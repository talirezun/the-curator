#!/usr/bin/env node
/**
 * OFFLINE — tier 0, ONE PROJECT MANY SOURCES (v3.69.0): the manifest model,
 * the lowest-version writer, and the per-document store.
 *
 * WHAT THIS SUITE PROVES, AND HOW
 * ───────────────────────────────
 *   §1  constants: MAX_SOURCES_PER_PROJECT = 8, manifest versions 1 and 2.
 *   §2  EVERY EXISTING MANIFEST SHAPE → the model (one fixture per row of
 *       CONTRACT §2.2 in scripts/fixtures/foundations-manifests/, the v1 rows
 *       produced by the v3.68.0 writer's formula over the FROZEN v3.68.0
 *       validator): the groups and derived ownership each reads as;
 *       serialise(parse(bytes)) === bytes (property 1); one real store write
 *       (a routing flag) and the version + keys it lands at.
 *   §3  the writer's properties over RANDOM models (seeded): idempotent
 *       (property 2), the version gate (property 3), and — against the FROZEN
 *       v3.68.0 validator, scripts/fixtures/validate-manifest-v3680.cjs — an
 *       OLDER APP REFUSES EVERY v2 OUTPUT and ACCEPTS EVERY v1 OUTPUT, seeing
 *       the same documents (CONTRACT §2.4).
 *   §4  the v2 validator's rules, each refusal driven (a group naming no
 *       source, a kept document with a group, one path twice in a group, the
 *       same path in two groups ALLOWED, the 8-group cap, the id grammar),
 *       and unknown keys kept through a rewrite (top, document, group).
 *   §5  a MIXED project through a fake GitHub and real folders: written +
 *       copied + folder mirror + two GitHub sources; the envelope (`sources[]`,
 *       `ownership: mixed`, `source.group`), freshness PER GROUP, and
 *       get_project_context's §3.5 rule (sources only for v2).
 *   §6  REFRESH EVERY SOURCE with one GitHub source answering 500: that group
 *       is reported and left byte-identical, the others refresh, and the
 *       manifest is written ONCE (a write spy).
 *   §7  collisions (`landingSlug`, `landsAs`, an explicit taken slug), the
 *       8-source cap at commit, the lock, D4 (a save over a mirrored slug is
 *       refused, a new one is fine), `group-required`.
 *   §8  delete: a group's last document takes the group with it in the same
 *       write, a mixed project goes back to v1 (property 4), and a deleted
 *       mirror does not come back on the next refresh (no tombstone).
 *   §9  a folder mirror roots at the CHECKOUT's top level, records `origin`,
 *       and the advisory `repo_root` refresh reads (a) a folder source from
 *       its own folder and (b) a GitHub source from the checkout, leaving it
 *       a GitHub source (real git; self-skips with ⊘ without it).
 *   §10 the checklist annotations (`annotateScanCandidates`), both modes.
 *
 * Isolated via CURATOR_TEST_USER_DATA_DIR + __setUserDataDirOverride +
 * __setDomainsDirOverride; the real `fetch` is replaced by a spy that throws.
 *
 * Run with:  node scripts/test-foundations-sources.js   (exit 0 = all green)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-fnd-sources-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.on('exit', () => {
  try {
    if (path.dirname(TMP) === tmpdir() && path.basename(TMP).startsWith('curator-fnd-sources-')) rmSync(TMP, { recursive: true, force: true });
  } catch { /* best effort */ }
});
const NET = [];
globalThis.fetch = (...a) => { NET.push(String(a[0]).slice(0, 120)); throw new Error('NET BLOCKED BY SPY'); };

const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setUserDataDirOverride(USER_DATA);
__setDomainsDirOverride(DOMAINS);

const WS = await import('../src/brain/working-state.js');
const { acquireFileLock } = await import('../src/brain/write-registry.js');
const FROZEN = require('./fixtures/validate-manifest-v3680.cjs');
const FIX = path.join(__dirname, 'fixtures', 'foundations-manifests');

let passed = 0, failed = 0, skipped = 0;
const failures = [];
function assert(cond, label, err) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++; failures.push(label); console.log(`  ✗ ${label}`); if (err !== undefined) console.log(`    └─ ${String(err).slice(0, 500)}`);
}
function eq(a, b, label) { assert(a === b, label, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
function skip(label) { skipped++; console.log(`  ⊘ ${label}`); }
function section(name) { console.log(`\n── ${name} ──`); }
const sha = (b) => createHash('sha256').update(b).digest('hex');
const gitBlobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const gitOk = (() => { try { return spawnSync('git', ['--version']).status === 0; } catch { return false; } })();
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

// ── Tokens and a fake GitHub serving MANY repositories ──────────────────
const CONFIG_TOKEN = 'github_pat_TESTONLY_SHOULD_NEVER_APPEAR_0123456789';
const SYNC_TOKEN = 'ghp_thisisasecretpatdonotleak1234abcdABCD';
writeFileSync(path.join(USER_DATA, '.curator-config.json'), JSON.stringify({ githubReadToken: CONFIG_TOKEN }, null, 2));
writeFileSync(path.join(USER_DATA, '.sync-config.json'), JSON.stringify({ repoUrl: 'https://github.com/o/knowledge', token: SYNC_TOKEN }, null, 2));

/** `repos`: { 'owner/repo': { files: {path: text}, commit } }. `fail` — a
 *  Set of 'owner/repo' keys that answer 500 to everything. */
function makeGitHub(repos, { fail = new Set() } = {}) {
  const calls = [];
  const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (k.toLowerCase() === 'x-ratelimit-remaining' ? '5000' : null) },
    async json() { return body; }, async text() { return JSON.stringify(body); },
  });
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init && init.headers && (init.headers.Authorization || init.headers.authorization) });
    const u = new URL(String(url));
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return json({ message: 'no route' }, 404);
    const key = `${m[1]}/${m[2]}`.toLowerCase();
    if (fail.has(key)) return json({ message: 'boom' }, 500);
    const repo = Object.entries(repos).find(([k]) => k.toLowerCase() === key);
    if (!repo) return json({ message: 'Not Found' }, 404);
    const r = repo[1];
    const rest = m[3] || '';
    if (!rest) return json({ default_branch: 'main' });
    if (rest.startsWith('/commits/')) return json({ sha: r.commit || 'c'.repeat(40) });
    if (rest.startsWith('/git/trees/')) {
      return json({ truncated: false, tree: Object.entries(r.files).map(([p, c]) => ({ path: p, type: 'blob', sha: gitBlobSha(Buffer.from(c)), size: Buffer.byteLength(c) })) });
    }
    const b = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    if (b) {
      const hit = Object.entries(r.files).find(([, c]) => gitBlobSha(Buffer.from(c)) === b[1]);
      if (!hit) return json({ message: 'Not Found' }, 404);
      return json({ content: Buffer.from(hit[1]).toString('base64'), encoding: 'base64' });
    }
    return json({ message: 'no route' }, 404);
  };
  return { fetchImpl, calls };
}
const fakeSleep = async () => {};

