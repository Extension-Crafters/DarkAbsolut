// Diagnostic harness: load the unpacked extension on a real URL (headless),
// then dump what DarkAbsolut did to the top/header region and screenshot it.
//
//   node tests/diag.js <url> [name]
//
// Output: tests/screenshots/diag-<name>.png plus a JSON-ish dump on stdout.
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const URL  = process.argv[2] || 'https://online.vfsevisa.com/thai/en/on-boarding';
const NAME = (process.argv[3] || URL.replace(/[^a-z0-9]+/gi, '_')).slice(0, 60);
const EXT_PATH  = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(__dirname, 'screenshots');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-diag-'));
fs.mkdirSync(SHOTS_DIR, { recursive: true });

// In-page probe. Walks the top strip and reports, for the topmost opaque
// container at a set of x positions, everything relevant to our heuristics.
function probe() {
  function rgb(s) {
    const m = s && s.match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const p = m[1].split(',').map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p[3] == null ? 1 : p[3] };
  }
  function lum(c) {
    if (!c) return null;
    const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return +(0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)).toFixed(3);
  }
  function describe(el) {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const attrs = {};
    for (const a of ['data-darkabsolut', 'data-darkabsolut-bg', 'data-darkabsolut-darknative',
                     'data-darkabsolut-lightnative', 'data-darkabsolut-bg-orig', 'data-darkabsolut-color-orig']) {
      if (el.hasAttribute(a)) attrs[a] = el.getAttribute(a);
    }
    const bc = rgb(cs.backgroundColor);
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 60),
      id: el.id || '',
      bgColor: cs.backgroundColor,
      bgLum: lum(bc),
      color: cs.color,
      colorLum: lum(rgb(cs.color)),
      bgImage: cs.backgroundImage.slice(0, 80),
      bgSize: cs.backgroundSize,
      bgRepeat: cs.backgroundRepeat,
      filter: cs.filter && cs.filter !== 'none' ? cs.filter.slice(0, 40) : 'none',
      rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x | 0, y: r.y | 0, w: r.width | 0, h: r.height | 0 }; })(),
      attrs
    };
  }
  const W = innerWidth, H = innerHeight;
  const out = { url: location.href, root: document.documentElement.getAttribute('data-darkabsolut'),
                colorScheme: getComputedStyle(document.documentElement).colorScheme, columns: [] };
  // Probe the header strip at a few x positions and a couple of heights.
  for (const fy of [0.02, 0.05, 0.10]) {
    const y = Math.max(1, Math.floor(H * fy));
    const row = { y, points: [] };
    for (const fx of [0.1, 0.5, 0.9]) {
      const x = Math.floor(W * fx);
      let el; try { el = document.elementFromPoint(x, y); } catch (_) { el = null; }
      // Walk up to the first element carrying a DA attribute or an opaque bg.
      const chain = [];
      let cur = el, hops = 0;
      while (cur && cur.nodeType === 1 && hops++ < 8) {
        chain.push(describe(cur));
        cur = cur.parentElement;
      }
      row.points.push({ x, chain });
    }
    out.columns.push(row);
  }
  return out;
}

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true,
    channel: 'chromium', // full Chrome-for-Testing build — headless_shell can't load extensions
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
    ],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) { try { worker = await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }

    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(60000);
    try {
      await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
    } catch (e) {
      console.error('navigation warning:', e.message);
    }
    // Let the controller's timed re-checks + observers settle.
    await page.waitForTimeout(3500);

    const info = await page.evaluate(probe);
    console.log(JSON.stringify(info, null, 2));

    const shot = path.join(SHOTS_DIR, `diag-${NAME}.png`);
    await page.screenshot({ path: shot });
    console.log('\nscreenshot ->', shot);
  } finally {
    await context.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
