use robius_authentication::{
    AndroidText, BiometricStrength, Context, PolicyBuilder, Text, WindowsText,
};

/// Trigger a cross-platform biometric prompt.
/// - Windows  → Windows Hello (fingerprint / face / PIN)
/// - macOS    → Touch ID / Face ID
/// - WSL      → Windows Hello on the host via powershell.exe (WSL interop)
/// - Linux    → polkit (desktop environment prompt)
pub fn verify() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if is_wsl() {
            return verify_windows_hello_from_wsl();
        }
    }

    // build() returns Option<Policy>, not Result
    let policy = PolicyBuilder::new()
        .biometrics(Some(BiometricStrength::Strong))
        .password(true)
        .build()
        .ok_or_else(|| "Failed to construct authentication policy".to_string())?;

    let text = Text {
        android: AndroidText {
            title: "KeyPick Vault",
            subtitle: Some("Verify your identity to access API keys"),
            description: None,
        },
        apple: "access your KeyPick API Vault",
        // WindowsText::new returns Option<WindowsText>; safe to unwrap with a static string
        windows: WindowsText::new("KeyPick Vault", "Verify your identity to access API keys")
            .expect("WindowsText::new should succeed with literal strings"),
    };

    // Use {:?} because robius_authentication::Error doesn't implement Display
    Context::new(())
        .blocking_authenticate(text, &policy)
        .map_err(|e| format!("{:?}", e))
}

// ─────────────────────────────────────────────────────────────────────────────
// WSL detection + Windows Hello bridge
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn is_wsl() -> bool {
    // Canonical signals: WSL_DISTRO_NAME / WSL_INTEROP env vars, or
    // "microsoft"/"WSL" substrings in /proc/version.
    if std::env::var("WSL_DISTRO_NAME").is_ok() || std::env::var("WSL_INTEROP").is_ok() {
        return true;
    }
    if let Ok(v) = std::fs::read_to_string("/proc/version") {
        let lower = v.to_lowercase();
        return lower.contains("microsoft") || lower.contains("wsl");
    }
    false
}

/// Invoke powershell.exe on the Windows host to trigger Windows Hello.
/// WSL puts powershell.exe on PATH automatically via interop.
#[cfg(target_os = "linux")]
fn verify_windows_hello_from_wsl() -> Result<(), String> {
    use std::process::Command;

    let script = windows_hello_script();
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .output()
        .map_err(|e| {
            format!(
                "Could not launch powershell.exe for biometric verification: {}.\n\
                 WSL interop may be disabled. Enable it in /etc/wsl.conf or use a distro with interop on.",
                e
            )
        })?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!(
            "Windows Hello verification failed (exit {:?})",
            output.status.code()
        ))
    } else {
        Err(stderr)
    }
}

#[cfg(target_os = "linux")]
fn windows_hello_script() -> String {
    // Same WinRT UserConsentVerifier flow as ts/src/lib/auth.ts.
    // Kept identical so behaviour matches across implementations.
    r#"
$ErrorActionPreference = 'Stop'
[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
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
$verifyOp = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('Verify your identity to access API keys')
$result = AwaitOp $verifyOp $resultType

if ($result -eq $resultType::Verified) { exit 0 }
[Console]::Error.WriteLine("Verification failed: $result")
exit 1
"#
    .to_string()
}
