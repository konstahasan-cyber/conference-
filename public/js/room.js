// Клиент комнаты: зал ожидания, WebRTC (mesh), чат, реакции, синхронный показ записи, управление у ведущего.
const roomId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop());
const params = new URLSearchParams(location.search);
const PRESENTER = '__presenter';
const SELF = '__self';

const S = {
  self: null,
  role: 'guest',
  joined: false,
  peers: new Map(),          // id -> { info, pc, stream, chain, pending, initiate }
  tiles: new Map(),          // key -> { el, video, avatar, nameEl, micEl, handEl, netEl }
  room: null,
  perms: { allowCam: false, allowMic: false },
  local: { audio: null, video: null, screen: null },
  dev: { mic: localStorage.getItem('devMic') || '', cam: localStorage.getItem('devCam') || '', spk: localStorage.getItem('devSpk') || '' },
  iceServers: [],
  hand: false,
  playback: null,
  adminState: null,
  recordings: [],
  side: null,
  unread: 0,
  joinedAt: 0,
  isOwner: false,
  isAdmin: false,
  observer: false,
  rejoin: null,              // токен возвращения после обрыва связи
  reconnecting: false,
  waiting: false,
};
const REJOIN_KEY = `rejoin:${roomId}`;
try { S.rejoin = sessionStorage.getItem(REJOIN_KEY) || null; } catch (e) {}
function saveRejoin(token) {
  S.rejoin = token || null;
  try { token ? sessionStorage.setItem(REJOIN_KEY, token) : sessionStorage.removeItem(REJOIN_KEY); } catch (e) {}
}
let audioCtx = null;
const blockedMedia = new Set();

const socket = io({ autoConnect: true });

function ensureAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

// ---------- Перед входом ----------
(async function init() {
  $('#nameInput').value = localStorage.getItem('confName') || '';
  try {
    const [info, cfg] = await Promise.all([
      api(`/api/rooms/${encodeURIComponent(roomId)}/public`),
      api('/api/config'),
      loadEmojis(roomId),
    ]);
    S.iceServers = cfg.iceServers;
    api('/api/me').then((m) => (S.isAdmin = m.admin)).catch(() => {});
    S.isOwner = info.isOwner;
    // админ по умолчанию входит невидимо (автовебинар); ?live=1 — сразу «в эфир»
    S.observer = info.isOwner && params.get('live') !== '1';
    S.perms = { allowCam: info.allowCamera, allowMic: info.allowMic };
    $('#preTitle').textContent = info.name;
    $('#preCode').textContent = `Код встречи: ${info.id}`;
    document.title = info.name;
    if (S.isOwner) {
      $('#hostNote').classList.remove('hidden');
      $(`input[name=hostMode][value=${S.observer ? 'hidden' : 'live'}]`).checked = true;
      // имя админа — то же, от которого ведётся автовебинар
      if (info.adminName) $('#nameInput').value = info.adminName;
    }
  } catch (e) {
    $('#preTitle').textContent = 'Встреча не найдена';
    $('#preError').textContent = 'Проверьте ссылку-приглашение.';
    $('#joinBtn').disabled = true;
  }
  updatePrejoin();
})();

const canUse = (kind) => (S.isOwner ? !S.observer : kind === 'cam' ? S.perms.allowCam : S.perms.allowMic);

function setRound(btn, on, icOn, icOff, allowed) {
  btn.classList.toggle('off', !on);
  btn.disabled = !allowed;
  btn.querySelector('.i').style.setProperty('--ic', `url(/icons/${on ? icOn : icOff}.svg)`);
}

function updatePrejoin() {
  if (!canUse('cam') && S.local.video) stopLocal('video');
  if (!canUse('mic') && S.local.audio) stopLocal('audio');
  setRound($('#preCam'), !!S.local.video, 'video', 'video-off', canUse('cam'));
  setRound($('#preMic'), !!S.local.audio, 'mic', 'mic-off', canUse('mic'));
  $('#preCam').title = canUse('cam') ? 'Камера' : 'Камера недоступна в этой встрече';
  $('#preMic').title = canUse('mic') ? 'Микрофон' : 'Микрофон недоступен в этой встрече';
  const pv = $('#previewVideo');
  const want = S.local.video || null;
  if ((pv.srcObject?.getVideoTracks()[0] || null) !== want) pv.srcObject = want ? new MediaStream([want]) : null;
  $('#previewOff').classList.toggle('hidden', !!S.local.video);
  $('#preLevelHint').textContent = S.local.audio ? 'скажите что-нибудь' : canUse('mic') ? 'микрофон выключен' : 'микрофон недоступен';
}
$('#preCam').onclick = async () => { S.local.video ? stopLocal('video') : await startLocal('video'); updatePrejoin(); };
$('#preMic').onclick = async () => { ensureAudioCtx(); S.local.audio ? stopLocal('audio') : await startLocal('audio'); updatePrejoin(); };
$('#preSettings').onclick = () => openDevices();
$$('input[name=hostMode]').forEach((r) => (r.onchange = () => { S.observer = $('input[name=hostMode][value=hidden]').checked; updatePrejoin(); }));

function mediaError(kind, e) {
  const what = kind === 'video' ? 'камере' : 'микрофону';
  const map = {
    NotAllowedError: `Нет доступа к ${what}. Нажмите на значок замка слева от адреса сайта и разрешите доступ.`,
    NotFoundError: kind === 'video' ? 'Камера не найдена' : 'Микрофон не найден',
    NotReadableError: `${kind === 'video' ? 'Камера' : 'Микрофон'} занят другой программой (Zoom, Telegram и т.п.) — закройте её`,
    OverconstrainedError: 'Выбранное устройство недоступно',
    SecurityError: 'Нужен защищённый адрес https://',
  };
  if (!window.isSecureContext) return 'Камера и микрофон работают только по адресу https://';
  return map[e?.name] || `Не удалось включить ${kind === 'video' ? 'камеру' : 'микрофон'}`;
}

async function startLocal(kind) {
  const id = kind === 'video' ? S.dev.cam : S.dev.mic;
  const base = kind === 'video'
    ? (window.NetQuality?.videoConstraints?.(S.isOwner ? 'host' : S.role) || { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } })
    : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const get = (withId) => navigator.mediaDevices.getUserMedia({ [kind]: withId && id ? { ...base, deviceId: { exact: id } } : base });
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: 'SecurityError' });
    let stream;
    try { stream = await get(true); } catch (e) {
      if (id && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) stream = await get(false);
      else throw e;
    }
    S.local[kind] = stream.getTracks()[0];
    S.local[kind].onended = () => { if (S.local[kind]?.readyState === 'ended') { S.local[kind] = null; afterLocalChange(); } };
    return true;
  } catch (e) {
    console.warn(kind, e);
    toast(mediaError(kind, e), 6000);
    return false;
  }
}

function stopLocal(kind) {
  S.local[kind]?.stop();
  S.local[kind] = null;
}

