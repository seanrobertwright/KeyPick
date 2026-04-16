// Set up GitHub Actions auto re-encryption workflow.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { ensureDir } from "../../lib/fs.ts";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import * as vault from "../../lib/vault.ts";
import * as utils from "./utils.ts";

// NOTE: The authoritative copy of this file lives at
// `.github/workflows/vault-sync.yml` in the repo root. `ts/src/assets/` holds
// a committed copy so it can be bundled with `bun install -g`. Keep them
// in sync when the workflow changes.
const WORKFLOW_ASSET_PATH = path.join(
  path.dirname(import.meta.url.replace(/^file:\/\/\/?/, "")),
  "..",
  "..",
  "assets",
  "vault-sync.yml",
);

function loadWorkflow(): string {
  // Resolve asset path once at startup; fall back to walking up from the
  // module location in case the package layout differs.
  const candidates = [
    WORKFLOW_ASSET_PATH,
    path.resolve(process.cwd(), "ts/src/assets/vault-sync.yml"),
    path.resolve(process.cwd(), "src/assets/vault-sync.yml"),
    path.resolve(process.cwd(), ".github/workflows/vault-sync.yml"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, "utf8");
    } catch {
      // keep looking
    }
  }
  throw new Error(
    "Could not locate vault-sync.yml workflow asset. Reinstall KeyPick.",
  );
}

export async function run(verbose: boolean): Promise<void> {
  try {
    await runInner(verbose);
  } catch (e) {
    console.error(chalk.red.bold("GitHub Actions setup failed:"), (e as Error).message);
  }
}

