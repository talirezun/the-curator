/**
 * test-next-existing-knowledge-folder.js — OFFLINE guard on the route an
 * EXISTING user takes into a fresh install: "I already have six domains,
 * where are they?"
 *
 * ── The defect this guards ───────────────────────────────────────────────
 *
 * Reported from a real packaged-app install: "there is no way to open
 * existing domains. I have 6 existing domains." In bundle mode the domains
 * folder resolves under ~/Library/Application Support and is CREATED on first
 * launch, so a long-time user opens the app to a correctly-working, genuinely
 * empty install — nothing broken, nothing lost, and no visible route to the
 * folder they already have. The conclusion an ordinary user reaches from an
 * empty Domains screen is not "wrong folder", it is "my knowledge base is
 * gone", and the project's own standing brief names existing wikis appearing
 * as the ONE must-have of the macOS pivot.
 *
 * The backend needed no change. This suite therefore guards a CLIENT
 * behaviour and one MEASURED backend property the client depends on.
 *
 * ── §1 is the part that is not a unit test ──────────────────────────────
 *
 * Everything the client does after a folder is picked rests on one claim:
 * `setDomainsDir()` takes effect immediately, in the same process, with no
 * restart and no reload. If that were false the user would pick the right
 * folder, see nothing, and conclude the feature is broken — strictly worse
 * than today, because their config has now moved too. So §1 does not mock:
 * it drives the REAL src/brain/config.js and src/brain/files.js over real
 * temp directories and asserts the property, plus the source condition that
 * makes it true (nothing captures the resolved path at module scope).
 *
 * §1 also pins the fact that produced describeSwitchOutcome: an empty
 * knowledge folder, a folder that is not a knowledge base at all, and a
 * folder that has been unmounted are ALL indistinguishable at the read layer
 * — every one returns `[]`. That is correct behaviour (an absent collection
 * is empty, not broken) and it is exactly why a UI that merely repaints an
 * empty list after a pick tells the user nothing.
 *
 * ── NOT ENFORCED (stated rather than implied) ───────────────────────────
 *
 *   • No server is started and no HTTP call is made. Request SHAPES and
 *     client state transitions are pinned; the server's replies are not.
 *     Both endpoints (`POST /api/config/pick-folder`, `POST /api/config/
 *     domains-path`) are pre-existing and unmodified by this change, and
 *     their own guards are covered by scripts/test-route-write-guards.js.
 *   • The native folder picker is NEVER invoked, here or anywhere in
 *     `npm test`. §4 drives the client against a fake `fetch` returning the
 *     shapes the route documents.
 *   • Contrast and press motion are not measured here. Every control this
 *     change adds is a plain `.btn`, so it inherits shell.css's existing
 *     press, disabled and reduced-motion rules; §8 asserts the CSS added
 *     declares no colour, type, border or shadow of its own, which is the
 *     property that keeps that inheritance true.
 */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const DOMAINS_JS = path.join(REPO, 'src/public/next/views/domains.js');
const DOMAINS_CSS = path.join(REPO, 'src/public/next/views/domains.css');
const ONBOARDING_JS = path.join(REPO, 'src/public/next/views/onboarding.js');

