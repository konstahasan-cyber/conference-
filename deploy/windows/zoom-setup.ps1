<#
  Настройка режима «Zoom-автовебинар» на Windows Server.

  Запускать в RDP-сессии того пользователя, под которым будут работать Zoom и OBS
  (обычно Administrator), — НЕ из службы и НЕ по SSH. Права администратора скрипт
  запросит сам (пользователь при этом останется тем же).

  Что делает:
    • ставит Zoom (клиент), OBS Studio и VB-CABLE (бесплатный виртуальный аудиокабель);
    • включает obs-websocket (127.0.0.1:4455, с паролем);
    • пишет настройки C:\conference\zoom-runner.json;
    • создаёт задачу conference-zoom-runner: при входе пользователя запускает
      zoom-runner (C:\conference\app\zoom-runner\runner.js) в его сессии;
    • кладёт на рабочий стол ярлык «Отключиться, оставив Zoom работать»;
    • отключает сон и гашение экрана;
    • в конце печатает список ручных шагов (вход в Zoom, выбор камеры и микрофона).
  Повторный запуск безопасен: уже установленное пропускается, пароль OBS сохраняется.

  Сначала должна быть выполнена основная установка (install.ps1).
  Запуск: двойной щелчок по zoom-setup.cmd или
    powershell -ExecutionPolicy Bypass -File C:\conference\app\deploy\windows\zoom-setup.ps1
#>
[CmdletBinding()]
param(
  # служебный: имя пользователя, запустившего скрипт до повышения прав
  [string]$ForUser = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # без этого Invoke-WebRequest качает в десятки раз медленнее
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}

$Root       = 'C:\conference'
$Bin        = Join-Path $Root 'bin'
$AppDir     = Join-Path $Root 'app'
$LogDir     = Join-Path $Root 'logs'
$TmpDir     = Join-Path $Root 'tmp'
$CfgPath    = Join-Path $Root 'config.json'
$RunnerDir  = Join-Path $AppDir 'zoom-runner'
$RunnerJs   = Join-Path $RunnerDir 'runner.js'
$RunnerCfg  = Join-Path $Root 'zoom-runner.json'
$RunnerPs1  = Join-Path $Root 'run-zoom-runner.ps1'
$RunnerLog  = Join-Path $LogDir 'zoom-runner.log'
$TaskName   = 'conference-zoom-runner'
$DisconnectCmd = Join-Path $Root 'rdp-disconnect.cmd'
$ShortcutName  = 'Отключиться, оставив Zoom работать'
$Branch     = 'claude/video-conference-recording-service-4y8f5m'
$RawBase    = "https://raw.githubusercontent.com/konstahasan-cyber/conference-/$Branch/deploy/windows"
$ObsPort    = 4455
$Utf8NoBom  = New-Object Text.UTF8Encoding $false
$Utf8Bom    = New-Object Text.UTF8Encoding $true

function Say([string]$m)  { Write-Host ''; Write-Host "==> $m" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Ok([string]$m)   { Write-Host $m -ForegroundColor Green }
function Die([string]$m)  { Write-Host ''; Write-Host "Ошибка: $m" -ForegroundColor Red; exit 1 }

$CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name

# ---------- Права администратора (тот же пользователь) ----------
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  if ($PSCommandPath) {
    Warn 'Нужны права администратора — открываю окно PowerShell от имени администратора...'
    Warn "Если Windows спросит логин и пароль ДРУГОГО пользователя — отмените: войдите по RDP как администратор ($CurrentUser должен входить в группу «Администраторы»)."
    $a = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`" -ForUser `"$CurrentUser`""
    Start-Process powershell.exe -Verb RunAs -ArgumentList $a
    exit
  }
  Die 'запустите PowerShell от имени администратора (правый щелчок → «Запуск от имени администратора») и повторите команду.'
}
if ($ForUser -and ($ForUser -ne $CurrentUser)) {
  Die "окно с правами администратора открыто под пользователем $CurrentUser, а скрипт запускал $ForUser. Zoom и OBS должны работать в сессии того пользователя, который вошёл по RDP: войдите по RDP как администратор и запустите скрипт снова."
}
$mySession = (Get-Process -Id $PID).SessionId
if ($mySession -eq 0) {
  Die 'скрипт запущен не в сессии рабочего стола (служба или SSH). Войдите на сервер по RDP и запустите его там.'
}

# ---------- Вспомогательные функции ----------
function Write-TextFile([string]$Path, [string]$Text, $Encoding) {
  if (-not $Encoding) { $Encoding = $Utf8NoBom }
  $Text = $Text -replace "`r?`n", "`r`n"
  [IO.File]::WriteAllText($Path, $Text, $Encoding)
}

function New-RandomString([int]$Length) {
  $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.ToCharArray()
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  $bytes = New-Object byte[] $Length
  $rng.GetBytes($bytes)
  $sb = New-Object Text.StringBuilder
  foreach ($b in $bytes) { [void]$sb.Append($chars[$b % $chars.Length]) }
  return $sb.ToString()
}

function Get-File([string]$Url, [string]$OutFile) {
  for ($i = 1; $i -le 3; $i++) {
    try {
      if (Test-Path $OutFile) { Remove-Item -Force $OutFile }
      Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
      if ((Test-Path $OutFile) -and ((Get-Item $OutFile).Length -gt 0)) { return $true }
    } catch {
      Warn "Попытка $i из 3 не удалась: $($_.Exception.Message)"
      Start-Sleep -Seconds 3
    }
  }
  return $false
}

