// DarkAbsolut — message router between popup / content scripts and storage.

import { DEFAULTS, SHORTCUT_ACTIONS, getState, setState, replaceState } from "./storage.js";
import {
  shouldEnableForUrl,
  registrableLike,
  hostnameFromUrl,
  resolveFeature
} from "./matching.js";
import { updateBadge } from "./badge.js";
import { configureAction } from "./action.js";

// feature key → { list storage key, global-default storage key, legacy `on` }.
const FEATURES = {
  dark:     { key: "disabledDomains",         global: "globalDarkMode",     legacyOn: false },
  img:      { key: "noImageInversionDomains",  global: "globalNaturalImages", legacyOn: true },
  contrast: { key: "enhanceContrastDomains",   global: "globalSoftGray",      legacyOn: true }
};

// Write (or replace) a valued per-host rule for a feature.
function setRule(list, host, includeSubdomains, on) {
  const next = (list || []).filter(e => (e.domain || "").toLowerCase() !== host);
  next.push({ domain: host, includeSubdomains: !!includeSubdomains, on: !!on });
  return next;
}

// Strip an incoming import payload into a canonical, trusted shape (valued
// rules + per-feature globals + mode). Legacy payloads (entries without `on`)
// are normalised by storage.replaceState using each list's historic meaning.
function sanitizeImportedData(data) {
  if (!data || typeof data !== "object") return null;

  const sanitizeRuleList = (raw) => {
    const out = [];
    if (!Array.isArray(raw)) return out;
    const seen = new Set();
    for (const e of raw) {
      if (!e || typeof e.domain !== "string") continue;
      const domain = e.domain.trim().toLowerCase();
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      const entry = { domain, includeSubdomains: !!e.includeSubdomains };
      if (typeof e.on === "boolean") entry.on = e.on;
      out.push(entry);
    }
    return out;
  };
  // Per-host throttle rules carry a numeric `ms` instead of a boolean `on`;
  // storage.replaceState → normalizeState clamps it to the allowed range.
  const sanitizeDelayList = (raw) => {
    const out = [];
    if (!Array.isArray(raw)) return out;
    const seen = new Set();
    for (const e of raw) {
      if (!e || typeof e.domain !== "string") continue;
      const domain = e.domain.trim().toLowerCase();
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      const entry = { domain, includeSubdomains: !!e.includeSubdomains };
      if (e.ms != null) entry.ms = e.ms;
      out.push(entry);
    }
    return out;
  };
  // Shortcuts are re-validated by storage.normalizeState (which drops invalid /
  // duplicate bindings and folds a legacy single `toggleShortcut`), so we just
  // pass the per-action arrays through, defaulting to empty lists.
  const sanitizeShortcuts = (raw) => {
    const src = (raw && typeof raw === "object") ? raw : {};
    const out = {};
    for (const action of SHORTCUT_ACTIONS) {
      out[action] = Array.isArray(src[action]) ? src[action] : [];
    }
    return out;
  };
  const bool = (v, d) => (typeof v === "boolean" ? v : d);
  return {
    globalEnabled: bool(data.globalEnabled, DEFAULTS.globalEnabled),
    mode: ["filter", "once", "toggle"].includes(data.mode) ? data.mode : DEFAULTS.mode,
    toggleOn: bool(data.toggleOn, DEFAULTS.toggleOn),
    globalDarkMode: bool(data.globalDarkMode, DEFAULTS.globalDarkMode),
    globalNaturalImages: bool(data.globalNaturalImages, DEFAULTS.globalNaturalImages),
    globalSoftGray: bool(data.globalSoftGray, DEFAULTS.globalSoftGray),
    globalThrottleDelay: typeof data.globalThrottleDelay === "number"
      ? data.globalThrottleDelay : DEFAULTS.globalThrottleDelay,
    disabledDomains: sanitizeRuleList(data.disabledDomains),
    noImageInversionDomains: sanitizeRuleList(data.noImageInversionDomains),
    enhanceContrastDomains: sanitizeRuleList(data.enhanceContrastDomains),
    throttleDelayDomains: sanitizeDelayList(data.throttleDelayDomains),
    shortcuts: sanitizeShortcuts(data.shortcuts),
    // Legacy single binding — normalizeState folds it into toggleDomain then
    // drops it, so importing an old export keeps its shortcut.
    toggleShortcut: (data.toggleShortcut && typeof data.toggleShortcut === "object")
      ? data.toggleShortcut : null
  };
}

