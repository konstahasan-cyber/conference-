'use strict';
// Минимальный клиент obs-websocket v5 (встроен в OBS Studio 28+). Без внешних зависимостей:
// в Node 22 есть глобальный WebSocket.
const crypto = require('node:crypto');

const CLOSE_REASONS = {
  4009: 'неверный пароль obs-websocket (Инструменты → Настройки сервера WebSocket)',
  4010: 'версия протокола obs-websocket не поддерживается',
  4011: 'OBS отключил клиента',
};

function sha256b64(s) {
  return crypto.createHash('sha256').update(s).digest('base64');
}

class ObsClient {
  constructor({ url, password, timeoutMs = 10_000 }) {
    this.url = url;
    this.password = password || '';
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.identified = false;
    this.pending = new Map();
    this.seq = 0;
    this.info = null;
    this.onDisconnect = null;
  }

  get connected() {
    return !!this.ws && this.identified;
  }

  connect(timeoutMs = 5000) {
    if (this.connected) return Promise.resolve(this.info);
    this.close();
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      const done = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          try { ws && ws.close(); } catch {}
          if (this.ws === ws) this.ws = null;
          this.identified = false;
          reject(err);
        } else resolve(val);
      };
      const timer = setTimeout(() => done(new Error('нет ответа от OBS (тайм-аут подключения)')), timeoutMs);
      try {
        ws = new WebSocket(this.url, 'obswebsocket.json');
      } catch (e) {
        return done(new Error('не удалось подключиться к OBS: ' + e.message));
      }
      this.ws = ws;
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.op === 0) {
          const d = msg.d || {};
          const ident = { rpcVersion: 1, eventSubscriptions: 0 };
          if (d.authentication) {
            if (!this.password) return done(new Error('OBS требует пароль obs-websocket, а в конфиге он не указан (obsPassword)'));
            const secret = sha256b64(this.password + d.authentication.salt);
            ident.authentication = sha256b64(secret + d.authentication.challenge);
          }
          this.info = { obsWebSocketVersion: d.obsWebSocketVersion, rpcVersion: d.rpcVersion };
          ws.send(JSON.stringify({ op: 1, d: ident }));
        } else if (msg.op === 2) {
          this.identified = true;
          done(null, this.info);
        } else if (msg.op === 7) {
          const d = msg.d || {};
          const p = this.pending.get(d.requestId);
          if (!p) return;
          this.pending.delete(d.requestId);
          clearTimeout(p.timer);
          const st = d.requestStatus || {};
          if (st.result) p.resolve(d.responseData || {});
          else {
            const e = new Error(`OBS: ${d.requestType} — ${st.comment || 'ошибка'} (код ${st.code})`);
            e.code = st.code;
            p.reject(e);
          }
        }
      };
      const teardown = (code) => {
        const wasIdentified = this.identified && this.ws === ws;
        if (this.ws === ws) { this.ws = null; this.identified = false; }
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('соединение с OBS разорвано'));
          this.pending.delete(id);
        }
        const reason = CLOSE_REASONS[code];
        done(new Error(reason ? 'OBS: ' + reason : 'не удалось подключиться к OBS (websocket ' + this.url + ')'));
        if (wasIdentified && this.onDisconnect) {
          try { this.onDisconnect(reason || null); } catch {}
        }
      };
      // при отказе в соединении Node 22 присылает только error, без close
      ws.onerror = () => setTimeout(() => { teardown(null); try { ws.close(); } catch {} }, 50); // close с кодом (если будет) важнее
      ws.onclose = (ev) => teardown(ev && ev.code);
    });
  }

  request(requestType, requestData, timeoutMs = this.timeoutMs) {
    if (!this.connected) return Promise.reject(new Error('нет соединения с OBS'));
    const requestId = 'r' + ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS не ответил на ${requestType} за ${Math.round(timeoutMs / 1000)} с`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData: requestData || {} } }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('не удалось отправить запрос в OBS: ' + e.message));
      }
    });
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.identified = false;
    if (ws) { try { ws.close(); } catch {} }
  }
}

const MEDIA = {
  RESTART: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
  PLAY: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
  PAUSE: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
  STOP: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
};

module.exports = { ObsClient, MEDIA, sha256b64 };
