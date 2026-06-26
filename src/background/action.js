// DarkAbsolut — toolbar action configuration (popup vs click-action + icon).
//
// The working mode decides what the toolbar button does:
//   "filter" → button opens the settings popup (auto-apply per site).
//   "once"   → no popup; clicking runs APPLY_ONCE on the active tab.
//   "toggle" → no popup; clicking flips dark mode on/off globally.
// When the extension is "off" (master off, or toggle mode turned off) the icon
// swaps to a sun. Settings stay reachable in the click modes via right-click →
// Options (manifest options_ui).

const MOON_ICON = { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
const SUN_ICON = { 16: "icons/icon-off16.png", 32: "icons/icon-off32.png", 48: "icons/icon-off48.png", 128: "icons/icon-off128.png" };

// "Off" = nothing will be applied anywhere: the master switch is off, or we're
// in toggle mode with the toggle turned off.
export function isOffState(state) {
  if (!state.globalEnabled) return true;
  if (state.mode === "toggle" && !state.toggleOn) return true;
  return false;
}

function titleFor(state) {
  if (!state.globalEnabled) return "DarkAbsolut — off (master switch)";
  if (state.mode === "once") return "DarkAbsolut — click to dark-mode this page";
  if (state.mode === "toggle") return state.toggleOn
    ? "DarkAbsolut — on (click to turn off)"
    : "DarkAbsolut — off (click to turn on)";
  return "DarkAbsolut";
}

export async function configureAction(state) {
  // Popup only in "filter" mode; the click modes need onClicked to fire.
  try {
    await chrome.action.setPopup({ popup: state.mode === "filter" ? "popup/popup.html" : "" });
  } catch (_) {}
  try {
    await chrome.action.setIcon({ path: isOffState(state) ? SUN_ICON : MOON_ICON });
  } catch (_) {}
  try {
    await chrome.action.setTitle({ title: titleFor(state) });
  } catch (_) {}
}
