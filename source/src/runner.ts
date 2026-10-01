/**
 * Helper kernels: short-lived Python kernels that launch, list and stop
 * renders. The render itself runs in a separate process group recorded in a
 * per-user registry (see scripts.ts), so it can be found and stopped from any
 * page, including after the page that started it was reloaded.
 */

import { JupyterFrontEnd } from '@jupyterlab/application';
import { PathExt } from '@jupyterlab/coreutils';
import { Kernel, KernelMessage, Session, SessionAPI } from '@jupyterlab/services';

import { CONTROL_SCRIPT } from './scripts';

export const HELPER_KERNEL = 'python3';
export const RENDER_SESSION = 'knit';
export const TASK_SESSION = 'knit-task';

const SESSION_PREFIX = '.knit-session-';
const MARKER = '__KNIT__';
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// a helper session idle for longer than this belongs to a page that is gone
const STALE_SESSION_MS = 60000;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export interface IHelperRun {
  stdout: string;
  error: string | null; // "Ename: evalue" when the helper code itself raised
  traceback: string;
}

/** Fill in the JSON arguments a script reads as ARGS_JSON. */
export function withArgs(script: string, args: object): string {
  return script.replace('ARGS_JSON', JSON.stringify(JSON.stringify(args)));
}

/** The JSON result a script prints on its last "__KNIT__" line. */
export function parseMarker(stdout: string): any {
  const lines = stdout.split('\n').filter(line => line.startsWith(MARKER));
  if (lines.length === 0) {
    return null;
  }
  try {
    return JSON.parse(lines[lines.length - 1].slice(MARKER.length));
  } catch {
    return null;
  }
}

export async function shutdownQuietly(
  session: Session.ISessionConnection
): Promise<void> {
  try {
    await session.shutdown();
    return;
  } catch (err) {
    console.warn('jupyterlab-knit: helper session shutdown failed, retrying', err);
  }
  // after a kernel crash the connection may refuse; ask the server directly
  await new Promise(resolve => setTimeout(resolve, 1000));
  try {
    await SessionAPI.shutdownSession(session.id, session.serverSettings);
  } catch (err) {
    console.warn('jupyterlab-knit: helper session shutdown failed', err);
  }
}

/**
 * Start a helper session whose kernel works in `dir` (a session path inside
 * `dir` makes the kernel start there).
 */
export async function startHelper(
  app: JupyterFrontEnd,
  dir: string,
  type: string
): Promise<Session.ISessionConnection> {
  const session = await app.serviceManager.sessions.startNew({
    path: PathExt.join(dir, `${SESSION_PREFIX}${Date.now()}`),
    type,
    name: type,
    kernel: { name: HELPER_KERNEL }
  });
  if (!session.kernel) {
    await shutdownQuietly(session);
    throw new Error(`could not start the "${HELPER_KERNEL}" kernel`);
  }
  return session;
}

/**
 * Execute code, streaming stdout to `onText` without the result line.
 * Rejects if the kernel dies or restarts before replying.
 */
export async function execute(
  kernel: Kernel.IKernelConnection,
  code: string,
  onText?: (text: string) => void
): Promise<IHelperRun> {
  let stdout = '';
  let error: string | null = null;
  let traceback = '';

  const future = kernel.requestExecute({
    code,
    store_history: false,
    stop_on_error: true
  });
  future.onIOPub = (msg: KernelMessage.IIOPubMessage) => {
    if (KernelMessage.isStreamMsg(msg)) {
      stdout += msg.content.text;
      if (onText) {
        const visible = msg.content.text
          .split('\n')
          .filter(line => !line.startsWith(MARKER))
          .join('\n');
        if (visible) {
          onText(visible);
        }
      }
    } else if (KernelMessage.isErrorMsg(msg)) {
      error = `${msg.content.ename}: ${msg.content.evalue}`;
      traceback = stripAnsi(msg.content.traceback.join('\n'));
    }
  };
  await future.done;
  return { stdout, error, traceback };
}

export interface IRunOptions {
  dir: string;
  code: string;
  type: string;
  onText?: (text: string) => void;
  onKernel?: (kernel: Kernel.IKernelConnection | null) => void;
}

/** One-shot: start a helper, run code, always shut the helper down. */
export async function runHelper(
  app: JupyterFrontEnd,
  options: IRunOptions
): Promise<IHelperRun> {
  const session = await startHelper(app, options.dir, options.type);
  try {
    options.onKernel?.(session.kernel);
    return await execute(
      session.kernel as Kernel.IKernelConnection,
      options.code,
      options.onText
    );
  } finally {
    options.onKernel?.(null);
    await shutdownQuietly(session);
  }
}

