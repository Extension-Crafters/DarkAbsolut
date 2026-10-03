// Regression test: a gradient's light/dark verdict weighs each colour stop by
// the LENGTH of gradient line it colours, not once per stop.
//
// canva.com's hero runs deep purple → blue over its first 57 %, then packs
// three near-white stops into the last quarter. Averaging the stops called it
// "light" (0.52 ≥ 0.5), so it was left to the page filter, which turned the
// purple into a pale pink wash over most of the screen. By area it is dark
// (0.38): it must be kept, like any dark/mid gradient.
//
//   1. Mostly-dark gradient with light stops packed at the end → kept ([bg]).
//   2. The mirror case — mostly-light gradient with dark stops packed at the
//      end — is no longer kept light: it goes dark with the page.
//   3. A LIGHT gradient clipped to the text is ink, not a light surface: it
//      keeps its colours (stripe.com's yellow→pink numerals would otherwise go
//      dark on the dark page).
//   4. Unchanged: evenly spaced light / dark gradients, a repeating gradient
//      with px stops, and a 3-stop brand gradient.
//
//   node tests/test-gradient-weight.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { decodePng } = require('./lib/png');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-gradw-'));

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>gradient-weight</title>
<style>
  html,body{margin:0;background:#fff;color:#222;font-family:sans-serif}
  .g{width:900px;height:300px;margin-bottom:16px}
  #canva{height:500px;background:linear-gradient(rgb(153,43,255) 0%,rgb(90,50,250) 30.09%,rgb(19,163,181) 56.76%,
    rgb(147,232,246) 76.85%,rgb(241,235,255) 95.28%,rgb(255,255,255) 100%)}
  #mostlylight{height:500px;background:linear-gradient(#ffffff 0%,#f4f6fa 80%,#20242c 92%,#101216 96%,#000000 100%)}
  #light2{background:linear-gradient(135deg,#ffffff 0%,#eef3f8 100%)}
  #dark2{background:linear-gradient(135deg,#10243b 0%,#1f4e79 100%)}
  #stripes{background:repeating-linear-gradient(45deg,#111111 0px,#111111 10px,#222222 10px,#222222 20px)}
  #brand3{background:linear-gradient(-90deg,#ff9100 0%,#f10366 50%,#6173ff 100%)}
  #gtext{font-size:80px;font-weight:bold;margin:0 0 16px;width:900px;color:transparent;
    background:linear-gradient(90deg,#ffd601 0%,#ffc0f4 100%);-webkit-background-clip:text;background-clip:text}
</style></head>
<body>
  <div class="g" id="canva"></div>
  <div class="g" id="mostlylight"></div>
  <div class="g" id="light2"></div>
  <div class="g" id="dark2"></div>
  <div class="g" id="stripes"></div>
  <div class="g" id="brand3"></div>
  <h2 id="gtext">Gradient text</h2>
</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

function avgColor(buf) {
  const { width, height, channels, data } = decodePng(buf);
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
  }
  return { r: r / n, g: g / n, b: b / n };
}
const lumOf = c => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
const fmt = c => `lum=${lumOf(c).toFixed(2)} rgb(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`;

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
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    const r = await page.evaluate(() => {
      const out = { root: document.documentElement.getAttribute('data-darkabsolut') };
      for (const el of document.querySelectorAll('.g, #gtext')) out[el.id] = el.getAttribute('data-darkabsolut-bg');
      return out;
    });
    // Average colour of the top 40 % of an element (where the first stops paint).
    const topOf = async id => {
      await page.evaluate(i => document.getElementById(i).scrollIntoView(), id);
      await page.waitForTimeout(120);
      const box = await page.locator('#' + id).boundingBox();
      return avgColor(await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height * 0.4 } }));
    };

    assert('light page inverts', r.root === 'on', `root=${r.root}`);

    // (1) mostly dark, light stops packed at the end.
    assert('mostly-dark gradient with packed light stops is kept', r.canva === '1', `bg=${r.canva}`);
    const c1 = await topOf('canva');
    assert('its purple stays purple (not a pale wash)', lumOf(c1) < 0.45 && c1.b > c1.g + 40, fmt(c1));

    // (2) mostly light, dark stops packed at the end.
    assert('mostly-light gradient with packed dark stops is NOT kept', r.mostlylight !== '1', `bg=${r.mostlylight}`);
    const c2 = await topOf('mostlylight');
    assert('it goes dark with the page', lumOf(c2) < 0.2, fmt(c2));

    // (3) gradient clipped to the text.
    assert('light gradient TEXT keeps its colours', r.gtext === '1', `bg=${r.gtext}`);

    // (4) unchanged.
    assert('evenly spaced light gradient is NOT kept', r.light2 !== '1', `bg=${r.light2}`);
    assert('evenly spaced dark gradient is kept', r.dark2 === '1', `bg=${r.dark2}`);
    assert('repeating dark gradient with px stops is kept', r.stripes === '1', `bg=${r.stripes}`);
    assert('3-stop brand gradient is kept', r.brand3 === '1', `bg=${r.brand3}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
