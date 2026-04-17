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
 * Parents the Hello dialog to the user's terminal window via
 * IUserConsentVerifierInterop::RequestVerificationForWindowAsync. Without a
 * parent HWND, CredentialUIBroker may place the dialog on whichever virtual
 * desktop it last used — stranding the user's terminal on a different desktop
 * while the prompt waits invisibly elsewhere.
 *
 * We previously tried to chase the dialog after the fact with
 * IVirtualDesktopManager::MoveWindowToDesktop, but that API only moves
 * windows owned by the calling process — the Hello dialog belongs to
 * CredentialUIBroker.exe, so the call always failed silently with
 * E_ACCESSDENIED. Parenting at creation is the correct fix.
 */
function windowsHelloScript(): string {
  const reason = REASON.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
function Step($m) { [Console]::Error.WriteLine("[keypick-auth] $m") }

try {

Step 'add-type:interop'
Add-Type -Language CSharp @"
using System;
using System.Runtime.InteropServices;

public static class W {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    public const uint GA_ROOTOWNER = 3;
}

// Direct vtable invocation for IUserConsentVerifierInterop. We can't cast the
// activation factory to a [ComImport] interop interface via -as in PowerShell:
// .NET Framework's WinRT projection layer wraps the factory and hides its
// non-projected interfaces from managed casts, even though QueryInterface at
// the raw-IUnknown level succeeds. So we reach past the projection by reading
// the vtable slot and calling the function pointer directly.
public static class Direct {
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int RequestDelegate(
        IntPtr thisPtr,
        IntPtr appWindow,
        IntPtr messageHString,
        ref Guid riid,
        out IntPtr asyncOperation);

    [DllImport("combase.dll", PreserveSig = true)]
    static extern int WindowsCreateString(
        [MarshalAs(UnmanagedType.LPWStr)] string src, uint length, out IntPtr hstring);

    [DllImport("combase.dll", PreserveSig = true)]
    static extern int WindowsDeleteString(IntPtr hstring);

    // Invokes IUserConsentVerifierInterop::RequestVerificationForWindowAsync.
    // interopPtr: a raw IUnknown* already QI'd to IUserConsentVerifierInterop.
    // Returns a raw pointer to the returned IAsyncOperation (caller releases).
    // Slot 6 = IUnknown(0-2) + IInspectable(3-5) + our method at 6.
    public static IntPtr Call(IntPtr interopPtr, IntPtr hwnd, string message, Guid asyncOpIid) {
        IntPtr hstring;
        int hrCreate = WindowsCreateString(message, (uint)message.Length, out hstring);
        if (hrCreate != 0) throw new System.ComponentModel.Win32Exception(hrCreate, "WindowsCreateString");
        try {
            IntPtr vtbl = Marshal.ReadIntPtr(interopPtr);
            IntPtr method = Marshal.ReadIntPtr(vtbl, 6 * IntPtr.Size);
            RequestDelegate del = (RequestDelegate)Marshal.GetDelegateForFunctionPointer(method, typeof(RequestDelegate));
            IntPtr asyncOp;
            int hr = del(interopPtr, hwnd, hstring, ref asyncOpIid, out asyncOp);
            if (hr != 0) throw new System.ComponentModel.Win32Exception(hr, "RequestVerificationForWindowAsync");
            return asyncOp;
        } finally {
            WindowsDeleteString(hstring);
        }
    }
}
"@ | Out-Null

Step 'winrt:load-types'
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

Step 'availability:check'
$availType = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability]
$availability = AwaitOp ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) $availType
Step "availability:$availability"

if ($availability -ne $availType::Available) {
    [Console]::Error.WriteLine("Biometric/PIN not available: $availability")
    exit 2
}

# Find the terminal's root-owner HWND. For Windows Terminal (and other
# tabbed hosts), the foreground HWND may be a child; GA_ROOTOWNER walks up
# to the window that can legitimately parent a modal.
$fg = [W]::GetForegroundWindow()
$parent = [W]::GetAncestor($fg, [W]::GA_ROOTOWNER)
if ($parent -eq [IntPtr]::Zero) { $parent = $fg }
Step "hwnd:fg=$fg parent=$parent"

# Get the activation factory, QI for the interop interface, and invoke the
# window-scoped request via direct vtable call (see Direct class above for
# why a managed cast won't work). The async-op IID is derived at runtime
# via WinRT's parameterized-generic projection.
Step 'interop:get-factory'
$resultType = [Windows.Security.Credentials.UI.UserConsentVerificationResult]
$asyncOpType = [Windows.Foundation.IAsyncOperation\`1].MakeGenericType($resultType)
$iid = $asyncOpType.GUID
Step "interop:iid=$iid"

$factory = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal]::GetActivationFactory(
    [Windows.Security.Credentials.UI.UserConsentVerifier]
)
Step "interop:factory=$($factory.GetType().FullName)"

# QI the factory for IUserConsentVerifierInterop at the raw-IUnknown level.
# The CLR projection wrapper won't let us cast to it directly, so we work
# with the raw pointer returned by QueryInterface.
$factoryUnk = [System.Runtime.InteropServices.Marshal]::GetIUnknownForObject($factory)
try {
    $iidInterop = [Guid]'39E050C3-4E74-441A-8DC0-B81104DF949C'
    $ppv = [IntPtr]::Zero
    $hr = [System.Runtime.InteropServices.Marshal]::QueryInterface($factoryUnk, [ref]$iidInterop, [ref]$ppv)
    Step ("interop:QI hr=0x{0:X8} ppv={1}" -f $hr, $ppv)
    if ($hr -ne 0 -or $ppv -eq [IntPtr]::Zero) {
        [Console]::Error.WriteLine("QueryInterface for IUserConsentVerifierInterop failed: HRESULT 0x$('{0:X8}' -f $hr)")
        exit 3
    }

    try {
        Step 'interop:call'
        $opPtr = [Direct]::Call($ppv, $parent, '${reason}', $iid)
    } finally {
        [System.Runtime.InteropServices.Marshal]::Release($ppv) | Out-Null
    }
} finally {
    [System.Runtime.InteropServices.Marshal]::Release($factoryUnk) | Out-Null
}

Step "interop:async-op-ptr=$opPtr"
$op = [System.Runtime.InteropServices.Marshal]::GetObjectForIUnknown($opPtr)
[System.Runtime.InteropServices.Marshal]::Release($opPtr) | Out-Null

try {
    Step 'interop:await'
    $result = AwaitOp $op $resultType
    Step "result:$result"
} finally {
    # Restore focus to the terminal. After CredentialUIBroker's dialog closes,
    # Windows picks whichever window it wants as the new foreground — often not
    # our terminal. SetForegroundWindow is blocked for background processes by
    # the foreground lock; SwitchToThisWindow bypasses that.
    if ($parent -ne [IntPtr]::Zero) {
        try { [W]::SwitchToThisWindow($parent, $true) } catch {}
    }
}

if ($result -eq $resultType::Verified) { exit 0 }
[Console]::Error.WriteLine("Verification failed: $result")
exit 1

} catch {
    [Console]::Error.WriteLine("[keypick-auth][fatal] $($_.Exception.GetType().FullName): $($_.Exception.Message)")
    [Console]::Error.WriteLine($_.ScriptStackTrace)
    exit 9
}
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
