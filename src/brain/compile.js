/**
 * Conversation compilation — v2.5.0
 *
 * Compiles a saved chat conversation into wiki pages, treating the dialogue
 * as a source document. Single LLM call (conversations are typically much
 * shorter than ingested PDFs, so multi-phase isn't needed). Reuses the same
 * write pipeline as ingest: writePage → syncSummaryEntities → appendLog.
 *
 * Public API:
 *   compileConversation(domain, conversationId, onProgress?)
 *     → { ok: true,  title, pagesWritten, changes }
 *     → { ok: false, reason | error }
 */

import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { generateText } from './llm.js';
import { parseJSON, isOutputTokenLimit } from './ingest.js';
import {
  readSchema,
  readIndex,
  readConversation,
  wikiPath,
  writePage,
  appendLog,
  syncSummaryEntities,
} from './files.js';

// A single rich question→answer exchange is worth compiling (v3.0.1-beta.15).
// Lowered from 2 so the "Compile to Wiki" button appears after the first answer.
//
// EXPORTED since v3.27.0 so the cost estimator can quote the same floor rather
// than keeping a second copy of it. The estimator's refusals are produced by
// `precheckCompile` below — the SAME function compileConversation itself calls —
// so an estimate can never say "this will cost $x" about a conversation the
// compile is about to refuse for free.
export const MIN_USER_MESSAGES = 1;

/**
 * Lowercase, alphanumeric, hyphenated slug. Max length capped to keep
 * filenames sensible. Mirrors the slugify rules used elsewhere in the wiki.
 */
function slugifyTitle(title, max = 60) {
  return (title || 'conversation')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')   // strip punctuation
    .trim()
    .replace(/\s+/g, '-')        // spaces → hyphens
    .replace(/_/g, '-')          // underscores → hyphens (wiki convention)
    .replace(/-+/g, '-')         // collapse runs
    .slice(0, max)
    .replace(/-+$/, '');         // no trailing hyphen
}

/**
 * 4-char hex hash of conversation content. Idempotent: re-compiling the same
 * conversation produces the same hash → same slug → file overwritten cleanly
 * via the existing merge pipeline. Different content → different hash → new
 * file (no silent collision).
 */
function shortHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 4);
}

function computeSummarySlug(conversation, messages, today) {
  const titleSlug = slugifyTitle(conversation.title);
  const corpus = messages.map(m => `${m.role}:${m.content}`).join('\n');
  const hash = shortHash(corpus);
  return `${titleSlug}-${today}-${hash}`;
}

/**
 * Everything `compileConversation` decides BEFORE it spends a cent, factored
 * out so the cost estimator can reach the identical decision.
 *
 * ── WHY THIS IS ONE FUNCTION AND NOT TWO AGREEING COPIES ────────────────────
 * The estimator's whole job is to be believed. An estimate that quotes a price
 * for a conversation the compile is about to refuse — too short, or already
 * compiled — is worse than no estimate: the user pre-authorises a spend that
 * never happens and learns the app's numbers do not describe the app. So the
 * refusal is PRODUCED HERE and consumed by both callers, in the same order and
 * with the same wording. There is no second copy to drift.
 *
 * Returns either `{ refusal: string }` — the exact `result.reason` the compile
 * would have returned — or the full context both callers need:
 *   `{ conversation, messages, userTurns, summaryPath, summarySlug, today }`
 *
 * `messages` is normalised to an array here. Before this refactor a malformed
 * conversation JSON (no `messages` key) threw a raw TypeError out of
 * `.filter`; it now falls to the "too short" refusal, which is the same
 * outcome a user would want and strictly safer. That is the ONLY behavioural
 * change: for every well-formed conversation the refusals, their wording and
 * their order are byte-identical to what compileConversation did before.
 *
 * @param {string} domain
 * @param {string} conversationId
 * @param {string} [today]  ISO date; defaults to today. Passed explicitly by
 *   compileConversation so the slug the estimate quoted and the slug the
 *   compile writes cannot disagree across a midnight boundary within one call.
 */
