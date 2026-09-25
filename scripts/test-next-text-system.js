/**
 * test-next-text-system.js — OFFLINE suite for src/public/next/shared/text.js
 * and shared/text.css, the first shared component in /next that renders TEXT.
 *
 * No network, no API key, no server, no browser, no spend.
 *
 * ── WHY THIS COMPONENT EXISTS, IN ONE LINE ──────────────────────────────
 *
 * The app renders a MEASUREMENT and an EXPLANATION in the same voice.
 * Measured over the /next stylesheets before text.css existed: 744 rules
 * carry a text treatment, 84 of them on 81 distinct class names ending
 * -desc/-hint/-note/-body/-lede/-sub, resolving to 93 distinct
 * (size, colour, weight) combinations. `.view-body` carries four unrelated
 * meanings; `.sidebar-hint` renders both a marketing sentence and a runtime
 * error, separated only by a colour modifier.
 *
 * ── THE SUITE EXECUTES THE REAL RENDERERS ───────────────────────────────
 *
 * shared/text.js takes NO imports, specifically so it can be imported in
 * Node. That is not a stylistic choice: importing src/public/next/app.js in
 * Node throws `ReferenceError: document is not defined`, and so does
 * anything importing it — importing shared/listbox.js fails identically,
 * which is why v3.18.0 records its keyboard contract as resting on SOURCE
 * SCANS. Several guards in this repo have been decorative for exactly that
 * reason: they drove a pure helper the real call site never invokes. Every
 * behavioural section below calls the shipped function and asserts on its
 * real output string.
 *
 * ── ENFORCED ────────────────────────────────────────────────────────────
 *
 *  §1 escapeHtml here is EQUIVALENT to app.js's, proven by extracting
 *     app.js's copy by brace-match and running both over a corpus. The
 *     duplication is deliberate (see the module header) and is pinned
 *     rather than trusted.
 *  §2 ABSENT IS NOT ZERO, executed on every role: a field that was not
 *     supplied is OMITTED, never rendered as 0, a dash, or an invented
 *     default.
 *  §2b `renderReadout`'s `markHtml` (v3.62.0): ABSENT is byte-identical to
 *     what the ten shipped call sites rendered before the option existed,
 *     pinned against golden strings produced by the PRE-CHANGE function;
 *     present, the mark lands inside `.tx-readout-value` before the figure,
 *     unescaped, while label / value / provenance stay escaped; a non-string
 *     mark is dropped. §8 adds the three CSS declarations that make the mark
 *     and the figure one line, and proves the `tx-`-prefix guard fires on a
 *     stylesheet planted as a REAL FILE, not only on a string.
 *  §3 Every interpolated value is escaped; `html: true` is opt-in only.
 *  §4 A warning passed to the EXPLAINER renders OUTSIDE and BEFORE the
 *     <details>, in every combination of `open`, and there is no parameter
 *     that places it inside.
 *  §5 CONTRAST, MEASURED from tokens/color.css with var() chains resolved
 *     and rgba tints composited, in BOTH themes: every token text.css uses
 *     as a `color:` clears 4.5:1 on all three surfaces, and every token it
 *     uses as a tone clears 3:1 as a border. The token list is enumerated
 *     FROM text.css, not hand-written, so adding `color: var(--text-3)`
 *     goes red.
 *  §6 text.css declares no px font-size (the --font-scale control would not
 *     reach it) and every var() resolves to a real token.
 *  §7 text.css is REACHABLE — actually linked from index.html. v3.9.1
 *     shipped progress-ring.css styled but unlinked for a whole release.
 *  §8 NO LOCAL COPY: each of the six renderer names is declared exactly
 *     once across all of src/public/next, enumerated from disk.
 *  §9 Positive controls: `ok()` can actually fail, the escaper corpus can
 *     actually detect a difference, the theme tables are genuinely
 *     distinct, and the no-local-copy detector fires on a planted duplicate.
 *
 * ── NOT ENFORCED — stated, not implied away ─────────────────────────────
 *
 *  - NO OFFLINE SUITE HERE MEASURES REAL RENDERING. These assertions prove
 *    the markup, the class names and the token arithmetic. They do NOT
 *    prove appearance, layout, cascade resolution, specificity against a
 *    view's own later rules, or that anything is legible on a screen. The
 *    repo's CSS suites are pure Node text analysis by design; a hand-rolled
 *    specificity calculator adjudicating a cross-file cascade would be the
 *    decorative-guard shape this project keeps hitting.
 *  - THE NEUTRAL STATUS RAIL FAILS THE 3:1 NON-TEXT FLOOR. --border-strong
 *    measures 1.54 dark / 1.64 light against --surface-raised. It is
 *    inherited from the .build-current precedent and kept, because the
 *    neutral state means "nothing to report" so a faint rail under-states
 *    nothing. §5 asserts this is TRUE rather than pretending otherwise, so
 *    the day someone re-points that token the assertion goes red and the
 *    decision gets re-made deliberately.
 *  - ADOPTION IS NOT COVERED. No view imports this module yet, by design —
 *    this wave is build-and-test only. §8 therefore proves the renderers are
 *    single-source, NOT that any view uses them. When adoption lands, that
 *    change must add import-site assertions, exactly as
 *    test-next-cost-honesty.js does for format-usd.js.
 *  - THE ESCAPER EQUALITY IS OVER A CORPUS, not a proof. §1 compares the two
 *    implementations across a broad input set including every character the
 *    replacer names; it cannot prove agreement over all strings.
 *  - The `html: true` escape hatch on renderDescription/renderExplainer
 *    hands escaping back to the caller. Nothing here can check what a future
 *    caller passes through it.
 *  - `markHtml` IS THAT SAME HATCH, on a third role. §2b proves it is not
 *    escaped and that nothing else lost its escaping; it cannot prove a
 *    future caller passes a `.fresh-dot` rather than something it built from
 *    a store string. The rule is stated at the function and is a convention.
 *  - THE THREE FLEX DECLARATIONS ARE ASSERTED, NOT MEASURED, HERE. That a
 *    `baseline` mark stays on line one of a wrapped value, and that the ten
 *    existing readouts are unmoved to the hundredth of a pixel, were measured
 *    in a browser over the shipped stylesheets when the option landed; the
 *    numbers are recorded beside the rule in text.css. This suite pins the
 *    DECISION so it cannot be reverted silently — it does not re-measure it,
 *    for the same reason the first NOT ENFORCED item gives.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  renderReadout, renderReadoutGroup, renderDescription,
  renderStatus, renderBadge, renderExplainer,
} from '../src/public/next/shared/text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEXT = join(HERE, '..', 'src', 'public', 'next');
const read = (p) => readFileSync(join(NEXT, p), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

/** Enumerate FROM DISK. A hardcoded file list is how a guard goes blind. */
function walk(dir, ext, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

const textJs = read('shared/text.js');
const textCss = read('shared/text.css');

// =======================================================================
console.log('\n§0  POSITIVE CONTROL - the harness can actually fail');
// v3.18.0: two suites disagreed about ok()'s argument order, and a reversed
// signature made every literal assertion pass unconditionally. Caught by
// mutation, not review. This control makes the hazard visible in-file.
{
  let localPass = 0, localFail = 0;
  const probe = (cond) => { if (cond) localPass++; else localFail++; };
  probe(true); probe(false);
  ok(localPass === 1 && localFail === 1,
     'CONTROL: a true assertion passes and a FALSE assertion fails - ok() is not ' +
     'unconditional (got ' + localPass + ' pass / ' + localFail + ' fail)');
  ok(typeof renderReadout === 'function' && typeof renderExplainer === 'function',
     'CONTROL: the real module was imported in Node and its renderers are callable - ' +
     'these are executed assertions, not source scans');
}

// =======================================================================
console.log('\n§1  escapeHtml is EQUIVALENT to app.js copy');
{
  const appJs = read('app.js');
  const marker = 'export function escapeHtml(s) {';
  const start = appJs.indexOf(marker);
  ok(start !== -1, 'app.js escapeHtml was located for extraction');
  let i = appJs.indexOf('{', start), depth = 0, end = -1;
  for (; i < appJs.length; i++) {
    if (appJs[i] === '{') depth++;
    else if (appJs[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const src = appJs.slice(start, end).replace('export function', 'function');
  const appEscape = new Function(src + '; return escapeHtml;')();
  ok(typeof appEscape === 'function', 'app.js escapeHtml was extracted and is callable');

  const ourStart = textJs.indexOf('function escapeHtml(s) {');
  let j = textJs.indexOf('{', ourStart), d2 = 0, e2 = -1;
  for (; j < textJs.length; j++) {
    if (textJs[j] === '{') d2++;
    else if (textJs[j] === '}') { d2--; if (d2 === 0) { e2 = j + 1; break; } }
  }
  const ourEscape = new Function(textJs.slice(ourStart, e2) + '; return escapeHtml;')();

  const corpus = [
    '', 'plain', '<script>alert(1)</script>', '&amp;', '"', "'", '<>&"\'',
    'a & b < c > d " e \' f', '<img src=x onerror=alert(1)>', 'ja <b>r</b>',
    '[31m', '日本語 & <tag>', 'A'.repeat(500) + '<',
    null, undefined, 0, 12, false, '[[wikilink]]', 'path/to/file.md',
    '</summary><script>', '&lt;already escaped&gt;', '"><svg onload=alert(1)>',
  ];
  let diffs = 0, firstDiff = null;
  for (const c of corpus) {
    if (appEscape(c) !== ourEscape(c)) {
      diffs++;
      if (firstDiff === null) firstDiff = JSON.stringify(c);
    }
  }
  ok(diffs === 0,
     'the two escapeHtml implementations agree over ' + corpus.length +
     ' inputs (differences: ' + diffs + (firstDiff ? ', first at ' + firstDiff : '') + ')');
  const brokenEscape = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let ctrlDiffs = 0;
  for (const c of corpus) if (appEscape(c) !== brokenEscape(c)) ctrlDiffs++;
  ok(ctrlDiffs > 0,
     'CONTROL: the same corpus DOES detect a difference against an escaper missing the ' +
     'apostrophe rule (' + ctrlDiffs + ' inputs differ) - so the equality above is not vacuous');
}

// =======================================================================
console.log('\n§2  READOUT - an instrument, and ABSENT IS NOT ZERO');
{
  const full = renderReadout({ label: 'Issues', value: 12, provenance: 'scanned 10s ago' });
  ok(full.includes('tx-readout-label') && full.includes('>Issues<'), 'the label renders');
  ok(full.includes('tx-readout-value') && full.includes('>12<'), 'the value renders');
  ok(full.includes('tx-readout-prov') && full.includes('scanned 10s ago'), 'the provenance renders');

  const noProv = renderReadout({ label: 'Issues', value: 12 });
  ok(!noProv.includes('tx-readout-prov'),
     'ABSENT IS NOT ZERO: no provenance supplied -> NO provenance element at all');
  ok(!/never|unknown|null|undefined/i.test(noProv) && !noProv.includes('—'),
     'and it invents no placeholder - no dash, no "never", no "unknown" (got: ' + noProv + ')');

  const noLabel = renderReadout({ value: 12 });
  ok(!noLabel.includes('tx-readout-label') && noLabel.includes('>12<'),
     'ABSENT IS NOT ZERO: no label supplied -> no label element, the figure still renders');

  ok(renderReadout({ label: 'Issues' }) === '',
     'NO VALUE, NO READOUT: an instrument with nothing to display renders nothing, rather ' +
     'than an empty box implying a reading');
  ok(renderReadout({ label: 'x', value: '' }) === '' &&
     renderReadout({ label: 'x', value: '   ' }) === '',
     'an empty or whitespace-only value is also nothing to display');
  ok(renderReadout(null) === '' && renderReadout(undefined) === '' && renderReadout('nope') === '',
     'a junk argument renders nothing rather than throwing - it fails toward "no claim"');

  ok(renderReadout({ value: 0 }).includes('>0<'),
     'a REAL zero still renders: 0 issues is a measurement, and suppressing it would be the ' +
     'absent/zero collapse in the opposite direction');
  ok(renderReadout({ value: NaN }) === '' && renderReadout({ value: Infinity }) === '',
     'NaN and Infinity are not measurements and render nothing');

  const xss = renderReadout({ label: '<b>x</b>', value: '"><script>', provenance: "'&<" });
  ok(!xss.includes('<b>') && !xss.includes('<script>') && xss.includes('&lt;'),
     'every readout field is escaped');

  const grp = renderReadoutGroup([
    { label: 'Issues', value: 12 }, { label: 'Nothing' }, { label: 'Pages', value: 3384 },
  ]);
  ok(grp.includes('tx-readout-group') && (grp.match(/tx-readout"/g) || []).length === 2,
     'a group drops entries that render nothing and keeps the rest (2 of 3)');
  ok(renderReadoutGroup([{ label: 'x' }]) === '' && renderReadoutGroup([]) === '' &&
     renderReadoutGroup(null) === '',
     'a group with nothing left renders no container at all');
}

// =======================================================================
console.log('\n§2b  THE READOUT MARK - markHtml, the ONE unescaped field');
// v3.62.0. The Context view's three-cell strip carries a freshness mark in
// each cell, on the app's ONE freshness scale (shared/freshness.css) rather
// than a fourth private mark family in a view sheet. `renderReadout` escapes
// its value, so the mark needs a field of its own — and a field that emits
// caller HTML into a component whose whole contract is "it escapes
// internally" is exactly the kind of licence that has to be pinned rather
// than described.
{
  const DOT = '<span class="fresh-dot fresh-today" aria-hidden="true"></span>';

  // ── (i) ABSENT markHtml IS BYTE-IDENTICAL TO WHAT SHIPPED ─────────────
  // GOLDEN LITERALS, and they are golden in the literal sense: each one was
  // produced by running the PRE-CHANGE renderReadout (extracted from the
  // commit before this option existed) over the real shapes at the ten
  // shipped call sites — Domains health, the Ingest estimate, memory's
  // Last-saved / Foundations / journal / reader, the Settings tool map, a
  // bare figure, a real zero, and the escaping case. They are not a
  // re-description of the current template: a template that drifts by one
  // character goes red here naming the input, which is the property the
  // ten existing callers are owed and the reason this is not
  // `expect(out).toContain('tx-readout-value')`.
  const GOLDEN = [
    [{ label: 'Open issues', value: 12, provenance: 'scanned 10s ago' },
     '<div class="tx-readout"><span class="tx-readout-label">Open issues</span><span class="tx-readout-value">12</span><span class="tx-readout-prov">scanned 10s ago</span></div>'],
    [{ label: 'Entities', value: 614 },
     '<div class="tx-readout"><span class="tx-readout-label">Entities</span><span class="tx-readout-value">614</span></div>'],
    [{ label: 'Dismissed', value: 0 },
     '<div class="tx-readout"><span class="tx-readout-label">Dismissed</span><span class="tx-readout-value">0</span></div>'],
    [{ label: 'Estimated cost', value: '$0.04 – $0.11', provenance: '12 files · 340 KB · gemini-2.5-flash-lite' },
     '<div class="tx-readout"><span class="tx-readout-label">Estimated cost</span><span class="tx-readout-value">$0.04 – $0.11</span><span class="tx-readout-prov">12 files · 340 KB · gemini-2.5-flash-lite</span></div>'],
    [{ label: 'Last saved', value: '38 min ago', provenance: 'agent · curator-main · this machine' },
     '<div class="tx-readout"><span class="tx-readout-label">Last saved</span><span class="tx-readout-value">38 min ago</span><span class="tx-readout-prov">agent · curator-main · this machine</span></div>'],
    [{ label: 'Foundations', value: '4 documents · 2 skeletons to fill' },
     '<div class="tx-readout"><span class="tx-readout-label">Foundations</span><span class="tx-readout-value">4 documents · 2 skeletons to fill</span></div>'],
    [{ label: 'Saves shown', value: 24, provenance: 'most recent · full count unknown' },
     '<div class="tx-readout"><span class="tx-readout-label">Saves shown</span><span class="tx-readout-value">24</span><span class="tx-readout-prov">most recent · full count unknown</span></div>'],
    [{ label: 'Updated', value: '2 days ago', provenance: 'commit 1f2a3b4' },
     '<div class="tx-readout"><span class="tx-readout-label">Updated</span><span class="tx-readout-value">2 days ago</span><span class="tx-readout-prov">commit 1f2a3b4</span></div>'],
    [{ label: 'Last session start', value: 'none since this log began' },
     '<div class="tx-readout"><span class="tx-readout-label">Last session start</span><span class="tx-readout-value">none since this log began</span></div>'],
    [{ value: 3445 },
     '<div class="tx-readout"><span class="tx-readout-value">3445</span></div>'],
    [{ label: '<b>x</b>', value: '"><script>', provenance: "'&<" },
     '<div class="tx-readout"><span class="tx-readout-label">&lt;b&gt;x&lt;/b&gt;</span><span class="tx-readout-value">&quot;&gt;&lt;script&gt;</span><span class="tx-readout-prov">&#39;&amp;&lt;</span></div>'],
  ];
  const drift = GOLDEN.filter(([o, want]) => renderReadout(o) !== want);
  ok(drift.length === 0,
     'BYTE-IDENTICAL WITHOUT THE OPTION: all ' + GOLDEN.length + ' shipped call shapes render ' +
     'exactly the string they rendered before markHtml existed' +
     (drift.length ? ' - DRIFTED: ' + JSON.stringify(drift[0][0]) + '\n      want: ' +
       drift[0][1] + '\n      got:  ' + renderReadout(drift[0][0]) : ''));
  ok(GOLDEN.every(([, want]) => !want.includes('fresh-dot') && !/<span class="tx-readout-value"><</.test(want)),
     'CONTROL: ...and not one of those golden strings carries a mark, so the pin above is a pin ' +
     'on the UNMARKED output rather than a tautology');

  // ── (ii) THE MARK GOES INSIDE THE VALUE, BEFORE THE FIGURE ────────────
  // Inside, because that is what puts the mark and the word it qualifies on
  // one line (text.css makes the value an inline-flex for exactly this).
  // BEFORE, because the mark is read first and the figure is the answer.
  const marked = renderReadout({ label: 'Working state', value: 'saved 38 min ago', markHtml: DOT });
  ok(marked === '<div class="tx-readout"><span class="tx-readout-label">Working state</span>' +
                '<span class="tx-readout-value">' + DOT + 'saved 38 min ago</span></div>',
     'the mark is emitted INSIDE .tx-readout-value and BEFORE the figure (got: ' + marked + ')');
  ok(marked.indexOf(DOT) > marked.indexOf('tx-readout-value') &&
     marked.indexOf(DOT) < marked.indexOf('saved 38 min ago'),
     '...stated as an ordering rather than as one literal, so a whitespace change cannot ' +
     'hide a mark that escaped its element');
  const markedProv = renderReadout({ label: 'L', value: 'v', provenance: 'p', markHtml: DOT });
  ok((markedProv.match(/fresh-dot/g) || []).length === 1 &&
     markedProv.indexOf(DOT) < markedProv.indexOf('tx-readout-prov'),
     'the mark appears ONCE and never inside the label or the provenance');

  // ── (iii) markHtml IS NOT ESCAPED; EVERY OTHER FIELD STILL IS ─────────
  // The one-way property: opening this door for the mark must not open it
  // for the three fields that carry user- and store-supplied text.
  const mixed = renderReadout({
    label: '<b>lab</b>', value: '<i>val</i>', provenance: '<u>prov</u>', markHtml: DOT });
  ok(mixed.includes(DOT),
     'markHtml survives VERBATIM - it is trusted, pre-rendered HTML and the caller owns it');
  ok(mixed.includes('&lt;b&gt;lab&lt;/b&gt;') && !mixed.includes('<b>lab</b>'),
     '...and the LABEL is still escaped');
  ok(mixed.includes('&lt;i&gt;val&lt;/i&gt;') && !mixed.includes('<i>val</i>'),
     '...and the VALUE is still escaped');
  ok(mixed.includes('&lt;u&gt;prov&lt;/u&gt;') && !mixed.includes('<u>prov</u>'),
     '...and the PROVENANCE is still escaped');
  ok(!renderReadout({ value: 'v', markHtml: '<img src=x onerror=alert(1)>' })
        .includes('&lt;img'),
     'CONTROL: the escaper is genuinely NOT applied to markHtml (an escaped mark would be a ' +
     'literal <span> printed on the strip, which is the failure this control names)');

  // ── (iv) markHtml IS TYPE-CHECKED, so the trust needs a real caller ───
  // Through the same str() every other field uses: a number, an object or an
  // array is DROPPED rather than coerced into markup. An object stringifies
  // to "[object Object]" and an array JOINS its members - both would print.
  const plain = renderReadout({ label: 'L', value: 'v' });
  const junk = [undefined, null, '', '   ', 0, 12, true, {}, [], [DOT], { toString: () => DOT }];
  const leaked = junk.filter((m) => renderReadout({ label: 'L', value: 'v', markHtml: m }) !== plain);
  ok(leaked.length === 0,
     'a markHtml that is not a non-empty string is DROPPED, and the readout is byte-identical ' +
     'to one with no mark at all (' + junk.length + ' junk values; leaked: ' +
     JSON.stringify(leaked) + ')');
  ok(renderReadout({ label: 'L', markHtml: DOT }) === '',
     'NO VALUE, NO READOUT still holds WITH a mark: a dot beside nothing is a claim that ' +
     'there is a reading');
}

// =======================================================================
console.log('\n§3  DESCRIPTION - one treatment, escaped by default');
{
  const d = renderDescription('A domain is one compounding wiki.');
  ok(d === '<p class="tx-desc">A domain is one compounding wiki.</p>',
     'a description is one element with one class (got: ' + d + ')');
  ok(renderDescription('<img src=x onerror=alert(1)>').includes('&lt;img'),
     'escaped by DEFAULT - the ordinary call is safe');
  ok(renderDescription('<span class="mono">x</span>', { html: true }).includes('<span class="mono">'),
     'html:true is the opt-in for the existing strings that carry inline mono spans');
  ok(renderDescription('') === '' && renderDescription('   ') === '' &&
     renderDescription(null) === '' && renderDescription(42) === '',
     'nothing to say -> no element, so a caller can concatenate unconditionally');
}

// =======================================================================
console.log('\n§4  STATUS - state without a sentence');
{
  ok(renderStatus({ state: 'success', title: 'Haiku 4.5' }).includes('tx-status-success'),
     'a success state carries its modifier class');
  ok(renderStatus({ state: 'attention', title: 'x' }).includes('tx-status-attention'), 'attention');
  ok(renderStatus({ state: 'danger', title: 'x' }).includes('tx-status-danger'), 'danger');
  ok(renderStatus({ title: 'x' }).includes('tx-status-neutral'),
     'NEUTRAL IS THE DEFAULT - most things on screen are ordinary, and the precedent own ' +
     'comment says the first-run case "must not be dressed as a problem"');
  ok(renderStatus({ state: 'catastrophe', title: 'x' }).includes('tx-status-neutral'),
     'an unrecognised tone falls back to neutral rather than throwing - a typo must not take ' +
     'the mount down, and "no claim" is the safe direction');
  ok(renderStatus({ state: '__proto__', title: 'x' }).includes('tx-status-neutral'),
     'a prototype key is refused as a tone (the v3.0.9 prototype-key class)');
  ok(!renderStatus({ title: 'x' }).includes('tx-status-detail'),
     'ABSENT IS NOT ZERO: no detail supplied -> no detail element');
  ok(renderStatus({ state: 'success' }) === '' && renderStatus(null) === '',
     'no title -> nothing rendered');
  ok(renderStatus({ title: '<script>' }).includes('&lt;script&gt;'), 'the title is escaped');
  ok(renderStatus({ title: 'a', detail: '<b>' }).includes('&lt;b&gt;'), 'the detail is escaped');
}

// =======================================================================
console.log('\n§5  BADGE - the tone is the border and the tint, never the label colour');
{
  ok(renderBadge({ label: 'caution', tone: 'attention' }) ===
     '<span class="tx-badge tx-badge-attention">caution</span>', 'a badge is one element');
  ok(renderBadge({ label: 'x' }).includes('tx-badge-neutral'), 'neutral by default');
  ok(renderBadge({ label: 'x', tone: 'nope' }).includes('tx-badge-neutral'), 'unknown tone -> neutral');
  ok(renderBadge({ tone: 'danger' }) === '' && renderBadge(null) === '', 'no label -> no badge');
  ok(renderBadge({ label: '<b>' }).includes('&lt;b&gt;'), 'the label is escaped');
}

// =======================================================================
console.log('\n§6  EXPLAINER - a warning CANNOT be folded');
{
  const plain = renderExplainer({ summary: 'How this works', body: 'Three files per project.' });
  ok(plain.startsWith('<details'), 'with no warning, the explainer is just the details element');
  ok(!plain.includes(' open>'),
     'CLOSED BY DEFAULT - the renderAbout precedent: needed once, then never again');
  ok(renderExplainer({ summary: 's', body: 'b', open: true }).includes(' open>'),
     'open:true is honoured for a caller restoring a remembered fold');

  const warned = renderExplainer({
    summary: 'How this works', body: 'Long prose.',
    warning: 'This model runs away about once in nine documents.',
  });
  const wIdx = warned.indexOf('tx-status');
  const dIdx = warned.indexOf('<details');
  ok(wIdx !== -1, 'the warning renders');
  ok(wIdx < dIdx,
     'THE STRUCTURAL GUARANTEE: the warning element precedes the details element in the output ' +
     '(warning at ' + wIdx + ', details at ' + dIdx + ') - it is a SIBLING BEFORE the fold, ' +
     'not content inside it');
  ok(warned.slice(0, dIdx).includes('runs away about once in nine documents'),
     'and the warning TEXT is in the pre-details region, so it is on screen unopened');
  ok(!warned.slice(dIdx).includes('runs away about once in nine documents'),
     'and it is NOT duplicated inside the fold');

  const closedWarn = renderExplainer({ summary: 's', body: 'b', warning: 'w', open: false });
  ok(closedWarn.indexOf('tx-status') < closedWarn.indexOf('<details') &&
     !closedWarn.includes(' open>'),
     'the warning survives the fold being CLOSED - the case a folded warning would vanish in');
  ok(renderExplainer({ summary: 's', body: 'b', warning: 'w' }).includes('tx-status-attention'),
     'a field named `warning` defaults to the ATTENTION tone, never silently to neutral');
  ok(renderExplainer({ summary: 's', body: 'b', warning: 'w', warningTone: 'danger' })
       .includes('tx-status-danger'), 'warningTone can escalate to danger');

  const bodyTone = renderExplainer({ summary: 's', body: 'b', bodyTone: 'danger', tone: 'danger' });
  ok(!bodyTone.includes('tx-status'),
     'NO PARAMETER SMUGGLES A TONE INTO THE BODY: `bodyTone`/`tone` are not read, so there is ' +
     'no way to express "a warning, but inside the fold"');
  ok(renderExplainer({ summary: 's' }) === '' && renderExplainer({ body: 'b' }) === '',
     'summary and body are both required');
  ok(renderExplainer({ summary: '<b>s', body: 'x' }).includes('&lt;b&gt;s') &&
     renderExplainer({ summary: 's', body: '<b>b' }).includes('&lt;b&gt;b'),
     'summary and body are escaped by default');
  ok(renderExplainer({ summary: 's', body: '<i>x</i>', html: true }).includes('<i>x</i>'),
     'html:true is the opt-in for rich body prose');
  ok(renderExplainer({ summary: 's', body: 'b', id: 'a"b' }).includes('data-tx-explainer="a&quot;b"'),
     'the fold id is escaped inside the attribute');
}

// =======================================================================
console.log('\n§7  CONTRAST - MEASURED from tokens/color.css, both themes');
{
  // ANCHOR SELECTORS AT LINE START: the first version of this tool used a
  // bare indexOf, and `[data-theme="light"]` also appears in color.css's
  // HEADER COMMENT, so it returned the :root block twice and light measured
  // IDENTICAL to dark across every pair. Identical columns are impossible,
  // which is what exposed it.
  const colorCss = read('tokens/color.css');
  function blk(sel) {
    const i = colorCss.indexOf('\n' + sel);
    if (i < 0) throw new Error('no line-anchored selector ' + sel);
    const s = colorCss.indexOf('{', i);
    return colorCss.slice(s + 1, colorCss.indexOf('\n}', s));
  }
  function vars(txt) {
    const o = {}, re = /(--[a-z0-9-]+):\s*([^;]+);/g; let m;
    while ((m = re.exec(txt))) o[m[1]] = m[2].trim();
    return o;
  }
  const dark = vars(blk(':root'));
  const lite = { ...dark, ...vars(blk('[data-theme="light"]')) };
  ok(dark['--surface-raised'] !== lite['--surface-raised'],
     'CONTROL: the two theme tables are genuinely different (dark ' + dark['--surface-raised'] +
     ' vs light ' + lite['--surface-raised'] + ') - a parser conflating them would report ' +
     'every pair as identical and prove nothing');

  const res = (v, t, d = 0) => {
    if (d > 10) throw new Error('cycle');
    const m = /^var\((--[a-z0-9-]+)\)$/.exec(String(v).trim());
    return m ? res(t[m[1]], t, d + 1) : String(v).trim();
  };
  function rgb(c) {
    c = c.trim();
    let m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) { const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255, 1]; }
    m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    throw new Error('unparsed colour ' + c);
  }
  const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3])).concat(1);
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const A = lum(a), B = lum(b);
    return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05);
  };
  const C = (t, fg, bg, tint) => {
    let b = rgb(res('var(' + bg + ')', t));
    if (tint) b = over(rgb(res('var(' + tint + ')', t)), b);
    return ratio(over(rgb(res('var(' + fg + ')', t)), b), b);
  };

  // ENUMERATED FROM text.css, not hand-written: every token used in a
  // `color:` declaration must clear 4.5:1 on every surface the component can
  // sit on. Adding `color: var(--text-3)` therefore goes red.
  const colorTokens = new Set();
  for (const m of textCss.matchAll(/(?:^|[;{\s])color:\s*var\((--[a-z0-9-]+)\)/g)) {
    colorTokens.add(m[1]);
  }
  ok(colorTokens.size >= 2,
     'the text-colour tokens were enumerated from text.css itself: ' + [...colorTokens].join(', '));
  const SURFACES = ['--surface', '--surface-raised', '--surface-inset'];
  let worst = Infinity, worstAt = '';
  for (const tok of colorTokens) {
    for (const s of SURFACES) {
      for (const [n, t] of [['dark', dark], ['light', lite]]) {
        const r = C(t, tok, s, null);
        if (r < worst) { worst = r; worstAt = tok + ' on ' + s + ' (' + n + ')'; }
      }
    }
  }
  ok(worst >= 4.5,
     'every text colour text.css uses clears AA (4.5:1) on all 3 surfaces in BOTH themes - ' +
     'worst measured ' + worst.toFixed(2) + ':1 at ' + worstAt);
  ok(!colorTokens.has('--text-3') && !colorTokens.has('--text-faint'),
     '--text-3 (measured ' + C(dark, '--text-3', '--surface').toFixed(2) + ' dark / ' +
     C(lite, '--text-3', '--surface').toFixed(2) + ' light) and --text-faint are NOT used as a ' +
     'text colour here - 181 rules elsewhere in /next do, and they are under the 4.5 floor');

  for (const [tok, name] of [['--success-text', 'success'], ['--attention-text', 'attention'],
                             ['--danger-text', 'danger']]) {
    const d = C(dark, tok, '--surface-raised'), l = C(lite, tok, '--surface-raised');
    ok(d >= 3 && l >= 3,
       'the ' + name + ' rail clears the 3:1 NON-TEXT floor as a border (' + d.toFixed(2) +
       ' dark / ' + l.toFixed(2) + ' light)');
  }
  const attnAsText = C(lite, '--attention-text', '--surface-raised', '--attention-tint');
  // MESSAGE CORRECTED (the assertion is unchanged token maths and still holds).
  // This used to end "...unlike .model-badge-flag", naming that badge as the
  // live counter-example still painting the status colour as its label. It no
  // longer is: views/settings.css now renders it `color: var(--text)` with
  // `border: 1px solid var(--attention-text)` — the same tone-on-the-rail
  // pattern this component uses — so the sentence had become false. The finding
  // it justifies is unaffected, and is asserted here rather than assumed, so
  // that the fix cannot come to look unnecessary now that its motivating site
  // has been repaired.
  ok(attnAsText < 4.5,
     'FINDING 2 HOLDS: --attention-text as TEXT on its own tint measures ' +
     attnAsText.toFixed(2) + ':1 in the light theme - under AA. This is why the badge label ' +
     'here is --text and not the status colour. The site that used to be the live counter-example, ' +
     '.model-badge-flag, has since ADOPTED this same pattern (--text on the tint at ' +
     C(lite, '--text', '--surface-raised', '--attention-tint').toFixed(2) + ' light, with the tone moved to a ' +
     '1px --attention-text border at ' + C(lite, '--attention-text', '--surface-raised').toFixed(2) +
     ' against a 3:1 non-text floor) - so the reasoning spread rather than the finding expiring');
  const labelOnTint = Math.min(
    C(lite, '--text', '--surface', '--attention-tint'), C(dark, '--text', '--surface', '--attention-tint'),
    C(lite, '--text', '--surface', '--success-tint'), C(dark, '--text', '--surface', '--success-tint'),
    C(lite, '--text', '--surface', '--danger-tint'), C(dark, '--text', '--surface', '--danger-tint'));
  ok(labelOnTint >= 4.5,
     'and the label colour actually used clears AA on every tint in both themes (worst ' +
     labelOnTint.toFixed(2) + ':1)');

  const railN = C(dark, '--border-strong', '--surface-raised');
  ok(railN < 3,
     'KNOWN LIMIT, recorded not hidden: the NEUTRAL rail (--border-strong) measures ' +
     railN.toFixed(2) + ':1, under the 3:1 non-text floor. Kept because neutral means ' +
     '"nothing to report"; this assertion goes red if the token is ever re-pointed');

  const elevL = ratio(rgb(res('var(--surface-raised)', lite)), rgb(res('var(--surface)', lite)));
  ok(elevL < 1.05,
     'FINDING 3: --surface-raised vs --surface is ' + elevL.toFixed(2) + ':1 in LIGHT - a ' +
     '"raised" box is invisible without a border, which is why every boxed role carries one');
  for (const cls of ['.tx-status {', '.tx-explainer {']) {
    const i = textCss.indexOf(cls);
    ok(i !== -1 && textCss.slice(i, textCss.indexOf('}', i)).includes('border: 1px solid'),
       cls.replace(' {', '') + ' carries a 1px border, so it delineates in the light theme');
  }
}

