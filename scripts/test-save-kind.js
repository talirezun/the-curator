#!/usr/bin/env node
/**
 * OFFLINE — the fifth `classifySaveNotes` verdict: `clipped` vs `trimmed`.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS SUITE GUARDS
 * ═════════════════════════════════════════════════════════════════════════
 * A maintainer's Agent-memory view badged a save `incomplete` and told him:
 * "That save did not fit the state budget, so part of it was trimmed before
 * it was written. The handoff below is missing what the note names — ask the
 * agent to save again, shorter." BOTH halves were false for the save that
 * triggered it. The real journal record: 6,698 of a 49,152-byte budget used
 * (14%), and the ONLY note was `headline: truncated to 200 chars (was 244)`
 * — a clip of the one-line summary, with the handoff BODY stored in full.
 *
 * The cause: `classifySaveNotes` tested every note against one loss-word
 * regex and returned `'trimmed'` on any match, so a metadata-field clip
 * (headline/harness/model) was classified identically to real content loss
 * from the handoff body (nowState/decisions/traps/nextSteps/observations/
 * openQuestions). This suite pins the fix: a fifth verdict, `'clipped'`,
 * that fires ONLY when every loss-worded note is confirmed to be about a
 * metadata field — never merely because no body field happened to match.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT "DERIVED FROM THE PRODUCING CODE" MEANS HERE, AND HOW §2 PROVES IT
 * ═════════════════════════════════════════════════════════════════════════
 * `working-state.js` keys `BODY_SAVE_NOTE_FIELDS` off `STATE_SECTIONS` — the
 * same exported array that defines the rendered document and the `label`
 * passed to every per-field sanitiser — rather than a hand-typed list. §2
 * does not merely read that source line; it imports the live `STATE_SECTIONS`
 * array and, for EVERY key in it, synthesises a loss note of the exact shape
 * the real sanitisers emit and asserts `classifySaveNotes` calls it
 * `'trimmed'`. If a body section is ever added to `STATE_SECTIONS` and the
 * classifier's derivation is ever reverted to a hand-typed list that forgets
 * it, this loop catches it without anyone updating this test — because it
 * walks the array, not a copy of it.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY THE PRIORITY RULE IS TESTED WITH REAL saveWorkingState CALLS, NOT ONLY
 * SYNTHETIC NOTE ARRAYS
 * ═════════════════════════════════════════════════════════════════════════
 * A synthetic `classifySaveNotes(['headline: truncated…'])` call proves the
 * classifier's logic but not that production ever produces that exact shape,
 * or that a save which clips BOTH a metadata field and a body field in the
 * same call is classified correctly end to end. §4 drives the real
 * `saveWorkingState` — real sanitisers, real `renderWithinBudget`, real
 * `finaliseNotes` — with oversized fields and reads `result.notes` /
 * `result.ok` back, then classifies THOSE. §5 reproduces the maintainer's
 * exact reported shape (a 244-char headline, a small body) end to end and
 * asserts the body content is verifiably intact on disk, not merely that the
 * verdict says so.
 *
 * SAFETY — never touches real user data. Domains and user-data are both
 * pinned into a throwaway tempdir BEFORE any module that resolves a path is
 * imported.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NEXT = join(ROOT, 'src/public/next');

// ── Isolation, established BEFORE any import that resolves a path ─────────
const TMP = mkdtempSync(join(tmpdir(), 'curator-savekind-'));
const DOMAINS = join(TMP, 'domains');
const USER_DATA = join(TMP, 'userdata');
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(USER_DATA, { recursive: true });
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'DOMAINS_PATH', 'LLM_MODEL']) delete process.env[k];

function cleanup() {
  try {
    const rel = relative(tmpdir(), TMP);
    if (rel && !rel.startsWith('..') && !rel.includes('/')) rmSync(TMP, { recursive: true, force: true });
  } catch { /* best effort */ }
}
process.on('exit', cleanup);

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function section(t) { console.log('\n' + t); }

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);
const WS = await import('../src/brain/working-state.js');
const { classifySaveNotes, saveWorkingState, STATE_SECTIONS, INSTALL_ID_UNAVAILABLE_NOTE,
  MAX_HEADLINE_CHARS, MAX_META_CHARS, MAX_PROSE_CHARS } = WS;

