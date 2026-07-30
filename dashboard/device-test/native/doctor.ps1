$ErrorActionPreference = "Stop"

if (-not [Environment]::UserInteractive) {
    throw "Native WebView2 automation requires an interactive Windows desktop."
}

$dashboard = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$repository = (Resolve-Path (Join-Path $dashboard "..")).Path
$binary = Join-Path $dashboard "src-tauri\target\debug\Time.exe"
$database = if ($env:TIME_DB_PATH) {
    [IO.Path]::GetFullPath($env:TIME_DB_PATH)
} else {
    Join-Path $repository "data\device-compat.db"
}
$deviceConfig = Join-Path $dashboard "src-tauri\device-test.conf.json"
$stateDirectory = Join-Path $env:APPDATA "io.github.jmaroszek.time.device-compat"

if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw "Isolated debug binary is missing. Run npm run build:native-device first."
}

$config = Get-Content -Raw -LiteralPath $deviceConfig | ConvertFrom-Json
if ($config.identifier -ne "io.github.jmaroszek.time.device-compat") {
    throw "Native suite requires the isolated device-compat application identifier."
}
$binaryText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($binary))
if (-not $binaryText.Contains($config.identifier)) {
    throw "Debug binary was not compiled with the isolated device-compat identifier."
}

$resolvedBinary = [IO.Path]::GetFullPath($binary)
$existing = @(
    Get-Process -Name "Time" -ErrorAction SilentlyContinue |
        Where-Object {
            try { [IO.Path]::GetFullPath($_.Path) -eq $resolvedBinary }
            catch { $false }
        }
)
if ($existing.Count -ne 0) {
    throw "The isolated debug Time process is already running. Close it before testing."
}

$webViewRoots = @(
    "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application",
    "$env:ProgramFiles\Microsoft\EdgeWebView\Application",
    "$env:LOCALAPPDATA\Microsoft\EdgeWebView\Application"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
$webViewCandidates = @($webViewRoots | ForEach-Object {
    Get-ChildItem -LiteralPath $_ -Filter msedgewebview2.exe `
        -Recurse -ErrorAction SilentlyContinue
})
if ($webViewCandidates.Count -eq 0) {
    throw "Microsoft Edge WebView2 Runtime was not found."
}

$tauriService = Join-Path $dashboard "node_modules\@wdio\tauri-service"
if (-not (Test-Path -LiteralPath $tauriService -PathType Container)) {
    throw "WebView2 driver service is missing. Run npm ci before native testing."
}

& python (Join-Path $PSScriptRoot "doctor.py") $database
if ($LASTEXITCODE -ne 0) {
    throw "Scratch database validation failed."
}

# Only the test identifier's state is reset. The production Time window state
# and any running production process are deliberately outside this path.
$stateFile = Join-Path $stateDirectory ".window-state.json"
if (Test-Path -LiteralPath $stateFile -PathType Leaf) {
    Remove-Item -LiteralPath $stateFile -Force
}

Write-Host "ENVIRONMENT_READY: isolated native test prerequisites passed."
