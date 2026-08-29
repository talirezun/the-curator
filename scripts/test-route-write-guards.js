/**
 * test-route-write-guards.js — OFFLINE suite for the write-registry guard on
 * the mutating /api/config routes, POST /api/sync/setup, and domain rename.
 *
 * ── What this pins ───────────────────────────────────────────────────────
 *
 * Two config values are resolved FRESH on every use, by deliberate design:
 * `getDomainsDir()` re-reads .curator-config.json on every call (the v3.1.0
 * per-call-resolution invariant), and `getProviderInfo()` runs per LLM call
 * inside `callProvider`. So a config mutation that lands mid-ingest takes
 * effect on the REMAINING work of an operation already in flight:
 *
 *   • changing the knowledge folder writes the rest of one source's pages
 *     under a different root — the document's pages split across two
 *     locations, with an index and log each describing only half of it;
 *   • saving / disconnecting / switching a provider key can fail the run
 *     partway through, or silently finish it on a DIFFERENT model (v3.0.2's
 *     last-saved-wins means even a plain save switches the active provider).
 *
 * A multi-phase ingest takes minutes and the shipping frontend's busy gate
 * does NOT disable the folder picker or the key controls, so a user wandering
 * into Settings mid-ingest reaches all of this. `POST /update` has had the
 * `hasActiveWrites()` guard since v3.0.1-beta.8; these five routes did not.
 *
 * ── The half people forget ───────────────────────────────────────────────
 *
 * Every "the guard FIRES" assertion below is paired with a "the guard does
 * NOT fire when idle" assertion against the same route. A guard that always
 * blocks is as broken as one that never does, and only the negative half can
 * tell those two apart — a suite that merely proves 409s could be green
 * against a hard-coded `return res.status(409)`.
 *
 * Section 5 additionally pins the routes deliberately left UNGUARDED, so a
 * future well-meaning blanket application shows up as a failure and gets a
 * conversation rather than shipping silently.
 *
 * ── Isolation ────────────────────────────────────────────────────────────
 *
 * Sections 2 and 4 make real mutating requests (they write API keys and a
 * domainsPath). Both `CURATOR_TEST_USER_DATA_DIR` and `CURATOR_TEST_DOMAINS_DIR`
 * are set BEFORE any app module is imported, and section 1 asserts the resolved
 * config path really is inside the tempdir and that the maintainer's real
 * config is untouched (hashed before and after the whole run). No request in
 * this file can reach the real .curator-config.json.
 *
 * `POST /api/config/update` is NEVER called here, at any point, under any
 * condition: it runs `git fetch` + `git reset --hard origin/main` against the
 * REAL checkout regardless of which process invokes it.
 *
 * `POST /pick-folder` is only ever exercised in the REFUSED state, where the
 * middleware short-circuits before `osascript` runs. Calling it while idle
 * would open a real, blocking Finder dialog on the developer's machine.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { createServer } from 'http';
import { execFileSync } from 'child_process';

// ── Isolation FIRST — before any app module is imported ─────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-cfgguard-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
const TMP_PICK = path.join(TMP, 'picked-folder');
for (const d of [TMP_USER, TMP_DOMAINS, TMP_PICK]) mkdirSync(d, { recursive: true });

process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
// DOMAINS_PATH still outranks the default inside getDomainsDir(); an inherited
// one would point an "isolated" run at a real wiki (see paths.js's docblock).
delete process.env.DOMAINS_PATH;

// Fingerprint the REAL credential files so we can prove we never touched them.
const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const REAL_FILES = [
  '.curator-config.json', '.sync-config.json', '.sharedbrain-config.json',
].map(f => path.join(REPO_ROOT, f));
function fingerprint() {
  // sha256 + size + existence ONLY. mtime is deliberately excluded: the
  // maintainer's live app on :3333 rewrites .curator-config.json during
  // ordinary Settings use, and an mtime-sensitive guard would then fail a
  // multi-second suite with a false "isolation is broken" (the v3.0.16
  // misattribution shape).
  return REAL_FILES.map(f => {
    if (!existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const FINGERPRINT_BEFORE = fingerprint();

const { default: configRouter } = await import('../src/routes/config.js');
const { default: syncRouter } = await import('../src/routes/sync.js');
const { default: domainsRouter } = await import('../src/routes/domains.js');
const { default: healthRouter } = await import('../src/routes/health.js');
const { writePage, renameDomain, listDomains } = await import('../src/brain/files.js');
const { getCuratorConfigFile } = await import('../src/brain/paths.js');
const registry = await import('../src/brain/write-registry.js');
const { default: express } = await import('express');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// ── Shared route-guard classifier ─────────────────────────────────────────
//
// Used by every "every mutating route is guarded" assertion below (sync.js,
// config.js, domains.js, health.js). An earlier version of this file had FOUR
// different matchers of differing soundness: a single-line, single-quote
// regex for sync.js claiming to be "the invariant, not a per-route spot
// check" (defeated by a double-quoted path, OR by a guard placed on the
// FOLLOWING line rather than the declaration line); a hardcoded 5-route loop
// for config.js that only ever looked at routes it already knew about, so a
// sixth unguarded route was invisible to it by construction; ad hoc PUT/DELETE
// checks for domains.js with no invariant over the file at all; and a
// comment-stripped, brace-matched scanner for health.js gated behind a
// hardcoded DESTRUCTIVE function-name allow-list, so a new destructive helper
// under a name the list didn't know about was silently never checked. An
// adversarial audit mutation-proved all four gaps. This is the single,
// generalised replacement, applied identically to all four files.
//
// Soundness properties:
//   1. Comments and string/template literals are blanked BEFORE any pattern
//      is matched (stripSource below), so a `router.post(` inside a comment
//      or string literal can never manufacture a phantom route, and a real
//      route hidden behind a commented-out example can never mask a genuine
//      one. Verified against the recorded "a `//` comment containing `/*` can
//      desync a naive stripper" failure mode: `line` mode short-circuits with
//      `continue` before the block-comment-start check ever runs, so a line
//      comment can never accidentally open block mode, and `block` mode never
//      even reaches the line-comment-start check while active. Both directions
//      hold.
//   2. Guard detection reads the WHOLE brace-matched call body, not one line
//      of it — a guard on a following line counts.
//   3. Route-PATH quoting is irrelevant to whether a route is DISCOVERED at
//      all (single/double/backtick all match): discovery keys off the method
//      name (`router.post(` etc.), never the quote character of its first
//      argument.
//   4. The router variable name is discovered from `const X = Router()`
//      rather than assumed to be literally `router`; if that declaration does
//      not appear EXACTLY once in the file, classification refuses outright
//      (a second router variable would otherwise register routes invisibly to
//      every check below — sound-in-the-safe-direction, not a convenience).
//   5. UNCLASSIFIABLE IS A FAILURE, NEVER A SILENT SKIP. A mutating route
//      whose path cannot be read as a plain literal (built from a variable, a
//      computed expression, a template literal with interpolation) can NEVER
//      be matched against the exemption list — there is no literal to check
//      it against — so it is REQUIRED to carry a guard unconditionally.
//      Skipping it because "we can't tell" would be exactly the failure shape
//      this round exists to remove.
//   6. `.route(path).post(...).get(...)` chaining is recognised as a second,
//      independent call pattern — each chained method call shares the
//      route()'s literal path and is checked on its own brace-matched body.
//   7. An independent, DELIBERATELY DIFFERENTLY-IMPLEMENTED cross-check
//      counts every `<routerVar>.<method>(` occurrence via a plain indexOf
//      scan with NO regex and NO brace-matching, and asserts it exactly
//      equals the number of DIRECT calls the brace-matching pass above
//      actually produced. This is the CLAUDE.md-recorded lesson applied here:
//      "a scanner silently seeing 78 of 90 declarations while reporting every
//      assertion green" was caught only by an independent second count, never
//      by the sophisticated pass agreeing with itself.
//
//   8. BRACKET-NOTATION DISPATCH (`router['post'](...)`) is now an ASSERTION,
//      not a comment (finding 12). It used to be "documented" only as prose
//      claiming "grepped before writing this classifier" — unfalsifiable,
//      and confirmed exploitable live: an injected
//      `router['post']('/:domain/sneaky-wipe', ...)` calling `fixIssue`
//      completely unguarded left `npm test` at Passed: 340  Failed: 0.
//      findBracketNotationRoutes() (below) scans every classified file's
//      COMMENTS-stripped source (stripCommentsOnly — a stripSource() variant
//      that keeps string/template content, since the method name here IS a
//      string literal) for `<routerVar>['method'](` / `["method"](` /
//      `` [`method`]( `` and auditRouteGuards() fails LOUDLY, per file, if
//      any is found — "an allow-list silently permits what it forgot"
//      applies to the classifier's own blind spots, not only to route
//      exemptions. Proven exploitable-then-caught in section 14 by injecting
//      exactly that route into a temp copy of health.js.
//
// KNOWN REMAINING BLIND SPOT — stated plainly, not left for the next reviewer
// to find: a `.route(...)` call whose Route object is assigned to an
// intermediate variable and chained in a SEPARATE statement
// (`const r = router.route('/x'); r.post(fn);`) is invisible to both the
// chained-call pass and the indexOf cross-check, because the chained method
// call no longer carries `<routerVar>.` as a textual prefix at all. No route
// in this codebase uses that form today (grepped before writing this
// classifier); if one ever does, it will not be checked, and nothing here
// will say so. This form is UNRELATED to bracket-notation dispatch (property
// 8 above) — that one is now enforced; this one is not, and remains an
// honestly-recorded gap rather than a fixed one.
function stripSource(src) {
  let o = ''; let q = null, line = false, block = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (line) { if (c === '\n') { line = false; o += '\n'; } else o += ' '; continue; }
    if (block) { if (c === '*' && src[i + 1] === '/') { block = false; o += '  '; i++; } else o += (c === '\n' ? '\n' : ' '); continue; }
    if (q) { if (c === '\\') { o += '  '; i++; continue; } if (c === q) q = null; o += (c === '\n' ? '\n' : ' '); continue; }
    if (c === '/' && src[i + 1] === '/') { line = true; o += ' '; continue; }
    if (c === '/' && src[i + 1] === '*') { block = true; o += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; o += ' '; continue; }
    o += c;
  }
  return o;
}

// Comments-only stripper (finding 12). stripSource() above blanks BOTH
// comments AND the contents of every string/template literal — correct for
// method-call discovery (a `.post(` inside a string must never manufacture a
// phantom route), but wrong for bracket-notation detection: `'post'` inside
// `router['post'](...)` IS the method name, and stripSource erases it before
// any regex could read it. This variant blanks only // and /* */ comments
// and passes string/template CONTENT through verbatim, while remaining
// quote-aware so a `//` or `/*` sequence INSIDE a string can never be
// misread as opening a real comment.
function stripCommentsOnly(src) {
  let o = ''; let q = null, line = false, block = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (line) { if (c === '\n') { line = false; o += '\n'; } else o += ' '; continue; }
    if (block) { if (c === '*' && src[i + 1] === '/') { block = false; o += '  '; i++; } else o += (c === '\n' ? '\n' : ' '); continue; }
    if (q) {
      if (c === '\\') { o += c + (src[i + 1] ?? ''); i++; continue; }
      if (c === q) q = null;
      o += c;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { line = true; o += ' '; continue; }
    if (c === '/' && src[i + 1] === '*') { block = true; o += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; o += c; continue; }
    o += c;
  }
  return o;
}

function matchPair(s, from) {
  let d = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '(') d++;
    else if (s[i] === ')') { d--; if (d === 0) return i; }
  }
  return -1;
}

