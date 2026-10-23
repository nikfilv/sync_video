(() => {
  let video = null;
  let selected = false;
  let session = null;
  let applyingUntil = 0;
  let localUntil = 0;
  let lastHeartbeat = 0;
  let seekTimer;
  let reporting = false;
  let banner;
  let label;
  let resumeButton;
  let noticeTimer;
  let lastNotice;
  const send = message => chrome.runtime.sendMessage(message);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const isAd = element => Boolean(element?.closest('.ad-showing, .ad-interrupting'));

  function hideNotice() {
    clearTimeout(noticeTimer);
    if (banner) { banner.hidden = true; banner.style.display = 'none'; }
  }
  function notify(text, needsGesture = false) {
    const noticeKey = `${needsGesture}:${text}`;
    // Polling repeats the same state. A dismissed/expired notice must stay hidden.
    if (noticeKey === lastNotice) return;
    lastNotice = noticeKey;
    if (!banner) {
      banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:320px';
      const root = banner.attachShadow({ mode: 'closed' });
      const panel = document.createElement('div');
      panel.style.cssText = 'background:#171b2b;color:#f4f5ff;border:1px solid #7566ed;border-radius:12px;padding:11px 14px;font:13px/1.5 system-ui;box-shadow:0 5px 24px #0005';
      label = document.createElement('span');
      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.textContent = '×';
      closeButton.title = 'Скрыть уведомление';
      closeButton.ariaLabel = 'Скрыть уведомление';
      closeButton.style.cssText = 'float:right;margin:-4px -5px 2px 10px;border:0;background:transparent;color:#c9c5ee;font:20px/1 system-ui;cursor:pointer;padding:4px';
      closeButton.onclick = hideNotice;
      resumeButton = document.createElement('button');
      resumeButton.type = 'button';
      resumeButton.textContent = 'Разрешить воспроизведение';
      resumeButton.style.cssText = 'display:block;margin-top:8px;border:0;border-radius:7px;padding:8px;background:#8d7bff;color:#fff;cursor:pointer;font:inherit';
      resumeButton.onclick = async () => {
        if (!video) return;
        applyingUntil = Date.now() + 600;
        try { await video.play(); await applyRemote(session?.snapshot); }
        catch { notify('Нажмите Play в самом плеере', true); }
      };
      panel.append(closeButton, label, resumeButton);
      root.append(panel);
      document.documentElement.append(banner);
    }
    banner.hidden = false;
    banner.style.display = 'block';
    label.textContent = text;
    resumeButton.hidden = !needsGesture;
    // An explicit display:block otherwise overrides the browser's [hidden] rule.
    resumeButton.style.display = needsGesture ? 'block' : 'none';
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, needsGesture ? 8000 : 3500);
  }
  function state() {
    return { time: video.currentTime, paused: video.paused, rate: video.playbackRate };
  }
  async function publish(kind = 'control') {
    if (!video || !selected || !session || isAd(video) || video.readyState < 1 || !Number.isFinite(video.currentTime)) return;
    if (kind === 'control') localUntil = Date.now() + 1500;
    try {
      const result = await send({ type: 'COMMAND', kind, clientId: session.clientId, state: state() });
      if (!result.ok) notify(`Нет связи: ${result.error}`);
    } catch { notify('Расширение обновлено. Перезагрузите страницу.'); }
  }
  function onControl(event) {
    if (Date.now() < applyingUntil || isAd(video)) return;
    if (event.type === 'seeked') {
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => publish(), 120);
    } else if (!video.seeking) publish();
  }
  function findVideo() {
    const list = [...document.querySelectorAll('video')].map(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      return { element, area: visible && !isAd(element) ? rect.width * rect.height : 0 };
    }).filter(item => item.area > 0).sort((a, b) => b.area - a.area);
    const next = list[0]?.element || null;
    if (next !== video) {
      if (video) for (const type of ['play', 'pause', 'seeked', 'ratechange']) video.removeEventListener(type, onControl);
      clearTimeout(seekTimer);
      video = next;
      if (video) for (const type of ['play', 'pause', 'seeked', 'ratechange']) video.addEventListener(type, onControl);
    }
    return list[0]?.area || 0;
  }
  async function applyRemote(snapshot) {
    if (!selected || !session || !video || isAd(video) || !snapshot?.state) return;
    const remote = snapshot.state;
    session.snapshot = snapshot;
    if (remote.mediaKey !== session.mediaKey) {
      notify('В комнате открыто другое видео. Откройте ту же ссылку.');
      return;
    }
    if (remote.clientId === session.clientId || Date.now() < localUntil) return;
    if (video.readyState < 1 || video.seeking) return;
    const serverNow = Date.now() + (snapshot.clockOffset || 0);
    let target = remote.time + (remote.paused ? 0 : Math.max(0, serverNow - remote.updatedAt) / 1000 * remote.rate);
    if (Number.isFinite(video.duration)) target = Math.min(target, Math.max(0, video.duration - 0.05));
    try {
      const seek = Math.abs(video.currentTime - target) > (remote.paused ? 0.15 : 0.8);
      const changeRate = Math.abs(video.playbackRate - remote.rate) > 0.01;
      const changePlayback = video.paused !== remote.paused;
      if (seek || changeRate || changePlayback) applyingUntil = Date.now() + 700;
      if (changeRate) video.playbackRate = remote.rate;
      if (seek) video.currentTime = target;
      if (remote.paused && !video.paused) video.pause();
      if (!remote.paused && video.paused) await video.play();
      notify('Смотрим вместе · синхронизация включена');
    } catch (error) {
      notify(error.name === 'NotAllowedError' ? 'Браузер ждёт нажатия для запуска видео' : 'Нажмите Play в плеере для синхронизации', true);
    }
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'REMOTE') {
      session = { ...session, clientId: message.clientId, mediaKey: message.mediaKey, snapshot: message.snapshot };
      applyRemote(message.snapshot);
    }
  });
  async function report() {
    if (reporting) return;
    reporting = true;
    try {
      const result = await send({ type: 'REPORT', area: findVideo() });
      if (!result.ok) return;
      const wasConnected = Boolean(session?.code);
      selected = result.selected;
      session = result.session;
      if (!session || !selected) { hideNotice(); lastNotice = null; return; }
      if (!wasConnected) notify('Смотрим вместе · подключено');
      if (!session.snapshot?.state) await publish();
      else await applyRemote(session.snapshot);
      const remote = session.snapshot?.state;
      if (remote?.clientId === session.clientId && remote.mediaKey === session.mediaKey && video && !video.paused && Date.now() - lastHeartbeat > 5000) {
        lastHeartbeat = Date.now();
        await publish('heartbeat');
      }
    } catch { hideNotice(); }
    finally { reporting = false; }
  }
  report();
  setInterval(report, 2000);
  if (window === window.top) {
    (async () => {
      while (chrome.runtime?.id) {
        try {
          const result = await send({ type: 'POLL' });
          if (!result.ok) {
            if (session) notify(`Нет связи: ${result.error}`);
            await sleep(3000);
          } else if (!result.connected) await sleep(1000);
        } catch { await sleep(3000); }
      }
    })();
  }
})();
