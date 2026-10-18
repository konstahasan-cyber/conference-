// Пульт управления встречей
const roomId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop());
const socket = io();
const emit = (ev, args = {}) => socket.emit(ev, { roomId, ...args }, (res) => res?.error && toast(res.error));
let state = null;
let formFilled = false;
let pbRecv = 0;
let seeking = false;

const inviteUrl = `${location.origin}/r/${roomId}`;
$('#inviteLink').value = inviteUrl;
$('#roomCode').textContent = roomId;
$('#enterBtn').href = `/r/${roomId}?live=1`;
$('#observeBtn').href = `/r/${roomId}`;
$('#copyLink').onclick = async () => { await navigator.clipboard.writeText(inviteUrl).catch(() => {}); toast('Ссылка скопирована'); };

socket.on('connect', () => emit('admin:watch'));
socket.on('admin:state', (st) => {
  if (!st.room) return;
  state = st;
  render();
});
socket.on('emojis-updated', () => loadEmojis());
loadEmojis();

$('#endBtn').onclick = () => { if (confirm('Завершить встречу для всех участников?')) emit('admin:end'); };
$('#dupBtn').onclick = async () => {
  const room = await api(`/api/rooms/${roomId}/duplicate`, { method: 'POST' });
  toast('Копия создана — открываю её пульт');
  setTimeout(() => (location.href = `/admin/room/${room.id}`), 700);
};

$('#saveName').onclick = async () => {
  await api(`/api/rooms/${roomId}`, { method: 'PUT', body: { name: $('#roomName').value } });
  toast('Сохранено');
};

async function fillPlaybackForm() {
  formFilled = true;
  const recs = await api('/api/recordings');
  renderPlaybackForm($('#pbForm'), state.room.playback, recs);
}

$('#pbSave').onclick = async () => {
  const playback = readPlaybackForm($('#pbForm'));
  const err = validatePlayback(playback);
  if (err) return toast(err);
  try {
    await api(`/api/rooms/${roomId}`, { method: 'PUT', body: { playback } });
    toast('Настройки показа сохранены');
  } catch (e) { toast(e.message); }
};

$('#pbStart').onclick = () => {
  const recordingId = $('[data-f=recordingId]')?.value || state.room.playback.recordingId;
  if (!recordingId) return toast('Выберите запись');
  if (state.playback.status === 'playing' && !confirm('Запись уже идёт. Запустить заново с начала?')) return;
  emit('admin:playback', { action: 'start', recordingId });
};
$('#pbPause').onclick = () => emit('admin:playback', { action: 'pause' });
$('#pbResume').onclick = () => emit('admin:playback', { action: 'resume' });
$('#pbStop').onclick = () => { if (confirm('Остановить показ записи у всех?')) emit('admin:playback', { action: 'stop' }); };
$('#pbSeek').oninput = () => { seeking = true; $('#pbPos').textContent = fmtTime($('#pbSeek').value); };
$('#pbSeek').onchange = () => { seeking = false; emit('admin:playback', { action: 'seek', position: Number($('#pbSeek').value) }); };
$('#pbReact').onclick = () => emojiPicker($('#pbReact'), (code) => emit('admin:reaction', { emoji: code }), { quick: true });

function pbPosition() {
  const p = state.playback;
  return p.position + (p.status === 'playing' ? (performance.now() - pbRecv) / 1000 : 0);
}

// ---------- Показ в Zoom ----------
let zoomFilled = false;
async function saveZoom(patch) {
  try {
    await api(`/api/rooms/${roomId}`, { method: 'PUT', body: { zoom: patch } });
    toast('Сохранено');
  } catch (e) { toast(e.message); }
}
$('#zoomSave').onclick = () => saveZoom({ link: $('#zoomLink').value });
$('#zoomEnabled').onchange = () => {
  if ($('#zoomEnabled').checked && !$('#zoomLink').value.trim()) toast('Вставьте ссылку-приглашение Zoom');
  saveZoom({ enabled: $('#zoomEnabled').checked, link: $('#zoomLink').value });
};

