#!/usr/bin/env node
/**
 * test-next-title-affordances.js — OFFLINE. HOVER-ONLY INFORMATION IN /next.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 *
 * A `title=` attribute on an element that CANNOT BE FOCUSED is hover-only. A
 * keyboard user never reaches it. On touch there is no hover at all, so the
 * string does not exist. v3.20.0 counted 11 such strings in this tree and
 * filed them as known-and-unfixed; v3.22.0 built the fix — a real focusable
 * <button> revealing a panel, Escape closes it and returns focus — and used it
 * only for view headers, recording the rest as still open.
 *
 * This suite is the ratchet. It measures the population and fails on GROWTH.
 *
 * ── WHY A CLASS GUARD AND NOT A LIST OF SITES ──────────────────────────────
 *
 * v3.22.0 found a mutation that reddened only the specifically-named
 * assertion while the class stayed unguarded, and v3.20.0 found a guard
 * commissioned to enforce adoption that could not fail at all. So §1 counts
 * over EVERY view file ENUMERATED FROM DISK — a hardcoded list is how a
 * previous guard in this repo went blind when a new file appeared — and the
 * named assertions in §3–§5 are defence in depth on top of it, never the
 * primary.
 *
 * ── WHAT COUNTS AS FOCUSABLE, AND WHY THE SCAN OVER-REPORTS ON PURPOSE ─────
 *
 * `<button>`, `<a>`, `<input>`, `<select>`, `<textarea>`, `<summary>`,
 * `<details>` are focusable — UNLESS `disabled` appears in the same tag, which
 * removes a control from the tab order entirely. That last part is the one
 * most easily missed: a tooltip on a disabled button is exactly as unreachable
 * as one on a <span>, and in this tree it was routinely the ONLY statement of
 * why a control was greyed out.
 *
 * These are string-concatenation templates, so `disabled` is usually inside a
 * ternary and the scan cannot know whether it fires. It counts the tag as
 * disabled whenever the token appears — and counts a title it cannot attribute
 * to any tag at all (one held in a variable, then concatenated in) as
 * non-focusable too. Both are the SAFE direction for a ratchet: it can
 * over-report, never under-report, so the number can only be driven down by
 * removing real tooltips.
 *
 * ── NOT ENFORCED, stated rather than implied away ──────────────────────────
 *
 *  · Whether the information is genuinely reachable some OTHER way. A `title=`
 *    that repeats visible text is counted the same as one carrying a unique
 *    sentence. Triage is a human judgement; this only bounds the population.
 *  · `aria-label`, `aria-describedby` and `.visually-hidden` are not credited
 *    — a site fixed that way must also drop its `title=` for the count to move.
 *  · A tooltip set from JavaScript (`el.title = …`) is invisible to this scan.
 *  · It does not measure rendering. Nothing offline in this repo does; the
 *    keyboard behaviour of the info mark is a browser check, not this file.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}
function section(t) { console.log('\n' + t); }

const VIEWS_DIR = 'src/public/next/views';
const TEXT_JS = 'src/public/next/shared/text.js';

// ── The comment stripper ───────────────────────────────────────────────────
// A source scan that reads its own explanatory comments is the hazard v3.19.0
// recorded: an ABSENCE check passed because the replacement COMMENT quoted the
// very selector it asserted was deleted. This file's comments are full of the
// literal string `title=`, so without this the suite would count itself.
// Newlines inside block comments are preserved so reported line numbers stay
// true to the original file.
function stripComments(src) {
  let out = '', i = 0; const n = src.length; let q = null;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (q) {
      if (c === '\\') { out += c + (d || ''); i += 2; continue; }
      if (c === q) { q = null; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      let nl = ''; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') nl += '\n'; i++; }
      i += 2; out += nl + ' '; continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

const FOCUSABLE = /^(?:button|a|input|select|textarea|summary|details)$/i;

/** Every HTML `title=` in a source file, with the tag it belongs to. */
function scanTitles(code) {
  const src = stripComments(code);
  const hits = [];
  // `[^-\w]` before the word rejects `data-conv-title=`, `data-browse-title=`
  // and any other `*-title` data attribute — three of which exist in this tree
  // and are not tooltips at all.
  const re = /(^|[^-\w])title="/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const at = m.index + m[0].length - 'title="'.length;
    const before = src.slice(Math.max(0, at - 1400), at);
    const tagM = [...before.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)/g)].pop();
    let tag = null, disabled = false;
    if (tagM) {
      const seg = before.slice(tagM.index);
      // A literal `>` between the tag name and here means that tag already
      // closed, so this title belongs to something else. `=>` is an arrow
      // function, not a tag close.
      if (!/>/.test(seg.replace(/=>/g, ''))) { tag = tagM[1]; disabled = /\bdisabled\b/.test(seg); }
    }
    hits.push({
      line: src.slice(0, at).split('\n').length,
      tag: tag || '(unattributed)',
      disabled,
      focusable: !!(tag && FOCUSABLE.test(tag) && !disabled),
    });
  }
  return hits;
}

