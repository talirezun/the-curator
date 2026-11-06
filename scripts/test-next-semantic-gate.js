/**
 * test-next-semantic-gate.js — OFFLINE guard on /next's semantic-duplicate
 * merge safety gate (src/public/next/views/domains.js).
 *
 * ── What is at stake ─────────────────────────────────────────────────────
 *
 * A semantic-duplicate merge DELETES a wiki page and rewrites every
 * [[wikilink]] pointing at it across the whole domain, on the strength of an
 * LLM's judgement about two pages being "the same thing".
 *
 * The shipping app gives that judgement two ways to be checked: a per-pair
 * path where Merge stays DISABLED until the comparison for that exact pair has
 * been on screen for 500 ms (and the handler refuses even if the button is
 * clicked anyway), and a batch "Merge all N high-confidence" behind a text
 * confirm. /next shipped only the batch path — so "merge all of them, sight
 * unseen" was the ONLY available action on a semantic duplicate. A
 * high-confidence pair pointing the wrong way (keep the stub, delete the
 * rich page) had no correction path, and a false positive came back on
 * every future scan forever.
 *
 * ── The two invariants this suite exists for ─────────────────────────────
 *
 * INVARIANT 1 — the previewed set is EMPTY after a new scan, after a domain
 * switch, and after a Flip. `state` in domains.js is module-scoped and
 * survives leaving the view, so a set that is never cleared can outlive the
 * scan it belongs to and authorise a merge on a DIFFERENT domain's pair.
 * It is defended twice and the layers are INDEPENDENT:
 *   LAYER 1 — the set lives inside state.semanticScan, which
 *     resetDomainScopedHealthState() nulls.
 *   LAYER 2 — the scan carries the slug it was scanned for, and
 *     activeSemanticScan() refuses it once that stamp stops matching.
 * §2 asserts LAYER 1 by reading the RAW stored set (rawPreviewedKeys), and
 * §3 asserts LAYER 2 separately. That separation is deliberate: two guards
 * that mask each other are two guards nobody is testing — v3.4.0 recorded
 * exactly that, where two mutations each stayed green because a second
 * layer covered them, and only pairing them went red.
 *
 * INVARIANT 2 — the batch runner derives its pair list from LIVE state at
 * click time, never from the array the scan returned. This is not a
 * nicety: the shipping app fixed this exact bug in a v3.0.1-beta.15 audit —
 * "a user's Flip / Skip / individual-Merge before clicking 'Merge all'
 * could merge the WRONG direction or re-merge a dismissed pair". Adding
 * Flip and Skip on top of a frozen array re-creates it. §5 drives it.
 *
 * ── Method ───────────────────────────────────────────────────────────────
 *
 * Functions are extracted from the real source (brace-matched, throwing on a
 * missing name) and executed via `new Function`, so these are BEHAVIOURAL
 * assertions about the shipped code paths — not regexes proving a line
 * exists. §7 carries negative controls proving the detectors can fail.
 *
 * ── NOT ENFORCED (stated rather than implied) ────────────────────────────
 *
 *   • No server, no HTTP. `fetchJSON`/`streamSSE` are stubbed; this pins the
 *     client's gate and request shapes, not the server's merge.
 *   • The server independently re-validates every pair
 *     (resolveSemanticDupePair in src/brain/health.js). This suite does not
 *     test that, and the client gate is not a substitute for it.
 *   • Nothing here asserts that the LLM's confidence judgement is correct —
 *     the whole point of the gate is that it might not be.
 */

import { readFileSync } from 'fs';
import path from 'path';
// v3.89.0: the fold items are the section kit's (real functions).
import { SECTION_KIT_NAMES, SECTION_KIT_VALUES } from './test-helpers/section-kit.js';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const SRC = path.join(REPO, 'src/public/next/views/domains.js');
const src = readFileSync(SRC, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(source);
  if (!m) throw new Error(`extractFunction: "${name}" not found in domains.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = source.indexOf('(', start);
  if (p === -1) throw new Error(`extractFunction: "${name}" has no parameter list`);
  let parenDepth = 0;
  for (; p < source.length; p++) {
    if (source[p] === '(') parenDepth++;
    else if (source[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = source.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = source.slice(start, i);
  if (extracted.includes('\n') && !/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

function extractConst(source, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} = [\\s\\S]*?;[ \\t]*(?://[^\\n]*)?\\n`);
  const m = re.exec(source);
  if (!m) throw new Error(`extractConst: "${name}" not found in domains.js`);
  return m[0].trim();
}

const FNS = [
  'semanticPairKey',
  'activeSemanticScan',
  'rawPreviewedKeys',
  'markSemanticPreviewed',
  'isSemanticPreviewed',
  'semanticListOf',
  'canMergeSemanticPair',
  'flipSemanticPair',
  'liveBatchPairs',
  'markSemanticPairStatus',
  'setSemanticPairMessage',
  // v3.53.0 — the chained-merge cascade. A semantic scan pairs EVERY
  // candidate, so a version family is a clique: merging one pair deletes a
  // page several sibling pairs still name. These three are what stops those
  // siblings sitting on screen as cards that can be neither previewed nor
  // merged. §10-§12 drive them.
  'resolvePairsTouching',
  'markSemanticPairResolved',
  'semanticStaleFromError',
  'renderCompareRow', 'renderDecisionLane', 'renderPlainRow', 'renderAnchorHere', 'renderAnchorStack', 'renderIssueFold', 'renderShowMore', 'renderDismissedGroup',
  'renderLaneHead', 'renderLaneTrace', 'mergeRowButton', 'deletesReading', 'deletedPageCount', 'activeSemanticQuote', 'n0', 'costReadout', 'formatUsd',
  'semanticCoverageFrom',
  'newSemanticScan',
  'syncSemanticScan',
  'countSemanticPairs',
  'armSemanticPair',
  // A real dependency of runSemanticScan and runMergeSemanticDuplicates,
  // not a convenience: both feed the Health progress ring from the SSE
  // frames they already read. Omitting it made the merge stream throw a
  // ReferenceError on its FIRST progress frame — which the handler's own
  // try/catch swallowed into an error banner, so §5g reported "merged pairs
  // are recorded" (frame 1 had already run) and only "skipped pairs are
  // recorded" (frame 2, never reached) went red. Worth reading twice: a
  // missing sandbox binding here does not crash, it silently truncates the
  // stream.
  'noteAiProgress',
  'toWirePair',
  'resetDomainScopedHealthState',
  'loadHealth',
  'selectDomain',
  'runSemanticScan',
  'previewSemanticPair',
  'mergeOneSemanticPair',
  'skipSemanticPair',
  'runMergeSemanticDuplicates',
  'mergeSemanticDuplicates',
  'totalOpenIssues',
  'classifyDomainError',
  'pluralize',
  // L1 fix (this session): extracted from the REAL source (not a hand-
  // rolled stub) so the `!res.ok` -> err.status/err.body fix is actually
  // exercised. The hand-rolled `streamSSE` stub this replaced always threw
  // whatever bare Error `net.nextReject` held, which could never have
  // caught the real bug (a bare `new Error(msg)` with neither field) —
  // it would have stayed green with the fix reverted. See the `fetch`
  // stub in PREAMBLE below, which is what the real streamSSE now calls.
  'streamSSE',
];
const CONSTS = ['HEALTH_CATEGORIES', 'GIT_UNDO_WARN'];

