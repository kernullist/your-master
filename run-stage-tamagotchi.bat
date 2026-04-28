@echo off
setlocal

cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm is not available on PATH.
  echo Install pnpm or enable it with Corepack, then run this file again.
  pause
  exit /b 1
)

echo Starting AIRI stage-tamagotchi desktop app...
pnpm dev:tamagotchi

set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" (
  echo.
  echo App command exited with code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