function afterLocalChange() {
  if (S.joined) { pushVideoTrack(); pushAudioTrack(); sendMedia(); updateButtons(); } else updatePrejoin();
}

// индикатор громкости своего микрофона
const levelBuf = new Uint8Array(512);
let levelAnalyser = null, levelTrack = null;
setInterval(() => {
  const track = S.local.audio;
  if (track !== levelTrack) {
    levelTrack = track;
    levelAnalyser = null;
    if (track && ensureAudioCtx()) {
      try {
        levelAnalyser = audioCtx.createAnalyser();
        levelAnalyser.fftSize = 512;
        audioCtx.createMediaStreamSource(new MediaStream([track])).connect(levelAnalyser);
      } catch (e) { levelAnalyser = null; }
    }
  }
  let v = 0;
  if (levelAnalyser) {
    levelAnalyser.getByteTimeDomainData(levelBuf);
    let sum = 0;
    for (let i = 0; i < levelBuf.length; i++) { const x = (levelBuf[i] - 128) / 128; sum += x * x; }
    v = Math.min(100, Math.sqrt(sum / levelBuf.length) * 400);
  }
  $('#preLevel').style.width = v + '%';
  $('#devLevel').style.width = v + '%';
}, 80);

// ---------- Выбор устройств ----------
async function openDevices() {
  ensureAudioCtx();
  $('#devicesModal').classList.remove('hidden');
  let list = [];
  try { list = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
  const fill = (sel, kind, cur, label) => {
    const items = list.filter((d) => d.kind === kind);
    sel.innerHTML = '<option value="">По умолчанию</option>' + items.map((d, i) =>
      `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || `${label} ${i + 1}`)}</option>`).join('');
  };
  fill($('#devMic'), 'audioinput', S.dev.mic, 'Микрофон');
  fill($('#devCam'), 'videoinput', S.dev.cam, 'Камера');
  fill($('#devSpk'), 'audiooutput', S.dev.spk, 'Динамики');
  $('#devSpkWrap').classList.toggle('hidden', !('setSinkId' in HTMLMediaElement.prototype) || !list.some((d) => d.kind === 'audiooutput'));
  if (!list.some((d) => d.label)) $('#devMic').insertAdjacentHTML('beforeend', '');
}
const closeDevices = () => $('#devicesModal').classList.add('hidden');
// проверка связи (модуль conn-test.js)
$('#connTestBtn').onclick = async () => {
  const box = $('#connTestResult');
  if (!window.ConnTest?.run) { box.textContent = 'Проверка связи недоступна'; return; }
  const btn = $('#connTestBtn');
  btn.disabled = true;
  box.innerHTML = '<span class="muted small">Проверяем связь… это займёт несколько секунд</span>';
  try {
    const res = await window.ConnTest.run(S.iceServers);
    if (window.ConnTest.render) window.ConnTest.render(box, res);
    else box.textContent = JSON.stringify(res);
  } catch (e) {
    box.textContent = 'Не удалось проверить связь';
  }
  btn.disabled = false;
};
$('#devClose').onclick = $('#devDone').onclick = closeDevices;
$('#devicesModal').onclick = (e) => { if (e.target.id === 'devicesModal') closeDevices(); };
$('#devMic').onchange = async () => {
  S.dev.mic = $('#devMic').value; localStorage.setItem('devMic', S.dev.mic);
  if (S.local.audio) { stopLocal('audio'); await startLocal('audio'); afterLocalChange(); }
};
$('#devCam').onchange = async () => {
  S.dev.cam = $('#devCam').value; localStorage.setItem('devCam', S.dev.cam);
  if (S.local.video) { stopLocal('video'); await startLocal('video'); afterLocalChange(); }
};
$('#devSpk').onchange = () => { S.dev.spk = $('#devSpk').value; localStorage.setItem('devSpk', S.dev.spk); applySink(); };
function applySink() {
  if (!S.dev.spk) return;
  for (const el of [pbVideo, stageVideo, ...[...S.tiles.values()].map((t) => t.video)]) el.setSinkId?.(S.dev.spk).catch(() => {});
}

// ---------- Вход ----------
$('#joinBtn').onclick = () => {
  const name = $('#nameInput').value.trim();
  if (!name) { $('#nameInput').focus(); return toast('Введите имя'); }
  localStorage.setItem('confName', name);
  // создаём аудиоконтекст и «разблокируем» видео в момент клика — чтобы потом звук шёл без ограничений автозапуска
  ensureAudioCtx();
  pbVideo.muted = true; pbVideo.play().catch(() => {}); pbVideo.pause(); pbVideo.muted = false;
  $('#joinBtn').disabled = true;
  S.joinName = name;
  // если страницу перезагрузили в течение 3 минут — токен вернёт во встречу без зала ожидания
  socket.emit('join', { roomId, name, asHost: S.isOwner, hidden: S.observer, rejoin: S.rejoin || undefined }, (res) => {
    $('#joinBtn').disabled = false;
    if (res?.error) { $('#preError').textContent = res.error; return; }
    if (res.status === 'waiting') showWaiting();
  });
};

function showWaiting() {
  S.waiting = true;
  $('#waitTitle').textContent = $('#preTitle').textContent;
  show('waiting');
}

$('#cancelWait').onclick = () => { S.waiting = false; socket.emit('leave'); show('prejoin'); };

// ---------- Переподключение ----------
// при обрыве связи не выкидываем из встречи: ждём, пока socket.io переподключится, и входим по токену
let reconnectTimer = null;
function setReconnectBanner(on) { $('#reconnectBanner').classList.toggle('hidden', !on); }

function startReconnecting() {
  S.reconnecting = true;
  for (const id of [...S.peers.keys()]) removePeer(id);
  setReconnectBanner(true);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!S.reconnecting) return;
    stopReconnecting();
    showEnd('Соединение прервано', 'Проверьте интернет и подключитесь снова.');
  }, 60_000);
}

function stopReconnecting() {
  S.reconnecting = false;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  setReconnectBanner(false);
}

function rejoinRoom() {
  socket.emit('join', { roomId, name: S.self?.name || S.joinName, asHost: S.isOwner, hidden: S.observer, rejoin: S.rejoin || undefined }, (res) => {
    if (res?.error) {
      stopReconnecting();
      saveRejoin(null);
      return showEnd('Не удалось вернуться во встречу', res.error);
    }
    if (res?.status === 'waiting') {
      // токен истёк, а в комнате зал ожидания — ждём снова
      stopReconnecting();
      S.joined = false;
      showWaiting();
    }
  });
}

socket.on('connect', () => {
  if (S.reconnecting) rejoinRoom();
  else if (S.waiting && !S.joined) {
    // обрыв в зале ожидания — встаём в очередь заново
    socket.emit('join', { roomId, name: S.joinName, asHost: S.isOwner, hidden: S.observer }, (res) => {
      if (res?.error) { S.waiting = false; showEnd('Соединение прервано', res.error); }
      else if (res?.status === 'waiting') showWaiting();
    });
  }
});

