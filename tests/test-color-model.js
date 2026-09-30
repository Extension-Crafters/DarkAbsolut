// Regression test for the colour model the colour-coding rescues rely on.
//
//   1. DA.colors.pageFilter must reproduce the browser's rendering of the page
//      filter `invert(1) hue-rotate(180deg)` exactly — every accent colour is
//      computed through it.
//   2. The SVG accent filter (styles.js) must be an exact identity on neutral
//      pixels (they keep inverting with the theme: an empty star goes faint),
//      leave dark/mid colours to the page filter, and keep BRIGHT colours lit in
//      their own hue (a gold star stays gold instead of turning brown).
//   3. The JS helpers (hueKeeping / accentFillSource / accentTextSource) keep
//      hue, stay in gamut, and reach the contrast they promise.
//
// Runs the real content-script sources in a plain Chromium page (no extension).
//
//   node tests/test-color-model.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { decodePng } = require('./lib/png');

const SRC = path.resolve(__dirname, '..', 'src', 'content');
const SCRIPTS = ['00-namespace.js', 'colors.js', 'styles.js'].map(f => path.join(SRC, f));

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

// Load the colour module in Node for the pure-math checks.
const ctx = {};
vm.createContext(ctx);
for (const f of SCRIPTS.slice(0, 2)) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
const C = ctx.DA.colors;

const rgb = (r, g, b) => ({ r, g, b, a: 1 });
const arr = c => [c.r, c.g, c.b];
function hueOf({ r, g, b }) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return null;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

// 6-level RGB grid (216 colours) + the colours the bug reports are about.
const GRID = [];
for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
  GRID.push(rgb(r * 51, g * 51, b * 51));
}
const NAMED = {
  gold: rgb(251, 188, 4), empty: rgb(218, 220, 224), amber: rgb(255, 193, 7),
  lime: rgb(139, 195, 74), teal: rgb(0, 123, 139), red: rgb(217, 48, 37),
};
const COLORS = [...GRID, ...Object.values(NAMED)];

// ── 3. Pure math ────────────────────────────────────────────────────────────
(function mathChecks() {
  let worstHue = 0, worstLuma = 0, clipped = 0;
  for (const c of COLORS) {
    if (C.chroma(c) < 0.2) continue;
    for (const L of [0.3, 0.45, 0.58, 0.7]) {
      const src = C.hueKeeping(c, 1 - L, true);
      const shown = C.pageFilter(src);
      worstLuma = Math.max(worstLuma, Math.abs(C.filterLuma(shown) - L));
      const h0 = hueOf(c), h1 = hueOf(shown);
      if (h1 != null) worstHue = Math.max(worstHue, hueDist(h0, h1));
      // In gamut through the filter: the unclamped shift must already fit.
      const s = 255 * (1 - 2 * C.filterLuma(src));
      if ([src.r + s, src.g + s, src.b + s].some(v => v < -1.5 || v > 256.5)) clipped++;
    }
  }
  assert('hueKeeping: rendered luma hits the target', worstLuma <= 0.02, `worst Δluma=${worstLuma.toFixed(4)}`);
  assert('hueKeeping: hue preserved through the page filter', worstHue <= 6, `worst Δhue=${worstHue.toFixed(1)}°`);
  assert('hueKeeping: never relies on the filter clamping', clipped === 0, `clipped=${clipped}`);

  let fillBad = [];
  for (const c of COLORS) {
    const src = C.accentFillSource(c);
    const L = C.filterLuma(c);
    if (L <= 0.5 || C.chroma(c) < C.ACCENT_CHROMA_FULL) {
      if (src) fillBad.push(`${arr(c)} should be left to the page filter`);
      continue;
    }
    const shown = C.pageFilter(src);
    if (Math.abs(C.filterLuma(shown) - Math.min(L, C.ACCENT_LUMA)) > 0.02) fillBad.push(`${arr(c)} → ${arr(shown)}`);
  }
  assert('accentFillSource: bright accents lit at ACCENT_LUMA, others untouched',
    fillBad.length === 0, fillBad.slice(0, 3).join('; '));

  let textBad = [];
  for (const c of COLORS) {
    if (C.chroma(c) < 0.25) continue;
    for (const bgLum of [0, 0.02, 0.05]) {
      const src = C.accentTextSource(c, bgLum, 4.5, true);
      if (!src) { textBad.push(`${arr(c)} unattainable`); continue; }
      const shown = C.pageFilter(src);
      const cr = C.contrastRatio(C.luminance(shown), bgLum);
      const dh = hueDist(hueOf(c), hueOf(shown) ?? hueOf(c));
      if (cr < 4.45 || dh > 6) textBad.push(`${arr(c)} → ${arr(shown)} cr=${cr.toFixed(2)} Δh=${dh.toFixed(1)}`);
    }
  }
  assert('accentTextSource: reaches 4.5:1 on dark backdrops, hue kept',
    textBad.length === 0, textBad.slice(0, 3).join('; '));

  const gold = C.pageFilter(C.accentTextSource(NAMED.gold, 0, 4.5, true));
  const goldFill = C.pageFilter(C.accentFillSource(NAMED.gold));
  assert('gold ★ text and gold fill render the same lit gold',
    Math.max(...arr(gold).map((v, i) => Math.abs(v - arr(goldFill)[i]))) <= 6,
    `${arr(gold)} vs ${arr(goldFill)}`);
})();

