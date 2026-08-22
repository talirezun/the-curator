/**
 * Shared Brain — Push / Pull / Synthesis orchestration
 *
 * The brain layer for Shared Brain. The only module that combines:
 *   - filesystem reads from the contributor's wiki
 *   - the local LLM (via sharedbrain-delta)
 *   - the storage adapter (via sharedbrain-storage-factory)
 *   - persistent connection state (via sharedbrain-config)
 *
 * Phase 2B scope:
 *   - pushDomain()         — push one domain's deltas to the collective storage
 *   - findChangedPages()   — mtime + pending_retry union
 *   - getAllPagePaths()    — list page paths in a domain (for cross-domain
 *                            link filtering)
 *   - loadPriorContent()   — best-effort git lookup (returns null if .knowledge-git
 *                            isn't present — most users don't have it)
 *
 * Phase 2C will add pullCollective(); Phase 2E will add runLocalSynthesis().
 *
 * Decisions (binding per docs/shared-brain-design.md):
 *   - Decision 3: partial push on LLM failure, with pending_retry tracking.
 *     Pages that fail 3 consecutive times move to permanent_skip and the
 *     UI must surface them for manual review.
 *   - Decision 2: cross-domain links are stripped at delta-generation
 *     (the delta module handles this; we just pass `domainPagePaths`).
 *   - Spec Part 10 invariant 4: pushDomain refuses any domain not in
 *     `connection.local_domains`. Personal-domain isolation enforced
 *     before any LLM or storage call.
 *
 * Logging discipline:
 *   - All progress notifications via `onProgress(stage, message)` callback.
 *   - All diagnostics via console.error (this module is imported by mcp/*
 *     in Phase 4+; stdout reserved for MCP JSON-RPC stream).
 */

import { readFile, readdir, stat, mkdir, writeFile, lstat, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDomainsDir, __setDomainsDirOverride } from './config.js';
import { createStorageAdapter } from './sharedbrain-storage-factory.js';
import { generateDeltaSummary } from './sharedbrain-delta.js';
import { patchSharedBrain } from './sharedbrain-config.js';
import { writePage, syncSummaryEntities, appendLog } from './files.js';
import { getSyncGitDir } from './paths.js';

// execFile — NOT exec. Page paths come from readdir over a folder the user
// (or, via pull, a remote shared brain) controls; exec would interpolate
// them into a shell string where backticks/$() execute (v3.0.2).
const execFileAsync = promisify(execFile);

/** Retry attempt threshold beyond which a page is moved to permanent_skip. */
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * Transient-error markers (v3.0.2). A delta-generation failure whose
 * message matches one of these is a provider/network blip, NOT a problem with
 * the page — it must not count toward the MAX_RETRY_ATTEMPTS permanent-skip
 * strike counter. Matches the strings src/brain/llm.js surfaces (and the CI
 * flake detector in scripts/ci-flake.js).
 */
const TRANSIENT_ERROR_RE = /(503|429|temporarily overloaded|Service Unavailable|Too Many Requests|RESOURCE_EXHAUSTED|Premature close|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|network)/i;

export function isTransientLlmError(message) {
  return typeof message === 'string' && TRANSIENT_ERROR_RE.test(message);
}

/** Folders within a domain's wiki/ that we consider for changed-page detection. */
const WIKI_FOLDERS = ['entities', 'concepts', 'summaries'];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * List the paths of every .md file inside a domain's wiki/, relative to wiki/.
 * E.g. ["entities/foo.md", "concepts/bar.md", "summaries/baz.md"].
 *
 * Used by:
 *   - sharedbrain-delta's filterToDomainLinks (cross-domain link safety net)
 *   - findChangedPages
 */
