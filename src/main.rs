mod vault;
mod auth;
mod commands;
mod terminal;

use clap::{Parser, Subcommand};
use colored::*;

/// KeyPick — Cross-platform API key vault manager
#[derive(Parser)]
#[command(name = "keypick")]
#[command(version = "0.1.0")]
#[command(about = "Secure, grouped API key manager powered by SOPS + age", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Add or update keys in a named service group
    Add,

    /// Extract keys from one or more groups into a .env file
    Extract,

    /// List all stored service groups and their key names (values hidden)
    List,

    /// Copy a specific key value to the clipboard (never written to disk)
    Copy,

    /// Non-interactive export for use with direnv .envrc files
    ///
    /// Example .envrc line:
    ///   eval $(keypick auto Supabase_Prod Google_AI)
    Auto {
        /// Names of the service groups to export
        groups: Vec<String>,
    },

    /// Manage vault repository selection
    Vault {
        #[command(subcommand)]
        sub: commands::vaults::VaultCommands,
    },

    /// Manage per-project .env files in the vault
    Env {
        #[command(subcommand)]
        sub: commands::env::EnvCommands,
    },

    /// Set up KeyPick on this machine (install prerequisites, configure vault)
    Setup {
        #[command(subcommand)]
        sub: Option<commands::setup::SetupCommands>,

        /// Run setup with detailed explanations of each step
        #[arg(long)]
        walkthrough: bool,
    },
}

fn main() {
    terminal::install_panic_hook();
    print_banner();

    let cli = Cli::parse();

    // Setup runs before vault exists — skip biometric gate
    if let Some(Commands::Setup { sub, walkthrough }) = &cli.command {
        commands::setup::run(sub.clone(), *walkthrough);
        return;
    }

    // Env::Status skips biometric; Push and Pull require it
    if let Some(Commands::Env { sub }) = &cli.command {
        match sub {
            commands::env::EnvCommands::Status => {
                commands::env::run(commands::env::EnvCommands::Status);
                return;
            }
            _ => {} // fall through to biometric gate
        }
    }

    // Non-secret vault management and `auto` skip biometric auth.
    let needs_bio = !matches!(
        &cli.command,
        Some(Commands::Auto { .. }) | Some(Commands::Vault { .. })
    );

    if needs_bio {
        if let Err(e) = auth::verify() {
            eprintln!("{} {}", "Authentication failed:".red().bold(), e);
            terminal::cleanup_and_exit(1);
        }
        terminal::restore_console_focus();
        println!("{}", "✓ Identity verified.\n".green().bold());
    }

    match cli.command {
        Some(Commands::Add) => commands::add::run(),
        Some(Commands::Extract) => commands::extract::run(),
        Some(Commands::List) => commands::list::run(),
        Some(Commands::Copy) => commands::copy::run(),
        Some(Commands::Auto { groups }) => commands::auto_export::run(&groups),
        Some(Commands::Vault { sub }) => commands::vaults::run(sub),
        Some(Commands::Env { sub }) => commands::env::run(sub),
        Some(Commands::Setup { .. }) => unreachable!(),
        None => commands::interactive::run(),
    }
}

fn print_banner() {
    println!(
        "{}",
        r#"
  ██╗  ██╗███████╗██╗   ██╗    ██████╗ ██╗ ██████╗██╗  ██╗
  ██║ ██╔╝██╔════╝╚██╗ ██╔╝    ██╔══██╗██║██╔════╝██║ ██╔╝
  █████╔╝ █████╗   ╚████╔╝     ██████╔╝██║██║     █████╔╝
  ██╔═██╗ ██╔══╝    ╚██╔╝      ██╔═══╝ ██║██║     ██╔═██╗
  ██║  ██╗███████╗   ██║       ██║     ██║╚██████╗██║  ██╗
  ╚═╝  ╚═╝╚══════╝   ╚═╝       ╚═╝     ╚═╝ ╚═════╝╚═╝  ╚═╝
"#
        .cyan()
        .bold()
    );
    println!(
        "  {} {}\n",
        "KeyPick".cyan().bold(),
        "— Secure Cross-Platform API Key Vault".dimmed()
    );
}
