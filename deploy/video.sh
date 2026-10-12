#!/usr/bin/env bash
# Быстрые команды для сервиса видеовстреч. Устанавливается в /usr/local/bin/video.
#   video update | restart | stop | start | status | logs | url | password <новый> | check | help
# Обновление меняет только код приложения — Caddy и другие проекты не трогаются.
set -euo pipefail

APP_DIR=/opt/conference
ENV_FILE="${ENV_FILE:-/etc/conference.env}"
TURN_CONF="${TURN_CONF:-/etc/turnserver.conf}"
APP_USER=conference
BRANCH="${BRANCH:-claude/video-conference-recording-service-4y8f5m}"

say() { echo -e "\033[1;34m==> $*\033[0m"; }
ok() { echo -e "\033[1;32m$*\033[0m"; }
die() { echo -e "\033[1;31mОшибка: $*\033[0m" >&2; exit 1; }

# video-update == video update
cmd="${1:-help}"
[ "$(basename "$0")" = "video-update" ] && cmd=update

if [ "$(id -u)" -ne 0 ] && [ "$cmd" != help ] && [ -z "${VIDEO_NO_SUDO:-}" ]; then exec sudo "$0" "$@"; fi

env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }

check_alive() {
  local host port
  host="$(env_get HOST)"; port="$(env_get PORT)"
  for _ in $(seq 1 10); do
    if curl -fsS --max-time 3 "http://${host:-127.0.0.1}:${port:-3000}/api/me" 2>/dev/null | grep -q '"admin"'; then
      ok "Сервис работает: https://$(env_get PUBLIC_DOMAIN)/admin"
      return 0
    fi
    sleep 1
  done
  journalctl -u conference -n 30 --no-pager
  die "сервис не отвечает — см. логи выше"
}

# ---------- диагностика: video check ----------
PASS=0; FAIL=0
good() { echo -e "\033[1;32m✅ $*\033[0m"; PASS=$((PASS + 1)); }
bad()  { echo -e "\033[1;31m❌ $*\033[0m"; FAIL=$((FAIL + 1)); }
info() { echo "   $*"; }

# turn_probe <tcp|udp> <ip> <user> <pass>: пытается получить relay-адрес через TURN
turn_probe() {
  local proto="$1" ip="$2" user="$3" pass="$4" out rc=0 flag=() buf=()
  [ "$proto" = tcp ] && flag=(-t)
  # stdbuf: чтобы вывод не потерялся в буфере, если timeout прервёт клиента
  command -v stdbuf >/dev/null 2>&1 && buf=(stdbuf -oL -eL)
  out="$(timeout 10 "${buf[@]}" turnutils_uclient "${flag[@]}" -u "$user" -w "$pass" -y -n 1 -m 1 "$ip" 2>&1)" || rc=$?
  if echo "$out" | grep -qi 'relay addr'; then
    good "TURN по ${proto^^}: relay-адрес выдан ($ip:3478)"
  elif echo "$out" | grep -qiE '401|unauthori[sz]ed'; then
    bad "TURN по ${proto^^}: неверный логин/пароль (TURN_USER/TURN_PASS не совпадают с $TURN_CONF)"
  elif [ "$rc" -eq 124 ]; then
    bad "TURN по ${proto^^}: нет ответа за 10 с от $ip:3478"
  else
    bad "TURN по ${proto^^}: relay не выдан (код $rc)"
    echo "$out" | grep -iE 'error|cannot|fail|403|437|486' | head -3 | sed 's/^/   /' || true
  fi
}

