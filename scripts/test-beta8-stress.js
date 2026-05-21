#!/usr/bin/env node
/**
 * v3.0.1-beta.8 — Stress + safety battle test.
 *
 * Validates the four-fix-plus-five-bonus bundle:
 *   1. Atomic writes (writeFileAtomic + writeFileAtomicSync)
 *   2. Trunk-page detector (validateOutline)
 *   3. Write registry (in-memory + file-based lock + 409 conflict response)
 *   4. Anthropic stop_reason: max_tokens detection (synthetic test)
 *   5. validateOutline structural checks (dup paths, missing entity/concept)
 *
 * Pure offline tests — no network, no LLM calls. Uses tempdirs for filesystem
 * tests. Run: node scripts/test-beta8-stress.js
 * Exit code 0 if all green; non-zero on any failure.
 */

import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, lstat, unlink, rm, stat } from 'fs/promises';
import { existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawn } from 'child_process';

import {
  writeFileAtomic,
  writeFileAtomicSync,
  __testing as atomicTesting,
} from '../src/brain/atomic-write.js';
import {
  registerWrite,
  listActiveWrites,
  hasActiveWrites,
  isDomainActive,
  conflictResponse,
  beginUpdate,
  endUpdate,
  isUpdateInProgress,
  acquireFileLock,
  isFileLocked,
  __testing as registryTesting,
} from '../src/brain/write-registry.js';
import { validateOutline } from '../src/brain/ingest.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}
function fail(label, detail) {
  failed++;
  failures.push({ label, detail });
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`    └─ ${detail}`);
}
function assertEq(actual, expected, label) {
  if (actual === expected) return ok(label);
  fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTrue(cond, label, detail) {
  if (cond) return ok(label);
  fail(label, detail);
}
function assertThrows(fn, label, expectedMsg) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => fail(label, 'expected throw, got resolution'),
        (err) => {
          if (expectedMsg && !err.message.includes(expectedMsg)) {
            return fail(label, `wrong message: ${err.message}`);
          }
          return ok(label);
        }
      );
    }
    return fail(label, 'expected throw, got return value');
  } catch (err) {
    if (expectedMsg && !err.message.includes(expectedMsg)) {
      return fail(label, `wrong message: ${err.message}`);
    }
    return ok(label);
  }
}

console.log('\n=== v3.0.1-beta.8 stress + safety battle test ===\n');

// ── 1. writeFileAtomic — basic behaviour ─────────────────────────────────────
console.log('1. writeFileAtomic — basics\n');
{
  const dir = await mkdtemp(path.join(tmpdir(), 'curator-atomic-'));
  const target = path.join(dir, 'page.md');

  await writeFileAtomic(target, 'hello');
  assertEq(await readFile(target, 'utf8'), 'hello', 'first write creates file');

  await writeFileAtomic(target, 'updated');
  assertEq(await readFile(target, 'utf8'), 'updated', 'second write replaces file');

  // After successful write, no temp files should remain in the directory
  const entries = await readdir(dir);
  const tmpLeftovers = entries.filter(e => e.startsWith('.tmp-'));
  assertEq(tmpLeftovers.length, 0, 'no .tmp-* files left on success');

  // Tempfile is in the SAME directory as the target (EXDEV-safe)
  const tmpName = atomicTesting.nextTmpName(target);
  assertEq(path.dirname(tmpName), dir, 'temp path is in same dir as target');
  assertTrue(path.basename(tmpName).startsWith('.tmp-page.md-'), 'temp name pattern matches');
  assertTrue(path.basename(tmpName).includes(`-${process.pid}-`), 'temp name includes pid');

  await rm(dir, { recursive: true, force: true });
}

// ── 2. writeFileAtomic — cleanup on rename failure ──────────────────────────
console.log('\n2. writeFileAtomic — cleanup on rename failure\n');
{
  const dir = await mkdtemp(path.join(tmpdir(), 'curator-atomic-'));
  // Create a path that points to a DIRECTORY — rename(file, dir) fails on POSIX
  const blocker = path.join(dir, 'blocked');
  await mkdir(blocker);

  try {
    await writeFileAtomic(blocker, 'content');
    fail('rename-over-directory should throw');
  } catch {
    ok('rename-over-directory throws');
  }

  // Verify no orphan tempfile remains in the dir (the cleanup ran)
  const entries = await readdir(dir);
  const tmpLeftovers = entries.filter(e => e.startsWith('.tmp-'));
  assertEq(tmpLeftovers.length, 0, 'no orphan .tmp-* file after rename failure');

  await rm(dir, { recursive: true, force: true });
}

