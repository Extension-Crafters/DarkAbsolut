// Regression test: text that ends up dark-on-dark after the page invert must be
// rescued to a readable light colour.
//
// The bug (OVH Manager flyout sidebar): menu items carry a small icon set via
// `background-size: contain`, so shouldReinvertBgImage tags them for
// counter-invert. The counter-invert reverts each item's text back to its
// original dark colour, but the item's own background is transparent — so the
// dark text lands on the page-inverted (dark) panel behind it = dark-on-dark,
// nearly invisible. A post-pass must detect this and force the text light.
//
//   node tests/test-contrast-rescue.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { decodePng, pixelLum } = require('./lib/png');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-contrast-'));

// A MOSTLY-TRANSPARENT icon used as a `background-size: cover` image. The
// `cover` size trips shouldReinvertBgImage's counter-invert path, but because
// the image is almost entirely transparent the dark (page-inverted) panel
// shows through behind the item's reverted-to-dark text = the dark-on-dark bug.
const ICON =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'></svg>\")";

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>flyout</title>
<style>
  html,body{margin:0;background:#fff;font-family:sans-serif}
  /* light flyout panel (becomes dark after the page invert) */
  .flyout{background:#e8ecf3;width:320px;padding:16px}
  /* menu item with a cover-sized (mostly transparent) icon + muted dark text.
     The cover size trips the counter-invert heuristic. */
  .item{display:block;color:#46506a;font:600 18px sans-serif;padding:10px;
        background-image:${ICON};background-repeat:no-repeat;background-size:cover;
        text-decoration:none}
  /* On hover the site swaps in a pale highlight (like OVH's flyout). The rescue
     must defer to this so we don't get forced-light text on a light bg. */
  .item:hover{background-color:#dfe6f3}
  /* a plain text item with no bg-image — normal inversion, control */
  .plain{display:block;color:#46506a;font:600 18px sans-serif;padding:10px;text-decoration:none}
</style></head>
<body>
  <nav class="flyout">
    <a class="item"  id="buggy1">Managed Bare Metal</a>
    <a class="item"  id="buggy2">Cloud Disk Array</a>
    <a class="plain" id="control">Serveurs Prives Virtuels</a>
  </nav>
  ${'<p>filler text to fill the viewport. </p>'.repeat(30)}
</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

// Fraction of pixels in a screenshot buffer brighter than `thr`.
function brightFrac(buf, thr = 0.5) {
  const { width, height, channels, data } = decodePng(buf);
  let bright = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    if (pixelLum(data, i * channels, channels) > thr) bright++;
  }
  return bright / n;
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
    headless: true, channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }

    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 700 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(1200);

    const r = await page.evaluate(() => ({
      root: document.documentElement.getAttribute('data-darkabsolut'),
      buggyTagged: document.getElementById('buggy1').getAttribute('data-darkabsolut-bg'),
      buggyRescued: document.getElementById('buggy1').hasAttribute('data-darkabsolut-rtext'),
      controlRescued: document.getElementById('control').hasAttribute('data-darkabsolut-rtext'),
    }));

    assert('page is inverted', r.root === 'on', `root=${r.root}`);
    assert('icon item was tagged for counter-invert', r.buggyTagged === '1', `bg=${r.buggyTagged}`);

    const buggyShot = await page.locator('#buggy1').screenshot();
    const controlShot = await page.locator('#control').screenshot();
    const bf = brightFrac(buggyShot);
    const cf = brightFrac(controlShot);

    // The counter-inverted item's text must be visibly light (bright glyph
    // pixels present), not dark-on-dark.
    assert('counter-inverted menu text is readable (light glyphs)', bf > 0.02,
      `brightFrac=${bf.toFixed(4)}`);
    assert('rescue attribute set on the dark-on-dark item', r.buggyRescued === true,
      `rescued=${r.buggyRescued}`);

    // The normal control item is already readable via the page invert and must
    // NOT be touched by the rescue pass (no over-triggering).
    assert('normal menu text stays readable', cf > 0.02, `brightFrac=${cf.toFixed(4)}`);
    assert('rescue does NOT fire on normal text', r.controlRescued === false,
      `rescued=${r.controlRescued}`);

    // Loop guard: the rescue writes an inline `color`, which is a `style`
    // mutation the controller's observer watches. The rescue MUST be write-once
    // — otherwise observer → re-process → re-write churns forever and freezes
    // the page (the OVH Manager freeze regression). Add a dark-on-dark item
    // dynamically, then count ongoing style mutations after it settles.
    const churn = await page.evaluate(() => new Promise(resolve => {
      let count = 0;
      const mo = new MutationObserver(muts => {
        for (const m of muts) if (m.attributeName === 'style') count++;
      });
      mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['style'] });
      const a = document.createElement('a');
      a.className = 'item';
      a.id = 'buggy3';
      a.textContent = 'Backup Agent';
      document.querySelector('.flyout').appendChild(a);
      // Let the extension process + rescue it, then measure a quiet window.
      setTimeout(() => { count = 0; setTimeout(() => { mo.disconnect(); resolve(count); }, 600); }, 600);
    }));
    assert('no style-mutation loop after rescue settles', churn < 30, `style mutations/600ms=${churn}`);

    // Hover defer: the rescued item has rescue=2 → forced rgb(237,237,237).
    // On hover the site shows a pale highlight; the rescue must defer (drop our
    // forced light colour) so the text isn't light-on-light. After hover the
    // computed colour should revert to the site's original, not stay forced.
    const beforeHover = await page.evaluate(() => getComputedStyle(document.getElementById('buggy1')).color);
    await page.hover('#buggy1');
    await page.waitForTimeout(120);
    const onHover = await page.evaluate(() => getComputedStyle(document.getElementById('buggy1')).color);
    assert('rescue forces light text when not hovered', beforeHover === 'rgb(237, 237, 237)',
      `color=${beforeHover}`);
    assert('rescue defers to site styling on hover (not forced light)',
      onHover !== 'rgb(237, 237, 237)', `hoverColor=${onHover}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
