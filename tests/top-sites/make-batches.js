// Group captured pages into review batches (all pages of a site stay together).
//   node tests/top-sites/make-batches.js --lists <dir> --runs <dir> --reviews <dir> [--per 4] [--max-pages 6] [--out batches.json]
'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const LISTS = path.resolve(arg('--lists'));
const RUNS = path.resolve(arg('--runs'));
const REVIEWS = path.resolve(arg('--reviews'));
const PER = +arg('--per', 4), MAXP = +arg('--max-pages', 6);
const OUT = arg('--out', path.join(REVIEWS, 'batches.json'));
// Sites with a page still pending capture (comma list of page ids, or a pages json file).
const pendingArg = arg('--pending', '');
const pendingPages = pendingArg.endsWith('.json') ? JSON.parse(fs.readFileSync(pendingArg, 'utf8')).map(p => p.id) : pendingArg.split(',').filter(Boolean);
const sites = JSON.parse(fs.readFileSync(path.join(LISTS, 'sites-final.json'), 'utf8'));
const pages = JSON.parse(fs.readFileSync(path.join(LISTS, 'pages.json'), 'utf8'));
fs.mkdirSync(REVIEWS, { recursive: true });

const todo = [];
for (const s of sites) {
  if (fs.existsSync(path.join(REVIEWS, s.id + '.json'))) continue; // already reviewed
  if (pages.some(p => p.site === s.id && pendingPages.includes(p.id))) continue; // wait for its capture
  const ps = pages.filter(p => p.site === s.id && fs.existsSync(path.join(RUNS, p.id, 'analysis.json')));
  if (!ps.length) continue;
  todo.push({ site: s.id, url: s.url, brandKey: s.brandKey, category: s.category,
    lists: (ls => ls.length > 4 ? ls.slice(0, 3).join(', ') + ` + ${ls.length - 3} other national top-10s` : ls.join(', '))(
      s.lists.map(l => l.list === 'global' ? `global #${l.rank}` : `${l.cc} #${l.rank}`)),
    pages: ps.map(p => ({ id: p.id, url: p.url, kind: p.kind })) });
}
const batches = [];
let cur = null;
for (const t of todo) {
  if (!cur || cur.sites.length >= PER || cur.pageCount + t.pages.length > MAXP) {
    cur = { name: 'b' + String(batches.length + 1).padStart(3, '0'), sites: [], pageCount: 0 };
    batches.push(cur);
  }
  cur.sites.push(t); cur.pageCount += t.pages.length;
}
fs.writeFileSync(OUT, JSON.stringify(batches, null, 1));
console.log(`${todo.length} sites, ${todo.reduce((s, t) => s + t.pages.length, 0)} pages → ${batches.length} batches → ${OUT}`);
