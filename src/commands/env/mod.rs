pub mod push;
pub mod pull;
pub mod status;
pub mod utils;

use clap::Subcommand;

#[derive(Subcommand)]
pub enum EnvCommands {
    /// Push .env files from the current project to the vault
    Push,

    /// Pull .env files from the vault to the current project
    Pull,

    /// Show which .env files are stored for the current project
    Status,
}

pub fn run(sub: EnvCommands) {
    match sub {
        EnvCommands::Push => push::run(),
        EnvCommands::Pull => pull::run(),
        EnvCommands::Status => status::run(),
    }
}
