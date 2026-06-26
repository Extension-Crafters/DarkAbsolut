// DarkAbsolut — persisted settings access.

export const DEFAULTS = {
  // Master kill switch for the whole extension.
  globalEnabled: true,

  // Working mode (toolbar-button behaviour + auto-apply policy):
  //   "filter" — apply per-site (the default): each feature resolves
  //              per-host → per-subdomain → its global default below.
  //   "once"   — never auto-apply; clicking the toolbar button dark-modes the
  //              current page just for this page load.
  //   "toggle" — clicking the toolbar button flips dark mode on/off globally
  //              (icon shows a sun when off). Ignores per-site rules.
  mode: "filter",
  // For "toggle" mode: is dark mode currently on?
  toggleOn: true,

  // Per-feature GLOBAL defaults — used by "filter" mode for any site that has
  // no per-host/per-subdomain rule (the "global" column in the popup).
  globalDarkMode: true,       // invert light pages everywhere by default
  globalNaturalImages: false, // keep images' real colours everywhere by default
  globalSoftGray: false,      // soft dark-gray contrast everywhere by default

  // Per-site rule lists. Each entry: { domain, includeSubdomains, on }
  //   on = whether the FEATURE is enabled for that host (an explicit override of
  //   the global default). Names kept for storage/import back-compat:
  //     disabledDomains          → dark-mode rules     (legacy entry ⇒ on:false)
  //     noImageInversionDomains  → natural-image rules (legacy entry ⇒ on:true)
  //     enhanceContrastDomains   → soft-gray rules     (legacy entry ⇒ on:true)
  disabledDomains: [],
  noImageInversionDomains: [],
  enhanceContrastDomains: []
};

const MODES = ["filter", "once", "toggle"];

// Normalise a rule list: lowercase domains, coerce flags, drop dupes, and
// backfill `on` for legacy entries (which predate per-feature globals) using
// each list's historic meaning so old saved settings keep behaving the same.
function normalizeRules(list, legacyOn) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (!e || typeof e.domain !== "string") continue;
    const domain = e.domain.trim().toLowerCase();
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push({
      domain,
      includeSubdomains: !!e.includeSubdomains,
      on: typeof e.on === "boolean" ? e.on : legacyOn
    });
  }
  return out;
}

function normalizeState(s) {
  const out = { ...DEFAULTS, ...s };
  if (!MODES.includes(out.mode)) out.mode = "filter";
  out.globalEnabled = !!out.globalEnabled;
  out.toggleOn = !!out.toggleOn;
  out.globalDarkMode = !!out.globalDarkMode;
  out.globalNaturalImages = !!out.globalNaturalImages;
  out.globalSoftGray = !!out.globalSoftGray;
  out.disabledDomains = normalizeRules(out.disabledDomains, false);
  out.noImageInversionDomains = normalizeRules(out.noImageInversionDomains, true);
  out.enhanceContrastDomains = normalizeRules(out.enhanceContrastDomains, true);
  return out;
}

export async function getState() {
  const data = await chrome.storage.local.get(DEFAULTS);
  return normalizeState(data);
}

export async function setState(patch) {
  const cur = await getState();
  const next = normalizeState({ ...cur, ...patch });
  await chrome.storage.local.set(next);
  return next;
}

// Replace everything we own with `next`. Used by IMPORT_SETTINGS so that
// any key missing from the imported payload is reset to its default.
export async function replaceState(next) {
  const clean = normalizeState(next);
  await chrome.storage.local.clear();
  await chrome.storage.local.set(clean);
  return clean;
}
