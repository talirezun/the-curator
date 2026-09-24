#!/usr/bin/env node
/**
 * OFFLINE — v3.68.0's TWO DOORS into a project's documents: "Add from this
 * computer" and "Add from GitHub".
 *
 * The maintainer, on v3.67.1: GitHub only appeared after a local add; after one
 * file was added no more could be; files came one at a time. The two doors
 * must be there at 0 documents and at N, a local add must take many files and
 * APPEND, and a GitHub add must list and mirror. Every rule is asserted by
 * BEHAVIOUR — the store driven against real temp folders, the GitHub read
 * against a fake API, the routes through a real Express app on a loopback
 * port, the DOM-free door rules called directly.
 *
 * NO REAL NETWORK: `globalThis.fetch` is replaced by a spy that THROWS for
 * anything but this suite's own loopback server; §12 asserts it recorded
 * nothing. Isolated via CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR
 * (set before any import) and __setDomainsDirOverride.
 *
 * Run with:  node scripts/test-foundations-add.js   (exit 0 = all green)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, symlinkSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-fnd-add-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
const SRC = path.join(TMP, 'src');          // folders the owner "picks"
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.on('exit', () => {
  try {
    if (path.dirname(TMP) === tmpdir() && path.basename(TMP).startsWith('curator-fnd-add-')) rmSync(TMP, { recursive: true, force: true });
  } catch { /* best effort */ }
});

const REAL_FETCH = globalThis.fetch.bind(globalThis);
const NET_ATTEMPTS = [];
let LOOPBACK = null;
globalThis.fetch = (url, init) => {
  if (LOOPBACK && String(url).startsWith(LOOPBACK)) return REAL_FETCH(url, init);
  NET_ATTEMPTS.push(String(url).slice(0, 200));
  throw new Error('NET BLOCKED BY SPY');
};

