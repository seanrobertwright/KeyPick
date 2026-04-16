# KeyPick uninstaller (Windows PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/seanrobertwright/KeyPick/master/uninstall.ps1 | iex
#
# Removes the KeyPick bundle, shim, legacy installs, config, and cloned vaults.
# Prompts before deleting the age private key (irreversible).

$ErrorActionPreference = 'Stop'

$ShareDir  = if ($env:KEYPICK_SHARE_DIR) { $env:KEYPICK_SHARE_DIR } else { Join-Path $env:USERPROFILE '.local\share\keypick' }
$BinDir    = if ($env:KEYPICK_BIN_DIR)   { $env:KEYPICK_BIN_DIR }   else { Join-Path $env:USERPROFILE '.local\bin' }
$ConfigDir = if ($env:KEYPICK_HOME)      { $env:KEYPICK_HOME }      else { Join-Path $env:USERPROFILE '.keypick' }
$AgeKeys   = Join-Path $env:APPDATA 'sops\age\keys.txt'
$SkillDir  = Join-Path $env:USERPROFILE '.claude\skills\keypick'

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!   $m" -ForegroundColor Yellow }
function Skip($m) { Write-Host "-   $m" -ForegroundColor DarkGray }

function Confirm-Prompt($prompt, $default) {
    $hint = if ($default -eq 'Y') { 'Y/n' } else { 'y/N' }
    $response = Read-Host "$prompt [$hint]"
    if ([string]::IsNullOrWhiteSpace($response)) { $response = $default }
    return ($response -match '^[Yy]')
}

function Remove-Path($path, $label) {
    if (Test-Path -LiteralPath $path) {
        try {
            Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
            Info "Removed ${label}: $path"
        } catch {
            Warn "Could not remove ${label} (${path}): $($_.Exception.Message)"
        }
    } else {
        Skip "$label not present: $path"
    }
}

Info 'KeyPick uninstaller'
Write-Host ''

# 1. Current install: bundle + shim
Remove-Path $ShareDir 'bundle'
Remove-Path (Join-Path $BinDir 'keypick.cmd') 'shim (.cmd)'
Remove-Path (Join-Path $BinDir 'keypick')     'shim'

# 2. Legacy: bun global install (pre-GitHub-Releases era)
if (Get-Command bun -ErrorAction SilentlyContinue) {
    $pkgs = & bun pm ls -g 2>$null
    if ($pkgs -match 'keypick') {
        Info 'Removing legacy bun global install...'
        & bun remove -g keypick 2>$null | Out-Null
    }
}
@(
    (Join-Path $env:USERPROFILE '.bun\bin\keypick'),
    (Join-Path $env:USERPROFILE '.bun\bin\keypick.exe'),
    (Join-Path $env:USERPROFILE '.bun\bin\keypick.bunx')
) | ForEach-Object {
    if (Test-Path -LiteralPath $_) {
        Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue
        Info "Removed legacy bun shim: $_"
    }
}
$bunPkgDir = Join-Path $env:USERPROFILE '.bun\install\global\node_modules\keypick'
if (Test-Path -LiteralPath $bunPkgDir) {
    Remove-Item -LiteralPath $bunPkgDir -Recurse -Force -ErrorAction SilentlyContinue
    Info "Removed legacy bun package dir: $bunPkgDir"
}

# 3. Legacy: Rust cargo install
if (Get-Command cargo -ErrorAction SilentlyContinue) {
    $cargoList = & cargo install --list 2>$null
    if ($cargoList -match '^keypick') {
        Info 'Removing legacy cargo install...'
        & cargo uninstall keypick 2>$null | Out-Null
    }
}
@(
    (Join-Path $env:USERPROFILE '.cargo\bin\keypick.exe'),
    (Join-Path $env:USERPROFILE '.cargo\bin\keypick2.exe')
) | ForEach-Object {
    if (Test-Path -LiteralPath $_) {
        Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue
        Info "Removed legacy cargo artifact: $_"
    }
}

# 4. Config + cloned vaults
if (Test-Path -LiteralPath $ConfigDir) {
    Write-Host ''
    Warn "Config + cloned vaults: $ConfigDir"
    Get-ChildItem -LiteralPath $ConfigDir -Force -ErrorAction SilentlyContinue |
        Select-Object -First 10 |
        ForEach-Object { Write-Host "    $($_.Name)" }
    if (Confirm-Prompt "Remove $ConfigDir (clones live here; git remotes remain intact)?" 'Y') {
        Remove-Item -LiteralPath $ConfigDir -Recurse -Force -ErrorAction SilentlyContinue
        Info "Removed $ConfigDir"
    } else {
        Skip "Kept $ConfigDir"
    }
} else {
    Skip "No config dir at $ConfigDir"
}

# 5. Claude Code skill
if (Test-Path -LiteralPath $SkillDir) {
    if (Confirm-Prompt "Remove KeyPick Claude Code skill at ${SkillDir}?" 'Y') {
        Remove-Item -LiteralPath $SkillDir -Recurse -Force -ErrorAction SilentlyContinue
        Info "Removed skill: $SkillDir"
    } else {
        Skip "Kept skill: $SkillDir"
    }
}

# 6. Age private key (irreversible)
if (Test-Path -LiteralPath $AgeKeys) {
    Write-Host ''
    Warn "DANGER: age private key at $AgeKeys"
    Warn 'This is the ONLY way to decrypt your vault on this machine.'
    Warn 'Without a recovery key, other machines, or a backup, deleting'
    Warn 'this makes your vault contents permanently inaccessible.'
    if (Confirm-Prompt 'Delete age private key anyway?' 'N') {
        Remove-Item -LiteralPath $AgeKeys -Force -ErrorAction SilentlyContinue
        Info "Removed age private key: $AgeKeys"
    } else {
        Skip 'Kept age private key'
    }
} else {
    Skip "No age private key at $AgeKeys"
}

Write-Host ''
Info 'Uninstall complete.'
