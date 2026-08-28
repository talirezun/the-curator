/**
 * Health write tools — v2.5.2 MCP
 *
 * Three tools that wrap the existing src/brain/health.js + health-ai.js
 * machinery via direct import:
 *   - scan_wiki_health           → src/brain/health.js scanWiki()
 *   - fix_wiki_issue             → src/brain/health.js fixIssue() (+ AUTO_FIXABLE gate)
 *   - scan_semantic_duplicates   → src/brain/health-ai.js (cost-gated, opt-in)
 *
 * The user's existing dismissals (v2.5.1+ JSONL store) automatically filter
 * scan results — Claude never sees issues the user already skipped on either
 * surface. Persistent dismissals are managed by the dismissed.js tools.
 *
 * Three-tier handling for Claude (encoded in tool descriptions, not code):
 *   - Auto-fixable types  → call fix_wiki_issue without asking
 *   - Review-only types   → confirm with user, then call
 *   - semanticDupe        → ALWAYS preview first, then confirm, then commit
 *
 * Destructive `semanticDupe` merges are gated at the tool level: the first
 * call MUST pass preview: true to receive a diff plan; only then is a second
 * call (with preview: false) allowed to apply.
 */

import {
  scanWiki,
  fixIssue,
  AUTO_FIXABLE,
  previewSemanticDuplicateMerge,
} from '../../src/brain/health.js';
import {
  estimateSemanticDuplicateScan,
  scanSemanticDuplicates,
} from '../../src/brain/health-ai.js';
import { getAiHealthSettings, getDefaultDomain } from '../../src/brain/config.js';
import { domainPath } from '../../src/brain/files.js';
import { acquireFileLock } from '../../src/brain/write-registry.js';
import { resolveDomainArg, refuseIfReadonly } from '../util.js';

// ── scan_wiki_health ─────────────────────────────────────────────────────────

export const scanWikiHealthDefinition = {
  name: 'scan_wiki_health',
  description:
    "Scan the user's second brain wiki for structural issues — broken links, orphan pages, duplicate entities, hyphenation drift, folder-prefix violations, missing backlinks. " +
    "Use this when the user asks to 'check my wiki', 'find problems', 'clean up the knowledge base', 'audit my second brain', 'see what's broken'. " +
    "Returns categorized issue lists. Issues the user has already dismissed (via the in-app Health tab or a previous MCP session) are filtered out automatically — counts.dismissed reports how many. " +
    "Pair this with fix_wiki_issue to apply repairs. Auto-fixable types (folderPrefixLinks, crossFolderDupes, hyphenVariants, missingBacklinks, brokenLinks WITH a suggestedTarget) can be fixed without confirmation. " +
    "Review-only types (orphans, brokenLinks WITHOUT a target) require human judgement — confirm with the user before fixing or dismissing.",
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: "Target domain slug (e.g. 'articles'). If omitted, uses the configured default domain.",
      },
    },
    required: [],
  },
};

export async function scanWikiHealthHandler(args, storage) {
  const domain = await resolveDomainArg(args, storage, getDefaultDomain);
  if (domain.error) return { ok: false, error: domain.error };

  const report = await scanWiki(domain.value);
  const total =
    report.brokenLinks.length +
    report.orphans.length +
    report.folderPrefixLinks.length +
    report.crossFolderDupes.length +
    report.hyphenVariants.length +
    report.missingBacklinks.length;

  // Fixable count — broken links with a target are also auto-fixable.
  const autoFixableTypes = ['folderPrefixLinks', 'crossFolderDupes', 'hyphenVariants', 'missingBacklinks'];
  const autoFixableCount =
    report.brokenLinks.filter(b => b.suggestedTarget).length +
    autoFixableTypes.reduce((sum, t) => sum + (report[t]?.length || 0), 0);
  const reviewOnlyCount = total - autoFixableCount;

  // Issues are placed at the top level (not nested under `issues`) so the
  // MCP response-size guard's progressive-trim logic can find and shrink them
  // by name on a very-large-domain scan. Same field names the in-app /api/health
  // endpoint returns, just lifted up by one level.
  return {
    ok: true,
    domain: domain.value,
    scanned_at: report.scannedAt,
    counts: {
      ...report.counts,
      total_issues:    total,
      auto_fixable:    autoFixableCount,
      review_only:     reviewOnlyCount,
    },
    brokenLinks:       report.brokenLinks,
    orphans:           report.orphans,
    folderPrefixLinks: report.folderPrefixLinks,
    crossFolderDupes:  report.crossFolderDupes,
    hyphenVariants:    report.hyphenVariants,
    missingBacklinks:  report.missingBacklinks,
    report:
      total === 0
        ? `Wiki '${domain.value}' is clean. No structural issues.${report.counts.dismissed ? ` (${report.counts.dismissed} previously dismissed.)` : ''}`
        : `Found ${total} issue${total === 1 ? '' : 's'} in '${domain.value}': ${autoFixableCount} auto-fixable, ${reviewOnlyCount} review-only${report.counts.dismissed ? `, ${report.counts.dismissed} previously dismissed` : ''}.`,
  };
}

