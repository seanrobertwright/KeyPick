// Non-interactive export for shell evaluation (used by direnv).
//
// Prints `export KEY='VALUE'` lines to stdout for each group provided, and
// nothing else: stdout is eval'd, so usage and missing-group warnings go to
// stderr. If any key name in those groups isn't a shell variable name, prints
// nothing to stdout, names each such key on stderr, and exits 1. No biometric
// gate — authentication is handled by the calling shell context.
//
// Usage in .envrc (quote the substitution so values keep their whitespace
// and aren't glob-expanded):
//   eval "$(keypick auto Supabase_Prod Google_AI)"

import * as vault from "../lib/vault.ts";
import * as terminal from "../lib/terminal.ts";

export async function run(groups: string[]): Promise<void> {
  if (groups.length === 0) {
    console.error("Usage: keypick auto <Group1> [Group2 ...]");
    terminal.cleanupAndExit(1);
  }

  const data = await vault.load();
  const found: string[] = [];
  for (const group of groups) {
    if (vault.groupKeys(data.services, group)) {
      found.push(group);
    } else {
      console.error(`Warning: group '${group}' not found in vault.`);
    }
  }

  let output: string;
  try {
    output = vault.groupsToExports(data.services, found);
  } catch (e) {
    if (!(e instanceof vault.UnsafeVaultContentError)) throw e;
    console.error(`Nothing exported: eval could run these key names as shell commands.\n${e.message}`);
    terminal.cleanupAndExit(1);
  }

  process.stdout.write(output);
}
