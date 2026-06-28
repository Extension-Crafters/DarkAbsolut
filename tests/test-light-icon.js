// Regression test for the light vector-SVG icon rescue. On a mixed page that DA
// inverts, a small SVG glyph that is ALREADY light (e.g. a prefers-dark icon on
// an otherwise-light page — the Gmail header) would be flipped to black-on-dark.
// DA tags such glyphs (data-darkabsolut-lighticon) so CSS counter-inverts them
// back to light. Dark glyphs and large light SVGs (logos/illustrations) are left
// to invert with the page as before.
//
//   node tests/test-light-icon.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-lighticon-'));

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>lighticon</title>
<style>html,body{margin:0;background:#fff;color:#202124}</style></head>
<body>
 <h1>icons</h1>
 <!-- light glyph via explicit white fill -->
 <svg id="light" width="24" height="24" viewBox="0 0 24 24" fill="#ffffff"><path d="M3 3h18v18H3z"/></svg>
 <!-- light glyph via currentColor (the Gmail header pattern) -->
 <svg id="light-cc" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" style="color:#fff"><path d="M3 3h18v18H3z"/></svg>
 <!-- dark glyph: must NOT be rescued (inverts with the page to become light) -->
 <svg id="dark" width="24" height="24" viewBox="0 0 24 24" fill="#333333"><path d="M3 3h18v18H3z"/></svg>
 <!-- large light SVG (logo/illustration): too big to be a UI glyph -->
 <svg id="big" width="120" height="120" viewBox="0 0 24 24" fill="#ffffff"><path d="M3 3h18v18H3z"/></svg>
 <!-- small background-image glyphs (the Gmail nav-sprite case); filled at runtime
      with same-origin PNG data URIs so DA can sample them deterministically -->
 <div id="bg-light" style="width:20px;height:20px;background-repeat:no-repeat;background-size:20px"></div>
 <div id="bg-dark" style="width:20px;height:20px;background-repeat:no-repeat;background-size:20px"></div>
 <!-- mask-image glyphs (Gmail nav label/folder icons): the glyph is the mask,
      painted in background-color. Light bg-color → rescue; dark → invert. -->
 <div id="mask-light" style="width:20px;height:20px;background-color:#ffffff"></div>
 <div id="mask-dark"  style="width:20px;height:20px;background-color:#999999"></div>
 <script>
   function solid(color){ var c=document.createElement('canvas'); c.width=20; c.height=20;
     var x=c.getContext('2d'); x.fillStyle=color; x.fillRect(0,0,20,20); return c.toDataURL('image/png'); }
   document.getElementById('bg-light').style.backgroundImage = "url('"+solid('#ffffff')+"')";
   document.getElementById('bg-dark').style.backgroundImage  = "url('"+solid('#222222')+"')";
   var mask = "url(\\"data:image/svg+xml," + encodeURIComponent(
     "<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'><rect width='20' height='20' fill='white'/></svg>") + "\\")";
   ['mask-light','mask-dark'].forEach(function(id){ var e=document.getElementById(id);
     e.style.webkitMaskImage = mask; e.style.maskImage = mask; });
 </script>
</body></html>`;

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
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }
    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(900);

    assert('page inverted (root on)', (await page.evaluate(() =>
      document.documentElement.getAttribute('data-darkabsolut'))) === 'on');

    const probe = (id) => page.evaluate((id) => {
      const el = document.getElementById(id);
      return { lighticon: el.getAttribute('data-darkabsolut-lighticon'),
               filter: getComputedStyle(el).filter };
    }, id);

    const light = await probe('light');
    assert('explicit-white glyph → tagged lighticon + counter-inverted',
      light.lighticon === '1' && /invert/.test(light.filter), JSON.stringify(light));

    const lightCc = await probe('light-cc');
    assert('currentColor white glyph → tagged lighticon + counter-inverted',
      lightCc.lighticon === '1' && /invert/.test(lightCc.filter), JSON.stringify(lightCc));

    const dark = await probe('dark');
    assert('dark glyph → NOT rescued (filter none, inverts with page)',
      dark.lighticon !== '1' && dark.filter === 'none', JSON.stringify(dark));

    const big = await probe('big');
    assert('large light SVG (logo) → NOT rescued (too big for a UI glyph)',
      big.lighticon !== '1', JSON.stringify(big));

    // Background-image glyphs are sampled asynchronously — give it a moment.
    await page.waitForTimeout(900);
    const bgLight = await probe('bg-light');
    assert('light bg-image glyph → sampled + tagged lighticon (counter-inverted)',
      bgLight.lighticon === '1' && /invert/.test(bgLight.filter), JSON.stringify(bgLight));

    const bgDark = await probe('bg-dark');
    assert('dark bg-image glyph → NOT rescued (inverts with the page)',
      bgDark.lighticon !== '1', JSON.stringify(bgDark));

    const maskLight = await probe('mask-light');
    assert('light mask-image glyph → tagged lighticon (counter-inverted)',
      maskLight.lighticon === '1' && /invert/.test(maskLight.filter), JSON.stringify(maskLight));

    const maskDark = await probe('mask-dark');
    assert('mid/dark mask-image glyph → NOT rescued (filter none, inverts with page)',
      maskDark.lighticon !== '1' && maskDark.filter === 'none', JSON.stringify(maskDark));
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
