<#
.SYNOPSIS
    Restores a console whose input handling has been left broken by an aborted
    build -- dead backspace, dead shortcuts, keys that do not register.

.DESCRIPTION
    A process that changes the console mode and then dies without restoring it
    leaves the console in whatever state it was using. The symptoms are specific
    and recognisable: backspace does nothing, Ctrl shortcuts do nothing, and
    typing may not echo. Nothing is wrong with the shell; the console's input
    mode simply no longer describes a line-edited terminal.

    Console mode is a property of the console, not of a process, so the reset
    below works even when this script runs as a child. Reloading PSReadLine does
    not -- that has to happen inside the session that owns the prompt. Dot-source
    this script to get both:

        . scripts/repair_console.ps1

    Running it any other way still fixes the console mode and says so.

    If this ever fails to help, the fallback is a new window. That was the only
    remedy before this script existed.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

if (-not ("Time.ConsoleRepair" -as [type])) {
    Add-Type -Namespace Time -Name ConsoleRepair -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr GetStdHandle(int nStdHandle);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
'@
}

$STD_INPUT  = -10
$STD_OUTPUT = -11

# The flags a line-edited console needs. ENABLE_LINE_INPUT and ENABLE_ECHO_INPUT
# are the two whose absence produces "backspace does nothing"; PROCESSED_INPUT is
# what makes Ctrl+C a signal rather than a character.
#
# These are OR-ed into the current mode rather than replacing it. The failure
# being repaired is flags being cleared, and overwriting wholesale would also
# strip flags that are legitimately set -- mouse input, auto-position -- and force
# on ones the console never had, like VIRTUAL_TERMINAL_INPUT, whose correct value
# differs between Windows Terminal and conhost. Restore what is missing; leave
# the rest alone.
$INPUT_REQUIRED = 0x0001 -bor  # ENABLE_PROCESSED_INPUT
                  0x0002 -bor  # ENABLE_LINE_INPUT
                  0x0004 -bor  # ENABLE_ECHO_INPUT
                  0x0020 -bor  # ENABLE_INSERT_MODE
                  0x0080       # ENABLE_EXTENDED_FLAGS

$OUTPUT_REQUIRED = 0x0001 -bor # ENABLE_PROCESSED_OUTPUT
                   0x0002 -bor # ENABLE_WRAP_AT_EOL_OUTPUT
                   0x0004      # ENABLE_VIRTUAL_TERMINAL_PROCESSING

$script:RepairedSomething = $false
$script:SawRealConsole = $false

function Restore-Mode {
    param([int]$Handle, [uint32]$Required, [string]$Label)

    $h = [Time.ConsoleRepair]::GetStdHandle($Handle)
    if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr](-1)) {
        Write-Host "  $Label : no console handle (output is redirected?)"
        return
    }
    $before = 0
    if (-not [Time.ConsoleRepair]::GetConsoleMode($h, [ref]$before)) {
        Write-Host "  $Label : could not be read; not a real console"
        return
    }
    $script:SawRealConsole = $true

    $desired = $before -bor $Required
    if ($desired -eq $before) {
        Write-Host ("  {0} : 0x{1:X4}  (already correct)" -f $Label, $before)
        return
    }
    if (-not [Time.ConsoleRepair]::SetConsoleMode($h, $desired)) {
        Write-Host ("  {0} : repair FAILED (error {1})" -f $Label, [Runtime.InteropServices.Marshal]::GetLastWin32Error())
        return
    }
    $missing = $Required -band (-bnot $before)
    Write-Host ("  {0} : 0x{1:X4} -> 0x{2:X4}  (restored 0x{3:X4})" -f $Label, $before, $desired, $missing)
    $script:RepairedSomething = $true
}

Write-Host "Console mode:"
Restore-Mode -Handle $STD_INPUT  -Required $INPUT_REQUIRED  -Label "input "
Restore-Mode -Handle $STD_OUTPUT -Required $OUTPUT_REQUIRED -Label "output"

if (-not $script:SawRealConsole) {
    Write-Host ""
    Write-Host "No console was attached, so nothing was repaired. Run this from the"
    Write-Host "terminal that is misbehaving, not through a redirected pipe."
    return
}
if (-not $script:RepairedSomething) {
    Write-Host ""
    Write-Host "The console mode was already correct, so the problem is elsewhere."
    Write-Host "Reloading PSReadLine below is the next thing worth trying."
}

# $MyInvocation.InvocationName is "." only when dot-sourced, which is the one way
# this can reach the caller's module table.
if ($MyInvocation.InvocationName -eq ".") {
    Remove-Module PSReadLine -Force -ErrorAction SilentlyContinue
    Import-Module PSReadLine -ErrorAction SilentlyContinue
    if (Get-Module PSReadLine) {
        Write-Host "PSReadLine reloaded. The line editor should behave again."
    } else {
        Write-Host "PSReadLine could not be reloaded; open a new window."
    }
} else {
    Write-Host ""
    Write-Host "PSReadLine was not reloaded -- that only works from the session that"
    Write-Host "owns the prompt. If the line editor is still wrong, run this instead:"
    Write-Host "    . scripts/repair_console.ps1"
}
