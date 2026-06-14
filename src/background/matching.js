// DarkAbsolut — URL / hostname matching rules.

import { getState } from "./storage.js";

// URLs we must never touch (browser chrome, extension internals, etc.).
const RESTRICTED_SCHEME_RE =
  /^(chrome|edge|about|moz-extension|chrome-extension|view-source|file):/i;

export function hostnameFromUrl(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
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

export function isHostDisabled(hostname, disabledDomains) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  for (const entry of disabledDomains) {
    const d = (entry.domain || "").toLowerCase();
    if (!d) continue;
    if (entry.includeSubdomains) {
      if (h === d || h.endsWith("." + d)) return true;
    } else {
      if (h === d) return true;
    }
  }
  return false;
}

export async function shouldEnableForUrl(url) {
  const state = await getState();
  if (!state.globalEnabled) return { enabled: false, imageInversionDisabled: false, state };
  const host = hostnameFromUrl(url);
  if (!host) return { enabled: false, imageInversionDisabled: false, state };
  if (isRestrictedUrl(url)) return { enabled: false, imageInversionDisabled: false, state };
  if (isHostDisabled(host, state.disabledDomains)) {
    return { enabled: false, imageInversionDisabled: false, state };
  }
  const imageInversionDisabled = isHostDisabled(host, state.noImageInversionDomains || []);
  return { enabled: true, imageInversionDisabled, state };
}
