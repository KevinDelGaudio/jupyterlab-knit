#!/usr/bin/env bash
# Install TinyTeX in user space (~/.TinyTeX) for "Knit to PDF".
# Uses Quarto's own installer; if that fails (e.g. GitHub API rate limit),
# downloads the same TinyTeX bundle directly. Idempotent.
set -euo pipefail

dest="$HOME/.TinyTeX"
quarto="$(command -v quarto || echo "$HOME/.local/bin/quarto")"

latex_bin() {
  compgen -G "$dest/bin/*/lualatex" | head -n 1 || true
}

# ---- preflight --------------------------------------------------------------
if [[ ! -x "$quarto" ]]; then
  echo "ERROR: quarto not found; run install_quarto.sh first" >&2
  exit 1
fi

if [[ -n "$(latex_bin)" ]]; then
  echo "TinyTeX already installed: $(latex_bin)"
else
  # ---- 1: Quarto's installer ------------------------------------------------
  echo "Installing TinyTeX with: quarto install tinytex"
  if ! "$quarto" install tinytex --no-prompt; then
    echo "quarto install tinytex failed; downloading the bundle directly"

    # ---- 2: direct download (same bundle Quarto uses) -----------------------
    latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
      https://github.com/rstudio/tinytex-releases/releases/latest)"
    tag="${latest_url##*/}"
    if [[ ! "$tag" =~ ^v[0-9]{4}\.[0-9]{2}$ ]]; then
      echo "ERROR: could not determine the TinyTeX release (got '$tag')" >&2
      exit 1
    fi
    url="https://github.com/rstudio/tinytex-releases/releases/download/$tag/TinyTeX-$tag.tar.gz"

    tmp="$(mktemp -d "$HOME/.tinytex-tmp.XXXXXX")"
    trap 'rm -rf "$tmp"' EXIT
    echo "Downloading $url"
    curl -fSL --progress-bar -o "$tmp/tinytex.tar.gz" "$url"
    tar -xzf "$tmp/tinytex.tar.gz" -C "$tmp"
    if [[ ! -d "$tmp/.TinyTeX" ]]; then
      echo "ERROR: unexpected tarball layout, .TinyTeX/ not found" >&2
      exit 1
    fi
    rm -rf "$dest"
    mv "$tmp/.TinyTeX" "$dest"
  fi
fi

# ---- verify -----------------------------------------------------------------
lualatex="$(latex_bin)"
if [[ -z "$lualatex" ]]; then
  echo "ERROR: no lualatex found under $dest/bin after installation" >&2
  exit 1
fi
"$lualatex" --version | head -n 1
echo "OK: TinyTeX in $dest (the Knit button adds its bin/ to PATH itself)."
echo "Missing LaTeX packages are installed automatically on the first PDF knits."