// Stubs for everything the extracted functions reach outside themselves.
// `net` records every request so the shapes can be asserted; `net.fail`
// makes the next call reject with a chosen error.
const PREAMBLE = `
let state = {};
let myMountToken = 1;
const compareAll = { acknowledge() {}, forgetQuote() {}, running() { return false; }, sync() {}, noteQuote() {}, afterPaint() {}, reading() { return null; }, actions(slug, next) { return next; }, line() { return ''; }, onClick() { return false; } };
function releaseArrivals() {}
const ISSUE_PAGE = 20;
const DESTRUCTIVE_FIX_TYPES = new Set(['crossFolderDupes', 'hyphenVariants']);
function buttonRingHtml() { return ''; }
function formatUsdHonest(v) { return '$' + v; }
function aiActionDisabledAttrs() { return ''; }
function renderConfirmCard() { return ''; }
function renderPendingPlan() { return ''; }
function renderOutcomeLine() { return ''; }
function gatedLoader() { return ''; }
const loadGate = null;
function describeDismissed(r) { return String(r.type); }
function renderIssueRow() { return ''; }
const inFlightWriteSlugs = new Set();
const net = { calls: [], nextReject: null, nextResult: null, sseFrames: [], nextFetchNotOk: null };
const gates = { opened: [], released: 0 };
function render() {}
function isCurrentMount(t) { return t === myMountToken; }
function reportAsyncActionFailure() {}
// v3.48.0: selectDomain also re-asks for the domain's PROJECTS (agent memory
// is kept per project inside a domain). Stubbed here because this suite is
// about the semantic-merge gate; the projects load has its own coverage in
// scripts/test-next-domain-projects.js.
function loadProjects() { return Promise.resolve(); }
// v3.49.0: and the domain's PAGE LIST — the wiki browser used to sit behind
// a "Browse pages" button and is now loaded with the domain. Stubbed for the
// same reason as loadProjects above; its own coverage is in
// scripts/test-next-domain-card-order.js.
function loadBrowse() { return Promise.resolve(); }
function beginDomainWrite(domain, label) { gates.opened.push({ domain, label }); return () => { gates.released++; }; }
function loadEstimates() { return Promise.resolve(); }
function escapeHtml(s) { return String(s == null ? '' : s); }
function icon() { return ''; }
// No DOM in this sandbox: the reveal helpers are asserted in §9 by source
// and proven for real in the browser (they are a scroll-position concern,
// which is not a thing a headless state machine can have).
function revealMessage() { return false; }
async function fetchJSON(url, opts) {
  net.calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
  if (net.nextReject) { const e = net.nextReject; net.nextReject = null; throw e; }
  const r = net.nextResult; net.nextResult = null;
  return r === null || r === undefined ? {} : r;
}
// L1 fix (this session): streamSSE itself is now extracted from the REAL
// source (see FNS above) rather than hand-stubbed, so this fakes the one
// thing IT calls — fetch — faithfully enough to exercise both of its exit
// paths: a pre-stream non-ok response (net.nextFetchNotOk — this is what
// a write-registry/file-lock 409 looks like: the route refuses BEFORE
// res.flushHeaders(), so the client never even sees a text/event-stream
// response) and a normal SSE body assembled from net.sseFrames. A thrown
// net.nextReject at the fetch() call site itself (network-level failure,
// e.g. the connection dropping) is also honoured for completeness, though
// no current section exercises it that way.
async function fetch(url, opts) {
  const parsedBody = (opts && opts.body) ? JSON.parse(opts.body) : null;
  net.calls.push({ url, sse: true, body: parsedBody });
  if (net.nextReject) { const e = net.nextReject; net.nextReject = null; throw e; }
  if (net.nextFetchNotOk) {
    const nf = net.nextFetchNotOk; net.nextFetchNotOk = null;
    return {
      ok: false,
      status: nf.status || 500,
      body: null,
      async json() {
        if (nf.body !== undefined) return nf.body;
        throw new Error('no json body');
      },
    };
  }
  const frames = net.sseFrames; net.sseFrames = [];
  let text = '';
  for (const f of frames) text += 'event: ' + f.type + '\\n' + 'data: ' + JSON.stringify(f) + '\\n\\n';
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          cancel() { return Promise.resolve(); },
        };
      },
    },
  };
}
`;

let sandbox;
try {
  sandbox = new Function(
    ...SECTION_KIT_NAMES,
    PREAMBLE +
    CONSTS.map((c) => extractConst(src, c)).join('\n') + '\n' +
    FNS.map((n) => extractFunction(src, n)).join('\n\n') + '\n' +
    `return { ${FNS.join(', ')},
       __state: () => state, __setState: (s) => { state = s; },
       __net: () => net, __gates: () => gates,
       __setMount: (t) => { myMountToken = t; },
       __inFlight: () => inFlightWriteSlugs };`
  )(...SECTION_KIT_VALUES);
} catch (err) {
  console.log('FATAL: could not build the sandbox from domains.js — ' + err.message);
  process.exit(1);
}

const {
  semanticPairKey, activeSemanticScan, rawPreviewedKeys, markSemanticPreviewed,
  isSemanticPreviewed, canMergeSemanticPair, flipSemanticPair, liveBatchPairs,
  markSemanticPairStatus, toWirePair, loadHealth, selectDomain, runSemanticScan,
  previewSemanticPair, mergeOneSemanticPair, skipSemanticPair, runMergeSemanticDuplicates,
  mergeSemanticDuplicates,
  resolvePairsTouching, markSemanticPairResolved, semanticStaleFromError,
  armSemanticPair, renderCompareRow, renderDecisionLane, syncSemanticScan, newSemanticScan,
  __state, __setState, __net, __gates, __setMount,
} = sandbox;

function pair(over) {
  return Object.assign({
    keepFolder: 'entities', keepSlug: 'openai',
    removeFolder: 'concepts', removeSlug: 'open-ai',
    confidence: 'high', rationale: 'same company', status: 'open', spellingVariant: true,
  }, over || {});
}

function stateWithScan(slug, pairs, previewed) {
  return {
    loaded: true,
    domains: [{ slug: 'alpha', displayName: 'Alpha', pageCount: 3 }, { slug: 'beta', displayName: 'Beta', pageCount: 1 }],
    readonlySet: new Set(),
    activeSlug: slug,
    health: { counts: { entities: 1, concepts: 1, summaries: 0, dismissed: 0 }, brokenLinks: [], orphans: [], crossFolderDupes: [], hyphenVariants: [], folderPrefixLinks: [], missingBacklinks: [] },
    healthLoading: false, healthError: null, healthSummary: {},
    aiAvailable: false, estimates: {},
    expandedGroups: new Set(), dismissedRecords: null,
    confirm: null, busyKey: null, banner: null, pendingPlan: null,
    semanticScan: {
      slug,
      pairs: pairs.slice(),
      cost: null,
      previewed: new Set(previewed || []),
      preview: null,
    },
    lifecycle: null, browse: null,
  };
}

console.log('\n=== 1. Pair identity and the domain stamp ===');
__setState(stateWithScan('alpha', [pair()]));
ok(semanticPairKey(pair()) === 'entities/openai||concepts/open-ai', 'the key names keep and remove sides in order');
ok(semanticPairKey(pair()) !== semanticPairKey(pair({ keepFolder: 'concepts', keepSlug: 'open-ai', removeFolder: 'entities', removeSlug: 'openai' })),
   'the key is DIRECTION-SENSITIVE — a flipped pair is not the same pair');
ok(activeSemanticScan() !== null, 'a scan whose stamp matches the active domain is reachable');
__state().activeSlug = 'beta';
ok(activeSemanticScan() === null, 'the same scan becomes UNREACHABLE the moment the active domain differs');
ok(__state().semanticScan !== null, '…while the object itself is still there — proving the accessor, not the clearing, did this');

console.log('\n=== 2. INVARIANT 1 (LAYER 1): the previewed set is EMPTY after… ===');

// 2a. …a new scan. Structural: a scan builds a NEW object with a NEW Set,
// so there is no previous set to forget to clear.
__setState(stateWithScan('alpha', [pair()], ['entities/openai||concepts/open-ai']));
ok(rawPreviewedKeys().length === 1, 'precondition: a previewed key is stored');
__net().sseFrames = [{ type: 'done', pairs: [{ keepFolder: 'entities', keepSlug: 'openai', removeFolder: 'concepts', removeSlug: 'open-ai', confidence: 'high', rationale: 'r' }], cost: { inputTokens: 1, outputTokens: 1 } }];
await runSemanticScan('alpha');
ok(rawPreviewedKeys().length === 0,
   '2a: after a NEW SCAN the previewed set is EMPTY (raw read, not "some later check refuses")');
ok(__state().semanticScan.pairs.length === 1 && __state().semanticScan.slug === 'alpha', '2a: the new scan is stamped with the domain it scanned');
ok(__state().semanticScan.pairs[0].status === 'open', '2a: scanned pairs start open');

// 2b. …a domain switch. Driven through the REAL selectDomain -> loadHealth
// path, not by calling the reset helper directly.
__setState(stateWithScan('alpha', [pair()], ['entities/openai||concepts/open-ai']));
ok(rawPreviewedKeys().length === 1, 'precondition: a previewed key is stored for alpha');
__net().nextResult = { counts: { entities: 0, concepts: 0, summaries: 0, dismissed: 0 }, brokenLinks: [], orphans: [], crossFolderDupes: [], hyphenVariants: [], folderPrefixLinks: [], missingBacklinks: [] };
selectDomain('beta');
await new Promise((r) => setTimeout(r, 0));
ok(__state().semanticScan === null, '2b: after a DOMAIN SWITCH the whole scan object is gone');
ok(rawPreviewedKeys().length === 0, '2b: …so the previewed set is EMPTY (raw read)');

// 2c. …a Flip.
__setState(stateWithScan('alpha', [pair(), pair({ keepSlug: 'rag', removeSlug: 'r-a-g' })],
  ['entities/openai||concepts/open-ai', 'entities/rag||concepts/r-a-g']));
ok(rawPreviewedKeys().length === 2, 'precondition: two previewed keys are stored');
flipSemanticPair(__state().semanticScan.pairs[0]);
ok(rawPreviewedKeys().length === 0,
   '2c: after a FLIP the previewed set is EMPTY — fail-closed, and not dependent on the key derivation changing');
