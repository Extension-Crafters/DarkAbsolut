// Regression test: media inside a kept-dark (darknative) wrapper, and the
// vector-SVG veto exclusion.
//
//   1. A natively-dark wrapper that contains a large VECTOR <svg> must still be
//      kept dark. Vector SVGs are filter:none (text-like) and safe inside a
//      darknative wrapper, so they must NOT veto native-dark tagging. (KYM's
//      navy header is 86% covered by a decorative vector SVG; counting it kept
//      the whole header from being preserved and it flipped to a light block.)
//
//   2. Raster media inside a darknative wrapper must render at ORIGINAL colours,
//      not a colour-negative. The wrapper's own counter-invert already restores
//      its subtree; a second counter-invert on the image is a third total
//      inversion → negative (a beach/island photo staying inverted even with
//      "natural images" on). styles.js neutralises media inside darknative.
//
//   3. The raster veto still holds: a dark wrapper fronted by a LARGE raster
//      image is NOT tagged (the TripAdvisor placeholder-behind-photo case).
//
//   node tests/test-darknative-media.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { decodePng } = require('./lib/png');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-dnmedia-'));

// 2x2 pure-red PNG (opaque). Original red ⇒ R is the dominant channel. A
// colour-negative (odd number of invert+hue-rotate) would make it cyan ⇒ R no
// longer dominant. So "R is max" proves correct (even-parity) rendering.
const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8z8Dwn4EIwAgAJAUH/Vn5d8AAAAAASUVORK5CYII=';
// A DARK bg-fronted icon (phpMyAdmin pattern): a 1×1 placeholder <img src> with
// a dark SVG painted as a repeating CSS background-image. Sampled dark → tagged
// BG_ICON_ATTR. Inside a darknative wrapper it must regain ONE counter-invert so
// the dark glyph flips light (else it'd be dark-on-dark — the regression the
// adversarial review caught).
const DOT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const DARK_ICON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect x='2' y='2' width='20' height='20' fill='%23222222'/%3E%3C/svg%3E")`;

// Light page (white body → inverts, root on) with two natively-dark sections
// below the fold. #darkwrap holds a large vector <svg> + a small raster <img>.
// #photowrap is fronted by a large raster <img>.
const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>dn-media</title>
<style>
  html,body{margin:0;background:#fff;color:#111;font-family:sans-serif}
  .top{height:760px;padding:20px}            /* keep dark sections below the fold */
  .darkwrap{background:#111111;color:#eee;width:900px;height:400px;padding:10px}
  .darkwrap svg{display:block}
  .darkwrap img{width:60px;height:60px;display:block}
  .photowrap{background:#111111;width:900px;height:400px;margin-top:30px}
  .photowrap img{width:880px;height:380px;display:block}
  .icowrap{background:#0a0a0a;color:#eee;width:900px;height:200px;padding:10px;margin-top:30px}
  .icowrap .dicon{display:inline-block;width:24px;height:24px;background:${DARK_ICON} repeat}
</style></head>
<body>
  <div class="top"><h1>White page</h1><p>Plenty of light content up top.</p></div>
  <div class="darkwrap" id="darkwrap">
    <svg width="800" height="300" viewBox="0 0 800 300" xmlns="http://www.w3.org/2000/svg">
      <rect width="800" height="300" fill="#1b2a6b"/><circle cx="400" cy="150" r="120" fill="#ffcc00"/>
    </svg>
    <img id="redimg" src="${RED}" alt="red">
    <p>Kept-dark section text</p>
  </div>
  <div class="photowrap" id="photowrap"><img src="${RED}" alt="big"></div>
  <div class="icowrap" id="icowrap">
    <img class="dicon" id="dicon" src="${DOT}" alt="">
    <p>kept-dark toolbar</p>
  </div>
</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

function avgColor(buf) {
  const { width, height, channels, data } = decodePng(buf);
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
  }
  return { r: r / n, g: g / n, b: b / n };
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
    headless: true, channel: 'chromium', colorScheme: 'light',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }

    const page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    const r = await page.evaluate(() => {
      const dw = document.getElementById('darkwrap');
      const pw = document.getElementById('photowrap');
      const img = document.getElementById('redimg');
      const svg = dw.querySelector('svg');
      const iw = document.getElementById('icowrap');
      const dicon = document.getElementById('dicon');
      return {
        root: document.documentElement.getAttribute('data-darkabsolut'),
        darkwrapTagged: dw.getAttribute('data-darkabsolut-darknative'),
        darkwrapFilter: getComputedStyle(dw).filter,
        imgFilter: getComputedStyle(img).filter,
        svgFilter: getComputedStyle(svg).filter,
        photowrapTagged: pw.getAttribute('data-darkabsolut-darknative'),
        icowrapTagged: iw.getAttribute('data-darkabsolut-darknative'),
        diconBgIcon: dicon.getAttribute('data-darkabsolut-bgicon'),
        diconFilter: getComputedStyle(dicon).filter,
      };
    });

    assert('light page inverts', r.root === 'on', `root=${r.root}`);

    // (1) vector SVG doesn't veto → wrapper kept dark.
    assert('dark wrapper with large vector SVG IS kept dark', r.darkwrapTagged === '1', `darknative=${r.darkwrapTagged}`);
    assert('kept-dark wrapper carries the counter-invert', /invert/.test(r.darkwrapFilter), `filter=${r.darkwrapFilter}`);

    // (2) media inside darknative is neutralised (filter:none) → even parity.
    assert('raster <img> inside darknative is filter:none', r.imgFilter === 'none', `imgFilter=${r.imgFilter}`);
    assert('vector <svg> inside darknative is filter:none', r.svgFilter === 'none', `svgFilter=${r.svgFilter}`);

    // (2b) and it actually renders RED (original), not cyan (negative).
    await page.evaluate(() => document.getElementById('redimg').scrollIntoView());
    await page.waitForTimeout(150);
    const shot = await page.locator('#redimg').screenshot();
    const c = avgColor(shot);
    assert('red image renders red (not a colour-negative)', c.r > c.g + 30 && c.r > c.b + 30,
      `rgb(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`);

    // (3) raster veto still holds for a large image-fronted dark wrapper.
    assert('dark wrapper fronted by large raster image NOT tagged', r.photowrapTagged !== '1',
      `darknative=${r.photowrapTagged}`);

    // (4) a DARK bg-icon inside a kept-dark wrapper must regain one counter-
    // invert (so the dark glyph flips light) — not stay dark-on-dark.
    assert('icon wrapper kept dark', r.icowrapTagged === '1', `darknative=${r.icowrapTagged}`);
    assert('dark bg-icon is classified (bgicon attr)', r.diconBgIcon === '1', `bgicon=${r.diconBgIcon}`);
    assert('dark bg-icon inside darknative keeps a counter-invert (stays visible)',
      /invert/.test(r.diconFilter), `diconFilter=${r.diconFilter}`);
    await page.evaluate(() => document.getElementById('dicon').scrollIntoView());
    await page.waitForTimeout(150);
    const iconShot = await page.locator('#dicon').screenshot();
    const ic = avgColor(iconShot);
    const iconLum = (0.2126 * ic.r + 0.7152 * ic.g + 0.0722 * ic.b) / 255;
    assert('dark bg-icon renders LIGHT on the kept-dark wrapper (not dark-on-dark)',
      iconLum > 0.45, `lum=${iconLum.toFixed(2)} rgb(${ic.r.toFixed(0)},${ic.g.toFixed(0)},${ic.b.toFixed(0)})`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
