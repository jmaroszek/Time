<#
.SYNOPSIS
    Builds a signed Time release and the update manifest that offers it.

.DESCRIPTION
    Every public build has to clear the same three Authenticode signatures, and
    an update build has to clear one more thing on top: the Ed25519 signature in
    latest.json must describe the exact bytes users will download. Those two
    requirements fight each other, because Authenticode rewrites the installer.
    Sign the installer after the bundler computed the update signature and the
    signature silently stops matching — every client refuses the update, and
    nothing says so until they do.

    This script removes that ordering hazard rather than checking for it: the
    update signature is regenerated from the finished, Authenticode-signed
    installer as the last step before the manifest is written, so whatever
    happened during bundling cannot leave a stale .sig behind.

    Requires TAURI_SIGNING_PRIVATE_KEY (and its password, if the key has one) in
    the environment. Never pass a key as an argument — it lands in the shell
    history and in this process's command line.
#>
param(
    # Skips the build and uses whatever is already in target/release/bundle.
    # For re-running the manifest half after a failed upload.
    [switch]$SkipBuild,
    # Where latest.json is written. Defaults beside the installer.
    [string]$OutputDirectory,
    # Base address the installer will be downloaded from. The manifest needs an
    # absolute URL; this is the only part of it that is not derivable.
    [string]$DownloadBaseUrl = "https://trackwithtime.com/updates",
    # Release notes shown in the update control. Keep it to a sentence.
    [string]$Notes
)

$ErrorActionPreference = "Stop"

$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$dashboard = Join-Path $repository "dashboard"
$srcTauri = Join-Path $dashboard "src-tauri"
$configPath = Join-Path $srcTauri "tauri.conf.json"
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$version = $config.version

if (-not $version) {
    throw "Release blocked: tauri.conf.json declares no version."
}

# The placeholder ships in the repository on purpose — the real public key is
# half of a keypair whose private half only the owner holds. A build that
# reaches users with the placeholder still in it would advertise updates that
# every client rejects.
if ($config.plugins.updater.pubkey -eq "REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY") {
    throw @"
Release blocked: tauri.conf.json still carries the updater public-key placeholder.
Generate the keypair once, keep the private half out of the repository, and paste
the public half into plugins.updater.pubkey:

    npm --prefix dashboard run tauri signer generate -- -w <path outside this repo>
"@
}

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    throw "Release blocked: TAURI_SIGNING_PRIVATE_KEY is not set. Without it the update manifest cannot be signed."
}

if (-not $SkipBuild) {
    Write-Host "Building $version ..."
    # Runs the tracker sidecar build through beforeBundleCommand, then bundles.
    # Authenticode must be configured inside tauri.conf.json (certificateThumbprint
    # or signCommand) so the bundler signs the binaries it produces; this script
    # verifies that below rather than signing them itself.
    Push-Location $dashboard
    try {
        npm run tauri build
        if ($LASTEXITCODE -ne 0) { throw "Release blocked: tauri build failed." }
    } finally {
        Pop-Location
    }
}

$bundleDir = Join-Path $srcTauri "target\release\bundle\nsis"
$installer = Join-Path $bundleDir "Time_${version}_x64-setup.exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Release blocked: no installer at '$installer'. Build first, or correct the version."
}
$installer = (Resolve-Path -LiteralPath $installer).Path

# The existing gate: valid, timestamped Authenticode on the installer, the
# dashboard executable, and the tracker sidecar. Re-implementing those checks
# here would give the release two definitions of "signed".
& (Join-Path $PSScriptRoot "verify_release.ps1") -Installer $installer
if ($LASTEXITCODE -ne 0) { throw "Release blocked: signature gate failed." }

# The step the ordering hazard makes necessary. Anything that rewrote the
# installer after bundling — Authenticode, a repack, a manual patch — is now
# already in the bytes being signed.
Write-Host "Regenerating the update signature from the final installer ..."
$signaturePath = "$installer.sig"
Remove-Item -LiteralPath $signaturePath -ErrorAction SilentlyContinue
Push-Location $dashboard
try {
    npm run tauri -- signer sign $installer
    if ($LASTEXITCODE -ne 0) { throw "Release blocked: could not sign the installer for the updater." }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf)) {
    throw "Release blocked: the signer wrote no signature to '$signaturePath'."
}
$signature = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
if (-not $signature) {
    throw "Release blocked: the update signature is empty."
}

# Proof the signature belongs to the artifact being published, recorded next to
# it. A hash printed after a signature regenerated from the same path is the
# strongest statement this script can make without reimplementing minisign.
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
$installerName = Split-Path $installer -Leaf
$downloadUrl = "$($DownloadBaseUrl.TrimEnd('/'))/$installerName"

$manifest = [ordered]@{
    version   = $version
    notes     = if ($Notes) { $Notes } else { "" }
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $signature
            url       = $downloadUrl
        }
    }
}

if (-not $OutputDirectory) { $OutputDirectory = $bundleDir }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$manifestPath = Join-Path $OutputDirectory "latest.json"
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8

# Regenerating the signature above removes the ordering hazard; this proves it.
# The check is the client's own: the signature string as the manifest carries it,
# over the installer's bytes, under the public key baked into the build. Cheap,
# and the only alternative place to discover a mismatch is a user's machine.
Write-Host "Verifying the manifest the way a client will ..."
& node (Join-Path $PSScriptRoot "verify_update_signature.mjs") $installer --manifest $manifestPath
if ($LASTEXITCODE -ne 0) { throw "Release blocked: the manifest does not verify against the installer." }

Write-Host ""
Write-Host "Release $version prepared."
Write-Host "  Installer : $installer"
Write-Host "  SHA-256   : $hash"
Write-Host "  Manifest  : $manifestPath"
Write-Host ""
Write-Host "Upload, in this order:"
Write-Host "  1. $installerName  ->  $downloadUrl"
Write-Host "  2. latest.json     ->  $($DownloadBaseUrl.TrimEnd('/'))/latest.json"
Write-Host ""
Write-Host "The installer must be in place before the manifest names it, or the"
Write-Host "first client to check will fetch a URL that is not there yet."
Write-Host "Purge the CDN cache for latest.json afterwards; it is served with a"
Write-Host "short TTL, but a purge is what makes the release immediate."
Write-Host "Put the SHA-256 above into the beta invite note."
