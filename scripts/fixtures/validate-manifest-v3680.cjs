/**
 * FROZEN — v3.68.0's foundations manifest validator, VERBATIM.
 *
 * Copied from tag v3.68.0 (commit 05fb1a1, tag object d06097e4f75d),
 * file src/brain/working-state.js, git blob 56cb5dcdc046b37ca8849ae9314a1a161749085f,
 * sha256 of that file 5bf0d62ae2e6cccff5127caef82b225baf63234b7e78729160ac3e5aef21577b.
 * Line ranges copied: 223, 229, 233-236, 281, 928, 955-956, 959-960, 965, 1015,
 * 1021-1022, 1045-1052, 1060-1065, 1197-1201, 1739-1745, 4823, 4825, 4828,
 * 4870-4874, 5003-5028, 5047-5049, 5052-5067, 5077-5193 — nothing else changed
 * except dropping `export` and adding the module.exports line at the end.
 *
 * WHAT IT IS FOR (CONTRACT v3.69.0 §2.4): scripts/test-foundations-sources.js
 * feeds it every manifest the v3.69.0 writer produces. A v2 manifest must be
 * REFUSED (ok:false — an older app never rewrites it); a v1 manifest must be
 * ACCEPTED, with the documents v3.68 would see. NEVER EDIT THIS FILE: it is
 * what is already deployed on machines that have not updated.
 */
'use strict';
const path = require('path'); // eslint-disable-line no-unused-vars
const FOUNDATIONS_MANIFEST_VERSION = 1;
const FOUNDATIONS_BUDGET_BYTES = 200 * 1024;
const MAX_FOUNDATIONS_PER_PROJECT = 200;
const FOUNDATION_ROLES = Object.freeze([
  'architecture', 'decisions', 'conventions', 'roadmap', 'api', 'guide', 'other',
]);
const MAX_FOUNDATION_TITLE_CHARS = 120;
const CONTROL_KEEP_WS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const INVISIBLE_RE =
  /[\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const PROTOCOL_TAG_RE =
  /<(\/?\s*)(antml:[a-z0-9_.:-]+|system-reminder|system|human|assistant|user|function_calls|function_results|invoke|tool_use|tool_result|parameter)\b/gi;
const ROLE_MARKER_RE = /^([ \t]*)(Human|Assistant|System|Claude)(\s*):/gim;
const URL_SCHEME_RE = /\b(https?|ftp|ftps|file)(:\/\/)/gi;
const SHELL_PIPE_RE =
  /\|(\s*(?:sudo\s+|env\s+|command\s+)*(?:sh|bash|zsh|ksh|dash|fish|csh|tcsh|python3?|perl|ruby|node|deno|pwsh|powershell)\b)/gi;
function neutraliseProtocol(text) {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  return defang(text
    .replace(CONTROL_KEEP_WS_RE, '')
    .replace(INVISIBLE_RE, '')
    .replace(PROTOCOL_TAG_RE, (_m, slash, name) => `&lt;${slash}${name}`)
    .replace(ROLE_MARKER_RE, (_m, indent, role, sp) => `${indent}${role}${sp}&#58;`));
}
function defang(text) {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  return text
    .replace(URL_SCHEME_RE, (_m, scheme, sep) => `${scheme}[:]${sep.slice(1)}`)
    .replace(SHELL_PIPE_RE, (_m, tail) => `&#124;${tail}`);
}
function isIsoish(s) {
  if (typeof s !== 'string' || !s || s.length > 40) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}
const PROVENANCE_VALUE_RE = /[^A-Za-z0-9._:+-]+/g;

function provenanceValue(v, max = 60) {
  if (typeof v !== 'string' || !v) return null;
  const s = v.replace(PROVENANCE_VALUE_RE, '-').replace(/^-+|-+$/g, '').slice(0, max);
  return s || null;
}
const FOUNDATION_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}\.md$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
function normaliseSha(h) {
  if (typeof h !== 'string') return null;
  const t = h.trim().toLowerCase();
  return SHA256_RE.test(t) ? t : null;
}
function normaliseAuthoredBy(a) {
  if (!a || typeof a !== 'object') return null;
  const raw = String(a.kind || '').toLowerCase();
  const kind = raw === 'human' ? 'human' : raw === 'agent' ? 'agent' : 'unknown';
  const commissioned = a.commissionedBy === 'owner' || a.instructedBy === 'user' ? 'owner' : null;
  return {
    kind,
    harness: provenanceValue(typeof a.harness === 'string' ? a.harness : null),
    model: provenanceValue(typeof a.model === 'string' ? a.model : null),
    commissionedBy: kind === 'agent' ? (commissioned || 'owner') : commissioned,
  };
}

/** A copied-from folder BASENAME, or null. Never a path, never a control char. */
function readCopiedFrom(v) {
  if (typeof v !== 'string') return null;
  const t = neutraliseProtocol(v.replace(/[\r\n\t]+/g, ' ')).trim();
  if (!t || /[\\/]/.test(t) || t.includes('\0')) return null;
  return t.slice(0, 120);
}

