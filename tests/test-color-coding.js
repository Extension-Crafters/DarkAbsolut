// Regression test: colour-coded information must survive the inversion.
//
// The bug (Google Maps place panel): every rating star looked the same — gold
// "filled" and gray "empty" alike — so every place read as 5 stars. Maps paints
// its stars as 14px sprite spans (background-size 14px, repeat) served cross-
// origin WITHOUT CORS. The repeat made them counter-inverted "tiles", and the
// invert → hue-rotate round trip clamps a vivid gold to pale peach while the
// light-gray empty star stays light: both bright on the dark panel. The same
// collapse hit ★ text (the contrast rescue forced every star to neutral white),
// SVG and mask-image stars (the light-icon rescue kept both light), and small
// saturated fills (a primary button or a rating bar crushed to near-black like
// the surface around it).
//
// Expected now, whatever the star technique: filled = lit gold, empty = faint
// dark gray, half = both; accents keep their hue; faint-by-design text stays
// faint. Checked on the rendered pixels.
//
//   node tests/test-color-coding.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { decodePng } = require('./lib/png');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-colorcode-'));

const GOLD = '#fbbc04', EMPTY = '#dadce0';
// Square "star" sprites filling the whole tile, so the centre pixel is paint.
const sprite = (left, right = left) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28">` +
  `<rect width="14" height="28" fill="${left}"/><rect x="14" width="14" height="28" fill="${right}"/></svg>`;
const thumb = c =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">` +
  `<rect width="40" height="40" fill="#ffffff"/><circle cx="20" cy="20" r="8" fill="${c}"/></svg>`;
const SPRITES = {
  '/star.svg': sprite(GOLD),
  '/star_half.svg': sprite(GOLD, EMPTY),
  '/star_empty.svg': sprite(EMPTY),
  // Colour-facet sprite sheet (Amazon): a white cell and a black cell.
  '/swatches.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24">` +
    `<rect width="24" height="24" fill="#ffffff"/><rect x="24" width="24" height="24" fill="#000000"/></svg>`,
  '/thumb1.svg': thumb('#d93025'), '/thumb2.svg': thumb('#188038'), '/thumb3.svg': thumb('#1a73e8'),
};
const STAR_PATH = 'M12 1l3.4 7 7.6 1.1-5.5 5.4 1.3 7.6L12 18.5 5.2 22.1l1.3-7.6L1 9.1 8.6 8z';
const MASK = "url(\"data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='${STAR_PATH}'/></svg>`) + "\")";

