// `keypick setup` — full wizard + subcommands.
// Ported from rust/src/commands/setup/mod.rs.

import chalk from "chalk";
import { confirm, select } from "@inquirer/prompts";
import * as utils from "./utils.ts";
import * as prerequisites from "./prerequisites.ts";
import * as keygen from "./keygen.ts";
import * as init from "./init.ts";
import * as join from "./join.ts";
import * as actions from "./actions.ts";
import * as recovery from "./recovery.ts";
import * as terminal from "../../lib/terminal.ts";

export type SetupSubcommand = "actions" | "recovery";

export async function run(
  sub: SetupSubcommand | undefined,
  walkthrough: boolean,
): Promise<void> {
  switch (sub) {
    case "actions":
      return actions.run(walkthrough);
    case "recovery":
      return recovery.run(walkthrough);
    case undefined:
      return runFullWizard(walkthrough);
  }
}

async function runFullWizard(walkthrough: boolean): Promise<void> {
  console.log(`\n${chalk.cyan.bold("  -- KeyPick Setup Wizard --")}`);
  console.log(
    `  ${chalk.dim("This will get KeyPick fully configured on this machine.")}\n`,
  );

  if (walkthrough) {
    utils.explain([
      "WALKTHROUGH MODE ENABLED",
      "",
      "This setup wizard configures KeyPick in 4 phases:",
      "  1. Prerequisites  — install age (encryption) and sops (secret management)",
      "  2. Machine identity — generate a unique age keypair for this machine",
      "  3. Vault repository — create or join a Git repo that stores your encrypted secrets",
      "  4. Optional extras — GitHub Actions auto-sync and a recovery key",
      "",
      "Each step will be explained before it runs so you understand",
      "exactly what is happening and why.",
    ]);
  }

  // Phase 1: Prerequisites
  console.log(chalk.cyan.bold("[1/4] Checking prerequisites..."));
  if (walkthrough) {
    utils.explain([
      "WHY: KeyPick doesn't do encryption itself — it relies on two",
      "well-audited open-source tools:",
      "",
      "  • age  — a modern file encryption tool (like GPG but simpler).",
      "    Each machine gets its own age keypair. The public key is shared",
      "    with your vault so it can encrypt secrets FOR this machine.",
      "    The private key never leaves this machine.",
      "",
      "  • sops — \"Secrets OPerationS\" by Mozilla. It encrypts individual",
      "    values inside a YAML file (not the whole file), so you can see",
      "    key NAMES in plain text but VALUES stay encrypted. sops also",
      "    handles multi-recipient encryption: one vault, many machines.",
      "",
      "WHAT HAPPENS: We check if age and sops are already installed.",
      "If not, we download the correct binaries for your OS/architecture",
      "from their official GitHub releases and place them on your PATH.",
    ]);
  }
  try {
    await prerequisites.run(walkthrough);
  } catch (e) {
    console.error(chalk.red.bold("Setup failed:"), (e as Error).message);
    terminal.cleanupAndExit(1);
  }

  // Phase 2: Age key
  console.log(`\n${chalk.cyan.bold("[2/4] Machine identity...")}`);
  if (walkthrough) {
    utils.explain([
      "WHY: Every machine that accesses your vault needs its own age",
      "keypair. This is a core security property of KeyPick — if one",
      "machine is compromised, you revoke just that machine's key",
      "without affecting any others.",
      "",
      "The keypair consists of:",
      "  • A PRIVATE key (stored locally, never shared) — used to decrypt",
      "  • A PUBLIC key (shared with your vault) — used to encrypt FOR you",
      "",
      "WHAT HAPPENS: We check if you already have an age key on this",
      "machine. If you do, you can reuse it. If not, we generate a",
      "fresh keypair using `age-keygen` and store the private key at:",
      `  ${utils.ageKeyPath()}`,
    ]);
  }
  let publicKey: string;
  try {
    publicKey = await keygen.run(walkthrough);
  } catch (e) {
    console.error(chalk.red.bold("Key generation failed:"), (e as Error).message);
    terminal.cleanupAndExit(1);
  }

  // Phase 3: Vault repo
  console.log(`\n${chalk.cyan.bold("[3/4] Vault repository...")}`);
  if (walkthrough) {
    utils.explain([
      "WHY: Your encrypted secrets live in a Git repository — this is",
      "how they sync between machines. The repo contains:",
      "",
      "  • vault.yaml   — your secrets, encrypted by sops+age",
      "  • .sops.yaml   — lists which public keys can decrypt the vault",
      "",
      "The repo should be PRIVATE (only you can access it). Even though",
      "values are encrypted, the key NAMES are visible in the YAML.",
      "",
      "WHAT HAPPENS: You'll choose one of two paths:",
      "  • 'New vault' — if this is your first machine. We create a new",
      "     Git repo, initialize the SOPS config with your public key,",
      "     and create an empty encrypted vault under KeyPick's vault home.",
      "  • 'Join existing vault' — if you already set up KeyPick on",
      "     another machine. We clone your repo and register this",
      "     machine's public key so it can decrypt the vault too.",
    ]);
  }

  let choice: string;
  try {
    choice = await select({
      message: "Is this your first machine, or joining an existing vault?",
      choices: [
        { value: "new", name: "New vault (first machine)" },
        { value: "join", name: "Join existing vault" },
      ],
    });
  } catch {
    console.log(chalk.yellow("Setup cancelled."));
    return;
  }

  try {
    if (choice === "new") await init.run(publicKey, walkthrough);
    else await join.run(publicKey, walkthrough);
  } catch (e) {
    const label = choice === "new" ? "Init failed:" : "Join failed:";
    console.error(chalk.red.bold(label), (e as Error).message);
    terminal.cleanupAndExit(1);
  }

  // Phase 4: optional extras
  console.log(`\n${chalk.cyan.bold("[4/4] Optional enhancements...")}`);
  if (walkthrough) {
    utils.explain([
      "WHY: These optional features improve convenience and safety:",
      "",
      "  • GitHub Actions auto-sync — when you add a new machine,",
      "    a CI workflow automatically re-encrypts the vault so ALL",
      "    registered machines can decrypt it. Without this, you'd",
      "    have to manually run `sops updatekeys` from a machine",
      "    that already has access.",
      "",
      "  • Recovery key — a passphrase-protected backup key stored",
      "    offline. If you lose access to ALL your machines (e.g.",
      "    laptop stolen, desktop dies), the recovery key lets you",
      "    regain access to your vault. Without it, losing all",
      "    machines means losing all your secrets.",
    ]);
  }

  let wantActions = false;
  try {
    wantActions = await confirm({
      message: "Set up GitHub Actions auto-sync?",
      default: true,
    });
  } catch {
    wantActions = false;
  }
  if (wantActions) await actions.run(walkthrough);

  let wantRecovery = false;
  try {
    wantRecovery = await confirm({
      message: "Create a recovery key?",
      default: true,
    });
  } catch {
    wantRecovery = false;
  }
  if (wantRecovery) await recovery.run(walkthrough);

  console.log(`\n${chalk.green.bold("Setup complete!")}`);
  console.log(`  ${chalk.dim("Run `keypick add` to store your first secrets.")}`);

  if (walkthrough) {
    utils.explain([
      "ALL DONE! Here's what was set up:",
      "",
      "  • age + sops are installed and ready",
      "  • This machine has a unique age keypair",
      "  • Your vault repo is configured and syncing via Git",
      "",
      "NEXT STEPS:",
      "  1. Run `keypick add` to store your first API keys",
      "  2. Run `keypick extract` in a project directory to create a .env file",
      "  3. On another machine, run `keypick setup` and choose 'Join existing vault'",
      "  4. Use KEYPICK_VAULT_DIR only when you want to override the remembered vault",
      "",
      "Your secrets are encrypted at rest and protected by biometric",
      "authentication. They are only ever decrypted in memory during",
      "a keypick session.",
    ]);
  }
}
