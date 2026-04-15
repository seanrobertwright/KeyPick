use crate::commands::setup::utils;
use crate::vault;
use colored::*;
use inquire::Text;
use std::fs;
use std::path::Path;
use std::process::Command;

pub fn run(public_key: &str, verbose: bool) -> Result<(), String> {
    let has_gh = utils::command_exists("gh");

    if verbose {
        utils::explain(&[
            "JOINING AN EXISTING VAULT",
            "",
            "You already have a vault set up on another machine. We need to:",
            "  1. Clone (or locate) your existing vault repository",
            "  2. Add this machine's public key to .sops.yaml",
            "  3. Re-encrypt the vault so this machine can decrypt it",
            "  4. Commit and push so other machines see the change",
            "",
            "After this, you can use all keypick commands from this machine.",
        ]);
    }

    let vault_dir = if has_gh {
        join_with_gh(verbose)?
    } else {
        join_manual(verbose)?
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

    if verbose {
        utils::explain(&[
            "CHECKING RECIPIENTS",
            "",
            "The .sops.yaml file lists every public key that can decrypt",
            "the vault. Each key represents a machine (or GitHub Actions,",
            "or a recovery key). We'll check if this machine's key is",
            "already in the list.",
        ]);
    }

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
        if verbose {
            utils::explain(&[
                "ADDING THIS MACHINE AS A RECIPIENT",
                "",
                "Your public key is not yet in .sops.yaml, so we'll add it.",
                "Then we run `sops updatekeys -y vault.yaml` which tells sops",
                "to re-encrypt the vault for ALL recipients (including this",
                "new machine). This requires that the current machine running",
                "the command can already decrypt the vault (which it can,",
                "because we're inside the cloned repo from the original machine).",
                "",
                "After re-encryption, we commit and push so other machines",
                "can pull the updated vault.",
            ]);
        }

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
        utils::git_commit_and_push(
            &vault_dir,
            &[".sops.yaml", "vault.yaml"],
            "feat: add new machine to vault recipients",
        )?;
    }

    println!(
        "\n  {} {}",
        "Vault directory:".dimmed(),
        vault_dir.cyan().bold()
    );
    println!("  {}", "KeyPick will remember this vault selection.".dimmed());

    Ok(())
}

fn join_with_gh(verbose: bool) -> Result<String, String> {
    let vault_home = vault::vaults_home_dir();
    fs::create_dir_all(&vault_home)
        .map_err(|e| format!("Failed to create {}: {}", vault_home.display(), e))?;

    if verbose {
        utils::explain(&[
            "The GitHub CLI (`gh`) is available, so you can clone your",
            "vault repo by providing the 'owner/repo' format.",
            "Example: myusername/my-keys",
        ]);
    }
    let repo = Text::new("GitHub repo to clone? (e.g. username/my-keys)")
        .with_help_message("Your private vault repository")
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    let repo_name = repo.split('/').last().unwrap_or(&repo);

    let sp = utils::spinner("Cloning repository...");
    let result = Command::new("gh")
        .args(["repo", "clone", &repo])
        .current_dir(&vault_home)
        .output()
        .map_err(|e| format!("Failed to run `gh`: {}", e))
        .and_then(|output| {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
            }
        });
    sp.finish_and_clear();

    match result {
        Ok(_) => {
            let dir = vault_home.join(repo_name);
            let _ = vault::remember_vault_dir(&dir);
            utils::done(&format!("Cloned {}", repo));
            Ok(dir.display().to_string())
        }
        Err(e) => Err(format!("Clone failed: {}", e)),
    }
}

fn join_manual(verbose: bool) -> Result<String, String> {
    let default_dir = vault::vaults_home_dir().display().to_string();
    if verbose {
        utils::explain(&[
            "Provide either:",
            "  • A git clone URL (e.g. git@github.com:user/my-keys.git)",
            "  • A local path to an already-cloned vault repo",
            "",
            &format!("New clones are stored under: {}", default_dir),
        ]);
    }
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
        let vault_home = vault::vaults_home_dir();
        fs::create_dir_all(&vault_home)
            .map_err(|e| format!("Failed to create {}: {}", vault_home.display(), e))?;

        let sp = utils::spinner("Cloning repository...");
        let output = Command::new("git")
            .args(["clone", &input])
            .current_dir(&vault_home)
            .output()
            .map_err(|e| format!("git clone failed: {}", e))?;
        sp.finish_and_clear();

        if !output.status.success() {
            return Err(format!(
                "Clone failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let dir = vault_home.join(repo_name);
        let _ = vault::remember_vault_dir(&dir);
        utils::done(&format!("Cloned to {}", dir.display()));
        Ok(dir.display().to_string())
    } else {
        if !Path::new(&input).exists() {
            return Err(format!("Directory {} does not exist", input));
        }
        let _ = vault::remember_vault_dir(Path::new(&input));
        Ok(input)
    }
}
