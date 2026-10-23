import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createSyncServer } from '../server/index.js';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
async function browser(t, { delayFirstCommand = false } = {}) {
  const server = createSyncServer({ pollTimeout: 40 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = `http://127.0.0.1:${server.address().port}`;
  let listener;
  const deliveries = [];
  const memory = {};
  let inFlight = 0;
  let maxInFlight = 0;
  let commandCount = 0;
  const storage = {
    get: async key => structuredClone({ [key]: memory[key] }),
    set: async data => Object.assign(memory, structuredClone(data)),
    remove: async key => { delete memory[key]; }
  };
  const tabs = new Map([[1, { id: 1, url: 'https://www.youtube.com/watch?v=one&utm_source=test' }],
    [2, { id: 2, url: 'https://www.youtube.com/watch?v=one&t=30' }]]);
  vm.runInNewContext(source, {
    chrome: {
      storage: { session: storage, local: storage },
      runtime: { onMessage: { addListener: fn => { listener = fn; } } },
      tabs: { get: async id => tabs.get(id), onRemoved: { addListener() {} },
        sendMessage: async (tabId, message, options) => { deliveries.push({ tabId, message, options }); } },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
    },
    fetch: async (url, options) => {
      const command = options?.method === 'POST' && !url.endsWith('/rooms');
      if (command) { inFlight++; commandCount++; maxInFlight = Math.max(maxInFlight, inFlight); }
      try {
        if (command && commandCount === 1 && delayFirstCommand) await new Promise(resolve => setTimeout(resolve, 30));
        return await fetch(url, options);
      } finally { if (command) inFlight--; }
    },
    crypto: globalThis.crypto, URL, AbortSignal, Date, Map, Promise
  });
  const send = (message, tabId, frameId = 0) => new Promise(resolve => listener(message,
    tabId ? { tab: tabs.get(tabId), frameId } : {}, resolve));
  const connect = async (tabId, code) => send({ type: 'CONNECT', tabId, server: address, create: !code, code });
  return { send, connect, deliveries, memory, getMaxInFlight: () => maxInFlight };
}

test('extension bridges two tabs and chooses the largest frame', async t => {
  const b = await browser(t);
  await b.send({ type: 'REPORT', area: 10 }, 1, 0);
  await b.send({ type: 'REPORT', area: 1000 }, 1, 3);
  await b.send({ type: 'REPORT', area: 100 }, 2, 0);
  const first = await b.connect(1);
  assert.equal(first.ok, true);
  const second = await b.connect(2, first.session.code);
  assert.equal(second.ok, true);
  const state = { paused: true, time: 80, rate: 1.25 };
  const ignored = await b.send({ type: 'COMMAND', clientId: first.session.clientId, kind: 'control', state }, 1, 0);
  assert.equal(ignored.snapshot, undefined);
  const waiting = b.send({ type: 'POLL' }, 2, 0);
  const sent = await b.send({ type: 'COMMAND', clientId: first.session.clientId, kind: 'control', state }, 1, 3);
  assert.equal(sent.ok, true);
  assert.equal(sent.snapshot.state.mediaKey, 'youtube:one');
  await waiting;
  const remote = b.deliveries.findLast(item => item.tabId === 2);
  assert.equal(remote.message.snapshot.state.time, 80);
  assert.equal(remote.options.frameId, 0);
  assert.equal(b.memory['tab:2'].version, 1);
});

test('extension serializes commands so final pause wins over a slow play request', async t => {
  const b = await browser(t, { delayFirstCommand: true });
  await b.send({ type: 'REPORT', area: 100 }, 1);
  const joined = await b.connect(1);
  const command = paused => b.send({ type: 'COMMAND', clientId: joined.session.clientId, kind: 'control',
    state: { paused, time: 8, rate: 1 } }, 1);
  const [play, pause] = await Promise.all([command(false), command(true)]);
  assert.equal(play.snapshot.version, 1);
  assert.equal(pause.snapshot.version, 2);
  assert.equal(pause.snapshot.state.paused, true);
  assert.equal(b.getMaxInFlight(), 1);
});

test('leaving or switching rooms rejects old client commands and polls', async t => {
  const b = await browser(t);
  await b.send({ type: 'REPORT', area: 100 }, 1);
  const old = await b.connect(1);
  const pending = b.send({ type: 'POLL' }, 1);
  const joined = await b.connect(1);
  const oldCommand = await b.send({ type: 'COMMAND', clientId: old.session.clientId, kind: 'control',
    state: { paused: false, time: 40, rate: 1 } }, 1);
  assert.equal(oldCommand.snapshot, undefined);
  await pending;
  assert.equal(b.memory['tab:1'].clientId, joined.session.clientId);
  await b.send({ type: 'DISCONNECT', tabId: 1 });
  assert.equal((await b.send({ type: 'POLL' }, 1)).connected, false);
  assert.equal(b.memory['tab:1'], undefined);
});
