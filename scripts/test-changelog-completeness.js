/**
 * test-changelog-completeness.js — OFFLINE suite proving that the project's
 * changelog, SPLIT across two files, is still one complete set.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 * v3.24.2 moved 130 changelog rows out of the auto-loaded `CLAUDE.md` into
 * `CHANGELOG-ARCHIVE.md`, byte-for-byte, and recorded its own open gap in the
 * release row verbatim:
 *
 *   "no automated guard proves the archive's rows plus this file's rows still
 *    equal the original set, so a future edit could silently drop one and
 *    nothing would go red"
 *
 * That gap is not hypothetical and it did not stay theoretical. The SAME row
 * also asked the next release to move `v3.22.0` to the archive to restore the
 * intended five kept rows. Three releases then each added a row and none moved
 * one, so the auto-loaded file grew from 5 intended rows to NINE and from
 * ~42,792 tokens back to ~58,125 — and nothing went red, because nothing was
 * looking. This suite is that missing check, in both of its halves:
 *
 *   COMPLETENESS — a release must never fall out of the union of the two
 *                  files, and must never be duplicated across them.
 *   LEANNESS     — the number of FULL rows in the auto-loaded file is capped,
 *                  so the debt cannot silently accumulate for three releases
 *                  again.
 *
 * ── THE STRUCTURE BEING CHECKED ──────────────────────────────────────────
 * `CLAUDE.md` carries TWO tables:
 *   • the FULL-ROW table (header `| Commit | What it fixed |`) — the newest
 *     few releases, each one a whole long row;
 *   • the INDEX table (header `| Release | Headline …`) — exactly one pointer
 *     line per ARCHIVED release.
 * `CHANGELOG-ARCHIVE.md` carries one table (header `| Commit | What it fixed |`)
 * holding the archived rows in full.
 *
 * The invariant is therefore a THREE-WAY one, not a two-way one:
 *
 *     index(CLAUDE.md)  ==  rows(CHANGELOG-ARCHIVE.md)      (set equality)
 *     full(CLAUDE.md)   ∩   rows(CHANGELOG-ARCHIVE.md) = ∅  (disjoint)
 *     full(CLAUDE.md)   ∩   index(CLAUDE.md)           = ∅  (disjoint)
 *
 * ── WHY SET EQUALITY ALONE IS NOT ENOUGH, AND WHAT CLOSES IT ─────────────
 * Set equality catches a row deleted from the archive (its index line is left
 * orphaned) and an index line deleted (its archive row is left unindexed). It
 * does NOT catch someone deleting BOTH halves of the same release — the sets
 * still agree, one release shorter. Two independent measurements close that,
 * and neither needs an external manifest (git tags are NOT one: there are 41
 * tags and they stop at `v3.9.2`, against 139 documented releases):
 *
 *   §4 SERIES CONTIGUITY — the `vMAJOR.MINOR.PATCH` releases must have no GAP.
 *      For major 3, every minor from the lowest present to the highest must
 *      appear, and within each `major.minor` the patch numbers must be
 *      contiguous from the lowest present to the highest. Deleting both halves
 *      of `v3.20.0` leaves minor 20 with no release at all → RED, naming it.
 *      Patch numbering legitimately starts above 0 in places (there is no
 *      `v3.0.0` row — the beta line covers it), so contiguity is asserted
 *      from the LOWEST PRESENT patch, never from 0, which is what makes this
 *      a real check rather than one that has to be exempted into silence.
 *
 *   §5 THE PROSE COUNTS — `CLAUDE.md` states how many rows are archived and
 *      how many are kept; `CHANGELOG-ARCHIVE.md` states the same two numbers
 *      in its own header. All three prose claims are compared against the
 *      MEASURED counts. A silent drop that also removed the index line must
 *      additionally edit three numbers in two files to stay quiet.
 *
 * ── NOT ENFORCED, stated so nobody reads more into a green run ───────────
 *   • This suite cannot prove a row's CONTENT was not reworded — only that the
 *     release is still present, exactly once, in exactly one of the two files.
 *     Byte-identity across a MOVE is proven at move time with per-row hashes
 *     and positive controls; there is no committed pre-move corpus to diff a
 *     later edit against, and inventing one would be a second copy of the
 *     rows, which is the thing the archive exists to avoid.
 *   • A release that was NEVER documented in either file is invisible here.
 *     §6 anchors the one case that matters — `package.json`'s current version
 *     must have a FULL row in the auto-loaded file — but an undocumented
 *     historical release cannot be detected from these two files alone.
 *   • The commit-SHA rows (`7b54fa2`, `f9665b3`, …) and the `Phase 1 ✅` row
 *     participate in set equality and disjointness but are excluded from the
 *     semver contiguity check, because they carry no version to order.
 *
 * Zero dependencies — node: builtins only, no network, no API key.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CLAUDE_MD = path.join(ROOT, 'CLAUDE.md');
const ARCHIVE_MD = path.join(ROOT, 'CHANGELOG-ARCHIVE.md');

const claudeSrc = readFileSync(CLAUDE_MD, 'utf8');
const archiveSrc = readFileSync(ARCHIVE_MD, 'utf8');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Table extraction ──────────────────────────────────────────────────────
// A markdown table row here is any line starting with "| ". The loop must
// break on "not a table row", NEVER on "not a backticked identifier": the
// archive table contains one row whose first cell is `Phase 1 ✅`, and a
// backtick-anchored loop silently stops there and reports 119 rows where
// there are 134 — i.e. it reports a loss that has not happened. That exact
// mistake was made while building this change and is pinned by §0 below.
function tableRows(src, headerPredicate, label) {
  const lines = src.split('\n');
  const h = lines.findIndex(headerPredicate);
  if (h < 0) throw new Error(`tableRows: header not found for ${label}`);
  if (!/^\|\s*-{2,}/.test(lines[h + 1])) {
    throw new Error(`tableRows: no separator row under the ${label} header — the table shape changed`);
  }
  const rows = [];
  for (let i = h + 2; i < lines.length; i++) {
    if (!lines[i].startsWith('| ')) break;
    rows.push(lines[i]);
  }
  return rows;
}

// The identifier is the first cell's backticked token; a row without one
// (`Phase 1 ✅`) is keyed by its literal first cell so it still participates
// in set equality rather than being silently dropped from the comparison.
function idOf(row) {
  const m = row.match(/^\| `([^`]+)`/);
  if (m) return m[1];
  const cell = row.slice(2, row.indexOf(' |', 2));
  return cell.trim();
}

const isFullHeader = (l) => l === '| Commit | What it fixed |';
const isIndexHeader = (l) => l.startsWith('| Release | Headline');

const fullRows = tableRows(claudeSrc, isFullHeader, 'CLAUDE.md full-row table');
const indexRows = tableRows(claudeSrc, isIndexHeader, 'CLAUDE.md index table');
const archiveRows = tableRows(archiveSrc, isFullHeader, 'CHANGELOG-ARCHIVE.md');

const fullIds = fullRows.map(idOf);
const indexIds = indexRows.map(idOf);
const archiveIds = archiveRows.map(idOf);

section('0. The parser sees whole tables (anti-vacuity — a parser that stops early reports a loss that never happened, and one that matches nothing reports perfection forever)');
{
  ok(fullRows.length >= 3, `CLAUDE.md full-row table parsed: ${fullRows.length} rows (a parser matching 0 or 1 rows would make every later assertion vacuous)`);
  ok(indexRows.length >= 100, `CLAUDE.md index table parsed: ${indexRows.length} rows`);
  ok(archiveRows.length >= 100, `CHANGELOG-ARCHIVE.md parsed: ${archiveRows.length} rows`);
  ok(archiveIds.includes('Phase 1 ✅'), 'the non-backticked "Phase 1 ✅" archive row IS seen by the parser — the row that broke a backtick-anchored loop and made it under-count by 15');
  ok(fullIds.every((id) => id.length > 0) && indexIds.every((id) => id.length > 0) && archiveIds.every((id) => id.length > 0),
    'every parsed row yields a non-empty identifier (an empty id would collapse rows together in the Set comparisons below)');
  ok(new Set(archiveIds).size === archiveIds.length, `no identifier appears twice inside CHANGELOG-ARCHIVE.md (${archiveIds.length} rows, ${new Set(archiveIds).size} distinct)`);
  ok(new Set(indexIds).size === indexIds.length, `no identifier appears twice inside the CLAUDE.md index (${indexIds.length} lines, ${new Set(indexIds).size} distinct)`);
  ok(new Set(fullIds).size === fullIds.length, `no identifier appears twice in the CLAUDE.md full-row table (${fullIds.length} rows)`);
}

section('1. THE CORE INVARIANT — every archived row has exactly one index line, and every index line points at a real archived row');
{
  const archiveSet = new Set(archiveIds);
  const indexSet = new Set(indexIds);

  const orphanedIndex = indexIds.filter((id) => !archiveSet.has(id));
  ok(orphanedIndex.length === 0,
    orphanedIndex.length === 0
      ? 'no index line points at a release missing from CHANGELOG-ARCHIVE.md'
      : `INDEX LINE WITHOUT AN ARCHIVED ROW — the full record for ${orphanedIndex.join(', ')} is GONE from CHANGELOG-ARCHIVE.md. An index line is a pointer, never the record; restore the row.`);

  const unindexed = archiveIds.filter((id) => !indexSet.has(id));
  ok(unindexed.length === 0,
    unindexed.length === 0
      ? 'every archived row is reachable from the index in the auto-loaded CLAUDE.md'
      : `ARCHIVED ROW WITH NO INDEX LINE — ${unindexed.join(', ')} is preserved but unreachable from CLAUDE.md; nobody will know to grep for it. Add its one-line index entry.`);

  ok(indexIds.length === archiveIds.length,
    `index line count equals archived row count (${indexIds.length} == ${archiveIds.length})`);
}

section('2. DISJOINTNESS — a release lives in exactly ONE place, never both (a copy-not-move leaves the auto-loaded file carrying the very bytes the split removed)');
{
  const archiveSet = new Set(archiveIds);
  const indexSet = new Set(indexIds);
  const inBoth = fullIds.filter((id) => archiveSet.has(id));
  ok(inBoth.length === 0,
    inBoth.length === 0
      ? 'no release has a full row in BOTH CLAUDE.md and CHANGELOG-ARCHIVE.md'
      : `DUPLICATED — ${inBoth.join(', ')} has a full row in CLAUDE.md AND in CHANGELOG-ARCHIVE.md. A move that only copied leaves the context cost in place.`);

  const alsoIndexed = fullIds.filter((id) => indexSet.has(id));
  ok(alsoIndexed.length === 0,
    alsoIndexed.length === 0
      ? 'no release has both a full row and an index line in CLAUDE.md'
      : `DOUBLE-LISTED IN CLAUDE.md — ${alsoIndexed.join(', ')} appears as a full row and as an index line.`);
}

section('3. LEANNESS RATCHET — CLAUDE.md is auto-loaded into every session, so its row count is a per-session tax and cannot be allowed to drift upward unnoticed');
{
  // The intended steady state is FIVE full rows (v3.24.2's decision, argued
  // there against three and against eight). The cap is SIX, not five, so a
  // release may add its own row before the trim is performed in the same
  // change — it is a ratchet against silent accumulation, not a style rule.
  // It last failed to hold for THREE consecutive releases, reaching nine.
  const CAP = 6;
  ok(fullRows.length <= CAP,
    fullRows.length <= CAP
      ? `CLAUDE.md carries ${fullRows.length} full changelog rows (cap ${CAP}, intended steady state 5)`
      : `TOO MANY FULL ROWS — ${fullRows.length} against a cap of ${CAP}. Move the oldest to CHANGELOG-ARCHIVE.md byte-for-byte and add one index line each. This is exactly the drift that took the file from ~42,792 back to ~58,125 tokens over three releases.`);

  // Measured, not asserted from memory: the actual byte cost of the rows kept.
  const fullBytes = fullRows.reduce((n, r) => n + Buffer.byteLength(r, 'utf8'), 0);
  const claudeBytes = Buffer.byteLength(claudeSrc, 'utf8');
  console.log(`    (measured: full rows ${fullBytes} chars of ${claudeBytes} = ${(fullBytes / claudeBytes * 100).toFixed(1)}% of the auto-loaded file)`);
  ok(fullBytes < claudeBytes, 'the full-row table is a proper subset of the file (sanity check on the byte measurement above)');
}

section('4. SERIES CONTIGUITY — closes the one hole set equality cannot see: deleting BOTH halves of a release leaves the sets agreeing, one release shorter');
{
  const all = [...fullIds, ...archiveIds];
  const semver = [];
  for (const id of all) {
    const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(id); // release rows only — betas, SHAs and "Phase 1 ✅" carry no orderable version
    if (m) semver.push({ id, major: +m[1], minor: +m[2], patch: +m[3] });
  }
  ok(semver.length >= 60, `${semver.length} plain-semver releases found across both files (anti-vacuity: a regex matching none would pass every gap check below)`);

  // (a) within each major.minor, patches contiguous from the LOWEST PRESENT
  const byMinor = new Map();
  for (const r of semver) {
    const k = `${r.major}.${r.minor}`;
    if (!byMinor.has(k)) byMinor.set(k, []);
    byMinor.get(k).push(r.patch);
  }
  const patchGaps = [];
  for (const [k, patches] of byMinor) {
    const sorted = [...patches].sort((a, b) => a - b);
    for (let p = sorted[0]; p <= sorted[sorted.length - 1]; p++) {
      if (!sorted.includes(p)) patchGaps.push(`v${k}.${p}`);
    }
  }
  ok(patchGaps.length === 0,
    patchGaps.length === 0
      ? `no patch-number gap in any release line (${byMinor.size} major.minor lines checked)`
      : `MISSING RELEASE(S) — ${patchGaps.join(', ')} appear in NEITHER CLAUDE.md nor CHANGELOG-ARCHIVE.md, but releases on either side of them do. A row was dropped from both files.`);

  // (b) within major 3, minors contiguous from the lowest present
  const minors3 = [...new Set(semver.filter((r) => r.major === 3).map((r) => r.minor))].sort((a, b) => a - b);
  const minorGaps = [];
  for (let m = minors3[0]; m <= minors3[minors3.length - 1]; m++) {
    if (!minors3.includes(m)) minorGaps.push(`v3.${m}.x`);
  }
  ok(minorGaps.length === 0,
    minorGaps.length === 0
      ? `major 3 covers every minor from ${minors3[0]} to ${minors3[minors3.length - 1]} with no gap`
      : `ENTIRE RELEASE LINE MISSING — ${minorGaps.join(', ')} has no row in either file.`);
}

section('5. THE PROSE COUNTS ARE MEASURED, NOT TRUSTED — three claims in two files must agree with the tables, so a drop that also removed the index line still has to survive editing all three');
{
  // CLAUDE.md: "The **5 newest releases** are below in full."
  const keptClaim = claudeSrc.match(/The \*\*(\d+) newest releases\*\* are below in full/);
  ok(!!keptClaim, 'CLAUDE.md states how many full rows it keeps');
  if (keptClaim) {
    ok(Number(keptClaim[1]) === fullRows.length,
      `CLAUDE.md's "${keptClaim[1]} newest releases" matches the ${fullRows.length} full rows actually present`);
  }

  // CLAUDE.md: "Every earlier release — **134 rows**, back to `v2.4.2` — is preserved"
  const archivedClaim = claudeSrc.match(/Every earlier release — \*\*(\d+) rows\*\*/);
  ok(!!archivedClaim, 'CLAUDE.md states how many rows are archived');
  if (archivedClaim) {
    ok(Number(archivedClaim[1]) === archiveRows.length,
      `CLAUDE.md's "${archivedClaim[1]} rows" matches the ${archiveRows.length} rows actually in CHANGELOG-ARCHIVE.md`);
  }

  // CHANGELOG-ARCHIVE.md: "The newest\n> 5 releases stay in `CLAUDE.md`; these 134 live here."
  const archiveClaim = archiveSrc.match(/(\d+) releases stay in `CLAUDE\.md`; these (\d+) live here/);
  ok(!!archiveClaim, 'CHANGELOG-ARCHIVE.md restates both counts in its own header');
  if (archiveClaim) {
    ok(Number(archiveClaim[1]) === fullRows.length,
      `the archive's "${archiveClaim[1]} releases stay in CLAUDE.md" matches the ${fullRows.length} kept`);
    ok(Number(archiveClaim[2]) === archiveRows.length,
      `the archive's "these ${archiveClaim[2]} live here" matches its own ${archiveRows.length} rows`);
  }
}

