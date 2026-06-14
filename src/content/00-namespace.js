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
DA.BG_IMAGE_ATTR = "data-darkabsolut-bg";
DA.NATIVE_DARK_ATTR = "data-darkabsolut-darknative";
DA.NATIVE_LIGHT_ATTR = "data-darkabsolut-lightnative";
DA.NOIMG_ATTR = "data-darkabsolut-noimg";
