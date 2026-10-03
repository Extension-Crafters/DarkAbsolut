// Regression test: a large LIGHT content container that merely carries a
// fitted (non-`cover`) decorative background image must NOT be counter-inverted.
//
// italki's quiz report wraps the whole page in
//   <div class="min-h-screen bg-bg3 bg-top bg-no-repeat bg-[length:100%]"
//        style="background-image:url(bg2.svg)">
// — a light background-color with a hero banner fitted 100% wide at the top.
// `background-size:100%` matched the "image fills the element" rule, so the
// wrapper was tagged [bg] and its counter-invert reverted the ENTIRE page to
// light, while every <img> inside (itself counter-inverted) became a colour-
// negative.
//
//   1. The page wrapper is not tagged: its surface renders dark and an <img>
//      inside keeps its true colours.
//   2. Same wrapper mounted EMPTY (a loading state — an image panel, tagged)
//      and filled after the timed re-scans: the content arriving inside it
//      must drop the tag, with no class/style mutation on the wrapper itself.
//   3. What already worked is unchanged — these stay counter-inverted:
//        • a `cover` photo hero (even with a light fallback colour);
//        • a fitted image with LIGHT text on it (a dark backdrop for text);
//        • a picture-sized element (logo button) with a light bg + text;
//        • a large text-free image panel.
//
//   node tests/test-light-surface-bg.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { decodePng } = require('./lib/png');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-lightsurf-'));

// 2x2 red/black PNG (opaque). Even inversion parity keeps it a DARK red; an odd
// parity (colour-negative) washes it out to a light pink.
const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8z8Dwn4EIwAgAJAUH/Vn5d8AAAAAASUVORK5CYII=';
// A wide yellow banner (1440×413, like italki's bg2.svg): fitted 100% wide it
// covers only the top of the wrapper; the light bg-color shows below it.
const BANNER = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1440' height='413'%3E%3Cellipse cx='737' cy='-13' rx='1416' ry='382' fill='%23FFC400'/%3E%3C/svg%3E")`;

const LATE_MS = 5000;

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>light-surface-bg</title>
<style>
  html,body{margin:0;background:#fff;color:#333;font-family:sans-serif}
  /* (1) the italki page wrapper */
  #wrap{min-height:100vh;background-color:#f5f6f9;background-image:${BANNER};
        background-repeat:no-repeat;background-position:top;background-size:100%;
        padding:80px 0;box-sizing:border-box}
  .card{background:#fff;width:800px;margin:0 auto 16px;padding:24px;border-radius:12px}
  .card img{width:56px;height:56px;display:block}
  .title{width:800px;margin:24px auto 8px;font-weight:bold}
  .spacer{height:500px}
  /* (2) same wrapper, content mounted late */
  #late{min-height:700px;margin-top:20px;background-color:#f5f6f9;background-image:${BANNER};
        background-repeat:no-repeat;background-position:top;background-size:100%}
  /* (3) unchanged cases */
  .hero{width:1000px;height:300px;margin-top:20px;padding:20px;box-sizing:border-box}
  #coverhero{background:#eeeeee url(${RED}) no-repeat center / cover;color:#222}
  #lighttext{background:#eeeeee url(${RED}) no-repeat center / 100%}
  #lighttext h2{color:#fff}
  #logobtn{display:inline-block;width:220px;height:44px;line-height:44px;padding-left:50px;
           background:#fff url(${RED}) no-repeat left center / contain;color:#222}
  #panel{width:900px;height:400px;margin-top:20px;background:#fff url(${RED}) no-repeat center / contain}