function show(view) {
  for (const v of ['prejoin', 'waiting', 'meeting', 'end']) $(`#${v}View`).classList.toggle('hidden', v !== view);
}

function showEnd(title, text) {
  if (REC.recorder) stopHostRecording();
  S.joined = false;
  S.waiting = false;
  stopReconnecting();
  for (const peer of S.peers.values()) { clearTimeout(peer.iceTimer); peer.pc?.close(); }
  S.peers.clear();
  stopLocal('video'); stopLocal('audio'); stopLocal('screen');
  pbVideo.pause();
  $('#endTitle').textContent = title;
  $('#endText').textContent = text || '';
  $('#unmuteBtn').classList.add('hidden');
  $('#endAdmin').classList.toggle('hidden', !S.isAdmin);
  $('#endAdmin').href = S.isOwner ? `/admin/room/${encodeURIComponent(roomId)}` : '/admin';
  show('end');
}

// ---------- Встреча ----------
socket.on('joined', ({ self, peers, room, playback, chat, rejoin }) => {
  const again = S.joined; // повторный вход после обрыва связи
  stopReconnecting();
  S.waiting = false;
  S.joined = true;
  S.self = self;
  S.role = self.role;
  S.observer = !!self.hidden;
  if (!again) S.joinedAt = Date.now();
  saveRejoin(rejoin);
  // старые соединения (если остались) закрываем — заново звоним всем
  for (const id of [...S.peers.keys()]) removePeer(id);
  S.perms = { allowCam: self.allowCam, allowMic: self.allowMic };
  if (self.hidden) { stopLocal('video'); stopLocal('audio'); }
  if (!S.perms.allowCam) stopLocal('video');
  if (!S.perms.allowMic) stopLocal('audio');
  show('meeting');
  const host = S.role === 'host';
  $('#btnScreen').classList.toggle('hidden', !host || self.hidden);
  $('#btnManage').classList.toggle('hidden', !host);
  $('#btnRec').classList.toggle('hidden', !host || self.hidden);
  $('#tabManage').classList.toggle('hidden', !host);
  $('#observerBadge').classList.toggle('hidden', !self.hidden);
  applyRoom(room);
  $('#chatList').innerHTML = '';
  chat.forEach(addChat);
  S.unread = 0; updateUnread();
  for (const info of peers) addPeer(info).initiate = true;
  for (const info of peers) callPeer(info.id);
  applyPlayback(playback);
  sendMedia();
  if (again && S.hand) socket.emit('hand', true);
  updateButtons();
  tuneNet();
  if (host) {
    socket.emit('admin:watch', { roomId });
    api('/api/recordings').then((r) => { S.recordings = r; renderManage(); }).catch(() => {});
  }
  layout();
});

socket.on('denied', () => { saveRejoin(null); showEnd('Вход отклонён', 'Организатор не разрешил вам присоединиться к встрече.'); });
socket.on('kicked', () => { saveRejoin(null); showEnd('Вы удалены из встречи', 'Организатор удалил вас из встречи.'); });
socket.on('meeting-ended', ({ reason } = {}) => { saveRejoin(null); showEnd('Встреча завершена', reason); });
socket.on('disconnect', (reason) => {
  if (S.joined) {
    if (!S.reconnecting) startReconnecting();
  } else if (!S.waiting) return;
  // сервер сам закрыл сокет — socket.io в этом случае не переподключается автоматически
  if (reason === 'io server disconnect') socket.connect();
});

socket.on('peer-joined', (info) => { addPeer(info); layout(); tuneNet(); });
socket.on('peer-left', ({ id }) => removePeer(id));
socket.on('peer-updated', (info) => {
  if (info.id === socket.id) {
    S.self = info;
    if (!info.hand && S.hand) { S.hand = false; updateButtons(); }
    renderPeople();
    return;
  }
  const peer = S.peers.get(info.id);
  if (!peer) return;
  peer.info = info;
  layout();
});
socket.on('participants', (list) => {
  for (const info of list) {
    if (info.id === socket.id) S.self = info;
    const peer = S.peers.get(info.id);
    if (peer) peer.info = info;
  }
  layout();
});
socket.on('room-updated', (room) => applyRoom(room));
socket.on('playback', (pb) => applyPlayback(pb));
socket.on('chat', (msg) => addChat(msg));
socket.on('chat-cleared', () => { $('#chatList').innerHTML = ''; });
socket.on('emojis-updated', () => loadEmojis(roomId));
socket.on('signal', ({ from, data }) => {
  const peer = S.peers.get(from);
  if (!peer) return;
  peer.chain = peer.chain.then(() => handleSignal(peer, from, data)).catch((e) => console.warn('signal', e));
});

socket.on('perm', (perms) => {
  const before = S.perms;
  S.perms = perms;
  if (!perms.allowCam && (S.local.video || S.local.screen)) { stopLocal('video'); stopLocal('screen'); pushVideoTrack(); toast('Организатор выключил вашу камеру'); }
  else if (!perms.allowCam && before.allowCam) toast('Организатор запретил включать камеру');
  if (!perms.allowMic && S.local.audio) { stopLocal('audio'); pushAudioTrack(); toast('Организатор выключил ваш микрофон'); }
  else if (!perms.allowMic && before.allowMic) toast('Организатор запретил включать микрофон');
  if (perms.allowCam && !before.allowCam) toast('Организатор разрешил включить камеру');
  if (perms.allowMic && !before.allowMic) toast('Организатор разрешил включить микрофон');
  sendMedia();
  updateButtons();
});

socket.on('force-mute', () => {
  if (!S.local.audio) return;
  stopLocal('audio'); pushAudioTrack(); sendMedia(); updateButtons();
  toast('Организатор выключил ваш микрофон');
});
socket.on('force-cam-off', () => {
  if (!S.local.video) return;
  stopLocal('video'); pushVideoTrack(); sendMedia(); updateButtons();
  toast('Организатор выключил вашу камеру');
});
socket.on('lower-hand', () => { S.hand = false; updateButtons(); });

socket.on('admin:state', (st) => {
  const prevWaiting = S.adminState?.waiting.length || 0;
  S.adminState = st;
  const n = st.waiting.length;
  $('#waitCount').textContent = n;
  $('#waitCount').classList.toggle('hidden', !n);
  if (n > prevWaiting && S.side !== 'people') toast(`В зале ожидания: ${n}`, 2500);
  renderPeople();
  renderManage();
});

function applyRoom(room) {
  S.room = room;
  $('#meetTitle').textContent = room.name;
  document.title = room.name;
  const canChat = room.allowChat || S.role === 'host';
  $('#chatInput').disabled = !canChat;
  $('#chatInput').placeholder = canChat ? 'Сообщение всем' : 'Чат отключён организатором';
  $('#btnReact').disabled = !(room.allowReactions || S.role === 'host') || !!S.self?.hidden;
  layout();
}