// ── A domain, projects, folders ────────────────────────────────────────
const D = 'srcdom';
mkdirSync(path.join(DOMAINS, D, 'wiki'), { recursive: true });
writeFileSync(path.join(DOMAINS, D, 'CLAUDE.md'), `# ${D}\n`);
let pn = 0;
async function newProject() { const p = `p${pn++}`; const r = await WS.createProject(D, p, {}); if (!r.ok) throw new Error(JSON.stringify(r)); return p; }
const fdir = (p) => path.join(DOMAINS, D, 'state', p, WS.FOUNDATIONS_DIRNAME);
const mpath = (p) => path.join(fdir(p), WS.FOUNDATIONS_MANIFEST_FILENAME);
const manifestOf = (p) => JSON.parse(readFileSync(mpath(p), 'utf8'));
const bytesOf = (p) => readFileSync(mpath(p), 'utf8');
function folder(name, files) {
  const root = path.join(TMP, 'src', name);
  for (const [rel, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); }
  return root;
}
const docsFingerprint = (p) => readdirSync(fdir(p)).sort().map((n) => `${n}:${sha(readFileSync(path.join(fdir(p), n)))}`).join(',');

// ═════════════════════════════════════════════════════════════════════════
section('1. Constants');
{
  eq(WS.MAX_SOURCES_PER_PROJECT, 8, 'MAX_SOURCES_PER_PROJECT is 8 (decision D3)');
  eq(WS.FOUNDATIONS_MANIFEST_VERSION, 1, 'the base manifest version stays 1');
  eq(WS.FOUNDATIONS_MANIFEST_V2, 2, 'version 2 exists for what v1 cannot express');
  eq(WS.FOUNDATIONS_MANIFEST_MAX_VERSION, 2, 'this store reads up to version 2');
  eq(typeof WS.serialiseManifest, 'function', 'serialiseManifest is exported (pure)');
  eq(typeof WS.parseFoundationsManifest, 'function', 'parseFoundationsManifest is exported (pure)');
}

