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

// A left menu / tree whose nested lists carry a *repeating* (tiled) connector
// background image and dark-text links — the phpRedisAdmin pattern. The whole
// <ul> must NOT be counter-inverted: doing so reverts every link's dark text
// back to dark, making it invisible on the dark page. After inversion the dark
// link text must become light (visible).
const TILED_TREE_MENU = `<!doctype html><html><head><meta charset=utf-8><title>tiled-tree</title>
<style>html,body{margin:0;background:#fff;font:14px sans-serif}
#sidebar{width:100%}
#sidebar a{color:#000;text-decoration:none;display:block;padding:3px 0}
ul{list-style:none;margin:0;padding-left:18px}
ul ul{background:url('data:image/gif;base64,R0lGODlhAQAKAIABAMzMzP///yH5BAEAAAEALAAAAAABAAoAAAIEjI8ZBQA7') repeat-y}
</style></head>
<body><div id="sidebar"><ul>
  <li><a href="#">Keys</a><ul>
    ${Array.from({length:40}, (_,i)=>`<li><a href="#">menu_item_${i} link with dark text</a></li>`).join('')}
  </ul></li>
</ul></div></body></html>`;

// A white "card" banner whose only background-IMAGE is a mid-luminance,
// multi-stop brand gradient used as a thin decorative frame (the Firefox Relay
// promo-banner pattern). The visible surface is the white background-color, so
// the card must darken — not be counter-inverted back to a bright block by the
// presence of the gradient.
const GRADIENT_FRAME_CARD = `<!doctype html><html><head><meta charset=utf-8><title>gradient-frame</title>
<style>html,body{margin:0;background:#fff}
.frame{background:#ffffff linear-gradient(-90deg,#ff9100 0%,#f10366 50%,#6173ff 100%);
  padding:4px}
.card{background:#fff;color:#15141a;padding:20px 24px;font:600 18px sans-serif}</style></head>
<body><header class="frame"><div class="card">Relay works better with Firefox &nbsp; — &nbsp; Install Firefox</div></header>${PAGE_BODY}</body></html>`;

// A full-page white content wrapper carrying several near-transparent gradient
// tints (the ko-fi pattern: rgba(…,0.03)/rgba(…,0.05) overlays on a white
// surface). The wrapper holds text directly (no light-bg child to corroborate),
// so it reproduces the bug where such a wrapper was counter-inverted — reverting
// the whole content area back to light. The faint gradient must be treated as a
// tint over the white surface, so the wrapper darkens.
const FAINT_TINT_WRAPPER = `<!doctype html><html><head><meta charset=utf-8><title>faint-tint</title>
<style>html,body{margin:0;background:#fff}
.wrap{background-color:#fff;background-image:linear-gradient(0deg,rgba(0,0,0,0.03),rgba(0,0,0,0.03)),
  linear-gradient(0deg,rgba(70,124,235,0.05),rgba(70,124,235,0.05));min-height:100vh;
  padding:24px;color:#222;font-family:sans-serif}</style></head>
<body><div class="wrap"><h1>Content wrapper</h1>
  ${'<p>Paragraph of content text inside the tinted white wrapper. </p>'.repeat(30)}
</div></body></html>`;

const PAGES = {
  '/dark-bar': DARK_BAR,
  '/light-gradient': LIGHT_GRADIENT_BAR,
  '/dark-gradient': DARK_GRADIENT_BAR,
  '/logo-bar': LOGO_BAR,
  '/tiled-tree': TILED_TREE_MENU,
  '/gradient-frame': GRADIENT_FRAME_CARD,
  '/faint-tint': FAINT_TINT_WRAPPER,
};

// What we expect after DarkAbsolut runs.
//   wantDarkTop:      the header strip should be dark (low luminance).
//   wantVisibleText:  the page is dark but light (visible) text must be present
//                     — guards against text being counter-inverted to invisible.
const EXPECT = {
  '/dark-bar':       { wantDarkTop: true },
  '/light-gradient': { wantDarkTop: true },
  '/dark-gradient':  { wantDarkTop: true },
  '/logo-bar':       { wantDarkTop: true },
  '/tiled-tree':     { wantVisibleText: true },
  '/gradient-frame': { wantDarkTop: true },
  '/faint-tint':     { wantVisibleText: true },
};

module.exports = { PAGES, EXPECT };
