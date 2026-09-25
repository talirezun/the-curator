#!/usr/bin/env node
/**
 * test-domains-true-numbers.js — OFFLINE suite for v3.72.1's "true numbers"
 * fixes on the Domains page and Wiki health (truth-audit part-domains F1–F12,
 * part-tray-copy F8, and the AI Health default-limits contradiction).
 *
 * No network, no API key, no browser, no spend. Isolated user-data and
 * domains dirs are set BEFORE any app module is imported.
 *
 * Every view assertion EXECUTES the real function lifted from
 * src/public/next/views/domains.js (brace-matched to its column-0 close) in a
 * sandbox whose collaborators are named here — a missing collaborator is a
 * named failure, never a silent pass. Server assertions call the real brain
 * functions and the real route handlers.
 *
 *   §1  F1  refreshDomainFigures patches the row, revalidates the list, drops
 *           a non-active domain's dot, rescans only when asked
 *   §2  F1  the write-gate watcher: an ingest's release refreshes + rescans,
 *           a Health write's release refreshes without a second scan, a
 *           rename/delete is left to its own reload; the label sets name
 *           labels this file really passes to beginDomainWrite
 *   §3  F1  the Delete confirm quotes the count read when it OPENED, never
 *           the stale row ("promise 4, delete 7")
 *   §4  F2/F3 lastWriteReading: day precision, the log's own verb
 *   §5  F4  the duplicate-scan confirm refuses before the click when over the
 *           ceiling, and names the max-pairs cap as the user's setting
 *   §6  F4  the defaults agree: ceiling >= max pairs × tokens per pair
 *   §7  F5  the Dismissed group counts records, not hidden issues; the route
 *           sends the record count
 *   §8  F6  "Fix N safe issues" counts and warns about the pages it deletes
 *   §9  F7  the PROJECTS figure is the store's total, not the capped rows
 *   §10 F8  the PAGES tile's name when OTHER files exist
 *   §11 F9  staleHealthSlugs drops a dot whose domain's stats moved
 *   §12 F10 the compact cost badge is marked "≈"
 *   §13 F11 the semantic header names verdicts, not candidates
 *   §14 F12 ages tick: relTime speaks the ticker's words; the scan meta and a
 *           project's last save are [data-age-at] spans
 *   §15 tray F8 the merge preview's cap is the server's, in characters
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const USER_DIR = mkdtempSync(path.join(os.tmpdir(), 'curator-truenum-user-'));
const DOMAINS_DIR = mkdtempSync(path.join(os.tmpdir(), 'curator-truenum-domains-'));
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DIR;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;

const { __setDomainsDirOverride, DEFAULT_AI_HEALTH, getAiHealthSettings } =
  await import(path.join(REPO, 'src/brain/config.js'));
__setDomainsDirOverride(DOMAINS_DIR);
const { previewSemanticDuplicateMerge, MERGED_PREVIEW_CAP_CHARS, SEMANTIC_DUPE_DEFAULT_CAP } =
  await import(path.join(REPO, 'src/brain/health.js'));
const { EST_TOKENS_PER_PAIR, scanSemanticDuplicates } = await import(path.join(REPO, 'src/brain/health-ai.js'));
const { addDismissal } = await import(path.join(REPO, 'src/brain/health-dismissed.js'));
const { formatDayAge, formatAge } = await import(path.join(REPO, 'src/public/next/shared/age.js'));
const { ageWordsFor } = await import(path.join(REPO, 'src/public/next/shared/age-ticker.js'));
const { formatUsdHonest } = await import(path.join(REPO, 'src/public/next/shared/format-usd.js'));

const SRC = readFileSync(path.join(REPO, 'src/public/next/views/domains.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }

// ── Lifting ────────────────────────────────────────────────────────────────
// A top-level `function NAME(` / `async function NAME(` through the first
// `\n}` at column 0 (this file's functions all close there).
function lift(name) {
  const re = new RegExp(`\\n((?:async )?function ${name}\\()`);
  const m = SRC.match(re);
  if (!m) throw new Error('lift: no function ' + name);
  const start = m.index + 1;
  const end = SRC.indexOf('\n}', start);
  if (end === -1) throw new Error('lift: no column-0 close for ' + name);
  return SRC.slice(start, end + 2);
}
function liftConst(name) {
  const re = new RegExp(`\\nconst ${name} = [\\s\\S]*?\\);\\n`);
  const m = SRC.match(re);
  if (!m) throw new Error('liftConst: no const ' + name);
  return m[0];
}
function sandbox(fnNames, inject, extraSrc = '') {
  const body = extraSrc + fnNames.map(lift).join('\n\n') + `\nreturn { ${fnNames.join(', ')} };`;
  const names = Object.keys(inject);
  return new Function(...names, body)(...names.map((k) => inject[k]));
}
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const pluralize = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
const tick = () => new Promise((r) => setTimeout(r, 0));

// ═══════════════════════════════════════════════════════════════════════════
section('1. F1 — refreshDomainFigures');
{
  const mk = (over = {}) => {
    const calls = { render: 0, browse: [], rescan: [] };
    const state = {
      activeSlug: 'a',
      domains: [
        { slug: 'a', pageCount: 4, pageCounts: { entities: 4, concepts: 0, summaries: 0, other: 0 }, lastIngestDate: '2026-09-20', lastIngestKind: 'ingest' },
        { slug: 'b', pageCount: 9, pageCounts: { entities: 9, concepts: 0, summaries: 0, other: 0 }, lastIngestDate: '2026-09-01', lastIngestKind: 'ingest' },
      ],
      healthSummary: { a: 3, b: 5 },
    };
    const fresh = over.fresh || {};
    const fns = sandbox(['statsRowChanged', 'refreshDomainFigures'], {
      state,
      fetchJSON: async (url) => {
        calls.url = url;
        if (over.fail) throw new Error('boom');
        const slug = decodeURIComponent(url.split('/')[3]);
        return fresh[slug];
      },
      isCurrentMount: () => over.stale !== true,
      render: () => { calls.render++; },
      loadBrowse: async (slug) => { calls.browse.push(slug); },
      rescan: (slug) => { calls.rescan.push(slug); },
      reportAsyncActionFailure: () => {},
    });
    return { state, calls, fns };
  };

  const seven = { slug: 'a', pageCount: 7, pageCounts: { entities: 7, concepts: 0, summaries: 0, other: 0 }, lastIngestDate: '2026-09-25', lastIngestKind: 'ingest' };
  let t = mk({ fresh: { a: seven } });
  let r = await t.fns.refreshDomainFigures('a', 1, { rescan: true });
  ok(t.calls.url === '/api/domains/a/stats', '1.1 reads the one-domain stats route', t.calls.url);
  ok(t.state.domains[0].pageCount === 7 && r && r.pageCount === 7, '1.2 the row is patched with the fresh count (4 → 7)');
  ok(t.state.domains[1].pageCount === 9, '1.3 the other domain\'s row is untouched');
  ok(t.calls.browse.join() === 'a', '1.4 the active domain\'s page list is revalidated');
  ok(t.calls.rescan.join() === 'a', '1.5 rescan:true + a changed row rescans Health');
  ok(t.calls.render >= 1, '1.6 a changed row repaints');

  t = mk({ fresh: { a: seven } });
  await t.fns.refreshDomainFigures('a', 1, {});
  ok(t.calls.rescan.length === 0, '1.7 without rescan (a Health write reloads itself) there is no second scan');

  const bFresh = { slug: 'b', pageCount: 8, pageCounts: { entities: 8, concepts: 0, summaries: 0, other: 0 }, lastIngestDate: '2026-09-25', lastIngestKind: 'ingest' };
  t = mk({ fresh: { b: bFresh } });
  await t.fns.refreshDomainFigures('b', 1, { rescan: true });
  ok(!('b' in t.state.healthSummary) && t.state.healthSummary.a === 3,
    '1.8 a NON-active domain whose stats moved loses its (now stale) dot; the active one keeps its own');
  ok(t.calls.browse.length === 0 && t.calls.rescan.length === 0, '1.9 …and nothing is revalidated for a domain not on screen');

  t = mk({ fail: true });
  r = await t.fns.refreshDomainFigures('a', 1, { rescan: true });
  ok(r === null && t.state.domains[0].pageCount === 4, '1.10 a failed read returns null and leaves the row alone');

  t = mk({ fresh: { a: { ...t.state.domains[0] } } });
  await t.fns.refreshDomainFigures('a', 1, { rescan: true });
  ok(t.calls.render === 0 && t.calls.rescan.length === 0, '1.11 CONTROL — an identical row repaints nothing and scans nothing');

  t = mk({ fresh: { a: seven }, stale: true });
  await t.fns.refreshDomainFigures('a', 1, { rescan: true });
  ok(t.state.domains[0].pageCount === 4, '1.12 an abandoned mount writes nothing');
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. F1 — the write-gate watcher');
{
  const run = async (label) => {
    const busy = new Map();
    const refreshes = [];
    const shell = {
      isDomainWriteBusy: (s) => busy.has(s),
      getDomainWriteLabel: (s) => busy.get(s) || null,
    };
    const state = { domains: [{ slug: 'a' }, { slug: 'b' }] };
    const extra = liftConst('WRITES_THAT_RESCAN_THEMSELVES') + liftConst('WRITES_THAT_RELOAD_THE_LIST') +
      'const writesInFlight = new Map();\n';
    const { onWriteGateEdge } = sandbox(['onWriteGateEdge'], {
      shell, state, isCurrentMount: () => true, reportAsyncActionFailure: () => {},
      refreshDomainFigures: async (slug, token, opts) => { refreshes.push({ slug, rescan: !!(opts && opts.rescan) }); },
    }, extra);
    busy.set('a', label); onWriteGateEdge(1);
    ok(refreshes.length === 0, `2.x (${label}) nothing refreshes while the write is running`);
    busy.delete('a'); onWriteGateEdge(1);
    await tick();
    onWriteGateEdge(1); // a later unrelated gate change must not refresh again
    return refreshes;
  };
  let r = await run('ingest');
  ok(r.length === 1 && r[0].slug === 'a' && r[0].rescan === true, '2.1 an ingest\'s release refreshes that domain AND rescans Health', JSON.stringify(r));
  r = await run('batch ingest');
  ok(r.length === 1 && r[0].rescan === true, '2.2 a batch ingest likewise');
  r = await run('health-fix');
  ok(r.length === 1 && r[0].rescan === false, '2.3 a Health write refreshes the figures without a second scan', JSON.stringify(r));
  r = await run('semantic-dupes-merge-batch');
  ok(r.length === 1 && r[0].rescan === false, '2.4 the semantic batch merge likewise');
  r = await run('delete-domain');
  ok(r.length === 0, '2.5 a delete is left to reloadAfterLifecycleChange');
  r = await run('sharedbrain-pull');
  ok(r.length === 1 && r[0].rescan === true, '2.6 an unknown label takes the SAFE branch (rescan)');

  // The two sets name real labels: a renamed label would otherwise orphan a
  // set entry and make its write rescan twice or skip its refresh.
  const literal = new Set([...SRC.matchAll(/beginDomainWrite\([^,]+,\s*([^)]*)\)/g)]
    .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])));
  const setMembers = (name) => [...liftConst(name).matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const orphans = [...setMembers('WRITES_THAT_RESCAN_THEMSELVES'), ...setMembers('WRITES_THAT_RELOAD_THE_LIST')]
    .filter((l) => !literal.has(l));
  ok(orphans.length === 0, '2.7 every label in the two sets is a literal this file passes to beginDomainWrite', orphans.join(', '));
  ok(literal.size >= 8, '2.8 CROSS-CHECK — the label scan found the file\'s writes (' + literal.size + ')');
  // And every Health path that ends in loadHealth holds a label in the set.
  for (const fn of ['runFixSafe', 'fixAllOfType', 'applyPendingPlan']) {
    const src = lift(fn);
    const labels = [...src.matchAll(/beginDomainWrite\([^,]+,\s*([^)]*)\)/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
      .filter((l) => !/^[a-z]+[A-Z]/.test(l)); // a `kind === 'brokenLinks'` operand is not a label
    const set = new Set(setMembers('WRITES_THAT_RESCAN_THEMSELVES'));
    ok(labels.length > 0 && labels.every((l) => set.has(l)) && /loadHealth\(/.test(src),
      `2.9 ${fn}: reloads Health itself and its label(s) ${labels.join('/')} are in WRITES_THAT_RESCAN_THEMSELVES`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('2b. A Shared Brain pull reloads the page\'s figures (onActionDone)');
{
  const refreshed = [];
  let reloaded = 0;
  const state = { domains: [{ slug: 'a', pageCount: 1 }, { slug: 'shared-x', pageCount: 5 }] };
  let serve = { domains: [{ slug: 'a', pageCount: 1 }, { slug: 'shared-x', pageCount: 9 }] };
  const { onSharedActionDone } = sandbox(['statsRowChanged', 'staleHealthSlugs', 'onSharedActionDone'], {
    state, myMountToken: 1, isCurrentMount: () => true, reportAsyncActionFailure: (e) => { throw e; },
    fetchJSON: async () => serve,
    refreshDomainFigures: async (slug, t, o) => { refreshed.push(slug + ':' + !!(o && o.rescan)); },
    reloadAfterLifecycleChange: async () => { reloaded++; },
  });
  onSharedActionDone({ action: 'pull', connId: 'c1' });
  await tick(); await tick();
  ok(refreshed.join() === 'shared-x:true' && reloaded === 0,
    '2b.1 a pull refreshes the mirror whose pages changed (and only it)', refreshed.join());
  serve = { domains: [...serve.domains, { slug: 'shared-y', pageCount: 3 }] };
  onSharedActionDone({ action: 'pull', connId: 'c2' });
  await tick(); await tick();
  ok(reloaded === 1, '2b.2 a pull that CREATED a mirror reloads the whole list');
  ok(/onActionDone: onSharedActionDone/.test(lift('mountHostedSections')), '2b.3 the hook is passed to the hosted Shared Brain section');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. F1 — the Delete confirm quotes the count read when it opened');
{
  let resolveFresh;
  const state = {
    domains: [{ slug: 'a', displayName: 'Alpha', pageCount: 4 }],
    readonlySet: new Set(), lifecycle: null, banner: null, confirm: null,
  };
  let renders = 0;
  const fns = sandbox(['openLifecycle', 'renderLifecycleCard'], {
    state, myMountToken: 1, render: () => { renders++; },
    isCurrentMount: () => true, reportAsyncActionFailure: (e) => { throw e; },
    refreshDomainFigures: () => new Promise((r) => { resolveFresh = r; }),
    icon: () => '', escapeHtml, pluralize,
  });
  fns.openLifecycle('delete', state.domains[0]);
  const before = fns.renderLifecycleCard();
  ok(!/4 pages/.test(before) && /every page in it/.test(before),
    '3.1 while the count is being read, the stale row\'s "4 pages" is NOT quoted', before.match(/removes[^.]*/)?.[0]);
  resolveFresh({ slug: 'a', pageCount: 7 });
  await tick(); await tick();
  const after = fns.renderLifecycleCard();
  ok(/all 7 pages in it/.test(after), '3.2 once read, the FRESH count is quoted (7, not the row\'s 4)', after.match(/removes[^.]*/)?.[0]);

  fns.openLifecycle('delete', state.domains[0]);
  resolveFresh(null);
  await tick(); await tick();
  const failedRead = fns.renderLifecycleCard();
  ok(!/\d+ pages?/.test(failedRead.match(/removes[^.]*/)?.[0] || '') && /every page in it/.test(failedRead),
    '3.3 a failed read quotes no number at all — never the stale one');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. F2/F3 — lastWriteReading');
{
  const { lastWriteReading } = sandbox(['lastWriteReading'], { formatDayAge });
  const now = Date.now();
  const d = new Date(now);
  const todayLocal = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const ing = lastWriteReading({ lastIngestDate: todayLocal, lastIngestKind: 'ingest' }, now);
  ok(ing.meta === 'last ingest today' && ing.tile === 'today', '4.1 an ingest dated today reads "today" — day precision', JSON.stringify(ing));
  ok(!/hour|min/.test(JSON.stringify(ing)), '4.2 no hour/minute precision is claimed from a bare date');
  ok(ing.tile === formatDayAge(todayLocal, now), '4.3 the tile and the sidebar (formatDayAge) cannot disagree');
  const comp = lastWriteReading({ lastIngestDate: todayLocal, lastIngestKind: 'compile' }, now);
  ok(comp.meta === 'last compile today', '4.4 a compile is called a compile, not an ingest', comp.meta);
  ok(comp.tile === '—' && /compile/.test(comp.tileName), '4.5 SOURCES shows no ingest age over a compile, and its name says why');
  const unk = lastWriteReading({ lastIngestDate: todayLocal, lastIngestKind: null }, now);
  ok(unk.meta === 'last write today', '4.6 an unknown kind is the neutral "last write"');
  const none = lastWriteReading({ lastIngestDate: null }, now);
  ok(none.meta === 'nothing ingested yet' && none.tile === 'nothing yet', '4.7 a domain never written to');
  // The render sites use it, not relTime on the date.
  ok(!/relTime\(domain\.lastIngestDate\)|relTime\(jumps\.lastIngest\)/.test(SRC), '4.8 no render site feeds a bare date to relTime any more');
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. F4 — the duplicate-scan confirm and the ceiling');
{
  const { semanticScanConfirmText } = sandbox(['semanticScanConfirmText'], {});
  const over = semanticScanConfirmText({ candidatePairs: 180, totalCandidates: 180, truncated: false,
    estimatedTokens: 72000, costCeilingTokens: 50000 }, 'gemini/flash', '$0.01');
  ok(over.refused === true, '5.1 72,000 estimated over a 50,000 ceiling is REFUSED before the click');
  ok(/72,000/.test(over.body) && /50,000/.test(over.body) && /will not start/.test(over.body),
    '5.2 the refusal names both figures and says it will not start', over.body);
  ok(!/Estimated cost \$/.test(over.body), '5.3 no price is offered for a run that cannot happen');
  const under = semanticScanConfirmText({ candidatePairs: 100, totalCandidates: 100, truncated: false,
    estimatedTokens: 40000, costCeilingTokens: 50000 }, 'gemini/flash', '$0.01');
  ok(under.refused === false && /Estimated cost \$0\.01/.test(under.body), '5.4 CONTROL — under the ceiling it is the ordinary priced confirm');
  const capped = semanticScanConfirmText({ candidatePairs: 500, totalCandidates: 2300, truncated: true, maxPairs: 500,
    estimatedTokens: 200000, costCeilingTokens: 200000 }, 'x', '$0.03');
  ok(/capped at your 500-pair limit/.test(capped.body) && !/pre-filtered locally from/.test(capped.body),
    '5.5 a capped list names the user\'s max-pairs setting, not a "local pre-filter"', capped.body);
  ok(capped.refused === false, '5.6 exactly AT the ceiling runs (the server refuses only when over)');

  // The card: a refused confirm has no yes button.
  const state = { confirm: { title: 't', body: 'b', refused: true, settingsLabel: 'Open scan limits', confirmLabel: null } };
  const { renderConfirmCard } = sandbox(['renderConfirmCard'], { state, escapeHtml });
  const html = renderConfirmCard();
  ok(!/dm-confirm-yes/.test(html) && /dm-confirm-settings/.test(html) && /Open scan limits/.test(html),
    '5.7 the refused card has no Scan button, and one door to the limits');
  state.confirm = { title: 't', body: 'b', confirmLabel: 'Scan now' };
  ok(/dm-confirm-yes[^>]*>Scan now/.test(renderConfirmCard()), '5.8 CONTROL — an ordinary confirm keeps its yes button');
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. F4 — the two AI Health defaults agree');
{
  ok(DEFAULT_AI_HEALTH.costCeilingTokens >= DEFAULT_AI_HEALTH.semanticDupeMaxPairs * EST_TOKENS_PER_PAIR,
    `6.1 default ceiling ${DEFAULT_AI_HEALTH.costCeilingTokens} admits a full default-cap scan (${DEFAULT_AI_HEALTH.semanticDupeMaxPairs} × ${EST_TOKENS_PER_PAIR})`);
  ok(SEMANTIC_DUPE_DEFAULT_CAP === DEFAULT_AI_HEALTH.semanticDupeMaxPairs, '6.2 health.js\'s function default cap is config\'s default');
  const s = getAiHealthSettings();
  ok(s.costCeilingTokens === DEFAULT_AI_HEALTH.costCeilingTokens && s.semanticDupeMaxPairs === DEFAULT_AI_HEALTH.semanticDupeMaxPairs,
    '6.3 a fresh install reads those defaults');
  // BEHAVIOUR: scanSemanticDuplicates with no ceiling passed uses config's,
  // not a second literal — a 3-pair domain is never refused by a default.
  const name = 'zz-ceiling';
  const wiki = path.join(DOMAINS_DIR, name, 'wiki');
  mkdirSync(path.join(wiki, 'entities'), { recursive: true });
  writeFileSync(path.join(DOMAINS_DIR, name, 'CLAUDE.md'), '# t\n');
  let threw = null;
  try {
    await scanSemanticDuplicates(name, { costCeilingTokens: 1, generateText: async () => ({ text: '[]' }) }, () => {});
  } catch (e) { threw = e; }
  ok(!threw || threw.code !== 'OVER_COST_CEILING', '6.4 CONTROL — an empty domain (0 pairs) is never over any ceiling', threw && threw.message);
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. F5 — the Dismissed group counts records');
{
  const state = { expandedGroups: new Set(), dismissedRecords: null };
  const fns = sandbox(['renderIssueGroups', 'renderDismissedGroup'], {
    state, escapeHtml, icon: () => '', gatedLoader: () => '', loadGate: null,
    HEALTH_CATEGORIES: [], renderIssueGroup: () => '', describeDismissed: (r) => r.type,
  });
  const report = { counts: { dismissed: 0 }, dismissedRecords: 3 };
  const html = fns.renderIssueGroups(report, false, false);
  ok(/dm-group-dismissed/.test(html) && /dm-group-pill">3</.test(html),
    '7.1 three records (say, semantic Skips) with 0 hidden issues still render the group, pill 3', html);
  const old = fns.renderIssueGroups({ counts: { dismissed: 2 } }, false, false);
  ok(/dm-group-pill">2</.test(old), '7.2 an older server without the record count falls back to the old figure');
  state.expandedGroups.add('dismissed');
  state.dismissedRecords = [{ type: 'a' }, { type: 'b' }, { type: 'c' }, { type: 'd' }];
  ok(/dm-group-pill">4</.test(fns.renderIssueGroups(report, false, false)), '7.3 an open, loaded list counts itself');
  ok(/'hidden by a dismissal'/.test(SRC) && !/key: 'dismissed', value: report\.counts\.dismissed/.test(SRC),
    '7.4 the scan monitor names its figure as hidden issues, not "dismissed"');

  // The route sends the record count.
  const { default: router } = await import(path.join(REPO, 'src/routes/health.js'));
  const name = 'zz-dismiss';
  const wiki = path.join(DOMAINS_DIR, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(DOMAINS_DIR, name, 'CLAUDE.md'), '# t\n');
  writeFileSync(path.join(wiki, 'entities', 'a.md'), '# A\n');
  writeFileSync(path.join(wiki, 'entities', 'b.md'), '# B\n');
  await addDismissal(name, 'semanticDupe', { slugA: 'a', folderA: 'entities', slugB: 'b', folderB: 'entities' });
  const layer = router.stack.find((l) => l.route && l.route.path === '/:domain' && l.route.methods.get);
  let body = null;
  await layer.route.stack[0].handle({ params: { domain: name }, query: {}, body: {} },
    { status() { return this; }, json(b) { body = b; return this; } });
  ok(body && body.dismissedRecords === 1, '7.5 GET /api/health/:domain carries dismissedRecords (a semantic Skip counts)', JSON.stringify(body && { d: body.dismissedRecords, c: body.counts }));
  ok(body && body.counts && body.counts.dismissed === 0, '7.6 …while counts.dismissed (hidden scan issues) is 0 — two different figures');
  ok(/state\.dismissedRecords = null;/.test(lift('skipSemanticPair')), '7.7 a Skip invalidates the loaded Dismissed list');
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. F6 — "Fix N safe issues" states the deletions');
{
  const state = {
    health: {
      brokenLinks: [], folderPrefixLinks: [], missingBacklinks: [{}],
      crossFolderDupes: [{ keep: 'x', remove: 'y' }],
      hyphenVariants: [{ files: ['a', 'b', 'c'] }],
    },
    confirm: null,
  };
  const extra = liftConst('DESTRUCTIVE_FIX_TYPES') +
    "const GIT_UNDO_NOTE = 'NOTE'; const GIT_UNDO_WARN = 'WARN';\n";
  const fns = sandbox(['countSafeFixable', 'deletedPageCount', 'safeFixDeletedPages', 'confirmFixSafe'], {
    state, pluralize, render: () => {}, myMountToken: 1, runFixSafe: () => {},
  }, extra);
  fns.confirmFixSafe('a');
  ok(/3 pages will be deleted/.test(state.confirm.body) && /WARN/.test(state.confirm.body),
    '8.1 1 cross-folder dupe + a 3-slug hyphen group = 3 pages deleted, with the hard warning', state.confirm.body);
  ok(state.confirm.confirmLabel === 'Fix and delete', '8.2 the button says it deletes');
  state.health.crossFolderDupes = []; state.health.hyphenVariants = [];
  fns.confirmFixSafe('a');
  ok(!/deleted/.test(state.confirm.body) && /NOTE/.test(state.confirm.body) && state.confirm.confirmLabel === 'Fix now',
    '8.3 CONTROL — with nothing destructive it is the soft note and "Fix now"');
}

// ═══════════════════════════════════════════════════════════════════════════
section('9. F7 — PROJECTS is the store\'s total');
{
  const rows = Array.from({ length: 200 }, (_, i) => ({ name: 'p' + i }));
  const state = { activeSlug: 'a', projects: null, cache: {} };
  const fns = sandbox(['activeProjects', 'loadProjects', 'projectCount'], {
    state, render: () => {}, isCurrentMount: () => true,
    fetchJSON: async () => ({ projects: rows, total: 240, truncated: true, canWrite: true }),
  });
  await fns.loadProjects('a', 1);
  ok(fns.projectCount() === 240, '9.1 240 projects read 240, not the 200 rows the route capped to', String(fns.projectCount()));
  ok(state.cache.a.projects.total === 240, '9.2 the session cache keeps it, so a domain switch back is still right');
}

// ═══════════════════════════════════════════════════════════════════════════
section('10. F8 — the PAGES tile when OTHER files exist');
{
  const state = { browse: { slug: 'a', loading: false, error: null, folder: 'all' }, activeSlug: 'a' };
  let captured = null;
  const fns = sandbox(['activeBrowse', 'renderStatCards'], {
    state, renderOverview: (o) => { captured = o; return ''; }, explainerLabel: () => '', explainerHtml: () => '',
    relTime: () => { throw new Error('relTime must not be reached'); },
  });
  fns.renderStatCards({ entities: 400, concepts: 5, summaries: 4, other: 3 }, 412, 1, null);
  const pages = captured.cards.find((c) => c.label === 'PAGES');
  ok(/409 listed pages/.test(pages.name) && /3 other files are not in the list/.test(pages.name),
    '10.1 PAGES 412 says the list holds 409 and 3 other files are not in it', pages.name);
  fns.renderStatCards({ entities: 400, concepts: 5, summaries: 4, other: 0 }, 409, 1, null);
  ok(/show every page in the list/.test(captured.cards.find((c) => c.label === 'PAGES').name), '10.2 CONTROL — no OTHER, the old promise is true and kept');
}

// ═══════════════════════════════════════════════════════════════════════════
section('11. F9 — staleHealthSlugs');
{
  const { staleHealthSlugs } = sandbox(['statsRowChanged', 'staleHealthSlugs'], {});
  const prev = [{ slug: 'a', pageCount: 1, lastIngestDate: '2026-09-01' }, { slug: 'b', pageCount: 2, lastIngestDate: '2026-09-01' }];
  const next = [{ slug: 'a', pageCount: 1, lastIngestDate: '2026-09-01' }, { slug: 'b', pageCount: 3, lastIngestDate: '2026-09-25' }, { slug: 'c', pageCount: 1 }];
  const out = staleHealthSlugs(prev, next);
  ok(out.join() === 'b', '11.1 only the domain whose stats moved is stale (a new domain has no dot to drop)', out.join());
  ok(/staleHealthSlugs\(state\.domains, nextRows\)/.test(lift('loadDomainsList')), '11.2 the list reload applies it');
}

// ═══════════════════════════════════════════════════════════════════════════
section('12. F10 — the compact cost badge is an estimate');
{
  const { costReadout } = sandbox(['formatUsd', 'costReadout'], { formatUsdHonest });
  ok(costReadout({ estimatedUsd: 0.03 }, { compact: true }) === '≈ $0.03', '12.1 the badge reads "≈ $0.03"', costReadout({ estimatedUsd: 0.03 }, { compact: true }));
  ok(costReadout({ estimatedUsd: 0.03 }) === '$0.03', '12.2 CONTROL — the full form (after "Estimated cost") is unprefixed');
}

// ═══════════════════════════════════════════════════════════════════════════
section('13. F11 — the semantic header');
{
  const src = lift('renderSemanticScanResult');
  ok(/'likely duplicate pair'/.test(src) && !/'candidate pair'\) \+ ' found'/.test(src),
    '13.1 the header counts likely duplicates, not "candidate pairs"');
  ok(/checked = ev\.candidatePairs/.test(lift('runSemanticScan')) && /\bchecked,/.test(lift('runSemanticScan')),
    '13.2 the scan\'s own start frame supplies "(of N checked)"');
}

// ═══════════════════════════════════════════════════════════════════════════
section('14. F12 — ages tick in the ticker\'s own words');
{
  const { relTime } = sandbox(['relTime'], { formatAge });
  const now = Date.now();
  for (const secs of [3, 90, 4000, 90000, 900000]) {
    const iso = new Date(now - secs * 1000).toISOString();
    ok(relTime(iso) === ageWordsFor(iso, Date.now()), `14.1 relTime and the ticker agree at ${secs}s ("${relTime(iso)}")`);
  }
  ok(relTime(undefined) === 'never' && relTime('garbage') === 'never', '14.2 an absent or unreadable time is "never", never "NaN days ago"');
  ok(/data-age-at="' \+ escapeHtml\(report\.scannedAt\)/.test(SRC), '14.3 the Scan row\'s age is a ticking [data-age-at] span');
  ok(/last save <span data-age-at="/.test(SRC), '14.4 a project\'s last save is a ticking span');
  ok(/subscribeAgeTicker\(/.test(SRC) && /unsubscribeAges\(\)/.test(SRC), '14.5 the view subscribes to the one clock and lets go on teardown');
}

// ═══════════════════════════════════════════════════════════════════════════
section('15. tray F8 — the merge preview cap');
{
  const name = 'zz-preview';
  const wiki = path.join(DOMAINS_DIR, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(DOMAINS_DIR, name, 'CLAUDE.md'), '# t\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  // Multibyte text: 4,000 characters of it are ~12 KB, which is why "4 KB" was wrong.
  const big = '## Key Facts\n\n' + Array.from({ length: 900 }, (_, i) => `- fact ${i} — ✓ déjà vu\n`).join('');
  writeFileSync(path.join(wiki, 'entities', 'keep.md'), '---\ntype: entity\n---\n\n# Keep\n\n' + big);
  writeFileSync(path.join(wiki, 'entities', 'gone.md'), '---\ntype: entity\n---\n\n# Gone\n\n## Key Facts\n\n- other\n');
  const p = await previewSemanticDuplicateMerge(name, { keepSlug: 'keep', keepFolder: 'entities', removeSlug: 'gone', removeFolder: 'entities' });
  ok(p.mergedPreviewCap === MERGED_PREVIEW_CAP_CHARS && p.mergedPreview.length === MERGED_PREVIEW_CAP_CHARS,
    '15.1 the server sends its cap, and the preview is cut at exactly that many characters');
  ok(Buffer.byteLength(p.mergedPreview, 'utf8') > 4096, '15.2 …which is more than 4 KB of UTF-8 here — the old label was false', String(Buffer.byteLength(p.mergedPreview, 'utf8')));

  const { renderSemanticPreview } = sandbox(['renderSemanticPreview'], { escapeHtml, icon: () => '', pluralize });
  const html = renderSemanticPreview({ data: p });
  ok(/MERGED CONTENT \(FIRST 4,000 CHARACTERS\)/.test(html) && !/4 KB/.test(html), '15.3 the label names the server\'s cap in characters');
  ok(/…\(truncated\)/.test(html), '15.4 a longer merge is marked truncated');
  const short = renderSemanticPreview({ data: { ...p, mergedPreview: 'abc', mergedLength: 3 } });
  ok(!/truncated/.test(short), '15.5 CONTROL — a merge that fits is not marked truncated');
  ok(!/> 4000/.test(lift('renderSemanticPreview')), '15.6 the view no longer retypes 4000');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
