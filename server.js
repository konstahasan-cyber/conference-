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
const ADMIN_LOGIN = (process.env.ADMIN_LOGIN || 'admin').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB, 10) || 4096;
const SESSION_TTL = 1000 * 60 * 60 * 24 * 14;
const APPLE_EMOJI_CDN = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64/';

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠  ADMIN_PASSWORD не задан — используется пароль по умолчанию "admin". Обязательно поменяйте его!');
}

const app = express();
// за обратным прокси (Caddy/nginx) берём настоящий IP клиента из X-Forwarded-For
app.set('trust proxy', 'loopback');
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json());

// ---------- Авторизация ----------
// Токен подписан секретом и хранит id админа и срок, поэтому вход переживает перезапуск сервера.
const SECRET_FILE = path.join(path.dirname(db.UPLOAD_DIR), 'secret.key');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

const ownerUser = () => ({ id: db.OWNER_ID, login: ADMIN_LOGIN, name: db.adminName(db.OWNER_ID), role: 'owner' });

// при смене пароля старые входы перестают действовать
const passwordStamp = (userId) => (userId === db.OWNER_ID ? ADMIN_PASSWORD : db.getUser(userId)?.hash || '');

function signToken(userId, exp) {
  const mac = crypto.createHmac('sha256', SECRET).update(`${userId}.${exp}.${passwordStamp(userId)}`).digest('hex');
  return `${userId}.${exp}.${mac}`;
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function userFromCookie(cookieHeader) {
  const token = parseCookies(cookieHeader).sid || '';
  const [userId, exp] = token.split('.');
  if (!userId || !(Number(exp) > Date.now())) return null;
  const expected = signToken(userId, exp);
  if (expected.length !== token.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token))) return null;
  if (userId === db.OWNER_ID) return ownerUser();
  const u = db.getUser(userId);
  return u ? { id: u.id, login: u.login, name: u.name, role: 'admin' } : null;
}

