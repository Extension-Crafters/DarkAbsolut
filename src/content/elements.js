// DarkAbsolut — per-element processing.
//
// Three responsibilities:
//   * tag elements with background-image so CSS can re-invert them,
//   * tag already-dark elements so they aren't flipped to white,
//   * pre-lighten saturated mid-lightness backgrounds so the page-level
//     invert actually darkens them (filters don't darken mid-saturation
//     colors much otherwise).

(function (DA) {
  "use strict";

  const {
    parseColor, luminance, rgbToHsl, hslToRgbString, nativeDarkMaxSat
  } = DA.colors;

  const {
    ORIG_ATTR, ORIG_COLOR_ATTR, BG_IMAGE_ATTR,
    NATIVE_DARK_ATTR, NATIVE_LIGHT_ATTR
  } = DA;

  // Minimum fraction of the viewport area a subtree must cover before we
  // tag it as a light island worth inverting. Below this threshold we let
  // small light widgets (dropdowns, tooltips, buttons) be — inverting them
  // creates more visual churn than value.
  const LIGHT_ISLAND_MIN_AREA_RATIO = 0.05;
  // Opaque background luminance above which an element's background is
  // considered "light". Matches the threshold used by detect.js sampling.
  const LIGHT_ISLAND_MIN_LUM = 0.80;

  // Form controls get browser-injected background-images (dropdown arrows,
  // spinners) that don't need re-inversion — the html-level filter is enough.
  const SKIP_BG_IMAGE_TAGS = new Set(["SELECT", "INPUT", "TEXTAREA"]);

  // Walk ancestors looking for a darknative-tagged container. Elements
  // inside such a container are already double-inverted back to their
  // original colors by the container's counter-filter, so pre-lightening
  // is both unnecessary and harmful (it compounds into a light artifact).
  function hasNativeDarkAncestor(el) {
    let cur = el.parentElement;
    while (cur && cur !== document.documentElement) {
      if (cur.hasAttribute(NATIVE_DARK_ATTR)) return true;
      cur = cur.parentElement;
    }
    return false;
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

  // Native-dark element: a child element with an already-dark, near-neutral
  // background shouldn't be flipped by our page-level filter. Tag it so
  // CSS re-inverts it back to dark.
  function tagNativeDarkBg(el, cs) {
    const c = parseColor(cs.backgroundColor);
    if (!c || c.a < 0.5) return false;
    if (el === document.documentElement || el === document.body) return false;
    // Prevent nested darknative filters — two stacked counter-filters create
    // unwanted triple-inversion on intermediate light-bg elements.
    if (hasNativeDarkAncestor(el)) return false;
    const lum = luminance(c);
    const maxSat = nativeDarkMaxSat(lum);
    const sat = DA.colors.saturation(c);
    if (lum < 0.10 && sat < maxSat) {
      // Don't tag a wrapper whose counter-filter would double-invert a
      // visible white child. Let the children be processed individually.
      if (hasVisibleLightDescendant(el, 3)) return false;
      el.setAttribute(NATIVE_DARK_ATTR, "1");
      return true;
    }
    return false;
  }

  // Saturated mid-lightness backgrounds (e.g. brand blue #459cd5, l~55%)
  // are barely darkened by `invert + hue-rotate(180)`. Pre-lighten the bg
  // to ~92% lightness so the html-level invert flips it to ~8% (true dark)
  // while preserving hue. Also force a dark text color if needed so the
  // invert produces readable light text over the new dark background.
  function preLightenIfSaturated(el, cs) {
    if (el.hasAttribute(ORIG_ATTR)) return;
    if (hasNativeDarkAncestor(el)) return;
    const c = parseColor(cs.backgroundColor);
    if (!c || c.a < 0.5) return;
    const hsl = rgbToHsl(c);
    if (hsl.l < 0.18) return; // dark — tagNativeDarkBg or filter handles it

    let targetS;
    if (hsl.s >= 0.30 && hsl.l <= 0.85) {
      // Saturated mid-lightness background.
      targetS = Math.min(hsl.s, 0.55);
    } else if (hsl.s >= 0.30 && hsl.l > 0.85) {
      // Near-white with a real color tint. Keep saturation so the hue
      // survives invert+hue-rotate and gives a clearly-hued dark result.
      targetS = Math.min(hsl.s, 0.60);
    } else if (hsl.s >= 0.05 && hsl.l >= 0.65 && hsl.l <= 0.88) {
      // Subtly-tinted light backgrounds (info boxes, light panels). Without
      // amplification the filter collapses them to near-neutral black.
      targetS = Math.min(hsl.s * 3.0, 0.45);
    } else {
      return; // near-grayscale or extreme lightness — filter is adequate
    }

    const lightened = hslToRgbString({ h: hsl.h, s: targetS, l: 0.92 });
    el.setAttribute(ORIG_ATTR, el.style.getPropertyValue("background-color") || "");
    el.style.setProperty("background-color", lightened, "important");

    // Only force dark text if the original text was light (would become
    // unreadable after invert). Dark/medium text inverts to light naturally.
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

  // Mean luminance of the (opaque-weighted) color stops in a CSS gradient
  // string. Computed styles always express stops as rgb()/rgba(), so a plain
  // scan over those is enough. Returns null when there are no usable stops or
  // the gradient is mostly transparent (an overlay/scrim rather than a solid
  // surface), in which case the caller should not treat it as light.
  function gradientMeanLuminance(bg) {
    const matches = bg.match(/rgba?\([^)]*\)/gi);
    if (!matches) return null;
    let sumL = 0, sumA = 0;
    for (const m of matches) {
      const c = parseColor(m);
      if (!c) continue;
      const a = c.a == null ? 1 : c.a;
      sumL += luminance(c) * a;
      sumA += a;
    }
    if (sumA < 0.5) return null; // mostly transparent — treat as overlay
    return sumL / sumA;
  }

  // Media tags whose pixels are counter-inverted by the page CSS so they show
  // their true colors. When one of these covers most of an element, that
  // element's gradient is just a fallback painted *behind* the image — the
  // image is the real visible surface.
  const MEDIA_SELECTOR = "img,video,canvas,picture,object,embed,svg";
  // Fraction of an element's area a single media descendant must cover for the
  // element to count as "image-fronted".
  const MEDIA_COVER_RATIO = 0.35;

  // True when the element's subtree contains any non-whitespace text. Used to
  // tell a content container (whose real identity is its text) from a bare
  // decorative tile. Short-circuits at the first non-space character.
  function hasTextContent(el) {
    try { return /\S/.test(el.textContent || ""); } catch (_) { return false; }
  }

  // True when a descendant image/video/etc. covers a large fraction of `el`.
  // Such an element must keep the counter-invert filter: dropping it would
  // leave the (separately counter-inverted) child media double-inverted back
  // to its true — often bright — colors, un-darkening the region. Only the
  // counter-invert on the container keeps that media dark (via triple-invert).
  function hasLargeMediaDescendant(el) {
    let rect;
    try { rect = el.getBoundingClientRect(); } catch (_) { return false; }
    const area = rect.width * rect.height;
    if (area <= 0) return false;
    let media;
    try { media = el.querySelectorAll(MEDIA_SELECTOR); } catch (_) { return false; }
    let i = 0;
    for (const m of media) {
      if (i++ > 200) break; // safety cap
      let r;
      try { r = m.getBoundingClientRect(); } catch (_) { continue; }
      if (r.width * r.height >= area * MEDIA_COVER_RATIO) return true;
    }
    return false;
  }

  // Decide whether an element with a background-image should receive the
  // counter-invert filter. The filter re-inverts the whole element
  // (including its rendered text), which is correct for panels whose visual
  // identity lives in the image (gradients on buttons, hero images). It is
  // WRONG for tiny decorative icons painted on an otherwise-transparent
  // element: the text gets reverted to its original color while the
  // transparent background shows the outer page's inverted (dark) color —
  // producing an unreadable original-color-on-dark combination.
  //
  // Heuristics:
  //   • CSS gradient:
  //       – a light, opaque, gradient-only background (decorative header /
  //         banner / panel gradient sitting behind text) is NOT tagged, so
  //         the page-level filter darkens it like any other light surface.
  //         Counter-inverting it would revert it to a bright strip in an
  //         otherwise-dark page — the "header reverts to light" bug.
  //       – a dark / mid-tone gradient (hero bars, brand buttons, dark nav)
  //         IS tagged so the counter-invert preserves its real colors.
  //       – a gradient combined with a url() image is image content → tag.
  //   • url() that tiles or fills the element (cover/contain/100% or a
  //     repeating pattern) → tag. The image defines the element's visual
  //     identity; re-invert keeps the intended colors.
  //   • url() with no-repeat and default (auto) size → treat as a
  //     decorative icon and DON'T tag, regardless of whether the element's
  //     background-color is opaque. Tagging such elements counter-inverts
  //     their whole subtree (including the text), producing native-color
  //     text on the root-inverted surrounding surface — unreadable and the
  //     cause of dark-on-dark sidebar items in dense tree UIs.
  // Gradients at or above this mean luminance count as "light surfaces" that
  // should be darkened by the page filter rather than counter-inverted.
  const LIGHT_GRADIENT_MIN_LUM = 0.5;

  function shouldReinvertBgImage(el, cs, bg) {
    const hasGradient = /gradient\(/i.test(bg);
    const hasUrl = /url\(/i.test(bg);
    if (hasGradient) {
      if (!hasUrl) {
        const meanLum = gradientMeanLuminance(bg);
        // The element reads as a "light surface" — to be darkened by the page
        // filter rather than counter-inverted back to a bright block — when:
        //   • the gradient itself is light (a decorative header/banner
        //     gradient sitting behind text), or
        //   • it is a light card with a merely-decorative gradient frame: an
        //     opaque light background-color whose light surface is confirmed by
        //     a visible light descendant (the inner content panel). Promo
        //     banners (e.g. Firefox Relay) paint a colourful gradient border on
        //     a white card; the gradient hides the bg-color, so we corroborate
        //     "is a light card" with the descendant before trusting it — this
        //     avoids darkening a real opaque gradient surface that merely
        //     declares a light fallback background-color.
        const lightGradient = meanLum != null && meanLum >= LIGHT_GRADIENT_MIN_LUM;
        const bc = parseColor(cs.backgroundColor);
        const lightCard = bc && bc.a >= 0.8 &&
          luminance(bc) >= LIGHT_GRADIENT_MIN_LUM &&
          hasVisibleLightDescendant(el, 3);
        // …but not when a large image fronts it — there the gradient is only a
        // fallback and dropping the counter-invert would un-darken the media.
        if ((lightGradient || lightCard) && !hasLargeMediaDescendant(el)) {
          return false;
        }
      }
      return true;
    }

    // url()-only case: decide by whether the image fills the element.
    const repeat = (cs.backgroundRepeat || "").toLowerCase();
    const size = (cs.backgroundSize || "").toLowerCase();
    const coversViewport = /cover|contain|100%/.test(size);
    const isRepeating = repeat && repeat !== "no-repeat";
    if (coversViewport) return true;

    if (isRepeating) {
      // A tiled/repeating background is almost always a decorative texture or
      // connector pattern (tree-guide lines, separators, subtle textures). If
      // the element also holds text, that text — not the tile — is its real
      // content: counter-inverting the whole subtree would revert every
      // descendant's text to its original (often dark) colour, making it
      // invisible on the dark page (e.g. phpRedisAdmin's `repeat-y` tree
      // <ul> hiding all key names). Let the page filter invert the tile
      // instead. Only counter-invert a bare decorative tile with no text.
      return !hasTextContent(el);
    }

    // Small decorative icon — leave it untouched so the root invert can
    // flip the text color normally.
    return false;
  }

  function processElement(el) {
    if (!el || el.nodeType !== 1) return;
    try {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundImage;
      const hasBgImage = bg && bg !== "none" && /url\(|gradient\(/i.test(bg) &&
          !SKIP_BG_IMAGE_TAGS.has(el.tagName);
      // "Force natural images" mode: when set on <html>, every element
      // with a background-image gets counter-inverted, bypassing the
      // shouldReinvertBgImage heuristic that would otherwise leave small
      // decorative bg-image elements inverted on this site.
      const forceImages =
        document.documentElement.hasAttribute(DA.NOIMG_ATTR);
      if (hasBgImage && (forceImages || shouldReinvertBgImage(el, cs, bg))) {
        el.setAttribute(BG_IMAGE_ATTR, "1");
      } else if (el.hasAttribute(BG_IMAGE_ATTR)) {
        el.removeAttribute(BG_IMAGE_ATTR);
      }
      if (tagNativeDarkBg(el, cs)) return;
      if (el.hasAttribute(NATIVE_DARK_ATTR)) {
        el.removeAttribute(NATIVE_DARK_ATTR);
      }
      preLightenIfSaturated(el, cs);
    } catch (_) { /* detached */ }
  }

  function markBackgroundImageElements(root) {
    const scope = root || document;
    let i = 0;
    // Include the root itself when it's an Element; querySelectorAll("*")
    // returns only descendants. Crucial for MutationObserver-added nodes.
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

  // ── Light-island tagging (used on already-dark pages) ────────────────
  // On a page whose overall theme is dark, large light subtrees injected
  // by application JS (Gmail compose dialog, message reading iframes,
  // modal popups with white cards, etc.) look jarringly bright and have
  // unreadable dark-on-dark text after the user's OS/site dark theme
  // propagates. We tag such subtrees so CSS (styles.js) can invert them
  // locally without touching the rest of the page.

  function hasLightIslandAncestor(el) {
    let cur = el.parentElement;
    while (cur && cur !== document.documentElement) {
      if (cur.hasAttribute(NATIVE_LIGHT_ATTR)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // True if `el` has an opaque, near-neutral light background.
  function hasOpaqueLightBg(cs) {
    const c = parseColor(cs.backgroundColor);
    if (!c || c.a < 0.7) return false;
    if (luminance(c) < LIGHT_ISLAND_MIN_LUM) return false;
    // Skip very saturated tints — those are accent surfaces, not a
    // neutral "white card" we want to darken.
    if (DA.colors.saturation(c) > 0.30) return false;
    return true;
  }

  // Consider tagging this single element as a light island.
  function tryTagLightIsland(el, viewportArea) {
    if (!el || el.nodeType !== 1) return false;
    if (el === document.documentElement || el === document.body) return false;
    if (el.hasAttribute(NATIVE_LIGHT_ATTR)) return false;
    if (hasLightIslandAncestor(el)) return false;

    let cs;
    try { cs = getComputedStyle(el); } catch (_) { return false; }
    if (cs.display === "none" || cs.visibility === "hidden") return false;

    let rect;
    try { rect = el.getBoundingClientRect(); } catch (_) { return false; }
    const area = rect.width * rect.height;
    if (area < viewportArea * LIGHT_ISLAND_MIN_AREA_RATIO) return false;

    // Same-origin iframes: the iframe element itself is usually
    // transparent; inspect its document body to decide.
    if (el.tagName === "IFRAME") {
      try {
        const doc = el.contentDocument;
        if (doc && doc.body) {
          const bcs = getComputedStyle(doc.body);
          const bc = parseColor(bcs.backgroundColor);
          // Treat missing/transparent body bg as white (browser default).
          const effective = (bc && bc.a > 0.5)
            ? bc : { r: 255, g: 255, b: 255, a: 1 };
          if (luminance(effective) >= LIGHT_ISLAND_MIN_LUM) {
            el.setAttribute(NATIVE_LIGHT_ATTR, "1");
            return true;
          }
        }
      } catch (_) { /* cross-origin — cannot inspect */ }
      return false;
    }

    if (!hasOpaqueLightBg(cs)) return false;
    el.setAttribute(NATIVE_LIGHT_ATTR, "1");
    return true;
  }

  // From a given starting element, walk up the DOM and return the
  // outermost ancestor whose computed background is opaque and light.
  // Used to find the visually-dominant light container at a viewport
  // probe point even when it sits deep in the tree.
  function outermostLightAncestor(start) {
    let candidate = null;
    let cur = start;
    while (cur && cur.nodeType === 1 &&
           cur !== document.body && cur !== document.documentElement) {
      let cs;
      try { cs = getComputedStyle(cur); } catch (_) { break; }
      if (cs.display !== "none" && cs.visibility !== "hidden" &&
          hasOpaqueLightBg(cs)) {
        candidate = cur;
      }
      cur = cur.parentElement;
    }
    return candidate;
  }

  // Probe a viewport point and tag the largest light ancestor at that
  // location. Indispensable for app-shell pages (Gmail, Outlook, Slack)
  // where the visible white content panel sits beyond any practical
  // bulk-scan cap because of the size of the surrounding chrome tree.
  function tagLightIslandAtPoint(x, y, viewportArea) {
    let el;
    try { el = document.elementFromPoint(x, y); } catch (_) { return false; }
    if (!el) return false;
    const candidate = outermostLightAncestor(el);
    if (!candidate) return false;
    return tryTagLightIsland(candidate, viewportArea);
  }

  // Scan a subtree for light islands. Called from the controller when
  // root inversion is NOT applied (page detected as already-dark) so the
  // CSS rule html:not([data-darkabsolut="on"]) ... can take effect.
  function tagLightIslands(root) {
    const W = window.innerWidth | 0;
    const H = window.innerHeight | 0;
    const viewportArea = W * H;
    if (viewportArea < 10000) return;

    const scope = root && root.nodeType === 1 ? root : document.body;
    if (!scope) return;

    // Check the scope root itself first so a freshly-inserted subtree
    // whose own root matches gets tagged without scanning its descendants.
    if (tryTagLightIsland(scope, viewportArea)) return;

    const all = scope.querySelectorAll ? scope.querySelectorAll("*") : [];
    let i = 0;
    for (const el of all) {
      if (i++ > 5000) break; // safety cap
      tryTagLightIsland(el, viewportArea);
    }

    // Targeted probes — when the bulk walk hits its cap before reaching
    // a deeply-nested visible white panel (Gmail message reading-pane,
    // modal dialogs, etc.), elementFromPoint finds it directly. Only
    // probe when the scope is the whole document; per-subtree mutation
    // calls don't need this and shouldn't hijack the global viewport.
    if (scope === document.body || scope === document.documentElement) {
      const probes = [
        [W >> 1, H >> 1],         // viewport center
        [Math.floor(W * 0.66), H >> 1], // right-of-center (sidebar layouts)
        [W >> 1, Math.floor(H * 0.4)]   // upper-center
      ];
      for (const [x, y] of probes) {
        tagLightIslandAtPoint(x, y, viewportArea);
      }
    }
  }

  function clearLightIslands(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const els = scope.querySelectorAll(`[${NATIVE_LIGHT_ATTR}]`);
    for (const el of els) el.removeAttribute(NATIVE_LIGHT_ATTR);
  }

  DA.elements = {
    hasNativeDarkAncestor,
    hasVisibleLightDescendant,
    tagNativeDarkBg,
    preLightenIfSaturated,
    revertPreLightened,
    processElement,
    markBackgroundImageElements,
    tagLightIslands,
    clearLightIslands
  };
})(DA);