ok(__state().semanticScan.pairs[0].keepSlug === 'open-ai' && __state().semanticScan.pairs[0].removeSlug === 'openai',
   '2c: the flip actually swapped which side survives');
ok(__state().semanticScan.preview === null, '2c: any open preview is dropped with it');
ok(__state().semanticScan.pairs[0].confidence === 'high' && __state().semanticScan.pairs[0].status === 'open',
   '2c: confidence and status are preserved across a flip');

// 2d. …a status change (merged/skipped), asserted INDEPENDENTLY of
// canMergeSemanticPair's `status !== 'open'` gate. markSemanticPairStatus
// deletes the pair's previewed key as defense-in-depth — without it, a
// merged-then-flipped-back-to-open pair (not a reachable UI flow today, but
// nothing in the data shape forbids it) would still read as previewed from
// a stale preview of the OLD direction. That line has no independent
// coverage of its own — canMergeSemanticPair's status check alone already
// refuses a non-open pair, so a suite that only asserts THROUGH the gate
// cannot tell whether this line is doing anything. rawPreviewedKeys() is
// the same raw-read escape hatch §2a-§2c use to test LAYER 1 on its own.
__setState(stateWithScan('alpha', [pair()], ['entities/openai||concepts/open-ai']));
ok(rawPreviewedKeys().length === 1, 'precondition: the pair is previewed');
markSemanticPairStatus(__state().semanticScan.pairs[0], 'merged');
ok(rawPreviewedKeys().length === 0,
   '2d: marking a pair merged/skipped clears ITS previewed key too (raw read — not routed through canMergeSemanticPair)');

console.log('\n=== 3. INVARIANT 1 (LAYER 2): the gate refuses, independently ===');
__setState(stateWithScan('alpha', [pair()], ['entities/openai||concepts/open-ai']));
ok(canMergeSemanticPair(__state().semanticScan.pairs[0]).allowed === true, 'a previewed, open pair on the active domain is allowed');
// Now make the stamp stale WITHOUT clearing anything — this is exactly the
// state layer 1 is supposed to prevent, and layer 2 must catch it anyway.
__state().activeSlug = 'beta';
const crossDomain = canMergeSemanticPair(__state().semanticScan.pairs[0]);
ok(crossDomain.allowed === false, 'LAYER 2: a scan stamped for another domain cannot authorise a merge');
ok(/different domain/.test(crossDomain.reason), '…and the refusal says why');
ok(rawPreviewedKeys().length === 1,
   'the raw set still holds its key here — so this assertion is genuinely testing LAYER 2, not layer 1 in disguise');

console.log('\n=== 4. The gate blocks everything it should ===');
__setState(stateWithScan('alpha', [pair()]));
let g = canMergeSemanticPair(__state().semanticScan.pairs[0]);
ok(g.allowed === false && /comparison/i.test(g.reason), 'not yet seen: refused, and told to read the comparison first');
markSemanticPreviewed(__state().semanticScan.pairs[0]);
ok(canMergeSemanticPair(__state().semanticScan.pairs[0]).allowed === true, 'previewed: allowed');
markSemanticPairStatus(__state().semanticScan.pairs[0], 'merged');
g = canMergeSemanticPair(__state().semanticScan.pairs[0]);
ok(g.allowed === false && /already been handled/.test(g.reason), 'an already-merged pair cannot be merged twice');
__setState(stateWithScan('alpha', [pair()]));
g = canMergeSemanticPair(pair({ keepSlug: 'ghost' }));
ok(g.allowed === false && /no longer part/.test(g.reason), 'a pair that is not in the current scan is refused');
__setState(stateWithScan('alpha', [pair()], ['entities/openai||concepts/open-ai']));
__state().semanticScan = null;
ok(canMergeSemanticPair(pair()).allowed === false, 'with no scan at all, nothing is mergeable');

console.log('\n=== 4b. Fetching is not seeing, and only a SUCCESSFUL comparison can open the gate ===');
__setState(stateWithScan('alpha', [pair()]));
ok(armSemanticPair(__state().semanticScan.pairs[0]) === false, 'with no comparison held, nothing can arm the gate');
__net().nextResult = { ok: true, basis: 'b-1', keepPath: 'entities/openai.md', removePath: 'concepts/open-ai.md', totalLinksRewritten: 3, affectedCount: 2, affectedFiles: [], mergedPreview: 'x', mergedLength: 1 };
const fetched = await previewSemanticPair('alpha', __state().semanticScan.pairs[0]);
ok(!!fetched.data, 'the comparison comes back to its caller');
ok(isSemanticPreviewed(__state().semanticScan.pairs[0]) === false, 'THE TRIGGER MOVED: a comparison that has only been fetched does NOT open the gate');
ok(canMergeSemanticPair(__state().semanticScan.pairs[0]).allowed === false, '…so Merge is still refused');
ok(__state().semanticScan.preview && __state().semanticScan.preview.data, 'the comparison is held for the desk');
ok(__state().semanticScan.bases[semanticPairKey(__state().semanticScan.pairs[0])] === 'b-1', 'its basis is held for this exact direction');
ok(armSemanticPair(__state().semanticScan.pairs[0]) === true && canMergeSemanticPair(__state().semanticScan.pairs[0]).allowed === true, 'seen: the desk arms it, and the gate opens');
ok(__net().calls.some((c) => /semantic-dupes\/preview$/.test(c.url) && c.body && c.body.issue),
   'the comparison POSTs { issue } to /semantic-dupes/preview');
ok(__net().calls.slice(-1)[0].body.issue.status === undefined,
   'the wire pair carries no view-local `status` field');

// A comparison held for the other direction arms nothing.
__setState(stateWithScan('alpha', [pair()]));
__net().nextResult = { ok: true, basis: 'b-1' };
await previewSemanticPair('alpha', __state().semanticScan.pairs[0]);
flipSemanticPair(__state().semanticScan.pairs[0]);
ok(armSemanticPair(__state().semanticScan.pairs[0]) === false, 'after a flip the comparison held is not this direction\'s: it arms nothing');
__setState(stateWithScan('alpha', [pair()]));
__net().nextResult = { ok: true, basis: 'b-1' };
const inFlight = __state().semanticScan.pairs[0];
const waiting = previewSemanticPair('alpha', inFlight);
flipSemanticPair(__state().semanticScan.pairs[0]);
const answered = await waiting;
ok(answered.stale === true && __state().semanticScan.preview === null, 'a comparison that lands after a flip is dropped, never shown as this direction\'s');

__setState(stateWithScan('alpha', [pair()]));
__net().nextReject = new Error('preview blew up');
const failedCompare = await previewSemanticPair('alpha', __state().semanticScan.pairs[0]);
ok(failedCompare.error === 'preview blew up', 'a failed comparison answers with its own message');
ok(armSemanticPair(__state().semanticScan.pairs[0]) === false, 'a FAILED comparison cannot arm the gate, however long passes');
ok(isSemanticPreviewed(__state().semanticScan.pairs[0]) === false && canMergeSemanticPair(__state().semanticScan.pairs[0]).allowed === false, '…and Merge stays refused');

console.log('\n=== 4c. Merge re-checks the gate at EXECUTION time ===');
// A disabled button is an affordance. This is the guard.
__setState(stateWithScan('alpha', [pair()]));           // deliberately NOT previewed
__net().calls.length = 0;
await mergeOneSemanticPair('alpha', __state().semanticScan.pairs[0]);
ok(__net().calls.length === 0, 'an un-previewed pair NEVER reaches the network, even when the function is called directly');
ok(!!(__state().semanticScan && __state().semanticScan.pairs[0].refusal && /comparison/i.test(__state().semanticScan.pairs[0].refusal)),
   '…and the refusal is written onto that pair so the user is told why');
ok(!!(__state().semanticScan && __state().semanticScan.pairs[0].status === 'open'), '…and nothing about the pair changed');

// The happy path, for contrast — proving the guard can also say yes.
__setState(stateWithScan('alpha', [pair()], ['entities/openai||concepts/open-ai']));
__net().calls.length = 0;
__net().nextResult = { ok: true, fixed: true };
await mergeOneSemanticPair('alpha', __state().semanticScan.pairs[0]);
const mergeCall = __net().calls.find((c) => /\/fix$/.test(c.url));
ok(!!mergeCall, 'a previewed pair DOES reach POST /api/health/:domain/fix (positive control)');
ok(!!(mergeCall && mergeCall.body.type === 'semanticDupe'), '…with type semanticDupe');
ok(!!(__state().semanticScan && __state().semanticScan.pairs[0].status === 'merged'), '…and the pair is recorded as merged');
ok(__gates().opened.some((x) => x.domain === 'alpha') && __gates().released > 0,
   'the per-pair merge takes and releases the shell-wide write gate');
