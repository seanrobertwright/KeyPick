# Can KeyPick ship as a standalone binary on every platform?

Research for wayfinder ticket #12 (map #9). Feeds the decision ticket #21,
"How is KeyPick v0.3 distributed and installed?". Researched 2026-10-10.
This document presents findings and options. It does not make the decision.

## Question

Can KeyPick ship as a standalone executable (no Bun or Node on the user's
machine) for Windows x64/arm64, macOS x64/arm64, Linux x64/arm64, and WSL?
What breaks or needs extra work: `bun build --compile` targets, size and
startup; the Windows Hello, Touch ID and polkit helpers in `ts/src/lib/auth.ts`;
`clipboardy`; the bundled `ts/src/assets/vault-sync.yml`; code signing and
notarization; and the Homebrew, Scoop, winget and curl/PowerShell channels?

## Summary

- **Building works for every target.** One Windows x64 host produced binaries
  for all six requested targets plus Linux musl. Every binary I could run
  started and printed `--version`: Windows x64 natively, Linux x64 in WSL2,
  Linux arm64 under qemu, and Linux musl on Alpine. The darwin and Windows arm64
  binaries were built but not run. Binaries are 64–99 MB raw and 24–38 MB
  gzipped, against 0.68 MB for today's JS bundle. Startup is a little faster than
  today's `bun keypick.js`.
- **Two features break in a compiled binary, and both are already broken in the
  v0.2.3 release.** The `vault-sync.yml` lookup builds a path from
  `import.meta.url` (the `WORKFLOW_ASSET_PATH` constant in `actions.ts`).
  clipboardy 4 runs a helper `.exe` that it finds the same way. Neither file
  exists next to a bundle or inside a compiled binary, and the v0.2.3 archive
  ships only `keypick.js`. Embedding the YAML with
  `import ... with { type: "text" }` works in every mode. clipboardy 5 fixes
  clipboard on Windows and probably on WSL.
- **Windows Hello and WSL auth survive compilation unchanged.** The PowerShell
  script is passed inline, so nothing needs to exist on disk. I ran the real
  script from compiled binaries on Windows and in WSL, up to the availability
  check, and both succeeded. polkit is an external `pkexec` and behaves the same.
  On macOS, `swift` from the Xcode Command Line Tools is still needed at
  runtime. A standalone binary does not remove that dependency unless KeyPick
  ships a prebuilt helper.
- **sops, age, git and gh stay external.** A standalone binary removes Bun and
  Node, not these tools. Every package channel can declare sops and age as
  dependencies, because all three have them.
- **macOS: every binary needs re-signing on a Mac.** Both darwin outputs carry
  stale signatures. The x64 output keeps Bun's own Developer ID signature, which
  no longer matches the file. Ad-hoc signing is enough for curl and Homebrew
  formula installs. Browser downloads and Homebrew casks need Developer ID and
  notarization, which costs 99 USD a year, and Apple cannot staple a ticket to a
  bare binary.
- **Windows: unsigned binaries show warnings only in some cases.** An unsigned
  exe triggers the "Windows protected your PC" warning when it carries Mark of
  the Web, which browser downloads do. `Invoke-WebRequest` and `curl.exe` did not
  add Mark of the Web in my test. Smart App Control blocks unsigned files
  whatever their origin. EV certificates no longer bypass SmartScreen.
  Microsoft's Artifact Signing starts at 9.99 USD a month, but individual
  developers must be in the US or Canada.
- **Channel effort is mostly CI work on top of a GitHub Release.** That release
  carries per-target archives and a `SHA256SUMS` file. A Homebrew tap, a Scoop
  bucket and pinned curl/`irm` installers are each a small addition. winget adds
  antivirus scanning and manual review. GoReleaser has had a Bun builder since
  v2.6 and can generate most of this.
- **The release pipeline needs to grow.** It goes from one Ubuntu job that
  builds a JS bundle to a matrix: a macOS step for signing, a Windows step for
  exe metadata and optional Authenticode, and per-OS smoke tests. Pin Bun to
  1.4.2 or later. It fixes the cross-compile extraction bug I hit, and Bun 1.4.1
  lists a darwin-arm64 signature fix.

## Per-platform results

