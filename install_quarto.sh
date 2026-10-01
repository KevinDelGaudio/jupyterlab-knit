#!/usr/bin/env bash
# Install Quarto in user space (no admin rights):
#   ~/opt/quarto-<version>  +  symlink ~/.local/bin/quarto
# Usage: bash install_quarto.sh [version]     (default: latest release)
# Idempotent: an already installed version is not downloaded again.
set -euo pipefail

prefix="$HOME/opt"
bindir="$HOME/.local/bin"

# ---- preflight --------------------------------------------------------------
if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "ERROR: this script installs the linux-amd64 build; machine is $(uname -m)" >&2
  exit 1
fi
if ! command -v python >/dev/null; then
  echo "ERROR: no 'python' on PATH (needed for the Jupyter check)" >&2
  exit 1
fi

# ---- resolve version --------------------------------------------------------
version="${1:-}"
if [[ -z "$version" ]]; then
  # /releases/latest redirects to /releases/tag/v<version>; reading the
  # redirect avoids the rate-limited GitHub API.
  latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    https://github.com/quarto-dev/quarto-cli/releases/latest)"
  version="${latest_url##*/v}"
fi
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: could not determine a valid Quarto version (got '$version')" >&2
  exit 1
fi
echo "Quarto version: $version"

# ---- download and unpack ----------------------------------------------------
dest="$prefix/quarto-$version"
if [[ -x "$dest/bin/quarto" ]]; then
  echo "Already installed in $dest, skipping download"
else
  mkdir -p "$prefix"
  # Unpack inside $prefix so that only a complete install is moved into place
  tmp="$(mktemp -d "$prefix/.quarto-tmp.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT

  tarball="quarto-$version-linux-amd64.tar.gz"
  url="https://github.com/quarto-dev/quarto-cli/releases/download/v$version/$tarball"
  echo "Downloading $url"
  curl -fSL --progress-bar -o "$tmp/$tarball" "$url"

  tar -xzf "$tmp/$tarball" -C "$tmp"
  if [[ ! -x "$tmp/quarto-$version/bin/quarto" ]]; then
    echo "ERROR: unexpected tarball layout, bin/quarto not found" >&2
    exit 1
  fi
  mv "$tmp/quarto-$version" "$dest"
fi

# ---- link and verify --------------------------------------------------------
mkdir -p "$bindir"
ln -sfn "$dest/bin/quarto" "$bindir/quarto"

installed="$("$bindir/quarto" --version)"
if [[ "$installed" != "$version" ]]; then
  echo "ERROR: $bindir/quarto reports version '$installed', expected '$version'" >&2
  exit 1
fi
echo "OK: quarto $installed -> $bindir/quarto"

echo "Checking Jupyter integration with $(command -v python):"
QUARTO_PYTHON="$(command -v python)" "$bindir/quarto" check jupyter

case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "NOTE: $bindir is not on your PATH; the Knit button finds it anyway,"
     echo "      add it to PATH only if you want 'quarto' in the terminal." ;;
esac
