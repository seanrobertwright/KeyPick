// Shared setup/env command utilities.

import { existsSync, readFileSync } from "node:fs";
import { ensureDir } from "../../lib/fs.ts";
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
      ensureDir(localBin);
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
// Vault capability probes
// ─────────────────────────────────────────────────────────────────────────────

// True iff this machine's age key matches a current recipient and can decrypt
// vault.yaml. Used to decide whether `sops updatekeys` can run locally or
// whether re-encryption must be deferred to GH Actions / another machine.
export function canDecryptVault(vaultDir: string): boolean {
  const vaultYaml = path.join(vaultDir, "vault.yaml");
  if (!existsSync(vaultYaml)) return true;
  const res = spawnSync("sops", ["-d", "vault.yaml"], {
    cwd: vaultDir,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return res.status === 0;
}

export function hasAutoSyncWorkflow(vaultDir: string): boolean {
  return existsSync(
    path.join(vaultDir, ".github", "workflows", "vault-sync.yml"),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// .sops.yaml recipient editing
// ─────────────────────────────────────────────────────────────────────────────

// Adds `newKey` to EVERY `age:` block in .sops.yaml where it's not already
// present. .sops.yaml may have multiple creation_rules (e.g. `vault.yaml$`
// and `envs/.*`), each with its own age recipient list. The previous
// implementation only appended to the last block, leaving env files
// undecryptable on machines registered via the vault-only path.
//
// Returns the (possibly unchanged) content. If `content === addRecipient(...)`,
// the key was already present in every block — caller can use that
// equality to detect "no-op" and skip commits.
export function addRecipient(content: string, newKey: string): string {
  if (!newKey.startsWith("age1")) {
    throw new Error(`Invalid age public key: ${newKey}`);
  }

  const lines = content.split("\n");

  // Find each contiguous run of age1 lines. Each run is one `age:` block.
  const groups: Array<[number, number]> = [];
  let groupStart: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim().replace(/,+$/, "");
    const isKey = trimmed.startsWith("age1");
    if (isKey && groupStart === null) groupStart = i;
    if (!isKey && groupStart !== null) {
      groups.push([groupStart, i - 1]);
      groupStart = null;
    }
  }
  if (groupStart !== null) groups.push([groupStart, lines.length - 1]);

  if (groups.length === 0) {
    throw new Error("Could not find age key entries in .sops.yaml");
  }

  // Insert in reverse order so earlier group indices don't shift.
  for (let g = groups.length - 1; g >= 0; g--) {
    const [start, end] = groups[g]!;

    let alreadyInGroup = false;
    for (let i = start; i <= end; i++) {
      if (lines[i]!.includes(newKey)) {
        alreadyInGroup = true;
        break;
      }
    }
    if (alreadyInGroup) continue;

    if (!lines[end]!.trimEnd().endsWith(",")) {
      lines[end] = `${lines[end]!.trimEnd()},`;
    }
    const indentMatch = lines[end]!.match(/^\s*/);
    const indent = indentMatch ? indentMatch[0] : "";
    lines.splice(end + 1, 0, `${indent}${newKey}`);
  }

  return `${lines.join("\n")}\n`;
}
