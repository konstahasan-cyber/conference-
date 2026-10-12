// Клиент комнаты: зал ожидания, WebRTC (mesh), чат, синхронный показ записи.
const roomId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop());
const PRESENTER = '__presenter';
const SELF = '__self';

const S = {
  self: null,
  role: 'guest',
  joined: false,
  peers: new Map(),          // id -> { info, pc, stream, chain, pending }
  tiles: new Map(),          // key -> { el, video, avatar, nameEl, micEl, handEl }
  room: null,
  perms: { allowCam: false, allowMic: false },
  local: { audio: null, video: null, screen: null },
  iceServers: [],
  hand: false,
  playback: null,
  adminState: null,
  side: null,
  unread: 0,
  joinedAt: 0,
  isAdmin: false,
};
let audioCtx = null;

const socket = io({ autoConnect: true });

// ---------- Перед входом ----------
(async function init() {
  $('#nameInput').value = localStorage.getItem('confName') || '';
  try {
    const [info, me, cfg] = await Promise.all([
      api(`/api/rooms/${encodeURIComponent(roomId)}/public`),
      api('/api/me'),
      api('/api/config'),
    ]);
    S.iceServers = cfg.iceServers;
    loadEmojis();
    S.isAdmin = me.admin;
    S.perms = { allowCam: info.allowCamera, allowMic: info.allowMic };
    $('#preTitle').textContent = info.name;
    $('#preCode').textContent = `Код встречи: ${info.id}`;
    document.title = info.name;
    if (me.admin) { $('#hostOptions').classList.remove('hidden'); updatePrejoinButtons(); }
  } catch (e) {
    $('#preTitle').textContent = 'Встреча не найдена';
    $('#preError').textContent = 'Проверьте ссылку-приглашение.';
    $('#joinBtn').disabled = true;
  }
  updatePrejoinButtons();
})();

function prejoinAllowed(kind) {
  if (S.isAdmin && $('#asHost').checked) return !$('#asHidden').checked;
  return kind === 'cam' ? S.perms.allowCam : S.perms.allowMic;
}

function updatePrejoinButtons() {
  const cam = $('#preCam'), mic = $('#preMic');
  if (!prejoinAllowed('cam') && S.local.video) stopLocal('video');
  if (!prejoinAllowed('mic') && S.local.audio) stopLocal('audio');
  cam.disabled = !prejoinAllowed('cam');
  mic.disabled = !prejoinAllowed('mic');
  cam.textContent = !prejoinAllowed('cam') ? '📷 Камера недоступна' : S.local.video ? '📷 Камера вкл.' : '📷 Камера выкл.';
  mic.textContent = !prejoinAllowed('mic') ? '🎤 Микрофон недоступен' : S.local.audio ? '🎤 Микрофон вкл.' : '🎤 Микрофон выкл.';
  cam.classList.toggle('primary', !!S.local.video);
  mic.classList.toggle('primary', !!S.local.audio);
  const pv = $('#previewVideo');
  pv.srcObject = S.local.video ? new MediaStream([S.local.video]) : null;
  $('#previewOff').classList.toggle('hidden', !!S.local.video);
}
$('#asHost').onchange = $('#asHidden').onchange = updatePrejoinButtons;
$('#preCam').onclick = async () => { S.local.video ? stopLocal('video') : await startLocal('video'); updatePrejoinButtons(); };
$('#preMic').onclick = async () => { S.local.audio ? stopLocal('audio') : await startLocal('audio'); updatePrejoinButtons(); };

async function startLocal(kind) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(kind === 'video'
      ? { video: { width: { ideal: 1280 }, height: { ideal: 720 } } }
      : { audio: { echoCancellation: true, noiseSuppression: true } });
    S.local[kind] = stream.getTracks()[0];
    return true;
  } catch (e) {
    toast(kind === 'video' ? 'Нет доступа к камере' : 'Нет доступа к микрофону');
    return false;
  }
}

