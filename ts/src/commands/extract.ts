// Interactive multi-select: pick which groups to write to .env
// Ported from rust/src/commands/extract.rs.

import { writeFileSync } from "node:fs";
import chalk from "chalk";
import { checkbox } from "@inquirer/prompts";
import * as vault from "../lib/vault.ts";
import * as terminal from "../lib/terminal.ts";

const ENV_FILE = ".env";

export async function run(): Promise<void> {
  const data = await vault.load();

  const groups = Object.keys(data.services).sort();
  if (groups.length === 0) {
    console.log(chalk.yellow("  No groups found in vault. Run `keypick add` first."));
    return;
  }

  let selected: string[];
  try {
    selected = await checkbox({
      message: "Select the groups to extract into .env (Space to toggle, Enter to confirm):",
      choices: groups.map((g) => ({ value: g, name: g })),
    });
  } catch {
    terminal.cleanupAndExit(0);
  }

  if (selected.length === 0) {
    console.log(chalk.yellow("  Nothing selected. Aborted."));
    return;
  }

  let envContent = "";
  let totalKeys = 0;
  for (const group of selected) {
    const keys = data.services[group];
    if (!keys) continue;
    envContent += `# --- ${group} ---\n`;
    envContent += vault.keysToEnv(keys);
    envContent += "\n";
    totalKeys += Object.keys(keys).length;
  }

  try {
    writeFileSync(ENV_FILE, envContent);
  } catch (e) {
    console.error(`Failed to write .env: ${(e as Error).message}`);
    terminal.cleanupAndExit(1);
  }

  console.log(
    `\n  ${chalk.green.bold("✓")} ${chalk.cyan.bold(totalKeys)} keys from ${chalk.cyan(selected.length)} group(s) written to ${chalk.cyan.bold(ENV_FILE)}`,
  );
  console.log(
    `  ${chalk.yellow("⚠")} Add ${chalk.yellow(ENV_FILE)} to your .gitignore so secrets are never committed.`,
  );
}