export async function getAllPagePaths(wikiDir) {
  const out = [];
  for (const folder of WIKI_FOLDERS) {
    const folderPath = path.join(wikiDir, folder);
    if (!existsSync(folderPath)) continue;
    let entries;
    try { entries = await readdir(folderPath, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      out.push(`${folder}/${entry.name}`);
    }
  }
  return out;
}

/**
 * Find pages that changed since the given timestamp, UNION with any pages in
 * pendingRetry. Returns deduplicated array of paths relative to wiki/.
 *
 * @param {string} wikiDir
 * @param {Date|null} sinceDate         null = treat all pages as changed (first push)
 * @param {object} pendingRetry         { [pagePath]: attemptCount }
 * @returns {Promise<string[]>}
 */
export async function findChangedPages(wikiDir, sinceDate, pendingRetry = {}) {
  const changed = new Set();

  // 1. mtime-based detection
  for (const folder of WIKI_FOLDERS) {
    const folderPath = path.join(wikiDir, folder);
    if (!existsSync(folderPath)) continue;
    let entries;
    try { entries = await readdir(folderPath, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const pageAbs = path.join(folderPath, entry.name);
      try {
        const st = await stat(pageAbs);
        if (!sinceDate || st.mtime > sinceDate) {
          changed.add(`${folder}/${entry.name}`);
        }
      } catch { /* skip pages we can't stat */ }
    }
  }

  // 2. union with pending_retry — pages that failed last time
  for (const p of Object.keys(pendingRetry || {})) {
    // Only retry pages that still exist
    const pageAbs = path.join(wikiDir, p);
    if (existsSync(pageAbs)) {
      changed.add(p);
    }
  }

  return Array.from(changed);
}

/**
 * Best-effort: fetch the version of a wiki page as of `sinceDate` from the
 * personal-sync git repo (.knowledge-git). Returns null if:
 *   - .knowledge-git doesn't exist (most users don't have personal sync)
 *   - git command fails for any reason
 *   - the page wasn't tracked at that time
 *
 * Returning null means the LLM is told this is a new page — slightly less
 * useful delta (no prior-version comparison), but safe.
 */
export async function loadPriorContent(domainsDir, domain, pagePath, sinceDate) {
  if (!sinceDate) return null;
  try {
    // ⚠ THIS FUNCTION IS CURRENTLY DEAD — it returns null on EVERY call, and
    // the v3.1.0 path change below did NOT revive it.
    //
    // The pathspec at the bottom of this function is `domains/<domain>/wiki/...`,
    // but Personal Sync's work-tree IS the domains dir (see `git()` in sync.js,
    // which passes --work-tree=getDomainsDir()), so tracked paths carry NO
    // `domains/` prefix. Verified against the real repo: 0 of 5242 tracked
    // files match. The sha lookup therefore always comes back empty and every
    // Shared Brain delta is generated as if the page were brand new — degraded
    // quality and wasted tokens, but not corruption.
    //
    // The fix (drop the `domains/` prefix) is deliberately DEFERRED: it changes
    // LLM prompt content on the Shared Brain path, which must not ride in a
    // release whose whole purpose is proving a no-op. Tracked separately.
    //
    // v3.1.0+: the git DIR now comes from paths.js — the SAME resolver sync.js
    // uses. It used to be derived as `<domainsDir>/..`, which silently missed
    // the real repo for anyone with a custom domainsPath, and would miss it
    // again in a packaged .app. Because the function is dead either way, this
    // change is provably a no-op on its output (null before, null after).
    const gitDir = getSyncGitDir();
    if (!existsSync(gitDir)) return null;

    const sinceIso = sinceDate.toISOString();
    const { stdout: shaOut } = await execFileAsync(
      'git',
      [`--git-dir=${gitDir}`, `--work-tree=${domainsDir}`,
       'log', '--format=%H', `--before=${sinceIso}`, '-1', '--',
       `domains/${domain}/wiki/${pagePath}`],
      { encoding: 'utf-8' }
    );
    const sha = shaOut.trim();
    if (!sha) return null;

    const { stdout: content } = await execFileAsync(
      'git',
      [`--git-dir=${gitDir}`, 'show', `${sha}:domains/${domain}/wiki/${pagePath}`],
      { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 }
    );
    return content;
  } catch {
    return null;
  }
}

// ── pushDomain ─────────────────────────────────────────────────────────────

/**
 * Push one domain's deltas to the collective storage.
 *
 * Flow:
 *   1. Security gate: refuse if domainSlug is not in connection.local_domains.
 *   2. Find changed pages (mtime > last_push_at  ∪  pending_retry).
 *   3. List all page paths in the domain (for cross-domain link filtering).
 *   4. For each changed page:
 *        a. Read current content.
 *        b. Best-effort: read prior content via personal-sync git.
 *        c. Generate DeltaSummary via local LLM (sharedbrain-delta).
 *        d. On failure: increment pending_retry counter, or mark
 *           permanent_skip if attempts hit MAX_RETRY_ATTEMPTS.
 *   5. Build contribution payload, call adapter.storeContribution.
 *   6. Update connection state: last_push_at, pending_retry, permanent_skip.
 *
 * @param {object} connection                 Full connection object (with tokens)
 * @param {string} domainSlug                 Local domain to push (must be in connection.local_domains)
 * @param {object} [opts]
 * @param {Function} [opts.onProgress]        (stage, message, meta?) callback for SSE
 * @param {Function} [opts.llmFn]             Test injection — overrides generateText
 * @param {string}   [opts.domainsDir]        Override domains root (test injection)
 * @param {Function} [opts.patchFn]           Test injection — overrides patchSharedBrain
 * @param {Function} [opts.now]               Test injection — returns Date object
 * @param {string}   [opts.submissionId]      Test injection — pre-set submission UUID for determinism
 * @returns {Promise<{ ok, pushed, skipped, permanent_skip, domain, submission_id, error? }>}
 */
export async function pushDomain(connection, domainSlug, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const domainsDir = opts.domainsDir || getDomainsDir();
  const patchFn    = opts.patchFn    || patchSharedBrain;
  const nowFn      = opts.now        || (() => new Date());
  const submissionId = opts.submissionId || randomUUID();

  // ── 1. Security gate ─────────────────────────────────────────────────────
  if (!connection || typeof connection !== 'object') {
    return { ok: false, error: 'pushDomain: connection object is required' };
  }
  if (!connection.enabled) {
    return { ok: false, error: 'pushDomain: connection is disabled' };
  }
  if (!Array.isArray(connection.local_domains) || !connection.local_domains.includes(domainSlug)) {
    return {
      ok: false,
      error: `pushDomain: domain "${domainSlug}" is not in this connection's contribution list. ` +
             `Add it to the connection's local_domains in the Sync tab settings before pushing.`,
    };
  }
  // v3.0.2: the shared-* namespace is reserved for read-only mirror
  // domains. Contributing FROM a mirror would create a feedback loop (pulled
  // collective content re-contributed, conflict markers re-ingested as facts)
  // and lets remotely-chosen page names flow back into local git commands.
  // The UI already filters mirrors out of the wizard; this closes the
  // hand-edited-config path.
  if (domainSlug.startsWith('shared-')) {
    return {
      ok: false,
      error: `pushDomain: "${domainSlug}" is a read-only Shared Brain mirror — it cannot be a contributing domain. ` +
             `Contribute from a personal domain instead.`,
    };
  }

  const wikiDir = path.join(domainsDir, domainSlug, 'wiki');
  if (!existsSync(wikiDir)) {
    return { ok: false, error: `pushDomain: wiki folder not found at ${wikiDir}` };
  }

  // ── 2. Find changed pages ────────────────────────────────────────────────
  const sinceDate = connection.last_push_at ? new Date(connection.last_push_at) : null;
  if (sinceDate && isNaN(sinceDate.getTime())) {
    return { ok: false, error: `pushDomain: connection.last_push_at is not a valid date: "${connection.last_push_at}"` };
  }

  // v3.0.3 (L2): capture the push timestamp BEFORE the change scan. When it
  // was captured after, a page edited during the scan window could carry an
  // mtime below the recorded timestamp and never be pushed. Overlap in the
  // other direction (re-pushing an already-pushed page) is safe — the
  // collective's exact-string dedup absorbs it; a gap is not.
  const pushTimestamp = nowFn().toISOString();

  const pendingRetry = { ...(connection.pending_retry || {}) };
  const permanentSkip = new Set(connection.permanent_skip || []);

  // v3.0.2: un-skip on edit. The permanent_skip warn message has
  // always told the user "re-edit the page; it will retry on next push" —
  // this is the code that makes that true. A skipped page whose mtime is
  // newer than the last push was edited by the user after it was skipped:
  // give it a fresh set of attempts.
  for (const p of [...permanentSkip]) {
    const pageAbs = path.join(wikiDir, p);
    if (!existsSync(pageAbs)) { permanentSkip.delete(p); continue; } // deleted → drop stale entry
    if (!sinceDate) { permanentSkip.delete(p); continue; }           // no baseline → let it retry
    try {
      const st = await stat(pageAbs);
      if (st.mtime > sinceDate) {
        permanentSkip.delete(p);
        delete pendingRetry[p]; // fresh strike counter
        onProgress('info', `${p}: edited since it was skipped — retrying.`);
      }
    } catch { /* can't stat → leave skipped */ }
  }

  let changedPages = await findChangedPages(wikiDir, sinceDate, pendingRetry);
  // Remove any pages still in permanent_skip — those need manual user attention.
  changedPages = changedPages.filter(p => !permanentSkip.has(p));

  if (changedPages.length === 0) {
    onProgress('info', 'No pages changed since last push.');
    // Still update last_push_at so subsequent pushes don't re-scan everything.
    // Also persist the pruned permanent_skip / pending_retry (stale entries
    // for deleted pages are dropped above / here) — v3.0.2.
    const prunedRetry = {};
    for (const [p, n] of Object.entries(pendingRetry)) {
      if (existsSync(path.join(wikiDir, p))) prunedRetry[p] = n;
    }
    patchFn(connection.id, {
      last_push_at: pushTimestamp,
      permanent_skip: Array.from(permanentSkip),
      pending_retry: prunedRetry,
    });
    return {
      ok: true, pushed: 0, skipped: 0,
      permanent_skip: Array.from(permanentSkip),
      domain: domainSlug, submission_id: null,
    };
  }

  onProgress('info', `Found ${changedPages.length} changed page(s). Pre-processing with local LLM...`);

  // ── 3. Build the cross-domain link filter set ───────────────────────────
  const domainPagePaths = await getAllPagePaths(wikiDir);

  // ── 4. Generate DeltaSummaries ──────────────────────────────────────────
  const deltas = [];
  const newPendingRetry = {};
  const newPermanentSkip = new Set(permanentSkip);
  let skippedCount = 0;

  for (let i = 0; i < changedPages.length; i++) {
    const pagePath = changedPages[i];
    onProgress('progress', `Processing ${pagePath} (${i + 1}/${changedPages.length})`, {
      current: i + 1, total: changedPages.length,
    });

    let currentContent;
    try {
      currentContent = await readFile(path.join(wikiDir, pagePath), 'utf-8');
    } catch (err) {
      console.error(`[sharedbrain] Skipping ${pagePath} — read failed: ${err.message}`);
      skippedCount++;
      continue;
    }

    const priorContent = await loadPriorContent(domainsDir, domainSlug, pagePath, sinceDate);

    const result = await generateDeltaSummary({
      pagePath, currentContent, priorContent,
      fellowId: connection.fellow_id,
      fellowDisplayName: connection.fellow_display_name,
      domainPagePaths,
      options: {
        llmFn: opts.llmFn,
        now: nowFn,
      },
    });

    if (result.ok) {
      deltas.push(result.delta);
      // Don't re-queue this page — it succeeded.
    } else if (isTransientLlmError(result.error)) {
      // v3.0.2: a provider outage / rate limit is NOT the page's
      // fault — re-queue without advancing the strike counter, so a 503
      // window can never permanently exclude a page from the shared brain.
      newPendingRetry[pagePath] = pendingRetry[pagePath] || 0;
      onProgress('warn',
        `${pagePath}: AI provider temporarily unavailable — will retry next push (does not count against the retry limit).`
      );
      skippedCount++;
    } else {
      // LLM/parse failure. Track for retry per Decision 3.
      const prevCount = pendingRetry[pagePath] || 0;
      const newCount = prevCount + 1;
      if (newCount >= MAX_RETRY_ATTEMPTS) {
        newPermanentSkip.add(pagePath);
        onProgress('warn',
          `${pagePath}: failed ${newCount} times — marked permanent_skip. ` +
          `Edit the page (any change updates its timestamp) and it will retry on the next push.`
        );
      } else {
        newPendingRetry[pagePath] = newCount;
        onProgress('warn',
          `${pagePath}: LLM pre-processing failed (attempt ${newCount}/${MAX_RETRY_ATTEMPTS}). ` +
          `Will retry next push.`
        );
      }
      skippedCount++;
    }
  }

  // ── 5. Store contribution payload (if anything to push) ──────────────────
  let pushedSubmissionId = null;
  if (deltas.length > 0) {
    let adapter;
    try {
      adapter = createStorageAdapter(connection, { onWarn: (msg) => onProgress('warn', msg) });
    } catch (err) {
      // v3.0.3 (L3): persist this cycle's retry/skip bookkeeping even though
      // the push failed — do NOT advance last_push_at (the pages must
      // rescan next time).
      patchFn(connection.id, {
        pending_retry: newPendingRetry,
        permanent_skip: Array.from(newPermanentSkip),
      });
      return {
        ok: false,
        error: `pushDomain: storage adapter init failed: ${err.message}`,
        pushed: 0, skipped: skippedCount,
        domain: domainSlug,
      };
    }

    const payload = {
      submission_id: submissionId,
      fellow_id: connection.fellow_id,
      fellow_display_name: connection.fellow_display_name,
      domain: connection.shared_domain,
      domain_display_name: connection.shared_domain_display_name || connection.shared_domain,
      contributed_at: pushTimestamp,
      consent: { share_with_brain: true },
      delta_since: sinceDate ? sinceDate.toISOString() : null,
      deltas,
    };

    onProgress('info', `Pushing ${deltas.length} delta summaries to collective storage...`);
    try {
      await adapter.storeContribution(connection.fellow_id, submissionId, payload);
      pushedSubmissionId = submissionId;
    } catch (err) {
      // v3.0.3 (L3): as above — keep the retry bookkeeping, don't advance
      // last_push_at, so both the failed deltas and the strike counters
      // survive to the next push.
      patchFn(connection.id, {
        pending_retry: newPendingRetry,
        permanent_skip: Array.from(newPermanentSkip),
      });
      return {
        ok: false,
        error: `pushDomain: storage write failed: ${err.message}`,
        pushed: 0, skipped: skippedCount,
        domain: domainSlug,
      };
    }
  } else {
    onProgress('info', 'All changed pages failed pre-processing — nothing to push this cycle.');
  }

  // ── 6. Update connection state ──────────────────────────────────────────
  patchFn(connection.id, {
    last_push_at: pushTimestamp,
    pending_retry: newPendingRetry,
    permanent_skip: Array.from(newPermanentSkip),
  });

  const summary = deltas.length === 0
    ? `Push complete: 0 pushed, ${skippedCount} skipped.`
    : `Pushed ${deltas.length} page${deltas.length !== 1 ? 's' : ''}.` +
      (skippedCount > 0 ? ` ${skippedCount} will retry next time.` : '');

  onProgress('done', summary, { pushed: deltas.length, skipped: skippedCount });

  return {
    ok: true,
    pushed: deltas.length,
    skipped: skippedCount,
    permanent_skip: Array.from(newPermanentSkip),
    pending_retry: newPendingRetry,
    domain: domainSlug,
    submission_id: pushedSubmissionId,
  };
}

// ── pullCollective ─────────────────────────────────────────────────────────

/**
 * Resolves `relative` against `base` and refuses if the result escapes `base`.
 * Used to guard every write path during pull, including paths that came from
 * remote shared-brain storage. Matches the chokepoint semantics used in
 * sharedbrain-local-adapter and mcp/storage/local.js.
 */
function resolveInsideBase(base, relative) {
  if (relative === null || relative === undefined) return null;
  if (typeof relative !== 'string') return null;
  if (path.isAbsolute(relative)) return null;
  const resolved = path.resolve(base, relative);
  const baseResolved = path.resolve(base);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    return null;
  }
  return resolved;
}

/**
 * Ensure the local shared-brain mirror domain exists on disk.
 *
 * Creates the standard Curator domain layout (entities/, concepts/, summaries/,
 * conversations/, raw/, index.md, log.md) with a special CLAUDE.md that:
 *   - Carries YAML frontmatter `readonly: true` (Decision 7) — used by
 *     Phase 4 MCP write tools to refuse direct writes to this domain.
 *   - States clearly in the body that this is a synced shared-brain mirror
 *     and must not be ingested into manually.
 *
 * Idempotent: if CLAUDE.md already exists, returns without modification.
 *
 * @param {string} localDomain     e.g. "shared-cohort"
 * @param {object} connection
 * @param {string} domainsDir      absolute path to domains/ folder
 */
export async function ensureSharedDomainExists(localDomain, connection, domainsDir) {
  // Slug safety
  if (typeof localDomain !== 'string' ||
      !localDomain ||
      localDomain.includes('..') ||
      localDomain.includes('/') ||
      localDomain.includes('\\') ||
      localDomain.startsWith('.')) {
    throw new Error(`ensureSharedDomainExists: invalid local domain slug "${localDomain}"`);
  }

  const base = path.join(domainsDir, localDomain);
  const claudeMdPath = path.join(base, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    return; // already initialised
  }

  await mkdir(path.join(base, 'wiki', 'entities'),  { recursive: true });
  await mkdir(path.join(base, 'wiki', 'concepts'),  { recursive: true });
  await mkdir(path.join(base, 'wiki', 'summaries'), { recursive: true });
  await mkdir(path.join(base, 'conversations'),     { recursive: true });
  await mkdir(path.join(base, 'raw'),               { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const labelText = (connection.label || localDomain).replace(/\r?\n/g, ' ');

  // CLAUDE.md with readonly frontmatter (Decision 7). MCP write tools in
  // Phase 4 will read this marker and refuse to write to this domain
  // directly. Contributions must originate from the contributor's personal
  // opted-in domain (e.g. connection.local_domains[0]) → DeltaSummary push →
  // synthesis → pull.
  const claudeMd = [
    '---',
    'readonly: true',
    'source: shared-brain',
    `shared_brain_slug: ${connection.shared_brain_slug || 'unknown'}`,
    `shared_domain: ${connection.shared_domain || 'unknown'}`,
    '---',
    '',
    `# Shared Brain Mirror: ${labelText}`,
    '',
    'This domain is the local read-only mirror of a Shared Brain. It is updated by',
    'the **Pull updates** button in the Sync tab — never by manual ingestion.',
    '',
    '## How to contribute',
    '',
    'To add knowledge to this Shared Brain, edit pages in your **personal opted-in',
    `domain** (configured under this connection: \`${(connection.local_domains || []).join(', ') || '(none yet)'}\`). Then click`,
    '**Push contributions** in the Sync tab. After the next synthesis, your',
    'contributions will appear here on the next Pull.',
    '',
    'Direct edits to pages in this domain will be **overwritten** on the next pull.',
    '',
    '## What lives here',
    '',
    '- `entities/` — named things shared across the collective.',
    '- `concepts/` — ideas and frameworks accumulated from all contributors.',
    '- `summaries/` — per-source summaries with cross-contributor provenance.',
    '- `index.md`  — catalog of all pages.',
    '- `log.md`    — chronological pull history.',
    '',
    `_Created: ${today}._`,
    '',
  ].join('\n');

  await writeFile(claudeMdPath, claudeMd, 'utf8');

  await writeFile(
    path.join(base, 'wiki', 'index.md'),
    `# Wiki Index — ${labelText} (Shared Brain Mirror)\nLast updated: ${today}\n\n| Page | Type | Summary |\n|------|------|---------|`,
    'utf8'
  );
  await writeFile(
    path.join(base, 'wiki', 'log.md'),
    `# Pull Log — ${labelText} (Shared Brain Mirror)\n`,
    'utf8'
  );
}

/**
 * Pull the full collective wiki snapshot for a connection's shared domain
 * into a local read-only mirror.
 *
 * Flow:
 *   1. Validate connection.
 *   2. Compute local mirror domain slug (e.g. "shared-cohort").
 *   3. Ensure the local mirror exists (creates with readonly frontmatter).
 *   4. List all pages in collective/<shared_domain>/wiki/ via adapter.
 *   5. For each page:
 *        - resolveInsideBase() guard against path-traversal in remote paths.
 *        - writePage(localDomain, path, content)  ← reuses existing pipeline:
 *          merge, dedup, frontmatter, link normalisation, backlink injection.
 *   6. For each summary page written: syncSummaryEntities() to ensure
 *      cross-page backlinks are wired.
 *   7. appendLog() with pull stats.
 *   8. patchSharedBrain() to update last_pull_at.
 *
 * @param {object} connection
 * @param {object} [opts]
 * @param {Function} [opts.onProgress]  (stage, message, meta?) => void
 * @param {string}   [opts.domainsDir]  Override domains root (test injection).
 *                                      When set, temporarily overrides
 *                                      process.env.DOMAINS_PATH for the
 *                                      duration of this call so writePage()
 *                                      and friends see the override.
 * @param {Function} [opts.patchFn]     Test injection — overrides patchSharedBrain.
 * @param {Function} [opts.now]         Test injection — returns Date.
 * @returns {Promise<{ ok, created, updated, skipped, local_domain, error? }>}
 */
export async function pullCollective(connection, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const patchFn    = opts.patchFn    || patchSharedBrain;
  const nowFn      = opts.now        || (() => new Date());

  // ── 1. Validate connection ─────────────────────────────────────────────
  if (!connection || typeof connection !== 'object') {
    return { ok: false, error: 'pullCollective: connection object is required' };
  }
  if (!connection.enabled) {
    return { ok: false, error: 'pullCollective: connection is disabled' };
  }
  if (typeof connection.shared_brain_slug !== 'string' || !connection.shared_brain_slug) {
    return { ok: false, error: 'pullCollective: connection.shared_brain_slug is required' };
  }
  if (typeof connection.shared_domain !== 'string' || !connection.shared_domain) {
    return { ok: false, error: 'pullCollective: connection.shared_domain is required' };
  }

  // ── 2. Compute local mirror slug ───────────────────────────────────────
  const localDomain = `shared-${connection.shared_brain_slug}`;

  // ── 3. Temporarily override the domains dir if a test wants it ─────────
  // writePage / syncSummaryEntities / appendLog all read getDomainsDir()
  // internally. To support per-fellow test isolation without rewriting those
  // functions, we redirect getDomainsDir for the duration of this call.
  // We use __setDomainsDirOverride (checked BEFORE config) rather than the
  // DOMAINS_PATH env var, because the env var loses to .curator-config.json's
  // domainsPath — which a real install almost always has — so the env-var
  // form was a silent no-op on any configured machine (and broke the tests
  // that relied on it). Production never passes opts.domainsDir, so this stays
  // a no-op there.
  if (opts.domainsDir) {
    __setDomainsDirOverride(opts.domainsDir);
  }

  try {
    const domainsDir = opts.domainsDir || getDomainsDir();

    // ── 4. Ensure mirror domain exists ──────────────────────────────────
    await ensureSharedDomainExists(localDomain, connection, domainsDir);

    // ── 5. Read all collective pages ────────────────────────────────────
    let adapter;
    try {
      adapter = createStorageAdapter(connection, { onWarn: (msg) => onProgress('warn', msg) });
    } catch (err) {
      return { ok: false, error: `pullCollective: storage adapter init failed: ${err.message}` };
    }

    onProgress('info', 'Fetching collective wiki page list...');
    let pagePaths;
    try {
      pagePaths = await adapter.listPages(connection.shared_domain);
    } catch (err) {
      return { ok: false, error: `pullCollective: listPages failed: ${err.message}` };
    }

    // v3.0.4 (M16): learn when the collective was last synthesised so the
    // connection card can show it ("Pull pulls 0 pages" almost always means
    // "no synthesis has run yet" — invisible to contributors before this).
    // Best-effort: one extra meta read; a failure changes nothing.
    let lastSynthesisAt;
    try {
      const synthState = await adapter.readMeta('state.last-synthesis');
      if (synthState && typeof synthState.at === 'string') {
        lastSynthesisAt = synthState.at;
      }
    } catch { /* no synthesis yet, or meta unreadable — leave undefined */ }
    const synthPatch = lastSynthesisAt !== undefined ? { last_synthesis_at: lastSynthesisAt } : {};

    if (!Array.isArray(pagePaths) || pagePaths.length === 0) {
      onProgress('info', 'Collective brain is empty — nothing to pull. ' +
        (lastSynthesisAt ? '' : 'No synthesis has run yet — ask your admin to run one after contributors push.'));
      const pulledAt = nowFn().toISOString();
      patchFn(connection.id, { last_pull_at: pulledAt, ...synthPatch });
      return { ok: true, created: 0, updated: 0, skipped: 0, local_domain: localDomain, last_synthesis_at: lastSynthesisAt || null };
    }

    onProgress('info', `Pulling ${pagePaths.length} page${pagePaths.length !== 1 ? 's' : ''}...`);

    // ── 6. Write each page locally ──────────────────────────────────────
    const wikiBase = path.join(domainsDir, localDomain, 'wiki');
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    const writtenSummaryPaths = [];
    const writtenPaths = [];

    for (let i = 0; i < pagePaths.length; i++) {
      const remotePath = pagePaths[i];
      onProgress('progress', `${remotePath} (${i + 1}/${pagePaths.length})`, {
        current: i + 1, total: pagePaths.length,
      });

      // ── 6a. Security guard — path traversal ─────────────────────────
      // A malicious shared brain could include a page path like
      // "../../etc/passwd" or "../other-domain/wiki/x.md" to escape.
      const safePath = resolveInsideBase(wikiBase, remotePath);
      if (!safePath) {
        console.error(`[pullCollective] SECURITY: refused path "${remotePath}" from shared brain (would escape wiki/)`);
        onProgress('warn', `Skipped suspicious path: ${remotePath}`);
        skipped++;
        continue;
      }

      // ── 6a.2 Security guard — symlink defense ───────────────────────
      // resolveInsideBase rejects ".." but does NOT follow symlinks. So a
      // pre-existing symlink at safePath (planted by another process or
      // a hostile user with filesystem access) could redirect writeFile
      // to a legitimate user file — overwriting e.g. domains/articles/
      // wiki/entities/anthropic.md from the mirror.
      //
      // Use lstat (not stat) to detect the symlink without following it.
      // If safePath exists and IS a symlink, refuse the write. We can do
      // this cheaply because the path is guaranteed inside our domain.
      try {
        const stats = await lstat(safePath);
        if (stats.isSymbolicLink()) {
          console.error(`[pullCollective] SECURITY: refused symlinked path "${remotePath}" — target is a symlink, would follow to an unsafe location`);
          onProgress('warn', `Skipped symlink: ${remotePath}`);
          skipped++;
          continue;
        }
      } catch (err) {
        // ENOENT is fine — file doesn't exist yet, that's the normal "new page" case.
        if (err.code !== 'ENOENT') {
          console.error(`[pullCollective] lstat unexpected error for "${remotePath}": ${err.message}`);
          skipped++;
          continue;
        }
      }

      // ── 6b. Read content ────────────────────────────────────────────
      let content;
      try {
        content = await adapter.readPage(connection.shared_domain, remotePath);
      } catch (err) {
        console.error(`[pullCollective] readPage failed for "${remotePath}": ${err.message}`);
        skipped++;
        continue;
      }
      if (content === null || content === undefined) {
        skipped++;
        continue;
      }

      // ── 6c. Run through the existing writePage pipeline ─────────────
      // This is where v2.5.5 link grounding, Pass A/B/C link normalisation,
      // frontmatter injection, and backlink injection all run. v3.0.3:
      // `replace: true` — the mirror is a MIRROR, not a merge target. The
      // union merge used to resurrect facts the collective had removed
      // (conflict resolution, GDPR revocation) from the stale local copy on
      // every pull, forever. The returned result.status is authoritative
      // ("created"|"updated"|"unchanged") — more accurate than our own
      // existsSync check because writePage may redirect the path via
      // cross-folder dedup.
      let result;
      try {
        result = await writePage(localDomain, remotePath, content, { replace: true });
      } catch (err) {
        console.error(`[pullCollective] writePage failed for "${remotePath}": ${err.message}`);
        skipped++;
        continue;
      }
      if (!result) {
        // writePage returned null (invalid path / no filename)
        skipped++;
        continue;
      }

      if (result.status === 'created') created++;
      else if (result.status === 'updated') updated++;
      else if (result.status === 'unchanged') unchanged++;
      else skipped++;

      writtenPaths.push(result.canonPath);
      if (result.canonPath.startsWith('summaries/')) {
        writtenSummaryPaths.push(result.canonPath);
      }
    }

    // ── 7. syncSummaryEntities for any summary pages ───────────────────
    for (const summaryPath of writtenSummaryPaths) {
      try {
        await syncSummaryEntities(localDomain, summaryPath, writtenPaths);
      } catch (err) {
        console.error(`[pullCollective] syncSummaryEntities failed for "${summaryPath}": ${err.message}`);
      }
    }

    // ── 7b. Prune local pages deleted from the collective (v3.0.3, H8) ──
    // The mirror must not retain pages the collective no longer has — most
    // importantly after a GDPR revocation, where "the revoked content stays
    // on every contributor's machine forever" was a real erasure gap.
    // Guards:
    //   - Only when this pull processed EVERY remote page (skipped === 0):
    //     a page skipped over a read error is still remote — pruning by an
    //     incomplete written-set would delete live content.
    //   - Only .md files inside the three canonical wiki folders; index.md,
    //     log.md and dot-files (e.g. .health-dismissed.jsonl) are untouched.
    //   - The empty-collective case never reaches here (early return above),
    //     so a transient empty listing can't wipe the mirror.
    let pruned = 0;
    if (skipped === 0) {
      const writtenSet = new Set(writtenPaths);
      for (const folder of WIKI_FOLDERS) {
        const folderAbs = path.join(wikiBase, folder);
        if (!existsSync(folderAbs)) continue;
        let entries;
        try { entries = await readdir(folderAbs, { withFileTypes: true }); }
        catch { continue; }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const rel = `${folder}/${entry.name}`;
          if (writtenSet.has(rel)) continue;
          try {
            await unlink(path.join(folderAbs, entry.name));
            pruned++;
            onProgress('info', `Removed ${rel} — no longer in the collective.`);
          } catch (err) {
            console.error(`[pullCollective] prune failed for "${rel}": ${err.message}`);
          }
        }
      }
    } else {
      onProgress('warn', `${skipped} page(s) could not be processed this pull — skipping stale-page cleanup to be safe.`);
    }

    // ── 8. appendLog ─────────────────────────────────────────────────────
    const today = nowFn().toISOString().slice(0, 10);
    const logMsg = `[${today}] Shared Brain pull from "${connection.label}": ${created} new, ${updated} updated, ${unchanged} unchanged${pruned > 0 ? `, ${pruned} removed` : ''}${skipped > 0 ? `, ${skipped} skipped` : ''}.`;
    try { await appendLog(localDomain, logMsg); }
    catch (err) { console.error(`[pullCollective] appendLog failed: ${err.message}`); }

    // ── 9. Update connection state ───────────────────────────────────────
    const pulledAt = nowFn().toISOString();
    patchFn(connection.id, { last_pull_at: pulledAt, ...synthPatch });

    const summary = `Pull complete: ${created} new, ${updated} updated, ${unchanged} unchanged${pruned > 0 ? `, ${pruned} removed` : ''}${skipped > 0 ? `, ${skipped} skipped` : ''}. Local domain: ${localDomain}`;
    onProgress('done', summary, { created, updated, unchanged, pruned, skipped, local_domain: localDomain });

    return {
      ok: true,
      created,
      updated,
      unchanged,
      pruned,
      skipped,
      local_domain: localDomain,
      last_synthesis_at: lastSynthesisAt || null,
    };

  } finally {
    // Clear the override regardless of success.
    if (opts.domainsDir) {
      __setDomainsDirOverride(null);
    }
  }
}

// ── computePendingPages ────────────────────────────────────────────────────

/**
 * Cheap local count of pages that would be pushed if the user clicked
 * "Push contributions" right now — the same detection pushDomain uses
 * (mtime > last_push_at ∪ pending_retry, minus permanent_skip), but
 * read-only: no LLM, no network, no state change. Powers the navbar
 * pending badge and the connection card (v3.0.4, M14).
 *
 * Read-only connections always return 0 (they cannot push).
 *
 * @param {object} connection   Masked or full connection — no tokens needed.
 * @param {string} [domainsDir] Override for tests; defaults to getDomainsDir().
 * @returns {Promise<number>}
 */
export async function computePendingPages(connection, domainsDir) {
  if (!connection || typeof connection !== 'object') return 0;
  if (connection.enabled === false) return 0;
  if (connection.read_only === true) return 0;
  const root = domainsDir || getDomainsDir();
  const sinceDate = connection.last_push_at ? new Date(connection.last_push_at) : null;
  if (sinceDate && isNaN(sinceDate.getTime())) return 0;
  const skip = new Set(connection.permanent_skip || []);
  let total = 0;
  for (const d of (Array.isArray(connection.local_domains) ? connection.local_domains : [])) {
    if (typeof d !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(d)) continue;
    if (d.toLowerCase().startsWith('shared-')) continue;
    const wikiDir = path.join(root, d, 'wiki');
    if (!existsSync(wikiDir)) continue;
    try {
      const changed = await findChangedPages(wikiDir, sinceDate, connection.pending_retry || {});
      total += changed.filter(p => !skip.has(p)).length;
    } catch { /* unreadable domain → contribute 0 */ }
  }
  return total;
}

// ── listMembers (v3.0.5, Phase 4.3) ────────────────────────────────────────

/**
 * Pure grouping core: turn a contribution listing (as returned by
 * adapter.listContributionsSince) into a per-fellow member summary.
 * Identity comes from the storage-path-derived fellowId (the same trust
 * decision as synthesis, v3.0.3) — payload fields are informational only.
 *
 * @param {Array<{fellowId, submissionId, payload}>} listed
 * @returns {Array<{fellow_id, short_id, submissions, first_contributed_at,
 *                  last_contributed_at, display_name, pages}>}
 */
export function groupMembers(listed) {
  const byFellow = new Map();
  for (const c of (Array.isArray(listed) ? listed : [])) {
    if (!c || typeof c.fellowId !== 'string' || !c.fellowId) continue;
    let m = byFellow.get(c.fellowId);
    if (!m) {
      m = {
        fellow_id: c.fellowId,
        short_id: c.fellowId.replace(/-/g, '').slice(0, 8),
        submissions: 0,
        first_contributed_at: null,
        last_contributed_at: null,
        display_name: null,
        pages: 0,
      };
      byFellow.set(c.fellowId, m);
    }
    m.submissions++;
    const payload = c.payload && typeof c.payload === 'object' ? c.payload : {};
    const t = typeof payload.contributed_at === 'string' ? Date.parse(payload.contributed_at) : NaN;
    if (Number.isFinite(t)) {
      const iso = new Date(t).toISOString();
      if (!m.first_contributed_at || iso < m.first_contributed_at) m.first_contributed_at = iso;
      if (!m.last_contributed_at || iso > m.last_contributed_at) m.last_contributed_at = iso;
    }
    if (typeof payload.fellow_display_name === 'string' && payload.fellow_display_name.trim()) {
      // Informational only (single-line, capped) — the admin can read the raw
      // payloads in the repo anyway; never treat this as identity.
      m.display_name = payload.fellow_display_name.replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
    }
    m.pages += Array.isArray(payload.deltas) ? payload.deltas.length : 0;
  }
  return [...byFellow.values()].sort((a, b) =>
    String(b.last_contributed_at || '').localeCompare(String(a.last_contributed_at || '')));
}

/**
 * List everyone who has ever contributed to this connection's shared brain —
 * the member directory the admin needs for revocation (a fellow_id was
 * previously undiscoverable from the UI). Read-only; one listing pass over
 * contributions/ (on GitHub this reads each contribution payload — fine at
 * cohort scale, documented in shared-brain-admin.md).
 *
 * @param {object} connection  Full connection (with tokens).
 * @param {object} [opts]      {onWarn} forwarded to the adapter.
 * @returns {Promise<{ok, members?, error?}>}
 */
export async function listMembers(connection, opts = {}) {
  if (!connection || typeof connection !== 'object') {
    return { ok: false, error: 'listMembers: connection object is required' };
  }
  let adapter;
  try {
    adapter = createStorageAdapter(connection, { onWarn: opts.onWarn });
  } catch (err) {
    return { ok: false, error: `listMembers: storage adapter init failed: ${err.message}` };
  }
  let listed;
  try {
    listed = await adapter.listContributionsSince(null);
  } catch (err) {
    return { ok: false, error: `listMembers: could not list contributions: ${err.message}` };
  }
  return { ok: true, members: groupMembers(listed) };
}

// Exposed for testing only
export const __testing = { resolveInsideBase };