const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setUserDataDirOverride(USER_DATA);
__setDomainsDirOverride(DOMAINS);
const WS = await import('../src/brain/working-state.js');
const FA = await import('../src/public/next/shared/foundations-add.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${String(detail).slice(0, 300)}` : ''}`); }
}
function eq(label, a, b) { ok(label, a === b, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
function section(n) { console.log(`\n── ${n} ──`); }
const sha = (b) => createHash('sha256').update(b).digest('hex');
const gitBlobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// ── Fixtures ─────────────────────────────────────────────────────────────
const D = 'adom';
mkdirSync(path.join(DOMAINS, D, 'wiki'), { recursive: true });
writeFileSync(path.join(DOMAINS, D, 'CLAUDE.md'), `# ${D}\n`);
let projN = 0;
async function newProject() {
  const name = `p${++projN}`;
  const r = await WS.createProject(D, name, { brief: `# ${name}\n` });
  if (!r || r.ok === false) throw new Error('createProject failed: ' + JSON.stringify(r));
  return name;
}
const fdir = (p) => path.join(DOMAINS, D, 'state', p, WS.FOUNDATIONS_DIRNAME);
const manifestOf = (p) => JSON.parse(readFileSync(path.join(fdir(p), WS.FOUNDATIONS_MANIFEST_FILENAME), 'utf8'));
function folder(name, files) {
  const root = path.join(SRC, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}
/** Every file under a directory, with its sha — a whole-tree fingerprint. */
function fingerprint(dir) {
  const out = {};
  const walk = (d) => {
    let es = [];
    try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[path.relative(dir, p)] = sha(readFileSync(p));
    }
  };
  walk(dir);
  return JSON.stringify(out);
}

const NOTES = folder('notes', {
  'architecture.md': '# Architecture\n\nHow it fits.\n',
  'decisions.md': '# Decisions\n\n0001.\n',
  'sub/meeting.txt': 'A plain text note.\n',
  'image.png': 'not a document',
  'node_modules/pkg/readme.md': '# vendored\n',
  '.hidden/secret.md': '# hidden\n',
  'a/b/c/d/too-deep.md': '# deep\n',
});
const MORE = folder('more', { 'roadmap.md': '# Roadmap\n\nNext.\n', 'architecture.md': '# Another architecture\n' });
const OUTSIDE = folder('outside', { 'secret.md': '# Outside the picked folder\n' });

// ═════════════════════════════════════════════════════════════════════════
section('1. The listing: every document in the folder (all=1), within bounds');
{
  const s = await WS.scanRepoForFoundations(NOTES, { all: true });
  const paths = s.candidates.map((c) => c.path);
  ok('lists .md and .txt documents, relative paths, with sizes',
    paths.includes('architecture.md') && paths.includes('decisions.md') && paths.includes('sub/meeting.txt')
    && s.candidates.every((c) => Number.isInteger(c.bytes)), JSON.stringify(paths));
  ok('skips a non-document', !paths.includes('image.png'));
  ok('skips node_modules and hidden folders', !paths.some((p) => /node_modules|\.hidden/.test(p)), JSON.stringify(paths));
  ok('stops at the depth bound', !paths.includes('a/b/c/d/too-deep.md'), JSON.stringify(paths));
  ok('sorted by path', JSON.stringify(paths) === JSON.stringify(paths.slice().sort((a, b) => a.localeCompare(b))));
  const heur = await WS.scanRepoForFoundations(NOTES);
  ok('CONTROL: without all=1 the heuristic scan is unchanged (it omits a doc named nothing special)',
    !heur.candidates.some((c) => c.path === 'sub/meeting.txt'), JSON.stringify(heur.candidates.map((c) => c.path)));
  const bad = await WS.scanRepoForFoundations('relative/path', { all: true });
  eq('a relative folder is refused as invalid-root', bad.reason, 'invalid-root');
}

// ═════════════════════════════════════════════════════════════════════════
section('2. From this computer: many files at once, into an EMPTY project');
let P1;
{
  P1 = await newProject();
  const before = fingerprint(NOTES);
  const r = await WS.addFoundationsFromFolder(D, P1, { root: NOTES,
    files: [{ path: 'architecture.md' }, { path: 'decisions.md' }, { path: 'sub/meeting.txt' }] });
  ok('three files added in ONE call', r.ok === true && r.added.length === 3, JSON.stringify(r));
  eq('...as copies (curator-kept)', r.mode, 'copy');
  const m = manifestOf(P1);
  eq('the project is curator-kept now', m.ownership, 'curator');
  ok('each document is the source file byte for byte',
    sha(readFileSync(path.join(fdir(P1), 'architecture.md'))) === sha(readFileSync(path.join(NOTES, 'architecture.md')))
    && readFileSync(path.join(fdir(P1), 'meeting.md'), 'utf8') === 'A plain text note.\n');
  ok('...stamped human, never agent', m.documents.every((d) => d.authoredBy && d.authoredBy.kind === 'human'));
  eq('the picked folder is untouched', fingerprint(NOTES), before);
}

// ── 2b. PROVENANCE: copied, not written (screen review) ─────────────────
{
  const m = manifestOf(P1);
  ok('each copied document records the folder BASENAME it came from — never a path',
    m.documents.every((d) => d.copiedFrom === 'notes'), JSON.stringify(m.documents.map((d) => d.copiedFrom)));
  const idx = await WS.listFoundations(D, P1);
  ok('...and the index carries it', idx.documents.every((d) => d.copiedFrom === 'notes'));
  const P2 = await newProject();
  await WS.saveFoundation(D, P2, { slug: 'own.md', text: '# Own\n' });
  eq('a document WRITTEN here carries no copiedFrom', (await WS.listFoundations(D, P2)).documents[0].copiedFrom, undefined);
  // An OLDER manifest (no field) and a hand-edited one with a PATH both read safely.
  const mm = manifestOf(P2);
  mm.documents[0].copiedFrom = '/Users/me/secret/folder';
  writeFileSync(path.join(fdir(P2), 'manifest.json'), JSON.stringify(mm));
  eq('a copiedFrom that is a PATH is dropped on read, not shown', (await WS.listFoundations(D, P2)).documents[0].copiedFrom, undefined);
}

// ═════════════════════════════════════════════════════════════════════════
section('3. A second add — another folder — APPENDS and never replaces');
{
  const archBefore = sha(readFileSync(path.join(fdir(P1), 'architecture.md')));
  const r = await WS.addFoundationsFromFolder(D, P1, { root: MORE,
    files: [{ path: 'roadmap.md' }, { path: 'architecture.md' }] });
  ok('the new document is added', r.ok === true && r.added.includes('roadmap.md'), JSON.stringify(r));
  ok('...a same-named file is REFUSED as already added, named', r.refused.some((x) => /already added/.test(x.reason)
    && x.path === 'architecture.md'), JSON.stringify(r.refused));
  eq('...and the document already there is byte-identical', sha(readFileSync(path.join(fdir(P1), 'architecture.md'))), archBefore);
  eq('the project now holds four', manifestOf(P1).documents.length, 4);
  ok('the second batch records ITS folder', manifestOf(P1).documents.find((d) => d.slug === 'roadmap.md').copiedFrom === 'more');
  await WS.saveFoundation(D, P1, { slug: 'roadmap.md', text: '# Roadmap\n\nRewritten here by the owner.\n' });
  eq('an EDIT in the app makes it written — copiedFrom is cleared',
    manifestOf(P1).documents.find((d) => d.slug === 'roadmap.md').copiedFrom, undefined);
  await WS.setFoundationStartState(D, P1, 'decisions.md', 'read-first');
  ok('...while its siblings keep theirs, through a start-state write too',
    manifestOf(P1).documents.find((d) => d.slug === 'decisions.md').copiedFrom === 'notes'
    && manifestOf(P1).documents.find((d) => d.slug === 'decisions.md').readFirst === true);
  const again = await WS.addFoundationsFromFolder(D, P1, { root: NOTES, files: [{ path: 'decisions.md' }] });
  ok('an add where EVERY file is already there refuses the whole call, listing why',
    again.ok === false && again.reason === 'nothing-added' && again.refused.length === 1, JSON.stringify(again));
  const dup = await WS.addFoundationsFromFolder(D, P1, { root: folder('dups', { 'x/notes.md': '# a\n', 'y/notes.md': '# b\n' }),
    files: [{ path: 'x/notes.md' }, { path: 'y/notes.md' }] });
  ok('two ticked files that would land on one name: the first is added, the second refused by name',
    dup.ok && dup.added.length === 1 && /another ticked file/.test((dup.refused[0] || {}).reason || ''), JSON.stringify(dup));
}

// ═════════════════════════════════════════════════════════════════════════
section('4. Path safety: traversal, absolute, symlink escape, non-documents');
{
  const P = await newProject();
  try { symlinkSync(path.join(OUTSIDE, 'secret.md'), path.join(NOTES, 'link-out.md')); } catch { /* exists */ }
  const stateBefore = fingerprint(path.join(DOMAINS, D));
  const r = await WS.addFoundationsFromFolder(D, P, { root: NOTES, files: [
    { path: '../outside/secret.md' }, { path: path.join(OUTSIDE, 'secret.md') },
    { path: 'link-out.md' }, { path: 'image.png' }, { path: 'nope.md' }] });
  ok('nothing was added', r.ok === false && r.reason === 'nothing-added', JSON.stringify(r));
  const why = Object.fromEntries((r.refused || []).map((x) => [x.path, x.reason]));
  ok('a ../ path is refused as outside the folder', /outside/.test(why['../outside/secret.md'] || ''), JSON.stringify(why));
  ok('an absolute path is refused', /absolute/.test(why[path.join(OUTSIDE, 'secret.md')] || ''), JSON.stringify(why));
  ok('a symlink resolving OUT of the folder is refused', /symlink/.test(why['link-out.md'] || ''), JSON.stringify(why));
  ok('a non-document is refused', /\.md and \.txt/.test(why['image.png'] || ''), JSON.stringify(why));
  ok('a missing file is refused by name', /not found/.test(why['nope.md'] || ''), JSON.stringify(why));
  eq('...and NOTHING was written anywhere in the domain', fingerprint(path.join(DOMAINS, D)), stateBefore);
  const rel = await WS.addFoundationsFromFolder(D, P, { root: 'notes', files: [{ path: 'a.md' }] });
  eq('a relative ROOT is refused', rel.reason, 'invalid-root');
  const gone = await WS.addFoundationsFromFolder(D, P, { root: path.join(TMP, 'no-such-folder'), files: [{ path: 'a.md' }] });
  ok('an unreadable folder is refused with a sentence', gone.ok === false && /could not be read/.test(gone.message), JSON.stringify(gone));
  const none = await WS.addFoundationsFromFolder(D, P, { root: NOTES, files: [] });
  eq('no files ticked is refused', none.reason, 'no-files');
  const tooMany = await WS.addFoundationsFromFolder(D, P, { root: NOTES,
    files: Array.from({ length: WS.MAX_FOUNDATIONS_PER_PROJECT + 1 }, (_, i) => ({ path: `f${i}.md` })) });
  eq('more files than the per-project cap in one call is refused', tooMany.reason, 'too-many-documents');
  try { rmSync(path.join(NOTES, 'link-out.md')); } catch { /* ignore */ }
}

// ═════════════════════════════════════════════════════════════════════════
section('5. Byte limits: the per-document wall and the project budget, with numbers');
{
  const P = await newProject();
  const BIG = folder('big', { 'huge.md': '# H\n' + 'x'.repeat(WS.MAX_FOUNDATION_BYTES + 10),
    'a.md': '# A\n' + 'a'.repeat(120 * 1024), 'b.md': '# B\n' + 'b'.repeat(120 * 1024) });
  const r = await WS.addFoundationsFromFolder(D, P, { root: BIG, files: [{ path: 'huge.md' }, { path: 'a.md' }, { path: 'b.md' }] });
  const huge = r.refused.find((x) => x.path === 'huge.md');
  ok('a file over the per-document wall is refused WITH its bytes and the cap',
    !!huge && huge.bytes === WS.MAX_FOUNDATION_BYTES + 14 && huge.cap === WS.MAX_FOUNDATION_BYTES
    && /524288-byte \(512 KB\)/.test(huge.reason), JSON.stringify(huge));
  ok('...and is never written', !existsSync(path.join(fdir(P), 'huge.md')));
  ok('over the PROJECT budget the add completes and says so with the numbers',
    r.ok === true && r.added.length === 2 && r.budgetExceeded === true && r.totalBytes > r.budgetBytes
    && r.notes.some((n) => new RegExp(`${r.totalBytes} bytes, over the ${r.budgetBytes}-byte`).test(n)), JSON.stringify(r).slice(0, 400));
}

// ═════════════════════════════════════════════════════════════════════════
section('6. A FOLDER MIRROR: adds go through the mirror, from inside its folder');
{
  const P = await newProject();
  const REPO = folder('repo', { 'docs/architecture.md': '# Arch\n', 'docs/sub/guide.md': '# Guide\n', 'README.md': '# R\n' });
  const init = await WS.initFoundations(D, P, { ownership: 'repo', repoRoot: REPO, files: [{ path: 'README.md' }] });
  ok('SETUP: a folder mirror with one document', init.ok && manifestOf(P).documents.length === 1, JSON.stringify(init).slice(0, 300));
  const r = await WS.addFoundationsFromFolder(D, P, { root: path.join(REPO, 'docs'), files: [{ path: 'sub/guide.md' }] });
  eq('picking a SUBFOLDER of the mirror adds through the mirror', r.mode, 'mirror');
  const m = manifestOf(P);
  ok('...rebased to a path inside the mirrored folder, source kind repo',
    m.documents.some((d) => d.slug === 'guide.md' && d.source.kind === 'repo' && d.source.path === 'docs/sub/guide.md'),
    JSON.stringify(m.documents.map((d) => d.source)));
  eq('...and the project is still repo-owned', m.ownership, 'repo');
  const before = fingerprint(fdir(P));
  const out = await WS.addFoundationsFromFolder(D, P, { root: OUTSIDE, files: [{ path: 'secret.md' }] });
  ok('a folder OUTSIDE the mirror is refused by name — a mirror has one source',
    out.ok === false && out.reason === 'outside-mirrored-folder' && typeof out.mirroredFolder === 'string', JSON.stringify(out));
  eq('...and nothing was written', fingerprint(fdir(P)), before);
  // A sibling whose NAME starts with the mirror's folder name is outside it.
  const sib = folder('repo-sibling', { 'x.md': '# x\n' });
  const s2 = await WS.addFoundationsFromFolder(D, P, { root: sib, files: [{ path: 'x.md' }] });
  eq('a sibling folder named like the mirror (repo-sibling) is outside it too', s2.reason, 'outside-mirrored-folder');
}

// ═════════════════════════════════════════════════════════════════════════
section('7. A GITHUB MIRROR: the local door is refused, honestly');
{
  const P = await newProject();
  // A remote-born empty mirror, then one hand-listed document, so it is populated.
  await WS.initFoundations(D, P, { ownership: 'repo', remote: 'acme/thing' });
  const m = manifestOf(P);
  m.documents.push({ slug: 'x.md', role: 'other', title: 'X', source: { kind: 'repo', path: 'x.md' },
    sha256: sha(Buffer.from('# x\n')), bytes: 4, updatedAt: null, commit: null, authoredBy: null });
  writeFileSync(path.join(fdir(P), 'x.md'), '# x\n');
  writeFileSync(path.join(fdir(P), 'manifest.json'), JSON.stringify(m));
  const r = await WS.addFoundationsFromFolder(D, P, { root: NOTES, files: [{ path: 'decisions.md' }] });
  ok('refused source-is-github, naming the repository', r.ok === false && r.reason === 'source-is-github'
    && /acme\/thing/.test(r.message), JSON.stringify(r));
}

// ═════════════════════════════════════════════════════════════════════════
section('8. An EMPTY project\'s source may be chosen again — and only an empty one');
{
  // A fake GitHub, for the init's remote read.
  const REPO_FILES = { 'docs/architecture.md': '# Architecture\n', 'README.md': '# Readme\n', 'notes/x.txt': 'x\n', '.github/ci.md': '# ci\n' };
  const ghFetch = async (url) => {
    const u = new URL(String(url));
    const json = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => null },
      async json() { return body; }, async text() { return JSON.stringify(body); } });
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m || m[1] !== 'acme' || m[2] !== 'docs') return json({ message: 'Not Found' }, 404);
    const rest = m[3] || '';
    if (!rest) return json({ default_branch: 'main' });
    if (rest.startsWith('/commits/')) return json({ sha: 'c'.repeat(40) });
    if (rest.startsWith('/git/trees/')) return json({ truncated: false, tree: Object.entries(REPO_FILES).map(([p, c]) =>
      ({ path: p, type: 'blob', sha: gitBlobSha(Buffer.from(c)), size: Buffer.byteLength(c) })) });
    const b = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    if (b) { const hit = Object.values(REPO_FILES).find((c) => gitBlobSha(Buffer.from(c)) === b[1]);
      return hit ? json({ encoding: 'base64', content: Buffer.from(hit).toString('base64') }) : json({ message: 'nf' }, 404); }
    return json({ message: 'no route' }, 404);
  };
  writeFileSync(path.join(USER_DATA, '.curator-config.json'),
    JSON.stringify({ githubReadToken: 'github_pat_TESTONLY_SHOULD_NEVER_APPEAR_0123456789' }));

  const scan = await WS.scanRemoteForFoundations({ remote: 'acme/docs', all: true, fetchImpl: ghFetch });
  const paths = (scan.candidates || []).map((c) => c.path);
  ok('the GitHub listing (all=1) finds every document, skipping hidden folders',
    scan.ok && paths.includes('notes/x.txt') && paths.includes('README.md') && !paths.some((p) => p.startsWith('.github')),
    JSON.stringify(scan).slice(0, 300));

  const P = await newProject();
  await WS.initFoundations(D, P, { ownership: 'curator', seed: false });
  const without = await WS.initFoundations(D, P, { ownership: 'repo', remote: 'acme/docs', files: [{ path: 'README.md' }], fetchImpl: ghFetch });
  eq('WITHOUT the flag an empty manifest still refuses a second init', without.reason, 'ownership-set');
  const withFlag = await WS.initFoundations(D, P, { ownership: 'repo', remote: 'acme/docs', rechooseEmpty: true,
    files: [{ path: 'README.md' }, { path: 'docs/architecture.md' }], fetchImpl: ghFetch });
  ok('WITH rechooseEmpty an EMPTY curator project becomes a GitHub mirror, documents copied',
    withFlag.ok === true && manifestOf(P).ownership === 'repo' && manifestOf(P).documents.length === 2,
    JSON.stringify(withFlag).slice(0, 400));
  eq('...the bytes are the repository\'s', readFileSync(path.join(fdir(P), 'readme.md'), 'utf8'), '# Readme\n');
  const populated = await WS.initFoundations(D, P, { ownership: 'curator', rechooseEmpty: true });
  eq('a project WITH documents is never re-chosen, flag or not', populated.reason, 'ownership-set');

  const Q = await newProject();
  await WS.initFoundations(D, Q, { ownership: 'curator', seed: false });
  writeFileSync(path.join(fdir(Q), 'orphan.md'), '# somebody wrote this\n');
  const orphan = await WS.initFoundations(D, Q, { ownership: 'curator', rechooseEmpty: true });
  eq('an UNLISTED document in the folder means not empty — refused', orphan.reason, 'ownership-set');
  const orphanAdd = await WS.addFoundationsFromFolder(D, Q, { root: NOTES, files: [{ path: 'decisions.md' }] });
  ok('...and the local door will not copy over a project holding an orphan it cannot see',
    orphanAdd.ok === false && orphanAdd.reason === 'orphans-present', JSON.stringify(orphanAdd));
  eq('...the orphan is untouched', readFileSync(path.join(fdir(Q), 'orphan.md'), 'utf8'), '# somebody wrote this\n');

  const R = await WS.addFoundationsFromFolder(D, (await (async () => {
    const x = await newProject();
    await WS.initFoundations(D, x, { ownership: 'repo', remote: 'acme/docs' });
    return x;
  })()), { root: NOTES, files: [{ path: 'decisions.md' }] });
  ok('an EMPTY GitHub mirror takes a local add as a copy, re-chosen and SAID so',
    R.ok === true && R.mode === 'copy' && R.rechosen === true, JSON.stringify(R).slice(0, 300));
}

