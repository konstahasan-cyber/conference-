// Синхронизация показа записи: решаем, когда перематывать, а когда мягко догонять скоростью.
// Главное правило: не перематывать во время буферизации — перемотка сбрасывает буфер
// и вызывает новую буферизацию, из-за чего на медленном интернете видео бесконечно «заикается».
(function () {
  const DEAD_ZONE = 0.6;        // расхождение, которое не трогаем вовсе
  const SOFT_LIMIT = 8;         // до этого порога догоняем скоростью, дальше — перемотка
  const STALL_SEEK_LIMIT = 15;  // при буферизации перематываем только при очень большом отставании
  const LOOKAHEAD = 0.5;        // при перемотке вперёд целимся чуть дальше: пока грузится, «эфир» уйдёт вперёд
  const RATE_MIN = 0.9;
  const RATE_MAX = 1.15;
  const HAVE_FUTURE_DATA = 3;   // readyState: есть данные для продолжения воспроизведения

  function clampRate(r) {
    return Math.min(RATE_MAX, Math.max(RATE_MIN, r));
  }

  function decide(opts) {
    const o = opts || {};
    const want = Number(o.want);
    const current = Number(o.current);
    if (!Number.isFinite(want)) return { seek: null, rate: 1 };

    // Старт, перемотка или продолжение от ведущего — ставим позицию точно, без догадок.
    if (o.force) return { seek: Math.max(0, want), rate: 1 };
    if (!Number.isFinite(current)) return { seek: Math.max(0, want), rate: 1 };

    const diff = want - current; // > 0 — отстаём, < 0 — убежали вперёд
    const stalled = Number(o.readyState) < HAVE_FUTURE_DATA;

    // Видео ждёт данных: перемотка только усугубит, поэтому ждём,
    // кроме случая огромного отставания (например, долго не было сети).
    if (stalled) {
      if (diff > STALL_SEEK_LIMIT) return { seek: want + LOOKAHEAD, rate: 1 };
      return { seek: null, rate: 1 };
    }

    const abs = Math.abs(diff);
    if (abs <= DEAD_ZONE) return { seek: null, rate: 1 };

    // Сильное расхождение — дешевле перемотать, чем догонять минутами.
    if (abs > SOFT_LIMIT) {
      return { seek: Math.max(0, diff > 0 ? want + LOOKAHEAD : want), rate: 1 };
    }

    // Небольшое отставание — чуть ускоряемся (высота звука сохраняется браузером).
    if (diff > 0) return { seek: null, rate: clampRate(diff < 3 ? 1.08 : 1.15) };
    // Убежали вперёд — чуть замедляемся, пока «эфир» не догонит.
    return { seek: null, rate: clampRate(0.92) };
  }

  window.PlaybackSync = {
    decide,
    SYNC_INTERVAL_MS: 1000,
  };
})();
