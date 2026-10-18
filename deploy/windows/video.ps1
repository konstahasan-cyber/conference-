<#
  Быстрые команды для сервиса видеовстреч на Windows. Устанавливается в C:\conference\video.ps1,
  вызывается из любой консоли командой «video» (C:\Windows\video.cmd).
    video update | restart | stop | start | status | logs [app|livekit|caddy] | url
          | password <новый> | check | diag [часы] | zoom [status|logs|restart] | help
  Обновление меняет только код приложения — Caddy, LiveKit и данные не трогаются.
  В локальном режиме (config.json: mode = local, install.ps1 -Local) есть только служба app:
  команды работают с ней, а video check не проверяет LiveKit, HTTPS, домен и брандмауэр.
#>
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1)][string]$Arg = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}

$Root     = 'C:\conference'
$Bin      = Join-Path $Root 'bin'
$NodeDir  = Join-Path $Bin 'node'
$AppDir   = Join-Path $Root 'app'
$DataDir  = Join-Path $Root 'data'
$LogDir   = Join-Path $Root 'logs'
$TmpDir   = Join-Path $Root 'tmp'
$CfgPath  = Join-Path $Root 'config.json'
$Services = @('livekit', 'app', 'caddy')
$Utf8NoBom = New-Object Text.UTF8Encoding $false
$PwRegex  = '^[A-Za-z0-9_.,@%+=:!?-]+$'

function Say([string]$m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Ok([string]$m)   { Write-Host $m -ForegroundColor Green }
function Die([string]$m)  { Write-Host "Ошибка: $m" -ForegroundColor Red; exit 1 }

$Command = $Command.ToLower()

# ---------- Права администратора ----------
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($Command -ne 'help' -and -not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Warn 'Нужны права администратора — открываю окно PowerShell от имени администратора...'
  $a = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`" $Command"
  if ($Arg) { $a += " `"$Arg`"" }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $a
  exit
}

# ---------- Режим установки: local (только админка на этом компьютере + Zoom) или full (сайт) ----------
$IsLocal = $false
if (Test-Path $CfgPath) {
  try {
    $c0 = Get-Content -Raw -Encoding UTF8 $CfgPath | ConvertFrom-Json
    if ([string]$c0.mode -eq 'local') { $IsLocal = $true }
  } catch {}
}
if ($IsLocal) { $Services = @('app'); $StopOrder = @('app') } else { $StopOrder = @('caddy', 'app', 'livekit') }

# ---------- Общие функции ----------
function Get-Config {
  if (-not (Test-Path $CfgPath)) { Die "не найден $CfgPath — сначала выполните установку (install.ps1)" }
  return (Get-Content -Raw -Encoding UTF8 $CfgPath | ConvertFrom-Json)
}
function Save-Config($Cfg) {
  [IO.File]::WriteAllText($CfgPath, ($Cfg | ConvertTo-Json), $Utf8NoBom)
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
  if (-not (Get-ScheduledTask -TaskName "conference-$Name" -ErrorAction SilentlyContinue)) {
    Die "задача conference-$Name не найдена — запустите установку заново (install.ps1)"
  }
  Start-ScheduledTask -TaskName "conference-$Name"
}

function Test-Url([string]$Url, [string]$Expect, [int]$Timeout = 5) {
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $Timeout
    if ($Expect) { return ([string]$r.Content -like "*$Expect*") }
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Show-LogTail([string]$Name, [int]$Lines = 30) {
  $lf = Join-Path $LogDir "$Name.log"
  if (Test-Path $lf) { Get-Content -Encoding UTF8 -Tail $Lines $lf | ForEach-Object { Write-Host "  $_" } }
}

function Get-AdminUrl($Cfg) {
  if ($IsLocal) { return "http://127.0.0.1:$($Cfg.port)/admin" }
  return "https://$($Cfg.domain)/admin"
}

function Wait-Alive {
  $cfg = Get-Config
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-Url "http://127.0.0.1:$($cfg.port)/api/me" '' 3) {
      Ok "Сервис работает: $(Get-AdminUrl $cfg)"
      return
    }
    Start-Sleep -Seconds 1
  }
  Show-LogTail 'app' 30
  Die "сервис не отвечает — см. лог выше ($LogDir\app.log)"
}

