import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function player({ snapshot, key = 'youtube:one', blocked = false } = {}) {
  let listener;
  let report;
  let current = 0;
  let paused = true;
  let rate = 1;
  const events = {};
  const commands = [];
  const labels = [];
  const elements = [];
  const timers = new Map();
  let timerId = 0;
  const session = { code: 'room', clientId: 'local', mediaKey: key, snapshot };
  const video = {
    readyState: 4, seeking: false, duration: 1000,
    get currentTime() { return current; },
    set currentTime(value) { current = value; events.seeked?.({ type: 'seeked' }); },
    get paused() { return paused; },
    get playbackRate() { return rate; },
    set playbackRate(value) { rate = value; events.ratechange?.({ type: 'ratechange' }); },
    async play() {
      if (blocked) throw Object.assign(new Error('Blocked'), { name: 'NotAllowedError' });
      paused = false; events.play?.({ type: 'play' });
    },
    pause() { paused = true; events.pause?.({ type: 'pause' }); },
    closest: () => null,
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
    addEventListener: (type, fn) => { events[type] = fn; },
    removeEventListener: type => { delete events[type]; }
  };
  const element = tag => {
    const node = { tag, style: {}, append() {}, attachShadow: () => ({ append() {} }),
      get textContent() { return this.text; },
      set textContent(text) { this.text = text; labels.push(text); } };
    elements.push(node);
    return node;
  };
  const context = vm.createContext({
    chrome: { runtime: {
      sendMessage: async message => {
        if (message.type === 'REPORT') return { ok: true, selected: true, session };
        if (message.type === 'COMMAND') { commands.push(message); return { ok: true }; }
      },
      onMessage: { addListener: fn => { listener = fn; } }
    } },
    document: { querySelectorAll: () => [video], createElement: element, documentElement: { append() {} } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    window: { top: {} }, Date,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
    setInterval: fn => { report = fn; }
  });
  vm.runInContext(script, context);
  await tick();
  return { video, commands, labels, elements, timers, report, remote: async value => {
    listener({ type: 'REMOTE', snapshot: value, clientId: 'local', mediaKey: key });
    await tick();
  } };
}
function remote(extra = {}) {
  return { version: 1, clockOffset: 0, state: { clientId: 'other', mediaKey: 'youtube:one', paused: true,
    time: 100, rate: 1, updatedAt: Date.now(), ...extra } };
}

test('remote seek/play/rate applies without echoing local events', async () => {
  const p = await player({ snapshot: remote({ paused: false, rate: 1.5 }) });
  assert.equal(p.video.paused, false);
  assert.ok(Math.abs(p.video.currentTime - 100) < 1);
  assert.equal(p.video.playbackRate, 1.5);
  assert.equal(p.commands.length, 0);
  await p.remote(remote({ paused: true, time: 22 }));
  assert.equal(p.video.paused, true);
  assert.equal(p.video.currentTime, 22);
  assert.equal(p.commands.length, 0);
});

test('another video is never seeked or started', async () => {
  const p = await player({ snapshot: remote({ mediaKey: 'youtube:two', paused: false }) });
  assert.equal(p.video.currentTime, 0);
  assert.equal(p.video.paused, true);
  assert.ok(p.labels.some(text => text.includes('другое видео')));
});

test('autoplay rejection surfaces a user action', async () => {
  const p = await player({ snapshot: remote({ paused: false }), blocked: true });
  assert.equal(p.video.paused, true);
  assert.ok(p.labels.some(text => text.includes('нажатия')));
});

test('empty room publishes the initial player state', async () => {
  const p = await player({ snapshot: { version: 0, state: null } });
  assert.equal(p.commands.length, 1);
  assert.equal(p.commands[0].state.paused, true);
  assert.equal(p.commands[0].clientId, 'local');
});

test('successful sync hides the autoplay button and notice expires without returning on polling', async () => {
  const p = await player({ snapshot: remote() });
  const banner = p.elements[0];
  const resume = p.elements.find(node => node.textContent === 'Разрешить воспроизведение');
  assert.equal(resume.hidden, true);
  assert.equal(resume.style.display, 'none');
  const timer = [...p.timers.values()].find(item => item.ms === 3500);
  assert.ok(timer);
  timer.fn();
  assert.equal(banner.style.display, 'none');
  await p.report();
  assert.equal(banner.style.display, 'none');
});

test('autoplay notice can be dismissed and is cleared after playback succeeds', async () => {
  const p = await player({ snapshot: remote({ paused: false }), blocked: true });
  const banner = p.elements[0];
  const resume = p.elements.find(node => node.textContent === 'Разрешить воспроизведение');
  const close = p.elements.find(node => node.title === 'Скрыть уведомление');
  assert.equal(resume.style.display, 'block');
  assert.ok([...p.timers.values()].some(item => item.ms === 8000));
  close.onclick();
  await p.report();
  assert.equal(banner.style.display, 'none');
  await p.remote(remote({ paused: true }));
  assert.equal(resume.hidden, true);
  assert.equal(resume.style.display, 'none');
});
