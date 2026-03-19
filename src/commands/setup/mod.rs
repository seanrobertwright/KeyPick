mod utils;
mod prerequisites;
mod keygen;
mod init;
mod join;
mod actions;
mod recovery;

use clap::Subcommand;
use colored::*;
use inquire::Select;

#[derive(Subcommand, Clone)]
pub enum SetupCommands {
    /// Set up GitHub Actions auto re-encryption
    Actions,
    /// Generate a passphrase-protected recovery key
    Recovery,
}

/// Main setup wizard entry point
pub fn run(sub: Option<SetupCommands>) {
    match sub {
        Some(SetupCommands::Actions) => actions::run(),
        Some(SetupCommands::Recovery) => recovery::run(),
        None => run_full_wizard(),
    }
}

fn run_full_wizard() {
    println!(
        "\n{}",
        "  -- KeyPick Setup Wizard --".cyan().bold()
    );
    println!(
        "  {}\n",
        "This will get KeyPick fully configured on this machine.".dimmed()
    );

    // Phase 1: Prerequisites
    println!("{}", "[1/4] Checking prerequisites...".cyan().bold());
    if let Err(e) = prerequisites::run() {
        eprintln!("{} {}", "Setup failed:".red().bold(), e);
        std::process::exit(1);
    }

    // Phase 2: Age key
    println!("\n{}", "[2/4] Machine identity...".cyan().bold());
    let public_key = match keygen::run() {
        Ok(key) => key,
        Err(e) => {
            eprintln!("{} {}", "Key generation failed:".red().bold(), e);
            std::process::exit(1);
        }
    };

    // Phase 3: Vault repo
    println!("\n{}", "[3/4] Vault repository...".cyan().bold());
    let options = vec!["New vault (first machine)", "Join existing vault"];
    let choice = Select::new(
        "Is this your first machine, or joining an existing vault?",
        options,
    )
    .prompt();

    match choice {
        Ok(c) if c.starts_with("New") => {
            if let Err(e) = init::run(&public_key) {
                eprintln!("{} {}", "Init failed:".red().bold(), e);
                std::process::exit(1);
            }
        }
        Ok(_) => {
            if let Err(e) = join::run(&public_key) {
                eprintln!("{} {}", "Join failed:".red().bold(), e);
                std::process::exit(1);
            }
        }
        Err(_) => {
            println!("{}", "Setup cancelled.".yellow());
            return;
        }
    }

    // Phase 4: Optional extras
    println!("\n{}", "[4/4] Optional enhancements...".cyan().bold());

    if inquire::Confirm::new("Set up GitHub Actions auto-sync?")
        .with_default(true)
        .with_help_message("Automatically re-encrypts vault when recipients change")
        .prompt()
        .unwrap_or(false)
    {
        actions::run();
    }

    if inquire::Confirm::new("Create a recovery key?")
        .with_default(true)
        .with_help_message("Emergency backup in case you lose access to all machines")
        .prompt()
        .unwrap_or(false)
    {
        recovery::run();
    }

    println!("\n{}", "Setup complete!".green().bold());
    println!(
        "  {}",
        "Run `keypick add` to store your first secrets.".dimmed()
    );
}