function stopLocal(kind) {
  S.local[kind]?.stop();
  S.local[kind] = null;
}

$('#joinBtn').onclick = () => {
  const name = $('#nameInput').value.trim();
  if (!name) { $('#nameInput').focus(); return toast('Введите имя'); }
  localStorage.setItem('confName', name);
  // Создаём аудиоконтекст и «разблокируем» видео в момент клика — чтобы потом звук записи шёл без ограничений автозапуска
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch (e) {}
  pbVideo.play().catch(() => {});
  const asHost = S.isAdmin && $('#asHost').checked;
  const hidden = asHost && $('#asHidden').checked;
  $('#joinBtn').disabled = true;
  socket.emit('join', { roomId, name, asHost, hidden }, (res) => {
    $('#joinBtn').disabled = false;
    if (res?.error) { $('#preError').textContent = res.error; return; }
    if (res.status === 'waiting') {
      $('#waitTitle').textContent = $('#preTitle').textContent;
      show('waiting');
    }
  });
};

$('#cancelWait').onclick = () => { socket.emit('leave'); show('prejoin'); };

function show(view) {
  for (const v of ['prejoin', 'waiting', 'meeting', 'end']) $(`#${v}View`).classList.toggle('hidden', v !== view);
}

function showEnd(title, text) {
  S.joined = false;
  for (const peer of S.peers.values()) peer.pc?.close();
  S.peers.clear();
  stopLocal('video'); stopLocal('audio'); stopLocal('screen');
  pbVideo.pause();
  $('#endTitle').textContent = title;
  $('#endText').textContent = text || '';
  $('#unmuteBtn').classList.add('hidden');
  show('end');
}

// ---------- Вход во встречу ----------
socket.on('joined', ({ self, peers, room, playback, chat }) => {
  S.joined = true;
  S.self = self;
  S.role = self.role;
  S.joinedAt = Date.now();
  S.perms = { allowCam: self.allowCam, allowMic: self.allowMic };
  if (self.hidden) { stopLocal('video'); stopLocal('audio'); }
  if (!S.perms.allowCam) stopLocal('video');
  if (!S.perms.allowMic) stopLocal('audio');
  show('meeting');
  $('#btnScreen').classList.toggle('hidden', S.role !== 'host' || self.hidden);
  applyRoom(room);
  $('#chatList').innerHTML = '';
  chat.forEach(addChat);
  S.unread = 0;
  for (const info of peers) addPeer(info).initiate = true;
  for (const info of peers) callPeer(info.id);
  applyPlayback(playback);
  sendMedia();
  updateButtons();
  if (S.role === 'host') socket.emit('admin:watch', { roomId });
  layout();
});

socket.on('denied', () => showEnd('Вход отклонён', 'Организатор не разрешил вам присоединиться к встрече.'));
socket.on('kicked', () => showEnd('Вы удалены из встречи', 'Организатор удалил вас из встречи.'));
socket.on('meeting-ended', ({ reason } = {}) => showEnd('Встреча завершена', reason));
socket.on('disconnect', () => {
  if (S.joined) showEnd('Соединение прервано', 'Проверьте интернет и подключитесь снова.');
  else if (!$('#waitingView').classList.contains('hidden')) showEnd('Соединение прервано', 'Попробуйте подключиться снова.');
});

socket.on('peer-joined', (info) => { addPeer(info); layout(); });
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
socket.on('lower-hand', () => { S.hand = false; updateButtons(); });

socket.on('admin:state', (st) => {
  S.adminState = st;
  const n = st.waiting.length;
  $('#waitCount').textContent = n;
  $('#waitCount').classList.toggle('hidden', !n);
  if (n && S.side !== 'people') toast(`В зале ожидания: ${n}`, 2500);
  renderPeople();
});

