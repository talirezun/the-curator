#!/usr/bin/env node
/**
 * test-summary-backlink-sync.js — OFFLINE suite for syncSummaryEntities() and
 * injectSummaryBacklinks() in src/brain/files.js.
 *
 * WHY THIS SUITE EXISTS — a measured hole, not a speculative one.
 *
 * CLAUDE.md calls syncSummaryEntities "THE KEY POST-WRITE STEP". It is the
 * reconciliation that makes the wiki a GRAPH rather than a pile of pages:
 * after an ingest it injects EVERY written entity AND concept slug into the
 * summary's "Entities Mentioned" section, then re-fires injectSummaryBacklinks
 * with the complete list so each of those pages gets a [[summaries/<slug>]]
 * backlink in its Related section. It exists because of a documented,
 * every-ingest LLM compliance failure: "'Entities Mentioned' lists 5-7
 * entities while 20-30 entity pages are written." Commits 8f77d33, f4cb825
 * and b2fa124 were all written to fix this class.
 *
 * It is reached by FOUR write paths — ingest.js:2694, compile.js:507,
 * mcp/tools/compile.js:616, sharedbrain.js:1092 — and, before this suite, had
 * ZERO offline assertions. Measured on a repo copy: replacing the entire body
 * of syncSummaryEntities() with `return;` left the offline suite byte-identical
 * to baseline. Not one assertion moved.
 *
 * AND MORE LIVE GATING WOULD NOT HAVE CLOSED IT. The expensive live-LLM
 * harness scripts/test-ingest-deep.js has a Q6 check for exactly this
 * property, but Q6 reports through warn() (test-ingest-deep.js:137), and
 * warn() — unlike fail() — does NOT set exitCode. So even promoting that suite
 * to CI would not deterministically catch the regression. Its Q4 (the section
 * exists at all) is a hard assert, but only fires when the LLM omits the
 * section entirely, which CLAUDE.md classes as "Occasional (large docs)".
 * That is why this suite is offline, deterministic and free: the hole cannot
 * be closed by paying a provider more often.
 *
 * WHAT IS PINNED — an INVARIANT, deliberately, not a list of cases:
 *
 *   entitiesMentioned(summary)  ==  { pages holding a backlink to summary }
 *
 * SET EQUALITY in both directions, not one-directional containment. Testing
 * the invariant rather than the branch is what catches a door the fix was
 * never written against: containment-only would stay green if the sync
 * injected slugs it should not have, or backlinked pages it never wrote.
 *
 * §1  the reciprocal invariant, modelling the real failure (summary lists 2
 *     of 7; sync must repair to 7) — and deliberately written SUMMARY FIRST,
 *     so no entity file exists when writePage runs its own backlink pass.
 *     syncSummaryEntities is then the ONLY thing that can create those edges.
 * §2  idempotency — running twice must not duplicate bullets. Asserted on the
 *     OUTCOME (bullet counts on disk), never on deduplicateBulletSections
 *     having been called.
 * §3  a target page with NO "## Related" section must have one CREATED
 *     (commit b2fa124, and the 'im' multiline-regex fix beside it).
 * §4  a summary missing "Entities Mentioned" ENTIRELY gets the section added
 *     (the documented truncated-summary case).
 * §5  the canonical-path contract: writePage returns canonPath, which may
 *     differ from the requested path (Pass A title-prefix strip). The summary
 *     must reference the CANONICAL slug and the CANONICAL page must hold the
 *     backlink — feeding the original LLM-proposed paths is the bug this pins.
 * §6  the concepts fallback — injectSummaryBacklinks checks entities/ first
 *     and falls back to concepts/; a concept-only slug must still be backlinked.
 * §7  NEGATIVE CONTROL — a page that exists on disk but was NOT written this
 *     ingest must be in neither set. Without this, a suite that failed
 *     everything, or an over-broad injection, could be mistaken for coverage.
 *
 * ── NOT INDEPENDENTLY PINNED, measured rather than assumed ─────────────
 * `deduplicateBulletSections(stripped)` inside syncSummaryEntities is
 * DEFENCE IN DEPTH, not independently load-bearing, and §2 does not pin it
 * alone. Replacing that call with a pass-through leaves this suite at
 * 50/0 GREEN, because injectBulletsIntoSection's own `seen`/dedupKey filter
 * already suppressed the duplicate one layer earlier. Chased rather than
 * reported as coverage (the v3.4.0 method): defeating BOTH layers in the
 * same run takes §2 RED with behavioural diagnostics — Entities Mentioned
 * 3 → 5 bullets across two syncs, alpha's backlinks 2 → 5. So §2 genuinely
 * measures the deduplication OUTCOME rather than the presence of a call;
 * what it cannot tell you is which of the two layers produced it. Do not
 * read a green §2 as proof that the safety-net line is still there.
 *
 * The section parser below is an INDEPENDENT, deliberately-dumb
 * reimplementation. It does not import extractBulletsFromSection from the
 * module under test — a checker that shares its subject's parser cannot
 * observe that parser being wrong.
 *
 * Isolated via CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR, set
 * BEFORE any app module is imported, plus __setDomainsDirOverride() belt-and-
 * braces. NEVER process.env.DOMAINS_PATH — see CLAUDE.md's "Active Development
 * Decisions": that var loses to a configured domainsPath and would silently
 * no-op on a real install, which is how suites once wrote fixtures into the
 * maintainer's real domains/ folder.
 *
 * Run with:  node scripts/test-summary-backlink-sync.js
 * Exit code 0 if all green; non-zero on any failure.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// ── Isolation FIRST — before any app module is imported ──────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-blsync-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
for (const d of [TMP_USER, TMP_DOMAINS]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.DOMAINS_PATH;

const { __setDomainsDirOverride, getDomainsDir } = await import('../src/brain/config.js');
__setDomainsDirOverride(TMP_DOMAINS);

const {
  writePage, syncSummaryEntities, injectSummaryBacklinks,
  createDomain, wikiPath,
} = await import('../src/brain/files.js');

// ── Harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function bad(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err}`); }
function assert(cond, label, err) { cond ? ok(label) : bad(label, err || 'assertion failed'); }
function section(name) { console.log(`\n── ${name} ──`); }

/** Sorted, comma-joined rendering of a Set, for readable failure output. */
const show = (s) => `{${[...s].sort().join(', ')}}`;
const setEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

