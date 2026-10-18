@echo off
rem Disconnect from Remote Desktop WITHOUT locking the Windows session.
rem Closing the RDP window with the X locks the session, and Zoom / OBS may stop sending video.
rem This script moves the current session to the server console (tscon <id> /dest:console):
rem the RDP window closes, but the desktop stays unlocked and Zoom / OBS keep working.
rem Installed by zoom-setup.ps1 as C:\conference\rdp-disconnect.cmd with a desktop shortcut.
setlocal

rem --- self-elevation (tscon needs administrator rights) ---
net session >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

rem --- already on the console? nothing to do ---
query session 2>nul | findstr /b /i /c:">console" >nul
if not errorlevel 1 (
  echo This session is already on the console - nothing to disconnect.
  timeout /t 5 >nul
  exit /b 0
)

rem --- current session id: the line marked with ">" in "query session" ---
set "SID="
for /f "tokens=3" %%i in ('query session 2^>nul ^| findstr /b /c:">"') do set "SID=%%i"
echo %SID%| findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 (
  set "SID="
  for /f %%i in ('powershell.exe -NoProfile -Command "(Get-Process -Id $PID).SessionId"') do set "SID=%%i"
)
if "%SID%"=="" (
  echo Could not determine the current session id. Run "query session" and then: tscon ID /dest:console
  pause
  exit /b 1
)

echo Disconnecting session %SID% to the console. Zoom and OBS keep running.
tscon %SID% /dest:console
if errorlevel 1 (
  echo tscon failed. Make sure you are logged on as an administrator.
  pause
  exit /b 1
)
exit /b 0
