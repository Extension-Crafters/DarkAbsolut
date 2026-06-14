// DarkAbsolut — service worker entry point.
//
// Wires together storage defaults, the message router, and the tab
// lifecycle hooks that refresh the toolbar badge.

import { DEFAULTS } from "./storage.js";
import { installMessageRouter } from "./messaging.js";
import { updateBadge } from "./badge.js";

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(null);
  const merged = { ...DEFAULTS, ...cur };
  await chrome.storage.local.set(merged);
});

installMessageRouter();

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateBadge(tabId, tab.url);
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" || info.url) updateBadge(tabId, tab.url);
});
