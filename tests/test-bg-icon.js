// Regression test: an <img> icon painted via CSS background-image over a 1×1
// placeholder src (the phpMyAdmin pattern) is colour-classified by sampling the
// real icon pixels — DARK icons invert with the theme (→ light), LIGHT icons
// keep their counter-invert. Reproduces the phpMyAdmin 5.2.3 + bootstrap-theme
// bug: bootstrap icons are dark SVGs with background-repeat:repeat, which the
// generic "repeating tile" path used to counter-invert (leaving them dark-on-
// dark). The colour-aware classifier must take precedence for such icons.
//
//   node tests/test-bg-icon.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { decodePng, pixelLum } = require('./lib/png');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-bgicon-'));

const DOT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8z8Dwn4EIwAgAJAUH/Vn5d8AAAAAASUVORK5CYII=';
// Dark icon (fill #222) and light icon (fill #ddd), each painted as a repeating
// background-image (mimicking the bootstrap theme's `background-repeat:repeat`).
const SVG = (hex, w = 24, h = 24, rw = 20, rh = 20) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'%3E%3Crect x='2' y='2' width='${rw}' height='${rh}' fill='%23${hex}'/%3E%3C/svg%3E")`;
// A WHITE monochrome logo as a real <img> src (the omori store-badge case).
const WHITE_LOGO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='40'%3E%3Crect x='4' y='4' width='92' height='32' fill='%23ffffff'/%3E%3C/svg%3E";

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>bgicon</title>
<style>
  html,body{margin:0;background:#fff;font-family:sans-serif}
  .dark{display:inline-block;width:24px;height:24px;background:${SVG('222222')} repeat}
  .light{display:inline-block;width:24px;height:24px;background:${SVG('dddddd')} repeat}
  /* black button fronting a white logo <img> (omori "available on" buttons) */
  .darkbtn{display:inline-block;background:#000000;padding:6px}
  .darkbtn img{display:block;width:100px;height:40px}
</style></head>
<body>
  <img class="dark"  id="dark"  src="${DOT}" alt="">
  <img class="light" id="light" src="${DOT}" alt="">
  <img id="photo" src="${RED}" width="64" height="64" alt="">
  <span class="darkbtn"><img id="logo" src="${WHITE_LOGO}" alt=""></span>
  ${'<p>filler text to fill the viewport. </p>'.repeat(25)}
</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}
function brightFrac(buf, thr = 0.5) {
  const { width, height, channels, data } = decodePng(buf);
  let b = 0; const n = width * height;
  for (let i = 0; i < n; i++) if (pixelLum(data, i * channels, channels) > thr) b++;
  return b / n;
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
    await page.waitForTimeout(1500); // allow async icon-colour sampling to settle

    const r = await page.evaluate(() => ({
      root: document.documentElement.getAttribute('data-darkabsolut'),
      darkBgIcon: document.getElementById('dark').getAttribute('data-darkabsolut-bgicon'),
      darkFilter: getComputedStyle(document.getElementById('dark')).filter,
      lightBgIcon: document.getElementById('light').getAttribute('data-darkabsolut-bgicon'),
      photoBgIcon: document.getElementById('photo').getAttribute('data-darkabsolut-bgicon'),
      photoFilter: getComputedStyle(document.getElementById('photo')).filter,
    }));

    assert('page is inverted', r.root === 'on', `root=${r.root}`);

    // Dark icon: classified dark → neutralised → inverts with theme → light.
    assert('dark bg-icon tagged (color-aware, despite bg-repeat)', r.darkBgIcon === '1', `bgicon=${r.darkBgIcon}`);
    assert('dark bg-icon filter neutralised', r.darkFilter === 'none', `filter=${r.darkFilter}`);
    const darkBf = brightFrac(await page.locator('#dark').screenshot());
    assert('dark icon now renders light (readable)', darkBf > 0.1, `brightFrac=${darkBf.toFixed(4)}`);

    // Light icon: classified light → NOT tagged → keeps counter-invert → light.
    assert('light bg-icon NOT tagged', r.lightBgIcon !== '1', `bgicon=${r.lightBgIcon}`);
    const lightBf = brightFrac(await page.locator('#light').screenshot());
    assert('light icon stays readable', lightBf > 0.1, `brightFrac=${lightBf.toFixed(4)}`);

    // Real photo img: not bg-fronted, NOT monochrome → keeps counter-invert.
    assert('real photo img NOT tagged bgicon', r.photoBgIcon !== '1', `bgicon=${r.photoBgIcon}`);
    assert('real photo img keeps counter-invert', /invert/.test(r.photoFilter), `filter=${r.photoFilter}`);

    // Real <img> WHITE logo on a black button (omori): the button page-inverts to
    // white; the white logo must invert too (→ dark) so it stays visible.
    const logo = await page.evaluate(() => ({
      bgicon: document.getElementById('logo').getAttribute('data-darkabsolut-bgicon'),
      filter: getComputedStyle(document.getElementById('logo')).filter,
    }));
    assert('white logo on dark button tagged (invert with theme)', logo.bgicon === '1', `bgicon=${logo.bgicon}`);
    assert('white logo filter neutralised', logo.filter === 'none', `filter=${logo.filter}`);
    const logoBf = brightFrac(await page.locator('#logo').screenshot());
    assert('white logo now renders dark (visible on white button)', logoBf < 0.4, `brightFrac=${logoBf.toFixed(4)}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
