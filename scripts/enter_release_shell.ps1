<#
.SYNOPSIS
    Populates the six environment variables a release build needs, with no
    prompting.

.DESCRIPTION
    Dot-source this. Environment variables set by a child process die with it:

        . scripts\enter_release_shell.ps1

    Four of the six are non-secret identifiers and are literals below -- they are
    useless without the client secret, and hunting for them was itself part of
    the friction. The updater private key is read from its file. The two real
    secrets come from the SecretStore vault created once by
    setup_release_secrets.ps1.

    Nothing is echoed. The check at the end reports character counts, which is
    enough to catch the failure that actually happens -- a truncated or
    single-character paste -- without putting a secret on screen or in a
    transcript.

    These variables are process-scoped on purpose. They die with the window,
    which is why the build has to run from the same one. Never promote them with
    [Environment]::SetEnvironmentVariable(..., 'User'): that writes the secret to
    the registry in plaintext and leaves it there.
#>
[CmdletBinding()]
param(
    [string]$KeyFile = "C:\Secrets\Time\private-key.txt",
    [string]$Vault = "TimeRelease"
)

$ErrorActionPreference = "Stop"

# Non-secret identifiers. Recorded here so a release is runnable without hunting
# through docs/personal; each is meaningless without the client secret.
$env:AZURE_TENANT_ID = "794e903a-b823-4f2e-b39e-d5af35d26c62"
$env:AZURE_CLIENT_ID = "13dfedc3-5bc4-4ec3-9486-121d21399dec"
$env:AZURE_ARTIFACT_SIGNING_ACCOUNT = "time-signing"
$env:AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE = "time-public-trust"

# The updater key. Tauri also honours TAURI_SIGNING_PRIVATE_KEY_PATH, but
# publish_release.ps1 tests the contents variable and refuses to start without
# it -- a correct key supplied the other way blocks the release.
if (-not (Test-Path -LiteralPath $KeyFile -PathType Leaf)) {
    throw @"
Updater private key not found at '$KeyFile'.
The durable copies are in Apple Passwords and Google Password Manager.
Losing this key means no installed copy of Time can ever be updated again.
"@
}
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -LiteralPath $KeyFile -Raw).Trim()

# The two secrets.
if (-not (Get-Module -ListAvailable -Name Microsoft.PowerShell.SecretManagement)) {
    throw "SecretManagement is not installed. Run scripts\setup_release_secrets.ps1 once."
}
Import-Module Microsoft.PowerShell.SecretManagement -ErrorAction Stop
if (-not (Get-SecretVault -Name $Vault -ErrorAction SilentlyContinue)) {
    throw "Vault '$Vault' is not registered. Run scripts\setup_release_secrets.ps1 once."
}

function Get-RequiredSecret {
    param([string]$Name)

    $value = Get-Secret -Name $Name -Vault $Vault -AsPlainText -ErrorAction SilentlyContinue
    if (-not $value) {
        throw "Secret '$Name' is missing from vault '$Vault'. Run scripts\setup_release_secrets.ps1."
    }
    $value
}

$env:AZURE_CLIENT_SECRET = Get-RequiredSecret -Name "Time.AzureClientSecret"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Get-RequiredSecret -Name "Time.UpdaterKeyPassword"

# Report lengths, never values. A 0 means missing; a 1 means something pasted
# badly, which is the failure this whole path exists to eliminate.
$checks = [ordered]@{
    "AZURE_TENANT_ID"                            = $env:AZURE_TENANT_ID
    "AZURE_CLIENT_ID"                            = $env:AZURE_CLIENT_ID
    "AZURE_CLIENT_SECRET"                        = $env:AZURE_CLIENT_SECRET
    "AZURE_ARTIFACT_SIGNING_ACCOUNT"             = $env:AZURE_ARTIFACT_SIGNING_ACCOUNT
    "AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE" = $env:AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE
    "TAURI_SIGNING_PRIVATE_KEY"                  = $env:TAURI_SIGNING_PRIVATE_KEY
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"         = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
}

$bad = @()
foreach ($name in $checks.Keys) {
    $value = $checks[$name]
    $length = if ($value) { $value.Length } else { 0 }
    if ($length -lt 2) { $bad += $name }
    Write-Host ("  {0,-44} {1,4} chars" -f $name, $length)
}
if ($bad.Count) {
    throw "These are empty or implausibly short: $($bad -join ', ')."
}

Write-Host ""
Write-Host "Release shell ready. Next: scripts\release.ps1"
