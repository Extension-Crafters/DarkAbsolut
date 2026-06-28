// Regression test for the translucent-dark-scrim handling (Gmail prefers-dark
// reading pane). On a light page DA root-inverts, a LARGE SEMI-TRANSPARENT
// neutral-dark element is a scrim/elevation overlay — counter-inverting it
// (darknative) washes it to light gray (a big light blob). So:
//   • scrim over LIGHT-THEMED content (dark foreground text) → NEUTRALISED
//     (background made transparent, NOT darknative) so the inverted-dark
//     backdrop shows through.
//   • scrim that is a genuine DARK-THEMED region (LIGHT foreground icons/text)
//     → kept darknative, so its light content isn't inverted to black-on-black.
//   • a SMALL translucent dark element stays on the darknative path (not a
//     page-dominating scrim).
//   • an OPAQUE dark surface stays darknative as before.
//
//   node tests/test-scrim.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-scrim-'));

// A light page (DA inverts it) with four probe elements.
const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>scrim</title>
<style>html,body{margin:0;background:#fff;color:#202124;font-family:sans-serif}
 .big{width:700px;height:300px;margin:8px}
 .small{width:120px;height:80px;margin:8px}
 /* translucent neutral-dark scrim */
 .scrim{background:rgba(51,51,51,0.8)}
 /* opaque dark surface */
 .solid{background:rgb(17,17,17)}
 .darkfg{color:#202124}   /* dark text  → light-themed content under the scrim */
 .lightfg{color:#eeeeee}  /* light text → genuine dark-themed region */
</style></head>
<body>
 <div id="over-light" class="big scrim darkfg">dark text on a big translucent scrim</div>
 <div id="dark-region" class="big scrim lightfg">light text on a big translucent scrim</div>
 <div id="small-scrim" class="small scrim lightfg">small</div>
 <div id="opaque" class="big solid lightfg">opaque dark surface</div>
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
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(900);

    assert('page inverted (root on)', (await page.evaluate(() =>
      document.documentElement.getAttribute('data-darkabsolut'))) === 'on');

    const probe = (id) => page.evaluate((id) => {
      const el = document.getElementById(id);
      return {
        darknative: el.getAttribute('data-darkabsolut-darknative'),
        bgOrig: el.hasAttribute('data-darkabsolut-bg-orig'),
        inlineBg: el.style.getPropertyValue('background-color'),
      };
    }, id);

    const overLight = await probe('over-light');
    assert('scrim over light content → neutralised (transparent, not darknative)',
      overLight.bgOrig && overLight.darknative !== '1' && overLight.inlineBg === 'transparent',
      JSON.stringify(overLight));

    const darkRegion = await probe('dark-region');
    assert('genuine dark region (light fg) → kept darknative, not neutralised',
      darkRegion.darknative === '1' && !darkRegion.bgOrig,
      JSON.stringify(darkRegion));

    const small = await probe('small-scrim');
    assert('small translucent dark element → not neutralised (darknative path)',
      !small.bgOrig, JSON.stringify(small));

    const opaque = await probe('opaque');
    assert('opaque dark surface → darknative as before (not neutralised)',
      opaque.darknative === '1' && !opaque.bgOrig, JSON.stringify(opaque));
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