// ---------- WebRTC ----------
function addPeer(info) {
  let peer = S.peers.get(info.id);
  if (!peer) {
    peer = { info, pc: null, stream: new MediaStream(), chain: Promise.resolve(), pending: [] };
    S.peers.set(info.id, peer);
  } else peer.info = info;
  return peer;
}

function removePeer(id) {
  const peer = S.peers.get(id);
  if (!peer) return;
  clearTimeout(peer.iceTimer);
  peer.pc?.close();
  S.peers.delete(id);
  const t = S.tiles.get(id);
  if (t) { t.el.remove(); S.tiles.delete(id); }
  meters.delete(id);
  layout();
  tuneNet();
}

// битрейт видео под число участников (модуль net-quality.js)
function tuneNet() {
  const pcs = [...S.peers.values()].map((p) => p.pc).filter(Boolean);
  try { window.NetQuality?.tune?.(pcs, { screen: !!S.local.screen }); } catch (e) { console.warn('tune', e); }
}

const currentVideoTrack = () => S.local.screen || S.local.video || null;

function newPC(id) {
  const peer = S.peers.get(id);
  peer.pc?.close();
  peer.stream = new MediaStream();
  peer.pending = [];
  const pc = new RTCPeerConnection({ iceServers: S.iceServers });
  peer.pc = pc;
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    peer.stream.getTracks().filter((t) => t.kind === e.track.kind).forEach((t) => peer.stream.removeTrack(t));
    peer.stream.addTrack(e.track);
    e.track.onunmute = () => {
      const t = S.tiles.get(id);
      if (t) safePlay(t.video);
      layout();
    };
    layout();
  };
  pc.onconnectionstatechange = () => {
    if (peer.pc !== pc) return;
    const st = pc.connectionState;
    const alive = () => S.peers.get(id) === peer && peer.pc === pc;
    if (st !== 'disconnected') { clearTimeout(peer.iceTimer); peer.iceTimer = null; }
    // если соединение оборвалось — инициатор переподключается
    if (st === 'failed' && peer.initiate && alive()) setTimeout(() => alive() && callPeer(id), 1000);
    // «disconnected» дольше 8 секунд — тоже переподключаемся
    if (st === 'disconnected' && peer.initiate && !peer.iceTimer) {
      peer.iceTimer = setTimeout(() => {
        peer.iceTimer = null;
        if (alive() && pc.connectionState === 'disconnected') callPeer(id);
      }, 8000);
    }
    if (st === 'connected') tuneNet();
    layout();
  };
  return pc;
}

async function callPeer(id) {
  const peer = S.peers.get(id);
  if (!peer) return;
  peer.chain = peer.chain.then(async () => {
    const pc = newPC(id);
    const a = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const v = pc.addTransceiver('video', { direction: 'sendrecv' });
    await a.sender.replaceTrack(S.local.audio);
    await v.sender.replaceTrack(currentVideoTrack());
    await pc.setLocalDescription(await pc.createOffer());
    socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
  }).catch((e) => console.warn('call', e));
}

