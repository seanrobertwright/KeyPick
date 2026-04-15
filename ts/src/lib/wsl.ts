// WSL detection.
//
// WSL reports process.platform === "linux" but polkit is typically
// absent/broken, so it needs its own branch for biometric auth, clipboard,
// and focus restore. We detect WSL via `/proc/version` (contains "microsoft"
// or "WSL") and the WSL_DISTRO_NAME env var (set by WSL's init).

import { readFileSync } from "node:fs";
import process from "node:process";

let cached: boolean | null = null;

export function isWsl(): boolean {
  if (cached !== null) return cached;
  if (process.platform !== "linux") {
    cached = false;
    return false;
  }
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    cached = true;
    return true;
  }
  try {
    const v = readFileSync("/proc/version", "utf8").toLowerCase();
    cached = v.includes("microsoft") || v.includes("wsl");
  } catch {
    cached = false;
  }
  return cached;
}
