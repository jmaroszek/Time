<#
.SYNOPSIS
    Builds and verifies a Time release from one command, detached from the
    terminal that launched it.

.DESCRIPTION
    Three problems this exists to solve, all met while shipping 1.1.0.

    A build run in the interactive terminal shares that terminal's console, and
    every process attached to a console receives its Ctrl+C. Twice, a Ctrl+C
    nobody typed killed a release build partway through PyInstaller. The cause is
    still unknown. This does not fix it -- it makes it irrelevant, by launching
    the build with its own console. A control event in the launching terminal
    cannot reach a process that is not attached to it.

    The same isolation protects the terminal in the other direction. Both aborts
    left the console unusable -- dead backspace, dead shortcuts -- and forced a
    new window mid-release. A build that owns its console can wreck only its own.

    And a working build printed thousands of lines. Everything still goes to a
    log; this prints the dozen lines that describe progress.

    Deliberately stops after verification. Tagging and publishing are
    irreversible and stay deliberate manual acts: this prints the exact commands
    rather than running them.

.PARAMETER DownloadBaseUrl
    Base address the INSTALLER will be downloaded from. Signed into the manifest,
    so a wrong value cannot be corrected without re-signing.

.PARAMETER Notes
    Release note recorded in the manifest. Not shown anywhere in the app -- see
    the comment on publish_release.ps1's -Notes -- but latest.json is served
    publicly, so it is the machine-readable record of what a version contained.

.PARAMETER SkipPreflight
    Skip the updater key check. Only for a re-run in a session where it already
    passed; it costs nothing and guards an unrecoverable mistake.

.EXAMPLE
    pwsh -File scripts\release.ps1 -DownloadBaseUrl "https://trackwithtime.com/downloads" -Notes "..."
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DownloadBaseUrl,
    [string]$Notes,
    [switch]$SkipPreflight
)

$ErrorActionPreference = "Stop"

$EXPECTED_KEY_ID = "55df2f6d0a30a543"
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$started = Get-Date

function Say {
    param([string]$Text, [string]$Colour = "Gray")
    Write-Host ("  [{0:mm\:ss}] " -f ((Get-Date) - $started)) -NoNewline -ForegroundColor DarkGray
    Write-Host $Text -ForegroundColor $Colour
}

# The log is being written by another process, so it has to be opened with
# ReadWrite sharing; the default would fail with a lock error.
function Read-LogText {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    try {
        $stream = [System.IO.File]::Open($Path, "Open", "Read", "ReadWrite")
        try {
            $reader = New-Object System.IO.StreamReader($stream)
            try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
        } finally { $stream.Dispose() }
    } catch {
        return ""
    }
}

function Read-LogLines {
    param([string]$Path)
    return ((Read-LogText -Path $Path) -split "`r?`n")
}

# --- 1. environment ------------------------------------------------------

# Populated here rather than requiring a dot-source, which keeps this to one
# command: the build is spawned as a child and inherits what we set.
if (-not $env:AZURE_CLIENT_SECRET -or -not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Say "Loading release secrets ..." "White"
    . (Join-Path $PSScriptRoot "enter_release_shell.ps1")
} else {
    Say "Release environment already loaded." "White"
}

# --- 2. key preflight ----------------------------------------------------

# Ten seconds, no cloud signature, and it answers the one question that cannot
# be recovered from afterwards. A manifest signed by the wrong key is rejected by
# every installed copy of Time, permanently.
if (-not $SkipPreflight) {
    Say "Proving the updater key ..." "White"
    $probe = Join-Path $env:TEMP "time-keycheck.txt"
    "preflight" | Set-Content -LiteralPath $probe -Encoding utf8
    try {
        Push-Location (Join-Path $repository "dashboard")
        try {
            npm run tauri -- signer sign $probe 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Release blocked: the updater signer failed. Wrong key password?" }
        } finally { Pop-Location }

        $report = (& node (Join-Path $PSScriptRoot "verify_update_signature.mjs") $probe --signature "$probe.sig" 2>&1) -join "`n"
        $keyId = ([regex]::Match($report, 'Key id\s*:\s*([0-9a-f]+)')).Groups[1].Value
        if ($keyId -ne $EXPECTED_KEY_ID) {
            throw @"
Release blocked: the updater key in this shell is '$keyId'; expected '$EXPECTED_KEY_ID'.
This is the wrong key. Publishing a manifest signed by it means every installed
copy of Time rejects the update, and no later fix reaches them.
"@
        }
        Say "Updater key is $keyId." "Green"
    } finally {
        Remove-Item -LiteralPath $probe, "$probe.sig" -ErrorAction SilentlyContinue
    }
}

# --- 3. the build, in its own console ------------------------------------

$logDir = Join-Path $repository "dashboard\src-tauri\target\release\build-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$log = Join-Path $logDir "release-$stamp.log"
$errLog = Join-Path $logDir "release-$stamp.err.log"

$publishArgs = @(
    "-NoProfile", "-NoLogo", "-NonInteractive",
    "-File", (Join-Path $PSScriptRoot "publish_release.ps1"),
    "-DownloadBaseUrl", $DownloadBaseUrl
)
if ($Notes) { $publishArgs += @("-Notes", $Notes) }

Say "Building. Full log: $log" "White"
Write-Host ""

# -WindowStyle Hidden is what buys the isolation, and it was verified rather than
# assumed: a child started this way does not appear in this process's
# GetConsoleProcessList, and a console control event reaches only processes
# attached to that console. -NoNewWindow would share ours and defeat the point.
# -NoProfile keeps the interactive profile -- starship, zoxide, the conda hook --
# out of the build entirely.
$build = Start-Process pwsh -ArgumentList $publishArgs -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError $errLog

