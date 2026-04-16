#!/usr/bin/env bash
# KeyPick installer (macOS + Linux + WSL).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/seanrobertwright/KeyPick/master/install.sh | sh
#
# Runs `bun install -g keypick` (requires Bun).

set -euo pipefail

info() { printf "\033[36m==>\033[0m %s\n" "$*"; }
die()  { printf "\033[31mx\033[0m  %s\n" "$*" >&2; exit 1; }

if ! command -v bun >/dev/null 2>&1; then
  die "Bun is not installed. Install it first: https://bun.sh"
fi

info "KeyPick installer"
info "Running: bun install -g keypick"
bun install -g keypick

info "Done. Run 'keypick setup' to get started."
