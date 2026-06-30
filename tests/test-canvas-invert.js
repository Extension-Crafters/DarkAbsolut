// Regression test for luminance-driven canvas handling (the Google Maps case).
// A large LIGHT canvas the user navigates (a light map surface) should be
// darkened WITH the theme — tagged so its default counter-invert is dropped
// (filter:none) and the page-level invert darkens it. A large DARK canvas (a
// native dark map / dark game frame) must keep its counter-invert so it stays
// true-colour. A small canvas (a chart/sprite) is never touched.
//
//   node tests/test-canvas-invert.js
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-canvasinv-'));

// Light app (white body) with three canvases painted via 2D context on load:
//   #light — large, filled a light grey (a light map) → should invert w/ theme
//   #dark  — large, filled near-black (a dark map)     → should KEEP true colours
//   #chart — small, filled light                       → too small, left alone
const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>canvas</title>
<style>
  html,body{margin:0;background:#fff;color:#111}
  canvas{display:block;width:100%}
  #light{height:340px}
  #dark{height:340px}
  #chart{width:120px;height:80px}
</style></head>
<body>
  <canvas id="light" width="1000" height="340"></canvas>
  <canvas id="dark" width="1000" height="340"></canvas>
  <canvas id="chart" width="120" height="80"></canvas>
  <script>
    function paint(id, fill){
      const c = document.getElementById(id);
      const x = c.getContext('2d');
      x.fillStyle = fill; x.fillRect(0,0,c.width,c.height);
      // a few darker strokes so it isn't a perfectly flat fill (map-like)
      x.strokeStyle = id==='dark' ? '#333' : '#888';
      for(let i=0;i<c.width;i+=60){ x.beginPath(); x.moveTo(i,0); x.lineTo(i,c.height); x.stroke(); }
    }
    paint('light', '#cfd4d8'); // light map grey
    paint('dark',  '#101314'); // dark map
    paint('chart', '#e8eef4'); // light, but small
  </script>
</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
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
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: true, channel: 'chromium', colorScheme: 'light',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }
    const page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(base, { waitUntil: 'load' });

    // Give the post-load element passes (700/1800ms) time to sample canvases.
    await page.waitForTimeout(2200);

    const st = await page.evaluate(() => {
      const get = id => {
        const el = document.getElementById(id);
        return { tag: el.getAttribute('data-darkabsolut-invertmedia'),
                 filter: getComputedStyle(el).filter };
      };
      return { root: document.documentElement.getAttribute('data-darkabsolut'),
               light: get('light'), dark: get('dark'), chart: get('chart') };
    });

    assert('page inverted (light app)', st.root === 'on', `root=${st.root}`);
    assert('LIGHT canvas tagged invert-with-theme', st.light.tag === '1', JSON.stringify(st.light));
    assert('LIGHT canvas drops counter-invert (filter:none)',
           st.light.filter === 'none', `filter=${st.light.filter}`);
    assert('DARK canvas NOT tagged', !st.dark.tag, JSON.stringify(st.dark));
    assert('DARK canvas keeps counter-invert (true colours)',
           /invert\(1\)/.test(st.dark.filter), `filter=${st.dark.filter}`);
    assert('SMALL canvas left alone (not tagged)', !st.chart.tag, JSON.stringify(st.chart));
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
