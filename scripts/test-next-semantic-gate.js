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
 * path where Merge stays DISABLED until the user has opened a Preview diff
 * for that exact pair (and the handler refuses even if the button is
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
  'canMergeSemanticPair',
  'flipSemanticPair',
  'liveHighConfidencePairs',
  'markSemanticPairStatus',
  'setSemanticPairMessage',
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
const CONSTS = ['HEALTH_CATEGORIES'];

// Stubs for everything the extracted functions reach outside themselves.
// `net` records every request so the shapes can be asserted; `net.fail`
// makes the next call reject with a chosen error.
const PREAMBLE = `
let state = {};
let myMountToken = 1;
const inFlightWriteSlugs = new Set();
const net = { calls: [], nextReject: null, nextResult: null, sseFrames: [], nextFetchNotOk: null };
const gates = { opened: [], released: 0 };
function render() {}
function isCurrentMount(t) { return t === myMountToken; }
function reportAsyncActionFailure() {}
function beginDomainWrite(domain, label) { gates.opened.push({ domain, label }); return () => { gates.released++; }; }
function loadEstimates() { return Promise.resolve(); }
function escapeHtml(s) { return String(s == null ? '' : s); }
function icon() { return ''; }
// No DOM in this sandbox: the reveal helpers are asserted in §9 by source
// and proven for real in the browser (they are a scroll-position concern,
// which is not a thing a headless state machine can have).
function revealMessage() { return false; }
function revealSemanticMessage(key) { net.revealed = key; return false; }
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
    PREAMBLE +
    CONSTS.map((c) => extractConst(src, c)).join('\n') + '\n' +
    FNS.map((n) => extractFunction(src, n)).join('\n\n') + '\n' +
    `return { ${FNS.join(', ')},
       __state: () => state, __setState: (s) => { state = s; },
       __net: () => net, __gates: () => gates,
       __setMount: (t) => { myMountToken = t; },
       __inFlight: () => inFlightWriteSlugs };`
  )();
} catch (err) {
  console.log('FATAL: could not build the sandbox from domains.js — ' + err.message);
  process.exit(1);
}

const {
  semanticPairKey, activeSemanticScan, rawPreviewedKeys, markSemanticPreviewed,
  isSemanticPreviewed, canMergeSemanticPair, flipSemanticPair, liveHighConfidencePairs,
  markSemanticPairStatus, toWirePair, loadHealth, selectDomain, runSemanticScan,
  previewSemanticPair, mergeOneSemanticPair, skipSemanticPair, runMergeSemanticDuplicates,
  mergeSemanticDuplicates,
  __state, __setState, __net, __gates, __setMount,
} = sandbox;

function pair(over) {
  return Object.assign({
    keepFolder: 'entities', keepSlug: 'openai',
    removeFolder: 'concepts', removeSlug: 'open-ai',
    confidence: 'high', rationale: 'same company', status: 'open',
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
ok(g.allowed === false && /preview/i.test(g.reason), 'un-previewed: refused, and told to preview first');
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

console.log('\n=== 4b. Only a SUCCESSFUL preview opens the gate ===');
__setState(stateWithScan('alpha', [pair()]));
__net().nextResult = { ok: true, keepPath: 'entities/openai.md', removePath: 'concepts/open-ai.md', totalLinksRewritten: 3, affectedCount: 2, affectedFiles: [], mergedPreview: 'x', mergedLength: 1 };
await previewSemanticPair('alpha', __state().semanticScan.pairs[0]);
ok(!!(__state().semanticScan && isSemanticPreviewed(__state().semanticScan.pairs[0]) === true), 'a successful preview marks the pair previewed');
ok(__state().semanticScan.preview && __state().semanticScan.preview.data, 'the preview payload is stored for rendering');
ok(__net().calls.some((c) => /semantic-dupes\/preview$/.test(c.url) && c.body && c.body.issue),
   'the preview POSTs { issue } to /semantic-dupes/preview');
ok(__net().calls.slice(-1)[0].body.issue.status === undefined,
   'the wire pair carries no view-local `status` field');

__setState(stateWithScan('alpha', [pair()]));
__net().nextReject = new Error('preview blew up');
await previewSemanticPair('alpha', __state().semanticScan.pairs[0]);
ok(isSemanticPreviewed(__state().semanticScan.pairs[0]) === false,
   'a FAILED preview does NOT open the gate — otherwise "clicking Preview" is the guard, which is not what it promises');
ok(__state().semanticScan.preview && __state().semanticScan.preview.error === 'preview blew up',
   'the failed preview renders its own error in the pair’s own card');
ok(canMergeSemanticPair(__state().semanticScan.pairs[0]).allowed === false, '…and Merge stays refused');

console.log('\n=== 4c. Merge re-checks the gate at EXECUTION time ===');
// A disabled button is an affordance. This is the guard.
__setState(stateWithScan('alpha', [pair()]));           // deliberately NOT previewed
__net().calls.length = 0;
await mergeOneSemanticPair('alpha', __state().semanticScan.pairs[0]);
ok(__net().calls.length === 0, 'an un-previewed pair NEVER reaches the network, even when the function is called directly');
ok(!!(__state().semanticScan && __state().semanticScan.pairs[0].refusal && /preview/i.test(__state().semanticScan.pairs[0].refusal)),
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
ok(liveHighConfidencePairs().length === 2, '5a: only high-confidence pairs are batch-eligible (medium is not)');

// 5b. a FLIP before the batch must change the direction that gets merged
__setState(stateWithScan('alpha', [p1, p2]));
flipSemanticPair(__state().semanticScan.pairs[0]);
let live = liveHighConfidencePairs();
ok(live[0].keepSlug === 'b' && live[0].removeSlug === 'a',
   '5b: after a Flip the batch list carries the FLIPPED direction — merging the pre-flip direction deletes the page the user chose to keep');

// 5c. a SKIP before the batch must exclude the pair
__setState(stateWithScan('alpha', [p1, p2]));
markSemanticPairStatus(__state().semanticScan.pairs[1], 'skipped');
live = liveHighConfidencePairs();
ok(live.length === 1 && live[0].keepSlug === 'a', '5c: a skipped pair is excluded from the batch');

// 5d. an already-merged pair must not be re-attempted
__setState(stateWithScan('alpha', [p1, p2]));
markSemanticPairStatus(__state().semanticScan.pairs[0], 'merged');
ok(liveHighConfidencePairs().length === 1, '5d: an already-merged pair is excluded from the batch');

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
ok(__state().banner && /Nothing left to merge/.test(__state().banner.text), '5f: …and the user is told why nothing happened');

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
ok(__state().banner && __state().banner.tone === 'error', '5h: a banner was rendered');
ok(!!(__state().banner && /Cannot batch-merge duplicates/.test(__state().banner.text)),
   '5h: the server’s own 409 sentence reaches the banner verbatim — the refusal branch of classifyDomainError fired');
ok(!(__state().banner && /^Could not merge duplicates —/.test(__state().banner.text)),
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
ok(liveHighConfidencePairs().length === 2, 'liveHighConfidencePairs returns pairs when there are pairs (so an empty result above means something)');
// And the flip detector must not "pass" on an unflipped pair.
ok(liveHighConfidencePairs()[0].keepSlug === 'a',
   'an UNflipped pair keeps its original direction — the 5b assertion is detecting the flip, not a constant');

console.log('\n=== 8. Structure that keeps the invariants from drifting back ===');
const scanSrc = extractFunction(src, 'runSemanticScan');
ok(/previewed: new Set\(\)/.test(scanSrc),
   'a new scan builds a NEW previewed Set inside the scan object — structural, so it cannot inherit an old one');
ok(/slug,/.test(scanSrc), 'a new scan records the slug it was scanned for');
const confirmSrc = extractFunction(src, 'mergeSemanticDuplicates');
ok(/run: \(\) => runMergeSemanticDuplicates\(slug\),/.test(confirmSrc),
   'the confirm passes NO pair list — capturing one is the v3.0.1-beta.15 bug');
const batchSrc = extractFunction(src, 'runMergeSemanticDuplicates');
ok(/liveHighConfidencePairs\(\)\.map\(toWirePair\)/.test(batchSrc), 'the batch derives its list inside itself, at execution');
ok(!/state\.semanticScan\.pairs\.filter/.test(batchSrc), 'the batch never reads the raw pairs array directly');
// Every reader/writer of the previewed set must go through the accessor.
for (const fn of ['markSemanticPreviewed', 'isSemanticPreviewed', 'canMergeSemanticPair', 'flipSemanticPair', 'liveHighConfidencePairs', 'markSemanticPairStatus', 'setSemanticPairMessage']) {
  ok(/activeSemanticScan\(\)/.test(extractFunction(src, fn)),
     `${fn} reaches the scan ONLY through activeSemanticScan() (LAYER 2 cannot be bypassed)`);
}
// rawPreviewedKeys is the deliberate exception — it exists to see PAST
// layer 2 so layer 1 can be asserted on its own.
ok(!/activeSemanticScan\(\)/.test(extractFunction(src, 'rawPreviewedKeys')),
   'rawPreviewedKeys deliberately bypasses the accessor — that is what makes the LAYER 1 assertions independent');
ok(/if \(!\(opts && opts\.keepSemanticScan\)\) state\.semanticScan = null;/.test(extractFunction(src, 'resetDomainScopedHealthState')),
   'the scan is cleared by default and kept only on an explicit opt-in');
const perPairKeeps = extractFunction(src, 'mergeOneSemanticPair') + extractFunction(src, 'skipSemanticPair');
ok((perPairKeeps.match(/keepSemanticScan: true/g) || []).length === 2,
   'exactly the two per-pair actions opt into keeping the scan');
ok(!/keepSemanticScan/.test(extractFunction(src, 'selectDomain')), 'a domain switch never opts in');
ok(!/keepSemanticScan/.test(extractFunction(src, 'runFixSafe')), 'an ordinary fix never opts in');

console.log('\n=== 9. A rendered refusal must also be VISIBLE ===');
// Found in browser verification of this change: a 409 rendered correctly, on
// the right pair, with no overlay anywhere — at y=1067 in an 892px viewport.
// The user sees the button re-enable and nothing else. "We rendered it" is
// not "they can see it"; that distinction IS v3.6.0 finding 7.
const mergeOneSrc = extractFunction(src, 'mergeOneSemanticPair');
const skipOneSrc = extractFunction(src, 'skipSemanticPair');
ok(/revealSemanticMessage\(key\);/.test(mergeOneSrc), 'a per-pair merge reveals its outcome message');
ok(/revealSemanticMessage\(key\);/.test(skipOneSrc), 'a per-pair skip reveals its outcome message');
ok((mergeOneSrc.match(/revealSemanticMessage\(key\)/g) || []).length === 2,
   'both the synchronous gate refusal AND the post-request outcome are revealed — the gate refusal never reaches the network, so it has no repaint of its own to piggyback on');
const revealSrc = extractFunction(src, 'revealMessage');
ok(/if \(r\.top >= 0 && r\.bottom <= window\.innerHeight\) return false;/.test(revealSrc),
   'revealMessage is a NO-OP when the message is already fully in view — it must not yank the page under someone who can already read it');
ok(/typeof el\.scrollIntoView === 'function'/.test(revealSrc), 'it degrades safely if scrollIntoView is unavailable');
for (const fn of ['runCreateDomain', 'runRenameDomain', 'runDeleteDomain']) {
  ok(/revealMessage\('\.dm-lc-refusal, \.dm-lc-error'\)/.test(extractFunction(src, fn)),
     fn + ' reveals its refusal/error too');
}

console.log('\n' + '='.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ /next semantic-duplicate merge gate holds');
