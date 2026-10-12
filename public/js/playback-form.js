// Форма настроек показа записи (общая для «По умолчанию» и пульта встречи)
(function () {
  const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const REPEAT = [['none', 'Один раз'], ['daily', 'Каждый день'], ['weekdays', 'По будням (пн–пт)'], ['weekly', 'Каждую неделю']];

  window.renderPlaybackForm = (box, pb, recordings) => {
    const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    box.innerHTML = `
      <label class="field"><span>Запись</span>
        <select data-f="recordingId"><option value="">— не выбрана —</option>${recordings.map((r) => opt(r.id, pb.recordingId, esc(r.title) + (r.duration ? ' · ' + fmtTime(r.duration) : ''))).join('')}</select></label>
      <div><span class="label">Как показывать</span>
        <div class="choice">
          <label><input type="radio" name="pf-display" value="camera" ${pb.display === 'camera' ? 'checked' : ''}><span><b>Как камера ведущего</b><span class="d">Плитка участника с вашим именем, звук из видео</span></span></label>
          <label><input type="radio" name="pf-display" value="presentation" ${pb.display === 'presentation' ? 'checked' : ''}><span><b>Как демонстрация экрана</b><span class="d">Видео на весь экран, как презентация</span></span></label>
        </div></div>
      <label class="field"><span>Имя ведущего на плитке</span><input data-f="presenterName" maxlength="60" value="${esc(pb.presenterName)}"></label>
      <label class="switch"><span class="txt"><b>Показывать ведущего до старта</b><span>Плитка с аватаркой, пока запись не началась</span></span>
        <input type="checkbox" data-f="showPresenterBeforeStart" ${pb.showPresenterBeforeStart ? 'checked' : ''}><span class="knob"></span></label>
      <div><span class="label">Когда запускать</span>
        <div class="choice">
          <label><input type="radio" name="pf-mode" value="manual" ${pb.startMode === 'manual' ? 'checked' : ''}><span><b>Вручную</b><span class="d">Кнопкой «Запустить» на пульте или во встрече</span></span></label>
          <label><input type="radio" name="pf-mode" value="scheduled" ${pb.startMode === 'scheduled' ? 'checked' : ''}><span class="grow"><b>По расписанию</b>
            <span class="d">Опоздавшие попадут в текущий момент, как в настоящем эфире</span>
            <span class="row" style="margin-top:8px"><input type="datetime-local" data-f="startAt" value="${toLocalInput(pb.startAt)}" style="width:auto">
            <select data-f="repeat" style="width:auto">${REPEAT.map(([v, l]) => opt(v, pb.repeat, l)).join('')}</select></span></span></label>
          <label><input type="radio" name="pf-mode" value="firstGuest" ${pb.startMode === 'firstGuest' ? 'checked' : ''}><span><b>После входа первого участника</b>
            <span class="d">через <input type="number" data-f="delaySec" min="0" max="3600" value="${pb.delaySec}" class="inline" style="width:76px"> сек.</span></span></label>
        </div></div>
      <label class="field"><span>Когда запись закончится</span>
        <select data-f="endAction">${opt('stay', pb.endAction, 'Оставить участников в комнате')}${opt('endMeeting', pb.endAction, 'Завершить встречу для всех')}</select></label>`;
    $('[data-f=startAt]', box).onfocus = $('[data-f=repeat]', box).onfocus = () => ($('input[name=pf-mode][value=scheduled]', box).checked = true);
    $('[data-f=delaySec]', box).onfocus = () => ($('input[name=pf-mode][value=firstGuest]', box).checked = true);
  };

  window.readPlaybackForm = (box) => {
    const f = (k) => $(`[data-f=${k}]`, box);
    const startAt = f('startAt').value;
    return {
      recordingId: f('recordingId').value || null,
      display: $('input[name=pf-display]:checked', box)?.value,
      presenterName: f('presenterName').value,
      showPresenterBeforeStart: f('showPresenterBeforeStart').checked,
      startMode: $('input[name=pf-mode]:checked', box)?.value || 'manual',
      startAt: startAt ? new Date(startAt).toISOString() : null,
      repeat: f('repeat').value,
      tzOffset: new Date().getTimezoneOffset(),
      delaySec: f('delaySec').value,
      endAction: f('endAction').value,
    };
  };

  window.validatePlayback = (pb, { needRecording = true } = {}) => {
    if (pb.startMode === 'scheduled' && !pb.startAt) return 'Укажите дату и время старта';
    if (needRecording && pb.startMode !== 'manual' && !pb.recordingId) return 'Выберите запись для автозапуска';
    return null;
  };

  const REPEAT_LABEL = Object.fromEntries(REPEAT);
  window.scheduleText = (pb, nextStart) => {
    if (pb.startMode === 'manual') return 'запуск вручную';
    if (pb.startMode === 'firstGuest') return `через ${pb.delaySec} с после входа первого`;
    if (!pb.startAt) return 'расписание не задано';
    const rep = pb.repeat !== 'none' ? ` · ${REPEAT_LABEL[pb.repeat].toLowerCase()}` : '';
    return nextStart ? `следующий: ${fmtDate(nextStart)}${rep}` : `был: ${fmtDate(pb.startAt)}${rep}`;
  };
})();
