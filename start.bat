@echo off
chcp 65001 >nul
title Видеовстречи - сервер
cd /d "%~dp0"

rem ===== 1. Node.js =====
where node >nul 2>nul
if %errorlevel%==0 goto have_node
echo Node.js не найден. Пробую установить автоматически...
where winget >nul 2>nul
if not %errorlevel%==0 goto manual_node
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.
echo Готово. ЗАКРОЙТЕ это окно и запустите start.bat ещё раз.
pause
exit /b

:manual_node
echo Установите Node.js - версию LTS - с сайта nodejs.org, затем запустите start.bat снова.
start "" https://nodejs.org/
pause
exit /b

:have_node
rem ===== 2. Зависимости =====
if exist "node_modules\socket.io\" goto have_modules
echo Первый запуск: устанавливаю зависимости, это займёт минуту...
call npm install --omit=dev
if %errorlevel%==0 goto have_modules
echo.
echo Не удалось установить зависимости. Проверьте интернет и запустите снова.
pause
exit /b

:have_modules
rem ===== 3. Пароль администратора =====
if exist "admin-password.txt" goto have_pass
echo.
echo Придумайте пароль для админ-панели - латинские буквы и цифры.
:ask_pass
set "NEWPASS="
set /p "NEWPASS=Пароль: "
if not defined NEWPASS goto ask_pass
>"admin-password.txt" echo %NEWPASS%
echo Пароль сохранён в файле admin-password.txt
echo Чтобы сменить пароль, удалите этот файл и запустите start.bat снова.

:have_pass
set /p ADMIN_PASSWORD=<"admin-password.txt"

rem ===== 4. Ярлык на рабочем столе =====
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Conference.lnk'; if (-not (Test-Path $p)) { $s = (New-Object -ComObject WScript.Shell).CreateShortcut($p); $s.TargetPath = '%~dp0start.bat'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%SystemRoot%\System32\shell32.dll,13'; $s.Save(); Write-Host 'Ярлык Conference создан на рабочем столе.' }"

rem ===== 5. Запуск =====
if not defined PORT set PORT=3000
set OPEN_BROWSER=1
echo.
echo ================================================
echo   Админ-панель:  http://localhost:%PORT%/admin
echo   Чтобы остановить сервер - закройте это окно.
echo ================================================
echo.
node server.js
echo.
echo Сервер остановлен.
pause
