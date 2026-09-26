/**
 * src/brain/health-summary.js — the LAST Wiki health scan per domain, kept
 * across restarts (v3.77).
 *
 * WHY. Until v3.77 a domain's health mark lived only in the Domains view's
 * session state, so after every restart each domain the user had not opened
 * yet showed the hollow "Health not checked yet" ring — even one scanned an
 * hour earlier. The scan itself is free and local; what was lost was only the
 * fact that it had happened and what it found.
 *
 * WHAT IS KEPT, per slug: `{count, scannedAt, logMark}` in one JSON file at
 * paths.js getHealthSummaryPath() — in the user-data dir, OUTSIDE domains/,
 * never synced (see that resolver for why).
 *
 *   · `count`     — open issues across the six categories the Domains view
 *                   counts (HEALTH_ISSUE_KEYS, the view's HEALTH_CATEGORIES),
 *                   after dismissals, exactly as that scan reported them.
 *   · `scannedAt` — the report's own `scannedAt`: when the wiki was READ.
 *   · `logMark`   — the domain's wiki/log.md identity (mtime in ns + size)
 *                   at record time.
 *
 * STALE, HONESTLY. Every write path that changes a wiki's content through the
 * app — ingest, compile (app and MCP), a sync pull — also touches log.md, so
 * a log.md whose identity differs from the recorded one means the wiki
 * changed after the scan, and the summary is served with `stale: true`
 * ("checked before the wiki last changed"), never as a current count. The
 * limit, stated: an edit made OUTSIDE the app (Obsidian) that does not touch
 * log.md is not seen until the next scan. A full page-signature check would
 * see it, at ~30 ms per 3,000-page domain on a POLLED endpoint; the log mark
 * costs one stat per domain.
 *
 * Nothing here ever writes stdout.
 */
import { readFile, stat, mkdir } from 'fs/promises';
import path from 'path';
import { getHealthSummaryPath } from './paths.js';
import { writeFileAtomic } from './atomic-write.js';
import { wikiPath } from './files.js';

/** The six categories the Domains view sums (views/domains.js HEALTH_CATEGORIES). */
export const HEALTH_ISSUE_KEYS = Object.freeze([
  'brokenLinks', 'orphans', 'crossFolderDupes', 'hyphenVariants', 'folderPrefixLinks', 'missingBacklinks',
]);

export function countOpenIssues(report) {
  if (!report || typeof report !== 'object') return 0;
  let n = 0;
  for (const k of HEALTH_ISSUE_KEYS) n += Array.isArray(report[k]) ? report[k].length : 0;
  return n;
}

/** log.md's identity as a string, or null when there is no log. */
export async function wikiLogMark(domain) {
  try {
    const st = await stat(path.join(wikiPath(domain), 'log.md'), { bigint: true });
    return `${st.mtimeNs}:${st.size}`;
  } catch {
    return null;
  }
}

async function readAll() {
  try {
    const parsed = JSON.parse(await readFile(getHealthSummaryPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// One writer at a time in this process: a read-modify-write per call, chained,
// so two scans finishing together cannot drop each other's entry.
let chain = Promise.resolve();
function mutate(fn) {
  const run = chain.then(async () => {
    const all = await readAll();
    const changed = fn(all);
    if (!changed) return;
    const file = getHealthSummaryPath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(all, null, 2) + '\n');
  });
  chain = run.catch(() => {});
  return run;
}

const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

/** Record a finished scan. Never throws — a cache must not fail a scan. */
export async function recordHealthSummary(domain, report) {
  if (typeof domain !== 'string' || !SAFE_SLUG.test(domain) || !report) return;
  const scannedAt = typeof report.scannedAt === 'string' && Number.isFinite(Date.parse(report.scannedAt))
    ? report.scannedAt : new Date().toISOString();
  const logMark = await wikiLogMark(domain);
  try {
    await mutate((all) => {
      const prev = all[domain];
      // An older report (a scan cache hit carries its original scannedAt) never
      // overwrites a newer one.
      if (prev && Date.parse(prev.scannedAt) > Date.parse(scannedAt)) return false;
      all[domain] = { count: countOpenIssues(report), scannedAt, logMark };
      return true;
    });
  } catch (err) {
    process.stderr.write(`[health-summary] could not record ${domain}: ${err && err.message}\n`);
  }
}

/**
 * The served summary for each of `domains`: `{count, scannedAt, stale}`, or
 * absent (never scanned on this machine).
 */
export async function readHealthSummaries(domains) {
  const all = await readAll();
  const out = {};
  await Promise.all((domains || []).map(async (d) => {
    const e = all[d];
    if (!e || !Number.isInteger(e.count) || e.count < 0 || typeof e.scannedAt !== 'string') return;
    const mark = await wikiLogMark(d);
    out[d] = { count: e.count, scannedAt: e.scannedAt, stale: mark !== (e.logMark ?? null) };
  }));
  return out;
}

/** A deleted domain's summary goes with it (a new domain of that name starts unscanned). */
export function forgetHealthSummary(domain) {
  return mutate((all) => {
    if (!Object.prototype.hasOwnProperty.call(all, domain)) return false;
    delete all[domain];
    return true;
  }).catch(() => {});
}

/** A renamed domain keeps its summary under the new slug. */
export function renameHealthSummary(oldSlug, newSlug) {
  if (oldSlug === newSlug) return Promise.resolve();
  return mutate((all) => {
    if (!Object.prototype.hasOwnProperty.call(all, oldSlug)) return false;
    all[newSlug] = all[oldSlug];
    delete all[oldSlug];
    return true;
  }).catch(() => {});
}

export const __testing = { readAll };
