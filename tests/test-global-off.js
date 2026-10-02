// Regression test: with the master kill switch OFF, a (re)loaded page must be
// left completely untouched — no data-darkabsolut* attribute, no inline style
// rewrite, no injected stylesheet, no shadow-root counter-invert.
//
// The bug: phase 0 optimistically calls apply() at document_start, BEFORE the
// service-worker round-trip. apply() deferred its full-document tagging pass
// to DOMContentLoaded. When the worker answered "disabled" first (any page
// still parsing at that point), disableForPage() reverted everything — and
// then DOMContentLoaded fired the stale pass anyway: saturated backgrounds got
// pre-lightened inline (data-darkabsolut-bg-orig), and shadow roots received
// the UNGATED counter-invert sheet, so their images rendered inverted on an
// otherwise-native page. Persisted across reloads since phase 0 re-runs each
// load.
//
// The fixture streams its body with a delay so DOMContentLoaded reliably lands
// AFTER the worker's answer — the racy ordering that exposed the bug.
//
//   node tests/test-global-off.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-globaloff-'));

// A coloured image for the shadow-root <img> (any <img> is counter-inverted).
const IMG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
  '<rect width="32" height="64" fill="#e33"/><rect x="32" width="32" height="64" fill="#33e"/></svg>';

const HEAD = `<!doctype html><html><head><meta charset=utf-8><title>slow light</title>
<style>html,body{margin:0;background:#fff;color:#111;font:16px sans-serif}
#brand{background:#459cd5;color:#fff;padding:24px;height:200px}
#scrim{background:rgba(20,20,20,0.6);color:#111;width:600px;height:200px}
#hero{background:linear-gradient(135deg,#10243b 0%,#1f4e79 100%);color:#eaf2fb;padding:24px}</style></head>
<body><div id="brand">Saturated brand banner</div><div id="hero">Dark gradient hero</div>`;

const TAIL = `<div id="scrim">translucent dark scrim</div>
<div id="host"></div>
<script>
  const sr = document.getElementById('host').attachShadow({ mode: 'open' });
  sr.innerHTML = '<div id="sbrand" style="background:#459cd5;padding:24px;height:120px">shadow banner</div>' +
    '<img id="simg" src="/img.svg" width="64" height="64">';
</script>
${'<p>Body paragraph text to give the page some content. </p>'.repeat(40)}
</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

// Everything DarkAbsolut could have left in the page.
function snapshotTraces() {
  const attrs = [];
  const walk = root => {
    for (const el of root.querySelectorAll('*')) {
      for (const a of el.attributes) {
        if (a.name.startsWith('data-darkabsolut')) attrs.push(`${el.tagName.toLowerCase()}[${a.name}]`);
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document); // querySelectorAll('*') includes <html> itself
  const sr = document.getElementById('host').shadowRoot;
  const simg = sr && sr.getElementById('simg');
  return {
    attrs,
    style: !!document.getElementById('darkabsolut-style'),
    defs: !!document.getElementById('darkabsolut-filters'),
    brandInline: document.getElementById('brand').getAttribute('style') || '',
    scrimInline: document.getElementById('scrim').getAttribute('style') || '',
    shadowBrandBg: sr ? sr.getElementById('sbrand').style.backgroundColor : 'missing',
    shadowSheets: sr ? sr.adoptedStyleSheets.length + sr.querySelectorAll('style').length : -1,
    shadowImgFilter: simg ? getComputedStyle(simg).filter : 'missing',
  };
}

(async () => {
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      if (req.url.startsWith('/img.svg')) {
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        res.end(IMG);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write(HEAD);
      // Hold the rest of the document so parsing (and DOMContentLoaded) waits
      // well past the service-worker round-trip.
      setTimeout(() => res.end(TAIL), 900);
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
    if (!w) { try { w = await context.waitForEvent('serviceworker', { timeout: 10000 }); } catch (_) {} }
    const extId = new URL(w.url()).host;
    const ctl = await context.newPage();
    await ctl.goto(`chrome-extension://${extId}/popup/io.html`, { waitUntil: 'load' });
    const send = (msg) => ctl.evaluate(m => new Promise(r => chrome.runtime.sendMessage(m, r)), msg);

    const page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });

    // Sanity: with the master ON the same page IS themed (the fixture really
    // triggers pre-lighten + shadow counter-invert), so a clean OFF run below
    // proves the switch, not a fixture that never gets touched.
    await send({ type: 'IMPORT_SETTINGS', data: { globalEnabled: true } });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const on = await page.evaluate(snapshotTraces);
    assert('master ON: page inverted', on.attrs.includes('html[data-darkabsolut]'), on.attrs.slice(0, 4).join(' '));
    assert('master ON: saturated banner pre-lightened', /background-color/.test(on.brandInline), on.brandInline);
    assert('master ON: shadow img counter-inverted', /invert/.test(on.shadowImgFilter), on.shadowImgFilter);
    assert('master ON: shadow banner pre-lightened', on.shadowBrandBg !== 'rgb(69, 156, 213)', on.shadowBrandBg);
    assert('master ON: dark gradient hero tagged', on.attrs.includes('div[data-darkabsolut-bg]'));

    // Master OFF, then reload a few times (the race is timing-dependent).
    await send({ type: 'SET_GLOBAL_ENABLED', value: false });
    for (let i = 1; i <= 3; i++) {
      await page.goto(base, { waitUntil: 'load' });
      // Outlast apply()'s delayed rescans (700/1800ms) and async icon sampling.
      await page.waitForTimeout(2200);
      const off = await page.evaluate(snapshotTraces);
      assert(`master OFF #${i}: no data-darkabsolut* attribute left`, off.attrs.length === 0,
        off.attrs.slice(0, 6).join(' '));
      assert(`master OFF #${i}: no injected stylesheet / filter defs`, !off.style && !off.defs,
        `style=${off.style} defs=${off.defs}`);
      assert(`master OFF #${i}: banner inline style untouched`, off.brandInline === '', off.brandInline);
      assert(`master OFF #${i}: scrim inline style untouched`, off.scrimInline === '', off.scrimInline);
      assert(`master OFF #${i}: shadow root has no DarkAbsolut sheet`, off.shadowSheets === 0, String(off.shadowSheets));
      assert(`master OFF #${i}: shadow img not inverted`, off.shadowImgFilter === 'none', off.shadowImgFilter);
      assert(`master OFF #${i}: shadow banner untouched`, off.shadowBrandBg === 'rgb(69, 156, 213)', off.shadowBrandBg);
    }

    // Turning OFF on an already-themed page must also clean up fully.
    await send({ type: 'SET_GLOBAL_ENABLED', value: true });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    await send({ type: 'SET_GLOBAL_ENABLED', value: false });
    await page.waitForTimeout(800);
    const live = await page.evaluate(snapshotTraces);
    assert('live OFF: no data-darkabsolut* attribute left', live.attrs.length === 0, live.attrs.slice(0, 6).join(' '));
    assert('live OFF: banner inline style restored', live.brandInline === '', live.brandInline);
    assert('live OFF: no injected stylesheet / filter defs', !live.style && !live.defs);
    assert('live OFF: scrim inline style restored', live.scrimInline === '', live.scrimInline);
    assert('live OFF: shadow root has no DarkAbsolut sheet', live.shadowSheets === 0, String(live.shadowSheets));
    assert('live OFF: shadow img not inverted', live.shadowImgFilter === 'none', live.shadowImgFilter);
    assert('live OFF: shadow banner restored', live.shadowBrandBg === 'rgb(69, 156, 213)', live.shadowBrandBg);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
