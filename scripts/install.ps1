<#
.SYNOPSIS
  Install dsh-turbo into a DeepSeek Harness profile and select its bundle.

.DESCRIPTION
  Windows-first installer that does the two things a bundle install needs:
    1. make the package resolvable from the profile (pnpm add link:<path>);
    2. append the bundle name to `dsh.profile.bundles` (idempotent).

  It uses the *bundled* CLI shipped with the desktop app, so it works even when
  no `dsh` command is on PATH and even when the PATH `dsh` is an older CLI.

  The Web plugin manager does the same two steps; use this script for scripted
  installs or when the GUI is unavailable. Profile configuration reloads live,
  but a running process keeps already-imported modules — restart the app when
  you want a rebuilt plugin's newest code (see compatibility-report.md §9).

.PARAMETER Profile
  Profile name under $DSH_HOME/profiles. Default: desktop (the GUI's profile).

.PARAMETER Path
  Plugin directory. Default: the parent of this script's directory.

.PARAMETER Harness
  Path to "DeepSeek Harness.exe". Default: the per-user install location.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Profile desktop
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$Path = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [string]$Harness = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')
)

$ErrorActionPreference = 'Stop'
$pluginPath = (Resolve-Path $Path).Path
if (-not (Test-Path (Join-Path $pluginPath 'package.json'))) {
  throw "not a plugin directory (no package.json): $pluginPath"
}
$manifest = Get-Content (Join-Path $pluginPath 'package.json') -Raw | ConvertFrom-Json
$name = $manifest.name
if (-not $manifest.dsh.bundle.patch) {
  throw "$name does not declare dsh.bundle.patch, so it is not an installable bundle"
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome "profiles/$Profile"
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
  throw "unknown profile '$Profile' (no $profileDir\package.json)"
}

# ── 1. dependency ────────────────────────────────────────────────────────────
$cli = Join-Path (Split-Path -Parent $Harness) 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
if (Test-Path $cli) {
  Write-Host "• installing $name into profile '$Profile' via the bundled CLI"
  $spec = "link:$($pluginPath -replace '\\','/')"
  $env:ELECTRON_RUN_AS_NODE = '1'
  & $Harness --expose-internals $cli plugin --profile $Profile add $spec
  if ($LASTEXITCODE -ne 0) { throw "pnpm add failed with exit code $LASTEXITCODE" }
} elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
  Write-Host "• bundled CLI not found; using pnpm in $profileDir"
  Push-Location $profileDir
  try {
    & pnpm add "link:$($pluginPath -replace '\\','/')"
    if ($LASTEXITCODE -ne 0) { throw "pnpm add failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
} else {
  throw 'neither the bundled dsh CLI nor pnpm is available'
}

# ── 2. bundle selection ──────────────────────────────────────────────────────
$manifestPath = Join-Path $profileDir 'package.json'
$profileManifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if (-not $profileManifest.dsh) { $profileManifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
if (-not $profileManifest.dsh.profile) { $profileManifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
if (-not $profileManifest.dsh.profile.bundles) {
  $profileManifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
}
$bundles = @($profileManifest.dsh.profile.bundles)
if ($bundles -contains $name) {
  Write-Host "• bundle '$name' is already selected in $Profile"
} else {
  $profileManifest.dsh.profile.bundles = @($bundles + $name)
  $profileManifest | ConvertTo-Json -Depth 12 | Set-Content $manifestPath -Encoding utf8
  Write-Host "• added '$name' to dsh.profile.bundles"
}

# ── 3. verification hints ────────────────────────────────────────────────────
$port = 19387
Write-Host ''
Write-Host 'Next steps:'
Write-Host "  1. If the harness is running, let the profile reload settle (or restart it to load rebuilt code)."
Write-Host "  2. Refresh the Web UI once so the client bundle enters the boot graph."
Write-Host "  3. Verify the Host half:"
Write-Host "       Invoke-RestMethod http://127.0.0.1:$port/api/dsh-turbo/health"
Write-Host "  4. A new conversation starts with Turbo OFF unless config defaultMode is 'turbo'."
