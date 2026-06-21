// Regression tests for three related "a dark band fools whole-page detection"
// bugs, all on LIGHT pages that rely on the default white canvas (transparent
// <body>/<html>):
//
//   1. Dark hero at the TOP (Know Your Meme): the only opaque background in the
//      first viewport is a tall dark hero; the white content below is the
//      transparent canvas. Detection used to drop the transparent points and
//      see only the dark hero → "already dark" → never inverted. Now a
//      transparent point counts as the canvas colour (white) → page inverts.
//
//   2. Dark footer scrolled into view (mesepices): the page inverts at load
//      (scroll 0), but a timed/observer re-check after scrolling sampled the
//      dark footer viewport and called unapplyRootInversion() → the whole light
//      page flipped back to native. Re-evaluation now only un-inverts for a
//      scroll-independent signal (declared dark scheme / dark base), so a dark
//      section scrolled into view can't undo the inversion.
//
//   3. Large dark footer with a SMALL light child (mesepices footer): a big
//      dark wrapper wasn't counter-inverted (so it flipped to light) because it
//      contained one thin white strip. The light-child veto is now scaled to
//      the wrapper size: a small light widget no longer vetoes; a dominant
//      light panel (the real "dark frame around white card" case) still does.
//
//   node tests/test-detect-scroll.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-scroll-'));

// Light page: NO background on html/body → the white canvas shows through
// transparent content. A tall dark hero at the top, a dark footer far below
// (with a small white strip), and a "card" = dark frame around a LARGE white
// panel (the cascade case that must stay protected).
const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>scroll</title>
<style>
  html,body{margin:0;font-family:sans-serif}            /* no bg → white canvas */
  .hero{background:#0a0a14;height:280px;color:#fff;padding:20px}
  .content{padding:20px;color:#222}                     /* transparent → canvas */
  .spacer{height:320px}
  .card{background:#161515;color:#eee;padding:10px;width:400px;margin:20px}
  .card .body{background:#fff;height:260px;color:#111;padding:10px} /* >50% → veto */
  .footer{background:#161515;height:700px;color:#eee}
  .footer .strip{background:#fff;height:48px}           /* small → must NOT veto */
</style></head>
<body>
  <div class="hero"><h1>Big dark hero banner</h1><p>navy, fills the first viewport</p></div>
  <div class="content"><h2>White content</h2><p>This area is the transparent white canvas.</p></div>
  <div class="spacer"></div>
  <div class="card" id="card"><div class="body">large white panel inside a dark frame</div></div>
  <div class="footer" id="footer"><div class="strip"></div><h3>Footer menu</h3><p>links…</p></div>
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
    await page.setViewportSize({ width: 800, height: 700 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    // (1) Dark hero at top must not stop the light page inverting.
    const root1 = await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'));
    assert('light page with tall dark hero still inverts', root1 === 'on', `root=${root1}`);

    // (3) Footer veto: big dark footer with a small white strip is kept dark;
    // the dark frame around a large white panel is NOT (cascade protected).
    const tags = await page.evaluate(() => ({
      footer: document.getElementById('footer').getAttribute('data-darkabsolut-darknative'),
      card: document.getElementById('card').getAttribute('data-darkabsolut-darknative'),
    }));
    assert('dark footer with small light strip IS kept dark', tags.footer === '1', `darknative=${tags.footer}`);
    assert('dark frame around large white panel NOT kept dark', tags.card !== '1', `darknative=${tags.card}`);

    // (2) Scroll the dark footer into view, then force a re-evaluation (a body
    // class mutation, as a theme toggle would) — the page must STAY inverted.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    await page.evaluate(() => { document.body.classList.add('da-test-reeval'); });
    await page.waitForTimeout(500);
    const root2 = await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'));
    assert('scrolling a dark footer into view does NOT un-invert', root2 === 'on', `root=${root2}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
