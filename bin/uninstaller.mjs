// KeyPick uninstall wizard — Node-compatible, zero deps.
// Run via: npx github:seanrobertwright/KeyPick uninstall

import { homedir, platform } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

import {
  banner, box, why, log, confirm, done, cancelled, color,
} from "./ui.mjs";

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

const CONFIG_DIR = process.env.KEYPICK_HOME ||
  (IS_WIN
    ? path.join(process.env.USERPROFILE || HOME, ".keypick")
    : path.join(HOME, ".keypick"));

const AGE_KEYS = IS_WIN
  ? path.join(process.env.APPDATA || "", "sops", "age", "keys.txt")
  : path.join(HOME, ".config", "sops", "age", "keys.txt");

const SKILL_DIR = path.join(HOME, ".claude", "skills", "keypick");

const TOTAL_STEPS = 5;

function rm(target, label) {
  try {
    const stat = fs.lstatSync(target);
    fs.rmSync(target, { recursive: true, force: true });
    log.ok(`Removed ${label}: ${color.cyan(target)}`);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") {
      log.skip(`${label} not present: ${color.gray(target)}`);
    } else {
      log.warn(`Could not remove ${label} (${target}): ${e.message}`);
    }
    return false;
  }
}

async function main() {
  banner();
  box("Uninstaller", [
    color.bold("Heads up.") + " This wizard removes KeyPick from your machine.",
    "",
    "It will offer to remove: the bundle, shim, legacy installs, config,",
    "cloned vaults, the Claude Code skill, and your age private key.",
    "",
    color.yellow("  !  Your remote git repo — and vaults on other machines — are NOT affected."),
    color.dim("Press Ctrl+C at any time to abort."),
  ], { color: color.yellow });

  if (!(await confirm("Proceed with uninstall?", false))) {
    cancelled();
    process.exit(0);
  }

  stepRemoveCurrent();
  stepRemoveLegacy();
  await stepRemoveConfig();
  await stepRemoveSkill();
  await stepRemoveAgeKey();

  done("Uninstall complete.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — Current install (bundle + shim)
// ─────────────────────────────────────────────────────────────────────────────
function stepRemoveCurrent() {
  log.step(1, TOTAL_STEPS, "Remove bundle and shim");
  why(
    "This removes the files KeyPick placed when you installed it: the "
    + "bundle at " + color.cyan(SHARE_DIR) + " and the shim in "
    + color.cyan(BIN_DIR) + ". Safe to remove — none of your vault data "
    + "lives in these directories.",
  );

  rm(SHARE_DIR, "bundle");
  rm(path.join(BIN_DIR, IS_WIN ? "keypick.cmd" : "keypick"), "shim");
  if (IS_WIN) rm(path.join(BIN_DIR, "keypick"), "shim (nix-style)");
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — Legacy installs
// ─────────────────────────────────────────────────────────────────────────────
function stepRemoveLegacy() {
  log.step(2, TOTAL_STEPS, "Remove legacy installations");
  why(
    "Earlier versions of KeyPick shipped via `bun install -g` or a Rust "
    + "cargo build. Those leave artifacts in different directories that the "
    + "normal uninstall doesn't cover. We sweep them up here.",
  );

  // Legacy: bun global install
  const bunCheck = spawnSync(IS_WIN ? "where" : "which", ["bun"], { stdio: "pipe" });
  if (bunCheck.status === 0) {
    const lst = spawnSync("bun", ["pm", "ls", "-g"], { stdio: "pipe", encoding: "utf8" });
    if ((lst.stdout || "").toLowerCase().includes("keypick")) {
      log.info("Removing legacy bun global install…");
      spawnSync("bun", ["remove", "-g", "keypick"], { stdio: "inherit" });
    }
  }
  const bunBase = path.join(HOME, ".bun", "bin");
  for (const f of ["keypick", "keypick.exe", "keypick.bunx"]) {
    rm(path.join(bunBase, f), "legacy bun shim");
  }
  rm(path.join(HOME, ".bun", "install", "global", "node_modules", "keypick"), "legacy bun package dir");

  // Legacy: cargo install
  const cargoCheck = spawnSync(IS_WIN ? "where" : "which", ["cargo"], { stdio: "pipe" });
  if (cargoCheck.status === 0) {
    const lst = spawnSync("cargo", ["install", "--list"], { stdio: "pipe", encoding: "utf8" });
    if (/^keypick/m.test(lst.stdout || "")) {
      log.info("Removing legacy cargo install…");
      spawnSync("cargo", ["uninstall", "keypick"], { stdio: "inherit" });
    }
  }
  const cargoBase = path.join(HOME, ".cargo", "bin");
  for (const f of ["keypick", "keypick.exe", "keypick2.exe"]) {
    rm(path.join(cargoBase, f), "legacy cargo artifact");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Config + cloned vaults
// ─────────────────────────────────────────────────────────────────────────────
async function stepRemoveConfig() {
  log.step(3, TOTAL_STEPS, "Remove config and cloned vaults");
  why(
    "KeyPick clones your vault repositories into " + color.cyan(CONFIG_DIR) + ". "
    + "Removing this directory deletes the LOCAL copies only — your git remotes "
    + "(e.g. on GitHub) and your vaults on other machines are untouched. You can "
    + "always re-clone later with `keypick setup`.",
  );

  if (!fs.existsSync(CONFIG_DIR)) {
    log.skip(`No config dir at ${color.gray(CONFIG_DIR)}`);
    return;
  }

  log.warn(`Contents of ${color.cyan(CONFIG_DIR)}:`);
  try {
    const entries = fs.readdirSync(CONFIG_DIR).slice(0, 10);
    for (const e of entries) log.info("  " + e);
  } catch {
    /* best-effort listing */
  }

  if (await confirm(`Remove ${CONFIG_DIR}?`, true)) {
    rm(CONFIG_DIR, "config dir");
  } else {
    log.skip(`Kept ${color.gray(CONFIG_DIR)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — Claude Code skill
// ─────────────────────────────────────────────────────────────────────────────
async function stepRemoveSkill() {
  log.step(4, TOTAL_STEPS, "Remove the Claude Code skill");
  why(
    "The global skill lives at " + color.cyan(SKILL_DIR) + ". We only remove "
    + "the GLOBAL installation here. Project-scope installations "
    + "(./.claude/skills/keypick in individual repos) are left alone — remove "
    + "them per-project if needed.",
  );

  if (!fs.existsSync(SKILL_DIR)) {
    log.skip(`No skill at ${color.gray(SKILL_DIR)}`);
    return;
  }

  if (await confirm(`Remove the KeyPick skill at ${SKILL_DIR}?`, true)) {
    rm(SKILL_DIR, "skill");
  } else {
    log.skip(`Kept ${color.gray(SKILL_DIR)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — Age private key
// ─────────────────────────────────────────────────────────────────────────────
async function stepRemoveAgeKey() {
  log.step(5, TOTAL_STEPS, "Remove the age private key");
  why(
    "This is the ONLY key that can decrypt your vault on THIS machine. "
    + "Without a recovery key, another enrolled machine, or a backup, deleting "
    + "it makes this machine's copy of the vault permanently unreadable. "
    + "Default is NO for a reason.",
  );

  if (!fs.existsSync(AGE_KEYS)) {
    log.skip(`No age private key at ${color.gray(AGE_KEYS)}`);
    return;
  }

  box("DANGER", [
    color.bold(color.red("Irreversible.")),
    "",
    "Age private key location: " + color.cyan(AGE_KEYS),
    "",
    "If you delete this AND don't have a recovery key AND no other machine",
    "is enrolled AND no backup exists — your vault contents on this machine",
    "are permanently inaccessible.",
  ], { color: color.red });

  if (await confirm("Delete age private key anyway?", false)) {
    rm(AGE_KEYS, "age private key");
  } else {
    log.skip("Kept age private key");
  }
}

main().catch((e) => {
  log.err(e.stack || e.message || String(e));
  process.exit(1);
});