// ── 1–2. In the browser ─────────────────────────────────────────────────────
const SW = 14; // swatch size, px
const PER_ROW = 60;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: PER_ROW * SW + 20, height: 900 });
    await page.setContent(`<!doctype html><html style="filter:invert(1) hue-rotate(180deg);background:#fff">
      <body style="margin:0;background:#fff"><div id="plain"></div><div id="accent"></div><div id="misc"></div></body></html>`);
    for (const f of SCRIPTS) await page.addScriptTag({ path: f });
    const layout = await page.evaluate(({ colors, SW, PER_ROW }) => {
      DA.styles.ensureFilterDefs();
      const place = (id, c, i, extra) => {
        const d = document.createElement('div');
        d.style.cssText = `position:absolute;width:${SW}px;height:${SW}px;` +
          `left:${(i % PER_ROW) * SW}px;top:${Math.floor(i / PER_ROW) * SW}px;` +
          `background:rgba(${c.r},${c.g},${c.b},${c.a == null ? 1 : c.a});${extra || ''}`;
        document.getElementById(id).appendChild(d);
      };
      const rows = Math.ceil(colors.length / PER_ROW);
      for (const id of ['plain', 'accent', 'misc']) document.getElementById(id).style.cssText =
        `position:relative;height:${rows * SW}px;margin-bottom:10px`;
      colors.forEach((c, i) => {
        place('plain', c, i);
        place('accent', c, i, `filter:url(#${DA.ACCENT_FILTER_ID})`);
      });
      // misc: semi-transparent gold through the accent filter; the JS fill
      // source for gold rendered by the page filter alone.
      const gold = { r: 251, g: 188, b: 4 };
      place('misc', { ...gold, a: 0.5 }, 0, `filter:url(#${DA.ACCENT_FILTER_ID})`);
      place('misc', DA.colors.accentFillSource(gold), 1);
      place('misc', gold, 2, `filter:url(#${DA.ACCENT_FILTER_ID})`);
      const top = id => document.getElementById(id).getBoundingClientRect().top;
      return { plain: top('plain'), accent: top('accent'), misc: top('misc') };
    }, { colors: COLORS, SW, PER_ROW });
    await page.waitForTimeout(200);
    const png = decodePng(await page.screenshot({ fullPage: true }));
    const px = (x, y) => {
      const o = (Math.round(y) * png.width + Math.round(x)) * png.channels;
      return [png.data[o], png.data[o + 1], png.data[o + 2]];
    };
    const cell = (block, i) => px((i % PER_ROW) * SW + SW / 2, layout[block] + Math.floor(i / PER_ROW) * SW + SW / 2);
    const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

    // 1. Model vs browser.
    let worst = 0, worstAt = '';
    COLORS.forEach((c, i) => {
      const d = maxDiff(cell('plain', i), arr(C.pageFilter(c)));
      if (d > worst) { worst = d; worstAt = `${arr(c)} → browser ${cell('plain', i)} model ${arr(C.pageFilter(c))}`; }
    });
    assert('pageFilter model matches the browser rendering', worst <= 2, `worst Δ=${worst} ${worstAt}`);

    // 2. Accent filter.
    let neutralWorst = 0, midWorst = 0, brightBad = [];
    COLORS.forEach((c, i) => {
      const plain = cell('plain', i), acc = cell('accent', i);
      const ch = C.chroma(c), L = C.filterLuma(c);
      if (ch < C.ACCENT_CHROMA_MIN) neutralWorst = Math.max(neutralWorst, maxDiff(plain, acc));
      else if (L <= 0.45) midWorst = Math.max(midWorst, maxDiff(plain, acc));
      else if (ch >= C.ACCENT_CHROMA_FULL && L >= 0.6) {
        const accC = { r: acc[0], g: acc[1], b: acc[2] };
        const dh = hueDist(hueOf(c), hueOf(accC) ?? 999);
        if (C.filterLuma(accC) < 0.45 || C.filterLuma(accC) < C.filterLuma({ r: plain[0], g: plain[1], b: plain[2] }) + 0.1 || dh > 15) {
          brightBad.push(`${arr(c)} → ${acc} (plain ${plain}, Δh=${dh.toFixed(0)})`);
        }
      }
    });
    assert('accent filter: exact identity on neutral pixels', neutralWorst <= 1, `worst Δ=${neutralWorst}`);
    assert('accent filter: dark/mid colours left to the page filter', midWorst <= 2, `worst Δ=${midWorst}`);
    assert('accent filter: bright colours stay lit in their own hue',
      brightBad.length === 0, brightBad.slice(0, 3).join('; '));

    const goldI = COLORS.indexOf(NAMED.gold), emptyI = COLORS.indexOf(NAMED.empty);
    const g = cell('accent', goldI), e = cell('accent', emptyI);
    assert('accent filter: gold star → lit gold, empty star → faint gray',
      C.luminance({ r: g[0], g: g[1], b: g[2] }) > 0.25 && C.luminance({ r: e[0], g: e[1], b: e[2] }) < 0.03,
      `gold ${g} empty ${e}`);

    const semi = px(SW / 2, layout.misc + SW / 2), jsFill = px(SW * 1.5, layout.misc + SW / 2);
    const full = px(SW * 2.5, layout.misc + SW / 2);
    assert('accent filter: alpha preserved (50% gold = half the lit gold)',
      maxDiff(semi, full.map(v => v / 2)) <= 3, `semi ${semi} vs full/2 ${full.map(v => Math.round(v / 2))}`);
    assert('JS fill source and SVG accent filter agree on gold',
      maxDiff(jsFill, full) <= 8, `js ${jsFill} vs svg ${full}`);
  } finally {
    await browser.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
