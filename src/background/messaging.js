// DarkAbsolut — message router between popup / content scripts and storage.

import { DEFAULTS, getState, setState, replaceState } from "./storage.js";
import {
  shouldEnableForUrl,
  registrableLike
} from "./matching.js";
import { updateBadge } from "./badge.js";

// Strip an incoming import payload into a canonical, trusted shape.
function sanitizeImportedData(data) {
  if (!data || typeof data !== "object") return null;

  const sanitizeDomainList = (raw) => {
    const out = [];
    if (!Array.isArray(raw)) return out;
    const seen = new Set();
    for (const e of raw) {
      if (!e || typeof e.domain !== "string") continue;
      const domain = e.domain.trim().toLowerCase();
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      out.push({ domain, includeSubdomains: !!e.includeSubdomains });
    }
    return out;
  };
  return {
    globalEnabled: typeof data.globalEnabled === "boolean"
      ? data.globalEnabled
      : DEFAULTS.globalEnabled,
    disabledDomains: sanitizeDomainList(data.disabledDomains),
    noImageInversionDomains: sanitizeDomainList(data.noImageInversionDomains)
  };
}

async function broadcastUpdate() {
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
        state: res.state
      };
    }
    case "GET_FULL_STATE": {
      const state = await getState();
      return { ok: true, state };
    }
    case "SET_GLOBAL_ENABLED": {
      const next = await setState({ globalEnabled: !!msg.value });
      await broadcastUpdate();
      return { ok: true, state: next };
    }
    case "SET_DOMAIN_DISABLED": {
      const state = await getState();
      const host = (msg.hostname || "").toLowerCase();
      const includeSubdomains = !!msg.includeSubdomains;
      const list = state.disabledDomains.filter(
        e => e.domain.toLowerCase() !== host
      );
      if (msg.disabled) list.push({ domain: host, includeSubdomains });
      const next = await setState({ disabledDomains: list });
      await broadcastUpdate();
      return { ok: true, state: next };
    }
    case "SET_DOMAIN_IMAGE_INVERSION_DISABLED": {
      const state = await getState();
      const host = (msg.hostname || "").toLowerCase();
      const includeSubdomains = !!msg.includeSubdomains;
      const cur = state.noImageInversionDomains || [];
      const list = cur.filter(e => e.domain.toLowerCase() !== host);
      if (msg.disabled) list.push({ domain: host, includeSubdomains });
      const next = await setState({ noImageInversionDomains: list });
      await broadcastUpdate();
      return { ok: true, state: next };
    }
    case "IMPORT_SETTINGS": {
      const next = sanitizeImportedData(msg && msg.data);
      if (!next) return { ok: false, error: "invalid_payload" };
      await replaceState(next);
      await broadcastUpdate();
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
      const next = await setState({ disabledDomains, noImageInversionDomains });
      await broadcastUpdate();
      return { ok: true, state: next };
    }
    case "CLEAR_ALL_DOMAINS": {
      // Drop every per-site override; keep the global master switch as-is.
      const next = await setState({ disabledDomains: [], noImageInversionDomains: [] });
      await broadcastUpdate();
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