| Platform | Bun target | Builds? (raw / gzip) | Starts? | Auth helper in a compiled binary | Clipboard in a compiled binary | Signing need |
| --- | --- | --- | --- | --- | --- | --- |
| Windows x64 | `bun-windows-x64` | Yes (99.2 MB / 38.3 MB) | Yes, native | Works. Script passed inline via `-Command`. Verified up to the availability check. | Broken with clipboardy 4. clipboardy 5 works (read verified). | Optional. Unsigned triggers SmartScreen on browser downloads, and Smart App Control blocks it. |
| Windows arm64 | `bun-windows-arm64` | Yes (95.3 MB / 36.7 MB) | Not run (no arm64 host). The x64 build also runs under Windows 11 x64 emulation. | Expected to match x64, since inbox Windows PowerShell does the work. Unverified on hardware. | clipboardy 5 picks the PowerShell path first. Unverified. | Same as x64 |
| macOS x64 | `bun-darwin-x64` | Yes (69.8 MB / 26.6 MB) | Not run (no Mac) | Still needs `swift` (Xcode CLT) at runtime. Compiling changes nothing. | `pbcopy`, a system tool. Not run. | Must be re-signed: output carries Bun's Developer ID signature, now invalid. Notarize for browser downloads and casks. |
| macOS arm64 | `bun-darwin-arm64` | Yes (64.1 MB / 24.1 MB) | Not run (no Mac) | As x64 | As x64 | Ad-hoc signed by Bun, but one page hash is wrong on 1.3.14. Re-sign. Apple silicon refuses unsigned code. |
| Linux x64 (glibc) | `bun-linux-x64` | Yes (95.3 MB / 36.0 MB) | Yes (WSL2 Ubuntu 24.04) | `pkexec /bin/true`, an external tool, works as before | Needs `xsel` (or `wl-copy` with clipboardy 5) on PATH. The bundled `xsel` fallback cannot be reached. | None |
| Linux arm64 (glibc) | `bun-linux-arm64` | Yes (94.3 MB / 35.8 MB) | Yes (Debian bookworm under qemu) | As Linux x64 | As Linux x64 | None |
| Linux musl (Alpine) | `bun-linux-x64-musl` (an arm64 musl target also exists) | Yes (91.8 MB / 34.7 MB) | Yes on Alpine 3.20 after `apk add libstdc++ libgcc`. The glibc build does not start on Alpine. | As Linux x64 | As Linux x64 | None |
| WSL2 | Linux x64/arm64 builds | As Linux | Yes (WSL2 Ubuntu 24.04) | `powershell.exe` over interop runs Windows Hello on the host. Verified up to the availability check. | Broken with clipboardy 4. clipboardy 5 copies via `clip.exe` (not exercised) and fails to paste. KeyPick only copies. | None |

