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
