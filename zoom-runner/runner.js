'use strict';
// Zoom-пульт: запускает заранее записанный эфир в OBS (виртуальная камера + звук через VB-CABLE)
// и заходит с ним в Zoom-встречу. Задание берёт с сервера конференций (/api/zoom/poll),
// о своём состоянии сообщает туда же (/api/zoom/report). Работает в сеансе пользователя Windows.
//
// Запуск: node runner.js [путь к конфигу]   (или переменная ZOOM_RUNNER_CONFIG)

const fs = require('node:fs');
const path = require('node:path');
const { ObsClient, MEDIA } = require('./obs');
const platform = require('./platform');
const { parseZoomLink, buildJoinUrl } = require('./zoomlink');

const VERSION = '1.0.0';
const DEFAULT_CONFIG = 'C:\\conference\\zoom-runner.json';
const CONFIG_PATH = process.argv[2] || process.env.ZOOM_RUNNER_CONFIG || DEFAULT_CONFIG;

const DEFAULTS = {
  server: 'http://127.0.0.1:3000',
  tokenFile: 'C:\\conference\\data\\zoom-runner.token',
  obsUrl: 'ws://127.0.0.1:4455',
  obsPassword: '',
  obsExe: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
  zoomExe: null,
  leaveOnEnd: true,
  sceneName: 'Автовебинар',
  inputName: 'Запись',
  joinRetrySec: 60,
};

const POLL_MS = 2000;
const DRIFT_CHECK_MS = 10_000;
const DRIFT_MAX_S = 2;
const LEAVE_GRACE_MS = 5000;
const OBS_LAUNCH_WAIT_MS = 45_000;
const START_RETRY_MS = 10_000;
const IDLE_OBS_PROBE_MS = 10_000;
const LOG_MAX_BYTES = 10 * 1024 * 1024;

const ST = {
  PLAYING: 'OBS_MEDIA_STATE_PLAYING',
  PAUSED: 'OBS_MEDIA_STATE_PAUSED',
  STOPPED: 'OBS_MEDIA_STATE_STOPPED',
  ENDED: 'OBS_MEDIA_STATE_ENDED',
  NONE: 'OBS_MEDIA_STATE_NONE',
  ERROR: 'OBS_MEDIA_STATE_ERROR',
};

// ---------- журнал ----------
const LOG_DIR = path.join(path.dirname(path.resolve(CONFIG_PATH)), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'zoom-runner.log');

function ts(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(msg) {
  const line = `${ts()} ${msg}`;
  try { process.stdout.write(line + '\n'); } catch {}
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch {}
    fs.appendFileSync(LOG_FILE, line + '\r\n');
  } catch {}
}

const lastLogged = new Map();
function logThrottled(key, msg, everyMs = 60_000) {
  const prev = lastLogged.get(key);
  if (prev && prev.msg === msg && Date.now() - prev.at < everyMs) return;
  lastLogged.set(key, { msg, at: Date.now() });
  log(msg);
}

const maskUrl = (u) => String(u).replace(/(pwd=)[^&]+/i, '$1***');
const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => (e && e.message) || String(e);

// ---------- конфиг и токен ----------
let cfg = null;
let cfgMtime = 0;

function loadConfig() {
  let stat;
  try { stat = fs.statSync(CONFIG_PATH); } catch {
    if (!cfg) throw new Error(`не найден файл настроек ${CONFIG_PATH} (образец — config.example.json)`);
    return;
  }
  if (cfg && stat.mtimeMs === cfgMtime) return;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    if (!cfg) throw new Error(`ошибка в файле настроек ${CONFIG_PATH}: ${errText(e)}`);
    logThrottled('cfg', `Ошибка в файле настроек ${CONFIG_PATH}: ${errText(e)} — оставлены прежние настройки`);
    return;
  }
  const next = { ...DEFAULTS, ...raw };
  next.server = String(next.server).replace(/\/+$/, '');
  if (cfg && (cfg.obsUrl !== next.obsUrl || cfg.obsPassword !== next.obsPassword)) {
    obs.close();
  }
  cfg = next;
  cfgMtime = stat.mtimeMs;
  obs.url = cfg.obsUrl;
  obs.password = cfg.obsPassword || '';
  log(`Настройки загружены из ${CONFIG_PATH}: сервер ${cfg.server}, OBS ${cfg.obsUrl}, сцена «${cfg.sceneName}», источник «${cfg.inputName}»`);
}

