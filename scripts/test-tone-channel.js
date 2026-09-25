#!/usr/bin/env node
/**
 * scripts/test-tone-channel.js — TONE IS A MARK, NEVER TEXT (v3.66.0, design rule 7)
 *
 * TONE says how an OUTCOME went — ok · warn · danger · quiet — and it is drawn
 * only as a MARK: a state dot beside a word, a gutter rule on a line or a loud
 * entry, a glyph, a 1px border, or a depth bar's danger fill. The WORDS stay in
 * --text / --text-2. Two reasons, both measured:
 *
 *   1. LEGIBILITY. On the light theme --success-text reads 4.05 / 3.79 / 3.44
 *      and --attention-text 3.58 / 3.35 / 3.04 on --surface / --surface-inset /
 *      --surface-active — under the 4.5:1 text floor everywhere. A word painted
 *      in either is the least legible word on its screen.
 *   2. SEPARATION. ok shares teal with the freshness scale's "recent" and warn
 *      shares amber with "today". They are told apart by POSITION — a
 *      freshness dot sits before an age in words, a tone is a rule or a head
 *      dot before a state word. A tone-coloured WORD has no position; it just
 *      looks like a time.
 *
 * ONE carve-out: a DESTRUCTIVE CONTROL's label (`.btn-danger` and three kin,
 * listed by name below) is an action affordance, not a reading, and passes AA
 * in both themes (5.41 light / 7.80 dark).
 *
 * THE CENSUS. Every `color:` declaration in every /next stylesheet outside
 * tokens/ that names a tone ink is classified:
 *   MARK       its selector targets an svg, a *-glyph, *-dot, *-icon, *-pip or
 *              *-star — a non-text mark, 3:1 floor, allowed;
 *   CARVE-OUT  one of the named destructive controls — allowed;
 *   TEXT       everything else — a violation, BASELINED PER FILE at the count
 *              this release leaves, and the count may only SHRINK.
 * v3.66.0 converts every success and attention TEXT rule in the kit's own files
 * (the progress ring's label, both tones); the rest are listed by file:line in
 * the kit package's report for the view packages that own them. A package
 * that converts one lowers its own file's line in BASELINE below.
 *
 * Plus the renderer's half: the monitor draws a freshness mark OR a tone on a
 * line, never both, and its tone classes set only a dot's background or a
 * rule's border — asserted by executing renderMonitor and by reading the
 * kit's stylesheets with comments stripped.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonitor, TONE_WORDS } from '../src/public/next/shared/monitor.js';
import { ringToneClass } from '../src/public/next/shared/progress-ring.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = path.join(ROOT, 'src/public/next');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + msg); return true; }
  failed++;
  console.log('  \x1b[31m✗\x1b[0m ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 600)));
  return false;
}
const eq = (msg, got, want) => ok(got === want, msg, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
const section = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

/** Comments blanked to spaces, NEWLINES KEPT, so a reported line number is the
 *  file's own — and a rule that exists only inside a comment is not a rule. */
const blankComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

// ── THE CLASSIFIER ─────────────────────────────────────────────────────────
const TONE_COLOR_RE = /(?:^|[;{\s])color\s*:\s*var\(--(success|attention|danger)(-text)?\)/g;
/** A selector's LAST compound targets a non-text mark. */
function isMarkSelector(sel) {
  const last = sel.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() || '';
  const bare = last.replace(/::?[a-z-]+(\([^)]*\))?/gi, '');   // pseudo-classes/elements
  if (/^svg$|^path$|^circle$/i.test(bare)) return true;
  return bare.split('.').filter(Boolean).some((c) => /(^|-)(glyph|dot|icon|pip|star)$/.test(c));
}
/** The destructive-control carve-out, BY NAME. A new one is a decision, made
 *  here in the open, not a pattern that quietly excuses the next button. */
