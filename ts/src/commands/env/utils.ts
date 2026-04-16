// Shared helpers for `keypick env` subcommands.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Derive a project identifier from the given directory.
 *
 * Resolution:
 *   1. Parse `git remote get-url origin` → normalize to `owner__repo`
 *   2. Fall back to directory name if no git remote
 */
export function deriveProjectId(dir: string): { id: string; usedFallback: boolean } {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (!result.error && result.status === 0) {
    const url = (result.stdout ?? "").trim();
    const id = normalizeRemoteUrl(url);
    if (id) return { id, usedFallback: false };
  }

  const dirName = path.basename(dir);
  if (!dirName) throw new Error("Cannot determine directory name");
  return { id: dirName, usedFallback: true };
}

/**
 * Normalize a git remote URL to a project identifier.
 *   https://github.com/owner/repo.git → owner__repo
 *   git@github.com:owner/repo.git     → owner__repo
 *   https://github.com/owner/repo     → owner__repo
 */
export function normalizeRemoteUrl(url: string): string | null {
  const cleaned = url.trim();
  let remainder: string;

  if (cleaned.startsWith("git@")) {
    const afterGitAt = cleaned.slice("git@".length);
    const colon = afterGitAt.indexOf(":");
    if (colon === -1) return null;
    remainder = afterGitAt.slice(colon + 1);
  } else {
    let withoutProto: string | null = null;
    if (cleaned.startsWith("https://")) withoutProto = cleaned.slice("https://".length);
    else if (cleaned.startsWith("http://")) withoutProto = cleaned.slice("http://".length);
    if (withoutProto === null) return null;
    const slash = withoutProto.indexOf("/");
    if (slash === -1) return null;
    remainder = withoutProto.slice(slash + 1);
  }

  const stripped = remainder.endsWith(".git") ? remainder.slice(0, -4) : remainder;
  const id = stripped.replace(/\//g, "__");
  return id === "" ? null : id;
}

/**
 * Find all .env* files in a directory (non-recursive).
 * Returns sorted list of file paths. Skips empty files.
 */
export function discoverEnvFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const matches = entries
    .filter((name) => name.startsWith(".env"))
    .map((name) => path.join(dir, name))
    .filter((p) => {
      try {
        const s = statSync(p);
        return s.isFile() && s.size > 0;
      } catch {
        return false;
      }
    });
  matches.sort();
  return matches;
}

export function envsDir(vaultDir: string, projectId: string): string {
  return path.join(vaultDir, "envs", projectId);
}

/**
 * Ensure .sops.yaml has an `envs/.*` creation rule.
 * If missing, adds one using the age recipients from the existing vault.yaml rule.
 * Returns true if the file was modified.
 */
export function ensureSopsEnvRule(vaultDir: string): boolean {
  const sopsPath = path.join(vaultDir, ".sops.yaml");
  let content: string;
  try {
    content = readFileSync(sopsPath, "utf8");
  } catch (e) {
    throw new Error(`Failed to read .sops.yaml: ${(e as Error).message}`);
  }

  if (content.includes("envs/")) return false;

  // Extract age recipients from the existing vault.yaml rule.
  const lines = content.split(/\r?\n/);
  let ageValue = "";
  let inVaultRule = false;
  let foundAge = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- path_regex:") && trimmed.includes("vault")) {
      inVaultRule = true;
      continue;
    }
    if (inVaultRule && trimmed.startsWith("age:")) {
      foundAge = true;
      const afterAge = trimmed.slice("age:".length).trim();
      if (afterAge === ">-" || afterAge === "|" || afterAge === "") {
        // Block scalar — collect following lines below
        continue;
      } else {
        ageValue = afterAge.replace(/^"|"$/g, "");
        break;
      }
    }
    if (foundAge && inVaultRule) {
      if (trimmed.startsWith("age1") || trimmed.startsWith('"age1')) {
        if (ageValue !== "") {
          ageValue = ageValue.replace(/,+$/, "");
          ageValue += ",";
        }
        ageValue += trimmed.replace(/,+$/, "");
      } else if (trimmed !== "" && !trimmed.startsWith("-")) {
        continue;
      } else {
        break;
      }
    }
    if (inVaultRule && trimmed.startsWith("- ") && foundAge) break;
  }

  if (ageValue === "") {
    throw new Error("Could not find age recipients in .sops.yaml");
  }

  const envRule = `creation_rules:\n  - path_regex: envs/.*\n    age: >-\n      ${ageValue}\n  - path_regex: vault\\.yaml$`;
  const updated = content.replace(
    "creation_rules:\n  - path_regex: vault\\.yaml$",
    envRule,
  );

  try {
    writeFileSync(sopsPath, updated);
  } catch (e) {
    throw new Error(`Failed to write .sops.yaml: ${(e as Error).message}`);
  }
  return true;
}
