'use strict';

// EdcWatch relay server for Node (local development, tests, self-hosting).
// The room logic lives in ../shared/room-core.js and is shared with the
// Cloudflare Worker in ../worker, which is what you deploy for free.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { RoomCore, ALPHABET, ROOM_RE, parseHttpUrl } = require('../shared/room-core');

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/join.js': ['join.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function randomRoomId() {
  let id = '';
  for (let i = 0; i < 6; i++) id += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return id;
}

function createApp(opts = {}) {
  const cfg = {
    maxMembers: opts.maxMembers ?? Number(process.env.MAX_MEMBERS || 8),
    holdTimeoutMs: opts.holdTimeoutMs ?? 20_000,
    emptyTtlMs: opts.emptyTtlMs ?? 6 * 3600_000,
    unusedTtlMs: opts.unusedTtlMs ?? 2 * 3600_000,
    maxRooms: opts.maxRooms ?? 5000,
    createLimitPerHour: opts.createLimitPerHour ?? Number(process.env.CREATE_LIMIT_PER_HOUR || 30),
    publicUrl: opts.publicUrl ?? process.env.PUBLIC_URL ?? '',
    trustProxy: opts.trustProxy ?? process.env.TRUST_PROXY !== '0',
    heartbeatMs: opts.heartbeatMs ?? 30_000,
    log: opts.log ?? (process.env.QUIET ? () => {} : (...a) => console.log(new Date().toISOString(), ...a)),
  };

  /** @type {Map<string, RoomCore>} */
  const rooms = new Map();
  const createCounts = new Map(); // ip -> { n, resetAt }

  const files = new Map();
  for (const [route, [file, type]] of Object.entries(STATIC)) {
    files.set(route, { body: fs.readFileSync(path.join(PUBLIC_DIR, file)), type });
  }

  function createRoom(url) {
    let id;
    do id = randomRoomId();
    while (rooms.has(id));
    const room = new RoomCore({ id, url, maxMembers: cfg.maxMembers, holdTimeoutMs: cfg.holdTimeoutMs, log: cfg.log });
    rooms.set(id, room);
    return room;
  }

  // ------------------------------------------------------------ websocket

  function attachSocket(ws) {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    const conn = { send: (s) => ws.readyState === ws.OPEN && ws.send(s), close: (code, reason) => ws.close(code, reason) };
    let joined = null; // { room, member }
    let burst = 0;
    const burstTimer = setInterval(() => (burst = 0), 1000);
    const joinTimer = setTimeout(() => !joined && ws.close(4000, 'join-timeout'), 5000);

    ws.on('message', (data) => {
      if (++burst > 60) return; // flood protection
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (!joined) {
        if (msg.t !== 'join') return;
        const room = ROOM_RE.test(msg.room) ? rooms.get(msg.room) : null;
        if (!room) {
          conn.send(JSON.stringify({ t: 'error', code: 'room-not-found' }));
          ws.close(4004, 'room-not-found');
          return;
        }
        const member = room.join(conn, msg);
        if (member) {
          joined = { room, member };
          clearTimeout(joinTimer);
        }
        return;
      }
      joined.room.handle(joined.member, msg);
    });

    ws.on('close', () => {
      clearInterval(burstTimer);
      clearTimeout(joinTimer);
      if (joined) joined.room.leave(joined.member);
    });
    ws.on('error', () => {});
  }

  // ----------------------------------------------------------------- http

  function clientIp(req) {
    if (cfg.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function allowCreate(ip) {
    const now = Date.now();
    let e = createCounts.get(ip);
    if (!e || e.resetAt < now) e = { n: 0, resetAt: now + 3600_000 };
    createCounts.set(ip, e);
    return ++e.n <= cfg.createLimitPerHour;
  }

  function baseUrl(req) {
    if (cfg.publicUrl) return cfg.publicUrl.replace(/\/+$/, '');
    const proto = (cfg.trustProxy && req.headers['x-forwarded-proto']) || 'http';
    return `${String(proto).split(',')[0]}://${req.headers.host}`;
  }

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(body));
  }

  function readJson(req, limit = 8192) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('too-large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }

  function sendPage(res, file) {
    res.writeHead(200, {
      'content-type': file.type,
      'content-security-policy': CSP,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
    });
    res.end(file.body);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      });
      return res.end();
    }

    if (req.method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true, rooms: rooms.size });

    if (req.method === 'POST' && p === '/api/rooms') {
      if (!allowCreate(clientIp(req))) return sendJson(res, 429, { error: 'rate-limited' });
      if (rooms.size >= cfg.maxRooms) return sendJson(res, 503, { error: 'busy' });
      let body;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'bad-json' });
      }
      const u = parseHttpUrl(body.url);
      if (!u) return sendJson(res, 400, { error: 'bad-url' });
      const room = createRoom(u.href);
      cfg.log(`room ${room.id} created for ${u.origin}`);
      return sendJson(res, 201, { room: room.id, url: room.url, link: `${baseUrl(req)}/j/${room.id}` });
    }

    const m = p.match(/^\/api\/rooms\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const room = ROOM_RE.test(m[1]) ? rooms.get(m[1]) : null;
      if (!room) return sendJson(res, 404, { error: 'room-not-found' });
      return sendJson(res, 200, room.info());
    }

    if (req.method === 'GET') {
      if (/^\/j\/[^/]+$/.test(p)) return sendPage(res, files.get('/'));
      const file = files.get(p);
      if (file) return sendPage(res, file);
    }

    sendJson(res, 404, { error: 'not-found' });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  wss.on('connection', attachSocket);
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // ------------------------------------------------------------ housekeeping

  const timers = [
    setInterval(() => {
      for (const ws of wss.clients) {
        if (!ws.isAlive) ws.terminate();
        else {
          ws.isAlive = false;
          ws.ping();
        }
      }
    }, cfg.heartbeatMs),
    setInterval(() => {
      const now = Date.now();
      for (const [id, room] of rooms) {
        if (room.members.size > 0) continue;
        const ttl = room.everJoined ? cfg.emptyTtlMs : cfg.unusedTtlMs;
        if (now - room.emptySince > ttl) {
          room.destroy();
          rooms.delete(id);
        }
      }
      for (const [ip, e] of createCounts) if (e.resetAt < now) createCounts.delete(ip);
    }, 60_000),
  ];
  for (const t of timers) t.unref();

  return {
    server,
    rooms,
    listen: (port, host) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () =>
      new Promise((resolve) => {
        timers.forEach(clearInterval);
        for (const r of rooms.values()) r.destroy();
        for (const ws of wss.clients) ws.terminate();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const app = createApp();
  app.listen(port, process.env.HOST || '0.0.0.0').then((p) => console.log(`EdcWatch server listening on :${p}`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
}
