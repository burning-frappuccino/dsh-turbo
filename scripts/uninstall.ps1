<#
.SYNOPSIS
  Remove dsh-turbo from a DeepSeek Harness profile.

.DESCRIPTION
  Reverses install.ps1: deselects the bundle, removes the dependency, and
  optionally deletes the per-session state (mode/metrics/evidence) this plugin
  wrote under $DSH_HOME/storages/dsh-turbo*.

  Removing the bundle with the Web plugin manager (Plugins → dsh-turbo →
  remove) does the same thing; this script exists for scripted uninstalls.

.PARAMETER Profile
  Profile name under $DSH_HOME/profiles. Default: desktop.

.PARAMETER Purge
  Also delete the stored state, metrics and evidence documents.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/uninstall.ps1 -Profile desktop -Purge
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$Purge,
  [string]$Harness = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')
)

$ErrorActionPreference = 'Stop'
$name = 'dsh-turbo'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome "profiles/$Profile"
$manifestPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path $manifestPath)) { throw "unknown profile '$Profile' (no $manifestPath)" }

# ── 1. bundle deselection ────────────────────────────────────────────────────
$profileManifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$bundles = @($profileManifest.dsh.profile.bundles)
if ($bundles -contains $name) {
  $profileManifest.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $name })
  $profileManifest | ConvertTo-Json -Depth 12 | Set-Content $manifestPath -Encoding utf8
  Write-Host "• removed '$name' from dsh.profile.bundles"
} else {
  Write-Host "• '$name' was not selected in $Profile"
}

# ── 2. dependency removal ────────────────────────────────────────────────────
$cli = Join-Path (Split-Path -Parent $Harness) 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
if (Test-Path $cli) {
  $env:ELECTRON_RUN_AS_NODE = '1'
  & $Harness --expose-internals $cli plugin --profile $Profile remove $name
  if ($LASTEXITCODE -ne 0) { Write-Warning "pnpm remove exited $LASTEXITCODE (state was already deselected)" }
} elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
  Push-Location $profileDir
  try { & pnpm remove $name } finally { Pop-Location }
} else {
  Write-Warning 'no bundled CLI and no pnpm; remove the dependency by hand'
}

# ── 3. optional state purge ──────────────────────────────────────────────────
if ($Purge) {
  foreach ($relative in @('storages/dsh-turbo', 'storages/dsh-turbo-bench', 'storages/dsh-turbo-bench-turbo', 'storages/dsh-turbo-bench-default')) {
    $target = Join-Path $dshHome $relative
    if (Test-Path $target) {
      Remove-Item -Recurse -Force $target
      Write-Host "• deleted $target"
    }
  }
  $profiles = Join-Path $dshHome 'profiles'
  if (Test-Path (Join-Path $profiles 'turbo-bench')) {
    Remove-Item -Recurse -Force (Join-Path $profiles 'turbo-bench')
    Write-Host '• deleted the benchmark profile profiles/turbo-bench'
  }
}

Write-Host ''
Write-Host "Done. The Host rows, the prompt section and the composer toggle disappear with the bundle."
Write-Host 'Restart the harness if a running process still shows the toggle.'
