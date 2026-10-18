<#
  Установка / обновление сервиса видеовстреч на Windows Server.

  Ставит в C:\conference (без Docker и платных программ):
    • Node.js 22 (портативный), ffmpeg, Caddy (HTTPS), LiveKit (медиасервер);
    • код приложения из GitHub и его зависимости (npm ci);
    • три задачи Планировщика (conference-app, conference-livekit, conference-caddy):
      запускаются при загрузке Windows и перезапускаются при падении;
    • правила брандмауэра Windows;
    • команду «video» (video update, video check, video logs ...).
  Повторный запуск обновляет код и программы, сохраняя настройки (config.json) и данные (data\).

  Запуск (PowerShell от имени администратора):
    powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/konstahasan-cyber/conference-/claude/video-conference-recording-service-4y8f5m/deploy/windows/install.ps1 -OutFile $env:TEMP\install.ps1; & $env:TEMP\install.ps1"
  или двойной щелчок по install.cmd рядом с этим файлом.

  Параметры (необязательно):
    -Domain meet.example.ru     сменить/задать домен
    -AdminPassword secret       задать пароль админки
    -UpdateTools                заново скачать Node.js, ffmpeg, Caddy и LiveKit
    -Local                      локальный режим (только Zoom-автовебинар): без сайта, HTTPS и LiveKit —
                                админ-панель открывается только на этом компьютере (http://127.0.0.1:порт/admin).
                                Уже установленный сайт (с доменом) этот ключ не трогает.
    -Full                       перевести локальную установку в полноценный сайт (спросит домен)
#>
[CmdletBinding()]
param(
  [string]$Domain = $env:DOMAIN,
  [string]$AdminPassword = $env:ADMIN_PASSWORD,
  [switch]$UpdateTools,
  [switch]$Local,
  [switch]$Full
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # без этого Invoke-WebRequest качает в десятки раз медленнее
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}

$Root      = 'C:\conference'
$Bin       = Join-Path $Root 'bin'
$NodeDir   = Join-Path $Bin 'node'
$AppDir    = Join-Path $Root 'app'
$DataDir   = Join-Path $Root 'data'
$LogDir    = Join-Path $Root 'logs'
$TmpDir    = Join-Path $Root 'tmp'
$CfgPath   = Join-Path $Root 'config.json'
$Caddyfile = Join-Path $Root 'Caddyfile'
$LkYaml    = Join-Path $Root 'livekit.yaml'
$Branch    = 'claude/video-conference-recording-service-4y8f5m'
$CodeZipUrl = "https://github.com/konstahasan-cyber/conference-/archive/refs/heads/$Branch.zip"
$LiveKitPort = 7880
$Services  = @('livekit', 'app', 'caddy')
$Utf8NoBom = New-Object Text.UTF8Encoding $false
$Utf8Bom   = New-Object Text.UTF8Encoding $true

function Say([string]$m)  { Write-Host ''; Write-Host "==> $m" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Ok([string]$m)   { Write-Host $m -ForegroundColor Green }
function Die([string]$m)  { Write-Host ''; Write-Host "Ошибка: $m" -ForegroundColor Red; exit 1 }

# ---------- Права администратора ----------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  if ($PSCommandPath) {
    Warn 'Нужны права администратора — открываю окно PowerShell от имени администратора...'
    $a = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`""
    if ($Domain) { $a += " -Domain `"$Domain`"" }
    if ($UpdateTools) { $a += ' -UpdateTools' }
    if ($Local) { $a += ' -Local' }
    if ($Full) { $a += ' -Full' }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $a
    exit
  }
  Die 'запустите PowerShell от имени администратора (правый щелчок → «Запуск от имени администратора») и повторите команду.'
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

function Get-TcpListeners([int[]]$Ports) {
  @(Get-NetTCPConnection -State Listen -LocalPort $Ports -ErrorAction SilentlyContinue)
}
function Get-UdpListeners([int[]]$Ports) {
  @(Get-NetUDPEndpoint -LocalPort $Ports -ErrorAction SilentlyContinue)
}
function Test-TcpPortBusy([int]$Port) { (Get-TcpListeners @($Port)).Count -gt 0 }

function Get-ProcDescription([int]$ProcId) {
  if ($ProcId -eq 4) {
    return 'System (PID 4) — это HTTP.sys: обычно IIS (служба W3SVC/WAS), WinRM по HTTP(S), SSRS, WSUS или другая служба Windows. Посмотреть, кто именно: netsh http show servicestate'
  }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction SilentlyContinue
  if ($p) {
    $path = $p.ExecutablePath
    if (-not $path) { $path = 'путь недоступен' }
    return "$($p.Name) (PID $ProcId, $path)"
  }
  return "PID $ProcId"
}

function Get-ServiceExe([string]$Name) {
  switch ($Name) {
    'app'     { return (Join-Path $NodeDir 'node.exe') }
    'livekit' { return (Join-Path $Bin 'livekit-server.exe') }
    'caddy'   { return (Join-Path $Bin 'caddy.exe') }
  }
}

function Get-OurProcesses([string]$Exe) {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $Exe) })
}

