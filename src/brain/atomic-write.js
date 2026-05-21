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
 * 2. Tempfile name includes process pid + a monotonic counter so two
 *    concurrent writers in the same dir never collide.
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

import { writeFile, rename, unlink, lstat } from 'fs/promises';
import {
  writeFileSync,
  renameSync,
  unlinkSync,
  lstatSync,
  existsSync,
} from 'fs';
import path from 'path';

// Per-process monotonic counter to avoid temp-file collisions on the same
// millisecond in the same directory.
let _tmpCounter = 0;
function nextTmpName(targetPath) {
  _tmpCounter = (_tmpCounter + 1) & 0xffffffff;
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  // Leading dot keeps the temp file out of casual `ls` output;
  // pid + counter make collisions effectively impossible.
  return path.join(dir, `.tmp-${base}-${process.pid}-${_tmpCounter}`);
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
 * @param {string} [encoding]  Encoding for string content (default 'utf8')
 * @returns {Promise<void>}
 */
export async function writeFileAtomic(targetPath, content, encoding = 'utf8') {
  if (await isUnsafeSymlink(targetPath)) {
    throw new Error(
      `Refusing to write through symlink: ${targetPath}. ` +
      `If you intentionally want to replace this file, remove the symlink first.`
    );
  }
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
export function writeFileAtomicSync(targetPath, content, encoding = 'utf8') {
  if (isUnsafeSymlinkSync(targetPath)) {
    throw new Error(
      `Refusing to write through symlink: ${targetPath}. ` +
      `If you intentionally want to replace this file, remove the symlink first.`
    );
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
