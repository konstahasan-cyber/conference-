// Админ-панель: встречи, записи, студия, эмодзи, настройки по умолчанию, админы
const tabs = ['rooms', 'recordings', 'studio', 'emojis', 'defaults', 'admins'];
let me = null;
let recordings = [];

function openTab(name) {
  if (name === 'admins' && me?.role !== 'owner') name = 'rooms';
  $$('.nav-item[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  tabs.forEach((t) => $(`#tab-${t}`).classList.toggle('hidden', t !== name));
  history.replaceState(null, '', '#' + name);
  ({ rooms: loadRooms, recordings: loadRecordings, emojis: loadEmojiTab, defaults: loadDefaults, admins: loadUsers }[name] || (() => {}))();
}
$$('.nav-item[data-tab]').forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };

// ---------- Встречи ----------
async function loadRooms() {
  const [rooms, recs] = await Promise.all([api('/api/rooms'), api('/api/recordings')]);
  recordings = recs;
  $('#roomsEmpty').classList.toggle('hidden', rooms.length > 0);
  $('#roomsGrid').innerHTML = rooms.map((r) => {
    const rec = recordings.find((x) => x.id === r.playback.recordingId);
    const pbState = { playing: '<span class="badge live">в эфире</span>', paused: '<span class="badge warn">пауза</span>', ended: '<span class="badge">закончилась</span>' }[r.live.playback] || '';
    const lock = r.settings.locked ? `<span class="badge warn">${ic('lock', 'sm')} закрыта</span>` : r.settings.waitingRoom ? `<span class="badge">${ic('door-closed', 'sm')} зал ожидания</span>` : `<span class="badge">${ic('door-open', 'sm')} свободный вход</span>`;
    return `<div class="card room-card">
      <div class="top">
        <div class="ava">${ic('video', 'lg')}</div>
        <div class="grow"><div class="title">${esc(r.name)}</div><div class="small muted mono">${esc(r.id)}</div></div>
        ${pbState}
      </div>
      <div class="meta">
        <span class="badge ${r.live.participants ? 'ok' : ''}">${ic('users', 'sm')} ${r.live.participants}</span>
        ${r.live.waiting ? `<span class="badge warn">${ic('clock', 'sm')} ждут: ${r.live.waiting}</span>` : ''}
        ${lock}
        ${r.playback.repeat !== 'none' && r.playback.startMode === 'scheduled' ? `<span class="badge accent">${ic('repeat', 'sm')} повтор</span>` : ''}
      </div>
      <div class="small muted">${rec ? `${ic('film', 'sm')} ${esc(rec.title)} — ${scheduleText(r.playback, r.nextStart)}` : 'Запись не выбрана'}</div>
      <div class="actions">
        <a class="btn sm primary" href="/admin/room/${encodeURIComponent(r.id)}">${ic('sliders-horizontal', 'sm')} Пульт</a>
        <a class="btn sm" href="/r/${encodeURIComponent(r.id)}" target="_blank">${ic('log-in', 'sm')} Войти</a>
        <a class="btn sm" href="/r/${encodeURIComponent(r.id)}?observer=1" target="_blank" title="Войти невидимо — участники вас не увидят">${ic('eye-off', 'sm')}</a>
        <button class="btn sm" data-copy="${esc(r.id)}" title="Скопировать ссылку">${ic('link', 'sm')}</button>
        <button class="btn sm" data-dup="${esc(r.id)}" title="Дублировать с теми же настройками">${ic('copy-plus', 'sm')}</button>
        <button class="btn sm danger" data-del="${esc(r.id)}" title="Удалить">${ic('trash-2', 'sm')}</button>
      </div></div>`;
  }).join('');
}

$('#roomsGrid').onclick = async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    await navigator.clipboard.writeText(`${location.origin}/r/${copy.dataset.copy}`).catch(() => {});
    toast('Ссылка скопирована');
  }
  const dup = e.target.closest('[data-dup]');
  if (dup) {
    await api(`/api/rooms/${dup.dataset.dup}/duplicate`, { method: 'POST' });
    toast('Встреча продублирована');
    loadRooms();
  }
  const del = e.target.closest('[data-del]');
  if (del && confirm('Удалить встречу? Все участники будут отключены.')) {
    await api(`/api/rooms/${del.dataset.del}`, { method: 'DELETE' });
    loadRooms();
  }
};

$('#newRoom').onsubmit = async (e) => {
  e.preventDefault();
  const room = await api('/api/rooms', { method: 'POST', body: { name: $('#newRoomName').value } });
  location.href = `/admin/room/${room.id}`;
};

setInterval(() => { if (!$('#tab-rooms').classList.contains('hidden')) loadRooms().catch(() => {}); }, 5000);

