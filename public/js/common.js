// Общие утилиты для всех страниц
window.$ = (sel, root = document) => root.querySelector(sel);
window.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];

window.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

window.toast = (text, ms = 3500) => {
  let wrap = $('.toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), ms);
};

const AVATAR_COLORS = ['#e5484d', '#f76b15', '#ffb224', '#30a46c', '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#ab4aba'];
window.avatarColor = (name) => {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
};
window.initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';

window.fmtTime = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
};

window.api = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка ' + res.status);
  return data;
};

// Отрисовка панели «зал ожидания + участники» с кнопками управления.
// Используется в админке и в комнате у ведущего.
window.renderControls = (container, state, socket) => {
  const roomId = state.room.id;
  const emit = (ev, args) => socket.emit(ev, { roomId, ...args });
  const visible = state.participants.filter((p) => !p.hidden);
  const permBtn = (p, key, label) => {
    const allowed = key === 'cam' ? p.allowCam : p.allowMic;
    return `<button class="btn sm ${allowed ? '' : 'danger'}" data-act="perm-${key}" data-id="${p.id}" title="${allowed ? 'Запретить' : 'Разрешить'} ${label}">${key === 'cam' ? '📷' : '🎤'} ${allowed ? 'вкл' : 'запрещ.'}</button>`;
  };
  container.innerHTML = `
    <div class="section-title"><span>Зал ожидания (${state.waiting.length})</span>
      ${state.waiting.length > 1 ? '<button class="btn sm ok" data-act="admit-all">Впустить всех</button>' : ''}</div>
    ${state.waiting.length ? `<ul class="plist">${state.waiting.map((w) => `
      <li><div class="mini-avatar" style="background:${avatarColor(w.name)}">${esc(initials(w.name))}</div>
        <div class="nm">${esc(w.name)}</div>
        <div class="pctrl"><button class="btn sm ok" data-act="admit" data-id="${w.id}">Впустить</button>
        <button class="btn sm" data-act="deny" data-id="${w.id}">Отклонить</button></div></li>`).join('')}</ul>`
      : '<div class="muted small">Никто не ждёт</div>'}
    <div class="section-title"><span>Участники (${visible.length})</span>
      <span class="row"><button class="btn sm" data-act="mute-all">🔇 Всем выкл. микрофон</button>
      <button class="btn sm" data-act="lower-hands">✋ Опустить руки</button></span></div>
    <ul class="plist">${state.participants.map((p) => `
      <li><div class="mini-avatar" style="background:${avatarColor(p.name)}">${esc(initials(p.name))}</div>
        <div class="nm">${esc(p.name)} ${p.role === 'host' ? `<span class="badge">${p.hidden ? 'наблюдатель' : 'ведущий'}</span>` : ''}
          <div class="icons small">${p.hand ? '✋' : ''}<span>${p.mic ? '🎤' : '🔇'}</span><span>${p.cam ? '📷' : '<span class="muted">📷✕</span>'}</span></div></div>
        ${p.role === 'host' ? '' : `<div class="pctrl">${permBtn(p, 'cam', 'камеру')}${permBtn(p, 'mic', 'микрофон')}
          <button class="btn sm" data-act="kick" data-id="${p.id}" title="Удалить из встречи">✕</button></div>`}
      </li>`).join('')}</ul>`;

  container.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    const p = state.participants.find((x) => x.id === id);
    switch (b.dataset.act) {
      case 'admit': emit('admin:admit', { id }); break;
      case 'deny': emit('admin:deny', { id }); break;
      case 'admit-all': emit('admin:admit-all'); break;
      case 'mute-all': emit('admin:mute-all'); break;
      case 'lower-hands': emit('admin:lower-hands'); break;
      case 'kick': if (confirm(`Удалить ${p?.name} из встречи?`)) emit('admin:kick', { id }); break;
      case 'perm-cam': emit('admin:perm', { id, allowCam: !p.allowCam }); break;
      case 'perm-mic': emit('admin:perm', { id, allowMic: !p.allowMic }); break;
    }
  };
};

// ---------- Эмодзи ----------
window.EMOJI = { standard: [], custom: [] };
window.loadEmojis = async () => {
  try { window.EMOJI = await api('/api/emojis'); } catch (e) {}
  return window.EMOJI;
};
// код реакции: обычный символ или "custom:<id>"
window.emojiHtml = (code, cls = 'emoji') => {
  if (String(code).startsWith('custom:')) {
    const e = EMOJI.custom.find((x) => x.id === code.slice(7));
    return e ? `<img class="${cls}" src="${esc(e.url)}" alt=":${esc(e.name)}:" title=":${esc(e.name)}:">` : '';
  }
  return `<span class="${cls}">${esc(code)}</span>`;
};
// текст чата: экранируем и заменяем :имя: на картинки
window.chatHtml = (text) => esc(text).replace(/:([a-z0-9_а-яё-]{1,32}):/gi, (m, name) => {
  const e = EMOJI.custom.find((x) => x.name === name.toLowerCase());
  return e ? `<img class="emoji-inline" src="${esc(e.url)}" alt=":${esc(e.name)}:" title=":${esc(e.name)}:">` : m;
});
// всплывающая панель выбора эмодзи
window.emojiPicker = (anchor, onPick, { withNames = false } = {}) => {
  document.querySelector('.emoji-picker')?.remove();
  const box = document.createElement('div');
  box.className = 'emoji-picker';
  box.innerHTML = EMOJI.standard.map((c) => `<button data-code="${esc(c)}">${emojiHtml(c)}</button>`).join('') +
    (EMOJI.custom.length ? '<div class="sep"></div>' + EMOJI.custom.map((e) =>
      `<button data-code="custom:${e.id}" data-name="${esc(e.name)}">${emojiHtml('custom:' + e.id)}</button>`).join('') : '');
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(window.innerWidth - box.offsetWidth - 8, r.left + r.width / 2 - box.offsetWidth / 2)) + 'px';
  box.style.top = Math.max(8, r.top - box.offsetHeight - 8) + 'px';
  box.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    onPick(b.dataset.code, b.dataset.name);
    box.remove();
  };
  setTimeout(() => document.addEventListener('click', function close(e) {
    if (!box.contains(e.target)) { box.remove(); document.removeEventListener('click', close); }
  }), 0);
};
