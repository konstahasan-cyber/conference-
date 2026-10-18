@echo off
rem Zoom autowebinar setup (Zoom client, OBS Studio, VB-CABLE, zoom-runner) for Windows Server.
rem Run it inside the RDP session of the user who will run Zoom and OBS (usually Administrator),
rem after install.cmd / install.ps1. Double-click this file or run it from cmd:
rem it starts zoom-setup.ps1 from the same folder (the script asks for administrator rights itself).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0zoom-setup.ps1" %*
echo.
pause