function Remove-Dir([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    cmd.exe /c "rd /s /q `"$Path`" >nul 2>nul" | Out-Null
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return (Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json) } catch { return $null }
}
function Get-Prop($Obj, [string]$Name) {
  if ($null -eq $Obj) { return $null }
  $p = $Obj.PSObject.Properties[$Name]
  if ($p) { return $p.Value }
  return $null
}

function Find-ZoomExe {
  $cands = @(
    (Join-Path $env:APPDATA 'Zoom\bin\Zoom.exe'),
    (Join-Path $env:ProgramFiles 'Zoom\bin\Zoom.exe')
  )
  if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'Zoom\bin\Zoom.exe') }
  foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { return $c } }
  return $null
}
function Find-ObsExe {
  $c = Join-Path $env:ProgramFiles 'obs-studio\bin\64bit\obs64.exe'
  if (Test-Path -LiteralPath $c) { return $c }
  return $null
}
function Test-VbCable {
  $found = @(Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*VB-Audio*' })
  if ($found.Count -gt 0) { return $true }
  try {
    $pnp = @(Get-PnpDevice -FriendlyName '*CABLE*' -PresentOnly -ErrorAction SilentlyContinue |
      Where-Object { $_.FriendlyName -like '*VB-Audio*' -or $_.Class -eq 'AudioEndpoint' -or $_.Class -eq 'MEDIA' })
    if ($pnp.Count -gt 0) { return $true }
  } catch {}
  return $false
}

# итог автоматических настроек для финальной сводки
$script:AutoResults = New-Object System.Collections.Generic.List[string]
function Add-Auto([bool]$Done, [string]$Text) {
  if ($Done) { $script:AutoResults.Add("✅ $Text") } else { $script:AutoResults.Add("⚠  $Text — НЕ удалось, см. предупреждения выше") }
}

# Меняет ключи в одной секции INI-файла, сохраняя остальное содержимое.
# OBS пишет свои .ini в UTF-8 без BOM с переводами строк LF — пишем так же.
function Set-IniValues([string]$Path, [string]$Section, [hashtable]$Values) {
  $lines = New-Object System.Collections.Generic.List[string]
  if (Test-Path -LiteralPath $Path) { foreach ($l in [IO.File]::ReadAllLines($Path)) { $lines.Add($l) } }
  $pending = @{}
  foreach ($k in $Values.Keys) { $pending[$k] = $true }
  $start = -1; $end = $lines.Count
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -match '^\[(.+)\]$') {
      if ($start -ge 0) { $end = $i; break }
      if ($Matches[1] -eq $Section) { $start = $i }
    }
  }
  if ($start -lt 0) {
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim() -ne '') { $lines.Add('') }
    $lines.Add("[$Section]")
    $start = $lines.Count - 1; $end = $lines.Count
  }
  for ($i = $start + 1; $i -lt $end; $i++) {
    $eq = $lines[$i].IndexOf('=')
    if ($eq -le 0) { continue }
    $k = $lines[$i].Substring(0, $eq).Trim()
    if ($pending.ContainsKey($k)) { $lines[$i] = "$k=$($Values[$k])"; $pending.Remove($k) }
  }
  $ins = $end
  while ($ins -gt ($start + 1) -and $lines[$ins - 1].Trim() -eq '') { $ins-- }
  foreach ($k in @($Values.Keys)) {
    if ($pending.ContainsKey($k)) { $lines.Insert($ins, "$k=$($Values[$k])"); $ins++ }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
  [IO.File]::WriteAllText($Path, (($lines -join "`n") + "`n"), $Utf8NoBom)
}

# Аудиоустройства Windows из реестра (MMDevices). Flow: Render (вывод) или Capture (запись).
function Get-AudioEndpoints([string]$Flow) {
  $res = @()
  $root = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey("SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\$Flow")
  if (-not $root) { return $res }
  try {
    foreach ($guid in $root.GetSubKeyNames()) {
      $fn = ''; $dn = ''; $state = 0
      try {
        $k = $root.OpenSubKey($guid)
        if (-not $k) { continue }
        try {
          $state = [int]$k.GetValue('DeviceState', 0)
          $pk = $k.OpenSubKey('Properties')
          if ($pk) {
            try {
              $fn = [string]$pk.GetValue('{a45c254e-df1c-4efd-8020-67d146a850e0},2')
              $dn = [string]$pk.GetValue('{b3f8fa53-0004-438e-9003-51a46e139bfc},6')
            } finally { $pk.Close() }
          }
        } finally { $k.Close() }
      } catch { continue }
      $prefix = '{0.0.0.00000000}.'
      if ($Flow -eq 'Capture') { $prefix = '{0.0.1.00000000}.' }
      $res += [pscustomobject]@{
        Id = $prefix + $guid.ToLower(); Name = $fn; Device = $dn
        FullName = "$fn ($dn)"; Active = (($state -band 0xF) -eq 1)
      }
    }
  } finally { $root.Close() }
  return $res
}
# Конец VB-CABLE: «CABLE Input» (вывод) или «CABLE Output» (запись); активный и точное имя — в приоритете.
function Find-CableEndpoint([string]$Flow, [string]$Name) {
  Get-AudioEndpoints $Flow | Where-Object { $_.Device -like '*VB-Audio*' -and $_.Name -like "$Name*" } |
    Sort-Object @{ Expression = { $_.Active }; Descending = $true }, @{ Expression = { $_.Name -eq $Name }; Descending = $true } |
    Select-Object -First 1
}

# Устройство по умолчанию через недокументированный, но давно известный интерфейс IPolicyConfig.
$PolicyConfigCs = @"
using System;
using System.Runtime.InteropServices;
namespace ConfAudio {
  [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    [PreserveSig] int GetMixFormat();
    [PreserveSig] int GetDeviceFormat();
    [PreserveSig] int ResetDeviceFormat();
    [PreserveSig] int SetDeviceFormat();
    [PreserveSig] int GetProcessingPeriod();
    [PreserveSig] int SetProcessingPeriod();
    [PreserveSig] int GetShareMode();
    [PreserveSig] int SetShareMode();
    [PreserveSig] int GetPropertyValue();
    [PreserveSig] int SetPropertyValue();
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
    [PreserveSig] int SetEndpointVisibility();
  }
  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
  class CPolicyConfigClient { }
  public static class Policy {
    public static int SetDefault(string id) {
      IPolicyConfig pc = (IPolicyConfig)new CPolicyConfigClient();
      int hr = 0;
      for (int role = 0; role < 3; role++) { int r = pc.SetDefaultEndpoint(id, role); if (r != 0) hr = r; }
      return hr;
    }
  }
}
"@
function Set-DefaultAudioEndpoint([string]$Id) {
  if (-not ('ConfAudio.Policy' -as [type])) { Add-Type -TypeDefinition $PolicyConfigCs -Language CSharp }
  $hr = [ConfAudio.Policy]::SetDefault($Id)
  if ($hr -ne 0) { throw ('SetDefaultEndpoint вернул 0x{0:X8}' -f $hr) }
}

# ---------- 1. Основная установка ----------
Say 'Проверяю основную установку'
if (-not (Test-Path $CfgPath)) { Die "не найден $CfgPath — сначала выполните основную установку (install.ps1)." }
$NodeExe = Join-Path $Bin 'node\node.exe'
if (-not (Test-Path $NodeExe)) {
  $n = Get-ChildItem -Path $Bin -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($n) { $NodeExe = $n.FullName }
  else { Die "не найден Node.js в $Bin — сначала выполните основную установку (install.ps1)." }
}
$cfg = Read-JsonFile $CfgPath
if (-not $cfg) { Die "не удалось прочитать $CfgPath" }
$AppPort = Get-Prop $cfg 'port'
if (-not $AppPort) { Die "в $CfgPath нет порта приложения (port) — запустите install.ps1 заново." }
$DataDir = Get-Prop $cfg 'dataDir'
if (-not $DataDir) { $DataDir = Join-Path $Root 'data' }
$TokenFile = Join-Path $DataDir 'zoom-runner.token'
Write-Host "Пользователь: $CurrentUser (сессия $mySession)"
Write-Host "Node.js:      $NodeExe"
Write-Host "Приложение:   http://127.0.0.1:$AppPort"
if (-not (Test-Path $RunnerJs)) {
  Warn "Не найден $RunnerJs — обновите приложение командой «video update», затем запустите этот скрипт снова."
  Warn 'Продолжаю настройку; задача zoom-runner заработает после обновления.'
}
foreach ($d in @($LogDir, $TmpDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# ---------- 2. Zoom ----------
Say 'Zoom (клиент)'
$ZoomExe = Find-ZoomExe
if ($ZoomExe) {
  Write-Host "Уже установлен: $ZoomExe"
} else {
  $msi = Join-Path $TmpDir 'ZoomInstallerFull.msi'
  Write-Host 'Скачиваю установщик Zoom'
  if (-not (Get-File 'https://zoom.us/client/latest/ZoomInstallerFull.msi' $msi)) {
    Warn 'Не удалось скачать Zoom. Установите вручную с https://zoom.us/download и запустите скрипт снова.'
  } else {
    Write-Host 'Устанавливаю Zoom (1-2 минуты)'
    $msiLog = Join-Path $LogDir 'zoom-install.log'
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart ZoomAutoUpdate=true /l*v `"$msiLog`"" -Wait -PassThru
    Remove-Item -Force $msi -ErrorAction SilentlyContinue
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Warn "msiexec завершился с кодом $($p.ExitCode) (подробности: $msiLog)" }
    $ZoomExe = Find-ZoomExe
    if ($ZoomExe) { Ok "Zoom установлен: $ZoomExe" }
    else { Warn 'Zoom.exe не найден после установки. Установите Zoom вручную с https://zoom.us/download и запустите скрипт снова.' }
  }
}

