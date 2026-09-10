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
} from '../src/public/next/shared/agent-instructions.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
  '`get_working_state` with project "widget" and scope "latest" and read the standing\n' +
  'brief before acting. SAVE with `save_working_state` under project "widget", scope\n' +
  '"main", after every material decision and at least every ten tool calls, and ALWAYS\n' +
  'before you stop; a save overwrites, so send the complete state each time.\n';

// The sha256 of /private/tmp/wt52-entry-block.md as it was fed to the runs.
// An INDEPENDENT witness to the same fact: the literal above could itself be
// mistyped in a way that matches a mistyped TEMPLATE, and a hash cannot be.
const MEASURED_SHA256 =
  '85dc8f9738e783e3c909133fd899c84978aa48b7c4e2c9ab922d927305244f5b';

{
  const out = composeAgentInstructions({ domain: 'exp', project: 'widget' });
  eq('the composed block IS the artefact that was measured', out, MEASURED_EXP_WIDGET);
  eq('...and hashes to the measured file\'s sha256',
    createHash('sha256').update(out, 'utf8').digest('hex'), MEASURED_SHA256);
  eq('...501 bytes, including the single trailing newline', Buffer.byteLength(out, 'utf8'), 501);

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
    'get_working_state',
    'save_working_state',
    'scope "latest"',
    'read the standing',
    'after every material decision and at least every ten tool calls',
    'ALWAYS\nbefore you stop',
    'a save overwrites, so send the complete state each time',
    '`.curator-project`',
    'my-curator MCP tool',
  ]) {
    ok('the tested wording survives: ' + JSON.stringify(phrase), out.includes(phrase));
  }
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
  eq('...and is the exact wording the release specifies', COPY_SUCCESS_BANNER,
    'Agent instructions copied — paste into CLAUDE.md, AGENTS.md, GEMINI.md or your Cursor rules');
}

// ═══════════════════════════════════════════════════════════════════════════
section('S3 -- Domains -> Projects: the row, the click, the refusal');
// ═══════════════════════════════════════════════════════════════════════════

const DOMAINS_SRC = read('src/public/next/views/domains.js');

const DOM_FNS = [
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
    'composeAgentInstructions', 'COPY_SUCCESS_BANNER',
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
  )(composeAgentInstructions, COPY_SUCCESS_BANNER);
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
  eq('clicking it puts EXACTLY the helper\'s text on the clipboard',
    domBox.__calls().clipboard[0],
    composeAgentInstructions({ domain: 'alpha', project: 'lumina' }));
  eq('...the outcome is recorded as an agent copy', domBox.__state().copied.kind, 'agent');
  eq('...for the project that was clicked', domBox.__state().copied.project, 'lumina');
  eq('...and succeeded', domBox.__state().copied.ok, true);
  ok('...and the view repainted', domBox.__calls().render >= 1);

  const painted = domBox.renderCopyOutcome();
  ok('the confirmation says the instructions were copied', painted.includes('Agent instructions copied'));
  ok('...and names where to paste them', painted.includes('CLAUDE.md') && painted.includes('AGENTS.md'));
  ok('...with no fallback block, because nothing was lost', !painted.includes('dm-proj-copy-fallback'));

  // The marker action still works, unchanged, through the SAME shared body.
  markerBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  eq('the marker action still copies exactly domain/project',
    domBox.__calls().clipboard[1], 'alpha/lumina');
  eq('...and is recorded as a marker copy', domBox.__state().copied.kind, 'marker');
  ok('...with its own confirmation', domBox.renderCopyOutcome().includes('Marker line copied'));
}

