'use strict';

// Runs in the page's own JS world (injected by content.js, Netflix only).
// Netflix's player rejects `video.currentTime = x`, so seeking goes through its
// internal player API instead.

(() => {
  if (window.__edcBridge) return;
  window.__edcBridge = true;

  function netflixPlayer() {
    const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
    const ids = vp.getAllPlayerSessionIds();
    const id = ids.find((x) => String(x).startsWith('watch')) || ids[0];
    return vp.getVideoPlayerBySessionId(id);
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.edcwatch !== 'cmd') return;
    let ok = false;
    try {
      if (d.op === 'seek' && Number.isFinite(d.ms)) {
        netflixPlayer().seek(Math.max(0, Math.round(d.ms)));
        ok = true;
      }
    } catch {}
    window.postMessage({ edcwatch: 'res', id: d.id, ok }, '*');
  });
})();
