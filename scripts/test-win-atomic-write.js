#!/usr/bin/env node
/**
 * writeFileAtomic on Windows (v4.1.2, audit W5). An antivirus, the search
 * indexer, OneDrive or an editor can hold a file open for a moment; the
 * rename over it then fails with EPERM / EACCES / EBUSY. On win32 ONLY the
 * rename is retried, bounded (7 attempts, ~2.75 s). On macOS and Linux the
 * behaviour is unchanged: one rename, its error thrown at once.
 *
 * Windows is SIMULATED through atomic-write's test seam (platform + rename
 * function). The real NTFS lock behaviour is something only a real PC shows.
 *
 * Offline. Everything runs in a throwaway directory.
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync as realRenameSync } from 'fs';
import { rename as realRename } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-win-atomic-'));
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'userdata');
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(TMP, 'domains');
process.env.CURATOR_NO_OPEN = '1';
process.env.HOME = path.join(TMP, 'home');
mkdirSync(process.env.CURATOR_TEST_USER_DATA_DIR, { recursive: true });
mkdirSync(process.env.CURATOR_TEST_DOMAINS_DIR, { recursive: true });
mkdirSync(process.env.HOME, { recursive: true });
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

const aw = await import('../src/brain/atomic-write.js');
const { writeFileAtomic, writeFileAtomicSync, __testing, WIN_RENAME_BACKOFF_MS, WIN_RENAME_LOCK_CODES } = aw;

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.error('FAIL: ' + m); } }
let n = 0;
function fresh() { const d = path.join(TMP, 'case-' + (++n)); mkdirSync(d, { recursive: true }); return d; }
const leftovers = (d) => readdirSync(d).filter((x) => x.startsWith('.tmp-'));
const errOf = (code) => Object.assign(new Error(code + ': simulated lock'), { code });

/** A rename that fails `failures` times with `code`, then does the real rename. */
function flaky(code, failures) {
  const calls = { n: 0 };
  const fn = async (a, b) => { calls.n++; if (calls.n <= failures) throw errOf(code); return realRename(a, b); };
  const fnSync = (a, b) => { calls.n++; if (calls.n <= failures) throw errOf(code); return realRenameSync(a, b); };
  return { calls, fn, fnSync };
}
function seams(platform, f, waits) {
  __testing.setSeams({
    platform,
    renameFn: f.fn,
    renameSyncFn: f.fnSync,
    sleep: async (ms) => { waits.push(ms); },
    sleepSync: (ms) => { waits.push(ms); },
  });
}

ok(WIN_RENAME_LOCK_CODES.join() === 'EPERM,EACCES,EBUSY', 'lock codes are EPERM, EACCES, EBUSY');
ok(WIN_RENAME_BACKOFF_MS.reduce((a, b) => a + b, 0) === 2750 && WIN_RENAME_BACKOFF_MS.length === 6, 'backoff is 6 waits, 2.75 s in all');

for (const mode of ['async', 'sync']) {
  const write = mode === 'async'
    ? (t, c, o) => writeFileAtomic(t, c, o)
    : async (t, c, o) => writeFileAtomicSync(t, c, o);

  // 1. win32: a lock that clears succeeds, the new bytes land, no temp left.
  for (const code of WIN_RENAME_LOCK_CODES) {
    const d = fresh(); const t = path.join(d, 'page.md');
    writeFileSync(t, 'old');
    const f = flaky(code, 3); const waits = [];
    seams('win32', f, waits);
    let threw = null;
    try { await write(t, 'new'); } catch (e) { threw = e; }
    ok(!threw, `${mode} win32 ${code}: a lock that clears after 3 tries does not fail (${threw && threw.message})`);
    ok(readFileSync(t, 'utf8') === 'new', `${mode} win32 ${code}: the new content is on disk`);
    ok(f.calls.n === 4, `${mode} win32 ${code}: 4 rename attempts (got ${f.calls.n})`);
    ok(waits.join() === '50,100,200', `${mode} win32 ${code}: waited 50,100,200 (got ${waits.join()})`);
    ok(leftovers(d).length === 0, `${mode} win32 ${code}: no temp file left`);
  }

  // 2. win32: a lock that never clears gives up after 7 attempts, the old
  //    file intact, the temp removed, the lock's own error thrown.
  {
    const d = fresh(); const t = path.join(d, 'page.md');
    writeFileSync(t, 'old');
    const f = flaky('EBUSY', 1000); const waits = [];
    seams('win32', f, waits);
    let threw = null;
    try { await write(t, 'new'); } catch (e) { threw = e; }
    ok(threw && threw.code === 'EBUSY', `${mode} win32 permanent lock: throws EBUSY`);
    ok(f.calls.n === 7, `${mode} win32 permanent lock: exactly 7 attempts, bounded (got ${f.calls.n})`);
    ok(waits.join() === WIN_RENAME_BACKOFF_MS.join(), `${mode} win32 permanent lock: the full backoff and no more (got ${waits.join()})`);
    ok(readFileSync(t, 'utf8') === 'old', `${mode} win32 permanent lock: the old file is intact`);
    ok(leftovers(d).length === 0, `${mode} win32 permanent lock: the temp file is removed`);
  }

  // 3. win32: a non-lock error is not retried.
  {
    const d = fresh(); const t = path.join(d, 'page.md');
    writeFileSync(t, 'old');
    const f = flaky('ENOSPC', 1000); const waits = [];
    seams('win32', f, waits);
    let threw = null;
    try { await write(t, 'new'); } catch (e) { threw = e; }
    ok(threw && threw.code === 'ENOSPC' && f.calls.n === 1 && waits.length === 0, `${mode} win32 ENOSPC: one attempt, no wait, thrown (calls ${f.calls.n})`);
    ok(readFileSync(t, 'utf8') === 'old' && leftovers(d).length === 0, `${mode} win32 ENOSPC: old intact, no temp`);
  }

  // 4. darwin and linux: UNCHANGED — one rename, the lock error thrown at once.
  for (const platform of ['darwin', 'linux']) {
    for (const code of WIN_RENAME_LOCK_CODES) {
      const d = fresh(); const t = path.join(d, 'page.md');
      writeFileSync(t, 'old');
      const f = flaky(code, 1); const waits = [];
      seams(platform, f, waits);
      let threw = null;
      try { await write(t, 'new'); } catch (e) { threw = e; }
      ok(threw && threw.code === code, `${mode} ${platform} ${code}: the error is thrown (not retried)`);
      ok(f.calls.n === 1 && waits.length === 0, `${mode} ${platform} ${code}: exactly one rename, no wait (calls ${f.calls.n}, waits ${waits.length})`);
      ok(readFileSync(t, 'utf8') === 'old' && leftovers(d).length === 0, `${mode} ${platform} ${code}: old intact, no temp`);
    }
    // a clean write is a plain write: one rename
    const d = fresh(); const t = path.join(d, 'page.md');
    const f = flaky('EPERM', 0); const waits = [];
    seams(platform, f, waits);
    await write(t, 'hello', { mode: 0o600 });
    ok(readFileSync(t, 'utf8') === 'hello' && f.calls.n === 1 && waits.length === 0, `${mode} ${platform}: a clean write is one rename`);
  }
}

// 5. Reset: the real platform and real renames, and a real write works.
__testing.setSeams();
{
  const d = fresh(); const t = path.join(d, 'real.md');
  await writeFileAtomic(t, 'a'); writeFileAtomicSync(t, 'b');
  ok(readFileSync(t, 'utf8') === 'b' && leftovers(d).length === 0, 'after reset, real async + sync writes work');
}

console.log(`win atomic-write: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