async function broadcastUpdate(state) {
  if (state) { try { await configureAction(state); } catch (_) {} }
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id == null) continue;
    updateBadge(t.id, t.url);
    try {
      await chrome.tabs.sendMessage(t.id, { type: "STATE_UPDATED" });
    } catch (_) { /* no content script in this tab */ }
  }
}

async function handle(msg, sender) {
  switch (msg && msg.type) {
    case "GET_STATE_FOR_URL": {
      const url = msg.url || (sender.tab && sender.tab.url) || "";
      const res = await shouldEnableForUrl(url);
      return {
        ok: true,
        enabled: res.enabled,
        imageInversionDisabled: !!res.imageInversionDisabled,
        enhanceContrast: !!res.enhanceContrast,
        throttleDelay: res.throttleDelay,
        mode: res.mode,
        state: res.state
      };
    }
    case "GET_FULL_STATE": {
      const state = await getState();
      return { ok: true, state };
    }
    case "SET_GLOBAL_ENABLED": {
      const next = await setState({ globalEnabled: !!msg.value });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "SET_MODE": {
      const mode = ["filter", "once", "toggle"].includes(msg.mode) ? msg.mode : "filter";
      const next = await setState({ mode });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "SET_TOGGLE": {
      // Flip (or set) the global on/off used by "toggle" mode.
      const cur = await getState();
      const value = typeof msg.value === "boolean" ? msg.value : !cur.toggleOn;
      const next = await setState({ toggleOn: value });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "SET_GLOBAL_FEATURE": {
      const f = FEATURES[msg.feature];
      if (!f) return { ok: false, error: "unknown_feature" };
      const next = await setState({ [f.global]: !!msg.value });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "SET_FEATURE_RULE": {
      const f = FEATURES[msg.feature];
      if (!f) return { ok: false, error: "unknown_feature" };
      const host = (msg.hostname || "").toLowerCase();
      if (!host) return { ok: false, error: "missing_hostname" };
      const state = await getState();
      const list = setRule(state[f.key], host, msg.includeSubdomains, msg.on);
      const next = await setState({ [f.key]: list });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "REMOVE_FEATURE_RULE": {
      const f = FEATURES[msg.feature];
      if (!f) return { ok: false, error: "unknown_feature" };
      const host = (msg.hostname || "").toLowerCase();
      if (!host) return { ok: false, error: "missing_hostname" };
      const state = await getState();
      const list = (state[f.key] || []).filter(e => (e.domain || "").toLowerCase() !== host);
      const next = await setState({ [f.key]: list });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    // ── Re-analyse throttle delay (perf knob) ────────────────────────────────
    case "SET_GLOBAL_THROTTLE": {
      // setState → normalizeState clamps to [THROTTLE_MIN, THROTTLE_MAX].
      const next = await setState({ globalThrottleDelay: msg.ms });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "SET_THROTTLE_RULE": {
      const host = (msg.hostname || "").toLowerCase();
      if (!host) return { ok: false, error: "missing_hostname" };
      const state = await getState();
      const list = (state.throttleDelayDomains || []).filter(e => (e.domain || "").toLowerCase() !== host);
      list.push({ domain: host, includeSubdomains: !!msg.includeSubdomains, ms: msg.ms });
      const next = await setState({ throttleDelayDomains: list });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "REMOVE_THROTTLE_RULE": {
      const host = (msg.hostname || "").toLowerCase();
      if (!host) return { ok: false, error: "missing_hostname" };
      const state = await getState();
      const list = (state.throttleDelayDomains || []).filter(e => (e.domain || "").toLowerCase() !== host);
      const next = await setState({ throttleDelayDomains: list });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    // ── Keyboard shortcuts (multi-binding, per action) ───────────────────────
    case "ADD_SHORTCUT": {
      if (!SHORTCUT_ACTIONS.includes(msg.action)) return { ok: false, error: "unknown_action" };
      const state = await getState();
      // setState → normalizeState validates + de-dupes, so pushing an invalid
      // or duplicate binding is harmlessly dropped.
      const list = (state.shortcuts[msg.action] || []).concat([msg.shortcut || {}]);
      const next = await setState({ shortcuts: { ...state.shortcuts, [msg.action]: list } });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "REMOVE_SHORTCUT": {
      if (!SHORTCUT_ACTIONS.includes(msg.action)) return { ok: false, error: "unknown_action" };
      const state = await getState();
      const list = (state.shortcuts[msg.action] || []).slice();
      const idx = Number(msg.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return { ok: false, error: "bad_index" };
      list.splice(idx, 1);
      const next = await setState({ shortcuts: { ...state.shortcuts, [msg.action]: list } });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "TOGGLE_GLOBAL_ENABLED": {
      // Fired by the content script's global on/off shortcut: flip the master
      // kill switch for every site.
      const cur = await getState();
      const next = await setState({ globalEnabled: !cur.globalEnabled });
      await broadcastUpdate(next);
      return { ok: true, state: next, on: !cur.globalEnabled };
    }
    case "TOGGLE_DOMAIN_DARK": {
      // Fired by the content script when the user presses the bound shortcut:
      // flip this host's dark-mode rule (the per-site on/off the popup's "This
      // host" checkbox writes). Preserve an existing rule's subdomain scope.
      const host = hostnameFromUrl(msg.url || (sender.tab && sender.tab.url) || "");
      if (!host) return { ok: false, error: "missing_hostname" };
      const state = await getState();
      const current = resolveFeature(host, state.disabledDomains, state.globalDarkMode);
      const existing = (state.disabledDomains || [])
        .find(e => (e.domain || "").toLowerCase() === host);
      const includeSubdomains = existing ? !!existing.includeSubdomains : false;
      const list = setRule(state.disabledDomains, host, includeSubdomains, !current);
      const next = await setState({ disabledDomains: list });
      await broadcastUpdate(next);
      return { ok: true, state: next, on: !current };
    }
    // ── Legacy per-domain handlers (kept for back-compat) ────────────────────
    case "SET_DOMAIN_ENHANCE_CONTRAST": {
      const state = await getState();
      const host = (msg.hostname || "").toLowerCase();
      const cur = (state.enhanceContrastDomains || []).filter(e => e.domain.toLowerCase() !== host);
      if (msg.enabled) cur.push({ domain: host, includeSubdomains: !!msg.includeSubdomains, on: true });
      const next = await setState({ enhanceContrastDomains: cur });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "SET_DOMAIN_DISABLED": {
      const state = await getState();
      const host = (msg.hostname || "").toLowerCase();
      const list = state.disabledDomains.filter(e => e.domain.toLowerCase() !== host);
      if (msg.disabled) list.push({ domain: host, includeSubdomains: !!msg.includeSubdomains, on: false });
      const next = await setState({ disabledDomains: list });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "SET_DOMAIN_IMAGE_INVERSION_DISABLED": {
      const state = await getState();
      const host = (msg.hostname || "").toLowerCase();
      const cur = (state.noImageInversionDomains || []).filter(e => e.domain.toLowerCase() !== host);
      if (msg.disabled) cur.push({ domain: host, includeSubdomains: !!msg.includeSubdomains, on: true });
      const next = await setState({ noImageInversionDomains: cur });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "IMPORT_SETTINGS": {
      const sanitized = sanitizeImportedData(msg && msg.data);
      if (!sanitized) return { ok: false, error: "invalid_payload" };
      const next = await replaceState(sanitized);
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "REMOVE_DOMAIN_CONFIG": {
      // Wipe every saved setting for one host (theme + image overrides),
      // letting the site fall back to the automatic default.
      const host = (msg.hostname || "").toLowerCase();
      if (!host) return { ok: false, error: "missing_hostname" };
      const state = await getState();
      const disabledDomains = state.disabledDomains.filter(
        e => e.domain.toLowerCase() !== host
      );
      const noImageInversionDomains = (state.noImageInversionDomains || []).filter(
        e => e.domain.toLowerCase() !== host
      );
      const enhanceContrastDomains = (state.enhanceContrastDomains || []).filter(
        e => e.domain.toLowerCase() !== host
      );
      const throttleDelayDomains = (state.throttleDelayDomains || []).filter(
        e => e.domain.toLowerCase() !== host
      );
      const next = await setState({ disabledDomains, noImageInversionDomains, enhanceContrastDomains, throttleDelayDomains });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "CLEAR_ALL_DOMAINS": {
      // Drop every per-site override; keep the global master switch as-is.
      const next = await setState({ disabledDomains: [], noImageInversionDomains: [], enhanceContrastDomains: [], throttleDelayDomains: [] });
      await broadcastUpdate(next);
      return { ok: true, state: next };
    }
    case "GET_REGISTRABLE": {
      return { ok: true, registrable: registrableLike(msg.hostname || "") };
    }
    default:
      return { ok: false, error: "unknown_message" };
  }
}

export function installMessageRouter() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handle(msg, sender)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async
  });
}
