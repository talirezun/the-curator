/**
 * Settings › Trash (v3.76.0) — LIST what is in The Curator's trash, RESTORE
 * one entry to where it came from, or DELETE one entry FOREVER.
 *
 * The trash itself (where a deleted domain, project or handoff goes, and why
 * it is outside the domains folder) is trash.js and paths.js's getTrashDir().
 * Three kinds, one folder each, named by the delete that made them:
 *
 *   domains/<slug>--<stamp>/                      → domains/<slug>/
 *   projects/<domain>--<project>--<stamp>/        → domains/<domain>/state/<project>/
 *   scopes/<domain>--<project>--<scope>--<stamp>/ → domains/<domain>/state/[<project>/]<scope>/
 *
 * (`<stamp>` is trash.js's `trashStamp`, optionally `-2`, `-3`… A scope of
 * the domain's OWN project has `<project>` equal to `<domain>` and lives at
 * the state root, the rule `projectPrefix` states.)
 *
 * ── WHERE AN ENTRY CAME FROM ─────────────────────────────────────────────
 * Read from the ORIGIN RECORD beside it (trash.js's originRecordPath), and
 * only when that record agrees with the folder's own name. An entry deleted
 * before v3.76.0 has no record, so its name is split: exactly when that split
 * is unambiguous. A name that can be split more than one way (a domain or a
 * scope whose own name contains `--`) and no live domain settles it is
 * UNKNOWN ORIGIN, and the entry is listed but not restorable — a restore that
 * guessed would put someone's handoffs into the wrong project.
 *
 * ── THE THREE RULES A RESTORE KEEPS ──────────────────────────────────────
 *  1. NEVER OVERWRITE, NEVER MERGE. A destination that exists now is refused
 *     (`exists`), with a suggested other name (`<name>-restored`) the caller
 *     may pass back EXPLICITLY as `as`. Nothing is ever written into an
 *     existing folder.
 *  2. THE PARENT MUST STILL BE THERE. A project or handoff whose domain (or
 *     whose named project) is gone is refused (`no-parent`) with the reason:
 *     restore the domain or the project first. The domains folder itself
 *     missing (an unmounted drive) refuses a domain restore the same way.
 *  3. THE SAME GUARDS AS THE DELETE. A project or handoff restore takes the
 *     domain's cross-process write lock, the one deleteProject and
 *     deleteWorkStream take, and a Shared Brain mirror is refused. The route
 *     adds the in-process write registry (a write in flight on that domain is
 *     a 409). A DOMAIN restore takes no file lock — acquireFileLock creates
 *     the folder it locks, and the destination must not exist — so its
 *     protection is the exists-check immediately before an atomic rename(2).
 *
 * ── ADDRESSING ───────────────────────────────────────────────────────────
 * An entry is addressed by (kind, id), and the id must be one of the names
 * readdir actually returns for that kind's folder, as a real directory (not a
 * symlink). Nothing built from the id is ever joined into a path before that
 * membership check, so `..`, `/`, an absolute path or a symlink simply do not
 * match anything.
 *
 * ── THE ONE PERMANENT DELETE IN THE APP ──────────────────────────────────
 * `emptyTrashItem` removes ONE entry for good, with a typed confirmation (the
 * entry's own name). There is deliberately no "empty the whole trash": the
 * trash exists because one click once removed a whole domain, and a one-click
 * erase of everything that was ever deleted would rebuild that hazard one
 * level down. A person who wants it all gone can empty the folder in Finder.
 *
 * Never writes to stdout.
 */

import { readdir, lstat, readFile, rm, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getTrashDir } from './paths.js';
import { getDomainsDir } from './config.js';
import { __moveDirectory, originRecordPath } from './trash.js';
import {
  domainPath, listDomains, isDomainReadonly, assertNotReservedDomainSlug, renameDomain,
} from './files.js';
import {
  isSafeSegment, projectPrefix, resolveInsideState, stateRoot,
  STATE_DIRNAME, CURRENT_FILENAME, BRIEF_FILENAME, FOUNDATIONS_DIRNAME,
} from './working-state.js';
import { acquireFileLock } from './write-registry.js';

/** The three kinds, as their folder names — also the URL segment. */
export const TRASH_KINDS = Object.freeze(['domains', 'projects', 'scopes']);