const CARVE_OUTS = new Set([
  '.btn-danger',                   // shell.css — the destructive button family
  '.dm-delete-btn',                // views/domains.css — delete a domain/project
  // '.chat-conv-delete:hover' REMOVED, v3.72.0 (P3, M3): Chat's conversation
  // rows adopted shared/row-action.css's `.row-act` — neutral on hover, red
  // only at the confirm — and the class no longer exists.
  // '.ing-queue-file-remove:hover' REMOVED, v3.72.0 (P5, DESIGN.md §4, M3,
  // the ONE row-action rule): this control's hover no longer colours
  // --danger-text at all — it adopted shared/row-action.css's neutral
  // --mat-row-hover/--text treatment (scripts/test-row-actions.js pins it).
  // There is nothing left here to carve out.
]);
/** Marks whose class name does not say so, BY NAME, each with its evidence. */
const MARKS_BY_NAME = new Set([
  // views/onboarding.js renders it `aria-hidden="true"` and its done state
  // replaces the step number with a check ICON (views/onboarding.css records
  // 8.37 dark / 3.59 light against the 3:1 non-text floor).
  '.obp-mark-done',
]);
function classifyRule(selectorList) {
  const sels = selectorList.split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (sels.length && sels.every((s) => CARVE_OUTS.has(s))) return 'CARVE-OUT';
  if (sels.length && sels.every((s) => isMarkSelector(s) || MARKS_BY_NAME.has(s))) return 'MARK';
  return 'TEXT';
}
/** Every tone-coloured `color:` in a stylesheet, classified, with its line. */
function census(css, rel) {
  const src = blankComments(css);
  const out = [];
  const re = /([^{}]*)\{([^{}]*)\}/g;   // innermost blocks: @media bodies are included, which is right
  let m;
  while ((m = re.exec(src))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@')) continue;
    for (const d of m[2].matchAll(TONE_COLOR_RE)) {
      // The DECLARATION's own line, so a report points at the thing to change.
      const line = src.slice(0, m.index + m[1].length + 1 + d.index + d[0].search(/color/)).split('\n').length;
      out.push({ rel, line, ink: d[1] + (d[2] || ''), family: d[1] === 'danger' ? 'danger' : 'okwarn', sel, kind: classifyRule(sel) });
    }
  }
  return out;
}
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'tokens' ? [] : walk(abs);
    return e.name.endsWith('.css') ? [path.relative(NEXT, abs).split(path.sep).join('/')] : [];
  });
}