# ---------- 3. OBS Studio ----------
Say 'OBS Studio'
$ObsExe = Find-ObsExe
if ($ObsExe) {
  Write-Host "Уже установлен: $ObsExe"
} else {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Host 'Устанавливаю через winget'
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      & $winget.Source install --id OBSProject.OBSStudio -e --silent --accept-package-agreements --accept-source-agreements 2>&1 |
        ForEach-Object { Write-Host "   $_" }
    } catch { Warn "winget: $($_.Exception.Message)" } finally { $ErrorActionPreference = $eap }
    $ObsExe = Find-ObsExe
  }
  if (-not $ObsExe) {
    if ($winget) { Warn 'winget не справился — скачиваю установщик с GitHub' }
    else { Write-Host 'winget нет (обычное дело для Windows Server) — скачиваю установщик с GitHub' }
    $asset = $null
    try {
      $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/obsproject/obs-studio/releases/latest' -UseBasicParsing
      $assets = @($rel.assets)
      foreach ($pat in @('*Windows-x64-Installer.exe', '*Windows-Installer.exe', '*Full-Installer-x64.exe')) {
        $asset = $assets | Where-Object { $_.name -like $pat -and $_.name -notlike '*arm64*' } | Select-Object -First 1
        if ($asset) { break }
      }
      if ($asset) { Write-Host "Версия $($rel.tag_name): $($asset.name)" }
    } catch { Warn "Не удалось получить список версий OBS: $($_.Exception.Message)" }
    if (-not $asset) {
      Warn 'Не нашёл установщик OBS. Установите вручную с https://obsproject.com и запустите скрипт снова.'
    } else {
      $exe = Join-Path $TmpDir 'obs-installer.exe'
      if (Get-File $asset.browser_download_url $exe) {
        Write-Host 'Устанавливаю OBS Studio (1-2 минуты)'
        $p = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
        if ($p.ExitCode -ne 0) { Warn "Установщик OBS завершился с кодом $($p.ExitCode)" }
        Remove-Item -Force $exe -ErrorAction SilentlyContinue
      } else { Warn "Не удалось скачать $($asset.browser_download_url)" }
    }
    for ($i = 0; $i -lt 10 -and -not $ObsExe; $i++) { $ObsExe = Find-ObsExe; if (-not $ObsExe) { Start-Sleep -Seconds 2 } }
  }
  if ($ObsExe) { Ok "OBS Studio установлен: $ObsExe" }
  else { Warn 'obs64.exe не найден. Установите OBS Studio вручную с https://obsproject.com (в папку по умолчанию) и запустите скрипт снова.' }
}

