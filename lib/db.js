// Простое хранилище в JSON-файле: комнаты и записи.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let data = { rooms: [], recordings: [], emojis: [] };
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
  allowMic: false,     // участникам разрешено включать микрофон
  allowChat: true,
  locked: false,       // новые участники не могут даже встать в очередь
};

const DEFAULT_PLAYBACK = {
  recordingId: null,
  display: 'camera',          // 'camera' — как видео ведущего, 'presentation' — как демонстрация экрана
  presenterName: 'Ведущий',
  startMode: 'manual',        // 'manual' | 'scheduled' | 'firstGuest'
  startAt: null,              // ISO-время для режима scheduled
  delaySec: 15,               // задержка после входа первого участника для режима firstGuest
  endAction: 'stay',          // 'stay' — остаться в комнате, 'endMeeting' — завершить встречу для всех
  showPresenterBeforeStart: true,
};

function normalizeRoom(room) {
  room.settings = Object.assign({}, DEFAULT_SETTINGS, room.settings);
  room.playback = Object.assign({}, DEFAULT_PLAYBACK, room.playback);
  return room;
}
data.rooms.forEach(normalizeRoom);

module.exports = {
  UPLOAD_DIR,
  listRooms: () => data.rooms,
  getRoom: (id) => data.rooms.find((r) => r.id === id) || null,
  createRoom(name) {
    let id;
    do id = roomCode(); while (data.rooms.some((r) => r.id === id));
    const room = normalizeRoom({ id, name: name || 'Встреча', createdAt: new Date().toISOString() });
    data.rooms.push(room);
    save();
    return room;
  },
  updateRoom(id, patch) {
    const room = this.getRoom(id);
    if (!room) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) room.name = patch.name.trim().slice(0, 100);
    if (patch.settings) {
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (k in patch.settings) room.settings[k] = !!patch.settings[k];
      }
    }
    if (patch.playback) {
      const p = patch.playback;
      const pb = room.playback;
      if ('recordingId' in p) pb.recordingId = p.recordingId || null;
      if (['camera', 'presentation'].includes(p.display)) pb.display = p.display;
      if (typeof p.presenterName === 'string') pb.presenterName = p.presenterName.trim().slice(0, 60) || 'Ведущий';
      if (['manual', 'scheduled', 'firstGuest'].includes(p.startMode)) pb.startMode = p.startMode;
      if ('startAt' in p) pb.startAt = p.startAt && !isNaN(Date.parse(p.startAt)) ? new Date(p.startAt).toISOString() : null;
      if ('delaySec' in p) pb.delaySec = Math.max(0, Math.min(3600, parseInt(p.delaySec, 10) || 0));
      if (['stay', 'endMeeting'].includes(p.endAction)) pb.endAction = p.endAction;
      if ('showPresenterBeforeStart' in p) pb.showPresenterBeforeStart = !!p.showPresenterBeforeStart;
    }
    save();
    return room;
  },
  deleteRoom(id) {
    data.rooms = data.rooms.filter((r) => r.id !== id);
    save();
  },

  listEmojis: () => data.emojis,
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

  listRecordings: () => data.recordings,
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
    save();
    return rec;
  },
  deleteRecording(id) {
    const rec = this.getRecording(id);
    if (!rec) return;
    data.recordings = data.recordings.filter((r) => r.id !== id);
    data.rooms.forEach((r) => { if (r.playback.recordingId === id) r.playback.recordingId = null; });
    save();
    fs.rm(path.join(UPLOAD_DIR, rec.file), () => {});
  },
};
