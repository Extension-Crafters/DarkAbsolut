// Regression test: DA's counter-invert filter on a darknative wrapper traps
// the z-index of an absolutely-positioned popup inside it.
//
// The bug (skyscanner.fr flight pages): the dark navy search header
// (#05203c, position:static, NO stacking context of its own) is tagged
// data-darkabsolut-darknative="1" and the injected stylesheet applies
// `filter: invert(1) hue-rotate(180deg)` to it. A non-none filter creates a
// STACKING CONTEXT. The calendar popup that opens from the header's date
// field is position:absolute with z-index:1000 and natively paints above all
// later-DOM page content (its z-index participates in the ROOT stacking
// context). Once the header gets the filter, the popup's z-index is trapped
// inside the header's stacking context — and every later-DOM element that
// ALSO gets a DA filter (counter-inverted airline-logo <img>s, darknative
// info cards) becomes a sibling stacking context at layer 0 that paints in
// DOM order, i.e. OVER the header's atomic render and therefore over the
// open calendar. The calendar is visibly covered and unclickable.
//
// Fixture: a light page (white body → DA inverts) with a Skyscanner-like
// dark navy header holding a fake date field. Clicking the field mounts the
// white calendar popup (28 day buttons + an Apply footer) that extends below
// the header — mounted AFTER the initial tagging pass, like the real site,
// which also exercises the mutation/interaction re-analysis path. Below the
// header in DOM order: a row of multi-colour logo <img>s on white cards and
// a black info card, both spatially overlapping the open popup.
//
// Asserts (extension ON):
//   • header IS tagged darknative and carries the counter-invert (fixture
//     models the site — precondition, not the bug).
//   • BUG: document.elementsFromPoint at the centre of a mid-grid day button
//     must return the day button (a popup descendant) topmost. With current
//     code a logo <img> is on top instead.
//   • BUG: the same for the popup's Apply footer vs the dark info card.
//   • BUG: a real mouse click at the day button's centre must reach the day
//     button (handler sets window.__clickedDay). With current code the click
//     lands on the covering logo <img>.
// A no-extension CONTROL run first proves the fixture natively paints the
// popup on top (so a failure with the extension is DA's doing).
//
//   node tests/test-stacking.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-stack-'));
const SHOT = path.join(__dirname, 'screenshots', 'stacking-repro.png');

// Multi-colour "airline logos" (NOT mono — so classifyLogoImg leaves them to
// the blanket img counter-invert, which is what puts a filter on them).
const LOGO = n => 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">` +
  `<rect width="120" height="60" fill="#f5f8fb"/>` +
  `<circle cx="30" cy="30" r="18" fill="${['#e74c3c', '#2980b9', '#27ae60', '#f39c12'][n]}"/>` +
  `<rect x="58" y="18" width="50" height="10" fill="#34495e"/>` +
  `<rect x="58" y="34" width="36" height="8" fill="#95a5a6"/></svg>`);

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>stacking-popup</title>
<style>
  html,body{margin:0;background:#fff;color:#222;font-family:sans-serif}
  /* Skyscanner-like dark navy search header: position:static, no z-index —
     natively it creates NO stacking context. */
  #header{background:#05203c;color:#eaf1f8;height:220px;box-sizing:border-box;padding:24px}
  #header h2{margin:0 0 10px;font-size:22px}
  .field-wrap{position:relative;display:inline-block}
  #datefield{width:160px;height:36px;background:#fff;color:#333;border:0;border-radius:4px;
    font:14px sans-serif;text-align:left;padding:0 10px;cursor:pointer}
  /* Calendar popup (mounted on click): abs-positioned, high z-index, extends
     below the header over the following content. */
  #popup{position:absolute;top:44px;left:0;z-index:1000;width:640px;box-sizing:border-box;
    background:#fff;color:#111;border:1px solid #cfd6de;border-radius:6px;
    box-shadow:0 6px 24px rgba(0,0,0,.35);padding:10px}
  #popup .mlabel{height:24px;font:600 14px sans-serif;color:#05203c;margin-bottom:6px}
  /* Sized so the OPEN popup exceeds LIGHT_CHILD_VETO_RATIO (50%) of the
     header's area, like the real Skyscanner popover (~95% of its hero):
     re-processing the header with the popup open must NOT untag it (the
     floating-overlay exemption in hasVisibleLightDescendant). */
  #popup .grid{display:grid;grid-template-columns:repeat(7,84px);gap:4px}
  #popup button.day{width:84px;height:56px;background:#f4f6f9;color:#111;
    border:1px solid #dde3ea;border-radius:4px;font:13px sans-serif;cursor:pointer}
  #popup .pfoot{margin-top:6px}
  #popup-apply{width:100%;height:40px;background:#0770e3;color:#fff;border:0;border-radius:4px;
    font:600 14px sans-serif;cursor:pointer}
  /* Airline-logo row: LATER in DOM, spatially under the open popup. */
  .logos{display:flex;gap:12px;padding:16px 24px}
  .logos .card{background:#fff;border:1px solid #e4e8ee;border-radius:6px;padding:5px}
  .logos img{display:block;width:120px;height:60px}
  /* Dark info card further down, also overlapping the popup area. */
  #darkcard{margin:0 24px;background:#000;color:#ddd;height:120px;box-sizing:border-box;
    padding:16px;font-size:14px}
  main{padding:24px}
