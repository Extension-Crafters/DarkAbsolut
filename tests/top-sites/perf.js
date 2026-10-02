// Load-time main-thread cost of the extension: total long-task time and
// blocking time (sum of duration-50ms) from navigation to +12 s, with and
// without the extension (fresh profile each, order alternated per site).
//   node tests/top-sites/perf.js --list pages.json --out perf.json [--sample 60] [--workers 6]
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const EXT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const LIST = arg('--list'), OUT = arg('--out', 'perf.json');
const SAMPLE = +arg('--sample', 60), WORKERS = +arg('--workers', 6);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function measure(url, withExt) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'da-perf-'));
  const args = ['--headless=new', '--no-sandbox', '--mute-audio'];
  if (withExt) args.push(`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`);
  const ctx = await chromium.launchPersistentContext(ud, { headless: true, channel: 'chromium', viewport: { width: 1366, height: 768 }, locale: 'fr-FR', userAgent: UA, args });
  try {
    if (withExt) { let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }); }
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__lt = [];
      try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch (_) {}
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(12000);
    return await page.evaluate(() => {
      const lt = (window.__lt || []).filter(([t]) => t <= 12000 + (performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart));
      const nav = performance.getEntriesByType('navigation')[0] || {};
      return { total: Math.round(lt.reduce((s, [, d]) => s + d, 0)), blocking: Math.round(lt.reduce((s, [, d]) => s + Math.max(0, d - 50), 0)),
        count: lt.length, longest: Math.round(Math.max(0, ...lt.map(([, d]) => d))), dcl: Math.round(nav.domContentLoadedEventEnd || 0),
        nodes: document.getElementsByTagName('*').length, root: document.documentElement.getAttribute('data-darkabsolut') };
    });
  } finally { await ctx.close().catch(() => {}); try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) {} }
}

(async () => {
  const pages = JSON.parse(fs.readFileSync(LIST, 'utf8')).filter(p => p.kind === 'home');
  const step = Math.max(1, Math.floor(pages.length / SAMPLE));
  const sample = pages.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  const results = [];
  let next = 0;
  async function worker() {
    while (next < sample.length) {
      const i = next++, p = sample[i];
      const r = { id: p.id, url: p.url };
      for (const withExt of (i % 2 ? [true, false] : [false, true])) {
        try { r[withExt ? 'ext' : 'noext'] = await measure(p.url, withExt); }
        catch (e) { r[withExt ? 'ext' : 'noext'] = { error: e.message.split('\n')[0].slice(0, 100) }; }
      }
      results.push(r);
      const a = r.noext || {}, b = r.ext || {};
      console.log(`${results.length}/${sample.length} ${p.id} blocking noext=${a.blocking} ext=${b.blocking} nodes=${b.nodes} root=${b.root}`);
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  const ok = results.filter(r => r.ext && r.noext && r.ext.blocking != null && r.noext.blocking != null);
  const med = v => { const s = [...v].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const d = ok.map(r => r.ext.blocking - r.noext.blocking);
  console.log(`\nsites=${ok.length} median blocking noext=${med(ok.map(r => r.noext.blocking))} ext=${med(ok.map(r => r.ext.blocking))} median delta=${med(d)} ` +
    `p75 delta=${[...d].sort((x, y) => x - y)[Math.floor(d.length * 0.75)]} max delta=${Math.max(...d)}`);
})().catch(e => { console.error(e); process.exit(1); });