Bun's documented minimums apply to all targets: macOS 13.0 or later,
Windows 10 1809 or later, and glibc 2.17 or later for glibc builds
([Bun installation](https://bun.com/docs/installation)).
The x64 build runs on Windows 11 on Arm through x64 emulation
([Microsoft: emulation on Arm](https://learn.microsoft.com/en-us/windows/arm/apps-on-arm-x86-emulation)).

## Hands-on results

Environment: Windows 11 Pro x64, Bun 1.3.14, Windows PowerShell 5.1 and
PowerShell 7.6, WSL2 Ubuntu 24.04 (glibc 2.39), and Docker Desktop for
`debian:bookworm-slim` (arm64 under qemu) and `alpine:3.20`. All output went to a
temp directory outside the repository. No binary is committed. No command
touched a vault or decrypted anything.

### Build and cross-compile

- `bun build --compile src/main.ts --outfile <tmp>/keypick` from `ts/` built
  221 modules in about 1.7 s.
- Every cross target failed on this host with
  `Failed to extract executable for 'bun-linux-x64-v1.3.14'. The download may be incomplete.`
  This is [oven-sh/bun#43446](https://github.com/oven-sh/bun/issues/43446). Bun
  1.3.14 fails when the working directory and the Bun cache are on different
  volumes, and 1.4.2 fixes it. The issue reports that GitHub-hosted Windows
  runners have this layout. To work around it, I downloaded `@oven/bun-<target>`
  1.3.14 from npm and passed `--compile-executable-path`. After that, all targets
  built in under 1 s each.
- The CI workflows currently set `bun-version: latest`. Bun 1.4.3 was the latest
  release on the research date, so these measurements come from an older Bun.

### Size

| Output | Raw bytes | gzip -9 bytes |
| --- | --- | --- |
| Windows x64 | 99,150,336 | 38,326,209 |
| Windows x64, `--minify --bytecode` | 101,786,624 | 39,009,042 |
| Windows arm64 | 95,254,016 | 36,692,630 |
| macOS x64 | 69,845,072 | 26,569,671 |
| macOS arm64 | 64,123,106 | 24,067,098 |
| Linux x64 | 95,262,848 | 35,991,385 |
| Linux arm64 | 94,349,456 | 35,759,738 |
| Linux x64 musl | 91,842,848 | 34,678,769 |
| Today's `keypick.js` (v0.2.3 asset) | 681,533 | n/a |

Almost all of each binary is the Bun runtime: the Linux x64 runtime alone is
92,752,752 bytes. Bun's docs admit that "Bun's binary is still way too big"
([Bun executables](https://bun.com/docs/bundler/executables)).
GitHub caps each release file at 2 GiB and sets no total size limit
([About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)).

### Startup

On the Windows host, I took the median of 20 `--version` runs after 2 warm-up
runs:

| Mode | Median |
| --- | --- |
| Compiled, default flags | 99.1 ms |
| Compiled, `--minify --bytecode` | 83.6 ms |
| `bun keypick.js` (today's install) | 110.8 ms |
| `bun src/main.ts` (dev) | 196.4 ms |

The Linux x64 binary inside WSL2 averaged 62 ms over 20 runs.

`--version` prints `0.2.2` while `ts/package.json` says `0.2.3`, because the
`VERSION` constant in `ts/src/main.ts` is typed by hand. A release build should
inject the version, for example with `--define`, so that `brew test` and winget
report the right number.

### Embedded asset: `vault-sync.yml`

`WORKFLOW_ASSET_PATH` in `ts/src/commands/setup/actions.ts` strips `file://`
from `import.meta.url` and walks to `../../assets/vault-sync.yml`. A probe
reproduced that expression:

| Mode | `import.meta.url` | Resolved path | Exists |
| --- | --- | --- | --- |
| Compiled, Windows | `file:///B:/%7EBUN/root/...` | `B:\assets\vault-sync.yml` | No |
| Compiled, Linux (WSL) | `file:///$bunfs/root/...` | `assets/vault-sync.yml`, a relative path | No |
| Release-style bundle at `~/.local/share/keypick/keypick.js` | the bundle file | a sibling `assets/` dir that the installer never creates | No |

- On POSIX, the regex `^file:\/\/\/?` also eats the leading `/`, so even the
  dev path is relative to the working directory. Only the fallbacks to the
  working directory rescue it, and only inside a KeyPick checkout.
- The v0.2.3 release archive holds only `keypick.js`, `package.json`,
  `README.md` and `LICENSE`. `keypick setup`'s GitHub Actions step therefore
  cannot find the workflow outside a checkout today.
- `import workflow from "../../assets/vault-sync.yml" with { type: "text" }`
  embedded 2,752 bytes and loaded correctly from source, from the bundle, and
  from the compiled Windows and Linux binaries. Bun documents text imports as
  embedded modules ([Bun executables](https://bun.com/docs/bundler/executables)).
  The CI job that keeps `ts/src/assets/vault-sync.yml` in sync with
  `.github/workflows/vault-sync.yml` can stay as it is.

### Clipboard: `clipboardy`

KeyPick uses clipboardy 4.0.0 only to write, from `ts/src/commands/copy.ts`. On
Windows and WSL it runs `fallbacks/windows/clipboard_x86_64.exe`, which it finds
relative to its own module URL. On Linux it tries `xsel` on PATH and then a
bundled x86-64 `xsel`. On macOS it runs `pbcopy`.

To avoid overwriting the clipboard, the probes called `clipboard.read()`, never
`write()`, and printed only success or failure:

| clipboardy | Mode | Result |
| --- | --- | --- |
| 4.0.0 | `bun` from source | ok |
| 4.0.0 | release-style bundle, Windows | failed: the helper path resolves to a `fallbacks\windows\` folder beside the bundle's directory, which does not exist |
| 4.0.0 | compiled, Windows | failed: `B:\~BUN\fallbacks\windows\clipboard_x86_64.exe` |
| 4.0.0 | compiled Linux, in WSL | failed: `ENOENT /$bunfs/fallbacks/windows/clipboard_x86_64.exe` |
| 5.3.2 | compiled, Windows | ok (PowerShell `Get-Clipboard`) |
| 5.3.2 | compiled Linux, in WSL | failed: `powershell-utils` builds a Windows-style path under `%SystemRoot%`, which Linux cannot run |

- clipboardy 5.3.2 is the latest release. On Windows it uses PowerShell
  `Set-Clipboard` and `Get-Clipboard` first and falls back to the helper exe only
  if the exe exists on disk. On WSL it copies with `clip.exe` and pastes through
  the Windows code path. On Wayland it uses `wl-copy` and falls back to `xsel`.
  These behaviours come from the package's `lib/windows.js`, `lib/wsl.js` and
  `lib/wayland.js` in the npm tarball.
- `copy` in a compiled binary should therefore work on Windows with clipboardy
  5, and on WSL as long as `clip.exe` is reachable. I did not exercise the WSL
  write path, to avoid overwriting the clipboard.
- On Linux, a compiled binary needs `xsel`, or `wl-copy` with clipboardy 5, on
  PATH.
- A smaller option is about 40 lines of KeyPick code calling `pbcopy`,
  `clip.exe` or `Set-Clipboard`, `wl-copy`, `xclip` or `xsel` directly.

### Biometric helpers in `ts/src/lib/auth.ts`

- **Windows and WSL.** A probe ran the script text that `windowsHelloScript`
  generates, cut off after the availability check so that no Hello prompt
  appeared. The compiled Windows exe launched `powershell.exe` with the same
  arguments as `runWindowsHello`, and so did the compiled Linux binary in WSL
  over interop. Both printed `add-type:interop`, `winrt:load-types` and
  `availability:Available`, then exited 0. In-memory C# `Add-Type` and the WinRT
  projection both work when the parent process is a compiled Bun binary.
- **macOS.** `verifyMacOS` writes a `.swift` file to the temp directory and runs
  `swift <file>`. That requires the Xcode Command Line Tools on the user's Mac.
  A compiled binary cannot change this. Options:
  - Keep requiring the Command Line Tools. This is the current behaviour, but it
    breaks the "nothing to install" promise.
  - Build a Swift helper in CI as a universal binary, sign it with the same
    identity, embed it with `with { type: "file" }`, and copy it to a cache
    directory before running it. Bun documents embedding but not running
    embedded files ([Bun executables](https://bun.com/docs/bundler/executables)).
  - Call `LAContext` through `osascript -l JavaScript`. Unverified.
- **Linux.** `verifyLinux` spawns `pkexec /bin/true`. That is an external tool,
  unchanged by compiling. I did not exercise it.

### Signatures on the outputs

- **Windows.** The compiled exe reports `NotSigned` from
  `Get-AuthenticodeSignature`, even though the host `bun.exe` carries a valid
  signature. The exe's version resource says ProductName `Bun`, CompanyName
  `Oven`, FileVersion `1.3.14` unless `--windows-title`, `--windows-publisher`,
  `--windows-version` and `--windows-description` are passed. I confirmed that
  those flags set the resource on a host build. Bun's docs say these flags,
  except `hideConsole`, cannot be used when cross-compiling
  ([Bun executables](https://bun.com/docs/bundler/executables)), so Windows
  builds belong on a Windows runner.
- **macOS.** I parsed the Mach-O `LC_CODE_SIGNATURE` and recomputed every
  CodeDirectory page hash.
  - **arm64.** Bun wrote a fresh ad-hoc signature with identifier `a.out`. Every
    page hash matched except the last partial page, which Bun 1.3.14 hashes
    zero-padded to 4 KiB.
    [Bun v1.4.1](https://bun.com/blog/bun-v1.4.1) lists a fix for darwin-arm64
    binaries that "in rare cases failed `codesign -v` and were killed on macOS 27".
    I could not confirm that this fix covers the zero-padding defect.
  - **x64.** The output keeps Bun's original Developer ID signature, with
    entitlements and a CMS blob, but 55 of its 16,753 page hashes no longer
    match. A third-party project describes the same state for both darwin
    targets and re-signs them on a macOS runner with
    `codesign --force --sign -`
    ([anomalyco/opencode#48428](https://github.com/anomalyco/opencode/pull/48428)).
    A similar truncated-signature regression shipped in Bun 1.3.12
    ([oven-sh/bun#29120](https://github.com/oven-sh/bun/issues/29120)).

### `.env` and `bunfig.toml` autoload

Bun's docs say compiled executables load `.env` and `bunfig.toml` by default,
and that `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig` turn
this off ([Bun executables](https://bun.com/docs/bundler/executables)). The Bun
runtime also loads `.env` automatically
([Bun env](https://bun.com/docs/runtime/env)), so today's install behaves the
same way.

`keypick extract` writes a `.env` file into the current directory. Running
`keypick` again from that directory loads those values into KeyPick's own
environment and passes them to child processes such as `sops`, `git` and `gh`. A release build should
pass both `--no-compile-autoload-*` flags.

I also put a `bunfig.toml` with a `preload` entry in the working directory. The
preload did not run, either in the compiled binary or under `bun keypick.js`.

## Other code changes a binary needs

- **`installDir` in `ts/src/commands/setup/utils.ts`.** When `~/.local/bin` is
  missing, it falls back to `dirname(process.execPath)`. In a compiled binary
  installed by Homebrew or Scoop, that is the package manager's directory, so the
  `age` and `sops` self-installer in `prerequisites.ts` would write there. Under a
  package manager, sops and age should come from declared dependencies, and
  KeyPick should prefer whatever is on PATH.
- **Prerequisite downloads.** `prerequisites.ts` downloads age 1.2.0 and
  sops 3.9.4 from GitHub with no checksum check. This is the same gap the
  installers have.
- **`bin/keypick.mjs`.** The `npx` dispatcher forwards to
  `bun ~/.local/share/keypick/keypick.js`. It would forward to the binary
  instead, or go away.
- **`bin/installer.mjs`.** It says it pulls "a signed release tarball". No
  signature exists today, so that sentence needs correcting whatever is
  decided.

## Code signing and notarization

### macOS

- **Apple silicon refuses unsigned code.** Apple silicon Macs run an executable
  only if it is signed, but "a simple ad-hoc signature is sufficient"
  ([Apple: macOS Big Sur universal apps release notes](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes)).
- **Gatekeeper usually checks only quarantined files.** "Most Unix-y tools don't
  quarantine their downloads, including curl and scp"
  ([Apple Developer Forums, Quinn](https://developer.apple.com/forums/thread/666452)).
  A curl installer with an ad-hoc signed binary therefore runs. A browser
  download of the same binary is blocked unless it is notarized. I did not find
  a primary source on whether Homebrew formula downloads are quarantined.
- **Notarization requirements.** It requires a Developer ID certificate from the
  Apple Developer Program, at 99 USD per membership year
  ([Apple: enroll](https://developer.apple.com/programs/enroll/),
  [Developer ID](https://developer.apple.com/support/developer-id/)).
  The notary service accepts ZIP, DMG and flat PKG. "Although tickets are created
  for standalone binaries, it's not currently possible to staple tickets to
  them", so Gatekeeper looks the ticket up online
  ([Apple: customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)).
- **Hardened runtime and JIT.** Bun recommends signing with entitlements for JIT
  (`allow-jit`, `allow-unsigned-executable-memory`,
  `disable-executable-page-protection`, `allow-dyld-environment-variables`,
  `disable-library-validation`) and needs Bun 1.2.4 or later for this
  ([Bun executables](https://bun.com/docs/bundler/executables)).
- **Signing without a Mac.** GoReleaser's cross-platform `notarize` uses
  anchore/quill, "works on any operating system", handles standalone binaries,
  and takes an entitlements file
  ([GoReleaser notarize](https://goreleaser.com/customization/notarize/)).
- **Homebrew casks.** Homebrew 5.0.0 deprecated `--no-quarantine` and said it
  "will disable all Homebrew/homebrew-cask casks that fail Gatekeeper checks in
  September 2026" ([Homebrew 5.0.0](https://brew.sh/2025/11/12/homebrew-5.0.0/)).
  That rule names the official cask repository, not third-party taps. GoReleaser
  says casks in a tap should still be signed, and documents an
  `xattr -dr com.apple.quarantine` hook as the unsigned fallback
  ([GoReleaser homebrew_casks](https://goreleaser.com/customization/homebrew_casks/)).

### Windows

- **SmartScreen.** Microsoft's table: an unsigned or self-signed file gets
  "Windows protected your PC". A file signed with an OV or EV certificate is still
  "flagged as unrecognized until reputation accumulates", but shows the publisher
  name. "EV certificates no longer bypass SmartScreen." Unsigned files "must
  build reputation anew with every update"
  ([Microsoft: SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
- **Smart App Control.** On Windows 11, it "will block execution of unsigned
  files unless the file has a positive reputation", and it checks all
  executables, not only downloads (same source).
- **Mark of the Web.** In my test, files downloaded with `Invoke-WebRequest`
  (PowerShell 7.6 and Windows PowerShell 5.1) and with `curl.exe` had no
  `Zone.Identifier` stream. A script install therefore does not trigger the
  download-reputation prompt. Whether Scoop and winget add Mark of the Web is
  unverified.
- **Artifact Signing (formerly Trusted Signing).** It "starts at $9.99/month"
  and needs no hardware token
  ([Microsoft: SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
  "Individual developers must be located in the United States or Canada", and
  validation uses a government ID
  ([Artifact Signing quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)).
  The Basic SKU includes 5,000 signatures a month
  ([pricing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/)).
- **SignPath Foundation.** It offers free code signing for open-source projects,
  with the foundation vouching for the binary ([signpath.org](https://signpath.org/)).
  I could not confirm its eligibility terms.
- **Antivirus false positives.** Antivirus products have flagged the Bun runtime
  itself ([oven-sh/bun#16981](https://github.com/oven-sh/bun/issues/16981),
  [oven-sh/bun#28707](https://github.com/oven-sh/bun/issues/28707)). A compiled
  KeyPick embeds that runtime, so it inherits the risk. I did not measure it.

## What each channel needs

### GitHub Release (the base for every other channel)

- **Assets.** Per-target archives named like
  `keypick-vX.Y.Z-<os>-<arch>.tar.gz`, or `.zip` for Windows, plus `SHA256SUMS`.
- **Digests.** GitHub computes a SHA256 digest for every uploaded asset and shows
  it in the UI, the API and `gh`
  ([GitHub changelog: release asset digests](https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/)).
- **Immutable releases.** They lock assets and tags after publishing and are
  generally available
  ([GitHub changelog: immutable releases GA](https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/)).
- **Provenance.** Artifact attestations use `actions/attest`, need
  `id-token: write`, `attestations: write` and `contents: read`, and are checked
  with `gh attestation verify <file> -R <owner>/KeyPick`
  ([GitHub: artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)).
- **Stable links.** `/releases/latest/download/<asset>` always points at the
  latest asset
  ([GitHub: linking to releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)).

### curl and PowerShell installers

Today, `install.sh` and `install.ps1` are fetched from `master`. They ask the API
for `releases/latest`, download `keypick.js`, verify nothing, and refuse to run
without Bun. A pinned, checked installer would:

- detect the OS and architecture, treating WSL as Linux and detecting musl;
- accept a `KEYPICK_VERSION` setting and download from
  `/releases/download/<tag>/`;
- download `SHA256SUMS` and verify it with `sha256sum -c` or `shasum -a 256` on
  POSIX and `Get-FileHash` on Windows, failing closed on a mismatch;
- install one file into `~/.local/bin` or `%USERPROFILE%\.local\bin`;
- be attached to each release, so a version-pinned installer URL exists;
- optionally run `gh attestation verify` when `gh` is present;
- drop the Bun check.

### Homebrew tap

- **Repository.** Name it `homebrew-<name>`. Users run
  `brew install <owner>/<tap>/keypick`. Formulae live in `Formula/`
  ([Homebrew: taps](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap)).
- **Formula or cask.** A tap formula can install the prebuilt binary, using
  `on_macos`, `on_linux`, `on_arm` and `on_intel` blocks
  ([Formula Cookbook](https://docs.brew.sh/Formula-Cookbook)) and a
  `test do` block that runs `keypick --version`. A cask can also ship a CLI:
  `binary` "works on either operating system", and cross-platform casks use
  `on_linux` ([Cask Cookbook](https://docs.brew.sh/Cask-Cookbook)). Casks bring
  Gatekeeper into play (see Signing).
- **GoReleaser's direction.** GoReleaser deprecated its formula generator
  (`brews`, soft in v2.10, since v2.16) in favour of `homebrew_casks`
  ([GoReleaser deprecations](https://goreleaser.com/deprecations/)).
- **Dependencies.** Homebrew core has `sops` (3.13.3) and `age` (1.3.2), so a
  formula can `depends_on` both ([formulae.brew.sh](https://formulae.brew.sh/)).
- **Getting into homebrew/core.** Core formulae "must either build from source
  or install portable, platform-independent output"
  ([Acceptable Formulae](https://docs.brew.sh/Acceptable-Formulae)). Core has a
  source-built `bun` formula (1.4.2), so a source-built KeyPick formula is
  conceivable later.

### Scoop bucket

- **Repository.** A bucket is "a Git repository containing JSON app manifests",
  and the BucketTemplate includes auto-update Actions. Users run
  `scoop bucket add <name> <repo-url>`
  ([Scoop: Buckets](https://github.com/ScoopInstaller/Scoop/wiki/Buckets)).
- **Manifest fields.** `version`, `description`, `homepage` and `license` are
  required. Add `architecture.64bit` and `architecture.arm64` with `url` and a
  SHA256 `hash`, plus `bin`, `checkver`, `autoupdate` and `depends`
  ([Scoop: App Manifests](https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests)).
- **Dependencies.** `sops` is in the main bucket and its manifest declares
  `depends: gpg`. `age` is in the extras bucket. Whether `depends` can name an
  app from another bucket is unverified.

### winget

- **Submission.** Send a PR to `microsoft/winget-pkgs` with version,
  defaultLocale and installer manifests. `wingetcreate` can generate and submit
  them ([winget: manifest](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest)).
- **Installer type.** For a zip, use `InstallerType: zip` with
  `NestedInstallerType: portable`, `NestedInstallerFiles` and
  `PortableCommandAlias: keypick`. For a bare exe, use `InstallerType: portable`.
  Declare `x64` and `arm64` architectures and an `InstallerSha256`. Package
  dependencies "must come from the same source"
  ([winget installer schema 1.12](https://github.com/microsoft/winget-pkgs/blob/master/doc/manifest/schema/1.12.0/installer.md)).
  `FiloSottile.age` and a `SecretsOPerationS.SOPS` package exist in winget-pkgs.
- **Validation.** Automated checks include URL reputation, Microsoft Defender
  dynamic testing, and "several antivirus programs" (`Binary-Validation-Error`),
  followed by moderator review. Installer URLs must come "directly from the
  publisher's website", and redirectors are rejected
  ([winget: submit](https://learn.microsoft.com/en-us/windows/package-manager/package/repository)).
  Every release needs a new PR, so it should be automated.

## Release pipeline changes

`.github/workflows/release.yml` today has one `ubuntu-latest` job. It installs
`bun-version: latest`, typechecks, builds `dist/keypick.js`, uploads a tar.gz and
a zip, and writes release notes saying "Requires Bun + Node 18+". Permissions are
`contents: write` at workflow level.

A binary release would change it as follows:

- **Pin Bun** to 1.4.2 or later.
- **Build** Linux and darwin targets on Ubuntu, or let GoReleaser do it with
  `builder: bun`
  ([GoReleaser Bun builder](https://goreleaser.com/customization/builds/bun/);
  the page does not say which edition includes it). Build Windows on a Windows
  runner so that the `--windows-*` metadata applies. Pass
  `--no-compile-autoload-dotenv`, `--no-compile-autoload-bunfig` and an injected
  version.
- **Re-sign darwin outputs on macOS**, either ad-hoc or Developer ID plus
  notarization, and smoke-test `--version` on each OS family.
- **Publish integrity data**: `SHA256SUMS` and attestations. Move permissions to
  the job level: `id-token: write` and `attestations: write` only on the attest
  job.
- **Push to the tap, bucket and winget.** This needs a token scoped to those
  repositories, with the narrowest permission that works.
- **Rewrite the release notes** for the new install paths.

## Implications for KeyPick

The options below are not mutually exclusive. Effort: S is under a day, M is a
few days, L is a week or more, assuming one maintainer.

**Prerequisites for any binary.** These fix bugs that exist today:

- embed `vault-sync.yml` with a text import;
- move clipboard off clipboardy 4;
- inject the version at build time;
- disable `.env` and `bunfig` autoload;
- correct the "signed release tarball" sentence.

Effort: S–M. Risk: low.

1. **Binaries on GitHub Releases plus pinned curl and `irm` installers with
   checksums.** macOS gets ad-hoc re-signing on a Mac runner. Windows stays
   unsigned.
   - Effort: M, mostly the CI matrix and installer rewrite.
   - Risk: browser downloads hit Gatekeeper on macOS and SmartScreen on
     Windows. Smart App Control blocks the unsigned exe. Antivirus false
     positives on the embedded Bun runtime are possible. Touch ID still needs the
     Xcode CLT. Downloads are about 24–38 MB per platform instead of 0.7 MB.
2. **Option 1 plus a Homebrew tap and a Scoop bucket**, both declaring sops and
   age.
   - Effort: S each on top of option 1, and GoReleaser can generate both.
   - Risk: a CI token with write access to the tap and bucket repositories. A
     formula that ships a prebuilt binary goes against Homebrew's stated
     direction. A cask brings Gatekeeper into play unless the binary is
     notarized or the documented `xattr` hook is used.
3. **Option 2 plus real signing.** Apple Developer ID and notarization, at
   99 USD a year. On Windows, either Artifact Signing (from 9.99 USD a month,
   individuals in the US or Canada only) or SignPath Foundation (free for open
   source, eligibility unverified).
   - Effort: M, including identity validation and secret handling in CI.
   - Risk: certificate and secret management. Notarization cannot be stapled to
     a bare binary, so first-run checks need network access. Signing on Windows
     still does not give instant SmartScreen reputation.
4. **winget.**
   - Effort: M for the first PR, then S per release once automated.
   - Risk: the antivirus and Defender scans may reject the binary because of
     its embedded Bun runtime. Manual review adds latency.
5. **Keep the JS bundle and require only Bun.** Fix the prerequisite bugs and
   make the shell installers the only path, dropping Node and npx.
   - Effort: S.
   - Risk: does not meet the "no runtime" goal, and Bun is still a hurdle for
     users who find KeyPick cold.
6. **Touch ID without the Command Line Tools.** This is a separate choice:
   - keep requiring the CLT (effort S, cold-start friction);
   - ship a signed, prebuilt universal Swift helper embedded in the binary
     (effort M, needs a macOS CI job and signing);
   - prototype JXA via `osascript` (effort S–M, unverified).

## Not verified

- I did not run the darwin and Windows arm64 binaries, the macOS Touch ID path,
  or Linux `pkexec`.
- I did not exercise the clipboard write path, to avoid overwriting the
  clipboard. Only reads were tested.
- I don't know whether the Bun 1.4.1 darwin-arm64 fix covers the zero-padded
  last page I observed on 1.3.14, or whether 1.4.x still leaves the x64 output
  with Bun's invalid Developer ID signature.
- I don't know whether Homebrew formula downloads, Scoop or winget add
  quarantine or Mark of the Web.
- I could not confirm SignPath Foundation's eligibility terms or the price of a
  conventional OV certificate.
- I could not confirm that Scoop `depends` works across buckets.
- I could not confirm that the JXA/`osascript` route to `LAContext` works.
- I did not measure antivirus detection rates for a compiled KeyPick.
- I could not confirm which GoReleaser edition includes the Bun builder.

## Sources

- Bun: [single-file executables](https://bun.com/docs/bundler/executables),
  [installation](https://bun.com/docs/installation),
  [environment variables](https://bun.com/docs/runtime/env),
  [v1.4.1 release notes](https://bun.com/blog/bun-v1.4.1),
  [#43446](https://github.com/oven-sh/bun/issues/43446),
  [#29120](https://github.com/oven-sh/bun/issues/29120),
  [#16981](https://github.com/oven-sh/bun/issues/16981),
  [#28707](https://github.com/oven-sh/bun/issues/28707)
- Apple: [Big Sur universal apps release notes](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes),
  [customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow),
  [Developer ID](https://developer.apple.com/support/developer-id/),
  [program enrollment](https://developer.apple.com/programs/enroll/),
  [forum thread 666452](https://developer.apple.com/forums/thread/666452)
- Microsoft: [SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation),
  [Artifact Signing overview](https://learn.microsoft.com/en-us/azure/trusted-signing/overview),
  [Artifact Signing quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart),
  [Artifact Signing pricing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/),
  [emulation on Arm](https://learn.microsoft.com/en-us/windows/arm/apps-on-arm-x86-emulation),
  [winget manifest](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest),
  [winget submission](https://learn.microsoft.com/en-us/windows/package-manager/package/repository),
  [winget installer schema 1.12](https://github.com/microsoft/winget-pkgs/blob/master/doc/manifest/schema/1.12.0/installer.md)
- Homebrew: [taps](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap),
  [Acceptable Formulae](https://docs.brew.sh/Acceptable-Formulae),
  [Formula Cookbook](https://docs.brew.sh/Formula-Cookbook),
  [Cask Cookbook](https://docs.brew.sh/Cask-Cookbook),
  [Homebrew 5.0.0](https://brew.sh/2025/11/12/homebrew-5.0.0/),
  [formulae.brew.sh](https://formulae.brew.sh/)
- Scoop: [App Manifests](https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests),
  [Buckets](https://github.com/ScoopInstaller/Scoop/wiki/Buckets)
- GoReleaser: [Bun builder](https://goreleaser.com/customization/builds/bun/),
  [homebrew_casks](https://goreleaser.com/customization/homebrew_casks/),
  [notarize](https://goreleaser.com/customization/notarize/),
  [deprecations](https://goreleaser.com/deprecations/)
- GitHub: [about releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases),
  [linking to releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases),
  [release asset digests](https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/),
  [immutable releases GA](https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/),
  [artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)
- Third party, corroborating the hands-on signature check:
  [anomalyco/opencode#48428](https://github.com/anomalyco/opencode/pull/48428)
- Other: [SignPath Foundation](https://signpath.org/); the clipboardy 4.0.0 and
  5.3.2 npm packages (`lib/*.js`), read directly.
- KeyPick code read: `ts/src/lib/auth.ts`, `ts/src/lib/wsl.ts`,
  `ts/src/lib/terminal.ts`, `ts/src/commands/copy.ts`,
  `ts/src/commands/setup/actions.ts`, `ts/src/commands/setup/prerequisites.ts`,
  `ts/src/commands/setup/utils.ts`, `ts/src/main.ts`,
  `.github/workflows/release.yml`, `.github/workflows/ci.yml`,
  `bin/installer.mjs`, `bin/keypick.mjs`, `install.sh`, `install.ps1`, and the
  v0.2.3 release archive.