</style></head>
<body>
  <div id="header">
    <h2>Flight search</h2>
    <div class="field-wrap">
      <button id="datefield" type="button">Departure date</button>
    </div>
  </div>
  <div class="logos">
    <div class="card"><img id="logo1" src="${LOGO(0)}" alt="airline 1"></div>
    <div class="card"><img id="logo2" src="${LOGO(1)}" alt="airline 2"></div>
    <div class="card"><img id="logo3" src="${LOGO(2)}" alt="airline 3"></div>
    <div class="card"><img id="logo4" src="${LOGO(3)}" alt="airline 4"></div>
  </div>
  <div id="darkcard">Direct flights only — 2h 05m average — best deals today</div>
  <main>
    <h1>Flight results</h1>
    ${'<p>Plenty of light body content so the page reads as a light theme and DarkAbsolut inverts it. </p>'.repeat(20)}
  </main>
<script>
  window.__clickedDay = null;
  window.__lastClick = null;
  document.addEventListener('click', e => {
    const t = e.target;
    window.__lastClick = t.tagName + (t.id ? '#' + t.id : '') +
      (t.className && typeof t.className === 'string' && t.className ? '.' + t.className.split(' ').join('.') : '');
  }, true);
  document.getElementById('datefield').addEventListener('click', () => {
    if (document.getElementById('popup')) return;
    const p = document.createElement('div');
    p.id = 'popup';
    let days = '';
    for (let i = 1; i <= 28; i++) days += '<button class="day" type="button" id="day-' + i + '">' + i + '</button>';
    p.innerHTML = '<div class="mlabel">July 2026</div><div class="grid">' + days + '</div>' +
      '<div class="pfoot"><button id="popup-apply" type="button">Apply</button></div>';
    p.addEventListener('click', ev => {
      const b = ev.target.closest('button.day');
      if (b) window.__clickedDay = b.id;
    });
    document.querySelector('.field-wrap').appendChild(p);
  });
</script>
</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

// In-page probe: what's topmost at the centre of a target element, plus the
// full hit-test stack for diagnostics. `id` must exist.
function probe(id) {
  const describe = el => {
    if (!el) return '(none)';
    let s = el.tagName;
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string' && el.className) s += '.' + el.className.split(' ').join('.');
    if (el.tagName === 'IMG') s += '[alt=' + (el.getAttribute('alt') || '') + ']';
    if (el.hasAttribute && el.hasAttribute('data-darkabsolut-darknative')) s += '[darknative]';
    return s;
  };
  const target = document.getElementById(id);
  const popup = document.getElementById('popup');
  const r = target.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const els = document.elementsFromPoint(x, y);
  return {
    x, y,
    topDesc: describe(els[0]),
    stack: els.slice(0, 6).map(describe).join(' > '),
    topIsPopup: !!(popup && els[0] && popup.contains(els[0])),
  };
}

