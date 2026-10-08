'use strict';

// EdcWatch background script.
//
// Owns everything that must outlive a page: the WebSocket to the relay server,
// the room <-> tab binding, the clock offset to the server and the choice of
// which frame's <video> is the one being synced. Content scripts only ever
// talk to this script, never to the network (page CSP cannot block us here).
//
// The script may be torn down at any time (MV3 service worker / Safari event
// page), so everything durable lives in storage and every handler first waits
// for `ready`.

const api = globalThis.browser ?? globalThis.chrome;
if (typeof importScripts === 'function') {
  try {
    importScripts('config.js');
  } catch {}
}
const DEFAULT_SERVER = (self.EDC_CONFIG && self.EDC_CONFIG.server) || 'http://localhost:8787';

const settingsArea = api.storage.local;
const sessionArea = api.storage.session || api.storage.local;

const ROOM_RE = /^[A-HJKMNP-Z2-9]{6}$/;
const FATAL_CLOSE = { 4004: 'room-not-found', 4005: 'room-full', 4001: 'replaced', 4003: 'bad-id' };

const S = {
  settings: { server: DEFAULT_SERVER, name: '', clientId: '' },
  sess: null, // { room, server, tabId, link }
  ws: null,
  connected: false,
  members: [],
  roomUrl: '',
  state: null, // room playback state, timestamps in *local* time
  offset: 0, // serverTime - localTime (ms)
  samples: [],
  reports: new Map(), // frameId -> { score, ts }
  elected: null, // frameId whose <video> is synced
  error: null,
  reconnectDelay: 1000,
  reconnectTimer: null,
  pingTimer: null,
  navTimer: null,
};

// ------------------------------------------------------------------ helpers

const randomId = () => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

const httpBase = (server) => server.replace(/^ws/, 'http').replace(/\/+$/, '');
const wsUrl = (server, room) => {
  const u = new URL(server);
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = `?room=${encodeURIComponent(room)}`; // the Cloudflare worker routes by this
  u.hash = '';
  return u.toString();
};

function normalizeServer(raw) {
  let s = String(raw || '').trim();
  if (!s) return DEFAULT_SERVER;
  if (!/^[a-z]+:\/\//i.test(s)) s = (/^(localhost|127\.|192\.168\.|10\.)/.test(s) ? 'http://' : 'https://') + s;
  const u = new URL(s);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  if (u.protocol === 'wss:') u.protocol = 'https:';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad-server');
  return u.origin;
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

async function apiFetch(server, path, init) {
  let res;
  try {
    res = await fetch(httpBase(server) + path, init);
  } catch {
    throw Object.assign(new Error('network'), { code: 'network' });
  }
  let body = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) {
    const code = (body && body.error) || `http-${res.status}`;
    throw Object.assign(new Error(code), { code });
  }
  return body;
}

async function toTab(tabId, msg) {
  if (tabId == null) return false;
  try {
    await api.tabs.sendMessage(tabId, msg);
    return true;
  } catch {
    return false; // no content script there (yet)
  }
}

function changed() {
  try {
    Promise.resolve(api.runtime.sendMessage({ type: 'status-changed' })).catch(() => {});
  } catch {}
}

async function saveSettings() {
  await settingsArea.set({ settings: S.settings });
}

// ------------------------------------------------------------------- startup

const ready = (async () => {
  const stored = (await settingsArea.get('settings')).settings;
  S.settings = { ...S.settings, ...stored };
  if (!S.settings.clientId) {
    S.settings.clientId = randomId();
    await saveSettings();
  }
  const saved = (await sessionArea.get('edc_sess')).edc_sess;
  if (saved) {
    try {
      await api.tabs.get(saved.tabId);
      S.sess = saved;
    } catch {
      await sessionArea.remove('edc_sess');
    }
  }
  if (S.sess) connect();
})();

api.alarms.create('edc-tick', { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener(async () => {
  await ready;
  if (S.sess && !S.ws) connect();
  elect();
});

// ----------------------------------------------------------------- websocket

function connect() {
  if (!S.sess || (S.ws && S.ws.readyState <= 1)) return;
  clearTimeout(S.reconnectTimer);
  let ws;
  try {
    ws = new WebSocket(wsUrl(S.sess.server, S.sess.room));
  } catch {
    S.error = 'bad-server';
    changed();
    return;
  }
  S.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'join', room: S.sess.room, id: S.settings.clientId, name: S.settings.name }));
  };
  ws.onmessage = (ev) => {
    try {
      onServer(JSON.parse(ev.data));
    } catch (e) {
      console.error('EdcWatch: bad server message', e);
    }
  };
  ws.onclose = (ev) => {
    if (S.ws !== ws) return;
    S.ws = null;
    S.connected = false;
    clearInterval(S.pingTimer);
    const fatal = FATAL_CLOSE[ev.code];
    if (fatal === 'replaced' || fatal === 'bad-id') {
      S.error = fatal;
    } else if (fatal) {
      leave(fatal);
      return;
    } else {
      S.reconnectTimer = setTimeout(connect, S.reconnectDelay);
      S.reconnectDelay = Math.min(S.reconnectDelay * 2, 15000);
    }
    changed();
  };
  ws.onerror = () => {};
}

