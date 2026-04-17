// KeyPick install wizard — Node-compatible, zero deps.
// Run via: npx github:seanrobertwright/KeyPick install

import { homedir, platform, tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  banner, box, why, log, confirm, choose, showCommand, done, cancelled, color,
} from "./ui.mjs";

const REPO = process.env.KEYPICK_REPO || "seanrobertwright/KeyPick";
const IS_WIN = platform() === "win32";
const HOME = homedir();

const SHARE_DIR = process.env.KEYPICK_SHARE_DIR ||
  (IS_WIN
    ? path.join(process.env.USERPROFILE || HOME, ".local", "share", "keypick")
    : path.join(HOME, ".local", "share", "keypick"));

const BIN_DIR = process.env.KEYPICK_BIN_DIR ||
  (IS_WIN
    ? path.join(process.env.USERPROFILE || HOME, ".local", "bin")
    : path.join(HOME, ".local", "bin"));

const TOTAL_STEPS = 5;

async function main() {
  banner();
  box("Installer", [
    color.bold("Welcome.") + " This wizard installs KeyPick on your machine.",
    "",
    "The wizard will:",
    "  " + color.cyan("•") + " Download the latest release from GitHub",
    "  " + color.cyan("•") + " Place the binary and shim in per-user paths",
    "  " + color.cyan("•") + " Check your PATH",
    "  " + color.cyan("•") + " Optionally install the Claude Code skill",
    "",
    color.dim("Press Ctrl+C at any time to abort."),
  ]);

  if (!(await confirm("Ready to install?", true))) {
    cancelled();
    process.exit(0);
  }

  await stepCheckBun();
  const tag = await stepFetchRelease();
  await stepInstallBundle(tag);
  await stepCheckPath();
  await stepInstallSkill();

  done("KeyPick installed.");
  box("Next", [
    "Run the interactive setup to create or join a vault:",
    "",
    color.bold(color.green("  keypick setup")),
    "",
    color.dim("If `keypick` is not found, open a new shell or add "
      + BIN_DIR + " to your PATH."),
  ], { color: color.magenta });
  showCommand("keypick setup", "Suggested next command");
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — Bun
// ─────────────────────────────────────────────────────────────────────────────
async function stepCheckBun() {
  log.step(1, TOTAL_STEPS, "Check for Bun");
  why(
    "KeyPick is distributed as a single JavaScript bundle that runs on the "
    + "Bun runtime. Bun gives us fast startup and native binary output without "
    + "asking you to install Node + npm just to run a CLI. We need to verify "
    + "it's on your PATH before we download anything.",
  );

  const found = spawnSync(IS_WIN ? "where" : "which", ["bun"], { stdio: "pipe" });
  if (found.status === 0) {
    const v = spawnSync("bun", ["--version"], { stdio: "pipe", encoding: "utf8" });
    log.ok("Bun found: " + color.bold((v.stdout || "").trim()));
    return;
  }

  log.err("Bun is not installed.");
  box("Install Bun first", [
    "Pick your platform:",
    "",
    color.bold("macOS / Linux / WSL:"),
    "  " + color.green("curl -fsSL https://bun.sh/install | bash"),
    "",
    color.bold("Windows (PowerShell):"),
    "  " + color.green("irm bun.sh/install.ps1 | iex"),
    "",
    "Re-run this installer once Bun is on your PATH.",
  ], { color: color.yellow });
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — Fetch release tag
// ─────────────────────────────────────────────────────────────────────────────
async function stepFetchRelease() {
  log.step(2, TOTAL_STEPS, "Find the latest KeyPick release");
  why(
    "The installer pulls a signed release tarball from GitHub rather than "
    + "building from source. This keeps the install fast and reproducible — "
    + "everyone on your team gets the exact same bundle the release was cut from.",
  );

  log.info("Querying " + color.cyan(`api.github.com/repos/${REPO}/releases/latest`));
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": "keypick-installer" },
  });
  if (!res.ok) {
    log.err(`GitHub API returned ${res.status}. Check your network and try again.`);
    process.exit(1);
  }
  const body = await res.json();
  const tag = body.tag_name;
  if (!tag) {
    log.err("Release has no tag_name — aborting.");
    process.exit(1);
  }
  log.ok("Latest tag: " + color.bold(tag));
  return tag;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Install bundle + shim
// ─────────────────────────────────────────────────────────────────────────────
async function stepInstallBundle(tag) {
  log.step(3, TOTAL_STEPS, "Install the KeyPick bundle");
  why(
    "KeyPick lives in two places: the bundle (JavaScript) at "
    + color.cyan(SHARE_DIR)
    + " and a small shim at "
    + color.cyan(BIN_DIR)
    + " that puts the `keypick` command on your PATH. Putting them in "
    + "per-user directories means no sudo and no system-wide pollution.",
  );

  const asset = IS_WIN ? `keypick-${tag}.zip` : `keypick-${tag}.tar.gz`;
  const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
  const tmp = fs.mkdtempSync(path.join(tmpdir(), "keypick-install-"));
  const downloadPath = path.join(tmp, asset);

  try {
    log.info("Downloading " + color.cyan(url));
    await downloadFile(url, downloadPath);

    const extractDir = path.join(tmp, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    log.info("Extracting archive…");
    await extractArchive(downloadPath, extractDir);

    const bundleDir = path.join(extractDir, `keypick-${tag}`);
    const bundleSrc = path.join(bundleDir, "keypick.js");
    const pkgSrc = path.join(bundleDir, "package.json");
    if (!fs.existsSync(bundleSrc)) {
      log.err(`keypick.js missing from release archive (looked in ${bundleDir}).`);
      process.exit(1);
    }

    fs.mkdirSync(SHARE_DIR, { recursive: true });
    fs.mkdirSync(BIN_DIR, { recursive: true });

    const bundleDst = path.join(SHARE_DIR, "keypick.js");
    fs.copyFileSync(bundleSrc, bundleDst);
    try { fs.chmodSync(bundleDst, 0o755); } catch { /* Windows ignores chmod */ }
    if (fs.existsSync(pkgSrc)) {
      fs.copyFileSync(pkgSrc, path.join(SHARE_DIR, "package.json"));
    }
    log.ok("Bundle placed at " + color.cyan(bundleDst));

    if (IS_WIN) {
      const shimPath = path.join(BIN_DIR, "keypick.cmd");
      const shim = `@echo off\r\nbun "${bundleDst}" %*\r\n`;
      fs.writeFileSync(shimPath, shim, { encoding: "ascii" });
      log.ok("Shim written at " + color.cyan(shimPath));
    } else {
      const shimPath = path.join(BIN_DIR, "keypick");
      try { fs.unlinkSync(shimPath); } catch { /* not present */ }
      fs.symlinkSync(bundleDst, shimPath);
      log.ok("Symlink written at " + color.cyan(shimPath));
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

async function downloadFile(url, dest) {
  const res = await fetch(url, { headers: { "User-Agent": "keypick-installer" } });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function extractArchive(archivePath, destDir) {
  if (archivePath.endsWith(".zip")) {
    if (IS_WIN) {
      const r = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-Command",
          `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`],
        { stdio: "inherit" },
      );
      if (r.status !== 0) throw new Error("Expand-Archive failed");
    } else {
      const r = spawnSync("unzip", ["-q", "-o", archivePath, "-d", destDir], { stdio: "inherit" });
      if (r.status !== 0) throw new Error("unzip failed (is it installed?)");
    }
    return;
  }
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    const r = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("tar failed");
    return;
  }
  throw new Error(`Unknown archive type: ${archivePath}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — PATH
// ─────────────────────────────────────────────────────────────────────────────
async function stepCheckPath() {
  log.step(4, TOTAL_STEPS, "Check your PATH");
  why(
    "The shim at " + color.cyan(BIN_DIR) + " only works if that directory is on "
    + "your PATH. If it isn't, the `keypick` command won't be found and you'll "
    + "need to call it by its full path. We check here and help you fix it.",
  );

  const parts = (process.env.PATH || "").split(IS_WIN ? ";" : ":");
  if (parts.includes(BIN_DIR)) {
    log.ok(color.cyan(BIN_DIR) + " is already on your PATH.");
    return;
  }

  log.warn(color.cyan(BIN_DIR) + " is NOT on your PATH.");
  if (IS_WIN) {
    box("Add to PATH (Windows)", [
      "Run the following in PowerShell to append it to your user PATH:",
      "",
      color.bold(color.green(
        `[Environment]::SetEnvironmentVariable('Path', ` +
        `[Environment]::GetEnvironmentVariable('Path','User') + ';${BIN_DIR}', 'User')`,
      )),
      "",
      color.dim("Restart your shell afterwards."),
    ], { color: color.yellow });
    showCommand(
      `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${BIN_DIR}', 'User')`,
      "Copy & run in PowerShell",
    );
  } else {
    const line = `export PATH="${BIN_DIR}:$PATH"`;
    box("Add to PATH (macOS / Linux)", [
      "Add this line to your shell profile",
      color.dim("(~/.zshrc, ~/.bashrc, ~/.config/fish/config.fish, etc.)") + ":",
      "",
      color.bold(color.green("  " + line)),
      "",
      color.dim("Then source the file or open a new shell."),
    ], { color: color.yellow });
    showCommand(line, "Copy into your shell profile");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — Skill
// ─────────────────────────────────────────────────────────────────────────────
async function stepInstallSkill() {
  log.step(5, TOTAL_STEPS, "Install the Claude Code skill (optional)");
  why(
    "The KeyPick skill teaches Claude Code how to inject your vault keys "
    + "into commands without asking you to paste secrets into chat. Install "
    + "it globally to use KeyPick in every Claude Code session, install it "
    + "per-project to scope it to one repo, or skip.",
  );

  const scope = await choose("Where should the skill be installed?", [
    { key: "G", label: "Global — available in every project (" +
        color.cyan(path.join(HOME, ".claude", "skills", "keypick")) + ")" },
    { key: "P", label: "Project — this directory only (" +
        color.cyan(path.join(process.cwd(), ".claude", "skills", "keypick")) + ")" },
    { key: "S", label: "Skip" },
  ]);

  if (!scope || scope.toUpperCase() === "S") {
    log.skip("Skipping skill installation.");
    return;
  }

  const dest = scope.toUpperCase() === "G"
    ? path.join(HOME, ".claude", "skills", "keypick")
    : path.join(process.cwd(), ".claude", "skills", "keypick");

  fs.mkdirSync(dest, { recursive: true });
  const url = `https://raw.githubusercontent.com/${REPO}/master/skills/keypick/SKILL.md`;
  log.info("Fetching " + color.cyan(url));
  try {
    await downloadFile(url, path.join(dest, "SKILL.md"));
    log.ok("Skill installed at " + color.cyan(dest));
  } catch (e) {
    log.err("Failed to fetch skill: " + e.message);
    log.warn("You can install it manually later by copying skills/keypick/SKILL.md from the repo.");
  }
}

main().catch((e) => {
  log.err(e.stack || e.message || String(e));
  process.exit(1);
});
