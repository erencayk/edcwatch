'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const { until, readVideo, play, pause, seek } = H;

// Two real browsers with the extension, one relay server, one "movie site".
const ctx = {};

test.before(async () => {
  H.ensureFixtures();
  if (process.env.EDC_TEST_URL) {
    // e.g. `wrangler dev`: run the whole browser suite against the Cloudflare Worker
    ctx.relayUrl = new URL(process.env.EDC_TEST_URL).origin;
    ctx.relayPort = Number(new URL(ctx.relayUrl).port);
  } else {
    ctx.relay = H.createApp();
    ctx.relayPort = await ctx.relay.listen(0, '127.0.0.1');
    ctx.relayUrl = `http://127.0.0.1:${ctx.relayPort}`;
  }

  // site A (the page the user opens) and site B (a different origin that hosts
  // the actual player, like the embed hosts of streaming sites)
  ctx.siteB = await H.startSite({
    '/player.html': H.page('Player', H.VIDEO()),
    '/movie.html': H.page('Movie on another host', H.VIDEO()),
    '/ad.html': H.page('Ad', '<video id="ad" src="/ad.webm" width="300" height="170" autoplay loop muted></video>'),
  }, { host: 'localhost' });
  ctx.site = await H.startSite({
    '/movie.html': H.page('Movie 1', H.VIDEO()),
    '/movie2.html': H.page('Movie 2', H.VIDEO()),
    '/autoplay.html': H.page('Autoplay', H.VIDEO('autoplay')),
    // Source arrives late; the site's own script then restarts from 0 and plays,
    // i.e. it fights the sync right after we have joined the room.
    '/late.html': H.page(
      'Late autoplay',
      `<video id="v" width="640" height="360" controls preload="auto"></video>
       <script>
         const v = document.getElementById('v');
         setTimeout(() => {
           v.addEventListener('loadedmetadata', () => { v.currentTime = 0; v.play().catch(() => {}); });
           v.src = '/movie.webm';
         }, 1500);
       </script>`,
    ),
    '/embed.html': H.page(
      'Embed',
      `<h1 style="color:#fff">Pirate-ish site</h1>
       <iframe id="ad" src="${ctx.siteB.origin}/ad.html" width="300" height="170" style="border:0"></iframe>
       <iframe id="player" src="${ctx.siteB.origin}/player.html" width="660" height="380" style="border:0"></iframe>`,
    ),
  });

  ctx.eren = await H.launchPerson('Eren');
  ctx.doga = await H.launchPerson('Doğa');
  await ctx.eren.configure(ctx.relayUrl);
  await ctx.doga.configure(ctx.relayUrl);
});

test.after(async () => {
  await ctx.eren?.close();
  await ctx.doga?.close();
  await ctx.site?.close();
  await ctx.siteB?.close();
  await ctx.relay?.close();
});


// Every scenario starts from "nobody is in a room, only the helper page is open".
async function resetAll() {
  for (const p of [ctx.eren, ctx.doga]) {
    if (!p) continue;
    await p.call({ type: 'leave' }).catch(() => {});
    for (const page of p.ctx.pages()) if (page !== p.ext) await page.close().catch(() => {});
  }
  await ctx.doga?.ctx.clearCookies().catch(() => {});
}

function scenario(name, fn) {
  return test(name, async (t) => {
    try {
      await fn(t);
    } finally {
      await resetAll();
    }
  });
}

/** Eren creates a room for `url` through the real popup UI. */
async function createRoomFor(url) {
  const { eren } = ctx;
  const popup = await eren.ctx.newPage();
  await popup.goto(`chrome-extension://${eren.extId}/popup.html`);
  await popup.fill('#site-url', url);
  const erenTabPromise = eren.ctx.waitForEvent('page');
  await popup.click('#btn-create');
  const erenPage = await erenTabPromise;
  await popup.close();

  const st = await until(async () => {
    const s = await eren.status();
    return s.room && s.connected && s;
  }, { message: 'Eren connected' });
  return { room: st.room, link: st.link, erenPage, url };
}

