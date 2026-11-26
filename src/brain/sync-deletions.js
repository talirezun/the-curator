/**
 * sync-deletions.js — the Sync deletion guard's pure half (v4.2.1).
 *
 * THE OWNER'S GOAL: the GitHub backup can never be silently emptied. The
 * worst case is one question the person can answer no to.
 *
 * WHY IT IS NEEDED. Sync stages with `git add -A`, so a page missing from the
 * knowledge folder is a page deleted from GitHub at the next push, and a pull
 * deletes the local pages another computer removed. The folder checks
 * (`curator.workTree`, `curator.workTreeReal`) catch a CHANGED folder; they
 * cannot catch the same path now holding other content (a swapped drive, the
 * v4.1.2 N3 legacy case, a cloud folder that has not downloaded). Counting what
 * a sync would delete catches every one of those by its effect.
 *
 * THIS FILE is arithmetic over lists that brain/sync.js reads from git: no git,
 * no file system, no network. sync.js owns when it runs and what it refuses.
 *
 * THE THRESHOLD (`isSignificant`). A deletion set asks first when ANY of:
 *   · more than 5 files;
 *   · a whole domain disappears (a top-level folder with a CLAUDE.md, which
 *     is what the app lists as a domain: every file it had goes, and nothing
 *     of it stays on the other side) — the shape of every incident on record;
 *   · at least 3 files AND more than 10% of the tracked files — a small
 *     knowledge base losing a big share of itself.
 * A person deleting a page or two never sees it (2 files is under every
 * rule). Our own hygiene files (.DS_Store, .write-lock, …) never count:
 * untracking them is the app's own repair, not a loss.
 *
 * THE TOKEN binds a confirmation to the exact deletion set: the direction,
 * and every path with the git object id of the content that would be lost
 * (the remote's copy for an outgoing deletion, this computer's for an
 * incoming one). A different set, or the same paths with other content,
 * gives another token, so a stale confirmation is refused and asked again.
 * HEAD is deliberately NOT part of it: Sync now's pull half makes its own
 * auto-save commit between the pull-side and push-side checks, and a token
 * bound to HEAD would ask the same question twice.
 */

import { createHash } from 'node:crypto';

export const DELETION_LIMITS = Object.freeze({ files: 5, shareMinFiles: 3, share: 0.10 });

export const DELETION_CODES = Object.freeze({
  out: 'sync-deletions-need-confirm',
  in: 'sync-pull-deletions-need-confirm',
});
export const isDeletionCode = (c) => c === DELETION_CODES.out || c === DELETION_CODES.in;

const TOKEN_PREFIX = { out: 'sdo-', in: 'sdi-' };
const TOKEN_RE = /^sd[oi]-[0-9a-f]{40}$/;
const SAMPLE_MAX = 20;
const LIST_MAX = 500;
const MAX_TOKENS = 8;

/** A wiki page: any `.md` under `<domain>/wiki/`, except that folder's index.md and log.md. */
export function isWikiPagePath(p) {
  const parts = String(p).split('/');
  if (parts.length < 3 || parts[1] !== 'wiki' || !p.endsWith('.md')) return false;
  return !(parts.length === 3 && (parts[2] === 'index.md' || parts[2] === 'log.md'));
}

const topOf = (p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '');
const isDomainTop = (t) => t !== '' && !t.startsWith('.');

/** The tokens a request carries: a string or an array, only well-formed ones, at most 8. */
export function confirmedTokens(v) {
  const list = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
  return [...new Set(list.filter((t) => typeof t === 'string' && TOKEN_RE.test(t)))].slice(0, MAX_TOKENS);
}

export function deletionToken(direction, entries) {
  const lines = entries.map(([p, oid]) => `${p}\0${oid || ''}`).sort();
  return TOKEN_PREFIX[direction] + createHash('sha256').update(`${direction}\n${lines.join('\n')}`).digest('hex').slice(0, 40);
}

export function isSignificant(count, total, wholeDomains) {
  if (count > DELETION_LIMITS.files) return true;
  if (wholeDomains > 0) return true;
  return count >= DELETION_LIMITS.shareMinFiles && total > 0 && count / total > DELETION_LIMITS.share;
}