# Останавливает задачу, её скрипт-надзиратель и сам процесс (node/livekit/caddy).
function Stop-ConfService([string]$Name) {
  $task = "conference-$Name"
  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*run-$Name.ps1*") } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $exe = Get-ServiceExe $Name
  for ($i = 0; $i -lt 15; $i++) {
    $procs = Get-OurProcesses $exe
    if ($procs.Count -eq 0) { return }
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
  }
  Warn "Не удалось остановить $exe"
}

function Start-ConfService([string]$Name) {
  Start-ScheduledTask -TaskName "conference-$Name"
}

function Get-File([string]$Url, [string]$OutFile) {
  for ($i = 1; $i -le 3; $i++) {
    try {
      if (Test-Path $OutFile) { Remove-Item -Force $OutFile }
      Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
      if ((Test-Path $OutFile) -and ((Get-Item $OutFile).Length -gt 0)) { return }
    } catch {
      Warn "Попытка $i из 3 не удалась: $($_.Exception.Message)"
      Start-Sleep -Seconds 3
    }
  }
  Die "не удалось скачать $Url"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
function Expand-Zip([string]$Zip, [string]$Dest) {
  Remove-Dir $Dest
  [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Dest)
}

# rd /s /q надёжнее Remove-Item для глубоких папок node_modules
function Remove-Dir([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    cmd.exe /c "rd /s /q `"$Path`" >nul 2>nul" | Out-Null
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

# Запуск внешней программы: показываем её вывод, при ненулевом коде — ошибка.
function Invoke-Native([string]$What, [scriptblock]$Block) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block 2>&1 | ForEach-Object { Write-Host "   $_" } } finally { $ErrorActionPreference = $old }
  if ($LASTEXITCODE -ne 0) { Die "$What (код выхода $LASTEXITCODE)" }
}

# GitHub пишет хеш коммита в комментарий zip-архива — так узнаём версию без git.
function Get-ZipCommit([string]$Zip) {
  try {
    $fs = [IO.File]::OpenRead($Zip)
    try {
      $len = [int][Math]::Min($fs.Length, 70000)
      [void]$fs.Seek(-$len, [IO.SeekOrigin]::End)
      $buf = New-Object byte[] $len
      [void]$fs.Read($buf, 0, $len)
    } finally { $fs.Dispose() }
    for ($i = $len - 22; $i -ge 0; $i--) {
      if ($buf[$i] -eq 0x50 -and $buf[$i + 1] -eq 0x4b -and $buf[$i + 2] -eq 0x05 -and $buf[$i + 3] -eq 0x06) {
        $clen = $buf[$i + 20] + 256 * $buf[$i + 21]
        if ($clen -le 0 -or ($i + 22 + $clen) -gt $len) { return '' }
        $c = [Text.Encoding]::ASCII.GetString($buf, $i + 22, $clen).Trim()
        if ($c -match '^[0-9a-f]{40}$') { return $c.Substring(0, 7) }
        return ''
      }
    }
  } catch {}
  return ''
}

function Test-Url([string]$Url, [string]$Expect) {
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
    if ($Expect) { return ([string]$r.Content -like "*$Expect*") }
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}
function Wait-Url([string]$Url, [int]$Seconds, [string]$Expect) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    if (Test-Url $Url $Expect) { return $true }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Save-Config($Cfg) {
  Write-TextFile $CfgPath ($Cfg | ConvertTo-Json) $Utf8NoBom
  # в файле пароль и ключи — читать могут только администраторы и SYSTEM
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & icacls.exe $CfgPath /inheritance:r /grant:r '*S-1-5-32-544:(F)' '*S-1-5-18:(F)' 2>&1 | Out-Null } finally { $ErrorActionPreference = $old }
}

# ---------- Подготовка ----------
foreach ($d in @($Root, $Bin, $DataDir, $LogDir, $TmpDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# ---------- Сохранённые настройки ----------
$cfg = $null
$FirstInstall = $true
if (Test-Path $CfgPath) {
  try { $cfg = Get-Content -Raw -Encoding UTF8 $CfgPath | ConvertFrom-Json; $FirstInstall = $false } catch { Warn "Не удалось прочитать $CfgPath — настрою заново." }
}
if (-not $cfg) { $cfg = New-Object PSObject }
function Get-Cfg([string]$k) { $p = $cfg.PSObject.Properties[$k]; if ($p) { return $p.Value } return $null }
function Set-Cfg([string]$k, $v) {
  if ($cfg.PSObject.Properties[$k]) { $cfg.$k = $v } else { $cfg | Add-Member -NotePropertyName $k -NotePropertyValue $v }
}
if (-not $FirstInstall) { Write-Host "Найдены прежние настройки: $CfgPath — использую их." }

# ---------- Режим: full (сайт с HTTPS и LiveKit) или local (только админка на этом компьютере + Zoom) ----------
$PrevMode = [string](Get-Cfg 'mode')
$PrevDomain = [string](Get-Cfg 'domain')
if ($Full) {
  $Mode = 'full'
} elseif ($PrevMode -eq 'local') {
  $Mode = 'local'
} elseif ($Local) {
  if ($FirstInstall -or -not $PrevDomain) {
    $Mode = 'local'
  } else {
    $Mode = 'full'
    Warn "Уже установлен сайт https://$PrevDomain — оставляю его как есть (ключ -Local не применяется к существующему сайту)."
  }
} else {
  $Mode = 'full'
}
$IsLocal = ($Mode -eq 'local')
if ($IsLocal) {
  $Services = @('app')
  if ($Domain) { Warn 'Ключ -Domain в локальном режиме не используется (сделать сайт: install.ps1 -Full).' }
  Write-Host 'Режим: локальный (админ-панель только на этом компьютере, без сайта в интернете).'
} else {
  if ($PrevMode -eq 'local') { Write-Host 'Перевожу локальную установку в полноценный сайт (HTTPS, LiveKit).' }
  Write-Host 'Режим: сайт (HTTPS, LiveKit).'
}

# ---------- Останавливаем свои службы (чтобы не мешали проверке портов и обновлению файлов) ----------
Say 'Останавливаю прежнюю версию (если есть)'
if ($IsLocal) { $StopList = @('app') } else { $StopList = @('caddy', 'app', 'livekit') }
foreach ($s in $StopList) { Stop-ConfService $s }

if (-not $IsLocal) {
  Say 'Определяю внешний IP'
  $PublicIp = ''
  foreach ($u in @('https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com')) {
    try { $PublicIp = ([string](Invoke-RestMethod -Uri $u -UseBasicParsing -TimeoutSec 10)).Trim() } catch {}
    if ($PublicIp -match '^\d+\.\d+\.\d+\.\d+$') { break } else { $PublicIp = '' }
  }
  if (-not $PublicIp) { Die 'не удалось определить внешний IP сервера (нет доступа в интернет?)' }
  Write-Host "IP: $PublicIp"

  # ---------- Порты 80/443 должны быть свободны ----------
  Say 'Проверяю порты'
  $busy = Get-TcpListeners @(80, 443)
  if ($busy.Count -gt 0) {
    Write-Host ''
    Write-Host 'Порты 80/443 заняты другой программой:' -ForegroundColor Red
    foreach ($l in ($busy | Sort-Object LocalPort, OwningProcess -Unique)) {
      Write-Host ("  порт {0}: {1}" -f $l.LocalPort, (Get-ProcDescription $l.OwningProcess)) -ForegroundColor Red
    }
    Write-Host ''
    Write-Host 'Сервису видеовстреч нужны порты 80 и 443 для HTTPS (сертификат Let''s Encrypt).'
    Write-Host 'Я ничего не останавливаю сам. Освободите порты (например, отключите сайт по умолчанию в IIS:'
    Write-Host '  Stop-Service W3SVC; Set-Service W3SVC -StartupType Disabled' -ForegroundColor Yellow
    Write-Host 'если IIS не нужен) и запустите установку снова.'
    exit 1
  }
  foreach ($pp in @($LiveKitPort, 7881)) {
    $l = Get-TcpListeners @($pp)
    if ($l.Count -gt 0) { Die ("порт {0}/TCP нужен LiveKit, но занят: {1}" -f $pp, (Get-ProcDescription $l[0].OwningProcess)) }
  }
  $l = Get-UdpListeners @(3478)
  if ($l.Count -gt 0) { Die ("порт 3478/UDP нужен LiveKit (TURN), но занят: {0}" -f (Get-ProcDescription $l[0].OwningProcess)) }
  Ok 'Порты 80, 443, 7880, 7881, 3478 свободны.'

  # ---------- Домен ----------
  if (-not $Domain) { $Domain = Get-Cfg 'domain' }
  if (-not $Domain) {
    $DefaultDomain = ($PublicIp -replace '\.', '-') + '.sslip.io'
    Write-Host ''
    Write-Host "Укажите домен или поддомен, направленный (A-запись) на IP $PublicIp, например meet.mysite.ru"
    Write-Host "Если домена нет — нажмите Enter, будет бесплатный адрес $DefaultDomain"
    Write-Host '(свой домен лучше: адреса *.sslip.io иногда блокируют антивирусы и корпоративные сети)' -ForegroundColor DarkGray
    $Domain = (Read-Host 'Домен').Trim()
    if (-not $Domain) { $Domain = $DefaultDomain }
  }
  $Domain = ($Domain.Trim() -replace '^https?://', '' -replace '/.*$', '').ToLower()
  if ($Domain -notmatch '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$') { Die "неверный домен: $Domain" }
  Write-Host "Домен: $Domain"
  try {
    $ips = @(Resolve-DnsName -Name $Domain -Type A -DnsOnly -ErrorAction Stop | Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress })
    if ($ips -notcontains $PublicIp) {
      Warn "Внимание: $Domain указывает на $($ips -join ', '), а IP этого сервера $PublicIp. HTTPS-сертификат не выпустится, пока A-запись не исправлена."
    }
  } catch {
    Warn "Внимание: домен $Domain пока не находится в DNS. Проверьте A-запись на $PublicIp."
  }
}

# ---------- Пароль админки ----------
$PwRegex = '^[A-Za-z0-9_.,@%+=:!?-]+$'
$PwHint = 'в пароле можно использовать только латиницу, цифры и символы _ . , @ % + = : ! ? -'
$GeneratedPassword = $false
if (-not $AdminPassword) { $AdminPassword = Get-Cfg 'adminPassword' }
if ($AdminPassword) {
  if ($AdminPassword -notmatch $PwRegex) { Die $PwHint }
} else {
  while ($true) {
    Write-Host ''
    $ss = Read-Host 'Пароль для админ-панели (Enter — сгенерировать)' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
    try { $AdminPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if (-not $AdminPassword) { $AdminPassword = New-RandomString 14; $GeneratedPassword = $true; break }
    if ($AdminPassword -match $PwRegex) { break }
    Warn $PwHint
  }
}

# ---------- Ключи LiveKit и порт приложения ----------
$LkKey = Get-Cfg 'livekitKey'
$LkSecret = Get-Cfg 'livekitSecret'
if (-not $LkKey) { $LkKey = 'API' + (New-RandomString 12) }
if (-not $LkSecret) { $LkSecret = New-RandomString 40 }

# наше приложение уже остановлено, так что занятый порт — чужая программа: берём следующий
$Port = Get-Cfg 'port'
if (-not $Port -or (Test-TcpPortBusy ([int]$Port))) {
  $Port = 3000
  while ((Test-TcpPortBusy $Port) -or $Port -eq $LiveKitPort -or $Port -eq 7881) { $Port++ }
}
$Port = [int]$Port
if ($IsLocal) {
  Write-Host "Порт приложения: $Port (только для этого компьютера)"
  $AdminUrl = "http://127.0.0.1:$Port/admin"
} else {
  Write-Host "Порт приложения: $Port (только для этого компьютера, снаружи — через Caddy)"
  $AdminUrl = "https://$Domain/admin"
}

Set-Cfg 'mode' $Mode
if (-not $IsLocal) {
  Set-Cfg 'domain' $Domain
  Set-Cfg 'publicIp' $PublicIp
}
Set-Cfg 'adminUrl' $AdminUrl
Set-Cfg 'adminPassword' $AdminPassword
Set-Cfg 'port' $Port
Set-Cfg 'livekitPort' $LiveKitPort
Set-Cfg 'livekitKey' $LkKey
Set-Cfg 'livekitSecret' $LkSecret
Set-Cfg 'branch' $Branch
Save-Config $cfg
Ok "Настройки сохранены: $CfgPath"

# ---------- Программы ----------
Say 'Node.js 22'
$NodeExe = Join-Path $NodeDir 'node.exe'
$haveNode = ''
if (Test-Path $NodeExe) { try { $haveNode = (& $NodeExe -v) } catch {} }
if ($haveNode -like 'v22.*' -and -not $UpdateTools) {
  Write-Host "Уже установлен: $haveNode"
} else {
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $rel = $index | Where-Object { $_.version -like 'v22.*' -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
  if (-not $rel) { Die 'не нашёл Node.js 22 для Windows на nodejs.org/dist' }
  $v = $rel.version
  if ($haveNode -eq $v) {
    Write-Host "Уже последняя версия: $v"
  } else {
    Write-Host "Скачиваю Node.js $v"
    $zip = Join-Path $TmpDir 'node.zip'
    Get-File "https://nodejs.org/dist/$v/node-$v-win-x64.zip" $zip
    $ex = Join-Path $TmpDir 'node'
    Expand-Zip $zip $ex
    $inner = Get-ChildItem $ex -Directory | Select-Object -First 1
    Remove-Dir $NodeDir
    Move-Item $inner.FullName $NodeDir
    Remove-Dir $ex; Remove-Item -Force $zip
    Ok "Node.js $(& $NodeExe -v)"
  }
}

Say 'ffmpeg'
if ((Test-Path (Join-Path $Bin 'ffmpeg.exe')) -and (Test-Path (Join-Path $Bin 'ffprobe.exe')) -and -not $UpdateTools) {
  Write-Host 'Уже установлен.'
} else {
  $zip = Join-Path $TmpDir 'ffmpeg.zip'
  Get-File 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $zip
  $ex = Join-Path $TmpDir 'ffmpeg'
  Expand-Zip $zip $ex
  foreach ($n in @('ffmpeg.exe', 'ffprobe.exe')) {
    $f = Get-ChildItem $ex -Recurse -Filter $n | Select-Object -First 1
    if (-not $f) { Die "в архиве ffmpeg нет $n" }
    Copy-Item -Force $f.FullName (Join-Path $Bin $n)
  }
  Remove-Dir $ex; Remove-Item -Force $zip
  Ok 'ffmpeg установлен.'
}

if ($IsLocal) {
  Write-Host ''
  Write-Host 'Caddy и LiveKit в локальном режиме не нужны — пропускаю.'
} else {
  Say 'Caddy (HTTPS)'
  $CaddyExe = Join-Path $Bin 'caddy.exe'
  if ((Test-Path $CaddyExe) -and -not $UpdateTools) {
    Write-Host 'Уже установлен.'
  } else {
    $tmpExe = Join-Path $TmpDir 'caddy.exe'
    Get-File 'https://caddyserver.com/api/download?os=windows&arch=amd64' $tmpExe
    Move-Item -Force $tmpExe $CaddyExe
    Ok 'Caddy установлен.'
  }

  Say 'LiveKit (медиасервер)'
  $LkExe = Join-Path $Bin 'livekit-server.exe'
  if ((Test-Path $LkExe) -and -not $UpdateTools) {
    Write-Host 'Уже установлен.'
  } else {
    $LkReleases = 'https://github.com/livekit/livekit/releases'
    try {
      $relInfo = Invoke-RestMethod -Uri 'https://api.github.com/repos/livekit/livekit/releases/latest' -UseBasicParsing -Headers @{ 'User-Agent' = 'conference-installer' }
    } catch {
      Die "не удалось узнать последнюю версию LiveKit ($($_.Exception.Message)). Скачайте вручную файл livekit_..._windows_amd64.zip со страницы $LkReleases и положите livekit-server.exe в $Bin, затем запустите установку снова."
    }
    $asset = $relInfo.assets | Where-Object { $_.name -like '*windows_amd64.zip' } | Select-Object -First 1
    if (-not $asset) {
      Die "в выпуске LiveKit $($relInfo.tag_name) нет сборки для Windows (windows_amd64.zip). Скачайте её вручную со страницы $LkReleases и положите livekit-server.exe в $Bin, затем запустите установку снова."
    }
    Write-Host "Скачиваю LiveKit $($relInfo.tag_name)"
    $zip = Join-Path $TmpDir 'livekit.zip'
    Get-File $asset.browser_download_url $zip
    $ex = Join-Path $TmpDir 'livekit'
    Expand-Zip $zip $ex
    $f = Get-ChildItem $ex -Recurse -Filter 'livekit-server.exe' | Select-Object -First 1
    if (-not $f) { Die "в архиве $($asset.name) нет livekit-server.exe" }
    Copy-Item -Force $f.FullName $LkExe
    Remove-Dir $ex; Remove-Item -Force $zip
    Ok 'LiveKit установлен.'
  }
}

# ---------- Код приложения ----------
$env:PATH = "$NodeDir;$Bin;" + $env:PATH
Say "Загружаю приложение в $AppDir"
$zip = Join-Path $TmpDir 'app.zip'
Get-File $CodeZipUrl $zip
$Commit = Get-ZipCommit $zip
$ex = Join-Path $TmpDir 'app-src'
Expand-Zip $zip $ex
$inner = Get-ChildItem $ex -Directory | Select-Object -First 1
if (-not $inner -or -not (Test-Path (Join-Path $inner.FullName 'server.js'))) { Die 'в архиве приложения нет server.js' }
$NewDir = Join-Path $Root 'app.new'
Remove-Dir $NewDir
Move-Item $inner.FullName $NewDir
Remove-Dir $ex; Remove-Item -Force $zip

Say 'Устанавливаю зависимости (npm ci)'
Push-Location $NewDir
try {
  Invoke-Native 'npm ci не удался' { & (Join-Path $NodeDir 'npm.cmd') ci --omit=dev --no-audit --no-fund --loglevel=error }
} finally { Pop-Location }
if ($Commit) { Write-TextFile (Join-Path $NewDir '.commit') $Commit }

# меняем код целиком; данные лежат отдельно в $DataDir и не трогаются
if (Test-Path $AppDir) {
  $OldDir = Join-Path $Root ('app.old-' + (Get-Date -Format 'yyyyMMddHHmmss'))
  Move-Item $AppDir $OldDir
  Move-Item $NewDir $AppDir
  Remove-Dir $OldDir
} else {
  Move-Item $NewDir $AppDir
}
Get-ChildItem $Root -Directory -Filter 'app.old-*' | ForEach-Object { Remove-Dir $_.FullName }
if ($Commit) { Ok "Версия приложения: $Commit" } else { Ok 'Приложение загружено.' }

# ---------- Команда video ----------
$videoSrc = Join-Path $AppDir 'deploy\windows\video.ps1'
if (-not (Test-Path $videoSrc) -and $PSScriptRoot) { $videoSrc = Join-Path $PSScriptRoot 'video.ps1' }
if (Test-Path $videoSrc) {
  Copy-Item -Force $videoSrc (Join-Path $Root 'video.ps1')
  Write-TextFile (Join-Path $env:SystemRoot 'video.cmd') "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Root\video.ps1`" %*`r`n" (New-Object Text.ASCIIEncoding)
} else {
  Warn 'Не нашёл video.ps1 — команда video не установлена.'
}

# ---------- Конфиги LiveKit и Caddy ----------
if (-not $IsLocal) {
  Say 'Пишу конфиги LiveKit и Caddy'
  $lk = @"
# Сгенерировано install.ps1 — при повторной установке файл перезаписывается.
port: $LiveKitPort
bind_addresses: ["0.0.0.0"]
rtc:
  # медиатрафик участников: TCP 7881 (запасной путь) и UDP 50000-50200
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50200
  # внешний IP определяется автоматически через STUN
  use_external_ip: true
turn:
  # встроенный TURN только по UDP 3478 — помогает участникам за строгим NAT.
  # TURN/TLS выключен: порт 443 занят Caddy (HTTPS сайта), делить его нельзя.
  enabled: true
  domain: $Domain
  udp_port: 3478
keys:
  ${LkKey}: $LkSecret
logging:
  level: info
"@
  Write-TextFile $LkYaml $lk $Utf8NoBom

  $caddy = @"
# Сгенерировано install.ps1 — при повторной установке файл перезаписывается.
# Сертификат Let's Encrypt выпускается автоматически (нужны открытые порты 80 и 443).
$Domain {
	encode gzip
	# сигнальный WebSocket LiveKit
	@livekit path /rtc /rtc/*
	handle @livekit {
		reverse_proxy 127.0.0.1:$LiveKitPort
	}
	handle {
		reverse_proxy 127.0.0.1:$Port
	}
}
"@
  Write-TextFile $Caddyfile $caddy $Utf8NoBom
  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'caddy-data'), (Join-Path $Root 'caddy-config') | Out-Null
  $ErrorActionPreference = 'Continue'
  $v = & $CaddyExe validate --config $Caddyfile --adapter caddyfile 2>&1
  $rc = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($rc -ne 0) { $v | ForEach-Object { Write-Host "   $_" }; Die 'Caddy не принял Caddyfile' }
}

# ---------- Скрипты-надзиратели ----------
Say 'Создаю службы (Планировщик заданий)'
$supervisor = @'
# Надзиратель для conference-__NAME__ (создан install.ps1, при переустановке перезаписывается).
# Запускает программу, пишет её вывод в logs\__NAME__.log и перезапускает при выходе.
$ErrorActionPreference = 'Continue'
$Name    = '__NAME__'
$Root    = 'C:\conference'
$Bin     = Join-Path $Root 'bin'
$NodeDir = Join-Path $Bin 'node'
$LogDir  = Join-Path $Root 'logs'
$Log     = Join-Path $LogDir "$Name.log"
$OldLog  = Join-Path $LogDir "$Name.1.log"
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

function Get-Spec {
  $cfg = Get-Content -Raw -Encoding UTF8 (Join-Path $Root 'config.json') | ConvertFrom-Json
  $env:PATH = "$Bin;$NodeDir;" + [Environment]::GetEnvironmentVariable('PATH', 'Machine')
  switch ($Name) {
    'app' {
      $env:NODE_ENV        = 'production'
      $env:PORT            = [string]$cfg.port
      $env:HOST            = '127.0.0.1'
      $env:DATA_DIR        = Join-Path $Root 'data'
      $env:ADMIN_PASSWORD  = [string]$cfg.adminPassword
      $env:MAX_UPLOAD_MB   = '4096'
      if ([string]$cfg.mode -eq 'local') {
        # локальный режим: нет домена и LiveKit — видеовстречи в браузере выключены, работает админка и Zoom
        foreach ($k in @('PUBLIC_DOMAIN', 'LIVEKIT_URL', 'LIVEKIT_API_URL', 'LIVEKIT_KEY', 'LIVEKIT_SECRET')) {
          Remove-Item "Env:$k" -ErrorAction SilentlyContinue
        }
      } else {
        $env:PUBLIC_DOMAIN   = [string]$cfg.domain
        $env:LIVEKIT_URL     = 'wss://' + $cfg.domain
        $env:LIVEKIT_API_URL = 'http://127.0.0.1:' + $cfg.livekitPort
        $env:LIVEKIT_KEY     = [string]$cfg.livekitKey
        $env:LIVEKIT_SECRET  = [string]$cfg.livekitSecret
      }
      return @{ Exe = (Join-Path $NodeDir 'node.exe'); Args = @('server.js'); Dir = (Join-Path $Root 'app') }
    }
    'livekit' {
      return @{ Exe = (Join-Path $Bin 'livekit-server.exe'); Args = @('--config', (Join-Path $Root 'livekit.yaml')); Dir = $Root }
    }
    'caddy' {
      # сертификаты хранятся в C:\conference\caddy-data и переживают переустановку
      $env:XDG_DATA_HOME   = Join-Path $Root 'caddy-data'
      $env:XDG_CONFIG_HOME = Join-Path $Root 'caddy-config'
      $env:AppData         = Join-Path $Root 'caddy-data'
      return @{ Exe = (Join-Path $Bin 'caddy.exe'); Args = @('run', '--config', (Join-Path $Root 'Caddyfile'), '--adapter', 'caddyfile'); Dir = $Root }
    }
  }
}

Open-Log
Write-Log "=== надзиратель запущен (PID $PID) ==="
while ($true) {
  Rotate-Log
  $spec = $null
  try { $spec = Get-Spec } catch { Write-Log "ошибка настроек: $($_.Exception.Message)" }
  if (-not $spec -or -not (Test-Path $spec.Exe)) {
    if ($spec) { Write-Log "не найден $($spec.Exe)" }
    Start-Sleep -Seconds 10
    continue
  }
  Set-Location $spec.Dir
  Write-Log ("запуск: {0} {1}" -f $spec.Exe, ($spec.Args -join ' '))
  $script:n = 0
  & $spec.Exe @($spec.Args) 2>&1 | ForEach-Object {
    Write-Log ([string]$_)
    $script:n++
    if (($script:n % 500) -eq 0) { Rotate-Log }
  }
  $code = $LASTEXITCODE
  Write-Log "процесс завершился, код $code; перезапуск через 3 с"
  Start-Sleep -Seconds 3
}
'@

$TaskDescr = @{ app = 'Видеовстречи: приложение (Node.js)'; livekit = 'Видеовстречи: медиасервер LiveKit'; caddy = 'Видеовстречи: HTTPS (Caddy)' }
foreach ($s in $Services) {
  $runPath = Join-Path $Root "run-$s.ps1"
  Write-TextFile $runPath ($supervisor -replace '__NAME__', $s) $Utf8Bom
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$runPath`"" -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  try {
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  } catch {
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
  }
  # ExecutionTimeLimit 0 — без ограничения (по умолчанию задачу убивают через 72 часа);
  # Priority 4 — обычный приоритет (по умолчанию у задач пониженный, это плохо для видео)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew -Priority 4
  Register-ScheduledTask -TaskName "conference-$s" -Action $action -Trigger $trigger -Principal $taskPrincipal `
    -Settings $settings -Description $TaskDescr[$s] -Force | Out-Null
  Write-Host "Задача conference-$s"
}

# ---------- Брандмауэр ----------
# в локальном режиме снаружи ничего не открываем: приложение слушает только 127.0.0.1
if (-not $IsLocal) {
  Say 'Настраиваю брандмауэр Windows'
  Get-NetFirewallRule -DisplayName 'Conference*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  $rules = @(
    @{ Name = 'Conference HTTP (TCP 80)';          Proto = 'TCP'; Port = '80' },
    @{ Name = 'Conference HTTPS (TCP 443)';        Proto = 'TCP'; Port = '443' },
    @{ Name = 'Conference HTTP/3 (UDP 443)';       Proto = 'UDP'; Port = '443' },
    @{ Name = 'Conference LiveKit RTC (TCP 7881)'; Proto = 'TCP'; Port = '7881' },
    @{ Name = 'Conference TURN (UDP 3478)';        Proto = 'UDP'; Port = '3478' },
    @{ Name = 'Conference WebRTC (UDP 50000-50200)'; Proto = 'UDP'; Port = '50000-50200' }
  )
  foreach ($r in $rules) {
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow -Protocol $r.Proto -LocalPort $r.Port -Profile Any | Out-Null
    Write-Host "  $($r.Name)"
  }
}

# ---------- Запуск ----------
Say 'Запускаю'
foreach ($s in $Services) { Start-ConfService $s; Start-Sleep -Seconds 1 }

$okApp = Wait-Url "http://127.0.0.1:$Port/api/me" 60 ''
if ($okApp) { Write-Host "✅ Приложение отвечает (127.0.0.1:$Port)" -ForegroundColor Green }
else { Write-Host "❌ Приложение не отвечает на http://127.0.0.1:$Port/api/me — смотрите $LogDir\app.log" -ForegroundColor Red }
$okLk = $true
$okHttps = $true
if (-not $IsLocal) {
  $okLk = Wait-Url "http://127.0.0.1:$LiveKitPort/" 60 'OK'
  if ($okLk) { Write-Host "✅ LiveKit отвечает (127.0.0.1:$LiveKitPort)" -ForegroundColor Green }
  else { Write-Host "❌ LiveKit не отвечает на http://127.0.0.1:$LiveKitPort — смотрите $LogDir\livekit.log" -ForegroundColor Red }
  Write-Host 'Жду HTTPS-сертификат (до минуты)...'
  $okHttps = Wait-Url "https://$Domain/api/me" 60 ''
  if ($okHttps) { Write-Host "✅ Сайт доступен по HTTPS: https://$Domain" -ForegroundColor Green }
  else {
    Write-Host "❌ https://$Domain пока не отвечает — смотрите $LogDir\caddy.log" -ForegroundColor Red
    Warn '   Частые причины: порты 80/443 закрыты в панели хостера; A-запись домена ещё не обновилась. Проверка: video check'
  }
}

if (-not ($okApp -and $okLk)) {
  Write-Host ''
  Write-Host '--- последние строки логов ---' -ForegroundColor Yellow
  foreach ($s in @('app', 'livekit')) {
    if ($Services -notcontains $s) { continue }
    $lf = Join-Path $LogDir "$s.log"
    if (Test-Path $lf) { Write-Host "[$s]"; Get-Content -Encoding UTF8 -Tail 15 $lf | ForEach-Object { Write-Host "  $_" } }
  }
}

Remove-Dir $TmpDir

$line = '=' * 60
Write-Host ''
Write-Host $line -ForegroundColor Green
if ($IsLocal) {
  if ($okApp) { Write-Host '  Готово! (локальный режим)' -ForegroundColor Green }
  else { Write-Host '  Установка завершена с ошибками — см. сообщения выше (video check, video logs).' -ForegroundColor Yellow }
  Write-Host "  Админ-панель:  $AdminUrl"
  Write-Host '  Логин:         admin'
  if ($GeneratedPassword) { Write-Host "  Пароль админа: $AdminPassword   (сохраните его!)" -ForegroundColor Yellow }
  Write-Host '  Панель открывается только на этом компьютере (сайта в интернете нет).' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host "  Настройки:  $CfgPath     Данные: $DataDir"
  Write-Host '  Логи:       video logs'
  Write-Host '  Обновить:   video update      (все команды: video help, проверка: video check)'
  Write-Host '  Нужен сайт для видеовстреч в браузере (HTTPS, свой домен):' -ForegroundColor DarkGray
  Write-Host "    powershell -ExecutionPolicy Bypass -File $AppDir\deploy\windows\install.ps1 -Full" -ForegroundColor DarkGray
} else {
  if ($okApp -and $okLk -and $okHttps) { Write-Host '  Готово!' -ForegroundColor Green }
  elseif ($okApp -and $okLk) { Write-Host '  Готово! (HTTPS ещё настраивается — проверьте через пару минут: video check)' -ForegroundColor Green }
  else { Write-Host '  Установка завершена с ошибками — см. сообщения выше (video check, video logs).' -ForegroundColor Yellow }
  Write-Host "  Сайт:          https://$Domain"
  Write-Host "  Админ-панель:  $AdminUrl"
  if ($GeneratedPassword) { Write-Host "  Пароль админа: $AdminPassword   (сохраните его!)" -ForegroundColor Yellow }
  Write-Host ''
  Write-Host "  Настройки:  $CfgPath     Данные: $DataDir"
  Write-Host "  Логи:       video logs   (video logs livekit, video logs caddy)"
  Write-Host '  Обновить:   video update      (все команды: video help, проверка: video check)'
  Write-Host '  Если у хостера есть свой файрвол — откройте в его панели входящие порты:'
  Write-Host '    TCP 80, 443, 7881;  UDP 443, 3478, 50000-50200'
  if ($Domain -like '*.sslip.io') {
    Write-Host '  Адрес *.sslip.io временный: лучше свой домен (A-запись на этот IP), затем:' -ForegroundColor DarkYellow
    Write-Host "    powershell -ExecutionPolicy Bypass -File $AppDir\deploy\windows\install.ps1 -Domain meet.ваш-домен.ru" -ForegroundColor DarkYellow
  }
}
Write-Host $line -ForegroundColor Green
