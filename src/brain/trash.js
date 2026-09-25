/**
 * Recoverable delete (v3.73.0) — MOVE a folder into The Curator's trash
 * instead of `rm -rf`-ing it.
 *
 * Used by `deleteDomain` (files.js), `deleteProject` and `deleteWorkStream`
 * (working-state.js). Listing, restoring and permanently deleting an entry
 * live in trash-items.js (v3.76.0, Settings › Trash).
 * The trash lives OUTSIDE the domains folder — see `getTrashDir()` in
 * paths.js for why that is load-bearing (Personal Sync's work-tree).
 *
 * A LEAF MODULE: it imports paths.js and node built-ins only, so both
 * files.js and working-state.js (which imports files.js) can use it without
 * a cycle. It never writes to stdout — the MCP reaches working-state.js.
 *
 * ── Two ways to move, and the one that is not atomic ──────────────────────
 *
 * `rename(2)` is one atomic step, and is what happens on every normal install:
 * the domains folder and the user-data dir sit on the same volume. A user who
 * pointed `domainsPath` at a USB stick or another volume gets EXDEV from
 * rename, and then the folder is COPIED into the trash and the original is
 * removed only after the copy completed. A copy that fails part-way removes
 * its own partial copy and leaves the original exactly where it was: the
 * failure direction is "nothing was deleted", never "half was".
 */

import { rename as fsRename, cp, rm, mkdir, readdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getTrashDir } from './paths.js';

/** Filesystem-safe UTC stamp, second resolution: 2026-09-25T14-03-22Z. */
export function trashStamp(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

/**
 * The folder a delete will land in. Never an existing path: a second delete
 * in the same second (or a restored-then-deleted-again domain) gets `-2`,
 * `-3`, … rather than colliding.
 */
export function uniqueTrashPath(kind, baseName, now = new Date()) {
  const dir = path.join(getTrashDir(), kind);
  const stem = `${baseName}--${trashStamp(now)}`;
  let candidate = path.join(dir, stem);
  for (let i = 2; existsSync(candidate); i++) candidate = path.join(dir, `${stem}-${i}`);
  return candidate;
}

/**
 * Move `src` to `dest` (which must not exist). `opts.rename` is a TEST-ONLY
 * seam — it lets a suite force the EXDEV path, which no single-volume test
 * machine can produce for real. Production callers never pass it.
 */
export async function __moveDirectory(src, dest, opts = {}) {
  const renameFn = typeof opts.rename === 'function' ? opts.rename : fsRename;
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await renameFn(src, dest);
    return { method: 'rename' };
  } catch (err) {
    if (!err || err.code !== 'EXDEV') throw err;
  }
  // Another volume. Copy first; the original goes only once the copy is whole.
  try {
    await cp(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  } catch (err) {
    try { await rm(dest, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
  await rm(src, { recursive: true, force: true });
  return { method: 'copy' };
}

/**
 * The ORIGIN RECORD beside a trash entry (v3.76.0): `<trash>/<kind>/<id>.origin.json`.
 *
 * The folder name alone (`<domain>--<project>--<scope>--<stamp>`) cannot be
 * split back into its parts when a domain or a scope name itself contains
 * `--` — both are legal (a hand-made domain folder, a scope named
 * `a--b`). The record says exactly where the folder came from, so Settings ›
 * Trash can put it back. It sits BESIDE the folder, never inside it, so a
 * restored folder is byte-identical to the one that was deleted.
 *
 * Best-effort: a record that cannot be written costs only the exactness of a
 * later restore (trash-items.js falls back to reading the name), never the
 * delete itself.
 */
export function originRecordPath(entryPath) {
  return entryPath + '.origin.json';
}

/**
 * Move one folder into `<trash>/<kind>/<baseName>--<stamp>/`.
 * Returns the absolute path it now lives at.
 *
 * `origin` (optional) — `{ domain, project?, scope? }`, written as the origin
 * record beside it (see originRecordPath).
 */
export async function moveToTrash(src, kind, baseName, origin) {
  const trashRoot = path.resolve(getTrashDir());
  const from = path.resolve(src);
  // A trash INSIDE the folder being deleted would move a folder into itself
  // (an install whose domainsPath is odd enough to contain the user-data
  // dir). Refuse rather than guess.
  if (trashRoot === from || trashRoot.startsWith(from + path.sep)) {
    throw new Error('Refusing to delete: the trash folder is inside the folder being deleted.');
  }
  const dest = uniqueTrashPath(kind, baseName);
  await __moveDirectory(from, dest);
  if (origin && typeof origin === 'object') {
    try {
      await writeFile(originRecordPath(dest), JSON.stringify({
        version: 1, kind,
        domain: origin.domain ?? null,
        project: origin.project ?? null,
        scope: origin.scope ?? null,
        deletedAt: new Date().toISOString(),
      }, null, 2) + '\n', 'utf8');
    } catch { /* best-effort — see originRecordPath */ }
  }
  return dest;
}

/** How many regular files sit under `dir` (dot-files skipped), capped. */
export async function countFiles(dir, cap = 100000) {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < cap) {
    const d = stack.pop();
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) stack.push(path.join(d, e.name));
      else if (e.isFile()) n++;
    }
  }
  return n;
}
