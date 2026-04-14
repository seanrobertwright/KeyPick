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
