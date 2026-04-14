use colored::*;
use inquire::Select;

/// Full interactive mode (no subcommand given — just run `keypick`)
pub fn run() {
    let action = Select::new(
        "What would you like to do?",
        vec![
            "Extract keys to .env",
            "Add / Update a key group",
            "List vault contents",
            "Copy a key to clipboard",
            "Push .env files to vault",
            "Pull .env files from vault",
            "Exit",
        ],
    )
    .prompt()
    .unwrap_or_else(|_| "Exit");

    println!();

    match action {
        "Extract keys to .env" => super::extract::run(),
        "Add / Update a key group" => super::add::run(),
        "List vault contents" => super::list::run(),
        "Copy a key to clipboard" => super::copy::run(),
        "Push .env files to vault" => super::env::push::run(),
        "Pull .env files from vault" => super::env::pull::run(),
        _ => println!("{}", "Goodbye!".dimmed()),
    }
}
