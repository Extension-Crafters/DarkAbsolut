// Regression test: cross-origin iframe inversion coordination.
//
//  * A natively-DARK parent (DarkAbsolut leaves it alone) that embeds a LIGHT
//    cross-origin iframe must let the iframe invert ITSELF — otherwise nothing
//    darkens it and it stays a bright block (the plex.tv sign-in form bug: a
//    dark plex.tv embedding a light app.plex.tv auth form).
//  * A LIGHT parent (DarkAbsolut inverts it) embedding the same iframe must make
//    the iframe SIT OUT — the parent's filter inverts it; inverting again would
//    double-invert it back to light.
//
// Two origins are obtained from one server via localhost vs 127.0.0.1.
//   node tests/test-iframe.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-iframe-'));

const FORM = `<!doctype html><html><head><meta charset=utf-8><title>form</title>
<style>html,body{margin:0;background:#ffffff;color:#111}</style></head>
<body><h1>Sign in</h1><input placeholder=email><p>light form content</p></body></html>`;

function parent(bg, color, iframeSrc) {
  return `<!doctype html><html><head><meta charset=utf-8><title>parent</title>
<style>html,body{margin:0;background:${bg};color:${color};font-family:sans-serif}</style></head>
<body><h1>Parent</h1>
<iframe src="${iframeSrc}" width="420" height="280" style="border:0"></iframe>
${'<p>parent filler text to dominate the viewport sampling. </p>'.repeat(30)}
</body></html>`;
}

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

async function frameRoot(page, needle) {
  for (const fr of page.frames()) {
    if (fr.url().includes(needle)) {
      try { return await fr.evaluate(() => document.documentElement.getAttribute('data-darkabsolut')); }
      catch (_) { return '(eval-failed)'; }
    }
  }
  return '(no frame)';
}

(async () => {
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.url.startsWith('/form')) return res.end(FORM);
      // iframe served from the OTHER origin (localhost) to be cross-origin.
      const port = server.address().port;
      const iframeSrc = `http://localhost:${port}/form`;
      if (req.url.startsWith('/dark')) return res.end(parent('#111111', '#eee', iframeSrc));
      return res.end(parent('#ffffff', '#111', iframeSrc));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true, channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }
    const page = await context.newPage();
    await page.setViewportSize({ width: 900, height: 700 });

    // 1) Dark parent (127.0.0.1) embeds a light cross-origin iframe (localhost).
    await page.goto(`http://127.0.0.1:${port}/dark`, { waitUntil: 'load' });
    await page.waitForTimeout(2800);
    const darkParentRoot = await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'));
    const darkIframeRoot = await frameRoot(page, '/form');
    assert('dark parent is NOT inverted (native dark)', darkParentRoot !== 'on', `root=${darkParentRoot}`);
    assert('light iframe under dark parent inverts ITSELF', darkIframeRoot === 'on', `iframe root=${darkIframeRoot}`);

    // 2) Light parent (127.0.0.1) embeds the same light cross-origin iframe.
    await page.goto(`http://127.0.0.1:${port}/light`, { waitUntil: 'load' });
    await page.waitForTimeout(2800);
    const lightParentRoot = await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'));
    const lightIframeRoot = await frameRoot(page, '/form');
    assert('light parent IS inverted', lightParentRoot === 'on', `root=${lightParentRoot}`);
    assert('iframe under inverted parent SITS OUT (no double-invert)', lightIframeRoot !== 'on', `iframe root=${lightIframeRoot}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