const page = spriteBase => `<!doctype html><html><head><meta charset=utf-8><title>colour coding</title>
<style>
  html,body{margin:0;background:#fff;color:#202124;font:16px sans-serif}
  .row{display:flex;gap:4px;margin:10px 16px;align-items:center}
  .sp{display:inline-block;width:14px;height:14px;background-size:14px 14px;background-repeat:repeat}
  .sp24{width:24px;height:24px;background-size:24px 24px}
  .mk{width:24px;height:24px;-webkit-mask:${MASK} center/contain no-repeat;mask:${MASK} center/contain no-repeat}
  .txt{font-size:32px;line-height:36px}
  .btn{display:inline-block;padding:8px 16px;border-radius:18px;font-weight:600}
  .track{width:200px;height:8px;background:#e8eaed;border-radius:4px;margin:10px 16px}
  .bar{width:150px;height:8px;background:${GOLD};border-radius:4px}
</style></head><body>
  <!-- 1. Google Maps: 14px cross-origin sprites (no CORS), repeat, 14px tile -->
  <span class="row" id="maps" role="img" aria-label="3,5 étoiles">
    <span class="sp" id="m1" style="background-image:url(${spriteBase}/star.svg)"></span>
    <span class="sp" id="m2" style="background-image:url(${spriteBase}/star.svg)"></span>
    <span class="sp" id="m3" style="background-image:url(${spriteBase}/star.svg)"></span>
    <span class="sp" id="mh" style="background-image:url(${spriteBase}/star_half.svg)"></span>
    <span class="sp" id="m0" style="background-image:url(${spriteBase}/star_empty.svg)"></span>
  </span>
  <!-- 2. Same-origin sprites (readable → the light-icon sampler runs too) -->
  <span class="row" id="same">
    <span class="sp sp24" id="s1" style="background-image:url(/star.svg);background-repeat:no-repeat"></span>
    <span class="sp sp24" id="s2" style="background-image:url(/star.svg);background-repeat:no-repeat"></span>
    <span class="sp sp24" id="s3" style="background-image:url(/star.svg);background-repeat:no-repeat"></span>
    <span class="sp sp24" id="s0" style="background-image:url(/star_empty.svg);background-repeat:no-repeat"></span>
    <span class="sp sp24" id="s00" style="background-image:url(/star_empty.svg);background-repeat:no-repeat"></span>
  </span>
  <!-- 2b. NOT colour-coded glyphs — they must keep their TRUE colours:
       a colour-facet sprite sheet (white / black swatches, Amazon) and a strip
       of distinct small thumbnails -->
  <span class="row" id="swatches">
    ${['0 0', '-24px 0', '0 0'].map((pos, i) =>
      `<span id="sw${i}" style="display:inline-block;width:24px;height:24px;background:url(${spriteBase}/swatches.svg) ${pos}"></span>`).join('')}
  </span>
  <span class="row" id="thumbs">
    ${[1, 2, 3].map(i =>
      `<span id="th${i}" style="display:inline-block;width:40px;height:40px;background:url(${spriteBase}/thumb${i}.svg) center/contain no-repeat"></span>`).join('')}
  </span>
  <!-- 3. Inline SVG stars: same shape, gold vs light-gray fill -->
  <span class="row" id="svgrow">
    ${[GOLD, GOLD, GOLD, EMPTY, EMPTY].map((c, i) =>
      `<svg id="v${i}" width="24" height="24" viewBox="0 0 24 24"><path fill="${c}" d="${STAR_PATH}"/></svg>`).join('')}
  </span>
  <!-- 3b. Same, painted through the root fill / currentColor (what the
       light-icon rescue reads): the gray ones are the "off" state of the row -->
  <span class="row" id="svgroot">
    ${[GOLD, GOLD, GOLD, EMPTY, EMPTY].map((c, i) =>
      `<svg id="r${i}" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" style="color:${c}"><path d="${STAR_PATH}"/></svg>`).join('')}
  </span>
  <!-- 3c. NOT a rating: a toolbar of light prefers-dark icons (different shapes)
       with one coloured icon — the light ones must keep the light-icon rescue -->
  <span class="row" id="toolbar">
    <svg id="tb0" width="24" height="24" viewBox="0 0 24 24" fill="#e3e3e3"><path d="M3 3h18v18H3z"/></svg>
    <svg id="tb1" width="24" height="24" viewBox="0 0 24 24" fill="#e3e3e3"><path d="M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z"/></svg>
    <svg id="tb2" width="24" height="24" viewBox="0 0 24 24" fill="#e3e3e3"><path d="M2 12l10-10 10 10-10 10z"/></svg>
    <svg id="tb3" width="24" height="24" viewBox="0 0 24 24" fill="${GOLD}"><path d="${STAR_PATH}"/></svg>
  </span>
  <!-- 4. Star characters -->
  <div class="row txt"><span id="t-on" style="color:${GOLD}">★★★</span><span id="t-off" style="color:${EMPTY}">★★</span></div>
  <!-- 5. mask-image stars painted in background-color -->
  <span class="row" id="maskrow">
    ${[GOLD, GOLD, GOLD, EMPTY, EMPTY].map((c, i) =>
      `<span class="mk" id="k${i}" style="background-color:${c}"></span>`).join('')}
  </span>
  <!-- 6. Primary (filled) vs secondary (tinted) actions, and a large surface -->
  <div class="row">
    <span class="btn" id="primary" style="background:#007b8b;color:#fff">Se connecter</span>
    <span class="btn" id="secondary" style="background:#d3f7ff;color:#014f5a">Suggérer</span>
  </div>
  <div id="banner" style="background:#007b8b;color:#fff;width:800px;height:120px;margin:10px 16px">Large brand surface</div>
  <!-- 7. Rating-distribution bar: gold fill over a light-gray track -->
  <div class="track"><div class="bar" id="bar"></div></div>
  <!-- 8. Status colours, body text and a faint-by-design hint -->
  <div class="row txt"><span id="closed" style="color:#d93025">Fermé</span><span id="open" style="color:#188038">Ouvert</span></div>
  <p class="row" id="body">Body text</p>
  <p class="row" id="hint" style="color:#bbbbbb">Faint hint text</p>
</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

