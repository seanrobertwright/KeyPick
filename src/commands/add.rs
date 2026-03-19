use colored::*;
use inquire::{Confirm, Select, Text};
use std::collections::BTreeMap;

use crate::vault;

/// Interactive wizard: add or update a key group in the vault.
///
/// Flow:
///   1. Ask for Group/Service Name (shows existing groups, or "New Group...")
///   2. Loop: ask for Key Name → Value until the user says done
///   3. Encrypt and save
pub fn run() {
    let mut vault = vault::load();

    // Build selection list: existing groups + a "New Group" option
    let mut options: Vec<String> = vault.services.keys().cloned().collect();
    options.insert(0, "[ + New Group ]".to_string());

    let group_choice = Select::new(
        "Select a group to update, or create a new one:",
        options,
    )
    .prompt()
    .unwrap_or_else(|_| std::process::exit(0));

    let group_name = if group_choice == "[ + New Group ]" {
        Text::new("Service/Group name (e.g. Supabase_Prod, Google_AI):")
            .prompt()
            .unwrap_or_else(|_| std::process::exit(0))
    } else {
        group_choice
    };

    let entry: &mut BTreeMap<String, String> =
        vault.services.entry(group_name.clone()).or_default();

    println!(
        "\n  {} {}\n  {}\n",
        "Adding keys to group:".dimmed(),
        group_name.cyan().bold(),
        "Leave 'Key Name' blank to finish.".dimmed()
    );

    loop {
        let key = Text::new("Key Name  :")
            .prompt()
            .unwrap_or_else(|_| std::process::exit(0));

        if key.trim().is_empty() {
            break;
        }

        let val = Text::new(&format!("Value for {}:", key.cyan().bold().to_string()))
            .prompt()
            .unwrap_or_else(|_| std::process::exit(0));

        let is_update = entry.contains_key(&key);
        entry.insert(key.clone(), val);

        if is_update {
            println!("  {} {}", "↺ Updated:".yellow(), key);
        } else {
            println!("  {} {}", "✓ Added:".green(), key);
        }

        let again = Confirm::new("Add another key to this group?")
            .with_default(true)
            .prompt()
            .unwrap_or(false);

        if !again {
            break;
        }
    }

    println!("\n{}", "  Encrypting and saving vault...".dimmed());
    vault::save(&vault);
    println!("{}", "  ✓ Vault updated successfully.".green().bold());
    println!(
        "\n  {} git add vault.yaml && git commit -m \"Update {}\" && git push",
        "Remember to sync:".dimmed(),
        group_name
    );
}
