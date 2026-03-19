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
            .expect("Could not determine config directory")
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
pub fn run_cmd(cmd: &str, args: &[&str]) -> Result<String, String> {
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

/// Run a git command in a specific directory.
pub fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
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

/// Check if a git repo has a remote configured.
pub fn has_remote(dir: &str) -> bool {
    run_git(dir, &["remote"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
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
    println!("  {} {}", "–".dimmed(), msg.dimmed());
}

/// Print a walkthrough explanation block.
pub fn explain(lines: &[&str]) {
    println!();
    for line in lines {
        println!("  {} {}", "│".cyan(), line.dimmed());
    }
    println!();
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
        "amd64"
    };

    (os, arch)
}

/// Get a suitable install directory for downloaded binaries.
pub fn install_dir() -> PathBuf {
    // Try user-local bin first
    if let Some(home) = dirs::home_dir() {
        let local_bin = home.join(".local").join("bin");
        if local_bin.exists() {
            return local_bin;
        }
    }

    // Try next to keypick's own executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            return dir.to_path_buf();
        }
    }

    // Create ~/.local/bin as fallback (never use System32)
    if let Some(home) = dirs::home_dir() {
        let local_bin = home.join(".local").join("bin");
        let _ = std::fs::create_dir_all(&local_bin);
        return local_bin;
    }

    PathBuf::from(".")
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

/// Safely truncate a public key for display (avoids panic on short strings).
pub fn short_key(key: &str, len: usize) -> &str {
    key.get(..len).unwrap_or(key)
}

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