$('#zoomAuto').onchange = async () => {
  const on = $('#zoomAuto').checked;
  if (on) toast('Создаю встречу в Zoom…');
  try {
    const room = await api(`/api/rooms/${roomId}`, { method: 'PUT', body: { zoom: { auto: on, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } } });
    if (on && room.zoom.link && !room.zoom.syncError) { $('#zoomLink').value = room.zoom.link; toast('Встреча в Zoom создана — ссылка ниже'); }
    else if (room.zoom.syncError) toast(room.zoom.syncError, 6000);
  } catch (e) { toast(e.message); }
};
$('#zoomInvite').onclick = () => state && copyText(inviteText({ ...state.room, nextStart: state.room.nextStart }), 'Приглашение скопировано');

$('#zoomTest').onclick = () => emit('admin:zoom-test', { on: !state?.zoomTest });

function renderZoom() {
  const z = state.room.zoom || { enabled: false, link: '' };
  if (!zoomFilled || (z.auto && document.activeElement !== $('#zoomLink'))) { $('#zoomLink').value = z.link || ''; zoomFilled = true; }
  $('#zoomEnabled').checked = !!z.enabled;
  $('#zoomAuto').checked = !!z.auto;
  $('#zoomLink').readOnly = !!z.auto;
  $('#zoomSave').classList.toggle('hidden', !!z.auto);
  $('#zoomSyncErr').classList.toggle('hidden', !z.syncError);
  $('#zoomSyncErr').textContent = z.syncError ? 'Zoom: ' + z.syncError : '';
  $('#zoomTest').innerHTML = state.zoomTest ? `${ic('square')}Закончить тест` : `${ic('play')}Тест без входа в Zoom`;
  $('#zoomTestHint').textContent = state.zoomTest ? 'Тест: запись идёт в OBS, в Zoom пульт не заходит. Смотрите окно OBS на сервере.' : '';
  const r = state.zoomRunner || { online: false };
  const yes = (b) => (b ? '✅' : '❌');
  $('#zrBadge').className = 'badge ' + (r.online ? (r.state === 'error' ? 'live' : 'ok') : 'warn');
  $('#zrBadge').textContent = r.online ? `пульт: ${({ idle: 'ждёт', starting: 'запускает', playing: 'в эфире', paused: 'пауза', ending: 'выходит', error: 'ошибка' })[r.state] || r.state}` : 'пульт не подключён';
  $('#zrStatus').innerHTML = !r.online
    ? '<span class="muted">Zoom-пульт не отвечает. На сервере: войдите по RDP под пользователем с Zoom и выполните <code>video zoom status</code>.</span>'
    : `${r.message ? `<div style="margin-bottom:6px">${esc(r.message)}</div>` : ''}<div class="row muted" style="gap:14px">
        <span>${yes(r.obs?.connected)} OBS</span><span>${yes(r.obs?.virtualCam)} виртуальная камера</span>
        <span>${yes(/cable/i.test(r.obs?.monitorDevice || ''))} звук в Zoom (CABLE)</span>
        <span>${yes(r.zoom?.inMeeting)} во встрече Zoom</span>
        ${r.media?.cursor != null ? `<span>⏱ ${fmtTime(r.media.cursor)}</span>` : ''}</div>`;
}