# ---------- 4. VB-CABLE ----------
Say 'VB-CABLE (виртуальный аудиокабель)'
# на Windows Server служба «Windows Audio» по умолчанию не запущена — без неё звука нет вообще
foreach ($svc in @('AudioEndpointBuilder', 'Audiosrv')) {
  try {
    $s = Get-Service -Name $svc -ErrorAction Stop
    if ($s.StartType -ne 'Automatic') { Set-Service -Name $svc -StartupType Automatic }
    if ($s.Status -ne 'Running') { Start-Service -Name $svc -ErrorAction Stop; Write-Host "Запущена служба $svc" }
  } catch { Warn "Не удалось включить службу $svc ($($_.Exception.Message))" }
}
$NeedReboot = $false
if (Test-VbCable) {
  Write-Host 'Уже установлен.'
} else {
  $zip = Join-Path $TmpDir 'vbcable.zip'
  $got = $false
  foreach ($u in @('https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip',
                   'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip')) {
    Write-Host "Скачиваю $u"
    if (Get-File $u $zip) { $got = $true; break }
  }
  if (-not $got) {
    Warn 'Не удалось скачать VB-CABLE. Скачайте вручную с https://vb-audio.com/Cable/, распакуйте и запустите VBCABLE_Setup_x64.exe от имени администратора («Install Driver»).'
  } else {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $ex = Join-Path $TmpDir 'vbcable'
    Remove-Dir $ex
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $ex)
    Remove-Item -Force $zip
    $setup = Get-ChildItem -Path $ex -Recurse -Filter 'VBCABLE_Setup_x64.exe' | Select-Object -First 1
    if (-not $setup) {
      Warn "В архиве нет VBCABLE_Setup_x64.exe — установите VB-CABLE вручную ($ex)."
    } else {
      # доверяем издателю драйвера заранее — тогда Windows не спрашивает «Установить это устройство?»
      try {
        $signed = Get-ChildItem -Path $setup.Directory.FullName -Include '*.cat', '*.sys' -Recurse | Select-Object -First 1
        if ($signed) {
          $cert = (Get-AuthenticodeSignature -FilePath $signed.FullName).SignerCertificate
          if ($cert) {
            $store = New-Object Security.Cryptography.X509Certificates.X509Store('TrustedPublisher', 'LocalMachine')
            $store.Open('ReadWrite'); $store.Add($cert); $store.Close()
          }
        }
      } catch {}
      Warn 'Устанавливаю драйвер. Если появится окно VB-CABLE — нажмите «Install Driver»,'
      Warn 'а если Windows спросит про установку программного обеспечения устройства — «Установить».'
      try {
        $p = Start-Process -FilePath $setup.FullName -ArgumentList '-i', '-h' -WorkingDirectory $setup.Directory.FullName -PassThru
        if (-not $p.WaitForExit(180000)) {
          Warn 'Установщик ещё работает — нажмите в его окне «Install Driver» и дождитесь сообщения об успехе.'
          $p.WaitForExit()
        }
      } catch { Warn "Не удалось запустить установщик: $($_.Exception.Message)" }
      $ok = $false
      for ($i = 0; $i -lt 15 -and -not $ok; $i++) { $ok = Test-VbCable; if (-not $ok) { Start-Sleep -Seconds 2 } }
      if ($ok) {
        Ok 'VB-CABLE установлен.'
        Warn 'Если устройства «CABLE Input / CABLE Output» не видны в Zoom и OBS — перезагрузите сервер.'
      } else {
        $NeedReboot = $true
        Warn "VB-CABLE пока не виден. Запустите вручную $($setup.FullName) (правый щелчок → «Запуск от имени администратора» → «Install Driver»),"
        Warn 'затем перезагрузите сервер и запустите этот скрипт снова.'
      }
    }
  }
}

