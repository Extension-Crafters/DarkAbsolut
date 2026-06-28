// DarkAbsolut — persisted settings access.

// Dynamic-DOM re-analyse throttle bounds (ms). The content script waits this
// long for a page to stop mutating before re-theming the changed nodes (a
// trailing-edge debounce). Higher = fewer, lazier passes — smoother on heavy
// pages (a streaming Google AI overview on a slow phone) at the cost of new
// content staying un-themed a little longer. Keep in sync with popup/shared.js
// and src/content/controller.js.
export const THROTTLE_DEFAULT = 250;
export const THROTTLE_MIN = 60;
export const THROTTLE_MAX = 5000;

// Coerce any value to a whole-millisecond delay inside [MIN, MAX]; non-numbers
// fall back to the default (so a missing/garbage value never breaks the page).
export function clampDelay(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return THROTTLE_DEFAULT;
  return Math.min(THROTTLE_MAX, Math.max(THROTTLE_MIN, n));
}

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
  enhanceContrastDomains: [],

  // Performance: how long (ms) the content script waits for the DOM to go quiet
  // before re-theming changed nodes. `globalThrottleDelay` is the default for
  // every site; `throttleDelayDomains` holds per-host overrides, each entry:
  //   { domain, includeSubdomains, ms }
  globalThrottleDelay: THROTTLE_DEFAULT,
  throttleDelayDomains: [],

  // User-recorded keyboard shortcut that toggles dark mode on/off for the
  // current site (flips its per-host `disabledDomains` rule). `null` when unset.
  // Shape: { ctrl, alt, altGr, shift, meta, code, key } where `code` is the
  // KeyboardEvent.code of the main (non-modifier) key and the booleans are the
  // required modifier state. A valid binding needs at least one qualifying
  // modifier (ctrl / alt / altGr / meta) plus a non-modifier main key.
  toggleShortcut: null
};

// Codes that are themselves modifier keys — never valid as the shortcut's main
// key. Keep in sync with the content script's matcher (controller.js).
const MODIFIER_CODE_RE =
  /^(?:Control|Alt|Shift|Meta)(?:Left|Right)$|^AltGraph$|^CapsLock$/;

// Validate / coerce a recorded shortcut to the canonical shape, or null if it
// isn't a usable binding (no main key, a modifier-only "main" key, or no
// qualifying modifier held).
function normalizeShortcut(sc) {
  if (!sc || typeof sc !== "object") return null;
  const code = typeof sc.code === "string" ? sc.code : "";
  if (!code || MODIFIER_CODE_RE.test(code)) return null;
  const out = {
    ctrl: !!sc.ctrl,
    alt: !!sc.alt,
    altGr: !!sc.altGr,
    shift: !!sc.shift,
    meta: !!sc.meta,
    code,
    key: typeof sc.key === "string" ? sc.key : ""
  };
  if (!(out.ctrl || out.alt || out.altGr || out.meta)) return null;
  return out;
}

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

// Normalise a per-host delay list: lowercase domains, coerce flags, clamp the
// millisecond value to the allowed range, and drop dupes.
function normalizeDelayRules(list) {
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
      ms: clampDelay(e.ms)
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
  out.globalThrottleDelay = clampDelay(out.globalThrottleDelay);
  out.throttleDelayDomains = normalizeDelayRules(out.throttleDelayDomains);
  out.toggleShortcut = normalizeShortcut(out.toggleShortcut);
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
