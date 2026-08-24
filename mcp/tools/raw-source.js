/**
 * get_raw_source — Track 7 Part II: raw-source fidelity for Claude.
 *
 * A summary page is a lossy rendering of an original document: the LLM kept
 * what it judged important at ingest time. When Claude needs a direct quote,
 * an exact figure, or context the summary dropped, this tool goes back to the
 * source text the wiki was built from.
 *
 * ── BINARY IS NEVER EMITTED ─────────────────────────────────────────────
 * Most raw sources are PDFs. Their bytes must NEVER reach the JSON-RPC
 * stream — this is the same class of failure as the v2.5.3 stdout-pollution
 * bug, where non-protocol content on the wire broke Claude Desktop with
 * "Unexpected token … is not valid JSON". Two structural defenses:
 *
 *   1. We never touch `storage.readFile` for a raw source. That adapter
 *      forces 'utf8', which would not refuse a PDF — it would silently
 *      mangle it into replacement characters and hand it over.
 *   2. Extraction goes through `readRawSourceText` (raw-store.js), which
 *      runs the real PDF text extractor and REFUSES anything that does not
 *      decode as text, rather than emitting mojibake.
 *
 * Text is capped well under the 400 KB MCP response budget (see
 * MAX_EXTRACT_CHARS) and the response says so explicitly when truncated, so
 * Claude never silently reasons over a partial document believing it is
 * whole.
 *
 * ── STDOUT DISCIPLINE ───────────────────────────────────────────────────
 * This module and everything it imports run in the MCP stdio child process.
 * stdout is reserved for JSON-RPC frames: no `console.log` here, ever — use
 * `console.error` (v2.5.3).
 */

import { isValidDomain, isValidSlug, resolveDomainArg } from '../util.js';
// Same convention as every other domain-taking tool (compile.js, health.js,
// dismissed.js): the handler signature is (args, storage), and the default
// domain is imported directly rather than threaded through the call site.
import { getDefaultDomain } from '../../src/brain/config.js';

export const getRawSourceDefinition = {
  name: 'get_raw_source',
  description:
    'Retrieve the ORIGINAL document a summary page was built from — the actual source text, ' +
    'not the wiki\'s condensed version of it. Use this when the summary is not enough: when you ' +
    'need an exact quote, a precise figure, the author\'s own wording, or a detail the summary ' +
    'left out. Summaries are lossy by design; this is how you check them against the source. ' +
    'Returns extracted plain text (PDFs are text-extracted, never sent as binary), capped in ' +
    'size — the response tells you if it was truncated. Raw source files live only on the ' +
    'machine that ingested them and are not synced, so a source may be recorded but absent; ' +
    'in that case you still get its filename, size and ingest date.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description:
          'Summary page slug (from get_index or a [[summaries/<slug>]] link). ' +
          'A full path like "summaries/my-doc.md" is also accepted.',
      },
      domain: { type: 'string', description: 'Domain slug. Defaults to the configured default domain.' },
      max_chars: {
        type: 'number',
        description: 'Optional cap on returned text (default 122880). Lower it when you only need the opening.',
      },
    },
    required: ['slug'],
  },
};

/**
 * Accept either a bare slug ("my-doc") or a full summary path
 * ("summaries/my-doc.md"), and return the canonical wiki path — or null.
 *
 * Path-shaped input is reduced to its slug and re-validated with isValidSlug
 * rather than passed through, so no separator or traversal segment from the
 * caller ever reaches the reader: the path we hand downstream is built from
 * a validated slug, never concatenated from caller text.
 */
export function summaryPathFromSlug(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (s.toLowerCase().startsWith('summaries/')) s = s.slice('summaries/'.length);
  if (s.toLowerCase().endsWith('.md')) s = s.slice(0, -3);
  if (!isValidSlug(s)) return null;
  return `summaries/${s}.md`;
}

export async function getRawSourceHandler(args, storage) {
  const { slug, max_chars } = args || {};

  const resolvedDomain = await resolveDomainArg(args, storage, getDefaultDomain);
  if (resolvedDomain.error) return { ok: false, error: resolvedDomain.error };
  const domain = resolvedDomain.value;
  if (!isValidDomain(domain)) return { ok: false, error: `Invalid domain: ${domain}` };

  const summaryPath = summaryPathFromSlug(slug);
  if (!summaryPath) {
    return {
      ok: false,
      error: `Invalid summary slug "${slug}". Pass a summary slug from get_index, e.g. "my-document".`,
    };
  }

  // Lazy import so the MCP's startup path stays lean and the brain modules
  // load only when a raw-source call actually fires (same pattern as
  // refuseIfReadonly in util.js).
  const { sourceForSummary, readRawSourceText, findManifestRecord, MAX_EXTRACT_CHARS } =
    await import('../../src/brain/raw-store.js');

  let found;
  try {
    found = await sourceForSummary(domain, summaryPath);
  } catch (err) {
    // getWikiPage throws with .status for an unknown page / bad path.
    return {
      ok: false,
      error: err?.status === 404
        ? `Summary "${summaryPath}" not found in domain "${domain}". Use get_index to browse summaries.`
        : `Could not read "${summaryPath}": ${err?.message || 'unknown error'}`,
    };
  }

  if (!found.found) {
    // Missing blob is the interesting case: raw/ is gitignored and does not
    // sync, so a second machine legitimately has the record and not the file.
    // Report what IS known rather than a bare "not found" — the filename,
    // size and ingest date are often enough for the user to go get it.
    const record = found.manifest || await findManifestRecord(domain, found.declaredSource);
    return {
      ok: true,
      found: false,
      domain,
      summary: summaryPath,
      reason: found.reason,
      declared_source: found.declaredSource || null,
      message: found.message,
      ...(record ? {
        known_from_manifest: {
          filename: record.filename,
          bytes: record.bytes,
          sha256: record.sha256,
          ingested_at: record.ingestedAt,
        },
      } : {}),
    };
  }

  const cap = Number.isFinite(max_chars) && max_chars > 0
    ? Math.min(Math.floor(max_chars), MAX_EXTRACT_CHARS)
    : MAX_EXTRACT_CHARS;

  const extracted = await readRawSourceText(found.absPath, cap);

  if (!extracted.ok) {
    // Binary or unreadable. We still report the file's identity — that it
    // exists and how big it is — but never its bytes.
    return {
      ok: true,
      found: true,
      domain,
      summary: summaryPath,
      filename: found.filename,
      bytes: found.bytes,
      text: null,
      text_unavailable: extracted.reason,
      message: extracted.message,
    };
  }

  return {
    ok: true,
    found: true,
    domain,
    summary: summaryPath,
    filename: found.filename,
    bytes: found.bytes,
    mtime: found.mtime,
    truncated: extracted.truncated,
    total_chars: extracted.totalChars,
    returned_chars: extracted.text.length,
    ...(extracted.truncated ? {
      truncation_notice:
        `This is the FIRST ${extracted.text.length} of ${extracted.totalChars} characters of the ` +
        `original document — the rest was not sent. Do not treat it as the complete source; if ` +
        `what you need is not here, say so rather than assuming the document does not contain it.`,
    } : {}),
    text: extracted.text,
  };
}
