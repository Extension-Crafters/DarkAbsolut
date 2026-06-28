// DarkAbsolut — shared popup helpers.
// Loaded as a classic script by popup.html and io.html before their own
// page-specific scripts.

// eslint-disable-next-line no-unused-vars, no-var
var DAPopup = (function () {
  "use strict";

  function $(id) {
    return document.getElementById(id);
  }

  function send(msg) {
    return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  function hostFromUrl(url) {
    try {
      const u = new URL(url);
      // Mirror matching.js: local files share one pseudo-host so the popup's
      // per-"site" controls operate on the same key the background uses.
      if (u.protocol === "file:") return "localfile";
      return u.hostname.toLowerCase();
    } catch { return ""; }
  }

  // Re-analyse throttle bounds — keep in sync with background/storage.js and
  // content/controller.js.
  const THROTTLE = { DEFAULT: 250, MIN: 60, MAX: 5000 };

  // Clamp a user-entered delay to whole ms within [MIN, MAX]; non-numbers → null
  // so callers can treat a blank/garbage field as "inherit" rather than a value.
  function clampDelay(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    return Math.min(THROTTLE.MAX, Math.max(THROTTLE.MIN, n));
  }

  // Numeric mirror of matching.resolveValue: exact host > longest subdomain
  // rule > global default. Returns the matched rule's `ms`, else the default.
  function resolveValue(rules, host, globalDefault) {
    if (!host) return globalDefault;
    const h = host.toLowerCase();
    let exact = null, sub = null, subLen = -1;
    for (const e of rules || []) {
      const d = (e.domain || "").toLowerCase();
      if (!d) continue;
      if (h === d) { exact = e; break; }
      if (e.includeSubdomains && h.endsWith("." + d) && d.length > subLen) { sub = e; subLen = d.length; }
    }
    const m = exact || sub;
    return m ? m.ms : globalDefault;
  }

  return { $, send, getActiveTab, hostFromUrl, THROTTLE, clampDelay, resolveValue };
})();
