use crate::commands::setup::utils;
use crate::vault;
use colored::*;
use inquire::{Confirm, Text};
use std::fs;
use std::path::Path;
use std::process::Command;

pub fn run(public_key: &str, verbose: bool) -> Result<(), String> {
    let has_gh = utils::command_exists("gh");

    if verbose {
        utils::explain(&[
            "CREATING A NEW VAULT",
            "",
            "You'll choose a name for your vault repository. This becomes",
            "a Git repo containing your encrypted secrets. The default",
            "name is 'my-keys' but you can call it anything.",
            "",
            "By default, KeyPick stores vault repos in your per-user vault home:",
            &format!("  {}", vault::vaults_home_dir().display()),
            "",
            "If the GitHub CLI (`gh`) is installed and authenticated, we",
            "can create a PRIVATE GitHub repo automatically. Otherwise,",
            "we'll create a local Git repo and you can add a remote later.",
        ]);
    }

    let repo_name = Text::new("Vault repo name?")
        .with_default("my-keys")
        .with_help_message("This will be a private Git repo for your encrypted secrets")
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    let vault_dir = if has_gh {
        init_with_gh(&repo_name, verbose)?
    } else {
        init_manual(&repo_name, verbose)?
    };

    // Create .sops.yaml
    if verbose {
        utils::explain(&[
            "CREATING .sops.yaml",
            "",
            "This file tells sops HOW to encrypt your vault:",
            "  • path_regex — which files to encrypt (vault.yaml)",
            "  • age — the list of public keys that can decrypt it",
            "",
            "Right now, only this machine's public key is listed.",
            "When you add more machines or set up GitHub Actions,",
            "their public keys get appended here too.",
            "",
            "This file is safe to commit — it contains only PUBLIC keys.",
        ]);
    }
    let sops_path = Path::new(&vault_dir).join(".sops.yaml");
    let sp = utils::spinner("Creating SOPS config...");
    let sops_content = format!(
        "creation_rules:\n  - path_regex: envs/.*\n    age: >-\n      {0}\n  - path_regex: vault\\.yaml$\n    age: >-\n      {0}\n",
        public_key
    );
    fs::write(&sops_path, &sops_content)
        .map_err(|e| format!("Failed to write .sops.yaml: {}", e))?;
    sp.finish_and_clear();
    utils::done("Created .sops.yaml");

    // Create and encrypt vault.yaml
    if verbose {
        utils::explain(&[
            "CREATING vault.yaml",
            "",
            "This is your actual secrets file. It starts empty (just",
            "'services: {}') and gets encrypted in-place by sops.",
            "",
            "After encryption, the file will contain age-encrypted data",
            "that only holders of the private keys listed in .sops.yaml",
            "can decrypt. The command `sops -e -i vault.yaml` encrypts",
            "the file in-place.",
        ]);
    }
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
    if verbose {
        utils::explain(&[
            "COMMITTING TO GIT",
            "",
            "We commit both .sops.yaml and the encrypted vault.yaml",
            "to Git. This is your initial commit. From here on, every",
            "change to the vault (adding keys, adding machines) will",
            "be a new commit you can push/pull across machines.",
        ]);
    }
    let sp = utils::spinner("Committing...");
    utils::run_git(&vault_dir, &["add", ".sops.yaml", "vault.yaml"])?;
    utils::run_git(&vault_dir, &["commit", "-m", "feat: initialize encrypted vault"])?;
    sp.finish_and_clear();
    utils::done("Initial commit created");

    // Try to push
    if utils::has_remote(&vault_dir) {
        if verbose {
            utils::explain(&[
                "PUSHING TO REMOTE",
                "",
                "Pushing the initial commit to GitHub so your vault",
                "is backed up and accessible from other machines.",
            ]);
        }
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

fn init_with_gh(repo_name: &str, verbose: bool) -> Result<String, String> {
    let vault_home = vault::vaults_home_dir();
    fs::create_dir_all(&vault_home)
        .map_err(|e| format!("Failed to create {}: {}", vault_home.display(), e))?;

    if verbose {
        utils::explain(&[
            "The GitHub CLI (`gh`) is available. We can create a private",
            "repo on GitHub and clone it locally in one step. This runs:",
            &format!("  (from {}) gh repo create {} --private --clone", vault_home.display(), repo_name),
            "",
            "If you decline, we'll create a local-only Git repo instead.",
        ]);
    }
    let create_remote = Confirm::new("Create a private GitHub repo automatically?")
        .with_default(true)
        .with_help_message("Requires `gh` CLI to be authenticated")
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    if create_remote {
        let sp = utils::spinner("Creating private GitHub repo...");
        let result = Command::new("gh")
            .args(["repo", "create", repo_name, "--private", "--clone"])
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
                utils::done(&format!("Created and cloned {}", repo_name));
                Ok(dir.display().to_string())
            }
            Err(e) => {
                utils::warn(&format!("gh repo create failed: {}", e));
                utils::warn("Falling back to manual setup...");
                init_manual(repo_name, verbose)
            }
        }
    } else {
        init_manual(repo_name, verbose)
    }
}

fn init_manual(repo_name: &str, verbose: bool) -> Result<String, String> {
    let default_dir = vault::default_vault_dir(repo_name);
    let default_dir_display = default_dir.display().to_string();
    if verbose {
        utils::explain(&[
            "MANUAL REPO SETUP",
            "",
            "We'll create a local Git repository. You can add a remote",
            "later by creating a private repo on GitHub (or any Git host)",
            "and running `git remote add origin <url>`.",
        ]);
    }
    let dir = Text::new("Local directory for the vault repo?")
        .with_default(&default_dir_display)
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

    let _ = vault::remember_vault_dir(Path::new(&dir));
    Ok(dir)
}
