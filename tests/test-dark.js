// Playwright test: verify DarkAbsolut color transformations on Redis docs
// Run: node test-dark.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const TARGET       = 'https://redis.io/docs/latest/commands/lpos/';
const SHOTS_DIR    = path.join(__dirname, 'screenshots');
const SHOT_PATH    = path.join(SHOTS_DIR, 'test-result.png');
const CORE_PATH    = path.join(__dirname, 'test-core.js');

fs.mkdirSync(SHOTS_DIR, { recursive: true });

// Apply CSS filter: invert(1) hue-rotate(180deg) to an rgb color (in JS math).
function applyInvertHueRotate(r, g, b) {
  // Step 1 — invert
  let ri = 255 - r, gi = 255 - g, bi = 255 - b;
  // Step 2 — hue-rotate(180deg) in HSL space
  const R = ri/255, G = gi/255, B = bi/255;
  const mx = Math.max(R,G,B), mn = Math.min(R,G,B);
  const l = (mx+mn)/2;
  const d = mx-mn;
  if (d < 0.001) return { r: ri, g: gi, b: bi }; // achromatic — rotation has no effect
  const s = l > 0.5 ? d/(2-mx-mn) : d/(mx+mn);
  let h = 0;
  switch (mx) {
    case R: h = ((G-B)/d + (G<B?6:0)) * 60; break;
    case G: h = ((B-R)/d + 2) * 60; break;
    case B: h = ((R-G)/d + 4) * 60; break;
  }
  h = (h + 180) % 360;  // rotate 180°
  // HSL → RGB
  const c2 = (1 - Math.abs(2*l-1)) * s;
  const x2 = c2 * (1 - Math.abs(((h/60)%2)-1));
  const m2 = l - c2/2;
  let r2,g2,b2;
  if      (h<60)  [r2,g2,b2]=[c2,x2,0];
  else if (h<120) [r2,g2,b2]=[x2,c2,0];
  else if (h<180) [r2,g2,b2]=[0,c2,x2];
  else if (h<240) [r2,g2,b2]=[0,x2,c2];
  else if (h<300) [r2,g2,b2]=[x2,0,c2];
  else            [r2,g2,b2]=[c2,0,x2];
  return { r: Math.round((r2+m2)*255), g: Math.round((g2+m2)*255), b: Math.round((b2+m2)*255) };
}

