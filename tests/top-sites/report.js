// Render the field-audit report (French) from findings.json + coverage.json
// (+ synthesis/ outputs when present):
//   <out>/REPORT.md   — summary, method, numbers, bug classes, untestable list
//   <out>/SITES.md    — one section per site with confirmed bugs
//   <out>/index.html  — local visual viewer (ON/OFF screenshots, filters)
//   node tests/top-sites/report.js --root tests/screenshots/top-sites
'use strict';
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(arg('--root', 'tests/screenshots/top-sites'));
const OUT = path.join(ROOT, 'report');
fs.mkdirSync(OUT, { recursive: true });
const J = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const T = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };

const findings = J(path.join(ROOT, 'reviews', 'findings.json'));
const coverage = J(path.join(ROOT, 'lists', 'coverage.json'));
const clusters = J(path.join(ROOT, 'synthesis', 'clusters.json'));
const summaryMd = T(path.join(ROOT, 'synthesis', 'summary.md'));
const extBugsMd = T(path.join(ROOT, 'synthesis', 'extension-bugs.md'));
if (!findings) { console.error('findings.json missing'); process.exit(1); }

const SEV_FR = { critical: 'critique', major: 'majeur', minor: 'mineur' };
const VERDICT_FR = { ok: 'OK', 'minor-issues': 'problèmes mineurs', 'major-issues': 'problèmes majeurs', broken: 'cassé', untestable: 'non testable' };
const CAT_FR = {
  'dark-site-inverted': 'Site sombre inversé', 'light-left-unthemed': 'Zone claire non assombrie', 'media-negative': 'Média en négatif',
  'logo-icon': 'Logo / icône', 'text-contrast': 'Contraste du texte', 'bg-image-gradient': 'Image de fond / dégradé',
  'color-semantics': 'Couleurs porteuses de sens', 'shadow-border': 'Ombres / bordures', 'layout-stacking': 'Mise en page / empilement',
  'iframe-embed': 'Iframes / embeds / pubs', 'consent-overlay': 'Bandeau cookies / overlay', 'form-controls': 'Champs / contrôles',
  'state-toggle': 'Désactivation / réactivation', performance: 'Performance', other: 'Autre' };
const VER_FR = { confirmed: 'confirmé', uncertain: 'incertain', 'added-by-verifier': 'ajouté par le vérificateur', unverified: 'non vérifié' };
const DEC_FR = { inverted: 'page inversée', 'kept-dark': 'laissée sombre (déjà sombre)', mixed: 'mixte selon les pages', none: 'aucune' };
const THEME_FR = { light: 'clair', dark: 'sombre', mixed: 'mixte', unknown: 'inconnu' };
// Raw tags in prose (`<img>`, `<dialog>`) would be swallowed as HTML by Markdown
// renderers: escape `<` outside inline code spans.
const mdSafe = t => String(t == null ? '' : t).split(/(`[^`]*`)/).map((part, i) => i % 2 ? part : part.replace(/<(?=[A-Za-z\/!])/g, '&lt;')).join('');
const listLabel = l => l.list === 'global' ? `mondial #${l.rank}` : `${l.cc} #${l.rank}`;
const esc = s => mdSafe(String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' '));
const clusterOf = new Map();
if (clusters && clusters.clusters) for (const c of clusters.clusters) for (const ref of c.bugs || []) clusterOf.set(ref, c.id);

const sites = findings.sites;
const withBugs = sites.filter(s => s.bugs.length);
const st = findings.stats;

// ── REPORT.md ───────────────────────────────────────────────────────────────
let md = `# DarkAbsolut — campagne de test sur les sites les plus visités\n\n`;
md += `*Campagne des 2 et 3 octobre 2026 · DarkAbsolut 1.0.13 (copie de travail incluant le correctif du switch global) · ` +
  `${findings.stats.reviewed} sites (top 500 mondial + top 10 des 50 pays les plus peuplés, dédupliqués) · ${coverage ? coverage.totalPages : '?'} pages. ` +
  `Le rapport détaillé par site est dans SITES.md ; la visionneuse avec les captures avant/après est index.html.*\n\n`;
