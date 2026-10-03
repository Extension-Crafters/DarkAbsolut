// Regression test: a large DARK surface painted by a pseudo-element keeps its
// colours instead of being flipped to a light wash.
//
// The tagging reads an element's OWN background; a background painted by
// ::before / ::after was invisible to it, so the page filter inverted it:
//   • cdc.gov — the hero's dark-blue gradient scrim (.carousel-item::before,
//     over a counter-inverted photo) and the nav bar's solid blue
//     (nav::before) both turned pale, under white text → light on light;
//   • busuu.com — the header's purple→blue gradient (header::before, z-index
//     below the content) turned pale pink.
// The host now carries data-darkabsolut-pbg and the pseudo-element is
// counter-inverted.
//
//   1. Kept: gradient scrim (::before), solid colour bar (::before), brand
//      gradient behind the content (::after, negative z-index), and a
//      translucent viewport veil on <body> (which otherwise WHITENS the page).
//   2. Text on a kept surface is rescued to light.
//   3. Unchanged — not kept: a thin rule (foreground ink), a light surface, a
//      bright saturated one (the page filter darkens it), a small one (button),
//      and a host inside a kept-dark wrapper (already restored by the wrapper's
//      counter-invert).
//
//   node tests/test-pseudo-surface.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { decodePng } = require('./lib/png');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-pseudo-'));

// A mid-gray "photo" behind the hero scrim.
const PHOTO = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='32'%3E%3Crect width='100' height='32' fill='%23999999'/%3E%3C/svg%3E`;

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>pseudo-surface</title>
<style>
  html,body{margin:0;background:#fff;color:#222;font-family:sans-serif}
  .row{position:relative;width:1000px;margin-bottom:16px}
  .row>*{position:relative}
  /* (1) kept */
  #hero{height:320px;overflow:hidden}
  #hero img{position:absolute;inset:0;width:100%;height:100%}
  #hero::before{content:"";position:absolute;inset:0;z-index:1;
    background:linear-gradient(90deg,rgba(103,35,99,.9) 0px,rgba(0,87,183,.9) 55%,rgb(0,129,161) 100%)}
  #hero h2{z-index:2;color:#fff;margin:0;padding:130px 40px}
  #nav{height:80px}
  #nav::before{content:"";position:absolute;inset:0;background:#005ea2}
  #nav a{color:#fff;line-height:80px;margin-left:40px}
  #brand{height:240px;z-index:0}
  #brand::after{content:"";position:absolute;inset:0;z-index:-1;
    background:linear-gradient(20deg,#6e00f8 3%,#563ce9 28%,#116eee 93%)}
  #brand h2{color:#fff;margin:0;padding:90px 40px}
  /* own mid-gray background UNDER a dark pseudo-surface */
  #under{height:120px;background:#666}
  #under::before{content:"";position:absolute;inset:0;background:#10243b}
  #under a{color:#fff;line-height:120px;margin-left:40px}
  /* (3) unchanged */
  #rule{height:40px}
  #rule::after{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;background:#222}
  #lightp{height:160px}
  #lightp::before{content:"";position:absolute;inset:0;background:#f2f4f8}
  #bright{height:160px}
  #bright::before{content:"";position:absolute;inset:0;background:#ffc400}
  #btn{display:inline-block;width:160px;height:44px}
  #btn::before{content:"";position:absolute;inset:0;background:#222}
  #dn{background:#111;color:#eee;padding:10px;box-sizing:border-box}
  #dnin{position:relative;height:160px}
  #dnin::before{content:"";position:absolute;inset:0;background:#005ea2}
</style></head>
<body>
  <div class="row" id="hero"><img src="${PHOTO}" alt=""><h2 id="herotitle">Preparedness Month</h2></div>
  <div class="row" id="nav"><a id="navlink" href="#">Health topics</a></div>
  <div class="row" id="brand"><h2>New language, new opportunities</h2></div>
  <div class="row" id="under"><a id="underlink" href="#">Link over a covered bar</a></div>
  <div class="row" id="rule"><span>underlined heading</span></div>
  <div class="row" id="lightp"><p>light panel</p></div>
  <div class="row" id="bright"><p>bright banner</p></div>
  <div class="row" id="btn"></div>
  <div class="row" id="dn"><div id="dnin"><p>inside a kept-dark wrapper</p></div></div>
</body></html>`;

