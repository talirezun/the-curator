#!/usr/bin/env node
/**
 * OFFLINE — the MCP save response tells the truth about WHICH verdict it got.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS GUARDS
 * ─────────────────────────────────────────────────────────────────────────
 * v3.39.0 split the store's save verdict in two, because a save that had lost
 * NOTHING was being reported as an incomplete handoff: its only note was
 * `headline: truncated to 200 chars (was 244)`, its body was stored in full,
 * and `classifySaveNotes` returned `trimmed` on the loss word alone. The fifth
 * verdict `clipped` was added and the app's own copy was rewritten.
 *
 * `mcp/tools/working-state.js` never got the message. It carried its OWN
 * `LOSSY_NOTE_RE = /\b(dropped|omitted|truncated)\b/i` — a second, drifted
 * copy of the classification — and rendered a clipped headline as:
 *
 *     "Some input was DROPPED, OMITTED or TRUNCATED — read `notes` and
 *      re-save what matters."
 *
 * That is the instruction an agent obeys. Six of eight headlines in one real
 * working session clip, so on most saves the MCP surface was asking for a
 * complete, wasted re-save of a handoff that was already stored in full — and
 * asking it of an agent that was, by construction, low on context.
 *
 * The regexes are gone; the verdict now comes from the store's exported
 * `classifySaveNotes`, and this file owns only the wording.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE ASSERTS, AND WHY IT IS NOT A STRING TEST
 * ─────────────────────────────────────────────────────────────────────────
 * The old defect WAS a confident, well-written string describing a fact that
 * was not true of the save in front of it. So asserting "the new sentence is
 * present" would guard nothing. Instead every verdict is produced by DRIVING
 * THE REAL HANDLER against the real store with input shaped to produce it, and
 * the headline assertions are:
 *
 *   §2  the clipped save is CLASSIFIED clipped, and its body really is on disk
 *       in full (read back through the real read handler, not asserted from
 *       the write side) — so the sentence "stored IN FULL" is a measurement;
 *   §3  the clipped sentence does NOT instruct a re-save, and the trimmed one
 *       DOES — the two must not be renderable as each other;
 *   §5  all five meanings are pairwise DISTINCT. A collapse back to one
 *       reassurance is the shape of the original defect and reds here without
 *       anyone knowing which words changed.
 *
 * §6 is the anti-vacuity control: it proves this suite can tell the verdicts
 * apart at all, by showing the pre-fix regex would have classified the clipped
 * save identically to the trimmed one.
 *
 * SAFETY — never touches real user data. Everything lives in a throwaway
 * tempdir pinned with BOTH CURATOR_TEST_DOMAINS_DIR and
 * CURATOR_TEST_USER_DATA_DIR, set BEFORE the modules are imported.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-save-verdict-'));
const DOMAINS = path.join(TMP, 'domains');
const USER_DATA = path.join(TMP, 'userdata');
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(USER_DATA, { recursive: true });
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'DOMAINS_PATH', 'LLM_MODEL']) delete process.env[k];
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

const { MAX_HEADLINE_CHARS, classifySaveNotes } = await import('../src/brain/working-state.js');
const { saveWorkingStateHandler, getWorkingStateHandler } =
  await import('../mcp/tools/working-state.js');
const { createStorageAdapter } = await import('../mcp/storage/local.js');

const storage = createStorageAdapter({ domainsPath: DOMAINS });

let passed = 0, failed = 0;
const failures = [];
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); failures.push({ label, detail }); }
};
const section = (t) => console.log(`\n── ${t} ──`);

const P = 'zz-verdict';
mkdirSync(path.join(DOMAINS, P, 'wiki', 'entities'), { recursive: true });
writeFileSync(path.join(DOMAINS, P, 'CLAUDE.md'), `# ${P}\n\nThrowaway fixture.\n`);

const save = (args) => saveWorkingStateHandler({ project: P, ...args }, storage);

// The body every save carries, long enough that "stored in full" is a claim
// with something to be false about.
const BODY = 'The adapter work is finished and merged. '.repeat(20)
  + 'STOPPED HERE: the retry ladder still needs a second rung.';

section('§1 · FIXTURES — each verdict is produced by real input, not by a stub');

const complete = await save({ scope: 'v-complete', headline: 'plain save', now_state: BODY });
ok(complete?.ok === true, 'a plain save succeeds');
ok((complete?.notes || []).length === 0 && complete?.save_kind === 'complete',
  'PRECONDITION: it produces NO notes, and the verdict is `complete`', JSON.stringify(complete?.notes));

const noted = await save({
  scope: 'v-noted', headline: 'normalised save', now_state: BODY,
  observations: [{ statement: 'the suite is green' }],
});
ok(noted?.save_kind === 'noted',
  'PRECONDITION: an observation with no time is `noted` — a default was applied and disclosed',
  `${noted?.save_kind} / ${JSON.stringify(noted?.notes)}`);

// THE CASE THE WHOLE SUITE EXISTS FOR. 244 chars is the maintainer's real one.
const LONG_HEADLINE = 'x'.repeat(244);
ok(LONG_HEADLINE.length > MAX_HEADLINE_CHARS,
  `PRECONDITION: the headline (${LONG_HEADLINE.length}) really does exceed the store's cap (${MAX_HEADLINE_CHARS})`);
const clipped = await save({ scope: 'v-clipped', headline: LONG_HEADLINE, now_state: BODY });
ok(clipped?.ok === true, 'an over-long headline does NOT refuse the save — it is clipped and disclosed');
ok((clipped?.notes || []).length === 1 && /^headline:/.test(clipped.notes[0]),
  'PRECONDITION: its ONLY note names the `headline` field', JSON.stringify(clipped?.notes));

const trimmed = await save({
  scope: 'v-trimmed', headline: 'lossy save', now_state: BODY,
  observations: [{ statement: 'kept' }, { nope: true }, 42],
});
ok((trimmed?.notes || []).some((n) => /^observations:/.test(n) && /dropped/i.test(n)),
  'PRECONDITION: unusable observations produce a DROPPED note naming a body field',
  JSON.stringify(trimmed?.notes));

// `replaced` needs a real destructive overwrite: a substantial handoff, then a
// near-empty one carrying replace: true.
await save({ scope: 'v-replaced', headline: 'the big one', now_state: BODY, decisions: [BODY.slice(0, 200)] });
const refused = await save({ scope: 'v-replaced', headline: 'tiny' });
ok(refused?.ok === false,
  'PRECONDITION: shrinking a real handoff is refused without the flag', JSON.stringify(refused?.reason));
const replaced = await save({ scope: 'v-replaced', headline: 'tiny', replace: true });
ok(replaced?.ok === true && replaced?.save_kind === 'replaced',
  'PRECONDITION: with replace: true it succeeds and the verdict is `replaced`',
  `${replaced?.ok} / ${replaced?.save_kind}`);

section('§2 · THE CLIPPED VERDICT — classified apart, and the body really is intact');

ok(clipped?.save_kind === 'clipped',
  'a clipped headline is `clipped`, NOT `trimmed` — the v3.39.0 split reaches the MCP surface',
  String(clipped?.save_kind));
ok(trimmed?.save_kind === 'trimmed',
  '…while a dropped body item is still `trimmed`, so the split discriminates rather than relabelling everything',
  String(trimmed?.save_kind));
ok(clipped?.save_kind === classifySaveNotes(clipped?.notes || []),
  'the forwarded `save_kind` IS the store\'s own verdict over the same notes, not a second opinion');

// "Stored IN FULL" is measured from the READ side, through the real read
// handler — the write side claiming success would prove nothing about disk.
const readBack = await getWorkingStateHandler({ project: P, scope: 'v-clipped' }, storage);
const currentText = readBack?.current?.text || readBack?.current?.content || '';
ok(readBack?.current?.present === true, 'the clipped save is readable back', JSON.stringify(Object.keys(readBack?.current || {})));
ok(currentText.includes('STOPPED HERE: the retry ladder still needs a second rung.'),
  'THE MEASUREMENT: the handoff body is on disk in full — the tail of a 900-char now_state survives the clip',
  currentText.slice(-120));
ok(currentText.includes('x'.repeat(MAX_HEADLINE_CHARS)) && !currentText.includes('x'.repeat(MAX_HEADLINE_CHARS + 1)),
  '…and it is the HEADLINE that was shortened, to exactly the cap — the two facts are separable and both checked');

section('§3 · THE READ PATH FORWARDS THE FIFTH VERDICT');

ok(readBack?.current?.lastSaveKind === 'clipped',
  'get_working_state reports lastSaveKind `clipped` — a reader is told the label was cut, not that content was lost',
  String(readBack?.current?.lastSaveKind));
ok(Array.isArray(readBack?.current?.lastSaveNotes)
   && readBack.current.lastSaveNotes.some((n) => /^headline:/.test(n)),
  '…and lastSaveNotes carries the note that names the field, so the verdict is checkable by the reader',
  JSON.stringify(readBack?.current?.lastSaveNotes));
const readTrimmed = await getWorkingStateHandler({ project: P, scope: 'v-trimmed' }, storage);
ok(readTrimmed?.current?.lastSaveKind === 'trimmed',
  'CONTROL: the read path is not pinned to one value — the trimmed scope reads back `trimmed`',
  String(readTrimmed?.current?.lastSaveKind));

section('§4 · THE SENTENCE — what an agent actually acts on');

const M = (r) => String(r?.notes_meaning || '');
ok(/stored IN FULL/i.test(M(clipped)),
  'the clipped meaning states the handoff was stored in full', M(clipped));
ok(/no re-save is needed/i.test(M(clipped)),
  '…and says explicitly that NO RE-SAVE IS NEEDED — the wasted-work instruction is the defect being fixed', M(clipped));
ok(!/re-save what matters/i.test(M(clipped)),
  '…and it is not the trimmed instruction wearing new words', M(clipped));
ok(/shorter headline/i.test(M(clipped)),
  '…while still asking for a shorter headline next time — the clip is harmless, not free', M(clipped));
ok(/re-save what matters/i.test(M(trimmed)) && /DROPPED, OMITTED or TRUNCATED/.test(M(trimmed)),
  'the trimmed meaning KEEPS the loud instruction — real body loss must stay loud', M(trimmed));
ok(!/stored in full/i.test(M(trimmed)),
  '…and never claims the handoff was stored in full', M(trimmed));
ok(/NORMALISED/.test(M(noted)) && /Nothing was dropped/i.test(M(noted)),
  'the noted meaning is a normalisation, not a loss', M(noted));
ok(/No notes/i.test(M(complete)), 'a save with nothing to disclose says exactly that', M(complete));
ok(/REPLACED a larger saved handoff/i.test(M(replaced)) && /not recoverable/i.test(M(replaced)),
  'the replaced meaning still names the destroyed document', M(replaced));

section('§5 · THE FIVE MEANINGS ARE PAIRWISE DISTINCT');

const meanings = {
  complete: M(complete), noted: M(noted), clipped: M(clipped),
  trimmed: M(trimmed), replaced: M(replaced),
};
const distinct = new Set(Object.values(meanings));
ok(distinct.size === 5,
  'five verdicts, five different sentences — a collapse back to one reassurance reds here',
  JSON.stringify(meanings, null, 1));
const tails = new Set([complete, noted, clipped, trimmed, replaced].map((r) => String(r?.report || '')));
ok(tails.size === 5, '…and the five `report` lines differ too, since some clients only read that');
ok(/no re-save is needed/i.test(String(clipped?.report)),
  'the clipped report carries the same acquittal as its meaning — the two surfaces cannot disagree',
  String(clipped?.report));

section('§6 · ANTI-VACUITY — the pre-fix classifier could not tell these apart');

const OLD_RE = /\b(dropped|omitted|truncated)\b/i;
const clipHitsOld = (clipped?.notes || []).some((n) => OLD_RE.test(n));
const trimHitsOld = (trimmed?.notes || []).some((n) => OLD_RE.test(n));
ok(clipHitsOld && trimHitsOld,
  'CONTROL: the deleted regex matches BOTH fixtures — so §2 passing is a real discrimination, not two notes that never collided');
ok(clipped.save_kind !== trimmed.save_kind,
  '…and the shipped classifier separates exactly the pair the old one merged');
// And the drift in the OTHER direction: three loss words the local copy missed.
ok(['rejected', 'discarded', 'lost'].every((w) => !OLD_RE.test(`nowState: content ${w}`)
    && classifySaveNotes([`nowState: content ${w}`]) === 'trimmed'),
  'CONTROL: `rejected` / `discarded` / `lost` were invisible to the deleted regex and ARE body loss to the store — the second drift the deletion closes');

console.log(`\n${'─'.repeat(56)}\nPassed: ${passed}   Failed: ${failed}`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
}
process.exit(failed ? 1 : 0);
