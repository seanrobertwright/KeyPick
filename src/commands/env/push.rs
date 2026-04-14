use colored::*;
use std::env;
use std::fs;
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
