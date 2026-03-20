use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use inquire::Select;

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
const SOPS_FILE: &str = ".sops.yaml";
const APP_DIR: &str = "keypick";
const VAULTS_DIR: &str = "vaults";
const ACTIVE_VAULT_FILE: &str = "active_vault.txt";

fn is_vault_dir(path: &Path) -> bool {
    path.join(VAULT_FILE).exists() && path.join(SOPS_FILE).exists()
}

fn debug_vault_enabled() -> bool {
    env::var("KEYPICK_DEBUG_VAULT").ok().as_deref() == Some("1")
}

fn debug_vault(message: impl AsRef<str>) {
    if debug_vault_enabled() {
        eprintln!("[keypick] {}", message.as_ref());
    }
}

fn app_config_dir() -> PathBuf {
    if let Ok(dir) = env::var("KEYPICK_HOME") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    if let Some(home) = dirs::home_dir() {
        home.join(format!(".{}", APP_DIR))
    } else {
        PathBuf::from(".").join(APP_DIR)
    }
}

pub fn vaults_home_dir() -> PathBuf {
    app_config_dir().join(VAULTS_DIR)
}

fn active_vault_file() -> PathBuf {
    app_config_dir().join(ACTIVE_VAULT_FILE)
}

fn local_age_public_key() -> Option<String> {
    let key_path = if cfg!(windows) {
        dirs::config_dir()?.join("sops").join("age").join("keys.txt")
    } else {
        dirs::home_dir()?
            .join(".config")
            .join("sops")
            .join("age")
            .join("keys.txt")
    };

    let content = std::fs::read_to_string(key_path).ok()?;
    content
        .lines()
        .find_map(|line| line.strip_prefix("# public key: ").map(|value| value.trim().to_string()))
}

fn vault_allows_local_key(path: &Path, local_key: &str) -> bool {
    std::fs::read_to_string(path.join(SOPS_FILE))
        .map(|content| content.contains(local_key))
        .unwrap_or(false)
}

fn remember_vault_dir_inner(path: &Path) -> Result<(), String> {
    let config_dir = app_config_dir();
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!(
            "Failed to create {}: {}. Set KEYPICK_HOME to a writable directory if needed.",
            config_dir.display(),
            e
        ))?;
    std::fs::write(active_vault_file(), path.display().to_string())
        .map_err(|e| format!(
            "Failed to save active vault in {}: {}. Set KEYPICK_HOME to a writable directory if needed.",
            config_dir.display(),
            e
        ))
}

pub fn remember_vault_dir(path: &Path) -> Result<(), String> {
    remember_vault_dir_inner(path)
}

fn remembered_vault_dir() -> Option<PathBuf> {
    let path = active_vault_file();
    let content = std::fs::read_to_string(path).ok()?;
    let candidate = PathBuf::from(content.trim());
    if is_vault_dir(&candidate) {
        Some(candidate)
    } else {
        None
    }
}

pub fn current_vault_dir() -> Option<PathBuf> {
    if let Ok(dir) = env::var("KEYPICK_VAULT_DIR") {
        let path = PathBuf::from(dir);
        if is_vault_dir(&path) {
            return Some(path);
        }
    }

    if let Some(path) = discover_in_ancestors() {
        return Some(path);
    }

    remembered_vault_dir()
}

pub fn list_known_vaults() -> Vec<PathBuf> {
    let mut vaults = Vec::new();

    if let Some(current) = current_vault_dir() {
        vaults.push(current);
    }

    let vault_home = vaults_home_dir();
    if vault_home.exists() {
        if let Ok(children) = discover_child_vaults(&vault_home, "KeyPick vault home") {
            for child in children {
                if !vaults.contains(&child) {
                    vaults.push(child);
                }
            }
        }
    }

    if let Ok(cwd) = env::current_dir() {
        if let Ok(children) = discover_child_vaults(&cwd, "current directory") {
            for child in children {
                if !vaults.contains(&child) {
                    vaults.push(child);
                }
            }
        }
    }

    vaults
}