# --- 4. compact progress -------------------------------------------------

$milestones = @(
    @{ Match = "Checking version parity";            Text = "version parity" }
    @{ Match = "vite v";                             Text = "frontend bundle" }
    @{ Match = "Built application at";               Text = "rust application" }
    @{ Match = "build:tracker";                      Text = "tracker sidecar" }
    @{ Match = "Recorded signed app evidence";       Text = "signed the app" }
    @{ Match = "Recorded signed tracker evidence";   Text = "signed the tracker" }
    @{ Match = "Recorded signed installer evidence"; Text = "signed the installer" }
    @{ Match = "Release signature gate passed";      Text = "signature gate passed"; Colour = "Green" }
    @{ Match = "Regenerating the update signature";  Text = "regenerating update signature" }
    @{ Match = "Update signature verified";          Text = "manifest verifies as a client would"; Colour = "Green" }
)

$seen = @{}
$consumed = 0
$helpers = 0
$helpersAnnounced = $false

function Show-NewProgress {
    param([switch]$Final)

    $text = Read-LogText -Path $log
    if ($text.Length -le $script:consumed) { return }
    $chunk = $text.Substring($script:consumed)

    # Stop at the last newline. A log being written by another process almost
    # always ends mid-line, and consuming that fragment would mark a milestone
    # seen while its text is still half-arrived -- the completed line then never
    # gets examined and the milestone silently never prints. Once the build has
    # exited there is nothing still being written, so -Final takes the remainder.
    if (-not $Final) {
        $cut = $chunk.LastIndexOf("`n")
        if ($cut -lt 0) { return }
        $chunk = $chunk.Substring(0, $cut)
        $script:consumed += $cut + 1
    } else {
        $script:consumed = $text.Length
    }

    foreach ($line in ($chunk -split "`r?`n")) {
        if (-not $line) { continue }

        # Collapsed rather than printed: a release signs a dozen-plus bundle
        # helpers, and one line each would be most of the output this script is
        # trying to remove.
        if ($line -match "Signed bundle helper") { $script:helpers++; continue }

        foreach ($m in $milestones) {
            if ($seen.ContainsKey($m.Match)) { continue }
            if ($line -notmatch [regex]::Escape($m.Match)) { continue }

            if ($script:helpers -gt 0 -and -not $script:helpersAnnounced) {
                Say "signed $($script:helpers) bundle helpers"
                $script:helpersAnnounced = $true
            }
            $colour = if ($m.Colour) { $m.Colour } else { "Gray" }
            Say $m.Text $colour
            $seen[$m.Match] = $true
            break
        }

        if ($line -match "blocked:|Release blocked|Aborted by user request|Terminate batch job") {
            Say $line.Trim() "Red"
        }
    }
}

while (-not $build.HasExited) {
    Start-Sleep -Milliseconds 400
    Show-NewProgress
}
# Redirected output can still be flushing after the process object reports exit.
Start-Sleep -Milliseconds 600
Show-NewProgress -Final

if ($helpers -gt 0 -and -not $helpersAnnounced) {
    Say "signed $helpers bundle helpers"
}

# --- 5. outcome ----------------------------------------------------------

Write-Host ""
if ($build.ExitCode -ne 0) {
    Write-Host "Build FAILED (exit $($build.ExitCode))." -ForegroundColor Red
    Write-Host ""
    Write-Host "Last 25 lines of $log" -ForegroundColor DarkGray
    Read-LogLines -Path $log | Where-Object { $_ } | Select-Object -Last 25 | ForEach-Object { "    $_" }
    $errors = Read-LogLines -Path $errLog | Where-Object { $_ }
    if ($errors) {
        Write-Host ""
        Write-Host "Standard error:" -ForegroundColor DarkGray
        $errors | Select-Object -Last 25 | ForEach-Object { "    $_" }
    }
    exit $build.ExitCode
}

$config = Get-Content -LiteralPath (Join-Path $repository "dashboard\src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$version = $config.version
$installer = Join-Path $repository "dashboard\src-tauri\target\release\bundle\nsis\Time_${version}_x64-setup.exe"

Say "Verifying the finished installer ..." "White"
& (Join-Path $PSScriptRoot "verify_release.ps1") -Installer $installer | Out-Null
Say "Release gate passed." "Green"

$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
$size = (Get-Item -LiteralPath $installer).Length
$commit = (& git -C $repository rev-parse HEAD).Trim()

Write-Host ""
Write-Host "Release $version is built and verified." -ForegroundColor Green
Write-Host "  Installer : $installer"
Write-Host "  SHA-256   : $hash"
Write-Host "  Size      : $('{0:N0}' -f $size) bytes"
Write-Host "  Commit    : $commit"
Write-Host "  Log       : $log"
Write-Host ""
Write-Host "Nothing has been published. The remaining steps are irreversible, so"
Write-Host "they are yours to run:"
Write-Host ""
Write-Host "  1. Tag the exact commit this was built from" -ForegroundColor DarkGray
Write-Host "     git tag -a v$version $commit -m `"Time $version"
Write-Host "     Time_${version}_x64-setup.exe"
Write-Host "     SHA-256 $hash`""
Write-Host "     git push origin v$version"
Write-Host ""
Write-Host "  2. Publish the INSTALLER first, then the manifest" -ForegroundColor DarkGray
Write-Host "     gh release create v$version `"$installer`" --title `"Time $version`""
Write-Host ""
Write-Host "  3. Then the website bump, then purge the CDN for latest.json." -ForegroundColor DarkGray
Write-Host "     The manifest advertises the update to every installed copy; if it"
Write-Host "     names a URL that is not live, the first client to check gets a 404."