/**
 * The deletion set, summarised.
 *   direction  'out' (deleted from GitHub) | 'in' (deleted on this computer)
 *   entries    [[path, oid]] — what goes, with the content id that is lost
 *   before     Map path→oid — the side that loses them (junk paths ignored)
 *   otherSide  Set or Map of the paths on the side that keeps going: a
 *              domain with anything there has not disappeared
 *   isJunk     (path) => boolean — our own hygiene files, never counted
 * Null when nothing is deleted.
 */
export function summarizeDeletions(direction, entries, before, otherSide, isJunk = () => false) {
  const kept = entries.filter(([p]) => !isJunk(p));
  if (!kept.length) return null;
  const perTop = new Map();
  let total = 0;
  for (const p of before.keys()) {
    if (isJunk(p)) continue;
    total++;
    const t = topOf(p);
    perTop.set(t, (perTop.get(t) || 0) + 1);
  }
  const otherTops = new Set();
  for (const p of otherSide.keys ? otherSide.keys() : otherSide) if (!isJunk(p)) otherTops.add(topOf(p));

  const groups = new Map();
  let pages = 0;
  for (const [p] of kept) {
    const t = topOf(p);
    const g = groups.get(t) || { domain: t, count: 0, pages: 0 };
    g.count++;
    if (isWikiPagePath(p)) { g.pages++; pages++; }
    groups.set(t, g);
  }
  const byDomain = [...groups.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  // A domain is what the app lists as one: a top-level folder with a
  // CLAUDE.md (the v2.3.4 ghost-domain rule). A loose folder is counted by
  // the file rules only.
  const wholeDomains = byDomain
    .filter((g) => isDomainTop(g.domain) && before.has(`${g.domain}/CLAUDE.md`)
      && g.count === (perTop.get(g.domain) || 0) && !otherTops.has(g.domain))
    .map((g) => g.domain);
  const paths = kept.map(([p]) => p).sort();
  return {
    direction,
    count: kept.length,
    pages,
    total,
    byDomain,
    wholeDomains,
    sample: paths.slice(0, SAMPLE_MAX),
    paths: paths.slice(0, LIST_MAX),
    significant: isSignificant(kept.length, total, wholeDomains.length),
    confirmToken: deletionToken(direction, kept),
  };
}

// ── The words ────────────────────────────────────────────────────────────
// One wording, used by the refusal's sentence (what the API, the rail's notice
// and the Context page show) and by the Sync page's confirm card.

/** "41 pages", "41 files", or "41 files (38 of them pages)". */
export function deletionWhat(s) {
  const n = s.count;
  if (s.pages === n) return `${n} page${n === 1 ? '' : 's'}`;
  if (!s.pages) return `${n} file${n === 1 ? '' : 's'}`;
  return `${n} files (${s.pages} of them page${s.pages === 1 ? '' : 's'})`;
}

/** "articles 38 · research 3", at most four names then "+N more". */
export function deletionDomains(s) {
  const named = s.byDomain.slice(0, 4).map((g) => `${g.domain || 'top level'} ${g.count}`);
  const rest = s.byDomain.length - named.length;
  return named.join(' · ') + (rest > 0 ? ` · +${rest} more` : '');
}

/** The card's headline sentence. */
export function deletionHeadline(s) {
  return s.direction === 'in'
    ? `This sync would delete ${deletionWhat(s)} on this computer that are no longer in your GitHub backup (${deletionDomains(s)}).`
    : `This sync would delete ${deletionWhat(s)} from your GitHub backup (${deletionDomains(s)}).`;
}

/** The refusal's sentence: shown wherever the card is not (the API, a notice on another page). */
export function deletionGuardMessage(s) {
  return `${deletionHeadline(s)} Sync stopped to ask first. Nothing was changed. ` +
    `If you didn’t delete ${s.count === 1 ? 'it' : 'these'} on purpose, do not confirm. Open Sync to see the list and decide.`;
}
