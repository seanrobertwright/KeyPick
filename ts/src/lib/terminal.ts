// Terminal state management: panic hooks, console restore, focus.
// Stub — full implementation ported from src/terminal.rs in task #5.

export function installPanicHook(): void {
  process.on("uncaughtException", (err) => {
    console.error(err);
    cleanupAndExit(1);
  });
  process.on("SIGINT", () => cleanupAndExit(130));
}

export function cleanupAndExit(code: number): never {
  process.exit(code);
}

export function restoreConsoleFocus(): void {
  // Windows-only no-op stub; implemented in task #5.
}
