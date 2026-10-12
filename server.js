const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { execFile } = require('child_process');
const multer = require('multer');
const { Server } = require('socket.io');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB, 10) || 4096;
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7;

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠  ADMIN_PASSWORD не задан — используется пароль по умолчанию "admin". Обязательно поменяйте его!');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json());

// ---------- Авторизация администратора ----------
const sessions = new Map(); // token -> expiresAt

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function isAdminCookie(cookieHeader) {
  const token = parseCookies(cookieHeader).sid;
  const exp = token && sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function requireAdmin(req, res, next) {
  if (isAdminCookie(req.headers.cookie)) return next();
  res.status(401).json({ error: 'Требуется вход администратора' });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const loginAttempts = new Map(); // ip -> {count, until}
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const a = loginAttempts.get(ip) || { count: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: 'Слишком много попыток, подождите минуту' });
  if (!safeEqual(req.body?.password || '', ADMIN_PASSWORD)) {
    a.count += 1;
    if (a.count >= 5) { a.count = 0; a.until = Date.now() + 60_000; }
    loginAttempts.set(ip, a);
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  sessions.delete(parseCookies(req.headers.cookie).sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ admin: isAdminCookie(req.headers.cookie) }));

app.get('/api/config', (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS,
    });
  }
  res.json({ iceServers });
});

// ---------- Комнаты ----------
app.get('/api/rooms/:id/public', (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Встреча не найдена' });
  res.json({ id: room.id, name: room.name, allowCamera: room.settings.allowCamera, allowMic: room.settings.allowMic });
});

app.get('/api/rooms', requireAdmin, (req, res) => {
  res.json(db.listRooms().map((r) => ({ ...r, live: liveSummary(r.id) })));
});

app.post('/api/rooms', requireAdmin, (req, res) => {
  const room = db.createRoom(String(req.body?.name || '').trim().slice(0, 100));
  res.json(room);
});

app.get('/api/rooms/:id', requireAdmin, (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Не найдено' });
  res.json(room);
});

app.put('/api/rooms/:id', requireAdmin, (req, res) => {
  const room = db.updateRoom(req.params.id, req.body || {});
  if (!room) return res.status(404).json({ error: 'Не найдено' });
  onRoomUpdated(room.id);
  res.json(room);
});

app.delete('/api/rooms/:id', requireAdmin, (req, res) => {
  endMeeting(req.params.id, 'Встреча завершена организатором');
  db.deleteRoom(req.params.id);
  res.json({ ok: true });
});

// ---------- Записи ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: db.UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.webm').toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(video|audio)\//.test(file.mimetype)),
});

app.get('/api/recordings', requireAdmin, (req, res) => res.json(db.listRecordings()));

app.post('/api/recordings', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нужен видеофайл' });
  const rec = db.addRecording({
    id: crypto.randomBytes(8).toString('hex'),
    title: String(req.body.title || req.file.originalname).trim().slice(0, 120) || 'Запись',
    file: req.file.filename,
    mime: req.file.mimetype,
    size: req.file.size,
    duration: Number(req.body.duration) > 0 && isFinite(Number(req.body.duration)) ? Number(req.body.duration) : null,
    createdAt: new Date().toISOString(),
  });
  optimizeRecording(rec);
  res.json(rec);
});

// Если на сервере установлен ffmpeg — пересобираем файл (без перекодирования),
// чтобы в нём были индекс и длительность: тогда перемотка для опоздавших работает мгновенно.
function optimizeRecording(rec) {
  const src = path.join(db.UPLOAD_DIR, rec.file);
  const ext = path.extname(rec.file);
  const tmp = src + '.tmp' + ext;
  const args = ['-y', '-v', 'error', '-i', src, '-c', 'copy'];
  if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') args.push('-movflags', '+faststart');
  args.push(tmp);
  execFile('ffmpeg', args, { timeout: 30 * 60_000 }, (err) => {
    if (err) { fs.rm(tmp, () => {}); return; }
    fs.rename(tmp, src, () => {
      execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], (e2, out) => {
        const d = parseFloat(out);
        let size = 0;
        try { size = fs.statSync(src).size; } catch (e) {}
        db.updateRecording(rec.id, { duration: !e2 && d > 0 ? d : undefined, size });
      });
    });
  });
}