async function handleSignal(peer, from, data) {
  if (data.sdp?.type === 'offer') {
    const pc = newPC(from);
    await pc.setRemoteDescription(data.sdp);
    for (const t of pc.getTransceivers()) {
      t.direction = 'sendrecv';
      await t.sender.replaceTrack(t.receiver.track.kind === 'audio' ? S.local.audio : currentVideoTrack());
    }
    await pc.setLocalDescription(await pc.createAnswer());
    socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
    await flushCandidates(peer);
  } else if (data.sdp?.type === 'answer') {
    if (peer.pc?.signalingState !== 'have-local-offer') return;
    await peer.pc.setRemoteDescription(data.sdp);
    await flushCandidates(peer);
  } else if (data.candidate) {
    if (peer.pc?.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
    else peer.pending.push(data.candidate);
  }
}

async function flushCandidates(peer) {
  const list = peer.pending.splice(0);
  for (const c of list) await peer.pc.addIceCandidate(c).catch(() => {});
}

function replaceAll(kind, track) {
  for (const peer of S.peers.values()) {
    const t = peer.pc?.getTransceivers().find((x) => x.receiver.track.kind === kind);
    t?.sender.replaceTrack(track).catch(() => {});
  }
}
const pushVideoTrack = () => replaceAll('video', currentVideoTrack());
const pushAudioTrack = () => replaceAll('audio', S.local.audio);

function sendMedia() {
  if (!S.joined || S.reconnecting) return;
  socket.emit('media', { cam: !!(S.local.video || S.local.screen), mic: !!S.local.audio, screen: !!S.local.screen });
  layout();
}

// ---------- Автовоспроизведение ----------
function safePlay(el) {
  if (!el || !el.srcObject && !el.src) return;
  el.play().catch((err) => {
    if (err.name !== 'NotAllowedError') return;
    blockedMedia.add(el);
    $('#unmuteBtn').classList.remove('hidden');
  });
}
$('#unmuteBtn').onclick = () => {
  ensureAudioCtx();
  pbVideo.muted = false;
  for (const el of blockedMedia) el.play().catch(() => {});
  blockedMedia.clear();
  if (S.playback?.status === 'playing') pbVideo.play().catch(() => {});
  $('#unmuteBtn').classList.add('hidden');
};

// ---------- Кнопки ----------
function setCtrl(btn, { icon, text, off, on, disabled, locked }) {
  btn.querySelector('.ib .i').style.setProperty('--ic', `url(/icons/${icon}.svg)`);
  btn.querySelector('.t').textContent = text;
  btn.classList.toggle('off', !!off);
  btn.classList.toggle('on', !!on);
  btn.disabled = !!disabled;
  let lock = btn.querySelector('.lock');
  if (locked && !lock) { btn.insertAdjacentHTML('beforeend', `<span class="lock" title="Запрещено организатором">${ic('lock', 'sm')}</span>`); }
  if (!locked && lock) lock.remove();
}

function updateButtons() {
  const hidden = S.self?.hidden;
  setCtrl($('#btnMic'), { icon: S.local.audio ? 'mic' : 'mic-off', text: S.local.audio ? 'Микрофон' : 'Вкл. звук', off: !S.local.audio, disabled: hidden, locked: !S.perms.allowMic && !hidden });
  setCtrl($('#btnCam'), { icon: S.local.video ? 'video' : 'video-off', text: S.local.video ? 'Камера' : 'Вкл. видео', off: !S.local.video, disabled: hidden, locked: !S.perms.allowCam && !hidden });
  setCtrl($('#btnScreen'), { icon: S.local.screen ? 'monitor-x' : 'monitor-up', text: S.local.screen ? 'Стоп показ' : 'Экран', on: !!S.local.screen });
  setCtrl($('#btnHand'), { icon: 'hand', text: S.hand ? 'Опустить' : 'Рука', on: S.hand, disabled: hidden });
  updatePeopleCount();
}

$('#btnMic').onclick = async () => {
  ensureAudioCtx();
  if (S.local.audio) stopLocal('audio');
  else {
    if (!S.perms.allowMic) return toast('Организатор не разрешил включать микрофон');
    await startLocal('audio');
  }
  pushAudioTrack(); sendMedia(); updateButtons();
};

$('#btnCam').onclick = async () => {
  if (S.local.video) stopLocal('video');
  else {
    if (!S.perms.allowCam) return toast('Организатор не разрешил включать камеру');
    await startLocal('video');
  }
  pushVideoTrack(); sendMedia(); updateButtons();
};

$('#btnScreen').onclick = async () => {
  if (S.local.screen) stopLocal('screen');
  else {
    try {
      const st = await navigator.mediaDevices.getDisplayMedia({ video: true });
      S.local.screen = st.getVideoTracks()[0];
      S.local.screen.onended = () => { S.local.screen = null; pushVideoTrack(); sendMedia(); updateButtons(); tuneNet(); };
    } catch (e) { return; }
  }
  pushVideoTrack(); sendMedia(); updateButtons(); tuneNet();
};

$('#btnHand').onclick = () => { S.hand = !S.hand; socket.emit('hand', S.hand); updateButtons(); };
$('#btnSettings').onclick = () => openDevices();

$('#btnLeave').onclick = async () => {
  if (REC.recorder && !confirm('Идёт запись. Остановить её, сохранить и выйти?')) return;
  if (REC.recorder) await stopHostRecording();
  socket.emit('leave');
  saveRejoin(null);
  showEnd('Вы покинули встречу', REC.uploading ? 'Запись загружается — не закрывайте страницу, пока не появится «Запись сохранена».' : '');
};

// ---------- Запись ведущего ----------
// Пишется только своё: микрофон ведущего + камера или демонстрация экрана (экран с камерой в углу).
// Участники, их звук и видео в запись не попадают.
const REC = { recorder: null, parts: [], started: 0, uploading: false };

function pickRecMime() {
  const list = ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

function startHostRecording() {
  if (!window.MediaRecorder) return toast('Этот браузер не умеет записывать — используйте Chrome, Edge или Firefox');
  ensureAudioCtx();
  const W = 1280, H = 720;
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d');
  const mkVideo = () => Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true });
  const vCam = mkVideo(), vScr = mkVideo();
  const dest = audioCtx.createMediaStreamDestination();
  const src = { cam: undefined, scr: undefined, mic: undefined, node: null };

  const syncSources = () => {
    if (src.cam !== S.local.video) { src.cam = S.local.video; vCam.srcObject = src.cam ? new MediaStream([src.cam]) : null; vCam.play().catch(() => {}); }
    if (src.scr !== S.local.screen) { src.scr = S.local.screen; vScr.srcObject = src.scr ? new MediaStream([src.scr]) : null; vScr.play().catch(() => {}); }
    if (src.mic !== S.local.audio) {
      src.mic = S.local.audio;
      src.node?.disconnect();
      src.node = src.mic ? audioCtx.createMediaStreamSource(new MediaStream([src.mic])) : null;
      src.node?.connect(dest);
    }
  };
  const fit = (v, x, y, w, h, cover) => {
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    const r = cover ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
    const dw = vw * r, dh = vh * r;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
  };
  const draw = () => {
    syncSources();
    ctx.fillStyle = '#0b0d12'; ctx.fillRect(0, 0, W, H);
    if (src.scr) {
      fit(vScr, 0, 0, W, H, false);
      if (src.cam) {
        ctx.save(); ctx.beginPath(); ctx.roundRect(W - 292, H - 182, 272, 162, 14); ctx.clip();
        fit(vCam, W - 292, H - 182, 272, 162, true);
        ctx.restore();
      }
    } else if (src.cam) {
      fit(vCam, 0, 0, W, H, true);
    } else {
      // камера выключена — аватарка с именем, как в самой встрече
      const name = S.self?.name || '';
      const g = ctx.createLinearGradient(W / 2 - 90, H / 2 - 90, W / 2 + 90, H / 2 + 90);
      g.addColorStop(0, '#8b5cf6'); g.addColorStop(1, '#3b82f6');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(W / 2, H / 2 - 20, 90, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '700 64px Inter, Arial, sans-serif'; ctx.fillText(initials(name), W / 2, H / 2 - 18);
      ctx.font = '500 30px Inter, Arial, sans-serif'; ctx.fillStyle = '#c9cfdc'; ctx.fillText(name, W / 2, H / 2 + 110);
    }
  };
  // таймер в воркере: не замедляется, когда вкладка в фоне (например, во время демонстрации другого окна)
  const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 33)'], { type: 'text/javascript' })));
  ticker.onmessage = draw;
  draw();

  const stream = new MediaStream([canvas.captureStream(30).getVideoTracks()[0], dest.stream.getAudioTracks()[0]]);
  const mimeType = pickRecMime();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined);
  REC.parts = [];
  recorder.ondataavailable = (e) => e.data.size && REC.parts.push(e.data);
  REC.done = new Promise((resolve) => {
    recorder.onstop = () => {
      ticker.terminate();
      src.node?.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      const duration = (Date.now() - REC.started) / 1000;
      const type = (recorder.mimeType || mimeType || 'video/webm').split(';')[0];
      resolve({ blob: new Blob(REC.parts, { type }), duration, ext: type.includes('mp4') ? 'mp4' : 'webm' });
    };
  });
  recorder.start(1000);
  REC.recorder = recorder;
  REC.started = Date.now();
  REC.timer = setInterval(() => ($('#recTime').textContent = fmtTime((Date.now() - REC.started) / 1000)), 500);
  $('#recBadge').classList.remove('hidden');
  updateRecButton();
  toast('Запись началась: пишутся только ваш голос и то, что вы показываете');
}

