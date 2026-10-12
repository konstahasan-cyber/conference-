// Админ-панель: встречи, записи, студия
const tabs = ['rooms', 'recordings', 'studio', 'emojis'];
function openTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  tabs.forEach((t) => $(`#tab-${t}`).classList.toggle('hidden', t !== name));
  location.hash = name;
  if (name === 'rooms') loadRooms();
  if (name === 'recordings') loadRecordings();
  if (name === 'emojis') loadEmojiTab();
}
$$('.tabs button').forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };

let recordings = [];

// ---------- Встречи ----------
async function loadRooms() {
  const [rooms, recs] = await Promise.all([api('/api/rooms'), api('/api/recordings')]);
  recordings = recs;
  $('#roomsEmpty').classList.toggle('hidden', rooms.length > 0);
  $('#roomsBody').innerHTML = rooms.map((r) => {
    const rec = recordings.find((x) => x.id === r.playback.recordingId);
    const pbState = { playing: '<span class="badge live">идёт</span>', paused: '<span class="badge warn">пауза</span>', ended: '<span class="badge">закончилась</span>' }[r.live.playback] || '';
    const mode = { manual: 'вручную', scheduled: r.playback.startAt ? 'в ' + new Date(r.playback.startAt).toLocaleString('ru-RU') : 'по расписанию', firstGuest: `через ${r.playback.delaySec} с после входа` }[r.playback.startMode];
    return `<tr>
      <td><b>${esc(r.name)}</b></td>
      <td><code>${esc(r.id)}</code></td>
      <td>👥 ${r.live.participants} ${r.live.waiting ? `<span class="badge warn">ждут: ${r.live.waiting}</span>` : ''}</td>
      <td class="small">${rec ? `${esc(rec.title)} ${pbState}<div class="muted">старт: ${mode}</div>` : '<span class="muted">—</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <a class="btn sm primary" href="/admin/room/${encodeURIComponent(r.id)}">Управление</a>
        <button class="btn sm" data-copy="${esc(r.id)}">Скопировать ссылку</button>
        <button class="btn sm danger" data-del="${esc(r.id)}">Удалить</button>
      </td></tr>`;
  }).join('');
}

$('#roomsBody').onclick = async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    await navigator.clipboard.writeText(`${location.origin}/r/${copy.dataset.copy}`).catch(() => {});
    toast('Ссылка скопирована');
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
    <td><b>${esc(r.title)}</b></td>
    <td>${r.duration ? fmtTime(r.duration) : '<span class="muted">?</span>'}</td>
    <td>${fmtSize(r.size)}</td>
    <td class="small muted">${new Date(r.createdAt).toLocaleString('ru-RU')}</td>
    <td style="text-align:right;white-space:nowrap">
      <button class="btn sm" data-view="${r.id}">▶ Просмотр</button>
      <button class="btn sm" data-rename="${r.id}">Переименовать</button>
      <button class="btn sm danger" data-del="${r.id}">Удалить</button>
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

$('#uploadForm').onsubmit = async (e) => {
  e.preventDefault();
  const file = $('#upFile').files[0];
  if (!file) return toast('Выберите видеофайл');
  $('#upBtn').disabled = true;
  try {
    const duration = await probeDuration(file);
    const title = $('#upTitle').value.trim() || file.name.replace(/\.[^.]+$/, '');
    await uploadRecording(file, file.name, title, duration, $('#upProg'), $('#upInfo'));
    $('#upFile').value = ''; $('#upTitle').value = '';
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
          ctx.drawImage(vCam, 1280 - 260, 720 - 195, 240, 180);
          studio.raf = requestAnimationFrame(draw);
        };
        draw();
        videoTrack = canvas.captureStream(30).getVideoTracks()[0];
      }
    }
    studio.stream = new MediaStream([videoTrack, mic.getAudioTracks()[0]]);
    studio.extra.push(mic);
    $('#stPreview').srcObject = new MediaStream([videoTrack]);
    $('#stRec').disabled = false;
    $('#stInfo').textContent = 'Готово к записи.';
  } catch (e) {
    toast('Нет доступа к камере/экрану/микрофону');
  }
};

function pickMime() {
  const list = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
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
  studio.timer = setInterval(() => ($('#stTime').textContent = '● ' + fmtTime((Date.now() - studio.started) / 1000)), 500);
  $('#stRec').disabled = true; $('#stStop').disabled = false; $('#stPrepare').disabled = true;
  $('#stInfo').textContent = 'Идёт запись…';
};

$('#stStop').onclick = () => {
  studio.recorder?.stop();
  $('#stStop').disabled = true; $('#stPrepare').disabled = false;
  $('#stTime').textContent = '';
};

// ---------- Эмодзи ----------
async function loadEmojiTab() {
  const { custom } = await loadEmojis();
  $('#emojiEmpty').classList.toggle('hidden', custom.length > 0);
  $('#emojiGrid').innerHTML = custom.map((e) => `<div class="emoji-card">
    <img src="${esc(e.url)}" alt=""><code>:${esc(e.name)}:</code>
    <button class="btn sm danger" data-del="${e.id}">Удалить</button></div>`).join('');
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

openTab(tabs.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'rooms');