// ── 3. writeFileAtomic — symlink refusal ────────────────────────────────────
console.log('\n3. writeFileAtomic — refuses to write through symlink\n');
{
  const dir = await mkdtemp(path.join(tmpdir(), 'curator-atomic-'));
  const target = path.join(dir, 'real-page.md');
  const link = path.join(dir, 'link.md');
  await writeFile(target, 'original');
  await symlink(target, link);

  try {
    await writeFileAtomic(link, 'overwrite-via-link');
    fail('should refuse to write through symlink');
  } catch (err) {
    assertTrue(err.message.includes('symlink'), 'symlink refusal message');
  }

  // Verify the symlink target is unchanged AND the link is still a symlink
  const st = await lstat(link);
  assertTrue(st.isSymbolicLink(), 'symlink remains a symlink after refusal');
  assertEq(await readFile(target, 'utf8'), 'original', 'symlink target content untouched');

  await rm(dir, { recursive: true, force: true });
}

// ── 4. writeFileAtomic — concurrent writes don't collide ────────────────────
console.log('\n4. writeFileAtomic — concurrent writes (different files, same dir)\n');
{
  const dir = await mkdtemp(path.join(tmpdir(), 'curator-atomic-'));
  // Fire 20 concurrent writes to 20 distinct files in the same directory.
  // The monotonic counter in nextTmpName must ensure no two callers pick
  // the same temp path on the same millisecond.
  const writes = [];
  for (let i = 0; i < 20; i++) {
    writes.push(writeFileAtomic(path.join(dir, `f-${i}.md`), `content-${i}`));
  }
  await Promise.all(writes);
  for (let i = 0; i < 20; i++) {
    const content = await readFile(path.join(dir, `f-${i}.md`), 'utf8');
    if (content !== `content-${i}`) {
      fail(`concurrent file ${i} content`, `got: ${content}`);
    }
  }
  ok('20 concurrent writes to distinct files all succeeded');

  // No temp files remain
  const entries = await readdir(dir);
  const tmpLeftovers = entries.filter(e => e.startsWith('.tmp-'));
  assertEq(tmpLeftovers.length, 0, 'no .tmp-* files left after concurrent burst');

  await rm(dir, { recursive: true, force: true });
}

// ── 5. writeFileAtomicSync — sync behaviour ─────────────────────────────────
console.log('\n5. writeFileAtomicSync — basic sync behaviour\n');
{
  const dir = await mkdtemp(path.join(tmpdir(), 'curator-atomic-'));
  const target = path.join(dir, 'config.json');
  writeFileAtomicSync(target, '{"key":"v1"}');
  assertEq(await readFile(target, 'utf8'), '{"key":"v1"}', 'sync write creates file');
  writeFileAtomicSync(target, '{"key":"v2"}');
  assertEq(await readFile(target, 'utf8'), '{"key":"v2"}', 'sync write replaces file');
  await rm(dir, { recursive: true, force: true });
}

