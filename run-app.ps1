# Launch the AIRI desktop app (stage-tamagotchi) in dev mode.
# Usage:
#   pwsh -File .\run-app.ps1            # start dev (electron-vite dev)
#   pwsh -File .\run-app.ps1 -Install   # run pnpm install first, then dev
#   pwsh -File .\run-app.ps1 -Web       # run the web build (stage-web) instead

param(
    [switch]$Install,
    [switch]$Web
)

$ErrorActionPreference = "Stop"

# Always operate from the repo root (the folder this script lives in),
# regardless of the caller's current directory.
$RepoRoot = $PSScriptRoot
Set-Location $RepoRoot

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue))
{
    Write-Error "pnpm not found on PATH. Install pnpm first: https://pnpm.io/installation"
    exit 1
}

if ($Install)
{
    Write-Host "[run-app] Installing dependencies (pnpm install)..."
    pnpm install
}

if ($Web)
{
    Write-Host "[run-app] Starting stage-web dev server..."
    pnpm -F @proj-airi/stage-web dev
}
else
{
    Write-Host "[run-app] Starting stage-tamagotchi (Electron) dev..."
    pnpm -F @proj-airi/stage-tamagotchi dev
}
