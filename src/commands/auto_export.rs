use crate::vault;

/// Non-interactive export for shell evaluation (used by direnv).
///
/// Prints `export KEY='VALUE'` lines to stdout for each group provided.
/// No biometric gate — authentication is handled by the calling shell context.
///
/// Usage in .envrc:
///   eval $(key-pick auto Supabase_Prod Google_AI)
pub fn run(groups: &[String]) {
    if groups.is_empty() {
        eprintln!("Usage: key-pick auto <Group1> [Group2 ...]");
        std::process::exit(1);
    }

    let vault = vault::load();
    let mut output = String::new();

    for group in groups {
        match vault.services.get(group) {
            Some(keys) => {
                output.push_str(&format!("# {}\n", group));
                output.push_str(&vault::keys_to_exports(keys));
            }
            None => {
                eprintln!("Warning: group '{}' not found in vault.", group);
            }
        }
    }

    print!("{}", output);
}
