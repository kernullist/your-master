@echo off
REM Double-click wrapper to launch the AIRI desktop app via run-app.ps1.
REM Forwards any args (e.g. -Install, -Web) to the PowerShell script.
pwsh -ExecutionPolicy Bypass -File "%~dp0run-app.ps1" %*
if errorlevel 1 (
    echo.
    echo [run-app] Failed. See messages above.
    pause
)
