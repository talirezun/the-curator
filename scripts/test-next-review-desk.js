#!/usr/bin/env node
/**
 * test-next-review-desk.js — THE REVIEW DESK, offline (views/health-review.js).
 *
 * The real desk over a stand-in for domains.js (test-helpers/review-desk-fixture.js):
 * the words, what opens Merge, the walk through the pairs, a comparison that went stale
 * or failed, and a list of thousands. What only a browser can say (0 px across a
 * decision, the 500 ms measured, focus, keys) is e2e-wiki-health.mjs S16; the real gate
 * functions are test-next-semantic-gate.js.
 *
 * OFFLINE. No network, no browser, no user data.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deskFixture, pair, comparison, WARN } from './test-helpers/review-desk-fixture.js';
import { renderDesk, renderPairsFold, foldWindow, foldSummary, tally, nextWaiting, afterLine, pageBody, formatSize, FOLD_PAGE, ARM_MS, RELATION_LABELS } from '../src/public/next/views/health-review.js';
import { wordAllowed, BANNED } from './test-helpers/health-words.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0; let failed = 0;
function ok(c, m, d) { if (c) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + m); } else { failed++; console.log('  \x1b[31m✗\x1b[0m ' + m + (d === undefined ? '' : ' — ' + String(d).slice(0, 500))); } }
const section = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

const THREE = () => [pair('data-privacy', 'privacy-and-data-protection'), pair('agent', 'ai-agents', { nameRelation: 'version-differs' }), pair('hand-off', 'handoff', { nameRelation: 'spelling-variant', spellingVariant: true })];
const buttonOf = (html, id) => (new RegExp('<button[^>]*id="' + id + '"[^>]*>').exec(html) || [''])[0];
const shut = (html, id) => / disabled/.test(buttonOf(html, id));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

async function opened(pairs, over) { const fx = deskFixture(pairs || THREE(), over); fx.desk.open(); await fx.paint(); return fx; }

section('§1 The words');
{
  const fx = await opened();
  let h = fx.html();
  const t = text(h);
  ok(t.includes('Pair 1 of 3') && t.includes('0 decided · 3 left'), 'title and count', t.slice(0, 80));
  for (const w of ['Previous', 'Next', 'Done', 'Keep both', 'Read full page', 'Keep this one instead', 'Goes away', 'Stays', 'All 3 pairs']) ok(t.includes(w), 'it says ' + w);
  ok(t.includes('Merge into privacy-and-data-protection'), 'Merge names its result');
  ok(t.includes('Different names') && t.includes('The AI says: "Both pages describe one thing."'), 'the app\'s fact, and the AI quoted as the AI');
  ok(t.includes('concepts · 4 links point here · 1.1 KB') && t.includes('concepts · 11 links point here · 1.1 KB'), 'each pane: folder, links, size');
  ok(t.includes('After the merge there is one page, privacy-and-data-protection . Lists from data-privacy join the sections of the same name, and everything else moves under "Merged from data-privacy". 4 links move to it.'), 'the after line, as agreed', t);
  ok(t.includes('Merging deletes data-privacy . ' + WARN), 'the deletion and the pinned warning, byte for byte');
  ok(!/Lost from|the text of the longer page|Nothing is lost/.test(t), 'v3.91.1: nothing here says text is lost');
  ok(!/confidence/i.test(t) && !/high/.test(t), 'the confidence badge is gone from the screen');
  ok(!/confidence/.test(h), '…and from the markup');
  ok(/article class="hr-pane hr-pane-goes" aria-label="Page that goes away: data-privacy"/.test(h) && /aria-label="Page that stays: privacy-and-data-protection"/.test(h), 'the panes are named, in words');
  ok(BANNED.test('the confidence'), 'confidence is a banned word now');
  ok(!/<h1|---/.test(h.slice(h.indexOf('hr-pane-text'), h.indexOf('hr-pane-text') + 60)), 'the frontmatter does not show in a pane');

  ok(afterLine('a', 'b', 1, 'Merged from a').endsWith('1 link moves to it.'), 'after line: one link');
  ok(afterLine('a', 'b', 0, 'Merged from a').endsWith('No links move, because nothing links here.'), 'after line: no links');
  ok(!afterLine('a', 'b', 3, null).includes('everything else'), 'after line: with nothing to move it does not say something moves');
  ok(afterLine('a<b', 'c', 2, 'Merged from a<b').includes('a&lt;b') && !afterLine('a<b', 'c', 2, 'x').includes('a<b'), 'a page name is escaped');
  ok(formatSize(251) === '251 B' && formatSize(1100) === '1.1 KB' && formatSize(34000) === '34 KB', 'sizes');
  ok(pageBody('---\na: 1\n---\n\n# T\n') === '\n# T\n' && pageBody('# T\n---\nx') === '# T\n---\nx', 'only a leading frontmatter block is left out');
  const noReason = await opened([pair('a', 'b', { rationale: '' })]);
  ok(text(noReason.html()).includes('The AI gave no reason.'), 'no reason: it says so');
  const hostile = await opened([pair('a', 'b', { rationale: '<img src=x onerror=1>' })]);
  ok(!hostile.html().includes('<img') && hostile.html().includes('&lt;img'), 'the AI\'s words are escaped');
  ok(Object.keys(RELATION_LABELS).join() === 'spelling-variant,version-differs,different-names', 'three facts, all from the server');
}

section('§2 What opens Merge');
{
  ok(ARM_MS === 500, 'the wait is 500 ms');
  const fx = deskFixture(THREE());
  fx.desk.open();
  ok(shut(fx.html(), 'hr-merge'), 'on arrival, shut');
  ok(text(fx.html()).includes('Loading the page…'), 'with nothing loaded the panes say so');
  await fx.paint();
  ok(fx.calls.compare.length === 1, 'the comparison is fetched without asking, once');
  ok(shut(fx.html(), 'hr-merge'), 'fetched is not seen: still shut');
  await fx.press('hr-merge');
  ok(fx.calls.merge.length === 0, 'a press before then reaches nothing');
  ok(fx.seen() && !shut(fx.html(), 'hr-merge'), 'seen: open');
  ok(fx.html().indexOf('btn btn-danger') !== -1 && !/btn-primary/.test(fx.html()), 'Merge is the danger button and nothing is violet');
  ok(!/title=/.test(fx.html()), 'no tooltip anywhere');
  // Flip: another direction, another comparison.
  await fx.press('hr-flip');
  ok(shut(fx.html(), 'hr-merge'), 'Keep this one instead shuts it');
  ok(text(fx.html()).includes('Merge into data-privacy'), 'and Merge names the other page at once');
  ok(fx.seen() === false, 'the comparison held is not this direction\'s');
  await fx.paint();
  ok(fx.calls.compare.length === 2 && fx.seen() && !shut(fx.html(), 'hr-merge'), 'it is fetched for this direction, and only then can open');
  // A new pair.
  await fx.press('hr-next');
  ok(shut(fx.html(), 'hr-merge') && fx.scan.previewed.size === 0, 'a new pair is shut, and the old one\'s permission is gone');
  await fx.press('hr-prev');
  ok(fx.scan.previewed.size === 0 && shut(fx.html(), 'hr-merge'), 'coming back to a pair opens nothing: it is read and seen again');
  // Failed.
  const bad = deskFixture(THREE());
  bad.nextCompare = { error: 'the disk went away' };
  bad.desk.open();
  await bad.paint();
  ok(text(bad.html()).includes('Could not load the comparison: the disk went away') && /id="hr-retry"/.test(bad.html()), 'a failed comparison says so, with Try again');
  ok(shut(bad.html(), 'hr-merge') && !bad.seen(), 'and nothing can open Merge');
  ok(!text(bad.html()).includes('Loading the page…'), 'and it has stopped saying it is loading');
  await bad.press('hr-retry');
  await bad.paint();
  ok(bad.calls.compare.length === 2 && bad.seen() && !shut(bad.html(), 'hr-merge'), 'Try again asks again, and the gate can open');
  ok(!text(bad.html()).includes('Could not load'), 'and the failure has gone with it');
  // Merge cannot run on a comparison it does not hold, whatever the gate says.
  const odd = await opened();
  odd.scan.previewed.add(odd.key(odd.scan.pairs[0]));
  odd.state.review.comparison = null;
  await odd.press('hr-merge');
  ok(odd.calls.merge.length === 0, 'a press with no comparison on screen is refused here too');
}

section('§3 The walk');
{
  const fx = await opened();
  fx.seen();
  const firstKey = fx.key(fx.scan.pairs[0]);
  await fx.press('hr-merge');
  ok(fx.calls.merge[0] === firstKey, 'Merge merges the pair on screen');
  let t = text(fx.html());
  ok(t.includes('Merged data-privacy into privacy-and-data-protection . 4 links moved.'), 'the outcome line', t);
  ok(t.includes('Pair 2 of 3') && t.includes('1 decided · 2 left'), 'the next pair, and the count', t.slice(0, 80));
  ok(/^Merged data-privacy into privacy-and-data-protection\. 4 links moved\. Pair 2 of 3\.$/.test(fx.state.healthLive), 'spoken: the outcome and where you are', fx.state.healthLive);
  await fx.paint();
  ok(shut(fx.html(), 'hr-merge'), 'the next pair is shut until seen');
  // Next records nothing and says nothing new.
  const said = text(fx.html()).includes('Merged data-privacy');
  await fx.press('hr-next');
  ok(fx.calls.merge.length === 1 && fx.calls.keep.length === 0 && said && text(fx.html()).includes('Merged data-privacy'), 'Next records nothing and the outcome stays');
  ok(text(fx.html()).includes('Pair 3 of 3'), 'Next goes on');
  await fx.paint();
  await fx.press('hr-next');
  ok(text(fx.html()).includes('Pair 2 of 3'), 'Next goes round, past the decided pair');
  await fx.paint();
  fx.seen();
  // Keep both, Undo.
  const kept = fx.key(fx.scan.pairs[1]);
  await fx.press('hr-keep');
  t = text(fx.html());
  ok(fx.calls.keep[0] === kept && t.includes('Kept agent and ai-agents apart. They will not come back.') && /id="hr-undo"/.test(fx.html()), 'Keep both: says so, with Undo', t);
  await fx.press('hr-undo');
  ok(fx.calls.back[0] === kept && fx.scan.pairs[1].status === 'open' && text(fx.html()).includes('Brought back.'), 'Undo brings it back');
  ok(fx.state.review.index === 2, 'Undo does not move you');
  ok(fx.html().includes('2 left') || text(fx.html()).includes('1 decided · 2 left'), 'and the count knows');
  // Undo that fails.
  await fx.paint(); fx.seen();
  await fx.press('hr-keep');
  fx.nextBack = 'the disk went away';
  await fx.press('hr-undo');
  ok(text(fx.html()).includes('Could not save: the disk went away') && /id="hr-retry"/.test(fx.html()), 'an Undo that fails stays, with Try again', text(fx.html()));
  fx.nextBack = null;
  await fx.press('hr-retry');
  ok(text(fx.html()).includes('Brought back.'), 'and Try again undoes it');

  // A sibling settled: the cascade counted, and the pair it settled is skipped over.
  const sib = await opened([pair('a2', 'a3'), pair('a2', 'a1'), pair('z2', 'z')]);
  sib.seen();
  sib.nextMerge = { merged: true, alsoResolved: 1 };
  sib.scan.pairs[1].status = 'open';
  const realMerge = sib.scan.pairs;
  sib.nextMerge = { merged: true, alsoResolved: 1 };
  await (async () => { realMerge[1] = { ...realMerge[1], status: 'resolved' }; await sib.press('hr-merge'); })();
  ok(text(sib.html()).includes('1 other pair settled.'), 'one merge can settle others, and says so');
  ok(text(sib.html()).includes('Pair 3 of 3'), 'and the walk steps over a settled pair');

  // The end.
  const end = await opened([pair('a', 'b'), pair('c', 'd')], { coverage: { left: 1200 } });
  end.seen(); await end.press('hr-merge'); await end.paint(); end.seen(); await end.press('hr-keep');
  t = text(end.html());
  ok(t.includes('All pairs decided.') && t.includes('1 merged · 1 kept both · 0 settled by another merge'), 'the end of the list', t);
  ok(t.includes('1,200 pairs have not been compared yet, shown in AI help.'), 'and what has not been compared');
  ok(/id="hr-done"/.test(end.html()) && !/id="hr-merge"|id="hr-next"/.test(end.html()), 'Done is the only way on');
  ok(!shut(end.html(), 'hr-done'), 'and it is open');
  await end.press('hr-undo');
  await end.paint();
  ok(text(end.html()).includes('Pair 2 of 2') && text(end.html()).includes('Brought back.'), 'Undo from the end brings the pair back to the desk');
  await end.press('hr-done');
  ok(end.state.review === null && end.calls.closed[0] === 1, 'Done closes it and reports what was merged');

  // Busy.
  const busy = await opened();
  busy.seen();
  busy.state.busyKey = 'semanticMergeOne:' + busy.key(busy.scan.pairs[0]);
  let h = busy.html();
  ok(/aria-busy="true"/.test(buttonOf(h, 'hr-merge')) && text(h).includes('Merging…') && !/ disabled/.test(buttonOf(h, 'hr-merge')), 'while merging: the label says so, focus can stay');
  ok(shut(h, 'hr-keep') && shut(h, 'hr-next') && shut(h, 'hr-prev') && shut(h, 'hr-done') && shut(h, 'hr-flip'), 'and nothing else can be pressed');
  busy.state.busyKey = 'semanticSkip:' + busy.key(busy.scan.pairs[0]);
  h = busy.html();
  ok(/aria-busy="true"/.test(buttonOf(h, 'hr-keep')) && text(h).includes('Saving…') && shut(h, 'hr-merge'), 'while keeping both: Saving…, and Merge is shut');

  // Mount and domain.
  const away = await opened();
  away.activeSlug = 'beta';
  ok(away.desk.isOpen() === false && away.html() === '', 'on another domain the desk is not open, and draws nothing');
  away.activeSlug = 'alpha';
  ok(away.desk.isOpen() === true, 'and coming back it is');
  away.gone = true;
  ok(away.desk.isOpen() === false, 'with a new scan it is over');
  const none = deskFixture([pair('a', 'b', { status: 'merged' })]);
  ok(none.desk.open() === false && none.state.review === null, 'with nothing waiting it does not open');
  ok(nextWaiting([{ status: 'open' }], 0, 1) === 0 && nextWaiting([{ status: 'merged' }], 0, 1) === -1, 'nextWaiting: itself when alone, none when none');

  // Read full page.
  const read = await opened();
  await read.press('hr-read-goes');
  await read.press('hr-read-stays');
  ok(read.calls.read.join() === 'concepts/data-privacy.md|data-privacy,concepts/privacy-and-data-protection.md|privacy-and-data-protection', 'Read full page opens the right page');
}

section('§4 A page changed under the comparison');
{
  const fx = await opened();
  fx.seen();
  const k = fx.key(fx.scan.pairs[0]);
  fx.nextMerge = { stale: true };
  let held;
  fx.holdCompare = new Promise((r) => { held = r; });
  await fx.press('hr-merge');
  ok(fx.scan.previewed.size === 0 && shut(fx.html(), 'hr-merge'), 'the gate shuts');
  ok(fx.state.review.index === 0, 'and the pair stays');
  ok(!text(fx.html()).includes('has been refreshed'), 'it does not yet say the comparison was refreshed, because it has not been');
  ok(text(fx.html()).includes('Text of data-privacy'), 'the text stays on screen while it is read again');
  fx.desk.afterPaint();
  held(); fx.holdCompare = null;
  await fx.paint();
  ok(fx.calls.compare.filter((c) => c === k).length === 2, 'it is read again');
  ok(text(fx.html()).includes('This page changed since you compared it. The comparison has been refreshed.'), 'now it says so', text(fx.html()).slice(-300));
  ok(/changed since you compared/.test(fx.state.healthLive), 'and it is spoken');
  ok(shut(fx.html(), 'hr-merge'), 'and Merge is still shut: the new text has to be seen');
  ok(fx.seen() && !shut(fx.html(), 'hr-merge'), 'seen, it opens');

  const worse = await opened();
  worse.seen();
  worse.nextMerge = { stale: true };
  worse.nextCompare = { error: 'the disk went away' };
  await worse.press('hr-merge');
  await worse.paint();
  ok(!text(worse.html()).includes('has been refreshed') && text(worse.html()).includes('Could not load the comparison: the disk went away'), 'if reading it again fails, it says that, and not "refreshed"');
  ok(shut(worse.html(), 'hr-merge'), 'and Merge stays shut');

  const gone = await opened();
  gone.nextCompare = null;
  gone.seen();
  gone.nextMerge = { gone: true, missing: 'concepts/data-privacy' };
  await gone.press('hr-merge');
  ok(text(gone.html()).includes('This pair is settled: concepts/data-privacy no longer exists. Moving on.'), 'a page gone at merge: settled, and moving on', text(gone.html()).slice(-200));

  const away = deskFixture(THREE());
  away.nextCompare = { settled: true, missing: 'concepts/data-privacy' };
  away.desk.open();
  await away.paint();
  ok(text(away.html()).includes('This pair is settled: concepts/data-privacy no longer exists. Moving on.') && text(away.html()).includes('Pair 2 of 3'), 'a page gone at the comparison: the same');

  const fail = await opened();
  fail.seen();
  fail.nextMerge = { error: 'Could not merge: the disk went away' };
  await fail.press('hr-merge');
  ok(text(fail.html()).includes('Could not merge: the disk went away') && /id="hr-retry"/.test(fail.html()) && fail.state.review.index === 0, 'a failed merge stays on the pair, with Try again');
  fail.nextMerge = { merged: true, alsoResolved: 0 };
  await fail.press('hr-retry');
  ok(fail.calls.merge.length === 2 && text(fail.html()).includes('Merged data-privacy'), 'and Try again merges it, through the same gate');
  const failK = await opened();
  failK.seen();
  failK.nextKeep = { error: 'Could not save: the disk went away' };
  await failK.press('hr-keep');
  ok(text(failK.html()).includes('Could not save: the disk went away') && /id="hr-retry"/.test(failK.html()), 'a Keep both that fails says so');
}

section('§5 A list of thousands');
{
  const many = Array.from({ length: 5000 }, (_, i) => pair('r' + i, 'k' + i, { status: i % 7 === 0 ? 'merged' : i % 11 === 0 ? 'skipped' : i % 13 === 0 ? 'resolved' : 'open', nameRelation: i % 2 ? 'different-names' : 'spelling-variant' }));
  const t = tally(many);
  ok(t.total === 5000 && t.open + t.merged + t.kept + t.settled === 5000, 'the tally adds up');
  const fx = deskFixture(many);
  fx.desk.open();
  const shutFold = fx.html();
  ok(!/hr-fold-row/.test(shutFold), 'shut, it draws no row at all');
  ok(text(shutFold).includes('All 5,000 pairs'), 'and counts them all, with a separator');
  fx.state.expandedGroups.add('reviewPairs');
  const t0 = performance.now();
  const h = fx.html();
  const ms = performance.now() - t0;
  console.log('    (one paint of the desk with 5,000 pairs and the list open: ' + Math.round(ms * 10) / 10 + ' ms)');
  ok((h.match(/hr-fold-row/g) || []).length === FOLD_PAGE, 'open, it draws one window of rows, not the list');
  ok(h.indexOf('hr-fold-summary') < h.indexOf('hr-fold-row'), 'and the summary first');
  ok(ms < 100, 'a paint costs what fifty rows cost', ms);
  ok(/id="hr-fold-more"/.test(h) && text(h).includes('Show 50 more'), 'and offers the next page');
  const sum = text(foldSummary(tally([pair('a', 'b'), pair('c', 'd', { status: 'merged' }), pair('e', 'f', { status: 'skipped', nameRelation: 'spelling-variant' }), pair('g', 'h', { status: 'resolved' })])));
  ok(sum.includes('1 waiting · 1 merged · 1 kept both · 1 settled by another merge') && sum.includes('Spelling variant 1 · Different names 3'), 'the summary abstracts the list: what happened, and what kind', sum);
  ok(wordAllowed('1 waiting · 1 merged · 1 kept both · 1 settled by another merge') && wordAllowed('Spelling variant 1 · Different names 3'), '…in words the deck allows');
  ok(!wordAllowed('1 waiting · 1 banana'), 'CONTROL — and no others');
  // The window holds the pair you are on.
  ok(foldWindow(5000, 1234, null, null).from === 1200 && foldWindow(5000, 1234, null, null).to === 1250, 'the window opens on the pair you are at');
  const deep = deskFixture(many);
  deep.desk.open();
  deep.state.review.index = 1234;
  deep.state.expandedGroups.add('reviewPairs');
  const dh = deep.html();
  ok(/id="hr-fold-earlier"/.test(dh) && (dh.match(/this pair/g) || []).length <= 1, 'with earlier rows to show, it offers them');
  await deep.press('hr-fold-earlier');
  ok((deep.html().match(/hr-fold-row/g) || []).length === 100, 'Show more upward adds a page');
  await deep.press('hr-fold-more');
  ok((deep.html().match(/hr-fold-row/g) || []).length === 150, 'and downward');
  // Jump.
  const jump = await opened();
  jump.state.expandedGroups.add('reviewPairs');
  const jh = jump.html();
  ok(/data-review-jump="1"/.test(jh) && !/data-review-jump="0"/.test(jh) && /this pair/.test(jh), 'a waiting row is a button; this pair is not');
  await jump.press('', { reviewJump: '2' });
  ok(text(jump.html()).includes('Pair 3 of 3') && jump.scan.previewed.size === 0, 'a jump goes there, armed by nothing');
  await jump.paint(); jump.seen();
  await jump.press('hr-merge');
  jump.state.expandedGroups.add('reviewPairs');
  ok(!/data-review-jump="2"/.test(jump.html()) && text(jump.html()).includes('merged'), 'a decided row is not a button, and says what happened');
  await jump.press('', { reviewJump: '2' });
  ok(jump.state.review.index !== 2, 'and a forged jump to it goes nowhere');
}

section('§6 The rubber-stamp guards, in the source');
{
  const src = readFileSync(join(ROOT, 'src/public/next/views/health-review.js'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/keydown|keypress|keyup|accesskey/i.test(code), 'the desk listens to no key: no shortcut can exist (the browser walk presses them)');
  ok(!/btn-primary|btn-ghost/.test(code), 'no violet and no ghost button');
  ok(!/\.confidence\b/.test(code), 'the desk never reads confidence');
  const css = readFileSync(join(ROOT, 'src/public/next/views/health-review.css'), 'utf8');
  ok(!/transition-duration|[^-]\d+m?s\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'its motion is only the tokens, so reduced motion needs nothing of its own');
  ok(!/text-transform/.test(css), 'nothing in capitals');
  const index = readFileSync(join(ROOT, 'src/public/next/index.html'), 'utf8');
  ok(index.includes('/next/views/health-review.css'), 'the stylesheet is linked');
  const view = readFileSync(join(ROOT, 'src/public/next/views/domains.js'), 'utf8');
  for (const gone of ['dm-sem-card', 'renderSemanticPairCard', 'renderSemanticPreview', 'renderSemanticScanResult', 'semanticPrimaryAction', 'Preview required', 'Preview diff', 'flipFlash', 'data-sem-action']) {
    ok(!view.includes(gone), 'retired: ' + gone);
  }
  const words = readFileSync(join(ROOT, 'src/routes/health.js'), 'utf8');
  ok(/const MERGE_BASIS_CLIENT_REQUIRED = true;/.test(words), 'the server requires the basis');
}

section('§7 The same desk can carry a family walk');
{
  // A walk fills the same slots with its own words. Nothing about a pair is inside renderDesk.
  const pane = (role, page, readId, flip) => ({ role, page, readId, flip, bodyHtml: '<p>Text</p>', meta: 'concepts · 1 link points here · 2 KB' });
  const h = renderDesk({
    titleHtml: 'Family of 12 pages', countText: 'Page 4 of 11 · 2 merged · 1 kept · 8 left', factsHtml: '<span class="hr-fact">Different names</span> The AI never compared these two pages.',
    reviewKey: 'x||y', goes: pane('Goes away', 'claude-opus', 'hr-read-goes', { disabled: false }), stays: pane('Stays', 'claude', 'hr-read-stays', null),
    afterHtml: 'After the merge…', keepLabel: 'Keep both', keepAttrs: '', mergeLabelHtml: 'Merge claude-opus into claude', mergeSpoken: 'Merge claude-opus into claude', mergeAttrs: '',
    noteHtml: 'Merging deletes claude-opus. ' + WARN, outcome: { tone: 'success', html: 'Merged.' }, busy: false, foldHtml: '',
  });
  ok(h.includes('Family of 12 pages') && h.includes('Page 4 of 11') && h.includes('Merge claude-opus into claude') && h.includes('hr-panes'), 'renderDesk draws a family walk from a model, unchanged');
  ok(renderPairsFold({ pairs: [pair('a', 'b')], index: 0, tally: tally([pair('a', 'b')]), foldOpen: false }).includes('All 1 pair'), 'one pair, singular');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
