import { randomUUID } from 'crypto';
import { generateText, isOfferableModel } from './llm.js';
// NAMESPACE import for everything ADDED after v3.14.0. A named import of an
// export that is later renamed or not yet shipped is a SyntaxError at MODULE
// LOAD, which takes this whole file — and therefore all of chat — down; a
// namespace member is merely `undefined`, and every read of it below is
// type-checked before it is called so the miss degrades to a refusal (fall back
// to the global active provider) instead of a crash. This is routes/config.js's
// v3.12.0 rule applied at the second consumer of the same catalogue.
//
// The two named imports above are LEFT AS THEY ARE deliberately: they predate
// this change, are load-bearing on the chat path, and rewriting them would
// widen the diff of a defect fix into a refactor of a working import.
import * as llmModule from './llm.js';
import { getApiKeys } from './config.js';
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
      'Give just the key point and its most important nuance. Cite only the 2–3 ' +
      'most important sources. Omit background the user did not ask for.',
  },
  balanced: {
    // NOT empty (fixed after live testing showed an unconstrained balanced answer
    // running LONGER than comprehensive on content-rich questions): a soft
    // moderate-length directive keeps balanced in the middle so the tiers are
    // reliably ordered concise < balanced < comprehensive.
    maxTokens: 8192,
    directive:
      'RESPONSE STYLE — BALANCED: A well-rounded answer that covers the main ' +
      'points and their important nuances in a few short paragraphs. Aim for the ' +
      'middle ground — more than a quick summary, but NOT exhaustive: hit the key ' +
      'takeaways, skip the exhaustive enumeration of every detail.',
  },
  comprehensive: {
    maxTokens: 12288,
    directive:
      'RESPONSE STYLE — COMPREHENSIVE: Be thorough and complete — this should be ' +
      'your LONGEST, most detailed answer. Cover every relevant angle, sub-point, ' +
      'and caveat in depth, with more supporting citations where they genuinely add ' +
      'value. Do NOT pad with tangential material, and NEVER reproduce the domain ' +
      'catalogue or bare file paths — depth means more reasoning and coverage, not a ' +
      'raw list of pages.',
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
  // intent instructions (shape). All three styles now carry a directive; the
  // ternary's empty-directive branch is a defensive fallback only.
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

/**
 * ── PER-PROVIDER CREDENTIAL FIELD, KEYED BY ID ───────────────────────────────
 *
 * This replaces a pair of BINARY TERNARIES — `provider === 'gemini' ? keys.gemini
 * : keys.anthropic` — which had no third arm, so ANY provider that was not
 * literally 'gemini' fell through to the ANTHROPIC credential. That is the
 * v3.10.1 credential-crossing shape verbatim: measured here, with an OpenRouter
 * key saved and OpenRouter models offerable, `normalizeChatModel('openrouter', …)`
 * returned the model when an Anthropic key happened to be saved and null when it
 * was not. An OpenRouter decision was being made from Anthropic's credential.
 *
 * A frozen array of pairs scanned with `===`, exactly like llm.js's
 * KNOWN_PROVIDERS: the caller's string is compared, never used to index, so
 * '__proto__' / 'constructor' / 'toString' are structurally unable to resolve to
 * a field name. `row[1]` is a literal from this table and never caller text.
 *
 * AN UNKNOWN ID RESOLVES TO NO KEY, never to another provider's — the whole
 * point of the change. Under-reading is recoverable (chat falls back to the
 * global active provider); reading the wrong slot spends someone else's money.
 *
 * This list must stay in step with config.js's PROVIDER_KEY_FIELDS, which is not
 * exported. Drift fails SAFE in both directions: a provider missing here is
 * simply not chat-selectable, and a provider here but unknown to llm.js is
 * refused by the catalogue gates below.
 */
const CHAT_PROVIDER_KEY_FIELDS = Object.freeze([
  Object.freeze(['gemini',     'geminiApiKey']),
  Object.freeze(['anthropic',  'anthropicApiKey']),
  Object.freeze(['openrouter', 'openrouterApiKey']),
]);

/**
 * The key SAVED IN SETTINGS for a provider, or '' when there is none.
 *
 * CONFIG-SCOPED, never getEffectiveKey/.env — the v3.0.13 rule: a provider the
 * user has Disconnected in Settings must not be reachable from chat even if its
 * key still lingers in .env.
 */
function savedChatKey(provider) {
  const row = CHAT_PROVIDER_KEY_FIELDS.find(([id]) => id === provider);
  if (!row) return '';
  return getApiKeys()[row[1]] || '';
}

/**
 * Can this provider serve a chat turn in which NO model is named?
 *
 * DERIVED, NEVER A HARDCODED PROVIDER LIST. It asks llm.js the only question
 * that matters — does `getDefaultModel(provider)` resolve to an actual id — so a
 * provider becomes chat-selectable the moment it genuinely can serve one, and a
 * fourth provider needs no edit here.
 *
 * WHY THIS GATE IS DERIVED RATHER THAN AN ALLOW-LIST. The case that taught the
 * lesson has since resolved, but the lesson is why the shape is right. When
 * OpenRouter was first added, `DEFAULTS.openrouter` was deliberately null (no
 * route had yet been measured against the ingest outline prompt) and
 * `getProviderInfo` refused a null model with a named throw — measured at the
 * time: `getProviderInfo('openrouter', null)` threw "No model is configured for
 * OpenRouter". Merely adding 'openrouter' to a hardcoded allow-list would
 * therefore have converted a silent mis-bill into a HARD CHAT FAILURE for every
 * OpenRouter user — the same shape as the P0 already fixed on the key-save path.
 *
 * ⚠ THAT PREMISE HAS EXPIRED, AND NOTHING HERE NEEDED EDITING — which is the
 * point. As of v3.14.0 `DEFAULTS.openrouter` is `'upstage/solar-pro4'` and
 * `getProviderInfo('openrouter', null)` RESOLVES instead of throwing (measured
 * by execution, not read off the source). Because this gate asks llm.js the
 * question rather than carrying a list, OpenRouter became chat-selectable at the
 * exact moment it could genuinely serve a model-less turn. The same property
 * holds in the other direction: a provider whose default is later withdrawn
 * silently stops being offered here instead of starting to throw.
 *
 * FAILS SAFE ON A MISSING EXPORT. llm.js is imported as a NAMESPACE and the
 * function is type-checked before it is called, so an export that is renamed or
 * not yet shipped degrades to "this provider cannot serve a model-less turn" —
 * a fall-back to the global active provider — rather than a TypeError at the
 * trust boundary or a SyntaxError at module load.
 */
function chatProviderHasDefaultModel(provider) {
  if (typeof llmModule.getDefaultModel !== 'function') return false;
  let id = null;
  try { id = llmModule.getDefaultModel(provider); } catch { return false; }
  return typeof id === 'string' && id.length > 0;
}

// Validate a per-chat provider override against the SAVED SETTINGS KEYS (config
// only — NOT getEffectiveKey / .env). This is deliberate: a provider the user
// has Disconnected in Settings must not be usable in chat, even if the key still
// lingers in .env — so the chat model selector exactly mirrors the saved-keys
// state and a disconnected model can never silently answer. Anything invalid or
// without a saved key → null (fall back to the global active provider).
//
// ── TWO MODES, AND THE PAIR MUST NEVER DISAGREE ─────────────────────────────
// `normalizedModel` is the output of normalizeChatModel for this same request.
// When a model has been honoured, the provider that offers it is honoured with
// it; when no model is named, the provider must be able to resolve its own
// default (chatProviderHasDefaultModel above).
//
// This coupling is the point, not a convenience. sendMessage passes provider and
// model to generateText independently, so if this function refused a provider
// whose MODEL the sibling function had just accepted, getProviderInfo would
// resolve the GLOBAL active provider and then discard the model as not offerable
// there — silently answering on, and billing, a provider the user did not pick.
// That is the same defect one layer down, so the two are resolved together.
//
// The hand-off is SELF-VALIDATING rather than trusted: `normalizedModel` is
// re-checked against the allow-list here, so a caller passing arbitrary truthy
// junk cannot use it to skip the default-model gate. The parameter is defaulted,
// so every existing single-argument caller keeps its exact previous meaning.
export function normalizeChatProvider(provider, normalizedModel = null) {
  if (!savedChatKey(provider)) return null;
  if (normalizedModel && isOfferableModel(provider, normalizedModel)) return provider;
  return chatProviderHasDefaultModel(provider) ? provider : null;
}

// Validate a per-chat MODEL override. TWO independent gates, both required:
//
//   1. isOfferableModel(provider, model) — the OFFERABLE_MODELS allow-list, the
//      same predicate getProviderInfo applies. Its lookup is an array scan
//      comparing with `===`, so '__proto__' / 'constructor' / 'toString' cannot
//      resolve to anything. This wrapper deliberately adds NO object lookup of
//      its own, so that property is inherited by construction rather than by
//      remembering an Object.hasOwn call (the v3.0.9 normalizeResponseStyle bug
//      shape, closed structurally).
//   2. The provider has a key SAVED IN SETTINGS — getApiKeys(), never
//      getEffectiveKey. This is the v3.0.13 rule: a provider the user has
//      Disconnected in Settings must not be reachable from chat even if its key
//      still lingers in .env. A model is a strictly NARROWER choice than the
//      provider that serves it, so it must inherit the stricter of the two
//      gates — it can never be a way back in. The lookup is now KEYED BY
//      PROVIDER ID (savedChatKey) rather than the binary ternary that used to
//      sit here, which had no third arm and therefore decided every
//      non-Gemini provider — OpenRouter included — from ANTHROPIC's credential.
//
// DELIBERATELY DOES NOT REQUIRE A RESOLVABLE PROVIDER DEFAULT, unlike its
// sibling. A model override NAMES what to send, so it works on a provider with
// no pinned default at all: measured, `getProviderInfo('openrouter', '<offerable
// id>')` resolves cleanly while `getProviderInfo('openrouter', null)` throws.
// Requiring a default here would keep a fully-measured OpenRouter catalogue
// unusable until the user also pinned something in Settings, which is a gate on
// the wrong fact.
//
// Anything else → null → the provider's default model. Refusal FALLS BACK rather
// than throwing, matching normalizeChatProvider and applyModelOverride: a saved
// selection can outlive the model it names, and the default is the CHEAPEST
// model on that provider, so a refusal can only ever spend LESS than asked.
//
// KNOWN AND DELIBERATE: `provider` is the provider the CALLER asked for, not
// necessarily the one that ends up serving the request. A body carrying a model
// but NO provider therefore resolves to the provider default even where the
// model would have been valid for the global active provider. The shipping
// client never produces that shape — /next sends the two together and treats a
// restored model as implying its provider — and refusing is the safe direction
// on both money and correctness, so this is not widened speculatively.
export function normalizeChatModel(provider, model) {
  if (!isOfferableModel(provider, model)) return null;
  return savedChatKey(provider) ? model : null;
}

/**
 * Build the assistant message RECORD that is persisted into the conversation
 * JSON. Pure; exported for testing.
 *
 * WHY THIS EXISTS. Until now a conversation stored only { role, content,
 * citations }, so once an answer had been written there was NO record anywhere
 * of which model produced it — the Chat tab labelled it from the user's own
 * dropdown, which is a restatement of the request, not evidence about the
 * answer. A maintainer who picked claude-sonnet-5 and wanted to confirm Sonnet 5
 * had actually run had nothing in the app to check against.
 *
 * `servedUsage` extends the SAME record with the four token counts that answer
 * "what did this answer cost". It is the LOAD-BEARING half of that feature, not
 * a convenience: a cost derived only from the live `sendMessage` return would
 * appear beside an answer and then vanish the moment the conversation is
 * reloaded from disk — the same figure present and absent for the same message
 * depending on how you arrived at it, which is a worse surface than no figure at
 * all. Persisting the counts (not a computed dollar amount — see
 * normalizeReportedUsage, and the price-at-render-time note in the /next chat
 * view) makes the reloaded thread and the live thread render from one input.
 *
 * THE RULE: servedProvider / servedModel / servedUsage are what the PROVIDER
 * REPORTED in its own usage payload (llm.js reportUsage), never what the caller
 * requested. The
 * two diverge on two real paths:
 *
 *   • an allow-list refusal — normalizeChatModel returns null and the provider
 *     default answers instead;
 *   • a fallback-chain WALK — the picked model 404s and the NEXT rung answers.
 *
 * Re-deriving the value here by calling getProviderInfo() would look correct and
 * would pass every refusal case, while being blind to the walk — reporting
 * claude-sonnet-5 ($2/$10) when claude-sonnet-4-6 ($3/$15) actually answered.
 * That is mutation M3b from the v3.13.0 work: a stored falsehood about capability
 * AND money, in the one direction where the user pays more. Only the reported
 * value is trustworthy, so only the reported value is stored.
 *
 * NOTHING REPORTED ⇒ NOTHING STORED. The fields are OMITTED rather than filled
 * with a guess, because "we could not tell" and "it was the default" are
 * different facts and a record that cannot express the first is worse than no
 * record. Both shipping provider branches call reportUsage before returning, so
 * this is a defensive path, not an expected one.
 *
 * BACKWARD COMPATIBILITY IS THE LOAD-BEARING PROPERTY. Every conversation
 * written before this change has assistant messages with neither field, and
 * those are read by a plain JSON.parse in files.js's readConversation. There is
 * deliberately NO read-side defaulting, NO migration-on-read and NO relabelling
 * anywhere: absent means UNKNOWN, and any reader that renders these must treat
 * it that way. Defaulting a missing field to DEFAULTS[provider] would invent a
 * measurement for every historical message in every existing user's wiki — the
 * exact falsehood this record exists to prevent, applied retroactively and at
 * scale. The new keys are appended AFTER the existing ones so an untouched
 * message serialises byte-identically to before.
 */
export function buildAssistantMessage(content, citations, servedProvider, servedModel, servedUsage) {
  const msg = { role: 'assistant', content, citations };
  if (typeof servedProvider === 'string' && servedProvider) msg.provider = servedProvider;
  if (typeof servedModel === 'string' && servedModel) msg.model = servedModel;
  const usage = normalizeReportedUsage(servedUsage);
  if (usage) msg.usage = usage;
  return msg;
}

/**
 * The four token counts from a provider's usage payload, or null.
 *
 * ── ALL FOUR OR NOTHING, AND THAT IS THE HONESTY RULE ────────────────────
 * This is a MONEY input: the four fields are multiplied by four different
 * per-token rates (full price, output price, the cached-read discount, the
 * cache-write premium). A record carrying three of them would produce a cost
 * that is confidently wrong and indistinguishable from a correct one, which is
 * strictly worse than showing nothing. So a partial payload yields null and the
 * reader shows no cost at all — the same "reported or absent, never inferred"
 * rule the `model` field above already follows, applied to the numbers.
 *
 * Zero is a REPORT, not an absence: `{in: 0, out: 0, ...}` is a legitimate thing
 * for a provider to say, so the discriminator is `Number.isFinite`, never
 * truthiness. Negative values are refused — no provider emits one, and a
 * negative would subtract from a bill.
 *
 * Both shipping branches (normalizeGeminiUsage / normalizeAnthropicUsage in
 * llm.js) always emit all four as finite numbers, so the null path here is
 * defensive rather than expected. It is written anyway because the payload
 * arrives through a callback contract, not a type system.
 *
 * The returned object is a FRESH literal with the four keys in a fixed order —
 * never the caller's object — so nothing else riding on the usage payload
 * (provider, model, or anything llm.js adds later) can leak into a persisted
 * conversation record and out over the wire.
 */
function normalizeReportedUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const fields = ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cacheWriteTokens'];
  const out = {};
  for (const f of fields) {
    const v = u[f];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    out[f] = v;
  }
  // ── ZERO IN AND ZERO OUT IS A SENTINEL, NOT A MEASUREMENT ───────────────
  // Found by the offline suite, not reasoned about in advance: llm.js's
  // normalizers coerce EVERY missing field to 0 (`num()`), so a provider that
  // returns no usage block at all arrives here as {0,0,0,0} — indistinguishable
  // from a report of zero. Recording it would price a paid answer at exactly
  // $0.00 on the one surface whose job is to say what something cost, which is
  // the defect shared/format-usd.js exists to prevent, arriving through a
  // different door.
  //
  // Refusing it is not an inference. A COMPLETED chat turn cannot have consumed
  // zero input: the prompt carries the domain schema plus thousands of
  // characters of selected wiki pages before the user's message. So zero-in AND
  // zero-out is physically impossible for a turn that produced text, and the
  // only thing it can mean is "the provider told us nothing".
  //
  // Deliberately narrow: zero-in-and-zero-out only. `inputTokens > 0` with
  // `outputTokens === 0` stays a legitimate report and still prices above zero.
  // And it is fixed HERE rather than in llm.js's normalizers — those feed the
  // ingest queue's running spend total, where a 0 is the correct neutral
  // element and changing it would move real money arithmetic in a release about
  // a chat label.
  if (out.inputTokens === 0 && out.outputTokens === 0) return null;
  return out;
}