export async function precheckCompile(domain, conversationId, today = new Date().toISOString().slice(0, 10)) {
  const conversation = await readConversation(domain, conversationId);
  if (!conversation) return { refusal: 'Conversation not found' };

  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const userTurns = messages.filter(m => m && m.role === 'user').length;
  if (userTurns < MIN_USER_MESSAGES) {
    return {
      refusal: `Conversation too short to compile (need at least ${MIN_USER_MESSAGES} user messages, got ${userTurns})`,
    };
  }

  // The slug is a function of (title, date, content-hash), so if the summary
  // file already exists at this exact path, the conversation has not gained any
  // new turns since the last compile. Re-running the LLM would still produce
  // slightly different output and the bullet-merge pipeline would silently
  // inflate every related page's Related/Key Facts sections.
  const summarySlug = computeSummarySlug(conversation, messages, today);
  const summaryPath = `summaries/${summarySlug}.md`;
  if (existsSync(path.join(wikiPath(domain), summaryPath))) {
    return {
      refusal: `Already compiled to ${summaryPath}. Send another message in this conversation to extend it, or delete that file in your wiki to start over.`,
    };
  }

  return { conversation, messages, userTurns, summarySlug, summaryPath, today };
}

/**
 * Format the conversation as a transcript readable by the LLM. Roles are
 * spelled out so the model can distinguish "User said X" from "Assistant
 * replied Y" — important when extracting which insights came from where.
 */
function formatTranscript(messages) {
  return messages.map(m => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    return `${role}: ${m.content}`;
  }).join('\n\n');
}

