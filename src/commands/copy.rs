use arboard::Clipboard;
use colored::*;
use inquire::Select;

use crate::vault;

/// Copy a single key's value directly to clipboard — nothing written to disk.
pub fn run() {
    let vault = vault::load();

    if vault.services.is_empty() {
        println!("{}", "  Vault is empty.".yellow());
        return;
    }

    // Step 1: pick the group
    let groups: Vec<String> = vault.services.keys().cloned().collect();
    let group = Select::new("Select group:", groups)
        .prompt()
        .unwrap_or_else(|_| std::process::exit(0));

    let keys_map = vault.services.get(&group).unwrap();

    // Step 2: pick the key
    let key_names: Vec<String> = keys_map.keys().cloned().collect();
    let key = Select::new("Select key to copy:", key_names)
        .prompt()
        .unwrap_or_else(|_| std::process::exit(0));

    let value = keys_map.get(&key).unwrap();

    // Step 3: copy to clipboard
    let mut clipboard = Clipboard::new().unwrap_or_else(|e| {
        eprintln!("Clipboard error: {}", e);
        std::process::exit(1);
    });

    clipboard.set_text(value).unwrap_or_else(|e| {
        eprintln!("Failed to set clipboard: {}", e);
        std::process::exit(1);
    });

    println!(
        "\n  {} {} → {} copied to clipboard.",
        "✓".green().bold(),
        group.cyan(),
        key.cyan().bold()
    );
    println!("  {}", "Value is NOT on disk. Clipboard will clear on reboot.".dimmed());
}
