// Interactive wizard: add or update a key group in the vault.

import chalk from "chalk";
import { select, input, confirm } from "@inquirer/prompts";
import * as vault from "../lib/vault.ts";
import * as terminal from "../lib/terminal.ts";

const NEW_GROUP = "[ + New Group ]";

export async function run(): Promise<void> {
  const data = await vault.load();

  const existingGroups = Object.keys(data.services).sort();
  const options: string[] = [NEW_GROUP, ...existingGroups];

  let groupChoice: string;
  try {
    groupChoice = await select({
      message: "Select a group to update, or create a new one:",
      choices: options.map((v) => ({ value: v, name: v })),
    });
  } catch {
    terminal.cleanupAndExit(0);
  }

  let groupName: string;
  if (groupChoice === NEW_GROUP) {
    try {
      groupName = await input({
        message: "Service/Group name (e.g. Supabase_Prod, Google_AI):",
      });
    } catch {
      terminal.cleanupAndExit(0);
    }
  } else {
    groupName = groupChoice;
  }

  if (!data.services[groupName]) data.services[groupName] = {};
  const entry = data.services[groupName];

  console.log(
    `\n  ${chalk.dim("Adding keys to group:")} ${chalk.cyan.bold(groupName)}\n  ${chalk.dim("Leave 'Key Name' blank to finish.")}\n`,
  );

  // biome-ignore lint: intentional infinite loop
  while (true) {
    let key: string;
    try {
      key = await input({ message: "Key Name  :" });
    } catch {
      terminal.cleanupAndExit(0);
    }

    if (key.trim() === "") break;

    let val: string;
    try {
      val = await input({ message: `Value for ${chalk.cyan.bold(key)}:` });
    } catch {
      terminal.cleanupAndExit(0);
    }

    const isUpdate = key in entry;
    entry[key] = val;

    if (isUpdate) console.log(`  ${chalk.yellow("↺ Updated:")} ${key}`);
    else console.log(`  ${chalk.green("✓ Added:")} ${key}`);

    let again = false;
    try {
      again = await confirm({ message: "Add another key to this group?", default: true });
    } catch {
      again = false;
    }
    if (!again) break;
  }

  console.log(`\n${chalk.dim("  Encrypting and saving vault...")}`);
  await vault.save(data);
  const dir = await vault.vaultDir();
  console.log(chalk.green.bold("  ✓ Vault updated successfully."));
  console.log(
    `\n  ${chalk.dim("Remember to sync:")} cd ${dir} && git add vault.yaml && git commit -m "Update ${groupName}" && git push`,
  );
}
