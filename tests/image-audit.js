// Image-color & text-inversion audit for DarkAbsolut.
//
// Loads the real extension on many image-heavy sites and, for each, runs a
// DOM "inversion parity" check. The page applies `filter: invert()` on <html>
// and again on counter-inverted elements; a rendered element's pixels are
// inverted once per `filter:invert` in its ancestor-or-self chain. So:
//   • media (img/picture/video/canvas/svg image) must end with an EVEN count
//     (back to true colors). An ODD count = a colour-negative image.
//   • a large url() background-image (a photo) likewise must be EVEN.
//   • readable text needs the same inversion parity as the background it sits
//     on; a mismatch means the designed contrast was flipped (text can vanish).
//
//   node tests/image-audit.js                # default site list (headless)
//   node tests/image-audit.js <url> [name]   # one URL
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'screenshots', 'image-audit');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-imgaudit-'));
fs.mkdirSync(OUT, { recursive: true });

const SITES = process.argv[2]
  ? [[process.argv[3] || 'url', process.argv[2]]]
  : [
      ['wikipedia',   'https://en.wikipedia.org/wiki/Tokyo'],
      ['bbc',         'https://www.bbc.com/news'],
      ['cnn',         'https://www.cnn.com/'],
      ['amazon',      'https://www.amazon.com/s?k=headphones'],
      ['ebay',        'https://www.ebay.com/b/Sneakers/15709/bn_57918'],
      ['imdb',        'https://www.imdb.com/chart/top/'],
      ['espn',        'https://www.espn.com/'],
      ['etsy',        'https://www.etsy.com/c/jewelry'],
      ['unsplash',    'https://unsplash.com/'],
      ['pexels',      'https://www.pexels.com/'],
      ['wikihow',     'https://www.wikihow.com/Main-Page'],
      ['w3schools',   'https://www.w3schools.com/'],
      ['github',      'https://github.com/trending'],
      ['stackoverflow','https://stackoverflow.com/questions'],
      ['mdn',         'https://developer.mozilla.org/en-US/'],
      ['nytimes',     'https://www.nytimes.com/'],
      ['theverge',    'https://www.theverge.com/'],
      ['booking',     'https://www.booking.com/'],
      ['yelp',        'https://www.yelp.com/sf'],
      ['producthunt', 'https://www.producthunt.com/'],
      ['gmaps',       'https://www.google.com/maps/@48.8584,2.2945,14z'],
    ];

// In-page probe (stringified; runs in page context).
function probe() {
  function invCount(el, includeSelf) {
    let n = 0, cur = includeSelf ? el : el.parentElement;
    while (cur) {
      let f = '';
      try { f = getComputedStyle(cur).filter; } catch (_) {}
      if (/invert/.test(f)) n++;
      cur = cur.parentElement;
    }
    return n;
  }
  function rgb(s) {
    const m = s && s.match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const p = m[1].split(',').map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p[3] == null ? 1 : p[3] };
  }
  function lum(c) {
    const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  const visible = el => {
    const r = el.getBoundingClientRect();
    return r.width * r.height >= 6000 && r.bottom > 0 && r.top < (innerHeight * 3);
  };

  const out = {
    root: document.documentElement.getAttribute('data-darkabsolut'),
    mediaTotal: 0, mediaWrong: 0, mediaSamples: [],
    bgPhotoTotal: 0, bgPhotoWrong: 0, bgSamples: [],
    textChecked: 0, textWrong: 0, textSamples: [],
  };
  if (out.root !== 'on') return out; // not inverted → nothing to check

  // Collect matching elements across the document AND open shadow roots
  // (querySelectorAll does not cross shadow boundaries — shadow-DOM media is
  // exactly where the colour-negative bug lives, so we must descend into it).
  function queryDeep(sel) {
    const out = [];
    const walk = root => {
      try { for (const el of root.querySelectorAll(sel)) out.push(el); } catch (_) {}
      let hosts = [];
      try { hosts = root.querySelectorAll('*'); } catch (_) {}
      for (const h of hosts) if (h.shadowRoot) walk(h.shadowRoot);
    };
    walk(document);
    return out;
  }

  // ── Media: must be even ────────────────────────────────────────────────
  // NB: <picture> is excluded — it is a non-rendering wrapper whose child
  // <img> (checked here) is what actually paints. <picture> never carries the
  // counter-invert filter (only its <img> does), so measuring the wrapper
  // reports a phantom odd parity. Same for <source>.
  for (const el of queryDeep('img,video,canvas,svg image')) {
    if (!visible(el)) continue;
    out.mediaTotal++;
    const n = invCount(el, true);
    if (n % 2 === 1) {
      out.mediaWrong++;
      if (out.mediaSamples.length < 6) out.mediaSamples.push({
        tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 24),
        inverts: n, src: (el.currentSrc || el.src || '').slice(-44),
      });
    }
  }

  // ── Large url() background photos: must be even ─────────────────────────
  let scanned = 0;
  for (const el of queryDeep('*')) {
    if (scanned++ > 6000) break;
    let cs; try { cs = getComputedStyle(el); } catch (_) { continue; }
    if (!/url\(/i.test(cs.backgroundImage)) continue;
    if (!visible(el)) continue;
    out.bgPhotoTotal++;
    const n = invCount(el, true);
    if (n % 2 === 1) {
      out.bgPhotoWrong++;
      if (out.bgSamples.length < 6) out.bgSamples.push({
        tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 24),
        inverts: n, tagged: el.getAttribute('data-darkabsolut-bg'),
        repeat: cs.backgroundRepeat, size: cs.backgroundSize,
        img: cs.backgroundImage.slice(0, 40),
      });
    }
  }

  // ── Text readability: text parity must match its visible background ─────
  // Walk a sample of text-bearing elements; compare the element's inversion
  // count to that of its nearest opaque-background ancestor. A parity mismatch
  // means text and background were inverted a different number of times, so the
  // designed contrast is broken (text can become near-invisible).
  function nearestOpaqueBg(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      let cs; try { cs = getComputedStyle(cur); } catch (_) { return null; }
      const c = rgb(cs.backgroundColor);
      if (c && c.a > 0.5) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  const textEls = [];
  for (const el of document.querySelectorAll('p,span,a,li,h1,h2,h3,h4,td,th,label,button,div')) {
    if (textEls.length > 400) break;
    // direct text content only, reasonably sized, on screen
    const t = el.childNodes;
    let hasText = false;
    for (const n of t) if (n.nodeType === 3 && /\S/.test(n.nodeValue)) { hasText = true; break; }
    if (!hasText) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 8 || r.top > innerHeight || r.bottom < 0) continue;
    textEls.push(el);
  }
  for (const el of textEls) {
    const bgEl = nearestOpaqueBg(el);
    if (!bgEl) continue;
    out.textChecked++;
    const nText = invCount(el, true);
    const nBg = invCount(bgEl, true);
    if ((nText % 2) !== (nBg % 2)) {
      out.textWrong++;
      if (out.textSamples.length < 6) out.textSamples.push({
        tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 20),
        text: (el.textContent || '').trim().slice(0, 24), nText, nBg,
      });
    }
  }
  return out;
}

