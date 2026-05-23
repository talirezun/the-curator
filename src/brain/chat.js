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
// New design: select the pages most relevant to the user's query (and
// recent conversation context) and load THOSE in full, up to a budget.
// Always include a compact slug catalogue so the LLM knows what else is
// in the domain (vital for honest "not in the wiki" answers).
//
// Budgets are character-based, not token-based, because the LLM has its
// own tokeniser and we don't want to depend on it here. ~60 KB of plain
// text ≈ 15-20 k tokens, well within every supported model.

const CONTENT_BUDGET_CHARS    = 60_000;   // total budget for full page content
const CATALOGUE_BUDGET_CHARS  = 8_000;    // separate budget for the slug catalogue
const MAX_PAGES_LOADED        = 40;       // hard cap regardless of budget
const HEAD_SCAN_CHARS         = 600;      // chars from page head used in scoring

/**
 * Pull a compact "slug catalogue" out of the page list — one line per
 * entity/concept/summary, with just the slug + the first heading or
 * one-line description. Gives the LLM full breadth without spending
 * budget on full content. Excludes index.md and log.md.
 */
function buildSlugCatalogue(pages, budget = CATALOGUE_BUDGET_CHARS) {
  const lines = [];
  let used = 0;
  for (const p of pages) {
    if (p.path === 'index.md' || p.path === 'log.md') continue;
    const titleMatch = p.content.match(/^#{1,3}\s+(.+)/m);
    const title = titleMatch ? titleMatch[1].trim().slice(0, 80) : '';
    const line = title ? `${p.path} — ${title}` : p.path;
    if (used + line.length + 1 > budget) {
      lines.push(`(… ${pages.length - lines.length} more pages not shown in catalogue …)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * Score a single page against the query token bag.
 *
 * Filename tokens (3x weight) and heading tokens (2x weight) are the most
 * reliable signal — they reflect what the page is ABOUT. Body-head match
 * (1x weight) catches pages whose subject is in the first paragraph.
 *
 * Returns 0 for pages the query doesn't intersect at all.
 */
function scorePage(page, queryTokens) {
  if (queryTokens.size === 0) return 0;
  let score = 0;

  // Filename slug — tokenise by splitting on '-' and stripping any folder
  // prefix and the .md extension.
  const base = page.path.split('/').pop().replace(/\.md$/, '');
  const slugTokens = base.split('-').filter(t => t.length > 1);
  for (const t of slugTokens) if (queryTokens.has(t)) score += 3;

  // First heading.
  const titleMatch = page.content.match(/^#{1,3}\s+(.+)/m);
  if (titleMatch) {
    const titleTokens = tokenize(titleMatch[1]);
    for (const t of titleTokens) if (queryTokens.has(t)) score += 2;
  }

  // Body head — first HEAD_SCAN_CHARS characters after the first heading.
  const head = page.content.slice(0, HEAD_SCAN_CHARS);
  const headTokens = tokenize(head);
  for (const t of headTokens) if (queryTokens.has(t)) score += 1;

  return score;
}

/**
 * Pick the pages most relevant to the query within a character budget.
 *
 * Exported for unit testing (v3.0.1-beta.11).
 */
export function selectRelevantPages(pages, queryText, opts = {}) {
  const {
    contentBudget = CONTENT_BUDGET_CHARS,
    maxPages = MAX_PAGES_LOADED,
  } = opts;

  const queryTokens = new Set(tokenize(queryText));
  const contentPages = pages.filter(p => p.path !== 'index.md' && p.path !== 'log.md');

  const scored = contentPages
    .map(page => ({ page, score: scorePage(page, queryTokens) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path));

  // If the query had no matches at all, fall back to the pages with the
  // most outgoing wikilinks (proxy for "hub" pages, likely to mention the
  // breadth of the domain). Better than returning nothing.
  let candidates;
  if (scored.length === 0) {
    candidates = contentPages
      .map(page => ({ page, score: (page.content.match(/\[\[/g) || []).length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  } else {
    candidates = scored;
  }

  const selected = [];
  let used = 0;
  for (const { page, score } of candidates) {
    if (selected.length >= maxPages) break;
    const cost = page.content.length + page.path.length + 30; // "--- FILE: ... ---\n" overhead
    if (used + cost > contentBudget) {
      // Try smaller pages later in the candidate list — sometimes a
      // 30 KB page eats the budget but a 2 KB page would still fit.
      continue;
    }
    selected.push({ page, score });
    used += cost;
  }
  return { selected, contentBytes: used, scoredCount: scored.length };
}

function buildPrompt(domain, pages, history, userMessage) {
  // Pull recent history into the query context so a multi-turn
  // conversation about "vector databases" still finds the right pages
  // when the user types just "tell me more about HNSW".
  const recentUserTurns = history
    .filter(m => m.role === 'user')
    .slice(-2)
    .map(m => m.content);
  const queryContext = [...recentUserTurns, userMessage].join(' ');

  const { selected, contentBytes, scoredCount } = selectRelevantPages(pages, queryContext);

  const wikiContext = selected
    .map(({ page }) => `--- FILE: ${page.path} ---\n${page.content}`)
    .join('\n\n');

  const catalogue = buildSlugCatalogue(pages);

  const historyText = history.length > 0
    ? '[Conversation so far]\n' +
      history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n') +
      '\n\n'
    : '';

  const selectionNote = scoredCount > 0
    ? `Selected ${selected.length} of ${scoredCount} matching pages (loaded ${(contentBytes/1024).toFixed(1)} KB of full content).`
    : `No keyword match for the query — fell back to ${selected.length} most-linked hub pages (loaded ${(contentBytes/1024).toFixed(1)} KB).`;

  return `The user is having a conversation about the "${domain}" domain wiki.

[Domain catalogue — ALL pages available, with title preview]
${catalogue}

---
[Relevant pages loaded in full]
${selectionNote}

${wikiContext}

---
${historyText}[New message from user]
${userMessage}

Instructions:
- Answer using the full content of the loaded pages above, plus the catalogue for what else exists in the domain.
- If the answer is in a catalogue page that wasn't loaded in full, say "I see we have a page on X but I'd need to look at it directly" and cite the path.
- If the answer is not in the wiki at all, say so honestly.
- Cite pages inline using [source: path/to/page.md] format.
- Synthesize across pages; do not quote large blocks verbatim.
- Be conversational — this is a multi-turn chat, not a one-shot Q&A.
- Keep answers focused and concise.`;
}

export async function sendMessage(domain, conversationId, userMessage) {
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

  const prompt = buildPrompt(domain, pages, history, userMessage);
  const answer = await generateText(schema, prompt, 4096);

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
  };
}

// Exported for tests (v3.0.1-beta.11)
export const __testing = { buildSlugCatalogue, scorePage, buildPrompt };
