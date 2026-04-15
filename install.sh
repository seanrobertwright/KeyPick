#!/usr/bin/env bash
# KeyPick installer (macOS + Linux).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/seanrobertwright/KeyPick/master/install.sh | sh
#
# Prompts for Rust or TypeScript, then installs the chosen variant.
# - Rust: downloads the latest release archive matching your OS/arch and
#   installs the `keypick` binary into ~/.local/bin.
# - TypeScript: runs `bun install -g keypick` (requires Bun).

set -euo pipefail

REPO="seanrobertwright/KeyPick"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

info()  { printf "\033[36m==>\033[0m %s\n" "$*"; }
warn()  { printf "\033[33m!\033[0m  %s\n" "$*"; }
die()   { printf "\033[31mx\033[0m  %s\n" "$*" >&2; exit 1; }

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="macos" ;;
    Linux)  os="linux" ;;
    *)      die "Unsupported OS: $(uname -s). Use install.ps1 on Windows." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x86_64" ;;
    arm64|aarch64)
      [ "$os" = "macos" ] && arch="aarch64" || die "Linux arm64 is not prebuilt yet. Use --from-source."
      ;;
    *) die "Unsupported architecture: $(uname -m)" ;;
  esac
  echo "${os}-${arch}"
}

install_rust() {
  local platform tag url tmp
  platform="$(detect_platform)"
  info "Fetching latest release tag..."
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  [ -n "$tag" ] || die "Could not determine latest release tag."
  info "Latest tag: $tag"

  url="https://github.com/${REPO}/releases/download/${tag}/keypick-${tag}-${platform}.tar.gz"
  info "Downloading $url"
  tmp="$(mktemp -d)"
  trap "rm -rf \"$tmp\"" EXIT
  curl -fsSL "$url" -o "$tmp/keypick.tar.gz" \
    || die "Failed to download release archive. Check that the release exists."
  tar -xzf "$tmp/keypick.tar.gz" -C "$tmp"

  mkdir -p "$INSTALL_DIR"
  install -m 0755 "$tmp"/keypick-*/keypick "$INSTALL_DIR/keypick"
  info "Installed to $INSTALL_DIR/keypick"

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) warn "$INSTALL_DIR is not on PATH. Add it to your shell profile:";
       warn "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
  esac
}

install_ts() {
  if ! command -v bun >/dev/null 2>&1; then
    die "Bun is not installed. Install it first: https://bun.sh — or choose the Rust option."
  fi
  info "Running: bun install -g keypick"
  bun install -g keypick
}

main() {
  info "KeyPick installer"
  printf "\nChoose the implementation to install:\n"
  printf "  1) Rust (prebuilt binary — no runtime required)\n"
  printf "  2) TypeScript (via Bun — easier to hack on)\n\n"
  printf "Enter 1 or 2: "
  read -r choice </dev/tty || die "No input received."

  case "$choice" in
    1) install_rust ;;
    2) install_ts ;;
    *) die "Invalid choice: $choice" ;;
  esac

  info "Done. Run 'keypick setup' to get started."
}

main "$@"
