// DarkAbsolut - Import/Export full-page logic
const { $, send } = DAPopup;

let currentState = { globalEnabled: true, disabledDomains: [] };

async function loadState() {
  const r = await send({ type: "GET_FULL_STATE" });
  currentState = (r && r.state) || { globalEnabled: true, disabledDomains: [] };
  $("cur-global").textContent = currentState.globalEnabled ? "On" : "Off";
  $("cur-count").textContent = String((currentState.disabledDomains || []).length);
}

function setMsg(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("ok", "error");
  if (kind) el.classList.add(kind);
}

function setStep(name, status) {
  // status: "active" | "done" | "error" | "" (reset)
  const li = document.querySelector(`#import-progress li[data-step="${name}"]`);
  if (!li) return;
  li.classList.remove("active", "done", "error");
  if (status) li.classList.add(status);
}

function resetSteps() {
  document.querySelectorAll("#import-progress li").forEach(li => {
    li.classList.remove("active", "done", "error");
  });
}

async function onExport() {
  setMsg("export-msg", "");
  try {
    await loadState();
    const payload = {
      app: "DarkAbsolut",
      version: 1,
      exportedAt: new Date().toISOString(),
      globalEnabled: !!currentState.globalEnabled,
      disabledDomains: Array.isArray(currentState.disabledDomains)
        ? currentState.disabledDomains
        : [],
      noImageInversionDomains: Array.isArray(currentState.noImageInversionDomains)
        ? currentState.noImageInversionDomains
        : [],
      enhanceContrastDomains: Array.isArray(currentState.enhanceContrastDomains)
        ? currentState.enhanceContrastDomains
        : []
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `darkabsolut-settings-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMsg("export-msg",
      `Exported ${payload.disabledDomains.length} domain(s).`,
      "ok");
  } catch (err) {
    setMsg("export-msg", "Export failed: " + (err && err.message || err), "error");
  }
}

function validateEntries(rawList) {
  const result = { kept: [], skipped: 0, found: 0 };
  if (!Array.isArray(rawList)) return result;
  result.found = rawList.length;
  const seen = new Set();
  for (const e of rawList) {
    if (!e || typeof e.domain !== "string") { result.skipped++; continue; }
    const domain = e.domain.trim().toLowerCase();
    if (!domain || seen.has(domain)) { result.skipped++; continue; }
    seen.add(domain);
    result.kept.push({ domain, includeSubdomains: !!e.includeSubdomains });
  }
  return result;
}

async function onImportFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  $("import-progress").hidden = false;
  $("import-summary").hidden = true;
  resetSteps();
  setMsg("import-msg", "");

  const previousCount = (currentState.disabledDomains || []).length;
  $("sum-cleared").textContent = String(previousCount);
  $("sum-found").textContent = "0";
  $("sum-imported").textContent = "0";
  $("sum-skipped").textContent = "0";
  $("sum-global").textContent = "—";

  try {
    setStep("read", "active");
    const text = await file.text();
    setStep("read", "done");

    setStep("parse", "active");
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("Root JSON value is not an object.");
    setStep("parse", "done");

    setStep("validate", "active");
    const v = validateEntries(data.disabledDomains);
    const vNoImg = validateEntries(data.noImageInversionDomains);
    const vHc = validateEntries(data.enhanceContrastDomains);
    const globalEnabled = typeof data.globalEnabled === "boolean" ? data.globalEnabled : true;
    $("sum-found").textContent = String(v.found);
    $("sum-skipped").textContent = String(v.skipped);
    $("sum-global").textContent = globalEnabled ? "On" : "Off";
    setStep("validate", "done");

    // The background does the actual clear + apply atomically. We split the
    // visual steps for UX, but the real work happens in IMPORT_SETTINGS.
    setStep("clear", "active");
    setStep("apply", "active");
    const r = await send({
      type: "IMPORT_SETTINGS",
      data: {
        globalEnabled,
        disabledDomains: v.kept,
        noImageInversionDomains: vNoImg.kept,
        enhanceContrastDomains: vHc.kept
      }
    });
    if (!r || !r.ok) throw new Error((r && r.error) || "Background rejected the import.");
    setStep("clear", "done");
    setStep("apply", "done");

    $("sum-imported").textContent = String(
      Array.isArray(r.state && r.state.disabledDomains) ? r.state.disabledDomains.length : v.kept.length
    );
    $("import-summary").hidden = false;

    setStep("done", "done");
    setMsg("import-msg",
      `Import complete. Cleared ${previousCount} previous domain(s), imported ${v.kept.length}.`,
      "ok");

    await loadState();
  } catch (err) {
    // Mark the first non-done step as error.
    const steps = ["read", "parse", "validate", "clear", "apply", "done"];
    for (const s of steps) {
      const li = document.querySelector(`#import-progress li[data-step="${s}"]`);
      if (!li) continue;
      if (!li.classList.contains("done")) {
        li.classList.remove("active");
        li.classList.add("error");
        break;
      }
    }
    setMsg("import-msg", "Import failed: " + (err && err.message || err), "error");
  } finally {
    e.target.value = "";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("btn-refresh").addEventListener("click", loadState);
  $("btn-export").addEventListener("click", onExport);
  $("import-file").addEventListener("change", onImportFile);
  loadState();
});
