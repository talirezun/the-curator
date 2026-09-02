/**
 * test-next-sharedbrain-wizard.js — OFFLINE suite for the Shared Brain SETUP
 * WIZARD and the connection card's stored-token check.
 *
 * Subject: src/public/next/views/shared-brain-wizard.js + views/shared.js +
 * views/shared.css, pinned against the real route contract in
 * src/routes/sharedbrain.js.
 *
 * No network, no API key, no server, no browser, no dependency. Every
 * function under test is lifted out of the LIVE source by brace-matching and
 * executed with `new Function` — the technique test-next-sharedbrain-admin.js
 * and test-next-settings-scroll-and-scale.js use, and for the reason
 * CLAUDE.md records at v3.0.17: "a test that proves a line exists proves
 * nothing about what it does."
 *
 * ── WHY THIS SUITE EXISTS ────────────────────────────────────────────────
 * v3.43.0 drove the whole Shared Brain flow end to end for the first time,
 * with two isolated instances and a real GitHub repository. What that run
 * found in the wizard was not a crash — every unit of it worked — but a set
 * of places where a person could not get through, or could not get out:
 *
 *   · GitHub's fine-grained token page defaults its **Resource owner** to
 *     the signed-in personal account, so an ORGANISATION's repository is
 *     simply absent from the picker with no error. Nothing in the app named
 *     the field. That is the cohort-killer: it presents as "the collaborator
 *     invitation never arrived".
 *   · GitHub's default **Expiration is 30 days**. Nothing named that either,
 *     so a cohort's pushes stop dead a month after setup, silently.
 *   · Editing the invite token after checking a PAT cleared the verdict in
 *     STATE (the H1 fix) and left the checked token sitting in the field
 *     under a green "verified" line — both describing a repository the
 *     invite no longer names.
 *   · A scrim click discarded a filled-in wizard instantly, including an
 *     admin token that had been minted, SHOWN ONCE, and is persisted only by
 *     the save on step 5.
 *   · Enter did nothing, anywhere. The panels are not a <form>, and every
 *     step change moves focus to the panel's <h3>.
 *
 * ── COVERED, BEHAVIOURALLY (the real functions run, both directions) ──────
 *   §1  stepCountLabel + the REAL goToStep writing it into the DOM
 *   §2  resourceOwnerSentence — one sentence, two renderings — and the REAL
 *       refreshPatStepCopy composing it from the invite metadata, escaped
 *   §3  patCheckRequest: the exact body that carries a live credential
 *   §4  patVerdict / patVerdictAccepts over every response the route emits
 *   §5  bindStep3 DRIVEN against a recording fetch: the Check token button,
 *       the debounce, the sequence guard, and what is stored on each verdict
 *   §6  isDirty + dismissDecision + discardConfirmText, and the REAL
 *       requestDismiss / showDiscardConfirm against a fake DOM
 *   §7  the invite-edit reset (F-14), driven through the REAL bindStep1
 *   §8  enterTargetId / primaryButtonId, per mode, per step, and the nulls
 *   §9  plainInviteError
 *   §10 the markup: what the panels actually say
 *   §11 the CSS: the heading focus ring, and the sheet's clip budget
 *   §12 the card's stored-token check (views/shared.js)
 *
 * ── NOT COVERED (stated, not implied away) ───────────────────────────────
 *   · Anything needing real layout or a real browser: whether step 2's
 *     Continue is REACHED by a scroll at 900px is asserted here as a
 *     stylesheet BUDGET (max-height + overflow), not as a measurement; the
 *     render was checked separately in a headless browser.
 *   · The routes themselves. Request shapes are pinned against the route
 *     source; no HTTP server runs here.
 *   · The clipboard, focus rings as pixels, and the actual GitHub calls.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const R = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const wizard = R('src/public/next/views/shared-brain-wizard.js');
const shared = R('src/public/next/views/shared.js');
const sharedCss = R('src/public/next/views/shared.css');
const appJs = R('src/public/next/app.js');
const routes = R('src/routes/sharedbrain.js');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  \u001b[32m✓\u001b[0m ${label}`); }
  else { failed++; console.log(`  \u001b[31m✗ ${label}\u001b[0m`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)})`); }
function section(t) { console.log(`\n${t}`); }

// ── Extraction ───────────────────────────────────────────────────────────
function extractFunction(src, name, where) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start), parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i).replace(/^export\s+/, '');
  // Two tripwires, because several of these are one-liners and the usual
  // `\n}` heuristic would reject them: the text must END at a brace, and it
  // must PARSE. A desync has to fail loudly here, not later as a confusing
  // SyntaxError out of a 400-line new Function().
  if (!/\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced in ${where}`);
  try { new Function(out); } catch (e) { throw new Error(`extractFunction: "${name}" does not parse (${e.message})`); }
  return out;
}

/** Lifts a top-level `const NAME = …;`. String- and bracket-aware, so a ';'
 *  inside one of these long sentences cannot end the declaration early — and
 *  they are all long sentences. */
function extractConst(src, name, where) {
  const m = new RegExp(`(?:^|\\n)const ${name}\\s*=`).exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let i = src.indexOf('=', start) + 1, depth = 0, quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) { i++; break; }
  }
  const out = src.slice(start, i);
  if (!out.endsWith(';')) throw new Error(`extractConst: "${name}" did not terminate in ${where}`);
  return out;
}

/** The body of one function, for the few STRUCTURAL assertions that remain.
 *  Scoped to the function so a match in a neighbour cannot satisfy it. */
function bodyOf(src, name) { return extractFunction(src, name, 'shared-brain-wizard.js'); }

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

const ICON_STUB = 'function icon(name, size) { return "<svg data-icon=\\"" + name + "\\"></svg>"; }\n';
const ESCAPE = extractFunction(appJs, 'escapeHtml', 'app.js');

const WIZ_CONSTS = [
  'STEP_TOTAL', 'PAT_EXPIRY_WARNING', 'PAT_REFUSAL', 'INVITE_EDIT_RESET_NOTICE',
  'DIRTY_TEXT_FIELD_IDS', 'DEFAULT_BRANCH', 'PRIMARY_BUTTON_IDS',
];
const PURE_FNS = [
  'stepCountLabel', 'repoOwnerOf', 'resourceOwnerSentence', 'patCheckRequest',
  'patVerdict', 'patVerdictAccepts', 'inviteEditResetNotice', 'plainInviteError',
  'isDirty', 'dismissDecision', 'discardConfirmText', 'primaryButtonId', 'enterTargetId',
];

