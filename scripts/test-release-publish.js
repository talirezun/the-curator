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

import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { archFromAssetName } from '../desktop/lib/update-plan.js';
import {
  PUBLISHED_PREFIX, ARCH_LABEL, PUBLISHED_ARCHES, LIPO_ARCH,
  publishedNameFor, classifyBuiltName, planPublish, publishNames, parsePublishArgs,
} from './publish-dmg-assets.js';
import {
  planWinPublish, WIN_PUBLISH_REFUSALS, parseWinPublishArgs, verifySourceArchive, noticesNameSource, fetchSourceArchive,
} from './publish-win-assets.js';
import * as ci from './ci-win-app.mjs';
import { installerFileName } from '../desktop/lib/win-pack.mjs';
import { MINGIT, MINGIT_SOURCE, thirdPartyNotices } from '../desktop/lib/fetch-mingit.mjs';
import { resolveInstallerRelease } from '../desktop/lib/update-release.js';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CLI = path.join(__dirname, 'publish-dmg-assets.js');
const WIN_CLI = path.join(__dirname, 'publish-win-assets.js');
const CI_CLI = path.join(__dirname, 'ci-win-app.mjs');
// The REAL route module (the picker and installerAssetsFor). Isolated first:
// importing it resolves user-data paths.
process.env.CURATOR_TEST_USER_DATA_DIR = process.env.CURATOR_TEST_USER_DATA_DIR || mkdtempSync(path.join(tmpdir(), 'curator-publish-ud-'));
process.env.CURATOR_TEST_DOMAINS_DIR = process.env.CURATOR_TEST_DOMAINS_DIR || path.join(process.env.CURATOR_TEST_USER_DATA_DIR, 'domains');
const cfgMod = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'routes', 'config.js')).href);
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
function throwsMsg(fn) { try { fn(); return null; } catch (e) { return e.message || 'threw'; } }

/** A gzip'd tar in GitHub's archive shape: a pax global header carrying the
 *  commit, then every file under `top/`. ustar headers with real checksums. */
function makeTarGz(top, files, commit) {
  const header = (name, size, type) => {
    const h = Buffer.alloc(512, 0);
    h.write(name.slice(0, 100), 0, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.fill(0x20, 148, 156);
    h.write(type, 156);
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512, 0)]);
  const parts = [];
  const rec = `comment=${commit}\n`;
  const paxBody = Buffer.from(`${rec.length + 3 + String(rec.length + 3).length - 1} ${rec}`.replace(/^\d+/, (n) => String(Buffer.byteLength(`${n} ${rec}`))));
  parts.push(header('pax_global_header', paxBody.length, 'g'), pad(paxBody));
  parts.push(header(`${top}/`, 0, '5'));
  for (const [n, data] of files) {
    const b = Buffer.from(data);
    parts.push(header(`${top}/${n}`, b.length, '0'), pad(b));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts));
}

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