// ═════════════════════════════════════════════════════════════════════════
section('§1 — the classifier is watched working before its census is believed');
// ═════════════════════════════════════════════════════════════════════════
eq('an svg inside a note is a MARK', classifyRule('.mem-note svg'), 'MARK');
eq('a *-glyph is a MARK', classifyRule('.check-ok .check-glyph'), 'MARK');
eq('a *-star is a MARK', classifyRule('.chat-mm-star.is-on'), 'MARK');
eq('a *-pip with a state class is a MARK', classifyRule('.sbw-pip.done'), 'MARK');
eq('the NUMBER inside a pip is TEXT', classifyRule('.sbw-pip.done .sbw-pip-num'), 'TEXT');
eq('a headline is TEXT', classifyRule('.sb-outcome-ok .sb-outcome-headline'), 'TEXT');
eq('.btn-danger is the carve-out', classifyRule('.btn-danger'), 'CARVE-OUT');
eq('...but a list mixing it with a label is TEXT', classifyRule('.btn-danger, .some-label'), 'TEXT');
eq('a class merely CONTAINING "dot" mid-name is not a mark', classifyRule('.dotted-note'), 'TEXT');
eq('a named aria-hidden icon is a MARK', classifyRule('.obp-mark-done'), 'MARK');
{
  const stale = [...MARKS_BY_NAME].filter((sel) => !readFileSync(path.join(NEXT, 'views/onboarding.css'), 'utf8').includes(sel + ' {'));
  eq('every mark named by hand still exists (no stale excuse)', stale.join(','), '');
}
{
  const planted = '/* .x { color: var(--success-text); } */\n.a { color: var(--success-text); }\n.b svg { color: var(--danger-text); }\n'
    + '.c { background-color: var(--danger); border-color: var(--success); }\n.d{color:var(--attention)}';
  const c = census(planted, 'planted.css');
  eq('the census reads a planted sheet: two TEXT, one MARK, nothing from a comment or a non-`color` property',
    c.map((x) => x.kind + '@' + x.line).join(','), 'TEXT@2,MARK@3,TEXT@5');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — THE CENSUS: text coloured by tone may only SHRINK, per file');
// ═════════════════════════════════════════════════════════════════════════
/* The baseline this release leaves, per file: `okwarn` counts --success* and
   --attention* TEXT rules (the ones that fail AA on light), `danger` counts
   --danger* TEXT rules (which pass AA and are left for a later sweep). A file
   absent here must have ZERO of either. Lower a number when you convert one;
   never raise one. */
const BASELINE = {
  'shell.css':            { okwarn: 1, danger: 2 },
  'views/chat.css':       { okwarn: 0, danger: 4 },   // v3.66.0 D: the four success/attention TEXT rules converted
  'views/domains.css':    { okwarn: 0, danger: 5 },   // v3.66.0 E: all five success/attention TEXT rules converted
  'views/ingest.css':     { okwarn: 0, danger: 4 },   // v3.66.0 D: .ing-queue-done-fail-reason converted
  'views/mcp-wizard.css': { okwarn: 0, danger: 1 },
  'views/memory.css':     { okwarn: 0, danger: 0 },
  'views/settings.css':   { okwarn: 0, danger: 5 },
  'views/shared.css':     { okwarn: 6, danger: 10 },
};
const files = walk(NEXT);
ok(files.length >= 20 && files.includes('shared/monitor.css') && !files.some((f) => f.startsWith('tokens/')),
  `walked ${files.length} /next stylesheets, tokens/ excluded (the ramp itself is not a use of it)`);
const all = files.flatMap((rel) => census(readFileSync(path.join(NEXT, rel), 'utf8'), rel));
const text = all.filter((x) => x.kind === 'TEXT');
{
  const counts = {};
  for (const x of text) {
    counts[x.rel] = counts[x.rel] || { okwarn: 0, danger: 0 };
    counts[x.rel][x.family]++;
  }
  const grew = [], shrank = [];
  for (const rel of new Set([...Object.keys(counts), ...Object.keys(BASELINE)])) {
    const got = counts[rel] || { okwarn: 0, danger: 0 };
    const base = BASELINE[rel] || { okwarn: 0, danger: 0 };
    for (const fam of ['okwarn', 'danger']) {
      if (got[fam] > base[fam]) {
        grew.push(`${rel} ${fam} ${base[fam]} -> ${got[fam]}: `
          + text.filter((x) => x.rel === rel && x.family === fam).map((x) => `:${x.line} ${x.sel}`).join(' '));
      } else if (got[fam] < base[fam]) shrank.push(`${rel} ${fam} ${base[fam]} -> ${got[fam]}`);
    }
  }
  ok(grew.length === 0, 'NO file colours more text with a tone than its baseline allows', grew.join(' | '));
  if (shrank.length) console.log('    ↓ tighten BASELINE (a conversion landed): ' + shrank.join(' | '));
  const kitFiles = ['shared/monitor.css', 'shared/progress-ring.css', 'shared/depth-bar.css', 'shared/sidebar.css', 'shared/overview.css'];
  const kitText = text.filter((x) => kitFiles.includes(x.rel));
  eq('the KIT colours no text with a tone at all (the progress ring\'s two label rules were converted in v3.66.0)',
    kitText.map((x) => `${x.rel}:${x.line}`).join(','), '');
  const total = (fam) => text.filter((x) => x.family === fam).length;
  console.log(`    census: ${all.length} tone-coloured \`color:\` declarations — ${all.filter((x) => x.kind === 'MARK').length} MARK, `
    + `${all.filter((x) => x.kind === 'CARVE-OUT').length} CARVE-OUT, ${text.length} TEXT (${total('okwarn')} success/attention, ${total('danger')} danger)`);
  for (const x of text.filter((t) => t.family === 'okwarn')) console.log(`      okwarn TEXT  ${x.rel}:${x.line}  ${x.ink}  ${x.sel}`);
}
{
  // Every carve-out is REAL — a stale name in the list would excuse nothing
  // today and something tomorrow.
  const found = new Set(all.filter((x) => x.kind === 'CARVE-OUT').map((x) => x.sel.replace(/\s+/g, ' ')));
  const stale = [...CARVE_OUTS].filter((s) => !found.has(s));
  eq('every named carve-out exists in a stylesheet and names a DANGER ink (no stale excuse)', stale.join(','), '');
  ok(all.filter((x) => x.kind === 'CARVE-OUT').every((x) => x.family === 'danger'),
    '...and the carve-out is for DESTRUCTIVE controls only — no ok/warn label hides behind it');
}
{
  // THE RATCHET BITES: a planted TEXT rule in a baselined file is reported.
  const rel = 'views/memory.css';
  const src = readFileSync(path.join(NEXT, rel), 'utf8') + '\n.planted-note { color: var(--success-text); }\n';
  const n = census(src, rel).filter((x) => x.kind === 'TEXT' && x.family === 'okwarn').length;
  ok(n > BASELINE[rel].okwarn, `CONTROL — a planted success-coloured sentence in ${rel} takes it over its baseline (${n} > ${BASELINE[rel].okwarn})`);
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — THE KIT DRAWS TONE ONLY AS A MARK');
// ═════════════════════════════════════════════════════════════════════════
{
  const mon = blankComments(readFileSync(path.join(NEXT, 'shared/monitor.css'), 'utf8'));
  const toneRules = [...mon.matchAll(/([^{}]*\.cur-mon-(ok|warn|danger|quiet)\b[^{}]*)\{([^}]*)\}/g)];
  ok(toneRules.length >= 11, `monitor.css: ${toneRules.length} tone rules found (head dot × 4, line rule × 3 + quiet, loud rule × 4)`);
  const badMon = toneRules.filter((m) => m[2] !== 'quiet'
    && !/^\s*(background|border-left-color)\s*:\s*var\(--(success|attention|danger)-text\)\s*;?\s*$/.test(m[3]));
  eq('monitor.css: every ok/warn/danger rule sets ONLY a dot\'s background or a rule\'s border-left-color',
    badMon.map((m) => m[1].trim() + ' {' + m[3].trim() + '}').join(' | '), '');
  ok(/\.cur-mon-line\.cur-mon-quiet \.cur-mon-value\s*\{\s*color:\s*var\(--text-2\)/.test(mon),
    '...and `quiet` is a de-emphasis (--text-2 on the value), not a colour');
  const ring = blankComments(readFileSync(path.join(NEXT, 'shared/progress-ring.css'), 'utf8'));
  const ringTone = [...ring.matchAll(/(\.pring-tone-[a-z]+[^{}]*)\{([^}]*)\}/g)];
  ok(ringTone.length === 3 && ringTone.every((m) => /^\s*--pring-color\s*:\s*var\(--[a-z-]+\)\s*;?\s*$/.test(m[2])),
    'progress-ring.css: the three tone rules re-point the STROKE token and nothing else', ringTone.map((m) => m[0]).join(' '));
  const depth = blankComments(readFileSync(path.join(NEXT, 'shared/depth-bar.css'), 'utf8'));
  ok(/\.cur-depth-danger\s*\{\s*background:/.test(depth) && !/\.cur-depth-danger[^{]*\{[^}]*\bcolor\s*:/.test(depth),
    'depth-bar.css: danger is a bar FILL; the figure on it keeps --text');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — THE RENDERER: a tone before a state word or as a rule; a freshness mark before an age; never both');
// ═════════════════════════════════════════════════════════════════════════
{
  eq('the one alphabet', TONE_WORDS.join(','), 'ok,warn,danger,quiet');
  const head = renderMonitor({ head: { stateWord: 'Bridge responds', tone: 'ok' }, lines: [{ key: 'k', value: 1 }] });
  ok(/<span class="cur-mon-state cur-mon-ok"><span class="cur-mon-state-dot" aria-hidden="true"><\/span>Bridge responds<\/span>/.test(head),
    'a head tone is a DOT immediately before its state WORD, and the word is plain text', head);
  const dot = '<span class="fresh-dot fresh-recent" aria-hidden="true"></span>';
  const timed = renderMonitor({ lines: [{ key: 'last save', value: '12 min ago', markHtml: dot }] });
  ok(timed.includes('<span class="cur-mon-value">' + dot + '12 min ago</span>'),
    'a freshness mark sits immediately before the age in words, inside the value', timed);
  const both = renderMonitor({ lines: [{ key: 'last save', value: '12 min ago', markHtml: dot, tone: 'ok' }] });
  ok(!/cur-mon-line cur-mon-ok/.test(both) && both.includes(dot), 'given both, the line keeps the MARK and drops the TONE', both);
  const ruled = renderMonitor({ lines: [{ key: 'read and did not save', value: 2, tone: 'warn' }] });
  ok(/<div class="cur-mon-line cur-mon-warn"><span class="cur-mon-key">read and did not save<\/span>/.test(ruled),
    'a toned line is a RULE on the line (a class), and its key and value carry no tone markup of their own', ruled);
  const loud = renderMonitor({ loud: [{ tone: 'danger', text: 'Self-test failed' }] });
  ok(/<div class="cur-mon-loud cur-mon-danger" role="status">Self-test failed<\/div>/.test(loud),
    'a loud outcome is a rule plus plain words, always rendered', loud);
  eq('the ring speaks the same words for its outcomes (ok, warn)', [ringToneClass('ok'), ringToneClass('warn')].join(','),
    'pring-tone-ok,pring-tone-warn');
}

console.log('\n  ' + '─'.repeat(60));
console.log('  Passed: ' + passed + '   Failed: ' + failed);
if (failed) { console.log('  \x1b[31m❌ tone channel\x1b[0m'); process.exit(1); }
console.log('  \x1b[32m✅ tone is a mark, never text\x1b[0m');