const src = readFileSync(DOMAINS_JS, 'utf8');
const cssSrc = readFileSync(DOMAINS_CSS, 'utf8');
const onbSrc = readFileSync(ONBOARDING_JS, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

// ── Extraction (same brace-matched shape as test-next-domain-lifecycle.js) ──
function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(source);
  if (!m) throw new Error(`extractFunction: "${name}" not found`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = source.indexOf('(', start);
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
    throw new Error(`extractFunction: "${name}" desynced — did not end at a top-level brace`);
  }
  return extracted;
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1  MEASURED, not assumed: does a folder switch need a restart?');
// ═══════════════════════════════════════════════════════════════════════════
{
  const TMP = mkdtempSync(path.join(tmpdir(), 'curator-kbfolder-'));
  // Isolation FIRST. Never the real .curator-config.json: this section CALLS
  // setDomainsDir, which writes it.
  process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'userdata');
  mkdirSync(process.env.CURATOR_TEST_USER_DATA_DIR, { recursive: true });

  const EMPTY = path.join(TMP, 'fresh-install');       // the app-support default
  const REAL = path.join(TMP, 'my-second-brain');      // six existing domains
  const NOT_A_WIKI = path.join(TMP, 'holiday-photos'); // not a knowledge base
  const ONE_DOMAIN = path.join(TMP, 'my-second-brain', 'articles'); // one level too deep
  mkdirSync(EMPTY, { recursive: true });
  mkdirSync(NOT_A_WIKI, { recursive: true });
  writeFileSync(path.join(NOT_A_WIKI, 'beach.jpg'), 'not markdown');
  const SIX = ['articles', 'projects', 'research', 'business', 'health', 'music'];
  for (const n of SIX) {
    mkdirSync(path.join(REAL, n, 'wiki'), { recursive: true });
    writeFileSync(path.join(REAL, n, 'CLAUDE.md'), '# schema\n');
  }

  const cfg = await import('../src/brain/config.js');
  const files = await import('../src/brain/files.js');

  cfg.setDomainsDir(EMPTY);
  const atStart = await files.listDomains();
  ok(atStart.length === 0, 'a fresh install reads as ZERO domains, not as an error');

  // THE CLAIM. Same process, same module instances, no re-import, no restart.
  cfg.setDomainsDir(REAL);
  const afterSwitch = await files.listDomains();
  ok(cfg.getDomainsDir() === path.resolve(REAL),
     'getDomainsDir() reflects the new folder IMMEDIATELY — it re-reads config per call');
  ok(afterSwitch.length === 6 && SIX.every((s) => afterSwitch.includes(s)),
     'listDomains() returns all six existing domains in the SAME PROCESS — no restart, no reload, ' +
     'so the correct client behaviour after a pick is simply to re-fetch the list');
  ok(cfg.getConfig().domainsPathSource === 'ui',
     'and getConfig() reports the source as the user’s own choice');

  // The three cases the read layer CANNOT tell apart. This is the fact that
  // makes describeSwitchOutcome necessary rather than decorative.
  cfg.setDomainsDir(NOT_A_WIKI);
  const notAWiki = await files.listDomains();
  cfg.setDomainsDir(ONE_DOMAIN);
  const tooDeep = await files.listDomains();
  cfg.setDomainsDir(path.join(TMP, 'ejected-drive'));
  const absent = await files.listDomains();
  ok(notAWiki.length === 0 && tooDeep.length === 0 && absent.length === 0,
     'a non-knowledge folder, a single domain picked one level too deep, and an absent folder ' +
     'ALL read as [] — indistinguishable from an empty knowledge base');
  ok(JSON.stringify(notAWiki) === JSON.stringify(absent) &&
     JSON.stringify(tooDeep) === JSON.stringify(absent),
     'and they are indistinguishable from EACH OTHER — so the UI cannot diagnose which one ' +
     'happened and must instead name what it looked for');

  // The source condition that keeps the immediacy claim true. A future
  // `const DIR = getDomainsDir()` at module scope would silently break it,
  // with no error and no test able to see it from the client side.
  const { readdirSync } = await import('fs');
  const scanned = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); }
      else if (e.name.endsWith('.js')) scanned.push(full);
    }
  };
  walk(path.join(REPO, 'src'));
  walk(path.join(REPO, 'mcp'));
  // Column 0 = module scope in this codebase. A leading-whitespace form is an
  // ordinary per-call resolution INSIDE a function, which is the correct
  // shape and appears at eight sites; matching those too is how the first
  // draft of this check reported four false positives.
  const MODULE_SCOPE_CAPTURE = /^(?:const|let|var)\s+\w+\s*=\s*getDomainsDir\s*\(\s*\)/m;
  const captures = scanned
    .filter((f) => MODULE_SCOPE_CAPTURE.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(REPO, f));
  ok(captures.length === 0,
     'NO module in src/ or mcp/ captures getDomainsDir() at module scope — the condition that ' +
     'makes the no-restart property true (found: ' + (captures.join(', ') || 'none') + ')');
  // POSITIVE CONTROL. A detector that can no longer fire would report this
  // same clean result forever, which is the failure mode the tightening
  // above could easily have introduced.
  ok(MODULE_SCOPE_CAPTURE.test('import x from "y";\nconst DIR = getDomainsDir();\n'),
     'and the detector still FIRES on a planted module-scope capture');
  ok(!MODULE_SCOPE_CAPTURE.test('function f() {\n  const dir = getDomainsDir();\n}\n'),
     'while correctly ignoring the per-call form inside a function');
  ok(scanned.length > 50, 'the scan actually walked the tree (' + scanned.length + ' files) — ' +
     'a zero-file walk would report the same clean result');

  rmSync(TMP, { recursive: true, force: true });
  delete process.env.CURATOR_TEST_USER_DATA_DIR;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sandbox for the client half.
// ═══════════════════════════════════════════════════════════════════════════
const FNS = [
  'classifyPickResponse',
  'describeSwitchOutcome',
  'renderLookedInLine',
  'knowledgeFolderBtn',
  'renderKnowledgeNotice',
  'loadKnowledgeBase',
  'onChooseKnowledgeFolder',
  'applySwitchedFolder',
  'onUndoKnowledgeFolder',
  'bindSidebarButtons',
  'bindKnowledgeListeners',
  'renderSidebar',
];

