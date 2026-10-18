<#
  «Автовебинары» — установка одной программой (запускается из AutowebinarSetup.exe).

  1. install.ps1 -Local: Node.js, ffmpeg, приложение (админка только на этом компьютере,
     http://127.0.0.1:порт/admin, без домена, HTTPS и открытых портов);
  2. zoom-setup.ps1: Zoom, OBS Studio, VB-CABLE, zoom-runner в сессии пользователя;
  3. ярлык «Автовебинары» на рабочем столе и в меню «Пуск» — админка в отдельном окне.

  Сначала пробует скачать свежие версии скриптов с GitHub (тогда установщик .exe
  не устаревает); если не вышло — использует те, что лежат рядом.
#>
[CmdletBinding()]
param([switch]$NoRefresh)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}
try { $Host.UI.RawUI.WindowTitle = 'Установка: Автовебинары' } catch {}

$Root    = 'C:\conference'
$CfgPath = Join-Path $Root 'config.json'
$IconDst = Join-Path $Root 'autowebinar.ico'
$Branch  = 'claude/video-conference-recording-service-4y8f5m'
$RawBase = "https://raw.githubusercontent.com/konstahasan-cyber/conference-/$Branch/deploy/windows"
$Files   = @('install.ps1', 'video.ps1', 'zoom-setup.ps1', 'rdp-disconnect.cmd')
$AppName = 'Автовебинары'
$Here    = $PSScriptRoot

function Say([string]$m)  { Write-Host ''; Write-Host "==> $m" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Ok([string]$m)   { Write-Host $m -ForegroundColor Green }
function Stop-Setup([string]$m) {
  Write-Host ''
  Write-Host "Ошибка: $m" -ForegroundColor Red
  Write-Host 'Исправьте причину и запустите установщик ещё раз — уже сделанное повторно не скачивается.'
  Read-Host 'Нажмите Enter, чтобы закрыть окно' | Out-Null
  exit 1
}
function Get-File([string]$Url, [string]$OutFile) {
  try {
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 60
    return ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 0)
  } catch { return $false }
}
function Invoke-Step([string]$Script, [string[]]$ScriptArgs) {
  # отдельный процесс: «exit» внутри скрипта не закрывает установщик
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Here $Script)) + $ScriptArgs
  & powershell.exe @a
  return $LASTEXITCODE
}

# ---------- Права администратора ----------
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Stop-Setup 'нужны права администратора — запустите AutowebinarSetup.exe ещё раз и разрешите изменения.'
}
if ((Get-Process -Id $PID).SessionId -eq 0) {
  Stop-Setup 'установку нужно запускать на рабочем столе (войдите на сервер по RDP), а не через службу или SSH.'
}

# ---------- Свежие версии скриптов ----------
if (-not $NoRefresh) {
  $fresh = Join-Path $env:TEMP ('autowebinar-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $fresh | Out-Null
  $ok = Get-File "$RawBase/installer/autowebinar-setup.ps1" (Join-Path $fresh 'autowebinar-setup.ps1')
  foreach ($f in $Files) { if ($ok) { $ok = Get-File "$RawBase/$f" (Join-Path $fresh $f) } }
  if ($ok) {
    Copy-Item -Force (Join-Path $Here 'autowebinar.ico') $fresh -ErrorAction SilentlyContinue
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fresh 'autowebinar-setup.ps1') -NoRefresh
    $code = $LASTEXITCODE
    Remove-Item -Recurse -Force $fresh -ErrorAction SilentlyContinue
    exit $code
  }
  Remove-Item -Recurse -Force $fresh -ErrorAction SilentlyContinue
  Warn 'Не удалось скачать свежие скрипты с GitHub — ставлю версией из установщика.'
}

Write-Host ''
Write-Host '  Автовебинары: показ записей в Zoom как живого эфира' -ForegroundColor Green
Write-Host '  Установка займёт 5–15 минут. Окно можно не трогать — вопросы будут здесь.' -ForegroundColor Green

# ---------- 1. Программа и админка ----------
Say 'Шаг 1 из 3: программа и админ-панель'
$rc = Invoke-Step 'install.ps1' @('-Local')
if ($rc -ne 0) { Stop-Setup 'установка программы не завершилась (см. сообщения выше).' }
if (-not (Test-Path $CfgPath)) { Stop-Setup "не найден $CfgPath после установки." }
$cfg = Get-Content -Raw -Encoding UTF8 $CfgPath | ConvertFrom-Json
$AdminUrl = [string]$cfg.adminUrl
if (-not $AdminUrl) { $AdminUrl = "http://127.0.0.1:$($cfg.port)/admin" }

