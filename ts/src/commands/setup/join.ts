// Join an existing vault: clone repo, add this machine's key, re-encrypt.
// Ported from rust/src/commands/setup/join.rs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { input } from "@inquirer/prompts";
import * as vault from "../../lib/vault.ts";
import * as utils from "./utils.ts";

export async function run(publicKey: string, verbose: boolean): Promise<void> {
  const hasGh = utils.commandExists("gh");

  if (verbose) {
    utils.explain([
      "JOINING AN EXISTING VAULT",
      "",
      "You already have a vault set up on another machine. We need to:",
      "  1. Clone (or locate) your existing vault repository",
      "  2. Add this machine's public key to .sops.yaml",
      "  3. Re-encrypt the vault so this machine can decrypt it",
      "  4. Commit and push so other machines see the change",
      "",
      "After this, you can use all keypick commands from this machine.",
    ]);
  }

  const vaultDir = hasGh ? await joinWithGh(verbose) : await joinManual(verbose);

  const sopsPath = path.join(vaultDir, ".sops.yaml");
  if (!existsSync(sopsPath)) {
    throw new Error(`No .sops.yaml found in ${vaultDir}. Is this the right repo?`);
  }

  let content: string;
  try {
    content = readFileSync(sopsPath, "utf8");
  } catch (e) {
    throw new Error(`Failed to read .sops.yaml: ${(e as Error).message}`);
  }

  if (verbose) {
    utils.explain([
      "CHECKING RECIPIENTS",
      "",
      "The .sops.yaml file lists every public key that can decrypt",
      "the vault. Each key represents a machine (or GitHub Actions,",
      "or a recovery key). We'll check if this machine's key is",
      "already in the list.",
    ]);
  }

  console.log(`\n  ${chalk.dim("Current recipients:")}`);
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/,+$/, "");
    if (trimmed.startsWith("age1")) {
      console.log(`    ${chalk.dim("-")} ${chalk.cyan(utils.shortKey(trimmed, 30))}`);
    }
  }

  if (content.includes(publicKey)) {
    utils.done("This machine's key is already a recipient");
  } else {
    if (verbose) {
      utils.explain([
        "ADDING THIS MACHINE AS A RECIPIENT",
        "",
        "Your public key is not yet in .sops.yaml, so we'll add it.",
        "Then we run `sops updatekeys -y vault.yaml` which tells sops",
        "to re-encrypt the vault for ALL recipients (including this",
        "new machine). This requires that the current machine running",
        "the command can already decrypt the vault (which it can,",
        "because we're inside the cloned repo from the original machine).",
        "",
        "After re-encryption, we commit and push so other machines",
        "can pull the updated vault.",
      ]);
    }

    const sp = utils.spinner("Adding this machine's key to recipients...");
    try {
      const updated = utils.addRecipient(content, publicKey);
      writeFileSync(sopsPath, updated);
    } finally {
      sp.stop();
    }
    utils.done(`Added key ${chalk.cyan(utils.shortKey(publicKey, 20))}... to recipients`);

    const vaultYaml = path.join(vaultDir, "vault.yaml");
    if (existsSync(vaultYaml)) {
      const sp2 = utils.spinner("Re-encrypting vault for new recipient...");
      const res = spawnSync("sops", ["updatekeys", "-y", "vault.yaml"], {
        cwd: vaultDir,
        encoding: "utf8",
      });
      sp2.stop();
      if (res.error) throw new Error(`sops updatekeys failed: ${res.error.message}`);
      if (res.status !== 0) {
        throw new Error(`Failed to re-encrypt vault: ${res.stderr ?? ""}`);
      }
      utils.done("Vault re-encrypted");
    }

    utils.gitCommitAndPush(
      vaultDir,
      [".sops.yaml", "vault.yaml"],
      "feat: add new machine to vault recipients",
    );
  }

  console.log(`\n  ${chalk.dim("Vault directory:")} ${chalk.cyan.bold(vaultDir)}`);
  console.log(`  ${chalk.dim("KeyPick will remember this vault selection.")}`);
}

async function joinWithGh(verbose: boolean): Promise<string> {
  const vaultHome = vault.vaultsHomeDir();
  try {
    mkdirSync(vaultHome, { recursive: true });
  } catch (e) {
    throw new Error(`Failed to create ${vaultHome}: ${(e as Error).message}`);
  }

  if (verbose) {
    utils.explain([
      "The GitHub CLI (`gh`) is available, so you can clone your",
      "vault repo by providing the 'owner/repo' format.",
      "Example: myusername/my-keys",
    ]);
  }

  let repo: string;
  try {
    repo = await input({
      message: "GitHub repo to clone? (e.g. username/my-keys)",
    });
  } catch {
    throw new Error("Cancelled");
  }

  const segs = repo.split("/");
  const repoName = segs[segs.length - 1] || repo;

  const sp = utils.spinner("Cloning repository...");
  const result = spawnSync("gh", ["repo", "clone", repo], {
    cwd: vaultHome,
    encoding: "utf8",
  });
  sp.stop();

  if (result.error || result.status !== 0) {
    const err = result.error?.message ?? (result.stderr ?? "").trim();
    throw new Error(`Clone failed: ${err}`);
  }

  const dir = path.join(vaultHome, repoName);
  try {
    vault.rememberVaultDir(dir);
  } catch {
    // best-effort
  }
  utils.done(`Cloned ${repo}`);
  return dir;
}

async function joinManual(verbose: boolean): Promise<string> {
  const defaultDir = vault.vaultsHomeDir();

  if (verbose) {
    utils.explain([
      "Provide either:",
      "  • A git clone URL (e.g. git@github.com:user/my-keys.git)",
      "  • A local path to an already-cloned vault repo",
      "",
      `New clones are stored under: ${defaultDir}`,
    ]);
  }

  let inputValue: string;
  try {
    inputValue = await input({
      message: "Path to existing vault repo (or git clone URL)?",
    });
  } catch {
    throw new Error("Cancelled");
  }

  const isUrl = inputValue.includes("git@") || inputValue.includes("https://");
  if (isUrl) {
    const segs = inputValue.split("/");
    let repoName = segs[segs.length - 1] || "my-keys";
    if (repoName.endsWith(".git")) repoName = repoName.slice(0, -4);

    const vaultHome = vault.vaultsHomeDir();
    try {
      mkdirSync(vaultHome, { recursive: true });
    } catch (e) {
      throw new Error(`Failed to create ${vaultHome}: ${(e as Error).message}`);
    }

    const sp = utils.spinner("Cloning repository...");
    const res = spawnSync("git", ["clone", inputValue], {
      cwd: vaultHome,
      encoding: "utf8",
    });
    sp.stop();

    if (res.error) throw new Error(`git clone failed: ${res.error.message}`);
    if (res.status !== 0) throw new Error(`Clone failed: ${res.stderr ?? ""}`);

    const dir = path.join(vaultHome, repoName);
    try {
      vault.rememberVaultDir(dir);
    } catch {
      // best-effort
    }
    utils.done(`Cloned to ${dir}`);
    return dir;
  }

  if (!existsSync(inputValue)) {
    throw new Error(`Directory ${inputValue} does not exist`);
  }
  try {
    vault.rememberVaultDir(inputValue);
  } catch {
    // best-effort
  }
  return inputValue;
}
