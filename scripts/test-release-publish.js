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
 *   • NO REAL SOURCE PACKAGE WAS DOWNLOADED (§6). The 28 MinGit source
 *     packages and the git archive are checked here against FIXTURES of the
 *     same shape; that each real file has its pinned size, digest and
 *     `<pkgbase>/PKGBUILD` tree is proven only when publish-windows runs on a
 *     real release tag, and fails that job if not. The component table was
 *     checked against Git for Windows' published package-versions list, not
 *     against the list inside the MinGit zip (fetch-mingit refuses the build
 *     if those ever differ).
 *   • THE STABLE-NAME COPIES (§11-§13) are proven against the REAL picker
 *     and resolver and the publish steps' shell is EXECUTED against a fake
 *     `gh`; that GitHub accepts the uploads, that `--notes-file` renders the
 *     body as written, and that /releases/latest/download/<name> serves the
 *     copy are seen only on a real release. On macOS the Windows step runs
 *     under a `mapfile` shim (bash 3.2); the runner's bash has it built in.
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
  SOURCE_REFUSALS, SAFE_ASSET_NAME, noticesMissingSources, fetchAllSources, verifySourceFile, checkReleaseAssets, tarEntryNames,
} from './publish-win-assets.js';
import * as ci from './ci-win-app.mjs';
import { installerFileName } from '../desktop/lib/win-pack.mjs';
import * as fm from '../desktop/lib/fetch-mingit.mjs';
import {
  MINGIT, MINGIT_SOURCE, thirdPartyNotices, RELEASE_SOURCE_ASSETS, MINGIT_COMPONENTS, COPYLEFT_SOURCES, LICENCE_TEXTS,
  PACKAGE_VERSIONS_PROVENANCE, classifyComponents,
} from '../desktop/lib/fetch-mingit.mjs';
import { resolveInstallerRelease } from '../desktop/lib/update-release.js';
import { pickInstallerAsset } from '../desktop/lib/update-plan.js';
import * as dl from './release-downloads.js';
import * as zlib from 'node:zlib';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
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
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** A zip of STORED entries [[name, bytes]] with real CRC-32s (fetch-mingit's reader checks them). */
function storedZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [n, data] of entries) {
    const name = Buffer.from(n);
    const crc = fm.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** A gzip'd tar in GitHub's archive shape: a pax global header carrying the
 *  commit, then every file under `top/`. ustar headers with real checksums. */
function makeTarGz(top, files, commit) {
  const header = (name, size, type) => {
    const h = Buffer.alloc(512, 0);
    let pre = '';
    if (name.length > 100) { const cut = name.lastIndexOf('/', name.length - 2 > 155 ? 155 : name.length - 2); pre = name.slice(0, cut); name = name.slice(cut + 1); }
    h.write(name.slice(0, 100), 0, 'utf8');
    if (pre) h.write(pre, 345, 'utf8');
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
  ok(parseWinPublishArgs(['--sources']).error && parseWinPublishArgs(['--source', '--out', 'o']).error, 'the sources mode needs --out (and the retired single --source flag is refused)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  The source of EVERY copyleft MinGit component: classified, named by the notices, verified before upload, checked on the release');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ── 6a. The component table ───────────────────────────────────────────────
  // The list Git for Windows publishes for this MinGit, byte for byte. Its
  // SHA-256 is the one GitHub records for the asset (pinned in the table's
  // provenance), so this copy cannot drift from upstream unnoticed.
  const PUBLISHED = [
    'gawk 5.4.1-1', 'coreutils 8.32-5', 'diffutils 3.12-1', 'findutils 4.11.0-2', 'gcc-libs 16.2.0-1', 'gmp 6.3.0-2',
    'grep 1~3.0-7', 'heimdal-libs 7.8.0-5', 'libcbor 0.11.0-1', 'libfido2 1.15.0-1', 'libiconv 1.19-1', 'libintl 0.22.5-1',
    'libopenssl 3.5.9-1', 'libpcre 8.45-5', 'libreadline 8.3.006-1', 'libsqlite 3.54.0-1', 'libxcrypt 4.5.2-1',
    'mingw-w64-ucrt-x86_64-brotli 1.2.1-1', 'mingw-w64-ucrt-x86_64-ca-certificates 20260816-3', 'mingw-w64-ucrt-x86_64-cc-libs 16.2.0-6',
    'mingw-w64-ucrt-x86_64-curl-winssl 8.23.0-1', 'mingw-w64-ucrt-x86_64-curl-openssl-alternate 8.23.0-1', 'mingw-w64-ucrt-x86_64-curl-winssl 8.23.0-1',
    'mingw-w64-ucrt-x86_64-docx2txt-rs 0.2.0-1', 'mingw-w64-ucrt-x86_64-expat 2.9.0-1', 'mingw-w64-ucrt-x86_64-gcc-libs 16.2.0-6',
    'mingw-w64-ucrt-x86_64-gettext-runtime 1.0-1', 'mingw-w64-ucrt-x86_64-git 2.56.1.1-1', 'mingw-w64-ucrt-x86_64-git-credential-manager 2.9.1-1',
    'mingw-w64-ucrt-x86_64-git-credential-wincred 2.56.1.1-1', 'mingw-w64-ucrt-x86_64-git-extra 1.1.715.85f886165-1',
    'mingw-w64-ucrt-x86_64-git-for-windows-addons 2.56.1.1-1', 'mingw-w64-ucrt-x86_64-git-gui 2.56.1.1-1', 'mingw-w64-ucrt-x86_64-git-perl 2.56.1.1-1',
    'mingw-w64-ucrt-x86_64-git-send-email 2.56.1.1-1', 'mingw-w64-ucrt-x86_64-git-subtree 2.56.1.1-1', 'mingw-w64-ucrt-x86_64-gitk 2.56.1.1-1',
    'mingw-w64-ucrt-x86_64-libatomic 16.2.0-6', 'mingw-w64-ucrt-x86_64-libffi 3.8.0-1', 'mingw-w64-ucrt-x86_64-libgcc 16.2.0-6',
    'mingw-w64-ucrt-x86_64-libgomp 16.2.0-6', 'mingw-w64-ucrt-x86_64-libiconv 1.19-1', 'mingw-w64-ucrt-x86_64-libidn2 2.3.8-4',
    'mingw-w64-ucrt-x86_64-libpsl 0.21.5-3', 'mingw-w64-ucrt-x86_64-libquadmath 16.2.0-6', 'mingw-w64-ucrt-x86_64-libssh2-wincng 1.11.1-2',
    'mingw-w64-ucrt-x86_64-libssh2-wincng 1.11.1-2', 'mingw-w64-ucrt-x86_64-libstdc++ 16.2.0-6', 'mingw-w64-ucrt-x86_64-libtasn1 4.21.0-1',
    'mingw-w64-ucrt-x86_64-libunistring 1.4.2-1', 'mingw-w64-ucrt-x86_64-libwinpthread 14.0.0.r536.g7ce22f663-1', 'mingw-w64-ucrt-x86_64-nghttp2 1.70.0-1',
    'mingw-w64-ucrt-x86_64-openssl 3.5.9-1', 'mingw-w64-ucrt-x86_64-pcre2 10.49-1', 'mingw-w64-ucrt-x86_64-zlib 1.3.2-3', 'mingw-w64-ucrt-x86_64-zstd 1.5.7-2',
    'mpfr 4.2.2-1', 'msys2-runtime 3.6.10-4', 'ncurses 6.6-2', 'openssh 10.6p1-1', 'openssl 3.5.9-1', 'sed 4.9-1', 'bash 5.3.015-2', 'zlib 1.3.2-1',
    'filesystem 2026.10.17-1', 'dash 0.5.13.5-1', 'rebase 4.5.0-5',
  ];
  const publishedText = PUBLISHED.join('\n') + '\n';
  eq([Buffer.byteLength(publishedText), sha256(publishedText)], [PACKAGE_VERSIONS_PROVENANCE.size, PACKAGE_VERSIONS_PROVENANCE.sha256],
    'the fixture IS Git for Windows\' published package-versions-2.56.1-MinGit.txt (size and SHA-256 GitHub records)');
  const cls = classifyComponents(fm.parsePackageVersions(publishedText));
  eq([cls.ok, cls.unknown, cls.absent], [true, [], []], `every one of its ${new Set(PUBLISHED).size} components has exactly one row in the table, and the table has no row it lacks`);
  eq(classifyComponents([...PUBLISHED, 'mingw-w64-ucrt-x86_64-newthing 1.0-1']).unknown, ['mingw-w64-ucrt-x86_64-newthing 1.0-1'], 'CONTROL: a component nobody classified is caught');
  eq(classifyComponents(PUBLISHED.map((l) => (l === 'sed 4.9-1' ? 'sed 4.10-1' : l))).unknown, ['sed 4.10-1'], 'CONTROL: the same component at ANOTHER version is caught (the source must be of the exact version)');
  eq(classifyComponents(PUBLISHED.filter((l) => l !== 'bash 5.3.015-2')).absent, ['bash 5.3.015-2'], 'CONTROL: a row the archive no longer has is caught');

  // The rule, cross-checked against each row's own licence string (a dumb
  // second reading of the same decision).
  const looksCopyleft = (lic) => /\b(A?GPL|LGPL|MPL)\b|GPL-|MPL-/.test(lic);
  const misfiled = MINGIT_COMPONENTS.filter((c) => (looksCopyleft(c.licence) ? 'copyleft' : 'permissive') !== c.kind && !(c.name.endsWith('-zstd')));
  eq(misfiled.map((c) => c.name), [], 'every row whose licence names GPL, LGPL or MPL is "copyleft"; every other row "permissive" (zstd: dual BSD OR GPL, taken as BSD)');
  const sourceKeys = new Set(COPYLEFT_SOURCES.map((s) => s.key));
  eq(MINGIT_COMPONENTS.filter((c) => c.kind === 'copyleft' && !sourceKeys.has(c.source)).map((c) => c.name), [], 'every copyleft component points at a source package that is attached');
  eq(MINGIT_COMPONENTS.filter((c) => c.kind === 'permissive' && !/^https:\/\/(repo\.msys2\.org|github\.com\/git-for-windows)\//.test(c.source)).map((c) => c.name), [],
    'every permissive component names the address of its exact source package');
  const usedKeys = new Set(MINGIT_COMPONENTS.filter((c) => c.kind === 'copyleft').map((c) => c.source));
  eq(COPYLEFT_SOURCES.filter((s) => !usedKeys.has(s.key)).map((s) => s.key), [], 'and no source package is attached that no component needs');
  for (const lic of ['GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0']) {
    ok(MINGIT_COMPONENTS.some((c) => c.texts.includes(lic)), `the ${lic} text is used by at least one component (and therefore printed)`);
  }
  eq(MINGIT_COMPONENTS.flatMap((c) => c.texts).filter((k) => !LICENCE_TEXTS[k]), [], 'every licence a row names has a pinned full text');
  const textProblems = Object.keys(LICENCE_TEXTS).filter((k) => { try { return fm.readLicenceText(k).length < 400; } catch { return true; } });
  eq(textProblems, [], `all ${Object.keys(LICENCE_TEXTS).length} licence texts read back with their pinned SHA-256 (and are real texts, not stubs)`);
  const td = tmp();
  for (const t of Object.values(LICENCE_TEXTS)) writeFileSync(path.join(td, t.file), readFileSync(path.join(fm.LICENCE_DIR, t.file)));
  writeFileSync(path.join(td, LICENCE_TEXTS.curl.file), readFileSync(path.join(fm.LICENCE_DIR, LICENCE_TEXTS.curl.file), 'utf8').replace('Daniel', 'Someone'));
  ok(/curl\.txt has SHA-256/.test(throwsMsg(() => fm.readLicenceText('curl', { dir: td })) || ''), 'CONTROL: one changed word in a licence text is refused (the notices are never written from an unreviewed text)');
  const crlf = tmp();
  for (const t of Object.values(LICENCE_TEXTS)) writeFileSync(path.join(crlf, t.file), readFileSync(path.join(fm.LICENCE_DIR, t.file), 'utf8').replace(/\n/g, '\r\n'));
  eq(Object.keys(LICENCE_TEXTS).filter((k) => throwsMsg(() => fm.readLicenceText(k, { dir: crlf }))), [],
    'the same texts checked out with CRLF (git on the windows-latest runner) still match their pins');

  // ── 6b. The attachments: names, hosts, pins ───────────────────────────────
  eq(RELEASE_SOURCE_ASSETS.length, COPYLEFT_SOURCES.length + 1, `${RELEASE_SOURCE_ASSETS.length} files: GitHub's archive of the git tag plus one source package per copyleft package base`);
  eq([RELEASE_SOURCE_ASSETS[0].asset, RELEASE_SOURCE_ASSETS[0].kind, MINGIT_SOURCE.topDir], ['git-for-windows-2.56.1.windows.1-source.tar.gz', 'git-tag-archive', 'git-2.56.1.windows.1'],
    'the first is the git archive, its name and top folder derived from the pinned tag');
  eq(MINGIT_SOURCE.url, `https://github.com/git-for-windows/git/archive/refs/tags/${MINGIT.tag}.tar.gz`, '…GitHub\'s archive of exactly the pinned tag');
  const names = RELEASE_SOURCE_ASSETS.map((a) => a.asset);
  eq(names.filter((n) => !SAFE_ASSET_NAME.test(n)), [], 'every attachment name survives GitHub unchanged (letters, digits, . _ + - only; MSYS2\'s "~" becomes "_")');
  eq(names.length, new Set(names.map((n) => n.toLowerCase())).size, 'no two attachments share a name (compared ignoring case)');
  ok(names.includes('grep-1_3.0-7.src.tar.zst') && COPYLEFT_SOURCES.find((s) => s.pkgbase === 'grep').url.endsWith('/grep-1~3.0-7.src.tar.zst'),
    'grep\'s epoch: fetched by its real name, attached as grep-1_3.0-7.src.tar.zst');
  eq(COPYLEFT_SOURCES.filter((s) => !(s.size > 0)).map((s) => s.asset), [], 'every source package has its exact byte size pinned');
  eq(COPYLEFT_SOURCES.filter((s) => /^https:\/\/github\.com\/git-for-windows\//.test(s.url) !== !!s.sha256).map((s) => s.asset), [],
    'a SHA-256 is pinned exactly where the host records one (Git for Windows\' GitHub releases); repo.msys2.org files are pinned by size and tree');
  eq(COPYLEFT_SOURCES.filter((s) => !/^https:\/\/(repo\.msys2\.org\/(msys|mingw)\/sources\/|github\.com\/git-for-windows\/(git|pacman-repo)\/releases\/download\/)/.test(s.url)).map((s) => s.url), [],
    'every source comes from MSYS2\'s source repository or a Git for Windows release, never anywhere else');
  for (const p of ['win32', 'darwin']) {
    eq(cfgMod.installerAssetsFor({ assets: names.map((name) => ({ name })) }, p), [], `the REAL installerAssetsFor(…, '${p}') counts none of them as an installer (an updater never downloads a source file)`);
  }

  // ── 6c. The notices name every one ────────────────────────────────────────
  const shipped = thirdPartyNotices({ components: ['git 2.56.1.windows.1'] });
  eq(noticesMissingSources(shipped), [], 'the THIRD-PARTY-NOTICES.txt the build ships names EVERY attached file');
  ok(noticesNameSource(shipped), '…including the git archive and the MinGit tag');
  eq(noticesMissingSources(shipped.replaceAll('sed-4.9-1.src.tar.zst', 'sed.tar')), ['sed-4.9-1.src.tar.zst'], 'CONTROL: notices that leave one out are caught, by name');
  ok(MINGIT_COMPONENTS.every((c) => shipped.includes(`   ${c.name} ${c.version}\r\n     Licence:  ${c.licence}`)), 'every component is in the notices with its licence');
  ok(Object.keys(LICENCE_TEXTS).every((k) => shipped.includes(LICENCE_TEXTS[k].title)), 'every licence text is printed in full, under its title');
  ok(shipped.includes('GNU GENERAL PUBLIC LICENSE') && shipped.includes('Apache License') && shipped.includes('Version 2.0, January 2004'),
    'CONTROL: the full GPL and Apache texts really are in the file, not only their names');
  ok(!/[^\r]\n/.test(shipped), 'CRLF throughout (Notepad opens it)');

  // ── 6d. fetch-mingit refuses a MinGit whose component list differs ────────
  const pvGood = Buffer.from(publishedText);
  const zipOf = (pv) => storedZip([['cmd/git.exe', Buffer.from('MZ fake git')], ['LICENSE.txt', Buffer.from('GPL v2 text')], ['etc/package-versions.txt', pv]]);
  const runFetch = async (pv, table) => {
    const z = zipOf(pv);
    const f = path.join(tmp(), 'm.zip');
    writeFileSync(f, z);
    const pin = { ...MINGIT, size: z.length, sha256: sha256(z) };
    try { await fm.fetchMinGit({ outDir: tmp(), zipPath: f, pin, table, log: () => {} }); return null; } catch (e) { return e.message; }
  };
  eq(await runFetch(pvGood, MINGIT_COMPONENTS), null, 'fetchMinGit, held to the table, accepts a MinGit whose list is the published one');
  const extra = await runFetch(Buffer.from(publishedText + 'perl 5.40.0-1\n'), MINGIT_COMPONENTS);
  ok(/REFUSED/.test(extra || '') && /not in the table: perl 5\.40\.0-1/.test(extra || ''), 'REFUSED: a MinGit carrying a component nobody classified (named in the message)');
  const fewer = await runFetch(Buffer.from(publishedText.replace('dash 0.5.13.5-1\n', '')), MINGIT_COMPONENTS);
  ok(/REFUSED/.test(fewer || '') && /in the table but not in this MinGit: dash 0\.5\.13\.5-1/.test(fewer || ''), 'REFUSED: a MinGit whose list lacks a row (the notices would describe something else)');
  eq(await runFetch(Buffer.from(publishedText + 'perl 5.40.0-1\n'), null), null, 'CONTROL: a fixture pin is not held to the table unless the caller passes it (the default binds the table to the REAL pin\'s SHA-256)');

  // ── 6e. Each source file is verified, gzip and zstd alike ─────────────────
  const COMMIT = 'a'.repeat(40);
  const gitFiles = [['GIT-VERSION-GEN', 'v'], ['COPYING', 'GPL'], ...Array.from({ length: 120 }, (_, i) => [`builtin/f${i}.c`, `int f${i};`])];
  const gitGood = makeTarGz(MINGIT_SOURCE.topDir, gitFiles, COMMIT);
  const v = verifySourceArchive(gitGood);
  eq([v.ok, v.entries, v.commit], [true, gitFiles.length + 1, COMMIT], 'the git archive check reads the tree and the commit GitHub records');
  eq(verifySourceArchive(Buffer.from('not gzip')).reason, 'not-gzip', 'REFUSED: not gzip');
  eq(verifySourceArchive(makeTarGz('git-2.55.0.windows.1', gitFiles, COMMIT)).reason, 'wrong-tree', 'REFUSED: another tag\'s tree');
  eq(verifySourceArchive(makeTarGz(MINGIT_SOURCE.topDir, gitFiles.filter(([n]) => n !== 'COPYING'), COMMIT)).reason, 'not-git-source', 'REFUSED: no COPYING');
  eq(verifySourceArchive(makeTarGz(MINGIT_SOURCE.topDir, gitFiles.slice(0, 10), COMMIT)).reason, 'too-few-entries', 'REFUSED: a handful of files');
  const tarBytes = (gz) => gunzipSync(gz);
  const bigName = `pkg/${'d'.repeat(60)}/${'f'.repeat(60)}.c`;
  eq(tarEntryNames(tarBytes(makeTarGz('pkg', [[bigName.slice(4), 'x']], COMMIT))).slice(-1), [bigName], 'a name longer than 100 characters is read whole (ustar prefix)');
  ok(/checksum/.test(throwsMsg(() => { const t = Buffer.from(tarBytes(makeTarGz('pkg', [['PKGBUILD', 'x']], COMMIT))); t[1024 + 10] ^= 1; tarEntryNames(t); }) || ''),
    'a damaged tar header is refused on its checksum, not read past');

  const pkg = (base, extraFiles = []) => makeTarGz(base, [['PKGBUILD', 'pkgname=x'], ['.SRCINFO', 'x'], ['x-1.0.tar.gz', 'payload'], ...extraFiles], COMMIT);
  const gzPkg = pkg('mingw-w64-demo');
  const asset = (over) => ({ kind: 'makepkg-source', pkgbase: 'mingw-w64-demo', topDir: 'mingw-w64-demo', upstreamName: 'mingw-w64-demo-1.0-1.src.tar.gz',
    asset: 'mingw-w64-demo-1.0-1.src.tar.gz', url: 'https://example.invalid/mingw-w64-demo-1.0-1.src.tar.gz', size: gzPkg.length, sha256: sha256(gzPkg), ...over });
  const fileWith = (bytes, name = 'f.partial') => { const f = path.join(tmp(), name); writeFileSync(f, bytes); return f; };
  const vf = await verifySourceFile(fileWith(gzPkg), asset());
  eq([vf.ok, vf.size, vf.sha256], [true, gzPkg.length, sha256(gzPkg)], 'a makepkg .src.tar.gz of the pinned size, SHA-256 and tree is accepted');
  eq((await verifySourceFile(fileWith(gzPkg), asset({ size: gzPkg.length + 1 }))).reason, 'wrong-size', 'REFUSED: one byte off the pinned size');
  eq((await verifySourceFile(fileWith(gzPkg), asset({ sha256: '0'.repeat(64) }))).reason, 'wrong-sha256', 'REFUSED: another SHA-256');
  const other = pkg('mingw-w64-other');
  eq((await verifySourceFile(fileWith(other), asset({ size: other.length, sha256: null }))).reason, 'wrong-tree', 'REFUSED: another package\'s source (entries outside <pkgbase>/), with only the size pinned');
  const noPkgbuild = makeTarGz('mingw-w64-demo', [['README', 'x']], COMMIT);
  eq((await verifySourceFile(fileWith(noPkgbuild), asset({ size: noPkgbuild.length, sha256: null }))).reason, 'no-pkgbuild', 'REFUSED: no <pkgbase>/PKGBUILD');
  eq((await verifySourceFile(fileWith(Buffer.from('<html>rate limited</html>')), asset({ size: 25, sha256: null }))).reason, 'not-gzip', 'REFUSED: an HTML error page of the right size is not a source package');
  eq((await verifySourceFile(fileWith(gzPkg), asset({ asset: 'a~b.tar.gz' }))).reason, 'unsafe-asset-name', 'REFUSED: a name GitHub would rewrite');

  // zstd: a stand-in decompressor (this Node may have none), and the refusal when there is none.
  const ZMAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
  const fakeZstd = { ...zlib, createZstdDecompress: () => {
    const parts = [];
    return new Transform({ transform(c, _e, cb) { parts.push(c); cb(); }, flush(cb) { cb(null, gunzipSync(Buffer.concat(parts).subarray(4))); } });
  } };
  const zstPkg = Buffer.concat([ZMAGIC, gzPkg]);
  const zAsset = asset({ upstreamName: 'mingw-w64-demo-1.0-1.src.tar.zst', asset: 'mingw-w64-demo-1.0-1.src.tar.zst', size: zstPkg.length, sha256: null });
  eq((await verifySourceFile(fileWith(zstPkg), zAsset, { z: fakeZstd })).ok, true, 'a .src.tar.zst is read through node:zlib\'s zstd decompressor (stand-in here) and its tree checked');
  const noZstd = { ...zlib, createZstdDecompress: undefined };
  eq((await verifySourceFile(fileWith(zstPkg), zAsset, { z: noZstd })).reason, 'zstd-unavailable', 'REFUSED (not skipped) on a Node without zstd');
  eq((await verifySourceFile(fileWith(gzPkg), zAsset, { z: fakeZstd })).reason, 'wrong-size', 'a gzip file under a .zst name: refused');
  const zAsset2 = { ...zAsset, size: gzPkg.length };
  eq((await verifySourceFile(fileWith(gzPkg), zAsset2, { z: fakeZstd })).reason, 'not-zstd', '…and refused as not zstd when the size happens to match');

  // ── 6f. fetchAllSources: all or nothing, notices first ────────────────────
  const assets3 = [
    { kind: 'git-tag-archive', key: 'git', asset: MINGIT_SOURCE.asset, url: 'https://example.invalid/git.tar.gz', topDir: MINGIT_SOURCE.topDir, size: null, sha256: null },
    asset(),
    { ...zAsset, url: 'https://example.invalid/demo.zst' },
  ];
  const served = { 'https://example.invalid/git.tar.gz': gitGood, [asset().url]: gzPkg, 'https://example.invalid/demo.zst': zstPkg };
  let fetched = [];
  const serve = (over = {}) => async (url) => {
    fetched.push(url);
    if (over[url] instanceof Error) throw over[url];
    const body = over[url] !== undefined ? over[url] : served[url];
    return body === null ? new Response('nope', { status: 404 }) : new Response(body, { status: 200 });
  };
  const noticesFile = path.join(tmp(), 'THIRD-PARTY-NOTICES.txt');
  writeFileSync(noticesFile, assets3.map((a) => a.asset).join('\r\n'));
  const outAll = tmp();
  const all = await fetchAllSources({ out: outAll, notices: noticesFile, fetchImpl: serve(), assets: assets3, log: () => {}, z: fakeZstd });
  eq([all.ok, all.files && all.files.length], [true, 3], 'fetchAllSources: all three downloaded and verified');
  eq(readFileSync(path.join(outAll, 'sources.txt'), 'utf8').trim().split('\n'), assets3.map((a) => path.join(outAll, a.asset)), '…sources.txt lists each verified file, under its attachment name');
  eq(readdirSync(outAll).filter((n) => n.endsWith('.partial')), [], '…and no .partial is left');

  const outFail = tmp();
  const failed1 = await fetchAllSources({ out: outFail, notices: noticesFile, fetchImpl: serve({ [asset().url]: other }), assets: assets3, log: () => {}, z: fakeZstd });
  eq([failed1.ok, failed1.asset], [false, asset().asset], 'ONE wrong file: refused, naming it');
  ok(!existsSync(path.join(outFail, 'sources.txt')), '…and there is no sources.txt, so the publish step has nothing to attach');
  const out404 = tmp();
  const f404 = await fetchAllSources({ out: out404, notices: noticesFile, fetchImpl: serve({ 'https://example.invalid/demo.zst': null }), assets: assets3, log: () => {}, z: fakeZstd });
  eq([f404.reason, f404.asset], ['download-failed', zAsset.asset], 'a source that is gone (404) fails the job, naming it');

  fetched = [];
  let flaky = 0;
  const flakyFetch = async (url, o) => { if (url === asset().url && flaky++ === 0) throw new Error('ECONNRESET'); return serve()(url, o); };
  eq((await fetchAllSources({ out: tmp(), notices: noticesFile, fetchImpl: flakyFetch, assets: assets3, log: () => {}, z: fakeZstd })).ok, true, 'a dropped connection is retried once');

  const thin = path.join(tmp(), 'n.txt');
  writeFileSync(thin, assets3.slice(0, 2).map((a) => a.asset).join('\n'));
  fetched = [];
  const nn = await fetchAllSources({ out: tmp(), notices: thin, fetchImpl: serve(), assets: assets3, log: () => {}, z: fakeZstd });
  eq([nn.reason, fetched], ['notices-do-not-name-source', []], 'notices that leave a file out: refused BEFORE any download');

  // The single-file mode is still exact.
  fetched = [];
  const legacy = await fetchSourceArchive({ out: tmp(), fetchImpl: async (u) => { fetched.push(u); return new Response(gitGood); }, log: () => {} });
  eq([legacy.ok, legacy.commit, fetched], [true, COMMIT, [MINGIT_SOURCE.url]], 'fetchSourceArchive (one file, by hand) fetches exactly the pinned tag\'s archive');

  // ── 6g. The release, afterwards: every file BY EXACT NAME ─────────────────
  const SETUP = installerFileName('4.0.0');
  const setupFile = path.join(outAll, SETUP);
  writeFileSync(setupFile, 'MZ setup');
  const expected = [{ name: SETUP, size: 8, sha256: null }, ...all.files.map((f) => ({ name: f.asset, size: f.size, sha256: f.sha256 }))];
  const release = { assets: expected.map((e) => ({ name: e.name, size: e.size, state: 'uploaded', digest: e.sha256 ? `sha256:${e.sha256}` : null })) };
  eq(checkReleaseAssets(release, expected).ok, true, 'a release with the setup and every source file passes');
  for (const e of expected) {
    const r = checkReleaseAssets({ assets: release.assets.filter((a) => a.name !== e.name) }, expected);
    eq([r.ok, r.reason, r.missing], [false, 'missing-on-release', [e.name]], `REFUSED when ${e.name} is missing from the release`);
  }
  eq(checkReleaseAssets({ assets: release.assets.map((a) => (a.name === expected[2].name ? { ...a, name: a.name.replace('.tar.gz', '.tar.gz.1') } : a)) }, expected).reason,
    'missing-on-release', 'a file GitHub renamed counts as missing (the notices name the exact name)');
  eq(checkReleaseAssets({ assets: release.assets.map((a, i) => (i === 1 ? { ...a, state: 'starter' } : a)) }, expected).reason, 'missing-on-release', 'an upload that never finished counts as missing');
  eq(checkReleaseAssets({ assets: release.assets.map((a, i) => (i === 2 ? { ...a, size: a.size - 1 } : a)) }, expected).reason, 'wrong-size-on-release', 'a short upload is refused');
  eq(checkReleaseAssets({ assets: release.assets.map((a, i) => (i === 2 ? { ...a, digest: `sha256:${'f'.repeat(64)}` } : a)) }, expected).reason, 'wrong-digest-on-release', 'GitHub\'s digest, when it gives one, must be the verified SHA-256');
  eq(checkReleaseAssets({}, expected).reason, 'release-unreadable', 'an unreadable answer is a refusal, not a pass');

  // The CLI, for real, on files: what the workflow runs.
  const relFile = path.join(tmp(), 'release.json');
  const listFile = path.join(outAll, 'sources.txt');
  const runCheck = (rel, list = listFile) => { writeFileSync(relFile, JSON.stringify(rel)); return spawnSync(process.execPath, [WIN_CLI, '--check-release', relFile, '--setup', setupFile, '--sources-list', list], { encoding: 'utf8' }); };
  const realAssets = RELEASE_SOURCE_ASSETS;
  // The CLI checks against the REAL list; serve it a complete fake release of those names.
  const realDir = tmp();
  const realFiles = realAssets.map((a) => { const f = path.join(realDir, a.asset); writeFileSync(f, a.asset); return f; });
  const realList = path.join(realDir, 'sources.txt');
  writeFileSync(realList, realFiles.join('\n') + '\n');
  const realRelease = { assets: [{ name: SETUP, size: 8, state: 'uploaded' }, ...realAssets.map((a) => ({ name: a.asset, size: Buffer.byteLength(a.asset), state: 'uploaded' }))] };
  const okRun = runCheck(realRelease, realList);
  eq(okRun.status, 0, `the CLI --check-release exits 0 when all ${realAssets.length + 1} files are on the release`);
  const drop = realAssets[7].asset;
  const badRun = runCheck({ assets: realRelease.assets.filter((a) => a.name !== drop) }, realList);
  ok(badRun.status === 1 && /missing-on-release/.test(badRun.stderr) && badRun.stderr.includes(drop), `the CLI exits 1 naming the missing file (${drop}), so publish-windows goes red`);
  writeFileSync(realList, realFiles.filter((f) => !f.endsWith(drop)).join('\n') + '\n');
  const shortList = runCheck(realRelease, realList);
  ok(shortList.status === 1 && shortList.stderr.includes(drop), 'a sources list that lost a file is refused too (the release is checked against the PINNED names, not against whatever was downloaded)');
  ok(parseWinPublishArgs(['--sources', '--out', 'o']).error && !parseWinPublishArgs(['--sources', '--out', 'o', '--notices', 'n']).error, 'the sources mode needs --out and --notices');
  ok(parseWinPublishArgs(['--check-release', 'r', '--setup', 's']).error && !parseWinPublishArgs(['--check-release', 'r', '--setup', 's', '--sources-list', 'l']).error, 'the release check needs --setup and --sources-list');
  ok(parseWinPublishArgs(['--sources', '--out', 'o', '--notices', 'n', '--dir', 'd']).error, 'two modes at once is a hard error');
  ok(SOURCE_REFUSALS.includes('missing-on-release') && SOURCE_REFUSALS.includes('zstd-unavailable'), 'the refusals are named in one list');
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
  const iSrc = at(ps, (s) => s.id === 'sources');
  const iPub = at(ps, (s) => /gh release (upload|create)/.test(s.run || ''));
  const iChk = at(ps, (s) => /--check-release/.test(s.run || ''));
  ok(iPNames >= 0 && iPNames < iSrc && iSrc < iPub && iPub < iChk,
    'publish: check the name, fetch and verify EVERY source, publish, then check the release by name (in that order)');
  ok(/publish-win-assets\.js --sources --out /.test((ps[iSrc] || {}).run || '') &&
     /--notices win-release\/win-unpacked\/resources\/THIRD-PARTY-NOTICES\.txt/.test((ps[iSrc] || {}).run || ''),
    'the sources step runs --sources against the notices file the build SHIPPED (it travels in the artifact)');
  const upPaths = String(((steps[iUp] || {}).with || {}).path || '');
  ok(upPaths.includes('desktop/dist/win-unpacked/resources/THIRD-PARTY-NOTICES.txt'), '…and the build job does upload that file');
  const pub = ps[iPub] || {};
  const pubRun = pub.run || '';
  ok(/set -euo pipefail/.test(pubRun) && /mapfile -t SOURCES < "\$SOURCES_LIST"/.test(pubRun), 'publish reads the VERIFIED list (sources.txt), under set -euo pipefail');
  ok(/--verify-tag/.test(pubRun) && /gh release upload "\$TAG" "\$SETUP" "\$\{SOURCES\[@\]\}" --clobber/.test(pubRun) && /gh release create "\$TAG" "\$SETUP" "\$\{SOURCES\[@\]\}"/.test(pubRun),
    'publish: create (--verify-tag) or upload --clobber, the setup AND every source file, in both arms');
  ok(/gh release view "\$TAG"/.test(pubRun), '…deciding by whether the release already exists (the Mac job usually made it)');
  ok(!/git push|git tag/.test(pubRun), 'it pushes nothing and tags nothing');
  eq([pub.env && pub.env.SETUP, pub.env && pub.env.SOURCES_LIST], ['${{ steps.names.outputs.setup }}', '${{ steps.sources.outputs.sources_list }}'], 'it attaches the checked paths, by step output');
  const chk = ps[iChk] || {};
  const chkRun = chk.run || '';
  ok(/gh release view "\$TAG" --json assets > "\$RUNNER_TEMP\/release-assets\.json"/.test(chkRun) &&
     /--check-release "\$RUNNER_TEMP\/release-assets\.json" --setup "\$SETUP" --sources-list "\$SOURCES_LIST"/.test(chkRun),
    'the release check reads the release\'s assets and runs --check-release on the same setup and list');
  ok(/for attempt in 1 2 3 4 5 6/.test(chkRun) && /exit 1\s*$/.test(chkRun) && !/continue-on-error/.test(JSON.stringify(chk)),
    '…re-reading a few times (GitHub is eventually consistent), then FAILING the job; never continue-on-error');
  eq([chk.env && chk.env.SETUP, chk.env && chk.env.SOURCES_LIST], ['${{ steps.names.outputs.setup }}', '${{ steps.sources.outputs.sources_list }}'], '…on exactly the files that were verified and attached');
  ok(!ps.some((st) => st.if) && !ps.some((st) => st['continue-on-error']), 'no step of publish-windows is skippable or allowed to fail');
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
  // Electron 43 has no postinstall (run 44756919186: `npm ci` in desktop/ left no
  // binary, §7 went red). The binary is fetched by its own install.js, in desktop/,
  // after desktop's npm ci and before the MCP suite.
  const iDeskCi = at(twSteps, (s) => s['working-directory'] === 'desktop' && /^npm ci\b/.test((s.run || '').trim()));
  const iElectron = at(twSteps, (s) => s['working-directory'] === 'desktop' && /node node_modules\/electron\/install\.js/.test(s.run || ''));
  const iMcp = at(twSteps, (s) => /test-mcp-install-windows/.test(s.run || ''));
  ok(iDeskCi >= 0 && iElectron > iDeskCi && iElectron < iMcp,
    '…the pinned Electron binary is fetched (desktop/, install.js) after desktop\'s npm ci and before the MCP suite');
  ok(iElectron >= 0 && !twSteps.some((s) => s.env && 'ELECTRON_SKIP_BINARY_DOWNLOAD' in s.env) && !(tw.env && 'ELECTRON_SKIP_BINARY_DOWNLOAD' in tw.env),
    '…and nothing in the windows job skips that download');
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

section('§9  The install smoke\'s Apps & features probe: absent, present, and a PowerShell failure are three different answers');
{
  // v3.99.3-wintest.2: the probe piped an `if` statement into ConvertTo-Json,
  // which Windows PowerShell refuses to parse; the empty stdout read as "no
  // key", so "exists" failed and "is gone" passed for the same wrong reason.
  const GUID = '80ccaaf9-11be-57fd-99fb-d73402b182f5';
  // A minimal PowerShell grammar rule: a top-level statement that STARTS with a
  // keyword statement (if/foreach/for/while/switch/try) may not contain a pipe
  // outside braces and quotes. `if (…) {…} else {…} | X` is a parse error
  // ("An empty pipe element is not allowed"); `$x = @(… | …)` is not.
  function pipedStatements(cmd) {
    const stmts = [];
    let depth = 0, cur = '', q = false;
    for (const ch of cmd) {
      if (q) { cur += ch; if (ch === "'") q = false; continue; }
      if (ch === "'") { q = true; cur += ch; continue; }
      if (ch === '{' || ch === '(') depth++;
      if (ch === '}' || ch === ')') depth--;
      if (ch === ';' && depth === 0) { stmts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    stmts.push(cur);
    return stmts.filter((st) => {
      if (!/^\s*(if|foreach|for|while|switch|try)\b/i.test(st)) return false;
      let d = 0, inQ = false;
      for (const ch of st) {
        if (inQ) { if (ch === "'") inQ = false; continue; }
        if (ch === "'") { inQ = true; continue; }
        if (ch === '{' || ch === '(') d++;
        else if (ch === '}' || ch === ')') d--;
        else if (ch === '|' && d === 0) return true;
      }
      return false;
    });
  }
  const OLD = `$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}'; if (Test-Path -LiteralPath $k) { Get-ItemProperty -LiteralPath $k | Select-Object DisplayName } else { $null } | ConvertTo-Json -Compress -Depth 4`;
  eq(pipedStatements(OLD).length, 1, 'CONTROL: the rule catches the wintest.2 probe (an if/else piped into ConvertTo-Json)');
  eq(pipedStatements('$a = @(Get-ChildItem x | Where-Object { $_ }); ConvertTo-Json -InputObject $a').length, 0, 'CONTROL: …and passes a pipe inside @( ) after an assignment');
  const keyCmd = ci.uninstallKeyCommand(GUID);
  eq(pipedStatements(keyCmd), [], 'the key probe pipes no statement');
  eq(pipedStatements(ci.uninstallListCommand()), [], 'the Uninstall listing pipes no statement');
  ok(keyCmd.includes(`'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}'`) && keyCmd.includes(ci.KEY_ABSENT),
    'the key probe looks at HKCU\\…\\Uninstall\\<NSIS_GUID> and answers a sentinel when it is absent');
  ok(!!throwsMsg(() => ci.uninstallKeyCommand("x'; Remove-Item C:\\ -Recurse; '")), 'the key probe refuses anything but a GUID');

  eq(ci.parseUninstallKeyProbe({ status: 0, stdout: ci.KEY_ABSENT + '\r\n', stderr: '' }), null, 'absent: the sentinel → null');
  eq(ci.parseUninstallKeyProbe({ status: 0, stdout: '{"DisplayName":"The Curator","DisplayVersion":"3.99.3"}', stderr: '' }),
    { DisplayName: 'The Curator', DisplayVersion: '3.99.3' }, 'present: the values');
  const parseErr = 'At line:1 char:200\r\n+ … } else { $null } | ConvertTo-Json …\r\nAn empty pipe element is not allowed.';
  const m1 = throwsMsg(() => ci.parseUninstallKeyProbe({ status: 1, stdout: '', stderr: parseErr }));
  ok(!!m1 && /exited 1/.test(m1) && /At line:1/.test(m1), 'a PowerShell failure THROWS, with its first error line (never reads as "absent")');
  ok(!!throwsMsg(() => ci.parseUninstallKeyProbe({ status: 0, stdout: '', stderr: '' })), 'empty stdout with exit 0 THROWS (never reads as "absent")');
  ok(!!throwsMsg(() => ci.parseUninstallKeyProbe({ status: 0, stdout: 'null', stderr: '' })), '"null" THROWS (never reads as "absent")');

  const one = { Key: GUID, DisplayName: 'The Curator', DisplayVersion: '3.99.3', UninstallString: '"C:\\x\\Uninstall The Curator.exe" /currentuser' };
  eq(ci.parseUninstallList({ status: 0, stdout: '[]', stderr: '' }), [], 'listing: none');
  eq(ci.parseUninstallList({ status: 0, stdout: JSON.stringify(one), stderr: '' }), [one], 'listing: one entry (PowerShell unwraps a one-element array)');
  const stranger = { Key: '{ABC}', DisplayName: 'The Curator Pro (someone else)', DisplayVersion: '1', UninstallString: 'x' };
  const both = ci.parseUninstallList({ status: 0, stdout: JSON.stringify([stranger, one]), stderr: '' });
  eq(both.length, 2, 'listing: several');
  eq(ci.appUninstallKeys(both), [GUID], 'the app\'s own entry is the one whose DisplayName is exactly "The Curator"; a stranger\'s "Curator" entry never matches');
  ok(!!throwsMsg(() => ci.parseUninstallList({ status: 1, stdout: '', stderr: 'boom' })), 'listing: a PowerShell failure THROWS');
}

section('§10  The install smoke waits until the silent uninstall has FINISHED, not until two of its files are gone');
{
  // A fake clock and a scripted uninstall in the order app-builder-lib's
  // uninstaller.nsh runs it: top-level files go early in RMDir /r, the folder
  // later, the uninstall key LAST. Run 44771959833 checked at "files gone".
  let t = 0;
  const now = () => t;
  const sleepFn = async (ms) => { t += ms; };
  const KEY = { DisplayName: 'The Curator' };
  const timeline = { folderGoneAt: 30000, keyGoneAt: 34000 };
  const dirExists = () => t < timeline.folderGoneAt;
  const probeKey = () => (t < timeline.keyGoneAt ? KEY : null);

  eq(ci.uninstallPending({ dirExists: () => true, probeKey: () => KEY }), ['the install folder', 'the HKCU uninstall key'], 'pending: folder and key both named');
  eq(ci.uninstallPending({ dirExists: () => false, probeKey: () => KEY }), ['the HKCU uninstall key'], 'pending: the folder gone is NOT finished while the key (the last act) is there');
  eq(ci.uninstallPending({ dirExists: () => true, probeKey: () => null }), ['the install folder'], 'pending: the key gone is not finished while any of the folder is there');
  eq(ci.uninstallPending({ dirExists: () => false, probeKey: () => null }), [], 'pending: folder and key gone = finished');
  const unreadable = ci.uninstallPending({ dirExists: () => false, probeKey: () => { throw new Error('PowerShell exited 1: boom'); } });
  ok(unreadable.length === 1 && /could not be read: PowerShell exited 1: boom/.test(unreadable[0]), 'pending: a key probe that THROWS is not finished (never read as "absent"), with its error');

  const r = await ci.waitUninstallFinished({ dirExists, probeKey, sleepFn, now, timeoutMs: 240000, everyMs: 1000 });
  eq([r.finished, r.pending, r.waitedMs], [true, [], timeline.keyGoneAt], 'the wait returns only once the key is gone (34 s), not when the folder went (30 s)');

  t = 0;
  const stuck = await ci.waitUninstallFinished({ dirExists: () => false, probeKey: () => KEY, sleepFn, now, timeoutMs: 240000, everyMs: 1000 });
  eq([stuck.finished, stuck.pending, stuck.waitedMs >= 240000 && stuck.waitedMs <= 241000], [false, ['the HKCU uninstall key'], true],
    'a key that never goes (a guard abort, say) times out at 240 s, naming what is still there');
  t = 0;
  const neverRead = await ci.waitUninstallFinished({ dirExists: () => false, probeKey: () => { throw new Error('x'); }, sleepFn, now, timeoutMs: 5000 });
  eq(neverRead.finished, false, 'a key that can never be read times out unfinished');
  t = 0;
  const already = await ci.waitUninstallFinished({ dirExists: () => false, probeKey: () => null, sleepFn, now });
  eq([already.finished, already.waitedMs], [true, 0], 'already finished: returns at once');

  // CROSS-CHECK against the uninstaller's real order (the template this
  // version of app-builder-lib ships): the guard before RMDir /r $INSTDIR,
  // the shortcuts after it, DeleteRegKey of the uninstall key after both.
  const tpl = path.join(ROOT, 'desktop', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'uninstaller.nsh');
  if (existsSync(tpl)) {
    const body = readFileSync(tpl, 'utf8');
    const sec = body.slice(body.indexOf('Section "un.'), body.indexOf('SectionEnd', body.indexOf('Section "un.')));
    const at = (re) => { const m = re.exec(sec); return m ? m.index : -1; };
    const order = [at(/!insertmacro customUnInstall\b/), at(/RMDir \/r \$INSTDIR/), at(/Delete "\$oldDesktopLink"/), at(/Delete "\$oldStartMenuLink"/), at(/DeleteRegKey SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}"/)];
    ok(order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]),
      'CROSS-CHECK: uninstaller.nsh runs the guard, RMDir /r $INSTDIR, the two shortcuts, then the uninstall key LAST', JSON.stringify(order));
  } else {
    console.log('  · (desktop/node_modules not installed here: the uninstaller.nsh order cross-check is skipped)');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11  The stable-name copies are INVISIBLE to the in-app updater — the REAL resolver and picker, darwin arm64, darwin x64, win32 x64');
// ═══════════════════════════════════════════════════════════════════════════
{
  const NEW = '9.1.0', OLD = '9.0.0', CUR = '8.0.0';
  const DL = 'https://github.com/talirezun/the-curator/releases/download/';
  const asset = (tag, name, size, hex) => ({ name, size, digest: `sha256:${hex}`, state: 'uploaded', content_type: 'application/octet-stream', browser_download_url: `${DL}${tag}/${name}` });
  const filesOf = (v) => ({
    'win32-x64': [installerFileName(v), 120000003, '1'.repeat(64)],
    'darwin-arm64': [publishedNameFor(v, 'arm64'), 140000001, '2'.repeat(64)],
    'darwin-x64': [publishedNameFor(v, 'x64'), 140000002, '3'.repeat(64)],
  });
  // The copies go FIRST in the listing: pickInstallerAsset takes the FIRST
  // match, so a copy the matcher accepted would win, and this would see it.
  function release(v, { versioned = true, copies = true, sources = true, only = null } = {}) {
    const tag = `v${v}`;
    const f = filesOf(v);
    const keys = only || dl.INSTALLERS.map((i) => i.key);
    const out = [];
    if (copies) for (const i of dl.INSTALLERS) if (keys.includes(i.key)) out.push(asset(tag, i.stable, f[i.key][1], f[i.key][2]));
    if (versioned) for (const k of keys) out.push(asset(tag, f[k][0], f[k][1], f[k][2]));
    if (sources) out.push(asset(tag, RELEASE_SOURCE_ASSETS[0].asset, 1000, 'c'.repeat(64)));
    return {
      tag_name: tag, name: `The Curator ${tag}`, draft: false, prerelease: false,
      html_url: `https://github.com/talirezun/the-curator/releases/tag/${tag}`, published_at: '2026-11-21T00:00:00Z', assets: out,
    };
  }
  const fetchOf = (payload) => async () => new Response(JSON.stringify(payload), { status: 200 });
  const resolve = (payload, platform, arch) => resolveInstallerRelease({ configModule: cfgMod, fetchImpl: fetchOf(payload), currentVersion: CUR, arch, platform });
  const PLAT = [['darwin', 'arm64', 'darwin-arm64'], ['darwin', 'x64', 'darwin-x64'], ['win32', 'x64', 'win32-x64']];

  for (const name of dl.STABLE_NAMES) {
    eq([archFromAssetName(name), archFromAssetName(name, { ext: '.dmg' }), archFromAssetName(name, { ext: '.exe' })], [null, null, null],
      `the REAL archFromAssetName reads ${name} as no architecture, on either extension`);
    eq(dl.updaterWouldPick(name), null, `…and the real pickInstallerAsset picks it for no arch on either extension`);
  }

  for (const [platform, arch, key] of PLAT) {
    const want = filesOf(NEW)[key];
    const withCopies = await resolve([release(NEW), release(OLD)], platform, arch);
    const without = await resolve([release(NEW, { copies: false }), release(OLD, { copies: false })], platform, arch);
    eq([withCopies.ok, withCopies.version, withCopies.asset && withCopies.asset.name, withCopies.asset && withCopies.asset.size, withCopies.asset && withCopies.asset.digest && withCopies.asset.digest.hex],
      [true, NEW, want[0], want[1], want[2]],
      `${platform} ${arch}: the REAL resolveInstallerRelease downloads the VERSIONED ${want[0]}, though the copies are listed first`);
    eq(withCopies, without, `${platform} ${arch}: …every field identical to the same releases WITHOUT copies (URL, size, digest, version, release)`);
  }
  for (const platform of ['darwin', 'win32', undefined]) {
    eq(cfgMod.pickInstallableRelease([release(NEW), release(OLD)], { platform }), cfgMod.pickInstallableRelease([release(NEW, { copies: false }), release(OLD, { copies: false })], { platform }),
      `config.js pickInstallableRelease (${platform || 'no platform'}): the same release with or without copies (Settings' check is unchanged)`);
  }
  eq(cfgMod.installerAssetsFor(release(NEW), 'win32').map((a) => a.name), ['TheCurator-Windows-Setup.exe', installerFileName(NEW)],
    'installerAssetsFor DOES count the .exe copy (an extension rule); the arch rule is what drops it, as the lines above show');

  // CONTROL: the same checks CAN see a copy being chosen. A copy whose name
  // carried an arch token, listed first, wins.
  const bad = 'TheCurator-Mac-x64.dmg';
  const ctl = pickInstallerAsset([asset('v9.1.0', bad, 5, 'd'.repeat(64)), asset('v9.1.0', publishedNameFor(NEW, 'x64'), 6, 'e'.repeat(64))], { arch: 'x64' });
  eq(ctl.ok && ctl.asset.name, bad, 'CONTROL: a copy named with an x64 token, listed first, WOULD be downloaded, so a green line above is not vacuous');
  ok(/archFromAssetName/.test(dl.updaterWouldPick(bad) || ''), 'CONTROL: updaterWouldPick names that copy');

  // A release carrying ONLY copies (cannot be produced by the workflow: a copy
  // is uploaded only after its versioned file, in a second upload).
  const copiesOnly = [release(NEW, { versioned: false, sources: false }), release(OLD, { copies: false })];
  for (const [platform, arch] of PLAT) {
    eq((cfgMod.pickInstallableRelease(copiesOnly, { platform }) || {}).version, NEW,
      `copies only, ${platform}: the picker still counts it (extension rule), exactly as it counts a release missing this arch`);
    const r = await resolve(copiesOnly, platform, arch);
    eq([r.ok, r.reason], [false, 'no-asset-for-arch'], `copies only, ${platform} ${arch}: a NAMED failure (no-asset-for-arch); nothing is downloaded, never a copy`);
  }
  // One platform's job failed: its copy is absent with its versioned file, so
  // the other platform's copies never make this release "installable" for it.
  const macOnly = [release(NEW, { only: ['darwin-arm64', 'darwin-x64'] }), release(OLD)];
  const w = await resolve(macOnly, 'win32', 'x64');
  eq([w.ok, w.version, w.asset && w.asset.name], [true, OLD, installerFileName(OLD)], 'Mac files and Mac copies only on the newest release: Windows is offered the older release\'s versioned setup, as before');
  const winOnly = [release(NEW, { only: ['win32-x64'] }), release(OLD)];
  const m = await resolve(winOnly, 'darwin', 'arm64');
  eq([m.ok, m.version, m.asset && m.asset.name], [true, OLD, publishedNameFor(OLD, 'arm64')], 'Windows files and the Windows copy only: a Mac is offered the older release\'s versioned DMG, as before');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§12  release-downloads.js: the copies (staged, byte-checked), the release check, the body');
// ═══════════════════════════════════════════════════════════════════════════
const DLCLI = path.join(__dirname, 'release-downloads.js');
const RV = '4.1.0';
function makeBuild(dir, version, bytes = { 'win32-x64': 3001, 'darwin-arm64': 4001, 'darwin-x64': 5001 }) {
  mkdirSync(dir, { recursive: true });
  const out = {};
  for (const i of dl.INSTALLERS) {
    const f = path.join(dir, i.versioned(version));
    const buf = Buffer.alloc(bytes[i.key]);
    for (let k = 0; k < buf.length; k++) buf[k] = (k * 31 + i.key.length) & 0xff;
    writeFileSync(f, buf);
    out[i.key] = f;
  }
  return out;
}
const relJson = (entries) => ({ assets: entries.map(([name, size, hex]) => ({ name, size, state: 'uploaded', ...(hex ? { digest: `sha256:${hex}` } : {}) })) });
{
  eq(dl.STABLE_NAMES, ['TheCurator-Windows-Setup.exe', 'TheCurator-Mac-AppleSilicon.dmg', 'TheCurator-Mac-Intel.dmg'], 'the three stable names (the owner\'s)');
  eq(dl.INSTALLERS.map((i) => dl.stableDownloadUrl(i.stable)), [
    'https://github.com/talirezun/the-curator/releases/latest/download/TheCurator-Windows-Setup.exe',
    'https://github.com/talirezun/the-curator/releases/latest/download/TheCurator-Mac-AppleSilicon.dmg',
    'https://github.com/talirezun/the-curator/releases/latest/download/TheCurator-Mac-Intel.dmg',
  ], 'the three stable URLs');
  eq(`${dl.REPO_URL}/releases`, cfgMod.RELEASES_PAGE_URL, 'CROSS-CHECK: the repository is the one config.js reads releases from');
  eq(dl.INSTALLERS.map((i) => i.versioned(RV)), [installerFileName(RV), publishedNameFor(RV, 'arm64'), publishedNameFor(RV, 'x64')],
    'the versioned names are the publish scripts\' own (installerFileName, publishedNameFor), never retyped');

  // ── stage ──
  const top = tmp();
  const build = makeBuild(path.join(top, 'dist'), RV);
  const out = path.join(top, 'stable');
  const pairs = dl.INSTALLERS.map((i) => ({ key: i.key, file: build[i.key] }));
  const st = dl.stageStableCopies({ pairs, version: RV, out });
  ok(st.ok, `stage: all three copies made (${st.reason || ''} ${st.detail || ''})`);
  for (const i of dl.INSTALLERS) {
    const c = path.join(out, i.stable);
    ok(existsSync(c) && sha256(readFileSync(c)) === sha256(readFileSync(build[i.key])), `stage: ${i.stable} is byte-identical to ${path.basename(build[i.key])}`);
  }
  eq(readdirSync(path.join(top, 'dist')).sort(), dl.INSTALLERS.map((i) => i.versioned(RV)).sort(), 'stage writes nothing into the build folder (the rename\'s re-read and the artifact never see a copy)');
  eq(dl.stageStableCopies({ pairs: [{ key: 'darwin-x64', file: build['darwin-arm64'] }], version: RV, out }).reason, 'not-the-versioned-file', 'stage refuses the arm64 DMG offered as the Intel one');
  eq(dl.stageStableCopies({ pairs: [{ key: 'win32-x64', file: path.join(top, 'nope.exe') }], version: RV, out }).reason, 'missing-file', 'stage refuses a missing file');
  eq(dl.stageStableCopies({ pairs, version: '4.1.0-rc1', out }).reason, 'bad-version', 'stage refuses a version that is not bare X.Y.Z');
  eq(dl.stageStableCopies({ pairs: [{ key: 'linux-x64', file: build['win32-x64'] }], version: RV, out }).reason, 'unknown-key', 'stage refuses an unknown platform key');
  // THE GUARD: a stable name the updater would pick is refused before any copy.
  const picky = [{ ...dl.INSTALLERS[2], stable: 'TheCurator-Mac-x64-Intel.dmg' }];
  const out2 = path.join(top, 'stable2');
  const g = dl.stageStableCopies({ pairs: [{ key: 'darwin-x64', file: build['darwin-x64'] }], version: RV, out: out2, installers: picky });
  eq(g.reason, 'stable-name-matched-by-updater', 'stage REFUSES a stable name the real updater matcher would pick (here one with an x64 token)');
  ok(!existsSync(path.join(out2, 'TheCurator-Mac-x64-Intel.dmg')), '…before making any copy');
  // THE GUARD: a copy that is not the same bytes is refused.
  const short = (a, b) => writeFileSync(b, readFileSync(a).subarray(1));
  eq(dl.stageStableCopies({ pairs: [{ key: 'win32-x64', file: build['win32-x64'] }], version: RV, out: path.join(top, 'stable3'), copyFile: short }).reason, 'copy-differs',
    'stage REFUSES a copy one byte short (size and SHA-256 are re-read from disk)');
  const flip = (a, b) => { const buf = readFileSync(a); buf[0] ^= 1; writeFileSync(b, buf); };
  eq(dl.stageStableCopies({ pairs: [{ key: 'win32-x64', file: build['win32-x64'] }], version: RV, out: path.join(top, 'stable4'), copyFile: flip }).reason, 'copy-differs',
    'stage REFUSES a copy of the right size with one byte changed');

  // The CLI, as the workflow runs it.
  const ghOut = path.join(top, 'gh-output');
  const cli = spawnSync(process.execPath, [DLCLI, 'stage', '--version', RV, '--out', path.join(top, 'stable5'),
    '--file', `darwin-arm64=${build['darwin-arm64']}`, '--file', `darwin-x64=${build['darwin-x64']}`],
  { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: ghOut } });
  eq(cli.status, 0, `stage CLI exits 0 (${cli.stderr.trim()})`);
  eq(existsSync(ghOut) ? readFileSync(ghOut, 'utf8') : '(no output written)', `darwin_arm64=${path.join(top, 'stable5', 'TheCurator-Mac-AppleSilicon.dmg')}\ndarwin_x64=${path.join(top, 'stable5', 'TheCurator-Mac-Intel.dmg')}\n`,
    '…and writes darwin_arm64= and darwin_x64= (the step outputs the publish step reads)');
  const cliBad = spawnSync(process.execPath, [DLCLI, 'stage', '--version', RV, '--out', path.join(top, 'stable6'), '--file', `win32-x64=${build['darwin-x64']}`], { encoding: 'utf8' });
  ok(cliBad.status === 1 && /not-the-versioned-file/.test(cliBad.stderr), 'stage CLI exits 1 naming the refusal');
  ok(spawnSync(process.execPath, [DLCLI, 'stage', '--version', RV], { encoding: 'utf8' }).status === 2, 'stage CLI without --out/--file is a usage error (2)');

  // ── check ──
  const full = [];
  for (const i of dl.INSTALLERS) {
    const b = readFileSync(build[i.key]);
    full.push([i.versioned(RV), b.length, sha256(b)], [i.stable, b.length, sha256(b)]);
  }
  full.push([RELEASE_SOURCE_ASSETS[0].asset, 10, null]);
  eq(dl.checkReleaseCopies({ release: relJson(full), pairs, version: RV }), { ok: true, checked: 6 }, 'check: three versioned files and three copies, by exact name, size and digest');
  const without = (name) => relJson(full.filter((e) => e[0] !== name));
  for (const i of dl.INSTALLERS) {
    const r = dl.checkReleaseCopies({ release: without(i.stable), pairs, version: RV });
    eq([r.reason, r.missing], ['missing-on-release', [i.stable]], `check: the copy ${i.stable} missing FAILS (missing-on-release)`);
  }
  eq(dl.checkReleaseCopies({ release: without(installerFileName(RV)), pairs, version: RV }).reason, 'missing-on-release', 'check: the versioned setup missing fails too');
  const wrongSize = relJson(full.map((e) => (e[0] === 'TheCurator-Mac-Intel.dmg' ? [e[0], e[1] - 1, null] : e)));
  eq(dl.checkReleaseCopies({ release: wrongSize, pairs, version: RV }).reason, 'wrong-size-on-release', 'check: a copy one byte short on the release FAILS (wrong-size-on-release)');
  const wrongDigest = relJson(full.map((e) => (e[0] === 'TheCurator-Windows-Setup.exe' ? [e[0], e[1], 'f'.repeat(64)] : e)));
  eq(dl.checkReleaseCopies({ release: wrongDigest, pairs, version: RV }).reason, 'wrong-digest-on-release', 'check: a copy whose GitHub digest differs FAILS');
  const starter = relJson(full); starter.assets.find((a) => a.name === 'TheCurator-Mac-AppleSilicon.dmg').state = 'starter';
  eq(dl.checkReleaseCopies({ release: starter, pairs, version: RV }).reason, 'missing-on-release', 'check: a copy still uploading (state starter) does not count');
  const relFile = path.join(top, 'rel.json');
  writeFileSync(relFile, JSON.stringify(without('TheCurator-Windows-Setup.exe')));
  const ck = spawnSync(process.execPath, [DLCLI, 'check', '--release-json', relFile, '--version', RV, '--file', `win32-x64=${build['win32-x64']}`], { encoding: 'utf8' });
  ok(ck.status === 1 && /missing-on-release.*TheCurator-Windows-Setup\.exe/.test(ck.stderr), 'check CLI exits 1 naming the missing copy');
  writeFileSync(relFile, JSON.stringify(relJson(full)));
  eq(spawnSync(process.execPath, [DLCLI, 'check', '--release-json', relFile, '--version', RV, '--file', `win32-x64=${build['win32-x64']}`], { encoding: 'utf8' }).status, 0, 'check CLI exits 0 when both are there');

  // ── the previous release, for the changelog link ──
  const tags = [
    'aaa\trefs/tags/v4.0.0', 'bbb\trefs/tags/v4.0.1', 'ccc\trefs/tags/v4.0.1^{}', 'ddd\trefs/tags/v3.99.3-wintest.11',
    'eee\trefs/tags/v4.1.0', 'fff\trefs/tags/v4.2.0', 'ggg\trefs/tags/v3.100.0', 'hhh\trefs/heads/v4.0.9',
  ].join('\n');
  eq(dl.previousReleaseTag(tags, '4.1.0'), 'v4.0.1', 'previousReleaseTag: the newest plain tag below this one (numeric, not text order; rehearsal tags, branches and newer tags ignored)');
  eq(dl.previousReleaseTag(tags, '4.0.0'), 'v3.100.0', '…3.100.0 is newer than 3.99.x');
  eq([dl.previousReleaseTag('', '4.1.0'), dl.previousReleaseTag(null, '4.1.0')], [null, null], '…none when there is nothing to read');

  // ── body ──
  const allNames = full.map((e) => e[0]);
  const body = dl.releaseBody({ version: RV, assets: allNames, previousTag: 'v4.0.1' });
  const lines = body.split('\n');
  eq(lines[0], '## Download', 'the body STARTS with "## Download"');
  const rows = lines.filter((l) => l.startsWith('- **'));
  eq(rows.length, 3, 'one line per installer');
  dl.INSTALLERS.forEach((i, k) => {
    ok(rows[k].includes(`(${dl.stableDownloadUrl(i.stable)})`) && rows[k].includes(`\`${i.versioned(RV)}\``), `row ${k + 1}: the stable link to ${i.stable} AND the versioned name ${i.versioned(RV)}`);
  });
  ok(/^- \*\*Windows 10\/11:\*\*/.test(rows[0]) && /Run it\. If "Windows protected your PC" appears, click More info, then Run anyway\./.test(rows[0]), 'Windows: run it; "Windows protected your PC" → More info → Run anyway');
  for (const r of rows.slice(1)) {
    ok(/drag The Curator onto Applications/.test(r) && /System Settings → Privacy & Security, click Open Anyway/.test(r), 'Mac: drag to Applications; first open via System Settings → Privacy & Security → Open Anyway');
  }
  // The wording must match the user docs as they are, not the brief's guess
  // (docs/mac-app.md: Control-click → Open no longer works on Sequoia).
  const macDoc = readFileSync(path.join(ROOT, 'docs', 'mac-app.md'), 'utf8');
  const winDoc = readFileSync(path.join(ROOT, 'docs', 'windows-app.md'), 'utf8');
  ok(/System Settings → Privacy & Security/.test(macDoc) && /\*\*Open Anyway\*\*/.test(macDoc) && /drag\s+\*\*The Curator\*\* onto \*\*Applications\*\*/.test(macDoc),
    'CROSS-CHECK: docs/mac-app.md gives the same route (Privacy & Security → Open Anyway; drag onto Applications)');
  ok(!/right-click|Control-click/i.test(body), '…and the body does not send anyone to right-click → Open (the docs say it no longer works on Sequoia)');
  ok(/Windows protected your PC/.test(winDoc) && /\*\*More info\*\*/.test(winDoc) && /\*\*Run anyway\*\*/.test(winDoc), 'CROSS-CHECK: docs/windows-app.md names the same SmartScreen steps');
  const iGpl = lines.findIndex((l) => /source code of the git program bundled in the Windows app/.test(l) && /GPL/.test(l));
  const iLog = lines.findIndex((l) => l === '**Changelog:** https://github.com/talirezun/the-curator/compare/v4.0.1...v4.1.0');
  ok(iGpl > lines.indexOf(rows[2]) && iLog > iGpl, 'then the one-line GPL note, then the changelog link (compare from the previous release)');
  eq(dl.releaseBody({ version: RV, assets: allNames }).trim().split('\n').at(-1), '**Changelog:** https://github.com/talirezun/the-curator/commits/v4.1.0', 'no previous release known: the tag\'s commit history');
  const macOnlyBody = dl.releaseBody({ version: RV, assets: allNames.filter((n) => !/Windows/.test(n)) });
  ok(!/Windows 10/.test(macOnlyBody) && !/GPL/.test(macOnlyBody) && (macOnlyBody.match(/^- \*\*/gm) || []).length === 2, 'Mac files only: two rows, no Windows row and no GPL note');
  const noCopy = dl.releaseBody({ version: RV, assets: allNames.filter((n) => n !== 'TheCurator-Mac-Intel.dmg') });
  ok(!/Mac with Intel/.test(noCopy), 'an installer whose copy is not on the release is NOT listed (the body never links a file the release lacks)');
  const noVersioned = dl.releaseBody({ version: RV, assets: allNames.filter((n) => n !== publishedNameFor(RV, 'arm64')) });
  ok(!/Apple Silicon/.test(noVersioned), '…nor one whose versioned file is missing');
  ok(/^## Download\n\nNo installer is attached to this release yet\.\n/.test(dl.releaseBody({ version: RV, assets: [] })), 'no installer at all: still "## Download" first, saying so');
  eq(throwsMsg(() => dl.releaseBody({ version: 'v4.1.0', assets: [] })) !== null, true, 'the body refuses a version with a v');

  // body CLI: the release's own assets, unioned with the names about to be uploaded.
  const bodyFile = path.join(top, 'body.md');
  const tagsFile = path.join(top, 'tags.txt');
  writeFileSync(tagsFile, tags);
  writeFileSync(relFile, JSON.stringify(relJson(full.filter((e) => !/Windows/.test(e[0])))));
  const bc = spawnSync(process.execPath, [DLCLI, 'body', '--version', RV, '--out', bodyFile, '--tags', tagsFile, '--release-json', relFile,
    '--asset', installerFileName(RV), '--asset', 'TheCurator-Windows-Setup.exe'], { encoding: 'utf8' });
  eq(bc.status, 0, `body CLI exits 0 (${bc.stderr.trim()})`);
  eq(readFileSync(bodyFile, 'utf8'), body, '…and writes exactly the body above (release assets + names about to upload; previous tag from ls-remote text)');
  const bt = spawnSync(process.execPath, [DLCLI, 'body', '--version', RV, '--out', bodyFile, '--tags', path.join(top, 'no-tags.txt'), '--asset', 'x'], { encoding: 'utf8' });
  ok(bt.status === 0 && /commits\/v4\.1\.0/.test(readFileSync(bodyFile, 'utf8')), 'an unreadable tags file falls back to the commit history link, never fails the publish');
  ok(spawnSync(process.execPath, [DLCLI, 'body', '--version', RV, '--out', bodyFile], { encoding: 'utf8' }).status === 2, 'body CLI with neither --release-json nor --asset is a usage error');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§13  The publish steps — PARSED, then their shell EXECUTED against a fake gh (both arms, both jobs)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const doc = (() => { try { return parseYaml(readFileSync(DMG_WORKFLOW, 'utf8')); } catch { return { jobs: {} }; } })();
  const J = doc.jobs || {};
  const ms = (J.dmg && J.dmg.steps) || [];
  const ps = (J['publish-windows'] && J['publish-windows'].steps) || [];
  const at = (steps, pred) => steps.findIndex(pred);

  // ── Mac: order and wiring ──
  const iLipo = at(ms, (s) => /lipo -archs/.test(s.run || ''));
  const iArt = at(ms, (s) => /upload-artifact/.test(s.uses || ''));
  const iStage = at(ms, (s) => s.id === 'stable');
  const iPub = at(ms, (s) => /gh release create/.test(s.run || ''));
  const iChk = at(ms, (s) => /release-downloads\.js check/.test(s.run || ''));
  const iBody = at(ms, (s) => /release-downloads\.js body/.test(s.run || '') && /--release-json/.test(s.run || '') && !/gh release create/.test(s.run || ''));
  ok(iLipo >= 0 && iArt > iLipo && iStage > iArt && iPub > iStage && iChk > iPub && iBody > iChk,
    `Mac: lipo, artifact, stage the copies, publish, check the release, write the body (in that order: ${[iLipo, iArt, iStage, iPub, iChk, iBody]})`);
  const stRun = (ms[iStage] || {}).run || '';
  ok(/release-downloads\.js stage --version "\$\{GITHUB_REF_NAME#v\}" --out "\$RUNNER_TEMP\/stable"/.test(stRun)
    && stRun.includes('--file "darwin-arm64=${{ steps.names.outputs.arm64 }}"') && stRun.includes('--file "darwin-x64=${{ steps.names.outputs.x64 }}"'),
  'Mac stage: both renamed DMGs by step output, copies into $RUNNER_TEMP (never desktop/dist, which the artifact globs)');
  const pub = ms[iPub] || {};
  eq([pub.env && pub.env.ARM64_STABLE, pub.env && pub.env.X64_STABLE], ['${{ steps.stable.outputs.darwin_arm64 }}', '${{ steps.stable.outputs.darwin_x64 }}'], 'Mac publish: the copies by the stage step\'s outputs');
  const chk = ms[iChk] || {};
  ok(/for attempt in 1 2 3 4 5 6/.test(chk.run || '') && /exit 1\s*$/.test(chk.run || '') && /--file "darwin-arm64=\$ARM64_DMG" --file "darwin-x64=\$X64_DMG"/.test(chk.run || '') && !chk['continue-on-error'] && !chk.if,
    'Mac check: re-read a few times, then FAIL the job; both DMGs (and so both copies); never skippable');
  ok(!ms.some((s) => s['continue-on-error']), 'no Mac step may fail quietly');
  ok(!/--generate-notes/.test(JSON.stringify(J)), 'no job uses --generate-notes any more (the body is ours, on both paths)');

  // ── Windows: order and wiring ──
  const wNames = at(ps, (s) => s.id === 'names');
  const wStage = at(ps, (s) => s.id === 'stable');
  const wSrc = at(ps, (s) => s.id === 'sources');
  const wPub = at(ps, (s) => /gh release (upload|create)/.test(s.run || ''));
  const wChk = at(ps, (s) => /--check-release/.test(s.run || ''));
  ok(wNames >= 0 && wStage > wNames && wStage < wPub && wSrc < wPub && wPub < wChk, `Windows: name check, stage the copy, sources, publish, check (${[wNames, wStage, wSrc, wPub, wChk]})`);
  ok(((ps[wStage] || {}).run || '').includes('--file "win32-x64=${{ steps.names.outputs.setup }}"') && /--out "\$RUNNER_TEMP\/stable"/.test((ps[wStage] || {}).run || ''), 'Windows stage: the checked setup, by step output');
  eq((ps[wPub] || {}).env && ps[wPub].env.SETUP_STABLE, '${{ steps.stable.outputs.win32_x64 }}', 'Windows publish: the copy by the stage step\'s output');
  ok(/publish-win-assets\.js --check-release [^\n]*&&\s*\n\s*node scripts\/release-downloads\.js check --release-json "\$RUNNER_TEMP\/release-assets\.json" --version "\$VERSION" --file "win32-x64=\$SETUP" &&/.test((ps[wChk] || {}).run || ''),
    'Windows check: the GPL check AND the copy check must both pass, in the same retry loop');
  eq((ps[wChk] || {}).env && ps[wChk].env.VERSION, '${{ needs.gate.outputs.version }}', '…with the gate\'s version');

  // ── EXECUTED: the shell of each publish step, against a fake gh ──
  const top = tmp();
  const bin = path.join(top, 'bin');
  mkdirSync(bin);
  const log = path.join(top, 'gh.log');
  const notes = path.join(top, 'notes');
  mkdirSync(notes);
  writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/bash',
    'printf "%s|" "$@" >> "$FAKE_LOG"; printf "\\n" >> "$FAKE_LOG"',
    'if [ "$1" = release ] && [ "$2" = view ]; then',
    '  if [ "${4:-}" = --json ]; then cat "$FAKE_ASSETS_JSON"; exit 0; fi',
    '  [ "$FAKE_EXISTS" = 1 ]; exit $?',
    'fi',
    'prev=""; for a in "$@"; do if [ "$prev" = --notes-file ]; then cp "$a" "$FAKE_NOTES/$(ls "$FAKE_NOTES" | wc -l | tr -d " ").md"; fi; prev="$a"; done',
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(path.join(bin, 'git'), '#!/bin/bash\n[ "$1" = ls-remote ] && printf "a\\trefs/tags/v4.0.1\\nb\\trefs/tags/v4.0.0\\n" && exit 0\nexit 1\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const bashMajor = Number(spawnSync('bash', ['-c', 'echo ${BASH_VERSINFO[0]}'], { encoding: 'utf8' }).stdout.trim());
  // macOS ships bash 3.2, which has no mapfile; the runner's bash 5 has it.
  // A shim for THIS harness only, so the Windows step's text runs unchanged.
  const shim = bashMajor >= 4 ? '' : 'mapfile() { [ "$1" = -t ] && shift; local __n=$1 __l; eval "$__n=()"; while IFS= read -r __l; do eval "$__n+=(\\"\\$__l\\")"; done; }\n';
  const build = makeBuild(path.join(top, 'dist'), RV);
  const stable = path.join(top, 'stable');
  const st = dl.stageStableCopies({ pairs: dl.INSTALLERS.map((i) => ({ key: i.key, file: build[i.key] })), version: RV, out: stable });
  ok(st.ok, 'harness: real copies staged');
  const srcFile = path.join(top, RELEASE_SOURCE_ASSETS[0].asset);
  writeFileSync(srcFile, 'src');
  const srcList = path.join(top, 'sources.txt');
  writeFileSync(srcList, `${srcFile}\n`);
  const fullRel = path.join(top, 'full.json');
  const fullAssets = [];
  for (const i of dl.INSTALLERS) {
    const b = readFileSync(build[i.key]);
    fullAssets.push([i.versioned(RV), b.length, sha256(b)], [i.stable, b.length, sha256(b)]);
  }
  fullAssets.push([path.basename(srcFile), 3, null]);
  writeFileSync(fullRel, JSON.stringify(relJson(fullAssets)));
  const macOnlyRel = path.join(top, 'mac.json');
  writeFileSync(macOnlyRel, JSON.stringify(relJson(fullAssets.filter((e) => /Mac|AppleSilicon|Intel/.test(e[0])))));

  function runStep(step, { exists, assetsJson, env }) {
    rmSync(notes, { recursive: true, force: true }); mkdirSync(notes);
    writeFileSync(log, '');
    const rt = mkdtempSync(path.join(top, 'rt-'));
    const r = spawnSync('bash', ['-c', shim + (step.run || 'exit 99')], {
      cwd: ROOT, encoding: 'utf8',
      env: {
        ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: rt, GITHUB_STEP_SUMMARY: path.join(rt, 'summary'),
        FAKE_LOG: log, FAKE_NOTES: notes, FAKE_EXISTS: exists ? '1' : '0', FAKE_ASSETS_JSON: assetsJson, GH_TOKEN: 'x', TAG: `v${RV}`, ...env,
      },
    });
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('|').slice(0, -1));
    const bodies = readdirSync(notes).sort().map((f) => readFileSync(path.join(notes, f), 'utf8'));
    return { status: r.status, stderr: r.stderr, calls, bodies };
  }
  const short = (c) => c.slice(0, 2).join(' ') + ' ' + c.slice(2).map((a) => path.basename(a)).join(' ');
  const macEnv = { ARM64_DMG: build['darwin-arm64'], X64_DMG: build['darwin-x64'], ARM64_STABLE: path.join(stable, 'TheCurator-Mac-AppleSilicon.dmg'), X64_STABLE: path.join(stable, 'TheCurator-Mac-Intel.dmg') };
  const winEnv = { SETUP: build['win32-x64'], SETUP_STABLE: path.join(stable, 'TheCurator-Windows-Setup.exe'), SOURCES_LIST: srcList, VERSION: RV };

  // Mac, no release yet: create (with the body), then the copies.
  const mc = runStep(pub, { exists: false, assetsJson: fullRel, env: macEnv });
  eq(mc.status, 0, `Mac publish, NEW release: the step's shell runs to the end (${mc.stderr.trim().split('\n').at(-1) || ''})`);
  const mcCalls = mc.calls.filter((c) => c[1] !== 'view').map(short);
  eq(mcCalls, [
    `release create v${RV} ${publishedNameFor(RV, 'arm64')} ${publishedNameFor(RV, 'x64')} --title The Curator v${RV} --notes-file release-body.md --verify-tag --latest`,
    `release upload v${RV} TheCurator-Mac-AppleSilicon.dmg TheCurator-Mac-Intel.dmg --clobber`,
  ], '…gh release create WITH --notes-file, then the copies in a SECOND upload');
  ok(mc.bodies.length === 1 && mc.bodies[0].startsWith('## Download\n') && /TheCurator-Mac-AppleSilicon\.dmg/.test(mc.bodies[0]) && /compare\/v4\.0\.1\.\.\.v4\.1\.0/.test(mc.bodies[0]),
    '…and the body it was given starts with "## Download", lists the Mac files, links the changelog from the previous tag');
  // Mac, release exists (a re-run, or Windows went first).
  const me = runStep(pub, { exists: true, assetsJson: fullRel, env: macEnv });
  eq(me.status, 0, 'Mac publish, EXISTING release: runs to the end');
  eq(me.calls.filter((c) => c[1] !== 'view').map(short), [
    `release upload v${RV} ${publishedNameFor(RV, 'arm64')} ${publishedNameFor(RV, 'x64')} --clobber`,
    `release upload v${RV} TheCurator-Mac-AppleSilicon.dmg TheCurator-Mac-Intel.dmg --clobber`,
    `release edit v${RV} --latest --notes-file release-body.md`,
  ], '…versioned files, then the copies, then gh release edit --notes-file (the body is set on this path too)');
  // Mac: the check step, executed (sleep is a no-op here).
  const okChk = runStep(chk, { exists: true, assetsJson: fullRel, env: macEnv });
  eq(okChk.status, 0, 'Mac check step: exit 0 when the release carries both DMGs and both copies');
  writeFileSync(path.join(top, 'missing.json'), JSON.stringify(relJson(fullAssets.filter((e) => e[0] !== 'TheCurator-Mac-Intel.dmg'))));
  const badChk = runStep(chk, { exists: true, assetsJson: path.join(top, 'missing.json'), env: macEnv });
  ok(badChk.status === 1 && badChk.calls.filter((c) => c[1] === 'view').length === 6 && /TheCurator-Mac-Intel\.dmg/.test(badChk.stderr),
    'Mac check step: a missing copy FAILS the job after six reads, naming the file');
  // Mac: the final body step, from what the release carries.
  const mb = runStep(ms[iBody], { exists: true, assetsJson: fullRel, env: {} });
  eq([mb.status, mb.calls.filter((c) => c[1] === 'edit').map(short)], [0, [`release edit v${RV} --notes-file release-body.md`]], 'Mac body step: gh release edit --notes-file');
  ok(mb.bodies.length === 1 && (mb.bodies[0].match(/^- \*\*/gm) || []).length === 3 && /GPL/.test(mb.bodies[0]), '…with all three installers and the GPL note when the Windows files are already there');

  // Windows, no release yet (the Mac job failed): create with the body, then the copy.
  const wp = ps[wPub] || {};
  const wc = runStep(wp, { exists: false, assetsJson: fullRel, env: winEnv });
  eq(wc.status, 0, `Windows publish, NEW release: runs to the end (${wc.stderr.trim().split('\n').at(-1) || ''})`);
  eq(wc.calls.filter((c) => c[1] !== 'view').map(short), [
    `release create v${RV} ${installerFileName(RV)} ${path.basename(srcFile)} --title The Curator v${RV} --notes-file release-body.md --verify-tag --latest`,
    `release upload v${RV} TheCurator-Windows-Setup.exe --clobber`,
  ], '…gh release create WITH --notes-file, then the copy in a SECOND upload');
  ok(wc.bodies.length === 1 && wc.bodies[0].startsWith('## Download\n') && (wc.bodies[0].match(/^- \*\*/gm) || []).length === 1 && /GPL/.test(wc.bodies[0]),
    '…its body lists the Windows installer only (the Mac files are not there) and the GPL note');
  // Windows, release exists (the usual order: the Mac job made it).
  const we = runStep(wp, { exists: true, assetsJson: macOnlyRel, env: winEnv });
  eq(we.status, 0, 'Windows publish, EXISTING release: runs to the end');
  eq(we.calls.filter((c) => c[1] !== 'view').map(short), [
    `release upload v${RV} ${installerFileName(RV)} ${path.basename(srcFile)} --clobber`,
    `release upload v${RV} TheCurator-Windows-Setup.exe --clobber`,
    `release edit v${RV} --notes-file release-body.md`,
  ], '…setup and sources, then the copy, then gh release edit --notes-file');
  ok(we.bodies.length === 1 && (we.bodies[0].match(/^- \*\*/gm) || []).length === 3 && /GPL/.test(we.bodies[0]),
    '…and that body lists all THREE installers: the Mac files read back from the release plus the Windows files just uploaded');
  // Windows check step: the copy is required.
  const wck = ps[wChk] || {};
  // (publish-win-assets' own check reads the real RELEASE_SOURCE_ASSETS list,
  // which this fixture does not carry; so the copy check is executed alone.)
  const copyCheckLine = ((wck.run || '').match(/node scripts\/release-downloads\.js check [^\n]*?(?= &&)/) || [''])[0];
  ok(copyCheckLine.length > 0, 'harness: the copy check line is extracted from the Windows check step');
  const runLine = (assetsFile) => spawnSync('bash', ['-c', `cp "${assetsFile}" "$RUNNER_TEMP/release-assets.json" && ${copyCheckLine}`], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: mkdtempSync(path.join(top, 'rt-')), ...winEnv },
  });
  eq(runLine(fullRel).status, 0, 'Windows check (the copy line, executed): passes with the setup and its copy');
  writeFileSync(path.join(top, 'nowin.json'), JSON.stringify(relJson(fullAssets.filter((e) => e[0] !== 'TheCurator-Windows-Setup.exe'))));
  eq(runLine(path.join(top, 'nowin.json')).status, 1, '…and FAILS without the copy');
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
