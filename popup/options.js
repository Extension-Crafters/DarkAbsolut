// DarkAbsolut — full-page options: table of every per-site config in memory.
const { $, send } = DAPopup;

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(width, paths) {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", width);
  el.setAttribute("height", width);
  el.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("fill", "currentColor");
    p.setAttribute("d", d);
    el.appendChild(p);
  }
  return el;
}

// External-link and trash glyphs (Material-ish, single path each).
const ICON_OPEN = "M14 3v2h3.6l-9.3 9.3 1.4 1.4L19 6.4V10h2V3h-7zM5 5h5V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5h-2v5H5V5z";
const ICON_TRASH = "M9 3v1H4v2h16V4h-5V3H9zM6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13H6z";

// Merge the two domain lists into one row per host so a domain that is both
// theme-disabled and image-overridden shows as a single line.
function buildRows(state) {
  const map = new Map();
  const get = (host) => {
    const key = host.toLowerCase();
    if (!map.has(key)) map.set(key, { domain: key });
    return map.get(key);
  };
  for (const e of state.disabledDomains || []) {
    if (!e || typeof e.domain !== "string") continue;
    const r = get(e.domain);
    r.themeDisabled = true;
    r.themeSub = !!e.includeSubdomains;
  }
  for (const e of state.noImageInversionDomains || []) {
    if (!e || typeof e.domain !== "string") continue;
    const r = get(e.domain);
    r.naturalImages = true;
    r.imgSub = !!e.includeSubdomains;
  }
  return [...map.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

function badge(text, kind, subLabel) {
  const wrap = document.createElement("div");
  const b = document.createElement("span");
  b.className = "opt-badge " + kind;
  b.textContent = text;
  wrap.appendChild(b);
  if (subLabel) {
    const s = document.createElement("span");
    s.className = "opt-sub";
    s.textContent = subLabel;
    wrap.appendChild(s);
  }
  return wrap;
}

function renderRow(row) {
  const tr = document.createElement("tr");

  // Site (clickable link → new tab)
  const tdSite = document.createElement("td");
  tdSite.className = "opt-site";
  const a = document.createElement("a");
  a.className = "opt-link";
  a.href = "https://" + row.domain + "/";
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = "Open " + row.domain + " in a new tab";
  a.appendChild(document.createTextNode(row.domain));
  a.appendChild(svg("14", [ICON_OPEN]));
  tdSite.appendChild(a);
  tr.appendChild(tdSite);

  // Dark theme column
  const tdTheme = document.createElement("td");
  tdTheme.appendChild(
    row.themeDisabled
      ? badge("Disabled", "opt-badge-off", row.themeSub ? "incl. subdomains" : null)
      : badge("On (auto)", "opt-badge-muted", null)
  );
  tr.appendChild(tdTheme);

  // Natural images column
  const tdImg = document.createElement("td");
  tdImg.appendChild(
    row.naturalImages
      ? badge("Forced", "opt-badge-on", row.imgSub ? "incl. subdomains" : null)
      : badge("Auto", "opt-badge-muted", null)
  );
  tr.appendChild(tdImg);

  // Actions
  const tdAct = document.createElement("td");
  tdAct.className = "opt-actions";
  const btn = document.createElement("button");
  btn.className = "opt-remove";
  btn.type = "button";
  btn.dataset.host = row.domain;
  btn.appendChild(svg("14", [ICON_TRASH]));
  btn.appendChild(document.createTextNode("Remove"));
  btn.addEventListener("click", () => onRemove(row.domain));
  tdAct.appendChild(btn);
  tr.appendChild(tdAct);

  return tr;
}

function setMsg(text, kind) {
  const el = $("opt-msg");
  el.textContent = text || "";
  el.classList.remove("ok", "error");
  if (kind) el.classList.add(kind);
}

async function render() {
  const r = await send({ type: "GET_FULL_STATE" });
  const state = (r && r.state) || { disabledDomains: [], noImageInversionDomains: [] };
  const rows = buildRows(state);

  const tbody = $("opt-rows");
  tbody.replaceChildren(...rows.map(renderRow));

  const count = rows.length;
  $("opt-count-top").textContent = String(count);
  $("opt-count-bottom").textContent = String(count);
  $("opt-empty").hidden = count > 0;
  $("opt-clear-top").disabled = count === 0;
  $("opt-clear-bottom").disabled = count === 0;
}

async function onRemove(host) {
  setMsg("");
  const r = await send({ type: "REMOVE_DOMAIN_CONFIG", hostname: host });
  if (!r || !r.ok) {
    setMsg("Could not remove " + host + ": " + ((r && r.error) || "unknown error"), "error");
    return;
  }
  setMsg("Removed saved settings for " + host + ".", "ok");
  await render();
}

async function onClearAll() {
  const count = $("opt-rows").childElementCount;
  if (count === 0) return;
  const ok = window.confirm(
    `Remove the saved settings for all ${count} site(s)?\n\n` +
    `This clears every per-site override. Your global on/off switch is left unchanged. ` +
    `This cannot be undone.`
  );
  if (!ok) return;

  setMsg("");
  const r = await send({ type: "CLEAR_ALL_DOMAINS" });
  if (!r || !r.ok) {
    setMsg("Could not clear settings: " + ((r && r.error) || "unknown error"), "error");
    return;
  }
  setMsg(`Cleared saved settings for ${count} site(s).`, "ok");
  await render();
}

document.addEventListener("DOMContentLoaded", () => {
  $("opt-clear-top").addEventListener("click", onClearAll);
  $("opt-clear-bottom").addEventListener("click", onClearAll);

  // Keep the table in sync if settings change elsewhere (e.g. the popup on
  // another tab) while this page is open.
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") render();
  });

  render();
});
