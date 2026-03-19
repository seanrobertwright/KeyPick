use crate::commands::setup::utils;
use colored::*;
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

const VAULT_SYNC_WORKFLOW: &str = include_str!("../../../.github/workflows/vault-sync.yml");

pub fn run(verbose: bool) {
    if let Err(e) = run_inner(verbose) {
        eprintln!("{} {}", "GitHub Actions setup failed:".red().bold(), e);
    }
}

fn run_inner(verbose: bool) -> Result<(), String> {
    if verbose {
        utils::explain(&[
            "GITHUB ACTIONS AUTO-SYNC",
            "",
            "This sets up a CI workflow that solves a key problem:",
            "when you add a new machine, you update .sops.yaml with its",
            "public key. But the vault.yaml is still encrypted for the",
            "OLD set of recipients — the new machine can't decrypt it yet.",
            "",
            "The workflow watches for changes to .sops.yaml. When it",
            "detects a change, it runs `sops updatekeys` to re-encrypt",
            "the vault for ALL current recipients, then commits and pushes.",
            "",
            "This requires:",
            "  • The `gh` CLI (to set a GitHub Actions secret)",
            "  • A separate age keypair just for GitHub Actions",
        ]);
    }

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
    if verbose {
        utils::explain(&[
            "STEP 1: Generate a dedicated age keypair for GitHub Actions.",
            "",
            "This key is separate from your machine keys. Its private key",
            "will be stored as a GitHub Actions secret (SOPS_AGE_KEY).",
            "Its public key will be added to .sops.yaml so the workflow",
            "can decrypt and re-encrypt the vault.",
        ]);
    }
    let sp = utils::spinner("Generating GitHub Actions age key...");
    let tmp_dir = tempfile::tempdir()
        .map_err(|e| format!("Temp dir error: {}", e))?;
    let key_path = tmp_dir.path().join("actions_key.txt");

    let output = Command::new("age-keygen")
        .args(["-o", &key_path.to_string_lossy()])
        .output()
        .map_err(|e| format!("age-keygen failed: {}", e))?;
    sp.finish_and_clear();

    if !output.status.success() {
        return Err(format!(
            "age-keygen failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let key_content = fs::read_to_string(&key_path)
        .map_err(|e| format!("Failed to read generated key: {}", e))?;
    let pubkey = utils::read_public_key(&key_path)?;

    utils::done(&format!(
        "Generated Actions key: {}...",
        utils::short_key(&pubkey, 24).cyan()
    ));

    // Step 2: Add public key to .sops.yaml
    if verbose {
        utils::explain(&[
            "STEP 2: Add the Actions public key to .sops.yaml.",
            "",
            "This registers GitHub Actions as a vault recipient,",
            "giving the workflow permission to decrypt the vault",
            "during re-encryption runs.",
        ]);
    }
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
    if verbose {
        utils::explain(&[
            "STEP 3: Store the Actions PRIVATE key as a GitHub secret.",
            "",
            "The private key is piped to `gh secret set SOPS_AGE_KEY`.",
            "GitHub encrypts it with libsodium and stores it securely.",
            "It's only available to workflows running in your repo —",
            "it never appears in logs or the GitHub UI after being set.",
        ]);
    }
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
    if verbose {
        utils::explain(&[
            "STEP 4: Install the GitHub Actions workflow file.",
            "",
            "This creates .github/workflows/vault-sync.yml in your repo.",
            "The workflow triggers on pushes that change .sops.yaml or",
            "vault.yaml. It downloads age + sops, imports the secret key,",
            "runs `sops updatekeys -y vault.yaml`, and auto-commits the",
            "re-encrypted vault.",
        ]);
    }
    let sp = utils::spinner("Installing workflow file...");
    fs::create_dir_all(".github/workflows")
        .map_err(|e| format!("Failed to create .github/workflows: {}", e))?;
    fs::write(".github/workflows/vault-sync.yml", VAULT_SYNC_WORKFLOW)
        .map_err(|e| format!("Failed to write workflow: {}", e))?;
    sp.finish_and_clear();
    utils::done("Installed .github/workflows/vault-sync.yml");

    // Step 5: Commit and push
    if verbose {
        utils::explain(&[
            "STEP 5: Commit and push the workflow + updated .sops.yaml.",
            "",
            "This makes the workflow active on GitHub. The next time",
            ".sops.yaml or vault.yaml is pushed, the workflow will run",
            "and re-encrypt the vault for all recipients.",
        ]);
    }
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