# ---------- 5. obs-websocket ----------
Say 'obs-websocket (управление OBS)'
$obsProcs = @(Get-Process -Name 'obs64' -ErrorAction SilentlyContinue)
if ($obsProcs.Count -gt 0) {
  Warn 'OBS Studio сейчас запущен — его нужно закрыть, иначе он перезапишет настройки.'
  $ans = Read-Host 'Закрыть OBS сейчас? [Д/н]'
  if ($ans -match '^(н|n)') { Die 'закройте OBS Studio и запустите скрипт снова.' }
  foreach ($p in $obsProcs) { try { [void]$p.CloseMainWindow() } catch {} }
  for ($i = 0; $i -lt 20 -and @(Get-Process -Name 'obs64' -ErrorAction SilentlyContinue).Count -gt 0; $i++) { Start-Sleep -Seconds 1 }
  if (@(Get-Process -Name 'obs64' -ErrorAction SilentlyContinue).Count -gt 0) {
    Warn 'OBS не закрылся сам (возможно, ждёт ответа в своём окне).'
    $ans = Read-Host 'Завершить OBS принудительно? [Д/н]'
    if ($ans -match '^(н|n)') { Die 'закройте OBS Studio и запустите скрипт снова.' }
    Get-Process -Name 'obs64' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
  }
  Ok 'OBS закрыт.'
}
$oldRunner = Read-JsonFile $RunnerCfg
$wsDir = Join-Path $env:APPDATA 'obs-studio\plugin_config\obs-websocket'
$wsCfgPath = Join-Path $wsDir 'config.json'
$ObsPassword = [string](Get-Prop $oldRunner 'obsPassword')
if (-not $ObsPassword) { $ObsPassword = [string](Get-Prop (Read-JsonFile $wsCfgPath) 'server_password') }
if (-not $ObsPassword -or $ObsPassword -notmatch '^[A-Za-z0-9]+$') { $ObsPassword = New-RandomString 20 }
New-Item -ItemType Directory -Force -Path $wsDir | Out-Null
$ws = [ordered]@{
  alerts_enabled  = $false
  auth_required   = $true
  first_load      = $false
  server_enabled  = $true
  server_password = $ObsPassword
  server_port     = $ObsPort
}
Write-TextFile $wsCfgPath ($ws | ConvertTo-Json) $Utf8NoBom
Ok "obs-websocket включён: ws://127.0.0.1:$ObsPort ($wsCfgPath)"
Add-Auto $true 'OBS: включено управление obs-websocket (127.0.0.1:4455, с паролем)'

# ---------- 5а. Настройки OBS: без мастера первого запуска, мониторинг звука в CABLE Input ----------
Say 'Настройки OBS (мастер первого запуска, устройство мониторинга)'
$ObsCfgDir = Join-Path $env:APPDATA 'obs-studio'
try {
  # FirstRun=true — OBS считает, что уже запускался, и не показывает мастер автонастройки.
  # OBS до 30 хранит это в global.ini, OBS 31+ — в user.ini; пишем в оба.
  foreach ($ini in @('global.ini', 'user.ini')) { Set-IniValues (Join-Path $ObsCfgDir $ini) 'General' @{ FirstRun = 'true' } }
  Add-Auto $true 'OBS: мастер автонастройки при первом запуске отключён'
} catch { Warn "Не удалось записать настройки OBS: $($_.Exception.Message)"; Add-Auto $false 'OBS: отключение мастера автонастройки' }
$profilesDir = Join-Path $ObsCfgDir 'basic\profiles'
$profiles = @()
try {
  $profiles = @(Get-ChildItem -Path $profilesDir -Directory -ErrorAction SilentlyContinue)
  if ($profiles.Count -eq 0) {
    $pd = Join-Path $profilesDir 'Untitled'
    Set-IniValues (Join-Path $pd 'basic.ini') 'General' @{ Name = 'Untitled' }
    foreach ($ini in @('global.ini', 'user.ini')) { Set-IniValues (Join-Path $ObsCfgDir $ini) 'Basic' @{ Profile = 'Untitled'; ProfileDir = 'Untitled' } }
    $profiles = @(Get-Item $pd)
    Write-Host "Создан профиль OBS: $pd"
  }
} catch { Warn "Не удалось подготовить профиль OBS: $($_.Exception.Message)" }
$cableIn = Find-CableEndpoint 'Render' 'CABLE Input'
if (-not $cableIn) {
  Warn 'Устройство «CABLE Input» пока не найдено — устройство мониторинга OBS настроится при следующем запуске этого скрипта (после установки VB-CABLE / перезагрузки).'
  Add-Auto $false 'OBS: устройство мониторинга «CABLE Input» (VB-CABLE ещё не виден)'
} else {
  $okMon = $true
  foreach ($pr in $profiles) {
    try {
      Set-IniValues (Join-Path $pr.FullName 'basic.ini') 'Audio' @{ MonitoringDeviceId = $cableIn.Id; MonitoringDeviceName = $cableIn.FullName }
      Write-Host "Профиль «$($pr.Name)»: мониторинг → $($cableIn.FullName)"
    } catch { $okMon = $false; Warn "Профиль «$($pr.Name)»: $($_.Exception.Message)" }
  }
  if (-not $cableIn.Active) { Warn "«$($cableIn.FullName)» сейчас неактивно (возможно, нужна перезагрузка)." }
  Add-Auto ($okMon -and $profiles.Count -gt 0) "OBS: устройство мониторинга — «$($cableIn.FullName)»"
}

