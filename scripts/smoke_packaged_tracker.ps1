param(
    [Parameter(Mandatory = $true)]
    [string]$TrackerExecutable,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"

if ($env:GITHUB_ACTIONS -ne "true") {
    throw "Packaged tracker smoke is restricted to an isolated GitHub Actions runner."
}
if (-not $env:RUNNER_TEMP) {
    throw "RUNNER_TEMP is required for packaged tracker isolation."
}

$tracker = (Resolve-Path -LiteralPath $TrackerExecutable).Path
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (-not ($output + '\').StartsWith($runnerTemp, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Packaged smoke output must stay inside RUNNER_TEMP."
}
if (Test-Path -LiteralPath $output) {
    throw "Packaged smoke output already exists; refusing to reuse uncertain state."
}

$localAppData = Join-Path $output "LOCALAPPDATA"
$database = Join-Path $localAppData "Time\time_log.db"
$results = Join-Path $output "results"
New-Item -ItemType Directory -Path $localAppData, $results | Out-Null

$resolvedExpected = [IO.Path]::GetFullPath($database)
if (-not ($resolvedExpected + '').StartsWith(
    ([IO.Path]::GetFullPath($localAppData).TrimEnd('\') + '\'),
    [StringComparison]::OrdinalIgnoreCase
)) {
    throw "Resolved tracker database escaped scratch LOCALAPPDATA."
}
Write-Host "SCRATCH_DATABASE_CONFIRMED: $resolvedExpected"

$previousLocalAppData = $env:LOCALAPPDATA
$previousMigrateOnly = $env:TIME_MIGRATE_ONLY
$previousLocation = Get-Location
try {
    $env:LOCALAPPDATA = $localAppData
    $env:TIME_MIGRATE_ONLY = "1"
    Set-Location -LiteralPath (Split-Path -Parent $tracker)
    & $tracker
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged migration/bootstrap exited with $LASTEXITCODE."
    }

    Remove-Item Env:\TIME_MIGRATE_ONLY -ErrorAction SilentlyContinue
    & $tracker
    if ($LASTEXITCODE -ne 0) {
        throw "Fresh no-consent startup exited with $LASTEXITCODE."
    }
} finally {
    Set-Location $previousLocation
    $env:LOCALAPPDATA = $previousLocalAppData
    if ($null -eq $previousMigrateOnly) {
        Remove-Item Env:\TIME_MIGRATE_ONLY -ErrorAction SilentlyContinue
    } else {
        $env:TIME_MIGRATE_ONLY = $previousMigrateOnly
    }
}

python (Join-Path $repository "scripts\verify_packaged_smoke.py") `
    $database --local-app-data $localAppData |
    Tee-Object -FilePath (Join-Path $results "packaged-smoke.json")
if ($LASTEXITCODE -ne 0) {
    throw "Packaged smoke database verification failed."
}
python (Join-Path $repository "scripts\check_db_anomalies.py") $database --json |
    Tee-Object -FilePath (Join-Path $results "anomaly-checks.json")
if ($LASTEXITCODE -ne 0) {
    throw "Packaged smoke anomaly checks failed."
}

Write-Host "PACKAGED_TRACKER_SMOKE_PASSED"
