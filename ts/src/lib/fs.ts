import { mkdirSync, statSync } from "node:fs";

/**
 * Recursive mkdir that tolerates an existing directory at the target.
 *
 * Bun 1.3 on Windows throws EEXIST for mkdirSync(p, { recursive: true }) when
 * p is inside a OneDrive-synced tree and already exists (Node does not). This
 * wrapper recovers by verifying the path is already a directory.
 */
export function ensureDir(p: string): void {
  try {
    mkdirSync(p, { recursive: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      try {
        if (statSync(p).isDirectory()) return;
      } catch {
        // fall through to rethrow original
      }
    }
    throw e;
  }
}
