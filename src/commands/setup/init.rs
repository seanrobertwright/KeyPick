use crate::commands::setup::utils;
use colored::*;
use inquire::{Confirm, Text};
use std::fs;
use std::path::Path;
use std::process::Command;

pub fn run(public_key: &str) -> Result<(), String> {
    let has_gh = utils::command_exists("gh");

    let repo_name = Text::new("Vault repo name?")
        .with_default("my-keys")
        .with_help_message("This will be a private Git repo for your encrypted secrets")
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    let vault_dir = if has_gh {
        init_with_gh(&repo_name)?
    } else {
        init_manual(&repo_name)?
    };

    // Create .sops.yaml
    let sops_path = Path::new(&vault_dir).join(".sops.yaml");
    let sp = utils::spinner("Creating SOPS config...");
    let sops_content = format!(
        "creation_rules:\n  - path_regex: vault\\.yaml$\n    age: >-\n      {}\n",
        public_key
    );
    fs::write(&sops_path, &sops_content)
        .map_err(|e| format!("Failed to write .sops.yaml: {}", e))?;
    sp.finish_and_clear();
    utils::done("Created .sops.yaml");

    // Create and encrypt vault.yaml
    let vault_path = Path::new(&vault_dir).join("vault.yaml");
    let sp = utils::spinner("Creating encrypted vault...");
    fs::write(&vault_path, "services: {}\n")
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

    // Git add and commit
    let sp = utils::spinner("Committing...");
    utils::run_git(&vault_dir, &["add", ".sops.yaml", "vault.yaml"])?;
    utils::run_git(&vault_dir, &["commit", "-m", "feat: initialize encrypted vault"])?;
    sp.finish_and_clear();
    utils::done("Initial commit created");

    // Try to push
    if utils::has_remote(&vault_dir) {
        let sp = utils::spinner("Pushing to remote...");
        // Try main first, then master
        let result = utils::run_git(&vault_dir, &["push", "-u", "origin", "main"]);
        if result.is_err() {
            let _ = utils::run_git(&vault_dir, &["push", "-u", "origin", "master"]);
        }
        sp.finish_and_clear();
        utils::done("Pushed to remote");
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

fn init_with_gh(repo_name: &str) -> Result<String, String> {
    let create_remote = Confirm::new("Create a private GitHub repo automatically?")
        .with_default(true)
        .with_help_message("Requires `gh` CLI to be authenticated")
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    if create_remote {
        let sp = utils::spinner("Creating private GitHub repo...");
        let result = utils::run_cmd(
            "gh",
            &["repo", "create", repo_name, "--private", "--clone"],
        );
        sp.finish_and_clear();

        match result {
            Ok(_) => {
                utils::done(&format!("Created and cloned {}", repo_name));
                Ok(repo_name.to_string())
            }
            Err(e) => {
                utils::warn(&format!("gh repo create failed: {}", e));
                utils::warn("Falling back to manual setup...");
                init_manual(repo_name)
            }
        }
    } else {
        init_manual(repo_name)
    }
}

fn init_manual(repo_name: &str) -> Result<String, String> {
    let dir = Text::new("Local directory for the vault repo?")
        .with_default(repo_name)
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    // Init git if not already a repo
    let git_dir = Path::new(&dir).join(".git");
    if !git_dir.exists() {
        let sp = utils::spinner("Initializing git repository...");
        utils::run_git(&dir, &["init"])?;
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