async function stopHostRecording() {
  if (!REC.recorder) return;
  REC.recorder.stop();
  REC.recorder = null;
  clearInterval(REC.timer);
  $('#recBadge').classList.add('hidden');
  updateRecButton();
  const { blob, duration, ext } = await REC.done;
  if (duration < 1 || !blob.size) return toast('Запись слишком короткая — не сохранена');
  const title = `${S.room?.name || 'Встреча'} — ${new Date(REC.started).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  REC.uploading = true;
  const fd = new FormData();
  fd.append('title', title);
  fd.append('duration', duration);
  fd.append('file', blob, `meeting.${ext}`);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/recordings');
  let last = 0;
  xhr.upload.onprogress = (e) => {
    const pct = e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : 0;
    if (pct - last >= 25) { last = pct; toast(`Сохраняю запись… ${pct}%`, 1500); }
  };
  xhr.onload = () => {
    REC.uploading = false;
    if (xhr.status === 200) {
      toast('Запись сохранена в раздел «Записи»', 5000);
      if (S.role === 'host') api('/api/recordings').then((r) => { S.recordings = r; renderManage(); }).catch(() => {});
    } else toast('Не удалось сохранить запись', 6000);
  };
  xhr.onerror = () => { REC.uploading = false; toast('Ошибка сети — запись не сохранена', 6000); };
  xhr.send(fd);
}

function updateRecButton() {
  setCtrl($('#btnRec'), { icon: REC.recorder ? 'square' : 'circle-dot', text: REC.recorder ? 'Стоп запись' : 'Запись', off: !!REC.recorder });
}
$('#btnRec').onclick = () => (REC.recorder ? stopHostRecording() : startHostRecording());
window.addEventListener('beforeunload', (e) => {
  if (REC.recorder || REC.uploading) { e.preventDefault(); e.returnValue = ''; }
});

function openSide(which) {
  if (S.side === which) which = null;
  S.side = which;
  $('#side').classList.toggle('hidden', !which);
  for (const p of ['people', 'chat', 'manage']) $(`#${p}Panel`).classList.toggle('hidden', which !== p);
  $$('[data-side]').forEach((b) => b.classList.toggle('active', b.dataset.side === which));
  $('#chatForm').classList.toggle('hidden', which !== 'chat');
  if (which === 'chat') { S.unread = 0; updateUnread(); $('#chatInput').focus(); scrollChat(); }
  if (which === 'people') renderPeople();
  if (which === 'manage') renderManage();
  layout();
}
$('#btnPeople').onclick = () => openSide('people');
$('#btnChat').onclick = () => openSide('chat');
$('#btnManage').onclick = () => openSide('manage');
$$('[data-side]').forEach((b) => (b.onclick = () => S.side !== b.dataset.side && openSide(b.dataset.side)));
$('#sideClose').onclick = () => openSide(null);

// ---------- Чат ----------
function addChat(msg) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  const time = new Date(msg.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `${avatarHtml(msg.name)}<div class="grow"><div class="who"><b>${esc(msg.name)}</b>${time}</div><div class="txt ${isJumbo(msg.text) ? 'jumbo' : ''}">${chatHtml(msg.text)}</div></div>`;
  $('#chatList').appendChild(el);
  if (S.side !== 'chat') { S.unread++; updateUnread(); }
  scrollChat();
}
function scrollChat() { const b = $('#sideBody'); b.scrollTop = b.scrollHeight; }
function updateUnread() {
  $('#chatCount').textContent = S.unread;
  $('#chatCount').classList.toggle('hidden', !S.unread);
}
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  if (S.reconnecting) return toast('Нет связи — сообщение не отправлено');
  socket.emit('chat', text);
  $('#chatInput').value = '';
};

// ---------- Реакции и эмодзи ----------
$('#btnReact').onclick = () => {
  if (S.self?.hidden) return;
  emojiPicker($('#btnReact'), (code) => socket.emit('reaction', code), { quick: true });
};
$('#chatEmoji').onclick = () => {
  emojiPicker($('#chatEmoji'), (code, text) => {
    const inp = $('#chatInput');
    inp.value += text;
    inp.focus();
  });
};
socket.on('reaction', ({ from, emoji }) => {
  const key = from === socket.id ? SELF : from;
  const t = S.tiles.get(key);
  if (!t) return;
  const who = key === SELF ? 'Вы' : key === PRESENTER ? S.room?.presenter?.name : S.peers.get(key)?.info.name;
  const el = document.createElement('div');
  el.className = 'reaction';
  el.style.left = 8 + Math.random() * 62 + '%';
  el.innerHTML = emojiHtml(emoji, '') + (who ? `<span class="who">${esc(who)}</span>` : '');
  t.el.appendChild(el);
  setTimeout(() => el.remove(), 3700);
});

// ---------- Участники ----------
function presenterInfo() {
  const pr = S.room?.presenter;
  if (!pr?.visible) return null;
  const pb = S.playback;
  const playing = pb?.status === 'playing';
  const active = pb && (pb.status === 'playing' || pb.status === 'paused');
  return { id: PRESENTER, name: pr.name, cam: !!active, mic: playing, hand: false };
}

function updatePeopleCount() {
  let n = [...S.peers.values()].filter((p) => !p.info.hidden).length + (S.self && !S.self.hidden ? 1 : 0);
  if (presenterInfo()) n++;
  $('#peopleCount').textContent = n;
}

function renderPeople() {
  updatePeopleCount();
  if (S.side !== 'people') return;
  const isHost = S.role === 'host' && S.adminState;
  $('#hostControls').classList.toggle('hidden', !isHost);
  $('#peopleList').classList.toggle('hidden', !!isHost);
  if (isHost) return renderControls($('#hostControls'), S.adminState, socket);
  const list = [];
  const pres = presenterInfo();
  if (pres) list.push({ ...pres, tag: 'организатор' });
  for (const p of S.peers.values()) if (!p.info.hidden) list.push({ ...p.info, tag: p.info.role === 'host' ? 'организатор' : '' });
  if (S.self && !S.self.hidden) list.push({ ...S.self, label: S.self.name + ' (вы)', cam: !!S.local.video, mic: !!S.local.audio, hand: S.hand });
  $('#peopleList').innerHTML = `<div class="section-title">В комнате · ${list.length}</div>` + list.map((p) => `
    <li>${avatarHtml(p.name)}
      <div class="nm"><div>${esc(p.label || p.name)} ${p.tag ? `<span class="badge accent">${p.tag}</span>` : ''}</div></div>
      <div class="icons">${p.hand ? ic('hand', 'sm') : ''}${p.mic ? ic('mic', 'sm') : `<span class="off">${ic('mic-off', 'sm')}</span>`}${p.cam ? ic('video', 'sm') : `<span class="faint">${ic('video-off', 'sm')}</span>`}</div></li>`).join('');
}

