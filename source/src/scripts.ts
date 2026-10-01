/**
 * Python run in throwaway helper kernels. ARGS_JSON is replaced with a JSON
 * string literal before execution; every script ends by printing one
 * "__KNIT__" line holding its JSON result.
 *
 * Active renders are recorded in a per-user registry so that they can be
 * listed and stopped from any page, including after a reload, when the page
 * that started them is gone.
 */

// Shared by the render and control scripts.
const COMMON = String.raw`
import importlib.util, json, os, re, shlex, shutil, signal, socket
import subprocess, sys, time, uuid

ARGS = json.loads(ARGS_JSON)
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
LATEX = ("lualatex", "xelatex", "pdflatex")
REGISTRY = os.path.join(os.path.expanduser("~"), ".local", "share",
                        "jupyterlab-knit", "active")
HOST = socket.gethostname()


class sigint_ignored:
    # A second Stop arriving while a render is being stopped or cleaned up
    # must not interrupt the stopping or the clean-up itself.
    def __enter__(self):
        self.previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
        return self

    def __exit__(self, *exc):
        signal.signal(signal.SIGINT, self.previous)
        return False


def process_cmdline(pid):
    try:
        with open("/proc/%d/cmdline" % int(pid), "rb") as handle:
            return handle.read().replace(b"\0", b" ").decode(errors="replace")
    except (OSError, ValueError, TypeError):
        return None


def registry_entries():
    entries = []
    if not os.path.isdir(REGISTRY):
        return entries
    for name in sorted(os.listdir(REGISTRY)):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(REGISTRY, name)) as handle:
                entries.append(json.load(handle))
        except (OSError, ValueError):
            continue
    return entries


def entry_path(entry_id):
    return os.path.join(REGISTRY, entry_id + ".json")


def write_entry(entry):
    os.makedirs(REGISTRY, exist_ok=True)
    tmp = entry_path(entry["id"]) + ".tmp"
    with open(tmp, "w") as handle:
        json.dump(entry, handle)
    os.replace(tmp, entry_path(entry["id"]))


def remove_entry(entry_id):
    try:
        os.remove(entry_path(entry_id))
    except FileNotFoundError:
        pass


def render_alive(entry):
    # The process group leader must exist and still be this render; the
    # command line check guards against a recycled pid.
    if entry.get("host") != HOST:
        return False
    cmdline = process_cmdline(entry.get("pgid"))
    return cmdline is not None and entry.get("match", "") in cmdline


def helper_alive(entry):
    cmdline = process_cmdline(entry.get("helper_pid"))
    return cmdline is not None and "python" in cmdline


def temporary_names(directory, tmp_stem):
    # Everything a render of the temporary copy can produce
    if not os.path.isdir(directory):
        return []
    return sorted(name for name in os.listdir(directory)
                  if name.startswith(tmp_stem + ".") or name == tmp_stem + "_files")


def discard_temporary(directory, tmp_stem, stem, preexisting=()):
    # After a failed or stopped render nothing produced from the temporary
    # copy may replace the previous output; only the LaTeX log is kept, under
    # a name that cannot be mistaken for a result. Files that were already
    # there before the render started are never touched.
    kept = None
    for name in temporary_names(directory, tmp_stem):
        if name in preexisting:
            continue
        path = os.path.join(directory, name)
        try:
            if name == tmp_stem + ".log":
                kept = stem + ".knit-error.log"
                os.replace(path, os.path.join(directory, kept))
            elif os.path.isdir(path):
                shutil.rmtree(path, ignore_errors=True)
            else:
                os.remove(path)
        except OSError:
            pass
    return kept


def terminate(pgid, proc=None, grace=10):
    # SIGTERM to the whole render (quarto, pandoc, LaTeX, notebook kernel),
    # SIGKILL if it is still there after the grace period. When the caller
    # owns the group leader it is reaped here, otherwise it would linger as
    # a zombie and keep the group alive for the whole grace period.
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.time() + grace
    while time.time() < deadline:
        if proc is not None:
            proc.poll()
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.2)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass
`;

