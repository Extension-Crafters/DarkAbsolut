// Regression/behaviour test for the coalesced, rate-limited mutation processor.
// A flood of DOM mutations (DuckDuckGo: streaming results + infinite scroll)
// must NOT be processed synchronously per-mutation (that janks page load) — work
// is batched and flushed on a debounce. But it must ALWAYS finish: every node
// eventually gets processed (here: dark wrappers get tagged darknative).
//
//   node tests/test-mutation-coalesce.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-coalesce-'));
const N = 150;

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>coalesce</title>
<style>html,body{margin:0;background:#fff;color:#111;font-family:sans-serif}
.dyn{width:600px;height:30px;background:#0a0a0a;color:#eee;margin:2px}</style></head>
<body><h1>White page</h1><div id="sink"></div></body></html>`;

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
    await page.waitForTimeout(800);

    assert('page inverted (root on)', (await page.evaluate(() =>
      document.documentElement.getAttribute('data-darkabsolut'))) === 'on');

    // Synchronously append N dark wrappers (simulating a burst of streamed DOM).
    await page.evaluate((n) => {
      const sink = document.getElementById('sink');
      for (let i = 0; i < n; i++) {
        const d = document.createElement('div');
        d.className = 'dyn'; d.textContent = 'result ' + i;
        sink.appendChild(d);
      }
    }, N);

    const tagged = () => page.evaluate(() =>
      document.querySelectorAll('#sink .dyn[data-darkabsolut-darknative="1"]').length);

    // Shortly after the burst (< debounce window) the work must be DEFERRED, not
    // all done synchronously inside the observer callback.
    await page.waitForTimeout(40);
    const immediate = await tagged();
    assert('processing is deferred (not synchronous per-mutation)', immediate < N,
      `tagged ${immediate}/${N} at +40ms`);

    // After things settle, the backlog must be fully drained (job always finishes).
    await page.waitForTimeout(1500);
    const settled = await tagged();
    assert('all dynamic nodes eventually processed (trailing flush finishes)', settled === N,
      `tagged ${settled}/${N}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
