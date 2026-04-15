// Generate a passphrase-protected recovery key for emergency vault access.
// Ported from rust/src/commands/setup/recovery.rs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { password } from "@inquirer/prompts";
import * as vault from "../../lib/vault.ts";
import * as utils from "./utils.ts";

export async function run(verbose: boolean): Promise<void> {
  try {
    await runInner(verbose);
  } catch (e) {
    console.error(chalk.red.bold("Recovery key setup failed:"), (e as Error).message);
  }
}

async function runInner(verbose: boolean): Promise<void> {
  const vaultDir = await vault.vaultDir();

  console.log(
    `\n  ${chalk.dim("A recovery key lets you regain access if you lose all your machines.")}`,
  );
  console.log(`  ${chalk.dim("You'll set a passphrase to protect it.")}\n`);

  if (verbose) {
    utils.explain([
      "RECOVERY KEY OVERVIEW",
      "",
      "A recovery key is a safety net. It's an age keypair that:",
      "  • Gets added to .sops.yaml as a vault recipient",
      "  • Is encrypted with a passphrase YOU choose",
      "  • Is saved as 'recovery_key.age' for offline storage",
      "",
      "To recover, you need BOTH the encrypted file AND the passphrase.",
      "This is deliberate — storing them separately means a single",
      "breach (someone finds the file, or someone learns the passphrase)",
      "isn't enough to access your secrets.",
      "",
      "The process:",
      "  1. Generate a fresh age keypair (not tied to any machine)",
      "  2. You choose a strong passphrase",
      "  3. We encrypt the private key with your passphrase",
      "  4. The public key is added to .sops.yaml as a recipient",
      "  5. The vault is re-encrypted to include the recovery key",
    ]);
  }

  // Step 1: Generate keypair (in-memory: stdout has private, stderr has public)
  if (verbose) {
    utils.explain([
      "STEP 1: Generate a recovery age keypair.",
      "",
      "This is an independent keypair, separate from your machine",
      "key. It's generated in memory — the private key will be",
      "encrypted with your passphrase before touching disk.",
    ]);
  }
  const sp1 = utils.spinner("Generating recovery keypair...");
  const keygenRes = spawnSync("age-keygen", [], { encoding: "utf8" });
  sp1.stop();
  if (keygenRes.error) throw new Error(`age-keygen failed: ${keygenRes.error.message}`);
  if (keygenRes.status !== 0) throw new Error("age-keygen failed");

  const keyMaterial = keygenRes.stdout ?? "";
  const stderrText = keygenRes.stderr ?? "";

  let pubkey: string | null = null;
  for (const line of stderrText.split(/\r?\n/)) {
    const prefix = "Public key: ";
    if (line.startsWith(prefix)) {
      pubkey = line.slice(prefix.length).trim();
      break;
    }
  }
  if (!pubkey) throw new Error("Could not extract public key from age-keygen output");

  utils.done(`Generated recovery key: ${chalk.cyan(utils.shortKey(pubkey, 24))}...`);

  // Step 2: passphrase
  if (verbose) {
    utils.explain([
      "STEP 2: Choose a passphrase to protect the recovery key.",
      "",
      "This passphrase encrypts the recovery private key. Use",
      "something strong and memorable — you'll need it if you",
      "ever have to recover. Write it on paper and store it",
      "physically (not digitally) in a secure location.",
    ]);
  }

  let passphrase: string;
  try {
    passphrase = await password({
      message: "Enter a strong passphrase for the recovery key:",
      mask: "*",
    });
  } catch {
    throw new Error("Cancelled");
  }

  let confirmValue: string;
  try {
    confirmValue = await password({ message: "Confirm passphrase:", mask: "*" });
  } catch {
    throw new Error("Cancelled");
  }

  if (passphrase !== confirmValue) {
    throw new Error("Passphrases don't match");
  }

  // Step 3: Encrypt with age -e -p, using AGE_PASSPHRASE env var
  if (verbose) {
    utils.explain([
      "STEP 3: Encrypt the recovery private key with your passphrase.",
      "",
      "We run `age -e -p` which uses scrypt key derivation to turn",
      "your passphrase into an encryption key, then encrypts the",
      "recovery private key. The output is saved as recovery_key.age.",
    ]);
  }
  const sp3 = utils.spinner("Encrypting recovery key with passphrase...");
  const encRes = spawnSync("age", ["-e", "-p"], {
    env: { ...process.env, AGE_PASSPHRASE: passphrase },
    input: keyMaterial,
    encoding: "buffer",
  });
  sp3.stop();

  if (encRes.error) throw new Error(`Failed to run age: ${encRes.error.message}`);

  if (encRes.status === 0 && encRes.stdout && encRes.stdout.length > 0) {
    try {
      writeFileSync(path.join(vaultDir, "recovery_key.age"), encRes.stdout);
    } catch (e) {
      throw new Error(`Failed to write recovery_key.age: ${(e as Error).message}`);
    }
  } else {
    // Fallback — AGE_PASSPHRASE not supported in this age build. Run
    // interactively. inherits stdio so the user can type the passphrase.
    utils.warn("Automatic passphrase entry not supported. Running interactively...");
    console.log(`  ${chalk.dim("Enter your passphrase when prompted by age:")}`);

    const interactiveRes = spawnSync("age", ["-e", "-p", "-o", "recovery_key.age"], {
      cwd: vaultDir,
      input: keyMaterial,
      stdio: ["pipe", "inherit", "inherit"],
    });
    if (interactiveRes.error) throw new Error(`age failed: ${interactiveRes.error.message}`);
    if (interactiveRes.status !== 0) throw new Error("Failed to encrypt recovery key");
  }

  utils.done("Encrypted recovery key saved to recovery_key.age");

  // Step 4: Register recovery pubkey
  if (verbose) {
    utils.explain([
      "STEP 4: Register the recovery key as a vault recipient.",
      "",
      "We add the recovery public key to .sops.yaml and re-encrypt",
      "the vault. This means the recovery key can now decrypt the",
      "vault — but only after YOU decrypt the recovery key itself",
      "with your passphrase.",
    ]);
  }
  const sopsPath = path.join(vaultDir, ".sops.yaml");
  const vaultPath = path.join(vaultDir, "vault.yaml");

  if (existsSync(sopsPath)) {
    const sp4 = utils.spinner("Adding recovery key to .sops.yaml...");
    let content: string;
    try {
      content = readFileSync(sopsPath, "utf8");
    } catch (e) {
      sp4.stop();
      throw new Error(`Failed to read .sops.yaml: ${(e as Error).message}`);
    }
    if (!content.includes(pubkey)) {
      try {
        const updated = utils.addRecipient(content, pubkey);
        writeFileSync(sopsPath, updated);
      } catch (e) {
        sp4.stop();
        throw new Error(`Failed to write .sops.yaml: ${(e as Error).message}`);
      }
    }
    sp4.stop();
    utils.done("Added recovery key to .sops.yaml recipients");

    if (existsSync(vaultPath)) {
      const sp5 = utils.spinner("Re-encrypting vault...");
      spawnSync("sops", ["updatekeys", "-y", "vault.yaml"], { cwd: vaultDir });
      sp5.stop();
      utils.done("Vault re-encrypted with recovery key");
    }

    utils.gitCommitAndPush(
      vaultDir,
      [".sops.yaml", "vault.yaml"],
      "feat: add recovery key to vault recipients",
    );
  }

  // Step 5: storage instructions
  console.log(`\n  ${chalk.yellow.bold("-- Recovery Key Storage --")}`);
  console.log(
    `  ${chalk.cyan.bold("1.")} Upload ${chalk.cyan("recovery_key.age")} to cloud storage (e.g. Google Drive)`,
  );
  console.log(
    `  ${chalk.cyan.bold("2.")} Write the passphrase on paper, store in a safe/lockbox`,
  );
  console.log(
    `  ${chalk.yellow.bold("WARNING:")} ${chalk.yellow("Store the FILE and PASSPHRASE in SEPARATE physical locations!")}`,
  );
  console.log(`  ${chalk.cyan.bold("3.")} Delete recovery_key.age from this machine after uploading\n`);

  if (verbose) {
    utils.explain([
      "WHY SEPARATE LOCATIONS?",
      "",
      "Two-factor recovery: the encrypted file is useless without",
      "the passphrase, and the passphrase is useless without the",
      "file. An attacker would need to compromise BOTH locations.",
      "",
      "Good storage examples:",
      "  • File: Google Drive, iCloud, Dropbox, USB stick in a drawer",
      "  • Passphrase: Paper in a safe, bank safety deposit box",
      "",
      "TO USE THE RECOVERY KEY LATER:",
      "  1. Download recovery_key.age",
      "  2. Run: age -d recovery_key.age > temp_key.txt",
      "  3. Enter your passphrase when prompted",
      "  4. Run: SOPS_AGE_KEY_FILE=temp_key.txt keypick list",
      "  5. Delete temp_key.txt immediately after use",
    ]);
  }
}
