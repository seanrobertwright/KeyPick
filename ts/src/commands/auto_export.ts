// Non-interactive export for shell evaluation (used by direnv).
//
// Prints `export KEY='VALUE'` lines to stdout for each group provided.
// No biometric gate — authentication is handled by the calling shell context.
//
// Usage in .envrc:
//   eval $(keypick auto Supabase_Prod Google_AI)

import * as vault from "../lib/vault.ts";
import * as terminal from "../lib/terminal.ts";

export async function run(groups: string[]): Promise<void> {
  if (groups.length === 0) {
    console.error("Usage: keypick auto <Group1> [Group2 ...]");
    terminal.cleanupAndExit(1);
  }

  const data = await vault.load();
  let output = "";
  for (const group of groups) {
    const keys = data.services[group];
    if (keys) {
      output += `# ${group}\n`;
      output += vault.keysToExports(keys);
    } else {
      console.error(`Warning: group '${group}' not found in vault.`);
    }
  }

  process.stdout.write(output);
}
