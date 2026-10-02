// Prepare compact per-group inputs for the root-cause synthesis agents.
//   node tests/top-sites/prep-synthesis.js --root tests/screenshots/top-sites
'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(arg('--root', 'tests/screenshots/top-sites'));
const OUT = path.join(ROOT, 'synthesis');
fs.mkdirSync(OUT, { recursive: true });
const findings = JSON.parse(fs.readFileSync(path.join(ROOT, 'reviews', 'findings.json'), 'utf8'));

const GROUPS = {
  media: ['media-negative', 'bg-image-gradient'],
  light: ['light-left-unthemed', 'dark-site-inverted'],
  text: ['text-contrast', 'form-controls', 'color-semantics'],
  icons: ['logo-icon'],
  frames: ['iframe-embed', 'consent-overlay', 'layout-stacking'],
  misc: ['shadow-border', 'state-toggle', 'performance', 'other'],
};
const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const counts = {};
for (const [g, cats] of Object.entries(GROUPS)) {
  const lines = [];
  for (const s of findings.sites) for (const b of s.bugs) {
    if (!cats.includes(b.category)) continue;
    lines.push([`${s.id}#${b.id}`, b.severity, b.verdict, b.category, b.page, clean(b.title), 'OBS: ' + clean(b.observed),
      'CAUSE: ' + clean(b.likelyCause), 'FIX: ' + clean(b.genericFix), 'WHERE: ' + clean(b.where)].join(' | '));
  }
  counts[g] = lines.length;
  fs.writeFileSync(path.join(OUT, `input-${g}.txt`),
    `# Group "${g}" — categories: ${cats.join(', ')} — ${lines.length} retained bugs\n` +
    `# Format: siteId#bugId | severity | verification | category | page | title | observed | likely cause | generic fix | where\n` +
    lines.join('\n') + '\n');
}
fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify({ ...findings.stats, groups: counts }, null, 1));
console.log(JSON.stringify(counts));
