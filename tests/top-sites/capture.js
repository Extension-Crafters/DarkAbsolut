// Top-sites field audit — capture stage.
//
// Loads each site with the real unpacked extension (one isolated Chromium +
// extension instance per worker) and records, for later pixel analysis and
// visual review:
//   on-initial   — first settled view (consent banner still up, if any)
//   on-top/mid   — themed page after consent dismissal, top + 1.5 viewports down
//   off-mid/top  — same page load after flipping the MASTER switch off: a
//                  pixel-aligned native baseline, plus a residue check (nothing
//                  of DarkAbsolut may remain in the DOM)
//   reon-top     — master switched back on: must re-theme like the first load
// plus DOM snapshots (extension tags, visible media/text/fixed elements, a
// hit-test grid) and long-task totals with the extension on vs off.
//
//   node tests/top-sites/capture.js --list sites.json --out runs [--workers 10]
//        [--only id1,id2] [--limit N] [--force]
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXT = path.resolve(__dirname, '..', '..');
const VIEWPORT = { width: 1366, height: 768 };

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const LIST = arg('--list');
const OUT = path.resolve(arg('--out', 'runs'));
const WORKERS = +arg('--workers', 8);
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean);
const LIMIT = +arg('--limit', 0);
const FORCE = argv.includes('--force');
const RESTART_EVERY = 25; // fresh browser per N sites (leaks, wedged service workers)

fs.mkdirSync(OUT, { recursive: true });

// ── In-page helpers (serialised into the page) ──────────────────────────────
// Long-task recorder, installed before any site script.
const INIT = `(() => {
  window.__qaLT = [];
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__qaLT.push([e.startTime, e.duration]); })
      .observe({ type: 'longtask', buffered: true });
  } catch (_) {}
})();`;

