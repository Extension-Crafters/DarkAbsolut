// DarkAbsolut - popup UI logic
const $ = (id) => document.getElementById(id);

let currentTab = null;
let currentHostname = "";
let state = null;

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function hostFromUrl(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function findEntry(host) {
  if (!state || !host) return null;
  return state.disabledDomains.find(e => e.domain.toLowerCase() === host) || null;
}

function isCoveredBySubdomainRule(host) {
  if (!state || !host) return false;
  return state.disabledDomains.some(e => {
    const d = (e.domain || "").toLowerCase();
    return e.includeSubdomains && d && host !== d && host.endsWith("." + d);
  });
}

function setDisabled(el, disabled) {
  el.disabled = !!disabled;
  el.closest(".da-row")?.classList.toggle("disabled", !!disabled);
}

async function refresh() {
  currentTab = await getActiveTab();
  const url = currentTab && currentTab.url || "";
  currentHostname = hostFromUrl(url);
  const r = await send({ type: "GET_FULL_STATE" });
  state = (r && r.state) || { globalEnabled: true, disabledDomains: [] };

  $("da-host").textContent = currentHostname || "(no site)";
  $("da-global").checked = !!state.globalEnabled;

  const restricted = !currentHostname || /^(chrome|edge|about|moz-extension|chrome-extension|view-source|file):/i.test(url);
  const entry = findEntry(currentHostname);
  const coveredBySub = isCoveredBySubdomainRule(currentHostname);
  const siteDisabled = !!entry || coveredBySub;

  // "Enable on this site" reflects the inverse of disabled.
  $("da-domain").checked = !siteDisabled;
  $("da-sub").checked = !!(entry && entry.includeSubdomains);

  // Disable per-site controls when global is off, on restricted URLs,
  // or when only a parent subdomain rule covers this host.
  const siteCtrlsDisabled = !state.globalEnabled || restricted || coveredBySub;
  setDisabled($("da-domain"), siteCtrlsDisabled);
  setDisabled($("da-sub"), siteCtrlsDisabled || !siteDisabled);

  $("da-domain-desc").textContent = restricted
    ? "Not applicable on this page."
    : coveredBySub
      ? "Disabled by a parent-domain rule."
      : `Toggle off to disable on ${currentHostname}.`;
}

async function onGlobalChange(e) {
  await send({ type: "SET_GLOBAL_ENABLED", value: e.target.checked });
  await refresh();
}

async function onDomainChange(e) {
  if (!currentHostname) return;
  const enabledOnSite = e.target.checked;
  const includeSubdomains = $("da-sub").checked;
  await send({
    type: "SET_DOMAIN_DISABLED",
    hostname: currentHostname,
    disabled: !enabledOnSite,
    includeSubdomains
  });
  await refresh();
}

async function onSubChange(e) {
  if (!currentHostname) return;
  const entry = findEntry(currentHostname);
  if (!entry) return; // only meaningful when site is disabled
  await send({
    type: "SET_DOMAIN_DISABLED",
    hostname: currentHostname,
    disabled: true,
    includeSubdomains: e.target.checked
  });
  await refresh();
}

function onReload() {
  if (currentTab && currentTab.id != null) chrome.tabs.reload(currentTab.id);
  window.close();
}

function activateTab(name) {
  document.querySelectorAll(".da-tab").forEach(b => {
    const active = b.dataset.tab === name;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".da-tab-panel").forEach(p => {
    p.classList.toggle("active", p.dataset.panel === name);
  });
}

function onOpenIoPage() {
  // The popup closes as soon as a file picker / download dialog steals
  // focus, which interrupts import/export work. Hand off to a real page.
  const url = chrome.runtime.getURL("popup/io.html");
  chrome.tabs.create({ url });
  window.close();
}

document.addEventListener("DOMContentLoaded", () => {
  $("da-global").addEventListener("change", onGlobalChange);
  $("da-domain").addEventListener("change", onDomainChange);
  $("da-sub").addEventListener("change", onSubChange);
  $("da-reload").addEventListener("click", onReload);
  document.querySelectorAll(".da-tab").forEach(b => {
    b.addEventListener("click", () => activateTab(b.dataset.tab));
  });
  $("da-open-io").addEventListener("click", onOpenIoPage);
  refresh();
});