// ---------- Записи ----------
function fmtSize(b) {
  if (b > 1e9) return (b / 1e9).toFixed(2) + ' ГБ';
  return (b / 1e6).toFixed(1) + ' МБ';
}

async function loadRecordings() {
  recordings = await api('/api/recordings');
  $('#recEmpty').classList.toggle('hidden', recordings.length > 0);
  $('#recBody').innerHTML = recordings.slice().reverse().map((r) => `<tr>
    <td><div class="row nowrap">${ic('film', 'sm')}<b>${esc(r.title)}</b></div></td>
    <td>${r.duration ? fmtTime(r.duration) : '<span class="muted">?</span>'}</td>
    <td>${fmtSize(r.size)}</td>
    <td class="small muted">${fmtDate(r.createdAt)}</td>
    <td style="text-align:right;white-space:nowrap">
      <button class="btn sm" data-view="${r.id}">${ic('play', 'sm')} Смотреть</button>
      <button class="btn sm icon" data-rename="${r.id}" title="Переименовать">${ic('pencil', 'sm')}</button>
      <button class="btn sm icon danger" data-del="${r.id}" title="Удалить">${ic('trash-2', 'sm')}</button>
    </td></tr>`).join('');
}

$('#recBody').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const rec = recordings.find((r) => r.id === (b.dataset.view || b.dataset.rename || b.dataset.del));
  if (!rec) return;
  if (b.dataset.view) {
    $('#previewCard').classList.remove('hidden');
    $('#previewTitle').textContent = rec.title;
    $('#previewVideo').src = `/media/${rec.file}`;
    $('#previewVideo').play().catch(() => {});
    $('#previewVideo').onloadedmetadata = () => {
      // если длительность ещё не известна — сохраняем её
      const d = $('#previewVideo').duration;
      if (!rec.duration && isFinite(d) && d > 0) api(`/api/recordings/${rec.id}`, { method: 'PATCH', body: { duration: d } }).then(loadRecordings);
    };
    $('#previewCard').scrollIntoView({ behavior: 'smooth' });
  } else if (b.dataset.rename) {
    const title = prompt('Новое название', rec.title);
    if (title) { await api(`/api/recordings/${rec.id}`, { method: 'PATCH', body: { title } }); loadRecordings(); }
  } else if (b.dataset.del && confirm(`Удалить запись «${rec.title}»?`)) {
    await api(`/api/recordings/${rec.id}`, { method: 'DELETE' });
    loadRecordings();
  }
};
$('#previewClose').onclick = () => { $('#previewVideo').pause(); $('#previewCard').classList.add('hidden'); };

function probeDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { const d = v.duration; URL.revokeObjectURL(v.src); resolve(isFinite(d) ? d : 0); };
    v.onerror = () => resolve(0);
    v.src = URL.createObjectURL(file);
  });
}

function uploadRecording(blob, filename, title, duration, progEl, infoEl) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('title', title);
    fd.append('duration', duration || '');
    fd.append('file', blob, filename);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/recordings');
    progEl.classList.remove('hidden');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = (e.loaded / e.total) * 100;
      $('div', progEl).style.width = pct + '%';
      infoEl.textContent = `Загрузка… ${pct.toFixed(0)}% (${fmtSize(e.loaded)} из ${fmtSize(e.total)})`;
    };
    xhr.onload = () => {
      progEl.classList.add('hidden');
      if (xhr.status === 200) { infoEl.textContent = 'Готово! Запись добавлена.'; resolve(JSON.parse(xhr.responseText)); }
      else { infoEl.textContent = 'Ошибка загрузки'; reject(new Error(xhr.responseText)); }
    };
    xhr.onerror = () => { progEl.classList.add('hidden'); infoEl.textContent = 'Ошибка сети'; reject(new Error('network')); };
    xhr.send(fd);
  });
}

let pickedFile = null;
function pickFile(file) {
  if (!file) return;
  if (!/^(video|audio)\//.test(file.type)) return toast('Нужен видеофайл');
  pickedFile = file;
  $('#upRow').classList.remove('hidden');
  $('#upTitle').value = file.name.replace(/\.[^.]+$/, '');
  $('#upInfo').textContent = `${file.name} · ${fmtSize(file.size)}`;
}
$('#upFile').onchange = () => pickFile($('#upFile').files[0]);
const dz = $('#dropzone');
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
dz.ondragleave = () => dz.classList.remove('over');
dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); pickFile(e.dataTransfer.files[0]); };

