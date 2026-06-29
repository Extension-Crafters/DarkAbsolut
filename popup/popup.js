// DarkAbsolut - popup UI logic
const { $, send, getActiveTab, hostFromUrl, THROTTLE, clampDelay, resolveValue } = DAPopup;

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

  refreshDelay(masterOff, restricted);
  renderShortcuts();
}

// Re-analyse throttle controls: the global default applies to every site; a
// blank "this site" field inherits it (the placeholder shows what that resolves
// to), while a value writes a per-host override. The "subs" box scopes the
// override to subdomains, mirroring the per-feature rules above.
function refreshDelay(masterOff, restricted) {
  const gInput = $("da-delay-global");
  const sInput = $("da-delay-site");
  const subBox = $("da-delay-sub");
  if (!gInput || !sInput || !subBox) return;

  const globalDelay = Number.isFinite(state.globalThrottleDelay) ? state.globalThrottleDelay : THROTTLE.DEFAULT;
  gInput.value = String(globalDelay);
  gInput.disabled = !!masterOff;

  const rules = state.throttleDelayDomains || [];
  const rule = findRule(rules, currentHostname);
  // What this host resolves to with no exact rule (a parent subdomain rule, or
  // the global default) — shown as the placeholder so "blank = inherit" is clear.
  const inherited = resolveValue(
    rules.filter(r => (r.domain || "").toLowerCase() !== currentHostname),
    currentHostname, globalDelay);
  sInput.placeholder = String(inherited);
  sInput.value = rule ? String(rule.ms) : "";
  subBox.checked = rule ? !!rule.includeSubdomains : false;
  // The "subs" scope only matters once a per-host override exists — hide the
  // whole label (text + box) until then.
  const subLabel = subBox.closest(".da-perf-sub");
  if (subLabel) subLabel.hidden = !rule;

  const siteDisabled = !!masterOff || !!restricted || !currentHostname;
  setDisabled(sInput, siteDisabled);
  setDisabled(subBox, siteDisabled || !rule);
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

async function onDelayGlobalChange(e) {
  const ms = clampDelay(e.target.value);
  if (ms == null) { await refresh(); return; } // garbage → restore displayed value
  await send({ type: "SET_GLOBAL_THROTTLE", ms });
  await refresh();
}

async function onDelaySiteChange(e) {
  if (!currentHostname) return;
  const raw = (e.target.value || "").trim();
  if (raw === "") {
    // Blank → drop the override and inherit the global / parent value.
    await send({ type: "REMOVE_THROTTLE_RULE", hostname: currentHostname });
    await refresh();
    return;
  }
  const ms = clampDelay(raw);
  if (ms == null) { await refresh(); return; }
  await send({
    type: "SET_THROTTLE_RULE", hostname: currentHostname,
    includeSubdomains: $("da-delay-sub").checked, ms
  });
  await refresh();
}

async function onDelaySubChange(e) {
  if (!currentHostname) return;
  const rule = findRule(state.throttleDelayDomains, currentHostname);
  if (!rule) return; // only meaningful once a host override exists
  await send({
    type: "SET_THROTTLE_RULE", hostname: currentHostname,
    includeSubdomains: e.target.checked, ms: rule.ms
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

// ── Keyboard shortcuts: record combos for per-site / global on/off ───────────
// Each action keeps a LIST of bindings. "Add shortcut" records one (Esc cancels;
// a non-modifier alone is rejected); each binding renders as a chip with a ×
// remove button. A combo is accepted only with a qualifying modifier (Ctrl /
// Alt / AltGr / Meta) plus a non-modifier key; the background re-validates and
// de-dupes.
const SC_ACTIONS = [
  { action: "toggleDomain", listId: "da-sc-list-domain", addId: "da-sc-add-domain" },
  { action: "toggleGlobal", listId: "da-sc-list-global", addId: "da-sc-add-global" }
];
let recordingAction = null; // the action currently recording, or null

function isModifierCode(code) {
  return /^(?:Control|Alt|Shift|Meta)(?:Left|Right)$|^AltGraph$|^CapsLock$/.test(code);
}

// Human-readable modifier chips. AltGr is reported as Ctrl+Alt internally, so
// show "AltGr" alone rather than the raw pair.
function modifierParts(m) {
  const parts = [];
  if (m.altGr) parts.push("AltGr");
  else { if (m.ctrl) parts.push("Ctrl"); if (m.alt) parts.push("Alt"); }
  if (m.meta) parts.push("Meta");
  if (m.shift) parts.push("Shift");
  return parts;
}

// Label for the main key — prefer the layout-independent code so e.g. AltGr
// dead-keys still read sensibly, falling back to the event's `key`.
function keyLabel(sc) {
  const code = sc.code || "";
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
  if ((m = /^Numpad(.+)$/.exec(code))) return "Num " + m[1];
  if (code === "Space") return "Space";
  if (code) return code.replace(/^Arrow/, "");
  const key = sc.key || "";
  return key === " " ? "Space" : (key.length === 1 ? key.toUpperCase() : key);
}

function shortcutLabel(sc) {
  if (!sc || !sc.code) return "";
  return [...modifierParts(sc), keyLabel(sc)].join(" + ");
}

function setScStatus(text, invalid) {
  const status = $("da-sc-status");
  if (!status) return;
  status.textContent = text || "";
  status.classList.toggle("is-invalid", !!invalid);
}

function makeChip(action, sc, index) {
  const chip = document.createElement("span");
  chip.className = "da-sc-chip";
  const label = document.createElement("span");
  label.textContent = shortcutLabel(sc);
  chip.appendChild(label);
  const x = document.createElement("button");
  x.type = "button";
  x.className = "da-sc-chip-x";
  x.textContent = "×";
  x.setAttribute("aria-label", "Remove shortcut " + shortcutLabel(sc));
  x.addEventListener("click", () => onRemoveBinding(action, index));
  chip.appendChild(x);
  return chip;
}

function renderShortcuts() {
  const sc = (state && state.shortcuts) || { toggleDomain: [], toggleGlobal: [] };
  for (const a of SC_ACTIONS) {
    const list = $(a.listId);
    const addBtn = $(a.addId);
    if (!list || !addBtn) continue;
    const bindings = sc[a.action] || [];
    const recording = recordingAction === a.action;
    list.replaceChildren();
    bindings.forEach((b, i) => list.appendChild(makeChip(a.action, b, i)));
    if (recording) {
      const chip = document.createElement("span");
      chip.className = "da-sc-chip is-recording";
      chip.textContent = "Press keys…  (Esc)";
      list.appendChild(chip);
    } else if (!bindings.length) {
      const empty = document.createElement("span");
      empty.className = "da-sc-empty";
      empty.textContent = "None";
      list.appendChild(empty);
    }
    addBtn.textContent = recording ? "Cancel" : "Add shortcut";
    addBtn.classList.toggle("is-recording", recording);
  }
}

function onRecordKeydown(e) {
  e.preventDefault();
  e.stopPropagation();
  if (!recordingAction) return;
  const code = e.code || "";
  if (code === "Escape") { stopRecording(); return; } // cancel recording
  const mods = {
    ctrl: e.ctrlKey, alt: e.altKey,
    altGr: !!(e.getModifierState && e.getModifierState("AltGraph")),
    meta: e.metaKey, shift: e.shiftKey
  };
  if (isModifierCode(code)) {
    // Still composing — preview the held modifiers and wait for a main key.
    setScStatus([...modifierParts(mods), "…"].join(" + "), false);
    return;
  }
  if (!(mods.ctrl || mods.alt || mods.altGr || mods.meta)) {
    setScStatus("Need Ctrl, Alt or AltGr + another key", true);
    return; // stay in recording mode so the user can try again
  }
  saveBinding(recordingAction, { ...mods, code, key: e.key || "" });
}

function startRecording(action) {
  if (!recordingAction) document.addEventListener("keydown", onRecordKeydown, true);
  recordingAction = action;
  setScStatus("", false);
  renderShortcuts();
  const a = SC_ACTIONS.find(x => x.action === action);
  if (a) { const b = $(a.addId); if (b) b.blur(); } // so Space/Enter don't re-fire
}

function stopRecording() {
  recordingAction = null;
  document.removeEventListener("keydown", onRecordKeydown, true);
  setScStatus("", false);
  renderShortcuts();
}

async function saveBinding(action, sc) {
  recordingAction = null;
  document.removeEventListener("keydown", onRecordKeydown, true);
  setScStatus("", false);
  await send({ type: "ADD_SHORTCUT", action, shortcut: sc });
  await refresh();
}

function onAddClick(action) {
  if (recordingAction === action) stopRecording();
  else startRecording(action);
}

async function onRemoveBinding(action, index) {
  await send({ type: "REMOVE_SHORTCUT", action, index });
  await refresh();
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
  $("da-delay-global").addEventListener("change", onDelayGlobalChange);
  $("da-delay-site").addEventListener("change", onDelaySiteChange);
  $("da-delay-sub").addEventListener("change", onDelaySubChange);
  // "?" affordance (shown on touch devices): tap to surface a column/feature
  // explanation in the hint line — the same text desktop shows on hover.
  document.querySelectorAll(".da-q").forEach(b =>
    b.addEventListener("click", () => {
      const hint = $("da-hint");
      if (hint) hint.textContent = b.getAttribute("data-hint") || "";
    }));
  for (const a of SC_ACTIONS) {
    $(a.addId).addEventListener("click", () => onAddClick(a.action));
  }
  $("da-reload").addEventListener("click", onReload);
  document.querySelectorAll(".da-tab").forEach(b => {
    b.addEventListener("click", () => activateTab(b.dataset.tab));
  });
  $("da-open-io").addEventListener("click", onOpenIoPage);
  showVersion();
  refresh();
});
