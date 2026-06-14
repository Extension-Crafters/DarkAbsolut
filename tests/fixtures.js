// Synthetic fixture pages that reproduce common "header / banner" patterns
// where a whole-page invert plus selective counter-invert can misbehave.
// Each fixture is a light-themed page (so DarkAbsolut activates) with a
// distinctive top strip. The audit measures whether the top strip ends up
// dark (good) or stays/reverts bright (the bug we are fixing).
'use strict';

const PAGE_BODY = `
  <main style="padding:24px;font-family:sans-serif;color:#222">
    <h1>Content heading</h1>
    ${'<p>Body paragraph with enough text to fill the page so the viewport is mostly content. </p>'.repeat(30)}
  </main>`;

// A light site whose header is a solid dark brand-blue bar with white text.
// After invert the bar should NOT become a bright band.
const DARK_BAR = `<!doctype html><html><head><meta charset=utf-8><title>dark-bar</title>
<style>html,body{margin:0;background:#fff}
header{background:#0a3d62;color:#fff;padding:18px 24px;font:600 18px sans-serif}</style></head>
<body><header>BrandName &nbsp; Home &nbsp; About &nbsp; Contact</header>${PAGE_BODY}</body></html>`;

// Header uses a linear-gradient (light → lighter) behind dark text — the
// classic "decorative gradient" that shouldReinvertBgImage counter-inverts,
// reverting it back to a bright strip. This models the VFS visa header.
const LIGHT_GRADIENT_BAR = `<!doctype html><html><head><meta charset=utf-8><title>light-gradient</title>
<style>html,body{margin:0;background:#fff}
header{background:linear-gradient(135deg,#ffffff 0%,#eef3f8 100%);color:#1b3a5b;
  padding:20px 24px;font:600 18px sans-serif;border-bottom:1px solid #d4dde6}</style></head>
<body><header>VFS-like header &nbsp; Step 1 &nbsp; Step 2 &nbsp; Step 3</header>${PAGE_BODY}</body></html>`;

// Header is a dark gradient with light text (e.g. a hero/nav). Counter-invert
// here is CORRECT (keeps it dark) — a control to guard against regression.
const DARK_GRADIENT_BAR = `<!doctype html><html><head><meta charset=utf-8><title>dark-gradient</title>
<style>html,body{margin:0;background:#fff}
header{background:linear-gradient(135deg,#10243b 0%,#1f4e79 100%);color:#eaf2fb;
  padding:20px 24px;font:600 18px sans-serif}</style></head>
<body><header>Dark hero header &nbsp; Menu</header>${PAGE_BODY}</body></html>`;

// Header with a small no-repeat logo bg-image on a light bar — must darken
// normally (control; not counter-inverted).
const LOGO_BAR = `<!doctype html><html><head><meta charset=utf-8><title>logo-bar</title>
<style>html,body{margin:0;background:#fff}
header{background:#f7f7f7 url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22><circle cx=%2212%22 cy=%2212%22 r=%2210%22 fill=%22%23e44%22/></svg>') no-repeat 12px center;
  padding:18px 24px 18px 48px;color:#222;font:600 18px sans-serif}</style></head>
<body><header>Logo brand nav</header>${PAGE_BODY}</body></html>`;

const PAGES = {
  '/dark-bar': DARK_BAR,
  '/light-gradient': LIGHT_GRADIENT_BAR,
  '/dark-gradient': DARK_GRADIENT_BAR,
  '/logo-bar': LOGO_BAR,
};

// What we expect of the top strip after DarkAbsolut runs.
//   wantDarkTop: the header strip should be dark (low luminance).
const EXPECT = {
  '/dark-bar':       { wantDarkTop: true },
  '/light-gradient': { wantDarkTop: true },
  '/dark-gradient':  { wantDarkTop: true },
  '/logo-bar':       { wantDarkTop: true },
};

module.exports = { PAGES, EXPECT };
