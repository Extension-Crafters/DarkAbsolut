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
    ORIG_ATTR, ORIG_COLOR_ATTR, BG_IMAGE_ATTR, BG_ICON_ATTR,
    NATIVE_DARK_ATTR, NATIVE_LIGHT_ATTR, RESCUE_COLOR_ATTR
  } = DA;

  // Minimum fraction of the viewport area a subtree must cover before we
  // tag it as a light island worth inverting. Below this threshold we let
  // small light widgets (dropdowns, tooltips, buttons) be — inverting them
  // creates more visual churn than value.
  const LIGHT_ISLAND_MIN_AREA_RATIO = 0.05;
  // Opaque background luminance above which an element's background is
  // considered "light". Matches the threshold used by detect.js sampling.
  const LIGHT_ISLAND_MIN_LUM = 0.80;
  // Fraction of a dark wrapper a light child must cover before it blocks
  // counter-inverting that wrapper. The guard exists for "dark frame around a
  // large white content panel" (tagging would keep the panel white in dark
  // mode). A small light widget — a divider strip, a search box, a badge —
  // inside a big dark footer/section should NOT veto the whole wrapper: doing
  // so flips the entire dark area to light (mesepices footer: a 9.7% white
  // strip was turning the whole 1280×595 footer light).
  const LIGHT_CHILD_VETO_RATIO = 0.5;

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
  // child up to `depth` levels has a light opaque background that is LARGE
  // enough (>= `minArea` px²) to dominate the wrapper. Used to detect wrapper
  // elements whose counter-filter would double-invert a white panel inside
  // them back to white (the cascade problem). A small light widget doesn't
  // count — see LIGHT_CHILD_VETO_RATIO.
  function hasVisibleLightDescendant(el, depth, minArea) {
    for (const child of el.children) {
      let cs;
      try { cs = getComputedStyle(child); } catch (_) { continue; }
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0.4 && luminance(c) > 0.50) {
        if (!minArea) return true;
        let r; try { r = child.getBoundingClientRect(); } catch (_) { r = null; }
        if (r && r.width * r.height >= minArea) return true;
      }
      if (depth > 1 && hasVisibleLightDescendant(child, depth - 1, minArea)) return true;
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
      // Don't tag a wrapper whose counter-filter would double-invert a LARGE
      // visible white panel (a dark frame around light content). A small light
      // widget inside a big dark wrapper must not veto tagging — otherwise the
      // whole dark area flips to light. Scale the veto to the wrapper's size.
      let wrapperArea = 0;
      try { const r = el.getBoundingClientRect(); wrapperArea = r.width * r.height; } catch (_) {}
      const minLightArea = wrapperArea * LIGHT_CHILD_VETO_RATIO;
      if (hasVisibleLightDescendant(el, 3, minLightArea)) return false;
      // Don't tag a wrapper that fronts large RASTER media. That media is
      // counter-inverted by its own rule; wrapping it in another counter-invert
      // triple-inverts it into a colour-negative — e.g. an image carousel whose
      // dark placeholder background made the wrapper look "natively dark", which
      // then flipped every restaurant photo inside it (TripAdvisor cards). The
      // wrapper's dark bg is hidden behind the image anyway. Vector SVGs are
      // EXCLUDED (filter:none → safe inside darknative); counting them flipped
      // KYM's whole dark header to light. Media inside a kept-dark wrapper is
      // additionally neutralised in CSS (styles.js) so it never triple-inverts.
      if (hasLargeRasterMediaDescendant(el)) return false;
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

  // Stats over the color stops of a CSS gradient string. Computed styles
  // always express stops as rgb()/rgba(), so a plain scan is enough. Returns:
  //   • meanLum: opacity-weighted mean luminance, or null when the gradient is
  //     mostly transparent (a faint tint/scrim rather than a solid surface) —
  //     in which case its own luminance isn't a reliable "is it light" signal.
  //   • maxAlpha: the peak stop opacity. Low values mean the gradient is a
  //     near-transparent overlay that lets the element's background-color show
  //     through (so the bg-color is the real surface).
  function gradientStats(bg) {
    const matches = bg.match(/rgba?\([^)]*\)/gi);
    if (!matches) return { meanLum: null, maxAlpha: 0 };
    let sumL = 0, sumA = 0, maxAlpha = 0;
    for (const m of matches) {
      const c = parseColor(m);
      if (!c) continue;
      const a = c.a == null ? 1 : c.a;
      sumL += luminance(c) * a;
      sumA += a;
      if (a > maxAlpha) maxAlpha = a;
    }
    return { meanLum: sumA < 0.5 ? null : sumL / sumA, maxAlpha };
  }

  // Media tags whose pixels are counter-inverted by the page CSS so they show
  // their true colors. When one of these covers most of an element, that
  // element's gradient is just a fallback painted *behind* the image — the
  // image is the real visible surface.
  const MEDIA_SELECTOR = "img,video,canvas,picture,object,embed,svg";
  // Media that actually gets the *counter-invert* filter (so it would
  // triple-invert into a colour-negative inside a darknative wrapper). This
  // EXCLUDES plain vector SVGs: they're treated like text (filter:none — see
  // styles.js) and render correctly inside a darknative wrapper, so they must
  // NOT veto native-dark tagging. (KYM's header is 86% covered by a decorative
  // vector SVG; counting it kept the whole dark header from being preserved, so
  // it flipped to a light block.) Only an <svg> holding a raster <image> counts.
  const RASTER_MEDIA_SELECTOR = "img,video,canvas,picture,object,embed,svg:has(image)";
  // Fraction of an element's area a single media descendant must cover for the
  // element to count as "image-fronted".
  const MEDIA_COVER_RATIO = 0.35;

  // True when the element's subtree contains any non-whitespace text. Used to
  // tell a content container (whose real identity is its text) from a bare
  // decorative tile. Short-circuits at the first non-space character.
  function hasTextContent(el) {
    try { return /\S/.test(el.textContent || ""); } catch (_) { return false; }
  }

  // A no-repeat background image counts as a logo/photo/illustration (rather
  // than a small UI glyph) when its element is sizeable, bounded, and carries
  // no text:
  //   • below MIN side it's a themeable icon/glyph — leave it to invert;
  //   • above MAX side it's likely a full-width decorative band, where a light
  //     image would become a bright stripe — leave it to darken (genuine large
  //     photos almost always use background-size:cover, handled above);
  //   • text-bearing elements are excluded — tagging them would revert their
  //     text too (the icon-beside-a-label / dark-on-dark sidebar case).
  const MIN_BG_PHOTO_SIDE = 48;   // px — smaller is an icon/glyph
  const MIN_BG_PHOTO_AREA = 8000; // px²
  const MAX_BG_PHOTO_SIDE = 600;  // px — larger is treated as a decorative band
  function isLogoOrPhotoBg(el) {
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return false; }
    if (Math.min(r.width, r.height) < MIN_BG_PHOTO_SIDE) return false;
    if (Math.max(r.width, r.height) > MAX_BG_PHOTO_SIDE) return false;
    if (r.width * r.height < MIN_BG_PHOTO_AREA) return false;
    return !hasTextContent(el);
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

  // Like hasLargeMediaDescendant but only counts RASTER media (the kind that
  // gets the counter-invert and would therefore triple-invert inside a
  // darknative wrapper). Vector SVGs are excluded — see RASTER_MEDIA_SELECTOR.
  // Used by tagNativeDarkBg so a decorative vector SVG can't stop a genuinely
  // dark wrapper from being kept dark.
  function hasLargeRasterMediaDescendant(el) {
    let rect;
    try { rect = el.getBoundingClientRect(); } catch (_) { return false; }
    const area = rect.width * rect.height;
    if (area <= 0) return false;
    let media;
    try { media = el.querySelectorAll(RASTER_MEDIA_SELECTOR); } catch (_) { return false; }
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
        const { meanLum, maxAlpha } = gradientStats(bg);
        const bc = parseColor(cs.backgroundColor);
        const opaqueLightBg =
          bc && bc.a >= 0.8 && luminance(bc) >= LIGHT_GRADIENT_MIN_LUM;
        // A near-transparent gradient is a decorative tint/scrim; the element's
        // own background-color shows through it and is the real surface.
        const faintGradient = maxAlpha < 0.5;
        // The element reads as a "light surface" — to be darkened by the page
        // filter rather than counter-inverted back to a bright block — when:
        //   • the gradient itself is light (a decorative header/banner gradient
        //     sitting behind text), or
        //   • it is a light card: an opaque light background-color that is the
        //     visible surface. We trust the bg-color directly when the gradient
        //     is only a faint tint over it (ko-fi's white content wrapper with
        //     rgba(…,0.03) overlays), and otherwise corroborate with a visible
        //     light descendant — an opaque gradient hides the bg-color, but a
        //     decorative gradient *frame* around a white card (Firefox Relay)
        //     still leaves the inner light panel visible. The descendant gate
        //     avoids darkening a real opaque gradient surface that merely
        //     declares a light fallback background-color.
        const lightGradient = meanLum != null && meanLum >= LIGHT_GRADIENT_MIN_LUM;
        const lightCard = opaqueLightBg &&
          (faintGradient || hasVisibleLightDescendant(el, 3));
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
    // A cover/contain image is the element's visual identity → counter-invert,
    // unless a large <img>/<video> fronts it (then this is a wrapper around real
    // media that would be triple-inverted; leave it to the media's own rule).
    if (coversViewport) return !hasLargeMediaDescendant(el);

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

    // No-repeat url() background: usually a small decorative/UI icon (search
    // glyph, dropdown arrow) that SHOULD invert with the theme. But a no-repeat
    // image on a sizeable, text-free element is almost always a logo, photo or
    // illustration (a header logo, a card thumbnail) — counter-invert it so it
    // keeps its true colours instead of rendering as a colour-negative.
    // Elements that carry text are excluded: tagging them would revert their
    // text too (the icon-beside-a-label / dark-on-dark sidebar case).
    if (isLogoOrPhotoBg(el)) return true;

    // Small decorative icon — leave it untouched so the root invert can
    // flip the text color normally.
    return false;
  }

  // ── Low-contrast text rescue ─────────────────────────────────────────────
  // A pure page-level invert preserves contrast for normally-inverted text, so
  // readable light-theme text stays readable. The exception is text inside a
  // *counter-inverted* element (tagged bg-image / native-dark): the counter-
  // filter reverts the text to its original (dark) colour, but if that element
  // has no opaque background of its own, the text lands on the page-inverted
  // (dark) surface behind it → dark-on-dark, nearly invisible. This is the
  // recurring "dark-on-dark sidebar" failure (e.g. OVH Manager's flyout menu,
  // whose items carry a cover-sized icon background that trips counter-invert).
  //
  // Rather than chase every tagging trigger, this pass fixes the *symptom*:
  // when an element's rendered text is dark on a rendered-dark background, force
  // it to render light. It only ever touches text that is already near-invisible
  // (contrast below MIN_TEXT_CONTRAST on a dark backdrop), so it cannot make
  // legible text worse.

  // Max rendered background luminance still considered "dark" for the rescue.
  const RESCUE_DARK_BG_MAX = 0.22;
  // Below this rendered text/background contrast ratio the text is unreadable
  // enough to justify forcing it light (WCAG AA large-text threshold).
  const RESCUE_MIN_CONTRAST = 3.0;

  function invertColor(c) {
    return { r: 255 - c.r, g: 255 - c.g, b: 255 - c.b, a: c.a };
  }

  // Parity of DarkAbsolut invert filters in the element's ancestor-or-self
  // chain. The page filter on <html> contributes 1 when applied; each counter-
  // inverted ancestor/self ([bg]/[darknative]) adds another. Odd ⇒ the element
  // renders inverted relative to its source colours; even ⇒ it renders as-is.
  // Counted from our own attributes (cheap, and the only inverts we reason
  // about) rather than getComputedStyle.
  function chainInvertParity(el) {
    let n = document.documentElement.getAttribute(DA.ATTR) === "on" ? 1 : 0;
    let cur = el, hops = 0;
    while (cur && cur.nodeType === 1 && hops++ < 200) {
      if (cur !== document.documentElement &&
          (cur.hasAttribute(BG_IMAGE_ATTR) || cur.hasAttribute(NATIVE_DARK_ATTR))) {
        n++;
      }
      if (cur === document.documentElement) break;
      cur = cur.parentElement;
    }
    return n % 2;
  }

  // Rendered luminance of a source colour given its chain parity.
  function displayedLum(c, parity) {
    return parity ? luminance(invertColor(c)) : luminance(c);
  }

  // Rendered luminance of the surface the element's text actually sits on.
  // Walks ancestors for the first opaque background-color and returns its
  // rendered luminance. Returns null when the backdrop is unknowable — an
  // *ancestor* paints a background-image (the text sits on that image, whose
  // colour we can't read). The element's *own* background-image is skipped
  // (decorative/transparent overlays like menu-item icons let the surface
  // behind show through). Reaching the root with no opaque colour means the
  // page surface shows through, which is dark while inverted.
  function effectiveDisplayedBg(el) {
    let cur = el, hops = 0;
    while (cur && cur.nodeType === 1 && hops++ < 200) {
      let cs;
      try { cs = getComputedStyle(cur); } catch (_) { return null; }
      const c = parseColor(cs.backgroundColor);
      if (c && c.a >= 0.5) return displayedLum(c, chainInvertParity(cur));
      if (cur !== el && cur.hasAttribute(BG_IMAGE_ATTR)) return null;
      if (cur === document.documentElement) break;
      cur = cur.parentElement;
    }
    return 0; // page background shows through; inverted page surface is dark
  }

  function hasDirectText(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && /\S/.test(n.nodeValue)) return true;
    }
    return false;
  }

  // If the element's text renders dark on a dark surface, mark it so the
  // injected CSS forces it light. Sets only a data-attribute — never inline
  // style — so it can't trigger the controller's style-watching observer
  // (attributeFilter is class/style), which is what prevents the re-process
  // loop that froze the page. The attribute also colours via CSS, so it
  // survives framework re-renders better than an inline style would.
  //   "1" = odd parity  → page filter inverts our value (CSS sets near-black).
  //   "2" = even parity → counter-inverted, renders as-is (CSS sets light).
  function rescueTextColor(el, cs) {
    if (document.documentElement.getAttribute(DA.ATTR) !== "on") return;
    if (el === document.documentElement || el === document.body) return;
    if (el.hasAttribute(ORIG_ATTR)) return; // pre-lighten owns this element's colour
    if (!hasDirectText(el)) return;
    // Shadow-DOM text: chainInvertParity can't cross the shadow boundary to the
    // page filter, so its parity is unreliable — leave shadow text alone.
    if (el.getRootNode() !== document) { el.removeAttribute(RESCUE_COLOR_ATTR); return; }
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const src = parseColor(cs.color);
    if (!src || src.a < 0.3) { el.removeAttribute(RESCUE_COLOR_ATTR); return; }

    const parity = chainInvertParity(el);
    // Measure the element's ORIGINAL colour. If we already rescued it, our CSS
    // rule is colouring it now, so temporarily drop the tag to read the real
    // computed colour. (Toggling a data-attribute doesn't trigger the observer.)
    let measured = src;
    const wasTagged = el.hasAttribute(RESCUE_COLOR_ATTR);
    if (wasTagged) {
      el.removeAttribute(RESCUE_COLOR_ATTR);
      try { measured = parseColor(getComputedStyle(el).color) || src; } catch (_) {}
    }

    const want = decideRescue(el, measured, parity);
    if (want) el.setAttribute(RESCUE_COLOR_ATTR, want);
    else if (wasTagged) el.removeAttribute(RESCUE_COLOR_ATTR);
  }

  // Returns "1"/"2" if the element's text renders dark on a dark surface and
  // should be forced light, else null. Pure decision — no DOM writes.
  function decideRescue(el, src, parity) {
    const textLum = displayedLum(src, parity);
    if (textLum >= 0.5) return null; // already renders light — nothing to fix
    const bgLum = effectiveDisplayedBg(el);
    if (bgLum == null) return null;            // unknown backdrop — don't guess
    if (bgLum >= RESCUE_DARK_BG_MAX) return null; // backdrop isn't dark — leave it
    const contrast =
      (Math.max(textLum, bgLum) + 0.05) / (Math.min(textLum, bgLum) + 0.05);
    if (contrast >= RESCUE_MIN_CONTRAST) return null; // readable enough
    return parity ? "1" : "2";
  }

  function revertRescuedText(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const els = scope.querySelectorAll(`[${RESCUE_COLOR_ATTR}]`);
    for (const el of els) el.removeAttribute(RESCUE_COLOR_ATTR);
  }

  // ── Background-fronted icon imgs (the phpMyAdmin pattern) ────────────────
  // Some apps render icons as <img src="1×1 dot.gif"> with the real icon painted
  // via CSS background-image. The blanket `img` counter-invert keeps that bg at
  // its original colour — correct for LIGHT icons (they stay light on the dark
  // page), wrong for DARK icons (they stay dark-on-dark). We can't tell which
  // without looking, so we sample the icon's actual pixels and tag only the dark
  // ones to invert with the theme. (A blanket rule either way breaks one theme:
  // verified pmahomme icons are light ~0.6, bootstrap-style icons are dark.)

  // An <img> whose visible content is its CSS background-image (placeholder src).
  function isBgFrontedImg(el) {
    const nw = el.naturalWidth | 0, nh = el.naturalHeight | 0;
    if (nw > 0 && nw <= 2 && nh > 0 && nh <= 2) return true;
    const src = (el.getAttribute("src") || "").trim();
    if (!src) return true;
    if (nw <= 2 &&
        /\b(?:dot|blank|spacer|transparent|clear|pixel|1x1)\.(?:gif|png|svg)\b/i.test(src)) {
      return true;
    }
    return false;
  }

  function firstUrl(bg) {
    const m = /url\((["']?)(.*?)\1\)/i.exec(bg || "");
    return m ? m[2] : null;
  }

  // Sample an image's opaque pixels → { lum, mono }: mean luminance (0..1) and
  // whether it's (near-)monochrome/grayscale (a logo/glyph, not a colour photo).
  // null when it can't be read (cross-origin taint / load error). Drawn to a
  // canvas; same-origin assets (the common case) read fine.
  function sampleImage(url) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth || 24, h = img.naturalHeight || 24;
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          const d = ctx.getImageData(0, 0, w, h).data;
          // Stride so huge images don't cost a full per-pixel scan.
          const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4000))) * 4;
          let sr = 0, sg = 0, sb = 0, n = 0, gray = 0;
          for (let i = 0; i < d.length; i += step) {
            if (d[i + 3] <= 20) continue;
            const r = d[i], g = d[i + 1], b = d[i + 2];
            sr += r; sg += g; sb += b;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            if (mx === 0 || (mx - mn) / mx < 0.18) gray++;
            n++;
          }
          // WCAG luminance of the average opaque colour — same scale as the
          // container luminance we compare against in shouldInvertIcon.
          finish(n ? { lum: luminance({ r: sr / n, g: sg / n, b: sb / n }), mono: gray / n > 0.85 } : null);
        } catch (_) { finish(null); } // tainted (cross-origin) → unknown
      };
      img.onerror = () => finish(null);
      try { img.src = url; } catch (_) { finish(null); }
      setTimeout(() => finish(null), 4000); // safety timeout
    });
  }

  const iconStatsCache = new Map();   // url -> {lum,mono}|null
  const iconStatsPending = new Map(); // url -> Promise
  function getIconStats(url) {
    if (iconStatsCache.has(url)) return Promise.resolve(iconStatsCache.get(url));
    if (iconStatsPending.has(url)) return iconStatsPending.get(url);
    const p = sampleImage(url).then(v => {
      iconStatsCache.set(url, v); iconStatsPending.delete(url); return v;
    });
    iconStatsPending.set(url, p);
    return p;
  }

  function contrastRatio(a, b) {
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  // Below this rendered contrast a monochrome icon/logo is unreadable on its bg.
  const ICON_MIN_CONTRAST = 3.0;

  // Should an icon/logo with raw luminance `lum` be inverted WITH the theme
  // (filter:none) rather than keeping its colour (counter-invert)? Yes when, on
  // its rendered container background, the kept colour is low-contrast AND
  // inverting improves it. Container-aware so it works whether the icon sits on
  // the page (phpMyAdmin: dark icon on dark page → invert) or on an element that
  // flipped to light (omori: white logo on a black button now white → invert).
  function shouldInvertIcon(lum, containerLum) {
    if (lum == null || containerLum == null) return false;
    const keep = contrastRatio(lum, containerLum);
    const inv = contrastRatio(1 - lum, containerLum);
    return keep < ICON_MIN_CONTRAST && inv > keep;
  }

  function tagIcon(el, on) {
    if (!el.isConnected || el.hasAttribute(BG_IMAGE_ATTR)) return;
    if (on) el.setAttribute(BG_ICON_ATTR, "1");
    else if (el.hasAttribute(BG_ICON_ATTR)) el.removeAttribute(BG_ICON_ATTR);
  }

  // Background-fronted icon (placeholder-src <img> + CSS background-image, the
  // phpMyAdmin pattern). Decide by contrast against the rendered container.
  function classifyBgIcon(el, bg) {
    const url = firstUrl(bg);
    if (!url) return;
    const decide = s => tagIcon(el, !!(s && shouldInvertIcon(s.lum, effectiveDisplayedBg(el))));
    if (iconStatsCache.has(url)) decide(iconStatsCache.get(url));
    else getIconStats(url).then(decide);
  }

  // A real <img> logo (e.g. a white store badge on a dark button). When it's a
  // monochrome logo (not a colour photo) and its kept colour would be invisible
  // on the rendered container, invert it with the theme so it stays visible.
  // Size-gated to logos/badges to skip (and not sample) large photos.
  function classifyLogoImg(el) {
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return; }
    if (r.width === 0 || Math.max(r.width, r.height) > 512) { tagIcon(el, false); return; }
    const url = el.currentSrc || el.getAttribute("src");
    if (!url) return;
    const decide = s => tagIcon(el, !!(s && s.mono && shouldInvertIcon(s.lum, effectiveDisplayedBg(el))));
    if (iconStatsCache.has(url)) decide(iconStatsCache.get(url));
    else getIconStats(url).then(decide);
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
      // An <img> icon painted via background-image over a placeholder src (the
      // phpMyAdmin pattern). This MUST take precedence over the generic
      // background-image logic below: bootstrap-theme icons use
      // background-repeat:repeat, which shouldReinvertBgImage would treat as a
      // "decorative tile → keep colours" and counter-invert, leaving dark icons
      // dark-on-dark. Instead sample the icon's real colour: dark icons invert
      // with the theme (→ light), light icons keep the blanket img counter-invert.
      // Skipped under "force natural images" (keep everything counter-inverted).
      const isBgIcon = el.tagName === "IMG" && hasBgImage && !forceImages &&
          isBgFrontedImg(el);
      if (isBgIcon) {
        if (el.hasAttribute(BG_IMAGE_ATTR)) el.removeAttribute(BG_IMAGE_ATTR);
        classifyBgIcon(el, bg);
      } else {
        if (hasBgImage && (forceImages || shouldReinvertBgImage(el, cs, bg))) {
          el.setAttribute(BG_IMAGE_ATTR, "1");
        } else if (el.hasAttribute(BG_IMAGE_ATTR)) {
          el.removeAttribute(BG_IMAGE_ATTR);
        }
        // A real <img> logo (its own content, no CSS bg-image): a monochrome
        // logo whose kept colour would be invisible on its flipped container
        // (e.g. a white store badge on a now-white button — omori-game.com) is
        // inverted with the theme instead. Photos are left alone (not mono).
        if (el.tagName === "IMG" && !hasBgImage && !forceImages &&
            !el.hasAttribute(BG_IMAGE_ATTR)) {
          classifyLogoImg(el);
        } else if (el.hasAttribute(BG_ICON_ATTR)) {
          el.removeAttribute(BG_ICON_ATTR);
        }
      }
      if (tagNativeDarkBg(el, cs)) return;
      if (el.hasAttribute(NATIVE_DARK_ATTR)) {
        el.removeAttribute(NATIVE_DARK_ATTR);
      }
      preLightenIfSaturated(el, cs);
      // Last: rescue text that still renders dark-on-dark after all the
      // tagging above has settled this element's (and its ancestors') filters.
      rescueTextColor(el, cs);
    } catch (_) { /* detached */ }
  }

  function markBackgroundImageElements(root) {
    const scope = root || document;
    let i = 0;
    // Include the root itself when it's an Element; querySelectorAll("*")
    // returns only descendants. Crucial for MutationObserver-added nodes.
    if (scope.nodeType === 1) {
      processElement(scope);
      if (scope.shadowRoot) processShadowRoot(scope.shadowRoot);
      i++;
    }
    const all = scope.querySelectorAll ? scope.querySelectorAll("*") : [];
    for (const el of all) {
      if (i++ > 5000) break; // safety cap on large DOMs
      processElement(el);
      // Open shadow roots: neither the counter-invert CSS nor querySelectorAll
      // cross the boundary, yet the page filter still inverts the shadow
      // content — so its media renders as a colour-negative (e.g. ad/sponsored
      // web components). Recurse to re-invert it.
      if (el.shadowRoot) processShadowRoot(el.shadowRoot);
    }
  }

  // ── Shadow DOM re-inversion ──────────────────────────────────────────────
  const observedShadowRoots = new WeakSet();

  // Make an open shadow root re-invert its media: adopt the shadow-scoped
  // counter-invert stylesheet, tag its background-image elements, and observe
  // it so lazily-mounted images (ad cards load late) are handled too. The
  // observer is gated on DA.state.applied so it never re-adds styles after the
  // extension is turned off for the page.
  function processShadowRoot(sr) {
    if (!sr) return;
    try { DA.styles.applyShadowStyle(sr); } catch (_) {}
    if (!observedShadowRoots.has(sr)) {
      observedShadowRoots.add(sr);
      try {
        const mo = new MutationObserver(muts => {
          if (!DA.state || !DA.state.applied) return;
          for (const m of muts) {
            if (m.type === "childList") {
              for (const n of m.addedNodes) if (n.nodeType === 1) markBackgroundImageElements(n);
            } else if (m.type === "attributes" && m.target && m.target.nodeType === 1) {
              processElement(m.target);
              if (m.target.shadowRoot) processShadowRoot(m.target.shadowRoot);
            }
          }
        });
        mo.observe(sr, {
          childList: true, subtree: true,
          attributes: true, attributeFilter: ["class", "style"]
        });
      } catch (_) {}
    }
    // Tag bg-images and recurse into any nested shadow roots.
    markBackgroundImageElements(sr);
  }

  // Remove our shadow-scoped styles (used when root inversion is turned off, so
  // shadow media isn't left counter-inverted on a now-uninverted page).
  function clearShadowStyles(root) {
    const scope = root || document;
    let i = 0;
    if (scope.nodeType === 1 && scope.shadowRoot) {
      try { DA.styles.removeShadowStyle(scope.shadowRoot); } catch (_) {}
      clearShadowStyles(scope.shadowRoot);
    }
    const all = scope.querySelectorAll ? scope.querySelectorAll("*") : [];
    for (const el of all) {
      if (i++ > 5000) break;
      if (el.shadowRoot) {
        try { DA.styles.removeShadowStyle(el.shadowRoot); } catch (_) {}
        clearShadowStyles(el.shadowRoot);
      }
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

  // True if the candidate contains a large opaque DARK region — i.e. it wraps the
  // page's real dark UI under a light fallback background-color. Twitch's
  // `channel-root` (bg #fff) holds the dark info panel + chat; the player's
  // <video> is an EXTERNAL overlay (not a descendant), so the media/sampling
  // guards miss it and the white shows beside the player. Inverting such a
  // wrapper flips its dark panels to light. The dark panels are substantial in
  // absolute terms even when the wrapper itself is a huge scroll container, so
  // measure each candidate descendant against the viewport area.
  function hasLargeDarkDescendant(el, viewportArea) {
    let list;
    try { list = el.querySelectorAll("*"); } catch (_) { return false; }
    let n = 0;
    for (const child of list) {
      if (n++ > 3000) break; // safety cap on huge containers
      let cs;
      try { cs = getComputedStyle(child); } catch (_) { continue; }
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const c = parseColor(cs.backgroundColor);
      if (!c || c.a < 0.7) continue;
      if (luminance(c) >= 0.25) continue; // not dark
      let r;
      try { r = child.getBoundingClientRect(); } catch (_) { continue; }
      if (r.width * r.height >= viewportArea * 0.08) return true;
    }
    return false;
  }

  // Verify a candidate light island's light background is the actually-PAINTED
  // surface, not a CSS background-color hidden behind opaque content. Twitch's
  // `div.channel-root` declares background:#fff but its children paint the dark
  // theme — and the <video> — on top; tagging it as a light island inverts the
  // whole dark channel UI to light. Sample rendered points across the element
  // and require the visible surface to be predominantly the light background.
  //
  // Two ways the light bg is NOT the visible surface:
  //   • large MEDIA (img/video/canvas/…) is painted over it — its CSS
  //     background-color is transparent, so a naive bg-color walk wrongly
  //     reports the wrapper's light bg. This is the Twitch case (channel-root
  //     fronts the <video>, ~38% of it) and why the block flipped to light only
  //     once the video started painting (~5-6s) under an elementFromPoint-only
  //     check. hasLargeMediaDescendant is viewport- and play-state-independent.
  //   • opaque DARK children cover the wrapper (a white-bg wrapper with a dark
  //     theme painted on top). Detected by sampling the rendered surface.
  // Off-screen / fully-overlaid elements can't be sampled — fall back to the
  // bg-color decision (original behaviour); the media guard above still applies.
  function lightBgIsVisible(el) {
    if (hasLargeMediaDescendant(el)) return false;
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return true; }
    const W = window.innerWidth, H = window.innerHeight;
    const x0 = Math.max(1, r.left), y0 = Math.max(1, r.top);
    const x1 = Math.min(W - 2, r.right), y1 = Math.min(H - 2, r.bottom);
    if (x1 <= x0 || y1 <= y0) return true; // off-screen — trust the bg-color
    const fxs = [0.5, 0.25, 0.75, 0.5, 0.5, 0.25, 0.75];
    const fys = [0.5, 0.5, 0.5, 0.2, 0.8, 0.8, 0.2];
    let light = 0, total = 0;
    for (let i = 0; i < fxs.length; i++) {
      const x = x0 + (x1 - x0) * fxs[i];
      const y = y0 + (y1 - y0) * fys[i];
      let hit;
      try { hit = document.elementFromPoint(x, y); } catch (_) { continue; }
      if (!hit || (hit !== el && !el.contains(hit))) continue; // overlay outside el
      total++;
      // Media painted at this point — real content covers the bg, not light.
      let m = null;
      try { m = hit.closest(MEDIA_SELECTOR); } catch (_) {}
      if (m && (m === el || el.contains(m))) continue;
      const c = DA.detect.firstOpaqueBgUp(hit);
      if (c && luminance(c) >= LIGHT_ISLAND_MIN_LUM) light++;
    }
    if (total === 0) return true; // fully overlaid — trust the bg-color
    return light >= total * 0.5;
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
    // Don't invert a wrapper that holds the page's real dark UI — its light bg
    // is a structural fallback behind large dark panels (Twitch channel-root,
    // whose <video> is an external overlay so the media/sampling guards miss it).
    if (hasLargeDarkDescendant(el, viewportArea)) return false;
    // The light bg must actually be visible — not hidden behind opaque dark
    // children or media painted on top (Twitch channel-root, image cards).
    if (!lightBgIsVisible(el)) return false;
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
    rescueTextColor,
    revertRescuedText,
    processElement,
    markBackgroundImageElements,
    processShadowRoot,
    clearShadowStyles,
    tagLightIslands,
    clearLightIslands
  };
})(DA);
