// DarkAbsolut — content-script controller.
//
// Strategy: optimistically pre-apply inversion at document_start so that
// light pages never flash white. Then re-evaluate at multiple checkpoints
// (stylesheet loads, DOMContentLoaded, load, and timed re-checks) and
// toggle off if the site reveals itself to be already dark. Also watch for
// theme-class flips on <html>/<body> and prefers-color-scheme changes.

(function (DA) {
  "use strict";

  const {
    ensureStyle, ensureAttributeAndStyle, setImageInversionDisabled, setEnhanceContrast
  } = DA.styles;
  const {
    pageDeclaresDarkScheme,
    effectiveBgColor,
    canvasBgColor,
    fullPageBgColor,
    allStylesheetsLoaded
  } = DA.detect;
  const { isNeutralDark } = DA.colors;
  const {
    markBackgroundImageElements,
    processElement,
    revertPreLightened,
    revertRescuedText,
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
    recheckTimers: [],
    // What an ancestor frame told us about its own inversion: true = it inverts
    // (we must sit out), false = it does NOT (we must theme ourselves), null =
    // unknown. Lets a cross-origin child stop assuming its parent inverts once
    // the parent says otherwise (e.g. a natively-dark parent like plex.tv that
    // embeds a light sign-in form iframe).
    ancestorInvertedHint: null,
    // Per-site soft-dark-gray contrast (mirrored from settings each evaluate).
    enhanceContrast: false,
    // Re-analyse throttle: how long (ms) the mutation processor waits for the
    // DOM to go quiet before re-theming changed nodes. User-configurable per
    // site / globally so heavy pages (a streaming Google AI overview on a slow
    // phone) can be made lazier and stop starving keyboard/input handling.
    // Resolved from settings each evaluate; THROTTLE_DEFAULT until then.
    throttleDelay: 250,
    // "Once" mode: the user clicked the toolbar button to dark-mode THIS page
    // load even though auto-apply says off. Sticky for the page so a later
    // STATE_UPDATED broadcast can't quietly revert it; resets on navigation.
    forcedOnce: false,
    // User-recorded keyboard shortcut that toggles dark mode on/off for this
    // site. Refreshed from settings on every evaluate; null = unbound. Read by
    // the top-frame keydown handler installed at startup. See storage.js.
    toggleShortcut: null
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

  // ── Mutation observer for dynamic DOM (coalesced + rate-limited) ──────────
  // Heavy SPAs flood the page with mutations — DuckDuckGo streams results in and
  // toggles classes constantly, and infinite scroll keeps appending. Running
  // markBackgroundImageElements (a full subtree scan) and processElement
  // synchronously inside the observer callback per mutation janked page load
  // badly. Instead we COALESCE affected nodes into pending sets and FLUSH on a
  // debounced timer with a hard max-wait, doing the work in small time-budgeted
  // slices that yield to the browser between them — but always draining the
  // whole backlog (trailing edge), so the theme still fully applies in the end.
  //
  // (DA writes only data-darkabsolut-* attributes + injected CSS, never class/
  // style or DOM nodes, so processing can't re-trigger this observer — no loop.)
  //
  // Two timers, both derived from the user-configurable `state.throttleDelay`:
  //   • the DEBOUNCE flush runs `throttleDelay` ms after mutations go quiet —
  //     this is the "last word": once a burst (e.g. an AI overview finishing
  //     streaming) settles, the final state is always themed.
  //   • the MAX-WAIT flush is a relief valve for pages that NEVER go quiet
  //     (live tickers, perpetual animations) so they still get themed. It is
  //     scaled OFF the debounce (×STORM_FACTOR, floored/ceiled) so raising the
  //     delay also makes these mid-storm passes rarer — the whole point of the
  //     knob: on a slow phone a higher delay stops the greedy re-analysis that
  //     was firing every few hundred ms and starving keystroke handling.
  const THROTTLE_MIN = 60, THROTTLE_MAX = 5000, THROTTLE_DEFAULT = 250;
  const STORM_FACTOR = 6;         // max-wait = debounce × this (clamped below)
  const STORM_FLOOR_MS = 900;     // never force a mid-storm pass more often than this
  const STORM_CEIL_MS = 12000;    // …nor wait longer than this before one
  const MUT_SLICE_MS = 12;        // work at most this long per slice, then yield
  const pendingNodes = new Set(); // added subtree roots → mark/tag
  const pendingAttrs = new Set(); // class/style targets → re-process/tag
  let mutDebounceTimer = null, mutMaxWaitTimer = null, draining = false;

  function clampThrottle(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n)
      ? Math.min(THROTTLE_MAX, Math.max(THROTTLE_MIN, n))
      : THROTTLE_DEFAULT;
  }
  // Trailing-edge debounce window (ms) — the configured re-analyse delay.
  function mutDebounceMs() { return clampThrottle(state.throttleDelay); }
  // Storm relief valve (ms) — scaled off the debounce, clamped to a sane band.
  function mutMaxWaitMs() {
    return Math.min(STORM_CEIL_MS, Math.max(STORM_FLOOR_MS, mutDebounceMs() * STORM_FACTOR));
  }

  const nowMs = () =>
    (window.performance && performance.now) ? performance.now() : Date.now();

  function scheduleFlush() {
    if (mutDebounceTimer) clearTimeout(mutDebounceTimer);
    mutDebounceTimer = setTimeout(flushMutations, mutDebounceMs());
    // Guarantee a flush even while mutations never stop (the debounce keeps
    // resetting) — the max-wait timer is armed once and not reset.
    if (mutMaxWaitTimer == null) mutMaxWaitTimer = setTimeout(flushMutations, mutMaxWaitMs());
  }

  function clearFlushTimers() {
    if (mutDebounceTimer) { clearTimeout(mutDebounceTimer); mutDebounceTimer = null; }
    if (mutMaxWaitTimer) { clearTimeout(mutMaxWaitTimer); mutMaxWaitTimer = null; }
  }

  // Yield, then continue draining. requestIdleCallback runs us in the browser's
  // spare time (with a timeout so we never starve); setTimeout is the fallback.
  function yieldThenDrain() {
    draining = true;
    if (window.requestIdleCallback) requestIdleCallback(drainSlice, { timeout: 250 });
    else setTimeout(drainSlice, 16);
  }

  function flushMutations() {
    clearFlushTimers();
    if (draining) return; // a slice loop is already working through the backlog
    drainSlice();
  }

  function drainSlice() {
    draining = false;
    const applied = state.applied, lastReq = state.lastEnabledRequest;
    if (!applied && !lastReq) { pendingNodes.clear(); pendingAttrs.clear(); return; }
    const start = nowMs();
    let islandsDirty = false;

    // Added-node subtrees first (deleting as we go is safe during Set iteration).
    for (const n of pendingNodes) {
      pendingNodes.delete(n);
      if (n.nodeType === 1 && n.isConnected !== false) {
        if (applied) {
          try { markBackgroundImageElements(n); } catch (_) {}
        } else {
          // Root inversion off (page detected dark): tag injected light subtrees
          // (compose dialogs, message iframes, modals) so the local-invert rule
          // darkens them; hook iframes (contentDocument unreadable before load).
          try { tagLightIslands(n); } catch (_) {}
          islandsDirty = true;
          if (n.tagName === "IFRAME") hookIframe(n);
          else if (n.querySelectorAll) { for (const f of n.querySelectorAll("iframe")) hookIframe(f); }
        }
      }
      if (nowMs() - start > MUT_SLICE_MS) break;
    }

    // Then class/style targets (a change can flip an element's resolved bg).
    if (nowMs() - start <= MUT_SLICE_MS) {
      for (const t of pendingAttrs) {
        pendingAttrs.delete(t);
        if (t.nodeType === 1 && t.isConnected !== false) {
          if (applied) { try { processElement(t); } catch (_) {} }
          else { try { tagLightIslands(t); } catch (_) {} islandsDirty = true; }
        }
        if (nowMs() - start > MUT_SLICE_MS) break;
      }
    }

    if (islandsDirty) scheduleLightIslandRescan();
    // Backlog left (slice ran out of budget, or new mutations arrived) → keep
    // going after a yield so the job always finishes.
    if (pendingNodes.size || pendingAttrs.size) yieldThenDrain();
  }

  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === "childList") {
          for (const n of m.addedNodes) if (n.nodeType === 1) pendingNodes.add(n);
        } else if (m.type === "attributes" && m.target && m.target.nodeType === 1) {
          pendingAttrs.add(m.target);
        }
      }
      if (pendingNodes.size || pendingAttrs.size) scheduleFlush();
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
    clearFlushTimers();
    pendingNodes.clear();
    pendingAttrs.clear();
    draining = false;
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
    // Some themes apply element backgrounds via a stylesheet that loads AFTER
    // our first pass (e.g. phpMyAdmin swaps each icon's real background-image in
    // late). That's a CSS change with no element mutation, so the observer never
    // fires — re-scan a few times so those backgrounds get (re)classified.
    [700, 1800, 4000].forEach(ms => setTimeout(() => {
      if (state.applied) { try { markBackgroundImageElements(document); } catch (_) {} }
    }, ms));
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
    // Root filter is gone — restore any text we forced light for contrast.
    try { revertRescuedText(document); } catch (_) {}
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
    // Parent no longer inverting → let children take care of themselves. Re-send
    // after the DOM settles so a cross-origin iframe that mounts late (e.g. the
    // plex.tv sign-in form from app.plex.tv) still learns the parent is dark and
    // themes itself instead of sitting out forever.
    broadcastInversionToSubframes(false);
    setTimeout(() => { if (!state.applied) broadcastInversionToSubframes(false); }, 400);
    setTimeout(() => { if (!state.applied) broadcastInversionToSubframes(false); }, 1500);
  }

  // Hard disable for the page (global kill switch / domain opt-out).
  // Removes every trace of DarkAbsolut from the DOM.
  function disableForPage() {
    document.documentElement.removeAttribute(DA.ATTR);
    document.documentElement.removeAttribute(DA.NOIMG_ATTR);
    setEnhanceContrast(false);
    const style = document.getElementById(DA.STYLE_ID);
    if (style) style.remove();
    stopObserver();
    try { revertPreLightened(document); } catch (_) {}
    try { revertRescuedText(document); } catch (_) {}
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
      // effectiveBgColor() samples the current viewport, which can read dark for
      // reasons that AREN'T a page-wide dark theme: a dark footer/hero scrolled
      // into view (mesepices), or dark media filling the view — a map <canvas>,
      // video or hero (Google Maps: a light app whose map canvas is black).
      // So once we've already inverted, only UN-invert for a page-wide signal:
      // a declared dark color-scheme, or the body/html BASE background itself
      // being dark (a real theme switch). The viewport / <main> / media don't
      // count. (First-time detection — !state.applied — still honours the full
      // verdict so genuinely-dark sites are never inverted in the first place.)
      let baseDark = pageDeclaresDarkScheme();
      if (!baseDark) {
        try { const c = canvasBgColor(); baseDark = !!c && isNeutralDark(c); } catch (_) {}
      }
      // App shells (Next.js, etc.) paint the dark theme on a full-document
      // wrapper, not <html>/<body>, so canvasBgColor misses it. A wrapper that
      // covers the WHOLE document (not a band) is a real page-wide dark signal.
      if (!baseDark) {
        try { const c = fullPageBgColor(); baseDark = !!c && isNeutralDark(c); } catch (_) {}
      }
      if (state.applied && !baseDark) {
        ensureAttributeAndStyle();
      } else {
        state.stableDarkConfirmed = true;
        // Idempotent: ensures the stylesheet + observer + initial island
        // scan are in place even if we already transitioned to dark-mode.
        unapplyRootInversion();
      }
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

  // ── Throttled re-check after user interaction ───────────────────────────
  // SPA apps (Gmail, Outlook, etc.) swap the main view on click WITHOUT
  // touching <html>/<body> classes, so the theme watchers never fire and the
  // timed post-load re-checks have long since expired. A freshly-rendered view
  // (an opened message, a switched folder) can therefore be left un-themed —
  // most visibly a message body that renders in its own iframe and ends up
  // un-inverted (light) on the otherwise-dark page until something else nudges
  // it. A click-triggered re-evaluation re-runs detection, re-tags injected
  // light subtrees, and re-broadcasts our inversion state to descendant frames
  // so a double-inverted body iframe re-syncs.
  //
  // It is throttled the same way the mutation flush is: a debounce that waits
  // for the click's async render to settle, plus a hard max-wait so a stream of
  // rapid clicks still gets serviced regularly — never one heavy pass per click.
  // Both scale off the same user-configurable throttle delay (with their own
  // floors) so dialing the knob up also calms click-driven re-evaluation —
  // reevaluate() samples pixels, which is the other thing that can jank a slow
  // phone when the user is rapidly interacting with a busy page.
  const INTERACT_SETTLE_FLOOR_MS = 250;   // never run sooner than this after a click
  const INTERACT_MAX_WAIT_FLOOR_MS = 1000; // …nor force a pass more often than this
  function interactSettleMs() { return Math.max(INTERACT_SETTLE_FLOOR_MS, mutDebounceMs()); }
  function interactMaxWaitMs() { return Math.max(INTERACT_MAX_WAIT_FLOOR_MS, mutDebounceMs() * 4); }
  let interactTimer = null, interactMaxTimer = null;

  function runInteractionRecheck() {
    // Null BOTH timers after clearing: the next click batch re-arms the max-wait
    // via the `interactMaxTimer == null` check in scheduleInteractionRecheck, so
    // dropping this reset would wedge the max-wait off after the first run.
    if (interactTimer) { clearTimeout(interactTimer); interactTimer = null; }
    if (interactMaxTimer) { clearTimeout(interactMaxTimer); interactMaxTimer = null; }
    if (!state.lastEnabledRequest) return;
    reevaluate();
    // Re-sync whichever mode we ended up in: inverted pages re-announce to
    // descendant frames (fixes a body iframe left double-inverted/light); dark
    // pages re-scan for newly-injected light subtrees (compose dialog, message
    // pane). Cheap — the mutation observer already handles per-node bg tagging.
    if (state.applied) broadcastInversionToSubframes(true);
    else scheduleLightIslandRescan();
  }

  function scheduleInteractionRecheck() {
    if (!state.lastEnabledRequest) return;
    if (interactTimer) clearTimeout(interactTimer);
    interactTimer = setTimeout(runInteractionRecheck, interactSettleMs());
    if (interactMaxTimer == null) {
      interactMaxTimer = setTimeout(runInteractionRecheck, interactMaxWaitMs());
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

    // Re-check shortly after a click — catches SPA view swaps (open a Gmail
    // message, switch folder) that re-render the main panel without a theme
    // change. Capture phase + passive so the app can't suppress it and we never
    // delay the click. Throttled inside scheduleInteractionRecheck.
    document.addEventListener("click", scheduleInteractionRecheck, { capture: true, passive: true });

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
      // Cross-origin: we can't read the ancestor. Trust what it told us via
      // postMessage if anything (hint===false → it is NOT inverting, so we must
      // theme ourselves); otherwise assume it may be inverting (conservative,
      // correct for the common "inverted admin panel embeds an iframe" case).
      return state.ancestorInvertedHint !== false;
    }
  }

  // Ask the parent frame whether it is inverting (used when we'd otherwise sit
  // out for a cross-origin ancestor we can't introspect). The parent replies via
  // postMessage, which sets our hint and may un-suppress us. Robust to broadcast
  // timing because the child initiates once it's ready.
  function requestAncestorState() {
    if (window === window.top) return;
    try { window.parent.postMessage({ __darkabsolut_req: true }, "*"); } catch (_) {}
  }

  // ── Toggle shortcut (keyboard binding for per-site on/off) ───────────────
  // The user records a combo in the popup (stored in settings); pressing it on
  // any page flips dark mode on/off for the current site. We register one
  // capturing keydown handler in the TOP frame only (so a focused iframe can't
  // double-fire it and the host we toggle is always the main page's), and read
  // the binding from state.toggleShortcut, which evaluateAndApply keeps fresh.

  // Codes that are themselves modifier keys — never the shortcut's main key.
  // Keep in sync with storage.js MODIFIER_CODE_RE.
  const MODIFIER_CODE_RE =
    /^(?:Control|Alt|Shift|Meta)(?:Left|Right)$|^AltGraph$|^CapsLock$/;

  function shortcutMatches(sc, e) {
    if (!sc || !sc.code || e.code !== sc.code) return false;
    if (MODIFIER_CODE_RE.test(e.code)) return false;
    const altGr = !!(e.getModifierState && e.getModifierState("AltGraph"));
    return !!sc.ctrl === !!e.ctrlKey
      && !!sc.alt === !!e.altKey
      && !!sc.shift === !!e.shiftKey
      && !!sc.meta === !!e.metaKey
      && !!sc.altGr === altGr;
  }

  function onShortcutKeydown(e) {
    if (e.repeat) return; // holding the combo must not toggle repeatedly
    const sc = state.toggleShortcut;
    if (!shortcutMatches(sc, e)) return;
    e.preventDefault();
    e.stopPropagation();
    // Background flips this host's dark rule and broadcasts STATE_UPDATED,
    // which re-runs evaluateAndApply here to apply/remove the theme.
    try { chrome.runtime.sendMessage({ type: "TOGGLE_DOMAIN_DARK", url: location.href }); } catch (_) {}
  }

  function installShortcutHandler() {
    if (state.shortcutHandlerInstalled || window !== window.top) return;
    state.shortcutHandlerInstalled = true;
    window.addEventListener("keydown", onShortcutKeydown, true);
  }

  // ── Entry point ──────────────────────────────────────────────────────────
  async function evaluateAndApply() {
    // Frames embedded under an already-inverted ancestor must not invert
    // again — it double-inverts and leaves the iframe looking light.
    if (ancestorIsInverted()) {
      disableForPage();
      state.lastEnabledRequest = false;
      // We're sitting out on the assumption the (cross-origin) parent inverts.
      // Confirm it: if it replies that it does NOT, we'll re-evaluate and theme
      // ourselves (fixes a light iframe inside a natively-dark cross-origin page).
      requestAncestorState();
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
    // Keep the bound shortcut current even on pages where we apply nothing
    // (disabled host, master off) — the user must still be able to turn dark
    // mode back ON for the site via the keyboard. Set before any early return.
    state.toggleShortcut = (resp.state && resp.state.toggleShortcut) || null;
    // A one-time button click only forces the page on while we're still in
    // "once" mode; leaving that mode clears the forced state.
    if (resp.mode !== "once") state.forcedOnce = false;
    // "Once" mode: a one-time button click forces this page on even though
    // auto-apply (resp.enabled) is false — but never past the master kill switch
    // (resp.state.globalEnabled), so "off" still means nothing is applied.
    const masterOn = !(resp.state && resp.state.globalEnabled === false);
    const effectiveEnabled = !!resp.enabled || (resp.mode === "once" && state.forcedOnce && masterOn);
    state.lastEnabledRequest = effectiveEnabled;
    const prevImageInversionDisabled = !!state.imageInversionDisabled;
    state.imageInversionDisabled = !!resp.imageInversionDisabled;
    setImageInversionDisabled(state.imageInversionDisabled && state.lastEnabledRequest);
    state.enhanceContrast = !!resp.enhanceContrast;
    // Resolved per-site / global re-analyse throttle (drives the mutation
    // debounce + max-wait + interaction recheck). Set before apply()/observer
    // start so the very first flush already uses the configured delay.
    state.throttleDelay = clampThrottle(resp.throttleDelay);
    if (!effectiveEnabled) { disableForPage(); return; }
    setEnhanceContrast(state.enhanceContrast);
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
    } else if (window === window.top) {
      // Optimistic pre-apply avoids a white flash on light top-level pages.
      apply();
    }
    // else: a subframe under a non-inverting ancestor. Do NOT optimistically
    // invert — most cross-origin subframes are ads / trackers / extension
    // overlays that must stay native (blanket-inverting a Twitch pre-roll ad
    // iframe paints a light block in place of the video). reevaluate() below
    // applies() only when it positively detects a light background (e.g. the
    // Plex sign-in form), so genuinely-light embedded forms still get themed.

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
    if (!d) return;
    // A descendant frame asks whether we're inverting → reply with our state.
    if (d.__darkabsolut_req === true) {
      try { e.source && e.source.postMessage({ __darkabsolut: true, inverted: !!state.applied }, "*"); } catch (_) {}
      return;
    }
    if (d.__darkabsolut !== true) return;
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
    state.ancestorInvertedHint = !!d.inverted;
    if (d.inverted) {
      if (state.applied || document.documentElement.hasAttribute(DA.ATTR)) {
        disableForPage();
      }
      state.lastEnabledRequest = false;
      state.suppressedByAncestor = true;
    } else {
      // Ancestor is NOT inverting — we must theme ourselves. Re-evaluate
      // regardless of how we sat out (a message OR the cross-origin assumption),
      // now that the hint lets ancestorIsInverted() return false.
      state.suppressedByAncestor = false;
      evaluateAndApply();
    }
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === "STATE_UPDATED") {
      state.recheckTimers.forEach(clearTimeout);
      state.recheckTimers = [];
      state.stableDarkConfirmed = false;
      evaluateAndApply();
    } else if (msg && msg.type === "APPLY_ONCE") {
      // "Once" mode toolbar click: dark-mode this page for this page load only.
      state.forcedOnce = true;
      state.recheckTimers.forEach(clearTimeout);
      state.recheckTimers = [];
      state.stableDarkConfirmed = false;
      evaluateAndApply();
    }
  });

  installShortcutHandler();
  evaluateAndApply();
})(DA);
