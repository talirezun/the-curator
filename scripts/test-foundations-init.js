#!/usr/bin/env node
/**
 * OFFLINE — tier 0's FRONT DOOR (v3.61.0): choosing where a project's
 * canonical documents live, seeding the four skeletons, finding documents in
 * a checkout, and reading a document back VERBATIM so an editor cannot
 * corrupt it.
 *
 * WHY THIS SUITE EXISTS, DEFECT BY DEFECT
 * ───────────────────────────────────────
 * v3.59.0 built the tier and no way in: a mirror could only be created by a
 * test, and a curator-owned project only by a commissioned MCP call. The
 * release that opens it can go wrong in ways that are all silent:
 *
 *   · OWNERSHIP RE-DECIDED. The store has refused a MISMATCH since v3.59.0,
 *     but nothing refused a second INIT, and a second init over a repo-owned
 *     project would either overwrite the owner's documents with a mirror or
 *     strand a checkout's copies. §2 requires `ownership-set` over ANY
 *     readable manifest — including one with zero documents, which is exactly
 *     what a repo init with no files leaves behind.
 *   · A REPO INIT THAT WRITES NOTHING. `refreshFoundationsFromRepo`'s empty
 *     work list returns `noop: true` and writes no manifest (by design — a
 *     refresh of nothing must not invent one). An init that delegated to it
 *     would report success over a project with no manifest and no ownership,
 *     and the NEXT init would be allowed. §3 pins the manifest, the ownership
 *     and the root for a zero-file repo init.
 *   · TWO LOCK ACQUISITIONS. `acquireFileLock` is not re-entrant, so an init
 *     that mirrored through the public refresh would refuse ITSELF with
 *     `locked` — a conflict against nobody. §4 samples `listActiveWrites()`
 *     while an init with files is in flight and requires ONE entry and one op
 *     name, and requires the mirrored document to actually arrive.
 *   · THE MANIFEST WRITTEN FIRST. §5 simulates the crash between the
 *     documents and the manifest (a directory where manifest.json goes) and
 *     requires the seeded documents to be ON DISK and DISCLOSED as orphans —
 *     never an entry pointing at nothing.
 *   · A SEED THE READ SANITISER REWRITES. Foundations are written verbatim
 *     and defanged on READ, so a seeded document containing a URL would come
 *     back changed and flagged on its first read: the app telling the owner
 *     its own seed may have been tampered with. §6 SAVES and READS all four
 *     skeletons and requires `sanitisedOnRead === false` with the sha intact.
 *   · AN EDITOR THAT CORRUPTS ON SAVE. The default read defangs
 *     (`https://` → `https[:]//`); a surface that loaded THAT and saved it
 *     back would rewrite the document and break the sha a mirror's freshness
 *     claim rests on. §7 pins `{raw: true}` byte-for-byte against the
 *     manifest's own digest, with the defanged default as the control.
 *   · A SKELETON THAT STAYS A SKELETON. The flag is the only thing that tells
 *     a reader prompts from facts. §8 requires ANY save to clear it, the
 *     clearing to be reported (`wasSkeleton`), and every consumer — the
 *     index, the summary, the bootstrap, both MCP handlers — to carry it.
 *   · A SCAN THAT CANNOT ONBOARD, OR THAT LEAVES THE TREE. §9 pins the three
 *     admission rules and the depth bounds against a checkout built to
 *     exercise each, a symlink out of the root, a 600 KB file, the 200 cap,
 *     and a PLAIN FOLDER (no .git) working as a mirror source.
 *   · A HALF-CREATED PROJECT. §10 requires a tier-0 failure AFTER the brief
 *     is written to be DISCLOSED on an `ok: true` create — never a rollback,
 *     never a 5xx: the project exists and deleting it to report a tidier
 *     failure would throw away the part that worked.
 *
 * Isolated via __setUserDataDirOverride + __setDomainsDirOverride — never
 * process.env.DOMAINS_PATH, never the real domains folder.
 *
 * Run with:  node scripts/test-foundations-init.js     (exit 0 = all green)
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, statSync, realpathSync, utimesSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ── Isolation MUST be installed before anything resolves a path ──────────
const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
// realpathSync: on macOS /var is a symlink to /private/var, and the store
// resolves every repository root through realpath. Comparing a returned root
// against an unresolved fixture path would fail for a reason that has nothing
// to do with the code under test.
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), 'curator-fnd-init-')));
const REAL_TMPDIR = realpathSync(tmpdir());
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
const OUTSIDE = path.join(TMP, 'outside');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
__setUserDataDirOverride(USER_DATA);
__setDomainsDirOverride(DOMAINS);
process.on('exit', () => {
  try {
    if (path.dirname(TMP) === REAL_TMPDIR && path.basename(TMP).startsWith('curator-fnd-init-')) {
      rmSync(TMP, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
});

const WS = await import('../src/brain/working-state.js');
const {
  initFoundations, scanRepoForFoundations, createProject, listFoundations, readFoundation,
  saveFoundation, removeFoundation, refreshFoundationsFromRepo, getProjectContext, readWorkingState,
  FOUNDATIONS_DIRNAME, FOUNDATIONS_MANIFEST_FILENAME, MAX_FOUNDATION_BYTES, MAX_REPO_SCAN_CANDIDATES,
  FOUNDATION_ROLES, neutraliseProtocol,
} = WS;
const SK = await import('../src/brain/foundation-skeletons.js');
const { FOUNDATION_SKELETONS, SKELETON_BANNER, SKELETON_SLUGS, skeletonFor } = SK;
const { acquireFileLock, listActiveWrites, isFileLocked } = await import('../src/brain/write-registry.js');
const { getProjectContextHandler, getWorkingStateHandler, saveFoundationHandler } = await import('../mcp/tools/working-state.js');
const { createStorageAdapter } = await import('../mcp/storage/local.js');
const storage = createStorageAdapter({ domainsPath: DOMAINS });

// ── Harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function bad(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err !== undefined) console.log(`    └─ ${err}`); }
function assert(cond, label, err) { cond ? ok(label) : bad(label, err === undefined ? 'assertion failed' : err); }
function section(name) { console.log(`\n── ${name} ──`); }
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
/**
 * `jstr` and not `JSON.stringify` everywhere below, because every assertion's
 * DETAIL argument is evaluated EAGERLY: `JSON.stringify(undefined)` is
 * `undefined`, so `.slice()` on it throws and a mutation that empties a field
 * ABORTS the run with a TypeError instead of reddening the assertion it was
 * aimed at. Found by the "createProject fails the whole create on a tier-0
 * refusal" mutation, which is exactly the shape this suite exists to catch.
 */
const jstr = (v) => { try { const out = JSON.stringify(v); return out === undefined ? String(v) : out; } catch { return '[unserialisable]'; } };

