// Terminal state management.
//
// Two responsibilities:
//   1. Restore the terminal to a sane state on exit / uncaught error
//      (disable raw mode, the inquirer equivalent of crossterm).
//   2. On Windows, re-establish console focus after Windows Hello closes —
//      the Windows Hello dialog disconnects ConPTY's focus pipe, so we
//      shell out to PowerShell to minimize/restore the host window.

import { spawnSync } from "node:child_process";
import process from "node:process";
import { isWsl } from "./wsl.ts";

function disableRawMode(): void {
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  } catch {
    // best-effort
  }
}

/** Restore the terminal to a sane state and exit. */
export function cleanupAndExit(code: number): never {
  disableRawMode();
  process.exit(code);
}

/**
 * Install handlers so uncaught errors and SIGINT don't leave the terminal
 * stuck in raw mode.
 */
export function installPanicHook(): void {
  process.on("uncaughtException", (err) => {
    disableRawMode();
    console.error(err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    disableRawMode();
    console.error(reason);
    process.exit(1);
  });
  process.on("SIGINT", () => {
    disableRawMode();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    disableRawMode();
    process.exit(143);
  });
}

/**
 * Restore keyboard input to the terminal after an external dialog
 * (like Windows Hello) that disconnects ConPTY's focus tracking.
 *
 * On Windows, shells out to a PowerShell snippet that performs a
 * minimize/restore cycle on the terminal's root-owner window. This is
 * the programmatic equivalent of the lock/unlock workaround.
 *
 * No-op on macOS and Linux.
 */
export function restoreConsoleFocus(): void {
  const isWindows = process.platform === "win32";
  const wsl = isWsl();
  if (!isWindows && !wsl) return;

  // Uses Win32 APIs via Add-Type. GetConsoleWindow + GetAncestor(..., GA_ROOTOWNER)
  // because in Windows Terminal, GetConsoleWindow returns a hidden ConPTY pseudo-window.
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace KP -Name Win -MemberDefinition @"
  [System.Runtime.InteropServices.DllImport("kernel32.dll")]
  public static extern System.IntPtr GetConsoleWindow();
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern System.IntPtr GetAncestor(System.IntPtr hwnd, uint gaFlags);
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(System.IntPtr hWnd);
"@
$console = [KP.Win]::GetConsoleWindow()
if ($console -eq [System.IntPtr]::Zero) { exit 0 }
$root = [KP.Win]::GetAncestor($console, 3) # GA_ROOTOWNER
$target = if ($root -eq [System.IntPtr]::Zero) { $console } else { $root }
[KP.Win]::ShowWindow($target, 6) | Out-Null  # SW_MINIMIZE
Start-Sleep -Milliseconds 200
[KP.Win]::ShowWindow($target, 9) | Out-Null  # SW_RESTORE
[KP.Win]::SetForegroundWindow($target) | Out-Null
Start-Sleep -Milliseconds 100
`;

  // WSL exposes powershell.exe via interop; same call shape works.
  try {
    spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { stdio: "ignore" },
    );
  } catch {
    // best-effort
  }
}