// ---------- Управление встречей (ведущий) ----------
function renderManage() {
  if (S.side !== 'manage' || !S.adminState) return;
  const { room, playback } = S.adminState;
  const panel = $('#managePanel');
  const recOptions = S.recordings.map((r) => `<option value="${r.id}" ${r.id === (playback.recordingId || room.playback.recordingId) ? 'selected' : ''}>${esc(r.title)}${r.duration ? ' · ' + fmtTime(r.duration) : ''}</option>`).join('');
  const status = { idle: '<span class="badge">не запущена</span>', playing: '<span class="badge live">идёт</span>', paused: '<span class="badge warn">пауза</span>', ended: '<span class="badge">закончилась</span>' }[playback.status];
  const focused = document.activeElement && panel.contains(document.activeElement) && document.activeElement.tagName === 'SELECT';
  if (focused) return;
  panel.innerHTML = `
    <div class="section-title">Доступ</div>
    ${switchesHtml(room.settings, 'data-mset')}
    <div class="section-title">Запись ${status}</div>
    <select id="mRec" style="margin-bottom:8px">${recOptions || '<option value="">Нет записей</option>'}</select>
    <div class="small muted" style="margin-bottom:8px">${playback.title ? esc(playback.title) + ' · ' : ''}<span id="mPos">${fmtTime(expectedPos())}</span>${playback.duration ? ' / ' + fmtTime(playback.duration) : ''}</div>
    <div class="row" style="gap:6px">
      <button class="btn sm ok" data-pb="start">${ic('play', 'sm')} Сначала</button>
      ${playback.status === 'playing' ? `<button class="btn sm" data-pb="pause">${ic('pause', 'sm')} Пауза</button>` : ''}
      ${playback.status === 'paused' ? `<button class="btn sm" data-pb="resume">${ic('play', 'sm')} Дальше</button>` : ''}
      ${playback.status !== 'idle' ? `<button class="btn sm danger" data-pb="stop">${ic('square', 'sm')} Стоп</button>` : ''}
    </div>
    <div class="section-title">Встреча</div>
    <div class="row" style="gap:6px">
      <button class="btn sm" id="mCopy">${ic('link', 'sm')} Ссылка</button>
      <a class="btn sm" href="/admin/room/${encodeURIComponent(roomId)}" target="_blank">${ic('external-link', 'sm')} Пульт</a>
      <button class="btn sm danger" id="mEnd">${ic('phone-off', 'sm')} Завершить для всех</button>
    </div>`;
  $$('[data-mset]', panel).forEach((el) => (el.onchange = () => socket.emit('admin:settings', { roomId, settings: { [el.dataset.mset]: el.checked } })));
  $$('[data-pb]', panel).forEach((b) => (b.onclick = () => {
    const action = b.dataset.pb;
    if (action === 'stop' && !confirm('Остановить запись у всех?')) return;
    socket.emit('admin:playback', { roomId, action, recordingId: $('#mRec').value || undefined });
  }));
  $('#mCopy').onclick = async () => { await navigator.clipboard.writeText(`${location.origin}/r/${roomId}`).catch(() => {}); toast('Ссылка скопирована'); };
  $('#mEnd').onclick = () => { if (confirm('Завершить встречу для всех участников?')) socket.emit('admin:end', { roomId }); };
}

// ---------- Плитки и раскладка ----------
function ensureTile(key) {
  let t = S.tiles.get(key);
  if (t) return t;
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML = `<div class="avatar"><span></span></div><img class="hand hidden" alt="">
    <div class="net hidden">${ic('triangle-alert', 'sm')} связь</div>
    <div class="name"><span class="mic"></span><b></b></div>`;
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true;
  if (S.dev.spk) video.setSinkId?.(S.dev.spk).catch(() => {});
  el.prepend(video);
  t = { el, video, avatar: $('.avatar', el), nameEl: $('.name b', el), micEl: $('.name .mic', el), handEl: $('.hand', el), netEl: $('.net', el) };
  t.handEl.src = emojiSrc('✋');
  S.tiles.set(key, t);
  return t;
}

function setTile(t, { name, label, cam, mic, hand, stream, mirror, muted, net }) {
  t.nameEl.textContent = label || name;
  t.micEl.innerHTML = mic ? '' : ic('mic-off', 'sm');
  t.handEl.classList.toggle('hidden', !hand);
  t.netEl.classList.toggle('hidden', !net);
  const sp = $('span', t.avatar);
  sp.textContent = initials(name);
  sp.style.background = avatarColor(name);
  t.video.muted = !!muted;
  if (stream !== undefined && t.video.srcObject !== stream) {
    t.video.srcObject = stream;
    safePlay(t.video);
  }
  t.video.classList.toggle('mirror', !!mirror);
  // видео не скрываем через display:none, чтобы звук продолжал играть
  t.video.style.visibility = cam ? 'visible' : 'hidden';
  t.avatar.classList.toggle('hidden', !!cam);
}

function layout() {
  if (!S.joined) return;
  const grid = $('#grid');
  const keys = [];
  const pb = S.playback;
  const pbActive = pb && pb.url && (pb.status === 'playing' || pb.status === 'paused');
  const pres = presenterInfo();

  // виртуальный ведущий (запись как камера)
  if (pres) {
    const t = ensureTile(PRESENTER);
    setTile(t, { name: pres.name, cam: pbActive && S.room.presenter.display === 'camera', mic: pres.mic });
    t.video.style.display = 'none';
    if (pbActive && S.room.presenter.display === 'camera' && pbVideo.parentNode !== t.el) t.el.prepend(pbVideo);
    pbVideo.style.visibility = pbActive ? 'visible' : 'hidden';
    keys.push(PRESENTER);
  }

  // реальные участники
  const sorted = [...S.peers.values()].filter((p) => !p.info.hidden)
    .sort((a, b) => (a.info.role === 'host' ? -1 : 0) - (b.info.role === 'host' ? -1 : 0));
  for (const p of sorted) {
    const t = ensureTile(p.info.id);
    const hasVideo = p.info.cam && p.stream.getVideoTracks().some((tr) => tr.readyState === 'live');
    const net = ['failed', 'disconnected'].includes(p.pc?.connectionState);
    setTile(t, { name: p.info.name, cam: hasVideo, mic: p.info.mic, hand: p.info.hand, stream: p.stream, net });
    keys.push(p.info.id);
  }
  // невидимые участники: плитку не показываем, но звук их микрофона не нужен — они без медиа
  // своя плитка
  if (S.self && !S.self.hidden) {
    const t = ensureTile(SELF);
    const track = currentVideoTrack();
    if (t.localTrack !== track) {
      t.localTrack = track;
      setTile(t, { name: S.self.name, stream: track ? new MediaStream([track]) : null, muted: true });
    }
    setTile(t, { name: S.self.name, label: S.self.name + ' (вы)', cam: !!track, mic: !!S.local.audio, hand: S.hand, mirror: !S.local.screen, muted: true });
    keys.splice(pres ? 1 : 0, 0, SELF);
  }

  // убираем лишние плитки
  for (const [k, t] of S.tiles) {
    if (!keys.includes(k)) {
      if (k === PRESENTER && pbVideo.parentNode === t.el) pbVideo.remove();
      t.el.remove(); S.tiles.delete(k);
    }
  }
  keys.forEach((k, i) => { const el = S.tiles.get(k).el; if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null); });

  // сцена: запись в режиме «презентация» или демонстрация экрана
  const stage = $('#stage');
  let stageOn = false;
  if (pbActive && S.room.presenter.display === 'presentation') {
    stageOn = true;
    if (pbVideo.parentNode !== stage) stage.prepend(pbVideo);
    pbVideo.style.visibility = 'visible';
    $('#stageLabel').innerHTML = `${ic('presentation', 'sm')} ${esc(S.room.presenter.name)} — демонстрация экрана`;
    stageVideo.remove();
  } else {
    const sharer = sorted.find((p) => p.info.screen);
    if (sharer) {
      stageOn = true;
      if (stageVideo.srcObject !== sharer.stream) { stageVideo.srcObject = sharer.stream; safePlay(stageVideo); }
      if (stageVideo.parentNode !== stage) stage.prepend(stageVideo);
      $('#stageLabel').innerHTML = `${ic('monitor-up', 'sm')} ${esc(sharer.info.name)} — демонстрация экрана`;
    } else if (S.local.screen) {
      stageOn = true;
      if (stageVideo.srcObject?.getVideoTracks()[0] !== S.local.screen) stageVideo.srcObject = new MediaStream([S.local.screen]);
      if (stageVideo.parentNode !== stage) stage.prepend(stageVideo);
      $('#stageLabel').innerHTML = `${ic('monitor-up', 'sm')} Вы показываете экран`;
    } else {
      stageVideo.remove();
    }
    if (pbVideo.parentNode === stage) pbVideo.remove();
  }
  stage.classList.toggle('hidden', !stageOn);
  $('#content').classList.toggle('with-stage', stageOn);
  sizeGrid(keys.length, stageOn);
  renderPeople();
}

