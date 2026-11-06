/**
 * src/brain/recent-new-pages.js — which pages recent ingests created.
 *
 * WHY. Ingest never folds anything beyond a spelling variant; it asks afterwards. On
 * a wiki with tens of thousands of old candidate pairs, a duplicate scan would not
 * reach a new page's pairs for a long time, so the plan above
 * findSemanticCandidatePairs (planSemanticScan) puts pairs touching these pages first.
 *
 * ONLY AN ORDER. One JSON file per domain at paths.js getRecentNewPagesDir(), in the
 * user-data dir, OUTSIDE domains/, so it is never synced and the wiki gains no write.
 * A missing or corrupt file reads as empty, and the scan then uses the order it always
 * had. Nothing here throws. It holds names only, oldest first, at most
 * RECENT_NEW_PAGES_CAP of them, and only for this computer: a page created on another
 * computer and synced here is not recorded.
 *
 * A PAGE THAT IS GONE. The scan's plan and the counts read the live candidate list, so
 * a deleted or merged page stops counting at once, however it went (the app, a repair
 * script, Obsidian). Its name leaves the file at the next ingest or scan.
 *
 * Reachable from mcp/: nothing here may write to stdout.
 */
import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getRecentNewPagesDir } from './paths.js';
import { writeFileAtomic } from './atomic-write.js';
import { isMergeableSlug } from './duplicate-checks.js';

const FORMAT = 1;

/**
 * Bigger than a large batch of ordinary ingests (about 10 new pages each on the one
 * domain measured, June to October) and small enough that the file stays a few tens
 * of KB. Past it the oldest names drop, and their pairs return to the scan's ordinary
 * order.
 */
export const RECENT_NEW_PAGES_CAP = 2000;

function fileFor(domain) {
  const name = encodeURIComponent(String(domain));
  if (!name || name === '.' || name === '..') return null;
  return path.join(getRecentNewPagesDir(), name + '.json');
}

/** 'concepts/x' or 'entities/x' with a name the scan can use. Summaries are never candidates. */
function isPageKey(key) {
  if (typeof key !== 'string') return false;
  const at = key.indexOf('/');
  if (at < 0) return false;
  const folder = key.slice(0, at);
  return (folder === 'concepts' || folder === 'entities') && isMergeableSlug(key.slice(at + 1));
}

async function readList(domain) {
  const file = fileFor(domain);
  if (!file) return [];
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || parsed.format !== FORMAT || !Array.isArray(parsed.pages)) return [];
    return parsed.pages.filter(isPageKey).slice(-RECENT_NEW_PAGES_CAP);
  } catch {
    return [];
  }
}

async function writeList(domain, list) {
  const file = fileFor(domain);
  if (!file) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify({ format: FORMAT, pages: list }) + '\n');
  return true;
}

/** The pages a change list says were created, as 'concepts/slug'. index.md and summaries are left out. */
export function createdPageKeys(changes) {
  if (!Array.isArray(changes)) return [];
  const keys = new Set();
  for (const c of changes) {
    if (!c || c.status !== 'created' || typeof c.canonPath !== 'string') continue;
    const key = c.canonPath.replace(/\.md$/, '');
    if (isPageKey(key)) keys.add(key);
  }
  return [...keys];
}

/** The recorded pages as a Set. A missing or bad file is an empty Set. */
export async function loadRecentNewPages(domain) {
  return new Set(await readList(domain));
}

/**
 * Add pages, newest last, dropping any that no longer exist and the oldest beyond the
 * cap. Re-reads first, so a concurrent writer loses at most its own last few names,
 * which costs only their place in the order. Never throws. Returns whether it saved.
 */
export async function recordRecentNewPages(domain, pageKeys, wikiDir) {
  const incoming = (Array.isArray(pageKeys) ? pageKeys : []).filter(isPageKey);
  if (incoming.length === 0) return false;
  try {
    const fresh = new Set(incoming);
    const kept = (await readList(domain)).filter((k) => !fresh.has(k) && existsSync(path.join(wikiDir, k + '.md')));
    return await writeList(domain, [...kept, ...fresh].slice(-RECENT_NEW_PAGES_CAP));
  } catch (err) {
    process.stderr.write(`[recent-new-pages] could not save ${domain}: ${err && err.message}\n`);
    return false;
  }
}

/** Remove names whose page has gone. Writes only when something changed. Never throws. */
export async function pruneRecentNewPages(domain, wikiDir) {
  try {
    const list = await readList(domain);
    const kept = list.filter((k) => existsSync(path.join(wikiDir, k + '.md')));
    if (kept.length === list.length) return false;
    return await writeList(domain, kept);
  } catch (err) {
    process.stderr.write(`[recent-new-pages] could not tidy ${domain}: ${err && err.message}\n`);
    return false;
  }
}
