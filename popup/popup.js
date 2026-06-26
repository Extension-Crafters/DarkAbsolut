// DarkAbsolut - popup UI logic
const { $, send, getActiveTab, hostFromUrl } = DAPopup;

let currentTab = null;
let currentHostname = "";
let state = null;

// Each feature has a global default + a per-host/per-subdomain valued-rule list.
// The popup's three checkbox columns map to: global → this-host → subdomains.
const FEATURES = [
  { msg: "dark",     key: "disabledDomains",        global: "globalDarkMode",      g: "da-dark-global", host: "da-domain", sub: "da-sub" },
  { msg: "img",      key: "noImageInversionDomains", global: "globalNaturalImages", g: "da-img-global",  host: "da-noimg",  sub: "da-noimg-sub" },
  { msg: "contrast", key: "enhanceContrastDomains",  global: "globalSoftGray",      g: "da-hc-global",   host: "da-hc",     sub: "da-hc-sub" }
];

// Mirror of background matching.resolveFeature: exact host > longest subdomain
// rule > global default. `on` is each rule's explicit value.
function resolveFeature(rules, host, globalDefault) {
  if (!host) return !!globalDefault;
  const h = host.toLowerCase();
  let exact = null, sub = null, subLen = -1;
  for (const e of rules || []) {
    const d = (e.domain || "").toLowerCase();
    if (!d) continue;
    if (h === d) { exact = e; break; }
    if (e.includeSubdomains && h.endsWith("." + d) && d.length > subLen) { sub = e; subLen = d.length; }
  }
  const m = exact || sub;
  return m ? !!m.on : !!globalDefault;
}

function findRule(rules, host) {
  return (rules || []).find(e => (e.domain || "").toLowerCase() === host) || null;
}

function setDisabled(el, disabled) {
  if (!el) return;
  el.disabled = !!disabled;
}

async function refresh() {
  currentTab = await getActiveTab();
  const url = currentTab && currentTab.url || "";
  currentHostname = hostFromUrl(url);
  const r = await send({ type: "GET_FULL_STATE" });
  state = (r && r.state) || {};

  $("da-host").textContent = currentHostname || "(no site)";
  $("da-global").checked = !!state.globalEnabled;
  const modeSel = $("da-mode");
  if (modeSel) modeSel.value = state.mode || "filter";

  const restricted = !currentHostname || /^(chrome|edge|about|moz-extension|chrome-extension|view-source):/i.test(url);
  const masterOff = !state.globalEnabled;

  // Is dark mode effectively going to apply to THIS host? (governs whether the
  // image / soft-gray per-site controls are meaningful).
  const darkActive = state.mode === "toggle"
    ? !!state.toggleOn
    : resolveFeature(state.disabledDomains, currentHostname, state.globalDarkMode);

  let anySub = false;
  for (const f of FEATURES) {
    const rules = state[f.key] || [];
    const globalOn = !!state[f.global];
    const rule = findRule(rules, currentHostname);
    const effective = resolveFeature(rules, currentHostname, globalOn);
    if (rule) anySub = true;

    $(f.g).checked = globalOn;
    $(f.host).checked = effective;
    $(f.sub).checked = rule ? !!rule.includeSubdomains : false;
    $(f.sub).hidden = !rule;

    // Image / soft-gray only matter when dark mode actually applies.
    const gated = f.msg !== "dark" && !darkActive;
    setDisabled($(f.g), masterOff || gated);
    setDisabled($(f.host), masterOff || restricted || gated);
    setDisabled($(f.sub), masterOff || restricted || gated);
  }

  // Collapse the subdomains column when no feature has a per-site rule here.
  document.querySelector(".da-ptable")?.classList.toggle("da-no-subs", !anySub);

  const hint = $("da-hint");
  if (hint) {
    hint.textContent =
      masterOff ? "Master switch is off."
        : state.mode === "once" ? "Click mode: the toolbar button dark-modes the current page. Settings via right-click → Options."
          : state.mode === "toggle" ? "Toggle mode: the toolbar button turns dark mode on/off. Settings via right-click → Options."
            : restricted ? "Not available on this browser page."
              : !currentHostname ? "No site in this tab."
                : "";
  }
}