function readToken() {
  try {
    const t = fs.readFileSync(cfg.tokenFile, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!t) throw new Error('файл пуст');
    return t;
  } catch (e) {
    throw new Error(`не удалось прочитать токен из ${cfg.tokenFile}: ${errText(e)}`);
  }
}

// ---------- состояние ----------
const obs = new ObsClient({ url: DEFAULTS.obsUrl, password: '' });
obs.onDisconnect = (reason) => log(`Соединение с OBS разорвано${reason ? ': ' + reason : ''}`);

const S = {
  state: 'idle',
  message: 'Ожидание задания',
  token: null,
  pollNow: 0,
  pollAt: 0,
  active: null, // { key, file, noJoin, status, needSetup, lastExpected, lastExpectedAt, roomName }
  obs: { connected: false, virtualCam: false, monitorDevice: null },
  obsRunning: false,
  zoom: { running: false, inMeeting: false },
  media: { state: null, cursor: null, duration: null },
  monitorWarn: null,
  lastDriftCheck: 0,
  lastJoinAt: 0,
  joinAttempts: 0,
  joinedByUs: false,
  joinedConfno: null,
  leaveAt: 0,
  failedKey: null,
  startRetryAt: 0,
  obsLaunchedAt: 0,
  lastObsProbe: 0,
  stopping: false,
};

function setState(state, message) {
  if (state === S.state && message === S.message) return;
  S.state = state;
  S.message = message;
  log(`[${state}] ${message}`);
  report().catch(() => {});
}

