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
    parseColor, luminance, rgbToHsl, hslToRgbString, nativeDarkMaxSat,
    chroma, filterLuma, contrastRatio, toHex, accentFillSource, accentTextSource
  } = DA.colors;

  const {
    ORIG_ATTR, ORIG_COLOR_ATTR, BG_IMAGE_ATTR, BG_ICON_ATTR,
    NATIVE_DARK_ATTR, NATIVE_LIGHT_ATTR, RESCUE_COLOR_ATTR, LIGHT_ICON_ATTR,
    INVERT_MEDIA_ATTR, ZLIFT_ATTR, ZLIFT_ORIG_ATTR, ACCENT_ATTR, BG_SRC_ATTR
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

  // A neutral-dark background that is SEMI-TRANSPARENT (alpha below this) is a
  // scrim / elevation overlay, not a real dark surface — e.g. Gmail paints the
  // reading pane rgba(51,51,51,0.8) from a `prefers-color-scheme: dark` media
  // query while the page theme is still light. Counter-inverting a translucent
  // surface does NOT keep it dark: the double-invert washes it to mid-gray (a
  // big light blob over the otherwise-dark UI). So a sizeable translucent dark
  // scrim is NEUTRALISED (background made transparent) so the already-inverted
  // dark content behind shows through; opaque dark surfaces (alpha >= this)
  // keep the normal darknative counter-invert.
  const SCRIM_MIN_OPAQUE_ALPHA = 0.92;
  const SCRIM_MIN_AREA = 50000; // px² — only neutralise large scrims, not chips/tooltips

  // Light vector-SVG icon rescue. A small vector glyph whose paint colour is
  // already light (luminance above this) would be flipped to black-on-dark by
  // the page invert — counter-invert it instead so it stays light. Only applied
  // to UI-icon-sized SVGs (longer side at or below this) so logos/illustrations
  // (which carry their own colours) are untouched.
  const LIGHT_ICON_MAX_PX = 48;
  // Relative-luminance crossover above which an icon is "light": keeping it
  // (counter-invert) gives MORE contrast on the now-dark page than letting it
  // invert. 0.5 is the natural midpoint — and notably Gmail paints some glyphs a
  // dim light-gray (e.g. the selection-action toolbar icons at ~rgb(196,199,197),
  // lum ~0.56), which a higher threshold would miss and leave dark-on-dark.
  const LIGHT_ICON_MIN_LUM = 0.5;

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

  // True when an ancestor carries one of our counter-invert tags ([bg] or
  // [darknative]), i.e. the element does NOT render under the page filter
  // alone. The accent treatments are computed for exactly one inversion, so
  // they stay off inside such wrappers.
  function hasCounterInvertedAncestor(el) {
    let cur = el.parentElement;
    while (cur && cur !== document.documentElement) {
      if (cur.hasAttribute(NATIVE_DARK_ATTR) || cur.hasAttribute(BG_IMAGE_ATTR)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // A positioned child that FLOATS above the wrapper rather than composing its
  // in-flow content: absolutely/fixed-positioned with an explicit stacking
  // order (z-index >= 1), or escaping the wrapper's own box (a date-picker
  // popover jutting out of a dark search header). Such transient UI is not
  // the wrapper's identity and must not veto darknative tagging — otherwise a
  // REPROCESS of the wrapper while its popup is open (any class/style flip,
  // including our own z-lift below) strips the tag and flips the whole dark
  // region light. The genuine veto case — a dark frame around a large white
  // in-flow content panel — is untouched.
  //
  // Consulted ONLY when the caller supplies the wrapper's rect (the
  // tagNativeDarkBg veto). shouldReinvertBgImage's lightCard corroboration
  // calls hasVisibleLightDescendant WITHOUT a rect and must keep counting
  // positioned light panels (a layered hero card's white inner panel is the
  // corroboration that the gradient element is a light card, not a dark one).
  function isFloatingOverlayChild(child, cs, outerRect) {
    if (cs.position !== "absolute" && cs.position !== "fixed") return false;
    const z = parseInt(cs.zIndex, 10);
    if (Number.isFinite(z) && z >= 1) return true;
    let r;
    try { r = child.getBoundingClientRect(); } catch (_) { return false; }
    const pad = 8;
    return r.left < outerRect.left - pad || r.top < outerRect.top - pad ||
           r.right > outerRect.right + pad || r.bottom > outerRect.bottom + pad;
  }

  // Returns true if any visible (not display:none/hidden) direct or nested
  // child up to `depth` levels has a light opaque background that is LARGE
  // enough (>= `minArea` px²) to dominate the wrapper. Used to detect wrapper
  // elements whose counter-filter would double-invert a white panel inside
  // them back to white (the cascade problem). A small light widget doesn't
  // count — see LIGHT_CHILD_VETO_RATIO. Floating overlays (open popovers)
  // don't count either — see isFloatingOverlayChild.
  function hasVisibleLightDescendant(el, depth, minArea, outerRect) {
    for (const child of el.children) {
      let cs;
      try { cs = getComputedStyle(child); } catch (_) { continue; }
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (outerRect && isFloatingOverlayChild(child, cs, outerRect)) continue;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0.4 && luminance(c) > 0.50) {
        if (!minArea) return true;
        let r; try { r = child.getBoundingClientRect(); } catch (_) { r = null; }
        if (r && r.width * r.height >= minArea) return true;
      }
      if (depth > 1 && hasVisibleLightDescendant(child, depth - 1, minArea, outerRect)) return true;
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
      let wrapperArea = 0, wrapperRect = null;
      try {
        wrapperRect = el.getBoundingClientRect();
        wrapperArea = wrapperRect.width * wrapperRect.height;
      } catch (_) {}
      // A large SEMI-TRANSPARENT dark surface is a scrim/elevation overlay, not
      // a real dark theme region. Counter-inverting it washes it to light gray
      // (Gmail's prefers-dark reading pane), so neutralise it instead — making
      // it transparent reveals the already-inverted dark content behind.
      //
      // BUT only when the scrim sits over LIGHT-THEMED content, detected by the
      // element's own foreground text colour being DARK. A translucent dark
      // surface whose foreground is LIGHT is a genuine dark-themed region (light
      // icons/text — a toolbar, nav, message row); neutralising it would let the
      // root filter invert that light content to dark (black-on-black icons), so
      // leave those to the darknative path below.
      const fg = parseColor(cs.color);
      const fgIsLight = fg && fg.a > 0.3 && luminance(fg) > 0.5;
      if (c.a < SCRIM_MIN_OPAQUE_ALPHA && wrapperArea >= SCRIM_MIN_AREA && !fgIsLight) {
        if (!el.hasAttribute(ORIG_ATTR)) {
          el.setAttribute(ORIG_ATTR, el.style.getPropertyValue("background-color") || "");
          el.setAttribute(BG_SRC_ATTR, cs.backgroundColor);
          el.style.setProperty("background-color", "transparent", "important");
        }
        return false;
      }
      // Don't tag a wrapper whose counter-filter would double-invert a LARGE
      // visible white panel (a dark frame around light content). A small light
      // widget inside a big dark wrapper must not veto tagging — otherwise the
      // whole dark area flips to light. Scale the veto to the wrapper's size.
      const minLightArea = wrapperArea * LIGHT_CHILD_VETO_RATIO;
      if (hasVisibleLightDescendant(el, 3, minLightArea, wrapperRect)) return false;
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

  // ── Trapped-overlay z-index rescue ───────────────────────────────────────
  // Any non-none CSS filter creates a stacking context, which TRAPS every
  // descendant's z-index inside it. Our counter-invert on a tagged wrapper
  // ([darknative]/[bg]) therefore breaks sites whose popovers are nested in
  // that wrapper but rely on a high z-index resolving in the ROOT stacking
  // context to paint above later-DOM content (Skyscanner: the calendar
  // popover, z-index:900, nested in the dark search hero — counter-inverted
  // airline-logo <img>s and later cards painted OVER the open calendar,
  // making dates unclickable; same pattern on booking.com). No CSS on the
  // descendant can escape an ancestor's stacking context, so we lift the
  // WRAPPER itself to the overlay's z-index (inline style, saved/restored
  // like the scrim/pre-lighten pattern): the wrapper then competes at the
  // level the popup natively painted at, and the popup — topmost inside the
  // wrapper — is back on top. Using the overlay's OWN z-index rather than a
  // huge constant keeps genuinely-higher site overlays (portaled modals,
  // dialogs) above the lifted region.
  //
  // Only wrappers with NO native stacking context are lifted: one that
  // already had a numeric z-index / transform / reduced opacity trapped the
  // overlay with or without DarkAbsolut, and the site designed for that.

  // Ignore positioned micro-widgets (badges, notification dots) — a real
  // popup/dropdown/panel is comfortably bigger than this.
  const OVERLAY_MIN_AREA = 4000; // px²

  function liftWrapper(w, z, wcs) {
    if (w === document.documentElement || w === document.body) return;
    const prev = parseInt(w.getAttribute(ZLIFT_ATTR) || "", 10);
    const hasLift = Number.isFinite(prev);
    // Already lifted at least this high and SOME inline z-index is still in
    // place. Deliberately not compared to our recorded value: a framework
    // that wiped the style attribute leaves it empty (re-assert below), while
    // a site that actively set its OWN inline z-index is respected — stomping
    // an explicit site value is worse than losing the lift.
    if (hasLift && prev >= z && w.style.getPropertyValue("z-index") !== "") return;
    if (!hasLift) {
      // Native stacking context → our filter changed nothing; leave it alone.
      if (wcs.zIndex !== "auto" || wcs.transform !== "none" ||
          parseFloat(wcs.opacity) < 1 || wcs.isolation === "isolate") return;
      // Save the original INLINE values (usually empty) for restore. "|" is
      // safe as a separator — neither CSS value can contain it.
      w.setAttribute(ZLIFT_ORIG_ATTR,
        (w.style.getPropertyValue("position") || "") + "|" +
        (w.style.getPropertyValue("z-index") || ""));
    }
    const target = hasLift ? Math.max(prev, z) : z;
    // z-index needs the wrapper positioned; keep whatever positioning the
    // site gave it (relative/sticky/…) and only promote static.
    if (wcs.position === "static") w.style.setProperty("position", "relative");
    w.style.setProperty("z-index", String(target));
    w.setAttribute(ZLIFT_ATTR, String(target));
    // (These inline writes re-enqueue w via the style-attribute observer;
    // the re-process is a no-op because the lift is already recorded.)
  }

  // Called from processElement for every element: when el is a sizeable
  // positioned overlay with an explicit z-index, lift every counter-filtered
  // wrapper on its ancestor chain. Runs on the mutation re-analysis path, so
  // a popup that MOUNTS (or is unhidden) inside an already-tagged wrapper is
  // caught within one throttle window.
  function maybeLiftTrappedOverlay(el, cs) {
    // Wrapper counter-filters only exist while root inversion is on — the
    // [bg]/[darknative] rules are gated on html[data-darkabsolut="on"].
    if (document.documentElement.getAttribute(DA.ATTR) !== "on") return;
    if (cs.position !== "absolute" && cs.position !== "fixed") return;
    const z = parseInt(cs.zIndex, 10);
    if (!Number.isFinite(z) || z < 1) return;
    if (cs.display === "none" || cs.visibility === "hidden") return;
    // Cheap attribute-only ancestor scan FIRST; getBoundingClientRect forces
    // layout, so pay it only when a tagged wrapper actually exists above us.
    const wrappers = [];
    let cur = el.parentElement, hops = 0;
    while (cur && cur !== document.documentElement && hops++ < 200) {
      if (cur.hasAttribute(NATIVE_DARK_ATTR) || cur.hasAttribute(BG_IMAGE_ATTR)) {
        wrappers.push(cur);
      }
      cur = cur.parentElement;
    }
    if (!wrappers.length) return;
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return; }
    if (r.width * r.height < OVERLAY_MIN_AREA) return;
    // Lift every counter-filtered wrapper up the chain (nested darknative is
    // prevented, but [bg] wrappers can nest). The computed-filter check keeps
    // this exact: tags whose filter is neutralised by a more specific rule
    // (e.g. [bg] inside [darknative]) create no stacking context and must not
    // be turned into one by a lift.
    for (const w of wrappers) {
      let wcs = null;
      try { wcs = getComputedStyle(w); } catch (_) {}
      if (wcs && wcs.filter && wcs.filter !== "none") liftWrapper(w, z, wcs);
    }
  }

  function revertZLiftOn(el) {
    const orig = el.getAttribute(ZLIFT_ORIG_ATTR);
    el.removeAttribute(ZLIFT_ATTR);
    el.removeAttribute(ZLIFT_ORIG_ATTR);
    const sep = orig == null ? -1 : orig.indexOf("|");
    const origPos = sep >= 0 ? orig.slice(0, sep) : "";
    const origZ = sep >= 0 ? orig.slice(sep + 1) : "";
    el.style.removeProperty("position");
    if (origPos) el.style.setProperty("position", origPos);
    el.style.removeProperty("z-index");
    if (origZ) el.style.setProperty("z-index", origZ);
  }

  function revertZLifts(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const els = scope.querySelectorAll(`[${ZLIFT_ATTR}]`);
    for (const el of els) revertZLiftOn(el);
    // Lifts can be recorded INSIDE open shadow roots too (the shadow-scoped
    // stylesheet counter-filters [darknative]/[bg] there, and processShadowRoot
    // runs the same pipeline), but querySelectorAll doesn't pierce the
    // boundary — recurse like clearShadowStyles does so disable leaves no
    // inline position/z-index behind.
    let i = 0;
    const all = scope.querySelectorAll("*");
    for (const el of all) {
      if (i++ > 5000) break;
      if (el.shadowRoot) revertZLifts(el.shadowRoot);
    }
  }

  // Absolute chroma (max−min over the RGB channels, 0..255) below which a
  // "saturated" light colour is really a PERCEPTUALLY-NEUTRAL near-white/gray.
  // HSL saturation explodes toward white — a 5/255 channel spread reads as
  // s≈0.5 — so the branches below would mistake a neutral canvas for a tinted
  // surface and hue-amplify it, which the page invert then renders as a
  // COLOURED dark block (the navy cast Gmail's faint-blue #f6f8fc canvas, chroma
  // 6, acquired). A genuine light tint — an info box, a brand wash, a coloured
  // selection — clears this floor (chroma ≳ 25), so it keeps its hue. Tuned to
  // sit just above Gmail's neutral chrome/selection (chroma ≤ 22) and below
  // semantic light fills (success #d4edda 25, info #d1ecf1 32, warn #fff3cd 50).
  const MIN_TINT_CHROMA = 24;

  // Largest area (px²) a saturated fill may cover and still be an ACCENT (a
  // button, chip, badge, status dot) rather than a SURFACE (header, banner,
  // sidebar, hero) that should go dark with the page.
  const ACCENT_FILL_MAX_AREA = 20000;
  // A fill this thin is a line/bar indicator at any length (progress bar, tab
  // underline, rating-distribution bar).
  const ACCENT_FILL_MAX_THICKNESS = 16;
  // Min rendered label/fill contrast for a small fill to keep its accent
  // rendering; below it the surface path (with its forced label colour) wins.
  const ACCENT_LABEL_MIN_CONTRAST = 3.0;

  function isAccentSizedFill(el) {
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return false; }
    if (!r.width || !r.height) return false;
    return r.width * r.height <= ACCENT_FILL_MAX_AREA ||
           Math.min(r.width, r.height) <= ACCENT_FILL_MAX_THICKNESS;
  }

  // Would the fill's own label stay readable under the plain page filter? A
  // label designed with poor contrast (white on yellow) comes out dark on dark
  // brown; such fills keep the surface treatment, which forces a dark label.
  function accentLabelReadable(el, c, cs) {
    if (!hasTextContent(el)) return true;
    const tc = parseColor(cs.color);
    if (!tc || tc.a < 0.3) return true;
    const { pageFilter } = DA.colors;
    return contrastRatio(luminance(pageFilter(tc)), luminance(pageFilter(c))) >=
      ACCENT_LABEL_MIN_CONTRAST;
  }

  // A BRIGHT, text-free accent fill (a gold rating bar, a lime status dot) is
  // pushed dark by the plain page filter (gold → brown, nearly the tone of the
  // track it sits on). Rewrite its background to the source colour the filter
  // renders as the SAME hue, lit (DA.colors.accentFillSource). Mid/dark tones
  // need nothing — the filter already renders them lighter with their hue.
  function accentFill(el, c, cs) {
    if (hasTextContent(el) || hasCounterInvertedAncestor(el)) return;
    // Its own counter-invert tag means it doesn't render through the page
    // filter alone — the source colour below would be wrong.
    if (el.hasAttribute(BG_IMAGE_ATTR) || el.hasAttribute(NATIVE_DARK_ATTR)) return;
    const src = accentFillSource(c);
    if (!src) return;
    el.setAttribute(ORIG_ATTR, el.style.getPropertyValue("background-color") || "");
    el.setAttribute(BG_SRC_ATTR, cs.backgroundColor);
    el.style.setProperty("background-color",
      `rgba(${src.r}, ${src.g}, ${src.b}, ${c.a == null ? 1 : c.a})`, "important");
  }

  // Saturated mid-lightness backgrounds (e.g. brand blue #459cd5, l~55%)
  // are barely darkened by `invert + hue-rotate(180)`. Pre-lighten the bg
  // to ~92% lightness so the html-level invert flips it to ~8% (true dark)
  // while preserving hue. Also force a dark text color if needed so the
  // invert produces readable light text over the new dark background.
  function preLightenIfSaturated(el, cs) {
    if (el.hasAttribute(ORIG_ATTR)) return;
    if (hasNativeDarkAncestor(el)) return;
    // An accent glyph's fill (a chromatic mask star) is handled per pixel by
    // the accent filter; rewriting it would apply the correction twice.
    if (el.hasAttribute(ACCENT_ATTR)) return;
    // A light-icon glyph is counter-inverted to keep its (mask) fill colour —
    // rewriting that fill would defeat the rescue.
    if (el.hasAttribute(LIGHT_ICON_ATTR)) return;
    const c = parseColor(cs.backgroundColor);
    if (!c || c.a < 0.5) return;
    const hsl = rgbToHsl(c);
    if (hsl.l < 0.18) return; // dark — tagNativeDarkBg or filter handles it

    let targetS, targetL = 0.92;
    if (hsl.s >= 0.30 && hsl.l <= 0.85) {
      // A SMALL saturated fill is an accent, not a surface: a primary button,
      // a badge, a progress/rating bar, a status dot. Crushing it to near-black
      // like the page around it erases what its colour encodes (Google Maps:
      // the filled primary action looked like the tinted secondary ones). The
      // plain page filter keeps its hue and mirrors its luma around 0.5, so a
      // mid-tone accent stays one (teal button → light teal, dark label — the
      // Material dark pattern); a bright text-free indicator is kept lit.
      if (isAccentSizedFill(el) && accentLabelReadable(el, c, cs)) {
        accentFill(el, c, cs);
        return;
      }
      // Saturated mid-lightness surface.
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

    // The high HSL saturation that selected a branch above is a measurement
    // artefact when the absolute chroma is tiny: the surface is really neutral.
    // Desaturate it IN PLACE (drop saturation, keep its own lightness) so the
    // page invert renders it neutral dark rather than a coloured block. Keeping
    // the lightness — instead of the 0.92 normalisation the branches use — lets
    // a near-white canvas invert all the way to near-black (a true dark
    // background) while a lighter neutral fill (a selected/hover row) inverts to
    // a slightly-lifted neutral ~#141414, preserving its subtle highlight.
    const chroma = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    if (chroma < MIN_TINT_CHROMA) {
      targetS = 0;
      targetL = hsl.l;
    }

    const lightened = hslToRgbString({ h: hsl.h, s: targetS, l: targetL });
    el.setAttribute(ORIG_ATTR, el.style.getPropertyValue("background-color") || "");
    el.setAttribute(BG_SRC_ATTR, cs.backgroundColor);
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

  // `scope` plus every open shadow root nested in it. processShadowRoot runs
  // the full element pipeline in there (pre-lighten included), but a plain
  // querySelectorAll doesn't pierce the boundary — reverts must recurse.
  function withShadowScopes(scope, out) {
    out = out || [];
    out.push(scope);
    let i = 0;
    for (const el of scope.querySelectorAll("*")) {
      if (i++ > 5000) break;
      if (el.shadowRoot) withShadowScopes(el.shadowRoot, out);
    }
    return out;
  }

  function revertPreLightened(root) {
    const scope = root && root.querySelectorAll ? root : document;
    for (const s of withShadowScopes(scope)) revertPreLightenedIn(s);
  }

  function revertPreLightenedIn(scope) {
    const els = scope.querySelectorAll(`[${ORIG_ATTR}]`);
    for (const el of els) {
      const orig = el.getAttribute(ORIG_ATTR);
      el.style.removeProperty("background-color");
      if (orig) el.style.setProperty("background-color", orig);
      el.removeAttribute(ORIG_ATTR);
      el.removeAttribute(BG_SRC_ATTR);
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
  //   • below the LONG-side picture threshold it's a themeable icon/glyph —
  //     leave it to invert with the theme so a DARK glyph stays visible instead
  //     of being kept dark-on-dark. A picture/logo is "generally larger than
  //     ~100px" (the icon-vs-picture size discriminant); a sprite-driven UI icon
  //     stays well under it. Keyed on the LONG side, not the short one, so a wide
  //     wordmark logo (e.g. wikiHow's 172×72 header) is still treated as a logo;
  //   • a tiny short side is a sliver/hairline, not a picture;
  //   • above MAX side it's likely a full-width decorative band, where a light
  //     image would become a bright stripe — leave it to darken (genuine large
  //     photos almost always use background-size:cover, handled above);
  //   • text-bearing elements are excluded — tagging them would revert their
  //     text too (the icon-beside-a-label / dark-on-dark sidebar case).
  const MIN_BG_PHOTO_SIDE = 48;        // px — shorter side floor (a sliver isn't a picture)
  const MIN_BG_PHOTO_LONG_SIDE = 100;  // px — longer side; below it the image is a UI icon
  const MIN_BG_PHOTO_AREA = 8000;      // px²
  const MAX_BG_PHOTO_SIDE = 600;       // px — larger is treated as a decorative band
  function isLogoOrPhotoBg(el) {
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return false; }
    const longSide = Math.max(r.width, r.height);
    if (longSide < MIN_BG_PHOTO_LONG_SIDE) return false; // icon-sized → invert with theme
    if (Math.min(r.width, r.height) < MIN_BG_PHOTO_SIDE) return false;
    if (longSide > MAX_BG_PHOTO_SIDE) return false;
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

  // Chroma (0..1) at or above which text is COLOUR-CODED (a gold ★, an amber
  // "limited", a lime "in stock"): it is rescued along its own hue rather than
  // to neutral light.
  const TEXT_ACCENT_MIN_CHROMA = 0.25;
  // Contrast colour-coded text is lifted to on its dark backdrop.
  const TEXT_ACCENT_CONTRAST = 4.5;
  // The page filter doesn't preserve WCAG contrast exactly; a rendering within
  // this factor of the designed contrast counts as "carried over".
  const FAINT_TOLERANCE = 0.9;
  // Below this DESIGNED contrast the text was effectively invisible on the
  // backdrop we computed — so that backdrop isn't what the user saw (a theme
  // leak, an image or scrim we can't read): no faint-by-design claim then.
  const FAINT_MIN_DESIGNED_CONTRAST = 1.25;

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

  // Rendered luminance of a source colour given its chain parity (exact page-
  // filter model — see DA.colors.pageFilter).
  function displayedLum(c, parity) {
    return parity ? luminance(DA.colors.pageFilter(c)) : luminance(c);
  }

  // The background the site designed this element's text against, in ORIGINAL
  // colours: the first opaque background up the tree, reading through our own
  // background rewrites (BG_SRC_ATTR). Null when an ancestor paints a
  // background image (its colour is unknowable) — nothing can be claimed then.
  function originalBackdrop(el) {
    let cur = el, hops = 0;
    while (cur && cur.nodeType === 1 && hops++ < 200) {
      let cs;
      try { cs = getComputedStyle(cur); } catch (_) { return null; }
      const c = parseColor(cur.getAttribute(BG_SRC_ATTR) || cs.backgroundColor);
      if (c && c.a >= 0.5) return c;
      if (cur !== el && cs.backgroundImage && cs.backgroundImage !== "none") return null;
      if (cur === document.documentElement) break;
      cur = cur.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 }; // default canvas
  }

  // Low contrast that the SITE designed (an empty-star ★, a hint, disabled
  // text) and the page filter merely carried over. Such text is meant to be
  // faint; forcing it light inverts the hierarchy — the empty star outshines
  // the filled ones and a rating reads 5/5.
  function isFaintByDesign(el, src, renderedContrast) {
    const bg = originalBackdrop(el);
    if (!bg) return false;
    const a = src.a == null ? 1 : src.a;
    const fg = { r: src.r * a + bg.r * (1 - a), g: src.g * a + bg.g * (1 - a),
                 b: src.b * a + bg.b * (1 - a) };
    const designed = contrastRatio(luminance(fg), luminance(bg));
    return designed >= FAINT_MIN_DESIGNED_CONTRAST && designed < RESCUE_MIN_CONTRAST &&
           renderedContrast >= designed * FAINT_TOLERANCE;
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

  // Input types whose visible content (value / placeholder) is painted via the
  // element's own `color`, not a child text node — so hasDirectText misses them.
  const TEXT_INPUT_TYPES = new Set(
    ["text", "search", "email", "url", "tel", "password", "number", ""]);

  // True for a form field whose text is its `color` (so the text rescue should
  // consider it even though it has no child text node).
  function isTextField(el) {
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    return TEXT_INPUT_TYPES.has((el.getAttribute("type") || "text").trim().toLowerCase());
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
    // Form fields paint their value + ::placeholder via the element's `color`,
    // not a child text node, so hasDirectText misses them. The search box is the
    // canonical victim: Gmail styles it with light text (color:#fff…) that the
    // page invert flips to near-black on the now-dark bar — unreadable typed text
    // AND placeholder. Treat such fields as text-bearing so the rescue forces
    // them light again (the ::placeholder is fixed by a matching CSS rule).
    if (!hasDirectText(el) && !isTextField(el)) return;
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

  // Returns the rescue value if the element's text renders dark on a dark
  // surface, else null: "1"/"2" = neutral light, "c<hex>" = colour-coded text
  // lifted along its own hue (the hex joins the stylesheet palette). Decides
  // only; the sole side effect is registering a palette colour.
  function decideRescue(el, src, parity) {
    const textLum = displayedLum(src, parity);
    if (textLum >= 0.5) return null; // already renders light — nothing to fix
    const bgLum = effectiveDisplayedBg(el);
    if (bgLum == null) return null;            // unknown backdrop — don't guess
    if (bgLum >= RESCUE_DARK_BG_MAX) return null; // backdrop isn't dark — leave it
    const contrast = contrastRatio(textLum, bgLum);
    if (contrast >= RESCUE_MIN_CONTRAST) return null; // readable enough
    const field = isTextField(el);
    // Colour-coded text keeps its hue. The page filter pushes bright accents
    // dark (a gold ★ → brown); a neutral rescue would then paint every star of
    // a rating the same white, filled or empty.
    if (!field && chroma(src) >= TEXT_ACCENT_MIN_CHROMA) {
      const lit = accentTextSource(src, bgLum, TEXT_ACCENT_CONTRAST, !!parity);
      if (lit) {
        const hex = toHex(lit);
        if (DA.styles.requestTextColor(hex)) return "c" + hex;
      }
    }
    // Form fields are exempt: whatever the design, typed text must read.
    if (!field && isFaintByDesign(el, src, contrast)) return null;
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
      // Request via CORS so a cross-origin asset served with
      // Access-Control-Allow-Origin (e.g. Gmail's gstatic label sprites) can be
      // drawn + read instead of tainting the canvas. Non-CORS cross-origin
      // images simply fail to load here → null (same outcome as a taint).
      try { img.crossOrigin = "anonymous"; } catch (_) {}
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

  // Image sampling settles asynchronously — possibly after the page was
  // switched off (disableForPage). Never tag a page that is no longer themed.
  // (DA.state is absent when the module runs without the controller.)
  function themeActive() { return !DA.state || DA.state.applied; }

  function tagIcon(el, on) {
    if (!el.isConnected || el.hasAttribute(BG_IMAGE_ATTR) || !themeActive()) return;
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

  // ── Colour-coded glyphs ──────────────────────────────────────────────────
  // A small glyph's colour often IS the information: gold vs gray rating stars,
  // a red/green status icon. The page invert keeps hue but mirrors luma, so a
  // bright accent comes out dark (gold → brown), and the counter-invert can't
  // restore it either (the round trip clamps it to pale peach) — while a light
  // gray "off" glyph is kept light by the counter-invert or the light-icon
  // rescue. Filled and empty stars then look alike. Such glyphs are tagged
  // ACCENT and rendered through the SVG accent filter (styles.js): neutral
  // pixels invert with the theme, bright chromatic pixels stay lit in their own
  // hue. Per-pixel, so it needs no pixel read-back — the Google Maps star
  // sprites are cross-origin without CORS.

  function setAccent(el, on) {
    if (on) {
      if (el.getAttribute(ACCENT_ATTR) !== "1") el.setAttribute(ACCENT_ATTR, "1");
      DA.styles.ensureFilterDefs();
    } else if (el.hasAttribute(ACCENT_ATTR)) {
      el.removeAttribute(ACCENT_ATTR);
    }
  }

  // The accent filter is computed for exactly one inversion (the page filter),
  // and its url(#…) reference only resolves in the main document tree.
  function accentContextOk(el) {
    return el.getRootNode() === document && !hasCounterInvertedAncestor(el);
  }

  function isChromaticPaint(c) { return chroma(c) >= TEXT_ACCENT_MIN_CHROMA; }
  function isBrightChromatic(c) { return isChromaticPaint(c) && filterLuma(c) > 0.5; }

  function maskOf(cs) {
    return (cs.maskImage && cs.maskImage !== "none") ? cs.maskImage
         : (cs.webkitMaskImage && cs.webkitMaskImage !== "none") ? cs.webkitMaskImage : null;
  }

  function isGlyphSized(el) {
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return false; }
    return !!r && r.width > 0 && r.height > 0 && Math.max(r.width, r.height) <= LIGHT_ICON_MAX_PX;
  }

  // A text-free, childless, glyph-sized element painted by its own url()
  // background image: a sprite glyph. `cover` sizing is excluded — that's a
  // photo thumbnail/avatar. `keepsColours` = the bg-image heuristic wants it
  // counter-inverted (true colours); see isStateGlyphRow for when a glyph may
  // still trade that for the accent rendering. Otherwise it would get the plain
  // page invert, which the accent filter only improves on (it differs just for
  // bright chromatic pixels).
  function isAccentBgGlyph(el, cs, bg, keepsColours) {
    if (!/url\(/i.test(bg) || /gradient\(/i.test(bg)) return false;
    if (/\bcover\b/i.test(cs.backgroundSize || "")) return false;
    if (el.childElementCount || hasTextContent(el)) return false;
    // A glyph on its own dark plate is a badge the darknative path keeps dark.
    const plate = parseColor(cs.backgroundColor);
    if (plate && plate.a >= 0.5 && luminance(plate) < 0.10) return false;
    if (!isGlyphSized(el)) return false;
    return !keepsColours || isStateGlyphRow(el, cs);
  }

  // The background image is ONE glyph scaled to the element's box (the Maps
  // star: a 14px image on a 14px span), not a cell of a sprite sheet or a tile.
  function bgFitsBox(cs, r) {
    const size = (cs.backgroundSize || "").trim().toLowerCase();
    if (/^(contain|100%( 100%)?)$/.test(size)) return true;
    const m = /^([\d.]+)px(?: ([\d.]+)px)?$/.exec(size);
    if (!m) return false;
    const w = parseFloat(m[1]), h = m[2] ? parseFloat(m[2]) : w;
    return Math.abs(w - r.width) <= GLYPH_SIZE_TOLERANCE &&
           Math.abs(h - r.height) <= GLYPH_SIZE_TOLERANCE;
  }

  // A counter-inverted sprite keeps its TRUE colours, which is what a colour
  // swatch (Amazon's colour facets: a white swatch must stay white), a
  // thumbnail or a lone brand icon needs. Only the member of a colour-coded
  // STATE row trades them for the accent rendering: a single-glyph image
  // fitted to its box, not rounded (avatars are), among ≥3 same-size sibling
  // glyphs that REUSE images (filled/half/empty stars; a strip of distinct
  // thumbnails or swatches doesn't).
  function isStateGlyphRow(el, cs) {
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return false; }
    if (!bgFitsBox(cs, r)) return false;
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    const radiusPx = /%/.test(cs.borderTopLeftRadius) ? radius / 100 * r.width : radius;
    if (radiusPx >= 0.4 * Math.min(r.width, r.height)) return false;
    const row = glyphRow(el, g => {
      if (g.childElementCount || hasTextContent(g)) return false;
      let gcs;
      try { gcs = getComputedStyle(g); } catch (_) { return false; }
      return /url\(/i.test(gcs.backgroundImage || "");
    });
    if (!row) return false;
    const urls = new Set(row.map(g => firstUrl(getComputedStyle(g).backgroundImage)));
    return urls.size < row.length;
  }

  // A mask-image glyph (the shape is the mask, painted in background-color)
  // whose paint is chromatic — a gold mask star.
  function isAccentMaskGlyph(el, cs) {
    if (!maskOf(cs)) return false;
    const bc = parseColor(cs.backgroundColor);
    return !!bc && bc.a >= 0.2 && isChromaticPaint(bc) && isGlyphSized(el);
  }

  // ── Colour-coded glyph rows ──────────────────────────────────────────────
  // Rating stars, signal bars, step dots: a row of same-sized glyphs whose
  // members differ by colour. A NEUTRAL light member of such a row is the "off"
  // state — an empty star beside gold ones. The site drew it faint on a light
  // page, so it must invert WITH the theme into a faint dark glyph; the light-
  // icon rescue would keep it light, as bright as the "on" members.
  const GLYPH_ROW_MIN = 3;
  const GLYPH_ROW_MAX = 12;
  const GLYPH_SIZE_TOLERANCE = 2; // px

  // Same-sized glyphs forming el's row (el included), or null. Looks at el's
  // siblings, or — when el is wrapped alone (<span><svg/></span> ×5) — at the
  // single glyph inside each of its wrapper's siblings.
  function glyphRow(el, isGlyph) {
    let r0;
    try { r0 = el.getBoundingClientRect(); } catch (_) { return null; }
    const sameSize = g => {
      let r;
      try { r = g.getBoundingClientRect(); } catch (_) { return false; }
      return Math.abs(r.width - r0.width) <= GLYPH_SIZE_TOLERANCE &&
             Math.abs(r.height - r0.height) <= GLYPH_SIZE_TOLERANCE;
    };
    const collect = (container, unwrap) => {
      if (!container || container.childElementCount > GLYPH_ROW_MAX * 2) return null;
      const row = [];
      for (const ch of container.children) {
        const g = !unwrap ? ch : (ch.childElementCount === 1 ? ch.firstElementChild : null);
        if (g && isGlyph(g) && sameSize(g)) row.push(g);
      }
      return row.length >= GLYPH_ROW_MIN && row.length <= GLYPH_ROW_MAX && row.includes(el)
        ? row : null;
    };
    const p = el.parentElement;
    return collect(p, false) ||
      (p && p.childElementCount === 1 ? collect(p.parentElement, true) : null);
  }

  const SVG_SHAPES = "path,polygon,circle,rect,ellipse,use,line,polyline";

  // Shape identity of an SVG glyph: viewBox + first shape's geometry. Members
  // of a rating row share it; a toolbar's different icons don't — so a row of
  // light toolbar icons with one coloured icon is NOT mistaken for a rating.
  function svgShapeKey(svg) {
    let s = null;
    try { s = svg.querySelector(SVG_SHAPES); } catch (_) {}
    if (!s) return null;
    return (svg.getAttribute("viewBox") || "") + "|" + s.tagName + "|" +
      (s.getAttribute("d") || s.getAttribute("points") || s.getAttribute("href") ||
       s.getAttribute("xlink:href") || "");
  }

  // Colours an SVG glyph paints with: its own fill/stroke and those of its
  // first few shapes (computed, so currentColor is resolved).
  function svgPaints(svg, cs) {
    const out = [];
    const add = v => { const c = parseColor(v); if (c && c.a >= 0.2) out.push(c); };
    add(cs.fill);
    if (cs.stroke !== "none") add(cs.stroke);
    let shapes = [];
    try { shapes = svg.querySelectorAll(SVG_SHAPES); } catch (_) {}
    for (let i = 0; i < shapes.length && i < 4; i++) {
      let s;
      try { s = getComputedStyle(shapes[i]); } catch (_) { continue; }
      add(s.fill);
      if (s.stroke !== "none") add(s.stroke);
    }
    return out;
  }

  function isOffStateSvg(el) {
    const key = svgShapeKey(el);
    if (!key) return false;
    const row = glyphRow(el, g => g.tagName.toLowerCase() === "svg");
    if (!row) return false;
    return row.some(m => {
      if (m === el || svgShapeKey(m) !== key) return false;
      let mcs;
      try { mcs = getComputedStyle(m); } catch (_) { return false; }
      return svgPaints(m, mcs).some(isChromaticPaint);
    });
  }

  function isOffStateMask(el, mask) {
    const row = glyphRow(el, g => {
      let gcs;
      try { gcs = getComputedStyle(g); } catch (_) { return false; }
      return maskOf(gcs) === mask;
    });
    if (!row) return false;
    return row.some(m => {
      if (m === el) return false;
      const bc = parseColor(getComputedStyle(m).backgroundColor);
      return !!bc && bc.a >= 0.2 && isChromaticPaint(bc);
    });
  }

  // Sprite rows can only be judged by sampling the siblings' images (async,
  // cached). Resolves true when a sibling's sprite is colourful.
  function isOffStateSprite(el) {
    const row = glyphRow(el, g => {
      if (g.childElementCount || hasTextContent(g)) return false;
      let gcs;
      try { gcs = getComputedStyle(g); } catch (_) { return false; }
      return /url\(/i.test(gcs.backgroundImage || "");
    });
    if (!row) return Promise.resolve(false);
    const own = firstUrl(getComputedStyle(el).backgroundImage);
    const urls = new Set();
    for (const m of row) {
      if (m === el) continue;
      const u = firstUrl(getComputedStyle(m).backgroundImage);
      if (u && u !== own) urls.add(u);
    }
    if (!urls.size) return Promise.resolve(false);
    return Promise.all([...urls].map(getIconStats))
      .then(stats => stats.some(s => s && s.mono === false));
  }

  // Small vector-SVG UI glyphs. Two rescues from what the page invert alone
  // would do:
  //   • ACCENT — painted in a BRIGHT colour (gold star, amber warning): the
  //     invert would darken it (gold → brown). The accent filter keeps its hue
  //     lit while still inverting its neutral parts.
  //   • LIGHT_ICON — a NEUTRAL glyph that is ALREADY light (a prefers-dark icon
  //     on a light-themed Gmail): the invert flips it to black-on-dark, so it is
  //     counter-inverted back to light — unless it is the "off" member of a
  //     colour-coded row (an empty star), which must stay faint.
  function classifySvgGlyph(el, cs) {
    if (el.tagName.toLowerCase() !== "svg") return;
    const clear = () => {
      if (el.hasAttribute(LIGHT_ICON_ATTR)) el.removeAttribute(LIGHT_ICON_ATTR);
      setAccent(el, false);
    };
    // Inside a kept-dark wrapper the icon already shows its true (light) colour
    // via the wrapper's counter-invert; a tagged bg-image SVG is handled by the
    // media rules. Don't double-handle either.
    if (el.hasAttribute(BG_IMAGE_ATTR) || hasNativeDarkAncestor(el)) { clear(); return; }
    if (!isGlyphSized(el)) { clear(); return; }
    let hasRaster = false;
    try { hasRaster = !!el.querySelector("image"); } catch (_) {}
    if (hasRaster) { clear(); return; } // raster <image> → covered by media rules
    if (accentContextOk(el) && svgPaints(el, cs).some(isBrightChromatic)) {
      if (el.hasAttribute(LIGHT_ICON_ATTR)) el.removeAttribute(LIGHT_ICON_ATTR);
      setAccent(el, true);
      return;
    }
    setAccent(el, false);
    // Effective paint colour: a non-black explicit fill, else the (currentColor)
    // text colour — what actually paints a currentColor glyph.
    let paint = parseColor(cs.fill);
    const fillBlackish = !paint || paint.a < 0.2 || (paint.r < 24 && paint.g < 24 && paint.b < 24);
    if (fillBlackish) paint = parseColor(cs.color);
    if (paint && paint.a >= 0.2 && luminance(paint) > LIGHT_ICON_MIN_LUM &&
        !(!isChromaticPaint(paint) && isOffStateSvg(el))) {
      if (!el.hasAttribute(LIGHT_ICON_ATTR)) el.setAttribute(LIGHT_ICON_ATTR, "1");
    } else if (el.hasAttribute(LIGHT_ICON_ATTR)) {
      el.removeAttribute(LIGHT_ICON_ATTR);
    }
  }

  // Light background-image UI glyph rescue. The bg-image counterpart of
  // classifySvgGlyph: a small no-`<img>` element whose background-image SAMPLES
  // light (Gmail's prefers-dark nav label/folder sprites, served from gstatic
  // with CORS) would be flipped to black-on-dark by the page invert. Sample its
  // pixels (async, cached) and counter-invert the light ones — except a
  // colourful sprite already tagged ACCENT (the accent filter keeps it lit
  // without the counter-invert's washed-out round trip) and the neutral "off"
  // member of a colour-coded sprite row (an empty star).
  function classifyLightBgIcon(el, bg) {
    const url = firstUrl(bg);
    if (!url) { if (el.hasAttribute(LIGHT_ICON_ATTR)) el.removeAttribute(LIGHT_ICON_ATTR); return; }
    const tag = on => {
      if (!el.isConnected || !themeActive()) return;
      if (on) { if (!el.hasAttribute(LIGHT_ICON_ATTR)) el.setAttribute(LIGHT_ICON_ATTR, "1"); }
      else if (el.hasAttribute(LIGHT_ICON_ATTR)) el.removeAttribute(LIGHT_ICON_ATTR);
    };
    const decide = s => {
      if (!el.isConnected) return;
      if (!s || s.lum == null || s.lum <= LIGHT_ICON_MIN_LUM) { tag(false); return; }
      if (!s.mono) { tag(!el.hasAttribute(ACCENT_ATTR)); return; }
      tag(true);
      isOffStateSprite(el).then(off => { if (off) tag(false); }, () => {});
    };
    if (iconStatsCache.has(url)) decide(iconStatsCache.get(url));
    else getIconStats(url).then(decide);
  }

  // Light UI-icon rescue for non-SVG, non-<img> elements. Mixed prefers-dark
  // themes paint small glyphs light through several mechanisms; detect each and
  // counter-invert the LIGHT ones so the page invert doesn't bury them on the
  // dark background. Cheap-rejects anything that isn't an icon candidate before
  // touching layout, so it stays affordable on big pages.
  function classifyLightIconNonSvg(el, cs) {
    const clear = () => { if (el.hasAttribute(LIGHT_ICON_ATTR)) el.removeAttribute(LIGHT_ICON_ATTR); };
    const ownBg = cs.backgroundImage;
    const hasOwnBg = ownBg && ownBg !== "none" && /url\(/i.test(ownBg);
    const mask = maskOf(cs);
    const pointer = cs.cursor === "pointer";
    // Not an icon candidate (no own bg-image, no mask, not a clickable glyph that
    // might paint via a pseudo-element) → bail without forcing layout.
    if (!hasOwnBg && !mask && !pointer) { clear(); return; }
    if (!isGlyphSized(el)) { clear(); return; }
    // (a) mask-image glyph: the shape is the mask, painted in background-color.
    //     A chromatic paint is an accent glyph (processElement tags it); only a
    //     neutral LIGHT paint needs the counter-invert — unless it's the "off"
    //     member of a colour-coded row.
    if (mask) {
      const bc = parseColor(cs.backgroundColor);
      if (bc && bc.a >= 0.2) {
        if (!isChromaticPaint(bc) && luminance(bc) > LIGHT_ICON_MIN_LUM &&
            !isOffStateMask(el, mask)) {
          if (!el.hasAttribute(LIGHT_ICON_ATTR)) el.setAttribute(LIGHT_ICON_ATTR, "1");
        } else clear();
        return;
      }
    }
    // (b) own background-image glyph → sample its pixels.
    if (hasOwnBg) { classifyLightBgIcon(el, ownBg); return; }
    // (c) glyph painted by a pseudo-element background-image (the Gmail row star
    //     renders its sprite via ::before). Counter-inverting the element flips
    //     the pseudo too. Only checked for small clickable glyphs.
    if (pointer) {
      for (const pe of ["::before", "::after"]) {
        let pbg = "none";
        try { pbg = getComputedStyle(el, pe).backgroundImage; } catch (_) {}
        if (pbg && pbg !== "none" && /url\(/i.test(pbg)) { classifyLightBgIcon(el, pbg); return; }
      }
    }
    clear();
  }

  // ── Large light canvases (the navigable map-surface case) ────────────────
  // A canvas is counter-inverted by default so photos/video/game frames keep
  // their true colours. That leaves a LIGHT raster surface the user navigates —
  // Google Maps' light map tiles — bright on the otherwise-dark page. Sample the
  // canvas: a predominantly-LIGHT large canvas is tagged to invert WITH the theme
  // (drop the counter-invert) so it darkens; a DARK one (a native dark map, a
  // dark game) keeps its counter-invert so it stays true. Decided per-sample, so
  // it self-corrects when the map switches between light and satellite/dark.

  // Min fraction of the viewport a canvas must cover to count as a navigable
  // background surface rather than a content graphic (chart, sprite, thumbnail)
  // whose colours should be preserved.
  const MAP_CANVAS_MIN_AREA_RATIO = 0.25;
  // Opaque-pixel mean luminance at/above which the canvas is a LIGHT surface
  // worth darkening. Matches the page dark/light boundary (DARK_LUM_MAX) so
  // "not neutral-dark ⇒ invert it" stays consistent.
  const LIGHT_CANVAS_MIN_LUM = 0.22;
  // Need this fraction of sampled pixels opaque to trust the verdict; a
  // near-empty read (WebGL buffer not preserved, a pre-render frame) is
  // inconclusive → leave the tag as-is (safe: keeps the default true colours).
  const CANVAS_MIN_OPAQUE_FRAC = 0.30;
  // Passive (mutation/scan) re-sample floor; interaction re-checks force a fresh
  // sample past this so a just-switched map style is reflected at once.
  const CANVAS_SAMPLE_THROTTLE_MS = 500;
  const CANVAS_SAMPLE_DIM = 32;
  const canvasSampleAt = new WeakMap(); // canvas -> last sample timestamp (ms)

  // Synchronously sample a canvas's opaque pixels → { lum, opaqueFrac } or null.
  // Downscales via drawImage into a tiny 2D canvas, then reads it back. A
  // cross-origin-tainted or unreadable canvas throws → null (caller leaves the
  // tag unchanged). Cheap: the read target is CANVAS_SAMPLE_DIM².
  function sampleCanvas(cv) {
    try {
      if (!cv.width || !cv.height) return null;
      const s = document.createElement("canvas");
      s.width = CANVAS_SAMPLE_DIM; s.height = CANVAS_SAMPLE_DIM;
      const ctx = s.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(cv, 0, 0, CANVAS_SAMPLE_DIM, CANVAS_SAMPLE_DIM);
      const d = ctx.getImageData(0, 0, CANVAS_SAMPLE_DIM, CANVAS_SAMPLE_DIM).data; // throws if tainted
      let sr = 0, sg = 0, sb = 0, n = 0, total = 0;
      for (let i = 0; i < d.length; i += 4) {
        total++;
        if (d[i + 3] <= 20) continue; // skip (near-)transparent pixels
        sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++;
      }
      if (!n) return { lum: 0, opaqueFrac: 0 };
      return { lum: luminance({ r: sr / n, g: sg / n, b: sb / n }), opaqueFrac: n / total };
    } catch (_) { return null; } // tainted / not drawable
  }

  // Classify one canvas. `force` bypasses the per-canvas sample throttle (used
  // by the interaction re-check so a light↔satellite switch is picked up at
  // once). Tags INVERT_MEDIA_ATTR on a predominantly-light large canvas, clears
  // it on a dark/inconclusive one. Skipped under "force natural images".
  function classifyMapCanvas(cv, force) {
    if (document.documentElement.hasAttribute(DA.NOIMG_ATTR)) return;
    let r;
    try { r = cv.getBoundingClientRect(); } catch (_) { return; }
    const vw = window.innerWidth | 0, vh = window.innerHeight | 0;
    if (vw < 50 || vh < 50) return;
    if (r.width * r.height < vw * vh * MAP_CANVAS_MIN_AREA_RATIO) {
      if (cv.hasAttribute(INVERT_MEDIA_ATTR)) cv.removeAttribute(INVERT_MEDIA_ATTR);
      return; // too small to be a navigable surface — keep true colours
    }
    const now = Date.now();
    if (!force && now - (canvasSampleAt.get(cv) || 0) < CANVAS_SAMPLE_THROTTLE_MS) return;
    canvasSampleAt.set(cv, now);
    const s = sampleCanvas(cv);
    if (!s || s.opaqueFrac < CANVAS_MIN_OPAQUE_FRAC) return; // inconclusive — leave tag as-is
    if (s.lum >= LIGHT_CANVAS_MIN_LUM) {
      if (!cv.hasAttribute(INVERT_MEDIA_ATTR)) cv.setAttribute(INVERT_MEDIA_ATTR, "1");
    } else if (cv.hasAttribute(INVERT_MEDIA_ATTR)) {
      cv.removeAttribute(INVERT_MEDIA_ATTR);
    }
  }

  // Re-sample every large canvas now (interaction re-check entry point), forcing
  // past the throttle so a just-switched map style is reflected immediately.
  function reclassifyLargeCanvases() {
    let list;
    try { list = document.getElementsByTagName("canvas"); } catch (_) { return; }
    for (let i = 0; i < list.length && i < 8; i++) classifyMapCanvas(list[i], true);
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
      const isSvg = el.tagName.toLowerCase() === "svg";
      let accentGlyph = false;
      if (isBgIcon) {
        if (el.hasAttribute(BG_IMAGE_ATTR)) el.removeAttribute(BG_IMAGE_ATTR);
        classifyBgIcon(el, bg);
      } else {
        const keepsColours = hasBgImage && (forceImages || shouldReinvertBgImage(el, cs, bg));
        // A glyph-sized sprite (the Maps rating star) or a chromatic mask glyph
        // is colour-coded: it renders through the accent filter rather than the
        // counter-invert (washes gold to peach, keeps an empty star light) or
        // the plain invert (turns gold brown). SVG glyphs: classifySvgGlyph.
        accentGlyph = !isSvg && el.tagName !== "IMG" &&
            ((hasBgImage && !forceImages && isAccentBgGlyph(el, cs, bg, keepsColours)) ||
             isAccentMaskGlyph(el, cs)) &&
            accentContextOk(el);
        if (keepsColours && !accentGlyph) {
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
      if (!isSvg) setAccent(el, accentGlyph);
      // Light UI icon rescue (mixed prefers-dark themes paint some glyphs light;
      // the page invert would flip them to black-on-dark). SVGs read their colour
      // from CSS; other small glyphs are detected via their background-image
      // (sampled), mask-image (glyph = background-color) or a pseudo-element
      // background-image (the Gmail row star) — see classifyLightIconNonSvg.
      // SVG glyphs painted in a bright colour are tagged ACCENT there too.
      classifySvgGlyph(el, cs);
      if (el.tagName !== "IMG" && !isSvg &&
          !el.hasAttribute(BG_IMAGE_ATTR) && !el.hasAttribute(BG_ICON_ATTR)) {
        classifyLightIconNonSvg(el, cs);
      }
      // A large LIGHT canvas (the Google Maps map surface) is darkened WITH the
      // theme instead of kept true-colour; a dark canvas keeps its true colours.
      if (el.tagName === "CANVAS") classifyMapCanvas(el, false);
      // A positioned high-z overlay nested in a counter-filtered wrapper is
      // trapped by the wrapper's filter-induced stacking context — lift the
      // wrapper so the overlay still paints above later-DOM content
      // (the Skyscanner/booking.com calendar popover).
      maybeLiftTrappedOverlay(el, cs);
      // An accent glyph is fully rendered by the accent filter; a darknative
      // counter-invert on top would fight it.
      if (!el.hasAttribute(ACCENT_ATTR) && tagNativeDarkBg(el, cs)) return;
      if (el.hasAttribute(NATIVE_DARK_ATTR)) {
        el.removeAttribute(NATIVE_DARK_ATTR);
      }
      // Both counter-filter tags are gone → the wrapper has no filter, so a
      // recorded z-lift would leave behind a stacking context the site never
      // had. Restore its original stacking.
      if (el.hasAttribute(ZLIFT_ATTR) && !el.hasAttribute(BG_IMAGE_ATTR)) {
        revertZLiftOn(el);
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

  // The pure classification tags — inert without our stylesheet, but a hard
  // disable must leave the DOM exactly as the site built it. (Tags that also
  // rewrote inline style are restored by revertPreLightened / revertZLifts.)
  const CLASS_TAGS = [
    BG_IMAGE_ATTR, BG_ICON_ATTR, NATIVE_DARK_ATTR, LIGHT_ICON_ATTR,
    INVERT_MEDIA_ATTR, ACCENT_ATTR
  ];
  const CLASS_TAGS_SEL = CLASS_TAGS.map(a => `[${a}]`).join(",");

  function clearTags(root) {
    const scope = root && root.querySelectorAll ? root : document;
    for (const s of withShadowScopes(scope)) {
      for (const el of s.querySelectorAll(CLASS_TAGS_SEL)) {
        for (const a of CLASS_TAGS) el.removeAttribute(a);
      }
    }
  }

  DA.elements = {
    hasNativeDarkAncestor,
    hasVisibleLightDescendant,
    tagNativeDarkBg,
    preLightenIfSaturated,
    revertPreLightened,
    revertZLifts,
    rescueTextColor,
    revertRescuedText,
    processElement,
    classifyMapCanvas,
    reclassifyLargeCanvases,
    markBackgroundImageElements,
    processShadowRoot,
    clearShadowStyles,
    clearTags,
    tagLightIslands,
    clearLightIslands
  };
})(DA);
