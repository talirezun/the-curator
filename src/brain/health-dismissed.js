/**
 * Health dismissal store — v2.5.1
 *
 * Persists user "skip / not-a-duplicate / leave-alone" decisions across Health
 * scans so the same false positives don't re-surface every time. Stored per
 * domain at `<wiki>/.health-dismissed.jsonl` so it gets git-tracked and synced
 * across machines via the existing GitHub sync (the wiki/ folder is already
 * tracked; sibling files like raw/ are gitignored, but our file lives INSIDE
 * wiki/ so it travels with the rest of the wiki).
 *
 * Format: one JSON object per line:
 *   {"type":"semanticDupe","slugs":["e-mail","email"],"folder":"entities","dismissedAt":"2026-04-26T14:32Z"}
 *
 * The line-oriented format is git-merge-friendly — concurrent dismissals on
 * different machines append cleanly. Order-insensitive identities (semantic
 * pairs, hyphen-variant groups) are stored alphabetically so the same logical
 * dismissal always produces the same canonical key.
 */

import { existsSync } from 'fs';
import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import path from 'path';
import { wikiPath } from './files.js';

const DISMISSED_FILENAME = '.health-dismissed.jsonl';

function dismissedFilePath(domain) {
  return path.join(wikiPath(domain), DISMISSED_FILENAME);
}

/**
 * Build a canonical, deterministic key from an issue object.
 *
 * The key is what we look up against the dismissed-set during a scan. Two
 * dismissals describing the same logical issue MUST produce the same key,
 * even if their fields are presented in different order (semantic-dupe pair
 * order, hyphen-variant list order).
 *
 * Returns null if `type` is unknown — caller should treat that as "cannot
 * dismiss this kind of issue" rather than crashing.
 */
export function keyForIssue(type, issue) {
  if (!issue || typeof issue !== 'object') return null;
  switch (type) {
    case 'brokenLinks':
      // Identity = the broken link in this exact source file.
      return `brokenLinks|${issue.sourceFile}|${issue.linkText}`;

    case 'folderPrefixLinks':
      return `folderPrefixLinks|${issue.sourceFile}|${issue.linkText}`;

    case 'orphans':
      // path is "entities/foo.md" — already canonical
      return `orphans|${issue.path || (issue.type ? `${issue.type === 'entity' ? 'entities' : 'concepts'}/${issue.slug}.md` : issue.slug)}`;

    case 'crossFolderDupes':
      // keep + remove are folder-prefixed, so order is naturally determined
      return `crossFolderDupes|${issue.keep}|${issue.remove}`;

    case 'hyphenVariants': {
      const sortedFiles = Array.isArray(issue.files) ? [...issue.files].sort() : [];
      return `hyphenVariants|${sortedFiles.join(',')}|${issue.suggestedSlug || ''}`;
    }

    case 'missingBacklinks':
      return `missingBacklinks|${issue.summary}|${issue.entity}`;

    case 'semanticDupe': {
      // Pair is order-independent — sort the two folder/slug pairs.
      const a = `${issue.folderA}/${issue.slugA}`;
      const b = `${issue.folderB}/${issue.slugB}`;
      const [first, second] = [a, b].sort();
      return `semanticDupe|${first}|${second}`;
    }

    default:
      return null;
  }
}

/**
 * Read the JSONL file and return the parsed records. Tolerant of malformed
 * lines (skips them). Returns `[]` if the file doesn't exist.
 */
async function readRecords(domain) {
  const file = dismissedFilePath(domain);
  if (!existsSync(file)) return [];
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch { return []; }
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && obj.type) records.push(obj);
    } catch { /* skip malformed line */ }
  }
  return records;
}

/**
 * Serialise records back to the JSONL file. Used by remove + prune paths.
 * Adds entirely new records via append (separate path) to avoid rewriting
 * the whole file every dismissal.
 */
async function writeRecords(domain, records) {
  const file = dismissedFilePath(domain);
  await mkdir(path.dirname(file), { recursive: true });
  const lines = records.map(r => JSON.stringify(r)).join('\n');
  await writeFile(file, lines + (lines ? '\n' : ''), 'utf8');
}

/**
 * Walk the wiki and collect the slug + file inventory used for stale-record
 * pruning. Returns lookup sets so the caller can ask "does this slug/file
 * still exist?" without re-walking on every check.
 */
