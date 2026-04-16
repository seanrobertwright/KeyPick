#!/usr/bin/env bash
# KeyPick installer (macOS + Linux + WSL).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/seanrobertwright/KeyPick/master/install.sh | sh
#
# Downloads the latest release tarball, extracts the Bun bundle to
# ~/.local/share/keypick, and drops a symlink at ~/.local/bin/keypick.
# Requires Bun: https://bun.sh

set -euo pipefail

REPO="${KEYPICK_REPO:-seanrobertwright/KeyPick}"
SHARE_DIR="${KEYPICK_SHARE_DIR:-$HOME/.local/share/keypick}"
BIN_DIR="${KEYPICK_BIN_DIR:-$HOME/.local/bin}"

info() { printf "\033[36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[33m!\033[0m  %s\n" "$*"; }
die()  { printf "\033[31mx\033[0m  %s\n" "$*" >&2; exit 1; }

if ! command -v bun >/dev/null 2>&1; then
  die "Bun is not installed. Install it first: https://bun.sh"
fi

info "KeyPick installer"

info "Fetching latest release tag..."
tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$tag" ] || die "Could not determine latest release tag."
info "Latest tag: $tag"

asset="keypick-${tag}.tar.gz"
url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
info "Downloading $url"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/${asset}" \
  || die "Failed to download release archive. Check that the release exists."
tar -xzf "$tmp/${asset}" -C "$tmp"

bundle_dir="$tmp/keypick-${tag}"
[ -f "$bundle_dir/keypick.js" ] || die "keypick.js missing from release archive."

mkdir -p "$SHARE_DIR" "$BIN_DIR"
install -m 0755 "$bundle_dir/keypick.js" "$SHARE_DIR/keypick.js"
install -m 0644 "$bundle_dir/package.json" "$SHARE_DIR/package.json"

shim="$BIN_DIR/keypick"
rm -f "$shim"
ln -s "$SHARE_DIR/keypick.js" "$shim"
info "Installed to $SHARE_DIR (shim: $shim)"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on PATH. Add it to your shell profile:";
     warn "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

info "Done. Run 'keypick setup' to get started."
