// Regression test: icon-vs-picture size discriminant for no-repeat background
// images (Gmail-style folder/UI glyphs).
//
// A no-repeat url() background on a TEXT-FREE element is counter-inverted
// ("kept colours") only when it is large enough to be a logo/picture. A small
// UI glyph must instead invert WITH the theme, so a DARK glyph on a light bar
// becomes a light glyph on the now-dark bar — visible — rather than being kept
// dark-on-dark (the "black-on-black nav icon" report). The boundary is the
// element's LONGER side: a picture is "generally larger than ~100px"; a sprite
// glyph stays well under it. Keyed on the long side (not the short one) so a
// wide wordmark logo (e.g. wikiHow's 172x72 header) is still kept as a logo.
//
//   node tests/test-icon-size.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-iconsize-'));

// A tiny opaque-black no-repeat glyph at natural (auto) size. Content is
// irrelevant — isLogoOrPhotoBg decides purely on element geometry.
const GLYPH =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><rect width='16' height='16' fill='black'/></svg>\")";

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>icons</title>
<style>
  html,body{margin:0;background:#fff}
  .bar{background:#eef1f6;padding:20px;display:flex;gap:20px;align-items:flex-start}
  .bg{background-image:${GLYPH};background-repeat:no-repeat;background-size:auto;display:block}
  #icon20{width:20px;height:20px}
  #icon90{width:90px;height:90px}        /* square, long side 90 < 100 -> icon */
  #icon99{width:99px;height:99px}        /* boundary: long side 99 < 100 -> icon */
  #logo100{width:100px;height:100px}     /* boundary: long side 100 -> logo */
  #logo172{width:172px;height:72px}      /* wide wordmark, long side 172 -> logo */
  #photo200{width:200px;height:150px}    /* picture -> keep colours */
</style></head>
<body>
  <div class="bar">
    <span class="bg" id="icon20"></span>
    <span class="bg" id="icon90"></span>
    <span class="bg" id="icon99"></span>
    <span class="bg" id="logo100"></span>
    <span class="bg" id="logo172"></span>
    <span class="bg" id="photo200"></span>
  </div>
  ${'<p>filler to fill the viewport so the page reads light.</p>'.repeat(30)}
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
    headless: true, channel: 'chromium', colorScheme: 'light',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }
    const page = await context.newPage();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(1200);

    const r = await page.evaluate(() => {
      const bg = id => document.getElementById(id).getAttribute('data-darkabsolut-bg');
      return {
        root: document.documentElement.getAttribute('data-darkabsolut'),
        icon20: bg('icon20'), icon90: bg('icon90'), icon99: bg('icon99'),
        logo100: bg('logo100'), logo172: bg('logo172'), photo200: bg('photo200'),
      };
    });

    assert('page is inverted', r.root === 'on', `root=${r.root}`);
    // Small UI glyphs invert WITH the theme (not tagged) so dark glyphs stay visible.
    assert('20px icon is NOT counter-inverted (inverts with theme)', r.icon20 == null, `bg=${r.icon20}`);
    assert('90px square icon is NOT counter-inverted (long side < 100)', r.icon90 == null, `bg=${r.icon90}`);
    // Boundary cases pin the threshold value itself (not just "below 172").
    assert('99px square icon is NOT counter-inverted (just below 100)', r.icon99 == null, `bg=${r.icon99}`);
    assert('100px square IS counter-inverted (exactly at the boundary)', r.logo100 === '1', `bg=${r.logo100}`);
    // Wide wordmark logo and real picture keep their colours (counter-inverted).
    assert('172x72 wordmark logo IS counter-inverted (long side >= 100)', r.logo172 === '1', `bg=${r.logo172}`);
    assert('200x150 picture IS counter-inverted', r.photo200 === '1', `bg=${r.photo200}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
