<#
.SYNOPSIS
    Authenticode-signs one Tauri release artifact and preserves verification
    evidence before Tauri can rewrite or restore its source path.

.DESCRIPTION
    Tauri signs the patched main executable, gives those bytes to NSIS, and
    restores the original unsigned target/release/Time.exe after bundling. A
    post-build check of that path therefore inspects the wrong bytes.

    publish_release.ps1 supplies a fresh evidence directory and build id. This
    wrapper checks the signature immediately, copies the signed main executable
    and tracker into that directory, and records the final installer's hash.
    verify_release.ps1 binds those records to the generated NSIS script and the
    finished installer.

    Tauri routes more than those three through this command. Unsigned resource
    executables and DLLs bundled with the app, the NSIS plugin DLLs it copies
    into the build, and the generated uninstaller all arrive here before the
    installer does. They are signed and validated to the same standard, but they
    are not shipping boundaries and leave no evidence record: they are reached
    only through an installer this gate already binds.
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$Artifact,
    [string]$ExpectedPublisherName = "Jonah Maroszek"
)

$ErrorActionPreference = "Stop"

# Anything Tauri hands over that is not a Portable Executable is outside the
# contract this wrapper was written against. Read the DOS stub's pointer to the
# PE header rather than trusting the extension, so the fallback branch cannot be
# talked into spending a signature on an arbitrary file.
function Test-PortableExecutable {
    param([string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        if ($stream.Length -lt 64) { return $false }
        $dosHeader = [byte[]]::new(64)
        if ($stream.Read($dosHeader, 0, 64) -ne 64) { return $false }
        if ($dosHeader[0] -ne 0x4D -or $dosHeader[1] -ne 0x5A) { return $false }  # "MZ"
        $peOffset = [System.BitConverter]::ToInt32($dosHeader, 0x3C)
        if ($peOffset -lt 64 -or $peOffset -gt ($stream.Length - 4)) { return $false }
        $stream.Position = $peOffset
        $peSignature = [byte[]]::new(4)
        if ($stream.Read($peSignature, 0, 4) -ne 4) { return $false }
        return $peSignature[0] -eq 0x50 -and $peSignature[1] -eq 0x45 -and
               $peSignature[2] -eq 0x00 -and $peSignature[3] -eq 0x00            # "PE\0\0"
    } finally {
        $stream.Dispose()
    }
}

$evidenceDirectory = $env:TIME_RELEASE_SIGNING_EVIDENCE_DIR
$buildId = $env:TIME_RELEASE_BUILD_ID
if (-not $evidenceDirectory -or -not $buildId) {
    throw @"
Release signing evidence is not configured. Run scripts/publish_release.ps1;
it creates a fresh build id and evidence directory before Tauri signs anything.
"@
}

$artifact = (Resolve-Path -LiteralPath $Artifact).Path
$leaf = Split-Path $artifact -Leaf
if ($leaf -eq "Time.exe") {
    $kind = "app"
    $evidenceLeaf = "Time.exe"
} elseif ($leaf -match '^time-tracker(?:-.+)?\.exe$') {
    $kind = "tracker"
    $evidenceLeaf = "time-tracker.exe"
} elseif ($leaf -match '^Time_.+_x64-setup\.exe$') {
    $kind = "installer"
    $evidenceLeaf = $null
} elseif (Test-PortableExecutable -Path $artifact) {
    # A bundled resource binary, a copied NSIS plugin DLL, or the generated
    # uninstaller. Signed and checked like the rest; no evidence copy, and no
    # "$kind.json" record — every one of these would collide on one filename,
    # and verify_release.ps1 must keep binding exactly three boundaries.
    $kind = "auxiliary"
    $evidenceLeaf = $null
} else {
    throw "Release signing blocked: '$artifact' is not a Portable Executable. Update the evidence contract before signing a new artifact type."
}

if (-not (Get-Command artifact-signing-cli -ErrorAction SilentlyContinue)) {
    throw "Release signing blocked: artifact-signing-cli is not available in this shell."
}

& artifact-signing-cli -e "https://eus.codesigning.azure.net" -d "Time" $artifact
if ($LASTEXITCODE -ne 0) {
    throw "Release signing blocked: artifact-signing-cli failed for '$artifact'."
}

$signature = Get-AuthenticodeSignature -LiteralPath $artifact
if ($signature.Status -ne "Valid") {
    throw "Release signing blocked: Authenticode status for '$artifact' is $($signature.Status)."
}
if (-not $signature.SignerCertificate -or -not $signature.TimeStamperCertificate) {
    throw "Release signing blocked: '$artifact' must have both a signer and a trusted timestamp."
}
$publisherName = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
)
if ($publisherName -ne $ExpectedPublisherName) {
    throw "Release signing blocked: '$artifact' was signed by '$publisherName'; expected '$ExpectedPublisherName'."
}

New-Item -ItemType Directory -Force -Path $evidenceDirectory | Out-Null
$evidenceDirectory = (Resolve-Path -LiteralPath $evidenceDirectory).Path
$sourceHash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
$sourceSize = (Get-Item -LiteralPath $artifact).Length

$evidencePath = $null
if ($evidenceLeaf) {
    $evidencePath = Join-Path $evidenceDirectory $evidenceLeaf
    Copy-Item -LiteralPath $artifact -Destination $evidencePath -Force
    $evidencePath = (Resolve-Path -LiteralPath $evidencePath).Path
    $evidenceHash = (Get-FileHash -LiteralPath $evidencePath -Algorithm SHA256).Hash
    if ($evidenceHash -ne $sourceHash) {
        throw "Release signing blocked: the $kind evidence copy differs from the signed source."
    }
}

$record = [ordered]@{
    schemaVersion      = 1
    buildId            = $buildId
    kind               = $kind
    sourcePath         = $artifact
    evidenceFile       = $evidenceLeaf
    sha256             = $sourceHash
    sizeBytes          = $sourceSize
    publisher          = $signature.SignerCertificate.Subject
    publisherName      = $publisherName
    timestampAuthority = $signature.TimeStamperCertificate.Subject
    capturedAtUtc      = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}

if ($kind -eq "auxiliary") {
    # Appended, never overwritten, and deliberately not "auxiliary.json": the
    # verifier reads records as "<kind>.json", so a name it cannot form is a
    # structural guarantee that a helper file can never stand in for a boundary.
    # This log is an audit trail of what a release spent signatures on, nothing
    # the gate depends on.
    $auxiliaryLogPath = Join-Path $evidenceDirectory "auxiliary.jsonl"
    $record | ConvertTo-Json -Depth 3 -Compress |
        Add-Content -LiteralPath $auxiliaryLogPath -Encoding utf8
    Write-Host "Signed bundle helper '$leaf' for build $buildId (not a shipping boundary)."
} else {
    $recordPath = Join-Path $evidenceDirectory "$kind.json"
    $record | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $recordPath -Encoding utf8
    Write-Host "Recorded signed $kind evidence for build $buildId."
}