async function runInner(verbose: boolean): Promise<void> {
  const vaultDir = await vault.vaultDir();

  if (verbose) {
    utils.explain([
      "GITHUB ACTIONS AUTO-SYNC",
      "",
      "This sets up a CI workflow that solves a key problem:",
      "when you add a new machine, you update .sops.yaml with its",
      "public key. But the vault.yaml is still encrypted for the",
      "OLD set of recipients — the new machine can't decrypt it yet.",
      "",
      "The workflow watches for changes to .sops.yaml. When it",
      "detects a change, it runs `sops updatekeys` to re-encrypt",
      "the vault for ALL current recipients, then commits and pushes.",
      "",
      "This requires:",
      "  • The `gh` CLI (to set a GitHub Actions secret)",
      "  • A separate age keypair just for GitHub Actions",
    ]);
  }

  if (!utils.commandExists("gh")) {
    throw new Error(
      "The `gh` CLI is required for GitHub Actions setup.\n  Install it from: https://cli.github.com",
    );
  }

  let remoteUrl: string;
  try {
    remoteUrl = utils.runGit(vaultDir, ["remote", "get-url", "origin"]);
  } catch {
    throw new Error("Selected vault is not in a git repo with an 'origin' remote.");
  }

  console.log(`  ${chalk.dim("Repo:")} ${chalk.cyan(remoteUrl.trim())}`);

  // Step 1: Generate Actions age keypair
  if (verbose) {
    utils.explain([
      "STEP 1: Generate a dedicated age keypair for GitHub Actions.",
      "",
      "This key is separate from your machine keys. Its private key",
      "will be stored as a GitHub Actions secret (SOPS_AGE_KEY).",
      "Its public key will be added to .sops.yaml so the workflow",
      "can decrypt and re-encrypt the vault.",
    ]);
  }
  const sp1 = utils.spinner("Generating GitHub Actions age key...");
  const tmpDir = mkdtempSync(path.join(tmpdir(), "keypick-actions-"));
  const keyPath = path.join(tmpDir, "actions_key.txt");

  const keygenRes = spawnSync("age-keygen", ["-o", keyPath], { encoding: "utf8" });
  sp1.stop();
  if (keygenRes.error) throw new Error(`age-keygen failed: ${keygenRes.error.message}`);
  if (keygenRes.status !== 0) {
    throw new Error(`age-keygen failed: ${keygenRes.stderr ?? ""}`);
  }

  const keyContent = readFileSync(keyPath, "utf8");
  const pubkey = utils.readPublicKey(keyPath);
  utils.done(`Generated Actions key: ${chalk.cyan(utils.shortKey(pubkey, 24))}...`);

  // Step 2: Add pubkey to .sops.yaml
  if (verbose) {
    utils.explain([
      "STEP 2: Add the Actions public key to .sops.yaml.",
      "",
      "This registers GitHub Actions as a vault recipient,",
      "giving the workflow permission to decrypt the vault",
      "during re-encryption runs.",
    ]);
  }

  const sopsPath = path.join(vaultDir, ".sops.yaml");
  const sp2 = utils.spinner("Adding Actions key to .sops.yaml...");
  let sopsContent: string;
  try {
    sopsContent = readFileSync(sopsPath, "utf8");
  } catch (e) {
    sp2.stop();
    throw new Error(`Failed to read .sops.yaml: ${(e as Error).message}`);
  }

  if (sopsContent.includes(pubkey)) {
    sp2.stop();
    utils.skip("Actions key already in .sops.yaml");
  } else {
    try {
      const updated = utils.addRecipient(sopsContent, pubkey);
      writeFileSync(sopsPath, updated);
    } finally {
      sp2.stop();
    }
    utils.done("Added Actions key to .sops.yaml");
  }

  // Step 3: Set GitHub secret
  if (verbose) {
    utils.explain([
      "STEP 3: Store the Actions PRIVATE key as a GitHub secret.",
      "",
      "The private key is piped to `gh secret set SOPS_AGE_KEY`.",
      "GitHub encrypts it with libsodium and stores it securely.",
      "It's only available to workflows running in your repo —",
      "it never appears in logs or the GitHub UI after being set.",
    ]);
  }
  const sp3 = utils.spinner("Setting SOPS_AGE_KEY secret on GitHub...");
  const secretRes = spawnSync("gh", ["secret", "set", "SOPS_AGE_KEY"], {
    cwd: vaultDir,
    input: keyContent,
    encoding: "utf8",
  });
  sp3.stop();

  if (secretRes.error) throw new Error(`Failed to run gh: ${secretRes.error.message}`);
  if (secretRes.status !== 0) {
    throw new Error("Failed to set GitHub secret. Check `gh auth status`.");
  }
  utils.done("Set SOPS_AGE_KEY secret on GitHub");

  // Step 4: Install workflow file
  if (verbose) {
    utils.explain([
      "STEP 4: Install the GitHub Actions workflow file.",
      "",
      "This creates .github/workflows/vault-sync.yml in your repo.",
      "The workflow triggers on pushes that change .sops.yaml or",
      "vault.yaml. It downloads age + sops, imports the secret key,",
      "runs `sops updatekeys -y vault.yaml`, and auto-commits the",
      "re-encrypted vault.",
    ]);
  }
  const sp4 = utils.spinner("Installing workflow file...");
  try {
    const workflow = loadWorkflow();
    ensureDir(path.join(vaultDir, ".github", "workflows"));
    writeFileSync(
      path.join(vaultDir, ".github", "workflows", "vault-sync.yml"),
      workflow,
    );
  } finally {
    sp4.stop();
  }
  utils.done("Installed .github/workflows/vault-sync.yml");

  // Step 5: Commit and push
  if (verbose) {
    utils.explain([
      "STEP 5: Commit and push the workflow + updated .sops.yaml.",
      "",
      "This makes the workflow active on GitHub. The next time",
      ".sops.yaml or vault.yaml is pushed, the workflow will run",
      "and re-encrypt the vault for all recipients.",
    ]);
  }
  utils.gitCommitAndPush(
    vaultDir,
    [".github", ".sops.yaml"],
    "feat: add GitHub Actions auto re-encryption",
  );

  console.log(
    `\n  ${chalk.green.bold("Done!")} ${chalk.dim(
      "The workflow will auto re-encrypt vault.yaml when .sops.yaml changes.",
    )}`,
  );
}