// ═════════════════════════════════════════════════════════════════════════
section('2. Every existing manifest shape → the model, byte-identical round trip, one real write');
const parse = (text) => WS.parseFoundationsManifest(JSON.parse(text));
// name → [groups, derived ownership, round-trip identical?, version after a routing write, group kinds]
const ROWS = {
  'v1-curator-copied': { groups: 0, ownership: 'curator', identical: true, afterWrite: 1, kinds: [] },
  'v1-folder-mirror': { groups: 1, ownership: 'repo', identical: true, afterWrite: 1, kinds: ['folder'] },
  'v1-folder-mirror-origin': { groups: 1, ownership: 'repo', identical: true, afterWrite: 1, kinds: ['folder'] },
  'v1-github-mirror': { groups: 1, ownership: 'repo', identical: true, afterWrite: 1, kinds: ['github'] },
  'v1-empty-curator': { groups: 0, ownership: 'curator', identical: true, afterWrite: null, kinds: [] },
  'v1-empty-repo-declared': { groups: 1, ownership: 'repo', identical: true, afterWrite: null, kinds: ['github'] },
  'v1-curator-stale-repo': { groups: 0, ownership: 'curator', identical: true, afterWrite: 1, kinds: [] },
  'v1-null-ownership-mirror': { groups: 1, ownership: null, identical: true, afterWrite: 1, kinds: ['folder'] },
  'v1-mixed-legacy-repo': { groups: 1, ownership: null, identical: false, afterWrite: 2, kinds: ['folder'] },
  'v1-mixed-legacy-norepo': { groups: 1, ownership: null, identical: false, afterWrite: 2, kinds: ['folder'] },
};
{
  for (const [name, want] of Object.entries(ROWS)) {
    const text = readFileSync(path.join(FIX, `${name}.json`), 'utf8');
    const r = parse(text);
    assert(r.ok, `${name}: reads`, r.error);
    if (!r.ok) continue;
    eq(r.manifest.sources.length, want.groups, `${name}: ${want.groups} source group(s)`);
    eq(FROZEN.validateManifest(JSON.parse(text)).ok, true, `${name}: the v3.68.0 validator accepts the fixture (it is a real v1 shape)`);
    const repoDocs = r.manifest.documents.filter((d) => d.source.kind === 'repo');
    assert(repoDocs.every((d) => d.source.group === 's1'), `${name}: every mirrored document reads as group s1`);
    const out = WS.serialiseManifest(r.manifest);
    if (want.identical) eq(out, text, `${name}: serialise(parse(bytes)) === bytes (property 1)`);
    else eq(JSON.parse(out).version, 2, `${name}: a hand-edited mix is written at version 2 on its NEXT write — never rewritten on read`);
  }
  // A pre-v3.68 curator manifest: what v3.68.0 itself wrote on its first rewrite.
  const pre = readFileSync(path.join(FIX, 'v1-curator-pre368.json'), 'utf8');
  const want = readFileSync(path.join(FIX, 'v1-curator-pre368.v3680-rewrite.json'), 'utf8');
  eq(WS.serialiseManifest(parse(pre).manifest), want, 'a pre-v3.68 curator manifest is rewritten exactly as v3.68.0 rewrote it (copiedFrom: null added)');
  // A newer app's manifest.
  const newer = parse(readFileSync(path.join(FIX, 'v3-newer.json'), 'utf8'));
  assert(newer.ok === false && newer.code === WS.MANIFEST_NEWER_CODE && /newer version of The Curator/.test(newer.error)
    && /leave it exactly as it is/.test(newer.error) && /version 3/.test(newer.error),
  'version 3: refused as "a newer version", naming the version, "leave it exactly as it is"', JSON.stringify(newer));
  assert(!/\bremov|\bfix\b/i.test(newer.error), '…and never says fix or remove', newer.error);

  // The derived envelope ownership + one REAL write through the store.
  for (const [name, want2] of Object.entries(ROWS)) {
    const p = await newProject();
    mkdirSync(fdir(p), { recursive: true });
    const text = readFileSync(path.join(FIX, `${name}.json`), 'utf8');
    writeFileSync(mpath(p), text);
    const m = JSON.parse(text);
    for (const d of m.documents) writeFileSync(path.join(fdir(p), d.slug), '# x\n');
    const idx = await WS.listFoundations(D, p);
    assert(idx.ok && idx.present, `${name}: listFoundations reads it`, idx.manifestError);
    const kinds = idx.sources.map((g) => g.kind);
    eq(JSON.stringify(kinds), JSON.stringify(want2.kinds), `${name}: sources[] kinds ${JSON.stringify(want2.kinds)}`);
    eq(bytesOf(p), text, `${name}: a READ never rewrites the file`);
    if (want2.afterWrite !== null) {
      const slug = m.documents[0].slug;
      const w = await WS.setFoundationStartState(D, p, slug, m.documents[0].readFirst ? 'on-request' : 'read-first');
      assert(w.ok && w.changed, `${name}: a routing write succeeds`, JSON.stringify(w).slice(0, 200));
      const after = manifestOf(p);
      eq(after.version, want2.afterWrite, `${name}: written back at version ${want2.afterWrite}`);
      const keys = Object.keys(after).join(',');
      eq(keys, want2.afterWrite === 1 ? 'version,ownership,repo,budgetBytes,order,documents' : 'version,sources,budgetBytes,order,documents',
        `${name}: top-level keys in writer order`);
      if (want2.afterWrite === 1) {
        // Only the flag moved: the rest is the v3.68 byte shape.
        const v = FROZEN.validateManifest(after);
        assert(v.ok, `${name}: the v3.68.0 validator accepts the rewrite`, v.error);
        eq(after.ownership, m.ownership, `${name}: the declared ownership is kept (${JSON.stringify(m.ownership)})`);
        eq(JSON.stringify(after.repo), JSON.stringify(m.repo), `${name}: repo is kept byte for byte`);
      } else {
        eq(FROZEN.validateManifest(after).ok, false, `${name}: an OLDER app refuses the v2 rewrite (never rewrites it)`);
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('3. Properties over random models: idempotent, the version gate, the older app');
{
  let seed = 69;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const HUMAN = { kind: 'human', harness: null, model: null, commissionedBy: null };
  let v1n = 0, v2n = 0, gateOk = true, idemOk = true, frozenV2Refused = true, frozenV1Accepted = true, docsEqual = true;
  const why = [];
  for (let n = 0; n < 400; n++) {
    const G = pick([0, 0, 1, 1, 1, 2, 3, 8]);
    const sources = [];
    for (let i = 1; i <= G; i++) {
      const folderRoot = rnd() < 0.5 ? `/srv/r${i}` : null;
      sources.push({ id: `s${i}`, root: folderRoot, remote: folderRoot && rnd() < 0.5 ? null : { owner: 'acme', repo: `r${i}`, ref: null, path: null },
        lastRefreshAt: null, lastRefreshCommit: null });
    }
    const documents = [];
    const nd = pick([0, 1, 2, 3, 5]);
    for (let j = 0; j < nd; j++) {
      const mirrored = G > 0 && rnd() < 0.5;
      const g = mirrored ? pick(sources).id : null;
      documents.push({
        slug: `d${j}.md`, role: pick(['architecture', 'guide', 'other']), title: `D${j}`,
        source: mirrored ? { kind: 'repo', path: `docs/d${j}.md`, group: g } : { kind: 'curator' },
        sha256: 'e'.repeat(64), bytes: 10 + j, updatedAt: null, commit: null, authoredBy: HUMAN,
        skeleton: false, readFirst: rnd() < 0.3, hidden: false, copiedFrom: !mirrored && rnd() < 0.5 ? 'dev' : null,
      });
    }
    const model = { version: 1, sources, budgetBytes: 204800, order: ['architecture', 'decisions', 'conventions', 'roadmap', 'api', 'guide', 'other'], documents };
    const hasRepo = documents.some((d) => d.source.kind === 'repo');
    const hasKept = documents.some((d) => d.source.kind !== 'repo');
    const expressible = G <= 1 && !(hasRepo && hasKept) && !(hasKept && G >= 1);
    const out = WS.serialiseManifest(model);
    const obj = JSON.parse(out);
    if ((obj.version === 1) !== expressible) { gateOk = false; why.push(`gate n=${n} G=${G} repo=${hasRepo} kept=${hasKept} v=${obj.version}`); }
    const back = WS.parseFoundationsManifest(obj);
    if (!back.ok) { idemOk = false; why.push(`reparse n=${n}: ${back.error}`); continue; }
    if (WS.serialiseManifest(back.manifest) !== out) { idemOk = false; why.push(`idem n=${n}`); }
    const old = FROZEN.validateManifest(obj);
    if (obj.version === 2) { v2n++; if (old.ok) frozenV2Refused = false; }
    else {
      v1n++;
      if (!old.ok) { frozenV1Accepted = false; why.push(`frozen v1 n=${n}: ${old.error}`); continue; }
      // The documents v3.68 sees are the documents v3.69 sees, minus `group`.
      const mine = back.manifest.documents.map((d) => ({ ...d, source: d.source.kind === 'repo' ? { kind: 'repo', path: d.source.path } : d.source }));
      if (JSON.stringify(old.manifest.documents) !== JSON.stringify(mine)) { docsEqual = false; why.push(`docs n=${n}`); }
    }
  }
  assert(v1n > 50 && v2n > 50, `the random mix covers both versions (v1 ${v1n}, v2 ${v2n})`);
  assert(gateOk, 'THE VERSION GATE: version 2 exactly when v1 cannot express the model (property 3)', why.slice(0, 3).join(' | '));
  assert(idemOk, 'IDEMPOTENT: serialise(parse(serialise(m))) === serialise(m), v1 and v2 (property 2)', why.slice(0, 3).join(' | '));
  assert(frozenV2Refused, `THE OLDER APP (frozen v3.68.0 validator) REFUSES every v2 output (${v2n})`);
  assert(frozenV1Accepted, `…and ACCEPTS every v1 output (${v1n})`, why.slice(0, 3).join(' | '));
  assert(docsEqual, '…seeing exactly the documents this app sees (deep-equal, group aside)', why.slice(0, 3).join(' | '));
  const ownershipNull = FROZEN.validateManifest({ version: 1, ownership: null, repo: { root: '/a', remote: null, lastRefreshAt: null, lastRefreshCommit: null }, budgetBytes: 204800, documents: [
    { slug: 'a.md', role: 'other', source: { kind: 'repo', path: 'docs/README.md' }, sha256: 'a'.repeat(64), bytes: 1 },
    { slug: 'b.md', role: 'other', source: { kind: 'repo', path: 'docs/README.md' }, sha256: 'a'.repeat(64), bytes: 1 },
    { slug: 'c.md', role: 'other', source: { kind: 'curator' }, sha256: 'a'.repeat(64), bytes: 1 }] });
  assert(ownershipNull.ok, 'WHY v2 (CONTRACT §2.4): v3.68 would ACCEPT a mix written as v1 with ownership null — and lose every group id, so the gate is the only safe encoding');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. The v2 validator, rule by rule; unknown keys survive a rewrite');
const V2 = (over = {}) => ({
  version: 2,
  sources: [
    { id: 's1', root: '/srv/a', remote: null, lastRefreshAt: null, lastRefreshCommit: null },
    { id: 's2', root: null, remote: { owner: 'acme', repo: 'lumina', ref: 'main', path: null }, lastRefreshAt: null, lastRefreshCommit: null },
  ],
  budgetBytes: 204800,
  order: ['architecture', 'decisions', 'conventions', 'roadmap', 'api', 'guide', 'other'],
  documents: [
    { slug: 'a.md', role: 'architecture', title: 'A', source: { kind: 'repo', path: 'docs/architecture.md', group: 's1' }, sha256: 'a'.repeat(64), bytes: 1 },
    { slug: 'b.md', role: 'architecture', title: 'B', source: { kind: 'repo', path: 'docs/architecture.md', group: 's2' }, sha256: 'b'.repeat(64), bytes: 1 },
    { slug: 'c.md', role: 'other', title: 'C', source: { kind: 'curator' }, copiedFrom: 'dev', sha256: 'c'.repeat(64), bytes: 1 },
  ],
  ...over,
});
{
  const good = WS.parseFoundationsManifest(V2());
  assert(good.ok, 'a well-formed v2 reads', good.error);
  assert(good.ok && good.manifest.documents[0].source.group === 's1' && good.manifest.documents[1].source.group === 's2',
    'THE SAME PATH IN TWO GROUPS is allowed — two repositories, two files');
  const bad = (label, obj, re) => {
    const r = WS.parseFoundationsManifest(obj);
    assert(r.ok === false && re.test(r.error), label, JSON.stringify(r).slice(0, 200));
  };
  const d0 = V2().documents;
  bad('a mirrored document whose group names no source is refused', V2({ documents: [{ ...d0[0], source: { kind: 'repo', path: 'x.md', group: 's7' } }] }), /names no source/);
  bad('a mirrored document with no group is refused', V2({ documents: [{ ...d0[0], source: { kind: 'repo', path: 'x.md' } }] }), /names no source/);
  bad('a kept document carrying a group is refused', V2({ documents: [{ ...d0[2], source: { kind: 'curator', group: 's1' } }] }), /cannot name a source group/);
  bad('ONE PATH TWICE IN ONE GROUP is refused', V2({ documents: [d0[0], { ...d0[0], slug: 'a2.md', source: { kind: 'repo', path: './docs/architecture.md', group: 's1' } }] }), /mirrored twice/);
  bad('a duplicate group id is refused', V2({ sources: [V2().sources[0], V2().sources[0]] }), /listed twice/);
  bad('a group id outside s1…s99 is refused', V2({ sources: [{ ...V2().sources[0], id: 'x' }], documents: [] }), /not a source id/);
  bad('a 9th source is refused (the cap)', V2({ sources: Array.from({ length: 9 }, (_, i) => ({ id: `s${i + 1}`, root: `/r${i}`, remote: null })), documents: [] }), /over the 8 cap/);
  bad('sources must be an array', V2({ sources: {} }), /sources is not an array/);
  const withV1Keys = WS.parseFoundationsManifest(V2({ ownership: 'repo', repo: null }));
  assert(withV1Keys.ok && withV1Keys.notes.some((n) => /version 1 only/.test(n)) && !/"ownership"/.test(WS.serialiseManifest(withV1Keys.manifest)),
    'v1\'s `ownership`/`repo` in a v2 file are ignored, named, and never written back');
  // Unknown keys: top level, per document, per group — kept in read order.
  const withExtras = V2({ futureTop: { a: 1 } });
  withExtras.documents = withExtras.documents.map((d, i) => (i === 0 ? { ...d, futureDoc: 'x' } : d));
  withExtras.sources = withExtras.sources.map((g, i) => (i === 1 ? { ...g, futureGroup: [1, 2] } : g));
  const pe = WS.parseFoundationsManifest(withExtras);
  const reOut = JSON.parse(WS.serialiseManifest(pe.manifest));
  assert(reOut.futureTop && reOut.futureTop.a === 1 && reOut.documents[0].futureDoc === 'x' && JSON.stringify(reOut.sources[1].futureGroup) === '[1,2]',
    'unknown top-level, document and GROUP keys survive a rewrite (spec §1 rule 2)', JSON.stringify(reOut).slice(0, 300));
  eq(Object.keys(reOut).pop(), 'futureTop', '…after the known keys');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. A MIXED project: written + copied + folder mirror + GitHub sources');
const LUMINA = { 'docs/architecture.md': '# Lumina architecture\n\nFrom GitHub.\n', 'docs/guide.md': '# Lumina guide\n', 'README.md': '# Lumina\n' };
const ATLAS = { 'docs/architecture.md': '# Atlas architecture\n', 'notes.md': '# Atlas notes\n' };
const gh = makeGitHub({ 'acme/lumina': { files: LUMINA, commit: '1'.repeat(40) }, 'acme/atlas': { files: ATLAS, commit: '2'.repeat(40) } });
const MX = await newProject();
const MIRROR_DIR = folder('mirror-src', { 'architecture.md': '# Folder architecture\n', 'decisions.md': '# Folder decisions\n' });
const COPY_DIR = folder('dev', { 'architecture.md': '# Copied architecture\n', 'conventions.md': '# Conventions\n' });
{
  const w = await WS.saveFoundation(D, MX, { slug: 'architecture.md', role: 'architecture', text: '# Written here\n' });
  assert(w.ok, 'a written document', w.message);
  eq(manifestOf(MX).version, 1, '…a kept-only project is v1');
  const c = await WS.addFoundationsFromFolder(D, MX, { root: COPY_DIR, mode: 'copy', files: [{ path: 'architecture.md' }, { path: 'conventions.md' }] });
  assert(c.ok && c.mode === 'copy', 'copy once from a folder', JSON.stringify(c).slice(0, 300));
  assert(c.added.includes('architecture-dev.md') && (c.landed || []).some((x) => x.slug === 'architecture-dev.md' && x.from === 'architecture.md'),
    'a copied architecture.md beside the written one LANDS as architecture-dev.md, and says so (§4.5)', JSON.stringify(c.landed));
  eq(manifestOf(MX).version, 1, '…still v1 (kept only)');
  const curatorBefore = manifestOf(MX).documents.map((d) => JSON.stringify(d));
  const fm = await WS.addFoundationsFromFolder(D, MX, { root: MIRROR_DIR, mode: 'mirror', files: [{ path: 'architecture.md' }, { path: 'decisions.md' }] });
  assert(fm.ok && fm.mode === 'mirror' && fm.groupCreated === true && fm.groupId === 's1', 'a folder MIRROR starts source s1', JSON.stringify(fm).slice(0, 300));
  const m1 = manifestOf(MX);
  eq(m1.version, 2, 'kept + mirrored: the manifest is now version 2');
  assert(curatorBefore.every((s) => m1.documents.some((d) => JSON.stringify(d) === s)),
    'every kept entry is BYTE-EQUAL to what it was in v1, apart from its position (CONTRACT §2.3)');
  eq(FROZEN.validateManifest(m1).ok, false, 'the frozen v3.68.0 validator refuses it — an older machine never rewrites it');
  const gr = await WS.addFoundationsFromRemote(D, MX, { remote: 'acme/lumina', tokenSource: 'sync', files: [{ path: 'docs/architecture.md' }, { path: 'docs/guide.md' }], fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  assert(gr.ok && gr.groupId === 's2' && gr.groupCreated === true, 'Add from GitHub starts source s2', JSON.stringify(gr).slice(0, 300));
  assert(Array.isArray(gr.addedFiles) && gr.addedFiles.some((a) => a.path === 'docs/architecture.md' && a.slug === 'architecture-lumina.md'),
    '…its architecture.md lands as architecture-lumina.md, reported as {path, slug}', JSON.stringify(gr.addedFiles));
  assert(gh.calls.every((c) => /ghp_thisisasecret/.test(String(c.auth))), '…read with the SYNC token it was asked for');
  const ga = await WS.addFoundationsFromRemote(D, MX, { remote: 'https://github.com/acme/atlas.git', files: [{ path: 'docs/architecture.md' }], fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  assert(ga.ok && ga.groupId === 's3', 'a DIFFERENT repository adds a source (s3) — it no longer switches one (§3.2)', JSON.stringify(ga).slice(0, 200));
  const again = await WS.addFoundationsFromRemote(D, MX, { remote: 'ACME/Lumina', files: [{ path: 'README.md' }], fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  assert(again.ok && again.groupId === 's2' && again.groupCreated === false, 'the same repository (any case) JOINS its source', JSON.stringify(again).slice(0, 200));
  const m2 = manifestOf(MX);
  eq(m2.sources.length, 3, 'three sources on disk');
  eq(m2.sources.find((g) => g.id === 's2').tokenSource, 'sync', 'the token SOURCE is recorded on the group (never a token) — addendum 4');
  assert(!JSON.stringify(m2).includes(SYNC_TOKEN) && !JSON.stringify(m2).includes(CONFIG_TOKEN), '…and no token value is anywhere in the manifest');
  eq(m2.sources.find((g) => g.id === 's3').tokenSource, undefined, 'a source added without naming a token source records none (the default applies)');

  const idx = await WS.listFoundations(D, MX);
  eq(idx.ownership, 'mixed', 'the envelope ownership reads "mixed" (display only)');
  eq(idx.manifestVersion, 2, 'manifestVersion 2');
  eq(JSON.stringify(Object.keys(idx.sources[0])), JSON.stringify(['id', 'kind', 'label', 'reachableHere', 'remote', 'lastRefreshAt', 'lastRefreshCommit', 'documentCount']),
    'sources[] carries exactly the §1.6/addendum-2 fields');
  const s1 = idx.sources.find((g) => g.id === 's1'), s2 = idx.sources.find((g) => g.id === 's2');
  assert(s1.kind === 'folder' && s1.label === 'mirror-src' && s1.reachableHere === true && s1.documentCount === 2, 'the folder source: kind, basename label, reachable, 2 documents', JSON.stringify(s1));
  assert(s2.kind === 'github' && s2.label === 'acme/lumina' && s2.reachableHere === false && s2.documentCount === 3, 'the GitHub source: owner/repo label, 3 documents', JSON.stringify(s2));
  assert(!JSON.stringify(idx.sources).includes(realpathSync(MIRROR_DIR)), 'the folder PATH is not in sources[] (label only)');
  eq(idx.repo, null, 'repo is null with several sources');
  const byslug = Object.fromEntries(idx.documents.map((d) => [d.slug, d]));
  eq(byslug['decisions.md'].source.group, 's1', 'a v2 index row carries source.group');
  eq(byslug['decisions.md'].freshness, 'fresh', 'freshness of a folder document: fresh against ITS OWN folder');
  eq(byslug['guide.md'].freshness, 'unreachable', 'a GitHub document: unreachable (no network on a read)');
  eq(byslug['architecture.md'].freshness, 'n/a', 'a kept document: n/a');
  writeFileSync(path.join(MIRROR_DIR, 'decisions.md'), '# Folder decisions, edited\n');
  eq((await WS.listFoundations(D, MX)).documents.find((d) => d.slug === 'decisions.md').freshness, 'stale', 'an edit in the folder reads stale');
  const summary = (await WS.readWorkingState(D, { project: MX })).foundations;
  eq(Object.keys(summary).join(','), 'present,count,totalBytes,staleCount,unreachableCount,skeletonCount,readFirstCount,onRequestCount,budgetExceeded,orphanFileCount,manifestError,readingBudgetBytes,readingBudgetDefaulted,hiddenCount',
    'summariseFoundations keeps its v3.68 keys exactly (the D3 ceiling)');
  const ctx = await WS.getProjectContext(D, MX);
  assert(Array.isArray(ctx.foundations.sources) && ctx.foundations.sources.length === 3, 'get_project_context carries foundations.sources for a v2 project (§3.5)');
  assert(ctx.foundations.index.every((r) => r.source.kind !== 'repo' || /^s\d$/.test(r.source.group)), '…and every mirrored index row names its group');
  // A v1 project's context: nothing new.
  const V1P = await newProject();
  await WS.saveFoundation(D, V1P, { slug: 'a.md', text: '# A\n' });
  const ctx1 = await WS.getProjectContext(D, V1P);
  assert(!('sources' in ctx1.foundations), 'a v1 project\'s get_project_context has NO sources key (byte-identical, §3.5)');
  const V1M = await newProject();
  mkdirSync(fdir(V1M), { recursive: true });
  writeFileSync(mpath(V1M), readFileSync(path.join(FIX, 'v1-folder-mirror.json')));
  for (const s of ['architecture.md', 'guide.md']) writeFileSync(path.join(fdir(V1M), s), '# x\n');
  const ctxm = await WS.getProjectContext(D, V1M);
  assert(!('sources' in ctxm.foundations) && ctxm.foundations.index.every((r) => !('group' in r.source)),
    'a v1 MIRROR\'s context carries no sources and no source.group');
  const idxm = await WS.listFoundations(D, V1M);
  assert(idxm.sources.length === 1 && idxm.sources[0].id === 's1' && idxm.sources[0].kind === 'folder', '…while the app envelope always carries sources[] (s1 for a v1 mirror — addendum 2)');
}

// ═════════════════════════════════════════════════════════════════════════
section('6. Refresh every source: one GitHub source fails, the others refresh, the manifest is written ONCE');
{
  const failing = makeGitHub({ 'acme/lumina': { files: { ...LUMINA, 'docs/guide.md': '# Lumina guide v2\n' }, commit: '3'.repeat(40) }, 'acme/atlas': { files: { ...ATLAS, 'docs/architecture.md': '# Atlas v2\n' }, commit: '4'.repeat(40) } },
    { fail: new Set(['acme/lumina']) });
  const before = manifestOf(MX);
  const luminaDocs = ['architecture-lumina.md', 'guide.md', 'readme.md'].map((s) => [s, sha(readFileSync(path.join(fdir(MX), s)))]);
  const writes = [];
  WS.__setManifestWriteSpy((abs) => writes.push(abs));
  const all = await WS.refreshFoundationsFromRepo(D, MX, null, { fetchImpl: failing.fetchImpl, sleepImpl: fakeSleep });
  WS.__setManifestWriteSpy(null);
  assert(all.ok === true && Array.isArray(all.groups) && all.groups.length === 3, 'refresh with no group refreshes EVERY source (3 groups reported)', JSON.stringify(all).slice(0, 400));
  const g = Object.fromEntries(all.groups.map((x) => [x.id, x]));
  assert(g.s1.ok && g.s1.refreshed.includes('decisions.md'), 'the folder source refreshed its edited document', JSON.stringify(g.s1));
  assert(g.s3.ok && g.s3.refreshed.includes('architecture-atlas.md'), 'the other GitHub source refreshed', JSON.stringify(g.s3));
  assert(g.s2.ok === false && typeof g.s2.reason === 'string' && g.s2.message, 'the failing source is REPORTED with its reason', JSON.stringify(g.s2));
  eq(writes.length, 1, 'the manifest was written ONCE');
  const after = manifestOf(MX);
  eq(JSON.stringify(after.sources.find((x) => x.id === 's2')), JSON.stringify(before.sources.find((x) => x.id === 's2')), 'the failed group\'s record is untouched');
  assert(luminaDocs.every(([s, h]) => sha(readFileSync(path.join(fdir(MX), s))) === h), '…and every one of its documents is byte-identical');
  assert(after.sources.find((x) => x.id === 's1').lastRefreshAt !== before.sources.find((x) => x.id === 's1').lastRefreshAt, 'the folder group recorded its refresh');
  assert(all.refreshed.includes('decisions.md') && all.refreshed.includes('architecture-atlas.md'), 'the top-level arrays aggregate every group (v3.68 callers read one shape)');
  const one = await WS.refreshFoundationsFromRepo(D, MX, null, { group: 's3', fetchImpl: failing.fetchImpl, sleepImpl: fakeSleep });
  assert(one.ok && one.groups.length === 1 && one.groups[0].id === 's3' && one.source === 'remote', 'refresh {group} refreshes that group only, in v3.68\'s remote shape', JSON.stringify(one).slice(0, 200));
  const unk = await WS.refreshFoundationsFromRepo(D, MX, null, { group: 's9' });
  eq(unk.reason, 'unknown-group', 'a group this project does not have is refused');
  const files = await WS.refreshFoundationsFromRepo(D, MX, null, { files: [{ path: 'docs/x.md' }] });
  eq(files.reason, 'group-required', 'files with several sources and no group: group-required');
  const kept = await newProject();
  await WS.saveFoundation(D, kept, { slug: 'k.md', text: '# K\n' });
  const ns = await WS.refreshFoundationsFromRepo(D, kept, null, {});
  assert(ns.ok === false && ns.reason === 'no-sources' && /Copies and documents written here never change on their own/.test(ns.message),
    'a kept-only project answers no-sources, in the contract\'s words');
  const sw = await WS.setFoundationsSource(D, MX, { remote: 'acme/lumina', fetchImpl: gh.fetchImpl });
  eq(sw.reason, 'group-required', 'a source switch with several sources and no group is refused, not applied to the first');
}

// ═════════════════════════════════════════════════════════════════════════
section('7. Collisions, the cap, the lock, and one writer per FILE (D4)');
{
  eq(WS.landingSlug('architecture.md', new Set(), 'lumina'), 'architecture.md', 'landingSlug: a free name is kept');
  eq(WS.landingSlug('architecture.md', new Set(['architecture.md']), 'Lumina Docs'), 'architecture-lumina-docs.md', 'a taken name gets -<tag>, slugged');
  eq(WS.landingSlug('architecture.md', new Set(['architecture.md', 'architecture-lumina.md']), 'lumina'), 'architecture-lumina-2.md', '…then -<tag>-2');
  const long = `${'a'.repeat(60)}.md`;
  const l = WS.landingSlug(long, new Set([long]), 'lumina');
  assert(l && l.length <= 64 && l.endsWith('-lumina.md'), 'a long stem is trimmed so the whole name stays ≤ 64 characters', l);
  const full = new Set(['x.md', 'x-t.md', ...Array.from({ length: 98 }, (_, i) => `x-t-${i + 2}.md`)]);
  eq(WS.landingSlug('x.md', full, 't'), null, 'with -2 … -99 all taken: null (refused as "no free document name")');
  const taken = new Set(['a.md']);
  let clash = null, n = 0;
  for (;;) {
    const s = WS.landingSlug('a.md', taken, 't');
    if (s === null) break;
    if (taken.has(s)) { clash = s; break; }
    taken.add(s); n++;
  }
  assert(clash === null && n === 99, `landingSlug never returns a taken slug (99 distinct names, then null) — got ${n}`, clash);

  // An explicit slug that is taken is refused, never moved.
  const exp = await WS.addFoundationsFromRemote(D, MX, { remote: 'acme/atlas', files: [{ path: 'notes.md', slug: 'conventions.md' }], fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  assert(exp.ok === false && exp.reason === 'nothing-added' && exp.refused.some((r) => /curator-authored/.test(r.reason)),
    'an EXPLICIT slug taken by a kept document is refused, never renamed', JSON.stringify(exp).slice(0, 300));

  // D4 — a save over a MIRRORED slug is refused; a new document is fine.
  const guideBefore = sha(readFileSync(path.join(fdir(MX), 'guide.md')));
  const overGh = await WS.saveFoundation(D, MX, { slug: 'guide.md', text: '# hand-edited\n' });
  assert(overGh.ok === false && overGh.reason === 'ownership-mismatch' && /"guide\.md" is mirrored from acme\/lumina — edit it there and refresh\. Nothing was written\./.test(overGh.message),
    'a save over a GitHub-mirrored document: ownership-mismatch, "<slug> is mirrored from <label>"', overGh.message);
  eq(sha(readFileSync(path.join(fdir(MX), 'guide.md'))), guideBefore, '…and its bytes are untouched');
  const overFolder = await WS.saveFoundation(D, MX, { slug: 'decisions.md', text: '# hand\n', authoredBy: { kind: 'agent', harness: 'x', model: 'y', instructedBy: 'user' } });
  assert(overFolder.ok === false && /mirrored from mirror-src/.test(overFolder.message), 'a save over a FOLDER-mirrored document is refused too (any caller)', overFolder.message);
  const fresh = await WS.saveFoundation(D, MX, { slug: 'agent-notes.md', text: '# Agent notes\n', authoredBy: { kind: 'agent', harness: 'x', model: 'y', instructedBy: 'user' } });
  assert(fresh.ok && fresh.ownership === 'mixed', 'a NEW document is written into the mixed project (D4)', JSON.stringify(fresh).slice(0, 200));

  // The 8-source cap, at commit.
  const CAP = await newProject();
  const repos = {};
  for (let i = 1; i <= 9; i++) repos[`acme/r${i}`] = { files: { 'README.md': `# R${i}\n` }, commit: String(i).repeat(40) };
  const cgh = makeGitHub(repos);
  for (let i = 1; i <= 8; i++) {
    const r = await WS.addFoundationsFromRemote(D, CAP, { remote: `acme/r${i}`, files: [{ path: 'README.md' }], fetchImpl: cgh.fetchImpl, sleepImpl: fakeSleep });
    if (!r.ok) assert(false, `source ${i} added`, JSON.stringify(r).slice(0, 200));
  }
  eq(manifestOf(CAP).sources.length, 8, 'eight sources');
  const capBefore = docsFingerprint(CAP);
  const ninth = await WS.addFoundationsFromRemote(D, CAP, { remote: 'acme/r9', files: [{ path: 'README.md' }], fetchImpl: cgh.fetchImpl, sleepImpl: fakeSleep });
  assert(ninth.ok === false && ninth.reason === 'too-many-sources' && ninth.cap === 8, 'a 9th source is refused at commit (too-many-sources)', JSON.stringify(ninth).slice(0, 200));
  eq(docsFingerprint(CAP), capBefore, '…and nothing was written');
  const ninthLocal = await WS.addFoundationsFromFolder(D, CAP, { root: folder('ninth', { 'n.md': '# n\n' }), mode: 'mirror', files: [{ path: 'n.md' }] });
  eq(ninthLocal.reason, 'too-many-sources', 'a 9th FOLDER source is refused the same way');
  const copyOk = await WS.addFoundationsFromFolder(D, CAP, { root: folder('ninth2', { 'n.md': '# n\n' }), mode: 'copy', files: [{ path: 'n.md' }] });
  assert(copyOk.ok, 'a COPY is not a source — it is still allowed at the cap', JSON.stringify(copyOk).slice(0, 200));

  // The lock.
  const hold = await acquireFileLock(path.join(DOMAINS, D), { op: 'suite' });
  const lk = [
    await WS.addFoundationsFromRemote(D, MX, { remote: 'acme/atlas', files: [{ path: 'notes.md' }], fetchImpl: gh.fetchImpl }),
    await WS.addFoundationsFromFolder(D, MX, { root: MIRROR_DIR, mode: 'mirror', files: [{ path: 'architecture.md' }] }),
    await WS.refreshFoundationsFromRepo(D, MX, null, { fetchImpl: gh.fetchImpl }),
    await WS.removeFoundation(D, MX, 'guide.md'),
  ];
  await hold();
  assert(lk.every((r) => r.reason === 'locked'), 'add-remote, add-local, refresh-all and remove all refuse under a held lock', JSON.stringify(lk.map((r) => r.reason)));
}

// ═════════════════════════════════════════════════════════════════════════
section('8. Delete: a group goes with its last document; back to v1; no tombstone');
{
  const P = await newProject();
  await WS.saveFoundation(D, P, { slug: 'notes.md', text: '# Notes\n' });
  const v1bytes = bytesOf(P);
  const add = await WS.addFoundationsFromRemote(D, P, { remote: 'acme/atlas', files: [{ path: 'notes.md' }], fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  assert(add.ok && add.addedFiles[0].slug === 'notes-atlas.md', 'a v1 kept project + one GitHub add', JSON.stringify(add).slice(0, 200));
  eq(manifestOf(P).version, 2, '…is version 2');
  const rm = await WS.removeFoundation(D, P, 'notes-atlas.md');
  assert(rm.ok && rm.origin === 'github' && rm.groupRemoved === true && rm.sourceKept === true
    && rm.source && rm.source.label === 'acme/atlas' && rm.source.path === 'notes.md' && rm.group && rm.group.id === 's1',
  'removing the LAST GitHub document removes its group in the same write, and says what is kept', JSON.stringify(rm));
  const m = manifestOf(P);
  eq(m.version, 1, 'PROPERTY 4: the project stops mixing and is written at v1 again');
  eq(FROZEN.validateManifest(m).ok, true, '…which an older machine reads once more');
  eq(bytesOf(P), WS.serialiseManifest(WS.parseFoundationsManifest(JSON.parse(v1bytes)).manifest),
    '…byte-identical to a v1 rewrite of what it was before the add (v3.68\'s own first-rewrite shape)');
  const wr = await WS.removeFoundation(D, P, 'notes.md');
  assert(wr.ok && wr.origin === 'written' && wr.sourceKept === false && wr.groupRemoved === false && wr.group === null, 'a written document: origin written, nothing kept elsewhere', JSON.stringify(wr));

  // No tombstone: a removed mirror is not brought back by a refresh.
  const Q = await newProject();
  const src = folder('tomb', { 'a.md': '# A\n', 'b.md': '# B\n' });
  await WS.addFoundationsFromFolder(D, Q, { root: src, mode: 'mirror', files: [{ path: 'a.md' }, { path: 'b.md' }] });
  const r1 = await WS.removeFoundation(D, Q, 'a.md');
  assert(r1.ok && r1.origin === 'folder' && r1.groupRemoved === false, 'removing one of two folder documents keeps the group');
  const rf = await WS.refreshFoundationsFromRepo(D, Q, null, {});
  assert(rf.ok && !manifestOf(Q).documents.some((d) => d.slug === 'a.md') && !existsSync(path.join(fdir(Q), 'a.md')),
    'a refresh does NOT bring the deleted mirror back (no tombstone needed)', JSON.stringify(rf).slice(0, 200));
  const r2 = await WS.removeFoundation(D, Q, 'b.md');
  assert(r2.ok && r2.groupRemoved === true && manifestOf(Q).sources === undefined && manifestOf(Q).repo === null,
    'the last folder document takes the group with it (v1, repo null)', JSON.stringify(manifestOf(Q)).slice(0, 200));
  // A declared (empty) source survives a delete in another group.
  const R = await newProject();
  await WS.initFoundations(D, R, { ownership: 'repo', remote: 'acme/lumina' });
  await WS.addFoundationsFromFolder(D, R, { root: COPY_DIR, mode: 'copy', files: [{ path: 'conventions.md' }] });
  eq(manifestOf(R).version, 2, 'a copy beside a DECLARED (empty) source is v2 (v1 cannot say both)');
  await WS.removeFoundation(D, R, 'conventions.md');
  const mr = manifestOf(R);
  assert(mr.version === 1 && mr.repo && mr.repo.remote.repo === 'lumina', 'removing the copy leaves the declared source — and v1 again', JSON.stringify(mr).slice(0, 200));
}

// ═════════════════════════════════════════════════════════════════════════
section('9. A folder mirror roots at the checkout top level; the advisory repo_root refresh');
if (!gitOk) {
  skip('git is not installed — the top-level rooting and repo_root assertions are skipped');
} else {
  const CO = folder('second-brain', { 'docs/dev/decisions-agents.md': '# Decisions\n', 'docs/dev/wiki-pipeline.md': '# Pipeline\n', 'README.md': '# SB\n' });
  git(CO, 'init', '-q');
  git(CO, 'remote', 'add', 'origin', 'https://github.com/acme/second-brain.git');
  const P = await newProject();
  const add = await WS.addFoundationsFromFolder(D, P, { root: path.join(CO, 'docs', 'dev'), mode: 'mirror', files: [{ path: 'decisions-agents.md' }] });
  assert(add.ok && add.groupCreated, 'mirroring a SUBFOLDER of a checkout', JSON.stringify(add).slice(0, 300));
  let m = manifestOf(P);
  eq(m.repo.root, realpathSync(CO), 'the source is rooted at the checkout\'s TOP LEVEL, not the picked subfolder (§3.3)');
  eq(m.documents[0].source.path, 'docs/dev/decisions-agents.md', '…the path rebased to it — the same path GitHub uses');
  eq(JSON.stringify(m.repo.remote), JSON.stringify({ owner: 'acme', repo: 'second-brain', ref: null, path: null }), '…and origin recorded with path null');
  eq(add.addedFiles[0].path, 'decisions-agents.md', 'addedFiles names the path as the caller sent it');
  const join = await WS.addFoundationsFromFolder(D, P, { root: path.join(CO, 'docs'), files: [{ path: 'dev/wiki-pipeline.md' }] });
  assert(join.ok && join.mode === 'mirror' && join.groupCreated === false && manifestOf(P).sources === undefined,
    'a folder INSIDE the source joins it (no mode needed); still one source, v1', JSON.stringify(join).slice(0, 200));

  // The advisory repo_root refresh: (a) the folder source, from its own folder.
  writeFileSync(path.join(CO, '.curator-project'), `${D}/${P}\n`);
  writeFileSync(path.join(CO, 'docs/dev/decisions-agents.md'), '# Decisions, edited\n');
  const sv = await WS.saveWorkingState(D, { project: P, scope: 'adv', machine: 'box', headline: 'h', nowState: 'n', repoRoot: CO });
  assert(sv.ok && sv.foundationsRefresh && sv.foundationsRefresh.attempted && sv.foundationsRefresh.ok
    && sv.foundationsRefresh.refreshed.includes('decisions-agents.md'), '(a) repo_root refreshes the folder source inside the checkout', JSON.stringify(sv.foundationsRefresh).slice(0, 300));

  // (b) a GitHub source whose repository is this checkout's origin.
  const G = await newProject();
  const gg = makeGitHub({ 'acme/second-brain': { files: { 'README.md': '# SB\n' } } });
  await WS.addFoundationsFromRemote(D, G, { remote: 'acme/second-brain', files: [{ path: 'README.md' }], fetchImpl: gg.fetchImpl, sleepImpl: fakeSleep });
  writeFileSync(path.join(CO, '.curator-project'), `${D}/${G}\n`);
  writeFileSync(path.join(CO, 'README.md'), '# SB, edited in the checkout\n');
  const calls = gg.calls.length;
  const sv2 = await WS.saveWorkingState(D, { project: G, scope: 'adv', machine: 'box', headline: 'h', nowState: 'n', repoRoot: CO });
  assert(sv2.foundationsRefresh && sv2.foundationsRefresh.ok && sv2.foundationsRefresh.refreshed.includes('readme.md') && sv2.foundationsRefresh.source === 'local',
    '(b) a GitHub source whose origin is this checkout is refreshed FROM THE CHECKOUT', JSON.stringify(sv2.foundationsRefresh).slice(0, 300));
  eq(gg.calls.length, calls, '…without a single network request');
  eq(manifestOf(G).repo.root, null, '…and it STAYS a GitHub source: root is not set (the v3.65.1 switch is not undone)');
  // Neither: skipped with the contract's reason.
  const N = await newProject();
  await WS.addFoundationsFromRemote(D, N, { remote: 'acme/atlas', files: [{ path: 'notes.md' }], fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  writeFileSync(path.join(CO, '.curator-project'), `${D}/${N}\n`);
  const sv3 = await WS.saveWorkingState(D, { project: N, scope: 'adv', machine: 'box', headline: 'h', nowState: 'n', repoRoot: CO });
  eq(sv3.foundationsRefresh.skipped, 'no source of this project is this checkout', 'a checkout that is none of the sources: skipped, named');

  // Freshness never crosses groups: two folders, same relative path.
  const T = await newProject();
  const A = folder('fa', { 'guide.md': '# A guide\n' });
  const B = folder('fb', { 'guide.md': '# B guide\n' });
  await WS.addFoundationsFromFolder(D, T, { root: A, mode: 'mirror', files: [{ path: 'guide.md' }] });
  await WS.addFoundationsFromFolder(D, T, { root: B, mode: 'mirror', files: [{ path: 'guide.md' }] });
  const ti = await WS.listFoundations(D, T);
  assert(ti.documents.length === 2 && ti.documents.every((d) => d.freshness === 'fresh'),
    'two folder sources with the SAME relative path: each document is fresh against its own folder', JSON.stringify(ti.documents.map((d) => [d.slug, d.source, d.freshness])));
}

// ═════════════════════════════════════════════════════════════════════════
section('10. The checklist annotations — decided by the store, per mode');
{
  const P = await newProject();
  const DEV = folder('dev2', { 'architecture.md': '# A\n', 'notes.md': '# N\n' });
  await WS.saveFoundation(D, P, { slug: 'architecture.md', text: '# written\n' });
  await WS.addFoundationsFromFolder(D, P, { root: DEV, mode: 'copy', files: [{ path: 'notes.md' }] });
  const cand = [{ path: 'architecture.md', suggestedSlug: 'architecture.md' }, { path: 'notes.md', suggestedSlug: 'notes.md' }];
  const copy = await WS.annotateScanCandidates(D, P, { mode: 'copy', root: DEV }, cand);
  assert(copy.ok && copy.mode === 'copy', 'copy mode annotates', JSON.stringify(copy).slice(0, 200));
  const c0 = copy.candidates[0], c1 = copy.candidates[1];
  assert(c0.alreadyAdded === false && c0.landsAs === 'architecture-dev2.md' && c0.suggestedSlug === 'architecture.md',
    'a name taken by a WRITTEN document is not "already added" — it lands as architecture-dev2.md', JSON.stringify(c0));
  assert(c1.alreadyAdded === true && c1.alreadyAs === 'notes.md', 'the file already copied from this folder: already added, as notes.md', JSON.stringify(c1));
  const commit = await WS.addFoundationsFromFolder(D, P, { root: DEV, mode: 'copy', files: [{ path: 'architecture.md' }] });
  eq(commit.added[0], c0.landsAs, 'the commit lands exactly where the checklist said (landsAs)');
  const mir = await WS.annotateScanCandidates(D, P, { mode: 'mirror', root: DEV }, cand);
  assert(mir.ok && mir.mode === 'mirror' && mir.candidates.every((c) => c.alreadyAdded === false) && mir.group && mir.group.created === true,
    'mirror mode: nothing is "already added" as a MIRROR from a folder never mirrored', JSON.stringify(mir).slice(0, 300));
  // The same repository path through another source of the same repository.
  const gg = makeGitHub({ 'acme/lumina': { files: LUMINA } });
  await WS.addFoundationsFromRemote(D, P, { remote: 'acme/lumina', files: [{ path: 'docs/guide.md' }], fetchImpl: gg.fetchImpl, sleepImpl: fakeSleep });
  const rem = await WS.annotateScanCandidates(D, P, { remote: { owner: 'acme', repo: 'lumina', ref: null } },
    [{ path: 'docs/guide.md' }, { path: 'docs/architecture.md' }]);
  assert(rem.candidates[0].alreadyAdded === true && rem.candidates[0].alreadyAs === 'guide.md', 'GitHub: a path already mirrored from this repository is already added');
  eq(rem.candidates[1].landsAs, 'architecture-lumina.md', 'GitHub: a colliding name lands as <stem>-<repo>.md');
  eq(rem.inGitCheckout, false, 'inGitCheckout is false for a GitHub listing');
  if (gitOk) {
    const CO = folder('lumina', { 'docs/guide.md': '# g\n' });
    git(CO, 'init', '-q');
    git(CO, 'remote', 'add', 'origin', 'git@github.com:acme/lumina.git');
    const viaFolder = await WS.annotateScanCandidates(D, P, { mode: 'mirror', root: path.join(CO, 'docs') }, [{ path: 'guide.md' }]);
    assert(viaFolder.inGitCheckout === true && viaFolder.candidates[0].alreadyAdded === true && viaFolder.candidates[0].alreadyAs === 'guide.md',
      'the SAME file reached through a checkout of that repository is already added (one file, two ways)', JSON.stringify(viaFolder).slice(0, 300));
    const d = await WS.describeFolderSource(path.join(CO, 'docs'));
    assert(d.ok && d.inGitCheckout && d.topLevel === realpathSync(CO), 'describeFolderSource: inGitCheckout and the top level');
  } else {
    skip('git is not installed — the checkout annotation is skipped');
  }
}

eq(NET.length, 0, 'no real network request was attempted');
console.log(`\n${'═'.repeat(60)}\nPassed: ${passed}   Failed: ${failed}   Skipped: ${skipped}`);
if (failed) { console.log('FAILURES:'); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
