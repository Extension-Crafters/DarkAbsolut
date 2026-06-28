// Regenerate the store screenshots in screenshoots/ to reflect the current UI
// (incl. the new re-analyse-delay controls). Not part of `npm test`.
//
//   node tests/make-screenshots.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT = path.resolve(__dirname, '..');
const OUT = path.resolve(__dirname, '..', 'screenshoots');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-shots-'));

const HOST = 'news.ycombinator.com';

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true, channel: 'chromium', colorScheme: 'dark', deviceScaleFactor: 1,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { w = await context.waitForEvent('serviceworker', { timeout: 10000 }); } catch (_) {} }
    const extId = new URL(w.url()).host;

    // Seed representative settings: a per-site dark rule (so the 3-column table
    // is populated) and a per-site re-analyse-delay override (so the new feature
    // shows real values), plus a handful of saved sites for the options table.
    await w.evaluate((host) => chrome.storage.local.set({
      globalEnabled: true, mode: 'filter',
      globalDarkMode: true, globalNaturalImages: false, globalSoftGray: false,
      globalThrottleDelay: 250,
      disabledDomains: [
        { domain: host, includeSubdomains: true, on: true },
        { domain: 'example.org', includeSubdomains: false, on: false }
      ],
      noImageInversionDomains: [
        { domain: 'imgur.com', includeSubdomains: true, on: true }
      ],
      enhanceContrastDomains: [
        { domain: 'wikipedia.org', includeSubdomains: true, on: true }
      ],
      throttleDelayDomains: [
        { domain: host, includeSubdomains: false, ms: 600 },
        { domain: 'docs.google.com', includeSubdomains: false, ms: 1200 }
      ]
    }), HOST);

    // ── Popup (centered on a black 1280×800 stage, like the store shot) ───────
    const popup = await context.newPage();
    // Make the popup believe the active tab is news.ycombinator.com.
    await popup.addInitScript((host) => {
      const real = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q, cb) => {
        if (q && q.active) {
          const t = [{ id: 1, url: 'https://' + host + '/', active: true }];
          return cb ? cb(t) : Promise.resolve(t);
        }
        return real(q, cb);
      };
    }, HOST);
    await popup.setViewportSize({ width: 1280, height: 800 });
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await popup.waitForTimeout(500);

    // Float the popup on a black stage, top-aligned, scaled to fit 800px tall.
    await popup.evaluate(() => {
      const h = document.body.scrollHeight;
      // Scale the 320px popup to fill the 800px-tall stage (like the store shot),
      // capped so text stays crisp.
      const scale = Math.min(1.55, Math.max(1, 792 / h));
      const s = document.createElement('style');
      s.textContent = `
        html { background:#000; width:1280px; height:800px; overflow:hidden; }
        body {
          position:absolute; left:50%; top:4px;
          transform: translateX(-50%) scale(${scale});
          transform-origin: top center;
          box-shadow: 0 12px 48px rgba(0,0,0,.7);
          border-radius: 10px;
        }`;
      document.head.appendChild(s);
    });
    await popup.waitForTimeout(150);
    await popup.screenshot({ path: path.join(OUT, 'screen1.png'), clip: { x: 0, y: 0, width: 1280, height: 800 } });
    console.log('wrote screenshoots/screen1.png');

    // ── Options page (top region: Settings card + table header/rows) ─────────
    const opt = await context.newPage();
    await opt.setViewportSize({ width: 900, height: 900 });
    await opt.goto(`chrome-extension://${extId}/popup/options.html`, { waitUntil: 'load' });
    await opt.waitForFunction(() => document.querySelectorAll('#opt-rows tr').length > 0, { timeout: 5000 });
    await opt.waitForTimeout(300);
    // Capture from the top through the new global-delay row, the table header
    // (with the new column) and the first rows (one carries a "600 ms" badge).
    const h = await opt.evaluate(() => {
      const rows = document.querySelectorAll('#opt-rows tr');
      const target = rows[Math.min(2, rows.length - 1)];
      return Math.ceil(target.getBoundingClientRect().bottom + 16);
    });
    await opt.screenshot({ path: path.join(OUT, 'options-page.png'), clip: { x: 0, y: 0, width: 900, height: Math.min(h, 900) } });
    console.log('wrote screenshoots/options-page.png (height ' + Math.min(h, 900) + ')');
  } finally {
    await context.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
