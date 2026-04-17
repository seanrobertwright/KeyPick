#!/usr/bin/env bash
# KeyPick uninstaller (macOS + Linux + WSL).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/seanrobertwright/KeyPick/master/uninstall.sh | sh
#
# Removes the KeyPick bundle, shim, legacy installs, config, and cloned vaults.
# Prompts before deleting the age private key (irreversible).

set -euo pipefail

SHARE_DIR="${KEYPICK_SHARE_DIR:-$HOME/.local/share/keypick}"
BIN_DIR="${KEYPICK_BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${KEYPICK_HOME:-$HOME/.keypick}"
AGE_KEYS="$HOME/.config/sops/age/keys.txt"
SKILL_DIR="$HOME/.claude/skills/keypick"

info() { printf "\033[36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[33m!\033[0m  %s\n" "$*"; }
skip() { printf "\033[90m-\033[0m  %s\n" "$*"; }

confirm() {
  local prompt="$1" default="${2:-N}" response hint
  hint="$([ "$default" = "Y" ] && echo "Y/n" || echo "y/N")"
  if [ ! -t 0 ]; then
    if [ -r /dev/tty ]; then
      printf "%s [%s] " "$prompt" "$hint" >&2
      read -r response </dev/tty || response=""
    else
      response=""
    fi
  else
    printf "%s [%s] " "$prompt" "$hint"
    read -r response || response=""
  fi
  response="${response:-$default}"
  [[ "$response" =~ ^[Yy] ]]
}

remove_path() {
  local path="$1" label="$2"
  if [ -e "$path" ] || [ -L "$path" ]; then
    rm -rf "$path"
    info "Removed $label: $path"
  else
    skip "$label not present: $path"
  fi
}

info "KeyPick uninstaller"
echo

# 1. Current install: bundle + shim
remove_path "$SHARE_DIR" "bundle"
remove_path "$BIN_DIR/keypick" "shim"
remove_path "$BIN_DIR/keypick.cmd" "shim (.cmd)"

# 2. Legacy: bun global install (pre-GitHub-Releases era)
if command -v bun >/dev/null 2>&1; then
  if bun pm ls -g 2>/dev/null | grep -qi "keypick"; then
    info "Removing legacy bun global install..."
    bun remove -g keypick >/dev/null 2>&1 || true
  fi
fi
for f in "$HOME/.bun/bin/keypick" "$HOME/.bun/bin/keypick.exe" "$HOME/.bun/bin/keypick.bunx"; do
  [ -e "$f" ] && rm -f "$f" && info "Removed legacy bun shim: $f"
done
if [ -d "$HOME/.bun/install/global/node_modules/keypick" ]; then
  rm -rf "$HOME/.bun/install/global/node_modules/keypick"
  info "Removed legacy bun package dir"
fi

# 3. Legacy: Rust cargo install
if command -v cargo >/dev/null 2>&1; then
  if cargo install --list 2>/dev/null | grep -qi "^keypick"; then
    info "Removing legacy cargo install..."
    cargo uninstall keypick >/dev/null 2>&1 || true
  fi
fi
for f in "$HOME/.cargo/bin/keypick" "$HOME/.cargo/bin/keypick.exe" "$HOME/.cargo/bin/keypick2.exe"; do
  [ -e "$f" ] && rm -f "$f" && info "Removed legacy cargo artifact: $f"
done

# 4. Config + cloned vaults
if [ -d "$CONFIG_DIR" ]; then
  echo
  warn "Config + cloned vaults: $CONFIG_DIR"
  ls -la "$CONFIG_DIR" 2>/dev/null | sed 's/^/    /' | head -10
  if confirm "Remove $CONFIG_DIR (clones live here; git remotes remain intact)?" Y; then
    rm -rf "$CONFIG_DIR"
    info "Removed $CONFIG_DIR"
  else
    skip "Kept $CONFIG_DIR"
  fi
else
  skip "No config dir at $CONFIG_DIR"
fi

# 5. Claude Code skill
if [ -d "$SKILL_DIR" ]; then
  if confirm "Remove KeyPick Claude Code skill at $SKILL_DIR?" Y; then
    rm -rf "$SKILL_DIR"
    info "Removed skill: $SKILL_DIR"
  else
    skip "Kept skill: $SKILL_DIR"
  fi
fi
warn "Project-scope skills (./.claude/skills/keypick in individual projects) are not removed automatically."

# 6. Age private key (irreversible)
if [ -f "$AGE_KEYS" ]; then
  echo
  warn "DANGER: age private key at $AGE_KEYS"
  warn "This is the ONLY way to decrypt your vault on this machine."
  warn "Without a recovery key, other machines, or a backup, deleting"
  warn "this makes your vault contents permanently inaccessible."
  if confirm "Delete age private key anyway?" N; then
    rm -f "$AGE_KEYS"
    info "Removed age private key: $AGE_KEYS"
  else
    skip "Kept age private key"
  fi
else
  skip "No age private key at $AGE_KEYS"
fi

echo
info "Uninstall complete."
