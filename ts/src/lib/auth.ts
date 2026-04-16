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

/** PowerShell script that awaits WinRT's UserConsentVerifier. Runs on the host.
 *
 * Also starts a background STA thread that pulls the Hello/CredentialUI dialog
 * onto the current virtual desktop if CredentialUIBroker places it elsewhere
 * (common when the terminal and the broker's last session differ).
 */
function windowsHelloScript(): string {
  const reason = REASON.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'

Add-Type -Language CSharp @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class W {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("ole32.dll")] public static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);
    [DllImport("ole32.dll")] public static extern void CoUninitialize();
}

[ComImport]
[Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVirtualDesktopManager {
    [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr h, out int onCurrent);
    [PreserveSig] int GetWindowDesktopId(IntPtr h, out Guid desktopId);
    [PreserveSig] int MoveWindowToDesktop(IntPtr h, [MarshalAs(UnmanagedType.LPStruct)] Guid desktopId);
}

// Concrete wrapper so PowerShell can invoke instance methods directly;
// PS cannot dispatch against an IUnknown-only COM interface without this.
public class VDM {
    private IVirtualDesktopManager mgr;
    public VDM() {
        mgr = (IVirtualDesktopManager)Activator.CreateInstance(
            Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a"))
        );
    }
    public Guid GetWindowDesktopId(IntPtr h) {
        Guid g; int hr = mgr.GetWindowDesktopId(h, out g);
        if (hr != 0) throw new System.ComponentModel.Win32Exception(hr);
        return g;
    }
    public bool IsOnCurrent(IntPtr h) {
        int r; int hr = mgr.IsWindowOnCurrentVirtualDesktop(h, out r);
        if (hr != 0) throw new System.ComponentModel.Win32Exception(hr);
        return r != 0;
    }
    public void MoveTo(IntPtr h, Guid id) {
        int hr = mgr.MoveWindowToDesktop(h, id);
        if (hr != 0) throw new System.ComponentModel.Win32Exception(hr);
    }
}
"@ | Out-Null

# Capture the virtual desktop id of the user's terminal (current foreground).
$termHwnd = [W]::GetForegroundWindow()
$myDesktop = [Guid]::Empty
$canMove = $false
try {
    $vdm = [VDM]::new()
    $myDesktop = $vdm.GetWindowDesktopId($termHwnd)
    if ($myDesktop -ne [Guid]::Empty) { $canMove = $true }
} catch {}

# Background poller: for up to 10s, find the Hello dialog and move it to our
# desktop if CredentialUIBroker placed it elsewhere.
if ($canMove) {
    $poller = [System.Threading.Thread]::new([System.Threading.ParameterizedThreadStart]{
        param($target)
        [W]::CoInitializeEx([IntPtr]::Zero, 2) | Out-Null  # COINIT_APARTMENTTHREADED
        try {
            $vdm2 = [VDM]::new()
            $deadline = (Get-Date).AddSeconds(10)
            $seen = @{}
            while ((Get-Date) -lt $deadline) {
                $cb = [W+EnumWindowsProc]{
                    param($h, $l)
                    if (-not [W]::IsWindowVisible($h)) { return $true }
                    if ($seen.ContainsKey($h)) { return $true }
                    $cls = New-Object System.Text.StringBuilder 256
                    [W]::GetClassName($h, $cls, 256) | Out-Null
                    $c = $cls.ToString()
                    $ttl = New-Object System.Text.StringBuilder 256
                    [W]::GetWindowText($h, $ttl, 256) | Out-Null
                    $t = $ttl.ToString()
                    $isCandidate = ($c -eq 'Credential Dialog Xaml Host') -or
                                   (($c -eq 'ApplicationFrameWindow' -or $c -eq 'Windows.UI.Core.CoreWindow') -and
                                    ($t -match 'Windows Security|Windows Hello'))
                    if ($isCandidate) {
                        try {
                            if (-not $vdm2.IsOnCurrent($h)) {
                                $vdm2.MoveTo($h, $target)
                            }
                            [W]::SetForegroundWindow($h) | Out-Null
                        } catch {}
                        $seen[$h] = $true
                    }
                    return $true
                }
                [W]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
                Start-Sleep -Milliseconds 150
            }
        } finally {
            [W]::CoUninitialize()
        }
    })
    $poller.SetApartmentState([System.Threading.ApartmentState]::STA)
    $poller.IsBackground = $true
    $poller.Start($myDesktop)
}

# WinRT bootstrap
[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]

function AwaitOp($op, $resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
    $task.Wait() | Out-Null
    $task.Result
}

$availType = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability]
$availability = AwaitOp ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) $availType

if ($availability -ne $availType::Available) {
    [Console]::Error.WriteLine("Biometric/PIN not available: $availability")
    exit 2
}

$resultType = [Windows.Security.Credentials.UI.UserConsentVerificationResult]
$result = AwaitOp ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${reason}')) $resultType

if ($result -eq $resultType::Verified) { exit 0 }
[Console]::Error.WriteLine("Verification failed: $result")
exit 1
`;
}

function runWindowsHello(executable: string): void {
  // NOTE: do not pass -NonInteractive. On some Windows 11 builds it prevents
  // UserConsentVerifier's WinRT async from ever surfacing its GUI, hanging
  // the spawnSync call silently.
  const proc = spawnSync(
    executable,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsHelloScript()],
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
