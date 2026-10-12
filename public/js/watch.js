// Публичная страница просмотра записи: /v/:token
(() => {
  const token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const POS_KEY = 'watch-pos:' + token;
  const video = $('#video');

  const store = {
    get() { try { return Number(localStorage.getItem(POS_KEY)) || 0; } catch (e) { return 0; } },
    set(v) { try { localStorage.setItem(POS_KEY, String(Math.floor(v))); } catch (e) {} },
    clear() { try { localStorage.removeItem(POS_KEY); } catch (e) {} },
  };

  const show = (id) => {
    for (const v of ['loadingView', 'playerView', 'errorView']) $('#' + v).classList.toggle('hidden', v !== id);
  };

  function showError(text) {
    document.title = 'Запись недоступна';
    if (text) $('#errorText').textContent = text;
    show('errorView');
  }

  async function copyLink() {
    const link = location.origin + location.pathname;
    try {
      await navigator.clipboard.writeText(link);
    } catch (e) {
      // запасной вариант для http и старых браузеров
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (err) {}
      ta.remove();
    }
    toast('Ссылка скопирована');
  }

  function fileName(title, src) {
    const ext = (src.match(/\.(\w+)(?:\?|$)/) || [])[1] || 'mp4';
    const base = String(title || 'Запись').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Запись';
    return `${base}.${ext}`;
  }

  function setupResume() {
    const saved = store.get();
    const dur = video.duration;
    // предлагаем продолжить, если досмотрели не до конца
    if (saved > 10 && (!isFinite(dur) || saved < dur - 5)) {
      $('#resumeText').textContent = 'Продолжить с ' + fmtTime(saved);
      $('#resumeBox').classList.remove('hidden');
      $('#resumeBtn').onclick = () => {
        video.currentTime = saved;
        $('#resumeBox').classList.add('hidden');
        video.play().catch(() => {});
      };
      $('#resumeNo').onclick = () => {
        store.clear();
        $('#resumeBox').classList.add('hidden');
        video.play().catch(() => {});
      };
    }
  }

  function trackPosition() {
    let last = 0;
    video.addEventListener('timeupdate', () => {
      if (Math.abs(video.currentTime - last) < 2) return;
      last = video.currentTime;
      if (video.currentTime > 3) store.set(video.currentTime);
    });
    video.addEventListener('play', () => $('#resumeBox').classList.add('hidden'));
    video.addEventListener('pause', () => { if (video.currentTime > 3) store.set(video.currentTime); });
    video.addEventListener('ended', () => store.clear());
    window.addEventListener('pagehide', () => {
      if (video.currentTime > 3 && !video.ended) store.set(video.currentTime);
    });
  }

  async function init() {
    if (!token) return showError();
    let rec;
    try {
      rec = await api('/api/watch/' + encodeURIComponent(token));
    } catch (e) {
      return showError();
    }

    const src = pickMediaUrl(rec.url, rec.altUrl);
    const title = rec.title || 'Запись встречи';
    document.title = title;

    $('#title').textContent = title;
    $('#author').textContent = rec.author || 'Организатор';
    $('#authorAvatar').innerHTML = avatarHtml(rec.author || 'Организатор', 'watch-avatar');
    $('#date').textContent = rec.createdAt ? fmtDate(rec.createdAt) : '';
    const setDuration = (d) => {
      $('#duration').textContent = fmtTime(d);
      $('#durChip').classList.toggle('hidden', !(d > 0));
    };
    setDuration(rec.duration);

    const dl = $('#downloadBtn');
    dl.href = src;
    dl.setAttribute('download', fileName(title, src));
    $('#vidErrorDl').href = src;
    $('#vidErrorDl').setAttribute('download', fileName(title, src));
    $('#copyBtn').onclick = copyLink;

    video.addEventListener('loadedmetadata', () => {
      if (!(rec.duration > 0) && isFinite(video.duration)) setDuration(video.duration);
      setupResume();
    }, { once: true });
    video.addEventListener('error', () => {
      // запасной файл, если основной не воспроизвёлся
      if (rec.altUrl && video.currentSrc && !video.currentSrc.endsWith(rec.altUrl) && !video.dataset.fallback) {
        video.dataset.fallback = 1;
        video.src = rec.altUrl;
        return;
      }
      $('#vidError').classList.remove('hidden');
    });
    trackPosition();
    video.src = src;
    show('playerView');
  }

  init();
})();