const lin = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const chroma = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
function hue([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const fmt = p => `rgb(${p.join(',')})`;
// "Lit gold": bright enough to read as a lit accent (not the brown the plain
// invert gives), vivid (not the pale peach of the counter-invert round trip),
// and still gold/amber.
const isLitGold = p => lum(p) >= 0.2 && chroma(p) >= 0.4 && Math.min(...p) <= 70 &&
  hue(p) >= 35 && hue(p) <= 60;
// "Faint": an unlit star on the dark page — dim and neutral.
const isFaint = p => lum(p) <= 0.05 && chroma(p) <= 0.1;

(async () => {
  // Cross-origin sprite host WITHOUT CORS headers (like maps.gstatic.com).
  const serveSprites = (req, res) => {
    const body = SPRITES[req.url.split('?')[0]];
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    res.end(body);
  };
  const listen = handler => new Promise(resolve => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const spriteServer = await listen(serveSprites);
  // "localhost" vs "127.0.0.1" → a different origin from the page.
  const spriteBase = `http://localhost:${spriteServer.address().port}`;
  const server = await listen((req, res) => {
    if (SPRITES[req.url.split('?')[0]]) return serveSprites(req, res);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(spriteBase));
  });
  const base = `http://127.0.0.1:${server.address().port}/`;

  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true, channel: 'chromium', colorScheme: 'light',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }
    const pg = await context.newPage();
    await pg.setViewportSize({ width: 900, height: 900 });
    await pg.goto(base, { waitUntil: 'load' });
    // Sprite sampling is async; let the 700/1800ms re-scans settle too.
    await pg.waitForTimeout(2200);

    assert('page is inverted', (await pg.evaluate(() =>
      document.documentElement.getAttribute('data-darkabsolut'))) === 'on');

    const shot = decodePng(await pg.screenshot());
    const px = (x, y) => {
      const o = (Math.round(y) * shot.width + Math.round(x)) * shot.channels;
      return [shot.data[o], shot.data[o + 1], shot.data[o + 2]];
    };
    const rect = id => pg.evaluate(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }, id);
    const at = async (id, fx = 0.5, fy = 0.5) => {
      const r = await rect(id);
      return px(r.x + r.w * fx, r.y + r.h * fy);
    };
    // Most colourful bright pixel / brightest pixel inside an element (text).
    const scan = async id => {
      const r = await rect(id);
      let best = [0, 0, 0], brightest = [0, 0, 0], darkest = [255, 255, 255];
      for (let y = Math.ceil(r.y); y < r.y + r.h - 1; y++) {
        for (let x = Math.ceil(r.x); x < r.x + r.w - 1; x++) {
          const p = px(x, y);
          if (lum(p) >= 0.1 && chroma(p) > chroma(best)) best = p;
          if (lum(p) > lum(brightest)) brightest = p;
          if (lum(p) < lum(darkest)) darkest = p;
        }
      }
      return { best, brightest, darkest };
    };
    const attr = (id, a) => pg.evaluate(([id, a]) =>
      document.getElementById(id).getAttribute(a), [id, a]);

    // ── 1. Google Maps sprites (cross-origin, unreadable) ─────────────────
    const m1 = await at('m1'), m0 = await at('m0');
    assert('Maps sprite: filled star renders lit gold', isLitGold(m1), fmt(m1));
    assert('Maps sprite: empty star renders faint', isFaint(m0), fmt(m0));
    assert('Maps sprite: filled clearly brighter than empty',
      (lum(m1) + 0.05) / (lum(m0) + 0.05) >= 3, `${fmt(m1)} vs ${fmt(m0)}`);
    const mhL = await at('mh', 0.25), mhR = await at('mh', 0.75);
    assert('Maps sprite: half star = gold half + faint half',
      isLitGold(mhL) && isFaint(mhR), `${fmt(mhL)} | ${fmt(mhR)}`);
    assert('Maps sprite: rendered through the accent filter (not counter-inverted)',
      (await attr('m1', 'data-darkabsolut-accent')) === '1' &&
      (await attr('m1', 'data-darkabsolut-bg')) === null);

    // ── 2. Same-origin sprites: the light-icon sampler must not keep the
    //       empty star light (it is the "off" member of a colour-coded row) ──
    const s1 = await at('s1'), s0 = await at('s0');
    assert('same-origin sprite: filled star renders lit gold', isLitGold(s1), fmt(s1));
    assert('same-origin sprite: empty star renders faint (not light-icon rescued)',
      isFaint(s0) && (await attr('s0', 'data-darkabsolut-lighticon')) !== '1', fmt(s0));

    // ── 2b. Swatches and thumbnails keep their true colours ───────────────
    const swWhite = await at('sw0'), swBlack = await at('sw1');
    assert('colour swatch sheet: the WHITE swatch stays white', lum(swWhite) >= 0.8, fmt(swWhite));
    assert('colour swatch sheet: the BLACK swatch stays black', lum(swBlack) <= 0.02, fmt(swBlack));
    const thBg = await at('th1', 0.1, 0.1);
    assert('thumbnail strip keeps its true colours (white stays white)',
      lum(thBg) >= 0.8 && (await attr('th1', 'data-darkabsolut-accent')) === null, fmt(thBg));

    // ── 3. Inline SVG stars ───────────────────────────────────────────────
    const v0 = await at('v0'), v4 = await at('v4');
    assert('SVG: gold star renders lit gold', isLitGold(v0), fmt(v0));
    assert('SVG: light-gray star renders faint (not light-icon rescued)',
      isFaint(v4) && (await attr('v4', 'data-darkabsolut-lighticon')) !== '1', fmt(v4));

    const r0 = await at('r0'), r4 = await at('r4');
    assert('SVG (root fill): gold star renders lit gold', isLitGold(r0), fmt(r0));
    assert('SVG (root fill): gray star is the row\'s "off" state → faint',
      isFaint(r4) && (await attr('r4', 'data-darkabsolut-lighticon')) !== '1', fmt(r4));
    const tb0 = await attr('tb0', 'data-darkabsolut-lighticon');
    const tb2 = await attr('tb2', 'data-darkabsolut-lighticon');
    assert('toolbar of different light icons keeps the light-icon rescue',
      tb0 === '1' && tb2 === '1', `tb0=${tb0} tb2=${tb2}`);

    // ── 4. ★ characters ───────────────────────────────────────────────────
    const tOn = await scan('t-on'), tOff = await scan('t-off');
    assert('text ★: filled stars render lit gold', isLitGold(tOn.best), fmt(tOn.best));
    assert('text ★: empty stars stay faint (not rescued to white)',
      lum(tOff.brightest) <= 0.05, `brightest=${fmt(tOff.brightest)}`);

    // ── 5. mask-image stars ───────────────────────────────────────────────
    const k0 = await at('k0'), k4 = await at('k4');
    assert('mask: gold star renders lit gold', isLitGold(k0), fmt(k0));
    assert('mask: light-gray star renders faint', isFaint(k4), fmt(k4));

    // ── 6. Primary vs secondary action, large surface ─────────────────────
    const prim = await at('primary', 0.06), sec = await at('secondary', 0.06);
    assert('primary button keeps a lit teal fill (not crushed to black)',
      lum(prim) >= 0.2 && prim[2] > prim[0] + 60 && prim[1] > prim[0] + 60, fmt(prim));
    assert('primary stands out from the secondary action',
      (lum(prim) + 0.05) / (lum(sec) + 0.05) >= 3, `${fmt(prim)} vs ${fmt(sec)}`);
    // The label is whichever extreme differs most from the fill.
    const ps = await scan('primary');
    const cr = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const primLabel = cr(ps.darkest, prim) > cr(ps.brightest, prim) ? ps.darkest : ps.brightest;
    assert('primary label stays readable on its fill',
      cr(primLabel, prim) >= 4.5, `${fmt(primLabel)} on ${fmt(prim)}`);
    const ban = await at('banner', 0.95, 0.9);
    assert('a large saturated surface still goes dark', lum(ban) <= 0.05, fmt(ban));

    // ── 7. Rating-distribution bar ───────────────────────────────────────
    const bar = await at('bar', 0.5), track = await at('bar', 1.15);
    assert('rating bar: gold fill renders lit gold', isLitGold(bar), fmt(bar));
    assert('rating bar: fill clearly stands out from its track',
      (lum(bar) + 0.05) / (lum(track) + 0.05) >= 3, `${fmt(bar)} vs ${fmt(track)}`);

    // ── 8. Status colours keep their hue; faint text stays faint ─────────
    const closed = (await scan('closed')).best, open = (await scan('open')).best;
    assert('"Fermé" stays red', closed[0] > closed[1] + 60 && closed[0] > closed[2] + 60, fmt(closed));
    assert('"Ouvert" stays green', open[1] > open[0] + 40 && open[1] > open[2] + 20, fmt(open));
    const body = (await scan('body')).brightest, hint = (await scan('hint')).brightest;
    assert('faint hint is not rescued', (await attr('hint', 'data-darkabsolut-rtext')) === null);
    assert('hint stays dimmer than body text (hierarchy kept)',
      lum(hint) < lum(body) * 0.6, `hint=${fmt(hint)} body=${fmt(body)}`);

    assert('accent filter defs are mounted while active', await pg.evaluate(() =>
      !!document.getElementById('darkabsolut-accent')));
  } finally {
    await context.close();
    server.close();
    spriteServer.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
