#!/usr/bin/env node
/**
 * Offline battle test for the self-diagnostics module (v3.0.1-beta.23),
 * extended to cover the "OpenRouter-only install told it had no key" fix.
 *
 * ── The bug this suite exists to catch ───────────────────────────────────────
 * checkProvider() wraps getProviderInfo() in a try/catch. getProviderInfo()
 * throws for TWO structurally different reasons: (a) no key configured
 * anywhere, or (b) a key IS configured but the resolved provider has no
 * resolvable model (e.g. an install whose only saved key is a provider with
 * no default model — see DEFAULTS.<provider> in llm.js). Collapsing both into
 * "No API key configured" is false in case (b) and unhelpful in both — the
 * one panel whose entire job is answering "is the app working?" told a user
 * with a valid key that they had none.
 *
 * The fix distinguishes them via hasAnyKeyConfigured(), which derives the
 * provider list from getApiKeys()'s OWN field names (`<id>ApiKey` -> `<id>`)
 * rather than a hardcoded ['gemini','anthropic'] list, so a new provider
 * needs no edit in diagnostics.js itself.
 *
 * ── Why this suite extracts real function source instead of importing it ────
 * src/brain/llm.js is being actively edited elsewhere in this release
 * (populating a model catalogue: OFFERABLE_MODELS.openrouter, DEFAULTS.openrouter,
 * FREE_MODELS). Whether an OpenRouter-only config currently throws "no model
 * configured" from the REAL getProviderInfo() is therefore a moving target —
 * it may be true today and false tomorrow. A suite that depends on that would
 * be exactly the kind of guard this repo's history warns about: green for a
 * reason that quietly stops being true.
 *
 * So the "key exists but no model resolves" mechanism is tested by extracting
 * checkProvider() / hasAnyKeyConfigured() / runLiveApiCheck()'s ACTUAL source
 * text (by brace-matching, not by hand-copying) straight off disk and running
 * it against a SYNTHETIC getProviderInfo that throws on command — decoupled
 * from whatever llm.js's catalogue looks like right now. This is the same
 * "extract the real function, inject a fake collaborator" technique this repo
 * already uses elsewhere (see CLAUDE.md v3.14.0, chargeForItem/getModelPrice).
 * It also means a future edit that reintroduces a hardcoded provider list, or
 * that re-collapses the two error cases, is caught even though this suite
 * never imports llm.js at all.
 *
 * Real, imported, end-to-end runQuickDiagnostics()/runLiveApiCheck() calls are
 * still used wherever the scenario does NOT depend on the moving catalogue
 * (no keys at all; Gemini-only; Anthropic-only; all three keyed with an
 * explicit activeProvider) — those exercise the real getApiKeys/getEffectiveKey
 * wiring end to end, including the real config file on disk.
 *
 * runLiveApiCheck() is only ever driven down its NO-KEY branch for real (which
 * returns before any LLM call is even reachable) or via the extracted-source
 * harness with a fake generateText that records-and-fails if ever invoked.
 * This suite never makes a network call.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';
import { __setDomainsDirOverride } from '../src/brain/config.js';
import { __setUserDataDirOverride } from '../src/brain/paths.js';
import { runQuickDiagnostics, runLiveApiCheck } from '../src/brain/diagnostics.js';

let passed = 0, failed = 0;
const fails = [];
function ok(l)  { passed++; console.log(`  ✓ ${l}`); }
function bad(l, e) { failed++; fails.push({ l, e }); console.log(`  ✗ ${l}`); if (e) console.log(`    └─ ${e}`); }
function assert(c, l, e) { c ? ok(l) : bad(l, e || 'assertion failed'); }
function section(t) { console.log(`\n── ${t} ──`); }

const VALID = new Set(['ok', 'warn', 'fail', 'info']);
const PROVIDER_NAME_RE = /gemini|anthropic|openrouter/i;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIAGNOSTICS_PATH = path.join(__dirname, '..', 'src', 'brain', 'diagnostics.js');

// ── source-extraction harness ────────────────────────────────────────────────
// Naive brace-depth counting is safe for this file: every '{'/'}' inside the
// functions extracted below is either a real block delimiter or a balanced
// pair (an object literal, a destructuring pattern, or a `${...}` template
// interpolation) — none of the target functions contain a literal unmatched
// brace inside a plain string. If that ever stops being true, the depth
// tripwire below throws a clear, named error instead of silently returning a
// truncated function body.
function extractFunctionSource(src, name) {
  const marker = `function ${name}(`;
  const idx = src.indexOf(marker);
  if (idx === -1) {
    throw new Error(`extractFunctionSource: could not find "${marker}" in diagnostics.js — ` +
      `has it been renamed or removed? This suite's premise depends on it existing under that name.`);
  }
  const braceStart = src.indexOf('{', idx);
  if (braceStart === -1) throw new Error(`extractFunctionSource: no opening brace found after "${marker}"`);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  if (depth !== 0) {
    throw new Error(`extractFunctionSource: braces never balanced while extracting "${name}" — ` +
      `naive extraction is unsafe for this source shape now; this suite needs a real tokenizer.`);
  }
  return src.slice(idx, i);
}

function readDiagnosticsSource() {
  return readFileSync(DIAGNOSTICS_PATH, 'utf8');
}

// ── THE EXTRACTION MANIFESTS, DECLARED AS DATA ───────────────────────────────
// Three sandboxes, each lifting functions out of diagnostics.js by a HARDCODED
// list. Declared here rather than inline so the completeness guard below can
// reason about the same lists the harnesses actually build from.
const HARNESS_MANIFESTS = Object.freeze({
  checkProvider: {
    extracted: ['check', 'hasAnyKeyConfigured', 'checkProvider'],
    injected: ['getApiKeys', 'getEffectiveKey', 'getProviderInfo', 'getFallbackStatus'],
  },
  hasAnyKeyConfigured: {
    extracted: ['hasAnyKeyConfigured'],
    injected: ['getApiKeys', 'getEffectiveKey'],
  },
  runLiveApiCheck: {
    extracted: ['hasAnyKeyConfigured', 'runLiveApiCheck'],
    injected: ['getApiKeys', 'getEffectiveKey', 'getProviderInfo', 'getFallbackStatus', 'generateText'],
  },
});

/**
 * Builds the REAL checkProvider() (plus the REAL check()/hasAnyKeyConfigured()
 * it calls, so no ReferenceError masks a behavioural bug) against injected
 * collaborators.
 */