ok(__net().calls.some((c) => /\/api\/health\/alpha$/.test(c.url)),
   'health is refreshed afterwards');
ok(__state().semanticScan !== null,
   'the scan SURVIVES a per-pair merge — wiping it would force a paid re-scan to reach pair 2 of 8');

__setState(stateWithScan('alpha', [pair()], ['entities/openai||concepts/open-ai']));
__state().semanticScan.bases = { 'entities/openai||concepts/open-ai': 'basis-of-this-way-round', 'concepts/open-ai||entities/openai': 'basis-of-the-other-way' };
__net().calls.length = 0;
__net().nextResult = { ok: true, fixed: 1 };
let settledWith = null;
await mergeOneSemanticPair('alpha', __state().semanticScan.pairs[0], (o) => { settledWith = o; });
ok(__net().calls.find((c) => /\/fix$/.test(c.url)).body.basis === 'basis-of-this-way-round', 'the merge carries the basis of THIS direction');
ok(settledWith && settledWith.merged === true && settledWith.alsoResolved === 0, 'and tells the desk, with what else it settled');
for (const code of ['MERGE_BASIS_STALE', 'MERGE_BASIS_MISSING']) {
  __setState(stateWithScan('alpha', [pair()], ['entities/openai||concepts/open-ai']));
  __net().nextReject = Object.assign(new Error('changed'), { status: 409, body: { code, fixed: 0 } });
  let said = null;
  await mergeOneSemanticPair('alpha', __state().semanticScan.pairs[0], (o) => { said = o; });
  ok(said && said.stale === true && __state().semanticScan.pairs[0].status === 'open', code + ': the desk is told the comparison is out of date, and the pair stays');
}

console.log('\n=== 4d. A 409 on a per-pair merge is a visible refusal ===');
__setState(stateWithScan('alpha', [pair()], ['entities/openai||concepts/open-ai']));
__net().nextReject = Object.assign(new Error('Cannot fix an issue in domain "alpha" while a write operation is running: alpha (ingest).'),
  { status: 409, body: { conflict: 'write_in_progress' } });
await mergeOneSemanticPair('alpha', __state().semanticScan.pairs[0]);
const refused = (__state().semanticScan && __state().semanticScan.pairs[0]) || {};
ok(typeof refused.refusal === 'string' && /Cannot fix an issue/.test(refused.refusal),
   'the server’s own 409 sentence is attached to the pair the user clicked');
ok(!refused.error, 'a refusal is not ALSO reported as a generic error');
ok(refused.status === 'open', 'a refused merge leaves the pair untouched and retryable');
ok(__gates().released > 0, 'the write gate is released even when the merge is refused');

console.log('\n=== 5. INVARIANT 2: the batch derives from LIVE state at click time ===');
const p1 = pair({ keepSlug: 'a', removeSlug: 'b' });
const p2 = pair({ keepSlug: 'c', removeSlug: 'd' });
const p3 = pair({ keepSlug: 'e', removeSlug: 'f', confidence: 'medium' });

// 5a. baseline
__setState(stateWithScan('alpha', [p1, p2, p3]));
ok(liveBatchPairs().length === 2, '5a: only high-confidence pairs are batch-eligible (medium is not)');
__setState(stateWithScan('alpha', [p1, pair({ keepSlug: 'g', removeSlug: 'h', spellingVariant: false })]));
ok(liveBatchPairs().length === 1, '5a2: a high-confidence pair whose names differ is NOT batch-eligible');

// 5b. a FLIP before the batch must change the direction that gets merged
__setState(stateWithScan('alpha', [p1, p2]));
flipSemanticPair(__state().semanticScan.pairs[0]);
let live = liveBatchPairs();
ok(live[0].keepSlug === 'b' && live[0].removeSlug === 'a',
   '5b: after a Flip the batch list carries the FLIPPED direction — merging the pre-flip direction deletes the page the user chose to keep');

// 5c. a SKIP before the batch must exclude the pair
__setState(stateWithScan('alpha', [p1, p2]));
markSemanticPairStatus(__state().semanticScan.pairs[1], 'skipped');
live = liveBatchPairs();
ok(live.length === 1 && live[0].keepSlug === 'a', '5c: a skipped pair is excluded from the batch');

// 5d. an already-merged pair must not be re-attempted
__setState(stateWithScan('alpha', [p1, p2]));
markSemanticPairStatus(__state().semanticScan.pairs[0], 'merged');
ok(liveBatchPairs().length === 1, '5d: an already-merged pair is excluded from the batch');

// 5e. END-TO-END: open the confirm, THEN flip, THEN confirm. This is the
// reported v3.0.1-beta.15 sequence, and the reason `run` takes no captured
// pair list.
__setState(stateWithScan('alpha', [p1, p2]));
mergeSemanticDuplicates('alpha');
ok(__state().confirm !== null, '5e: the confirm dialog opened');
flipSemanticPair(__state().semanticScan.pairs[0]);   // user flips while the confirm is on screen
markSemanticPairStatus(__state().semanticScan.pairs[1], 'skipped'); // …and skips the other
__net().calls.length = 0;
__net().sseFrames = [{ type: 'done', merged: 1, total: 1 }];
const run = __state().confirm.run;
__state().confirm = null;
await run();
const batchCall = __net().calls.find((c) => /merge-batch$/.test(c.url));
ok(!!batchCall, '5e: the batch ran');
ok(batchCall.body.pairs.length === 1, '5e: the SKIPPED pair was not sent — it was excluded at confirm time, not scan time');
ok(batchCall.body.pairs[0].keepSlug === 'b' && batchCall.body.pairs[0].removeSlug === 'a',
   '5e: the FLIPPED direction was sent — the pre-flip direction would have deleted the wrong page');
ok(batchCall.body.pairs[0].status === undefined, '5e: no view-local status leaks onto the wire');

// 5f. everything handled between confirm and click → refuse, do not POST an
// empty batch.
__setState(stateWithScan('alpha', [p1]));
mergeSemanticDuplicates('alpha');
markSemanticPairStatus(__state().semanticScan.pairs[0], 'skipped');
__net().calls.length = 0;
const run2 = __state().confirm.run;
__state().confirm = null;
await run2();
ok(__net().calls.length === 0, '5f: with nothing left to merge, no request is made at all');
ok(__state().rowNote && /Nothing left to merge/.test(__state().rowNote.text), '5f: …and the user is told why nothing happened');

// 5g. the batch records per-pair outcomes instead of discarding the scan
__setState(stateWithScan('alpha', [p1, p2, p3]));
__net().sseFrames = [
  { type: 'progress', pair: { keepFolder: 'entities', keepSlug: 'a', removeFolder: 'concepts', removeSlug: 'b' }, status: 'merged' },
  { type: 'progress', pair: { keepFolder: 'entities', keepSlug: 'c', removeFolder: 'concepts', removeSlug: 'd' }, status: 'skipped' },
  { type: 'done', merged: 1, skipped: 1, total: 2 },
];
await runMergeSemanticDuplicates('alpha');
ok(__state().semanticScan !== null,
   '5g: the scan survives the batch — the medium-confidence pair it never touched still needs reviewing, and only a paid LLM pass can produce it again');
ok(!!(__state().semanticScan && __state().semanticScan.pairs.find((p) => p.keepSlug === 'a').status === 'merged'), '5g: merged pairs are recorded as merged');
ok(!!(__state().semanticScan && __state().semanticScan.pairs.find((p) => p.keepSlug === 'c').status === 'skipped'), '5g: skipped pairs are recorded as skipped');
ok(!!(__state().semanticScan && __state().semanticScan.pairs.find((p) => p.keepSlug === 'e').status === 'open'), '5g: the untouched medium pair is still open');

// 5h. L1 fix: a write-registry/file-lock 409 on the BATCH endpoint is a
// visible REFUSAL, not a generic error banner. This is the case verified
// live in the audit — the server refuses BEFORE it ever starts the SSE
// stream (routes/health.js's isUpdateInProgress()/registerWrite() checks
// run ahead of res.setHeader('Content-Type', 'text/event-stream')), which
// is exactly the streamSSE `!res.ok` exit path this suite's `fetch` stub
// now exercises faithfully (see the PREAMBLE comment above the fetch stub).
__setState(stateWithScan('alpha', [p1]));
__net().nextFetchNotOk = {
  status: 409,
  body: { error: 'Cannot batch-merge duplicates in "alpha" while a write operation is running: alpha (sync).', conflict: 'write_in_progress' },
};
await runMergeSemanticDuplicates('alpha');
ok(__state().rowNote && __state().rowNote.tone === 'error', '5h: a banner was rendered');
ok(!!(__state().rowNote && /Cannot batch-merge duplicates/.test(__state().rowNote.text)),
   '5h: the server’s own 409 sentence reaches the banner verbatim — the refusal branch of classifyDomainError fired');
