<#
.SYNOPSIS
    Builds an unsigned rehearsal release and the update manifest that offers it.

.DESCRIPTION
    The update mechanism's logic — version comparison, manifest fetch, signature
    verification, download, passive install — has nothing to do with
    Authenticode. Proving it works therefore does not need a code-signing
    signature, which is the scarce, expensive half of Time's signing story; the
    updater's Ed25519 key has no CA, no expiry, and no cost.

    publish_release.ps1 is the real release path and gates on Authenticode
    deliberately. This script is the rehearsal path: same signing, same manifest,
    same last-step signature regeneration, no Authenticode gate. It is a separate
    file rather than a switch on the release script because a flag that skips the
    signature gate is a flag somebody eventually ships with.

    Nothing it produces is publishable. Every artifact is stamped as a rehearsal
    and the script says so on the way in and the way out.

    Requires TAURI_SIGNING_PRIVATE_KEY, and TAURI_SIGNING_PRIVATE_KEY_PASSWORD if
    the key has a password. Never pass a key or password as an argument — both
    land in the shell history and in this process's command line.

.EXAMPLE
    # The "before" build: what gets installed in the VM. No manifest.
    pwsh -File scripts/rehearse_update.ps1 -Version 0.1.0 `
        -Endpoint https://time-update-rehearsal.pages.dev/updates/latest.json -NoManifest

.EXAMPLE
    # The "after" build: what the manifest offers.
    pwsh -File scripts/rehearse_update.ps1 -Version 0.1.1 `
        -DownloadBaseUrl https://time-update-rehearsal.pages.dev/updates `
        -Notes "Rehearsal of the update path."
#>
param(
    # The version this build reports and is named for. Applied as a config
    # override so no tracked file has to be edited and then remembered about.
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    # Updater endpoint to bake into this build, replacing the production one.
    # Only the "before" build needs it: it is the copy that does the checking.
    [string]$Endpoint,

    # Base address the manifest will point at for the installer. Required unless
    # -NoManifest, because a manifest needs an absolute URL and nothing else here
    # can derive it.
    [string]$DownloadBaseUrl,

    # Where the uploadable site is assembled. Files land in <dir>/updates/ so the
    # layout matches production and only the hostname differs.
    [string]$StageDirectory,

    [string]$Notes = "Rehearsal build. Not a release.",

    # Reuses whatever is already in target/release/bundle for this version.
    [switch]$SkipBuild,

    # For the "before" build, which is installed rather than offered.
    [switch]$NoManifest
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  REHEARSAL BUILD — NOT FOR RELEASE" -ForegroundColor Yellow
Write-Host "  Unsigned (no Authenticode). Do not hand these artifacts to anyone." -ForegroundColor Yellow
Write-Host ""

$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$dashboard = Join-Path $repository "dashboard"
$srcTauri = Join-Path $dashboard "src-tauri"
$configPath = Join-Path $srcTauri "tauri.conf.json"
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

# The same guard publish_release.ps1 carries, and for a sharper reason here: the
# rehearsal's whole point is that the installed copy verifies against the key
# baked into it. Rehearsing with the placeholder proves nothing at all.
if ($config.plugins.updater.pubkey -eq "REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY") {
    throw @"
Rehearsal blocked: tauri.conf.json still carries the updater public-key placeholder.
Generate the keypair once, keep the private half out of the repository, and paste
the public half into plugins.updater.pubkey:

    npm --prefix dashboard run tauri signer generate -- -w <path outside this repo>
"@
}

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    throw "Rehearsal blocked: TAURI_SIGNING_PRIVATE_KEY is not set. Without it the build emits no .sig and there is nothing to verify."
}

