// DarkAbsolut - content script
// 1) Asks background whether to apply on this URL.
// 2) Detects whether the page is already dark; if so, skips inversion.
// 3) Applies an inversion stylesheet that flips colors while re-inverting
//    media (images, videos, iframes, svg, canvas, picture, embed, object)
//    and elements with background images, so visual content stays correct.
// 4) Listens for state changes from the popup/background and re-applies.

(() => {
  const STYLE_ID = "darkabsolut-style";
  const ATTR = "data-darkabsolut";

  let applied = false;
  let lastEnabledRequest = false;

  function log(...a) { /* console.debug("[DarkAbsolut]", ...a); */ }

  // ---- Dark theme detection -------------------------------------------------
  // Parse rgb/rgba/hsl from computed style and return relative luminance.
  function parseColor(str) {
    if (!str) return null;
    const m = str.match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const parts = m[1].split(",").map(s => parseFloat(s.trim()));
    if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return null;
    const [r, g, b, a = 1] = parts;
    return { r, g, b, a };
  }
  function luminance({ r, g, b }) {
    const toLin = c => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
  }
  // HSL saturation in [0,1]. Real dark themes use near-neutral grays/blacks;
  // saturated colored backgrounds (e.g. #2980b9) should still be inverted.
  function saturation({ r, g, b }) {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return 0;
    return d / (1 - Math.abs(2 * l - 1));
  }
  // Walk from `el` up the ancestor chain until we find the first element with
  // a non-transparent background-color. This matches what the user actually
  // sees at that point on screen (CSS painting cascade).
  function firstOpaqueBgUp(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const cs = getComputedStyle(cur);
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0.5) {
        // Skip our own injected white override on <html>.
        if (cur === document.documentElement && applied &&
            c.r === 255 && c.g === 255 && c.b === 255) {
          return null;
        }
        // For url()-based background images we can't know the image's
        // darkness, so skip and walk up. CSS gradients are purely decorative
        // overlays; the background-color underneath is still the authoritative
        // dark signal, so don't skip those.
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
  // visible background color (area-weighted by sample count). This is robust
  // to sites where <body> is white but a descendant container (e.g. Tailwind
  // `background: rgb(9 26 35/var(--tw-bg-opacity,1))`) actually covers the
  // viewport — the case the previous body/html-only probe missed.
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

  function effectiveBgColor() {
    // 0) Semantic shortcut: if the primary content container has an explicitly
    // dark background the page uses a dark theme. This handles sites like
    // redis.io where white card components inside a dark <main> dominate the
    // sample grid (pushing the dominant cluster to white) and cause the
    // 40 % threshold check to return the wrong answer.
    try {
      const mainEl = document.querySelector('main, [role="main"]');
      if (mainEl) {
        const mc = parseColor(getComputedStyle(mainEl).backgroundColor);
        if (mc && mc.a > 0.5 && isNeutralDark(mc)) return mc;
      }
    } catch (_) {}
    // 1) Viewport sampling: what the user actually sees.
    const samples = sampleViewportBgColors();
    if (samples.length >= 5) {
      // Cluster by quantized RGB (16-step buckets) and pick the dominant one.
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
      // @media (prefers-color-scheme: dark) CSS (e.g. redis.io) apply dark
      // backgrounds component-by-component while <body> stays bg-white, so
      // white samples outnumber dark ones. If the OS is already in dark mode
      // and ≥ 25 % of sampled elements carry a neutral-dark background, the
      // page is already doing media-query dark mode — don't invert it.
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
    // 2) Fallback: body / html background-color (legacy path).
    const candidates = [document.body, document.documentElement].filter(Boolean);
    for (const el of candidates) {
      const cs = getComputedStyle(el);
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0.5) {
        if (el === document.documentElement && applied &&
            c.r === 255 && c.g === 255 && c.b === 255) {
          continue;
        }
        return c;
      }
    }
    return null;
  }
  function pageDeclaresDarkScheme() {
    // Respect site's own declared dark color-scheme.
    const html = document.documentElement;
    if (!html) return false;
    const cs = getComputedStyle(html);
    const scheme = (cs.colorScheme || "").toLowerCase();
    if (scheme.includes("dark") && !scheme.includes("light")) return true;
    // <meta name="color-scheme" content="dark">
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) {
      const v = (meta.getAttribute("content") || "").toLowerCase();
      if (v.includes("dark") && !v.includes("light")) return true;
    }
    return false;
  }
  // Treat as a real dark theme only if the background is dark AND
  // sufficiently neutral. A saturated mid-luminance color (e.g. #2980b9 blue)
  // is a branded light background and should still be inverted.
  // Very dark colors (luminance < 0.04, near-black) are allowed higher
  // saturation because even a chromatic near-black is clearly a dark theme
  // background (e.g. rgb(9,26,35) = redis-ink-900, luminance ≈ 0.009,
  // saturation ≈ 0.59 — it IS dark, the HSL formula overstates saturation
  // at near-zero lightness).
  const DARK_LUM_MAX = 0.22;
  function isNeutralDark(c) {
    if (!c) return false;
    const lum = luminance(c);
    if (lum >= DARK_LUM_MAX) return false;
    const sat = saturation(c);
    // Adaptive saturation ceiling: near-black colors can be chromatic and
    // still qualify; as luminance rises toward the threshold, tighten the
    // saturation limit so mid-luminance branded hues are rejected.
    const maxSat = lum < 0.04 ? 0.80 : lum < 0.10 ? 0.45 : 0.25;
    return sat < maxSat;
  }
  // Returns: true (dark), false (light), null (unknown / not enough info yet).
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

  function allStylesheetsLoaded() {
    const links = document.querySelectorAll('link[rel~="stylesheet"]');
    for (const l of links) {
      // sheet is null while still loading; throws on cross-origin but presence is enough
      if (!l.sheet && !l.disabled) return false;
    }
    return true;
  }

  // ---- Style injection ------------------------------------------------------
  function buildInversionCss() {
    // Base: invert the whole document, then re-invert media so colors
    // stay correct. hue-rotate(180deg) preserves hues after invert.
    return `
html[${ATTR}="on"] {
  filter: invert(1) hue-rotate(180deg) !important;
}
/* Zero-specificity fallback bg: any site rule (e.g. html.dark { background })
   wins, so effectiveBgColor() can read the real native bg and detect dark.
   No high-specificity override here: a higher-specificity rule on <html>
   would mask the site's real background and break dark-detection on sites
   like Redis docs where the dark color is set via html.dark{background:...}
   while <body> stays bg-white. */
:where(html[${ATTR}="on"]) {
  background-color: #ffffff;
}
html[${ATTR}="on"] img,
html[${ATTR}="on"] picture,
html[${ATTR}="on"] video,
html[${ATTR}="on"] iframe,
html[${ATTR}="on"] embed,
html[${ATTR}="on"] object,
html[${ATTR}="on"] canvas,
html[${ATTR}="on"] svg image,
html[${ATTR}="on"] [style*="background-image"],
html[${ATTR}="on"] [data-darkabsolut-bg="1"],
html[${ATTR}="on"] [data-darkabsolut-darknative="1"] {
  filter: invert(1) hue-rotate(180deg) !important;
}
/* Avoid double-inverting svg icons that use currentColor (treat them as text) */
html[${ATTR}="on"] svg:not([data-darkabsolut-bg="1"]):not(:has(image)) {
  filter: none !important;
}
/* Fixed elements need their own stacking context to invert correctly */
html[${ATTR}="on"] *[style*="position: fixed"],
html[${ATTR}="on"] *[style*="position:fixed"] {
  /* no-op placeholder; left as hook for future tuning */
}
`;
  }

  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = buildInversionCss();
      (document.head || document.documentElement).appendChild(style);
    }
    return style;
  }

  // ---- HSL conversion (used to pre-lighten saturated backgrounds so the
  // html-level invert filter actually darkens them) -------------------------
  function rgbToHsl({ r, g, b }) {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case R: h = (G - B) / d + (G < B ? 6 : 0); break;
        case G: h = (B - R) / d + 2; break;
        case B: h = (R - G) / d + 4; break;
      }
      h *= 60;
    }
    return { h, s, l };
  }
  function hslToRgbString({ h, s, l }) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r1, g1, b1;
    if (h < 60)       [r1, g1, b1] = [c, x, 0];
    else if (h < 120) [r1, g1, b1] = [x, c, 0];
    else if (h < 180) [r1, g1, b1] = [0, c, x];
    else if (h < 240) [r1, g1, b1] = [0, x, c];
    else if (h < 300) [r1, g1, b1] = [x, 0, c];
    else              [r1, g1, b1] = [c, 0, x];
    const R = Math.round((r1 + m) * 255);
    const G = Math.round((g1 + m) * 255);
    const B = Math.round((b1 + m) * 255);
    return `rgb(${R}, ${G}, ${B})`;
  }

  const ORIG_ATTR = "data-darkabsolut-bg-orig";
  const ORIG_COLOR_ATTR = "data-darkabsolut-color-orig";

  // Walk ancestors looking for a darknative-tagged container. Elements inside
  // such a container are double-inverted back to their original colors by the
  // container's counter-filter, so pre-lightening is both unnecessary and
  // harmful (it creates a compounded light artifact).
  function hasNativeDarkAncestor(el) {
    let cur = el.parentElement;
    while (cur && cur !== document.documentElement) {
      if (cur.hasAttribute("data-darkabsolut-darknative")) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // Saturated mid-lightness backgrounds (e.g. brand blue #459cd5, l~55%) are
  // barely darkened by `invert + hue-rotate(180)`. Pre-lighten the element's
  // background to ~92% lightness so the html-level invert flips it to ~8%
  // (true dark) while preserving hue. Also force a dark text color so the
  // invert flips it to light — readable over the new dark bg even if the
  // site originally used light text on its colored background.
  function preLightenIfSaturated(el, cs) {
    if (el.hasAttribute(ORIG_ATTR)) return;
    if (hasNativeDarkAncestor(el)) return;
    const c = parseColor(cs.backgroundColor);
    if (!c || c.a < 0.5) return;
    const hsl = rgbToHsl(c);
    if (hsl.l < 0.18) return; // dark — tagNativeDarkBg or filter handles it

    let targetS;
    if (hsl.s >= 0.30 && hsl.l <= 0.85) {
      // Original case: saturated mid-lightness background.
      targetS = Math.min(hsl.s, 0.55);
    } else if (hsl.s >= 0.30 && hsl.l > 0.85) {
      // Near-white with a real color tint (previously skipped). Keep saturation
      // so the hue survives invert+hue-rotate and gives a clearly-hued dark result.
      targetS = Math.min(hsl.s, 0.60);
    } else if (hsl.s >= 0.05 && hsl.l >= 0.65 && hsl.l <= 0.88) {
      // Subtly-tinted light backgrounds (info boxes, light panels). Without this
      // the filter collapses them to near-neutral black, losing all nuance.
      // Amplify saturation so the tint survives the inversion pipeline.
      targetS = Math.min(hsl.s * 3.0, 0.45);
    } else {
      return; // near-grayscale or extreme lightness — filter handles adequately
    }

    const lightened = hslToRgbString({
      h: hsl.h,
      s: targetS,
      l: 0.92
    });
    el.setAttribute(ORIG_ATTR, el.style.getPropertyValue("background-color") || "");
    el.style.setProperty("background-color", lightened, "important");

    // Force text color to dark only if the site's current text color would
    // become unreadable after invert (i.e. it was a light color intended for
    // the original colored bg). For dark/medium text we leave it alone so
    // it naturally inverts to light.
    const tc = parseColor(cs.color);
    if (tc && tc.a > 0.2) {
      const tl = rgbToHsl(tc).l;
      if (tl > 0.55) {
        el.setAttribute(ORIG_COLOR_ATTR, el.style.getPropertyValue("color") || "");
        el.style.setProperty("color", "#1a1a1a", "important");
      }
    }
  }
  function revertPreLightened(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const els = scope.querySelectorAll(`[${ORIG_ATTR}]`);
    for (const el of els) {
      const orig = el.getAttribute(ORIG_ATTR);
      el.style.removeProperty("background-color");
      if (orig) el.style.setProperty("background-color", orig);
      el.removeAttribute(ORIG_ATTR);
      if (el.hasAttribute(ORIG_COLOR_ATTR)) {
        const origColor = el.getAttribute(ORIG_COLOR_ATTR);
        el.style.removeProperty("color");
        if (origColor) el.style.setProperty("color", origColor);
        el.removeAttribute(ORIG_COLOR_ATTR);
      }
    }
  }

  // Returns true if any visible (not display:none/hidden) direct or nested
  // child up to `depth` levels has a light opaque background. Used to detect
  // wrapper elements whose counter-filter would double-invert a white panel
  // inside them back to white (the cascade problem).
  function hasVisibleLightDescendant(el, depth) {
    for (const child of el.children) {
      let cs;
      try { cs = getComputedStyle(child); } catch (_) { continue; }
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0.4 && luminance(c) > 0.50) return true;
      if (depth > 1 && hasVisibleLightDescendant(child, depth - 1)) return true;
    }
    return false;
  }

  // Native-dark element detection: a child element with an already-dark,
  // near-neutral background (e.g. #10151b) shouldn't be inverted to white by
  // our page-level filter. Tag it so CSS re-inverts it back to dark.
  function tagNativeDarkBg(el, cs) {
    const c = parseColor(cs.backgroundColor);
    if (!c || c.a < 0.5) return false;
    if (el === document.documentElement || el === document.body) return false;
    // Prevent nested darknative filters — two stacked counter-filters create
    // unwanted triple-inversion on intermediate light-bg elements.
    if (hasNativeDarkAncestor(el)) return false;
    const lum = luminance(c);
    const sat = saturation(c);
    // Use the same adaptive saturation ceiling as isNeutralDark so that
    // chromatic near-black backgrounds (e.g. redis-ink-900 rgb(9,26,35),
    // lum≈0.009, sat≈0.59) are correctly tagged and not inverted to light.
    const maxSat = lum < 0.04 ? 0.80 : lum < 0.10 ? 0.45 : 0.25;
    if (lum < 0.10 && sat < maxSat) {
      // Don't tag a wrapper whose counter-filter would cascade and double-invert
      // a visible white child (e.g. tab-content panel inside a dark codetabs div).
      // Let the children be processed individually instead.
      if (hasVisibleLightDescendant(el, 3)) return false;
      el.setAttribute("data-darkabsolut-darknative", "1");
      return true;
    }
    return false;
  }

  // Form controls get browser-injected background-images (dropdown arrows,
  // spinners) that don't need separate re-inversion — the html-level filter
  // handles them correctly on its own.
  const SKIP_BG_IMAGE_TAGS = new Set(["SELECT", "INPUT", "TEXTAREA"]);

  function processElement(el) {
    if (!el || el.nodeType !== 1) return;
    try {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundImage;
      if (bg && bg !== "none" && /url\(|gradient\(/i.test(bg) &&
          !SKIP_BG_IMAGE_TAGS.has(el.tagName)) {
        el.setAttribute("data-darkabsolut-bg", "1");
      } else if (el.hasAttribute("data-darkabsolut-bg")) {
        el.removeAttribute("data-darkabsolut-bg");
      }
      if (tagNativeDarkBg(el, cs)) return;
      // No longer native-dark? remove stale marker.
      if (el.hasAttribute("data-darkabsolut-darknative")) {
        el.removeAttribute("data-darkabsolut-darknative");
      }
      preLightenIfSaturated(el, cs);
    } catch (_) { /* detached */ }
  }

  function markBackgroundImageElements(root) {
    // Tag elements whose computed style has a background-image so we can
    // re-invert them (CSS can't select that without JS help). Also pre-lighten
    // elements with saturated mid-lightness background-colors and re-invert
    // elements with natively-dark backgrounds.
    const scope = root || document;
    let i = 0;
    // Include the root itself when it's an Element (querySelectorAll("*")
    // only returns descendants). This is crucial for MutationObserver-added
    // nodes whose top-level is the styled element (e.g. a section with
    // background: var(--dark)).
    if (scope.nodeType === 1) {
      processElement(scope);
      i++;
    }
    const all = scope.querySelectorAll ? scope.querySelectorAll("*") : [];
    for (const el of all) {
      if (i++ > 5000) break; // safety cap on large DOMs
      processElement(el);
    }
  }

  let observer = null;
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "childList") {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1) markBackgroundImageElements(n);
          }
        } else if (m.type === "attributes" && m.target && m.target.nodeType === 1) {
          // class/style change can flip an element's resolved background
          // (e.g. CSS variable swap, theme class). Re-process this element.
          processElement(m.target);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"]
    });
  }
  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  function apply() {
    if (applied) return;
    ensureStyle();
    document.documentElement.setAttribute(ATTR, "on");
    // Run after first paint to mark bg-image elements.
    const run = () => { try { markBackgroundImageElements(document); } catch (_) {} };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
    startObserver();
    applied = true;
  }

  function unapply() {
    document.documentElement.removeAttribute(ATTR);
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    stopObserver();
    try { revertPreLightened(document); } catch (_) {}
    applied = false;
  }

  // ---- Decision flow --------------------------------------------------------
  // Strategy: optimistically pre-apply inversion at document_start so that
  // light pages never flash white. Then re-evaluate at multiple checkpoints
  // (stylesheet loads, DOMContentLoaded, load, and a few timed re-checks) and
  // toggle off if the site reveals itself to be already dark. Also watch for
  // theme-class flips on <html>/<body> and prefers-color-scheme changes.

  let evaluationScheduled = false;
  let stableDarkConfirmed = false; // once we are confident it IS dark, stop fighting
  let watchersStarted = false;
  let recheckTimers = [];

  function reevaluate() {
    if (!lastEnabledRequest) return; // disabled by user / global
    // Trust a dark verdict only once stylesheets are actually loaded.
    // Frameworks (Next.js, next-themes, etc.) often set color-scheme:dark or
    // data-theme="dark" on <html> during early hydration *before* the site's
    // light stylesheet has applied. Acting on that prematurely removes our
    // inversion and causes a flash to the site's real light theme.
    // Trust a declared dark color-scheme once the document has parsed (or any
    // stylesheets we can see are loaded). Gating only on allStylesheetsLoaded
    // is too strict on real sites where some analytics/deferred sheet never
    // reports a usable `.sheet` and we'd never trust the declaration.
    const docReady = document.readyState !== "loading";
    const stylesheetsReady = allStylesheetsLoaded() || docReady;
    let state = null;
    if (pageDeclaresDarkScheme()) {
      state = stylesheetsReady ? true : null;
    } else {
      try {
        const c = effectiveBgColor();
        if (c) state = isNeutralDark(c);
      } catch (_) { state = null; }
    }
    if (state === true) {
      stableDarkConfirmed = true;
      if (applied) unapply();
    } else if (state === false) {
      // Light (or unknown styled as default white) -> keep / apply inversion,
      // but only re-apply if we haven't been told it's stably dark.
      if (!applied && !stableDarkConfirmed) apply();
      else if (applied) ensureAttributeAndStyle();
    } else {
      // Unknown: while we believe we should be applied, make sure framework
      // hydration didn't strip our marker attribute / style node.
      if (applied) ensureAttributeAndStyle();
    }
  }

  function ensureAttributeAndStyle() {
    // Re-add our attribute / style if a framework (e.g. React hydration,
    // next-themes) wiped them while we still believe inversion should be on.
    if (document.documentElement.getAttribute(ATTR) !== "on") {
      document.documentElement.setAttribute(ATTR, "on");
    }
    if (!document.getElementById(STYLE_ID)) {
      ensureStyle();
    }
  }

  function startThemeWatchers() {
    if (watchersStarted) return;
    watchersStarted = true;

    // Re-check whenever a stylesheet finishes loading.
    const onAnyStyleLoad = () => reevaluate();
    document.addEventListener("load", (e) => {
      const t = e.target;
      if (t && (t.tagName === "LINK" || t.tagName === "STYLE")) onAnyStyleLoad();
    }, true);

    // Watch class/style mutations on <html> and <body> (theme toggles).
    // Also include our own ATTR so we self-heal if a framework removes it.
    const themeMo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "attributes" && m.attributeName === ATTR && m.target === document.documentElement) {
          if (applied && lastEnabledRequest) ensureAttributeAndStyle();
        }
      }
      reevaluate();
    });
    themeMo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", ATTR] });
    if (document.body) {
      themeMo.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        if (document.body) themeMo.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
      }, { once: true });
    }

    // Watch for newly added <link rel=stylesheet> nodes, and for removal of
    // our injected <style id="darkabsolut-style"> (frameworks sometimes
    // rewrite <head> during hydration).
    const linkMo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && (n.tagName === "LINK" || n.tagName === "STYLE")) {
            queueMicrotask(reevaluate);
            n.addEventListener && n.addEventListener("load", reevaluate, { once: true });
          }
        }
        for (const n of m.removedNodes) {
          if (n.nodeType === 1 && n.id === STYLE_ID && applied && lastEnabledRequest) {
            ensureAttributeAndStyle();
          }
        }
      }
    });
    linkMo.observe(document.documentElement, { childList: true, subtree: true });

    // OS / user color-scheme preference flip.
    try {
      const mq = matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener ? mq.addEventListener("change", reevaluate) : mq.addListener(reevaluate);
    } catch (_) {}

    // Lifecycle checkpoints.
    document.addEventListener("DOMContentLoaded", reevaluate, { once: true });
    window.addEventListener("load", reevaluate, { once: true });

    // Timed re-checks to catch JS-driven theming (frameworks hydrating, etc.).
    [200, 600, 1500, 3000, 6000, 10000].forEach(ms => {
      recheckTimers.push(setTimeout(reevaluate, ms));
    });
  }

  async function evaluateAndApply() {
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "GET_STATE_FOR_URL", url: location.href });
    } catch (_) { return; }
    if (!resp || !resp.ok) return;
    lastEnabledRequest = !!resp.enabled;
    if (!resp.enabled) { unapply(); return; }

    // Reset stable-dark memo when re-evaluating from scratch (e.g. SPA nav).
    stableDarkConfirmed = false;

    // 1) Pre-apply immediately to avoid a white flash on light sites. If a
    //    declared dark color-scheme is already detectable, skip pre-apply.
    if (pageDeclaresDarkScheme()) {
      stableDarkConfirmed = true;
      unapply();
    } else {
      apply();
    }

    // 2) Once the body exists, do an initial measurement and start watchers.
    const init = () => {
      reevaluate();
      startThemeWatchers();
    };
    if (document.body) init();
    else document.addEventListener("DOMContentLoaded", init, { once: true });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "STATE_UPDATED") {
      // Clear timers and re-run.
      recheckTimers.forEach(clearTimeout);
      recheckTimers = [];
      stableDarkConfirmed = false;
      evaluateAndApply();
    }
  });

  evaluateAndApply();
})();
