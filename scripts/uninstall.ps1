<#
.SYNOPSIS
  Remove dsh-turbo from a DeepSeek Harness profile.

.DESCRIPTION
  Reverses install.ps1: deselects the bundle, removes the dependency, and
  optionally deletes the per-session state (mode/metrics/evidence) this plugin
  wrote under $DSH_HOME/storages/dsh-turbo*.

  Removing the bundle with the Web plugin manager (Plugins -> dsh-turbo ->
  remove) does the same thing; this script exists for scripted uninstalls.

  Same Windows caveats as install.ps1: defaults resolve after binding, app.asar
  is a file, and the GUI harness process needs a forced wait plus a
  manifest-based verification.

.PARAMETER Profile
  Profile name under $DSH_HOME/profiles. Default: desktop.

.PARAMETER Purge
  Also delete the stored state, metrics and evidence documents, and the
  benchmark profile created by scripts/benchmark.mjs.

.PARAMETER UseBundledCli
  Force the harness' own bundled CLI even when pnpm is on PATH.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall.ps1 -Profile desktop -Purge
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$Purge,
  [string]$Harness,
  [switch]$UseBundledCli
)

$ErrorActionPreference = 'Stop'

if (-not $Harness) {
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set; pass -Harness <path to DeepSeek Harness.exe>' }
  $Harness = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
}

$name = 'dsh-turbo'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome "profiles/$Profile"
$profileManifestFile = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $profileManifestFile)) { throw "unknown profile '$Profile' (no $profileManifestFile)" }

# -- 1. bundle deselection ---------------------------------------------------
$profileManifest = Get-Content -LiteralPath $profileManifestFile -Raw | ConvertFrom-Json
$bundles = @()
if ($profileManifest.dsh -and $profileManifest.dsh.profile -and $profileManifest.dsh.profile.bundles) {
  $bundles = @($profileManifest.dsh.profile.bundles)
}
if ($bundles -contains $name) {
  $profileManifest.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $name })
  $profileManifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $profileManifestFile -Encoding utf8
  Write-Host "* removed '$name' from dsh.profile.bundles"
} else {
  Write-Host "* '$name' was not selected in '$Profile'"
}

# -- 2. dependency removal ---------------------------------------------------
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$removed = $false
if (-not $UseBundledCli -and $pnpm) {
  Push-Location $profileDir
  try {
    & $pnpm.Source remove $name 2>&1 | Out-Host
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($null -ne $code -and $code -ne 0) { Write-Warning "pnpm remove exited $code (the bundle is already deselected)" }
  $removed = $true
}

if (-not $removed) {
  $asar = Join-Path (Split-Path -Parent $Harness) 'resources\app.asar'
  $cli = "$asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
  if (Test-Path -LiteralPath $asar) {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $Harness --expose-internals $cli plugin --profile $Profile remove $name 2>&1 | Out-Host
  } else {
    Write-Warning 'no pnpm on PATH and no bundled CLI; remove the dependency by hand'
  }
}

# Verify from the manifest rather than an exit code.
$after = Get-Content -LiteralPath $profileManifestFile -Raw | ConvertFrom-Json
$stillThere = $false
if ($after.dependencies) { $stillThere = $null -ne $after.dependencies.PSObject.Properties[$name] }
if ($stillThere) { Write-Warning "the dependency '$name' is still listed in $profileManifestFile" }
else { Write-Host "* dependency '$name' is gone from the profile" }

# -- 3. optional state purge -------------------------------------------------
if ($Purge) {
  foreach ($relative in @('storages/dsh-turbo', 'storages/dsh-turbo-bench', 'storages/dsh-turbo-bench-turbo', 'storages/dsh-turbo-bench-default', 'storages/dsh-turbo-probe')) {
    $target = Join-Path $dshHome $relative
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force
      Write-Host "* deleted $target"
    }
  }
  $benchProfile = Join-Path $dshHome 'profiles/turbo-bench'
  if (Test-Path -LiteralPath $benchProfile) {
    Remove-Item -LiteralPath $benchProfile -Recurse -Force
    Write-Host '* deleted the benchmark profile profiles/turbo-bench'
  }
}

Write-Host ''
Write-Host 'Done. The Host rows, the prompt section and the composer toggle disappear with the bundle.'
Write-Host 'Restart the harness if a running process still shows the toggle.'