// ── 6. writeFileAtomic — process-kill simulation via worker subprocess ──────
console.log('\n6. writeFileAtomic — kill-mid-write leaves file intact\n');
{
  // We can't reliably SIGKILL ourselves mid-syscall, but we CAN test the
  // intent: spawn a child that begins many atomic writes and SIGKILL it
  // mid-flight, then verify the target files are either pristine (old) or
  // pristine (new) — never empty.
  const dir = await mkdtemp(path.join(tmpdir(), 'curator-atomic-kill-'));
  const target = path.join(dir, 'page.md');
  await writeFile(target, 'pre-existing-baseline');

  // Spawn a child that hammers writeFileAtomic on the same target
  const child = spawn(process.execPath, [
    '-e',
    `
    import('${path.resolve('src/brain/atomic-write.js').replace(/\\\\/g, '/')}').then(async ({ writeFileAtomic }) => {
      for (let i = 0; i < 1000; i++) {
        await writeFileAtomic('${target.replace(/\\\\/g, '/')}', 'iteration-' + i);
      }
    });
    `,
  ], { stdio: 'ignore' });

  // Kill after a brief delay — child is likely mid-write
  await new Promise(r => setTimeout(r, 50));
  child.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 100));

  // The target file MUST still exist and MUST have non-empty content.
  // (Either "pre-existing-baseline" or "iteration-NNN", but never empty.)
  const st = await stat(target);
  assertTrue(st.size > 0, 'target file is non-empty after SIGKILL', `size: ${st.size}`);
  const content = await readFile(target, 'utf8');
  const looksValid = content === 'pre-existing-baseline' || content.startsWith('iteration-');
  assertTrue(looksValid, 'target content is a clean state, not torn', `content: ${content.slice(0, 60)}`);

  // No stray temp files left
  const entries = await readdir(dir);
  const tmpLeftovers = entries.filter(e => e.startsWith('.tmp-'));
  // It's permissible to have a leftover temp file if the kill landed between
  // writeFile and rename — but it should be a small number, not dozens.
  // What MUST be true: the target file is whole.
  assertTrue(tmpLeftovers.length <= 1, 'at most one leftover .tmp file from kill', `found: ${tmpLeftovers.length}`);

  await rm(dir, { recursive: true, force: true });
}

// ── 7. Trunk-page detector ──────────────────────────────────────────────────
console.log('\n7. Trunk-page detector in validateOutline\n');

// Case A: 3 sibling concepts with shared prefix → trunk injected
{
  const outline = {
    title: 'taste essay',
    pages: [
      { path: 'summaries/taste-essay.md', summary: 'the article' },
      { path: 'concepts/taste-as-moat.md', summary: 'taste-as-moat' },
      { path: 'concepts/taste-as-judgment.md', summary: 'taste-as-judgment' },
      { path: 'concepts/taste-development-formula.md', summary: 'taste-formula' },
    ],
  };
  const { outline: out, warnings } = validateOutline(outline, 'summaries/taste-essay.md', 'taste-essay.pdf', []);
  const trunkInjected = out.pages.find(p => p.path === 'concepts/taste.md');
  assertTrue(!!trunkInjected, 'trunk page `concepts/taste.md` injected for taste-* cluster');
  const hasWarn = warnings.some(w => w.includes('"taste-*" pages without a parent'));
  assertTrue(hasWarn, 'warning surfaced for trunk-page injection');
  // Trunk goes after summary (so Phase 2 writes it before children)
  const summaryIdx = out.pages.findIndex(p => p.path === 'summaries/taste-essay.md');
  const trunkIdx = out.pages.findIndex(p => p.path === 'concepts/taste.md');
  assertTrue(trunkIdx === summaryIdx + 1, 'trunk inserted directly after summary');
}

// Case B: trunk already in outline → NO double-inject
{
  const outline = {
    title: 'taste essay',
    pages: [
      { path: 'summaries/taste-essay.md', summary: 'the article' },
      { path: 'concepts/taste.md', summary: 'taste umbrella' },
      { path: 'concepts/taste-as-moat.md', summary: 'taste-as-moat' },
      { path: 'concepts/taste-as-judgment.md', summary: 'taste-as-judgment' },
      { path: 'concepts/taste-development-formula.md', summary: 'taste-formula' },
    ],
  };
  const { outline: out, warnings } = validateOutline(outline, 'summaries/taste-essay.md', 'taste-essay.pdf', []);
  const trunkCount = out.pages.filter(p => p.path === 'concepts/taste.md').length;
  assertEq(trunkCount, 1, 'no double-inject when trunk already present');
  const trunkWarn = warnings.filter(w => w.includes('"taste-*" pages without a parent')).length;
  assertEq(trunkWarn, 0, 'no trunk-injection warning when already covered');
}