if (summaryMd) md += mdSafe(summaryMd.trim()) + '\n\n';
md += `## Chiffres clés\n\n`;
md += `| Indicateur | Valeur |\n|---|---|\n`;
md += `| Sites testés (mondial + nationaux, dédupliqués) | ${st.reviewed} |\n`;
md += `| Sites testables | ${st.testable} |\n| Sites non testables (blocage, erreur, page vide) | ${st.untestable} |\n`;
md += `| Sites testables avec au moins un bug retenu | ${st.withBugs} (${Math.round(100 * st.withBugs / st.testable)} %) |\n| Bugs retenus | ${st.bugs} (dont ${st.uncertain} incertains, ${st.addedByVerifier} ajoutés par la vérification${st.withBugsUntestable ? `, ${st.withBugsUntestable} sites non testables portant des bugs relevés sur leur page de blocage` : ''}) |\n`;
md += `| Bugs rejetés par la vérification contradictoire | ${st.rejected} |\n\n`;
md += `| Sévérité | Bugs |\n|---|---|\n` + ['critical', 'major', 'minor'].map(k => `| ${SEV_FR[k]} | ${st.bySeverity[k] || 0} |`).join('\n') + '\n\n';
md += `| Catégorie | Bugs |\n|---|---|\n` + Object.entries(st.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${CAT_FR[k] || k} | ${v} |`).join('\n') + '\n\n';
md += `| Verdict par site | Sites |\n|---|---|\n` + Object.entries(st.byVerdict).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${VERDICT_FR[k] || k} | ${v} |`).join('\n') + '\n\n';

if (clusters && clusters.clusters) {
  md += `## Causes racines et correctifs proposés\n\n`;
  md += `| ID | Priorité | Cause | Sites touchés | Bugs | Effort |\n|---|---|---|---|---|---|\n`;
  for (const c of clusters.clusters) md += `| ${c.id} | ${c.priority || ''} | ${esc(c.title)} | ${(c.sites || []).length} | ${(c.bugs || []).length} | ${c.effort || ''} |\n`;
  md += '\n';
  for (const c of clusters.clusters) {
    md += `### ${c.id} — ${mdSafe(c.title)}\n\n`;
    if (c.mechanism) md += `**Mécanisme.** ${mdSafe(c.mechanism)}\n\n`;
    if (c.impact) md += `**Impact.** ${mdSafe(c.impact)}\n\n`;
    if (c.fix) md += `**Correctif proposé.** ${mdSafe(c.fix)}\n\n`;
    if (c.risks) md += `**Risques / régressions.** ${mdSafe(c.risks)}\n\n`;
    if (c.test) md += `**Test à ajouter.** ${mdSafe(c.test)}\n\n`;
    if (c.examples && c.examples.length) md += `**Exemples.** ${mdSafe(c.examples.join(' ; '))}\n\n`;
    if (c.sites && c.sites.length) md += `**Sites concernés (${c.sites.length}).** ${c.sites.slice(0, 60).join(', ')}${c.sites.length > 60 ? ', …' : ''}\n\n`;
  }
}
if (extBugsMd) md += mdSafe(extBugsMd.trim()) + '\n\n';

const untestable = sites.filter(s => !s.testable);
md += `## Sites non testables (${untestable.length})\n\n| Site | Classement | Raison |\n|---|---|---|\n`;
for (const s of untestable) md += `| ${s.brandKey} | ${s.lists.map(listLabel).join(', ')} | ${esc(s.untestableReason)} |\n`;
md += '\n';
const ok = sites.filter(s => s.testable && !s.bugs.length);
md += `## Sites sans bug retenu (${ok.length})\n\n${ok.map(s => s.brandKey).join(', ')}\n\n`;