// ---------- обмен с сервером ----------
async function pollServer() {
  const r = await fetch(`${cfg.server}/api/zoom/poll`, {
    headers: { 'X-Runner-Token': S.token },
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 401) return { unauthorized: true };
  if (!r.ok) throw new Error(`сервер ответил ${r.status}`);
  return r.json();
}

let reportBusy = false;
let reportAgain = false;
async function report() {
  if (!cfg || !S.token) return;
  if (reportBusy) { reportAgain = true; return; }
  reportBusy = true;
  try {
    do {
      reportAgain = false;
      const body = {
        version: VERSION,
        state: S.state,
        message: S.message,
        obs: { connected: obs.connected, virtualCam: !!S.obs.virtualCam, monitorDevice: S.obs.monitorDevice },
        zoom: { running: !!S.zoom.running, inMeeting: !!S.zoom.inMeeting },
        media: S.media,
        job: S.active ? S.active.key : null,
      };
      try {
        const r = await fetch(`${cfg.server}/api/zoom/report`, {
          method: 'POST',
          headers: { 'X-Runner-Token': S.token, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok && r.status !== 204) logThrottled('report', `Сервер не принял отчёт: ${r.status}`);
      } catch (e) {
        logThrottled('report', `Не удалось отправить отчёт на сервер: ${errText(e)}`);
      }
    } while (reportAgain && !S.stopping);
  } finally {
    reportBusy = false;
  }
}

// ---------- OBS ----------
const req = (type, data) => obs.request(type, data);
const mediaAction = (action) => req('TriggerMediaInputAction', { inputName: cfg.inputName, mediaAction: action });
const isAuthError = (e) => /пароль/.test(errText(e));

async function onObsConnected() {
  const i = obs.info || {};
  log(`Подключились к OBS (obs-websocket ${i.obsWebSocketVersion || '?'})`);
  S.obs.connected = true;
}

async function ensureObs() {
  if (obs.connected) return;
  let lastErr;
  try {
    await obs.connect(5000);
    await onObsConnected();
    return;
  } catch (e) {
    lastErr = e;
    if (isAuthError(e)) throw e;
  }
  let running = S.obsRunning;
  try { running = (await platform.status()).obsRunning; } catch {}
  const exe = cfg.obsExe;
  if (!running) {
    if (!exe || !fs.existsSync(exe)) {
      throw new Error(`OBS не запущен, а программа OBS не найдена по пути obsExe (${exe || 'не указан'})`);
    }
    if (Date.now() - S.obsLaunchedAt > 60_000) {
      setState('starting', 'Запускаем OBS…');
      try {
        await platform.launchObs(exe);
      } catch (e) {
        throw new Error(`не удалось запустить OBS (${exe}): ${errText(e)}`);
      }
      S.obsLaunchedAt = Date.now();
    }
  } else {
    setState('starting', 'OBS запущен, ждём подключения к его серверу WebSocket…');
  }
  const deadline = Date.now() + OBS_LAUNCH_WAIT_MS;
  while (Date.now() < deadline && !S.stopping) {
    await sleep(1500);
    try {
      await obs.connect(5000);
      await onObsConnected();
      return;
    } catch (e) {
      lastErr = e;
      if (isAuthError(e)) throw e;
    }
  }
  throw new Error(`OBS не отвечает по WebSocket (${cfg.obsUrl}): ${errText(lastErr)}. Проверьте в OBS: Инструменты → Настройки сервера WebSocket → «Включить сервер», порт и пароль`);
}

async function getMediaStatus() {
  const m = await req('GetMediaInputStatus', { inputName: cfg.inputName });
  S.media = {
    state: m.mediaState || null,
    cursor: m.mediaCursor == null ? null : Math.round(m.mediaCursor / 100) / 10,
    duration: m.mediaDuration == null ? null : Math.round(m.mediaDuration / 100) / 10,
  };
  return m;
}

async function waitMediaState(states, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let m;
  while (Date.now() < deadline) {
    m = await getMediaStatus();
    if (states.includes(m.mediaState)) return m;
    await sleep(250);
  }
  return null;
}

async function seek(seconds) {
  await req('SetMediaInputCursor', { inputName: cfg.inputName, mediaCursor: Math.max(0, Math.round(seconds * 1000)) });
}

// Позиция записи сейчас, по данным последнего опроса сервера
function expectedPosition(job) {
  let pos = Number(job.position) || 0;
  if (job.status === 'playing') {
    const skew = S.pollAt - S.pollNow; // часы сервера и этого компьютера могут расходиться
    const ref = Math.abs(skew) < 5000 ? S.pollNow : S.pollAt;
    pos += Math.max(0, Date.now() - ref) / 1000;
  }
  if (job.duration) pos = Math.min(pos, Math.max(0, Number(job.duration) - 0.5));
  return Math.max(0, pos);
}

async function checkMonitorDevice() {
  let dev = null;
  try {
    const r = await req('GetProfileParameter', { parameterCategory: 'Audio', parameterName: 'MonitoringDeviceName' });
    dev = r.parameterValue || null;
  } catch {}
  S.obs.monitorDevice = dev;
  S.monitorWarn = dev && /cable/i.test(dev) ? null : 'В OBS не выбран мониторинг «CABLE Input» — в Zoom не будет звука';
  if (S.monitorWarn) logThrottled('monitor', `Внимание: устройство мониторинга OBS — «${dev || 'по умолчанию'}». ${S.monitorWarn}`, 600_000);
}

async function ensureVirtualCam() {
  const vc = await req('GetVirtualCamStatus');
  if (!vc.outputActive) {
    log('Включаем виртуальную камеру OBS');
    try {
      await req('StartVirtualCam');
    } catch (e) {
      throw new Error(`не удалось включить виртуальную камеру OBS: ${errText(e)}`);
    }
  }
  S.obs.virtualCam = true;
}

// Запустить файл заново и перемотать на нужную позицию
async function startMediaAt(job) {
  await mediaAction(MEDIA.RESTART);
  const m = await waitMediaState([ST.PLAYING], 10_000);
  if (!m) throw new Error(`OBS не начал воспроизведение файла за 10 с (${job.file}) — файл повреждён или формат не поддерживается`);
  const pos = expectedPosition(job);
  if (job.status === 'paused') await mediaAction(MEDIA.PAUSE);
  if (pos > 0.5) {
    await seek(pos);
    log(`Запись перемотана на ${fmtTime(pos)}`);
  }
  S.lastDriftCheck = Date.now();
}

// Сцена, источник, растяжение на весь холст, мониторинг звука, запуск, виртуальная камера
async function setupObsMedia(job) {
  const { sceneName, inputName } = cfg;
  if (!fs.existsSync(job.file)) throw new Error(`файл записи не найден на этом компьютере: ${job.file}`);

  setState('starting', 'Настраиваем сцену и источник в OBS');
  const { scenes = [] } = await req('GetSceneList');
  if (!scenes.some((s) => s.sceneName === sceneName)) {
    log(`Создаём сцену «${sceneName}» в OBS`);
    await req('CreateScene', { sceneName });
  }
  await req('SetCurrentProgramScene', { sceneName });

  const settings = {
    local_file: job.file,
    is_local_file: true,
    looping: false,
    restart_on_activate: false,
    close_when_inactive: false,
    hw_decode: false,
    clear_on_media_end: false,
  };
  const { inputs = [] } = await req('GetInputList');
  const existing = inputs.find((i) => i.inputName === inputName);
  let sceneItemId = null;
  if (!existing) {
    log(`Создаём медиаисточник «${inputName}» в OBS`);
    const r = await req('CreateInput', { sceneName, inputName, inputKind: 'ffmpeg_source', inputSettings: settings, sceneItemEnabled: true });
    sceneItemId = r.sceneItemId ?? null;
  } else {
    if (existing.inputKind && existing.inputKind !== 'ffmpeg_source') {
      throw new Error(`в OBS уже есть источник «${inputName}» другого типа (${existing.inputKind}) — удалите или переименуйте его`);
    }
    await req('SetInputSettings', { inputName, inputSettings: settings, overlay: true });
  }
  if (sceneItemId == null) {
    try {
      sceneItemId = (await req('GetSceneItemId', { sceneName, sourceName: inputName })).sceneItemId;
    } catch {
      sceneItemId = (await req('CreateSceneItem', { sceneName, sourceName: inputName, sceneItemEnabled: true })).sceneItemId;
    }
  }
  await req('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: true });

  const vs = await req('GetVideoSettings');
  await req('SetSceneItemTransform', {
    sceneName,
    sceneItemId,
    sceneItemTransform: {
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: vs.baseWidth,
      boundsHeight: vs.baseHeight,
      positionX: 0,
      positionY: 0,
      alignment: 5,
      boundsAlignment: 0,
    },
  });

  await req('SetInputAudioMonitorType', { inputName, monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' });
  await req('SetInputMute', { inputName, inputMuted: false }).catch(() => {});
  await checkMonitorDevice();

  const pos = expectedPosition(job);
  setState('starting', `Запускаем запись в OBS с ${fmtTime(pos)}`);
  await startMediaAt(job);

  await ensureVirtualCam();
}

// Сверка воспроизведения в OBS с сервером (пауза/продолжение/перемотка/расхождение)
async function syncMedia(job) {
  const a = S.active;
  const m = await getMediaStatus();
  const now = Date.now();
  const expected = expectedPosition(job);
  const cursor = m.mediaCursor == null ? null : m.mediaCursor / 1000;
  const mediaDur = m.mediaDuration ? m.mediaDuration / 1000 : null;

  // перемотка на сервере: позиция «прыгнула» относительно прошлого опроса
  let jumped = false;
  if (a.lastExpected != null) {
    const predicted = a.lastExpected + (a.status === 'playing' ? (now - a.lastExpectedAt) / 1000 : 0);
    jumped = Math.abs(expected - predicted) > DRIFT_MAX_S;
  }
  a.lastExpected = expected;
  a.lastExpectedAt = now;

  const checkDrift = async (force) => {
    if (!force && now - S.lastDriftCheck < DRIFT_CHECK_MS) return;
    S.lastDriftCheck = now;
    if (cursor == null) return;
    const drift = cursor - expected;
    if (Math.abs(drift) > DRIFT_MAX_S) {
      log(`Расхождение с сервером ${drift > 0 ? '+' : ''}${drift.toFixed(1)} с — перематываем на ${fmtTime(expected)}`);
      await seek(expected);
    }
  };
  const finished = mediaDur != null && expected >= mediaDur - 1;

  if (job.status === 'playing') {
    if (m.mediaState === ST.PLAYING) {
      await checkDrift(jumped || a.status !== 'playing');
    } else if (m.mediaState === ST.PAUSED) {
      log(`Продолжаем воспроизведение с ${fmtTime(expected)}`);
      await seek(expected);
      await mediaAction(MEDIA.PLAY);
      S.lastDriftCheck = now;
    } else if ([ST.STOPPED, ST.ENDED, ST.NONE, ST.ERROR].includes(m.mediaState) && !finished) {
      log(`Воспроизведение в OBS остановилось (${m.mediaState}) — запускаем заново`);
      await startMediaAt(job);
    }
  } else if (job.status === 'paused') {
    if (m.mediaState === ST.PLAYING) {
      log(`Пауза на ${fmtTime(expected)}`);
      await mediaAction(MEDIA.PAUSE);
      if (cursor == null || Math.abs(cursor - expected) > 0.5) await seek(expected);
      S.lastDriftCheck = now;
    } else if (m.mediaState === ST.PAUSED) {
      await checkDrift(jumped);
    } else if ([ST.STOPPED, ST.ENDED, ST.NONE, ST.ERROR].includes(m.mediaState) && !finished) {
      await startMediaAt(job);
    }
  }
  a.status = job.status;
}

// ---------- Zoom ----------
async function zoomStatus() {
  try {
    const s = await platform.status();
    S.zoom = { running: s.zoomRunning, inMeeting: s.inMeeting };
    S.obsRunning = s.obsRunning;
  } catch (e) {
    logThrottled('ps', `Не удалось проверить процессы Zoom/OBS: ${errText(e)}`);
  }
  return S.zoom;
}

// Возвращает текст для сообщения о Zoom (или null, если всё в порядке)
async function ensureZoom(job, fresh) {
  const parsed = parseZoomLink(job.link);
  if (!parsed || (!parsed.confno && !parsed.raw)) {
    return `Не удалось разобрать ссылку Zoom «${String(job.link || '').slice(0, 80)}» — нужна ссылка-приглашение или номер встречи`;
  }
  const url = buildJoinUrl(parsed, job.name || 'Автовебинар');
  const z = await zoomStatus();
  if (z.inMeeting) {
    if (fresh && S.joinedByUs && S.joinedConfno && parsed.confno && S.joinedConfno !== parsed.confno) {
      log(`Zoom во встрече ${S.joinedConfno}, а нужна ${parsed.confno} — закрываем Zoom и заходим заново`);
      await platform.killZoom();
      await sleep(3000);
      S.lastJoinAt = 0;
    } else {
      S.joinAttempts = 0;
      return null;
    }
  }
  if (fresh && S.joinedConfno !== parsed.confno) S.lastJoinAt = 0;
  const retryMs = (Number(cfg.joinRetrySec) || 60) * 1000;
  if (S.lastJoinAt && Date.now() - S.lastJoinAt < retryMs) {
    return S.joinAttempts > 1
      ? `Zoom не заходит во встречу (попытка ${S.joinAttempts}) — проверьте, что клиент Zoom запущен и вошёл в аккаунт`
      : 'Заходим в Zoom-встречу…';
  }
  if (S.lastJoinAt) log(`Zoom не во встрече ${Math.round((Date.now() - S.lastJoinAt) / 1000)} с после попытки входа — пробуем снова`);
  setState(S.state === 'starting' ? 'starting' : S.state, 'Заходим в Zoom-встречу…');
  log(`Открываем Zoom: ${maskUrl(url)}`);
  try {
    await platform.openUrl(url, cfg.zoomExe);
  } catch (e) {
    S.lastJoinAt = Date.now();
    return `Не удалось открыть Zoom: ${errText(e)}`;
  }
  S.lastJoinAt = Date.now();
  S.joinAttempts++;
  S.joinedByUs = true;
  S.joinedConfno = parsed.confno;
  return 'Заходим в Zoom-встречу…';
}

async function leaveZoom() {
  log('Выходим из Zoom (закрываем клиент Zoom)');
  try { await platform.killZoom(); } catch (e) { log(`Не удалось закрыть Zoom: ${errText(e)}`); }
  S.joinedByUs = false;
  S.joinedConfno = null;
  S.lastJoinAt = 0;
  S.joinAttempts = 0;
  await zoomStatus();
}

// ---------- сценарии ----------
function composeMessage(job, zoomMsg) {
  const parts = [];
  const where = job.roomName ? ` («${job.roomName}»)` : '';
  if (job.noJoin) parts.push('Тест: запись идёт в OBS, в Zoom не заходим');
  else if (zoomMsg) parts.push(zoomMsg);
  else parts.push(job.status === 'paused' ? `Пауза в Zoom-встрече${where}` : `Запись идёт в Zoom-встрече${where}`);
  if (job.noJoin && job.status === 'paused') parts.push('пауза');
  if (S.monitorWarn) parts.push(S.monitorWarn);
  return parts.reduce((acc, x) => (acc ? acc + (/[.…!?]$/.test(acc) ? ' ' : '. ') + x : x), '');
}

async function startJob(job) {
  S.leaveAt = 0;
  S.active = null;
  log(`Новое задание ${job.key}: «${job.roomName || job.roomId}», файл ${job.file}, позиция ${fmtTime(Number(job.position) || 0)}, ${job.status}${job.noJoin ? ', тест без входа в Zoom' : ''}`);
  setState('starting', `Запуск: «${job.roomName || job.roomId}»`);
  try {
    if (!obs.connected) setState('starting', 'Подключаемся к OBS');
    await ensureObs();
    await setupObsMedia(job);
  } catch (e) {
    S.failedKey = job.key;
    S.startRetryAt = Date.now() + START_RETRY_MS;
    setState('error', `Не удалось запустить запись: ${errText(e)}`);
    return;
  }
  S.active = {
    key: job.key,
    file: job.file,
    noJoin: !!job.noJoin,
    status: job.status,
    needSetup: false,
    lastExpected: null,
    lastExpectedAt: 0,
  };
  S.failedKey = null;
  let zoomMsg = null;
  if (!job.noJoin) zoomMsg = await ensureZoom(job, true);
  else await zoomStatus();
  setState(job.status === 'paused' ? 'paused' : 'playing', composeMessage(job, zoomMsg));
}

async function followJob(job) {
  const a = S.active;
  if (!obs.connected) {
    setState('starting', 'Связь с OBS потеряна — переподключаемся');
    a.needSetup = true;
    await ensureObs();
  }
  if (a.needSetup || a.file !== job.file) {
    a.file = job.file;
    await setupObsMedia(job);
    a.needSetup = false;
    a.status = job.status;
    a.lastExpected = null;
  } else {
    await syncMedia(job);
    if (!S.obs.virtualCam) await ensureVirtualCam();
  }
  if (a.noJoin && !job.noJoin) log('Тестовый режим выключен — заходим в Zoom');
  a.noJoin = !!job.noJoin;
  let zoomMsg = null;
  if (!a.noJoin) {
    const wasIn = S.zoom.inMeeting;
    zoomMsg = await ensureZoom(job, false);
    if (wasIn && !S.zoom.inMeeting) log('Zoom вышел из встречи');
  }
  setState(job.status === 'paused' ? 'paused' : 'playing', composeMessage(job, zoomMsg));
}

async function stopPlayback(why) {
  const a = S.active;
  S.active = null;
  log(`${why} — останавливаем запись в OBS`);
  if (obs.connected) {
    try { await mediaAction(MEDIA.STOP); } catch (e) { log(`Не удалось остановить запись в OBS: ${errText(e)}`); }
  }
  if (cfg.leaveOnEnd && a && !a.noJoin && S.joinedByUs) {
    S.leaveAt = Date.now() + LEAVE_GRACE_MS;
    setState('ending', `${why}. Выходим из Zoom через ${LEAVE_GRACE_MS / 1000} с`);
  } else {
    setState('idle', `${why}. Ожидание задания`);
  }
}

async function handleJob(job) {
  const ended = !job || job.status === 'ended' || !job.file;
  if (ended) {
    if (S.active) {
      await stopPlayback(job && job.status === 'ended' ? 'Запись закончилась' : 'Трансляция остановлена');
    } else if (S.leaveAt) {
      if (Date.now() >= S.leaveAt) {
        S.leaveAt = 0;
        await leaveZoom();
        setState('idle', 'Вышли из Zoom. Ожидание задания');
      }
    } else if (S.state !== 'idle') {
      setState('idle', 'Ожидание задания');
    }
    return;
  }
  if (!S.active || S.active.key !== job.key) {
    if (S.failedKey === job.key && Date.now() < S.startRetryAt) return;
    await startJob(job);
    return;
  }
  await followJob(job);
}

// Состояние OBS/Zoom для отчёта
async function refreshStatus() {
  await zoomStatus();
  if (!obs.connected && !S.active && Date.now() - S.lastObsProbe > IDLE_OBS_PROBE_MS) {
    S.lastObsProbe = Date.now();
    try { await obs.connect(3000); await onObsConnected(); } catch {}
  }
  S.obs.connected = obs.connected;
  if (!obs.connected) {
    S.obs.virtualCam = false;
    S.media = { state: null, cursor: null, duration: null };
    return;
  }
  try { S.obs.virtualCam = !!(await req('GetVirtualCamStatus')).outputActive; } catch {}
  try { await getMediaStatus(); } catch { S.media = { state: null, cursor: null, duration: null }; }
  if (S.obs.monitorDevice == null && !S.active) await checkMonitorDevice().catch(() => {});
}

async function cycle() {
  try {
    loadConfig();
    S.token = readToken();
  } catch (e) {
    logThrottled('cfg', `Ошибка: ${errText(e)}`);
    return;
  }
  let poll;
  try {
    poll = await pollServer();
  } catch (e) {
    logThrottled('poll', `Сервер ${cfg.server} недоступен: ${errText(e.cause || e)}`);
    return;
  }
  if (poll.unauthorized) {
    logThrottled('poll', `Сервер отклонил токен (401) — проверьте файл ${cfg.tokenFile}`);
    return;
  }
  S.pollNow = Number(poll.now) || Date.now();
  S.pollAt = Date.now();
  await refreshStatus();
  try {
    await handleJob(poll.job || null);
  } catch (e) {
    if (S.active && !obs.connected) S.active.needSetup = true;
    setState('error', `Ошибка: ${errText(e)}`);
  }
  await report();
}

async function main() {
  log(`Zoom-пульт ${VERSION} запущен (Node ${process.version}${platform.fake ? ', ИМИТАЦИЯ Windows' : ''}), настройки: ${CONFIG_PATH}`);
  while (!S.stopping) {
    const t0 = Date.now();
    try {
      await cycle();
    } catch (e) {
      log(`Внутренняя ошибка: ${(e && e.stack) || e}`);
    }
    await sleep(Math.max(200, POLL_MS - (Date.now() - t0)));
  }
}

async function shutdown(sig) {
  if (S.stopping) return;
  S.stopping = true;
  log(`Получен ${sig} — завершаем работу`);
  S.state = 'idle';
  S.message = 'Zoom-пульт остановлен';
  S.active = null;
  reportBusy = false;
  await Promise.race([report(), sleep(3000)]);
  obs.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
if (platform.fake && process.platform !== 'win32') process.on('SIGUSR2', () => platform._dropMeeting());
process.on('uncaughtException', (e) => log(`Непредвиденная ошибка: ${(e && e.stack) || e}`));
process.on('unhandledRejection', (e) => log(`Непредвиденная ошибка: ${(e && e.stack) || e}`));

main();
