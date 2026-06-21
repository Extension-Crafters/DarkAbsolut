// Smoke test for the redesigned popup: it must load without JS errors, render
// the per-site feature table (3 features × 2 checkbox columns + column headers),
// and the "?" help affordance must populate the hint line.
//
//   node tests/test-popup.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-popup-'));

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true, channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { w = await context.waitForEvent('serviceworker', { timeout: 10000 }); } catch (_) {} }
    const extId = new URL(w.url()).host;

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e && e.message || e)));
    await page.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await page.waitForTimeout(600);

    const r = await page.evaluate(() => {
      const ids = ['da-global', 'da-domain', 'da-sub', 'da-noimg', 'da-noimg-sub', 'da-hc', 'da-hc-sub'];
      return {
        checkboxes: ids.filter(id => !!document.getElementById(id)),
        rows: document.querySelectorAll('.da-prow').length,
        cols: document.querySelectorAll('.da-phead .da-pcol').length,
        qs: document.querySelectorAll('.da-q').length,
        hasHint: !!document.getElementById('da-hint'),
        // no leftover removed elements referenced
        oldDesc: !!(document.getElementById('da-domain-desc') || document.getElementById('da-hc-desc')),
        // with no per-site rules, the subdomains column collapses and its
        // checkboxes are hidden — never a dead, non-interactive column.
        noSubsCollapsed: document.querySelector('.da-ptable').classList.contains('da-no-subs'),
        subBoxesHidden: ['da-sub', 'da-noimg-sub', 'da-hc-sub'].every(id => document.getElementById(id).hidden),
      };
    });

    assert('popup loads with no JS errors', errors.length === 0, errors.join(' | '));
    assert('all 7 switches/checkboxes present', r.checkboxes.length === 7, r.checkboxes.join(','));
    assert('feature table has header + 3 feature rows', r.rows === 4, `rows=${r.rows}`);
    assert('two checkbox column headers', r.cols === 2, `cols=${r.cols}`);
    assert('"?" help affordances present', r.qs >= 5, `qs=${r.qs}`);
    assert('hint line present, old desc rows gone', r.hasHint && !r.oldDesc, `hint=${r.hasHint} oldDesc=${r.oldDesc}`);
    assert('subdomains column collapsed with no rules', r.noSubsCollapsed, `noSubs=${r.noSubsCollapsed}`);
    assert('subdomain checkboxes hidden with no rules', r.subBoxesHidden, `hidden=${r.subBoxesHidden}`);

    // Tapping a "?" surfaces its explanation in the hint line.
    const hintText = await page.evaluate(() => {
      const q = document.querySelector('.da-q');
      q.click();
      return document.getElementById('da-hint').textContent;
    });
    assert('"?" tap shows a hint', !!hintText && hintText.length > 3, `hint="${hintText}"`);
  } finally {
    await context.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