</style></head>
<body>
  <div id="wrap">
    <div class="card"><img id="avatar" src="${RED}" alt=""><p>Language Talent</p></div>
    <div class="title">Teachers for you</div>
    <div class="card"><p>Professional Teacher</p></div>
    <div class="spacer" id="surface"></div>
  </div>
  <div class="hero" id="coverhero"><h2>Cover photo hero</h2><div class="card" style="width:200px">card</div></div>
  <div class="hero" id="lighttext"><h2>Light text on the image</h2></div>
  <div id="logobtn">Sign in</div>
  <div id="panel"></div>
  <div id="late"></div>
  <script>
    // Past the controller's timed full re-scans (700 / 1800 / 4000 ms).
    setTimeout(() => {
      document.getElementById('late').innerHTML =
        '<div class="card"><p>Late card</p></div><div class="title">Late title</div>' +
        '<div class="spacer" id="latesurface"></div>';
    }, ${LATE_MS});
  </script>
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
const fmt = c => `rgb(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`;

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
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    const r = await page.evaluate(() => {
      // Number of invert filters on the element's ancestor-or-self chain.
      const invCount = el => {
        let n = 0;
        for (let cur = el; cur; cur = cur.parentElement) {
          if (/invert/.test(getComputedStyle(cur).filter)) n++;
        }
        return n;
      };
      const tag = id => document.getElementById(id).getAttribute('data-darkabsolut-bg');
      return {
        root: document.documentElement.getAttribute('data-darkabsolut'),
        wrap: tag('wrap'),
        wrapFilter: getComputedStyle(document.getElementById('wrap')).filter,
        avatarInverts: invCount(document.getElementById('avatar')),
        coverhero: tag('coverhero'),
        lighttext: tag('lighttext'),
        logobtn: tag('logobtn'),
        panel: tag('panel'),
        lateEmpty: tag('late'),
      };
    });

    assert('light page inverts', r.root === 'on', `root=${r.root}`);

    // (1) the page wrapper is a light content surface, not an image panel.
    assert('page wrapper with a fitted banner is NOT tagged [bg]', r.wrap !== '1', `bg=${r.wrap}`);
    assert('page wrapper carries no counter-invert', !/invert/.test(r.wrapFilter), `filter=${r.wrapFilter}`);
    assert('<img> inside the wrapper is not triple-inverted', r.avatarInverts % 2 === 0,
      `inverts=${r.avatarInverts}`);

    await page.evaluate(() => document.getElementById('surface').scrollIntoView());
    await page.waitForTimeout(150);
    const surf = avgColor(await page.locator('#surface').screenshot());
    assert('wrapper surface renders DARK', lumOf(surf) < 0.2, `lum=${lumOf(surf).toFixed(2)} ${fmt(surf)}`);

    await page.evaluate(() => document.getElementById('avatar').scrollIntoView());
    await page.waitForTimeout(150);
    const av = avgColor(await page.locator('#avatar').screenshot());
    assert('<img> inside the wrapper renders dark red (not a colour-negative)',
      av.r > av.g + 30 && av.r > av.b + 30 && lumOf(av) < 0.4, `lum=${lumOf(av).toFixed(2)} ${fmt(av)}`);

    // (3) unchanged behaviour.
    assert('cover photo hero stays counter-inverted', r.coverhero === '1', `bg=${r.coverhero}`);
    assert('fitted image under LIGHT text stays counter-inverted', r.lighttext === '1', `bg=${r.lighttext}`);
    assert('picture-sized logo button stays counter-inverted', r.logobtn === '1', `bg=${r.logobtn}`);
    assert('large text-free image panel stays counter-inverted', r.panel === '1', `bg=${r.panel}`);

    // (2) content mounted late inside the (until then empty, tagged) wrapper.
    assert('fixture: empty wrapper is an image panel (tagged)', r.lateEmpty === '1', `bg=${r.lateEmpty}`);
    await page.waitForSelector('#latesurface', { state: 'attached', timeout: LATE_MS + 5000 });
    await page.waitForTimeout(1200); // debounced mutation flush
    const lateTag = await page.evaluate(() => document.getElementById('late').getAttribute('data-darkabsolut-bg'));
    assert('wrapper filled late is no longer tagged [bg]', lateTag !== '1', `bg=${lateTag}`);
    await page.evaluate(() => document.getElementById('latesurface').scrollIntoView());
    await page.waitForTimeout(150);
    const late = avgColor(await page.locator('#latesurface').screenshot());
    assert('late-filled wrapper surface renders DARK', lumOf(late) < 0.2,
      `lum=${lumOf(late).toFixed(2)} ${fmt(late)}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