pub fn select_known_vault_interactively() -> Result<PathBuf, String> {
    let vaults = list_known_vaults();
    if vaults.is_empty() {
        return Err(format!(
            "No KeyPick vaults were found under {}.",
            vaults_home_dir().display()
        ));
    }

    if vaults.len() == 1 {
        remember_vault_dir(&vaults[0])?;
        return Ok(vaults[0].clone());
    }

    choose_vault_interactively(vaults, "known vaults")
        .and_then(|result| result.ok_or_else(|| "Vault selection cancelled.".to_string()))
        .and_then(|path| {
            remember_vault_dir(&path)?;
            Ok(path)
        })
}

fn discover_in_ancestors() -> Option<PathBuf> {
    let cwd = env::current_dir().ok()?;
    debug_vault(format!("cwd for ancestor scan: {}", cwd.display()));

    for dir in cwd.ancestors() {
        debug_vault(format!("checking ancestor: {}", dir.display()));
        if is_vault_dir(dir) {
            debug_vault(format!("selected ancestor vault: {}", dir.display()));
            return Some(dir.to_path_buf());
        }
    }

    None
}

fn discover_child_vaults(base: &Path, label: &str) -> Result<Vec<PathBuf>, String> {
    debug_vault(format!("scanning {} for child vaults: {}", label, base.display()));
    let entries = std::fs::read_dir(base)
        .map_err(|e| format!("Failed to scan {} for vault repos: {}", base.display(), e))?;

    let mut candidates = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && is_vault_dir(&path) {
            debug_vault(format!("found child vault candidate: {}", path.display()));
            candidates.push(path);
        }
    }

    candidates.sort();
    Ok(candidates)
}

fn select_from_candidates(candidates: Vec<PathBuf>, source: &str) -> Result<Option<PathBuf>, String> {
    match candidates.len() {
        0 => Ok(None),
        1 => Ok(candidates.into_iter().next()),
        _ => {
            if let Some(local_key) = local_age_public_key() {
                debug_vault(format!("matching child vaults against local key: {}", local_key));
                let matching = candidates
                    .iter()
                    .filter(|path| vault_allows_local_key(path, &local_key))
                    .cloned()
                    .collect::<Vec<_>>();

                debug_vault(format!(
                    "child vaults matching local key: {}",
                    if matching.is_empty() {
                        "<none>".to_string()
                    } else {
                        matching
                            .iter()
                            .map(|p| p.display().to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    }
                ));

                if matching.len() == 1 {
                    debug_vault(format!(
                        "selected child vault by local key match: {}",
                        matching[0].display()
                    ));
                    return Ok(matching.into_iter().next());
                }

                if matching.len() > 1 {
                    return choose_vault_interactively(matching, source);
                }
            }

            choose_vault_interactively(candidates, source)
        }
    }
}

fn choose_vault_interactively(candidates: Vec<PathBuf>, source: &str) -> Result<Option<PathBuf>, String> {
    let options = candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>();
    let prompt = format!("Select a KeyPick vault from {}:", source);

    let selected = Select::new(&prompt, options).prompt().map_err(|_| {
        format!(
            "Multiple vault repositories are available. Re-run interactively, run inside the vault repo you want, or set KEYPICK_VAULT_DIR."
        )
    })?;

    Ok(Some(PathBuf::from(selected)))
}

fn resolve_vault_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = env::var("KEYPICK_VAULT_DIR") {
        let path = PathBuf::from(dir);
        debug_vault(format!("KEYPICK_VAULT_DIR is set: {}", path.display()));
        if is_vault_dir(&path) {
            return Ok(path);
        }
        return Err(format!(
            "KEYPICK_VAULT_DIR is set to {}, but that directory does not contain both {} and {}.",
            path.display(),
            VAULT_FILE,
            SOPS_FILE
        ));
    }

    if let Some(path) = discover_in_ancestors() {
        return Ok(path);
    }

    if let Some(path) = remembered_vault_dir() {
        debug_vault(format!("using remembered vault: {}", path.display()));
        return Ok(path);
    }

    let vault_home = vaults_home_dir();
    if vault_home.exists() {
        if let Some(path) = select_from_candidates(discover_child_vaults(&vault_home, "KeyPick vault home")?, "KeyPick vault home")? {
            return Ok(path);
        }
    }

    let cwd = env::current_dir()
        .map_err(|e| format!("Failed to read current directory: {}", e))?;
    if let Some(path) = select_from_candidates(discover_child_vaults(&cwd, "current directory")?, "current directory")? {
        return Ok(path);
    }

    Err(format!(
        "Could not find a vault repository.\n\nLooked in:\n  - current directory and its parents\n  - remembered KeyPick vault\n  - {}\n  - direct child directories of {}\n\nSet KEYPICK_VAULT_DIR if your vault lives elsewhere, or run `keypick setup` to create one under the default vault home.",
        vault_home.display(),
        env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "<unknown directory>".to_string())
    ))
}