export function buildCompilePrompt({ today, existingFiles, conversation, summaryPath, mode = 'full' }) {
  const transcript = formatTranscript(conversation.messages);
  const entityFileList = existingFiles.entities.length
    ? existingFiles.entities.map(f => `  entities/${f}`).join('\n')
    : '  (none yet)';
  const conceptFileList = existingFiles.concepts.length
    ? existingFiles.concepts.map(f => `  concepts/${f}`).join('\n')
    : '  (none yet)';

  // v3.0.1-beta.27 (Fix #2): summary-only fallback. When the full and concise
  // extractions both overflowed the output-token limit, we ask for ONLY the
  // summary page so the conversation is still captured (degraded but useful)
  // rather than the compile failing outright. Mirrors ingest's "reduce scope on
  // overflow" safety net. The page flows through the same writePage pipeline.
  if (mode === 'summary-only') {
    return `Today's date: ${today}

You are compiling a conversation into a persistent knowledge wiki, but a previous
attempt produced too much output. Produce ONLY a single summary page — do NOT
create any entity or concept pages this time.

--- CONVERSATION (title: "${conversation.title || 'untitled'}") ---
${transcript}
--- END CONVERSATION ---

REQUIRED summary page path: "${summaryPath}"
You MUST use this exact path. Do NOT invent another summaries/ path.

Write the summary page: capture what was learned, the conclusions reached, and
which entities/concepts were discussed. Keep it to 5–10 concise bullet points.
You MAY mention entities/concepts as [[wikilinks]] using the EXACT slug from the
existing filenames below, but do NOT create separate pages for them.

Existing entity files:
${entityFileList}

Existing concept files:
${conceptFileList}

Page body rules:
- Do NOT include YAML frontmatter (--- blocks) — added automatically.
- Include a "Tags: tag1, tag2" line.
- Links: always [[page-name]] — NEVER [[concepts/x]] or [[entities/x]] (folder prefix forbidden).

Return ONLY valid JSON in this exact shape (no markdown fences, no commentary):
{
  "title": "human-readable title for this compilation",
  "pages": [
    { "path": "${summaryPath}", "content": "...", "summary": "1-line description for the index" }
  ]
}`;
  }

  // v3.0.1-beta.27 (Fix #2): concise retry. Inserted when the full extraction
  // overflowed the output-token limit. Asks for fewer, broader pages and shorter
  // content so the response fits — still creates entity/concept pages, just terser.
  const conciseDirective = mode === 'concise'
    ? `\n⚠ RETRY — the previous attempt produced TOO MUCH output and was cut off.
Be much more economical this time:
- Create AT MOST ~10 pages total. Consolidate closely-related entities/concepts
  into a single broader page instead of many small ones.
- Cap each page at 3–5 short bullets.
- ALWAYS include the summary page.
\n`
    : '';

  // Note: the domain schema is delivered via `generateText`'s systemPrompt
  // argument (same pattern ingest uses). Do NOT embed it again in the user
  // prompt body — that doubles input tokens on every compile.
  //
  // v3.0.1-beta.25 (Fix #1): the full index.md is deliberately NOT included
  // here. On a large domain the index is tens of KB (96 KB on the dev machine's
  // articles domain); feeding that bloated, repetitive table into the request
  // pushed Gemini into a degeneration/repeat loop that filled the entire output
  // budget and surfaced as "hit the output token limit (65536 tokens)". The LLM
  // does not need the index: link grounding comes from the entity/concept
  // filename lists above, the summary path is forced below, and the app updates
  // index.md programmatically via mergeIntoIndex AFTER this call (the LLM is told
  // not to touch it). Removing the index is the root-cause fix — do not re-add it.
  return `Today's date: ${today}
${conciseDirective}
You are compiling a conversation into a persistent knowledge wiki.
Extract durable knowledge — facts, insights, concepts, and conclusions
that emerged from the dialogue. Treat the conversation as a source document.
Write pages a reader could consult months later WITHOUT needing to re-read
the conversation. Do NOT reproduce the transcript verbatim — synthesise.

EXISTING WIKI FILES — reuse these exact filenames for known entities/concepts.
Do NOT invent variants (e.g. if "lumina-ai.md" exists, do NOT create "lumina.md").
Only create a new file for a genuinely new entity/concept not already present.

Existing entity files:
${entityFileList}

Existing concept files:
${conceptFileList}

--- CONVERSATION (title: "${conversation.title || 'untitled'}") ---
${transcript}
--- END CONVERSATION ---

REQUIRED summary page path: "${summaryPath}"
You MUST use this exact path for the summary page. Do NOT invent another summaries/ path.

Your task:
1. Write the summary page at the path above — capture what was learned, the
   conclusions reached, and which entities/concepts were discussed. Include a
   "Concepts Introduced or Referenced" section with [[wikilinks]] and an
   "Entities Mentioned" section with [[wikilinks]] for every relevant page.
2. Create or update entity pages for any people, tools, companies, datasets,
   or frameworks central to the discussion (only if not already in existing files).
3. Create or update concept pages for any key ideas, principles, methodologies,
   or techniques that emerged (only if not already in existing files).
4. Add cross-references between related pages using [[page-name]] syntax.
5. DO NOT touch index.md — the application updates it after this call.

Page body rules:
- Each page: 3–8 concise bullet points or sentences. No long prose.
- Do NOT include YAML frontmatter (--- blocks) — added automatically.
- Entity pages: include a "Type: <entity-type>" line and a "Tags: tag1, tag2" line.
- Concept and summary pages: include a "Tags: tag1, tag2" line.
- Links: always [[page-name]] — NEVER [[concepts/x]] or [[entities/x]] (folder prefix forbidden).
  Exception: [[summaries/...]] keeps its prefix.
- LINK ACCURACY: Use the EXACT slug from existing filenames when linking.
  If the entity file is iea.md, write [[iea]], NOT [[international-energy-agency]].

CRITICAL — Valid folder prefixes for page paths:
  • summaries/  — exactly one summary page (path is fixed above)
  • entities/   — every person, tool, company, framework, dataset, organization
  • concepts/   — every idea, technique, principle, methodology
NEVER use any other folder. Every page path MUST start with one of the three.

CROSS-FOLDER RULE: If a file already exists in entities/, do NOT create a
concepts/ file with the same or similar name, and vice versa.

Each "page.summary" is a 1-line description that will be added to the index.
Keep each summary under 160 characters.

Return ONLY valid JSON in this exact shape (no markdown fences, no commentary,
no index.md content — the app maintains the index itself):
{
  "title": "human-readable title for this compilation",
  "pages": [
    { "path": "${summaryPath}", "content": "...", "summary": "1-line description for the index" },
    { "path": "concepts/some-concept.md", "content": "...", "summary": "1-line description" },
    { "path": "entities/some-entity.md", "content": "...", "summary": "1-line description" }
  ]
}`;
}

