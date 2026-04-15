// Cross-platform biometric authentication.
// Windows → PowerShell + WinRT UserConsentVerifier
// macOS   → swift + LocalAuthentication
// Linux   → pkcheck (polkit)
// Stub — full implementation in task #4.

export async function verify(): Promise<void> {
  switch (process.platform) {
    case "win32":
      return verifyWindows();
    case "darwin":
      return verifyMacOS();
    case "linux":
      return verifyLinux();
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

async function verifyWindows(): Promise<void> {
  throw new Error("Windows biometric auth not yet implemented (task #4)");
}

async function verifyMacOS(): Promise<void> {
  throw new Error("macOS biometric auth not yet implemented (task #4)");
}

async function verifyLinux(): Promise<void> {
  throw new Error("Linux biometric auth not yet implemented (task #4)");
}
