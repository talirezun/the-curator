#!/usr/bin/env node
/**
 * test-sync-line-records.js — OFFLINE, real git, a local bare remote, two computers.
 *
 * The defect (reproduced 2026-11-14 with plain git): two computers each append a
 * line to a domain's `wiki/.raw-manifest.jsonl`, then sync. pull()'s
 * `git pull --no-rebase -X theirs` decides the shared end-of-file hunk for the
 * OTHER computer, so this computer's line was silently dropped — and with it the
 * record that a source was read (the same-model no-call rule, duplicate
 * detection and the `keyFacts` marker all read that file).
 *
 * The fix (sync-records.js + reconcileRecordFiles in sync.js): after git's merge,
 * every record file BOTH computers changed is recomputed as a three-way merge of
 * RECORDS (JSONL lines; log.md entry blocks) and committed on top. A first fix
 * used git's `merge=union`; an independent audit proved it brought undismissed
 * Health rows back and mis-attributed log.md entries that listed the same pages,
 * so §2 and §3 pin exactly those cases.
 *
 * This suite drives the app's OWN setup()/pull()/push()/sync() on two computers
 * and reads the files on both computers and the remote. It also pins what must
 * NOT change: a wiki page still merges `-X theirs`, the user's `.gitattributes`
 * is untouched, the app writes nothing to info/attributes, and no commit is
 * rewritten.
 *
 * ISOLATION. Temp dirs only: CURATOR_TEST_USER_DATA_DIR, CURATOR_TEST_DOMAINS_DIR
 * and the sync seams point inside one mkdtemp. CURATOR_NO_OPEN=1. No network.
 *
 * Run: node scripts/test-sync-line-records.js
 */
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const ROOT_TMP = mkdtempSync(path.join(tmpdir(), 'curator-line-records-'));
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(ROOT_TMP, 'user-data');
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(ROOT_TMP, 'unused-domains');
process.env.CURATOR_NO_OPEN = '1';
mkdirSync(process.env.CURATOR_TEST_USER_DATA_DIR);
mkdirSync(process.env.CURATOR_TEST_DOMAINS_DIR);

const sync = await import('../src/brain/sync.js');
const records = await import('../src/brain/sync-records.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
const { __setSyncTestOverrides, setup, pull, push } = sync;

const sh = (cmd, cwd = ROOT_TMP) =>
  execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).toString();

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
const eq = (a, b, msg) => ok(a === b, `${msg}${a === b ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);
const section = (t) => console.log(`\n${t}\n`);

let n = 0;
function write(base, rel, text) {
  const p = path.join(base, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
}
function append(base, rel, text) {
  const p = path.join(base, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  appendFileSync(p, text);
}
const read = (base, rel) => readFileSync(path.join(base, rel), 'utf8');

function computer(remote, name) {
  const dir = path.join(ROOT_TMP, `${name}-${++n}`);
  mkdirSync(dir);
  const c = {
    name,
    domains: path.join(dir, 'folder'),
    gitDir: path.join(dir, 'gitdir'),
    configFile: path.join(dir, 'config.json'),
    url: `file://${remote}`,
    use() {
      __setDomainsDirOverride(c.domains);
      __setSyncTestOverrides({ gitDir: c.gitDir, configFile: c.configFile });
      return c;
    },
  };
  mkdirSync(c.domains);
  return c.use();
}
function newRemote() {
  const r = path.join(ROOT_TMP, `remote-${++n}.git`);
  sh(`git init -q --bare -b main "${r}"`);
  return r;
}
const remoteBlob = (remote, p) => sh(`git --git-dir="${remote}" show "main:${p}"`);
const remoteHead = (remote) => sh(`git --git-dir="${remote}" rev-parse main`).trim();
const isAncestor = (remote, a, b) => {
  try { sh(`git --git-dir="${remote}" merge-base --is-ancestor ${a} ${b}`); return true; } catch { return false; }
};

