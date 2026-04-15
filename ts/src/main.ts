#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import * as terminal from "./lib/terminal.ts";
import * as auth from "./lib/auth.ts";

// Command handlers (to be implemented)
// import * as add from "./commands/add.ts";
// import * as list from "./commands/list.ts";
// ...

const VERSION = "0.1.0";

function printBanner(): void {
  const banner = `
  ██╗  ██╗███████╗██╗   ██╗    ██████╗ ██╗ ██████╗██╗  ██╗
  ██║ ██╔╝██╔════╝╚██╗ ██╔╝    ██╔══██╗██║██╔════╝██║ ██╔╝
  █████╔╝ █████╗   ╚████╔╝     ██████╔╝██║██║     █████╔╝
  ██╔═██╗ ██╔══╝    ╚██╔╝      ██╔═══╝ ██║██║     ██╔═██╗
  ██║  ██╗███████╗   ██║       ██║     ██║╚██████╗██║  ██╗
  ╚═╝  ╚═╝╚══════╝   ╚═╝       ╚═╝     ╚═╝ ╚═════╝╚═╝  ╚═╝
`;
  console.log(chalk.cyan.bold(banner));
  console.log(
    `  ${chalk.cyan.bold("KeyPick")} ${chalk.dim("— Secure Cross-Platform API Key Vault")}\n`,
  );
}

async function main(): Promise<void> {
  terminal.installPanicHook();
  printBanner();

  const program = new Command();
  program
    .name("keypick")
    .version(VERSION)
    .description("Secure, grouped API key manager powered by SOPS + age");

  program.command("add").description("Add or update keys in a named service group").action(async () => {
    await requireBio();
    console.log(chalk.yellow("add: not yet implemented"));
  });

  program.command("list").description("List all stored service groups").action(async () => {
    await requireBio();
    console.log(chalk.yellow("list: not yet implemented"));
  });

  program.command("copy").description("Copy a specific key value to the clipboard").action(async () => {
    await requireBio();
    console.log(chalk.yellow("copy: not yet implemented"));
  });

  program.command("extract").description("Extract keys into a .env file").action(async () => {
    await requireBio();
    console.log(chalk.yellow("extract: not yet implemented"));
  });

  program
    .command("auto")
    .description("Non-interactive export for direnv")
    .argument("[groups...]", "Names of service groups to export")
    .action(async (_groups: string[]) => {
      // auto skips biometric
      console.log(chalk.yellow("auto: not yet implemented"));
    });

  // TODO: vault, env, setup subcommands

  // No args → interactive menu
  if (process.argv.length <= 2) {
    await requireBio();
    console.log(chalk.yellow("interactive: not yet implemented"));
    return;
  }

  await program.parseAsync(process.argv);
}

async function requireBio(): Promise<void> {
  try {
    await auth.verify();
  } catch (e) {
    console.error(chalk.red.bold("Authentication failed:"), (e as Error).message);
    terminal.cleanupAndExit(1);
  }
  terminal.restoreConsoleFocus();
  console.log(chalk.green.bold("✓ Identity verified.\n"));
}

main().catch((e) => {
  console.error(chalk.red.bold("Fatal:"), e);
  terminal.cleanupAndExit(1);
});