function applyRoom(room) {
  const prevVisible = S.room?.presenter?.visible;
  S.room = room;
  $('#meetTitle').textContent = room.name;
  document.title = room.name;
  const canChat = room.allowChat || S.role === 'host';
  $('#chatInput').disabled = !canChat;
  $('#chatInput').placeholder = canChat ? 'Сообщение всем' : 'Чат отключён организатором';
  if (prevVisible !== room.presenter.visible) layout();
  else layout();
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
  peer.pc?.close();
  S.peers.delete(id);
  const t = S.tiles.get(id);
  if (t) { t.el.remove(); S.tiles.delete(id); }
  layout();
}

const currentVideoTrack = () => S.local.screen || S.local.video || null;

function newPC(id) {
  const peer = S.peers.get(id);
  peer.pc?.close();
  peer.stream = new MediaStream();
  const pc = new RTCPeerConnection({ iceServers: S.iceServers });
  peer.pc = pc;
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    peer.stream.getTracks().filter((t) => t.kind === e.track.kind).forEach((t) => peer.stream.removeTrack(t));
    peer.stream.addTrack(e.track);
    e.track.onunmute = () => layout();
    layout();
  };
  pc.onconnectionstatechange = () => {
    // если соединение оборвалось — инициатор переподключается
    if (pc.connectionState === 'failed' && peer.initiate && S.peers.get(id) === peer) callPeer(id);
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
  if (!S.joined) return;
  socket.emit('media', { cam: !!(S.local.video || S.local.screen), mic: !!S.local.audio, screen: !!S.local.screen });
  layout();
}

// ---------- Кнопки ----------
function setCtrl(btn, { icon, text, off, disabled, locked }) {
  btn.querySelector('.i').textContent = icon;
  btn.querySelector('.t').textContent = text;
  btn.classList.toggle('off', !!off);
  btn.disabled = !!disabled;
  let lock = btn.querySelector('.lock');
  if (locked && !lock) { lock = document.createElement('span'); lock.className = 'lock'; lock.textContent = '🔒'; btn.appendChild(lock); }
  if (!locked && lock) lock.remove();
}

function updateButtons() {
  const hidden = S.self?.hidden;
  setCtrl($('#btnMic'), {
    icon: S.local.audio ? '🎤' : '🔇',
    text: S.local.audio ? 'Выкл. звук' : 'Вкл. звук',
    off: !S.local.audio, disabled: hidden, locked: !S.perms.allowMic,
  });
  setCtrl($('#btnCam'), {
    icon: '📷',
    text: S.local.video ? 'Остановить видео' : 'Начать видео',
    off: !S.local.video, disabled: hidden, locked: !S.perms.allowCam,
  });
  setCtrl($('#btnScreen'), { icon: '🖥', text: S.local.screen ? 'Остановить показ' : 'Демонстрация', off: false });
  setCtrl($('#btnHand'), { icon: '✋', text: S.hand ? 'Опустить руку' : 'Поднять руку', off: false, disabled: hidden });
  $('#btnHand').classList.toggle('off', S.hand);
}

$('#btnMic').onclick = async () => {
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
      S.local.screen.onended = () => { S.local.screen = null; pushVideoTrack(); sendMedia(); updateButtons(); };
    } catch (e) { return; }
  }
  pushVideoTrack(); sendMedia(); updateButtons();
};

$('#btnHand').onclick = () => { S.hand = !S.hand; socket.emit('hand', S.hand); updateButtons(); };

$('#btnLeave').onclick = () => {
  socket.emit('leave');
  showEnd('Вы покинули встречу', '');
};

function openSide(which) {
  if (S.side === which) which = null;
  S.side = which;
  $('#side').classList.toggle('hidden', !which);
  $('#peoplePanel').classList.toggle('hidden', which !== 'people');
  $('#chatPanel').classList.toggle('hidden', which !== 'chat');
  $('#chatForm').classList.toggle('hidden', which !== 'chat');
  $('#sideTitle').textContent = which === 'chat' ? 'Чат' : 'Участники';
  if (which === 'chat') { S.unread = 0; updateUnread(); $('#chatInput').focus(); scrollChat(); }
  if (which === 'people') renderPeople();
  layout();
}
$('#btnPeople').onclick = () => openSide('people');
$('#btnChat').onclick = () => openSide('chat');
$('#sideClose').onclick = () => openSide(null);

