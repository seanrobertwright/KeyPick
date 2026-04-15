// Copy a single key's value directly to clipboard — nothing written to disk.
// Ported from rust/src/commands/copy.rs.

import chalk from "chalk";
import clipboard from "clipboardy";
import { select } from "@inquirer/prompts";
import * as vault from "../lib/vault.ts";
import * as terminal from "../lib/terminal.ts";

export async function run(): Promise<void> {
  const data = await vault.load();

  const groups = Object.keys(data.services).sort();
  if (groups.length === 0) {
    console.log(chalk.yellow("  Vault is empty."));
    return;
  }

  let group: string;
  try {
    group = await select({
      message: "Select group:",
      choices: groups.map((g) => ({ value: g, name: g })),
    });
  } catch {
    terminal.cleanupAndExit(0);
  }

  const keysMap = data.services[group] ?? {};
  const keyNames = Object.keys(keysMap).sort();

  let key: string;
  try {
    key = await select({
      message: "Select key to copy:",
      choices: keyNames.map((k) => ({ value: k, name: k })),
    });
  } catch {
    terminal.cleanupAndExit(0);
  }

  const value = keysMap[key];
  if (value === undefined) {
    console.error(chalk.red(`Key '${key}' not found in group '${group}'.`));
    terminal.cleanupAndExit(1);
  }

  try {
    await clipboard.write(value);
  } catch (e) {
    console.error(`Failed to set clipboard: ${(e as Error).message}`);
    terminal.cleanupAndExit(1);
  }

  console.log(
    `\n  ${chalk.green.bold("✓")} ${chalk.cyan(group)} → ${chalk.cyan.bold(key)} copied to clipboard.`,
  );
  console.log(`  ${chalk.dim("Value is NOT on disk. Clipboard will clear on reboot.")}`);
}