ok(!(__state().rowNote && /^Could not merge duplicates —/.test(__state().rowNote.text)),
   '5h: …and NOT the generic "Could not merge duplicates —" error-branch wording, which is what shipped before the fix');
ok(__gates().released > 0, '5h: the write gate is released even when the batch is refused');
ok(!!(__state().semanticScan && __state().semanticScan.pairs[0].status === 'open'),
   '5h: a refused batch leaves every pair untouched and retryable');

console.log('\n=== 6. Skip persists the dismissal in the shape the store expects ===');
__setState(stateWithScan('alpha', [pair()]));
__net().calls.length = 0;
__net().nextResult = { ok: true };
await skipSemanticPair('alpha', __state().semanticScan.pairs[0]);
const dismissCall = __net().calls.find((c) => /\/dismiss$/.test(c.url));
ok(!!dismissCall, 'Skip POSTs to /api/health/:domain/dismiss');
ok(dismissCall.body.type === 'semanticDupe', '…with type semanticDupe');
ok(dismissCall.body.issue.slugA === 'openai' && dismissCall.body.issue.folderA === 'entities' &&
   dismissCall.body.issue.slugB === 'open-ai' && dismissCall.body.issue.folderB === 'concepts',
   '…and the slugA/folderA/slugB/folderB shape health-dismissed.js keys on');
ok(!!(__state().semanticScan && __state().semanticScan.pairs[0].status === 'skipped'), 'the pair is marked skipped locally');
ok(__state().semanticScan !== null, 'the rest of the scan survives a skip');

console.log('\n=== 7. Negative controls — these detectors CAN fail ===');
// If any of these went the other way, the assertions above would be
// vacuous. Twelve recorded instances of this project's named failure shape
// began as a green test that had stopped reaching what it protected.
__setState(stateWithScan('alpha', [pair()], ['entities/openai||concepts/open-ai']));
ok(rawPreviewedKeys().length === 1, 'rawPreviewedKeys reports a NON-empty set when one exists (so "empty" above means something)');
ok(canMergeSemanticPair(__state().semanticScan.pairs[0]).allowed === true, 'the gate reports allowed=true when it should (so allowed=false above means something)');
__setState(stateWithScan('alpha', [p1, p2]));
ok(liveBatchPairs().length === 2, 'liveBatchPairs returns pairs when there are pairs (so an empty result above means something)');
// And the flip detector must not "pass" on an unflipped pair.
ok(liveBatchPairs()[0].keepSlug === 'a',
   'an UNflipped pair keeps its original direction — the 5b assertion is detecting the flip, not a constant');

console.log('\n=== 8. Structure that keeps the invariants from drifting back ===');
const scanSrc = extractFunction(src, 'newSemanticScan');
ok(/previewed: new Set\(\)/.test(scanSrc),
   'a new scan builds a NEW previewed Set inside the scan object — structural, so it cannot inherit an old one');
ok(/slug,/.test(scanSrc), 'a new scan records the slug it was scanned for');
const confirmSrc = extractFunction(src, 'mergeSemanticDuplicates');
ok(/run: \(\) => runMergeSemanticDuplicates\(slug\),/.test(confirmSrc),
   'the confirm passes NO pair list — capturing one is the v3.0.1-beta.15 bug');
const batchSrc = extractFunction(src, 'runMergeSemanticDuplicates');
ok(/liveBatchPairs\(\)\.map\(toWirePair\)/.test(batchSrc), 'the batch derives its list inside itself, at execution');
ok(!/state\.semanticScan\.pairs\.filter/.test(batchSrc), 'the batch never reads the raw pairs array directly');
// Every reader/writer of the previewed set must go through the accessor.
for (const fn of ['markSemanticPreviewed', 'isSemanticPreviewed', 'canMergeSemanticPair', 'flipSemanticPair', 'liveBatchPairs', 'markSemanticPairStatus', 'setSemanticPairMessage']) {
  ok(/activeSemanticScan\(\)/.test(extractFunction(src, fn)),
     `${fn} reaches the scan ONLY through activeSemanticScan() (LAYER 2 cannot be bypassed)`);
}
// rawPreviewedKeys is the deliberate exception — it exists to see PAST
// layer 2 so layer 1 can be asserted on its own.
ok(!/activeSemanticScan\(\)/.test(extractFunction(src, 'rawPreviewedKeys')),
   'rawPreviewedKeys deliberately bypasses the accessor — that is what makes the LAYER 1 assertions independent');
// Run, not read. A domain switch clears the list; a quiet reading of the same domain
// keeps the paid list but RE-ARMS the gate, because a repair may have changed the very
// pages a preview showed (the press rule; a quiet reading used to clear it and fetch
// it back, taking a whole card out from above the row just pressed).
{
  const st = { estimates: {}, semanticScan: null, activeSlug: 'a', pendingPlan: null, dismissedRecords: [] };
  const resetFn = new Function('state', extractFunction(src, 'resetDomainScopedHealthState') + '\nreturn resetDomainScopedHealthState;')(st);
  const armed = () => ({ slug: 'a', pairs: [], previewed: new Set(['x']), preview: { key: 'x' } });
  st.semanticScan = armed(); resetFn();
  ok(st.semanticScan === null, 'the scan is cleared by default');
  st.semanticScan = armed(); resetFn({ keepSemanticScan: true });
  ok(st.semanticScan && st.semanticScan.previewed.size === 1, 'an explicit opt-in (the merge paths) keeps it as it was');
  st.semanticScan = armed(); resetFn({ silent: true });
  ok(st.semanticScan && st.semanticScan.previewed.size === 0 && st.semanticScan.preview === null, 'a quiet reading keeps the list and empties the previewed set: Merge is disabled until previewed again');
  st.semanticScan = armed(); resetFn({ keepHealth: true });
  ok(st.semanticScan && st.semanticScan.previewed.size === 0, 'a rescan behind a kept report does the same');
  st.semanticScan = { ...armed(), slug: 'other' }; resetFn({ silent: true });
  ok(st.semanticScan === null, 'and another domain\'s list is never kept, quiet or not');
}
const perPairKeeps = extractFunction(src, 'mergeOneSemanticPair') + extractFunction(src, 'skipSemanticPair');
ok((perPairKeeps.match(/keepSemanticScan: true/g) || []).length === 2,
   'exactly the two per-pair actions opt into keeping the scan');
ok(!/keepSemanticScan/.test(extractFunction(src, 'selectDomain')), 'a domain switch never opts in');
ok(!/keepSemanticScan/.test(extractFunction(src, 'repairAllFree')), 'an ordinary fix never opts in');

console.log('\n=== 9. A rendered refusal must also be VISIBLE ===');
const revealSrc = extractFunction(src, 'revealMessage');
ok(/if \(r\.top >= 0 && r\.bottom <= window\.innerHeight\) return false;/.test(revealSrc),
   'revealMessage is a NO-OP when the message is already fully in view — it must not yank the page under someone who can already read it');
ok(/typeof el\.scrollIntoView === 'function'/.test(revealSrc), 'it degrades safely if scrollIntoView is unavailable');
for (const fn of ['runCreateDomain', 'runRenameDomain', 'runDeleteDomain']) {
  ok(/revealMessage\('\.dm-lc-refusal, \.dm-lc-error'\)/.test(extractFunction(src, fn)),
     fn + ' reveals its refusal/error too');
}

console.log('\n=== 10. CHAINED MERGES: one merge resolves the pairs that share its page ===');
// THE REPORTED DEFECT. findSemanticCandidatePairs emits EVERY pair above
// threshold, so a family of near-identical pages is a dense CLIQUE — 8
// versions produce 28 pairs and every page is in 7 of them. Merging one pair
// DELETES a page that several sibling pairs still name, and those stayed on
// screen as ordinary action cards: Preview failed ("Both pages must exist"),
// Merge stayed gated behind "Preview required before Merge", and the only way
// out was to re-run a PAID scan.
function family() {
  return [
    pair({ keepFolder: 'entities', keepSlug: 'a3', removeFolder: 'entities', removeSlug: 'a2' }),   // merged first
    pair({ keepFolder: 'entities', keepSlug: 'a',  removeFolder: 'entities', removeSlug: 'a2' }),   // names a2 on REMOVE
    pair({ keepFolder: 'entities', keepSlug: 'a2', removeFolder: 'entities', removeSlug: 'a4' }),   // names a2 on KEEP
    pair({ keepFolder: 'entities', keepSlug: 'z',  removeFolder: 'entities', removeSlug: 'z2' }),   // unrelated control
  ];
}
const KEY_1 = 'entities/a3||entities/a2';

