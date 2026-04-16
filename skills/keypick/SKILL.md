---
name: keypick
description: Use this skill whenever the user needs API keys, secrets, or environment variables to run code, scripts, or shell commands — even if they don't mention KeyPick by name. Trigger on phrases like "run this script", "test the API", "it needs my key", "set up my env", "what keys do I have", or any task that requires injecting credentials. Also trigger for vault management: listing stored keys, adding new ones, extracting to .env, or switching vaults. If the user has KeyPick installed and needs any kind of secret, this skill applies.
---

# KeyPick — Claude Code Integration

KeyPick is a biometric-secured API key vault. Use it to inject keys into commands, discover what's stored, and manage the vault — without ever asking the user to paste a secret into the chat.

## Quick command reference

| Goal | Command | Auth required? |
|------|---------|---------------|
| Inject keys into current shell | `eval $(keypick auto <Group>)` | No |
| List all groups and key names | `keypick list` | Yes (biometric) |
| Add or update keys | `keypick add` | Yes (biometric) |
| Copy one key to clipboard | `keypick copy` | Yes (biometric) |
| Extract groups to a .env file | `keypick extract` | Yes (biometric) |
| Show/switch active vault | `keypick vault current` / `keypick vault select` | No |
| Manage per-project .env in vault | `keypick env status/push/pull` | No / Yes |
| First-time setup | `keypick setup` | No |

## Injecting keys before a command

`keypick auto <Group> [Group2 ...]` is the non-interactive path — no biometric prompt, designed for scripting. It prints `export KEY='VALUE'` lines to stdout.

```bash
# Inject one group, then run the command
eval $(keypick auto OpenAI) && python script.py

# Inject multiple groups at once
eval $(keypick auto Stripe OpenAI) && node server.js

# Verify what was injected
eval $(keypick auto Stripe) && env | grep -i stripe
```

**When you don't know the group name:** ask the user — "Which KeyPick group holds those keys?" — or suggest they run `keypick list` themselves (it requires their fingerprint so you can't run it silently).

**When the group name is obvious from context** (e.g., the script imports `openai`, the user mentions "Stripe"), make a reasonable inference and tell the user what you're using: "I'll pull keys from your `OpenAI` group — let me know if that's named differently in your vault."

## Running a command that needs keys

The standard pattern for any Bash tool invocation that requires secrets:

```bash
eval $(keypick auto <Group>) && <the actual command>
```

Prefer this over a multi-step approach — it keeps keys scoped to that single subshell invocation and they don't linger in the environment.

## Vault management operations

These require the user's biometric — run them interactively and let the user authenticate when prompted.

```bash
keypick list          # Shows all groups and key names (values hidden)
keypick add           # Prompts to add/update a group
keypick copy          # Interactive: pick group → pick key → copies to clipboard
keypick extract       # Interactive: pick groups → writes a .env file
keypick vault select  # Choose a different vault repository
```

For `keypick env push/pull`, the user must be in the project directory that owns the .env files.

## Checking if KeyPick is installed

```bash
keypick --version 2>/dev/null || echo "not installed"
```

If not installed, direct the user to run the installer:
- Windows: `irm https://raw.githubusercontent.com/seanrobertwright/KeyPick/master/install.ps1 | iex`
- macOS/Linux: *(Rust binary or `bun install -g keypick`)*

If installed but not set up: `keypick setup`

## Security notes

- `keypick auto` intentionally skips biometric auth — it's for scripting contexts (direnv, CI, Claude). Keys are never written to disk by this command; they live only in the subshell for the duration of the command.
- Never echo key values into chat, logs, or files. If you need to confirm a key is present: `echo ${MY_KEY:+set}` (prints "set" without revealing the value).
- Prefer `eval $(keypick auto ...) && <command>` over `export`-ing into a persistent shell session.
