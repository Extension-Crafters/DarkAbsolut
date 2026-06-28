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
   Excludes light-icon-rescued glyphs (handled by the rule just below). */
html[${ATTR}="on"] svg:not([${DA.BG_IMAGE_ATTR}="1"]):not(:has(image)):not([${DA.LIGHT_ICON_ATTR}="1"]) {
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
    setImageInversionDisabled,
    setEnhanceContrast,
    applyShadowStyle,
    removeShadowStyle
  };
})(DA);