// 10a. the single-pair path
__setState(stateWithScan('alpha', family(), [KEY_1]));
__net().nextResult = { ok: true, fixed: 1 };
await mergeOneSemanticPair('alpha', __state().semanticScan.pairs[0]);
let ps = __state().semanticScan.pairs;
ok(ps[0].status === 'merged', '10a: the merged pair is recorded as merged');
ok(ps[1].status === 'resolved',
   '10a: THE FIX — a sibling naming the deleted page on its REMOVE side is RESOLVED, not left as an unmergeable card');
ok(ps[2].status === 'resolved', '10a: …and so is the sibling naming it on its KEEP side');
ok(ps[3].status === 'open', '10a: NEGATIVE CONTROL — an unrelated pair is untouched and still actionable');
ok(/a2 was merged into a3/.test(ps[1].resolvedBy || ''),
   '10a: the resolved pair carries the sentence that explains it');
ok(ps[1].resolvedMissing === 'entities/a2', '10a: …and the page that went');
ok(__state().semanticScan !== null, '10a: the paid pair list is NOT dropped to achieve this');

// 10b. the gate speaks for a resolved pair
let gr = canMergeSemanticPair(__state().semanticScan.pairs[1]);
ok(gr.allowed === false, '10b: a resolved pair cannot be merged');
ok(/Already resolved by an earlier merge/.test(gr.reason) && /a2/.test(gr.reason),
   '10b: …and the refusal names the page, instead of the generic "already been handled"');
ok(canMergeSemanticPair(__state().semanticScan.pairs[3]).allowed === false &&
   /comparison/i.test(canMergeSemanticPair(__state().semanticScan.pairs[3]).reason),
   '10b: NEGATIVE CONTROL — the untouched pair still gets the ordinary refusal, not the resolved one');

// 10c. DEFENCE IN DEPTH — a page deleted OUTSIDE this session (Obsidian, the
// MCP, another Health fix) is first noticed by a failing preview.
__setState(stateWithScan('alpha', family()));
__net().nextReject = new Error('entities/a2 no longer exists — it was probably merged into another page earlier in this session, so this pair is already resolved.');
await previewSemanticPair('alpha', __state().semanticScan.pairs[1]);
ps = __state().semanticScan.pairs;
ok(ps[1].status === 'resolved',
   '10c: a preview refused with the `no longer exists` marker RESOLVES the pair instead of leaving a red card with a gated Merge button');
ok(ps[1].resolvedMissing === 'entities/a2', '10c: …and takes the page name from the server’s own message');
ok(ps[0].status === 'resolved' && ps[2].status === 'resolved',
   '10c: …and cascades to every other pair naming that page');
ok(ps[3].status === 'open', '10c: NEGATIVE CONTROL — the unrelated pair is still open');
ok(!(__state().semanticScan.preview && __state().semanticScan.preview.error),
   '10c: no "Could not build a preview" error is rendered for a pair that is simply already done');

__setState(stateWithScan('alpha', family()));
__net().nextReject = new Error('preview blew up');
await previewSemanticPair('alpha', __state().semanticScan.pairs[1]);
ok(__state().semanticScan.pairs[1].status === 'open',
   '10c: NEGATIVE CONTROL — an ORDINARY preview failure does NOT resolve anything');
ok(!!(__state().semanticScan.preview && __state().semanticScan.preview.error === 'preview blew up'),
   '10c: …it still renders as the pair’s own error, exactly as before');

// 10d. the detector itself
ok(semanticStaleFromError(new Error('entities/a2 no longer exists — …')).missing === 'entities/a2',
   '10d: semanticStaleFromError extracts the folder/slug');
ok(semanticStaleFromError(new Error('something else went wrong')) === null,
   '10d: NEGATIVE CONTROL — it does not fire on an unrelated message');

// 10e. a merge the SERVER refuses because a page is gone is not an error
__setState(stateWithScan('alpha', family(), [KEY_1]));
__net().nextResult = { ok: true, fixed: 0, reason: 'keep-page-missing', missing: 'entities/a2' };
await mergeOneSemanticPair('alpha', __state().semanticScan.pairs[0]);
ps = __state().semanticScan.pairs;
ok(ps[0].status === 'resolved' && !ps[0].error,
   '10e: fixed:0 with a staleness reason is ALREADY RESOLVED, never "the pair failed validation on disk"');
__setState(stateWithScan('alpha', family(), [KEY_1]));
__net().nextResult = { ok: true, fixed: 0, reason: 'semantic-pair-invalid' };
await mergeOneSemanticPair('alpha', __state().semanticScan.pairs[0]);
ok(/did not pass the check on disk/.test(__state().semanticScan.pairs[0].error || ''),
   '10e: NEGATIVE CONTROL — a real validation refusal still reports as an error on the pair');
__setState(stateWithScan('alpha', family(), [KEY_1]));
__net().nextResult = { ok: true, fixed: 0, reason: 'merge-would-lose-text' };
await mergeOneSemanticPair('alpha', __state().semanticScan.pairs[0]);
ok(/would lose text/.test(__state().semanticScan.pairs[0].error || ''), '10e: a merge refused for losing text says so');

console.log('\n=== 11. The BATCH path cascades too — and it reaches this first ===');
// v3.0.17's lesson: fix the path that runs FIRST. The batch deletes many
// pages in one pass, so within a family most of its own later pairs go stale
// mid-run.
__setState(stateWithScan('alpha', family()));
__net().sseFrames = [
  { type: 'progress', done: 1, total: 2, pair: { keepFolder: 'entities', keepSlug: 'a3', removeFolder: 'entities', removeSlug: 'a2' }, status: 'merged' },
  { type: 'done', merged: 1, stale: 1, skipped: 0, errors: 0, total: 2 },
];
await runMergeSemanticDuplicates('alpha');
ps = __state().semanticScan.pairs;
ok(ps[0].status === 'merged', '11a: the merged frame is recorded');
ok(ps[1].status === 'resolved' && ps[2].status === 'resolved',
   '11a: THE FIX — a `merged` batch frame resolves every sibling naming the deleted page');
ok(ps[3].status === 'open', '11a: NEGATIVE CONTROL — the unrelated pair survives the batch, still actionable');

// 11b. a `stale` frame — the server telling us THIS pair was already gone.
__setState(stateWithScan('alpha', family()));
__net().sseFrames = [
  { type: 'progress', done: 1, total: 2, pair: { keepFolder: 'entities', keepSlug: 'a', removeFolder: 'entities', removeSlug: 'a2' }, status: 'stale', missing: 'entities/a2' },
  { type: 'done', merged: 0, stale: 1, skipped: 0, errors: 0, total: 1 },
];
await runMergeSemanticDuplicates('alpha');
ps = __state().semanticScan.pairs;
ok(ps[1].status === 'resolved',
   '11b: a `stale` frame maps to RESOLVED — not to `skipped`, which is the word the UI uses for the user’s own Skip');
ok(ps[0].status === 'resolved' && ps[2].status === 'resolved',
   '11b: …and the named missing page cascades to the rest of the family');
__setState(stateWithScan('alpha', family()));
__net().sseFrames = [
  { type: 'progress', done: 1, total: 1, pair: { keepFolder: 'entities', keepSlug: 'a', removeFolder: 'entities', removeSlug: 'a2' }, status: 'skipped' },
  { type: 'done', merged: 0, stale: 0, skipped: 1, errors: 0, total: 1 },
];
await runMergeSemanticDuplicates('alpha');
ok(__state().semanticScan.pairs[1].status === 'skipped',
   '11b: NEGATIVE CONTROL — a genuine `skipped` frame is still recorded as skipped, so the split means something');
ok(__state().semanticScan.pairs[0].status === 'open',
   '11b: …and a skipped pair cascades to nothing, because nothing was deleted');

// 11c. the helper on its own, with no scan and with a junk page
__setState(stateWithScan('alpha', family()));
ok(resolvePairsTouching(null, { folder: 'entities', slug: 'a2' }, null) === 0, '11c: no scan → nothing resolved, no throw');
ok(resolvePairsTouching(__state().semanticScan, { folder: 'entities', slug: 'nobody' }, null) === 0,
   '11c: NEGATIVE CONTROL — a page no pair names resolves nothing');
ok(resolvePairsTouching(__state().semanticScan, { folder: 'entities', slug: 'a2' }, null) === 3,
   '11c: …while a2 resolves exactly the three pairs that name it');
ok(resolvePairsTouching(__state().semanticScan, { folder: 'entities', slug: 'a2' }, null) === 0,
   '11c: …and running it again resolves nothing more (it only ever touches OPEN pairs)');