async function buildInventory(domain) {
  const wikiDir = wikiPath(domain);

  const list = async (dir) => {
    try { return (await readdir(dir)).filter(f => f.endsWith('.md')); }
    catch { return []; }
  };

  const entityFiles  = await list(path.join(wikiDir, 'entities'));
  const conceptFiles = await list(path.join(wikiDir, 'concepts'));
  const summaryFiles = await list(path.join(wikiDir, 'summaries'));

  const filesByRel = new Set();
  for (const f of entityFiles)  filesByRel.add(`entities/${f}`);
  for (const f of conceptFiles) filesByRel.add(`concepts/${f}`);
  for (const f of summaryFiles) filesByRel.add(`summaries/${f}`);

  const slugsByFolder = {
    entities: new Set(entityFiles.map(f => f.slice(0, -3))),
    concepts: new Set(conceptFiles.map(f => f.slice(0, -3))),
    summaries: new Set(summaryFiles.map(f => f.slice(0, -3))),
  };

  return { filesByRel, slugsByFolder };
}

/**
 * Determine whether a dismissal record still references things that exist in
 * the wiki. Returns true if the record is still live; false if any referenced
 * file/slug is gone (in which case the record should be pruned).
 *
 * Conservative: a record is kept if we can't confidently say it's stale, so
 * unknown types or malformed payloads stay in the file rather than being
 * silently dropped.
 */
function isRecordLive(record, inventory) {
  const { filesByRel, slugsByFolder } = inventory;
  switch (record.type) {
    case 'brokenLinks':
    case 'folderPrefixLinks':
      // Source must still exist; we don't try to confirm the link is still
      // present in the file (that's what the next scan would tell us anyway).
      return filesByRel.has(record.sourceFile);

    case 'orphans': {
      // record.path = "entities/foo.md" or "concepts/foo.md"
      const p = record.path || (record.slug && record.type ? `${record.type === 'entity' ? 'entities' : 'concepts'}/${record.slug}.md` : null);
      return p ? filesByRel.has(p) : false;
    }

    case 'crossFolderDupes':
      return filesByRel.has(record.keep) && filesByRel.has(record.remove);

    case 'hyphenVariants': {
      if (!Array.isArray(record.files)) return false;
      // Keep only if at least 2 of the variant files still exist (else there's
      // no longer a duplicate to dismiss).
      let alive = 0;
      for (const stem of record.files) {
        if (filesByRel.has(`entities/${stem}.md`)) alive++;
      }
      return alive >= 2;
    }

    case 'missingBacklinks':
      return filesByRel.has(record.summary) && filesByRel.has(record.entity);

    case 'semanticDupe': {
      const slugs = Array.isArray(record.slugs) ? record.slugs : null;
      if (!slugs || slugs.length !== 2) return false;
      const folder = record.folder;
      // Either both slugs in the recorded folder, or split — record covers both
      // shapes by checking presence in any folder. Cross-folder dupes use a
      // different type, so semanticDupe pairs are normally same-folder.
      const a = slugs[0], b = slugs[1];
      const folders = folder ? [folder] : ['entities', 'concepts'];
      const has = (slug) => folders.some(f => slugsByFolder[f]?.has(slug));
      return has(a) && has(b);
    }

    default:
      return true; // unknown future type — leave it alone
  }
}

/**
 * Load all live dismissal records for a domain. Stale records (referenced
 * files/slugs no longer exist) are silently dropped and the file is rewritten
 * if anything changed.
 *
 * Returns:
 *   {
 *     records: [...],          // live records (objects, parsed from JSONL)
 *     keys:    Set<string>,    // canonical keys for fast membership lookup
 *   }
 */
export async function loadDismissed(domain) {
  const all = await readRecords(domain);
  if (all.length === 0) return { records: [], keys: new Set() };

  const inventory = await buildInventory(domain);
  const live = [];
  let pruned = 0;
  for (const r of all) {
    if (isRecordLive(r, inventory)) live.push(r);
    else pruned++;
  }

  if (pruned > 0) {
    await writeRecords(domain, live);
  }

  const keys = new Set();
  for (const r of live) {
    const issue = recordToIssue(r);
    const key = keyForIssue(r.type, issue);
    if (key) keys.add(key);
  }
  return { records: live, keys };
}

/**
 * Lift a stored record back into the issue shape that scanWiki/scan APIs
 * use. This is the inverse of `issueToRecord` and lets keyForIssue produce
 * the same key for both stored records and freshly-scanned issues.
 */
