use clap::Subcommand;
use colored::*;

use crate::vault;

#[derive(Subcommand, Clone)]
pub enum VaultCommands {
    /// List known vault repositories
    List,
    /// Show the currently selected vault repository
    Current,
    /// Interactively choose the active vault repository
    Select,
}

pub fn run(command: VaultCommands) {
    match command {
        VaultCommands::List => list_vaults(),
        VaultCommands::Current => current_vault(),
        VaultCommands::Select => select_vault(),
    }
}

fn list_vaults() {
    let current = vault::current_vault_dir();
    let vaults = vault::list_known_vaults();

    if vaults.is_empty() {
        println!(
            "  {} No known vaults found under {}",
            "!".yellow().bold(),
            vault::vaults_home_dir().display()
        );
        return;
    }

    println!("\n  {}\n", "Known Vaults:".bold().underline());
    for path in vaults {
        let marker = if current.as_ref() == Some(&path) { "*" } else { "-" };
        println!("  {} {}", marker.cyan().bold(), path.display());
    }
    println!();
}

fn current_vault() {
    match vault::current_vault_dir() {
        Some(path) => println!("{}", path.display()),
        None => {
            eprintln!(
                "No active vault is selected. Run `keypick vault select` or `keypick setup`."
            );
            crate::terminal::cleanup_and_exit(1);
        }
    }
}

fn select_vault() {
    match vault::select_known_vault_interactively() {
        Ok(path) => {
            println!(
                "\n  {} {}",
                "Active vault:".green().bold(),
                path.display().to_string().cyan().bold()
            );
        }
        Err(error) => {
            eprintln!("{}", error);
            crate::terminal::cleanup_and_exit(1);
        }
    }
}
