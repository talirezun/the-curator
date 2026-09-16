#!/usr/bin/env node
/**
 * scripts/test-semantic-chained-merges.js — OFFLINE
 *
 * Semantic-duplicate merges CHAIN, and the server has to say so.
 *
 * ── THE REPORTED DEFECT ───────────────────────────────────────────────────
 *
 * A user scanned a domain ("25 candidate pairs found"), previewed and merged
 * several pairs one at a time, and then hit a card he could not get past:
 * Preview on `entities/claude-opus-5 → entities/claude-opus` failed with
 * "Could not build a preview — Both pages must exist to preview a merge",
 * while Merge stayed disabled behind "Preview required before Merge". A dead
 * end: the only escape was to re-run a PAID LLM scan.
 *
 * The cause is structural, not a typo. `findSemanticCandidatePairs` emits
 * EVERY pair above threshold, so a family of near-identical pages is a dense
 * CLIQUE — 8 versions produce 28 pairs and every page appears in 7 of them.
 * `fixSemanticDuplicate` rm()s the loser and tells nothing else, so the
 * siblings that still name the deleted page became unmergeable for a reason
 * the user could not act on, phrased as though the pair were malformed.
 *
 * ── WHAT THIS SUITE PINS ──────────────────────────────────────────────────
 *
 *   1. A stale preview NAMES the missing page and keeps the stable substring
 *      `no longer exists` (/next's semanticStaleFromError keys on it).
 *   2. fixIssue on a stale pair returns fixed:0 with a REASON and the page —
 *      not a bare false that collapses five outcomes into one.
 *   3. The batch reports `stale` (a page is gone) separately from `skipped`
 *      (this pair never made sense), because `skipped` is the word the UI
 *      uses for the user's own Skip.
 *   4. NEGATIVE CONTROL: a pair whose pages both exist still previews and
 *      still merges. A guard that refuses everything is as broken as one
 *      that refuses nothing.
 *   5. The route maps the stale preview to 409 (a refusal), not 500.
 *
 * ── Method ────────────────────────────────────────────────────────────────
 *
 * A real on-disk fixture domain (A / A2 / A3, two pairs that share A2),
 * driven through the REAL exported functions. No mocks, no source regexes:
 * every assertion is about what the code DOES. Isolated with
 * __setDomainsDirOverride (in-process, domains-only) AND
 * CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR, set before any app
 * module is imported — nothing here reads or writes the real domains folder
 * or the real .curator-config.json, and §0 fingerprints that file (sha256 +
 * size, never mtime) to prove it.
 *
 * ── NOT ENFORCED ──────────────────────────────────────────────────────────
 *
 *   • No HTTP server. §5 drives the route's HANDLER directly with fake
 *     req/res objects; it does not prove Express wiring.
 *   • Nothing here tests the /next client's cascade — that is
 *     scripts/test-next-semantic-gate.js §10-§12.
 *   • Nothing here asserts the LLM's duplicate judgement is correct.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ── Isolation, BEFORE any app module is imported ───────────────────────────
const USER_DIR = mkdtempSync(path.join(os.tmpdir(), 'curator-chained-user-'));
const DOMAINS_DIR = mkdtempSync(path.join(os.tmpdir(), 'curator-chained-domains-'));
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DIR;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;

// Fingerprint the REAL config before anything can touch it. sha256 + size +
// existence only — never mtime: the maintainer's own running app rewrites
// that file during an ordinary Settings action, and an mtime comparison
// turns that into a false "isolation is broken" (v3.1.1's recorded lesson).
const REAL_CONFIG = path.join(REPO, '.curator-config.json');
function fingerprint(file) {
  if (!existsSync(file)) return { exists: false };
  const buf = readFileSync(file);
  return { exists: true, size: statSync(file).size, sha: createHash('sha256').update(buf).digest('hex') };
}
const CONFIG_BEFORE = fingerprint(REAL_CONFIG);

const { __setDomainsDirOverride } = await import(path.join(REPO, 'src/brain/config.js'));
__setDomainsDirOverride(DOMAINS_DIR);

const {
  fixIssue,
  previewSemanticDuplicateMerge,
  fixSemanticDuplicatesBatch,
} = await import(path.join(REPO, 'src/brain/health.js'));

let passed = 0, failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }

// ── Fixture: a three-page version family, exactly the reported shape ───────
function page(title, body = '') {
  return `---\ntype: entity\ntags: [type/entity]\n---\n\n# ${title}\n\n## Key Facts\n\n- a fact about ${title}\n${body}`;
}

let domainSeq = 0;
function mkDomain(files) {
  const name = 'chain' + (++domainSeq);
  const wiki = path.join(DOMAINS_DIR, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(DOMAINS_DIR, name, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(wiki, rel), body);
  return { name, wiki };
}

// A/A2/A3 = the three versions. Two pairs SHARE A2, which is what makes the
// chain: merging pair 1 deletes A2, and pair 2 still names it.
function familyFixture() {
  return mkDomain({
    'entities/claude-opus.md': page('Claude Opus', '- [[claude-opus-5]] is the newer one\n'),
    'entities/claude-opus-5.md': page('Claude Opus 5'),
    'entities/claude-opus-5-1m.md': page('Claude Opus 5 1M'),
    'entities/hub.md': page('Hub', '- [[claude-opus-5]]\n- [[claude-opus-5-1m]]\n'),
  });
}
const PAIR_1 = { keepSlug: 'claude-opus', keepFolder: 'entities', removeSlug: 'claude-opus-5', removeFolder: 'entities' };
// Pair 2 names the page pair 1 deletes, on its KEEP side.
const PAIR_2 = { keepSlug: 'claude-opus-5', keepFolder: 'entities', removeSlug: 'claude-opus-5-1m', removeFolder: 'entities' };
// Pair 3 names it on its REMOVE side.
const PAIR_3 = { keepSlug: 'claude-opus-5-1m', keepFolder: 'entities', removeSlug: 'claude-opus-5', removeFolder: 'entities' };

// ═══════════════════════════════════════════════════════════════════════════
section('0. Isolation');
ok(DOMAINS_DIR.startsWith(os.tmpdir()), 'the domains dir is a tempdir, not the repo');
ok(!existsSync(path.join(REPO, 'domains', 'chain1')), 'no fixture domain was created under the repo\'s domains/');

// ═══════════════════════════════════════════════════════════════════════════
section('1. A stale preview NAMES the page that is gone');
{
  const d = familyFixture();
  // Merge pair 1 for real — this is the chain, not a simulated one.
  const first = await fixIssue(d.name, 'semanticDupe', PAIR_1);
  ok(first.fixed === 1, '1.0 precondition: pair 1 merges (claude-opus-5 → claude-opus)', JSON.stringify(first));
  ok(!existsSync(path.join(d.wiki, 'entities/claude-opus-5.md')), '1.1 …and really deletes the page pair 2 still names');

  let err = null;
  try { await previewSemanticDuplicateMerge(d.name, PAIR_2); } catch (e) { err = e; }
  ok(!!err, '1.2 previewing the sibling pair still refuses');
  ok(!!err && /entities\/claude-opus-5/.test(err.message),
     '1.3 THE FIX — the refusal NAMES the missing folder/slug', err && err.message);
  ok(!!err && / no longer exists/.test(err.message),
     '1.4 …and carries the stable `no longer exists` substring the client keys on', err && err.message);
  ok(!!err && !/Both pages must exist/.test(err.message),
     '1.5 …and is no longer the generic "Both pages must exist to preview a merge"', err && err.message);
  ok(!!err && err.code === 'SEMANTIC_PAIR_STALE', '1.6 it is tagged as a refusal, machine-readably');
  ok(!!err && err.status === 409, '1.7 …and carries 409, not 500');
  ok(!!err && err.missing === 'entities/claude-opus-5', '1.8 …and the missing page as a field, not only in prose');

  // The REMOVE side going missing is the other half of the same fact.
  let err3 = null;
  try { await previewSemanticDuplicateMerge(d.name, PAIR_3); } catch (e) { err3 = e; }
  ok(!!err3 && /entities\/claude-opus-5 no longer exists/.test(err3.message),
     '1.9 the same holds when the missing page is the REMOVE side', err3 && err3.message);
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. fixIssue on a stale pair reports a REASON, not a bare refusal');
{
  const d = familyFixture();
  await fixIssue(d.name, 'semanticDupe', PAIR_1);

  const r2 = await fixIssue(d.name, 'semanticDupe', PAIR_2);
  ok(r2.fixed === 0, '2.1 the stale pair is not merged', JSON.stringify(r2));
  ok(r2.total === 1, '2.2 …and still reports total:1 (the existing caller contract is untouched)');
  ok(r2.reason === 'keep-page-missing',
     '2.3 THE FIX — the reason says WHICH side is gone (keep-page-missing)', JSON.stringify(r2));
  ok(r2.missing === 'entities/claude-opus-5',
     '2.4 …and names the page, so a caller never parses it back out of prose', JSON.stringify(r2));

  const r3 = await fixIssue(d.name, 'semanticDupe', PAIR_3);
  ok(r3.reason === 'remove-page-missing' && r3.missing === 'entities/claude-opus-5',
     '2.5 the REMOVE side gone is its own distinct reason', JSON.stringify(r3));

  // A pair that never made sense must NOT be reported as stale — otherwise
  // "already resolved" would absorb real validation failures.
  const bad = await fixIssue(d.name, 'semanticDupe',
    { keepSlug: 'claude-opus', keepFolder: 'summaries', removeSlug: 'hub', removeFolder: 'entities' });
  ok(bad.fixed === 0 && bad.reason === 'semantic-pair-invalid',
     '2.6 NEGATIVE CONTROL — an invalid pair (summaries/) is invalid, never "already resolved"', JSON.stringify(bad));
  ok(bad.missing === undefined, '2.7 …and names no missing page, because none is missing');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. The batch splits `stale` from `skipped`');
{
  const d = familyFixture();
  const progress = [];
  const res = await fixSemanticDuplicatesBatch(d.name, [
    PAIR_1,                                   // merges, deleting claude-opus-5
    PAIR_2,                                   // now stale — its keep page is gone
    { keepSlug: 'hub', keepFolder: 'summaries', removeSlug: 'nope', removeFolder: 'entities' }, // invalid folder
  ], (p) => progress.push(p));

  ok(res.results[0].status === 'merged', '3.1 pair 1 merges', JSON.stringify(res.results[0]));
  ok(res.results[1].status === 'stale',
     '3.2 THE FIX — a pair the batch itself invalidated is `stale`, not `skipped`', JSON.stringify(res.results[1]));
  ok(res.results[1].missing === 'entities/claude-opus-5',
     '3.3 …and the result names the page that went', JSON.stringify(res.results[1]));
  ok(res.results[2].status === 'skipped',
     '3.4 NEGATIVE CONTROL — a genuinely invalid pair is still `skipped`, so the split means something',
     JSON.stringify(res.results[2]));
  ok(res.merged === 1 && res.stale === 1 && res.skipped === 1 && res.errors === 0,
     '3.5 the counts are four disjoint buckets', JSON.stringify({ m: res.merged, st: res.stale, sk: res.skipped, e: res.errors }));
  ok(res.merged + res.stale + res.skipped + res.errors === res.total,
     '3.6 …and they still sum to total');
  ok(progress.map((p) => p.status).join(',') === 'merged,stale,skipped',
     '3.7 the SSE progress frames carry the same three statuses', progress.map((p) => p.status).join(','));
  ok(progress[1].missing === 'entities/claude-opus-5',
     '3.8 …and the stale frame carries the missing page, so the UI can cascade on it');

  // The truthiness trap: fixSemanticDuplicate now returns an OBJECT on a
  // refusal, and `{ok:false}` is truthy. If the batch ever reads it without
  // normaliseFixOutcome, a refused pair reports as merged.
  ok(res.merged === 1, '3.9 a refused pair is NEVER counted as merged ({ok:false} is truthy)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. NEGATIVE CONTROL — a live pair still previews and still merges');
{
  const d = familyFixture();
  const plan = await previewSemanticDuplicateMerge(d.name, PAIR_1);
  ok(plan.keepPath === 'entities/claude-opus.md' && plan.removePath === 'entities/claude-opus-5.md',
     '4.1 a pair whose pages both exist previews normally', JSON.stringify({ k: plan.keepPath, r: plan.removePath }));
  ok(plan.affectedCount >= 1 && plan.totalLinksRewritten >= 1,
     '4.2 …with the real link-rewrite count (the preview is not a stub)', JSON.stringify({ f: plan.affectedCount, l: plan.totalLinksRewritten }));

  const r = await fixIssue(d.name, 'semanticDupe', PAIR_1);
  ok(r.fixed === 1, '4.3 …and it merges', JSON.stringify(r));
  ok(!existsSync(path.join(d.wiki, 'entities/claude-opus-5.md')), '4.4 the duplicate is deleted');
  ok(r.reason === undefined && r.missing === undefined, '4.5 a successful fix reports no reason and no missing page');
  const hub = readFileSync(path.join(d.wiki, 'entities/hub.md'), 'utf8');
  ok(hub.includes('[[claude-opus]]') && !hub.includes('[[claude-opus-5]]'),
     '4.6 inbound links were repointed — the early return did not skip the repoint', hub);
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. The preview ROUTE answers 409, not 500');
{
  // The route handler is driven directly (no HTTP server): find it on the
  // router's own stack by path, then call it with fake req/res.
  const routerMod = await import(path.join(REPO, 'src/routes/health.js'));
  const router = routerMod.default;
  const layer = router.stack.find((l) => l.route && l.route.path === '/:domain/semantic-dupes/preview');
  ok(!!layer, '5.0 the preview route is registered');
  const handler = layer && layer.route.stack[layer.route.stack.length - 1].handle;

  const d = familyFixture();
  await fixIssue(d.name, 'semanticDupe', PAIR_1);

  function fakeRes() {
    const out = { code: 200, body: null };
    return {
      out,
      status(c) { out.code = c; return this; },
      json(b) { out.body = b; return this; },
    };
  }

  const resStale = fakeRes();
  await handler({ params: { domain: d.name }, body: { issue: PAIR_2 } }, resStale);
  ok(resStale.out.code === 409,
     '5.1 THE FIX — a stale pair is a REFUSAL (409), not a server failure (500)', String(resStale.out.code));
  ok(!!resStale.out.body && / no longer exists/.test(resStale.out.body.error || ''),
     '5.2 …and the named message reaches the client verbatim', JSON.stringify(resStale.out.body));
  // MEASURED, not assumed: 5.1 alone does NOT pin the route's own branch.
  // The error carries `status: 409` itself, so the pre-existing
  // `res.status(err.status || 500)` fallback answers 409 too — a mutation
  // that deletes the branch leaves 5.1 green. These two are what fail,
  // because `code` and `missing` exist only on the explicit branch (which
  // also stops the refusal being logged as a server error).
  ok(!!resStale.out.body && resStale.out.body.code === 'SEMANTIC_PAIR_STALE',
     '5.3 …tagged machine-readably by the route\'s own refusal branch', JSON.stringify(resStale.out.body));
  ok(!!resStale.out.body && resStale.out.body.missing === 'entities/claude-opus-5',
     '5.4 …with the missing page as a structured field');

  const resOk = fakeRes();
  await handler({ params: { domain: d.name }, body: { issue: { keepSlug: 'claude-opus', keepFolder: 'entities', removeSlug: 'claude-opus-5-1m', removeFolder: 'entities' } } }, resOk);
  ok(resOk.out.code === 200 && resOk.out.body && resOk.out.body.ok === true,
     '5.5 NEGATIVE CONTROL — a live pair still answers 200', JSON.stringify(resOk.out.code));

  const resBad = fakeRes();
  await handler({ params: { domain: d.name }, body: { issue: { keepSlug: 'x', keepFolder: 'summaries', removeSlug: 'y', removeFolder: 'entities' } } }, resBad);
  ok(resBad.out.code === 500,
     '5.6 NEGATIVE CONTROL — a genuinely invalid pair is still a 500, so the 409 is a real distinction',
     String(resBad.out.code));
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. The real config was never touched');
{
  const after = fingerprint(REAL_CONFIG);
  ok(after.exists === CONFIG_BEFORE.exists, '6.1 .curator-config.json existence unchanged');
  ok(after.sha === CONFIG_BEFORE.sha && after.size === CONFIG_BEFORE.size,
     '6.2 …and its sha256 + size are identical (mtime deliberately not compared)');
}

console.log('\n' + '='.repeat(62));
console.log(`Passed: ${passed}   Failed: ${failed}`);
__setDomainsDirOverride(null);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ chained semantic merges report themselves honestly');
