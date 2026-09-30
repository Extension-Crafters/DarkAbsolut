// DarkAbsolut — pure color math.
//
// Isolated here because none of these helpers touch the DOM or the
// extension lifecycle. They are cheap, deterministic, and easy to unit-test
// in isolation.

(function (DA) {
  "use strict";

  // Parse any CSS rgb()/rgba() color string into an {r,g,b,a} record.
  function parseColor(str) {
    if (!str) return null;
    const m = str.match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const parts = m[1].split(",").map(s => parseFloat(s.trim()));
    if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return null;
    const [r, g, b, a = 1] = parts;
    return { r, g, b, a };
  }

  // Relative luminance per WCAG.
  function luminance({ r, g, b }) {
    const toLin = c => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
  }

  // HSL saturation in [0,1]. Real dark themes use near-neutral grays/blacks;
  // saturated branded colors (e.g. #2980b9) should still be inverted.
  function saturation({ r, g, b }) {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return 0;
    return d / (1 - Math.abs(2 * l - 1));
  }

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

  // Max luminance a background may have and still count as a real dark theme.
  const DARK_LUM_MAX = 0.22;

  // Treat as a real dark theme only if the background is dark AND
  // sufficiently neutral. Very dark colors are allowed higher saturation
  // because a chromatic near-black still reads as dark (e.g. rgb(9,26,35)
  // redis-ink-900, luminance ≈ 0.009, HSL saturation ≈ 0.59 — the formula
  // overstates saturation at near-zero lightness).
  function isNeutralDark(c) {
    if (!c) return false;
    const lum = luminance(c);
    if (lum >= DARK_LUM_MAX) return false;
    return saturation(c) < nativeDarkMaxSat(lum);
  }

  // Shared adaptive saturation ceiling used by both isNeutralDark and the
  // element-level tagNativeDarkBg.
  function nativeDarkMaxSat(lum) {
    // Perceptually near-black: at this luminance the colour reads as black and
    // HSL saturation is meaningless (a few units in one channel blow it up to
    // ~1.0), so allow ANY saturation. Without this, a very-dark but saturated
    // theme background is mistaken for an invertible accent colour and the whole
    // page gets inverted to light — k4g.com's bg rgb(0,3,38) (luminance ≈ 0.002,
    // HSL saturation ≈ 1.0) was flipped bright this way.
    if (lum < 0.015) return 1.01; // > 1 so even saturation 1.0 passes
    return lum < 0.04 ? 0.80 : lum < 0.10 ? 0.45 : 0.25;
  }

  // ── Page-filter model ────────────────────────────────────────────────────
  // With the luma weights of the CSS hue-rotate() matrix (Filter Effects spec),
  // the page filter `invert(1) hue-rotate(180deg)` reduces EXACTLY to a uniform
  // per-channel shift:
  //     out = in + (1 − 2·filterLuma(in))        (then clamped to [0,1])
  // It keeps the chroma vector (hue + colourfulness) and mirrors luma around
  // 0.5. So mid-tones keep their hue and brightness, but a BRIGHT accent (gold,
  // yellow, lime) is pushed dark: gold #fbbc04 renders brown rgb(130,67,0). And
  // a vivid gold can never be displayed under the page filter at all — no
  // in-gamut source has gold's chroma at the mirrored (low) luma — which is why
  // counter-inverting a gold icon washes it to pale peach instead of restoring
  // it. tests/test-color-model.js checks this model pixel-exact in the browser.
  function filterLuma({ r, g, b }) {
    return (0.213 * r + 0.715 * g + 0.072 * b) / 255;
  }

  const clamp255 = v => Math.max(0, Math.min(255, Math.round(v)));

  function pageFilter(c) {
    const s = 255 * (1 - 2 * filterLuma(c));
    return { r: clamp255(c.r + s), g: clamp255(c.g + s), b: clamp255(c.b + s),
             a: c.a == null ? 1 : c.a };
  }

  // Absolute chroma: max − min channel spread, 0..1. Unlike HSL saturation it
  // doesn't explode near white or black, so it is the reliable "is this colour
  // actually colourful" signal (gold star ≈ 0.97, light-gray empty star ≈ 0.06).
  function chroma({ r, g, b }) {
    return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  }

  function contrastRatio(l1, l2) {
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function toHex({ r, g, b }) {
    return [r, g, b].map(v => clamp255(v).toString(16).padStart(2, "0")).join("");
  }

  // A colour with c's hue and as much of its chroma as fits, at filter-luma
  // `lum`. With `viaFilter` the chroma is also capped so the colour's page-
  // filtered image (luma 1 − lum) stays in gamut: the result is then a SOURCE
  // value that the page filter renders as c's hue at luma 1 − lum, unclipped
  // (no hue drift).
  function hueKeeping(c, lum, viaFilter) {
    const L = filterLuma(c);
    const d = [c.r / 255 - L, c.g / 255 - L, c.b / 255 - L];
    let k = 1;
    const fit = l => {
      for (const di of d) {
        if (di > 1e-6) k = Math.min(k, (1 - l) / di);
        else if (di < -1e-6) k = Math.min(k, l / -di);
      }
    };
    fit(lum);
    if (viaFilter) fit(1 - lum);
    k = Math.max(0, k);
    return { r: clamp255((lum + k * d[0]) * 255), g: clamp255((lum + k * d[1]) * 255),
             b: clamp255((lum + k * d[2]) * 255), a: 1 };
  }

  // Displayed luma given to a fully chromatic BRIGHT colour by the accent
  // treatment (the SVG accent filter in styles.js, accentFillSource below):
  // high enough to read as a lit accent on the dark page, low enough to keep
  // real chroma (the page filter can only render strong chroma near luma 0.5).
  // Gold #fbbc04 renders ≈ rgb(183,146,37) instead of brown.
  const ACCENT_LUMA = 0.58;
  // Chroma ramp of the accent treatment: below MIN a colour is neutral and
  // inverts with the theme; from FULL up it is fully an accent; linear between.
  const ACCENT_CHROMA_MIN = 0.08;
  const ACCENT_CHROMA_FULL = 0.30;

  // Source colour for a bright accent FILL (a rating bar, a status dot) so the
  // page filter renders its own hue at ACCENT_LUMA instead of darkening it.
  // Null when the plain filter already does fine: dark and mid tones (mirrored
  // luma ≥ 0.5 → they come out lighter, hue kept) and near-neutral colours.
  function accentFillSource(c) {
    const L = filterLuma(c);
    if (L <= 0.5 || chroma(c) < ACCENT_CHROMA_FULL) return null;
    return hueKeeping(c, 1 - Math.min(L, ACCENT_LUMA), true);
  }

  // Source colour for colour-coded TEXT that renders too dark on its dark
  // backdrop (a gold ★, an amber label): the least-changed colour of the same
  // hue whose rendering reaches `minContrast` against `bgLum` (luminance of the
  // rendered backdrop). `inverted` = the text sits under an odd number of
  // invert filters, so the value is chosen for the page filter to render it
  // right; otherwise it renders as-is. Null when unattainable.
  // Through the page filter a bright colour starts at the accent luma, like an
  // accent-filtered glyph: a gold ★ character and a gold ★ sprite then render
  // the same gold.
  function accentTextSource(c, bgLum, minContrast, inverted) {
    const render = lum => {
      const src = hueKeeping(c, inverted ? 1 - lum : lum, inverted);
      return { src, shown: inverted ? pageFilter(src) : src };
    };
    const ok = lum => contrastRatio(luminance(render(lum).shown), bgLum) >= minContrast;
    const L = filterLuma(c);
    let lo = inverted ? Math.max(1 - L, Math.min(L, ACCENT_LUMA)) : L, hi = 1;
    if (!ok(hi)) return null;
    if (ok(lo)) return render(lo).src;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) hi = mid; else lo = mid;
    }
    return render(hi).src;
  }

  DA.colors = {
    parseColor,
    luminance,
    saturation,
    rgbToHsl,
    hslToRgbString,
    isNeutralDark,
    nativeDarkMaxSat,
    filterLuma,
    pageFilter,
    chroma,
    contrastRatio,
    toHex,
    hueKeeping,
    accentFillSource,
    accentTextSource,
    DARK_LUM_MAX,
    ACCENT_LUMA,
    ACCENT_CHROMA_MIN,
    ACCENT_CHROMA_FULL
  };
})(DA);