/** What one entry is called on screen. */
export const KIND_NOUN = Object.freeze({ domains: 'domain', projects: 'project', scopes: 'handoff' });

/** `…--2026-09-25T14-03-22Z` or `…--2026-09-25T14-03-22Z-2` at the END of a name. */
const STAMP_RE = /--(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:-(\d+))?$/;

/** Walk cap per entry: the listing stays cheap on a huge deleted domain. */
export const MAX_WALK_ENTRIES = 50000;

/** The suffix a "restore as a new name" suggestion carries. */
export const RESTORED_SUFFIX = '-restored';

const MAX_ORIGIN_RECORD_BYTES = 8 * 1024;

// ─────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────

/** A domain folder name a restore may create: createDomain's own guard. */
function isUsableDomainSlug(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 128
    && !s.includes('..') && !s.includes('/') && !s.includes('\\') && !s.startsWith('.')
    && !/[\0\r\n]/.test(s);
}

/** Split `<prefix>--<stamp>[-n]` → { prefix, stamp, deletedAt } or null. */
export function splitStamp(id) {
  if (typeof id !== 'string') return null;
  const m = STAMP_RE.exec(id);
  if (!m) return null;
  const prefix = id.slice(0, m.index);
  if (!prefix) return null;
  const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z');
  const t = Date.parse(iso);
  return { prefix, stamp: m[1], deletedAt: Number.isFinite(t) ? new Date(t).toISOString() : null };
}

/**
 * Every way `prefix` can be read as an origin of this kind. Pure. A domain
 * may hold `--`, and so may a scope; a project slug never does
 * (slugSegment collapses hyphen runs), which is what keeps most splits unique.
 */
export function originCandidates(kind, prefix) {
  if (typeof prefix !== 'string' || !prefix) return [];
  if (kind === 'domains') return isUsableDomainSlug(prefix) ? [{ domain: prefix }] : [];
  const parts = prefix.split('--');
  const out = [];
  if (kind === 'projects') {
    for (let i = 1; i < parts.length; i++) {
      const domain = parts.slice(0, i).join('--');
      const project = parts.slice(i).join('--');
      if (isSafeSegment(domain) && isSafeSegment(project)) out.push({ domain, project });
    }
  } else if (kind === 'scopes') {
    for (let i = 1; i < parts.length - 1; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const domain = parts.slice(0, i).join('--');
        const project = parts.slice(i, j).join('--');
        const scope = parts.slice(j).join('--');
        if (isSafeSegment(domain) && isSafeSegment(project) && isSafeSegment(scope)) out.push({ domain, project, scope });
      }
    }
  }
  return out;
}

/** The name prefix a delete of this origin would have minted. */
function prefixFor(kind, o) {
  if (kind === 'domains') return o.domain;
  if (kind === 'projects') return `${o.domain}--${o.project}`;
  return `${o.domain}--${o.project}--${o.scope}`;
}