# ---------- 5б. Микрофон Windows по умолчанию = CABLE Output ----------
Say 'Микрофон Windows по умолчанию'
$cableOut = Find-CableEndpoint 'Capture' 'CABLE Output'
if (-not $cableOut) {
  Warn 'Устройство «CABLE Output» пока не найдено — настроится при следующем запуске этого скрипта.'
  Add-Auto $false 'Windows: микрофон по умолчанию «CABLE Output» (VB-CABLE ещё не виден)'
} else {
  try {
    Set-DefaultAudioEndpoint $cableOut.Id
    Ok "Микрофон по умолчанию: $($cableOut.FullName)"
    Add-Auto $true "Windows: микрофон по умолчанию — «$($cableOut.FullName)» (Zoom берёт его как «системный»)"
  } catch {
    Warn "Не удалось сделать «$($cableOut.FullName)» микрофоном по умолчанию: $($_.Exception.Message)"
    Add-Auto $false 'Windows: микрофон по умолчанию «CABLE Output»'
  }
  # Если динамики по умолчанию — CABLE Input, звук участников Zoom попадёт обратно в «микрофон» (эхо).
  try {
    $render = @(Get-AudioEndpoints 'Render' | Where-Object { $_.Active })
    $other = $render | Where-Object { $_.Device -notlike '*VB-Audio*' } | Select-Object -First 1
    if ($other) {
      Set-DefaultAudioEndpoint $other.Id
      Write-Host "Динамики по умолчанию: $($other.FullName)"
    } else {
      Warn 'Кроме VB-CABLE, устройств вывода звука нет — Zoom может выводить звук участников в «CABLE Input»,'
      Warn 'и он вернётся в эфир эхом. Если участники слышат эхо, в Zoom → Звук выберите другой динамик.'
    }
  } catch { Warn "Не удалось выбрать динамики по умолчанию: $($_.Exception.Message)" }
}

# ---------- 5в. Политики Zoom (настройки клиента) ----------
Say 'Настройки клиента Zoom (политики)'
# Имена параметров — из документации Zoom по массовому развёртыванию (Mass deployment / ADMX);
# параметры, которых конкретная версия Zoom не знает, она просто игнорирует.
# Заданные политикой настройки в Zoom становятся недоступны для изменения вручную.
$zoomPol = 'HKLM:\SOFTWARE\Policies\Zoom\Zoom Meetings\General'
$zoomVals = [ordered]@{
  AutoJoinVoIP                      = 1  # автоматически подключать звук компьютера
  MuteVoipWhenJoin                  = 0  # не выключать микрофон при входе
  TurnOffVideoCameraOnJoin          = 0  # видео при входе включено
  AlwaysShowVideoPreviewDialog      = 0  # без окна предпросмотра видео
  SetUseSystemDefaultMicForVoip     = 1  # микрофон «как в системе» = CABLE Output
  SetUseSystemDefaultSpeakerForVoip = 1  # динамики «как в системе»
  EnableClientAutoUpdate            = 0  # без предложений обновиться посреди вебинара
}
try {
  New-Item -Path $zoomPol -Force | Out-Null
  foreach ($k in $zoomVals.Keys) { New-ItemProperty -Path $zoomPol -Name $k -PropertyType DWord -Value $zoomVals[$k] -Force | Out-Null }
  Ok "Записано: $zoomPol"
  Add-Auto $true 'Zoom: звук компьютера при входе, микрофон включён, видео включено, без предпросмотра, системные микрофон/динамики, без автообновления'
} catch {
  Warn "Не удалось записать политики Zoom: $($_.Exception.Message)"
  Add-Auto $false 'Zoom: настройки клиента (политики)'
}

# ---------- 6. Настройки zoom-runner ----------
Say 'Настройки zoom-runner'
$rc = [ordered]@{
  server      = "http://127.0.0.1:$AppPort"
  tokenFile   = $TokenFile
  obsUrl      = "ws://127.0.0.1:$ObsPort"
  obsPassword = $ObsPassword
  obsExe      = $ObsExe
  zoomExe     = $ZoomExe
  leaveOnEnd  = $true
  sceneName   = 'Автовебинар'
  inputName   = 'Запись'
}
Write-TextFile $RunnerCfg ($rc | ConvertTo-Json) $Utf8NoBom
# в файле пароль OBS — читать могут только администраторы, SYSTEM и этот пользователь
$eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try { & icacls.exe $RunnerCfg /inheritance:r /grant:r '*S-1-5-32-544:(F)' '*S-1-5-18:(F)' "${CurrentUser}:(R)" 2>&1 | Out-Null } finally { $ErrorActionPreference = $eap }
Ok "Записано: $RunnerCfg"
if (Test-Path $TokenFile) {
  Write-Host "Токен доступа: $TokenFile"
} else {
  Warn "Нет файла $TokenFile — его создаёт приложение при запуске."
  Warn 'Выполните «video restart» (или «video update», если приложение старое) — zoom-runner подхватит токен сам.'
}