// =======================================================================
console.log('\n§8  text.css hygiene and REACHABILITY');
{
  const px = [...textCss.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => m[0]);
  ok(px.length === 0,
     'NO frozen px font-size - every size is a --text-* ramp token, so the text-scale control ' +
     'in Settings reaches this component (found: ' + (px.join(', ') || 'none') + ')');
  const sizes = [...textCss.matchAll(/font-size:\s*var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
  ok(sizes.length > 0 && sizes.every((s) => /^--text-/.test(s)),
     'every font-size reads a --text-* ramp token (' + sizes.length + ' declarations)');

  /* `material` joined this list when text.css first reached for --hit-min and
     this check reported it undefined. It was not: the material pass added a
     sixth token file and every hand-kept list of the other five became short
     by one. THE LIST IS NOW DERIVED from index.html's own <link> tags, so a
     seventh file cannot repeat it — the browser's token universe is exactly
     the set of sheets the page loads, and reading that is strictly better
     than remembering to add a name here.
     tokens/fonts.css is deliberately NOT linked (it @imports Google Fonts);
     reading the links rather than the directory keeps that true. */
  const linked = [...read('index.html').matchAll(/href="\/next\/(tokens\/[a-z-]+\.css)"/g)].map((m) => m[1]);
  ok(linked.length >= 6, `${linked.length} token sheets are linked by index.html: ${linked.map((f) => f.replace('tokens/', '')).join(', ')}`);
  ok(linked.includes('tokens/material.css'),
    'and tokens/material.css is one of them — the sheet this list was missing');
  const tokenCss = linked.map((n) => read(n)).join('\n');
  const defined = new Set([...tokenCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  for (const m of textCss.matchAll(/(--tx-[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  const used = [...textCss.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
  const undef = [...new Set(used)].filter((v) => !defined.has(v));
  ok(undef.length === 0,
     'every var() in text.css resolves to a real token - an undefined custom property fails ' +
     'SILENTLY at computed-value time (found undefined: ' + (undef.join(', ') || 'none') + ')');
  ok(!/var\(--text-dim\)/.test(textCss),
     '--text-dim is NOT referenced: it does not exist, and referencing it once shipped ' +
     'invisible text (v3.0.12)');

  const selectors = [...textCss.matchAll(/^\.([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
  ok(selectors.length > 0 && selectors.every((s) => s === 'tx' || s.startsWith('tx-')),
     'every top-level selector in text.css is on the `tx-` prefix (' + selectors.length + ' rules)');
  // COMMENTS ARE STRIPPED BEFORE THIS SCAN, and that is a correction rather
  // than a loosening. The assertion's own words are that no other stylesheet
  // DEFINES a `tx-` rule; a raw scan cannot tell a rule from a sentence, so a
  // comment that merely NAMES `.tx-vh-panel` — for instance to record why a
  // view deliberately did NOT borrow it — was reported as a leak. That is the
  // comment-satisfies-a-scan hazard this repo keeps recording, inverted: a
  // guard firing on prose teaches people to reword comments instead of fixing
  // code, and the next person deletes the explanation rather than the defect.
  // Stripping can only remove FALSE positives here: a real rule is never
  // inside a comment. The control below proves the detector still fires.
  const stripCssComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
  const otherCss = walk(NEXT, '.css').filter((p) => !p.endsWith('shared/text.css'));
  const leaksIn = (src) => /\.tx-[a-z]/.test(stripCssComments(src));
  const leaks = otherCss.filter((p) => leaksIn(readFileSync(p, 'utf8')));
  ok(leaks.length === 0,
     'no OTHER /next stylesheet defines a `tx-` rule, so this component owns its prefix (' +
     otherCss.length + ' files scanned; leaks: ' +
     (leaks.map((p) => p.split('/').pop()).join(', ') || 'none') + ')');
  ok(leaksIn('.chat-x { color: red; }\n.tx-vh-panel { margin-top: 6px; }'),
     'CONTROL: a real `.tx-` RULE in another sheet is still detected as a leak');
  ok(!leaksIn('/* `.tx-vh-panel` was tried first and rejected. */\n.chat-x { color: red; }'),
     'CONTROL: ...and a comment that merely NAMES one is not, which is the false positive removed');
  ok(!leaksIn('/* a\n .tx-vh-panel\n b */\n.chat-x { color: red; }'),
     'CONTROL: ...including across a multi-line comment');

  // THE SAME GUARD, DRIVEN OVER THE REAL DISK PATH. The three controls above
  // exercise the DETECTOR on strings; they say nothing about the walk, the
  // read and the exclusion of text.css itself, which is the half that decides
  // whether a real file in a real directory is seen. §9 plants a .js file for
  // the same reason. Every `tx-` rule in this app is now load-bearing for a
  // second component (the readout's mark), so this half is worth executing.
  const plantedCss = join(NEXT, 'views', '__tx_planted_probe.css');
  try {
    writeFileSync(plantedCss, '.tx-readout-value { display: block; gap: 0; }\n');
    const found = walk(NEXT, '.css')
      .filter((p) => !p.endsWith('shared/text.css'))
      .filter((p) => leaksIn(readFileSync(p, 'utf8')));
    // `includes`, not `length === 1`: the assertion above already owns "no
    // OTHER sheet leaks", and making this one depend on that too turns one
    // planted file into two reds saying the same thing.
    ok(found.includes(plantedCss),
       'CONTROL: a `tx-` rule planted as a REAL FILE under /next is found by the walk-and-read ' +
       'path, not just by the string detector (found: ' +
       (found.map((p) => p.split('/').pop()).join(', ') || 'NOTHING') + ')');
  } finally {
    try { unlinkSync(plantedCss); } catch { /* already gone */ }
  }
  const cssStillClean = walk(NEXT, '.css')
    .filter((p) => !p.endsWith('shared/text.css'))
    .filter((p) => leaksIn(readFileSync(p, 'utf8')));
  ok(cssStillClean.length === 0, 'the planted stylesheet was removed and the tree is clean again');

  // ── THE READOUT VALUE CARRIES THE MARK, AND THE RULE SAYS SO ──────────
  // v3.62.0. renderReadout's markHtml puts a `.fresh-dot` INSIDE
  // .tx-readout-value; without these three declarations the mark and the
  // figure are a block box and a stray inline, which is a dot on its own
  // line. The rule is asserted here rather than trusted because the JS half
  // is now meaningless without it and the two live in different files.
  const declsOf = (sel) => {
    const src = stripCssComments(textCss);
    const re = new RegExp('(?:^|\\})\\s*\\' + sel + '\\s*\\{([^}]*)\\}');
    const m = src.match(re);
    return m ? m[1] : null;
  };
  const valDecls = declsOf('.tx-readout-value');
  const prop = (decls, name) => {
    const m = decls && decls.match(new RegExp('(?:^|[;{])\\s*' + name + '\\s*:\\s*([^;}]+)'));
    return m ? m[1].trim() : null;
  };
  ok(valDecls !== null, '.tx-readout-value has a rule in text.css at all');
  ok(prop(valDecls, 'display') === 'inline-flex',
     'the readout value is `inline-flex`, so a mark and the figure sit on ONE line (reads: ' +
     prop(valDecls, 'display') + ')');
  ok(prop(valDecls, 'gap') === 'var(--space-3)',
     'and the mark-to-figure gap is var(--space-3) - the same 6px .fnd-fresh already uses, ' +
     'so two marks on one screen are not two spacings (reads: ' + prop(valDecls, 'gap') + ')');
  ok(prop(valDecls, 'align-items') === 'baseline',
     'and the cross-axis is `baseline`, NOT `center`: measured, a centred mark on a value that ' +
     'WRAPPED drifts to the middle of the block (11.4-19.4px on a two-line value) while ' +
     'baseline stays on line one (4.0-12.0px, one line or two) (reads: ' +
     prop(valDecls, 'align-items') + ')');
  ok(prop(valDecls, 'overflow-wrap') === 'anywhere' &&
     prop(valDecls, 'font-family') === 'var(--font-mono)',
     'CONTROL: the rule the three declarations were added to is still the readout FIGURE rule - ' +
     'mono, and still allowed to wrap');
  ok(prop('.tx-x { display: block; }', 'display') === 'block' &&
     prop('.tx-x { align-items: center; }', 'align-items') === 'center' &&
     prop('.tx-x { color: red; }', 'display') === null,
     'CONTROL: the declaration reader reports a DIFFERENT value as different and an absent one ' +
     'as null - so the three assertions above can actually fail');

  // REACHABILITY. v3.9.1: progress-ring.css shipped styled but UNLINKED for a
  // whole release, and both existing guards were blind - one read stylesheets
  // from disk, the other grepped index.html for asset paths.
  const html = read('index.html');
  ok(html.includes('href="/next/shared/text.css"'),
     'text.css is actually linked from index.html - a stylesheet that exists but is never ' +
     'loaded is dead CSS, and every element depending on it renders unstyled');
}

// =======================================================================
console.log('\n§9  NO LOCAL COPY - the renderers are single-source');
{
  // The format-usd.js contract: one module, and a test asserts no view has
  // re-grown a local copy. Enumerated FROM DISK - a hardcoded file list is
  // exactly how the v3.8.0 single-copy guard went blind.
  const jsFiles = walk(NEXT, '.js');
  ok(jsFiles.length > 10, 'enumerated ' + jsFiles.length + ' /next .js files from disk');
  const NAMES = ['renderReadout', 'renderReadoutGroup', 'renderDescription',
                 'renderStatus', 'renderBadge', 'renderExplainer'];
  // Every declaration form, including `export default` - the v3.8.0 rebuild
  // still missed that one under a docblock claiming completeness.
  const declRe = (n) => new RegExp(
    '(?:^|\\n)\\s*(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s+' + n + '\\b' +
    '|(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+' + n + '\\s*=', 'g');
  for (const name of NAMES) {
    const hits = [];
    for (const f of jsFiles) {
      const n = (readFileSync(f, 'utf8').match(declRe(name)) || []).length;
      if (n) hits.push(f.replace(NEXT + '/', '') + (n > 1 ? ' x' + n : ''));
    }
    ok(hits.length === 1 && hits[0] === 'shared/text.js',
       name + ' is declared exactly once, in shared/text.js (found: ' +
       (hits.join(', ') || 'NOWHERE') + ')');
  }

  // POSITIVE CONTROL: the guard must actually bite.
  const planted = join(NEXT, 'views', '__tx_planted_probe.js');
  try {
    writeFileSync(planted, 'export function renderBadge(o) { return "local copy"; }\n');
    const after = walk(NEXT, '.js').filter((f) =>
      (readFileSync(f, 'utf8').match(declRe('renderBadge')) || []).length);
    ok(after.length === 2,
       'CONTROL: the no-local-copy detector FIRES on a planted duplicate renderBadge (saw ' +
       after.length + ' declaration sites, expected 2) - so the assertions above are not vacuous');
  } finally {
    try { unlinkSync(planted); } catch { /* already gone */ }
  }
  const stillGone = walk(NEXT, '.js').filter((f) =>
    (readFileSync(f, 'utf8').match(declRe('renderBadge')) || []).length);
  ok(stillGone.length === 1, 'the planted probe was removed and the tree is clean again');

  ok(!/^import\s|\bfrom\s+['"]/m.test(textJs.replace(/\/\*[\s\S]*?\*\//g, '')),
     'shared/text.js takes NO imports, so it stays importable in Node - importing app.js ' +
     'throws ReferenceError: document is not defined, and that is what reduces a suite to ' +
     'source scans (v3.18.0, shared/listbox.js)');
}

// =======================================================================
// §10  THE ROLE → TOKEN STANDARD (v3.56.0)
// =======================================================================
//
// The maintainer's ask, from his own production screenshots: "some titles are
// much bigger than they should be — we need a standard, the size of fonts set
// per role". docs/design-system-source.md § "The type standard" is that
// standard in prose; this section is the part of it a stylesheet edit cannot
// walk away from.
//
// IT GUARDS THE TOKEN, NOT THE NUMBER. Every assertion below reads the
// stylesheet for which `--text-*` / `--type-*` name a role takes, never for a
// px value — so a future change to the ramp's own values in
// tokens/typography.css moves the whole app at once and reds nothing here,
// which is exactly the property a ramp is for. What it refuses is a rule
// that leaves the ramp, or a role that picks a different rung in one view
// than in another.
//
// COMMENTS ARE STRIPPED FIRST, for the reason §8 already records: a guard
// that fires on prose teaches people to reword explanations instead of fixing
// code. The controls at the end of each block prove each detector still bites.
console.log('\n§10  THE ROLE -> TOKEN STANDARD');
{
  const stripCssComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ');

  // Every /next stylesheet, from disk. A hardcoded list is how a guard goes
  // blind (§8's own note), and the views/ directory grows.
  const sheets = walk(NEXT, '.css')
    .map((p) => [p.replace(NEXT + '/', ''), stripCssComments(readFileSync(p, 'utf8'))]);
  ok(sheets.length >= 15,
     `enumerated ${sheets.length} /next stylesheets from disk`);

  // Split a stylesheet into { selector, decls } records. Deliberately dumb:
  // a brace walker over comment-stripped source, which is all these
  // assertions need and is the same shape the other CSS suites use.
  function rules(css) {
    const out = [];
    let depth = 0, selStart = 0;
    for (let i = 0; i < css.length; i++) {
      const c = css[i];
      if (c === '{') {
        if (depth === 0) {
          const sel = css.slice(selStart, i).trim().replace(/\s+/g, ' ');
          const close = matchBrace(css, i);
          if (close !== -1 && !sel.startsWith('@')) out.push({ sel, decls: css.slice(i + 1, close) });
        }
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth <= 0) { depth = 0; selStart = i + 1; }
      }
    }
    return out;
  }
  function matchBrace(css, at) {
    let d = 0;
    for (let i = at; i < css.length; i++) {
      if (css[i] === '{') d++;
      else if (css[i] === '}') { d--; if (d === 0) return i; }
    }
    return -1;
  }
  // The size a rule sets, as the TOKEN NAME it reads — from `font-size:` or
  // from the `font:` shorthand — or 'PX-LITERAL', or null for "sets none".
  function sizeTokenOf(decls) {
    const fs = decls.match(/(?:^|[;{])\s*font-size\s*:\s*([^;}]+)/);
    const sh = decls.match(/(?:^|[;{])\s*font\s*:\s*([^;}]+)/);
    const v = fs ? fs[1] : (sh ? sh[1] : null);
    if (v === null) return null;
    const t = v.match(/var\((--(?:text|type)-[a-z0-9-]+)\)/);
    if (t) return t[1];
    if (/(?:^|[^a-zA-Z0-9_.-])\d*\.?\d+px/.test(fs ? v : v.replace(/\/\s*[\d.]+px/, '/L')))
      return 'PX-LITERAL';
    return v.trim();
  }
  function weightTokenOf(decls) {
    const m = decls.match(/(?:^|[;{])\s*font-weight\s*:\s*([^;}]+)/);
    if (m) {
      const t = m[1].match(/var\((--weight-[a-z]+)\)/);
      return t ? t[1] : m[1].trim();
    }
    const sh = decls.match(/(?:^|[;{])\s*font\s*:\s*([^;}]+)/);
    if (sh) {
      const t = sh[1].match(/var\((--weight-[a-z]+)\)/);
      if (t) return t[1];
      const r = sh[1].match(/var\((--type-[a-z0-9-]+)\)/);
      if (r) return { '--type-h1': '--weight-semibold', '--type-h2': '--weight-semibold',
                      '--type-h3': '--weight-semibold', '--type-body': '--weight-regular',
                      '--type-body-sm': '--weight-regular', '--type-label': '--weight-medium',
                      '--type-mono': '--weight-regular', '--type-eyebrow': '--weight-medium',
                      '--type-caption': '--weight-medium', '--type-display': '--weight-semibold' }[r[1]] || null;
    }
    return null;
  }
  const allRules = sheets.flatMap(([file, css]) => rules(css).map((r) => ({ ...r, file })));
  ok(allRules.length > 400,
     `parsed ${allRules.length} top-level rules across those sheets`);

  // ── (i) EVERY STANDARDISED TITLE READS A RAMP TOKEN ───────────────────
  // The list is EXPLICIT rather than a `-title$` pattern, and that is the
  // point: it names the selectors this release measured and moved, so a
  // rename cannot silently drop one out of the guard's reach (the assertion
  // below proves every name is still findable). Three rungs:
  //   VIEW    = --type-h1            the one <h1> on a screen
  //   HERO    = --type-h2            a column or overlay with no <h1>
  //   TITLE   = --type-h3            block, card and sidebar titles
  //   SUB     = --text-md / semibold a group inside a block or card
  // `.tx-vh-title` is deliberately NOT here, and the first draft of this
  // section put it here and went red, which is the useful kind of red: it
  // sets `margin: 0` and NOTHING ELSE. renderViewHeader emits it as a second
  // class beside `.view-title` (main region) or `.sidebar-title` (sidebar),
  // and those two carry the size — so the header component takes whichever
  // rung its position calls for rather than declaring a third. Listing a
  // placement-only class as a size role would have pinned a size that rule
  // must never grow.
  const VIEW_TITLE = ['.view-title', '.reader-title'];
  const HERO_TITLE = ['.chat-empty-title', '.mcpw-title', '.sbw-title'];
  const CARD_TITLE = [
    '.sidebar-title', '.settings-job-title', '.dm-health-title',
    '.sb-card-title', '.sb-cta-title', '.sb-enable-title',
    '.sync-setup-title', '.sync-decision-title', '.chat-browse-title',
    '.ing-queue-panel-title', '.ing-queue-confirm-title', '.obp-title', '.cfd-title',
  ];
  const SUB_TITLE = [
    '.tx-status-title', '.dm-lc-title', '.dm-confirm-title', '.settings-shelf-title',
    '.model-lane-title', '.build-list-title', '.build-change-title',
    '.sb-admin-row-title', '.sb-outcome-headline', '.ing-change-title',
    '.chat-compile-change-title', '.mem-doc-empty-title',
  ];
  // The page-subtitle rung: the line that qualifies the <h1> it sits under.
  const PAGE_SUBTITLE = ['.mem-project-name', '.mem-project-domain', '.mem-project-sep'];
  // The sidebar list row's own name. `.dm-row-name` moved to the kit's own
  // `.cur-sb-name` (v3.65.0): the row rule itself now lives in
  // shared/sidebar.css, with `dm-row-name` riding only as an alias TOKEN on
  // the rendered element — no stylesheet declares a rule for that name any
  // more, so the standard follows the rule the kit actually owns. `.mem-row-
  // name` is gone the same way — memory.js's sidebar row is the kit's row
  // now too, so `.cur-sb-name` alone carries this rung for it as well.
  // `.chat-conv-title` is gone the same way in v3.72.0 (P3): Chat's
  // conversation rows adopted the kit's row, so `.cur-sb-name` carries it.
  const ROW_NAME = ['.cur-sb-name', '.sync-domain-name',
                    '.sb-conn-name', '.ing-dest-name'];

  /**
   * TARGETING, not equality. A rule reaches `.reader-title` as
   * `.reader-body .reader-title` and `.dm-row-name` as
   * `.dm-row.active .dm-row-name`, so a comma-part TARGETS the class when its
   * final compound is exactly that class. The first draft compared the whole
   * selector string and reported `.reader-title` as having no rule at all —
   * the shape where a guard passes by not looking.
   */
  function targets(selectorList, cls) {
    return selectorList.split(',').some((part) => {
      const last = part.trim().split(/\s+|>|\+|~/).filter(Boolean).pop();
      return last === cls;
    });
  }
  /**
   * EVERY size-setting rule that reaches `sel`, not just the winning one.
   * Deciding a winner would need a specificity calculator adjudicating a
   * cross-file cascade — the decorative-guard shape this file's header
   * refuses — and it is not needed: the standard's claim is that NO rule
   * anywhere puts this role off its rung, which is strictly stronger.
   */
  function sizesOf(sel) {
    return allRules
      .filter((r) => targets(r.sel, sel) && sizeTokenOf(r.decls) !== null)
      .map((r) => ({ token: sizeTokenOf(r.decls), weight: weightTokenOf(r.decls), file: r.file, sel: r.sel }));
  }
  /** The one a human means by "what size is this" — for the readable message. */
  function sizeOf(sel) {
    const hits = sizesOf(sel);
    return hits.length ? hits[hits.length - 1] : { token: 'NO-RULE', weight: null, file: null };
  }

  const ROLE_CHECKS = [
    ['view title', VIEW_TITLE, ['--type-h1'], null],
    ['hero / overlay title', HERO_TITLE, ['--type-h2'], null],
    ['block / card / sidebar title', CARD_TITLE, ['--type-h3', '--text-lg'], '--weight-semibold'],
    ['sub-title inside a block', SUB_TITLE, ['--text-md'], '--weight-semibold'],
    ['page subtitle under the h1', PAGE_SUBTITLE, ['--text-base'], '--weight-medium'],
    ['sidebar row name', ROW_NAME, ['--text-md', '--type-body-sm'], null],
  ];
  for (const [role, sels, allowed, weight] of ROLE_CHECKS) {
    const bad = [];
    for (const sel of sels) {
      const hits = sizesOf(sel);
      if (!hits.length) { bad.push(`${sel} has NO size rule anywhere`); continue; }
      for (const h of hits) {
        if (!allowed.includes(h.token)) bad.push(`${h.file} \`${h.sel}\` reads ${h.token}`);
        else if (weight && h.weight !== weight) bad.push(`${h.file} \`${h.sel}\` is ${h.weight}, not ${weight}`);
      }
    }
    ok(bad.length === 0,
       `${role}: every size rule reaching its ${sels.length} selectors reads ${allowed.join(' or ')}` +
       (weight ? ` at ${weight}` : '') +
       (bad.length ? ` — OFF STANDARD: ${bad.join('; ')}` : ''));
  }

  // The list is only a guard while every name in it still exists. A renamed
  // class would otherwise resolve to NO-RULE... which the check above already
  // catches — so this asserts the inverse: nothing in the standard is a name
  // no stylesheet has ever heard of.
  const everySel = [...VIEW_TITLE, ...HERO_TITLE, ...CARD_TITLE, ...SUB_TITLE,
                    ...PAGE_SUBTITLE, ...ROW_NAME];
  const ghosts = everySel.filter((s) => sizeOf(s).token === 'NO-RULE');
  ok(ghosts.length === 0,
     `all ${everySel.length} standardised selectors resolve to a real rule` +
     (ghosts.length ? ` — GHOSTS: ${ghosts.join(', ')}` : ''));

  // CONTROLS for (i): the size reader must see both declaration forms, and
  // must call a px literal a px literal.
  ok(sizeTokenOf('font: var(--type-h3); color: var(--text);') === '--type-h3',
     'CONTROL: the size reader resolves the `font:` SHORTHAND form');
  ok(sizeTokenOf('font-size: var(--text-md); font-weight: 600;') === '--text-md',
     'CONTROL: ...and the `font-size:` longhand form');
  ok(sizeTokenOf('font-size: 14.5px;') === 'PX-LITERAL',
     'CONTROL: ...and reports a frozen px literal as PX-LITERAL');
  ok(sizeTokenOf('font: var(--weight-medium) var(--text-2xs)/15px var(--font-mono);') === '--text-2xs',
     'CONTROL: ...and is not fooled by a px LINE-HEIGHT inside the shorthand (.rail-badge)');
  ok(sizeTokenOf('color: var(--text-2); margin: 0;') === null,
     'CONTROL: ...and returns null for a rule that sets no size at all');
  ok(weightTokenOf('font: var(--type-h3);') === '--weight-semibold',
     'CONTROL: the weight reader unpacks a composed --type-* role');

  // ── (ii) THE READOUT VALUE IS DECLARED ONCE, AND NO VIEW RAISES IT ────
  // The figure competes with the block title it sits inside if it reaches the
  // title rung, which is exactly what shipped: --text-lg on BOTH. It is
  // --text-base now, and the ceiling the standard states is --text-lg.
  const RAMP_ORDER = ['--text-2xs', '--text-xs', '--text-sm', '--text-md',
                      '--text-base', '--text-lg', '--text-xl', '--text-2xl',
                      '--text-3xl', '--text-4xl', '--text-5xl'];
  const readoutDecls = allRules.filter((r) =>
    /(^|[\s,>+~])\.tx-readout-value(\s|,|$)/.test(r.sel) && sizeTokenOf(r.decls) !== null);
  ok(readoutDecls.length === 1 && readoutDecls[0].file === 'shared/text.css',
     `the readout value's size is declared EXACTLY ONCE, in shared/text.css ` +
     `(found ${readoutDecls.length}: ${readoutDecls.map((r) => r.file).join(', ') || 'none'})`);
  const readoutToken = readoutDecls.length ? sizeTokenOf(readoutDecls[0].decls) : null;
  ok(readoutToken === '--text-base',
     `the readout value is --text-base — one rung under the block title, so a figure never ` +
     `out-shouts the heading of the block containing it (reads ${readoutToken})`);
  ok(RAMP_ORDER.indexOf(readoutToken) <= RAMP_ORDER.indexOf('--text-lg'),
     'and it is at or under the standard\'s --text-lg ceiling');
  // §8 already refuses a `tx-` RULE in any other sheet, which is what makes
  // "declared once" enforceable at all. Named here so the two cannot drift.
  ok(sheets.filter(([f]) => f !== 'shared/text.css')
        .every(([, css]) => !/\.tx-readout-value/.test(css)),
     'no other stylesheet mentions .tx-readout-value at all, so nothing can override it upward');

  // (iii) — the memory view's 'Working on' line (.mem-working-text) was deleted in v3.62.0 with the Status block; its reading now lives in the strip through renderReadout.

  // ── (iv) NO NEW PX FONT SIZE ANYWHERE THE STANDARD REACHES ────────────
  // The hard ratchet lives in test-css-tokens.js's FROZEN_PX_CEILING (lowered
  // to shell.css: 1 by this release). This is the per-ROLE half: not one
  // selector in the standard may leave the ramp, ever, under any ceiling.
  const offRamp = everySel
    .concat(['.tx-readout-value'])
    .map((s) => [s, sizeOf(s)])
    .filter(([, r]) => r.token === 'PX-LITERAL' || !/^--(text|type)-/.test(r.token));
  ok(offRamp.length === 0,
     `every selector in the standard reads a --text-* or --type-* token — a px literal is the ` +
     `one size Settings > General's text-size control cannot reach` +
     (offRamp.length ? ` — OFF RAMP: ${offRamp.map(([s, r]) => `${s} = ${r.token}`).join(', ')}` : ''));

  // ── (v) ONE EYEBROW FACE ──────────────────────────────────────────────
  // typography.css reserves mono for "everything the machine owns", and names
  // eyebrow labels in that list. `.cur-group-title` was the one sans eyebrow.
  const EYEBROWS = ['.cur-eyebrow', '.cur-group-title'];
  const sansEyebrow = EYEBROWS.filter((sel) => {
    const r = allRules.filter((x) => x.sel.split(',').map((s) => s.trim()).includes(sel));
    return !r.some((x) => /var\(--type-eyebrow\)|var\(--font-mono\)/.test(x.decls));
  });
  ok(sansEyebrow.length === 0,
     'every shell eyebrow takes --type-eyebrow (mono) — the app had one in sans, on the same ' +
     'screen as three in mono' + (sansEyebrow.length ? ` — SANS: ${sansEyebrow.join(', ')}` : ''));

  // CONTROLS for (ii)-(v): each detector fires on a planted violation, driven
  // through the REAL readers rather than a re-implementation of them.
  const plantedRaise = rules('.mem-status .tx-readout-value { font-size: var(--text-2xl); }');
  ok(plantedRaise.length === 1 && sizeTokenOf(plantedRaise[0].decls) === '--text-2xl'
     && RAMP_ORDER.indexOf('--text-2xl') > RAMP_ORDER.indexOf('--text-lg'),
     'CONTROL: a planted view override raising .tx-readout-value above the ceiling IS detected');
  const plantedPx = rules('.dm-health-title { font-size: 15px; }');
  ok(sizeTokenOf(plantedPx[0].decls) === 'PX-LITERAL',
     'CONTROL: a planted px literal on a standardised title IS detected');
  ok(!/var\(--type-eyebrow\)|var\(--font-mono\)/.test('font: var(--weight-medium) var(--text-xs)/1 var(--font-sans);'),
     'CONTROL: the eyebrow-face detector FIRES on the sans form this release replaced');
}

// =======================================================================
console.log('\n------------------------------------------------------------');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed === 0) console.log('All text-system offline assertions green');
process.exit(failed === 0 ? 0 : 1);
