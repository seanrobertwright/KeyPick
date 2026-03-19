use crate::commands::setup::utils;
use colored::*;
use std::fs;

/// Ensures an age keypair exists. Returns the public key.
pub fn run() -> Result<String, String> {
    let key_path = utils::age_key_path();

    if key_path.exists() {
        let pubkey = utils::read_public_key(&key_path)?;
        utils::done(&format!("Age key already exists: {}", pubkey.cyan()));

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
