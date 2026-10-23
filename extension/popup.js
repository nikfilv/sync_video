const $ = id => document.getElementById(id);
let tabId;
function show(session) {
  $('connected').hidden = !session;
  $('disconnected').hidden = Boolean(session);
  $('server').disabled = Boolean(session);
  if (session) { $('share-code').value = session.code; $('server').value = session.server; }
}
async function request(data) {
  const result = await chrome.runtime.sendMessage({ ...data, tabId });
  if (!result.ok) throw new Error(result.error);
  return result;
}
async function busy(action) {
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  $('message').textContent = '';
  try { await action(); }
  catch (error) { $('message').textContent = error.message === 'Failed to fetch' ? 'Сервер недоступен. Проверьте адрес и запустите сервер синхронизации.' : error.message; }
  finally { for (const button of document.querySelectorAll('button')) button.disabled = false; }
}
async function connect(create) {
  const result = await request({ type: 'CONNECT', create, server: $('server').value.trim(), code: $('code').value });
  show(result.session);
  $('message').textContent = 'Если видео не реагирует, обновите страницу и нажмите Play один раз.';
}
$('create').onclick = () => busy(() => connect(true));
$('join').onclick = () => busy(() => connect(false));
$('leave').onclick = () => busy(async () => { await request({ type: 'DISCONNECT' }); show(null); });
$('copy').onclick = () => busy(async () => {
  try { await navigator.clipboard.writeText($('share-code').value); $('message').textContent = 'Код скопирован'; }
  catch { $('share-code').select(); $('message').textContent = 'Нажмите Ctrl+C, чтобы скопировать код'; }
});
$('code').addEventListener('keydown', event => { if (event.key === 'Enter') $('join').click(); });
busy(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  const saved = await chrome.storage.local.get('server');
  if (saved.server) $('server').value = saved.server;
  const result = await request({ type: 'POPUP_STATUS' });
  show(result.session);
  if (result.session && !result.hasVideo) $('message').textContent = 'Видео пока не найдено. Запустите его или обновите страницу.';
});
