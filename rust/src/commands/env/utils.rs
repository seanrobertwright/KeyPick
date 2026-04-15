use std::path::{Path, PathBuf};
use std::process::Command;

/// Derive a project identifier from the current working directory.
///
/// Resolution:
/// 1. Parse git remote origin URL → normalize to `owner__repo`
/// 2. Fall back to directory name if no git remote
///
/// Returns (project_id, used_fallback)
pub fn derive_project_id(dir: &Path) -> Result<(String, bool), String> {
    // Try git remote first
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(dir)
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(id) = normalize_remote_url(&url) {
                return Ok((id, false));
            }
        }
    }

    // Fall back to directory name
    let dir_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Cannot determine directory name".to_string())?;

    Ok((dir_name.to_string(), true))
}

/// Normalize a git remote URL to a project identifier.
///
/// Handles:
/// - https://github.com/owner/repo.git → owner__repo
/// - git@github.com:owner/repo.git → owner__repo
/// - https://github.com/owner/repo → owner__repo
fn normalize_remote_url(url: &str) -> Option<String> {
    let cleaned = url.trim();

    // SSH format: git@host:owner/repo.git
    let path = if let Some(after_colon) = cleaned.strip_prefix("git@") {
        after_colon.split_once(':').map(|(_, path)| path)?
    } else {
        // HTTPS format: https://host/owner/repo.git
        // Strip protocol and host
        let without_proto = cleaned
            .strip_prefix("https://")
            .or_else(|| cleaned.strip_prefix("http://"))?;
        // Skip the hostname (first path segment)
        without_proto.split_once('/').map(|(_, path)| path)?
    };

    // Strip .git suffix and replace / with __
    let path = path.strip_suffix(".git").unwrap_or(path);
    let id = path.replace('/', "__");

    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

/// Find all .env* files in a directory (non-recursive).
///
/// Returns sorted list of file paths matching .env* glob pattern.
/// Skips empty files.
pub fn discover_env_files(dir: &Path) -> Vec<PathBuf> {
    let pattern = dir.join(".env*").to_string_lossy().to_string();
    let mut files: Vec<PathBuf> = glob::glob(&pattern)
        .unwrap_or_else(|_| panic!("Invalid glob pattern"))
        .filter_map(|entry| entry.ok())
        .filter(|path| path.is_file())
        .filter(|path| {
            std::fs::metadata(path)
                .map(|m| m.len() > 0)
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    files
}

/// Get the envs directory path within a vault repo for a given project.
pub fn envs_dir(vault_dir: &Path, project_id: &str) -> PathBuf {
    vault_dir.join("envs").join(project_id)
}

/// Ensure .sops.yaml has an envs/.* creation rule.
/// If missing, adds one using the age recipients from the existing vault.yaml rule.
/// Returns true if the file was modified.
pub fn ensure_sops_env_rule(vault_dir: &Path) -> Result<bool, String> {
    let sops_path = vault_dir.join(".sops.yaml");
    let content = std::fs::read_to_string(&sops_path)
        .map_err(|e| format!("Failed to read .sops.yaml: {}", e))?;

    // Check if envs rule already exists
    if content.contains("envs/") {
        return Ok(false);
    }

    // Extract age recipients from the existing vault.yaml rule
    // Look for the age: line(s) after path_regex: vault\.yaml$
    let lines: Vec<&str> = content.lines().collect();
    let mut age_value = String::new();
    let mut in_vault_rule = false;
    let mut found_age = false;

    for line in &lines {
        let trimmed = line.trim();
        if trimmed.starts_with("- path_regex:") && trimmed.contains("vault") {
            in_vault_rule = true;
            continue;
        }
        if in_vault_rule && trimmed.starts_with("age:") {
            found_age = true;
            // Could be inline or block scalar
            let after_age = trimmed.strip_prefix("age:").unwrap().trim();
            if after_age == ">-" || after_age == "|" || after_age.is_empty() {
                // Block scalar — collect following indented lines
                continue;
            } else {
                // Inline value (possibly quoted)
                age_value = after_age.trim_matches('"').to_string();
                break;
            }
        }
        if found_age && in_vault_rule {
            // Collecting block scalar lines
            if trimmed.starts_with("age1") || trimmed.starts_with("\"age1") {
                if !age_value.is_empty() {
                    // Remove trailing comma from previous
                    age_value = age_value.trim_end_matches(',').to_string();
                    age_value.push(',');
                }
                age_value.push_str(trimmed.trim_end_matches(','));
            } else if !trimmed.is_empty() && !trimmed.starts_with('-') {
                // Still in block scalar if indented
                continue;
            } else {
                break;
            }
        }
        if in_vault_rule && trimmed.starts_with("- ") && found_age {
            break;
        }
    }

    if age_value.is_empty() {
        return Err("Could not find age recipients in .sops.yaml".to_string());
    }

    // Prepend the envs rule before the vault rule
    let env_rule = format!(
        "creation_rules:\n  - path_regex: envs/.*\n    age: >-\n      {}\n  - path_regex: vault\\.yaml$",
        age_value
    );
    let updated = content.replacen(
        "creation_rules:\n  - path_regex: vault\\.yaml$",
        &env_rule,
        1,
    );

    std::fs::write(&sops_path, &updated)
        .map_err(|e| format!("Failed to write .sops.yaml: {}", e))?;

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_https_url() {
        assert_eq!(
            normalize_remote_url("https://github.com/seanrobertwright/my-app.git"),
            Some("seanrobertwright__my-app".to_string())
        );
    }

    #[test]
    fn test_normalize_https_no_git_suffix() {
        assert_eq!(
            normalize_remote_url("https://github.com/seanrobertwright/my-app"),
            Some("seanrobertwright__my-app".to_string())
        );
    }

    #[test]
    fn test_normalize_ssh_url() {
        assert_eq!(
            normalize_remote_url("git@github.com:seanrobertwright/my-app.git"),
            Some("seanrobertwright__my-app".to_string())
        );
    }

    #[test]
    fn test_normalize_ssh_no_git_suffix() {
        assert_eq!(
            normalize_remote_url("git@github.com:seanrobertwright/my-app"),
            Some("seanrobertwright__my-app".to_string())
        );
    }

    #[test]
    fn test_normalize_nested_path() {
        assert_eq!(
            normalize_remote_url("https://github.com/org/sub/repo.git"),
            Some("org__sub__repo".to_string())
        );
    }
}