// ── fix_wiki_issue ───────────────────────────────────────────────────────────

const FIXABLE_TYPES = new Set([
  'brokenLinks',
  'folderPrefixLinks',
  'crossFolderDupes',
  'hyphenVariants',
  'missingBacklinks',
  'orphanLink',     // pseudo-type for AI orphan-rescue (Phase 2)
  'semanticDupe',   // pseudo-type for semantic-dupe merge (Phase 3, DESTRUCTIVE, gated)
]);

const SEMANTIC_DUPE_PREVIEWED = new Set();
function previewKey(issue) {
  if (!issue) return null;
  const a = `${issue.removeFolder || issue.folderA}/${issue.removeSlug || issue.slugA}`;
  const b = `${issue.keepFolder   || issue.folderB}/${issue.keepSlug   || issue.slugB}`;
  return [a, b].sort().join('||');
}

export const fixWikiIssueDefinition = {
  name: 'fix_wiki_issue',
  description:
    "Apply ONE fix to the user's second brain wiki. Use after scan_wiki_health to repair an issue you've decided to act on. " +
    "PASS BACK THE ISSUE OBJECT SCAN_WIKI_HEALTH GAVE YOU. Do not compose one, and do not substitute your own idea of the right target — the scanner's suggestions come from deterministic slug normalisation, yours would be a guess, and a wrong retarget writes a factually wrong link into every page that referenced it. " +
    "Safe to apply without asking, PROVIDED the issue object came from scan_wiki_health: folderPrefixLinks, missingBacklinks, and brokenLinks that already carry a suggestedTarget. " +
    "brokenLinks WITHOUT a scanner suggestedTarget is not fixable here — say so and leave the link alone, or point the user at the Health tab's AI broken-link fixer, which previews the whole plan before writing. A suggestedTarget you invented is rejected unless it names a page that exists, and even then it is your guess, not the scanner's. " +
    "crossFolderDupes and hyphenVariants merge two pages and DELETE one of them (inbound links are repointed): tell the user which page disappears before you call them. " +
    "Review-only types require user confirmation in chat first: orphanLink (the AI-orphan-rescue pseudo-type — pass it the orphan slug + target slug + bullet description), semanticDupe (the destructive merge pseudo-type). " +
    "semanticDupe is DESTRUCTIVE: it deletes the duplicate file and rewrites every [[old-slug]] link across the domain. " +
    "REQUIRED: call once with preview: true first to receive the diff plan; show the user what will change; then call again with preview: false to commit. " +
    "Without a preview having been performed in this MCP session, a preview: false call on semanticDupe is refused.",
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: "Target domain slug. If omitted, uses the configured default domain.",
      },
      type: {
        type: 'string',
        description: "Issue type. One of: brokenLinks, folderPrefixLinks, crossFolderDupes, hyphenVariants, missingBacklinks, orphanLink, semanticDupe.",
      },
      issue: {
        type: 'object',
        description:
          "The issue object as returned by scan_wiki_health. Field shape depends on type:\n" +
          " - brokenLinks: { sourceFile, linkText, suggestedTarget } — suggestedTarget must name a page that EXISTS (a bare entity/concept slug, or summaries/<slug>); anything else is refused\n" +
          " - folderPrefixLinks: { sourceFile, linkText }\n" +
          " - crossFolderDupes: { keep, remove }\n" +
          " - hyphenVariants: { files: [...], suggestedSlug }\n" +
          " - missingBacklinks: { summary, entity, summarySlug }\n" +
          " - orphanLink: { orphanSlug, targetSlug, description }\n" +
          " - semanticDupe: { keepSlug, keepFolder, removeSlug, removeFolder, rationale }",
      },
      preview: {
        type: 'boolean',
        description:
          "REQUIRED for semanticDupe on the first call (returns the diff plan without applying). For other types, preview is ignored — they apply directly.",
        default: false,
      },
    },
    required: ['type', 'issue'],
  },
};