fn vault_file_path() -> PathBuf {
    let resolved = resolve_vault_dir()
        .unwrap_or_else(|message| {
            eprintln!("{}", message);
            crate::terminal::cleanup_and_exit(1);
        });

    if debug_vault_enabled() {
        let local_key = local_age_public_key().unwrap_or_else(|| "<not found>".to_string());
        eprintln!(
            "[keypick] resolved vault dir: {}\n[keypick] local age public key: {}",
            resolved.display(),
            local_key
        );
    }

    let _ = remember_vault_dir(&resolved);
    resolved.join(VAULT_FILE)
}

pub fn vault_dir() -> PathBuf {
    let resolved = resolve_vault_dir().unwrap_or_else(|message| {
        eprintln!("{}", message);
        crate::terminal::cleanup_and_exit(1);
    });
    let _ = remember_vault_dir(&resolved);
    resolved
}

pub fn default_vault_dir(name: &str) -> PathBuf {
    vaults_home_dir().join(name)
}

/// Decrypt vault.yaml via SOPS and deserialize into a Vault struct.
pub fn load() -> Vault {
    let vault_file = vault_file_path();
    let output = Command::new("sops")
        .arg("-d")
        .arg(&vault_file)
        .output()
        .unwrap_or_else(|_| {
            eprintln!(
                "ERROR: Could not run `sops`. Make sure sops.exe is in your PATH.\n\
                 Download: https://github.com/getsops/sops/releases"
            );
            crate::terminal::cleanup_and_exit(1);
        });

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("SOPS decryption failed:\n{}", stderr);
        eprintln!(
            "\nHint: Make sure your age private key is at:\n  \
             Windows: %AppData%\\sops\\age\\keys.txt\n  \
             macOS/Linux: ~/.config/sops/age/keys.txt"
        );
        crate::terminal::cleanup_and_exit(1);
    }

    serde_yaml::from_slice(&output.stdout).unwrap_or_default()
}

/// Serialize the Vault and encrypt it back to vault.yaml via SOPS.
pub fn save(vault: &Vault) {
    let vault_dir = vault_dir();
    let vault_file = vault_dir.join(VAULT_FILE);
    let yaml_data = serde_yaml::to_string(vault).expect("Failed to serialize vault");

    // Pipe unencrypted YAML into sops stdin → encrypted YAML out
    let mut child = Command::new("sops")
        .args([
            "--encrypt",
            "--input-type",
            "yaml",
            "--output-type",
            "yaml",
            "--filename-override",
            VAULT_FILE,
            "/dev/stdin",
        ])
        .current_dir(&vault_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|_| {
            eprintln!("ERROR: Could not spawn sops for encryption.");
            crate::terminal::cleanup_and_exit(1);
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
        crate::terminal::cleanup_and_exit(1);
    }

    std::fs::write(&vault_file, &output.stdout).expect("Failed to write vault.yaml");
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
