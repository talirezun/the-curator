/**
 * Undo for Wiki health (owner's decision, 2026-11-07, reversing "There is NO
 * in-app revert").
 *
 * Before a Health action changes a file in a domain's wiki, a copy of that
 * file as it was is saved here, outside `domains/`, on this computer only.
 * "Recent changes" lists those actions for 30 days, and Undo puts every file
 * back exactly as it was — or, if any of them changed since, changes nothing.
 *
 * ── How the copy is taken: at the write, not from a plan ─────────────────
 *
 * `withHealthUndo(domain, meta, fn)` runs `fn` with a recorder in
 * `writeRecorder` (atomic-write.js). Every `writeFileAtomic` and every
 * `removeWikiFile` asks the recorder first, and the recorder copies the file's
 * CURRENT bytes (or notes that it does not exist) to disk, fsynced, before it
 * lets the write go ahead. The first touch of each file is the one copied;
 * later writes to the same file in the same action are not, so the copy is
 * always the state before the action.
 *
 * Why at the write and not from a list of files each action would declare: a
 * merge repoints links in pages found while it runs, and a second list of
 * "the files this action touches" kept beside the code that touches them is a
 * list that drifts. At the chokepoint, a file cannot be changed without its
 * copy, whichever code path changes it.
 *
 * THE COPY FAILS ⇒ THE WRITE DOES NOT RUN. The record (folder + record.json)
 * is created BEFORE `fn` runs, so an unwritable store refuses the action with
 * nothing changed. A copy that fails later (a full disk part-way through)
 * throws at that write, so that file and everything after it is untouched;
 * the files the action already changed have their copies and are undoable.
 *
 * ── Undo is all or nothing ─────────────────────────────────────────────────
 *
 * Every file must be exactly as the action left it (sha-256 of the bytes, and
 * existence). One file that differs — an edit, a later ingest, a sync from
 * another computer, a later Health change — refuses the whole undo, names the
 * page, and writes nothing. Undo never overwrites a change it did not make.
 *
 * A CRASH PART-WAY THROUGH AN UNDO. The record is marked `undoing` (fsynced)
 * before the first file is put back, and each file is put back by an atomic
 * rename. If the process dies part-way, the next thing that touches this
 * domain's changes — the server's start, the list, any Health action — finds
 * `undoing` and finishes it, file by file, only where a file is still as the
 * action left it. So the wiki ends as it was before the action, never half;
 * between the crash and the next start, the disk can hold a mix.
 *
 * ── What it does not cover, said where people read it ────────────────────
 *
 *   - other computers: the copies are on this one. A merge synced to another
 *     computer is undone there only by syncing this computer's undo to it;
 *   - files changed since: refused, never overwritten;
 *   - ingest, compile and the MCP's `compile_to_wiki` writes: not Health
 *     actions, not recorded;
 *   - the repair scripts in scripts/: not recorded.
 *
 * Machine-local, not synced, never inside `domains/`: `getHealthUndoDir()`.
 * Records are keyed by the domain's name AND a hash of its folder, so a
 * record is never applied to a different folder of the same name (a changed
 * knowledge folder, or a test's temporary one).
 *
 * Never writes to stdout: reachable from the MCP (fix_wiki_issue).
 */