run_check() {
  local host port domain dir turn_user turn_pass pub_ip ext_ip ufw_out avail free_mb
  host="$(env_get HOST)"; host="${host:-127.0.0.1}"
  port="$(env_get PORT)"; port="${port:-3000}"
  domain="$(env_get PUBLIC_DOMAIN)"
  dir="$(env_get DATA_DIR)"; dir="${dir:-/var/lib/conference}"
  turn_user="$(env_get TURN_USER)"; turn_pass="$(env_get TURN_PASS)"

  echo "Диагностика сервиса видеовстреч"
  echo "--- Приложение ---"
  if systemctl is-active --quiet conference 2>/dev/null; then
    good "Сервис conference запущен"
  else
    bad "Сервис conference не запущен (video start, video logs)"
  fi
  if curl -fsS --max-time 5 "http://$host:$port/api/me" >/dev/null 2>&1; then
    good "Приложение отвечает на http://$host:$port/api/me"
  else
    bad "Приложение не отвечает на http://$host:$port/api/me"
  fi
  if [ -z "$domain" ]; then
    bad "PUBLIC_DOMAIN не задан в $ENV_FILE"
  elif curl -sS -f --max-time 8 "https://$domain/api/me" >/dev/null 2>&1; then
    good "Сайт доступен из интернета: https://$domain"
  else
    bad "https://$domain/api/me не отвечает (Caddy, DNS или сертификат)"
  fi

  echo "--- TURN-сервер (coturn) ---"
  if systemctl is-active --quiet coturn 2>/dev/null; then
    good "coturn запущен"
  else
    bad "coturn не запущен (systemctl restart coturn; journalctl -u coturn -n 30)"
  fi
  if ss -lunH 2>/dev/null | awk '{print $4}' | grep -qE ':3478$'; then
    good "Порт 3478/UDP слушается"
  else
    bad "Порт 3478/UDP не слушается"
  fi
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE ':3478$'; then
    good "Порт 3478/TCP слушается"
  else
    bad "Порт 3478/TCP не слушается"
  fi

  pub_ip="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
  ext_ip="$(grep -E '^external-ip=' "$TURN_CONF" 2>/dev/null | head -1 | cut -d= -f2- | cut -d/ -f1 || true)"
  if [ -z "$pub_ip" ]; then
    bad "Не удалось узнать внешний IP (api.ipify.org)"
  elif [ "$ext_ip" = "$pub_ip" ]; then
    good "external-ip в $TURN_CONF совпадает с внешним IP ($pub_ip)"
  else
    bad "external-ip в $TURN_CONF = '${ext_ip:-нет}', а внешний IP = $pub_ip (переустановите: install.sh)"
  fi

  local target="${pub_ip:-$ext_ip}"
  if [ -z "$turn_user" ] || [ -z "$turn_pass" ]; then
    bad "TURN_USER/TURN_PASS не заданы в $ENV_FILE — TURN не используется"
  elif ! command -v turnutils_uclient >/dev/null 2>&1; then
    bad "turnutils_uclient не найден (apt-get install coturn)"
  elif [ -z "$target" ]; then
    bad "Не к чему подключаться для проверки TURN (нет IP)"
  else
    turn_probe udp "$target" "$turn_user" "$turn_pass"
    turn_probe tcp "$target" "$turn_user" "$turn_pass"
  fi

  echo "--- Брандмауэр ---"
  if ! command -v ufw >/dev/null 2>&1; then
    info "ufw не установлен — проверьте только фаервол в панели VDSina"
  else
    ufw_out="$(ufw status 2>/dev/null || true)"
    if ! echo "$ufw_out" | grep -q "Status: active"; then
      info "ufw выключен — локальный фаервол не мешает"
    else
      if echo "$ufw_out" | grep -qE '^3478(/(udp|tcp))?[[:space:]].*ALLOW'; then
        good "ufw: порт 3478 открыт"
      else
        bad "ufw: порт 3478 закрыт (ufw allow 3478)"
      fi
      if echo "$ufw_out" | grep -qE '^49160:49250/udp[[:space:]].*ALLOW'; then
        good "ufw: порты 49160:49250/udp открыты"
      else
        bad "ufw: порты 49160:49250/udp закрыты (ufw allow 49160:49250/udp)"
      fi
    fi
  fi

  echo "--- Диск и записи ---"
  if [ -d "$dir" ]; then
    avail="$(df -Pk "$dir" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
    if [ -n "$avail" ]; then
      free_mb=$((avail / 1024))
      if [ "$free_mb" -ge 1024 ]; then
        good "Свободно на диске ($dir): ${free_mb} МБ"
      else
        bad "Мало места на диске ($dir): ${free_mb} МБ — записи могут не сохраниться"
      fi
    else
      bad "Не удалось узнать свободное место в $dir"
    fi
  else
    bad "Папка данных $dir не найдена"
  fi
  if command -v ffmpeg >/dev/null 2>&1; then
    good "ffmpeg установлен"
  else
    bad "ffmpeg не найден (apt-get install ffmpeg) — записи не будут обрабатываться"
  fi

  echo
  if [ "$FAIL" -eq 0 ]; then
    ok "Всё в порядке: $PASS проверок пройдено."
  else
    echo -e "\033[1;31mПроблем: $FAIL (пройдено: $PASS).\033[0m"
  fi
  cat <<'EOF'
Подсказка: если участники не видят/не слышат друг друга, а TURN не работает извне —
откройте в панели VDSina (раздел «Firewall»/«Брандмауэр») входящие порты
3478 TCP+UDP и 49160-49250 UDP. Проверка с самого сервера может пройти, даже когда
внешний фаервол закрыт: проверьте с другого компьютера, например
https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
EOF
  [ "$FAIL" -eq 0 ]
}

