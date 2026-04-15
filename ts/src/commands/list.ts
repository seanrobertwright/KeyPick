// List all groups and key names (values hidden).
// Ported from rust/src/commands/list.rs.

import chalk from "chalk";
import * as vault from "../lib/vault.ts";

export async function run(): Promise<void> {
  const data = await vault.load();

  const groups = Object.keys(data.services).sort();
  if (groups.length === 0) {
    console.log(chalk.yellow("  Vault is empty. Run `keypick add` to add your first group."));
    return;
  }

  console.log(`\n  ${chalk.bold.underline("Vault Contents (values hidden):")}\n`);

  let totalKeys = 0;
  for (const group of groups) {
    const keys = data.services[group] ?? {};
    console.log(`  ${chalk.cyan("◆")} ${chalk.cyan.bold(group)}`);
    for (const key of Object.keys(keys).sort()) {
      console.log(`      ${chalk.dim("·")} ${key}`);
    }
    totalKeys += Object.keys(keys).length;
    console.log();
  }

  console.log(
    `  ${chalk.dim("→")} ${groups.length} group(s), ${totalKeys} key(s) total.\n`,
  );
}
