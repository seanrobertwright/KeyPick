# .env File Management Implementation Plan

> **For agentic workers:** REQUIRED: Use lril-superpowers:subagent-driven-development (if subagents available) or lril-superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `keypick env push/pull/status` commands that encrypt, store, and sync per-project `.env` files through the existing vault infrastructure.

**Architecture:** New `src/commands/env/` module with four files (mod.rs, push.rs, pull.rs, status.rs, utils.rs). Project identification derived from git remote URL. `.env*` files stored as individually SOPS-encrypted dotenv files under `envs/<project-id>/` in the vault repo. Same `.sops.yaml` recipient management as vault.yaml.

**Tech Stack:** Rust, clap (CLI), SOPS (dotenv encryption), age (keys), inquire (prompts), colored (output), indicatif (spinners), glob (file discovery)

---

## Chunk 1: Core Utilities & Project ID

### Task 1: Add glob dependency

**Files:**
- Modify: `Cargo.toml:12` (dependencies section)

- [ ] **Step 1: Add glob crate to Cargo.toml**

In the `[dependencies]` section, add:

```toml
# File pattern matching for .env* discovery
glob = "0.3"
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "chore: add glob dependency for .env file discovery"
```

---

### Task 2: Create env utils module — project ID derivation and file discovery

**Files:**
- Create: `src/commands/env/utils.rs`
- Create: `src/commands/env/mod.rs`

- [ ] **Step 1: Create `src/commands/env/utils.rs` with project ID derivation**