const MANIFEST = 'd/wiki/.raw-manifest.jsonl';
const DISMISSED = 'd/wiki/.health-dismissed.jsonl';
const LOG = 'd/wiki/log.md';
const JOURNAL = 'd/state/proj/claude-code/shared-machine/journal.jsonl';
const dis = (slug) => `{"type":"orphans","slug":"${slug}","dismissedAt":"2026-11-01"}\n`;
const logEntry = (title, pages, extra = '') =>
  `## [2026-11-14] ingest | ${title}\nPages created or updated:\n${pages.map((p) => `- ${p}`).join('\n')}\n${extra}\n`;

function seed(base) {
  write(base, 'd/CLAUDE.md', 'schema\n');
  write(base, 'd/wiki/index.md', '# Index\n');
  write(base, 'd/wiki/entities/p.md', '# P\n\nline one\n');
  write(base, MANIFEST, '{"filename":"old.md","completed":true}\n');
  write(base, DISMISSED, ['x1', 'x2', 'x3', 'x4'].map(dis).join(''));
  write(base, LOG, `# Log\n\n${logEntry('old', ['summaries/old.md'])}\n`);
  write(base, JOURNAL, '{"at":"2026-11-01","headline":"old"}\n');
}

/** Two computers on one remote, both holding the seed. */
async function pair(userAttrs) {
  const remote = newRemote();
  const A = computer(remote, 'a');
  seed(A.domains);
  if (userAttrs) write(A.domains, '.gitattributes', userAttrs);
  await setup(A.url, 't', 'push');
  const B = computer(remote, 'b');
  await setup(B.url, 't', 'pull');
  return { remote, A, B };
}
/** A changes and syncs, B changes and syncs, A pulls: the ordinary two-computer race. */
async function race({ A, B }, onA, onB) {
  A.use(); onA(A.domains); await sync.sync();
  B.use(); onB(B.domains); await sync.sync();
  A.use(); await pull();
}
const lines = (t) => t.split('\n').filter((l) => l.trim());
const slugs = (t) => lines(t).map((l) => JSON.parse(l).slug);

