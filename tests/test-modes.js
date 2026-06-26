// Tests for working modes + the per-feature global-default column.
//
//   * Resolution precedence: exact host → subdomain rule → global default, with
//     valued (`on`) rules, via GET_STATE_FOR_URL.
//   * Mode behaviour: "filter" auto-applies per site; "once" never auto-applies
//     (APPLY_ONCE on click dark-modes the page); "toggle" follows a global
//     on/off and ignores per-site dark rules.
//   * Action config: the toolbar opens the popup only in "filter" mode.
//
//   node tests/test-modes.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-modes-'));

const LIGHT_PAGE = `<!doctype html><html><head><meta charset=utf-8><title>light</title>
<style>html,body{margin:0;background:#fff;color:#111}</style></head>
<body><h1>Light page</h1><p>plain white content</p></body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(LIGHT_PAGE);
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

    // Page used to send runtime messages from an extension context.
    const ctl = await context.newPage();
    await ctl.goto(`chrome-extension://${extId}/popup/io.html`, { waitUntil: 'load' });
    const send = (msg) => ctl.evaluate(m => new Promise(r => chrome.runtime.sendMessage(m, r)), msg);
    const enabledFor = async (url) => (await send({ type: 'GET_STATE_FOR_URL', url })).enabled;
    const stateFor = (url) => send({ type: 'GET_STATE_FOR_URL', url });
    const getPopup = () => w.evaluate(() => new Promise(r => chrome.action.getPopup({}, r)));
    const getTitle = () => w.evaluate(() => new Promise(r => chrome.action.getTitle({}, r)));

    const E = 'https://example.com/';
    const SUB = 'https://app.example.com/';
    const OTHER = 'https://other.com/';

    // ── Resolution precedence (filter mode) ──────────────────────────────────
    await send({ type: 'SET_MODE', mode: 'filter' });
    await send({ type: 'CLEAR_ALL_DOMAINS' });
    await send({ type: 'SET_GLOBAL_FEATURE', feature: 'dark', value: true });
    assert('global dark on → fresh site enabled', await enabledFor(E));

    await send({ type: 'SET_GLOBAL_FEATURE', feature: 'dark', value: false });
    assert('global dark off → fresh site disabled', !(await enabledFor(E)));

    await send({ type: 'SET_FEATURE_RULE', feature: 'dark', hostname: 'example.com', includeSubdomains: false, on: true });
    assert('host rule on beats global off', await enabledFor(E));
    assert('host-only rule does NOT cover subdomain', !(await enabledFor(SUB)));

    await send({ type: 'SET_FEATURE_RULE', feature: 'dark', hostname: 'example.com', includeSubdomains: true, on: true });
    assert('subdomain rule covers subdomain', await enabledFor(SUB));
    assert('subdomain rule does not leak to other site', !(await enabledFor(OTHER)));

    await send({ type: 'SET_FEATURE_RULE', feature: 'dark', hostname: 'app.example.com', includeSubdomains: false, on: false });
    assert('exact host off beats parent subdomain on', !(await enabledFor(SUB)));

    // restore default global
    await send({ type: 'CLEAR_ALL_DOMAINS' });
    await send({ type: 'SET_GLOBAL_FEATURE', feature: 'dark', value: true });

    // ── Per-feature image/contrast globals ───────────────────────────────────
    await send({ type: 'SET_GLOBAL_FEATURE', feature: 'img', value: true });
    assert('global natural-images on → resolves for fresh site',
      (await stateFor(E)).imageInversionDisabled === true);
    await send({ type: 'SET_GLOBAL_FEATURE', feature: 'img', value: false });
    await send({ type: 'SET_GLOBAL_FEATURE', feature: 'contrast', value: true });
    assert('global soft-gray on → resolves for fresh site',
      (await stateFor(E)).enhanceContrast === true);
    await send({ type: 'SET_GLOBAL_FEATURE', feature: 'contrast', value: false });

    // ── Action config: popup only in filter mode ─────────────────────────────
    await send({ type: 'SET_MODE', mode: 'filter' });
    assert('filter mode → toolbar opens popup', /popup\.html$/.test(await getPopup()), await getPopup());
    await send({ type: 'SET_MODE', mode: 'once' });
    assert('once mode → no popup (button runs action)', (await getPopup()) === '');
    await send({ type: 'SET_MODE', mode: 'toggle' });
    assert('toggle mode → no popup (button runs action)', (await getPopup()) === '');

    // ── "once" mode: never auto-applies; APPLY_ONCE dark-modes the page ───────
    await send({ type: 'SET_MODE', mode: 'once' });
    assert('once mode → GET_STATE_FOR_URL not enabled', !(await enabledFor(E)));
    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(900);
    assert('once mode: light page NOT auto-inverted',
      (await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'))) !== 'on');
    const tabId = await page.evaluate(() => 0); // placeholder; use tabs API via worker
    // Send APPLY_ONCE to the page's tab via the worker (find the matching tab).
    await w.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) if (t.url && t.url.startsWith(u)) {
        try { await chrome.tabs.sendMessage(t.id, { type: 'APPLY_ONCE' }); } catch (_) {}
      }
    }, base);
    await page.waitForTimeout(900);
    assert('once mode: APPLY_ONCE dark-modes the page',
      (await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'))) === 'on');

    // ── "toggle" mode: global on/off, ignores per-site dark rules ─────────────
    await send({ type: 'SET_MODE', mode: 'toggle' });
    await send({ type: 'SET_TOGGLE', value: true });
    assert('toggle on → enabled regardless of host', await enabledFor(OTHER));
    await send({ type: 'SET_TOGGLE', value: false });
    assert('toggle off → disabled everywhere', !(await enabledFor(OTHER)));
    // Off-state drives the sun icon; the title is the queryable proxy. The two
    // titles are distinguished by their call-to-action ("turn on" vs "turn off").
    assert('toggle off → "turn on" title (sun icon)', /turn on/i.test(await getTitle()), await getTitle());
    await send({ type: 'SET_TOGGLE', value: true });
    assert('toggle on → "turn off" title (moon icon)', /turn off/i.test(await getTitle()), await getTitle());
    await send({ type: 'SET_TOGGLE', value: false });
    // toggling re-evaluates open tabs: turn on, the once-loaded page should invert.
    await send({ type: 'SET_TOGGLE', value: true });
    await page.waitForTimeout(700);
    assert('toggle on broadcasts → open light page inverts',
      (await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'))) === 'on');
    await send({ type: 'SET_TOGGLE', value: false });
    await page.waitForTimeout(700);
    assert('toggle off broadcasts → open page reverts',
      (await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'))) !== 'on');

    // ── Migration: legacy entries (no `on`) keep their historic meaning ──────
    await w.evaluate(() => chrome.storage.local.clear());
    await w.evaluate(() => chrome.storage.local.set({
      globalEnabled: true,
      disabledDomains: [{ domain: 'example.com', includeSubdomains: false }],
      noImageInversionDomains: [{ domain: 'pics.com', includeSubdomains: false }],
      enhanceContrastDomains: [{ domain: 'gray.com', includeSubdomains: false }]
    }));
    assert('legacy disabled entry → dark OFF', !(await enabledFor('https://example.com/')));
    assert('legacy noImageInversion entry → natural images ON',
      (await stateFor('https://pics.com/')).imageInversionDisabled === true);
    assert('legacy enhanceContrast entry → soft-gray ON',
      (await stateFor('https://gray.com/')).enhanceContrast === true);
    assert('migrated: unlisted site → dark ON (global default)', await enabledFor('https://fresh.com/'));

    // ── Import: v2 round-trips; v1 (legacy, no `on`/mode/globals) still works ─
    await send({ type: 'IMPORT_SETTINGS', data: {
      globalEnabled: true, mode: 'toggle', toggleOn: true,
      globalDarkMode: false, globalNaturalImages: true, globalSoftGray: true,
      disabledDomains: [{ domain: 'a.com', includeSubdomains: true, on: true }],
      noImageInversionDomains: [], enhanceContrastDomains: []
    } });
    let full = (await send({ type: 'GET_FULL_STATE' })).state;
    assert('v2 import: mode + globals', full.mode === 'toggle' && full.globalDarkMode === false
      && full.globalNaturalImages === true && full.globalSoftGray === true);
    assert('v2 import: valued rule `on`/sub preserved',
      full.disabledDomains.length === 1 && full.disabledDomains[0].on === true
      && full.disabledDomains[0].includeSubdomains === true);

    await send({ type: 'IMPORT_SETTINGS', data: {
      version: 1, globalEnabled: true,
      disabledDomains: [{ domain: 'old.com', includeSubdomains: false }]
    } });
    assert('v1 import: legacy disabled → dark OFF', !(await enabledFor('https://old.com/')));
    assert('v1 import: other site → dark ON (default global)', await enabledFor('https://new.com/'));
    full = (await send({ type: 'GET_FULL_STATE' })).state;
    assert('v1 import: defaults applied (filter mode, dark global on)',
      full.mode === 'filter' && full.globalDarkMode === true);

    // ── Master kill switch beats "once" (BUG-2 defense-in-depth) ─────────────
    await send({ type: 'IMPORT_SETTINGS', data: { globalEnabled: true } });
    await send({ type: 'SET_MODE', mode: 'once' });
    await send({ type: 'SET_GLOBAL_ENABLED', value: false });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    await w.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) if (t.url && t.url.startsWith(u)) {
        try { await chrome.tabs.sendMessage(t.id, { type: 'APPLY_ONCE' }); } catch (_) {}
      }
    }, base);
    await page.waitForTimeout(700);
    assert('master off: APPLY_ONCE does NOT invert',
      (await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'))) !== 'on');
    await send({ type: 'SET_GLOBAL_ENABLED', value: true });

    // ── "once": a forced page survives a STATE_UPDATED broadcast ─────────────
    await send({ type: 'SET_MODE', mode: 'once' });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    await w.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) if (t.url && t.url.startsWith(u)) {
        try { await chrome.tabs.sendMessage(t.id, { type: 'APPLY_ONCE' }); } catch (_) {}
      }
    }, base);
    await page.waitForTimeout(700);
    assert('once: APPLY_ONCE inverts the page',
      (await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'))) === 'on');
    await send({ type: 'SET_GLOBAL_FEATURE', feature: 'img', value: true }); // broadcasts
    await page.waitForTimeout(700);
    assert('once: forced page survives a settings broadcast',
      (await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'))) === 'on');
    await send({ type: 'SET_GLOBAL_FEATURE', feature: 'img', value: false });

    // ── BUG-1: popup host checkbox can override a parent subdomain rule ───────
    await send({ type: 'IMPORT_SETTINGS', data: { globalEnabled: true } });
    await send({ type: 'SET_FEATURE_RULE', feature: 'dark', hostname: 'example.com', includeSubdomains: true, on: false });
    const pop = await context.newPage();
    await pop.addInitScript(() => {
      // Drive the popup as if the active tab were app.example.com (a subdomain
      // governed by the parent example.com include-subdomains rule).
      const real = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q, cb) => {
        if (q && q.active) { const t = [{ id: 999, url: 'https://app.example.com/' }]; return cb ? cb(t) : Promise.resolve(t); }
        return real(q, cb);
      };
    });
    await pop.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await pop.waitForTimeout(400);
    assert('BUG-1: subdomain inherits parent rule (host box unchecked)',
      (await pop.evaluate(() => document.getElementById('da-domain').checked)) === false);
    await pop.evaluate(() => {
      const c = document.getElementById('da-domain');
      c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await pop.waitForTimeout(500);
    const ruleOn = await w.evaluate(async () => {
      const s = await chrome.storage.local.get('disabledDomains');
      const r = (s.disabledDomains || []).find(e => e.domain === 'app.example.com');
      return r ? r.on : null;
    });
    assert('BUG-1: checking host box writes an exact override (on:true)', ruleOn === true);
    assert('BUG-1: host box stays checked after override',
      (await pop.evaluate(() => document.getElementById('da-domain').checked)) === true);
    await pop.close();
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