const RENDER_BODY = String.raw`

def tool_env():
    # The server's PATH often lacks user-space installs: add ~/.local/bin
    # (quarto) and TinyTeX, and point Quarto at this Python for Jupyter.
    home = os.path.expanduser("~")
    extra = [os.path.join(home, ".local", "bin")]
    tinytex_bin = os.path.join(home, ".TinyTeX", "bin")
    if os.path.isdir(tinytex_bin):
        for arch in sorted(os.listdir(tinytex_bin)):
            extra.append(os.path.join(tinytex_bin, arch))
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join(extra + [env.get("PATH", "")])
    env["QUARTO_PYTHON"] = sys.executable
    return env


def own_kernel_id():
    try:
        from ipykernel.connect import get_connection_file
        name = os.path.basename(get_connection_file())
        return name[len("kernel-"):-len(".json")]
    except Exception:
        return None


def summarize(log):
    # The Python exception if there is one, otherwise the last Quarto
    # ERROR line, otherwise the last line of the log that is not a warning.
    lines = [l.strip() for l in log.splitlines()
             if l.strip() and not l.strip().startswith("WARN")]
    exc = [l for l in lines
           if re.match(r"^[A-Za-z_][\w.]*(Error|Exception|Interrupt|Exit)\b", l)]
    err = [l for l in lines if l.startswith("ERROR")]
    if exc:
        return exc[-1]
    if err:
        return err[-1]
    if lines:
        return lines[-1]
    return "no output"


def result(rc, engine, output, summary, cancelled):
    return {"rc": rc, "engine": engine, "output": output,
            "summary": summary, "cancelled": cancelled}


def fail(engine, message):
    print("ERROR: " + message, flush=True)
    return result(1, engine, None, message, False)


def run_streaming(cmd, env, entry, tmp_stem, stem):
    # Runs the render in its own process group, records it in the registry
    # while it runs and streams its output. Returns (rc, log, cancelled).
    def shown(text):
        return text.replace(tmp_stem, stem) if tmp_stem else text

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True,
                            errors="replace", bufsize=1,
                            env=env, start_new_session=True)
    log = []
    cancelled = False
    try:
        try:
            entry["pgid"] = proc.pid
            entry["started"] = time.time()
            write_entry(entry)
            # first output only once the render is registered, so a Stop
            # triggered by it always finds something to stop
            print("==> " + shown(" ".join(shlex.quote(c) for c in cmd)) + "\n",
                  flush=True)
            for line in proc.stdout:
                line = shown(line)
                log.append(line)
                sys.stdout.write(line)
                sys.stdout.flush()
            rc = proc.wait()
        except KeyboardInterrupt:
            # Stop from this page: the helper kernel was interrupted
            cancelled = True
            with sigint_ignored():
                terminate(proc.pid, proc)
                rc = proc.wait()
        except Exception:
            # never leave a render running that nothing tracks
            with sigint_ignored():
                terminate(proc.pid, proc)
                proc.wait()
            raise
        # Stop from Active Knits (possibly another page) marks the entry
        try:
            with open(entry_path(entry["id"])) as handle:
                if json.load(handle).get("stopped"):
                    cancelled = True
        except (OSError, ValueError):
            pass
    finally:
        remove_entry(entry["id"])
    return rc, ANSI.sub("", "".join(log)), cancelled


def rename_outputs(tmp_stem, stem, nb, preexisting=()):
    # After a successful render everything Quarto produced from the
    # temporary copy (output, kept .tex, _files folder) takes the notebook's
    # stem, replacing the previous version.
    for name in temporary_names(".", tmp_stem):
        if name in preexisting:
            continue
        target = stem + name[len(tmp_stem):]
        if target == nb:
            continue
        if os.path.isdir(target):
            shutil.rmtree(target)
        elif os.path.exists(target):
            os.remove(target)
        os.replace(name, target)
    stale_log = stem + ".knit-error.log"
    if os.path.exists(stale_log):
        os.remove(stale_log)


def ensure_filter(nb, name, content):
    # The header written by "Knit to PDF" references a Lua filter kept next
    # to the notebook; supply it if missing, never overwrite an existing one.
    if os.path.exists(name):
        return
    with open(nb, encoding="utf-8") as handle:
        cells = json.load(handle).get("cells", [])
    if not cells or cells[0].get("cell_type") != "raw":
        return
    source = cells[0].get("source", "")
    if isinstance(source, list):
        source = "".join(source)
    if name not in source:
        return
    with open(name, "w", encoding="utf-8") as handle:
        handle.write(content)
    print("==> wrote " + name + " next to the notebook\n", flush=True)


def render():
    nb = ARGS["nb"]
    to = ARGS["to"]
    params = ARGS["params"]
    depth = ARGS["project_depth"]

    stem = os.path.splitext(nb)[0]
    nb_abs = os.path.abspath(nb)
    if not os.path.isfile(nb):
        return fail("knit", "notebook not found: " + nb_abs)

    # One render per notebook: a second one would share its temporary copy
    for other in registry_entries():
        if other.get("notebook_abs") == nb_abs and render_alive(other):
            outcome = fail("knit", nb + " is already being knitted from another "
                           "tab or a reloaded page")
            outcome["busy"] = True
            return outcome

    env = tool_env()
    quarto = shutil.which("quarto", path=env["PATH"])
    entry = {"id": uuid.uuid4().hex, "host": HOST, "notebook": ARGS["nb_path"],
             "notebook_abs": nb_abs, "directory": os.getcwd(), "stem": stem,
             "format": to, "helper_pid": os.getpid(),
             "kernel_id": own_kernel_id(), "stopped": False}

    if quarto is None:
        needs = []
        if to != "html":
            needs.append("Knit to " + to)
        if params:
            needs.append("parameters")
        if depth is not None:
            needs.append("Project Directory")
        if needs:
            return fail("nbconvert", "Quarto is required for " +
                        ", ".join(needs) + ": run install_quarto.sh")
        cmd = [sys.executable, "-m", "nbconvert", "--to", "html", "--execute",
               "--ExecutePreprocessor.timeout=-1", nb]
        entry.update({"engine": "nbconvert", "tmp_stem": None, "match": nb})
        rc, log, cancelled = run_streaming(cmd, env, entry, None, stem)
        output = stem + ".html" if rc == 0 and not cancelled else None
        return result(rc, "nbconvert", output, summarize(log), cancelled)

    if params and importlib.util.find_spec("papermill") is None:
        return fail("Quarto", "Knit with Parameters needs papermill: "
                    + sys.executable + " -m pip install papermill")
    if to == "pdf" and not any(shutil.which(t, path=env["PATH"]) for t in LATEX):
        return fail("Quarto", "Knit to PDF needs LaTeX: run install_tinytex.sh")
    if to == "pdf":
        ensure_filter(nb, ARGS["filter_name"], ARGS["filter_lua"])

    # Quarto writes executed outputs back into the .ipynb it renders, so a
    # copy is rendered. It is not hidden: LaTeX refuses to write dot-files.
    tmp_stem = stem + "__knit"
    tmp_nb = tmp_stem + ".ipynb"
    if os.path.isdir(tmp_nb):
        return fail("Quarto", "a folder named " + tmp_nb + " is in the way of "
                    "the temporary copy; rename or remove it")
    # a leftover copy from an interrupted knit is overwritten; anything else
    # already carrying the temporary prefix is left alone
    preexisting = [name for name in temporary_names(".", tmp_stem) if name != tmp_nb]

    cmd = [quarto, "render", tmp_nb, "--execute", "--to", to,
           "-M", "embed-resources:true"]
    if depth is not None:
        root = os.getcwd()
        for _ in range(depth):
            root = os.path.dirname(root)
        cmd += ["--execute-dir", root]
    for p in params:
        cmd += ["-P", p]
    entry.update({"engine": "Quarto", "tmp_stem": tmp_stem, "match": tmp_nb,
                  "preexisting": preexisting})

    rc, log, cancelled = 1, "", False
    try:
        shutil.copyfile(nb, tmp_nb)
        rc, log, cancelled = run_streaming(cmd, env, entry, tmp_stem, stem)
    finally:
        with sigint_ignored():
            if os.path.isfile(tmp_nb):
                os.remove(tmp_nb)
            if rc == 0 and not cancelled:
                rename_outputs(tmp_stem, stem, nb, preexisting)
            else:
                kept = discard_temporary(os.getcwd(), tmp_stem, stem, preexisting)
                if kept and not cancelled:
                    print("\n==> LaTeX log kept as " + kept + "\n", flush=True)

    if cancelled:
        return result(1, "Quarto", None, "stopped", True)
    created = re.findall(r"^Output created: (.+?)\s*$", log, re.M)
    output = created[-1] if created else None
    summary = summarize(log)
    if rc == 0 and output is None:
        rc = 1
        summary = "Quarto finished without reporting an output file"
    return result(rc, "Quarto", output if rc == 0 else None, summary, False)


def main():
    try:
        return render()
    except KeyboardInterrupt:
        # Stopped before the render process had started
        return result(1, "knit", None, "stopped", True)
    except Exception as exc:
        return fail("knit", "%s: %s" % (type(exc).__name__, exc))


print("\n__KNIT__" + json.dumps(main()), flush=True)
`;

