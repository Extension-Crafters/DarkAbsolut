// DarkAbsolut — URL / hostname matching rules.

import { getState } from "./storage.js";

// URLs we must never touch (browser chrome, extension internals, etc.).
// Note: file:// is intentionally NOT restricted — local pages (saved HTML,
// generated reports) benefit from dark mode too. Chrome still requires the
// user to enable "Allow access to file URLs" in the extension details before
// content scripts run on file:// pages; this only governs our own gating.
const RESTRICTED_SCHEME_RE =
  /^(chrome|edge|about|moz-extension|chrome-extension|view-source):/i;

// Stable pseudo-host for local file:// URLs (which have no real hostname) so
// the empty-host guard, the popup label and per-"site" disable all work. All
// local files share this single host. Keep in sync with popup/shared.js.
export const LOCAL_FILE_HOST = "localfile";

export function hostnameFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return LOCAL_FILE_HOST;
    return u.hostname.toLowerCase();
  } catch { return ""; }
}

// Naive eTLD+1 fallback: last two labels. Good enough for the "include
// subdomains" semantics used in the popup without pulling a PSL dependency.
export function registrableLike(hostname) {
  if (!hostname) return "";
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}

export function isRestrictedUrl(url) {
  return RESTRICTED_SCHEME_RE.test(url || "");
}

// Resolve a feature's value for a host: an exact-host rule wins, else the most
// specific (longest-domain) include-subdomains rule, else the global default.
// Each rule's `on` is the explicit value. This is the per-host → per-subdomain →
// global precedence the popup's three columns map onto.
export function resolveFeature(hostname, rules, globalDefault) {
  if (!hostname) return !!globalDefault;
  const h = hostname.toLowerCase();
  let exact = null, sub = null, subLen = -1;
  for (const entry of rules || []) {
    const d = (entry.domain || "").toLowerCase();
    if (!d) continue;
    if (h === d) { exact = entry; break; }
    if (entry.includeSubdomains && h.endsWith("." + d) && d.length > subLen) {
      sub = entry; subLen = d.length;
    }
  }
  const m = exact || sub;
  return m ? !!m.on : !!globalDefault;
}

export async function shouldEnableForUrl(url) {
  const state = await getState();
  const host = hostnameFromUrl(url);
  const restricted = isRestrictedUrl(url);
  const base = {
    enabled: false, imageInversionDisabled: false, enhanceContrast: false,
    mode: state.mode, state
  };
  if (!state.globalEnabled || !host || restricted) return base;

  // Image / soft-gray resolve the same way in every mode — they only take
  // effect once dark mode is actually applied to the page.
  const imageInversionDisabled =
    resolveFeature(host, state.noImageInversionDomains, state.globalNaturalImages);
  const enhanceContrast =
    resolveFeature(host, state.enhanceContrastDomains, state.globalSoftGray);

  let enabled;
  if (state.mode === "toggle") {
    enabled = !!state.toggleOn;       // global on/off; per-site dark rules ignored
  } else if (state.mode === "once") {
    enabled = false;                  // never auto; only on explicit button click
  } else {
    enabled = resolveFeature(host, state.disabledDomains, state.globalDarkMode);
  }
  return { enabled, imageInversionDisabled, enhanceContrast, mode: state.mode, state };
}
