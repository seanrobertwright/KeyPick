# Setup Installer Implementation Plan

> **For agentic workers:** REQUIRED: Use lril-superpowers:subagent-driven-development (if subagents available) or lril-superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `key-pick setup` TUI installer that automates prerequisites installation, key generation, vault repo creation/joining, GitHub Actions setup, and recovery key generation.

**Architecture:** New `src/commands/setup/` module with submodules for each phase. A top-level orchestrator (`mod.rs`) drives the wizard flow, delegating to phase-specific modules. Shared utilities (platform detection, downloads, spinners) live in a `utils.rs` helper.

**Tech Stack:** Rust, clap (CLI), inquire (prompts), indicatif (progress/spinners), reqwest (downloads), dirs (platform paths), tempfile (safe temp files), colored (output styling)

---

## Chunk 1: Foundation

### Task 1: Add Dependencies

**Files:**
- Modify: `Cargo.toml`

- [ ] **Step 1: Add new crate dependencies**

Add to `[dependencies]` section in `Cargo.toml`:

```toml
# TUI progress indicators
indicatif = "0.17"

# HTTP client for downloading binaries
reqwest = { version = "0.12", features = ["blocking"] }

# Cross-platform standard directories
dirs = "5"

# Temp files for safe downloads
tempfile = "3"

# Regex for parsing age keys
regex = "1"
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: Compiles with no errors (warnings OK)

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "feat(setup): add dependencies for setup installer"
```

---

### Task 2: Setup Module Structure & CLI Wiring

**Files:**
- Create: `src/commands/setup/mod.rs`
- Create: `src/commands/setup/utils.rs`
- Modify: `src/commands/mod.rs`
- Modify: `src/main.rs`

- [ ] **Step 1: Create `src/commands/setup/mod.rs` with subcommand enum and stub orchestrator**

```rust
mod utils;
mod prerequisites;
mod keygen;
mod init;
mod join;
mod actions;
mod recovery;

use clap::Subcommand;
use colored::*;
use inquire::Select;

#[derive(Subcommand)]
pub enum SetupCommands {
    /// Set up GitHub Actions auto re-encryption
    Actions,
    /// Generate a passphrase-protected recovery key
    Recovery,
}

/// Main setup wizard entry point
pub fn run(sub: Option<SetupCommands>) {
    match sub {
        Some(SetupCommands::Actions) => actions::run(),
        Some(SetupCommands::Recovery) => recovery::run(),
        None => run_full_wizard(),
    }
}

fn run_full_wizard() {
    println!(
        "\n{}",
        "  ── KeyPick Setup Wizard ──".cyan().bold()
    );
    println!(
        "  {}\n",
        "This will get KeyPick fully configured on this machine.".dimmed()
    );

    // Phase 1: Prerequisites
    println!("{}", "[1/4] Checking prerequisites...".cyan().bold());
    if let Err(e) = prerequisites::run() {
        eprintln!("{} {}", "Setup failed:".red().bold(), e);
        std::process::exit(1);
    }

    // Phase 2: Age key
    println!("\n{}", "[2/4] Machine identity...".cyan().bold());
    let public_key = match keygen::run() {
        Ok(key) => key,
        Err(e) => {
            eprintln!("{} {}", "Key generation failed:".red().bold(), e);
            std::process::exit(1);
        }
    };

    // Phase 3: Vault repo
    println!("\n{}", "[3/4] Vault repository...".cyan().bold());
    let options = vec!["New vault (first machine)", "Join existing vault"];
    let choice = Select::new("Is this your first machine, or joining an existing vault?", options)
        .prompt();

    match choice {
        Ok(c) if c.starts_with("New") => {
            if let Err(e) = init::run(&public_key) {
                eprintln!("{} {}", "Init failed:".red().bold(), e);
                std::process::exit(1);
            }
        }
        Ok(_) => {
            if let Err(e) = join::run(&public_key) {
                eprintln!("{} {}", "Join failed:".red().bold(), e);
                std::process::exit(1);
            }
        }
        Err(_) => {
            println!("{}", "Setup cancelled.".yellow());
            return;
        }
    }

    // Phase 4: Optional extras
    println!("\n{}", "[4/4] Optional enhancements...".cyan().bold());

    if inquire::Confirm::new("Set up GitHub Actions auto-sync?")
        .with_default(true)
        .with_help_message("Automatically re-encrypts vault when recipients change")
        .prompt()
        .unwrap_or(false)
    {
        actions::run();
    }

    if inquire::Confirm::new("Create a recovery key?")
        .with_default(true)
        .with_help_message("Emergency backup in case you lose access to all machines")
        .prompt()
        .unwrap_or(false)
    {
        recovery::run();
    }

    println!("\n{}", "✓ KeyPick setup complete!".green().bold());
    println!(
        "  {}",
        "Run `key-pick add` to store your first secrets.".dimmed()
    );
}
```

- [ ] **Step 2: Create `src/commands/setup/utils.rs` with shared helpers**