app.patch('/api/recordings/:id', requireAdmin, (req, res) => {
  const rec = db.updateRecording(req.params.id, req.body || {});
  if (!rec) return res.status(404).json({ error: 'Не найдено' });
  res.json(rec);
});

app.delete('/api/recordings/:id', requireAdmin, (req, res) => {
  for (const room of db.listRooms()) {
    const live = lives.get(room.id);
    if (live && live.play.recordingId === req.params.id) stopPlayback(room.id);
  }
  db.deleteRecording(req.params.id);
  res.json({ ok: true });
});

// ---------- Кастомные эмодзи ----------
const STD_REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉', '🔥', '🙏'];
const emojiUpload = multer({
  storage: upload.storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|gif|webp|jpeg)$/.test(file.mimetype)),
});

app.get('/api/emojis', (req, res) => {
  res.json({ standard: STD_REACTIONS, custom: db.listEmojis().map((e) => ({ id: e.id, name: e.name, url: `/media/${e.file}` })) });
});

app.post('/api/emojis', requireAdmin, emojiUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нужна картинка PNG, GIF, WebP или JPG до 2 МБ' });
  const name = String(req.body.name || '').toLowerCase().replace(/[^a-z0-9_а-яё-]/g, '').slice(0, 32);
  if (!name || db.listEmojis().some((e) => e.name === name)) {
    fs.rm(req.file.path, () => {});
    return res.status(400).json({ error: name ? 'Эмодзи с таким именем уже есть' : 'Укажите имя (буквы, цифры, _)' });
  }
  const e = db.addEmoji({ id: crypto.randomBytes(6).toString('hex'), name, file: req.file.filename });
  io.emit('emojis-updated');
  res.json(e);
});

app.delete('/api/emojis/:id', requireAdmin, (req, res) => {
  db.deleteEmoji(req.params.id);
  io.emit('emojis-updated');
  res.json({ ok: true });
});

app.use('/media', express.static(db.UPLOAD_DIR, { maxAge: '1h', index: false }));

// ---------- Страницы ----------
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { index: false }));
app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));
app.get('/r/:id', (req, res) => res.sendFile(path.join(pub, 'room.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin', isAdminCookie(req.headers.cookie) ? 'index.html' : 'login.html')));
app.get('/admin/room/:id', (req, res) => {
  if (!isAdminCookie(req.headers.cookie)) return res.redirect('/admin');
  res.sendFile(path.join(pub, 'admin', 'room.html'));
});

// ---------- Живое состояние комнат ----------
// lives: roomId -> { participants: Map, waiting: Map, chat: [], play: {...}, timers }
const lives = new Map();

function getLive(roomId) {
  let live = lives.get(roomId);
  if (!live) {
    live = {
      participants: new Map(),
      waiting: new Map(),
      chat: [],
      play: { status: 'idle', recordingId: null, position: 0, startedAt: 0 },
      autoStartedFor: null,
      firstGuestTimer: null,
      endTimer: null,
    };
    lives.set(roomId, live);
  }
  return live;
}

function liveSummary(roomId) {
  const live = lives.get(roomId);
  if (!live) return { participants: 0, waiting: 0, playback: 'idle' };
  return {
    participants: [...live.participants.values()].filter((p) => !p.hidden).length,
    waiting: live.waiting.size,
    playback: live.play.status,
  };
}

function effectivePerms(room, p) {
  if (p.role === 'host') return { allowCam: true, allowMic: true };
  return {
    allowCam: p.camOverride ?? room.settings.allowCamera,
    allowMic: p.micOverride ?? room.settings.allowMic,
  };
}

function publicParticipant(room, p) {
  return {
    id: p.id, name: p.name, role: p.role, hidden: !!p.hidden,
    cam: p.cam, mic: p.mic, screen: p.screen, hand: p.hand,
    camOverride: p.camOverride, micOverride: p.micOverride,
    ...effectivePerms(room, p),
  };
}

function playbackPosition(play) {
  if (play.status === 'playing') return play.position + (Date.now() - play.startedAt) / 1000;
  return play.position;
}