section('6. LIVENESS — the release currently shipping is documented, in the auto-loaded file, not only in the archive');
{
  const v = 'v' + pkg.version;
  ok(fullIds.includes(v),
    fullIds.includes(v)
      ? `package.json's ${pkg.version} has a FULL row in CLAUDE.md`
      : `THE CURRENT RELEASE IS NOT DOCUMENTED IN CLAUDE.md — package.json says ${pkg.version} and no full row names ${v}. Either the row was never written, or it was archived while still being the shipping version.`);
  ok(fullIds[0] === v,
    fullIds[0] === v
      ? `${v} is the FIRST full row (newest-first order holds at the top of the table)`
      : `ORDER BROKEN — the first full row is ${fullIds[0]}, not the shipping ${v}.`);
}

section('7. THE ARCHIVE STAYS AT THE REPO ROOT — measured in v3.24.2 at 176 broken links against a baseline of 1 if re-homed under docs/, and the only repair available there is editing the rows');
{
  // Not a preference: the preserved rows carry root-relative markdown links,
  // and those resolve only from the repo root. This asserts the link corpus is
  // still substantial, so the reasoning in the archive's own header stays true.
  const rootRelLinks = archiveSrc.match(/\]\((?!https?:|#|\/)[a-zA-Z0-9._-]+\/[^)]*\)/g) || [];
  ok(rootRelLinks.length > 100,
    `CHANGELOG-ARCHIVE.md carries ${rootRelLinks.length} path-prefixed root-relative links — the measured reason the file cannot move into docs/`);
  ok(/why this file is at the repo root/i.test(archiveSrc),
    'the archive states in its own header why it must stay at the repo root, so a future tidy-up finds the reasoning before acting');
}

console.log('\n' + '─'.repeat(62));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ Changelog completeness assertions failed');
  process.exit(1);
} else {
  console.log('✅ Changelog is one complete set across CLAUDE.md + CHANGELOG-ARCHIVE.md');
}
