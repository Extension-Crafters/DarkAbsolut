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
    try {
      const u = new URL(url);
      // Mirror matching.js: local files share one pseudo-host so the popup's
      // per-"site" controls operate on the same key the background uses.
      if (u.protocol === "file:") return "localfile";
      return u.hostname.toLowerCase();
    } catch { return ""; }
  }

  // Re-analyse throttle bounds — keep in sync with background/storage.js and
  // content/controller.js.
  const THROTTLE = { DEFAULT: 250, MIN: 60, MAX: 5000 };

  // Clamp a user-entered delay to whole ms within [MIN, MAX]; non-numbers → null
  // so callers can treat a blank/garbage field as "inherit" rather than a value.
  function clampDelay(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    return Math.min(THROTTLE.MAX, Math.max(THROTTLE.MIN, n));
  }

  // Numeric mirror of matching.resolveValue: exact host > longest subdomain
  // rule > global default. Returns the matched rule's `ms`, else the default.
  function resolveValue(rules, host, globalDefault) {
    if (!host) return globalDefault;
    const h = host.toLowerCase();
    let exact = null, sub = null, subLen = -1;
    for (const e of rules || []) {
      const d = (e.domain || "").toLowerCase();
      if (!d) continue;
      if (h === d) { exact = e; break; }
      if (e.includeSubdomains && h.endsWith("." + d) && d.length > subLen) { sub = e; subLen = d.length; }
    }
    const m = exact || sub;
    return m ? m.ms : globalDefault;
  }

  // ── Keyboard-shortcut recorder (shared by the popup + the options page) ─────
  // Each action keeps a LIST of bindings. "Add shortcut" records one (Esc
  // cancels; a bare non-modifier is rejected); each binding renders as a chip
  // with a × remove button. A combo is accepted only with a qualifying modifier
  // (Ctrl / Alt / AltGr / Meta) plus a non-modifier key; the background
  // re-validates and de-dupes. Both host pages use the same #da-sc-* element IDs.
  const SC_ACTIONS = [
    { action: "toggleDomain", listId: "da-sc-list-domain", addId: "da-sc-add-domain" },
    { action: "toggleGlobal", listId: "da-sc-list-global", addId: "da-sc-add-global" }
  ];

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

  // Build a shortcut UI bound to the host page's #da-sc-* elements.
  //   getShortcuts() → the current { toggleDomain:[], toggleGlobal:[] } map
  //   afterChange()  → re-fetch + re-render the page after a binding add/remove
  // Returns { render, wire }: call render() whenever page state refreshes, and
  // wire() once to attach the "Add shortcut" button handlers.
  function createShortcutUI({ getShortcuts, afterChange }) {
    let recordingAction = null; // the action currently recording, or null

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

    function render() {
      const sc = getShortcuts() || { toggleDomain: [], toggleGlobal: [] };
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
      render();
      const a = SC_ACTIONS.find(x => x.action === action);
      if (a) { const b = $(a.addId); if (b) b.blur(); } // so Space/Enter don't re-fire
    }

    function stopRecording() {
      recordingAction = null;
      document.removeEventListener("keydown", onRecordKeydown, true);
      setScStatus("", false);
      render();
    }

    async function saveBinding(action, sc) {
      recordingAction = null;
      document.removeEventListener("keydown", onRecordKeydown, true);
      setScStatus("", false);
      await send({ type: "ADD_SHORTCUT", action, shortcut: sc });
      await afterChange();
    }

    function onAddClick(action) {
      if (recordingAction === action) stopRecording();
      else startRecording(action);
    }

    async function onRemoveBinding(action, index) {
      await send({ type: "REMOVE_SHORTCUT", action, index });
      await afterChange();
    }

    function wire() {
      for (const a of SC_ACTIONS) {
        const b = $(a.addId);
        if (b) b.addEventListener("click", () => onAddClick(a.action));
      }
    }

    return { render, wire };
  }

  return { $, send, getActiveTab, hostFromUrl, THROTTLE, clampDelay, resolveValue, createShortcutUI };
})();
