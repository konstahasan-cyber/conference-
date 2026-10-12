#!/usr/bin/env bash
# Установка / обновление сервиса видеовстреч на Ubuntu 24.04.
#
# Два режима (выбирается автоматически):
#  • чистый сервер — ставит свой Caddy (HTTPS) и включает файрвол;
#  • порты 80/443 уже заняты (например, Caddy в Docker другого проекта) — НЕ трогает их,
#    а добавляет сайт в существующий Caddy (с резервной копией и проверкой конфига).
# Также ставит Node.js 22, ffmpeg, coturn (TURN) и systemd-сервис.
# Повторный запуск обновляет код и сохраняет настройки и данные.
#
#   sudo bash install.sh
#   sudo DOMAIN=meet.example.com ADMIN_PASSWORD=secret bash install.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/konstahasan-cyber/conference-.git}"
BRANCH="${BRANCH:-claude/video-conference-recording-service-4y8f5m}"
APP_DIR=/opt/conference
DATA_DIR=/var/lib/conference
ENV_FILE=/etc/conference.env
APP_USER=conference

randstr() { head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }
say() { echo -e "\n\033[1;34m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m$*\033[0m"; }
die() { echo -e "\033[1;31mОшибка: $*\033[0m" >&2; exit 1; }
port_busy() { [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ]; }
ask() { local a; read -rp "$1" a < /dev/tty || true; echo "$a"; }

[ "$(id -u)" -eq 0 ] || die "запустите через sudo: sudo bash install.sh"
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || warn "Внимание: скрипт рассчитан на Ubuntu 24.04, у вас ${PRETTY_NAME:-неизвестная ОС}"
export DEBIAN_FRONTEND=noninteractive

say "Определяю внешний IP"
PUBLIC_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || curl -4 -fsS --max-time 10 https://ifconfig.me || true)"
[ -n "$PUBLIC_IP" ] || die "не удалось определить внешний IP сервера"
echo "IP: $PUBLIC_IP"

# ---------- Сохранённые настройки ----------
FIRST_INSTALL=1
if [ -f "$ENV_FILE" ]; then
  FIRST_INSTALL=0
  set -a; . "$ENV_FILE"; set +a
  DOMAIN="${DOMAIN:-${PUBLIC_DOMAIN:-}}"
fi

# ---------- Режим: свой Caddy или уже существующий ----------
systemctl is-active --quiet conference 2>/dev/null && systemctl stop conference   # чтобы не мешал проверке портов
MODE="${MODE:-}"
if [ -z "$MODE" ]; then
  if systemctl is-active --quiet caddy 2>/dev/null && [ "${PROXY_MODE:-}" != "external" ]; then
    MODE=own                                   # наш Caddy уже стоит с прошлой установки
  elif port_busy 80 || port_busy 443; then
    MODE=external
  else
    MODE=own
  fi
fi

CADDY_CONTAINER=""
UPSTREAM_HOST=127.0.0.1
if [ "$MODE" = external ]; then
  warn "Порты 80/443 уже заняты другим веб-сервером — использую его, ничего из существующего не удаляю."
  # остаток прошлой неудачной установки: системный Caddy не смог запуститься из-за занятых портов.
  # Отключаем его, иначе после перезагрузки он может перехватить порты у основного веб-сервера.
  if systemctl is-enabled --quiet caddy 2>/dev/null && ! systemctl is-active --quiet caddy; then
    systemctl disable --now caddy >/dev/null 2>&1 || true
    echo "Отключён лишний системный Caddy от прошлой попытки установки."
  fi
  if command -v docker >/dev/null; then
    CADDY_CONTAINER="$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /caddy/ {print $1; exit}')"
  fi
  if [ -n "$CADDY_CONTAINER" ]; then
    echo "Найден Caddy в Docker: $CADDY_CONTAINER"
    # приложение слушает на IP моста Docker — контейнер его видит, из интернета порт недоступен
    UPSTREAM_HOST="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}' "$CADDY_CONTAINER" | awk '{print $1}')"
    # контейнер в режиме network_mode: host — достаточно localhost
    [ -n "$UPSTREAM_HOST" ] || UPSTREAM_HOST=127.0.0.1
  fi