function recordToIssue(record) {
  switch (record.type) {
    case 'semanticDupe': {
      const [slugA, slugB] = record.slugs || [];
      return {
        slugA, slugB,
        folderA: record.folderA || record.folder || 'entities',
        folderB: record.folderB || record.folder || 'entities',
      };
    }
    default:
      // Other types store the issue fields verbatim alongside `type` and
      // `dismissedAt`, so the record itself doubles as the issue object.
      return record;
  }
}

/**
 * Convert an issue + type into a stored record. Captures all fields needed
 * to (a) regenerate the canonical key on load, and (b) decide if the record
 * is still live during prune.
 */
function issueToRecord(type, issue) {
  const dismissedAt = new Date().toISOString();
  switch (type) {
    case 'semanticDupe': {
      const a = `${issue.folderA}/${issue.slugA}`;
      const b = `${issue.folderB}/${issue.slugB}`;
      const [first, second] = [a, b].sort();
      const [folderA, slugA] = first.split('/');
      const [folderB, slugB] = second.split('/');
      // Slugs alphabetised via the folder/slug join. Convenience field
      // `slugs` carries them in the same order for the prune check.
      return {
        type,
        slugs: [slugA, slugB],
        folderA, folderB,
        // legacy alias kept for human inspection of the JSONL file
        folder: folderA === folderB ? folderA : 'mixed',
        dismissedAt,
      };
    }
    case 'orphans':
      return { type, path: issue.path, slug: issue.slug, entityType: issue.type, dismissedAt };
    case 'brokenLinks':
      return { type, sourceFile: issue.sourceFile, linkText: issue.linkText, suggestedTarget: issue.suggestedTarget || null, dismissedAt };
    case 'folderPrefixLinks':
      return { type, sourceFile: issue.sourceFile, linkText: issue.linkText, dismissedAt };
    case 'crossFolderDupes':
      return { type, keep: issue.keep, remove: issue.remove, dismissedAt };
    case 'hyphenVariants':
      return { type, files: [...(issue.files || [])].sort(), suggestedSlug: issue.suggestedSlug, dismissedAt };
    case 'missingBacklinks':
      return { type, summary: issue.summary, entity: issue.entity, summarySlug: issue.summarySlug, dismissedAt };
    default:
      return null;
  }
}

/**
 * Append a dismissal record. No-op if the same canonical key is already
 * stored — protects against double-clicks and concurrent UI rapid-fire.
 */
export async function addDismissal(domain, type, issue) {
  const record = issueToRecord(type, issue);
  if (!record) return { ok: false, reason: `Cannot dismiss type: ${type}` };

  const key = keyForIssue(type, recordToIssue(record));
  if (!key) return { ok: false, reason: 'Could not derive key' };

  const { records } = await loadDismissed(domain);
  const existingKey = records.some(r => keyForIssue(r.type, recordToIssue(r)) === key);
  if (existingKey) return { ok: true, alreadyDismissed: true };

  records.push(record);
  await writeRecords(domain, records);
  return { ok: true, key };
}

/**
 * Remove a dismissal record (un-dismiss). Identifies the record by canonical
 * key so the caller can pass either the original issue object or a record.
 */
export async function removeDismissal(domain, type, issue) {
  const targetKey = keyForIssue(type, issue);
  if (!targetKey) return { ok: false, reason: 'Could not derive key' };

  const { records } = await loadDismissed(domain);
  const filtered = records.filter(r => keyForIssue(r.type, recordToIssue(r)) !== targetKey);
  if (filtered.length === records.length) return { ok: true, notFound: true };

  await writeRecords(domain, filtered);
  return { ok: true, removed: records.length - filtered.length };
}

/**
 * Return the full list of live dismissal records for the UI's Dismissed
 * section. Each entry includes its canonical key so the UI can pass it
 * back on un-dismiss.
 */
export async function listDismissed(domain) {
  const { records } = await loadDismissed(domain);
  return records.map(r => ({
    ...r,
    key: keyForIssue(r.type, recordToIssue(r)),
  }));
}

/**
 * Filter an array of issues against the dismissed-keys set. Returns
 *   { kept: [...], dismissed: count }
 * so callers can both narrow the list AND report how many were filtered.
 */
export function filterDismissed(issues, type, dismissedKeys) {
  if (!Array.isArray(issues) || issues.length === 0) return { kept: [], dismissed: 0 };
  if (!dismissedKeys || dismissedKeys.size === 0) return { kept: issues, dismissed: 0 };
  const kept = [];
  let dismissed = 0;
  for (const issue of issues) {
    const key = keyForIssue(type, issue);
    if (key && dismissedKeys.has(key)) dismissed++;
    else kept.push(issue);
  }
  return { kept, dismissed };
}