# ---------- 2. Zoom, OBS, VB-CABLE ----------
Say 'Шаг 2 из 3: Zoom, OBS Studio и виртуальный звук'
$rc = Invoke-Step 'zoom-setup.ps1' @('-ForUser', [Security.Principal.WindowsIdentity]::GetCurrent().Name)
$ZoomOk = ($rc -eq 0)
if (-not $ZoomOk) { Warn 'Настройка Zoom завершилась с ошибкой (см. выше). Админка работает; повторите установщик после исправления.' }

# ---------- 3. Окно программы ----------
Say 'Шаг 3 из 3: ярлык «Автовебинары»'
Copy-Item -Force (Join-Path $Here 'autowebinar.ico') $IconDst -ErrorAction SilentlyContinue

function Find-Browser {
  foreach ($p in @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
                   "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
                   "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                   "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                   "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}
$Browser = Find-Browser
if (-not $Browser) {
  Write-Host 'На сервере нет Microsoft Edge — ставлю (админке нужен современный браузер)...'
  $msi = Join-Path $env:TEMP 'MicrosoftEdgeEnterpriseX64.msi'
  if (Get-File 'https://go.microsoft.com/fwlink/?LinkID=2093437' $msi) {
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
    Remove-Item -Force $msi -ErrorAction SilentlyContinue
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Warn "Установщик Edge вернул код $($p.ExitCode)." }
  }
  $Browser = Find-Browser
}
if ($Browser -like '*msedge.exe') {
  # без приветственных окон Edge при первом запуске
  $pol = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
  try {
    New-Item -Force -Path $pol | Out-Null
    Set-ItemProperty -Path $pol -Name 'HideFirstRunExperience' -Value 1 -Type DWord
  } catch {}
}

$ProfileDir = Join-Path $Root 'browser'
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"),
  (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) "$AppName.lnk")
)
$wsh = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
  try {
    $lnk = $wsh.CreateShortcut($t)
    if ($Browser) {
      $lnk.TargetPath = $Browser
      $lnk.Arguments = "--app=$AdminUrl --user-data-dir=`"$ProfileDir`" --no-first-run --no-default-browser-check"
    } else {
      $lnk.TargetPath = 'explorer.exe'
      $lnk.Arguments = $AdminUrl
    }
    if (Test-Path $IconDst) { $lnk.IconLocation = "$IconDst,0" }
    $lnk.Description = 'Автовебинары: записи, расписание и показ в Zoom'
    $lnk.Save()
  } catch { Warn "Не удалось создать ярлык ${t}: $($_.Exception.Message)" }
}
Ok "Ярлык «$AppName» — на рабочем столе и в меню «Пуск»."

# ---------- Итог ----------
$line = '=' * 64
Write-Host ''
Write-Host $line -ForegroundColor Green
if ($ZoomOk) { Write-Host '  Готово! Программа «Автовебинары» установлена.' -ForegroundColor Green }
else { Write-Host '  Админка установлена, но в настройке Zoom были ошибки (см. выше).' -ForegroundColor Yellow }
Write-Host "  Открыть:  ярлык «$AppName» на рабочем столе ($AdminUrl)"
Write-Host '  Логин:    admin'
Write-Host '  Пароль:   тот, что вы ввели (или сгенерированный — показан выше)'
Write-Host ''
Write-Host '  Как пользоваться:' -ForegroundColor Cyan
Write-Host '   1. «Записи» → загрузите видео созвона.'
Write-Host '   2. Создайте встречу → в пульте выберите запись, в карточке «Показ в Zoom»'
Write-Host '      вставьте ссылку на Zoom-встречу и включите переключатель.'
Write-Host '   3. «Тест без входа в Zoom» — проверить картинку и звук в OBS.'
Write-Host '   4. Запуск — кнопкой, по расписанию или с повтором каждый день.'
Write-Host '   5. Уходя с сервера — ярлык «Отключиться, оставив Zoom работать».'
Write-Host $line -ForegroundColor Green

if ($Browser) { Start-Process -FilePath $Browser -ArgumentList "--app=$AdminUrl", "--user-data-dir=`"$ProfileDir`"", '--no-first-run', '--no-default-browser-check' }
else { Start-Process $AdminUrl }
Read-Host 'Нажмите Enter, чтобы закрыть это окно' | Out-Null
exit 0