function playbackPayload(roomId) {
  const room = db.getRoom(roomId);
  const play = getLive(roomId).play;
  const rec = play.recordingId ? db.getRecording(play.recordingId) : null;
  return {
    status: rec ? play.status : 'idle',
    recordingId: rec?.id || null,
    url: rec ? `/media/${rec.file}` : null,
    title: rec?.title || null,
    duration: rec?.duration || null,
    position: rec ? playbackPosition(play) : 0,
    display: room?.playback.display || 'camera',
  };
}

function guestRoomInfo(room) {
  const pb = room.playback;
  const play = getLive(room.id).play;
  const active = play.status === 'playing' || play.status === 'paused';
  return {
    id: room.id,
    name: room.name,
    allowChat: room.settings.allowChat,
    presenter: {
      name: pb.presenterName,
      display: pb.display,
      // «виртуальный ведущий» отображается как обычный участник
      visible: pb.display === 'camera' && !!pb.recordingId && (active || pb.showPresenterBeforeStart),
    },
  };
}

function adminState(roomId) {
  const room = db.getRoom(roomId);
  const live = getLive(roomId);
  return {
    room,
    waiting: [...live.waiting.values()].map((w) => ({ id: w.id, name: w.name, at: w.at })),
    participants: [...live.participants.values()].map((p) => publicParticipant(room, p)),
    playback: playbackPayload(roomId),
    chat: live.chat,
  };
}

function notifyAdmins(roomId) {
  if (!db.getRoom(roomId)) return;
  io.to(`adm:${roomId}`).emit('admin:state', adminState(roomId));
}

function broadcastPlayback(roomId) {
  const payload = playbackPayload(roomId);
  io.to(roomId).emit('playback', payload);
  io.to(roomId).emit('room-updated', guestRoomInfo(db.getRoom(roomId)));
  notifyAdmins(roomId);
}

function scheduleEnd(roomId) {
  const live = getLive(roomId);
  clearTimeout(live.endTimer);
  const rec = db.getRecording(live.play.recordingId);
  if (live.play.status !== 'playing' || !rec?.duration) return;
  const left = rec.duration - playbackPosition(live.play);
  live.endTimer = setTimeout(() => finishPlayback(roomId), Math.max(0, left * 1000) + 500);
}

function startPlayback(roomId, recordingId, { startedAt = Date.now(), position = 0 } = {}) {
  const room = db.getRoom(roomId);
  const recId = recordingId || room?.playback.recordingId;
  if (!room || !db.getRecording(recId)) return false;
  const live = getLive(roomId);
  clearTimeout(live.firstGuestTimer);
  live.play = { status: 'playing', recordingId: recId, position, startedAt };
  scheduleEnd(roomId);
  broadcastPlayback(roomId);
  return true;
}

function pausePlayback(roomId) {
  const live = getLive(roomId);
  if (live.play.status !== 'playing') return;
  live.play.position = playbackPosition(live.play);
  live.play.status = 'paused';
  clearTimeout(live.endTimer);
  broadcastPlayback(roomId);
}

function resumePlayback(roomId) {
  const live = getLive(roomId);
  if (live.play.status !== 'paused') return;
  live.play.status = 'playing';
  live.play.startedAt = Date.now();
  scheduleEnd(roomId);
  broadcastPlayback(roomId);
}

function seekPlayback(roomId, position) {
  const live = getLive(roomId);
  if (!['playing', 'paused'].includes(live.play.status)) return;
  live.play.position = Math.max(0, Number(position) || 0);
  live.play.startedAt = Date.now();
  scheduleEnd(roomId);
  broadcastPlayback(roomId);
}

function stopPlayback(roomId) {
  const live = getLive(roomId);
  clearTimeout(live.endTimer);
  clearTimeout(live.firstGuestTimer);
  live.play = { status: 'idle', recordingId: null, position: 0, startedAt: 0 };
  broadcastPlayback(roomId);
}

function finishPlayback(roomId) {
  const live = getLive(roomId);
  if (live.play.status !== 'playing') return;
  clearTimeout(live.endTimer);
  live.play.position = playbackPosition(live.play);
  live.play.status = 'ended';
  broadcastPlayback(roomId);
  const room = db.getRoom(roomId);
  if (room?.playback.endAction === 'endMeeting') {
    setTimeout(() => endMeeting(roomId, 'Встреча завершена'), 1500);
  }
}

