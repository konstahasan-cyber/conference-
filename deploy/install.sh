#!/usr/bin/env bash
# Установка / обновление сервиса видеовстреч на Ubuntu 24.04.
# Ставит: Node.js 22, ffmpeg, Caddy (HTTPS через Let's Encrypt), coturn (TURN), systemd-сервис, файрвол.
# Повторный запуск обновляет код и сохраняет настройки и данные.
#
#   sudo bash install.sh                       # спросит домен и пароль
#   sudo DOMAIN=meet.example.com ADMIN_PASSWORD=secret bash install.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/konstahasan-cyber/conference-.git}"
BRANCH="${BRANCH:-claude/video-conference-recording-service-4y8f5m}"
APP_DIR=/opt/conference
DATA_DIR=/var/lib/conference
ENV_FILE=/etc/conference.env
APP_USER=conference
PORT=3000

randstr() { head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }
say() { echo -e "\n\033[1;34m==> $*\033[0m"; }
die() { echo -e "\033[1;31mОшибка: $*\033[0m" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "запустите через sudo: sudo bash install.sh"
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || echo "Внимание: скрипт рассчитан на Ubuntu 24.04, у вас ${PRETTY_NAME:-неизвестная ОС}"

export DEBIAN_FRONTEND=noninteractive

say "Определяю внешний IP"
PUBLIC_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || curl -4 -fsS --max-time 10 https://ifconfig.me || true)"
[ -n "$PUBLIC_IP" ] || die "не удалось определить внешний IP сервера"
echo "IP: $PUBLIC_IP"

# ---------- Настройки (при повторном запуске берём из сохранённого файла) ----------
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
  DOMAIN="${DOMAIN:-${PUBLIC_DOMAIN:-}}"
fi

if [ -z "${DOMAIN:-}" ]; then
  DEFAULT_DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  echo
  echo "Укажите домен, который уже направлен (A-запись) на IP $PUBLIC_IP."
  echo "Если домена нет — просто нажмите Enter, будет использован бесплатный адрес $DEFAULT_DOMAIN"
  read -rp "Домен: " DOMAIN < /dev/tty || true
  DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
fi
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"

if [ -z "${ADMIN_PASSWORD:-}" ]; then
  echo
  read -rsp "Пароль для админ-панели (Enter — сгенерировать): " ADMIN_PASSWORD < /dev/tty || true
  echo
  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD="$(randstr 14)"
    GENERATED_PASSWORD=1
  fi
fi
[[ "$ADMIN_PASSWORD" =~ ^[A-Za-z0-9_.,@%+=:!?-]+$ ]] || die "в пароле можно использовать только латиницу, цифры и символы _ . , @ % + = : ! ? -"
TURN_USER="${TURN_USER:-meet}"
TURN_PASS="${TURN_PASS:-$(randstr 24)}"

# ---------- Пакеты ----------
say "Устанавливаю системные пакеты"
apt-get update -y
apt-get install -y curl git ffmpeg ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https coturn

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  say "Устанавливаю Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js $(node -v)"

if ! command -v caddy >/dev/null; then
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
PORT=$PORT
HOST=127.0.0.1
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
After=network.target

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

# ---------- HTTPS ----------
say "Настраиваю Caddy для https://$DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF

# ---------- Файрвол ----------
say "Настраиваю файрвол"
SSH_PORT="$(echo "${SSH_CONNECTION:-}" | awk '{print $4}')"
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
[ -n "$SSH_PORT" ] && ufw allow "$SSH_PORT/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw allow 3478 >/dev/null
ufw allow 49160:49250/udp >/dev/null
ufw --force enable >/dev/null

# ---------- Запуск ----------
say "Запускаю сервисы"
systemctl daemon-reload
systemctl enable coturn conference caddy >/dev/null 2>&1
systemctl restart coturn conference caddy

sleep 3
systemctl is-active --quiet conference || { journalctl -u conference -n 30 --no-pager; die "приложение не запустилось"; }

echo
echo -e "\033[1;32m========================================================\033[0m"
echo -e "\033[1;32m  Готово!\033[0m"
echo "  Сайт:          https://$DOMAIN"
echo "  Админ-панель:  https://$DOMAIN/admin"
if [ "${GENERATED_PASSWORD:-}" = 1 ]; then
  echo "  Пароль админа: $ADMIN_PASSWORD   (сохраните его!)"
fi
echo
echo "  Сертификат HTTPS выпускается автоматически в течение минуты."
echo "  Настройки:  $ENV_FILE     Данные: $DATA_DIR"
echo "  Логи:       journalctl -u conference -f"
echo "  Обновить:   sudo bash $APP_DIR/deploy/install.sh"
echo -e "\033[1;32m========================================================\033[0m"