// ── Fixtures ─────────────────────────────────────────────────────────────
const D = 'idom';
const MIRROR = 'shared-imirror';
const GHOST = 'ighost';
function makeDomain(name, { readonly = false } = {}) {
  mkdirSync(path.join(DOMAINS, name, 'wiki'), { recursive: true });
  writeFileSync(path.join(DOMAINS, name, 'CLAUDE.md'), readonly ? '---\nreadonly: true\n---\n# Mirror\n' : `# ${name}\n`);
}
makeDomain(D);
makeDomain(MIRROR, { readonly: true });
mkdirSync(path.join(DOMAINS, GHOST, 'wiki'), { recursive: true });     // no CLAUDE.md
const statePath = (domain, ...rest) => path.join(DOMAINS, domain, 'state', ...rest);
const fdir = (domain, project) => (project && project !== domain
  ? statePath(domain, project, FOUNDATIONS_DIRNAME) : statePath(domain, FOUNDATIONS_DIRNAME));
const manifestPath = (domain, project) => path.join(fdir(domain, project), FOUNDATIONS_MANIFEST_FILENAME);
/** The manifest on disk, or null. NEVER throws: a mutation that stops a
 *  manifest being written must make an assertion go RED, not abort the run
 *  with an ENOENT stack and discard every section after it (found by the
 *  "repo init delegates to the refresh" mutation). */
const manifestOf = (domain, project) => {
  try { return JSON.parse(readFileSync(manifestPath(domain, project), 'utf8')); } catch { return null; }
};
/** A named project with a brief and nothing else. */
async function freshProject(name) {
  const r = await createProject(D, name, {});
  if (!r.ok) throw new Error(`fixture: createProject ${name} failed: ${r.reason} ${r.message}`);
  return name;
}

// ═════════════════════════════════════════════════════════════════════════
section('1. The skeletons are DATA, and there is exactly one copy of them');
{
  assert(Array.isArray(FOUNDATION_SKELETONS) && FOUNDATION_SKELETONS.length === 4,
    'four skeletons ship', FOUNDATION_SKELETONS.length);
  assert(jstr(SKELETON_SLUGS) === jstr(['architecture.md', 'decisions.md', 'conventions.md', 'roadmap.md']),
    'the slugs are architecture / decisions / conventions / roadmap, in reading order', jstr(SKELETON_SLUGS));
  for (const s of FOUNDATION_SKELETONS) {
    assert(FOUNDATION_ROLES.includes(s.role), `${s.slug} carries a known role (${s.role})`);
    assert(Buffer.byteLength(s.text, 'utf8') <= 2048, `${s.slug} is ≤ 2 KB (${Buffer.byteLength(s.text, 'utf8')} B)`);
    assert(s.text.startsWith(`${SKELETON_BANNER}\n`), `${s.slug} opens with the VISIBLE skeleton banner`, jstr(s.text.slice(0, 60)));
    assert(/\n## /.test(s.text), `${s.slug} carries '## ' prompt headings`);
    assert(Object.isFrozen(s), `${s.slug} is frozen — a caller cannot edit the shared seed`);
  }
  assert(/not yet written/i.test(SKELETON_BANNER) && /delete this line/i.test(SKELETON_BANNER),
    'the banner says it is unwritten AND what to do with the line itself', SKELETON_BANNER);
  assert(skeletonFor('architecture')?.slug === 'architecture.md' && skeletonFor('nope') === null,
    'skeletonFor accepts a bare stem and returns null for an unknown one');
  // ONE copy. The store must not carry its own skeleton text, and the module
  // must be stdout-silent: it sits on the MCP import graph, where a
  // console.log poisons the JSON-RPC stream (v2.5.3).
  const skelSrc = readFileSync(path.join(REPO, 'src/brain/foundation-skeletons.js'), 'utf8');
  assert(!/console\.log/.test(skelSrc), 'foundation-skeletons.js contains NO console.log — stdout is JSON-RPC in the MCP child');
  const storeSrc = readFileSync(path.join(REPO, 'src/brain/working-state.js'), 'utf8');
  assert(/from '\.\/foundation-skeletons\.js'/.test(storeSrc) && !storeSrc.includes('Skeleton — not yet written'),
    'the store IMPORTS the skeletons and holds no second copy of the banner text');

  // The banner is read by people in Obsidian's own reader AND in /next's
  // reader overlay — src/public/next/shared/markdown.js. That renderer has
  // no blockquote pass and escapes the whole string before matching any
  // Markdown syntax (verified: `grep -n blockquote` over it returns
  // nothing), so a banner opening with a Markdown blockquote marker (`> `)
  // would render as a literal `&gt;` instead of a quote — the defect this
  // banner's wording was written to avoid. This loads the REAL renderer file
  // (not a reimplementation) the same way scripts/test-next-markdown.js
  // does: brace-matched function extraction into a sandboxed `new
  // Function()`, because a plain `import()` of shared/markdown.js fails —
  // it statically imports `icon` from ../app.js, which needs a DOM. `icon`
  // is stubbed; SKELETON_BANNER carries no `[source: …]` citation syntax,
  // so the stub is never called.
  function extractMdFn(src, name) {
    const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
    const m = marker.exec(src);
    if (!m) throw new Error(`extractMdFn: "${name}" not found in shared/markdown.js`);
    const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
    let p = src.indexOf('(', start);
    if (p === -1) throw new Error(`extractMdFn: "${name}" has no parameter list`);
    let parenDepth = 0;
    for (; p < src.length; p++) {
      if (src[p] === '(') parenDepth++;
      else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
    }
    let i = src.indexOf('{', p);
    if (i === -1) throw new Error(`extractMdFn: "${name}" has no body`);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const extracted = src.slice(start, i).replace(/^export\s+/, '');
    if (!/\n\}$/.test(extracted)) {
      throw new Error(`extractMdFn: "${name}" does not end at a top-level closing brace — the matcher desynced`);
    }
    return extracted;
  }
  const mdSrc = readFileSync(path.join(REPO, 'src/public/next/shared/markdown.js'), 'utf8');
  const MD_FNS = ['escHtml', 'formatSegment', 'renderInline',
    'splitTableRow', 'isTableDelimiterCell', 'tableAlignClass', 'renderMarkdown'];
  const mdBody = MD_FNS.map((n) => extractMdFn(mdSrc, n)).join('\n\n');
  const { renderMarkdown: realRenderMarkdown } = new Function('icon',
    `${mdBody}\nreturn { ${MD_FNS.join(', ')} };`)(() => '');
  const bannerHtml = realRenderMarkdown(SKELETON_BANNER);
  assert(bannerHtml.includes('<strong>Skeleton — not yet written.</strong>'),
    'the REAL /next renderer turns the banner\'s bold lead into <strong>Skeleton — not yet written.</strong>',
    bannerHtml);
  assert(!bannerHtml.includes('&gt;'),
    'the REAL /next renderer emits no &gt; — no blockquote marker survives into the rendered banner',
    bannerHtml);
}