$('#upBtn').onclick = async () => {
  if (!pickedFile) return toast('Выберите видеофайл');
  $('#upBtn').disabled = true;
  try {
    const duration = await probeDuration(pickedFile);
    await uploadRecording(pickedFile, pickedFile.name, $('#upTitle').value.trim() || pickedFile.name, duration, $('#upProg'), $('#upInfo'));
    pickedFile = null; $('#upFile').value = ''; $('#upRow').classList.add('hidden');
    loadRecordings();
  } catch (err) {
    toast('Не удалось загрузить файл');
  } finally { $('#upBtn').disabled = false; }
};

// ---------- Студия ----------
const studio = { stream: null, parts: [], recorder: null, started: 0, timer: null, extra: [] };

function studioCleanup() {
  [studio.stream, ...studio.extra].forEach((s) => s?.getTracks().forEach((t) => t.stop()));
  studio.stream = null; studio.extra = [];
  cancelAnimationFrame(studio.raf);
  $('#stPreview').srcObject = null;
}

$('#stPrepare').onclick = async () => {
  studioCleanup();
  const mode = $('input[name=src]:checked').value;
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    studio.extra.push(mic);
    let videoTrack;
    if (mode === 'camera') {
      const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      studio.extra.push(cam);
      videoTrack = cam.getVideoTracks()[0];
    } else {
      const scr = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 } });
      studio.extra.push(scr);
      videoTrack = scr.getVideoTracks()[0];
      if (mode === 'screen-cam') {
        // склеиваем экран и камеру на холсте
        const cam = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
        studio.extra.push(cam);
        const vScr = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: scr });
        const vCam = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: cam });
        await Promise.all([vScr.play(), vCam.play()]);
        const canvas = document.createElement('canvas');
        canvas.width = 1280; canvas.height = 720;
        const ctx = canvas.getContext('2d');
        const draw = () => {
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1280, 720);
          const r = Math.min(1280 / (vScr.videoWidth || 1280), 720 / (vScr.videoHeight || 720));
          const w = (vScr.videoWidth || 1280) * r, h = (vScr.videoHeight || 720) * r;
          ctx.drawImage(vScr, (1280 - w) / 2, (720 - h) / 2, w, h);
          ctx.save();
          ctx.beginPath(); ctx.roundRect(1280 - 268, 720 - 203, 248, 183, 16); ctx.clip();
          ctx.drawImage(vCam, 1280 - 268, 720 - 203, 248, 183);
          ctx.restore();
          studio.raf = requestAnimationFrame(draw);
        };
        draw();
        videoTrack = canvas.captureStream(30).getVideoTracks()[0];
      }
    }
    studio.stream = new MediaStream([videoTrack, mic.getAudioTracks()[0]]);
    $('#stPreview').srcObject = new MediaStream([videoTrack]);
    $('#stRec').disabled = false;
    $('#stInfo').textContent = 'Готово к записи.';
  } catch (e) {
    toast('Нет доступа к камере, экрану или микрофону');
  }
};

function pickMime() {
  const list = ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

$('#stRec').onclick = () => {
  if (!studio.stream) return;
  const mimeType = pickMime();
  studio.parts = [];
  studio.recorder = new MediaRecorder(studio.stream, { mimeType, videoBitsPerSecond: 2_500_000 });
  studio.recorder.ondataavailable = (e) => e.data.size && studio.parts.push(e.data);
  studio.recorder.onstop = async () => {
    const duration = (Date.now() - studio.started) / 1000;
    clearInterval(studio.timer);
    const type = studio.recorder.mimeType || mimeType || 'video/webm';
    const blob = new Blob(studio.parts, { type: type.split(';')[0] });
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const title = $('#studioTitle').value.trim() || `Запись ${new Date().toLocaleString('ru-RU')}`;
    studioCleanup();
    try {
      await uploadRecording(blob, `studio.${ext}`, title, duration, $('#stProg'), $('#stInfo'));
      toast('Запись сохранена');
    } catch (e) { toast('Ошибка сохранения записи'); }
  };
  studio.recorder.start(1000);
  studio.started = Date.now();
  $('#stTime').classList.remove('hidden');
  studio.timer = setInterval(() => ($('#stTime').textContent = fmtTime((Date.now() - studio.started) / 1000)), 500);
  $('#stRec').disabled = true; $('#stStop').disabled = false; $('#stPrepare').disabled = true;
  $('#stInfo').textContent = 'Идёт запись…';
};

$('#stStop').onclick = () => {
  studio.recorder?.stop();
  $('#stStop').disabled = true; $('#stPrepare').disabled = false;
  $('#stTime').classList.add('hidden');
};

// ---------- Эмодзи ----------
async function loadEmojiTab() {
  const { custom, pack } = await loadEmojis();
  $('#emojiEmpty').classList.toggle('hidden', custom.length > 0);
  $('#emojiGrid').innerHTML = custom.map((e) => `<div class="emoji-card">
    <img src="${esc(e.url)}" alt=""><code>:${esc(e.name)}:</code>
    <button class="btn sm danger" data-del="${e.id}">${ic('trash-2', 'sm')}</button></div>`).join('');
  $('#packGrid').innerHTML = pack.map((e) => `<div class="emoji-card"><img src="${esc(e.url)}" alt=""><code>:${esc(e.name)}:</code></div>`).join('');
}
$('#emojiGrid').onclick = async (e) => {
  const b = e.target.closest('[data-del]');
  if (!b || !confirm('Удалить эмодзи?')) return;
  await api(`/api/emojis/${b.dataset.del}`, { method: 'DELETE' });
  loadEmojiTab();
};
$('#emFile').onchange = () => {
  const f = $('#emFile').files[0];
  if (f && !$('#emName').value) $('#emName').value = f.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_а-яё-]/g, '_').slice(0, 32);
};
$('#emojiForm').onsubmit = async (e) => {
  e.preventDefault();
  const file = $('#emFile').files[0];
  if (!file) return toast('Выберите картинку');
  const fd = new FormData();
  fd.append('name', $('#emName').value.trim());
  fd.append('file', file);
  try {
    await api('/api/emojis', { method: 'POST', body: fd });
    $('#emFile').value = ''; $('#emName').value = '';
    toast('Эмодзи добавлен');
    loadEmojiTab();
  } catch (err) { toast(err.message); }
};