console.log('\n=== 13. The lanes: the agreed words, and no primary action ===');
const primaryCount = (h) => (h.match(/btn-primary/g) || []).length;
// How far it has got and Compare the next are AI help's row, and the batch is the Spelling
// variants row in Your decision. The pairs themselves are the review desk's: its suite is
// test-next-review-desk.js.
const compareOf = () => renderCompareRow({ needsKey: false, model: 'm' }, __state().busyKey, false);
const decisionOf = (readonly) => renderDecisionLane({ counts: { dismissed: 0 }, dismissedRecords: 0 }, !!readonly, false);
const card = (pairs, coverage, previewed) => {
  __setState(stateWithScan('alpha', pairs, previewed));
  __state().semanticScan.coverage = coverage;
  return decisionOf();
};
const SOME = { total: 36333, checked: 500, left: 35833, next: 500 };
const NONE = { total: 943, checked: 943, left: 0, next: 0 };
const VARIANT = pair({ keepSlug: 'hand-off', removeSlug: 'handoff', removeFolder: 'entities' });
const LOOKALIKE = pair({ keepSlug: 'gemini', removeSlug: 'gemini-flash', removeFolder: 'entities', spellingVariant: false });
const MEDIUM = pair({ keepSlug: 'x-one', removeSlug: 'x-two', removeFolder: 'entities', confidence: 'medium', spellingVariant: false });

