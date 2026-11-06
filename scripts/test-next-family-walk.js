#!/usr/bin/env node
/**
 * test-next-family-walk.js — A FAMILY AT THE REVIEW DESK, offline.
 *
 * The real desk (views/health-review.js) and the real grouping and words
 * (views/health-family.js) over the stand-in for domains.js, plus the real server function that
 * reads the facts, on a generated wiki. What only a browser can say (0 px across a decision, the
 * 500 ms measured, focus and keys, text on disk through the real routes) is e2e-family-walk.mjs.
 *
 * OFFLINE. No network, no browser, no user data.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deskFixture, pair, comparison } from './test-helpers/review-desk-fixture.js';
import { walksToStore, restoreWalks, worstSlots, walkPagesWithNoPair, planDecisions, connectedGroups, relationOf, applyFacts, newFamily, orderFor, matchedWith, leftovers, SHOW_MARKS, renderMarks } from '../src/public/next/views/health-family.js';
import { wordAllowed, BANNED } from './test-helpers/health-words.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0; let failed = 0;
function ok(c, m, d) { if (c) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + m); } else { failed++; console.log('  \x1b[31m✗\x1b[0m ' + m + (d === undefined ? '' : ' — ' + String(d).slice(0, 700))); } }
const section = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').replace(/ ([.,:])/g, '$1').replace(/ "([.,])/g, '"$1');
const buttonOf = (html, id) => (new RegExp('<button[^>]*id="' + id + '"[^>]*>').exec(html) || [''])[0];
const shut = (html, id) => / disabled/.test(buttonOf(html, id));
const c = (s) => 'concepts/' + s;
const NOTE = 'If you use GitHub Sync, changes can be undone with a git client — the app has no Undo button yet.';

// A~B, B~C, C~D, and one the AI said is not the same. A is never compared with C or D.
const CHAIN = () => [pair('b', 'a', { rationale: 'A and B match.' }), pair('c', 'b', { rationale: 'B and C match.' }), pair('d', 'c', { rationale: 'C and D match.' })];
const FACTS = (extra = {}) => ({
  pages: ['a', 'b', 'c', 'd', 'e'].map((s, i) => ({ page: c(s), folder: 'concepts', slug: s, exists: true, opening: 'Opening of ' + s + '.', length: 1000 + i * 100, links: 10 - i })),
  answers: [
    { a: c('a'), b: c('b'), compared: 'same', rationale: 'A and B match.' },
    { a: c('b'), b: c('c'), compared: 'same', rationale: 'B and C match.' },
    { a: c('c'), b: c('d'), compared: 'same', rationale: 'C and D match.' },
    { a: c('a'), b: c('e'), compared: 'different', rationale: 'E is another subject.' },
    { a: c('d'), b: c('e'), compared: 'same', rationale: 'D and E match.' },
    ...(extra.answers || []),
  ],
  kept: extra.kept || [],
});
function family(pairs, over = {}) {
  const facts = over.facts || FACTS(over);
  const fx = deskFixture(pairs, { deps: { familyFacts: async (slug, pages, textOf) => {
    fx.calls.facts = (fx.calls.facts || 0) + 1;
    if (!textOf) fx.calls.factsWhole = (fx.calls.factsWhole || 0) + 1;
    if (fx.nextFacts) { const e = fx.nextFacts; fx.nextFacts = null; throw new Error(e); }
    if (textOf) return { pages: [{ page: textOf, exists: true, length: 4242, links: 21 }], answers: [], kept: [], keptText: { text: '# ' + textOf + '\n\n## Merged from x\n', truncated: false } };
    return { ...facts, pages: facts.pages.filter((p) => pages.includes(p.page)), answers: facts.answers };
  }, keepApart: async (slug, p) => { fx.calls.apart = [...(fx.calls.apart || []), fx.key(p)]; if (fx.nextApart && fx.calls.apart.length === fx.nextApart.at) throw new Error(fx.nextApart.error); }, reload: () => { fx.calls.reload = (fx.calls.reload || 0) + 1; }, note: NOTE, ...(over.deps || {}) } });
  return fx;
}
function deskFixtureFor(pairs, facts) { return family(pairs, { facts }); }
async function opened(pairs, over) { const fx = family(pairs || CHAIN().concat([pair('e', 'd', { rationale: 'D and E match.' })]), over); fx.desk.open(); await fx.paint(); return fx; }
const pick = async (fx, page) => { await fx.press('', { famPick: c(page) }); await fx.paint(); };
const fam = (fx) => fx.state.review.family;

section('§1 Which pairs are a family');
{
  const g = connectedGroups(CHAIN().map((p, at) => ({ at, pair: p })));
  ok(g.length === 1 && g[0].pages.join() === [c('a'), c('b'), c('c'), c('d')].join(), 'pairs sharing pages join');
  const scan = { pairs: [pair('x', 'y'), ...CHAIN(), pair('p', 'q')] };
  const items = planDecisions(scan);
  ok(items.map((i) => i.kind).join() === 'pair,family,pair', 'pairs in no family stay pairs, in their place', items.map((i) => i.kind).join());
  ok(planDecisions({ pairs: [pair('x', 'y'), pair('p', 'q')] }) === null, 'no shared page: no list, the plain pair desk');
  ok(planDecisions({ pairs: [pair('a', 'b'), pair('b', 'a', { status: 'skipped' })] }) === null, 'a family of two is a pair');
  const fx = deskFixture([pair('a', 'b'), pair('c', 'd')], { deps: { familyFacts: async () => { throw new Error('never called'); } } });
  fx.desk.open(); await fx.paint();
  ok(text(fx.html()).includes('Pair 1 of 2') && !/Family/.test(text(fx.html())), 'and it looks exactly as before');
}

section('§2 A~B and B~C are never A~C');
{
  const f = newFamily([c('a'), c('b'), c('c'), c('d'), c('e')]);
  applyFacts(f, FACTS(), CHAIN());
  ok(relationOf(f, c('b'), c('a')).kind === 'same', 'a direct answer is what it says');
  ok(relationOf(f, c('c'), c('a')).kind === 'never', 'A~B and B~C leave A and C at never');
  ok(relationOf(f, c('d'), c('a')).kind === 'never', 'and two steps away too');
  ok(relationOf(f, c('e'), c('a')).kind === 'different', 'not the same is its own answer');
  // Every page against every page: only a pair the server answered is ever anything but never.
  const answered = new Set(FACTS().answers.flatMap((a) => [a.a + '|' + a.b, a.b + '|' + a.a]));
  let wrong = 0; let checked = 0;
  for (const x of f.pages) for (const y of f.pages) { if (x === y) continue; checked++; const kind = relationOf(f, x, y).kind; if ((kind === 'never') === answered.has(x + '|' + y)) wrong++; }
  ok(checked === 20 && wrong === 0, 'for every page as the one that stays, against every other: the direct answer or never', wrong);
  ok(matchedWith(f, c('c'), c('a')) === c('b'), 'it names the page it really was matched with');
  ok(orderFor(f, c('a')).join() === [c('b'), c('c'), c('d'), c('e')].join(), 'same first, then never, then not the same');
  const stale = newFamily([c('a'), c('b'), c('c')]);
  applyFacts(stale, { pages: FACTS().pages.slice(0, 3), answers: [{ a: c('a'), b: c('c'), compared: 'stale' }, { a: c('a'), b: c('b'), compared: 'same', rationale: 'r' }] }, []);
  ok(orderFor(stale, c('a')).join() === [c('b'), c('c')].join() && relationOf(stale, c('c'), c('a')).kind === 'stale', 'an answer about older text is neither compared nor never');
}

section('§3 Step 1: which page stays');
{
  const fx = family(CHAIN());
  fx.desk.open();
  const before = fx.html();
  ok(text(before).includes('Family of 4 pages') && text(before).includes('Decision 1 of 1') && /data-fam-pick=/.test(before) && / disabled/.test((/<button[^>]*data-fam-pick[^>]*>/.exec(before) || [''])[0]), 'before the facts are read nothing can be pressed: it could not yet say what it knows');
  await fx.paint();
  const h = fx.html(); const t = text(h);
  ok(t.includes('4 pages, 34 links pointing to them, 4.6 KB of text. The AI compared 3 of the 6 possible pairs here. A match between two pages says nothing about a third.'), 'the one sentence: pages, links, text, how much was compared', t.slice(0, 300));
  ok(t.includes('Which page stays?') && t.includes('Press it. Nothing is merged yet: the others then come up one at a time, beside it, for you to decide.'), 'the one question');
  ok(t.includes('10 links · 1 KB · AI compared it with 1 of the other 3'), 'a row: links, size, how far it was compared', t);
  ok(/aria-label="Read full page: a"/.test(h), 'Read is named for a screen reader');
  ok(!/type="radio"|type="checkbox"|checked/.test(h), 'nothing is ticked: there is nothing to tick');
  ok(fx.calls.merge.length === 0 && fx.calls.keep.length === 0, 'opening it does nothing');
  ok(t.includes('Keep all 4 apart') && t.includes('Different things that only look alike?'), 'the way out is there');
  ok(!/btn-primary/.test(h), 'no violet on any choice');
  await fx.press('', { famRead: c('b') });
  ok(fx.calls.read[0] === 'concepts/b.md|b', 'Read opens the reader on that page');
  await fx.press('', { famPick: 'concepts/not-in-this-family' });
  ok(fam(fx).stays === null, 'a page not in the family cannot be chosen');
  const big = Array.from({ length: 30 }, (_, i) => pair('page-' + i, i ? 'page-' + (i - 1) : 'hub'));
  const pages = ['hub', ...big.map((p) => p.removeSlug)];
  const fb = await opened(big, { facts: { pages: pages.map((s, i) => ({ page: c(s), folder: 'concepts', slug: s, exists: true, opening: 'o', length: 100, links: 40 - i })), answers: big.map((p) => ({ a: c(p.keepSlug), b: c(p.removeSlug), compared: 'same', rationale: 'r' })), kept: [] } });
  ok((fb.html().match(/data-fam-pick=/g) || []).length === 8 && text(fb.html()).includes('Show the other 23'), 'at 31 pages it shows 8 and offers the rest');
  ok(/id="hr-fam-find"/.test(fb.html()) && /placeholder="Find a page in this family"/.test(fb.html()), 'and a way to find one');
  fam(fb).q = 'page-29';
  ok((fb.html().match(/data-fam-pick=/g) || []).length === 1, 'finding finds, past the first 8');
  fam(fb).q = 'zzz';
  ok(text(fb.html()).includes('No page in this family has that in its name.'), 'and says when nothing matches');
  fam(fb).q = '';
  await fb.press('hr-fam-show');
  ok((fb.html().match(/data-fam-pick=/g) || []).length === 31, 'Show the other shows them');
  const mixed = family([pair('x', 'y'), ...CHAIN()]);
  mixed.desk.open(); await mixed.paint();
  ok(text(mixed.html()).includes('Pair 1 of 1'), 'in a mixed list a pair is still a pair');
  await mixed.press('hr-next'); await mixed.paint();
  ok(text(mixed.html()).includes('Family of 4 pages') && text(mixed.html()).includes('Decision 2 of 2'), 'and Next reaches the family, recording nothing');
  await mixed.press('hr-next'); await mixed.paint();
  ok(text(mixed.html()).includes('Pair 1 of 1'), 'and goes on round');
  const failing = family(CHAIN());
  failing.nextFacts = 'the disk went away';
  failing.desk.open(); await failing.paint();
  ok(text(failing.html()).includes('Could not load the comparison: the disk went away') && /id="hr-retry"/.test(failing.html()), 'facts that fail say so, with Try again');
  ok(/ disabled/.test((/<button[^>]*data-fam-pick[^>]*>/.exec(failing.html()) || [''])[0]), 'and no page can be chosen on what is not known');
  await failing.press('hr-retry'); await failing.paint();
  ok(text(failing.html()).includes('The AI compared 3 of the 6') && !text(failing.html()).includes('Could not load'), 'Try again reads them');
}

section('§4 The walk: the same desk, the same gate');
{
  const fx = await opened();
  ok(fx.scan.walkPairs === undefined || fx.scan.walkPairs.length === 0, 'choosing has not started until a page is pressed');
  await pick(fx, 'a');
  let h = fx.html(); let t = text(h);
  ok(t.includes('Family of 5 pages') && t.includes('Page 1 of 4 · 0 merged · 0 kept · 4 left'), 'the count', t.slice(0, 120));
  ok(t.includes('a stays.') && /id="hr-fam-rechoose"/.test(h) && t.includes('Choose again'), 'the running line, and it can still change', t);
  ok(/class="hr-pane hr-pane-goes"[^>]*aria-label="Page that goes away: b"/.test(h) && /aria-label="Page that stays: a"/.test(h), 'the same panes, named');
  ok(t.includes('Merge b into a') && /aria-label="Merge b into a"/.test(h), 'Merge names both pages');
  ok(t.includes('Merging deletes b.') && t.includes('otherwise it cannot be undone'), 'the deletion and the pinned warning are on screen');
  ok(/btn btn-danger" id="hr-merge"/.test(h) && !/btn-primary/.test(h), 'Merge is the danger button, never primary');
  ok(t.includes('The AI compared these two pages and said they are the same.') && t.includes('The AI says: "A and B match."'), 'what the AI knows about THIS pair');
  ok(t.includes('Lists from b join the sections of the same name, and everything else moves under "Merged from b". 4 links move to it.'), 'the after line, as agreed', t);
  ok(shut(h, 'hr-merge'), 'the gate is shut on arrival');
  await fx.press('hr-merge');
  ok(fx.calls.merge.length === 0, 'a press before it opens reaches nothing');
  ok(fx.seen() && !shut(fx.html(), 'hr-merge'), 'seen for this exact direction, it opens');
  const firstKey = 'concepts/a||concepts/b';
  ok(fx.calls.compare.includes(firstKey), 'the comparison asked for is stays against this page');
  ok(fx.scan.bases[firstKey], 'and its basis is held for the merge');
  await fx.press('hr-merge');
  ok(fx.calls.merge[0] === firstKey, 'one press, one merge');
  t = text(fx.html());
  ok(t.includes('Merged b into a. 4 links moved.'), 'the outcome line', t);
  ok(t.includes('Page 2 of 4 · 1 merged · 0 kept · 3 left') && t.includes('a stays. It has taken in 1 page so far.'), 'the next page, the count', t.slice(0, 120));
  ok(!/id="hr-fam-rechoose"/.test(fx.html()) && !/id="hr-flip"/.test(fx.html()), 'after a decision the page that stays can no longer change');
  ok(fx.scan.previewed.size === 0 && shut(fx.html(), 'hr-merge'), 'the next page is shut, with no permission carried over');
  ok(/^Merged b into a\. 4 links moved\. Page 2 of 4\. The AI never compared these two pages\.$/.test(fx.state.healthLive), 'spoken: the outcome, where you are, and that it was never compared', fx.state.healthLive);

  // THE SNAPSHOT. The merge closed B~C, the only pair that brought C in.
  ok(fx.scan.pairs.find((p) => p.removeSlug === 'c').status === 'resolved', 'the cascade closed the pair that brought C in');
  ok(fam(fx).order.includes(c('c')) && fam(fx).order[fam(fx).i] === c('c'), 'and C has not left the walk');
  ok(fx.calls.factsWhole === 1, 'the facts were read once, when the family opened, and never again', fx.calls.factsWhole);
  t = text(fx.html());
  ok(t.includes('The AI never compared these two pages.') && !t.includes('The AI compared these two pages'), 'and it is never treated as compared');
  ok(t.includes('It is here because the AI matched it with b, which you have since merged in. That says nothing about a. Only your reading decides this one.'), 'it says plainly why C is here', t);

  // A resting pointer is not a press.
  await fx.paint();
  fx.overMerge = true; fx.desk.onPointer({ clientX: 5, clientY: 5, pointerType: 'mouse' });
  await fx.press('hr-next'); await fx.paint(); await fx.press('hr-prev'); await fx.paint();
  fx.seen();
  ok(shut(fx.html(), 'hr-merge') && text(fx.html()).includes('Move the pointer off Merge and back to press it.'), 'a pointer still on Merge when the page arrives must leave and come back');
  for (let i = 0; i < 30; i++) await fx.press('hr-merge');
  ok(fx.calls.merge.length === 1, '30 presses on one spot merge nothing');
  fx.overMerge = false; fx.desk.onPointer({ clientX: 500, clientY: 500, pointerType: 'mouse' });

  // Keep both.
  const keepKey = fx.key({ keepFolder: 'concepts', keepSlug: 'a', removeFolder: 'concepts', removeSlug: 'c' });
  await fx.press('hr-keep');
  ok(fx.calls.keep[0] === keepKey, 'Keep both records this pair, stays against this page');
  t = text(fx.html());
  ok(t.includes('Kept c and a apart. This pair will not come back.') && /id="hr-undo"/.test(fx.html()), 'says so, with Undo', t);
  ok(t.includes('Page 3 of 4 · 1 merged · 1 kept · 2 left'), 'and goes on');
  await fx.press('hr-undo'); await fx.paint();
  t = text(fx.html());
  ok(fx.calls.back[0] === keepKey && t.includes('Brought back c.') && t.includes('Page 2 of 4 · 1 merged · 0 kept · 3 left'), 'Undo brings the page back to the desk', t);
  ok(fx.calls.reload >= 1, 'and the figures behind it are read again');
  fx.nextBack = 'the disk went away';
  await fx.press('hr-keep');
  await fx.press('hr-undo');
  ok(text(fx.html()).includes('Could not save: the disk went away') && /id="hr-retry"/.test(fx.html()), 'an Undo that fails stays, with Try again');
  fx.nextBack = null;
  await fx.press('hr-retry'); await fx.paint();
  ok(text(fx.html()).includes('Brought back c.'), 'and Try again undoes it');

  // Next and Previous record nothing.
  const said = fx.calls.merge.length + fx.calls.keep.length;
  await fx.press('hr-next'); await fx.paint();
  await fx.press('hr-prev'); await fx.paint();
  ok(fx.calls.merge.length + fx.calls.keep.length === said, 'Next and Previous record nothing');
  ok(fx.scan.previewed.size === 0, 'and open nothing');

  // A decided page, gone back to.
  await fx.press('hr-prev'); await fx.paint();
  h = fx.html(); t = text(h);
  ok(t.includes('Merged b') || t.includes('This page no longer exists'), 'back on the merged page');
  ok(t.includes('This page no longer exists') && t.includes('Its text is on the page that stays, under Merged from b.') && t.includes('Merged into a. Nothing more to decide here.'), 'it says what happened', t);
  ok(!/id="hr-merge"|id="hr-keep"/.test(h) && !/id="hr-read-goes"/.test(h), 'no button can act on it');
  ok(!fx.calls.compare.includes('concepts/a||concepts/b') || fx.calls.compare.filter((k) => k === 'concepts/a||concepts/b').length === 1, 'it does not ask for a comparison of a page that is gone');
  ok(fam(fx).keptAt === 1 && t.includes('21 links point here') && t.includes('4.2 KB'), 'and the kept page beside it is the real one, as it is now', t);
  await fx.press('', { famJump: c('c') }); await fx.paint();
  await fx.press('hr-keep'); await fx.paint();
  await fx.press('', { famJump: c('c') }); await fx.paint();
  h = fx.html(); t = text(h);
  ok(t.includes('You kept c and a apart.') && /id="hr-undo"/.test(h) && !/id="hr-merge"/.test(h), 'back on a kept page: it says so, with Undo', t);
  ok(/Page that goes away: c/.test(h) && t.includes('Text of c'), 'and its text as usual');
}

section('§4b The AI\'s own pair follows a decision on the walk');
{
  const fx = await opened();
  await pick(fx, 'a');
  // The AI's pair is b -> a: the same two pages as the walk's, whichever way round it was stored.
  fx.scan.pairs[0] = { ...fx.scan.pairs[0], keepSlug: 'b', removeSlug: 'a' };
  fx.seen();
  await fx.press('hr-keep'); await fx.paint();
  ok(fx.scan.pairs[0].status === 'skipped', 'Keep both decides it too, or the lanes would still count it');
  await fx.press('hr-undo'); await fx.paint();
  ok(fx.scan.pairs[0].status === 'open', 'and Undo brings it back');
  ok(fx.calls.keep.length === 1 && fx.calls.keep[0] === 'concepts/a||concepts/b', 'one record, in the walk\'s direction');
}

section('§4c A decided page cannot be decided again');
{
  const fx = await opened();
  await pick(fx, 'a');
  fx.seen(); await fx.press('hr-merge'); await fx.paint();
  await fx.press('', { famJump: c('b') }); await fx.paint();
  const before = fx.calls.merge.length;
  await fx.press('hr-merge'); await fx.press('hr-keep');
  ok(fx.calls.merge.length === before && fx.calls.keep.length === 0, 'a forged press on a merged page reaches nothing');
}

section('§5 The AI\'s three answers, and the fourth');
{
  const fx = await opened();
  await pick(fx, 'a');
  await fx.press('', { famJump: c('e') }); await fx.paint();
  let t = text(fx.html());
  ok(t.includes('The AI compared these two pages and said they are not the same.') && t.includes('The AI says: "E is another subject."'), 'compared, not the same, with its reason', t);
  const never = await opened(CHAIN(), { facts: { ...FACTS(), pages: FACTS().pages.slice(0, 4), answers: FACTS().answers.slice(0, 3) } });
  await pick(never, 'a');
  await never.press('', { famJump: c('d') }); await never.paint();
  t = text(never.html());
  ok(t.includes('The AI never compared these two pages.') && t.includes('It is here because the AI matched it with c. That says nothing about a. Only your reading decides this one.'), 'never compared, naming the page it matched', t);
  ok(/hr-ev-never/.test(never.html()), 'and marked, beside its words');
  const alone = await opened(CHAIN(), { facts: { pages: FACTS().pages.slice(0, 4), answers: [{ a: c('a'), b: c('d'), compared: 'different' }], kept: [] } });
  await pick(alone, 'a');
  await alone.press('', { famJump: c('d') }); await alone.paint();
  t = text(alone.html());
  ok(t.includes('The AI compared these two pages and said they are not the same.') && t.includes('The reason it gave was not kept.'), 'an old answer with no reason says so, and quotes nothing', t);
  const old = await opened(CHAIN(), { facts: { pages: FACTS().pages.slice(0, 4), answers: [{ a: c('a'), b: c('b'), compared: 'stale' }], kept: [] } });
  await pick(old, 'b');
  await old.press('', { famJump: c('a') }); await old.paint();
  t = text(old.html());
  ok(t.includes('The AI compared older versions of these two pages.') && t.includes('Its answer no longer applies. Only your reading decides this one.'), 'a lapsed answer is not claimed', t);
  ok(!t.includes('The AI compared these two pages') && !t.includes('The AI never compared these two pages.'), 'neither compared nor never', t);
}

section('§6 Keep this one instead, Choose again, a pair kept earlier');
{
  const fx = await opened();
  await pick(fx, 'a');
  await fx.press('hr-flip'); await fx.paint();
  let t = text(fx.html());
  ok(fam(fx).stays === c('b') && t.includes('Now b stays, and a is one of the pages to go through.'), 'Keep this one instead', t);
  ok(fx.scan.previewed.size === 0 && shut(fx.html(), 'hr-merge'), 'and nothing is armed for the new direction');
  ok(t.includes('The AI compared these two pages and said they are the same.'), 'the facts are read for the new page that stays');
  await fx.press('hr-fam-rechoose'); await fx.paint();
  ok(fam(fx).stays === null && text(fx.html()).includes('Which page stays?') && (fx.scan.walkPairs || []).length === 0, 'Choose again goes back and leaves nothing behind');
  const prior = await opened(CHAIN(), { facts: { ...FACTS(), pages: FACTS().pages.slice(0, 4), answers: FACTS().answers.slice(0, 3), kept: [[c('a'), c('d')]] } });
  await pick(prior, 'a');
  t = text(prior.html());
  ok(t.includes('Page 1 of 3 · 0 merged · 1 kept · 2 left'), 'a pair you kept apart earlier counts as kept', t.slice(0, 120));
  ok(/id="hr-fam-rechoose"/.test(prior.html()) && /id="hr-flip"/.test(prior.html()), 'and is not a decision made here: the page can still change');
  ok(!prior.calls.keep.length, 'and is not recorded again');
}

section('§7 Stop any time; the end');
{
  const fx = await opened();
  await pick(fx, 'a');
  await fx.press('hr-done');
  ok(fx.state.review === null && fx.calls.closed[0] === 0, 'Done with no decision goes back and says nothing');
  fx.desk.open(); await fx.paint();
  ok(fam(fx).stays === c('a') && text(fx.html()).includes('Page 1 of 4'), 'the family is still there, with the page chosen');
  fx.seen(); await fx.press('hr-merge'); await fx.paint();
  fx.seen(); await fx.press('hr-keep'); await fx.paint();
  await fx.press('hr-done'); await fx.paint();
  let h = fx.html(); let t = text(h);
  ok(t.includes('2 pages not decided') && /id="hr-fam-back"/.test(h) && t.includes('Go back to them'), 'Done after a decision: the summary, and a way back', t.slice(0, 160));
  ok(t.includes('Took in 1 page. Links pointing to it went from 10 to 21, its text from 1 KB to 4.2 KB.'), 'the card: the real figures', t);
  ok(t.includes('Merged in') && t.includes('1 page deleted') && t.includes('Kept both') && t.includes('1 page kept') && t.includes('Not decided') && t.includes('2 pages waiting'), 'the three rows with their counts on show');
  ok(t.includes(NOTE), 'and the pinned note');
  ok(!t.includes('You merged'), 'a page the AI did compare gets no such line');
  fx.state.expandedGroups.add('reviewFamMerged'); fx.state.expandedGroups.add('reviewFamKept'); fx.state.expandedGroups.add('reviewFamLeft');
  t = text(fx.html());
  ok(t.includes('Their text is on a, each under "Merged from" and its name.') && t.includes('These stay separate from a, and that pair will not come back.') && t.includes('Nothing happened to these.'), 'each row explains itself', t);
  ok(/data-fam-undo="concepts\/c"/.test(fx.html()), 'a kept page can be undone from here');
  await fx.press('hr-done');
  ok(fx.state.review === null && fx.calls.closed[1] === 1, 'Done leaves, and the lanes are told what was merged');
  fx.desk.open(); await fx.paint();
  t = text(fx.html());
  ok(t.includes('You chose a earlier. 1 merged, 1 kept, 2 left.') && t.includes('Page 3 of 4'), 'coming back: remembered, and it says so', t.slice(0, 300));
  // A family left half done must not stand in front of everything else.
  const lastly = await opened([pair('x', 'y'), ...CHAIN()]);
  await lastly.press('hr-next'); await lastly.paint();
  await pick(lastly, 'a');
  await lastly.press('hr-done');
  lastly.desk.open(); await lastly.paint();
  ok(text(lastly.html()).includes('Pair 1 of 1'), 'a family you left does not come first: the rest can be reached', text(lastly.html()).slice(0, 100));
  await lastly.press('hr-next'); await lastly.paint();
  ok(text(lastly.html()).includes('Page 1 of') && text(lastly.html()).includes('a stays.'), 'and Next reaches it, remembered');
  await lastly.press('hr-done');
  lastly.scan.pairs[0].status = 'merged';
  lastly.desk.open(); await lastly.paint();
  ok(text(lastly.html()).includes('a stays.'), 'with nothing else left it opens by itself');

  // Leftovers.
  const walk = await opened();
  await pick(walk, 'a');
  walk.seen(); await walk.press('hr-merge'); await walk.paint();        // b merged
  await walk.press('hr-keep'); await walk.paint();                       // c kept
  await walk.press('hr-keep'); await walk.paint();                       // d kept
  await walk.press('hr-keep'); await walk.paint();                       // e kept
  t = text(walk.html());
  ok(t.includes('All decided'), 'every page decided', t.slice(0, 100));
  ok(t.includes('3 pages left over still match one another, so they may be a smaller family of their own.') && t.includes('Review those 3'), 'the pages left over are offered', t);
  ok(leftovers(fam(walk), walk.scan.pairs).length === 1, 'as one family, because C~D and D~E share D');
  ok(!leftovers(fam(walk), walk.scan.pairs)[0].pages.includes(c('a')), 'and the page that stays is never one of them');
  await walk.press('hr-fam-residue'); await walk.paint();
  t = text(walk.html());
  ok(t.includes('Family of 3 pages') && t.includes('Which page stays?'), 'Review those 3: a smaller family, from the start', t.slice(0, 160));
  ok(fam(walk).stays === null && walk.calls.facts >= 3, 'its facts read afresh');

  const small = await opened(CHAIN().slice(1).concat([pair('b', 'a')]));
  await pick(small, 'a');
  small.seen(); await small.press('hr-keep'); await small.paint();
  await small.press('hr-keep'); await small.paint();
  await small.press('hr-keep'); await small.paint();
  ok(text(small.html()).includes('Review those 3'), 'three left over');
  const two = await opened([pair('b', 'a'), pair('c', 'a'), pair('c', 'd')], { facts: { pages: FACTS().pages.slice(0, 4), answers: [{ a: c('a'), b: c('b'), compared: 'same', rationale: 'r' }, { a: c('a'), b: c('c'), compared: 'same', rationale: 'r' }, { a: c('c'), b: c('d'), compared: 'same', rationale: 'r' }], kept: [] } });
  await pick(two, 'a');
  two.seen(); await two.press('hr-merge'); await two.paint();
  two.seen(); await two.press('hr-keep'); await two.paint();
  await two.press('hr-keep'); await two.paint();
  ok(text(two.html()).includes('Review those 2'), 'two left over are offered');
  await two.press('hr-fam-residue'); await two.paint();
  ok(text(two.html()).includes('Pair 1 of 1') && !text(two.html()).includes('Family'), 'and two pages open as a pair', text(two.html()).slice(0, 120));

  // A merge can close the only pair naming a page still waiting. The lanes must still offer the walk.
  const quiet = await opened([pair('b', 'a'), pair('c', 'b')], { facts: { pages: FACTS().pages.slice(0, 3), answers: FACTS().answers.slice(0, 2), kept: [] } });
  await pick(quiet, 'a');
  quiet.seen(); await quiet.press('hr-merge'); await quiet.paint();
  await quiet.press('hr-done'); await quiet.paint();
  ok(text(quiet.html()).includes('1 page not decided'), 'c waits, with no open pair left to name it');
  await quiet.press('hr-done');
  ok(quiet.scan.pairs.every((p) => p.status !== 'open') && quiet.scan.walkWaiting === 1, 'the lanes are told, so Review is still offered', quiet.scan.walkWaiting);
  ok(quiet.desk.open() === true && text(quiet.html()).includes('a stays.'), 'and it opens on the walk');

  // Who can be left over.
  const lo = await opened();
  await pick(lo, 'a');
  ok(leftovers(fam(lo), lo.scan.pairs).every((g) => !g.pages.includes(c('a'))) && leftovers(fam(lo), lo.scan.pairs).length === 1, 'the page that stays is never left over, even with its own pairs open');
  lo.scan.pairs.forEach((p, i) => { lo.scan.pairs[i] = { ...p, status: 'skipped' }; });
  ok(leftovers(fam(lo), lo.scan.pairs).length === 0, 'a pair kept apart does not make anything left over');

  // Merged with no comparison: named on the way out.
  const nv = await opened(CHAIN(), { facts: { ...FACTS(), pages: FACTS().pages.slice(0, 4), answers: FACTS().answers.slice(0, 3) } });
  await pick(nv, 'a');
  nv.seen(); await nv.press('hr-merge'); await nv.paint();
  nv.seen(); await nv.press('hr-merge'); await nv.paint();
  nv.seen(); await nv.press('hr-merge'); await nv.paint();
  t = text(nv.html());
  ok(t.includes('You merged 2 pages the AI never compared with a: c and d. Only your reading decided them.'), 'a line names any page merged without a comparison', t);
  nv.state.expandedGroups.add('reviewFamMerged');
  ok((text(nv.html()).match(/the AI never compared it/g) || []).length === 2, 'and marks it in the list');
  await nv.press('hr-done');
  ok(nv.scan.families[0].retired === true, 'finished, it is over: it does not come back');
  ok(nv.desk.open() === false, 'with nothing left, the desk has nothing to open');
}

section('§8 Keep all apart');
{
  const fx = await opened([pair('x', 'y'), ...CHAIN()]);
  await fx.press('hr-next'); await fx.paint();
  await fx.press('hr-fam-apart'); await fx.paint();
  let t = text(fx.html());
  ok(fx.calls.apart.length === 3, 'every pair the AI matched here is kept apart, and no other', fx.calls.apart);
  ok(fx.calls.merge.length === 0, 'and nothing is merged');
  ok(t.includes('Kept these 4 pages apart. They will not come back. Pairs the AI has not compared may still come up later.') && /id="hr-undo"/.test(fx.html()), 'the sentence, with Undo', t);
  ok(fx.scan.pairs.slice(1).every((p) => p.status === 'skipped'), 'the pairs are decided');
  ok(t.includes('Pair 1 of 1'), 'and the desk goes on to what still waits', t.slice(0, 100));
  await fx.press('hr-undo'); await fx.paint();
  t = text(fx.html());
  ok(t.includes('Brought back.') && t.includes('Which page stays?') && fx.scan.pairs.slice(1).every((p) => p.status === 'open') && fx.calls.back.length === 3, 'Undo brings the family back', t.slice(0, 160));
  const half = await opened();
  half.nextApart = { at: 2, error: 'the disk went away' };
  await half.press('hr-fam-apart'); await half.paint();
  t = text(half.html());
  ok(t.includes('Could not save: the disk went away') && /id="hr-retry"/.test(half.html()), 'a failure says so, with Try again');
  ok(half.calls.back.length === 1 && half.scan.pairs.every((p) => p.status === 'open'), 'and takes back what it had done: nothing half kept');
  ok(fam(half).keptAll === null, 'the family still waits');
}

section('§9 A failure stays; a page that went');
{
  const fx = await opened();
  await pick(fx, 'a');
  fx.seen();
  fx.nextMerge = { error: 'Could not merge: the disk went away' };
  await fx.press('hr-merge');
  let t = text(fx.html());
  ok(t.includes('Could not merge: the disk went away') && /id="hr-retry"/.test(fx.html()) && fam(fx).order[fam(fx).i] === c('b') && !fam(fx).dec[c('b')], 'a failed merge stays on the page, decided nothing', t);
  fx.nextMerge = { merged: true, alsoResolved: 0 };
  await fx.press('hr-retry');
  ok(fx.calls.merge.length === 2 && fam(fx).dec[c('b')] === 'merged', 'Try again merges it, through the same gate');
  const st = await opened();
  await pick(st, 'a');
  st.seen();
  st.nextMerge = { stale: true };
  await st.press('hr-merge'); await st.paint();
  t = text(st.html());
  ok(t.includes('This page changed since you compared it. The comparison has been refreshed.') && st.scan.previewed.size === 0 && shut(st.html(), 'hr-merge'), 'a page changed: refused, read again, shut again', t);
  ok(st.calls.compare.filter((k) => k === 'concepts/a||concepts/b').length === 2, 'it really was read again');
  ok(!fam(st).dec[c('b')], 'and nothing is recorded');
  const bad = family(CHAIN());
  bad.desk.open(); await bad.paint();
  await bad.press('', { famPick: c('a') });
  bad.nextCompare = { error: 'the disk went away' };
  await bad.paint();
  t = text(bad.html());
  ok(t.includes('Could not load the comparison: the disk went away') && /id="hr-retry"/.test(bad.html()) && shut(bad.html(), 'hr-merge'), 'a comparison that fails: Merge stays shut');
  await bad.press('hr-retry'); await bad.paint();
  ok(bad.seen() && !shut(bad.html(), 'hr-merge'), 'and Try again can open it');
  const gone = family(CHAIN());
  gone.desk.open(); await gone.paint();
  await gone.press('', { famPick: c('a') });
  gone.nextCompare = { settled: true, missing: c('b') };
  await gone.paint();
  t = text(gone.html());
  ok(t.includes('This page is settled: b no longer exists. Moving on.') && !fam(gone).order.includes(c('b')), 'a page gone from under the walk leaves it, and says so', t);
  ok(t.includes('Page 1 of 2'), 'and is not counted as merged or kept');
  const staysGone = await opened([pair('x', 'y'), ...CHAIN()]);
  await staysGone.press('hr-next'); await staysGone.paint();
  await staysGone.press('', { famPick: c('a') });
  staysGone.nextCompare = { settled: true, missing: c('a') };
  await staysGone.paint();
  t = text(staysGone.html());
  ok(t.includes('This page is settled: a no longer exists. Moving on.') && staysGone.scan.families[0].retired === true && t.includes('Pair 1 of 1'), 'the page that stays gone: the family ends, and says why', t.slice(0, 200));
}

section('§9b The second review: what real data showed');
{
  // 1. Every long name and the whole warning are what a slot is measured for.
  const LONG = 'x'.repeat(200); const LONG2 = 'y'.repeat(180);
  const w = worstSlots({ goes: LONG, stays: LONG2, warn: 'THE-WARNING', family: true });
  ok(w['.hr-decide'].html.includes('Merge <span class="mono">' + LONG + '</span> into <span class="mono">' + LONG2 + '</span>') && w['.hr-decide'].html.includes('THE-WARNING'), '1. the decision slot is measured with both whole names and the whole warning');
  ok(w['.hr-running'].html.includes(LONG2) && w['.hr-running'].html.includes('Choose again'), '1. the running line with the page that stays and Choose again');
  ok(w['.hr-pane-head'].html.join().includes(LONG) && w['.hr-pane-head'].html.join().includes(LONG2) && w['.hr-pane-head'].html.join().includes('links point here'), '1. the pane heads with both names and the links count');
  ok(w['.hr-after'].html.includes(LONG) && w['.hr-outcome'].html.includes('Undo'), '1. the after line and the outcome with its Undo');
  const css = readFileSync(join(ROOT, 'src/public/next/views/health-review.css'), 'utf8');
  ok(!/line-clamp/.test(css.slice(css.indexOf('.hr-merge-label'), css.indexOf('.hr-note'))) && !/\.hr-merge-label \{[^}]*clamp/.test(css), '1. no name is cut on the button');

  // 2. A low-confidence same does not contradict itself.
  const un = await opened(CHAIN(), { facts: { pages: FACTS().pages.slice(0, 4), answers: [{ a: c('a'), b: c('b'), compared: 'unsure', rationale: 'Both cover the same subject.' }, ...FACTS().answers.slice(1, 3)], kept: [] } });
  ok(text(un.html()).includes('The AI compared 3 of the 6'), '2. it counts as compared');
  await pick(un, 'a');
  await un.press('', { famJump: c('b') }); await un.paint();
  let t = text(un.html());
  ok(t.includes('The AI leaned towards these two pages being the same, but was not sure.') && t.includes('The AI says: "Both cover the same subject."'), '2. it says what the AI did, with its reason', t);
  ok(!t.includes('said they are not the same') && !t.includes('said they are the same'), '2. and neither of the plain answers');
  ok(t.includes('1 it was unsure about'), '2. the marks say so');
  un.state.expandedGroups.add('reviewFamily');
  ok(text(un.html()).includes('The AI was unsure whether these are the same as a (1)'), '2. the list says so');

  // 3. The button does what it says, or says what it does.
  const split = [pair('b', 'a'), pair('c', 'b'), pair('d', 'c'), pair('p', 'c'), pair('q', 'p')];
  const pagesOf = ['a', 'b', 'c', 'd', 'p', 'q'];
  const facts3 = { pages: pagesOf.map((s, i) => ({ page: c(s), folder: 'concepts', slug: s, exists: true, opening: 'o', length: 100, links: 9 - i })), answers: split.map((p) => ({ a: c(p.keepSlug), b: c(p.removeSlug), compared: 'same', rationale: 'r' })), kept: [] };
  const lo = await opened(split, { facts: facts3 });
  await pick(lo, 'a');
  // b goes, c stays apart: d~c and p~c are closed by Keep? No: only a's pairs are decided. So p~c, q~p, d~c remain one group.
  lo.seen(); await lo.press('hr-merge'); await lo.paint();
  await lo.press('hr-done'); await lo.paint();
  t = text(lo.html());
  ok(t.includes('Review those 4') && t.includes('4 pages left over'), '3. one group: the words as agreed', t);
  await lo.press('hr-fam-residue'); await lo.paint();
  t = text(lo.html());
  ok(t.includes('Family of 4 pages'), '3. Review those 4 opens 4', t.slice(0, 80));
  ok(t.includes('The walk for a is still there, with 4 pages not decided. Next reaches it.'), '3. and the walk it left is not ended silently: it says so', t);
  ok(lo.scan.families.some((f) => f.stays === c('a') && !f.retired), '3. and it really is still there');
  // Two groups: the count on the button is what opens.
  const two = await opened([pair('b', 'a'), pair('c', 'b'), pair('d', 'c'), pair('e', 'b'), pair('f', 'e'), pair('g', 'f')], { facts: { pages: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s, i) => ({ page: c(s), folder: 'concepts', slug: s, exists: true, opening: 'o', length: 100, links: 9 - i })), answers: [], kept: [] } });
  await pick(two, 'a');
  fam(two).dec[c('b')] = 'merged'; fam(two).mergedOrder.push(c('b'));
  two.scan.pairs.forEach((p, i) => { if (p.keepSlug === 'b' || p.removeSlug === 'b') two.scan.pairs[i] = { ...p, status: 'resolved' }; });
  await two.press('hr-done'); await two.paint();
  t = text(two.html());
  ok(t.includes('in 2 separate groups') && t.includes('Review the first 2') && !t.includes('Review those'), '3. several groups: it says so, and the button counts what it opens', t);
  await two.press('hr-fam-residue'); await two.paint();
  t = text(two.html());
  ok(t.includes('Pair') || t.includes('Family of 2'), '3. the first group opens', t.slice(0, 120));
  ok(t.includes('These are 2 of the 5 pages left over. The other groups come up after them.'), '3. and it says the rest come next', t);
  ok(two.state.review.items.filter((it) => it.kind === 'family' && !it.fam.stays).length === 1, '3. the rest really are next');

  // 4. A walk's arrival brings its title into view.
  let brought = 0;
  const seenT = await opened(undefined, { deps: { titleIntoView: () => { brought++; } } });
  ok(brought === 1, '4. opening a family brings the title into view', brought);
  await pick(seenT, 'a');
  ok(brought === 2, '4. pressing the page that stays brings it into view', brought);
  seenT.seen(); await seenT.press('hr-merge');
  ok(brought === 3, '4. and so does each decision', brought);
  await seenT.press('hr-next');
  ok(brought === 4, '4. and Next', brought);

  // 5. Stale says what changed.
  const lapse = (extra) => opened(CHAIN(), { facts: { pages: FACTS().pages.slice(0, 4), answers: [{ a: c('a'), b: c('b'), compared: 'stale', ...extra }, ...FACTS().answers.slice(1, 3)], kept: [] } });
  const onB = async (f) => { await pick(f, 'a'); await f.press('', { famJump: c('b') }); await f.paint(); return text(f.html()); };
  t = await onB(await lapse({ changed: 'model', model: 'gemini-old' }));
  ok(t.includes('The AI compared these two pages on another model, gemini-old.') && !t.includes('older versions'), '5. a model change says a model change', t);
  t = await onB(await lapse({ changed: 'prompt' }));
  ok(t.includes('when the app asked it differently') && !t.includes('older versions'), '5. a changed question says that');
  t = await onB(await lapse({ changed: 'text' }));
  ok(t.includes('The AI compared older versions of these two pages.'), '5. and changed text says older versions');

  // 6. A reload: pages come back, truthfully.
  let stored = [];
  const before = await opened([pair('b', 'a'), pair('c', 'b')], { facts: { pages: FACTS().pages.slice(0, 3), answers: FACTS().answers.slice(0, 2), kept: [] }, deps: { saveWalks: (s, w) => { stored = w; } } });
  await pick(before, 'a');
  before.seen(); await before.press('hr-merge'); await before.paint();
  ok(stored.length === 1 && stored[0].stays === c('a') && stored[0].pages.join() === c('c'), '6. what is left is kept: the page that stays and the page still waiting', JSON.stringify(stored));
  // A new page load: the merged pair is gone, nothing names c.
  const after = deskFixtureFor([], { pages: [FACTS().pages[0], FACTS().pages[2]], answers: [], kept: [] });
  restoreWalks(after.scan, JSON.parse(JSON.stringify(stored)));
  ok(after.scan.walkWaiting === 1, '6. the lanes know, with no pair naming it');
  ok(after.desk.open() === true, '6. Review opens on it');
  await after.paint();
  t = text(after.html());
  ok(t.includes('Family of 2 pages') && t.includes('You chose a earlier. 1 page is still waiting.') && t.includes('Page 1 of 1'), '6. it comes back in the walk, and says what it is', t.slice(0, 500));
  ok(t.includes('The AI never compared these two pages.') && t.includes('Only your reading decides this one.'), '6. and the match it had is not claimed', t);
  ok(!t.includes('since merged in'), '6. nor a merge this page load knows nothing about');
  const gate = after.scan.previewed.size;
  ok(gate === 0 && shut(after.html(), 'hr-merge'), '6. and nothing is armed');
  const noStay = deskFixtureFor([], { pages: [FACTS().pages[2]], answers: [], kept: [] });
  restoreWalks(noStay.scan, [{ stays: c('a'), pages: [c('c')] }]);
  noStay.desk.open(); await noStay.paint();
  ok(noStay.scan.families[0].retired === true, '6. the page that stayed is gone and one page is left: nothing to decide, and it says nothing false');
  ok(walkPagesWithNoPair({ pairs: [], families: [] }) === 0, '6. nothing stored: nothing waits');
  restoreWalks({ pairs: [] }, 'not an array');
  restoreWalks({ pairs: [] }, [{ stays: 3 }, null, { stays: 'concepts/a', pages: [] }]);
  ok(true, '6. a bad record is ignored');

  // Two walks left: the second can be reached.
  const pairsTwo = [pair('b', 'a'), pair('c', 'b'), pair('y', 'x'), pair('z', 'y')];
  const twoF = { pages: ['a', 'b', 'c', 'x', 'y', 'z'].map((s, i) => ({ page: c(s), folder: 'concepts', slug: s, exists: true, opening: 'o', length: 100, links: 9 - i })), answers: [], kept: [] };
  const bo = await opened(pairsTwo, { facts: twoF });
  await pick(bo, 'a'); const firstFam = fam(bo);
  await bo.press('hr-done');
  bo.desk.open(); await bo.paint();
  await pick(bo, 'x'); const secondFam = fam(bo);
  await bo.press('hr-done');
  bo.desk.open(); await bo.paint();
  ok(fam(bo) === firstFam, 'of two walks left, the one left longest ago comes up');
  await bo.press('hr-done');
  bo.desk.open(); await bo.paint();
  ok(fam(bo) === secondFam, 'and leaving it brings up the other: neither blocks the other');
}

section('§10 Every word, against the deck');
{
  const arms = [];
  const push = (label, h) => arms.push([label, h]);
  const a = family(CHAIN()); a.desk.open(); push('loading', a.html()); await a.paint(); push('choose', a.html());
  await pick(a, 'a'); push('walk', a.html()); a.seen(); push('armed', a.html());
  a.state.expandedGroups.add('reviewFamily'); push('fold', a.html()); a.state.expandedGroups.delete('reviewFamily');
  await a.press('hr-merge'); await a.paint(); push('merged', a.html());
  a.seen(); await a.press('hr-keep'); await a.paint(); push('kept', a.html());
  await a.press('hr-prev'); await a.paint(); push('back on kept', a.html());
  await a.press('hr-prev'); await a.paint(); push('back on merged', a.html());
  await a.press('hr-done'); await a.paint();
  for (const k of ['reviewFamMerged', 'reviewFamKept', 'reviewFamLeft']) a.state.expandedGroups.add(k);
  push('finish', a.html());
  let bad = [];
  for (const [label, h] of arms) {
    const body = h.replace(/<article[\s\S]*?<\/article>/g, '').replace(/<div class="hr-pane-text">[\s\S]*?<\/div>/g, '');
    const plain = body.replace(/<span class="mono">([^<]*)<\/span>/g, '$1').replace(/<\/?strong>/g, '');
    const blocks = plain.split(/<\/?(?:p|div|h4|h5|button|summary|article|header|span|details)\b[^>]*>/);
    for (const raw of blocks) {
      const line = raw.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/ ([.,:;])/g, '$1').trim();
      if (!line || /^(a|b|c|d|e)$/.test(line) || /^Opening of /.test(line)) continue;
      if (BANNED.test(line)) bad.push(label + ': BANNED: ' + line);
      else if (!wordAllowed(line)) bad.push(label + ': ' + line);
    }
  }
  ok(bad.length === 0, 'every line in every arm is one the deck allows', bad.slice(0, 12).join(' | '));
  ok(!wordAllowed('The AI thinks these are probably the same.'), 'CONTROL: an invented sentence is refused');
  const words = readFileSync(join(ROOT, 'src/public/next/views/health-family.js'), 'utf8');
  ok(!/Lost from|the text of the longer page|Merge in\b|ticked/.test(words.replace(/\/\/.*$/gm, '')), 'nothing COPY.md retired has come back');
}

section('§11 The marks can go without taking anything with them');
{
  ok(typeof SHOW_MARKS === 'boolean', 'one switch');
  const f = await opened();
  await pick(f, 'a');
  const m = renderMarks(fam(f), true);
  ok(/role="img"/.test(m) && /aria-label="4 pages to go through: 0 merged, 0 kept, 4 left"/.test(m), 'spoken as words');
  ok(/hr-marks-words/.test(m) && text(m).includes('1 the AI said is the same · 2 it never compared · 1 it said is not the same'), 'and beside them in words, singular where it should be', text(m));
  const src = readFileSync(join(ROOT, 'src/public/next/views/health-family.js'), 'utf8');
  ok(/const row = !SHOW_MARKS \? '' :/.test(src), 'false removes the row and leaves the words');
}

section('§12 What the server reads (semanticFamilyFacts)');
{
  const tmp = mkdtempSync(join(tmpdir(), 'curator-family-facts-'));
  process.env.CURATOR_TEST_USER_DATA_DIR = join(tmp, 'ud');
  mkdirSync(process.env.CURATOR_TEST_USER_DATA_DIR, { recursive: true });
  writeFileSync(join(process.env.CURATOR_TEST_USER_DATA_DIR, '.curator-config.json'), JSON.stringify({ activeProvider: 'gemini', geminiApiKey: 'AIza-FAKE-not-a-credential' }));
  const { __setDomainsDirOverride } = await import('../src/brain/config.js');
  __setDomainsDirOverride(join(tmp, 'domains'));
  const wiki = join(tmp, 'domains', 'alpha', 'wiki');
  mkdirSync(join(wiki, 'concepts'), { recursive: true });
  mkdirSync(join(wiki, 'entities'), { recursive: true });
  mkdirSync(join(wiki, 'summaries'), { recursive: true });
  const page = (t) => '---\ntype: concept\n---\n\n# ' + t + '\n\nOpening of ' + t + '.\n';
  writeFileSync(join(wiki, 'concepts', 'a.md'), page('a') + '\n[[a]] [[b]] [[concepts/b]] [[b|Bee]]\n');
  writeFileSync(join(wiki, 'concepts', 'b.md'), page('b') + '\n[[a]]\n[[b]]\n');
  writeFileSync(join(wiki, 'concepts', 'c.md'), page('c') + '\n[[summaries/a]]\n');
  writeFileSync(join(wiki, 'summaries', 's.md'), '# s\n\n[[entities/a]] [[not-here]]\n');
  writeFileSync(join(wiki, 'index.md'), '[[a]] [[a]] [[a]]\n');
  writeFileSync(join(wiki, 'log.md'), '[[a]]\n');
  const { semanticFamilyFacts, FAMILY_FACTS_MAX_PAGES } = await import('../src/brain/health-ai.js');
  const { saveDuplicateChecks, pairKey, openingsHash, pageOpening } = await import('../src/brain/duplicate-checks.js');
  const { getProviderInfo } = await import('../src/brain/llm.js');
  const info = getProviderInfo();
  const openings = { a: pageOpening(readFileSync(join(wiki, 'concepts', 'a.md'), 'utf8')), b: pageOpening(readFileSync(join(wiki, 'concepts', 'b.md'), 'utf8')), c: pageOpening(readFileSync(join(wiki, 'concepts', 'c.md'), 'utf8')) };
  const hash = (x, y) => openingsHash('concepts', x, openings[x], 'concepts', y, openings[y]);
  const promptId = (await import('../src/brain/health-ai.js')).SEMANTIC_PROMPT_ID;
  const base = { provider: info.provider, model: info.model, prompt: promptId, at: new Date().toISOString() };
  const saved = await saveDuplicateChecks('alpha', [
    [pairKey('concepts', 'a', 'concepts', 'b'), { ...base, openings: hash('a', 'b'), verdict: 'yes', keep: 'concepts/a', remove: 'concepts/b', confidence: 'high', rationale: 'Same thing.' }],
    [pairKey('concepts', 'a', 'concepts', 'c'), { ...base, openings: hash('a', 'c'), verdict: 'no', rationale: 'Different subject.' }],
    [pairKey('concepts', 'b', 'concepts', 'c'), { ...base, openings: 'an-older-hash', verdict: 'yes', keep: 'concepts/b', remove: 'concepts/c', confidence: 'high', rationale: 'Older.' }],
  ]);
  ok(saved === true, 'answers saved for the test', saved);
  const before = readFileSync(join(wiki, 'concepts', 'a.md'), 'utf8');
  const r = await semanticFamilyFacts('alpha', [c('a'), c('b'), c('c')]);
  const links = Object.fromEntries(r.pages.map((p) => [p.slug, p.links]));
  // a: from b (1), c ([[summaries/a]] 1), s (1). Its own [[a]] does not count, nor index.md or log.md.
  ok(links.a === 3, 'links to a page: a page\'s link to itself, index.md and log.md do not count', JSON.stringify(links));
  ok(links.b === 3, 'with a folder or an alias they do', JSON.stringify(links));
  ok(links.c === 0, 'nothing links here is 0');
  const ans = Object.fromEntries(r.answers.map((a) => [a.a.slice(9) + '~' + a.b.slice(9), a]));
  ok(ans['a~b'].compared === 'same' && ans['a~b'].rationale === 'Same thing.', 'a yes that applies is same, with its reason');
  ok(ans['a~c'].compared === 'different' && ans['a~c'].rationale === 'Different subject.', 'a no that applies is different, with the reason now kept');
  ok(ans['b~c'].compared === 'stale' && !ans['b~c'].rationale, 'an answer about older text is stale, and quotes nothing', JSON.stringify(ans['b~c']));
  ok(r.answers.length === 3, 'nothing is inferred: three answers in, three out');
  const noD = await semanticFamilyFacts('alpha', [c('a'), c('b')]);
  ok(noD.answers.length === 1, 'an answer naming a page outside the family stays out');
  const gone = await semanticFamilyFacts('alpha', [c('a'), c('ghost')]);
  ok(gone.pages.find((p) => p.slug === 'ghost').exists === false, 'a page that is gone says so');
  const kt = await semanticFamilyFacts('alpha', [c('a')], { textOf: c('a') });
  ok(kt.keptText.text === before && kt.pages[0].length === before.length, 'textOf gives that page\'s text as it is');
  let threw = 0;
  for (const bad of [[], null, ['../../etc/passwd'], ['summaries/s'], ['concepts/a/b']]) {
    try { await semanticFamilyFacts('alpha', bad); } catch (e) { if (e.status === 400) threw++; }
  }
  ok(threw === 5, 'anything but wiki pages is refused, status 400', threw);
  try { await semanticFamilyFacts('alpha', Array.from({ length: FAMILY_FACTS_MAX_PAGES + 1 }, (_, i) => 'concepts/p' + i)); ok(false, 'too many pages are refused'); } catch (e) { ok(e.status === 400, 'too many pages are refused, never cut short'); }
  try { await semanticFamilyFacts('alpha', [c('a')], { textOf: c('b') }); ok(false, 'textOf outside'); } catch (e) { ok(e.status === 400, 'textOf must be one of the pages'); }
  ok(readFileSync(join(wiki, 'concepts', 'a.md'), 'utf8') === before, 'it wrote nothing');
  rmSync(tmp, { recursive: true, force: true });
}

section('§13 The real gate knows a walk\'s pairs from the AI\'s');
{
  const view = readFileSync(join(ROOT, 'src/public/next/views/domains.js'), 'utf8');
  const fn = (name) => { const at = view.indexOf('function ' + name + '('); return view.slice(at, view.indexOf('\n}\n', at)); };
  ok(/semanticListOf\(s, pair\)/.test(fn('canMergeSemanticPair')), 'canMergeSemanticPair looks in the right list');
  ok(/scan\.walkPairs \|\| \[\]/.test(fn('semanticListOf')), 'and a walk\'s pairs live apart');
  ok(!/walkPairs|semanticListOf/.test(fn('resolvePairsTouching')), 'the cascade never touches them');
  ok(!/walkPairs|semanticListOf/.test(fn('liveBatchPairs')), 'nor can the batch merge one');
  const rv = readFileSync(join(ROOT, 'src/public/next/views/health-review.js'), 'utf8');
  ok(!/d\.merge\((?!r\.slug, pair, \(out\))/.test(rv) && (rv.match(/\bd\.merge\(/g) || []).length === 1, 'one call to merge in the whole desk, the same for a pair and a walk');
  ok(!/keypress|keyup|accesskey/i.test(rv.replace(/\/\/.*$/gm, '')) && (rv.match(/'keydown'/g) || []).length === 1, 'no key merges anything');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