import { open, readFile, readdir, rename, rm, mkdir, lstat, stat, readlink, symlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { getHealthUndoDir } from './paths.js';
import { writeRecorder } from './atomic-write.js';
import { domainPath, wikiPath } from './files.js';

export const UNDO_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Per domain folder. The newest record is never deleted to meet it. */
export const UNDO_MAX_BYTES = 256 * 1024 * 1024;
/** A recording left by a process that is gone is finished after this long even if the pid is reused. */
const STALE_RECORDING_MS = 60 * 60 * 1000;
const RECORD_FILE = 'record.json';
// Sorts by time: milliseconds, then a per-process counter, then a random tail.
const ID_RE = /^\d{8}T\d{9}Z-[0-9a-f]{12}$/;


export const UNDO_COPY_FAILED = 'undo-copy-failed';
export const UNDO_CONFLICT = 'undo-conflict';
export const UNDO_NOT_FOUND = 'undo-not-found';
export const UNDO_NOT_READY = 'undo-not-ready';

// ── Test seams ────────────────────────────────────────────────────────────
let _fault = null;
/**
 * TEST-ONLY. `{ copy(rel) }` may throw to simulate a copy that cannot be
 * saved; `{ restore(index, rel) }` runs before each file an undo puts back
 * (a suite kills its own process there to simulate a crash).
 */
export function __setUndoFaultForTest(f) { _fault = f || null; }

const _activeIds = new Set();   // records this process is recording or undoing now

// Creating a record and expiring old ones take turns: expiry removes a domain's
// folder once it is empty, and must never do that between a new record's mkdir
// and its first write.
let _storeTurn = Promise.resolve();
function inTurn(fn) {
  const run = _storeTurn.then(fn);
  _storeTurn = run.catch(() => {});
  return run;
}

// ── Small helpers ─────────────────────────────────────────────────────────
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

function idStamp(now) {
  return now.toISOString().replace(/[-:.]/g, '');
}

let _idCounter = 0;
function newId(now = new Date()) {
  _idCounter = (_idCounter + 1) & 0xffff;
  return idStamp(now) + '-' + _idCounter.toString(16).padStart(4, '0') + randomBytes(4).toString('hex');
}

function assertDomainName(domain) {
  // Any folder name the app accepts, but never one that leaves the store.
  if (typeof domain !== 'string' || !domain || domain === '.' || domain === '..' || /[\/\\\0]/.test(domain)) {
    const err = new Error('Invalid domain name.');
    err.status = 400;
    throw err;
  }
}

/** The folder this domain's records live in: its name and a hash of its folder. */
export function domainUndoDir(domain) {
  assertDomainName(domain);
  const key = sha256(path.resolve(domainPath(domain))).slice(0, 12);
  return path.join(getHealthUndoDir(), `${domain}--${key}`);
}

function recordDir(domain, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  return path.join(domainUndoDir(domain), id);
}

async function syncDir(dir) {
  try {
    const fh = await open(dir, 'r');
    try { await fh.sync(); } finally { await fh.close(); }
  } catch { /* not every filesystem lets a directory be fsynced */ }
}

/**
 * Write `data` to `file` so a crash leaves the old file or the new one, and
 * the new one is on disk when this returns. The temp name is fixed-length
 * (a 244-character page name must not overflow NAME_MAX).
 */
async function durableWrite(file, data, mode = 0o600) {
  const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const fh = await open(tmp, 'w', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await fh.close();
  try { await rename(tmp, file); }
  catch (err) { await rm(tmp, { force: true }).catch(() => {}); throw err; }
  await syncDir(path.dirname(file));
}

async function fileState(abs) {
  let st;
  try { st = await lstat(abs); }
  catch (err) { if (err.code === 'ENOENT') return { exists: false }; throw err; }
  // A page that is a symbolic link (a merge may remove one) is recorded as the
  // link, not the file it points at, and put back as that link.
  if (st.isSymbolicLink()) {
    const link = await readlink(abs);
    return { exists: true, link, sha: sha256('symlink:' + link), size: 0 };
  }
  if (!st.isFile()) {
    const err = new Error(`${path.basename(abs)} is not a plain file.`);
    err.code = 'NOT_A_FILE';
    throw err;
  }
  const bytes = await readFile(abs);
  return { exists: true, sha: sha256(bytes), size: bytes.length, bytes };
}

function sameState(a, b) {
  if (!a || !b) return false;
  if (!a.exists || !b.exists) return a.exists === b.exists;
  return a.sha === b.sha;
}

function relInside(wikiDir, abs) {
  if (typeof abs !== 'string') return null;
  const rel = path.relative(path.resolve(wikiDir), path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function absOf(wikiDir, rel) {
  const abs = path.resolve(wikiDir, ...rel.split('/'));
  if (relInside(wikiDir, abs) !== rel) throw new Error('A recorded path is outside the wiki.');
  return abs;
}

async function readRecord(dir) {
  try { return JSON.parse(await readFile(path.join(dir, RECORD_FILE), 'utf8')); }
  catch { return null; }
}

async function writeRecord(dir, rec) {
  await durableWrite(path.join(dir, RECORD_FILE), JSON.stringify(rec, null, 2));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

/** Is someone still working on this record? This process, or another live one, recently. */
function ownerLive(rec, now = Date.now()) {
  if (_activeIds.has(rec.id)) return true;
  if (rec.pid === process.pid) return false;           // this process, not active: left over from a failure
  const since = Date.parse(rec.status === 'undoing' ? (rec.undoStartedAt || rec.createdAt) : rec.createdAt);
  if (Number.isFinite(since) && now - since > STALE_RECORDING_MS) return false;
  return processAlive(rec.pid);
}

const isIndexFile = (rel) => rel === 'index.md' || rel === 'log.md';
const pageName = (rel) => rel.replace(/\.md$/i, '');

function summarise(files) {
  const deleted = [], created = [], changed = [];
  for (const f of files) {
    if (!f.after) continue;
    if (f.before.exists && !f.after.exists) deleted.push(f.rel);
    else if (!f.before.exists && f.after.exists) created.push(f.rel);
    else changed.push(f.rel);
  }
  return { deleted, created, changed };
}

// ── Recording ─────────────────────────────────────────────────────────────

class Recorder {
  constructor(domain, wikiDir, dir, rec) {
    this.domain = domain;
    this.wikiDir = path.resolve(wikiDir);
    this.dir = dir;
    this.rec = rec;
    this.seen = new Map();     // rel → Promise of its copy
    this.chain = Promise.resolve();
    this.closed = false;
    this.failed = null;
  }

  covers(abs) { return !this.closed && relInside(this.wikiDir, abs) !== null; }

  async beforeWrite(abs) {
    if (this.closed) return;
    const rel = relInside(this.wikiDir, abs);
    if (rel === null) return;
    // A copy that failed stops every later write of this action too.
    if (this.failed) throw this.failed;
    if (!this.seen.has(rel)) this.seen.set(rel, this.copy(rel, abs));
    await this.seen.get(rel);
  }

  copy(rel, abs) {
    // One at a time: the record file lists the copies in the order they were taken.
    const run = this.chain.then(async () => {
      try {
        if (_fault && _fault.copy) await _fault.copy(rel);
        const before = await fileState(abs);
        const entry = { rel, before: { exists: before.exists }, after: null };
        if (before.exists && before.link !== undefined) {
          entry.before.link = before.link;
          entry.before.sha = before.sha;
        } else if (before.exists) {
          const copyName = 'f' + this.rec.files.length;
          await durableWrite(path.join(this.dir, copyName), before.bytes);
          entry.copy = copyName;
          entry.before.sha = before.sha;
          entry.before.size = before.size;
        }
        this.rec.files.push(entry);
        await writeRecord(this.dir, this.rec);
      } catch (err) {
        const e = new Error(`The Curator could not save a copy of ${rel} for Undo, so it did not change it. ${err.message}`);
        e.code = UNDO_COPY_FAILED;
        e.status = 507;
        this.failed = e;
        throw e;
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }
}

async function openRecord(domain, meta) {
  const dir = domainUndoDir(domain);
  const id = newId();
  const rdir = path.join(dir, id);
  const rec = {
    v: 1, id, domain, folder: path.resolve(domainPath(domain)),
    createdAt: new Date().toISOString(), pid: process.pid,
    status: 'recording', kind: String(meta && meta.kind || 'health'),
    title: null, files: [],
  };
  try {
    await inTurn(async () => {
      await mkdir(rdir, { recursive: true, mode: 0o700 });
      await writeRecord(rdir, rec);
    });
  } catch (err) {
    await rm(rdir, { recursive: true, force: true }).catch(() => {});
    const e = new Error(`The Curator could not save copies for Undo, so nothing was changed. ${err.message}`);
    e.code = UNDO_COPY_FAILED;
    e.status = 507;
    throw e;
  }
  _activeIds.add(id);
  return new Recorder(domain, wikiPath(domain), rdir, rec);
}

/** What the action left: the after-state of every copied file. Unchanged files are dropped. */
async function settleFiles(wikiDir, rdir, files) {
  const kept = [];
  for (const f of files) {
    let now;
    try { now = await fileState(absOf(wikiDir, f.rel)); }
    catch { now = { exists: true, sha: 'unreadable' }; }
    const after = now.exists ? { exists: true, sha: now.sha } : { exists: false };
    if (sameState(f.before, after)) {
      if (f.copy) await rm(path.join(rdir, f.copy), { force: true }).catch(() => {});
      continue;
    }
    kept.push({ ...f, after });
  }
  return kept;
}

function describe(meta, summary, result) {
  let title = null;
  try {
    title = typeof meta.title === 'function' ? meta.title(summary, result) : meta.title;
  } catch { title = null; }
  if (typeof title !== 'string' || !title.trim()) title = 'Wiki health change';
  return title.trim().slice(0, 300);
}

async function finishRecording(recorder, meta, result, { interrupted = false } = {}) {
  const { rec, dir } = recorder;
  const files = await settleFiles(recorder.wikiDir, dir, rec.files);
  if (!files.length) {
    await rm(dir, { recursive: true, force: true });
    return null;
  }
  rec.files = files;
  rec.title = describe(meta, summarise(files), result);
  rec.status = 'ready';
  if (interrupted) rec.interrupted = true;
  rec.finishedAt = new Date().toISOString();
  await writeRecord(dir, rec);
  return publicChange(rec);
}

/**
 * Run a Health action with every file it changes copied first.
 *
 * `meta` is `{ kind, title }`, where `title` may be a function of
 * `({deleted, created, changed}, result)` returning plain words. Returns the
 * action's own result; an object result gains `undo: {id, title, pages}` when
 * something changed (additive).
 *
 * A call made while another Health action on the same domain is recording (a
 * fix-all calling fixIssue) joins that record: one action, one Undo.
 */
export async function withHealthUndo(domain, meta, fn) {
  const outer = writeRecorder.getStore();
  if (outer && !outer.closed && outer.domain === domain) return fn();
  await recoverHealthUndo(domain);
  const recorder = await openRecord(domain, meta || {});
  let result, error = null;
  try {
    result = await writeRecorder.run(recorder, fn);
  } catch (err) {
    error = err;
  } finally {
    recorder.closed = true;
  }
  let change = null;
  try {
    change = await finishRecording(recorder, meta || {}, result, { interrupted: !!error });
  } catch (err) {
    console.error('[health-undo] could not finish a record:', err.message);
  } finally {
    _activeIds.delete(recorder.rec.id);
  }
  pruneHealthUndo().catch((err) => console.error('[health-undo] prune failed:', err.message));
  if (error) {
    if (change) error.undo = change;
    throw error;
  }
  if (change && result && typeof result === 'object' && !Array.isArray(result)) result.undo = change;
  return result;
}

/** `rm` of a wiki file, copied first when a Health action is recording. */
export async function removeWikiFile(abs, opts) {
  const recorder = writeRecorder.getStore();
  if (recorder) await recorder.beforeWrite(abs);
  return rm(abs, opts);
}

// ── Reading ───────────────────────────────────────────────────────────────

function publicChange(rec) {
  const files = Array.isArray(rec.files) ? rec.files : [];
  const s = summarise(files);
  const pages = files.filter((f) => !isIndexFile(f.rel));
  return {
    id: rec.id,
    at: rec.createdAt,
    kind: rec.kind,
    title: rec.title || 'Wiki health change',
    status: rec.status === 'undone' ? 'undone' : (rec.status === 'stuck' ? 'stuck' : 'ready'),
    pages: pages.length,
    pageList: pages.map((f) => pageName(f.rel)),
    deleted: s.deleted.filter((r) => !isIndexFile(r)).map(pageName),
    index: files.some((f) => f.rel === 'index.md'),
    ...(rec.interrupted ? { interrupted: true } : {}),
    ...(rec.undoneAt ? { undoneAt: rec.undoneAt } : {}),
    ...(rec.stuck ? { stuck: rec.stuck } : {}),
  };
}

async function listRecordDirs(dir) {
  let names;
  try { names = await readdir(dir); } catch { return []; }
  return names.filter((n) => ID_RE.test(n)).sort();
}

/**
 * The domain's recent changes, newest first, last 30 days.
 * Read-only apart from finishing an interrupted undo and expiring old copies.
 */
export async function listHealthChanges(domain, { now = Date.now() } = {}) {
  await recoverHealthUndo(domain);
  const dir = domainUndoDir(domain);
  const out = [];
  for (const id of (await listRecordDirs(dir)).reverse()) {
    const rec = await readRecord(path.join(dir, id));
    if (!rec || rec.status === 'recording' || rec.status === 'undoing') continue;
    const at = Date.parse(rec.createdAt);
    if (!Number.isFinite(at) || now - at > UNDO_KEEP_DAYS * DAY_MS) continue;
    out.push(publicChange(rec));
  }
  return out;
}

// ── Undo ──────────────────────────────────────────────────────────────────

function refusal(code, message, status, extra = {}) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  Object.assign(e, extra);
  return e;
}

/** Which recorded files are no longer as the action left them, and why, in plain words. */
async function findConflicts(domain, rec) {
  const wikiDir = wikiPath(domain);
  const conflicts = [];
  for (const f of rec.files) {
    let now;
    try { now = await fileState(absOf(wikiDir, f.rel)); }
    catch { conflicts.push({ page: pageName(f.rel), why: 'unreadable' }); continue; }
    if (sameState(f.after, now)) continue;
    const why = f.after.exists && !now.exists ? 'deleted'
      : !f.after.exists && now.exists ? 'recreated' : 'edited';
    conflicts.push({ page: pageName(f.rel), why });
  }
  if (!conflicts.length) return conflicts;
  // A later Health change that touched the same page says which one to undo first.
  const dir = domainUndoDir(domain);
  for (const id of await listRecordDirs(dir)) {
    if (id <= rec.id) continue;
    const later = await readRecord(path.join(dir, id));
    if (!later || later.status !== 'ready') continue;
    for (const c of conflicts) {
      if (!c.laterChange && later.files.some((f) => pageName(f.rel) === c.page)) {
        c.laterChange = { id: later.id, title: later.title, at: later.createdAt };
      }
    }
  }
  return conflicts;
}

function conflictMessage(conflicts) {
  const c = conflicts[0];
  const what = c.why === 'deleted' ? 'was deleted' : c.why === 'recreated' ? 'was created again'
    : c.why === 'unreadable' ? 'could not be read' : 'was changed';
  const others = conflicts.length > 1 ? ` (and ${conflicts.length - 1} more)` : '';
  const why = c.laterChange
    ? `by a later change, "${c.laterChange.title}". Undo that one first.`
    : 'after this change: an edit, a later ingest, or a sync from another computer.';
  return `Nothing was undone. ${c.page}${others} ${what} ${why} Undo puts back every page or none, and never overwrites a newer change.`;
}

/**
 * Can this change be undone right now? `{ ok, conflicts, change }`. Read-only.
 */
export async function checkHealthUndo(domain, id) {
  await recoverHealthUndo(domain);
  const rdir = recordDir(domain, id);
  const rec = rdir ? await readRecord(rdir) : null;
  if (!rec) throw refusal(UNDO_NOT_FOUND, 'This change is no longer in the list: its copies have expired or were removed.', 404);
  if (rec.status !== 'ready') {
    return { ok: false, change: publicChange(rec), conflicts: [],
      message: rec.status === 'undone' ? 'This change was already undone.' : 'This change cannot be undone.' };
  }
  const conflicts = await findConflicts(domain, rec);
  return { ok: conflicts.length === 0, change: publicChange(rec), conflicts,
    ...(conflicts.length ? { message: conflictMessage(conflicts) } : {}) };
}

/** Put every recorded file back. Only files still as the action left them are touched. */
async function restoreFiles(domain, rdir, rec) {
  const wikiDir = wikiPath(domain);
  let i = 0;
  for (const f of rec.files) {
    const abs = absOf(wikiDir, f.rel);
    const now = await fileState(abs).catch(() => null);
    if (now && sameState(f.before, now)) { i++; continue; }        // already back
    if (!now || !sameState(f.after, now)) {
      // Only reachable after a crash, when something else wrote this page
      // before the undo was finished. Left alone: never overwrite a newer change.
      throw refusal(UNDO_CONFLICT, `${pageName(f.rel)} changed while the undo was unfinished.`, 409, { page: pageName(f.rel) });
    }
    if (_fault && _fault.restore) await _fault.restore(i, f.rel);
    if (f.before.exists && f.before.link !== undefined) {
      await rm(abs, { force: true });
      await symlink(f.before.link, abs);
      await syncDir(path.dirname(abs));
    } else if (f.before.exists) {
      const bytes = await readFile(path.join(rdir, f.copy));
      if (sha256(bytes) !== f.before.sha) throw refusal(UNDO_CONFLICT, `The saved copy of ${pageName(f.rel)} is damaged.`, 409);
      await mkdir(path.dirname(abs), { recursive: true });
      await durableWrite(abs, bytes, 0o644);
    } else {
      await rm(abs, { force: true });
      await syncDir(path.dirname(abs));
    }
    i++;
  }
}

/**
 * Undo one change: every file back exactly as it was, or nothing.
 * The caller holds the domain's write lock (the route does).
 */
export async function undoHealthChange(domain, id) {
  await recoverHealthUndo(domain);
  const rdir = recordDir(domain, id);
  const rec = rdir ? await readRecord(rdir) : null;
  if (!rec) throw refusal(UNDO_NOT_FOUND, 'This change is no longer in the list: its copies have expired or were removed.', 404);
  if (rec.status === 'undone') throw refusal(UNDO_NOT_READY, 'This change was already undone.', 409);
  if (rec.status !== 'ready') throw refusal(UNDO_NOT_READY, 'This change cannot be undone.', 409);
  if (path.resolve(rec.folder || '') !== path.resolve(domainPath(domain))) {
    throw refusal(UNDO_NOT_READY, 'This change was made in a different knowledge folder.', 409);
  }
  // Every copy must be whole before anything is written.
  for (const f of rec.files) {
    if (!f.before.exists || f.before.link !== undefined) continue;
    let bytes;
    try { bytes = await readFile(path.join(rdir, f.copy)); } catch { bytes = null; }
    if (!bytes || sha256(bytes) !== f.before.sha) {
      throw refusal(UNDO_NOT_READY, `Nothing was undone: the saved copy of ${pageName(f.rel)} is missing or damaged.`, 409);
    }
  }
  const conflicts = await findConflicts(domain, rec);
  if (conflicts.length) throw refusal(UNDO_CONFLICT, conflictMessage(conflicts), 409, { conflicts });

  _activeIds.add(rec.id);
  try {
    rec.status = 'undoing';
    rec.undoStartedAt = new Date().toISOString();
    rec.undoPid = process.pid;
    rec.pid = process.pid;
    await writeRecord(rdir, rec);
    await restoreFiles(domain, rdir, rec);
    rec.status = 'undone';
    rec.undoneAt = new Date().toISOString();
    await writeRecord(rdir, rec);
  } finally {
    _activeIds.delete(rec.id);
  }
  return publicChange(rec);
}

// ── Recovery and expiry ───────────────────────────────────────────────────

/**
 * Finish what a crash left: an undo part-way (finished, file by file), and a
 * recording whose action died (kept, marked interrupted, so its copies can
 * put back what it did change). Safe to call any time; the server calls it
 * at start for every domain.
 */
export async function recoverHealthUndo(domain) {
  let dir;
  try { dir = domainUndoDir(domain); } catch { return; }
  if (!existsSync(dir)) return;
  for (const id of await listRecordDirs(dir)) {
    const rdir = path.join(dir, id);
    const rec = await readRecord(rdir);
    if (!rec) continue;
    if (rec.status !== 'undoing' && rec.status !== 'recording') continue;
    if (ownerLive(rec)) continue;
    try {
      if (rec.status === 'undoing') {
        _activeIds.add(rec.id);
        try {
          await restoreFiles(domain, rdir, rec);
          rec.status = 'undone';
          rec.undoneAt = new Date().toISOString();
          rec.recovered = true;
        } catch (err) {
          rec.status = 'stuck';
          rec.stuck = err.message;
        } finally {
          _activeIds.delete(rec.id);
        }
        await writeRecord(rdir, rec);
      } else {
        const files = await settleFiles(wikiPath(domain), rdir, rec.files || []);
        if (!files.length) { await rm(rdir, { recursive: true, force: true }); continue; }
        rec.files = files;
        rec.status = 'ready';
        rec.interrupted = true;
        rec.title = rec.title || 'An interrupted Wiki health change';
        await writeRecord(rdir, rec);
      }
    } catch (err) {
      console.error('[health-undo] recovery failed for a record:', err.message);
    }
  }
}

/**
 * What the server runs at start: finish what a crash left, then expire copies
 * older than 30 days (and over the cap), so they do not wait for the next
 * Health action to go. Never throws.
 */
export async function startHealthUndo() {
  try { await recoverAllHealthUndo(); } catch (err) { console.error('[health-undo] recovery at start failed:', err.message); }
  try { await pruneHealthUndo(); } catch (err) { console.error('[health-undo] expiry at start failed:', err.message); }
}

/** Every domain folder that has records: run recovery for each. For the server's start. */
export async function recoverAllHealthUndo() {
  let names;
  try { names = await readdir(getHealthUndoDir()); } catch { return; }
  for (const n of names) {
    const cut = n.lastIndexOf('--');
    if (cut <= 0) continue;
    const domain = n.slice(0, cut);
    try {
      if (domainUndoDir(domain) === path.join(getHealthUndoDir(), n)) await recoverHealthUndo(domain);
    } catch { /* a name that is not a domain */ }
  }
}

async function recordBytes(rdir) {
  let total = 0;
  let names;
  try { names = await readdir(rdir); } catch { return 0; }
  for (const n of names) {
    try { total += (await stat(path.join(rdir, n))).size; } catch { /* gone */ }
  }
  return total;
}

/**
 * Expire records older than 30 days, then, per domain folder, delete the
 * OLDEST records until the copies fit `maxBytes` — never the newest one, and
 * never one being recorded or undone.
 */
export function pruneHealthUndo(opts = {}) {
  return inTurn(() => pruneNow(opts));
}

async function pruneNow({ now = Date.now(), maxBytes = UNDO_MAX_BYTES } = {}) {
  const root = getHealthUndoDir();
  let keys;
  try { keys = await readdir(root); } catch { return { removed: 0 }; }
  let removed = 0;
  for (const key of keys) {
    const dir = path.join(root, key);
    const ids = await listRecordDirs(dir);
    const live = [];
    for (const id of ids) {
      const rdir = path.join(dir, id);
      const rec = await readRecord(rdir);
      if (rec && (rec.status === 'recording' || rec.status === 'undoing')) { live.push({ id, rdir, busy: true }); continue; }
      const at = rec ? Date.parse(rec.createdAt) : NaN;
      if (!Number.isFinite(at) || now - at > UNDO_KEEP_DAYS * DAY_MS) {
        // A record that cannot be read is expired only once its folder is old, so a
        // half-written newest one is never removed under its writer.
        if (!rec) {
          try { if (now - (await stat(rdir)).mtimeMs <= STALE_RECORDING_MS) { live.push({ id, rdir, busy: true }); continue; } } catch { continue; }
        }
        await rm(rdir, { recursive: true, force: true });
        removed++;
        continue;
      }
      live.push({ id, rdir, busy: false });
    }
    const sizes = [];
    let total = 0;
    for (const r of live) { const b = await recordBytes(r.rdir); sizes.push(b); total += b; }
    // Oldest first; the last (newest) is never a candidate.
    for (let i = 0; i < live.length - 1 && total > maxBytes; i++) {
      if (live[i].busy) continue;
      await rm(live[i].rdir, { recursive: true, force: true });
      total -= sizes[i];
      removed++;
    }
    try { if (!(await readdir(dir)).length) await rm(dir, { recursive: true, force: true }); } catch { /* fine */ }
  }
  return { removed };
}