const PREAMBLE = `
let state = {};
let myMountToken = 1;
const calls = { render: 0, fetch: [], loadDomainsList: 0, listeners: [], openLifecycle: 0, sidebar: [] };
let nextResponses = [];
let domainsAfterReload = [];
let loadErrorAfterReload = null;
let writeBusy = false;
let busyThrows = false;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function icon() { return ''; }
function pluralize(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
function render() { calls.render++; }
function isCurrentMount() { return true; }
function reportAsyncActionFailure() {}
function openLifecycle() { calls.openLifecycle++; }
function domainDotClass() { return 'dm-row-dot-1'; }
function gatedLoader() { return '<GATED/>'; }
let loadGate = {};
function setSidebar(html) { calls.sidebar.push(html); }
function renderStatus(o) {
  return '<div class="tx-status tx-status-' + (o.state || 'neutral') + '">' +
    '<div class="tx-status-title">' + escapeHtml(o.title) + '</div>' +
    (o.detail ? '<div class="tx-status-detail">' + escapeHtml(o.detail) + '</div>' : '') + '</div>';
}
const shell = { isAnyWriteBusy: () => { if (busyThrows) throw new Error('gate exploded'); return writeBusy; } };

// The ONLY network seam. Every entry records the exact call the client made.
async function fetch(url, opts) {
  calls.fetch.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
  const next = nextResponses.shift();
  if (!next) throw new Error('test fetch: no queued response for ' + url);
  if (next.throws) throw new Error(next.throws);
  return { ok: next.status < 400, status: next.status, json: async () => next.body };
}
async function fetchJSON(url) {
  calls.fetch.push({ url, method: 'GET' });
  const next = nextResponses.shift();
  if (!next) throw new Error('test fetchJSON: no queued response for ' + url);
  if (next.throws) throw new Error(next.throws);
  if (next.status >= 400) throw new Error((next.body && next.body.error) || 'fail');
  return next.body;
}
// Stands in for the real one. Records that it ran and applies the outcome the
// test declared, so the caller's ORDER (reset -> reload -> describe) is what
// is under test, not the list fetch itself.
async function loadDomainsList() {
  calls.loadDomainsList++;
  state.loaded = true;
  state.loadError = loadErrorAfterReload;
  state.domains = domainsAfterReload;
  state.activeSlug = domainsAfterReload.length ? domainsAfterReload[0].slug : null;
}

// Minimal DOM so the BINDERS execute for real. A binder that silently wires
// nothing is exactly the "dead button" failure this change must not ship.
const domNodes = {};
const document = {
  getElementById(id) { return domNodes[id] || null; },
  querySelectorAll() { return []; },
};
function makeNode(id) {
  const n = { id, disabled: false, listeners: [],
    addEventListener(ev, fn) { this.listeners.push(ev); calls.listeners.push(id + ':' + ev); this['on_' + ev] = fn; } };
  domNodes[id] = n;
  return n;
}
`;

let sandbox;
try {
  sandbox = new Function(
    PREAMBLE +
    FNS.map((n) => extractFunction(src, n)).join('\n\n') + '\n' +
    `return { ${FNS.join(', ')},
      __state: () => state,
      __setState: (s) => { state = s; },
      __calls: () => calls,
      __reset: () => { calls.render = 0; calls.fetch.length = 0; calls.loadDomainsList = 0;
                       calls.listeners.length = 0; calls.openLifecycle = 0; calls.sidebar.length = 0;
                       nextResponses = []; writeBusy = false; busyThrows = false;
                       domainsAfterReload = []; loadErrorAfterReload = null;
                       for (const k of Object.keys(domNodes)) delete domNodes[k]; },
      __queue: (r) => { nextResponses.push(r); },
      __setBusy: (v) => { writeBusy = v; },
      __setBusyThrows: (v) => { busyThrows = v; },
      __setReload: (domains, err) => { domainsAfterReload = domains; loadErrorAfterReload = err || null; },
      __node: makeNode,
      __nodes: () => domNodes };`
  )();
} catch (err) {
  console.log('FATAL: could not build the sandbox from domains.js — ' + err.message);
  process.exit(1);
}

const {
  classifyPickResponse, describeSwitchOutcome, renderKnowledgeNotice, renderLookedInLine,
  knowledgeFolderBtn, onChooseKnowledgeFolder, onUndoKnowledgeFolder,
  bindSidebarButtons, bindKnowledgeListeners, renderSidebar,
  __state, __setState, __calls, __reset, __queue, __setBusy, __setBusyThrows, __setReload, __node,
} = sandbox;

