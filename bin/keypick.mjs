#!/usr/bin/env node
// KeyPick dispatcher (Node-compatible).
//
// Entry point for `npx github:seanrobertwright/KeyPick <command>`.
// Dispatches:
//   install     — run the install wizard
//   uninstall   — run the uninstall wizard
//   (anything else) — forward to the installed Bun-built keypick, if present

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2];

function importSibling(file) {
  return import(pathToFileURL(path.join(__dirname, file)).href);
}

if (arg === "install") {
  await importSibling("installer.mjs");
} else if (arg === "uninstall") {
  await importSibling("uninstaller.mjs");
} else {
  forwardToInstalled();
}

function forwardToInstalled() {
  const IS_WIN = platform() === "win32";
  const HOME = homedir();
  const shareDir = process.env.KEYPICK_SHARE_DIR ||
    (IS_WIN
      ? path.join(process.env.USERPROFILE || HOME, ".local", "share", "keypick")
      : path.join(HOME, ".local", "share", "keypick"));
  const bundle = path.join(shareDir, "keypick.js");

  if (!fs.existsSync(bundle)) {
    process.stderr.write(
      "KeyPick is not installed yet.\n\n" +
      "Run:  npx github:seanrobertwright/KeyPick install\n"
    );
    process.exit(1);
  }

  const bunCheck = spawnSync(IS_WIN ? "where" : "which", ["bun"], { stdio: "pipe" });
  if (bunCheck.status !== 0) {
    process.stderr.write(
      "KeyPick needs Bun at runtime: https://bun.sh\n"
    );
    process.exit(1);
  }

  const result = spawnSync("bun", [bundle, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