// A translucent dark veil over the whole viewport, painted by body::before
// (a modal / consent backdrop). Inverted, it becomes a WHITE veil.
const VEIL = `<!doctype html><html><head><meta charset=utf-8><title>veil</title>
<style>
  html,body{margin:0;background:#fff;color:#222;font-family:sans-serif;min-height:100vh}
  body::before{content:"";position:fixed;inset:0;background:rgba(0,0,0,.6);pointer-events:none}
</style></head>
<body><div id="blank" style="height:300px"></div><p>page under a veil</p></body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

function avgColor(buf) {
  const { width, height, channels, data } = decodePng(buf);
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
  }
  return { r: r / n, g: g / n, b: b / n };
}
const lumOf = c => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
const fmt = c => `lum=${lumOf(c).toFixed(2)} rgb(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`;

(async () => {
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url === '/veil' ? VEIL : PAGE);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/`;

  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true, channel: 'chromium', colorScheme: 'light',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }

    const page = await context.newPage();
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    const r = await page.evaluate(() => {
      const q = id => document.getElementById(id);
      const pbg = id => q(id).getAttribute('data-darkabsolut-pbg');
      const pf = (id, pe) => getComputedStyle(q(id), pe).filter;
      return {
        root: document.documentElement.getAttribute('data-darkabsolut'),
        hero: pbg('hero'), heroFilter: pf('hero', '::before'),
        nav: pbg('nav'), navFilter: pf('nav', '::before'),
        brand: pbg('brand'), brandFilter: pf('brand', '::after'),
        heroTitle: q('herotitle').getAttribute('data-darkabsolut-rtext'),
        navLink: q('navlink').getAttribute('data-darkabsolut-rtext'),
        underLink: q('underlink').getAttribute('data-darkabsolut-rtext'),
        rule: pbg('rule'), lightp: pbg('lightp'), bright: pbg('bright'), btn: pbg('btn'),
        dnin: pbg('dnin'), dnFilter: pf('dnin', '::before'),
        dn: q('dn').getAttribute('data-darkabsolut-darknative'),
      };
    });

    assert('light page inverts', r.root === 'on', `root=${r.root}`);

    // (1) kept surfaces.
    assert('gradient scrim (::before) is kept', r.hero === 'before solid' && /invert/.test(r.heroFilter),
      `pbg=${r.hero} filter=${r.heroFilter}`);
    assert('solid colour bar (::before) is kept', r.nav === 'before solid' && /invert/.test(r.navFilter),
      `pbg=${r.nav} filter=${r.navFilter}`);
    assert('brand gradient behind the content (::after) is kept', r.brand === 'after solid' && /invert/.test(r.brandFilter),
      `pbg=${r.brand} filter=${r.brandFilter}`);
    for (const [id, label] of [['hero', 'hero scrim'], ['nav', 'nav bar'], ['brand', 'brand gradient']]) {
      await page.evaluate(i => document.getElementById(i).scrollIntoView(), id);
      await page.waitForTimeout(120);
      const c = avgColor(await page.locator('#' + id).screenshot());
      // Its own (mid-dark, saturated) colours; inverted it is a pale wash (~0.7).
      assert(`${label} keeps its dark colours (not a light wash)`, lumOf(c) < 0.45, fmt(c));
    }

    // (2) text on a kept surface is rescued to light.
    assert('white title over the kept scrim is rescued', r.heroTitle === '1', `rtext=${r.heroTitle}`);
    assert('white link over the kept bar is rescued', r.navLink === '1', `rtext=${r.navLink}`);
    // The host's own (mid-gray) background lies UNDER the pseudo-surface: the
    // text's backdrop is the dark surface, not that gray.
    assert('white link is rescued even when the host has its own background', r.underLink === '1',
      `rtext=${r.underLink}`);

    // (3) unchanged.
    assert('thin rule is NOT kept (foreground ink)', r.rule == null, `pbg=${r.rule}`);
    assert('light pseudo-surface is NOT kept', r.lightp == null, `pbg=${r.lightp}`);
    assert('bright saturated pseudo-surface is NOT kept', r.bright == null, `pbg=${r.bright}`);
    assert('small pseudo-surface (button) is NOT kept', r.btn == null, `pbg=${r.btn}`);
    assert('host inside a kept-dark wrapper is NOT tagged', r.dn === '1' && r.dnin == null && r.dnFilter === 'none',
      `darknative=${r.dn} pbg=${r.dnin} filter=${r.dnFilter}`);
    await page.evaluate(() => document.getElementById('lightp').scrollIntoView());
    await page.waitForTimeout(120);
    const lp = avgColor(await page.locator('#lightp').screenshot());
    assert('light pseudo-surface still goes dark', lumOf(lp) < 0.2, fmt(lp));
    await page.evaluate(() => document.getElementById('bright').scrollIntoView());
    await page.waitForTimeout(120);
    const br = avgColor(await page.locator('#bright').screenshot());
    assert('bright pseudo-surface still goes dark', lumOf(br) < 0.4, fmt(br));

    // (1b) translucent viewport veil on <body>.
    await page.goto(base + 'veil', { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const veil = await page.evaluate(() => document.body.getAttribute('data-darkabsolut-pbg'));
    assert('viewport veil on <body> is kept', (veil || '').split(' ').includes('before'), `pbg=${veil}`);
    const vc = avgColor(await page.locator('#blank').screenshot());
    assert('page under the veil stays DARK (no white veil)', lumOf(vc) < 0.1, fmt(vc));
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