```rust
use std::path::{Path, PathBuf};
use std::process::Command;

/// Derive a project identifier from the current working directory.
///
/// Resolution:
/// 1. Parse git remote origin URL → normalize to `owner__repo`
/// 2. Fall back to directory name if no git remote
///
/// Returns (project_id, used_fallback)
pub fn derive_project_id(dir: &Path) -> Result<(String, bool), String> {
    // Try git remote first
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(dir)
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(id) = normalize_remote_url(&url) {
                return Ok((id, false));
            }
        }
    }

    // Fall back to directory name
    let dir_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Cannot determine directory name".to_string())?;

    Ok((dir_name.to_string(), true))
}

/// Normalize a git remote URL to a project identifier.
///
/// Handles:
/// - https://github.com/owner/repo.git → owner__repo
/// - git@github.com:owner/repo.git → owner__repo
/// - https://github.com/owner/repo → owner__repo
fn normalize_remote_url(url: &str) -> Option<String> {
    let cleaned = url.trim();

    // SSH format: git@host:owner/repo.git
    let path = if let Some(after_colon) = cleaned.strip_prefix("git@") {
        after_colon.split_once(':').map(|(_, path)| path)?
    } else {
        // HTTPS format: https://host/owner/repo.git
        // Strip protocol and host
        let without_proto = cleaned
            .strip_prefix("https://")
            .or_else(|| cleaned.strip_prefix("http://"))?;
        // Skip the hostname (first path segment)
        without_proto.split_once('/').map(|(_, path)| path)?
    };

    // Strip .git suffix and replace / with __
    let path = path.strip_suffix(".git").unwrap_or(path);
    let id = path.replace('/', "__");

    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

/// Find all .env* files in a directory (non-recursive).
///
/// Returns sorted list of file paths matching .env* glob pattern.
/// Skips empty files.
pub fn discover_env_files(dir: &Path) -> Vec<PathBuf> {
    let pattern = dir.join(".env*").to_string_lossy().to_string();
    let mut files: Vec<PathBuf> = glob::glob(&pattern)
        .unwrap_or_else(|_| panic!("Invalid glob pattern"))
        .filter_map(|entry| entry.ok())
        .filter(|path| path.is_file())
        .filter(|path| {
            std::fs::metadata(path)
                .map(|m| m.len() > 0)
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    files
}

/// Get the envs directory path within a vault repo for a given project.
pub fn envs_dir(vault_dir: &Path, project_id: &str) -> PathBuf {
    vault_dir.join("envs").join(project_id)
}

/// Ensure .sops.yaml has an envs/.* creation rule.
/// If missing, adds one using the age recipients from the existing vault.yaml rule.
/// Returns true if the file was modified.
pub fn ensure_sops_env_rule(vault_dir: &Path) -> Result<bool, String> {
    let sops_path = vault_dir.join(".sops.yaml");
    let content = std::fs::read_to_string(&sops_path)
        .map_err(|e| format!("Failed to read .sops.yaml: {}", e))?;

    // Check if envs rule already exists
    if content.contains("envs/") {
        return Ok(false);
    }

    // Extract age recipients from the existing vault.yaml rule
    // Look for the age: line(s) after path_regex: vault\.yaml$
    let lines: Vec<&str> = content.lines().collect();
    let mut age_value = String::new();
    let mut in_vault_rule = false;
    let mut found_age = false;

    for line in &lines {
        let trimmed = line.trim();
        if trimmed.starts_with("- path_regex:") && trimmed.contains("vault") {
            in_vault_rule = true;
            continue;
        }
        if in_vault_rule && trimmed.starts_with("age:") {
            found_age = true;
            // Could be inline or block scalar
            let after_age = trimmed.strip_prefix("age:").unwrap().trim();
            if after_age == ">-" || after_age == "|" || after_age.is_empty() {
                // Block scalar — collect following indented lines
                continue;
            } else {
                // Inline value (possibly quoted)
                age_value = after_age.trim_matches('"').to_string();
                break;
            }
        }
        if found_age && in_vault_rule {
            // Collecting block scalar lines
            if trimmed.starts_with("age1") || trimmed.starts_with("\"age1") {
                if !age_value.is_empty() {
                    // Remove trailing comma from previous
                    age_value = age_value.trim_end_matches(',').to_string();
                    age_value.push(',');
                }
                age_value.push_str(trimmed.trim_end_matches(','));
            } else if !trimmed.is_empty() && !trimmed.starts_with('-') {
                // Still in block scalar if indented
                continue;
            } else {
                break;
            }
        }
        if in_vault_rule && trimmed.starts_with("- ") && found_age {
            break;
        }
    }

    if age_value.is_empty() {
        return Err("Could not find age recipients in .sops.yaml".to_string());
    }

    // Prepend the envs rule before the vault rule
    let env_rule = format!(
        "creation_rules:\n  - path_regex: envs/.*\n    age: >-\n      {}\n  - path_regex: vault\\.yaml$",
        age_value
    );
    let updated = content.replacen(
        "creation_rules:\n  - path_regex: vault\\.yaml$",
        &env_rule,
        1,
    );

    std::fs::write(&sops_path, &updated)
        .map_err(|e| format!("Failed to write .sops.yaml: {}", e))?;

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_https_url() {
        assert_eq!(
            normalize_remote_url("https://github.com/seanrobertwright/my-app.git"),
            Some("seanrobertwright__my-app".to_string())
        );
    }

    #[test]
    fn test_normalize_https_no_git_suffix() {
        assert_eq!(
            normalize_remote_url("https://github.com/seanrobertwright/my-app"),
            Some("seanrobertwright__my-app".to_string())
        );
    }

    #[test]
    fn test_normalize_ssh_url() {
        assert_eq!(
            normalize_remote_url("git@github.com:seanrobertwright/my-app.git"),
            Some("seanrobertwright__my-app".to_string())
        );
    }

    #[test]
    fn test_normalize_ssh_no_git_suffix() {
        assert_eq!(
            normalize_remote_url("git@github.com:seanrobertwright/my-app"),
            Some("seanrobertwright__my-app".to_string())
        );
    }

    #[test]
    fn test_normalize_nested_path() {
        assert_eq!(
            normalize_remote_url("https://github.com/org/sub/repo.git"),
            Some("org__sub__repo".to_string())
        );
    }
}
```

- [ ] **Step 2: Create `src/commands/env/mod.rs` with subcommand enum**

```rust
pub mod push;
pub mod pull;
pub mod status;
pub mod utils;

use clap::Subcommand;

#[derive(Subcommand)]
pub enum EnvCommands {
    /// Push .env files from the current project to the vault
    Push,

    /// Pull .env files from the vault to the current project
    Pull,

    /// Show which .env files are stored for the current project
    Status,
}

pub fn run(sub: EnvCommands) {
    match sub {
        EnvCommands::Push => push::run(),
        EnvCommands::Pull => pull::run(),
        EnvCommands::Status => status::run(),
    }
}
```