function sizeGrid(n, stageOn) {
  const grid = $('#grid');
  if (stageOn || !n) { grid.style.gridTemplateColumns = ''; return; }
  const W = grid.clientWidth, H = grid.clientHeight, gap = 10;
  let best = { w: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * 16 / 9);
    if (w > best.w) best = { w, cols };
  }
  grid.style.gridTemplateColumns = `repeat(${best.cols}, ${Math.floor(best.w)}px)`;
}
window.addEventListener('resize', () => layout());

const stageVideo = document.createElement('video');
stageVideo.autoplay = true; stageVideo.playsInline = true; stageVideo.muted = true;

// ---------- Воспроизведение записи ----------
const pbVideo = document.createElement('video');
pbVideo.playsInline = true;
pbVideo.preload = 'auto';
pbVideo.controls = false;
pbVideo.disablePictureInPicture = true;
pbVideo.setAttribute('disableRemotePlayback', '');
pbVideo.oncontextmenu = (e) => e.preventDefault();
pbVideo.style.pointerEvents = 'none';
pbVideo.addEventListener('error', () => {
  const alt = S.playback?.altUrl && new URL(S.playback.altUrl, location.href).href;
  if (alt && pbVideo.src !== alt) { pbVideo.src = alt; pbVideo.load(); syncVideo(true); }
});
if (S.dev.spk) pbVideo.setSinkId?.(S.dev.spk).catch(() => {});

function expectedPos() {
  const p = S.playback;
  if (!p) return 0;
  return p.position + (p.status === 'playing' ? (performance.now() - p.recvAt) / 1000 : 0);
}

function applyPlayback(pb) {
  pb.recvAt = performance.now();
  S.playback = pb;
  const active = pb.url && (pb.status === 'playing' || pb.status === 'paused');
  if (active) {
    const abs = new URL(pickMediaUrl(pb.url, pb.altUrl), location.href).href;
    if (pbVideo.src !== abs) { pbVideo.src = abs; pbVideo.load(); }
    syncVideo(true);
  } else {
    pbVideo.pause();
  }
  layout();
}

function syncVideo(force) {
  const p = S.playback;
  if (!p || !p.url || !(p.status === 'playing' || p.status === 'paused')) return;
  if (pbVideo.readyState < 1) {
    if (!pbVideo._waiting) {
      pbVideo._waiting = true;
      pbVideo.addEventListener('loadedmetadata', () => { pbVideo._waiting = false; syncVideo(true); }, { once: true });
    }
    return;
  }
  const want = expectedPos();
  const dur = p.duration || pbVideo.duration;
  if (isFinite(dur) && want >= dur) { pbVideo.pause(); return; }
  const d = window.PlaybackSync?.decide?.({ current: pbVideo.currentTime, want, readyState: pbVideo.readyState, paused: pbVideo.paused, force: !!force });
  if (d) {
    if (d.seek != null && isFinite(d.seek)) pbVideo.currentTime = d.seek;
    if (isFinite(d.rate) && d.rate > 0 && pbVideo.playbackRate !== d.rate) pbVideo.playbackRate = d.rate;
  } else if (force || Math.abs(pbVideo.currentTime - want) > 2) pbVideo.currentTime = want;
  if (p.status === 'playing' && pbVideo.paused) playPb();
  if (p.status === 'paused' && !pbVideo.paused) pbVideo.pause();
}
setInterval(() => syncVideo(false), 1000);

function playPb() {
  pbVideo.play().then(connectPresenterAudio).catch((err) => {
    if (err.name !== 'NotAllowedError') return;
    // браузер запретил автозапуск со звуком — играем без звука и просим нажать кнопку
    pbVideo.muted = true;
    pbVideo.play().catch(() => {});
    $('#unmuteBtn').classList.remove('hidden');
  });
}

// ---------- Индикатор «говорит» ----------
const meters = new Map(); // key -> analyser
function connectPresenterAudio() {
  // звук записи не пропускаем через WebAudio (иначе на iPhone он может пропасть) — только снимаем копию в Chrome
  if (meters.has(PRESENTER) || !pbVideo.captureStream || pbVideo.mozCaptureStream || !ensureAudioCtx()) return;
  try {
    const track = pbVideo.captureStream().getAudioTracks()[0];
    if (track) meterFor(PRESENTER, track);
  } catch (e) {}
}

function meterFor(key, track) {
  let m = meters.get(key);
  if (m && m.track === track) return m;
  if (!audioCtx || !track) return null;
  try {
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    audioCtx.createMediaStreamSource(new MediaStream([track])).connect(an);
    an.track = track;
    meters.set(key, an);
    return an;
  } catch (e) { return null; }
}

const buf = new Uint8Array(512);
function level(an) {
  an.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < an.fftSize; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / an.fftSize);
}

let fakeTalk = 0;
setInterval(() => {
  if (!S.joined) return;
  fakeTalk = (fakeTalk + 1) % 1000;
  for (const [key, t] of S.tiles) {
    let speaking = false;
    if (key === PRESENTER) {
      const an = meters.get(PRESENTER);
      const playing = S.playback?.status === 'playing' && !pbVideo.paused;
      // если анализ звука недоступен (Safari/Firefox) — подсвечиваем ведущего, пока идёт запись
      speaking = playing && (an ? level(an) > 0.03 : fakeTalk % 12 < 9);
    } else if (key === SELF) {
      const an = meterFor(SELF, S.local.audio);
      speaking = !!S.local.audio && !!an && level(an) > 0.04;
    } else {
      const p = S.peers.get(key);
      const an = p && meterFor(key, p.stream.getAudioTracks()[0]);
      speaking = !!p?.info.mic && !!an && level(an) > 0.04;
    }
    t.el.classList.toggle('speaking', speaking);
  }
}, 200);

// ---------- Часы ----------
setInterval(() => {
  if (!S.joined) return;
  $('#meetClock').textContent = fmtTime((Date.now() - S.joinedAt) / 1000);
  const mPos = $('#mPos');
  if (mPos && S.playback) mPos.textContent = fmtTime(Math.min(expectedPos(), S.playback.duration || Infinity));
}, 1000);
