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
