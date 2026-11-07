/**
 * Atomic file writes (v3.0.1-beta.8).
 *
 * Wraps `fs.writeFile` / `fs.writeFileSync` so that any process kill (or
 * concurrent overwrite, or full-disk error) during the write leaves either
 * the OLD file intact or the NEW file intact — never a partial / zero-byte
 * file. Implements the standard "write to tempfile + rename" pattern.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * Pre-v3.0.1-beta.8 the Curator used plain `await writeFile(path, content)`
 * everywhere. If the Node process was killed mid-write (e.g. user clicked
 * "Check for Updates" while an ingest was running — the update flow calls
 * `/api/restart` which spawns a new process and exits the old one), the
 * file currently being written ended up truncated to zero bytes. With 25-
 * page ingests, especially the full-file rewrite of `index.md` and
 * `log.md`, this manifested as "files disappeared" reports.
 *
 * ── Key invariants ───────────────────────────────────────────────────────
 *
 * 1. Tempfile lives in the SAME directory as the final target. POSIX
 *    `rename(2)` is only atomic within a single filesystem; crossing
 *    filesystems throws EXDEV. `getDomainsDir()` can be a USB drive or a
 *    network mount, so we must NOT use `os.tmpdir()` for the temp path.
 *
 * 2. Tempfile name is `.tmp-<pid>-<counter>-<random hex>`: unique across
 *    concurrent writers and processes in the same dir, and a FIXED length
 *    that never grows with the target's name (a 255-byte target works).
 *
 * 3. We refuse to rename over a path that already exists AS A SYMLINK
 *    (defense in depth — Shared Brain mirror domains live as read-only
 *    folders, not symlinks, but if a user manually symlinks a wiki page
 *    we don't want to silently replace the link with a regular file).
 *
 * 4. Cleanup: if the rename fails, the tempfile MUST be removed so we
 *    don't accumulate orphaned `.tmp-*` files. Best-effort `unlink`.
 *
 * 5. JSONL audit logs (sharedbrain-local-adapter.js line 304, MCP write
 *    log, etc.) MUST KEEP using `appendFile` — they are crash-safe at
 *    line granularity on local filesystems. Converting them to atomic
 *    rewrite would be a regression.
 */

