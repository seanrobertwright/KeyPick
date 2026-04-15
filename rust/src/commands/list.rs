use colored::*;

use crate::vault;

/// Print all groups and key names. Values are hidden — this is a safe listing.
pub fn run() {
    let vault = vault::load();

    if vault.services.is_empty() {
        println!("{}", "  Vault is empty. Run `keypick add` to add your first group.".yellow());
        return;
    }

    println!("\n  {}\n", "Vault Contents (values hidden):".bold().underline());

    for (group, keys) in &vault.services {
        println!("  {} {}", "◆".cyan(), group.cyan().bold());
        for key in keys.keys() {
            println!("      {} {}", "·".dimmed(), key);
        }
        println!();
    }

    println!(
        "  {} {} group(s), {} key(s) total.\n",
        "→".dimmed(),
        vault.services.len(),
        vault.services.values().map(|k| k.len()).sum::<usize>()
    );
}