// ═══════════════════════════════════════════════════════════════════════════
section('§5  The Windows setup program: publish-win-assets.js against the updater\'s own matchers');
// ═══════════════════════════════════════════════════════════════════════════
{
  const WV = '3.100.0';
  const SETUP = installerFileName(WV);
  eq(SETUP, `TheCurator-${WV}-x64-Windows-Setup.exe`, 'the published name comes from win-pack.mjs installerFileName (the one definition)');
  eq(archFromAssetName(SETUP, { ext: '.exe' }), 'x64', 'the REAL archFromAssetName(name, {ext:".exe"}) resolves it to x64');
  eq(archFromAssetName(SETUP), null, 'CONTROL: without ext it is not a Mac asset (null), so a Mac never downloads it');

  // electron-builder also leaves these beside the setup; they are not published.
  const NORMAL = [SETUP, 'win-unpacked', 'builder-debug.yml', 'builder-effective-config.yaml'];
  const good = planWinPublish(NORMAL, WV, { installerAssetsFor: cfgMod.installerAssetsFor });
  eq([good.ok, good.setup, good.arch], [true, SETUP, 'x64'], 'a normal output folder plans cleanly, checked against config.js installerAssetsFor');
  const refusals = [
    [[], WV, 'missing-setup', 'an empty folder'],
    [[installerFileName('3.99.3')], WV, 'unrecognised-exe', 'a setup of ANOTHER version'],
    [[SETUP, 'The Curator Setup 3.100.0.exe'], WV, 'unrecognised-exe', 'a second .exe (electron-builder\'s default name)'],
    [[SETUP, `${SETUP}.blockmap`], WV, 'blockmap-present', 'a .blockmap (nothing reads it; the app has no electron-updater)'],
    [[SETUP, 'latest.yml'], WV, 'update-feed-present', 'a latest.yml update feed'],
    [[SETUP], `v${WV}`, 'bad-version', 'a version with its v'],
    [[SETUP], '3.100.0-beta.1', 'bad-version', 'a pre-release version (the project ships plain X.Y.Z)'],
  ];
  for (const [names, ver, reason, what] of refusals) {
    eq(planWinPublish(names, ver).reason, reason, `REFUSED: ${what} → ${reason}`);
  }
  eq(planWinPublish([SETUP], WV, { installerAssetsFor: () => [] }).reason, 'not-a-windows-installer',
    'a picker that would not count the setup as a Windows installer is refused (the check reaches the consumer)');
  eq(planWinPublish([SETUP], WV, { installerAssetsFor: (r) => r.assets }).reason, 'counted-as-mac-installer',
    'a picker that would offer the setup to a Mac is refused');
  ok(WIN_PUBLISH_REFUSALS.includes('blockmap-present') && WIN_PUBLISH_REFUSALS.length >= 8, 'the refusals are named in one list');

  // The CLI, for real, on real files.
  const dir = tmp();
  for (const n of NORMAL) {
    if (n === 'win-unpacked') mkdirSync(path.join(dir, n));
    else writeFileSync(path.join(dir, n), 'x');
  }
  const outFile = path.join(dir, 'gh-output');
  writeFileSync(outFile, '');
  const r = spawnSync(process.execPath, [WIN_CLI, '--dir', dir, '--version', WV, '--check-consumers'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outFile },
  });
  eq(r.status, 0, 'the CLI exits 0 on a normal folder, with --check-consumers (it imports the real config.js)');
  ok(readFileSync(outFile, 'utf8').includes(`setup=${path.join(dir, SETUP)}`), 'GITHUB_OUTPUT carries setup=<path>, so later steps never glob');
  writeFileSync(path.join(dir, `${SETUP}.blockmap`), 'x');
  const bad = spawnSync(process.execPath, [WIN_CLI, '--dir', dir, '--version', WV], { encoding: 'utf8' });
  ok(bad.status === 1 && /blockmap-present/.test(bad.stderr), 'a refusal exits 1 and names itself, so the job fails before publishing');
  ok(parseWinPublishArgs(['--dir', 'x']).error && parseWinPublishArgs(['--version', WV]).error, 'the setup mode needs --dir and --version');
  ok(parseWinPublishArgs(['--dir', 'x', '--version', WV, '--wat']).error, 'an unrecognised flag is a hard error');
  ok(parseWinPublishArgs(['--source']).error && !parseWinPublishArgs(['--source', '--out', 'o']).error, 'the source mode needs --out');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  The GPLv2 source of the bundled MinGit: named by the notices, verified before upload');