// DOM snapshot: extension state + what is visible in the viewport.
function snapshotFn() {
  const html = document.documentElement;
  const vw = innerWidth, vh = innerHeight;
  const q = s => { try { return document.querySelectorAll(s).length; } catch (_) { return -1; } };
  const short = (s, n = 120) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const desc = el => {
    if (!el || el.nodeType !== 1) return null;
    let d = el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    if (cls) d += '.' + cls.trim().split(/\s+/).slice(0, 3).join('.');
    return d.slice(0, 120);
  };
  const daTags = el => {
    const t = [];
    for (const a of el.attributes) if (a.name.startsWith('data-darkabsolut')) t.push(a.name.replace('data-darkabsolut', 'da') + (a.value && a.value !== '1' ? '=' + a.value.slice(0, 20) : ''));
    return t;
  };
  const pathOf = el => {
    const parts = [];
    let cur = el, n = 0;
    while (cur && cur.nodeType === 1 && cur !== html && n++ < 8) {
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      let i = 1, s = cur;
      while ((s = s.previousElementSibling)) if (s.tagName === cur.tagName) i++;
      parts.unshift(cur.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      cur = cur.parentElement;
    }
    return parts.join('>');
  };
  const visRect = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return null;
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const filteredAncestor = el => {
    let cur = el.parentElement;
    while (cur && cur !== html) {
      const f = getComputedStyle(cur).filter;
      if (f && f !== 'none') return desc(cur) + ' {' + f.slice(0, 40) + '}';
      cur = cur.parentElement;
    }
    return null;
  };

  const ext = {
    root: html.getAttribute('data-darkabsolut'),
    hc: html.getAttribute('data-darkabsolut-hc'),
    noimg: html.getAttribute('data-darkabsolut-noimg'),
    style: !!document.getElementById('darkabsolut-style'),
    filterDefs: !!document.getElementById('darkabsolut-filters'),
    htmlFilter: getComputedStyle(html).filter,
    tags: {
      bg: q('[data-darkabsolut-bg]'), darknative: q('[data-darkabsolut-darknative]'),
      lightnative: q('[data-darkabsolut-lightnative]'), bgicon: q('[data-darkabsolut-bgicon]'),
      lighticon: q('[data-darkabsolut-lighticon]'), accent: q('[data-darkabsolut-accent]'),
      invertmedia: q('[data-darkabsolut-invertmedia]'), rtext: q('[data-darkabsolut-rtext]'),
      zlift: q('[data-darkabsolut-zlift]'), bgOrig: q('[data-darkabsolut-bg-orig]'),
      colorOrig: q('[data-darkabsolut-color-orig]'),
    },
  };
  const bcs = document.body ? getComputedStyle(document.body) : null;
  const hcs = getComputedStyle(html);
  const meta = document.querySelector('meta[name="color-scheme"]');
  const pageInfo = {
    title: short(document.title, 160), url: location.href, readyState: document.readyState,
    lang: html.lang || null,
    metaColorScheme: meta ? meta.content : null, htmlColorScheme: hcs.colorScheme,
    htmlBg: hcs.backgroundColor, bodyBg: bcs && bcs.backgroundColor, bodyColor: bcs && bcs.color,
    htmlClass: short(typeof html.className === 'string' ? html.className : '', 160),
    htmlDataTheme: html.getAttribute('data-theme') || html.getAttribute('data-color-mode') || html.getAttribute('data-bs-theme') || null,
    bodyClass: short(document.body && typeof document.body.className === 'string' ? document.body.className : '', 160),
    scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight,
    nodeCount: document.getElementsByTagName('*').length,
    iframeCount: document.getElementsByTagName('iframe').length,
    shadowHosts: 0,
    textLen: (document.body && document.body.innerText || '').length,
    textHead: short(document.body && document.body.innerText, 600),
  };

  const media = [], texts = [], fixed = [], iframes = [];
  const all = document.getElementsByTagName('*');
  let n = 0;
  for (const el of all) {
    if (++n > 25000) break;
    if (el.shadowRoot) pageInfo.shadowHosts++;
    const tag = el.tagName.toLowerCase();
    let cs;
    try { cs = getComputedStyle(el); } catch (_) { continue; }
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    // Fixed / sticky elements (position + whether a filtered ancestor captures them).
    if (cs.position === 'fixed' || cs.position === 'sticky') {
      const r = visRect(el);
      if (r && r.w * r.h >= 2000 && fixed.length < 40) {
        fixed.push({ path: pathOf(el), desc: desc(el), pos: cs.position, rect: r, z: cs.zIndex, filteredAncestor: filteredAncestor(el), da: daTags(el) });
      }
    }
    const isMedia = tag === 'img' || tag === 'video' || tag === 'canvas' || tag === 'svg' || tag === 'picture' || tag === 'iframe' || tag === 'embed' || tag === 'object';
    const bgi = cs.backgroundImage;
    const hasBgUrl = bgi && bgi !== 'none' && /url\(/i.test(bgi);
    const hasGrad = bgi && /gradient\(/i.test(bgi);
    if (isMedia || hasBgUrl || hasGrad) {
      const r = visRect(el);
      if (r && r.w >= 16 && r.h >= 16 && media.length < 220) {
        const m = { tag, path: pathOf(el), desc: desc(el), rect: r, filter: cs.filter, da: daTags(el), kind: tag };
        if (hasBgUrl && !isMedia) { m.kind = 'bgimg'; m.bg = short(bgi, 160); }
        else if (hasGrad && !isMedia) { m.kind = 'gradient'; m.bg = short(bgi, 160); }
        if (tag === 'img') { m.src = short(el.currentSrc || el.src, 160); m.nat = [el.naturalWidth, el.naturalHeight]; m.alt = short(el.alt, 60); }
        if (tag === 'iframe') {
          m.src = short(el.src, 160);
          let same = false; try { same = !!el.contentDocument; } catch (_) {}
          m.sameOrigin = same;
          iframes.push({ src: m.src, rect: r, sameOrigin: same, da: m.da });
        }
        if (tag === 'svg') { m.fill = cs.fill; m.color = cs.color; }
        media.push(m);
      }
    }
    // Text-bearing elements (direct text node children).
    if (texts.length < 400 && tag !== 'script' && tag !== 'style' && tag !== 'noscript') {
      let direct = '';
      for (const c of el.childNodes) if (c.nodeType === 3) direct += c.nodeValue;
      direct = direct.replace(/\s+/g, ' ').trim();
      const isField = (tag === 'input' && /^(text|search|email|url|tel|password|number|)$/i.test(el.type || '')) || tag === 'textarea';
      if (direct.length >= 2 || isField) {
        const r = visRect(el);
        if (r && r.h >= 8 && r.h <= 260 && r.w >= 10 && r.x >= 0 && r.y >= 0 && r.x + r.w <= vw && r.y + r.h <= vh) {
          texts.push({ path: pathOf(el), desc: desc(el), rect: r, text: isField ? short(el.value || el.placeholder, 50) : short(direct, 50),
            field: isField, fs: parseFloat(cs.fontSize), fw: cs.fontWeight, color: cs.color, bg: cs.backgroundColor, filter: cs.filter, da: daTags(el) });
        }
      }
    }
  }
  // Hit-test grid: what is actually painted at each point (topmost element).
  const grid = [];
  const GX = 24, GY = 14;
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    const x = Math.round((i + 0.5) * vw / GX), y = Math.round((j + 0.5) * vh / GY);
    const el = document.elementFromPoint(x, y);
    if (!el) { grid.push({ x, y, el: null }); continue; }
    const cs = getComputedStyle(el);
    const chain = [];
    let cur = el.parentElement, k = 0;
    while (cur && cur !== html && k++ < 12) {
      const t = daTags(cur); const f = getComputedStyle(cur).filter;
      if (t.length || (f && f !== 'none')) chain.push(desc(cur) + (t.length ? ' [' + t.join(',') + ']' : '') + (f && f !== 'none' ? ' {' + f.slice(0, 30) + '}' : ''));
      cur = cur.parentElement;
    }
    grid.push({ x, y, el: desc(el), bg: cs.backgroundColor, color: cs.color, filter: cs.filter, da: daTags(el), chain });
  }
  return { ext, page: pageInfo, media, texts, fixed, iframes, grid };
}

// Everything DarkAbsolut could have left behind after a hard disable.
function residueFn() {
  const out = { attrs: {}, style: !!document.getElementById('darkabsolut-style'), defs: !!document.getElementById('darkabsolut-filters'), shadowSheets: 0, examples: [] };
  const walk = root => {
    for (const el of root.querySelectorAll('*')) {
      for (const a of el.attributes) {
        if (a.name.startsWith('data-darkabsolut')) {
          out.attrs[a.name] = (out.attrs[a.name] || 0) + 1;
          if (out.examples.length < 8) out.examples.push(el.tagName.toLowerCase() + '[' + a.name + '="' + a.value.slice(0, 30) + '"] style="' + (el.getAttribute('style') || '').slice(0, 80) + '"');
        }
      }
      if (el.shadowRoot) {
        const sr = el.shadowRoot;
        try { if (sr.getElementById('darkabsolut-style')) out.shadowSheets++; } catch (_) {}
        try { for (const s of sr.adoptedStyleSheets || []) { const t = [...s.cssRules].map(r => r.cssText).join(''); if (t.includes('data-darkabsolut')) out.shadowSheets++; } } catch (_) {}
        walk(sr);
      }
    }
  };
  walk(document);
  return out;
}

// Consent banners: prefer reject / necessary-only, else accept. Marks the
// chosen element so Playwright can deliver a trusted click.
function findConsentFn() {
  const norm = s => (s || '').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const REJECT = [/^tout refuser$/, /^refuser tout$/, /^tout rejeter$/, /^rejeter tout$/, /^refuser$/, /^je refuse$/, /^refuser et fermer$/,
    /^continuer sans accepter/, /^reject all( cookies)?$/, /^reject( cookies)?$/, /^decline( all)?$/, /^deny( all)?$/, /^refuse( all)?$/,
    /^continue without accepting/, /^alle ablehnen$/, /^ablehnen$/, /^rechazar( todo| todas)?$/, /^rifiuta( tutto)?$/, /^rejeitar( tudo)?$/,
    /^recusar( tudo)?$/, /^odrzuć( wszystkie)?$/, /^tümünü reddet$/, /^reddet$/, /^отклонить( все)?$/, /^weiger(en)?$/,
    /^(use |allow )?(only )?(strictly )?(necessary|essential)( cookies)?( only)?$/, /^uniquement (les cookies )?(n[ée]cessaires|essentiels)/,
    /^refuser les cookies( optionnels| non essentiels)?$/, /^decline optional cookies$/, /^only allow essential cookies$/,
    /^ne pas accepter$/, /^non merci$/, /^no,? thanks$/];
  const ACCEPT = [/^tout accepter$/, /^accepter tout$/, /^accepter( et (fermer|continuer))?$/, /^j'accepte$/, /^accept all( cookies)?$/, /^accept( cookies)?$/,
    /^i accept$/, /^(i )?agree( and (close|continue))?$/, /^allow all( cookies)?$/, /^allow( cookies)?$/, /^got it!?$/, /^ok(ay)?!?$/,
    /^alle akzeptieren$/, /^akzeptieren$/, /^aceptar( todo| todas| cookies)?$/, /^accetta( tutto| tutti)?$/, /^aceitar( tudo| todos)?$/,
    /^zaakceptuj( wszystkie)?$/, /^kabul et$/, /^tümünü kabul et$/, /^принять( все)?$/, /^同意(する)?$/, /^모두 동의$/, /^동의$/,
    /^allow essential and optional cookies$/, /^consent$/, /^understood$/, /^compris$/, /^d'accord$/, /^continuer$/];
  const BANNER = /(cookie|consent|gdpr|cmp|privacy|onetrust|didomi|qc-cmp|sp_message|usercentrics|truste|cookiebot|evidon|osano|klaro|tarteaucitron|axeptio|cmpbox|fc-consent|cc-window|cc_banner)/i;
  const cands = [];
  const visit = (root, depth) => {
    if (depth > 6) return;
    const els = root.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"], span[tabindex], div[tabindex]');
    for (const el of els) {
      const txt = norm(el.innerText || el.value || el.getAttribute('aria-label') || '');
      if (!txt || txt.length > 60) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > innerHeight + 2 || r.right < 0 || r.left > innerWidth) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      let inBanner = false, cur = el, k = 0;
      while (cur && k++ < 14) {
        const idc = (cur.id || '') + ' ' + (typeof cur.className === 'string' ? cur.className : '') + ' ' + (cur.getAttribute && (cur.getAttribute('aria-label') || '') || '');
        if (BANNER.test(idc)) { inBanner = true; break; }
        cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
      }
      const rej = REJECT.some(re => re.test(txt));
      const acc = ACCEPT.some(re => re.test(txt));
      if (!rej && !acc) continue;
      // Loose accept words ("ok", "continuer", "compris") only inside a banner.
      if (acc && !rej && !inBanner && /^(ok(ay)?!?|continuer|compris|understood|d'accord|got it!?|allow( cookies)?|accept( cookies)?)$/.test(txt)) continue;
      cands.push({ el, txt, score: (rej ? 100 : 0) + (inBanner ? 20 : 0) });
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
  };
  visit(document, 0);
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  best.el.setAttribute('data-qa-consent', '1');
  return { text: best.txt, kind: best.score >= 100 ? 'reject' : 'accept', count: cands.length };
}

function blockedFn() {
  const t = (document.title + ' ' + (document.body ? document.body.innerText.slice(0, 2000) : '')).toLowerCase();
  const pats = ['access denied', 'attention required', 'just a moment', 'verify you are human', 'verifying you are human', 'are you a robot',
    'captcha', 'request blocked', '403 forbidden', 'unusual traffic', 'pardon our interruption', 'robot check', 'security check',
    'vérifiez que vous êtes', 'vérification de sécurité', 'checking your browser', 'please enable js and disable any ad blocker',
    'bot detection', 'not available in your country', "n'est pas disponible dans votre pays", 'unavailable for legal reasons', 'error 1020', 'ray id'];
  const hit = pats.filter(p => t.includes(p));
  return { hit, textLen: document.body ? document.body.innerText.length : 0 };
}

// ── Worker ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
let UA = null;

async function launch(idx) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `da-top-${idx}-`));
  const context = await chromium.launchPersistentContext(userData, {
    headless: true, channel: 'chromium', viewport: VIEWPORT, deviceScaleFactor: 1,
    locale: 'fr-FR', timezoneId: 'Europe/Paris', colorScheme: 'light',
    userAgent: UA || undefined, acceptDownloads: false, ignoreHTTPSErrors: true,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox',
      '--mute-audio', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const ctl = await context.newPage();
  await ctl.goto(`chrome-extension://${extId}/popup/io.html`, { waitUntil: 'load' });
  const send = msg => ctl.evaluate(m => new Promise(r => chrome.runtime.sendMessage(m, r)), msg);
  const keep = new Set([ctl]);
  const env = { context, ctl, send, keep, userData, expectPage: false };
  // Close site-opened popups/popunders; our own newPage() is announced first.
  context.on('page', p => {
    if (env.expectPage) { env.expectPage = false; keep.add(p); return; }
    setTimeout(() => { if (!keep.has(p)) p.close().catch(() => {}); }, 50);
  });
  return env;
}

async function shot(page, file) {
  try { await page.screenshot({ path: file, type: 'jpeg', quality: 82, timeout: 20000, animations: 'allow' }); return path.basename(file); }
  catch (e) { return null; }
}

async function longTasks(page, ms) {
  const start = await page.evaluate(() => performance.now()).catch(() => null);
  await sleep(ms);
  if (start == null) return null;
  return page.evaluate(s => {
    let total = 0, blocking = 0, count = 0;
    for (const [t, d] of window.__qaLT || []) if (t >= s) { total += d; blocking += Math.max(0, d - 50); count++; }
    return { count, total: Math.round(total), blocking: Math.round(blocking) };
  }, start).catch(() => null);
}

// DarkAbsolut's state inside every visible subframe (double/no inversion of
// embeds, ads, nested frames).
async function frameStates(page) {
  const out = [];
  const timeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('timeout'); })]);
  const deadline = Date.now() + 12000; // ad-heavy pages have dozens of slow OOPIFs
  for (const fr of page.frames()) {
    if (fr === page.mainFrame() || out.length >= 30) continue;
    if (Date.now() > deadline) { out.push({ truncated: true }); break; }
    let box = null;
    try { const fe = await timeout(fr.frameElement(), 2000); box = await timeout(fe.boundingBox(), 2000); } catch (_) {}
    if (process.env.QA_DEBUG) console.log('frame', fr.url().slice(0, 80), JSON.stringify(box));
    if (!box || box.width * box.height < 2000 || box.y > VIEWPORT.height * 2.5 || box.y + box.height < 0) continue;
    let depth = 0; for (let f = fr.parentFrame(); f && f !== page.mainFrame(); f = f.parentFrame()) depth++;
    let info;
    try {
      info = await timeout(fr.evaluate(() => ({
        root: document.documentElement.getAttribute('data-darkabsolut'),
        style: !!document.getElementById('darkabsolut-style'),
        tags: document.querySelectorAll('[data-darkabsolut-bg],[data-darkabsolut-darknative],[data-darkabsolut-lightnative]').length,
        bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : null,
        imgs: document.images.length,
      })), 3000);
    } catch (e) { info = { error: e.message.split('\n')[0].slice(0, 80) }; }
    out.push({ url: fr.url().slice(0, 140), depth, box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }, ...info });
  }
  return out;
}