function Remove-Dir([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    cmd.exe /c "rd /s /q `"$Path`" >nul 2>nul" | Out-Null
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

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

# ---------- video update ----------
function Invoke-Update {
  $cfg = Get-Config
  $branch = $cfg.branch
  if (-not $branch) { $branch = 'claude/video-conference-recording-service-4y8f5m' }
  if (-not (Test-Path (Join-Path $AppDir 'server.js'))) { Die "приложение не установлено в $AppDir" }
  $env:PATH = "$NodeDir;$Bin;" + $env:PATH
  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

  Say 'Скачиваю последнюю версию'
  $zip = Join-Path $TmpDir 'app.zip'
  $url = "https://github.com/konstahasan-cyber/conference-/archive/refs/heads/$branch.zip"
  $done = $false
  for ($i = 1; $i -le 3 -and -not $done; $i++) {
    try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing; $done = $true }
    catch { Warn "Попытка $i из 3 не удалась: $($_.Exception.Message)"; Start-Sleep -Seconds 3 }
  }
  if (-not $done) { Die "не удалось скачать $url" }

  $commitFile = Join-Path $AppDir '.commit'
  $old = ''
  if (Test-Path $commitFile) { $old = (Get-Content -Raw $commitFile).Trim() }
  $new = Get-ZipCommit $zip
  if ($old -and $new -and $old -eq $new -and $Arg -ne 'force') {
    Remove-Item -Force $zip
    Ok "Уже последняя версия ($new). Принудительно: video update force"
    return
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $ex = Join-Path $TmpDir 'app-src'
  Remove-Dir $ex
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $ex)
  Remove-Item -Force $zip
  $inner = Get-ChildItem $ex -Directory | Select-Object -First 1
  if (-not $inner -or -not (Test-Path (Join-Path $inner.FullName 'server.js'))) { Die 'в архиве приложения нет server.js' }
  $newDir = Join-Path $Root 'app.new'
  Remove-Dir $newDir
  Move-Item $inner.FullName $newDir
  Remove-Dir $ex

  # зависимости ставим заранее, пока старая версия ещё работает — простой минимальный
  Say 'Устанавливаю зависимости'
  Push-Location $newDir
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    & (Join-Path $NodeDir 'npm.cmd') ci --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | ForEach-Object { Write-Host "   $_" }
    $rc = $LASTEXITCODE
  } finally { $ErrorActionPreference = $eap; Pop-Location }
  if ($rc -ne 0) { Remove-Dir $newDir; Die "npm ci не удался (код $rc) — работает прежняя версия" }
  if ($new) { [IO.File]::WriteAllText((Join-Path $newDir '.commit'), $new, $Utf8NoBom) }

  Say 'Перезапускаю приложение'
  Stop-ConfService 'app'
  $oldDir = Join-Path $Root ('app.old-' + (Get-Date -Format 'yyyyMMddHHmmss'))
  Move-Item $AppDir $oldDir
  Move-Item $newDir $AppDir
  Start-ConfService 'app'
  Remove-Dir $oldDir
  if ($old -and $new) { Write-Host "Версия: $old -> $new" }
  elseif ($new) { Write-Host "Версия: $new" }
  Ok 'Обновлено.'
  Wait-Alive

  # обновляем и саму эту команду (PowerShell уже прочитал скрипт целиком — перезапись безопасна)
  $src = Join-Path $AppDir 'deploy\windows\video.ps1'
  if (Test-Path $src) { Copy-Item -Force $src (Join-Path $Root 'video.ps1') }
  Write-Host 'Проверить связь: video check'
}

# ---------- video status ----------
function Show-Status {
  foreach ($s in $Services) {
    $t = Get-ScheduledTask -TaskName "conference-$s" -ErrorAction SilentlyContinue
    $state = 'нет задачи'
    if ($t) { $state = [string]$t.State }
    $procs = Get-OurProcesses (Get-ServiceExe $s)
    if ($procs.Count -gt 0) {
      $p = $procs[0]
      $mb = [Math]::Round($p.WorkingSetSize / 1MB)
      $started = ''
      try { $started = $p.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') } catch {}
      Write-Host ("✅ conference-{0,-8} задача: {1,-8} процесс: PID {2}, {3} МБ, запущен {4}" -f $s, $state, $p.ProcessId, $mb, $started) -ForegroundColor Green
    } else {
      Write-Host ("❌ conference-{0,-8} задача: {1,-8} процесс не запущен (video logs {0})" -f $s, $state) -ForegroundColor Red
    }
  }
}

# ---------- video check ----------
$script:Pass = 0; $script:Fail = 0
function Good([string]$m) { Write-Host "✅ $m" -ForegroundColor Green; $script:Pass++ }
function Bad([string]$m)  { Write-Host "❌ $m" -ForegroundColor Red; $script:Fail++ }
function Info([string]$m) { Write-Host "   $m" }

function Invoke-Check {
  $cfg = Get-Config
  $domain = [string]$cfg.domain
  $port = $cfg.port
  $lkPort = $cfg.livekitPort
  if (-not $lkPort) { $lkPort = 7880 }

  Write-Host 'Диагностика сервиса видеовстреч'
  if ($IsLocal) { Write-Host 'Режим: локальный (только админ-панель на этом компьютере; LiveKit, HTTPS и брандмауэр не проверяются)' }
  Write-Host '--- Службы ---'
  foreach ($s in $Services) {
    $t = Get-ScheduledTask -TaskName "conference-$s" -ErrorAction SilentlyContinue
    if (-not $t) { Bad "Задача conference-$s не найдена (переустановите: install.ps1)"; continue }
    if ((Get-OurProcesses (Get-ServiceExe $s)).Count -gt 0) { Good "conference-$s запущен" }
    else { Bad "conference-$s не запущен (video start, video logs $s)" }
  }

  if ($IsLocal) { Write-Host '--- Приложение ---' } else { Write-Host '--- Приложение и LiveKit ---' }
  if (Test-Url "http://127.0.0.1:$port/api/me" '' 5) { Good "Приложение отвечает на http://127.0.0.1:$port/api/me" }
  else { Bad "Приложение не отвечает на http://127.0.0.1:$port/api/me (video logs)" }
  if ($IsLocal) {
    Write-Host '--- Порт приложения ---'
    $l = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($l.Count -eq 0) { Bad "Порт $port/TCP не слушается (app)" }
    else {
      $ours = $false
      foreach ($c in $l) {
        $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
        if ($pr -and $pr.ExecutablePath -ieq (Get-ServiceExe 'app')) { $ours = $true }
      }
      if ($ours) { Good "Порт $port/TCP слушает app" }
      else { Bad "Порт $port/TCP занят другой программой (PID $($l[0].OwningProcess)), а не app" }
    }
    Info "Админ-панель: http://127.0.0.1:$port/admin (только на этом компьютере)"
  } else {
    if (Test-Url "http://127.0.0.1:$lkPort/" 'OK' 5) { Good "LiveKit отвечает на http://127.0.0.1:$lkPort" }
    else { Bad "LiveKit не отвечает на http://127.0.0.1:$lkPort (video logs livekit)" }

    Write-Host '--- Сайт из интернета ---'
    $pubIp = ''
    try { $pubIp = ([string](Invoke-RestMethod -Uri 'https://api.ipify.org' -UseBasicParsing -TimeoutSec 8)).Trim() } catch {}
    if (-not $domain) {
      Bad "domain не задан в $CfgPath"
    } else {
      try {
        $ips = @(Resolve-DnsName -Name $domain -Type A -DnsOnly -ErrorAction Stop | Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress })
        if (-not $pubIp) { Info "DNS: $domain -> $($ips -join ', ') (внешний IP узнать не удалось)" }
        elseif ($ips -contains $pubIp) { Good "DNS: $domain указывает на этот сервер ($pubIp)" }
        else { Bad "DNS: $domain указывает на $($ips -join ', '), а IP сервера $pubIp — исправьте A-запись" }
      } catch { Bad "DNS: домен $domain не найден — проверьте A-запись" }
      if (Test-Url "https://$domain/api/me" '' 10) { Good "Сайт доступен по HTTPS: https://$domain" }
      else { Bad "https://$domain/api/me не отвечает (Caddy, DNS, сертификат или порты 80/443 — video logs caddy)" }
      if ($domain -like '*.sslip.io' -or $domain -like '*.nip.io') {
        Write-Host "⚠  Адрес $domain — временный бесплатный. Его иногда блокируют антивирусы," -ForegroundColor Yellow
        Write-Host '   корпоративные сети и некоторые провайдеры — у части людей сайт просто не откроется.' -ForegroundColor Yellow
        Write-Host "   Лучше купить свой домен (от ~200 ₽/год) и перенастроить:" -ForegroundColor Yellow
        Write-Host "   powershell -ExecutionPolicy Bypass -File $AppDir\deploy\windows\install.ps1 -Domain ваш.домен" -ForegroundColor Yellow
      }
    }

    Write-Host '--- Порты ---'
    $tcpWant = @(@{ P = 80; S = 'caddy' }, @{ P = 443; S = 'caddy' }, @{ P = 7881; S = 'livekit' }, @{ P = $lkPort; S = 'livekit' }, @{ P = $port; S = 'app' })
    foreach ($w in $tcpWant) {
      $l = @(Get-NetTCPConnection -State Listen -LocalPort $w.P -ErrorAction SilentlyContinue)
      if ($l.Count -eq 0) { Bad "Порт $($w.P)/TCP не слушается ($($w.S))"; continue }
      $exe = Get-ServiceExe $w.S
      $ours = $false
      foreach ($c in $l) {
        $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
        if ($pr -and $pr.ExecutablePath -ieq $exe) { $ours = $true }
      }
      if ($ours) { Good "Порт $($w.P)/TCP слушает $($w.S)" }
      else { Bad "Порт $($w.P)/TCP занят другой программой (PID $($l[0].OwningProcess)), а не $($w.S)" }
    }
    if (@(Get-NetUDPEndpoint -LocalPort 3478 -ErrorAction SilentlyContinue).Count -gt 0) { Good 'Порт 3478/UDP (TURN) слушается' }
    else { Bad 'Порт 3478/UDP (TURN) не слушается (video logs livekit)' }
    Info 'Порты UDP 50000-50200 открываются LiveKit по мере подключения участников.'

    Write-Host '--- Брандмауэр Windows ---'
    $want = @(
      @{ Proto = 'TCP'; Port = '80' }, @{ Proto = 'TCP'; Port = '443' }, @{ Proto = 'UDP'; Port = '443' },
      @{ Proto = 'TCP'; Port = '7881' }, @{ Proto = 'UDP'; Port = '3478' }, @{ Proto = 'UDP'; Port = '50000-50200' }
    )
    $rules = @(Get-NetFirewallRule -DisplayName 'Conference*' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' })
    $filters = @()
    foreach ($r in $rules) { $filters += ($r | Get-NetFirewallPortFilter) }
    foreach ($w in $want) {
      $hit = $filters | Where-Object { $_.Protocol -eq $w.Proto -and (@($_.LocalPort) -contains $w.Port) }
      if ($hit) { Good "Правило брандмауэра: $($w.Proto) $($w.Port) открыт" }
      else { Bad "Правило брандмауэра: $($w.Proto) $($w.Port) не открыт (переустановите: install.ps1)" }
    }
    $profiles = @(Get-NetFirewallProfile -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' })
    if ($profiles.Count -eq 0) { Info 'Брандмауэр Windows выключен — локально ничего не мешает.' }
  }

  Write-Host '--- Диск и записи ---'
  if (Test-Path $DataDir) {
    try {
      $drive = (Get-Item $DataDir).PSDrive.Name
      $free = [Math]::Floor((Get-PSDrive $drive).Free / 1MB)
      if ($free -ge 1024) { Good "Свободно на диске ${drive}: $free МБ" }
      else { Bad "Мало места на диске ${drive}: $free МБ — записи могут не сохраниться" }
    } catch { Bad "Не удалось узнать свободное место для $DataDir" }
  } else { Bad "Папка данных $DataDir не найдена" }
  foreach ($n in @('ffmpeg', 'ffprobe')) {
    $exe = Join-Path $Bin "$n.exe"
    $works = $false
    if (Test-Path $exe) {
      $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      try { & $exe -version 2>&1 | Out-Null; $works = ($LASTEXITCODE -eq 0) } catch {} finally { $ErrorActionPreference = $eap }
    }
    if ($works) { Good "$n установлен ($exe)" }
    else { Bad "$n не найден или не запускается ($exe) — переустановите: install.ps1 -UpdateTools" }
  }

  Write-Host ''
  if ($script:Fail -eq 0) { Ok "Всё в порядке: $($script:Pass) проверок пройдено." }
  else { Write-Host "Проблем: $($script:Fail) (пройдено: $($script:Pass))." -ForegroundColor Red }
  if (-not $IsLocal) {
    Write-Host @'
Подсказка: если участники не видят/не слышат друг друга — откройте в панели хостера
(раздел «Firewall»/«Брандмауэр»/«Сетевой экран») входящие порты:
  TCP 80, 443, 7881;  UDP 443, 3478, 50000-50200.
Проверка с самого сервера может пройти, даже когда внешний фаервол закрыт: проверьте
с другого компьютера, например https://livekit.io/connection-test (адрес wss://ваш-домен).
'@
  }
  if ($script:Fail -ne 0) { exit 1 }
}

# ---------- video diag ----------
function Show-Diag {
  $hours = 24
  if ($Arg -match '^\d+$') { $hours = [int]$Arg }
  $since = (Get-Date).AddHours(-$hours)
  Write-Host "Проблемы у участников за последние $hours ч (новые внизу):"
  $files = @((Join-Path $LogDir 'app.1.log'), (Join-Path $LogDir 'app.log')) | Where-Object { Test-Path $_ }
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($f in $files) {
    foreach ($line in [IO.File]::ReadLines($f)) {
      $i = $line.IndexOf('DIAG ')
      if ($i -lt 0 -or $line.Length -lt 19) { continue }
      $ts = [datetime]::MinValue
      if (-not [datetime]::TryParseExact($line.Substring(0, 19), 'yyyy-MM-dd HH:mm:ss', $null, [Globalization.DateTimeStyles]::None, [ref]$ts)) { continue }
      if ($ts -lt $since) { continue }
      $out.Add($line.Substring(0, 19) + ' ' + $line.Substring($i + 5))
    }
  }
  if ($out.Count -eq 0) { Write-Host '  (ничего)' }
  else { $out | Select-Object -Last 60 | ForEach-Object { Write-Host $_ } }
  Write-Host ''
  Write-Host 'Расшифровка: ice-failed — участники не соединились с медиасервером (проверьте порты: video check);'
  Write-Host 'playback-stall / playback-lag — запись зависла или сильно отстаёт у участника (слабый интернет); playback-error — браузер не смог открыть файл;'
  Write-Host 'media-error — нет доступа к камере/микрофону на стороне участника.'
}

# ---------- video zoom ----------
$ZoomTask = 'conference-zoom-runner'
function Invoke-Zoom {
  $sub = 'status'
  if ($Arg) { $sub = $Arg.ToLower() }
  $lf = Join-Path $LogDir 'zoom-runner.log'
  switch ($sub) {
    'status' {
      $t = Get-ScheduledTask -TaskName $ZoomTask -ErrorAction SilentlyContinue
      if (-not $t) {
        Write-Host "❌ Задача $ZoomTask не найдена — выполните zoom-setup.ps1 в RDP-сессии пользователя Zoom" -ForegroundColor Red
      } else {
        $user = [string]$t.Principal.UserId
        $last = ''
        try {
          $ti = Get-ScheduledTaskInfo -TaskName $ZoomTask
          if ($ti.LastRunTime) { $last = ", последний запуск $($ti.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss')) (код $($ti.LastTaskResult))" }
        } catch {}
        $color = 'Red'
        if ([string]$t.State -eq 'Running') { $color = 'Green' }
        Write-Host "Задача $ZoomTask`: $($t.State), пользователь $user$last" -ForegroundColor $color
      }
      $runner = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -like '*zoom-runner*runner.js*') })
      $obs  = @(Get-Process -Name 'obs64' -ErrorAction SilentlyContinue)
      $zoom = @(Get-Process -Name 'Zoom' -ErrorAction SilentlyContinue)
      foreach ($x in @(@{ N = 'zoom-runner'; P = $runner; Id = 'ProcessId' }, @{ N = 'OBS Studio '; P = $obs; Id = 'Id' }, @{ N = 'Zoom       '; P = $zoom; Id = 'Id' })) {
        if ($x.P.Count -gt 0) {
          $ids = ($x.P | ForEach-Object { $_.($x.Id) }) -join ', '
          Write-Host "✅ $($x.N) запущен (PID $ids)" -ForegroundColor Green
        } else {
          Write-Host "❌ $($x.N) не запущен" -ForegroundColor Red
        }
      }
      Write-Host "--- Последние строки $lf ---"
      if (Test-Path $lf) { Show-LogTail 'zoom-runner' 20 } else { Write-Host '  (лог ещё не создан)' }
    }
    'logs' {
      if (-not (Test-Path $lf)) { Die "лог $lf ещё не создан" }
      Write-Host "Лог $lf (выход: Ctrl+C)" -ForegroundColor DarkGray
      Get-Content -Path $lf -Encoding UTF8 -Tail 50 -Wait
    }
    'restart' {
      if (-not (Get-ScheduledTask -TaskName $ZoomTask -ErrorAction SilentlyContinue)) {
        Die "задача $ZoomTask не найдена — выполните zoom-setup.ps1 в RDP-сессии пользователя Zoom"
      }
      Stop-ScheduledTask -TaskName $ZoomTask -ErrorAction SilentlyContinue
      Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and (($_.CommandLine -like '*run-zoom-runner.ps1*') -or ($_.Name -ieq 'node.exe' -and $_.CommandLine -like '*zoom-runner*runner.js*')) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 2
      Start-ScheduledTask -TaskName $ZoomTask
      Start-Sleep -Seconds 3
      $t = Get-ScheduledTask -TaskName $ZoomTask
      if ([string]$t.State -eq 'Running') { Ok "zoom-runner перезапущен. Лог: video zoom logs" }
      else { Warn "Задача $ZoomTask в состоянии $($t.State) — пользователь $($t.Principal.UserId) должен быть в системе (войдите по RDP)" }
    }
    default { Die 'укажите status, logs или restart: video zoom status' }
  }
}

