// Test the per-site "Soft dark gray" contrast option: when enabled for a host,
// the inversion filter gains contrast(<1) (lifting pure black to dark gray);
// other hosts are unaffected. Saved per-domain (with include-subdomains), like
// the disable / force-natural-images options.
//
//   node tests/test-contrast-enhance.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-hc-'));

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>hc</title>
<style>html,body{margin:0;background:#fff;color:#111;font-family:sans-serif}</style></head>
<body><h1>Light page</h1>${'<p>content. </p>'.repeat(30)}</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}
const sendFrom = (page, msg) =>
  page.evaluate(m => new Promise(r => chrome.runtime.sendMessage(m, r)), msg);

(async () => {
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  // 127.0.0.1 and localhost are distinct hosts → use them as two "sites".
  const targetUrl = `http://127.0.0.1:${port}/`;
  const otherUrl = `http://localhost:${port}/`;

  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true, channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { w = await context.waitForEvent('serviceworker', { timeout: 10000 }); } catch (_) {} }
    const extId = new URL(w.url()).host;

    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(targetUrl, { waitUntil: 'load' });
    await page.waitForTimeout(900);

    const hc = () => page.evaluate(() => ({
      root: document.documentElement.getAttribute('data-darkabsolut'),
      hcAttr: document.documentElement.getAttribute('data-darkabsolut-hc'),
      filter: getComputedStyle(document.documentElement).filter,
    }));

    // Default: not enabled for this host → plain invert, no contrast().
    let s = await hc();
    assert('page inverted', s.root === 'on', `root=${s.root}`);
    assert('default: no soft-dark-gray attr', s.hcAttr === null, `hc=${s.hcAttr}`);
    assert('default: plain invert filter', /invert/.test(s.filter) && !/contrast\(/.test(s.filter), `filter=${s.filter}`);

    // Enable soft dark gray for THIS host only (per-domain).
    const seed = await context.newPage();
    await seed.goto(`chrome-extension://${extId}/popup/io.html`, { waitUntil: 'load' });
    await sendFrom(seed, { type: 'SET_DOMAIN_ENHANCE_CONTRAST', hostname: '127.0.0.1', enabled: true, includeSubdomains: false });
    await page.waitForTimeout(900);
    s = await hc();
    assert('enabled: soft-dark-gray attr set', s.hcAttr === '1', `hc=${s.hcAttr}`);
    assert('enabled: filter lifts black (contrast<1)', /contrast\(/.test(s.filter), `filter=${s.filter}`);
    assert('enabled: still inverted', /invert/.test(s.filter), `filter=${s.filter}`);

    // A DIFFERENT host must be unaffected (per-site, not global).
    const other = await context.newPage();
    await other.goto(otherUrl, { waitUntil: 'load' });
    await other.waitForTimeout(900);
    const os = await other.evaluate(() => ({
      hcAttr: document.documentElement.getAttribute('data-darkabsolut-hc'),
      filter: getComputedStyle(document.documentElement).filter,
    }));
    assert('other host NOT affected', os.hcAttr === null && !/contrast\(/.test(os.filter), `hc=${os.hcAttr} filter=${os.filter}`);

    // Persists across reload of the target host.
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    s = await hc();
    assert('persists after reload', s.hcAttr === '1' && /contrast\(/.test(s.filter), `hc=${s.hcAttr}`);

    // Turn it off → back to plain invert.
    await sendFrom(seed, { type: 'SET_DOMAIN_ENHANCE_CONTRAST', hostname: '127.0.0.1', enabled: false, includeSubdomains: false });
    await page.waitForTimeout(900);
    s = await hc();
    assert('off: attr removed', s.hcAttr === null, `hc=${s.hcAttr}`);
    assert('off: back to plain invert', /invert/.test(s.filter) && !/contrast\(/.test(s.filter), `filter=${s.filter}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
