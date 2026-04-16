# KeyPick installer (Windows PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/seanrobertwright/KeyPick/master/install.ps1 | iex
#
# Downloads the latest release zip, extracts the Bun bundle to
# %USERPROFILE%\.local\share\keypick, and drops a keypick.cmd shim at
# %USERPROFILE%\.local\bin.
# Requires Bun: https://bun.sh

$ErrorActionPreference = 'Stop'

$Repo = if ($env:KEYPICK_REPO) { $env:KEYPICK_REPO } else { 'seanrobertwright/KeyPick' }
$ShareDir = if ($env:KEYPICK_SHARE_DIR) { $env:KEYPICK_SHARE_DIR } else { Join-Path $env:USERPROFILE '.local\share\keypick' }
$BinDir   = if ($env:KEYPICK_BIN_DIR)   { $env:KEYPICK_BIN_DIR }   else { Join-Path $env:USERPROFILE '.local\bin' }

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!   $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "x   $m" -ForegroundColor Red; exit 1 }

function Install-KeyPick {
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        Die 'Bun is not installed. Install it first: https://bun.sh'
    }

    Info 'Fetching latest release tag...'
    $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
    $tag = $release.tag_name
    if (-not $tag) { Die 'Could not determine latest release tag.' }
    Info "Latest tag: $tag"

    $asset = "keypick-$tag.zip"
    $url = "https://github.com/$Repo/releases/download/$tag/$asset"
    Info "Downloading $url"

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $zipPath = Join-Path $tmp $asset
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
        Expand-Archive -Path $zipPath -DestinationPath $tmp -Force

        $bundleDir = Join-Path $tmp "keypick-$tag"
        if (-not (Test-Path (Join-Path $bundleDir 'keypick.js'))) {
            Die "keypick.js missing from release archive."
        }

        if (-not (Test-Path $ShareDir)) { New-Item -ItemType Directory -Path $ShareDir -Force | Out-Null }
        if (-not (Test-Path $BinDir))   { New-Item -ItemType Directory -Path $BinDir -Force | Out-Null }

        Copy-Item (Join-Path $bundleDir 'keypick.js')   (Join-Path $ShareDir 'keypick.js')   -Force
        Copy-Item (Join-Path $bundleDir 'package.json') (Join-Path $ShareDir 'package.json') -Force

        $bundlePath = Join-Path $ShareDir 'keypick.js'
        $quote = [char]34
        $shimContent = "@echo off`r`nbun {0}{1}{0} %*`r`n" -f $quote, $bundlePath
        $shimPath = Join-Path $BinDir 'keypick.cmd'
        Set-Content -Path $shimPath -Value $shimContent -Encoding ASCII -NoNewline

        Info "Installed to $ShareDir (shim: $shimPath)"
    }
    finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$BinDir*") {
        Warn "$BinDir is not on your user PATH."
        $response = Read-Host 'Add it now? (y/N)'
        if ($response -match '^[Yy]') {
            [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
            Info 'PATH updated. Restart your shell to pick it up.'
        }
    }
}

function Install-Skill {
    Write-Host ''
    Write-Host 'Install the KeyPick Claude Code skill?'
    Write-Host '  G) Global  - available in every project (~\.claude\skills\keypick)'
    Write-Host '  P) Project - current directory only (.claude\skills\keypick)'
    Write-Host '  S) Skip'
    Write-Host ''
    $scope = Read-Host 'Enter G, P, or S'

    switch ($scope.ToUpper()) {
        'G' { $skillDest = Join-Path $env:USERPROFILE '.claude\skills\keypick' }
        'P' { $skillDest = Join-Path (Get-Location) '.claude\skills\keypick' }
        'S' { Info 'Skipping skill installation.'; return }
        default { Warn "Unrecognised choice '$scope' - skipping skill installation."; return }
    }

    # Prefer a local copy (dev/TS install); fall back to fetching from GitHub.
    $localSkill = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'skills\keypick\SKILL.md' } else { $null }

    if ($localSkill -and (Test-Path $localSkill)) {
        New-Item -ItemType Directory -Path $skillDest -Force | Out-Null
        Copy-Item $localSkill (Join-Path $skillDest 'SKILL.md') -Force
    } else {
        Info 'Fetching skill from GitHub...'
        $rawUrl = "https://raw.githubusercontent.com/$Repo/master/skills/keypick/SKILL.md"
        New-Item -ItemType Directory -Path $skillDest -Force | Out-Null
        Invoke-WebRequest -Uri $rawUrl -OutFile (Join-Path $skillDest 'SKILL.md') -UseBasicParsing
    }

    Info "Skill installed to $skillDest"
}

Info 'KeyPick installer'
Install-KeyPick
Install-Skill

Info "Done. Run 'keypick setup' to get started."
