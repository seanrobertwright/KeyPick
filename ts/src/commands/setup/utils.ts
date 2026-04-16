// Shared setup/env command utilities.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import ora, { type Ora } from "ora";

// ─────────────────────────────────────────────────────────────────────────────
// Age key paths
// ─────────────────────────────────────────────────────────────────────────────

export function ageKeyDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error("Could not determine config directory (%APPDATA% not set)");
    return path.join(appData, "sops", "age");
  }
  const home = homedir();
  if (!home) throw new Error("Could not determine home directory");
  return path.join(home, ".config", "sops", "age");
}

export function ageKeyPath(): string {
  return path.join(ageKeyDir(), "keys.txt");
}

// ─────────────────────────────────────────────────────────────────────────────
// Process helpers
// ─────────────────────────────────────────────────────────────────────────────

export function commandExists(name: string): boolean {
  const tool = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(tool, [name], { stdio: "ignore" });
  return result.status === 0;
}

export function runCmd(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.error) throw new Error(`Failed to run \`${cmd}\`: ${result.error.message}`);
  if (result.status === 0) return (result.stdout ?? "").trim();
  throw new Error((result.stderr ?? "").trim());
}

export function runGit(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.error) throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status === 0) return result.stdout ?? "";
  throw new Error(result.stderr ?? "");
}

export function hasRemote(dir: string): boolean {
  try {
    return runGit(dir, ["remote"]).trim() !== "";
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────────────────────

export function spinner(msg: string): Ora {
  return ora({ text: msg, color: "cyan" }).start();
}

export function done(msg: string): void {
  console.log(`  ${chalk.green.bold("✓")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${chalk.yellow.bold("!")} ${msg}`);
}

export function skip(msg: string): void {
  console.log(`  ${chalk.dim("–")} ${chalk.dim(msg)}`);
}

export function explain(lines: string[]): void {
  console.log();
  for (const line of lines) {
    console.log(`  ${chalk.cyan("│")} ${chalk.dim(line)}`);
  }
  console.log();
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform detection (for download URLs)
// ─────────────────────────────────────────────────────────────────────────────

export function platform(): { os: "windows" | "darwin" | "linux"; arch: "amd64" | "arm64" } {
  const os =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return { os, arch };
}

// ─────────────────────────────────────────────────────────────────────────────
// Install dir for downloaded binaries
// ─────────────────────────────────────────────────────────────────────────────

export function installDir(): string {
  const home = homedir();
  if (home) {
    const localBin = path.join(home, ".local", "bin");
    if (existsSync(localBin)) return localBin;
  }

  try {
    const exe = process.execPath;
    const dir = path.dirname(exe);
    if (dir) return dir;
  } catch {
    // ignore
  }

  if (home) {
    const localBin = path.join(home, ".local", "bin");
    try {
      mkdirSync(localBin, { recursive: true });
    } catch {
      // best-effort
    }
    return localBin;
  }

  return ".";
}

// ─────────────────────────────────────────────────────────────────────────────
// Age keys.txt parsing
// ─────────────────────────────────────────────────────────────────────────────

export function readPublicKey(keysPath: string): string {
  let content: string;
  try {
    content = readFileSync(keysPath, "utf8");
  } catch (e) {
    throw new Error(`Cannot read ${keysPath}: ${(e as Error).message}`);
  }
  for (const line of content.split(/\r?\n/)) {
    const prefix = "# public key: ";
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  throw new Error("Could not find public key in keys file");
}

export function shortKey(key: string, len: number): string {
  return key.length >= len ? key.slice(0, len) : key;
}

// ─────────────────────────────────────────────────────────────────────────────
// Git commit + push
// ─────────────────────────────────────────────────────────────────────────────

export function gitCommitAndPush(dir: string, files: string[], message: string): void {
  const sp = spinner("Committing...");
  try {
    runGit(dir, ["add", ...files]);
    runGit(dir, ["commit", "-m", message]);
  } finally {
    sp.stop();
  }
  done("Changes committed");

  if (hasRemote(dir)) {
    const sp2 = spinner("Pushing...");
    try {
      runGit(dir, ["push"]);
      sp2.stop();
      done("Pushed to remote");
    } catch {
      sp2.stop();
      warn("Push failed — you can push manually later");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// .sops.yaml recipient editing
// ─────────────────────────────────────────────────────────────────────────────

export function addRecipient(content: string, newKey: string): string {
  if (!newKey.startsWith("age1")) {
    throw new Error(`Invalid age public key: ${newKey}`);
  }
  if (content.includes(newKey)) return content;

  const lines = content.split("\n");
  let lastKeyIdx: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim().replace(/,+$/, "");
    if (trimmed.startsWith("age1")) lastKeyIdx = i;
  }

  if (lastKeyIdx === null) {
    throw new Error("Could not find age key entries in .sops.yaml");
  }

  if (!lines[lastKeyIdx]!.trimEnd().endsWith(",")) {
    lines[lastKeyIdx] = `${lines[lastKeyIdx]!.trimEnd()},`;
  }
  const indentMatch = lines[lastKeyIdx]!.match(/^\s*/);
  const indent = indentMatch ? indentMatch[0] : "";
  lines.splice(lastKeyIdx + 1, 0, `${indent}${newKey}`);
  return `${lines.join("\n")}\n`;
}
