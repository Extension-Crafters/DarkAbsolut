// Smoke test for the full-page options table (popup/options.html) and its
// REMOVE_DOMAIN_CONFIG / CLEAR_ALL_DOMAINS background messages.
//
// Run: node tests/test-options.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const EXT_PATH = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-opt-'));

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

const sendFrom = (page, msg) =>
  page.evaluate(m => new Promise(r => chrome.runtime.sendMessage(m, r)), msg);

(async () => {
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
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = new URL(worker.url()).host;

    // Seed state from a real extension page (so sendMessage hits the router).
    const seed = await context.newPage();
    await seed.goto(`chrome-extension://${extId}/popup/io.html`, { waitUntil: 'load' });
    await sendFrom(seed, { type: 'SET_DOMAIN_DISABLED', hostname: 'example.com', disabled: true, includeSubdomains: true });
    await sendFrom(seed, { type: 'SET_DOMAIN_DISABLED', hostname: 'news.example.org', disabled: true, includeSubdomains: false });
    await sendFrom(seed, { type: 'SET_DOMAIN_IMAGE_INVERSION_DISABLED', hostname: 'example.com', disabled: true, includeSubdomains: false });
    await sendFrom(seed, { type: 'SET_DOMAIN_IMAGE_INVERSION_DISABLED', hostname: 'shimga.com', disabled: true, includeSubdomains: true });

    // Open the options page.
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/popup/options.html`, { waitUntil: 'load' });
    await opt.waitForFunction(() => document.querySelectorAll('#opt-rows tr').length > 0, { timeout: 5000 });

    // 3 distinct domains: example.com (merged), news.example.org, shimga.com
    const rowCount = await opt.evaluate(() => document.querySelectorAll('#opt-rows tr').length);
    assert('table renders one row per distinct host', rowCount === 3, `rows=${rowCount}`);

    const countText = await opt.evaluate(() => document.getElementById('opt-count-top').textContent);
    assert('header count matches row count', countText === '3', `count=${countText}`);

    // Link points to the right site and opens in a new tab.
    const link = await opt.evaluate(() => {
      const a = document.querySelector('#opt-rows a.opt-link');
      return { href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') };
    });
    assert('site link is https + new tab', /^https:\/\/example\.com\//.test(link.href) && link.target === '_blank' && /noopener/.test(link.rel), JSON.stringify(link));

    // Merged row shows both a theme-disabled badge AND an images-forced badge.
    const merged = await opt.evaluate(() => {
      const rows = [...document.querySelectorAll('#opt-rows tr')];
      const tr = rows.find(r => r.textContent.includes('example.com') && !r.textContent.includes('news.'));
      return tr ? tr.innerText.replace(/\s+/g, ' ').trim() : null;
    });
    assert('merged row shows Disabled + Forced + subdomain note', merged && /Disabled/.test(merged) && /Forced/.test(merged) && /subdomains/.test(merged), merged);

    // Remove a single host.
    await opt.evaluate(() => document.querySelector('button.opt-remove[data-host="news.example.org"]').click());
    await opt.waitForFunction(() => document.querySelectorAll('#opt-rows tr').length === 2, { timeout: 5000 });
    const afterRemove = await sendFrom(opt, { type: 'GET_FULL_STATE' });
    const stillThere = afterRemove.state.disabledDomains.some(e => e.domain === 'news.example.org');
    assert('remove deletes host from storage', !stillThere, JSON.stringify(afterRemove.state.disabledDomains));

    // Clear all (auto-accept the confirm dialog).
    opt.on('dialog', d => d.accept());
    await opt.evaluate(() => document.getElementById('opt-clear-top').click());
    await opt.waitForFunction(() => document.querySelectorAll('#opt-rows tr').length === 0, { timeout: 5000 });
    const emptyShown = await opt.evaluate(() => !document.getElementById('opt-empty').hidden);
    assert('empty state shown after clear all', emptyShown);
    const cleared = await sendFrom(opt, { type: 'GET_FULL_STATE' });
    assert('clear all empties both domain lists',
      cleared.state.disabledDomains.length === 0 && cleared.state.noImageInversionDomains.length === 0,
      JSON.stringify({ d: cleared.state.disabledDomains.length, n: cleared.state.noImageInversionDomains.length }));
    assert('clear all leaves global switch intact', cleared.state.globalEnabled === true, `global=${cleared.state.globalEnabled}`);
    assert('clear buttons disabled when empty',
      await opt.evaluate(() => document.getElementById('opt-clear-top').disabled && document.getElementById('opt-clear-bottom').disabled));
  } catch (err) {
    console.error('\nTEST ERROR:', err && err.stack || err);
    results.push({ name: 'harness ran without throwing', ok: false });
  } finally {
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    await context.close();
    fs.rmSync(USER_DATA, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  }
})();