// ---------- По умолчанию ----------
async function loadDefaults() {
  const [d, recs] = await Promise.all([api('/api/defaults'), api('/api/recordings')]);
  $('#defSwitches').innerHTML = switchesHtml(d.settings, 'data-dset');
  renderPlaybackForm($('#defPlayback'), d.playback, recs);
}
$('#defSave').onclick = async () => {
  const settings = {};
  $$('[data-dset]').forEach((el) => (settings[el.dataset.dset] = el.checked));
  const playback = readPlaybackForm($('#defPlayback'));
  const err = validatePlayback(playback, { needRecording: false });
  if (err) return toast(err);
  try {
    await api('/api/defaults', { method: 'PUT', body: { settings, playback } });
    toast('Сохранено. Новые встречи будут создаваться с этими настройками');
  } catch (e) { toast(e.message); }
};

// ---------- Админы ----------
async function loadUsers() {
  const users = await api('/api/users');
  $('#adminUrl').textContent = `${location.origin}/admin`;
  $('#usersEmpty').classList.toggle('hidden', users.length > 0);
  $('#usersBody').innerHTML = users.map((u) => `<tr>
    <td><div class="row nowrap">${avatarHtml(u.name)}<b>${esc(u.name)}</b></div></td>
    <td class="mono">${esc(u.login)}</td><td>${u.rooms}</td><td>${u.recordings}</td>
    <td class="small muted">${fmtDate(u.createdAt)}</td>
    <td style="text-align:right;white-space:nowrap">
      <button class="btn sm" data-pass="${u.id}">${ic('key-round', 'sm')} Пароль</button>
      <button class="btn sm icon danger" data-del="${u.id}" title="Удалить">${ic('trash-2', 'sm')}</button></td></tr>`).join('');
}
$('#usersBody').onclick = async (e) => {
  const pass = e.target.closest('[data-pass]');
  if (pass) {
    const password = prompt('Новый пароль (от 6 символов)');
    if (!password) return;
    try { await api(`/api/users/${pass.dataset.pass}`, { method: 'PATCH', body: { password } }); toast('Пароль изменён'); } catch (err) { toast(err.message); }
  }
  const del = e.target.closest('[data-del]');
  if (del && confirm('Удалить администратора вместе со всеми его встречами и записями?')) {
    await api(`/api/users/${del.dataset.del}`, { method: 'DELETE' });
    loadUsers();
  }
};
$('#userForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/api/users', { method: 'POST', body: { name: $('#uName').value, login: $('#uLogin').value, password: $('#uPass').value } });
    toast('Администратор создан');
    e.target.reset();
    loadUsers();
  } catch (err) { toast(err.message); }
};

// ---------- Старт ----------
(async () => {
  me = (await api('/api/me')).user;
  if (!me) return location.reload();
  $('#meAva').innerHTML = avatarHtml(me.name);
  $('#meName').textContent = me.name;
  $('#meRole').textContent = me.role === 'owner' ? 'главный админ' : me.login;
  $('#navAdmins').classList.toggle('hidden', me.role !== 'owner');
  const h = location.hash.slice(1);
  openTab(tabs.includes(h) ? h : 'rooms');
})();
