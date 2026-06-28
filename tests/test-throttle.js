// Tests for the configurable re-analyse throttle delay (the perf knob that
// stops a high-frequency DOM storm — e.g. a streaming Google AI overview on a
// slow phone — from re-theming greedily and starving input handling).
//
//   * Resolution precedence + clamping via GET_STATE_FOR_URL: exact host →
//     subdomain rule → global default, all clamped to [60, 5000] ms.
//   * SET_GLOBAL_THROTTLE / SET_THROTTLE_RULE / REMOVE_THROTTLE_RULE.
//   * REMOVE_DOMAIN_CONFIG / CLEAR_ALL_DOMAINS also drop throttle overrides.
//   * Import/export round-trips the throttle settings (and re-clamps).
//   * Behaviour: a larger delay genuinely reaches the content script — a DOM
//     burst stays DEFERRED longer than the default would, yet the trailing-edge
//     flush still drains every node in the end ("always the last word").
//
//   node tests/test-throttle.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-throttle-'));
const N = 120;

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>throttle</title>
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
    if (!w) { try { w = await context.waitForEvent('serviceworker', { timeout: 10000 }); } catch (_) {} }
    const extId = new URL(w.url()).host;

    const ctl = await context.newPage();
    await ctl.goto(`chrome-extension://${extId}/popup/io.html`, { waitUntil: 'load' });
    const send = (msg) => ctl.evaluate(m => new Promise(r => chrome.runtime.sendMessage(m, r)), msg);
    const delayFor = async (url) => (await send({ type: 'GET_STATE_FOR_URL', url })).throttleDelay;

    const E = 'https://example.com/';
    const SUB = 'https://app.example.com/';
    const OTHER = 'https://other.com/';

    // ── Default + global ─────────────────────────────────────────────────────
    await send({ type: 'CLEAR_ALL_DOMAINS' });
    await send({ type: 'SET_GLOBAL_THROTTLE', ms: 250 });
    assert('default global delay resolves (250)', (await delayFor(E)) === 250, String(await delayFor(E)));

    await send({ type: 'SET_GLOBAL_THROTTLE', ms: 800 });
    assert('global delay change resolves (800)', (await delayFor(E)) === 800, String(await delayFor(E)));

    // ── Clamping ─────────────────────────────────────────────────────────────
    await send({ type: 'SET_GLOBAL_THROTTLE', ms: 5 });
    assert('global delay clamps up to MIN 60', (await delayFor(E)) === 60, String(await delayFor(E)));
    await send({ type: 'SET_GLOBAL_THROTTLE', ms: 999999 });
    assert('global delay clamps down to MAX 5000', (await delayFor(E)) === 5000, String(await delayFor(E)));
    await send({ type: 'SET_GLOBAL_THROTTLE', ms: 250 });

    // ── Per-host precedence ──────────────────────────────────────────────────
    await send({ type: 'SET_THROTTLE_RULE', hostname: 'example.com', includeSubdomains: false, ms: 600 });
    assert('exact host rule wins', (await delayFor(E)) === 600, String(await delayFor(E)));
    assert('host-only rule does NOT cover subdomain', (await delayFor(SUB)) === 250, String(await delayFor(SUB)));

    await send({ type: 'SET_THROTTLE_RULE', hostname: 'example.com', includeSubdomains: true, ms: 1200 });
    assert('subdomain rule covers subdomain', (await delayFor(SUB)) === 1200, String(await delayFor(SUB)));
    assert('subdomain rule does not leak to other site', (await delayFor(OTHER)) === 250, String(await delayFor(OTHER)));

    await send({ type: 'SET_THROTTLE_RULE', hostname: 'app.example.com', includeSubdomains: false, ms: 300 });
    assert('exact host beats parent subdomain rule', (await delayFor(SUB)) === 300, String(await delayFor(SUB)));

    await send({ type: 'REMOVE_THROTTLE_RULE', hostname: 'app.example.com' });
    assert('removing exact rule falls back to parent subdomain', (await delayFor(SUB)) === 1200, String(await delayFor(SUB)));

    // Per-host rule is clamped too.
    await send({ type: 'SET_THROTTLE_RULE', hostname: 'tiny.com', includeSubdomains: false, ms: 1 });
    assert('per-host rule clamps to MIN', (await delayFor('https://tiny.com/')) === 60, String(await delayFor('https://tiny.com/')));

    // ── REMOVE_DOMAIN_CONFIG drops the throttle override too ──────────────────
    await send({ type: 'REMOVE_DOMAIN_CONFIG', hostname: 'example.com' });
    assert('REMOVE_DOMAIN_CONFIG clears the host throttle override', (await delayFor(E)) === 250, String(await delayFor(E)));

    // ── Import / export round-trip (+ re-clamp) ──────────────────────────────
    await send({ type: 'IMPORT_SETTINGS', data: {
      globalEnabled: true,
      globalThrottleDelay: 700,
      throttleDelayDomains: [
        { domain: 'x.com', includeSubdomains: true, ms: 900 },
        { domain: 'low.com', includeSubdomains: false, ms: 5 }    // clamps to 60
      ]
    } });
    const full = (await send({ type: 'GET_FULL_STATE' })).state;
    assert('import: global throttle applied', full.globalThrottleDelay === 700, String(full.globalThrottleDelay));
    assert('import: per-host throttle rule (subdomain) resolves', (await delayFor('https://sub.x.com/')) === 900, String(await delayFor('https://sub.x.com/')));
    assert('import: per-host throttle ms re-clamped', (await delayFor('https://low.com/')) === 60, String(await delayFor('https://low.com/')));

    // ── CLEAR_ALL_DOMAINS drops throttle overrides, keeps the global ──────────
    await send({ type: 'CLEAR_ALL_DOMAINS' });
    const cleared = (await send({ type: 'GET_FULL_STATE' })).state;
    assert('clear all empties throttle overrides', (cleared.throttleDelayDomains || []).length === 0,
      JSON.stringify(cleared.throttleDelayDomains));
    assert('clear all keeps the global throttle', cleared.globalThrottleDelay === 700, String(cleared.globalThrottleDelay));

    // ── Behaviour: a large delay reaches the content script ──────────────────
    // With a 2000 ms delay the post-burst flush is deferred far past the point
    // the default 250 ms would have completed — but the trailing flush still
    // drains every node eventually (the "last word" always lands).
    await send({ type: 'SET_GLOBAL_THROTTLE', ms: 2000 });
    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 700 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(700);
    assert('light page inverted (root on)', (await page.evaluate(() =>
      document.documentElement.getAttribute('data-darkabsolut'))) === 'on');

    // apply() runs full-document re-scans at +700/1800/4000 ms (a late-CSS
    // safety net independent of the throttle). Wait past all of them so the
    // burst below is processed ONLY by the throttled mutation observer.
    await page.waitForTimeout(4200);

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

    // +600ms: the default delay (250) would be fully drained by now; the big
    // 2000 ms delay must still be holding the work back (greedy re-analysis
    // suppressed — the whole point of the knob).
    await page.waitForTimeout(600);
    const early = await tagged();
    assert('large delay defers the burst (no greedy mid-storm pass)', early < N, `tagged ${early}/${N} at +600ms`);

    // After the configured delay elapses, the backlog is fully drained.
    await page.waitForTimeout(2600);
    const settled = await tagged();
    assert('trailing flush still drains every node ("last word")', settled === N, `tagged ${settled}/${N}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
