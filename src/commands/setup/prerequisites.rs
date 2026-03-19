use crate::commands::setup::utils;
use colored::*;
use indicatif::ProgressBar;
use std::fs;
use std::io::Read;
use std::path::Path;

const AGE_VERSION: &str = "1.2.0";
const SOPS_VERSION: &str = "3.9.4";

pub fn run() -> Result<(), String> {
    check_and_install("age", AGE_VERSION, install_age)?;
    check_and_install("sops", SOPS_VERSION, install_sops)?;
    Ok(())
}

fn check_and_install(
    name: &str,
    version: &str,
    installer: fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    if utils::command_exists(name) {
        let ver = utils::run_cmd(name, &["--version"]).unwrap_or_default();
        utils::done(&format!(
            "{} already installed ({})",
            name,
            ver.lines().next().unwrap_or(&ver)
        ));
        return Ok(());
    }

    println!(
        "  {} not found. Installing {}...",
        name.yellow().bold(),
        version
    );
    installer(version)?;

    if utils::command_exists(name) {
        let ver = utils::run_cmd(name, &["--version"]).unwrap_or_default();
        utils::done(&format!(
            "{} installed ({})",
            name,
            ver.lines().next().unwrap_or(&ver)
        ));
        Ok(())
    } else {
        let dir = utils::install_dir();
        Err(format!(
            "{} was downloaded but is not on PATH.\n  \
             Add {} to your PATH environment variable, then retry.",
            name,
            dir.display()
        ))
    }
}

fn install_age(version: &str) -> Result<(), String> {
    let (os, arch) = utils::platform();
    let filename = match os {
        "windows" => format!("age-v{}-windows-{}.zip", version, arch),
        "darwin" => format!("age-v{}-darwin-{}.tar.gz", version, arch),
        _ => format!("age-v{}-linux-{}.tar.gz", version, arch),
    };
    let url = format!(
        "https://github.com/FiloSottile/age/releases/download/v{}/{}",
        version, filename
    );

    let install_dir = utils::install_dir();
    let data = download_file(&url, &filename)?;

    let tmp = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let archive_path = tmp.path().join(&filename);
    fs::write(&archive_path, &data).map_err(|e| format!("Failed to write archive: {}", e))?;

    // Extract
    extract_archive(&archive_path, tmp.path(), os)?;

    // Find and copy binaries
    let age_dir = tmp.path().join("age");
    let ext = if cfg!(windows) { ".exe" } else { "" };

    let age_src = find_binary(&age_dir, tmp.path(), &format!("age{}", ext))?;
    let keygen_src = find_binary(&age_dir, tmp.path(), &format!("age-keygen{}", ext))?;

    fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create {}: {}", install_dir.display(), e))?;

    fs::copy(&age_src, install_dir.join(format!("age{}", ext)))
        .map_err(|e| format!("Failed to install age: {}", e))?;
    fs::copy(&keygen_src, install_dir.join(format!("age-keygen{}", ext)))
        .map_err(|e| format!("Failed to install age-keygen: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o755);
        let _ = fs::set_permissions(install_dir.join("age"), perms.clone());
        let _ = fs::set_permissions(install_dir.join("age-keygen"), perms);
    }

    Ok(())
}

fn install_sops(version: &str) -> Result<(), String> {
    let (os, arch) = utils::platform();
    let filename = match os {
        "windows" => format!("sops-v{}.exe", version),
        "darwin" => format!("sops-v{}.darwin.{}", version, arch),
        _ => format!("sops-v{}.linux.{}", version, arch),
    };
    let url = format!(
        "https://github.com/getsops/sops/releases/download/v{}/{}",
        version, filename
    );

    let install_dir = utils::install_dir();
    let data = download_file(&url, &filename)?;

    fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create {}: {}", install_dir.display(), e))?;

    let ext = if cfg!(windows) { ".exe" } else { "" };
    let dest = install_dir.join(format!("sops{}", ext));
    fs::write(&dest, &data).map_err(|e| format!("Failed to write sops: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
    }

    Ok(())
}

fn download_file(url: &str, name: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("Download failed for {}: {}", name, e))?;

    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {} for {}", resp.status(), url));
    }

    let total = resp.content_length().unwrap_or(0);
    let pb = if total > 0 {
        utils::download_bar(total, name)
    } else {
        let pb = ProgressBar::new_spinner();
        pb.set_message(format!("Downloading {}...", name));
        pb
    };

    let mut bytes = Vec::with_capacity(total as usize);
    let mut reader = resp;
    let mut buf = [0u8; 8192];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Read error: {}", e))?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
        pb.set_position(bytes.len() as u64);
    }
    pb.finish_and_clear();
    Ok(bytes)
}

fn extract_archive(archive: &Path, dest: &Path, os: &str) -> Result<(), String> {
    let sp = utils::spinner("Extracting...");

    let result = if os == "windows" || archive.extension().map(|e| e == "zip").unwrap_or(false) {
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                    archive.display(),
                    dest.display()
                ),
            ])
            .output()
    } else {
        std::process::Command::new("tar")
            .args([
                "xzf",
                &archive.to_string_lossy(),
                "-C",
                &dest.to_string_lossy(),
            ])
            .output()
    };

    sp.finish_and_clear();

    match result {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => Err(format!(
            "Extract failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )),
        Err(e) => Err(format!("Extract failed: {}", e)),
    }
}

fn find_binary(primary_dir: &Path, fallback_dir: &Path, name: &str) -> Result<std::path::PathBuf, String> {
    // Check primary dir (e.g., age/ subfolder in archive)
    let path = primary_dir.join(name);
    if path.exists() {
        return Ok(path);
    }

    // Recursive search in fallback
    for entry in walk_files(fallback_dir) {
        if let Some(fname) = entry.file_name() {
            if fname.to_string_lossy() == name {
                return Ok(entry);
            }
        }
    }

    Err(format!("Could not find {} in extracted archive", name))
}

fn walk_files(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut results = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                results.extend(walk_files(&path));
            } else {
                results.push(path);
            }
        }
    }
    results
}
