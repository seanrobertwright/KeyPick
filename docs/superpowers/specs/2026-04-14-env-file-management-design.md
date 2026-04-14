# KeyPick .env File Management

## Overview

Extend KeyPick to manage per-project `.env` files, encrypted and synced across machines through the same vault infrastructure used for key/value secrets.

## Decisions

- `.env` files are stored as individually SOPS-encrypted files in the vault repo under `envs/<project-id>/`
- All `.env*` variants in a project root are managed together (`.env`, `.env.local`, `.env.production`, etc.)
- Project identified by git remote URL (normalized), falling back to directory name
- Last push wins — no conflict resolution, local files overwritten on pull
- Biometric auth required for push and pull (not status)
- New `keypick env push/pull/status` subcommands plus interactive menu entries
- Separate from the existing `vault.yaml` key/value system — no changes to `vault.rs`

## Project Identification

Resolution logic:
1. Run `git remote get-url origin` in CWD
2. Parse the URL — strip protocol, `.git` suffix, normalize SSH and HTTPS forms (e.g., `https://github.com/seanrobertwright/my-app.git` and `git@github.com:seanrobertwright/my-app.git` both become `seanrobertwright/my-app`)
3. Replace `/` with `__` for filesystem safety: `seanrobertwright__my-app`
4. If no git remote exists, fall back to the current directory name and print a note

## File Discovery & Storage Layout

**Push — file discovery:** Scan CWD for `.env*` glob pattern. Root only, no recursive subdirectory search. Empty files are skipped.

**Vault repo layout:**
```
~/.keypick/vaults/my-keys/
  vault.yaml
  .sops.yaml
  envs/
    seanrobertwright__my-app/
      .env
      .env.local
    seanrobertwright__other-project/
      .env
      .env.production
```

Each file is SOPS-encrypted in dotenv format (key names plaintext, values encrypted):
```
DB_HOST=ENC[AES256_GCM,data:...,type:str]
DB_PASSWORD=ENC[AES256_GCM,data:...,type:str]
```

**`.sops.yaml` creation rule** for env files:
```yaml
creation_rules:
  - path_regex: envs/.*
    age: "age1abc...,age1def..."
  - path_regex: vault\.yaml$
    age: "age1abc...,age1def..."
```

Same recipient list — adding a machine to the vault automatically covers `.env` files.

## CLI Commands

### `keypick env push`
1. Biometric check
2. Derive project ID from CWD
3. Scan CWD for `.env*` files
4. If none found, error with helpful message
5. Show files that will be pushed
6. For each file: `sops -e --input-type dotenv --output-type dotenv <file>` → write to `envs/<project-id>/<filename>` in vault repo. **Note:** SOPS dotenv format support must be verified at implementation time. If SOPS does not support `--input-type dotenv`, fall back to binary mode (`sops -e -input-type binary`) or treat `.env` files as plaintext and encrypt as YAML by converting key=value pairs to a YAML map before encryption.
7. Check `git status` for changes in `envs/<project-id>/`. If no changes (identical re-push), skip commit and print "No changes to push." Otherwise: `git add envs/<project-id>/ && git commit -m "update env: <project-id>" && git push`

### `keypick env pull`
1. Biometric check
2. Derive project ID from CWD
3. `git pull` on vault repo to get latest
4. Look up `envs/<project-id>/` in vault repo; error if not found
5. For each encrypted file: `sops -d --input-type dotenv --output-type dotenv <file>` → write to CWD (same format note as push applies)
6. Print summary of files written (list each file and whether it was created or overwritten)

### `keypick env status`
1. Derive project ID from CWD (no biometric — no secrets exposed)
2. Run `git fetch` on vault repo (non-blocking best-effort — if it fails, proceed with local state and note "could not fetch latest")
3. Check if `envs/<project-id>/` exists in vault repo
4. List stored `.env*` files
5. Compare with local `.env*` files: show which exist locally, which are missing, which are only local

### Interactive menu
Add two entries to the existing no-arg `keypick` menu:
- "Push .env files" → push flow
- "Pull .env files" → pull flow

## Git Sync Behavior

**Push:** KeyPick handles the full git cycle automatically (add, commit, push). Unlike `keypick add` which prints manual git commands, env operations are self-contained.

**Pull:** Runs `git pull` on vault repo before decrypting. Local `.env` files overwritten without prompting.

**GitHub Actions:** Update the embedded `vault-sync.yml` workflow to trigger on `envs/**` changes and run `sops updatekeys` on all env files when a new machine is added.

## Error Handling

- **No vault configured:** Error: "No vault found. Run `keypick setup` first."
- **No git remote in CWD:** Fall back to directory name with a printed note about needing matching folder names on other machines.
- **Empty `.env` files:** Skipped during push.
- **Non-dotenv files matching `.env*`:** SOPS encryption failure caught, file skipped, rest continue.
- **No `envs/` directory yet:** Created on first push.
- **Project ID collision (folder name fallback):** Accepted limitation, user warned.
- **Existing vault missing `envs/.*` creation rule:** On first `keypick env push`, check `.sops.yaml` for the `envs/.*` path_regex rule. If missing, automatically add it using the same age recipients from the existing `vault\.yaml$` rule, then proceed. Print a note: "Updated .sops.yaml with env file encryption rule."

## Module Structure

New files:
```
src/commands/env/
  mod.rs        — subcommand enum (Push, Pull, Status), dispatch
  push.rs       — file discovery, encryption, git commit/push
  pull.rs       — git pull, decryption, file write
  status.rs     — local vs vault comparison
  utils.rs      — project ID derivation, .env* glob
```

Changes to existing files:
- `src/main.rs` — Add `Env` variant to `Commands` enum with subcommands. Add to biometric gate (env push/pull require auth, status does not). Add dispatch arm.
- `src/commands/mod.rs` — Add `pub mod env;`
- `src/commands/interactive.rs` — Add menu entries for push/pull
- `src/commands/setup/init.rs` — Include `envs/.*` creation rule in `.sops.yaml` for new vaults
- `src/commands/setup/actions.rs` — Update embedded workflow template to trigger on `envs/**` and run `updatekeys` on env files
