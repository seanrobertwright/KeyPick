# Changelog

All notable changes to KeyPick are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Key names reached shell `export` lines unchecked** (#4). A key named
  `X=1;touch /tmp/marker;Y` ran `touch` under `eval "$(keypick auto …)"`.
  `auto` and `extract` now refuse a vault whose requested keys aren't shell
  variable names (`^[A-Za-z_][A-Za-z0-9_]*$`): they print nothing to stdout,
  write no file, name each bad key on stderr without its value, and exit 1.
  Fix such names by editing the vault with `sops`. A vault whose names are
  all valid gives the same output as before.
- `extract` also refuses a value containing a line break, since `.env`
  values are unquoted and the break would start another variable, and a
  group name containing a control character, which would break the
  `# --- <group> ---` header line.
- `keypick add` asks again for a key name that isn't a shell variable name
  or a new group name that doesn't match `^[A-Za-z0-9][A-Za-z0-9_.-]*$`, and
  refuses `__proto__`, `constructor`, and `prototype` as either. Its
  "Remember to sync" hint names the group in the commit message only when
  the name passes that rule.
- Group and key lookups use own properties only, so
  `keypick auto constructor` reports the group as not found.
- `keypick env push`, `pull`, and `status` refuse a project id that is `.`
  or `..` or contains `/`, `\`, or a control character. A remote ending in
  `/..` used to point them at the vault root.

### Fixed

- **`eval $(keypick auto …)` set no variables** (#3). The ASCII banner
  printed to stdout before `auto`'s output, and `auto` wrote a `# <Group>`
  line before each group, which hid every later `export` once unquoted
  `$(…)` collapsed the output onto one line. `auto` now writes only
  `export` lines to stdout. The banner appears only for the no-argument
  interactive menu when stdout is a terminal, so subcommands, `--version`,
  and `--help` no longer print it. The vault picker, which `auto` shows on
  a first run when several vaults are found, now renders on stderr.

### Docs

- `README.md`, the Claude Code skill, and the `auto` source comment now use
  the quoted form `eval "$(keypick auto …)"`, which keeps runs of spaces in
  values and doesn't glob-expand them.
- The skill tells agents not to run `keypick auto` bare to debug a failed
  injection, since its stdout is the plaintext `export` lines.
- `README.md` and `TUTORIAL.md` give the key and group name rules. The README
  troubleshooting section covers vault names that can't be exported and
  project ids that can't be used as a folder. The skill explains that a
  refused `auto` still lets the chained command run, without those keys.

### Tests

- Added a `bun test` integration suite (`bun run test` in `ts/`) that builds a
  throwaway sops/age vault and evaluates `keypick auto` output through bash.
  CI installs sops and age and runs it.
- Added tests for the name checks: the issue #4 repro against a real vault,
  unit tests on the `export` and `.env` emitters and the `add` name rules,
  and project-id tests against real git repos, including `keypick env status`.

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

[Unreleased]: https://github.com/seanrobertwright/KeyPick/compare/v0.2.3...HEAD
[0.2.2]: https://github.com/seanrobertwright/KeyPick/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/seanrobertwright/KeyPick/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/seanrobertwright/KeyPick/releases/tag/v0.2.0