function endMeeting(roomId, reason) {
  const live = lives.get(roomId);
  if (!live) return;
  for (const id of [...live.participants.keys(), ...live.waiting.keys()]) {
    const s = io.sockets.sockets.get(id);
    const p = live.participants.get(id);
    if (p?.role === 'host') continue;
    s?.emit('meeting-ended', { reason });
    s?.leave(roomId);
    if (s) s.data.roomId = null;
    live.participants.delete(id);
    live.waiting.delete(id);
    io.to(roomId).emit('peer-left', { id });
  }
  live.chat = [];
  notifyAdmins(roomId);
}

function onRoomUpdated(roomId) {
  const room = db.getRoom(roomId);
  if (!room) return;
  const live = getLive(roomId);
  // если отключили зал ожидания — впускаем всех, кто ждёт
  if (!room.settings.waitingRoom) {
    for (const id of [...live.waiting.keys()]) admitWaiting(roomId, id);
  }
  if (room.settings.locked) {
    for (const id of [...live.waiting.keys()]) denyWaiting(roomId, id);
  }
  for (const p of live.participants.values()) {
    io.to(p.id).emit('perm', effectivePerms(room, p));
    enforcePerms(room, p);
  }
  io.to(roomId).emit('room-updated', guestRoomInfo(room));
  io.to(roomId).emit('participants', [...live.participants.values()].map((p) => publicParticipant(room, p)));
  if (room.playback.startMode === 'scheduled') live.autoStartedFor = null;
  notifyAdmins(roomId);
}

function enforcePerms(room, p) {
  const perms = effectivePerms(room, p);
  if (!perms.allowCam) { p.cam = false; p.screen = false; }
  if (!perms.allowMic) p.mic = false;
}

// Автоматический запуск записи по расписанию
setInterval(() => {
  const now = Date.now();
  for (const room of db.listRooms()) {
    const pb = room.playback;
    if (pb.startMode !== 'scheduled' || !pb.startAt || !pb.recordingId) continue;
    const at = Date.parse(pb.startAt);
    const live = getLive(room.id);
    if (now < at || live.autoStartedFor === pb.startAt) continue;
    live.autoStartedFor = pb.startAt;
    if (live.play.status === 'playing' || live.play.status === 'paused') continue;
    const rec = db.getRecording(pb.recordingId);
    // Если сервер был перезапущен после времени старта — продолжаем «с того места, где должны быть»
    const maxLate = rec?.duration || 6 * 3600;
    if ((now - at) / 1000 >= maxLate) continue;
    startPlayback(room.id, pb.recordingId, { startedAt: at });
  }
}, 1000);

function maybeFirstGuestStart(roomId) {
  const room = db.getRoom(roomId);
  const live = getLive(roomId);
  if (room.playback.startMode !== 'firstGuest' || !room.playback.recordingId) return;
  if (live.play.status !== 'idle' || live.firstGuestTimer) return;
  live.firstGuestTimer = setTimeout(() => {
    live.firstGuestTimer = null;
    if (live.play.status === 'idle' && [...live.participants.values()].some((p) => p.role === 'guest')) {
      startPlayback(roomId);
    }
  }, room.playback.delaySec * 1000);
}

// ---------- Сокеты ----------
function admit(socket, roomId, { name, role, hidden }) {
  const room = db.getRoom(roomId);
  const live = getLive(roomId);
  live.waiting.delete(socket.id);
  const p = {
    id: socket.id, name, role, hidden: !!hidden,
    cam: false, mic: false, screen: false, hand: false,
    camOverride: null, micOverride: null,
  };
  live.participants.set(socket.id, p);
  socket.join(roomId);
  socket.data.roomId = roomId;
  socket.emit('joined', {
    self: publicParticipant(room, p),
    peers: [...live.participants.values()].filter((x) => x.id !== socket.id).map((x) => publicParticipant(room, x)),
    room: guestRoomInfo(room),
    playback: playbackPayload(roomId),
    chat: live.chat.slice(-100),
  });
  socket.to(roomId).emit('peer-joined', publicParticipant(room, p));
  if (role === 'guest') maybeFirstGuestStart(roomId);
  notifyAdmins(roomId);
}

function admitWaiting(roomId, id) {
  const live = getLive(roomId);
  const w = live.waiting.get(id);
  const s = io.sockets.sockets.get(id);
  if (!w || !s) { live.waiting.delete(id); return; }
  admit(s, roomId, { name: w.name, role: 'guest' });
}

