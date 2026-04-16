// Cross-platform biometric authentication — shells out to per-OS native helpers.
//
//   Windows  → PowerShell + Windows.Security.Credentials.UI.UserConsentVerifier
//   macOS    → swift + LocalAuthentication (LAContext)
//   WSL      → Windows Hello on the host via powershell.exe (WSL interop)
//   Linux    → pkexec (polkit) — prompts for the user's login credentials
//

import { spawnSync, spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { isWsl } from "./wsl.ts";

const TITLE = "KeyPick Vault";
const REASON = "Verify your identity to access API keys";

export async function verify(): Promise<void> {
  switch (process.platform) {
    case "win32":
      return verifyWindows();
    case "darwin":
      return verifyMacOS();
    case "linux":
      if (isWsl()) return verifyWindowsHelloFromWsl();
      return verifyLinux();
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows Hello — shared between native Windows and WSL
// ─────────────────────────────────────────────────────────────────────────────

/** PowerShell script that awaits WinRT's UserConsentVerifier. Runs on the host. */
function windowsHelloScript(): string {
  return `
$ErrorActionPreference = 'Stop'
[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Generic AsTask<T>(IAsyncOperation<T>) trampoline
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]

function AwaitOp($op, $resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
    $task.Wait() | Out-Null
    $task.Result
}

$availType = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability]
$availOp = [Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()
$availability = AwaitOp $availOp $availType

if ($availability -ne $availType::Available) {
    [Console]::Error.WriteLine("Biometric/PIN not available: $availability")
    exit 2
}

$resultType = [Windows.Security.Credentials.UI.UserConsentVerificationResult]
$verifyOp = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${REASON.replace(/'/g, "''")}')
$result = AwaitOp $verifyOp $resultType

if ($result -eq $resultType::Verified) { exit 0 }
[Console]::Error.WriteLine("Verification failed: $result")
exit 1
`;
}

function runWindowsHello(executable: string): void {
  const proc = spawnSync(
    executable,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", windowsHelloScript()],
    { encoding: "utf8" },
  );

  if (proc.error) {
    throw new Error(
      `Could not launch ${executable} for biometric verification: ${proc.error.message}`,
    );
  }
  if (proc.status === 0) return;

  const stderr = (proc.stderr ?? "").trim();
  throw new Error(stderr || `Windows Hello verification failed (exit ${proc.status})`);
}

async function verifyWindows(): Promise<void> {
  runWindowsHello("powershell.exe");
}

/**
 * WSL path: WSL interop exposes powershell.exe on PATH by default, which
 * runs on the Windows host and can invoke Windows Hello normally.
 * Falls back to polkit if interop is disabled (rare).
 */
async function verifyWindowsHelloFromWsl(): Promise<void> {
  try {
    runWindowsHello("powershell.exe");
    return;
  } catch (e) {
    // If powershell.exe isn't available at all, fall through to polkit.
    // If it ran but failed (user cancelled, no biometric configured),
    // surface the error — don't silently downgrade to password auth.
    const msg = (e as Error).message ?? "";
    const interopMissing = msg.includes("ENOENT") || msg.includes("spawn");
    if (!interopMissing) throw e;
  }
  await verifyLinux();
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS — LocalAuthentication via inline swift script
// ─────────────────────────────────────────────────────────────────────────────

async function verifyMacOS(): Promise<void> {
  const swiftSrc = `
import LocalAuthentication
import Foundation

let ctx = LAContext()
ctx.localizedReason = ${JSON.stringify(`access your ${TITLE}`)}
var err: NSError?

// Prefer biometrics+password; fall back to password-only if Touch ID unavailable.
let policy: LAPolicy = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
    ? .deviceOwnerAuthenticationWithBiometrics
    : .deviceOwnerAuthentication

let sem = DispatchSemaphore(value: 0)
var success = false
var evalErr: Error?

ctx.evaluatePolicy(policy, localizedReason: ${JSON.stringify(REASON)}) { ok, e in
    success = ok
    evalErr = e
    sem.signal()
}
sem.wait()

if success {
    exit(0)
}
if let e = evalErr {
    FileHandle.standardError.write(Data("\\(e.localizedDescription)\\n".utf8))
}
exit(1)
`;

  const tmp = path.join(tmpdir(), `keypick-auth-${process.pid}-${Date.now()}.swift`);
  writeFileSync(tmp, swiftSrc);
  try {
    const proc = spawnSync("swift", [tmp], { encoding: "utf8" });
    if (proc.error) {
      throw new Error(
        `Could not launch \`swift\` for biometric verification: ${proc.error.message}. Install Xcode Command Line Tools with \`xcode-select --install\`.`,
      );
    }
    if (proc.status === 0) return;
    const stderr = (proc.stderr ?? "").trim();
    throw new Error(stderr || `Touch ID verification failed (exit ${proc.status})`);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Linux — polkit via pkexec
// ─────────────────────────────────────────────────────────────────────────────

async function verifyLinux(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("pkexec", ["/bin/true"], { stdio: "inherit" });

    proc.on("error", (err) => {
      reject(
        new Error(
          `Could not launch \`pkexec\` for authentication: ${err.message}. Install polkit (\`sudo apt install policykit-1\` or equivalent).`,
        ),
      );
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`polkit authentication failed (exit ${code ?? "?"})`));
    });
  });
}
