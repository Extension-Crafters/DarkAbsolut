// DarkAbsolut — dark-theme detection.
//
// Decides whether a page is already using a dark theme by:
//   1. Respecting an explicitly declared dark color-scheme.
//   2. Sampling the actual painted viewport at a grid of points.
//   3. Falling back to <body>/<html> background-color.
//
// `detectDarkState()` returns true (dark), false (light), or null (unknown).

(function (DA) {
  "use strict";

  const { parseColor, luminance, isNeutralDark } = DA.colors;

  // Walk from `el` up the ancestor chain until we find the first element with
  // a non-transparent background-color — this matches what the user actually
  // sees at that point on screen (CSS painting cascade).
  function firstOpaqueBgUp(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const cs = getComputedStyle(cur);
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0.5) {
        // Skip our own injected white override on <html>.
        if (cur === document.documentElement && DA.state && DA.state.applied &&
            c.r === 255 && c.g === 255 && c.b === 255) {
          return null;
        }
        // For url()-based background images we can't know the image's
        // darkness, so walk up. Gradients are decorative overlays; the
        // background-color underneath is still the authoritative signal.
        const bgi = cs.backgroundImage;
        if (bgi && bgi !== "none" && /url\(/i.test(bgi) && !/gradient\(/i.test(bgi)) {
          cur = cur.parentElement;
          continue;
        }
        return c;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  // Sample the rendered viewport at a grid of points and return the dominant
  // visible background color (area-weighted by sample count). Robust to
  // descendant containers that cover the viewport when <body> is white
  // (e.g. Tailwind with CSS custom properties).
  function sampleViewportBgColors() {
    const W = window.innerWidth | 0;
    const H = window.innerHeight | 0;
    if (W < 50 || H < 50) return [];
    const fxs = [0.1, 0.3, 0.5, 0.7, 0.9];
    const fys = [0.15, 0.35, 0.55, 0.75, 0.92];
    const out = [];
    for (const fx of fxs) {
      for (const fy of fys) {
        const x = Math.max(1, Math.min(W - 2, Math.floor(W * fx)));
        const y = Math.max(1, Math.min(H - 2, Math.floor(H * fy)));
        let el;
        try { el = document.elementFromPoint(x, y); } catch (_) { el = null; }
        if (!el) continue;
        const c = firstOpaqueBgUp(el);
        if (c) out.push(c);
      }
    }
    return out;
  }

  // Sample only the viewport edges — the strips the page chrome lives in
  // (top header, left/right sidebars, bottom bar). This is the signal we
  // trust for "is the site frame dark?" independently of how big or light
  // the central content panel is. Critical for apps like Gmail where an
  // open message renders a large white iframe inside an otherwise-dark UI
  // and would otherwise dominate the full-viewport sampling.
  function sampleChromeBgColors() {
    const W = window.innerWidth | 0;
    const H = window.innerHeight | 0;
    if (W < 600 || H < 400) return [];
    const points = [
      // Left edge.
      [0.02, 0.15], [0.02, 0.35], [0.02, 0.55], [0.02, 0.75], [0.02, 0.92],
      // Right edge.
      [0.98, 0.15], [0.98, 0.35], [0.98, 0.55], [0.98, 0.75], [0.98, 0.92],
      // Top edge (skip the very first row to avoid browser chrome bleed).
      [0.20, 0.03], [0.50, 0.03], [0.80, 0.03],
      // Bottom edge.
      [0.20, 0.97], [0.50, 0.97], [0.80, 0.97]
    ];
    const out = [];
    for (const [fx, fy] of points) {
      const x = Math.max(1, Math.min(W - 2, Math.floor(W * fx)));
      const y = Math.max(1, Math.min(H - 2, Math.floor(H * fy)));
      let el;
      try { el = document.elementFromPoint(x, y); } catch (_) { el = null; }
      if (!el) continue;
      const c = firstOpaqueBgUp(el);
      if (c) out.push(c);
    }
    return out;
  }

  function effectiveBgColor() {
    // 0) Semantic shortcut: if the primary content container is explicitly
    // dark, the page uses a dark theme. Handles sites like redis.io where
    // white cards inside a dark <main> dominate the sample grid.
    try {
      const mainEl = document.querySelector('main, [role="main"]');
      if (mainEl) {
        const mc = parseColor(getComputedStyle(mainEl).backgroundColor);
        if (mc && mc.a > 0.5 && isNeutralDark(mc)) return mc;
      }
    } catch (_) {}

    // 0.5) Chrome-edge sampling. If the site frame (header, sidebar, side
    // rails, footer) is predominantly dark, treat the page as dark even
    // when a large central content panel is white. Without this, apps like
    // Gmail with an open message get mis-detected as light because the
    // white message iframe dominates the full-viewport sample grid.
    const chrome = sampleChromeBgColors();
    if (chrome.length >= 8) {
      let darkCount = 0, darkSample = null;
      for (const c of chrome) {
        if (isNeutralDark(c)) {
          darkCount++;
          if (!darkSample) darkSample = c;
        }
      }
      if (darkSample && darkCount >= Math.ceil(chrome.length * 0.6)) {
        return darkSample;
      }
    }

    // 1) Viewport sampling: what the user actually sees.
    const samples = sampleViewportBgColors();
    if (samples.length >= 5) {
      const buckets = new Map();
      for (const c of samples) {
        const k = (c.r >> 4) + "_" + (c.g >> 4) + "_" + (c.b >> 4);
        const e = buckets.get(k) || { c, n: 0 };
        e.n++; buckets.set(k, e);
      }
      let best = null;
      for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
      if (best && best.n >= Math.ceil(samples.length * 0.4)) return best.c;

      // Dominant cluster didn't reach 40 %. Sites using pure
      // @media (prefers-color-scheme: dark) CSS apply dark backgrounds
      // component-by-component while <body> stays bg-white. If the OS is in
      // dark mode and ≥ 25 % of samples are neutral-dark, trust that.
      try {
        if (matchMedia('(prefers-color-scheme: dark)').matches) {
          let darkCount = 0, darkSample = null;
          for (const c of samples) {
            if (isNeutralDark(c)) { darkCount++; if (!darkSample) darkSample = c; }
          }
          if (darkSample && darkCount >= Math.ceil(samples.length * 0.25)) return darkSample;
        }
      } catch (_) {}
    }

    // 2) Fallback: body / html background-color.
    const candidates = [document.body, document.documentElement].filter(Boolean);
    for (const el of candidates) {
      const cs = getComputedStyle(el);
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0.5) {
        if (el === document.documentElement && DA.state && DA.state.applied &&
            c.r === 255 && c.g === 255 && c.b === 255) {
          continue;
        }
        return c;
      }
    }
    return null;
  }

  function pageDeclaresDarkScheme() {
    const html = document.documentElement;
    if (!html) return false;
    const cs = getComputedStyle(html);
    const scheme = (cs.colorScheme || "").toLowerCase();
    if (scheme.includes("dark") && !scheme.includes("light")) return true;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) {
      const v = (meta.getAttribute("content") || "").toLowerCase();
      if (v.includes("dark") && !v.includes("light")) return true;
    }
    return false;
  }

  function allStylesheetsLoaded() {
    const links = document.querySelectorAll('link[rel~="stylesheet"]');
    for (const l of links) {
      if (!l.sheet && !l.disabled) return false;
    }
    return true;
  }

  function detectDarkState() {
    if (pageDeclaresDarkScheme()) return true;
    try {
      const c = effectiveBgColor();
      if (!c) return null;
      if (isNeutralDark(c)) return true;
      return false;
    } catch (_) {
      return null;
    }
  }

  DA.detect = {
    firstOpaqueBgUp,
    sampleViewportBgColors,
    sampleChromeBgColors,
    effectiveBgColor,
    pageDeclaresDarkScheme,
    allStylesheetsLoaded,
    detectDarkState
  };
})(DA);
