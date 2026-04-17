// Vault: on-disk SOPS-encrypted YAML, in-memory representation, and path resolution.

import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { ensureDir } from "./fs.ts";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { select } from "@inquirer/prompts";
import * as terminal from "./terminal.ts";

/**
 * In-memory representation of vault.yaml.
 *
 * Disk layout (SOPS-encrypted YAML):
 *   services:
 *     Supabase_Prod:
 *       DB_HOST: "db.supabase.co"
 *       DB_PASSWORD: "secret"
 *     Google_AI:
 *       API_KEY: "gl-..."
 */
export type VaultData = {
  services: Record<string, Record<string, string>>;
};

export function emptyVault(): VaultData {
  return { services: {} };
}

const VAULT_FILE = "vault.yaml";
const SOPS_FILE = ".sops.yaml";
const APP_DIR = "keypick";
const VAULTS_DIR = "vaults";
const ACTIVE_VAULT_FILE = "active_vault.txt";

// ─────────────────────────────────────────────────────────────────────────────
// Debug logging (gated by KEYPICK_DEBUG_VAULT=1)
// ─────────────────────────────────────────────────────────────────────────────

function debugVaultEnabled(): boolean {
  return process.env.KEYPICK_DEBUG_VAULT === "1";
}

function debugVault(message: string): void {
  if (debugVaultEnabled()) {
    console.error(`[keypick] ${message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────────────

function isVaultDir(p: string): boolean {
  return existsSync(path.join(p, VAULT_FILE)) && existsSync(path.join(p, SOPS_FILE));
}

function appConfigDir(): string {
  const override = process.env.KEYPICK_HOME;
  if (override && override.trim() !== "") return override.trim();

  const home = homedir();
  if (home) return path.join(home, `.${APP_DIR}`);
  return path.join(".", APP_DIR);
}

export function vaultsHomeDir(): string {
  return path.join(appConfigDir(), VAULTS_DIR);
}

function activeVaultFile(): string {
  return path.join(appConfigDir(), ACTIVE_VAULT_FILE);
}

/**
 * Locate the local age public key from the sops keys.txt file.
 * Windows: %AppData%/sops/age/keys.txt
 * Unix:    ~/.config/sops/age/keys.txt
 */
function localAgePublicKey(): string | null {
  let keyPath: string;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    keyPath = path.join(appData, "sops", "age", "keys.txt");
  } else {
    const home = homedir();
    if (!home) return null;
    keyPath = path.join(home, ".config", "sops", "age", "keys.txt");
  }

  let content: string;
  try {
    content = readFileSync(keyPath, "utf8");
  } catch {
    return null;
  }

  for (const line of content.split(/\r?\n/)) {
    const prefix = "# public key: ";
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return null;
}

function vaultAllowsLocalKey(dir: string, localKey: string): boolean {
  try {
    const content = readFileSync(path.join(dir, SOPS_FILE), "utf8");
    return content.includes(localKey);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Active-vault memory
// ─────────────────────────────────────────────────────────────────────────────

export function rememberVaultDir(dir: string): void {
  const configDir = appConfigDir();
  try {
    ensureDir(configDir);
  } catch (e) {
    throw new Error(
      `Failed to create ${configDir}: ${(e as Error).message}. Set KEYPICK_HOME to a writable directory if needed.`,
    );
  }
  try {
    writeFileSync(activeVaultFile(), dir);
  } catch (e) {
    throw new Error(
      `Failed to save active vault in ${configDir}: ${(e as Error).message}. Set KEYPICK_HOME to a writable directory if needed.`,
    );
  }
}

function rememberedVaultDir(): string | null {
  try {
    const content = readFileSync(activeVaultFile(), "utf8").trim();
    return isVaultDir(content) ? content : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

function ancestors(start: string): string[] {
  const result: string[] = [];
  let current = path.resolve(start);
  while (true) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

function discoverInAncestors(): string | null {
  let cwd: string;
  try {
    cwd = process.cwd();
  } catch {
    return null;
  }
  debugVault(`cwd for ancestor scan: ${cwd}`);

  for (const dir of ancestors(cwd)) {
    debugVault(`checking ancestor: ${dir}`);
    if (isVaultDir(dir)) {
      debugVault(`selected ancestor vault: ${dir}`);
      return dir;
    }
  }
  return null;
}

function discoverChildVaults(base: string, label: string): string[] {
  debugVault(`scanning ${label} for child vaults: ${base}`);
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch (e) {
    throw new Error(`Failed to scan ${base} for vault repos: ${(e as Error).message}`);
  }

  const candidates: string[] = [];
  for (const name of entries) {
    const full = path.join(base, name);
    try {
      if (isVaultDir(full)) {
        debugVault(`found child vault candidate: ${full}`);
        candidates.push(full);
      }
    } catch {
      // ignore
    }
  }
  candidates.sort();
  return candidates;
}

async function chooseVaultInteractively(candidates: string[], source: string): Promise<string | null> {
  try {
    const selected = await select({
      message: `Select a KeyPick vault from ${source}:`,
      choices: candidates.map((c) => ({ value: c, name: c })),
    });
    return selected;
  } catch {
    throw new Error(
      "Multiple vault repositories are available. Re-run interactively, run inside the vault repo you want, or set KEYPICK_VAULT_DIR.",
    );
  }
}

async function selectFromCandidates(candidates: string[], source: string): Promise<string | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;

  const localKey = localAgePublicKey();
  if (localKey) {
    debugVault(`matching child vaults against local key: ${localKey}`);
    const matching = candidates.filter((p) => vaultAllowsLocalKey(p, localKey));
    debugVault(
      `child vaults matching local key: ${matching.length === 0 ? "<none>" : matching.join(", ")}`,
    );
    if (matching.length === 1) {
      debugVault(`selected child vault by local key match: ${matching[0]}`);
      return matching[0] ?? null;
    }
    if (matching.length > 1) {
      return chooseVaultInteractively(matching, source);
    }
  }

  return chooseVaultInteractively(candidates, source);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public discovery API
// ─────────────────────────────────────────────────────────────────────────────

export function currentVaultDir(): string | null {
  const envDir = process.env.KEYPICK_VAULT_DIR;
  if (envDir) {
    if (isVaultDir(envDir)) return envDir;
  }

  const ancestor = discoverInAncestors();
  if (ancestor) return ancestor;

  return rememberedVaultDir();
}

export function listKnownVaults(): string[] {
  const vaults: string[] = [];

  const current = currentVaultDir();
  if (current) vaults.push(current);

  const home = vaultsHomeDir();
  if (existsSync(home)) {
    try {
      for (const child of discoverChildVaults(home, "KeyPick vault home")) {
        if (!vaults.includes(child)) vaults.push(child);
      }
    } catch {
      // ignore
    }
  }

  try {
    const cwd = process.cwd();
    for (const child of discoverChildVaults(cwd, "current directory")) {
      if (!vaults.includes(child)) vaults.push(child);
    }
  } catch {
    // ignore
  }

  return vaults;
}

export async function selectKnownVaultInteractively(): Promise<string> {
  const vaults = listKnownVaults();
  if (vaults.length === 0) {
    throw new Error(`No KeyPick vaults were found under ${vaultsHomeDir()}.`);
  }
  if (vaults.length === 1) {
    const only = vaults[0]!;
    rememberVaultDir(only);
    return only;
  }
  const chosen = await chooseVaultInteractively(vaults, "known vaults");
  if (!chosen) throw new Error("Vault selection cancelled.");
  rememberVaultDir(chosen);
  return chosen;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vault directory resolution (async — may prompt)
// ─────────────────────────────────────────────────────────────────────────────

async function resolveVaultDir(): Promise<string> {
  const envDir = process.env.KEYPICK_VAULT_DIR;
  if (envDir) {
    debugVault(`KEYPICK_VAULT_DIR is set: ${envDir}`);
    if (isVaultDir(envDir)) return envDir;
    throw new Error(
      `KEYPICK_VAULT_DIR is set to ${envDir}, but that directory does not contain both ${VAULT_FILE} and ${SOPS_FILE}.`,
    );
  }

  const ancestor = discoverInAncestors();
  if (ancestor) return ancestor;

  const remembered = rememberedVaultDir();
  if (remembered) {
    debugVault(`using remembered vault: ${remembered}`);
    return remembered;
  }

  const home = vaultsHomeDir();
  if (existsSync(home)) {
    const picked = await selectFromCandidates(discoverChildVaults(home, "KeyPick vault home"), "KeyPick vault home");
    if (picked) return picked;
  }

  let cwd: string;
  try {
    cwd = process.cwd();
  } catch (e) {
    throw new Error(`Failed to read current directory: ${(e as Error).message}`);
  }

  const picked = await selectFromCandidates(discoverChildVaults(cwd, "current directory"), "current directory");
  if (picked) return picked;

  throw new Error(
    `Could not find a vault repository.\n\nLooked in:\n  - current directory and its parents\n  - remembered KeyPick vault\n  - ${home}\n  - direct child directories of ${cwd}\n\nSet KEYPICK_VAULT_DIR if your vault lives elsewhere, or run \`keypick setup\` to create one under the default vault home.`,
  );
}

/**
 * Resolve the vault directory or exit cleanly with the error message.
 */
async function resolveVaultDirOrExit(): Promise<string> {
  try {
    return await resolveVaultDir();
  } catch (e) {
    console.error((e as Error).message);
    terminal.cleanupAndExit(1);
  }
}

async function vaultFilePath(): Promise<string> {
  const resolved = await resolveVaultDirOrExit();

  if (debugVaultEnabled()) {
    const localKey = localAgePublicKey() ?? "<not found>";
    console.error(`[keypick] resolved vault dir: ${resolved}`);
    console.error(`[keypick] local age public key: ${localKey}`);
  }

  try {
    rememberVaultDir(resolved);
  } catch {
    // best-effort
  }
  return path.join(resolved, VAULT_FILE);
}

export async function vaultDir(): Promise<string> {
  const resolved = await resolveVaultDirOrExit();
  try {
    rememberVaultDir(resolved);
  } catch {
    // best-effort
  }
  return resolved;
}

export function defaultVaultDir(name: string): string {
  return path.join(vaultsHomeDir(), name);
}

// ─────────────────────────────────────────────────────────────────────────────
// SOPS encrypt/decrypt
// ─────────────────────────────────────────────────────────────────────────────

/** Decrypt vault.yaml via SOPS and parse into a Vault struct. */
export async function load(): Promise<VaultData> {
  const vaultFile = await vaultFilePath();
  const result = spawnSync("sops", ["-d", vaultFile], {
    cwd: path.dirname(vaultFile),
    encoding: "buffer",
  });

  if (result.error) {
    console.error(
      "ERROR: Could not run `sops`. Make sure sops.exe is in your PATH.\nDownload: https://github.com/getsops/sops/releases",
    );
    terminal.cleanupAndExit(1);
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf8") ?? "";
    console.error(`SOPS decryption failed:\n${stderr}`);
    console.error(
      "\nHint: Make sure your age private key is at:\n  Windows: %AppData%\\sops\\age\\keys.txt\n  macOS/Linux: ~/.config/sops/age/keys.txt",
    );
    terminal.cleanupAndExit(1);
  }

  const stdout = result.stdout?.toString("utf8") ?? "";
  const parsed = YAML.parse(stdout);
  if (!parsed || typeof parsed !== "object" || !("services" in parsed)) {
    return emptyVault();
  }
  return parsed as VaultData;
}

/** Serialize the Vault and encrypt it back to vault.yaml via SOPS. */
export async function save(vault: VaultData): Promise<void> {
  const dir = await vaultDir();
  const vaultFile = path.join(dir, VAULT_FILE);
  const yamlData = YAML.stringify(vault);

  // Write plaintext to temp file in the vault dir so SOPS picks up .sops.yaml rules
  const tmpPath = path.join(dir, "vault.yaml.tmp");
  writeFileSync(tmpPath, yamlData);

  // --filename-override makes SOPS match creation_rules against vault.yaml
  // instead of vault.yaml.tmp (which won't match a `vault\.yaml$` rule).
  const result = spawnSync(
    "sops",
    [
      "--encrypt",
      "--input-type", "yaml",
      "--output-type", "yaml",
      "--filename-override", VAULT_FILE,
      "--output", vaultFile,
      tmpPath,
    ],
    { cwd: dir, encoding: "buffer" },
  );

  try {
    rmSync(tmpPath, { force: true });
  } catch {
    // best-effort
  }

  if (result.error) {
    console.error("ERROR: Could not spawn sops for encryption.");
    terminal.cleanupAndExit(1);
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf8") ?? "";
    console.error(`SOPS encryption failed:\n${stderr}`);
    terminal.cleanupAndExit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a group's keys as KEY=VALUE lines suitable for a .env file.
 * Keys are emitted in sorted order.
 */
export function keysToEnv(keys: Record<string, string>): string {
  return Object.keys(keys)
    .sort()
    .map((k) => `${k}=${keys[k]}\n`)
    .join("");
}

/**
 * Format a group's keys as `export KEY='VALUE'` lines suitable for shell eval.
 * Keys are emitted in sorted order.
 */
export function keysToExports(keys: Record<string, string>): string {
  return Object.keys(keys)
    .sort()
    .map((k) => `export ${k}='${keys[k]!.replace(/'/g, "'\\''")}'\n`)
    .join("");
}
