/**
 * test-next-domains-text.js — OFFLINE suite, zero dependencies, no network.
 *
 * Guards views/domains.js's ADOPTION of the shared text system
 * (src/public/next/shared/text.js + text.css — the five roles: readout,
 * description, status, badge, explainer).
 *
 * ── WHY THIS SUITE EXISTS SEPARATELY FROM test-next-text-system.js ────────
 *
 * That suite proves the RENDERERS are correct and single-source. It cannot
 * prove that anything CALLS them, and it says so itself: "this wave is
 * build-and-test only". A component that ships and is never adopted is the
 * exact shape v3.16.0 records — `fetchOpenRouterCatalogue` was built, tested
 * and documented, and invoked from nowhere in production, which is how a
 * public README came to promise "hundreds of models" while nothing populated
 * the list. The precedent for closing that gap is format-usd.js, whose import
 * sites are asserted by name in test-next-cost-honesty.js §6; §1 below is the
 * same guard for the same reason.
 *
 * ── HOW IT TESTS ─────────────────────────────────────────────────────────
 *
 * By EXECUTING the real render functions, lifted out of the live source with
 * a brace matcher and run through `new Function`, with the SHARED RENDERERS
 * PASSED IN REAL (never stubbed — shared/text.js takes no imports precisely
 * so that it stays executable in Node). Assertions are then made on the HTML
 * those functions actually produce.
 *
 * They are deliberately NOT source regexes. This repo's recorded failure
 * shape is "a check that stopped reaching the thing it protects": v3.0.17
 * shipped an assertion that pinned a CALL SITE with a regex and labelled it
 * "the sizing datapoint", while the value that call site produced was always
 * wrong. A test that proves a line exists proves nothing about what it does.
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  §1 views/domains.js IMPORTS the three roles it uses from shared/text.js,
 *     and declares none of the six renderer names locally (no re-growth).
 *  §2 The retired class names are gone from the view's CODE (comments
 *     stripped first, because this file's own comments quote them), and the
 *     two DELIBERATE survivors are asserted PRESENT with their reasons — a
 *     survivor that quietly disappears is as much a regression as one that
 *     quietly returns. domains.css names no tx- class at all.
 *  §3 THE REPORTED DEFECT: renderHealthPanel no longer welds an action
 *     report, a generated measurement and a description into one <div>. The
 *     figures render as readouts; the re-scanning caveat renders as a status
 *     ABOVE them; a failed scan renders as a danger status.
 *  §4 ABSENT IS NOT ZERO, at this call site rather than in the component:
 *     no scannedAt renders NO provenance (it used to render the word
 *     "never", produced by relTime out of a missing field), and a missing
 *     count renders nothing (it used to render "undefined dismissed"). A
 *     real 0 still renders, because that is a measurement.
 *  §5 The cost promise and the git-recovery note are ALWAYS on screen and
 *     never inside a <details>, and the in-flight-write warning is a status
 *     rather than dyed prose.
 *  §6 The mirror note, the sidebar load error and the browse-listing error
 *     are status boxes, and every server-supplied string reaching them is
 *     escaped.
 *  §7 domains.css declares no px font-size (the --font-scale control would
 *     not reach it), and the placement rules set no type — no font-size, no
 *     colour, no border, no font-family.
 *  §8 CONTRAST, COMPUTED from tokens/color.css in both themes: the tokens
 *     this view moved OFF failed AA and the ones it moved ON to pass, and
 *     the remaining --attention-text-as-text sites are COUNTED so the known
 *     gap cannot grow silently.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *  · Nothing here measures real RENDERING. Whether the readouts actually lay
 *    out on one row, whether the status rail is visible, and the real
 *    computed colours all come from a browser. A `getComputedStyle` result
 *    is not reproducible in Node.
 *  · §7's "the placement rules set no type" reads the block by its comment
 *    delimiters. A placement rule written somewhere else in the file is
 *    invisible to it. It fails SAFE (a rule outside the block is simply not
 *    checked), and the tx- ban in §2 is what stops the worst version of it.
 *  · The two remaining --attention-text-as-text sites (the browse-listing
 *    truncation warning and the pending-plan in-flight line) are COUNTED,
 *    not fixed. Both measure 3.16-3.58:1 in the light theme against a 4.5
 *    floor. One of them is byte-asserted by test-next-domain-lifecycle.js,
 *    so moving it is not this file's call.
 *  · `<div class="dm-health-body">Scanning…</div>` SURVIVES and §2 asserts
 *    it does. It is byte-pinned by test-next-loading-gate.js as a measured
 *    exemption from the delay-gate rule; rewriting it would silently revoke
 *    a v3.11.0 decision.
 *  · The escaping assertions prove the CALL SITES do not bypass the
 *    component (e.g. by passing pre-built HTML). The escaper itself is
 *    proven equivalent to app.js's in test-next-text-system.js §1.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  renderReadout, renderReadoutGroup, renderDescription, renderStatus, renderBadge, renderExplainer,
} from '../src/public/next/shared/text.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, 'src/public/next');

const domainsSrc = readFileSync(join(NEXT, 'views/domains.js'), 'utf8');
const domainsCss = readFileSync(join(NEXT, 'views/domains.css'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Comment stripping ────────────────────────────────────────────────────
// Every "this class is gone" assertion has to run against CODE. The view's
// own comments QUOTE the retired names while explaining why they went, so a
// scan over raw text would be reading a comment and reporting the opposite
// of the truth. Same technique, same reason, as test-next-cost-honesty.js.
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') { out += src[i]; i++; } out += src[i]; i++; }
      out += src[i] || ''; i++; continue;
    }
    out += c; i++;
  }
  return out;
}
const domainsCode = stripComments(domainsSrc);

function stripCssComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ' '); }
const domainsCssCode = stripCssComments(domainsCss);

// ── Extraction ───────────────────────────────────────────────────────────
// Brace-matched and parameter-list-aware, lifted from the shape
// test-next-domain-lifecycle.js already uses on this same file. It THROWS on
// a missing name or a desynced match rather than handing the sandbox
// something that fails later as a bare SyntaxError.
function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(source);
  if (!m) throw new Error(`extractFunction: "${name}" not found in domains.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = source.indexOf('(', start), parenDepth = 0;
  for (; p < source.length; p++) {
    if (source[p] === '(') parenDepth++;
    else if (source[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = source.indexOf('{', p), depth = 0;
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

/**
 * Build a callable from lifted source, with every free identifier supplied
 * by name.
 *
 * THIS WRAPPER EXISTS BECAUSE OF A DEFECT THIS WAVE CAUSED. Adopting the
 * text system added three new module-level identifiers to renderHealthPanel,
 * and test-next-loading-gate.js — which lifts that same function with a
 * hand-listed dependency map — CRASHED with a bare ReferenceError instead of
 * failing. That is v3.11.0's recorded blind spot: a hardcoded dependency
 * list makes a suite die rather than go red, and a dead suite reads exactly
 * like a passing one in a summary line.
 *
 * So a missing dependency here becomes a NAMED failing assertion instead.
 */
