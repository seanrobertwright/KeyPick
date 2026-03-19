use crate::commands::setup::utils;
use colored::*;
use std::fs;

/// Ensures an age keypair exists. Returns the public key.
pub fn run(verbose: bool) -> Result<String, String> {
    let key_path = utils::age_key_path();

    if key_path.exists() {
        let pubkey = utils::read_public_key(&key_path)?;
        utils::done(&format!("Age key already exists: {}", pubkey.cyan()));

        if verbose {
            utils::explain(&[
                "An age key was found on this machine. This means you've",
                "either run KeyPick setup before, or another tool generated",
                "an age key. You can reuse it (recommended) or generate a",
                "fresh one (the old key will be backed up with a .bak extension).",
            ]);
        }

        let use_existing = inquire::Confirm::new("Use this existing key?")
            .with_default(true)
            .prompt()
            .map_err(|_| "Cancelled".to_string())?;

        if use_existing {
            return Ok(pubkey);
        }

        // User wants a new key -- back up the old one
        let backup = key_path.with_extension("txt.bak");
        fs::rename(&key_path, &backup)
            .map_err(|e| format!("Failed to back up existing key: {}", e))?;
        utils::warn(&format!("Old key backed up to {}", backup.display()));
    }

    if verbose {
        utils::explain(&[
            "Generating a new age keypair using `age-keygen`.",
            "",
            "This creates two things:",
            "  • A private key (AGE-SECRET-KEY-...) — stays on this machine only",
            "  • A public key (age1...) — will be added to your vault's .sops.yaml",
            "",
            &format!("The keypair is saved to: {}", key_path.display()),
            "",
            "IMPORTANT: Never share or commit your private key. If this machine",
            "is lost or compromised, remove its public key from .sops.yaml to",
            "revoke access.",
        ]);
    }

    // Generate new key
    let sp = utils::spinner("Generating age keypair...");

    let key_dir = utils::age_key_dir();
    fs::create_dir_all(&key_dir)
        .map_err(|e| format!("Failed to create {}: {}", key_dir.display(), e))?;

    utils::run_cmd("age-keygen", &["-o", &key_path.to_string_lossy()])
        .map_err(|e| format!("age-keygen failed: {}", e))?;

    sp.finish_and_clear();

    let pubkey = utils::read_public_key(&key_path)?;

    utils::done(&format!("Key generated: {}", pubkey.cyan()));
    println!(
        "  {} {}",
        "Saved to:".dimmed(),
        key_path.display().to_string().dimmed()
    );

    Ok(pubkey)
}