// ---------- Чат ----------
function addChat(msg) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  const time = new Date(msg.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `<div class="who"><b>${esc(msg.name)}</b> · ${time}</div><div class="txt">${chatHtml(msg.text)}</div>`;
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
  socket.emit('chat', text);
  $('#chatInput').value = '';
};

// ---------- Реакции и эмодзи ----------
$('#btnReact').onclick = (e) => {
  e.stopPropagation();
  if (S.self?.hidden) return toast('В режиме наблюдателя реакции недоступны');
  emojiPicker($('#btnReact'), (code) => socket.emit('reaction', code));
};
$('#chatEmoji').onclick = (e) => {
  e.stopPropagation();
  emojiPicker($('#chatEmoji'), (code, name) => {
    const inp = $('#chatInput');
    inp.value += name ? `:${name}:` : code;
    inp.focus();
  });
};
socket.on('reaction', ({ from, emoji }) => {
  const key = from === socket.id ? SELF : from;
  const t = S.tiles.get(key);
  if (!t) return;
  const el = document.createElement('div');
  el.className = 'reaction';
  el.style.left = 10 + Math.random() * 60 + '%';
  el.innerHTML = emojiHtml(emoji);
  t.el.appendChild(el);
  setTimeout(() => el.remove(), 3600);
});
socket.on('emojis-updated', () => loadEmojis());

// ---------- Участники ----------
function presenterInfo() {
  const pr = S.room?.presenter;
  if (!pr?.visible) return null;
  const pb = S.playback;
  const playing = pb?.status === 'playing';
  const active = pb && (pb.status === 'playing' || pb.status === 'paused');
  return { id: PRESENTER, name: pr.name, cam: !!active, mic: playing, hand: false };
}

function renderPeople() {
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
  $('#peopleList').innerHTML = `<div class="section-title">Участники (${list.length})</div>` + list.map((p) => `
    <li><div class="mini-avatar" style="background:${avatarColor(p.name)}">${esc(initials(p.name))}</div>
      <div class="nm">${esc(p.label || p.name)} ${p.tag ? `<span class="badge">${p.tag}</span>` : ''}</div>
      <div class="icons">${p.hand ? '✋' : ''}<span>${p.mic ? '🎤' : '🔇'}</span><span>${p.cam ? '📷' : '<span class="muted">📷✕</span>'}</span></div></li>`).join('');
}

// ---------- Плитки и раскладка ----------
function ensureTile(key) {
  let t = S.tiles.get(key);
  if (t) return t;
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML = '<div class="avatar"><span></span></div><div class="hand hidden">✋</div><div class="name"><span class="mic"></span><b></b></div>';
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true;
  el.prepend(video);
  t = { el, video, avatar: $('.avatar', el), nameEl: $('.name b', el), micEl: $('.name .mic', el), handEl: $('.hand', el) };
  S.tiles.set(key, t);
  return t;
}