// Fixture sanity: the probed popup buttons must spatially overlap the later-
// DOM content (a logo img / the dark card), else the test proves nothing.
function overlaps(pageIdA, pageIdB) {
  const a = document.getElementById(pageIdA).getBoundingClientRect();
  const b = document.getElementById(pageIdB).getBoundingClientRect();
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

(async () => {
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/`;

  // ── Control: NO extension — the popup must natively paint on top. ──
  const ctl = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const cpage = await ctl.newPage();
    await cpage.setViewportSize({ width: 1000, height: 760 });
    await cpage.goto(base, { waitUntil: 'load' });
    await cpage.click('#datefield');
    await cpage.waitForTimeout(200);
    const cOverlap = await cpage.evaluate(`(${overlaps})('day-16','logo1') && (${overlaps})('popup-apply','darkcard')`);
    assert('fixture: popup overlaps logo img and dark card', cOverlap, `overlap=${cOverlap}`);
    const cDay = await cpage.evaluate(`(${probe})('day-16')`);
    assert('control (no extension): day button is topmost at its centre', cDay.topIsPopup,
      `top=${cDay.topDesc}`);
    const cApply = await cpage.evaluate(`(${probe})('popup-apply')`);
    assert('control (no extension): Apply footer is topmost at its centre', cApply.topIsPopup,
      `top=${cApply.topDesc}`);
  } finally {
    await ctl.close();
  }

  // ── With the extension. ──
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true, channel: 'chromium', colorScheme: 'light',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }

    const page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    // Preconditions: page inverted, dark header tagged darknative BEFORE the
    // popup exists (initial tagging pass — mirrors the real site).
    const pre = await page.evaluate(() => ({
      root: document.documentElement.getAttribute('data-darkabsolut'),
      headerTagged: document.getElementById('header').getAttribute('data-darkabsolut-darknative'),
    }));
    assert('light page inverts', pre.root === 'on', `root=${pre.root}`);
    assert('dark navy header IS tagged darknative (precondition)', pre.headerTagged === '1',
      `darknative=${pre.headerTagged}`);

    // Open the calendar the way a user does — and let the mutation +
    // interaction re-analysis settle (throttled re-check runs ≥250ms later).
    await page.click('#datefield');
    await page.waitForTimeout(1500);

    const post = await page.evaluate(() => {
      const header = document.getElementById('header');
      const hr = header.getBoundingClientRect();
      const pr = document.getElementById('popup') ?
        document.getElementById('popup').getBoundingClientRect() : { width: 0, height: 0 };
      const hcs = getComputedStyle(header);
      return {
        headerTagged: header.getAttribute('data-darkabsolut-darknative'),
        headerFilter: hcs.filter,
        headerZ: hcs.zIndex,
        headerPos: hcs.position,
        zlift: header.getAttribute('data-darkabsolut-zlift'),
        popupBigEnough: pr.width * pr.height >= hr.width * hr.height * 0.5,
        popupMounted: !!document.getElementById('popup'),
      };
    });
    assert('popup is mounted', post.popupMounted, `mounted=${post.popupMounted}`);
    assert('fixture: popup covers >= 50% of the header area (exercises the veto exemption)',
      post.popupBigEnough, `bigEnough=${post.popupBigEnough}`);
    assert('header STAYS tagged darknative with the popup open', post.headerTagged === '1',
      `darknative=${post.headerTagged}`);
    assert('header carries the counter-invert filter (the stacking-context trigger)',
      /invert/.test(post.headerFilter), `filter=${post.headerFilter}`);
    assert('header is z-lifted to the popup\'s z-index (positioned + z-index:1000)',
      post.zlift === '1000' && post.headerZ === '1000' && post.headerPos === 'relative',
      `zlift=${post.zlift} z=${post.headerZ} pos=${post.headerPos}`);

    await page.screenshot({ path: SHOT });
    console.log(`  (screenshot saved to ${SHOT})`);

    // ── THE BUG: the open calendar must still paint above later-DOM content. ──
    const day = await page.evaluate(`(${probe})('day-16')`);
    assert('BUG: day button is topmost at its own centre (calendar not covered)',
      day.topIsPopup, `top=${day.topDesc}  stack: ${day.stack}`);

    const apply = await page.evaluate(`(${probe})('popup-apply')`);
    assert('BUG: popup Apply footer is topmost at its own centre (not under the dark card)',
      apply.topIsPopup, `top=${apply.topDesc}  stack: ${apply.stack}`);

    // Belt and braces: a REAL mouse click at the day button's centre must
    // reach the day button.
    await page.mouse.click(day.x, day.y);
    await page.waitForTimeout(100);
    const clicked = await page.evaluate(() => ({
      day: window.__clickedDay, last: window.__lastClick,
    }));
    assert('BUG: real mouse click reaches the day button', clicked.day === 'day-16',
      `clickedDay=${clicked.day}  click landed on: ${clicked.last}`);

    // The lift must use the overlay's OWN z-index, not a huge constant, so a
    // genuinely-higher site overlay (a portaled login/cookie modal) still
    // paints above the lifted header region.
    const modalTop = await page.evaluate(() => {
      const m = document.createElement('div');
      m.id = 'sitemodal';
      m.style.cssText = 'position:fixed;top:40px;left:40px;width:400px;height:300px;' +
        'z-index:2000;background:#fff;color:#111;padding:20px';
      m.textContent = 'Sign in';
      document.body.appendChild(m);
      const r = document.getElementById('day-16').getBoundingClientRect();
      const top = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)[0];
      const desc = top ? top.tagName + (top.id ? '#' + top.id : '') : '(none)';
      m.remove();
      return desc;
    });
    assert('a higher-z site modal still paints above the lifted header',
      modalTop === 'DIV#sitemodal', `top=${modalTop}`);
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
