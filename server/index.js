import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOM_TTL = 24 * 60 * 60 * 1000;
const CODE = /^[a-f0-9]{24}$/;

export function createSyncServer({ now = Date.now, pollTimeout = 20_000, maxRooms = 1000 } = {}) {
  const rooms = new Map();
  const requests = new Map();
  function reply(res, status, data) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  function snapshot(room) {
    return { version: room.version, state: room.state, serverTime: now() };
  }
  function flush(room) {
    for (const finish of [...room.waiters]) finish();
  }
  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw new Error('Тело запроса слишком большое');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  }
  const server = http.createServer(async (req, res) => {
    try {
      const ip = req.socket.remoteAddress;
      const stamp = now();
      let bucket = requests.get(ip);
      if (!bucket || stamp - bucket.start > 60_000) {
        bucket = { start: stamp, count: 0 };
        requests.set(ip, bucket);
      }
      if (++bucket.count > 600) return reply(res, 429, { error: 'Слишком много запросов. Подождите минуту.' });
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/rooms') {
        if (rooms.size >= maxRooms) return reply(res, 503, { error: 'Сервер заполнен. Попробуйте позднее.' });
        const code = randomBytes(12).toString('hex');
        rooms.set(code, { version: 0, state: null, touched: stamp, waiters: new Set() });
        return reply(res, 201, { code });
      }
      const match = /^\/rooms\/([a-f0-9]{24})(\/events)?$/.exec(url.pathname);
      if (!match || !CODE.test(match[1])) return reply(res, 404, { error: 'Адрес не найден' });
      const room = rooms.get(match[1]);
      if (!room || stamp - room.touched > ROOM_TTL) return reply(res, 404, { error: 'Комната не найдена или срок её действия истёк' });
      room.touched = stamp;
      if (req.method === 'GET' && !match[2]) return reply(res, 200, snapshot(room));
      if (req.method === 'GET' && match[2]) {
        const after = Number(url.searchParams.get('after'));
        if (!Number.isSafeInteger(after) || after < 0) return reply(res, 400, { error: 'Некорректная версия' });
        if (after !== room.version) return reply(res, 200, snapshot(room));
        if (room.waiters.size >= 50) return reply(res, 429, { error: 'Слишком много подключений к комнате' });
        const finish = () => {
          clearTimeout(timer);
          room.waiters.delete(finish);
          reply(res, 200, snapshot(room));
        };
        const timer = setTimeout(finish, pollTimeout);
        room.waiters.add(finish);
        res.on('close', () => { clearTimeout(timer); room.waiters.delete(finish); });
        return;
      }
      if (req.method === 'POST' && !match[2]) {
        const data = await body(req);
        if (typeof data.clientId !== 'string' || data.clientId.length > 80 || !data.clientId ||
            typeof data.mediaKey !== 'string' || !data.mediaKey || data.mediaKey.length > 2048 ||
            typeof data.paused !== 'boolean' || !Number.isFinite(data.time) || data.time < 0 || data.time > 1e9 ||
            !Number.isFinite(data.rate) || data.rate < 0.25 || data.rate > 4 ||
            !['control', 'heartbeat'].includes(data.kind)) {
          return reply(res, 400, { error: 'Некорректное состояние видео' });
        }
        // Only the last person to use the player can publish periodic corrections.
        if (data.kind === 'heartbeat' && room.state?.clientId !== data.clientId) return reply(res, 200, snapshot(room));
        room.state = { clientId: data.clientId, mediaKey: data.mediaKey, paused: data.paused,
          time: data.time, rate: data.rate, updatedAt: now() };
        room.version++;
        flush(room);
        return reply(res, 200, snapshot(room));
      }
      reply(res, 405, { error: 'Метод не поддерживается' });
    } catch {
      reply(res, 400, { error: 'Не удалось прочитать запрос' });
    }
  });
  const cleanup = setInterval(() => {
    for (const [code, room] of rooms) {
      if (now() - room.touched > ROOM_TTL) { flush(room); rooms.delete(code); }
    }
    for (const [ip, bucket] of requests) if (now() - bucket.start > 60_000) requests.delete(ip);
  }, 60_000);
  cleanup.unref();
  server.on('close', () => clearInterval(cleanup));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  createSyncServer().listen(port, host, () => console.log(`Sync Video: http://${host}:${port}`));
}