// ── Independent section parser (NOT the module under test's) ─────────────
// Deliberately dumb: walk lines, track the current `## Heading`, collect
// `- ` bullets under the requested one. Case-insensitive heading match to
// mirror the wiki's real tolerance, but nothing else is shared with files.js.
function bulletsUnder(content, sectionName) {
  const out = [];
  let inSection = false;
  for (const line of content.split('\n')) {
    if (/^##\s+/.test(line)) {
      inSection = line.replace(/^##\s+/, '').trim().toLowerCase() === sectionName.toLowerCase();
      continue;
    }
    if (inSection && line.startsWith('- ')) out.push(line);
  }
  return out;
}
/** Every [[target]] appearing in a list of bullet lines, folder prefix intact. */
function linkTargets(bullets) {
  const out = [];
  for (const b of bullets) {
    for (const m of b.matchAll(/\[\[([^\]|#\n]+)/g)) out.push(m[1].trim());
  }
  return out;
}
function headingCount(content, sectionName) {
  return content.split('\n').filter(l =>
    /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase() === sectionName.toLowerCase()
  ).length;
}

// ── Fixture helpers ──────────────────────────────────────────────────────
let domainSeq = 0;
async function freshDomain(name) {
  const slug = `zz-blsync-${name}-${++domainSeq}`;
  await createDomain(slug, `Backlink Sync ${name}`, 'offline fixture', 'general');
  return slug;
}
const readWiki = (domain, rel) => readFileSync(path.join(wikiPath(domain), rel), 'utf8');

/** A plain entity/concept page WITH a Related section already present. */
const pageWithRelated = (title) =>
  `# ${title}\n\n## Summary\n${title} is a fixture page.\n\n## Key Facts\n- A fact about ${title}.\n\n## Related\n`;
/** A page with NO Related section at all — §3's subject. */
const pageWithoutRelated = (title) =>
  `# ${title}\n\n## Summary\n${title} is a fixture page with no Related section.\n\n## Key Facts\n- A fact about ${title}.\n`;

/**
 * Collect, from disk, the set of entity/concept slugs whose Related section
 * holds a backlink to the given summary. This is the RIGHT-HAND side of the
 * invariant, read independently of anything the sync reported.
 */
function backlinkersOf(domain, summarySlug) {
  const found = new Set();
  for (const folder of ['entities', 'concepts']) {
    const dir = path.join(wikiPath(domain), folder);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const content = readFileSync(path.join(dir, f), 'utf8');
      const related = linkTargets(bulletsUnder(content, 'Related'));
      if (related.includes(`summaries/${summarySlug}`)) found.add(f.slice(0, -3));
    }
  }
  return found;
}
/** The LEFT-HAND side: bare slugs listed under the summary's Entities Mentioned. */
function mentionedIn(domain, summaryRel) {
  const content = readWiki(domain, summaryRel);
  return new Set(
    linkTargets(bulletsUnder(content, 'Entities Mentioned')).map(t => t.split('/').pop())
  );
}

try {
  // ══ §0 — isolation sanity, before a single byte is written ═════════════
  section('§0 Isolation');
  assert(getDomainsDir() === path.resolve(TMP_DOMAINS),
    `#1: getDomainsDir() resolves to the tempdir, not the real domains/ (got ${getDomainsDir()})`);
  assert(!getDomainsDir().includes('second-brain/domains'),
    '#2: the resolved domains dir is not the maintainer\'s real one');

  // ══ §1 — THE RECIPROCAL INVARIANT ══════════════════════════════════════
  // Models the documented failure directly: the LLM writes a summary naming
  // only 2 entities while 7 pages are actually written.
  //
  // Written SUMMARY FIRST on purpose. writePage runs its own
  // injectSummaryBacklinks pass when it writes a summary (files.js:1135), but
  // at that moment none of the seven target files exist yet, so it cannot
  // create a single edge. Every backlink observed below is therefore
  // attributable to syncSummaryEntities and to nothing else.
  section('§1 The reciprocal invariant (entitiesMentioned == backlinkers)');
  {
    const d = await freshDomain('core');
    const SUMMARY = 'summaries/the-energy-report.md';
    const SUMMARY_SLUG = 'the-energy-report';

    const summaryBody =
      `# The Energy Report\n\n## Summary\nA report.\n\n` +
      `## Entities Mentioned\n- [[openai]]\n- [[data-centres]]\n\n## Notes\n`;
    const summaryRec = await writePage(d, SUMMARY, summaryBody);
    assert(summaryRec && summaryRec.canonPath === SUMMARY,
      `#1: summary written at its canonical path (got ${summaryRec && summaryRec.canonPath})`);

    const ENTITIES = ['openai', 'nvidia', 'iea', 'microsoft'];
    const CONCEPTS = ['data-centres', 'water-footprint', 'inference-cost'];
    const canonicalPaths = [summaryRec.canonPath];
    for (const s of ENTITIES) {
      const r = await writePage(d, `entities/${s}.md`, pageWithRelated(s));
      canonicalPaths.push(r.canonPath);
    }
    for (const s of CONCEPTS) {
      const r = await writePage(d, `concepts/${s}.md`, pageWithRelated(s));
      canonicalPaths.push(r.canonPath);
    }

    // Precondition: prove the corpus starts in the BROKEN state the sync exists
    // to repair. Without this, a green below could mean "nothing to do".
    const before = mentionedIn(d, SUMMARY);
    assert(before.size === 2,
      `#2: precondition — before the sync the summary names only 2 of 7 pages, the documented LLM failure (got ${before.size}: ${show(before)})`);
    const backlinksBefore = backlinkersOf(d, SUMMARY_SLUG);
    assert(backlinksBefore.size === 0,
      `#3: precondition — no page holds a backlink yet, so every edge below is attributable to the sync (got ${show(backlinksBefore)})`);

    await syncSummaryEntities(d, summaryRec.canonPath, canonicalPaths);

    const mentioned = mentionedIn(d, SUMMARY);
    const backlinkers = backlinkersOf(d, SUMMARY_SLUG);
    const expected = new Set([...ENTITIES, ...CONCEPTS]);

    // Requirement 1 — every ENTITY slug reaches Entities Mentioned.
    for (const s of ENTITIES) {
      assert(mentioned.has(s), `#4.${s}: entity "${s}" appears in Entities Mentioned after the sync`);
    }
    // Requirement 1, the half a refactor drops — CONCEPTS too. The filter in
    // syncSummaryEntities is `entities/ || concepts/`; narrowing it to
    // entities/ is a one-token edit with no other visible symptom.
    for (const s of CONCEPTS) {
      assert(mentioned.has(s), `#5.${s}: CONCEPT "${s}" appears in Entities Mentioned after the sync (concepts are explicitly in the contract)`);
    }
    // Requirement 2 — bidirectionality.
    for (const s of [...ENTITIES, ...CONCEPTS]) {
      assert(backlinkers.has(s), `#6.${s}: "${s}" carries [[summaries/${SUMMARY_SLUG}]] in its Related section`);
    }
    // Requirement 3 — SET EQUALITY, both directions.
    assert(setEq(mentioned, expected),
      `#7: Entities Mentioned is EXACTLY the set of written entity+concept pages — no page missing, none invented\n       expected ${show(expected)}\n       actual   ${show(mentioned)}`);
    assert(setEq(backlinkers, expected),
      `#8: the backlinking pages are EXACTLY the written entity+concept pages\n       expected ${show(expected)}\n       actual   ${show(backlinkers)}`);
    assert(setEq(mentioned, backlinkers),
      `#9: THE INVARIANT — entitiesMentioned(summary) == { pages backlinking to summary }\n       mentioned   ${show(mentioned)}\n       backlinkers ${show(backlinkers)}`);
  }

  // ══ §2 — IDEMPOTENCY ═══════════════════════════════════════════════════
  section('§2 Idempotency (running the sync twice must not duplicate bullets)');
  {
    const d = await freshDomain('idem');
    const SUMMARY = 'summaries/twice.md';
    const rec = await writePage(d, SUMMARY,
      `# Twice\n\n## Summary\nRun me twice.\n\n## Entities Mentioned\n- [[alpha]]\n`);
    const paths = [rec.canonPath];
    for (const s of ['alpha', 'beta']) {
      paths.push((await writePage(d, `entities/${s}.md`, pageWithRelated(s))).canonPath);
    }

    await syncSummaryEntities(d, rec.canonPath, paths);
    const afterFirst = readWiki(d, SUMMARY);
    const mentionedOnce = bulletsUnder(afterFirst, 'Entities Mentioned').length;
    const alphaOnce = bulletsUnder(readWiki(d, 'entities/alpha.md'), 'Related').length;

    await syncSummaryEntities(d, rec.canonPath, paths);
    const afterSecond = readWiki(d, SUMMARY);
    const mentionedTwice = bulletsUnder(afterSecond, 'Entities Mentioned').length;
    const alphaTwice = bulletsUnder(readWiki(d, 'entities/alpha.md'), 'Related').length;

    assert(mentionedOnce === 2, `#1: after one sync the summary lists exactly 2 pages (got ${mentionedOnce})`);
    assert(mentionedTwice === mentionedOnce,
      `#2: a SECOND sync adds no duplicate Entities Mentioned bullets (${mentionedOnce} → ${mentionedTwice})`);
    assert(alphaOnce === 1, `#3: alpha holds exactly one backlink after the first sync (got ${alphaOnce})`);
    assert(alphaTwice === alphaOnce,
      `#4: a SECOND sync adds no duplicate backlink to alpha (${alphaOnce} → ${alphaTwice})`);
    assert(headingCount(afterSecond, 'Entities Mentioned') === 1,
      '#5: the summary still has exactly ONE "## Entities Mentioned" heading (no section duplication)');
    assert(headingCount(readWiki(d, 'entities/alpha.md'), 'Related') === 1,
      '#6: alpha still has exactly ONE "## Related" heading');
  }

  // ══ §3 — SECTION CREATION ON THE TARGET PAGE ═══════════════════════════
  section('§3 A target page with no "## Related" gets one created (commit b2fa124)');
  {
    const d = await freshDomain('mkrelated');
    const rec = await writePage(d, 'summaries/creates.md',
      `# Creates\n\n## Summary\nS.\n\n## Entities Mentioned\n`);
    const bare = await writePage(d, 'entities/bare.md', pageWithoutRelated('bare'));

    const beforeContent = readWiki(d, 'entities/bare.md');
    assert(headingCount(beforeContent, 'Related') === 0,
      '#1: precondition — the target page genuinely has no "## Related" section before the sync');

    await syncSummaryEntities(d, rec.canonPath, [rec.canonPath, bare.canonPath]);

    const after = readWiki(d, 'entities/bare.md');
    assert(headingCount(after, 'Related') === 1,
      `#2: a "## Related" section was CREATED on the target page (heading count ${headingCount(after, 'Related')})`);
    assert(linkTargets(bulletsUnder(after, 'Related')).includes('summaries/creates'),
      '#3: the backlink landed inside that newly-created section — it was not silently dropped');
  }

  // ══ §4 — SUMMARY MISSING "ENTITIES MENTIONED" ENTIRELY ═════════════════
  section('§4 A summary with no "Entities Mentioned" section gets one added (truncated-summary case)');
  {
    const d = await freshDomain('nosection');
    // A summary the LLM truncated: no Entities Mentioned heading at all.
    const rec = await writePage(d, 'summaries/truncated.md',
      `# Truncated\n\n## Summary\nThe model stopped early.\n\n## Notes\nnothing\n`);
    const preContent = readWiki(d, 'summaries/truncated.md');
    assert(headingCount(preContent, 'Entities Mentioned') === 0,
      '#1: precondition — the summary genuinely lacks the section before the sync');

    const e = await writePage(d, 'entities/rescued.md', pageWithRelated('rescued'));
    await syncSummaryEntities(d, rec.canonPath, [rec.canonPath, e.canonPath]);

    const after = readWiki(d, 'summaries/truncated.md');
    assert(headingCount(after, 'Entities Mentioned') === 1,
      `#2: the "## Entities Mentioned" section was ADDED (heading count ${headingCount(after, 'Entities Mentioned')})`);
    assert(mentionedIn(d, 'summaries/truncated.md').has('rescued'),
      '#3: the written entity is listed in the newly-added section');
    assert(backlinkersOf(d, 'truncated').has('rescued'),
      '#4: and the edge is still bidirectional — a section added late must not skip the backlink pass');
  }

  // ══ §5 — THE CANONICAL-PATH CONTRACT ═══════════════════════════════════
  // CLAUDE.md: the sync must use "canonicalPaths (returned by writePage), NOT
  // original LLM paths. This ensures redirected slugs (dr-tali-rezun →
  // tali-rezun) appear correctly in the summary."
  //
  // writePage Pass A strips a title prefix ONLY when the canonical file
  // already exists, so the fixture writes tali-rezun.md first.
  section('§5 Canonical-path redirection (writePage Pass A: dr-tali-rezun → tali-rezun)');
  {
    const d = await freshDomain('canon');
    const canonical = await writePage(d, 'entities/tali-rezun.md', pageWithRelated('Tali Rezun'));
    assert(canonical.canonPath === 'entities/tali-rezun.md',
      `#1: the canonical entity page exists first (got ${canonical.canonPath})`);

    const REQUESTED = 'entities/dr-tali-rezun.md';
    const redirected = await writePage(d, REQUESTED, pageWithRelated('Dr Tali Rezun'));
    assert(redirected.canonPath === 'entities/tali-rezun.md',
      `#2: precondition — writePage REDIRECTED "${REQUESTED}" to "${redirected.canonPath}" (if this ever stops redirecting, §5 proves nothing and must be rewritten)`);
    assert(!existsSync(path.join(wikiPath(d), REQUESTED)),
      '#3: precondition — no dr-tali-rezun.md ghost file was created on disk');

    const rec = await writePage(d, 'summaries/authored.md',
      `# Authored\n\n## Summary\nS.\n\n## Entities Mentioned\n`);

    // Feed CANONICAL paths, exactly as ingest.js:2686 does.
    await syncSummaryEntities(d, rec.canonPath, [rec.canonPath, redirected.canonPath]);

    const mentioned = mentionedIn(d, 'summaries/authored.md');
    assert(mentioned.has('tali-rezun'),
      `#4: the summary references the CANONICAL slug "tali-rezun" (got ${show(mentioned)})`);
    assert(!mentioned.has('dr-tali-rezun'),
      `#5: the summary does NOT reference the redirected-away slug "dr-tali-rezun" — feeding original LLM paths instead of canonPath is the bug this pins (got ${show(mentioned)})`);
    assert(backlinkersOf(d, 'authored').has('tali-rezun'),
      '#6: the CANONICAL page holds the backlink');
    assert(setEq(mentionedIn(d, 'summaries/authored.md'), backlinkersOf(d, 'authored')),
      '#7: the invariant still holds across a redirection — mentioned == backlinkers');
  }

  // ══ §6 — CONCEPTS FALLBACK IN injectSummaryBacklinks ═══════════════════
  // The resolver checks entities/ first, then falls back to concepts/. Driven
  // through injectSummaryBacklinks DIRECTLY here, so the fallback is exercised
  // on its own rather than incidentally via the sync.
  section('§6 injectSummaryBacklinks falls back to concepts/ when a slug is not an entity');
  {
    const d = await freshDomain('fallback');
    await writePage(d, 'concepts/only-a-concept.md', pageWithRelated('Only A Concept'));
    assert(!existsSync(path.join(wikiPath(d), 'entities/only-a-concept.md')),
      '#1: precondition — the slug exists ONLY in concepts/, never in entities/');

    const summaryContent =
      `# Fallback\n\n## Summary\nS.\n\n## Entities Mentioned\n- [[only-a-concept]]\n`;
    await injectSummaryBacklinks('fallback-summary', summaryContent, wikiPath(d));

    const after = readWiki(d, 'concepts/only-a-concept.md');
    assert(linkTargets(bulletsUnder(after, 'Related')).includes('summaries/fallback-summary'),
      '#2: the concept page received its backlink via the concepts/ fallback');
  }

  // ══ §7 — NEGATIVE CONTROL ══════════════════════════════════════════════
  // Proves the corpus can pass for the RIGHT reason and that the set-equality
  // assertions are not vacuous: a page present on disk but NOT part of this
  // ingest must appear in NEITHER set. A suite that failed everything, or one
  // whose sets were both empty, would be indistinguishable from coverage
  // without this.
  section('§7 Negative control (a page not written this ingest is in neither set)');
  {
    const d = await freshDomain('negctl');
    // A bystander from some earlier ingest.
    await writePage(d, 'entities/bystander.md', pageWithRelated('Bystander'));

    const rec = await writePage(d, 'summaries/this-ingest.md',
      `# This Ingest\n\n## Summary\nS.\n\n## Entities Mentioned\n`);
    const participant = await writePage(d, 'entities/participant.md', pageWithRelated('Participant'));

    // bystander is deliberately absent from writtenPaths.
    await syncSummaryEntities(d, rec.canonPath, [rec.canonPath, participant.canonPath]);

    const mentioned = mentionedIn(d, 'summaries/this-ingest.md');
    const backlinkers = backlinkersOf(d, 'this-ingest');

    assert(mentioned.has('participant'), '#1: the participating page IS listed (the control can go green)');
    assert(backlinkers.has('participant'), '#2: the participating page IS backlinked');
    assert(!mentioned.has('bystander'),
      `#3: the bystander is NOT listed in Entities Mentioned — the sync injects what was written, not what exists (got ${show(mentioned)})`);
    assert(!backlinkers.has('bystander'),
      `#4: the bystander did NOT receive a backlink (got ${show(backlinkers)})`);
    assert(setEq(mentioned, backlinkers),
      `#5: the invariant holds with a bystander present\n       mentioned   ${show(mentioned)}\n       backlinkers ${show(backlinkers)}`);
    assert(mentioned.size === 1,
      `#6: the sets are non-empty AND bounded — exactly one page, so set equality above is not vacuously true of two empty sets (got ${mentioned.size})`);
  }

} catch (err) {
  bad('unexpected throw during test run', err && (err.stack || err.message) || String(err));
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const { label, err } of failures) console.log(`  ✗ ${label}${err ? ` — ${err}` : ''}`);
  process.exit(1);
}
console.log('\nAll summary-backlink-sync tests green.');
process.exit(0);