/**
 * Programmatically merge new pages into the existing index.md.
 *
 * Replaces the LLM-driven index regeneration that blew the output budget on
 * large domains (a 20 KB markdown table can saturate the response with one
 * field). Reads the existing index, appends rows for any newly-created pages
 * that aren't already in the table, leaves all existing rows untouched.
 *
 * @param {string}   existingIndex  current index.md content
 * @param {object[]} pages          [{path, content, summary}] from the LLM
 * @param {object[]} writeRecords   [{originalPath, record}] aligned 1:1 with `pages`
 *                                  so we can look up summaries by post-write
 *                                  canonical path (writePage may redirect via
 *                                  cross-folder dedup, hyphen normalisation, etc.)
 */
export function mergeIntoIndex(existingIndex, pages, writeRecords) {
  // Build a quick lookup of pages already mentioned in the index
  const mentioned = new Set();
  const wikiLinkRe = /\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = wikiLinkRe.exec(existingIndex)) !== null) {
    // Strip folder prefix (summaries/foo → foo) for normalised comparison
    const slug = m[1].split('/').pop();
    mentioned.add(slug);
  }

  // Pair the LLM's per-page summary with the canonical post-write path. The
  // LLM emits {path, content, summary}; writePage may have redirected `path`
  // (e.g. concepts/Google.md → entities/google.md), so we map by record index
  // — pages[i] produced writeRecords[i].
  const summaryByCanon = new Map();
  for (let i = 0; i < writeRecords.length; i++) {
    const entry = writeRecords[i];
    if (!entry || !entry.record) continue;
    const llmSummary = pages[i] && pages[i].summary;
    if (llmSummary) summaryByCanon.set(entry.record.canonPath, llmSummary);
  }

  // Sanitise a free-form LLM summary string for safe inclusion in a markdown
  // table cell: strip pipes (column separator), strip newlines (row break),
  // collapse whitespace, cap length.
  const cellSafe = (s) => String(s || '')
    .replace(/[|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);

  const newRows = [];
  for (const entry of writeRecords) {
    if (!entry || !entry.record || entry.record.status !== 'created') continue;
    const canon = entry.record.canonPath;
    const slug = canon.replace(/\.md$/, '').split('/').pop();
    if (mentioned.has(slug)) continue; // already in index from a prior ingest

    const folder = canon.split('/')[0]; // entities | concepts | summaries
    const type =
      folder === 'entities' ? 'entity' :
      folder === 'concepts' ? 'concept' :
      'summary';

    const linkSlug = folder === 'summaries' ? `summaries/${slug}` : slug;
    const summary = cellSafe(summaryByCanon.get(canon));
    newRows.push(`| [[${linkSlug}]] | ${type} | ${summary} |`);
  }

  if (newRows.length === 0) {
    // Nothing new to add — return null so the caller can skip the index write.
    return null;
  }

  // Detect a markdown table and append rows after the last table row.
  // If the existing index has no table, append new rows under a heading.
  const lines = existingIndex.split('\n');
  let lastTableLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\|/.test(lines[i])) lastTableLine = i;
  }

  if (lastTableLine >= 0) {
    lines.splice(lastTableLine + 1, 0, ...newRows);
    return lines.join('\n');
  }

  // No table found — append a fresh table at the end.
  return existingIndex.trimEnd() + `\n\n## New pages\n\n| Page | Type | Summary |\n|---|---|---|\n${newRows.join('\n')}\n`;
}

