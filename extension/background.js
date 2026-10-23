const candidates = new Map();
const commandQueues = new Map();
const sessionKey = id => `tab:${id}`;
const readSession = async id => (await chrome.storage.session.get(sessionKey(id)))[sessionKey(id)];
const saveSession = (id, session) => chrome.storage.session.set({ [sessionKey(id)]: session });

function normalizeServer(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Укажите HTTP или HTTPS адрес сервера без пароля и параметров');
  }
  return url.href.replace(/\/$/, '');
}
function mediaKey(value) {
  const url = new URL(value);
  if (url.hostname === 'youtu.be') return `youtube:${url.pathname.slice(1)}`;
  if (/(^|\.)youtube\.com$/.test(url.hostname)) {
    const id = url.searchParams.get('v') || /^\/(?:shorts|embed|live)\/([^/]+)/.exec(url.pathname)?.[1];
    if (id) return `youtube:${id}`;
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}
async function api(server, path, options = {}) {
  const start = Date.now();
  const response = await fetch(`${server}${path}`, { ...options, cache: 'no-store', signal: AbortSignal.timeout(24_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Ошибка сервера: ${response.status}`);
  return { ...result, clockOffset: result.serverTime ? result.serverTime - (start + Date.now()) / 2 : 0 };
}
function selectedFrame(tabId) {
  const frames = candidates.get(tabId);
  if (!frames) return null;
  const eligible = [...frames].filter(([, value]) => Date.now() - value.at < 6500 && value.area > 0);
  eligible.sort((a, b) => b[1].area - a[1].area);
  return eligible[0]?.[0] ?? null;
}
async function deliver(tabId, message) {
  const frameId = selectedFrame(tabId);
  if (frameId === null) return;
  try { await chrome.tabs.sendMessage(tabId, message, { frameId }); } catch { /* Frame navigated. */ }
}
async function handle(message, sender) {
  // Popup requests are extension-owned; websites cannot configure connections.
  if (!sender.tab && ['CONNECT', 'DISCONNECT', 'POPUP_STATUS'].includes(message.type)) {
    const tabId = message.tabId;
    if (!Number.isInteger(tabId)) throw new Error('Откройте вкладку с видео');
    if (message.type === 'POPUP_STATUS') return { session: await readSession(tabId), hasVideo: selectedFrame(tabId) !== null };
    if (message.type === 'DISCONNECT') {
      await chrome.storage.session.remove(sessionKey(tabId));
      await chrome.action.setBadgeText({ tabId, text: '' });
      return {};
    }
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:/.test(tab.url || '')) throw new Error('Откройте обычную страницу с видео');
    const server = normalizeServer(message.server);
    let code = message.code?.trim().toLowerCase();
    if (message.create) ({ code } = await api(server, '/rooms', { method: 'POST' }));
    if (!/^[a-f0-9]{24}$/.test(code || '')) throw new Error('Код комнаты должен содержать 24 символа');
    const snapshot = await api(server, `/rooms/${code}`);
    const session = { server, code, clientId: crypto.randomUUID(), version: snapshot.version,
      snapshot, clockOffset: snapshot.clockOffset, connectedAt: Date.now() };
    await saveSession(tabId, session);
    await chrome.storage.local.set({ server });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c6cff' });
    await chrome.action.setBadgeText({ tabId, text: 'ON' });
    await deliver(tabId, { type: 'REMOTE', snapshot, clientId: session.clientId, mediaKey: mediaKey(tab.url) });
    return { session };
  }
  const tabId = sender.tab?.id;
  if (tabId === undefined) return {};
  if (message.type === 'REPORT') {
    if (!candidates.has(tabId)) candidates.set(tabId, new Map());
    candidates.get(tabId).set(sender.frameId, { area: Math.max(0, Number(message.area) || 0), at: Date.now() });
    const session = await readSession(tabId);
    const chosen = selectedFrame(tabId) === sender.frameId;
    return { selected: chosen, session: session ? { clientId: session.clientId, snapshot: session.snapshot,
      mediaKey: mediaKey(sender.tab.url), code: session.code } : null };
  }
  if (message.type === 'POLL' && sender.frameId === 0) {
    const session = await readSession(tabId);
    if (!session) return { connected: false };
    const snapshot = await api(session.server, `/rooms/${session.code}/events?after=${session.version}`);
    // A room switch while polling must never restore the old room.
    const current = await readSession(tabId);
    if (!current || current.clientId !== session.clientId) return { connected: false };
    if (snapshot.version >= current.version) {
      // Long polls include server waiting time. Estimate clock offset from a short request instead.
      snapshot.clockOffset = current.clockOffset;
      current.snapshot = snapshot;
      current.version = snapshot.version;
      await saveSession(tabId, current);
      const tab = await chrome.tabs.get(tabId);
      await deliver(tabId, { type: 'REMOTE', snapshot, clientId: current.clientId, mediaKey: mediaKey(tab.url) });
    }
    return { connected: true };
  }
  if (message.type === 'COMMAND') {
    if (selectedFrame(tabId) !== sender.frameId) return {};
    const connection = await readSession(tabId);
    if (!connection || message.clientId !== connection.clientId) return {};
    // Serialize requests so a slow play request cannot overwrite a later pause/seek.
    const previous = commandQueues.get(tabId) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const session = await readSession(tabId);
      if (!session || session.clientId !== connection.clientId) return {};
      const payload = { ...message.state, kind: message.kind, clientId: session.clientId, mediaKey: mediaKey(sender.tab.url) };
      const snapshot = await api(session.server, `/rooms/${session.code}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      return { snapshot };
    });
    commandQueues.set(tabId, task);
    try { return await task; } finally { if (commandQueues.get(tabId) === task) commandQueues.delete(tabId); }
  }
  return {};
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  candidates.delete(tabId);
  chrome.storage.session.remove(sessionKey(tabId));
});