let h13 = card([VARIANT, LOOKALIKE], SOME);
ok(compareOf().includes('500 of 36,333 pairs compared'), '13a: some left: the exact reading');
ok(compareOf().includes('Compare the next 500'), '13a: …with its button');
ok(decisionOf().includes('Spelling variants') && decisionOf().includes('Merge 1<') && decisionOf().includes('deletes 1 page'), '13b: the batch row, singular, and it says what it deletes');
ok(decisionOf().indexOf('Spelling variants') < decisionOf().indexOf('Possible duplicates'), '13b: Spelling variants comes first, so what a batch settles is all below the press');
ok(!h13.includes('dm-semantic-reset-btn') && /btn-secondary btn-xs" id="dm-semantic-reset-btn"/.test(compareOf()), '13d: Forget all comparisons is in AI help\'s fold, a real button and the smallest there');
ok(primaryCount(h13) === 0, '13e: with a variant waiting, nothing leans toward deleting: the batch is not primary');

h13 = card([LOOKALIKE, MEDIUM], SOME);
ok(primaryCount(h13) === 0 && h13.includes('dm-review-btn') && !h13.includes('Spelling variants'), '13f: with pairs to read and none to batch, Review is the way in, and it is not primary');
ok(/btn-ai/.test(compareOf()) && !/btn-primary/.test(compareOf()), '13f: the next run is the AI button, whatever waits');

h13 = card([], SOME);
ok(primaryCount(h13) === 0, '13h: nothing waiting: nothing primary');
ok(!decisionOf().includes('Possible duplicates'), '13h: and no row for pairs that are not there');

h13 = card([], NONE);
ok(compareOf().includes('All 943 pairs compared') && !/data-action="semanticDupes"/.test(compareOf()), '13i: none left: the exact reading, with no next button');

// The row counts only what is still undecided.
h13 = card([pair({ keepSlug: 'a', removeSlug: 'b', remembered: true }), pair({ keepSlug: 'c', removeSlug: 'd', remembered: true, status: 'merged' })], SOME);
ok(/Possible duplicates<\/span><span class="[^"]*">1</.test(decisionOf()), '13j: remembered pairs count, undecided only');

h13 = card([], { total: 10, checked: 0, left: 10, next: 10 });
ok(!compareOf().includes('dm-semantic-reset-btn'), '13k: nothing compared: nothing to forget, so no reset');
__setState(stateWithScan('alpha', [], []));
__state().semanticScan.coverage = SOME;
__state().semanticScan.failedAll = true;
ok(!compareOf().includes('No two page names') && !compareOf().includes('All '), '13l: a run whose every call failed does not claim it found nothing');

__setState(stateWithScan('alpha', [VARIANT], []));
__state().semanticScan.coverage = SOME;
h13 = decisionOf(true);
ok(primaryCount(h13) === 0 && !h13.includes('dm-review-btn') && !h13.includes('dm-semantic-merge-btn'), '13m: read-only: no action of any kind');

const visible = card([VARIANT, LOOKALIKE], SOME).replace(/<[^>]*>/g, ' ');
for (const w of ['verdict', 'cache', 'record', 'hash', 'token']) ok(!new RegExp(w, 'i').test(visible), `13n: no mechanism word on screen: ${w}`);

__setState(stateWithScan('alpha', [LOOKALIKE], []));
flipSemanticPair(__state().semanticScan.pairs[0]);
ok(__state().semanticScan.pairs[0].spellingVariant === false, '13o: a Flip keeps what the server said about the names');
__setState(stateWithScan('alpha', [VARIANT], []));
flipSemanticPair(__state().semanticScan.pairs[0]);
ok(liveBatchPairs().length === 1, '13o: …so a flipped variant stays in the batch');
__setState(stateWithScan('alpha', [pair({ nameRelation: 'spelling-variant' })], []));
flipSemanticPair(__state().semanticScan.pairs[0]);
ok(__state().semanticScan.pairs[0].nameRelation === 'spelling-variant', '13o: a Flip keeps the app\'s own fact about the names');
ok(newSemanticScan('alpha', { pairs: [pair({ nameRelation: 'version-differs' })] }).pairs[0].nameRelation === 'version-differs', '13o: a scan keeps it too');
{
  const ordered = newSemanticScan('alpha', { pairs: [pair({ keepSlug: 'a', confidence: 'low' }), pair({ keepSlug: 'b', confidence: 'medium' }), pair({ keepSlug: 'c', confidence: 'high' }), pair({ keepSlug: 'd', confidence: 'medium' }), pair({ keepSlug: 'e', confidence: 'high' })] }).pairs.map((p) => p.keepSlug).join();
  ok(ordered === 'c,e,b,d,a', '13o: the desk\'s order is high first, and what the server ranked stays ranked inside each', ordered);
}
ok(toWirePair(VARIANT).spellingVariant === undefined, '13p: the view never sends its own idea of eligibility');

console.log('\n=== 13q. State belongs to its domain: an answer lands on the scan that asked ===');
{
  const SAME = 'entities/openai||concepts/open-ai';
  const switchTo = (slug) => { __state().activeSlug = slug; __state().semanticScan = { slug, pairs: [pair()], cost: null, previewed: new Set(), preview: null }; };
  // Merge in flight, then another domain with a pair of the same names.
  __setState(stateWithScan('alpha', [pair(), pair({ keepSlug: 'openai', keepFolder: 'entities', removeSlug: 'x', removeFolder: 'concepts' })], [SAME]));
  const scanA = __state().semanticScan;
  __net().nextResult = { ok: true, fixed: 1 };
  let wait = mergeOneSemanticPair('alpha', scanA.pairs[0]);
  switchTo('beta');
  await wait;
  ok(__state().semanticScan.pairs[0].status === 'open', 'a merge in alpha, landing after a switch, does not mark beta\'s pair of the same names');
  ok(scanA.pairs[0].status === 'merged', 'it is recorded on alpha\'s own list');
  // Settled by a merge: the same.
  __setState(stateWithScan('alpha', [pair()], [SAME]));
  const scanA2 = __state().semanticScan;
  __net().nextResult = { ok: true, fixed: 0, reason: 'keep-page-missing', missing: 'entities/openai' };
  wait = mergeOneSemanticPair('alpha', scanA2.pairs[0]);
  switchTo('beta');
  await wait;
  ok(__state().semanticScan.pairs[0].status === 'open' && scanA2.pairs[0].status === 'resolved', 'a page gone in alpha settles alpha\'s pair, not beta\'s');
  // Failed: the message too.
  __setState(stateWithScan('alpha', [pair()], [SAME]));
  __net().nextReject = new Error('the disk went away');
  wait = mergeOneSemanticPair('alpha', __state().semanticScan.pairs[0]);
  switchTo('beta');
  await wait;
  ok(!__state().semanticScan.pairs[0].error, 'a failure in alpha is not written on beta\'s pair');
  // Keep both.
  __setState(stateWithScan('alpha', [pair()]));
  const scanA3 = __state().semanticScan;
  __net().nextResult = { ok: true };
  wait = skipSemanticPair('alpha', scanA3.pairs[0]);
  switchTo('beta');
  await wait;
  ok(__state().semanticScan.pairs[0].status === 'open' && scanA3.pairs[0].status === 'skipped', 'Keep both, the same');
  // A comparison.
  __setState(stateWithScan('alpha', [pair()]));
  __net().nextResult = { ok: true, basis: 'of-alpha' };
  wait = previewSemanticPair('alpha', __state().semanticScan.pairs[0]);
  switchTo('beta');
  const ans = await wait;
  ok(ans.stale === true && __state().semanticScan.preview === null && !__state().semanticScan.bases, 'alpha\'s comparison and basis never land on beta');
  __setState(stateWithScan('alpha', [pair()]));
  __net().nextReject = new Error('entities/openai no longer exists — settled.');
  wait = previewSemanticPair('alpha', __state().semanticScan.pairs[0]);
  switchTo('beta');
  await wait;
  ok(__state().semanticScan.pairs[0].status === 'open', 'alpha\'s page gone never settles beta\'s pair');

  // Coming back: the row is there before anything has answered.
  const REPORT = { counts: { entities: 0, concepts: 0, summaries: 0, dismissed: 0 }, brokenLinks: [], orphans: [], crossFolderDupes: [], hyphenVariants: [], folderPrefixLinks: [], missingBacklinks: [] };
  __setState(stateWithScan('alpha', [pair(), pair({ keepSlug: 'kept', removeSlug: 'gone', status: 'merged' })], [SAME]));
  __state().cache = { alpha: { health: REPORT } };
  __state().aiAvailable = true;
  const listA = __state().semanticScan;
  __net().nextResult = REPORT;
  await loadHealth('beta', 1, {});
  ok(__state().semanticScan === null || __state().semanticScan !== listA, 'a domain switch takes the list off screen');
  ok(rawPreviewedKeys().length === 0 && listA.previewed.size === 0 && listA.preview === null, 'disarmed: what was armed for it is gone, and stays gone');
  __state().activeSlug = 'alpha';
  let answered = false;
  __net().nextResult = REPORT;
  const back = loadHealth('alpha', 1, {});
  ok(__state().semanticScan === listA, 'coming back it is there at once, before the reading has answered');
  ok(decisionOf().includes('Possible duplicates'), 'and so is the row');
  ok(listA.pairs[1].status === 'merged', 'with what happened to each pair');
  ok(canMergeSemanticPair(listA.pairs[0]).allowed === false, 'and nothing armed by it');
  await back; answered = true;
  ok(answered, 'the reading lands behind it');
  ok(!__state().cache.alpha.scan, 'held once: a list forgotten later cannot come back from here');
}

console.log('\n=== 14. Singular forms, the failure notice, counting, long lists ===');
const ONE = { total: 1, checked: 1, left: 0, next: 0 };
card([], ONE);
ok(compareOf().includes('The 1 pair was compared'), '14a: all, singular');
card([], { total: 1, checked: 0, left: 1, next: 1 });
ok(compareOf().includes('No pairs compared yet') && compareOf().includes('Compare the next 1'), '14a: some left, singular');

const failedCard = (failedPairs, failedAll, pairs = []) => {
  __setState(stateWithScan('alpha', pairs, []));
  Object.assign(__state().semanticScan, { coverage: SOME, failedPairs, failedAll });
  return compareOf();
};
ok(failedCard(20, false).includes('20 pairs could not be compared because the AI call failed. They will be tried again next time.'), '14b: the midway notice, on the row');
ok(failedCard(1, false).includes('1 pair could not be compared because the AI call failed.'), '14b: …singular');
ok(!failedCard(20, true).includes('could not be compared'), '14b: every batch failing is the failure on the row, not the notice');

__net().sseFrames = [
  { type: 'start', candidatePairs: 40 },
  { type: 'batch-error', batch: 0, error: 'boom' },
  { type: 'done', pairs: [], failedPairs: 20, totalPairs: 100, checkedPairs: 20, leftPairs: 80, nextPairs: 40 },
];
__setState(stateWithScan('alpha', [], []));
__state().estimates = {};
await runSemanticScan('alpha');
ok(!(__state().rowNote && __state().rowNote.tone === 'error') && __state().semanticScan.failedPairs === 20, '14c: part of a run failing raises no failure on the row');
__net().sseFrames = [
  { type: 'start', candidatePairs: 20 },
  { type: 'batch-error', batch: 0, error: 'boom' },
  { type: 'done', pairs: [], failedPairs: 20, totalPairs: 100, checkedPairs: 0, leftPairs: 100, nextPairs: 20 },
];
await runSemanticScan('alpha');
ok(__state().rowNote && __state().rowNote.tone === 'error' && /Could not compare pages: boom/.test(__state().rowNote.text) && __state().semanticScan.failedAll, '14c: all of it failing does');

__setState(stateWithScan('alpha', [VARIANT], []));
Object.assign(__state().semanticScan, { coverage: SOME, counting: true });
// A RECOUNT MOVES NOTHING (the press rule). The figures stay, marked as about, and the
// button stays: what it would really send is read at the press.
ok(compareOf().includes('About 500 of 36,333 pairs compared'), '14d: while recounting, the figures already on screen stay');
ok(/id="dm-semantic-reset-btn" disabled/.test(compareOf()), '14d: …and Forget waits for it');
__state().activeSlug = 'alpha';
__state().semanticQuote = { slug: 'alpha', forNext: 40, est: { candidatePairs: 40, estimatedUsd: 0.04, priceKnown: true } };
{
  const row = compareOf();
  const btn = /<button[^>]*data-action="semanticDupes"[^>]*>/.exec(row)[0];
  ok(!/disabled/.test(btn) && /cur-action-cost/.test(row), '14d: a recount disables nothing: the button keeps a figure, scaled to what it says it will send');
}
__state().semanticQuote = null;
ok(decisionOf().includes('dm-review-btn'), '14d: …and the pairs are already there');
__setState(stateWithScan('alpha', [], []));
Object.assign(__state().semanticScan, { coverage: null, counting: true });
ok(compareOf().includes('Working out the cost…') && /disabled/.test(compareOf()) && !/All |No two/.test(compareOf()), '14d: with no figures yet it claims no finding');

// Coming back: the pairs come from the quick call, then the figures land.
__setState(stateWithScan('alpha', [], []));
Object.assign(__state(), { semanticScan: null, aiAvailable: true });
__net().calls.length = 0;
__net().nextResult = { hasChecks: true, pairs: [{ keepFolder: 'concepts', keepSlug: 'a', removeFolder: 'concepts', removeSlug: 'b', confidence: 'high', rationale: 'r', spellingVariant: true, remembered: true }] };
syncSemanticScan('alpha', 1);
await new Promise((r) => setTimeout(r, 0));
ok(/status\?quick=1$/.test(__net().calls[0].url), '14e: coming back asks for the pairs first, with no candidate pass');
await new Promise((r) => setTimeout(r, 5));
ok(__net().calls.length === 2 && /status$/.test(__net().calls[1].url), '14e: …then counts');
__setState(stateWithScan('alpha', [], []));
Object.assign(__state(), { aiAvailable: true });
const heldScan = __state().semanticScan;
heldScan.coverage = { total: 9, checked: 3, left: 6, next: 6 };
__net().nextResult = { totalPairs: 8, checkedPairs: 2, leftPairs: 6, nextPairs: 6 };
syncSemanticScan('alpha', 1);
ok(heldScan.counting === true, '14f: a merge or Skip on screen re-counts');
await new Promise((r) => setTimeout(r, 5));
ok(heldScan.counting === false && heldScan.coverage.total === 8, '14f: …and the true figures land');
__setState(stateWithScan('alpha', [], []));
Object.assign(__state(), { aiAvailable: true });
__state().readonlySet.add('alpha');
__state().semanticScan = null;
__net().calls.length = 0;
syncSemanticScan('alpha', 1);
ok(__net().calls.length === 0, '14g: a mirror has no scan to resume');

const many = [];
for (let i = 0; i < 123; i++) many.push(pair({ keepSlug: 'k' + i, removeSlug: 'r' + i }));
h13 = card(many, SOME);
ok(decisionOf().includes('Merge 123<'), '14h: the batch counts ALL pairs');
ok(liveBatchPairs().length === 123, '14h: …and so does what the batch would send');

// The batch's own message.
__setState(stateWithScan('alpha', [VARIANT], []));
__net().sseFrames = [{ type: 'progress', done: 1, total: 3, pair: toWirePair(VARIANT), status: 'ineligible', reason: 'page-changed' }, { type: 'done', merged: 1, total: 3, ineligible: 2 }];
await runMergeSemanticDuplicates('alpha');
ok(__state().rowNote.text === 'Merged 1 of 3. 2 now need your review.', '14k: some refused: the exact words', );
ok(__state().semanticScan.pairs[0].spellingVariant === false, '14k: a refused pair leaves the batch and stays on screen');
__setState(stateWithScan('alpha', [VARIANT], []));
__net().sseFrames = [{ type: 'done', merged: 1, total: 2, ineligible: 1 }];
await runMergeSemanticDuplicates('alpha');
ok(__state().rowNote.text === 'Merged 1 of 2. 1 now needs your review.', '14k: …singular');
__setState(stateWithScan('alpha', [], []));
await runMergeSemanticDuplicates('alpha');
ok(__state().rowNote.text === 'Nothing left to merge.', '14l: nothing left: the exact words');

console.log('\n' + '='.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ /next semantic-duplicate merge gate holds');
