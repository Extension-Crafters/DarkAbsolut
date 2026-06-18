// Regression test: on an already-dark page, a wrapper whose CSS background-color
// is light but is COVERED by opaque dark children must NOT be tagged as a light
// island and inverted.
//
// The bug (Twitch channel page): `div.channel-root` declares
// `background-color: #fff`, but its children paint Twitch's dark theme on top,
// so the white is never visible. DarkAbsolut's light-island detector saw the
// white bg, tagged it, and inverted the whole channel subtree → every dark UI
// panel (streamer bio/title/info, chat) flipped to LIGHT. A real light island
// (a genuinely-visible white panel) must still be darkened.
//
//   node tests/test-light-island.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { decodePng, pixelLum } = require('./lib/png');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-island-'));

// 2x2 red PNG (opaque pixels, transparent CSS background) — stands in for the
// Twitch <video>: real content painted over a wrapper's white background-color.
const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8z8Dwn4EIwAgAJAUH/Vn5d8AAAAAASUVORK5CYII=';

// Dark page (so the extension detects dark, leaves root inversion OFF, and runs
// the light-island path). `.channel-root` has a white bg hidden behind opaque
// dark children (the Twitch bug). `.modal` is a genuinely-visible white panel.
const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>island</title>
<style>
  html,body{margin:0;background:#0e0e10;color:#efeff1;font-family:sans-serif}
  .channel-root{background:#ffffff;width:100%}
  .panel{background:#0e0e10;color:#efeff1;padding:24px;height:96px}
  .modal{background:#ffffff;color:#111111;padding:24px;width:340px;height:150px}
  /* white wrapper whose visible area is filled by opaque media (the <video>
     case): its bg-color is white but the real painted content is the image. */
  .player-root{background:#ffffff;width:760px;height:180px}
  .player-root img{width:100%;height:100%;display:block}
  /* white wrapper holding a large dark panel with white showing BESIDE it (the
     real channel-root pattern: the video is an external overlay, so white shows
     next to the dark info/chat panels). Must not be inverted. */
  .mixed-root{background:#ffffff;width:760px;height:160px;position:relative}
  .mixed-root .darkpane{background:#0e0e10;color:#efeff1;width:300px;height:160px}
</style></head>
<body>
  <div class="channel-root">
    <div class="panel" id="bio">Streamer bio / title / channel info (dark theme)</div>
    <div class="panel">More dark channel content below the player</div>
  </div>
  <div class="player-root" id="player"><img src="${RED}"></div>
  <div class="mixed-root" id="mixed"><div class="darkpane">dark info panel</div></div>
  <div class="modal" id="modal">A real light modal that SHOULD be darkened</div>
</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

function brightFrac(buf, thr = 0.5) {
  const { width, height, channels, data } = decodePng(buf);
  let bright = 0; const n = width * height;
  for (let i = 0; i < n; i++) if (pixelLum(data, i * channels, channels) > thr) bright++;
  return bright / n;
}

(async () => {
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/`;

  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true, channel: 'chromium', colorScheme: 'dark',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }

    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 700 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    const r = await page.evaluate(() => {
      const cr = document.querySelector('.channel-root');
      const md = document.getElementById('modal');
      const pl = document.getElementById('player');
      const mx = document.getElementById('mixed');
      return {
        root: document.documentElement.getAttribute('data-darkabsolut'),
        crTagged: cr.getAttribute('data-darkabsolut-lightnative'),
        crFilter: getComputedStyle(cr).filter,
        modalTagged: md.getAttribute('data-darkabsolut-lightnative'),
        modalFilter: getComputedStyle(md).filter,
        playerTagged: pl.getAttribute('data-darkabsolut-lightnative'),
        mixedTagged: mx.getAttribute('data-darkabsolut-lightnative'),
      };
    });

    // Page is already dark → extension must NOT root-invert.
    assert('dark page: root inversion stays off', r.root !== 'on', `root=${r.root}`);

    // The white-but-covered wrapper must NOT be treated as a light island.
    assert('covered white wrapper NOT tagged light-island', r.crTagged !== '1',
      `lightnative=${r.crTagged}`);
    assert('covered white wrapper NOT inverted', !/invert/.test(r.crFilter),
      `filter=${r.crFilter}`);

    // The bio/info area must stay dark (not flipped to a light block).
    const bioShot = await page.locator('#bio').screenshot();
    const bf = brightFrac(bioShot);
    assert('streamer bio/info area stays dark', bf < 0.10, `brightFrac=${bf.toFixed(4)}`);

    // A white wrapper filled by opaque media (the <video> case) must NOT be
    // tagged — the visible surface is the media, not the white bg.
    assert('media-covered white wrapper NOT tagged light-island', r.playerTagged !== '1',
      `lightnative=${r.playerTagged}`);

    // A white wrapper holding a large dark panel (white showing beside it — the
    // real channel-root layout with an external video overlay) must NOT be tagged.
    assert('white wrapper around dark UI NOT tagged light-island', r.mixedTagged !== '1',
      `lightnative=${r.mixedTagged}`);

    // A genuinely-visible white panel must still be darkened (no over-correction).
    assert('real visible white panel IS tagged light-island', r.modalTagged === '1',
      `lightnative=${r.modalTagged}`);
    assert('real visible white panel IS inverted', /invert/.test(r.modalFilter),
      `filter=${r.modalFilter}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
