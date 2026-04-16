// Full interactive menu (no subcommand given — just run `keypick`).

import chalk from "chalk";
import { select } from "@inquirer/prompts";
import * as extract from "./extract.ts";
import * as add from "./add.ts";
import * as list from "./list.ts";
import * as copy from "./copy.ts";
import * as push from "./env/push.ts";
import * as pull from "./env/pull.ts";

type Action =
  | "extract"
  | "add"
  | "list"
  | "copy"
  | "env-push"
  | "env-pull"
  | "exit";

export async function run(): Promise<void> {
  let action: Action;
  try {
    action = await select<Action>({
      message: "What would you like to do?",
      choices: [
        { value: "extract", name: "Extract keys to .env" },
        { value: "add", name: "Add / Update a key group" },
        { value: "list", name: "List vault contents" },
        { value: "copy", name: "Copy a key to clipboard" },
        { value: "env-push", name: "Push .env files to vault" },
        { value: "env-pull", name: "Pull .env files from vault" },
        { value: "exit", name: "Exit" },
      ],
    });
  } catch {
    action = "exit";
  }

  console.log();

  switch (action) {
    case "extract":
      return extract.run();
    case "add":
      return add.run();
    case "list":
      return list.run();
    case "copy":
      return copy.run();
    case "env-push":
      return push.run();
    case "env-pull":
      return pull.run();
    case "exit":
      console.log(chalk.dim("Goodbye!"));
      return;
  }
}
