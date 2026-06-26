// Regression test: a form field with light text (and a light ::placeholder)
// must stay readable after the page invert.
//
// The bug (Gmail search box): the search <input> is styled with light text
// (color: rgba(255,255,255,0.87)) sitting on a light bar. The page invert flips
// that text to near-black on the now-dark bar — unreadable typed text AND an
// unreadable placeholder. The text rescue used to skip form fields entirely
// (an <input> has no child text node, and ::placeholder is a pseudo-element),
// so neither was fixed. The rescue now covers text fields, and a matching
// ::placeholder CSS rule forces the placeholder readable too.
//
//   node tests/test-input-placeholder.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { decodePng, pixelLum } = require('./lib/png');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-input-'));

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>search</title>
<style>
  html,body{margin:0;background:#fff;font-family:sans-serif}
  /* Gmail-like search bar: a light bar with a transparent input whose text +
     placeholder are LIGHT (the page invert turns them dark-on-dark). */
  .bar{background:#e6ebf5;padding:8px 16px;width:600px}
  .lighttext{background:transparent;border:0;outline:0;font-size:18px;width:100%;
          color:rgba(255,255,255,0.87)}
  .lighttext::placeholder{color:rgba(255,255,255,0.87);opacity:1}
  /* Control: a normal input — dark text on white. After invert it renders light
     on dark, already readable, so the rescue must NOT touch it. */
  .plainbar{background:#fff;padding:8px 16px;width:600px;margin-top:12px}
  #plain{border:1px solid #ccc;font-size:18px;width:100%;color:#202124}
  #plain::placeholder{color:#5f6368}
</style></head>
<body>
  <div class="bar"><input id="search" class="lighttext" type="text" placeholder="Search mail"></div>
  <div class="bar"><input id="searchType" class="lighttext" type="search" placeholder="Search type"></div>
  <div class="bar"><input id="emailType" class="lighttext" type="email" placeholder="Email type"></div>
  <div class="plainbar"><input id="plain" type="text" placeholder="Type here"></div>
  ${'<p>filler to fill the viewport so the page reads light.</p>'.repeat(30)}
</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

function brightFrac(buf, thr = 0.5) {
  const { width, height, channels, data } = decodePng(buf);
  let bright = 0; const n = width * height;
  for (let i = 0; i < n; i++) if (pixelLum(data, i * channels, channels) > thr) bright++;
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
    headless: true, channel: 'chromium', colorScheme: 'light',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }
    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 700 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(1200);

    const r = await page.evaluate(() => {
      const get = id => {
        const e = document.getElementById(id);
        return { rtext: e.getAttribute('data-darkabsolut-rtext'),
                 color: getComputedStyle(e).color, ph: getComputedStyle(e, '::placeholder').color };
      };
      return {
        root: document.documentElement.getAttribute('data-darkabsolut'),
        search: get('search'), searchType: get('searchType'), emailType: get('emailType'),
        plainRescue: document.getElementById('plain').hasAttribute('data-darkabsolut-rtext'),
      };
    });

    assert('page is inverted', r.root === 'on', `root=${r.root}`);
    // The light-text field is rescued: its colour (and placeholder) is forced to
    // the near-black value the page invert flips back to light.
    assert('search field is rescued', r.search.rtext === '1', `rtext=${r.search.rtext}`);
    assert('search text colour forced to rescue value', r.search.color === 'rgb(20, 20, 20)', `color=${r.search.color}`);
    assert('search ::placeholder colour forced to rescue value', r.search.ph === 'rgb(20, 20, 20)', `ph=${r.search.ph}`);
    // Other text-bearing input types (search, email) are handled identically —
    // guards isTextField()/TEXT_INPUT_TYPES against dropping a type.
    assert('type=search field is rescued', r.searchType.rtext === '1', `rtext=${r.searchType.rtext}`);
    assert('type=search ::placeholder forced light', r.searchType.ph === 'rgb(20, 20, 20)', `ph=${r.searchType.ph}`);
    assert('type=email field is rescued', r.emailType.rtext === '1', `rtext=${r.emailType.rtext}`);
    assert('type=email ::placeholder forced light', r.emailType.ph === 'rgb(20, 20, 20)', `ph=${r.emailType.ph}`);
    // The normal dark-text field already renders light after invert — untouched.
    assert('normal input is NOT rescued', r.plainRescue === false, `rescued=${r.plainRescue}`);

    // The placeholder must render visibly light (bright glyph pixels) on the
    // now-dark bar, not dark-on-dark.
    const shot = await page.locator('#search').screenshot();
    const bf = brightFrac(shot);
    assert('search placeholder renders as light glyphs', bf > 0.02, `brightFrac=${bf.toFixed(4)}`);

    // On hover the rescue must NOT defer (a field's background doesn't swap on
    // hover, unlike a menu item) — the value/placeholder must stay readable.
    await page.hover('#search');
    await page.waitForTimeout(150);
    const hover = await page.evaluate(() => ({
      color: getComputedStyle(document.getElementById('search')).color,
      ph: getComputedStyle(document.getElementById('search'), '::placeholder').color,
    }));
    assert('search text stays rescued on hover', hover.color === 'rgb(20, 20, 20)', `color=${hover.color}`);
    assert('search ::placeholder stays rescued on hover', hover.ph === 'rgb(20, 20, 20)', `ph=${hover.ph}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
