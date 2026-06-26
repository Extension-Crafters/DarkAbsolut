// Regression test for Google Maps: a LIGHT app (white UI) whose large map
// <canvas> has background-color:#000. Detection must look PAST the canvas
// background (it's a placeholder behind drawn tiles, not the page surface) and
// keep the page inverted — not read the black canvas as "already dark" and
// un-invert, flipping the Maps UI back to light a few seconds after load.
//
//   node tests/test-map-canvas.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-mapcanvas-'));

// Fixed full-viewport light app: white panels + a black-background map canvas
// filling the view (Google Maps' structure). The page is genuinely light.
const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>map</title>
<style>
  html,body{margin:0;background:#fff;color:#111;height:100%;overflow:hidden}
  #app{position:fixed;inset:0}
  #map{position:absolute;inset:0;width:100%;height:100%;background:#000;display:block}
  .panel{position:absolute;top:12px;left:12px;width:300px;height:80px;background:#fff;border:1px solid #ddd;z-index:2;color:#111}
</style></head>
<body>
  <div id="app">
    <canvas id="map"></canvas>
    <div class="panel">Search this area</div>
  </div>
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
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(base, { waitUntil: 'load' });

    await page.waitForTimeout(700);
    const r0 = await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'));
    assert('light Maps-like app is inverted at load', r0 === 'on', `root=${r0}`);

    // The black map canvas must NOT make DA un-invert over the next few seconds.
    await page.waitForTimeout(4000);
    const r1 = await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'));
    assert('black map canvas does NOT cause un-invert (stays dark)', r1 === 'on', `root=${r1}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
