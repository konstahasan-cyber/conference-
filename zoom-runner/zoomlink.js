'use strict';
// Разбор ссылки на Zoom-встречу и сборка ссылки zoommtg:// для клиента Zoom.
// Поддерживаются:
//   https://us05web.zoom.us/j/81234567890?pwd=AbCd...   (а также /s/, /w/, /wc/join/, /wc/<id>/join)
//   zoommtg://zoom.us/join?action=join&confno=...&pwd=... (передаётся как есть, меняется только uname)
//   "81234567890", "812 3456 7890", "812-3456-7890"
//   "81234567890 пароль"

function parseZoomLink(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return null;

  if (/^zoom(mtg|us):\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { return null; }
    const confno = (u.searchParams.get('confno') || '').replace(/\D/g, '');
    return { confno: confno || null, pwd: u.searchParams.get('pwd') || null, raw: s };
  }

  if (/^(https?:\/\/)?([a-z0-9-]+\.)*zoom\.(us|com)(\/|$)/i.test(s) || /^(https?:\/\/)?([a-z0-9-]+\.)*zoomgov\.com(\/|$)/i.test(s)) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
    const p = u.pathname;
    const m = p.match(/^\/(?:j|s|w|join|wc\/join)\/(\d{9,12})(?:\/|$)/i) || p.match(/^\/wc\/(\d{9,12})\/(?:join|start)/i);
    if (!m) return null;
    return { confno: m[1], pwd: u.searchParams.get('pwd') || null, raw: null };
  }

  // "id" или "id пароль" (id может быть записан с пробелами/дефисами)
  const m = s.match(/^((?:\d[\s-]?){8,13}\d)(?:\s+(\S+))?$/);
  if (m) {
    const confno = m[1].replace(/\D/g, '');
    if (confno.length < 9 || confno.length > 12) return null;
    return { confno, pwd: m[2] || null, raw: null };
  }
  // "id" отдельно, "пароль" — через пробел, но id с пробелами и пароль: последняя группа — пароль
  const m2 = s.match(/^([\d\s-]+?)\s+(\S*[^\d\s-]\S*)$/);
  if (m2) {
    const confno = m2[1].replace(/\D/g, '');
    if (confno.length >= 9 && confno.length <= 12) return { confno, pwd: m2[2], raw: null };
  }
  return null;
}

// Собирает zoommtg://-ссылку. Для исходной zoommtg-ссылки сохраняет все её параметры, меняя uname.
function buildJoinUrl(link, uname) {
  const parsed = typeof link === 'string' ? parseZoomLink(link) : link;
  if (!parsed) return null;
  if (parsed.raw) {
    const u = new URL(parsed.raw);
    if (!u.searchParams.get('action')) u.searchParams.set('action', 'join');
    if (uname) u.searchParams.set('uname', uname);
    return u.toString();
  }
  if (!parsed.confno) return null;
  const q = new URLSearchParams({ action: 'join', confno: parsed.confno });
  if (parsed.pwd) q.set('pwd', parsed.pwd);
  if (uname) q.set('uname', uname);
  return 'zoommtg://zoom.us/join?' + q.toString();
}

module.exports = { parseZoomLink, buildJoinUrl };
