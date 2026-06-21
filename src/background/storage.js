// DarkAbsolut — persisted settings access.

export const DEFAULTS = {
  globalEnabled: true,
  // Each entry: { domain: "example.com", includeSubdomains: true }
  disabledDomains: [],
  // Per-site "soft dark gray" contrast variant: lift pure black to dark gray so
  // the inversion keeps visual depth instead of flattening to black. Same entry
  // shape as disabledDomains (with includeSubdomains).
  enhanceContrastDomains: [],
  // Domains where img / picture / background-image elements should NOT
  // get the counter-invert filter (extension stays active for the rest
  // of the page). Same entry shape as disabledDomains.
  noImageInversionDomains: []
};

export async function getState() {
  const data = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...data };
}

export async function setState(patch) {
  const cur = await getState();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set(next);
  return next;
}

// Replace everything we own with `next`. Used by IMPORT_SETTINGS so that
// any key missing from the imported payload is reset to its default.
export async function replaceState(next) {
  await chrome.storage.local.clear();
  await chrome.storage.local.set(next);
  return next;
}
