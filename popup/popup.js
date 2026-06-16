// DarkAbsolut - popup UI logic
const { $, send, getActiveTab, hostFromUrl } = DAPopup;

let currentTab = null;
let currentHostname = "";
let state = null;

function findEntryIn(list, host) {
  if (!list || !host) return null;
  return list.find(e => e.domain.toLowerCase() === host) || null;
}

function isCoveredBySubdomainRuleIn(list, host) {
  if (!list || !host) return false;
  return list.some(e => {
    const d = (e.domain || "").toLowerCase();
    return e.includeSubdomains && d && host !== d && host.endsWith("." + d);
  });
}

function findEntry(host) {
  return findEntryIn(state && state.disabledDomains, host);
}

function isCoveredBySubdomainRule(host) {
  return isCoveredBySubdomainRuleIn(state && state.disabledDomains, host);
}

function findNoImgEntry(host) {
  return findEntryIn(state && state.noImageInversionDomains, host);
}

function isCoveredByNoImgSubdomainRule(host) {
  return isCoveredBySubdomainRuleIn(state && state.noImageInversionDomains, host);
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
  state = (r && r.state) || { globalEnabled: true, disabledDomains: [], noImageInversionDomains: [] };
  if (!Array.isArray(state.noImageInversionDomains)) state.noImageInversionDomains = [];

  $("da-host").textContent = currentHostname || "(no site)";
  $("da-global").checked = !!state.globalEnabled;

  const restricted = !currentHostname || /^(chrome|edge|about|moz-extension|chrome-extension|view-source):/i.test(url);
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

  // ── Don't-invert-images per-site option ────────────────────────────────
  const noImgEntry = findNoImgEntry(currentHostname);
  const coveredByNoImgSub = isCoveredByNoImgSubdomainRule(currentHostname);
  const noImgActive = !!noImgEntry || coveredByNoImgSub;

  $("da-noimg").checked = noImgActive;
  $("da-noimg-sub").checked = !!(noImgEntry && noImgEntry.includeSubdomains);

  // The image option only makes sense while the extension is actually
  // active for this site (global on, not restricted, site not disabled).
  const noImgCtrlsDisabled = !state.globalEnabled || restricted || siteDisabled || coveredByNoImgSub;
  setDisabled($("da-noimg"), noImgCtrlsDisabled);
  setDisabled($("da-noimg-sub"), noImgCtrlsDisabled || !noImgActive);

  $("da-noimg-desc").textContent = restricted
    ? "Not applicable on this page."
    : siteDisabled
      ? "Site-wide disable is on; image option not needed."
      : coveredByNoImgSub
        ? "Already enforced by a parent-domain rule."
        : `Force natural images on ${currentHostname}.`;
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

async function onNoImgChange(e) {
  if (!currentHostname) return;
  const includeSubdomains = $("da-noimg-sub").checked;
  await send({
    type: "SET_DOMAIN_IMAGE_INVERSION_DISABLED",
    hostname: currentHostname,
    disabled: e.target.checked,
    includeSubdomains
  });
  await refresh();
}

async function onNoImgSubChange(e) {
  if (!currentHostname) return;
  const entry = findNoImgEntry(currentHostname);
  if (!entry) return; // only meaningful when image-skip is on for this host
  await send({
    type: "SET_DOMAIN_IMAGE_INVERSION_DISABLED",
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
  $("da-noimg").addEventListener("change", onNoImgChange);
  $("da-noimg-sub").addEventListener("change", onNoImgSubChange);
  $("da-reload").addEventListener("click", onReload);
  document.querySelectorAll(".da-tab").forEach(b => {
    b.addEventListener("click", () => activateTab(b.dataset.tab));
  });
  $("da-open-io").addEventListener("click", onOpenIoPage);
  refresh();
});
