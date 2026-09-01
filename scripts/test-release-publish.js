#!/usr/bin/env node
/**
 * test-release-publish.js — OFFLINE suite over the step that turns a pushed
 * tag into installers people can actually download.
 *
 * ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────────
 * `scripts/release.js` bumps, gates on CI, fast-forwards `main` and pushes an
 * annotated tag. It does not publish a GitHub Release, and until v3.38.0
 * neither did anything else: `.github/workflows/desktop-dmg.yml` built both
 * DMGs and uploaded them as a 14-day workflow ARTIFACT. Publishing them,
 * RENAMED, was a manual step nobody had written down.
 *
 * The consequence was silent. The in-app updater resolves "the newest release
 * carrying an installer" from the Releases API, so with a tag and no release
 * every installed copy confidently reported **"You're up to date"** while
 * running the previous version. Six releases went out that way.
 *
 * ── AND THE RENAME IS NOT COSMETIC ────────────────────────────────────────
 * electron-builder writes `The Curator-3.37.0-arm64.dmg` and — this is the
 * dangerous one — `The Curator-3.37.0.dmg` for x86_64, with NO architecture in
 * the name at all. `archFromAssetName()` in `desktop/lib/update-plan.js`
 * lowercases, requires `.dmg`, splits the stem on `-` ONLY and looks for a
 * whole token `arm64` or `x64`. So the raw x64 name resolves to **null**, and
 * a release published unrenamed offers nothing to any Intel Mac — silently,
 * because `pickInstallerAsset()` reports `no-asset-for-arch` rather than
 * anything a user would read as "the release is mis-named".
 *
 * ── BEHAVIOUR, NOT SOURCE ─────────────────────────────────────────────────
 * §1 and §2 do not check that a regex exists. §1 runs the REAL, imported
 * `archFromAssetName` over the names this repo would publish, and over the raw
 * electron-builder names as NEGATIVE CONTROLS. §2 spawns the real CLI against
 * real files in a real tempdir and reads the directory afterwards.
 *
 * §3 is the exception and says so: the workflow cannot be executed here, so it
 * is PARSED — with a small YAML parser in this file, controlled by feeding it
 * malformed input it must reject and a second real workflow it must accept —
 * and asserted structurally. That is a weaker claim than §1 and §2 and it is
 * labelled as one.
 *
 * ── NOT ENFORCED (stated so a green run is not over-read) ─────────────────
 *   • NO GITHUB ACTION WAS RUN. Nothing here proves the workflow's YAML is
 *     accepted by GitHub's own schema, that `gh release create --verify-tag
 *     --latest` behaves as described, that `contents: write` is sufficient, or
 *     that `actions/upload-artifact@v4` still resolves. The publish path has
 *     never executed.
 *   • NO DISK IMAGE WAS OPENED. The `hdiutil` + `lipo` step is macOS-runner
 *     only. §3 asserts it exists, runs after the rename, and uses the arch
 *     spellings `LIPO_ARCH` declares — it cannot prove `lipo` reports what is
 *     expected of it.
 *   • The parser in §3 is a SUBSET of YAML — enough for these two workflows,
 *     and deliberately strict so it fails rather than guesses. It treats `on`
 *     as the string key `on`, where a YAML 1.1 loader would give `true`.
 *
 * Zero dependencies — node: builtins only, no network, no API key.
 */

import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { archFromAssetName } from '../desktop/lib/update-plan.js';
import {
  PUBLISHED_PREFIX, ARCH_LABEL, PUBLISHED_ARCHES, LIPO_ARCH,
  publishedNameFor, classifyBuiltName, planPublish, publishNames, parsePublishArgs,
} from './publish-dmg-assets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CLI = path.join(__dirname, 'publish-dmg-assets.js');
const DMG_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'desktop-dmg.yml');
const TEST_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'test.yml');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (good) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function section(t) { console.log(`\n${t}`); }

const V = '3.37.0';
const RAW_ARM64 = `The Curator-${V}-arm64.dmg`;
const RAW_X64 = `The Curator-${V}.dmg`;

