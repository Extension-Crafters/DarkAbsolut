// Regression test: a plain-text (text/plain) document that the BROWSER renders
// dark in OS dark mode (Chrome's text-file viewer: dark canvas + light text,
// with no explicit CSS background) must NOT be inverted — inverting it turned
// the native light text dark → unreadable black-on-black (dlcompare.fr/llms.txt).
// In light mode the same file is rendered light and SHOULD be inverted.
//
// Detection relies on: with no explicit background, the canvas colour is the
// OPPOSITE of the UA default text colour (detect.js canvasBgColor) — light
// default text ⇒ the UA is rendering dark ⇒ already-dark ⇒ leave it.
//
//   node tests/test-text-plain.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const BODY = '# Title\n\nplain text document line one\nplain text document line two\n'.repeat(20);

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

async function run(scheme) {
  const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-txt-' + scheme + '-'));
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(BODY);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/page.txt`;
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true, channel: 'chromium', colorScheme: scheme,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }
    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    return await page.evaluate(() => {
      const pre = document.querySelector('pre');
      const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const lum = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const a = m[1].split(',').map(parseFloat); return 0.2126 * lin(a[0]) + 0.7152 * lin(a[1]) + 0.0722 * lin(a[2]); };
      const cs = pre ? getComputedStyle(pre) : null;
      return {
        root: document.documentElement.getAttribute('data-darkabsolut'),
        preColorLum: cs ? lum(cs.color) : null,
        htmlInverted: /invert/.test(getComputedStyle(document.documentElement).filter),
      };
    });
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  // Dark mode: browser renders the text file dark; DA must leave it alone.
  const dark = await run('dark');
  assert('dark-mode text file is NOT inverted', dark.root !== 'on', `root=${dark.root}`);
  assert('dark-mode text stays light (readable, not black-on-black)',
    dark.preColorLum != null && dark.preColorLum > 0.5, `preColorLum=${dark.preColorLum && dark.preColorLum.toFixed(2)}`);

  // Light mode: browser renders it light; DA inverts it to dark mode.
  const light = await run('light');
  assert('light-mode text file IS inverted', light.root === 'on' && light.htmlInverted,
    `root=${light.root} inv=${light.htmlInverted}`);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
