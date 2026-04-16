# KeyPick installer (Windows PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/seanrobertwright/KeyPick/master/install.ps1 | iex
#
# Runs `bun install -g keypick` (requires Bun).

$ErrorActionPreference = 'Stop'

$Repo = 'seanrobertwright/KeyPick'

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!   $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "x   $m" -ForegroundColor Red; exit 1 }

function Install-KeyPick {
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        Die 'Bun is not installed. Install it first: https://bun.sh'
    }
    Info 'Running: bun install -g keypick'
    bun install -g keypick
    if ($LASTEXITCODE -ne 0) { Die 'bun install failed.' }
}

function Install-Skill {
    Write-Host ''
    Write-Host 'Install the KeyPick Claude Code skill?'
    Write-Host '  G) Global  — available in every project (~\.claude\skills\keypick)'
    Write-Host '  P) Project — current directory only (.claude\skills\keypick)'
    Write-Host '  S) Skip'
    Write-Host ''
    $scope = Read-Host 'Enter G, P, or S'

    switch ($scope.ToUpper()) {
        'G' { $skillDest = Join-Path $env:USERPROFILE '.claude\skills\keypick' }
        'P' { $skillDest = Join-Path (Get-Location) '.claude\skills\keypick' }
        'S' { Info 'Skipping skill installation.'; return }
        default { Warn "Unrecognised choice '$scope' — skipping skill installation."; return }
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
