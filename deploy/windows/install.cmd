@echo off
rem Conference (video meetings) installer for Windows Server.
rem Double-click this file or run it from cmd: it starts install.ps1 from the same folder
rem (the script asks for administrator rights itself).
rem
rem One-liner without downloading the repo (PowerShell as Administrator):
rem   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/konstahasan-cyber/conference-/claude/video-conference-recording-service-4y8f5m/deploy/windows/install.ps1 -OutFile $env:TEMP\install.ps1; & $env:TEMP\install.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
