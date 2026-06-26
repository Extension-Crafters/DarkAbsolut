// Regression test: a natively-dark app shell whose dark theme lives on a
// full-document WRAPPER (not <html>/<body>) must be detected as dark and left
// alone — not optimistically inverted into a bright page.
//
// The bug (k4g.com): <html>/<body> are transparent and body text is black, so
// canvasBgColor() reads "white" base; the dark theme is painted on a full-page
// wrapper #k4g-root with background rgb(0,3,38). Two things defeated detection:
//   1. rgb(0,3,38) has luminance ~0.002 but HSL saturation ~1.0 (the formula
//      blows tiny channel deltas up at near-zero lightness), so isNeutralDark()
//      rejected it as an "accent" colour → the page was inverted to light.
//   2. even once recognised, the optimistic-apply baseDark guard only checked
//      html/body, so it never saw the wrapper and kept inversion on.
// Fixes: isNeutralDark() treats perceptually-black colours as dark regardless of
// saturation; fullPageBgColor() finds a full-DOCUMENT dark wrapper for baseDark.
//
//   node tests/test-dark-wrapper.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-darkwrap-'));

// k4g-like: transparent html/body, black body text, a full-document wrapper with
// a very-dark SATURATED background. The page is genuinely dark.
const DARK_PAGE = `<!doctype html><html><head><meta charset=utf-8><title>k4g-like</title>
<style>
  html,body{margin:0;background:transparent;color:#000}
  #root{background:rgb(0,3,38);min-height:2400px;color:#e6e8ff}
  .bar{height:120px;background:rgb(0,3,38)}
  .card{margin:20px;height:300px;background:rgb(23,26,60)}
</style></head>
<body>
  <div id="root">
    <div class="bar">k4g-like header</div>
    <div class="card">a panel</div>
    <div class="card">another panel</div>
  </div>
</body></html>`;

// Light app shell with the SAME structure (full-document wrapper) but a WHITE
// wrapper — must still be inverted (guards that fullPageBgColor returning a light
// colour doesn't wrongly suppress inversion).
const LIGHT_PAGE = `<!doctype html><html><head><meta charset=utf-8><title>light-shell</title>
<style>
  html,body{margin:0;background:transparent;color:#111}
  #root{background:#ffffff;min-height:2400px}
  .card{margin:20px;height:300px;background:#f2f2f2}
</style></head>
<body>
  <div id="root"><div class="card">a</div><div class="card">b</div></div>
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
      res.end(req.url.startsWith('/light') ? LIGHT_PAGE : DARK_PAGE);
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

    // ── Dark app shell: DA must sit out (no root inversion). ──
    const dpage = await context.newPage();
    await dpage.setViewportSize({ width: 1000, height: 760 });
    await dpage.goto(base, { waitUntil: 'load' });
    await dpage.waitForTimeout(800);
    const early = await dpage.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'));
    assert('dark wrapper page is NOT inverted shortly after load', early !== 'on', `root=${early}`);
    // Hold across the timed re-checks — it must not flip back on.
    await dpage.waitForTimeout(3500);
    const late = await dpage.evaluate(() => ({
      root: document.documentElement.getAttribute('data-darkabsolut'),
      htmlFilter: getComputedStyle(document.documentElement).filter,
      rootBg: getComputedStyle(document.getElementById('root')).backgroundColor,
    }));
    assert('dark wrapper page stays un-inverted (native dark preserved)', late.root !== 'on', `root=${late.root}`);
    assert('no invert filter on <html>', late.htmlFilter === 'none', `filter=${late.htmlFilter}`);
    assert('wrapper keeps its native dark colour', late.rootBg === 'rgb(0, 3, 38)', `bg=${late.rootBg}`);

    // ── Light app shell with the same structure: DA must invert. ──
    const lpage = await context.newPage();
    await lpage.setViewportSize({ width: 1000, height: 760 });
    await lpage.goto(base + 'light', { waitUntil: 'load' });
    await lpage.waitForTimeout(1500);
    const lroot = await lpage.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'));
    assert('light wrapper page IS inverted (full-page-wrapper check stays light-safe)', lroot === 'on', `root=${lroot}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