if (coverage) {
  md += `## Couverture des tops nationaux\n\nLégende : **gras** = site nouveau (testé grâce au top national), sinon déjà couvert par le top mondial ou un autre pays.\n\n`;
  md += `| Pays | Source | Top 10 retenu |\n|---|---|---|\n`;
  const PAYS = { IN: 'Inde', CN: 'Chine', US: 'États-Unis', ID: 'Indonésie', PK: 'Pakistan', NG: 'Nigeria', BR: 'Brésil', BD: 'Bangladesh',
    RU: 'Russie', ET: 'Éthiopie', MX: 'Mexique', JP: 'Japon', EG: 'Égypte', PH: 'Philippines', CD: 'RD Congo', VN: 'Viêt Nam', IR: 'Iran',
    TR: 'Turquie', DE: 'Allemagne', TH: 'Thaïlande', TZ: 'Tanzanie', GB: 'Royaume-Uni', FR: 'France', ZA: 'Afrique du Sud', IT: 'Italie',
    KE: 'Kenya', MM: 'Myanmar', CO: 'Colombie', KR: 'Corée du Sud', SD: 'Soudan', UG: 'Ouganda', ES: 'Espagne', DZ: 'Algérie', IQ: 'Irak',
    AR: 'Argentine', AF: 'Afghanistan', YE: 'Yémen', CA: 'Canada', AO: 'Angola', UA: 'Ukraine', MA: 'Maroc', PL: 'Pologne', UZ: 'Ouzbékistan',
    MY: 'Malaisie', MZ: 'Mozambique', GH: 'Ghana', PE: 'Pérou', SA: 'Arabie saoudite', MG: 'Madagascar', CI: "Côte d'Ivoire" };
  for (const c of coverage.countries) md += `| ${c.cc} ${PAYS[c.cc] || c.name} | ${c.source === 'research' ? 'recherche' : c.source} | ${c.top10.map(t => t.status === 'new' ? `**${t.domain}**` : t.domain).join(', ')} |\n`;
  md += '\n';
}
md += `## Fichiers et données\n\nTout est sous \`tests/screenshots/top-sites/\` (dossier ignoré par git) :\n\n` +
  `- \`report/REPORT.md\` (ce document), \`report/SITES.md\` (un chapitre par site avec bugs), \`report/index.html\` (visionneuse locale : filtres, captures ON/OFF) ;\n` +
  `- \`runs/<page>/\` : captures \`on-initial\`, \`on-top\`, \`on-mid\`, \`off-top\`, \`off-mid\`, \`reon-top\`, planche \`sheet.jpg\`, instantanés DOM \`capture.json\`, analyse \`analysis.json\` ;\n` +
  `- \`reviews/<site>.json\` et \`reviews/<site>.verify.json\` : revue visuelle et vérification contradictoire ; \`reviews/findings.json\` : agrégat ;\n` +
  `- \`synthesis/clusters.json\` : les ${clusters && clusters.clusters ? clusters.clusters.length : '?'} causes racines avec la liste des bugs et des sites rattachés ; \`synthesis/critique.md\` : la relecture critique appliquée ;\n` +
  `- \`lists/\` : sources (CrUX, Tranco, Similarweb, Semrush, recherche), décisions d'inclusion et \`coverage.json\` ; \`perf.json\` : étude de performance.\n\n` +
  `Relancer la campagne (outillage dans \`tests/top-sites/\`) : \`capture.js\` → \`analyze.js\` → revue → \`aggregate.js\` → \`report.js\` ; ` +
  `\`perf.js\` pour la performance. Pour valider un correctif, rejouer \`capture.js --only <ids>\` sur les pages listées dans \`clusters.json\`.\n`;
fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);