import { writeFile, rename, unlink, lstat, chmod } from 'fs/promises';
import {
  writeFileSync,
  renameSync,
  unlinkSync,
  lstatSync,
  chmodSync,
  existsSync,
} from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * THE UNDO RECORDER'S SEAM (owner's decision, 2026-11-07). While a Wiki health
 * action runs, `src/brain/health-undo.js` puts a recorder in this store, and
 * every write below asks it first: it saves a copy of the file as it is now,
 * and only then may the write go ahead. A copy that cannot be saved THROWS, so
 * the write never happens. This is the one chokepoint because every page write
 * in the app is a `writeFileAtomic` (ingest, compile, every Health fix, the
 * index): an action cannot reach a page around it.
 *
 * Outside a Health action the store is empty and nothing changes: one
 * `getStore()` per write. The recorder decides itself which paths it covers
 * (that domain's wiki folder only), so a config or credential write made
 * during an action is never copied.
 */
export const writeRecorder = new AsyncLocalStorage();

/**
 * Normalise the third argument, which historically was an encoding string.
 * Now also accepts an options object `{ encoding, mode }` so credential files
 * (.curator-config.json, .sync-config.json, .sharedbrain-config.json) can be
 * written 0600 (v3.0.1-beta.20). Passing a bare string keeps the old behaviour.
 */
function normalizeOpts(opts) {
  if (typeof opts === 'string') return { encoding: opts, mode: undefined };
  if (opts && typeof opts === 'object') {
    return { encoding: opts.encoding || 'utf8', mode: opts.mode };
  }
  return { encoding: 'utf8', mode: undefined };
}

// Per-process monotonic counter to avoid temp-file collisions on the same
// millisecond in the same directory.
let _tmpCounter = 0;
function nextTmpName(targetPath) {
  _tmpCounter = (_tmpCounter + 1) & 0xffffffff;
  const dir = path.dirname(targetPath);
  // Shape: `.tmp-<pid>-<counter>-<8 hex>`. FIXED LENGTH: the name does NOT
  // include the target's name, because a page name near the 255-byte
  // filename limit (real wikis have 244-character names) plus a prefix and
  // suffix would overflow it (ENAMETOOLONG). The leading `.tmp-` is kept —
  // the desktop watcher and the leftover checks match on it. pid + counter
  // are unique within a process; the random nonce covers pid reuse and
  // separate processes/containers sharing a directory.
  const nonce = randomBytes(4).toString('hex');
  return path.join(dir, `.tmp-${process.pid}-${_tmpCounter}-${nonce}`);
}

/**
 * Refuse to write through a symlink at `targetPath`. Returns true if the
 * write should be aborted, false if it's safe to proceed.
 *
 * Existence check uses `lstat` so we examine the symlink itself, not the
 * file it points to. If `lstat` throws ENOENT the path doesn't exist
 * (perfectly fine — fresh write).
 */
async function isUnsafeSymlink(targetPath) {
  try {
    const st = await lstat(targetPath);
    return st.isSymbolicLink();
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    // Other errors (permission, etc.) — let the real write surface them.
    return false;
  }
}

function isUnsafeSymlinkSync(targetPath) {
  try {
    const st = lstatSync(targetPath);
    return st.isSymbolicLink();
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    return false;
  }
}

/**
 * Atomic async write — replacement for `fs.promises.writeFile`.
 *
 * @param {string} targetPath  Absolute path to the final file
 * @param {string|Buffer} content  Content to write
 * @param {string|{encoding?:string, mode?:number}} [opts]  Encoding string
 *        (legacy) or an options object. `mode` (e.g. 0o600) tightens the
 *        final file's permissions — used for credential files.
 * @returns {Promise<void>}
 */
export async function writeFileAtomic(targetPath, content, opts = 'utf8') {
  const { encoding, mode } = normalizeOpts(opts);
  if (await isUnsafeSymlink(targetPath)) {
    throw new Error(
      `Refusing to write through symlink: ${targetPath}. ` +
      `If you intentionally want to replace this file, remove the symlink first.`
    );
  }
  const recorder = writeRecorder.getStore();
  if (recorder) await recorder.beforeWrite(targetPath);
  const tmpPath = nextTmpName(targetPath);
  let written = false;
  try {
    // `writeFile` to a fresh temp path — no existing content to merge with.
    if (Buffer.isBuffer(content)) {
      await writeFile(tmpPath, content);
    } else {
      await writeFile(tmpPath, content, encoding);
    }
    written = true;
    // Tighten permissions BEFORE the file becomes visible at its final path.
    // Done as an explicit chmod (not the writeFile mode option) so it isn't
    // subject to the process umask — credential files MUST end up 0600.
    if (mode !== undefined) await chmod(tmpPath, mode);
    // POSIX rename is atomic. If targetPath already exists as a regular
    // file, it's atomically replaced. If it doesn't exist, the temp file
    // is moved into place.
    await rename(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of the orphaned tempfile.
    if (written) {
      try { await unlink(tmpPath); } catch { /* ignore */ }
    }
    throw err;
  }
}

/**
 * Atomic sync write — replacement for `fs.writeFileSync`. Used by
 * `src/brain/config.js` which writes `.curator-config.json` during startup
 * before the async runtime is fully online (key save flow + onboarding
 * wizard). Sync is required there because callers don't await.
 */
export function writeFileAtomicSync(targetPath, content, opts = 'utf8') {
  const { encoding, mode } = normalizeOpts(opts);
  if (isUnsafeSymlinkSync(targetPath)) {
    throw new Error(
      `Refusing to write through symlink: ${targetPath}. ` +
      `If you intentionally want to replace this file, remove the symlink first.`
    );
  }
  // A synchronous write cannot wait for a copy, so inside a Health action it
  // may not touch a page at all: refused, never written without its copy.
  const recorder = writeRecorder.getStore();
  if (recorder && recorder.covers(targetPath)) {
    throw new Error(`Refusing a synchronous write to ${path.basename(targetPath)} during a Wiki health change: it could not be copied for Undo first.`);
  }
  const tmpPath = nextTmpName(targetPath);
  let written = false;
  try {
    if (Buffer.isBuffer(content)) {
      writeFileSync(tmpPath, content);
    } else {
      writeFileSync(tmpPath, content, encoding);
    }
    written = true;
    // See writeFileAtomic — explicit chmod so umask can't loosen 0600.
    if (mode !== undefined) chmodSync(tmpPath, mode);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    if (written && existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    throw err;
  }
}

/**
 * Test helper — exposes the temp-path generator so battle tests can verify
 * the same-directory naming convention without monkey-patching fs.
 */
export const __testing = { nextTmpName };