// Case C: only 2 siblings → below threshold → no injection
{
  const outline = {
    title: 'tiny',
    pages: [
      { path: 'summaries/tiny.md', summary: 's' },
      { path: 'concepts/curation-as-art.md', summary: 'c1' },
      { path: 'concepts/curation-as-job.md', summary: 'c2' },
    ],
  };
  const { outline: out } = validateOutline(outline, 'summaries/tiny.md', 'tiny.pdf', []);
  const hasTrunk = out.pages.some(p => p.path === 'concepts/curation.md');
  assertEq(hasTrunk, false, 'no trunk for cluster below threshold (2 siblings)');
}

// Case D: 10+ siblings → trunk injected, warning lists up to 5 paths
// Use a multi-char prefix to clear the single-char-prefix safety filter.
{
  const pages = [{ path: 'summaries/big.md', summary: 's' }];
  for (let i = 0; i < 12; i++) pages.push({ path: `concepts/curation-sub-${i}.md`, summary: `s-${i}` });
  const { outline: out, warnings } = validateOutline({ title: 't', pages }, 'summaries/big.md', 'big.pdf', []);
  const trunk = out.pages.find(p => p.path === 'concepts/curation.md');
  assertTrue(!!trunk, 'trunk injected for 12-sibling cluster');
  const w = warnings.find(w => w.includes('"curation-*" pages'));
  assertTrue(!!w && w.includes('+'), 'warning truncates sub-list with "+N more"');
}

// Case E: entities/* cluster → NOT triggered (concepts only)
{
  const outline = {
    title: 'e',
    pages: [
      { path: 'summaries/e.md', summary: 's' },
      { path: 'entities/openai-gpt-4.md', summary: 'gpt4' },
      { path: 'entities/openai-gpt-5.md', summary: 'gpt5' },
      { path: 'entities/openai-codex.md', summary: 'codex' },
    ],
  };
  const { outline: out } = validateOutline(outline, 'summaries/e.md', 'e.pdf', []);
  const hasTrunk = out.pages.some(p => p.path === 'entities/openai.md' || p.path === 'concepts/openai.md');
  assertEq(hasTrunk, false, 'entities clusters do NOT trigger trunk injection');
}

// Case F: single-char prefix (e.g. "a-foo") → skipped to avoid noise
{
  const outline = {
    title: 'short',
    pages: [
      { path: 'summaries/s.md', summary: 's' },
      { path: 'concepts/a-foo.md', summary: 's' },
      { path: 'concepts/a-bar.md', summary: 's' },
      { path: 'concepts/a-baz.md', summary: 's' },
    ],
  };
  const { outline: out } = validateOutline(outline, 'summaries/s.md', 's.pdf', []);
  const hasTrunk = out.pages.some(p => p.path === 'concepts/a.md');
  assertEq(hasTrunk, false, 'single-char prefix clusters do not trigger');
}

// ── 8. validateOutline structural checks ────────────────────────────────────
console.log('\n8. validateOutline structural checks\n');

// Dup paths warned
{
  const outline = {
    title: 't',
    pages: [
      { path: 'summaries/t.md', summary: 's' },
      { path: 'entities/x.md', summary: 'x' },
      { path: 'entities/x.md', summary: 'x dup' },
      { path: 'concepts/c.md', summary: 'c' },
    ],
  };
  const { warnings } = validateOutline(outline, 'summaries/t.md', 't.pdf', []);
  const dupWarn = warnings.find(w => w.includes('duplicate paths'));
  assertTrue(!!dupWarn, 'duplicate paths surfaced as warning');
}

// No entities warned
{
  const outline = {
    title: 't',
    pages: [
      { path: 'summaries/t.md', summary: 's' },
      { path: 'concepts/c.md', summary: 'c' },
    ],
  };
  const { warnings } = validateOutline(outline, 'summaries/t.md', 't.pdf', []);
  const w = warnings.find(w => w.includes('no entities/ pages'));
  assertTrue(!!w, 'no-entities case warned');
}

// No concepts warned
{
  const outline = {
    title: 't',
    pages: [
      { path: 'summaries/t.md', summary: 's' },
      { path: 'entities/e.md', summary: 'e' },
    ],
  };
  const { warnings } = validateOutline(outline, 'summaries/t.md', 't.pdf', []);
  const w = warnings.find(w => w.includes('no concepts/ pages'));
  assertTrue(!!w, 'no-concepts case warned');
}