// ═════════════════════════════════════════════════════════════════════════
section('9. The route: strict body, honest statuses, the numbers ride out');
{
  const express = (await import('express')).default;
  const router = (await import('../src/routes/memory.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/memory', router);
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  LOOPBACK = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => {
    const r = await fetch(`${LOOPBACK}/api/memory/${D}/${p}/foundations/add-local`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const P = await newProject();
  const tok = await post(P, { root: NOTES, files: [{ path: 'decisions.md' }], token: 'x' });
  ok('a body with any other field (here `token`) is a 400 naming it', tok.status === 400
    && tok.body.reason === 'unexpected_fields' && tok.body.fields.includes('token'), JSON.stringify(tok));
  const okAdd = await post(P, { root: NOTES, files: [{ path: 'decisions.md' }, { path: 'architecture.md' }] });
  ok('the wire index carries copiedFrom', okAdd.body.foundations.documents.every((d) => d.copiedFrom === 'notes'));
  ok('an add answers 200 with what was added and the fresh index', okAdd.status === 200
    && okAdd.body.added.length === 2 && okAdd.body.foundations && okAdd.body.foundations.documents.length === 2,
    JSON.stringify(okAdd).slice(0, 300));
  const dup = await post(P, { root: NOTES, files: [{ path: 'decisions.md' }] });
  ok('nothing addable is a 422 with every refusal and its reason', dup.status === 422
    && dup.body.refused[0].reason.includes('already added'), JSON.stringify(dup));
  const BIG = folder('big2', { 'huge.md': 'x'.repeat(WS.MAX_FOUNDATION_BYTES + 1) });
  const big = await post(P, { root: BIG, files: [{ path: 'huge.md' }] });
  ok('an over-the-wall file carries its bytes and the cap on the wire', big.status === 422
    && big.body.refused[0].bytes === WS.MAX_FOUNDATION_BYTES + 1 && big.body.refused[0].cap === WS.MAX_FOUNDATION_BYTES,
    JSON.stringify(big));
  const trav = await post(P, { root: NOTES, files: [{ path: '../outside/secret.md' }] });
  ok('a traversal is refused on the wire too (422, reason named)', trav.status === 422 && /outside/.test(trav.body.refused[0].reason));
  const bad = await post(P, { root: 'relative', files: [{ path: 'a.md' }] });
  eq('a relative root is a 400', bad.status, 400);
  const scan = await fetch(`${LOOPBACK}/api/memory/repo-scan?all=1&root=${encodeURIComponent(NOTES)}`).then((r) => r.json());
  ok('repo-scan?all=1 lists every document', scan.ok && scan.candidates.some((c) => c.path === 'sub/meeting.txt'));
  const scan0 = await fetch(`${LOOPBACK}/api/memory/repo-scan?root=${encodeURIComponent(NOTES)}`).then((r) => r.json());
  ok('CONTROL: without all=1 the route keeps the heuristic scan', !scan0.candidates.some((c) => c.path === 'sub/meeting.txt'),
    JSON.stringify(scan0.candidates.map((c) => c.path)));
  const E = await newProject();
  await WS.initFoundations(D, E, { ownership: 'curator', seed: false });
  const initPost = (body) => fetch(`${LOOPBACK}/api/memory/${D}/${E}/foundations/init`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const truthy = await initPost({ ownership: 'curator', rechooseEmpty: 'yes' });
  eq('init forwards rechooseEmpty ONLY as the literal true — a truthy string still refuses an empty project',
    truthy.status, 400);
  const literal = await initPost({ ownership: 'curator', rechooseEmpty: true });
  eq('...and the literal true re-chooses it (the four templates)', literal.status, 201);
  await new Promise((r) => server.close(r));
  LOOPBACK = null;
}

// ═════════════════════════════════════════════════════════════════════════
section('10. The doors (DOM-free): always both, always enabled (v3.69.0)');
{
  // v3.69.0 (CONTRACT §4.1): the source is per DOCUMENT, so neither door
  // depends on what the project already holds. Disabled only on a read-only
  // mirror and an unreadable manifest, each with its reason.
  const empty = { present: false, count: 0, docs: [] };
  const cur = { present: true, ownership: 'curator', count: 3, docs: [] };
  const mir = { present: true, ownership: 'repo', count: 2, docs: [], repo: { root: '/r', remote: null } };
  const gh = { present: true, ownership: 'repo', count: 2, docs: [], repo: { root: null, remote: { owner: 'o', repo: 'r' } } };
  const mixed = { present: true, ownership: 'mixed', count: 4, docs: [] };
  for (const [name, f] of [['empty', empty], ['curator', cur], ['folder mirror', mir], ['github mirror', gh], ['mixed', mixed]]) {
    const d = FA.doorsFor(f);
    ok(`[${name}] BOTH doors available, neither with a reason`,
      d.local.available && d.github.available && !d.local.why && !d.github.why);
    eq(`[${name}] the GitHub door ADDS — naming another repository adds a source`, d.github.mode, 'add');
    eq(`[${name}] the local door's mode is chosen in the panel`, d.local.mode, null);
  }
  ok('the GitHub note says another repository becomes a NEW source, never that it switches',
    /becomes a new source/.test(FA.doorsFor(cur).github.note) && !/switch/i.test(FA.doorsFor(cur).github.note));
  const ro = FA.doorsFor(empty, { readonly: true });
  ok('a read-only mirror: both disabled, with the reason', !ro.local.available && !ro.github.available && !!ro.local.why);
  const bad = FA.doorsFor({ present: true, manifestError: 'x' });
  ok('an unreadable manifest: both disabled, with the reason', !bad.local.available && !bad.github.available && !!bad.github.why);
  for (const [name, dd] of [['empty', FA.doorsFor(empty)], ['curator', FA.doorsFor(cur)], ['readonly', ro]]) {
    const h = FA.renderDoors(dd);
    ok(`renderDoors [${name}] ALWAYS emits both doors`, h.includes('id="mem-fnd-door-local"') && h.includes('id="mem-fnd-door-github"'));
  }
  ok('an enabled door is a real button with no reason attribute',
    !/aria-disabled|data-fnd-door-why/.test(FA.renderDoors(FA.doorsFor(cur))));
  ok('a disabled door is aria-disabled (the press still arrives) and carries its reason',
    /id="mem-fnd-door-github"[^>]*aria-disabled="true"[^>]*data-fnd-door-why="[^"]+"/.test(FA.renderDoors(ro)));
  ok('the reason is escaped into the attribute', !/data-fnd-door-why="[^"]*<[^"]*"/.test(
    FA.renderDoors({ local: { available: false, why: '<img onerror=x>' }, github: { available: true } })));
}

// ═════════════════════════════════════════════════════════════════════════
section('11. The checklist and the commit, DOM-free (v3.69.0)');
{
  const facts = { present: true, ownership: 'curator', count: 1, bytes: 1000, budgetBytes: 204800,
    docs: [{ slug: 'architecture.md', source: { kind: 'curator' } }] };
  const rec = Object.assign(FA.freshAddPanel('local', FA.doorsFor(facts).local, facts), {
    domain: 'd', project: 'p', root: '/typed/n', listedRoot: '/n',
    candidates: [
      { path: 'architecture.md', bytes: 10, suggestedSlug: 'architecture.md', alreadyAdded: true, alreadyAs: 'architecture.md', landsAs: 'architecture.md' },
      { path: 'b.md', bytes: 20, suggestedSlug: 'b.md', alreadyAdded: false, landsAs: 'b.md' },
      { path: 'big.md', bytes: 600000, suggestedSlug: 'big.md', tooLarge: true }],
    picks: { 'architecture.md': true, 'b.md': true, 'big.md': true } });
  eq('a fresh local panel starts on Copy once', FA.freshAddPanel('local', {}, facts).mode, 'copy');
  ok('an already-added row (the SERVER\'s field) is never counted as ticked, even if its tick is set',
    JSON.stringify(FA.tickedPaths(rec)) === JSON.stringify(['b.md']));
  ok('...nor is a too-large row', !FA.tickedPaths(rec).includes('big.md'));
  eq('commitWord says Copy', FA.commitWord(rec), 'Copy 1 document');
  eq('...and Mirror in Keep in sync', FA.commitWord(Object.assign({}, rec, { mode: 'mirror' })), 'Mirror 1 document');
  ok('alreadyAdded reads the server field ONLY — a same-named file the server does not mark stays tickable',
    FA.alreadyAdded({ candidates: [{ path: 'x/architecture.md', suggestedSlug: 'architecture.md' }] }).size === 0);
  const req = FA.buildAddCommit(rec, facts, 'd', 'p');
  eq('the local commit posts to add-local', req.url, '/api/memory/d/p/foundations/add-local');
  eq('...with the LISTED root, the ticked paths and the mode — nothing else',
    JSON.stringify(req.body), JSON.stringify({ root: '/n', files: [{ path: 'b.md' }], mode: 'copy' }));
  eq('...and `mirror` when Keep in sync is chosen',
    FA.buildAddCommit(Object.assign({}, rec, { mode: 'mirror' }), facts, 'd', 'p').body.mode, 'mirror');
  ok('the listing names its mode and this project, so the server can annotate',
    /&mode=copy&domain=d&project=p$/.test(FA.listUrl(rec)), FA.listUrl(rec));
  const g = Object.assign(FA.freshAddPanel('github', { mode: 'add' }, facts), {
    remote: 'o/r', path: 'docs', candidates: [{ path: 'docs/x.md', bytes: 1 }], picks: { 'docs/x.md': true } });
  eq('GitHub, any repository: add-remote', FA.buildAddCommit(g, facts, 'd', 'p').url, '/api/memory/d/p/foundations/add-remote');
  eq('...sending the repository (never the listing folder), the token FILE and the files — nothing else',
    JSON.stringify(FA.buildAddCommit(g, facts, 'd', 'p').body),
    JSON.stringify({ remote: { owner: 'o', repo: 'r' }, tokenSource: 'config', files: [{ path: 'docs/x.md' }] }));
  const sw = Object.assign(FA.freshAddPanel('github', { mode: 'switch', group: 's2',
    remote: { owner: 'o', repo: 'r', ref: 'main' }, groupLabel: 'notes', groupCount: 3 }, facts), { tokenSource: 'sync' });
  eq('"Read from GitHub instead" posts to source', FA.buildAddCommit(sw, facts, 'd', 'p').url, '/api/memory/d/p/foundations/source');
  eq('...naming ITS group, the repository and the token file',
    JSON.stringify(FA.buildAddCommit(sw, facts, 'd', 'p').body),
    JSON.stringify({ group: 's2', remote: { owner: 'o', repo: 'r', ref: 'main' }, tokenSource: 'sync' }));
  eq('...and needs no listing to commit', FA.commitBlockedReason(sw), null);
  eq('...its primary counts the group', FA.commitWord(sw), 'Read 3 documents from GitHub');
  ok('a URL is accepted as the repository', JSON.stringify(FA.parseRepoInput('https://github.com/o/r.git')) === JSON.stringify({ owner: 'o', repo: 'r' }));
  ok('garbage is not', FA.parseRepoInput('o/r/x') === null && FA.parseRepoInput('') === null);
  ok('no request body anywhere carries a token',
    [req, FA.buildAddCommit(g, facts, 'd', 'p'), FA.buildAddCommit(sw, facts, 'd', 'p')]
      .every((x) => !/token"\s*:/.test(JSON.stringify(x.body).replace(/tokenSource/g, ''))));
  const over = Object.assign({}, rec, { projectBytes: 204000, picks: { 'b.md': true },
    candidates: [{ path: 'b.md', bytes: 2000, suggestedSlug: 'b.md' }] });
  ok('the budget warning carries the numbers', /201 KB, over its 200 KB budget by 1 KB/.test(FA.budgetWarning(over)),
    FA.budgetWarning(over));
  const read = FA.readCommitResponse(422, { ok: false, reason: 'nothing-added', error: 'None…', refused: [{ path: 'a', reason: 'r' }] }, rec);
  ok('a refusal reads as an error with its refused list', read.ok === false && read.error === 'None…' && read.refused.length === 1);
  const readGh = FA.readCommitResponse(429, { ok: false, reason: 'rate-limited' }, g);
  ok('a GitHub rate limit becomes a sentence, never the code', /rate-limiting/.test(readGh.error), readGh.error);
  const readObj = FA.readCommitResponse(201, { ok: true, added: [{ path: 'docs/x.md', slug: 'x-r.md' }], refused: [] }, g);
  ok('an added list of {path, slug} objects is read as the landed names', readObj.ok && readObj.added[0] === 'x-r.md');
}

// ═════════════════════════════════════════════════════════════════════════
section('12. No real network');
eq('the fetch spy recorded no outbound request', NET_ATTEMPTS.length, 0);

console.log(`\n${'═'.repeat(60)}\nPassed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ foundations-add assertions failed'); process.exit(1); }
console.log('✅ All foundations-add assertions green');
