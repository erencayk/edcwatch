'use strict';

// Landing page for invite links (/j/ROOM). When the EdcWatch extension is
// installed its content script marks <html data-edcwatch="1"> and listens for
// the "join" message below; the extension then opens the site in this tab.

(() => {
  const $ = (id) => document.getElementById(id);
  const show = (id) => ($(id).hidden = false);

  const m = location.pathname.match(/^\/j\/([^/]+)$/);
  if (!m) return show('home');
  const room = m[1].toUpperCase();

  const nameInput = $('name');
  const joinBtn = $('join');
  const status = $('status');

  try {
    nameInput.value = localStorage.getItem('edcwatch-name') || '';
  } catch {}

  function hasExtension() {
    return document.documentElement.dataset.edcwatch === '1';
  }

  async function init() {
    let info;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(room)}`);
      if (!res.ok) throw new Error(String(res.status));
      info = await res.json();
    } catch {
      return show('gone');
    }

    $('site').textContent = new URL(info.url).hostname.replace(/^www\./, '');
    $('people').textContent = info.members > 0 ? `Odada şu an ${info.members} kişi var` : 'Odada henüz kimse yok';
    show('invite');

    // The content script runs at document_start, but give it a moment anyway.
    let waited = 0;
    const tick = setInterval(() => {
      waited += 150;
      if (hasExtension()) {
        clearInterval(tick);
        joinBtn.disabled = false;
      } else if (waited >= 900) {
        clearInterval(tick);
        $('noext').hidden = false;
      }
    }, 150);
  }

  joinBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    try {
      localStorage.setItem('edcwatch-name', name);
    } catch {}
    joinBtn.disabled = true;
    status.textContent = 'Bağlanıyor…';
    window.postMessage({ edcwatch: true, type: 'join', room, name }, location.origin);
    setTimeout(() => {
      status.textContent = 'Uzantı yanıt vermedi. Safari’de uzantının etkin olduğundan emin ol ve tekrar dene.';
      joinBtn.disabled = false;
    }, 6000);
  });

  init();
})();