export async function sendMessage(domain, conversationId, userMessage, opts = {}) {
  const responseStyle = normalizeResponseStyle(opts.responseStyle);
  // ORDER IS LOAD-BEARING: the MODEL is resolved first and handed to the
  // provider gate, so a provider whose model was accepted is accepted with it.
  // Resolved independently, the two could disagree — and a model honoured
  // beside a refused provider is sent to the GLOBAL provider, which then
  // discards it as not offerable there and answers on a provider the user never
  // picked. Same mis-bill, one layer down.
  const chatModel = normalizeChatModel(opts.provider, opts.model); // null → provider default model
  const chatProvider = normalizeChatProvider(opts.provider, chatModel); // null → global active provider
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
  // v3.0.11: honour the chat model selector via the provider override (null →
  // global active provider). generateText re-validates the key defensively.
  // v3.12.x: the model override rides alongside it. Passing null for either is
  // byte-identical to omitting it — generateText narrows a non-string to null
  // before getProviderInfo sees it — so a caller that never picks a model is on
  // exactly the pre-picker path.
  //
  // onUsage tells us which model ACTUALLY answered, rather than which one was
  // asked for. It fires inside callProvider once per COMPLETED provider call
  // carrying the real model id, so the last payload names the rung that produced
  // this text. That covers BOTH ways the request can diverge from the outcome:
  // an allow-list refusal (→ provider default) and a fallback-chain WALK (the
  // picked model 404s and the next rung answers). Re-resolving through
  // getProviderInfo here would see the first and be blind to the second — and
  // the walk is where the number matters most, because it can move the user ONTO
  // a costlier model (claude-sonnet-5 $2/$10 → claude-sonnet-4-6 $3/$15). A
  // reported model that names the request would then be a falsehood about money,
  // which is the v3.9.0 dead-flag shape. A throwing callback cannot break the
  // call: llm.js's reportUsage try/catches it.
  //
  // usedProvider rides alongside usedModel for the same reason and under the
  // same rule: it is READ OUT OF THE USAGE PAYLOAD, never inferred from
  // chatProvider. chatProvider is what was ASKED for (null meaning "whatever
  // the global active provider is"), which is precisely the thing a persisted
  // record must not claim.
  //
  // usedUsage carries the same payload's four TOKEN COUNTS, under the same rule
  // and for the same reason: they are the only evidence of what this turn cost,
  // and they belong to the model that actually ran. Overwritten (not summed) on
  // each report, exactly like usedModel — a chat turn is ONE provider call, and
  // when the fallback chain walks, the earlier rungs THREW rather than
  // completing, so no usage was reported for them at all. Summing would mean a
  // 404ed rung could still add tokens to the bill.
  let usedModel = null;
  let usedProvider = null;
  let usedUsage = null;
  const rawAnswer = await generateText(schema, prompt, maxTokens, 'text', null, {
    provider: chatProvider,
    model: chatModel,
    // ── CANCELLATION: the signal reaches EXACTLY ONE CALL, and that is the
    // whole design (v3.18.x) ───────────────────────────────────────────────
    //
    // Chat was the last long-running LLM surface with no way to stop it. The
    // abort plumbing has existed in llm.js since v3.4.0 (the batch-ingest
    // queue); chat simply never handed it a signal. This line is that fix.
    //
    // It matters most on the RATE-LIMIT ladder, which is the reported symptom:
    // generateText retries a 429 four times, and parseRetryDelay DEFAULTS TO
    // 60_000 ms when the provider sends no Retry-After hint — so a chat turn
    // can sit in backoff for up to three minutes before surfacing an error.
    // sleep() is abortable, so a cancel now rejects out of that wait instead of
    // serving it out.
    //
    // PASSED UNCONDITIONALLY, and that is provably free for callers who do not
    // cancel: generateText runs `normalizeSignal(opts?.signal)`, which
    // duck-types on `.aborted`/`.addEventListener` and returns null for
    // anything else. `signal: undefined` and an omitted key both normalise to
    // null, and callProvider then does `opts.signal || null` again. So a
    // no-signal caller is on a byte-identical path to the pre-cancellation
    // code, with no branch here to get the two cases wrong.
    signal: opts.signal,
    onUsage: (u) => {
      if (!u) return;
      if (typeof u.model === 'string' && u.model) usedModel = u.model;
      if (typeof u.provider === 'string' && u.provider) usedProvider = u.provider;
      const usage = normalizeReportedUsage(u);
      if (usage) usedUsage = usage;
    },
  });
  // v3.0.7 Tier 1: strip any catalogue-echo blob before it reaches the user or
  // the saved history. Citations are extracted from the CLEANED answer so a
  // stripped bare-path run never counts as a citation.
  const answer = stripCatalogueEcho(rawAnswer);

  const citations = [...answer.matchAll(/\[source:\s*([^\]]+)\]/g)].map(m => m[1].trim());
  const uniqueCitations = [...new Set(citations)];

  // ── THE PERSISTENCE RULE, STATED SO NOBODY "IMPROVES" IT ────────────────
  //
  // There is DELIBERATELY no abort check between generateText returning and
  // this write, and none may be added. The rule is:
  //
  //   generateText THREW  -> nothing is persisted.
  //   generateText RETURNED -> the turn is persisted, whatever the signal says.
  //
  // Both halves are load-bearing and each protects a different user.
  //
  // The throw half is a property this file already had rather than a new one:
  // this is the ONLY writeConversation call site in sendMessage, and both
  // messages are pushed on the two lines above it, so a failed turn leaves an
  // existing conversation file byte-unchanged and a failed FIRST turn leaves no
  // file at all. A cancelled turn must not become a half-written turn, and a
  // "save what we have" improvement here would produce exactly that: a user
  // message with no answer, silently added to the history that seeds the NEXT
  // prompt.
  //
  // The return half is the one that is easy to get wrong. A turn whose reader
  // has walked away must still land on disk. In the SPA, navigating to another
  // conversation or another section does NOT close the HTTP connection, so the
  // turn keeps running with nobody watching and must be waiting when the user
  // comes back. It also covers the narrow race where a cancel arrives in the
  // milliseconds after the provider answered: the money is already spent and
  // the answer already exists, so discarding it would be a second loss on top
  // of the one the user was trying to avoid.
  //
  // The consequence is that CANCELLATION IS NOT A GUARANTEE OF NON-PERSISTENCE,
  // and that is intended. What a cancel guarantees is that we stop WAITING and
  // stop SPENDING at the next call boundary — see llm.js's own honest-scope note.
  conversation.messages.push({ role: 'user', content: userMessage });
  conversation.messages.push(buildAssistantMessage(answer, uniqueCitations, usedProvider, usedModel, usedUsage));
  await writeConversation(domain, conversation);

  return {
    conversationId: conversation.id,
    isNew,
    title: conversation.title,
    answer,
    citations: uniqueCitations,
    responseStyle,
    provider: chatProvider,   // null → global active provider was used
    // The model that ANSWERED — measured, never the request. Differs from
    // opts.model whenever the allow-list refused it or a fallback rung served
    // the call. Null only if a completed provider call reported no usage at
    // all, which neither shipping branch can do (both call reportUsage before
    // returning); it is left null rather than back-filled with a guess, because
    // "we could not tell" and "it was the default" are different facts.
    model: usedModel,
    // The four token counts the provider reported for THIS turn, or null when
    // it reported none (or reported them incompletely — see
    // normalizeReportedUsage: a partial payload is refused rather than
    // part-filled, because three of four numbers priced as if they were four is
    // a confident wrong answer about money).
    //
    // DELIBERATELY TOKENS, NOT A DOLLAR FIGURE. The price of a model is a
    // property of the catalogue and of the date (two models here are on
    // promotional pricing that ends on a stated day), so the arithmetic belongs
    // wherever the catalogue is — not frozen into a conversation record written
    // months earlier. The consumer multiplies these by the SERVED model's live
    // price. The trade-off is stated rather than hidden: an answer produced
    // during a promotion and re-read after it ends will price at the standing
    // rate, i.e. HIGHER than it actually cost. That direction is deliberate —
    // it matches this repo's rule that every price failure resolves upward — but
    // it is an approximation, and it is the reason a persisted `costUsd` is a
    // reasonable future change rather than an obviously wrong one.
    //
    // Route-side: src/routes/chat.js returns this object with `res.json(result)`
    // — it names no fields and spreads nothing, so this reaches the wire with no
    // route change. That was verified, not assumed; a route that enumerated
    // fields would have made this the third dead-data field in the app's
    // history (v3.9.0 finding 7).
    usage: usedUsage,
  };
}

// Exported for tests (v3.0.1-beta.11+)
export const __testing = { buildSlugCatalogue, scorePage, buildPrompt, stripCatalogueEcho, extractAsk, RESPONSE_STYLES, normalizeResponseStyle, normalizeChatProvider, normalizeChatModel, buildAssistantMessage, normalizeReportedUsage };