# ---------- 7. Автозапуск zoom-runner в сессии пользователя ----------
Say "Задача $TaskName (автозапуск при входе $CurrentUser)"
$wrapper = @'
# Надзиратель для conference-zoom-runner (создан zoom-setup.ps1, при повторном запуске перезаписывается).
# Работает в сессии пользователя: запускает zoom-runner, пишет вывод в logs\zoom-runner.log и перезапускает при выходе.
$ErrorActionPreference = 'Continue'
$Root    = 'C:\conference'
$NodeExe = '__NODE__'
$Dir     = Join-Path $Root 'app\zoom-runner'
$Script  = Join-Path $Dir 'runner.js'
$Config  = Join-Path $Root 'zoom-runner.json'
$LogDir  = Join-Path $Root 'logs'
$Log     = Join-Path $LogDir 'zoom-runner.log'
$OldLog  = Join-Path $LogDir 'zoom-runner.1.log'
$MaxBytes = 20MB
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$script:writer = $null
function Open-Log {
  $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
  $fs = New-Object IO.FileStream($Log, [IO.FileMode]::Append, [IO.FileAccess]::Write, $share)
  $script:writer = New-Object IO.StreamWriter($fs, (New-Object Text.UTF8Encoding $false))
  $script:writer.AutoFlush = $true
}
function Close-Log { if ($script:writer) { $script:writer.Dispose(); $script:writer = $null } }
function Write-Log([string]$Line) {
  try { $script:writer.WriteLine((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Line) } catch {}
}
function Rotate-Log {
  try {
    if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt $MaxBytes)) {
      Close-Log
      try {
        if (Test-Path $OldLog) { Remove-Item -Force $OldLog }
        [IO.File]::Move($Log, $OldLog)
      } catch {}
      Open-Log
    }
  } catch {}
}

Open-Log
Write-Log "=== надзиратель zoom-runner запущен (PID $PID, пользователь $env:USERDOMAIN\$env:USERNAME, сессия $((Get-Process -Id $PID).SessionId)) ==="
while ($true) {
  Rotate-Log
  if (-not (Test-Path $NodeExe)) {
    $n = Get-ChildItem -Path (Join-Path $Root 'bin') -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($n) { $NodeExe = $n.FullName }
  }
  if (-not (Test-Path $NodeExe) -or -not (Test-Path $Script) -or -not (Test-Path $Config)) {
    Write-Log "нет $NodeExe, $Script или $Config — жду 30 с (video update / zoom-setup.ps1)"
    Start-Sleep -Seconds 30
    continue
  }
  $env:PATH = (Split-Path $NodeExe) + ';' + (Join-Path $Root 'bin') + ';' + [Environment]::GetEnvironmentVariable('PATH', 'Machine')
  Set-Location $Dir
  Write-Log "запуск: $NodeExe $Script $Config"
  $script:n = 0
  & $NodeExe $Script $Config 2>&1 | ForEach-Object {
    Write-Log ([string]$_)
    $script:n++
    if (($script:n % 500) -eq 0) { Rotate-Log }
  }
  $code = $LASTEXITCODE
  Write-Log "zoom-runner завершился, код $code; перезапуск через 5 с"
  Start-Sleep -Seconds 5
}
'@
Write-TextFile $RunnerPs1 ($wrapper -replace '__NODE__', $NodeExe) $Utf8Bom

# останавливаем прежний экземпляр, если он есть
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and (($_.CommandLine -like '*run-zoom-runner.ps1*') -or ($_.Name -ieq 'node.exe' -and $_.CommandLine -like '*zoom-runner*runner.js*')) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$RunnerPs1`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -Priority 4
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal `
  -Settings $settings -Description "Видеовстречи: zoom-runner (OBS + Zoom) в сессии $CurrentUser" -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5
$t = Get-ScheduledTask -TaskName $TaskName
if ([string]$t.State -eq 'Running') { Ok "Задача $TaskName запущена. Лог: $RunnerLog (video zoom logs)" }
else { Warn "Задача $TaskName в состоянии $($t.State) — смотрите $RunnerLog (video zoom status)" }

# ---------- 8. Не терять сессию при отключении от RDP ----------
Say 'Ярлык «Отключиться, оставив Zoom работать»'
$src = $null
$cands = @((Join-Path $AppDir 'deploy\windows\rdp-disconnect.cmd'))
if ($PSScriptRoot) { $cands = @((Join-Path $PSScriptRoot 'rdp-disconnect.cmd')) + $cands }
foreach ($c in $cands) {
  if ($c -and (Test-Path -LiteralPath $c)) { $src = $c; break }
}
if ($src) {
  if ((Resolve-Path $src).Path -ne $DisconnectCmd) { Copy-Item -Force $src $DisconnectCmd }
} else {
  if (-not (Get-File "$RawBase/rdp-disconnect.cmd" $DisconnectCmd)) { Warn 'Не удалось получить rdp-disconnect.cmd — ярлык не создан.' }
}
if (Test-Path $DisconnectCmd) {
  try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $wsh = New-Object -ComObject WScript.Shell
    $lnk = $wsh.CreateShortcut((Join-Path $desktop "$ShortcutName.lnk"))
    $lnk.TargetPath = $DisconnectCmd
    $lnk.WorkingDirectory = $Root
    $lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,27"
    $lnk.Description = 'Отключиться от RDP, не блокируя сессию: Zoom и OBS продолжат показывать видео'
    $lnk.Save()
    Ok "Ярлык на рабочем столе: «$ShortcutName»"
  } catch { Warn "Не удалось создать ярлык: $($_.Exception.Message). Запускайте $DisconnectCmd вручную." }
}

