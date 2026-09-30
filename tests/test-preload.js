// Regression test for the phase-0 preload lightness probe (detect.js
// quickPageLightness) that gates the optimistic pre-invert.
//
// It injects the REAL content modules (00-namespace + colors + detect) as the
// FIRST child of <head> so the probe runs SYNCHRONOUSLY during parse — exactly
// the document_start view a content script has — then reads it again at load.
// This pins the two facts the preload phasing relies on:
//   • at document_start only INLINE <html> signals (style/class/color-scheme)
//     are resolved, so the probe says "dark" for the SSR/inline dark pattern
//     (→ we skip the invert, avoiding a light flash) and "unknown" otherwise
//     (→ we optimistically invert, killing the white flash);
//   • by load the head-<style>/external backgrounds are applied, so the later
//     phase correctly resolves them ("dark"/"light").
//
//   node tests/test-preload.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const SRC = path.resolve(__dirname, '..', 'src', 'content');
const MODULES = ['00-namespace.js', 'colors.js', 'detect.js']
  .map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

// The real modules + a synchronous document_start reading, as the first <head>
// child. `var DA` at module top-level becomes a global, so page.evaluate can
// re-read the probe at load.
const PROBE = `<script>\n${MODULES}\nwindow.__q_ds = DA.detect.quickPageLightness();\n</script>`;

const FIXTURES = {
  // Dark declared via inline color-scheme (+ meta): detectable at document_start.
  'dark-declared': {
    html: `<!doctype html><html style="color-scheme:dark;background:#0b0b0b"><head>${PROBE}<meta name=color-scheme content=dark><style>html,body{background:#0b0b0b;color:#eee}</style></head><body>x</body></html>`,
    ds: 'dark', load: 'dark',
  },
  // Dark via an INLINE <html> background with NO color-scheme — the probe's
  // added value over the old pageDeclaresDarkScheme() gate (step 2).
  'dark-inline-bg': {
    html: `<!doctype html><html style="background:#111111"><head>${PROBE}<style>body{color:#eee}</style></head><body>x</body></html>`,
    ds: 'dark', load: 'dark',
  },
  // Dark via head <style> only — NOT knowable at document_start ("unknown" → we
  // optimistically invert, accepting a brief light flash), but "dark" by load.
  'dark-headstyle': {
    html: `<!doctype html><html><head>${PROBE}<style>html,body{background:#111;color:#eee}</style></head><body>x</body></html>`,
    ds: 'unknown', load: 'dark',
  },
  // Plain light page — "unknown" at document_start (→ optimistic invert, the
  // white-flash fix) and "light" at load.
  'light-headstyle': {
    html: `<!doctype html><html><head>${PROBE}<style>html,body{background:#fff;color:#111}</style></head><body>x</body></html>`,
    ds: 'unknown', load: 'light',
  },
};

const results = [];
function assert(name, cond, detail) {
  results.push(!!cond);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const server = await new Promise(res => {
    const s = http.createServer((req, r2) => {
      const key = decodeURIComponent(req.url.replace(/^\//, '').replace(/\/$/, ''));
      r2.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      r2.end((FIXTURES[key] && FIXTURES[key].html) || '<!doctype html><html><body>?</body></html>');
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true });

  try {
    for (const [key, fx] of Object.entries(FIXTURES)) {
      const page = await browser.newPage();
      await page.goto(base + key, { waitUntil: 'load' });
      const ds = await page.evaluate('window.__q_ds');
      const load = await page.evaluate('DA.detect.quickPageLightness()');
      assert(`${key}: document_start → "${fx.ds}"`, ds === fx.ds, `got "${ds}"`);
      assert(`${key}: load → "${fx.load}"`, load === fx.load, `got "${load}"`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  if (passed !== results.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
