// DarkAbsolut - background service worker
// Manages global state, per-domain disable list, and badge UI.

const DEFAULTS = {
  globalEnabled: true,
  // Each entry: { domain: "example.com", includeSubdomains: true }
  disabledDomains: []
};

async function getState() {
  const data = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...data };
}

async function setState(patch) {
  const cur = await getState();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set(next);
  return next;
}

function hostnameFromUrl(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function registrableLike(hostname) {
  // Naive eTLD+1 fallback: take last two labels. Works for most TLDs and is
  // good enough for "include subdomains" semantics in this extension.
  if (!hostname) return "";
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}

function isHostDisabled(hostname, disabledDomains) {
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

async function shouldEnableForUrl(url) {
  const state = await getState();
  if (!state.globalEnabled) return { enabled: false, state };
  const host = hostnameFromUrl(url);
  if (!host) return { enabled: false, state };
  if (/^(chrome|edge|about|moz-extension|chrome-extension|view-source|file):/i.test(url)) {
    return { enabled: false, state };
  }
  if (isHostDisabled(host, state.disabledDomains)) return { enabled: false, state };
  return { enabled: true, state };
}

async function updateBadge(tabId, url) {
  try {
    const { enabled, state } = await shouldEnableForUrl(url || "");
    if (!state.globalEnabled) {
      await chrome.action.setBadgeText({ text: "off", tabId });
      await chrome.action.setBadgeBackgroundColor({ color: "#888888", tabId });
    } else if (!enabled) {
      await chrome.action.setBadgeText({ text: "—", tabId });
      await chrome.action.setBadgeBackgroundColor({ color: "#cc6633", tabId });
    } else {
      await chrome.action.setBadgeText({ text: "", tabId });
    }
  } catch (_) { /* tab may have closed */ }
}

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(null);
  const merged = { ...DEFAULTS, ...cur };
  await chrome.storage.local.set(merged);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "GET_STATE_FOR_URL": {
          const url = msg.url || (sender.tab && sender.tab.url) || "";
          const res = await shouldEnableForUrl(url);
          sendResponse({ ok: true, enabled: res.enabled, state: res.state });
          break;
        }
        case "GET_FULL_STATE": {
          const state = await getState();
          sendResponse({ ok: true, state });
          break;
        }
        case "SET_GLOBAL_ENABLED": {
          const next = await setState({ globalEnabled: !!msg.value });
          await broadcastUpdate();
          sendResponse({ ok: true, state: next });
          break;
        }
        case "SET_DOMAIN_DISABLED": {
          // msg: { hostname, disabled: bool, includeSubdomains: bool }
          const state = await getState();
          const host = (msg.hostname || "").toLowerCase();
          const includeSubdomains = !!msg.includeSubdomains;
          let list = state.disabledDomains.filter(e => e.domain.toLowerCase() !== host);
          // Also remove a parent registrable entry if it covers this host with subdomains.
          // (We keep behavior simple: only manage exact host entry here.)
          if (msg.disabled) {
            list.push({ domain: host, includeSubdomains });
          }
          const next = await setState({ disabledDomains: list });
          await broadcastUpdate();
          sendResponse({ ok: true, state: next });
          break;
        }
        case "IMPORT_SETTINGS": {
          // msg.data: { globalEnabled?, disabledDomains? }
          const data = msg && msg.data;
          if (!data || typeof data !== "object") {
            sendResponse({ ok: false, error: "invalid_payload" });
            break;
          }
          // Build next from scratch so we never share array references with
          // DEFAULTS, and so missing fields fall back to a *fresh* empty value.
          const importedList = [];
          if (Array.isArray(data.disabledDomains)) {
            const seen = new Set();
            for (const e of data.disabledDomains) {
              if (!e || typeof e.domain !== "string") continue;
              const domain = e.domain.trim().toLowerCase();
              if (!domain || seen.has(domain)) continue;
              seen.add(domain);
              importedList.push({ domain, includeSubdomains: !!e.includeSubdomains });
            }
          }
          const next = {
            globalEnabled: typeof data.globalEnabled === "boolean"
              ? data.globalEnabled
              : DEFAULTS.globalEnabled,
            disabledDomains: importedList
          };
          // Wipe everything we own, then write only the imported subset.
          await chrome.storage.local.clear();
          await chrome.storage.local.set(next);
          await broadcastUpdate();
          sendResponse({ ok: true, state: next });
          break;
        }
        case "GET_REGISTRABLE": {
          sendResponse({ ok: true, registrable: registrableLike(msg.hostname || "") });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown_message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // async
});

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

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateBadge(tabId, tab.url);
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" || info.url) updateBadge(tabId, tab.url);
});