// Literal-string extraction reads the RAW source (stripSource blanks quote
// contents), using the position-preserving index computed against `stripped`
// — stripSource never changes the string's length, so indices line up.
function extractLiteralArg(raw, openIdx) {
  const m = raw.slice(openIdx, openIdx + 4000).match(/^\(\s*(['"`])([^'"`]*)\1/);
  return m ? m[2] : null;
}

function classifyRouteFile(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const stripped = stripSource(raw);
  const commentsStripped = stripCommentsOnly(raw);
  const result = { raw, stripped, commentsStripped, routes: [], parseFails: 0, routerVar: null, routerDeclCount: 0 };

  const routerDecls = [...stripped.matchAll(/\bconst\s+(\w+)\s*=\s*Router\s*\(\s*\)/g)];
  result.routerDeclCount = routerDecls.length;
  if (routerDecls.length !== 1) return result; // caller refuses to proceed on this
  const routerVar = routerDecls[0][1];
  result.routerVar = routerVar;

  // Pass 1: direct `routerVar.method(...)` calls.
  const METHOD_RE = new RegExp('\\b' + routerVar + '\\.(get|post|put|delete|patch)\\s*\\(', 'g');
  let m;
  while ((m = METHOD_RE.exec(stripped))) {
    const openIdx = stripped.indexOf('(', m.index);
    const endIdx = matchPair(stripped, openIdx);
    if (endIdx === -1) { result.parseFails++; continue; }
    result.routes.push({
      method: m[1].toUpperCase(),
      path: extractLiteralArg(raw, openIdx),
      body: stripped.slice(openIdx, endIdx + 1),
      kind: 'direct',
    });
  }

  // Pass 2: chained `routerVar.route(path).method(...).method(...)`. Each
  // chained segment shares the route()'s literal path and is checked on its
  // OWN brace-matched body (a guard on one chained method must not silently
  // "cover" a sibling method on the same route()).
  const ROUTE_RE = new RegExp('\\b' + routerVar + '\\.route\\s*\\(', 'g');
  let rm;
  while ((rm = ROUTE_RE.exec(stripped))) {
    const openIdx = stripped.indexOf('(', rm.index);
    const endIdx = matchPair(stripped, openIdx);
    if (endIdx === -1) { result.parseFails++; continue; }
    const routePath = extractLiteralArg(raw, openIdx);
    let pos = endIdx + 1;
    for (;;) {
      const chainM = /^\s*\.\s*(get|post|put|delete|patch)\s*\(/.exec(stripped.slice(pos, pos + 200));
      if (!chainM) break;
      const chainOpenIdx = pos + chainM[0].lastIndexOf('(');
      const chainEndIdx = matchPair(stripped, chainOpenIdx);
      if (chainEndIdx === -1) { result.parseFails++; break; }
      result.routes.push({
        method: chainM[1].toUpperCase(),
        path: routePath,
        body: stripped.slice(chainOpenIdx, chainEndIdx + 1),
        kind: 'chained',
      });
      pos = chainEndIdx + 1;
    }
  }

  return result;
}

// Independent cross-check for DIRECT calls only (pass 1) — deliberately a
// different implementation (plain indexOf scan, no regex, no brace-matching)
// so a bug specific to the regex/brace-matching machinery above cannot also
// break this count in the same way. Requires a non-identifier char (or start
// of string) immediately before `routerVar` so it can't match e.g.
// `myrouter.post(` as a false positive.
function dumbCountDirectCalls(stripped, routerVar) {
  const methods = ['get', 'post', 'put', 'delete', 'patch'];
  let count = 0;
  for (const method of methods) {
    const needle = routerVar + '.' + method + '(';
    let idx = 0;
    for (;;) {
      const found = stripped.indexOf(needle, idx);
      if (found === -1) break;
      const before = found > 0 ? stripped[found - 1] : '';
      if (!/[A-Za-z0-9_$]/.test(before)) count++;
      idx = found + needle.length;
    }
  }
  return count;
}

function bodyIsGuarded(body, guardTokens, guardMode) {
  const res = guardTokens.map(t => new RegExp('\\b' + t + '\\s*\\(').test(body));
  return guardMode === 'all' ? res.every(Boolean) : res.some(Boolean);
}

// Finding 9: quote-style-agnostic literal-occurrence counter. The original
// finding-9a regression guard counted only `'${p}'` (single-quoted), so a
// double-quoted or backtick-quoted duplicate exemption list would silently
// not be counted at all — the opposite of what a "no hand-duplicated copy"
// guard is for. Counts all three JS quote forms.
function countQuotedLiteral(src, literal) {
  let count = 0;
  for (const q of ["'", '"', '`']) {
    const needle = q + literal + q;
    let idx = 0;
    for (;;) {
      const found = src.indexOf(needle, idx);
      if (found === -1) break;
      count++;
      idx = found + needle.length;
    }
  }
  return count;
}

// Finding 12: property 8 of classifyRouteFile's docblock, made executable.
// `<routerVar>['post'](...)` dispatches a route exactly like
// `<routerVar>.post(...)`, but neither Pass 1's METHOD_RE nor Pass 2's
// ROUTE_RE can see it -- both require a literal `.method(` property access.
//
// Deliberately scans `commentsStripped`, NOT `stripped`: stripSource() blanks
// the CONTENTS of every string/template literal (correct for method-call
// discovery, where a `.post(` inside a string must never manufacture a
// phantom route) — but the bracketed method name here (`'post'` in
// `router['post'](...)`) IS a string literal, so scanning `stripped` would
// search a string with the very method name already erased (confirmed: the
// first version of this function did exactly that and matched nothing on a
// real injected route). `commentsStripped` blanks only comments and keeps
// string content intact, so the classifier's original guarantee still
// holds — a bracket shape inside a // or /* */ comment can never
// manufacture a false positive — while the method name stays legible.
function findBracketNotationRoutes(commentsStripped, routerVar) {
  if (!routerVar) return [];
  const re = new RegExp(
    '\\b' + routerVar + '\\s*\\[\\s*([\'"`])(get|post|put|delete|patch)\\1\\s*\\]\\s*\\(', 'g');
  const hits = [];
  let m;
  while ((m = re.exec(commentsStripped))) hits.push(m[2].toUpperCase());
  return hits;
}

// Every HTTP verb this suite treats as "mutating" -- the single definition
// shared by auditRouteGuards() below AND computeWritabilityCoverage() below
// it. Before the v3.6.2 fix, section 13's own coverage pin re-declared this
// as an inline `r.method === 'POST'` filter, so a PUT/DELETE/PATCH mutating
// route would be silently excluded from what the pin DEMANDS coverage for --
// not merely unexempted, but invisible to the requirement entirely. One
// source now feeds both checks.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// Every mutating verb this file's own HTTP client (post/put/del/patch below)
// can actually issue against the in-process server. Kept identical to
// MUTATING_METHODS today -- the point of keeping it a SEPARATE set, rather
// than reusing MUTATING_METHODS directly, is that if a fifth verb is ever
// added to MUTATING_METHODS without a matching driver function,
// computeWritabilityCoverage's `undrivable` branch below fails LOUDLY,
// naming the route, instead of a filter silently dropping it from `required`
// the same way the POST-only filter used to (finding 9b's exact shape,
// generalised so it can't recur under a different verb).
const DRIVABLE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// Single implementation of "which of this route file's mutating routes does
// the WRITABILITY axis require to be behaviourally driven, and which are
// legitimately exempt" -- shared verbatim by section 13 (against the REAL
// health.js) and the mutation-proof fixtures in section 14 (against mutated
// TEMP COPIES of it). This used to be two separate pieces of logic: section
// 13 hand-maintained its OWN `exemptPaths` Set (a second, driftable copy of
// the exemptions already declared on HEALTH_GUARD_CLASSES's writability
// class -- finding 9a), and it filtered routes to `r.method === 'POST'`
// before checking anything, so a PUT/DELETE/PATCH route in the writability
// class would never even reach the exemption check (finding 9b). Both bugs
// lived in a re-implementation that only section 13 used; folding them into
// one function that section 13 calls, rather than section 13 re-typing the
// derivation AND section 14 re-implementing it a second time to test it, is
// deliberate -- a bug in a second re-implementation would prove nothing
// about the code that actually ships in section 13.
//
// `info` is a classifyRouteFile() result (real or from a mutated temp file).
// `guardClasses` is the SAME shape auditRouteGuards() takes -- this function
// reads only the class named 'writability' out of it, exactly as section 13
// always has.
function computeWritabilityCoverage(info, guardClasses) {
  const writabilityClass = guardClasses.find(c => c.name === 'writability');
  if (!writabilityClass) return { required: [], undrivable: [], exemptKeys: new Set() };
  const exemptKeys = new Set(writabilityClass.exemptions.map(e => e.method + ' ' + e.path));
  const required = [];
  const undrivable = [];
  for (const r of info.routes) {
    if (!MUTATING_METHODS.has(r.method)) continue;
    if (!r.path) continue; // non-literal paths are unconditionally required by 6b itself; this pin only drives literal paths
    const key = r.method + ' ' + r.path;
    if (exemptKeys.has(key)) continue;
    if (!DRIVABLE_METHODS.has(r.method)) { undrivable.push(key); continue; }
    required.push(r.method + ' ' + r.path.replace('/:domain', ''));
  }
  return { required: required.sort(), undrivable, exemptKeys };
}

// Runs the full class-invariant sweep over one route file and pushes
// assertions via assert()/eq().
//
// ── Why this takes a LIST of guard classes, not one token list ────────────
//
// It used to take a single `guardTokens`/`guardMode`/`exemptions` triple, and
// that shape is precisely how it missed the v3.6.1 follow-up defect. health.js
// protects itself along TWO INDEPENDENT AXES:
//
//   • CONCURRENCY — registerWrite + acquireFileLock + isUpdateInProgress:
//     "do not interleave this write with another one."
//   • WRITABILITY — assertWritableDomain: "do not write into a read-only
//     Shared Brain mirror at all, however quiet the moment is."
//
// A single token list can only express one axis. The old config expressed the
// concurrency axis, so `assertWritableDomain` was not a checked token ANYWHERE
// — and a single shared exemption list then let a route be waved past both
// axes on a rationale that had only ever considered the first. Mutation-proven
// before this rewrite: deleting assertWritableDomain from POST /:domain/fix-all
// — a fully in-scope, non-exempted, bulk-destructive route — left the suite at
// Passed: 213  Failed: 0. The blindness was never specific to /dismiss.
//
// So each axis is now its own class with its OWN exemption list. A route
// exempt from concurrency is still checked for writability, which is exactly
// the /dismiss + /undismiss case: a sidecar write that needs no lock (the MCP
// twins take none either) but absolutely must refuse a mirror.
//
// Exemptions remain the inversion described before: every mutating route is in
// scope by default and only an explicit, justified exemption removes it — but
// an exemption now removes it from ONE named axis, never from the sweep.
function auditRouteGuards(relPath, { guardClasses, expectedMutatingCount, label }) {
  const abs = path.join(REPO_ROOT, relPath);
  const info = classifyRouteFile(abs);
  eq(info.routerDeclCount, 1,
    `${label}: exactly one \`const X = Router()\` declaration (router variable identified unambiguously)`);
  if (info.routerDeclCount !== 1) return; // cannot proceed safely — see property 4
  eq(info.parseFails, 0, `${label}: every router.X(...)/.route(...) call brace-matched cleanly`);

  const directRoutes = info.routes.filter(r => r.kind === 'direct');
  const dumbCount = dumbCountDirectCalls(info.stripped, info.routerVar);
  eq(dumbCount, directRoutes.length,
    `${label}: independent indexOf cross-check agrees with the brace-matching classifier on direct calls (${dumbCount} vs ${directRoutes.length})`);

  // Finding 12: bracket-notation dispatch is a documented blind spot of BOTH
  // passes above — enforce it as an assertion rather than leaving it as a
  // comment nobody re-verifies after the next edit.
  const bracketHits = findBracketNotationRoutes(info.commentsStripped, info.routerVar);
  eq(bracketHits.length, 0,
    `${label}: no bracket-notation route dispatch (router['post'](...) etc.) found — the classifier's documented blind spot is enforced, not merely claimed (found: ${JSON.stringify(bracketHits)})`);

  // Reuses the single shared MUTATING_METHODS set (defined above, alongside
  // computeWritabilityCoverage) instead of declaring its own copy here --
  // finding 9a/9b's lesson generalised: a set this file needs in two places
  // is defined once.
  const mutating = info.routes.filter(r => MUTATING_METHODS.has(r.method));
  assert(mutating.length >= 1, `${label}: found mutating routes to check (${mutating.length})`);
  if (typeof expectedMutatingCount === 'number') {
    eq(mutating.length, expectedMutatingCount,
      `${label}: exactly ${expectedMutatingCount} mutating routes found (a drift means EXEMPTIONS/guard config below needs review)`);
  }

  for (const cls of guardClasses) {
    const { name, guardTokens, guardMode = 'any', exemptions = [] } = cls;
    const exemptSet = new Set(exemptions.map(e => e.method + ' ' + e.path));
    const consumed = new Set();

    for (const r of mutating) {
      const pathDisplay = r.path === null ? '(non-literal)' : r.path;
      const chainNote = r.kind === 'chained' ? ' [chained via .route()]' : '';
      const routeLabel = `${label} [${name}] ${r.method} '${pathDisplay}'${chainNote}`;

      if (r.path === null) {
        // Property 5: a non-literal path can never be exempted, on any axis.
        assert(bodyIsGuarded(r.body, guardTokens, guardMode),
          `${routeLabel}: non-literal path — REQUIRED to carry a guard unconditionally (cannot be exempted)`);
        continue;
      }

      const key = r.method + ' ' + r.path;
      if (exemptSet.has(key)) {
        consumed.add(key);
        assert(true, `${routeLabel}: explicitly exempted — ${exemptions.find(e => e.method + ' ' + e.path === key).reason}`);
        continue;
      }
      assert(bodyIsGuarded(r.body, guardTokens, guardMode),
        `${routeLabel}: carries a guard (${guardMode === 'all' ? 'ALL of' : 'one of'} ${JSON.stringify(guardTokens)})`);
    }

    // Every declared exemption must correspond to a route that actually exists
    // — a stale exemption for a renamed/removed route would otherwise rot into
    // a hole a differently-motivated future route could reuse by coincidence.
    for (const e of exemptions) {
      const k = e.method + ' ' + e.path;
      assert(consumed.has(k), `${label} [${name}]: exemption "${k}" matches an actual route (not stale)`);
    }
  }
}

// ── Test server: the REAL router, mounted in-process ────────────────────
// In-process is required, not a convenience: the write registry is an
// in-memory Map scoped to one process, so an out-of-process test could not
// register a write that the server would see (short of running a real,
// paid ingest).
const app = express();
app.use(express.json());
app.use('/api/config', configRouter);
app.use('/api/sync', syncRouter);
app.use('/api/domains', domainsRouter);
app.use('/api/health', healthRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function post(routePath, body) {
  const res = await fetch(BASE + routePath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, body: json };
}

async function put(routePath, body) {
  const res = await fetch(BASE + routePath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, body: json };
}

async function del(routePath) {
  const res = await fetch(BASE + routePath, { method: 'DELETE' });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, body: json };
}

async function patch(routePath, body) {
  const res = await fetch(BASE + routePath, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, body: json };
}

// Dispatches to whichever of post/put/del/patch above matches `method` --
// keyed off DRIVABLE_METHODS (defined earlier, alongside
// computeWritabilityCoverage) so the two stay honest about each other: if a
// method is ever added to DRIVABLE_METHODS without a case here, this throws
// loudly at the call site instead of a route silently never being driven
// (finding 9b's shape, applied to the driver side rather than the
// requirement side).
async function mutatingRequest(method, routePath, body) {
  switch (method) {
    case 'POST': return post(routePath, body);
    case 'PUT': return put(routePath, body);
    case 'DELETE': return del(routePath);
    case 'PATCH': return patch(routePath, body);
    default: throw new Error(`mutatingRequest: no driver for HTTP method ${method} (routePath ${routePath})`);
  }
}

// The five routes this change guards. `/pick-folder` carries a flag: it is
// only ever called in the REFUSED state (see the file docblock).
const GUARDED = [
  { path: '/api/config/domains-path',        body: { path: TMP_PICK },       label: 'domains-path' },
  { path: '/api/config/pick-folder',         body: {},                        label: 'pick-folder', refusedOnly: true },
  { path: '/api/config/api-keys',            body: { geminiApiKey: 'test-key-aaa' }, label: 'api-keys (save)' },
  { path: '/api/config/api-keys/disconnect', body: { provider: 'gemini' },   label: 'api-keys/disconnect' },
  { path: '/api/config/api-keys/active',     body: { provider: 'gemini' },   label: 'api-keys/active' },
];

console.log('\n=== 1. Isolation is real before any mutating request ===');
{
  const cfgPath = getCuratorConfigFile();
  assert(cfgPath.startsWith(TMP_USER),
    `resolved config file is inside the tempdir (${cfgPath})`);
  assert(!cfgPath.startsWith(REPO_ROOT + path.sep + '.curator-config'),
    'resolved config file is NOT the repo-root .curator-config.json');
  assert(registry.hasActiveWrites() === false, 'registry starts clean');
}

console.log('\n=== 2. Guard does NOT fire when idle (the half people forget) ===');
{
  registry.__testing._resetActiveWrites();
  for (const r of GUARDED.filter(r => !r.refusedOnly)) {
    const { status, body } = await post(r.path, r.body);
    assert(status !== 409, `${r.label}: not refused while idle (status ${status})`);
    assert(!body || body.conflict !== 'write_in_progress',
      `${r.label}: idle response carries no write_in_progress conflict`);
  }
  // And the normal path genuinely works, not merely "not 409":
  const dp = await post('/api/config/domains-path', { path: TMP_PICK });
  eq(dp.status, 200, 'domains-path succeeds while idle');
  assert(dp.body && dp.body.ok === true, 'domains-path returns ok:true while idle');
  const save = await post('/api/config/api-keys', { geminiApiKey: 'test-key-bbb' });
  eq(save.status, 200, 'api-keys save succeeds while idle');
  assert(save.body && save.body.ok === true, 'api-keys save returns ok:true while idle');
  assert(save.body.activeProvider === 'gemini',
    'api-keys save applies last-saved-wins while idle (activeProvider=gemini)');
  const act = await post('/api/config/api-keys/active', { provider: 'gemini' });
  eq(act.status, 200, 'api-keys/active succeeds while idle');
}

console.log('\n=== 3. Guard FIRES while a write is registered ===');
{
  const release = registry.registerWrite('articles', 'ingest');
  assert(registry.hasActiveWrites() === true, 'a write is registered');

  for (const r of GUARDED) {
    const { status, body } = await post(r.path, r.body);
    eq(status, 409, `${r.label}: refused with 409`);
    assert(body && body.conflict === 'write_in_progress',
      `${r.label}: body.conflict === "write_in_progress"`);
    assert(body && typeof body.error === 'string' && body.error.length > 0,
      `${r.label}: body carries a non-empty error string`);
    // `?? ''` rather than a bare deref: under a mutation that disables the
    // guard these fields are absent, and a TypeError here would abort the run
    // and hide every remaining failure — a mutation must produce a full,
    // readable RED, not a stack trace on the first assertion.
    const errText = (body && typeof body.error === 'string') ? body.error : '';
    // Actionable, not a bare 409 — the message must name what is running.
    assert(errText.includes('articles'), `${r.label}: error names the active domain`);
    assert(errText.includes('ingest'), `${r.label}: error names the active operation`);
    assert(/wait for it to finish/i.test(errText),
      `${r.label}: error tells the user what to do`);
    assert(body && Array.isArray(body.active) && body.active.length === 1,
      `${r.label}: body.active is structured for the frontend`);
    eq(body && body.updateInProgress, false, `${r.label}: updateInProgress flag present and false`);
    // The shipping frontend's pick-folder handler checks `data.cancelled`
    // BEFORE `res.ok`, so a refusal carrying that field would be silently
    // swallowed as "user pressed Cancel" and the error never shown.
    assert(!body || body.cancelled === undefined,
      `${r.label}: refusal does NOT carry a "cancelled" field`);
    // /api/config/update's frontend handler interpolates err.message into
    // innerHTML, so refusal text must be HTML-inert.
    assert(!/[<>&]/.test(errText), `${r.label}: error text is HTML-safe`);
  }

  // /pick-folder's refusal must come from the MIDDLEWARE, i.e. before
  // `osascript` is ever spawned. If the middleware were removed, the request
  // would reach execAsync and block on a real, modal Finder dialog for up to
  // its 60 s timeout. A sub-second refusal is therefore positive evidence that
  // no dialog was opened — and it is the only way to prove this route's guard
  // behaviourally without actually opening one on the developer's screen.
  const release2 = registry.registerWrite('articles', 'ingest');
  const t0 = Date.now();
  const pick = await post('/api/config/pick-folder', {});
  const elapsed = Date.now() - t0;
  eq(pick.status, 409, 'pick-folder refused with 409');
  assert(elapsed < 1000,
    `pick-folder refused in ${elapsed}ms — short-circuited before osascript spawned a dialog`);
  release2();

  release();
  assert(registry.hasActiveWrites() === false, 'registry clean after release');
}

console.log('\n=== 4. Guard releases correctly — routes work again afterwards ===');
{
  registry.__testing._resetActiveWrites();
  for (const r of GUARDED.filter(r => !r.refusedOnly)) {
    const { status } = await post(r.path, r.body);
    assert(status !== 409, `${r.label}: usable again once the write finished (status ${status})`);
  }
  // Refcount semantics: two writes on one domain need two releases.
  const rel1 = registry.registerWrite('articles', 'ingest');
  const rel2 = registry.registerWrite('articles', 'compile');
  rel1();
  assert(registry.hasActiveWrites() === true, 'still active after one of two releases');
  const stillRefused = await post('/api/config/api-keys/active', { provider: 'gemini' });
  eq(stillRefused.status, 409, 'still refused while the second write runs');
  rel2();
  const nowOk = await post('/api/config/api-keys/active', { provider: 'gemini' });
  assert(nowOk.status !== 409, 'allowed once the last write releases');
}

console.log('\n=== 5. Deliberately UNGUARDED routes stay unguarded ===');
{
  // /default-domain only selects which domain MCP write tools assume when the
  // user does not name one. An in-flight ingest already has an explicit
  // domain, so changing this cannot affect a write that is already running —
  // guarding it would be blanket application, not reasoning. Pinned so a
  // future sweep has to justify itself here.
  const release = registry.registerWrite('articles', 'ingest');
  const res = await fetch(BASE + '/api/config/default-domain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultDomain: '' }),
  });
  assert(res.status !== 409,
    `/default-domain is NOT guarded (status ${res.status}) — it cannot affect an in-flight write`);
  // GETs are never guarded — read-only, and the Settings UI polls them.
  const get = await fetch(BASE + '/api/config');
  eq(get.status, 200, 'GET /api/config still readable during a write');
  const keys = await fetch(BASE + '/api/config/api-keys');
  eq(keys.status, 200, 'GET /api/config/api-keys still readable during a write');
  release();
}

console.log('\n=== 6. Source guards — shape of the fix ===');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/config.js'), 'utf8');

  // Wording quality only — NOT a guard-presence invariant (that is section 6b
  // below, over the whole file). This just pins that each of the five known
  // guardConcurrent(...) calls names the right action phrase, so a refusal's
  // message stays accurate if someone edits one in passing.
  for (const [route, action] of [
    ['/domains-path', 'change the knowledge folder'],
    ['/pick-folder', 'change the knowledge folder'],
    ['/api-keys', 'save API keys'],
    ['/api-keys/disconnect', 'disconnect an API key'],
    ['/api-keys/active', 'switch the AI provider'],
  ]) {
    assert(src.includes(`guardConcurrent('${action}')`),
      `${route}: some guardConcurrent(...) call in config.js uses the action phrase "${action}"`);
  }

  // The refusal must be built by the SHARED conflictResponse, never a
  // hand-rolled 409 — that is what keeps status/body/message identical to
  // every other refusal in the app.
  assert(!/res\.status\(409\)/.test(src),
    'no hand-rolled 409 in config.js — all refusals go through conflictResponse()');

  // pick-folder's post-dialog re-check. The middleware only proves the state
  // when the dialog OPENED; osascript blocks for up to 60 s. This cannot be
  // exercised over HTTP without opening a real Finder dialog, so it is pinned
  // at the source level.
  const pickStart = src.indexOf(`router.post('/pick-folder'`);
  const pickEnd = src.indexOf(`router.post('/api-keys'`, pickStart);
  assert(pickStart !== -1 && pickEnd > pickStart, 'located the /pick-folder handler');
  const pickBody = src.slice(pickStart, pickEnd);
  const recheck = pickBody.indexOf('hasActiveWrites()');
  const setCall = pickBody.indexOf('setDomainsDir(picked)');
  assert(recheck !== -1, '/pick-folder re-checks hasActiveWrites() after the dialog returns');
  assert(recheck !== -1 && setCall !== -1 && recheck < setCall,
    '/pick-folder re-check happens BEFORE setDomainsDir(picked), not after');

  // /update must keep its own guard -- this change must not have disturbed it.
  const upStart = src.indexOf("router.post('/update'");
  assert(upStart !== -1 && src.slice(upStart, upStart + 1200).includes('hasActiveWrites()'),
    'POST /update still carries its original hasActiveWrites() guard');

  // sync.js's own "every mutating route must carry guardConcurrent" invariant
  // moved to section 6b below — a line-oriented, single-quote-only regex used
  // to live here, claimed to be a class invariant, and was mutation-proven to
  // be a per-route spot check (defeated by a double-quoted path, and it flagged
  // a false positive when a guard sat on the line AFTER the declaration).

  // ── domains.js: rename and delete use the PER-DOMAIN predicate ──────────
  // A rename or delete affects exactly one domain, so blocking either because
  // an unrelated domain is busy would be broader than the harm. Pin that they
  // do NOT reach for the global hasActiveWrites().
  const domSrc = readFileSync(path.join(REPO_ROOT, 'src/routes/domains.js'), 'utf8');
  const putStart = domSrc.indexOf("router.put('/:domain'");
  const delStart = domSrc.indexOf("router.delete('/:domain'");
  assert(putStart !== -1 && delStart > putStart, 'located domains.js PUT and DELETE handlers');
  const putBodyRaw = domSrc.slice(putStart, delStart);
  // Strip line comments before these assertions. The handler's own docblock
  // explains WHY it uses isDomainActive "rather than the global
  // hasActiveWrites()" and mentions "renameDomain() moves the directory" --
  // both of which a naive substring test happily matches, so the first version
  // of these two assertions was measuring prose instead of code and went RED
  // against correct source. An assertion about code must read code.
  const putBody = putBodyRaw.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert(/isDomainActive\(req\.params\.domain\)/.test(putBody),
    'domains.js PUT /:domain guards with isDomainActive(req.params.domain)');
  assert(!/hasActiveWrites\(/.test(putBody),
    'domains.js PUT /:domain does NOT use the global hasActiveWrites()');
  assert(/isDomainActive\(/.test(domSrc.slice(delStart, delStart + 800)),
    'domains.js DELETE /:domain still guards with isDomainActive (unchanged)');
  // The guard must precede the work, not sit after it.
  assert(putBody.indexOf('isDomainActive') < putBody.indexOf('renameDomain('),
    'domains.js PUT guard runs BEFORE renameDomain()');
}

// health.js's guard-class config, hoisted to MODULE SCOPE so it is defined
// EXACTLY ONCE. Before the v3.6.2 fix this array lived inline inside the
// auditRouteGuards('src/routes/health.js', {...}) call below (section 6b),
// and section 13's coverage pin (originally ~250 lines further down) kept
// its OWN hand-typed copy of the writability class's six exempt paths —
// two lists a maintainer had to remember to update together. A route added
// to that SECOND, section-13-only list — without ever being added here —
// would be silently excluded from the behavioural sweep while still passing
// the source-scan in 6b (finding 9a). Two hand-maintained copies of the same
// data is the exact shape that produced this repo's v3.2.0 CRITICAL (two
// hand-maintained copies of a path guard, which drifted); the fix here is
// structural, not a one-time sync: computeWritabilityCoverage() (above) and
// every consumer of this constant read it from this ONE place.
//
// ── Why this is a LIST of guard classes, not one token list ────────────
//
// It used to take a single `guardTokens`/`guardMode`/`exemptions` triple, and
// that shape is precisely how it missed the v3.6.1 follow-up defect. health.js
// protects itself along TWO INDEPENDENT AXES:
//
//   • CONCURRENCY — registerWrite + acquireFileLock + isUpdateInProgress:
//     "do not interleave this write with another one."
//   • WRITABILITY — assertWritableDomain: "do not write into a read-only
//     Shared Brain mirror at all, however quiet the moment is."
//
// A single token list can only express one axis. The old config expressed the
// concurrency axis, so `assertWritableDomain` was not a checked token ANYWHERE
// — and a single shared exemption list then let a route be waved past both
// axes on a rationale that had only ever considered the first. Mutation-proven
// before that rewrite: deleting assertWritableDomain from POST /:domain/fix-all
// — a fully in-scope, non-exempted, bulk-destructive route — left the suite at
// Passed: 213  Failed: 0. The blindness was never specific to /dismiss.
//
// So each axis is its own class with its OWN exemption list. A route exempt
// from concurrency is still checked for writability, which is exactly the
// /dismiss + /undismiss case: a sidecar write that needs no lock (the MCP
// twins take none either) but absolutely must refuse a mirror.
//
// Exemptions remain the inversion described before: every mutating route is in
// scope by default and only an explicit, justified exemption removes it — but
// an exemption now removes it from ONE named axis, never from the sweep.
//
// ── ENFORCED / NOT ENFORCED (finding 7) ─────────────────────────────────
//
// A re-audit reproduced this exact mutation against a real POST /:domain/
// fix-all handler and confirmed `npm test` stayed at Passed: 340  Failed: 0:
//
//   - const releaseRegistry = registerWrite(domain, 'health-fix-all');
//   + const releaseRegistry = (false ? registerWrite(domain, 'health-fix-all') : (() => {}));
//
// bodyIsGuarded() is a TEXT scan (`\bregisterWrite\s*\(`). The token
// `registerWrite(` still appears verbatim in the mutated line — inside dead
// code that never executes — so the source scan cannot distinguish a live
// call from a guard-shaped corpse. This is not a fixable regex: the same
// shape can be built with `if (false) {…}`, `0 && registerWrite(…)`, a flag
// threaded in from elsewhere, etc. — an unbounded family, not a pattern to
// enumerate. Only running the code and observing the registry can tell them
// apart, which is exactly the asymmetry between the two axes below.
//
// WRITABILITY — ENFORCED BEHAVIOURALLY for all 8 routes in the class.
//   Section 13 drives every writability-class route over real HTTP against a
//   real read-only mirror domain and asserts the ACTUAL refusal (status,
//   message, zero side effects). A present-but-inert `assertWritableDomain`
//   would fail those assertions for real — the mirror request would not
//   actually be refused — regardless of what the dead code around it says.
//   Source-scan (bodyIsGuarded, in 6b) runs too, as a cheap first pass, but
//   is not what makes this axis trustworthy; the live sweep is.
//
// CONCURRENCY — ENFORCED BEHAVIOURALLY for exactly TWO routes: POST /:domain/
//   fix (section 11(b)) and POST /:domain/fix-all (section 11(e), added by
//   this fix). Both are driven for real against a real, large domain; the
//   assertions poll the LIVE `registry.listActiveWrites()` while the request
//   is in flight and require the domain to actually appear there, under the
//   real op label, with a concurrent sync/delete genuinely refused. A
//   present-but-inert guard on either of these two routes WOULD be caught —
//   the poll would simply never observe the domain and the assertion would
//   fail. Section 15 proves this mechanism actually distinguishes "live" from
//   "dead code" using a synthetic reproduction of the reported mutation, since
//   health.js itself cannot be mutated to prove it directly (out of scope for
//   this file to edit).
//
//   NOT ENFORCED BEHAVIOURALLY — source-scan only (bodyIsGuarded, 6b) — for
//   every OTHER route in the concurrency class: /ai-settings, /:domain/
//   ai-suggest, /:domain/semantic-dupes/scan, /:domain/semantic-dupes/preview,
//   /:domain/broken-links/plan, /:domain/orphans/plan, /:domain/dismiss,
//   /:domain/undismiss, /:domain/fix-all-safe, /:domain/broken-links/apply,
//   /:domain/orphans/apply, /:domain/semantic-dupes/merge-batch. For these, a
//   present-but-inert registerWrite/acquireFileLock/isUpdateInProgress call
//   (dead-code-wrapped, wrongly-scoped, or otherwise never actually reached)
//   would NOT be caught by this suite today — only a guard token that is
//   textually ABSENT is caught for them. This is a real, acknowledged gap,
//   not a closed one; recorded here rather than left for the next reviewer to
//   discover by reproducing the same mutation against a different route.
const HEALTH_GUARD_CLASSES = [
  {
    // ── AXIS 1: do not INTERLEAVE this write with another one ──────────
    // A three-guard combo, not any single one.
    name: 'concurrency',
    guardTokens: ['registerWrite', 'acquireFileLock', 'isUpdateInProgress'],
    guardMode: 'all',
    exemptions: [
      { method: 'POST', path: '/ai-settings', reason:
        'writes only the aiHealth cost-ceiling/candidate-pair-cap settings to .curator-config.json — never touches a domain at all.' },
      { method: 'POST', path: '/:domain/ai-suggest', reason:
        'health-ai.js is READ-ONLY by design (the v2.4.3 invariant) — proposes a target, never writes; the actual write happens through the guarded /fix route.' },
      { method: 'POST', path: '/:domain/semantic-dupes/scan', reason:
        'runs the LLM scan and streams candidate pairs; read-only (health-ai.js), no wiki write.' },
      { method: 'POST', path: '/:domain/semantic-dupes/preview', reason:
        'computes and returns a merge diff preview; read-only, no wiki write.' },
      { method: 'POST', path: '/:domain/broken-links/plan', reason:
        'runs the deterministic pre-pass + AI batches and streams the plan; read-only — the write happens in the separate, guarded /broken-links/apply route.' },
      { method: 'POST', path: '/:domain/orphans/plan', reason:
        'same shape as broken-links/plan — read-only planning stage; the write happens in the separate, guarded /orphans/apply route.' },
      // The two below are exempt from CONCURRENCY only. They remain fully
      // in scope for the writability axis — that separation is the whole
      // point of splitting the classes, and its absence is what let the
      // v3.6.1 defect through.
      //
      // The previous rationale here read "not wiki content", which is
      // FALSE and is corrected: the store is <domain>/wiki/.health-
      // dismissed.jsonl, i.e. inside the git-tracked, synced wiki/ folder
      // (health-dismissed.js's own docblock says so: "our file lives
      // INSIDE wiki/ so it travels with the rest of the wiki"). Being
      // synced is exactly why the writability guard IS required.
      { method: 'POST', path: '/:domain/dismiss', reason:
        'no LOCK needed: it writes one sidecar via writeFileAtomic (rename-atomic, so a concurrent sync sees old-or-new, never torn) and touches no wiki page, so it cannot interleave with an ingest\'s page writes. The MCP twin dismiss_wiki_issue deliberately takes no file lock either (mcp/tools/dismissed.js) while fix_wiki_issue and compile_to_wiki both do — the two surfaces already agree on this distinction. RESIDUAL, recorded not hidden: two simultaneous dismissals are a read-modify-write race that can lose one (writeRecords rewrites the whole file); pre-existing, unrelated to this axis, and blunted by addDismissal\'s duplicate-key no-op.' },
      { method: 'POST', path: '/:domain/undismiss', reason:
        'same shape and same MCP parity as /dismiss above; rewrites the one sidecar file atomically, no wiki page touched.' },
    ],
  },
  {
    // ── AXIS 2: do not write into a READ-ONLY mirror at all ────────────
    // assertWritableDomain refuses a shared-* Shared Brain mirror with a
    // 400 + steer message (Decision 7). This axis did not exist before
    // v3.6.1's follow-up: `assertWritableDomain` was not a checked token
    // anywhere in this file, so the invariant was blind to its removal on
    // EVERY health route, not merely the two that were missing it.
    //
    // Scope of the axis: any route that writes ANYTHING into
    // domains/<domain>/ — wiki content or sidecar alike. Both get
    // overwritten by the next Pull on a mirror, which is the harm.
    name: 'writability',
    guardTokens: ['assertWritableDomain'],
    guardMode: 'all',
    exemptions: [
      { method: 'POST', path: '/ai-settings', reason:
        'not domain-scoped — writes app config only; there is no :domain to be read-only.' },
      { method: 'POST', path: '/:domain/ai-suggest', reason:
        'READ-ONLY (v2.4.3 invariant): proposes, never writes. Reading a mirror is explicitly allowed — scanning mirrors stays permitted so users can spot conflict markers.' },
      { method: 'POST', path: '/:domain/semantic-dupes/scan', reason:
        'read-only scan; writes nothing to the domain.' },
      { method: 'POST', path: '/:domain/semantic-dupes/preview', reason:
        'read-only diff preview; writes nothing to the domain.' },
      { method: 'POST', path: '/:domain/broken-links/plan', reason:
        'read-only planning stage; the write is in /broken-links/apply, which carries the guard.' },
      { method: 'POST', path: '/:domain/orphans/plan', reason:
        'read-only planning stage; the write is in /orphans/apply, which carries the guard.' },
      // NOTHING ELSE. /dismiss and /undismiss are deliberately NOT here.
    ],
  },
];

console.log('\n=== 6b. INVARIANT: every mutating route in these four files is guarded or explicitly exempted ===');
{
  // The class assertion, over ALL FOUR route files that mutate wiki state or
  // app config, using the single shared classifier defined above. Replaces:
  //   - sync.js's line-oriented, single-quote-only "invariant" (defeated by a
  //     double-quoted path, or a guard on the following line);
  //   - config.js's hardcoded 5-route loop (never looked at a 6th route);
  //   - domains.js's total absence of a file-wide invariant (only PUT/DELETE
  //     had ad hoc checks; POST '/' was never reasoned about at all);
  //   - health.js's comment-stripped scanner gated behind a hardcoded
  //     DESTRUCTIVE function-name allow-list (a new destructive helper under
  //     an unlisted name was invisible to it).
  //
  // Each mutating route must EITHER carry a guard (any-of / all-of per file,
  // matching how that file actually protects itself) OR appear on that file's
  // explicit, reasoned EXEMPTIONS list below. There is no third option — an
  // unrecognised new route is neither guarded nor exempted, and fails.

  auditRouteGuards('src/routes/sync.js', {
    label: 'sync.js',
    expectedMutatingCount: 5,
    guardClasses: [{
      name: 'concurrency',
      guardTokens: ['guardConcurrent'],
      guardMode: 'any',
      exemptions: [], // every mutating route here runs a real git operation over the wiki repo
    }],
  });

  auditRouteGuards('src/routes/config.js', {
    label: 'config.js',
    // default-domain, domains-path, pick-folder, api-keys, api-keys/disconnect,
    // api-keys/active, api-keys/model, update.
    //
    // 8th (api-keys/model, v3.12.x): persists the user's per-provider MODEL
    // choice. It is in the concurrency class and NOT exempt, and the reason is
    // the sharpest instance of this file's own founding hazard. v3.6.0 guarded
    // the five routes above it because getProviderInfo() resolves FRESH PER
    // CALL, so a provider switch mid-ingest could silently finish a run on a
    // different model. This route changes WHICH MODEL answers, and llm.js's
    // resolveProviderDefault now consults the stored choice on every single LLM
    // call — so unguarded, a click during a 40-minute multi-phase ingest plans
    // the outline on one model and writes Phase-2 batches on another, producing
    // a wiki nobody chose, with nothing downstream to flag it. It would also
    // invalidate Anthropic's prompt cache mid-run (a different model is a
    // different cache namespace, so every cached prefix READ becomes a WRITE at
    // 1.25x — the v3.0.16 saving inverted into a surcharge) and make the ingest
    // queue's per-item spend arithmetic wrong, since price is looked up per
    // model.
    //
    // It carries guardConcurrent (hasActiveWrites), matching its provider-shaped
    // sibling api-keys/active exactly. Deliberately NOT isUpdateInProgress:
    // that token guards the OTHER direction — a domain write checking whether an
    // app update is running (health.js's use) — whereas this is a config
    // mutation being protected FROM an in-flight write. /update already refuses
    // while writes are active, so the pair is closed from both sides.
    //
    // 11th (openrouter/qualify, this release): runs the on-wiki model probe.
    // It CARRIES guardConcurrent and needs no exemption. It is in the
    // concurrency class for the same reason api-keys/model is — a completed run
    // can promote a model into the BUILD LANE, changing what
    // resolveProviderDefault returns for every subsequent ingest, Health scan
    // and Compile call, which mid-run is the "plans on one model, writes on
    // another" hazard reached through a different door. It also spends the
    // user's key concurrently with whatever is already spending it.
    //
    // Its sibling GET /openrouter/qualify/estimate is NOT counted here: it is a
    // GET, and GETs are never in the mutating set. It is also deliberately
    // unguarded — it is a read-only estimate and refusing it mid-ingest would
    // deny the user the one screen that says what a run would cost, the same
    // reasoning api-keys/validate is exempted on.
    //
    // 9th (api-keys/validate, v3.15.0): a READ-ONLY key check. The count moved
    // 8 -> 9 in this release and that is exactly what this tripwire is for —
    // it does not assert "eight is correct", it asserts "the set of routes has
    // not moved without a human looking at the exemption list below". Bumping
    // it IS that look. See the exemption entry for why the new route carries no
    // concurrency guard; the classifier below deliberately stays VERB-BASED, so
    // a read-only POST trips it and must be exempted by name rather than being
    // waved through by a cleverer classifier that could also wave through a
    // genuinely destructive one.
    // 11 -> 12: POST /api-keys/build-model, the ONE build model (provider and
    // model chosen together so a pin can never be inert). It carries
    // guardConcurrent and needs no exemption — the bump IS the human look the
    // comment above demands, and the guard assertions below check it like any
    // other mutating route.
    expectedMutatingCount: 12,
    guardClasses: [{
      name: 'concurrency',
      // /update guards itself with a direct hasActiveWrites() check (it also
      // sets the global updateInProgress flag, so it can't reuse the plain
      // guardConcurrent() middleware unchanged) — both count as "guarded".
      guardTokens: ['guardConcurrent', 'hasActiveWrites'],
      guardMode: 'any',
      exemptions: [
        { method: 'POST', path: '/default-domain', reason:
          'selects which domain MCP write tools assume when the caller does not name one; an in-flight write already carries an explicit domain captured at request time, so changing this default cannot affect it (see CLAUDE.md section 5 of this same file\'s own docblock).' },
        { method: 'POST', path: '/api-keys/validate', reason:
          'read-only key check — one zero-token GET to the provider, writes no state; POST only so the cross-origin guard applies. Precedent: sharedbrain /validate-pat, diagnostics /live. Guarding it would be actively HARMFUL, not merely redundant: a 409 here fires precisely while a multi-phase ingest is running, i.e. exactly when a user is asking "is my key the problem?" — it would refuse the diagnostic at the moment it is needed. This is the same reasoning the writability axis on health.js uses for its six read-only POSTs (/ai-suggest, /semantic-dupes/scan, /semantic-dupes/preview, /broken-links/plan, /orphans/plan): the verb says mutate, the body does not.' },
      ],
    }],
    // No writability class: config.js routes are not domain-scoped, so there
    // is no domain whose read-only status could be violated.
  });

  auditRouteGuards('src/routes/domains.js', {
    label: 'domains.js',
    expectedMutatingCount: 3, // POST '/', PUT '/:domain', DELETE '/:domain'
    guardClasses: [{
      name: 'concurrency',
      guardTokens: ['isDomainActive', 'hasActiveWrites'],
      guardMode: 'any',
      exemptions: [
        { method: 'POST', path: '/', reason:
          'creates a brand-new domain at a freshly generated, not-yet-existing slug — there is no existing directory or in-flight write it could conflict with.' },
      ],
    }],
  });

  auditRouteGuards('src/routes/health.js', {
    label: 'health.js',
    expectedMutatingCount: 14,
    // Defined once, at module scope, as HEALTH_GUARD_CLASSES (above section
    // 6) -- NOT re-typed here. Section 13's coverage pin and section 14's
    // mutation-proof fixtures read the SAME object via
    // computeWritabilityCoverage(), so there is exactly one place these
    // exemptions are declared. See HEALTH_GUARD_CLASSES's own docblock for
    // the two-axis rationale and the v3.6.1 defect it fixes.
    guardClasses: HEALTH_GUARD_CLASSES,
  });

  // Control: prove the classifier CAN see a missing guard on a synthetic
  // handler shaped like the real bug this section exists to catch (an
  // unguarded call to a destructive write helper) — so the assertions above
  // are not vacuously green.
  const fakeGuarded   = "router.post('/x', async (req,res) => { registerWrite(d,'y'); acquireFileLock(p); isUpdateInProgress(); await fixIssue(d,t,i); });";
  const fakeUnguarded = "router.post('/x', async (req,res) => { await fixIssue(d,t,i); });";
  assert(bodyIsGuarded(fakeGuarded, ['registerWrite', 'acquireFileLock', 'isUpdateInProgress'], 'all'),
    '  (control) a handler carrying all three guards is classified as guarded');
  assert(!bodyIsGuarded(fakeUnguarded, ['registerWrite', 'acquireFileLock', 'isUpdateInProgress'], 'all'),
    '  (control) an unguarded destructive-shaped handler is classified as NOT guarded');
}

console.log('\n=== 7. The real credential files were never touched ===');
{
  eq(fingerprint(), FINGERPRINT_BEFORE,
    'real .curator-config.json / .sync-config.json / .sharedbrain-config.json unchanged (sha256+size)');
  // And the tempdir config really did receive the writes, proving section 2's
  // mutations landed somewhere — an isolation that wrote nowhere would make
  // the fingerprint assertion above vacuous.
  const tmpCfg = getCuratorConfigFile();
  assert(existsSync(tmpCfg), 'the isolated tempdir config WAS written to (isolation is not vacuous)');
  const parsed = JSON.parse(readFileSync(tmpCfg, 'utf8'));
  assert(parsed.geminiApiKey === 'test-key-bbb' || typeof parsed.geminiApiKey === 'string',
    'tempdir config holds the test key, not a real one');
}


console.log('\n=== 8. POST /api/sync/setup is guarded like its four siblings ===');
{
  // setup() runs git init + \`git add -A\` + commit + \`git push\` across the
  // domains work-tree. It is NEVER invoked for real here: the idle half sends
  // a deliberately invalid body so its own validation answers 400, which
  // proves the guard did NOT short-circuit without performing any git or
  // network operation. 400 vs 409 is the whole distinction being tested.
  registry.__testing._resetActiveWrites();
  const idle = await post('/api/sync/setup', {});
  eq(idle.status, 400, 'sync/setup reaches its own validation when idle (400, not 409)');
  assert(idle.body && /repoUrl/i.test(idle.body.error || ''),
    'sync/setup idle response is its real validation error, not a refusal');

  const release = registry.registerWrite('articles', 'ingest');
  const busy = await post('/api/sync/setup', {});
  eq(busy.status, 409, 'sync/setup refused with 409 while a write is running');
  assert(busy.body && busy.body.conflict === 'write_in_progress',
    'sync/setup refusal carries conflict: write_in_progress');
  assert(busy.body && /articles/.test(busy.body.error || ''),
    'sync/setup refusal names the active domain');
  assert(busy.body && !/repoUrl/i.test(busy.body.error || ''),
    'sync/setup refusal short-circuits BEFORE body validation (no git, no network)');
  // The shipping sync wizard duck-types on data.success; a refusal must not
  // carry one, or the wizard would treat the refusal as a successful setup.
  assert(busy.body && busy.body.success === undefined,
    'sync/setup refusal does NOT carry a "success" field');

  // THE TRAP for this route, and the reason the action phrase is "set up sync".
  // app.js's submitSyncSetup catch (app.js:4587) runs a network-down regex over
  // ANY thrown message -- including a structured 409's error text -- and on a
  // match REPLACES it with "The Curator server stopped responding during
  // setup...". That regex carries a bare, unanchored "connection" alternative,
  // which a natural phrasing like "change the repository connection" would trip,
  // silently discarding the real refusal. Same class as the "cancelled" trap on
  // /pick-folder: the guard fires and the user is told something false.
  //
  // The regex is EXTRACTED FROM app.js rather than copied, so if that line is
  // reworded this assertion follows it instead of quietly rotting.
  const appJs = readFileSync(path.join(REPO_ROOT, 'src/public/app.js'), 'utf8');
  const reLine = appJs.match(/const isNetworkDown = \/([^\n]+?)\/i\.test\(raw\)/);
  assert(!!reLine, 'located app.js isNetworkDown regex (if RED, re-verify the sync-wizard trace)');
  if (reLine) {
    const netRe = new RegExp(reLine[1], 'i');
    assert(!netRe.test((busy.body && busy.body.error) || ''),
      'sync/setup refusal does NOT trip app.js network-down regex (else it is replaced by a false "server stopped responding" message)');
    // Prove that assertion CAN fail -- a regex matching nothing would make it
    // vacuously green.
    assert(netRe.test('the connection was reset'),
      '  (control) the extracted regex really does match a network-shaped message');
  }
  release();
}

console.log('\n=== 9. PUT /api/domains/:domain (rename) is guarded, PER DOMAIN ===');
{
  registry.__testing._resetActiveWrites();
  // Fixture: two real domains in the isolated tempdir.
  for (const name of ['alpha', 'other']) {
    for (const sub of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw', 'conversations'])
      mkdirSync(path.join(TMP_DOMAINS, name, sub), { recursive: true });
    writeFileSync(path.join(TMP_DOMAINS, name, 'CLAUDE.md'), '# Domain: ' + name + '\n');
    writeFileSync(path.join(TMP_DOMAINS, name, 'wiki/index.md'), '# Wiki Index — ' + name + '\n');
    writeFileSync(path.join(TMP_DOMAINS, name, 'wiki/log.md'), '# Ingest Log — ' + name + '\n');
  }

  const busyRelease = registry.registerWrite('alpha', 'ingest');
  const refused = await put('/api/domains/alpha', { displayName: 'Renamed Alpha' });
  eq(refused.status, 409, 'rename refused with 409 while THAT domain is being written');
  assert(refused.body && refused.body.conflict === 'write_in_progress',
    'rename refusal carries conflict: write_in_progress');
  assert(refused.body && /rename domain/i.test(refused.body.error || ''),
    'rename refusal names the attempted operation');
  assert(existsSync(path.join(TMP_DOMAINS, 'alpha')),
    'the refused rename did NOT move the directory');

  // THE distinguishing assertion: the predicate is per-domain (isDomainActive),
  // matching the sibling DELETE — not the global hasActiveWrites(). A write on
  // an unrelated domain must NOT block this rename.
  const otherOk = await put('/api/domains/other', { displayName: 'Other Renamed' });
  assert(otherOk.status !== 409,
    'an unrelated domain is still renameable while "alpha" is busy (per-domain predicate, not global)');
  busyRelease();

  // Idle half: the rename genuinely works.
  registry.__testing._resetActiveWrites();
  const ok = await put('/api/domains/alpha', { displayName: 'Alpha Renamed' });
  assert(ok.status !== 409, 'rename not refused when idle (status ' + ok.status + ')');
  eq(ok.status, 200, 'rename succeeds when idle');
}

console.log('\n=== 10. Regression: the harm the rename guard exists to prevent ===');
{
  // Drives the real files.js functions to pin the mechanism, so the guard's
  // rationale is executable rather than a claim in a comment.
  //
  // If this section ever goes RED because writePage() stopped resurrecting the
  // directory, that does NOT mean the guard can be removed — the display-name
  // branch still races appendLog() over log.md. It means this rationale needs
  // rewriting to match the new behaviour.
  const d = path.join(TMP_DOMAINS, 'harm');
  for (const sub of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw'])
    mkdirSync(path.join(d, sub), { recursive: true });
  writeFileSync(path.join(d, 'CLAUDE.md'), '# Domain: harm\n');
  writeFileSync(path.join(d, 'wiki/index.md'), '# Wiki Index — harm\n');
  writeFileSync(path.join(d, 'wiki/log.md'), '# Ingest Log — harm\n');

  await writePage('harm', 'entities/before.md', '# Before\n\n## Key Facts\n\n- one\n');
  await renameDomain('harm', 'harm-renamed', 'Harm Renamed');
  assert(!existsSync(path.join(TMP_DOMAINS, 'harm')), 'rename moved the directory away');

  // An in-flight ingest keeps writing to the slug it captured at request time.
  const after = await writePage('harm', 'entities/after.md', '# After\n\n## Key Facts\n\n- two\n');
  assert(after !== null, 'writePage to the OLD slug does not fail loudly — it silently succeeds');
  assert(existsSync(path.join(TMP_DOMAINS, 'harm', 'wiki/entities/after.md')),
    'the remaining page landed in a RESURRECTED ghost directory (writePage mkdirs it)');
  assert(!existsSync(path.join(TMP_DOMAINS, 'harm', 'CLAUDE.md')),
    'the ghost has no CLAUDE.md');
  const visible = await listDomains();
  assert(!visible.includes('harm'),
    'listDomains() HIDES the ghost — those pages are invisible in every UI surface');
  assert(visible.includes('harm-renamed'), 'only the renamed domain is visible');
  assert(existsSync(path.join(TMP_DOMAINS, 'harm-renamed', 'wiki/entities/before.md')) &&
         !existsSync(path.join(TMP_DOMAINS, 'harm-renamed', 'wiki/entities/after.md')),
    'the document is SPLIT: first half in the renamed domain, second half orphaned');
}

console.log('\n=== 11. POST /api/health/:domain/fix is guarded like /fix-all ===');
{
  // IMPORTANT — what "guarded" means for this route, and what it does NOT mean.
  // The first version of this section asserted /fix returns 409 while an ingest
  // is registered. It does not, and neither does /fix-all: registerWrite() is
  // not a mutual-exclusion gate between two writes. The protection runs the
  // OTHER way -- /fix now REGISTERS, so a concurrent sync / update / domain
  // delete refuses while it runs -- plus an isUpdateInProgress() check, which
  // is the only condition under which /fix itself refuses. Asserting the
  // assumed behaviour instead of the real one produced a RED against correct
  // source; these assertions measure what the guard actually provides.
  registry.__testing._resetActiveWrites();
  registry.__testing._resetUpdate();

  const build = (dom, n) => {
    for (const sub of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw'])
      mkdirSync(path.join(TMP_DOMAINS, dom, sub), { recursive: true });
    writeFileSync(path.join(TMP_DOMAINS, dom, 'CLAUDE.md'), '# Domain: ' + dom + '\n');
    writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/index.md'), '# Wiki Index\n');
    writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/log.md'), '# Ingest Log\n');
    for (let i = 0; i < n; i++) {
      writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/concepts/c' + i + '.md'), '# c' + i + '\n');
      writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/entities/e' + i + '.md'),
        '# e' + i + '\n\n## Related\n\n- [[concepts/c' + i + ']]\n');
    }
  };
  const page = (d, i) => path.join(TMP_DOMAINS, d, 'wiki/entities/e' + i + '.md');

  // ── (a) refuses while an app update is in progress; not when idle ────────
  build('hfix', 2);
  const beforeBytes = readFileSync(page('hfix', 0), 'utf8');
  registry.beginUpdate();
  const duringUpdate = await post('/api/health/hfix/fix', { type: 'folderPrefixLinks' });
  eq(duringUpdate.status, 409, '/fix refused with 409 while an app update is in progress');
  assert(duringUpdate.body && duringUpdate.body.conflict === 'write_in_progress',
    '/fix refusal carries conflict: write_in_progress');
  assert(duringUpdate.body && /fix an issue in domain/i.test(duringUpdate.body.error || ''),
    '/fix refusal names the attempted operation');
  eq(readFileSync(page('hfix', 0), 'utf8'), beforeBytes,
    '/fix refusal performed NO partial work — the page is byte-identical');
  assert(duringUpdate.body && duringUpdate.body.ok === undefined,
    '/fix refusal does NOT carry ok:true');
  assert(duringUpdate.body && duringUpdate.body.fixed === undefined,
    '/fix refusal does NOT carry a "fixed" count');
  registry.endUpdate();

  const idle = await post('/api/health/hfix/fix', { type: 'folderPrefixLinks' });
  assert(idle.status !== 409, '/fix NOT refused when idle (status ' + idle.status + ')');
  eq(idle.status, 200, '/fix succeeds when idle');
  assert(idle.body && idle.body.ok === true, '/fix returns ok:true when idle');
  assert(!readFileSync(page('hfix', 0), 'utf8').includes('[[concepts/'),
    '/fix genuinely rewrote the folder-prefix link (not merely "not 409")');

  // ── (b) THE PROTECTION GAINED: /fix registers, so destructive siblings
  //        refuse while it is in flight. This is the whole point of the fix.
  build('hbusy', 900);
  let seenOps = null, syncDuring = null, deleteDuring = null;
  const inFlight = post('/api/health/hbusy/fix', { type: 'folderPrefixLinks' });
  for (let i = 0; i < 400; i++) {                    // poll until it registers
    const active = registry.listActiveWrites();
    if (active.some(a => a.domain === 'hbusy')) {
      seenOps = active.find(a => a.domain === 'hbusy').ops;
      syncDuring = await post('/api/sync/push', {});
      deleteDuring = await del('/api/domains/hbusy');
      break;
    }
    await new Promise(r => setTimeout(r, 2));
  }
  const done = await inFlight;
  eq(done.status, 200, '/fix completed');
  assert(seenOps !== null, '/fix registered itself in the write registry while running');
  assert(seenOps && seenOps.includes('health-fix'),
    '/fix registers under the label "health-fix" (got ' + JSON.stringify(seenOps) + ')');
  assert(syncDuring && syncDuring.status === 409,
    'a concurrent sync push is REFUSED while /fix runs (status ' + (syncDuring && syncDuring.status) + ')');
  assert(deleteDuring && deleteDuring.status === 409,
    'a concurrent domain delete is REFUSED while /fix runs (status ' + (deleteDuring && deleteDuring.status) + ')');
  assert(existsSync(path.join(TMP_DOMAINS, 'hbusy')),
    'the refused delete did NOT remove the domain mid-fix');
  // Poll rather than assert immediately: the client receives the response from
  // res.json() inside the try, while releaseRegistry() runs in the finally that
  // follows — so there is a legitimate tick where the response has arrived and
  // the registration is still held. Asserting instantly made this RED against
  // correct source.
  let released = false;
  for (let i = 0; i < 200; i++) {
    if (registry.listActiveWrites().every(a => a.domain !== 'hbusy')) { released = true; break; }
    await new Promise(r => setTimeout(r, 5));
  }
  assert(released, '/fix released its registration when it finished');

  // ── (d) the cross-process file lock, exercised behaviourally ────────────
  // Mutation-testing showed the lock was covered only by the source invariant
  // in section 6b, so removing it went RED for a source reason and not a
  // behavioural one. A lock file stamped with THIS process's pid reads as held
  // by a live owner (isPidAlive is true for self), which is exactly the state a
  // concurrent MCP write produces.
  build('hlock', 2);
  writeFileSync(path.join(TMP_DOMAINS, 'hlock', '.write-lock'), JSON.stringify({
    pid: process.pid, op: 'mcp:fix_wiki_issue', startedAt: Date.now(), hostname: 'test',
  }));
  const lockedBefore = readFileSync(page('hlock', 0), 'utf8');
  const locked = await post('/api/health/hlock/fix', { type: 'folderPrefixLinks' });
  eq(locked.status, 409, '/fix refused with 409 while another process holds the file lock');
  assert(locked.body && locked.body.conflict === 'file_lock',
    "/fix lock refusal carries conflict: 'file_lock' (distinct from write_in_progress)");
  eq(readFileSync(page('hlock', 0), 'utf8'), lockedBefore,
    '/fix lock refusal performed NO partial work');
  rmSync(path.join(TMP_DOMAINS, 'hlock', '.write-lock'));
  const afterUnlock = await post('/api/health/hlock/fix', { type: 'folderPrefixLinks' });
  eq(afterUnlock.status, 200, '/fix works again once the lock is released');

  // ── (c) parity: /fix-all behaves identically, proving a mirror not an invention
  build('hpar', 2);
  registry.beginUpdate();
  const faUpd = await post('/api/health/hpar/fix-all', { type: 'folderPrefixLinks' });
  const fUpd  = await post('/api/health/hpar/fix',     { type: 'folderPrefixLinks' });
  eq(fUpd.status, faUpd.status, '/fix and /fix-all agree on status during an update');
  eq(fUpd.body && fUpd.body.conflict, faUpd.body && faUpd.body.conflict,
    '/fix and /fix-all agree on the conflict field during an update');
  registry.endUpdate();

  // ── (e) FINDING 7 real coverage: /fix-all REGISTERS ITSELF in the write
  //        registry, driven live — not merely "agrees with /fix's status
  //        during an update" (part c, which never touches registerWrite at
  //        all). Part (b) above already proves this shape for /fix; a
  //        re-audit reproduced the exact reported mutation
  //        (registerWrite(domain, 'health-fix-all') replaced by dead code
  //        behind `false ? … : (() => {})`) against /fix-all specifically and
  //        found nothing in this file drove it the same way part (b) drives
  //        /fix — so the source-scan-visible token was never behaviourally
  //        checked for THIS route. This closes that gap by polling the LIVE
  //        registry while a real /fix-all request is in flight, exactly like
  //        part (b) does for /fix.
  registry.__testing._resetActiveWrites();
  build('hfaall', 900);
  let seenOpsAll = null, syncDuringAll = null, deleteDuringAll = null;
  const inFlightAll = post('/api/health/hfaall/fix-all', { type: 'folderPrefixLinks' });
  for (let i = 0; i < 400; i++) {                    // poll until it registers
    const activeAll = registry.listActiveWrites();
    if (activeAll.some(a => a.domain === 'hfaall')) {
      seenOpsAll = activeAll.find(a => a.domain === 'hfaall').ops;
      syncDuringAll = await post('/api/sync/push', {});
      deleteDuringAll = await del('/api/domains/hfaall');
      break;
    }
    await new Promise(r => setTimeout(r, 2));
  }
  const doneAll = await inFlightAll;
  eq(doneAll.status, 200, '/fix-all completed');
  assert(seenOpsAll !== null,
    '/fix-all registered itself in the write registry while running — the EXACT behaviour the finding-7 mutation silently removed');
  assert(seenOpsAll && seenOpsAll.includes('health-fix-all'),
    '/fix-all registers under the label "health-fix-all" (got ' + JSON.stringify(seenOpsAll) + ')');
  assert(syncDuringAll && syncDuringAll.status === 409,
    'a concurrent sync push is REFUSED while /fix-all runs (status ' + (syncDuringAll && syncDuringAll.status) + ')');
  assert(deleteDuringAll && deleteDuringAll.status === 409,
    'a concurrent domain delete is REFUSED while /fix-all runs (status ' + (deleteDuringAll && deleteDuringAll.status) + ')');
  assert(existsSync(path.join(TMP_DOMAINS, 'hfaall')),
    'the refused delete did NOT remove the domain mid-fix-all');
  let releasedAll = false;
  for (let i = 0; i < 200; i++) {
    if (registry.listActiveWrites().every(a => a.domain !== 'hfaall')) { releasedAll = true; break; }
    await new Promise(r => setTimeout(r, 5));
  }
  assert(releasedAll, '/fix-all released its registration when it finished');
}

console.log('\n=== 12. Regression: /fix with no `issue` runs the BULK path ===');
{
  // This is why the guard is required, and why the old "sub-second" rationale
  // was wrong. fixIssue() branches on its third argument: falsy => scanWiki()
  // plus a fix for EVERY issue of that type. /fix passes `issue || null`, so
  // omitting `issue` makes this route do exactly what /fix-all does.
  registry.__testing._resetActiveWrites();
  const dom = 'hbulk';
  for (const sub of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw'])
    mkdirSync(path.join(TMP_DOMAINS, dom, sub), { recursive: true });
  writeFileSync(path.join(TMP_DOMAINS, dom, 'CLAUDE.md'), '# Domain: ' + dom + '\n');
  writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/index.md'), '# Wiki Index\n');
  writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/log.md'), '# Ingest Log\n');
  for (const n of ['a', 'b', 'c']) {
    writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/concepts/' + n + '.md'), '# ' + n + '\n');
    writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/entities/src-' + n + '.md'),
      '# src-' + n + '\n\n## Related\n\n- [[concepts/' + n + ']]\n');
  }
  const res = await post('/api/health/' + dom + '/fix', { type: 'folderPrefixLinks' });
  eq(res.status, 200, '/fix with no issue succeeds');
  assert(res.body && res.body.total >= 3,
    '/fix with no `issue` scanned the whole domain and found every issue (total=' +
    (res.body && res.body.total) + ') — this is the BULK path, not a single fix');
  assert(res.body && res.body.fixed >= 3,
    '/fix with no `issue` fixed MULTIPLE files in one call (fixed=' +
    (res.body && res.body.fixed) + ')');
  for (const n of ['a', 'b', 'c'])
    assert(!readFileSync(path.join(TMP_DOMAINS, dom, 'wiki/entities/src-' + n + '.md'), 'utf8')
      .includes('[[concepts/'), 'bulk path rewrote src-' + n + '.md');
}

// The old section 13 ("INVARIANT: every destructive health.js route
// registers") was folded into section 6b above, which now covers all four
// route files with one sound classifier instead of health.js alone with a
// hardcoded destructive-function allow-list. See section 6b's docblock.

// The eight writability-class routes that MUST refuse a read-only mirror.
// Hoisted to MODULE SCOPE (not declared inside section 13's block) so
// section 14's mutation-proof fixtures can replay the exact same
// `WRITABILITY_ROUTES` the real coverage pin below uses, rather than a
// second, potentially-drifted copy. Bodies are the minimum that reaches the
// guard.
const dismissBody = { type: 'orphans', issue: { path: 'entities/e0.md' } };
const WRITABILITY_ROUTES = [
  { method: 'POST', path: '/fix',                        body: { type: 'folderPrefixLinks' },  label: '/fix' },
  { method: 'POST', path: '/fix-all',                    body: { type: 'folderPrefixLinks' },  label: '/fix-all' },
  { method: 'POST', path: '/fix-all-safe',               body: {},                             label: '/fix-all-safe' },
  { method: 'POST', path: '/broken-links/apply',         body: {},                             label: '/broken-links/apply' },
  { method: 'POST', path: '/orphans/apply',              body: {},                             label: '/orphans/apply' },
  { method: 'POST', path: '/semantic-dupes/merge-batch', body: {},                             label: '/semantic-dupes/merge-batch' },
  { method: 'POST', path: '/dismiss',                    body: dismissBody,                    label: '/dismiss' },
  { method: 'POST', path: '/undismiss',                  body: dismissBody,                    label: '/undismiss' },
];

console.log('\n=== 13. BEHAVIOURAL: every writability-class route refuses a read-only mirror ===');
{
  // Section 6b's writability axis is a SOURCE scan: it proves the token
  // `assertWritableDomain(` appears in each handler body. That is necessary
  // but not sufficient — v3.6.1 records a regression test defeated because it
  // matched source text that did not correspond to the behaviour claimed. So
  // every route in that class is ALSO driven for real here, against an actual
  // read-only Shared Brain mirror, and asserted on status + message + the
  // absence of any on-disk side effect.
  //
  // Offline-safe: assertWritableDomain runs BEFORE body validation on the
  // plan/pairs routes, so a mirror request is refused without a plan[], an
  // API key, or an LLM call. That ordering is itself load-bearing and is
  // asserted below via the writable-domain control (same 400, different
  // message — proving the mirror refusal is not just generic body validation).
  registry.__testing._resetActiveWrites();
  registry.__testing._resetUpdate();

  const mkDomain = (name, frontmatter) => {
    for (const sub of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw'])
      mkdirSync(path.join(TMP_DOMAINS, name, sub), { recursive: true });
    writeFileSync(path.join(TMP_DOMAINS, name, 'CLAUDE.md'),
      (frontmatter || '') + '# Domain: ' + name + '\n');
    writeFileSync(path.join(TMP_DOMAINS, name, 'wiki/index.md'), '# Wiki Index\n');
    writeFileSync(path.join(TMP_DOMAINS, name, 'wiki/log.md'), '# Ingest Log\n');
    // One real folder-prefix issue so /fix and /fix-all have work to do on the
    // writable control (otherwise "200" could mean "nothing to fix").
    writeFileSync(path.join(TMP_DOMAINS, name, 'wiki/concepts/c0.md'), '# c0\n');
    writeFileSync(path.join(TMP_DOMAINS, name, 'wiki/entities/e0.md'),
      '# e0\n\n## Related\n\n- [[concepts/c0]]\n');
  };

  // A Shared Brain mirror is a domain whose CLAUDE.md opens with YAML
  // frontmatter carrying `readonly: true` (files.js isDomainReadonly).
  const MIRROR = 'shared-cohort';
  const WRITABLE = 'personal-wr';
  mkDomain(MIRROR, '---\nreadonly: true\nshared_brain: cohort\n---\n');
  mkDomain(WRITABLE, null);

  // Sanity: the fixture really IS classified read-only, and the control is
  // NOT. Without this, every refusal below could be a 404 in disguise.
  const { isDomainReadonly } = await import('../src/brain/files.js');
  assert(await isDomainReadonly(MIRROR) === true,
    `fixture "${MIRROR}" is recognised as a read-only mirror`);
  assert(await isDomainReadonly(WRITABLE) === false,
    `control "${WRITABLE}" is NOT read-only`);

  // WRITABILITY_ROUTES and dismissBody are declared at module scope, above
  // this section — `writableExpect` is what the SAME request does on a
  // writable domain, which is what makes each mirror assertion non-vacuous.

  // Pin the list against HEALTH_GUARD_CLASSES's own writability class, via
  // computeWritabilityCoverage() — the SAME function section 14's
  // mutation-proof fixtures call against mutated copies, so this pin and
  // that proof can never quietly diverge into two different notions of
  // "required". A NEW route that joins the writability class — of ANY
  // mutating method, not just POST (finding 9b) — can never be added to the
  // source invariant (6b) while quietly skipping this behavioural sweep,
  // and can never be exempted from this sweep by any path OTHER than a
  // real, reasoned entry on HEALTH_GUARD_CLASSES itself (finding 9a).
  {
    const info = classifyRouteFile(path.join(REPO_ROOT, 'src/routes/health.js'));
    const { required, undrivable } = computeWritabilityCoverage(info, HEALTH_GUARD_CLASSES);
    // A route whose HTTP method this harness's driver can't issue must FAIL
    // LOUDLY, naming it — never be silently dropped from `required` the way
    // the old `r.method === 'POST'` filter dropped every non-POST route.
    // Unreachable today (DRIVABLE_METHODS covers every verb
    // MUTATING_METHODS recognises) — that emptiness is itself asserted
    // below, and the mutation fixtures in section 14 prove the branch fires
    // when it needs to.
    for (const u of undrivable) {
      assert(false,
        `health.js's writability class contains ${u}, whose HTTP method this harness has no driver for — add one instead of silently excluding it from the behavioural sweep (finding 9b)`);
    }
    eq(undrivable.length, 0, 'no writability-class route today needs a method this harness cannot drive');
    const covered = WRITABILITY_ROUTES.map(r => r.method + ' ' + r.path).sort();
    eq(JSON.stringify(covered), JSON.stringify(required),
      'the behavioural sweep covers EXACTLY the writability class from HEALTH_GUARD_CLASSES — every mutating method, not just POST (no route in the class is left undriven)');
  }

  for (const r of WRITABILITY_ROUTES) {
    const res = await mutatingRequest(r.method, `/api/health/${MIRROR}${r.path}`, r.body);
    const err = (res.body && typeof res.body.error === 'string') ? res.body.error : '';

    eq(res.status, 400, `${r.label} on a mirror: refused with 400`);
    assert(err.includes(MIRROR),
      `${r.label} on a mirror: refusal names the offending domain`);
    assert(/read-only Shared Brain mirror/i.test(err),
      `${r.label} on a mirror: refusal carries the Decision 7 steer text`);
    assert(/push contributions from the Sync tab/i.test(err),
      `${r.label} on a mirror: refusal tells the user what to do instead`);
    assert(!res.body || res.body.ok === undefined,
      `${r.label} on a mirror: refusal does NOT carry ok:true`);
    // The refusal must be JSON, not a half-opened SSE stream — the three
    // apply/merge routes set SSE headers only after the guard passes, and a
    // frontend awaiting res.json() on a text/event-stream body would throw
    // "Unexpected token" instead of showing the steer (the v2.3.3 class).
    assert(res.body !== null, `${r.label} on a mirror: refusal body is JSON, not an SSE stream`);
  }

  // ── The refusal happened BEFORE any side effect on disk ──────────────────
  // v3.0.1-beta.17 records a bug where fix-all acquired the file lock and
  // mkdir'd a ghost directory before validating. Same shape here: the
  // dismissal store's writeRecords() mkdirs wiki/ before writing, so a guard
  // placed after it would leave a file behind on a refused request.
  assert(!existsSync(path.join(TMP_DOMAINS, MIRROR, 'wiki/.health-dismissed.jsonl')),
    'a refused /dismiss on a mirror wrote NO .health-dismissed.jsonl');
  assert(!existsSync(path.join(TMP_DOMAINS, MIRROR, '.write-lock')),
    'no refused mirror request left a .write-lock behind (guard precedes acquireFileLock)');
  eq(readFileSync(path.join(TMP_DOMAINS, MIRROR, 'wiki/entities/e0.md'), 'utf8'),
    '# e0\n\n## Related\n\n- [[concepts/c0]]\n',
    'the mirror\'s wiki page is byte-identical — no refused route did partial work');
  assert(registry.hasActiveWrites() === false,
    'no refused mirror request leaked a write registration');

  // ── The negative half: the guard does NOT fire on a writable domain ──────
  // Without this, every assertion above would still pass against a handler
  // that refused unconditionally.
  for (const r of WRITABILITY_ROUTES) {
    const res = await mutatingRequest(r.method, `/api/health/${WRITABLE}${r.path}`, r.body);
    const err = (res.body && typeof res.body.error === 'string') ? res.body.error : '';
    assert(!/read-only Shared Brain mirror/i.test(err),
      `${r.label} on a writable domain: NOT refused as a mirror (status ${res.status})`);
  }
  // And concretely: the two dismiss routes really do their work there.
  const dOk = await post(`/api/health/${WRITABLE}/dismiss`, dismissBody);
  eq(dOk.status, 200, '/dismiss succeeds on a writable domain');
  assert(dOk.body && dOk.body.ok === true, '/dismiss returns ok:true on a writable domain');
  assert(existsSync(path.join(TMP_DOMAINS, WRITABLE, 'wiki/.health-dismissed.jsonl')),
    '/dismiss genuinely wrote the dismissal store (not merely "not refused")');
  const uOk = await post(`/api/health/${WRITABLE}/undismiss`, dismissBody);
  eq(uOk.status, 200, '/undismiss succeeds on a writable domain');
  assert(uOk.body && uOk.body.removed === 1,
    '/undismiss genuinely removed the record (removed=1)');

  // ── Reading a mirror stays ALLOWED — the guard must not over-reach ───────
  // scanWiki on a mirror is explicitly permitted (route docblock: "Scanning
  // mirrors stays allowed ... useful to spot conflict markers"). A blanket
  // application of assertWritableDomain would silently break that.
  const scan = await fetch(BASE + `/api/health/${MIRROR}`);
  eq(scan.status, 200, 'GET /:domain still SCANS a read-only mirror (read is allowed)');
  const listed = await fetch(BASE + `/api/health/${MIRROR}/dismissed`);
  eq(listed.status, 200, 'GET /:domain/dismissed still READS on a mirror');

  // ── Parity with the MCP twins, which had this guard all along ────────────
  // The recorded defect was precisely that the app routes lagged their MCP
  // counterparts. Pin both halves of the distinction the two surfaces make:
  // dismiss/undismiss take the readonly guard and NO file lock, while
  // fix_wiki_issue takes both.
  const mcpDismissSrc = readFileSync(path.join(REPO_ROOT, 'mcp/tools/dismissed.js'), 'utf8');
  const mcpHealthSrc = readFileSync(path.join(REPO_ROOT, 'mcp/tools/health.js'), 'utf8');
  eq((mcpDismissSrc.match(/refuseIfReadonly\(/g) || []).length, 2,
    'both MCP dismissal write tools still call refuseIfReadonly (the parity this fix restores)');
  assert(!/acquireFileLock\(/.test(mcpDismissSrc),
    'MCP dismissal tools take NO file lock — the concurrency exemption in 6b mirrors a real, existing decision');
  assert(/acquireFileLock\(/.test(mcpHealthSrc),
    '  (control) MCP fix_wiki_issue DOES take the file lock — the two surfaces genuinely distinguish the axes');
}

console.log('\n=== 14. MUTATION-PROOF: findings 9a (single exemption list) & 9b (non-POST coverage) ===');
{
  // Every fixture here mutates an IN-MEMORY STRING copy of health.js's real
  // source and writes it to a THROWAWAY temp file inside TMP. health.js
  // itself is only ever read()— never written — matching this task's
  // read-only constraint on that file. Each mutated file is confirmed to
  // actually PARSE (`node --check`, the real Node binary, not a guess) before
  // any assertion below trusts a result derived from it: a red caused by a
  // syntax error or a TDZ would be a red for the wrong reason and would prove
  // nothing about the fix (the trap this repo's CLAUDE.md records this exact
  // suite being caught by twice).
  const realHealthSrc = readFileSync(path.join(REPO_ROOT, 'src/routes/health.js'), 'utf8');
  const exportIdx = realHealthSrc.lastIndexOf('export default router');
  assert(exportIdx !== -1,
    'located health.js\'s `export default router` line to inject mutation-proof fixtures before');

  function buildMutatedHealthFile(fixtureName, injectedRouteSrc) {
    const mutatedSrc = realHealthSrc.slice(0, exportIdx) + injectedRouteSrc + '\n' + realHealthSrc.slice(exportIdx);
    const mutFile = path.join(TMP, `health-mutation-${fixtureName}.js`);
    writeFileSync(mutFile, mutatedSrc, 'utf8');
    try {
      execFileSync(process.execPath, ['--check', mutFile], { stdio: 'pipe' });
      assert(true, `${fixtureName} fixture: mutated file parses cleanly under \`node --check\` (so a RED derived from it below is behavioural, not a syntax error)`);
    } catch (err) {
      const detail = err.stderr ? err.stderr.toString().split('\n')[0] : err.message;
      assert(false, `${fixtureName} fixture: mutated file FAILED \`node --check\` (${detail}) — nothing below can trust this file`);
    }
    return mutFile;
  }

  // ── 9a: the bypass is closed ─────────────────────────────────────────────
  // Before this fix, section 13 kept its OWN exemptPaths Set. A route added
  // to health.js, marked "guarded" by 6b's source scan, and exempted ONLY in
  // that second, section-13-only list — without ever being added to
  // HEALTH_GUARD_CLASSES's real exemptions or to WRITABILITY_ROUTES — would
  // pass every check while never being behaviourally driven. That is exactly
  // the shape that would hide a PRESENT-BUT-INERT guard: a route whose body
  // calls assertWritableDomain(...) on the wrong value (or from dead code)
  // still matches 6b's `\bassertWritableDomain\s*\(` regex, so only the
  // behavioural sweep in section 13 could ever have caught it — and the old,
  // second exemption list let a route dodge that sweep entirely.
  const injectedA =
    "router.post('/:domain/mutation-test-9a', async (req, res) => {\n" +
    "  const domain = req.params.domain;\n" +
    "  assertWritableDomain(domain);\n" +
    "  registerWrite(domain, 'mutation-test');\n" +
    "  acquireFileLock(domain);\n" +
    "  isUpdateInProgress();\n" +
    "  res.json({ ok: true });\n" +
    "});\n";
  const mutFileA = buildMutatedHealthFile('9a', injectedA);

  const mutInfoA = classifyRouteFile(mutFileA);
  eq(mutInfoA.parseFails, 0, '9a fixture: mutated copy brace-matches cleanly (classifyRouteFile agrees with node --check)');
  eq(mutInfoA.routerDeclCount, 1, '9a fixture: mutated copy still has exactly one router declaration');
  const injectedRouteA = mutInfoA.routes.find(r => r.method === 'POST' && r.path === '/:domain/mutation-test-9a');
  assert(!!injectedRouteA, '9a fixture: the injected route is discovered by the classifier');
  assert(injectedRouteA && bodyIsGuarded(injectedRouteA.body, ['assertWritableDomain'], 'all'),
    '9a fixture: the injected route DOES carry assertWritableDomain — 6b\'s source scan alone would call it guarded');

  // If this route were merely added to a SECOND, section-13-only exemption
  // list (the pre-fix bug), the coverage pin below would never demand it be
  // driven. With single-sourcing there is no such second list to add it to —
  // the ONLY way to silence the requirement is a real entry on
  // HEALTH_GUARD_CLASSES. None exists for this injected route, so it MUST
  // appear in `required`.
  const { required: requiredA } = computeWritabilityCoverage(mutInfoA, HEALTH_GUARD_CLASSES);
  assert(requiredA.includes('POST /mutation-test-9a'),
    '9a: the guarded-but-unexempted injected route IS demanded by the single-sourced coverage derivation (no silent pass)');

  // Replaying the REAL coverage-pin comparison — the SAME computeWritability
  // Coverage() function and the SAME WRITABILITY_ROUTES the real section 13
  // uses, not a re-implementation — against the mutated file must go RED:
  // proof that if this route existed for real on the shipping health.js, the
  // suite would fail rather than stay quietly green.
  const coveredReal = WRITABILITY_ROUTES.map(r => r.method + ' ' + r.path).sort();
  assert(JSON.stringify(coveredReal) !== JSON.stringify(requiredA),
    '9a: replaying the real coverage-pin comparison against the mutated file goes RED — the bypass this finding closes stays closed');

  // And the legitimate path still works: a REAL, reasoned exemption added to
  // the ONE shared writability list (not a fork — the exemptions array is
  // spread into a brand-new array, never mutated in place) correctly removes
  // the route from `required`. This proves the derivation is CORRECT, not
  // merely strict.
  const writabilityClass = HEALTH_GUARD_CLASSES.find(c => c.name === 'writability');
  // Snapshot BEFORE building the augmented copy, not a hardcoded literal
  // (finding 9, compounding issue): a hardcoded `=== 6` would go RED the
  // moment a legitimate 7th writability exemption is ever added for real,
  // with a failure message claiming mutation when only the count moved for a
  // good reason. Comparing against a snapshot taken in THIS run instead
  // means the assertion tracks "did building the copy mutate the shared
  // object", which is the only thing it is actually supposed to prove.
  const writabilityExemptionsCountBeforeA = writabilityClass.exemptions.length;
  const augmentedGuardClasses = HEALTH_GUARD_CLASSES.map(c => c.name !== 'writability' ? c : {
    ...c,
    exemptions: [...c.exemptions, {
      method: 'POST', path: '/:domain/mutation-test-9a',
      reason: 'test-only: mutation-proof fixture for finding 9a — never a real exemption',
    }],
  });
  const { required: requiredIfExempted } = computeWritabilityCoverage(mutInfoA, augmentedGuardClasses);
  assert(!requiredIfExempted.includes('POST /mutation-test-9a'),
    '9a: a REAL, reasoned exemption added to the one shared list correctly removes the route from required — the mechanism works when used honestly, not merely "always fails"');
  eq(writabilityClass.exemptions.length, writabilityExemptionsCountBeforeA,
    `9a: building the augmented copy above did NOT mutate the real, shared HEALTH_GUARD_CLASSES (still ${writabilityExemptionsCountBeforeA} writability exemptions, derived from a before-snapshot rather than a hardcoded number)`);

  // ── Regression guard: no HAND-DUPLICATED second copy of these paths ─────
  // (finding 9a's literal fix, read back from THIS file's own source).
  //
  // Finding 9 (re-audit): the ORIGINAL version of this guard asserted
  // `count === 2` for every writability-exempt path — but the invariant it
  // is FOR is "no re-introduced, hand-typed second exemptPaths list", not
  // "every writability exemption is also a concurrency exemption". Those
  // happen to coincide for all six paths TODAY (each is exempt on both
  // axes), but the whole point of splitting the classes (see the "why this
  // is a LIST of guard classes" docblock above) is to let a FUTURE route be
  // exempted on exactly ONE axis. A `=== 2` check would then fail on a
  // perfectly legitimate single-axis exemption — appearing once, as it
  // should — with a message ("hand-duplicated") that misdiagnoses a healthy
  // addition as the bug this guard exists to catch.
  //
  // Fixed by deriving, per path, how many axes it is ACTUALLY exempt on from
  // HEALTH_GUARD_CLASSES itself (never a hardcoded 2), and asserting the
  // literal-occurrence count matches exactly that — so a legitimate
  // single-axis exemption (expected 1) passes, while any occurrence BEYOND
  // what the real exemption lists justify (a rogue extra list, anywhere in
  // the file) still fails. Quote-style-agnostic via countQuotedLiteral()
  // (defined above, alongside bodyIsGuarded) — the original used a
  // single-quote-only needle, so a double-quoted or backtick-quoted
  // duplicate list would have gone completely uncounted.
  //
  // Scope stays the same as the original guard — every path that is
  // WRITABILITY-exempt (the six today) — deliberately NOT widened to also
  // cover concurrency-only exemptions like /:domain/dismiss: that path's
  // literal already appears a second, entirely legitimate time in this file
  // (the re-confirm (iii) control assertion a few dozen lines below asserts
  // it is NOT writability-exempt), which is a real, intentional cross-check
  // rather than a hand-duplicated exemption list. A path-count invariant
  // cannot tell those two kinds of "second occurrence" apart by text alone,
  // so it is scoped to paths where today's file has no such legitimate
  // second reference — matching finding 9's own description ("every
  // writability-exempt path").
  const selfSrc = readFileSync(path.join(REPO_ROOT, 'scripts/test-route-write-guards.js'), 'utf8');
  const concurrencyClass = HEALTH_GUARD_CLASSES.find(c => c.name === 'concurrency');
  const WRITABILITY_EXEMPT_PATHS_FOR_GUARD = writabilityClass.exemptions.map(e => e.path);
  for (const p of WRITABILITY_EXEMPT_PATHS_FOR_GUARD) {
    const inConcurrency = concurrencyClass.exemptions.some(e => e.path === p);
    // Every path in this loop is writability-exempt by construction (that is
    // where WRITABILITY_EXEMPT_PATHS_FOR_GUARD comes from) -- the ONLY thing
    // that varies, and the only thing this derives rather than hardcodes, is
    // whether it is ALSO concurrency-exempt.
    const expectedCount = 1 + (inConcurrency ? 1 : 0);
    const count = countQuotedLiteral(selfSrc, p);
    eq(count, expectedCount,
      `finding 9: '${p}' appears in this file's own source exactly ${expectedCount} time(s), matching its real axis membership (writability-exempt: true, concurrency-exempt: ${inConcurrency}) — any occurrence BEYOND that would be a re-introduced, hand-duplicated exemptPaths list, and a legitimate writability-only exemption (expected count 1) is correctly NOT required to appear twice`);
  }

  // ── Finding 9: prove the fix works in BOTH directions, on synthetic text
  //        (never the real file) so this proof cannot depend on today's
  //        exemption list staying exactly as it is.
  {
    // Direction 1: a legitimate, single-occurrence, writability-ONLY
    // exemption must NOT be flagged — exactly the case the old `=== 2` check
    // would have wrongly failed, and exactly the case the two-axis split was
    // built to allow.
    const syntheticSingleAxis =
      "const X = [{ name: 'writability', exemptions: [\n" +
      "  { method: 'POST', path: '/:domain/future-writability-only-route', reason: 'r' },\n" +
      "] }];\n";
    const soloCount = countQuotedLiteral(syntheticSingleAxis, '/:domain/future-writability-only-route');
    const soloExpected = 1; // writability-exempt only, not concurrency-exempt
    eq(soloCount, soloExpected,
      'finding 9 (direction 1): a legitimate single-occurrence, writability-only exemption is counted correctly and would NOT fail this guard');

    // Direction 2: a genuinely hand-duplicated SECOND exemption list — the
    // real historical bug this guard exists to catch (section 13 used to
    // keep its own second copy of the six writability-exempt paths) — must
    // still be caught. Three occurrences (concurrency + writability + a
    // rogue standalone list) against an expectedCount derived from only the
    // first two must NOT match.
    const syntheticDuplicated =
      "const HEALTH_GUARD_CLASSES = [\n" +
      "  { name: 'concurrency', exemptions: [{ method: 'POST', path: '/:domain/dupe-test', reason: 'r' }] },\n" +
      "  { name: 'writability',  exemptions: [{ method: 'POST', path: '/:domain/dupe-test', reason: 'r' }] },\n" +
      "];\n" +
      "// A re-introduced, hand-typed section-13-only copy -- the exact bug:\n" +
      "const exemptPaths = new Set(['/:domain/dupe-test']);\n";
    const dupeCount = countQuotedLiteral(syntheticDuplicated, '/:domain/dupe-test');
    const dupeExpected = 2; // what the two real, reasoned exemption lists alone justify
    assert(dupeCount !== dupeExpected,
      `finding 9 (direction 2): a genuinely hand-duplicated third occurrence (found ${dupeCount}, expected ${dupeExpected} from the two real exemption lists alone) is NOT silently accepted -- the class of bug this guard exists to catch is still caught`);
  }

  // ── 9b: non-POST mutating methods are no longer silently excluded ───────
  const injectedB =
    "router.put('/:domain/mutation-test-9b', async (req, res) => {\n" +
    "  res.json({ ok: true });\n" +
    "});\n";
  const mutFileB = buildMutatedHealthFile('9b', injectedB);

  const mutInfoB = classifyRouteFile(mutFileB);
  eq(mutInfoB.parseFails, 0, '9b fixture: mutated copy brace-matches cleanly (classifyRouteFile agrees with node --check)');
  const injectedRouteB = mutInfoB.routes.find(r => r.method === 'PUT' && r.path === '/:domain/mutation-test-9b');
  assert(!!injectedRouteB, '9b fixture: the injected PUT route is discovered by the classifier');
  assert(injectedRouteB && !bodyIsGuarded(injectedRouteB.body, ['assertWritableDomain'], 'all'),
    '9b fixture: the injected PUT route carries NO writability guard at all — the case that must not slip through');

  const { required: requiredB } = computeWritabilityCoverage(mutInfoB, HEALTH_GUARD_CLASSES);
  assert(requiredB.includes('PUT /mutation-test-9b'),
    '9b: an unguarded, non-POST mutating route is included in `required` — the method filter no longer silently drops it');

  // The OLD, pre-fix filter is reproduced HERE ONLY, deliberately, to prove
  // it really would have missed this — it is NOT the code that ships (the
  // real derivation is computeWritabilityCoverage, used above and by the
  // real section 13).
  const oldExemptKeys = new Set(HEALTH_GUARD_CLASSES.find(c => c.name === 'writability')
    .exemptions.map(e => e.method + ' ' + e.path));
  const oldRequiredB = mutInfoB.routes
    .filter(r => r.method === 'POST' && r.path && !oldExemptKeys.has(r.method + ' ' + r.path))
    .map(r => r.path.replace('/:domain', ''));
  assert(!oldRequiredB.includes('mutation-test-9b'),
    '9b (control): the OLD `r.method === \'POST\'` filter would have missed the injected PUT route entirely — the regression this fix closes was real');

  const coveredRealB = WRITABILITY_ROUTES.map(r => r.method + ' ' + r.path).sort();
  assert(JSON.stringify(coveredRealB) !== JSON.stringify(requiredB),
    '9b: replaying the real coverage-pin comparison against the mutated file goes RED — an unguarded PUT route is caught, not silently dropped');

  // ── Finding 12: bracket-notation dispatch — exploitable, then caught ────
  // Same in-memory/temp-copy pattern as 9a/9b above: a mutated copy of the
  // real health.js source, written only to TMP, `node --check`ed before
  // anything trusts it. Reproduces exactly what an independent re-audit
  // found: `router['post']('/:domain/sneaky-wipe', ...)` calling `fixIssue`
  // with NO guard at all, dispatched via bracket notation instead of
  // `router.post(...)`.
  const injectedC =
    "router['post']('/:domain/sneaky-wipe', async (req, res) => {\n" +
    "  const domain = req.params.domain;\n" +
    "  const result = await fixIssue(domain, req.body.type, null);\n" +
    "  res.json({ ok: true, ...result });\n" +
    "});\n";
  const mutFileC = buildMutatedHealthFile('finding12', injectedC);
  const mutInfoC = classifyRouteFile(mutFileC);
  eq(mutInfoC.parseFails, 0, 'finding-12 fixture: mutated copy brace-matches cleanly (classifyRouteFile agrees with node --check)');
  eq(mutInfoC.routerDeclCount, 1, 'finding-12 fixture: mutated copy still has exactly one router declaration');

  // ── (i) THE VULNERABILITY, reproduced: the normal discovery passes see
  //        NOTHING — an unguarded, destructive, bracket-dispatched route is
  //        completely invisible to `.routes`, so no per-route assertion
  //        anywhere in this file would ever be generated for it.
  const foundViaNormalDiscovery = mutInfoC.routes.find(
    r => r.method === 'POST' && r.path === '/:domain/sneaky-wipe');
  assert(!foundViaNormalDiscovery,
    'finding 12 (vulnerability, reproduced): the injected bracket-notation route calling fixIssue() unguarded is INVISIBLE to normal route discovery (.routes has no entry for it) — confirms it is exploitable, exactly as the re-audit found');
  const dumbCountC = dumbCountDirectCalls(mutInfoC.stripped, mutInfoC.routerVar);
  const directRoutesC = mutInfoC.routes.filter(r => r.kind === 'direct');
  eq(dumbCountC, directRoutesC.length,
    'finding 12 (vulnerability, reproduced): even the INDEPENDENT indexOf cross-check agrees with the blind classifier — both miss the bracket-notation route identically (it never manufactures a false discrepancy either)');

  // ── (ii) THE FIX: findBracketNotationRoutes() catches exactly this shape.
  const bracketHitsC = findBracketNotationRoutes(mutInfoC.commentsStripped, mutInfoC.routerVar);
  assert(bracketHitsC.includes('POST'),
    `finding 12 (fix): findBracketNotationRoutes() DOES catch the injected router['post'](...) route (found: ${JSON.stringify(bracketHitsC)}) — the class this finding closes stays closed`);

  // ── (iii) Negative control: the SAME scanner reports clean on the REAL,
  //          unmutated health.js — proving (ii) is not a scanner that just
  //          always fires (which would be as useless as always passing).
  const realInfoForBracket = classifyRouteFile(path.join(REPO_ROOT, 'src/routes/health.js'));
  const bracketHitsReal = findBracketNotationRoutes(realInfoForBracket.commentsStripped, realInfoForBracket.routerVar);
  eq(bracketHitsReal.length, 0,
    'finding 12 (negative control): the same scanner reports ZERO bracket-notation routes on the real, unmutated health.js — the detector distinguishes clean from injected rather than always firing');

  // ── Re-confirmation: the three properties an earlier audit round found ───
  // this rework already caught, replayed against the code as it stands after
  // this change. health.js itself is only read here, never mutated — per
  // this task's read-only constraint, none of these three reproduce the
  // auditor's original method of editing the real file and re-running
  // `npm test`; each is rebuilt using the same primitives (bodyIsGuarded,
  // classifyRouteFile, computeWritabilityCoverage) the real sections 6b/13
  // call, against real bodies or safe in-memory string copies.
  console.log('  -- re-confirming: unguarded-route / guard-downgrade / bogus-exemption detection --');

  // (i) UNGUARDED-ROUTE DETECTION on the WRITABILITY axis specifically (the
  // axis findings 9a/9b touch). Section 6b's own existing control (above)
  // already covers the concurrency axis with the same shape; this is its
  // sibling for writability, so both axes are freshly proven here rather
  // than just one.
  const fakeWritable = "router.post('/x', async (req,res) => { assertWritableDomain(req.params.domain); await fixIssue(d,t,i); });";
  const fakeUnguardedShared = "router.post('/x', async (req,res) => { await fixIssue(d,t,i); });";
  assert(bodyIsGuarded(fakeWritable, ['assertWritableDomain'], 'all'),
    '  (re-confirm i) a handler carrying assertWritableDomain is classified as writability-guarded');
  assert(!bodyIsGuarded(fakeUnguardedShared, ['assertWritableDomain'], 'all'),
    '  (re-confirm i) the same fully-unguarded handler is classified as NOT writability-guarded');

  // (ii) GUARD-DOWNGRADE DETECTION — take the REAL, live body of an actual
  // destructive route (/:domain/fix-all) from the REAL health.js (read-only;
  // never written), and confirm that removing its assertWritableDomain(...)
  // call in a STRING COPY flips detection to NOT guarded, while its
  // concurrency guard (untouched by the edit) still reads as guarded — a
  // downgrade on one axis must not blind the other.
  const realInfo = classifyRouteFile(path.join(REPO_ROOT, 'src/routes/health.js'));
  const fixAllRoute = realInfo.routes.find(r => r.method === 'POST' && r.path === '/:domain/fix-all');
  assert(!!fixAllRoute, 'located the real /:domain/fix-all route for the guard-downgrade re-confirmation');
  if (fixAllRoute) {
    assert(bodyIsGuarded(fixAllRoute.body, ['assertWritableDomain'], 'all'),
      '  (re-confirm ii) /fix-all currently carries assertWritableDomain for real');
    const downgradedBody = fixAllRoute.body.replace(/assertWritableDomain\s*\([^)]*\)\s*;?/, '/* removed */');
    assert(downgradedBody !== fixAllRoute.body,
      '  (re-confirm ii) the downgrade actually changed the string (the replace found something real to remove — not a vacuous no-op)');
    assert(!bodyIsGuarded(downgradedBody, ['assertWritableDomain'], 'all'),
      '  (re-confirm ii) stripping assertWritableDomain(...) from the SAME real body flips detection to NOT writability-guarded');
    assert(bodyIsGuarded(downgradedBody, ['registerWrite', 'acquireFileLock', 'isUpdateInProgress'], 'all'),
      '  (re-confirm ii) the SAME downgraded body is STILL correctly detected as concurrency-guarded — a downgrade on one axis does not blind the other');
  }

  // (iii) BOGUS DOUBLE-AXIS EXEMPTION DETECTION — the v3.6.1 defect shape:
  // exempting a route from one axis and (incorrectly) ALSO exempting it from
  // the other. /dismiss and /undismiss are the real, live example of the
  // CORRECT split (concurrency-exempt, writability NOT exempt); confirm that
  // split still holds for real, then confirm the mechanism would visibly
  // remove a route from `required` if a bogus double-axis entry ever existed
  // — demonstrated on a throwaway copy of the guard-class config, never the
  // real, shared HEALTH_GUARD_CLASSES.
  const realWritabilityExempt = new Set(
    HEALTH_GUARD_CLASSES.find(c => c.name === 'writability').exemptions.map(e => e.path));
  assert(!realWritabilityExempt.has('/:domain/dismiss') && !realWritabilityExempt.has('/:domain/undismiss'),
    '  (re-confirm iii) /dismiss and /undismiss remain exempt from concurrency ONLY — neither is bogusly exempt from writability too (the exact v3.6.1 defect shape)');
  // Snapshot BEFORE building the bogus copy, not a hardcoded literal (finding
  // 9, same fix as the 9a snapshot above): a hardcoded `=== 6` would go RED
  // the moment a legitimate 7th writability exemption is added for real, and
  // its message would claim mutation when only the count moved for a good
  // reason.
  const realWritabilityCountBefore = HEALTH_GUARD_CLASSES.find(c => c.name === 'writability').exemptions.length;
  const bogusGuardClasses = HEALTH_GUARD_CLASSES.map(c => c.name !== 'writability' ? c : {
    ...c,
    exemptions: [...c.exemptions, {
      method: 'POST', path: '/:domain/fix-all',
      reason: 'test-only: simulated BOGUS double-axis exemption — never a real entry',
    }],
  });
  const { required: requiredWithBogus } = computeWritabilityCoverage(realInfo, bogusGuardClasses);
  assert(!requiredWithBogus.includes('POST /fix-all'),
    '  (re-confirm iii) IF such a bogus exemption existed it would silently drop the real, destructive /fix-all from required — which is exactly why the check above matters, and exactly why no such entry exists for real');
  const realWritabilityCountAfter = HEALTH_GUARD_CLASSES.find(c => c.name === 'writability').exemptions.length;
  eq(realWritabilityCountAfter, realWritabilityCountBefore,
    `  (re-confirm iii) building the bogus copy above did not mutate the real, shared HEALTH_GUARD_CLASSES (still ${realWritabilityCountBefore} writability exemptions, derived from a before-snapshot rather than a hardcoded number)`);
}

console.log('\n=== 15. MUTATION-PROOF (finding 7): source-scan cannot tell a live concurrency guard from a dead-code-shaped one, a live registry poll can ===');
{
  // health.js itself is only ever READ in this file (task constraint), so the
  // exact reported mutation cannot be reproduced by editing the real
  // POST /:domain/fix-all handler. Instead this reproduces the SAME shape —
  // `const releaseRegistry = (false ? registerWrite(domain, 'op') : (() => {}));`
  // — in a tiny, throwaway Express router defined entirely in THIS file,
  // never written to disk, never touching src/routes/ at all. It sits
  // alongside a second handler carrying the real, live call. Both are driven
  // over real HTTP against the real, shared write-registry module (imported
  // once at the top of this file) so the comparison uses the exact same
  // registry the real health.js routes use — not a mock.
  //
  // What this proves:
  //   (i)  bodyIsGuarded (the mechanism 6b's source-scan runs on every route
  //        in the concurrency class) misclassifies the dead-code-wrapped call
  //        as guarded — reproducing, verbatim, the re-audit's finding.
  //   (ii) a LIVE poll of registry.listActiveWrites() while the request is in
  //        flight tells the two apart: the real call is observed, the
  //        dead-code one never is. This is the exact mechanism section
  //        11(b)/(e) above already run against the REAL /fix and /fix-all —
  //        this section is what proves that mechanism actually WORKS, rather
  //        than merely existing.
  const fakeInertHandlerBody =
    "const releaseRegistry = (false ? registerWrite(domain, 'health-fix-all') : (() => {}));";
  const fakeLiveHandlerBody =
    "const releaseRegistry = registerWrite(domain, 'health-fix-all');";

  assert(bodyIsGuarded(fakeInertHandlerBody, ['registerWrite'], 'any'),
    'finding 7 (i, reproduced): source-scan alone classifies the dead-code-wrapped registerWrite(...) as GUARDED — the exact false-green an independent re-audit reported against the real /:domain/fix-all handler');
  assert(bodyIsGuarded(fakeLiveHandlerBody, ['registerWrite'], 'any'),
    '  (control) the same scan correctly classifies the real, live call as guarded too — so (i) above is not "the scanner rejects everything", it specifically cannot tell live from dead');

  const mutApp15 = express();
  mutApp15.post('/live-guarded/:domain', async (req, res) => {
    const { domain } = req.params;
    const releaseRegistry = registry.registerWrite(domain, 'health-fix-all'); // the REAL shape
    await new Promise(r => setTimeout(r, 80));
    releaseRegistry();
    res.json({ ok: true });
  });
  mutApp15.post('/live-inert/:domain', async (req, res) => {
    const { domain } = req.params;
    // The exact reported mutation, reproduced verbatim in a throwaway
    // handler rather than in health.js itself.
    const releaseRegistry = (false ? registry.registerWrite(domain, 'health-fix-all') : (() => {}));
    await new Promise(r => setTimeout(r, 80));
    releaseRegistry();
    res.json({ ok: true });
  });
  const mutServer15 = createServer(mutApp15);
  await new Promise(r => mutServer15.listen(0, '127.0.0.1', r));
  const mutBase15 = `http://127.0.0.1:${mutServer15.address().port}`;

  async function pollForRegistration15(domain, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (registry.listActiveWrites().some(a => a.domain === domain)) return true;
      await new Promise(r => setTimeout(r, 3));
    }
    return false;
  }

  registry.__testing._resetActiveWrites();
  const guardedReq15 = fetch(mutBase15 + '/live-guarded/mutproof15-guarded', { method: 'POST' });
  const sawGuarded15 = await pollForRegistration15('mutproof15-guarded', 500);
  await guardedReq15;
  assert(sawGuarded15 === true,
    'finding 7 (ii): the REAL registerWrite(...) call IS observed live in the registry while its request is in flight');
  assert(registry.listActiveWrites().every(a => a.domain !== 'mutproof15-guarded'),
    'finding 7 (ii): ...and is released again once the request completes (no leak)');

  registry.__testing._resetActiveWrites();
  const inertReq15 = fetch(mutBase15 + '/live-inert/mutproof15-inert', { method: 'POST' });
  const sawInert15 = await pollForRegistration15('mutproof15-inert', 500);
  await inertReq15;
  assert(sawInert15 === false,
    'finding 7 (ii, the fix): the dead-code-wrapped call is NEVER observed live — a behavioural poll catches exactly what bodyIsGuarded (i, above) missed. This is the mechanism that makes section 11(e)\'s real /fix-all coverage meaningful, not merely present.');

  await new Promise(r => mutServer15.close(r));
  registry.__testing._resetActiveWrites();
}

console.log('\n=== 16. RE-CONFIRM: a present-but-inert WRITABILITY guard IS caught (the contrast Finding 7 draws) ===');
{
  // The mirror image of section 15, on the OTHER axis: the ENFORCED /
  // NOT ENFORCED docblock above HEALTH_GUARD_CLASSES claims the writability
  // axis catches a present-but-inert guard live, for real, on all 8 routes —
  // because section 13 drives every one of them over real HTTP against a
  // real mirror domain. This reproduces the SAME "dead-code-wrapped call"
  // shape Finding 7 used for concurrency, but for assertWritableDomain, using
  // the REAL production `isDomainReadonly` (imported from src/brain/files.js
  // — not a mock) against the REAL "shared-cohort" mirror fixture section 13
  // built on disk. health.js's own (unexported) assertWritableDomain is not
  // imported here — reconstructing its refusal shape from the same
  // production primitive it is built on is enough to prove the AXIS
  // mechanism (live HTTP driving) tells live from inert, which is the actual
  // claim being re-confirmed.
  const { isDomainReadonly: isDomainReadonlyFor16 } = await import('../src/brain/files.js');
  async function assertWritableDomainReal16(domain) {
    if (await isDomainReadonlyFor16(domain)) {
      const err = new Error(
        `Domain "${domain}" is a read-only Shared Brain mirror — fixes here would be overwritten on the next Pull.`);
      err.status = 400;
      throw err;
    }
  }

  const mutApp16 = express();
  mutApp16.post('/writ-guarded/:domain', async (req, res) => {
    try { await assertWritableDomainReal16(req.params.domain); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
    res.json({ ok: true });
  });
  mutApp16.post('/writ-inert/:domain', async (req, res) => {
    try {
      // The exact present-but-inert shape from Finding 7, applied here to
      // the writability axis instead of the concurrency one.
      await (false ? assertWritableDomainReal16(req.params.domain) : Promise.resolve());
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
    res.json({ ok: true });
  });
  const mutServer16 = createServer(mutApp16);
  await new Promise(r => mutServer16.listen(0, '127.0.0.1', r));
  const mutBase16 = `http://127.0.0.1:${mutServer16.address().port}`;

  // "shared-cohort" is the real, on-disk mirror fixture built in section 13
  // and never deleted since — reused here rather than rebuilt, so this is
  // the same domain section 13's own live assertions were proven against.
  const guardedRes16 = await fetch(mutBase16 + '/writ-guarded/shared-cohort', { method: 'POST' });
  const guardedBody16 = await guardedRes16.json();
  eq(guardedRes16.status, 400,
    're-confirm: a LIVE assertWritableDomain-shaped call correctly refuses the real mirror over HTTP (the same real isDomainReadonly section 13 depends on)');
  assert(guardedBody16 && /read-only Shared Brain mirror/i.test(guardedBody16.error || ''),
    're-confirm: ...carrying the expected steer message');

  const inertRes16 = await fetch(mutBase16 + '/writ-inert/shared-cohort', { method: 'POST' });
  const inertBody16 = await inertRes16.json();
  const inertRefusedAsMirror16 = inertRes16.status === 400 &&
    /read-only Shared Brain mirror/i.test((inertBody16 && inertBody16.error) || '');
  assert(!inertRefusedAsMirror16,
    'finding-7 contrast, re-confirmed: the dead-code-wrapped assertWritableDomain call wrongly ALLOWS the mirror through (status ' + inertRes16.status +
    ') — proving the writability axis is only trustworthy BECAUSE it is driven live end-to-end (section 13) against every one of its 8 routes, not because bodyIsGuarded\'s source scan is reliable on its own (it is not — see section 15). If section 13 were ever weakened to a source-scan-only check, this exact shape would go undetected on the writability axis too.');

  await new Promise(r => mutServer16.close(r));
}

// ── Teardown ─────────────────────────────────────────────────────────────
await new Promise(r => server.close(r));
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${'='.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailing assertions:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