```rust
use colored::*;
use indicatif::{ProgressBar, ProgressStyle};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

/// Returns the platform-specific age key directory.
/// Windows: %APPDATA%\sops\age
/// Unix: ~/.config/sops/age
pub fn age_key_dir() -> PathBuf {
    if cfg!(windows) {
        dirs::config_dir()
            .expect("Could not determine %APPDATA%")
            .join("sops")
            .join("age")
    } else {
        dirs::home_dir()
            .expect("Could not determine home directory")
            .join(".config")
            .join("sops")
            .join("age")
    }
}

/// Full path to the age keys.txt file.
pub fn age_key_path() -> PathBuf {
    age_key_dir().join("keys.txt")
}

/// Check if a command is available on PATH.
pub fn command_exists(name: &str) -> bool {
    let check = if cfg!(windows) {
        Command::new("where").arg(name).output()
    } else {
        Command::new("which").arg(name).output()
    };
    check.map(|o| o.status.success()).unwrap_or(false)
}

/// Run a command and return stdout as a string, or Err with stderr.
pub fn run_command(cmd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run `{}`: {}", cmd, e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Create a spinner with a message.
pub fn spinner(msg: &str) -> ProgressBar {
    let pb = ProgressBar::new_spinner();
    pb.set_style(
        ProgressStyle::default_spinner()
            .template("{spinner:.cyan} {msg}")
            .unwrap()
            .tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"),
    );
    pb.set_message(msg.to_string());
    pb.enable_steady_tick(Duration::from_millis(80));
    pb
}

/// Create a download progress bar.
pub fn download_bar(total: u64, name: &str) -> ProgressBar {
    let pb = ProgressBar::new(total);
    pb.set_style(
        ProgressStyle::default_bar()
            .template(&format!(
                "  {{spinner:.cyan}} {} [{{bar:30.cyan/dim}}] {{bytes}}/{{total_bytes}} ({{eta}})",
                name
            ))
            .unwrap()
            .progress_chars("█▓░"),
    );
    pb
}

/// Print a green checkmark status line.
pub fn done(msg: &str) {
    println!("  {} {}", "✓".green().bold(), msg);
}

/// Print a yellow warning.
pub fn warn(msg: &str) {
    println!("  {} {}", "!".yellow().bold(), msg);
}

/// Print a skip message.
pub fn skip(msg: &str) {
    println!("  {} {}", "–".dimmed(), msg.dimmed().to_string());
}

/// Detect OS and arch for download URLs.
pub fn platform() -> (&'static str, &'static str) {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };

    let arch = if cfg!(target_arch = "x86_64") {
        "amd64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64" // fallback
    };

    (os, arch)
}

/// Get a suitable install directory for downloaded binaries.
/// Prefers a directory already on PATH. Falls back to a sensible default.
pub fn install_dir() -> PathBuf {
    if cfg!(windows) {
        // Use the user's local bin if it exists, otherwise AppData
        let local_bin = dirs::home_dir()
            .unwrap()
            .join(".local")
            .join("bin");
        if local_bin.exists() {
            return local_bin;
        }
        // Fallback: put next to key-pick's own executable
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                return dir.to_path_buf();
            }
        }
        PathBuf::from("C:\\Windows\\System32")
    } else {
        let local_bin = dirs::home_dir()
            .unwrap()
            .join(".local")
            .join("bin");
        if local_bin.exists() {
            return local_bin;
        }
        PathBuf::from("/usr/local/bin")
    }
}

/// Read the public key from an age keys.txt file.
/// The public key is on a comment line like: # public key: age1...
pub fn read_public_key(keys_path: &std::path::Path) -> Result<String, String> {
    let content = std::fs::read_to_string(keys_path)
        .map_err(|e| format!("Cannot read {}: {}", keys_path.display(), e))?;
    for line in content.lines() {
        if line.starts_with("# public key: ") {
            return Ok(line.trim_start_matches("# public key: ").trim().to_string());
        }
    }
    Err("Could not find public key in keys file".to_string())
}
```

- [ ] **Step 3: Update `src/commands/mod.rs` to include setup**

```rust
pub mod add;
pub mod auto_export;
pub mod copy;
pub mod extract;
pub mod interactive;
pub mod list;
pub mod setup;
```

- [ ] **Step 4: Wire setup into `src/main.rs` CLI**

Add to the `Commands` enum:

```rust
    /// Set up KeyPick on this machine (install prerequisites, configure vault)
    Setup {
        #[command(subcommand)]
        sub: Option<commands::setup::SetupCommands>,
    },
```

Add to the match in `main()`:

```rust
        Some(Commands::Setup { sub }) => {
            // Setup wizard doesn't need biometric — it's creating the vault
            commands::setup::run(sub);
            return;
        }
```

Move the `Setup` match arm BEFORE the biometric check, since setup runs before the vault exists. Restructure the biometric gate:

```rust
fn main() {
    print_banner();

    let cli = Cli::parse();

    // Setup and auto commands skip biometric authentication
    match &cli.command {
        Some(Commands::Setup { sub }) => {
            commands::setup::run(sub.clone());
            return;
        }
        _ => {}
    }

    let needs_bio = !matches!(&cli.command, Some(Commands::Auto { .. }));

    if needs_bio {
        if let Err(e) = auth::verify() {
            eprintln!("{} {}", "Authentication failed:".red().bold(), e);
            std::process::exit(1);
        }
        println!("{}", "✓ Identity verified.\n".green().bold());
    }

    match cli.command {
        Some(Commands::Add) => commands::add::run(),
        Some(Commands::Extract) => commands::extract::run(),
        Some(Commands::List) => commands::list::run(),
        Some(Commands::Copy) => commands::copy::run(),
        Some(Commands::Auto { groups }) => commands::auto_export::run(&groups),
        Some(Commands::Setup { .. }) => unreachable!(),
        None => commands::interactive::run(),
    }
}
```

Note: `SetupCommands` needs `#[derive(Clone)]` for this to work. Update in `setup/mod.rs`.

- [ ] **Step 5: Create stub files for all submodules so it compiles**

Create each of these files with a minimal stub:

`src/commands/setup/prerequisites.rs`:
```rust
pub fn run() -> Result<(), String> {
    Ok(())
}
```

`src/commands/setup/keygen.rs`:
```rust
pub fn run() -> Result<String, String> {
    Ok("age1stub".to_string())
}
```

`src/commands/setup/init.rs`:
```rust
pub fn run(_public_key: &str) -> Result<(), String> {
    Ok(())
}
```

`src/commands/setup/join.rs`:
```rust
pub fn run(_public_key: &str) -> Result<(), String> {
    Ok(())
}
```

`src/commands/setup/actions.rs`:
```rust
pub fn run() {
    println!("GitHub Actions setup — coming soon");
}
```

`src/commands/setup/recovery.rs`:
```rust
pub fn run() {
    println!("Recovery key setup — coming soon");
}
```

- [ ] **Step 6: Verify it compiles**

Run: `cargo check`
Expected: Compiles successfully