export async function compileConversation(domain, conversationId, onProgress = () => {}, opts = {}) {
  const progress = (pct, message) => onProgress({ pct, message });
  // Test seam (v3.0.1-beta.27): allow injecting a fake LLM to exercise the
  // fallback ladder deterministically offline. Defaults to the real generateText.
  const llm = opts.generateText || generateText;

  // 1-4a. Load the conversation and take every pre-spend decision — not
  //        found, too short, already compiled — through the SAME function the
  //        cost estimator calls, so an estimate and a compile can never
  //        disagree about whether this conversation is compilable.
  //        (If the user adds a new message the corpus hash changes → new slug →
  //        no collision → compile proceeds normally. Cross-day compiles also
  //        proceed, because the date is part of the slug.)
  progress(5, 'Loading conversation…');
  const pre = await precheckCompile(domain, conversationId);
  if (pre.refusal) return { ok: false, reason: pre.refusal };
  const { conversation, summaryPath, today } = pre;

  // 3. Load domain context
  progress(10, 'Loading domain context…');
  const schema = await readSchema(domain);
  const index = await readIndex(domain);

  const wikiDir = wikiPath(domain);
  const existingFiles = {
    entities: await readdir(path.join(wikiDir, 'entities'))
      .then(f => f.filter(x => x.endsWith('.md')))
      .catch(() => []),
    concepts: await readdir(path.join(wikiDir, 'concepts'))
      .then(f => f.filter(x => x.endsWith('.md')))
      .catch(() => []),
  };

  // 5. Extract knowledge into wiki pages via the LLM, with a graceful fallback
  //    ladder on output-token overflow (Fix #2, v3.0.1-beta.27). Mirrors ingest's
  //    "reduce scope on overflow" safety net:
  //      full → concise (fewer/broader pages) → summary-only (just the summary).
  //    A step escalates ONLY on an output-token-limit error (or a JSON parse
  //    failure — a smaller response parses cleaner). ANY OTHER LLM error
  //    (503/429/auth/network) surfaces immediately, so we never mask a real
  //    failure or burn retries on a provider outage. Output budget stays 65536;
  //    the concise/summary-only prompts naturally produce far less.
  const warnings = [];
  const ATTEMPTS = [
    { mode: 'full', pct: 20, msg: 'AI is extracting knowledge from the conversation…', note: null },
    { mode: 'concise', pct: 30, msg: 'That was large — retrying with a more concise extraction…',
      note: 'The conversation was large, so it was compiled with a more concise extraction (fewer, broader pages).' },
    { mode: 'summary-only', pct: 30, msg: 'Still too large — saving a summary page only…',
      note: 'The conversation was too large for full extraction, so only a summary page was saved. Entity and concept pages were not created — compile a shorter thread to capture more detail.' },
  ];

  let result = null;
  let lastErr = null;
  for (let i = 0; i < ATTEMPTS.length; i++) {
    const attempt = ATTEMPTS[i];
    const isLast = i === ATTEMPTS.length - 1;
    progress(attempt.pct, attempt.msg);

    let raw;
    try {
      raw = (await llm(
        schema,
        // Note: `index` is intentionally NOT passed to the prompt (Fix #1, see
        // buildCompilePrompt). It is still read above for mergeIntoIndex below.
        buildCompilePrompt({ today, existingFiles, conversation, summaryPath, mode: attempt.mode }),
        65536,
        'json',
        (msg) => progress(attempt.pct, msg),
      )).trim();
    } catch (err) {
      lastErr = err;
      // Only an output-token overflow escalates to the next (smaller) attempt.
      // Any other error is real (503/429/auth/network) — stop and surface it.
      if (isOutputTokenLimit(err) && !isLast) continue;
      break;
    }

    let parsed;
    try {
      parsed = parseJSON(raw);
    } catch (err) {
      lastErr = err;
      console.error(`[compile] JSON parse failed (mode=${attempt.mode}). First 300 chars:`, raw.slice(0, 300));
      // A parse failure on a large response is usually size-related; the next,
      // smaller attempt is far more likely to parse. Out of attempts → error.
      if (!isLast) continue;
      break;
    }

    if (!parsed.pages || !Array.isArray(parsed.pages) || parsed.pages.length === 0) {
      lastErr = new Error('AI returned no pages to write');
      if (!isLast) continue;
      break;
    }

    // Success — record any degradation note so the user knows what happened.
    result = parsed;
    if (attempt.note) warnings.push(attempt.note);
    break;
  }

  if (!result) {
    // All attempts exhausted. Give COMPILE-SPECIFIC guidance — never ingest's
    // "split the PDF by chapter" (the user compiled a CONVERSATION, not a file).
    if (lastErr && isOutputTokenLimit(lastErr)) {
      return {
        ok: false,
        error: `This conversation is too large or complex to compile — the AI kept exceeding its output limit even after retrying with a shorter extraction. ` +
               `What to do: compile a shorter conversation (fewer or shorter messages), or split this discussion into separate conversations by topic and compile each one. ` +
               `(This is an AI output-size limit, not a problem with The Curator or your data.)`,
      };
    }
    return { ok: false, error: `LLM call failed: ${lastErr ? lastErr.message : 'unknown error'}` };
  }

  // 6. Deduplicate pages by path (LLM occasionally returns the same path twice)
  {
    const seen = new Map();
    for (const page of result.pages) seen.set(page.path, page);
    result.pages = [...seen.values()];
  }

  // 7. Force the summary page to our canonical path. If the LLM ignored the
  //    instruction and produced summaries/<other-slug>.md, rewrite it. We do
  //    this BEFORE writing so the slug is stable everywhere.
  let summaryFound = false;
  for (const page of result.pages) {
    if (page.path === summaryPath) { summaryFound = true; continue; }
    if (page.path.startsWith('summaries/') && !summaryFound) {
      console.warn(`[compile] LLM used non-canonical summary path "${page.path}" — rewriting to "${summaryPath}"`);
      page.path = summaryPath;
      summaryFound = true;
    }
  }
  if (!summaryFound) {
    return { ok: false, error: 'AI did not produce a summary page' };
  }

  // 8. Write all pages — collect canonical paths and change records.
  //    `writeRecords` is aligned 1:1 with `result.pages` (or null when writePage
  //    refused the input). mergeIntoIndex uses this alignment to look up the
  //    LLM-supplied `page.summary` by the post-write canonical path, since
  //    writePage may have redirected (cross-folder dedup, hyphen normalisation).
  progress(85, `Writing ${result.pages.length} pages to wiki…`);
  const canonicalPaths = [];
  const changes = [];
  const writeRecords = [];
  for (const page of result.pages) {
    const record = await writePage(domain, page.path, page.content);
    writeRecords.push(record ? { originalPath: page.path, record } : null);
    if (record) {
      canonicalPaths.push(record.canonPath);
      changes.push(record);
    }
  }

  // 9. Reconcile the summary's "Entities Mentioned" with every entity/concept
  //    actually written this compile (mirrors the ingest pipeline's step).
  progress(92, 'Syncing entity backlinks…');
  const summaryCanonPath = canonicalPaths.find(p => p.startsWith('summaries/'));
  if (summaryCanonPath) {
    await syncSummaryEntities(domain, summaryCanonPath, canonicalPaths);
  }

  // 10. Programmatically append new pages to the existing index.md.
  //     We do NOT ask the LLM to regenerate the index — on large domains the
  //     20+ KB markdown table saturates the output budget and breaks JSON.
  //     Instead, we read the current index, append rows for any pages this
  //     compile actually CREATED (not updates), and write it back.
  progress(96, 'Updating index…');
  const mergedIndex = mergeIntoIndex(index, result.pages, writeRecords);
  if (mergedIndex) {
    const indexRecord = await writePage(domain, 'index.md', mergedIndex);
    if (indexRecord) changes.push(indexRecord);
  }

  // 11. Append to log
  const compileTitle = result.title || conversation.title || 'Compiled conversation';
  const pageList = canonicalPaths.map(p => `  - ${p}`).join('\n');
  const logEntry = `## [${today}] compile | ${compileTitle}\nFrom conversation: "${conversation.title || conversation.id}"\nPages created or updated:\n${pageList}\n`;
  await appendLog(domain, logEntry);

  progress(100, 'Done!');
  return {
    ok: true,
    title: compileTitle,
    pagesWritten: canonicalPaths,
    changes,
    // Non-fatal notes (e.g. the conversation was large → concise/summary-only
    // fallback). Empty on a normal full compile. Surfaced in the result panel.
    warnings,
  };
}
