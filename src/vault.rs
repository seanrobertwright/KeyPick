use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};

/// The in-memory representation of vault.yaml
///
/// Structure on disk (SOPS-encrypted YAML):
/// ```yaml
/// services:
///   Supabase_Prod:
///     DB_HOST: "db.supabase.co"
///     DB_PASSWORD: "secret"
///   Google_AI:
///     API_KEY: "gl-..."
/// ```
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct Vault {
    /// Top-level: Group/Service Name → (Key Name → Secret Value)
    pub services: BTreeMap<String, BTreeMap<String, String>>,
}

const VAULT_FILE: &str = "vault.yaml";

/// Decrypt vault.yaml via SOPS and deserialize into a Vault struct.
pub fn load() -> Vault {
    let output = Command::new("sops")
        .args(["-d", VAULT_FILE])
        .output()
        .unwrap_or_else(|_| {
            eprintln!(
                "ERROR: Could not run `sops`. Make sure sops.exe is in your PATH.\n\
                 Download: https://github.com/getsops/sops/releases"
            );
            std::process::exit(1);
        });

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("SOPS decryption failed:\n{}", stderr);
        eprintln!(
            "\nHint: Make sure your age private key is at:\n  \
             Windows: %AppData%\\sops\\age\\keys.txt\n  \
             macOS/Linux: ~/.config/sops/age/keys.txt"
        );
        std::process::exit(1);
    }

    serde_yaml::from_slice(&output.stdout).unwrap_or_default()
}

/// Serialize the Vault and encrypt it back to vault.yaml via SOPS.
pub fn save(vault: &Vault) {
    let yaml_data = serde_yaml::to_string(vault).expect("Failed to serialize vault");

    // Pipe unencrypted YAML into sops stdin → encrypted YAML out
    let mut child = Command::new("sops")
        .args([
            "--encrypt",
            "--input-type",
            "yaml",
            "--output-type",
            "yaml",
            "/dev/stdin",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|_| {
            eprintln!("ERROR: Could not spawn sops for encryption.");
            std::process::exit(1);
        });

    {
        let stdin = child.stdin.as_mut().expect("Failed to open sops stdin");
        stdin
            .write_all(yaml_data.as_bytes())
            .expect("Failed to write to sops stdin");
    }

    let output = child
        .wait_with_output()
        .expect("Failed to wait on sops process");

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("SOPS encryption failed:\n{}", stderr);
        std::process::exit(1);
    }

    std::fs::write(VAULT_FILE, &output.stdout).expect("Failed to write vault.yaml");
}

/// Format a group's keys as KEY=VALUE lines suitable for a .env file.
pub fn keys_to_env(keys: &BTreeMap<String, String>) -> String {
    keys.iter()
        .map(|(k, v)| format!("{}={}\n", k, v))
        .collect()
}

/// Format a group's keys as `export KEY='VALUE'` lines suitable for shell eval.
pub fn keys_to_exports(keys: &BTreeMap<String, String>) -> String {
    keys.iter()
        .map(|(k, v)| format!("export {}='{}'\n", k, v))
        .collect()
}
