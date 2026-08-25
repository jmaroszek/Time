<#
.SYNOPSIS
    Proves every executable a user will run carries a valid, timestamped
    Authenticode signature.

.DESCRIPTION
    The gate covers the final NSIS installer and the signed app and tracker
    bytes Tauri gave to NSIS. Tauri deliberately restores the unsigned,
    unpatched target/release/Time.exe after bundling, so that post-build path is
    not evidence of what the installer contains.

    sign_release_artifact.ps1 captures the transient signed app and the signed
    tracker while Tauri is bundling. This verifier requires all three evidence
    records to share one build id, checks their hashes and signatures, and
    proves the generated NSIS script used the recorded app and tracker sources.
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$Installer,
    [string]$EvidenceDirectory,
    [string]$NsisScript,
    [string]$ExpectedBuildId,
    [string]$ExpectedPublisherName = "Jonah Maroszek"
)

$ErrorActionPreference = "Stop"
$artifact = (Resolve-Path -LiteralPath $Installer).Path
$releaseDir = Split-Path (Split-Path (Split-Path $artifact -Parent) -Parent) -Parent
if (-not $EvidenceDirectory) {
    $EvidenceDirectory = Join-Path $releaseDir "signing-evidence"
}
if (-not $NsisScript) {
    $NsisScript = Join-Path $releaseDir "nsis\x64\installer.nsi"
}

