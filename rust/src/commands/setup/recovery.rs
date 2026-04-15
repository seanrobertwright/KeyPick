use crate::commands::setup::utils;
use crate::vault;
use colored::*;
use inquire::Password;
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

pub fn run(verbose: bool) {
    if let Err(e) = run_inner(verbose) {
        eprintln!("{} {}", "Recovery key setup failed:".red().bold(), e);
    }
}

fn run_inner(verbose: bool) -> Result<(), String> {
    let vault_dir = vault::vault_dir();

    println!(
        "\n  {}",
        "A recovery key lets you regain access if you lose all your machines.".dimmed()
    );
    println!(
        "  {}\n",
        "You'll set a passphrase to protect it.".dimmed()
    );

    if verbose {
        utils::explain(&[
            "RECOVERY KEY OVERVIEW",
            "",
            "A recovery key is a safety net. It's an age keypair that:",
            "  • Gets added to .sops.yaml as a vault recipient",
            "  • Is encrypted with a passphrase YOU choose",
            "  • Is saved as 'recovery_key.age' for offline storage",
            "",
            "To recover, you need BOTH the encrypted file AND the passphrase.",
            "This is deliberate — storing them separately means a single",
            "breach (someone finds the file, or someone learns the passphrase)",
            "isn't enough to access your secrets.",
            "",
            "The process:",
            "  1. Generate a fresh age keypair (not tied to any machine)",
            "  2. You choose a strong passphrase",
            "  3. We encrypt the private key with your passphrase",
            "  4. The public key is added to .sops.yaml as a recipient",
            "  5. The vault is re-encrypted to include the recovery key",
        ]);
    }

    // Step 1: Generate keypair
    if verbose {
        utils::explain(&[
            "STEP 1: Generate a recovery age keypair.",
            "",
            "This is an independent keypair, separate from your machine",
            "key. It's generated in memory — the private key will be",
            "encrypted with your passphrase before touching disk.",
        ]);
    }
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
    if verbose {
        utils::explain(&[
            "STEP 2: Choose a passphrase to protect the recovery key.",
            "",
            "This passphrase encrypts the recovery private key. Use",
            "something strong and memorable — you'll need it if you",
            "ever have to recover. Write it on paper and store it",
            "physically (not digitally) in a secure location.",
        ]);
    }
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
    if verbose {
        utils::explain(&[
            "STEP 3: Encrypt the recovery private key with your passphrase.",
            "",
            "We run `age -e -p` which uses scrypt key derivation to turn",
            "your passphrase into an encryption key, then encrypts the",
            "recovery private key. The output is saved as recovery_key.age.",
        ]);
    }
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
        fs::write(vault_dir.join("recovery_key.age"), &output.stdout)
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
            .current_dir(&vault_dir)
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
    if verbose {
        utils::explain(&[
            "STEP 4: Register the recovery key as a vault recipient.",
            "",
            "We add the recovery public key to .sops.yaml and re-encrypt",
            "the vault. This means the recovery key can now decrypt the",
            "vault — but only after YOU decrypt the recovery key itself",
            "with your passphrase.",
        ]);
    }
    let sops_path = vault_dir.join(".sops.yaml");
    let vault_path = vault_dir.join("vault.yaml");

    if sops_path.exists() {
        let sp = utils::spinner("Adding recovery key to .sops.yaml...");
        let content = fs::read_to_string(&sops_path)
            .map_err(|e| format!("Failed to read .sops.yaml: {}", e))?;

        if !content.contains(&pubkey) {
            let updated = utils::add_recipient(&content, &pubkey)?;
            fs::write(&sops_path, &updated)
                .map_err(|e| format!("Failed to write .sops.yaml: {}", e))?;
        }
        sp.finish_and_clear();
        utils::done("Added recovery key to .sops.yaml recipients");

        // Re-encrypt vault
        if vault_path.exists() {
            let sp = utils::spinner("Re-encrypting vault...");
            let _ = Command::new("sops")
                .args(["updatekeys", "-y", "vault.yaml"])
                .current_dir(&vault_dir)
                .output();
            sp.finish_and_clear();
            utils::done("Vault re-encrypted with recovery key");
        }

        // Commit and push
        utils::git_commit_and_push(
            ".",
            &[".sops.yaml", "vault.yaml"],
            "feat: add recovery key to vault recipients",
        )?;
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

    if verbose {
        utils::explain(&[
            "WHY SEPARATE LOCATIONS?",
            "",
            "Two-factor recovery: the encrypted file is useless without",
            "the passphrase, and the passphrase is useless without the",
            "file. An attacker would need to compromise BOTH locations.",
            "",
            "Good storage examples:",
            "  • File: Google Drive, iCloud, Dropbox, USB stick in a drawer",
            "  • Passphrase: Paper in a safe, bank safety deposit box",
            "",
            "TO USE THE RECOVERY KEY LATER:",
            "  1. Download recovery_key.age",
            "  2. Run: age -d recovery_key.age > temp_key.txt",
            "  3. Enter your passphrase when prompted",
            "  4. Run: SOPS_AGE_KEY_FILE=temp_key.txt keypick list",
            "  5. Delete temp_key.txt immediately after use",
        ]);
    }

    Ok(())
}
