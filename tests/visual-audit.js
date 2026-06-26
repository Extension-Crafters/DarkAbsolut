// Visual regression audit for DarkAbsolut.
//
// Loads the real unpacked extension (headless) and, for each target page,
// screenshots the result and measures it from the actual rendered pixels:
//   • overallLum   — mean luminance of the viewport (lower = darker)
//   • brightFrac   — fraction of pixels brighter than 0.6 (lower = better)
//   • topBandLum   — mean luminance of the top 12% strip (the header)
//   • brightBand   — brightest contiguous horizontal band (y, height, lum)
//
// A good dark result has low overallLum, low brightFrac, and no bright band
// in the header strip. Results are written to tests/screenshots/audit/ and a
// JSON report; with --baseline it diffs against a saved baseline to flag
// regressions.
//
//   node tests/visual-audit.js                # fixtures only (fast, offline)
//   node tests/visual-audit.js --live         # fixtures + curated live sites
//   node tests/visual-audit.js --save-baseline
//   node tests/visual-audit.js --baseline
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');
const http = require('http');
const { decodePng, pixelLum } = require('./lib/png');
const { PAGES, EXPECT } = require('./fixtures');

const EXT_PATH  = path.resolve(__dirname, '..');
const OUT_DIR   = path.join(__dirname, 'screenshots', 'audit');
const REPORT    = path.join(OUT_DIR, 'report.json');
const BASELINE  = path.join(__dirname, 'audit-baseline.json');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-audit-'));
fs.mkdirSync(OUT_DIR, { recursive: true });

const LIVE = process.argv.includes('--live');
const SAVE_BASELINE = process.argv.includes('--save-baseline');
const USE_BASELINE  = process.argv.includes('--baseline');

// Curated sample of widely-used, light-themed sites where inversion is active
// (already-dark or login-walled top sites are exercised by the "stays dark /
// not inverted" checks elsewhere). Kept modest so the run stays tractable.
const LIVE_SITES = [
  ['wikipedia',    'https://en.wikipedia.org/wiki/Color'],
  ['mdn',          'https://developer.mozilla.org/en-US/docs/Web/CSS/filter'],
  ['stackoverflow','https://stackoverflow.com/questions/11227809'],
  ['github',       'https://github.com/torvalds/linux'],
  ['w3schools',    'https://www.w3schools.com/css/css_intro.asp'],
  ['amazon',       'https://www.amazon.com/'],
  ['ebay',         'https://www.ebay.com/'],
  ['imdb',         'https://www.imdb.com/'],
  ['bbc',          'https://www.bbc.com/news'],
  ['cnn',          'https://www.cnn.com/'],
  ['nytimes',      'https://www.nytimes.com/'],
  ['weather',      'https://weather.com/'],
  ['espn',         'https://www.espn.com/'],
  ['apple',        'https://www.apple.com/'],
  ['microsoft',    'https://www.microsoft.com/en-us/'],
  ['paypal',       'https://www.paypal.com/us/home'],
  ['gmaps',        'https://www.google.com/maps/@48.8584,2.2945,14z'],
  // Broader top-sites coverage (light-themed / content sites where the
  // inversion is active; already-dark or login-walled top sites are covered
  // by the "stays dark / not inverted" behavior instead).
  ['google',       'https://www.google.com/search?q=css'],
  ['bing',         'https://www.bing.com/search?q=css'],
  ['yahoo',        'https://www.yahoo.com/'],
  ['reddit',       'https://old.reddit.com/'],
  ['quora',        'https://www.quora.com/'],
  ['medium',       'https://medium.com/'],
  ['geeksforgeeks','https://www.geeksforgeeks.org/'],
  ['craigslist',   'https://craigslist.org/'],
  ['wikihow',      'https://www.wikihow.com/Main-Page'],
  ['indeed',       'https://www.indeed.com/'],
  ['yelp',         'https://www.yelp.com/'],
  ['npm',          'https://www.npmjs.com/package/react'],
  ['govuk',        'https://www.gov.uk/'],
  ['cdc',          'https://www.cdc.gov/'],
  ['tripadvisor',  'https://www.tripadvisor.com/'],
  ['walmart',      'https://www.walmart.com/'],
  ['target',       'https://www.target.com/'],
  ['etsy',         'https://www.etsy.com/'],
  ['cloudflare',   'https://www.cloudflare.com/'],
  ['mozilla',      'https://www.mozilla.org/en-US/'],
];

const VIEWPORT = { width: 1280, height: 900 };

// ── Pixel metrics ────────────────────────────────────────────────────────
function analyze(buf) {
  const { width, height, channels, data } = decodePng(buf);
  const colStep = Math.max(1, Math.floor(width / 240)); // subsample columns
  const rowLum = new Float64Array(height);
  let total = 0, bright = 0, sum = 0;
  for (let y = 0; y < height; y++) {
    let rs = 0, rn = 0;
    const base = y * width * channels;
    for (let x = 0; x < width; x += colStep) {
      const l = pixelLum(data, base + x * channels, channels);
      rs += l; rn++;
      sum += l; total++;
      if (l > 0.6) bright++;
    }
    rowLum[y] = rs / rn;
  }
  const overallLum = +(sum / total).toFixed(4);
  const brightFrac = +(bright / total).toFixed(4);

  // Page baseline = median row luminance.
  const sorted = Array.from(rowLum).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const bandThresh = Math.max(0.5, median + 0.28);

  // Brightest contiguous band (>= 8px tall).
  let best = null, runStart = -1;
  for (let y = 0; y <= height; y++) {
    const isBright = y < height && rowLum[y] > bandThresh;
    if (isBright && runStart < 0) runStart = y;
    if (!isBright && runStart >= 0) {
      const h = y - runStart;
      if (h >= 8) {
        let s = 0; for (let i = runStart; i < y; i++) s += rowLum[i];
        const avg = s / h;
        const score = h * avg;
        if (!best || score > best.score) best = { y: runStart, h, lum: +avg.toFixed(3), score };
      }
      runStart = -1;
    }
  }
  if (best) delete best.score;

  // Top header strip (top 12%).
  const topRows = Math.max(1, Math.floor(height * 0.12));
  let ts = 0; for (let y = 0; y < topRows; y++) ts += rowLum[y];
  const topBandLum = +(ts / topRows).toFixed(3);

  return { width, height, overallLum, brightFrac, topBandLum, brightBand: best };
}