function Get-NormalizedPath {
    param([string]$Path)
    [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Assert-SamePath {
    param(
        [string]$Actual,
        [string]$Expected,
        [string]$Description
    )
    $actualPath = Get-NormalizedPath -Path $Actual
    $expectedPath = Get-NormalizedPath -Path $Expected
    if (-not $actualPath.Equals($expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release blocked: $Description is '$actualPath'; expected '$expectedPath'."
    }
}

function Read-EvidenceRecord {
    param([string]$Kind)

    $path = Join-Path $EvidenceDirectory "$Kind.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Release blocked: missing $Kind signing record at '$path'. Build through publish_release.ps1."
    }
    try {
        $record = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    } catch {
        throw "Release blocked: could not read $Kind signing record '$path': $($_.Exception.Message)"
    }
    if ($record.schemaVersion -ne 1 -or $record.kind -ne $Kind -or
        -not $record.buildId -or -not $record.sourcePath -or
        -not $record.sha256 -or $null -eq $record.sizeBytes -or
        -not $record.publisher -or -not $record.publisherName -or
        -not $record.timestampAuthority) {
        throw "Release blocked: $Kind signing record '$path' is incomplete or unsupported."
    }
    $record
}

function Get-SignatureFacts {
    param(
        [string]$Path,
        [string]$Role
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Release blocked: expected $Role not found: '$Path'."
    }
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $signature = Get-AuthenticodeSignature -LiteralPath $resolved
    if ($signature.Status -ne "Valid") {
        throw "Release blocked: Authenticode status for '$resolved' is $($signature.Status)."
    }
    if (-not $signature.SignerCertificate -or -not $signature.TimeStamperCertificate) {
        throw "Release blocked: '$resolved' must have both a signer and a trusted timestamp."
    }
    $facts = [pscustomobject]@{
        Role = $Role
        Artifact = $resolved
        Status = $signature.Status
        Publisher = $signature.SignerCertificate.Subject
        PublisherName = $signature.SignerCertificate.GetNameInfo(
            [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
            $false
        )
        TimestampAuthority = $signature.TimeStamperCertificate.Subject
        HasTimestamp = [bool]$signature.TimeStamperCertificate
        SHA256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash
        SizeBytes = (Get-Item -LiteralPath $resolved).Length
    }
    $facts
}

function Assert-RecordMatchesFile {
    param(
        $Record,
        $Facts,
        [string]$Description
    )
    if ($Record.sha256 -ne $Facts.SHA256 -or
        [int64]$Record.sizeBytes -ne $Facts.SizeBytes -or
        $Record.publisher -ne $Facts.Publisher -or
        $Record.publisherName -ne $Facts.PublisherName -or
        $Record.timestampAuthority -ne $Facts.TimestampAuthority) {
        throw "Release blocked: $Description does not match its signing record."
    }
}

$appRecord = Read-EvidenceRecord -Kind "app"
$trackerRecord = Read-EvidenceRecord -Kind "tracker"
$installerRecord = Read-EvidenceRecord -Kind "installer"
$buildIds = @(
    @($appRecord.buildId, $trackerRecord.buildId, $installerRecord.buildId) |
        Select-Object -Unique
)
if ($buildIds.Count -ne 1) {
    throw "Release blocked: signing records came from different builds: $($buildIds -join ', ')."
}
$buildId = [string]$buildIds[0]
if ($ExpectedBuildId -and $buildId -ne $ExpectedBuildId) {
    throw "Release blocked: signing evidence build id is '$buildId'; expected '$ExpectedBuildId'."
}

if (-not (Test-Path -LiteralPath $EvidenceDirectory -PathType Container)) {
    throw "Release blocked: signing evidence directory not found: '$EvidenceDirectory'."
}
$appEvidence = Join-Path $EvidenceDirectory "Time.exe"
$trackerEvidence = Join-Path $EvidenceDirectory "time-tracker.exe"
if ($appRecord.evidenceFile -ne "Time.exe" -or $trackerRecord.evidenceFile -ne "time-tracker.exe") {
    throw "Release blocked: app or tracker signing record names an unexpected evidence file."
}

$installerFacts = Get-SignatureFacts -Path $artifact -Role "NSIS installer"
$appFacts = Get-SignatureFacts -Path $appEvidence -Role "Packaged Time.exe evidence"
$trackerFacts = Get-SignatureFacts -Path $trackerEvidence -Role "Packaged tracker evidence"
Assert-RecordMatchesFile -Record $installerRecord -Facts $installerFacts -Description "installer"
Assert-RecordMatchesFile -Record $appRecord -Facts $appFacts -Description "app evidence"
Assert-RecordMatchesFile -Record $trackerRecord -Facts $trackerFacts -Description "tracker evidence"
Assert-SamePath -Actual $installerRecord.sourcePath -Expected $artifact -Description "installer record source"

$publishers = @(
    @($installerFacts.Publisher, $appFacts.Publisher, $trackerFacts.Publisher) |
        Select-Object -Unique
)
if ($publishers.Count -ne 1) {
    throw "Release blocked: installer, app, and tracker were signed by different publishers."
}
foreach ($facts in @($installerFacts, $appFacts, $trackerFacts)) {
    if ($facts.PublisherName -ne $ExpectedPublisherName) {
        throw "Release blocked: $($facts.Role) was signed by '$($facts.PublisherName)'; expected '$ExpectedPublisherName'."
    }
}

if (-not (Test-Path -LiteralPath $NsisScript -PathType Leaf)) {
    throw "Release blocked: generated NSIS script not found: '$NsisScript'."
}
$nsisText = Get-Content -LiteralPath $NsisScript -Raw
$mainMatch = [regex]::Match(
    $nsisText,
    '(?m)^!define\s+MAINBINARYSRCPATH\s+"(?<path>[^"]+)"\s*$'
)
$trackerMatch = [regex]::Match(
    $nsisText,
    '(?m)^\s*File\b[^\r\n]*"/oname=time-tracker\.exe"\s+"(?<path>[^"]+)"\s*$'
)
if (-not $mainMatch.Success -or -not $trackerMatch.Success) {
    throw "Release blocked: generated NSIS script does not identify both packaged executable sources."
}
Assert-SamePath -Actual $appRecord.sourcePath -Expected $mainMatch.Groups['path'].Value -Description "packaged app source"
Assert-SamePath -Actual $trackerRecord.sourcePath -Expected $trackerMatch.Groups['path'].Value -Description "packaged tracker source"

# Unlike the main executable, Tauri does not restore the tracker source after
# bundling. Its current bytes must still match the evidence captured when it was
# signed and named in the NSIS script.
if (-not (Test-Path -LiteralPath $trackerRecord.sourcePath -PathType Leaf)) {
    throw "Release blocked: tracker source named by NSIS no longer exists: '$($trackerRecord.sourcePath)'."
}
$trackerSourceHash = (Get-FileHash -LiteralPath $trackerRecord.sourcePath -Algorithm SHA256).Hash
if ($trackerSourceHash -ne $trackerFacts.SHA256) {
    throw "Release blocked: tracker source changed after its signing evidence was captured."
}

@($installerFacts, $appFacts, $trackerFacts) |
    Format-List Role, Artifact, Publisher, TimestampAuthority, SHA256, SizeBytes

if (Test-Path -LiteralPath $appRecord.sourcePath -PathType Leaf) {
    $postBuildStatus = (Get-AuthenticodeSignature -LiteralPath $appRecord.sourcePath).Status
    Write-Host "Post-build target/release/Time.exe (not a shipping gate): $postBuildStatus"
}
Write-Host "Release signature gate passed for build $buildId."
