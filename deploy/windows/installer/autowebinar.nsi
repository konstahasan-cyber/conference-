; Установщик «Автовебинары» (AutowebinarSetup.exe).
; Сборка (Linux или Windows с NSIS 3): makensis deploy/windows/installer/autowebinar.nsi
; Сам установщик маленький: он распаковывает скрипты и запускает autowebinar-setup.ps1,
; который скачивает Node.js, приложение, Zoom, OBS и VB-CABLE.

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel admin
ManifestDPIAware true

!define APPNAME "Автовебинары"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Autowebinar"
!define SRC ".."

Name "${APPNAME}"
OutFile "..\..\..\dist\AutowebinarSetup.exe"
InstallDir "C:\conference"
Icon "autowebinar.ico"
UninstallIcon "autowebinar.ico"
BrandingText "${APPNAME}"
ShowInstDetails show

VIProductVersion "1.0.0.0"
VIAddVersionKey /LANG=1049 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=1049 "FileDescription" "Установка программы ${APPNAME}"
VIAddVersionKey /LANG=1049 "FileVersion" "1.0.0"
VIAddVersionKey /LANG=1049 "LegalCopyright" "conference"

!include "MUI2.nsh"
!define MUI_ICON "autowebinar.ico"
!define MUI_UNICON "autowebinar.ico"
!define MUI_WELCOMEPAGE_TITLE "Установка «${APPNAME}»"
!define MUI_WELCOMEPAGE_TEXT "Программа показывает заранее записанный созвон в Zoom как живой эфир: видео идёт камерой ведущего, звук — микрофоном.$\r$\n$\r$\nБудут установлены (бесплатно): Node.js, ffmpeg, админ-панель, Zoom, OBS Studio и виртуальный аудиокабель VB-CABLE.$\r$\n$\r$\nДальше откроется окно установки — в нём нужно будет придумать пароль для админки. Установка займёт 5–15 минут.$\r$\n$\r$\nЗапускайте на сервере в RDP-сессии того пользователя, под которым будет работать Zoom."
!define MUI_FINISHPAGE_TITLE "Почти готово"
!define MUI_FINISHPAGE_TEXT "Если окно установки закрылось с ошибкой — запустите установщик ещё раз.$\r$\n$\r$\nПрограмма открывается ярлыком «${APPNAME}» на рабочем столе."
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

Section "Install"
  SetOutPath "$INSTDIR\installer"
  File "autowebinar-setup.ps1"
  File "autowebinar.ico"
  File "${SRC}\install.ps1"
  File "${SRC}\video.ps1"
  File "${SRC}\zoom-setup.ps1"
  File "${SRC}\rdp-disconnect.cmd"

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\installer\autowebinar.ico"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "conference"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1

  DetailPrint "Открываю окно установки (не закрывайте его)..."
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\installer\autowebinar-setup.ps1"' $0
  DetailPrint "Окно установки закрыто (код $0)."
  StrCmp $0 "0" done
    MessageBox MB_ICONEXCLAMATION "Установка завершилась с ошибкой (код $0). Посмотрите сообщения в окне установки и запустите установщик ещё раз."
  done:
SectionEnd

Section "Uninstall"
  MessageBox MB_YESNO|MB_ICONQUESTION "Удалить и все данные (загруженные записи, встречи, настройки)?$\r$\n$\r$\n«Нет» — удалить только программу, данные останутся в $INSTDIR\data." IDYES wipe IDNO keep
  wipe:
    StrCpy $1 "1"
    Goto go
  keep:
    StrCpy $1 "0"
  go:
  DetailPrint "Останавливаю задачи..."
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-ScheduledTask -TaskName 'conference-*' -ErrorAction SilentlyContinue | ForEach-Object { Stop-ScheduledTask -InputObject $$_ -ErrorAction SilentlyContinue; Unregister-ScheduledTask -InputObject $$_ -Confirm:$$false }; Get-CimInstance Win32_Process | Where-Object { $$_.CommandLine -like '*C:\conference\*' -and $$_.ProcessId -ne $$PID } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-NetFirewallRule -DisplayName 'Conference*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule"`
  Sleep 2000
  SetShellVarContext current
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$DESKTOP\Отключиться, оставив Zoom работать.lnk"
  SetShellVarContext all
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$WINDIR\video.cmd"
  StrCmp $1 "1" 0 +3
    RMDir /r "$INSTDIR"
    Goto removed
  ; оставляем data\ и config.json — повторная установка подхватит их
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\bin"
  RMDir /r "$INSTDIR\installer"
  RMDir /r "$INSTDIR\browser"
  RMDir /r "$INSTDIR\logs"
  RMDir /r "$INSTDIR\tmp"
  Delete "$INSTDIR\*.ps1"
  Delete "$INSTDIR\*.cmd"
  Delete "$INSTDIR\uninstall.exe"
  removed:
  DeleteRegKey HKLM "${UNINST_KEY}"
  DetailPrint "Zoom, OBS Studio и VB-CABLE не удаляются — при желании удалите их в «Программы и компоненты»."
SectionEnd
