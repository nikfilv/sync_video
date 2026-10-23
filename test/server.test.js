import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncServer } from '../server/index.js';

async function setup(t, options) {
  const server = createSyncServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, data) => {
    const response = await fetch(root + path, data === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    return { status: response.status, data: await response.json() };
  };
  const { data: { code } } = await call('/rooms', {});
  return { call, code };
}
const control = (extra = {}) => ({ clientId: 'alice', mediaKey: 'youtube:example', paused: false,
  time: 12, rate: 1, kind: 'control', ...extra });

test('two clients receive play, pause, seek and playback rate updates', async t => {
  const { call, code } = await setup(t);
  assert.match(code, /^[a-f0-9]{24}$/);
  for (const [index, change] of [{}, { paused: true }, { time: 77 }, { paused: false, rate: 1.5 }].entries()) {
    const waiting = call(`/rooms/${code}/events?after=${index}`);
    const sent = await call(`/rooms/${code}`, control(change));
    const received = await waiting;
    assert.equal(received.status, 200);
    assert.equal(received.data.version, index + 1);
    assert.deepEqual(received.data.state, sent.data.state);
    assert.equal(received.data.state.time, change.time ?? 12);
  }
});

test('last controller wins; old controller heartbeat cannot overwrite it', async t => {
  const { call, code } = await setup(t);
  await call(`/rooms/${code}`, control());
  await call(`/rooms/${code}`, control({ clientId: 'bob', paused: true, time: 90 }));
  const stale = await call(`/rooms/${code}`, control({ kind: 'heartbeat', time: 15 }));
  assert.equal(stale.data.version, 2);
  assert.equal(stale.data.state.clientId, 'bob');
  assert.equal(stale.data.state.time, 90);
  const fresh = await call(`/rooms/${code}`, control({ kind: 'heartbeat', clientId: 'bob', time: 91 }));
  assert.equal(fresh.data.version, 3);
});

test('joining late returns current state; rooms are isolated', async t => {
  const { call, code } = await setup(t);
  await call(`/rooms/${code}`, control({ time: 100 }));
  const late = await call(`/rooms/${code}`);
  assert.equal(late.data.state.time, 100);
  const other = await call('/rooms', {});
  const empty = await call(`/rooms/${other.data.code}`);
  assert.equal(empty.data.state, null);
  assert.equal(empty.data.version, 0);
});

test('invalid state and missing rooms are rejected without changing state', async t => {
  const { call, code } = await setup(t);
  for (const change of [{ time: -1 }, { time: '12' }, { rate: 0 }, { paused: 'yes' }, { kind: 'wrong' }, { mediaKey: '' }]) {
    assert.equal((await call(`/rooms/${code}`, control(change))).status, 400);
  }
  assert.equal((await call(`/rooms/${code}`)).data.version, 0);
  assert.equal((await call(`/rooms/${'0'.repeat(24)}`)).status, 404);
  assert.equal((await call(`/rooms/${code}/events?after=-1`)).status, 400);
});

test('long poll times out cleanly with current version', async t => {
  const { call, code } = await setup(t, { pollTimeout: 30 });
  const result = await call(`/rooms/${code}/events?after=0`);
  assert.equal(result.data.version, 0);
  assert.equal(result.data.state, null);
});

test('expired rooms cannot be joined; room capacity is bounded', async t => {
  let clock = 1000;
  const { call, code } = await setup(t, { now: () => clock, maxRooms: 1 });
  assert.equal((await call('/rooms', {})).status, 503);
  clock += 24 * 60 * 60 * 1000 + 1;
  assert.equal((await call(`/rooms/${code}`)).status, 404);
});
