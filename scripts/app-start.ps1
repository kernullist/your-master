<#
.SYNOPSIS
Starts the AIRI desktop app (stage-tamagotchi) in dev mode as a background process.

.DESCRIPTION
Launches `pnpm -F <filter> dev` (electron-vite dev) detached from the current
terminal, writes the root process id to .temp/app-dev.pid so that
scripts/app-stop.ps1 can terminate the whole process tree later, and redirects
stdout/stderr to log files under .temp/.

.PARAMETER Filter
pnpm workspace filter of the app to start.
Default: @proj-airi/stage-tamagotchi (Electron desktop app).
Use @proj-airi/stage-web to start the web app dev server instead.

.EXAMPLE
./scripts/app-start.ps1
./scripts/app-start.ps1 -Filter @proj-airi/stage-web
#>
param(
    [string]$Filter = '@proj-airi/stage-tamagotchi'
)

$ErrorActionPreference = 'Stop'

# Resolve repo root from this script location so the script works from any cwd.
$repoRoot = Split-Path -Parent $PSScriptRoot
$tempDir = Join-Path $repoRoot '.temp'
$pidFile = Join-Path $tempDir 'app-dev.pid'
$outLog = Join-Path $tempDir 'app-dev.out.log'
$errLog = Join-Path $tempDir 'app-dev.err.log'

if (-not (Test-Path $tempDir))
{
    New-Item -ItemType Directory -Path $tempDir | Out-Null
}

# Refuse to double-start: if the recorded pid is still alive, bail out.
if (Test-Path $pidFile)
{
    $existingPid = (Get-Content $pidFile -TotalCount 1).Trim()
    $existingProcess = $null
    if ($existingPid -match '^\d+$')
    {
        $existingProcess = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
    }

    if ($existingProcess)
    {
        Write-Host "[app-start] already running (pid $existingPid). Use scripts/app-stop.ps1 first."
        exit 1
    }

    # Stale pidfile from a crashed or externally killed run; clean it up.
    Remove-Item $pidFile -Force -Confirm:$false
}

$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue)
if (-not $pnpm)
{
    Write-Host '[app-start] pnpm not found in PATH.'
    exit 1
}

Write-Host "[app-start] starting '$Filter' dev (logs: $outLog)"

# Start-Process gives us a stable root pid; taskkill /T from app-stop.ps1
# later kills the full tree (pnpm -> electron-vite -> electron + renderers).
$process = Start-Process -FilePath $pnpm.Source `
    -ArgumentList @('-F', $Filter, 'dev') `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden `
    -PassThru

Set-Content -Path $pidFile -Value $process.Id

# Early-exit detection: dev servers die within a few seconds on config or
# port errors. Catch that here instead of leaving a dead pidfile behind.
Start-Sleep -Seconds 3
if ($process.HasExited)
{
    Write-Host "[app-start] process exited immediately (code $($process.ExitCode)). Last stderr lines:"
    if (Test-Path $errLog)
    {
        Get-Content $errLog -Tail 20 | ForEach-Object { Write-Host "  $_" }
    }
    Remove-Item $pidFile -Force -Confirm:$false -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "[app-start] started (pid $($process.Id)). Stop with scripts/app-stop.ps1"
exit 0