function buildCheckProviderHarness(src) {
  const m = HARNESS_MANIFESTS.checkProvider;
  const body = m.extracted.map((n) => extractFunctionSource(src, n)).join('\n') + '\nreturn checkProvider;';
  return new Function(...m.injected, body);
}

/** Builds the REAL hasAnyKeyConfigured() in isolation. */
function buildHasAnyKeyConfiguredHarness(src) {
  const m = HARNESS_MANIFESTS.hasAnyKeyConfigured;
  const body = m.extracted.map((n) => extractFunctionSource(src, n)).join('\n') + '\nreturn hasAnyKeyConfigured;';
  return new Function(...m.injected, body);
}

/** Builds the REAL runLiveApiCheck() (+ the REAL hasAnyKeyConfigured() it calls). */
function buildRunLiveApiCheckHarness(src) {
  const m = HARNESS_MANIFESTS.runLiveApiCheck;
  // extractFunctionSource finds the substring starting at "function
  // runLiveApiCheck(" — it deliberately does not capture the "export async "
  // prefix, so that has to be restored here for `await` inside the body to
  // be legal.
  const body = m.extracted
    .map((n) => (n === 'runLiveApiCheck' ? 'async ' : '') + extractFunctionSource(src, n))
    .join('\n') + '\nreturn runLiveApiCheck;';
  return new Function(...m.injected, body);
}

/**
 * ══ §0  EVERY CALLEE IS PROVIDED — A NAMED FAILURE, NOT A CRASH ═════════════
 *
 * The three harnesses above lift functions out of diagnostics.js by a
 * hardcoded list. A function they call that is neither extracted nor injected
 * is a free identifier that only explodes at CALL time — and here the
 * explosion is a raw `ReferenceError` out of `new Function`, which ABORTS THE
 * WHOLE FILE. Every assertion after it never runs, and the runner sees a crash
 * rather than a tally, so what was really "one manifest entry is stale" reads
 * as "the diagnostics module is broken".
 *
 * The sibling suites (test-next-model-picker.js §0, test-next-provider-rows.js
 * §0) closed this class for their own sandboxes and recorded that every other
 * suite lifting functions by a hardcoded list still had it. This is that
 * closure here. The scanner is duplicated rather than shared: these suites use
 * three different `extractFunction*` implementations, and this change may not
 * add a file outside the suites it owns. The duplication is stated, not hidden.
 *
 * ── ENFORCED ──
 *   • Every function CALLED by an extracted function resolves to something the
 *     harness provides (extracted, injected, or a standard global).
 *   • Every manifest entry is a real top-level function in diagnostics.js.
 * ── NOT ENFORCED ──
 *   • Method calls (`a.b()`) — those resolve against a value, not module scope.
 *   • Free identifiers READ but never CALLED (a bare `SOME_CONST`); those still
 *     crash loudly rather than pass quietly.
 *   • Comment/literal stripping is approximate and errs toward OVER-reporting,
 *     whose cost is one manifest entry.
 */
