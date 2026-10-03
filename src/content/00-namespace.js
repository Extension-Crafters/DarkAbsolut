// DarkAbsolut — content-script shared namespace.
//
// Every content-script file declared in the manifest is a classic script
// that shares the same isolated-world global scope. The first script
// seeds a single `DA` namespace that the other modules extend. This keeps
// the sources split by concern while avoiding any build step.

// eslint-disable-next-line no-var
var DA = (typeof DA !== "undefined" && DA) || {};

DA.STYLE_ID = "darkabsolut-style";
DA.ATTR = "data-darkabsolut";
DA.ORIG_ATTR = "data-darkabsolut-bg-orig";
DA.ORIG_COLOR_ATTR = "data-darkabsolut-color-orig";
DA.RESCUE_COLOR_ATTR = "data-darkabsolut-rtext";
DA.BG_IMAGE_ATTR = "data-darkabsolut-bg";
DA.BG_ICON_ATTR = "data-darkabsolut-bgicon";
DA.NATIVE_DARK_ATTR = "data-darkabsolut-darknative";
DA.NATIVE_LIGHT_ATTR = "data-darkabsolut-lightnative";
DA.NOIMG_ATTR = "data-darkabsolut-noimg";
DA.HC_ATTR = "data-darkabsolut-hc";
// A vector-SVG UI icon that is ALREADY light (e.g. a prefers-color-scheme:dark
// glyph on a page whose theme is light — the Gmail header). The page-level
// invert would flip it to black-on-dark; this marks it for a counter-invert so
// it stays light. The mirror of BG_ICON_ATTR (which rescues DARK bg-icons).
DA.LIGHT_ICON_ATTR = "data-darkabsolut-lighticon";
// A LARGE canvas whose sampled pixels are predominantly LIGHT — a light raster
// surface the user navigates rather than a photo to view in true colour (the
// Google Maps map canvas). Media is counter-inverted by default to keep true
// colours, which leaves such a canvas bright on the dark UI. This marks it to
// drop the counter-invert so the page filter darkens it WITH the theme; a canvas
// that samples dark (a native dark map / dark game) is left counter-inverted so
// it keeps its real colours. Decided per-sample so it self-corrects when the map
// switches between light and satellite/dark styles.
// Also set on a large, featureless LIGHT <img> used as a section backdrop behind
// dark text (microsoft.com's hero) — same reasoning, same rule.
DA.INVERT_MEDIA_ATTR = "data-darkabsolut-invertmedia";
// An element whose ::before / ::after paints a large DARK surface (a scrim
// over a hero photo, a brand gradient, a coloured nav bar). A pseudo-element
// can't carry a tag of its own, so its HOST lists which ones keep their
// colours (space-separated: "before", "after", plus "solid" when one is
// opaque enough to be the backdrop of the text); the page filter would
// otherwise turn that dark paint into a light wash.
DA.PSEUDO_BG_ATTR = "data-darkabsolut-pbg";
// A counter-filtered wrapper ([darknative]/[bg]) whose filter-induced stacking
// context traps a positioned overlay's z-index (the Skyscanner calendar
// popover inside the dark search hero). The wrapper's own z-index is lifted
// (inline style) to the overlay's so the overlay keeps painting above
// later-DOM content. Value = the z-index applied; the -orig attr preserves the
// element's original inline position/z-index for restore on disable.
DA.ZLIFT_ATTR = "data-darkabsolut-zlift";
DA.ZLIFT_ORIG_ATTR = "data-darkabsolut-zlift-orig";
// A small UI glyph whose colours carry meaning (a rating star sprite, a
// coloured status icon). Such a glyph is rendered through the SVG "accent"
// filter (styles.js) instead of the plain page invert or the counter-invert:
// its NEUTRAL pixels invert with the theme (an empty light-gray star becomes a
// faint dark one) while its CHROMATIC pixels keep their hue and stay bright (a
// gold star stays gold instead of turning brown, or pale peach once counter-
// inverted). Without it the Google Maps rating stars rendered filled and empty
// alike ("everything looks 5-star").
DA.ACCENT_ATTR = "data-darkabsolut-accent";
DA.FILTER_DEFS_ID = "darkabsolut-filters";
DA.ACCENT_FILTER_ID = "darkabsolut-accent";
// The ORIGINAL computed background-color of an element whose background we
// rewrote (pre-lightened surface, accent fill, neutralised scrim). The inline
// original kept in ORIG_ATTR is usually empty, so this is what lets the text
// rescue compare against the colour the site actually designed for.
DA.BG_SRC_ATTR = "data-darkabsolut-bg-src";
