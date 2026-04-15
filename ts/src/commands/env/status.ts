// `keypick env status` — compare local .env files with vault copies.
// Ported from rust/src/commands/env/status.rs.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import chalk from "chalk";
import * as vault from "../../lib/vault.ts";
import * as terminal from "../../lib/terminal.ts";
import * as setupUtils from "../setup/utils.ts";
import * as envUtils from "./utils.ts";

export async function run(): Promise<void> {
  try {
    await runInner();
  } catch (e) {
    console.error(chalk.red.bold("Status failed:"), (e as Error).message);
    terminal.cleanupAndExit(1);
  }
}

async function runInner(): Promise<void> {
  const cwd = process.cwd();
  const { id: projectId, usedFallback } = envUtils.deriveProjectId(cwd);
  if (usedFallback) {
    console.log(
      `  ${chalk.yellow.bold("!")} ${chalk.dim(
        `No git remote found. Using folder name '${projectId}' as project identifier.`,
      )}`,
    );
  }
  console.log(`  ${chalk.dim("Project:")} ${chalk.cyan.bold(projectId)}`);

  const vaultDir = await vault.vaultDir();

  const sp = setupUtils.spinner("Fetching latest...");
  let fetchFailed = false;
  try {
    setupUtils.runGit(vaultDir, ["fetch"]);
  } catch {
    fetchFailed = true;
  }
  sp.stop();
  if (fetchFailed) {
    console.log(
      `  ${chalk.yellow.bold("!")} ${chalk.dim("Could not fetch latest — showing local vault state.")}`,
    );
  }

  const vaultEnvDir = envUtils.envsDir(vaultDir, projectId);
  let vaultFiles: string[] = [];
  if (existsSync(vaultEnvDir)) {
    try {
      vaultFiles = readdirSync(vaultEnvDir).filter((n) => n.startsWith(".env"));
    } catch (e) {
      throw new Error(`Failed to read vault envs: ${(e as Error).message}`);
    }
  }

  const localFiles: string[] = envUtils.discoverEnvFiles(cwd).map((p) => path.basename(p));

  const vaultSet = new Set(vaultFiles);
  const localSet = new Set(localFiles);
  const inBoth = localFiles.filter((f) => vaultSet.has(f));
  const localOnly = localFiles.filter((f) => !vaultSet.has(f));
  const vaultOnly = vaultFiles.filter((f) => !localSet.has(f));

  console.log();

  if (vaultFiles.length === 0 && localFiles.length === 0) {
    console.log(`  ${chalk.dim("·")} No .env files found locally or in the vault.`);
    return;
  }

  if (inBoth.length > 0) {
    console.log(`  ${chalk.green("■")} Synced (in vault and local):`);
    for (const f of inBoth) console.log(`    ${chalk.cyan(f)}`);
  }
  if (localOnly.length > 0) {
    console.log(`  ${chalk.yellow("■")} Local only (not pushed):`);
    for (const f of localOnly) console.log(`    ${chalk.yellow(f)}`);
  }
  if (vaultOnly.length > 0) {
    console.log(`  ${chalk.blue("■")} Vault only (not pulled):`);
    for (const f of vaultOnly) console.log(`    ${chalk.blue(f)}`);
  }

  console.log();
}
