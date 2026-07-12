import { randomUUID } from 'crypto';
import { generateText } from './llm.js';
import { tokenize } from './sharedbrain-delta.js';
import {
  readSchema,
  readWikiPages,
  listConversations,
  readConversation,
  writeConversation,
  deleteConversation,
} from './files.js';

export { listConversations, readConversation, deleteConversation };

// ── Tunables ──────────────────────────────────────────────────────────────
//
// Pre-v3.0.1-beta.11, chat used a hard `wikiContext.slice(0, 90000)` over
// the whole wiki in readdir order. On any mature domain that meant the LLM
// saw the first ~20 KB of `index.md`, then `log.md`, and ZERO actual
// entity/concept/summary pages. Effectively non-functional on the
// `articles` domain (~4.4 MB wiki). Bug surfaced by a community member.
//
// v3.0.1-beta.11 introduced query-driven page selection — score each page
// by keyword overlap, load top-scoring up to 60 KB. That fixed "tell me
// about X" queries but had a structural blind spot for ENUMERATE-style
// queries ("list articles by Tali Rezun"): the chat would load the
// entity page (good) but then synthesize from the few summary pages it
// could keyword-match, ignoring the 50+ other summaries listed in the
// entity's Related section. Result: chat under-reported.
//
// v3.0.1-beta.13 adds three layered improvements:
//   1. Entity-pivot retrieval — when a query mentions an entity that exists
//      in the wiki, force-load that entity's page AND every summary it
//      backlinks to. The user's intent is implicit in their mention.
//   2. Author-aware catalogue — each summary's catalogue line now shows
//      the entity pages that backlink to it ("· referenced by: X, Y, Z"),
//      so the LLM can enumerate by author from the catalogue alone.
//   3. Query-intent detection — enumerate-style queries get a different
//      prompt that emphasises completeness over synthesis.
//
// Budgets are character-based, not token-based, because the LLM has its
// own tokeniser and we don't want to depend on it here. ~60 KB of plain
// text ≈ 15-20 k tokens, well within every supported model.

const CONTENT_BUDGET_CHARS    = 60_000;   // total budget for full page content
const CATALOGUE_BUDGET_CHARS  = 12_000;   // bumped in beta.13 from 8k to fit author metadata
const MAX_PAGES_LOADED        = 50;       // bumped in beta.13 from 40 to allow more pivot pages
const HEAD_SCAN_CHARS         = 600;      // chars from page head used in scoring