function closeWs() {
  clearTimeout(S.reconnectTimer);
  clearInterval(S.pingTimer);
  if (S.ws) {
    const ws = S.ws;
    S.ws = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {}
  }
  S.connected = false;
}

function wsSend(obj) {
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function startPing() {
  clearInterval(S.pingTimer);
  const ping = () => wsSend({ t: 'ping', c: Date.now() });
  for (let i = 0; i < 5; i++) setTimeout(ping, i * 250);
  S.pingTimer = setInterval(ping, 20000);
}

function fromServerState(s) {
  return {
    rev: s.rev,
    set: s.set,
    playing: s.playing,
    position: s.position,
    rate: s.rate,
    localAt: s.at - S.offset,
    by: s.by,
    byName: s.byName,
    byMe: s.by === S.settings.clientId,
    hold: s.hold,
  };
}

function expectedPosition(s, at) {
  return s.playing ? s.position + ((at - s.localAt) / 1000) * s.rate : s.position;
}

function describeChange(prev, next, reason) {
  if (next.hold) {
    const names = next.hold.names.join(', ');
    return names ? `${names} için video yükleniyor, bekleniyor…` : 'Video yükleniyor, bekleniyor…';
  }
  if (prev && prev.hold) return 'Devam ediyor';
  if (next.byMe || reason === 'welcome' || reason === 'elect') return '';
  const who = next.byName || 'Biri';
  if (!prev || !prev.set || prev.playing !== next.playing) return `${who} ${next.playing ? 'oynattı' : 'durdurdu'}`;
  if (Math.abs(expectedPosition(prev, next.localAt) - next.position) > 2) return `${who} ${fmtTime(next.position)} konumuna sardı`;
  if (prev.rate !== next.rate) return `${who} hızı ${next.rate}x yaptı`;
  return '';
}

function toastFrame() {
  return S.elected ?? 0;
}

function pushState(reason) {
  if (!S.sess || !S.state) return;
  toTab(S.sess.tabId, { type: 'state', state: S.state, reason, applyFrame: S.elected });
}

function toast(text) {
  if (text && S.sess) toTab(S.sess.tabId, { type: 'toast', frameId: toastFrame(), text });
}

function onServer(m) {
  switch (m.t) {
    case 'welcome': {
      S.connected = true;
      S.error = null;
      S.reconnectDelay = 1000;
      S.members = m.members;
      S.roomUrl = m.room.url;
      S.offset = m.serverNow - Date.now();
      S.samples = [];
      startPing();
      S.state = fromServerState(m.state);
      pushState('welcome');
      changed();
      break;
    }
    case 'pong': {
      const now = Date.now();
      const rtt = now - m.c;
      if (rtt < 0 || rtt > 5000) break;
      S.samples.push({ rtt, offset: m.s + rtt / 2 - now });
      if (S.samples.length > 8) S.samples.shift();
      S.offset = S.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
      break;
    }
    case 'state': {
      if (S.state && m.rev <= S.state.rev) break; // stale or duplicate
      const prev = S.state;
      S.state = fromServerState(m);
      toast(describeChange(prev, S.state, m.reason));
      pushState(m.reason);
      break;
    }
    case 'members': {
      S.members = m.list;
      if (m.joined) toast(`${m.joined.name} katıldı`);
      if (m.left) toast(`${m.left.name} ayrıldı`);
      changed();
      break;
    }
    case 'nav': {
      S.roomUrl = m.url;
      if (S.sess) {
        api.tabs.get(S.sess.tabId).then(
          (tab) => {
            if (tab.url !== m.url) toTab(S.sess.tabId, { type: 'nav-prompt', frameId: toastFrame(), url: m.url, name: m.byName });
          },
          () => {},
        );
      }
      break;
    }
    case 'error': {
      S.error = m.code;
      changed();
      break;
    }
  }
}

// ------------------------------------------------------- frame election

// Every frame with a plausible <video> reports a score; the highest one is the
// "player" that gets synced. Ads, previews and thumbnails score low.
function elect() {
  const now = Date.now();
  let best = null;
  let cur = null;
  for (const [fid, r] of S.reports) {
    if (now - r.ts > 10000) {
      S.reports.delete(fid);
      continue;
    }
    if (!(r.score > 0)) continue;
    if (fid === S.elected) cur = { fid, score: r.score };
    if (!best || r.score > best.score) best = { fid, score: r.score };
  }
  let next = S.elected;
  if (!cur) next = best ? best.fid : null;
  else if (best && best.fid !== cur.fid && best.score > cur.score * 1.5) next = best.fid;
  if (next === S.elected) return;
  S.elected = next;
  if (S.sess) {
    toTab(S.sess.tabId, { type: 'elect', frameId: next });
    if (next !== null) pushState('elect');
  }
  changed();
}

// -------------------------------------------------------------- room control

async function bind(tabId, room, server, link, reloadIfMissing) {
  if (S.sess) await leave(null, true);
  S.sess = { room, server, tabId, link: link || `${httpBase(server)}/j/${room}` };
  S.error = null;
  S.members = [];
  S.state = null;
  S.elected = null;
  S.reports.clear();
  await sessionArea.set({ edc_sess: S.sess });
  connect();
  const delivered = await toTab(tabId, { type: 'activate' });
  if (!delivered && reloadIfMissing) {
    try {
      await api.tabs.reload(tabId);
    } catch {}
  }
  changed();
}

async function leave(error, silent) {
  const tabId = S.sess && S.sess.tabId;
  S.sess = null;
  S.members = [];
  S.state = null;
  S.elected = null;
  S.roomUrl = '';
  S.reports.clear();
  S.error = error || null;
  closeWs();
  await sessionArea.remove('edc_sess');
  if (tabId != null) await toTab(tabId, { type: 'deactivate' });
  if (!silent) changed();
}

async function createRoom({ url, tabId }) {
  if (!isHttpUrl(url)) throw Object.assign(new Error('bad-url'), { code: 'bad-url' });
  const server = S.settings.server;
  const r = await apiFetch(server, '/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const attach = tabId != null;
  const id = attach ? tabId : (await api.tabs.create({ url })).id;
  await bind(id, r.room, server, r.link, attach);
  S.roomUrl = url;
  return { room: r.room, link: r.link };
}

function parseInvite(input) {
  const text = String(input || '').trim();
  const code = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (ROOM_RE.test(code) && !/[:/.]/.test(text)) return { room: code, server: S.settings.server };
  try {
    const u = new URL(text);
    const m = u.pathname.match(/^\/j\/([A-Za-z0-9]{6})\/?$/);
    if (m && (u.protocol === 'http:' || u.protocol === 'https:')) return { room: m[1].toUpperCase(), server: u.origin };
  } catch {}
  throw Object.assign(new Error('bad-invite'), { code: 'bad-invite' });
}

async function joinRoom({ room, server, tabId }) {
  const info = await apiFetch(server, `/api/rooms/${room}`);
  let id = tabId;
  if (id == null) id = (await api.tabs.create({ url: info.url })).id;
  else await api.tabs.update(id, { url: info.url });
  await bind(id, room, server, null, false);
  S.roomUrl = info.url;
}

// ---------------------------------------------------------------- messaging

function snapshot() {
  return {
    settings: { server: S.settings.server, name: S.settings.name },
    defaultServer: DEFAULT_SERVER,
    you: S.settings.clientId,
    room: S.sess ? S.sess.room : null,
    link: S.sess ? S.sess.link : null,
    tabId: S.sess ? S.sess.tabId : null,
    connected: S.connected,
    members: S.members,
    hasVideo: S.elected !== null,
    error: S.error,
  };
}

async function handle(msg, sender) {
  await ready;
  const tabId = sender.tab ? sender.tab.id : null;
  const inRoomTab = S.sess && tabId === S.sess.tabId;

  switch (msg.type) {
    // ---- from content scripts
    case 'hello':
      return {
        frameId: sender.frameId,
        active: !!inRoomTab,
        serverOrigin: new URL(S.settings.server).origin,
      };

    case 'video-report':
      if (!inRoomTab) return;
      S.reports.set(sender.frameId, { score: msg.score, ts: Date.now() });
      elect();
      return;

    case 'action':
      if (!inRoomTab || sender.frameId !== S.elected) return;
      if (wsSend({ t: 'state', playing: msg.playing, position: msg.position, rate: msg.rate, at: msg.ts + S.offset })) {
        S.state = {
          ...(S.state || { rev: 0 }),
          set: true,
          playing: msg.playing,
          position: msg.position,
          rate: msg.rate,
          localAt: msg.ts,
          by: S.settings.clientId,
          byMe: true,
          hold: null,
        };
      }
      return;

    case 'wait':
    case 'ready':
      if (inRoomTab && sender.frameId === S.elected) wsSend({ t: msg.type, position: msg.position, at: msg.ts + S.offset });
      return;

    case 'go':
      if (inRoomTab && isHttpUrl(msg.url)) await api.tabs.update(tabId, { url: msg.url });
      return;

    case 'join-landing': {
      // Only the landing page of *our* server may drive this, and only from
      // its top frame: the page opens the shared site in this very tab.
      if (sender.frameId !== 0 || !sender.url || new URL(sender.url).origin !== new URL(S.settings.server).origin) return;
      const room = String(msg.room || '').toUpperCase();
      if (!ROOM_RE.test(room)) return { ok: false, error: 'bad-invite' };
      if (msg.name && String(msg.name).trim()) {
        S.settings.name = String(msg.name).trim().slice(0, 24);
        await saveSettings();
      }
      try {
        await joinRoom({ room, server: S.settings.server, tabId });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.code || 'error' };
      }
    }

    // ---- from the popup
    case 'status':
      return snapshot();

    case 'create':
      try {
        return { ok: true, ...(await createRoom(msg)) };
      } catch (e) {
        return { ok: false, error: e.code || 'error' };
      }

    case 'join':
      try {
        return { ok: true, ...(await joinRoom({ ...parseInvite(msg.input), tabId: null })) };
      } catch (e) {
        return { ok: false, error: e.code || 'error' };
      }

    case 'leave':
      await leave(null);
      return { ok: true };

    case 'settings': {
      try {
        if (typeof msg.name === 'string') {
          S.settings.name = msg.name.trim().slice(0, 24);
          wsSend({ t: 'name', name: S.settings.name });
        }
        if (typeof msg.server === 'string') S.settings.server = normalizeServer(msg.server);
        await saveSettings();
        changed();
        return { ok: true, settings: snapshot().settings };
      } catch {
        return { ok: false, error: 'bad-server' };
      }
    }
  }
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => {
    console.error('EdcWatch:', e);
    sendResponse(undefined);
  });
  return true;
});

api.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (S.sess && S.sess.tabId === tabId) leave(null);
});

api.tabs.onUpdated.addListener(async (tabId, info) => {
  await ready;
  if (!S.sess || tabId !== S.sess.tabId) return;
  if (info.status === 'loading' && info.url) {
    // New document: old frames are gone, the new ones will report in.
    S.reports.clear();
    if (S.elected !== null) {
      S.elected = null;
      changed();
    }
  }
  if (info.url && isHttpUrl(info.url)) {
    clearTimeout(S.navTimer);
    S.navTimer = setTimeout(() => {
      if (info.url !== S.roomUrl) wsSend({ t: 'nav', url: info.url });
    }, 1500);
  }
});
