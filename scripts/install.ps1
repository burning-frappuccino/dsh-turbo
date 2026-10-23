<#
.SYNOPSIS
  Install or update dsh-turbo in a DeepSeek Harness profile.

.DESCRIPTION
  Does the two things a bundle install needs:
    1. make the package resolvable from the profile (pnpm add link:<path>);
    2. append the bundle name to `dsh.profile.bundles` (idempotent).

  Runs on Windows PowerShell 5.1 and PowerShell 7. Notes that cost an earlier
  revision a crash, kept here deliberately:
    * `$MyInvocation.MyCommand.Path` is EMPTY inside a `param()` default when the
      script is started with `-File`; use `$PSScriptRoot` and resolve after
      binding.
    * `resources\app.asar` is a FILE. `Test-Path` cannot see a path "inside" it,
      but Electron's node can load it; test the archive, not the inner path.
    * The harness executable is a GUI subsystem app: Windows PowerShell does not
      wait for it and leaves `$LASTEXITCODE` unset. Prefer pnpm (a console app);
      when falling back to the bundled CLI, force the wait and verify the
      result from the profile manifest instead of an exit code.

  A version update always ends with a harness restart: Cordis/Node cache modules
  by resolved path, so a rebuilt plugin is not re-imported in place.

.PARAMETER Profile
  Profile name under $DSH_HOME/profiles. Default: desktop (the GUI's profile).

.PARAMETER Path
  Plugin directory. Default: the parent of this script's directory.

.PARAMETER Harness
  Path to "DeepSeek Harness.exe". Default: the per-user install location.

.PARAMETER UseBundledCli
  Force the harness' own bundled CLI even when pnpm is on PATH.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -Profile desktop

.NOTES
  `-NoProfile` is recommended: a broken conda/python init in your PowerShell
  profile prints its traceback before this script even starts.
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$Path,
  [string]$Harness,
  [switch]$UseBundledCli
)

$ErrorActionPreference = 'Stop'

# -- 0. resolve defaults after binding (never inside param()) -----------------
if (-not $Path) {
  $Path = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
}
if (-not $Harness) {
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set; pass -Harness <path to DeepSeek Harness.exe>' }
  $Harness = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
}

$pluginPath = (Resolve-Path -LiteralPath $Path).Path
$manifestFile = Join-Path $pluginPath 'package.json'
if (-not (Test-Path -LiteralPath $manifestFile)) { throw "not a plugin directory (no package.json): $pluginPath" }
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
$name = $manifest.name
if (-not $manifest.dsh.bundle.patch) { throw "$name does not declare dsh.bundle.patch, so it is not an installable bundle" }

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome "profiles/$Profile"
$profileManifestFile = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $profileManifestFile)) { throw "unknown profile '$Profile' (no $profileManifestFile)" }

$spec = "link:$($pluginPath -replace '\\','/')"
Write-Host "* plugin : $name $($manifest.version)  ($pluginPath)"
Write-Host "* profile: $Profile  ($profileDir)"

# -- 1. dependency -----------------------------------------------------------
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$installed = $false
if (-not $UseBundledCli -and $pnpm) {
  Write-Host '* installing the dependency with pnpm'
  Push-Location $profileDir
  try {
    & $pnpm.Source add $spec 2>&1 | Out-Host
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($null -ne $code -and $code -ne 0) { throw "pnpm add failed with exit code $code" }
  $installed = $true
}

if (-not $installed) {
  if (-not (Test-Path -LiteralPath $Harness)) {
    throw "cannot find the harness executable at '$Harness'; pass -Harness <path to DeepSeek Harness.exe>"
  }
  # app.asar is a file: test the archive, not the path inside it.
  $asar = Join-Path (Split-Path -Parent $Harness) 'resources\app.asar'
  $cli = "$asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
  if (-not (Test-Path -LiteralPath $asar)) {
    throw "no bundled CLI at $asar and no pnpm on PATH; install pnpm or pass -Harness"
  }
  Write-Host '* installing the dependency with the harness bundled CLI'
  $env:ELECTRON_RUN_AS_NODE = '1'
  # Piping the GUI app's output is what makes Windows PowerShell wait for it.
  & $Harness --expose-internals $cli plugin --profile $Profile add $spec 2>&1 | Out-Host
}

# Verify from the manifest: an exit code is not portable across shells here.
$profileManifest = Get-Content -LiteralPath $profileManifestFile -Raw | ConvertFrom-Json
$dependency = $null
if ($profileManifest.dependencies) {
  $dependency = $profileManifest.dependencies.PSObject.Properties[$name]
}
if (-not $dependency) {
  throw "the dependency '$name' is still missing from $profileManifestFile; the package step did not complete"
}
Write-Host "* dependency present: $name = $($dependency.Value)"

# -- 2. bundle selection -----------------------------------------------------
# Re-read: the package step may have rewritten the manifest.
$profileManifest = Get-Content -LiteralPath $profileManifestFile -Raw | ConvertFrom-Json
if (-not $profileManifest.dsh) { $profileManifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
if (-not $profileManifest.dsh.profile) { $profileManifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
if (-not $profileManifest.dsh.profile.bundles) {
  $profileManifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
}
$bundles = @($profileManifest.dsh.profile.bundles)
if ($bundles -contains $name) {
  Write-Host "* bundle '$name' is already selected in '$Profile'"
} else {
  $profileManifest.dsh.profile.bundles = @($bundles + $name)
  $profileManifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $profileManifestFile -Encoding utf8
  Write-Host "* added '$name' to dsh.profile.bundles"
}

# -- 3. live verification (best effort) --------------------------------------
$port = 19387
$reported = $null
for ($attempt = 1; $attempt -le 5; $attempt++) {
  try {
    $reported = Invoke-RestMethod "http://127.0.0.1:$port/api/dsh-turbo/health" -TimeoutSec 5 -ErrorAction Stop
    if ($reported -and $reported.ok) { break }
  } catch {
    $reported = $null
  }
  Start-Sleep -Seconds 1
}

Write-Host ''
if ($reported -and $reported.ok) {
  Write-Host "* host bridge answered: version $($reported.version), tracked sessions $($reported.trackedSessions)"
  if ($reported.version -ne $manifest.version) {
    Write-Host "  ! the RUNNING process still serves $($reported.version); restart the harness to load $($manifest.version)"
  }
} else {
  Write-Host '* host bridge did not answer: the dsh-turbo row is not active right now'
  Write-Host "  after a version update this is expected: the running process still holds the"
  Write-Host "  OLD module, and a new config key (or a new lib/) cannot activate in it."
  Write-Host "  restart DeepSeek Harness to load $($manifest.version)."
}
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Restart DeepSeek Harness (a rebuilt plugin is never re-imported in place).'
Write-Host '  2. Refresh the Web UI once so the client bundle enters the boot graph.'
Write-Host "  3. Verify: Invoke-RestMethod http://127.0.0.1:$port/api/dsh-turbo/health"
Write-Host "  4. New conversations start with Turbo OFF unless config defaultMode is 'turbo'."
