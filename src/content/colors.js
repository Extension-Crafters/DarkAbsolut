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

  DA.colors = {
    parseColor,
    luminance,
    saturation,
    rgbToHsl,
    hslToRgbString,
    isNeutralDark,
    nativeDarkMaxSat,
    DARK_LUM_MAX
  };
})(DA);