function requireAdmin(req, res, next) {
  req.user = userFromCookie(req.headers.cookie);
  if (req.user) return next();
  res.status(401).json({ error: 'Требуется вход администратора' });
}
function requireOwner(req, res, next) {
  requireAdmin(req, res, () => (req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Только для главного администратора' })));
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
  const login = String(req.body?.login || ADMIN_LOGIN).trim().toLowerCase();
  const password = String(req.body?.password || '');
  let userId = null;
  if (login === ADMIN_LOGIN) {
    if (safeEqual(password, ADMIN_PASSWORD)) userId = db.OWNER_ID;
  } else {
    const u = db.findUserByLogin(login);
    if (u && db.checkPassword(u, password)) userId = u.id;
  }
  if (!userId) {
    a.count += 1;
    if (a.count >= 5) { a.count = 0; a.until = Date.now() + 60_000; }
    loginAttempts.set(ip, a);
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  loginAttempts.delete(ip);
  const exp = Date.now() + SESSION_TTL;
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${signToken(userId, exp)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = userFromCookie(req.headers.cookie);
  res.json({ admin: !!user, user });
});

// своё имя — от него ведутся автовебинары
app.patch('/api/me', requireAdmin, (req, res) => {
  const name = db.setAdminName(req.user.id, req.body?.name);
  if (!name) return res.status(400).json({ error: 'Введите имя' });
  for (const r of db.listRooms(req.user.id)) onRoomUpdated(r.id);
  res.json({ ok: true, name });
});

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

// ---------- Админы (только главный) ----------
const LOGIN_RE = /^[a-z0-9_.-]{3,32}$/;
app.get('/api/users', requireOwner, (req, res) => {
  res.json(db.listUsers().map((u) => ({ ...u, rooms: db.listRooms(u.id).length, recordings: db.listRecordings(u.id).length })));
});
app.post('/api/users', requireOwner, (req, res) => {
  const login = String(req.body?.login || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!LOGIN_RE.test(login)) return res.status(400).json({ error: 'Логин: 3–32 символа, латиница, цифры, _ . -' });
  if (login === ADMIN_LOGIN || db.findUserByLogin(login)) return res.status(400).json({ error: 'Такой логин уже есть' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль — минимум 6 символов' });
  const u = db.createUser({ login, name: req.body?.name || login, password });
  res.json({ id: u.id, login: u.login, name: u.name });
});
app.patch('/api/users/:id', requireOwner, (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Пароль — минимум 6 символов' });
  if (!db.setUserPassword(req.params.id, password)) return res.status(404).json({ error: 'Не найдено' });
  res.json({ ok: true });
});
app.delete('/api/users/:id', requireOwner, (req, res) => {
  for (const r of db.listRooms(req.params.id)) endMeeting(r.id, 'Встреча завершена организатором');
  db.deleteUser(req.params.id);
  res.json({ ok: true });
});

// ---------- Настройки по умолчанию ----------
app.get('/api/defaults', requireAdmin, (req, res) => res.json(db.getDefaults(req.user.id)));
app.put('/api/defaults', requireAdmin, (req, res) => {
  const body = req.body || {};
  if (body.playback?.recordingId && !ownRecording(req.user, body.playback.recordingId)) return res.status(400).json({ error: 'Запись не найдена' });
  res.json(db.setDefaults(req.user.id, body));
});

// ---------- Комнаты ----------
function ownRoom(req, res) {
  const room = db.getRoom(req.params.id);
  if (!room || room.ownerId !== req.user.id) { res.status(404).json({ error: 'Не найдено' }); return null; }
  return room;
}
const ownRecording = (user, id) => { const r = db.getRecording(id); return r && r.ownerId === user.id ? r : null; };

app.get('/api/rooms/:id/public', (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Встреча не найдена' });
  const user = userFromCookie(req.headers.cookie);
  res.json({
    id: room.id, name: room.name,
    allowCamera: room.settings.allowCamera, allowMic: room.settings.allowMic,
    isOwner: !!user && user.id === room.ownerId,
    adminName: user && user.id === room.ownerId ? db.adminName(room.ownerId) : undefined,
  });
});

const roomView = (r) => ({ ...r, live: liveSummary(r.id), nextStart: nextOccurrence(r.playback, Date.now()) });

app.get('/api/rooms', requireAdmin, (req, res) => res.json(db.listRooms(req.user.id).map(roomView)));

app.post('/api/rooms', requireAdmin, (req, res) => {
  const room = db.createRoom(req.user.id, String(req.body?.name || '').trim().slice(0, 100));
  res.json(room);
});

app.post('/api/rooms/:id/duplicate', requireAdmin, (req, res) => {
  const src = ownRoom(req, res);
  if (!src) return;
  const room = db.createRoom(req.user.id, `${src.name} (копия)`.slice(0, 100), { settings: src.settings, playback: src.playback });
  res.json(room);
});

app.get('/api/rooms/:id', requireAdmin, (req, res) => {
  const room = ownRoom(req, res);
  if (room) res.json(roomView(room));
});

app.put('/api/rooms/:id', requireAdmin, (req, res) => {
  if (!ownRoom(req, res)) return;
  const rid = req.body?.playback?.recordingId;
  if (rid && !ownRecording(req.user, rid)) return res.status(400).json({ error: 'Запись не найдена' });
  const room = db.updateRoom(req.params.id, req.body || {});
  onRoomUpdated(room.id);
  res.json(roomView(room));
});

app.delete('/api/rooms/:id', requireAdmin, (req, res) => {
  if (!ownRoom(req, res)) return;
  endMeeting(req.params.id, 'Встреча завершена организатором');
  db.deleteRoom(req.params.id);
  lives.delete(req.params.id);
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

app.get('/api/recordings', requireAdmin, (req, res) => res.json(db.listRecordings(req.user.id)));

app.post('/api/recordings', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нужен видеофайл' });
  const rec = db.addRecording({
    id: crypto.randomBytes(8).toString('hex'),
    ownerId: req.user.id,
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

// Если на сервере есть ffmpeg — приводим запись к MP4 (H.264 + AAC), который играет везде, включая iPhone.
// Подходящие файлы только пересобираются без перекодирования (добавляется индекс для быстрой перемотки),
// остальные (WebM, VP9, Opus из браузерной записи) перекодируются в фоне. Пока идёт обработка, используется исходник.
function optimizeRecording(rec) {
  const ext = path.extname(rec.file).toLowerCase();
  if (ext !== '.webm' && ext !== '.mkv') return transcodeRecording(rec);
  // Шаг 1 (секунды): записи из браузера приходят без индекса — опоздавшим браузер перематывает такой файл,
  // скачивая его с самого начала, и всё это время у них чёрный экран. Пересобираем без перекодирования — индекс появляется.
  const src = path.join(db.UPLOAD_DIR, rec.file);
  const fixedName = crypto.randomBytes(16).toString('hex') + ext;
  const fixed = path.join(db.UPLOAD_DIR, fixedName);
  execFile('ffmpeg', ['-y', '-v', 'error', '-i', src, '-c', 'copy', fixed], { timeout: 30 * 60_000 }, (err) => {
    const cur = db.getRecording(rec.id);
    if (err || !cur) { fs.rm(fixed, () => {}); if (cur) transcodeRecording(cur); return; }
    db.updateRecording(rec.id, { file: fixedName });
    setTimeout(() => fs.rm(src, () => {}), 6 * 3600_000).unref();
    // Шаг 2 (долго, в фоне): перекодирование в MP4, который играет везде
    transcodeRecording(db.getRecording(rec.id));
  });
}

function transcodeRecording(rec) {
  const src = path.join(db.UPLOAD_DIR, rec.file);
  execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=bit_rate', '-of', 'json', src], (perr, out) => {
    if (perr) return;
    let info;
    try { info = JSON.parse(out); } catch (e) { return; }
    const v = (info.streams || []).find((x) => x.codec_type === 'video');
    const a = (info.streams || []).find((x) => x.codec_type === 'audio');
    const bitrate = Number(info.format?.bit_rate) || 0;
    // слишком тяжёлые файлы (например, видео с телефона 4K) тоже пережимаем — иначе у людей со слабым интернетом будет тормозить
    const light = !v || (Math.min(v.width || 0, v.height || 0) <= 1080 && (!bitrate || bitrate <= 4_000_000));
    const compatible = (!v || v.codec_name === 'h264') && (!a || a.codec_name === 'aac' || a.codec_name === 'mp3') && light;
    const outName = crypto.randomBytes(16).toString('hex') + '.mp4';
    const dst = path.join(db.UPLOAD_DIR, outName);
    const args = ['-y', '-v', 'error', '-i', src];
    if (compatible) args.push('-c', 'copy');
    else args.push('-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-c:v', 'libx264', '-preset', 'superfast', '-crf', '24',
      '-maxrate', '1800k', '-bufsize', '3600k', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k');
    args.push('-movflags', '+faststart', dst);
    // перекодирование — с низким приоритетом, чтобы не мешать встречам
    const [cmd, cmdArgs] = compatible ? ['ffmpeg', args] : ['nice', ['-n', '15', 'ffmpeg', ...args]];
    execFile(cmd, cmdArgs, { timeout: 6 * 3600_000 }, (err) => {
      if (err || !db.getRecording(rec.id)) { fs.rm(dst, () => {}); return; }
      execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dst], (e2, dout) => {
        const d = parseFloat(dout);
        let size = 0;
        try { size = fs.statSync(dst).size; } catch (e) {}
        if (compatible || v?.codec_name === 'h264') {
          db.updateRecording(rec.id, { file: outName, mime: 'video/mp4', duration: !e2 && d > 0 ? d : undefined, size });
          // исходник удаляем позже (запасным он не нужен — H.264 играет везде): его ещё могут досматривать участники идущей встречи
          setTimeout(() => fs.rm(src, () => {}), 6 * 3600_000).unref();
        } else {
          // исходник оставляем запасным вариантом для браузеров без H.264
          db.updateRecording(rec.id, { file: outName, altFile: rec.file, mime: 'video/mp4', duration: !e2 && d > 0 ? d : undefined, size });
        }
      });
    });
  });
}

app.patch('/api/recordings/:id', requireAdmin, (req, res) => {
  if (!ownRecording(req.user, req.params.id)) return res.status(404).json({ error: 'Не найдено' });
  const { title, duration } = req.body || {};
  res.json(db.updateRecording(req.params.id, { title, duration }));
});

// Публичная ссылка на просмотр записи (как на YouTube: без регистрации)
app.post('/api/recordings/:id/share', requireAdmin, (req, res) => {
  const rec = ownRecording(req.user, req.params.id);
  if (!rec) return res.status(404).json({ error: 'Не найдено' });
  const token = rec.shareToken || crypto.randomBytes(9).toString('base64url');
  // у новой ссылки счётчик просмотров начинается заново
  db.updateRecording(rec.id, rec.shareToken ? {} : { shareToken: token, views: 0 });
  res.json({ token, url: `/v/${token}` });
});
app.delete('/api/recordings/:id/share', requireAdmin, (req, res) => {
  const rec = ownRecording(req.user, req.params.id);
  if (!rec) return res.status(404).json({ error: 'Не найдено' });
  db.updateRecording(rec.id, { shareToken: null });
  res.json({ ok: true });
});
app.get('/api/watch/:token', (req, res) => {
  const rec = db.findRecordingByShare(String(req.params.token));
  if (!rec) return res.status(404).json({ error: 'Запись не найдена или доступ к ней закрыт' });
  db.bumpViews(rec.id);
  const t = encodeURIComponent(rec.shareToken);
  res.json({
    title: rec.title, author: db.adminName(rec.ownerId), createdAt: rec.createdAt, duration: rec.duration,
    // видео идёт через ссылку с проверкой доступа: после «Закрыть доступ» оно перестаёт открываться
    url: `/v/${t}/video${path.extname(rec.file)}`,
    altUrl: rec.altFile ? `/v/${t}/alt${path.extname(rec.altFile)}` : null,
  });
});

app.get('/v/:token/:kind(video|alt).:ext', (req, res) => {
  const rec = db.findRecordingByShare(String(req.params.token));
  const file = rec && (req.params.kind === 'alt' ? rec.altFile : rec.file);
  if (!file) return res.sendStatus(404);
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.join(db.UPLOAD_DIR, file));
});

app.delete('/api/recordings/:id', requireAdmin, (req, res) => {
  if (!ownRecording(req.user, req.params.id)) return res.status(404).json({ error: 'Не найдено' });
  for (const room of db.listRooms(req.user.id)) {
    const live = lives.get(room.id);
    if (live && live.play.recordingId === req.params.id) stopPlayback(room.id);
  }
  db.deleteRecording(req.params.id);
  res.json({ ok: true });
});

// ---------- Диагностика ----------
// Браузеры участников сообщают о проблемах (видео не грузится, обрыв соединения, нет доступа к камере).
// Смотреть: video diag (или journalctl -u conference | grep DIAG)
const diagHits = new Map(); // ip -> {n, reset}
app.post('/api/diag', (req, res) => {
  res.sendStatus(204);
  const now = Date.now();
  const h = diagHits.get(req.ip) || { n: 0, reset: now + 60_000 };
  if (now > h.reset) { h.n = 0; h.reset = now + 60_000; }
  if (++h.n > 20) return;
  diagHits.set(req.ip, h);
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const clean = (v, n) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)).replace(/[\r\n]+/g, ' ').slice(0, n);
  console.log(`DIAG room=${clean(b.room, 20)} who=${clean(b.name, 40)} kind=${clean(b.kind, 30)} ${clean(b.detail, 300)} | ${clean(req.headers['user-agent'], 160)}`);
});
setInterval(() => { const now = Date.now(); for (const [k, v] of diagHits) if (now > v.reset) diagHits.delete(k); }, 300_000).unref();

// ---------- Эмодзи ----------
// Нарисованный набор (public/emoji/pack/*.svg) + Apple-эмодзи + загруженные админом картинки
const PACK_DIR = path.join(__dirname, 'public', 'emoji', 'pack');
const PACK = fs.existsSync(PACK_DIR)
  ? fs.readdirSync(PACK_DIR).filter((f) => f.endsWith('.svg')).sort().map((f) => f.slice(0, -4))
  : [];
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣]*$/u;

// значения от клиента: берём только настоящие строки (объект с подменённым toString уронил бы сервер)
const str = (v) => (typeof v === 'string' ? v : '');

function validReaction(room, code) {
  code = str(code);
  if (code.startsWith('pack:')) return PACK.includes(code.slice(5));
  if (code.startsWith('custom:')) return db.getEmoji(code.slice(7))?.ownerId === room.ownerId;
  return code.length <= 16 && EMOJI_RE.test(code);
}

const emojiUpload = multer({
  storage: upload.storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|gif|webp|jpeg)$/.test(file.mimetype)),
});

app.get('/api/emojis', (req, res) => {
  let ownerId = null;
  if (req.query.room) ownerId = db.getRoom(String(req.query.room))?.ownerId || null;
  else ownerId = userFromCookie(req.headers.cookie)?.id || null;
  res.json({
    pack: PACK.map((name) => ({ name, url: `/emoji/pack/${name}.svg` })),
    custom: ownerId ? db.listEmojis(ownerId).map((e) => ({ id: e.id, name: e.name, url: `/media/${e.file}` })) : [],
  });
});

app.post('/api/emojis', requireAdmin, emojiUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нужна картинка PNG, GIF, WebP или JPG до 2 МБ' });
  const name = String(req.body.name || '').toLowerCase().replace(/[^a-z0-9_а-яё-]/g, '').slice(0, 32);
  if (!name || PACK.includes(name) || db.listEmojis(req.user.id).some((e) => e.name === name)) {
    fs.rm(req.file.path, () => {});
    return res.status(400).json({ error: name ? 'Эмодзи с таким именем уже есть' : 'Укажите имя (буквы, цифры, _)' });
  }
  const e = db.addEmoji({ id: crypto.randomBytes(6).toString('hex'), ownerId: req.user.id, name, file: req.file.filename });
  io.emit('emojis-updated');
  res.json(e);
});