{
  // A REFUSED CLIPBOARD MUST NOT LOSE THE TEXT. The block is a paragraph, so
  // it gets a selectable mono block rather than being crammed into a sentence.
  domBox.__setState(domState());
  domBox.__reset();
  domBox.__setClipboard(false);
  await domBox.copyProjectAgentInstructions('lumina');
  eq('a refusal is recorded as a failure', domBox.__state().copied.ok, false);
  eq('...and keeps the whole block', domBox.__state().copied.text,
    composeAgentInstructions({ domain: 'alpha', project: 'lumina' }));
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

const MEM_FNS = ['renderCopyOutcome', 'renderProject', 'copyAgentInstructions', 'wire'];

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
const pendingListboxes = [];
function gatedLoader() { return '<!--LOADER-->'; }
function unlistedCount() { return 0; }
function renderUnlistedNote() { return '<!--UNLISTED-->'; }
function renderSaveStatus() { return '<!--SAVESTATUS-->'; }
function renderStaleNotice() { return '<!--STALE-->'; }
function renderEmptyProject() { return '<!--EMPTY-->'; }
function renderAbout() { return '<!--ABOUT-->'; }
function renderBriefOnlyNotice() { return '<!--BRIEFONLY-->'; }
function renderScopeControls() { return '<!--SCOPES-->'; }
function renderHandoff() { return '<!--HANDOFF-->'; }
function renderJournal() { return '<!--JOURNAL-->'; }
function renderBrief() { return '<!--BRIEF-->'; }
function keyOf(d, p) { return d + '/' + p; }
function activeKey() { return keyOf(state.activeDomain, state.activeProject); }
function selectProject() {}
function saveBrief() {}
function refreshIndex() {}
function reloadActive() {}
function loadScope() {}
function mountListbox() {}
const JOURNAL_PAGE = 5;
const JOURNAL_MORE = 50;
let document = { getElementById: () => null, querySelectorAll: () => [] };
const navigator = { clipboard: { writeText: async (t) => {
  if (!clipboardOk) throw new Error('denied');
  calls.clipboard.push(t);
} } };
`;
  return new Function(
    'composeAgentInstructions', 'COPY_SUCCESS_BANNER',
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
       __setClipboard: (v) => { clipboardOk = v; },
       __setMounted: (v) => { mounted = v; } };`
  )(composeAgentInstructions, COPY_SUCCESS_BANNER);
})();

const memState = (over) => ({
  activeDomain: 'acme', activeProject: 'lumina',
  projectRead: { scopes: [], brief: { present: false } },
  detail: null, detailError: null, detailLoading: false,
  copied: null, ...over,
});

{
  memBox.__setState(memState());
  const html = memBox.renderProject();
  ok('the header carries the action', html.includes('id="mem-copy-agent"'));
  ok('...labelled in the words the docs use', html.includes('Copy agent instructions'));
  ok('CONTROL -- the rest of the page really did render, so the check is not vacuous',
    html.includes('<!--EMPTY-->') && html.includes('<!--ABOUT-->'));

  const ro = (() => {
    memBox.__setState(memState({ detail: { readonly: true } }));
    return memBox.renderProject();
  })();
  ok('a read-only Shared Brain mirror gets it too -- nothing here writes',
    ro.includes('id="mem-copy-agent"'));
  ok('CONTROL -- ...and still says it is a mirror', ro.includes('shared mirror'));
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
  eq('clicking it copies the helper\'s text for the project on screen',
    memBox.__calls().clipboard[0],
    composeAgentInstructions({ domain: 'acme', project: 'lumina' }));
  eq('...stamped with the domain it was pressed on', memBox.__state().copied.domain, 'acme');
  eq('...and the project', memBox.__state().copied.project, 'lumina');
  ok('...and the view repainted', memBox.__calls().render >= 1);
  ok('the confirmation paints', memBox.renderCopyOutcome().includes('Agent instructions copied'));
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
  memBox.__setState(memState({
    copied: { domain: 'acme', project: 'lumina', ok: true, text: 'x' },
  }));
  ok('CONTROL -- the matching pair DOES paint, so the two checks above are not vacuous',
    memBox.renderCopyOutcome().includes('Agent instructions copied'));
}

{
  // A refusal here keeps the block too.
  memBox.__setState(memState());
  memBox.__reset();
  memBox.__setClipboard(false);
  await memBox.copyAgentInstructions(1);
  eq('a refused copy is recorded as a failure', memBox.__state().copied.ok, false);
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

console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) {
  console.log('❌ Agent-instructions assertions FAILED');
  process.exit(1);
}
console.log('✅ All agent-instructions assertions green');
