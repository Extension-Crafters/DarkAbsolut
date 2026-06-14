// Standalone injection script — no chrome.runtime dependency.
// Loaded into the page by test-dark.js via page.addScriptTag.
(() => {
  const ATTR           = 'data-darkabsolut';
  const STYLE_ID       = 'darkabsolut-style';
  const ORIG_ATTR      = 'data-darkabsolut-bg-orig';
  const ORIG_COLOR_ATTR = 'data-darkabsolut-color-orig';

  // ── colour helpers ──────────────────────────────────────────────────────────
  function parseColor(str) {
    if (!str) return null;
    const m = str.match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return null;
    const [r, g, b, a = 1] = parts;
    return { r, g, b, a };
  }
  function luminance({ r, g, b }) {
    const toLin = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
  }
  function saturation({ r, g, b }) {
    const R = r/255, G = g/255, B = b/255;
    const mx = Math.max(R,G,B), mn = Math.min(R,G,B);
    const l = (mx+mn)/2, d = mx-mn;
    return d === 0 ? 0 : d / (1 - Math.abs(2*l - 1));
  }
  function rgbToHsl({ r, g, b }) {
    const R = r/255, G = g/255, B = b/255;
    const mx = Math.max(R,G,B), mn = Math.min(R,G,B);
    const l = (mx+mn)/2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      switch (mx) {
        case R: h = (G-B)/d + (G<B?6:0); break;
        case G: h = (B-R)/d + 2; break;
        case B: h = (R-G)/d + 4; break;
      }
      h *= 60;
    }
    return { h, s, l };
  }
  function hslToRgbString({ h, s, l }) {
    const c = (1 - Math.abs(2*l-1)) * s;
    const x = c * (1 - Math.abs(((h/60) % 2) - 1));
    const m = l - c/2;
    let r1, g1, b1;
    if      (h < 60)  [r1,g1,b1] = [c,x,0];
    else if (h < 120) [r1,g1,b1] = [x,c,0];
    else if (h < 180) [r1,g1,b1] = [0,c,x];
    else if (h < 240) [r1,g1,b1] = [0,x,c];
    else if (h < 300) [r1,g1,b1] = [x,0,c];
    else              [r1,g1,b1] = [c,0,x];
    return 'rgb(' + Math.round((r1+m)*255) + ',' + Math.round((g1+m)*255) + ',' + Math.round((b1+m)*255) + ')';
  }

  // ── CSS injection ───────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    const A = 'html[data-darkabsolut="on"]';
    style.textContent = [
      A + ' { filter: invert(1) hue-rotate(180deg) !important; }',
      ':where(' + A + ') { background-color: #ffffff; }',
      [A + ' img', A + ' picture', A + ' video',
       A + ' canvas', A + ' svg image',
       A + ' [data-darkabsolut-bg="1"]',
       A + ' [data-darkabsolut-darknative="1"]'].join(',') +
        ' { filter: invert(1) hue-rotate(180deg) !important; }',
      A + ' svg:not([data-darkabsolut-bg="1"]):not(:has(image)) { filter: none !important; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  // ── per-element processing ──────────────────────────────────────────────────
  function hasVisibleLightDescendant(el, depth) {
    for (const child of el.children) {
      let cs;
      try { cs = getComputedStyle(child); } catch (_) { continue; }
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0.4 && luminance(c) > 0.50) return true;
      if (depth > 1 && hasVisibleLightDescendant(child, depth - 1)) return true;
    }
    return false;
  }

  function tagNativeDarkBg(el, cs) {
    const c = parseColor(cs.backgroundColor);
    if (!c || c.a < 0.5) return false;
    if (el === document.documentElement || el === document.body) return false;
    if (hasNativeDarkAncestor(el)) return false;
    const lum = luminance(c);
    const sat = saturation(c);
    const maxSat = lum < 0.04 ? 0.80 : lum < 0.10 ? 0.45 : 0.25;
    if (lum < 0.10 && sat < maxSat) {
      if (hasVisibleLightDescendant(el, 3)) return false;
      el.setAttribute('data-darkabsolut-darknative', '1');
      return true;
    }
    return false;
  }

  function hasNativeDarkAncestor(el) {
    let cur = el.parentElement;
    while (cur && cur !== document.documentElement) {
      if (cur.hasAttribute('data-darkabsolut-darknative')) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function preLightenIfSaturated(el, cs) {
    if (el.hasAttribute(ORIG_ATTR)) return;
    if (hasNativeDarkAncestor(el)) return;
    const c = parseColor(cs.backgroundColor);
    if (!c || c.a < 0.5) return;
    const hsl = rgbToHsl(c);
    if (hsl.l < 0.18) return;

    let targetS;
    if (hsl.s >= 0.30 && hsl.l <= 0.85) {
      targetS = Math.min(hsl.s, 0.55);
    } else if (hsl.s >= 0.30 && hsl.l > 0.85) {
      targetS = Math.min(hsl.s, 0.60);
    } else if (hsl.s >= 0.05 && hsl.l >= 0.65 && hsl.l <= 0.88) {
      targetS = Math.min(hsl.s * 3.0, 0.45);
    } else {
      return;
    }

    const lightened = hslToRgbString({ h: hsl.h, s: targetS, l: 0.92 });
    el.setAttribute(ORIG_ATTR, el.style.getPropertyValue('background-color') || '');
    el.setAttribute('data-da-orig-computed', cs.backgroundColor);
    el.style.setProperty('background-color', lightened, 'important');

    const tc = parseColor(cs.color);
    if (tc && tc.a > 0.2 && rgbToHsl(tc).l > 0.55) {
      el.setAttribute(ORIG_COLOR_ATTR, el.style.getPropertyValue('color') || '');
      el.style.setProperty('color', '#1a1a1a', 'important');
    }
  }

  const SKIP_BG_IMAGE_TAGS = new Set(['SELECT', 'INPUT', 'TEXTAREA']);

  function processElement(el) {
    if (!el || el.nodeType !== 1) return;
    try {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundImage;
      if (bg && bg !== 'none' && /url\(|gradient\(/i.test(bg) && !SKIP_BG_IMAGE_TAGS.has(el.tagName)) {
        el.setAttribute('data-darkabsolut-bg', '1');
      } else {
        el.removeAttribute('data-darkabsolut-bg');
      }
      if (tagNativeDarkBg(el, cs)) return;
      el.removeAttribute('data-darkabsolut-darknative');
      preLightenIfSaturated(el, cs);
    } catch (_) {}
  }

  function markAll() {
    let i = 0;
    for (const el of document.querySelectorAll('*')) {
      if (i++ > 8000) break;
      processElement(el);
    }
  }

  ensureStyle();
  document.documentElement.setAttribute(ATTR, 'on');
  markAll();
  window.__darkabsolut_applied = true;
  console.log('[DarkAbsolutTest] applied, processed ' + document.querySelectorAll('[data-darkabsolut-bg-orig]').length + ' pre-lightened elements');
})();