function makeDomain(slug) {
  mkdirSync(join(DOMAINS, slug, 'wiki', 'entities'), { recursive: true });
  writeFileSync(join(DOMAINS, slug, 'CLAUDE.md'), '# ' + slug + '\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'index.md'), '# Index\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'log.md'), '# Log\n');
}
makeDomain('proj');

// ═════════════════════════════════════════════════════════════════════════
section('§1 — classifySaveNotes: the required shapes, in priority order');
// ═════════════════════════════════════════════════════════════════════════

eq('a non-array is null — unaffected by this change',
  classifySaveNotes('nope'), null);
eq('an empty list is complete — unaffected',
  classifySaveNotes([]), 'complete');

// The maintainer's ACTUAL reported pair, verbatim.
const REAL_PAIR = [
  'headline: truncated to 200 chars (was 244)',
  'nowState: escaped protocol-shaped markers (a <tag> or a line-initial "Role:") '
    + 'so they cannot be read as a separate channel — wording is otherwise unchanged',
];
eq('THE REPORTED CASE: a headline clip alongside a benign nowState note is CLIPPED, not trimmed',
  classifySaveNotes(REAL_PAIR), 'clipped');

eq('headline-only clip is CLIPPED',
  classifySaveNotes(['headline: truncated to 200 chars (was 244)']), 'clipped');
eq('harness-only clip is CLIPPED',
  classifySaveNotes(['harness: truncated to 80 chars (was 95)']), 'clipped');
eq('model-only clip is CLIPPED',
  classifySaveNotes(['model: truncated to 80 chars (was 95)']), 'clipped');
eq('a body-section truncation (nowState, the handoff prose) is TRIMMED',
  classifySaveNotes(['nowState: truncated to 8000 chars (was 9000)']), 'trimmed');
eq('a body-section list truncation (nextSteps) is TRIMMED',
  classifySaveNotes(['nextSteps: 2 item(s) omitted over the state size budget']), 'trimmed');
eq('a dropped body item (traps) is TRIMMED',
  classifySaveNotes(['traps: dropped 1 empty/oversized/non-string item(s)']), 'trimmed');

// THE WORST-WINS RULE — the priority ordering explicitly required.
eq('BOTH a metadata clip AND a body loss in one save: the BODY verdict wins',
  classifySaveNotes([
    'headline: truncated to 200 chars (was 244)',
    'decisions: 1 item(s) omitted over the state size budget',
  ]), 'trimmed');
eq('...order of the notes array must not matter — body-first still trims',
  classifySaveNotes([
    'openQuestions: dropped 3 empty/oversized/non-string item(s)',
    'model: truncated to 80 chars (was 90)',
  ]), 'trimmed');

eq('a deliberate replace is its own verdict, unaffected by this change',
  classifySaveNotes(['replace: deliberately overwrote a larger handoff (4000 → 200 body bytes)']),
  'replaced');
eq('a benign normalisation note (nothing lost) is NOTED, unaffected',
  classifySaveNotes(['observations: 1 item(s) stamped with the save time']), 'noted');
eq('the machine-identity warning is NOTED — it is about the folder, not the content',
  classifySaveNotes([INSTALL_ID_UNAVAILABLE_NOTE]), 'noted');

// FAIL-SAFE: a loss word on a field this classifier does not recognise must
// read as body loss, never as a harmless clip — an unlisted field is a gap
// in OUR bookkeeping, not evidence the content survived.
eq('an unrecognised field name carrying a loss word fails SAFE to trimmed',
  classifySaveNotes(['somethingNew: truncated to 10 chars (was 50)']), 'trimmed');
eq('the whole-document last-resort truncation (key __document, no word-shaped field) fails SAFE to trimmed',
  classifySaveNotes(['__document: 1 item(s) omitted over the state size budget']), 'trimmed');
eq('a loss word with no field prefix at all fails SAFE to trimmed',
  classifySaveNotes(['this handoff lost its footing']), 'trimmed');

// ANTI-VACUITY: prove the metadata bucket is not simply "not caught by the
// old regex" — construct a metadata-shaped note that would have to be
// singled out correctly even among several non-matching decoys.
{
  const decoys = ['scope: saved under "main" — normalised', 'harness: claude-code', 'model: opus-5'];
  eq('a real clip found among several NON-loss metadata notes is still CLIPPED',
    classifySaveNotes([...decoys, 'headline: truncated to 200 chars (was 244)']), 'clipped');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — the body-field list is DERIVED from STATE_SECTIONS, not hand-typed');
// ═════════════════════════════════════════════════════════════════════════
//
// This walks the live, exported STATE_SECTIONS array — the same array
// saveWorkingState renders from and labels its sanitisers with — and proves
// every one of its keys is treated as body content. A future section added to
// STATE_SECTIONS and forgotten in the classifier's own field set would red
// this loop without anyone touching this file.
ok('STATE_SECTIONS is non-empty (non-vacuity: this loop tests something)',
  Array.isArray(STATE_SECTIONS) && STATE_SECTIONS.length >= 5, JSON.stringify(STATE_SECTIONS?.length));
{
  let allTrimmed = true;
  const results = [];
  for (const sec of STATE_SECTIONS) {
    const verdict = classifySaveNotes([`${sec.key}: truncated to 10 chars (was 50)`]);
    results.push([sec.key, verdict]);
    if (verdict !== 'trimmed') allTrimmed = false;
  }
  ok('every STATE_SECTIONS key, synthesised as a loss note, classifies as TRIMMED',
    allTrimmed, JSON.stringify(results));
}
// The mirror control: none of the current STATE_SECTIONS keys may be treated
// as metadata — if one ever were, the loop above would already have failed,
// but this states the invariant directly rather than by absence of failure.
{
  const bodyKeys = STATE_SECTIONS.map((s) => s.key);
  const metaKeys = ['headline', 'harness', 'model'];
  const overlap = bodyKeys.filter((k) => metaKeys.includes(k));
  eq('CONTROL: the body-section keys and the known metadata keys do not overlap today',
    overlap.length, 0);
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — anti-vacuity: every check above can actually fail');
// ═════════════════════════════════════════════════════════════════════════
//
// A suite asserting only positives cannot tell a classifier that always
// returns 'trimmed' from one that reasons about fields. These checks fail on
// today's shipped code turned into its own negative control.
ok('CONTROL: a headline clip is NOT classified the same as a body clip (proves the split exists)',
  classifySaveNotes(['headline: truncated to 200 chars (was 244)']) !==
  classifySaveNotes(['nowState: truncated to 8000 chars (was 9000)']));
ok('CONTROL: "clipped" is reachable at all (would fail if the branch were dead code)',
  classifySaveNotes(['headline: truncated to 200 chars (was 244)']) === 'clipped');
ok('CONTROL: "trimmed" still fires on pure body loss (would fail if the rewrite broke the base case)',
  classifySaveNotes(['nowState: truncated to 8000 chars (was 9000)']) === 'trimmed');

// ═════════════════════════════════════════════════════════════════════════
section('§4 — driven through the REAL saveWorkingState pipeline, not just the classifier');
// ═════════════════════════════════════════════════════════════════════════

{
  // A headline just over MAX_HEADLINE_CHARS, a small body — should clip the
  // headline and leave the body untouched.
  const longHeadline = 'x'.repeat(MAX_HEADLINE_CHARS + 44); // matches the reported 244 vs 200 gap
  const r = await saveWorkingState('proj', {
    scope: 'clip-only', headline: longHeadline, harness: 'test-harness', model: 'test-model',
    nowState: 'Small body, well under budget.',
    nextSteps: ['one step'],
  });
  ok('the real save succeeds', r.ok === true, JSON.stringify(r));
  ok('...the headline note fired', r.notes.some((n) => n.startsWith('headline: truncated')), JSON.stringify(r.notes));
  ok('...and NO body-field note fired alongside it', !r.notes.some((n) =>
    STATE_SECTIONS.some((s) => n.startsWith(s.key + ':'))), JSON.stringify(r.notes));
  eq('classifying the real notes from a real over-length headline is CLIPPED',
    classifySaveNotes(r.notes), 'clipped');
  ok('the byte count is far under the state budget — this was never a budget problem',
    r.bytes < WS.MAX_STATE_BYTES * 0.5, r.bytes);
}

{
  // A body field (nowState) pushed past its own per-field cap — real content
  // loss, independent of the overall document budget.
  const bigBody = 'y'.repeat(MAX_PROSE_CHARS + 500);
  const r = await saveWorkingState('proj', {
    scope: 'trim-body', headline: 'normal headline', nowState: bigBody,
  });
  ok('the real save succeeds', r.ok === true, JSON.stringify(r));
  ok('...a nowState truncation note fired', r.notes.some((n) => n.startsWith('nowState: truncated')), JSON.stringify(r.notes));
  eq('classifying the real notes from a real over-length body field is TRIMMED',
    classifySaveNotes(r.notes), 'trimmed');
}

{
  // BOTH at once, in one real call: a long headline AND a long body field.
  // The worst verdict must win end to end, not just in the synthetic case.
  const r = await saveWorkingState('proj', {
    scope: 'clip-and-trim',
    headline: 'z'.repeat(MAX_HEADLINE_CHARS + 44),
    nowState: 'w'.repeat(MAX_PROSE_CHARS + 500),
  });
  ok('the real save succeeds', r.ok === true, JSON.stringify(r));
  ok('...both a headline note and a nowState note fired',
    r.notes.some((n) => n.startsWith('headline: truncated')) &&
    r.notes.some((n) => n.startsWith('nowState: truncated')), JSON.stringify(r.notes));
  eq('a real save clipping metadata AND trimming the body is TRIMMED — worst wins, end to end',
    classifySaveNotes(r.notes), 'trimmed');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — the maintainer’s exact reported shape, reproduced end to end');
// ═════════════════════════════════════════════════════════════════════════
//
// Real 244-char headline → 200-char clip, small body, and proof — not
// merely a verdict string — that the body written to disk is complete.
{
  const headlineBase = 'Fix the sync guard so a second machine never overwrites the '
    + 'in-progress handoff before the push completes and the journal records '
    + 'it as the newest entry for this scope on this install, verified live.';
  // Built to EXACTLY 244 characters (the reported length) rather than
  // hand-counted, so the fixture cannot silently drift off the reported case
  // if this sentence is ever edited. Padded with non-whitespace so
  // sanitiseLine's whitespace-collapse can't eat the padding back off.
  const headline244 = (headlineBase + ' ' + 'x'.repeat(244)).slice(0, 244);
  eq('the fixture headline really is 244 characters (matching the reported case exactly)',
    headline244.length, 244);

  const body = {
    nowState: 'The sync guard change is implemented and unit-tested locally.',
    decisions: ['Keep the existing write-lock file name.'],
    nextSteps: ['Add the live integration test.', 'Update docs/sync.md.'],
  };
  const r = await saveWorkingState('proj', {
    scope: 'reported-case', headline: headline244, harness: 'claude-code', model: 'opus-5', ...body,
  });
  ok('the save succeeds', r.ok === true, JSON.stringify(r));
  eq('the headline note reports exactly the reported 244 → 200 clip',
    r.notes.find((n) => n.startsWith('headline:')), `headline: truncated to ${MAX_HEADLINE_CHARS} chars (was 244)`);
  eq('the verdict is CLIPPED, not the incomplete/trimmed alarm the maintainer saw', classifySaveNotes(r.notes), 'clipped');

  // Read the handoff back off disk and prove the body survived byte-for-byte
  // — not "the verdict says so", the actual file.
  const currentPath = join(DOMAINS, 'proj', r.path);
  const onDisk = readFileSync(currentPath, 'utf8');
  for (const step of body.nextSteps) {
    ok(`the body on disk really contains "${step}"`, onDisk.includes(step));
  }
  ok('the body on disk really contains the decision', onDisk.includes(body.decisions[0]));
  ok('the body on disk really contains the nowState prose', onDisk.includes(body.nowState));
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — the memory.js copy: what it must say, and what it must never say');
// ═════════════════════════════════════════════════════════════════════════
//
// Same technique test-memory-truth.js uses: extract the real functions out of
// the shipped view source and execute them, so this is the actual rendered
// HTML a browser would receive — not a hand-typed guess at it.
function extractFunction(src, name, where) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start); let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced in ${where}`);
  return out;
}

const viewSrc = readFileSync(join(NEXT, 'views/memory.js'), 'utf8');
const { renderReadout } = await import('../src/public/next/shared/text.js');
const escapeHtml = new Function(extractFunction(
  readFileSync(join(NEXT, 'app.js'), 'utf8'), 'escapeHtml', 'app.js') + '\nreturn escapeHtml;')();

const LIFT = ['formatAge', 'effectiveSave', 'freshnessStep', 'newestPair', 'harnessOf',
  'firstNote', 'saveLine', 'renderSaveStatus'];
function lifted(stateObj) {
  const body = LIFT.map((n) => extractFunction(viewSrc, n, 'memory.js')).join('\n') +
    '\nreturn { ' + LIFT.join(', ') + ' };';
  return new Function('state', 'escapeHtml', 'icon', 'renderReadout', body)(
    stateObj, escapeHtml, (n) => '<svg data-icon="' + n + '"></svg>', renderReadout);
}

const baseRead = {
  scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }],
  brief: { present: true, updatedAt: new Date(Date.now() - 6 * 86400_000).toISOString() },
};
const baseDetail = (over = {}) => {
  const { current, ...rest } = over;
  return {
    scope: 'main', machine: 'boxa',
    journal: { entries: [{ at: '2026-08-30T10:00:00.000Z', harness: 'claude-code', model: 'opus-5' }] },
    ...rest,
    current: {
      present: true, writtenAgeSeconds: 120,
      writtenAt: new Date(Date.now() - 120_000).toISOString(),
      savedAt: new Date(Date.now() - 120_000).toISOString(),
      arrivedAt: new Date(Date.now() - 120_000).toISOString(),
      lastSaveKind: 'complete', lastSaveNotes: [], ...current,
    },
  };
};

const clippedHtml = lifted({}).renderSaveStatus(baseRead, baseDetail({
  current: { lastSaveKind: 'clipped', lastSaveNotes: ['headline: truncated to 200 chars (was 244)'] },
}));
const trimmedHtml = lifted({}).renderSaveStatus(baseRead, baseDetail({
  current: { lastSaveKind: 'trimmed', lastSaveNotes: ['nextSteps: 2 item(s) omitted over the state size budget'] },
}));

ok('a CLIPPED save gets its own quiet badge, not "incomplete"',
  /mem-badge-quiet">summary shortened<\/span>/.test(clippedHtml) && !/incomplete/.test(clippedHtml),
  clippedHtml.slice(0, 700));
ok('...and it is NOT given the loud/attention treatment — this is a note, not an alarm',
  !/mem-save-line-loud/.test(clippedHtml) && !/mem-badge-attn/.test(clippedHtml), clippedHtml);
ok('the clipped copy does not claim the state budget was hit',
  !/state budget/i.test(clippedHtml), clippedHtml);
ok('the clipped copy does not say the handoff is missing anything',
  !/\bmissing\b/i.test(clippedHtml), clippedHtml);
ok('the clipped copy does not tell the user to save again',
  !/save (it |that content )?again/i.test(clippedHtml), clippedHtml);
ok('the clipped copy DOES say the handoff was written/saved in full — the reassurance is present, not just the absence of alarm',
  /written in full/i.test(clippedHtml), clippedHtml);
ok('the clipped copy names WHY the shortened label matters (a future session decides whether to open this state from it)',
  /future session/i.test(clippedHtml) && /deciding whether to open this state/i.test(clippedHtml), clippedHtml);
ok('the store’s own note is quoted, not paraphrased away',
  clippedHtml.includes('headline: truncated to 200 chars (was 244)'), clippedHtml);

ok('a TRIMMED save keeps the "incomplete" badge and the loud treatment — unchanged',
  /mem-badge-attn">incomplete<\/span>/.test(trimmedHtml) && /mem-save-line-loud/.test(trimmedHtml),
  trimmedHtml.slice(0, 700));
ok('the corrected trimmed copy no longer claims the state budget was hit as the cause',
  !/did not fit the state budget/i.test(trimmedHtml), trimmedHtml);
ok('CONTROL: that exact check can fail — the OLD sentence would have tripped it',
  /did not fit the state budget/i.test('That save did not fit the state budget, so part of it was trimmed.'));
ok('the trimmed copy still says something is missing — that part stays true for real body loss',
  /missing/i.test(trimmedHtml), trimmedHtml);
ok('CONTROL: a healthy (complete) save says neither "incomplete" nor "shortened"',
  !/incomplete/.test(lifted({}).renderSaveStatus(baseRead, baseDetail())) &&
  !/summary shortened/.test(lifted({}).renderSaveStatus(baseRead, baseDetail())));

// A REPLACED save must remain untouched by any of this.
const replacedHtml = lifted({}).renderSaveStatus(baseRead, baseDetail({
  current: { lastSaveKind: 'replaced', lastSaveNotes: ['replace: deliberately overwrote a larger handoff (9000 → 400 body bytes)'] },
}));
ok('CONTROL: a REPLACED save is unaffected by this change — no clipped/incomplete wording',
  !/incomplete/.test(replacedHtml) && !/summary shortened/.test(replacedHtml) &&
  replacedHtml.includes('replaced a larger handoff'), replacedHtml.slice(0, 700));

// ═════════════════════════════════════════════════════════════════════════
section('§7 — consumers: pass-through sites must not need a switch to be safe');
// ═════════════════════════════════════════════════════════════════════════
//
// tray-summary.js, src/routes/memory.js, and the MCP `get_working_state`
// surface all forward `lastSaveKind` as an opaque string rather than
// switching on it, so a new verdict reaches them automatically. This proves
// the ONE place that DOES switch (memory.js, tested above) is the only place
// that needed a code change, by confirming journalFacts/readWorkingState hand
// 'clipped' through unmodified — the same field-forwarding contract
// scripts/test-working-state-disclosure.js guards for the OTHER disclosure
// fields.
{
  const r = await saveWorkingState('proj', {
    scope: 'passthrough', machine: 'boxb', headline: 'x'.repeat(MAX_HEADLINE_CHARS + 10),
    nowState: 'fine',
  });
  ok('setup save succeeds', r.ok === true, JSON.stringify(r));
  const idx = await WS.listWorkingScopes('proj');
  const row = (idx.scopes || []).find((s) => s.scope === 'passthrough' && s.machine === 'boxb');
  ok('the scope index row exists', !!row, JSON.stringify(idx.scopes));
  eq('the index row (what tray-summary.js and the routes read) carries the CLIPPED verdict untouched',
    row && row.lastSaveKind, 'clipped');

  const detail = await WS.readWorkingState('proj', { scope: 'passthrough', machine: 'boxb' });
  ok('the scoped read succeeds', detail.ok === true, JSON.stringify(detail));
  eq('the scoped read’s current.lastSaveKind (what the MCP tool and the route both expose) is CLIPPED',
    detail.current && detail.current.lastSaveKind, 'clipped');
}

console.log('\n' + '─'.repeat(63));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ Some save-kind assertions failed');
  process.exitCode = 1;
} else {
  console.log('✅ All save-kind assertions green');
}