// ═══════════════════════════════════════════════════════════════════════════
{
  eq([MINGIT_SOURCE.asset, MINGIT_SOURCE.topDir], ['git-for-windows-2.56.1.windows.1-source.tar.gz', 'git-2.56.1.windows.1'],
    'the source file name and its top folder are derived from the pinned tag');
  eq(MINGIT_SOURCE.url, `https://github.com/git-for-windows/git/archive/refs/tags/${MINGIT.tag}.tar.gz`, 'it is GitHub\'s archive of exactly the pinned tag');
  const shipped = thirdPartyNotices({ components: ['git 2.56.1.windows.1'] });
  ok(noticesNameSource(shipped), 'the THIRD-PARTY-NOTICES.txt the build ships names that file (so a person can find it on the release)');
  ok(!noticesNameSource(shipped.replace(MINGIT_SOURCE.asset, 'source.tar.gz')), 'CONTROL: notices that do not name it are caught');

  // A synthetic GitHub archive: pax global header with the commit, entries under the top folder.
  const COMMIT = 'a'.repeat(40);
  const files = [['GIT-VERSION-GEN', 'v'], ['COPYING', 'GPL'], ...Array.from({ length: 120 }, (_, i) => [`builtin/f${i}.c`, `int f${i};`])];
  const good = makeTarGz(MINGIT_SOURCE.topDir, files, COMMIT);
  const v = verifySourceArchive(good);
  eq([v.ok, v.entries, v.commit], [true, files.length + 1, COMMIT], 'the archive check reads the tree and the commit GitHub records');
  eq(verifySourceArchive(Buffer.from('not gzip')).reason, 'not-gzip', 'REFUSED: not gzip');
  eq(verifySourceArchive(makeTarGz('git-2.55.0.windows.1', files, COMMIT)).reason, 'wrong-tree', 'REFUSED: another tag\'s tree');
  eq(verifySourceArchive(makeTarGz(MINGIT_SOURCE.topDir, files.filter(([n]) => n !== 'COPYING'), COMMIT)).reason, 'not-git-source', 'REFUSED: no COPYING');
  eq(verifySourceArchive(makeTarGz(MINGIT_SOURCE.topDir, files.slice(0, 10), COMMIT)).reason, 'too-few-entries', 'REFUSED: a handful of files');

  const notices = path.join(tmp(), 'THIRD-PARTY-NOTICES.txt');
  writeFileSync(notices, shipped);
  let fetched = [];
  const fakeFetch = (body, status = 200) => async (url) => { fetched.push(url); return new Response(body, { status }); };
  const out = tmp();
  const r = await fetchSourceArchive({ out, notices, fetchImpl: fakeFetch(good), log: () => {} });
  eq([r.ok, r.source, r.commit], [true, path.join(out, MINGIT_SOURCE.asset), COMMIT], 'fetchSourceArchive: downloaded, verified, saved under the notices\' name');
  eq(fetched, [MINGIT_SOURCE.url], '…from exactly the pinned tag\'s archive URL');
  const wrongNotices = path.join(tmp(), 'n.txt');
  writeFileSync(wrongNotices, 'MinGit 2.56.1 without a file name');
  fetched = [];
  eq((await fetchSourceArchive({ out: tmp(), notices: wrongNotices, fetchImpl: fakeFetch(good), log: () => {} })).reason,
    'notices-do-not-name-source', 'notices that do not name the file: refused BEFORE any download');
  eq(fetched, [], '…nothing was fetched');
  const out404 = tmp();
  eq((await fetchSourceArchive({ out: out404, fetchImpl: fakeFetch('nope', 404), log: () => {} })).reason, 'download-failed', 'a 404 is download-failed');
  const outBad = tmp();
  eq((await fetchSourceArchive({ out: outBad, fetchImpl: fakeFetch(makeTarGz('elsewhere', files, COMMIT)), log: () => {} })).reason,
    'wrong-tree', 'a downloaded archive of the wrong tree is refused');
  eq(readdirSync(outBad), [], '…and nothing (not even a .partial) is left to be uploaded');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  The update rehearsal\'s fixture is accepted by the REAL resolver; its fetch reaches nothing else');
