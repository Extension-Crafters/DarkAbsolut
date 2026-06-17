// DarkAbsolut — content-script controller.
//
// Strategy: optimistically pre-apply inversion at document_start so that
// light pages never flash white. Then re-evaluate at multiple checkpoints
// (stylesheet loads, DOMContentLoaded, load, and timed re-checks) and
// toggle off if the site reveals itself to be already dark. Also watch for
// theme-class flips on <html>/<body> and prefers-color-scheme changes.

(function (DA) {
  "use strict";

  const { ensureStyle, ensureAttributeAndStyle, setImageInversionDisabled } = DA.styles;
  const {
    pageDeclaresDarkScheme,
    effectiveBgColor,
    allStylesheetsLoaded
  } = DA.detect;
  const { isNeutralDark } = DA.colors;
  const {
    markBackgroundImageElements,
    processElement,
    revertPreLightened,
    clearShadowStyles,
    tagLightIslands,
    clearLightIslands
  } = DA.elements;

  // Shared mutable state exposed on DA so detect.js can read `applied`
  // without creating a circular module dependency.
  DA.state = {
    applied: false,
    lastEnabledRequest: false,
    stableDarkConfirmed: false,
    watchersStarted: false,
    observer: null,
    recheckTimers: []
  };
  const state = DA.state;

  // Schedule a debounced full-document light-island rescan. Single-node
  // scans at mutation time often miss the real light container because:
  //   • ancestor wrappers are transparent (compose dialog uses a stack of
  //     transparent <div>s around the editor),
  //   • newly-inserted iframes aren't laid out / haven't loaded yet so
  //     getBoundingClientRect() returns 0×0 and contentDocument is empty.
  // A couple of re-scans after the DOM settles reliably catches these.
  function scheduleLightIslandRescan() {
    if (state.applied || !state.lastEnabledRequest) return;
    if (state.lightIslandRescanPending) return;
    state.lightIslandRescanPending = true;
    const passes = [80, 400, 1200];
    passes.forEach((ms, idx) => setTimeout(() => {
      if (idx === passes.length - 1) state.lightIslandRescanPending = false;
      if (state.applied || !state.lastEnabledRequest) return;
      try { tagLightIslands(document.body || document); } catch (_) {}
    }, ms));
  }

  // Hook a freshly-mounted iframe: its contentDocument isn't readable
  // until after 'load', so tag once loaded (same-origin only — a cross-
  // origin iframe throws and is silently ignored by tryTagLightIsland).
  function hookIframe(frame) {
    if (!frame || frame.tagName !== "IFRAME") return;
    if (frame.__daHooked) return;
    frame.__daHooked = true;
    const onLoad = () => {
      if (state.applied || !state.lastEnabledRequest) return;
      try { tagLightIslands(frame); } catch (_) {}
      // Also rescan the full document — a loaded iframe often unveils a
      // newly-sized ancestor that now crosses the area threshold.
      scheduleLightIslandRescan();
    };
    frame.addEventListener("load", onLoad);
    // Already-loaded iframes (cached) don't fire load again; tag inline.
    try {
      if (frame.contentDocument && frame.contentDocument.readyState === "complete") {
        onLoad();
      }
    } catch (_) { /* cross-origin */ }
  }

  // ── Mutation observer for dynamic DOM ────────────────────────────────────
  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(muts => {
      let islandsDirty = false;
      for (const m of muts) {
        if (m.type === "childList") {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (state.applied) {
              markBackgroundImageElements(n);
            } else if (state.lastEnabledRequest) {
              // Root inversion is off (page detected dark). Look for
              // large light subtrees that the site injected (compose
              // dialogs, message iframes, modals) and tag them so the
              // local-invert CSS rule can darken them.
              tagLightIslands(n);
              islandsDirty = true;
              // Hook any iframes — their contentDocument isn't readable
              // before load, so we can't classify them synchronously.
              if (n.tagName === "IFRAME") hookIframe(n);
              if (n.querySelectorAll) {
                const frames = n.querySelectorAll("iframe");
                for (const f of frames) hookIframe(f);
              }
            }
          }
        } else if (m.type === "attributes" && m.target && m.target.nodeType === 1) {
          // class/style change can flip an element's resolved background
          // (e.g. CSS variable swap, theme class). Re-process this element.
          if (state.applied) {
            processElement(m.target);
          } else if (state.lastEnabledRequest) {
            tagLightIslands(m.target);
            islandsDirty = true;
          }
        }
      }
      if (islandsDirty) scheduleLightIslandRescan();
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"]
    });
  }

  function stopObserver() {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
  }

  // Broadcast our inversion state to every descendant frame so they can
  // disable their own root inversion and avoid the double-invert effect.
  // postMessage crosses origins, which is important for cross-origin iframes
  // where ancestorIsInverted() can't synchronously introspect.
  function broadcastInversionToSubframes(inverted) {
    let frames;
    try { frames = document.querySelectorAll("iframe"); } catch (_) { return; }
    frames.forEach(f => {
      try {
        const w = f.contentWindow;
        if (w) w.postMessage({ __darkabsolut: true, inverted: !!inverted }, "*");
      } catch (_) {}
    });
  }

  // ── Apply / unapply ──────────────────────────────────────────────────────
  function apply() {
    if (state.applied) return;
    ensureStyle();
    document.documentElement.setAttribute(DA.ATTR, "on");
    const run = () => {
      try { markBackgroundImageElements(document); } catch (_) {}
      // Leftover light-island tags from a previous dark-page mode would
      // double-invert under the now-active root filter. Clear them.
      try { clearLightIslands(document); } catch (_) {}
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
    startObserver();
    state.applied = true;
    // Tell descendant frames to sit out — parent filter will invert them.
    broadcastInversionToSubframes(true);
    // A late-mounted iframe won't exist yet; re-broadcast after the DOM
    // stabilises so dynamically inserted frames still receive the signal.
    setTimeout(() => broadcastInversionToSubframes(state.applied), 300);
    setTimeout(() => broadcastInversionToSubframes(state.applied), 1500);
  }

  // Turn off root-level inversion while the extension stays active for the
  // page. The injected <style> and the mutation observer remain in place so
  // large light subtrees that appear later (Gmail compose dialog, message
  // iframes, etc.) can still be locally inverted.
  function unapplyRootInversion() {
    document.documentElement.removeAttribute(DA.ATTR);
    try { revertPreLightened(document); } catch (_) {}
    // Root filter is gone — drop shadow-root counter-invert styles so shadow
    // media isn't left inverted on the now-uninverted page.
    try { clearShadowStyles(document); } catch (_) {}
    state.applied = false;
    // Ensure the stylesheet stays mounted so the light-island rules can
    // fire on tagged descendants.
    ensureStyle();
    // Initial island scan and make sure the observer is running.
    const run = () => {
      try { tagLightIslands(document.body || document); } catch (_) {}
      try {
        const frames = document.querySelectorAll("iframe");
        for (const f of frames) hookIframe(f);
      } catch (_) {}
      scheduleLightIslandRescan();
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
    startObserver();
    // Parent no longer inverting → let children take care of themselves.
    broadcastInversionToSubframes(false);
  }

  // Hard disable for the page (global kill switch / domain opt-out).
  // Removes every trace of DarkAbsolut from the DOM.
  function disableForPage() {
    document.documentElement.removeAttribute(DA.ATTR);
    document.documentElement.removeAttribute(DA.NOIMG_ATTR);
    const style = document.getElementById(DA.STYLE_ID);
    if (style) style.remove();
    stopObserver();
    try { revertPreLightened(document); } catch (_) {}
    try { clearShadowStyles(document); } catch (_) {}
    try { clearLightIslands(document); } catch (_) {}
    state.applied = false;
    broadcastInversionToSubframes(false);
  }

  // ── Re-evaluation ────────────────────────────────────────────────────────
  function reevaluate() {
    if (!state.lastEnabledRequest) return;
    // Parent may have flipped inversion on after our initial check (races
    // between our and parent's async state query). Re-confirm each cycle.
    if (ancestorIsInverted()) {
      disableForPage();
      state.lastEnabledRequest = false;
      return;
    }
    // Trust a dark verdict only once stylesheets are actually loaded (or
    // the document has parsed). Frameworks (Next.js, next-themes, etc.)
    // often set color-scheme:dark or data-theme="dark" on <html> during
    // early hydration *before* the light stylesheet has applied; acting on
    // that prematurely removes our inversion and flashes the light theme.
    const docReady = document.readyState !== "loading";
    const stylesheetsReady = allStylesheetsLoaded() || docReady;

    let verdict = null;
    if (pageDeclaresDarkScheme()) {
      verdict = stylesheetsReady ? true : null;
    } else {
      try {
        const c = effectiveBgColor();
        if (c) verdict = isNeutralDark(c);
      } catch (_) { verdict = null; }
    }

    if (verdict === true) {
      state.stableDarkConfirmed = true;
      // Idempotent: ensures the stylesheet + observer + initial island
      // scan are in place even if we already transitioned to dark-mode.
      unapplyRootInversion();
    } else if (verdict === false) {
      // Light (or unknown styled as default white) -> keep / apply inversion,
      // but don't re-apply if we've already decided the site is stably dark.
      if (!state.applied && !state.stableDarkConfirmed) apply();
      else if (state.applied) ensureAttributeAndStyle();
    } else {
      // Unknown: while we believe we should be applied, make sure framework
      // hydration didn't strip our marker attribute / style node.
      if (state.applied) ensureAttributeAndStyle();
    }
  }

  // ── Theme watchers (stylesheet loads, class flips, prefers-color-scheme) ─
  function startThemeWatchers() {
    if (state.watchersStarted) return;
    state.watchersStarted = true;

    // Re-check whenever a stylesheet finishes loading.
    document.addEventListener("load", e => {
      const t = e.target;
      if (t && (t.tagName === "LINK" || t.tagName === "STYLE")) reevaluate();
    }, true);

    // Watch class/style mutations on <html> and <body> (theme toggles).
    // Also include our own ATTR so we self-heal if a framework removes it.
    const themeMo = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === "attributes" && m.attributeName === DA.ATTR &&
            m.target === document.documentElement) {
          if (state.applied && state.lastEnabledRequest) ensureAttributeAndStyle();
        }
      }
      reevaluate();
    });
    themeMo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", DA.ATTR]
    });
    if (document.body) {
      themeMo.observe(document.body, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"]
      });
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        if (document.body) themeMo.observe(document.body, {
          attributes: true,
          attributeFilter: ["class", "style", "data-theme"]
        });
      }, { once: true });
    }

    // Watch for newly added <link rel=stylesheet> nodes, and for removal of
    // our injected <style id="darkabsolut-style"> (frameworks sometimes
    // rewrite <head> during hydration).
    const linkMo = new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && (n.tagName === "LINK" || n.tagName === "STYLE")) {
            queueMicrotask(reevaluate);
            n.addEventListener && n.addEventListener("load", reevaluate, { once: true });
          }
        }
        for (const n of m.removedNodes) {
          if (n.nodeType === 1 && n.id === DA.STYLE_ID &&
              state.applied && state.lastEnabledRequest) {
            ensureAttributeAndStyle();
          }
        }
      }
    });
    linkMo.observe(document.documentElement, { childList: true, subtree: true });

    // OS / user color-scheme preference flip.
    try {
      const mq = matchMedia("(prefers-color-scheme: dark)");
      if (mq.addEventListener) mq.addEventListener("change", reevaluate);
      else if (mq.addListener) mq.addListener(reevaluate);
    } catch (_) {}

    // Lifecycle checkpoints.
    document.addEventListener("DOMContentLoaded", reevaluate, { once: true });
    window.addEventListener("load", reevaluate, { once: true });

    // Timed re-checks to catch JS-driven theming (framework hydration, etc.).
    [200, 600, 1500, 3000, 6000, 10000].forEach(ms => {
      state.recheckTimers.push(setTimeout(reevaluate, ms));
    });
  }

  // Detect whether an ancestor frame is already being inverted by DarkAbsolut.
  // The parent's CSS `filter: invert(1)` applies to this iframe's rendered
  // pixels; if we *also* invert here, the two cancel out and the iframe
  // content shows up in its original (unreadable) light colors. In that case
  // we must sit out and let the parent's filter do the work.
  //
  // Same-origin ancestors: we read the DA.ATTR attribute directly.
  // Cross-origin ancestors: we can't introspect them, so we conservatively
  // assume they may be inverting (the extension, if present, targets
  // <all_urls>), which is the correct choice for the vast majority of
  // cross-origin embed scenarios (admin panels, analytics iframes, etc.).
  function ancestorIsInverted() {
    if (window === window.top) return false;
    try {
      let f = window.parent;
      let hops = 0;
      while (f && hops++ < 50) {
        const el = f.document && f.document.documentElement;
        if (el && el.getAttribute(DA.ATTR) === "on") return true;
        if (f === f.parent) break;
        f = f.parent;
      }
      return false;
    } catch (_) {
      // Cross-origin: assume an invert filter may be in effect upstream.
      return true;
    }
  }

  // ── Entry point ──────────────────────────────────────────────────────────
  async function evaluateAndApply() {
    // Frames embedded under an already-inverted ancestor must not invert
    // again — it double-inverts and leaves the iframe looking light.
    if (ancestorIsInverted()) {
      disableForPage();
      state.lastEnabledRequest = false;
      return;
    }
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "GET_STATE_FOR_URL",
        url: location.href
      });
    } catch (_) { return; }
    if (!resp || !resp.ok) return;
    state.lastEnabledRequest = !!resp.enabled;
    const prevImageInversionDisabled = !!state.imageInversionDisabled;
    state.imageInversionDisabled = !!resp.imageInversionDisabled;
    setImageInversionDisabled(state.imageInversionDisabled && state.lastEnabledRequest);
    if (!resp.enabled) { disableForPage(); return; }
    // If the per-site "Force natural images" flag changed while inversion
    // is already applied, re-run element tagging so the bg-image heuristic
    // re-evaluates with the new flag value.
    if (state.applied && prevImageInversionDisabled !== state.imageInversionDisabled) {
      try { markBackgroundImageElements(document); } catch (_) {}
    }

    // Reset stable-dark memo when re-evaluating from scratch (e.g. SPA nav).
    state.stableDarkConfirmed = false;

    // 1) Pre-apply immediately to avoid a white flash on light sites. If a
    //    declared dark color-scheme is already detectable, skip pre-apply.
    if (pageDeclaresDarkScheme()) {
      state.stableDarkConfirmed = true;
      unapplyRootInversion();
    } else {
      apply();
    }

    // 2) Once the body exists, measure and start watchers.
    const init = () => { reevaluate(); startThemeWatchers(); };
    if (document.body) init();
    else document.addEventListener("DOMContentLoaded", init, { once: true });
  }

  // Listen for a parent frame announcing its inversion state. This closes
  // the race where our async GET_STATE_FOR_URL resolves before the parent's
  // and lets us handle cross-origin parents (where we can't read their
  // attribute synchronously).
  window.addEventListener("message", e => {
    const d = e && e.data;
    if (!d || d.__darkabsolut !== true) return;
    // Only accept messages from an ancestor window, never from peers.
    try {
      let w = window.parent;
      let isAncestor = false;
      let hops = 0;
      while (w && hops++ < 50) {
        if (w === e.source) { isAncestor = true; break; }
        if (w === w.parent) break;
        w = w.parent;
      }
      if (!isAncestor) return;
    } catch (_) { /* cross-origin walk threw — trust the sender */ }
    if (d.inverted) {
      if (state.applied || document.documentElement.hasAttribute(DA.ATTR)) {
        disableForPage();
      }
      state.lastEnabledRequest = false;
      state.suppressedByAncestor = true;
    } else if (state.suppressedByAncestor) {
      state.suppressedByAncestor = false;
      // Parent turned inversion off — re-run the normal flow.
      evaluateAndApply();
    }
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === "STATE_UPDATED") {
      state.recheckTimers.forEach(clearTimeout);
      state.recheckTimers = [];
      state.stableDarkConfirmed = false;
      evaluateAndApply();
    }
  });

  evaluateAndApply();
})(DA);