function baseState(over) {
  return Object.assign({
    loaded: true, loadError: null, domains: [], readonlySet: new Set(),
    activeSlug: null, healthSummary: {},
    kb: { domainsPath: '/Users/x/Knowledge', domainsPathSource: 'ui' },
    kbBusy: false, kbNotice: null,
  }, over || {});
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  classifyPickResponse — every reply the route can send');
// ═══════════════════════════════════════════════════════════════════════════
{
  ok(classifyPickResponse(200, { cancelled: true }).kind === 'cancelled', 'a plain cancel is a cancel');
  ok(classifyPickResponse(200, { cancelled: true, inferred: true }).kind === 'cancelled',
     'an INFERRED cancel (exit 1, empty stderr) is still a cancel — the route says which it was, ' +
     'and either way nothing was chosen');

  // The ordering contract with the route's accept() closure.
  ok(classifyPickResponse(409, { cancelled: true, error: 'busy' }).kind === 'cancelled',
     'cancelled is checked BEFORE the status — the route’s own comment says a refusal must ' +
     'never carry that field, so mirroring its order keeps the two sides agreeing about what a cancel is');

  const busy = classifyPickResponse(409, { error: 'An ingest is running on articles.' });
  ok(busy.kind === 'refused', 'a 409 is a refusal, not a crash');
  ok(busy.detail.includes('An ingest is running on articles.'),
     'and it carries the SERVER’s own sentence, which names the domain and the operation — ' +
     'something our copy cannot do');

  const unsup = classifyPickResponse(501, { error: 'no picker', hint: 'Type the path in Settings.' });
  ok(unsup.kind === 'unsupported', 'a 501 capability refusal is its own kind, not a generic error');
  ok(unsup.detail.includes('no picker') && unsup.detail.includes('Type the path in Settings.'),
     'and it relays BOTH the error and the hint — the hint is the thing that keeps the ' +
     'first-run task completable on a build with no picker');

  const err = classifyPickResponse(500, { error: 'osascript exploded', hint: 'Check Privacy & Security.' });
  ok(err.kind === 'error' && err.detail.includes('Check Privacy & Security.'),
     'a 500 surfaces the error AND the recovery hint');

  const okRes = classifyPickResponse(200, { ok: true, path: '/Users/x/Second Brain' });
  ok(okRes.kind === 'switched' && okRes.path === '/Users/x/Second Brain',
     'a successful pick reports the path the server actually applied');
  ok(classifyPickResponse(200, { ok: true, path: '  /trim me  ' }).path === '/trim me',
     'and the path is trimmed');

  ok(classifyPickResponse(200, {}).kind === 'error',
     'a 200 with neither a path nor a cancel is an ERROR, never a silent success — claiming a ' +
     'switch that did not happen is the worst reply available');
  ok(classifyPickResponse(200, null).kind === 'error', 'a null body is an error, not a throw');
  ok(classifyPickResponse(200, 'not an object').kind === 'error', 'a non-object body is an error, not a throw');
  ok(classifyPickResponse(200, { ok: true, path: '   ' }).kind === 'error',
     'a whitespace-only path is not a path');
  ok(typeof classifyPickResponse(500, {}).detail === 'string' && classifyPickResponse(500, {}).detail.length > 0,
     'every non-cancel verdict carries a non-empty detail — a refusal that explains nothing is ' +
     'the v3.6.0 finding-7 shape');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  describeSwitchOutcome — the empty result is REPORTED, not repainted');
// ═══════════════════════════════════════════════════════════════════════════
{
  const good = describeSwitchOutcome('/Users/x/Second Brain', 6, '/old');
  ok(good.state === 'success', 'finding domains is a success');
  ok(good.title.includes('6 domains'), 'the count is in the title — "6 domains" is the whole answer ' +
     'to "is my knowledge base gone?"');
  ok(good.detail.includes('/Users/x/Second Brain'), 'the folder is named');
  ok(/copied|converted/.test(good.detail),
     'and the detail says nothing was copied or converted — the second fear after "is it gone"');
  ok(good.undoPath === null, 'a successful switch offers NO undo — there is nothing to undo');
  ok(describeSwitchOutcome('/p', 1, null).title.includes('1 domain') &&
     !describeSwitchOutcome('/p', 1, null).title.includes('1 domains'),
     'and it pluralises (a "1 domains" is the nit this file already fixed once, in the sidebar)');

  const bad = describeSwitchOutcome('/Users/x/Pictures', 0, '/Users/x/Knowledge');
  ok(bad.state === 'attention',
     'an empty folder is ATTENTION, not DANGER — nothing failed, and dressing a successful pick ' +
     'as an error is the mirror of the defect this release fixes');
  ok(bad.detail.includes('/Users/x/Pictures'), 'the folder that came back empty is named');
  ok(bad.detail.includes('CLAUDE.md'),
     'and the detail names WHAT WAS LOOKED FOR — the only honest way to let the user tell an ' +
     'empty knowledge base from a folder of holiday photos, which §1 proves we cannot');
  ok(/CONTAINS|contains/.test(bad.detail),
     'including the likeliest mistake: picking one domain instead of the folder holding them');
  ok(bad.undoPath === '/Users/x/Knowledge', 'and a way back is offered');

  ok(describeSwitchOutcome('/same', 0, '/same').undoPath === null,
     'no undo is offered back to the folder we are ALREADY in — a button that does nothing');
  ok(describeSwitchOutcome('/p', 0, null).undoPath === null, 'and none when there is nowhere to go back to');
  ok(describeSwitchOutcome('/p', 0, '   ').undoPath === null, 'a blank previous path is not a destination');
  ok(describeSwitchOutcome('', 0, null).detail.includes('that folder'),
     'a missing path degrades to prose rather than rendering an empty gap');
  ok(describeSwitchOutcome('/p', NaN, null).state === 'attention',
     'a count that is not a number is not treated as success');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  The whole flow, driven — and CANCEL COSTS NOTHING');
// ═══════════════════════════════════════════════════════════════════════════
{
  // CANCEL. One POST, no reload, no notice, and the config is untouched.
  __reset();
  __setState(baseState());
  __queue({ status: 200, body: { cancelled: true } });
  await onChooseKnowledgeFolder(1);
  let c = __calls();
  ok(c.fetch.length === 1 && c.fetch[0].url === '/api/config/pick-folder' && c.fetch[0].method === 'POST',
     'CANCEL: exactly one request, and it is the POST to pick-folder');
  ok(c.loadDomainsList === 0, 'CANCEL: the domain list is NOT reloaded');
  ok(__state().kbNotice === null,
     'CANCEL: and nothing is said — a user who changed their mind is not shown a report');
  ok(__state().kbBusy === false, 'CANCEL: the busy flag is released');
  ok(c.fetch[0].body === undefined,
     'the pick-folder POST carries NO body — which is why a second call site cannot hold a ' +
     'diverging copy of any rule: it holds nothing');

  // SUCCESS.
  __reset();
  __setState(baseState({ kb: { domainsPath: '/old/place', domainsPathSource: 'ui' } }));
  __setReload([{ slug: 'articles' }, { slug: 'projects' }, { slug: 'research' },
               { slug: 'business' }, { slug: 'health' }, { slug: 'music' }]);
  __queue({ status: 200, body: { ok: true, path: '/Users/x/Second Brain' } });
  await onChooseKnowledgeFolder(1);
  c = __calls();
  ok(c.loadDomainsList === 1, 'SUCCESS: the domain list is reloaded exactly once');
  ok(c.fetch.length === 1,
     'SUCCESS: and NO second request is made to "apply" the choice — pick-folder already ' +
     'mutated, so a second call would be a second writer');
  ok(__state().kbNotice.state === 'success' && __state().kbNotice.title.includes('6 domains'),
     'SUCCESS: the outcome is reported with the real count');
  ok(__state().kb.domainsPath === '/Users/x/Second Brain', 'SUCCESS: the remembered path follows');

  // Stale per-domain caches from the OLD folder must not survive. Two folders
  // can both contain a domain called `articles`; a report stamped with that
  // slug would otherwise render under the NEW folder's heading.
  __reset();
  __setState(baseState({
    kb: { domainsPath: '/old', domainsPathSource: 'ui' },
    activeSlug: 'articles',
    health: { issues: 99 }, healthSlug: 'articles', healthSummary: { articles: 99 },
    semanticScan: { slug: 'articles', pairs: [{}], previewed: new Set(['k']) },
    browse: { slug: 'articles', entries: [{}] },
  }));
  __setReload([{ slug: 'articles' }]);
  __queue({ status: 200, body: { ok: true, path: '/new' } });
  await onChooseKnowledgeFolder(1);
  const s = __state();
  ok(s.health === null && s.healthSlug === null, 'SWITCH: the old folder’s health report is dropped');
  ok(Object.keys(s.healthSummary).length === 0, 'SWITCH: the sidebar attention counts are dropped');
  ok(s.semanticScan === null,
     'SWITCH: the PAID semantic scan is dropped — unlike a domain switch this is a different ' +
     'FOLDER, so its previewed set could authorise a merge against a same-named page in another wiki');
  ok(s.browse === null, 'SWITCH: the browse listing is dropped');

  // REFUSED (409) — the cross-write guard, reached from the server.
  __reset();
  __setState(baseState());
  __queue({ status: 409, body: { error: 'An ingest is running on articles.' } });
  await onChooseKnowledgeFolder(1);
  ok(__state().kbNotice && __state().kbNotice.state === 'attention' &&
     __state().kbNotice.detail.includes('An ingest is running on articles.'),
     'REFUSED: a 409 reaches a visible surface carrying the server’s own sentence');
  ok(__calls().loadDomainsList === 0, 'REFUSED: and nothing is reloaded');

  // 501 capability refusal — the honest-difference case.
  __reset();
  __setState(baseState());
  __queue({ status: 501, body: { error: 'This install cannot open a folder picker.', hint: 'Use Settings.' } });
  await onChooseKnowledgeFolder(1);
  ok(__state().kbNotice.state === 'danger' && __state().kbNotice.detail.includes('Use Settings.'),
     'UNSUPPORTED: a build with no picker says so AND names the route that still works — the ' +
     'difference is made honestly rather than by showing a button that cannot work');

  // Transport failure.
  __reset();
  __setState(baseState());
  __queue({ throws: 'network down' });
  await onChooseKnowledgeFolder(1);
  ok(__state().kbNotice.state === 'danger' && __state().kbNotice.detail.includes('network down'),
     'THROW: a transport failure is reported, not swallowed');
  ok(__state().kbBusy === false, 'THROW: and the busy flag is still released');

  // The client-side busy gate, and its fail-OPEN direction.
  __reset();
  __setState(baseState());
  __setBusy(true);
  await onChooseKnowledgeFolder(1);
  ok(__calls().fetch.length === 0,
     'BUSY: the picker is not even opened while a write is in flight — changing the folder ' +
     'mid-write scatters that write’s remaining pages into the new one');
  ok(__state().kbNotice.state === 'attention' && /writing/i.test(__state().kbNotice.title),
     'BUSY: and the user is told why, rather than the click doing nothing');

  __reset();
  __setState(baseState());
  __setBusyThrows(true);
  __queue({ status: 200, body: { cancelled: true } });
  await onChooseKnowledgeFolder(1);
  ok(__calls().fetch.length === 1,
     'BUSY GATE THROWS: fails OPEN — the server carries the real guard, and a broken client ' +
     'predicate must never be able to lock a user out of the action that makes their wiki visible');

  // Re-entrancy: a second click while the picker is open must not queue a
  // second dialog.
  __reset();
  __setState(baseState({ kbBusy: true }));
  await onChooseKnowledgeFolder(1);
  ok(__calls().fetch.length === 0, 'a second click while the picker is open is a no-op');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  Undo — and the server’s validation is not pre-empted');
// ═══════════════════════════════════════════════════════════════════════════
{
  __reset();
  __setState(baseState({ kb: { domainsPath: '/Users/x/Pictures', domainsPathSource: 'ui' } }));
  __setReload([{ slug: 'articles' }, { slug: 'projects' }]);
  __queue({ status: 200, body: { ok: true, domainsPath: '/Users/x/Knowledge' } });
  await onUndoKnowledgeFolder('/Users/x/Knowledge', 1);
  const c = __calls();
  ok(c.fetch.length === 1 && c.fetch[0].url === '/api/config/domains-path' && c.fetch[0].method === 'POST',
     'undo goes through the EXISTING POST /api/config/domains-path — no new endpoint');
  ok(JSON.parse(c.fetch[0].body).path === '/Users/x/Knowledge',
     'and sends exactly the captured previous path, nothing else');
  ok(Object.keys(JSON.parse(c.fetch[0].body)).length === 1,
     'the body has exactly one key — it cannot smuggle any other config change');
  ok(__state().kbNotice.state === 'success' && __state().kbNotice.title.includes('2 domains'),
     'and the result of going back is itself reported');

  // The refusal that must survive: the previous folder can genuinely be gone
  // (an ejected drive is the whole reason someone lands here).
  __reset();
  __setState(baseState());
  __queue({ status: 400, body: { error: 'Folder does not exist: /Volumes/Ejected/Knowledge' } });
  await onUndoKnowledgeFolder('/Volumes/Ejected/Knowledge', 1);
  ok(__calls().loadDomainsList === 0, 'a REFUSED undo does not reload anything');
  ok(__state().kbNotice.state === 'danger' &&
     __state().kbNotice.detail.includes('Folder does not exist: /Volumes/Ejected/Knowledge'),
     'and the server’s own refusal is shown verbatim — the client never second-guesses it, ' +
     'so whatever the route refuses today it still refuses');

  __reset();
  __setState(baseState());
  await onUndoKnowledgeFolder('', 1);
  ok(__calls().fetch.length === 0, 'an empty undo target makes no request at all');

  // A load error after a switch keeps the way back.
  __reset();
  __setState(baseState({ kb: { domainsPath: '/before', domainsPathSource: 'ui' } }));
  __setReload([], 'EACCES: permission denied');
  __queue({ status: 200, body: { ok: true, path: '/locked' } });
  await onChooseKnowledgeFolder(1);
  ok(__state().kbNotice.state === 'danger' && __state().kbNotice.undoPath === '/before',
     'a folder that cannot be READ is a danger AND still offers the way back — the one state ' +
     'where a user is most stuck');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  THE TRAP: the route must survive the wrong click');
// ═══════════════════════════════════════════════════════════════════════════
{
  // If this affordance lived only on the empty card, an existing user pressing
  // "New domain" would make the list non-empty, DESTROY the empty card, and
  // take the only route to their real wiki with it.
  const branches = [
    ['still loading', { loaded: false, loadError: null, domains: [], readonlySet: new Set(), healthSummary: {}, activeSlug: null }],
    ['load error', { loaded: true, loadError: 'ENOENT', domains: [], readonlySet: new Set(), healthSummary: {}, activeSlug: null }],
    ['zero domains', { loaded: true, loadError: null, domains: [], readonlySet: new Set(), healthSummary: {}, activeSlug: null }],
    ['a populated list', { loaded: true, loadError: null, healthSummary: {}, activeSlug: 'a',
      readonlySet: new Set(), domains: [{ slug: 'a', displayName: 'A', pageCount: 3 }] }],
  ];
  for (const [label, st] of branches) {
    __reset();
    __setState(Object.assign(baseState(), st));
    renderSidebar(1);
    const html = __calls().sidebar.join('');
    ok(html.includes('dm-kb-choose-btn'),
       'the sidebar offers "use existing folder" when ' + label +
       ' — the route survives every state, including the one the wrong click produces');
  }

  // And the create path is not demoted anywhere: the sidebar keeps a
  // primary-styled New domain button in the same states.
  __reset();
  __setState(baseState());
  renderSidebar(1);
  const emptyHtml = __calls().sidebar.join('');
  ok(/id="dm-new-domain-btn"/.test(emptyHtml) && /btn-primary[^"]*dm-new-btn/.test(emptyHtml),
     'and "New domain" keeps its PRIMARY styling in the sidebar — which is what lets the empty ' +
     'card make the other action primary without demoting the create path anywhere on screen');

  // The buttons are actually WIRED. A binder that covers one control and not
  // the other leaves a live-looking button dead.
  __reset();
  __setState(baseState());
  __node('dm-new-domain-btn'); __node('dm-kb-choose-btn');
  bindSidebarButtons();
  ok(__calls().listeners.includes('dm-new-domain-btn:click'), 'New domain is wired');
  ok(__calls().listeners.includes('dm-kb-choose-btn:click'), 'Use existing folder is wired');

  __reset();
  __setState(baseState({ kbNotice: { state: 'attention', title: 't', detail: 'd', undoPath: '/back' } }));
  __node('dm-empty-kb-btn'); __node('dm-kb-undo-btn');
  bindKnowledgeListeners();
  ok(__calls().listeners.includes('dm-empty-kb-btn:click'), 'the empty-card folder button is wired');
  ok(__calls().listeners.includes('dm-kb-undo-btn:click'), 'the undo button is wired');

  // Stale target. The undo button captures its destination at BIND time; a
  // later notice must not redirect a button the user is already looking at.
  __reset();
  __setState(baseState({ kbNotice: { state: 'attention', title: 't', detail: 'd', undoPath: '/first' } }));
  const undoNode = __node('dm-kb-undo-btn');
  bindKnowledgeListeners();
  __setState(baseState({ kbNotice: { state: 'attention', title: 't', detail: 'd', undoPath: '/SOMEWHERE-ELSE' } }));
  __queue({ status: 200, body: { ok: true, domainsPath: '/first' } });
  __setReload([{ slug: 'x' }]);
  await undoNode.on_click();
  ok(JSON.parse(__calls().fetch[0].body).path === '/first',
     'the undo button goes where the notice that RENDERED it said, not where a later notice says — ' +
     'the same captured-target discipline the compile card uses for its conversation id');

  __reset();
  __setState(baseState({ kbNotice: { state: 'success', title: 't', detail: 'd', undoPath: null } }));
  __node('dm-kb-undo-btn');
  bindKnowledgeListeners();
  ok(!__calls().listeners.includes('dm-kb-undo-btn:click'),
     'and a notice with no undo path wires no undo handler even if a stale node is present');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  Rendering: escaped, honest, and never silent');
// ═══════════════════════════════════════════════════════════════════════════
{
  const HOSTILE = '<img src=x onerror=alert(1)>';
  __setState(baseState({ kbNotice: { state: 'attention', title: HOSTILE, detail: HOSTILE, undoPath: HOSTILE } }));
  const html = renderKnowledgeNotice();
  ok(html.includes('&lt;img') && !html.includes('<img src=x'),
     'a path and a server message are escaped before they reach the DOM');
  ok(html.includes('tx-status-attention'), 'the tone reaches the shared status role');
  ok(html.includes('dm-kb-undo-btn'), 'and the undo button renders when there is a path');

  __setState(baseState({ kbNotice: null }));
  ok(renderKnowledgeNotice() === '', 'no outcome, no box');

  __setState(baseState({ kb: { domainsPath: '/Users/x/K', domainsPathSource: 'ui' } }));
  ok(renderLookedInLine().includes('/Users/x/K') && renderLookedInLine().includes('dm-kb-path'),
     '"Looking in <path>" names the folder — the line that turns "my wiki is gone" into ' +
     '"wrong folder"');
  __setState(baseState({ kb: null }));
  ok(renderLookedInLine() === '',
     'and it renders NOTHING when the config read failed — an invented path is worse than none');

  __setState(baseState({ kbBusy: true }));
  ok(knowledgeFolderBtn().includes('disabled') && /picker/i.test(knowledgeFolderBtn()),
     'while the picker is open the button is disabled AND says what it is waiting for');
  __setState(baseState({ kbBusy: false }));
  ok(!knowledgeFolderBtn().includes('disabled'), 'and enabled otherwise');
  ok(/class="btn btn-secondary/.test(knowledgeFolderBtn()),
     'it is a plain .btn, so it inherits shell.css’s press, disabled and reduced-motion rules ' +
     'rather than introducing a new interaction vocabulary');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  Source discipline — no new server capability, no mode branch');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Every endpoint this view now touches, and nothing else new.
  const endpoints = [...src.matchAll(/['"`](\/api\/[a-z0-9/:._${}-]+)['"`]/gi)].map((m) => m[1]);
  ok(endpoints.includes('/api/config/pick-folder'), 'the view calls the EXISTING pick-folder route');
  ok(endpoints.includes('/api/config/domains-path'), 'and the EXISTING domains-path route for undo');
  ok(!/\/api\/config\/[a-z-]*(folder|domains-path)[a-z-]+/i.test(src),
     'and no invented sibling of either — this change adds no server capability');

  // A route may branch on a CAPABILITY, never on the install mode; a VIEW must
  // not branch on either. The 501 refusal is how the difference reaches the user.
  ok(!/getInstallMode|installMode|isBundleInstall/.test(src),
     'the view never reads the install mode');
  ok(!/folderPickerStyle|getCapabilities/.test(src),
     'and never reads a capability either — it asks the server and renders what comes back, ' +
     'which is what makes the browser install and the packaged app one code path');

  // pick-folder is the mutation. The client must never think it needs a
  // second call to apply the choice.
  const chooseFn = extractFunction(src, 'onChooseKnowledgeFolder');
  ok(!chooseFn.includes('domains-path'),
     'the pick path never calls domains-path — pick-folder sets the directory itself, and a ' +
     'second write would be a second writer racing the first');

  // No client-side re-implementation of the server's own validation.
  const undoFn = extractFunction(src, 'onUndoKnowledgeFolder');
  ok(!/existsSync|\.exists\(|isAbsolute|startsWith\('\//.test(undoFn),
     'and the undo path is not validated client-side — the server refuses a folder that is ' +
     'gone, and duplicating that check is how two copies of a guard drift');

  ok(!/location\.reload|window\.location\s*=/.test(src),
     'nothing reloads the page after a switch — §1 measured that it is unnecessary, and a ' +
     'reload would throw away every other view’s state to solve a problem that does not exist');

  // CSS: spacing and wrapping only.
  const stripped = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(stripped.includes('.dm-kb-'), 'the comment-stripping control works — the new rules survive it');
  const kbRules = stripped.split('}').filter((r) => /\.dm-kb-|\.dm-empty-(lines|actions)/.test(r));
  ok(kbRules.length >= 6, 'and all of the new rules are found (' + kbRules.length + ')');
  const offending = kbRules.filter((r) => /(^|[;{\s])(color|background|font|font-size|border|box-shadow)\s*:/.test(r));
  ok(offending.length === 0,
     'none of them declares a colour, type, border or shadow — the property that keeps the new ' +
     'controls inheriting shell.css’s press/disabled/reduced-motion rules, and keeps a focusable ' +
     'control free of a shadow that would fight the global :focus-visible ring');
  ok(!/\.tx-/.test(stripped.split('\n').filter((l) => /dm-kb|dm-empty/.test(l)).join('\n')),
     'and none of them names a tx- role — shared/text.css owns that prefix outright');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9  The first-run panel stops telling an existing user to start over');
// ═══════════════════════════════════════════════════════════════════════════
{
  const stepBlock = /domain:\s*\{[\s\S]*?\n  \},/.exec(onbSrc);
  ok(!!stepBlock, 'the domain step is found in STEP_COPY');
  const block = stepBlock ? stepBlock[0] : '';
  ok(/[Aa]lready have/.test(block),
     'step 2 now names the existing-user case — it used to say only "Create your first domain", ' +
     'which is the wrong advice for the exact person this release exists for');
  ok(/[Ss]tarting fresh|[Cc]reate a domain/.test(block),
     'and still names the create path — both routes, neither hidden');
  ok(/action: 'Open Domains'/.test(block),
     'and the action is UNCHANGED — the panel points at the view that owns both routes');

  ok(!/method:\s*'POST'|fetch\([^)]*\{\s*method/.test(onbSrc),
     'the panel still POSTs NOTHING — a folder-switching call site inside a first-run panel ' +
     'that has never mutated anything would be a new write path, not a copy edit');
  ok(/STEP_ORDER = \['api-key', 'domain', 'ingest'\]/.test(onbSrc),
     'and STEP_ORDER is untouched — nothing works without a model, so the key still comes first');
}

console.log('\n' + '─'.repeat(56));
console.log(`  ${passed} passed · ${failed} failed`);
console.log('─'.repeat(56));
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
process.exit(0);