async function evalSafe(page, fn, arg) {
  try { return await page.evaluate(fn, arg); } catch (e) { return { error: e.message.split('\n')[0] }; }
}

async function testSite(env, site) {
  const dir = path.join(OUT, site.id);
  fs.mkdirSync(dir, { recursive: true });
  const R = { id: site.id, url: site.url, started: new Date().toISOString(), shots: {}, steps: [] };
  const tS = Date.now();
  const step = name => { R.steps.push([name, Date.now() - tS]); if (process.env.QA_DEBUG) console.log(`  ${site.id} @${Date.now() - tS}ms ${name}`); };
  env.expectPage = true;
  const page = await env.context.newPage();
  env.expectPage = false;
  env.keep.add(page);
  page.on('dialog', d => d.dismiss().catch(() => {}));
  const consoleErrors = [];
  page.on('pageerror', e => { if (consoleErrors.length < 10) consoleErrors.push(String(e.message).slice(0, 200)); });
  await page.addInitScript(INIT);
  const t0 = Date.now();
  try {
    await env.send({ type: 'SET_GLOBAL_ENABLED', value: true });
    try {
      const resp = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      R.status = resp ? resp.status() : null;
    } catch (e) { R.navError = e.message.split('\n')[0]; }
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await sleep(6500);
    R.finalUrl = page.url();
    R.loadMs = Date.now() - t0;
    step('settled');
    R.shots.onInitial = await shot(page, path.join(dir, 'on-initial.jpg'));
    step('shot on-initial');
    R.blocked = await evalSafe(page, blockedFn);
    step('blocked check');

    // Consent: main frame first, then child frames (CMP iframes).
    R.consent = null;
    const consentDeadline = Date.now() + 15000; // a stalled ad frame must not wedge the run
    const within = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);
    for (const fr of [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())]) {
      if (Date.now() > consentDeadline) break;
      let found = null;
      try { found = await within(fr.evaluate(findConsentFn), 3000); } catch (_) {}
      if (found) {
        try { await fr.click('[data-qa-consent="1"]', { timeout: 4000 }); found.clicked = true; }
        catch (e) { try { await fr.evaluate(() => { const el = document.querySelector('[data-qa-consent="1"]'); if (el) el.click(); }); found.clicked = 'js'; } catch (_) { found.clicked = false; } }
        try { await fr.evaluate(() => { const el = document.querySelector('[data-qa-consent="1"]'); if (el) el.removeAttribute('data-qa-consent'); }); } catch (_) {}
        found.frame = fr === page.mainFrame() ? 'main' : fr.url().slice(0, 120);
        R.consent = found;
        break;
      }
    }
    step('consent search');
    if (R.consent && R.consent.clicked) {
      await page.waitForLoadState('load', { timeout: 12000 }).catch(() => {});
      await sleep(4000);
      R.finalUrl = page.url();
    }

    await evalSafe(page, () => window.scrollTo(0, 0));
    await sleep(900);
    step('pre-snapshot');
    R.onTop = await evalSafe(page, snapshotFn);
    step('snapshot on-top');
    R.shots.onTop = await shot(page, path.join(dir, 'on-top.jpg'));
    step('shot on-top');
    R.frames = await frameStates(page);
    step('frames');
    R.ltOn = await longTasks(page, 4000);

    await evalSafe(page, () => window.scrollTo(0, Math.round(innerHeight * 1.5)));
    await sleep(2800);
    R.onMid = await evalSafe(page, snapshotFn);
    step('snapshot on-mid');
    R.shots.onMid = await shot(page, path.join(dir, 'on-mid.jpg'));

    // Master OFF → pixel-aligned native baseline + residue check.
    step('shot on-mid');
    await env.send({ type: 'SET_GLOBAL_ENABLED', value: false });
    step('master off');
    await sleep(2200);
    R.offMid = await evalSafe(page, snapshotFn);
    R.shots.offMid = await shot(page, path.join(dir, 'off-mid.jpg'));
    await evalSafe(page, () => window.scrollTo(0, 0));
    await sleep(1500);
    R.offTop = await evalSafe(page, snapshotFn);
    R.shots.offTop = await shot(page, path.join(dir, 'off-top.jpg'));
    R.residue = await evalSafe(page, residueFn);
    step('residue');
    R.ltOff = await longTasks(page, 4000);

    // Master back ON → must re-theme like the first load.
    await env.send({ type: 'SET_GLOBAL_ENABLED', value: true });
    step('master on');
    await sleep(3800);
    R.reOn = await evalSafe(page, () => ({
      root: document.documentElement.getAttribute('data-darkabsolut'),
      style: !!document.getElementById('darkabsolut-style'),
      scrollY: Math.round(scrollY),
    }));
    R.shots.reonTop = await shot(page, path.join(dir, 'reon-top.jpg'));
  } catch (e) {
    R.fatal = e.message.split('\n')[0];
  } finally {
    R.pageErrors = consoleErrors;
    R.totalMs = Date.now() - t0;
    env.keep.delete(page);
    await page.close().catch(() => {});
  }
  fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify(R));
  return R;
}

