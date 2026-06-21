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
  const off = { enabled: false, imageInversionDisabled: false, enhanceContrast: false, state };
  if (!state.globalEnabled) return off;
  const host = hostnameFromUrl(url);
  if (!host) return off;
  if (isRestrictedUrl(url)) return off;
  if (isHostDisabled(host, state.disabledDomains)) return off;
  const imageInversionDisabled = isHostDisabled(host, state.noImageInversionDomains || []);
  const enhanceContrast = isHostDisabled(host, state.enhanceContrastDomains || []);
  return { enabled: true, imageInversionDisabled, enhanceContrast, state };
}