function render() {
  const { room, playback } = state;
  $('#roomTitle').textContent = room.name;
  document.title = 'Пульт: ' + room.name;
  if (document.activeElement !== $('#roomName')) $('#roomName').value = room.name;
  if (!$('#switches').children.length) {
    $('#switches').innerHTML = switchesHtml(room.settings);
    $$('[data-set]').forEach((el) => (el.onchange = () => emit('admin:settings', { settings: { [el.dataset.set]: el.checked } })));
  }
  $$('[data-set]').forEach((el) => (el.checked = !!room.settings[el.dataset.set]));
  renderControls($('#controls'), state, socket);
  renderZoom();
  if (!formFilled) fillPlaybackForm();
  if (!$('#chatAs').value) $('#chatAs').value = room.playback.presenterName || 'Организатор';
  $('#schedInfo').innerHTML = `${ic('clock', 'sm')} ${scheduleText(room.playback, room.nextStart)}`;

  const n = state.participants.filter((p) => !p.hidden).length;
  $('#liveBadge').className = n ? 'badge ok' : 'badge';
  $('#liveBadge').innerHTML = `${ic('users', 'sm')} ${n} в комнате${state.waiting.length ? ` · ${state.waiting.length} ждут` : ''}`;

  pbRecv = performance.now();
  const labels = { idle: '<span class="badge">не запущена</span>', playing: '<span class="badge live">в эфире</span>', paused: '<span class="badge warn">на паузе</span>', ended: '<span class="badge">закончилась</span>' };
  $('#pbStatus').innerHTML = (labels[playback.status] || '') + (playback.title ? ` <span class="muted">${esc(playback.title)}</span>` : '');
  $('#pbPause').disabled = playback.status !== 'playing';
  $('#pbResume').disabled = playback.status !== 'paused';
  $('#pbStop').disabled = playback.status === 'idle';
  $('#pbSeek').disabled = !['playing', 'paused'].includes(playback.status);

  const pv = $('#pbPreview');
  if (playback.url && ['playing', 'paused'].includes(playback.status)) {
    const abs = new URL(pickMediaUrl(playback.url, playback.altUrl), location.href).href;
    if (pv.src !== abs) pv.src = abs;
  } else if (pv.src) { pv.removeAttribute('src'); pv.load(); }
  syncPreview(true);

  const list = $('#chatList');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.innerHTML = state.chat.map((m) => `<div class="chat-msg">${avatarHtml(m.name)}<div class="grow"><div class="who"><b>${esc(m.name)}</b>${new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div><div class="txt ${isJumbo(m.text) ? 'jumbo' : ''}">${chatHtml(m.text)}</div></div></div>`).join('') || '<div class="muted small">Сообщений пока нет</div>';
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function syncPreview(force) {
  if (!state) return;
  const p = state.playback;
  const pv = $('#pbPreview');
  const dur = p.duration || (isFinite(pv.duration) ? pv.duration : 0);
  const pos = Math.min(pbPosition(), dur || Infinity);
  $('#pbDur').textContent = fmtTime(dur);
  $('#pbSeek').max = Math.max(1, Math.floor(dur));
  if (!seeking) { $('#pbSeek').value = pos; $('#pbPos').textContent = fmtTime(pos); }
  if (!pv.src || pv.readyState < 1) return;
  if (force || Math.abs(pv.currentTime - pos) > 2) pv.currentTime = pos;
  if (p.status === 'playing' && pv.paused && pos < (dur || Infinity)) pv.play().catch(() => {});
  if (p.status !== 'playing' && !pv.paused) pv.pause();
}
$('#pbPreview').onloadedmetadata = () => syncPreview(true);
$('#pbListen').onclick = () => {
  const pv = $('#pbPreview');
  pv.muted = !pv.muted;
  if (!pv.muted) pv.play().catch(() => {});
  $('#pbListen').innerHTML = pv.muted ? `${ic('volume-x', 'sm')}Включить звук` : `${ic('volume-2', 'sm')}Выключить звук`;
};
setInterval(() => syncPreview(false), 1000);

$('#chatEmoji').onclick = () => emojiPicker($('#chatEmoji'), (code, text) => { $('#chatText').value += text; $('#chatText').focus(); });
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chatText').value.trim();
  if (!text) return;
  emit('admin:chat', { text, as: $('#chatAs').value });
  $('#chatText').value = '';
};
