#!/usr/bin/env bash
# Быстрые команды для сервиса видеовстреч. Устанавливается в /usr/local/bin/video.
#   video update | restart | stop | start | status | logs | url | password <новый> | help
# Обновление меняет только код приложения — Caddy и другие проекты не трогаются.
set -euo pipefail

APP_DIR=/opt/conference
ENV_FILE=/etc/conference.env
APP_USER=conference
BRANCH="${BRANCH:-claude/video-conference-recording-service-4y8f5m}"

say() { echo -e "\033[1;34m==> $*\033[0m"; }
ok() { echo -e "\033[1;32m$*\033[0m"; }
die() { echo -e "\033[1;31mОшибка: $*\033[0m" >&2; exit 1; }

# video-update == video update
cmd="${1:-help}"
[ "$(basename "$0")" = "video-update" ] && cmd=update

if [ "$(id -u)" -ne 0 ] && [ "$cmd" != help ]; then exec sudo "$0" "$@"; fi

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
    ;;
  restart) systemctl restart conference; check_alive ;;
  start)   systemctl start conference; check_alive ;;
  stop)    systemctl stop conference; ok "Сервис остановлен. Запустить: video start" ;;
  status)  systemctl status conference --no-pager -l | head -15 ;;
  logs)    journalctl -u conference -f -n 50 ;;
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
  video url         — показать адрес сайта и админки
  video password    — сменить пароль админки
EOF
    ;;
esac
