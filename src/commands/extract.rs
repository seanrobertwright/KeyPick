use colored::*;
use inquire::MultiSelect;

use crate::vault;

const ENV_FILE: &str = ".env";

/// Interactive multi-select: pick which groups to write to .env
pub fn run() {
    let vault = vault::load();

    if vault.services.is_empty() {
        println!("{}", "  No groups found in vault. Run `key-pick add` first.".yellow());
        return;
    }

    let options: Vec<String> = vault.services.keys().cloned().collect();

    let selected = MultiSelect::new(
        "Select the groups to extract into .env (Space to toggle, Enter to confirm):",
        options,
    )
    .prompt()
    .unwrap_or_else(|_| std::process::exit(0));

    if selected.is_empty() {
        println!("{}", "  Nothing selected. Aborted.".yellow());
        return;
    }

    let mut env_content = String::new();
    let mut total_keys = 0usize;

    for group in &selected {
        if let Some(keys) = vault.services.get(group) {
            env_content.push_str(&format!("# --- {} ---\n", group));
            env_content.push_str(&vault::keys_to_env(keys));
            env_content.push('\n');
            total_keys += keys.len();
        }
    }

    std::fs::write(ENV_FILE, &env_content).unwrap_or_else(|e| {
        eprintln!("Failed to write .env: {}", e);
        std::process::exit(1);
    });

    println!(
        "\n  {} {} keys from {} group(s) written to {}",
        "✓".green().bold(),
        total_keys.to_string().cyan().bold(),
        selected.len().to_string().cyan(),
        ENV_FILE.cyan().bold()
    );

    println!(
        "  {} Add {} to your .gitignore so secrets are never committed.",
        "⚠".yellow(),
        ENV_FILE.yellow(),
    );
}
