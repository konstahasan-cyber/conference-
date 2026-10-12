// Простое хранилище в JSON-файле: админы, комнаты, записи, эмодзи, настройки по умолчанию.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CACHE_DIR = path.join(DATA_DIR, 'cache');

// Главный администратор задаётся через ADMIN_PASSWORD, остальных он создаёт в админке
const OWNER_ID = 'owner';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

let data = { users: [], rooms: [], recordings: [], emojis: [], defaults: {} };
if (fs.existsSync(DB_FILE)) {
  try {
    data = Object.assign(data, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) {
    console.error('Не удалось прочитать db.json:', e.message);
  }
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function roomCode() {
  const letters = 'abcdefghijkmnopqrstuvwxyz';
  const part = (n) => Array.from({ length: n }, () => letters[crypto.randomInt(letters.length)]).join('');
  return `${part(3)}-${part(4)}-${part(3)}`;
}

const DEFAULT_SETTINGS = {
  waitingRoom: true,   // вход только с разрешения организатора
  allowCamera: true,   // участникам разрешено включать камеру
  allowMic: true,      // участникам разрешено включать микрофон
  allowChat: true,
  allowReactions: true,
  locked: false,       // новые участники не могут даже встать в очередь
};

const DEFAULT_PLAYBACK = {
  recordingId: null,
  display: 'camera',          // 'camera' — как видео ведущего, 'presentation' — как демонстрация экрана
  presenterName: 'Ведущий',
  startMode: 'manual',        // 'manual' | 'scheduled' | 'firstGuest'
  startAt: null,              // ISO-время первого запуска для режима scheduled
  repeat: 'none',             // 'none' | 'daily' | 'weekdays' | 'weekly'
  tzOffset: -180,             // смещение часового пояса админа (минуты, как Date#getTimezoneOffset), для «по будням»
  delaySec: 15,               // задержка после входа первого участника для режима firstGuest
  endAction: 'stay',          // 'stay' — остаться в комнате, 'endMeeting' — завершить встречу для всех
  showPresenterBeforeStart: true,
};

// Перенос данных со старой версии: всё без владельца принадлежит главному админу
for (const list of [data.rooms, data.recordings, data.emojis]) {
  for (const item of list) if (!item.ownerId) item.ownerId = OWNER_ID;
}

function cleanSettings(src, base) {
  const out = { ...base };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (src && k in src) out[k] = !!src[k];
  return out;
}

function cleanPlayback(p, base) {
  const pb = { ...base };
  if (!p) return pb;
  if ('recordingId' in p) pb.recordingId = p.recordingId || null;
  if (['camera', 'presentation'].includes(p.display)) pb.display = p.display;
  if (typeof p.presenterName === 'string') pb.presenterName = p.presenterName.trim().slice(0, 60) || 'Ведущий';
  if (['manual', 'scheduled', 'firstGuest'].includes(p.startMode)) pb.startMode = p.startMode;
  if ('startAt' in p) pb.startAt = p.startAt && !isNaN(Date.parse(p.startAt)) ? new Date(p.startAt).toISOString() : null;
  if (['none', 'daily', 'weekdays', 'weekly'].includes(p.repeat)) pb.repeat = p.repeat;
  if ('tzOffset' in p && Number.isFinite(Number(p.tzOffset))) pb.tzOffset = Math.max(-840, Math.min(840, Number(p.tzOffset)));
  if ('delaySec' in p) pb.delaySec = Math.max(0, Math.min(3600, parseInt(p.delaySec, 10) || 0));
  if (['stay', 'endMeeting'].includes(p.endAction)) pb.endAction = p.endAction;
  if ('showPresenterBeforeStart' in p) pb.showPresenterBeforeStart = !!p.showPresenterBeforeStart;
  return pb;
}

function normalizeRoom(room) {
  room.settings = Object.assign({}, DEFAULT_SETTINGS, room.settings);
  room.playback = Object.assign({}, DEFAULT_PLAYBACK, room.playback);
  return room;
}
data.rooms.forEach(normalizeRoom);

// ---------- Пароли ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}
function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

module.exports = {
  OWNER_ID,
  UPLOAD_DIR,
  CACHE_DIR,
  DEFAULT_SETTINGS,
  DEFAULT_PLAYBACK,

  // ---------- Админы ----------
  listUsers: () => data.users.map(({ hash, salt, ...u }) => u),
  getUser: (id) => data.users.find((u) => u.id === id) || null,
  findUserByLogin: (login) => data.users.find((u) => u.login === String(login).toLowerCase()) || null,
  checkPassword,
  createUser({ login, name, password }) {
    const user = {
      id: crypto.randomBytes(6).toString('hex'),
      login: String(login).toLowerCase(),
      name: String(name || login).trim().slice(0, 60),
      ...hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    data.users.push(user);
    save();
    return user;
  },
  setUserPassword(id, password) {
    const u = this.getUser(id);
    if (!u) return null;
    Object.assign(u, hashPassword(password));
    save();
    return u;
  },
  deleteUser(id) {
    const ownedFiles = [
      ...data.recordings.filter((r) => r.ownerId === id),
      ...data.emojis.filter((e) => e.ownerId === id),
    ].map((x) => x.file);
    data.users = data.users.filter((u) => u.id !== id);
    data.rooms = data.rooms.filter((r) => r.ownerId !== id);
    data.recordings = data.recordings.filter((r) => r.ownerId !== id);
    data.emojis = data.emojis.filter((e) => e.ownerId !== id);
    delete data.defaults[id];
    save();
    for (const f of ownedFiles) fs.rm(path.join(UPLOAD_DIR, f), () => {});
  },

  // ---------- Настройки по умолчанию для новых встреч ----------
  getDefaults(ownerId) {
    const d = data.defaults[ownerId] || {};
    return {
      settings: Object.assign({}, DEFAULT_SETTINGS, d.settings),
      playback: Object.assign({}, DEFAULT_PLAYBACK, d.playback),
    };
  },
  setDefaults(ownerId, patch) {
    const cur = this.getDefaults(ownerId);
    data.defaults[ownerId] = {
      settings: cleanSettings(patch.settings, cur.settings),
      playback: cleanPlayback(patch.playback, cur.playback),
    };
    save();
    return this.getDefaults(ownerId);
  },

  // ---------- Комнаты ----------
  listRooms: (ownerId) => (ownerId ? data.rooms.filter((r) => r.ownerId === ownerId) : data.rooms),
  getRoom: (id) => data.rooms.find((r) => r.id === id) || null,
  createRoom(ownerId, name, { settings, playback } = this.getDefaults(ownerId)) {
    let id;
    do id = roomCode(); while (data.rooms.some((r) => r.id === id));
    const room = normalizeRoom({
      id, ownerId, name: name || 'Встреча', createdAt: new Date().toISOString(),
      settings: { ...settings }, playback: { ...playback },
    });
    data.rooms.push(room);
    save();
    return room;
  },
  updateRoom(id, patch) {
    const room = this.getRoom(id);
    if (!room) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) room.name = patch.name.trim().slice(0, 100);
    if (patch.settings) room.settings = cleanSettings(patch.settings, room.settings);
    if (patch.playback) room.playback = cleanPlayback(patch.playback, room.playback);
    save();
    return room;
  },
  deleteRoom(id) {
    data.rooms = data.rooms.filter((r) => r.id !== id);
    save();
  },

  // ---------- Эмодзи (загруженные админами) ----------
  listEmojis: (ownerId) => data.emojis.filter((e) => e.ownerId === ownerId),
  getEmoji: (id) => data.emojis.find((e) => e.id === id) || null,
  addEmoji(emoji) {
    data.emojis.push(emoji);
    save();
    return emoji;
  },
  deleteEmoji(id) {
    const e = this.getEmoji(id);
    if (!e) return;
    data.emojis = data.emojis.filter((x) => x.id !== id);
    save();
    fs.rm(path.join(UPLOAD_DIR, e.file), () => {});
  },

  // ---------- Записи ----------
  listRecordings: (ownerId) => data.recordings.filter((r) => r.ownerId === ownerId),
  getRecording: (id) => data.recordings.find((r) => r.id === id) || null,
  addRecording(rec) {
    data.recordings.push(rec);
    save();
    return rec;
  },
  updateRecording(id, patch) {
    const rec = this.getRecording(id);
    if (!rec) return null;
    if (typeof patch.title === 'string' && patch.title.trim()) rec.title = patch.title.trim().slice(0, 120);
    if (patch.duration > 0) rec.duration = Number(patch.duration);
    if (patch.size > 0) rec.size = Number(patch.size);
    if (typeof patch.file === 'string' && /^[a-f0-9]+\.[a-z0-9]+$/.test(patch.file)) rec.file = patch.file;
    if (typeof patch.mime === 'string') rec.mime = patch.mime;
    save();
    return rec;
  },
  deleteRecording(id) {
    const rec = this.getRecording(id);
    if (!rec) return;
    data.recordings = data.recordings.filter((r) => r.id !== id);
    data.rooms.forEach((r) => { if (r.playback.recordingId === id) r.playback.recordingId = null; });
    for (const d of Object.values(data.defaults)) if (d.playback?.recordingId === id) d.playback.recordingId = null;
    save();
    fs.rm(path.join(UPLOAD_DIR, rec.file), () => {});
  },
};
