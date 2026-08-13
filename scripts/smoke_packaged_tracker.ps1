param(
    [Parameter(Mandatory = $true)]
    [string]$TrackerExecutable,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"

# The sidecar is built windowed (`console=False`), so it lands in the Windows
# GUI subsystem. PowerShell's call operator does not block on those and leaves
# $LASTEXITCODE unset, which reads as a failure however the process ended.
# Start-Process is the only form that both waits and reports a real exit code.
function Invoke-PackagedTracker {
    param([Parameter(Mandatory = $true)][string]$Executable)

    $process = Start-Process -FilePath $Executable -Wait -PassThru -NoNewWindow
    return $process.ExitCode
}

function Assert-OutsideDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Forbidden,
        [Parameter(Mandatory = $true)][string]$Message
    )

    $boundary = [IO.Path]::GetFullPath($Forbidden).TrimEnd('\') + '\'
    if (($Path + '\').StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) {
        throw $Message
    }
}

$tracker = (Resolve-Path -LiteralPath $TrackerExecutable).Path
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)

# Isolation is what makes this safe to run, not the runner it runs on. Requiring
# GitHub Actions meant the script could never be rehearsed before it was merged,
# and two bugs reached main behind that guard. Assert the properties that
# actually protect the machine instead, so a release can rehearse it locally.
if ($env:RUNNER_TEMP) {
    $runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
    if (-not ($output + '\').StartsWith($runnerTemp, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Packaged smoke output must stay inside RUNNER_TEMP."
    }
} else {
    if (-not [IO.Path]::IsPathRooted($OutputDirectory)) {
        throw "Give the packaged smoke an absolute scratch directory."
    }
    if ($env:LOCALAPPDATA) {
        # The production data directory, not all of LOCALAPPDATA: %TEMP% sits
        # inside it, and that is where a scratch run naturally belongs.
        Assert-OutsideDirectory -Path $output -Forbidden (Join-Path $env:LOCALAPPDATA "Time") `
            -Message "Packaged smoke output must stay out of the real Time data directory."
    }
    Assert-OutsideDirectory -Path $output -Forbidden $repository `
        -Message "Packaged smoke output must stay out of the repository."
}
if (Test-Path -LiteralPath $output) {
    throw "Packaged smoke output already exists; refusing to reuse uncertain state."
}

$localAppData = Join-Path $output "LOCALAPPDATA"
$database = Join-Path $localAppData "Time\Data\database.db"
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
$previousMutexName = $env:TIME_MUTEX_NAME
$previousLocation = Get-Location
try {
    $env:LOCALAPPDATA = $localAppData
    # The owner's tracker holds the production mutex on a developer machine, and
    # a duplicate instance exits 0 without recording — the smoke would pass
    # having started nothing. Give this run its own name so the assertions mean
    # the same thing locally as they do on an empty runner.
    $env:TIME_MUTEX_NAME = "Global\TimeTrackerPackagedSmoke"
    $env:TIME_MIGRATE_ONLY = "1"
    Set-Location -LiteralPath (Split-Path -Parent $tracker)
    $migration = Invoke-PackagedTracker -Executable $tracker
    if ($migration -ne 0) {
        throw "Packaged migration/bootstrap exited with $migration."
    }

    Remove-Item Env:\TIME_MIGRATE_ONLY -ErrorAction SilentlyContinue
    $startup = Invoke-PackagedTracker -Executable $tracker
    if ($startup -ne 0) {
        throw "Fresh no-consent startup exited with $startup."
    }
} finally {
    Set-Location $previousLocation
    $env:LOCALAPPDATA = $previousLocalAppData
    if ($null -eq $previousMigrateOnly) {
        Remove-Item Env:\TIME_MIGRATE_ONLY -ErrorAction SilentlyContinue
    } else {
        $env:TIME_MIGRATE_ONLY = $previousMigrateOnly
    }
    if ($null -eq $previousMutexName) {
        Remove-Item Env:\TIME_MUTEX_NAME -ErrorAction SilentlyContinue
    } else {
        $env:TIME_MUTEX_NAME = $previousMutexName
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