// ── SITES.md ────────────────────────────────────────────────────────────────
let sm = `# Rapport par site\n\nUn chapitre par site présentant au moins un bug retenu, dans l'ordre du classement mondial puis des ajouts nationaux. Les captures citées sont dans \`tests/screenshots/top-sites/runs/<page>/\` (\`on-*.jpg\` = extension active, \`off-*.jpg\` = même chargement, extension coupée ; \`sheet.jpg\` = paires OFF | ON des zones signalées).\n\n`;
sm += `| Site | Classement | Verdict | Critiques | Majeurs | Mineurs |\n|---|---|---|---|---|---|\n`;
for (const s of withBugs) {
  const c = k => s.bugs.filter(b => b.severity === k).length;
  sm += `| [${s.brandKey}](#${s.id}) | ${s.lists.map(listLabel).join(', ')} | ${VERDICT_FR[s.verdict]} | ${c('critical')} | ${c('major')} | ${c('minor')} |\n`;
}
sm += '\n';
for (const s of withBugs) {
  sm += `<a id="${s.id}"></a>\n\n## ${s.brandKey}\n\n`;
  sm += `- **Classement :** ${s.lists.map(listLabel).join(', ')}\n- **URL :** ${s.url}\n- **Pages testées :** ${s.pagesReviewed.map(p => '`' + p + '`').join(', ')}\n`;
  sm += `- **Verdict :** ${VERDICT_FR[s.verdict]} — thème natif : ${THEME_FR[s.nativeTheme] || s.nativeTheme || '?'} ; décision de l'extension : ${DEC_FR[s.extensionDecision] || s.extensionDecision || '?'}\n\n`;
  if (s.summary) sm += `> ${mdSafe(s.summary)}\n\n`;
  for (const b of s.bugs) {
    const cl = clusterOf.get(`${s.id}#${b.id}`);
    sm += `### ${b.id} — ${mdSafe(b.title)} (${SEV_FR[b.severity] || b.severity})\n\n`;
    sm += `- **Catégorie :** ${CAT_FR[b.category] || b.category}${cl ? ` · **Cause commune :** ${cl}` : ''} · **Vérification :** ${VER_FR[b.verdict] || b.verdict} · **Confiance :** ${b.confidence || '?'}\n`;
    sm += `- **Page / vue :** \`${b.page}\` — ${mdSafe(b.where || '')}\n`;
    sm += `- **Constaté :** ${mdSafe(b.observed)}\n- **Attendu :** ${mdSafe(b.expected)}\n`;
    if (b.evidence) sm += `- **Preuve :** ${mdSafe(b.evidence)}\n`;
    if (b.likelyCause) sm += `- **Cause probable :** ${mdSafe(b.likelyCause)}\n`;
    if (b.genericFix) sm += `- **Correctif générique :** ${mdSafe(b.genericFix)}\n`;
    if (b.verifierNote) sm += `- **Note du vérificateur :** ${mdSafe(b.verifierNote)}\n`;
    sm += '\n';
  }
  if (s.positives && s.positives.length) sm += `*Points positifs :* ${mdSafe(s.positives.join(' ; '))}\n\n`;
}
fs.writeFileSync(path.join(OUT, 'SITES.md'), sm);

// ── index.html (local viewer) ───────────────────────────────────────────────
const data = sites.map(s => ({ id: s.id, b: s.brandKey, u: s.url, l: s.lists.map(listLabel).join(', '), v: s.verdict, t: s.testable, r: s.untestableReason,
  s: s.summary, p: s.pagesReviewed, n: THEME_FR[s.nativeTheme] || s.nativeTheme, d: DEC_FR[s.extensionDecision] || s.extensionDecision,
  bugs: s.bugs.map(b => ({ id: b.id, t: b.title, c: b.category, sv: b.severity, pg: b.page, w: b.where, o: b.observed, e: b.expected, ca: b.likelyCause, f: b.genericFix, vr: VER_FR[b.verdict] || b.verdict, cl: clusterOf.get(`${s.id}#${b.id}`) || null })) }));
