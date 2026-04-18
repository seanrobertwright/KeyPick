# Changelog

All notable changes to KeyPick are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] — 2026-04-18

### Security

- Hardened the `keypick` Claude Code skill (`skills/keypick/SKILL.md`) to prevent
  secrets from leaking into AI conversation context:
  - Removed the `env | grep` verification example, which would have printed
    plaintext key values into the model's tool output. Replaced with the
    safe `${VAR:+set}` presence-check pattern.
  - Added explicit rules forbidding `env`, `printenv`, `set`, `bash -x`, and
    any command whose output displays environment variables.
  - Added explicit rules forbidding `cat`, `Read`, or `Grep` on `.env`,
    `.envrc`, or files produced by `keypick extract`.
  - Clarified that `eval $(keypick auto …) && <command>` is safe only
    because `$(…)` consumes the `export` lines before they reach stdout —
    and that this guarantee evaporates if sibling commands echo env vars.
  - Suggested `keypick copy` over `keypick extract` when the user only
    needs a single value, to avoid writing plaintext to disk.

The installer fetches `SKILL.md` from `master` on every install
(`bin/installer.mjs`), so this patch is live for new installs immediately —
no release tag required.

## [0.2.1] — 2026-04-17

### Fixed

- **Windows Hello focus handling.** Parented the Windows Hello consent dialog
  at creation via `IUserConsentVerifierInterop` so the prompt renders over the
  active terminal instead of falling behind it (c7a2994). After experimenting
  with post-Hello focus restoration (4d76b0d), the extra focus-restore attempts
  were reverted (5839a2a) since parenting-at-creation was sufficient.

### Docs

- Updated the architecture diagram for v0.2.1 (14cea80).

## [0.2.0] — 2026-04-16

### Added

- **`npx` install / uninstall wizard.** KeyPick is now installable via
  `npx github:seanrobertwright/KeyPick install` with a guided, cross-platform
  wizard; `uninstall` mirrors it (0c41990, 7faedbc).
- **Per-project `.env` management** (`keypick env status/push/pull`) for
  syncing project-local `.env` files against the vault.
- **WSL support** for the TypeScript build path.
- **Skill installation:** the installer drops the Claude Code skill into the
  user's skills directory as part of setup (5bc143e).

### Changed

- **TypeScript-only.** The Rust implementation was removed; KeyPick now ships
  as a single Bun-built JavaScript bundle (36b2c60).
- **Distribution via GitHub Releases** rather than npm — the installer pulls
  a signed release tarball so every install gets an identical bundle
  (381adde).

### Fixed

- Pass `--filename-override` so SOPS matches creation rules regardless of cwd
  (b98da41).
- Tolerate Bun/Windows `mkdirSync EEXIST` on OneDrive-backed paths (bd95a7b).
- Wrap recovery-key input as a `Buffer` for `spawnSync` on Windows (ecfff51).
- Pull the Windows Hello dialog to the user's active virtual desktop
  (14955a5).
- Drop `-NonInteractive` from the Windows Hello spawn so the prompt can
  actually take input (9de1bcf).

[0.2.2]: https://github.com/seanrobertwright/KeyPick/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/seanrobertwright/KeyPick/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/seanrobertwright/KeyPick/releases/tag/v0.2.0