(async () => {
  const sites = JSON.parse(fs.readFileSync(LIST, 'utf8'))
    .filter(s => !ONLY.length || ONLY.includes(s.id))
    .filter(s => FORCE || !fs.existsSync(path.join(OUT, s.id, 'capture.json')));
  const todo = LIMIT ? sites.slice(0, LIMIT) : sites;
  console.log(`capture: ${todo.length} pages, ${WORKERS} workers → ${OUT}`);

  // Real desktop UA for this Chromium build (drop the Headless marker).
  {
    const b = await chromium.launch({ headless: true, channel: 'chromium', args: ['--headless=new'] });
    const p = await b.newPage();
    UA = (await p.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
    await b.close();
  }

  let next = 0, done = 0;
  const t0 = Date.now();
  async function worker(idx) {
    let env = null, since = 0;
    while (next < todo.length) {
      const site = todo[next++];
      try {
        if (!env || since >= RESTART_EVERY) {
          if (env) { await env.context.close().catch(() => {}); try { fs.rmSync(env.userData, { recursive: true, force: true }); } catch (_) {} }
          env = await launch(idx); since = 0;
        }
        since++;
        const r = await Promise.race([testSite(env, site), sleep(180000).then(() => ({ fatal: 'site timeout' }))]);
        if (r.fatal === 'site timeout') { await env.context.close().catch(() => {}); env = null; }
        done++;
        const el = (Date.now() - t0) / 1000;
        console.log(`[${done}/${todo.length}] w${idx} ${site.id} ${r.status || ''} ${r.navError ? 'NAVERR ' : ''}${r.fatal ? 'FATAL ' + r.fatal : ''} root=${r.onTop && r.onTop.ext ? r.onTop.ext.root : '?'} ${Math.round((r.totalMs || 0) / 1000)}s  (eta ${Math.round(el / done * (todo.length - done) / 60)}m)`);
      } catch (e) {
        done++;
        console.log(`[${done}/${todo.length}] w${idx} ${site.id} WORKER ERROR ${e.message.split('\n')[0]}`);
        if (env) { await env.context.close().catch(() => {}); env = null; }
      }
    }
    if (env) { await env.context.close().catch(() => {}); try { fs.rmSync(env.userData, { recursive: true, force: true }); } catch (_) {} }
  }
  await Promise.all(Array.from({ length: Math.min(WORKERS, todo.length) }, (_, i) => worker(i)));
  console.log(`capture done in ${Math.round((Date.now() - t0) / 60000)} min`);
})().catch(e => { console.error(e); process.exit(1); });
