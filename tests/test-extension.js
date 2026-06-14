// End-to-end test: load the unpacked extension in Chromium and verify that
// the production content + background scripts cooperate on real pages.
//
// Run: node tests/test-extension.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const http = require('http');

const EXT_PATH = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-ext-'));

// Minimal local HTTP server so the extension's content script gets a real
// http(s)-like origin (content_scripts don't run on about:blank).
function startServer(pages) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const body = pages[req.url];
      if (body == null) { res.writeHead(404); res.end('nope'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const LIGHT_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>light</title>
<style>html,body{background:#ffffff;color:#111;margin:0;padding:20px;font-family:sans-serif}</style>
</head><body><h1>Light page</h1><p>Lots of text to fill a viewport.</p>
${'<p>filler paragraph</p>'.repeat(40)}</body></html>`;

const DARK_PAGE = `<!doctype html><html style="color-scheme: dark"><head><meta charset="utf-8">
<title>dark</title>
<style>html,body{background:#0a0f14;color:#ddd;margin:0;padding:20px;font-family:sans-serif}</style>
</head><body><h1>Dark page</h1>
${'<p>filler paragraph</p>'.repeat(40)}</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const server = await startServer({
    '/light': LIGHT_PAGE,
    '/dark':  DARK_PAGE
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // Chromium loads extensions via persistent context with these two args.
  // `--headless=new` keeps CI-friendly while still supporting extensions.
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true,
    channel: 'chromium',
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox'
    ]
  });

  try {
    // Wait for the background service worker to come up.
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
    assert('service worker loaded', !!worker, worker && worker.url());

    // ── 1) Light page should get inverted ────────────────────────────────
    const pageLight = await context.newPage();
    await pageLight.goto(base + '/light', { waitUntil: 'load' });
    // Give the controller its timed re-checks room (it waits up to 200 ms on
    // the first one; we give a bit more for reevaluate + observers to settle).
    await pageLight.waitForTimeout(800);
    const lightAttr = await pageLight.evaluate(() =>
      document.documentElement.getAttribute('data-darkabsolut')
    );
    assert('light page: inversion attribute applied', lightAttr === 'on',
           `data-darkabsolut=${JSON.stringify(lightAttr)}`);

    const lightStyleInjected = await pageLight.evaluate(
      () => !!document.getElementById('darkabsolut-style')
    );
    assert('light page: <style id=darkabsolut-style> present', lightStyleInjected);

    // ── 2) Dark page should NOT be inverted ──────────────────────────────
    const pageDark = await context.newPage();
    await pageDark.goto(base + '/dark', { waitUntil: 'load' });
    await pageDark.waitForTimeout(1500); // give re-evaluate time to unapply
    const darkAttr = await pageDark.evaluate(() =>
      document.documentElement.getAttribute('data-darkabsolut')
    );
    assert('dark page: inversion NOT applied', darkAttr !== 'on',
           `data-darkabsolut=${JSON.stringify(darkAttr)}`);

    // ── 3) Background messaging round-trip ───────────────────────────────
    // chrome.runtime.sendMessage from the service worker does NOT trigger
    // the SW's own onMessage listeners, so we drive the real message router
    // from an extension page (popup/io.html), which is exactly the path the
    // popup uses in production.
    const extId = worker.url().split('/')[2];
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extId}/popup/io.html`,
                         { waitUntil: 'load' });

    const fullState = await popupPage.evaluate(() => new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_FULL_STATE' }, resolve);
    }));
    assert('GET_FULL_STATE returns ok',
           fullState && fullState.ok === true && typeof fullState.state === 'object',
           JSON.stringify(fullState));
    assert('default globalEnabled is true',
           fullState && fullState.state && fullState.state.globalEnabled === true);

    const urlResp = await popupPage.evaluate(url => new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_STATE_FOR_URL', url }, resolve);
    }), base + '/light');
    assert('GET_STATE_FOR_URL enabled for http url',
           urlResp && urlResp.ok && urlResp.enabled === true,
           JSON.stringify(urlResp));

    const chromeUrlResp = await popupPage.evaluate(() => new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: 'GET_STATE_FOR_URL', url: 'chrome://settings' }, resolve);
    }));
    assert('GET_STATE_FOR_URL disabled for chrome:// url',
           chromeUrlResp && chromeUrlResp.ok && chromeUrlResp.enabled === false);

    // ── 4) Toggle global off via background → content reacts ─────────────
    await popupPage.evaluate(() => new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'SET_GLOBAL_ENABLED', value: false }, resolve);
    }));
    // STATE_UPDATED is broadcast to tabs; the content script re-evaluates
    // asynchronously (awaiting a round-trip to the SW).
    await pageLight.waitForTimeout(600);
    const afterOff = await pageLight.evaluate(() =>
      document.documentElement.getAttribute('data-darkabsolut')
    );
    assert('light page: global-off removes inversion', afterOff !== 'on',
           `data-darkabsolut=${JSON.stringify(afterOff)}`);

    // Restore global on and confirm inversion comes back.
    await popupPage.evaluate(() => new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'SET_GLOBAL_ENABLED', value: true }, resolve);
    }));
    await pageLight.waitForTimeout(800);
    const afterOn = await pageLight.evaluate(() =>
      document.documentElement.getAttribute('data-darkabsolut')
    );
    assert('light page: global-on restores inversion', afterOn === 'on',
           `data-darkabsolut=${JSON.stringify(afterOn)}`);

  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.error('Failed:');
    for (const f of failed) console.error('  -', f.name, f.detail || '');
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