/** Somebody taps an invite link, lands on our page and presses the button. */
async function joinWithLink(person, link, url) {
  const landing = await person.ctx.newPage();
  await landing.goto(link);
  await landing.waitForSelector('#join:not([disabled])');
  await landing.fill('#name', person.name);
  await landing.click('#join');
  await landing.waitForURL(url);
  await until(async () => (await person.status()).connected, { message: `${person.name} connected` });
  return landing;
}

async function startParty(url) {
  const room = await createRoomFor(url);
  const dogaPage = await joinWithLink(ctx.doga, room.link, url);
  return { ...room, dogaPage };
}

async function stopParty() {
  await ctx.eren.call({ type: 'leave' });
  await ctx.doga.call({ type: 'leave' });
}

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${a} ≈ ${b} (±${tol})`);

scenario('two people, one room: invite, play, pause, seek', async (t) => {
  await t.test('invite flow: popup creates the room, the landing page joins it, both find the video', async () => {
    const { eren, doga } = ctx;
    const party = await startParty(`${ctx.site.origin}/movie.html`);
    ctx.party = party;

    assert.equal((await eren.status()).members.length, 2);
    await until(async () => (await eren.status()).hasVideo && (await doga.status()).hasVideo, { message: 'both players detected' });
    assert.deepEqual((await eren.status()).members.map((m) => m.name).sort(), ['Doğa', 'Eren']);
  });

  await t.test('play / pause / seek on one side is mirrored on the other, both directions', async () => {
    const { erenPage, dogaPage } = ctx.party;

    await play(erenPage);
    await until(async () => !(await readVideo(dogaPage)).paused, { message: 'Doğa starts playing' });
    await H.sleep(1500);
    let e = await readVideo(erenPage);
    let f = await readVideo(dogaPage);
    near(e.t, f.t, 0.8, 'playing in sync');

    await pause(erenPage);
    await until(async () => (await readVideo(dogaPage)).paused, { message: 'Doğa pauses' });
    e = await readVideo(erenPage);
    f = await readVideo(dogaPage);
    near(e.t, f.t, 0.5, 'paused at the same spot');

    await seek(erenPage, 60);
    await until(async () => Math.abs((await readVideo(dogaPage)).t - 60) < 0.5, { message: 'Doğa seeks to 60' });
    assert.equal((await readVideo(dogaPage)).paused, true);

    // other direction
    await play(dogaPage);
    await until(async () => !(await readVideo(erenPage)).paused, { message: 'Eren follows Doğa' });
    await H.sleep(1200);
    near((await readVideo(erenPage)).t, (await readVideo(dogaPage)).t, 0.8, 'Doğa drives');

    await seek(dogaPage, 20);
    await until(async () => Math.abs((await readVideo(erenPage)).t - 20) < 1.5, { message: 'Eren seeks to ~20' });
    assert.equal((await readVideo(erenPage)).paused, false);

    await pause(dogaPage);
    await until(async () => (await readVideo(erenPage)).paused, { message: 'Eren pauses' });
  });

  await t.test('no feedback loop: after a pause, the room stays quiet', async () => {
    const room = ctx.party.room;
    const obs = await H.observeRoom(ctx.relayPort, room);
    await H.sleep(2500);
    assert.equal(obs.states.length, 0, `unexpected chatter: ${JSON.stringify(obs.states)}`);
    obs.close();
  });

  await t.test('rapid actions converge on the same final state', async () => {
    const { erenPage, dogaPage } = ctx.party;
    await play(erenPage);
    await H.sleep(300);
    await Promise.all([pause(dogaPage), seek(erenPage, 100)]);
    await H.sleep(2500);
    const e = await readVideo(erenPage);
    const f = await readVideo(dogaPage);
    assert.equal(e.paused, f.paused, 'same play state');
    near(e.t, f.t, 1.0, 'same position');
    if (!e.paused) {
      await pause(erenPage);
      await until(async () => (await readVideo(dogaPage)).paused);
    }
  });


});

scenario('player inside a cross-origin iframe is synced, the ad video next to it is left alone', async () => {
  const { eren, doga } = ctx;
  const party = await startParty(`${ctx.site.origin}/embed.html`);
  const frameOf = (page, name) => page.frames().find((f) => f.url().includes(name));

  await until(async () => (await eren.status()).hasVideo && (await doga.status()).hasVideo, { message: 'players detected' });
  const ePlayer = frameOf(party.erenPage, '/player.html');
  const fPlayer = frameOf(party.dogaPage, '/player.html');
  const eAd = frameOf(party.erenPage, '/ad.html');
  const fAd = frameOf(party.dogaPage, '/ad.html');

  await play(ePlayer);
  await until(async () => !(await readVideo(fPlayer)).paused, { message: 'Doğa iframe player plays' });
  await H.sleep(1200);
  near((await readVideo(ePlayer)).t, (await readVideo(fPlayer)).t, 0.8, 'iframe players in sync');

  await seek(fPlayer, 45);
  await until(async () => Math.abs((await readVideo(ePlayer)).t - 45) < 1.5, { message: 'Eren iframe seeks to ~45' });

  await pause(ePlayer);
  await until(async () => (await readVideo(fPlayer)).paused, { message: 'Doğa iframe pauses' });

  // the looping ad video was never paused by any of this
  assert.equal((await readVideo(eAd, '#ad')).paused, false, 'ad on Eren side keeps playing');
  assert.equal((await readVideo(fAd, '#ad')).paused, false, 'ad on Doğa side keeps playing');

  await stopParty();
  await party.erenPage.close();
  await party.dogaPage.close();
});

for (const [label, file] of [['an autoplaying page', 'autoplay.html'], ['a page that restarts from 0 after loading', 'late.html']]) {
  scenario(`joining a running room: ${label} does not reset the room`, async () => {
    const { doga } = ctx;
    const url = `${ctx.site.origin}/${file}`;
    const room = await createRoomFor(url);

    // Eren's page starts by itself; wait until the room is playing and well past 0.
    await until(async () => !(await readVideo(room.erenPage)).paused, { message: 'Eren autoplay' });
    await H.sleep(6000);
    const obs = await H.observeRoom(ctx.relayPort, room.room);
    const erenBefore = (await readVideo(room.erenPage)).t;
    assert.ok(erenBefore > 5, `Eren is at ${erenBefore}`);

    const dogaPage = await joinWithLink(doga, room.link, url);
    await until(async () => {
      const f = await readVideo(dogaPage);
      return !f.paused && f.t > 5;
    }, { timeout: 12000, message: 'Doğa jumped to the room position' });
    await H.sleep(3000);

    const e = await readVideo(room.erenPage);
    const f = await readVideo(dogaPage);
    assert.ok(e.t > erenBefore, 'Eren kept playing forward');
    assert.equal(e.paused, false);
    near(e.t, f.t, 1.5, 'joiner is in sync with the room');
    const resets = obs.states.filter((s) => s.position < 3 || s.playing === false);
    assert.equal(resets.length, 0, `joiner must not reset the room: ${JSON.stringify(resets)}`);
    obs.close();
  });
}

scenario('slow connection: the others wait while one video buffers, then everybody continues together', async () => {
  const { eren, doga } = ctx;
  await doga.ctx.addCookies([{ name: 'slow', value: '1', url: ctx.site.origin }]);
  ctx.site.state.slowSeekMs = 5000;
  const party = await startParty(`${ctx.site.origin}/movie.html`);
  await until(async () => (await eren.status()).hasVideo && (await doga.status()).hasVideo, { message: 'players detected' });
  const obs = await H.observeRoom(ctx.relayPort, party.room);

  await play(party.erenPage);
  await until(async () => !(await readVideo(party.dogaPage)).paused, { message: 'Doğa plays' });
  await H.sleep(1500);

  // Eren jumps far ahead: Eren's fast connection has it quickly, Doğa's does not.
  await seek(party.erenPage, 200);
  await until(() => obs.states.some((s) => s.reason === 'hold'), { timeout: 9000, message: 'room goes on hold' });
  const hold = obs.states.find((s) => s.reason === 'hold');
  assert.deepEqual(hold.hold.names, ['Doğa']);
  await until(async () => (await readVideo(party.erenPage)).paused, { timeout: 3000, message: 'Eren is held' });

  await until(() => obs.states.some((s) => s.reason === 'resume'), { timeout: 20000, message: 'room resumes' });
  await until(async () => !(await readVideo(party.erenPage)).paused && !(await readVideo(party.dogaPage)).paused, { message: 'both playing again' });
  await H.sleep(2000);
  const e = await readVideo(party.erenPage);
  const f = await readVideo(party.dogaPage);
  near(e.t, f.t, 1.5, 'back in sync after the stall');
  assert.ok(e.t > 195, `still around the seek target (${e.t})`);

  obs.close();
  await doga.ctx.clearCookies();
  await stopParty();
  await party.erenPage.close();
  await party.dogaPage.close();
});

scenario('autoplay blocked (like iPad Safari): a tap button appears and joins the playback', async () => {
  const { eren } = ctx;
  const misafir = await H.launchPerson('Misafir', { autoplay: false });
  try {
    await misafir.configure(ctx.relayUrl);
    const party = await createRoomFor(`${ctx.siteB.origin}/movie.html`);
    // The film site has a different host than the relay, so the invite-page click does not unlock autoplay.
    await play(party.erenPage);
    await H.sleep(2000);

    const page = await joinWithLink(misafir, party.link, `${ctx.siteB.origin}/movie.html`);
    await until(async () => (await misafir.status()).hasVideo, { message: 'Misafir player detected' });
    const tap = page.locator('[data-edcwatch-ui] >> text=Birlikte izlemeye başla');
    await tap.waitFor({ state: 'visible', timeout: 8000 });
    assert.equal((await readVideo(page)).paused, true, 'blocked until the user taps');

    await tap.click();
    await until(async () => !(await readVideo(page)).paused, { message: 'tap starts playback' });
    await H.sleep(1500);
    near((await readVideo(party.erenPage)).t, (await readVideo(page)).t, 1.2, 'tapped player is in sync');
    await tap.waitFor({ state: 'hidden', timeout: 3000 });

    // later actions of the partner now go through without another tap
    await pause(party.erenPage);
    await until(async () => (await readVideo(page)).paused, { message: 'Misafir pauses with Eren' });
    await play(party.erenPage);
    await until(async () => !(await readVideo(page)).paused, { message: 'Misafir plays again with Eren' });

    await eren.call({ type: 'leave' });
    await party.erenPage.close();
  } finally {
    await misafir.close();
  }
});

scenario('episode change: the other side gets a prompt, follows, and stays in the room', async () => {
  const { eren, doga } = ctx;
  const party = await startParty(`${ctx.site.origin}/movie.html`);
  await until(async () => (await eren.status()).hasVideo && (await doga.status()).hasVideo, { message: 'players detected' });

  await party.erenPage.goto(`${ctx.site.origin}/movie2.html`);
  const go = party.dogaPage.locator('[data-edcwatch-ui] >> text=Git');
  await go.waitFor({ state: 'visible', timeout: 10000 });
  const info = await (await fetch(`${ctx.relayUrl}/api/rooms/${party.room}`)).json();
  assert.equal(info.url, `${ctx.site.origin}/movie2.html`);

  await go.click();
  await party.dogaPage.waitForURL(`${ctx.site.origin}/movie2.html`);
  await until(async () => (await eren.status()).hasVideo && (await doga.status()).hasVideo, { message: 'players detected again' });

  await play(party.erenPage);
  await until(async () => !(await readVideo(party.dogaPage)).paused, { message: 'sync continues on the new page' });

  await stopParty();
  await party.erenPage.close();
  await party.dogaPage.close();
});

scenario('connection drop: clients reconnect on their own and pick up the current state', async () => {
  const { eren, doga } = ctx;
  const party = await startParty(`${ctx.site.origin}/movie.html`);
  await until(async () => (await eren.status()).hasVideo && (await doga.status()).hasVideo, { message: 'players detected' });
  await play(party.erenPage);
  await until(async () => !(await readVideo(party.dogaPage)).paused);

  // Cut Doğa's socket, and change the room while she is away.
  await doga.sw.evaluate(() => S.ws.close());
  await until(async () => !(await doga.status()).connected, { message: 'Doğa noticed the drop' });
  await pause(party.erenPage);
  await seek(party.erenPage, 77);
  await until(async () => (await doga.status()).connected, { timeout: 10000, message: 'Doğa reconnected' });

  await until(async () => {
    const f = await readVideo(party.dogaPage);
    return f.paused && Math.abs(f.t - 77) < 0.6;
  }, { timeout: 8000, message: 'Doğa caught up with the room' });

  await stopParty();
  await party.erenPage.close();
  await party.dogaPage.close();
});

scenario('background worker killed by the browser: it wakes up, reconnects and the sync keeps working', async (t) => {
  const { eren, doga } = ctx;
  const party = await startParty(`${ctx.site.origin}/movie.html`);
  await until(async () => (await eren.status()).hasVideo && (await doga.status()).hasVideo, { message: 'players detected' });
  await play(party.erenPage);
  await until(async () => !(await readVideo(party.dogaPage)).paused);

  // Kill Doğa's service worker the way Chrome does after idling.
  const cdp = await doga.ctx.newCDPSession(doga.ext);
  const history = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (e) =>
    e.versions.filter((v) => v.scriptURL.includes(doga.extId)).forEach((v) => history.push({ id: v.versionId, status: v.runningStatus })));
  await cdp.send('ServiceWorker.enable');
  t.after(() => cdp.detach().catch(() => {}));
  await until(() => history.some((h) => h.status === 'running'), { message: 'service worker listed' });
  const versionId = history.find((h) => h.status === 'running').id;
  await cdp.send('ServiceWorker.stopWorker', { versionId });
  await until(() => history.some((h) => h.status === 'stopped'), { message: 'worker stopped' });

  // Eren pauses and seeks while Doğa's worker is down; the next message wakes it again.
  await pause(party.erenPage);
  await seek(party.erenPage, 33);

  const status = await until(async () => {
    const st = await doga.status();
    return st.room && st.connected && st;
  }, { timeout: 10000, message: 'Doğa reconnected after worker restart' });
  assert.equal(status.room, party.room);
  const i = history.findIndex((h) => h.status === 'stopped');
  assert.ok(history.slice(i).some((h) => h.status === 'running'), 'the worker really was restarted');

  await until(async () => {
    const f = await readVideo(party.dogaPage);
    return f.paused && Math.abs(f.t - 33) < 0.6;
  }, { timeout: 10000, message: 'Doğa caught up after the restart' });

  // the player is elected again, so Doğa's actions reach Eren
  await until(async () => (await doga.status()).hasVideo, { timeout: 8000, message: 'player re-elected' });
  const obs = await H.observeRoom(ctx.relayPort, party.room);
  await play(party.dogaPage);
  try {
    await until(async () => !(await readVideo(party.erenPage)).paused, { message: 'Eren follows Doğa after her restart' });
  } catch (e) {
    console.log('DEBUG states seen by server:', JSON.stringify(obs.states), 'doga video', JSON.stringify(await readVideo(party.dogaPage)), 'doga status', JSON.stringify(await doga.status()));
    throw e;
  }
});
