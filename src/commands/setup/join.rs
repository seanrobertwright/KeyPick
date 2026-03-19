use crate::commands::setup::utils;
use colored::*;
use inquire::Text;
use std::fs;
use std::path::Path;
use std::process::Command;

pub fn run(public_key: &str) -> Result<(), String> {
    let has_gh = utils::command_exists("gh");

    let vault_dir = if has_gh {
        join_with_gh()?
    } else {
        join_manual()?
    };

    // Verify .sops.yaml exists
    let sops_path = Path::new(&vault_dir).join(".sops.yaml");
    if !sops_path.exists() {
        return Err(format!(
            "No .sops.yaml found in {}. Is this the right repo?",
            vault_dir
        ));
    }

    // Show current recipients
    let content = fs::read_to_string(&sops_path)
        .map_err(|e| format!("Failed to read .sops.yaml: {}", e))?;

    println!("\n  {}", "Current recipients:".dimmed());
    for line in content.lines() {
        let trimmed = line.trim().trim_end_matches(',');
        if trimmed.starts_with("age1") {
            println!("    {} {}", "-".dimmed(), utils::short_key(trimmed, 30).cyan());
        }
    }

    // Check if key already present
    if content.contains(public_key) {
        utils::done("This machine's key is already a recipient");
    } else {
        let sp = utils::spinner("Adding this machine's key to recipients...");
        let updated = utils::add_recipient(&content, public_key)?;
        fs::write(&sops_path, &updated)
            .map_err(|e| format!("Failed to write .sops.yaml: {}", e))?;
        sp.finish_and_clear();
        utils::done(&format!(
            "Added key {}... to recipients",
            utils::short_key(public_key, 20).cyan()
        ));

        // Re-encrypt vault with the new recipient
        let vault_yaml = Path::new(&vault_dir).join("vault.yaml");
        if vault_yaml.exists() {
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
        }

        // Commit and push
        let sp = utils::spinner("Committing changes...");
        utils::run_git(&vault_dir, &["add", ".sops.yaml", "vault.yaml"])?;
        utils::run_git(
            &vault_dir,
            &["commit", "-m", "feat: add new machine to vault recipients"],
        )?;
        sp.finish_and_clear();
        utils::done("Changes committed");

        if utils::has_remote(&vault_dir) {
            let sp = utils::spinner("Pushing...");
            let _ = utils::run_git(&vault_dir, &["push"]);
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
    let result = utils::run_cmd("gh", &["repo", "clone", &repo]);
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
        let repo_name = input
            .split('/')
            .last()
            .unwrap_or("my-keys")
            .trim_end_matches(".git");

        let sp = utils::spinner("Cloning repository...");
        let output = Command::new("git")
            .args(["clone", &input])
            .output()
            .map_err(|e| format!("git clone failed: {}", e))?;
        sp.finish_and_clear();

        if !output.status.success() {
            return Err(format!(
                "Clone failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        utils::done(&format!("Cloned to {}/", repo_name));
        Ok(repo_name.to_string())
    } else {
        if !Path::new(&input).exists() {
            return Err(format!("Directory {} does not exist", input));
        }
        Ok(input)
    }
}
