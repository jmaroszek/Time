<#
.SYNOPSIS
    Proves every executable a user will run carries a valid, timestamped
    Authenticode signature.

.DESCRIPTION
    The gate covers the three files that actually reach a machine: the NSIS
    installer, `Time.exe`, and the tracker sidecar as Tauri stages it for
    bundling.

    That last one is easy to get wrong. `build_tracker.py` writes the sidecar to
    `src-tauri/binaries/time-tracker-<target-triple>.exe`, but Tauri copies it to
    `target/release/time-tracker.exe` — dropping the target triple — and bundles
    that copy. Checking only the file under `binaries/` therefore says nothing
    about what ships; it describes an input to the build, not an output of it.
    The bundled copy is the required one here, and the staging copy is reported
    alongside it because a difference between the two is worth seeing.
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$Installer,
    [string]$AppExecutable,
    # The sidecar as bundled: target/release/time-tracker.exe.
    [string]$TrackerExecutable,
    # The sidecar as built, before Tauri copies it. Reported, not required.
    [string]$StagedTrackerExecutable
)

$ErrorActionPreference = "Stop"
$artifact = (Resolve-Path -LiteralPath $Installer).Path
$releaseDir = Split-Path (Split-Path (Split-Path $artifact -Parent) -Parent) -Parent
$srcTauriDir = Split-Path (Split-Path $releaseDir -Parent) -Parent
if (-not $AppExecutable) { $AppExecutable = Join-Path $releaseDir "Time.exe" }
if (-not $TrackerExecutable) {
    $TrackerExecutable = Join-Path $releaseDir "time-tracker.exe"
}
if (-not $StagedTrackerExecutable) {
    $StagedTrackerExecutable = Join-Path $srcTauriDir "binaries\time-tracker-x86_64-pc-windows-msvc.exe"
}

function Get-SignatureFacts {
    param([string]$Path)

    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $signature = Get-AuthenticodeSignature -LiteralPath $resolved
    [pscustomobject]@{
        Artifact = $resolved
        Status = $signature.Status
        Publisher = $signature.SignerCertificate.Subject
        TimestampAuthority = $signature.TimeStamperCertificate.Subject
        HasTimestamp = [bool]$signature.TimeStamperCertificate
        SHA256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash
        SizeBytes = (Get-Item -LiteralPath $resolved).Length
    }
}

$required = @($artifact, $AppExecutable, $TrackerExecutable)
$results = foreach ($candidate in $required) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "Release blocked: expected artifact not found: '$candidate'."
    }
    $facts = Get-SignatureFacts -Path $candidate
    if ($facts.Status -ne "Valid") {
        throw "Release blocked: Authenticode status for '$($facts.Artifact)' is $($facts.Status)."
    }
    if (-not $facts.Publisher -or -not $facts.HasTimestamp) {
        throw "Release blocked: '$($facts.Artifact)' must have both a signer and a trusted timestamp."
    }
    $facts
}

$results | Format-List Artifact, Publisher, TimestampAuthority, SHA256, SizeBytes

# Informational. The staging copy is not shipped, so an unsigned one is not by
# itself a defect — but if it is signed and the bundled copy's hash differs,
# something rewrote the sidecar between build and bundle, and that is worth
# knowing before the artifact goes to a host.
if (Test-Path -LiteralPath $StagedTrackerExecutable -PathType Leaf) {
    $staged = Get-SignatureFacts -Path $StagedTrackerExecutable
    $bundled = $results | Where-Object { $_.Artifact -eq (Resolve-Path -LiteralPath $TrackerExecutable).Path }
    Write-Host "Staged sidecar (not shipped; for comparison only):"
    Write-Host "  Path   : $($staged.Artifact)"
    Write-Host "  Status : $($staged.Status)"
    Write-Host "  SHA256 : $($staged.SHA256)"
    if ($bundled -and $staged.SHA256 -ne $bundled.SHA256) {
        Write-Warning ("The staged and bundled sidecars differ. Expected if Tauri " +
            "signed the bundled copy itself; unexpected otherwise.")
    }
} else {
    Write-Host "Staged sidecar not present at '$StagedTrackerExecutable' (not required)."
}

Write-Host "Release signature gate passed."
