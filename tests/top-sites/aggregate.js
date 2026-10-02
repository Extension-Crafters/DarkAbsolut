// Merge reviewer findings with adversarial verdicts into findings.json + stats.
//   node tests/top-sites/aggregate.js --lists <dir> --reviews <dir> --out <file>
'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const LISTS = path.resolve(arg('--lists'));
const REVIEWS = path.resolve(arg('--reviews'));
const OUT = path.resolve(arg('--out', path.join(REVIEWS, 'findings.json')));
const J = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

const sites = J(path.join(LISTS, 'sites-final.json'));
const SEV = { critical: 3, major: 2, minor: 1 };
const out = { sites: [], stats: { reviewed: 0, testable: 0, untestable: 0, withBugs: 0, bugs: 0, rejected: 0, uncertain: 0, addedByVerifier: 0,
  bySeverity: {}, byCategory: {}, byVerdict: {} } };
for (const s of sites) {
  const rev = J(path.join(REVIEWS, s.id + '.json'));
  if (!rev) continue;
  const ver = J(path.join(REVIEWS, s.id + '.verify.json'));
  out.stats.reviewed++;
  const vmap = new Map(((ver && ver.verdicts) || []).map(v => [v.bugId, v]));
  const bugs = [], dropped = [];
  for (const b of rev.bugs || []) {
    const v = vmap.get(b.id);
    const verdict = ver ? (v ? v.verdict : 'unverified') : 'unverified';
    const rec = { ...b, verdict, verifierNote: v ? v.reason : null, severity: (v && v.severity) || b.severity };
    if (verdict === 'rejected') { dropped.push(rec); out.stats.rejected++; continue; }
    if (verdict === 'uncertain') out.stats.uncertain++;
    bugs.push(rec);
  }
  for (const b of (ver && ver.missed) || []) { bugs.push({ ...b, verdict: 'added-by-verifier' }); out.stats.addedByVerifier++; }
  bugs.sort((a, b) => (SEV[b.severity] || 0) - (SEV[a.severity] || 0));
  const testable = rev.testable !== false;
  if (testable) out.stats.testable++; else out.stats.untestable++;
  // The bug rate is over testable sites only; bugs seen on a blocking page
  // (captcha/interstitial themed badly) are kept but counted apart.
  if (bugs.length) { if (testable) out.stats.withBugs++; else out.stats.withBugsUntestable = (out.stats.withBugsUntestable || 0) + 1; }
  out.stats.bugs += bugs.length;
  for (const b of bugs) {
    out.stats.bySeverity[b.severity] = (out.stats.bySeverity[b.severity] || 0) + 1;
    out.stats.byCategory[b.category] = (out.stats.byCategory[b.category] || 0) + 1;
  }
  const verdict = !testable ? 'untestable'
    : bugs.length ? (bugs.some(b => b.severity === 'critical') ? 'broken' : bugs.some(b => b.severity === 'major') ? 'major-issues' : 'minor-issues') : 'ok';
  out.stats.byVerdict[verdict] = (out.stats.byVerdict[verdict] || 0) + 1;
  out.sites.push({ id: s.id, brandKey: s.brandKey, url: s.url, category: s.category,
    lists: s.lists, testable, untestableReason: rev.untestableReason || null, nativeTheme: rev.nativeTheme, extensionDecision: rev.extensionDecision,
    summary: rev.summary, positives: rev.positives || [], verdict, bugs, dropped, pagesReviewed: rev.pagesReviewed || [] });
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.stats, null, 1));
