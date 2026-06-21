// Regression test: media inside (open) shadow DOM must be re-inverted.
//
// The page-level `filter: invert()` on <html> inverts shadow content too, but
// the counter-invert CSS / element tagging don't cross shadow boundaries — so
// without special handling, images inside ad/sponsored web components render as
// colour-negatives (the TripAdvisor sponsored-card bug). DarkAbsolut adopts a
// shadow-scoped stylesheet into each shadow root and tags shadow bg-images.
//
//   node tests/test-shadow.js
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const EXT = path.resolve(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'da-shadow-'));

// Quote-free 1x1 PNG data URIs (size set via attributes/CSS) so the inline
// page script needs no escaping.
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PAGE = `<!doctype html><html><head><meta charset=utf-8><title>shadow</title>
<style>html,body{margin:0;background:#fff;color:#111;font-family:sans-serif}</style></head>
<body>
<h1>Light page</h1>
<img id="normal" width="200" height="120" src="${IMG}">
<sponsored-card></sponsored-card>
<script>
var SRC=${JSON.stringify(IMG)};
class SponsoredCard extends HTMLElement{
  connectedCallback(){
    var sr=this.attachShadow({mode:'open'});
    var im=document.createElement('img');im.id='shadowimg';im.width=200;im.height=120;im.src=SRC;sr.appendChild(im);
    var bg=document.createElement('div');bg.id='shadowbg';
    bg.style.cssText='width:200px;height:120px;background:url('+SRC+') no-repeat center / cover';
    sr.appendChild(bg);
    // A natively-dark wrapper (inside shadow) holding a SMALL image: the wrapper
    // is kept dark (darknative); its media must NOT also be counter-inverted, or
    // it triple-inverts to a colour-negative. Exercises the shadow-scoped
    // [darknative] media{filter:none} rule.
    var dwrap=document.createElement('div');dwrap.id='shadowdark';
    dwrap.style.cssText='width:300px;height:160px;background:#0a0a0a;color:#eee;padding:8px';
    var di=document.createElement('img');di.id='shadowdarkimg';di.width=80;di.height=40;di.src=SRC;
    dwrap.appendChild(di);sr.appendChild(dwrap);
    // lazily mount a second image to exercise the shadow observer
    setTimeout(function(){var l=document.createElement('img');l.id='shadowlazy';l.width=200;l.height=120;l.src=SRC;sr.appendChild(l);},700);
  }
}
customElements.define('sponsored-card',SponsoredCard);
</script>
${'<p>filler</p>'.repeat(25)}
</body></html>`;

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

function probe() {
  const card = document.querySelector('sponsored-card');
  const sr = card && card.shadowRoot;
  const f = el => el ? getComputedStyle(el).filter : '(missing)';
  const inv = s => /invert/.test(s);
  return {
    root: document.documentElement.getAttribute('data-darkabsolut'),
    normal: inv(f(document.getElementById('normal'))),
    shadowImg: inv(f(sr && sr.getElementById('shadowimg'))),
    shadowBg: inv(f(sr && sr.getElementById('shadowbg'))),
    shadowBgTagged: sr && sr.getElementById('shadowbg') ? sr.getElementById('shadowbg').getAttribute('data-darkabsolut-bg') : null,
    shadowLazy: (() => { const el = sr && sr.getElementById('shadowlazy'); return el ? inv(f(el)) : 'absent'; })(),
    shadowDarkTagged: sr && sr.getElementById('shadowdark') ? sr.getElementById('shadowdark').getAttribute('data-darkabsolut-darknative') : null,
    shadowDarkImg: (() => { const el = sr && sr.getElementById('shadowdarkimg'); return el ? inv(f(el)) : 'absent'; })(),
  };
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
    headless: true, channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  try {
    let [w] = context.serviceWorkers();
    if (!w) { try { w = await context.waitForEvent('serviceworker', { timeout: 8000 }); } catch (_) {} }
    const extId = w && w.url().split('/')[2];

    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 700 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(1600); // let the lazy shadow image mount + get processed

    const r = await page.evaluate(probe);
    assert('page is inverted', r.root === 'on', `root=${r.root}`);
    assert('normal <img> counter-inverted (control)', r.normal === true);
    assert('shadow-DOM <img> counter-inverted', r.shadowImg === true);
    assert('shadow-DOM bg-image tagged', r.shadowBgTagged === '1');
    assert('shadow-DOM bg-image counter-inverted', r.shadowBg === true);
    assert('lazily-added shadow <img> counter-inverted', r.shadowLazy === true,
           `shadowLazy=${r.shadowLazy}`);
    // Media inside a kept-dark wrapper *in shadow DOM* must be neutralised, not
    // triple-inverted (the shadow-scoped darknative-media rule).
    assert('shadow dark wrapper kept dark (darknative)', r.shadowDarkTagged === '1',
           `tagged=${r.shadowDarkTagged}`);
    assert('media inside shadow darknative NOT counter-inverted', r.shadowDarkImg === false,
           `inv=${r.shadowDarkImg}`);

    // ── Disable for the page → shadow counter-invert styles must be removed ──
    if (extId) {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extId}/popup/io.html`, { waitUntil: 'load' });
      await popup.evaluate(() => new Promise(res =>
        chrome.runtime.sendMessage({ type: 'SET_GLOBAL_ENABLED', value: false }, res)));
      await page.waitForTimeout(700);
      const off = await page.evaluate(() => {
        const sr = document.querySelector('sponsored-card').shadowRoot;
        return /invert/.test(getComputedStyle(sr.getElementById('shadowimg')).filter);
      });
      assert('disable removes shadow counter-invert', off === false);
      await popup.evaluate(() => new Promise(res =>
        chrome.runtime.sendMessage({ type: 'SET_GLOBAL_ENABLED', value: true }, res)));
    }
  } finally {
    await context.close();
    server.close();
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