const pure = new Function(
  WIZ_CONSTS.map((n) => extractConst(wizard, n, 'wizard')).join('\n') + '\n' +
  PURE_FNS.map((n) => extractFunction(wizard, n, 'wizard')).join('\n\n') + '\n' +
  `return { ${PURE_FNS.join(', ')}, ${WIZ_CONSTS.join(', ')} };`
)();

// ── A DOM small enough to reason about, real enough to drive the code ────
//
// Hand-rolled rather than jsdom: zero dependencies is this repo's house rule
// for offline suites, and — the reason that rule earns its keep — a fixture
// whose behaviour you cannot see is how a guard ends up asserting against a
// shape the product cannot produce (the v3.17.1 lesson, recorded again in
// v3.35.0 where a hand-written fixture string WAS the fiction).
function makeEl(id, attrs) {
  const classes = new Set(String((attrs && attrs.className) || '').split(/\s+/).filter(Boolean));
  const el = {
    id,
    tagName: (attrs && attrs.tagName) || 'INPUT',
    type: (attrs && attrs.type) || 'text',
    value: (attrs && attrs.value) !== undefined ? attrs.value : '',
    disabled: !!(attrs && attrs.disabled),
    textContent: '',
    innerHTML: '',
    clicks: 0,
    focused: 0,
    scrolled: 0,
    listeners: {},
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    addEventListener(kind, fn) { (this.listeners[kind] = this.listeners[kind] || []).push(fn); },
    fire(kind, ev) { (this.listeners[kind] || []).forEach((fn) => fn(ev || {})); },
    click() { this.clicks++; this.fire('click', {}); },
    focus() { this.focused++; },
    scrollIntoView() { this.scrolled++; },
  };
  return el;
}

/** The wizard box: the REAL byId/goToStep/requestDismiss/bindStep1/bindStep3
 *  and friends, over a fake root. `closeWizard` and `populateDomains` are
 *  RECORDING STUBS — closeWizard tears down a real document and replaces
 *  module state, which is not what any assertion here is about; what matters
 *  is WHETHER it was called, and that is exactly what the stub records. */
const DOM_FNS = [
  'isFresh', 'byId', 'qsa', 'setInviteMetadata', 'resetPatVerdict', 'currentValidatedPat',
  'isSaveBlocking', 'requestDismiss', 'dirtySignals', 'showDiscardConfirm', 'hideDiscardConfirm',
  'goToStep', 'refreshStep2Links', 'refreshPatCreateLink', 'refreshPatStepCopy',
  'hasPatToClear', 'onInviteTokenEdited', 'bindStep1', 'bindStep3',
];
const DOM_CONSTS = ['STEP_PANELS', 'STEP_LABELS', 'ALL_PANEL_IDS', ...WIZ_CONSTS];

function makeBox(opts) {
  const o = opts || {};
  const els = new Map();
  for (const [id, attrs] of Object.entries(o.elements || {})) els.set(id, makeEl(id, attrs));
  const rec = {
    closed: 0, populated: 0, fetches: [], timers: [], activeElement: null,
    el: (id) => els.get(id) || null,
    ensure: (id, attrs) => { if (!els.has(id)) els.set(id, makeEl(id, attrs)); return els.get(id); },
    flush: () => { const t = rec.timers.splice(0); t.forEach((fn) => fn && fn()); },
  };
  const root = {
    querySelector: (sel) => (sel.startsWith('#') ? (els.get(sel.slice(1)) || null) : null),
    querySelectorAll: () => [],
    contains: () => true,
  };
  const state = Object.assign({
    mode: 'join', step: 1, inviteMetadata: null,
    step1Seq: 0, step1Debounce: null,
    pat: '', patValidation: null, patValidatedRepo: null, patSeq: 0, patDebounce: null,
    selectedDomains: new Set(), displayName: '', attributeByName: false,
    consent: false, saveInProgress: false, discardConfirmOpen: false,
    slugManuallyEdited: false, generatedInviteToken: null, generatedAdminToken: null,
  }, o.state || {});

  const src =
    'let root = HOST_ROOT;\n' +
    'let state = HOST_STATE;\n' +
    'let wizardGen = 1;\n' +
    ESCAPE + '\n' +
    DOM_CONSTS.map((n) => extractConst(wizard, n, 'wizard')).join('\n') + '\n' +
    PURE_FNS.map((n) => extractFunction(wizard, n, 'wizard')).join('\n\n') + '\n' +
    DOM_FNS.map((n) => extractFunction(wizard, n, 'wizard')).join('\n\n') + '\n' +
    'function closeWizard() { REC.closed++; }\n' +
    'function populateDomains() { REC.populated++; }\n' +
    `return { ${DOM_FNS.join(', ')}, ${PURE_FNS.join(', ')}, state: () => state, bumpGen: () => { wizardGen++; } };`;

  const api = new Function(
    'HOST_ROOT', 'HOST_STATE', 'REC', 'document', 'fetch', 'setTimeout', 'clearTimeout',
    src
  )(
    root, state, rec,
    { get activeElement() { return rec.activeElement; } },
    async (url, init) => {
      rec.fetches.push({ url, init });
      const answer = o.response || { ok: true, body: { valid: true, hasWriteAccess: true, repoFullName: 'org/cohort' } };
      return { ok: answer.ok !== false, json: async () => answer.body };
    },
    (fn) => { rec.timers.push(fn); return rec.timers.length; },
    () => {}
  );
  return { api, rec, state, els };
}

// ═════════════════════════════════════════════════════════════════════════
section('§0  The extraction is real, and the harness can fail');
// ═════════════════════════════════════════════════════════════════════════
ok(typeof pure.stepCountLabel === 'function' && typeof pure.enterTargetId === 'function',
  'the pure decision layer extracts and evaluates as real functions');