Say 'Отключаю сон и гашение экрана'
$eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try {
  & powercfg.exe /change monitor-timeout-ac 0 2>&1 | Out-Null
  & powercfg.exe /change standby-timeout-ac 0 2>&1 | Out-Null
} finally { $ErrorActionPreference = $eap }
try {
  # заставка с блокировкой экрана тоже останавливает видео
  Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name 'ScreenSaveActive' -Value '0'
  Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name 'ScreenSaverIsSecure' -Value '0'
} catch {}
Ok 'Готово (если заставку включает групповая политика домена — её нужно отключить там).'

# ---------- 9. Итог и ручные шаги ----------
Write-Host ''
Write-Host '==================================================================' -ForegroundColor Green
Write-Host ' Zoom-автовебинар: автоматическая часть готова' -ForegroundColor Green
Write-Host '==================================================================' -ForegroundColor Green
Write-Host "  Zoom:        $(if ($ZoomExe) { $ZoomExe } else { 'НЕ установлен' })"
Write-Host "  OBS Studio:  $(if ($ObsExe) { $ObsExe } else { 'НЕ установлен' })"
Write-Host "  VB-CABLE:    $(if (Test-VbCable) { 'установлен' } else { 'НЕ виден (нужна установка/перезагрузка)' })"
Write-Host "  Настройки:   $RunnerCfg"
Write-Host "  Лог:         $RunnerLog"
Write-Host "  Команды:     video zoom status | video zoom logs | video zoom restart"
if ($NeedReboot) { Warn '  Нужна перезагрузка сервера, затем повторный запуск этого скрипта.' }
Write-Host ''
Write-Host 'Сделано автоматически:' -ForegroundColor Cyan
foreach ($r in $script:AutoResults) {
  if ($r.StartsWith('✅')) { Write-Host "  $r" -ForegroundColor Green } else { Write-Host "  $r" -ForegroundColor Yellow }
}
Write-Host '  ✅ Камера: на сервере нет других камер, Zoom сам выберет «OBS Virtual Camera»'
Write-Host '  (если какие-то пункты не удались — перезагрузите сервер и запустите этот скрипт ещё раз)'
Write-Host ''
Write-Host 'Осталось сделать вручную (один раз):' -ForegroundColor Cyan
Write-Host @'
  1. Откройте Zoom, войдите под учётной записью организатора встреч (хоста).
     В профиле задайте имя, которое увидят участники (например, «HR»).
  2. На сайте zoom.us → Настройки (или в настройках конкретной встречи):
       • Зал ожидания — ВЫКЛ;
       • «Разрешить участникам входить раньше организатора» — ВКЛ
         (или следите, чтобы организатор, т.е. этот сервер, входил первым);
       • «Выключать звук участников при входе» — ВКЛ.
  3. В программе «Подключение к удалённому рабочему столу» → Показать параметры →
     Локальные ресурсы → Удалённый звук → Параметры → «Оставить на удалённом компьютере»
     (иначе устройства VB-CABLE в RDP-сессии могут быть не видны).

Каждый раз:
  • В админке сервиса для встречи укажите ссылку Zoom (карточка «Zoom» на пульте).
  • Отключайтесь от сервера ТОЛЬКО ярлыком «Отключиться, оставив Zoom работать».
    Если закрыть окно RDP крестиком, сессия блокируется, и Zoom/OBS могут перестать
    передавать видео. Ярлык переводит сессию на «консоль» — она остаётся открытой.

Если не работает — проверьте:
  • Zoom → Настройки → Видео: камера «OBS Virtual Camera».
  • Zoom → Настройки → Звук: микрофон «CABLE Output (VB-Audio Virtual Cable)»
    (или «Как в системе»); по желанию: «Оригинальный звук для музыкантов», шумоподавление «Низкое».
  • OBS → Настройки → Аудио → Расширенные → Устройство мониторинга — «CABLE Input (VB-Audio Virtual Cable)».
  • Состояние и лог: video zoom status.

Важно:
  • Бесплатный Zoom завершает конференции через 40 минут — для длинных вебинаров нужна
    платная лицензия у учётной записи организатора.
  • После перезагрузки сервера zoom-runner запустится, только когда пользователь войдёт
    в систему. Чтобы вход происходил сам, можно (по желанию) включить автовход программой
    Sysinternals Autologon: https://learn.microsoft.com/sysinternals/downloads/autologon
    (пароль хранится в зашифрованном виде; скрипт это НЕ включает автоматически).
'@
if (-not (Test-Path $TokenFile)) { Warn "Не забудьте: «video restart», чтобы приложение создало $TokenFile." }
