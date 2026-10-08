// EdcWatch relay on Cloudflare Workers.
//
//   /api/rooms        POST  create a room        -> { room, url, link }
//   /api/rooms/:id    GET   room info            -> { room, url, members }
//   /ws?room=ID       WebSocket into the room's Durable Object
//   /j/:id            invite page (static, see ../server/public)
//
// Same protocol and room logic as the Node server (../shared/room-core.js).

import core from '../../shared/room-core.js';

const { RoomCore, ALPHABET, ROOM_RE, parseHttpUrl } = core;

const EMPTY_TTL_MS = 6 * 3600_000; // forget a room 6h after the last person left
const UNUSED_TTL_MS = 2 * 3600_000; // ... or 2h after creation if nobody ever joined

const CORS = { 'access-control-allow-origin': '*' };

const PAGE_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-cache',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  });

function randomRoomId() {
  let id = '';
  const limit = 256 - (256 % ALPHABET.length); // rejection sampling: no modulo bias
  while (id.length < 6) {
    for (const b of crypto.getRandomValues(new Uint8Array(12))) {
      if (b < limit && id.length < 6) id += ALPHABET[b % ALPHABET.length];
    }
  }
  return id;
}

const roomStub = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));

function withPageHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(PAGE_HEADERS)) out.headers.set(k, v);
  return out;
}

/** A socket that only delivers an error and closes, so clients see the same thing as with the Node server. */
function rejectSocket(code, reason) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.send(JSON.stringify({ t: 'error', code: reason }));
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

async function createRoom(request, env, url) {
  let body;
  try {
    const text = await request.text();
    if (text.length > 8192) return json({ error: 'bad-json' }, 400);
    body = JSON.parse(text || '{}');
  } catch {
    return json({ error: 'bad-json' }, 400);
  }
  const target = parseHttpUrl(body.url);
  if (!target) return json({ error: 'bad-url' }, 400);

  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomRoomId();
    const res = await roomStub(env, id).fetch('https://room/init', {
      method: 'POST',
      body: JSON.stringify({ id, url: target.href }),
    });
    if (res.status === 201) {
      const base = (env.PUBLIC_URL || url.origin).replace(/\/+$/, '');
      return json({ room: id, url: target.href, link: `${base}/j/${id}` }, 201);
    }
  }
  return json({ error: 'busy' }, 503);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        },
      });
    }

    if (p === '/healthz') return json({ ok: true });

    if (p === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
      const room = url.searchParams.get('room') || '';
      if (!ROOM_RE.test(room)) return rejectSocket(4004, 'room-not-found');
      return roomStub(env, room).fetch(request);
    }

    if (request.method === 'POST' && p === '/api/rooms') return createRoom(request, env, url);

    const m = p.match(/^\/api\/rooms\/([^/]+)$/);
    if (request.method === 'GET' && m) {
      if (!ROOM_RE.test(m[1])) return json({ error: 'room-not-found' }, 404);
      const res = await roomStub(env, m[1]).fetch('https://room/info');
      return res.ok ? json(await res.json()) : json({ error: 'room-not-found' }, 404);
    }

    if (request.method === 'GET' && /^\/j\/[^/]+$/.test(p)) {
      return withPageHeaders(await env.ASSETS.fetch(new Request(new URL('/', url), request)));
    }

    const asset = await env.ASSETS.fetch(request);
    return asset.status === 404 ? json({ error: 'not-found' }, 404) : withPageHeaders(asset);
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.core = null;
    ctx.blockConcurrencyWhile(async () => {
      const meta = await ctx.storage.get('meta');
      if (meta) this.core = this.makeCore(meta);
    });
  }

  makeCore(meta) {
    return new RoomCore({
      id: meta.id,
      url: meta.url,
      onUrlChange: (next) => this.ctx.storage.put('meta', { id: meta.id, url: next }),
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init') {
      if (this.core) return new Response('exists', { status: 409 });
      const meta = await request.json();
      await this.ctx.storage.put('meta', meta);
      this.core = this.makeCore(meta);
      await this.ctx.storage.setAlarm(Date.now() + UNUSED_TTL_MS);
      return new Response(null, { status: 201 });
    }

    if (url.pathname === '/info') {
      return this.core ? Response.json(this.core.info()) : new Response('gone', { status: 404 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.attach(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  attach(ws) {
    const room = this.core;
    if (!room) {
      ws.send(JSON.stringify({ t: 'error', code: 'room-not-found' }));
      ws.close(4004, 'room-not-found');
      return;
    }

    const conn = { send: (s) => ws.send(s), close: (code, reason) => ws.close(code, reason) };
    let member = null;
    let burst = 0;
    const burstTimer = setInterval(() => (burst = 0), 1000);
    const joinTimer = setTimeout(() => {
      if (!member) ws.close(4000, 'join-timeout');
    }, 5000);

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string' || ev.data.length > 16384 || ++burst > 60) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (!member) {
        if (msg.t !== 'join') return;
        member = room.join(conn, msg);
        if (member) {
          clearTimeout(joinTimer);
          this.ctx.storage.deleteAlarm();
        }
        return;
      }
      room.handle(member, msg);
    });

    const done = () => {
      clearInterval(burstTimer);
      clearTimeout(joinTimer);
      if (!member) return;
      room.leave(member);
      member = null;
      if (room.members.size === 0) this.ctx.storage.setAlarm(Date.now() + EMPTY_TTL_MS);
    };
    ws.addEventListener('close', (ev) => {
      done();
      try {
        // complete the closing handshake (1005/1006 are reserved and cannot be sent)
        ws.close(ev.code && ev.code !== 1005 && ev.code !== 1006 ? ev.code : 1000, 'bye');
      } catch {}
    });
    ws.addEventListener('error', done);
  }

  // Nobody has been in the room for a long time: forget it.
  async alarm() {
    if (this.core && this.core.members.size > 0) return;
    this.core?.destroy();
    this.core = null;
    await this.ctx.storage.deleteAll();
  }
}
