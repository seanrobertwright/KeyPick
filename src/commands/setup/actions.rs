use crate::commands::setup::utils;
use colored::*;
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

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
    let remote_url = utils::run_cmd("git", &["remote", "get-url", "origin"])
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
        utils::short_key(&pubkey, 24).cyan()
    ));

    // Step 2: Add public key to .sops.yaml
    let sp = utils::spinner("Adding Actions key to .sops.yaml...");
    let sops_content = fs::read_to_string(".sops.yaml")
        .map_err(|e| format!("Failed to read .sops.yaml: {}", e))?;

    if sops_content.contains(&pubkey) {
        sp.finish_and_clear();
        utils::skip("Actions key already in .sops.yaml");
    } else {
        let updated = utils::add_recipient(&sops_content, &pubkey)?;
        fs::write(".sops.yaml", &updated)
            .map_err(|e| format!("Failed to write .sops.yaml: {}", e))?;
        sp.finish_and_clear();
        utils::done("Added Actions key to .sops.yaml");
    }

    // Step 3: Set GitHub secret
    let sp = utils::spinner("Setting SOPS_AGE_KEY secret on GitHub...");
    let mut child = Command::new("gh")
        .args(["secret", "set", "SOPS_AGE_KEY"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run gh: {}", e))?;

    if let Some(ref mut stdin) = child.stdin {
        stdin
            .write_all(key_content.as_bytes())
            .map_err(|e| format!("Failed to write secret: {}", e))?;
    }
    drop(child.stdin.take());

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
    let _ = utils::run_cmd("git", &["add", ".github", ".sops.yaml"]);
    let _ = utils::run_cmd("git", &["commit", "-m", "feat: add GitHub Actions auto re-encryption"]);
    let push_result = utils::run_cmd("git", &["push"]);
    sp.finish_and_clear();

    match push_result {
        Ok(_) => utils::done("Pushed to remote"),
        Err(_) => utils::warn("Push failed - you can push manually later"),
    }

    // Temp file is automatically cleaned up when dropped
    println!(
        "\n  {} {}",
        "Done!".green().bold(),
        "The workflow will auto re-encrypt vault.yaml when .sops.yaml changes.".dimmed()
    );

    Ok(())
}
