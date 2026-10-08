'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

const ERRORS = {
  network: 'Sunucuya ulaşılamıyor. Sunucu adresini ve internetini kontrol et.',
  'bad-url': 'Geçerli bir site linki gir (http:// veya https:// ile başlamalı).',
  'bad-invite': 'Bu bir davet linkine ya da 6 haneli koda benzemiyor.',
  'bad-server': 'Sunucu adresi geçersiz.',
  'room-not-found': 'Oda bulunamadı. Link eski olabilir ya da oda kapanmış.',
  'room-full': 'Oda dolu.',
  replaced: 'Bu oda başka bir yerden açıldı. Odadan ayrılıp tekrar katıl.',
  'rate-limited': 'Çok fazla oda kuruldu, biraz sonra tekrar dene.',
  busy: 'Sunucu şu an meşgul, biraz sonra tekrar dene.',
};

let status = null;
let tab = null;

const call = (msg) => Promise.resolve(api.runtime.sendMessage(msg)).catch(() => undefined);

function banner(text, kind) {
  const el = $('banner');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('info', kind === 'info');
}

const errorText = (code) => ERRORS[code] || `Bir hata oluştu (${code || 'bilinmiyor'}).`;

function isHttp(url) {
  return /^https?:\/\//i.test(url || '');
}

function render() {
  if (!status) {
    banner('Eklenti arka planı yanıt vermiyor. Safari’de eklentiyi kapatıp açmayı dene.');
    return;
  }
  const inRoom = !!status.room;
  $('view-start').hidden = inRoom;
  $('view-room').hidden = !inRoom;

  if (status.error) banner(errorText(status.error));
  else if (!$('banner').classList.contains('info')) banner('');

  if (!inRoom) {
    if (document.activeElement !== $('name')) $('name').value = status.settings.name || '';
    if (document.activeElement !== $('server')) $('server').value = status.settings.server;
    const site = $('site-url');
    if (!site.value && tab && isHttp(tab.url) && new URL(tab.url).origin !== new URL(status.settings.server).origin) {
      site.value = tab.url;
    }
    return;
  }

  const dot = $('dot');
  dot.className = 'dot' + (status.connected ? ' ok' : status.error ? ' err' : '');
  $('conn').textContent = status.connected ? 'Bağlı' : 'Bağlanıyor…';
  $('code').textContent = status.room;
  $('video-state').textContent = status.hasVideo
    ? 'Video bulundu, senkron aktif.'
    : 'Video aranıyor… Sayfada filmi başlat veya oynat tuşuna bas.';

  const list = $('members');
  list.textContent = '';
  for (const m of status.members) {
    const li = document.createElement('li');
    li.textContent = m.name;
    if (m.id === status.you) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = '  (sen)';
      li.append(you);
    }
    list.append(li);
  }
  if (status.members.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Henüz kimse yok';
    list.append(li);
  }
  $('btn-share').hidden = !navigator.share;
}

async function refresh() {
  status = await call({ type: 'status' });
  try {
    [tab] = await api.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }
  render();
}

async function saveName() {
  await call({ type: 'settings', name: $('name').value });
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

$('name').addEventListener('change', saveName);

$('btn-create').addEventListener('click', async () => {
  const url = $('site-url').value.trim();
  if (!isHttp(url)) return banner(errorText('bad-url'));
  const btn = $('btn-create');
  btn.disabled = true;
  banner('');
  await saveName();
  const sameAsTab = tab && isHttp(tab.url) && tab.url.split('#')[0] === url.split('#')[0];
  const res = await call({ type: 'create', url, tabId: sameAsTab ? tab.id : undefined });
  btn.disabled = false;
  if (!res || !res.ok) return banner(errorText(res && res.error));
  const copied = await copy(res.link);
  banner(copied ? 'Davet linki kopyalandı. Arkadaşına gönder!' : 'Oda hazır. Davet linkini aşağıdan kopyala.', 'info');
  await refresh();
});

$('btn-join').addEventListener('click', async () => {
  const input = $('invite').value.trim();
  if (!input) return;
  const btn = $('btn-join');
  btn.disabled = true;
  banner('');
  await saveName();
  const res = await call({ type: 'join', input });
  btn.disabled = false;
  if (!res || !res.ok) return banner(errorText(res && res.error));
  await refresh();
});

$('btn-leave').addEventListener('click', async () => {
  await call({ type: 'leave' });
  banner('');
  await refresh();
});

$('btn-copy').addEventListener('click', async () => {
  if (!status || !status.link) return;
  banner((await copy(status.link)) ? 'Davet linki kopyalandı.' : status.link, 'info');
});

$('btn-share').addEventListener('click', async () => {
  if (!status || !status.link) return;
  try {
    await navigator.share({ title: 'EdcWatch', text: 'Birlikte izleyelim!', url: status.link });
  } catch {}
});

$('btn-save-server').addEventListener('click', async () => {
  const res = await call({ type: 'settings', server: $('server').value });
  if (!res || !res.ok) return banner(errorText(res && res.error));
  banner('Sunucu kaydedildi.', 'info');
  await refresh();
});

api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'status-changed') refresh();
});

refresh();
