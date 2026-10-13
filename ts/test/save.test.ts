// Integration tests for `vault.save` against a real sops/age vault in a git repo.
//
// `save` hands the decrypted vault to `sops --encrypt`. These tests intercept
// that spawn to look at the vault's git working tree while encryption is in
// progress, and to simulate KeyPick dying before `save` can clean up, which is
// when a plaintext file would be left for `git add -A` to commit.
//
// Requires `sops`, `age-keygen`, and `git` on PATH.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type SpawnSync = typeof childProcess.spawnSync;
type EncryptHook = (args: readonly string[], options: childProcess.SpawnSyncOptions) => void;

const realSpawnSync: SpawnSync = childProcess.spawnSync;
let onEncrypt: EncryptHook | null = null;

mock.module("node:child_process", () => ({
  ...childProcess,
  spawnSync: ((cmd: string, args?: readonly string[], options?: childProcess.SpawnSyncOptions) => {
    if (cmd === "sops" && args?.includes("--encrypt") && onEncrypt) onEncrypt(args, options ?? {});
    return realSpawnSync(cmd, args ?? [], options ?? {});
  }) as SpawnSync,
}));

const vault = await import("../src/lib/vault.ts");

// Unique per run, so a match can only come from this test's plaintext.
const SECRET = `plaintext-marker-${process.pid}-${Date.now()}`;

let root: string;
let vaultDir: string;
let keyFile: string;
let seedCommit: string;
const savedEnv: Record<string, string | undefined> = {};

function mustRun(cmd: string, args: string[], cwd?: string): string {
  const result = realSpawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.error) throw new Error(`Could not run \`${cmd}\` (is it on PATH?): ${result.error.message}`);
  if (result.status !== 0) throw new Error(`\`${cmd} ${args.join(" ")}\` exited ${result.status}:\n${result.stderr}`);
  return result.stdout;
}

/** The decrypted vault.yaml. Passes the key explicitly: Bun children don't see runtime process.env changes. */
function decryptVault(): string {
  const result = realSpawnSync("sops", ["-d", path.join(vaultDir, "vault.yaml")], {
    encoding: "utf8",
    env: { ...process.env, SOPS_AGE_KEY_FILE: keyFile },
  });
  if (result.status !== 0) throw new Error(`sops -d exited ${result.status}:
${result.stderr}`);
  return result.stdout;
}

function git(...args: string[]): string {
  return mustRun("git", ["-c", "user.name=KeyPick Test", "-c", "user.email=test@example.invalid", ...args], vaultDir);
}

/** Files under `dir` (skipping .git) whose content contains SECRET, relative to `dir`. */
function filesHoldingSecret(dir: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (readFileSync(full, "utf8").includes(SECRET)) hits.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return hits.sort();
}

/** What `git add -A` would pick up: untracked and modified paths, one per line. */
function workingTreeChanges(): string[] {
  return git("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).sort();
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "keypick-save-test-"));

  keyFile = path.join(root, "keys.txt");
  mustRun("age-keygen", ["-o", keyFile]);
  const publicKey = /^# public key: (\S+)$/m.exec(readFileSync(keyFile, "utf8"))?.[1];
  if (!publicKey) throw new Error(`age-keygen wrote no public key to ${keyFile}`);

  vaultDir = path.join(root, "vault");
  mkdirSync(vaultDir);
  writeFileSync(
    path.join(vaultDir, ".sops.yaml"),
    `creation_rules:\n  - path_regex: vault\\.yaml$\n    age: ${publicKey}\n`,
  );
  // A committed, encrypted starting vault, built without the code under test.
  const seed = path.join(root, "seed.yaml");
  writeFileSync(seed, JSON.stringify({ services: { Seed: { SEED_KEY: "seed" } } }));
  mustRun(
    "sops",
    [
      "--encrypt",
      "--input-type", "yaml",
      "--output-type", "yaml",
      "--filename-override", "vault.yaml",
      "--output", path.join(vaultDir, "vault.yaml"),
      seed,
    ],
    vaultDir,
  );
  rmSync(seed);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  seedCommit = git("rev-parse", "HEAD").trim();

  for (const [name, value] of Object.entries({
    SOPS_AGE_KEY_FILE: keyFile,
    KEYPICK_VAULT_DIR: vaultDir,
    // Keep the remembered-vault file out of the real ~/.keypick.
    KEYPICK_HOME: path.join(root, "home"),
  })) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});

