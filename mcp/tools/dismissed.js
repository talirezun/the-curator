/**
 * Dismissal tools — v2.5.2 MCP
 *
 * Persistent skip-store control from Claude Desktop. The same JSONL file
 * (domains/<d>/wiki/.health-dismissed.jsonl) is shared with the in-app
 * Health panel, which lives inside the Domains view since the v3.9.0
 * cutover moved Health out of the rail — dismissals made here are visible
 * in the Curator app's
 * Dismissed (N) section, and vice versa. Stale records prune automatically
 * via loadDismissed (v2.5.1+).
 */

import {
  addDismissal,
  removeDismissal,
  listDismissed,
  keyForIssue,
} from '../../src/brain/health-dismissed.js';
import { getDefaultDomain } from '../../src/brain/config.js';
import { resolveDomainArg, refuseIfReadonly } from '../util.js';

/**
 * The types these two tools accept, and the SINGLE source for both the runtime
 * gate and the schema below.
 *
 * These are the SCANNER'S OWN type names — `orphans`, the plural, is what
 * `scanWiki` emits and what a dismissal record is keyed on. It is deliberately
 * NOT the same set `fix_wiki_issue` takes: that one gates on `AUTO_FIXABLE`,
 * which carries the pseudo-type `orphanLink` (an AI rescue suggestion, never
 * emitted by a scan) and has no `orphans` at all. Two surfaces, two questions
 * — "may I hide this?" and "may I write this?" — and the answer legitimately
 * differs. The trap is only that the difference used to live in PROSE on both
 * sides, so `orphans` vs `orphanLink` was one typo away from a model being
 * refused by a tool whose own description had told it that value was fine.
 */
const DISMISSIBLE_TYPES = new Set([
  'brokenLinks',
  'orphans',
  'folderPrefixLinks',
  'crossFolderDupes',
  'hyphenVariants',
  'missingBacklinks',
  'semanticDupe',
]);

/**
 * The schema's `enum`, DERIVED from the gate above rather than re-typed beside
 * it. An MCP client validates arguments against the schema before the call is
 * made, so this is the difference between a model being told the accepted
 * values up front and discovering them from a refusal string. Exported so a
 * suite can assert the schema and the runtime gate are the same set — the only
 * thing that keeps them from drifting the way the prose did.
 */
export const DISMISSIBLE_TYPE_VALUES = Object.freeze([...DISMISSIBLE_TYPES]);

// ── get_health_dismissed ─────────────────────────────────────────────────────

export const getHealthDismissedDefinition = {
  name: 'get_health_dismissed',
  description:
    "List the wiki Health issues the user has previously dismissed (skipped, marked as 'leave alone'). " +
    "Use this when the user asks 'what have I dismissed?', 'show me what I'm ignoring', or to proactively offer un-dismissing an old skip. " +
    "Records are stored in domains/<d>/wiki/.health-dismissed.jsonl and sync across machines via the existing GitHub sync.",
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: "Target domain slug. If omitted, uses the default domain." },
    },
    required: [],
  },
};

export async function getHealthDismissedHandler(args, storage) {
  const domain = await resolveDomainArg(args, storage, getDefaultDomain);
  if (domain.error) return { ok: false, error: domain.error };

  const records = await listDismissed(domain.value);
  return {
    ok: true,
    domain: domain.value,
    count: records.length,
    records,
    report:
      records.length === 0
        ? `No dismissed issues in '${domain.value}'.`
        : `${records.length} dismissed issue${records.length === 1 ? '' : 's'} in '${domain.value}'.`,
  };
}

// ── dismiss_wiki_issue ───────────────────────────────────────────────────────

export const dismissWikiIssueDefinition = {
  name: 'dismiss_wiki_issue',
  description:
    "Mark a wiki Health issue as 'not-a-problem' so it stops surfacing on future scans. " +
    "Use when the user says they don't want to fix an issue and want it permanently silenced — e.g. an orphan they're keeping intentionally, " +
    "a broken link in a draft, two pages flagged as semantic duplicates that the user wants to keep separate. " +
    "Persists to domains/<d>/wiki/.health-dismissed.jsonl and syncs across the user's machines automatically. " +
    "Reversible — see undismiss_wiki_issue.",
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: "Target domain slug. If omitted, uses the default domain." },
      type: {
        type: 'string',
        enum: [...DISMISSIBLE_TYPE_VALUES],
        // Composed from the enum, so the sentence a model reads and the values
        // the handler accepts cannot say different things.
        description: `Issue type — exactly as scan_wiki_health reports it. One of: ${DISMISSIBLE_TYPE_VALUES.join(', ')}.`,
      },
      issue: {
        type: 'object',
        description:
          "The issue object as returned by scan_wiki_health. Field shape depends on type — pass the same object you got from the scan. " +
          "For semanticDupe specifically: { slugA, folderA, slugB, folderB } (order doesn't matter — keys are alphabetised).",
      },
    },
    required: ['type', 'issue'],
  },
};