export async function fixWikiIssueHandler(args, storage) {
  const domain = await resolveDomainArg(args, storage, getDefaultDomain);
  if (domain.error) return { ok: false, error: domain.error };

  // Decision 7 — refuse writes to Shared Brain mirror domains.
  const readonlyRefusal = await refuseIfReadonly(domain.value);
  if (readonlyRefusal) return readonlyRefusal;

  const { type, issue } = args || {};
  const preview = !!args?.preview;

  if (!type || typeof type !== 'string') return { ok: false, error: 'type is required' };
  if (!FIXABLE_TYPES.has(type))            return { ok: false, error: `Type "${type}" cannot be fixed via this tool. Valid: ${[...FIXABLE_TYPES].join(', ')}` };
  if (!AUTO_FIXABLE.has(type))             return { ok: false, error: `Type "${type}" is not auto-fixable in this codebase` };
  if (!issue || typeof issue !== 'object') return { ok: false, error: 'issue is required and must be an object' };

  // ── semanticDupe: hard preview gate ──────────────────────────────────────
  if (type === 'semanticDupe') {
    const key = previewKey(issue);
    if (preview) {
      const planned = await previewSemanticDuplicateMerge(domain.value, issue);
      if (key) SEMANTIC_DUPE_PREVIEWED.add(`${domain.value}|${key}`);
      return {
        ok: true,
        preview: true,
        domain: domain.value,
        type,
        plan: planned,
        report: `Preview: would merge '${planned.removePath}' into '${planned.keepPath}', rewriting links across ${planned.affectedCount} files. Confirm with the user, then call fix_wiki_issue again with preview: false.`,
      };
    }
    if (!key || !SEMANTIC_DUPE_PREVIEWED.has(`${domain.value}|${key}`)) {
      return {
        ok: false,
        error: 'semanticDupe merges require a preview first. Call this tool with preview: true to see the diff plan, present it to the user, then call again with preview: false.',
      };
    }
    // Consume the preview token so each merge requires a fresh preview.
    SEMANTIC_DUPE_PREVIEWED.delete(`${domain.value}|${key}`);
  }

  // v3.0.1-beta.8: respect the cross-process file lock. fixIssue() is
  // destructive on AUTO_FIXABLE types (mergeBulletSections + rm() on
  // crossFolderDupes / hyphenVariants / semanticDupe). Racing it against an
  // in-flight Curator-app ingest writing to the same files is a recipe for
  // confusing data loss.
  const releaseFileLock = await acquireFileLock(domainPath(domain.value), { op: 'mcp:fix_wiki_issue' });
  if (!releaseFileLock) {
    return {
      ok: false,
      error: `Another process is writing to "${domain.value}" right now (likely the Curator app). Wait a moment and retry. If you believe this is stale, delete <domains>/${domain.value}/.write-lock manually.`,
      conflict: 'file_lock',
    };
  }

  let result;
  try {
    result = await fixIssue(domain.value, type, issue);
  } finally {
    try { await releaseFileLock(); } catch { /* best-effort */ }
  }

  // Audit log (machine-private, gitignored)
  try {
    await storage.appendToWriteAudit(domain.value, {
      ts: new Date().toISOString(),
      tool: 'fix_wiki_issue',
      type,
      issue,
      result_summary: result?.fixed ? 'applied' : (result?.reason ? `no-op:${result.reason}` : 'no-op'),
    });
  } catch { /* best-effort */ }

  return {
    ok: true,
    domain: domain.value,
    type,
    fixed: result?.fixed || 0,
    // Machine-readable twin of the prose in `report`, so a caller can branch
    // without string-matching. Absent when the fix applied.
    ...(result?.reason ? { reason: result.reason } : {}),
    details: result || null,
    report: result?.fixed
      ? `Fixed 1 ${type} issue in '${domain.value}'.`
      : noOpReport(type, result?.reason, domain.value),
  };
}