function parseRgb(str) {
  const m = str && str.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const [r,g,b] = m[1].split(',').map(Number);
  return isNaN(r) ? null : { r, g, b };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  console.log('Navigating …');
  await page.goto(TARGET, { waitUntil: 'load', timeout: 60000 });
  console.log('Page loaded.');

  // Inject extension core.
  await page.addScriptTag({ path: CORE_PATH });
  await page.waitForTimeout(500);

  // Collect processed results.
  const processed = await page.evaluate(() => {
    const results = [];
    for (const el of document.querySelectorAll('[data-darkabsolut-bg-orig]')) {
      const origBg   = el.getAttribute('data-da-orig-computed') || el.getAttribute('data-darkabsolut-bg-orig');
      const preLit   = el.style.backgroundColor; // what we set
      const cs       = getComputedStyle(el);
      const tag      = el.tagName.toLowerCase();
      const cls      = Array.from(el.classList).slice(0,4).join(' ');
      results.push({ tag, cls, origBg, preLit, computedBg: cs.backgroundColor });
    }
    // Also collect still-unprocessed light elements.
    const unhandled = [];
    function lum(r,g,b) {
      const c = v => { const s=v/255; return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4); };
      return 0.2126*c(r)+0.7152*c(g)+0.0722*c(b);
    }
    function parseBg(str) {
      const m=str&&str.match(/rgba?\(([^)]+)\)/i); if(!m) return null;
      const [r,g,b,a=1]=m[1].split(',').map(Number); return isNaN(r)?null:{r,g,b,a};
    }
    for (const el of document.querySelectorAll('*')) {
      if (el===document.documentElement||el===document.body) continue;
      if (el.hasAttribute('data-darkabsolut-bg-orig')) continue;
      if (el.hasAttribute('data-darkabsolut-darknative')) continue;
      try {
        const cs = getComputedStyle(el);
        const c = parseBg(cs.backgroundColor);
        if (!c||c.a<0.5) continue;
        const l = lum(c.r,c.g,c.b);
        if (l > 0.30) {
          const tag=el.tagName.toLowerCase(), cls=Array.from(el.classList).slice(0,3).join(' ');
          unhandled.push({ tag, cls, bg: cs.backgroundColor, lum: +(l.toFixed(3)) });
        }
      } catch {}
    }
    return { processed: results, unhandled: unhandled.sort((a,b)=>b.lum-a.lum) };
  });

  console.log('\n── Pre-processed elements (' + processed.processed.length + ') ─────────────────────────');
  console.log('  (These get CSS filter applied on top, resulting in the "Final dark" color shown)\n');

  // Build swatch HTML for visual comparison.
  let swatchRows = '';
  for (const e of processed.processed) {
    const origC = parseRgb(e.origBg);
    const preC  = parseRgb(e.preLit);
    if (!origC || !preC) continue;

    const finalC = applyInvertHueRotate(preC.r, preC.g, preC.b);
    const finalStr = `rgb(${finalC.r},${finalC.g},${finalC.b})`;

    const textColor = (finalC.r*0.299+finalC.g*0.587+finalC.b*0.114) > 128 ? '#000' : '#fff';
    const label = (e.tag + ' ' + e.cls).slice(0, 50);

    console.log(`  ${label}`);
    console.log(`    orig:  ${e.origBg}`);
    console.log(`    pre:   ${e.preLit}`);
    console.log(`    final: ${finalStr}`);

    swatchRows += `
      <tr>
        <td style="background:${e.origBg||'#fff'};color:${(parseRgb(e.origBg||'rgb(0,0,0)')?.r||0)*0.299>128?'#000':'#fff'}">${label}</td>
        <td style="background:${e.preLit}">&nbsp;</td>
        <td style="background:${finalStr};color:${textColor}">${finalStr}</td>
      </tr>`;
  }

  // Unhandled light elements.
  console.log('\n── Unhandled light backgrounds (covered by page-level filter) ─────────────');
  const seen = new Set();
  let unhandledRows = '';
  for (const e of processed.unhandled) {
    if (seen.has(e.bg)) continue; seen.add(e.bg);
    const c = parseRgb(e.bg);
    if (!c) continue;
    const finalC = applyInvertHueRotate(c.r, c.g, c.b);
    const finalStr = `rgb(${finalC.r},${finalC.g},${finalC.b})`;
    const tc = (finalC.r*0.299+finalC.g*0.587+finalC.b*0.114)>128?'#000':'#fff';
    console.log(`  lum=${e.lum}  ${e.bg}  →  ${finalStr}  (${e.tag} ${e.cls.slice(0,30)})`);
    unhandledRows += `
      <tr>
        <td style="background:${e.bg}">${e.bg} — ${e.tag} ${e.cls.slice(0,30)}</td>
        <td style="background:${finalStr};color:${tc}">${finalStr}</td>
      </tr>`;
  }

  // Build and screenshot a swatch page showing the transformations.
  const swatchHtml = `<!DOCTYPE html><html><head>
  <style>
    body { font-family: monospace; font-size: 12px; margin: 12px; background: #111; color: #eee; }
    h2 { margin: 16px 0 6px; color: #aaa; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
    td { padding: 6px 10px; border: 1px solid #333; }
    td:first-child { width: 40%; }
  </style></head><body>
  <h2>Pre-processed elements: original → pre-lightened → final dark (after filter)</h2>
  <table><thead><tr><th>Element</th><th>Pre-lightened (what CSS sees)</th><th>Final dark (after invert+hue-rotate)</th></tr></thead>
  <tbody>${swatchRows || '<tr><td colspan="3">none</td></tr>'}</tbody></table>
  <h2>Unhandled light backgrounds: original → final dark (direct filter)</h2>
  <table><thead><tr><th>Original (computed bg)</th><th>Final dark</th></tr></thead>
  <tbody>${unhandledRows || '<tr><td colspan="2">none</td></tr>'}</tbody></table>
  </body></html>`;

  const swatchPath = path.join(SHOTS_DIR, 'test-swatches.html');
  fs.writeFileSync(swatchPath, swatchHtml);

  // Screenshot the swatch page.
  await page.setContent(swatchHtml);
  await page.screenshot({ path: SHOT_PATH, fullPage: true });
  console.log('\nSwatch screenshot ->', SHOT_PATH);

  await browser.close();
})();
