#!/usr/bin/env node
/**
 * writeFileAtomic temp-name length. The temp file used to be named
 * `.tmp-<target name>-<pid>-<n>`, so a wiki page with a 244-character name
 * overflowed the 255-byte filename limit (ENAMETOOLONG) and blocked a merge.
 * The temp name is now fixed-length: `.tmp-<pid>-<counter>-<8 hex>`.
 *
 * Offline. Everything runs in a throwaway directory; the domains dir and the
 * user-data dir are overridden so no real data or credential file is touched.
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-atomic-long-'));
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'userdata');
mkdirSync(process.env.CURATOR_TEST_USER_DATA_DIR, { recursive: true });
const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setUserDataDirOverride(process.env.CURATOR_TEST_USER_DATA_DIR);
__setDomainsDirOverride(path.join(TMP, 'domains'));
mkdirSync(path.join(TMP, 'domains'), { recursive: true });
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

const { writeFileAtomic, writeFileAtomicSync, __testing } = await import('../src/brain/atomic-write.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.error('FAIL: ' + m); } }
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const leftovers = (d) => readdirSync(d).filter((n) => n.startsWith('.tmp-'));
function fresh(name) { const d = path.join(TMP, name); mkdirSync(d, { recursive: true }); return d; }

// Names: 244 ASCII chars, 255 ASCII bytes, and multi-byte names at the limit.
const ascii244 = 'a'.repeat(241) + '.md';                       // 244 bytes
const ascii255 = 'b'.repeat(252) + '.md';                       // 255 bytes
const zcaron = 'ž'.repeat(126) + '.md';                         // 2 bytes each -> 255 bytes
const cjk = '日'.repeat(84) + '.md';                            // 3 bytes each -> 255 bytes
ok(bytes(ascii244) === 244 && bytes(ascii255) === 255, 'fixture sizes (ascii)');
ok(bytes(zcaron) === 255 && bytes(cjk) === 255, 'fixture sizes (multibyte)');

// 1. Temp-name shape: same dir, fixed length, independent of the target name.
{
  const d = fresh('shape');
  const short = path.basename(__testing.nextTmpName(path.join(d, 'a.md')));
  const longPath = __testing.nextTmpName(path.join(d, ascii255));
  const long = path.basename(longPath);
  ok(path.dirname(longPath) === d, 'temp is in the target directory');
  ok(/^\.tmp-\d+-\d+-[0-9a-f]{8}$/.test(long), 'temp name shape .tmp-<pid>-<n>-<hex>: ' + long);
  ok(bytes(long) <= 64 && Math.abs(bytes(long) - bytes(short)) < 12, 'temp name length does not grow with the target name');
  const names = new Set(Array.from({ length: 500 }, () => __testing.nextTmpName(path.join(d, 'x.md'))));
  ok(names.size === 500, 'consecutive temp names are unique');
}

// 2. Long targets write successfully, async and sync, and replace on rewrite.
for (const [label, name] of [['244', ascii244], ['255', ascii255], ['2byte', zcaron], ['3byte', cjk]]) {
  const d = fresh('long-' + label);
  const t = path.join(d, name);
  try {
    await writeFileAtomic(t, 'one');
    await writeFileAtomic(t, 'two');
    ok(readFileSync(t, 'utf8') === 'two', `async write ${label}`);
  } catch (e) { ok(false, `async write ${label}: ${e.code || e.message}`); }
  try {
    writeFileAtomicSync(t, 'three');
    ok(readFileSync(t, 'utf8') === 'three', `sync write ${label}`);
  } catch (e) { ok(false, `sync write ${label}: ${e.code || e.message}`); }
  ok(leftovers(d).length === 0, `no temp left after ${label}`);
}

// 3. Concurrent writers never collide, in-process and across processes.
{
  const d = fresh('concurrent');
  const t = path.join(d, ascii255);
  const results = await Promise.allSettled(Array.from({ length: 64 }, (_, i) => writeFileAtomic(t, `payload-${i}`)));
  ok(results.every((r) => r.status === 'fulfilled'), 'in-process concurrent writes to one target all succeed');
  ok(/^payload-\d+$/.test(readFileSync(t, 'utf8')), 'target holds exactly one whole payload');
  const many = await Promise.allSettled(Array.from({ length: 64 }, (_, i) =>
    writeFileAtomic(path.join(d, `${String(i).padStart(3, '0')}-` + 'c'.repeat(240) + '.md'), 'x'.repeat(2000 + i))));
  ok(many.every((r) => r.status === 'fulfilled'), 'concurrent writes to distinct long targets succeed');
  ok(leftovers(d).length === 0, 'no temp left after the in-process burst');

  const child = path.join(TMP, 'child.mjs');
  writeFileSync(child, `
    import { writeFileAtomic } from ${JSON.stringify(path.join(__dirname, '..', 'src/brain/atomic-write.js'))};
    const [t, tag] = process.argv.slice(2);
    let bad = 0;
    await Promise.all(Array.from({ length: 40 }, (_, i) => writeFileAtomic(t, tag + '-' + i).catch(() => { bad++; })));
    process.exit(bad ? 1 : 0);
  `);
  const codes = await Promise.all(['p', 'q', 'r', 's'].map((tag) => new Promise((res) => {
    const c = spawn(process.execPath, [child, t, tag], { stdio: 'ignore' });
    c.on('exit', res);
  })));
  ok(codes.every((c) => c === 0), 'cross-process concurrent writes all succeed: ' + codes.join(','));
  ok(/^[pqrs]-\d+$/.test(readFileSync(t, 'utf8')), 'cross-process: target holds one whole payload');
  ok(leftovers(d).length === 0, 'no temp left after the cross-process burst');
}

// 4. A failed write leaves no temp and leaves the target intact. Renaming a
//    file over a non-empty directory fails AFTER the temp is written.
{
  const d = fresh('failure');
  const t = path.join(d, ascii244);
  mkdirSync(t);
  writeFileSync(path.join(t, 'keep.txt'), 'keep');
  let threw = false;
  try { await writeFileAtomic(t, 'new'); } catch { threw = true; }
  ok(threw, 'async write onto a non-empty directory fails');
  ok(leftovers(d).length === 0, 'async failure leaves no temp');
  ok(statSync(t).isDirectory() && readFileSync(path.join(t, 'keep.txt'), 'utf8') === 'keep', 'async failure leaves the target intact');
  threw = false;
  try { writeFileAtomicSync(t, 'new'); } catch { threw = true; }
  ok(threw, 'sync write onto a non-empty directory fails');
  ok(leftovers(d).length === 0, 'sync failure leaves no temp');
  ok(statSync(t).isDirectory() && readFileSync(path.join(t, 'keep.txt'), 'utf8') === 'keep', 'sync failure leaves the target intact');
}

// 5. Credential mode 0600 survives (umask 0, so a loose default would show).
if (process.platform !== 'win32') {
  const old = process.umask(0);
  try {
    const d = fresh('mode');
    const t = path.join(d, '.curator-config.json');
    await writeFileAtomic(t, '{}', { encoding: 'utf8', mode: 0o600 });
    ok((statSync(t).mode & 0o777) === 0o600, 'async mode 0600');
    const t2 = path.join(d, ascii255);
    writeFileAtomicSync(t2, '{}', { mode: 0o600 });
    ok((statSync(t2).mode & 0o777) === 0o600, 'sync mode 0600 on a 255-byte name');
    await writeFileAtomic(path.join(d, 'plain.md'), 'x');
    ok((statSync(path.join(d, 'plain.md')).mode & 0o777) === 0o666, 'no mode given: default permissions, not tightened');
    ok(leftovers(d).length === 0, 'no temp left in the credential directory');
  } finally { process.umask(old); }
}

console.log(`atomic-write long names: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
