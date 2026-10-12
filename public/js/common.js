// Общие утилиты для всех страниц
window.$ = (sel, root = document) => root.querySelector(sel);
window.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];

window.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// SVG-иконка: ic('mic'), ic('mic', 'sm')
window.ic = (name, size = '') => `<i class="i ${size}" style="--ic:url(/icons/${name}.svg)"></i>`;
// иконки в статичной разметке: <i data-ic="mic"></i>
window.hydrateIcons = (root = document) => {
  for (const el of $$('[data-ic]', root)) {
    el.classList.add('i');
    el.style.setProperty('--ic', `url(/icons/${el.dataset.ic}.svg)`);
  }
};
document.addEventListener('DOMContentLoaded', () => hydrateIcons());

window.toast = (text, ms = 3500) => {
  let wrap = $('.toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), ms);
};

const AVATAR_COLORS = ['linear-gradient(135deg,#f43f5e,#e11d48)', 'linear-gradient(135deg,#fb923c,#ea580c)', 'linear-gradient(135deg,#facc15,#d97706)', 'linear-gradient(135deg,#4ade80,#16a34a)', 'linear-gradient(135deg,#2dd4bf,#0d9488)', 'linear-gradient(135deg,#38bdf8,#0284c7)', 'linear-gradient(135deg,#818cf8,#4f46e5)', 'linear-gradient(135deg,#c084fc,#9333ea)', 'linear-gradient(135deg,#f472b6,#db2777)'];
window.avatarColor = (name) => {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
};
window.initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0]?.toUpperCase() || '').join('') || '?';
window.avatarHtml = (name, cls = 'mini-avatar') => `<div class="${cls}" style="background:${avatarColor(name)}">${esc(initials(name))}</div>`;

window.fmtTime = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
};
window.fmtDate = (iso) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

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

// ---------- Эмодзи ----------
// Коды: обычный символ эмодзи (рисуется картинкой Apple), "pack:имя" (наш набор), "custom:id" (загруженный админом)
window.EMOJI = { pack: [], custom: [] };
window.loadEmojis = async (roomId) => {
  try { window.EMOJI = await api('/api/emojis' + (roomId ? `?room=${encodeURIComponent(roomId)}` : '')); } catch (e) {}
  return window.EMOJI;
};

const APPLE_MAP = new Map();
for (const cat of window.EMOJI_DATA?.categories || []) for (const [ch, img] of cat.items) APPLE_MAP.set(ch, img);
window.QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉', '🔥', '🙏'];

function appleSrc(ch) {
  const known = APPLE_MAP.get(ch) || APPLE_MAP.get(ch.replace(/️/g, ''));
  if (known) return `/apple-emoji/${known}.png`;
  return `/apple-emoji/${[...ch].map((c) => c.codePointAt(0).toString(16)).join('-')}.png`;
}
// если картинки нет — пробуем без FE0F, затем показываем обычный символ
window.emojiFallback = (img) => {
  const alt = img.getAttribute('alt');
  const stripped = `/apple-emoji/${[...alt].map((c) => c.codePointAt(0).toString(16)).filter((c) => c !== 'fe0f').join('-')}.png`;
  if (!img.dataset.retry && !img.src.endsWith(stripped)) { img.dataset.retry = 1; img.src = stripped; return; }
  img.replaceWith(document.createTextNode(alt));
};

window.emojiSrc = (code) => {
  code = String(code);
  if (code.startsWith('pack:')) return `/emoji/pack/${code.slice(5)}.svg`;
  if (code.startsWith('custom:')) return EMOJI.custom.find((x) => x.id === code.slice(7))?.url || '';
  return appleSrc(code);
};
window.emojiHtml = (code, cls = 'emoji-inline') => {
  const src = emojiSrc(code);
  if (!src) return '';
  const isApple = !String(code).includes(':');
  return `<img class="${cls}" src="${esc(src)}" alt="${esc(isApple ? code : ':' + code.split(':')[1] + ':')}" draggable="false"${isApple ? ' onerror="emojiFallback(this)"' : ''}>`;
};