export async function dismissWikiIssueHandler(args, storage) {
  const domain = await resolveDomainArg(args, storage, getDefaultDomain);
  if (domain.error) return { ok: false, error: domain.error };

  // Decision 7 — refuse writes to Shared Brain mirror domains.
  const readonlyRefusal = await refuseIfReadonly(domain.value);
  if (readonlyRefusal) return readonlyRefusal;

  const { type, issue } = args || {};

  if (!type || typeof type !== 'string') return { ok: false, error: 'type is required' };
  if (!DISMISSIBLE_TYPES.has(type))         return { ok: false, error: `Type "${type}" cannot be dismissed.` };
  if (!issue || typeof issue !== 'object')  return { ok: false, error: 'issue is required and must be an object' };

  const result = await addDismissal(domain.value, type, issue);
  if (!result.ok) return { ok: false, error: result.reason };

  // Audit log
  try {
    await storage.appendToWriteAudit(domain.value, {
      ts: new Date().toISOString(),
      tool: 'dismiss_wiki_issue',
      type,
      issue,
      already_dismissed: !!result.alreadyDismissed,
    });
  } catch { /* best-effort */ }

  return {
    ok: true,
    domain: domain.value,
    type,
    key: keyForIssue(type, issue),
    already_dismissed: !!result.alreadyDismissed,
    report: result.alreadyDismissed
      ? `Already dismissed — no change.`
      : `Dismissed. This issue will no longer surface in '${domain.value}' Health scans.`,
  };
}

// ── undismiss_wiki_issue ─────────────────────────────────────────────────────

export const undismissWikiIssueDefinition = {
  name: 'undismiss_wiki_issue',
  description:
    "Restore a previously dismissed wiki Health issue so it surfaces again on future scans. " +
    "Use when the user changes their mind about a skipped issue or asks to 'bring back' something they dismissed. " +
    "Pair with get_health_dismissed to find the record to restore.",
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: "Target domain slug. If omitted, uses the default domain." },
      type: {
        type: 'string',
        enum: [...DISMISSIBLE_TYPE_VALUES],
        description: `The type the record was dismissed under — the same set dismiss_wiki_issue takes. One of: ${DISMISSIBLE_TYPE_VALUES.join(', ')}.`,
      },
      issue: {
        type: 'object',
        description: "The same issue object that was dismissed. Pass the record returned by get_health_dismissed verbatim.",
      },
    },
    required: ['type', 'issue'],
  },
};

export async function undismissWikiIssueHandler(args, storage) {
  const domain = await resolveDomainArg(args, storage, getDefaultDomain);
  if (domain.error) return { ok: false, error: domain.error };

  // Decision 7 — refuse writes to Shared Brain mirror domains.
  const readonlyRefusal = await refuseIfReadonly(domain.value);
  if (readonlyRefusal) return readonlyRefusal;

  const { type, issue } = args || {};

  if (!type || typeof type !== 'string') return { ok: false, error: 'type is required' };
  if (!DISMISSIBLE_TYPES.has(type))         return { ok: false, error: `Type "${type}" cannot be un-dismissed.` };
  if (!issue || typeof issue !== 'object')  return { ok: false, error: 'issue is required and must be an object' };

  // For semanticDupe, the user may pass the stored record (slugs array) or the
  // pair shape (slugA/slugB). Normalise to the pair shape for keyForIssue.
  let normalisedIssue = issue;
  if (type === 'semanticDupe' && Array.isArray(issue.slugs) && issue.slugs.length === 2) {
    normalisedIssue = {
      slugA: issue.slugs[0],
      slugB: issue.slugs[1],
      folderA: issue.folderA || issue.folder || 'entities',
      folderB: issue.folderB || issue.folder || 'entities',
    };
  }

  const result = await removeDismissal(domain.value, type, normalisedIssue);
  if (!result.ok) return { ok: false, error: result.reason };

  try {
    await storage.appendToWriteAudit(domain.value, {
      ts: new Date().toISOString(),
      tool: 'undismiss_wiki_issue',
      type,
      issue: normalisedIssue,
      not_found: !!result.notFound,
    });
  } catch { /* best-effort */ }

  return {
    ok: true,
    domain: domain.value,
    type,
    not_found: !!result.notFound,
    report: result.notFound
      ? `No matching dismissal found — nothing to restore.`
      : `Restored. The issue will surface again on the next scan_wiki_health call.`,
  };
}

// (resolveDomainArg lives in mcp/util.js — shared with health.js so the
// default-domain fallback rule is implemented once.)
