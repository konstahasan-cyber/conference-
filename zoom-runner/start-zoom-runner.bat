@echo off
rem Запуск Zoom-пульта в сеансе текущего пользователя. При падении перезапускается через 5 с.
chcp 65001 >nul
cd /d "%~dp0"
:loop
node "%~dp0runner.js" "C:\conference\zoom-runner.json"
timeout /t 5 /nobreak >nul
goto loop