const EMOJI_SEQ = /(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*)/gu;
// текст чата: экранируем, заменяем эмодзи на картинки Apple, а :имя: — на стикеры
window.chatHtml = (text) => {
  let html = esc(text).replace(EMOJI_SEQ, (m) => (/^[©®™]$/.test(m) ? m : emojiHtml(m)));
  html = html.replace(/:([a-z0-9_а-яё-]{1,32}):/gi, (m, name) => {
    name = name.toLowerCase();
    const custom = EMOJI.custom.find((x) => x.name === name);
    if (custom) return emojiHtml('custom:' + custom.id);
    if (EMOJI.pack.some((x) => x.name === name)) return emojiHtml('pack:' + name);
    return m;
  });
  return html;
};
// сообщение только из 1–3 эмодзи показываем крупно
window.isJumbo = (text) => {
  const rest = String(text).replace(EMOJI_SEQ, '').replace(/:[a-z0-9_а-яё-]{1,32}:/gi, '').trim();
  const n = (String(text).match(EMOJI_SEQ) || []).length + (String(text).match(/:[a-z0-9_а-яё-]{1,32}:/gi) || []).length;
  return !rest && n > 0 && n <= 3;
};

// Панель выбора эмодзи. onPick(code, textToInsert)
window.emojiPicker = (anchor, onPick, { quick = false } = {}) => {
  document.querySelector('.emoji-picker')?.remove();
  const tabs = [];
  if (EMOJI.pack.length) tabs.push({ key: 'pack', title: 'Стикеры', icon: emojiSrc('pack:' + EMOJI.pack[0].name), big: true,
    items: EMOJI.pack.map((e) => ({ code: 'pack:' + e.name, text: `:${e.name}:`, title: `:${e.name}:` })) });
  if (EMOJI.custom.length) tabs.push({ key: 'custom', title: 'Свои', icon: EMOJI.custom[0].url, big: true,
    items: EMOJI.custom.map((e) => ({ code: 'custom:' + e.id, text: `:${e.name}:`, title: `:${e.name}:` })) });
  for (const cat of window.EMOJI_DATA?.categories || []) {
    tabs.push({ key: cat.name, title: cat.name, icon: `/apple-emoji/${cat.items[0][1]}.png`, char: cat.items[0][0],
      items: cat.items.map(([ch, img]) => ({ code: ch, text: ch, src: `/apple-emoji/${img}.png` })) });
  }
  const box = document.createElement('div');
  box.className = 'emoji-picker';
  box.innerHTML = `<div class="ep-tabs">${tabs.map((t, i) => `<button data-tab="${i}" title="${esc(t.title)}"><img src="${esc(t.icon)}" alt="${esc(t.char || '')}" ${t.char ? 'onerror="emojiFallback(this)"' : ''}></button>`).join('')}</div>
    <div class="ep-body"></div>
    ${quick ? `<div class="ep-quick">${QUICK_REACTIONS.map((c) => `<button data-code="${c}" data-text="${c}">${emojiHtml(c, '')}</button>`).join('')}</div>` : ''}`;
  const body = $('.ep-body', box);
  const show = (i) => {
    const t = tabs[i];
    $$('.ep-tabs button', box).forEach((b) => b.classList.toggle('active', Number(b.dataset.tab) === i));
    body.classList.toggle('big', !!t.big);
    body.innerHTML = `<div class="ep-title">${esc(t.title)}</div>` + t.items.map((it) =>
      `<button data-code="${esc(it.code)}" data-text="${esc(it.text)}" title="${esc(it.title || '')}"><img src="${esc(it.src || emojiSrc(it.code))}" alt="${esc(it.text)}" loading="lazy" ${it.src ? 'onerror="emojiFallback(this)"' : ''}></button>`).join('');
    body.scrollTop = 0;
  };
  document.body.appendChild(box);
  show(0);
  const r = anchor.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(window.innerWidth - box.offsetWidth - 8, r.left + r.width / 2 - box.offsetWidth / 2)) + 'px';
  box.style.top = Math.max(8, r.top - box.offsetHeight - 10) + 'px';
  box.onclick = (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) return show(Number(tab.dataset.tab));
    const b = e.target.closest('[data-code]');
    if (!b) return;
    onPick(b.dataset.code, b.dataset.text);
    if (quick) box.remove();
  };
  setTimeout(() => document.addEventListener('pointerdown', function close(e) {
    if (!box.contains(e.target) && !anchor.contains(e.target)) { box.remove(); document.removeEventListener('pointerdown', close); }
  }), 0);
};

