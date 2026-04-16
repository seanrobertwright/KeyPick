// `keypick env push` — encrypt and push .env files to the vault.

import { ensureDir } from "../../lib/fs.ts";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import * as vault from "../../lib/vault.ts";
import * as terminal from "../../lib/terminal.ts";
import * as setupUtils from "../setup/utils.ts";
import * as envUtils from "./utils.ts";

export async function run(): Promise<void> {
  try {
    await runInner();
  } catch (e) {
    console.error(chalk.red.bold("Push failed:"), (e as Error).message);
    terminal.cleanupAndExit(1);
  }
}

async function runInner(): Promise<void> {
  const cwd = process.cwd();

  const { id: projectId, usedFallback } = envUtils.deriveProjectId(cwd);
  if (usedFallback) {
    console.log(
      `  ${chalk.yellow.bold("!")} ${chalk.dim(
        `No git remote found. Using folder name '${projectId}' as project identifier.\n    Projects on other machines must use the same folder name to pull.`,
      )}`,
    );
  }
  console.log(`  ${chalk.dim("Project:")} ${chalk.cyan.bold(projectId)}`);

  const envFiles = envUtils.discoverEnvFiles(cwd);
  if (envFiles.length === 0) {
    throw new Error("No .env files found in the current directory.");
  }

  console.log(`\n  ${chalk.dim("Found")} files to push:`);
  for (const f of envFiles) {
    console.log(`    ${chalk.cyan(path.basename(f))}`);
  }
  console.log();

  const vaultDir = await vault.vaultDir();

  try {
    const modified = envUtils.ensureSopsEnvRule(vaultDir);
    if (modified) setupUtils.done("Updated .sops.yaml with env file encryption rule");
  } catch (e) {
    throw new Error(`Failed to update .sops.yaml: ${(e as Error).message}`);
  }

  const destDir = envUtils.envsDir(vaultDir, projectId);
  try {
    ensureDir(destDir);
  } catch (e) {
    throw new Error(`Failed to create ${destDir}: ${(e as Error).message}`);
  }

  const sp = setupUtils.spinner("Encrypting .env files...");
  const errors: string[] = [];

  for (const src of envFiles) {
    const name = path.basename(src);
    const dest = path.join(destDir, name);
    const result = spawnSync(
      "sops",
      ["--encrypt", "--input-type", "dotenv", "--output-type", "dotenv", "--output", dest, src],
      { encoding: "buffer" },
    );
    if (result.error) {
      sp.stop();
      throw new Error(`Failed to run sops: ${result.error.message}`);
    }
    if (result.status === 0) {
      // output written directly to dest via --output flag
    } else {
      const stderr = (result.stderr?.toString("utf8") ?? "").trim();
      errors.push(`${name}: ${stderr}`);
    }
  }
  sp.stop();

  if (errors.length > 0) {
    for (const err of errors) console.log(`  ${chalk.red("✗")} ${err}`);
    if (errors.length === envFiles.length) {
      throw new Error("All files failed to encrypt.");
    }
  }

  let envsStatus = "";
  try {
    envsStatus = setupUtils.runGit(vaultDir, ["status", "--porcelain", "envs/"]);
  } catch (e) {
    throw new Error((e as Error).message);
  }
  let sopsStatus = "";
  try {
    sopsStatus = setupUtils.runGit(vaultDir, ["status", "--porcelain", ".sops.yaml"]);
  } catch {
    sopsStatus = "";
  }

  if (envsStatus.trim() === "" && sopsStatus.trim() === "") {
    setupUtils.done("No changes to push — vault is already up to date.");
    return;
  }

  const envsPath = `envs/${projectId}`;
  const commitMsg = `update env: ${projectId}`;
  const filesToAdd: string[] = [envsPath];
  if (sopsStatus.trim() !== "") filesToAdd.push(".sops.yaml");

  setupUtils.gitCommitAndPush(vaultDir, filesToAdd, commitMsg);

  const pushedCount = envFiles.length - errors.length;
  console.log(
    `\n  ${chalk.green.bold("✓")} ${chalk.cyan.bold(pushedCount)} .env file(s) pushed for ${chalk.cyan(projectId)}`,
  );
}
