// `keypick env pull` — decrypt .env files from the vault to the current project.

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
    console.error(chalk.red.bold("Pull failed:"), (e as Error).message);
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

  const sp = setupUtils.spinner("Pulling latest from vault...");
  try {
    setupUtils.runGit(vaultDir, ["pull"]);
  } catch {
    // best-effort
  }
  sp.stop();

  const srcDir = envUtils.envsDir(vaultDir, projectId);
  if (!existsSync(srcDir)) {
    throw new Error(
      `No .env files stored for project '${projectId}'.\n  Push first with: keypick env push`,
    );
  }

  const entries = readdirSync(srcDir)
    .map((name) => ({ name, full: path.join(srcDir, name) }))
    .filter((e) => {
      try {
        return statSync(e.full).isFile() && e.name.startsWith(".env");
      } catch {
        return false;
      }
    });

  if (entries.length === 0) {
    throw new Error(`No .env files found in vault for project '${projectId}'.`);
  }

  const sp2 = setupUtils.spinner("Decrypting .env files...");
  const written: { name: string; existed: boolean }[] = [];
  const errors: string[] = [];

  for (const entry of entries) {
    const destPath = path.join(cwd, entry.name);
    const existed = existsSync(destPath);
    const result = spawnSync(
      "sops",
      ["--decrypt", "--input-type", "dotenv", "--output-type", "dotenv", entry.full],
      { encoding: "buffer" },
    );
    if (result.error) {
      sp2.stop();
      throw new Error(`Failed to run sops: ${result.error.message}`);
    }
    if (result.status === 0) {
      try {
        writeFileSync(destPath, result.stdout!);
        written.push({ name: entry.name, existed });
      } catch (e) {
        sp2.stop();
        throw new Error(`Failed to write ${destPath}: ${(e as Error).message}`);
      }
    } else {
      const stderr = (result.stderr?.toString("utf8") ?? "").trim();
      errors.push(`${entry.name}: ${stderr}`);
    }
  }
  sp2.stop();

  for (const { name, existed } of written) {
    const action = existed ? "overwritten" : "created";
    console.log(`  ${chalk.green.bold("✓")} ${chalk.cyan(name)} (${chalk.dim(action)})`);
  }
  for (const err of errors) {
    console.log(`  ${chalk.red("✗")} ${err}`);
  }

  if (written.length === 0) {
    throw new Error("All files failed to decrypt.");
  }

  console.log(
    `\n  ${chalk.green.bold("✓")} ${chalk.cyan.bold(written.length)} .env file(s) pulled for ${chalk.cyan(projectId)}`,
  );
}
