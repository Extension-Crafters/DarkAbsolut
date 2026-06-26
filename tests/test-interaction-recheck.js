// Regression test: a throttled re-check after a click re-themes content that a
// click reveals WITHOUT mutating the DOM.
//
// The bug (Gmail "main area becomes light on click"): SPA views swap on click
// without touching <html>/<body> classes, and the timed post-load re-checks
// have long expired, so a freshly-revealed light panel can be left un-inverted
// (bright) on an otherwise-dark page. The mutation observer only re-scans when
// the DOM actually changes — a panel shown purely via CSS :target (no attribute
// or childList mutation) slips past it. A click-triggered, throttled re-check
// closes that gap: it re-runs detection and re-scans for light islands.
//
// The page is detected as already-dark (light-island mode), so a revealed white
// panel must be tagged + locally inverted. We reveal it two ways:
//   1. by setting location.hash directly (NO click) — proves the gap: the panel
//      shows but is never tagged;
//   2. by a real click on the same anchor — the re-check tags + inverts it.
// Done AFTER all timed re-checks (<=10s) have expired so only the click path
// can be responsible.
//
//   node tests/test-interaction-recheck.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-interact-'));

// Dark app shell (detected as already-dark → light-island mode). A large white
// panel is hidden until its anchor is targeted, revealed purely via :target so
// no DOM mutation fires.
const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>shell</title>
<style>
  html,body{margin:0;background:#111;color:#eee;height:100%}
  .chrome{position:fixed;inset:0;background:#111}
  #panel{display:none;position:relative;z-index:2;width:640px;height:420px;
         margin:40px;background:#fff;color:#111}
  #panel:target{display:block}
  a{color:#8ab4f8}
</style></head>
<body>
  <div class="chrome"></div>
  <a href="#panel" id="open" style="position:relative;z-index:3">open message</a>
  <div id="panel">message body</div>
</body></html>`;

// A LIGHT app shell DarkAbsolut inverts (applied=true). Clicking the button
// injects a same-origin message-body iframe AFTER the initial subframe
// broadcasts have settled — exercising runInteractionRecheck's applied branch
// (broadcastInversionToSubframes). The child must sit out (ancestor inverted)
// so the parent filter inverts it once — NOT double-invert it back to light.
const LIGHT_PAGE = `<!doctype html><html><head><meta charset=utf-8><title>light</title>
<style>html,body{margin:0;background:#fff;color:#111;height:100%}</style></head>
<body>
  <button id="openmsg">open</button>
  <div id="host"></div>
  <script>
    document.getElementById('openmsg').addEventListener('click', () => {
      const f = document.createElement('iframe');
      f.id = 'msg'; f.style = 'width:600px;height:300px;border:0';
      f.srcdoc = '<!doctype html><html><body style="background:#fff;color:#111">message body</body></html>';
      document.getElementById('host').appendChild(f);
    });
  </script>
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
      res.end(req.url.startsWith('/light') ? LIGHT_PAGE : PAGE);
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
    await page.waitForTimeout(1500);

    // Precondition: dark page → DA sits out (light-island mode, root not "on").
    const pre = await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'));
    assert('dark page is NOT root-inverted (light-island mode)', pre !== 'on', `root=${pre}`);

    // Wait past the last timed re-check (10s) AND its trailing light-island
    // rescans (scheduled up to +1.2s after each reevaluate, so ~11.2s), so only
    // the click path can possibly re-scan after this point. The extra margin
    // over 11.2s absorbs scheduler jitter on loaded CI.
    await page.waitForTimeout(15000);

    // 1) Reveal the panel WITHOUT a click — set the hash directly. :target shows
    //    it but nothing mutates the DOM, so the panel is never tagged. (The gap.)
    await page.evaluate(() => { location.hash = '#panel'; });
    await page.waitForTimeout(900);
    const gap = await page.evaluate(() => ({
      shown: getComputedStyle(document.getElementById('panel')).display,
      tagged: document.getElementById('panel').hasAttribute('data-darkabsolut-lightnative'),
    }));
    assert('panel is visible after hash reveal', gap.shown === 'block', `display=${gap.shown}`);
    assert('without a click the revealed panel is NOT yet tagged', gap.tagged === false, `tagged=${gap.tagged}`);

    // 2) Click the anchor — the throttled re-check runs, re-scans light islands,
    //    and tags the now-visible panel so CSS inverts it locally.
    await page.click('#open');
    await page.waitForTimeout(900);
    const fixed = await page.evaluate(() => ({
      tagged: document.getElementById('panel').hasAttribute('data-darkabsolut-lightnative'),
      root: document.documentElement.getAttribute('data-darkabsolut'),
    }));
    assert('after a click the revealed panel IS tagged for local invert', fixed.tagged === true, `tagged=${fixed.tagged}`);
    assert('page stays in light-island mode (not wrongly root-inverted)', fixed.root !== 'on', `root=${fixed.root}`);

    // Throttle sanity: a burst of clicks must not break the themed state.
    for (let i = 0; i < 8; i++) await page.click('#open');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      tagged: document.getElementById('panel').hasAttribute('data-darkabsolut-lightnative'),
      root: document.documentElement.getAttribute('data-darkabsolut'),
    }));
    assert('rapid clicks keep the panel tagged', after.tagged === true, `tagged=${after.tagged}`);
    assert('rapid clicks do not flip the page to root-invert', after.root !== 'on', `root=${after.root}`);

    // ── Applied-page path: a LIGHT shell DA inverts; clicking injects a message
    // iframe. The re-check's applied branch (broadcast) runs; the page must stay
    // inverted and the injected iframe must NOT double-invert (child sits out).
    const lpage = await context.newPage();
    await lpage.setViewportSize({ width: 900, height: 700 });
    await lpage.goto(base + 'light', { waitUntil: 'load' });
    await lpage.waitForTimeout(1800); // let DA apply + initial subframe broadcasts settle
    const lpre = await lpage.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'));
    assert('light shell is root-inverted (applied)', lpre === 'on', `root=${lpre}`);

    await lpage.click('#openmsg');
    await lpage.waitForTimeout(900);
    const applied = await lpage.evaluate(() => {
      const f = document.getElementById('msg');
      let innerRoot = 'missing';
      try { innerRoot = f.contentDocument.documentElement.getAttribute('data-darkabsolut'); } catch (_) {}
      return { root: document.documentElement.getAttribute('data-darkabsolut'), innerRoot };
    });
    assert('click keeps the light shell inverted (recheck did not un-apply)', applied.root === 'on', `root=${applied.root}`);
    assert('injected message iframe sits out (no double-invert)', applied.innerRoot !== 'on', `innerRoot=${applied.innerRoot}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
