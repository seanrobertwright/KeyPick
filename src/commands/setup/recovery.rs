use crate::commands::setup::utils;
use colored::*;
use inquire::Password;
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

pub fn run() {
    if let Err(e) = run_inner() {
        eprintln!("{} {}", "Recovery key setup failed:".red().bold(), e);
    }
}

fn run_inner() -> Result<(), String> {
    println!(
        "\n  {}",
        "A recovery key lets you regain access if you lose all your machines.".dimmed()
    );
    println!(
        "  {}\n",
        "You'll set a passphrase to protect it.".dimmed()
    );

    // Step 1: Generate keypair
    let sp = utils::spinner("Generating recovery keypair...");
    let keygen_output = Command::new("age-keygen")
        .output()
        .map_err(|e| format!("age-keygen failed: {}", e))?;
    sp.finish_and_clear();

    if !keygen_output.status.success() {
        return Err("age-keygen failed".to_string());
    }

    let key_material = String::from_utf8_lossy(&keygen_output.stdout).to_string();
    let stderr_text = String::from_utf8_lossy(&keygen_output.stderr).to_string();

    // Extract public key from stderr (age-keygen prints it there)
    let pubkey = stderr_text
        .lines()
        .find(|l| l.starts_with("Public key: "))
        .map(|l| l.trim_start_matches("Public key: ").trim().to_string())
        .ok_or("Could not extract public key from age-keygen output")?;

    utils::done(&format!(
        "Generated recovery key: {}...",
        utils::short_key(&pubkey, 24).cyan()
    ));

    // Step 2: Get passphrase (masked input)
    let passphrase = Password::new("Enter a strong passphrase for the recovery key:")
        .with_help_message("This protects the key file. Use something memorable but strong.")
        .with_display_mode(inquire::PasswordDisplayMode::Masked)
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    let confirm = Password::new("Confirm passphrase:")
        .with_display_mode(inquire::PasswordDisplayMode::Masked)
        .without_confirmation()
        .prompt()
        .map_err(|_| "Cancelled".to_string())?;

    if passphrase != confirm {
        return Err("Passphrases don't match".to_string());
    }

    // Step 3: Encrypt private key with passphrase using age -p
    let sp = utils::spinner("Encrypting recovery key with passphrase...");

    // Try AGE_PASSPHRASE env var first (supported in age 1.1+)
    let mut child = Command::new("age")
        .args(["-e", "-p"])
        .env("AGE_PASSPHRASE", &passphrase)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run age: {}", e))?;

    {
        let stdin = child.stdin.as_mut().expect("Failed to open age stdin");
        stdin
            .write_all(key_material.as_bytes())
            .map_err(|e| format!("Failed to write to age stdin: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("age encrypt failed: {}", e))?;

    sp.finish_and_clear();

    if output.status.success() {
        fs::write("recovery_key.age", &output.stdout)
            .map_err(|e| format!("Failed to write recovery_key.age: {}", e))?;
    } else {
        // Fallback: AGE_PASSPHRASE not supported, run interactively
        utils::warn("Automatic passphrase entry not supported. Running interactively...");
        println!(
            "  {}",
            "Enter your passphrase when prompted by age:".dimmed()
        );

        // Write key to temp file, pipe into age
        let tmp = tempfile::NamedTempFile::new()
            .map_err(|e| format!("Temp file error: {}", e))?;
        fs::write(tmp.path(), &key_material)
            .map_err(|e| format!("Failed to write temp key: {}", e))?;

        let status = Command::new("age")
            .args(["-e", "-p", "-o", "recovery_key.age"])
            .stdin(Stdio::from(
                fs::File::open(tmp.path())
                    .map_err(|e| format!("Failed to open temp key: {}", e))?,
            ))
            .status()
            .map_err(|e| format!("age failed: {}", e))?;

        if !status.success() {
            return Err("Failed to encrypt recovery key".to_string());
        }
    }

    utils::done("Encrypted recovery key saved to recovery_key.age");

    // Step 4: Add recovery public key to .sops.yaml
    if std::path::Path::new(".sops.yaml").exists() {
        let sp = utils::spinner("Adding recovery key to .sops.yaml...");
        let content = fs::read_to_string(".sops.yaml")
            .map_err(|e| format!("Failed to read .sops.yaml: {}", e))?;

        if !content.contains(&pubkey) {
            let updated = utils::add_recipient(&content, &pubkey)?;
            fs::write(".sops.yaml", &updated)
                .map_err(|e| format!("Failed to write .sops.yaml: {}", e))?;
        }
        sp.finish_and_clear();
        utils::done("Added recovery key to .sops.yaml recipients");

        // Re-encrypt vault
        if std::path::Path::new("vault.yaml").exists() {
            let sp = utils::spinner("Re-encrypting vault...");
            let _ = Command::new("sops")
                .args(["updatekeys", "-y", "vault.yaml"])
                .output();
            sp.finish_and_clear();
            utils::done("Vault re-encrypted with recovery key");
        }

        // Commit
        let sp = utils::spinner("Committing...");
        let _ = utils::run_cmd("git", &["add", ".sops.yaml", "vault.yaml"]);
        let _ = utils::run_cmd(
            "git",
            &["commit", "-m", "feat: add recovery key to vault recipients"],
        );
        let _ = utils::run_cmd("git", &["push"]);
        sp.finish_and_clear();
        utils::done("Changes committed and pushed");
    }

    // Step 5: Storage instructions
    println!("\n  {}", "-- Recovery Key Storage --".yellow().bold());
    println!(
        "  {} Upload {} to cloud storage (e.g. Google Drive)",
        "1.".cyan().bold(),
        "recovery_key.age".cyan()
    );
    println!(
        "  {} Write the passphrase on paper, store in a safe/lockbox",
        "2.".cyan().bold()
    );
    println!(
        "  {} {}",
        "WARNING:".yellow().bold(),
        "Store the FILE and PASSPHRASE in SEPARATE physical locations!".yellow()
    );
    println!(
        "  {} Delete recovery_key.age from this machine after uploading\n",
        "3.".cyan().bold()
    );

    Ok(())
}
