// Regression test: a large, FEATURELESS light <img> used as a section's backdrop
// behind dark text is darkened with the theme instead of kept light.
//
// Every <img> is counter-inverted so photos keep their true colours. On
// microsoft.com the hero's background is an <img> (a pale abstract image,
// 1280×1883) with the section's text painted over it: it stayed a huge light
// surface while the dark headline on it was inverted to light → light on light.
//
//   1. Such a backdrop is tagged data-darkabsolut-invertmedia (filter:none) and
//      renders dark.
//   2. Unchanged — these keep the counter-invert (true colours):
//        • a picture with a dark subject under dark text (it would turn into a
//          colour-negative);
//        • a LIGHT product shot on a pale ground under dark text — light nearly
//          everywhere, but it has edges (apple.com's tiles);
//        • a dark picture under LIGHT text (a hero photo);
//        • a light image with no text painted over it (a content image, even
//          with a caption right below);
//        • a light image whose only text sits in an opaque card;
//        • a cross-origin image served without CORS (pixels unreadable).
//
//   node tests/test-backdrop-img.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { decodePng } = require('./lib/png');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-backdrop-'));

const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">${body}</svg>`;
const IMAGES = {
  // Pale abstract wash: every pixel light.
  '/light.svg': svg('<rect width="1200" height="800" fill="#fdeee6"/><circle cx="900" cy="250" r="320" fill="#e6eefc"/>'),
  // Light backdrop with a dark subject covering a quarter of it.
  '/subject.svg': svg('<rect width="1200" height="800" fill="#f4f4f4"/><rect x="300" y="200" width="600" height="400" fill="#223344"/>'),
  // Light subject on a pale ground: no dark pixel, but edges.
  '/product.svg': svg('<rect width="1200" height="800" fill="#f5f5f7"/><rect x="450" y="250" width="300" height="420" rx="30" fill="#b0b6c0"/>'),
  '/dark.svg': svg('<rect width="1200" height="800" fill="#1c2a3a"/>'),
};

const page1 = other => `<!doctype html><html><head><meta charset=utf-8><title>backdrop-img</title>
<style>
  html,body{margin:0;background:#fff;color:#1a1a1a;font-family:sans-serif}
  .sec{position:relative;width:900px;height:400px;margin-bottom:20px;background:#fff9f5}
  .bd{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
  .ct{position:relative;padding:60px 40px}
  .ct h2{margin:0 0 12px}
  .light h2,.light p{color:#fff}
  .card{position:relative;margin:60px 40px;padding:20px;background:#fff;width:300px}
  .fig{width:900px;margin-bottom:20px}
  .fig img{display:block;width:900px;height:400px}
  .fig p{margin:0;height:30px;line-height:30px}
</style></head>
<body>
  <div class="sec" id="s1"><img class="bd" id="b1" src="/light.svg" alt=""><div class="ct"><h2 id="h1">Hi there, welcome</h2><p>Dark text on a pale backdrop.</p></div></div>
  <div class="sec" id="s2"><img class="bd" id="b2" src="/subject.svg" alt=""><div class="ct"><h2>Dark text over a picture</h2></div></div>
  <div class="sec light" id="s3"><img class="bd" id="b3" src="/dark.svg" alt=""><div class="ct"><h2>Light text over a dark picture</h2></div></div>
  <div class="fig" id="s4"><img id="b4" src="/light.svg?content" alt=""><p>Caption right below a content image.</p></div>
  <div class="sec" id="s5"><img class="bd" id="b5" src="/light.svg?card" alt=""><div class="card"><h2>Text in an opaque card</h2></div></div>
  <div class="sec" id="s6"><img class="bd" id="b6" src="${other}/light.svg" alt=""><div class="ct"><h2>Dark text, unreadable pixels</h2></div></div>
  <div class="sec" id="s7"><img class="bd" id="b7" src="/product.svg" alt=""><div class="ct"><h2>Dark text over a light product shot</h2></div></div>
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
const lumOf = c => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
const fmt = c => `lum=${lumOf(c).toFixed(2)} rgb(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`;

// `cors: false` → a second origin that serves the images WITHOUT
// Access-Control-Allow-Origin, so their pixels can't be read from the page.
function serve(html) {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      const img = IMAGES[req.url.split('?')[0]];
      if (img) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end(img); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html ? html() : '');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

(async () => {
  const other = await serve(null);
  const otherBase = `http://127.0.0.1:${other.address().port}`;
  const server = await serve(() => page1(otherBase));
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
    await page.waitForTimeout(2500); // image sampling settles asynchronously

    const r = await page.evaluate(() => {
      const out = { root: document.documentElement.getAttribute('data-darkabsolut') };
      for (let i = 1; i <= 7; i++) {
        const img = document.getElementById('b' + i);
        out['b' + i] = { tag: img.getAttribute('data-darkabsolut-invertmedia'), filter: getComputedStyle(img).filter,
                         loaded: img.naturalWidth > 0 };
      }
      return out;
    });
    const show = b => `invertmedia=${b.tag} filter=${b.filter}`;

    assert('light page inverts', r.root === 'on', `root=${r.root}`);

    // (1) the pale backdrop behind dark text goes dark.
    assert('featureless light backdrop behind dark text is tagged', r.b1.tag === '1' && r.b1.filter === 'none', show(r.b1));
    const s1 = avgColor(await page.locator('#s1').screenshot());
    assert('that section renders DARK', lumOf(s1) < 0.25, fmt(s1));

    // (2) unchanged.
    const kept = b => b.tag == null && /invert/.test(b.filter);
    assert('picture with a dark subject keeps its colours', kept(r.b2), show(r.b2));
    assert('light product shot (edges, no dark pixel) keeps its colours', kept(r.b7), show(r.b7));
    assert('dark picture under light text keeps its colours', kept(r.b3), show(r.b3));
    assert('content image (caption below, nothing over it) keeps its colours', kept(r.b4), show(r.b4));
    assert('image whose only text sits in an opaque card keeps its colours', kept(r.b5), show(r.b5));
    assert('fixture: the cross-origin image loads', r.b6.loaded, `loaded=${r.b6.loaded}`);
    assert('cross-origin image without CORS keeps its colours', kept(r.b6), show(r.b6));
  } finally {
    await context.close();
    server.close(); other.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
