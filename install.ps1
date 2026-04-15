# KeyPick installer (Windows PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/seanrobertwright/KeyPick/master/install.ps1 | iex
#
# Prompts for Rust or TypeScript, then installs the chosen variant.

$ErrorActionPreference = 'Stop'

$Repo = 'seanrobertwright/KeyPick'
$InstallDir = if ($env:KEYPICK_INSTALL_DIR) { $env:KEYPICK_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.local\bin' }

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!   $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "x   $m" -ForegroundColor Red; exit 1 }

function Install-Rust {
    $arch = if ([Environment]::Is64BitOperatingSystem) { 'x86_64' } else { Die "Only 64-bit Windows is supported." }
    $platform = "windows-$arch"

    Info 'Fetching latest release tag...'
    $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
    $tag = $release.tag_name
    if (-not $tag) { Die 'Could not determine latest release tag.' }
    Info "Latest tag: $tag"

    $asset = "keypick-$tag-$platform.zip"
    $url = "https://github.com/$Repo/releases/download/$tag/$asset"
    Info "Downloading $url"

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $zipPath = Join-Path $tmp 'keypick.zip'
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
        Expand-Archive -Path $zipPath -DestinationPath $tmp -Force

        $binary = Get-ChildItem -Path $tmp -Recurse -Filter 'keypick.exe' | Select-Object -First 1
        if (-not $binary) { Die 'keypick.exe not found in release archive.' }

        if (-not (Test-Path $InstallDir)) {
            New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        }
        $dest = Join-Path $InstallDir 'keypick.exe'
        Copy-Item $binary.FullName $dest -Force
        Info "Installed to $dest"
    }
    finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$InstallDir*") {
        Warn "$InstallDir is not on your user PATH."
        $response = Read-Host 'Add it now? (y/N)'
        if ($response -match '^[Yy]') {
            [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
            Info 'PATH updated. Restart your shell to pick it up.'
        }
    }
}

function Install-TS {
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        Die 'Bun is not installed. Install it first: https://bun.sh — or choose the Rust option.'
    }
    Info 'Running: bun install -g keypick'
    bun install -g keypick
    if ($LASTEXITCODE -ne 0) { Die 'bun install failed.' }
}

Info 'KeyPick installer'
Write-Host ''
Write-Host 'Choose the implementation to install:'
Write-Host '  1) Rust (prebuilt binary — no runtime required)'
Write-Host '  2) TypeScript (via Bun — easier to hack on)'
Write-Host ''
$choice = Read-Host 'Enter 1 or 2'

switch ($choice) {
    '1' { Install-Rust }
    '2' { Install-TS }
    default { Die "Invalid choice: $choice" }
}

Info "Done. Run 'keypick setup' to get started."
