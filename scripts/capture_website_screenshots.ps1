<#
.SYNOPSIS
    Captures the complete website screenshot set from the debug Time dashboard.

.DESCRIPTION
    Runs the Playwright capture workflow once per requested theme and writes
    each set to its own directory. The debug dashboard must already be running,
    maximized, against an explicit demo database, with WebView2 remote debugging
    enabled. This script attaches to that dashboard; it never opens Time's live
    database.

    From the repository root, launch the isolated dashboard first:

        $env:TIME_DB_PATH = "$PWD\data\demo.db"
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
        Push-Location dashboard
        npm run tauri dev

    Then run this script from another terminal:

        scripts\capture_website_screenshots.ps1 -Theme Both
#>
param(
    [ValidateSet("Dark", "Light", "Both")]
    [string]$Theme = "Dark",

    # Each theme is written to a dark/ or light/ child directory here.
    [string]$OutputDirectory,

    [string]$CdpUrl = "http://127.0.0.1:9222",

    # Defaults to the approved Chrome listing image in the sibling extension repo.
    [string]$ExtensionImage
)

$ErrorActionPreference = "Stop"

$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$dashboard = Join-Path $repository "dashboard"
$captureScript = Join-Path $dashboard "scripts\capture_screenshots.mjs"
$outputRoot = if ($OutputDirectory) {
    [IO.Path]::GetFullPath($OutputDirectory)
} else {
    Join-Path $repository "data\website-screenshots"
}

if (-not (Test-Path -LiteralPath $captureScript -PathType Leaf)) {
    throw "Capture implementation not found: $captureScript"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required to capture website screenshots."
}

$themes = if ($Theme -eq "Both") { @("dark", "light") } else { @($Theme.ToLowerInvariant()) }
$generatedAssets = @(
    "insights-hero-week.png",
    "insights-timeline-week-tooltip.png",
    "insights-calendar-quarter-tooltip.png",
    "insights-rhythm-quarter-tooltip.png",
    "insights-top-apps-week.png",
    "insights-top-websites-week.png",
    "insights-weekly-hours-quarter.png",
    "insights-weekly-hours-quarter-categories.png",
    "activity-apps-websites-week.png",
    "activity-categories-rules-work-expanded.png"
)

# The extension listing image is an approved static source, not an app state.
# Preserve it in every themed handoff alongside the generated captures.
$extensionName = "extension-title-marker-1280x800.png"
$extensionSource = if ($ExtensionImage) {
    (Resolve-Path -LiteralPath $ExtensionImage).Path
} else {
    [IO.Path]::GetFullPath((Join-Path $repository "..\Extension\images\store-screenshot-1-title-marker-1280x800.png"))
}
if (-not (Test-Path -LiteralPath $extensionSource -PathType Leaf)) {
    throw "Approved extension screenshot not found: $extensionSource"
}
$expectedAssets = @($generatedAssets + $extensionName)

$previousOutput = $env:TIME_SCREENSHOT_OUT
$previousCdpUrl = $env:TIME_SCREENSHOT_CDP_URL
$previousLocation = Get-Location
try {
    $env:TIME_SCREENSHOT_CDP_URL = $CdpUrl
    Set-Location -LiteralPath $dashboard

    foreach ($captureTheme in $themes) {
        $themeOutput = Join-Path $outputRoot $captureTheme
        $env:TIME_SCREENSHOT_OUT = $themeOutput
        Write-Host "Capturing the complete $captureTheme screenshot set to $themeOutput ..."

        & node $captureScript --theme $captureTheme
        if ($LASTEXITCODE -ne 0) {
            throw "The $captureTheme screenshot capture exited with code $LASTEXITCODE."
        }

        Copy-Item -LiteralPath $extensionSource -Destination (Join-Path $themeOutput $extensionName) -Force

        $missing = @($expectedAssets | Where-Object {
            -not (Test-Path -LiteralPath (Join-Path $themeOutput $_) -PathType Leaf)
        })
        if ($missing.Count -gt 0) {
            throw "The $captureTheme set is incomplete. Missing: $($missing -join ', ')"
        }

        # Remove directories created by the older three-tier handoff only after
        # the complete flat replacement set has been verified.
        foreach ($legacyName in "masters", "web", "design-crops") {
            $legacyDirectory = Join-Path $themeOutput $legacyName
            if (Test-Path -LiteralPath $legacyDirectory -PathType Container) {
                $resolvedLegacy = (Resolve-Path -LiteralPath $legacyDirectory).Path
                $themeBoundary = [IO.Path]::GetFullPath($themeOutput).TrimEnd('\') + '\'
                if (-not ($resolvedLegacy + '\').StartsWith($themeBoundary, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Refusing to remove a legacy capture directory outside $themeOutput."
                }
                Remove-Item -LiteralPath $resolvedLegacy -Recurse -Force
            }
        }

        Write-Host "Verified $($expectedAssets.Count) $captureTheme assets."
    }
} finally {
    Set-Location $previousLocation
    if ($null -eq $previousOutput) {
        Remove-Item Env:\TIME_SCREENSHOT_OUT -ErrorAction SilentlyContinue
    } else {
        $env:TIME_SCREENSHOT_OUT = $previousOutput
    }
    if ($null -eq $previousCdpUrl) {
        Remove-Item Env:\TIME_SCREENSHOT_CDP_URL -ErrorAction SilentlyContinue
    } else {
        $env:TIME_SCREENSHOT_CDP_URL = $previousCdpUrl
    }
}

Write-Host "Website screenshot sets are ready in $outputRoot."
