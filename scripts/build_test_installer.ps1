<#
.SYNOPSIS
    Builds an unsigned NSIS installer for testing. Never for release.

.DESCRIPTION
    The installer you put in a VM. Same bundler, same hooks, same sidecar as a
    release; no Authenticode signature and no updater artifacts, so it needs no
    Azure account and no Ed25519 key and costs nothing to produce.

    There are three build paths and they are separate files on purpose, because
    a flag that skips a signature gate is a flag somebody eventually ships with:

      publish_release.ps1     signs, and refuses to proceed without every
                              credential. The only path whose output may reach
                              a user.
      rehearse_update.ps1     proves the update mechanism: unsigned installer,
                              signed manifest. Needs the Ed25519 key.
      build_test_installer.ps1 (this)  proves the application: unsigned, no
                              manifest, no keys of any kind.

    Nothing here is publishable. The artifact is stamped nowhere, so it looks
    exactly like a release build to anyone holding it -- which is why the hash
    is printed and why the unsigned check below is a hard failure rather than a
    warning. Hand this to nobody.

.EXAMPLE
    # Whatever tauri.conf.json currently says the version is.
    pwsh -File scripts/build_test_installer.ps1

.EXAMPLE
    # An older version number, to install first and then upgrade over. Note this
    # only changes what the build calls itself -- to test a migration you need a
    # build from a commit that actually had the older schema.
    pwsh -File scripts/build_test_installer.ps1 -Version 0.9.0
#>
param(
    # Applied as a config override so no tracked file has to be edited and then
    # remembered about. Defaults to the version already in tauri.conf.json.
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    # Reuses whatever is already in target/release/bundle for this version.
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  TEST BUILD - NOT FOR RELEASE" -ForegroundColor Yellow
Write-Host "  Unsigned, no updater artifacts. Do not hand this to anyone." -ForegroundColor Yellow
Write-Host ""

$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$dashboard = Join-Path $repository "dashboard"
$srcTauri = Join-Path $dashboard "src-tauri"
$config = Get-Content -LiteralPath (Join-Path $srcTauri "tauri.conf.json") -Raw | ConvertFrom-Json

if (-not $Version) { $Version = $config.version }

$installer = Join-Path $srcTauri "target\release\bundle\nsis\Time_${Version}_x64-setup.exe"

if (-not $SkipBuild) {
    # A file rather than an inline JSON string: --config takes either, and a
    # path cannot be mangled by a quoting rule between PowerShell, npm, and the
    # Tauri CLI. Merged over tauri.conf.json, so a partial document is correct.
    #
    # signCommand null is what makes this build free. createUpdaterArtifacts
    # false is what makes it possible at all without a key -- the bundler needs
    # TAURI_SIGNING_PRIVATE_KEY to emit a .sig, and a test install never reads
    # one.
    $overridePath = Join-Path ([System.IO.Path]::GetTempPath()) "time-test-build-$Version.json"
    [ordered]@{
        version = $Version
        bundle  = [ordered]@{
            createUpdaterArtifacts = $false
            windows                = [ordered]@{ signCommand = $null }
        }
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $overridePath -Encoding utf8

    Write-Host "Building $Version ..."
    Push-Location $dashboard
    try {
        npm run tauri -- build --config $overridePath
        if ($LASTEXITCODE -ne 0) { throw "Test build failed." }
    } finally {
        Pop-Location
        Remove-Item -LiteralPath $overridePath -ErrorAction SilentlyContinue
    }

    # The interpreter guard runs during the build, but it checks the interpreter
    # rather than the bundle. Confirm the packaged sidecar actually carries the
    # media extension: without it the tracker silently stops exempting playback
    # from AFK, which in a VM reads as a code regression rather than a build one.
    $mediaExtension = Get-ChildItem -Path (Join-Path $repository "tracker\dist\time-tracker\_internal\winrt") `
        -Filter "_winrt_windows_media_control*.pyd" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $mediaExtension) {
        throw "Test build blocked: the packaged sidecar has no winrt media-control extension. The wrong python built it."
    }
    Write-Host "Packaged sidecar carries $($mediaExtension.Name)."
}

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "No installer at '$installer'. Build first, or correct the version."
}
$installer = (Resolve-Path -LiteralPath $installer).Path

# Checked on the artifact, not trusted from the override above. If the override
# ever stops working -- a renamed config key, a bundler change -- the signature
# is spent by the time we get here, and the only thing worse than spending it is
# spending it and not being told. A test build that came out signed is also not
# the thing it claims to be, so this fails rather than warns.
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne "NotSigned") {
    throw @"
Test build blocked: the installer came out Authenticode-signed (status $($signature.Status)).
This path is supposed to cost nothing, so the signCommand override is no longer
taking effect. A certificate operation has already been spent on it.
"@
}

$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
Write-Host ""
Write-Host "Test installer $Version built. Unsigned, as intended."
Write-Host "  Installer : $installer"
Write-Host "  SHA-256   : $hash"
Write-Host ""
Write-Host "Windows will warn about an unknown publisher. That is expected here and"
Write-Host "says nothing about how the signed release will behave -- SmartScreen's"
Write-Host "reputation check needs Mark-of-the-Web, which a VM drag-and-drop does not"
Write-Host "apply. Verify the hash above in the VM before installing."
