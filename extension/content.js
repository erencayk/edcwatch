'use strict';

// EdcWatch content script. Runs in every frame but stays dormant unless the
// tab is bound to a room. In the frame that holds the "elected" player it
//   - turns user actions (play / pause / seek / rate) into room updates, and
//   - makes the <video> follow the room state.
//
// The sync is state based instead of event based: after every media event we
// compare the video with the room's expected state and only report a
// difference. That is what stops echo loops (our own programmatic play() fires
// a 'play' event that matches the room, so nothing is sent) and lets two
// devices converge even when messages cross.

(() => {
  if (globalThis.__edcwatch) return;
  globalThis.__edcwatch = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const isTop = window === window.top;

  const SEEK_TOLERANCE_PLAYING = 0.6; // s: don't seek for smaller differences
  const SEEK_TOLERANCE_PAUSED = 0.2;
  const DRIFT_LIMIT = 1.2; // s: watchdog re-syncs a playing video past this
  const USER_SEEK_PLAYING = 1.0; // s: local jump that counts as a user seek
  const USER_SEEK_PAUSED = 0.35;
  const STALL_MS = 1500;
  const ADOPT_MAX_MS = 10000; // longest we protect the room from a freshly attached video

  let myFrameId = null;
  let active = false; // this tab is in a room
  let elected = false; // this frame's video is the synced one
  let video = null; // best candidate in this frame
  let attached = null; // video we have listeners on
  let state = null; // room state (timestamps in local time)
  let adapter = null;

  let scanTimer = null;
  let observer = null;
  let driftTimer = null;
  let checkTimer = null;
  let stallTimer = null;
  let stalled = false;
  let tapVisible = false;
  let mismatch = 0;
  // A freshly attached video (or one whose source just loaded) must first catch
  // up with the room before its own events may change the room; otherwise a
  // page that autoplays from 0 would drag everybody back to the start.
  let adopted = true;
  let adoptDeadline = 0;
  let lastEmitTs = 0;
  let lastSeek = { to: -1, at: 0 };
  let lastReport = { score: -1, at: 0 };

  function send(msg) {
    try {
      return Promise.resolve(api.runtime.sendMessage(msg)).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined); // extension was reloaded under us
    }
  }

  // ------------------------------------------------------------------ adapters

  const genericAdapter = {
    seek(v, t) {
      v.currentTime = t;
    },
  };

  // Netflix refuses `video.currentTime = x` (error M7375); seeking has to go
  // through its own player API, which only exists in the page's JS world.
  let bridge = null;
  let bridgeSeq = 0;
  const bridgePending = new Map();

  function ensureBridge() {
    if (bridge) return bridge;
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data || e.data.edcwatch !== 'res') return;
      const done = bridgePending.get(e.data.id);
      if (done) {
        bridgePending.delete(e.data.id);
        done(!!e.data.ok);
      }
    });
    bridge = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = api.runtime.getURL('page-bridge.js');
      s.onload = () => {
        s.remove();
        resolve(true);
      };
      s.onerror = () => resolve(false);
      (document.head || document.documentElement).appendChild(s);
    });
    return bridge;
  }

  async function bridgeSeek(ms) {
    if (!(await ensureBridge())) return false;
    return new Promise((resolve) => {
      const id = ++bridgeSeq;
      bridgePending.set(id, resolve);
      window.postMessage({ edcwatch: 'cmd', id, op: 'seek', ms }, '*');
      setTimeout(() => bridgePending.delete(id) && resolve(false), 1000);
    });
  }

  const netflixAdapter = {
    seek(v, t) {
      bridgeSeek(t * 1000).then((ok) => {
        if (!ok) v.currentTime = t;
      });
    },
  };

  function pickAdapter() {
    return /(^|\.)netflix\.com$/.test(location.hostname) ? netflixAdapter : genericAdapter;
  }

  // -------------------------------------------------------------- UI overlay

  let ui = null;
  let toastTimer = null;

  // CSSOM only: inline <style>/style="" can be blocked by a page's CSP.
  const css = (el, props) => Object.assign(el.style, props);

  function ensureUi() {
    if (!ui) {
      const host = document.createElement('div');
      host.setAttribute('data-edcwatch-ui', '');
      css(host, { all: 'initial' });
      css(host, { position: 'fixed', top: '0', left: '0', width: '100%', height: '0', zIndex: '2147483647', pointerEvents: 'none' });
      const root = host.attachShadow({ mode: 'open' });

      const toastEl = document.createElement('div');
      css(toastEl, {
        position: 'absolute', top: '16px', left: '50%', transform: 'translate(-50%, -8px)',
        maxWidth: '90%', padding: '10px 16px', borderRadius: '999px',
        background: 'rgba(20,20,22,.88)', color: '#fff', font: '600 14px/1.3 -apple-system, "Segoe UI", sans-serif',
        boxShadow: '0 4px 20px rgba(0,0,0,.35)', opacity: '0', transition: 'opacity .2s, transform .2s',
        display: 'flex', alignItems: 'center', gap: '12px', pointerEvents: 'none', whiteSpace: 'nowrap',
      });

      const tapEl = document.createElement('button');
      tapEl.type = 'button';
      tapEl.textContent = '▶  Birlikte izlemeye başla';
      css(tapEl, {
        display: 'none', position: 'absolute', transform: 'translate(-50%, -50%)', padding: '16px 26px',
        border: '0', borderRadius: '999px', background: '#e5484d', color: '#fff', cursor: 'pointer',
        font: '700 17px/1 -apple-system, "Segoe UI", sans-serif', boxShadow: '0 6px 28px rgba(0,0,0,.45)', pointerEvents: 'auto',
      });
      tapEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideTap();
        if (attached && state && state.set) applyState(state, 'tap'); // inside the click: play() is allowed
        else if (attached) attached.play();
      });

      root.append(toastEl, tapEl);
      ui = { host, toastEl, tapEl };
      document.addEventListener('fullscreenchange', placeUi, true);
      document.addEventListener('webkitfullscreenchange', placeUi, true);
    }
    placeUi();
    return ui;
  }

  // Only the fullscreen element's subtree is visible in fullscreen.
  function placeUi() {
    if (!ui) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' && fs.tagName !== 'IFRAME' ? fs : document.documentElement;
    if (ui.host.parentNode !== parent) parent.appendChild(ui.host);
  }

  function toast(text, action) {
    if (!text) return;
    const { toastEl } = ensureUi();
    toastEl.textContent = '';
    const label = document.createElement('span');
    label.textContent = text;
    toastEl.append(label);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      css(b, {
        border: '0', borderRadius: '999px', padding: '6px 12px', background: '#fff', color: '#111',
        font: '700 13px/1 -apple-system, "Segoe UI", sans-serif', cursor: 'pointer', pointerEvents: 'auto',
      });
      b.addEventListener('click', () => {
        hideToast();
        action.run();
      });
      toastEl.append(b);
    }
    css(toastEl, { opacity: '1', transform: 'translate(-50%, 0)' });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 15000 : 3500);
  }

  function hideToast() {
    if (ui) css(ui.toastEl, { opacity: '0', transform: 'translate(-50%, -8px)' });
  }

  function showTap() {
    if (!attached) return;
    const { tapEl } = ensureUi();
    const r = attached.getBoundingClientRect();
    css(tapEl, { display: 'block', left: `${r.left + r.width / 2}px`, top: `${Math.max(r.top + r.height / 2, 60)}px` });
    tapVisible = true;
  }

  function hideTap() {
    tapVisible = false;
    if (ui) ui.tapEl.style.display = 'none';
  }

  // ------------------------------------------------------------- room state

  function expected(s) {
    if (!s.playing) return { playing: false, position: s.position, rate: s.rate };
    const elapsed = Math.max(0, Math.min((Date.now() - s.localAt) / 1000, 6 * 3600));
    return { playing: true, position: s.position + elapsed * s.rate, rate: s.rate };
  }

  function seekTo(v, t) {
    const d = v.duration;
    if (Number.isFinite(d) && d > 0) t = Math.min(t, Math.max(0, d - 0.05));
    t = Math.max(0, t);
    if (v.seeking && Math.abs(lastSeek.to - t) < 1) return;
    lastSeek = { to: t, at: Date.now() };
    adapter.seek(v, t);
  }

  function play(v) {
    const p = v.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (err && err.name === 'NotAllowedError') showTap();
      });
    }
  }

  function applyState(s, reason) {
    state = s;
    const v = attached;
    if (!v || !elected || !s.set) return;
    const exp = expected(s);
    const tol = exp.playing ? SEEK_TOLERANCE_PLAYING : SEEK_TOLERANCE_PAUSED;
    if (Math.abs(v.currentTime - exp.position) > tol) seekTo(v, exp.position);
    if (Math.abs(v.playbackRate - s.rate) > 0.01) v.playbackRate = s.rate;
    if (exp.playing && v.paused) play(v);
    else if (!exp.playing && !v.paused) v.pause();
    if (!exp.playing) hideTap();
  }

  // ------------------------------------------------- local video -> room

  function onLocalEvent() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(reconcileLocal, 150); // coalesce play+seeking+seeked
  }

  function reconcileLocal() {
    const v = attached;
    if (!v || !elected) return;
    const local = { playing: !v.paused && !v.ended, position: v.currentTime, rate: v.playbackRate };
    if (!Number.isFinite(local.position)) return;
    if (local.playing) hideTap();

    if (state && state.set) {
      const exp = expected(state);
      const tol = local.playing ? USER_SEEK_PLAYING : USER_SEEK_PAUSED;
      const same = exp.playing === local.playing && Math.abs(exp.position - local.position) <= tol && Math.abs(exp.rate - local.rate) < 0.01;
      if (same) {
        adopted = true; // caught up with the room
        return;
      }
      if (!adopted) {
        if (Date.now() < adoptDeadline || tapVisible) return; // still joining: the room wins, the watchdog pulls us over
        adopted = true; // gave up waiting; from now on the user is in control
      }
    } else if (!local.playing && local.position < 0.5) {
      return; // nothing has happened yet
    }

    const ts = Date.now();
    lastEmitTs = ts;
    adopted = true; // an action we report means the user is driving
    state = { ...(state || {}), set: true, playing: local.playing, position: local.position, rate: local.rate, localAt: ts, byMe: true };
    send({ type: 'action', playing: local.playing, position: local.position, rate: local.rate, ts });
  }

  // Buffering: if our video starves while the room plays, ask the others to
  // wait (the server freezes the timeline) and say when we can go on.
  function onWaiting() {
    if (!elected || !adopted || stalled || stallTimer) return; // a joiner that is still loading must not stop the others
    stallTimer = setTimeout(() => {
      stallTimer = null;
      const v = attached;
      if (!v || v.paused || v.ended || v.readyState >= 3) return;
      if (!(state && state.set && state.playing)) return;
      stalled = true;
      send({ type: 'wait', position: v.currentTime, ts: Date.now() });
    }, STALL_MS);
  }

  function checkReady() {
    const v = attached;
    if (!stalled || !v || v.readyState < 3) return;
    stalled = false;
    send({ type: 'ready', position: v.currentTime, ts: Date.now() });
  }

  function watchdog() {
    const v = attached;
    if (!v || !elected || !state || !state.set) return;
    if (tapVisible) showTap(); // keep it centred on the video
    if (stalled) return checkReady();
    if (v.seeking) {
      mismatch = 0;
      return;
    }
    const exp = expected(state);
    if (exp.playing && !v.paused) {
      if (Math.abs(v.currentTime - exp.position) > DRIFT_LIMIT) seekTo(v, exp.position);
      mismatch = 0;
    } else if (exp.playing !== !v.paused && !v.ended) {
      if (exp.playing && tapVisible) return; // waiting for the user's tap
      if (++mismatch >= 2) {
        mismatch = 0;
        applyState(state, 'watchdog');
      }
    } else {
      mismatch = 0;
    }
  }

  const LOCAL_EVENTS = ['play', 'pause', 'seeked', 'ratechange', 'ended'];
  const READY_EVENTS = ['canplay', 'playing', 'seeked'];

  function attach(v) {
    detach();
    if (!v) return;
    attached = v;
    adopted = false;
    adoptDeadline = Date.now() + ADOPT_MAX_MS;
    for (const ev of LOCAL_EVENTS) v.addEventListener(ev, onLocalEvent);
    for (const ev of READY_EVENTS) v.addEventListener(ev, checkReady);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('playing', hideTap);
    driftTimer = setInterval(watchdog, 1000);
    if (state) applyState(state, 'attach');
  }

  function onMeta() {
    adopted = false;
    adoptDeadline = Date.now() + ADOPT_MAX_MS;
    if (state && state.set) applyState(state, 'meta');
  }

  function detach() {
    const v = attached;
    if (!v) return;
    for (const ev of LOCAL_EVENTS) v.removeEventListener(ev, onLocalEvent);
    for (const ev of READY_EVENTS) v.removeEventListener(ev, checkReady);
    v.removeEventListener('waiting', onWaiting);
    v.removeEventListener('loadedmetadata', onMeta);
    v.removeEventListener('playing', hideTap);
    clearInterval(driftTimer);
    clearTimeout(checkTimer);
    clearTimeout(stallTimer);
    stallTimer = null;
    if (stalled) send({ type: 'ready', position: v.currentTime, ts: Date.now() });
    stalled = false;
    attached = null;
  }

  // ------------------------------------------------------- video discovery

  function allVideos() {
    const out = [];
    const visit = (root) => {
      for (const v of root.querySelectorAll('video')) out.push(v);
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(document);
    return out;
  }

  function scoreOf(v) {
    if (!v.isConnected) return 0;
    const r = v.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    if (w < 160 || h < 90) return 0;
    const cs = getComputedStyle(v);
    if (cs.visibility === 'hidden' || cs.display === 'none') return 0;
    let s = w * h;
    const d = v.duration;
    if (Number.isFinite(d) && d > 0 && d < 20) s *= 0.15; // bumpers, previews
    if (v.loop && v.muted) s *= 0.1; // decorative background loops
    return s;
  }

  function scan() {
    if (!active) return;
    let best = null;
    for (const el of allVideos()) {
      const score = scoreOf(el);
      if (score > 0 && (!best || score > best.score)) best = { el, score };
    }
    // Keep the current video unless another one is clearly better.
    if (attached && attached.isConnected) {
      const cur = scoreOf(attached);
      if (cur > 0 && (!best || best.el === attached || best.score < cur * 1.5)) best = { el: attached, score: cur };
    }
    video = best ? best.el : null;

    const score = best ? best.score : 0;
    const now = Date.now();
    if (Math.abs(score - lastReport.score) > Math.max(1, lastReport.score * 0.1) || now - lastReport.at >= 2500) {
      lastReport = { score, at: now };
      send({ type: 'video-report', score });
    }
    if (elected && video !== attached) attach(video);
  }

  function startScanning() {
    stopScanning();
    scan();
    scanTimer = setInterval(scan, 3000);
    let pending = null;
    observer = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        scan();
      }, 400);
    });
    observer.observe(document.documentElement || document, { childList: true, subtree: true });
  }

  function stopScanning() {
    clearInterval(scanTimer);
    scanTimer = null;
    if (observer) observer.disconnect();
    observer = null;
  }

  // -------------------------------------------------------------- lifecycle

  function activate() {
    if (active) return;
    active = true;
    adapter = pickAdapter();
    lastReport = { score: -1, at: 0 };
    startScanning();
  }

  function deactivate() {
    active = false;
    elected = false;
    stopScanning();
    detach();
    hideTap();
    state = null;
    if (ui) ui.host.remove();
  }

  function onElect(frameId) {
    const me = myFrameId !== null && frameId === myFrameId;
    if (me && !elected) {
      elected = true;
      attach(video);
      if (attached) toast('Senkron aktif');
    } else if (!me && elected) {
      elected = false;
      detach();
      hideTap();
    }
  }

  function onState(msg) {
    const s = msg.state;
    if (s.byMe && lastEmitTs > s.localAt) return; // stale echo of an older action of ours
    state = s;
    if (elected && myFrameId !== null && msg.applyFrame === myFrameId) applyState(s, msg.reason);
  }

  function navPrompt(msg) {
    toast(`${msg.name || 'Biri'} başka bir sayfaya geçti`, {
      label: 'Git',
      run: () => send({ type: 'go', url: msg.url }),
    });
  }

  // The invite landing page of our own server talks to the extension through
  // this tiny postMessage handshake; the background re-checks the origin.
  function markLanding() {
    document.documentElement.dataset.edcwatch = '1';
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (e.source !== window || e.origin !== location.origin || !d || d.edcwatch !== true || d.type !== 'join') return;
      send({ type: 'join-landing', room: d.room, name: d.name });
    });
  }

  async function hello() {
    const r = await send({ type: 'hello' });
    if (!r) return;
    myFrameId = r.frameId;
    if (isTop && r.serverOrigin === location.origin && !document.documentElement.dataset.edcwatch) markLanding();
    if (r.active) activate();
    else if (active) deactivate();
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'activate':
        hello();
        sendResponse({ ok: true });
        break;
      case 'deactivate':
        deactivate();
        break;
      case 'elect':
        onElect(msg.frameId);
        break;
      case 'state':
        onState(msg);
        break;
      case 'toast':
        if (msg.frameId === myFrameId) toast(msg.text);
        break;
      case 'nav-prompt':
        if (msg.frameId === myFrameId) navPrompt(msg);
        break;
    }
  });

  hello();
})();
