// DarkAbsolut — service worker entry point.
//
// Wires together storage defaults, the message router, the tab lifecycle hooks
// that refresh the toolbar badge, and the toolbar action (popup vs click-action
// + icon) which depends on the working mode.

import { getState, setState } from "./storage.js";
import { installMessageRouter } from "./messaging.js";
import { updateBadge } from "./badge.js";
import { configureAction } from "./action.js";

async function syncAction() {
  try { await configureAction(await getState()); } catch (_) {}
}

chrome.runtime.onInstalled.addListener(async () => {
  // getState merges defaults + normalises (migrates legacy entries to valued
  // rules); persist the result so the stored shape is current.
  const next = await getState();
  await chrome.storage.local.set(next);
  await configureAction(next);
});

// Service workers are torn down and restarted; re-apply the action config.
chrome.runtime.onStartup.addListener(syncAction);

installMessageRouter();
syncAction();

// Toolbar button in the click-driven modes (no popup is set, so this fires).
chrome.action.onClicked.addListener(async (tab) => {
  const state = await getState();
  // Master switch off ⇒ the whole extension is off (sun icon); the button is a
  // no-op until it's turned back on (via the Options page).
  if (!state.globalEnabled) return;
  if (state.mode === "once") {
    if (tab && tab.id != null) {
      try { await chrome.tabs.sendMessage(tab.id, { type: "APPLY_ONCE" }); } catch (_) {}
    }
  } else if (state.mode === "toggle") {
    const next = await setState({ toggleOn: !state.toggleOn });
    await configureAction(next);
    // Re-evaluate every tab so the toggle takes effect immediately.
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id == null) continue;
      updateBadge(t.id, t.url);
      try { await chrome.tabs.sendMessage(t.id, { type: "STATE_UPDATED" }); } catch (_) {}
    }
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateBadge(tabId, tab.url);
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" || info.url) updateBadge(tabId, tab.url);
});
