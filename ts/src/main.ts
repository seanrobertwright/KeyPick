#!/usr/bin/env bun
// KeyPick — Cross-platform API key vault manager (TypeScript port).

import { Command } from "commander";
import chalk from "chalk";
import * as terminal from "./lib/terminal.ts";
import * as auth from "./lib/auth.ts";
import * as add from "./commands/add.ts";
import * as list from "./commands/list.ts";
import * as copy from "./commands/copy.ts";
import * as extract from "./commands/extract.ts";
import * as autoExport from "./commands/auto_export.ts";
import * as vaults from "./commands/vaults.ts";
import * as env from "./commands/env/index.ts";
import * as setup from "./commands/setup/index.ts";
import * as interactive from "./commands/interactive.ts";

const VERSION = "0.2.0";

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

/** Run the biometric gate, or exit with an error. */
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

async function main(): Promise<void> {
  terminal.installPanicHook();
  printBanner();

  // Special case: no args → interactive menu (still needs biometric gate).
  if (process.argv.length <= 2) {
    await requireBio();
    return interactive.run();
  }

  const program = new Command();
  program
    .name("keypick")
    .version(VERSION)
    .description("Secure, grouped API key manager powered by SOPS + age");

  program
    .command("add")
    .description("Add or update keys in a named service group")
    .action(async () => {
      await requireBio();
      await add.run();
    });

  program
    .command("extract")
    .description("Extract keys from one or more groups into a .env file")
    .action(async () => {
      await requireBio();
      await extract.run();
    });

  program
    .command("list")
    .description("List all stored service groups and their key names (values hidden)")
    .action(async () => {
      await requireBio();
      await list.run();
    });

  program
    .command("copy")
    .description("Copy a specific key value to the clipboard (never written to disk)")
    .action(async () => {
      await requireBio();
      await copy.run();
    });

  program
    .command("auto")
    .description("Non-interactive export for use with direnv .envrc files")
    .argument("[groups...]", "Names of the service groups to export")
    .action(async (groups: string[]) => {
      // `auto` skips the biometric gate (used inside eval/direnv contexts).
      await autoExport.run(groups);
    });

  // Vault subcommands — skip biometric gate (non-secret operations).
  const vaultCmd = program.command("vault").description("Manage vault repository selection");
  vaultCmd
    .command("list")
    .description("List known vault repositories")
    .action(async () => vaults.run("list"));
  vaultCmd
    .command("current")
    .description("Show the currently selected vault repository")
    .action(async () => vaults.run("current"));
  vaultCmd
    .command("select")
    .description("Interactively choose the active vault repository")
    .action(async () => vaults.run("select"));

  // Env subcommands — status skips bio, push/pull gate.
  const envCmd = program.command("env").description("Manage per-project .env files in the vault");
  envCmd
    .command("status")
    .description("Show which .env files are stored for the current project")
    .action(async () => env.run("status"));
  envCmd
    .command("push")
    .description("Push .env files from the current project to the vault")
    .action(async () => {
      await requireBio();
      await env.run("push");
    });
  envCmd
    .command("pull")
    .description("Pull .env files from the vault to the current project")
    .action(async () => {
      await requireBio();
      await env.run("pull");
    });

  // Setup runs before vault exists — skip biometric gate entirely.
  const setupCmd = program
    .command("setup")
    .description("Set up KeyPick on this machine (install prerequisites, configure vault)")
    .option("--walkthrough", "Run setup with detailed explanations of each step")
    .action(async (opts: { walkthrough?: boolean }) => {
      await setup.run(undefined, opts.walkthrough === true);
    });
  setupCmd
    .command("actions")
    .description("Set up GitHub Actions auto re-encryption")
    .option("--walkthrough", "Run setup with detailed explanations of each step")
    .action(async (opts: { walkthrough?: boolean }) => {
      await setup.run("actions", opts.walkthrough === true);
    });
  setupCmd
    .command("recovery")
    .description("Generate a passphrase-protected recovery key")
    .option("--walkthrough", "Run setup with detailed explanations of each step")
    .action(async (opts: { walkthrough?: boolean }) => {
      await setup.run("recovery", opts.walkthrough === true);
    });

  await program.parseAsync(process.argv);
}

main().catch((e) => {
  console.error(chalk.red.bold("Fatal:"), e);
  terminal.cleanupAndExit(1);
});