const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DarkAbsolut — audit des top sites</title>
<style>
:root{--bg:#f6f7f9;--fg:#15171a;--muted:#5d6470;--card:#fff;--line:#dde1e6;--crit:#c62828;--maj:#d97706;--min:#2563eb;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--fg:#e8eaed;--muted:#9aa1ab;--card:#1a1d21;--line:#2c3036;--crit:#f87171;--maj:#fbbf24;--min:#60a5fa;--ok:#4ade80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
h1{font-size:16px;margin:0 12px 0 0}select,input{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font:inherit}
main{max-width:1280px;margin:0 auto;padding:16px}.site{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:0 0 14px;padding:14px}
.site h2{font-size:15px;margin:0 0 4px}.meta{color:var(--muted);font-size:12px}.sum{margin:8px 0}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;margin:10px 0}.shots figure{margin:0}.shots img{width:100%;border:1px solid var(--line);border-radius:6px;display:block}
.shots figcaption{font-size:11px;color:var(--muted)}.bug{border-left:4px solid var(--line);padding:6px 10px;margin:8px 0;background:color-mix(in srgb,var(--card) 92%,var(--fg))}
.bug.critical{border-color:var(--crit)}.bug.major{border-color:var(--maj)}.bug.minor{border-color:var(--min)}.bug b{display:block}
.pill{display:inline-block;font-size:11px;border:1px solid var(--line);border-radius:999px;padding:0 8px;margin-right:4px}
.v-broken{color:var(--crit)}.v-major-issues{color:var(--maj)}.v-minor-issues{color:var(--min)}.v-ok{color:var(--ok)}
details>summary{cursor:pointer}
</style></head><body>
<header><h1>DarkAbsolut — audit des top sites</h1>
<input id="q" type="search" placeholder="Filtrer (site, bug…)">
<select id="fv"><option value="">Tous les verdicts</option><option value="broken">cassé</option><option value="major-issues">majeur</option><option value="minor-issues">mineur</option><option value="ok">OK</option><option value="untestable">non testable</option></select>
<select id="fc"><option value="">Toutes les catégories</option>${Object.entries(CAT_FR).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
<span class="meta" id="count"></span></header>
<main id="list"></main>
<script>
const DATA=${JSON.stringify(data)};
const SEV={critical:'critique',major:'majeur',minor:'mineur'},VER=${JSON.stringify(VERDICT_FR)},CAT=${JSON.stringify(CAT_FR)};
const e=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function render(){const q=document.getElementById('q').value.toLowerCase(),fv=document.getElementById('fv').value,fc=document.getElementById('fc').value;
let n=0;const out=[];for(const s of DATA){if(fv&&s.v!==fv)continue;if(fc&&!s.bugs.some(b=>b.c===fc))continue;
if(q&&!(s.b+' '+s.s+' '+s.bugs.map(b=>b.t+' '+b.o).join(' ')).toLowerCase().includes(q))continue;n++;
const shots=(s.p||[]).map(pg=>'<div class="meta">'+e(pg)+'</div><div class="shots">'+['on-initial','on-top','off-top','on-mid','off-mid','reon-top','sheet'].map(k=>'<figure><a href="../runs/'+encodeURIComponent(pg)+'/'+k+'.jpg" target="_blank"><img loading="lazy" src="../runs/'+encodeURIComponent(pg)+'/'+k+'.jpg" onerror="this.parentNode.parentNode.remove()"></a><figcaption>'+k+'</figcaption></figure>').join('')+'</div>').join('');
out.push('<section class="site"><h2>'+e(s.b)+' <span class="v-'+s.v+'">· '+e(VER[s.v]||s.v)+'</span></h2><div class="meta">'+e(s.l)+' · <a href="'+e(s.u)+'" target="_blank" rel="noopener">'+e(s.u)+'</a> · thème natif '+e(s.n)+' · '+e(s.d)+(s.t?'':' · non testable : '+e(s.r))+'</div>'+
(s.s?'<p class="sum">'+e(s.s)+'</p>':'')+s.bugs.map(b=>'<div class="bug '+b.sv+'"><b>'+e(b.id)+' — '+e(b.t)+'</b><span class="pill">'+e(SEV[b.sv])+'</span><span class="pill">'+e(CAT[b.c]||b.c)+'</span>'+(b.cl?'<span class="pill">'+e(b.cl)+'</span>':'')+'<span class="pill">'+e(b.vr)+'</span><span class="pill">'+e(b.pg)+'</span><div>'+e(b.o)+'</div><details><summary>Détails</summary><div><i>Attendu :</i> '+e(b.e)+'</div><div><i>Cause probable :</i> '+e(b.ca)+'</div><div><i>Correctif :</i> '+e(b.f)+'</div><div><i>Vue :</i> '+e(b.w)+'</div></details></div>').join('')+
'<details><summary>Captures (ON = extension active, OFF = même chargement, extension coupée)</summary>'+shots+'</details></section>');}
document.getElementById('list').innerHTML=out.join('');document.getElementById('count').textContent=n+' site(s)';}
for(const id of ['q','fv','fc'])document.getElementById(id).addEventListener('input',render);render();
</script></body></html>`;
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log(`report → ${OUT} (REPORT.md, SITES.md, index.html); ${withBugs.length} sites with bugs`);
