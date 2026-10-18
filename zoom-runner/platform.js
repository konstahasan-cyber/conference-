'use strict';
// Операции, зависящие от Windows: открыть zoommtg-ссылку, узнать запущенные процессы,
// закрыть Zoom, запустить OBS. ZOOM_RUNNER_FAKE_PLATFORM=1 — имитация для проверки на Linux.
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Только процессы этого пользователя: на сервере могут работать и другие сеансы
function userFilter() {
  let u = process.env.USERNAME;
  try { u = u || os.userInfo().username; } catch {}
  return u ? ['/FI', `USERNAME eq ${process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : ''}${u}`] : [];
}

const OBS_ARGS = ['--minimize-to-tray', '--disable-shutdown-check', '--disable-updater', '--disable-missing-files-check'];

function run(cmd, args, timeoutMs = 10_000, extra = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...extra }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function detached(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
    } catch (e) { return reject(e); }
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

const windows = {
  fake: false,
  // Список имён запущенных процессов этого пользователя (в нижнем регистре)
  async processes() {
    const r = await run('tasklist', ['/FO', 'CSV', '/NH', ...userFilter()]);
    if (!r.ok) throw new Error('не удалось получить список процессов (tasklist)');
    const set = new Set();
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)"/);
      if (m) set.add(m[1].toLowerCase());
    }
    return set;
  },
  // Заголовки окон Zoom (вывод в UTF-8 через chcp 65001, иначе кириллица придёт в OEM-кодировке)
  async zoomTitles() {
    const f = userFilter().map((a) => (a.startsWith('/') ? a : `"${a}"`)).join(' ');
    // командная строка для cmd собирается вручную: /s снимает внешние кавычки, внутренние остаются
    const r = await run('cmd.exe', ['/d', '/s', '/c', `"chcp 65001 >nul & tasklist /V /FO CSV /NH /FI "IMAGENAME eq Zoom.exe" ${f}"`], 10_000, { windowsVerbatimArguments: true });
    if (!r.ok) return [];
    return r.stdout.split(/\r?\n/).map((l) => (l.match(/"([^"]*)"\s*$/) || [])[1]).filter(Boolean);
  },
  async status() {
    const p = await this.processes();
    const zoomRunning = p.has('zoom.exe');
    // признак конференции: процесс CptHost.exe, а если его нет — окно «Zoom Meeting» / «Конференция Zoom»
    let inMeeting = p.has('cpthost.exe');
    if (!inMeeting && zoomRunning) {
      const titles = await this.zoomTitles().catch(() => []);
      inMeeting = titles.some((t) => /zoom meeting|zoom webinar|конференция zoom|zoom-конференция|вебинар zoom/i.test(t));
    }
    return { zoomRunning, inMeeting, obsRunning: p.has('obs64.exe') || p.has('obs32.exe') };
  },
  // Открыть zoommtg://-ссылку. Без оболочки, поэтому символ & в ссылке безопасен.
  async openUrl(url, zoomExe) {
    if (zoomExe && fs.existsSync(zoomExe)) {
      return detached(zoomExe, ['--url=' + url], { cwd: path.dirname(zoomExe) });
    }
    return detached('rundll32', ['url.dll,FileProtocolHandler', url]);
  },
  async killZoom() {
    await run('taskkill', ['/F', '/IM', 'Zoom.exe', ...userFilter()]);
    await run('taskkill', ['/F', '/IM', 'CptHost.exe', ...userFilter()]);
  },
  async launchObs(exe) {
    return detached(exe, OBS_ARGS, { cwd: path.dirname(exe) });
  },
};

function fakePlatform() {
  let inMeeting = false;
  let zoomRunning = false;
  let obsRunning = false;
  let timer = null;
  const out = (s) => process.stdout.write(`[FAKE] ${s}\n`);
  return {
    fake: true,
    async status() { return { zoomRunning, inMeeting, obsRunning }; },
    async openUrl(url, zoomExe) {
      out(`openUrl ${url}${zoomExe ? ' via ' + zoomExe : ''}`);
      zoomRunning = true;
      clearTimeout(timer);
      timer = setTimeout(() => { inMeeting = true; out('inMeeting=true'); }, 2000);
    },
    async killZoom() {
      out('killZoom');
      clearTimeout(timer);
      inMeeting = false;
      zoomRunning = false;
    },
    async launchObs(exe) {
      out(`launchObs ${exe} ${OBS_ARGS.join(' ')}`);
      obsRunning = true;
    },
    // для тестов: «Zoom выкинуло из встречи»
    _dropMeeting() { inMeeting = false; out('inMeeting=false'); },
  };
}

module.exports = process.env.ZOOM_RUNNER_FAKE_PLATFORM === '1' ? fakePlatform() : windows;