async function onModeChange(e) {
  await send({ type: "SET_MODE", mode: e.target.value });
  await refresh();
}

async function onGlobalChange(e) {
  await send({ type: "SET_GLOBAL_ENABLED", value: e.target.checked });
  await refresh();
}

function featureByGlobalId(id) { return FEATURES.find(f => f.g === id); }
function featureByHostId(id) { return FEATURES.find(f => f.host === id); }
function featureBySubId(id) { return FEATURES.find(f => f.sub === id); }

async function onFeatureGlobalChange(e) {
  const f = featureByGlobalId(e.target.id);
  if (!f) return;
  await send({ type: "SET_GLOBAL_FEATURE", feature: f.msg, value: e.target.checked });
  await refresh();
}

async function onFeatureHostChange(e) {
  const f = featureByHostId(e.target.id);
  if (!f || !currentHostname) return;
  const value = e.target.checked;
  const rules = state[f.key] || [];
  const sub = $(f.sub).checked;
  const exact = findRule(rules, currentHostname);
  // What this host would resolve to with NO exact rule — a parent
  // include-subdomains rule, or the global default. We only drop the exact rule
  // when it adds nothing (matches that baseline AND we're not scoping to
  // subdomains). Comparing against the global alone would wrongly try to REMOVE
  // a non-existent rule when the host inherits from a parent subdomain rule,
  // leaving the checkbox unable to override it.
  const inherited = resolveFeature(
    rules.filter(r => (r.domain || "").toLowerCase() !== currentHostname),
    currentHostname, !!state[f.global]);
  if (value === inherited && !sub) {
    if (exact) await send({ type: "REMOVE_FEATURE_RULE", feature: f.msg, hostname: currentHostname });
  } else {
    await send({ type: "SET_FEATURE_RULE", feature: f.msg, hostname: currentHostname, includeSubdomains: sub, on: value });
  }
  await refresh();
}

async function onFeatureSubChange(e) {
  const f = featureBySubId(e.target.id);
  if (!f || !currentHostname) return;
  const rule = findRule(state[f.key], currentHostname);
  if (!rule) return; // only meaningful once a host rule exists
  await send({ type: "SET_FEATURE_RULE", feature: f.msg, hostname: currentHostname, includeSubdomains: e.target.checked, on: !!rule.on });
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

// Show the real extension version from the manifest, so it never needs to be
// kept in sync by hand (the single source of truth is manifest.json "version").
function showVersion() {
  const el = document.querySelector(".da-version");
  if (!el) return;
  try {
    const v = chrome.runtime.getManifest().version;
    if (v) el.textContent = "v" + v;
  } catch (_) { /* not in an extension context */ }
}

function onOpenIoPage() {
  // The popup closes as soon as a file picker / download dialog steals
  // focus, which interrupts import/export work. Hand off to a real page.
  const url = chrome.runtime.getURL("popup/io.html");
  chrome.tabs.create({ url });
  window.close();
}

document.addEventListener("DOMContentLoaded", () => {
  $("da-mode").addEventListener("change", onModeChange);
  $("da-global").addEventListener("change", onGlobalChange);
  for (const f of FEATURES) {
    $(f.g).addEventListener("change", onFeatureGlobalChange);
    $(f.host).addEventListener("change", onFeatureHostChange);
    $(f.sub).addEventListener("change", onFeatureSubChange);
  }
  // "?" affordance (shown on touch devices): tap to surface a column/feature
  // explanation in the hint line — the same text desktop shows on hover.
  document.querySelectorAll(".da-q").forEach(b =>
    b.addEventListener("click", () => {
      const hint = $("da-hint");
      if (hint) hint.textContent = b.getAttribute("data-hint") || "";
    }));
  $("da-reload").addEventListener("click", onReload);
  document.querySelectorAll(".da-tab").forEach(b => {
    b.addEventListener("click", () => activateTab(b.dataset.tab));
  });
  $("da-open-io").addEventListener("click", onOpenIoPage);
  showVersion();
  refresh();
});
