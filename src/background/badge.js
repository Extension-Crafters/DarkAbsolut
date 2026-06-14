// DarkAbsolut — toolbar badge updates.

import { shouldEnableForUrl } from "./matching.js";

export async function updateBadge(tabId, url) {
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
