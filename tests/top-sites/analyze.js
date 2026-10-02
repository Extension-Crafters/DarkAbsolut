// Top-sites field audit — analysis stage.
//
// Reads each <runs>/<id>/capture.json + screenshots and computes pixel-level
// evidence comparing the themed page (ON) with the pixel-aligned native
// baseline (OFF, same page load after the master switch was turned off):
//   • media whose luminance correlates NEGATIVELY ON vs OFF  → shown as a negative
//   • text whose rendered contrast collapsed ON vs OFF       → unreadable text
//   • large bright regions left on the themed page           → unthemed blocks
//   • page-level verdicts (dark page inverted, light page left light)
//   • residue after disable, re-enable mismatch, fixed elements captured by
//     a counter-filtered ancestor, extension-induced long tasks
// Writes <id>/analysis.json and <id>/sheet.jpg (OFF|ON crop pairs of the
// flagged items, one row each, in analysis.sheet order).
//
//   node tests/top-sites/analyze.js --runs <dir> [--only id1,id2]
'use strict';
const fs = require('fs');
const path = require('path');
const { jpegjs } = require('playwright-core/lib/utilsBundle');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const RUNS = path.resolve(arg('--runs', 'runs'));
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean);

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

function load(file) {
  if (!file || !fs.existsSync(file)) return null;
  const img = jpegjs.decode(fs.readFileSync(file), { useTArray: true, formatAsRGBA: true });
  const { width: W, height: H, data } = img;
  const lum = new Float32Array(W * H);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) lum[i] = 0.2126 * LIN[data[p]] + 0.7152 * LIN[data[p + 1]] + 0.0722 * LIN[data[p + 2]];
  return { W, H, data, lum };
}

function stats(img) {
  let s = 0, bright = 0, dark = 0, n = 0;
  for (let i = 0; i < img.lum.length; i += 3) { const l = img.lum[i]; s += l; n++; if (l > 0.6) bright++; if (l < 0.05) dark++; }
  return { mean: +(s / n).toFixed(3), bright: +(bright / n).toFixed(3), dark: +(dark / n).toFixed(3) };
}

function clip(r, W, H) {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
  const x1 = Math.min(W, r.x + r.w), y1 = Math.min(H, r.y + r.h);
  return x1 - x0 >= 4 && y1 - y0 >= 4 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// Pearson correlation of luminance on a sample grid inside rect, plus moments.
function corr(a, b, r) {
  const N = 28, xs = [], ys = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = Math.min(a.W - 1, Math.floor(r.x + (i + 0.5) * r.w / N));
    const y = Math.min(a.H - 1, Math.floor(r.y + (j + 0.5) * r.h / N));
    xs.push(a.lum[y * a.W + x]); ys.push(b.lum[y * b.W + x]);
  }
  const m = v => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = m(xs), mb = m(ys);
  let sab = 0, saa = 0, sbb = 0;
  for (let k = 0; k < xs.length; k++) { const da = xs[k] - ma, db = ys[k] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  const sa = Math.sqrt(saa / xs.length), sb = Math.sqrt(sbb / xs.length);
  return { r: saa && sbb ? +(sab / Math.sqrt(saa * sbb)).toFixed(2) : 0, meanOn: +ma.toFixed(3), meanOff: +mb.toFixed(3), sdOn: +sa.toFixed(3), sdOff: +sb.toFixed(3) };
}

function contrastIn(img, r) {
  const v = [];
  const step = r.w * r.h > 40000 ? 2 : 1;
  for (let y = r.y; y < r.y + r.h; y += step) for (let x = r.x; x < r.x + r.w; x += step) v.push(img.lum[y * img.W + x]);
  if (v.length < 20) return null;
  v.sort((p, q) => p - q);
  const lo = v[Math.floor(v.length * 0.04)], hi = v[Math.floor(v.length * 0.96)];
  return { ratio: +((hi + 0.05) / (lo + 0.05)).toFixed(2), lo: +lo.toFixed(3), hi: +hi.toFixed(3) };
}

function meanIn(img, r) {
  let s = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y += 2) for (let x = r.x; x < r.x + r.w; x += 2) { s += img.lum[y * img.W + x]; n++; }
  return n ? +(s / n).toFixed(3) : null;
}

