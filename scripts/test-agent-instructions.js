#!/usr/bin/env node
/**
 * test-agent-instructions.js — OFFLINE suite. No network, no API key, no LLM,
 * no filesystem writes.
 *
 * Guards the v3.52.0 "Copy agent instructions" action end to end:
 *
 *   src/public/next/shared/agent-instructions.js  the ONE text
 *   src/public/next/views/domains.js              the Projects-row action
 *   src/public/next/views/memory.js               the project-header action
 *   docs/working-state.md, docs/user-guide.md,
 *   skills/README.md, README.md                   the measurement, in prose
 *
 * ── WHAT MAKES THIS WORTH HAVING ─────────────────────────────────────────
 *
 * The text is not a design choice, it is an ARTEFACT: this exact block, with
 * its two placeholders, is what was pasted into arm B of a 16-run experiment
 * on 2026-09-10, and the only evidence that any of this works is that those
 * runs used THIS wording. An "improvement" to a word of it silently
 * invalidates the numbers printed three files away, with nothing to notice.
 *
 * So §1 pins the composed output two independent ways — against a
 * hand-written second copy of the block that lives in this file, and against
 * the sha256 of the measured artefact itself — and §5 pins the numbers in the
 * docs. Between them, an edit to the text is RED and an edit to the numbers is
 * RED, and the pair cannot drift apart quietly.
 *
 * Everything here DRIVES REAL CODE. The view functions are lifted out of the
 * live sources by brace-matching and executed (the technique
 * test-next-domain-projects.js and test-next-memory-view.js use); the
 * clipboard is injected and RECORDED, so the assertion is about what the
 * shipped handler asked for. "A test that proves a line exists proves nothing
 * about what it does."
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  · The composed block for (exp, widget) is BYTE-IDENTICAL to the measured
 *    artefact — asserted against a literal AND against its sha256.
 *  · Both placeholders are substituted, at every occurrence, and no `{{…}}`
 *    survives into anything a model will read.
 *  · The helper is pure: same in, same out; no shared mutable state between
 *    calls; an empty domain or project is REFUSED rather than composed around.
 *  · The Domains project row carries BOTH actions, on every row including the
 *    domain's own project and on a read-only domain.
 *  · Clicking either one puts the RIGHT text on the clipboard, through the
 *    shipped listener, and records an outcome the shipped renderer paints.
 *  · A clipboard refusal never loses the text: the marker prints its line, the
 *    agent block prints the block.
 *  · The Agent-memory header carries the action, and its confirmation is
 *    STAMPED — a copy made on one project does not paint under another.
 *  · The four docs carry the measured numbers (0/4, 3/4, 4/4), the exact
 *    block, the five per-harness file names, and the stated limits.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { functionSource } from './test-helpers/source-scan.js';
import {
  composeAgentInstructions, COPY_SUCCESS_BANNER, HEADING, TEMPLATE,
  COPY_SUCCESS_TITLE, COPY_SUCCESS_LINES,
  composeAgentInstructionsFull, TEMPLATE_FOUNDATIONS, TEMPLATE_SEED,
  TEMPLATE_DRAFT_ASK, composeDraftingAsk, TEMPLATE_READ_FIRST,
} from '../src/public/next/shared/agent-instructions.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// v3.67.2: a spy for shared/toast.js's `showToast`, injected into both lifted
// views, so the confirmation a user reads is asserted from the shipped call.
const toasts = [];
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
function section(t) { console.log('\n' + t + '\n' + '─'.repeat(t.length)); }
function ok(msg, cond, extra) {
  if (cond) { passed++; console.log('  ok ' + msg); }
  else { failed++; console.log('  FAIL ' + msg + (extra ? ' -- ' + extra : '')); }
}
function eq(msg, actual, want) {
  ok(msg, actual === want, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(want));
}
function threw(msg, fn) {
  let t = false;
  try { fn(); } catch { t = true; }
  ok(msg, t, 'it did not throw');
}

// ═══════════════════════════════════════════════════════════════════════════
section('S1 -- The text is the measured artefact, byte for byte');
// ═══════════════════════════════════════════════════════════════════════════
//
// A SECOND, HAND-WRITTEN COPY, deliberately. Deriving the expectation from
// TEMPLATE would make this assertion a tautology — it would pass for any text
// at all, including an empty one. This literal was typed from the file that
// was pasted into the experiment's arm-B runs, and it is the reason a
// well-meant rewording is red.
const MEASURED_EXP_WIDGET =
  '## Working state\n' +
  '\n' +
  "This repository's working state lives in The Curator (project `exp/widget`, see\n" +
  '`.curator-project`). At the START of every session call the my-curator MCP tool\n' +
  '`get_project_context` with project "widget" and read the standing brief and latest\n' +
  'handoff before acting. When the user says continue or resume, or you come back after a\n' +
  'pause, call `get_project_context` again before acting — another tool or computer may have\n' +
  'saved since. SAVE with `save_working_state` under project "widget" with the\n' +
  '`scope` argument set to your tool\'s name — "claude-code" if you are Claude Code,\n' +
  '"antigravity" if you are Antigravity, "opencode" if you are opencode, otherwise your\n' +
  'tool\'s own name, lowercase and hyphenated. Pass `scope` explicitly every time, and never\n' +
  'save under another tool\'s scope. Save after every material\n' +
  'decision, at least every ten tool calls, and ALWAYS before you stop; a save overwrites,\n' +
  'so send the complete state each time. Pass `harness` as that same name and `model` as\n' +
  'your exact model id if you know it (omit it otherwise — never search files for it), and\n' +
  'record the `seen` map as `foundations_read`.\n';

// v3.76.0 — the sha256 of paragraph 1 composed for exp/widget, as it stood in
// the CLAUDE.md fed to the 2026-09-25 runs (the file itself held the whole
// four-paragraph composition; its own sha is WHOLE_MEASURED_SHA256 below).
// An INDEPENDENT witness to the same fact: the literal above could itself be
// mistyped in a way that matches a mistyped TEMPLATE, and a hash cannot be.
//
// RECORDED REASON FOR THE RE-PIN (v3.76.0): the 2026-09-10 text (sha
// 85dc8f97…, 501 bytes) told every tool to save under scope "main", which the
// maintainer's live two-tool test of 2026-09-25 showed makes two tools on one
// Mac overwrite each other. The maintainer approved a per-tool-scope text;
// it was re-measured the same day (Claude Code 2.1.281 headless, Haiku 4.5,
// N=8: 7 of 8 runs saved, 2 of those 7 in the tool-named scope; the old text,
// same day, 7 of 8 and 0 of 7) and docs/working-state.md carries the table.
//
// SECOND RECORDED RE-PIN (v3.76.0, same day): the store began choosing the
// tool's own scope when `scope` is omitted and `harness` is given, which made
// the measured draft's "Never leave `scope` out (it defaults to the shared
// "main")" false. It became "Pass `scope` explicitly every time" (995 -> 972
// bytes, sha 42f60960… -> 6582395a…), and the shipped text was re-measured on
// the integrated code: Haiku 4.5 saved 5/8 (3 in claude-code, 2 named main),
// Sonnet 5 saved 8/8 (all in claude-code).
//
// THIRD RECORDED RE-PIN (v3.76.1, 2026-09-26): the maintainer's two-Mac
// test had an already-open conversation told "continue" act on stale context
// after another computer saved. Paragraph 1 gains the re-read sentence
// ("When the user says continue or resume, or you come back after a pause,
// call `get_project_context` again before acting — another tool or computer
// may have saved since."): 972 -> 1141 bytes, sha 6582395a… -> a19c9f24…,
// whole composition a139e04b… -> 9110ec0f…. Measured on a two-turn
// --resume protocol: Sonnet 5 re-read first in turn 2 in 0/8 runs with the
// v3.76.0 text and 8/8 with this one; Haiku 4.5 (N=4) 3/4 vs 2/4.
const MEASURED_SHA256 =
  'a19c9f244b48f7ad51cfb26d424a6df548a61fb29744d30583600367c3e622cd';

{
  const out = composeAgentInstructions({ domain: 'exp', project: 'widget' });
  eq('the composed block IS the artefact that was measured', out, MEASURED_EXP_WIDGET);
  eq('...and hashes to the measured file\'s sha256',
    createHash('sha256').update(out, 'utf8').digest('hex'), MEASURED_SHA256);
  eq('...1141 bytes, including the single trailing newline', Buffer.byteLength(out, 'utf8'), 1141);
  // The WHOLE Copy output for exp/widget -- the exact CLAUDE.md the
  // 2026-09-25 runs read. Pinned so that a change to ANY of the four
  // paragraphs is visibly a change to the measured artefact.
  const WHOLE_MEASURED_SHA256 =
    '9110ec0fc0d162445829992e304e9e2b04b377264cc76d3ad57b64faac5d5a81';
  eq('...and the whole four-paragraph Copy output is the file the 2026-09-25 runs read',
    createHash('sha256').update(composeAgentInstructionsFull({ domain: 'exp', project: 'widget' }), 'utf8')
      .digest('hex'), WHOLE_MEASURED_SHA256);

  // Self-test: the two witnesses above are not the same measurement wearing
  // two hats. A one-character change must fail BOTH.
  const nudged = out.replace('ALWAYS', 'always');
  ok('CONTROL -- a one-word change fails the literal', nudged !== MEASURED_EXP_WIDGET);
  ok('CONTROL -- ...and the hash',
    createHash('sha256').update(nudged, 'utf8').digest('hex') !== MEASURED_SHA256);

  // The load-bearing phrases, named individually, so a diff that survives a
  // careless "restore the snapshot" still says which promise was dropped.
  for (const phrase of [
    'At the START of every session',
    'get_project_context',
    'save_working_state',
    'read the standing brief and latest\nhandoff',
    '`scope` argument set to your tool\'s name',
    '"claude-code" if you are Claude Code',
    '"antigravity" if you are Antigravity',
    '"opencode" if you are opencode',
    'lowercase and hyphenated',
    'Pass `scope` explicitly every time',
    'When the user says continue or resume, or you come back after a\npause, call `get_project_context` again before acting',
    'another tool or computer may have\nsaved since',
    'never\nsave under another tool\'s scope',
    'Pass `harness` as that same name',
    'never search files for it',
    'record the `seen` map as `foundations_read`',
    'ALWAYS before you stop',
    'a save overwrites',
    '`.curator-project`',
    'my-curator MCP tool',
  ]) {
    ok('the tested wording survives: ' + JSON.stringify(phrase), out.includes(phrase));
  }

  // v3.76.0 -- the instruction the re-measure REPLACED must be gone, not
  // merely outnumbered: a block that says both "a scope named for your tool"
  // and 'scope "main"' is two instructions, and the one-tool default wins.
  ok('the retired shared-scope instruction is gone (no scope "main" to save under)',
    !/scope\s+"main"/.test(out));
  ok('...and paragraph 1 no longer names get_working_state at all', !out.includes('get_working_state'));
  const full = composeAgentInstructionsFull({ domain: 'exp', project: 'widget' });
  ok('...nor does ANY paragraph of the Copy output (the old "instead of get_working_state" is gone)',
    !full.includes('get_working_state'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('S2 -- Substitution, purity, and the refusal');
// ═══════════════════════════════════════════════════════════════════════════

{
  const out = composeAgentInstructions({ domain: 'acme', project: 'lumina' });
  ok('the domain/project pair is substituted', out.includes('project `acme/lumina`'));
  eq('...and the project slug replaces BOTH of its occurrences',
    (out.match(/project "lumina"/g) || []).length, 2);
  ok('no placeholder survives into a model-read text', !/\{\{|\}\}/.test(out));
  ok('the leading heading line is there', out.startsWith(HEADING + '\n\n'));
  eq('the heading is exactly the one the docs tell people to look for', HEADING, '## Working state');

  // A name that would break a naive replace: it CONTAINS the other
  // placeholder's replacement text.
  const tricky = composeAgentInstructions({ domain: 'widget', project: 'widget-2' });
  ok('a project name overlapping the domain substitutes cleanly',
    tricky.includes('project `widget/widget-2`') && tricky.includes('project "widget-2"'));
  ok('...and does not leave a half-substituted `widget/widget`',
    !tricky.includes('`widget/widget`'));

  // PURITY. Three calls, no shared state, no clock, no I/O.
  const a1 = composeAgentInstructions({ domain: 'd', project: 'p' });
  composeAgentInstructions({ domain: 'other', project: 'other' });
  const a2 = composeAgentInstructions({ domain: 'd', project: 'p' });
  eq('same arguments in, byte-identical string out', a1, a2);
  ok('...and an intervening call for another project changed nothing', a1 === a2);
  ok('TEMPLATE is not mutated by composing from it', TEMPLATE.includes('{{DOMAIN_PROJECT}}'));
  ok('...at both project placeholders too',
    (TEMPLATE.match(/\{\{PROJECT\}\}/g) || []).length === 2);

  // THE REFUSAL. A block naming project "" is an instruction to save into a
  // project that cannot exist -- reported by the store as a refusal, several
  // turns and one lost handoff later.
  threw('an empty project is refused, not composed around',
    () => composeAgentInstructions({ domain: 'd', project: '' }));
  threw('an empty domain is refused too', () => composeAgentInstructions({ domain: '', project: 'p' }));
  threw('a missing project is refused', () => composeAgentInstructions({ domain: 'd' }));
  threw('no arguments at all is refused', () => composeAgentInstructions());
  // FOUND BY THIS ASSERTION, and worth keeping named: the first draft coerced
  // with String() before checking, and String(undefined) is the truthy string
  // "undefined" -- so a no-argument call composed a block instructing an agent
  // to save under project "undefined".
  threw('...as is a non-object argument', () => composeAgentInstructions('acme/lumina'));
  threw('...and a numeric project, which is not a slug', () => composeAgentInstructions({ domain: 'd', project: 7 }));

  ok('the success banner names all four entry files',
    ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'Cursor'].every((f) => COPY_SUCCESS_BANNER.includes(f)),
    COPY_SUCCESS_BANNER);
  // v3.67.2 — the maintainer asked for WHERE in the file (the very top) and
  // WHICH file for WHICH harness, as a title and at most two short lines.
  eq('...and is the exact wording the release specifies (title)', COPY_SUCCESS_TITLE,
    'Agent instructions copied');
  eq('...(line 1: where in the file)', COPY_SUCCESS_LINES[0],
    'Paste it at the very top of the file your agent loads every session, so it is read first and no size cap cuts it off.');
  eq('...(line 2: which file for which harness)', COPY_SUCCESS_LINES[1],
    'CLAUDE.md for Claude Code · AGENTS.md for Codex and others · GEMINI.md for Gemini CLI · a rule file in .cursor/rules for Cursor.');
  ok('...and it is a title plus AT MOST two lines', COPY_SUCCESS_LINES.length <= 2);
  eq('COPY_SUCCESS_BANNER is the two lines joined, for every reader of the one-string form',
    COPY_SUCCESS_BANNER, COPY_SUCCESS_LINES.join(' '));
  // CROSS-CHECK against the docs table the harness names come from: every
  // harness the toast pairs with a file is paired with that SAME file in
  // docs/working-state.md's "Where it goes" table — a dumb second copy of the
  // fact, so a rename in one place cannot quietly make the toast false.
  {
    const WS_TABLE = read('docs/working-state.md');
    for (const [harness, file] of [['Claude Code', 'CLAUDE.md'], ['Codex', 'AGENTS.md'],
      ['Gemini CLI', 'GEMINI.md'], ['Cursor', '.cursor/rules']]) {
      ok('the docs table pairs ' + harness + ' with ' + file + ', as the toast does',
        new RegExp('\\| ' + harness + ' \\| `' + file.replace(/[.]/g, '\\.') + '`').test(WS_TABLE)
        && COPY_SUCCESS_LINES[1].includes(file + ' for ' + harness));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('S3 -- Domains -> Projects: the row, the click, the refusal');
// ═══════════════════════════════════════════════════════════════════════════

const DOMAINS_SRC = read('src/public/next/views/domains.js');
const { explainerMark, explainerHtml } = await import('../src/public/next/shared/explainer.js');
const { EXPLAINERS } = await import('../src/public/next/shared/explainers.js');

const DOM_FNS = [
  // v3.58.0: the row's two copy controls each carry an ⓘ at an id from
  // projInfoId. v3.71.1: the mark is the shared explainer kit's
  // `explainerMark` (injected REAL below — a stub would let the row render its
  // buttons with no explanation beside them and still pass).
  'projInfoId',
  'renderProjectRow', 'renderCopyOutcome',
  'copyProjectMarker', 'copyProjectAgentInstructions', 'copyForProject',
  'bindProjectListeners',
];

const domBox = (() => {
  const PREAMBLE = `
let state = {};
let myMountToken = 1;
let mounted = true;
let clipboardOk = true;
const calls = { render: 0, clipboard: [], asyncFailures: 0 };
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function icon() { return ''; }
function render() { calls.render++; }
function isCurrentMount() { return mounted; }
function reportAsyncActionFailure() { calls.asyncFailures++; }
function renderBadge(o) { return '<span class="tx-badge">' + escapeHtml(o.label) + '</span>'; }
function renderStatus(o) {
  return '<div class="tx-status tx-status-' + o.state + '"><b>' + escapeHtml(o.title) +
    '</b><i>' + escapeHtml(o.detail || '') + '</i></div>';
}
function relTime(iso) { return 'REL(' + iso + ')'; }
let document = { getElementById: () => null, querySelectorAll: () => [] };
const navigator = { clipboard: { writeText: async (t) => {
  if (!clipboardOk) throw new Error('denied');
  calls.clipboard.push(t);
} } };
`;
  return new Function(
    'composeAgentInstructions', 'composeAgentInstructionsFull', 'COPY_SUCCESS_BANNER',
    'COPY_SUCCESS_TITLE', 'COPY_SUCCESS_LINES', 'showToast', 'explainerMark',
    PREAMBLE +
    DOM_FNS.map((n) => {
      const src = functionSource(DOMAINS_SRC, n);
      if (!src) throw new Error('could not lift ' + n + ' from domains.js');
      return src;
    }).join('\n\n') + '\n' +
    `return { ${DOM_FNS.join(', ')},
       __state: () => state, __setState: (s) => { state = s; },
       __calls: () => calls,
       __reset: () => { calls.render = 0; calls.clipboard.length = 0; calls.asyncFailures = 0; },
       __setDocument: (d) => { document = d; },
       __setClipboard: (v) => { clipboardOk = v; },
       __setMounted: (v) => { mounted = v; } };`
  )(composeAgentInstructions, composeAgentInstructionsFull, COPY_SUCCESS_BANNER,
    COPY_SUCCESS_TITLE, COPY_SUCCESS_LINES, (o) => { toasts.push(o); return o && o.key; },
    explainerMark);
})();

const ROW = (over) => ({
  domain: 'alpha', project: 'lumina', isDefaultProject: false, hasBrief: true,
  lastWriteAt: '2026-09-06T12:00:00.000Z', writtenAt: '2026-09-06T12:00:00.000Z',
  newestScope: 'main', ...over,
});
const domState = (over) => ({ activeSlug: 'alpha', copied: null, ...over });

{
  const html = domBox.renderProjectRow(ROW(), true);
  ok('the row carries the marker action', html.includes('data-proj-marker="lumina"'));
  ok('...AND the agent-instructions action', html.includes('data-proj-agent="lumina"'));
  ok('...labelled in the words the docs use', html.includes('Copy agent instructions'));
  // v3.71.1: the two ⓘ beside the copy controls are the shared explainers.
  // The harness FILE NAMES left them (they are in COPY_SUCCESS_BANNER, S2,
  // and the user guide); the marker file name stays, in the steps.
  ok('...the instructions control’s ⓘ IS the domains.agent-instructions explainer',
    html.includes('aria-label="' + EXPLAINERS['domains.agent-instructions'].label + '" hidden>'
      + explainerHtml('domains.agent-instructions') + '</div>'));
  ok('...and the marker control’s ⓘ IS the domains.marker-line explainer',
    html.includes('aria-label="' + EXPLAINERS['domains.marker-line'].label + '" hidden>'
      + explainerHtml('domains.marker-line') + '</div>'));
  ok('...whose steps name the `.curator-project` file the block points an agent at',
    EXPLAINERS['domains.marker-line'].visual.steps.some((t) => t.includes('`.curator-project`'))
    && TEMPLATE.includes('`.curator-project`'));

  // NOT gated. Neither action writes anything, and the two rows that lose the
  // write controls are exactly the two people are most likely to be resuming.
  const own = domBox.renderProjectRow(ROW({ isDefaultProject: true, project: 'alpha' }), true);
  ok('the domain\'s OWN project gets it too', own.includes('data-proj-agent="alpha"'));
  ok('CONTROL -- ...while still getting no Rename', !own.includes('data-proj-rename'));
  const ro = domBox.renderProjectRow(ROW(), false);
  ok('a read-only domain\'s row gets it too', ro.includes('data-proj-agent="lumina"'));
  ok('CONTROL -- ...while still getting no Delete', !ro.includes('data-proj-delete'));

  const hostile = domBox.renderProjectRow(ROW({ project: '"><img onerror=x>' }), true);
  ok('the project name is escaped into the attribute',
    !hostile.includes('<img onerror') && hostile.includes('&quot;&gt;&lt;img'));
}

// THE CLICK. The shipped listener, the shipped handler, an injected clipboard.
function fakeDoc(nodes) {
  return {
    getElementById: () => null,
    querySelectorAll: (sel) => {
      const key = sel.replace(/[[\]]/g, '');
      return (nodes[key] || []);
    },
  };
}
function btn(datasetKey, value) {
  const listeners = [];
  return {
    dataset: { [datasetKey]: value },
    addEventListener: (_ev, fn) => listeners.push(fn),
    click: () => listeners.forEach((fn) => fn()),
  };
}

{
  domBox.__setState(domState());
  domBox.__reset();
  domBox.__setClipboard(true);
  const agentBtn = btn('projAgent', 'lumina');
  const markerBtn = btn('projMarker', 'lumina');
  domBox.__setDocument(fakeDoc({ 'data-proj-agent': [agentBtn], 'data-proj-marker': [markerBtn] }));
  domBox.bindProjectListeners();

  agentBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  eq('clicking it puts EXACTLY the helper\'s FULL text on the clipboard',
    domBox.__calls().clipboard[0],
    composeAgentInstructionsFull({ domain: 'alpha', project: 'lumina' }));
  // v3.59.0: the pinned block must still be what a user pastes FIRST -- the
  // foundations paragraph is an addendum, never a replacement.
  ok('...starting with the pinned block, byte for byte',
    domBox.__calls().clipboard[0].startsWith(
      composeAgentInstructions({ domain: 'alpha', project: 'lumina' })));
  ok('...and carrying the foundations paragraph too',
    domBox.__calls().clipboard[0].includes(TEMPLATE_FOUNDATIONS));
  // v3.67.2: a success is a TOAST that goes away on its own; nothing is
  // recorded for the page to keep painting.
  eq('...a success records NO in-flow outcome', domBox.__state().copied, null);
  ok('...and the view repainted', domBox.__calls().render >= 1);
  const t = toasts[toasts.length - 1] || {};
  eq('the confirmation toast says the instructions were copied', t.title, 'Agent instructions copied');
  ok('...and names where to paste them — the TOP of the file, and which file',
    /very top/.test((t.lines || []).join(' '))
    && (t.lines || []).join(' ').includes('CLAUDE.md') && (t.lines || []).join(' ').includes('AGENTS.md'),
    JSON.stringify(t));
  eq('...and the page paints nothing permanent for it', domBox.renderCopyOutcome(), '');

  // The marker action still works, unchanged, through the SAME shared body.
  markerBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  eq('the marker action still copies exactly domain/project',
    domBox.__calls().clipboard[1], 'alpha/lumina');
  eq('...with its own confirmation toast', (toasts[toasts.length - 1] || {}).title, 'Marker line copied');
}

{
  // A REFUSED CLIPBOARD MUST NOT LOSE THE TEXT. The block is a paragraph, so
  // it gets a selectable mono block rather than being crammed into a sentence.
  domBox.__setState(domState());
  domBox.__reset();
  domBox.__setClipboard(false);
  await domBox.copyProjectAgentInstructions('lumina');
  eq('a refusal is recorded as a failure', domBox.__state().copied.ok, false);
  eq('...and keeps the whole FULL block', domBox.__state().copied.text,
    composeAgentInstructionsFull({ domain: 'alpha', project: 'lumina' }));
  ok('...still starting with the pinned block, byte for byte',
    domBox.__state().copied.text.startsWith(
      composeAgentInstructions({ domain: 'alpha', project: 'lumina' })));
  const painted = domBox.renderCopyOutcome();
  ok('...which is printed for the user to select', painted.includes('dm-proj-copy-fallback'));
  ok('...containing the real text', painted.includes('save_working_state'));
  ok('...and says why the button appeared to do nothing',
    painted.includes('refused clipboard access'));
  domBox.__setClipboard(true);
}

{
  // A DOMAIN SWITCH MID-COPY. Nothing may be written after the mount changed.
  domBox.__setState(domState());
  domBox.__reset();
  domBox.__setMounted(false);
  await domBox.copyProjectAgentInstructions('lumina');
  eq('a copy that lands after the mount changed records nothing',
    domBox.__state().copied, null);
  eq('...and does not repaint', domBox.__calls().render, 0);
  domBox.__setMounted(true);
}

// ═══════════════════════════════════════════════════════════════════════════
section('S4 -- Agent memory: the project header');
// ═══════════════════════════════════════════════════════════════════════════

const MEMORY_SRC = read('src/public/next/views/memory.js');

// `renderMain` JOINS THE LIFT LIST, DELIBERATELY. The button moved out of
// `renderProject`'s breadcrumb row — where a `margin-left: auto` floated it
// alone at the far right of the page — into renderViewHeader's `actionsHtml`
// slot, which renderMain owns. A suite that went on lifting renderProject alone
// would have gone GREEN-BY-ABSENCE: the assertions below would simply stop
// finding the button and would have to be deleted, which is the one outcome
// this file exists to prevent. So the lift follows the control.
//
// renderMain is DOM-bound (it ends in setMain), so the preamble stubs setMain
// and captures what it was handed; everything the header needs — the component
// itself and the About panel's HTML — is stubbed with named markers so an
// assertion cannot pass over a page that rendered nothing.
const MEM_FNS = ['renderCopyOutcome', 'renderProject', 'renderMain', 'copyAgentInstructions', 'wire'];

const memBox = (() => {
  // The sub-renderers below `renderProject`'s header are stubbed with NAMED
  // markers rather than empty strings, so the assertions that the header is
  // present are not silently passing over a page that rendered nothing else.
  const PREAMBLE = `
let state = {};
let mounted = true;
let clipboardOk = true;
const calls = { render: 0, clipboard: [], failures: 0 };
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function icon() { return '<svg></svg>'; }
function render() { calls.render++; }
function isCurrentMount() { return mounted; }
function reportAsyncMountFailure() { calls.failures++; }
function renderStatus(o) {
  return '<div class="tx-status tx-status-' + o.state + '"><b>' + escapeHtml(o.title) +
    '</b><i>' + escapeHtml(o.detail || '') + '</i></div>';
}
const loadGate = null;
function gatedLoader() { return '<!--LOADER-->'; }
function unlistedCount() { return 0; }
function renderUnlistedNote() { return '<!--UNLISTED-->'; }
function renderSaveStatus() { return '<!--SAVESTATUS-->'; }
function renderStaleNotice() { return '<!--STALE-->'; }
function renderEmptyProject() { return '<!--EMPTY-->'; }
// v3.71.0: the header's ⓘ body is the explainer kit's (key context.page), and
// memStep marks through explainerMark. Stubbed with a marker that CARRIES the
// key, so the control below proves the header was handed THAT explainer.
function explainerHtml(k) { return '<!--XP:' + k + '-->'; }
function explainerMark(id, k) { return { btn: '<!--XPBTN:' + k + '-->', panel: '<!--XP:' + k + '-->' }; }
function explainerLabel(k) { return 'About ' + k; }
function renderNoProjects() { return '<!--NOPROJECTS-->'; }
// The REAL component's contract, reduced to what these assertions read: the
// actions slot and the info panel. Faithful on the one property that matters
// here: actionsHtml is emitted verbatim, so a header that dropped the slot
// would red rather than quietly pass. (No backticks in this block -- the whole
// PREAMBLE is a template literal, and one would end it.)
function renderViewHeader(o) {
  return '<header class="tx-vh"><h1>' + escapeHtml(o.title || '') + '</h1>' +
    (o.actionsHtml ? '<div class="tx-vh-actions">' + o.actionsHtml + '</div>' : '') +
    (o.info ? '<div class="tx-vh-panel" hidden>' + (o.infoHtml ? o.info : escapeHtml(o.info)) + '</div>' : '') +
    '</header>';
}
let mainHtml = '';
function setMain(html) { mainHtml = html; }
function renderBriefOnlyNotice() { return '<!--BRIEFONLY-->'; }
// v3.55.0: the two pickers are gone and the page is five shared blocks.
// renderWorkStreams + workStreamCounts replaced renderScopeControls, and
// renderProject now composes through shared/block.js's renderBlock -- stubbed
// here to a marker that CARRIES its id and its body, so an assertion can still
// tell which block a fragment landed in and a dropped body would red rather
// than quietly pass.
function renderWorkStreams() { return '<!--SCOPES-->'; }
function workStreamCounts() { return '<!--WSCOUNT-->'; }
function renderBlock(o) {
  return '<section data-block="' + escapeHtml(o.id) + '"><h2>' + escapeHtml(o.title) + '</h2>' +
    (o.ledeHtml ? '<p>' + o.ledeHtml + '</p>' : '') +
    '<div>' + (o.bodyHtml || '') + '</div></section>';
}
// v3.65.0 (the Settings + Sync package's kit, adopted here): renderProject's
// five blocks compose through memory.js's OWN memStep now, not shared/
// block.js's renderBlock -- renderBlock above is unused by the lifted body
// and stays only because nothing asked to delete it. memStep is stubbed the
// same way -- a marker that CARRIES its id and its body, so an assertion can
// still tell which block a fragment landed in and a dropped body would red
// rather than quietly pass. bindKnowledgeRows (the knowledge-row wiring wire()
// reaches for) is not exercised here, but a lifted function throws on a free
// identifier, so it is stubbed too: an undefined collaborator is a crash, not
// a failing assertion.
function memStep(o) { return '<section data-block="' + o.id + '"><h2>' + o.title + '</h2><div>' + (o.bodyHtml || '') + '</div></section>'; }
function bindKnowledgeRows() {}
// v3.56.0: renderHandoff is gone. The handoff is no longer printed on the
// page -- a work-stream row press opens it in the shell's reader -- so what
// replaced it is handoffReaderContent (a PAYLOAD, not markup) plus the wiring
// functions wire() reaches for. None is exercised here, but wire IS lifted and
// would throw on a free identifier, so each is stubbed: an undefined
// collaborator is a crash, not a failing assertion. (No backticks in this
// block -- the whole PREAMBLE is a template literal, and one would end it.)
function handoffReaderContent() { return null; }
function bindWorkStreamRows() {}
function showMoreWorkStreams() {}
function openWorkStream() {}
function wsShownCount() { return 0; }
function workStreamOrder(x) { return x || []; }
const WS_WINDOW = 5;
function renderJournal() { return '<!--JOURNAL-->'; }
function renderBrief() { return '<!--BRIEF-->'; }
// v3.59.0: tier 0. renderProject composes a fifth block from renderFoundations
// and adds one line to block 1 from renderFoundationsStatus; wire() binds the
// row handler and the Refresh control. None is exercised here, but BOTH lifted
// functions would throw on a free identifier, so each is stubbed with a named
// marker -- an undefined collaborator is a crash, not a failing assertion.
function renderFoundations() { return '<!--FOUNDATIONS-->'; }
function bindFoundationRows() {}
function refreshFoundations() {}
// v3.62.0: the page became three numbered STEPS. renderProject composes the
// three-cell strip, step (1)'s never-fold notices, the work-stream fold, step
// (3) and its read; wire() binds two doors and the sidebar's pointer. None is
// exercised here, but both lifted functions would throw on a free identifier,
// so each is stubbed with a named marker -- an undefined collaborator is a
// crash, not a failing assertion. renderFoundationsStatus went with the Status
// block it was the one line of. (No backticks in this block -- the whole
// PREAMBLE is a template literal, and one would end it.)
function foundationsFacts() { return { count: 0, present: false }; }
function foundationsNotices() { return '<!--FNDNOTES-->'; }
function renderLayerStrip() { return '<!--STRIP-->'; }
function renderWorkStreamsFold() { return '<!--WSFOLD-->'; }
function renderKnowledge() { return '<!--KNOWLEDGE-->'; }
function loadKnowledge() { return Promise.resolve(); }
// v3.63.0: the honesty meter. renderProject composes it into step (2) and
// selectProject asks for its reading. Neither is exercised here, but both
// lifted functions would throw on a free identifier, so each is stubbed with
// a named marker -- an undefined collaborator is a crash, not a failing
// assertion. (No backticks in this block -- the whole PREAMBLE is a template
// literal, and one would end it.)
function renderCaptureMeter() { return '<!--CAPTURE-->'; }
function loadCapture() { return Promise.resolve(); }
// v3.67.0: renderProject composes step 4 (Session start) and wire() hands the
// fold binder and the release's own controls to two named binders. None is
// exercised here, but a lifted function throws on a free identifier, so each
// is stubbed -- an undefined collaborator is a crash, not a failing assertion.
function renderSessionStart() { return '<!--SESSIONSTART-->'; }
// v3.77.0 — step 5 "Setup" (its own suite: test-next-setup-step.js).
function renderSetupStep() { return '<!--SETUP-->'; }
function bindFoldToggles() {}
function bindSessionAndPlan() {}
function bindSetup() {}
function requestDomain() {}
function goToChatScoped() {}
function navigate() {}
const LEDE_CANONICAL = 'L1';
const LEDE_STATE = 'L2';
const LEDE_KNOWLEDGE = 'L3';
function keyOf(d, p) { return d + '/' + p; }
function activeKey() { return keyOf(state.activeDomain, state.activeProject); }
function selectProject() {}
function saveBrief() {}
function refreshIndex() {}
function reloadActive() {}
function loadScope() {}
function briefDismissDecision() { return 'close'; }
function docsLinkHtml() { return '<a>guide</a>'; }
const JOURNAL_PAGE = 5;
const JOURNAL_MORE = 50;
let document = { getElementById: () => null, querySelectorAll: () => [] };
const navigator = { clipboard: { writeText: async (t) => {
  if (!clipboardOk) throw new Error('denied');
  calls.clipboard.push(t);
} } };
`;
  return new Function(
    'composeAgentInstructions', 'composeAgentInstructionsFull', 'COPY_SUCCESS_BANNER',
    'COPY_SUCCESS_TITLE', 'COPY_SUCCESS_LINES', 'showToast',
    PREAMBLE +
    MEM_FNS.map((n) => {
      const src = functionSource(MEMORY_SRC, n);
      if (!src) throw new Error('could not lift ' + n + ' from memory.js');
      return src;
    }).join('\n\n') + '\n' +
    `return { ${MEM_FNS.join(', ')},
       __state: () => state, __setState: (s) => { state = s; },
       __calls: () => calls,
       __reset: () => { calls.render = 0; calls.clipboard.length = 0; calls.failures = 0; },
       __setDocument: (d) => { document = d; },
       __main: () => mainHtml,
       __setClipboard: (v) => { clipboardOk = v; },
       __setMounted: (v) => { mounted = v; } };`
  )(composeAgentInstructions, composeAgentInstructionsFull, COPY_SUCCESS_BANNER,
    COPY_SUCCESS_TITLE, COPY_SUCCESS_LINES, (o) => { toasts.push(o); return o && o.key; });
})();

const memState = (over) => ({
  activeDomain: 'acme', activeProject: 'lumina',
  projectRead: { scopes: [], brief: { present: false } },
  detail: null, detailError: null, detailLoading: false,
  copied: null, ...over,
});

{
  // THE WHOLE PANE, not just renderProject: the control lives in the view
  // header now, so the only output that can prove it reaches the user is the
  // one setMain is handed.
  memBox.__setState(memState());
  memBox.renderMain(1);
  const html = memBox.__main();
  ok('the header carries the action', html.includes('id="mem-copy-agent"'));
  ok('...labelled in the words the docs use', html.includes('Copy agent instructions'));
  ok('...in the header\'s sanctioned ACTION slot, not floating in the breadcrumb row',
    /tx-vh-actions[\s\S]{0,160}id="mem-copy-agent"/.test(html), html.slice(0, 400));
  // `<!--EMPTY-->` was `renderEmptyProject`, which renderProject called
  // directly until v3.62.0; it is inside `renderWorkStreamsFold` now (step
  // (2)'s first fold), so the marker that proves the body rendered is the
  // fold's. Same property, one level in.
  ok('CONTROL -- the rest of the page really did render, so the check is not vacuous',
    html.includes('<!--WSFOLD-->') && html.includes('<!--XP:context.page-->'));
  ok('CONTROL -- and the breadcrumb row itself no longer carries it',
    !memBox.renderProject().includes('id="mem-copy-agent"'));

  const ro = (() => {
    memBox.__setState(memState({ detail: { readonly: true } }));
    memBox.renderMain(1);
    return memBox.__main();
  })();
  ok('a read-only Shared Brain mirror gets it too -- nothing here writes',
    ro.includes('id="mem-copy-agent"'));
  ok('CONTROL -- ...and still says it is a mirror', ro.includes('shared mirror'));

  // NO PROJECT, NO BUTTON. composeAgentInstructions needs the pair, and a
  // button whose only outcome is a refusal is worse than no button -- the same
  // rule the brief editor follows on a read-only mirror.
  memBox.__setState(memState({ activeProject: null, activeDomain: null }));
  memBox.renderMain(1);
  ok('with no project selected the action is withheld rather than offered dead',
    !memBox.__main().includes('id="mem-copy-agent"'), memBox.__main().slice(0, 300));
}

{
  // THE CLICK, through the shipped `wire()` and the shipped handler.
  memBox.__setState(memState());
  memBox.__reset();
  memBox.__setClipboard(true);
  const b = (() => {
    const listeners = [];
    return { addEventListener: (_e, fn) => listeners.push(fn), click: () => listeners.forEach((f) => f()) };
  })();
  memBox.__setDocument({
    getElementById: (id) => (id === 'mem-copy-agent' ? b : null),
    querySelectorAll: () => [],
  });
  memBox.wire(1);
  b.click();
  await new Promise((r) => setTimeout(r, 0));
  eq('clicking it copies the helper\'s FULL text for the project on screen',
    memBox.__calls().clipboard[0],
    composeAgentInstructionsFull({ domain: 'acme', project: 'lumina' }));
  ok('...starting with the pinned block, byte for byte',
    memBox.__calls().clipboard[0].startsWith(
      composeAgentInstructions({ domain: 'acme', project: 'lumina' })));
  ok('...and carrying the foundations paragraph too',
    memBox.__calls().clipboard[0].includes(TEMPLATE_FOUNDATIONS));
  // v3.67.2: the success is the shared toast, under the SAME key the Domains
  // view uses — so a repeat press anywhere re-shows one toast, not two.
  eq('...and records NO in-flow outcome', memBox.__state().copied, null);
  ok('...and the view repainted', memBox.__calls().render >= 1);
  const t = toasts[toasts.length - 1] || {};
  eq('the confirmation is a toast titled as before', t.title, 'Agent instructions copied');
  eq('...under the shared key', t.key, 'copy-agent-instructions');
  ok('...saying WHERE: the very top of the file', /very top/.test((t.lines || [])[0] || ''), JSON.stringify(t));
}

{
  // THE STAMP EARNS ITS KEEP. This view switches project WITHOUT unmounting,
  // so a mount check alone would let one project's confirmation paint under
  // another project's header.
  memBox.__setState(memState({
    copied: { domain: 'acme', project: 'other', ok: true, text: 'x' },
  }));
  eq('a confirmation from ANOTHER project does not paint here',
    memBox.renderCopyOutcome(), '');
  memBox.__setState(memState({
    copied: { domain: 'other', project: 'lumina', ok: true, text: 'x' },
  }));
  eq('...nor one from another domain with the same project name',
    memBox.renderCopyOutcome(), '');
  // v3.67.2: a SUCCESS never paints in flow any more (it is a toast), so the
  // stamp's CONTROL is taken on the one record that still paints — a refusal.
  memBox.__setState(memState({
    copied: { domain: 'acme', project: 'other', ok: false, text: 'x' },
  }));
  eq('a REFUSAL from another project does not paint here either', memBox.renderCopyOutcome(), '');
  memBox.__setState(memState({
    copied: { domain: 'acme', project: 'lumina', ok: false, text: 'x' },
  }));
  ok('CONTROL -- the matching pair DOES paint, so the checks above are not vacuous',
    memBox.renderCopyOutcome().includes('Could not copy'));
  memBox.__setState(memState({
    copied: { domain: 'acme', project: 'lumina', ok: true, text: 'x' },
  }));
  eq('...and an ok record paints NOTHING — no permanent twin of the toast', memBox.renderCopyOutcome(), '');
}

{
  // A refusal here keeps the block too.
  memBox.__setState(memState());
  memBox.__reset();
  memBox.__setClipboard(false);
  const before = toasts.length;
  await memBox.copyAgentInstructions(1);
  eq('a refused copy is recorded as a failure', memBox.__state().copied.ok, false);
  eq('...and raises NO toast: a refusal is not a confirmation, and its text must not vanish',
    toasts.length, before);
  const painted = memBox.renderCopyOutcome();
  ok('...and the block is printed for the user to select',
    painted.includes('mem-copy-fallback') && painted.includes('save_working_state'));
  memBox.__setClipboard(true);
}

// ═══════════════════════════════════════════════════════════════════════════
section('S5 -- The docs carry the MEASUREMENT, not a paraphrase of it');
// ═══════════════════════════════════════════════════════════════════════════
//
// The numbers are the whole reason the wording is frozen, and a doc edit is
// the easiest way to lose them: someone tidying a table, rounding "0/4" to
// "rarely", or dropping a harness. Each is greppable and each is asserted.

const WS = read('docs/working-state.md');
const UG = read('docs/user-guide.md');
const SKR = read('skills/README.md');
const RM = read('README.md');

{
  const anchorTitle = 'Activation: put the discipline where the harness cannot skip it';
  ok('working-state.md has the activation section', WS.includes('### ' + anchorTitle));

  // THE EXACT BLOCK, fenced, byte-identical to what the helper composes. Not
  // "a block that looks like it" -- the doc is where a person copies it from
  // when the app is not in front of them.
  const fenced = '```markdown\n' + composeAgentInstructions({ domain: 'exp', project: 'widget' }) + '```';
  ok('...and reproduces the exact block, byte for byte', WS.includes(fenced));

  // The table. Every cell that carries a number.
  for (const row of [
    '| Claude Code | A — skill only | **0/4** | 0/4 | 0/4 |',
    '| Claude Code | B — skill + block | **3/4** | 3/4 | 3/4 |',
    '| opencode | A — skill only | **4/4** | 4/4 | 3/4 |',
    '| opencode | B — skill + block | **4/4** | 4/4 | 3/4 |',
  ]) {
    ok('the measured table row survives: ' + row, WS.includes(row));
  }
  ok('...and the table names all three counted behaviours',
    WS.includes('Runs that saved ≥1') && WS.includes('Read state at start')
      && WS.includes('Saved before stopping'));

  // The five per-harness file names, each as its own table row, so a dropped
  // harness is red rather than merely absent.
  for (const [host, file] of [
    ['Claude Code', '`CLAUDE.md`'], ['Codex', '`AGENTS.md`'], ['opencode', '`AGENTS.md`'],
    ['Gemini CLI', '`GEMINI.md`'], ['Cursor', '`.cursor/rules`'],
  ]) {
    ok('working-state.md names ' + host + ' -> ' + file, WS.includes('| ' + host + ' | ' + file + ' |'));
  }

  // THE LIMITS. Dropping these turns a shape into a claimed rate, which is
  // the single most likely way this section becomes dishonest.
  for (const limit of [
    'N=4 is a shape, not a rate',
    'licenses a number like "75%"',
    'Headless only',
    'One task, one model (Haiku 4.5), one prompt',
    'skill competition',
    'opencode needs no block',
  ]) {
    ok('the stated limit survives: ' + JSON.stringify(limit), WS.includes(limit), 'missing from working-state.md');
  }
  // v3.76.0 -- the re-measure of the CHANGED block, including the
  // unflattering column. Rounding "2 of 7" up, or dropping the control row,
  // is exactly how a measured caveat quietly becomes a claim.
  for (const row of [
    '| v3.75.0 block (`"main"`) — same-day control | 7 of 8 | **7 of 8** | 7 of 8 | 0 of 7 | 0 of 7 |',
    '| v3.76.0 draft block (per-tool scope, *"Never leave `scope` out"*), store default `main` | 6 of 8 | **7 of 8** | 7 of 8 | **2 of 7** | 7 of 7 |',
  ]) {
    ok('the 2026-09-25 re-measure row survives: ' + row, WS.includes(row));
  }
  ok('...with its date, harness build and model on the record',
    WS.includes('2026-09-25') && WS.includes('CLI 2.1.281') && WS.includes('claude-haiku-4-5-20251001'));
  for (const row of [
    '| `claude-haiku-4-5-20251001` | 5 of 8 | **5 of 8** | 5 of 8 | **3 × `claude-code`** (1 named, 2 by the default), **2 × `main`** (named explicitly) | `claude-code` 5 of 5 | $0.49 |',
    '| `claude-sonnet-5` | 8 of 8 | **8 of 8** | 8 of 8 | **8 × `claude-code`**, all named explicitly | `claude-code` 8 of 8 | $0.98 |',
  ]) {
    ok('the integrated-code re-measure row survives: ' + row, WS.includes(row));
  }
  ok('...labelled with the default scope it ran against', WS.includes('(2026-09-25, with the v3.76.0 default scope)'));
  ok('...and the false "defaults to the shared main" sentence is gone from the fenced block and the text',
    !WS.includes('Never leave `scope` out (it defaults to the\n') && !TEMPLATE.includes('defaults to the'));
  // v3.76.1 -- the two-turn re-read campaign, control row included.
  for (const row of [
    '| `claude-sonnet-5` | v3.76.0 block (control) | 8 of 8 | **0 of 8** | 0 of 8 | 0 of 8 | $2.14 |',
    '| `claude-sonnet-5` | **v3.76.1 block (re-read sentence)** | 8 of 8 | **8 of 8** | 8 of 8 | 4 of 8 | $2.32 |',
    '| `claude-haiku-4-5-20251001` | v3.76.0 block (control) | 3 of 4 | **3 of 4** | 2 of 4 | 0 of 4 | $0.74 |',
    '| `claude-haiku-4-5-20251001` | **v3.76.1 block (re-read sentence)** | 1 of 4 | **2 of 4** | 2 of 4 | 0 of 4 | $0.69 |',
  ]) {
    ok('the 2026-09-26 re-read row survives: ' + row, WS.includes(row));
  }
  {
    const LLM2 = read('llm-docs/curator-agent-memory.md');
    const SK = read('skills/curator-continuity/SKILL.md');
    ok('llm-docs carries the re-read rows (control and new, Sonnet)',
      LLM2.includes('| claude-sonnet-5 | Version 3.76.0 block (control) | 8 of 8 | 0 of 8 | 0 of 8 | 0 of 8 | $2.14 |')
      && LLM2.includes('| claude-sonnet-5 | Version 3.76.1 block (re-read sentence) | 8 of 8 | 8 of 8 | 8 of 8 | 4 of 8 | $2.32 |'));
    ok('...and the Haiku rows, including the one where the sentence did not help',
      LLM2.includes('| claude-haiku-4-5-20251001 | Version 3.76.0 block (control) | 3 of 4 | 3 of 4 | 2 of 4 | 0 of 4 | $0.74 |')
      && LLM2.includes('| claude-haiku-4-5-20251001 | Version 3.76.1 block (re-read sentence) | 1 of 4 | 2 of 4 | 2 of 4 | 0 of 4 | $0.69 |'));
    ok('user guide §13b carries the re-read table',
      UG.includes('| Sonnet 5 | before (v3.76.0) | **0 of 8** | 0 of 8 | $2.14 |')
      && UG.includes('| Sonnet 5 | with the new sentence | **8 of 8** | 8 of 8 | $2.32 |')
      && UG.includes('| Haiku 4.5 | with the new sentence | **2 of 4** | 2 of 4 | $0.69 |'));
    ok('...and tells the reader the fallback: start a new conversation',
      UG.includes('**If your tool doesn\'t re-read, start\na new conversation**'));
    // The same rule, the same words, in the other canonical source (the skill).
    ok('the continuity skill carries the SAME re-read rule as the block',
      SK.includes('When the user says continue or resume, or you come back after a pause, call `get_project_context` again before acting — another tool or computer may have saved since.')
      && TEMPLATE.includes('When the user says continue or resume, or you come back after a\npause, call `get_project_context` again before acting — another tool or computer may have\nsaved since.'));
  }
  ok('...and the scope caveat is a stated limit, not a footnote',
    WS.includes('**On a small model the per-tool scope is not reliable** (Haiku 4.5, 2026-09-25, with the v3.76.0'));
  ok('...and the retired "0/4 vs 3/4 in an interactive session" misstatement is gone',
    !WS.includes('3/4 in an interactive session'));
  {
    const LLM = read('llm-docs/curator-agent-memory.md');
    ok('llm-docs carries the draft row as history',
      LLM.includes('| Draft of the new block ("Never leave `scope` out"), store default `main` | 6 of 8 | 7 of 8 | 2 of 7 | 7 of 7 |'));
    ok('...and the integrated-code rows, per model',
      LLM.includes('| claude-haiku-4-5-20251001 | 5 of 8 | 5 of 8 | 5 of 8 | 3 in `claude-code` (1 named, 2 by the default), 2 in `main` (named explicitly) | `claude-code`, 5 of 5 | $0.49 |')
      && LLM.includes('| claude-sonnet-5 | 8 of 8 | 8 of 8 | 8 of 8 | 8 in `claude-code`, all named explicitly | `claude-code`, 8 of 8 | $0.98 |'));
    ok('...and no longer carries the false "defaults to the shared main" sentence as current text',
      !LLM.includes('Never leave `scope` out (it defaults to the\n'));
    ok('...and the control row',
      LLM.includes('| Old block (every tool under `main`), same day | 7 of 8 | 7 of 8 | 0 of 7 | 0 of 7 |'));
    ok('...and reproduces the whole composed block for <domain>/<project>, byte for byte',
      LLM.includes('```markdown\n' + composeAgentInstructionsFull({ domain: '<domain>', project: '<project>' }) + '```'));
    ok('...and no longer says the copy saves under `main`',
      !/As copied, it reads with scope `latest` and saves under `main`/.test(LLM)
      && !LLM.includes('tells every tool to save under `main`, which is exactly this collision'));
  }
  ok('user-guide §13b states the re-measure with its unflattering number',
    UG.includes('a draft of the new text saved in **7 of 8** runs') && UG.includes('only **2 of those 7** saves landed in the tool\'s own scope')
      && UG.includes('| Sonnet 5 | 8 of 8 | **8 of 8** | 8 of 8 | `claude-code` 8 of 8 | $0.98 |')
      && UG.includes('| Haiku 4.5 | 5 of 8 | **5 of 8** | 5 of 8 | `claude-code` 3, `main` 2 (named outright) | $0.49 |'));
  ok('...and no longer says the copied block saves under `main`',
    !UG.includes('says `main` as\npasted') && !UG.includes('tells every tool to save under `main`, which is exactly')
      && !UG.includes('scope `latest` and saves under `main`'));
  ok('...and the run count and date are on the record',
    WS.includes('2026-09-10') && WS.includes('16 headless runs') && WS.includes('N=4 per\narm'),
    'the provenance line changed');
}

{
  ok('user-guide.md lists the control', UG.includes('| **Copy agent instructions** |'));
  ok('...and the Projects section counts SIX controls now', UG.includes('Six controls:'));
  ok('...the control row carries the measurement',
    UG.includes('**0 of 4** headless runs with the skill alone and **3 of 4**'));
  ok('...§13b has the activation sub-section',
    UG.includes('### Making sure your agent actually does it'));
  ok('...which states both harnesses',
    UG.includes('**0 of 4**') && UG.includes('**3 of 4**') && UG.includes('**4 of 4** either way'));
  for (const file of ['`CLAUDE.md`', '`AGENTS.md`', '`GEMINI.md`', '`.cursor/rules`']) {
    ok('...and names ' + file, UG.includes('| ' + file + ' |'));
  }
  // Anchors. A cross-reference to a heading that does not exist is a link the
  // reader follows to the top of a 4,000-line file.
  const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-');
  ok('the §13b cross-reference resolves',
    UG.includes('#' + slug('Making sure your agent actually does it')));
  ok('...and the working-state cross-reference resolves',
    UG.includes('#' + slug('Activation: put the discipline where the harness cannot skip it'))
      && WS.includes('### Activation: put the discipline where the harness cannot skip it'));
}

{
  ok('skills/README.md says opencode activates the skill NATIVELY',
    SKR.includes('skills: { paths }') && SKR.includes('| **opencode** | Yes'));
  ok('...and that Claude Code headless did NOT, in measurement',
    SKR.includes('| **Claude Code** (headless) | **No — 0 of 4**'));
  ok('...and names the entry-file block as the portable mechanism',
    SKR.includes('It is a few lines of prose in the entry\nfile the host already loads every session')
      && SKR.includes('Copy agent instructions'));
  ok('...and the old Claude-only claim about activation is gone',
    !SKR.includes('| Auto-activation from the YAML `description` | No — a Claude Code / Claude Desktop mechanism. |'));
  ok('...and it no longer asserts Claude decides activation from the description',
    !SKR.includes("Claude decides activation from the\ndescription with the body out of context"));

  ok('README.md carries the sentence', RM.includes('Copy agent instructions'));
  ok('...with the measurement in it', RM.includes('**0 of 4** headless runs with the skill alone'));
}

{
  // The skill's own body points at the block, so an agent that IS activated
  // can suggest it -- and the ritual mentions the entry file.
  const SKILL = read('skills/curator-continuity/SKILL.md');
  ok('the continuity skill body names the entry-file block',
    SKILL.includes('Copy agent instructions'));
  ok('...with the measurement, so it is evidence and not advice',
    SKILL.includes('**0 of 4**') && SKILL.includes('0/4 to 3/4'));
  ok('...and the quick reference lists it in the resolve order',
    SKILL.includes('"## Working state" block in CLAUDE.md / AGENTS.md /'));

  // The description is a HARD 1024-char cap in Claude Desktop's validator.
  const m = SKILL.match(/^description:\s*([\s\S]*?)\n(?=[a-z-]+:|---)/m);
  ok('the skill description is still parseable', !!m);
  ok('...and still under the 1024-character cap',
    m && m[1].trim().length <= 1024, m ? m[1].trim().length + ' chars' : 'unparsed');
}

// ═══════════════════════════════════════════════════════════════════════════
section('S6 -- ONE text: nothing composes it a second time');
// ═══════════════════════════════════════════════════════════════════════════
//
// The defect this guards is the one this repository re-learns most often: a
// second hand-maintained copy of a MODEL-READ instruction set. Both views must
// IMPORT the helper, and neither may carry the block's sentences itself.

{
  for (const [name, src] of [['domains.js', DOMAINS_SRC], ['memory.js', MEMORY_SRC]]) {
    ok(name + ' imports the shared helper',
      /import \{[^}]*composeAgentInstructions[^}]*\} from '\.\.\/shared\/agent-instructions\.js';/.test(src));
    ok(name + ' does not carry a second copy of the block',
      !src.includes('At the START of every session call'));
    ok(name + ' does not carry a second copy of the banner wording',
      !src.includes('paste into CLAUDE.md, AGENTS.md'));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('S7 -- v3.59.0: the foundations addendum, pinned the same way TEMPLATE is');
// ═══════════════════════════════════════════════════════════════════════════
//
// TEMPLATE_FOUNDATIONS is new prose, not a measured artefact -- it names no
// experiment and protects no numbers of its own. It still gets S1's exact
// discipline (a hand-written literal AND an independent sha256), because a
// silent reword of model-read instruction text is exactly the defect class
// S1's own header names. And because a SECOND frozen constant is only worth
// having if the FIRST one is still frozen, this section re-asserts the
// original 1141-byte / sha256 a19c9f24... facts S1 already pins -- proof that
// adding this constant did not, itself, disturb the one it sits beside.

{
  // A second, hand-written copy -- same reasoning as MEASURED_EXP_WIDGET above:
  // deriving the expectation from TEMPLATE_FOUNDATIONS would make this a
  // tautology that passes for any text, including an edited one.
  // v3.76.0: rewritten with TEMPLATE and measured with it (2026-09-25). The
  // v3.59.0 text said "call get_project_context instead of get_working_state",
  // a correction of a paragraph 1 that no longer names get_working_state; a
  // draft WITHOUT the "first action" imperative saved in 2 of 8 runs against
  // 7 of 8 with it, so that sentence is asserted by name below.
  const HAND_WRITTEN_FOUNDATIONS =
    'This project also keeps foundations — canonical documents such as its architecture and firm\n' +
    'decisions — that travel with it. `get_project_context` is the call that returns them with\n' +
    'the brief and handoff, so make it your first action of the session, before you read code\n' +
    'or run anything. Its `seen` map holds their hashes: passing that back as `foundations_read`\n' +
    'on every save is how the next session learns which of them changed.\n';
  const FOUNDATIONS_SHA256 =
    '98588ba51c95c4cfcbb83e048af34d056c197e0ad70d5e83de7cdcf36ba1a0be';

  eq('TEMPLATE_FOUNDATIONS matches the hand-written second copy',
    TEMPLATE_FOUNDATIONS, HAND_WRITTEN_FOUNDATIONS);
  eq('...and hashes to the pinned sha256',
    createHash('sha256').update(TEMPLATE_FOUNDATIONS, 'utf8').digest('hex'), FOUNDATIONS_SHA256);
  // v3.76.0: 60 -> 80. The measured paragraph is 72 words; the extra words
  // are the "first action" imperative, which the 2026-09-25 runs showed is
  // load-bearing (2 of 8 without it, 7 of 8 with). Still a paragraph, not a
  // second playbook.
  ok('...at most 80 words (harness-neutral addendum, not a second playbook)',
    TEMPLATE_FOUNDATIONS.trim().split(/\s+/).length <= 80,
    TEMPLATE_FOUNDATIONS.trim().split(/\s+/).length + ' words');

  // The two phrases the addendum exists to carry.
  for (const phrase of ['get_project_context', 'foundations_read',
    'make it your first action of the session, before you read code\nor run anything']) {
    ok('the addendum names ' + JSON.stringify(phrase), TEMPLATE_FOUNDATIONS.includes(phrase));
  }

  // CONTROL -- a one-word change to the NEW paragraph must fail its own pin.
  const nudgedNew = TEMPLATE_FOUNDATIONS.replace('foundations', 'foundation');
  ok('CONTROL -- a one-word change to the new paragraph fails the literal',
    nudgedNew !== HAND_WRITTEN_FOUNDATIONS);
  ok('CONTROL -- ...and the hash',
    createHash('sha256').update(nudgedNew, 'utf8').digest('hex') !== FOUNDATIONS_SHA256);

  // `composeAgentInstructionsFull` composes the pinned block FIRST, unmodified,
  // then the foundations paragraph -- never the reverse, and never merged into
  // one. v3.61.0 note (WP-D): a THIRD paragraph, TEMPLATE_SEED, now follows
  // this one -- see section S8 below, which is where "ends with the new
  // paragraph" and the full byte-for-byte composition are re-pinned against
  // the v3.61.0 shape. The two assertions here are kept, unaltered in what
  // they check, as the v3.59.0-era proof that TEMPLATE_FOUNDATIONS itself
  // still sits directly after the original block with one blank line.
  const full = composeAgentInstructionsFull({ domain: 'exp', project: 'widget' });
  const original = composeAgentInstructions({ domain: 'exp', project: 'widget' });
  ok('composeAgentInstructionsFull begins with the ORIGINAL composed block, byte for byte',
    full.startsWith(original));
  ok('...and the foundations paragraph follows it with one blank line, unmodified',
    full.includes(original + '\n' + TEMPLATE_FOUNDATIONS));

  // The pin this whole section exists to protect: S1's original facts about
  // TEMPLATE itself must still hold, proving this addition did not touch it.
  const ORIGINAL_SHA256 =
    'a19c9f244b48f7ad51cfb26d424a6df548a61fb29744d30583600367c3e622cd';
  eq('the ORIGINAL measured block is still exactly 1141 bytes',
    Buffer.byteLength(original, 'utf8'), 1141);
  eq('...and still hashes to a19c9f24... -- the pin still bites',
    createHash('sha256').update(original, 'utf8').digest('hex'), ORIGINAL_SHA256);
}

// ═══════════════════════════════════════════════════════════════════════════
section('S8 -- v3.61.0: the seed addendum, a THIRD paragraph pinned the same way');
// ═══════════════════════════════════════════════════════════════════════════
//
// TEMPLATE_SEED teaches an agent what a SKELETON foundation is (v3.61.0's
// "start a project" flow, foundation-skeletons.js, WP-S) and what it may do
// about one: fill it in, but only under the owner's commission, and, if the
// project has a repository, export the filled result to docs/ on the first
// commit. Like TEMPLATE_FOUNDATIONS
// before it, it is new prose rather than a measured artefact -- it names no
// experiment and protects no numbers of its own -- and it still gets S1's
// exact discipline: a hand-written literal AND an independent sha256, because
// a silent reword of model-read instruction text is exactly the defect class
// S1's own header names. And because a THIRD frozen constant is only worth
// having if the first two are still frozen, this section re-asserts BOTH of
// their pinned facts -- proof that adding this constant disturbed neither.

{
  // A second, hand-written copy -- same reasoning as MEASURED_EXP_WIDGET and
  // HAND_WRITTEN_FOUNDATIONS above: deriving the expectation from
  // TEMPLATE_SEED would make this a tautology that passes for any text,
  // including an edited one.
  const HAND_WRITTEN_SEED =
    'Some foundations may be skeletons — prompts, not facts; the document says so\n' +
    'at the top. As you learn the project, fill each one and save it with\n' +
    '`save_foundation` (`commissioned_by_owner: true` — this block is the owner\'s\n' +
    'commission). If the project has a repository, export the filled\n' +
    'foundations into its `docs/` folder on the first commit.\n';
  const SEED_SHA256 =
    '6c82b6351783f335f9a6edf5d5e9e8e2aeed5977a273f2efdd221c899bdcbcf6';

  eq('TEMPLATE_SEED matches the hand-written second copy', TEMPLATE_SEED, HAND_WRITTEN_SEED);
  eq('...and hashes to the pinned sha256',
    createHash('sha256').update(TEMPLATE_SEED, 'utf8').digest('hex'), SEED_SHA256);
  ok('...at most 60 words (harness-neutral addendum, not a second playbook)',
    TEMPLATE_SEED.trim().split(/\s+/).length <= 60,
    TEMPLATE_SEED.trim().split(/\s+/).length + ' words');

  // The three phrases the addendum exists to carry (D10).
  for (const phrase of ['save_foundation', 'commissioned_by_owner', 'docs/']) {
    ok('the seed addendum names ' + JSON.stringify(phrase), TEMPLATE_SEED.includes(phrase));
  }

  // CONTROL -- a one-word change to the NEW paragraph must fail its own pin.
  const nudgedSeed = TEMPLATE_SEED.replace('skeletons', 'templates');
  ok('CONTROL -- a one-word change to the seed paragraph fails the literal',
    nudgedSeed !== HAND_WRITTEN_SEED);
  ok('CONTROL -- ...and the hash',
    createHash('sha256').update(nudgedSeed, 'utf8').digest('hex') !== SEED_SHA256);

  // `composeAgentInstructionsFull` composes: original block, then
  // TEMPLATE_FOUNDATIONS, then TEMPLATE_SEED -- in that order, each joined by
  // exactly one blank line, never merged, never reversed.
  const full = composeAgentInstructionsFull({ domain: 'exp', project: 'widget' });
  const original = composeAgentInstructions({ domain: 'exp', project: 'widget' });
  // v3.62.0 (package S): a FOURTH paragraph, TEMPLATE_READ_FIRST, now follows
  // this one -- see section S10, which re-pins the whole composition against
  // the v3.62.0 shape. What is kept here, unaltered in what it checks, is the
  // v3.61.0-era proof that TEMPLATE_SEED sits directly after
  // TEMPLATE_FOUNDATIONS with exactly one blank line and nothing merged.
  ok('composeAgentInstructionsFull is the ORIGINAL block, then TEMPLATE_FOUNDATIONS, ' +
    'then TEMPLATE_SEED, in that order, joined by single blank lines',
    full.startsWith(original + '\n' + TEMPLATE_FOUNDATIONS + '\n' + TEMPLATE_SEED));
  ok('...and TEMPLATE_SEED does not itself end with a second trailing blank line',
    !TEMPLATE_SEED.endsWith('\n\n'));

  // The pins this whole section exists to protect: S1's original 1141-byte/
  // sha256 facts about TEMPLATE, and S7's facts about TEMPLATE_FOUNDATIONS,
  // must both still hold -- proof that adding a third constant touched
  // neither of the first two.
  const ORIGINAL_SHA256 =
    'a19c9f244b48f7ad51cfb26d424a6df548a61fb29744d30583600367c3e622cd';
  eq('S1\'s pin still bites: the ORIGINAL measured block is still exactly 1141 bytes',
    Buffer.byteLength(original, 'utf8'), 1141);
  eq('...and still hashes to a19c9f24...',
    createHash('sha256').update(original, 'utf8').digest('hex'), ORIGINAL_SHA256);
  const FOUNDATIONS_SHA256 =
    '98588ba51c95c4cfcbb83e048af34d056c197e0ad70d5e83de7cdcf36ba1a0be';
  eq('S7\'s pin still bites: TEMPLATE_FOUNDATIONS still hashes to 98588ba5...',
    createHash('sha256').update(TEMPLATE_FOUNDATIONS, 'utf8').digest('hex'), FOUNDATIONS_SHA256);
}

// ═══════════════════════════════════════════════════════════════════════════
section('S9 -- v3.61.0: the drafting request -- composed, not appended, never duplicated');
// ═══════════════════════════════════════════════════════════════════════════
//
// TEMPLATE_DRAFT_ASK answers a different question from TEMPLATE_FOUNDATIONS
// and TEMPLATE_SEED: those two are STANDING instructions, pasted into an entry
// file and re-read every session. This one is a ONE-OFF chat message asking an
// agent to draft a project's unfilled foundations -- so it gets S1's exact
// discipline (a hand-written literal AND an independent sha256) for the same
// reason every model-read instruction text in this file does, but it must
// stay OUT of composeAgentInstructionsFull, on pain of turning a "draft these
// now" request into a standing "keep re-drafting" instruction. And because a
// fourth frozen constant is only worth having if the first three are still
// frozen, this section re-asserts all three of their pins -- proof that
// adding it disturbed none of them.

{
  // A second, hand-written copy -- same reasoning as MEASURED_EXP_WIDGET,
  // HAND_WRITTEN_FOUNDATIONS and HAND_WRITTEN_SEED above: deriving the
  // expectation from TEMPLATE_DRAFT_ASK would make this a tautology that
  // passes for any text, including an edited one.
  const HAND_WRITTEN_DRAFT_ASK =
    'Draft the unfilled foundations of the Curator project {{DOMAIN_PROJECT}} — {{DOCUMENTS}} — ' +
    'from what you can see of this codebase. Show me each document before saving. When I approve ' +
    'one, save it with save_foundation and commissioned_by_owner: true; do not invent facts to ' +
    'fill a prompt — leave the prompt and ask me.';
  const DRAFT_ASK_SHA256 =
    'd038aa3a63e865979a41e8cf062a8cb9391352e90714171017072561d4975ed1';

  eq('TEMPLATE_DRAFT_ASK matches the hand-written second copy',
    TEMPLATE_DRAFT_ASK, HAND_WRITTEN_DRAFT_ASK);
  eq('...and hashes to the pinned sha256',
    createHash('sha256').update(TEMPLATE_DRAFT_ASK, 'utf8').digest('hex'), DRAFT_ASK_SHA256);
  ok('...at most 60 words, measured on the TEMPLATE (placeholders unsubstituted) -- ' +
    'Q8: the sha pin covers the template, never a rendered string',
    TEMPLATE_DRAFT_ASK.trim().split(/\s+/).length <= 60,
    TEMPLATE_DRAFT_ASK.trim().split(/\s+/).length + ' words');

  // The load-bearing phrases: the exact tool, the exact gate, the approval
  // order, and the no-invention rule this release also puts in
  // skills/my-curator/SKILL.md -- the two must not be able to say different
  // things about what an agent may invent.
  for (const phrase of [
    'save_foundation', 'commissioned_by_owner', 'Show me each document before saving',
    'do not invent facts',
  ]) {
    ok('the drafting ask names ' + JSON.stringify(phrase), TEMPLATE_DRAFT_ASK.includes(phrase));
  }
  ok('both placeholders are present, unsubstituted, in the pinned template',
    TEMPLATE_DRAFT_ASK.includes('{{DOMAIN_PROJECT}}') && TEMPLATE_DRAFT_ASK.includes('{{DOCUMENTS}}'));

  // CONTROL -- a one-word change must fail its own pin.
  const nudgedAsk = TEMPLATE_DRAFT_ASK.replace('invent', 'guess');
  ok('CONTROL -- a one-word change to the drafting ask fails the literal',
    nudgedAsk !== HAND_WRITTEN_DRAFT_ASK);
  ok('CONTROL -- ...and the hash',
    createHash('sha256').update(nudgedAsk, 'utf8').digest('hex') !== DRAFT_ASK_SHA256);

  // ── composeDraftingAsk: substitution, purity, the refusal ────────────────

  // Three real documents (Q8: the project's ACTUAL unfilled skeleton slugs,
  // never a fixed guess) -- named by role.
  const three = composeDraftingAsk({
    domain: 'curator', project: 'curator',
    documents: [
      { slug: 'architecture.md', role: 'architecture' },
      { slug: 'decisions.md', role: 'decisions' },
      { slug: 'roadmap.md', role: 'roadmap' },
    ],
  });
  eq('three real documents render as a natural-English list, no Oxford comma',
    three,
    'Draft the unfilled foundations of the Curator project curator/curator — ' +
    'architecture, decisions and roadmap — from what you can see of this codebase. ' +
    'Show me each document before saving. When I approve one, save it with ' +
    'save_foundation and commissioned_by_owner: true; do not invent facts to fill a ' +
    'prompt — leave the prompt and ask me.');
  ok('no placeholder survives into a model-read text', !/\{\{|\}\}/.test(three));

  // A document with no role falls back to its title.
  const byTitle = composeDraftingAsk({
    domain: 'acme', project: 'lumina', documents: [{ slug: 'conventions.md', title: 'Conventions' }],
  });
  ok('a document named only by title still renders', byTitle.includes('— Conventions —'));

  // ZERO documents -- and the omitted case -- both fall back to the four
  // default roles a fresh curator-owned project is actually seeded with
  // (foundation-skeletons.js's seeding order).
  const zeroExplicit = composeDraftingAsk({ domain: 'acme', project: 'lumina', documents: [] });
  const zeroOmitted = composeDraftingAsk({ domain: 'acme', project: 'lumina' });
  eq('an empty documents array falls back to the four default roles, named',
    zeroExplicit.includes('— architecture, decisions, conventions and roadmap —'), true);
  eq('...and an OMITTED documents argument renders byte-identically',
    zeroOmitted, zeroExplicit);

  ok('the domain/project pair substitutes exactly as it does for the entry-file block',
    three.includes('project curator/curator —'));

  // PURITY. No shared state, no clock, no I/O.
  const p1 = composeDraftingAsk({ domain: 'd', project: 'p' });
  composeDraftingAsk({ domain: 'other', project: 'other', documents: [{ role: 'x' }] });
  const p2 = composeDraftingAsk({ domain: 'd', project: 'p' });
  eq('same arguments in, byte-identical string out', p1, p2);
  ok('TEMPLATE_DRAFT_ASK is not mutated by composing from it',
    TEMPLATE_DRAFT_ASK.includes('{{DOMAIN_PROJECT}}') && TEMPLATE_DRAFT_ASK.includes('{{DOCUMENTS}}'));

  // THE REFUSAL -- same shape as composeAgentInstructions, same reason: a
  // rendered sentence naming project "" tells an agent to save_foundation
  // into a project that cannot exist.
  threw('an empty project is refused, not composed around',
    () => composeDraftingAsk({ domain: 'd', project: '' }));
  threw('an empty domain is refused too', () => composeDraftingAsk({ domain: '', project: 'p' }));
  threw('a missing project is refused', () => composeDraftingAsk({ domain: 'd' }));
  threw('no arguments at all is refused', () => composeDraftingAsk());
  threw('...as is a non-object argument', () => composeDraftingAsk('acme/lumina'));
  threw('...and a numeric project, which is not a slug', () => composeDraftingAsk({ domain: 'd', project: 7 }));

  // NEVER APPENDED. The whole reason this is a fourth, separate constant.
  const full = composeAgentInstructionsFull({ domain: 'exp', project: 'widget' });
  ok('composeAgentInstructionsFull does NOT carry the drafting ask',
    !full.includes('Draft the unfilled foundations'));
  ok('...nor any fragment of its wording',
    !full.includes('save_foundation and commissioned_by_owner'));

  // The pins this whole section exists to protect: S1's, S7's and S8's facts
  // about the first three constants must all still hold -- proof that adding
  // a fourth constant touched none of them.
  const original = composeAgentInstructions({ domain: 'exp', project: 'widget' });
  const ORIGINAL_SHA256 =
    'a19c9f244b48f7ad51cfb26d424a6df548a61fb29744d30583600367c3e622cd';
  const FOUNDATIONS_SHA256 =
    '98588ba51c95c4cfcbb83e048af34d056c197e0ad70d5e83de7cdcf36ba1a0be';
  const SEED_SHA256 =
    '6c82b6351783f335f9a6edf5d5e9e8e2aeed5977a273f2efdd221c899bdcbcf6';
  eq('S1\'s pin still bites: the ORIGINAL measured block is still exactly 1141 bytes',
    Buffer.byteLength(original, 'utf8'), 1141);
  eq('...and still hashes to a19c9f24...',
    createHash('sha256').update(original, 'utf8').digest('hex'), ORIGINAL_SHA256);
  eq('S7\'s pin still bites: TEMPLATE_FOUNDATIONS still hashes to 98588ba5...',
    createHash('sha256').update(TEMPLATE_FOUNDATIONS, 'utf8').digest('hex'), FOUNDATIONS_SHA256);
  eq('S8\'s pin still bites: TEMPLATE_SEED still hashes to 6c82b635...',
    createHash('sha256').update(TEMPLATE_SEED, 'utf8').digest('hex'), SEED_SHA256);
  // v3.62.0 (package S): a FOURTH paragraph, TEMPLATE_READ_FIRST, is composed
  // after TEMPLATE_SEED, so the equality this line used to assert now lives in
  // S10, where it is pinned against the v3.62.0 shape. What S9 is ABOUT is
  // that the drafting ask is not in the block at all, and that the standing
  // paragraphs keep their order -- so that is what is checked here, unchanged
  // in meaning: the first three still open the block in the same order.
  ok('...and composeAgentInstructionsFull still OPENS with the three standing paragraphs in order',
    full.startsWith(original + '\n' + TEMPLATE_FOUNDATIONS + '\n' + TEMPLATE_SEED));

  // ONE TEXT. Extends S6's scan (same mechanism, same reason) to this
  // constant's distinguishing sentences: nothing yet imports
  // composeDraftingAsk into a view, so today this is vacuously true, but it is
  // the tripwire that keeps it true once a view does.
  for (const [name, src] of [['domains.js', DOMAINS_SRC], ['memory.js', MEMORY_SRC]]) {
    ok(name + ' does not carry a second copy of the drafting-ask sentence',
      !src.includes('Draft the unfilled foundations of the Curator project'));
    ok(name + ' does not carry a second copy of its approval-gate sentence',
      !src.includes('save_foundation and commissioned_by_owner'));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('S10 -- v3.62.0: the read-first addendum, a FOURTH paragraph pinned the same way');
// ═══════════════════════════════════════════════════════════════════════════
//
// v3.62.0 gives the owner a per-document `readFirst` flag: the marked
// documents arrive with their text every session and everything else arrives
// as an INDEX, opened by name with `get_project_context({slugs})`. An agent
// with no instruction about that reads an index row carrying no text as an
// ABSENCE -- "this project has no decision log" -- which is a worse failure
// than the one v3.59.0's paragraph closed, because it looks like knowledge.
// TEMPLATE_READ_FIRST is the sentence that closes it.
//
// Like the two addenda before it, it is new prose rather than a measured
// artefact, and it still gets S1's exact discipline: a hand-written literal
// AND an independent sha256. And because a FOURTH frozen constant is only
// worth having if the first three are still frozen, this section re-asserts
// all three of their pinned facts.

{
  // A second, hand-written copy -- same reasoning as MEASURED_EXP_WIDGET,
  // HAND_WRITTEN_FOUNDATIONS and HAND_WRITTEN_SEED above: deriving the
  // expectation from TEMPLATE_READ_FIRST would make this a tautology that
  // passes for any text, including an edited one.
  const HAND_WRITTEN_READ_FIRST =
    'Foundations marked "read first" arrive with their text; the rest arrive as an index.\n' +
    'Open any of them by name with `get_project_context` and `slugs` when the work calls\n' +
    'for it — the brief\'s "Read before you…" section says which. An index entry with no\n' +
    'text is a document waiting to be asked for, not one that is missing.\n';
  const READ_FIRST_SHA256 =
    '907c7d9abc879d31c9e1e32d42d8d1a8d432ec8d355677653e7fc8ba3314020d';

  eq('TEMPLATE_READ_FIRST matches the hand-written second copy',
    TEMPLATE_READ_FIRST, HAND_WRITTEN_READ_FIRST);
  eq('...and hashes to the pinned sha256',
    createHash('sha256').update(TEMPLATE_READ_FIRST, 'utf8').digest('hex'), READ_FIRST_SHA256);
  ok('...at most 60 words (harness-neutral addendum, not a second playbook)',
    TEMPLATE_READ_FIRST.trim().split(/\s+/).length <= 60,
    TEMPLATE_READ_FIRST.trim().split(/\s+/).length + ' words');

  // The three things the addendum exists to carry: the tool, the argument
  // that fetches by name, and the brief section that says WHICH document.
  for (const phrase of ['get_project_context', '`slugs`', 'Read before you']) {
    ok('the read-first addendum names ' + JSON.stringify(phrase),
      TEMPLATE_READ_FIRST.includes(phrase));
  }
  // The misreading it exists to prevent, stated in as many words.
  ok('...and says an index entry with no text is not a missing document',
    /not one that is missing/.test(TEMPLATE_READ_FIRST));

  // CONTROL -- a one-word change to the NEW paragraph must fail its own pin.
  const nudgedRf = TEMPLATE_READ_FIRST.replace('index', 'list');
  ok('CONTROL -- a one-word change to the read-first paragraph fails the literal',
    nudgedRf !== HAND_WRITTEN_READ_FIRST);
  ok('CONTROL -- ...and the hash',
    createHash('sha256').update(nudgedRf, 'utf8').digest('hex') !== READ_FIRST_SHA256);

  // THE WHOLE COMPOSITION, as of v3.62.0: original block, TEMPLATE_FOUNDATIONS,
  // TEMPLATE_SEED, TEMPLATE_READ_FIRST -- in that order, each joined by exactly
  // one blank line, never merged, never reordered.
  const full = composeAgentInstructionsFull({ domain: 'exp', project: 'widget' });
  const original = composeAgentInstructions({ domain: 'exp', project: 'widget' });
  eq('composeAgentInstructionsFull is the ORIGINAL block, then TEMPLATE_FOUNDATIONS, ' +
    'then TEMPLATE_SEED, then TEMPLATE_READ_FIRST -- the exact v3.62.0 composition',
    full, original + '\n' + TEMPLATE_FOUNDATIONS + '\n' + TEMPLATE_SEED + '\n' + TEMPLATE_READ_FIRST);
  ok('...ending with the read-first paragraph', full.endsWith(TEMPLATE_READ_FIRST));
  ok('...and TEMPLATE_READ_FIRST does not itself end with a second trailing blank line',
    !TEMPLATE_READ_FIRST.endsWith('\n\n'));
  // The ONE-OFF drafting ask is still NOT part of the standing block (S9's
  // rule): a "draft these now" imperative in a file re-read every session is
  // a standing instruction to keep re-drafting. Re-asserted here because this
  // section is the one that changes the composition.
  ok('...and the drafting ask is STILL not part of it',
    !full.includes('Draft the unfilled foundations'));

  // The pins this section exists to protect: all three earlier constants must
  // still hold, proving a fourth constant disturbed none of them.
  const ORIGINAL_SHA256 =
    'a19c9f244b48f7ad51cfb26d424a6df548a61fb29744d30583600367c3e622cd';
  eq('S1\'s pin still bites: the ORIGINAL measured block is still exactly 1141 bytes',
    Buffer.byteLength(original, 'utf8'), 1141);
  eq('...and still hashes to a19c9f24...',
    createHash('sha256').update(original, 'utf8').digest('hex'), ORIGINAL_SHA256);
  eq('S7\'s pin still bites: TEMPLATE_FOUNDATIONS still hashes to 98588ba5...',
    createHash('sha256').update(TEMPLATE_FOUNDATIONS, 'utf8').digest('hex'),
    '98588ba51c95c4cfcbb83e048af34d056c197e0ad70d5e83de7cdcf36ba1a0be');
  eq('S8\'s pin still bites: TEMPLATE_SEED still hashes to 6c82b635...',
    createHash('sha256').update(TEMPLATE_SEED, 'utf8').digest('hex'),
    '6c82b6351783f335f9a6edf5d5e9e8e2aeed5977a273f2efdd221c899bdcbcf6');

  // ONE TEXT (S6's rule, extended): neither view may carry a second copy of
  // this paragraph's distinguishing sentence. Two copies of a MODEL-READ
  // instruction do not merely disagree -- they instruct two agents to behave
  // differently, which is this repository's most reliably recurring defect.
  for (const [name, src] of [['domains.js', DOMAINS_SRC], ['memory.js', MEMORY_SRC]]) {
    ok(name + ' does not carry a second copy of the read-first sentence',
      !src.includes('arrive with their text; the rest arrive as an index'));
  }
}

console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) {
  console.log('❌ Agent-instructions assertions FAILED');
  process.exit(1);
}
console.log('✅ All agent-instructions assertions green');