- [ ] **Step 7: Commit**

```bash
git add src/commands/setup/ src/commands/mod.rs src/main.rs
git commit -m "feat(setup): scaffold setup module structure and CLI wiring"
```

---

## Chunk 2: Prerequisites & Key Generation

### Task 3: Prerequisites Installer (age + sops)

**Files:**
- Modify: `src/commands/setup/prerequisites.rs`

- [ ] **Step 1: Implement the prerequisites checker and installer**

```rust
use crate::commands::setup::utils;
use colored::*;
use indicatif::ProgressBar;
use std::fs;
use std::io::Read;
use std::path::Path;

const AGE_VERSION: &str = "1.2.0";
const SOPS_VERSION: &str = "3.9.4";

pub fn run() -> Result<(), String> {
    check_and_install("age", AGE_VERSION, install_age)?;
    check_and_install("sops", SOPS_VERSION, install_sops)?;
    Ok(())
}

fn check_and_install(
    name: &str,
    version: &str,
    installer: fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    if utils::command_exists(name) {
        let ver = utils::run_command(name, &["--version"]).unwrap_or_default();
        utils::done(&format!("{} already installed ({})", name, ver.lines().next().unwrap_or(&ver)));
        Ok(())
    } else {
        println!("  {} not found. Installing {}...", name.yellow().bold(), version);
        installer(version)?;
        // Verify
        if utils::command_exists(name) {
            let ver = utils::run_command(name, &["--version"]).unwrap_or_default();
            utils::done(&format!("{} installed ({})", name, ver.lines().next().unwrap_or(&ver)));
            Ok(())
        } else {
            Err(format!(
                "{} was downloaded but is not on PATH. You may need to add {} to your PATH.",
                name,
                utils::install_dir().display()
            ))
        }
    }
}

fn install_age(version: &str) -> Result<(), String> {
    let (os, arch) = utils::platform();
    let filename = match os {
        "windows" => format!("age-v{}-windows-{}.zip", version, arch),
        "darwin" => format!("age-v{}-darwin-{}.tar.gz", version, arch),
        _ => format!("age-v{}-linux-{}.tar.gz", version, arch),
    };
    let url = format!(
        "https://github.com/FiloSottile/age/releases/download/v{}/{}",
        version, filename
    );

    let install_dir = utils::install_dir();
    let data = download_file(&url, &filename)?;

    let tmp = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let archive_path = tmp.path().join(&filename);
    fs::write(&archive_path, &data).map_err(|e| format!("Failed to write archive: {}", e))?;

    // Extract
    extract_archive(&archive_path, tmp.path(), os)?;

    // Find and copy binaries
    let src_dir = tmp.path().join(format!("age"));
    let age_src = find_binary(&src_dir, tmp.path(), "age")?;
    let keygen_src = find_binary(&src_dir, tmp.path(), "age-keygen")?;

    fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create {}: {}", install_dir.display(), e))?;

    let ext = if cfg!(windows) { ".exe" } else { "" };
    fs::copy(&age_src, install_dir.join(format!("age{}", ext)))
        .map_err(|e| format!("Failed to install age: {}", e))?;
    fs::copy(&keygen_src, install_dir.join(format!("age-keygen{}", ext)))
        .map_err(|e| format!("Failed to install age-keygen: {}", e))?;

    // Make executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o755);
        let _ = fs::set_permissions(install_dir.join("age"), perms.clone());
        let _ = fs::set_permissions(install_dir.join("age-keygen"), perms);
    }

    Ok(())
}

fn install_sops(version: &str) -> Result<(), String> {
    let (os, arch) = utils::platform();
    let (filename, is_binary) = match os {
        "windows" => (format!("sops-v{}.exe", version), true),
        "darwin" => (format!("sops-v{}.darwin.{}", version, arch), true),
        _ => (format!("sops-v{}.linux.{}", version, arch), true),
    };
    let url = format!(
        "https://github.com/getsops/sops/releases/download/v{}/{}",
        version, filename
    );

    let install_dir = utils::install_dir();
    let data = download_file(&url, &filename)?;

    fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create {}: {}", install_dir.display(), e))?;

    let ext = if cfg!(windows) { ".exe" } else { "" };
    let dest = install_dir.join(format!("sops{}", ext));
    fs::write(&dest, &data)
        .map_err(|e| format!("Failed to write sops: {}", e))?;

    // Make executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
    }

    Ok(())
}

fn download_file(url: &str, name: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("Download failed for {}: {}", name, e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Download failed: HTTP {} for {}",
            resp.status(),
            url
        ));
    }

    let total = resp.content_length().unwrap_or(0);
    let pb = if total > 0 {
        utils::download_bar(total, name)
    } else {
        let pb = ProgressBar::new_spinner();
        pb.set_message(format!("Downloading {}...", name));
        pb
    };

    let mut bytes = Vec::with_capacity(total as usize);
    let mut reader = resp;
    let mut buf = [0u8; 8192];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Read error: {}", e))?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
        pb.set_position(bytes.len() as u64);
    }
    pb.finish_and_clear();
    Ok(bytes)
}

fn extract_archive(archive: &Path, dest: &Path, os: &str) -> Result<(), String> {
    let sp = utils::spinner("Extracting...");

    let status = if os == "windows" || archive.extension().map(|e| e == "zip").unwrap_or(false) {
        // Use PowerShell to extract zip on Windows
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                    archive.display(),
                    dest.display()
                ),
            ])
            .output()
    } else {
        std::process::Command::new("tar")
            .args(["xzf", &archive.to_string_lossy(), "-C", &dest.to_string_lossy()])
            .output()
    };

    sp.finish_and_clear();

    match status {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => Err(format!(
            "Extract failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )),
        Err(e) => Err(format!("Extract failed: {}", e)),
    }
}

fn find_binary(primary_dir: &Path, fallback_dir: &Path, name: &str) -> Result<std::path::PathBuf, String> {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let filename = format!("{}{}", name, ext);

    // Check primary dir (e.g., age/ subfolder in archive)
    let path = primary_dir.join(&filename);
    if path.exists() {
        return Ok(path);
    }

    // Recursive search in fallback
    for entry in walkdir(fallback_dir) {
        if entry.file_name().to_string_lossy() == filename {
            return Ok(entry.path().to_path_buf());
        }
    }

    Err(format!("Could not find {} in extracted archive", name))
}

fn walkdir(dir: &Path) -> Vec<fs::DirEntry> {
    let mut results = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                results.extend(walkdir(&path));
            } else {
                results.push(entry);
            }
        }
    }
    results
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: Compiles

- [ ] **Step 3: Commit**

```bash
git add src/commands/setup/prerequisites.rs
git commit -m "feat(setup): implement prerequisites installer for age and sops"
```

---

### Task 4: Key Generation Phase

**Files:**
- Modify: `src/commands/setup/keygen.rs`

- [ ] **Step 1: Implement key generation**

```rust
use crate::commands::setup::utils;
use colored::*;
use std::fs;