try {
  section('0. The pure merge (sync-records.js)');
  {
    eq(records.recordKind('d/wiki/.raw-manifest.jsonl'), 'lines', 'the manifest is a line-record file');
    eq(records.recordKind('d/wiki/.health-dismissed.jsonl'), 'lines', 'Health dismissals are line records');
    eq(records.recordKind('d/wiki/log.md'), 'log', 'log.md merges by entry block');
    eq(records.recordKind('d/state/p/s/m/journal.jsonl'), 'lines', 'a working-state journal is line records');
    for (const p of ['d/wiki/index.md', 'd/wiki/entities/log.md', 'd/wiki/concepts/x.md', 'd/state/project.md',
      'd/wiki/summaries/a.md', 'd/state/p/s/m/current.md', 'd/conversations/x.json', 'd/wiki/../wiki/log.md']) {
      eq(records.recordKind(p), null, `never a record file: ${p}`);
    }
    const base = 'a\nb\nc\n';
    eq(records.mergeLineRecords(base, 'a\nb\nc\nours\n', 'a\nb\nc\ntheirs\n'), 'a\nb\nc\nours\ntheirs\n', 'both appends kept, ours first');
    eq(records.mergeLineRecords(base, 'a\nb\nc\nnew\n', 'a\nb\n'), 'a\nb\nnew\n', 'a deletion by theirs is respected');
    eq(records.mergeLineRecords(base, 'a\n', 'a\nb\nc\nnew\n'), 'a\nnew\n', 'a deletion by ours is respected');
    eq(records.mergeLineRecords(base, 'a\nb\nc\nsame\n', 'a\nb\nc\nsame\n'), 'a\nb\nc\nsame\n', 'an identical append appears once');
    eq(records.mergeLineRecords('', 'x\n', 'y\n'), 'x\ny\n', 'no base: both kept');
  }

  section('1. Two computers append to every record file, then sync: nothing is dropped');
  const USER_ATTRS = '# mine\n*.png binary\n';
  const P = await pair(USER_ATTRS);
  const { remote, A, B } = P;
  const headBefore = remoteHead(remote);
  const add = {
    [MANIFEST]: (w) => `{"filename":"${w}.md","completed":true,"model":"m","keyFacts":1}\n`,
    [DISMISSED]: (w) => dis(`${w}-page`),
    [JOURNAL]: (w) => `{"at":"2026-11-14","headline":"${w} saved"}\n`,
  };
  await race(P,
    (d) => { for (const [rel, f] of Object.entries(add)) append(d, rel, f('alpha')); write(d, 'd/wiki/entities/p.md', '# P\n\nline one, by A\n'); },
    (d) => { for (const [rel, f] of Object.entries(add)) append(d, rel, f('beta')); write(d, 'd/wiki/entities/p.md', '# P\n\nline one, by B\n'); });
  for (const [rel, f] of Object.entries(add)) {
    for (const c of [A, B]) {
      const t = read(c.domains, rel);
      ok(lines(t).filter((l) => l === f('alpha').trim()).length === 1 && lines(t).filter((l) => l === f('beta').trim()).length === 1,
        `${rel}: both computers' lines, once each, on computer ${c.name.toUpperCase()}`);
    }
    const r = remoteBlob(remote, rel);
    ok(r.includes(f('alpha')) && r.includes(f('beta')), `${rel}: both lines on the remote`);
    eq(read(A.domains, rel), read(B.domains, rel), `${rel}: both computers end byte-identical`);
  }
  ok(read(A.domains, MANIFEST).startsWith('{"filename":"old.md","completed":true}\n'), 'the manifest keeps its earlier record first');

  section('2. Health dismissals: an undismiss is respected, a new dismissal is kept (audit case 7)');
  {
    const Q = await pair();
    await race(Q,
      (d) => write(d, DISMISSED, ['x1', 'x2', 'x3'].map(dis).join('')),               // A undismisses the LAST (x4)
      (d) => append(d, DISMISSED, dis('x5')));                                         // B dismisses a new one
    for (const c of [Q.A, Q.B]) eq(slugs(read(c.domains, DISMISSED)).join(','), 'x1,x2,x3,x5', `undismissed x4 stays gone, x5 kept (computer ${c.name.toUpperCase()})`);

    const R = await pair();
    await race(R,
      (d) => write(d, DISMISSED, ['x1', 'x4'].map(dis).join('')),                      // A undismisses x2, x3 (adjacent)
      (d) => write(d, DISMISSED, ['x1', 'x2', 'x3', 'x4', 'x6'].map(dis).join('')));   // B adds x6
    for (const c of [R.A, R.B]) eq(slugs(read(c.domains, DISMISSED)).join(','), 'x1,x4,x6', `two adjacent undismissals stay gone (computer ${c.name.toUpperCase()})`);

    const S = await pair();
    await race(S,
      (d) => write(d, DISMISSED, ''),                                                   // A undismisses everything
      (d) => append(d, DISMISSED, dis('x7')));
    for (const c of [S.A, S.B]) eq(slugs(read(c.domains, DISMISSED)).join(','), 'x7', `undismiss-all keeps only the new dismissal (computer ${c.name.toUpperCase()})`);

    const T = await pair();
    await race(T,
      (d) => write(d, DISMISSED, ['x1', 'x3', 'x4'].map(dis).join('')),               // both undismiss, different rows
      (d) => write(d, DISMISSED, ['x1', 'x2', 'x3'].map(dis).join('')));
    for (const c of [T.A, T.B]) eq(slugs(read(c.domains, DISMISSED)).join(','), 'x1,x3', `both computers' undismissals hold (computer ${c.name.toUpperCase()})`);
  }

  section('3. log.md: each computer\'s entry stays whole, even when they list the same pages (audit case 8)');
  {
    const L = await pair();
    const entA = logEntry('Report A', ['summaries/report-a.md', 'entities/acme.md', 'concepts/pricing.md']);
    const entB = logEntry('Report B', ['summaries/report-b.md', 'entities/acme.md', 'concepts/pricing.md'], '\nWarnings:\n- something\n');
    await race(L, (d) => append(d, LOG, entA + '\n'), (d) => append(d, LOG, entB + '\n'));
    for (const c of [L.A, L.B]) {
      const t = read(c.domains, LOG);
      ok(t.includes(entA.trimEnd()), `Report A's entry is whole on computer ${c.name.toUpperCase()}`);
      ok(t.includes(entB.trimEnd()), `Report B's entry is whole, its pages under its own heading, on computer ${c.name.toUpperCase()}`);
      ok(t.startsWith('# Log\n\n## [2026-11-14] ingest | old\n'), `the header and the earlier entry stay first on computer ${c.name.toUpperCase()}`);
      eq(t.split('## [').length - 1, 3, `three entries, none duplicated, on computer ${c.name.toUpperCase()}`);
    }
    eq(read(L.A.domains, LOG), read(L.B.domains, LOG), 'both computers end byte-identical');
    ok(remoteBlob(L.remote, LOG).includes(entB.trimEnd()), 'and the remote has both entries whole');

    const L2 = await pair();
    await race(L2,
      (d) => write(d, LOG, read(d, LOG).replace('# Log', '# Log (renamed)')),
      (d) => append(d, LOG, logEntry('Later', ['summaries/later.md']) + '\n'));
    for (const c of [L2.A, L2.B]) {
      const t = read(c.domains, LOG);
      ok(t.startsWith('# Log (renamed)\n') && t.includes('## [2026-11-14] ingest | Later\n'),
        `a header change on one side and an entry on the other both land, header first (computer ${c.name.toUpperCase()})`);
    }
  }

  section('4. What must not change');
  eq(read(B.domains, 'd/wiki/entities/p.md'), '# P\n\nline one, by A\n', 'a wiki page both computers edited still merges -X theirs (the remote side), as before');
  eq(read(A.domains, 'd/wiki/entities/p.md'), read(B.domains, 'd/wiki/entities/p.md'), 'and both computers agree on it');
  ok(read(A.domains, '.gitattributes') === USER_ATTRS && read(B.domains, '.gitattributes') === USER_ATTRS, "the user's own .gitattributes is untouched on both computers");
  eq(remoteBlob(remote, '.gitattributes'), USER_ATTRS, 'and the remote carries it unchanged');
  for (const c of [A, B]) {
    const f = path.join(c.gitDir, 'info', 'attributes');
    ok(!existsSync(f) || !/curator|merge=/i.test(readFileSync(f, 'utf8')), `the app writes nothing to info/attributes (computer ${c.name.toUpperCase()})`);
  }
  ok(isAncestor(remote, headBefore, remoteHead(remote)), 'no history rewritten: the earlier remote head is an ancestor of the new one');
  ok(/Sync: kept both computers' records/.test(sh(`git --git-dir="${remote}" log --format=%s main`)),
    'the reconciliation is its own commit, named for what it did');

  section('5. Both computers create the same file (no common base) — both records kept');
  {
    A.use();
    write(A.domains, 'e/CLAUDE.md', 'schema\n');
    write(A.domains, 'e/wiki/.raw-manifest.jsonl', '{"filename":"a-first.md","completed":true}\n');
    await sync.sync();
    B.use();
    write(B.domains, 'e/CLAUDE.md', 'schema\n');
    write(B.domains, 'e/wiki/.raw-manifest.jsonl', '{"filename":"b-first.md","completed":true}\n');
    await sync.sync();
    A.use();
    await pull();
    for (const c of [A, B]) {
      const t = read(c.domains, 'e/wiki/.raw-manifest.jsonl');
      ok(t.includes('a-first.md') && t.includes('b-first.md'), `add/add manifest keeps both records on computer ${c.name.toUpperCase()}`);
    }
  }

  section('6. A merge connect (setup mode "merge") keeps both too');
  {
    const r2 = newRemote();
    const C = computer(r2, 'c');
    seed(C.domains);
    await setup(C.url, 't', 'push');
    const D = computer(r2, 'd');
    seed(D.domains);
    append(D.domains, MANIFEST, '{"filename":"d-only.md","completed":true}\n');
    C.use();
    append(C.domains, MANIFEST, '{"filename":"c-only.md","completed":true}\n');
    await push();
    D.use();
    await setup(D.url, 't', 'merge');
    const t = read(D.domains, MANIFEST);
    ok(t.includes('c-only.md') && t.includes('d-only.md'), "a first connect by merge keeps both computers' records");
    eq(sh(`git --git-dir="${D.gitDir}" --work-tree="${D.domains}" status --porcelain`), '', 'and leaves a clean tree');
  }
} finally {
  __setSyncTestOverrides({});
  __setDomainsDirOverride(null);
  rmSync(ROOT_TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
