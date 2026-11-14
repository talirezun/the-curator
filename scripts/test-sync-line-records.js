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
 * The fix is a `merge=union` rule for the app's line-record files, written into
 * `<git dir>/info/attributes` by pull() and by every connect. This suite drives
 * the app's OWN setup()/pull()/push()/sync() on two computers and asserts, for
 * each affected file, that both computers' lines survive on both machines and on
 * the remote. It also pins what must NOT change: a wiki page still merges the
 * old way, a user's `.gitattributes` and own info/attributes lines are kept
 * byte-for-byte, and no commit is rewritten.
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
const isAncestor = (remote, a, b) => {
  try { sh(`git --git-dir="${remote}" merge-base --is-ancestor ${a} ${b}`); return true; } catch { return false; }
};

// Every line-record file the app writes into a synced domain, and a line per computer.
const MANIFEST = 'd/wiki/.raw-manifest.jsonl';
const DISMISSED = 'd/wiki/.health-dismissed.jsonl';
const LOG = 'd/wiki/log.md';
const JOURNAL = 'd/state/proj/claude-code/shared-machine/journal.jsonl';
const FILES = {
  [MANIFEST]: (who) => `{"filename":"${who}.md","sha256":null,"completed":true,"model":"m","keyFacts":1}\n`,
  [DISMISSED]: (who) => `{"type":"orphans","slug":"${who}-page","dismissedAt":"2026-11-14"}\n`,
  [LOG]: (who) => `## [2026-11-14] ingest | ${who} source\nPages created or updated: ${who}-page\n\n`,
  // A journal path is per-machine by design; this one is deliberately shared to
  // prove the net holds if two writers ever meet.
  [JOURNAL]: (who) => `{"at":"2026-11-14","headline":"${who} saved"}\n`,
};

// Every non-blank line a computer wrote is a line of the merged file. Blank lines
// are left out of the check on purpose: log.md entries end in a blank line, and
// when both computers append one, union keeps that shared blank line ONCE, so two
// new entries can abut (measured; content is never lost, see sync.js).
const contentLines = (block) => block.split('\n').filter((l) => l.trim());
const survives = (text, block) => { const have = new Set(text.split('\n')); return contentLines(block).every((l) => have.has(l)); };
const onceEach = (text, block) => contentLines(block).every((l) => text.split('\n').filter((x) => x === l).length === 1);

function seed(base) {
  write(base, 'd/CLAUDE.md', 'schema\n');
  write(base, 'd/wiki/index.md', '# Index\n');
  write(base, 'd/wiki/entities/p.md', '# P\n\nline one\n');
  write(base, MANIFEST, '{"filename":"old.md","completed":true}\n');
  write(base, DISMISSED, '{"type":"orphans","slug":"old-page","dismissedAt":"2026-11-01"}\n');
  write(base, LOG, '# Log\n\n## [2026-11-01] ingest | old\nPages created or updated: old\n\n');
  write(base, JOURNAL, '{"at":"2026-11-01","headline":"old"}\n');
}

