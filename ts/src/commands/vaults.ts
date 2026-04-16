// Vault repository management subcommands.

import chalk from "chalk";
import * as vault from "../lib/vault.ts";
import * as terminal from "../lib/terminal.ts";

export type VaultSubcommand = "list" | "current" | "select";

export async function run(sub: VaultSubcommand): Promise<void> {
  switch (sub) {
    case "list":
      return listVaults();
    case "current":
      return currentVault();
    case "select":
      return selectVault();
  }
}

function listVaults(): void {
  const current = vault.currentVaultDir();
  const vaults = vault.listKnownVaults();

  if (vaults.length === 0) {
    console.log(
      `  ${chalk.yellow.bold("!")} No known vaults found under ${vault.vaultsHomeDir()}`,
    );
    return;
  }

  console.log(`\n  ${chalk.bold.underline("Known Vaults:")}\n`);
  for (const p of vaults) {
    const marker = current === p ? "*" : "-";
    console.log(`  ${chalk.cyan.bold(marker)} ${p}`);
  }
  console.log();
}

function currentVault(): void {
  const p = vault.currentVaultDir();
  if (p) {
    console.log(p);
  } else {
    console.error("No active vault is selected. Run `keypick vault select` or `keypick setup`.");
    terminal.cleanupAndExit(1);
  }
}

async function selectVault(): Promise<void> {
  try {
    const p = await vault.selectKnownVaultInteractively();
    console.log(`\n  ${chalk.green.bold("Active vault:")} ${chalk.cyan.bold(p)}`);
  } catch (e) {
    console.error((e as Error).message);
    terminal.cleanupAndExit(1);
  }
}
