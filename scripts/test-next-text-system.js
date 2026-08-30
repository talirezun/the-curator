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

  const tokenCss = ['color', 'space', 'shape', 'typography', 'motion']
    .map((n) => read('tokens/' + n + '.css')).join('\n');
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
console.log('\n------------------------------------------------------------');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed === 0) console.log('All text-system offline assertions green');
process.exit(failed === 0 ? 0 : 1);
