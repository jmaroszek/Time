<#
.SYNOPSIS
    Stores the two release secrets in a PowerShell SecretStore vault, once, so
    that no future release has to paste them.

.DESCRIPTION
    Every release used to begin by getting two secrets into the shell by hand.
    `Read-Host -AsSecureString` cannot be pasted into -- it bypasses PSReadLine
    and reads the raw console, so a bracketed paste arrives as a single character
    -- and the clipboard workaround that replaced it is a copy-switch-run dance
    repeated per secret, per release. Friction at the start of a release is
    friction that decides whether the release happens.

    This runs once. After it, `enter_release_shell.ps1` populates the whole
    environment with no prompting at all.

    Only the two genuinely secret values live here. The four Azure identifiers
    are useless on their own and stay as literals in `enter_release_shell.ps1`,
    and the updater key file stays at C:\Secrets\Time\private-key.txt -- vaulting
    its password while leaving the file on disk keeps the two halves apart, which
    is the arrangement that already works.

    The vault is a cache, not the system of record. Apple Passwords and Google
    Password Manager hold the durable copies; if they and this ever disagree, the
    password managers win.

.PARAMETER Typed
    Read secrets from a visible prompt instead of the clipboard. The clipboard is
    the default because it does not echo and pastes reliably.

.PARAMETER Only
    Rotate a single secret rather than all of them.
#>
[CmdletBinding()]
param(
    [switch]$Typed,
    [ValidateSet("AzureClientSecret", "UpdaterKeyPassword")]
    [string]$Only
)

$ErrorActionPreference = "Stop"

$VAULT = "TimeRelease"
$SECRETS = @(
    [ordered]@{
        Key   = "AzureClientSecret"
        Name  = "Time.AzureClientSecret"
        Where = "Apple Passwords. Only create a new one in the Azure portal if it has genuinely expired."
        Env   = "AZURE_CLIENT_SECRET"
    }
    [ordered]@{
        Key   = "UpdaterKeyPassword"
        Name  = "Time.UpdaterKeyPassword"
        Where = "Apple Passwords / Google Password Manager. This unlocks C:\Secrets\Time\private-key.txt."
        Env   = "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
    }
)

# --- modules -------------------------------------------------------------

foreach ($module in "Microsoft.PowerShell.SecretManagement", "Microsoft.PowerShell.SecretStore") {
    if (Get-Module -ListAvailable -Name $module) {
        Write-Host "$module already installed."
        continue
    }
    Write-Host "Installing $module for the current user ..."
    # PSGallery is Untrusted by default; -Force is what skips that prompt without
    # changing the machine's repository policy.
    Install-Module -Name $module -Scope CurrentUser -Force -Confirm:$false -Repository PSGallery
}
Import-Module Microsoft.PowerShell.SecretManagement
Import-Module Microsoft.PowerShell.SecretStore

# --- vault ---------------------------------------------------------------

if (-not (Get-SecretVault -Name $VAULT -ErrorAction SilentlyContinue)) {
    Write-Host "Registering vault '$VAULT' ..."
    Register-SecretVault -Name $VAULT -ModuleName Microsoft.PowerShell.SecretStore -DefaultVault
} else {
    Write-Host "Vault '$VAULT' already registered."
}

# Unattended retrieval. The owner has weighed this deliberately: the machine is
# BitLocker-encrypted and physically secure, and a release that stops to ask for
# a vault password has reintroduced the prompt this script exists to remove.
# SecretStore still encrypts at rest under the current user account, which is
# strictly better than the plaintext file this replaces.
Write-Host "Configuring the store for unattended access ..."
Set-SecretStoreConfiguration -Scope CurrentUser -Authentication None -Interaction None -Confirm:$false | Out-Null

# --- secrets -------------------------------------------------------------

function Read-SecretValue {
    param([string]$Label)

    if ($Typed) {
        # Plain Read-Host, deliberately. It echoes, but it pastes -- and its
        # response never reaches ConsoleHost_history.txt, which records command
        # lines only. -AsSecureString would hide the echo and break pasting, and
        # buys nothing here because the value ends up in a plain environment
        # variable either way.
        return (Read-Host "  Paste or type the $Label").Trim()
    }

    Write-Host "  Copy the $Label to your clipboard, then press Enter." -NoNewline
    [void](Read-Host)
    $value = (Get-Clipboard -Raw)
    if ($null -eq $value) { return "" }
    return $value.Trim()
}

$targets = if ($Only) { $SECRETS | Where-Object { $_.Key -eq $Only } } else { $SECRETS }

foreach ($secret in $targets) {
    Write-Host ""
    Write-Host "$($secret.Name)  ->  `$env:$($secret.Env)"
    Write-Host "  Where it lives: $($secret.Where)"

    $existing = Get-Secret -Name $secret.Name -Vault $VAULT -AsPlainText -ErrorAction SilentlyContinue
    if ($existing -and -not $Only) {
        Write-Host "  Already stored ($($existing.Length) chars). Leaving it alone."
        Write-Host "  To replace it: scripts\setup_release_secrets.ps1 -Only $($secret.Key)"
        continue
    }

    $value = Read-SecretValue -Label $secret.Key
    # .Trim() above is not cosmetic: password managers append a newline on copy,
    # and a trailing newline on AZURE_CLIENT_SECRET fails authentication with an
    # error that names nothing resembling its cause.
    if (-not $value) {
        throw "Nothing was read for $($secret.Name). Clipboard empty? Re-run, or use -Typed."
    }
    if ($value -match "\s") {
        Write-Warning "  The value contains whitespace. That is unusual for this secret -- check you copied the right field."
    }

    Set-Secret -Name $secret.Name -Secret $value -Vault $VAULT
    $readBack = Get-Secret -Name $secret.Name -Vault $VAULT -AsPlainText
    if ($readBack -ne $value) {
        throw "Stored $($secret.Name) but read back something different. Do not trust this vault."
    }
    Write-Host "  Stored and verified: $($readBack.Length) chars."
}

if (-not $Typed) {
    Set-Clipboard -Value " "
    Write-Host ""
    Write-Host "Clipboard cleared. Clipboard History keeps its own copy, so also clear"
    Write-Host "that: Win+V -> Clear all, or Settings > System > Clipboard."
}

Write-Host ""
Write-Host "Done. Every future release starts with:"
Write-Host "    . scripts\enter_release_shell.ps1"
