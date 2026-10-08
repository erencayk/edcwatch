'use strict';

process.env.QUIET = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createApp } = require('../server');

// EDC_TEST_URL=http://127.0.0.1:8788 runs the very same tests against a running
// server (e.g. `wrangler dev` for the Cloudflare Worker). Tests that need to
// configure the server are skipped there.
const EXTERNAL = process.env.EDC_TEST_URL ? new URL(process.env.EDC_TEST_URL) : null;
const needsConfig = { skip: EXTERNAL ? 'needs server configuration' : false };

async function start(opts = {}) {
  if (EXTERNAL) {
    const base = EXTERNAL.origin;
    const post = (p, body) =>
      fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { app: { close: async () => {} }, port: Number(EXTERNAL.port), base, post };
  }
  const app = createApp({ ...opts });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, port, base, post };
}

// Minimal client with a message queue and "wait for a message matching X".
const openSockets = new Set();
test.after(() => openSockets.forEach((ws) => ws.terminate())); // lets the process exit when testing an external server

function client(port, room = 'ZZZZZZ') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}`);
  openSockets.add(ws);
  ws.on('close', () => openSockets.delete(ws));
  const queue = [];
  const waiters = [];
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  const opened = new Promise((r) => ws.on('open', r));
  return {
    ws,
    closed,
    opened,
    send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)),
    next(pred = () => true, ms = 1500) {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const j = waiters.indexOf(w);
          if (j >= 0) {
            waiters.splice(j, 1);
            reject(new Error('timeout waiting for message'));
          }
        }, ms);
      });
    },
    has: (pred) => queue.some(pred),
    close: () => ws.close(),
  };
}

async function joined(port, room, id, name) {
  const c = client(port, room);
  await c.opened;
  c.send({ t: 'join', room, id, name });
  const welcome = await c.next((m) => m.t === 'welcome');
  return { c, welcome };
}

const ID_A = 'client-aaaaaaaa';
const ID_B = 'client-bbbbbbbb';
const ID_C = 'client-cccccccc';

test('HTTP: create room, read it back, validate input', async (t) => {
  const { app, post, base } = await start();
  t.after(() => app.close());

  const res = await post('/api/rooms', { url: 'https://example.com/film/1' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.room, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(body.link, `${base}/j/${body.room}`);

  const info = await (await fetch(`${base}/api/rooms/${body.room}`)).json();
  assert.equal(info.url, 'https://example.com/film/1');
  assert.equal(info.members, 0);

  assert.equal((await fetch(`${base}/api/rooms/ZZZZZZ`)).status, 404);
  assert.equal((await post('/api/rooms', { url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await post('/api/rooms', { url: 'x'.repeat(3000) })).status, 400);
  assert.equal((await post('/api/rooms', {})).status, 400);
});

test('HTTP: landing page is served for invite links with a strict CSP', async (t) => {
  const { app, base } = await start();
  t.after(() => app.close());
  const res = await fetch(`${base}/j/ABCDEF`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await res.text(), /EdcWatch/);
  assert.equal((await fetch(`${base}/join.js`)).status, 200);
  assert.equal((await fetch(`${base}/../server.js`)).status, 404);
});

test('HTTP: room creation is rate limited per IP', needsConfig, async (t) => {
  const { app, post } = await start({ createLimitPerHour: 3 });
  t.after(() => app.close());
  for (let i = 0; i < 3; i++) assert.equal((await post('/api/rooms', { url: 'https://a.com/' })).status, 201);
  assert.equal((await post('/api/rooms', { url: 'https://a.com/' })).status, 429);
});

test('WS: join, welcome, members broadcast', async (t) => {
  const { app, port, post } = await start();
  t.after(() => app.close());
  const { room } = await (await post('/api/rooms', { url: 'https://example.com/a' })).json();

  const a = await joined(port, room, ID_A, 'Eren');
  assert.equal(a.welcome.room.url, 'https://example.com/a');
  assert.equal(a.welcome.state.set, false);
  assert.deepEqual(a.welcome.members.map((m) => m.name), ['Eren']);
  assert.ok(Math.abs(a.welcome.serverNow - Date.now()) < 2000);

  const b = await joined(port, room, ID_B, 'Doğa');
  const ma = await a.c.next((m) => m.t === 'members');
  assert.deepEqual(ma.list.map((m) => m.name), ['Eren', 'Doğa']);
  assert.equal(ma.joined.name, 'Doğa');

  b.c.close();
  const left = await a.c.next((m) => m.t === 'members' && m.left);
  assert.equal(left.left.name, 'Doğa');
  a.c.close();
});

test('WS: an unknown room is rejected', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());

  const c = client(port, 'ZZZZZZ');
  await c.opened;
  c.send({ t: 'join', room: 'ZZZZZZ', id: ID_A, name: 'x' });
  assert.equal((await c.next((m) => m.t === 'error')).code, 'room-not-found');
  assert.equal(await c.closed, 4004);
});

test('WS: a full room rejects further members', needsConfig, async (t) => {
  const { app, port, post } = await start({ maxMembers: 2 });
  t.after(() => app.close());
  const { room } = await (await post('/api/rooms', { url: 'https://example.com/a' })).json();
  await joined(port, room, ID_A, 'a');
  await joined(port, room, ID_B, 'b');
  const third = client(port, room);
  await third.opened;
  third.send({ t: 'join', room, id: ID_C, name: 'c' });
  assert.equal((await third.next((m) => m.t === 'error')).code, 'room-full');
});

test('WS: state is stamped with an increasing rev and sent to everybody including the sender', async (t) => {
  const { app, port, post } = await start();
  t.after(() => app.close());
  const { room } = await (await post('/api/rooms', { url: 'https://example.com/a' })).json();
  const a = await joined(port, room, ID_A, 'Eren');
  const b = await joined(port, room, ID_B, 'Doğa');

  a.c.send({ t: 'state', playing: true, position: 12.5, rate: 1, at: Date.now() });
  const sa = await a.c.next((m) => m.t === 'state');
  const sb = await b.c.next((m) => m.t === 'state');
  for (const s of [sa, sb]) {
    assert.equal(s.rev, 1);
    assert.equal(s.playing, true);
    assert.equal(s.position, 12.5);
    assert.equal(s.by, ID_A);
    assert.equal(s.byName, 'Eren');
    assert.equal(s.reason, 'user');
  }

  b.c.send({ t: 'state', playing: false, position: 30, rate: 1, at: Date.now() });
  const s2 = await a.c.next((m) => m.t === 'state');
  assert.equal(s2.rev, 2);
  assert.equal(s2.playing, false);
  assert.equal(s2.byName, 'Doğa');

  // A late joiner receives the latest state in the welcome message.
  const c = await joined(port, room, ID_C, 'Misafir');
  assert.equal(c.welcome.state.rev, 2);
  assert.equal(c.welcome.state.position, 30);
  assert.equal(c.welcome.state.set, true);
});

test('WS: hostile state values are clamped or ignored', async (t) => {
  const { app, port, post } = await start();
  t.after(() => app.close());
  const { room } = await (await post('/api/rooms', { url: 'https://example.com/a' })).json();
  const a = await joined(port, room, ID_A, 'Eren');

  a.c.send({ t: 'state', playing: 'yes', position: -50, rate: 99, at: Date.now() + 60_000 });
  const s = await a.c.next((m) => m.t === 'state');
  assert.equal(s.playing, false); // only literal true counts
  assert.equal(s.position, 0);
  assert.equal(s.rate, 4);
  assert.ok(s.at <= Date.now());

  a.c.send({ t: 'state', playing: true, position: 'NaN', rate: null, at: 'x' });
  const s2 = await a.c.next((m) => m.t === 'state');
  assert.equal(s2.position, 0);
  assert.equal(s2.rate, 1);

  a.c.ws.send('not json');
  a.c.send({ t: 'ping', c: 7 });
  assert.equal((await a.c.next((m) => m.t === 'pong')).c, 7);
});

test('WS: ping/pong returns the server clock', async (t) => {
  const { app, port, post } = await start();
  t.after(() => app.close());
  const { room } = await (await post('/api/rooms', { url: 'https://example.com/a' })).json();
  const a = await joined(port, room, ID_A, 'Eren');
  const before = Date.now();
  a.c.send({ t: 'ping', c: before });
  const pong = await a.c.next((m) => m.t === 'pong');
  assert.equal(pong.c, before);
  assert.ok(pong.s >= before && pong.s <= Date.now());
});

test('WS: buffering hold freezes the room, ready resumes it at the slow client position', async (t) => {
  const { app, port, post } = await start();
  t.after(() => app.close());
  const { room } = await (await post('/api/rooms', { url: 'https://example.com/a' })).json();
  const a = await joined(port, room, ID_A, 'Eren');
  const b = await joined(port, room, ID_B, 'Doğa');

  // No hold while the room has not started / is paused.
  b.c.send({ t: 'wait', position: 1 });
  a.c.send({ t: 'ping', c: 1 });
  await a.c.next((m) => m.t === 'pong');
  assert.equal(a.c.has((m) => m.t === 'state'), false, 'no hold before the room has started');

  a.c.send({ t: 'state', playing: true, position: 10, rate: 1, at: Date.now() });
  await b.c.next((m) => m.t === 'state');
  await a.c.next((m) => m.t === 'state');

  b.c.send({ t: 'wait', position: 11 });
  const hold = await a.c.next((m) => m.t === 'state' && m.reason === 'hold');
  assert.equal(hold.playing, false);
  assert.equal(hold.position, 11);
  assert.deepEqual(hold.hold, { names: ['Doğa'] });
  await b.c.next((m) => m.t === 'state' && m.reason === 'hold');

  b.c.send({ t: 'ready', position: 11.4 });
  const resumed = await a.c.next((m) => m.t === 'state' && m.reason === 'resume');
  assert.equal(resumed.playing, true);
  assert.equal(resumed.position, 11.4);
  assert.equal(resumed.hold, null);
  assert.ok(resumed.rev > hold.rev);
});

test('WS: with two buffering members the room resumes only when both are ready', async (t) => {
  const { app, port, post } = await start();
  t.after(() => app.close());
  const { room } = await (await post('/api/rooms', { url: 'https://example.com/a' })).json();
  const a = await joined(port, room, ID_A, 'Eren');
  const b = await joined(port, room, ID_B, 'Doğa');
  const c = await joined(port, room, ID_C, 'Misafir');

  a.c.send({ t: 'state', playing: true, position: 5, rate: 1, at: Date.now() });
  await c.c.next((m) => m.t === 'state');

  b.c.send({ t: 'wait', position: 6 });
  await c.c.next((m) => m.t === 'state' && m.reason === 'hold');
  c.c.send({ t: 'wait', position: 5.5 });
  const both = await a.c.next((m) => m.t === 'state' && m.hold && m.hold.names.length === 2);
  assert.deepEqual(both.hold.names.sort(), ['Doğa', 'Misafir']);

  b.c.send({ t: 'ready', position: 6 });
  const still = await a.c.next((m) => m.t === 'state' && m.hold && m.hold.names.length === 1);
  assert.equal(still.playing, false);

  c.c.send({ t: 'ready', position: 5.9 });
  const go = await a.c.next((m) => m.t === 'state' && m.reason === 'resume');
  assert.equal(go.playing, true);
  assert.equal(go.position, 5.9);
});

test('WS: an explicit user action ends a hold; a waiter leaving or timing out resumes the room', needsConfig, async (t) => {
  const { app, port, post } = await start({ holdTimeoutMs: 200 });
  t.after(() => app.close());
  const { room } = await (await post('/api/rooms', { url: 'https://example.com/a' })).json();
  const a = await joined(port, room, ID_A, 'Eren');
  const b = await joined(port, room, ID_B, 'Doğa');

  // user action while holding
  a.c.send({ t: 'state', playing: true, position: 5, rate: 1, at: Date.now() });
  await b.c.next((m) => m.t === 'state');
  b.c.send({ t: 'wait', position: 6 });
  await a.c.next((m) => m.reason === 'hold');
  a.c.send({ t: 'state', playing: false, position: 6, rate: 1, at: Date.now() });
  const s = await b.c.next((m) => m.reason === 'user' && m.rev >= 3);
  assert.equal(s.hold, null);

  // timeout
  a.c.send({ t: 'state', playing: true, position: 8, rate: 1, at: Date.now() });
  await a.c.next((m) => m.reason === 'user' && m.playing === true);
  b.c.send({ t: 'wait', position: 9 });
  await a.c.next((m) => m.reason === 'hold');
  const to = await a.c.next((m) => m.reason === 'hold-timeout');
  assert.equal(to.playing, true);
  assert.equal(to.position, 9);

  // waiter disconnects
  b.c.send({ t: 'wait', position: 10 });
  await a.c.next((m) => m.reason === 'hold');
  b.c.close();
  const after = await a.c.next((m) => m.reason === 'resume' || m.reason === 'hold-timeout');
  assert.equal(after.playing, true);
});

test('WS: nav is relayed to the others for the same site only', async (t) => {
  const { app, port, post } = await start();
  t.after(() => app.close());
  const { room } = await (await post('/api/rooms', { url: 'https://example.com/ep1' })).json();
  const a = await joined(port, room, ID_A, 'Eren');
  const b = await joined(port, room, ID_B, 'Doğa');

  a.c.send({ t: 'nav', url: 'https://evil.example.org/x' });
  a.c.send({ t: 'nav', url: 'javascript:alert(1)' });
  a.c.send({ t: 'nav', url: 'https://example.com/ep2' });
  const nav = await b.c.next((m) => m.t === 'nav');
  assert.equal(nav.url, 'https://example.com/ep2');
  assert.equal(nav.byName, 'Eren');

  const info = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${room}`)).json();
  assert.equal(info.url, 'https://example.com/ep2');
});

test('WS: reconnecting with the same client id replaces the old socket', async (t) => {
  const { app, port, post } = await start();
  t.after(() => app.close());
  const { room } = await (await post('/api/rooms', { url: 'https://example.com/a' })).json();
  const a1 = await joined(port, room, ID_A, 'Eren');
  const b = await joined(port, room, ID_B, 'Doğa');

  const a2 = await joined(port, room, ID_A, 'Eren');
  assert.equal(await a1.c.closed, 4001);
  assert.equal(a2.welcome.members.length, 2);

  // The old socket closing must not remove the member.
  b.c.send({ t: 'state', playing: true, position: 1, rate: 1, at: Date.now() });
  const s = await a2.c.next((m) => m.t === 'state');
  assert.equal(s.playing, true);
});

test('WS: a socket that never joins is closed', async (t) => {
  const { app, port, post } = await start();
  t.after(() => app.close());
  const { room } = await (await post('/api/rooms', { url: 'https://example.com/a' })).json();
  const c = client(port, room);
  await c.opened;
  c.send({ t: 'state', playing: true, position: 1 }); // ignored before join
  assert.equal(await c.closed, 4000);
});