- [ ] **Step 3: Create placeholder files so compilation works**

Create `src/commands/env/push.rs`:
```rust
pub fn run() {
    todo!("env push")
}
```

Create `src/commands/env/pull.rs`:
```rust
pub fn run() {
    todo!("env pull")
}
```

Create `src/commands/env/status.rs`:
```rust
pub fn run() {
    todo!("env status")
}
```

- [ ] **Step 4: Verify tests pass**

Run: `cargo test commands::env::utils`
Expected: All 5 tests pass

- [ ] **Step 5: Verify it compiles**

Run: `cargo check`
Expected: compiles (with dead_code warnings for push/pull/status — that's fine)

- [ ] **Step 6: Commit**

```bash
git add src/commands/env/
git commit -m "feat: add env module with project ID utils and unit tests"
```

---

## Chunk 2: CLI Wiring

### Task 3: Wire env subcommands into main.rs and commands/mod.rs

**Files:**
- Modify: `src/main.rs:1-96`
- Modify: `src/commands/mod.rs:1-8`

- [ ] **Step 1: Add `pub mod env;` to `src/commands/mod.rs`**

Add after line 4 (`pub mod extract;`):
```rust
pub mod env;
```

- [ ] **Step 2: Add Env variant to Commands enum in `src/main.rs`**

After the `Setup` variant (line 56), add:
```rust
    /// Manage per-project .env files in the vault
    Env {
        #[command(subcommand)]
        sub: commands::env::EnvCommands,
    },
```

- [ ] **Step 3: Add Env to the biometric gate in `src/main.rs`**

Modify the `needs_bio` check at line 72-75. The `Env` command needs biometric for Push and Pull but not Status. The simplest approach: handle Env before the biometric gate, similar to Setup, and gate inside the env module. Change the match at line 72:

Replace the `needs_bio` logic and match block. After the Setup early-return (line 66-69), add:

```rust
    // Env::Status skips biometric; Push and Pull require it
    if let Some(Commands::Env { sub }) = &cli.command {
        match sub {
            commands::env::EnvCommands::Status => {
                commands::env::run(commands::env::EnvCommands::Status);
                return;
            }
            _ => {} // fall through to biometric gate
        }
    }
```

Then in the `needs_bio` check, add `Env` to the exclusion list — but actually we don't because Push and Pull need bio. The Status case returns early above. No change needed to `needs_bio`.

- [ ] **Step 4: Add dispatch arm in the match block**

In the `match cli.command` block at line 86-95, add before `None`:
```rust
        Some(Commands::Env { sub }) => commands::env::run(sub),
```

- [ ] **Step 5: Verify it compiles**

Run: `cargo check`
Expected: compiles with no errors

- [ ] **Step 6: Commit**

```bash
git add src/main.rs src/commands/mod.rs
git commit -m "feat: wire keypick env push/pull/status subcommands into CLI"
```

---

## Chunk 3: Push Command

### Task 4: Implement `keypick env push`

**Files:**
- Modify: `src/commands/env/push.rs`

- [ ] **Step 1: Implement push.rs**

Replace the placeholder with:

```rust
use colored::*;
use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;

use crate::commands::setup::utils as setup_utils;
use crate::vault;

use super::utils as env_utils;

pub fn run() {
    if let Err(e) = run_inner() {
        eprintln!("{} {}", "Push failed:".red().bold(), e);
        crate::terminal::cleanup_and_exit(1);
    }
}

fn run_inner() -> Result<(), String> {
    let cwd = env::current_dir()
        .map_err(|e| format!("Cannot read current directory: {}", e))?;

    // Derive project ID
    let (project_id, used_fallback) = env_utils::derive_project_id(&cwd)?;
    if used_fallback {
        println!(
            "  {} {}",
            "!".yellow().bold(),
            format!(
                "No git remote found. Using folder name '{}' as project identifier.\n    \
                 Projects on other machines must use the same folder name to pull.",
                project_id
            ).dimmed()
        );
    }
    println!(
        "  {} {}",
        "Project:".dimmed(),
        project_id.cyan().bold()
    );

    // Discover .env files
    let env_files = env_utils::discover_env_files(&cwd);
    if env_files.is_empty() {
        return Err("No .env files found in the current directory.".to_string());
    }

    println!("\n  {} files to push:", "Found".dimmed());
    for f in &env_files {
        println!("    {}", f.file_name().unwrap().to_string_lossy().cyan());
    }
    println!();

    // Resolve vault
    let vault_dir = vault::vault_dir();
    let vault_dir_str = vault_dir.display().to_string();

    // Ensure .sops.yaml has envs rule
    match env_utils::ensure_sops_env_rule(&vault_dir) {
        Ok(true) => {
            setup_utils::done("Updated .sops.yaml with env file encryption rule");
        }
        Ok(false) => {}
        Err(e) => return Err(format!("Failed to update .sops.yaml: {}", e)),
    }

    // Create project directory in vault
    let dest_dir = env_utils::envs_dir(&vault_dir, &project_id);
    fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create {}: {}", dest_dir.display(), e))?;

    // Encrypt and copy each file
    let sp = setup_utils::spinner("Encrypting .env files...");
    let mut errors = Vec::new();

    for src_file in &env_files {
        let file_name = src_file.file_name().unwrap().to_string_lossy();
        let dest_file = dest_dir.join(file_name.as_ref());

        let output = Command::new("sops")
            .args([
                "--encrypt",
                "--input-type", "dotenv",
                "--output-type", "dotenv",
            ])
            .arg(src_file)
            .output()
            .map_err(|e| format!("Failed to run sops: {}", e))?;

        if output.status.success() {
            fs::write(&dest_file, &output.stdout)
                .map_err(|e| format!("Failed to write {}: {}", dest_file.display(), e))?;
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            errors.push(format!("{}: {}", file_name, stderr.trim()));
        }
    }

    sp.finish_and_clear();

    if !errors.is_empty() {
        for err in &errors {
            println!("  {} {}", "✗".red(), err);
        }
        if errors.len() == env_files.len() {
            return Err("All files failed to encrypt.".to_string());
        }
    }

    // Check if there are actual changes to commit
    let status_output = setup_utils::run_git(
        &vault_dir_str,
        &["status", "--porcelain", "envs/"],
    )?;

    if status_output.trim().is_empty() {
        setup_utils::done("No changes to push — vault is already up to date.");
        return Ok(());
    }

    // Git add, commit, push
    let envs_path = format!("envs/{}", project_id);
    let commit_msg = format!("update env: {}", project_id);

    // Also commit .sops.yaml if it was modified
    let sops_status = setup_utils::run_git(
        &vault_dir_str,
        &["status", "--porcelain", ".sops.yaml"],
    ).unwrap_or_default();

    let mut files_to_add: Vec<&str> = vec![&envs_path];
    if !sops_status.trim().is_empty() {
        files_to_add.push(".sops.yaml");
    }

    setup_utils::git_commit_and_push(
        &vault_dir_str,
        &files_to_add,
        &commit_msg,
    )?;

    let pushed_count = env_files.len() - errors.len();
    println!(
        "\n  {} {} .env file(s) pushed for {}",
        "✓".green().bold(),
        pushed_count.to_string().cyan().bold(),
        project_id.cyan()
    );

    Ok(())
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add src/commands/env/push.rs
git commit -m "feat: implement keypick env push command"
```

---

## Chunk 4: Pull Command

### Task 5: Implement `keypick env pull`

**Files:**
- Modify: `src/commands/env/pull.rs`

- [ ] **Step 1: Implement pull.rs**

Replace the placeholder with:

```rust
use colored::*;
use std::env;
use std::fs;
use std::process::Command;

use crate::commands::setup::utils as setup_utils;
use crate::vault;

use super::utils as env_utils;

pub fn run() {
    if let Err(e) = run_inner() {
        eprintln!("{} {}", "Pull failed:".red().bold(), e);
        crate::terminal::cleanup_and_exit(1);
    }
}

fn run_inner() -> Result<(), String> {
    let cwd = env::current_dir()
        .map_err(|e| format!("Cannot read current directory: {}", e))?;

    // Derive project ID
    let (project_id, used_fallback) = env_utils::derive_project_id(&cwd)?;
    if used_fallback {
        println!(
            "  {} {}",
            "!".yellow().bold(),
            format!(
                "No git remote found. Using folder name '{}' as project identifier.",
                project_id
            ).dimmed()
        );
    }
    println!(
        "  {} {}",
        "Project:".dimmed(),
        project_id.cyan().bold()
    );

    // Resolve vault and pull latest
    let vault_dir = vault::vault_dir();
    let vault_dir_str = vault_dir.display().to_string();

    let sp = setup_utils::spinner("Pulling latest from vault...");
    let _ = setup_utils::run_git(&vault_dir_str, &["pull"]);
    sp.finish_and_clear();

    // Check if project exists in vault
    let src_dir = env_utils::envs_dir(&vault_dir, &project_id);
    if !src_dir.exists() {
        return Err(format!(
            "No .env files stored for project '{}'.\n  \
             Push first with: keypick env push",
            project_id
        ));
    }

    // Find encrypted .env files in vault
    let entries: Vec<_> = fs::read_dir(&src_dir)
        .map_err(|e| format!("Failed to read {}: {}", src_dir.display(), e))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(".env")
        })
        .collect();

    if entries.is_empty() {
        return Err(format!(
            "No .env files found in vault for project '{}'.",
            project_id
        ));
    }

    // Decrypt each file and write to CWD
    let sp = setup_utils::spinner("Decrypting .env files...");
    let mut written = Vec::new();
    let mut errors = Vec::new();

    for entry in &entries {
        let file_name = entry.file_name();
        let file_name_str = file_name.to_string_lossy();
        let src_path = entry.path();
        let dest_path = cwd.join(file_name_str.as_ref());

        let existed = dest_path.exists();

        let output = Command::new("sops")
            .args([
                "--decrypt",
                "--input-type", "dotenv",
                "--output-type", "dotenv",
            ])
            .arg(&src_path)
            .output()
            .map_err(|e| format!("Failed to run sops: {}", e))?;

        if output.status.success() {
            fs::write(&dest_path, &output.stdout)
                .map_err(|e| format!("Failed to write {}: {}", dest_path.display(), e))?;
            written.push((file_name_str.to_string(), existed));
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            errors.push(format!("{}: {}", file_name_str, stderr.trim()));
        }
    }

    sp.finish_and_clear();

    // Report results
    for (name, existed) in &written {
        let action = if *existed { "overwritten" } else { "created" };
        println!(
            "  {} {} ({})",
            "✓".green().bold(),
            name.cyan(),
            action.dimmed()
        );
    }

    for err in &errors {
        println!("  {} {}", "✗".red(), err);
    }

    if written.is_empty() {
        return Err("All files failed to decrypt.".to_string());
    }

    println!(
        "\n  {} {} .env file(s) pulled for {}",
        "✓".green().bold(),
        written.len().to_string().cyan().bold(),
        project_id.cyan()
    );

    Ok(())
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add src/commands/env/pull.rs
git commit -m "feat: implement keypick env pull command"
```

---

## Chunk 5: Status Command

### Task 6: Implement `keypick env status`

**Files:**
- Modify: `src/commands/env/status.rs`

- [ ] **Step 1: Implement status.rs**

Replace the placeholder with:

```rust
use colored::*;
use std::env;
use std::fs;

use crate::commands::setup::utils as setup_utils;
use crate::vault;

use super::utils as env_utils;

pub fn run() {
    if let Err(e) = run_inner() {
        eprintln!("{} {}", "Status failed:".red().bold(), e);
        crate::terminal::cleanup_and_exit(1);
    }
}

fn run_inner() -> Result<(), String> {
    let cwd = env::current_dir()
        .map_err(|e| format!("Cannot read current directory: {}", e))?;

    // Derive project ID
    let (project_id, used_fallback) = env_utils::derive_project_id(&cwd)?;
    if used_fallback {
        println!(
            "  {} {}",
            "!".yellow().bold(),
            format!(
                "No git remote found. Using folder name '{}' as project identifier.",
                project_id
            ).dimmed()
        );
    }
    println!(
        "  {} {}",
        "Project:".dimmed(),
        project_id.cyan().bold()
    );

    // Resolve vault and fetch latest (best-effort)
    let vault_dir = vault::vault_dir();
    let vault_dir_str = vault_dir.display().to_string();

    let sp = setup_utils::spinner("Fetching latest...");
    let fetch_failed = setup_utils::run_git(&vault_dir_str, &["fetch"]).is_err();
    sp.finish_and_clear();
    if fetch_failed {
        println!(
            "  {} {}",
            "!".yellow().bold(),
            "Could not fetch latest — showing local vault state.".dimmed()
        );
    }

    // Check vault for this project
    let vault_env_dir = env_utils::envs_dir(&vault_dir, &project_id);
    let vault_files: Vec<String> = if vault_env_dir.exists() {
        fs::read_dir(&vault_env_dir)
            .map_err(|e| format!("Failed to read vault envs: {}", e))?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with(".env"))
            .collect()
    } else {
        Vec::new()
    };

    // Check local .env files
    let local_files: Vec<String> = env_utils::discover_env_files(&cwd)
        .iter()
        .filter_map(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .collect();

    // Compare
    let in_both: Vec<&String> = local_files.iter().filter(|f| vault_files.contains(f)).collect();
    let local_only: Vec<&String> = local_files.iter().filter(|f| !vault_files.contains(f)).collect();
    let vault_only: Vec<&String> = vault_files.iter().filter(|f| !local_files.contains(f)).collect();

    println!();

    if vault_files.is_empty() && local_files.is_empty() {
        println!(
            "  {} No .env files found locally or in the vault.",
            "·".dimmed()
        );
        return Ok(());
    }

    if !in_both.is_empty() {
        println!("  {} Synced (in vault and local):", "■".green());
        for f in &in_both {
            println!("    {}", f.cyan());
        }
    }

    if !local_only.is_empty() {
        println!("  {} Local only (not pushed):", "■".yellow());
        for f in &local_only {
            println!("    {}", f.yellow());
        }
    }

    if !vault_only.is_empty() {
        println!("  {} Vault only (not pulled):", "■".blue());
        for f in &vault_only {
            println!("    {}", f.blue());
        }
    }

    println!();
    Ok(())
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add src/commands/env/status.rs
git commit -m "feat: implement keypick env status command"
```

---

## Chunk 6: Interactive Menu & Setup Integration

### Task 7: Add env entries to interactive menu

**Files:**
- Modify: `src/commands/interactive.rs:1-28`

- [ ] **Step 1: Add menu entries**

Add "Push .env files" and "Pull .env files" to the menu options vector, before "Exit":

```rust
use colored::*;
use inquire::Select;

/// Full interactive mode (no subcommand given — just run `keypick`)
pub fn run() {
    let action = Select::new(
        "What would you like to do?",
        vec![
            "Extract keys to .env",
            "Add / Update a key group",
            "List vault contents",
            "Copy a key to clipboard",
            "Push .env files to vault",
            "Pull .env files from vault",
            "Exit",
        ],
    )
    .prompt()
    .unwrap_or_else(|_| "Exit");

    println!();

    match action {
        "Extract keys to .env" => super::extract::run(),
        "Add / Update a key group" => super::add::run(),
        "List vault contents" => super::list::run(),
        "Copy a key to clipboard" => super::copy::run(),
        "Push .env files to vault" => super::env::push::run(),
        "Pull .env files from vault" => super::env::pull::run(),
        _ => println!("{}", "Goodbye!".dimmed()),
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add src/commands/interactive.rs
git commit -m "feat: add env push/pull to interactive menu"
```

---

### Task 8: Update setup/init.rs to include envs creation rule

**Files:**
- Modify: `src/commands/setup/init.rs:59-61`

- [ ] **Step 1: Update .sops.yaml template to include envs rule**

In `src/commands/setup/init.rs`, change the `sops_content` format string at line 59-61 from:

```rust
    let sops_content = format!(
        "creation_rules:\n  - path_regex: vault\\.yaml$\n    age: >-\n      {}\n",
        public_key
    );
```

To:

```rust
    let sops_content = format!(
        "creation_rules:\n  - path_regex: envs/.*\n    age: >-\n      {0}\n  - path_regex: vault\\.yaml$\n    age: >-\n      {0}\n",
        public_key
    );
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add src/commands/setup/init.rs
git commit -m "feat: include envs/.* rule in .sops.yaml for new vaults"
```

---

### Task 9: Update GitHub Actions workflow to cover env files

**Files:**
- Modify: `.github/workflows/vault-sync.yml`

**Note:** This file is the `include_str!` source embedded into `src/commands/setup/actions.rs` at compile time. Modifying this file is sufficient — no separate edit to `actions.rs` is needed. The next `cargo build` will pick up the updated workflow template.

- [ ] **Step 1: Update trigger paths and re-encrypt step**

Update the workflow to trigger on `envs/**` changes and run `sops updatekeys` on env files:

```yaml
name: Sync Vault Recipients

# Trigger whenever the SOPS config, vault, or env files are updated.
on:
  push:
    paths:
      - '.sops.yaml'
      - 'vault.yaml'
      - 'envs/**'

jobs:
  re-encrypt:
    name: Re-encrypt vault for updated recipients
    runs-on: ubuntu-latest

    permissions:
      contents: write  # Needed to push the re-encrypted vault

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install age
        run: |
          AGE_VERSION="1.2.0"
          curl -LO "https://github.com/FiloSottile/age/releases/download/v${AGE_VERSION}/age-v${AGE_VERSION}-linux-amd64.tar.gz"
          tar xzf age-v${AGE_VERSION}-linux-amd64.tar.gz
          sudo mv age/age age/age-keygen /usr/local/bin/

      - name: Install SOPS
        run: |
          SOPS_VERSION="3.9.1"
          curl -LO "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.amd64"
          sudo mv sops-v${SOPS_VERSION}.linux.amd64 /usr/local/bin/sops
          sudo chmod +x /usr/local/bin/sops

      - name: Import GitHub Actions age key
        env:
          SOPS_AGE_KEY: ${{ secrets.SOPS_AGE_KEY }}
        run: |
          mkdir -p ~/.config/sops/age
          echo "$SOPS_AGE_KEY" > ~/.config/sops/age/keys.txt
          chmod 600 ~/.config/sops/age/keys.txt

      - name: Re-encrypt vault for all recipients in .sops.yaml
        run: |
          sops updatekeys -y vault.yaml
          echo "Vault successfully re-encrypted."

      - name: Re-encrypt env files for all recipients
        run: |
          if [ -d "envs" ]; then
            find envs -name ".env*" -type f | while read -r envfile; do
              echo "Updating keys for: $envfile"
              sops updatekeys -y "$envfile" || echo "Warning: failed to update $envfile"
            done
            echo "Env files re-encrypted."
          else
            echo "No envs directory found, skipping."
          fi

      - name: Commit updated vault
        uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "ci: auto-sync vault recipients from .sops.yaml [skip ci]"
          file_pattern: "vault.yaml envs/"
          commit_user_name: "KeyPick Bot"
          commit_user_email: "actions@github.com"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/vault-sync.yml
git commit -m "feat: update vault-sync workflow to cover env files"
```

---

## Chunk 7: Build & Smoke Test

### Task 10: Full build and manual smoke test

- [ ] **Step 1: Run all unit tests**

Run: `cargo test`
Expected: All tests pass (including the 5 URL normalization tests)

- [ ] **Step 2: Build release binary**

Run: `cargo build`
Expected: Compiles with no errors or warnings (except possibly unused import warnings)

- [ ] **Step 3: Smoke test CLI help**

Run: `cargo run -- env --help`
Expected: Shows Push, Pull, Status subcommands with descriptions

Run: `cargo run -- env push --help`
Expected: Shows push help

- [ ] **Step 4: Commit any final fixes if needed**

If any compilation issues are found, fix and commit with descriptive message.