const viewFiles = readdirSync(VIEWS_DIR).filter((f) => f.endsWith('.js')).sort();
const sourceOf = {};
for (const f of viewFiles) sourceOf[f] = readFileSync(join(VIEWS_DIR, f), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
section('§1  THE SCANNER ITSELF — positive controls before any measurement');
// A count is worthless if the instrument cannot detect the thing it counts.
{
  // Written as template literals so the probe HTML needs no backslash
  // escaping — an escaped quote would make the probe stop matching and the
  // control would pass for the wrong reason.
  const probe = [
    `'<span title="hover only">x</span>'`,
    `'<button title="reachable">x</button>'`,
    `'<button disabled title="not reachable">x</button>'`,
    `'<a href="#" title="reachable">x</a>'`,
    `'<div data-browse-title="not a tooltip">x</div>'`,
  ].join(' + ');
  const hits = scanTitles(probe);
  ok('detects a title on a <span> as hover-only',
    hits.some((h) => h.tag === 'span' && !h.focusable));
  ok('an ENABLED <button> is focusable, so its title is not counted',
    hits.some((h) => h.tag === 'button' && !h.disabled && h.focusable));
  ok('a DISABLED <button> is NOT focusable — the case most easily missed',
    hits.some((h) => h.tag === 'button' && h.disabled && !h.focusable));
  ok('an <a> is focusable', hits.some((h) => h.tag === 'a' && h.focusable));
  ok('`data-browse-title=` is not a tooltip and is not counted', hits.length === 4);

  // CONTROLS for the stripper. A source scan that reads its own explanatory
  // comments is the hazard v3.19.0 recorded — an ABSENCE check that passed
  // because the replacement COMMENT quoted the selector it asserted was gone.
  const inComments = `// <span title="in a line comment">\n/* <span title="in a block comment"> */\nconst x = 1;`;
  ok('CONTROL: the comment stripper really strips — a title= inside a comment is not counted',
    scanTitles(inComments).length === 0);
  const real = `const a = '<span title="real">';`;
  ok('CONTROL: ...and the stripper is not simply deleting everything — a real one still counts',
    scanTitles(inComments + '\n' + real).length === 1);
  ok('CONTROL: block comments keep their newlines, so reported line numbers stay true',
    scanTitles(`/*\n\n\n*/\n` + real)[0].line === 5);

  // THE CONTROL THAT MATTERS, run against REAL source rather than a fixture.
  // views/domains.js now carries a comment that QUOTES the very tooltip it
  // records removing (`<span title="Read-only Shared Brain mirror">`). Without
  // the stripper this guard would count that explanation as the defect it
  // describes and report the site as never fixed — v3.19.0's
  // comment-satisfies-a-scan hazard, inverted. Measured, not assumed.
  const dRaw = readFileSync(join(VIEWS_DIR, 'domains.js'), 'utf8');
  const dRawN = (dRaw.match(/title="/g) || []).length;
  const dStripN = (stripComments(dRaw).match(/title="/g) || []).length;
  ok(`CONTROL: a real view file's comments are stripped (domains.js ${dRawN} raw -> ${dStripN} in code)`,
    dRawN > dStripN && dStripN >= 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  THE RATCHET — every view file, enumerated from disk');
//
// Lower a number here when a view is converted. NEVER raise one. A new
// hover-only tooltip anywhere in /next fails this section by construction,
// including in a file that did not exist when this was written (ceiling 0).
const CEILING = {
  // LOWERED 6 -> 4. The two `.chat-msg-cost` spans became a real focusable
  // button + panel (the per-answer token breakdown, which v3.20.0 named the
  // worst of the 11 because it is the one that justifies a dollar figure).
  // The 4 that remain are unrelated and pre-existing: two model-menu marks,
  // the compile button while disabled, and the send/stop button's
  // unattributed title. NEVER raise this back.
  'chat.js': 4,
  'domains.js': 1,     // the Flip button, focusable whenever it is not busy
  'ingest.js': 0,
  'memory.js': 3,
  'settings.js': 9,
  'shared.js': 0,
  'shared-brain-wizard.js': 0,
  'sync.js': 0,
};
{
  let total = 0;
  for (const f of viewFiles) {
    const hover = scanTitles(sourceOf[f]).filter((h) => !h.focusable);
    total += hover.length;
    const cap = Object.prototype.hasOwnProperty.call(CEILING, f) ? CEILING[f] : 0;
    ok(`${f}: ${hover.length} hover-only title= (ceiling ${cap})` +
       (hover.length ? ' — ' + hover.map((h) => 'L' + h.line + ' <' + h.tag + '>').join(', ') : ''),
      hover.length <= cap);
  }
  const TOTAL_CEILING = Object.values(CEILING).reduce((a, b) => a + b, 0);
  ok(`tree total ${total} hover-only title= across ${viewFiles.length} view files (ceiling ${TOTAL_CEILING})`,
    total <= TOTAL_CEILING);
  ok('the scan actually enumerated files from disk, it did not silently find none',
    viewFiles.length >= 8 && viewFiles.includes('settings.js'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  THE AFFORDANCE IS THE SHARED CONTRACT, NOT A SECOND PATTERN');
{
  const textSrc = readFileSync(TEXT_JS, 'utf8');
  const settings = sourceOf['settings.js'];

  // Extract `infoMark` by brace-matching and EXECUTE it. settings.js imports
  // app.js, which throws in Node (`document is not defined`), so the whole
  // module cannot be imported — the constraint shared/text.js's own docblock
  // records. Executing the one function is stronger than reading it.
  const start = settings.indexOf('function infoMark(');
  ok('infoMark() exists in settings.js', start > -1);
  let end = settings.indexOf('{', start), depth = 0, i = end;
  for (; i < settings.length; i++) {
    if (settings[i] === '{') depth++;
    else if (settings[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const glyphM = settings.match(/const TX_INFO_GLYPH =([\s\S]*?);\n/);
  ok('TX_INFO_GLYPH is defined in settings.js', !!glyphM);
  const fn = new Function('escapeHtml',
    'const TX_INFO_GLYPH =' + glyphM[1] + ';\n' + settings.slice(start, i) + '\nreturn infoMark;')(
    (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));

  const out = fn('probe-id', 'About the probe', 'The sentence that used to be a tooltip.');

  ok('the mark is a real <button type="button">, never a <span>',
    /^<button type="button"/.test(out.btn));
  ok('it is NOT disabled — a disabled button is out of the tab order, which is the defect',
    !/\bdisabled\b/.test(out.btn));
  ok('it carries data-tx-info, the attribute the shared delegated listener keys on',
    out.btn.includes('data-tx-info="probe-id"'));
  ok('aria-expanded starts false', out.btn.includes('aria-expanded="false"'));
  ok('aria-controls names the panel', out.btn.includes('aria-controls="probe-id"'));
  ok('it has an accessible name from aria-label, not from title alone',
    out.btn.includes('aria-label="About the probe"'));
  ok('the panel is HIDDEN on first paint — the whole point is that prose is not floating under a label',
    /<div class="tx-vh-panel" id="probe-id"[^>]*\shidden>/.test(out.panel));
  ok('the panel id matches the button’s aria-controls', out.panel.includes('id="probe-id"'));
  ok('the panel carries the prose', out.panel.includes('The sentence that used to be a tooltip.'));
  ok('the prose is escaped', fn('x', 'y', '<img onerror=1>').panel.includes('&lt;img'));
  ok('empty info renders NOTHING — no headless button pointing at no panel',
    fn('x', 'y', '   ').btn === '' && fn('x', 'y', '   ').panel === '');

  // The glyph is a COPY while shared/text.js is owned by another workstream.
  // Two hand-maintained copies of one thing is this repo's most reliable
  // early-warning shape, so it is pinned byte-identical rather than trusted.
  const theirs = textSrc.match(/const INFO_GLYPH =([\s\S]*?);\n/);
  ok('shared/text.js still has INFO_GLYPH to compare against', !!theirs);
  ok('settings.js’s TX_INFO_GLYPH is BYTE-IDENTICAL to shared/text.js’s INFO_GLYPH',
    glyphM[1].trim() === theirs[1].trim());
  ok('CONTROL: that comparison can fail — a changed glyph is not equal',
    glyphM[1].trim() !== theirs[1].trim().replace('r="9"', 'r="8"'));

  // The behaviour is inherited, not reimplemented. If the shared listener ever
  // becomes scoped to the header, every mark emitted here goes dead silently.
  const wire = textSrc.slice(textSrc.indexOf('function wireInfoToggles'));
  ok('the shared listener is keyed on [data-tx-info], NOT on .tx-vh — so a mark outside a header works',
    wire.includes('[data-tx-info]') && !/querySelectorAll\('\.tx-vh[ ,\]]/.test(wire));
  ok('the shared listener still closes on Escape', /e\.key !== 'Escape'/.test(wire));
  ok('...and RETURNS FOCUS to the button rather than dropping it to <body>',
    /last\.focus\(\)/.test(wire));
  ok('...and dismisses on an outside click while leaving clicks inside the panel alone',
    wire.includes('panel.contains(e.target)'));
  ok('settings.js imports shared/text.js, so that listener is installed before any mark renders',
    /from '\.\.\/shared\/text\.js'/.test(settings));
  ok('settings.js does NOT re-implement the toggle — no second listener',
    !/addEventListener\('keydown'[\s\S]{0,400}Escape[\s\S]{0,400}tx-vh/.test(settings));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  THE CONVERTED SITES — named, on top of the class guard');
{
  const s = sourceOf['settings.js'], d = sourceOf['domains.js'],
        sh = sourceOf['shared.js'], ing = sourceOf['ingest.js'];

  ok('settings: the build-lane chip’s meaning is behind a mark, not on the <span>',
    s.includes("infoMark('settings-build-chip-info'") &&
    !/model-badge model-measured ' \+ escapeHtml\(chip\.cls\) \+ '" title=/.test(s));
  ok('settings: "no models yet" states its reason through a mark',
    s.includes("infoMark(\n      'settings-nomodels-info-'") || s.includes("'settings-nomodels-info-'"));
  ok('settings: ...and that reason is no longer a title= on the <span>',
    !/provider-state-muted" title="' \+\s*\n?\s*escapeHtml\(p\.name/.test(s));
  ok('settings: the update button’s "wait for the running ingest" reason is VISIBLE text now',
    s.includes("updBusy ? 'Wait for the running ingest or sync to finish before installing.'") &&
    !s.includes('disabled title="Wait for the running ingest'));
  ok('settings: the unavailable-provider Replace button no longer repeats the <span> beside it',
    !s.includes('disabled title="Not available in this build"'));

  ok('domains: the RO badge’s meaning is in the row button’s accessible name',
    d.includes('<span class="visually-hidden">Read-only Shared Brain mirror</span>') &&
    !d.includes('dm-row-mirror" title='));
  ok('domains: the attention badge — an EMPTY span whose whole content was a tooltip — now names its count',
    /visually-hidden">' \+ issueCount \+ ' open health issue/.test(d) &&
    !d.includes('dm-row-attn" title='));
  ok('domains: the semantic-merge refusal is not a tooltip on a disabled button',
    !d.includes("gate.allowed ? 'Merge this pair' : gate.reason"));
  ok('domains: ...and the visible refusal it duplicated is still there',
    d.includes('Preview required before Merge'));

  ok('shared: the three "another write is running" tooltips are gone',
    !sh.includes("title=\"Another write is already running"));
  ok('shared: ...replaced by ONE visible status box',
    sh.includes('renderStatus({') && sh.includes('Some actions are paused while another write finishes'));
  // FOUND BY MUTATION, NOT BY REVIEW. Deleting `busyNote +` from the render
  // site left this section GREEN: the two assertions above prove the note is
  // BUILT, and nothing proved it is EMITTED. That is the dead-data shape this
  // repo keeps re-learning — a value produced with zero consumers — and it was
  // already guarded one file over for ingest.js's identical note while this
  // one was not. A count of call sites is not adoption; the CALL SITE is.
  ok('shared: and that note is RENDERED, not merely built — a computed-but-unemitted value is dead data',
    /let html = busyNote \+ '<div class="sb-card-actions">';/.test(sh));
  ok('shared: the note is built from BOTH busy conditions, so neither goes silent',
    /if \(pushBusyDomain && !readOnly\) blocked\.push/.test(sh) &&
    /if \(mirrorBusy\) blocked\.push/.test(sh));
  ok('shared: renderStatus is actually imported, not just referenced',
    /import \{ renderViewHeader, renderStatus \} from '\.\.\/shared\/text\.js';/.test(sh));

  ok('ingest: the Ingest button’s blocked reason is no longer a tooltip',
    !ing.includes('btnTitle'));
  ok('ingest: ...it is a visible status box above the button',
    ing.includes('crossBusyNote') && ing.includes('Waiting on another write in this domain'));
  ok('ingest: and that note is rendered, not merely built — a computed-but-unrendered value is dead data',
    /\n\s*crossBusyNote \+\n/.test(ing));

  // ── chat: the per-answer TOKEN BREAKDOWN ────────────────────────────────
  // v3.20.0's list of 11 hover-only strings named this the worst: it is the
  // arithmetic behind a dollar figure, on a spending surface, reachable only
  // by holding a mouse. The behaviour of the control it became is asserted by
  // EXECUTING it in test-next-composer-model.js §11.10; these are the source
  // facts that cannot be reached from there.
  const ch = sourceOf['chat.js'];
  ok('chat: the cost is a real <button type="button">, not a <span> wearing a tooltip',
    /<button type="button" class="chat-msg-cost"/.test(ch) &&
    !/<span class="chat-msg-cost"/.test(ch));
  ok('chat: ...and it is NOT disabled — a disabled button is out of the tab order, which is the defect',
    !/<button type="button" class="chat-msg-cost"[\s\S]{0,400}?\bdisabled\b/.test(ch));
  ok('chat: it inherits the shared delegated listener rather than re-implementing one',
    ch.includes("' data-tx-info=\"' + escapeHtml(panelId) + '\"'") &&
    /from '\.\.\/shared\/text\.js'/.test(ch));
  ok('chat: ...and does NOT install a second keydown/Escape handler of its own for it',
    !/addEventListener\('keydown'[\s\S]{0,400}Escape[\s\S]{0,400}chat-cost/.test(ch));
  ok('chat: the panel id is derived from the message INDEX, so N answers get N distinct panels',
    /const panelId = 'chat-cost-' \+ \(Number\.isInteger\(index\)/.test(ch));
  ok('chat: ...and that index is actually threaded from the thread render, not defaulted away',
    /assistantEyebrowHtml\(m, eyebrowCtx, i\)/.test(ch) &&
    /assistantCostHtml\(m, ctx, index\)/.test(ch));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  NO NEW HOVER-ONLY STRINGS, AND NO REGRESSION OF THE HOUSE RULES');
{
  // A warning must never move BEHIND the mark. v3.16.1: a warning behind a
  // click is not a warning; v3.22.0 split MIRROR_BLURB for exactly this.
  const s = sourceOf['settings.js'];
  const marks = [...s.matchAll(/infoMark\(\s*[^,]+,\s*[^,]+,\s*([\s\S]{0,400}?)\);/g)].map((m) => m[1]);
  ok('every infoMark in settings.js carries neutral explanation, never a cost or a warning',
    marks.length > 0 && marks.every((t) => !/\$|\birreversible\b|\bdelet|\boverwrit|\bwarning\b/i.test(t)));

  // The panel must never be emitted without `hidden`: that restores the exact
  // always-visible paragraph the component exists to remove.
  // These are concatenation templates, so `hidden` lands in a LATER fragment
  // than the class name — the window has to span the concatenation, not stop
  // at the closing quote of the first literal.
  ok('no tx-vh-panel is emitted without `hidden` anywhere in the views',
    viewFiles.every((f) => {
      const src = stripComments(sourceOf[f]);
      let i = -1, okAll = true;
      while ((i = src.indexOf('class="tx-vh-panel"', i + 1)) > -1) {
        if (!src.slice(i, i + 400).includes('hidden')) okAll = false;
      }
      return okAll;
    }));
  ok('CONTROL: that window really inspects something — settings.js does emit a tx-vh-panel',
    stripComments(sourceOf['settings.js']).includes('class="tx-vh-panel"'));

  // The same rule for chat's own cost panel, which owns its box rather than
  // borrowing the header's (shared/text.css owns the `tx-` prefix and a suite
  // enforces it). Same failure if `hidden` is lost: a permanently-open panel,
  // which is the always-visible paragraph the disclosure exists to remove.
  ok('chat: the cost panel is never emitted without `hidden`',
    (() => {
      const src = stripComments(sourceOf['chat.js']);
      let i = -1, all = true;
      while ((i = src.indexOf('class="chat-cost-panel"', i + 1)) > -1) {
        if (!src.slice(i, i + 400).includes('hidden')) all = false;
      }
      return all;
    })());
  ok('CONTROL: that window really inspects something — chat.js does emit a chat-cost-panel',
    stripComments(sourceOf['chat.js']).includes('class="chat-cost-panel"'));

  // A <button> does NOT inherit font from its parent: an unstyled one takes
  // the UA's ~13.33px default and is then FROZEN against Settings > General's
  // text size, because --font-scale multiplies the --text-* ramp and a UA
  // default never reads it. That is the v3.20.0 class you cannot grep for as
  // an ABSENT declaration — so it is grepped for as a PRESENT one, here, at
  // the one site this work turned into a form control.
  const chatCss = readFileSync('src/public/next/views/chat.css', 'utf8');
  const costRule = chatCss.slice(chatCss.indexOf('.chat-msg-cost {'));
  ok('chat.css: the cost button declares `font: inherit`, so it is not frozen at the UA default',
    /^\.chat-msg-cost \{[\s\S]{0,400}?font:\s*inherit;/.test(costRule));
  ok('chat.css: ...and does not suppress the global :focus-visible ring',
    !/^\.chat-msg-cost[\s\S]{0,600}?outline:\s*none/.test(costRule));

  // `.visually-hidden` only helps if the utility exists.
  const shell = readFileSync('src/public/next/shell.css', 'utf8');
  ok('shell.css really defines .visually-hidden (the clip-rect utility domains.js now relies on)',
    /\.visually-hidden\s*\{[\s\S]*?clip:\s*rect/.test(shell));
}

console.log('\n' + '='.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed === 0) console.log('✅ hover-only title= population is bounded and the info mark holds the shared contract');
process.exit(failed === 0 ? 0 : 1);