// ---------------------------------------------------------------------------
// Active renders
// ---------------------------------------------------------------------------

export interface IActiveKnit {
  id: string;
  notebook: string;
  format: string;
  engine: string;
  pgid: number;
  kernel_id: string | null;
  elapsed: number;
}

/**
 * Runs registry actions (list, stop) in one helper kernel kept for the
 * lifetime of the channel, so polling does not start a kernel each time.
 * Calls are serialised.
 */
export class ControlChannel {
  private session: Session.ISessionConnection | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private app: JupyterFrontEnd) {}

  run(args: object): Promise<any> {
    const next = this.queue.then(() => this.runNow(args));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<IActiveKnit[]> {
    const outcome = await this.run({ action: 'list' });
    return outcome.active as IActiveKnit[];
  }

  async stop(id: string): Promise<string> {
    const outcome = await this.run({ action: 'stop', id });
    return outcome.status as string;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.queue;
    if (this.session) {
      await shutdownQuietly(this.session);
      this.session = null;
    }
  }

  private async runNow(args: object): Promise<any> {
    if (this.disposed) {
      throw new Error('control channel closed');
    }
    if (!this.session || this.session.isDisposed || !this.session.kernel) {
      this.session = await startHelper(this.app, '', TASK_SESSION);
    }
    let run: IHelperRun;
    try {
      run = await execute(this.session.kernel as Kernel.IKernelConnection, withArgs(CONTROL_SCRIPT, args));
    } catch (err) {
      // kernel died: start a fresh one on the next call
      await shutdownQuietly(this.session);
      this.session = null;
      throw err;
    }
    if (run.error) {
      throw new Error(run.error);
    }
    const outcome = parseMarker(run.stdout);
    if (!outcome) {
      throw new Error('the control script returned no result');
    }
    if (outcome.error) {
      throw new Error(outcome.error);
    }
    return outcome;
  }
}

/** One-shot registry call through a temporary channel. */
export async function withControl<T>(
  app: JupyterFrontEnd,
  action: (channel: ControlChannel) => Promise<T>
): Promise<T> {
  const channel = new ControlChannel(app);
  try {
    return await action(channel);
  } finally {
    await channel.dispose();
  }
}

// ---------------------------------------------------------------------------
// Helper sessions left behind by closed or reloaded pages
// ---------------------------------------------------------------------------

function sessionAge(model: Session.IModel): number | null {
  const base = PathExt.basename(model.path);
  if (!base.startsWith(SESSION_PREFIX)) {
    return null;
  }
  const started = Number(base.slice(SESSION_PREFIX.length));
  return Number.isFinite(started) ? Date.now() - started : null;
}

function isHelper(model: Session.IModel): boolean {
  return model.type === RENDER_SESSION || model.type === TASK_SESSION;
}

function executionState(model: Session.IModel): string | undefined {
  return (model.kernel as any)?.execution_state;
}

/** Helper sessions whose kernel is busy, i.e. renders running somewhere. */
export function busyRenderSessions(app: JupyterFrontEnd): number {
  let count = 0;
  for (const model of app.serviceManager.sessions.running()) {
    if (model.type === RENDER_SESSION && executionState(model) === 'busy') {
      count += 1;
    }
  }
  return count;
}

/**
 * Shut down idle helper sessions older than a minute: their page was closed
 * or reloaded before it could shut them down. Busy ones are left alone.
 */
export async function cleanupStaleHelpers(
  app: JupyterFrontEnd,
  keep: Set<string>
): Promise<void> {
  const sessions = app.serviceManager.sessions;
  try {
    await sessions.refreshRunning();
  } catch (err) {
    console.warn('jupyterlab-knit: could not list sessions', err);
    return;
  }
  const stale: string[] = [];
  for (const model of sessions.running()) {
    const age = sessionAge(model);
    if (
      isHelper(model) &&
      !keep.has(model.id) &&
      age !== null &&
      age > STALE_SESSION_MS &&
      executionState(model) === 'idle'
    ) {
      stale.push(model.id);
    }
  }
  for (const id of stale) {
    try {
      await sessions.shutdown(id);
    } catch (err) {
      console.warn('jupyterlab-knit: stale helper shutdown failed', err);
    }
  }
}