try {
  section('1. Two computers append to every line-record file, then sync: nothing is dropped');
  const remote = newRemote();
  const A = computer(remote, 'a');
  seed(A.domains);
  // A user's own .gitattributes in the vault, which must stay byte-for-byte.
  const USER_ATTRS = '# mine\n*.png binary\n';
  write(A.domains, '.gitattributes', USER_ATTRS);
  await setup(A.url, 't', 'push');

  const B = computer(remote, 'b');
  await setup(B.url, 't', 'pull');
  ok(existsSync(path.join(B.domains, MANIFEST)), 'the second computer has the domain after connecting');

  // An existing install, configured before this release: no union block yet.
  // The next pull() must write it with no user action.
  for (const c of [A, B]) rmSync(path.join(c.gitDir, 'info', 'attributes'), { force: true });
  // A user's own machine-local attribute line, which must be kept.
  write(B.gitDir, 'info/attributes', '*.pdf -diff\n');

  const headBefore = sh(`git --git-dir="${remote}" rev-parse main`).trim();

  A.use();
  for (const [rel, line] of Object.entries(FILES)) append(A.domains, rel, line('alpha'));
  write(A.domains, 'd/wiki/entities/p.md', '# P\n\nline one, by A\n');
  await sync.sync();

  B.use();
  for (const [rel, line] of Object.entries(FILES)) append(B.domains, rel, line('beta'));
  write(B.domains, 'd/wiki/entities/p.md', '# P\n\nline one, by B\n');
  await sync.sync();

  A.use();
  await pull();

  for (const [rel, line] of Object.entries(FILES)) {
    for (const [c, label] of [[A, 'computer A'], [B, 'computer B']]) {
      const text = read(c.domains, rel);
      ok(survives(text, line('alpha')) && survives(text, line('beta')),
        `${rel}: both computers' lines survive on ${label}`);
      ok(onceEach(text, line('alpha')) && onceEach(text, line('beta')),
        `${rel}: each line appears once on ${label}`);
    }
    const r = remoteBlob(remote, rel);
    ok(survives(r, line('alpha')) && survives(r, line('beta')), `${rel}: both lines are on the remote`);
    ok(read(A.domains, rel) === read(B.domains, rel), `${rel}: both computers end byte-identical`);
  }
  ok(read(A.domains, MANIFEST).startsWith('{"filename":"old.md","completed":true}\n'),
    'the manifest keeps its earlier record first');
  ok(read(A.domains, LOG).includes('## [2026-11-14] ingest | alpha source\nPages created or updated: alpha-page\n') &&
     read(A.domains, LOG).includes('## [2026-11-14] ingest | beta source\nPages created or updated: beta-page\n'),
    'log.md keeps each entry whole (heading with its own lines)');

  section('2. What must not change');
  ok(read(B.domains, 'd/wiki/entities/p.md') === '# P\n\nline one, by A\n',
    'a wiki page both computers edited still merges -X theirs (the remote side), as before');
  ok(read(A.domains, 'd/wiki/entities/p.md') === read(B.domains, 'd/wiki/entities/p.md'), 'and both computers agree on it');
  ok(read(A.domains, '.gitattributes') === USER_ATTRS && read(B.domains, '.gitattributes') === USER_ATTRS,
    "the user's own .gitattributes is untouched on both computers");
  ok(remoteBlob(remote, '.gitattributes') === USER_ATTRS, 'and the remote carries it unchanged (the app commits none of its own)');
  const bAttrs = read(B.gitDir, 'info/attributes');
  ok(bAttrs.startsWith('*.pdf -diff\n'), "a user's own info/attributes line is kept");
  for (const rule of sync.__testing.LINE_RECORD_MERGE_RULES) ok(bAttrs.includes(`${rule}\n`), `info/attributes carries: ${rule}`);
  ok(!/index\.md|entities|concepts|summaries/.test(sync.__testing.LINE_RECORD_MERGE_RULES.join('\n')),
    'no rule names a wiki page or index.md');
  ok(isAncestor(remote, headBefore, sh(`git --git-dir="${remote}" rev-parse main`).trim()),
    'no history rewritten: the earlier remote head is an ancestor of the new one');

  section('3. The managed block is idempotent');
  {
    await sync.__testing.ensureLineRecordMerge(B.gitDir);
    await sync.__testing.ensureLineRecordMerge(B.gitDir);
    const again = read(B.gitDir, 'info/attributes');
    ok(again === bAttrs, 'writing it again changes nothing');
    ok(again.split('merge=union').length - 1 === sync.__testing.LINE_RECORD_MERGE_RULES.length, 'one copy of each rule');
  }

  section('4. Both computers create the same file (no common base) — both lines still kept');
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

  section('5. A merge connect (setup mode "merge") unions too');
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
    ok(t.includes('c-only.md') && t.includes('d-only.md'), 'a first connect by merge keeps both computers\' records');
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