const tmps = [];
function tmp() {
  const d = mkdtempSync(path.join(tmpdir(), 'curator-publish-'));
  tmps.push(d);
  return d;
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1  The published names resolve, and the RAW ones do not — real archFromAssetName');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Anti-vacuity first: prove the imported function is the real one and is
  // capable of returning both answers, before anything is asserted with it.
  eq(typeof archFromAssetName, 'function', 'archFromAssetName was imported from desktop/lib/update-plan.js');
  eq(archFromAssetName('x-1.0.0-arm64.dmg'), 'arm64', 'CONTROL — it can return arm64');
  eq(archFromAssetName('x-1.0.0-x64.dmg'), 'x64', 'CONTROL — it can return x64');
  eq(archFromAssetName('x-1.0.0.dmg'), null, 'CONTROL — it can return null');

  // THE NAMES THIS REPO PUBLISHES. Composed by the module, resolved by the app.
  for (const arch of PUBLISHED_ARCHES) {
    const name = publishedNameFor(V, arch);
    eq(name, `${PUBLISHED_PREFIX}-${V}-${ARCH_LABEL[arch]}.dmg`, `publishedNameFor(${V}, ${arch}) is ${name}`);
    eq(archFromAssetName(name), arch, `…and the app's own matcher resolves ${name} to ${arch}`);
  }

  // ── THE NEGATIVE CONTROLS — the whole reason the rename exists ───────────
  eq(archFromAssetName(RAW_X64), null,
     `the RAW electron-builder x64 name "${RAW_X64}" is UNPUBLISHABLE AS IS — the updater resolves it to null and no Intel Mac would find a build`);
  eq(archFromAssetName(RAW_ARM64), 'arm64',
     `the RAW arm64 name "${RAW_ARM64}" happens to resolve — recorded so nobody concludes only the x64 file needs renaming; it is renamed for a consistent, space-free published set`);

  // A name carrying BOTH tokens resolves to null, so a label change that
  // smuggled the other architecture's word in would break the download.
  eq(archFromAssetName(`${PUBLISHED_PREFIX}-${V}-arm64-x64.dmg`), null,
     'a name carrying BOTH arch tokens resolves to null');
  eq(archFromAssetName(`${PUBLISHED_PREFIX}-${V}-arm64-AppleSilicon.zip`), null,
     'a non-.dmg extension resolves to null');

  // The human half of the label must not accidentally contain the other
  // architecture's machine token. Derived from ARCH_LABEL rather than typed.
  for (const arch of PUBLISHED_ARCHES) {
    const other = PUBLISHED_ARCHES.filter((a) => a !== arch);
    const tokens = ARCH_LABEL[arch].toLowerCase().split('-');
    ok(!other.some((o) => tokens.includes(o)),
       `ARCH_LABEL.${arch} ("${ARCH_LABEL[arch]}") carries no token belonging to the other architecture`);
  }

  // A published name must never contain a space: it is percent-encoded in the
  // download URL and needs quoting in every shell line that touches it.
  for (const arch of PUBLISHED_ARCHES) {
    ok(!publishedNameFor(V, arch).includes(' '), `the published ${arch} name has no space (the raw one does: "${RAW_ARM64}")`);
  }

  // Pre-release versions carry a hyphen, which is the separator the matcher
  // splits on. Prove that does not break the resolution.
  for (const ver of ['3.0.1-beta.27', '10.0.0', '3.37.0']) {
    for (const arch of PUBLISHED_ARCHES) {
      eq(archFromAssetName(publishedNameFor(ver, arch)), arch, `${publishedNameFor(ver, arch)} still resolves to ${arch}`);
    }
  }
  eq(publishedNameFor('not-a-version', 'arm64'), null, 'a non-semver version composes no name');
  eq(publishedNameFor(V, 'ppc'), null, 'an unknown architecture composes no name');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  The rename, executed for real against real files');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ── classification of what electron-builder actually writes ─────────────
  eq(classifyBuiltName(RAW_ARM64, V), 'arm64', 'the raw arm64 build is classified arm64');
  eq(classifyBuiltName(RAW_X64, V), 'x64',
     'the raw name with NO arch segment is classified x64 — electron-builder omits the arch for x64, and that is the rule the whole rename turns on');
  eq(classifyBuiltName(`The Curator-3.36.0.dmg`, V), null, 'a build of a DIFFERENT version is not classified');
  eq(classifyBuiltName('The Curator-3.37.0.zip', V), null, 'a non-.dmg is not classified');

  // ── the plan, as a pure function ────────────────────────────────────────
  const good = planPublish([RAW_ARM64, RAW_X64, 'latest-mac.yml'], V);
  ok(good.ok, `a normal build directory plans cleanly${good.ok ? '' : ` — refused: ${good.reason} (${good.detail})`}`);
  // `|| []` so a refusal reds on the NAMED assertion below rather than
  // crashing here and taking the rest of the suite with it. A mutation that
  // reds by crashing is a weaker signal than one that reds by name, and this
  // file is downstream of a repo that has recorded that distinction repeatedly.
  eq((good.plan || []).map((s) => `${s.arch}:${s.from} -> ${s.to}`), [
    `arm64:${RAW_ARM64} -> ${publishedNameFor(V, 'arm64')}`,
    `x64:${RAW_X64} -> ${publishedNameFor(V, 'x64')}`,
  ], 'the plan renames both files to the published names, arm64 first');

  eq(planPublish([RAW_ARM64], V).reason, 'missing-arch', 'a build missing the x64 DMG is REFUSED, not published half-complete');
  eq(planPublish([RAW_X64], V).reason, 'missing-arch', 'a build missing the arm64 DMG is refused too');
  eq(planPublish([], V).reason, 'missing-arch', 'an empty directory is refused');
  eq(planPublish([RAW_ARM64, RAW_X64, 'The Curator-3.30.0-arm64.dmg'], V).reason, 'unrecognised-dmg',
     'a stale DMG from an older version is refused rather than silently published');
  eq(planPublish([RAW_ARM64, RAW_X64], 'v3.37.0').reason, 'bad-version',
     'the version must be bare semver — a leading v is refused, because the workflow strips it and a double strip would produce nothing');
  ok(planPublish([publishedNameFor(V, 'arm64'), publishedNameFor(V, 'x64')], V).ok,
     'a directory already carrying the published names plans as a no-op, so a workflow re-run is not a failure');

  // ── THE VERIFICATION LOOP, DRIVEN ───────────────────────────────────────
  // planPublish runs the real archFromAssetName over the names it is about to
  // publish. Reachable, not decorative: a version whose PRE-RELEASE segment is
  // itself an architecture token makes the arm64 name carry BOTH tokens, which
  // the matcher resolves to null. Without this case the loop could be deleted
  // and every other assertion here would stay green.
  {
    const poisoned = '1.0.0-x64';
    eq(archFromAssetName(publishedNameFor(poisoned, 'arm64')), null,
       'CONTROL — a version whose pre-release segment is "x64" makes the arm64 name carry both tokens, which the matcher cannot resolve');
    const r = planPublish([`The Curator-${poisoned}-arm64.dmg`, `The Curator-${poisoned}.dmg`], poisoned);
    eq(r.reason, 'name-does-not-resolve',
       'planPublish REFUSES a plan whose output names the app matcher cannot resolve — the check runs before any file moves');
    ok(/archFromAssetName/.test(r.detail), '…and the refusal names the function that rejected it');
  }

  // ── THE END TO END: the real CLI, real files, real renames ──────────────
  {
    const dir = tmp();
    for (const n of [RAW_ARM64, RAW_X64]) writeFileSync(path.join(dir, n), 'not really a disk image');
    const outFile = path.join(dir, 'gh-output');
    writeFileSync(outFile, '');
    const r = spawnSync(process.execPath, [CLI, '--dir', dir, '--version', V], {
      encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outFile },
    });
    eq(r.status, 0, 'the CLI exits 0 on a normal build directory');
    eq(readdirSync(dir).filter((f) => f.endsWith('.dmg')).sort(),
       [publishedNameFor(V, 'arm64'), publishedNameFor(V, 'x64')].sort(),
       'BOTH files on disk now carry the published names');
    ok(r.stdout.includes('resolves it to arm64') && r.stdout.includes('resolves it to x64'),
       'the CLI reports the resolution of each final name rather than only that it renamed something');

    // The workflow addresses the files by these outputs, never by a glob.
    const outText = readFileSync(outFile, 'utf8');
    ok(outText.includes(`arm64=${path.join(dir, publishedNameFor(V, 'arm64'))}`),
       'GITHUB_OUTPUT carries the arm64 path, so later steps do not glob');
    ok(outText.includes(`x64=${path.join(dir, publishedNameFor(V, 'x64'))}`),
       'GITHUB_OUTPUT carries the x64 path');

    // And the files that now exist really do resolve — read off disk, not from
    // the plan the script made a moment earlier.
    const resolved = readdirSync(dir).filter((f) => f.endsWith('.dmg')).map(archFromAssetName).sort();
    eq(resolved, ['arm64', 'x64'], 'reading the directory back, the app matcher resolves exactly one arm64 and one x64');
  }

  // A directory the rename cannot complete must EXIT NON-ZERO and rename
  // nothing, because the publish step downstream trusts this exit code.
  {
    const dir = tmp();
    writeFileSync(path.join(dir, RAW_ARM64), 'x');
    const r = spawnSync(process.execPath, [CLI, '--dir', dir, '--version', V], { encoding: 'utf8' });
    ok(r.status !== 0, 'a build missing an architecture exits NON-ZERO, so the job fails before publishing');
    ok(/missing-arch/.test(r.stderr), '…and names the refusal');
    eq(readdirSync(dir), [RAW_ARM64], '…and renamed nothing');
  }

  // --dry-run writes nothing.
  {
    const dir = tmp();
    for (const n of [RAW_ARM64, RAW_X64]) writeFileSync(path.join(dir, n), 'x');
    const r = spawnSync(process.execPath, [CLI, '--dir', dir, '--version', V, '--dry-run'], { encoding: 'utf8' });
    eq(r.status, 0, '--dry-run exits 0');
    eq(readdirSync(dir).sort(), [RAW_ARM64, RAW_X64].sort(), '…and renamed nothing');
  }

  eq(publishNames({ dir: path.join(tmp(), 'nope'), version: V, log: () => {} }).reason, 'no-such-dir',
     'a missing output directory is a named refusal, not a crash');
  ok(parsePublishArgs(['--dir', 'x']).error, 'the CLI refuses without --version');
  ok(parsePublishArgs(['--version', V]).error, 'the CLI refuses without --dir');
  ok(parsePublishArgs(['--dir', 'x', '--version', V, '--wat']).error,
     'an unrecognised flag is a hard error — never silently skipped, the shape v3.6.1 recorded');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  The workflow — PARSED, never executed. No Action was run for this suite.');
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A deliberately small, deliberately STRICT block-YAML parser: mappings,
 * sequences, block scalars, quote-aware comment stripping. It throws rather
 * than guesses, which is what makes "the file still parses" a real claim. The
 * controls below feed it malformed input it must reject and a second real
 * workflow it must accept.
 */