// ═══════════════════════════════════════════════════════════════════════════
{
  eq([ci.nextPatchVersion('3.99.3'), ci.nextPatchVersion('3.99.10'), ci.nextPatchVersion('v3.99.3'), ci.nextPatchVersion('3.99.3-beta.1')],
    ['3.99.4', '3.99.11', null, null], 'nextPatchVersion: plain X.Y.Z only');
  const rootText = readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  const stamped = ci.stampVersionText(rootText, '9.9.9');
  eq(JSON.parse(stamped).version, '9.9.9', 'stampVersionText sets the version');
  const diffLines = rootText.split('\n').filter((l, i) => l !== stamped.split('\n')[i]);
  eq(diffLines.length, 1, '…and changes exactly one line of the real root package.json');
  ok(throwsMsg(() => ci.stampVersionText(rootText, '9.9.9-rc1')), 'it refuses a non-plain version');

  const N = '3.100.0', N1 = '3.100.1';
  const assetName = installerFileName(N1);
  const sha = 'b'.repeat(64);
  const payload = ci.fixtureReleases({ version: N1, assetName, size: 123456, sha256: sha });
  const served = [];
  const underlying = async (url) => { served.push(url); return new Response(JSON.stringify(payload), { status: 200 }); };
  const calls = [];
  const fx = ci.makeFixtureFetch({ releasesApiUrl: cfgMod.RELEASES_API_URL, base: 'http://127.0.0.1:9', fetchImpl: underlying, onCall: (u, t) => calls.push([u, t]) });
  const rel = await resolveInstallerRelease({ configModule: cfgMod, fetchImpl: fx, currentVersion: N, arch: 'x64', platform: 'win32' });
  eq([rel.ok, rel.version, rel.asset && rel.asset.name, rel.asset && rel.asset.size, rel.asset && rel.asset.digest && rel.asset.digest.hex],
    [true, N1, assetName, 123456, sha], 'the REAL resolveInstallerRelease + config.js picker take the fixture: N+1, the setup, its size and SHA-256');
  ok(rel.asset && /^https:\/\/github\.com\/talirezun\/the-curator\/releases\/download\//.test(rel.asset.url),
    '…with the real https://github.com download URL, so update-plan.js\'s host rule runs unchanged');
  eq(served, ['http://127.0.0.1:9/releases'], 'the releases API call went to the local fixture, not GitHub');
  const mac = await resolveInstallerRelease({ configModule: cfgMod, fetchImpl: fx, currentVersion: N, arch: 'x64', platform: 'darwin' });
  eq(mac.reason, 'no-installable-release', 'CROSS-CHECK: the same fixture offers a Mac nothing (no .dmg), so the platform really decides');
  const same = await resolveInstallerRelease({ configModule: cfgMod, fetchImpl: fx, currentVersion: N1, arch: 'x64', platform: 'win32' });
  eq(same.reason, 'no-update', 'CONTROL: an app already on N+1 is told there is no update');
  eq(await fx(`${ci.REPO_RELEASES_DOWNLOAD}v${N1}/${assetName}`).then(() => served.at(-1)), `http://127.0.0.1:9/download/v${N1}/${assetName}`,
    'a download URL of this repository is served by the fixture');
  for (const u of ['https://api.github.com/repos/someone/else/releases', 'https://github.com/other/repo/releases/download/v1/x.exe', 'https://example.com/']) {
    let threw = false;
    try { await fx(u); } catch { threw = true; }
    ok(threw, `the fixture fetch REFUSES ${u} (nothing in a rehearsal reaches the real network)`);
  }

  // Instance records and the data snapshot comparison.
  const inst = tmp();
  mkdirSync(path.join(inst, 'abcd'), { recursive: true });
  writeFileSync(path.join(inst, 'abcd', '4242.json'), JSON.stringify({ pid: 4242, port: 51234, version: N1 }));
  writeFileSync(path.join(inst, 'abcd', '99.json.tmp'), '{');
  writeFileSync(path.join(inst, 'abcd', '77.json'), '{ half');
  eq(ci.readInstanceRecords(inst), [{ pid: 4242, port: 51234, version: N1 }], 'readInstanceRecords: whole records only');
  eq(ci.readInstanceRecords(path.join(inst, 'none')), [], 'a missing registry is no records, not a crash');
  eq(ci.snapshotDiff({ a: '1', b: '2', c: '3' }, { a: '1', b: 'X', d: '4' }), { changed: ['b'], missing: ['c'], added: ['d'] }, 'snapshotDiff names changed, missing and added files');
  ok(ci.parseArgs(['rehearse-update', '--from', 'a']).error, 'the CLI refuses a rehearsal without every argument');
  ok(ci.parseArgs(['git-checks']).error && !ci.parseArgs(['git-checks', '--mingit', 'x']).error, 'git-checks needs exactly one source');

  // The copy the launch check starts the app from (run 44756919210: cpSync put
  // it under a mangled folder name and the launch crashed with spawn ENOENT).
  {
    const top = tmp();
    const src = path.join(top, 'win-unpacked');
    mkdirSync(path.join(src, 'resources', 'app', 'izvor é'), { recursive: true });
    writeFileSync(path.join(src, ci.EXE_NAME), 'MZ');
    writeFileSync(path.join(src, 'resources', 'app', 'izvor é', 'Žiga.txt'), 'Ž');
    mkdirSync(path.join(src, 'empty'));
    const dest = path.join(top, 'out', 'Programs Ž é', ci.PRODUCT);
    const n = ci.copyTree(src, dest);
    eq([n, ci.countFiles(dest), ci.countFiles(src)], [2, 2, 2], 'copyTree copies every file (2), and countFiles agrees on both sides');
    ok(existsSync(path.join(dest, ci.EXE_NAME)) && readFileSync(path.join(dest, 'resources', 'app', 'izvor é', 'Žiga.txt'), 'utf8') === 'Ž' && existsSync(path.join(dest, 'empty')),
      '…to EXACTLY the asked path, non-ASCII and spaces included, bytes kept, empty folders too');
    eq(readdirSync(path.join(top, 'out')), ['Programs Ž é'], '…and nowhere else (no second, mangled folder beside it)');
    const desc = ci.describeTree(path.join(top, 'out'), 2);
    ok(desc.includes('Programs Ž é\\') && desc.includes('U+17D') && desc.includes('U+E9') && !/The Curator\\\s+\[/.test(desc),
      'describeTree lists what a folder holds, with code points for a non-ASCII name only (so mojibake shows as such)');
    ok(/cannot read: ENOENT/.test(ci.describeTree(path.join(top, 'nope'))), '…and says so for a folder that does not exist, never throws');
    symlinkSync(path.join(src, ci.EXE_NAME), path.join(src, 'link.exe'));
    ok(/symbolic link/.test(throwsMsg(() => ci.copyTree(src, path.join(top, 'out2'))) || ''), 'copyTree refuses a symbolic link rather than following it');
    // The guard against the Node bug can only fire on Windows, so this one is
    // structural, and says why: a cpSync back in the CI script is red here.
    ok(!/\bcpSync\b/.test(readFileSync(CI_CLI, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')), 'ci-win-app.mjs calls no fs.cpSync (Node 22 on Windows mangles a non-ASCII destination; see copyTree)');

    // A failed spawn is a failed check, never an unhandled 'error' crash.
    const child = spawn(path.join(top, 'out', 'Programs Ž é', 'missing.exe'), [], { stdio: 'ignore' });
    const seen = [];
    const getErr = ci.catchSpawnError(child, (e) => seen.push(e.code));
    await new Promise((r) => child.on('close', r).on('error', () => setTimeout(r, 50)));
    eq([getErr() && getErr().code, seen], ['ENOENT', ['ENOENT']], 'catchSpawnError catches the spawn ENOENT (this process did not crash) and reports it once');
    ok(/^ENOENT: spawn .*missing\.exe ENOENT$/.test(ci.spawnErrorText(getErr())), `spawnErrorText names the code and the path (${ci.spawnErrorText(getErr())})`);
  }

  if (process.platform !== 'win32') {
    const r = spawnSync(process.execPath, [CI_CLI, 'install-smoke', '--setup', 'x.exe', '--version', N], { encoding: 'utf8' });
    ok(r.status === 2 && /Windows only/.test(r.stderr), 'off Windows the Windows subcommands refuse to start (nothing is installed on a Mac)');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  The Windows jobs — PARSED, and the gate\'s release test EXECUTED');
// ═══════════════════════════════════════════════════════════════════════════
{
  const doc = (() => { try { return parseYaml(readFileSync(DMG_WORKFLOW, 'utf8')); } catch { return { jobs: {} }; } })();
  const J = doc.jobs || {};
  const asList = (v) => (Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []));
  eq(Object.keys(J), ['gate', 'dmg', 'windows', 'windows-update', 'publish-windows'], 'the jobs are gate, dmg, and the three Windows jobs');

  // THE ORDERING RULE: Windows waits for the Mac; the Mac never waits for Windows.
  eq(asList(J.dmg && J.dmg.needs), ['gate'], 'the Mac job needs ONLY the gate — never a Windows job, so a Windows failure cannot stop the Mac release');
  ok(!/windows/.test(JSON.stringify(J.dmg || {}).replace(/windows-latest/g, '')), '…and nothing in the Mac job mentions a Windows job');
  eq(asList(J.windows && J.windows.needs), ['gate'], 'the Windows build needs only the gate (it runs beside the Mac build)');
  eq(asList(J['windows-update'] && J['windows-update'].needs), ['gate', 'windows'], 'the update rehearsal needs the Windows build');
  const pubNeeds = asList(J['publish-windows'] && J['publish-windows'].needs);
  ok(['dmg', 'windows', 'windows-update', 'gate'].every((n) => pubNeeds.includes(n)), `publish-windows needs dmg, windows, windows-update and gate (${pubNeeds.join(', ')})`);
  const pubIf = String((J['publish-windows'] || {}).if || '');
  ok(/^always\(\)/.test(pubIf), 'publish-windows runs after the Mac job WHATEVER its result (always()), so the two never race and a Mac failure does not block Windows');
  ok(pubIf.includes("needs.gate.outputs.release == 'true'"), 'publish-windows runs on a RELEASE tag only');
  ok(pubIf.includes("needs.windows.result == 'success'") && pubIf.includes("needs.windows-update.result == 'success'"),
    'publish-windows needs BOTH Windows jobs green');
  ok(!/needs\.dmg\.result/.test(pubIf), 'publish-windows never conditions on the Mac job\'s result');
  ok(String((J.dmg || {}).if || '').includes("needs.gate.outputs.release == 'true'"), 'the Mac job builds and publishes on a RELEASE tag only (a rehearsal tag publishes nothing)');

  // Permissions: write only where a release is created.
  const writers = Object.entries(J).filter(([, j]) => j && j.permissions && j.permissions.contents === 'write').map(([k]) => k);
  eq(writers, ['dmg', 'publish-windows'], 'exactly dmg and publish-windows hold contents: write');
  eq([J.windows && J.windows.permissions, J['windows-update'] && J['windows-update'].permissions], [undefined, undefined],
    'the Windows build and rehearsal keep the read-only default');
  eq([J.windows && J.windows['runs-on'], J['windows-update'] && J['windows-update']['runs-on'], J['publish-windows'] && J['publish-windows']['runs-on']],
    ['windows-latest', 'windows-latest', 'ubuntu-latest'], 'runners: Windows to build and test, Linux to publish');

  // The build job's steps, in order.
  const steps = (J.windows && J.windows.steps) || [];
  const at = (list, pred) => list.findIndex(pred);
  const iFetch = at(steps, (s) => /lib\/fetch-mingit\.mjs/.test(s.run || ''));
  const iBuild = at(steps, (s) => /electron-builder --win/.test(s.run || ''));
  const iNames = at(steps, (s) => s.id === 'names');
  const iCheck = at(steps, (s) => /ci-win-app\.mjs check-build/.test(s.run || ''));
  const iSmoke = at(steps, (s) => /ci-win-app\.mjs install-smoke/.test(s.run || ''));
  const iUp = at(steps, (s) => /upload-artifact/.test(s.uses || ''));
  ok([iFetch, iBuild, iNames, iCheck, iSmoke, iUp].every((i) => i >= 0), 'the build job fetches MinGit, builds, names, checks, smoke-installs and uploads');
  ok(iFetch < iBuild && iBuild < iNames && iNames < iCheck && iCheck < iSmoke && iSmoke < iUp, '…in that order');
  // The owner downloads the installer of a RED run to try it by hand: the
  // upload must not depend on the checks passing, only on a setup existing.
  const upIf = String((steps[iUp] || {}).if || '');
  ok(/!cancelled\(\)/.test(upIf) && /steps\.names\.outputs\.setup != ''/.test(upIf) && !/success\(\)/.test(upIf),
    `the upload runs even when a check FAILED, whenever the name check found a setup (if: ${upIf || 'none'})`);
  // …and that never ships an unchecked build: both consumers need this job GREEN.
  const updIf = String((J['windows-update'] || {}).if || '');
  ok(!/always\(\)|failure\(\)|cancelled\(\)/.test(updIf), `the update rehearsal keeps the implicit success() on the build job (if: ${updIf})`);
  const build = steps[iBuild] || {};
  ok(/--config\.extraMetadata\.version=\$env:VERSION/.test(build.run || '') && /--publish never/.test(build.run || '') && /--config electron-builder\.yml/.test(build.run || ''),
    'the build is electron-builder --win with the version from the gate, --publish never (E\'s command)');
  eq(build.env && build.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false', 'no signing identity can be auto-discovered');
  ok(/publish-win-assets\.js --dir desktop\/dist --version \$env:VERSION --check-consumers/.test((steps[iNames] || {}).run || ''),
    'the name check runs against the real config.js picker (--check-consumers)');
  for (const i of [iCheck, iSmoke]) ok(((steps[i] || {}).run || '').includes('steps.names.outputs.setup'), `${(steps[i] || {}).name}: uses the path the name check emitted, never a glob`);
  eq(J.windows && J.windows.env && J.windows.env.VERSION, '${{ needs.gate.outputs.version }}', 'the version is the gate\'s');

  // The MinGit cache: the pin's own file and hash, everywhere it appears.
  const testDoc = parseYaml(readFileSync(TEST_WORKFLOW, 'utf8'));
  const caches = [...Object.values(J), testDoc.jobs.windows].flatMap((j) => ((j && j.steps) || []).filter((s) => /actions\/cache/.test(s.uses || '')));
  ok(caches.length === 3, `three MinGit cache steps (two desktop jobs, test.yml) — found ${caches.length}`);
  ok(caches.every((s) => s.with && s.with.path === `desktop/vendor/${MINGIT.asset}` && s.with.key === `mingit-${MINGIT.sha256}`),
    'every cache step names the pinned archive and its SHA-256 (drift from fetch-mingit.mjs MINGIT goes red here)');

  // The rehearsal job.
  const us = (J['windows-update'] && J['windows-update'].steps) || [];
  const iDl = at(us, (s) => /download-artifact/.test(s.uses || ''));
  const iStamp = at(us, (s) => /stamp-version/.test(s.run || ''));
  const iBuild1 = at(us, (s) => /electron-builder --win/.test(s.run || ''));
  const iRe = at(us, (s) => /ci-win-app\.mjs rehearse-update/.test(s.run || ''));
  ok(iDl >= 0 && iDl < iStamp && iStamp < iBuild1 && iBuild1 < iRe, 'rehearsal: download N, stamp N+1, build N+1, then rehearse');
  eq((us[iDl] || {}).with && us[iDl].with.name, (steps[iUp] || {}).with && steps[iUp].with.name, 'it downloads exactly the artifact the build job uploaded');
  ok(/steps\.next\.outputs\.next/.test((us[iBuild1] || {}).run || '') && /--to-version \$\{\{ steps\.next\.outputs\.next \}\}/.test((us[iRe] || {}).run || ''),
    'the N+1 build and the rehearsal use the stamped version');

  // The publish job.
  const ps = (J['publish-windows'] && J['publish-windows'].steps) || [];
  const iPNames = at(ps, (s) => s.id === 'names');
  const iSrc = at(ps, (s) => s.id === 'source');
  const iPub = at(ps, (s) => /gh release/.test(s.run || ''));
  ok(iPNames >= 0 && iPNames < iSrc && iSrc < iPub, 'publish: check the name, fetch and verify the source, then publish');
  ok(/--notices win-release\/win-unpacked\/resources\/THIRD-PARTY-NOTICES\.txt/.test((ps[iSrc] || {}).run || ''),
    'the source step checks the notices file the build SHIPPED (it travels in the artifact)');
  const upPaths = String(((steps[iUp] || {}).with || {}).path || '');
  ok(upPaths.includes('desktop/dist/win-unpacked/resources/THIRD-PARTY-NOTICES.txt'), '…and the build job does upload that file');
  const pub = ps[iPub] || {};
  const pubRun = pub.run || '';
  ok(/--verify-tag/.test(pubRun) && /gh release upload "\$TAG" "\$SETUP" "\$SOURCE" --clobber/.test(pubRun) && /gh release create "\$TAG" "\$SETUP" "\$SOURCE"/.test(pubRun),
    'publish: create (--verify-tag) or upload --clobber, BOTH the setup and the source, in both arms');
  ok(/gh release view "\$TAG"/.test(pubRun), '…deciding by whether the release already exists (the Mac job usually made it)');
  ok(!/git push|git tag/.test(pubRun), 'it pushes nothing and tags nothing');
  eq([pub.env && pub.env.SETUP, pub.env && pub.env.SOURCE], ['${{ steps.names.outputs.setup }}', '${{ steps.source.outputs.source }}'], 'it attaches the checked paths, by step output');
  ok(pub.env && /github\.token/.test(String(pub.env.GH_TOKEN || '')), 'the automatic GITHUB_TOKEN, never a PAT');

  // THE GATE, EXECUTED: which tags are releases.
  const kind = ((J.gate && J.gate.steps) || []).find((s) => s.id === 'kind');
  ok(!!kind && typeof kind.run === 'string', 'the gate has its release/rehearsal step');
  const bash = ['/bin/bash', '/usr/bin/bash'].find((b) => existsSync(b));
  if (kind && bash) {
    const runGate = (tag) => {
      const d = tmp();
      writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '3.99.3' }));
      const out = path.join(d, 'out'), summ = path.join(d, 'summary');
      writeFileSync(out, ''); writeFileSync(summ, '');
      const r = spawnSync(bash, ['-c', kind.run], {
        cwd: d, encoding: 'utf8',
        env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, GITHUB_REF_NAME: tag, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summ },
      });
      const o = Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('=')));
      return { status: r.status, ...o };
    };
    const cases = [
      ['v3.100.0', 'true', '3.100.0'],
      ['v10.0.12', 'true', '10.0.12'],
      ['v3.99.3-wintest.1', 'false', '3.99.3'],
      ['v3.99.3-rc1', 'false', '3.99.3'],
      ['vwintest-1', 'false', '3.99.3'],
      ['v3.99', 'false', '3.99.3'],
      ['v3.99.3.1', 'false', '3.99.3'],
      ['v3.99.3\nv1.0.0', 'false', '3.99.3'],
    ];
    for (const [tag, release, version] of cases) {
      const g = runGate(tag);
      eq([g.status, g.release, g.version], [0, release, version],
        `gate on ${JSON.stringify(tag)}: ${release === 'true' ? 'RELEASE, version from the tag' : 'REHEARSAL, nothing published, package.json\'s version'}`);
    }
  } else {
    console.log('  ⊘ the gate script was not executed (no bash here)');
  }

  // test.yml's windows job: the suites whose real-Windows sections only run there.
  const tw = testDoc.jobs.windows || {};
  const twSteps = tw.steps || [];
  const runs = twSteps.map((s) => s.run || '');
  for (const suite of ['test-mcp-install-windows.js', 'test-win-folder-access.js', 'test-desktop-update-win32.js', 'test-desktop-shell-win32.js', 'test-paths-win32.js', 'test-subprocess-env.js']) {
    ok(runs.some((r) => r.trim() === `node scripts/${suite}`), `test.yml windows job runs ${suite}`);
  }
  const helper = twSteps.find((s) => /test-desktop-update-win32/.test(s.run || ''));
  eq(helper && helper.env && helper.env.CURATOR_REQUIRE_WIN_HELPER, '1', '…the update suite with CURATOR_REQUIRE_WIN_HELPER=1');
  const mcp = twSteps.find((s) => /test-mcp-install-windows/.test(s.run || ''));
  eq(mcp && mcp.env && mcp.env.CURATOR_REQUIRE_ELECTRON, '1', '…the MCP suite still with CURATOR_REQUIRE_ELECTRON=1 (its §7 real handshake)');
  const iGitFetch = at(twSteps, (s) => /fetch-mingit\.mjs/.test(s.run || ''));
  const iGit = at(twSteps, (s) => /ci-win-app\.mjs git-checks --mingit desktop\/vendor\/mingit\/git/.test(s.run || ''));
  ok(iGitFetch >= 0 && iGitFetch < iGit, '…the bundled-git checks, after the pinned MinGit is fetched and verified');
  const co = twSteps.find((s) => /actions\/checkout/.test(s.uses || ''));
  eq(co && co.with && co.with['fetch-depth'], 0, '…with full history (the suites compare against fixed baseline commits)');
  ok(tw.if === undefined && twSteps.every((s) => s['continue-on-error'] === undefined), 'the windows job still GATES a release: no if:, no continue-on-error');
  eq(tw.name, 'Windows installer tests', 'its name is unchanged (release.js classifies jobs by name)');

  // Package L: install.ps1's (browser) names beside the Windows app, faked by its HKCU key.
  const wi = (testDoc.jobs['windows-install'] || {}).steps || [];
  const iL = at(wi, (s) => /80ccaaf9-11be-57fd-99fb-d73402b182f5/.test(s.run || '') && /\(browser\)\.lnk/.test(s.run || ''));
  const iClean = at(wi, (s) => s.if === 'always()' && /Remove-Item -LiteralPath \$key/.test(s.run || ''));
  ok(iL >= 0 && /Rerun/.test(wi[iL].run) && /Hash \$appLnk/.test(wi[iL].run), 'windows-install: the (browser) names step re-runs install.ps1 with the app key present and hashes the app\'s shortcut');
  ok(iL >= 0 && iClean > iL, '…and an always() step removes the fake app key afterwards');
  eq(wi.length && JSON.stringify(wi).includes('80ccaaf9-11be-57fd-99fb-d73402b182f5'), true, '…using the app\'s real uninstall key (win-pack.mjs NSIS_GUID)');
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
