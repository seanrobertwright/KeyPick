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
pub fn run(sub: Option<SetupCommands>, walkthrough: bool) {
    match sub {
        Some(SetupCommands::Actions) => actions::run(walkthrough),
        Some(SetupCommands::Recovery) => recovery::run(walkthrough),
        None => run_full_wizard(walkthrough),
    }
}

fn run_full_wizard(walkthrough: bool) {
    println!(
        "\n{}",
        "  -- KeyPick Setup Wizard --".cyan().bold()
    );
    println!(
        "  {}\n",
        "This will get KeyPick fully configured on this machine.".dimmed()
    );

    if walkthrough {
        utils::explain(&[
            "WALKTHROUGH MODE ENABLED",
            "",
            "This setup wizard configures KeyPick in 4 phases:",
            "  1. Prerequisites  — install age (encryption) and sops (secret management)",
            "  2. Machine identity — generate a unique age keypair for this machine",
            "  3. Vault repository — create or join a Git repo that stores your encrypted secrets",
            "  4. Optional extras — GitHub Actions auto-sync and a recovery key",
            "",
            "Each step will be explained before it runs so you understand",
            "exactly what is happening and why.",
        ]);
    }

    // Phase 1: Prerequisites
    println!("{}", "[1/4] Checking prerequisites...".cyan().bold());
    if walkthrough {
        utils::explain(&[
            "WHY: KeyPick doesn't do encryption itself — it relies on two",
            "well-audited open-source tools:",
            "",
            "  • age  — a modern file encryption tool (like GPG but simpler).",
            "    Each machine gets its own age keypair. The public key is shared",
            "    with your vault so it can encrypt secrets FOR this machine.",
            "    The private key never leaves this machine.",
            "",
            "  • sops — \"Secrets OPerationS\" by Mozilla. It encrypts individual",
            "    values inside a YAML file (not the whole file), so you can see",
            "    key NAMES in plain text but VALUES stay encrypted. sops also",
            "    handles multi-recipient encryption: one vault, many machines.",
            "",
            "WHAT HAPPENS: We check if age and sops are already installed.",
            "If not, we download the correct binaries for your OS/architecture",
            "from their official GitHub releases and place them on your PATH.",
        ]);
    }
    if let Err(e) = prerequisites::run(walkthrough) {
        eprintln!("{} {}", "Setup failed:".red().bold(), e);
        crate::terminal::cleanup_and_exit(1);
    }

    // Phase 2: Age key
    println!("\n{}", "[2/4] Machine identity...".cyan().bold());
    if walkthrough {
        utils::explain(&[
            "WHY: Every machine that accesses your vault needs its own age",
            "keypair. This is a core security property of KeyPick — if one",
            "machine is compromised, you revoke just that machine's key",
            "without affecting any others.",
            "",
            "The keypair consists of:",
            "  • A PRIVATE key (stored locally, never shared) — used to decrypt",
            "  • A PUBLIC key (shared with your vault) — used to encrypt FOR you",
            "",
            "WHAT HAPPENS: We check if you already have an age key on this",
            "machine. If you do, you can reuse it. If not, we generate a",
            "fresh keypair using `age-keygen` and store the private key at:",
            &format!("  {}", utils::age_key_path().display()),
        ]);
    }
    let public_key = match keygen::run(walkthrough) {
        Ok(key) => key,
        Err(e) => {
            eprintln!("{} {}", "Key generation failed:".red().bold(), e);
            crate::terminal::cleanup_and_exit(1);
        }
    };

    // Phase 3: Vault repo
    println!("\n{}", "[3/4] Vault repository...".cyan().bold());
    if walkthrough {
        utils::explain(&[
            "WHY: Your encrypted secrets live in a Git repository — this is",
            "how they sync between machines. The repo contains:",
            "",
            "  • vault.yaml   — your secrets, encrypted by sops+age",
            "  • .sops.yaml   — lists which public keys can decrypt the vault",
            "",
            "The repo should be PRIVATE (only you can access it). Even though",
            "values are encrypted, the key NAMES are visible in the YAML.",
            "",
            "WHAT HAPPENS: You'll choose one of two paths:",
            "  • 'New vault' — if this is your first machine. We create a new",
            "     Git repo, initialize the SOPS config with your public key,",
            "     and create an empty encrypted vault under KeyPick's vault home.",
            "  • 'Join existing vault' — if you already set up KeyPick on",
            "     another machine. We clone your repo and register this",
            "     machine's public key so it can decrypt the vault too.",
        ]);
    }
    let options = vec!["New vault (first machine)", "Join existing vault"];
    let choice = Select::new(
        "Is this your first machine, or joining an existing vault?",
        options,
    )
    .prompt();

    match choice {
        Ok(c) if c.starts_with("New") => {
            if let Err(e) = init::run(&public_key, walkthrough) {
                eprintln!("{} {}", "Init failed:".red().bold(), e);
                crate::terminal::cleanup_and_exit(1);
            }
        }
        Ok(_) => {
            if let Err(e) = join::run(&public_key, walkthrough) {
                eprintln!("{} {}", "Join failed:".red().bold(), e);
                crate::terminal::cleanup_and_exit(1);
            }
        }
        Err(_) => {
            println!("{}", "Setup cancelled.".yellow());
            return;
        }
    }

    // Phase 4: Optional extras
    println!("\n{}", "[4/4] Optional enhancements...".cyan().bold());
    if walkthrough {
        utils::explain(&[
            "WHY: These optional features improve convenience and safety:",
            "",
            "  • GitHub Actions auto-sync — when you add a new machine,",
            "    a CI workflow automatically re-encrypts the vault so ALL",
            "    registered machines can decrypt it. Without this, you'd",
            "    have to manually run `sops updatekeys` from a machine",
            "    that already has access.",
            "",
            "  • Recovery key — a passphrase-protected backup key stored",
            "    offline. If you lose access to ALL your machines (e.g.",
            "    laptop stolen, desktop dies), the recovery key lets you",
            "    regain access to your vault. Without it, losing all",
            "    machines means losing all your secrets.",
        ]);
    }

    if inquire::Confirm::new("Set up GitHub Actions auto-sync?")
        .with_default(true)
        .with_help_message("Automatically re-encrypts vault when recipients change")
        .prompt()
        .unwrap_or(false)
    {
        actions::run(walkthrough);
    }

    if inquire::Confirm::new("Create a recovery key?")
        .with_default(true)
        .with_help_message("Emergency backup in case you lose access to all machines")
        .prompt()
        .unwrap_or(false)
    {
        recovery::run(walkthrough);
    }

    println!("\n{}", "Setup complete!".green().bold());
    println!(
        "  {}",
        "Run `keypick add` to store your first secrets.".dimmed()
    );

    if walkthrough {
        utils::explain(&[
            "ALL DONE! Here's what was set up:",
            "",
            "  • age + sops are installed and ready",
            "  • This machine has a unique age keypair",
            "  • Your vault repo is configured and syncing via Git",
            "",
            "NEXT STEPS:",
            "  1. Run `keypick add` to store your first API keys",
            "  2. Run `keypick extract` in a project directory to create a .env file",
            "  3. On another machine, run `keypick setup` and choose 'Join existing vault'",
            "  4. Use KEYPICK_VAULT_DIR only when you want to override the remembered vault",
            "",
            "Your secrets are encrypted at rest and protected by biometric",
            "authentication. They are only ever decrypted in memory during",
            "a keypick session.",
        ]);
    }
}