app.delete('/api/emojis/:id', requireAdmin, (req, res) => {
  if (db.getEmoji(req.params.id)?.ownerId !== req.user.id) return res.status(404).json({ error: 'Не найдено' });
  db.deleteEmoji(req.params.id);
  io.emit('emojis-updated');
  res.json({ ok: true });
});

// Apple-эмодзи: сервер один раз скачивает картинку и дальше отдаёт её сам
const APPLE_DIR = path.join(db.CACHE_DIR, 'apple');
fs.mkdirSync(APPLE_DIR, { recursive: true });
const appleInflight = new Map();
app.get('/apple-emoji/:code.png', async (req, res) => {
  const code = req.params.code.toLowerCase();
  if (!/^[0-9a-f]{2,6}(-[0-9a-f]{2,6}){0,9}$/.test(code)) return res.sendStatus(404);
  const file = path.join(APPLE_DIR, code + '.png');
  const send = () => res.set('Cache-Control', 'public, max-age=2592000, immutable').sendFile(file);
  if (fs.existsSync(file)) return send();
  try {
    if (!appleInflight.has(code)) {
      appleInflight.set(code, (async () => {
        const r = await fetch(APPLE_EMOJI_CDN + code + '.png', { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(String(r.status));
        const buf = Buffer.from(await r.arrayBuffer());
        fs.writeFileSync(file + '.tmp', buf);
        fs.renameSync(file + '.tmp', file);
      })().finally(() => appleInflight.delete(code)));
    }
    await appleInflight.get(code);
    send();
  } catch (e) {
    res.sendStatus(404);
  }
});

app.use('/media', express.static(db.UPLOAD_DIR, { maxAge: '1h', index: false }));

// ---------- Страницы ----------
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { index: false }));
app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));
app.get('/r/:id', (req, res) => res.sendFile(path.join(pub, 'room.html')));
app.get('/v/:token', (req, res) => res.sendFile(path.join(pub, 'watch.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin', userFromCookie(req.headers.cookie) ? 'index.html' : 'login.html')));
app.get('/admin/room/:id', (req, res) => {
  if (!userFromCookie(req.headers.cookie)) return res.redirect('/admin');
  res.sendFile(path.join(pub, 'admin', 'room.html'));
});