async function readOriginRecord(entryAbs) {
  try {
    const st = await lstat(originRecordPath(entryAbs));
    if (!st.isFile() || st.size > MAX_ORIGIN_RECORD_BYTES) return null;
    const j = JSON.parse(await readFile(originRecordPath(entryAbs), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/**
 * Where one entry came from: `{ origin, originFrom }` or `{ origin: null }`.
 * `liveDomains` settles an ambiguous legacy name when exactly one reading
 * names a domain that exists.
 */
async function resolveOrigin(kind, id, entryAbs, liveDomains) {
  const sp = splitStamp(id);
  if (!sp) return { origin: null, deletedAt: null };
  const rec = await readOriginRecord(entryAbs);
  if (rec) {
    const o = {
      domain: typeof rec.domain === 'string' ? rec.domain : null,
      project: typeof rec.project === 'string' ? rec.project : null,
      scope: typeof rec.scope === 'string' ? rec.scope : null,
    };
    const shapeOk = kind === 'domains' ? isUsableDomainSlug(o.domain)
      : kind === 'projects' ? isSafeSegment(o.domain) && isSafeSegment(o.project)
        : isSafeSegment(o.domain) && isSafeSegment(o.project) && isSafeSegment(o.scope);
    // The record is believed only when it AGREES with the name: the id is the
    // authority on which entry this is, the record only disambiguates it.
    if (shapeOk && prefixFor(kind, o) === sp.prefix) {
      const origin = kind === 'domains' ? { domain: o.domain }
        : kind === 'projects' ? { domain: o.domain, project: o.project }
          : { domain: o.domain, project: o.project, scope: o.scope };
      return { origin, originFrom: 'record', deletedAt: sp.deletedAt };
    }
  }
  const cands = originCandidates(kind, sp.prefix);
  if (cands.length === 1) return { origin: cands[0], originFrom: 'name', deletedAt: sp.deletedAt };
  const live = cands.filter((c) => liveDomains.includes(c.domain));
  if (live.length === 1) return { origin: live[0], originFrom: 'name', deletedAt: sp.deletedAt };
  return { origin: null, deletedAt: sp.deletedAt, candidates: cands.length };
}

// ─────────────────────────────────────────────────────────────────────────
// What an entry holds — one bounded walk
// ─────────────────────────────────────────────────────────────────────────

async function walkEntry(kind, abs) {
  let bytes = 0, files = 0, seen = 0, capped = false;
  const c = { pages: 0, conversations: 0, rawSources: 0, handoffs: 0 };
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = await readdir(path.join(abs, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > MAX_WALK_ENTRIES) { capped = true; stack.length = 0; break; }
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { stack.push(r); continue; }
      if (!e.isFile()) continue;
      files++;
      try { bytes += (await lstat(path.join(abs, r))).size; } catch { /* vanished */ }
      if (e.name === CURRENT_FILENAME) c.handoffs++;
      if (kind === 'domains') {
        if (/^wiki\/(entities|concepts|summaries)\/[^/]+\.md$/.test(r)) c.pages++;
        else if (/^conversations\/[^/]+\.json$/.test(r)) c.conversations++;
        else if (r.startsWith('raw/') && !e.name.startsWith('.')) c.rawSources++;
      }
    }
  }
  const top = await (async () => {
    try { return (await readdir(abs, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch { return []; }
  })();
  const contains = { handoffs: c.handoffs };
  if (kind === 'domains') {
    Object.assign(contains, { pages: c.pages, conversations: c.conversations, rawSources: c.rawSources });
    contains.projects = await (async () => {
      try {
        return (await readdir(path.join(abs, STATE_DIRNAME), { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== FOUNDATIONS_DIRNAME
            && existsSync(path.join(abs, STATE_DIRNAME, e.name, BRIEF_FILENAME))).length;
      } catch { return 0; }
    })();
  } else if (kind === 'projects') {
    contains.hasBrief = existsSync(path.join(abs, BRIEF_FILENAME));
    contains.scopes = top.filter((n) => n !== FOUNDATIONS_DIRNAME).length;
  } else {
    contains.machines = top.length;
  }
  return { bytes, files, approximate: capped, contains };
}

async function readDisplayName(abs) {
  try {
    const st = await lstat(path.join(abs, 'CLAUDE.md'));
    if (!st.isFile() || st.size > 256 * 1024) return null;
    const m = /^# Domain: (.+)$/m.exec(await readFile(path.join(abs, 'CLAUDE.md'), 'utf8'));
    return m ? m[1].trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Destinations
// ─────────────────────────────────────────────────────────────────────────

/** The on-screen path an origin restores to (relative to the domains folder). */
export function restorePathLabel(kind, o, name) {
  if (kind === 'domains') return `domains/${name}/`;
  if (kind === 'projects') return `domains/${o.domain}/${STATE_DIRNAME}/${name}/`;
  const prefix = o.project === o.domain ? '' : `${o.project}/`;
  return `domains/${o.domain}/${STATE_DIRNAME}/${prefix}${name}/`;
}

/** The name an origin restores under by default. */
function originName(kind, o) {
  return kind === 'domains' ? o.domain : kind === 'projects' ? o.project : o.scope;
}

/**
 * Validate `name` for `kind` and resolve its absolute destination, or a
 * refusal. Does NOT check existence or the parent.
 */
function destinationFor(kind, o, name) {
  if (kind === 'domains') {
    if (!isUsableDomainSlug(name)) return { ok: false, reason: 'invalid-name', message: `"${name}" is not a usable domain folder name.` };
    return { ok: true, abs: domainPath(name) };
  }
  if (!isSafeSegment(name)) {
    return {
      ok: false, reason: 'invalid-name',
      message: `"${name}" is not a usable ${KIND_NOUN[kind]} name. Use letters, digits, dot, hyphen or underscore, up to 64 characters.`,
    };
  }
  if (kind === 'projects') {
    const prefix = projectPrefix(o.domain, name);
    if (prefix === null || prefix === '') {
      return {
        ok: false, reason: 'invalid-name',
        message: prefix === '' ? `"${name}" is the domain's own project, whose folder is the state folder itself. Choose another name.`
          : `"${name}" is a reserved name inside a state folder. Choose another name.`,
      };
    }
    const abs = resolveInsideState(o.domain, name);
    return abs ? { ok: true, abs } : { ok: false, reason: 'unsafe-path', message: 'Refusing to restore outside the state folder.' };
  }
  if (name.toLowerCase() === FOUNDATIONS_DIRNAME) {
    return { ok: false, reason: 'invalid-name', message: `"${name}" is a project's documents folder, not a handoff name. Choose another name.` };
  }
  const prefix = projectPrefix(o.domain, o.project);
  if (prefix === null) return { ok: false, reason: 'invalid-name', message: `"${o.project}" is not a usable project name.` };
  const abs = resolveInsideState(o.domain, `${prefix}${name}`);
  return abs ? { ok: true, abs } : { ok: false, reason: 'unsafe-path', message: 'Refusing to restore outside the state folder.' };
}

async function exists(abs) {
  try { await lstat(abs); return true; } catch { return false; }
}

/** The first `<name>-restored[-n]` that is free, or null. */
async function suggestFreeName(kind, o, name) {
  for (let i = 1; i <= 50; i++) {
    const cand = `${name}${RESTORED_SUFFIX}${i === 1 ? '' : '-' + i}`;
    const d = destinationFor(kind, o, cand);
    if (!d.ok) return null;
    if (!(await exists(d.abs))) return cand;
  }
  return null;
}

/**
 * Is the parent there, and writable? `{ ok: true }` or a refusal.
 * Shared by the listing (to say so before the press) and the restore.
 */
async function checkParent(kind, o, liveDomains) {
  if (kind === 'domains') {
    const dir = getDomainsDir();
    try {
      if ((await lstat(dir)).isDirectory()) return { ok: true };
    } catch { /* fall through */ }
    return { ok: false, reason: 'no-parent', message: `The domains folder is not there (${dir}). Is its drive connected?` };
  }
  if (!liveDomains.includes(o.domain)) {
    return {
      ok: false, reason: 'no-parent',
      message: `The domain "${o.domain}" no longer exists. Restore the domain first, then this ${KIND_NOUN[kind]}.`,
    };
  }
  if (await isDomainReadonly(o.domain)) {
    return { ok: false, reason: 'readonly', message: `"${o.domain}" is a read-only Shared Brain mirror. Nothing can be restored into it.` };
  }
  if (kind === 'scopes' && o.project !== o.domain) {
    const pAbs = resolveInsideState(o.domain, o.project);
    let isDir = false;
    try { isDir = !!pAbs && (await lstat(pAbs)).isDirectory(); } catch { isDir = false; }
    if (!isDir) {
      return {
        ok: false, reason: 'no-parent',
        message: `The project "${o.project}" in "${o.domain}" no longer exists. Restore the project first, then this handoff.`,
      };
    }
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// Listing
// ─────────────────────────────────────────────────────────────────────────

/** Real directories directly under one kind's folder (symlinks excluded). */
async function entryIds(kind) {
  const dir = path.join(getTrashDir(), kind);
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.')).map((e) => e.name);
}

async function describe(kind, id, liveDomains) {
  const abs = path.join(getTrashDir(), kind, id);
  const r = await resolveOrigin(kind, id, abs, liveDomains);
  const walk = await walkEntry(kind, abs);
  const entry = {
    kind, noun: KIND_NOUN[kind], id,
    deletedAt: r.deletedAt,
    name: r.origin ? originName(kind, r.origin) : null,
    domain: r.origin ? r.origin.domain : null,
    project: r.origin && r.origin.project ? r.origin.project : null,
    scope: r.origin && r.origin.scope ? r.origin.scope : null,
    isDefaultProject: !!(r.origin && kind === 'scopes' && r.origin.project === r.origin.domain),
    originFrom: r.origin ? r.originFrom : null,
    displayName: kind === 'domains' ? await readDisplayName(abs) : null,
    ...walk,
    restoreTo: null,
    status: 'ready',
    message: null,
    suggestedName: null,
  };
  if (!r.origin) {
    entry.status = 'unknown-origin';
    entry.message = 'Where this came from cannot be read from its folder name, so it cannot be restored from here. '
      + 'Move it back by hand (see the user guide, Trash).';
    return entry;
  }
  entry.restoreTo = restorePathLabel(kind, r.origin, entry.name);
  const parent = await checkParent(kind, r.origin, liveDomains);
  if (!parent.ok) {
    entry.status = parent.reason;
    entry.message = parent.message;
    return entry;
  }
  const d = destinationFor(kind, r.origin, entry.name);
  if (d.ok && await exists(d.abs)) {
    entry.status = 'exists';
    entry.suggestedName = await suggestFreeName(kind, r.origin, entry.name);
    entry.message = `A ${KIND_NOUN[kind]} named "${entry.name}" exists there now. Nothing is ever restored over it`
      + (entry.suggestedName ? `; restore this one as "${entry.suggestedName}" instead.` : '.');
  }
  return entry;
}

/**
 * Everything in the trash, newest first. Never throws.
 * @returns {Promise<{ok:true, trashDir:string, entries:object[]}>}
 */
export async function listTrash() {
  let liveDomains;
  try { liveDomains = await listDomains(); } catch { liveDomains = []; }
  const entries = [];
  for (const kind of TRASH_KINDS) {
    for (const id of await entryIds(kind)) {
      try { entries.push(await describe(kind, id, liveDomains)); } catch { /* one unreadable entry never hides the rest */ }
    }
  }
  entries.sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')) || a.id.localeCompare(b.id));
  return { ok: true, trashDir: getTrashDir(), entries };
}

/** Find one entry by (kind, id) against the ACTUAL listing, or a refusal. */
async function findEntry(kind, id) {
  if (!TRASH_KINDS.includes(kind)) return { ok: false, reason: 'invalid-kind', message: `"${kind}" is not a kind of trash entry.` };
  if (typeof id !== 'string' || !(await entryIds(kind)).includes(id)) {
    return { ok: false, reason: 'not-found', message: `Nothing called "${id}" is in the trash's ${kind} folder.` };
  }
  return { ok: true, abs: path.join(getTrashDir(), kind, id) };
}

/** The domain a restore of this entry writes into — for the route's registry check. */
export async function trashEntryDomain(kind, id) {
  const f = await findEntry(kind, id);
  if (!f.ok) return null;
  let liveDomains;
  try { liveDomains = await listDomains(); } catch { liveDomains = []; }
  const r = await resolveOrigin(kind, id, f.abs, liveDomains);
  return r.origin ? r.origin.domain : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Restore
// ─────────────────────────────────────────────────────────────────────────

/**
 * Put one trash entry back where it came from.
 *
 * `opts.as` — restore under THIS name instead (the "restore as
 * <name>-restored" alternative). Never implied: a destination that exists is
 * refused unless the caller names a free one.
 *
 * @returns {Promise<{ok:true, kind, id, name, domain, project, scope,
 *   restoredTo, renamed} | {ok:false, reason, message, suggestedName?}>}
 */
export async function restoreFromTrash(kind, id, opts = {}) {
  const f = await findEntry(kind, id);
  if (!f.ok) return f;
  let liveDomains;
  try { liveDomains = await listDomains(); } catch { liveDomains = []; }
  const r = await resolveOrigin(kind, id, f.abs, liveDomains);
  if (!r.origin) {
    return {
      ok: false, reason: 'unknown-origin',
      message: 'Where this came from cannot be read from its folder name. Nothing was restored; move it back by hand.',
    };
  }
  const o = r.origin;
  const original = originName(kind, o);
  const wantAs = opts && typeof opts.as === 'string' && opts.as !== '';
  const name = wantAs ? opts.as : original;
  if (kind === 'domains' && wantAs && name !== original) {
    try { assertNotReservedDomainSlug(name); } catch (err) {
      return { ok: false, reason: 'invalid-name', message: err.message };
    }
  }
  const d = destinationFor(kind, o, name);
  if (!d.ok) return d;
  const parent = await checkParent(kind, o, liveDomains);
  if (!parent.ok) return parent;

  const refuseExists = async () => {
    const suggestedName = await suggestFreeName(kind, o, name);
    return {
      ok: false, reason: 'exists', suggestedName,
      message: `A ${KIND_NOUN[kind]} named "${name}" already exists at ${restorePathLabel(kind, o, name)}. `
        + 'Nothing was restored, and nothing there was touched.'
        + (suggestedName ? ` Restore it as "${suggestedName}" instead.` : ''),
    };
  };

  if (kind === 'domains') {
    if (await exists(d.abs)) return refuseExists();
    try {
      await __moveDirectory(f.abs, d.abs);
    } catch (err) {
      if (err && (err.code === 'EEXIST' || err.code === 'ENOTEMPTY')) return refuseExists();
      return { ok: false, reason: 'io', message: `Could not restore: ${err && err.message ? err.message : err}` };
    }
    // A domain restored under a NEW folder name: its conversations name their
    // domain, and its CLAUDE.md / index / log headers name it for people —
    // renameDomain's same-slug path rewrites exactly those, and the display
    // name gains "(restored)" so two domains do not read the same in every list.
    if (name !== original) {
      const display = (await readDisplayName(d.abs)) || original;
      try { await renameDomain(name, name, `${display} (restored)`); } catch { /* the folder is back; labels are cosmetic */ }
    }
  } else {
    const release = await acquireFileLock(domainPath(o.domain), { op: 'restore-from-trash' });
    if (!release) {
      return { ok: false, reason: 'locked', message: `Another write is in progress on "${o.domain}". Nothing was restored.` };
    }
    try {
      if (await exists(d.abs)) return await refuseExists();
      await mkdir(path.dirname(d.abs), { recursive: true });
      // The state root itself may be absent on a domain whose last project
      // went to the trash; it is the domain's own folder to create.
      if (!existsSync(stateRoot(o.domain))) await mkdir(stateRoot(o.domain), { recursive: true });
      try {
        await __moveDirectory(f.abs, d.abs);
      } catch (err) {
        if (err && (err.code === 'EEXIST' || err.code === 'ENOTEMPTY')) return await refuseExists();
        return { ok: false, reason: 'io', message: `Could not restore: ${err && err.message ? err.message : err}` };
      }
    } finally {
      await release();
    }
  }
  try { await rm(originRecordPath(f.abs), { force: true }); } catch { /* best-effort */ }
  return {
    ok: true, kind, id, name,
    domain: kind === 'domains' ? name : o.domain,
    project: kind === 'domains' ? null : (kind === 'projects' ? name : o.project),
    scope: kind === 'scopes' ? name : null,
    restoredTo: restorePathLabel(kind, o, name),
    renamed: name !== original,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Delete forever
// ─────────────────────────────────────────────────────────────────────────

/**
 * PERMANENTLY delete one trash entry. `opts.confirm` must equal the entry's
 * own name (its domain, project or handoff name — or, for an entry whose
 * origin cannot be read, its full folder name), exactly: no trim, no case
 * folding. This is the only erase in the app.
 */
export async function emptyTrashItem(kind, id, opts = {}) {
  const f = await findEntry(kind, id);
  if (!f.ok) return f;
  let liveDomains;
  try { liveDomains = await listDomains(); } catch { liveDomains = []; }
  const r = await resolveOrigin(kind, id, f.abs, liveDomains);
  const word = r.origin ? originName(kind, r.origin) : id;
  if (!opts || typeof opts.confirm !== 'string' || opts.confirm !== word) {
    return {
      ok: false, reason: 'confirm-required', expected: word,
      message: `Deleting this forever cannot be undone. Type "${word}" to confirm.`,
    };
  }
  const walk = await walkEntry(kind, f.abs);
  try {
    await rm(f.abs, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, reason: 'io', message: `Could not delete: ${err && err.message ? err.message : err}` };
  }
  try { await rm(originRecordPath(f.abs), { force: true }); } catch { /* best-effort */ }
  return { ok: true, kind, id, name: word, files: walk.files, bytes: walk.bytes };
}
