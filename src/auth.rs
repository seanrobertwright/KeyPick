use robius_authentication::{
    AndroidText, BiometricStrength, Context, PolicyBuilder, Text, WindowsText,
};

/// Trigger a cross-platform biometric prompt.
/// - Windows  → Windows Hello (fingerprint / face / PIN)
/// - macOS    → Touch ID / Face ID
/// - Linux    → polkit (desktop environment prompt)
pub fn verify() -> Result<(), String> {
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