// ---------- Расписание и повторы ----------
const DAY = 24 * 3600 * 1000;
const isWeekend = (t, tzOffset) => { const d = new Date(t - tzOffset * 60000).getUTCDay(); return d === 0 || d === 6; };

// последний запуск, который уже наступил (или null)
function lastOccurrence(pb, now) {
  if (pb.startMode !== 'scheduled' || !pb.startAt) return null;
  const base = Date.parse(pb.startAt);
  if (now < base) return null;
  if (pb.repeat === 'none') return base;
  const step = pb.repeat === 'weekly' ? 7 * DAY : DAY;
  let occ = base + Math.floor((now - base) / step) * step;
  if (pb.repeat === 'weekdays') {
    while (occ >= base && isWeekend(occ, pb.tzOffset)) occ -= DAY;
    if (occ < base) return null;
  }
  return occ;
}

// ближайший будущий запуск (для показа в админке)
function nextOccurrence(pb, now) {
  if (pb.startMode !== 'scheduled' || !pb.startAt) return null;
  const base = Date.parse(pb.startAt);
  if (now < base) return new Date(base).toISOString();
  if (pb.repeat === 'none') return null;
  const step = pb.repeat === 'weekly' ? 7 * DAY : DAY;
  let occ = base + (Math.floor((now - base) / step) + 1) * step;
  if (pb.repeat === 'weekdays') while (isWeekend(occ, pb.tzOffset)) occ += DAY;
  return new Date(occ).toISOString();
}

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
    altUrl: rec?.altFile ? `/media/${rec.altFile}` : null,
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
    allowReactions: room.settings.allowReactions,
    presenter: {
      name: pb.presenterName,
      display: pb.display,
      // «виртуальный ведущий» отображается как обычный участник
      visible: pb.display === 'camera' && (active || (!!pb.recordingId && pb.showPresenterBeforeStart)),
    },
  };
}