// ── Reverse index: summary → entities that reference it ───────────────────
//
// For each entity page, scan its body for `[[summaries/X]]` backlinks and
// build a map `summarySlug → Set<entitySlug>`. This is the data structure
// that makes "list articles by Tali Rezun" answerable from the catalogue
// alone — every summary now knows which entities reference it.
//
// O(N * L) where N is the number of entity pages and L is average page
// length. On the articles domain (555 entities, ~1 KB average) this runs
// in under 100 ms.
//
// Exported for tests.
export function buildSummaryToEntitiesIndex(pages) {
  const index = new Map();
  const re = /\[\[summaries\/([^\]|#\n]+?)(\|[^\]]+)?\]\]/g;
  for (const p of pages) {
    if (!p.path.startsWith('entities/')) continue;
    const entitySlug = p.path.replace(/^entities\//, '').replace(/\.md$/, '');
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(p.content)) !== null) {
      const summarySlug = m[1].trim();
      if (!index.has(summarySlug)) index.set(summarySlug, new Set());
      index.get(summarySlug).add(entitySlug);
    }
  }
  return index;
}

// ── Entity-pivot detection ────────────────────────────────────────────────
//
// When the user's query tokens overlap with an entity's slug tokens, that
// entity is a "pivot" — almost certainly what the user is asking about.
// We force-load the entity page AND every summary it backlinks to.
//
// Threshold logic:
//   - Multi-token slug (e.g. "tali-rezun"): need ≥2 matching tokens OR
//     all slug tokens matched (single-token slug case)
//   - Single-token slug (e.g. "openai"): single match is enough — but
//     ONLY if that token is also relatively rare (skip "ai", "the", etc.
//     which would over-match)
//
// Exported for tests.
const COMMON_TOKENS_BLOCKLIST = new Set([
  'ai', 'llm', 'app', 'web', 'api', 'use', 'new', 'why', 'how', 'what',
]);

export function detectEntityPivots(queryText, pages) {
  const queryTokens = new Set(tokenize(queryText));
  if (queryTokens.size === 0) return [];

  const pivots = [];
  for (const p of pages) {
    if (!p.path.startsWith('entities/')) continue;
    const slug = p.path.replace(/^entities\//, '').replace(/\.md$/, '');
    const slugTokens = slug.split('-').filter(t => t.length > 1);
    if (slugTokens.length === 0) continue;

    let overlap = 0;
    const matchedTokens = [];
    for (const t of slugTokens) {
      if (queryTokens.has(t)) {
        overlap++;
        matchedTokens.push(t);
      }
    }

    if (overlap === 0) continue;

    // Determine if this is a confident pivot:
    //   - Multi-token slug: need ≥2 matching slug tokens
    //   - Single-token slug: need that token to be specific (not in blocklist)
    const isPivot =
      (overlap >= 2) ||
      (slugTokens.length === 1 && overlap === 1 && !COMMON_TOKENS_BLOCKLIST.has(slugTokens[0]));

    if (isPivot) {
      pivots.push({ page: p, slug, overlap, slugLength: slugTokens.length, matched: matchedTokens });
    }
  }
  // Sort: most overlap first, then shortest slug first (more specific match)
  pivots.sort((a, b) => b.overlap - a.overlap || a.slugLength - b.slugLength);
  return pivots;
}

// Extract `[[summaries/X]]` slugs from an entity page's body. Returns just
// the slug part (no `summaries/` prefix, no `.md` extension).
//
// Exported for tests.
export function extractSummaryBacklinks(entityContent) {
  const re = /\[\[summaries\/([^\]|#\n]+?)(\|[^\]]+)?\]\]/g;
  const slugs = new Set();
  let m;
  while ((m = re.exec(entityContent)) !== null) {
    slugs.add(m[1].trim());
  }
  return [...slugs];
}

// ── Query intent detection ────────────────────────────────────────────────
//
// Enumerate-style queries want a COMPLETE list, not a synthesis. The chat
// prompt is different in each case. False positives are OK (some synthesis
// queries get the enumeration prompt) because the enumeration prompt still
// allows synthesis as a fallback; false negatives are NOT OK (enumeration
// queries getting the synthesis prompt under-report, which is the bug we're
// fixing).
//
// Extract the user's actual ASK from a possibly-long, possibly-pasted message:
// the interrogative sentences, or the final sentence if there are none. Intent
// is classified on THIS, so list-like or decision-like words buried in pasted
// CONTENT (a topic idea that happens to say "everything", a pasted "List: A, B,
// C" line) can't hijack the routing. A single-sentence message is returned
// whole, so short questions behave exactly as before. Exported for tests.
const ASK_OPENER = /^(list|name|enumerate|show|give|tell|explain|describe|summari[sz]e|compare|contrast|recommend|suggest|advise|evaluate|rank|find|count|how|what|which|who|when|where|why|should|would|could|can|do|does|did|are|is|please)\b/i;

// Common abbreviations whose trailing period must NOT be treated as a sentence
// boundary ("Dr.", "e.g.", "U.S." …). Their periods are neutralised before the
// split and restored after.
const ABBR_RE = /\b(dr|prof|mr|mrs|ms|sr|jr|st|vs|etc|e\.g|i\.e|u\.s|u\.k|a\.m|p\.m)\./gi;
const ABBR_DOT = '~CURATOR_DOT~';  // visible placeholder; never appears in real input

export function extractAsk(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  // Split into sentence-ish units on . ! ? followed by whitespace, or newlines —
  // after protecting abbreviations so "Dr. X" / "e.g. Y" don't false-split.
  const protectedText = t.replace(ABBR_RE, (m) => m.replace(/\./g, ABBR_DOT));
  const units = protectedText
    .split(/(?<=[?!.])\s+|\n+/)
    .map(s => s.split(ABBR_DOT).join('.').trim())
    .filter(Boolean);
  if (units.length <= 1) return t;                 // single sentence → use whole
  // The real ask is the LAST qualifying clause — a trailing question, or a
  // trailing imperative/interrogative command. Scanning from the end correctly
  // prefers a final decision question over a pasted "List:" line (a content-line
  // hijack), AND a final "List every source" command over a quoted question in
  // the preamble (a content-question hijack). Both are the same failure shape as
  // the original "everything" bug, resolved by focusing on what the user
  // actually asked last.
  const qualifies = (u) => /\?\s*$/.test(u) || ASK_OPENER.test(u);
  for (let i = units.length - 1; i >= 0; i--) {
    if (qualifies(units[i])) return units[i];
  }
  return t;                                          // nothing qualifies → whole message
}

// Exported for tests.
export function detectQueryIntent(queryText) {
  if (typeof queryText !== 'string') return 'synthesis';
  // Classify on the ASK, not buried pasted content (v3.0.8, audit edge #1).
  const lc = extractAsk(queryText).toLowerCase().trim();
  if (!lc) return 'synthesis';

  // Analytical override: a question shaped like a list request but really asking
  // about DISAGREEMENT/DIFFERENCE wants ANALYSIS, not a raw list
  // ("which concepts have the most sources DISAGREEING?"). Kept deliberately
  // NARROW (audit-tightened): bare "most"/"least" were dropped because they
  // matched benign list phrasing ("list the MOST recent…", "list AT LEAST 10…"),
  // and "differ" is whole-word so it can't fire on "different".
  const analytical =
    /\b(disagree|disagreement|conflict|conflicting|contradict|contradiction|contested|debate|controvers)/.test(lc) ||
    /\bdiffer(s|ing)?\b/.test(lc);

  // ── 1. STRONG enumerate anchors (a list/count COMMAND opening a clause) ────
  // These BEAT incidental decision words (audit fix): "how many articles
  // recommend X?" is a COUNT, not a recommendation; "list all papers evaluating
  // X" is a LIST. Anchored to the start of the message OR any sentence/line so
  // the real ask can sit after a preamble ("…newsletters. How many sources do I
  // have?"). NOTE the bare word "everything" is NOT here — it matched ordinary
  // prose in pasted content, which is how a decision question got misrouted into
  // a full-domain dump (the community-reported bug).
  const B = '(?:^|[.?!]\\s+|\\n)\\s*';
  const strongEnumerate = [
    new RegExp(B + '(list|name|enumerate|show me all|show all|give me a list|give me all)\\b'),
    new RegExp(B + 'how many\\b'),
    new RegExp(B + 'count\\b'),
    new RegExp(B + '(all|every)\\s+(article|source|document|paper|page|entity|concept|summary|file)s?\\b'),
    new RegExp(B + '(what|which)\\s+(articles|sources|documents|papers|pages|entities|concepts|summaries|files)\\b'),
  ];
  if (strongEnumerate.some(re => re.test(lc))) {
    return analytical ? 'synthesis' : 'enumerate';
  }

  // ── 2. DECISION / RECOMMENDATION cues ──────────────────────────────────────
  // "which of these is best?", "recommend one", "should I…", "evaluate…" — the
  // user wants a CONCLUSION. Checked AFTER strong list/count commands so an
  // explicit list request can't be hijacked, but BEFORE weak list phrases.
  const decisionPatterns = [
    /\b(recommend|recommendation|suggest|advise|advice)\b/,
    /\bshould i\b/,
    /\bhelp me (choose|decide|pick|prioriti[sz]e|figure out|work out)\b/,
    /\bwhich (one|option|topic|idea|approach|of these|of the following|of those)\b/,
    /\bwhat('?s| is)? the best\b/,
    /\bevaluat(e|ing)\b/,
    /\bpros and cons\b/,
    /\bprioriti[sz]e\b/,
    /\bworth (doing|writing|tackling|covering|pursuing)\b/,
    /\bwhich\b[^?]{0,80}\b(best|better|strongest|most compelling)\b/,
  ];
  for (const re of decisionPatterns) if (re.test(lc)) return 'decision';

  // ── 3. WEAK enumerate cues (list phrases / "by Dr X") ──────────────────────
  const weakEnumerate = [
    /\b(complete list|full list|exhaustive list|list them all|list all of)\b/,
    /\b(by\s+(dr|prof|mr|ms|mrs)\.?\s+\w)/,  // "articles by Dr. X"
  ];
  if (weakEnumerate.some(re => re.test(lc))) {
    return analytical ? 'synthesis' : 'enumerate';
  }

  return 'synthesis';
}

// ── Catalogue builder ─────────────────────────────────────────────────────
//
// Compact one-line-per-page directory. Excludes index.md and log.md (they
// don't carry standalone knowledge).
//
// For summaries (v3.0.1-beta.13+): if the summary-to-entities index has
// data for this summary, append `· referenced by: X, Y, Z` so the LLM can
// see who/what is associated with each summary without loading it.
//
// For pivot entities: show `(N articles)` next to the entity slug so the
// LLM knows how many backlinks point to it.
function buildSlugCatalogue(pages, summaryToEntities = new Map(), pivotSlugs = new Set(), budget = CATALOGUE_BUDGET_CHARS) {
  const lines = [];
  let used = 0;
  let truncated = 0;

  // Sort so pivot pages and their related items come first (more useful
  // to the LLM when budget is tight). Pivots first, then summaries that
  // a pivot references, then everything else by path.
  const pivotEntityPaths = new Set([...pivotSlugs].map(s => `entities/${s}.md`));
  const pivotRelatedSummaries = new Set();
  for (const slug of pivotSlugs) {
    const ep = pages.find(p => p.path === `entities/${slug}.md`);
    if (ep) {
      for (const s of extractSummaryBacklinks(ep.content)) {
        pivotRelatedSummaries.add(`summaries/${s}.md`);
      }
    }
  }

  const sortPriority = (p) => {
    if (pivotEntityPaths.has(p.path)) return 0;
    if (pivotRelatedSummaries.has(p.path)) return 1;
    if (p.path.startsWith('summaries/')) return 2;
    if (p.path.startsWith('entities/')) return 3;
    return 4;
  };
  const sorted = [...pages].sort((a, b) =>
    sortPriority(a) - sortPriority(b) || a.path.localeCompare(b.path));

  for (const p of sorted) {
    if (p.path === 'index.md' || p.path === 'log.md') continue;
    const titleMatch = p.content.match(/^#{1,3}\s+(.+)/m);
    const title = titleMatch ? titleMatch[1].trim().slice(0, 80) : '';
    let line = title ? `${p.path} — ${title}` : p.path;

    // Enrich summaries with referenced-by entities.
    if (p.path.startsWith('summaries/')) {
      const slug = p.path.replace(/^summaries\//, '').replace(/\.md$/, '');
      const entities = summaryToEntities.get(slug);
      if (entities && entities.size > 0) {
        const list = [...entities].slice(0, 4).join(', ');
        const more = entities.size > 4 ? `, +${entities.size - 4}` : '';
        line += ` · referenced by: ${list}${more}`;
      }
    }
    // Enrich pivot entities with their backlink count.
    if (p.path.startsWith('entities/') && pivotEntityPaths.has(p.path)) {
      const backlinks = extractSummaryBacklinks(p.content);
      if (backlinks.length > 0) {
        line += ` (${backlinks.length} summary backlinks)`;
      }
    }

    if (used + line.length + 1 > budget) {
      truncated = pages.length - lines.length;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  if (truncated > 0) {
    lines.push(`(… ${truncated} more pages not shown in catalogue …)`);
  }
  return lines.join('\n');
}

// ── Page scorer ──────────────────────────────────────────────────────────
//
// Returns 0 for pages the query doesn't intersect at all. Filename tokens
// (3x weight) and heading tokens (2x weight) are the most reliable signal
// — they reflect what the page is ABOUT. Body-head match (1x weight)
// catches pages whose subject is in the first paragraph.
function scorePage(page, queryTokens) {
  if (queryTokens.size === 0) return 0;
  let score = 0;

  const base = page.path.split('/').pop().replace(/\.md$/, '');
  const slugTokens = base.split('-').filter(t => t.length > 1);
  for (const t of slugTokens) if (queryTokens.has(t)) score += 3;

  const titleMatch = page.content.match(/^#{1,3}\s+(.+)/m);
  if (titleMatch) {
    const titleTokens = tokenize(titleMatch[1]);
    for (const t of titleTokens) if (queryTokens.has(t)) score += 2;
  }

  const head = page.content.slice(0, HEAD_SCAN_CHARS);
  const headTokens = tokenize(head);
  for (const t of headTokens) if (queryTokens.has(t)) score += 1;

  return score;
}

/**
 * Pick the pages most relevant to the query within a character budget.
 *
 * v3.0.1-beta.13+: entity-pivot retrieval. If the query mentions an entity
 * that exists in the wiki, FORCE-LOAD that entity page AND every summary it
 * backlinks to (up to budget). These take priority over keyword-scored pages
 * because the user almost always wants to know about the pivoted entity
 * and its related material.
 *
 * Exported for unit testing.
 */
export function selectRelevantPages(pages, queryText, opts = {}) {
  const {
    contentBudget = CONTENT_BUDGET_CHARS,
    maxPages = MAX_PAGES_LOADED,
  } = opts;

  const queryTokens = new Set(tokenize(queryText));
  const contentPages = pages.filter(p => p.path !== 'index.md' && p.path !== 'log.md');

  // ── Stage 1: entity-pivot retrieval ────────────────────────────────────
  const pivots = detectEntityPivots(queryText, contentPages);
  const priorityPaths = new Set();
  for (const pivot of pivots) {
    priorityPaths.add(pivot.page.path);
    const backlinks = extractSummaryBacklinks(pivot.page.content);
    for (const slug of backlinks) {
      priorityPaths.add(`summaries/${slug}.md`);
    }
  }

  // Build the lookup so we can identify priority pages in the page list.
  const priorityCandidates = [];
  for (const path of priorityPaths) {
    const page = contentPages.find(p => p.path === path);
    if (page) priorityCandidates.push({ page, score: 1000, priority: true });
  }

  // ── Stage 2: keyword-scored remaining pages ────────────────────────────
  const scored = contentPages
    .filter(p => !priorityPaths.has(p.path))
    .map(page => ({ page, score: scorePage(page, queryTokens) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path));

  // ── Stage 3: assemble candidates ───────────────────────────────────────
  let candidates;
  if (priorityCandidates.length === 0 && scored.length === 0) {
    // Fallback: most-linked pages (hub heuristic).
    candidates = contentPages
      .map(page => ({ page, score: (page.content.match(/\[\[/g) || []).length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  } else {
    candidates = [...priorityCandidates, ...scored];
  }

  const selected = [];
  let used = 0;
  for (const { page, score, priority } of candidates) {
    if (selected.length >= maxPages) break;
    const cost = page.content.length + page.path.length + 30;
    if (used + cost > contentBudget) {
      continue;
    }
    selected.push({ page, score, priority: priority === true });
    used += cost;
  }
  return {
    selected,
    contentBytes: used,
    scoredCount: scored.length,
    pivotCount: pivots.length,
    pivotSlugs: pivots.map(p => p.slug),
  };
}

// ── Response-style control (Tier 2) ────────────────────────────────────────
//
// ORTHOGONAL to intent: `detectQueryIntent` picks the answer SHAPE
// (decision / enumerate / synthesis); the response style picks the DETAIL and
// LENGTH. The style directive is appended AFTER the intent instructions, and it
// NEVER relaxes the anti-catalogue-dump guardrails — "comprehensive" means
// deeper reasoning, not a longer list of every page. Each style also carries an
// output-token cap; on overflow the v3.0.7 text-mode path returns a partial
// answer with a note rather than failing, so a larger cap is always safe.
export const RESPONSE_STYLES = {
  concise: {
    maxTokens: 4096,
    directive:
      'RESPONSE STYLE — CONCISE: Keep the answer short and direct — 1–3 tight ' +
      'paragraphs (or a short list). Lead with the answer in the first sentence. ' +
      'Cite only the 2–3 most important sources. Omit background the user did not ask for.',
  },
  balanced: {
    maxTokens: 8192,
    directive: '',   // the intent instructions already produce a balanced answer
  },
  comprehensive: {
    maxTokens: 12288,
    directive:
      'RESPONSE STYLE — COMPREHENSIVE: Be thorough. Cover the relevant angles in ' +
      'more depth and include more supporting citations where they genuinely add ' +
      'value. Do NOT pad with tangential material, and NEVER reproduce the domain ' +
      'catalogue or bare file paths — depth means better reasoning, not a longer list.',
  },
};

// Normalise an arbitrary client value to a known style; default 'balanced'.
// Uses an OWN-property check (not truthiness) so inherited keys like
// '__proto__' / 'constructor' — which are truthy on a plain object — can't slip
// through and yield an undefined cap/directive downstream.
export function normalizeResponseStyle(style) {
  return (typeof style === 'string' && Object.hasOwn(RESPONSE_STYLES, style.toLowerCase()))
    ? style.toLowerCase()
    : 'balanced';
}

function buildPrompt(domain, pages, history, userMessage, responseStyle = 'balanced') {
  // Pull recent history into the query context so a multi-turn
  // conversation about "vector databases" still finds the right pages
  // when the user types just "tell me more about HNSW".
  const recentUserTurns = history
    .filter(m => m.role === 'user')
    .slice(-2)
    .map(m => m.content);
  const queryContext = [...recentUserTurns, userMessage].join(' ');

  const intent = detectQueryIntent(userMessage);  // base on current message, not history
  const summaryToEntities = buildSummaryToEntitiesIndex(pages);

  const { selected, contentBytes, scoredCount, pivotCount, pivotSlugs } =
    selectRelevantPages(pages, queryContext);

  const wikiContext = selected
    .map(({ page, priority }) =>
      `--- FILE: ${page.path} ---${priority ? '  [pivot]' : ''}\n${page.content}`)
    .join('\n\n');

  const catalogue = buildSlugCatalogue(pages, summaryToEntities, new Set(pivotSlugs));

  const historyText = history.length > 0
    ? '[Conversation so far]\n' +
      history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n') +
      '\n\n'
    : '';

  const selectionParts = [];
  if (pivotCount > 0) selectionParts.push(`${pivotCount} entity pivot${pivotCount === 1 ? '' : 's'} (${pivotSlugs.slice(0, 3).join(', ')}${pivotSlugs.length > 3 ? '…' : ''})`);
  if (scoredCount > 0) selectionParts.push(`${scoredCount} keyword-scored pages`);
  if (selectionParts.length === 0) selectionParts.push('no direct match — fell back to most-linked hubs');
  const selectionNote = `Retrieval: ${selectionParts.join(' + ')}. Loaded ${selected.length} pages in full (${(contentBytes/1024).toFixed(1)} KB).`;

  // Intent-aware instructions block (v3.0.1-beta.13+; v3.0.7 Tier 1 reshaped
  // enumerate, added decision, and hardened all three against catalogue dumps).
  const enumerateInstructions = `Instructions (ENUMERATION query — the user wants a focused list):
- Lead with ONE sentence summarising what the list covers and how many items there are.
- List the RELEVANT items, grouped by topic where useful. Cite each with [source: path/to/page.md] next to a short readable title.
- DEDUPLICATE: if two pages share the same or nearly the same title, list it once.
- Cap the list at roughly the 40 most relevant items. If more exist, end with "…and N more — ask me to narrow by topic" instead of dumping everything.
- Give a 1-line topic note for items you have full content for.
- NEVER paste the domain catalogue verbatim or output bare file paths on their own — every path must sit inside a [source: …] citation beside prose.
- If the user asked "how many", give an actual number.`;

  const decisionInstructions = `Instructions (DECISION / RECOMMENDATION query — give a clear answer, not a list):
- Lead with a direct recommendation in your FIRST sentence: state which option you would choose (or the single best answer) up front.
- Then give brief supporting reasoning — at most a few sentences per option, grounded in what the wiki actually contains.
- Cite only the MOST relevant 3–7 sources with [source: path/to/page.md]. Do NOT list every related page.
- NEVER paste the domain catalogue or dump long lists of sources or bare file paths.
- If the wiki genuinely can't support a recommendation, say what's missing instead of padding the answer with everything tangentially related.
- Be decisive and concise. The user wants a conclusion, not an inventory.`;

  const synthesisInstructions = `Instructions:
- Lead with the direct answer, then support it. Keep it focused.
- Answer using the full content of the loaded pages above, plus the catalogue for what else exists in the domain.
- If the answer is in a catalogue page that wasn't loaded in full, say "I see we have a page on X but I'd need to look at it directly" and cite the path.
- If the answer is not in the wiki at all, say so honestly.
- Cite pages inline using [source: path/to/page.md] format.
- Synthesize across pages; do not quote large blocks verbatim.
- NEVER paste the domain catalogue verbatim or output bare file paths — cite with [source: …] beside prose.
- Be conversational — this is a multi-turn chat, not a one-shot Q&A. Keep answers focused and concise.`;

  const intentInstructions =
    intent === 'enumerate' ? enumerateInstructions
    : intent === 'decision' ? decisionInstructions
    : synthesisInstructions;

  // Tier 2: append the response-style directive (detail/length) after the
  // intent instructions (shape). Balanced adds nothing (unchanged behaviour).
  const styleDirective = RESPONSE_STYLES[normalizeResponseStyle(responseStyle)].directive;
  const instructions = styleDirective
    ? `${intentInstructions}\n\n${styleDirective}`
    : intentInstructions;

  return `The user is having a conversation about the "${domain}" domain wiki.

[Domain catalogue — FOR YOUR REFERENCE ONLY: this is the index of pages available. Do NOT copy it into your answer or reproduce bare file paths; cite what you use with [source: path].]
${catalogue}

---
[Relevant pages loaded in full]
${selectionNote}

${wikiContext}

---
${historyText}[New message from user]
${userMessage}

${instructions}`;
}

// ── Catalogue-echo safety net (v3.0.7 Tier 1) ─────────────────────────────
//
// Even with the tamed prompts, a model can still regurgitate the internal
// catalogue as a trailing blob of bare file paths glued together with no prose
// (exactly what a community user saw at the end of a bloated answer). A
// legitimate answer NEVER contains 5+ consecutive bare wiki paths — real
// citations use the `[source: path]` form with a readable title between each,
// which breaks the run. So we strip any run of 5+ bare `folder/slug.md` tokens
// separated only by whitespace/commas/pipes. Conservative by construction:
// formatted citation lists and normal prose are untouched.
export function stripCatalogueEcho(answer) {
  if (typeof answer !== 'string' || !answer) return answer;
  // Runs of 5+ bare wiki paths separated ONLY by spaces/tabs (or glued directly
  // with no separator — the actual reported blob). We deliberately do NOT treat
  // commas, semicolons, pipes, or newlines as separators: a comma-separated
  // source line, a code block listing paths, or a multi-path [source: …]
  // citation are all legitimate and must survive.
  const RUN = /(?:(?:summaries|concepts|entities)\/[a-z0-9][a-z0-9._-]*\.md[ \t]*){5,}/gi;
  const replaced = answer.replace(RUN, ' ');
  if (replaced === answer) return answer;             // nothing stripped
  // Scoped tidy-up only: collapse blank lines the removal left behind and trim
  // the end. We do NOT collapse internal runs of spaces/tabs — that would
  // flatten legitimate code-block / nested-list indentation elsewhere.
  const cleaned = replaced.replace(/\n{3,}/g, '\n\n').trimEnd();
  return cleaned.length ? cleaned : answer;           // never return empty
}

export async function sendMessage(domain, conversationId, userMessage, opts = {}) {
  const responseStyle = normalizeResponseStyle(opts.responseStyle);
  const schema = await readSchema(domain);
  const pages = await readWikiPages(domain);

  if (pages.length === 0) {
    return {
      conversationId: null,
      isNew: false,
      title: null,
      answer: "This domain's wiki is empty. Ingest some sources first.",
      citations: [],
    };
  }

  // Load or create conversation
  let conversation = null;
  let isNew = false;

  if (conversationId) {
    conversation = await readConversation(domain, conversationId);
  }

  if (!conversation) {
    isNew = true;
    conversation = {
      id: randomUUID(),
      title: userMessage.length > 60 ? userMessage.slice(0, 57).trimEnd() + '…' : userMessage.trim(),
      createdAt: new Date().toISOString(),
      domain,
      messages: [],
    };
  }

  // Use up to last 20 messages (10 turns) for context
  const history = conversation.messages.slice(-20);

  const prompt = buildPrompt(domain, pages, history, userMessage, responseStyle);
  // v3.0.7: base cap 8192 (analytical questions need room; text-mode truncation
  // degrades to partial-with-note, never a hard error). Tier 2: the response
  // style sets the cap — concise 4096 / balanced 8192 / comprehensive 12288.
  const maxTokens = RESPONSE_STYLES[responseStyle].maxTokens;
  const rawAnswer = await generateText(schema, prompt, maxTokens);
  // v3.0.7 Tier 1: strip any catalogue-echo blob before it reaches the user or
  // the saved history. Citations are extracted from the CLEANED answer so a
  // stripped bare-path run never counts as a citation.
  const answer = stripCatalogueEcho(rawAnswer);

  const citations = [...answer.matchAll(/\[source:\s*([^\]]+)\]/g)].map(m => m[1].trim());
  const uniqueCitations = [...new Set(citations)];

  conversation.messages.push({ role: 'user', content: userMessage });
  conversation.messages.push({ role: 'assistant', content: answer, citations: uniqueCitations });
  await writeConversation(domain, conversation);

  return {
    conversationId: conversation.id,
    isNew,
    title: conversation.title,
    answer,
    citations: uniqueCitations,
    responseStyle,
  };
}

// Exported for tests (v3.0.1-beta.11+)
export const __testing = { buildSlugCatalogue, scorePage, buildPrompt, stripCatalogueEcho, extractAsk, RESPONSE_STYLES, normalizeResponseStyle };