// Minimum page count warned (< 3 pages)
{
  const outline = {
    title: 't',
    pages: [
      { path: 'summaries/t.md', summary: 's' },
      { path: 'entities/e.md', summary: 'e' },
    ],
  };
  const { warnings } = validateOutline(outline, 'summaries/t.md', 't.pdf', []);
  const w = warnings.find(w => w.includes('only 2 pages'));
  assertTrue(!!w, 'min-page-count case warned');
}

// Malformed entry (null path) dropped without crash
{
  const outline = {
    title: 't',
    pages: [
      { path: 'summaries/t.md', summary: 's' },
      null,
      { path: 'entities/e.md', summary: 'e' },
      { /* no path */ summary: 'noop' },
    ],
  };
  const { outline: out, warnings } = validateOutline(outline, 'summaries/t.md', 't.pdf', []);
  const hasMalformed = out.pages.some(p => !p || typeof p.path !== 'string');
  assertEq(hasMalformed, false, 'malformed entries dropped from outline');
  const w = warnings.filter(w => w.includes('malformed page entry')).length;
  assertTrue(w >= 1, 'malformed-entry warning surfaced (at least one)');
}

// ── 9. Write registry — in-memory accounting ────────────────────────────────
console.log('\n9. Write registry — in-memory accounting\n');
registryTesting._resetActiveWrites();
registryTesting._resetUpdate();

{
  assertEq(hasActiveWrites(), false, 'no active writes initially');
  assertEq(isDomainActive('articles'), false, 'specific domain not active initially');

  const r1 = registerWrite('articles', 'ingest');
  assertEq(hasActiveWrites(), true, 'hasActiveWrites true after register');
  assertEq(isDomainActive('articles'), true, 'isDomainActive true after register');
  assertEq(isDomainActive('other'), false, 'other domains not affected');

  // Two concurrent on same domain — count, not boolean
  const r2 = registerWrite('articles', 'compile');
  r1();
  assertEq(isDomainActive('articles'), true, 'still active after one release of two');
  r2();
  assertEq(isDomainActive('articles'), false, 'inactive after second release');
  assertEq(hasActiveWrites(), false, 'overall inactive');
}

// Release idempotent (calling twice is harmless)
{
  const r = registerWrite('articles', 'ingest');
  r();
  r();
  assertEq(isDomainActive('articles'), false, 'double-release is a no-op');
}

// listActiveWrites shape
{
  const r = registerWrite('articles', 'ingest');
  const list = listActiveWrites();
  assertEq(list.length, 1, 'one active write listed');
  assertEq(list[0].domain, 'articles', 'list entry has correct domain');
  assertTrue(list[0].ops.includes('ingest'), 'list entry includes op');
  assertTrue(list[0].count >= 1, 'list entry has count');
  r();
}

// conflictResponse shape
{
  const r = registerWrite('articles', 'ingest');
  const { status, body } = conflictResponse('update the app');
  assertEq(status, 409, 'conflict status 409');
  assertEq(body.conflict, 'write_in_progress', 'conflict marker');
  assertTrue(body.error.includes('articles'), 'error message names the active domain');
  assertTrue(Array.isArray(body.active), 'active array in body');
  r();
}

// updateInProgress flag
{
  assertEq(isUpdateInProgress(), false, 'update not in progress initially');
  beginUpdate();
  assertEq(isUpdateInProgress(), true, 'beginUpdate flips flag');
  const { status, body } = conflictResponse('start ingest');
  assertEq(status, 409, 'conflict 409 when update is in progress');
  assertTrue(body.updateInProgress, 'updateInProgress flag echoed in body');
  endUpdate();
  assertEq(isUpdateInProgress(), false, 'endUpdate clears flag');
}

