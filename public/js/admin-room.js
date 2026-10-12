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
$('#enterBtn').href = `/r/${roomId}`;
$('#copyLink').onclick = async () => { await navigator.clipboard.writeText(inviteUrl).catch(() => {}); toast('Ссылка скопирована'); };

socket.on('connect', () => emit('admin:watch'));
socket.on('admin:state', (st) => {
  if (!st.room) return;
  state = st;
  render();
});

$('#endBtn').onclick = () => { if (confirm('Завершить встречу для всех участников?')) emit('admin:end'); };

$('#saveName').onclick = async () => {
  await api(`/api/rooms/${roomId}`, { method: 'PUT', body: { name: $('#roomName').value } });
  toast('Сохранено');
};

$$('[data-set]').forEach((el) => {
  el.onchange = () => emit('admin:settings', { settings: { [el.dataset.set]: el.checked } });
});

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

async function fillPlaybackForm() {
  const recs = await api('/api/recordings');
  const pb = state.room.playback;
  $('#pbRec').innerHTML = '<option value="">— не выбрана —</option>' +
    recs.map((r) => `<option value="${r.id}">${esc(r.title)}${r.duration ? ' (' + fmtTime(r.duration) + ')' : ''}</option>`).join('');
  $('#pbRec').value = pb.recordingId || '';
  $$('input[name=pbDisplay]').forEach((r) => (r.checked = r.value === pb.display));
  $$('input[name=pbMode]').forEach((r) => (r.checked = r.value === pb.startMode));
  $('#pbName').value = pb.presenterName;
  $('#pbShowBefore').checked = pb.showPresenterBeforeStart;
  $('#pbAt').value = toLocalInput(pb.startAt);
  $('#pbDelay').value = pb.delaySec;
  $('#pbEnd').value = pb.endAction;
  formFilled = true;
}

$('#pbAt').onfocus = () => ($('input[name=pbMode][value=scheduled]').checked = true);
$('#pbDelay').onfocus = () => ($('input[name=pbMode][value=firstGuest]').checked = true);

$('#pbSave').onclick = async () => {
  const mode = $('input[name=pbMode]:checked')?.value || 'manual';
  if (mode === 'scheduled' && !$('#pbAt').value) return toast('Укажите дату и время старта');
  if (mode !== 'manual' && !$('#pbRec').value) return toast('Выберите запись');
  await api(`/api/rooms/${roomId}`, {
    method: 'PUT',
    body: {
      playback: {
        recordingId: $('#pbRec').value || null,
        display: $('input[name=pbDisplay]:checked')?.value,
        presenterName: $('#pbName').value,
        showPresenterBeforeStart: $('#pbShowBefore').checked,
        startMode: mode,
        startAt: $('#pbAt').value ? new Date($('#pbAt').value).toISOString() : null,
        delaySec: $('#pbDelay').value,
        endAction: $('#pbEnd').value,
      },
    },
  });
  toast('Настройки показа сохранены');
};

$('#pbStart').onclick = () => {
  const recordingId = $('#pbRec').value || state.room.playback.recordingId;
  if (!recordingId) return toast('Выберите запись');
  if (state.playback.status === 'playing' && !confirm('Запись уже идёт. Запустить заново с начала?')) return;
  emit('admin:playback', { action: 'start', recordingId });
};
$('#pbPause').onclick = () => emit('admin:playback', { action: 'pause' });
$('#pbResume').onclick = () => emit('admin:playback', { action: 'resume' });
$('#pbStop').onclick = () => { if (confirm('Остановить показ записи у всех?')) emit('admin:playback', { action: 'stop' }); };
$('#pbSeek').oninput = () => { seeking = true; $('#pbPos').textContent = fmtTime($('#pbSeek').value); };
$('#pbSeek').onchange = () => { seeking = false; emit('admin:playback', { action: 'seek', position: Number($('#pbSeek').value) }); };

function pbPosition() {
  const p = state.playback;
  return p.position + (p.status === 'playing' ? (performance.now() - pbRecv) / 1000 : 0);
}

function render() {
  const { room, playback } = state;
  $('#roomTitle').textContent = room.name;
  document.title = 'Управление: ' + room.name;
  if (document.activeElement !== $('#roomName')) $('#roomName').value = room.name;
  $$('[data-set]').forEach((el) => (el.checked = !!room.settings[el.dataset.set]));
  renderControls($('#controls'), state, socket);
  if (!formFilled) fillPlaybackForm();
  if (!$('#chatAs').value) $('#chatAs').value = room.playback.presenterName || 'Организатор';

  pbRecv = performance.now();
  const labels = { idle: 'не запущена', playing: '<span class="badge live">идёт</span>', paused: '<span class="badge warn">на паузе</span>', ended: '<span class="badge">закончилась</span>' };
  $('#pbStatus').innerHTML = (labels[playback.status] || '') + (playback.title ? ` — ${esc(playback.title)}` : '');
  $('#pbPause').disabled = playback.status !== 'playing';
  $('#pbResume').disabled = playback.status !== 'paused';
  $('#pbStop').disabled = playback.status === 'idle';
  $('#pbSeek').disabled = !['playing', 'paused'].includes(playback.status);

  const pv = $('#pbPreview');
  if (playback.url && ['playing', 'paused'].includes(playback.status)) {
    const abs = new URL(playback.url, location.href).href;
    if (pv.src !== abs) pv.src = abs;
  } else if (pv.src) { pv.removeAttribute('src'); pv.load(); }
  syncPreview(true);

  $('#chatList').innerHTML = state.chat.map((m) => `<div class="chat-msg"><div class="who"><b>${esc(m.name)}</b> · ${new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div><div class="txt">${chatHtml(m.text)}</div></div>`).join('') || '<div class="muted small">Сообщений пока нет</div>';
  $('#chatList').scrollTop = $('#chatList').scrollHeight;
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
setInterval(() => syncPreview(false), 1000);

loadEmojis();
socket.on('emojis-updated', () => loadEmojis());
$('#pbReact').onclick = (e) => {
  e.stopPropagation();
  emojiPicker($('#pbReact'), (code) => emit('admin:reaction', { emoji: code }));
};
$('#chatEmoji').onclick = (e) => {
  e.stopPropagation();
  emojiPicker($('#chatEmoji'), (code, name) => { $('#chatText').value += name ? `:${name}:` : code; $('#chatText').focus(); });
};

$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chatText').value.trim();
  if (!text) return;
  emit('admin:chat', { text, as: $('#chatAs').value });
  $('#chatText').value = '';
};
