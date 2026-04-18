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

# Verify a key is present WITHOUT revealing its value
eval $(keypick auto Stripe) && echo "STRIPE_API_KEY=${STRIPE_API_KEY:+set}"
```

The `${VAR:+set}` form prints the literal word `set` only when the variable is populated — it never echoes the secret itself. **Never** use `env`, `printenv`, `set`, or `env | grep` to verify injection: those print the plaintext values into your tool output, which means the secret enters the conversation context.

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

**After `keypick extract`**, a plaintext `.env` exists on disk. Do not `cat`, `Read`, or `Grep` that file from the AI side — see security notes below. If the user only needs a single value rather than a whole group, suggest `keypick copy` instead.

## Checking if KeyPick is installed

```bash
keypick --version 2>/dev/null || echo "not installed"
```

If not installed, direct the user to run the installer:
- Windows: `irm https://raw.githubusercontent.com/seanrobertwright/KeyPick/master/install.ps1 | iex`
- macOS/Linux: `bun install -g keypick`

If installed but not set up: `keypick setup`

## Security notes — keeping secrets out of AI context

The `eval $(keypick auto …) && <command>` idiom is safe *by construction*: `$(…)` captures the `export` lines so they never reach your tool's stdout, and the subshell dies when the command finishes. That guarantee is fragile — it only holds if you don't do any of the following.

**Hard rules — these commands leak plaintext into the conversation:**

- Do **not** run `env`, `printenv`, `set`, `env | grep`, or any sibling command whose purpose is to display environment variables. Their stdout is captured and returned to the model.
- Do **not** `cat`, `Read`, `Grep`, or otherwise ingest `.env`, `.envrc`, `.env.local`, or any file that may contain plaintext secrets — including files produced by `keypick extract`. Treat those files as write-only from the AI's perspective: created for the user's process, never read back.
- Do **not** run commands that print env vars as part of their own output (e.g., `node -e 'console.log(process.env)'`, debug middleware that dumps config, verbose CI loggers). If a script fails and the error includes env dumps, stop and tell the user rather than pasting the output back.
- Do **not** use `set -x`, `bash -x`, or other shell trace modes while secrets are in scope — trace output expands `eval` and prints the values.

**Preferred patterns:**

- Prefer `eval $(keypick auto …) && <command>` over `export`-ing into a persistent shell session — the subshell scope is the isolation.
- When the user only needs *one* value for their own use (pasting into a dashboard, a config UI, etc.), suggest `keypick copy` instead of `keypick extract`. `copy` puts the value on the OS clipboard and never writes plaintext to disk.
- When you must verify injection worked, use `echo "KEY=${KEY:+set}"` — prints the literal word `set` without revealing the value.

**What KeyPick itself guarantees:**

- `keypick auto` never writes to disk; keys live only in the calling subshell.
- `keypick list` shows key *names* only — values are hidden.
- `keypick copy` writes the value to the OS clipboard; only the group/key name is printed.
- Biometric-gated commands (`add`, `extract`, `copy`, `list`) cannot be run non-interactively by the AI — the user has to approve at the OS prompt.
