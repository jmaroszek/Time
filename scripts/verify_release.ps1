param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$Installer,
    [string]$AppExecutable,
    [string]$TrackerExecutable
)

$ErrorActionPreference = "Stop"
$artifact = (Resolve-Path -LiteralPath $Installer).Path
$releaseDir = Split-Path (Split-Path (Split-Path $artifact -Parent) -Parent) -Parent
$srcTauriDir = Split-Path (Split-Path $releaseDir -Parent) -Parent
if (-not $AppExecutable) { $AppExecutable = Join-Path $releaseDir "Time.exe" }
if (-not $TrackerExecutable) {
    $TrackerExecutable = Join-Path $srcTauriDir "binaries\time-tracker-x86_64-pc-windows-msvc.exe"
}

$artifacts = @($artifact, $AppExecutable, $TrackerExecutable)
$results = foreach ($candidate in $artifacts) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "Release blocked: expected artifact not found: '$candidate'."
    }
    $resolved = (Resolve-Path -LiteralPath $candidate).Path
    $signature = Get-AuthenticodeSignature -LiteralPath $resolved
    if ($signature.Status -ne "Valid") {
        throw "Release blocked: Authenticode status for '$resolved' is $($signature.Status)."
    }
    if (-not $signature.SignerCertificate -or -not $signature.TimeStamperCertificate) {
        throw "Release blocked: '$resolved' must have both a signer and a trusted timestamp."
    }
    $hash = Get-FileHash -LiteralPath $resolved -Algorithm SHA256
    [pscustomobject]@{
        Artifact = $resolved
        Publisher = $signature.SignerCertificate.Subject
        TimestampAuthority = $signature.TimeStamperCertificate.Subject
        SHA256 = $hash.Hash
        SizeBytes = (Get-Item -LiteralPath $resolved).Length
    }
}

$results | Format-List

Write-Host "Release signature gate passed."
