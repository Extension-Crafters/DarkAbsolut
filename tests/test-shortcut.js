// Tests for the per-site toggle keyboard shortcut.
//
//   * Popup recording UI: Esc cancels; a non-modifier alone is rejected; a
//     qualifying combo (Ctrl/Alt/AltGr + key) is saved and rendered; Remove
//     clears the binding.
//   * Background TOGGLE_DOMAIN_DARK flips the active host's dark rule.
//   * End-to-end: pressing the bound combo on a real page toggles dark mode
//     on/off for that site.
//
//   node tests/test-shortcut.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-sc-'));

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

    // Control page for sending runtime messages from an extension context.
    const ctl = await context.newPage();
    await ctl.goto(`chrome-extension://${extId}/popup/io.html`, { waitUntil: 'load' });
    const send = (msg) => ctl.evaluate(m => new Promise(r => chrome.runtime.sendMessage(m, r)), msg);
    const enabledFor = async (url) => (await send({ type: 'GET_STATE_FOR_URL', url })).enabled;
    const storedShortcut = () => w.evaluate(() => chrome.storage.local.get('toggleShortcut').then(s => s.toggleShortcut));

    // ── Popup recording UI ───────────────────────────────────────────────────
    await send({ type: 'SET_TOGGLE_SHORTCUT', shortcut: null });
    const pop = await context.newPage();
    const popErrors = [];
    pop.on('pageerror', e => popErrors.push(String(e && e.message || e)));
    await pop.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await pop.waitForTimeout(400);

    const ui0 = await pop.evaluate(() => ({
      hasDisplay: !!document.getElementById('da-sc-display'),
      hasRecord: !!document.getElementById('da-sc-record'),
      removeHidden: document.getElementById('da-sc-remove').hidden,
      display: document.getElementById('da-sc-display').textContent.trim(),
      recordLabel: document.getElementById('da-sc-record').textContent.trim(),
    }));
    assert('popup loads with no JS errors', popErrors.length === 0, popErrors.join(' | '));
    assert('shortcut UI present (display + record button)', ui0.hasDisplay && ui0.hasRecord);
    assert('unset → "Not set", Remove hidden', /not set/i.test(ui0.display) && ui0.removeHidden, `${ui0.display} removeHidden=${ui0.removeHidden}`);

    // Start recording, then Escape cancels.
    await pop.evaluate(() => document.getElementById('da-sc-record').click());
    const recState = await pop.evaluate(() => ({
      recording: document.getElementById('da-sc-display').classList.contains('is-recording'),
      label: document.getElementById('da-sc-record').textContent.trim(),
    }));
    assert('clicking record enters recording mode', recState.recording && /cancel/i.test(recState.label), JSON.stringify(recState));
    await pop.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true })));
    await pop.waitForTimeout(50);
    const afterEsc = await pop.evaluate(() => ({
      display: document.getElementById('da-sc-display').textContent.trim(),
      recording: document.getElementById('da-sc-display').classList.contains('is-recording'),
    }));
    assert('Esc cancels recording (back to "Not set")', /not set/i.test(afterEsc.display) && !afterEsc.recording, JSON.stringify(afterEsc));
    assert('Esc cancel saved nothing', (await storedShortcut()) == null);

    // Record again: a non-modifier alone is rejected (stays recording).
    await pop.evaluate(() => document.getElementById('da-sc-record').click());
    await pop.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', bubbles: true })));
    await pop.waitForTimeout(50);
    const afterBare = await pop.evaluate(() => ({
      invalid: document.getElementById('da-sc-display').classList.contains('is-invalid'),
      stillRecording: document.getElementById('da-sc-record').textContent.trim(),
    }));
    assert('non-modifier alone is rejected', afterBare.invalid && /cancel/i.test(afterBare.stillRecording), JSON.stringify(afterBare));
    assert('rejected combo saved nothing', (await storedShortcut()) == null);

    // Now a qualifying combo (Ctrl+Alt+D) is accepted and rendered.
    await pop.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown',
      { code: 'KeyD', key: 'd', ctrlKey: true, altKey: true, bubbles: true })));
    await pop.waitForTimeout(450);
    const saved = await storedShortcut();
    const afterSave = await pop.evaluate(() => ({
      display: document.getElementById('da-sc-display').textContent.trim(),
      removeHidden: document.getElementById('da-sc-remove').hidden,
      recordLabel: document.getElementById('da-sc-record').textContent.trim(),
    }));
    assert('Ctrl+Alt+D saved to storage', !!saved && saved.code === 'KeyD' && saved.ctrl === true && saved.alt === true, JSON.stringify(saved));
    assert('saved combo rendered as "Ctrl + Alt + D"', afterSave.display === 'Ctrl + Alt + D', afterSave.display);
    assert('after save: Remove shown, button says Change', !afterSave.removeHidden && /change/i.test(afterSave.recordLabel), JSON.stringify(afterSave));

    // Remove clears the binding.
    await pop.evaluate(() => document.getElementById('da-sc-remove').click());
    await pop.waitForTimeout(300);
    assert('Remove clears the binding in storage', (await storedShortcut()) == null);
    const afterRemove = await pop.evaluate(() => document.getElementById('da-sc-display').textContent.trim());
    assert('Remove → display back to "Not set"', /not set/i.test(afterRemove), afterRemove);
    await pop.close();

    // ── Background TOGGLE_DOMAIN_DARK flips the host's dark rule ──────────────
    await send({ type: 'IMPORT_SETTINGS', data: { globalEnabled: true } }); // defaults: filter, dark global on
    const HOST = 'https://shortcut-ex.com/';
    assert('fresh host enabled (global dark on)', await enabledFor(HOST));
    let r = await send({ type: 'TOGGLE_DOMAIN_DARK', url: HOST });
    assert('TOGGLE_DOMAIN_DARK off → reports on:false', r && r.ok && r.on === false, JSON.stringify(r));
    assert('host now disabled', !(await enabledFor(HOST)));
    r = await send({ type: 'TOGGLE_DOMAIN_DARK', url: HOST });
    assert('TOGGLE_DOMAIN_DARK on → reports on:true', r && r.ok && r.on === true, JSON.stringify(r));
    assert('host enabled again', await enabledFor(HOST));

    // Toggling preserves an existing rule's subdomain scope.
    await send({ type: 'CLEAR_ALL_DOMAINS' });
    await send({ type: 'SET_FEATURE_RULE', feature: 'dark', hostname: 'sub-ex.com', includeSubdomains: true, on: true });
    await send({ type: 'TOGGLE_DOMAIN_DARK', url: 'https://sub-ex.com/' });
    const subRule = await w.evaluate(async () => {
      const s = await chrome.storage.local.get('disabledDomains');
      return (s.disabledDomains || []).find(e => e.domain === 'sub-ex.com') || null;
    });
    assert('toggle flips `on` but keeps includeSubdomains', subRule && subRule.on === false && subRule.includeSubdomains === true, JSON.stringify(subRule));

    // ── End-to-end: pressing the combo toggles the live page ─────────────────
    await send({ type: 'IMPORT_SETTINGS', data: { globalEnabled: true } });
    await send({ type: 'SET_TOGGLE_SHORTCUT', shortcut: { ctrl: true, alt: true, altGr: false, shift: false, meta: false, code: 'KeyD', key: 'd' } });

    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const applied = (await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'))) === 'on';
    assert('light page auto-inverted to start', applied);

    const pressCombo = async () => {
      await page.bringToFront();
      await page.evaluate(() => window.focus());
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.press('KeyD');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Control');
    };

    await pressCombo();
    await page.waitForTimeout(800);
    assert('shortcut press 1 → dark mode OFF for the site',
      (await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'))) !== 'on');

    await pressCombo();
    await page.waitForTimeout(800);
    assert('shortcut press 2 → dark mode ON again',
      (await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'))) === 'on');

    // A non-matching combo (wrong key) must NOT toggle.
    await page.keyboard.down('Control');
    await page.keyboard.down('Alt');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
    await page.waitForTimeout(500);
    assert('non-matching combo does not toggle',
      (await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'))) === 'on');

    // ── Import/export round-trips the binding ────────────────────────────────
    let full = (await send({ type: 'GET_FULL_STATE' })).state;
    assert('GET_FULL_STATE exposes toggleShortcut', full.toggleShortcut && full.toggleShortcut.code === 'KeyD', JSON.stringify(full.toggleShortcut));
    await send({ type: 'IMPORT_SETTINGS', data: {
      globalEnabled: true,
      toggleShortcut: { ctrl: false, alt: true, altGr: false, shift: false, meta: false, code: 'KeyJ', key: 'j' }
    } });
    full = (await send({ type: 'GET_FULL_STATE' })).state;
    assert('import: valid shortcut kept', full.toggleShortcut && full.toggleShortcut.code === 'KeyJ' && full.toggleShortcut.alt === true, JSON.stringify(full.toggleShortcut));
    await send({ type: 'IMPORT_SETTINGS', data: {
      globalEnabled: true,
      toggleShortcut: { code: 'KeyX' } // no qualifying modifier → dropped
    } });
    full = (await send({ type: 'GET_FULL_STATE' })).state;
    assert('import: unqualified shortcut dropped to null', full.toggleShortcut == null, JSON.stringify(full.toggleShortcut));
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
