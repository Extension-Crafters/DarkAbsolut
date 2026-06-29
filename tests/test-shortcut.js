// Tests for the keyboard-shortcut feature (multi-binding, two actions).
//
//   * Popup recording UI: two action groups (current-site + global), each with
//     an "Add shortcut" recorder. Esc cancels; a non-modifier alone is
//     rejected; a qualifying combo is saved as a chip; several bindings per
//     action; the × button removes one.
//   * Background: ADD_SHORTCUT / REMOVE_SHORTCUT (validation + de-dupe),
//     TOGGLE_DOMAIN_DARK flips the active host, TOGGLE_GLOBAL_ENABLED flips the
//     master switch.
//   * End-to-end: pressing a bound combo toggles the live page (per-site) and
//     the master switch (global).
//   * Import/export round-trips the bindings (incl. legacy single migration).
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

// Dispatch a synthetic keydown into the popup's capture listener.
function keydown(opts) {
  return `document.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(opts)}))`;
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

    const ctl = await context.newPage();
    await ctl.goto(`chrome-extension://${extId}/popup/io.html`, { waitUntil: 'load' });
    const send = (msg) => ctl.evaluate(m => new Promise(r => chrome.runtime.sendMessage(m, r)), msg);
    const enabledFor = async (url) => (await send({ type: 'GET_STATE_FOR_URL', url })).enabled;
    const stored = () => w.evaluate(() => chrome.storage.local.get('shortcuts').then(s => s.shortcuts || {}));
    const fullState = async () => (await send({ type: 'GET_FULL_STATE' })).state;

    // ── Popup recording UI ───────────────────────────────────────────────────
    await send({ type: 'IMPORT_SETTINGS', data: { globalEnabled: true } }); // clears shortcuts
    const pop = await context.newPage();
    const popErrors = [];
    pop.on('pageerror', e => popErrors.push(String(e && e.message || e)));
    await pop.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await pop.waitForTimeout(400);

    const ui0 = await pop.evaluate(() => ({
      lists: !!document.getElementById('da-sc-list-domain') && !!document.getElementById('da-sc-list-global'),
      adds: !!document.getElementById('da-sc-add-domain') && !!document.getElementById('da-sc-add-global'),
      domainEmpty: document.getElementById('da-sc-list-domain').textContent.trim(),
      globalEmpty: document.getElementById('da-sc-list-global').textContent.trim(),
    }));
    assert('popup loads with no JS errors', popErrors.length === 0, popErrors.join(' | '));
    assert('two action groups (lists + add buttons) present', ui0.lists && ui0.adds);
    assert('both lists start at "None"', /none/i.test(ui0.domainEmpty) && /none/i.test(ui0.globalEmpty), `${ui0.domainEmpty}/${ui0.globalEmpty}`);

    // Start recording the current-site action, then Esc cancels.
    await pop.evaluate(() => document.getElementById('da-sc-add-domain').click());
    const rec = await pop.evaluate(() => ({
      label: document.getElementById('da-sc-add-domain').textContent.trim(),
      list: document.getElementById('da-sc-list-domain').textContent,
    }));
    assert('Add enters recording mode (chip + Cancel)', /cancel/i.test(rec.label) && /press keys/i.test(rec.list), JSON.stringify(rec));
    await pop.evaluate(keydown({ code: 'Escape', key: 'Escape', bubbles: true }));
    await pop.waitForTimeout(50);
    const afterEsc = await pop.evaluate(() => ({
      label: document.getElementById('da-sc-add-domain').textContent.trim(),
      list: document.getElementById('da-sc-list-domain').textContent.trim(),
    }));
    assert('Esc cancels recording (back to None / Add)', /none/i.test(afterEsc.list) && /add/i.test(afterEsc.label), JSON.stringify(afterEsc));
    assert('Esc cancel saved nothing', !((await stored()).toggleDomain || []).length);

    // Non-modifier alone is rejected.
    await pop.evaluate(() => document.getElementById('da-sc-add-domain').click());
    await pop.evaluate(keydown({ code: 'KeyD', key: 'd', bubbles: true }));
    await pop.waitForTimeout(50);
    const bare = await pop.evaluate(() => ({
      invalid: document.getElementById('da-sc-status').classList.contains('is-invalid'),
      label: document.getElementById('da-sc-add-domain').textContent.trim(),
    }));
    assert('non-modifier alone rejected (still recording)', bare.invalid && /cancel/i.test(bare.label), JSON.stringify(bare));

    // Qualifying combo Ctrl+Alt+D is accepted and chipped.
    await pop.evaluate(keydown({ code: 'KeyD', key: 'd', ctrlKey: true, altKey: true, bubbles: true }));
    await pop.waitForTimeout(450);
    let sc = await stored();
    const chip1 = await pop.evaluate(() => {
      const c = document.querySelector('#da-sc-list-domain .da-sc-chip');
      return c ? c.textContent.replace('×', '').trim() : '';
    });
    assert('Ctrl+Alt+D saved to toggleDomain', (sc.toggleDomain || []).length === 1 && sc.toggleDomain[0].code === 'KeyD', JSON.stringify(sc.toggleDomain));
    assert('binding rendered as chip "Ctrl + Alt + D"', chip1 === 'Ctrl + Alt + D', chip1);

    // A SECOND binding for the same action (multi-binding).
    await pop.evaluate(() => document.getElementById('da-sc-add-domain').click());
    await pop.evaluate(keydown({ code: 'KeyK', key: 'k', ctrlKey: true, altKey: true, bubbles: true }));
    await pop.waitForTimeout(450);
    sc = await stored();
    const chipCount = await pop.evaluate(() => document.querySelectorAll('#da-sc-list-domain .da-sc-chip').length);
    assert('second binding added (2 bindings, 2 chips)', (sc.toggleDomain || []).length === 2 && chipCount === 2, `len=${(sc.toggleDomain||[]).length} chips=${chipCount}`);

    // A binding for the GLOBAL action.
    await pop.evaluate(() => document.getElementById('da-sc-add-global').click());
    await pop.evaluate(keydown({ code: 'KeyG', key: 'g', ctrlKey: true, altKey: true, bubbles: true }));
    await pop.waitForTimeout(450);
    sc = await stored();
    assert('global binding saved to toggleGlobal', (sc.toggleGlobal || []).length === 1 && sc.toggleGlobal[0].code === 'KeyG', JSON.stringify(sc.toggleGlobal));

    // Remove the first current-site binding via its × button.
    await pop.evaluate(() => document.querySelector('#da-sc-list-domain .da-sc-chip .da-sc-chip-x').click());
    await pop.waitForTimeout(300);
    sc = await stored();
    assert('× removes one binding (KeyK remains)', (sc.toggleDomain || []).length === 1 && sc.toggleDomain[0].code === 'KeyK', JSON.stringify(sc.toggleDomain));
    await pop.close();

    // ── Background message validation ────────────────────────────────────────
    await send({ type: 'IMPORT_SETTINGS', data: { globalEnabled: true } });
    assert('ADD_SHORTCUT rejects unknown action', !(await send({ type: 'ADD_SHORTCUT', action: 'nope', shortcut: { ctrl: true, code: 'KeyD' } })).ok);
    await send({ type: 'ADD_SHORTCUT', action: 'toggleDomain', shortcut: { ctrl: true, alt: true, code: 'KeyD', key: 'd' } });
    await send({ type: 'ADD_SHORTCUT', action: 'toggleDomain', shortcut: { ctrl: true, alt: true, code: 'KeyD', key: 'd' } }); // dup
    assert('duplicate binding de-duped to one', ((await stored()).toggleDomain || []).length === 1);
    assert('REMOVE_SHORTCUT rejects bad index', !(await send({ type: 'REMOVE_SHORTCUT', action: 'toggleDomain', index: 9 })).ok);

    // ── TOGGLE_DOMAIN_DARK flips the active host's dark rule ──────────────────
    await send({ type: 'IMPORT_SETTINGS', data: { globalEnabled: true } });
    const HOST = 'https://shortcut-ex.com/';
    assert('fresh host enabled (global dark on)', await enabledFor(HOST));
    let r = await send({ type: 'TOGGLE_DOMAIN_DARK', url: HOST });
    assert('TOGGLE_DOMAIN_DARK → off (on:false)', r && r.ok && r.on === false, JSON.stringify(r && { ok: r.ok, on: r.on }));
    assert('host now disabled', !(await enabledFor(HOST)));
    r = await send({ type: 'TOGGLE_DOMAIN_DARK', url: HOST });
    assert('TOGGLE_DOMAIN_DARK → on (on:true)', r && r.ok && r.on === true);
    assert('host enabled again', await enabledFor(HOST));

    await send({ type: 'CLEAR_ALL_DOMAINS' });
    await send({ type: 'SET_FEATURE_RULE', feature: 'dark', hostname: 'sub-ex.com', includeSubdomains: true, on: true });
    await send({ type: 'TOGGLE_DOMAIN_DARK', url: 'https://sub-ex.com/' });
    const subRule = await w.evaluate(async () => {
      const s = await chrome.storage.local.get('disabledDomains');
      return (s.disabledDomains || []).find(e => e.domain === 'sub-ex.com') || null;
    });
    assert('toggle flips `on` but keeps includeSubdomains', subRule && subRule.on === false && subRule.includeSubdomains === true, JSON.stringify(subRule));

    // ── TOGGLE_GLOBAL_ENABLED flips the master switch ────────────────────────
    await send({ type: 'IMPORT_SETTINGS', data: { globalEnabled: true } });
    r = await send({ type: 'TOGGLE_GLOBAL_ENABLED' });
    assert('TOGGLE_GLOBAL_ENABLED → off', r && r.ok && r.on === false && (await fullState()).globalEnabled === false);
    r = await send({ type: 'TOGGLE_GLOBAL_ENABLED' });
    assert('TOGGLE_GLOBAL_ENABLED → on', r && r.ok && r.on === true && (await fullState()).globalEnabled === true);

    // ── End-to-end: per-site combo toggles the live page ─────────────────────
    await send({ type: 'IMPORT_SETTINGS', data: { globalEnabled: true } });
    await send({ type: 'ADD_SHORTCUT', action: 'toggleDomain', shortcut: { ctrl: true, alt: true, altGr: false, shift: false, meta: false, code: 'KeyD', key: 'd' } });
    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const isOn = async () => (await page.evaluate(() => document.documentElement.getAttribute('data-darkabsolut'))) === 'on';
    assert('light page auto-inverted to start', await isOn());

    const press = async (key) => {
      await page.bringToFront();
      await page.evaluate(() => window.focus());
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.press(key);
      await page.keyboard.up('Alt');
      await page.keyboard.up('Control');
    };

    await press('KeyD'); await page.waitForTimeout(800);
    assert('per-site press 1 → dark OFF for the site', !(await isOn()));
    await press('KeyD'); await page.waitForTimeout(800);
    assert('per-site press 2 → dark ON again', await isOn());
    await press('KeyK'); await page.waitForTimeout(400); // unbound key
    assert('unbound combo does not toggle', await isOn());

    // ── End-to-end: global combo flips the master switch ─────────────────────
    await send({ type: 'IMPORT_SETTINGS', data: { globalEnabled: true } });
    await send({ type: 'ADD_SHORTCUT', action: 'toggleGlobal', shortcut: { ctrl: true, alt: true, altGr: false, shift: false, meta: false, code: 'KeyG', key: 'g' } });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    assert('page inverted under master-on', await isOn());
    await press('KeyG'); await page.waitForTimeout(800);
    assert('global press 1 → master OFF (state + page reverts)',
      (await fullState()).globalEnabled === false && !(await isOn()));
    await press('KeyG'); await page.waitForTimeout(800);
    assert('global press 2 → master ON (state + page inverts)',
      (await fullState()).globalEnabled === true && await isOn());

    // ── Import/export round-trip + legacy migration ──────────────────────────
    let full = await fullState();
    assert('GET_FULL_STATE exposes shortcuts map', full.shortcuts && Array.isArray(full.shortcuts.toggleGlobal));
    await send({ type: 'IMPORT_SETTINGS', data: {
      globalEnabled: true,
      shortcuts: {
        toggleDomain: [{ ctrl: true, alt: true, code: 'KeyJ', key: 'j' }],
        toggleGlobal: [{ ctrl: false, alt: true, code: 'KeyM', key: 'm' }]
      }
    } });
    full = await fullState();
    assert('import: shortcuts kept per action',
      full.shortcuts.toggleDomain.length === 1 && full.shortcuts.toggleDomain[0].code === 'KeyJ'
      && full.shortcuts.toggleGlobal.length === 1 && full.shortcuts.toggleGlobal[0].code === 'KeyM',
      JSON.stringify(full.shortcuts));
    await send({ type: 'IMPORT_SETTINGS', data: {
      globalEnabled: true,
      toggleShortcut: { ctrl: true, alt: true, code: 'KeyL', key: 'l' } // legacy single
    } });
    full = await fullState();
    assert('import: legacy toggleShortcut migrates to toggleDomain',
      full.shortcuts.toggleDomain.length === 1 && full.shortcuts.toggleDomain[0].code === 'KeyL'
      && full.toggleShortcut === undefined,
      JSON.stringify(full.shortcuts));
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