function denyWaiting(roomId, id) {
  const live = getLive(roomId);
  if (!live.waiting.delete(id)) return;
  const s = io.sockets.sockets.get(id);
  if (s) { s.emit('denied'); s.data.roomId = null; }
}

function removeParticipant(roomId, id) {
  const live = lives.get(roomId);
  if (!live) return;
  live.waiting.delete(id);
  if (live.participants.delete(id)) io.to(roomId).emit('peer-left', { id });
  notifyAdmins(roomId);
}

io.on('connection', (socket) => {
  socket.data.admin = isAdminCookie(socket.handshake.headers.cookie);

  const current = () => {
    const roomId = socket.data.roomId;
    const room = roomId && db.getRoom(roomId);
    const p = room && lives.get(roomId)?.participants.get(socket.id);
    return p ? { room, p, live: lives.get(roomId) } : null;
  };

  socket.on('time', (cb) => typeof cb === 'function' && cb(Date.now()));

  socket.on('join', ({ roomId, name, asHost, hidden } = {}, cb = () => {}) => {
    const room = db.getRoom(roomId);
    if (!room) return cb({ error: 'Встреча не найдена' });
    if (socket.data.roomId) return cb({ error: 'Вы уже в комнате' });
    name = String(name || '').trim().slice(0, 40);
    if (!name) return cb({ error: 'Введите имя' });
    if (asHost) {
      if (!socket.data.admin) return cb({ error: 'Нет прав ведущего' });
      admit(socket, roomId, { name, role: 'host', hidden });
      return cb({ status: 'joined' });
    }
    if (room.settings.locked) return cb({ error: 'Встреча закрыта организатором' });
    if (room.settings.waitingRoom) {
      const live = getLive(roomId);
      live.waiting.set(socket.id, { id: socket.id, name, at: Date.now() });
      socket.data.roomId = roomId;
      cb({ status: 'waiting' });
      notifyAdmins(roomId);
      return;
    }
    admit(socket, roomId, { name, role: 'guest' });
    cb({ status: 'joined' });
  });

  socket.on('signal', ({ to, data } = {}) => {
    const c = current();
    if (!c || !c.live.participants.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('media', ({ cam, mic, screen } = {}) => {
    const c = current();
    if (!c) return;
    const perms = effectivePerms(c.room, c.p);
    c.p.cam = !!cam && perms.allowCam;
    c.p.mic = !!mic && perms.allowMic;
    c.p.screen = !!screen && c.p.role === 'host';
    io.to(c.room.id).emit('peer-updated', publicParticipant(c.room, c.p));
    notifyAdmins(c.room.id);
  });

  socket.on('hand', (up) => {
    const c = current();
    if (!c) return;
    c.p.hand = !!up;
    io.to(c.room.id).emit('peer-updated', publicParticipant(c.room, c.p));
    notifyAdmins(c.room.id);
  });

  socket.on('chat', (text) => {
    const c = current();
    if (!c) return;
    if (!c.room.settings.allowChat && c.p.role !== 'host') return;
    text = String(text || '').trim().slice(0, 1000);
    if (!text) return;
    const msg = { id: crypto.randomBytes(6).toString('hex'), name: c.p.name, text, at: Date.now(), host: c.p.role === 'host' };
    c.live.chat.push(msg);
    if (c.live.chat.length > 300) c.live.chat.shift();
    io.to(c.room.id).emit('chat', msg);
    notifyAdmins(c.room.id);
  });

  socket.on('reaction', (emoji) => {
    const c = current();
    if (!c || c.p.hidden) return;
    const now = Date.now();
    if (now - (socket.data.lastReaction || 0) < 400) return; // защита от спама
    socket.data.lastReaction = now;
    emoji = String(emoji || '');
    const ok = STD_REACTIONS.includes(emoji) || (emoji.startsWith('custom:') && db.getEmoji(emoji.slice(7)));
    if (!ok) return;
    io.to(c.room.id).emit('reaction', { from: socket.id, emoji });
  });

  socket.on('leave', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.leave(roomId);
    socket.data.roomId = null;
    removeParticipant(roomId, socket.id);
  });

  socket.on('disconnect', () => {
    if (socket.data.roomId) removeParticipant(socket.data.roomId, socket.id);
  });

  // ----- Управление (только администратор) -----
  const adminOn = (event, handler) => socket.on(event, (args = {}, cb) => {
    if (!socket.data.admin) return typeof cb === 'function' && cb({ error: 'Нет доступа' });
    const room = db.getRoom(args.roomId);
    if (!room) return typeof cb === 'function' && cb({ error: 'Комната не найдена' });
    handler(room, args);
    if (typeof cb === 'function') cb({ ok: true });
  });

  adminOn('admin:watch', (room) => {
    socket.join(`adm:${room.id}`);
    socket.emit('admin:state', adminState(room.id));
  });

  adminOn('admin:admit', (room, { id }) => admitWaiting(room.id, id));
  adminOn('admin:admit-all', (room) => {
    for (const id of [...getLive(room.id).waiting.keys()]) admitWaiting(room.id, id);
  });
  adminOn('admin:deny', (room, { id }) => { denyWaiting(room.id, id); notifyAdmins(room.id); });

  adminOn('admin:kick', (room, { id }) => {
    const live = getLive(room.id);
    const p = live.participants.get(id);
    if (!p || p.role === 'host') return;
    const s = io.sockets.sockets.get(id);
    if (s) { s.emit('kicked'); s.leave(room.id); s.data.roomId = null; }
    removeParticipant(room.id, id);
  });

  adminOn('admin:perm', (room, { id, allowCam, allowMic }) => {
    const live = getLive(room.id);
    const p = live.participants.get(id);
    if (!p || p.role === 'host') return;
    const norm = (v) => (v === null ? null : !!v);
    if (allowCam !== undefined) p.camOverride = norm(allowCam);
    if (allowMic !== undefined) p.micOverride = norm(allowMic);
    enforcePerms(room, p);
    io.to(id).emit('perm', effectivePerms(room, p));
    io.to(room.id).emit('peer-updated', publicParticipant(room, p));
    notifyAdmins(room.id);
  });

  adminOn('admin:mute-all', (room) => {
    for (const p of getLive(room.id).participants.values()) {
      if (p.role === 'host' || !p.mic) continue;
      p.mic = false;
      io.to(p.id).emit('force-mute');
      io.to(room.id).emit('peer-updated', publicParticipant(room, p));
    }
    notifyAdmins(room.id);
  });

  adminOn('admin:lower-hands', (room) => {
    for (const p of getLive(room.id).participants.values()) {
      if (!p.hand) continue;
      p.hand = false;
      io.to(room.id).emit('peer-updated', publicParticipant(room, p));
    }
    io.to(room.id).emit('lower-hand');
    notifyAdmins(room.id);
  });

  adminOn('admin:settings', (room, { settings }) => {
    db.updateRoom(room.id, { settings });
    onRoomUpdated(room.id);
  });

  adminOn('admin:playback', (room, { action, recordingId, position }) => {
    if (action === 'start') startPlayback(room.id, recordingId, { position: Math.max(0, Number(position) || 0) });
    else if (action === 'pause') pausePlayback(room.id);
    else if (action === 'resume') resumePlayback(room.id);
    else if (action === 'seek') seekPlayback(room.id, position);
    else if (action === 'stop') stopPlayback(room.id);
  });

  adminOn('admin:chat', (room, { text, as }) => {
    text = String(text || '').trim().slice(0, 1000);
    if (!text) return;
    const name = String(as || '').trim().slice(0, 60) || 'Организатор';
    const live = getLive(room.id);
    const msg = { id: crypto.randomBytes(6).toString('hex'), name, text, at: Date.now(), host: true };
    live.chat.push(msg);
    if (live.chat.length > 300) live.chat.shift();
    io.to(room.id).emit('chat', msg);
    notifyAdmins(room.id);
  });

  // реакция от имени «виртуального ведущего» (над плиткой записи)
  adminOn('admin:reaction', (room, { emoji }) => {
    emoji = String(emoji || '');
    if (!STD_REACTIONS.includes(emoji) && !(emoji.startsWith('custom:') && db.getEmoji(emoji.slice(7)))) return;
    io.to(room.id).emit('reaction', { from: '__presenter', emoji });
  });

  adminOn('admin:end', (room) => endMeeting(room.id, 'Встреча завершена организатором'));
});

server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  console.log(`Админ-панель:   http://localhost:${PORT}/admin`);
});