// ── Page driver ────────────────────────────────────────────────────────────
async function shoot(context, url) {
  const page = await context.newPage();
  await page.setViewportSize(VIEWPORT);
  page.setDefaultNavigationTimeout(45000);
  let navErr = null;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  } catch (e) { navErr = e.message; }
  await page.waitForTimeout(3000); // let controller re-checks settle
  let buf;
  try { buf = await page.screenshot(); } catch (e) { navErr = navErr || e.message; }
  const rootAttr = await page.evaluate(
    () => document.documentElement.getAttribute('data-darkabsolut')
  ).catch(() => null);
  await page.close();
  return { buf, rootAttr, navErr };
}

(async () => {
  const server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      const body = PAGES[req.url];
      if (body == null) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true,
    channel: 'chromium', // full Chrome-for-Testing build — headless_shell can't load extensions
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
    ],
  });

  const targets = [];
  for (const route of Object.keys(PAGES)) {
    targets.push({ name: 'fx' + route.replace(/\//g, '_'), url: base + route, kind: 'fixture', route });
  }
  if (LIVE) for (const [name, url] of LIVE_SITES) targets.push({ name, url, kind: 'live' });

  const report = {};
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }

    for (const t of targets) {
      process.stdout.write(`· ${t.name} … `);
      let metrics = null, rootAttr = null, navErr = null;
      try {
        const r = await shoot(context, t.url);
        rootAttr = r.rootAttr; navErr = r.navErr;
        if (r.buf) {
          fs.writeFileSync(path.join(OUT_DIR, `${t.name}.png`), r.buf);
          metrics = analyze(r.buf);
        }
      } catch (e) { navErr = (navErr ? navErr + '; ' : '') + e.message; }
      const entry = { kind: t.kind, url: t.url, rootAttr, navErr, ...(metrics || {}) };
      if (t.kind === 'fixture') {
        const exp = EXPECT[t.route];
        Object.assign(entry, exp);
        if (!metrics) {
          entry.pass = false;
        } else if (exp.wantDarkTop) {
          entry.pass = metrics.topBandLum < 0.4;
        } else if (exp.wantVisibleText) {
          // Dark page, but light text must be present (not counter-inverted to
          // invisible). brightFrac collapses to ~0 when text is reverted dark.
          entry.pass = metrics.overallLum < 0.4 && metrics.brightFrac > 0.01;
        } else {
          entry.pass = true;
        }
      }
      report[t.name] = entry;
      console.log(metrics
        ? `root=${rootAttr} overall=${metrics.overallLum} bright=${metrics.brightFrac} top=${metrics.topBandLum}` +
          (entry.pass === false ? '  ✗ FAIL' : entry.pass === true ? '  ✓' : '') +
          (metrics.brightBand ? `  band@y${metrics.brightBand.y}(h${metrics.brightBand.h},l${metrics.brightBand.lum})` : '')
        : `ERROR ${navErr || 'no screenshot'}`);
    }
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\nreport ->', REPORT);

  if (SAVE_BASELINE) {
    fs.writeFileSync(BASELINE, JSON.stringify(report, null, 2));
    console.log('baseline saved ->', BASELINE);
  }

  // Fixture pass/fail summary.
  const fixtures = Object.entries(report).filter(([, e]) => e.kind === 'fixture');
  const failed = fixtures.filter(([, e]) => e.pass === false);
  console.log(`\nFixtures: ${fixtures.length - failed.length}/${fixtures.length} passed.`);
  for (const [n, e] of failed) console.log(`  ✗ ${n}  topBandLum=${e.topBandLum}`);

  // Baseline regression diff (luminance went UP meaningfully = regression).
  if (USE_BASELINE && fs.existsSync(BASELINE)) {
    const baseRep = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    console.log('\n── Regression vs baseline ──');
    let regressions = 0;
    for (const [name, e] of Object.entries(report)) {
      const b = baseRep[name];
      if (!b || e.overallLum == null || b.overallLum == null) continue;
      const dOverall = +(e.overallLum - b.overallLum).toFixed(3);
      const dBright  = +(e.brightFrac - b.brightFrac).toFixed(3);
      const dTop     = +(e.topBandLum - b.topBandLum).toFixed(3);
      const regressed = dBright > 0.03 || dTop > 0.08 || dOverall > 0.04;
      const improved  = dBright < -0.03 || dTop < -0.08;
      if (regressed || improved) {
        console.log(`  ${regressed ? '▲ REGRESS' : '▼ improve'} ${name}  ` +
          `dOverall=${dOverall} dBright=${dBright} dTop=${dTop}`);
      }
      if (regressed) regressions++;
    }
    console.log(regressions ? `\n${regressions} regression(s).` : '\nNo regressions.');
    if (regressions) process.exitCode = 1;
  }

  if (failed.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });
