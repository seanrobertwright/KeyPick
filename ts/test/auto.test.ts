// Integration tests for `keypick auto` against a real sops/age vault.
//
// Each run creates a throwaway age key and vault in a temp dir, points
// SOPS_AGE_KEY_FILE and KEYPICK_VAULT_DIR at them, runs the CLI, and evaluates
// its stdout through bash the way users and agents do.
//
// Requires `sops`, `age-keygen`, and `bash` on PATH.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MAIN = path.resolve(import.meta.dir, "../src/main.ts");

const GOOD_VALUE = "good-value";
// Repeated spaces, a glob, shell expansions, and a single quote.
const TRICKY_VALUE = "two  spaces   * star $HOME ${PATH} $(id) it's";
// The issue's repro: a key name that runs `touch` when its export line is eval'd.
const MARKER = "keypick-marker";
const EVIL_KEY = `X=1;touch ${MARKER};Y`;
const EVIL_VALUE = "evil-value";

let root: string;
let vaultDir: string;
let env: NodeJS.ProcessEnv;

type RunResult = { stdout: string; stderr: string; status: number | null };

/** Run a command with stdout piped (not a TTY). Throws only if it can't start. */
function run(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): RunResult {
  const result = spawnSync(cmd, args, { ...options, encoding: "utf8" });
  if (result.error) {
    throw new Error(`Could not run \`${cmd}\` (is it on PATH?): ${result.error.message}`);
  }
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function mustRun(cmd: string, args: string[], cwd?: string): string {
  const result = run(cmd, args, { cwd });
  if (result.status !== 0) {
    throw new Error(`\`${cmd} ${args.join(" ")}\` exited ${result.status}:\n${result.stderr}`);
  }
  return result.stdout;
}

/** Run this checkout's CLI directly. */
function keypick(...args: string[]): RunResult {
  return run(process.execPath, [MAIN, ...args], { env });
}

/** Run a bash script in which `keypick` invokes this checkout's CLI. */
function bash(script: string, cwd?: string): RunResult {
  const prelude = 'keypick() { "$KEYPICK_TEST_BUN" "$KEYPICK_TEST_MAIN" "$@"; }\n';
  return run("bash", ["-c", prelude + script], {
    cwd,
    env: { ...env, KEYPICK_TEST_BUN: process.execPath, KEYPICK_TEST_MAIN: MAIN },
  });
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "keypick-auto-test-"));

  const keyFile = path.join(root, "keys.txt");
  mustRun("age-keygen", ["-o", keyFile]);
  const publicKey = /^# public key: (\S+)$/m.exec(readFileSync(keyFile, "utf8"))?.[1];
  if (!publicKey) throw new Error(`age-keygen wrote no public key to ${keyFile}`);

  vaultDir = path.join(root, "vault");
  mkdirSync(vaultDir);
  writeFileSync(
    path.join(vaultDir, ".sops.yaml"),
    `creation_rules:\n  - path_regex: vault\\.yaml$\n    age: ${publicKey}\n`,
  );

  // JSON is valid YAML, so the fixture doesn't depend on the YAML library under test.
  const plaintext = path.join(root, "plaintext.yaml");
  writeFileSync(
    plaintext,
    JSON.stringify({
      services: {
        Test: { GOOD_KEY: GOOD_VALUE },
        Tricky: { TRICKY_KEY: TRICKY_VALUE },
        Evil: { [EVIL_KEY]: EVIL_VALUE },
        // What YAML gives a group whose last key was deleted by hand.
        Empty: null,
      },
    }),
  );
  mustRun(
    "sops",
    [
      "--encrypt",
      "--input-type", "yaml",
      "--output-type", "yaml",
      "--filename-override", "vault.yaml",
      "--output", path.join(vaultDir, "vault.yaml"),
      plaintext,
    ],
    vaultDir,
  );
  rmSync(plaintext);

  env = {
    ...process.env,
    SOPS_AGE_KEY_FILE: keyFile,
    KEYPICK_VAULT_DIR: vaultDir,
    // Keep the remembered-vault file out of the real ~/.keypick.
    KEYPICK_HOME: path.join(root, "home"),
  };
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("keypick auto", () => {
  test('eval "$(keypick auto Test)" sets the group\'s keys without shell errors', () => {
    const result = bash('eval "$(keypick auto Test)"; echo "GOOD_KEY=${GOOD_KEY:+set}"');

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("GOOD_KEY=set\n");
  });

  test("eval $(keypick auto Test) sets the group's keys without shell errors", () => {
    const result = bash('eval $(keypick auto Test); echo "GOOD_KEY=${GOOD_KEY:+set}"');

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("GOOD_KEY=set\n");
  });

  test('eval "$(keypick auto Tricky)" reproduces the value exactly', () => {
    const result = bash(`eval "$(keypick auto Tricky)"; printf '%s' "$TRICKY_KEY"`);

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(TRICKY_VALUE);
  });

  test("stdout carries only export lines; warnings go to stderr without values", () => {
    const result = keypick("auto", "Test", "Missing", "Tricky");

    expect(result.status).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      "export GOOD_KEY='good-value'",
      "export TRICKY_KEY='two  spaces   * star $HOME ${PATH} $(id) it'\\''s'",
      "",
    ]);
    expect(result.stderr).toContain("Warning: group 'Missing' not found in vault.");
    expect(result.stderr).not.toContain(GOOD_VALUE);
    expect(result.stderr).not.toContain(TRICKY_VALUE);
  });

  test.each(["constructor", "__proto__", "toString"])(
    "reports %s as not found instead of reading a built-in object",
    (group) => {
      const result = keypick("auto", group);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`Warning: group '${group}' not found in vault.`);
    },
  );

  test("reports a group stored as null as not found and exports the others", () => {
    const result = keypick("auto", "Empty", "Test");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("export GOOD_KEY='good-value'\n");
    expect(result.stderr).toContain("Warning: group 'Empty' not found in vault.");
  });

  test("with no groups, prints usage to stderr and nothing to stdout", () => {
    const result = keypick("auto");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: keypick auto <Group1> [Group2 ...]");
  });
});