/**
 * `fixed: 0` is not one outcome, so it must not render as one sentence.
 *
 * This used to be the single line "No changes applied (the issue may already
 * have been resolved)." — which a model correctly reads as "nothing to do here"
 * and moves on. It was returned verbatim for a `suggestedTarget` naming a page
 * that does not exist, and for an orphan issue passed in the scanner's shape
 * that this tool cannot consume: in both cases the wiki was NOT fixed and the
 * report said it may as well have been. Repeated across a scan of 47 orphans
 * that is a clean-sweep report over an entirely untouched domain.
 *
 * Each branch therefore states what was refused AND the next action, because a
 * refusal without a next step leaves "retry with another guess" as the model's
 * most available move — and on a corpus where `claude-sonnet-4.5` and
 * `claude-sonnet-3.5` are different pages, a retried guess is how a wrong link
 * gets written into every page that referenced it.
 */
function noOpReport(type, reason, domainName) {
  switch (reason) {
    case 'target-not-found':
      return `REFUSED — nothing was written. The suggestedTarget you supplied does not name a page that exists in '${domainName}', so retargeting to it would replace one broken link with another. Do NOT retry with a different guess: confirm the real slug with get_index or search_wiki, and if no page genuinely covers it, leave the link alone and tell the user (or point them at the app's bulk "Fix broken links" flow, which previews the whole plan). The broken link is still there.`;
    case 'no-suggested-target':
      return `REFUSED — nothing was written. This brokenLinks issue carries no suggestedTarget, and the scanner did not produce one because no deterministic match exists. Report it to the user as review-only rather than inventing a target. The broken link is still there.`;
    case 'source-file-not-found':
      return `REFUSED — nothing was written. sourceFile did not resolve to a page inside '${domainName}'. Pass the issue object exactly as scan_wiki_health returned it.`;
    case 'orphan-fields-missing':
      return `REFUSED — nothing was written. type="orphanLink" needs an issue of {orphanSlug, targetSlug, description}, which is NOT the shape scan_wiki_health emits for an orphan ({path, type, slug}). This is the one fixable type you must compose rather than pass through: orphanSlug is the orphan's slug, and targetSlug is an EXISTING entity or concept page that should link to it (never a summary). Choosing that target is your judgement, not the scanner's, so confirm it with the user first. The orphan is still unlinked.`;
    case 'slug-shape-invalid':
      return `REFUSED — nothing was written. orphanSlug and targetSlug must each be a bare slug (letters, digits, hyphens) with no folder prefix and no ".md". The orphan is still unlinked.`;
    case 'orphan-not-found':
      return `REFUSED — nothing was written. orphanSlug does not name a page in '${domainName}'. Use the "slug" field from the scan's orphan entry verbatim.`;
    case 'self-link':
      return `REFUSED — nothing was written. orphanSlug and targetSlug are the same page; a page cannot rescue itself. Pick a different existing page to link FROM.`;
    case 'link-already-present':
      return `No changes applied — the target page already links to that orphan, so this issue really was already resolved. Re-run scan_wiki_health to confirm it has cleared.`;
    case 'link-not-present':
      return `No changes applied — the target exists and the source file exists, but that [[link]] is no longer in it, so this issue really was already resolved. Re-run scan_wiki_health to confirm it has cleared.`;
    default:
      // Reached only by handlers that still return a bare boolean (the
      // scanner-only ones). The wording stays cautious rather than cheerful:
      // v3.6.1 finding 5's lesson is that a default arm must not fall into the
      // reassuring branch.
      return `No changes applied, and the reason was not reported. Do not assume the issue is resolved — re-run scan_wiki_health and check whether it is still listed.`;
  }
}

// ── scan_semantic_duplicates ─────────────────────────────────────────────────