# The variable holds the key's contents. Given a path, the CLI reports "failed to
# decode base64 secret key", which reads like a corrupt key rather than the wrong
# kind of value — and only after the build has finished.
if ($env:TAURI_SIGNING_PRIVATE_KEY -notmatch "\s" -and (Test-Path -LiteralPath $env:TAURI_SIGNING_PRIVATE_KEY -PathType Leaf -ErrorAction SilentlyContinue)) {
    throw @"
Rehearsal blocked: TAURI_SIGNING_PRIVATE_KEY looks like a path, and it must hold
the key's contents:

    `$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$($env:TAURI_SIGNING_PRIVATE_KEY)"
"@
}

# A password-protected key with no password in the environment does not fail —
# the signer stops and waits on a prompt that a scripted build never answers, so
# the build appears to hang. Say so before starting a ten-minute compile.
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    Write-Host "TAURI_SIGNING_PRIVATE_KEY_PASSWORD is unset. If the key has a password, the" -ForegroundColor Yellow
    Write-Host "signer will stop at a prompt nothing here answers and this will look like a hang." -ForegroundColor Yellow
    Write-Host ""
}

if (-not $NoManifest -and -not $DownloadBaseUrl) {
    throw "Rehearsal blocked: -DownloadBaseUrl is required unless -NoManifest is given."
}

if (-not $StageDirectory) {
    $StageDirectory = Join-Path $srcTauri "target\rehearsal\site"
}

$bundleDir = Join-Path $srcTauri "target\release\bundle\nsis"
$installer = Join-Path $bundleDir "Time_${Version}_x64-setup.exe"

if (-not $SkipBuild) {
    # PATH used to decide which interpreter packaged the sidecar, because
    # beforeBundleCommand invoked a bare `python` — and the first one on this
    # machine is Anaconda base, which carries most of the pinned packages but no
    # winrt. That workaround lived here and nowhere else, which meant the real
    # release path did not have it. `build:tracker` now resolves the interpreter
    # itself through run_python.mjs, so both paths pick the pinned environment
    # for the same reason. The bundle check below still runs: it verifies the
    # artifact rather than the interpreter, and those can fail independently.

    # A file rather than an inline JSON string: --config takes either, and a
    # path cannot be mangled by a quoting rule between PowerShell, npm, and the
    # Tauri CLI. Merged over tauri.conf.json, so a partial document is correct.
    $override = [ordered]@{
        version = $Version
        # The "unsigned" in this script's own banner. tauri.conf.json carries a
        # signCommand, so without this override a rehearsal Authenticode-signs
        # like a release -- spending a certificate operation on an artifact
        # whose first printed line says it did not. That is not hypothetical:
        # the signCommand landed after this script did, and nothing tied the
        # two together until scripts/tests/test_unsigned_builds.py.
        #
        # Only the Authenticode half. createUpdaterArtifacts stays on, because
        # the .sig this produces is the whole point of a rehearsal.
        bundle  = [ordered]@{ windows = [ordered]@{ signCommand = $null } }
    }
    if ($Endpoint) {
        $override.plugins = @{ updater = @{ endpoints = @($Endpoint) } }
    }
    $overridePath = Join-Path ([System.IO.Path]::GetTempPath()) "time-rehearsal-$Version.json"
    $override | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $overridePath -Encoding utf8

    Write-Host "Building $Version ..."
    if ($Endpoint) { Write-Host "  Endpoint baked in: $Endpoint" }
    Push-Location $dashboard
    try {
        # tauri-build merges TAURI_CONFIG before codegen, so this version is the
        # one package_info() reports — which is what the updater compares.
        npm run tauri -- build --config $overridePath
        if ($LASTEXITCODE -ne 0) { throw "Rehearsal blocked: tauri build failed." }
    } finally {
        Pop-Location
        Remove-Item -LiteralPath $overridePath -ErrorAction SilentlyContinue
    }

    # The pin guard runs during the build, but it checks the interpreter rather
    # than the bundle. Confirm the packaged sidecar actually carries the media
    # extension: without it the tracker silently stops exempting playback from
    # AFK, which looks like a code regression rather than a build one.
    $mediaExtension = Get-ChildItem -Path (Join-Path $repository "tracker\dist\time-tracker\_internal\winrt") `
        -Filter "_winrt_windows_media_control*.pyd" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $mediaExtension) {
        throw "Rehearsal blocked: the packaged sidecar has no winrt media-control extension. The wrong python built it."
    }
    Write-Host "Packaged sidecar carries $($mediaExtension.Name)."
}

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Rehearsal blocked: no installer at '$installer'. Build first, or correct the version."
}
$installer = (Resolve-Path -LiteralPath $installer).Path

if ($NoManifest) {
    $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
    Write-Host ""
    Write-Host "Rehearsal $Version built (no manifest requested)."
    Write-Host "  Installer : $installer"
    Write-Host "  SHA-256   : $hash"
    Write-Host ""
    Write-Host "This is the copy to install in the VM. It will check:"
    Write-Host "  $(if ($Endpoint) { $Endpoint } else { $config.plugins.updater.endpoints[0] })"
    return
}

# The ordering discipline publish_release.ps1 exists to enforce, kept here so the
# two paths cannot drift: whatever touched the installer after bundling is now
# already in the bytes being signed.
Write-Host "Regenerating the update signature from the finished installer ..."
$signaturePath = "$installer.sig"
Remove-Item -LiteralPath $signaturePath -ErrorAction SilentlyContinue
Push-Location $dashboard
try {
    npm run tauri -- signer sign $installer
    if ($LASTEXITCODE -ne 0) { throw "Rehearsal blocked: could not sign the installer for the updater." }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf)) {
    throw "Rehearsal blocked: the signer wrote no signature to '$signaturePath'."
}
$signature = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
if (-not $signature) {
    throw "Rehearsal blocked: the update signature is empty."
}

$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
$installerName = Split-Path $installer -Leaf
$downloadUrl = "$($DownloadBaseUrl.TrimEnd('/'))/$installerName"

$manifest = [ordered]@{
    version   = $Version
    notes     = $Notes
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $signature
            url       = $downloadUrl
        }
    }
}

# Staged under updates/ so the deployed layout matches production exactly and the
# hostname is the only thing that differs between rehearsal and release.
$updatesDir = Join-Path $StageDirectory "updates"
New-Item -ItemType Directory -Force -Path $updatesDir | Out-Null
$manifestPath = Join-Path $updatesDir "latest.json"
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Copy-Item -LiteralPath $installer -Destination (Join-Path $updatesDir $installerName) -Force

# The client's own computation, run against the staged pair rather than the build
# output: signature as the manifest carries it, over the installer as staged,
# under the pubkey as configured. A pass leaves only the upload and the network.
Write-Host ""
Write-Host "Verifying the staged manifest the way a client will ..."
node (Join-Path $PSScriptRoot "verify_update_signature.mjs") (Join-Path $updatesDir $installerName) --manifest $manifestPath
if ($LASTEXITCODE -ne 0) { throw "Rehearsal blocked: the staged manifest does not verify." }

Write-Host ""
Write-Host "Rehearsal $Version staged."
Write-Host "  Installer : $installer"
Write-Host "  SHA-256   : $hash"
Write-Host "  Site root : $StageDirectory"
Write-Host "  Serves    : $($DownloadBaseUrl.TrimEnd('/'))/latest.json"
Write-Host ""
Write-Host "Deploy the staged directory, then confirm both URLs answer before"
Write-Host "letting the VM check — a manifest that names an installer which is"
Write-Host "not there yet fails as though the update mechanism were broken."
