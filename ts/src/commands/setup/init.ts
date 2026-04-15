// Create a brand-new vault repository and initial commit.
// Ported from rust/src/commands/setup/init.rs.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { confirm, input } from "@inquirer/prompts";
import * as vault from "../../lib/vault.ts";
import * as utils from "./utils.ts";

export async function run(publicKey: string, verbose: boolean): Promise<void> {
  const hasGh = utils.commandExists("gh");

  if (verbose) {
    utils.explain([
      "CREATING A NEW VAULT",
      "",
      "You'll choose a name for your vault repository. This becomes",
      "a Git repo containing your encrypted secrets. The default",
      "name is 'my-keys' but you can call it anything.",
      "",
      "By default, KeyPick stores vault repos in your per-user vault home:",
      `  ${vault.vaultsHomeDir()}`,
      "",
      "If the GitHub CLI (`gh`) is installed and authenticated, we",
      "can create a PRIVATE GitHub repo automatically. Otherwise,",
      "we'll create a local Git repo and you can add a remote later.",
    ]);
  }

  let repoName: string;
  try {
    repoName = await input({
      message: "Vault repo name?",
      default: "my-keys",
    });
  } catch {
    throw new Error("Cancelled");
  }

  const vaultDir = hasGh
    ? await initWithGh(repoName, verbose)
    : await initManual(repoName, verbose);

  // Create .sops.yaml
  if (verbose) {
    utils.explain([
      "CREATING .sops.yaml",
      "",
      "This file tells sops HOW to encrypt your vault:",
      "  • path_regex — which files to encrypt (vault.yaml)",
      "  • age — the list of public keys that can decrypt it",
      "",
      "Right now, only this machine's public key is listed.",
      "When you add more machines or set up GitHub Actions,",
      "their public keys get appended here too.",
      "",
      "This file is safe to commit — it contains only PUBLIC keys.",
    ]);
  }

  const sopsPath = path.join(vaultDir, ".sops.yaml");
  const sp1 = utils.spinner("Creating SOPS config...");
  const sopsContent = `creation_rules:\n  - path_regex: envs/.*\n    age: >-\n      ${publicKey}\n  - path_regex: vault\\.yaml$\n    age: >-\n      ${publicKey}\n`;
  try {
    writeFileSync(sopsPath, sopsContent);
  } catch (e) {
    sp1.stop();
    throw new Error(`Failed to write .sops.yaml: ${(e as Error).message}`);
  }
  sp1.stop();
  utils.done("Created .sops.yaml");

  // Create and encrypt vault.yaml
  if (verbose) {
    utils.explain([
      "CREATING vault.yaml",
      "",
      "This is your actual secrets file. It starts empty (just",
      "'services: {}') and gets encrypted in-place by sops.",
      "",
      "After encryption, the file will contain age-encrypted data",
      "that only holders of the private keys listed in .sops.yaml",
      "can decrypt. The command `sops -e -i vault.yaml` encrypts",
      "the file in-place.",
    ]);
  }

  const vaultPath = path.join(vaultDir, "vault.yaml");
  const sp2 = utils.spinner("Creating encrypted vault...");
  try {
    writeFileSync(vaultPath, "services: {}\n");
  } catch (e) {
    sp2.stop();
    throw new Error(`Failed to write vault.yaml: ${(e as Error).message}`);
  }

  const encRes = spawnSync("sops", ["-e", "-i", "vault.yaml"], {
    cwd: vaultDir,
    encoding: "utf8",
  });
  sp2.stop();
  if (encRes.error) throw new Error(`sops encrypt failed: ${encRes.error.message}`);
  if (encRes.status !== 0) {
    throw new Error(`SOPS encryption failed: ${encRes.stderr ?? ""}`);
  }
  utils.done("Created and encrypted vault.yaml");

  // Git add and commit
  if (verbose) {
    utils.explain([
      "COMMITTING TO GIT",
      "",
      "We commit both .sops.yaml and the encrypted vault.yaml",
      "to Git. This is your initial commit. From here on, every",
      "change to the vault (adding keys, adding machines) will",
      "be a new commit you can push/pull across machines.",
    ]);
  }
  const sp3 = utils.spinner("Committing...");
  try {
    utils.runGit(vaultDir, ["add", ".sops.yaml", "vault.yaml"]);
    utils.runGit(vaultDir, ["commit", "-m", "feat: initialize encrypted vault"]);
  } finally {
    sp3.stop();
  }
  utils.done("Initial commit created");

  // Try to push
  if (utils.hasRemote(vaultDir)) {
    if (verbose) {
      utils.explain([
        "PUSHING TO REMOTE",
        "",
        "Pushing the initial commit to GitHub so your vault",
        "is backed up and accessible from other machines.",
      ]);
    }
    const sp4 = utils.spinner("Pushing to remote...");
    try {
      try {
        utils.runGit(vaultDir, ["push", "-u", "origin", "main"]);
      } catch {
        try {
          utils.runGit(vaultDir, ["push", "-u", "origin", "master"]);
        } catch {
          // best-effort
        }
      }
    } finally {
      sp4.stop();
    }
    utils.done("Pushed to remote");
  } else {
    utils.warn("No remote configured. Push manually when ready.");
  }

  console.log(`\n  ${chalk.dim("Vault directory:")} ${chalk.cyan.bold(vaultDir)}`);
}