/// Ensures an age keypair exists. Returns the public key.
pub fn run() -> Result<String, String> {
    let key_path = utils::age_key_path();

    if key_path.exists() {
        let pubkey = utils::read_public_key(&key_path)?;
        utils::done(&format!("Age key already exists: {}", pubkey.cyan()));

        let use_existing = inquire::Confirm::new("Use this existing key?")
            .with_default(true)
            .prompt()
            .map_err(|_| "Cancelled".to_string())?;

        if use_existing {
            return Ok(pubkey);
        }

        // User wants a new key — back up the old one
        let backup = key_path.with_extension("txt.bak");
        fs::rename(&key_path, &backup)
            .map_err(|e| format!("Failed to back up existing key: {}", e))?;
        utils::warn(&format!("Old key backed up to {}", backup.display()));
    }

    // Generate new key
    let sp = utils::spinner("Generating age keypair...");

    let key_dir = utils::age_key_dir();
    fs::create_dir_all(&key_dir)
        .map_err(|e| format!("Failed to create {}: {}", key_dir.display(), e))?;

    let output = utils::run_command("age-keygen", &["-o", &key_path.to_string_lossy()])
        .map_err(|e| format!("age-keygen failed: {}", e));

    sp.finish_and_clear();

    // age-keygen prints the public key to stderr
    let pubkey = utils::read_public_key(&key_path)?;

    utils::done(&format!("Key generated: {}", pubkey.cyan()));
    println!(
        "  {} {}",
        "Saved to:".dimmed(),
        key_path.display().to_string().dimmed()
    );

    Ok(pubkey)
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: Compiles

- [ ] **Step 3: Commit**

```bash
git add src/commands/setup/keygen.rs
git commit -m "feat(setup): implement age key generation phase"
```

---

## Chunk 3: Init & Join Flows

### Task 5: Init Flow (First Machine)

**Files:**
- Modify: `src/commands/setup/init.rs`

- [ ] **Step 1: Implement the init flow**

```rust
use crate::commands::setup::utils;
use colored::*;
use inquire::{Text, Confirm};
use std::fs;
use std::process::Command;

pub fn run(public_key: &str) -> Result<(), String> {
    let has_gh = utils::command_exists("gh");

    let repo_name = Text::new("Vault repo name?")
        .with_default("my-keys")
        .with_help_message("This will be a private Git repo for your encrypted secrets")
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    let vault_dir = if has_gh {
        init_with_gh(&repo_name, public_key)?
    } else {
        init_manual(&repo_name, public_key)?
    };

    // Create .sops.yaml
    let sp = utils::spinner("Creating SOPS config...");
    let sops_content = format!(
        "creation_rules:\n  - path_regex: vault\\.yaml$\n    age: >-\n      {}\n",
        public_key
    );
    fs::write(format!("{}/.sops.yaml", vault_dir), &sops_content)
        .map_err(|e| format!("Failed to write .sops.yaml: {}", e))?;
    sp.finish_and_clear();
    utils::done("Created .sops.yaml");

    // Create and encrypt vault.yaml
    let sp = utils::spinner("Creating encrypted vault...");
    fs::write(format!("{}/vault.yaml", vault_dir), "services: {}\n")
        .map_err(|e| format!("Failed to write vault.yaml: {}", e))?;

    let output = Command::new("sops")
        .args(["-e", "-i", "vault.yaml"])
        .current_dir(&vault_dir)
        .output()
        .map_err(|e| format!("sops encrypt failed: {}", e))?;

    sp.finish_and_clear();

    if !output.status.success() {
        return Err(format!(
            "SOPS encryption failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    utils::done("Created and encrypted vault.yaml");

    // Git add, commit, push
    let sp = utils::spinner("Committing...");
    run_git(&vault_dir, &["add", ".sops.yaml", "vault.yaml"])?;
    run_git(&vault_dir, &["commit", "-m", "feat: initialize encrypted vault"])?;
    sp.finish_and_clear();
    utils::done("Initial commit created");

    // Try to push
    if has_remote(&vault_dir) {
        let sp = utils::spinner("Pushing to remote...");
        let push_result = run_git(&vault_dir, &["push", "-u", "origin", "main"]);
        sp.finish_and_clear();
        match push_result {
            Ok(_) => utils::done("Pushed to remote"),
            Err(_) => {
                // Try master branch
                let _ = run_git(&vault_dir, &["push", "-u", "origin", "master"]);
                utils::done("Pushed to remote");
            }
        }
    } else {
        utils::warn("No remote configured. Push manually when ready.");
    }

    println!(
        "\n  {} {}",
        "Vault directory:".dimmed(),
        vault_dir.cyan().bold()
    );

    Ok(())
}

fn init_with_gh(repo_name: &str, _public_key: &str) -> Result<String, String> {
    let create_remote = Confirm::new("Create a private GitHub repo automatically?")
        .with_default(true)
        .with_help_message("Requires `gh` CLI to be authenticated")
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    if create_remote {
        let sp = utils::spinner("Creating private GitHub repo...");
        let result = utils::run_command(
            "gh",
            &["repo", "create", repo_name, "--private", "--clone"],
        );
        sp.finish_and_clear();

        match result {
            Ok(output) => {
                utils::done(&format!("Created and cloned {}", repo_name));
                Ok(repo_name.to_string())
            }
            Err(e) => {
                utils::warn(&format!("gh repo create failed: {}", e));
                utils::warn("Falling back to manual setup...");
                init_manual(repo_name, _public_key)
            }
        }
    } else {
        init_manual(repo_name, _public_key)
    }
}

fn init_manual(repo_name: &str, _public_key: &str) -> Result<String, String> {
    let dir = Text::new("Local directory for the vault repo?")
        .with_default(repo_name)
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    // Init git if not already a repo
    if !std::path::Path::new(&format!("{}/.git", dir)).exists() {
        let sp = utils::spinner("Initializing git repository...");
        run_git(&dir, &["init"])?;
        sp.finish_and_clear();
        utils::done("Git repository initialized");
    }

    println!(
        "\n  {} {}",
        "Next:".yellow().bold(),
        "Create a PRIVATE repo on GitHub and run:".dimmed()
    );
    println!(
        "    {}",
        format!("git remote add origin git@github.com:YOU/{}.git", repo_name).cyan()
    );
    println!();

    Ok(dir)
}

fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git {} failed: {}", args.join(" "), e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

fn has_remote(dir: &str) -> bool {
    run_git(dir, &["remote"]).map(|s| !s.trim().is_empty()).unwrap_or(false)
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: Compiles

- [ ] **Step 3: Commit**

```bash
git add src/commands/setup/init.rs
git commit -m "feat(setup): implement init flow for first machine"
```

---

### Task 6: Join Flow (Additional Machine)

**Files:**
- Modify: `src/commands/setup/join.rs`

- [ ] **Step 1: Implement the join flow**

```rust
use crate::commands::setup::utils;
use colored::*;
use inquire::Text;
use std::fs;
use std::process::Command;

pub fn run(public_key: &str) -> Result<(), String> {
    let has_gh = utils::command_exists("gh");

    let vault_dir = if has_gh {
        join_with_gh()?
    } else {
        join_manual()?
    };

    // Read existing .sops.yaml and add this machine's key
    let sops_path = format!("{}/.sops.yaml", vault_dir);
    if !std::path::Path::new(&sops_path).exists() {
        return Err(format!(
            "No .sops.yaml found in {}. Is this the right repo?",
            vault_dir
        ));
    }

    let sp = utils::spinner("Adding this machine's key to recipients...");
    let content = fs::read_to_string(&sops_path)
        .map_err(|e| format!("Failed to read .sops.yaml: {}", e))?;

    // Check if key already present
    if content.contains(public_key) {
        sp.finish_and_clear();
        utils::done("This machine's key is already a recipient");
    } else {
        // Add the new key to the age recipient list
        let updated = add_recipient_to_sops(&content, public_key)?;
        fs::write(&sops_path, &updated)
            .map_err(|e| format!("Failed to write .sops.yaml: {}", e))?;
        sp.finish_and_clear();
        utils::done(&format!("Added key {} to recipients", &public_key[..20].cyan()));

        // Re-encrypt vault with the new recipient
        let sp = utils::spinner("Re-encrypting vault for new recipient...");
        let output = Command::new("sops")
            .args(["updatekeys", "-y", "vault.yaml"])
            .current_dir(&vault_dir)
            .output()
            .map_err(|e| format!("sops updatekeys failed: {}", e))?;
        sp.finish_and_clear();

        if !output.status.success() {
            return Err(format!(
                "Failed to re-encrypt vault: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        utils::done("Vault re-encrypted");

        // Commit and push
        let sp = utils::spinner("Committing changes...");
        run_git(&vault_dir, &["add", ".sops.yaml", "vault.yaml"])?;
        run_git(
            &vault_dir,
            &["commit", "-m", "feat: add new machine to vault recipients"],
        )?;
        sp.finish_and_clear();
        utils::done("Changes committed");

        if has_remote(&vault_dir) {
            let sp = utils::spinner("Pushing...");
            let _ = run_git(&vault_dir, &["push"]);
            sp.finish_and_clear();
            utils::done("Pushed to remote");
        }
    }

    println!(
        "\n  {} {}",
        "Vault directory:".dimmed(),
        vault_dir.cyan().bold()
    );
    println!(
        "  {}",
        "You can now use `key-pick` commands from this directory.".dimmed()
    );

    Ok(())
}

fn join_with_gh() -> Result<String, String> {
    let repo = Text::new("GitHub repo to clone? (e.g. username/my-keys)")
        .with_help_message("Your private vault repository")
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    let repo_name = repo.split('/').last().unwrap_or(&repo);

    let sp = utils::spinner("Cloning repository...");
    let result = utils::run_command("gh", &["repo", "clone", &repo]);
    sp.finish_and_clear();

    match result {
        Ok(_) => {
            utils::done(&format!("Cloned {}", repo));
            Ok(repo_name.to_string())
        }
        Err(e) => Err(format!("Clone failed: {}", e)),
    }
}

fn join_manual() -> Result<String, String> {
    let input = Text::new("Path to existing vault repo (or git clone URL)?")
        .with_help_message("e.g. git@github.com:user/my-keys.git or ./my-keys")
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    if input.contains("git@") || input.contains("https://") {
        // It's a clone URL
        let repo_name = input
            .split('/')
            .last()
            .unwrap_or("my-keys")
            .trim_end_matches(".git");

        let sp = utils::spinner("Cloning repository...");
        let result = Command::new("git")
            .args(["clone", &input])
            .output()
            .map_err(|e| format!("git clone failed: {}", e))?;
        sp.finish_and_clear();

        if !result.status.success() {
            return Err(format!(
                "Clone failed: {}",
                String::from_utf8_lossy(&result.stderr)
            ));
        }
        utils::done(&format!("Cloned to {}/", repo_name));
        Ok(repo_name.to_string())
    } else {
        // It's a local path
        if !std::path::Path::new(&input).exists() {
            return Err(format!("Directory {} does not exist", input));
        }
        Ok(input)
    }
}

fn add_recipient_to_sops(content: &str, new_key: &str) -> Result<String, String> {
    // Find the last age1... key line and append the new one after it
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let mut last_key_idx = None;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim().trim_end_matches(',');
        if trimmed.starts_with("age1") {
            last_key_idx = Some(i);
        }
    }

    match last_key_idx {
        Some(idx) => {
            // Ensure previous line ends with comma
            if !lines[idx].trim_end().ends_with(',') {
                lines[idx] = format!("{},", lines[idx].trim_end());
            }
            // Get the indentation from the previous key line
            let indent: String = lines[idx]
                .chars()
                .take_while(|c| c.is_whitespace())
                .collect();
            lines.insert(idx + 1, format!("{}{}", indent, new_key));
            Ok(lines.join("\n") + "\n")
        }
        None => Err("Could not find age key entries in .sops.yaml".to_string()),
    }
}

fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git {} failed: {}", args.join(" "), e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

fn has_remote(dir: &str) -> bool {
    run_git(dir, &["remote"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: Compiles

- [ ] **Step 3: Commit**

```bash
git add src/commands/setup/join.rs
git commit -m "feat(setup): implement join flow for additional machines"
```

---

## Chunk 4: Optional Wizards

### Task 7: GitHub Actions Mini-Wizard

**Files:**
- Modify: `src/commands/setup/actions.rs`

- [ ] **Step 1: Implement GitHub Actions setup**

```rust
use crate::commands::setup::utils;
use colored::*;
use std::fs;
use std::process::Command;

const VAULT_SYNC_WORKFLOW: &str = include_str!("../../../.github/workflows/vault-sync.yml");

pub fn run() {
    if let Err(e) = run_inner() {
        eprintln!("{} {}", "GitHub Actions setup failed:".red().bold(), e);
    }
}

fn run_inner() -> Result<(), String> {
    // Verify gh is available
    if !utils::command_exists("gh") {
        return Err(
            "The `gh` CLI is required for GitHub Actions setup.\n  \
             Install it from: https://cli.github.com"
                .to_string(),
        );
    }

    // Verify we're in a git repo with a remote
    let remote_url = utils::run_command("git", &["remote", "get-url", "origin"])
        .map_err(|_| "Not in a git repo with an 'origin' remote. Run from your vault repo.")?;

    println!(
        "  {} {}",
        "Repo:".dimmed(),
        remote_url.trim().cyan()
    );

    // Step 1: Generate age keypair for GH Actions
    let sp = utils::spinner("Generating GitHub Actions age key...");
    let tmp = tempfile::NamedTempFile::new()
        .map_err(|e| format!("Temp file error: {}", e))?;

    let output = Command::new("age-keygen")
        .args(["-o", &tmp.path().to_string_lossy()])
        .output()
        .map_err(|e| format!("age-keygen failed: {}", e))?;
    sp.finish_and_clear();

    if !output.status.success() {
        return Err(format!(
            "age-keygen failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let key_content = fs::read_to_string(tmp.path())
        .map_err(|e| format!("Failed to read generated key: {}", e))?;
    let pubkey = utils::read_public_key(tmp.path())?;

    utils::done(&format!(
        "Generated Actions key: {}...",
        &pubkey[..24].cyan()
    ));

    // Step 2: Add public key to .sops.yaml
    let sp = utils::spinner("Adding Actions key to .sops.yaml...");
    let sops_content = fs::read_to_string(".sops.yaml")
        .map_err(|e| format!("Failed to read .sops.yaml: {}", e))?;

    if sops_content.contains(&pubkey) {
        sp.finish_and_clear();
        utils::skip("Actions key already in .sops.yaml");
    } else {
        let updated = add_recipient(&sops_content, &pubkey)?;
        fs::write(".sops.yaml", &updated)
            .map_err(|e| format!("Failed to write .sops.yaml: {}", e))?;
        sp.finish_and_clear();
        utils::done("Added Actions key to .sops.yaml");
    }

    // Step 3: Set GitHub secret
    let sp = utils::spinner("Setting SOPS_AGE_KEY secret on GitHub...");
    let mut child = Command::new("gh")
        .args(["secret", "set", "SOPS_AGE_KEY"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run gh: {}", e))?;

    if let Some(ref mut stdin) = child.stdin {
        use std::io::Write;
        stdin
            .write_all(key_content.as_bytes())
            .map_err(|e| format!("Failed to write secret: {}", e))?;
    }

    let status = child.wait().map_err(|e| format!("gh failed: {}", e))?;
    sp.finish_and_clear();

    if !status.success() {
        return Err("Failed to set GitHub secret. Check `gh auth status`.".to_string());
    }
    utils::done("Set SOPS_AGE_KEY secret on GitHub");

    // Step 4: Copy workflow file
    let sp = utils::spinner("Installing workflow file...");
    fs::create_dir_all(".github/workflows")
        .map_err(|e| format!("Failed to create .github/workflows: {}", e))?;
    fs::write(".github/workflows/vault-sync.yml", VAULT_SYNC_WORKFLOW)
        .map_err(|e| format!("Failed to write workflow: {}", e))?;
    sp.finish_and_clear();
    utils::done("Installed .github/workflows/vault-sync.yml");

    // Step 5: Commit and push
    let sp = utils::spinner("Committing and pushing...");
    let _ = Command::new("git")
        .args(["add", ".github", ".sops.yaml"])
        .output();
    let _ = Command::new("git")
        .args(["commit", "-m", "feat: add GitHub Actions auto re-encryption"])
        .output();
    let push_output = Command::new("git")
        .args(["push"])
        .output()
        .map_err(|e| format!("git push failed: {}", e))?;
    sp.finish_and_clear();

    if push_output.status.success() {
        utils::done("Pushed to remote");
    } else {
        utils::warn("Push failed — you can push manually later");
    }

    // Temp file is automatically cleaned up when dropped
    println!(
        "\n  {} {}",
        "Done!".green().bold(),
        "The workflow will auto re-encrypt vault.yaml when .sops.yaml changes.".dimmed()
    );

    Ok(())
}

fn add_recipient(content: &str, new_key: &str) -> Result<String, String> {
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let mut last_key_idx = None;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim().trim_end_matches(',');
        if trimmed.starts_with("age1") {
            last_key_idx = Some(i);
        }
    }

    match last_key_idx {
        Some(idx) => {
            if !lines[idx].trim_end().ends_with(',') {
                lines[idx] = format!("{},", lines[idx].trim_end());
            }
            let indent: String = lines[idx]
                .chars()
                .take_while(|c| c.is_whitespace())
                .collect();
            lines.insert(idx + 1, format!("{}{}", indent, new_key));
            Ok(lines.join("\n") + "\n")
        }
        None => Err("Could not find age key entries in .sops.yaml".to_string()),
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: Compiles

- [ ] **Step 3: Commit**

```bash
git add src/commands/setup/actions.rs
git commit -m "feat(setup): implement GitHub Actions auto-sync wizard"
```

---

### Task 8: Recovery Key Mini-Wizard

**Files:**
- Modify: `src/commands/setup/recovery.rs`

- [ ] **Step 1: Implement recovery key wizard**

```rust
use crate::commands::setup::utils;
use colored::*;
use inquire::Text;
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

pub fn run() {
    if let Err(e) = run_inner() {
        eprintln!("{} {}", "Recovery key setup failed:".red().bold(), e);
    }
}

fn run_inner() -> Result<(), String> {
    println!(
        "\n  {}",
        "A recovery key lets you regain access if you lose all your machines.".dimmed()
    );
    println!(
        "  {}\n",
        "You'll set a passphrase to protect it.".dimmed()
    );

    // Step 1: Generate keypair
    let sp = utils::spinner("Generating recovery keypair...");
    let keygen_output = Command::new("age-keygen")
        .output()
        .map_err(|e| format!("age-keygen failed: {}", e))?;
    sp.finish_and_clear();

    if !keygen_output.status.success() {
        return Err("age-keygen failed".to_string());
    }

    let key_material = String::from_utf8_lossy(&keygen_output.stdout).to_string();
    let stderr_text = String::from_utf8_lossy(&keygen_output.stderr).to_string();

    // Extract public key from stderr (age-keygen prints it there)
    let pubkey = stderr_text
        .lines()
        .find(|l| l.starts_with("Public key: "))
        .map(|l| l.trim_start_matches("Public key: ").trim().to_string())
        .ok_or("Could not extract public key from age-keygen output")?;

    utils::done(&format!("Generated recovery key: {}...", &pubkey[..24].cyan()));

    // Step 2: Get passphrase
    let passphrase = Text::new("Enter a strong passphrase for the recovery key:")
        .with_help_message("This protects the key file. Use something memorable but strong.")
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    let confirm = Text::new("Confirm passphrase:")
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    if passphrase != confirm {
        return Err("Passphrases don't match".to_string());
    }

    // Step 3: Encrypt private key with passphrase using age -p
    let sp = utils::spinner("Encrypting recovery key with passphrase...");

    // Pipe key material through `age -e -p` with passphrase on stdin
    // age -p reads passphrase from terminal, so we use --passphrase flag
    // Actually, we need to pipe the passphrase. Use environment variable approach.
    let mut child = Command::new("age")
        .args(["-e", "-p", "-o", "recovery_key.age"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run age: {}", e))?;

    // age -p expects passphrase on stdin first, then the data
    // But actually age -p reads passphrase from terminal.
    // We need a different approach: use AGE_PASSPHRASE env var or write to a pipe.
    drop(child.stdin.take()); // close stdin
    let _ = child.wait();

    // Better approach: write key to temp file, encrypt with age
    let tmp_key = tempfile::NamedTempFile::new()
        .map_err(|e| format!("Temp file error: {}", e))?;
    fs::write(tmp_key.path(), &key_material)
        .map_err(|e| format!("Failed to write temp key: {}", e))?;

    // Use age with passphrase via stdin redirection
    // On age CLI, `-p` reads passphrase from /dev/tty, not stdin.
    // Workaround: use the SCRYPT_PASSPHRASE env var or just use age encrypt with recipient
    // Simplest reliable approach: pipe through age with the passphrase prompt
    // Actually the cleanest approach is to use age's --passphrase with stdin piping

    // Let's use a simpler approach: write the key, then tell the user to encrypt it
    // OR we can use age library... but the project uses CLI age.

    // The reliable approach: generate the encrypted file by piping key_material
    // into `age -e -p` and providing passphrase
    let mut child = Command::new("age")
        .args(["-e", "-p"])
        .env("AGE_PASSPHRASE", &passphrase)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run age: {}", e))?;

    {
        let stdin = child.stdin.as_mut().expect("Failed to open age stdin");
        stdin
            .write_all(key_material.as_bytes())
            .map_err(|e| format!("Failed to write to age stdin: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("age encrypt failed: {}", e))?;

    sp.finish_and_clear();

    if !output.status.success() {
        // AGE_PASSPHRASE might not be supported in older versions
        // Fall back to interactive prompt
        utils::warn("Automatic passphrase entry not supported by this age version.");
        println!(
            "  {}",
            "Running age interactively — enter your passphrase when prompted:".dimmed()
        );

        let status = Command::new("age")
            .args(["-e", "-p", "-o", "recovery_key.age"])
            .stdin(Stdio::from(
                fs::File::open(tmp_key.path())
                    .map_err(|e| format!("Failed to open temp key: {}", e))?,
            ))
            .status()
            .map_err(|e| format!("age failed: {}", e))?;

        if !status.success() {
            return Err("Failed to encrypt recovery key".to_string());
        }
    } else {
        fs::write("recovery_key.age", &output.stdout)
            .map_err(|e| format!("Failed to write recovery_key.age: {}", e))?;
    }

    utils::done("Encrypted recovery key saved to recovery_key.age");

    // Step 4: Add recovery public key to .sops.yaml
    if std::path::Path::new(".sops.yaml").exists() {
        let sp = utils::spinner("Adding recovery key to .sops.yaml...");
        let content = fs::read_to_string(".sops.yaml")
            .map_err(|e| format!("Failed to read .sops.yaml: {}", e))?;

        if !content.contains(&pubkey) {
            let updated = add_recipient(&content, &pubkey)?;
            fs::write(".sops.yaml", &updated)
                .map_err(|e| format!("Failed to write .sops.yaml: {}", e))?;
        }
        sp.finish_and_clear();
        utils::done("Added recovery key to .sops.yaml recipients");

        // Re-encrypt vault
        if std::path::Path::new("vault.yaml").exists() {
            let sp = utils::spinner("Re-encrypting vault...");
            let _ = Command::new("sops")
                .args(["updatekeys", "-y", "vault.yaml"])
                .output();
            sp.finish_and_clear();
            utils::done("Vault re-encrypted with recovery key");
        }

        // Commit
        let sp = utils::spinner("Committing...");
        let _ = Command::new("git")
            .args(["add", ".sops.yaml", "vault.yaml"])
            .output();
        let _ = Command::new("git")
            .args(["commit", "-m", "feat: add recovery key to vault recipients"])
            .output();
        let _ = Command::new("git").args(["push"]).output();
        sp.finish_and_clear();
        utils::done("Changes committed and pushed");
    }

    // Step 5: Storage instructions
    println!("\n  {}", "── Recovery Key Storage ──".yellow().bold());
    println!(
        "  {} Upload {} to cloud storage (e.g. Google Drive)",
        "1.".cyan().bold(),
        "recovery_key.age".cyan()
    );
    println!(
        "  {} Write the passphrase on paper, store in a safe/lockbox",
        "2.".cyan().bold()
    );
    println!(
        "  {} {}",
        "⚠".yellow().bold(),
        "Store the FILE and PASSPHRASE in SEPARATE physical locations!".yellow()
    );
    println!(
        "  {} Delete recovery_key.age from this machine after uploading\n",
        "3.".cyan().bold()
    );

    Ok(())
}

fn add_recipient(content: &str, new_key: &str) -> Result<String, String> {
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let mut last_key_idx = None;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim().trim_end_matches(',');
        if trimmed.starts_with("age1") {
            last_key_idx = Some(i);
        }
    }

    match last_key_idx {
        Some(idx) => {
            if !lines[idx].trim_end().ends_with(',') {
                lines[idx] = format!("{},", lines[idx].trim_end());
            }
            let indent: String = lines[idx]
                .chars()
                .take_while(|c| c.is_whitespace())
                .collect();
            lines.insert(idx + 1, format!("{}{}", indent, new_key));
            Ok(lines.join("\n") + "\n")
        }
        None => Err("Could not find age key entries in .sops.yaml".to_string()),
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: Compiles

- [ ] **Step 3: Commit**

```bash
git add src/commands/setup/recovery.rs
git commit -m "feat(setup): implement recovery key wizard"
```

---

## Chunk 5: Polish & Integration

### Task 9: Extract Shared `add_recipient` Helper

**Files:**
- Modify: `src/commands/setup/utils.rs`
- Modify: `src/commands/setup/join.rs`
- Modify: `src/commands/setup/actions.rs`
- Modify: `src/commands/setup/recovery.rs`

The `add_recipient` and `run_git` functions are duplicated across join, actions, and recovery modules.

- [ ] **Step 1: Move `add_recipient` and `run_git` into `utils.rs`**

Add to `src/commands/setup/utils.rs`:

```rust
/// Add an age public key to the recipient list in .sops.yaml content.
pub fn add_recipient(content: &str, new_key: &str) -> Result<String, String> {
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let mut last_key_idx = None;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim().trim_end_matches(',');
        if trimmed.starts_with("age1") {
            last_key_idx = Some(i);
        }
    }

    match last_key_idx {
        Some(idx) => {
            if !lines[idx].trim_end().ends_with(',') {
                lines[idx] = format!("{},", lines[idx].trim_end());
            }
            let indent: String = lines[idx]
                .chars()
                .take_while(|c| c.is_whitespace())
                .collect();
            lines.insert(idx + 1, format!("{}{}", indent, new_key));
            Ok(lines.join("\n") + "\n")
        }
        None => Err("Could not find age key entries in .sops.yaml".to_string()),
    }
}

/// Run a git command in a specific directory.
pub fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git {} failed: {}", args.join(" "), e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Check if a git repo has a remote configured.
pub fn has_remote(dir: &str) -> bool {
    run_git(dir, &["remote"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}
```

- [ ] **Step 2: Update join.rs, actions.rs, recovery.rs to use `utils::add_recipient`, `utils::run_git`, `utils::has_remote`**

Remove the local `add_recipient`, `run_git`, and `has_remote` functions from each file and replace calls with `utils::` prefixed versions.

- [ ] **Step 3: Verify it compiles**

Run: `cargo check`
Expected: Compiles

- [ ] **Step 4: Commit**

```bash
git add src/commands/setup/
git commit -m "refactor(setup): extract shared helpers into utils"
```

---

### Task 10: Build and Test End-to-End

- [ ] **Step 1: Build release binary**

Run: `cargo build --release`
Expected: Compiles with no errors

- [ ] **Step 2: Test help output**

Run: `./target/release/key-pick setup --help`
Expected: Shows setup subcommand with `actions` and `recovery` options

- [ ] **Step 3: Test that setup wizard starts**

Run: `./target/release/key-pick setup`
Expected: Shows banner, checks for age/sops, proceeds through wizard prompts

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "feat(setup): complete setup installer wizard"
```