const CONTROL_BODY = String.raw`

def describe(entry):
    return {"id": entry["id"], "notebook": entry.get("notebook"),
            "format": entry.get("format"), "engine": entry.get("engine"),
            "pgid": entry.get("pgid"), "kernel_id": entry.get("kernel_id"),
            "elapsed": int(time.time() - entry.get("started", time.time()))}


def clean_up(entry):
    # Called only when no helper is left to finish the render itself
    if entry.get("tmp_stem"):
        discard_temporary(entry["directory"], entry["tmp_stem"], entry["stem"],
                          entry.get("preexisting", []))
    remove_entry(entry["id"])


def list_active():
    active = []
    for entry in registry_entries():
        if entry.get("host") != HOST:
            continue
        if render_alive(entry):
            active.append(describe(entry))
        elif not helper_alive(entry):
            clean_up(entry)          # render and helper both gone
    return {"active": active}


def stop(entry_id):
    entry = next((e for e in registry_entries() if e["id"] == entry_id), None)
    if entry is None:
        return {"status": "finished"}
    if not render_alive(entry):
        if not helper_alive(entry):
            clean_up(entry)
        return {"status": "finished"}

    entry["stopped"] = True
    write_entry(entry)
    terminate(entry["pgid"])

    # A live helper cleans up and reports to its page; give it time
    deadline = time.time() + 15
    while helper_alive(entry) and os.path.exists(entry_path(entry_id)):
        if time.time() > deadline:
            break
        time.sleep(0.2)
    if os.path.exists(entry_path(entry_id)):
        clean_up(entry)
    return {"status": "stopped", "notebook": entry.get("notebook")}


def control():
    action = ARGS["action"]
    if action == "list":
        return list_active()
    if action == "stop":
        return stop(ARGS["id"])
    return {"error": "unknown action " + str(action)}


try:
    outcome = control()
except Exception as exc:
    outcome = {"error": "%s: %s" % (type(exc).__name__, exc)}
print("\n__KNIT__" + json.dumps(outcome), flush=True)
`;

export const RENDER_SCRIPT = COMMON + RENDER_BODY;
export const CONTROL_SCRIPT = COMMON + CONTROL_BODY;

export const CLEAR_CACHE_SCRIPT = String.raw`
import json, os, shutil

try:
    cache = ".jupyter_cache"
    if os.path.isdir(cache):
        shutil.rmtree(cache)
        outcome = {"status": "cleared", "dir": os.getcwd()}
    else:
        outcome = {"status": "none", "dir": os.getcwd()}
except Exception as exc:
    outcome = {"error": "%s: %s" % (type(exc).__name__, exc)}
print("\n__KNIT__" + json.dumps(outcome), flush=True)
`;
