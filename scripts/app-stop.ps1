<#
.SYNOPSIS
Stops the AIRI dev app started by scripts/app-start.ps1.

.DESCRIPTION
Reads the root process id from .temp/app-dev.pid and terminates the whole
process tree (pnpm -> electron-vite -> electron and its renderer processes)
via taskkill /T. If the pidfile is missing or stale, falls back to finding
leftover electron-vite/electron processes whose command line points into this
repository, so orphaned dev instances can still be cleaned up.

.PARAMETER Force
Skip the confirmation prompt for the fallback (command-line scan) path.
The pidfile path never prompts because it only kills what app-start recorded.

.EXAMPLE
./scripts/app-stop.ps1
./scripts/app-stop.ps1 -Force
#>
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $repoRoot '.temp/app-dev.pid'

function Stop-ProcessTree([int]$RootPid)
{
    # taskkill /T walks the child tree; Stop-Process alone would leave the
    # electron main/renderer processes alive when only pnpm dies.
    & taskkill /PID $RootPid /T /F 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

# Path 1: pidfile recorded by app-start.ps1.
if (Test-Path $pidFile)
{
    $recordedPid = (Get-Content $pidFile -TotalCount 1).Trim()
    Remove-Item $pidFile -Force -Confirm:$false

    if ($recordedPid -match '^\d+$' -and (Get-Process -Id ([int]$recordedPid) -ErrorAction SilentlyContinue))
    {
        if (Stop-ProcessTree ([int]$recordedPid))
        {
            Write-Host "[app-stop] stopped process tree (pid $recordedPid)."
            exit 0
        }

        Write-Host "[app-stop] taskkill failed for pid $recordedPid; falling back to scan."
    }
    else
    {
        Write-Host '[app-stop] pidfile was stale; scanning for leftover dev processes.'
    }
}
else
{
    Write-Host '[app-stop] no pidfile; scanning for leftover dev processes.'
}

# Path 2 (fallback): find node/electron processes whose command line points
# into this repo and looks like the dev runner. Match on the repo path to
# avoid killing unrelated electron apps (e.g. VS Code) on the machine.
$repoPathPattern = [regex]::Escape($repoRoot)
$candidates = Get-CimInstance Win32_Process |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match $repoPathPattern -and
        ($_.CommandLine -match 'electron-vite|electron\.exe|\\electron\\dist\\')
    }

if (-not $candidates)
{
    Write-Host '[app-stop] nothing to stop.'
    exit 0
}

Write-Host "[app-stop] found $(@($candidates).Count) candidate process(es):"
foreach ($candidate in $candidates)
{
    $preview = $candidate.CommandLine
    if ($preview.Length -gt 120)
    {
        $preview = $preview.Substring(0, 120) + '...'
    }
    Write-Host "  pid $($candidate.ProcessId): $preview"
}

if (-not $Force)
{
    $answer = Read-Host '[app-stop] kill these process trees? (y/N)'
    if ($answer -notmatch '^[yY]')
    {
        Write-Host '[app-stop] aborted.'
        exit 1
    }
}

$stoppedCount = 0
foreach ($candidate in $candidates)
{
    # A candidate may already be gone if it was a child of one killed earlier.
    if (Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue)
    {
        if (Stop-ProcessTree ([int]$candidate.ProcessId))
        {
            $stoppedCount += 1
        }
    }
}

Write-Host "[app-stop] stopped $stoppedCount process tree(s)."
exit 0
