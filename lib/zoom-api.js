// Zoom API: создание и изменение встреч в аккаунте Zoom админа.
// Нужно приложение Server-to-Server OAuth (marketplace.zoom.us → Develop → Build App) —
// бесплатно, работает и с бесплатным аккаунтом Zoom.
const tokens = new Map(); // clientId -> { token, exp }
// адреса можно подменить для проверки (имитация Zoom API в тестах)
const OAUTH = process.env.ZOOM_OAUTH_BASE || 'https://zoom.us';
const API = process.env.ZOOM_API_BASE || 'https://api.zoom.us/v2';

class ZoomApiError extends Error {}

async function getToken(cfg) {
  const cached = tokens.get(cfg.clientId);
  if (cached && cached.exp > Date.now() + 60_000 && cached.secret === cfg.clientSecret) return cached.token;
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  let r;
  try {
    r = await fetch(`${OAUTH}/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(cfg.accountId)}`, {
      method: 'POST', headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(15_000),
    });
  } catch (e) { throw new ZoomApiError(`нет связи с zoom.us (${e.message})`); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) {
    throw new ZoomApiError(`Zoom не принял ключи: ${body.reason || body.error || r.status}. Проверьте Account ID, Client ID, Client Secret и что приложение активировано (Activate)`);
  }
  tokens.set(cfg.clientId, { token: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000, secret: cfg.clientSecret });
  return body.access_token;
}

async function call(cfg, method, url, body) {
  const token = await getToken(cfg);
  let r;
  try {
    r = await fetch(API + url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) { throw new ZoomApiError(`нет связи с api.zoom.us (${e.message})`); }
  if (r.status === 204) return {};
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const scope = /scope/i.test(data.message || '') ? ' — добавьте приложению права (Scopes) из инструкции' : '';
    const err = new ZoomApiError(`Zoom: ${data.message || r.status}${scope}`);
    err.status = r.status; err.code = data.code;
    throw err;
  }
  return data;
}

// чей календарь: email из настроек, иначе «me», иначе первый пользователь аккаунта
async function hostPath(cfg) {
  if (cfg.hostEmail) return encodeURIComponent(cfg.hostEmail);
  if (cfg._host) return cfg._host;
  try {
    const me = await call(cfg, 'GET', '/users/me');
    cfg._host = encodeURIComponent(me.id);
  } catch (e) {
    if (e.status === 401) throw e;
    const list = await call(cfg, 'GET', '/users?status=active&page_size=1');
    if (!list.users?.length) throw new ZoomApiError('в аккаунте Zoom не найден пользователь — укажите email организатора');
    cfg._host = encodeURIComponent(list.users[0].id);
  }
  return cfg._host;
}

// местное время в часовом поясе tz: { iso: 'YYYY-MM-DDTHH:mm:ss', weekday: 1..7 (1 = воскресенье, как в Zoom) }
function wallTime(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday) + 1;
  return { iso: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`, weekday };
}

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Тело встречи по настройкам показа записи:
//   расписание «один раз» → обычная встреча на дату; с повтором → повторяющаяся;
//   вручную / после первого участника → встреча без фиксированного времени (постоянная ссылка)
function meetingBody({ topic, playback, durationSec, timezone, nextStart }) {
  const tz = validTz(timezone) ? timezone : 'UTC';
  const duration = Math.min(1440, Math.max(30, Math.ceil((durationSec || 3600) / 60) + 5));
  const body = {
    topic: String(topic || 'Вебинар').slice(0, 200),
    duration,
    timezone: tz,
    settings: {
      host_video: true,
      participant_video: false,
      join_before_host: false, // участники ждут, пока программа (организатор) не зайдёт и не начнёт показ
      waiting_room: false,
      mute_upon_entry: true,
      approval_type: 2,
      auto_recording: 'none',
      meeting_authentication: false,
    },
  };
  if (playback.startMode !== 'scheduled' || !playback.startAt) return { ...body, type: 3 };
  // для повторов берём ближайший будущий запуск — Zoom не принимает начало в прошлом
  const startMs = Math.max(Date.parse(playback.startAt), Date.parse(nextStart || '') || 0) || Date.parse(playback.startAt);
  const w = wallTime(startMs, tz);
  body.start_time = w.iso;
  if (playback.repeat === 'none') return { ...body, type: 2 };
  const recurrence = playback.repeat === 'daily' ? { type: 1, repeat_interval: 1 }
    : { type: 2, repeat_interval: 1, weekly_days: playback.repeat === 'weekdays' ? '2,3,4,5,6' : String(w.weekday) };
  // у Zoom число повторов ограничено; сервер раз в сутки сдвигает начало на ближайший запуск,
  // так что повторы не кончаются, а ссылка остаётся прежней
  recurrence.end_times = 50;
  return { ...body, type: 8, recurrence };
}

module.exports = {
  ZoomApiError,
  meetingBody,
  async test(cfg) {
    const host = await hostPath(cfg);
    const u = await call(cfg, 'GET', `/users/${host}`);
    return { email: u.email, name: [u.first_name, u.last_name].filter(Boolean).join(' '), type: u.type };
  },
  async create(cfg, body) {
    const host = await hostPath(cfg);
    return call(cfg, 'POST', `/users/${host}/meetings`, body);
  },
  async update(cfg, meetingId, body) {
    await call(cfg, 'PATCH', `/meetings/${encodeURIComponent(meetingId)}`, body);
    return call(cfg, 'GET', `/meetings/${encodeURIComponent(meetingId)}`);
  },
  async remove(cfg, meetingId) {
    try { await call(cfg, 'DELETE', `/meetings/${encodeURIComponent(meetingId)}`); } catch (e) { if (e.status !== 404) throw e; }
  },
};