function readTitle(t) {
  return typeof t === 'string' && t.trim()
    ? neutraliseProtocol(t.replace(/[\r\n\t]+/g, ' ')).trim().slice(0, MAX_FOUNDATION_TITLE_CHARS)
    : null;
}
const REMOTE_OWNER_RE = /^[a-z0-9][a-z0-9-]{0,38}$/i;
const REMOTE_REPO_RE = /^[a-zA-Z0-9._-]{1,100}$/;
const REMOTE_REF_RE = /^[a-z0-9][a-z0-9._/-]{0,127}$/i;
function normaliseRemote(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const owner = typeof raw.owner === 'string' ? raw.owner.trim() : '';
  const repo = typeof raw.repo === 'string' ? raw.repo.trim().replace(/\.git$/i, '') : '';
  if (!REMOTE_OWNER_RE.test(owner) || !REMOTE_REPO_RE.test(repo)) return null;
  const refRaw = typeof raw.ref === 'string' ? raw.ref.trim() : '';
  const ref = refRaw && REMOTE_REF_RE.test(refRaw) && !refRaw.includes('..') ? refRaw : null;
  // An optional prefix INSIDE the repository that every mirrored source must
  // sit under — the remote arm's equivalent of the local arm's "outside the
  // repository root" refusal, and the reason a `..` or an absolute value is
  // dropped rather than stored.
  const pathRaw = typeof raw.path === 'string' ? raw.path.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '') : '';
  const prefix = pathRaw && !pathRaw.startsWith('/') && !pathRaw.split('/').includes('..')
    && !pathRaw.includes('\0') && pathRaw.length <= 300 ? pathRaw : null;
  return { owner, repo, ref, path: prefix };
}
function validateManifest(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'manifest is not a JSON object' };
  if (obj.version !== FOUNDATIONS_MANIFEST_VERSION) {
    return { ok: false, error: `manifest version ${JSON.stringify(obj.version)} is not ${FOUNDATIONS_MANIFEST_VERSION}` };
  }
  const ownership = obj.ownership === 'repo' || obj.ownership === 'curator' ? obj.ownership
    : obj.ownership === null || obj.ownership === undefined ? null : undefined;
  if (ownership === undefined) return { ok: false, error: `ownership ${JSON.stringify(obj.ownership)} is not "repo", "curator" or null` };
  let repo = null;
  if (obj.repo !== null && obj.repo !== undefined) {
    if (typeof obj.repo !== 'object' || Array.isArray(obj.repo)) return { ok: false, error: 'repo is not an object' };
    if (obj.repo.root !== null && obj.repo.root !== undefined && typeof obj.repo.root !== 'string') {
      return { ok: false, error: 'repo.root is not a string' };
    }
    repo = {
      root: typeof obj.repo.root === 'string' && obj.repo.root ? obj.repo.root : null,
      // ── `repo.remote`, FIRST WRITTEN IN v3.63.0 — still schema v1 ───────
      // The field has existed since v3.59.0 and was only ever carried through
      // or defaulted to null, typed as a string nothing populated. It is now
      // `{owner, repo, ref, path}` — the coordinates the GitHub mirror arm
      // fetches from — and a legacy STRING is PARSED as a git remote URL
      // rather than refused. That direction is deliberate: `remote` is
      // advisory, and a manifest made unreadable by an advisory field takes
      // the project's whole tier 0 with it (`present: false` on every read).
      // An unparseable value becomes null, which is exactly today's meaning.
      remote: normaliseRemote(obj.repo.remote),
      lastRefreshAt: isIsoish(obj.repo.lastRefreshAt) ? new Date(obj.repo.lastRefreshAt).toISOString() : null,
      lastRefreshCommit: typeof obj.repo.lastRefreshCommit === 'string' && GIT_SHA_RE.test(obj.repo.lastRefreshCommit)
        ? obj.repo.lastRefreshCommit : null,
    };
  }
  const budgetBytes = Number.isInteger(obj.budgetBytes) && obj.budgetBytes > 0 ? obj.budgetBytes : FOUNDATIONS_BUDGET_BYTES;
  if (obj.budgetBytes !== undefined && obj.budgetBytes !== budgetBytes) {
    return { ok: false, error: 'budgetBytes is not a positive integer' };
  }
  const order = Array.isArray(obj.order) && obj.order.every((r) => typeof r === 'string')
    ? obj.order.filter((r) => FOUNDATION_ROLES.includes(r))
    : obj.order === undefined ? [...FOUNDATION_ROLES] : null;
  if (order === null) return { ok: false, error: 'order is not an array of role names' };
  for (const r of FOUNDATION_ROLES) if (!order.includes(r)) order.push(r);   // every role has a rank
  if (!Array.isArray(obj.documents)) return { ok: false, error: 'documents is not an array' };
  if (obj.documents.length > MAX_FOUNDATIONS_PER_PROJECT) {
    return { ok: false, error: `documents holds ${obj.documents.length} entries, over the ${MAX_FOUNDATIONS_PER_PROJECT} cap` };
  }
  const seen = new Set();
  const documents = [];
  const notes = [];
  for (let i = 0; i < obj.documents.length; i++) {
    const d = obj.documents[i];
    const where = `documents[${i}]`;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, error: `${where} is not an object` };
    const slug = typeof d.slug === 'string' && FOUNDATION_SLUG_RE.test(d.slug) ? d.slug : null;
    if (!slug) return { ok: false, error: `${where}.slug ${JSON.stringify(String(d.slug).slice(0, 80))} is not a valid document slug` };
    if (seen.has(slug)) return { ok: false, error: `${where}.slug "${slug}" is listed twice` };
    seen.add(slug);
    if (!FOUNDATION_ROLES.includes(d.role)) return { ok: false, error: `${where}.role ${JSON.stringify(d.role)} is not a known role` };
    const kind = d.source && typeof d.source === 'object' ? d.source.kind : undefined;
    if (kind !== 'repo' && kind !== 'curator') return { ok: false, error: `${where}.source.kind must be "repo" or "curator"` };
    if (kind === 'repo' && (typeof d.source.path !== 'string' || !d.source.path)) {
      return { ok: false, error: `${where}.source.path is required for a repo source` };
    }
    if (ownership && ((kind === 'repo') !== (ownership === 'repo'))) {
      return { ok: false, error: `${where} is ${kind}-sourced inside a ${ownership}-owned project` };
    }
    const sha256 = normaliseSha(d.sha256);
    if (!sha256) return { ok: false, error: `${where}.sha256 is not a 64-hex digest` };
    if (!Number.isInteger(d.bytes) || d.bytes < 0) return { ok: false, error: `${where}.bytes is not a non-negative integer` };
    documents.push({
      slug,
      role: d.role,
      title: readTitle(d.title) || slug.replace(/\.md$/, ''),
      source: kind === 'repo' ? { kind, path: String(d.source.path).slice(0, 512) } : { kind },
      sha256,
      bytes: d.bytes,
      updatedAt: isIsoish(d.updatedAt) ? new Date(d.updatedAt).toISOString() : null,
      commit: typeof d.commit === 'string' && GIT_SHA_RE.test(d.commit) ? d.commit : null,
      authoredBy: normaliseAuthoredBy(d.authoredBy),
      // v3.61.0, schema still v1: an ADDITIVE optional boolean. A seeded
      // document is a PROMPT, not a fact, and every reader needs to know
      // that. Absent means false, and only the literal `true` counts — a
      // string from a hand edit is not evidence that a document is unfilled,
      // and the fail-safe direction is "treat it as written".
      skeleton: d.skeleton === true,
      // v3.62.0, schema STILL v1: a second ADDITIVE optional boolean, and the
      // owner's ROUTING instruction rather than a fact about the document.
      // `true` means "an agent must not start work here without this one", and
      // the bootstrap sends its body every session; absent or anything but the
      // literal `true` means false, i.e. "index only, fetch it by name when
      // the task calls for it". Same fail-safe direction as `skeleton`, for
      // the mirror-image reason: a string from a hand edit is not the owner
      // saying a document is required reading, and reading one document too
      // few costs a fetch while reading the whole set every session costs the
      // budget the flag exists to spend deliberately.
      readFirst: d.readFirst === true,
      // v3.67.0, schema STILL v1: the third per-document state, "not at
      // start". MUTUALLY EXCLUSIVE with `readFirst` and always present on the
      // parsed entry; only the literal `true` counts. A hand edit carrying
      // BOTH reads as read first — the fail-safe direction, more context and
      // never less — and the contradiction is named in `notes` rather than
      // resolved in silence. Written to disk only when true (`writeManifest`),
      // so a project nobody routes keeps byte-identical manifests.
      hidden: d.hidden === true && d.readFirst !== true,
      // v3.68.0, schema STILL v1: an ADDITIVE optional string. The BASENAME of
      // the folder a curator-kept document was COPIED from by "Add from this
      // computer" — provenance, so the table can say "copied" rather than
      // "written by you". A basename only (never a path: the manifest syncs).
      // Absent (every older manifest) reads as null, i.e. written here. Only
      // on a curator source; a save of new text clears it (saveFoundation
      // builds a fresh entry), because the owner then HAS written it.
      copiedFrom: kind === 'curator' ? readCopiedFrom(d.copiedFrom) : null,
    });
    if (d.hidden === true && d.readFirst === true) {
      notes.push(`${where} ("${slug}") is marked both read first and not at start; it reads as read first`);
    }
  }
  return { ok: true, manifest: { version: FOUNDATIONS_MANIFEST_VERSION, ownership, repo, budgetBytes, order, documents }, notes };
}

module.exports = { validateManifest, FOUNDATIONS_MANIFEST_VERSION };