function setTile(t, { name, label, cam, mic, hand, stream, mirror, muted }) {
  t.nameEl.textContent = label || name;
  t.micEl.textContent = mic ? '' : '🔇';
  t.micEl.className = 'mic ico-muted';
  t.handEl.classList.toggle('hidden', !hand);
  const sp = $('span', t.avatar);
  sp.textContent = initials(name);
  sp.style.background = avatarColor(name);
  if (stream !== undefined && t.video.srcObject !== stream) {
    t.video.srcObject = stream;
    t.video.play().catch(() => {});
  }
  t.video.muted = !!muted;
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
    setTile(t, { name: p.info.name, cam: hasVideo, mic: p.info.mic, hand: p.info.hand, stream: p.stream });
    keys.push(p.info.id);
  }
  // свои плитки
  if (S.self && !S.self.hidden) {
    const t = ensureTile(SELF);
    const track = currentVideoTrack();
    if (t.localTrack !== track) {
      t.localTrack = track;
      setTile(t, { name: S.self.name, stream: track ? new MediaStream([track]) : null });
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

  // сцена: запись в режиме «презентация» или демонстрация экрана участником
  const stage = $('#stage');
  let stageOn = false;
  if (pbActive && S.room.presenter.display === 'presentation') {
    stageOn = true;
    if (pbVideo.parentNode !== stage) stage.prepend(pbVideo);
    pbVideo.style.visibility = 'visible';
    $('#stageLabel').textContent = `${S.room.presenter.name} — демонстрация экрана`;
    stageVideo.remove();
  } else {
    const sharer = sorted.find((p) => p.info.screen);
    if (sharer) {
      stageOn = true;
      if (stageVideo.srcObject !== sharer.stream) { stageVideo.srcObject = sharer.stream; stageVideo.play().catch(() => {}); }
      if (stageVideo.parentNode !== stage) stage.prepend(stageVideo);
      $('#stageLabel').textContent = `${sharer.info.name} — демонстрация экрана`;
    } else if (S.local.screen) {
      stageOn = true;
      if (stageVideo.srcObject?.getVideoTracks()[0] !== S.local.screen) stageVideo.srcObject = new MediaStream([S.local.screen]);
      if (stageVideo.parentNode !== stage) stage.prepend(stageVideo);
      $('#stageLabel').textContent = 'Вы показываете экран';
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
    const abs = new URL(pb.url, location.href).href;
    if (pbVideo.src !== abs) { pbVideo.src = abs; pbVideo.load(); }
    connectPresenterAudio();
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
  if (force || Math.abs(pbVideo.currentTime - want) > 2) pbVideo.currentTime = want;
  if (p.status === 'playing' && pbVideo.paused) playPb();
  if (p.status === 'paused' && !pbVideo.paused) pbVideo.pause();
}
setInterval(() => syncVideo(false), 3000);

function playPb() {
  pbVideo.play().catch((err) => {
    if (err.name !== 'NotAllowedError') return;
    // браузер запретил автозапуск со звуком — играем без звука и просим нажать кнопку
    pbVideo.muted = true;
    pbVideo.play().catch(() => {});
    $('#unmuteBtn').classList.remove('hidden');
  });
}
$('#unmuteBtn').onclick = () => {
  pbVideo.muted = false;
  audioCtx?.resume();
  pbVideo.play().catch(() => {});
  $('#unmuteBtn').classList.add('hidden');
};

// ---------- Индикатор «говорит» ----------
const meters = new Map(); // key -> analyser
function connectPresenterAudio() {
  if (meters.has(PRESENTER) || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const src = audioCtx.createMediaElementSource(pbVideo);
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    an.connect(audioCtx.destination);
    meters.set(PRESENTER, an);
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

setInterval(() => {
  if (!S.joined) return;
  for (const [key, t] of S.tiles) {
    let an = null, on = false;
    if (key === PRESENTER) { an = meters.get(PRESENTER); on = S.playback?.status === 'playing'; }
    else if (key === SELF) { an = meterFor(SELF, S.local.audio); on = !!S.local.audio; }
    else {
      const p = S.peers.get(key);
      an = p && meterFor(key, p.stream.getAudioTracks()[0]);
      on = !!p?.info.mic;
    }
    t.el.classList.toggle('speaking', !!(on && an && level(an) > 0.04));
  }
}, 200);

// ---------- Часы ----------
setInterval(() => {
  if (S.joined) $('#meetClock').textContent = fmtTime((Date.now() - S.joinedAt) / 1000);
}, 1000);