async function audit(context, name, url) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  page.setDefaultNavigationTimeout(45000);
  let navErr = null;
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
  catch (e) { navErr = e.message; }
  await page.waitForTimeout(3500);
  // trigger lazy images
  try {
    await page.evaluate(() => window.scrollTo(0, 1400));
    await page.waitForTimeout(1800);
    await page.evaluate(() => window.scrollTo(0, 2800));
    await page.waitForTimeout(1800);
  } catch (_) {}
  let info = null;
  try { info = await page.evaluate(probe); } catch (e) { navErr = navErr || e.message; }
  try { await page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: 12000 }); } catch (_) {}
  // detect bot/block pages so we don't report misleading zeros
  let blocked = false;
  try {
    blocked = await page.evaluate(() => /verify you are human|just a moment|access (is )?(temporarily )?(restricted|denied)|unusual activity|are you a robot|captcha/i
      .test((document.body && document.body.innerText || '').slice(0, 500)));
  } catch (_) {}
  await page.close();
  return { info, navErr, blocked };
}

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true,
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }

    const report = {};
    let anyWrong = false;
    for (const [name, url] of SITES) {
      process.stdout.write(`· ${name.padEnd(14)} `);
      const { info, navErr, blocked } = await audit(context, name, url);
      if (blocked || !info) {
        console.log(blocked ? 'BLOCKED (bot wall)' : `ERROR ${navErr || ''}`);
        report[name] = { blocked: !!blocked, navErr };
        continue;
      }
      report[name] = info;
      const flag = (info.mediaWrong || info.bgPhotoWrong) ? '  ✗ INVERTED IMAGES' : '';
      if (info.mediaWrong || info.bgPhotoWrong) anyWrong = true;
      console.log(
        `root=${info.root} media ${info.mediaWrong}/${info.mediaTotal} wrong` +
        ` · bgPhoto ${info.bgPhotoWrong}/${info.bgPhotoTotal} wrong` +
        ` · text ${info.textWrong}/${info.textChecked} parity-mismatch` + flag
      );
      for (const s of info.mediaSamples) console.log(`      img: ${s.tag}.${s.cls} inverts=${s.inverts} ${s.src}`);
      for (const s of info.bgSamples) console.log(`      bg : ${s.tag}.${s.cls} inverts=${s.inverts} tagged=${s.tagged} ${s.repeat}/${s.size}`);
    }
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\nreport ->', path.join(OUT, 'report.json'));
    console.log(anyWrong ? '\nFound inverted images on at least one site.' : '\nNo inverted images detected.');
  } finally {
    await context.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