function stripCommentsAndLiterals(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (two === '/*') { i += 2; while (i < src.length && src.slice(i, i + 2) !== '*/') i++; i += 2; continue; }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      i++;
      out += '""';
      continue;
    }
    out += c; i++;
  }
  return out;
}
function topLevelFunctionNames(src) {
  const names = new Set();
  const re = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return names;
}
const SAFE_GLOBALS = new Set([
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'RegExp',
  'Date', 'Error', 'Set', 'Map', 'Symbol', 'Promise', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'BigInt',
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
]);
function locallyBoundNames(body) {
  const names = new Set();
  const decl = /\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = decl.exec(body)) !== null) names.add(m[1]);
  const params = /(?:function\s*[A-Za-z_$\w$]*\s*|\)\s*=>|^)?\(([^()]*)\)\s*(?:=>|\{)/g;
  while ((m = params.exec(body)) !== null) {
    for (const part of m[1].split(',')) {
      const t = part.trim().replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  const destr = /\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g;
  while ((m = destr.exec(body)) !== null) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(':').pop().replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  return names;
}
/** Callees of `names` (taken from `src`) that resolve to nothing `provided` has. */
function unresolvedCallees(src, names, provided) {
  const out = [];
  for (const name of names) {
    const body = stripCommentsAndLiterals(extractFunctionSource(src, name));
    const locals = locallyBoundNames(body);
    // ── WHY THIS DOES NOT CONSUME THE PRECEDING CHARACTER ──────────────────
    // The obvious form, `/(^|[^.\w$\\])([A-Za-z_$][\w$]*)\s*\(/g`, EATS the
    // opening paren, so in `if (hasAnyKeyConfigured())` the match for `if (`
    // leaves lastIndex past the paren and the inner callee is never seen.
    // Measured: control 1 below reported "nothing found" against a call that
    // is plainly there. Any callee wrapped in `if (…)`, `while (…)`,
    // `return (…)` or another call was invisible. The identifier is now
    // matched with a LOOKAHEAD for the paren and the preceding character is
    // inspected without being consumed — `.` (member access), `\` (a regex
    // escape such as `/\B(?=…)/`) and a word character (a longer identifier)
    // all disqualify it.
    const callRe = /[A-Za-z_$][\w$]*(?=\s*\()/g;
    let m;
    while ((m = callRe.exec(body)) !== null) {
      const called = m[0];
      const prev = m.index > 0 ? body[m.index - 1] : '';
      if (prev === '.' || prev === '\\' || /[\w$]/.test(prev)) continue;
      if (called === name) continue;
      if (provided.has(called)) continue;
      if (locals.has(called)) continue;
      if (SAFE_GLOBALS.has(called)) continue;
      out.push(`${name}() -> ${called}()`);
    }
  }
  return [...new Set(out)];
}

function listAllFilesRecursive(dir) {
  const out = [];
  function walk(d, rel) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, r);
      else out.push(r);
    }
  }
  walk(dir, '');
  return out.sort();
}

function freshUserDataDir(root, name) {
  const d = path.join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
}

function writeCuratorConfig(userDataDir, obj) {
  writeFileSync(path.join(userDataDir, '.curator-config.json'), JSON.stringify(obj, null, 2), 'utf8');
}