function adminState(roomId) {
  const room = db.getRoom(roomId);
  const live = getLive(roomId);
  return {
    room: roomView(room),
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
  const rec = db.getRecording(recId);
  if (!room || !rec || rec.ownerId !== room.ownerId) return false;
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
  for (const [t, r] of live.rejoin || []) if (r.p.role !== 'host') live.rejoin.delete(t);
  notifyAdmins(roomId);
}

const scheduleKey = (pb) => `${pb.startMode}|${pb.startAt}|${pb.repeat}|${pb.recordingId}`;

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
  // изменили расписание — разрешаем запуск по новому времени
  if (live.scheduleKey !== scheduleKey(room.playback)) live.autoStartedFor = null;
  notifyAdmins(roomId);
}

function enforcePerms(room, p) {
  const perms = effectivePerms(room, p);
  if (!perms.allowCam) { p.cam = false; p.screen = false; }
  if (!perms.allowMic) p.mic = false;
}

// Автоматический запуск записи по расписанию (в т.ч. повторяющемуся)
setInterval(() => {
  const now = Date.now();
  for (const room of db.listRooms()) {
    const pb = room.playback;
    const occ = lastOccurrence(pb, now);
    if (occ === null || !pb.recordingId) continue;
    const live = getLive(room.id);
    if (live.autoStartedFor === occ) continue;
    live.autoStartedFor = occ;
    live.scheduleKey = scheduleKey(pb);
    if (live.play.status === 'playing' || live.play.status === 'paused') continue;
    const rec = db.getRecording(pb.recordingId);
    // если сервер был перезапущен после времени старта — продолжаем «с того места, где должны быть»
    const maxLate = rec?.duration || 6 * 3600;
    if ((now - occ) / 1000 >= maxLate) continue;
    if (pb.repeat !== 'none' && live.chat.length) {
      live.chat = [];
      io.to(room.id).emit('chat-cleared');
    }
    startPlayback(room.id, pb.recordingId, { startedAt: occ });
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
// Токен переподключения: если у участника на минуту пропал интернет, он возвращается
// во встречу сам, без зала ожидания и с теми же правами.
const REJOIN_TTL = 3 * 60_000;

function admit(socket, roomId, { name, role, hidden, camOverride = null, micOverride = null }) {
  const room = db.getRoom(roomId);
  const live = getLive(roomId);
  live.waiting.delete(socket.id);
  const p = {
    id: socket.id, name, role, hidden: !!hidden,
    cam: false, mic: false, screen: false, hand: false,
    camOverride, micOverride,
    rejoin: crypto.randomBytes(16).toString('hex'),
  };
  live.rejoin ??= new Map();
  live.rejoin.set(p.rejoin, { p, expires: Infinity });
  live.participants.set(socket.id, p);
  socket.join(roomId);
  socket.data.roomId = roomId;
  socket.emit('joined', {
    self: publicParticipant(room, p),
    peers: [...live.participants.values()].filter((x) => x.id !== socket.id).map((x) => publicParticipant(room, x)),
    room: guestRoomInfo(room),
    playback: playbackPayload(roomId),
    chat: live.chat.slice(-100),
    rejoin: p.rejoin,
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

function removeParticipant(roomId, id, { keepRejoin = false } = {}) {
  const live = lives.get(roomId);
  if (!live) return;
  live.waiting.delete(id);
  const p = live.participants.get(id);
  if (p) {
    live.participants.delete(id);
    if (keepRejoin && live.rejoin?.has(p.rejoin)) live.rejoin.get(p.rejoin).expires = Date.now() + REJOIN_TTL;
    else live.rejoin?.delete(p.rejoin);
    io.to(roomId).emit('peer-left', { id });
  }
  notifyAdmins(roomId);
}

setInterval(() => {
  const now = Date.now();
  for (const live of lives.values()) for (const [t, r] of live.rejoin || []) if (r.expires < now) live.rejoin.delete(t);
}, 60_000).unref();

function pushChat(room, msg) {
  const live = getLive(room.id);
  live.chat.push(msg);
  if (live.chat.length > 300) live.chat.shift();
  io.to(room.id).emit('chat', msg);
  notifyAdmins(room.id);
}

io.on('connection', (socket) => {
  socket.data.user = userFromCookie(socket.handshake.headers.cookie);

  const current = () => {
    const roomId = socket.data.roomId;
    const room = roomId && db.getRoom(roomId);
    const p = room && lives.get(roomId)?.participants.get(socket.id);
    return p ? { room, p, live: lives.get(roomId) } : null;
  };

  socket.on('join', (args, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const { roomId: rawRoom, name: rawName, asHost, hidden, rejoin } = args && typeof args === 'object' ? args : {};
    const room = db.getRoom(str(rawRoom));
    if (!room) return cb({ error: 'Встреча не найдена' });
    if (socket.data.roomId) return cb({ error: 'Вы уже в комнате' });
    // возвращение после обрыва связи — без зала ожидания
    const back = lives.get(room.id)?.rejoin?.get(str(rejoin));
    if (back && back.expires > Date.now()) {
      const live = lives.get(room.id);
      const { id: oldId, name: n, role, hidden: h, camOverride, micOverride } = back.p;
      // права ведущего проверяем ДО того, как трогать чужое подключение
      if (role === 'host' && socket.data.user?.id !== room.ownerId) return cb({ error: 'Нет прав ведущего в этой встрече' });
      live.rejoin.delete(str(rejoin));
      // сервер мог ещё не заметить обрыв старого подключения — убираем его, чтобы не было «двойника»
      if (live.participants.get(oldId) === back.p) {
        const old = io.sockets.sockets.get(oldId);
        if (old) { old.data.roomId = null; old.leave(roomId); old.disconnect(true); }
        removeParticipant(room.id, oldId);
      }
      admit(socket, room.id, { name: n, role, hidden: h, camOverride, micOverride });
      return cb({ status: 'joined' });
    }
    const roomId = room.id;
    const name = str(rawName).trim().slice(0, 40);
    if (!name) return cb({ error: 'Введите имя' });
    if (asHost) {
      if (socket.data.user?.id !== room.ownerId) return cb({ error: 'Нет прав ведущего в этой встрече' });
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

  socket.on('signal', (args) => {
    const { to, data } = args && typeof args === 'object' ? args : {};
    const c = current();
    if (!c || !c.live.participants.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('media', (args) => {
    const { cam, mic, screen } = args && typeof args === 'object' ? args : {};
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
    text = str(text).trim().slice(0, 1000);
    if (!text) return;
    pushChat(c.room, { id: crypto.randomBytes(6).toString('hex'), name: c.p.name, text, at: Date.now(), host: c.p.role === 'host' });
  });

  socket.on('reaction', (emoji) => {
    const c = current();
    if (!c || c.p.hidden) return;
    if (!c.room.settings.allowReactions && c.p.role !== 'host') return;
    const now = Date.now();
    if (now - (socket.data.lastReaction || 0) < 400) return; // защита от спама
    socket.data.lastReaction = now;
    if (!validReaction(c.room, emoji)) return;
    io.to(c.room.id).emit('reaction', { from: socket.id, emoji: str(emoji) });
  });

  socket.on('leave', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.leave(roomId);
    socket.data.roomId = null;
    removeParticipant(roomId, socket.id);
  });

  socket.on('disconnect', () => {
    if (socket.data.roomId) removeParticipant(socket.data.roomId, socket.id, { keepRejoin: true });
  });

  // ----- Управление (только владелец встречи) -----
  const adminOn = (event, handler) => socket.on(event, (args, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!args || typeof args !== 'object') args = {};
    const room = db.getRoom(args.roomId);
    if (!room) return reply({ error: 'Комната не найдена' });
    if (!socket.data.user || socket.data.user.id !== room.ownerId) return reply({ error: 'Нет доступа' });
    handler(room, args);
    reply({ ok: true });
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

  adminOn('admin:cams-off', (room) => {
    for (const p of getLive(room.id).participants.values()) {
      if (p.role === 'host' || !p.cam) continue;
      p.cam = false;
      io.to(p.id).emit('force-cam-off');
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
    if (recordingId && db.getRecording(recordingId)?.ownerId !== room.ownerId) return;
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
    pushChat(room, { id: crypto.randomBytes(6).toString('hex'), name, text, at: Date.now(), host: true });
  });

  // реакция от имени «виртуального ведущего» (над плиткой записи)
  adminOn('admin:reaction', (room, { emoji }) => {
    if (!validReaction(room, emoji)) return;
    io.to(room.id).emit('reaction', { from: '__presenter', emoji: String(emoji) });
  });

  adminOn('admin:end', (room) => endMeeting(room.id, 'Встреча завершена организатором'));
});

process.on('uncaughtException', (err) => console.error('Необработанная ошибка:', err));
process.on('unhandledRejection', (err) => console.error('Необработанная ошибка:', err));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} уже занят — возможно, сервер уже запущен в другом окне.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, process.env.HOST || undefined, () => {
  const url = `http://localhost:${PORT}/admin`;
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  console.log(`Админ-панель:   ${url}`);
  if (process.env.OPEN_BROWSER) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    require('child_process').exec(cmd);
  }
});