ok(pure.PAT_EXPIRY_WARNING.length > 40 && /30 days/.test(pure.PAT_EXPIRY_WARNING),
  'extractConst lifted a whole multi-clause sentence, not a fragment up to its first “;”');
{
  // ANTI-VACUITY. Every section below asserts "the real function answers X".
  // If extraction silently produced something inert, those would all pass on
  // a stub. This drives a function to a KNOWN-WRONG argument and requires
  // the answer to differ, so the box is proven to be computing.
  ok(pure.stepCountLabel(3, 5) !== pure.stepCountLabel(4, 5),
    'control: the same function answers differently for different inputs — the box is executing, not echoing');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  "Step N of 5" — computed, and written into the DOM by goToStep');
// ═════════════════════════════════════════════════════════════════════════
eq(pure.stepCountLabel(1, 5), 'Step 1 of 5', 'the first step');
eq(pure.stepCountLabel(5, 5), 'Step 5 of 5', 'the last');
eq(pure.stepCountLabel(6, 5), '', 'a step past the end renders NOTHING rather than a confident lie');
eq(pure.stepCountLabel(0, 5), '', '…and so does a step before the start');
eq(pure.stepCountLabel('x', 5), '', '…and so does a non-number');
eq(pure.STEP_TOTAL, 5, 'the total is the constant, not a literal typed into the label');
{
  const box = makeBox({ elements: { 'sbw-stepcount': { tagName: 'P' } } });
  box.api.goToStep(3, 1);
  eq(box.els.get('sbw-stepcount').textContent, 'Step 3 of 5',
    'the REAL goToStep writes the counter — driven, not grepped');
  box.api.goToStep(1, 1);
  eq(box.els.get('sbw-stepcount').textContent, 'Step 1 of 5', '…and rewrites it on the way back');
  // The stale-generation guard applies to this like everything else.
  box.api.goToStep(4, 99);
  eq(box.els.get('sbw-stepcount').textContent, 'Step 1 of 5',
    '…and a stale generation writes nothing at all');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  Resource owner — the sentence that decides whether a cohort works');
// ═════════════════════════════════════════════════════════════════════════
{
  const meta = { repo: 'acme-labs/cohort-brain', name: 'Cohort' };
  eq(pure.repoOwnerOf(meta), 'acme-labs', 'the owner is the half before the slash');
  eq(pure.repoOwnerOf({ repo: '' }), '', 'no repo, no owner');
  eq(pure.repoOwnerOf(null), '', '…and no metadata at all is not a crash');

  const plain = pure.resourceOwnerSentence(meta);
  ok(plain.includes('acme-labs'), 'the sentence names the OWNER from the invite');
  ok(/resource owner/i.test(plain) && /will not appear/i.test(plain),
    '…names the FIELD, and says what happens if it is wrong — the failure is silent on GitHub');
  const fallback = pure.resourceOwnerSentence(null);
  ok(!/undefined|null/.test(fallback) && /resource owner/i.test(fallback),
    'with no metadata it names the field and describes the owner rather than printing an empty name');

  // ONE sentence, TWO renderings. The wrap callback is the whole reason
  // this is not two strings that can drift.
  const html = pure.resourceOwnerSentence(meta, (v) => '<strong>' + v + '</strong>');
  eq(html, plain.replace('acme-labs', '<strong>acme-labs</strong>'),
    'the HTML rendering is the plain one with only the owner wrapped — they cannot drift');
}
{
  const box = makeBox({
    state: { inviteMetadata: { repo: 'acme-labs/cohort-brain' } },
    elements: { 'sbw-pat-owner': { tagName: 'SPAN' }, 'sbw-stepcount': { tagName: 'P' } },
  });
  box.api.refreshPatStepCopy();
  ok(/<strong>acme-labs<\/strong>/.test(box.els.get('sbw-pat-owner').innerHTML),
    'the REAL refreshPatStepCopy composes it into the panel');
  // Panel entry, not panel exit — rule 1. Driven: goToStep(3) must fill it.
  const box2 = makeBox({
    state: { inviteMetadata: { repo: 'acme-labs/cohort-brain' } },
    elements: { 'sbw-pat-owner': { tagName: 'SPAN' }, 'sbw-stepcount': { tagName: 'P' } },
  });
  eq(box2.els.get('sbw-pat-owner').innerHTML, '', 'before entering step 3 the slot is empty');
  box2.api.goToStep(3, 1);
  ok(/acme-labs/.test(box2.els.get('sbw-pat-owner').innerHTML),
    '…and ENTERING step 3 fills it (rule 1: population on entry, never on leaving the previous panel)');
}
{
  // The owner is the one value in that sentence that comes from data, and it
  // reaches innerHTML. It is escaped at the sink.
  const box = makeBox({
    state: { inviteMetadata: { repo: '<img src=x onerror=alert(1)>/repo' } },
    elements: { 'sbw-pat-owner': { tagName: 'SPAN' } },
  });
  box.api.refreshPatStepCopy();
  const out = box.els.get('sbw-pat-owner').innerHTML;
  ok(!/<img/.test(out) && /&lt;img/.test(out),
    'a hostile owner name is ESCAPED before it reaches innerHTML');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  The request that carries a live credential');
// ═════════════════════════════════════════════════════════════════════════
{
  const meta = { repo: 'org/cohort' };
  const req = pure.patCheckRequest(meta, '  github_pat_11ABCDEFG0abcdefghij  ');
  ok(req.ok === true, 'a plausible token builds a request');
  eq(req.url, '/api/sharedbrain/validate-pat', 'to the route that exists');
  eq(req.method, 'POST', 'by POST');
  eq(Object.keys(req.body).sort().join(','), 'pat,repo',
    'the body carries EXACTLY repo and pat — nothing else travels with a credential');
  eq(req.body.pat, 'github_pat_11ABCDEFG0abcdefghij', 'the token is trimmed, not mangled');
  eq(req.body.repo, 'org/cohort', 'and the repo is the invite’s, not anything typed');

  eq(pure.patCheckRequest(meta, '').code, 'empty', 'an empty field is refused locally');
  eq(pure.patCheckRequest(meta, '   ').code, 'empty', '…whitespace counts as empty');
  eq(pure.patCheckRequest(meta, 'github_pat_1').code, 'short', 'a half-pasted token is refused locally');
  eq(pure.patCheckRequest(null, 'github_pat_11ABCDEFG0abcdefghij').code, 'no-meta',
    'and with no invite metadata there is no repo to check against');
  ok(pure.patCheckRequest(meta, '').ok === false && pure.patCheckRequest(meta, '').body === undefined,
    'a refusal carries NO body — a refused check cannot leak a partial token to the network');

  // The 20-char floor is the SERVER's, mirrored so a half-paste never
  // becomes a 400 the user has to interpret.
  ok(/pat\.length < 20|length < 20/.test(stripComments(routes)),
    'control: the route really does floor the token length at 20, which is what this mirrors');
}
{
  // The two refusal tables differ, and that difference is the point: the
  // same short token is a nudge mid-paste and an error after a press.
  const t = pure.PAT_REFUSAL.typing, b = pure.PAT_REFUSAL.button;
  eq(t.empty, null, 'clearing the field mid-typing says nothing — an empty field is not an error');
  ok(Array.isArray(b.empty) && b.empty[0] === 'error',
    'but pressing Check token on an empty field always answers');
  eq(t.short[0], 'checking', 'a short token mid-paste is a neutral "keep going"');
  eq(b.short[0], 'error', '…and the same token after a deliberate press is a refusal');
  ok(b.short[1] !== t.short[1], '…with different words, because the user did different things');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  GitHub’s verdict → the one message both entry points show');
// ═════════════════════════════════════════════════════════════════════════
{
  const meta = { repo: 'org/cohort' };
  const good = pure.patVerdict({ valid: true, hasWriteAccess: true, repoFullName: 'org/cohort' }, meta);
  eq(good.kind, 'ok', 'a write-capable token is ok');
  ok(/org\/cohort/.test(good.message), '…and the message names what it authenticated against');

  const ro = pure.patVerdict({ valid: true, hasWriteAccess: false }, meta);
  eq(ro.kind, 'warn', 'a read-only token is a WARNING, not an error — read-only membership is supported');
  ok(/Pull/.test(ro.message) && /Read AND write/.test(ro.message),
    '…and says both what it can do and how to fix it');

  const bad = pure.patVerdict({ valid: false, error: 'GitHub rejected the token (401/403).' }, meta);
  eq(bad.kind, 'error', 'a rejection is an error');
  eq(bad.message, 'GitHub rejected the token (401/403).', '…and relays the server’s own diagnosis verbatim');
  eq(pure.patVerdict({ valid: false }, meta).kind, 'error', 'a rejection with no prose is still an error');
  eq(pure.patVerdict(null, meta).kind, 'error', 'and an unreadable answer is an error, never a pass');

  ok(pure.patVerdictAccepts(good) && pure.patVerdictAccepts(ro), 'ok and warn both let the user continue');
  ok(!pure.patVerdictAccepts(bad) && !pure.patVerdictAccepts(null),
    'an error — and a missing verdict — do not');

  // Pinned against the route: these are the exact fields it returns.
  const routeCode = stripComments(routes);
  ok(/valid: true,\s*\n?\s*hasWriteAccess/.test(routeCode) && /repoFullName/.test(routeCode),
    'control: valid / hasWriteAccess / repoFullName are the route’s own field names');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  Step 3 DRIVEN: one checker, two triggers, one recording fetch');
// ═════════════════════════════════════════════════════════════════════════
function step3Box(opts) {
  const o = opts || {};
  const box = makeBox({
    state: Object.assign({ inviteMetadata: { repo: 'org/cohort' }, step: 3 }, o.state),
    response: o.response,
    elements: {
      'sbw-pat-input': { tagName: 'INPUT', type: 'password', value: o.value === undefined ? '' : o.value },
      'sbw-pat-validation': { tagName: 'DIV', className: 'sbw-status sbw-hidden' },
      'sbw-step3-next': { tagName: 'BUTTON', disabled: true },
      'sbw-pat-check': { tagName: 'BUTTON' },
    },
  });
  box.api.bindStep3();
  return box;
}
{
  const box = step3Box({ value: 'github_pat_11ABCDEFG0abcdefghij' });
  box.els.get('sbw-pat-check').click();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  eq(box.rec.fetches.length, 1, 'the Check token button issues exactly one request');
  const f = box.rec.fetches[0];
  eq(f.url, '/api/sharedbrain/validate-pat', '…to the validate route');
  eq(f.init.method, 'POST', '…by POST');
  eq(JSON.parse(f.init.body).pat, 'github_pat_11ABCDEFG0abcdefghij',
    '…carrying the token from the field');
  eq(JSON.parse(f.init.body).repo, 'org/cohort', '…and the repo from the invite');
  ok(!/github_pat_/.test(f.url), 'the token is NEVER placed in the URL');
  eq(box.state.pat, 'github_pat_11ABCDEFG0abcdefghij', 'a valid verdict stores the token');
  eq(box.state.patValidatedRepo, 'org/cohort',
    '…recorded against the repo it was actually checked for (the H1 rule)');
  eq(box.els.get('sbw-step3-next').disabled, false, '…and Continue unlocks');
  ok(/sbw-status-ok/.test(box.els.get('sbw-pat-validation').className),
    '…with the verdict shown in the same place the debounce uses');
}
{
  const box = step3Box({ value: 'nope' });
  box.els.get('sbw-pat-check').click();
  await Promise.resolve();
  eq(box.rec.fetches.length, 0, 'a too-short token is refused LOCALLY — nothing leaves the browser');
  ok(/sbw-status-error/.test(box.els.get('sbw-pat-validation').className),
    '…and the deliberate press still gets an answer');
  eq(box.state.pat, '', '…and nothing is stored');
}
{
  const box = step3Box({
    value: 'github_pat_11ABCDEFG0abcdefghij',
    response: { ok: true, body: { valid: false, error: 'GitHub rejected the token (401/403).' } },
  });
  box.state.pat = 'stale-previously-accepted';
  box.state.patValidation = { valid: true };
  box.state.patValidatedRepo = 'org/cohort';
  box.els.get('sbw-pat-check').click();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  eq(box.state.pat, '', 'a REJECTION clears a previously-accepted token rather than leaving it standing');
  eq(box.state.patValidatedRepo, null, '…and the repo it was accepted for');
  eq(box.els.get('sbw-step3-next').disabled, true, '…and re-locks Continue');
}
{
  // The debounce path: typing does not fetch until the timer runs, and the
  // timer is gated on the sequence so a superseded keystroke never sends.
  const box = step3Box({});
  const input = box.els.get('sbw-pat-input');
  input.value = 'github_pat_11ABCDEFG0abcdefghij';
  input.fire('input');
  eq(box.rec.fetches.length, 0, 'typing schedules a check rather than firing one per keystroke');
  box.rec.flush();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  eq(box.rec.fetches.length, 1, '…and the scheduled check does fire');
  eq(box.state.pat, 'github_pat_11ABCDEFG0abcdefghij', '…storing the same token the button would');
}
{
  const box = step3Box({});
  const input = box.els.get('sbw-pat-input');
  input.value = 'github_pat_11ABCDEFG0abcdefghij';
  input.fire('input');          // schedules timer A
  input.value = 'github_pat_22ZYXWVUTS9zyxwvutsr';
  input.fire('input');          // supersedes it (patSeq bumps)
  box.rec.flush();              // both timers run
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  eq(box.rec.fetches.length, 1,
    'a superseded keystroke never reaches the network — the sequence guard gates the SEND, not just the response');
  eq(JSON.parse(box.rec.fetches[0].init.body).pat, 'github_pat_22ZYXWVUTS9zyxwvutsr',
    '…and the one request carries the token that is actually in the field');
}
{
  const box = step3Box({ value: 'github_pat_11ABCDEFG0abcdefghij' });
  box.els.get('sbw-pat-check').click();   // the request leaves…
  box.api.bumpGen();                       // …and THEN the wizard is closed and reopened
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  eq(box.rec.fetches.length, 1, 'control: the request really was in flight when the wizard was reopened');
  eq(box.state.pat, '', 'a response landing after a close-and-reopen is discarded, not aliased into the new session');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  The discard guard — a scrim click can no longer destroy a token');
// ═════════════════════════════════════════════════════════════════════════
{
  const empty = { typedFields: 0, branchChanged: false, validatedPat: false, selectedDomains: 0, generatedInvite: false, consent: false };
  ok(!pure.isDirty(empty), 'an untouched wizard is not dirty');
  ok(!pure.isDirty(null), '…and neither is a missing signal set');
  ok(pure.isDirty({ ...empty, typedFields: 1 }), 'one typed field is dirty');
  ok(pure.isDirty({ ...empty, branchChanged: true }), 'a changed branch is dirty');
  ok(pure.isDirty({ ...empty, validatedPat: true }), 'a checked token is dirty');
  ok(pure.isDirty({ ...empty, selectedDomains: 1 }), 'a picked domain is dirty');
  ok(pure.isDirty({ ...empty, generatedInvite: true }),
    'AND A MINTED INVITE IS DIRTY — by then the admin token has been shown once and is saved only at step 5');
  ok(pure.isDirty({ ...empty, consent: true }), 'a ticked consent box is dirty');
}
{
  const d = (o) => pure.dismissDecision(o);
  eq(d({ saveInProgress: true, dirty: true, confirmOpen: false }), 'blocked',
    'a save in flight refuses every dismiss gesture (M3), dirty or not');
  eq(d({ saveInProgress: true, dirty: false, confirmOpen: true }), 'blocked',
    '…and outranks the guard itself');
  eq(d({ saveInProgress: false, dirty: true, confirmOpen: false }), 'confirm',
    'a dirty wizard asks before closing');
  eq(d({ saveInProgress: false, dirty: false, confirmOpen: false }), 'close',
    'an untouched one just closes — no confirm nobody needs');
  eq(d({ saveInProgress: false, dirty: true, confirmOpen: true }), 'close',
    'A SECOND GESTURE CLOSES: the guard is a question, never a trap');
}
{
  const sig = { typedFields: 1, generatedInvite: false };
  ok(/Discard what you typed\?/.test(pure.discardConfirmText(sig)), 'the guard asks the question plainly');
  ok(!/admin token/i.test(pure.discardConfirmText(sig)),
    '…and does not mention an admin token that was never minted');
  ok(/admin token/i.test(pure.discardConfirmText({ ...sig, generatedInvite: true })),
    '…but names it when one HAS been minted, because that is the thing being destroyed');
}
{
  // The REAL requestDismiss, over a fake DOM.
  const els = {
    'sbw-discard': { tagName: 'DIV', className: 'sbw-discard sbw-hidden' },
    'sbw-discard-text': { tagName: 'SPAN' },
    'sbw-discard-yes': { tagName: 'BUTTON' },
    'sbw-admin-branch': { tagName: 'INPUT', value: 'main' },
    'sbw-admin-repo': { tagName: 'INPUT', value: '' },
  };
  const clean = makeBox({ elements: els });
  clean.api.requestDismiss();
  eq(clean.rec.closed, 1, 'an untouched wizard closes on the first gesture');

  const dirtyBox = makeBox({ elements: { ...els, 'sbw-admin-repo': { tagName: 'INPUT', value: 'org/cohort' } } });
  dirtyBox.api.requestDismiss();
  eq(dirtyBox.rec.closed, 0, 'a filled-in wizard does NOT close on the first gesture');
  ok(!dirtyBox.els.get('sbw-discard').classList.contains('sbw-hidden'), '…the guard is shown instead');
  ok(dirtyBox.els.get('sbw-discard-text').textContent.length > 0, '…carrying its question');
  eq(dirtyBox.els.get('sbw-discard-yes').focused, 1,
    '…with focus on Discard, so the keyboard has a way out as well as a way back');
  eq(dirtyBox.els.get('sbw-discard').scrolled, 1,
    '…and scrolled into view, because the sheet scrolls and the bar sits above the panels');
  dirtyBox.api.requestDismiss();
  eq(dirtyBox.rec.closed, 1, 'the SECOND gesture closes — nobody is trapped in the wizard');

  const saving = makeBox({ elements: els, state: { saveInProgress: true } });
  saving.api.requestDismiss();
  eq(saving.rec.closed, 0, 'and a save in flight refuses outright');
  ok(saving.els.get('sbw-discard').classList.contains('sbw-hidden'),
    '…without even raising the guard, because the answer is not the user’s to give yet');
}
{
  // The branch field ships pre-filled with `main`. Comparing it to EMPTY
  // rather than to its default would call every fresh admin wizard dirty.
  const els = {
    'sbw-discard': { tagName: 'DIV', className: 'sbw-hidden' },
    'sbw-discard-text': { tagName: 'SPAN' },
    'sbw-discard-yes': { tagName: 'BUTTON' },
    'sbw-admin-branch': { tagName: 'INPUT', value: 'main' },
  };
  const fresh = makeBox({ elements: els });
  ok(!fresh.api.isDirty(fresh.api.dirtySignals()),
    'a freshly-opened admin wizard, with its default branch, is NOT dirty');
  const edited = makeBox({ elements: { ...els, 'sbw-admin-branch': { tagName: 'INPUT', value: 'develop' } } });
  ok(edited.api.isDirty(edited.api.dirtySignals()), '…and one whose branch was changed IS');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  F-14 — editing the invite clears the token, and says why');
// ═════════════════════════════════════════════════════════════════════════
eq(pure.inviteEditResetNotice(false), null, 'nothing to clear ⇒ no accusation on the user’s first keystroke');
ok(/checked against the previous repository|previous repository/i.test(pure.inviteEditResetNotice(true) || ''),
  'and when something WAS cleared, the notice says why — the verdict belonged to another repo');
{
  const box = makeBox({
    state: { pat: 'github_pat_old', patValidation: { valid: true }, patValidatedRepo: 'org/old' },
    elements: {
      'sbw-pat-input': { tagName: 'INPUT', type: 'password', value: 'github_pat_old' },
      'sbw-pat-validation': { tagName: 'DIV', className: 'sbw-status sbw-status-ok' },
      'sbw-step3-next': { tagName: 'BUTTON', disabled: false },
    },
  });
  const hadPat = box.api.hasPatToClear();
  ok(hadPat, 'hasPatToClear sees the standing verdict');
  const seqBefore = box.state.patSeq;
  box.api.onInviteTokenEdited(hadPat);
  eq(box.els.get('sbw-pat-input').value, '', 'THE FIELD IS EMPTIED — the visible half of the H1 fix');
  eq(box.els.get('sbw-step3-next').disabled, true, 'Continue re-locks');
  ok(/sbw-status-warn/.test(box.els.get('sbw-pat-validation').className),
    'and the green "verified" line becomes a warning');
  ok(/Check token/.test(box.els.get('sbw-pat-validation').textContent),
    '…that tells the user exactly what to do next');
  ok(box.state.patSeq > seqBefore,
    'and any check already in flight for the OLD repo is superseded');
}
{
  const box = makeBox({
    elements: {
      'sbw-pat-input': { tagName: 'INPUT', value: '' },
      'sbw-pat-validation': { tagName: 'DIV', className: 'sbw-status' },
      'sbw-step3-next': { tagName: 'BUTTON', disabled: true },
    },
  });
  box.api.onInviteTokenEdited(box.api.hasPatToClear());
  ok(box.els.get('sbw-pat-validation').classList.contains('sbw-hidden'),
    'with nothing to clear, the panel stays silent rather than warning about a loss that did not happen');
}
{
  // End to end through the REAL step-1 handler: type an invite, get a
  // verdict, then edit it.
  const box = makeBox({
    response: { ok: true, body: { valid: true, metadata: { repo: 'org/cohort', name: 'C', branch: 'main', shared_domain: 'c' } } },
    // THE FIXTURE MUST BE A STATE THE PRODUCT CAN REACH. A stored verdict
    // exists only because an invite was parsed first, so inviteMetadata is
    // set — and setInviteMetadata resets the verdict on a repo CHANGE, which
    // never happens if the fixture pretends there was no invite at all. A
    // fixture in an impossible shape is this repo's recorded way of writing
    // a guard that cannot fail (v3.17.1, v3.35.0).
    state: {
      inviteMetadata: { repo: 'org/old', name: 'Old', branch: 'main', shared_domain: 'old' },
      pat: 'github_pat_old', patValidation: { valid: true }, patValidatedRepo: 'org/old',
    },
    elements: {
      'sbw-invite-token': { tagName: 'INPUT', value: 'sbi_something' },
      'sbw-invite-preview': { tagName: 'DIV', className: 'sbw-preview sbw-hidden' },
      'sbw-step1-next': { tagName: 'BUTTON', disabled: true },
      'sbw-step1-status': { tagName: 'DIV', className: 'sbw-status sbw-hidden' },
      'sbw-pat-input': { tagName: 'INPUT', value: 'github_pat_old' },
      'sbw-pat-validation': { tagName: 'DIV', className: 'sbw-status sbw-status-ok' },
      'sbw-step3-next': { tagName: 'BUTTON', disabled: false },
    },
  });
  box.api.bindStep1();
  box.els.get('sbw-invite-token').fire('input');
  eq(box.els.get('sbw-pat-input').value, '',
    'editing the invite token clears the access-token field through the REAL step-1 handler');
  eq(box.state.pat, '', '…and the stored verdict with it (the H1 half)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  Enter advances the step — and knows when not to');
// ═════════════════════════════════════════════════════════════════════════
{
  eq(pure.primaryButtonId('join', 1), 'sbw-step1-next', 'join step 1');
  eq(pure.primaryButtonId('create', 1), 'sbw-admin-step1-next', 'create step 1 is a DIFFERENT button');
  eq(pure.primaryButtonId('create', 2), 'sbw-admin-step2-next', 'create step 2 likewise');
  eq(pure.primaryButtonId('join', 5), 'sbw-step5-save', 'the last step is the save');
  eq(pure.primaryButtonId('create', 5), 'sbw-step5-save', '…shared by both modes, as the panels are');
  eq(pure.primaryButtonId('join', 6), null, 'there is no sixth step');
  eq(pure.primaryButtonId('join', 0), null, '…and no zeroth');

  const base = { mode: 'join', step: 1, saveInProgress: false, discardConfirmOpen: false };
  eq(pure.enterTargetId({ ...base, tag: 'INPUT', type: 'text' }), 'sbw-step1-next',
    'Enter in a text field advances');
  eq(pure.enterTargetId({ ...base, tag: 'H3' }), 'sbw-step1-next',
    'Enter on the focused heading advances — which is where focus IS after every step change');
  eq(pure.enterTargetId({ ...base, tag: 'BUTTON' }), null,
    'Enter on a button is left to the browser — intercepting it would fire the WRONG control');
  eq(pure.enterTargetId({ ...base, tag: 'A' }), null, '…and on a link');
  eq(pure.enterTargetId({ ...base, tag: 'TEXTAREA' }), null, '…and in a textarea, where Enter is a newline');
  eq(pure.enterTargetId({ ...base, tag: 'SELECT' }), null, '…and in a select');
  eq(pure.enterTargetId({ ...base, tag: 'INPUT', type: 'checkbox' }), null,
    'and NEVER from a checkbox — the consent box must not commit a credential write with a stray Enter');
  eq(pure.enterTargetId({ ...base, tag: 'INPUT', type: 'radio' }), null, '…nor a radio');
  eq(pure.enterTargetId({ ...base, tag: 'INPUT', saveInProgress: true }), null, 'nor mid-save');
  eq(pure.enterTargetId({ ...base, tag: 'INPUT', discardConfirmOpen: true }), null,
    'nor while the discard guard is up, where the gesture belongs to the guard’s own buttons');
}
{
  // The keydown handler is where "when it is enabled" lives.
  const keydown = stripComments(bodyOf(wizard, 'onWizardKeydown'));
  ok(/enterTargetId\(/.test(keydown), 'onWizardKeydown asks enterTargetId rather than deciding inline');
  ok(/btn\.disabled/.test(keydown),
    '…and refuses a DISABLED primary, so Enter means exactly what clicking means — nothing');
  ok(/btn\.click\(\)/.test(keydown), '…and otherwise performs the same click');
  ok(/root\.contains\(active\)/.test(keydown),
    '…only for focus inside the wizard, so a keystroke elsewhere on the page is not stolen');
}

// ═════════════════════════════════════════════════════════════════════════
section('§9  The server’s prose, translated where a person meets it');
// ═════════════════════════════════════════════════════════════════════════
{
  const decoded = pure.plainInviteError('Invite token is malformed (could not decode payload)');
  ok(!/payload/i.test(decoded), '"could not decode payload" does not reach the user');
  ok(/damaged|copying/i.test(decoded), '…and what replaces it says what probably happened');
  eq(pure.plainInviteError('Something new the route started saying'),
    'Something new the route started saying',
    'anything unrecognised is passed through VERBATIM — never flattened into a generic message');
  ok(pure.plainInviteError('').length > 0, 'and an empty error still produces a usable sentence');
  ok(/Update The Curator/.test(pure.plainInviteError('uses version 2; this Curator install supports up to v1')),
    'a version-too-new token gains the action the original message lacked');
  // Pinned against the route: this is the string being translated.
  ok(/could not decode payload/.test(routes),
    'control: the route really does emit "could not decode payload" — the translation is not aimed at a ghost');
}

// ═════════════════════════════════════════════════════════════════════════
section('§10  What the panels actually say');
// ═════════════════════════════════════════════════════════════════════════
// wizardShellHtml() composes every panel builder, so all of them load.
const MARKUP_FNS = [
  'panelStep1', 'panelStep2', 'panelStep3', 'panelStep4', 'panelStep5',
  'panelAdminStep1', 'panelAdminStep2', 'wizardShellHtml',
];
const markup = new Function(
  ESCAPE + '\n' + ICON_STUB +
  WIZ_CONSTS.map((n) => extractConst(wizard, n, 'wizard')).join('\n') + '\n' +
  MARKUP_FNS.map((n) => extractFunction(wizard, n, 'wizard')).join('\n\n') + '\n' +
  `return { ${MARKUP_FNS.join(', ')} };`
)();
{
  const labels = extractConst(wizard, 'STEP_LABELS', 'wizard');
  ok(!/'PAT'/.test(labels), 'no progress pip is labelled "PAT" any more');
  ok(/'Your token'/.test(labels), '…it is "Your token" — whose it is was the confusing part');
  ok((labels.match(/'Your token'/g) || []).length === 2, '…in both modes');
}
{
  const shell = markup.wizardShellHtml('create');
  const p1 = markup.panelAdminStep1();
  ok(/Set up a new Shared Brain/.test(shell), 'the card title still names the flow');
  ok(!/<h3>Set up a new Shared Brain<\/h3>/.test(p1),
    'and step 1 no longer REPEATS that title 40px below it');
  ok(/<h3>Name your Shared Brain and its repository<\/h3>/.test(p1),
    '…it names what this panel is for');
  ok(/id="sbw-stepcount"/.test(shell), 'the shell carries the step counter');
  ok(/id="sbw-discard"/.test(shell) && /sbw-discard-yes/.test(shell) && /sbw-discard-no/.test(shell),
    '…and the discard guard, with both answers');
  ok(/role="alertdialog"/.test(shell), '…announced as a question, not as decoration');
}
{
  const p3 = markup.panelStep3();
  ok(/Resource owner/.test(p3), 'step 3 names the Resource owner field');
  ok(/id="sbw-pat-owner"/.test(p3), '…with a slot the invite’s own owner is written into');
  ok(/Expiration/.test(p3) && /30 days/.test(p3), '…names Expiration and GitHub’s 30-day default');
  ok(/pushes stop with no notice/.test(p3), '…and says what expiry does, not merely that it exists');
  ok(/fine-grained/.test(p3), '…and says WHICH kind of token, which is the one GitHub page that works');
  ok(/id="sbw-pat-check"/.test(p3) && /Check token/.test(p3), 'and the field has a Check token button beside it');
  ok(/A <strong>token<\/strong> is a password-like string/.test(p3),
    'the word "token" is glossed at first use, in one sentence');
}
{
  const p1 = markup.panelStep1(), p2 = markup.panelStep2(), a1 = markup.panelAdminStep1();
  ok(/<strong>private repository<\/strong>/.test(a1) && /folder GitHub stores for you/.test(a1),
    '"repository" is glossed where an admin first meets it');
  ok(/<strong>collaborator<\/strong>/.test(p2) && /read and write that repository/.test(p2),
    '"collaborator" is glossed where a member first meets it');
  ok(/branch is one line of history/.test(a1), '"branch" is glossed beside the branch field');
  ok(!/slug/i.test(p1), 'the word "slug" is gone from step 1');
  ok(!/slug/i.test(a1), '…and from the admin setup panel');
  ok(/Folder in the repo/.test(p1), '…replaced by what it actually is');
  ok(!/\(auto from brain name\)/.test(a1),
    'the folder field’s placeholder is no longer PROSE rendered in the monospace face');
  ok(/placeholder="spring-2026-ml-cohort"/.test(a1),
    '…it is an EXAMPLE of the literal that goes there, which is what monospace is for');
}
{
  const code = stripComments(wizard);
  ok(!/git ref name/.test(code), '"git ref name" never reaches a user');
  ok(/Branch name: use letters, digits/.test(code), '…the branch refusal says the rule in plain words');
  ok(/Folder name: use letters, digits/.test(code), '…and so does the folder refusal');
  ok(!/coming soon/i.test(code), 'and the wizard promises nothing that does not exist');
}
{
  // The credential discipline this file's own header claims.
  const code = stripComments(wizard);
  ok(!/localStorage|sessionStorage/.test(code), 'no wizard code touches browser storage');
  ok(!/console\.(log|warn|error|info)/.test(code), '…or writes anything to the console');
}

// ═════════════════════════════════════════════════════════════════════════
section('§11  The CSS: the ring that was photographed, and the clip budget');
// ═════════════════════════════════════════════════════════════════════════
{
  const css = stripComments(sharedCss);
  ok(/\.sbw-panel h3:focus[^{]*\{[^}]*outline:\s*none/.test(css),
    'the programmatically-focused heading draws no focus outline (photographed on admin step 2)');
  ok(/\.sbw-panel h3:focus[^{]*\{[^}]*box-shadow:\s*none/.test(css),
    '…and no ring shadow either, which is what the design system draws focus WITH');
  ok(/\.sbw-input:focus\s*\{[^}]*box-shadow:\s*var\(--ring-focus\)/.test(css),
    'CONTROL: the fields that ARE operable keep their ring — this is a heading exception, not a blanket removal');
  ok(/\.sbw-discard\b/.test(css) && /\.sbw-stepcount\b/.test(css),
    'the two new elements are styled rather than left to the browser');
}
{
  // THE CLIP CHECK, as a budget rather than a measurement. There is no
  // layout here; what CAN be asserted is that the sheet is bounded by the
  // viewport and scrolls its own overflow, which is what makes a tall panel
  // reachable at 900px. The render itself was checked in a browser.
  const css = stripComments(sharedCss);
  const card = /\.sbw-card\s*\{([^}]*)\}/.exec(css);
  ok(!!card, '.sbw-card is declared');
  ok(/max-height:\s*calc\(100vh - \d+px\)/.test(card[1]),
    '…bounded by the VIEWPORT, so it can never grow past the window it hangs from');
  ok(/overflow-y:\s*auto/.test(card[1]),
    '…and scrolls its own overflow, which is what puts a tall panel’s Continue in reach at 900px');
  const inset = /max-height:\s*calc\(100vh - (\d+)px\)/.exec(card[1]);
  ok(Number(inset[1]) >= 24 && 900 - Number(inset[1]) > 400,
    `…leaving ${900 - Number(inset[1])}px of scrollable sheet at a 900px viewport, and ${inset[1]}px of chrome inset`);
}

// ═════════════════════════════════════════════════════════════════════════
section('§12  The card: is the STORED token still good?');
// ═════════════════════════════════════════════════════════════════════════
const cardBox = new Function(
  'let state = { expandedAdmin: new Set() };\n' + ESCAPE + '\n' + ICON_STUB +
  ['classifyTokenCheck', 'tokenCheckApplies', 'renderTokenCheck']
    .map((n) => extractFunction(shared, n, 'shared.js')).join('\n\n') + '\n' +
  'return { classifyTokenCheck, tokenCheckApplies, renderTokenCheck };'
)();
{
  const c = cardBox.classifyTokenCheck;
  const good = c({ ok: true, memberCount: 3, repoLabel: 'org/cohort' });
  eq(good.kind, 'ok', 'a listing with contributors in it proves the token still works');
  ok(/3 contributor records/.test(good.message) && /org\/cohort/.test(good.message),
    '…and the message reports what it actually read');
  eq(c({ ok: true, memberCount: 1, repoLabel: 'org/cohort' }).message.includes('1 contributor record'), true,
    '…singular when there is one');

  const empty = c({ ok: true, memberCount: 0, repoLabel: 'org/cohort' });
  eq(empty.kind, 'unknown',
    'AN EMPTY LISTING IS NOT A PASS: GitHub answers 404 for a repo a token cannot see, and the adapter reads that as an empty tree');
  ok(/cannot/.test(empty.message) && /pushed/.test(empty.message),
    '…so it says what it cannot tell, and when the answer becomes conclusive');

  for (const err of [
    'listMembers: could not list contributions: GitHub GET tree:main → 401: Bad credentials',
    'SHARED_BRAIN_AUTH something',
    'GitHub GET tree:main → 403: forbidden',
    'SHARED_BRAIN_FORBIDDEN',
  ]) {
    eq(c({ ok: false, error: err, repoLabel: 'org/cohort' }).kind, 'rejected',
      `a rejection is recognised: ${err.slice(0, 42)}…`);
  }
  const rejected = c({ ok: false, error: '… → 401: Bad credentials', repoLabel: 'org/cohort' });
  ok(/EXPIRED/.test(rejected.message), 'the rejection names expiry, which is the likeliest cause and the one nobody is told about');
  ok(/Leave this Shared Brain/.test(rejected.message),
    '…and names a control that exists in this view, since the wizard is the only thing that takes a token');

  const off = c({ ok: false, error: 'fetch failed', repoLabel: 'org/cohort' });
  eq(off.kind, 'unreachable', 'a network failure is not a verdict on the token');
  ok(/failure of the CHECK/.test(off.message), '…and says so, rather than implying the token is bad');
}
{
  ok(cardBox.tokenCheckApplies({ storage_type: 'github' }), 'the check is offered for a GitHub-backed brain');
  ok(!cardBox.tokenCheckApplies({ storage_type: 'local' }),
    '…and not for a local-folder brain, which has no token to check');
  ok(!cardBox.tokenCheckApplies(null), '…and not for nothing at all');

  const html = cardBox.renderTokenCheck({ storage_type: 'github' }, { tokenChecking: false, tokenCheck: null });
  ok(/data-sb-action="token-check"/.test(html), 'the control renders with its action');
  ok(/expire on the date you chose/.test(html), '…and the hint states the expiry fact up front, before anything breaks');
  ok(/costs no AI credits/.test(html), '…and what it costs, because every other button on this card spends something');
  eq(cardBox.renderTokenCheck({ storage_type: 'local' }, {}), '',
    'and nothing at all renders for a brain that has no token');

  const busy = cardBox.renderTokenCheck({ storage_type: 'github' }, { tokenChecking: true, tokenCheck: null });
  ok(/disabled/.test(busy) && /Checking…/.test(busy), 'while checking, the button says so and cannot be pressed again');

  const withVerdict = cardBox.renderTokenCheck(
    { storage_type: 'github' },
    { tokenChecking: false, tokenCheck: { kind: 'rejected', message: 'SENTINEL-9f3c the token was rejected' } }
  );
  ok(/SENTINEL-9f3c/.test(withVerdict), 'the verdict’s own message reaches the markup — traced value to pixels');
  ok(/sb-token-check-rejected/.test(withVerdict), '…carrying its kind, which is what colours it');

  const hostile = cardBox.renderTokenCheck(
    { storage_type: 'github' },
    { tokenChecking: false, tokenCheck: { kind: 'ok', message: '<img src=x onerror=alert(1)>' } }
  );
  ok(!/<img/.test(hostile) && /&lt;img/.test(hostile), 'and it is escaped at the sink');
}
{
  const code = stripComments(shared);
  const handler = extractFunction(shared, 'onCheckStoredToken', 'shared.js');
  ok(/\/api\/sharedbrain\/' \+ connId \+ '\/members/.test(handler),
    'the check exercises the STORED credential through GET /:id/members');
  ok(!/validate-pat/.test(handler),
    '…and NOT through validate-pat, which needs a plaintext token this screen must never hold');
  ok(/tokenCheckApplies\(conn\)/.test(handler),
    'the affordance is re-checked at the ACTION, not only in the render');
  ok(/card\.tokenChecking/.test(handler), 'and re-entry is refused on its own flag');
  ok(!/card\.acting/.test(handler),
    '…while taking no part in the per-connection action lock: this reads, so it must not block a Push');
  // Pinned against the route.
  ok(/router\.get\('\/:id\/members'/.test(routes), 'control: that route exists and is a GET');
  ok(/The full PAT is NEVER returned/.test(routes),
    'control: …and the reason validate-pat is unusable here is the route file’s own stated rule');
  // The reading-position fix that makes the shown-once token survivable.
  ok(/preserveMainScroll\(\(\) => \{/.test(extractFunction(shared, 'render', 'shared.js')),
    'every render in this view goes through preserveMainScroll — one chokepoint, ~30 call sites');
  ok(/revealShownAdminToken\(connId\)/.test(extractFunction(shared, 'onRotateAdminToken', 'shared.js')),
    '…and the shown-once token is additionally scrolled into view, because "where you were" may be nowhere near it');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ Shared Brain wizard assertions failed');
  process.exit(1);
}
console.log('✅ All Shared Brain wizard assertions green');
