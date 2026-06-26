// Regression test for an SPA that loads light then switches its WHOLE theme to
// dark a few seconds later — a real page-wide theme switch, i.e. the body/html
// base background turns dark. DarkAbsolut inverts the light load, but once the
// page's base goes dark it must UN-invert (leave the native dark theme), not
// keep inverting it into light.
//
// (Contrast with tests/test-map-canvas.js: a light app whose only dark surface
// is a media region — a black map <canvas> — must STAY inverted. Only a
// body/html base going dark, or a declared dark scheme, may un-invert.)
//
//   node tests/test-late-dark.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { decodePng, pixelLum } = require('./lib/png');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-latedark-'));

// Fixed full-viewport app: light at load, switches its base (html+body) to dark
// via JS at 1.2s — a genuine theme switch.
const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>mapapp</title>
<style>
  html,body{margin:0;background:#fff;color:#111;height:100%;overflow:hidden}
  #app{position:fixed;inset:0;background:#f6f6f6;color:#111}
  .panel{position:absolute;top:12px;left:12px;width:320px;height:90px;background:#fff;border:1px solid #ddd}
</style></head>
<body>
  <div id="app"><div class="panel">Search this area</div><h1>Map</h1></div>
  <script>
    setTimeout(function(){
      document.documentElement.style.background='#1f1f1f';
      document.body.style.background='#1f1f1f'; document.body.style.color='#e8e8e8';
      var a=document.getElementById('app');
      a.style.background='#1f1f1f'; a.style.color='#e8e8e8';
      document.querySelectorAll('.panel').forEach(function(p){p.style.background='#2a2a2a';p.style.color='#e8e8e8';p.style.borderColor='#444';});
    }, 1200);
  </script>
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
    headless: true, channel: 'chromium', colorScheme: 'light',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }
    const page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(base, { waitUntil: 'load' });

    await page.waitForTimeout(700); // before the theme flips
    assert('light load → inverted (root on)',
      (await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'))) === 'on');

    // After the app turns dark + the timed re-checks fire, DA must un-invert.
    await page.waitForTimeout(4000);
    const root = await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'));
    assert('late dark theme → un-inverted (root off)', root !== 'on', `root=${root}`);

    const bf = brightFrac(await page.screenshot());
    assert('app renders DARK (not flipped to light)', bf < 0.2, `brightFrac=${bf.toFixed(3)}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