// ── env isolation: never let the ambient shell's real keys leak in ──────────
const SAVED_ENV = {};
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'LLM_MODEL']) {
  SAVED_ENV[k] = process.env[k];
  delete process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ── §0 runs BEFORE anything else, because everything else depends on the
// three harnesses building. A stale manifest must be a NAMED failure here
// rather than a raw ReferenceError that takes the whole file down.
section('§0  Harness manifests are COMPLETE (a missing callee is a named failure, not a crash)');
{
  const src = readDiagnosticsSource();
  const topLevel = topLevelFunctionNames(src);
  assert(topLevel.size > 3,
    `the top-level function scanner sees diagnostics.js's helpers (found ${topLevel.size})`);

  const allUnresolved = [];
  for (const [harness, m] of Object.entries(HARNESS_MANIFESTS)) {
    for (const n of m.extracted) {
      assert(topLevel.has(n), `${harness}: manifest entry "${n}" is a real top-level function in diagnostics.js`);
    }
    const provided = new Set([...m.extracted, ...m.injected]);
    // A RENAMED function makes extractFunctionSource THROW, which would abort
    // the whole file — the very outcome this section exists to convert into a
    // tally entry. Caught here so the rename is reported as a named failure
    // beside the manifest assertion that already flagged it.
    try {
      for (const u of unresolvedCallees(src, m.extracted, provided)) allUnresolved.push(`${harness}: ${u}`);
    } catch (err) {
      allUnresolved.push(`${harness}: SCAN ABORTED — ${err && err.message}`);
    }
  }
  assert(allUnresolved.length === 0,
    'every function an extracted helper calls is itself extracted, injected or a standard global',
    allUnresolved.length
      ? `UNRESOLVED: ${allUnresolved.join(', ')}. Add the callee to that harness's \`extracted\` list ` +
        'if it is a diagnostics.js helper, or to its `injected` list if the sandbox should supply it. ' +
        'Without this the harness throws a raw ReferenceError out of new Function() and ABORTS THE ' +
        'WHOLE FILE — every assertion below never runs.'
      : null);

  // ── POSITIVE CONTROL 1 — an EXTRACTED callee ───────────────────────────
  // Drop hasAnyKeyConfigured from the checkProvider manifest; the detector
  // must NAME its caller. Proves the guard is not green because it sees
  // nothing. (`check` is the caller in diagnostics.js today; the assertion
  // only requires that SOMETHING is reported as calling it.)
  {
    const m = HARNESS_MANIFESTS.checkProvider;
    const without = m.extracted.filter((n) => n !== 'hasAnyKeyConfigured');
    const provided = new Set([...without, ...m.injected]);
    const found = unresolvedCallees(src, without, provided);
    assert(found.some((s) => s.endsWith('-> hasAnyKeyConfigured()')),
      'control — removing an EXTRACTED callee from a manifest IS detected',
      `found: ${found.join(', ') || 'nothing'}`);
  }
  // ── POSITIVE CONTROL 2 — an INJECTED collaborator ──────────────────────
  // A different shape, so the mechanism is not keyed to one special case.
  {
    const m = HARNESS_MANIFESTS.checkProvider;
    const provided = new Set([...m.extracted, ...m.injected.filter((n) => n !== 'getProviderInfo')]);
    const found = unresolvedCallees(src, m.extracted, provided);
    assert(found.some((s) => s.endsWith('-> getProviderInfo()')),
      'control — removing an INJECTED collaborator IS detected by the same scanner',
      `found: ${found.join(', ') || 'nothing'}`);
  }

  // ── POSITIVE CONTROL 3 — THE SHAPE THE OLD REGEX COULD NOT SEE ─────────
  // Synthetic source, so it pins the SCANNER rather than today's settings.js.
  // The previous consuming form matched `if (` and left lastIndex past the
  // paren, making `zzInner`, and everything nested inside another call,
  // invisible. This control fails on that form and passes on the lookahead
  // one; it also proves a METHOD call is still not mistaken for a free
  // identifier.
  {
    const probe = 'function zzProbe(a) {\n  if (zzInner(a)) return zzOuter(zzDeep(a));\n  return a.zzMethod();\n}\n';
    const found = unresolvedCallees(probe, ['zzProbe'], new Set());
    const want = ['zzInner', 'zzOuter', 'zzDeep'];
    assert(want.every((n) => found.includes(`zzProbe() -> ${n}()`)) &&
       !found.some((s) => s.endsWith('-> zzMethod()')),
      'control — a callee nested inside `if (…)` or another call IS visible, and a method call is not mistaken for one',
      `found: ${found.join(', ') || 'nothing'}`);
  }
}

const work = mkdtempSync(path.join(tmpdir(), 'diag-test-'));

try {
  // ═══════════════════════════════════════════════════════════════════════
  // A. runQuickDiagnostics() CONTRACT (unchanged from the original suite)
  // ═══════════════════════════════════════════════════════════════════════
  section('runQuickDiagnostics contract');
  const writableDir = freshUserDataDir(work, 'contract-domains');
  __setDomainsDirOverride(writableDir);
  __setUserDataDirOverride(freshUserDataDir(work, 'contract-userdata'));

  const res = await runQuickDiagnostics();
  assert(res && Array.isArray(res.checks), 'returns { checks: [] }');
  // 7 since the install-mode release: `install-mode` and `git` joined the five
  // originals. The count is pinned deliberately rather than relaxed to `>= 5` —
  // a row silently disappearing is exactly what this assertion is for.
  assert(res.checks.length === 7, `7 checks returned (got ${res.checks?.length})`);
  assert(res.checks.every(c => c.id && c.label && VALID.has(c.status) && typeof c.detail === 'string'),
    'every check has id/label/valid-status/detail');

  const summed = (res.summary.ok || 0) + (res.summary.warn || 0) + (res.summary.fail || 0) + (res.summary.info || 0);
  assert(summed === res.checks.length, `summary counts sum to checks.length (${summed} === ${res.checks.length})`);

  const ids = res.checks.map(c => c.id);
  for (const id of ['version', 'install-mode', 'provider', 'domains', 'credentials', 'git', 'sync']) {
    assert(ids.includes(id), `includes "${id}" check`);
  }

  // ── Domains-writable probe is deterministic ──────────────────────────────
  section('domains-writable probe is deterministic');
  const domCheckWritable = res.checks.find(c => c.id === 'domains');
  assert(domCheckWritable.status === 'ok', `writable tempdir → ok (got ${domCheckWritable.status})`);

  const leftover1 = readdirSync(writableDir).filter(f => f.startsWith('.curator-healthcheck'));
  assert(leftover1.length === 0, `probe file self-deleted (leftover: ${leftover1.join(',') || 'none'})`);

  __setDomainsDirOverride(path.join(work, 'contract-does-not-exist'));
  const res2 = await runQuickDiagnostics();
  const domMissing = res2.checks.find(c => c.id === 'domains');
  assert(domMissing.status === 'warn', `missing domains dir → warn (got ${domMissing.status})`);

  // ═══════════════════════════════════════════════════════════════════════
  // B. runQuickDiagnostics() is READ-ONLY w.r.t. user data
  // ═══════════════════════════════════════════════════════════════════════
  section('runQuickDiagnostics is read-only w.r.t. user data');
  const roDomains = freshUserDataDir(work, 'readonly-domains');
  const roUserData = freshUserDataDir(work, 'readonly-userdata');
  // Seed a fake domain + a wiki page, exactly the kind of content the probe
  // must never touch.
  const domainDir = path.join(roDomains, 'testdomain');
  const wikiDir = path.join(domainDir, 'wiki', 'entities');
  mkdirSync(wikiDir, { recursive: true });
  const claudeMdPath = path.join(domainDir, 'CLAUDE.md');
  const wikiPagePath = path.join(wikiDir, 'someone.md');
  const claudeMdContent = '# testdomain schema\nThis file must not be touched by System Check.\n';
  const wikiPageContent = '---\ntype: entity\n---\n# Someone\nContent that must survive byte-for-byte.\n';
  writeFileSync(claudeMdPath, claudeMdContent, 'utf8');
  writeFileSync(wikiPagePath, wikiPageContent, 'utf8');
  const beforeListing = listAllFilesRecursive(roDomains);
  const beforeClaudeMdMtime = statSync(claudeMdPath).mtimeMs;
  const beforeWikiMtime = statSync(wikiPagePath).mtimeMs;
  writeCuratorConfig(roUserData, { geminiApiKey: 'fake-readonly-probe-key' });

  __setDomainsDirOverride(roDomains);
  __setUserDataDirOverride(roUserData);
  await runQuickDiagnostics();
  // Also exercise the opt-in path's no-key branch shape (still no network —
  // getProviderInfo() will SUCCEED here since a Gemini key is configured, so
  // this call is intentionally NOT made in this scenario; see section D for
  // why runLiveApiCheck() is only ever driven for real down its no-key branch.

  const afterListing = listAllFilesRecursive(roDomains);
  assert(JSON.stringify(beforeListing) === JSON.stringify(afterListing),
    `domains tree file set unchanged (before: [${beforeListing.join(',')}], after: [${afterListing.join(',')}])`);
  assert(readFileSync(claudeMdPath, 'utf8') === claudeMdContent, 'CLAUDE.md content byte-unchanged');
  assert(readFileSync(wikiPagePath, 'utf8') === wikiPageContent, 'wiki page content byte-unchanged');
  assert(statSync(claudeMdPath).mtimeMs === beforeClaudeMdMtime, 'CLAUDE.md mtime unchanged (never opened for write)');
  assert(statSync(wikiPagePath).mtimeMs === beforeWikiMtime, 'wiki page mtime unchanged (never opened for write)');

  // ═══════════════════════════════════════════════════════════════════════
  // C. checkProvider(), REAL end-to-end — scenarios that do NOT depend on
  //    the (currently moving) OpenRouter model catalogue.
  // ═══════════════════════════════════════════════════════════════════════
  section('checkProvider() end-to-end: no keys at all');
  const noKeyUserData = freshUserDataDir(work, 'e2e-no-key-userdata');
  const noKeyDomains = freshUserDataDir(work, 'e2e-no-key-domains');
  __setUserDataDirOverride(noKeyUserData);
  __setDomainsDirOverride(noKeyDomains);
  // No .curator-config.json written at all.
  const noKeyRes = await runQuickDiagnostics();
  const noKeyProvider = noKeyRes.checks.find(c => c.id === 'provider');
  assert(noKeyProvider.status === 'warn', `no keys anywhere → warn (got ${noKeyProvider.status})`);
  assert(typeof noKeyProvider.detail === 'string' && noKeyProvider.detail.length > 0,
    'no-key detail is a non-empty string');
  assert(!PROVIDER_NAME_RE.test(noKeyProvider.detail),
    `no-key remedy does not hardcode a provider name — must not regress to naming Gemini/Anthropic/OpenRouter (got: "${noKeyProvider.detail}")`);
  const genericNoKeyMessageFromRealPath = noKeyProvider.detail;

  section('checkProvider() end-to-end: only Gemini keyed');
  const geminiOnlyUserData = freshUserDataDir(work, 'e2e-gemini-userdata');
  writeCuratorConfig(geminiOnlyUserData, { geminiApiKey: 'fake-test-gemini-key-not-real' });
  __setUserDataDirOverride(geminiOnlyUserData);
  const geminiOnlyRes = await runQuickDiagnostics();
  const geminiOnlyProvider = geminiOnlyRes.checks.find(c => c.id === 'provider');
  assert(geminiOnlyProvider.status === 'ok', `Gemini-only → ok (got ${geminiOnlyProvider.status}: ${geminiOnlyProvider.detail})`);
  assert(/gemini/i.test(geminiOnlyProvider.detail), `Gemini-only detail names gemini (got: "${geminiOnlyProvider.detail}")`);

  section('checkProvider() end-to-end: only Anthropic keyed');
  const anthropicOnlyUserData = freshUserDataDir(work, 'e2e-anthropic-userdata');
  writeCuratorConfig(anthropicOnlyUserData, { anthropicApiKey: 'fake-test-anthropic-key-not-real' });
  __setUserDataDirOverride(anthropicOnlyUserData);
  const anthropicOnlyRes = await runQuickDiagnostics();
  const anthropicOnlyProvider = anthropicOnlyRes.checks.find(c => c.id === 'provider');
  assert(anthropicOnlyProvider.status === 'ok', `Anthropic-only → ok (got ${anthropicOnlyProvider.status}: ${anthropicOnlyProvider.detail})`);
  assert(/anthropic/i.test(anthropicOnlyProvider.detail), `Anthropic-only detail names anthropic (got: "${anthropicOnlyProvider.detail}")`);

  section('checkProvider() end-to-end: all three providers keyed (activeProvider pinned)');
  const allThreeUserData = freshUserDataDir(work, 'e2e-all-three-userdata');
  writeCuratorConfig(allThreeUserData, {
    geminiApiKey: 'fake-test-gemini-key-not-real',
    anthropicApiKey: 'fake-test-anthropic-key-not-real',
    openrouterApiKey: 'fake-test-openrouter-key-not-real',
    activeProvider: 'gemini',
  });
  __setUserDataDirOverride(allThreeUserData);
  const allThreeRes = await runQuickDiagnostics();
  const allThreeProvider = allThreeRes.checks.find(c => c.id === 'provider');
  assert(allThreeProvider.status === 'ok', `all three keyed, active=gemini → ok (got ${allThreeProvider.status}: ${allThreeProvider.detail})`);
  assert(/gemini/i.test(allThreeProvider.detail), `all-three detail names the ACTIVE provider gemini (got: "${allThreeProvider.detail}")`);

  // ═══════════════════════════════════════════════════════════════════════
  // D. checkProvider(), extracted-source harness — decoupled from llm.js's
  //    catalogue state. This is where "a key exists but no model resolves"
  //    (the exact bug report: OpenRouter-only, no resolvable model) is
  //    actually proven, without depending on whether OFFERABLE_MODELS.openrouter
  //    / DEFAULTS.openrouter are populated at the moment this suite runs.
  // ═══════════════════════════════════════════════════════════════════════
  section('checkProvider() harness: key exists, no resolvable model (the reported bug)');
  const diagSrc1 = readDiagnosticsSource();
  const makeCheckProvider1 = buildCheckProviderHarness(diagSrc1);
  const SYNTHETIC_NO_MODEL_MESSAGE =
    'No model is configured for OpenRouter. This provider has no default model for building your wiki — pick one in Settings, or switch the active provider.';
  const checkProviderFn_keyExists = makeCheckProvider1(
    () => ({ openrouterApiKey: 'fake-openrouter-key-not-real' }),
    (id) => (id === 'openrouter' ? 'fake-openrouter-key-not-real' : null),
    () => { throw new Error(SYNTHETIC_NO_MODEL_MESSAGE); },
    () => null,
  );
  const keyExistsResult = checkProviderFn_keyExists();
  assert(keyExistsResult.status === 'warn', `key-exists-no-model → warn (got ${keyExistsResult.status})`);
  assert(keyExistsResult.detail === SYNTHETIC_NO_MODEL_MESSAGE,
    `key-exists-no-model surfaces the REAL error verbatim (got: "${keyExistsResult.detail}")`);
  assert(!/no api key configured/i.test(keyExistsResult.detail),
    `key-exists-no-model must NOT say "no API key configured" — a key IS configured (got: "${keyExistsResult.detail}")`);

  section('checkProvider() harness: no key anywhere (mechanism-level, cross-checked against the real end-to-end path)');
  const makeCheckProvider2 = buildCheckProviderHarness(diagSrc1);
  const checkProviderFn_noKey = makeCheckProvider2(
    () => ({}),
    () => null,
    () => { throw new Error('No LLM API key found. Add one in Settings, or set GEMINI_API_KEY / ANTHROPIC_API_KEY in .env.'); },
    () => null,
  );
  const noKeyHarnessResult = checkProviderFn_noKey();
  assert(noKeyHarnessResult.status === 'warn', `no-key harness → warn (got ${noKeyHarnessResult.status})`);
  assert(!PROVIDER_NAME_RE.test(noKeyHarnessResult.detail),
    `no-key harness remedy does not hardcode a provider name (got: "${noKeyHarnessResult.detail}")`);
  assert(noKeyHarnessResult.detail === genericNoKeyMessageFromRealPath,
    `harness-derived generic message is BYTE-IDENTICAL to the real end-to-end path's message ` +
    `(harness: "${noKeyHarnessResult.detail}" | real: "${genericNoKeyMessageFromRealPath}") — ` +
    `proves both paths run the same source, not two implementations that can drift`);

  section('checkProvider() harness: success path unaffected (sanity)');
  const makeCheckProvider3 = buildCheckProviderHarness(diagSrc1);
  const checkProviderFn_ok = makeCheckProvider3(
    () => ({ geminiApiKey: 'fake-gemini-key-not-real' }),
    (id) => (id === 'gemini' ? 'fake-gemini-key-not-real' : null),
    () => ({ provider: 'gemini', model: 'synthetic-test-model-id' }),
    () => null,
  );
  const okResult = checkProviderFn_ok();
  assert(okResult.status === 'ok', `success path → ok (got ${okResult.status})`);
  assert(okResult.detail.includes('gemini') && okResult.detail.includes('synthetic-test-model-id'),
    `success path names the resolved provider + model (got: "${okResult.detail}")`);

  // ═══════════════════════════════════════════════════════════════════════
  // E. hasAnyKeyConfigured() genericity — a synthetic FOURTH provider,
  //    proving the derivation is driven by whatever fields getApiKeys()
  //    returns, not a hardcoded id list inside diagnostics.js.
  // ═══════════════════════════════════════════════════════════════════════
  section('hasAnyKeyConfigured(): a synthetic 4th provider is treated as a provider, not ignored');
  const diagSrc2 = readDiagnosticsSource();
  const makeHasAnyKeyConfigured = buildHasAnyKeyConfiguredHarness(diagSrc2);

  {
    const calls = [];
    const hasAnyKeyConfiguredFn = makeHasAnyKeyConfigured(
      () => ({ somethingApiKey: 'fake-nonsecret-placeholder-value' }),
      (id) => { calls.push(id); return id === 'something' ? 'present' : null; },
    );
    const result = hasAnyKeyConfiguredFn();
    assert(result === true, `a synthetic "somethingApiKey" field with a truthy key → hasAnyKeyConfigured() true (got ${result})`);
    assert(calls.includes('something'),
      `getEffectiveKey was actually called with the derived id "something" (calls: [${calls.join(',')}])`);
    assert(!calls.includes('somethingApiKey'),
      `the "ApiKey" suffix was stripped before querying — "somethingApiKey" itself was never passed (calls: [${calls.join(',')}])`);
  }

  section('hasAnyKeyConfigured(): synthetic 4th provider present but key absent → false (not vacuously true)');
  {
    const hasAnyKeyConfiguredFn = makeHasAnyKeyConfigured(
      () => ({ somethingApiKey: 'irrelevant-value' }),
      () => null,
    );
    const result = hasAnyKeyConfiguredFn();
    assert(result === false, `field present but getEffectiveKey returns null for everything → false (got ${result})`);
  }

  section('hasAnyKeyConfigured(): no fields at all → false');
  {
    const hasAnyKeyConfiguredFn = makeHasAnyKeyConfigured(() => ({}), () => 'would-be-truthy-if-called');
    const result = hasAnyKeyConfiguredFn();
    assert(result === false, `getApiKeys() returning {} → false regardless of getEffectiveKey (got ${result})`);
  }

  section('hasAnyKeyConfigured(): only a LATER field is truthy → still true');
  {
    const hasAnyKeyConfiguredFn = makeHasAnyKeyConfigured(
      () => ({ aApiKey: '', bApiKey: 'ignored-by-getApiKeys-but-getEffectiveKey-decides' }),
      (id) => (id === 'b' ? 'present' : null),
    );
    const result = hasAnyKeyConfiguredFn();
    assert(result === true, `.some() does not short-circuit on the first field alone (got ${result})`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F. runLiveApiCheck() — never throws; the no-key/no-provider branch never
  //    reaches generateText. This suite makes NO network call: the real
  //    call below is only exercised where getProviderInfo() is GUARANTEED
  //    to throw before generateText is ever referenced (verified by reading
  //    the source above), and every other scenario runs through the
  //    extracted-source harness with a generateText stub that fails loudly
  //    if it is ever invoked.
  // ═══════════════════════════════════════════════════════════════════════
  section('runLiveApiCheck() end-to-end: no keys at all (guaranteed to short-circuit before any network call)');
  __setUserDataDirOverride(noKeyUserData); // reuse the no-key fixture from section C
  __setDomainsDirOverride(noKeyDomains);
  let liveNoKeyResult, liveNoKeyThrew = false;
  try {
    liveNoKeyResult = await runLiveApiCheck();
  } catch (err) {
    liveNoKeyThrew = true;
    liveNoKeyResult = { error: err.message };
  }
  assert(!liveNoKeyThrew, `runLiveApiCheck() did not throw with no keys configured (threw: ${liveNoKeyThrew ? liveNoKeyResult.error : 'n/a'})`);
  assert(liveNoKeyResult.ok === false, `no-key live check → ok:false (got ${JSON.stringify(liveNoKeyResult)})`);
  assert(typeof liveNoKeyResult.error === 'string' && liveNoKeyResult.error.length > 0,
    'no-key live check carries a non-empty error string');
  assert(!PROVIDER_NAME_RE.test(liveNoKeyResult.error),
    `no-key live check error does not hardcode a provider name (got: "${liveNoKeyResult.error}")`);

  section('runLiveApiCheck() harness: never throws, across several getProviderInfo failure shapes, and generateText is never reached');
  const diagSrc3 = readDiagnosticsSource();
  const makeRunLiveApiCheck = buildRunLiveApiCheckHarness(diagSrc3);

  async function driveRunLiveApiCheckHarness({ apiKeysFixture, effectiveKeyFixture, providerInfoError }) {
    let generateTextCalled = false;
    const fn = makeRunLiveApiCheck(
      apiKeysFixture,
      effectiveKeyFixture,
      () => { throw providerInfoError; },
      () => null,
      async () => { generateTextCalled = true; throw new Error('TEST FAILURE: generateText must never be reached when getProviderInfo() throws'); },
    );
    let threw = false, result;
    try {
      result = await fn();
    } catch (err) {
      threw = true;
      result = { error: err.message };
    }
    return { threw, result, generateTextCalled };
  }

  {
    // Shape 1: no key anywhere.
    const r = await driveRunLiveApiCheckHarness({
      apiKeysFixture: () => ({}),
      effectiveKeyFixture: () => null,
      providerInfoError: new Error('No LLM API key found. Add one in Settings, or set GEMINI_API_KEY / ANTHROPIC_API_KEY in .env.'),
    });
    assert(!r.threw, `harness no-key: does not throw (threw: ${r.threw ? r.result.error : 'n/a'})`);
    assert(!r.generateTextCalled, 'harness no-key: generateText never invoked');
    assert(r.result.ok === false, `harness no-key: ok:false (got ${JSON.stringify(r.result)})`);
    assert(!PROVIDER_NAME_RE.test(r.result.error), `harness no-key: error names no provider (got: "${r.result.error}")`);
  }

  {
    // Shape 2: a key exists (OpenRouter-shaped), but the provider throws its
    // own "no model configured" error — this must surface VERBATIM, not the
    // generic message. This is the harness-level proof of the reported bug,
    // for runLiveApiCheck() specifically (checkProvider()'s equivalent is
    // proven in section D).
    const r = await driveRunLiveApiCheckHarness({
      apiKeysFixture: () => ({ openrouterApiKey: 'fake-openrouter-key-not-real' }),
      effectiveKeyFixture: (id) => (id === 'openrouter' ? 'fake-openrouter-key-not-real' : null),
      providerInfoError: new Error(SYNTHETIC_NO_MODEL_MESSAGE),
    });
    assert(!r.threw, `harness key-exists-no-model: does not throw (threw: ${r.threw ? r.result.error : 'n/a'})`);
    assert(!r.generateTextCalled, 'harness key-exists-no-model: generateText never invoked');
    assert(r.result.ok === false, `harness key-exists-no-model: ok:false (got ${JSON.stringify(r.result)})`);
    assert(r.result.error === SYNTHETIC_NO_MODEL_MESSAGE,
      `harness key-exists-no-model: surfaces the real error verbatim (got: "${r.result.error}")`);
    assert(!/no api key configured/i.test(r.result.error),
      `harness key-exists-no-model: must NOT say "no API key configured" (got: "${r.result.error}")`);
  }

  {
    // Shape 3: an edge-case empty error message — still must not throw, and
    // must still resolve to a well-formed {ok:false, error} shape.
    const r = await driveRunLiveApiCheckHarness({
      apiKeysFixture: () => ({ openrouterApiKey: 'fake-openrouter-key-not-real' }),
      effectiveKeyFixture: (id) => (id === 'openrouter' ? 'fake-openrouter-key-not-real' : null),
      providerInfoError: new Error(''),
    });
    assert(!r.threw, `harness empty-message: does not throw (threw: ${r.threw ? r.result.error : 'n/a'})`);
    assert(!r.generateTextCalled, 'harness empty-message: generateText never invoked');
    assert(r.result.ok === false, `harness empty-message: ok:false (got ${JSON.stringify(r.result)})`);
    assert(r.result.error === '', `harness empty-message: error is the empty string, not swallowed or replaced (got: "${r.result.error}")`);
  }
} catch (err) {
  bad('unexpected throw aborted the suite', `${err.message}\n${err.stack || ''}`);
} finally {
  __setDomainsDirOverride(null);
  __setUserDataDirOverride(null);
  restoreEnv();
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  for (const { l, e } of fails) console.log(`  ✗ ${l}${e ? ` — ${e}` : ''}`);
  process.exit(1);
}
console.log('\nAll diagnostics tests green.');
process.exit(0);