const MEDIA_KINDS = new Set(['img', 'video', 'canvas', 'picture', 'bgimg', 'embed', 'object']);

// Bright connected regions on the themed screenshot (16px cells), ignoring
// cells mostly covered by raster media (a bright photo is legitimately bright).
function brightRegions(on, off, snap) {
  const C = 16, GW = Math.ceil(on.W / C), GH = Math.ceil(on.H / C);
  const cover = new Float32Array(GW * GH);
  for (const m of (snap && snap.media) || []) {
    if (!MEDIA_KINDS.has(m.kind)) continue;
    const r = clip(m.rect, on.W, on.H); if (!r) continue;
    for (let gy = Math.floor(r.y / C); gy <= Math.floor((r.y + r.h - 1) / C); gy++)
      for (let gx = Math.floor(r.x / C); gx <= Math.floor((r.x + r.w - 1) / C); gx++) {
        const ox = Math.max(0, Math.min(r.x + r.w, (gx + 1) * C) - Math.max(r.x, gx * C));
        const oy = Math.max(0, Math.min(r.y + r.h, (gy + 1) * C) - Math.max(r.y, gy * C));
        cover[gy * GW + gx] = Math.min(1, cover[gy * GW + gx] + (ox * oy) / (C * C));
      }
  }
  const bright = new Uint8Array(GW * GH);
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const r = clip({ x: gx * C, y: gy * C, w: C, h: C }, on.W, on.H); if (!r) continue;
    if (cover[gy * GW + gx] > 0.5) continue;
    if (meanIn(on, r) > 0.62) bright[gy * GW + gx] = 1;
  }
  const seen = new Uint8Array(GW * GH), regions = [];
  for (let s = 0; s < GW * GH; s++) {
    if (!bright[s] || seen[s]) continue;
    const stack = [s]; seen[s] = 1;
    let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    while (stack.length) {
      const c = stack.pop(); n++;
      const cx = c % GW, cy = (c - cx) / GW;
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
        const k = ny * GW + nx;
        if (bright[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    const areaFrac = (n * C * C) / (on.W * on.H);
    if (areaFrac < 0.012) continue;
    const rect = clip({ x: x0 * C, y: y0 * C, w: (x1 - x0 + 1) * C, h: (y1 - y0 + 1) * C }, on.W, on.H);
    const hits = ((snap && snap.grid) || []).filter(g => g.x >= rect.x && g.x < rect.x + rect.w && g.y >= rect.y && g.y < rect.y + rect.h)
      .map(g => g.el + (g.da && g.da.length ? ' [' + g.da.join(',') + ']' : '') + (g.chain && g.chain.length ? ' <- ' + g.chain.slice(0, 2).join(' <- ') : ''));
    regions.push({ rect, areaPct: +(areaFrac * 100).toFixed(1), lumOn: meanIn(on, rect), lumOff: off ? meanIn(off, rect) : null,
      elements: [...new Set(hits)].slice(0, 5) });
  }
  return regions.sort((a, b) => b.areaPct - a.areaPct).slice(0, 6);
}

function mediaChecks(on, off, snap, where) {
  const out = [];
  for (const m of (snap && snap.media) || []) {
    if (!MEDIA_KINDS.has(m.kind) && m.kind !== 'svg' && m.kind !== 'iframe') continue;
    const r = clip(m.rect, on.W, on.H); if (!r) continue;
    if (r.w < 40 || r.h < 40 || r.w * r.h < 3000) continue;
    const c = corr(on, off, r);
    const inverted = c.sdOff > 0.06 && c.sdOn > 0.04 && c.r < -0.35;
    if (inverted) out.push({ type: 'media-negative', where, kind: m.kind, desc: m.desc, da: m.da, filter: m.filter, src: m.src || m.bg || null, rect: r, ...c });
  }
  return out;
}

function textChecks(on, off, snap, where) {
  const out = [];
  for (const t of (snap && snap.texts) || []) {
    const r = clip(t.rect, on.W, on.H); if (!r) continue;
    if (t.fs < 10) continue;
    const a = contrastIn(on, r), b = contrastIn(off, r);
    if (!a || !b) continue;
    const collapsed = b.ratio >= 3 && a.ratio < 1.9 && a.ratio < b.ratio * 0.5;
    if (collapsed) out.push({ type: 'text-contrast', where, desc: t.desc, text: t.text, fs: t.fs, color: t.color, bg: t.bg, da: t.da, filter: t.filter, rect: r, on: a, off: b });
  }
  // Keep the worst, de-duplicated by overlapping rects.
  out.sort((x, y) => x.on.ratio - y.on.ratio);
  const kept = [];
  for (const o of out) if (!kept.some(k => Math.abs(k.rect.x - o.rect.x) < 20 && Math.abs(k.rect.y - o.rect.y) < 20)) kept.push(o);
  return kept.slice(0, 8);
}

function fixedChecks(onSnap, offSnap) {
  const out = [];
  const offByPath = new Map(((offSnap && offSnap.fixed) || []).map(f => [f.path, f]));
  for (const f of (onSnap && onSnap.fixed) || []) {
    const o = offByPath.get(f.path);
    const moved = o && (Math.abs(o.rect.y - f.rect.y) > 30 || Math.abs(o.rect.x - f.rect.x) > 30);
    if ((f.pos === 'fixed' && f.filteredAncestor) || moved) out.push({ type: 'fixed-position', desc: f.desc, pos: f.pos, rectOn: f.rect, rectOff: o ? o.rect : null, filteredAncestor: f.filteredAncestor, da: f.da });
  }
  // Fixed elements visible natively at mid-scroll but missing when themed.
  const onPaths = new Set(((onSnap && onSnap.fixed) || []).map(f => f.path));
  for (const o of (offSnap && offSnap.fixed) || []) if (o.pos === 'fixed' && !onPaths.has(o.path)) out.push({ type: 'fixed-missing', desc: o.desc, rectOff: o.rect });
  return out.slice(0, 6);
}

function meanAbsDiff(a, b) {
  let s = 0, n = 0;
  for (let i = 0; i < a.lum.length; i += 7) { s += Math.abs(a.lum[i] - b.lum[i]); n++; }
  return +(s / n).toFixed(3);
}

// Contact sheet: one row per flagged item, OFF crop | ON crop.
function sheet(rows, file) {
  const W = 1366, PAD = 6, HALF = (W - 3 * PAD) / 2 | 0, MAXH = 210;
  const items = rows.map(r => {
    const scale = Math.min(1, HALF / r.rect.w, MAXH / r.rect.h);
    return { ...r, scale, dw: Math.max(1, Math.round(r.rect.w * scale)), dh: Math.max(1, Math.round(r.rect.h * scale)) };
  });
  const H = items.reduce((s, it) => s + it.dh + PAD, PAD);
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = 255; out[i + 1] = 0; out[i + 2] = 255; out[i + 3] = 255; } // magenta gutters
  let y = PAD;
  for (const it of items) {
    for (const [k, img] of [[0, it.off], [1, it.on]]) {
      const ox = PAD + k * (HALF + PAD);
      for (let dy = 0; dy < it.dh; dy++) for (let dx = 0; dx < it.dw; dx++) {
        const sx = Math.min(img.W - 1, it.rect.x + Math.floor(dx / it.scale));
        const sy = Math.min(img.H - 1, it.rect.y + Math.floor(dy / it.scale));
        const si = (sy * img.W + sx) * 4, di = ((y + dy) * W + ox + dx) * 4;
        out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
      }
    }
    y += it.dh + PAD;
  }
  fs.writeFileSync(file, jpegjs.encode({ data: out, width: W, height: H }, 85).data);
}

function analyzeSite(dir) {
  const cap = JSON.parse(fs.readFileSync(path.join(dir, 'capture.json'), 'utf8'));
  const img = n => cap.shots && cap.shots[n] ? load(path.join(dir, cap.shots[n])) : null;
  const onTop = img('onTop'), offTop = img('offTop'), onMid = img('onMid'), offMid = img('offMid'), reon = img('reonTop'), onInit = img('onInitial');
  const A = { id: cap.id, url: cap.url, finalUrl: cap.finalUrl, status: cap.status, navError: cap.navError || null, fatal: cap.fatal || null,
    blocked: cap.blocked && cap.blocked.hit && cap.blocked.hit.length ? cap.blocked.hit : null, consent: cap.consent || null,
    title: cap.onTop && cap.onTop.page ? cap.onTop.page.title : null, flags: [], sheet: [] };
  const ext = cap.onTop && cap.onTop.ext;
  A.ext = ext ? { root: ext.root, style: ext.style, tags: ext.tags } : null;
  A.page = cap.onTop && cap.onTop.page ? (({ lang, metaColorScheme, htmlColorScheme, htmlBg, bodyBg, htmlDataTheme, nodeCount, iframeCount, shadowHosts, textLen }) =>
    ({ lang, metaColorScheme, htmlColorScheme, htmlBg, bodyBg, htmlDataTheme, nodeCount, iframeCount, shadowHosts, textLen }))(cap.onTop.page) : null;
  if (!onTop || !offTop) { A.unusable = 'missing screenshots'; return A; }
  A.lum = { onTop: stats(onTop), offTop: stats(offTop), onMid: onMid && stats(onMid), offMid: offMid && stats(offMid), reonTop: reon && stats(reon), onInitial: onInit && stats(onInit) };
  A.scrolled = cap.onMid && cap.onMid.page ? cap.onMid.page.scrollY > 0 : false;

  // Page-level verdicts.
  const L = A.lum;
  if (L.offTop.mean < 0.12 && L.onTop.mean > L.offTop.mean + 0.2) A.flags.push({ type: 'dark-page-inverted', detail: `native mean lum ${L.offTop.mean} → themed ${L.onTop.mean}`, root: ext && ext.root });
  if (L.offTop.mean > 0.45 && L.onTop.mean > 0.4) A.flags.push({ type: 'light-page-not-darkened', detail: `native ${L.offTop.mean} → themed ${L.onTop.mean}`, root: ext && ext.root });
  if (L.onTop.mean > 0.25 && L.onTop.mean <= 0.4 && L.offTop.mean > 0.3) A.flags.push({ type: 'page-partly-light', detail: `themed mean lum ${L.onTop.mean}, bright ${L.onTop.bright}` });

  // Residue after disable.
  const res = cap.residue;
  if (res && !res.error && (Object.keys(res.attrs || {}).length || res.style || res.defs || res.shadowSheets)) A.flags.push({ type: 'residue-after-disable', detail: JSON.stringify(res).slice(0, 400) });
  if (L.offTop && L.offTop.mean < 0.25 && ext && ext.root === 'on' && cap.offTop && cap.offTop.ext && cap.offTop.ext.htmlFilter !== 'none') A.flags.push({ type: 'filter-left-after-disable', detail: cap.offTop.ext.htmlFilter });

  // Re-enable consistency.
  if (cap.reOn && ext) {
    const d = reon ? meanAbsDiff(onTop, reon) : null;
    if (cap.reOn.root !== ext.root) A.flags.push({ type: 'reenable-mismatch', detail: `root before=${ext.root} after re-enable=${cap.reOn.root}; meanAbsDiff=${d}` });
    else if (d != null && d > 0.12) A.flags.push({ type: 'reenable-visual-diff', detail: `meanAbsDiff on-top vs reon-top = ${d}` });
  }

  // Jank (extension on vs off, steady state after load).
  if (cap.ltOn && cap.ltOff && cap.ltOn.blocking > 250 && cap.ltOn.blocking > 3 * (cap.ltOff.blocking + 30)) A.flags.push({ type: 'long-tasks', detail: `blocking ${cap.ltOn.blocking}ms with extension vs ${cap.ltOff.blocking}ms without (4s window)` });

  // Element-level evidence.
  const items = [];
  items.push(...mediaChecks(onTop, offTop, cap.onTop, 'top').map(x => ({ ...x, on: onTop, off: offTop })));
  if (onMid && offMid && A.scrolled) items.push(...mediaChecks(onMid, offMid, cap.onMid, 'mid').map(x => ({ ...x, on: onMid, off: offMid })));
  items.push(...textChecks(onTop, offTop, cap.onTop, 'top').map(x => ({ ...x, onC: x.on, offC: x.off, on: onTop, off: offTop })));
  if (onMid && offMid && A.scrolled) items.push(...textChecks(onMid, offMid, cap.onMid, 'mid').map(x => ({ ...x, onC: x.on, offC: x.off, on: onMid, off: offMid })));
  for (const reg of brightRegions(onTop, offTop, cap.onTop)) items.push({ type: 'bright-region', where: 'top', ...reg, on: onTop, off: offTop });
  if (onMid && A.scrolled) for (const reg of brightRegions(onMid, offMid, cap.onMid)) items.push({ type: 'bright-region', where: 'mid', ...reg, on: onMid, off: offMid });
  if (onInit && cap.consent && cap.consent.clicked) for (const reg of brightRegions(onInit, null, null)) if (reg.areaPct >= 3) items.push({ type: 'bright-region', where: 'initial(consent banner up)', ...reg, on: onInit, off: onInit, note: 'no native baseline for this view' });
  for (const f of fixedChecks(cap.onMid, cap.offMid)) A.flags.push(f);

  // Order: negatives, text, bright; cap the sheet.
  const prio = { 'media-negative': 0, 'text-contrast': 1, 'bright-region': 2 };
  items.sort((a, b) => prio[a.type] - prio[b.type]);
  const rows = items.filter(it => it.rect).slice(0, 12);
  rows.forEach((it, i) => {
    const { on, off, ...rest } = it;
    const rec = { row: i + 1, ...rest };
    if (rec.onC) { rec.contrastOn = rec.onC; rec.contrastOff = rec.offC; delete rec.onC; delete rec.offC; }
    A.sheet.push(rec);
  });
  const sheetRows = rows.map(it => ({ rect: it.rect, on: it.on, off: it.off }));
  if (sheetRows.length) { sheet(sheetRows, path.join(dir, 'sheet.jpg')); A.sheetFile = 'sheet.jpg'; }
  A.counts = { mediaNegative: items.filter(i => i.type === 'media-negative').length, textContrast: items.filter(i => i.type === 'text-contrast').length, brightRegions: items.filter(i => i.type === 'bright-region').length };
  return A;
}

const dirs = fs.readdirSync(RUNS).filter(d => fs.existsSync(path.join(RUNS, d, 'capture.json'))).filter(d => !ONLY.length || ONLY.includes(d));
let n = 0;
for (const d of dirs) {
  try {
    const A = analyzeSite(path.join(RUNS, d));
    fs.writeFileSync(path.join(RUNS, d, 'analysis.json'), JSON.stringify(A, null, 1));
    n++;
    console.log(`${d}: root=${A.ext && A.ext.root} lum on/off=${A.lum ? A.lum.onTop.mean + '/' + A.lum.offTop.mean : '-'} flags=[${A.flags.map(f => f.type).join(',')}] sheet=${A.sheet.length} ${A.counts ? JSON.stringify(A.counts) : ''}`);
  } catch (e) { console.log(`${d}: ANALYZE ERROR ${e.stack.split('\n').slice(0, 2).join(' ')}`); }
}
console.log(`analyzed ${n}/${dirs.length}`);
