// DarkAbsolut — CSS generation and injection.
//
// The inversion technique is a single page-level CSS filter that flips
// the whole document. Media and explicitly-tagged elements get a
// counter-filter so their colors survive correctly.

(function (DA) {
  "use strict";

  function buildInversionCss() {
    const ATTR = DA.ATTR;
    return `
html[${ATTR}="on"] {
  filter: invert(1) hue-rotate(180deg) !important;
}
/* Soft dark-gray contrast variant (per-site opt-in): lift pure black to dark
   gray so the inverted page keeps visual depth instead of flattening to black.
   contrast(<1) raises blacks (white → ~#1a1a1a, black → ~off-white). Higher
   specificity than the base rule so it wins when the attribute is set. Tunable. */
html[${ATTR}="on"][${DA.HC_ATTR}="1"] {
  filter: invert(1) hue-rotate(180deg) contrast(0.8) !important;
}
/* Zero-specificity fallback bg: any site rule (e.g. html.dark { background })
   wins so effectiveBgColor() can read the real native bg and detect dark.
   A higher-specificity override on <html> would mask the site's real
   background and break dark-detection on sites where the dark color is set
   via html.dark{background:...} while <body> stays bg-white. */
:where(html[${ATTR}="on"]) {
  background-color: #ffffff;
}
/* NOTE: do NOT include <picture> here. <picture> is a wrapper around its
   child <img>; if both get the counter-filter the inversion is applied
   twice on the rendered image, which combined with the page-level filter
   on <html> compounds to an odd-numbered total invert and the photo
   ends up looking like a color negative on responsive-image sites
   (airbnb, instagram, modern news sites). The <img> rule alone covers
   it correctly. */
html[${ATTR}="on"] img,
html[${ATTR}="on"] video,
html[${ATTR}="on"] embed,
html[${ATTR}="on"] object,
html[${ATTR}="on"] canvas,
html[${ATTR}="on"] svg image,
html[${ATTR}="on"] [${DA.BG_IMAGE_ATTR}="1"],
html[${ATTR}="on"] [${DA.NATIVE_DARK_ATTR}="1"] {
  filter: invert(1) hue-rotate(180deg) !important;
}
/* Avoid double-inverting svg icons that use currentColor (treat as text).
   Excludes light-icon-rescued and accent glyphs (handled by the rules below). */
html[${ATTR}="on"] svg:not([${DA.BG_IMAGE_ATTR}="1"]):not(:has(image)):not([${DA.LIGHT_ICON_ATTR}="1"]):not([${DA.ACCENT_ATTR}="1"]) {
  filter: none !important;
}
/* Colour-coded UI glyphs (rating-star sprites, coloured status icons), tagged by
   elements.js. The SVG accent filter (buildAccentFilter below) runs BEFORE the
   page filter: neutral pixels pass through untouched, so the page invert flips
   them like text (an empty light-gray star → a faint dark one), while bright
   chromatic pixels are darkened just enough that the page filter mirrors them
   back to a lit accent of their own hue (a gold star stays gold, not brown — nor
   pale peach, which is all the counter-invert can restore). A sampled light-icon
   rescue wins (Gmail's prefers-dark glyphs). */
html[${ATTR}="on"] [${DA.ACCENT_ATTR}="1"]:not([${DA.LIGHT_ICON_ATTR}="1"]) {
  filter: url("#${DA.ACCENT_FILTER_ID}") !important;
}
/* A large LIGHT canvas the user navigates (Google Maps' light map tiles),
   tagged by elements.js::classifyMapCanvas. The blanket canvas counter-invert
   above keeps such a canvas at its true (bright) colours on the dark page;
   dropping the counter-invert (filter:none) lets the page-level invert darken it
   WITH the theme. A canvas that samples DARK is left untagged, so it keeps the
   counter-invert (true colours). Higher specificity than the blanket rule. */
html[${ATTR}="on"] canvas[${DA.INVERT_MEDIA_ATTR}="1"] {
  filter: none !important;
}
/* Light-icon rescue: a glyph that is ALREADY light (a prefers-dark icon on a
   light-themed page — e.g. Gmail's header/nav on an OS that prefers dark) would
   be flipped to black-on-dark by the page invert. Counter-invert it so it stays
   light. Tags: vector SVGs (classifyLightIconSvg) and small background-image
   glyphs whose sampled pixels are light (classifyLightBgIcon — covers Gmail's
   cross-origin gstatic label/folder sprites). */
html[${ATTR}="on"] [${DA.LIGHT_ICON_ATTR}="1"] {
  filter: invert(1) hue-rotate(180deg) !important;
}
/* An <img> whose real content is a CSS background-image over a 1×1 placeholder
   src (the phpMyAdmin icon pattern). The blanket img counter-invert keeps that
   background at its original colour — fine for LIGHT icons (pmahomme), but for
   DARK icons (e.g. the bootstrap theme) it leaves them dark-on-dark. elements.js
   samples each icon's actual pixels and tags only the DARK ones here, so they
   invert with the theme (dark → light) while light icons keep their counter-
   invert. Sampling is what makes this safe across themes. */
html[${ATTR}="on"] img[${DA.BG_ICON_ATTR}="1"] { filter: none !important; }
/* Media inside a darknative (kept-dark) wrapper must NOT also be counter-
   inverted. The wrapper's own invert already restores its whole subtree to the
   original rendering, so a SECOND counter-invert on the media makes a third
   total inversion → a colour-negative photo/icon. This is what flipped images
   inside natively-dark sections (logos in the KYM header; a beach/island photo
   beside a hero illustration) even with "natural images" on. With this rule the
   wrapper keeps the region dark while its media shows true colours. More
   specific than the blanket counter-invert rules above, so it wins. */
html[${ATTR}="on"] [${DA.NATIVE_DARK_ATTR}="1"] img,
html[${ATTR}="on"] [${DA.NATIVE_DARK_ATTR}="1"] video,
html[${ATTR}="on"] [${DA.NATIVE_DARK_ATTR}="1"] embed,
html[${ATTR}="on"] [${DA.NATIVE_DARK_ATTR}="1"] object,
html[${ATTR}="on"] [${DA.NATIVE_DARK_ATTR}="1"] canvas,
html[${ATTR}="on"] [${DA.NATIVE_DARK_ATTR}="1"] svg image,
html[${ATTR}="on"] [${DA.NATIVE_DARK_ATTR}="1"] [${DA.BG_IMAGE_ATTR}="1"] {
  filter: none !important;
}
/* …but a dark bg-fronted ICON inside a kept-dark wrapper still needs ONE
   counter-invert to stay visible: the wrapper's invert + the page invert are
   even (icon would render dark-on-dark). Give it back its counter-invert so
   the dark glyph flips light. More specific than the rule above (extra
   [darknative] ancestor), so it wins. */
html[${ATTR}="on"] [${DA.NATIVE_DARK_ATTR}="1"] img[${DA.BG_ICON_ATTR}="1"] {
  filter: invert(1) hue-rotate(180deg) !important;
}
/* ── Low-contrast text rescue ─────────────────────────────────────────────
   Force text that would otherwise render dark-on-dark to render light.
   Applied via an attribute + CSS rule (NEVER inline style) so it cannot churn
   the style-watching MutationObserver into an infinite re-process loop that
   freezes the page. Tagged by elements.js::rescueTextColor:
     "1" = normally-inverted element — set a near-black the page filter flips
           to light; "2" = counter-inverted element — renders as-is, set light.
   Scoped with :not(:hover) so we DEFER to the site's own hover styling: on
   hover the site swaps in its own background + text colour (a contrasting pair
   it designed), which renders readably through the inversion. Without this our
   forced light text lands on the hover background (often light) = unreadable
   light-on-light (the OVH Manager flyout hover bug). */
html[${ATTR}="on"] [${DA.RESCUE_COLOR_ATTR}="1"]:not(:hover) { color: #141414 !important; }
html[${ATTR}="on"] [${DA.RESCUE_COLOR_ATTR}="2"]:not(:hover) { color: #ededed !important; }
/* Colour-coded text (a gold ★, an amber label) is rescued along its OWN hue —
   value "c<hex>", one generated rule per colour in use (see textPaletteCss). A
   neutral rescue would turn every star of a rating the same white. */
${textPaletteCss()}
/* Form fields rescued for low contrast. Two differences from the generic rule
   above: (1) cover the ::placeholder pseudo-element, which the bare color rule
   can't reach when the site sets an explicit placeholder colour (Gmail's search
   box); (2) do NOT defer on hover — unlike a menu item, a field's background
   doesn't swap on hover, so deferring would flash the value/placeholder back to
   unreadable while you point at the search box. These (no :not(:hover)) win on
   hover, where the generic rule above is inactive. */
html[${ATTR}="on"] input[${DA.RESCUE_COLOR_ATTR}="1"],
html[${ATTR}="on"] textarea[${DA.RESCUE_COLOR_ATTR}="1"],
html[${ATTR}="on"] input[${DA.RESCUE_COLOR_ATTR}="1"]::placeholder,
html[${ATTR}="on"] textarea[${DA.RESCUE_COLOR_ATTR}="1"]::placeholder { color: #141414 !important; }
html[${ATTR}="on"] input[${DA.RESCUE_COLOR_ATTR}="2"],
html[${ATTR}="on"] textarea[${DA.RESCUE_COLOR_ATTR}="2"],
html[${ATTR}="on"] input[${DA.RESCUE_COLOR_ATTR}="2"]::placeholder,
html[${ATTR}="on"] textarea[${DA.RESCUE_COLOR_ATTR}="2"]::placeholder { color: #ededed !important; }
/* ── Light islands on already-dark pages ─────────────────────────────────
   When the page is detected as already-dark we leave the root filter off
   so the site's dark theme is preserved. But dynamically-mounted light
   subtrees (e.g. Gmail message iframes, the "New message" compose dialog)
   need their own local inversion so their content is readable. Tagged by
   elements.js::tagLightIslands. Rules only fire when root is OFF to
   avoid double-inversion on light pages. */
html:not([${ATTR}="on"]) [${DA.NATIVE_LIGHT_ATTR}="1"] {
  filter: invert(1) hue-rotate(180deg) !important;
}
/* Re-invert media and bg-image descendants inside light islands so
   photos, icons and decorative imagery keep their real colors. */
html:not([${ATTR}="on"]) [${DA.NATIVE_LIGHT_ATTR}="1"] img,
html:not([${ATTR}="on"]) [${DA.NATIVE_LIGHT_ATTR}="1"] video,
html:not([${ATTR}="on"]) [${DA.NATIVE_LIGHT_ATTR}="1"] embed,
html:not([${ATTR}="on"]) [${DA.NATIVE_LIGHT_ATTR}="1"] object,
html:not([${ATTR}="on"]) [${DA.NATIVE_LIGHT_ATTR}="1"] canvas,
html:not([${ATTR}="on"]) [${DA.NATIVE_LIGHT_ATTR}="1"] svg image,
html:not([${ATTR}="on"]) [${DA.NATIVE_LIGHT_ATTR}="1"] [${DA.BG_IMAGE_ATTR}="1"] {
  filter: invert(1) hue-rotate(180deg) !important;
}
html:not([${ATTR}="on"]) [${DA.NATIVE_LIGHT_ATTR}="1"] svg:not([${DA.BG_IMAGE_ATTR}="1"]):not(:has(image)) {
  filter: none !important;
}
`;
  }

  // ── Hue-keeping text rescue palette ──────────────────────────────────────
  // Colours are picked per element by elements.js (DA.colors.accentTextSource)
  // but applied through the injected stylesheet — never inline style, which
  // would churn the style-watching observer (see the rescue notes in
  // buildInversionCss).
  const textPalette = new Set();
  const TEXT_PALETTE_MAX = 256;
  let paletteFlushQueued = false;

  function textPaletteCss() {
    let css = "";
    for (const hex of textPalette) {
      css += `html[${DA.ATTR}="on"] [${DA.RESCUE_COLOR_ATTR}="c${hex}"]:not(:hover) { color: #${hex} !important; }\n`;
    }
    return css;
  }

  // Make the rescue value "c<hex>" usable. Returns false when the palette is
  // full (the caller falls back to the neutral rescue). New colours reach the
  // stylesheet in one batched rewrite per task.
  function requestTextColor(hex) {
    if (textPalette.has(hex)) return true;
    if (textPalette.size >= TEXT_PALETTE_MAX) return false;
    textPalette.add(hex);
    if (!paletteFlushQueued) {
      paletteFlushQueued = true;
      queueMicrotask(() => {
        paletteFlushQueued = false;
        // Only refresh a mounted sheet: a flush landing after disableForPage()
        // must not resurrect the stylesheet.
        const style = document.getElementById(DA.STYLE_ID);
        if (style) style.textContent = buildInversionCss();
      });
    }
    return true;
  }

  // ── SVG accent filter ────────────────────────────────────────────────────
  // Per pixel, BEFORE the page filter F (out = in + 1 − 2·Lf; colors.js):
  //   κ   = chroma ramp, 0 for neutrals … 1 for colourful pixels, from
  //         |R−G| + |G−B| + |B−R| (= 2·chroma);
  //   u   = max(0, min(2Lf − 1, Lf − (1 − ACCENT_LUMA))), Lf = F's own luma:
  //         how far a BRIGHT pixel's luma must drop for F to mirror it to
  //         ~ACCENT_LUMA rather than to 1 − Lf (0 whenever Lf ≤ 0.5, i.e. for
  //         every colour F already renders light);
  //   out = SetLum(in, Lb − κ·u) — feBlend "luminosity" (Lb = blend-mode luma)
  //         shifts all channels by −κ·u, which lowers Lf by exactly κ·u too
  //         (both weight sets sum to 1), and clips chroma into gamut keeping
  //         the hue (plain arithmetic would clamp channels and drift it).
  // κ·u = 0 → SetLum(in, Lb) = in: exact identity, so neutral pixels and
  // dark/mid colours render just as with the plain page filter.
  // Intermediates are kept opaque (unpremultiplied); the source alpha is
  // re-applied at the end.
  const SVG_NS = "http://www.w3.org/2000/svg";
  let filterDefsWanted = false;

  function svgEl(tag, attrs, children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (children) for (const c of children) el.appendChild(c);
    return el;
  }

  function accentTables() {
    const { ACCENT_LUMA, ACCENT_CHROMA_MIN, ACCENT_CHROMA_FULL } = DA.colors;
    const u = [];
    for (let i = 0; i <= 50; i++) {
      const L = i / 50;
      u.push(+Math.max(0, Math.min(2 * L - 1, L - (1 - ACCENT_LUMA))).toFixed(4));
    }
    const span = ACCENT_CHROMA_FULL - ACCENT_CHROMA_MIN;
    return { u: u.join(" "), kc: +(0.5 / span).toFixed(4), ko: +(-ACCENT_CHROMA_MIN / span).toFixed(4) };
  }

  function buildAccentFilter() {
    const { u, kc, ko } = accentTables();
    const rgbTable = (vals, attrs) => svgEl("feComponentTransfer", attrs, ["feFuncR", "feFuncG", "feFuncB"]
      .map(f => svgEl(f, { type: "table", tableValues: vals })));
    const lumRow = "0.3 0.59 0.11 0 0";      // blend-mode luma (SetLum's)
    const fLumRow = "0.213 0.715 0.072 0 0"; // page-filter luma (hue-rotate's)
    const kRow = `${kc} ${kc} ${kc} 0 ${ko}`;
    return svgEl("filter", { id: DA.ACCENT_FILTER_ID, "color-interpolation-filters": "sRGB" }, [
      svgEl("feColorMatrix", { in: "SourceGraphic", type: "matrix", result: "src",
        values: "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1" }),
      svgEl("feColorMatrix", { in: "src", type: "matrix", result: "lum",
        values: `${lumRow}  ${lumRow}  ${lumRow}  0 0 0 0 1` }),
      svgEl("feColorMatrix", { in: "src", type: "matrix", result: "flum",
        values: `${fLumRow}  ${fLumRow}  ${fLumRow}  0 0 0 0 1` }),
      rgbTable(u, { in: "flum", result: "u" }),
      svgEl("feColorMatrix", { in: "src", type: "matrix", result: "diff",
        values: "0.5 -0.5 0 0 0.5  0 0.5 -0.5 0 0.5  -0.5 0 0.5 0 0.5  0 0 0 0 1" }),
      rgbTable("1 0 1", { in: "diff", result: "adiff" }),
      svgEl("feColorMatrix", { in: "adiff", type: "matrix", result: "kappa",
        values: `${kRow}  ${kRow}  ${kRow}  0 0 0 0 1` }),
      svgEl("feComposite", { in: "kappa", in2: "u", operator: "arithmetic",
        k1: "1", k2: "0", k3: "0", k4: "0", result: "ku" }),
      // 1 − κu, then Lb + (1 − κu) − 1: every arithmetic step keeps alpha at 1.
      rgbTable("1 0", { in: "ku", result: "w" }),
      svgEl("feComposite", { in: "lum", in2: "w", operator: "arithmetic",
        k1: "0", k2: "1", k3: "1", k4: "-1", result: "lg" }),
      svgEl("feBlend", { in: "lg", in2: "src", mode: "luminosity", result: "lit" }),
      svgEl("feComposite", { in: "lit", in2: "SourceGraphic", operator: "in" })
    ]);
  }

  // Mount the accent filter once an element needs it (most pages never do).
  // Built with DOM APIs, not innerHTML, so Trusted-Types pages accept it; not
  // display:none (Firefox drops filters defined in undisplayed SVG).
  function ensureFilterDefs() {
    filterDefsWanted = true;
    if (document.getElementById(DA.FILTER_DEFS_ID)) return;
    const root = document.documentElement;
    if (!root) return;
    const svg = svgEl("svg", {
      id: DA.FILTER_DEFS_ID, width: "0", height: "0", "aria-hidden": "true", focusable: "false",
      style: "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none"
    }, [buildAccentFilter()]);
    root.appendChild(svg);
  }

  function removeFilterDefs() {
    filterDefsWanted = false;
    const svg = document.getElementById(DA.FILTER_DEFS_ID);
    if (svg) svg.remove();
  }

  function ensureStyle() {
    let style = document.getElementById(DA.STYLE_ID);
    const css = buildInversionCss();
    if (!style) {
      style = document.createElement("style");
      style.id = DA.STYLE_ID;
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    } else if (style.textContent !== css) {
      // Existing style was generated by an older version of the
      // extension (e.g. after an in-place upgrade). Replace it so the
      // current selectors / per-site flags actually take effect.
      style.textContent = css;
    }
    return style;
  }

  // Desired soft-dark-gray state for this page; re-applied on self-heal so a
  // framework that resets <html> attributes doesn't silently drop it.
  let enhanceContrastOn = false;

  // Re-add our attribute / style node if a framework (e.g. React hydration,
  // next-themes) wiped them while we still believe inversion should be on.
  function ensureAttributeAndStyle() {
    if (document.documentElement.getAttribute(DA.ATTR) !== "on") {
      document.documentElement.setAttribute(DA.ATTR, "on");
    }
    if (enhanceContrastOn && document.documentElement.getAttribute(DA.HC_ATTR) !== "1") {
      document.documentElement.setAttribute(DA.HC_ATTR, "1");
    }
    if (!document.getElementById(DA.STYLE_ID)) {
      ensureStyle();
    }
    if (filterDefsWanted && !document.getElementById(DA.FILTER_DEFS_ID)) {
      ensureFilterDefs();
    }
  }

  // Toggle the per-site "don't invert images" flag on <html>. The CSS
  // selectors above key off this attribute so the change is purely
  // declarative — no per-element work needed.
  function setImageInversionDisabled(disabled) {
    const html = document.documentElement;
    if (!html) return;
    if (disabled) html.setAttribute(DA.NOIMG_ATTR, "1");
    else html.removeAttribute(DA.NOIMG_ATTR);
  }

  // Toggle the soft-dark-gray contrast flag on <html>. The CSS rule keyed off
  // this attribute (gated on the inversion being active) does the rest.
  function setEnhanceContrast(on) {
    enhanceContrastOn = !!on;
    const html = document.documentElement;
    if (!html) return;
    if (enhanceContrastOn) html.setAttribute(DA.HC_ATTR, "1");
    else html.removeAttribute(DA.HC_ATTR);
  }

  // ── Shadow DOM support ───────────────────────────────────────────────────
  // The page-level `filter: invert()` on <html> inverts everything it paints —
  // including content inside shadow roots. But the counter-invert rules above
  // live in the document's stylesheet and CSS does not cross shadow boundaries,
  // so media inside a shadow root (e.g. ad/sponsored web components) is inverted
  // once with no counter-invert → a colour-negative image. We fix this by
  // adopting an equivalent, shadow-scoped stylesheet into each shadow root.
  function buildShadowCss() {
    return `
img, video, embed, object, canvas, svg image,
[${DA.BG_IMAGE_ATTR}="1"], [${DA.NATIVE_DARK_ATTR}="1"] {
  filter: invert(1) hue-rotate(180deg) !important;
}
svg:not([${DA.BG_IMAGE_ATTR}="1"]):not(:has(image)):not([${DA.LIGHT_ICON_ATTR}="1"]) { filter: none !important; }
canvas[${DA.INVERT_MEDIA_ATTR}="1"] { filter: none !important; }
[${DA.LIGHT_ICON_ATTR}="1"] { filter: invert(1) hue-rotate(180deg) !important; }
img[${DA.BG_ICON_ATTR}="1"] { filter: none !important; }
[${DA.NATIVE_DARK_ATTR}="1"] img,
[${DA.NATIVE_DARK_ATTR}="1"] video,
[${DA.NATIVE_DARK_ATTR}="1"] embed,
[${DA.NATIVE_DARK_ATTR}="1"] object,
[${DA.NATIVE_DARK_ATTR}="1"] canvas,
[${DA.NATIVE_DARK_ATTR}="1"] svg image,
[${DA.NATIVE_DARK_ATTR}="1"] [${DA.BG_IMAGE_ATTR}="1"] {
  filter: none !important;
}
[${DA.NATIVE_DARK_ATTR}="1"] img[${DA.BG_ICON_ATTR}="1"] {
  filter: invert(1) hue-rotate(180deg) !important;
}
`;
  }

  let shadowSheet = null;
  function getShadowSheet() {
    if (shadowSheet) return shadowSheet;
    try {
      shadowSheet = new CSSStyleSheet();
      shadowSheet.replaceSync(buildShadowCss());
    } catch (_) {
      shadowSheet = null; // constructable stylesheets unsupported — caller falls back
    }
    return shadowSheet;
  }

  // Make a shadow root re-invert its media. Prefers adoptedStyleSheets; falls
  // back to appending a <style> node when constructable stylesheets are absent.
  function applyShadowStyle(root) {
    if (!root) return;
    const sheet = getShadowSheet();
    if (sheet && Array.isArray(root.adoptedStyleSheets)) {
      if (!root.adoptedStyleSheets.includes(sheet)) {
        try { root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]; return; }
        catch (_) { /* fall through to <style> */ }
      } else { return; }
    }
    if (!root.getElementById || !root.getElementById(DA.STYLE_ID)) {
      try {
        const s = document.createElement("style");
        s.id = DA.STYLE_ID;
        s.textContent = buildShadowCss();
        root.appendChild(s);
      } catch (_) {}
    }
  }

  function removeShadowStyle(root) {
    if (!root) return;
    try {
      if (shadowSheet && Array.isArray(root.adoptedStyleSheets)) {
        root.adoptedStyleSheets = root.adoptedStyleSheets.filter(s => s !== shadowSheet);
      }
      const s = root.getElementById && root.getElementById(DA.STYLE_ID);
      if (s) s.remove();
    } catch (_) {}
  }

  DA.styles = {
    buildInversionCss,
    ensureStyle,
    ensureAttributeAndStyle,
    requestTextColor,
    ensureFilterDefs,
    removeFilterDefs,
    setImageInversionDisabled,
    setEnhanceContrast,
    applyShadowStyle,
    removeShadowStyle
  };
})(DA);
