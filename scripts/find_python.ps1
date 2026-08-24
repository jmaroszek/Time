<#
.SYNOPSIS
    Writes the path of the Python interpreter the release scripts should use.

.DESCRIPTION
    `python` on PATH is not a stable identity on a Windows development machine.
    Anaconda puts its base environment first, the Microsoft Store installs an
    execution-alias stub that is not an interpreter at all, and a fresh shell
    can have none of them. Every release script that shells out to Python hit
    this, and the fix used to be "remember to arrange PATH first" — which is not
    a fix, because the person who forgets is the person running the release.

    Resolution order, which `run_python.mjs` mirrors for the npm entry points:

      1. TIME_PYTHON                    - explicit override, always wins
      2. data/tracker-build-env/Scripts - the pinned build environment
      3. `python` on PATH               - what CI's setup-python provides
      4. `py -3`                        - the Windows launcher

    Change this order and change `run_python.mjs` to match.

.EXAMPLE
    $python = & "$PSScriptRoot\find_python.ps1"
    & $python script.py --flag
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Test-PythonCandidate {
    param([string]$Command, [string[]]$PrefixArgs = @())

    # The Store's python.exe under WindowsApps is a stub that opens the Store
    # rather than running code. Reject it by path: executing it to find out
    # would pop a Store window at whoever is running the release.
    if ($Command -match "[\\/]WindowsApps[\\/]") { return $false }
    try {
        $reported = & $Command @PrefixArgs -c "import sys; print(sys.version_info[0])" 2>$null
        return ($LASTEXITCODE -eq 0 -and "$reported".Trim() -eq "3")
    } catch {
        return $false
    }
}

$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$pinned = Join-Path $repository "data\tracker-build-env\Scripts\python.exe"

if ($env:TIME_PYTHON) {
    if (-not (Test-PythonCandidate -Command $env:TIME_PYTHON)) {
        throw "TIME_PYTHON is set to '$($env:TIME_PYTHON)', which is not a working Python 3."
    }
    return $env:TIME_PYTHON
}

if ((Test-Path -LiteralPath $pinned -PathType Leaf) -and (Test-PythonCandidate -Command $pinned)) {
    return $pinned
}

foreach ($candidate in @("python", "py")) {
    $prefix = if ($candidate -eq "py") { @("-3") } else { @() }
    $resolved = Get-Command $candidate -ErrorAction SilentlyContinue
    if (-not $resolved) { continue }
    if (Test-PythonCandidate -Command $resolved.Source -PrefixArgs $prefix) {
        # `py -3` cannot be returned as a bare path, so hand back the concrete
        # interpreter the launcher would have chosen instead.
        if ($candidate -eq "py") {
            $target = & $resolved.Source -3 -c "import sys; print(sys.executable)"
            if ($LASTEXITCODE -eq 0 -and $target) { return "$target".Trim() }
            continue
        }
        return $resolved.Source
    }
}

throw @"
No usable Python 3 interpreter found. Looked at, in order:
  1. `$TIME_PYTHON                (unset)
  2. $pinned
     (create it: py -3 -m venv data\tracker-build-env)
  3. ``python`` on PATH
  4. ``py -3``
Install Python 3, or point TIME_PYTHON at an interpreter.
"@
