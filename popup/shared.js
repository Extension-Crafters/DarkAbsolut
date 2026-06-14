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
    try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
  }

  return { $, send, getActiveTab, hostFromUrl };
})();
