// Проверка связи: host / STUN / TURN (UDP/TCP) через сбор ICE-кандидатов
(() => {
  const TIMEOUT = 7000;

  // протокол до TURN-сервера для relay-кандидата
  const relayProto = (c, url) => {
    if (c.relayProtocol) return c.relayProtocol === 'udp' ? 'udp' : 'tcp';
    // url сервера, через который получен кандидат (Chrome)
    const m = /transport=(udp|tcp)/i.exec(url || '');
    if (url && /^turns:/i.test(url)) return 'tcp';
    if (m) return m[1].toLowerCase();
    // по приоритету: старший байт = type preference (2 — UDP, 1 — TCP, 0 — TLS)
    const pr = Number(c.priority ?? (String(c.candidate).split(' ')[3]));
    if (Number.isFinite(pr)) return (pr >>> 24) >= 2 ? 'udp' : 'tcp';
    return 'udp';
  };

  // тип кандидата: из поля или из строки candidate
  const candType = (c) => {
    if (c.type) return c.type;
    const m = / typ (\w+)/.exec(c.candidate || '');
    return m ? m[1] : '';
  };

  // сбор кандидатов одним PeerConnection
  const gather = (config) => new Promise((resolve) => {
    const out = { cands: [], error: '' };
    let pc;
    let done = false;
    let timer;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { pc && pc.close(); } catch (e) { /* ignore */ }
      resolve(out);
    };
    try {
      pc = new RTCPeerConnection(config);
      timer = setTimeout(finish, TIMEOUT);
      pc.onicecandidate = (e) => {
        if (!e.candidate) return finish();
        if (!e.candidate.candidate) return;
        out.cands.push({ c: e.candidate, url: e.url || '' });
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      pc.onicecandidateerror = (e) => {
        // ошибки отдельных серверов не фатальны — запоминаем первую
        if (!out.error && e && e.errorText) out.error = `${e.url || ''} ${e.errorCode || ''} ${e.errorText}`.trim();
      };
      pc.createDataChannel('t');
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .catch((err) => { out.error = String(err && err.message || err); finish(); });
    } catch (err) {
      out.error = String(err && err.message || err);
      finish();
    }
  });

  const urlsOf = (servers) => (servers || []).flatMap((s) => [].concat(s && s.urls || s && s.url || []));

  const run = async (iceServers) => {
    const t0 = performance.now();
    const res = { host: false, stun: false, turn: false, turnConfigured: false, turnUdp: false, turnTcp: false, ms: 0 };
    try {
      if (typeof RTCPeerConnection === 'undefined') throw new Error('WebRTC не поддерживается браузером');
      const servers = Array.isArray(iceServers) ? iceServers : [];
      res.turnConfigured = urlsOf(servers).some((u) => /^turns?:/i.test(String(u)));
      // обычный сбор и (если есть TURN) только relay — параллельно
      const [all, relay] = await Promise.all([
        gather({ iceServers: servers }),
        res.turnConfigured ? gather({ iceServers: servers, iceTransportPolicy: 'relay' }) : null,
      ]);
      const classify = (list) => {
        for (const { c, url } of list) {
          const t = candType(c);
          if (t === 'host') res.host = true;
          else if (t === 'srflx' || t === 'prflx') res.stun = true;
          else if (t === 'relay') {
            res.turn = true;
            if (relayProto(c, url) === 'udp') res.turnUdp = true;
            else res.turnTcp = true;
          }
        }
      };
      classify(all.cands);
      if (relay) classify(relay.cands);
      // ошибка relay-прохода важнее (он говорит о TURN)
      const errs = [relay && relay.error, all.error].filter(Boolean);
      const failed = !res.host && !res.stun && !res.turn;
      if (errs.length && (failed || (res.turnConfigured && !res.turn))) res.error = errs[0];
    } catch (err) {
      res.error = String(err && err.message || err);
    }
    res.ms = Math.round(performance.now() - t0);
    return res;
  };

  // строка отчёта: иконка + бейдж
  const line = (state, title, note) => {
    const icon = state === 'ok' ? 'check' : state === 'warn' ? 'triangle-alert' : 'x';
    const label = state === 'ok' ? 'есть' : 'нет';
    return `<div class="row nowrap between" style="padding:8px 0;border-bottom:1px solid var(--line)">
      <span class="grow">${esc(title)}${note ? `<br><span class="small faint">${esc(note)}</span>` : ''}</span>
      <span class="badge ${state === 'bad' ? 'live' : state}">${ic(icon, 'sm')}${esc(label)}</span>
    </div>`;
  };

  const render = (container, r) => {
    if (!container) return;
    r = r || {};
    const net = r.stun || r.host;
    const turnNote = r.turnConfigured
      ? (r.turn ? [r.turnUdp && 'UDP', r.turnTcp && 'TCP'].filter(Boolean).join(' + ') : 'сервер не ответил')
      : 'не настроен';
    const turnState = r.turn ? 'ok' : r.turnConfigured ? 'bad' : 'warn';

    let verdict;
    let vState;
    if (!r.stun && r.turn) {
      // прямого пути нет, но резервный сервер работает — видео пойдёт через него
      verdict = 'Связь в порядке (через резервный сервер)';
      vState = 'ok';
    } else if (!r.stun) {
      verdict = 'Похоже, сеть блокирует видеосвязь — попробуйте другой Wi‑Fi или мобильный интернет';
      vState = 'bad';
    } else if (r.turnConfigured && !r.turn) {
      verdict = 'Резервный сервер недоступен — у участников за строгими сетями (мобильный интернет, офисный Wi‑Fi) может не быть видео. Сообщите администратору.';
      vState = 'warn';
    } else {
      verdict = 'Связь в порядке';
      vState = 'ok';
    }
    const vIcon = vState === 'ok' ? 'check' : 'triangle-alert';
    const vColor = vState === 'ok' ? 'var(--ok)' : vState === 'warn' ? 'var(--warn)' : 'var(--danger)';

    // бейдж .live имеет пульсирующую точку — заменяем на статичный красный
    const badStyle = '<style>.ct-report .badge.live::before{display:none}</style>';

    container.innerHTML = `${badStyle}<div class="ct-report">
      ${line(r.stun ? 'ok' : net ? 'warn' : 'bad', 'Интернет-соединение', r.stun ? '' : (r.host ? 'только локальная сеть' : ''))}
      ${line(r.stun ? 'ok' : 'bad', 'Прямое соединение с участниками (STUN)')}
      ${line(turnState, 'Резервный сервер TURN (UDP/TCP)', turnNote)}
      <div class="row nowrap" style="margin-top:12px;align-items:flex-start;color:${vColor}">
        ${ic(vIcon)}<span class="grow" style="font-weight:600">${esc(verdict)}</span>
      </div>
      <div class="small faint" style="margin-top:8px">Проверка заняла ${esc((r.ms / 1000 || 0).toFixed(1))} с${r.error ? ` · <span class="mono">${esc(r.error)}</span>` : ''}</div>
    </div>`;
  };

  window.ConnTest = { run, render };
})();
