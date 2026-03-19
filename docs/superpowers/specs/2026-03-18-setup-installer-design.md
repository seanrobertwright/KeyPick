# KeyPick Setup Installer Design

## Overview

A `key-pick setup` subcommand that guides users through the entire KeyPick installation in a single interactive TUI wizard. One command, branching early based on first machine vs. joining an existing vault.

## Flow

```
key-pick setup
  |-- Check & install prerequisites (age, sops)
  |-- Generate machine age key (or detect existing)
  |-- "First machine or joining existing vault?"
  |   |-- INIT: Create vault repo (gh auto or manual), encrypt empty vault, push
  |   +-- JOIN: Clone existing repo, add machine key to .sops.yaml, push
  |-- "Set up GitHub Actions auto-sync?" (optional mini-wizard)
  |   +-- Generate actions key, set GH secret via gh, copy workflow
  +-- "Create a recovery key?" (optional mini-wizard)
      +-- Generate passphrase-protected recovery key, add to .sops.yaml
```

## Subcommands

| Command | Purpose |
|---|---|
| `key-pick setup` | Full wizard (main entry point) |
| `key-pick setup actions` | Standalone GitHub Actions setup |
| `key-pick setup recovery` | Standalone recovery key generation |

## Prerequisites Phase

- Detect OS and architecture
- Check if `age` and `sops` are on PATH
- If missing: download latest from GitHub releases with `indicatif` progress bars
- Install to a sensible location (user-chosen or default)
- Verify with `age --version` / `sops --version`
- If already installed: green checkmark, skip

## Key Generation Phase

- Check if age key file exists at the platform-standard location
- If exists: display the public key, ask "Use this existing key?"
- If not: run `age-keygen`, save to standard location, display public key

## Init Flow (First Machine)

1. Prompt for vault repo name (default: `my-keys`)
2. If `gh` detected: offer to create private repo automatically
3. If no `gh`: prompt for local directory, init git, tell user to create remote and add it
4. Create `.sops.yaml` with this machine's public key
5. Create empty `vault.yaml`, encrypt with `sops -e -i`
6. Git add, commit, push (if remote available)

## Join Flow (Additional Machine)

1. If `gh` detected: prompt for repo name, clone
2. If no `gh`: prompt for clone URL or existing local path
3. Read existing `.sops.yaml`, show current recipients
4. Add this machine's public key to the recipient list
5. Re-encrypt vault: `sops updatekeys -y vault.yaml`
6. Git add, commit, push

## GitHub Actions Mini-Wizard

1. Check `gh` is available (required for setting secrets)
2. Generate a new age keypair for GitHub Actions
3. Add public key to `.sops.yaml`
4. Use `gh secret set SOPS_AGE_KEY` to store private key
5. Copy `vault-sync.yml` (embedded in binary) into `.github/workflows/`
6. Commit and push
7. Securely delete the local key file

## Recovery Key Mini-Wizard

1. Generate a recovery keypair with `age-keygen`
2. Prompt user for a strong passphrase (with confirmation)
3. Encrypt private key with passphrase via `age -p`
4. Save as `recovery_key.age`
5. Add recovery public key to `.sops.yaml`
6. Re-encrypt vault with new recipient
7. Commit and push
8. Show storage instructions (file to cloud, passphrase to paper, separate locations)

## Visual Style

- `inquire` for all user prompts (consistent with existing commands)
- `indicatif` progress bars for downloads (bytes/sec, ETA)
- `indicatif` spinners for operations (key generation, encryption, git)
- `colored` for status messages (green checkmarks, yellow warnings, cyan info, red errors)
- Step counter headers: `[1/6] Installing age...`

## Error Handling

- Each step validates before proceeding
- On failure: clear error, suggest manual fix, offer retry
- Ctrl+C exits cleanly
- Detect partially-completed setup and resume

## New Dependencies

| Crate | Purpose |
|---|---|
| `indicatif` | Progress bars and spinners |
| `reqwest` (blocking) | HTTP downloads from GitHub releases |
| `dirs` | Cross-platform standard directory paths |
| `tempfile` | Safe temp file handling during downloads |