function parseYaml(src) {
  const raw = src.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const indentOf = (l) => l.match(/^ */)[0].length;
  const skippable = (l) => l.trim() === '' || /^\s*#/.test(l);

  function structural(l, n) {
    if (/^ *\t/.test(l)) throw new Error(`tab used for indentation at line ${n + 1}`);
    return l;
  }
  function stripComment(s) {
    let out = '', q = null;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (q) { out += ch; if (ch === q && s[k - 1] !== '\\') q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; out += ch; continue; }
      if (ch === '#' && (k === 0 || /\s/.test(s[k - 1]))) break;
      out += ch;
    }
    return out;
  }
  function scalar(t) {
    const s = t.trim();
    if (s === '') return null;
    if (s.length > 1 && ((s[0] === "'" && s.endsWith("'")) || (s[0] === '"' && s.endsWith('"')))) return s.slice(1, -1);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~') return null;
    if (/^-?\d+$/.test(s)) return Number(s);
    return s;
  }
  function nextMeaningful(from) {
    for (let j = from; j < raw.length; j++) if (!skippable(raw[j])) return j;
    return -1;
  }
  function blockScalar(parentIndent) {
    const buf = [];
    while (i < raw.length) {
      if (raw[i].trim() === '') { buf.push(''); i++; continue; }
      if (indentOf(raw[i]) <= parentIndent) break;
      buf.push(raw[i]); i++;
    }
    return buf.join('\n');
  }
  function node(indent) {
    const j = nextMeaningful(i);
    if (j === -1) return null;
    i = j;
    return /^-(\s|$)/.test(structural(raw[i], i).slice(indent)) ? seq(indent) : map(indent);
  }
  function map(indent) {
    const obj = {};
    while (i < raw.length) {
      if (skippable(raw[i])) { i++; continue; }
      const l = structural(raw[i], i);
      const ind = indentOf(l);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`unexpected indent at line ${i + 1}: ${JSON.stringify(l)}`);
      const body = stripComment(l.slice(indent));
      if (/^-(\s|$)/.test(body)) break;
      const m = body.match(/^([^:]+):(?:\s+(.*))?\s*$/);
      if (!m) throw new Error(`not a mapping entry at line ${i + 1}: ${JSON.stringify(l)}`);
      const key = m[1].trim().replace(/^['"]|['"]$/g, '');
      const rest = (m[2] ?? '').trim();
      i++;
      if (/^[|>][-+]?$/.test(rest)) { obj[key] = blockScalar(indent); continue; }
      if (rest !== '') { obj[key] = scalar(rest); continue; }
      const j = nextMeaningful(i);
      if (j === -1) { obj[key] = null; continue; }
      const childIndent = indentOf(structural(raw[j], j));
      if (childIndent > indent) { i = j; obj[key] = node(childIndent); continue; }
      if (childIndent === indent && /^-(\s|$)/.test(stripComment(raw[j].slice(indent)))) { i = j; obj[key] = seq(indent); continue; }
      obj[key] = null;
    }
    return obj;
  }
  function seq(indent) {
    const arr = [];
    while (i < raw.length) {
      if (skippable(raw[i])) { i++; continue; }
      const l = structural(raw[i], i);
      const ind = indentOf(l);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`unexpected indent at line ${i + 1}: ${JSON.stringify(l)}`);
      const body = stripComment(l.slice(indent));
      if (!/^-(\s|$)/.test(body)) break;
      const after = body.slice(1);
      if (after.trim() === '') {
        i++;
        const j = nextMeaningful(i);
        if (j !== -1 && indentOf(raw[j]) > indent) { i = j; arr.push(node(indentOf(raw[j]))); }
        else arr.push(null);
        continue;
      }
      const lead = after.match(/^ */)[0].length;
      const inner = after.slice(lead);
      if (/^[^:\s][^:]*:(\s|$)/.test(inner)) {
        const itemIndent = indent + 1 + lead;
        raw[i] = ' '.repeat(itemIndent) + inner;   // re-present the item as a plain mapping
        arr.push(map(itemIndent));
      } else {
        i++;
        arr.push(scalar(inner));
      }
    }
    return arr;
  }
  const doc = node(0);
  return doc;
}