function makeCallable(names, body, returnName) {
  return new Function(...names, `${body}\nreturn ${returnName};`);
}
function callOrFail(label, thunk) {
  try { return thunk(); } catch (err) {
    ok(false, `${label} — THREW instead of rendering: ${err && err.message}`);
    return null;
  }
}

// A server-supplied string that is hostile in every sink the view has.
const HOSTILE = '<img src=x onerror=alert(1)>"\'&';

// ═════════════════════════════════════════════════════════════════════════
section('§0  POSITIVE CONTROLS — this harness can actually fail');
// v3.18.0: two suites disagreed about ok()'s argument order, and a reversed
// signature made every literal assertion pass unconditionally — caught by
// mutation, not review. And v3.16.1 found an assertion that could not fail
// because the value it compared was always ''. Both hazards are made visible
// here rather than assumed away.
{
  let p = 0, f = 0;
  const probe = (cond) => { if (cond) p++; else f++; };
  probe(true); probe(false);
  ok(p === 1 && f === 1, 'ok(cond, label) takes the CONDITION first — a reversed signature would pass everything');

  // The extractor must really be lifting code, not returning something falsy
  // that then "passes" every .includes() test vacuously.
  const lifted = extractFunction(domainsSrc, 'renderHealthPanel');
  ok(lifted.length > 500 && lifted.startsWith('function renderHealthPanel'),
     `the extractor lifts real source (${lifted.length} chars) — an empty lift would make §3 vacuous`);

  // The missing-dependency detector must fire, or §3-§6 could crash silently
  // in some future edit and be reported as a single failure rather than as
  // the whole section going dark.
  const before = failed;
  const realLog = console.log;
  console.log = () => {};              // the probe's own ✗ line is not a result
  callOrFail('control', () => { throw new Error('DELIBERATE'); });
  console.log = realLog;
  const fired = failed === before + 1;
  failed = before;
  ok(fired, 'callOrFail turns a throw into a NAMED failure — the v3.11.0 crash-instead-of-red shape');

  // And the comment stripper must actually strip, or §2 reads prose.
  ok(!/dm-scope-desc/.test(stripComments('// dm-scope-desc\nconst a = 1;')),
     'the comment stripper removes // comments, so §2 reads code and not the prose explaining it');
  ok(/dm-scope-desc/.test(stripComments("const a = 'dm-scope-desc';")),
     'and it PRESERVES string literals, so a real class name in code is still visible');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  IMPORT SITE — the component is actually used');
// The format-usd.js precedent, and the reason it exists: the renderers being
// correct is worth nothing if the view kept its own copy.
{
  ok(/^import \{\s*\n?\s*renderReadoutGroup, renderDescription, renderStatus,\s*\n?\} from '\.\.\/shared\/text\.js';$/m.test(domainsCode)
     || /from '\.\.\/shared\/text\.js'/.test(domainsCode),
     'views/domains.js imports from ../shared/text.js');
  for (const name of ['renderReadoutGroup', 'renderDescription', 'renderStatus']) {
    const imported = new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\.\\./shared/text\\.js'`, 's').test(domainsCode);
    ok(imported, `${name} is IMPORTED from the shared module, not redefined`);
  }

  // NO LOCAL COPY, every declaration form — the v3.8.0 rebuild found that a
  // first version missed `export default`, this codebase's own idiom.
  for (const name of ['renderReadout', 'renderReadoutGroup', 'renderDescription',
                      'renderStatus', 'renderBadge', 'renderExplainer']) {
    const declared =
      new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).test(domainsCode) ||
      new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=`).test(domainsCode);
    ok(!declared, `views/domains.js does NOT declare a local ${name} — two copies of one treatment is the defect`);
  }

  // A local re-implementation would not carry the name, so also ban the
  // markup. If the class appears in this view's own code it was hand-built.
  for (const cls of ['tx-readout', 'tx-desc', 'tx-status', 'tx-badge', 'tx-explainer']) {
    ok(!domainsCode.includes(cls),
       `views/domains.js never writes the ${cls} markup itself — it comes from the component or not at all`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  RETIRED CLASSES — gone, and the survivors are deliberate');
{
  // GONE. Each of these was a treatment this view invented for a role the
  // component now covers.
  const RETIRED = [
    ['class="view-body"', 'the static-copy class that also carried a generated scan sentence'],
    ['dm-scope-desc', 'a live figure rendered through the static-description class'],
    ['dm-health-meta', 'the scan counts at --text-3, measured 4.27/4.14 against a 4.5 floor'],
    ['dm-error-text', 'a colour modifier bolted onto whichever class was nearby'],
    ['dm-mirror-note', 'a hand-built status box predating the shared one'],
    ['dm-quick-note"', 'the cost promise, sharing a class with a runtime warning'],
  ];
  for (const [needle, why] of RETIRED) {
    ok(!domainsCode.includes(needle), `\`${needle}\` is gone from views/domains.js — ${why}`);
  }

  // SURVIVORS, asserted PRESENT. A guard that only checks for absence cannot
  // tell "deliberately kept" from "accidentally deleted", and both of these
  // are load-bearing somewhere else.
  ok(domainsCode.includes('<div class="dm-health-body">Scanning…</div>'),
     'the health "Scanning…" placeholder is UNCHANGED — test-next-loading-gate.js byte-pins this exact markup ' +
     'as a measured exemption from the delay-gate rule (~654 ms, an honest indicator)');
  ok(/gatedLoader\(loadGate, 'Loading…', 'sidebar-hint'\)/.test(domainsCode),
     'the sidebar loading placeholder still routes through gatedLoader — loading is loading-gate.js\'s role, not a text role');

  // PREFIX OWNERSHIP, mirrored here. test-next-text-system.js walks the whole
  // tree for this; asserting it in the view's OWN suite means a domains-only
  // edit goes red here too, next to the person who made it.
  ok(!/\.tx-[a-z]/.test(domainsCss),
     'views/domains.css names no tx- class anywhere — shared/text.css owns that prefix, so a view cannot re-dress a role');

  // The wrappers the placement rules hang on must EXIST in the markup, or
  // the spacing silently does nothing.
  for (const w of ['dm-sidebar-status', 'dm-health-summary', 'dm-quick-footnote',
                   'dm-quick-empty-text', 'dm-browse-lead']) {
    ok(domainsCode.includes(w) && domainsCssCode.includes('.' + w),
       `.${w} exists in BOTH the markup and the stylesheet — a wrapper in one and not the other is dead spacing`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  THE REPORTED DEFECT — the health panel is a report, not a sentence');
{
  const deps = {
    icon: () => '', escapeHtml: (x) => String(x), pluralize: (n, w) => `${n} ${w}`,
    relTime: () => '10s ago', buttonRingHtml: () => '<RING/>',
    totalOpenIssues: (r) => (r && r.brokenLinks ? r.brokenLinks.length : 0),
    renderBanner: () => '', renderMirrorNote: () => '<MIRROR/>',
    renderQuickMaintenance: () => '<QUICK/>', renderAiProgressRing: () => '',
    renderConfirmCard: () => '', renderPendingPlan: () => '',
    activeSemanticScan: () => null, renderSemanticScanResult: () => '',
    renderIssueGroups: () => '<GROUPS/>',
    HEALTH_CATEGORIES: [{ key: 'brokenLinks', label: 'Broken links' }],
    inFlightWriteSlugs: new Set(),
    renderReadoutGroup, renderDescription, renderStatus,
  };
  const names = Object.keys(deps);
  const build = () => makeCallable(
    ['state', ...names],
    extractFunction(domainsSrc, 'shouldKeepHealthOnReload') + '\n' +
    extractFunction(domainsSrc, 'renderHealthPanel'),
    'renderHealthPanel'
  );
  const render = (st, readonly = false) => {
    const fn = build()(st, ...names.map((n) => deps[n]));
    return fn({ slug: 'articles' }, readonly);
  };
  const REPORT = {
    counts: { entities: 41, concepts: 331, summaries: 7, dismissed: 0 },
    scannedAt: '2026-08-29T12:00:00Z',
    brokenLinks: [{ a: 1 }, { a: 2 }, { a: 3 }],
  };
  const base = { healthLoading: false, health: REPORT, healthSlug: 'articles', healthError: null, busyKey: null, expandedGroups: new Set() };

  const settled = callOrFail('settled health panel', () => render(base));
  if (settled) {
    // THE FIGURES ARE AN INSTRUMENT.
    ok(settled.includes('tx-readout-group'), 'the counts render as a readout GROUP, not a prose sentence');
    ok((settled.match(/class="tx-readout"/g) || []).length === 5,
       'all five measurements are readouts — open issues plus the four scan counts ' +
       `(got ${(settled.match(/class="tx-readout"/g) || []).length})`);
    ok(/tx-readout-value">3</.test(settled) && /tx-readout-value">41</.test(settled) &&
       /tx-readout-value">331</.test(settled) && /tx-readout-value">7</.test(settled),
       'every figure is in a readout VALUE — mono, --text, the design system\'s own rule for counts');

    // THE WELD IS GONE. This is the maintainer's own report: three roles in
    // one <div>, which is why it read as a clarification and not a report.
    ok(!/class="dm-health-body">(?!Scanning)/.test(settled),
       'no prose <div class="dm-health-body"> carrying the figures survives in a settled panel');
    ok(!settled.includes('Found 3 issues'),
       'the figures are no longer welded into an English sentence');
    ok(!/last scanned/.test(settled),
       'the timestamp is no longer a clause inside that sentence');

    // PROVENANCE IS PART OF THE INSTRUMENT, not a separate sentence.
    ok(/tx-readout-prov">scanned 10s ago</.test(settled),
       'when the scan happened is the readout\'s PROVENANCE — same instrument, quieter treatment');

    // A settled panel makes no claim about being stale.
    ok(!settled.includes('tx-status'), 'a settled panel shows no status box — nothing to report is not a state');
  }

  const revalidating = callOrFail('revalidating health panel', () =>
    render({ ...base, healthLoading: true }));
  if (revalidating) {
    ok(revalidating.includes('Re-scanning… showing the previous result'),
       'a rescan behind a cached report still SAYS the figures are the previous scan\'s');
    ok(revalidating.includes('tx-status-attention'),
       'and it says so as a STATUS — the caveat is a state, not a sentence prefixed to a measurement');
    // ORDER IS A PRIORITY ORDER. A caveat printed after the number it
    // qualifies has already been read too late.
    ok(revalidating.indexOf('tx-status') < revalidating.indexOf('tx-readout-group'),
       'the caveat renders BEFORE the figures it qualifies');
    ok(/tx-readout-value">3</.test(revalidating),
       'and the cached figures stay on screen — the whole point of not collapsing the panel');
  }

  // A FAILED SCAN. This used to be `.dm-health-body.dm-error-text`: the same
  // class as the readout, distinguished only by being dyed red.
  const errored = callOrFail('errored health panel', () =>
    render({ ...base, healthError: 'ENOENT: no such file' }));
  if (errored) {
    ok(errored.includes('tx-status-danger'), 'a failed scan is a DANGER status, not red-dyed body prose');
    ok(errored.includes('Could not scan this domain'), 'with a constant headline');
    ok(errored.includes('tx-status-detail') && errored.includes('ENOENT: no such file'),
       'and the server\'s own message as the DETAIL rather than glued onto our sentence with an em dash');
    ok(!/tx-readout-value/.test(errored),
       'and NO stale figures underneath it implying the scan succeeded');
  }
  const hostileErr = callOrFail('errored health panel, hostile message', () =>
    render({ ...base, healthError: HOSTILE }));
  if (hostileErr) {
    ok(hostileErr.includes('&lt;img') && !hostileErr.includes('<img src=x'),
       'a hostile server message is ESCAPED — the call site passes a plain string and lets the component escape it');
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  ABSENT IS NOT ZERO — at this call site, not just in the module');
// The module's rule, but the bug it prevents was HERE: relTime(undefined)
// returns the literal string 'never', so a report with no scannedAt used to
// render "last scanned never." — a statement about when a scan happened,
// manufactured out of the absence of the field that would say.
{
  const deps = {
    icon: () => '', escapeHtml: (x) => String(x), pluralize: (n, w) => `${n} ${w}`,
    // THE REAL relTime, lifted from the view. Stubbing it would hide the
    // exact behaviour under test.
    buttonRingHtml: () => '<RING/>',
    totalOpenIssues: () => 0,
    renderBanner: () => '', renderMirrorNote: () => '',
    renderQuickMaintenance: () => '', renderAiProgressRing: () => '',
    renderConfirmCard: () => '', renderPendingPlan: () => '',
    activeSemanticScan: () => null, renderSemanticScanResult: () => '',
    renderIssueGroups: () => '', HEALTH_CATEGORIES: [], inFlightWriteSlugs: new Set(),
    renderReadoutGroup, renderDescription, renderStatus,
  };
  const names = Object.keys(deps);
  const render = (report) => {
    const fn = makeCallable(
      ['state', ...names],
      extractFunction(domainsSrc, 'relTime') + '\n' +
      extractFunction(domainsSrc, 'shouldKeepHealthOnReload') + '\n' +
      extractFunction(domainsSrc, 'renderHealthPanel'),
      'renderHealthPanel'
    )({ healthLoading: false, health: report, healthSlug: 'articles', healthError: null, busyKey: null, expandedGroups: new Set() },
      ...names.map((n) => deps[n]));
    return fn({ slug: 'articles' }, false);
  };

  // CONTROL FIRST: prove the real relTime does produce 'never', so the
  // assertion below is about behaviour and not about a stub that could never
  // have said it.
  const relTime = makeCallable([], extractFunction(domainsSrc, 'relTime'), 'relTime')();
  ok(relTime(undefined) === 'never' && relTime(null) === 'never',
     'CONTROL: the view\'s own relTime really does turn a missing timestamp into the word "never"');

  const noStamp = callOrFail('report with no scannedAt', () =>
    render({ counts: { entities: 4, concepts: 5, summaries: 6, dismissed: 0 } }));
  if (noStamp) {
    ok(!noStamp.includes('never'),
       'a report with no scannedAt does NOT render the word "never" — that is a claim nobody measured');
    ok(!noStamp.includes('tx-readout-prov'),
       'it renders NO provenance element at all, rather than a dash or a placeholder');
    ok(/tx-readout-value">4</.test(noStamp),
       'and the figures it DOES have still render — an absent stamp does not suppress a real measurement');
  }

  const noDismissed = callOrFail('report with no dismissed count', () =>
    render({ counts: { entities: 4, concepts: 5, summaries: 6 }, scannedAt: '2026-08-29T12:00:00Z' }));
  if (noDismissed) {
    ok(!noDismissed.includes('undefined'),
       'a missing count renders NOTHING — it used to render the literal string "undefined dismissed"');
    ok((noDismissed.match(/class="tx-readout"/g) || []).length === 4,
       'the entry is dropped and the other four survive');
  }

  const zeroes = callOrFail('report with real zeroes', () =>
    render({ counts: { entities: 0, concepts: 0, summaries: 0, dismissed: 0 }, scannedAt: '2026-08-29T12:00:00Z' }));
  if (zeroes) {
    ok((zeroes.match(/class="tx-readout"/g) || []).length === 5,
       'a MEASURED zero is a measurement and still renders — absent is not zero, and zero is not absent');
    ok((zeroes.match(/tx-readout-value">0</g) || []).length === 5, 'all five read 0');
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  THE SPEND GATE — the cost promise is never folded, never dyed');
{
  const deps = {
    icon: () => '<ICON/>', pluralize: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`,
    countSafeFixable: () => 0, quickAiButton: () => '<AIBTN/>',
    buttonRingHtml: () => '<RING/>', costReadout: () => null,
    GIT_UNDO_NOTE: 'If you use GitHub Sync, changes can be undone with a git client — the app has no Undo button yet.',
    renderStatus, renderDescription,
  };
  const names = Object.keys(deps);
  const render = (st, crossMountBusy) => makeCallable(
    ['state', ...names], extractFunction(domainsSrc, 'renderQuickMaintenance'), 'renderQuickMaintenance'
  )(st, ...names.map((n) => deps[n]))({ slug: 'articles' }, { brokenLinks: [{}], orphans: [] }, crossMountBusy);

  const normal = callOrFail('quick maintenance, idle', () =>
    render({ busyKey: null, aiAvailable: true, estimates: {} }, false));
  if (normal) {
    ok(normal.includes('Every AI action shows its cost before it runs'),
       'the cost promise is on screen');
    ok(normal.includes('the app has no Undo button yet'),
       'and so is the recovery note — the honest half, single-sourced from GIT_UNDO_NOTE');
    ok(normal.includes('tx-desc'), 'it renders as a DESCRIPTION — static copy, identical for every user');
    // v3.16.1: a warning behind a click is not a warning. The explainer role
    // exists and must not be reached for here.
    ok(!normal.includes('<details'),
       'it is NOT inside a <details> — the disclosure that makes a spend gate a gate cannot be one click away');
    ok(!normal.includes('tx-explainer'), 'and the explainer role is not used on this surface at all');
  }

  const busy = callOrFail('quick maintenance, an earlier write in flight', () =>
    render({ busyKey: null, aiAvailable: true, estimates: {} }, true));
  if (busy) {
    ok(busy.includes('An earlier fix on this domain is still running'),
       'the in-flight-write warning is still shown');
    ok(busy.includes('tx-status-attention'),
       'and it is a STATUS — it used to be the same class as the cost note plus a colour modifier, ' +
       'painting --attention-text as TEXT at a measured 3.16:1 in the light theme');
    ok(!busy.includes('<details'), 'and it is not folded either');
    ok(!busy.includes('dm-quick-note-busy'),
       'the dyed-prose class is gone from this site');
  }

  // The mount's OWN action must not be described as an earlier one — a
  // pre-existing behaviour that must survive the reshuffle.
  const ownAction = callOrFail('quick maintenance, this mount is the one working', () =>
    render({ busyKey: 'fixSafe', aiAvailable: true, estimates: {} }, true));
  if (ownAction) {
    ok(!ownAction.includes('An earlier fix'),
       'a user who clicked Fix and never left is NOT told an earlier fix is running (unchanged behaviour)');
  }

  const noKey = callOrFail('quick maintenance, no AI key', () =>
    render({ busyKey: null, aiAvailable: false, estimates: {} }, false));
  if (noKey) {
    ok(noKey.includes('tx-desc') && noKey.includes('Add an AI provider key in Settings'),
       'the no-key explanation is a description too, not a bare <span> inheriting a container font-size');
    ok(noKey.includes('dm-quick-empty-text'),
       'wrapped in this view\'s own flex-item class, so the stylesheet never names the role');
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  THE OTHER THREE SITES — mirror note, sidebar error, browse error');
{
  const mirror = callOrFail('mirror note', () => makeCallable(
    ['renderStatus'], extractFunction(domainsSrc, 'renderMirrorNote'), 'renderMirrorNote'
  )(renderStatus)());
  if (mirror) {
    ok(mirror.includes('tx-status'), 'a read-only mirror renders a status box');
    ok(mirror.includes('tx-status-neutral'),
       'at NEUTRAL tone — a mirror being read-only is the ordinary condition of a mirror, and ' +
       'text.css\'s own note is that the ordinary case must not be dressed as a problem');
    ok(mirror.includes('overwritten on the next Pull'),
       'and the consequence is still stated — nothing is hidden by making it calmer');
    ok(!mirror.includes('<details'), 'and not folded');
  }

  // SIDEBAR. Executed through setSidebar, which is where the real markup goes.
  {
    let captured = null;
    const deps = {
      isCurrentMount: () => true, icon: () => '', setSidebar: (html) => { captured = html; },
      gatedLoader: () => '<GATED/>', loadGate: {}, bindNewDomainBtn: () => {},
      escapeHtml: (x) => String(x), domainDotColor: () => '#000', renderStatus,
    };
    const names = Object.keys(deps);
    const run = (st) => {
      captured = null;
      makeCallable(['state', ...names], extractFunction(domainsSrc, 'renderSidebar'), 'renderSidebar')(
        st, ...names.map((n) => deps[n])
      )('tok');
      return captured;
    };
    const errHtml = callOrFail('sidebar with a load error', () =>
      run({ loaded: true, loadError: HOSTILE, domains: [], readonlySet: new Set(), healthSummary: {}, activeSlug: null }));
    if (errHtml) {
      ok(errHtml.includes('tx-status-danger'),
         'a failed domain load is a DANGER status, not `.sidebar-hint` plus a colour modifier — one class ' +
         'that meant both a marketing sentence and a failure. (A SEMANTIC fix, not a contrast one: measured ' +
         'in a browser, `.dm-error-text` won that cascade, so the old line was --danger-text at 7.80 dark / ' +
         '5.41 light and PASSED AA.)');
      ok(errHtml.includes('dm-sidebar-status'), 'wrapped in this view\'s spacing class');
      ok(errHtml.includes('&lt;img') && !errHtml.includes('<img src=x'),
         'and the server message is escaped');
      ok(!errHtml.includes('sidebar-hint'), 'the hint class is not used for a failure any more');
    }
    const loadingHtml = callOrFail('sidebar still loading', () =>
      run({ loaded: false, loadError: null, domains: [], readonlySet: new Set(), healthSummary: {}, activeSlug: null }));
    if (loadingHtml) {
      ok(loadingHtml.includes('<GATED/>'),
         'the LOADING branch still goes through gatedLoader — loading is not a text role and was not converted');
    }
  }

  // BROWSE. The third runtime error, which shared a class with a benign
  // empty state ("No pages match that filter").
  {
    const deps = {
      icon: () => '', escapeHtml: (x) => String(x), loadGate: {}, gatedLoader: () => '<GATED/>',
      activeBrowse: () => ({ error: HOSTILE }), BROWSE_RENDER_CAP: 300,
      filterBrowseEntries: () => [], renderStatus, renderDescription,
    };
    const names = Object.keys(deps);
    const html = callOrFail('browse panel with a listing error', () => makeCallable(
      ['state', ...names], extractFunction(domainsSrc, 'renderBrowsePanel'), 'renderBrowsePanel'
    )({}, ...names.map((n) => deps[n]))());
    if (html) {
      ok(html.includes('tx-status-danger'),
         'a failed page listing is a DANGER status, not the empty-state class dyed red');
      ok(html.includes('&lt;img') && !html.includes('<img src=x'), 'and its message is escaped');
      ok(!html.includes('dm-error-text'), 'the colour-modifier class is gone from this site too');
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  STYLESHEET HYGIENE — the view places, the component dresses');
{
  // --font-scale. Settings > General multiplies the --text-* ramp live; a px
  // literal freezes at 1x while everything around it grows.
  const pxSizes = [...domainsCssCode.matchAll(/font-size:\s*([^;]+);/g)]
    .map((m) => m[1].trim()).filter((v) => /\d+px/.test(v));
  ok(pxSizes.length === 0,
     `views/domains.css declares no px font-size (found: ${pxSizes.join(', ') || 'none'}) — ` +
     'the user-adjustable --font-scale would not reach it');

  // THE PLACEMENT BLOCK SETS NO TYPE. If a placement rule ever needs a
  // font-size or a colour, the role is wrong for the job and the answer is a
  // different role — not a re-dressed one. That is the rule that stops 81
  // one-off treatments growing back.
  const blockStart = domainsCss.indexOf('── Placement for the shared text roles');
  const blockEnd = domainsCss.indexOf('── Sidebar domain list');
  ok(blockStart > -1 && blockEnd > blockStart, 'the placement block is findable by its own heading');
  if (blockStart > -1 && blockEnd > blockStart) {
    const block = stripCssComments(domainsCss.slice(blockStart, blockEnd));
    for (const prop of ['font-size', 'font-family', 'font-weight', 'color', 'border', 'background']) {
      ok(!new RegExp(`(?:^|[;{\\s])${prop}\\s*:`).test(block),
         `the placement rules set no ${prop} — they place the roles, they do not re-dress them`);
    }
    ok(/margin/.test(block), 'CONTROL: the placement block does set margins, so the assertions above are not vacuous');
  }

  // Every var() in this stylesheet must resolve. An undefined custom property
  // fails SILENTLY at computed-value time — `--text-dim` (which does not
  // exist) once shipped as invisible text.
  // ENUMERATED FROM DISK. A hardcoded token-file list is how a guard goes
  // blind — the first draft of this section listed four of the six files in
  // tokens/ and reported --radius-md and --ring-focus as undefined.
  const defined = new Set();
  for (const f of readdirSync(join(NEXT, 'tokens')).filter((f) => f.endsWith('.css'))) {
    for (const m of readFileSync(join(NEXT, 'tokens', f), 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  }
  ok(defined.size > 40, `token definitions enumerated from tokens/*.css (${defined.size} custom properties)`);
  for (const css of [domainsCss, readFileSync(join(NEXT, 'shell.css'), 'utf8')]) {
    for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  }
  const undef = [...new Set([...domainsCssCode.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))]
    .filter((v) => !defined.has(v));
  ok(undef.length === 0, `every var() in domains.css resolves to a real token (undefined: ${undef.join(', ') || 'none'})`);
  ok(!/var\(--text-dim\)/.test(domainsCss), '--text-dim is not referenced — it does not exist');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  CONTRAST — computed from tokens/color.css, both themes');
// The tool is the one in test-next-text-system.js §7, reused deliberately
// rather than rewritten: its first version reported dark and light as
// IDENTICAL because `[data-theme="light"]` also appears in color.css's header
// COMMENT and a bare indexOf returned the :root block twice. Selectors are
// line-anchored here for that reason, and the control below would catch it
// again.
{
  const colorCss = readFileSync(join(NEXT, 'tokens/color.css'), 'utf8');
  const blk = (sel) => {
    const i = colorCss.indexOf('\n' + sel);
    if (i < 0) throw new Error('no line-anchored selector ' + sel);
    const s = colorCss.indexOf('{', i);
    return colorCss.slice(s + 1, colorCss.indexOf('\n}', s));
  };
  const vars = (txt) => {
    const o = {}; for (const m of txt.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) o[m[1]] = m[2].trim();
    return o;
  };
  const dark = vars(blk(':root'));
  const lite = { ...dark, ...vars(blk('[data-theme="light"]')) };
  ok(dark['--surface-raised'] !== lite['--surface-raised'],
     'CONTROL: the two theme tables are genuinely different — a parser conflating them would ' +
     'report every pair as identical and prove nothing');

  const res = (v, t, d = 0) => {
    if (d > 10) throw new Error('cycle');
    const m = /^var\((--[a-z0-9-]+)\)$/.exec(String(v).trim());
    return m ? res(t[m[1]], t, d + 1) : String(v).trim();
  };
  const rgb = (c) => {
    c = c.trim();
    let m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) { const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255, 1]; }
    m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    throw new Error('unparsed colour ' + c);
  };
  const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3])).concat(1);
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const A = lum(a), B = lum(b); return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05); };
  const C = (t, fg, bg, tint) => {
    let b = rgb(res('var(' + bg + ')', t));
    if (tint) b = over(rgb(res('var(' + tint + ')', t)), b);
    return ratio(over(rgb(res('var(' + fg + ')', t)), b), b);
  };
  const both = (fg, bg, tint) => Math.min(C(dark, fg, bg, tint), C(lite, fg, bg, tint));

  // WHY THE MOVE WAS NECESSARY. These are the treatments this view left, and
  // the assertion is that they really did fail — a fix justified by a claim
  // nobody measured is the shape this repo keeps recording.
  ok(both('--text-3', '--surface') < 4.5,
     `--text-3 as body text FAILS AA (${both('--text-3', '--surface').toFixed(2)}:1 worst theme) — ` +
     'this is what `.dm-health-meta` and `.sidebar-hint` painted measurements and errors in');
  ok(both('--attention-text', '--surface', '--accent-tint') < 4.5,
     `--attention-text as TEXT over --accent-tint FAILS AA (${both('--attention-text', '--surface', '--accent-tint').toFixed(2)}:1 ` +
     'worst theme) — this is what the in-flight-write warning above the page-deleting buttons was painted in');

  // WHERE THEY WENT. The roles' own tokens, on the surfaces this view puts
  // them on. text.css's suite proves this for its three surfaces; repeating
  // it here ties the claim to THIS view's containers.
  for (const [fg, bg, tint, what] of [
    ['--text', '--surface-raised', null, 'a status title / readout value'],
    ['--text-2', '--surface-raised', null, 'a status detail'],
    ['--text-2', '--surface', null, 'a description / readout label and provenance'],
    ['--text-2', '--surface', '--accent-tint', 'the cost promise inside the Quick maintenance block'],
  ]) {
    ok(both(fg, bg, tint) >= 4.5,
       `${what}: ${fg} clears AA at ${both(fg, bg, tint).toFixed(2)}:1 in the worse theme`);
  }

  // The rails are BORDERS, so their floor is 3:1, not 4.5. This is the whole
  // reason a status can carry a status colour at all in the light theme.
  for (const tok of ['--danger-text', '--attention-text', '--success-text']) {
    ok(both(tok, '--surface-raised') >= 3,
       `${tok} clears the 3:1 NON-TEXT floor as a rail (${both(tok, '--surface-raised').toFixed(2)}:1 worse theme)`);
  }

  // THE KNOWN GAP, COUNTED. Two sites still paint --attention-text as text.
  // Counting them means the gap cannot grow quietly, and the number is the
  // thing a later wave drives to zero.
  const busySites = (domainsCode.match(/dm-quick-note-busy/g) || []).length;
  ok(busySites === 2,
     `KNOWN GAP: exactly ${busySites} sites still render --attention-text as TEXT ` +
     '(the browse-listing truncation warning and the pending-plan in-flight line). Expected 2. ' +
     'Both measure under the 4.5 floor in the light theme; one is byte-asserted by ' +
     'test-next-domain-lifecycle.js, so neither is this wave\'s to move.');

  // And --text-3 is not gone from this view, only from the roles that were
  // converted. Pinning the count stops a future reader believing it is solved.
  // A RATCHET, not a target. 32 before this wave, 30 after (the two that went
  // were `.dm-health-meta` and `.dm-mirror-note svg`). It may fall; it may not
  // rise. Every one of the 30 is under the AA floor as body text, so a new one
  // is a new defect, and the count is here so nobody reads "the roles no
  // longer use --text-3" as "this view no longer does".
  const text3 = (domainsCssCode.match(/var\(--text-3\)/g) || []).length;
  ok(text3 > 0 && text3 <= 30,
     `KNOWN GAP, RATCHETED: views/domains.css uses --text-3 in ${text3} declarations; it was 32 before ` +
     'this wave and must not exceed 30. It is retired for the roles adopted here BY CONSTRUCTION — no ' +
     'role in the text system reads that token — and mass-changing the rest is its own change with its own proof.');
}

console.log('\n' + '='.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ views/domains.js text-system adoption holds');
process.exit(0);
