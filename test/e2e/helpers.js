'use strict';

// End-to-end test helpers: a local "movie site", two (or more) real Chromium
// profiles with the extension loaded, and small polling utilities.

process.env.QUIET = '1';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const WebSocket = require('../../server/node_modules/ws');
const { createApp } = require('../../server/server');

const ROOT = path.join(__dirname, '..', '..');
const EXTENSION = path.join(ROOT, 'extension');
const FIXTURES = path.join(__dirname, '.fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, { timeout = 10000, interval = 100, message = 'condition' } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${message}${last instanceof Error ? `: ${last.message}` : ''}`);
    }
    await sleep(interval);
  }
}

// ---------------------------------------------------------------- fixtures

function ensureFixtures() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const movie = path.join(FIXTURES, 'movie.webm');
  const ad = path.join(FIXTURES, 'ad.webm');
  const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (!fs.existsSync(movie)) {
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '240',
      '-c:v', 'libvpx', '-b:v', '300k', '-g', '30', '-c:a', 'libopus', '-b:a', '24k', '-cues_to_front', '1', movie]);
  }
  if (!fs.existsSync(ad)) {
    ff(['-f', 'lavfi', '-i', 'color=c=orange:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '6',
      '-c:v', 'libvpx', '-b:v', '100k', '-c:a', 'libopus', '-b:a', '24k', ad]);
  }
}

// ------------------------------------------------------------- movie sites

const VIDEO = (attrs = '') => `<video id="v" src="/movie.webm" width="640" height="360" controls preload="auto" ${attrs}></video>`;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0;background:#111">${body}</body></html>`;
}

/**
 * Minimal static server for the video files with HTTP Range support. If a
 * request carries the cookie `slow=1`, it behaves like a bad connection: data
 * trickles in, and any seek away from the start needs `slowSeekMs` extra.
 */
function startSite(pages, { host = '127.0.0.1' } = {}) {
  const state = { slowSeekMs: 4000, requests: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push(req.url);
    if (pages[url.pathname]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(typeof pages[url.pathname] === 'function' ? pages[url.pathname](url) : pages[url.pathname]);
    }
    const file = path.join(FIXTURES, path.basename(url.pathname));
    if (!url.pathname.endsWith('.webm') || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    const size = fs.statSync(file).size;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let start = 0;
    let end = size - 1;
    if (range) {
      if (range[1] !== '') start = Number(range[1]);
      if (range[2] !== '') end = Math.min(Number(range[2]), size - 1);
    }
    const slow = /(?:^|;\s*)slow=1/.test(req.headers.cookie || '');
    if (slow && start > 1_000_000) await sleep(state.slowSeekMs);
    res.writeHead(range ? 206 : 200, {
      'content-type': 'video/webm',
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    const stream = fs.createReadStream(file, { start, end, highWaterMark: slow ? 16 * 1024 : 64 * 1024 });
    req.on('close', () => stream.destroy());
    if (!slow) return stream.pipe(res);
    stream.on('data', (chunk) => {
      stream.pause();
      res.write(chunk, () => setTimeout(() => stream.resume(), 100));
    });
    stream.on('end', () => res.end());
  });
  return new Promise((resolve) =>
    server.listen(0, host, () => {
      const port = server.address().port;
      resolve({ server, port, origin: `http://${host}:${port}`, state, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) });
    }),
  );
}

// -------------------------------------------------------------- the browser

/** One person: a separate Chromium profile with the extension loaded. */
async function launchPerson(name, { autoplay = true } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `edcwatch-${name.replace(/[^a-z0-9]/gi, '_')}-`));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1000, height: 700 },
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      ...(autoplay ? ['--autoplay-policy=no-user-gesture-required'] : []),
    ],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  const extId = new URL(sw.url()).host;

  // A page on the extension origin, used to talk to the background script the
  // same way the popup does.
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/popup.html`);

  const person = {
    name,
    ctx,
    sw,
    extId,
    ext,
    call: (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg),
    status: () => person.call({ type: 'status' }),
    async configure(server) {
      const r = await person.call({ type: 'settings', server, name });
      if (!r || !r.ok) throw new Error(`configure failed: ${JSON.stringify(r)}`);
    },
    async tabIdOf(page) {
      return sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, page.url());
    },
    async close() {
      await ctx.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
  return person;
}

// ---------------------------------------------------------- video utilities

/** Read the state of the (first) video of a page or frame. */
const readVideo = (target, selector = '#v') =>
  target.evaluate((sel) => {
    const v = document.querySelector(sel);
    return { paused: v.paused, t: v.currentTime, rate: v.playbackRate, ready: v.readyState, seeking: v.seeking };
  }, selector);

const play = (target, selector = '#v') => target.evaluate((sel) => document.querySelector(sel).play(), selector);
const pause = (target, selector = '#v') => target.evaluate((sel) => document.querySelector(sel).pause(), selector);
const seek = (target, t, selector = '#v') => target.evaluate(([sel, t]) => (document.querySelector(sel).currentTime = t), [selector, t]);

/** Passive room observer: records every state message the server broadcasts. */
async function observeRoom(port, room) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}`);
  const states = [];
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'state') states.push(m);
  });
  ws.send(JSON.stringify({ t: 'join', room, id: 'observer-0000', name: 'observer' }));
  await until(() => ws.readyState === 1, { message: 'observer open' });
  return { states, close: () => ws.close() };
}

module.exports = {
  ROOT, EXTENSION, FIXTURES, sleep, until, ensureFixtures, startSite, page, VIDEO, launchPerson, createApp,
  readVideo, play, pause, seek, observeRoom,
};
