// Ensure an age keypair exists; generate if missing. Returns the public key.
// Ported from rust/src/commands/setup/keygen.rs.

import { existsSync, mkdirSync, renameSync } from "node:fs";
import chalk from "chalk";
import { confirm } from "@inquirer/prompts";
import * as utils from "./utils.ts";

export async function run(verbose: boolean): Promise<string> {
  const keyPath = utils.ageKeyPath();

  if (existsSync(keyPath)) {
    const pubkey = utils.readPublicKey(keyPath);
    utils.done(`Age key already exists: ${chalk.cyan(pubkey)}`);

    if (verbose) {
      utils.explain([
        "An age key was found on this machine. This means you've",
        "either run KeyPick setup before, or another tool generated",
        "an age key. You can reuse it (recommended) or generate a",
        "fresh one (the old key will be backed up with a .bak extension).",
      ]);
    }

    let useExisting = true;
    try {
      useExisting = await confirm({ message: "Use this existing key?", default: true });
    } catch {
      throw new Error("Cancelled");
    }
    if (useExisting) return pubkey;

    const backup = `${keyPath}.bak`;
    try {
      renameSync(keyPath, backup);
    } catch (e) {
      throw new Error(`Failed to back up existing key: ${(e as Error).message}`);
    }
    utils.warn(`Old key backed up to ${backup}`);
  }

  if (verbose) {
    utils.explain([
      "Generating a new age keypair using `age-keygen`.",
      "",
      "This creates two things:",
      "  • A private key (AGE-SECRET-KEY-...) — stays on this machine only",
      "  • A public key (age1...) — will be added to your vault's .sops.yaml",
      "",
      `The keypair is saved to: ${keyPath}`,
      "",
      "IMPORTANT: Never share or commit your private key. If this machine",
      "is lost or compromised, remove its public key from .sops.yaml to",
      "revoke access.",
    ]);
  }

  const sp = utils.spinner("Generating age keypair...");
  try {
    const keyDir = utils.ageKeyDir();
    try {
      mkdirSync(keyDir, { recursive: true });
    } catch (e) {
      throw new Error(`Failed to create ${keyDir}: ${(e as Error).message}`);
    }

    try {
      utils.runCmd("age-keygen", ["-o", keyPath]);
    } catch (e) {
      throw new Error(`age-keygen failed: ${(e as Error).message}`);
    }
  } finally {
    sp.stop();
  }

  const pubkey = utils.readPublicKey(keyPath);
  utils.done(`Key generated: ${chalk.cyan(pubkey)}`);
  console.log(`  ${chalk.dim("Saved to:")} ${chalk.dim(keyPath)}`);

  return pubkey;
}