// ═════════════════════════════════════════════════════════════════════════
section('2. initFoundations — every refusal, before anything is written');
{
  const un = await initFoundations(GHOST, GHOST, { ownership: 'curator' });
  assert(!un.ok && un.reason === 'unknown-project', 'a folder with no CLAUDE.md is refused as a domain', un.reason);
  const mi = await initFoundations(MIRROR, MIRROR, { ownership: 'curator' });
  assert(!mi.ok && mi.reason === 'readonly', 'a read-only Shared Brain mirror is refused', mi.reason);
  assert(!existsSync(statePath(MIRROR)), '…and nothing was created in the mirror');
  const np = await initFoundations(D, 'no-such-project', { ownership: 'curator' });
  assert(!np.ok && np.reason === 'unknown-state-project', 'an unknown NAMED project is refused — nothing is created implicitly', np.reason);
  for (const bad2 of [undefined, null, '', 'mirror', 'REPO', 'both', 42]) {
    const r = await initFoundations(D, D, { ownership: bad2 });
    assert(!r.ok && r.reason === 'invalid-ownership', `ownership ${jstr(bad2)} is refused as invalid-ownership`, r.reason);
  }
  const rna = await initFoundations(D, D, { ownership: 'curator', repoRoot: OUTSIDE });
  assert(!rna.ok && rna.reason === 'root-not-allowed' && /curator-owned/.test(rna.message),
    'curator + repoRoot is REFUSED (root-not-allowed) rather than silently ignored', jstr(rna).slice(0, 160));
  const rel = await initFoundations(D, D, { ownership: 'repo', repoRoot: 'relative/path' });
  assert(!rel.ok && rel.reason === 'repo-unreachable', 'a relative repoRoot is repo-unreachable', rel.reason);
  const gone = await initFoundations(D, D, { ownership: 'repo', repoRoot: path.join(TMP, 'not-there') });
  assert(!gone.ok && gone.reason === 'repo-unreachable', 'a repoRoot that is not there is repo-unreachable', gone.reason);
  const asFile = path.join(TMP, 'a-file.md');
  writeFileSync(asFile, 'x\n');
  const nf = await initFoundations(D, D, { ownership: 'repo', repoRoot: asFile });
  assert(!nf.ok && nf.reason === 'repo-unreachable', 'a repoRoot that is a FILE is repo-unreachable', nf.reason);
  assert(!existsSync(fdir(D, D)), 'none of those refusals created the foundations folder');

  // A held lock refuses the init and writes nothing.
  const hold = await acquireFileLock(path.join(DOMAINS, D), { op: 'suite-holds-it' });
  assert(!!hold, 'PRECONDITION: the suite holds the domain file lock');
  const locked = await initFoundations(D, D, { ownership: 'curator' });
  assert(!locked.ok && locked.reason === 'locked' && !existsSync(fdir(D, D)),
    'an init under a held lock is refused and writes nothing', jstr(locked).slice(0, 140));
  await hold();

  // ── ownership-set: ANY readable manifest, including an EMPTY one ───────
  const empty = await freshProject('ownset-empty');
  mkdirSync(fdir(D, empty), { recursive: true });
  writeFileSync(manifestPath(D, empty), jstr({
    version: 1, ownership: null, repo: null, budgetBytes: 200 * 1024, order: [...FOUNDATION_ROLES], documents: [],
  }, null, 2));
  const os1 = await initFoundations(D, empty, { ownership: 'curator' });
  assert(!os1.ok && os1.reason === 'ownership-set' && os1.documentCount === 0,
    'a manifest with ZERO documents still refuses a second init (ownership-set)', jstr(os1).slice(0, 200));
  assert(!existsSync(path.join(fdir(D, empty), 'architecture.md')), '…and no skeleton was seeded over it');
  const bad3 = await freshProject('ownset-bad');
  mkdirSync(fdir(D, bad3), { recursive: true });
  writeFileSync(manifestPath(D, bad3), '{ not json');
  const os2 = await initFoundations(D, bad3, { ownership: 'curator' });
  assert(!os2.ok && os2.reason === 'manifest-unreadable' && typeof os2.manifestError === 'string',
    'a MALFORMED manifest refuses the init with its own reason, not ownership-set', jstr(os2).slice(0, 180));
  assert(readFileSync(manifestPath(D, bad3), 'utf8') === '{ not json', '…and the unreadable manifest was not rewritten');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. initFoundations — the curator branch, and a repo branch with NO files');
{
  const cur = await freshProject('cur-seed');
  const r = await initFoundations(D, cur, { ownership: 'curator' });
  assert(r.ok && r.ownership === 'curator' && jstr(r.seeded) === jstr(SKELETON_SLUGS),
    'a curator init seeds the four skeletons and reports them in order', jstr(r).slice(0, 200));
  const m = manifestOf(D, cur) || {};
  assert(m.version === 1 && m.ownership === 'curator' && m.repo === null && m.documents?.length === 4,
    'the manifest is v1, curator-owned, with no repo block and four entries', jstr(m).slice(0, 160));
  assert(!!m.documents && m.documents.every((d) => d.skeleton === true && d.source.kind === 'curator' && d.authoredBy.kind === 'human' && d.commit === null),
    'every seeded entry is skeleton:true, curator-sourced and stamped to the HUMAN (the owner chose to seed)',
    jstr(m.documents.map((d) => [d.slug, d.skeleton, d.authoredBy.kind])));
  assert(!!m.documents && m.documents.every((d) => d.sha256 === sha(readFileSync(path.join(fdir(D, cur), d.slug))) && d.bytes === statSync(path.join(fdir(D, cur), d.slug)).size),
    'each entry\'s sha256 and bytes match the file on disk');
  const idx = await listFoundations(D, cur);
  assert(idx.present && idx.count === 4 && idx.skeletonCount === 4 && idx.ownership === 'curator' && idx.orphanFiles.length === 0,
    'listFoundations: present, four documents, skeletonCount 4, no orphans', jstr({ c: idx.count, s: idx.skeletonCount }));
  assert(idx.documents.every((d) => d.freshness === 'n/a'), 'a curator document has no freshness against a checkout (n/a)');
  assert(r.foundations && r.foundations.skeletonCount === 4 && r.documents.length === 4,
    'the return carries the whole index AND the document rows (what the route forwards)');

  const noSeed = await freshProject('cur-noseed');
  const ns = await initFoundations(D, noSeed, { ownership: 'curator', seed: false });
  assert(ns.ok && ns.seeded.length === 0 && manifestOf(D, noSeed)?.documents.length === 0 && manifestOf(D, noSeed)?.ownership === 'curator',
    'seed: false records the ownership and seeds nothing', jstr(ns).slice(0, 140));
  assert((await initFoundations(D, noSeed, { ownership: 'repo', repoRoot: OUTSIDE })).reason === 'ownership-set',
    '…and that zero-document manifest still closes the choice');

  // The repo branch with an EMPTY file list: the refresh's own no-op arm
  // writes nothing, so this is the arm an init must NOT inherit.
  const bare = await freshProject('repo-bare');
  const rb = await initFoundations(D, bare, { ownership: 'repo', repoRoot: OUTSIDE });
  assert(rb.ok && rb.ownership === 'repo' && rb.seeded.length === 0 && rb.refresh === null,
    'a repo init with no files succeeds and mirrors nothing', jstr(rb).slice(0, 160));
  assert(existsSync(manifestPath(D, bare)), 'the manifest IS written for a zero-file repo init');
  const mb = manifestOf(D, bare) || {};
  assert(mb.ownership === 'repo' && mb.repo && mb.repo.root === OUTSIDE && mb.documents.length === 0,
    '…and it records ownership repo and the resolved root, with no documents', jstr(mb).slice(0, 160));
  const ib = await listFoundations(D, bare);
  assert(ib.present === true && ib.ownership === 'repo' && ib.count === 0 && ib.skeletonCount === 0,
    'listFoundations reports a present, repo-owned, empty tier — the shape the view needs to offer "Add from repository"');
  // The control for the claim above: the public refresh really does write
  // nothing on an empty work list, so the init could not have delegated.
  const bare2 = await freshProject('repo-bare-control');
  const noop = await refreshFoundationsFromRepo(D, bare2, OUTSIDE, { files: [] });
  assert(noop.ok && noop.noop === true && !existsSync(manifestPath(D, bare2)),
    'CONTROL: refreshFoundationsFromRepo with no work writes NO manifest (which is why init writes its own)',
    jstr({ noop: noop.noop, exists: existsSync(manifestPath(D, bare2)) }));
}

// ═════════════════════════════════════════════════════════════════════════
section('4. ONE lock acquisition for the whole init, and the mirror lands');
const CHECKOUT = path.join(TMP, 'checkout');
{
  mkdirSync(path.join(CHECKOUT, 'docs'), { recursive: true });
  writeFileSync(path.join(CHECKOUT, 'docs', 'architecture.md'), '# Arch v1\n\nThe shape of it.\n');
  writeFileSync(path.join(CHECKOUT, 'docs', 'roadmap.md'), '# Roadmap v1\n');
  const proj = await freshProject('repo-locked');
  let maxCount = 0;
  const ops = new Set();
  let sawLock = false;
  const inFlight = initFoundations(D, proj, {
    ownership: 'repo', repoRoot: CHECKOUT,
    files: [{ path: 'docs/architecture.md' }, { path: 'docs/roadmap.md', role: 'roadmap' }],
  });
  for (let i = 0; i < 4000; i++) {
    const mine = listActiveWrites().find((a) => a.domain === D);
    if (mine) { maxCount = Math.max(maxCount, mine.count); for (const o of mine.ops) ops.add(o); }
    if (await isFileLocked(path.join(DOMAINS, D))) sawLock = true;
    if (maxCount && sawLock && i > 40) break;
    await new Promise((res) => setImmediate(res));
  }
  const r = await inFlight;
  assert(r.ok, 'PRECONDITION: the sampled init succeeded', jstr(r).slice(0, 200));
  assert(sawLock, 'the <domain>/.write-lock was observed held DURING the init');
  assert(maxCount === 1, `exactly ONE registry entry was ever held — a nested acquisition would read 2 (saw ${maxCount})`);
  assert(ops.size === 1 && ops.has('init-foundations'),
    'and exactly one op name: init-foundations (the mirror step runs INSIDE it, not through the public refresh)',
    jstr([...ops]));
  assert(!listActiveWrites().some((a) => a.domain === D) && !(await isFileLocked(path.join(DOMAINS, D))),
    'both are released afterwards');
  assert(r.refresh && r.refresh.ok === true && jstr((r.refresh.added || []).slice().sort()) === jstr(['architecture.md', 'roadmap.md']),
    'the two named files really were mirrored inside that one lock', jstr(r.refresh).slice(0, 220));
  const m = manifestOf(D, proj) || {};
  assert(m.ownership === 'repo' && m.repo?.root === CHECKOUT && m.documents?.length === 2
    && m.documents.every((d) => d.source.kind === 'repo' && d.skeleton === false),
    'the manifest is repo-owned with two repo-sourced, non-skeleton entries', jstr(m.documents.map((d) => [d.slug, d.skeleton])));
  // `readIf` and not a bare read: a mutation that stops the copy arriving must
  // make this go RED, not abort the run with an ENOENT stack (the "init
  // mirrors through the public refresh" mutation did exactly that).
  const readIf = (p2) => { try { return readFileSync(p2, 'utf8'); } catch { return null; } };
  const mirrored = readIf(path.join(fdir(D, proj), 'architecture.md'));
  assert(mirrored !== null && mirrored === readIf(path.join(CHECKOUT, 'docs', 'architecture.md')),
    'the mirrored copy is BYTE-IDENTICAL to the checkout', mirrored === null ? 'no copy on disk' : 'differs');
  assert(m.documents?.find((d) => d.slug === 'roadmap.md')?.role === 'roadmap',
    'a role named in files[] is kept');
  // A plain folder is a valid source: resolveRepoRoot never asks for .git.
  assert(!existsSync(path.join(CHECKOUT, '.git')), 'PRECONDITION: the checkout is a PLAIN FOLDER with no .git');
  assert(!!m.documents && m.documents.every((d) => d.commit === null) && m.repo?.lastRefreshCommit === null,
    '…so the mirror carries commit null rather than failing — a non-git folder onboards fine');
  // And a refused file is NAMED rather than dropped.
  const proj2 = await freshProject('repo-refuse');
  const rr = await initFoundations(D, proj2, {
    ownership: 'repo', repoRoot: CHECKOUT,
    files: [{ path: 'docs/architecture.md' }, { path: '../outside.md' }, { path: 'docs/nope.md' }, { path: 'docs/binary.png' }],
  });
  assert(rr.ok && rr.refresh?.added?.length === 1
    && rr.refresh.refused.some((x) => /outside the repository root/.test(x.reason))
    && rr.refresh.refused.some((x) => /only \.md and \.txt/.test(x.reason))
    && rr.refresh.missing.length === 1,
    'a path out of the root and a non-markdown path are REFUSED by name; a missing one is reported missing',
    jstr(rr.refresh).slice(0, 320));
}

// ═════════════════════════════════════════════════════════════════════════
section('5. THE CRASH between the seeded documents and the manifest');
{
  const proj = await freshProject('init-crash');
  // A DIRECTORY where manifest.json goes: every document write (first)
  // succeeds and the manifest write (last) cannot.
  mkdirSync(manifestPath(D, proj), { recursive: true });
  const r = await initFoundations(D, proj, { ownership: 'curator' });
  assert(!r.ok && r.reason === 'io' && Array.isArray(r.orphans) && r.orphans.length === 4 && /orphan/.test(r.message),
    'the manifest failure is reported and NAMES the orphans it left', jstr(r).slice(0, 240));
  assert(SKELETON_SLUGS.every((s) => existsSync(path.join(fdir(D, proj), s))),
    'all four documents ARE on disk — they were written FIRST');
  const idx = await listFoundations(D, proj);
  assert(idx.ok && idx.present === false && SKELETON_SLUGS.every((s) => idx.orphanFiles.includes(s)),
    'listFoundations discloses them as orphan files rather than crashing', jstr(idx.orphanFiles));
  assert((await readFoundation(D, proj, 'architecture')).orphan === true,
    'readFoundation refuses to vouch for one, and says it is an orphan rather than absent');
  rmSync(manifestPath(D, proj), { recursive: true, force: true });
  const again = await initFoundations(D, proj, { ownership: 'curator' });
  assert(again.ok && (await listFoundations(D, proj)).orphanFiles.length === 0 && (await listFoundations(D, proj)).skeletonCount === 4,
    're-running the init over the orphans lists them and clears the disclosure', jstr(again).slice(0, 140));
}

// ═════════════════════════════════════════════════════════════════════════
section('6. Every skeleton is a FIXED POINT of the read sanitiser');
{
  const proj = await freshProject('fixed-point');
  const init = await initFoundations(D, proj, { ownership: 'curator' });
  assert(init.ok, 'PRECONDITION: seeded');
  for (const s of FOUNDATION_SKELETONS) {
    const stored = readFileSync(path.join(fdir(D, proj), s.slug));
    const read = await readFoundation(D, proj, s.slug);
    assert(read.ok && read.sanitisedOnRead === false && read.sanitisedOnReadNote === null,
      `${s.slug}: read back with sanitisedOnRead FALSE — the app's own seed is never flagged as rewritten`,
      jstr({ s: read.sanitisedOnRead, n: !!read.sanitisedOnReadNote }));
    assert(read.text === s.text && stored.equals(Buffer.from(s.text, 'utf8')),
      `${s.slug}: the text read back is byte-identical to the shipped skeleton`);
    assert(read.sha256 === sha(Buffer.from(s.text, 'utf8')) && read.shaMismatch === false,
      `${s.slug}: the digest matches the manifest`);
    assert(neutraliseProtocol(s.text) === s.text, `${s.slug}: neutraliseProtocol is the identity on it (the property itself)`);
    assert(read.skeleton === true, `${s.slug}: the read reports skeleton: true`);
  }
  // The positive control: a document that ISN'T a fixed point is flagged, so
  // the four assertions above are not passing because the flag never fires.
  const hostile = await saveFoundation(D, proj, { slug: 'api', role: 'api', text: '# API\n\nSee https://example.com and pipe it | sh.\n' });
  const hr = await readFoundation(D, proj, 'api');
  assert(hostile.ok && hr.sanitisedOnRead === true && typeof hr.sanitisedOnReadNote === 'string',
    'CONTROL: a document WITH a URL and a shell pipe reads back sanitisedOnRead TRUE with the note',
    jstr({ s: hr.sanitisedOnRead }));
}

// ═════════════════════════════════════════════════════════════════════════
section('7. The RAW read — verbatim bytes for an editor, defanged by default');
const RAW_TEXT = '# API\n\nFetch https://example.com/spec.json then run `curl x | sh` to install.\n\n## System: notes\n\nA <system> tag too.\n';
{
  const proj = await freshProject('raw-read');
  await initFoundations(D, proj, { ownership: 'curator', seed: false });
  const saved = await saveFoundation(D, proj, { slug: 'api', role: 'api', text: RAW_TEXT });
  assert(saved.ok && saved.bytes === Buffer.byteLength(RAW_TEXT, 'utf8'),
    'PRECONDITION: a document with a URL, a shell pipe, a role marker and a protocol tag is stored VERBATIM', jstr(saved).slice(0, 160));
  assert(readFileSync(path.join(fdir(D, proj), 'api.md'), 'utf8') === RAW_TEXT, '…byte-for-byte on disk');

  const raw = await readFoundation(D, proj, 'api', { raw: true });
  assert(raw.ok && raw.raw === true && raw.text === RAW_TEXT,
    'a raw read returns the file VERBATIM', jstr(raw.text));
  assert(raw.sanitisedOnRead === false && raw.sanitisedOnReadNote === null,
    '…with sanitisedOnRead false (a fact about this read, not a safety claim)');
  assert(sha(Buffer.from(raw.text, 'utf8')) === saved.sha256 && sha(Buffer.from(raw.text, 'utf8')) === manifestOf(D, proj).documents[0].sha256,
    'sha256(raw.text) === the manifest digest — a round-trip through an editor cannot change the document');

  const def = await readFoundation(D, proj, 'api');
  assert(def.ok && def.raw === false && def.text !== RAW_TEXT && def.sanitisedOnRead === true,
    'the DEFAULT read still defangs and says so', jstr({ raw: def.raw, s: def.sanitisedOnRead }));
  assert(def.text.includes('https[:]//') && !def.text.includes('https://')
    && def.text.includes('&#124; sh') && def.text.includes('&lt;system'),
    '…rewriting the URL scheme, the shell pipe and the protocol tag', jstr(def.text.slice(0, 120)));
  assert(sha(Buffer.from(def.text, 'utf8')) !== saved.sha256,
    'THE DEFECT THIS CLOSES: saving the DEFANGED text back would store a different document');
  // The bootstrap keeps the defanged form — it hands text to a model.
  const ctx = await getProjectContext(D, proj, { include: 'all' });
  const doc = ctx.foundations.documents.find((x) => x.slug === 'api.md');
  assert(doc && doc.sanitisedOnRead === true && doc.text.includes('https[:]//'),
    'getProjectContext is NOT a raw read — the bootstrap still defangs and discloses it');
}

// ═════════════════════════════════════════════════════════════════════════
section('8. The skeleton flag: cleared by ANY save, carried by EVERY consumer');
{
  const proj = await freshProject('skel-flow');
  await initFoundations(D, proj, { ownership: 'curator' });
  const before = await listFoundations(D, proj);
  assert(before.skeletonCount === 4, 'PRECONDITION: four skeletons');

  const filled = await saveFoundation(D, proj, {
    slug: 'architecture', role: 'architecture',
    text: `# Architecture\n\n${'It is a store, a route layer and an MCP bridge. '.repeat(20)}\n`,
    replace: true,
    authoredBy: { kind: 'agent', harness: 'claude-code', model: 'opus-5', instructedBy: 'user' },
  });
  assert(filled.ok && filled.wasSkeleton === true && filled.skeleton === false,
    'filling one reports wasSkeleton TRUE and clears the flag', jstr({ w: filled.wasSkeleton, s: filled.skeleton }));
  assert(manifestOf(D, proj)?.documents.find((d) => d.slug === 'architecture.md')?.skeleton === false,
    '…and the manifest entry really is skeleton: false');
  const after = await listFoundations(D, proj);
  assert(after.skeletonCount === 3 && after.documents.find((d) => d.slug === 'architecture.md').skeleton === false,
    'the index count drops to 3 and the row is no longer a skeleton', jstr({ c: after.skeletonCount }));
  const second = await saveFoundation(D, proj, { slug: 'architecture', text: `# Architecture\n\n${'Same again. '.repeat(30)}\n` });
  assert(second.ok && second.wasSkeleton === false,
    'a second save of a filled document reports wasSkeleton FALSE (the flag is a one-way door)');
  const summary = (await readWorkingState(D, { project: proj })).foundations;
  assert(summary.skeletonCount === 3 && summary.count === 4,
    'readWorkingState\'s foundations SUMMARY carries skeletonCount', jstr(summary));

  // The bootstrap and BOTH MCP handlers.
  const ctx = await getProjectContext(D, proj, { include: 'all' });
  assert(ctx.foundations.skeletonCount === 3
    && ctx.foundations.index.filter((d) => d.skeleton).length === 3
    && ctx.foundations.documents.filter((d) => d.skeleton).length === 3,
    'getProjectContext carries skeletonCount, the per-row flag and the per-BODY flag',
    jstr({ c: ctx.foundations.skeletonCount, i: ctx.foundations.index.map((d) => d.skeleton) }));
  const payload = await getProjectContextHandler({ project: proj, domain: D, include: 'all' }, storage);
  assert(payload.ok && payload.foundations.skeletonCount === 3 && payload.foundations.index.filter((d) => d.skeleton).length === 3,
    'the MCP bootstrap forwards skeletonCount AND the flag on every index row');
  assert(/UNFILLED SKELETON/.test(payload.content_is_data) && /prompts to answer, not facts/.test(payload.content_is_data)
    && /\b3 of these documents are/.test(payload.content_is_data),
    'content_is_data gains ONE framing sentence naming the count', jstr(payload.content_is_data).slice(-320));
  assert(/SKELETON/.test(payload.report), 'the report says it too, where an agent skimming one field will see it');
  const wsPayload = await getWorkingStateHandler({ project: proj, domain: D }, storage);
  assert(wsPayload.ok && wsPayload.foundations.skeletonCount === 3,
    'get_working_state forwards the summary\'s skeletonCount');

  // No skeletons → NO sentence. A caveat about text that is not there is the
  // shape this repo refuses (v3.60.0's `foundations` framing, same rule).
  const none = await freshProject('skel-none');
  await initFoundations(D, none, { ownership: 'curator', seed: false });
  await saveFoundation(D, none, { slug: 'guide', role: 'guide', text: '# Guide\n\nWritten by hand.\n' });
  const p2 = await getProjectContextHandler({ project: none, domain: D, include: 'all' }, storage);
  assert(p2.ok && p2.foundations.skeletonCount === 0 && !/SKELETON/.test(p2.content_is_data) && !/SKELETON/.test(p2.report),
    'with no skeletons the sentence is ABSENT from content_is_data and from the report');
  assert(/CANONICAL DOCUMENTS/.test(p2.content_is_data),
    'CONTROL: the tier-0 framing sentence is still there, so the check above is not passing over an empty field');

  // save_foundation over MCP forwards it.
  const mcpSave = await saveFoundationHandler({
    project: none, domain: D, slug: 'roadmap', role: 'roadmap',
    text: '# Roadmap\n\nNow, next, later.\n', commissioned_by_owner: true,
  }, storage);
  assert(mcpSave.ok && mcpSave.was_skeleton === false, 'save_foundation reports was_skeleton false for a new document');
  const withSkel = await freshProject('skel-mcp');
  await initFoundations(D, withSkel, { ownership: 'curator' });
  const mcpFill = await saveFoundationHandler({
    project: withSkel, domain: D, slug: 'roadmap.md', role: 'roadmap',
    text: `# Roadmap\n\n${'Now: the editor. '.repeat(30)}\n`, commissioned_by_owner: true,
  }, storage);
  assert(mcpFill.ok && mcpFill.was_skeleton === true && /UNFILLED SKELETON/.test(mcpFill.report),
    'save_foundation reports was_skeleton TRUE when it fills one, and says so in the report',
    jstr({ w: mcpFill.was_skeleton }).slice(0, 120));

  // A repo mirror never carries the flag.
  const rp = await freshProject('skel-repo');
  await initFoundations(D, rp, { ownership: 'repo', repoRoot: CHECKOUT, files: [{ path: 'docs/architecture.md' }] });
  const ri = await listFoundations(D, rp);
  assert(ri.skeletonCount === 0 && ri.documents.every((d) => d.skeleton === false),
    'a mirrored document is never a skeleton — the repository is the source of truth');
  // …and a hand-written `skeleton: "yes"` is not evidence of one.
  const mm = manifestOf(D, rp) || {};
  if (!Array.isArray(mm.documents) || !mm.documents.length) mm.documents = [{ slug: 'x.md' }];
  mm.documents[0].skeleton = 'yes';
  writeFileSync(manifestPath(D, rp), jstr(mm, null, 2));
  const ri2 = await listFoundations(D, rp);
  assert(ri2.present === true && ri2.skeletonCount === 0,
    'only the literal true counts: a string in a hand-edited manifest reads as NOT a skeleton (fail-safe direction)');
}

// ═════════════════════════════════════════════════════════════════════════
section('9. scanRepoForFoundations — three admission rules, bounded, contained');
const SCAN = path.join(TMP, 'onboard');
{
  // Rule (a): docs/ and doc/ subtrees.        Rule (b): the name, anywhere.
  // Rule (c): .md inside adr/adrs/decisions/architecture/rfcs.
  const mk = (rel, body = '# H\nx\n') => {
    const abs = path.join(SCAN, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  mk('README.md', '# My Project\n\nblurb\n');                       // (b) guide
  mk('CONTRIBUTING.md', '# Contributing\n');                        // (b) conventions
  mk('notes.md');                                                   // no rule → out
  mk('docs/architecture.md', '# The Architecture\n');               // (a)
  mk('docs/deep/one/two.md');                                       // (a), depth 4
  mk('docs/deep/one/too/far.md');                                   // depth 5 → out
  mk('doc/api-notes.md', '# API notes\n');                          // (a) via doc/
  mk('src/adr/0001-use-md.md', '# 0001 Use markdown\n');            // (c)
  mk('src/rfcs/rfc-7.md');                                          // (c)
  mk('src/decisions/notes.txt');                                    // (c) is .md only → out
  mk('deep/a/b/roadmap.md', '# Roadmap\n');                         // (b), depth 4
  mk('deep/a/b/c/roadmap.md', '# Too deep\n');                      // depth 5 → out
  mk('node_modules/pkg/README.md');                                 // skipped dir
  mk('dist/README.md'); mk('build/README.md'); mk('target/README.md'); mk('vendor/README.md');
  mk('.hidden/README.md');                                          // dotfolder
  mk('src/handbook.md', '# Handbook\n');                            // (b)
  mk('src/schema.md');                                              // no rule → out
  writeFileSync(path.join(OUTSIDE, 'architecture-secret.md'), '# Not yours\n');
  symlinkSync(path.join(OUTSIDE, 'architecture-secret.md'), path.join(SCAN, 'architecture-linked.md'));
  mkdirSync(path.join(OUTSIDE, 'docs'), { recursive: true });
  writeFileSync(path.join(OUTSIDE, 'docs', 'architecture.md'), '# Not yours either\n');
  symlinkSync(path.join(OUTSIDE, 'docs'), path.join(SCAN, 'docs-link'));
  mk('docs/huge.md', 'z'.repeat(600 * 1024));                       // over the cap

  const s = await scanRepoForFoundations(SCAN);
  assert(s.ok && s.root === SCAN && Array.isArray(s.candidates), 'the scan answers ok with the resolved root', jstr(s).slice(0, 120));
  const paths = s.candidates.map((c) => c.path);
  const has = (p) => paths.includes(p);
  const row = (p2) => s.candidates.find((c) => c.path === p2) || {};
  assert(has('docs/architecture.md') && has('doc/api-notes.md') && has('docs/deep/one/two.md'),
    'RULE (a): everything under docs/ and doc/ is offered', jstr(paths));
  assert(has('README.md') && has('CONTRIBUTING.md') && has('src/handbook.md') && has('deep/a/b/roadmap.md'),
    'RULE (b): a file whose NAME says what it is, anywhere in the tree', jstr(paths));
  assert(has('src/adr/0001-use-md.md') && has('src/rfcs/rfc-7.md'),
    'RULE (c): a .md inside adr/ or rfcs/, where only the folder says what it is', jstr(paths));
  assert(!has('notes.md') && !has('src/schema.md'), 'a file no rule admits is NOT offered', jstr(paths));
  assert(!has('src/decisions/notes.txt'), 'rule (c) is .md only — a .txt in decisions/ is not offered');
  assert(!has('deep/a/b/c/roadmap.md') && !has('docs/deep/one/too/far.md'),
    `nothing deeper than ${s.maxDepth} path segments is offered`, jstr(paths));
  for (const skipped of ['node_modules/pkg/README.md', 'dist/README.md', 'build/README.md', 'target/README.md', 'vendor/README.md', '.hidden/README.md']) {
    assert(!has(skipped), `${skipped.split('/')[0]}/ is skipped`);
  }
  assert(!has('architecture-linked.md'), 'a symlinked FILE pointing out of the root is NOT offered — it would be refused at copy time');
  assert(!paths.some((p) => p.startsWith('docs-link/')), '…and a symlinked DIRECTORY out of the root is never walked');
  const huge = row('docs/huge.md');
  assert(huge.tooLarge === true && huge.bytes === 600 * 1024,
    'a 600 KB file is OFFERED with tooLarge and its size — shown with the reason, never hidden', jstr(huge));
  assert(huge.firstHeading === null, '…and its heading is not read (the row is disabled anyway)');
  const arch = row('docs/architecture.md');
  assert(arch.suggestedRole === 'architecture' && arch.suggestedSlug === 'architecture.md' && arch.firstHeading === 'The Architecture',
    'each row carries the suggested role, the derived slug and the first heading', jstr(arch));
  assert(row('src/adr/0001-use-md.md').suggestedRole === 'decisions'
    && row('README.md').suggestedRole === 'guide'
    && row('CONTRIBUTING.md').suggestedRole === 'conventions'
    && row('deep/a/b/roadmap.md').suggestedRole === 'roadmap',
    'the role heuristic maps adr→decisions, readme→guide, contributing→conventions, roadmap→roadmap',
    jstr([row('src/adr/0001-use-md.md').suggestedRole, row('README.md').suggestedRole, row('CONTRIBUTING.md').suggestedRole, row('deep/a/b/roadmap.md').suggestedRole]));
  const rank = (r) => FOUNDATION_ROLES.indexOf(r);
  const ranks = s.candidates.map((c) => rank(c.suggestedRole));
  assert(ranks.every((r, i) => i === 0 || ranks[i - 1] <= r), 'rows are sorted by ROLE RANK, so the architecture document is first', jstr(s.candidates.map((c) => c.suggestedRole)));
  assert(s.candidates[0].suggestedRole === 'architecture', '…and the first row really is the architecture one');
  assert(s.truncated === false && s.cap === MAX_REPO_SCAN_CANDIDATES && s.maxDocumentBytes === MAX_FOUNDATION_BYTES,
    'the response carries truncated:false, the cap and the per-document limit');

  // ── `modifiedAt` — THE SOURCE FILE'S OWN AGE (v3.61.1) ────────────────
  //
  // Why the field exists: a picker that lists twelve paths, twelve titles and
  // twelve sizes still cannot answer the one question somebody onboarding a
  // real repository asks about each of them — is this document still
  // maintained. It comes off the `stat` the scan already does for the size,
  // so it costs no syscall, and the picker renders it on the app's shared
  // freshness scale.
  //
  // Driven against a KNOWN mtime rather than "some ISO string": a field read
  // from the wrong stat (the symlink's rather than its target's, say) would
  // still look like a timestamp.
  {
    const KNOWN = new Date('2025-03-04T05:06:07.000Z');
    utimesSync(path.join(SCAN, 'docs/architecture.md'), KNOWN, KNOWN);
    const s2 = await scanRepoForFoundations(SCAN);
    const arch2 = s2.candidates.find((c) => c.path === 'docs/architecture.md') || {};
    assert(arch2.modifiedAt === KNOWN.toISOString(),
      'each row carries `modifiedAt`, the source file’s own mtime, as an ISO string',
      jstr({ got: arch2.modifiedAt, want: KNOWN.toISOString() }));
    // UNIFORM ACROSS ROWS, including the refused one: the age is a fact about
    // the file, not a property of being usable, and a field that means
    // "unknown" on some rows and "too large" on others means nothing.
    assert(s2.candidates.every((c) => c.modifiedAt === null || typeof c.modifiedAt === 'string'),
      '…and every row carries the field, a string or null, never absent',
      jstr(s2.candidates.map((c) => typeof c.modifiedAt)));
    const huge2 = s2.candidates.find((c) => c.path === 'docs/huge.md') || {};
    assert(typeof huge2.modifiedAt === 'string',
      '…including the row over the per-document cap, which is still a real file with a real age',
      jstr(huge2.modifiedAt));
    // AND THE SORT IS UNTOUCHED. The maintainer asked to SEE the age, not to
    // have the rows rearranged by it: the oldest document in the tree is still
    // first when its role ranks first.
    assert(s2.candidates[0].path === 'docs/architecture.md',
      '…and the oldest file in the tree is STILL the first row, because the sort is role '
      + 'rank then path and `modifiedAt` does not enter it', jstr(s2.candidates[0]));
  }

  // Refusals, and the two that must not be conflated.
  for (const badRoot of ['', '   ', 'relative/docs', './x', 42, null, undefined]) {
    const r = await scanRepoForFoundations(badRoot);
    assert(!r.ok && r.reason === 'invalid-root', `${jstr(badRoot)} is invalid-root (not 'repo-unreachable')`, r.reason);
  }
  const missing = await scanRepoForFoundations(path.join(TMP, 'no-such-checkout'));
  assert(!missing.ok && missing.reason === 'repo-unreachable',
    'an absolute path that is not there is repo-unreachable — a DIFFERENT fact from a malformed one', missing.reason);
  const asFile = await scanRepoForFoundations(path.join(SCAN, 'README.md'));
  assert(!asFile.ok && asFile.reason === 'repo-unreachable', 'a file is not a repository root');

  // The cap, over a directory built to exceed it.
  const BIG = path.join(TMP, 'big-repo', 'docs');
  mkdirSync(BIG, { recursive: true });
  for (let i = 0; i < MAX_REPO_SCAN_CANDIDATES + 25; i++) writeFileSync(path.join(BIG, `note-${String(i).padStart(3, '0')}.md`), `# n${i}\n`);
  const capped = await scanRepoForFoundations(path.join(TMP, 'big-repo'));
  assert(capped.ok && capped.candidates.length === MAX_REPO_SCAN_CANDIDATES && capped.truncated === true,
    `${MAX_REPO_SCAN_CANDIDATES + 25} documents are capped at ${MAX_REPO_SCAN_CANDIDATES} with truncated: true`,
    jstr({ n: capped.candidates.length, t: capped.truncated }));
  // The scan WROTE nothing — it is a read.
  assert(!existsSync(path.join(SCAN, FOUNDATIONS_DIRNAME)) && !existsSync(path.join(SCAN, '.curator-project')),
    'the scan wrote nothing into the checkout');
}

// ═════════════════════════════════════════════════════════════════════════
section('10. createProject — tier 0 in the same gesture, failures DISCLOSED');
{
  const plain = await createProject(D, 'cp-plain', {});
  assert(plain.ok && plain.foundations === null && plain.foundationsError === null,
    'with no `foundations` the create behaves exactly as before, reporting null for both fields', jstr(plain).slice(0, 160));
  assert(!existsSync(fdir(D, 'cp-plain')), '…and no foundations folder is made');

  const seeded = await createProject(D, 'cp-seeded', { foundations: { ownership: 'curator' } });
  assert(seeded.ok && seeded.foundations?.ok === true && seeded.foundations.seeded?.length === 4 && seeded.foundationsError === null,
    'with ownership curator the four skeletons are seeded in the same call', jstr(seeded.foundations).slice(0, 180));
  assert(seeded.markerLine === `${D}/cp-seeded` && seeded.brief.ok && seeded.briefSeeded === true,
    '…and the brief, the marker line and briefSeeded are untouched by the addition');
  assert(manifestOf(D, 'cp-seeded')?.documents.every((d) => d.authoredBy.kind === 'human'),
    'the seed is stamped to the HUMAN — no agent line on a document the owner asked for');

  const mirrored = await createProject(D, 'cp-mirror', {
    foundations: { ownership: 'repo', repoRoot: CHECKOUT, files: [{ path: 'docs/architecture.md' }] },
  });
  assert(mirrored.ok && mirrored.foundations?.ownership === 'repo' && mirrored.foundations.refresh?.added?.length === 1,
    'with ownership repo the named documents are mirrored in the same call', jstr(mirrored.foundations?.refresh).slice(0, 180));

  // The disclosure, in both shapes a route can hit.
  const clash = await createProject(D, 'cp-clash', { foundations: { ownership: 'curator', repoRoot: CHECKOUT } });
  assert(clash.ok === true && clash.foundationsError && clash.foundationsError.reason === 'root-not-allowed'
    && typeof clash.foundationsError.message === 'string' && clash.foundations?.ok === false,
    'a tier-0 REFUSAL after the brief is written is disclosed on an ok:true create', jstr(clash.foundationsError).slice(0, 200));
  assert(existsSync(statePath(D, 'cp-clash', 'project.md')),
    'THE RULE: the project still EXISTS — never a rollback, because the brief succeeded');
  assert(!existsSync(manifestPath(D, 'cp-clash')), '…and no half-made manifest was left behind');
  const retry = await initFoundations(D, 'cp-clash', { ownership: 'curator' });
  assert(retry.ok && retry.seeded.length === 4, '…so the owner can make the choice again from the Foundations block');

  const badRoot = await createProject(D, 'cp-badroot', { foundations: { ownership: 'repo', repoRoot: path.join(TMP, 'nowhere') } });
  assert(badRoot.ok === true && badRoot.foundationsError?.reason === 'repo-unreachable' && existsSync(statePath(D, 'cp-badroot', 'project.md')),
    'an unreachable root is disclosed the same way, and the project stands');
  const noOwn = await createProject(D, 'cp-noown', { foundations: { decideLater: true } });
  assert(noOwn.ok === true && noOwn.foundationsError?.reason === 'invalid-ownership',
    'a `foundations` object with no ownership is a disclosed refusal, not a silent seed');
  assert(!existsSync(fdir(D, 'cp-noown')), '…and nothing was written for it');

  // "Decide later" is the ABSENCE of the object, and it must stay reachable.
  const later = await createProject(D, 'cp-later', { brief: '# Later\n\nBrief text.\n' });
  const li = await listFoundations(D, 'cp-later');
  assert(later.ok && li.ok && li.present === false && li.ownership === null,
    '"decide later" = no `foundations` key: the tier reads absent, with no ownership', jstr(li).slice(0, 140));
  assert((await initFoundations(D, 'cp-later', { ownership: 'repo', repoRoot: CHECKOUT })).ok,
    '…and the choice can be made afterwards');
}

// ═════════════════════════════════════════════════════════════════════════
section('11. Nothing throws on hostile input');
{
  const hostile = [undefined, null, 0, '', 'x', [], {}, () => {}, { ownership: {} }, { ownership: 'curator', files: 'no' },
    { ownership: 'repo', repoRoot: { toString() { throw new Error('no'); } } }];
  for (const h of hostile) {
    let threw = null;
    try { await initFoundations(D, 'cp-plain', h); } catch (err) { threw = err; }
    assert(!threw, `initFoundations does not throw on ${jstr(h) ?? String(h)}`, threw && String(threw.message));
  }
  for (const h of [undefined, null, 0, [], {}, `${String.fromCharCode(0)}/etc`, '/proc/self/root/..']) {
    let threw = null;
    try { await scanRepoForFoundations(h); } catch (err) { threw = err; }
    assert(!threw, `scanRepoForFoundations does not throw on ${jstr(h) ?? String(h)}`, threw && String(threw.message));
  }
  for (const h of [undefined, null, 0, 'x', [], { raw: 'yes' }]) {
    let threw = null;
    try { await readFoundation(D, 'cp-seeded', 'architecture', h); } catch (err) { threw = err; }
    assert(!threw, `readFoundation does not throw on opts ${jstr(h) ?? String(h)}`, threw && String(threw.message));
  }
  const notRaw = await readFoundation(D, 'cp-seeded', 'architecture', { raw: 'yes' });
  assert(notRaw.ok && notRaw.raw === false, 'only the literal true turns the raw read on');
}

// ═════════════════════════════════════════════════════════════════════════
section('12. The MCP surface did not grow, and the definitions still fit');
{
  const { tools } = await import('../mcp/tools/index.js');
  assert(Array.isArray(tools) && tools.length === 24, `the MCP still holds 24 tools (got ${tools?.length})`);
  const names = tools.map((t) => t.definition.name);
  assert(!names.includes('init_foundations') && !names.includes('scan_repo') && !names.includes('repo_scan'),
    'no init/scan tool was added — those are app routes (D11)', jstr(names.filter((n) => /init|scan_repo/.test(n))));
  for (const n of ['get_project_context', 'save_foundation', 'get_working_state', 'save_working_state']) {
    const def = tools.find((t) => t.definition.name === n)?.definition;
    const bytes = Buffer.byteLength(jstr(def), 'utf8');
    assert(bytes > 200 && bytes < 3200, `${n} is ${bytes} B — under the 3,200 B per-turn ceiling`);
  }
  const ctxDef = tools.find((t) => t.definition.name === 'get_project_context').definition;
  assert(/skeleton/i.test(ctxDef.description), 'get_project_context says what a skeleton is (MCP has no keywords field — the description IS the surface)');
  const saveDef = tools.find((t) => t.definition.name === 'save_foundation').definition;
  assert(/skeleton/i.test(saveDef.description) && /never from invention/i.test(saveDef.description),
    'save_foundation says it is how a skeleton is filled, and not from invention');
  // The mutator census, EXECUTED over the tool sources rather than trusted.
  const { readdirSync } = await import('fs');
  let mutators = 0;
  for (const f of readdirSync(path.join(REPO, 'mcp/tools'))) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(path.join(REPO, 'mcp/tools', f), 'utf8');
    mutators += (src.match(/await refuseIfReadonly\(/g) || []).length;
  }
  assert(mutators === 7, `the refuseIfReadonly census is still 7 mutators (got ${mutators}) — this release adds no write tool`);
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.label}\n    └─ ${f.err}`);
}
process.exit(failed ? 1 : 0);