fi

# ---------- Домен и пароль ----------
if [ -z "${DOMAIN:-}" ]; then
  DEFAULT_DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  echo
  echo "Укажите домен или поддомен, направленный (A-запись) на IP $PUBLIC_IP, например meet.mysite.ru"
  echo "Если домена нет — нажмите Enter, будет бесплатный адрес $DEFAULT_DOMAIN"
  DOMAIN="$(ask "Домен: ")"
  DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
fi
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"

if [ -z "${ADMIN_PASSWORD:-}" ]; then
  echo
  read -rsp "Пароль для админ-панели (Enter — сгенерировать): " ADMIN_PASSWORD < /dev/tty || true
  echo
  if [ -z "$ADMIN_PASSWORD" ]; then ADMIN_PASSWORD="$(randstr 14)"; GENERATED_PASSWORD=1; fi
fi
[[ "$ADMIN_PASSWORD" =~ ^[A-Za-z0-9_.,@%+=:!?-]+$ ]] || die "в пароле можно использовать только латиницу, цифры и символы _ . , @ % + = : ! ? -"
TURN_USER="${TURN_USER:-meet}"
TURN_PASS="${TURN_PASS:-$(randstr 24)}"

# свободный порт для приложения (при обновлении оставляем прежний)
if [ "$FIRST_INSTALL" = 1 ] || [ -z "${PORT:-}" ]; then
  PORT=3000
  while port_busy "$PORT"; do PORT=$((PORT + 1)); done
fi
echo "Порт приложения: $PORT"

# ---------- Пакеты ----------
say "Устанавливаю системные пакеты"
apt-get update -y
apt-get install -y curl git ffmpeg ca-certificates gnupg coturn
[ "$MODE" = own ] && apt-get install -y ufw debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  say "Устанавливаю Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js $(node -v)"

if [ "$MODE" = own ] && ! command -v caddy >/dev/null; then
  say "Устанавливаю Caddy (HTTPS)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# ---------- Код приложения ----------
say "Загружаю приложение в $APP_DIR"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" reset --hard FETCH_HEAD
else
  rm -rf "$APP_DIR"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
mkdir -p "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

# ---------- Настройки приложения ----------
say "Сохраняю настройки в $ENV_FILE"
umask 077
cat > "$ENV_FILE" <<EOF
PUBLIC_DOMAIN=$DOMAIN
PROXY_MODE=$MODE
PORT=$PORT
HOST=$UPSTREAM_HOST
DATA_DIR=$DATA_DIR
ADMIN_PASSWORD=$ADMIN_PASSWORD
MAX_UPLOAD_MB=4096
TURN_URL=turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp
TURN_USER=$TURN_USER
TURN_PASS=$TURN_PASS
EOF
umask 022

cat > /etc/systemd/system/conference.service <<EOF
[Unit]
Description=Conference (видеовстречи)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

# ---------- TURN-сервер ----------
if port_busy 3478 && ! systemctl is-active --quiet coturn; then
  warn "Порт 3478 занят другим сервисом — TURN-сервер пропускаю."
  sed -i '/^TURN_/d' "$ENV_FILE"
else
  say "Настраиваю TURN-сервер (coturn)"
  cat > /etc/turnserver.conf <<EOF
listening-port=3478
external-ip=$PUBLIC_IP
min-port=49160
max-port=49250
fingerprint
lt-cred-mech
user=$TURN_USER:$TURN_PASS
realm=$DOMAIN
no-cli
no-multicast-peers
no-tls
no-dtls
# не пускаем TURN во внутренние сети сервера
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
EOF
  [ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  systemctl enable coturn >/dev/null 2>&1
  systemctl restart coturn
fi

# ---------- Запуск приложения ----------
say "Запускаю приложение"
systemctl daemon-reload
systemctl enable conference >/dev/null 2>&1
systemctl restart conference
sleep 3
systemctl is-active --quiet conference || { journalctl -u conference -n 30 --no-pager; die "приложение не запустилось"; }

SITE_BLOCK="$DOMAIN {
	encode gzip
	reverse_proxy $UPSTREAM_HOST:$PORT
}"
HTTPS_OK=1

