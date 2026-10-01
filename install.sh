#!/usr/bin/env bash
# Install the prebuilt jupyterlab-knit extension for the current user.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
target="$HOME/.local/share/jupyter/labextensions/jupyterlab-knit"

# ---- preflight --------------------------------------------------------------
if [[ ! -f "$here/labextension/package.json" ]]; then
  echo "ERROR: prebuilt extension not found in $here/labextension" >&2
  exit 1
fi

lab_version="$(jupyter lab --version)"
if [[ "${lab_version%%.*}" != "4" ]]; then
  echo "ERROR: JupyterLab 4.x required, found $lab_version" >&2
  exit 1
fi

if ! python -c "import nbconvert" 2>/dev/null; then
  echo "ERROR: nbconvert not importable by $(which python)" >&2
  exit 1
fi

if ! jupyter kernelspec list | grep -qE '^\s+python3\s'; then
  echo "ERROR: kernel 'python3' not found (used to launch the render)" >&2
  exit 1
fi

# ---- install (idempotent: replaces any previous copy) -----------------------
rm -rf "$target"
mkdir -p "$(dirname "$target")"
cp -r "$here/labextension" "$target"

# Capture the listing first: the command can exit non-zero because of other
# extensions (e.g. an incompatible jupyterlab-plotly), and piping straight
# into grep -q under pipefail turns that, or SIGPIPE, into a false failure.
listing="$(jupyter labextension list 2>&1 || true)"

if grep -q "jupyterlab-knit.*enabled.*OK" <<< "$listing"; then
  echo "OK: jupyterlab-knit installed in $target"
  echo "Now restart your server (File > Hub Control Panel > Stop My Server > Start)"
  echo "and reload the browser page."
else
  echo "ERROR: extension copied but not reported as enabled/OK:" >&2
  grep -i knit <<< "$listing" >&2 || true
  exit 1
fi