{
  // ── CONTROLS on the parser itself, before anything is claimed with it ────
  let threw = null;
  try { parseYaml('a:\n\tb: 1\n'); } catch (e) { threw = e; }
  ok(threw && /tab/.test(threw.message), 'CONTROL — the parser REJECTS tab indentation rather than guessing');
  threw = null;
  try { parseYaml('a: 1\n  b: 2\n'); } catch (e) { threw = e; }
  ok(threw && /indent/.test(threw.message), 'CONTROL — the parser REJECTS a mis-indented line');
  threw = null;
  try { parseYaml('a:\n  just some prose with no colon\n'); } catch (e) { threw = e; }
  ok(threw && /mapping entry/.test(threw.message), 'CONTROL — the parser REJECTS a line that is neither a mapping nor a sequence item');
  eq(parseYaml("a:\n  - 'x'\n  - y\nb: 2\n"), { a: ['x', 'y'], b: 2 }, 'CONTROL — the parser reads sequences and scalars correctly');

  // Parse failures are CAUGHT and reported as named assertions rather than
  // thrown. An uncaught throw still exits non-zero, but a crash names nothing
  // and takes the rest of the section with it — a distinction this repo has
  // recorded often enough (v3.24.1) to be worth honouring in a new suite.
  const tryParse = (file) => {
    try { return { doc: parseYaml(readFileSync(file, 'utf8')), err: null }; }
    catch (e) { return { doc: null, err: e }; }
  };

  ok(existsSync(TEST_WORKFLOW), 'test.yml exists');
  const t = tryParse(TEST_WORKFLOW);
  ok(t.doc && t.doc.jobs && Object.keys(t.doc.jobs).length >= 2,
     `CONTROL — the parser also reads the OTHER real workflow (${t.err ? t.err.message : Object.keys(t.doc.jobs || {}).join(', ')}), so a green §3 is not a parser that only understands one file`);

  // ── THE WORKFLOW ────────────────────────────────────────────────────────
  ok(existsSync(DMG_WORKFLOW), '.github/workflows/desktop-dmg.yml exists');
  const parsed = tryParse(DMG_WORKFLOW);
  ok(parsed.doc && typeof parsed.doc === 'object',
     `it still parses as YAML${parsed.err ? ` — ${parsed.err.message}` : ''}`);
  // A shape with the right keys and no content, so every assertion below reds
  // BY NAME on a parse failure instead of crashing on undefined.
  const doc = parsed.doc || { on: { push: {} }, permissions: null, jobs: { gate: {}, dmg: { steps: [] } } };
  eq(Object.keys(doc).sort(), ['concurrency', 'jobs', 'name', 'on', 'permissions'],
     'CONTROL — the top-level structure is what it should be, so the assertions below are not reading an empty object');

  // The header's whole argument: tag-gated, and nothing that could put a run on
  // a branch+SHA the release gate is polling. Unchanged by this release.
  eq(doc.on.push.tags, ['v*'], 'it still triggers on v* tags only');
  eq(doc.on.push.branches, undefined, 'still NO branches: filter under push');
  eq(doc.on.pull_request, undefined, 'still NO pull_request trigger');
  eq(doc.on.workflow_dispatch, undefined, 'still NO workflow_dispatch — a manual run carries head_branch: main and could collide with the release gate at the same SHA');
  eq(Object.keys(doc.on), ['push'], 'and push is the ONLY trigger');

  // ── PERMISSIONS: narrow, at the JOB level ───────────────────────────────
  eq(doc.permissions, { contents: 'read' }, 'the workflow DEFAULT token is still read-only');
  eq(doc.jobs.gate.permissions, undefined, 'the Linux gate job declares none, so it inherits the read-only default');
  eq(doc.jobs.dmg.permissions, { contents: 'write' },
     'ONLY the dmg job widens to contents: write — the scope gh release create needs, at the job level so nothing else inherits it');

  // ── THE STEPS, AND THEIR ORDER ──────────────────────────────────────────
  const steps = doc.jobs.dmg.steps;
  ok(Array.isArray(steps) && steps.length >= 8, `CONTROL — the dmg job's steps parsed (${steps.length} steps)`);

  const idx = (pred) => steps.findIndex(pred);
  const iBuild = idx((s) => /electron-builder/.test(s.run || ''));
  const iNames = idx((s) => s.id === 'names');
  const iLipo = idx((s) => /lipo -archs/.test(s.run || ''));
  const iArtifact = idx((s) => /upload-artifact/.test(s.uses || ''));
  const iPublish = idx((s) => /gh release create/.test(s.run || ''));

  ok(iBuild >= 0, 'the build step is present');
  ok(iNames >= 0, 'a step with id "names" renames the DMGs');
  ok(iLipo >= 0, 'a step reads the real binary architecture with lipo');
  ok(iArtifact >= 0, 'the 14-day workflow artifact upload is KEPT as a fallback');
  ok(iPublish >= 0, 'a step creates the GitHub Release');

  // ORDER IS THE PROPERTY, not presence. Publishing before the rename would
  // ship exactly the release the updater cannot use.
  ok(iBuild < iNames, 'the rename runs AFTER the build');
  ok(iNames < iLipo, 'the contents check runs AFTER the rename, so it checks the name that will actually be published');
  ok(iNames < iArtifact, 'the artifact upload runs after the rename, so it carries the published names too');
  ok(iLipo < iPublish, 'nothing is published until both verifications have passed');

  // The rename step must call the script this suite exercised, on the build
  // output, with the version taken from the TAG rather than typed.
  const namesRun = steps[iNames].run || '';
  ok(/scripts\/publish-dmg-assets\.js/.test(namesRun), 'the rename step calls scripts/publish-dmg-assets.js — the module §1 and §2 drive');
  ok(/--dir\s+desktop\/dist/.test(namesRun), '…on desktop/dist, which is electron-builder\'s output directory');
  ok(/GITHUB_REF_NAME#v/.test(namesRun), '…with the version derived from the tag, never hand-typed');

  // The lipo step must use the spellings LIPO_ARCH declares — derived from the
  // module, not transcribed here, so the two cannot drift.
  const lipoRun = steps[iLipo].run || '';
  for (const arch of PUBLISHED_ARCHES) {
    ok(new RegExp(`check\\s+${LIPO_ARCH[arch]}\\b`).test(lipoRun),
       `the contents check asserts ${LIPO_ARCH[arch]} for the ${arch} image (LIPO_ARCH, not a transcribed literal)`);
    ok(lipoRun.includes(`steps.names.outputs.${arch}`),
       `…on the ${arch} path the rename step emitted, never a glob`);
  }
  ok(/hdiutil attach/.test(lipoRun) && /hdiutil detach/.test(lipoRun), 'the image is mounted and unmounted');
  ok(lipoRun.indexOf('hdiutil detach') < lipoRun.indexOf('::error::'),
     'detach happens BEFORE the failure is raised, so a mismatch does not leave an image mounted');
  ok(/set -euo pipefail/.test(lipoRun), 'the shell fails on the first error rather than continuing past a bad mount');

  // The publish step.
  const pub = steps[iPublish];
  const pubRun = pub.run || '';
  ok(pub.env && /github\.token/.test(String(pub.env.GH_TOKEN || '')), 'the publish step uses the automatic GITHUB_TOKEN, not a PAT');
  ok(/--verify-tag/.test(pubRun),
     'gh is passed --verify-tag, so it ABORTS on a missing tag rather than creating one — release.js is the only thing allowed to make a tag');
  ok(/--latest/.test(pubRun), 'the release is marked latest');
  for (const arch of PUBLISHED_ARCHES) {
    ok(new RegExp(`steps\\.names\\.outputs\\.${arch}`).test(JSON.stringify(pub.env || {})),
       `the ${arch} installer is attached by the path the rename step emitted`);
  }
  ok(/gh release upload .*--clobber/.test(pubRun),
     'a re-run over an existing release REPLACES its assets rather than failing, so a retried job does not leave a release without installers');
  ok(!/git push/.test(pubRun) && !/git tag/.test(pubRun), 'the publish step pushes nothing and tags nothing');

  // Nothing in the job may reintroduce a credential literal.
  const rawWorkflow = readFileSync(DMG_WORKFLOW, 'utf8');
  ok(!/AIza[0-9A-Za-z_-]{35}|sk-ant-[0-9A-Za-z_-]{20,}|(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[0-9A-Za-z_]{20,}/.test(rawWorkflow),
     'the workflow carries no credential-shaped literal');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  release.js no longer claims a release needs no publishing');
// ═══════════════════════════════════════════════════════════════════════════
{
  // A SOURCE assertion, and labelled as one: this is a stale COMMENT, and a
  // comment has no behaviour to drive. The behavioural half — that the closing
  // banner says the installers are still building — is §6b of
  // scripts/test-release-preconditions.js, which runs the real release().
  const src = readFileSync(path.join(__dirname, 'release.js'), 'utf8');
  ok(!/shipping an unwired parameter/.test(src),
     'the expired "unwired parameter" justification is gone from release.js — it stopped being true in v3.31.0 and is how six releases shipped with no installers');
  ok(/desktop-dmg\.yml/.test(src), 'release.js names the workflow that does publish');

  // Whitespace-normalised, because prose is hard-wrapped and the phrase this
  // guards against was split across a line break — an un-normalised regex
  // reported it absent while it sat in the file.
  const contributing = readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8').replace(/\s+/g, ' ');
  ok(!/shipping an unwired parameter/.test(contributing),
     'and the same expired justification is gone from CONTRIBUTING.md');
  ok(/desktop-dmg\.yml/.test(contributing), 'CONTRIBUTING.md names the workflow that publishes the installers');
}

for (const d of tmps) rmSync(d, { recursive: true, force: true });

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('❌ the release publish path is not what it claims to be');
  process.exit(1);
}
console.log('✅ the tag a release pushes now ends in a published, correctly-named pair of installers');
console.log('   (UNEXERCISED: no GitHub Action was run, no disk image was opened — see the header)');