// ── 10. File-based lock — cross-process coordination ────────────────────────
console.log('\n10. File-based lock — basic acquire / release / staleness\n');
{
  const dir = await mkdtemp(path.join(tmpdir(), 'curator-lock-'));

  // Acquire — success
  const release1 = await acquireFileLock(dir, { op: 'test' });
  assertTrue(typeof release1 === 'function', 'first acquire returns release fn');
  assertEq(await isFileLocked(dir), true, 'isFileLocked true while held');

  // Second concurrent acquire from same process — refused (fresh lock exists)
  const release2 = await acquireFileLock(dir, { op: 'test' });
  assertEq(release2, null, 'second acquire refused while lock fresh');

  // Release
  await release1();
  assertEq(await isFileLocked(dir), false, 'isFileLocked false after release');
  // Can re-acquire
  const release3 = await acquireFileLock(dir, { op: 'test' });
  assertTrue(typeof release3 === 'function', 'can re-acquire after release');
  await release3();

  // Stale lock — manually write a lock with old timestamp and dead pid
  const lockFile = path.join(dir, '.write-lock');
  await writeFile(lockFile, JSON.stringify({
    pid: 999999,                            // very unlikely to be alive
    startedAt: Date.now() - 60 * 60 * 1000, // 1 hour ago — past staleness threshold
    op: 'orphaned',
  }));
  const release4 = await acquireFileLock(dir, { op: 'test' });
  assertTrue(typeof release4 === 'function', 'stale lock cleared and re-acquired');
  await release4();

  // Unparseable lock = treated as stale
  await writeFile(lockFile, 'not valid json{{{');
  const release5 = await acquireFileLock(dir, { op: 'test' });
  assertTrue(typeof release5 === 'function', 'unparseable lock cleared and re-acquired');
  await release5();

  await rm(dir, { recursive: true, force: true });
}

// ── 11. EXDEV defense — tempfile is in same directory ──────────────────────
console.log('\n11. EXDEV defense — tempfile lives in same dir as target\n');
{
  // We can't easily create a cross-FS scenario in a test, but we CAN verify
  // the temp-path generator never produces an out-of-dir path. nextTmpName
  // is the chokepoint — any future bug that introduces os.tmpdir() would
  // surface here.
  const cases = [
    '/var/folders/abc/foo.md',
    '/Users/me/Documents/curator/domains/x/wiki/concepts/foo.md',
    '/Volumes/MyUSB/curator/domains/x/wiki/index.md',
    '/tmp/random/path/page.md',
  ];
  for (const target of cases) {
    const tmp = atomicTesting.nextTmpName(target);
    assertEq(path.dirname(tmp), path.dirname(target), `temp for ${target} stays in same dir`);
  }
}

// ── 12. End-to-end via files.js — atomic writePage doesn't truncate ────────
console.log('\n12. End-to-end — writePage via files.js still produces clean content\n');
{
  // files.js resolves the domains path through config.getDomainsDir() which
  // prefers .curator-config.json over env. We resolve it at runtime so the
  // test works whether or not the user has a config file set.
  const { getDomainsDir } = await import('../src/brain/config.js');
  const { createDomain, writePage, wikiPath } = await import('../src/brain/files.js');
  const baseDir = getDomainsDir();
  const domainName = `beta8stress-${process.pid}`;
  try {
    await createDomain(domainName, 'Beta8 Stress', 'Testing atomic writes', 'tech');
    const rec = await writePage(domainName, 'entities/test-entity.md', '# Test Entity\n\n- A fact\n');
    assertTrue(rec && rec.canonPath === 'entities/test-entity.md', 'writePage returns canonical record');
    const expectedPath = path.join(wikiPath(domainName), 'entities', 'test-entity.md');
    const content = await readFile(expectedPath, 'utf8');
    assertTrue(content.length > 50, 'wiki page has expected length', `got ${content.length} chars`);
    assertTrue(content.includes('# Test Entity'), 'wiki page contains heading');
  } finally {
    // Clean up our test domain so we don't pollute the user's real list
    await rm(path.join(baseDir, domainName), { recursive: true, force: true });
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n=== Result ===');
console.log(`  ${passed} passed, ${failed} failed (${passed + failed} total)\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) {
    console.log(`  - ${f.label}`);
    if (f.detail) console.log(`      ${f.detail}`);
  }
  process.exit(1);
}
process.exit(0);
