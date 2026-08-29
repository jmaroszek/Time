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
    # Base address the INSTALLER will be downloaded from -- not where the
    # manifest is served. Production splits them: the installer lives under
    # /downloads and latest.json under /updates. This is the only part of the
    # manifest that is not derivable, and it is deliberately mandatory: the
    # value is signed along with the rest of the manifest, so a wrong one cannot
    # be corrected without re-signing, and a default would let the wrong value
    # ship silently. The manifest's own address is read from tauri.conf.json
    # below, because that is what installed copies actually poll.
    [Parameter(Mandatory = $true)]
    [string]$DownloadBaseUrl,
    # Recorded in latest.json as `notes`. NOT shown anywhere in the app, and
    # deliberately so -- the field is carried all the way through (parsed in
    # check_for_update, typed as AvailableUpdate.notes) and then read by nothing.
    # The update control is icon-only; its whole visible text is "Update to
    # <version>". That absence is the intended behaviour, not an unfinished
    # feature, so do not wire it into the UI.
    #
    # It still earns a good sentence: latest.json is served publicly, making this
    # the only machine-readable record of what a version contained.
    [string]$Notes
)

$ErrorActionPreference = "Stop"

$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

# Fail before selecting a versioned artifact: the installer name, manifest, and
# tracker embedded in a release must all describe the same build.
Write-Host "Checking version parity ..."
$python = & (Join-Path $PSScriptRoot "find_python.ps1")
& $python (Join-Path $PSScriptRoot "check_version_parity.py") --root $repository
if ($LASTEXITCODE -ne 0) { throw "Release blocked: version parity check failed." }

$dashboard = Join-Path $repository "dashboard"
$srcTauri = Join-Path $dashboard "src-tauri"
$configPath = Join-Path $srcTauri "tauri.conf.json"
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$version = $config.version

if (-not $version) {
    throw "Release blocked: tauri.conf.json declares no version."
}

$releaseDir = Join-Path $srcTauri "target\release"
$bundleDir = Join-Path $releaseDir "bundle\nsis"
$evidenceDirectory = Join-Path $releaseDir "signing-evidence"

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

# The Authenticode side needs five variables, and tracked configuration names
# none of them: the signing wrapper carries only the regional endpoint, so the
# account and certificate profile arrive through the environment and stay out
# of a public repository. That is a deliberate trade, and this is the cost of
# it -- without a check here the first sign attempt happens deep inside the
# Tauri build, after the frontend, the sidecar, and the Rust release build.
$signingVariables = @(
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_ARTIFACT_SIGNING_ACCOUNT",
    "AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE"
)
$missing = $signingVariables | Where-Object { -not [Environment]::GetEnvironmentVariable($_) }
if ($missing) {
    throw @"
Release blocked: the Authenticode signing environment is incomplete.
Missing: $($missing -join ', ')

These are read by artifact-signing-cli through tauri.conf.json's signing
wrapper. Set them in this shell -- the same one holding the updater key -- and
never in a committed file. See docs/personal/signing.md.
"@
}

$buildId = $null
if (-not $SkipBuild) {
    # A fresh build must not inherit an installer from a rehearsal or signing
    # evidence from an earlier run. -SkipBuild intentionally preserves both so
    # the manifest half can be retried against the exact completed build.
    if (Test-Path -LiteralPath $bundleDir) {
        Remove-Item -LiteralPath $bundleDir -Recurse -Force
    }
    if (Test-Path -LiteralPath $evidenceDirectory) {
        Remove-Item -LiteralPath $evidenceDirectory -Recurse -Force
    }

    $buildId = [Guid]::NewGuid().ToString("N")
    $previousEvidenceDirectory = $env:TIME_RELEASE_SIGNING_EVIDENCE_DIR
    $previousBuildId = $env:TIME_RELEASE_BUILD_ID
    $previousTrackerSignCommand = $env:TIME_SIGN_COMMAND
    $env:TIME_RELEASE_SIGNING_EVIDENCE_DIR = $evidenceDirectory
    $env:TIME_RELEASE_BUILD_ID = $buildId
    # Tauri's signCommand signs the actual external-binary source and captures
    # it. A pre-signed sidecar can make Tauri skip that command, leaving no
    # trustworthy evidence of which tracker NSIS received.
    Remove-Item Env:TIME_SIGN_COMMAND -ErrorAction SilentlyContinue

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
        if ($null -eq $previousEvidenceDirectory) {
            Remove-Item Env:TIME_RELEASE_SIGNING_EVIDENCE_DIR -ErrorAction SilentlyContinue
        } else {
            $env:TIME_RELEASE_SIGNING_EVIDENCE_DIR = $previousEvidenceDirectory
        }
        if ($null -eq $previousBuildId) {
            Remove-Item Env:TIME_RELEASE_BUILD_ID -ErrorAction SilentlyContinue
        } else {
            $env:TIME_RELEASE_BUILD_ID = $previousBuildId
        }
        if ($null -eq $previousTrackerSignCommand) {
            Remove-Item Env:TIME_SIGN_COMMAND -ErrorAction SilentlyContinue
        } else {
            $env:TIME_SIGN_COMMAND = $previousTrackerSignCommand
        }
    }
}

$installer = Join-Path $bundleDir "Time_${version}_x64-setup.exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Release blocked: no installer at '$installer'. Build first, or correct the version."
}
$installer = (Resolve-Path -LiteralPath $installer).Path

# The existing gate: valid, timestamped Authenticode on the installer and the
# app and tracker bytes Tauri gave to NSIS. Re-implementing those checks here
# would give the release two definitions of "signed".
& (Join-Path $PSScriptRoot "verify_release.ps1") -Installer $installer -ExpectedBuildId $buildId
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

# Where the manifest has to be served is not a matter of opinion: it is the
# endpoint compiled into every installed copy, and an installed copy polls that
# address and nothing else. Read it rather than deriving it from
# -DownloadBaseUrl, which addresses the installer and is frequently a different
# path. Getting these two confused publishes a correct manifest to an address
# no client ever reads, and the release looks successful from here.
$manifestEndpoint = $config.plugins.updater.endpoints | Select-Object -First 1
if (-not $manifestEndpoint) {
    throw "Release blocked: tauri.conf.json declares no plugins.updater.endpoints, so there is nowhere for installed copies to look for this manifest."
}

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
Write-Host "  2. latest.json     ->  $manifestEndpoint"
Write-Host ""
Write-Host "The installer must be in place before the manifest names it, or the"
Write-Host "first client to check will fetch a URL that is not there yet."
Write-Host "Purge the CDN cache for latest.json afterwards; it is served with a"
Write-Host "short TTL, but a purge is what makes the release immediate."
Write-Host "Record the SHA-256 above in docs/personal/release-record-<version>.md."