async function initWithGh(repoName: string, verbose: boolean): Promise<string> {
  const vaultHome = vault.vaultsHomeDir();
  try {
    mkdirSync(vaultHome, { recursive: true });
  } catch (e) {
    throw new Error(`Failed to create ${vaultHome}: ${(e as Error).message}`);
  }

  if (verbose) {
    utils.explain([
      "The GitHub CLI (`gh`) is available. We can create a private",
      "repo on GitHub and clone it locally in one step. This runs:",
      `  (from ${vaultHome}) gh repo create ${repoName} --private --clone`,
      "",
      "If you decline, we'll create a local-only Git repo instead.",
    ]);
  }

  let createRemote = true;
  try {
    createRemote = await confirm({
      message: "Create a private GitHub repo automatically?",
      default: true,
    });
  } catch {
    throw new Error("Cancelled");
  }

  if (!createRemote) return initManual(repoName, verbose);

  const sp = utils.spinner("Creating private GitHub repo...");
  const result = spawnSync("gh", ["repo", "create", repoName, "--private", "--clone"], {
    cwd: vaultHome,
    encoding: "utf8",
  });
  sp.stop();

  if (result.error || result.status !== 0) {
    const err = result.error?.message ?? (result.stderr ?? "").trim();
    utils.warn(`gh repo create failed: ${err}`);
    utils.warn("Falling back to manual setup...");
    return initManual(repoName, verbose);
  }

  const dir = path.join(vaultHome, repoName);
  try {
    vault.rememberVaultDir(dir);
  } catch {
    // best-effort
  }
  utils.done(`Created and cloned ${repoName}`);
  return dir;
}

async function initManual(repoName: string, verbose: boolean): Promise<string> {
  const defaultDir = vault.defaultVaultDir(repoName);

  if (verbose) {
    utils.explain([
      "MANUAL REPO SETUP",
      "",
      "We'll create a local Git repository. You can add a remote",
      "later by creating a private repo on GitHub (or any Git host)",
      "and running `git remote add origin <url>`.",
    ]);
  }

  let dir: string;
  try {
    dir = await input({
      message: "Local directory for the vault repo?",
      default: defaultDir,
    });
  } catch {
    throw new Error("Cancelled");
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(`Failed to create directory: ${(e as Error).message}`);
  }

  const gitDir = path.join(dir, ".git");
  if (!existsSync(gitDir)) {
    const sp = utils.spinner("Initializing git repository...");
    try {
      utils.runGit(dir, ["init"]);
    } finally {
      sp.stop();
    }
    utils.done("Git repository initialized");
  }

  console.log(`\n  ${chalk.yellow.bold("Next:")} ${chalk.dim("Create a PRIVATE repo on GitHub and run:")}`);
  console.log(`    ${chalk.cyan(`git remote add origin git@github.com:YOU/${repoName}.git`)}`);
  console.log();

  try {
    vault.rememberVaultDir(dir);
  } catch {
    // best-effort
  }
  return dir;
}