# ---------- HTTPS ----------
if [ "$MODE" = own ]; then
  say "Настраиваю Caddy для https://$DOMAIN"
  echo "$SITE_BLOCK" > /etc/caddy/Caddyfile
  systemctl enable caddy >/dev/null 2>&1
  systemctl restart caddy

  say "Настраиваю файрвол"
  SSH_PORT="$(echo "${SSH_CONNECTION:-}" | awk '{print $4}')"
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
  [ -n "$SSH_PORT" ] && ufw allow "$SSH_PORT/tcp" >/dev/null
  for r in 80/tcp 443/tcp 443/udp 3478 49160:49250/udp; do ufw allow "$r" >/dev/null; done
  ufw --force enable >/dev/null

elif [ -n "$CADDY_CONTAINER" ]; then
  say "Добавляю сайт в существующий Caddy ($CADDY_CONTAINER)"
  SRC="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$CADDY_CONTAINER")"
  if [ -z "$SRC" ]; then
    DIR="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}' "$CADDY_CONTAINER")"
    [ -n "$DIR" ] && SRC="$DIR/Caddyfile"
  fi
  if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
    HTTPS_OK=0
  elif grep -qF "$DOMAIN {" "$SRC"; then
    echo "Сайт $DOMAIN уже есть в $SRC — оставляю как есть."
    docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  else
    BACKUP="$SRC.bak-$(date +%Y%m%d-%H%M%S)"
    cp -p "$SRC" "$BACKUP"
    echo "Резервная копия: $BACKUP"
    printf '\n# --- видеовстречи (conference) ---\n%s\n' "$SITE_BLOCK" >> "$SRC"
    if docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
       && docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
      echo "Caddy перезагружен, сайт добавлен. Остальные сайты продолжают работать."
    else
      cat "$BACKUP" > "$SRC"     # пишем поверх, чтобы не сломать bind-mount файла
      docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
      warn "Caddy не принял новый конфиг — вернул прежний."
      HTTPS_OK=0
    fi
  fi
  if ufw status 2>/dev/null | grep -q "Status: active"; then
    for r in 3478 49160:49250/udp; do ufw allow "$r" >/dev/null; done
    # разрешаем контейнерам Docker обращаться к приложению
    [ "$UPSTREAM_HOST" != 127.0.0.1 ] && ufw allow from 172.16.0.0/12 to "$UPSTREAM_HOST" port "$PORT" proto tcp >/dev/null
  fi
else
  HTTPS_OK=0
fi

echo
echo -e "\033[1;32m========================================================\033[0m"
if [ "$HTTPS_OK" = 1 ]; then
  echo -e "\033[1;32m  Готово!\033[0m"
  echo "  Сайт:          https://$DOMAIN"
  echo "  Админ-панель:  https://$DOMAIN/admin"
  echo "  Сертификат HTTPS выпускается автоматически в течение минуты."
else
  warn "  Приложение запущено, но HTTPS нужно подключить вручную."
  echo "  Добавьте в конфиг вашего веб-сервера (Caddy):"
  echo
  echo "$SITE_BLOCK"
  echo
  echo "  Для nginx: proxy_pass http://$UPSTREAM_HOST:$PORT; с заголовками Upgrade/Connection для WebSocket."
fi
if [ "${GENERATED_PASSWORD:-}" = 1 ]; then
  echo "  Пароль админа: $ADMIN_PASSWORD   (сохраните его!)"
fi
echo
echo "  Настройки:  $ENV_FILE     Данные: $DATA_DIR"
echo "  Логи:       journalctl -u conference -f"
echo "  Обновить:   sudo bash $APP_DIR/deploy/install.sh"
echo "  Если у хостера есть свой файрвол — откройте порты 3478 (TCP+UDP) и 49160-49250 (UDP)."
echo -e "\033[1;32m========================================================\033[0m"
