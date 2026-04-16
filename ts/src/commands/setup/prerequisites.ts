// Check for (and install) age + sops prerequisites.

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import * as utils from "./utils.ts";

const AGE_VERSION = "1.2.0";
const SOPS_VERSION = "3.9.4";

export async function run(verbose: boolean): Promise<void> {
  if (verbose) {
    utils.explain([
      "Checking for 'age' — the encryption engine.",
      "age uses X25519 key agreement and ChaCha20-Poly1305 encryption.",
      "It's what actually encrypts and decrypts your secret values.",
    ]);
  }
  await checkAndInstall("age", AGE_VERSION, installAge);

  if (verbose) {
    utils.explain([
      "Checking for 'sops' — the secret operations manager.",
      "sops wraps age to handle multi-recipient encryption inside",
      "structured files (YAML/JSON). It encrypts VALUES while",
      "leaving KEYS visible, so git diffs stay meaningful.",
    ]);
  }
  await checkAndInstall("sops", SOPS_VERSION, installSops);
}

async function checkAndInstall(
  name: string,
  version: string,
  installer: (version: string) => Promise<void>,
): Promise<void> {
  if (utils.commandExists(name)) {
    let ver = "";
    try {
      ver = utils.runCmd(name, ["--version"]);
    } catch {
      // ignore
    }
    const firstLine = ver.split(/\r?\n/)[0] ?? ver;
    utils.done(`${name} already installed (${firstLine})`);
    return;
  }

  console.log(`  ${chalk.yellow.bold(name)} not found. Installing ${version}...`);
  await installer(version);

  if (utils.commandExists(name)) {
    let ver = "";
    try {
      ver = utils.runCmd(name, ["--version"]);
    } catch {
      // ignore
    }
    const firstLine = ver.split(/\r?\n/)[0] ?? ver;
    utils.done(`${name} installed (${firstLine})`);
    return;
  }

  const dir = utils.installDir();
  throw new Error(
    `${name} was downloaded but is not on PATH.\n  Add ${dir} to your PATH environment variable, then retry.`,
  );
}

async function installAge(version: string): Promise<void> {
  const { os, arch } = utils.platform();
  let filename: string;
  if (os === "windows") filename = `age-v${version}-windows-${arch}.zip`;
  else if (os === "darwin") filename = `age-v${version}-darwin-${arch}.tar.gz`;
  else filename = `age-v${version}-linux-${arch}.tar.gz`;

  const url = `https://github.com/FiloSottile/age/releases/download/v${version}/${filename}`;

  const installDir = utils.installDir();
  const data = await downloadFile(url, filename);

  const tmp = mkdtempSync(path.join(tmpdir(), "keypick-age-"));
  const archivePath = path.join(tmp, filename);
  writeFileSync(archivePath, data);

  extractArchive(archivePath, tmp, os);

  const ext = process.platform === "win32" ? ".exe" : "";
  const ageDir = path.join(tmp, "age");

  const ageSrc = findBinary(ageDir, tmp, `age${ext}`);
  const keygenSrc = findBinary(ageDir, tmp, `age-keygen${ext}`);

  mkdirSync(installDir, { recursive: true });
  copyFileSync(ageSrc, path.join(installDir, `age${ext}`));
  copyFileSync(keygenSrc, path.join(installDir, `age-keygen${ext}`));

  if (process.platform !== "win32") {
    try {
      chmodSync(path.join(installDir, "age"), 0o755);
      chmodSync(path.join(installDir, "age-keygen"), 0o755);
    } catch {
      // best-effort
    }
  }
}

async function installSops(version: string): Promise<void> {
  const { os, arch } = utils.platform();
  let filename: string;
  if (os === "windows") filename = `sops-v${version}.exe`;
  else if (os === "darwin") filename = `sops-v${version}.darwin.${arch}`;
  else filename = `sops-v${version}.linux.${arch}`;

  const url = `https://github.com/getsops/sops/releases/download/v${version}/${filename}`;

  const installDir = utils.installDir();
  const data = await downloadFile(url, filename);

  mkdirSync(installDir, { recursive: true });
  const ext = process.platform === "win32" ? ".exe" : "";
  const dest = path.join(installDir, `sops${ext}`);
  writeFileSync(dest, data);

  if (process.platform !== "win32") {
    try {
      chmodSync(dest, 0o755);
    } catch {
      // best-effort
    }
  }
}

async function downloadFile(url: string, name: string): Promise<Buffer> {
  const sp = ora({ text: `Downloading ${name}...`, color: "cyan" }).start();
  try {
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 120_000);
    let resp: Response;
    try {
      resp = await fetch(url, { signal: ctl.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) {
      throw new Error(`Download failed: HTTP ${resp.status} for ${url}`);
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    throw new Error(`Download failed for ${name}: ${(e as Error).message}`);
  } finally {
    sp.stop();
  }
}

function extractArchive(archive: string, dest: string, os: "windows" | "darwin" | "linux"): void {
  const sp = utils.spinner("Extracting...");
  try {
    let result;
    if (os === "windows" || archive.toLowerCase().endsWith(".zip")) {
      result = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path '${archive}' -DestinationPath '${dest}' -Force`,
        ],
        { encoding: "utf8" },
      );
    } else {
      result = spawnSync("tar", ["xzf", archive, "-C", dest], { encoding: "utf8" });
    }
    if (result.error) throw new Error(`Extract failed: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`Extract failed: ${(result.stderr ?? "").trim()}`);
    }
  } finally {
    sp.stop();
  }
}

function findBinary(primaryDir: string, fallbackDir: string, name: string): string {
  const primary = path.join(primaryDir, name);
  if (existsSync(primary)) return primary;

  for (const p of walkFiles(fallbackDir)) {
    if (path.basename(p) === name) return p;
  }
  throw new Error(`Could not find ${name} in extracted archive`);
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) results.push(...walkFiles(full));
    else results.push(full);
  }
  return results;
}
