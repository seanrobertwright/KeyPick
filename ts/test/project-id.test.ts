// Tests for the project id `keypick env` derives from a project's git remote
// or folder name, which becomes the folder envs/<id> in the vault.
//
// Requires `git` on PATH.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveProjectId } from "../src/commands/env/utils.ts";

const MAIN = path.resolve(import.meta.dir, "../src/main.ts");

let root: string;
let vaultDir: string;

function mustRun(cmd: string, args: string[], cwd: string): void {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.error) throw new Error(`Could not run \`${cmd}\` (is it on PATH?): ${result.error.message}`);
  if (result.status !== 0) throw new Error(`\`${cmd} ${args.join(" ")}\` exited ${result.status}:\n${result.stderr}`);
}

/** A new git repo under the temp root whose origin is `url`. */
function repoWithOrigin(name: string, url: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  mustRun("git", ["init", "-q"], dir);
  mustRun("git", ["remote", "add", "origin", url], dir);
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "keypick-project-id-test-"));

  // `env status` only checks that these exist; it never decrypts them.
  vaultDir = path.join(root, "vault");
  mkdirSync(vaultDir);
  writeFileSync(path.join(vaultDir, "vault.yaml"), "");
  writeFileSync(path.join(vaultDir, ".sops.yaml"), "");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("keypick env status", () => {
  test("refuses a remote that would make the project folder the vault root", () => {
    const project = repoWithOrigin("dotdot", "https://github.com/..");

    const result = spawnSync(process.execPath, [MAIN, "env", "status"], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, KEYPICK_VAULT_DIR: vaultDir, KEYPICK_HOME: path.join(root, "home") },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('git remote "origin"');
    expect(result.stderr).toContain('".."');
  });
});

// `env push` and `env pull` are interactive, so they're covered through the
// function all three commands call.
describe("deriveProjectId", () => {
  test("turns an ordinary remote into owner__repo", () => {
    const project = repoWithOrigin("ordinary", "https://github.com/owner/repo.git");

    expect(deriveProjectId(project)).toEqual({ id: "owner__repo", usedFallback: false });
  });

  test.each([
    ["dot", "git@github.com:.", '"."'],
    ["backslash", "https://github.com/owner\\..\\..\\escape", '"owner\\\\..\\\\..\\\\escape"'],
    ["control-character", "https://github.com/owner/re\tpo", '"owner__re\\tpo"'],
  ])("refuses the id from a %s remote, naming the remote", (name, url, quotedId) => {
    const project = repoWithOrigin(name, url);

    expect(() => deriveProjectId(project)).toThrow(`Project id ${quotedId}, from the URL of git remote "origin"`);
  });

  // Windows folder names can't contain control characters.
  test.skipIf(process.platform === "win32")("refuses a folder name with a control character, naming the folder", () => {
    const project = path.join(root, "bad\nname");
    mkdirSync(project);
    mustRun("git", ["init", "-q"], project);

    expect(() => deriveProjectId(project)).toThrow(`Project id "bad\\nname", from the name of folder ${JSON.stringify(project)}`);
  });
});
