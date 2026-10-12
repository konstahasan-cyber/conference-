// Качество видео для mesh-конференции: ограничения камеры и битрейт отправки
(() => {
  // ideal, а не exact: слабые/мобильные камеры отдадут что могут, а не упадут с OverconstrainedError
  const videoConstraints = (role) => role === 'host'
    ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
    // гость в mesh шлёт поток каждому участнику — берём полегче
    : { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24 } };

  const audioConstraints = () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });

  // чем больше пиров, тем меньше битрейт на каждого — иначе забьём аплинк
  const cameraBitrate = (n) => n <= 1 ? 1_500_000 : n <= 3 ? 900_000 : n <= 6 ? 500_000 : 300_000;
  // для экрана держим планку выше: мелкий текст должен оставаться читаемым
  const screenBitrate = (n) => Math.max(cameraBitrate(n), n <= 3 ? 1_200_000 : 800_000);

  const isClosed = (pc) => !pc || pc.connectionState === 'closed' || pc.signalingState === 'closed';

  // sender может временно жить с track = null (replaceTrack(null)), поэтому ищем и через трансиверы
  const videoSender = (pc) => {
    try {
      const s = pc.getSenders().find((x) => x.track?.kind === 'video');
      if (s) return s;
      const t = pc.getTransceivers().find((x) => !x.stopped && (x.sender.track?.kind === 'video' || x.receiver?.track?.kind === 'video'));
      return t?.sender || null;
    } catch { return null; }
  };

  const apply = async (pc, n, screen) => {
    if (isClosed(pc)) return;
    const sender = videoSender(pc);
    if (!sender?.getParameters || !sender.setParameters) return;
    try {
      const params = sender.getParameters();
      // до согласования (или в старом Safari) encodings бывает пустым
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const enc = params.encodings[0];
      enc.maxBitrate = screen ? screenBitrate(n) : cameraBitrate(n);
      if (!screen) {
        if (n <= 3) enc.scaleResolutionDownBy = 1;
        else if (n > 6) enc.scaleResolutionDownBy = 1.5;
      } else {
        enc.scaleResolutionDownBy = 1;
      }
      // экран: лучше реже кадры, чем мыло; камера — пусть браузер балансирует сам
      params.degradationPreference = screen ? 'maintain-resolution' : 'balanced';
      await sender.setParameters(params).catch(() => {});
    } catch {
      // старый Safari бросает синхронно на неподдерживаемых полях — не критично
    }
  };

  // дебаунс: при входе/выходе нескольких людей подряд перенастраиваем один раз
  let timer = null;
  let pending = null;
  let lastArgs = null;
  const tune = (pcs, { screen = false } = {}) => {
    lastArgs = { pcs: [...(pcs || [])], screen };
    if (timer) clearTimeout(timer);
    if (!pending) {
      let resolve;
      pending = { promise: new Promise((r) => { resolve = r; }), resolve };
    }
    const cur = pending;
    timer = setTimeout(async () => {
      timer = null;
      pending = null;
      const { pcs: list, screen: scr } = lastArgs;
      const n = list.length;
      await Promise.all(list.map((pc) => apply(pc, n, scr)));
      cur.resolve();
    }, 300);
    return cur.promise;
  };

  window.NetQuality = { videoConstraints, audioConstraints, tune };
})();
