// Regression test: an <img>/<video> inside a counter-inverted wrapper must not
// be triple-inverted into a colour-negative.
//
// The bug (TripAdvisor restaurant cards): a card's image carousel had a dark
// placeholder background-color, so the wrapper was tagged "native dark" and
// counter-inverted. The <img> inside is ALSO counter-inverted by its own rule,
// so it ended up inverted 3× (html + wrapper + img) = a colour-negative photo.
// Wrappers that front a large image/video must therefore NOT be counter-inverted
// (native-dark OR cover-bg paths) — the media keeps itself correct.
//
//   node tests/test-nested-media.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-nested-'));

// 2x2 red PNG (quote-free).
const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8z8Dwn4EIwAgAJAUH/Vn5d8AAAAAASUVORK5CYII=';

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>nested</title>
<style>html,body{margin:0;background:#fff;color:#111;font-family:sans-serif}
#control{width:240px;height:160px}
/* dark placeholder wrapper (the carousel pattern) holding a full-size image */
.carousel{background:#0a0a0a;width:240px;height:160px;overflow:hidden}
.carousel img{width:240px;height:160px;display:block}
/* cover-bg wrapper that also fronts a real <img> */
.coverwrap{background:#222 url(${RED}) no-repeat center / cover;width:240px;height:160px}
.coverwrap img{width:240px;height:160px;display:block}
</style></head>
<body>
<h1>Light page</h1>
<img id="control" src="${RED}">
<div class="carousel"><img id="carimg" src="${RED}"></div>
<div class="coverwrap"><img id="coverimg" src="${RED}"></div>
${'<p>filler text to fill the viewport</p>'.repeat(25)}
</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
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
    headless: true, channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }

    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 700 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(1200);

    const r = await page.evaluate(() => {
      // number of `filter: invert` in the element's ancestor-or-self chain;
      // media must end EVEN (true colours), odd = colour-negative.
      function invCount(el) { let n = 0, c = el; while (c) { if (/invert/.test(getComputedStyle(c).filter)) n++; c = c.parentElement; } return n; }
      const car = document.querySelector('.carousel');
      const cov = document.querySelector('.coverwrap');
      return {
        root: document.documentElement.getAttribute('data-darkabsolut'),
        control: invCount(document.getElementById('control')),
        carImg: invCount(document.getElementById('carimg')),
        coverImg: invCount(document.getElementById('coverimg')),
        carouselNative: car.getAttribute('data-darkabsolut-darknative'),
        coverTagged: cov.getAttribute('data-darkabsolut-bg'),
      };
    });

    assert('page is inverted', r.root === 'on', `root=${r.root}`);
    assert('control <img> even-inverted (correct)', r.control % 2 === 0, `inverts=${r.control}`);
    assert('image in dark wrapper NOT triple-inverted', r.carImg % 2 === 0, `inverts=${r.carImg}`);
    assert('dark wrapper not tagged native-dark', r.carouselNative !== '1', `darknative=${r.carouselNative}`);
    assert('image in cover-bg wrapper NOT triple-inverted', r.coverImg % 2 === 0, `inverts=${r.coverImg}`);
    assert('cover-bg wrapper fronting <img> not tagged', r.coverTagged !== '1', `bg=${r.coverTagged}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