export const scanSemanticDuplicatesDefinition = {
  name: 'scan_semantic_duplicates',
  description:
    "Find pages in the user's second brain that describe the same concept under different slugs — like [[email]] vs [[e-mail]], or [[rag]] vs [[retrieval-augmented-generation]]. " +
    "OPT-IN AND COSTED: this calls the LLM and has a small cost ($0.005–$0.03 typical on Gemini Flash Lite). Only run when the user explicitly asks. " +
    "Returns candidate duplicate pairs with confidence scores. Merging them goes through fix_wiki_issue with type=semanticDupe (which has its own preview/confirm gate). " +
    "Use the estimate_only: true flag first to show the user the cost before paying it.",
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: "Target domain slug. If omitted, uses the configured default domain.",
      },
      max_pairs: {
        type: 'integer',
        // 500 is the DEFAULT (config.js semanticDupeMaxPairs), not the ceiling.
        // Describing it as the range trained the model away from legal values
        // the schema and the handler both accept — a description contradicting
        // its own schema is worse on a MODEL-READ surface than one that is
        // merely vague, because the model believes it.
        description: "Cap candidate pairs. Lower = cheaper. Default 500 (from the user's AI Health settings); range 10–2000.",
        minimum: 10,
        maximum: 2000,
      },
      estimate_only: {
        type: 'boolean',
        description: "If true, return only the cost/page estimate without running the scan. Use this to preview cost before committing.",
        default: false,
      },
    },
    required: [],
  },
};

export async function scanSemanticDuplicatesHandler(args, storage) {
  const domain = await resolveDomainArg(args, storage, getDefaultDomain);
  if (domain.error) return { ok: false, error: domain.error };
  const { estimate_only } = args || {};
  const settings = getAiHealthSettings();
  const maxPairs = Math.max(10, Math.min(2000, args?.max_pairs ?? settings.semanticDupeMaxPairs));

  if (estimate_only) {
    try {
      const est = await estimateSemanticDuplicateScan(domain.value, maxPairs);
      // Build this line from fields the PRODUCER actually returns. The previous
      // version read `est.batches`, `est.estimatedInputTokens` and
      // `est.estimatedOutputTokens` — health-ai.js has never emitted any of the
      // three — so `.toLocaleString()` on undefined THREW and `estimate_only`
      // was 100% broken over MCP from v3.9.1 until v3.17.1. What hid it is that
      // `estimatedUsd?.` on the same line WAS optional-chained while its three
      // siblings were not: one guarded field reads as a guarded line.
      // It matters more than a cosmetic string, because the tool description
      // tells the caller to run `estimate_only` FIRST to see the cost before
      // paying it — so the documented cost gate failed, and the natural
      // recovery (call again without the flag) is to spend the money unseen.
      const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : 'unknown');
      // A fact and its ABSENCE stay distinguishable: `estimatedUsd: null` means
      // EITHER a free model OR no published price, and `costNote` is the field
      // that says which. Collapsing both to "$?" would report a free scan as an
      // unknown cost — the shape v3.15.0 removed from eight other places.
      const cost = est.costNote
        ? est.costNote
        : (typeof est.estimatedUsd === 'number' ? `~$${est.estimatedUsd.toFixed(4)}` : 'cost unknown');
      const scope = est.truncated
        ? `${n(est.candidatePairs)} of ${n(est.totalCandidates)} candidate pairs (capped)`
        : `${n(est.candidatePairs)} candidate pairs`;
      return {
        ok: true,
        domain: domain.value,
        estimate_only: true,
        estimate: est,
        report: `Estimate for '${domain.value}': ${scope} across ${n(est.pageCount)} pages. `
          + `Approx ${n(est.estimatedTokens)} tokens on ${est.model || 'the configured model'}. ${cost}`,
      };
    } catch (err) {
      return { ok: false, error: `Estimate failed: ${err.message}` };
    }
  }

  // Real scan — collect events into a single response since MCP doesn't stream.
  const pairs = [];
  let lastEvent = null;
  try {
    await scanSemanticDuplicates(
      domain.value,
      { maxPairs, costCeilingTokens: settings.costCeilingTokens },
      (event) => {
        if (event.type === 'pair') pairs.push(event.pair);
        else lastEvent = event;
      },
    );
  } catch (err) {
    return { ok: false, error: `Scan failed: ${err.message}` };
  }

  return {
    ok: true,
    domain: domain.value,
    pairs,
    cost: lastEvent?.cost || null,
    report: pairs.length === 0
      ? `No semantic duplicates found in '${domain.value}'.`
      : `Found ${pairs.length} candidate duplicate pair${pairs.length === 1 ? '' : 's'} in '${domain.value}'. Use fix_wiki_issue with type=semanticDupe (preview required first) to merge.`,
  };
}

// (resolveDomainArg lives in mcp/util.js — shared with dismissed.js so the
// default-domain fallback rule is implemented once.)
