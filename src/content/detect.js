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
  // Media elements draw their own content; their CSS background-color is a
  // placeholder BEHIND that content (like a url() image), not the page's
  // surface — so detection must look past it. Google Maps' map <canvas> has
  // background:#000; counting it made the (otherwise light) Maps UI read as
  // "already dark" and get un-inverted a few seconds after load.
  const MEDIA_TAGS = { CANVAS: 1, IMG: 1, VIDEO: 1, PICTURE: 1, OBJECT: 1, EMBED: 1 };

  function firstOpaqueBgUp(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (MEDIA_TAGS[cur.tagName]) { cur = cur.parentElement; continue; }
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

  // The color the UA paints behind fully-transparent content — the "canvas".
  // Per CSS background propagation that's the root element's background, else
  // <body>'s, else the UA default (white). We ignore our own injected
  // white-on-<html> fallback so re-evaluation reads the page's real base.
  //
  // This matters because a transparent sample point is NOT "no information":
  // it's whatever the canvas paints there. Sites that leave <body>/<html>
  // transparent and rely on the default white canvas (e.g. Know Your Meme,
  // where a tall dark hero is the only element with an explicit background)
  // were otherwise mis-read as dark, because every white point was dropped
  // and only the opaque dark hero got counted.
  function canvasBgColor() {
    const html = document.documentElement, body = document.body;
    if (html) {
      const hc = parseColor(getComputedStyle(html).backgroundColor);
      if (hc && hc.a > 0.5 &&
          !(DA.state && DA.state.applied && hc.r === 255 && hc.g === 255 && hc.b === 255)) {
        return hc;
      }
    }
    if (body) {
      const bc = parseColor(getComputedStyle(body).backgroundColor);
      if (bc && bc.a > 0.5) return bc;
    }
    // No explicit background: the canvas is the UA default, whose colour is the
    // OPPOSITE of the UA default *text* colour. Usually that's white (dark text
    // on white). But when the UA itself renders the document dark — OS dark mode
    // + a plain-text/data viewer (Chrome's text/plain page), or color-scheme:dark
    // — the default text turns light and the canvas is dark. Reading the default
    // text colour detects this without assuming any specific UA: light default
    // text ⇒ dark canvas. Fixes Chrome's text/plain viewer in dark mode being
    // inverted to unreadable black-on-black; normal light pages (dark default
    // text) still resolve to white.
    const textEl = body || html;
    if (textEl) {
      const tc = parseColor(getComputedStyle(textEl).color);
      if (tc && tc.a > 0.5 && luminance(tc) > 0.5) {
        return { r: 18, g: 18, b: 18, a: 1 };
      }
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  // The colour of an element that paints (nearly) the ENTIRE document — a
  // wrapper that establishes the page background even though <html>/<body> are
  // transparent. Modern app shells (Next.js #__next, React roots) commonly set
  // the dark theme background on such a wrapper, not on <html>/<body>, so
  // canvasBgColor() (which only reads html/body) misses it and the page reads as
  // light to the base-bg check — which then keeps an optimistically-applied
  // inversion on, flipping a genuinely-dark page bright. Requiring full-DOCUMENT
  // coverage (not just the viewport) keeps a dark hero / navbar / footer — which
  // each cover only a band — from qualifying. Returns the first full-page OPAQUE
  // background walking down from <body>, else null.
  // (k4g.com: body > #__next [transparent, full] > #k4g-root rgb(0,3,38) [opaque, full].)
  function fullPageBgColor() {
    const body = document.body;
    if (!body) return null;
    const W = window.innerWidth | 0;
    const docH = Math.max(
      document.documentElement.scrollHeight || 0,
      body.scrollHeight || 0, window.innerHeight | 0);
    if (W < 50 || docH < 50) return null;
    const queue = [];
    for (const ch of body.children) queue.push(ch);
    let i = 0;
    while (queue.length && i++ < 80) {
      const el = queue.shift();
      if (!el || el.nodeType !== 1) continue;
      let r; try { r = el.getBoundingClientRect(); } catch (_) { continue; }
      // Must span essentially the whole document — a band/hero/footer won't.
      if (r.width < W * 0.95 || r.height < docH * 0.9) continue;
      let cs; try { cs = getComputedStyle(el); } catch (_) { continue; }
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0.7) return c;          // first full-page opaque background
      for (const ch of el.children) queue.push(ch); // transparent → look deeper
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
    const canvasBg = canvasBgColor();
    const out = [];
    for (const fx of fxs) {
      for (const fy of fys) {
        const x = Math.max(1, Math.min(W - 2, Math.floor(W * fx)));
        const y = Math.max(1, Math.min(H - 2, Math.floor(H * fy)));
        let el;
        try { el = document.elementFromPoint(x, y); } catch (_) { el = null; }
        if (!el) continue;
        // A transparent point shows the canvas — count it, don't drop it.
        out.push(firstOpaqueBgUp(el) || canvasBg);
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
    const canvasBg = canvasBgColor();
    const out = [];
    for (const [fx, fy] of points) {
      const x = Math.max(1, Math.min(W - 2, Math.floor(W * fx)));
      const y = Math.max(1, Math.min(H - 2, Math.floor(H * fy)));
      let el;
      try { el = document.elementFromPoint(x, y); } catch (_) { el = null; }
      if (!el) continue;
      // A transparent edge shows the canvas — count it as such, don't drop it.
      out.push(firstOpaqueBgUp(el) || canvasBg);
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
    canvasBgColor,
    fullPageBgColor,
    sampleViewportBgColors,
    sampleChromeBgColors,
    effectiveBgColor,
    pageDeclaresDarkScheme,
    allStylesheetsLoaded,
    detectDarkState
  };
})(DA);