// ---------- Панель «зал ожидания + участники» ----------
// Используется в админке и в комнате у ведущего.
window.renderControls = (container, state, socket) => {
  const roomId = state.room.id;
  const emit = (ev, args) => socket.emit(ev, { roomId, ...args });
  const visible = state.participants.filter((p) => !p.hidden);
  const permBtn = (p, key) => {
    const allowed = key === 'cam' ? p.allowCam : p.allowMic;
    const icon = key === 'cam' ? (allowed ? 'video' : 'video-off') : (allowed ? 'mic' : 'mic-off');
    const what = key === 'cam' ? 'камеру' : 'микрофон';
    return `<button class="pill-btn ${allowed ? '' : 'off'}" data-act="perm-${key}" data-id="${p.id}" title="${allowed ? 'Запретить' : 'Разрешить'} ${what}">${ic(icon, 'sm')}</button>`;
  };
  const stateIcons = (p) => `<div class="icons small">${p.hand ? ic('hand', 'sm') : ''}${p.mic ? ic('mic', 'sm') : `<span class="off">${ic('mic-off', 'sm')}</span>`}${p.cam ? ic('video', 'sm') : `<span class="faint">${ic('video-off', 'sm')}</span>`}${p.screen ? ic('monitor-up', 'sm') : ''}</div>`;
  container.innerHTML = `
    <div class="section-title"><span>Зал ожидания · ${state.waiting.length}</span>
      ${state.waiting.length > 1 ? `<button class="btn sm ok" data-act="admit-all">${ic('check', 'sm')} Впустить всех</button>` : ''}</div>
    ${state.waiting.length ? `<ul class="plist">${state.waiting.map((w) => `
      <li>${avatarHtml(w.name)}
        <div class="nm"><div>${esc(w.name)}</div><div class="small faint">ждёт с ${new Date(w.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div></div>
        <div class="pctrl"><button class="btn sm ok" data-act="admit" data-id="${w.id}">Впустить</button>
        <button class="btn sm ghost" data-act="deny" data-id="${w.id}" title="Отклонить">${ic('x', 'sm')}</button></div></li>`).join('')}</ul>`
      : '<div class="muted small">Никто не ждёт</div>'}
    <div class="section-title"><span>В комнате · ${visible.length}</span>
      <span class="row" style="gap:4px">
        <button class="pill-btn" data-act="mute-all" title="Выключить микрофоны у всех">${ic('mic-off', 'sm')} всем</button>
        <button class="pill-btn" data-act="cams-off" title="Выключить камеры у всех">${ic('video-off', 'sm')} всем</button>
        <button class="pill-btn" data-act="lower-hands" title="Опустить все руки">${ic('hand', 'sm')}</button></span></div>
    <ul class="plist">${state.participants.map((p) => `
      <li>${avatarHtml(p.name)}
        <div class="nm"><div>${esc(p.name)} ${p.role === 'host' ? `<span class="badge accent">${p.hidden ? 'невидимка' : 'ведущий'}</span>` : ''}</div>${stateIcons(p)}</div>
        ${p.role === 'host' ? '' : `<div class="pctrl">${permBtn(p, 'cam')}${permBtn(p, 'mic')}
          <button class="pill-btn" data-act="kick" data-id="${p.id}" title="Удалить из встречи">${ic('user-x', 'sm')}</button></div>`}
      </li>`).join('') || '<div class="muted small">Пока никого</div>'}</ul>`;

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
      case 'cams-off': emit('admin:cams-off'); break;
      case 'lower-hands': emit('admin:lower-hands'); break;
      case 'kick': if (confirm(`Удалить ${p?.name} из встречи?`)) emit('admin:kick', { id }); break;
      case 'perm-cam': emit('admin:perm', { id, allowCam: !p.allowCam }); break;
      case 'perm-mic': emit('admin:perm', { id, allowMic: !p.allowMic }); break;
    }
  };
};

// Переключатели настроек встречи (общие для пульта и комнаты)
window.ROOM_SWITCHES = [
  ['waitingRoom', 'Зал ожидания', 'Вход только с вашего разрешения'],
  ['locked', 'Закрыть вход', 'Новые участники не смогут войти'],
  ['allowCamera', 'Камеры участников', 'Разрешено включать камеру'],
  ['allowMic', 'Микрофоны участников', 'Разрешено включать микрофон'],
  ['allowChat', 'Чат', 'Участники могут писать в чат'],
  ['allowReactions', 'Реакции', 'Участники могут отправлять эмодзи'],
];
window.switchesHtml = (settings, attr = 'data-set') => ROOM_SWITCHES.map(([k, title, desc]) => `
  <label class="switch"><span class="txt"><b>${title}</b><span>${desc}</span></span>
  <input type="checkbox" ${attr}="${k}" ${settings[k] ? 'checked' : ''}><span class="knob"></span></label>`).join('');
