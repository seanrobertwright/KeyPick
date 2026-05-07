// Join an existing vault: clone repo, add this machine's key, re-encrypt.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureDir } from "../../lib/fs.ts";
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

  // Compute the proposed file content first so we can tell whether anything
  // would change. `addRecipient` adds the key to every `age:` block where it's
  // missing; if the result equals the original, the key is already present in
  // every rule and there is nothing to do. (The previous content-wide
  // `content.includes(publicKey)` short-circuit was buggy: a machine listed
  // only in the `vault.yaml$` rule but missing from the `envs/.*` rule would
  // be wrongly reported as fully registered.)
  const proposed = utils.addRecipient(content, publicKey);

  if (proposed === content) {
    utils.done("This machine's key is already a recipient in every rule");
  } else {
    // Decide path BEFORE mutating .sops.yaml. `sops updatekeys` needs to first
    // decrypt the data key with one of the EXISTING recipients' private keys;
    // a fresh joiner doesn't have any of those, so we must defer rewrap to a
    // machine (or CI) that already holds a recipient identity.
    const canRewrapLocally = utils.canDecryptVault(vaultDir);

    if (verbose) {
      if (canRewrapLocally) {
        utils.explain([
          "ADDING THIS MACHINE AS A RECIPIENT (local re-encryption)",
          "",
          "Your public key is not yet in .sops.yaml, so we'll add it.",
          "This machine already holds an identity that can decrypt the",
          "vault, so we can run `sops updatekeys -y vault.yaml` here to",
          "re-encrypt for the new recipient set, then commit and push.",
        ]);
      } else {
        utils.explain([
          "ADDING THIS MACHINE AS A RECIPIENT (deferred re-encryption)",
          "",
          "Your public key is not yet in .sops.yaml, so we'll add it,",
          "commit, and push. This machine cannot decrypt the vault yet —",
          "and that's expected: cloning the repo gives you ciphertext,",
          "not the original machine's age private key.",
          "",
          "Re-encryption (`sops updatekeys`) needs a current recipient's",
          "identity. After we push, that step happens elsewhere:",
          "  • If GitHub Actions auto-sync is installed, the workflow",
          "    re-encrypts on push and commits the result.",
          "  • Otherwise, run it on a machine that already has access.",
          "",
          "Once re-encrypted on the remote, run `git pull` here.",
        ]);
      }
    }

    const sp = utils.spinner("Adding this machine's key to recipients...");
    try {
      writeFileSync(sopsPath, proposed);
    } finally {
      sp.stop();
    }
    utils.done(`Added key ${chalk.cyan(utils.shortKey(publicKey, 20))}... to recipients`);

    try {
      if (canRewrapLocally) {
        const filesToCommit = [".sops.yaml"];
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
          filesToCommit.push("vault.yaml");
        }
        utils.gitCommitAndPush(
          vaultDir,
          filesToCommit,
          "feat: add new machine to vault recipients",
        );
      } else {
        utils.gitCommitAndPush(
          vaultDir,
          [".sops.yaml"],
          "feat: register new machine for vault re-encryption",
        );

        if (utils.hasAutoSyncWorkflow(vaultDir)) {
          utils.explain([
            "GITHUB ACTIONS WILL RE-ENCRYPT THE VAULT",
            "",
            "Detected `.github/workflows/vault-sync.yml` in the repo.",
            "The workflow will re-encrypt vault.yaml for the updated",
            "recipient set and push the rewrap back automatically.",
            "",
            "Wait ~30-60 seconds, then run:",
            "  git pull",
            "from the vault directory. After that, `keypick list`",
            "should work on this machine.",
          ]);
        } else {
          utils.explain([
            "ACTION REQUIRED ON ANOTHER MACHINE",
            "",
            "This machine cannot decrypt the vault yet because none of",
            "the existing recipients matches a key on this machine — and",
            "that's normal for a brand-new machine. The push above only",
            "registered this machine as a recipient.",
            "",
            "From a machine that already has access, run:",
            "  cd <vault-dir>",
            "  git pull",
            "  sops updatekeys -y vault.yaml",
            "  git add vault.yaml",
            '  git commit -m "sync: re-encrypt for new recipient"',
            "  git push",
            "",
            "Then on THIS machine, run `git pull`. To automate this",
            "in CI going forward, run `keypick setup actions` on the",
            "machine that already has access.",
          ]);
        }
      }
    } catch (e) {
      // Roll back the .sops.yaml mutation so a retry isn't short-circuited
      // by line ~62's `content.includes(publicKey)` check leaving the file
      // dirty forever.
      try {
        writeFileSync(sopsPath, content);
      } catch {
        // best-effort
      }
      throw e;
    }
  }

  console.log(`\n  ${chalk.dim("Vault directory:")} ${chalk.cyan.bold(vaultDir)}`);
  console.log(`  ${chalk.dim("KeyPick will remember this vault selection.")}`);
}

async function joinWithGh(verbose: boolean): Promise<string> {
  const vaultHome = vault.vaultsHomeDir();
  try {
    ensureDir(vaultHome);
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
      ensureDir(vaultHome);
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