afterAll(() => {
  onEncrypt = null;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The plaintext file sops was asked to encrypt: the last argument of the call. */
function sopsInput(args: readonly string[]): string {
  return args[args.length - 1]!;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function saveSecret(): Promise<void> {
  return vault.save({ services: { Test: { SECRET_KEY: SECRET } } });
}

/** Run `fn` with console.error captured, returning everything it printed. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    await fn();
    return spy.mock.calls.map((call) => call.join(" ")).join("\n");
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  git("reset", "-q", "--hard", seedCommit);
  git("clean", "-q", "-f", "-d");
});

describe("vault.save", () => {
  test("round-trips through sops and leaves the working tree with only vault.yaml changed", async () => {
    await saveSecret();

    expect(workingTreeChanges()).toEqual([" M vault.yaml"]);
    expect(filesHoldingSecret(vaultDir)).toEqual([]);
    expect(decryptVault()).toContain(`SECRET_KEY: ${SECRET}`);
  });

  test("no plaintext exists in the vault working tree while sops encrypts", async () => {
    // Assigned in a callback, so TypeScript can't see it change from null.
    let secretFilesDuringEncrypt = null as string[] | null;
    onEncrypt = () => {
      secretFilesDuringEncrypt = filesHoldingSecret(vaultDir);
    };
    try {
      await saveSecret();
    } finally {
      onEncrypt = null;
    }

    expect(secretFilesDuringEncrypt).toEqual([]);
  });

  test("sops reads the plaintext from a private temp file outside the vault, removed afterwards", async () => {
    let input = "";
    let inputMode = 0;
    let dirMode = 0;
    onEncrypt = (args) => {
      input = sopsInput(args);
      inputMode = statSync(input).mode & 0o777;
      dirMode = statSync(path.dirname(input)).mode & 0o777;
      expect(readFileSync(input, "utf8")).toContain(SECRET);
    };
    try {
      await saveSecret();
    } finally {
      onEncrypt = null;
    }

    expect(isInside(input, vaultDir)).toBe(false);
    expect(isInside(input, tmpdir())).toBe(true);
    if (process.platform !== "win32") {
      expect(inputMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    }
    expect(existsSync(path.dirname(input))).toBe(false);
  });

  test("a crash during encryption leaves nothing in the vault working tree for git add to commit", async () => {
    const before = workingTreeChanges();
    let input = "";
    onEncrypt = (args) => {
      input = sopsInput(args);
      throw new Error("simulated crash while sops runs");
    };
    try {
      await expect(saveSecret()).rejects.toThrow("simulated crash");
    } finally {
      onEncrypt = null;
    }

    expect(filesHoldingSecret(vaultDir)).toEqual([]);
    expect(workingTreeChanges()).toEqual(before);
    // An exception unwinds through save's cleanup; only a hard kill would leave the private temp file.
    expect(existsSync(path.dirname(input))).toBe(false);
  });

  test("removes a vault.yaml.tmp an earlier version left behind, and says what it held", async () => {
    writeFileSync(path.join(vaultDir, "vault.yaml.tmp"), `services:\n  Old:\n    OLD_KEY: ${SECRET}\n`);

    const stderr = await captureStderr(saveSecret);

    expect(existsSync(path.join(vaultDir, "vault.yaml.tmp"))).toBe(false);
    expect(filesHoldingSecret(vaultDir)).toEqual([]);
    expect(stderr).toContain("vault.yaml.tmp");
    expect(stderr).toContain("decrypted vault");
    expect(stderr).not.toContain(SECRET);
    expect(stderr).not.toContain("history");
  });

  test("tells the user to rotate when git history holds a leftover vault.yaml.tmp", async () => {
    writeFileSync(path.join(vaultDir, "vault.yaml.tmp"), `services:\n  Old:\n    OLD_KEY: ${SECRET}\n`);
    git("add", "vault.yaml.tmp");
    git("commit", "-q", "-m", "oops");

    const stderr = await captureStderr(saveSecret);

    expect(existsSync(path.join(vaultDir, "vault.yaml.tmp"))).toBe(false);
    expect(stderr).toContain("history");
    expect(stderr).toContain("rotate");
    expect(stderr).not.toContain(SECRET);
  });
});