case "$cmd" in
  update)
    [ -d "$APP_DIR/.git" ] || die "приложение не установлено в $APP_DIR"
    say "Скачиваю последнюю версию"
    OLD="$(git -c safe.directory="$APP_DIR" -C "$APP_DIR" rev-parse --short HEAD)"
    git -c safe.directory="$APP_DIR" -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
    git -c safe.directory="$APP_DIR" -C "$APP_DIR" reset --hard FETCH_HEAD
    NEW="$(git -c safe.directory="$APP_DIR" -C "$APP_DIR" rev-parse --short HEAD)"
    if [ "$OLD" = "$NEW" ]; then
      ok "Уже последняя версия ($NEW)."
    else
      echo "Версия: $OLD -> $NEW"
      git -c safe.directory="$APP_DIR" -C "$APP_DIR" log --oneline "$OLD..$NEW" 2>/dev/null | head -10 || true
    fi
    say "Устанавливаю зависимости"
    (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
    say "Перезапускаю"
    systemctl restart conference
    check_alive
    # обновляем и саму эту команду (install создаёт новый файл, работающий скрипт не ломается)
    install -m 755 "$APP_DIR/deploy/video.sh" /usr/local/bin/video
    ln -sf /usr/local/bin/video /usr/local/bin/video-update
    echo "Проверить связь: video check"
    ;;
  restart) systemctl restart conference; check_alive ;;
  start)   systemctl start conference; check_alive ;;
  stop)    systemctl stop conference; ok "Сервис остановлен. Запустить: video start" ;;
  status)  systemctl status conference --no-pager -l | head -15 ;;
  check)   run_check ;;
  logs)    journalctl -u conference -f -n 50 ;;
  diag)
    # жалобы браузеров участников: не грузится видео, обрыв соединения, нет доступа к камере
    echo "Проблемы у участников за последние ${2:-24} ч (новые внизу):"
    journalctl -u conference --since "-${2:-24}h" --no-pager -o short-iso 2>/dev/null | grep 'DIAG' | sed 's/^\([^ ]*\) .*DIAG /\1 /' | tail -n 60 || true
    echo
    echo "Расшифровка: ice-failed — участники не соединились напрямую (проверьте TURN: video check);"
    echo "playback-stall / playback-lag — запись зависла или сильно отстаёт у участника (слабый интернет); playback-error — браузер не смог открыть файл;"
    echo "media-error — нет доступа к камере/микрофону на стороне участника."
    ;;
  url)     echo "Сайт:         https://$(env_get PUBLIC_DOMAIN)"
           echo "Админ-панель: https://$(env_get PUBLIC_DOMAIN)/admin" ;;
  password)
    NEWPASS="${2:-}"
    [ -n "$NEWPASS" ] || { read -rsp "Новый пароль админки: " NEWPASS; echo; }
    [[ "$NEWPASS" =~ ^[A-Za-z0-9_.,@%+=:!?-]+$ ]] || die "только латиница, цифры и символы _ . , @ % + = : ! ? -"
    sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$NEWPASS|" "$ENV_FILE"
    systemctl restart conference
    check_alive
    ok "Пароль изменён."
    ;;
  *)
    cat <<'EOF'
Команды сервиса видеовстреч:
  video update      — обновить до последней версии (то же самое: video-update)
  video restart     — перезапустить
  video stop        — остановить
  video start       — запустить
  video status      — состояние
  video logs        — логи в реальном времени (выход: Ctrl+C)
  video diag        — на что жаловались браузеры участников за сутки (video diag 3 — за 3 часа)
  video url         — показать адрес сайта и админки
  video password    — сменить пароль админки
  video check       — диагностика: сайт, TURN (coturn), порты, фаервол, диск
EOF
    ;;
esac