describe("keypick auto with a key name that isn't a shell variable name", () => {
  test("the issue's repro runs no command", () => {
    const result = bash(`eval "$(keypick auto Evil | grep '^export')"`, root);

    expect(result.status).toBe(0);
    expect(existsSync(path.join(root, MARKER))).toBe(false);
  });

  test("exits 1 with empty stdout, naming the key on stderr without its value", () => {
    const result = keypick("auto", "Evil");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"X=1;touch keypick-marker;Y"');
    expect(result.stderr).toContain("editing it with sops");
    expect(result.stderr).not.toContain(EVIL_VALUE);
  });

  test("exports nothing, not even the valid groups requested alongside it", () => {
    const result = keypick("auto", "Test", "Evil");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(GOOD_VALUE);
    expect(result.stderr).not.toContain(EVIL_VALUE);
  });
});

describe("banner", () => {
  test("keypick --version prints only the version", () => {
    const result = keypick("--version");

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  test("keypick --help starts with the usage line", () => {
    const result = keypick("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toStartWith("Usage: keypick ");
  });
});

describe("vault picker", () => {
  test("keypick auto writes only export lines to stdout when it asks which vault to use", () => {
    // No KEYPICK_VAULT_DIR, no remembered vault, no vault above cwd, and two
    // vaults under the vault home, so auto has to ask.
    const home = path.join(root, "picker-home");
    for (const name of ["first", "second"]) {
      cpSync(vaultDir, path.join(home, "vaults", name), { recursive: true });
    }
    const pickerEnv: NodeJS.ProcessEnv = { ...env, KEYPICK_HOME: home };
    delete pickerEnv.KEYPICK_VAULT_DIR;

    // Enter picks the first vault.
    const result = run(process.execPath, [MAIN, "auto", "Test"], { cwd: root, env: pickerEnv, input: "\r" });

    expect(result.stderr).toContain("Select a KeyPick vault");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("export GOOD_KEY='good-value'\n");
  });
});