# ---------- Команды ----------
switch ($Command) {
  'update'  { Invoke-Update }
  'restart' {
    foreach ($s in $StopOrder) { Stop-ConfService $s }
    foreach ($s in $Services) { Start-ConfService $s }
    Wait-Alive
  }
  'start'   { foreach ($s in $Services) { Start-ConfService $s }; Wait-Alive }
  'stop'    {
    foreach ($s in $StopOrder) { Stop-ConfService $s }
    Ok 'Сервис остановлен. Запустить: video start'
  }
  'status'  { Show-Status }
  'check'   { Invoke-Check }
  'logs'    {
    $name = 'app'
    if ($Arg) { $name = $Arg.ToLower() }
    if ($Services -notcontains $name) {
      if ($IsLocal) { Die 'в локальном режиме есть только лог приложения: video logs (лог Zoom: video zoom logs)' }
      Die 'укажите app, livekit или caddy: video logs livekit'
    }
    $lf = Join-Path $LogDir "$name.log"
    if (-not (Test-Path $lf)) { Die "лог $lf ещё не создан" }
    Write-Host "Лог $lf (выход: Ctrl+C)" -ForegroundColor DarkGray
    Get-Content -Path $lf -Encoding UTF8 -Tail 50 -Wait
  }
  'diag'    { Show-Diag }
  'zoom'    { Invoke-Zoom }
  'url'     {
    $cfg = Get-Config
    if ($IsLocal) {
      Write-Host "Админ-панель: $(Get-AdminUrl $cfg)  (только на этом компьютере, логин admin)"
    } else {
      Write-Host "Сайт:         https://$($cfg.domain)"
      Write-Host "Админ-панель: $(Get-AdminUrl $cfg)"
    }
  }
  'password' {
    $new = $Arg
    if (-not $new) {
      $ss = Read-Host 'Новый пароль админки' -AsSecureString
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
      try { $new = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    if (-not $new -or $new -notmatch $PwRegex) { Die 'только латиница, цифры и символы _ . , @ % + = : ! ? -' }
    $cfg = Get-Config
    $cfg.adminPassword = $new
    Save-Config $cfg
    Stop-ConfService 'app'
    Start-ConfService 'app'
    Wait-Alive
    Ok 'Пароль изменён.'
  }
  default {
    Write-Host @'
Команды сервиса видеовстреч:
  video update            — обновить до последней версии
  video restart           — перезапустить (приложение, LiveKit, Caddy)
  video stop              — остановить
  video start             — запустить
  video status            — состояние
  video logs              — логи приложения в реальном времени (выход: Ctrl+C)
  video logs livekit      — логи LiveKit (или: video logs caddy)
  video diag              — на что жаловались браузеры участников за сутки (video diag 3 — за 3 часа)
  video url               — показать адрес сайта и админки
  video password          — сменить пароль админки (video password НовыйПароль)
  video check             — диагностика: сайт, LiveKit, порты, брандмауэр, диск, ffmpeg
  video zoom status       — Zoom-автовебинар: задача, процессы OBS/Zoom, последние строки лога
  video zoom logs         — лог zoom-runner в реальном времени (выход: Ctrl+C)
  video zoom restart      — перезапустить zoom-runner
Файлы: C:\conference (настройки config.json, данные data\, логи logs\)
'@
  }
}
