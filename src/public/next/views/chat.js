// View: Chat — the way in to the wiki.
//
// It is NOT "the default view" any more, and this line used to say that it
// was. v3.49.0 moved HOME_VIEW to 'domains' (app.js), so the phrase became
// false and stayed in two places: here, and — until v3.61.0 — in the
// rendered eyebrow of both centre headers, where a user could read it. The
// header now reads `ask your wiki`; the change is recorded at
// scripts/test-next-view-header.js's chat.js block.
//
// DEVIATION FROM THE DESIGN SPEC (explicit product decision, not an
// oversight): the spec (README.md screen 1) describes ONE cross-domain
// conversation with domains as a multi-select filter (`All domains` +
// per-domain chips). That has been overridden — Chat stays DOMAIN-SCOPED,
// exactly like the shipping app: one active domain, its own conversation
// history, `POST /api/chat/:domain`. The scope bar below is therefore a
// single-select domain SWITCHER, not a filter, and there is no
// `All domains` pill. The live "N pages in scope" readout survives the
// override unchanged — it just reflects the one active domain's page
// count instead of a multi-domain sum.
//
// Owns views/chat.css. Reader-overlay content and the composer's model/
// length pickers are real here (not the Phase-1 demo stub they replace).
// The icon set this view needs (paperclip, chevron-down, send, search,
// plus, trash, alert-circle) lives in app.js's shared ICON_BODY — see
// icon() below — there is no view-local icon table.

import {
  registerView, setSidebar, setMain, emptyCard, escapeHtml, icon, openReader, navigate, isCurrentMount,
  reportAsyncMountFailure, isCurrentReader, reportAsyncActionFailure,
  consumeChatScopeRequest, requestSettingsSection,
} from '../app.js';
// The ONE view header in /next. `eyebrow()` is no longer imported: both of its
// call sites here built a header by hand — an eyebrow, then a raw
// `<h1 class="view-title">`, then, on the zero-domain branch, a paragraph. The
// component owns all three and has NO parameter that renders prose in the
// header body, so that shape is no longer expressible on this view. See
// shared/text.js's own header for why `info` is the only prose field and why it
// is emitted only inside a panel that is `hidden` on first paint.
import { renderViewHeader, renderReadoutGroup } from '../shared/text.js';
// G2 (v3.71.0, COPY.md §3): the Chat header had no ⓘ at all — the domain
// chips, the PROJECT pin, Length and Model were unexplained. `CHAT_INFO` is
// the framing top ⓘ (second brain → Shared Brain → agent memory, "you are
// here" on second-brain) every other top ⓘ in the app now opens with.
import { explainerHtml } from '../shared/explainer.js';
import { renderMarkdown } from '../shared/markdown.js';
// v3.72.0 (P2 + P3): the answer renderer — numbered inline citation markers
// and ONE Sources list under the answer, in the page-type channel. Replaces
// the raw `[source:]` path tags AND the title-chip row that repeated them.
import { renderAnswer, sourcesHtml, sourceByNumber } from '../shared/answer.js';
// The ONE honest USD renderer for /next. Imported, never re-implemented: a
// local `'$' + n.toFixed(4)` renders any charge below $0.00005 as the string
// `$0.0000`, i.e. a paid answer labelled free — and a one-word chat turn on the
// cheapest model measures ~$0.0000015, so that is this surface's ORDINARY case,
// not an edge case. See shared/format-usd.js.
import { formatUsdHonest } from '../shared/format-usd.js';
import { formatModelSummary, formatDurationMs } from '../shared/model-summary.js';
// v3.72.0 (P4): the ONE model-row body, shared by the Model menu and the
// browse dialog — see the model-row region below.
import { modelRowBodyHtml, modelMenuFootHtml, providerWord } from '../shared/model-row.js';
import { confirmThen, closeConfirmIfOpen } from '../shared/confirm.js';
// THE RUN LINE (v3.67.0). One line, the same on every AI action in the app:
// which model runs it, roughly what it costs, and one door to Providers & keys.
// Compile uses it three ways — first line of its confirm, the after-the-run
// line in its outcome card, and the no-key state of its button (disabled, never
// hidden). The shell's two door functions are INJECTED into wireAiRunDoors
// (shared/ai-run.js's own rule), never imported by the kit.
import { renderRunsOn, renderSpent, aiActionDisabledAttrs, wireAiRunDoors } from '../shared/ai-run.js';
// The one dropdown surface in /next. Adopted here for the composer's model and
// length pickers, which until now were the last hand-rolled menus in the tree
// and the only ones with no keyboard operation at all.
import { renderListboxHtml, mountListbox, closeAllListboxes } from '../shared/listbox.js';
import { createLoadingGate, gatedLoader, settleGate } from '../shared/loading-gate.js';
// The design system's two-layer ring, adopted here for the waiting state. It is
// the RIGHT component for this case and not merely a nicer spinner: its whole
// reason for existing (v3.9.0) is a single LLM call with no sub-progress, where
// the honest outer ring is EMPTY and an orbit carries the liveness.
//
// ── ITS ROLE NARROWED WHEN STREAMING LANDED, AND THE HONESTY RULE DID NOT ──
// This used to be the whole waiting state, on the premise that a chat turn is
// one non-streaming POST so time-to-first-byte EQUALS total. That premise is
// now false for a streaming response: deltas arrive long before the answer is
// finished (measured on `z-ai/glm-5.3-flash`: reasoning deltas from ~460ms,
// first CONTENT delta only at 86-91% of the way through a 45-99s turn). So the
// ring is now a PRE-ROLL — it covers the gap before the first delta of any
// kind, after which the streamed text itself carries the liveness.
//
// What did NOT change is the rule: still no `stages`, still `value: null`,
// still the component's activity-only mode (track + orbit, `role="progressbar"`
// with NO `aria-valuenow` — the standard "running, amount unknown"). Streaming
// gives us a token COUNT, which is not progress: `max_tokens` is a cap, not a
// forecast, and there is no denominator anywhere. An arc derived from tokens
// seen would be the same dishonesty as one derived from the clock, wearing a
// more convincing costume.
import { progressRingHtml } from '../shared/progress-ring.js';

// The ONE SSE frame reader for this frontend. Chat-turn streaming is its first
// adopter; see that module's header for why a sixth hand-rolled `reader.read()`
// loop was not written here.
import { readSseFrames } from '../shared/sse.js';
// The app-wide freshness scale, dot AND word, so the project pill's mark
// means the same thing here as it does in Context and Domains. One ladder,
// one stylesheet (shared/freshness.css owns the `fresh-` prefix outright).
import { formatAge, freshnessTier } from '../shared/age.js';
// CONTINUITY BY IDENTITY (v3.65.1). The ONE mapping from an install's domain
// index to its colour slot; the colours are shared/sidebar.css's
// `.cur-sb-dot-N`. Imported here so a domain chip in the scope bar is the
// same colour as that domain's row on the Domains rail, its project rows on
// the Context rail, and its destination row in Ingest.
import { identityDotClass } from '../shared/sidebar.js';
// v3.72.0: the conversation pane is its own DOM-free module (rows through the
// ONE sidebar component, the Select mode, live groups) — see its header.
import {
  conversationPaneHtml, wireConversationPane, convKey,
} from './chat-list.js';
import { subscribeAgeTicker, tickAgesNow, ageWordsFor } from '../shared/age-ticker.js';
// THE DEPTH BAR (design rule 6, v3.66.0). The project picker's footer is one
// of the four hosts that sit OUTSIDE a monitor, so it imports the bar from its
// public address rather than from shared/monitor.js. See
// `projectDocumentsReadout` for the one reading it draws.
import { renderDepthCell } from '../shared/depth-bar.js';

// ── Markdown rendering ──────────────────────────────────────────────────
// The renderer now lives in next/shared/markdown.js so the wiki-browse
// reader in views/domains.js renders rich Markdown from the SAME code path
// this view uses, instead of shipping escaped Markdown source. There is
// exactly one copy — see that file's header for the cardinal escape-first
// rule, the widened input surface it now has to survive, and why the
// emitted `chat-*` class names kept their prefix. The supplemental CSS for
// those classes (including the rules that make them work inside the reader
// overlay) stays in this view's chat.css, which index.html loads globally.

// ── Small pure helpers ───────────────────────────────────────────────────

function folderOfPath(p) {
  const seg = String(p || '').split('/')[0];
  return (seg === 'entities' || seg === 'concepts' || seg === 'summaries') ? seg : null;
}

/* v3.72.0: `typeChipClass`, `titleFromSlug` and `citationLabel` are gone with
   the `.chat-cite-row` title chips they labelled. An answer's sources are now
   shared/answer.js's ONE Sources list (P2), whose chip is shared/page-chip.css
   and whose title falls back exactly as `citationLabel` did. `isSameLocalDay`
   and the dead `timeAgo` went with the old TODAY/EARLIER grouping — the list's
   groups and ages are views/chat-list.js's, and tick (shared/age-ticker.js). */

// NIT-10 fix: indexed by server-supplied provider strings (state.modelProvider
// / state.activeProvider come from the /api/config/api-keys response) — same
// __proto__/constructor lookup hazard as app.js's READER_TYPE_CLASS/DOT maps,
// closed the same way.
// 'Claude' rather than 'Anthropic' is deliberate and predates OpenRouter: the
// composer names the thing that answers, and users say Claude. 'OpenRouter' is
// the vendor's own capitalisation — note the wire field is `hasOpenrouterKey`
// with a lowercase r, because the route derives it mechanically from the id.
// G2 (v3.71.0): computed once, like every other explainer adopter — the
// entry's own `visual.here: 'second-brain'` already marks this view's place
// in the frame, so no `{ here }` override is needed here.
const CHAT_INFO = explainerHtml('chat.page');

// ── THE PROJECT ⓘ IS RETIRED (v3.72.0) ─────────────────────────────────
// It explained one control inside a sticky bar and, opened, took the thread's
// height (DESIGN.md §0.4). Its three points now live in `chat.page`, the ONE
// page ⓘ the view header carries; the project pill on the composer is named
// in words and needs no mark of its own.

const PROVIDER_LABELS = Object.assign(Object.create(null), {
  gemini: 'Gemini',
  anthropic: 'Claude',
  openrouter: 'OpenRouter',
});
const STYLE_LABELS = { concise: 'Concise', balanced: 'Balanced', comprehensive: 'Detailed' };
const STYLE_ORDER = ['concise', 'balanced', 'comprehensive'];

// Compile to Wiki (v3.0.14/v3.0.1-beta.15 parity — src/public/app.js's
// COMPILE_MIN_USER_MESSAGES): one good question->answer exchange is worth
// saving. Backend MIN_USER_MESSAGES in src/brain/compile.js matches; a
// conversation with fewer user turns gets refused server-side with a plain
// "too short to compile" reason rather than the button ever appearing.
const COMPILE_MIN_USER_MESSAGES = 1;

// ── localStorage keys ────────────────────────────────────────────────────
// STYLE and PROVIDER deliberately read/write the SHIPPING app's own keys
// (src/public/app.js CHAT_STYLE_KEY / CHAT_MODEL_KEY) rather than a /next-
// namespaced pair — verified the stored-value FORMATS are identical before
// wiring this up, not just the key names: CHAT_STYLE_KEY holds one of the
// plain strings 'concise'|'balanced'|'comprehensive' (app.js CHAT_STYLES),
// exactly STYLE_ORDER below; CHAT_MODEL_KEY holds a provider id, exactly the
// provider strings used here. Both sides already
// guard every read with an `.includes()` allow-list against the live
// available-providers/styles list (see applyApiKeys below and app.js's own
// `CHAT_STYLES.includes(saved)` / `providers.includes(saved)`), so an
// unrecognised or stale value on either side already degrades to "not set"
// rather than being applied — no extra normalisation needed here.
//
// ── v3.15.0: THE TWO SIDES NO LONGER WRITE THE SAME VALUE SET ────────────
// /next can now write 'openrouter' into this shared key; /old cannot, and
// deliberately will not — it has no OpenRouter support and its four files
// are byte-frozen. So /old will read a provider id it does not recognise.
// VERIFIED, not assumed: src/public/app.js:1862 reads it as
// `providers.includes(saved) ? saved : (providers.includes(data.activeProvider)
// ? data.activeProvider : providers[0])`, and its `providers` array is built
// from hasGeminiKey/hasAnthropicKey only — so 'openrouter' fails the
// `.includes()` and falls through to the active provider or the first keyed
// one. The user's /old chat quietly uses a provider /old can actually reach,
// which is the correct degradation and needs no change on either side. It is
// recorded here because "a stale value degrades safely" is the whole reason
// sharing this key was acceptable, and that argument now has to hold for a
// value one writer produces and the other has never heard of. Reading
// the same keys means a user's per-chat model and response-length choice
// survives the /next cutover instead of silently resetting to the
// defaults (global provider, 'balanced'). LS_DOMAIN has no shipping
// counterpart (the shipping app doesn't persist a chat-scoped domain this
// way) and stays namespaced to this shell.
const LS_DOMAIN = 'curator-next-chat-domain';
const LS_STYLE = 'curator-chat-response-style';
const LS_PROVIDER = 'curator-chat-model-provider';
// The per-conversation MODEL id. Deliberately /next-namespaced and NOT sharing
// a key with anything the shipping app writes: LS_PROVIDER above holds a
// provider id, and this holds a model id like 'claude-sonnet-5'. Two
// different value FORMATS must never share one key — that is how a stale value
// from the other writer gets applied as if it were ours.
const LS_MODEL = 'curator-next-chat-model';
// ── THE WORKING SET'S TWO CLIENT-SIDE LISTS ──────────────────────────────
// Both are JSON arrays of model-id strings, /next-namespaced, and both follow
// the precedent already set by LS_MODEL / LS_STYLE / theme: per-browser
// convenience state, never anything the server needs. A corrupt, absent or
// hand-edited value degrades to an EMPTY list (see `parseIdList`), which
// degrades the working set to its measured tier — never to an exception and
// never to a smaller catalogue, because "every model stays reachable" must not
// depend on localStorage being intact.
const LS_MODEL_RECENTS = 'curator-next-chat-model-recents';
const LS_MODEL_STARRED = 'curator-next-chat-model-starred';
// ── THE PINNED PROJECT, PER DEVICE AND PER DOMAIN (v3.64.0) ──────────────
//
// PER DEVICE, NOT PER CONVERSATION, and that is the decision rather than the
// easy option. A conversation's JSON is TRACKED by the knowledge repo
// (CLAUDE.md: `conversations/*.json` is on none of the gitignore lists, which
// is why sending one chat message ticks the Sync badge), so a per-conversation
// pin would be a schema field that TRAVELS — to a machine where that project
// may not exist, on a thread the user opened to re-read an answer. Per device
// is the reversible choice.
//
// KEYED BY DOMAIN, as one JSON map `{ "<domain>": "<project>" }`. Switching
// domains therefore shows no pin (the new domain has none) and switching back
// restores the one you had, which is the behaviour a one-value key cannot
// give. Any failure — absent key, private-mode throw, hand-edited value,
// wrong shape — degrades to NO PIN, never to an exception and never to a pin
// for a project this domain does not have: the pill is a retrieval widening,
// so its fail-safe direction is "wiki only".
const LS_PROJECT = 'curator-chat-project-v1';
// A ceiling on the map, so a user who cycles through many domains does not
// grow an unbounded localStorage entry. Oldest-written entries are dropped.
const MAX_PINNED_PROJECTS = 40;

/**
 * ── THE GATE IS OPEN: THE BACKEND LANDED IN v3.13.0 ────────────────────────
 *
 * This constant was held at `false` for a real reason, recorded below because
 * it is the reason any FUTURE gated feature in this file should be held the
 * same way. It is now `true` because the three backend edits the gate was
 * waiting on have all shipped, in the exact shape planned:
 *
 *   1. `normalizeChatModel(provider, model)` (src/brain/chat.js) — mirrors
 *      `normalizeChatProvider`: returns `model` only when
 *      `isOfferableModel(provider, model)` (exported from src/brain/llm.js) is
 *      true AND that provider has a key SAVED IN SETTINGS (`getApiKeys()`,
 *      never `getEffectiveKey`/.env — the v3.0.13 rule). Anything else → `null`
 *      → the provider default. Exported on `chat.js`'s `__testing`.
 *   2. `sendMessage` (src/brain/chat.js) resolves `chatModel` via that
 *      function and threads it into `generateText(..., { provider, model })`,
 *      and returns the actually-served `model` alongside `provider`.
 *   3. `POST /api/chat/:domain` (src/routes/chat.js) now destructures `model`
 *      from the body and passes it straight through — deliberately with NO
 *      validation at that layer; `normalizeChatModel` is the sole gate.
 *
 * WHY IT WAS OFF, kept verbatim as the record of the hazard this constant
 * existed to hold shut — every row in this picker carries a PRICE, and before
 * the backend read `model` at all, a user picking "Opus 5 · $5/$25" would have
 * been quietly served Haiku 4.5 at $1/$5: a falsehood about both capability
 * and money, not a cosmetic gap. This repo has shipped inert controls before
 * and recorded them as defects (v3.7.0's five inert controls, v3.9.0's
 * hardcoded sync badge); an inert control that looks functional is worse than
 * no control, and worse still when it quotes a price. That is why this was
 * held behind a constant instead of shipped with a caveat, and it is the bar
 * the next gated feature in this file should be held to as well.
 *
 * Everything downstream of the flag was already complete and covered by
 * scripts/test-next-composer-model.js before the flip (it drove the real
 * renderers with the gate FORCED ON), so turning this on shipped an
 * already-proven surface rather than an unproven one.
 */
const MODEL_PICKER_ENABLED = true;

// ── View state ────────────────────────────────────────────────────────────

const state = {
  // Has boot() reached a conclusion about how many domains exist?
  //
  // THE DEFECT THIS EXISTS FOR: `domains: []` is both "we have not asked
  // yet" and "there genuinely are none", and renderMain branched on
  // `.length === 0` alone — so the FIRST FRAME A BRAND-NEW USER EVER SEES
  // was "Chat needs at least one domain to talk to", asserted before a
  // single request had been made. It is not merely premature, it is
  // FALSE, and it is false on the app's default view.
  //
  // Deliberately a third state rather than a nullable `domains`: every
  // other reader of state.domains (scope pills, resolveBootDomain,
  // switchDomain) can keep treating it as an array.
  booted: false,
  domains: [],           // [{slug, displayName, pageCount, pageCounts, conversationCount}]
  activeDomain: null,
  // v3.72.0 (M1): ONE list across every non-mirror domain, from GET /api/chat
  // — or one domain's, from GET /api/chat/:domain, while the list's domain
  // filter is set. Each row: {id, title, createdAt, messageCount, domain,
  // updatedAt?, lastProject?, matchField?}; `domain` is the storage path's.
  conversations: [],
  // The list's domain filter: null = all domains, else one slug.
  domainFilter: null,
  // The server's TRUE count for the last list answer (GET /api/chat's
  // `total`), which can exceed the rows fetched; and the domains whose
  // conversations folder could not be read, named rather than swallowed.
  listTotal: 0,
  listUnreadable: [],
  // Select mode (M3): checkboxes and the contextual bar are shown only while
  // this is on; the per-row trash is hidden while it is.
  selectMode: false,
  // What the search box currently HOLDS. It is NOT a client-side filter:
  // `conversations` is already whatever the server returned for the last
  // COMPLETED search, so this is read only to (a) repopulate the input's
  // value across a re-render and (b) word the empty state. Filtering moved
  // to the server because a conversation's title is its first user message
  // truncated at 57 chars, so a title-only predicate could never reach
  // anything said after the opening line of a thread — and the bodies that
  // would have to be searched are never loaded client-side.
  searchQuery: '',
  // Pending debounced search refetch. Cleared on teardown (timer hygiene:
  // an armed timer that outlives this mount would fetch and paint into
  // whatever view came next) and whenever a new keystroke supersedes it.
  searchTimer: null,
  // Conversations ticked for bulk delete.
  //
  // INVARIANT, and it is the safety property of the whole feature: this may
  // only ever contain ids that are IN state.conversations — see
  // pruneSelection(), which runs on every list update. Without it a
  // selection made before a search, a delete, or a domain switch could
  // survive into a list that no longer shows those rows, and "Delete
  // selected" would then destroy conversations the user cannot see. A Set,
  // so re-ticking a row cannot queue the same id twice.
  selectedConvKeys: new Set(),   // convKey(domain, id) — ids are unique only per domain
  // Outcome of the last bulk delete: {text, tone}. Rendered in the sidebar
  // because a partial failure has nowhere else to be seen — the list simply
  // comes back with some rows still in it, which on its own is
  // indistinguishable from having mis-clicked.
  bulkNotice: null,
  activeConversationId: null,
  thread: [],             // [{role, content, citations?, citationTitles?, error?}]
  sending: false,
  // ── WHICH CONVERSATION IS BEING ANSWERED (v3.64.1) ──────────────────────
  //
  // The sidebar's "answering" mark, and nothing else. Written by
  // `sendCurrentMessage` at send time and cleared in its `finally`, so it has
  // exactly the same lifetime as the `sendAbort` record — it is a SECOND
  // READER'S VIEW of that one fact, not a second copy of it, and the reason it
  // exists at all is written out on `conversationIsAnswering`: the row builder
  // is lifted and executed by a suite whose sandbox declares `state` and not
  // the module's turn record.
  //
  // Both fields or neither: an id is unique only inside one domain's folder.
  //
  // NOT RESET BY `onEnter`, on purpose. It is the one piece of turn state that
  // is still TRUE across a re-mount — the turn really is still running — and
  // blanking it would take the mark off the list at the exact moment the user
  // comes back looking for it.
  answeringConvId: null,
  answeringDomain: null,
  // Outcome of the last STOPPED turn: {text} or null. Rendered at the foot of
  // the thread.
  //
  // TRANSIENT STATE, DELIBERATELY NOT A `state.thread` ENTRY. A compile outcome
  // IS pushed into the thread (see renderThreadOnly's `role === 'compile'`
  // branch) because it records something that really happened to the wiki and
  // must survive every later rebuild. A cancelled turn is the opposite: the
  // server persisted NOTHING (writeConversation only runs after the model
  // returns), so a thread entry would be a claim about a conversation that does
  // not exist on disk and would reappear on every repaint until navigation. The
  // sidebar's `bulkNotice` above is the precedent this follows.
  cancelNotice: null,
  // ── THE PINNED PROJECT (v3.64.0) ────────────────────────────────────────
  //
  // `projectRows` is this domain's projects as `GET /api/memory/:domain/
  // projects` returned them, `projectsFor` is the domain they belong to, and
  // `projectsState` is 'idle' | 'loading' | 'ready' | 'error'. Kept as three
  // fields rather than one nullable object because "not asked yet", "asked
  // and none exist" and "asked and it failed" are three different pills, and
  // this view has already paid once for collapsing exactly that distinction
  // (see `booted` above).
  projectRows: [],
  projectsFor: null,
  projectsState: 'idle',
  // When `projectRows` were fetched (Date.now()). Each row's `ageSeconds`
  // was measured by the server AT that instant, so a row's age now is
  // ageSeconds + (now − projectsFetchedAt)/1000 (truth audit F3).
  projectsFetchedAt: 0,
  // The pinned project's slug for the ACTIVE domain, or null. Restored from
  // localStorage on mount and RECONCILED against `projectRows` the moment
  // they arrive — a project that has been deleted must not keep being sent.
  activeProject: null,
  // WHERE the pill's project came from (v3.76.0, F13): 'pin' — the
  // per-domain, per-browser pin (the default, and every new chat) — or
  // 'conversation', restored from the reopened conversation's own last turn.
  // A restored project is a reading of THAT thread, not a preference: it is
  // never written into the pin, and a project it names that has since gone
  // clears the pill without erasing the pin.
  activeProjectFrom: 'pin',
  // The WORK-STREAM within that project, or null for "whichever is newest".
  //
  // IN MEMORY ONLY, deliberately, and it is the one field here that is not
  // persisted. The PROJECT pin is a per-device preference (Q3); a scope is a
  // pointer at one work-stream, handed over by the Context view when the user
  // pressed "Ask this project" while looking at it. Persisting it would mean
  // a pin made on Monday keeps opening a work-stream that has since been
  // superseded, which is precisely what `latest` exists to avoid. Null is
  // sent as no `scope` field at all, and the STORE decides what `latest`
  // means — this app has already deleted one duplicate of that resolution.
  activeProjectScope: null,
  // What the last answered turn's project context actually contributed:
  // `{chars, documents, …}` straight off the server's own measurement, or
  // null. NEVER computed here — the server is the only thing that knows what
  // went into the prompt, and a client-side estimate beside a real one is the
  // dead-data shape this file already refuses for `usage`.
  projectLastUsed: null,
  // v3.65.0, P10 — WHICH WIKIS the pinned project's knowledge lives in, off
  // `GET /api/memory/:domain/:project`. A DISCLOSURE, never a selection: see
  // `ensureProjectKnowledge` for the two measured reasons Chat does not move
  // the chips. `{project, domains, defaulted, missing, error}` or null.
  projectKnowledge: null,
  responseStyle: 'balanced',
  modelProvider: null,    // null -> global active provider
  availableProviders: [], // config-scoped subset of PROVIDER_KEY_FLAGS' ids
  // The subset of availableProviders that can serve a turn in which NO MODEL IS
  // NAMED — i.e. the ones the provider-only menu may offer, and the only ones a
  // restored localStorage provider may resolve to. Derived from `models[p]`
  // below (the backend's own getDefaultModel), never a hardcoded id list.
  //
  // WHY IT IS A SEPARATE LIST. `availableProviders` means "has a saved key" and
  // is what scopes the catalogue (normalizeOfferable, resolveChatModel) — that
  // meaning must not move. But having a key does not imply being usable: an
  // OpenRouter key with nothing measured yet gives `models.openrouter === null`,
  // so there is no model to send. Offering it anyway is what let the composer
  // put a provider on screen, persist it, and POST it on every message while the
  // backend silently discarded it and billed whichever provider was active.
  providerOnlyProviders: [],
  models: {},             // {gemini, anthropic, openrouter} default model ids, for labels
  // The pickable-model catalogue, per provider, cheapest-first, exactly as
  // GET /api/config/api-keys returned it. Already config-scoped SERVER-side
  // (a provider with no saved Settings key gets `[]`), and re-scoped CLIENT-side
  // by normalizeOfferable so the v3.0.13 rule holds even if that ever changes.
  offerable: { gemini: [], anthropic: [], openrouter: [] },
  // ── THE BUILD MODEL, AND WHETHER ITS PROVIDER STILL LISTS IT ────────────
  // `GET /api/config/api-keys` carries `build.liveMissing`, three-valued. Chat
  // reads it for ONE reason: a turn sent with no model named resolves through
  // the active provider's default, which IS this model — so a retired build
  // model is also a retired chat default, and the composer is where that is
  // felt. Stored as the pair, never as a bare flag: the verdict is about ONE
  // model id, and a flag with no id attached would go on claiming after the
  // model changed underneath it.
  buildModelId: '',
  // v3.72.0 (P4): the build model's PROVIDER, so the Model menu marks exactly
  // one row "default" (two providers may list one id), and the OpenRouter
  // catalogue's own sync stamp for the menu's foot. Both from the same
  // /api/config/api-keys payload applyApiKeys reads; null when not sent.
  buildProvider: null,
  orCatalogueSyncedAt: null,
  buildLiveMissing: null,   // true | false | null — null is UNKNOWN, never gone
  // PER-BROWSER, not per-conversation. Persisted to localStorage[LS_MODEL] on
  // pick and restored in applyApiKeys, and nothing clears it on a conversation
  // switch — so one selection carries across every conversation and survives a
  // reload. (This line previously claimed the opposite, and was contradicted
  // by describeAnswerModel's docblock further down THIS same file.)
  // null -> the provider's default.
  //
  // The stickiness is deliberate and is SAFE ONLY BECAUSE every answer carries
  // the model that actually produced it (see describeAnswerModel /
  // assistantEyebrowHtml): a selection that outlives the conversation you made
  // it in is fine while each message says what answered it, and becomes a
  // silent surprise the moment it does not. Removing the per-message label
  // would remove the argument for keeping this sticky.
  chatModel: null,
  // ── THE WORKING SET'S TWO USER-DRIVEN LISTS ─────────────────────────────
  // Model ids, most-recent-first / newest-star-first, restored from
  // localStorage in applyApiKeys and written on every pick or star. They are
  // CONVENIENCE state, exactly like the theme and the sticky model pick: a
  // browser that loses them shows the measured tier and every model is still
  // one click away, so nothing a user can reach depends on them surviving.
  modelRecents: [],
  modelStarred: [],
  activeProvider: null,   // global active provider (fallback label when modelProvider is null)
  loadError: null,
  convToken: 0,           // guards against out-of-order conversation-list fetches (SAME mount, e.g. two quick conversation clicks)
  selectToken: 0,         // guards against out-of-order selectConversation resolutions (SAME mount)
  readerToken: 0,         // guards against out-of-order reader-page fetches (SAME mount)

  // Compile to Wiki. Deliberately a SINGLE global lock (matches the
  // shipping app's `compileBusy`, not per-conversation) — one compile in
  // flight is enough; a second click while one is running is refused by the
  // button's own `disabled`, not by conversation identity.
  //
  // THE LOCK'S LIFETIME IS THE RUN, NOT THE MOUNT. `compileOwner` carries the
  // token of the run that currently holds it (minted by runCompile from
  // `compileRunSeq`), and updateCompileButtonBusy refuses to publish anything
  // on behalf of a token that is not the current owner. That is what makes
  // "only the run holding this lock may release it" a property of the code
  // rather than a rule someone has to remember: before this, onEnter cleared
  // compileBusy on EVERY mount, so navigating away from Chat and back during
  // the 15-45s LLM call (src/brain/compile.js emits progress(20) and then
  // nothing until progress(85), so there is no SSE frame for almost the whole
  // run) re-enabled the button and a second click fired a SECOND paid,
  // destructive compile — whose route then told the user to delete a
  // .write-lock the first, still-running compile was legitimately holding.
  // See onEnter's own comment for why state.sending is different and IS still
  // reset there.
  //
  // `compilePct` is read by a full renderMain() rebuild (e.g. a domain switch
  // mid-compile, or a fresh mount arriving while a compile is in flight) so
  // that rebuild reflects the LAST progress this view actually saw rather
  // than resetting to 0% — the live, frame-by-frame update during a compile
  // writes straight to the DOM (see updateCompileButtonBusy) without going
  // through a full render. There is deliberately NO `compileLabel`: both the
  // live fast path and renderCompileButtonHtml render the identical
  // "Compiling… NN%" string, so the per-frame SSE `message` had no consumer.
  // It used to be stored here and read by nothing (two docblocks claimed
  // renderMain read it; renderMain never did). If that message should be
  // surfaced, the honest way is the shipping app's shape — a real progress
  // ROW with its own label element (src/public/app.js's #compile-progress-
  // label) — not a field held in state on the chance someone renders it.
  compileBusy: false,
  compilePct: 0,
  compileOwner: null,

  // THE NO-KEY STATE OF COMPILE (v3.67.0), CARRIED AS READY MARKUP. Both are
  // '' whenever a run is possible or nothing has been asked yet — the resting
  // state must never guess "no key" before the answer is in, because a
  // disabled Compile on a working install is a false fault.
  //
  // Precomputed by `applyCompileRunsOn` (from GET /api/health/ai-available's
  // `runsOn`, the contract's ONE resting-state source) rather than computed
  // inside `renderCompileButtonHtml` / `compileControlHtml`: both are lifted by
  // brace-match into suites whose sandboxes bind `state` and nothing from
  // shared/ai-run.js, so the markup rides on `state` (the contract's own
  // mitigation for lifted bodies) and those bodies gain no free identifier.
  compileKeyAttrs: '',
  compileKeyLineHtml: '',
};

// The two run-line ids Compile owns. Distinct, because the button's line and
// the confirm's line can both exist at once and aria-describedby names ONE.
const COMPILE_RUNLINE_ID = 'chat-compile-runline';
const COMPILE_CONFIRM_RUNLINE_ID = 'chat-compile-confirm-runline';

// Monotonic; source of `state.compileOwner`. Module-scoped (not in `state`)
// because it must never be reset — a reused owner token would let a stale run
// release a newer run's lock, which is the whole thing compileOwner prevents.
let compileRunSeq = 0;

let escHandler = null;
// The age ticker's unsubscribe, held for the teardown (v3.72.0).
let stopAgeTicker = null;

// `myMountToken` still exists so a handler invoked SYNCHRONOUSLY by a real
// user event (a click, a keydown — no `await` between the event firing and
// this variable being read) can read "the current mount's token" and be
// certain it's still correct: nothing else runs between the event and that
// read, so it cannot have gone stale. It must NEVER be read again by a
// function AFTER an `await` — at that point it may have been overwritten by
// a newer mount (including a re-entry into this same view by name; see
// app.js's isCurrentMount() doc comment for why that specifically matters).
//
// H1 re-audit fix (was the exact bug the H2/H3 comment below used to
// describe having closed, and hadn't): every async function that resumes
// after an await now captures ITS OWN token as a local variable at entry —
// before any await — and threads that local through to every render call
// and every nested async call it makes, rather than re-deriving it later
// from this shared variable. Reproduced before this fix: mount Domains
// (token A), navigate to Chat (token B) and back to Domains (token C) —
// while a health scan kicked off under token A was still in flight, it read
// the (by-then-live) `myMountToken`, saw C, and concluded "still current"
// even though the actual current mount had already moved on twice past it.
// Concretely for Chat: send a message, click Domains while the model is
// still thinking, click back to Chat (a fresh mount, its own boot() run) —
// the in-flight answer used to resolve, read the live myMountToken (now
// pointing at the NEW mount), decide it was current, and overwrite whatever
// conversation the user is now looking at with the old send's answer.
let myMountToken = 0;

// Delay-gated loading indicator for boot(). Built in onEnter, cancelled in
// the teardown. See shared/loading-gate.js.
let bootGate = null;

registerView('chat', {
  onEnter(mountToken) {
    myMountToken = mountToken;
    // Found live while verifying the H1 fix above: `state.sending` is
    // module state that survives a remount (this file's `state` is
    // deliberately NOT reset on every onEnter, same design as Domains — see
    // the comment on `myMountToken`), so leaving Chat mid-send and coming
    // back left a stale "thinking…" bubble under whatever conversation
    // boot() re-selected, even though nothing was actually being sent FOR
    // that conversation. The abandoned send's own eventual resolution is
    // already correctly dropped by sendCurrentMessage's isCurrentMount
    // check — this just makes sure a FRESH mount never opens already
    // showing someone else's spinner.
    //
    // THIS IS THE ONLY FLAG RESET HERE, and the reset IS deliberately
    // ungated. `state.compileBusy` is NOT reset — an earlier version of this
    // file reset it (and compilePct, and a compileLabel that nothing read)
    // under a comment generalising the rule above to "every other busy/
    // transient flag this file owns". That generalisation was wrong, and the
    // two flags differ for a concrete reason:
    //
    //   - state.sending drives a VISUAL ARTIFACT (the trailing "thinking…"
    //     bubble) that the in-flight send will never repaint away on a
    //     foreign mount, because every render sendCurrentMessage makes is
    //     isCurrentMount-gated. Clearing it here loses nothing: that send's
    //     reply is dropped by its own stillRelevant check regardless.
    //
    //     ── THAT ARGUMENT EXPIRED WHEN THE BUBBLE STOPPED BEING AN ARTIFACT.
    //     It is kept above because it is still WHY this reset exists, and
    //     deleting it would lose the history. But "a VISUAL ARTIFACT" was only
    //     ever a fair description of a spinner. A streaming bubble carries the
    //     model's reasoning and a draft of the answer — CONTENT — and painting
    //     another conversation's content into the thread you are reading is a
    //     trust bug in a knowledge app, not a cosmetic one. So the reset is no
    //     longer the only defence: `sendIsOnScreen()` gates every paint of that
    //     bubble on an IDENTITY MATCH (mount + domain + conversation) against
    //     the in-flight turn's own record, rather than on this bare boolean.
    //     The reset stays because it is still correct and still cheap; it is
    //     simply no longer load-bearing on its own. See sendIsOnScreen.
    //
    //   - state.compileBusy is a LOCK on a paid, destructive write. Clearing
    //     it here unlocked a live compile: the button re-enabled, a second
    //     click started a second compile, and the route answered it with
    //     "manually delete <domains>/<d>/.write-lock and retry" — advice that
    //     would remove the only cross-process guard while the FIRST compile
    //     was still writing. Nothing needs to clear it on mount anyway:
    //     runCompile's `finally` releases it unconditionally (no
    //     isCurrentMount gate, and the fetch is never aborted on teardown),
    //     and updateCompileButtonBusy writes the live button ungated by
    //     mount — so a fresh mount opened mid-compile correctly shows a
    //     disabled "Compiling… NN%" button that the run itself re-enables.
    //     There is no path to a permanently-stuck disabled button.
    //
    // AMENDED (chat-cancel), because this change interacts with the rule above
    // and the "only flag reset" line would otherwise become quietly false.
    // `state.cancelNotice` is now reset here too, and it belongs to the FIRST
    // category, not the second, on the same test the two bullets above apply:
    // it is purely a VISUAL ARTIFACT (one recessed line at the foot of the
    // thread), it holds no lock, it guards no paid or destructive work, and
    // nothing will ever repaint it away on a fresh mount — the turn it
    // described is over. Left unreset, a "Stopped." line from before the user
    // navigated away would reappear under whatever conversation boot()
    // re-selects, describing a turn that has nothing to do with it. So: two
    // flag resets here, both artifacts, and `state.compileBusy` still
    // deliberately NOT among them for exactly the reason given above.
    //
    // WHAT IS STILL NOT DONE HERE, AND MUST NOT BE: the in-flight turn's fetch
    // is NOT aborted, on this path or any other except an explicit click on
    // Stop. See `sendAbort`'s declaration for the measurement behind that —
    // in short, an abandoned turn's answer is still written to disk by the
    // server and the user gets it back by re-opening the conversation, so
    // aborting here would destroy a paid answer rather than save one.
    state.sending = false;
    state.cancelNotice = null;
    // Same category and the same reason: a stream buffer is the material the
    // thinking bubble paints from, so leaving it set would let a fresh mount
    // reconstruct the previous turn's reasoning under a conversation that never
    // asked for it. `sendIsOnScreen` would refuse to paint it anyway (the mount
    // token has moved), so this is the second of two layers, not the only one.
    // The in-flight turn keeps writing into its own detached record and its
    // paints are dropped by that same gate.
    sendStream = null;
    // The abandon path. The clock is module-level precisely so it can be
    // stopped from a DIFFERENT mount than the one that started it: the previous
    // mount's send is still in flight (this view never aborts the fetch), and
    // its interval would otherwise keep ticking against a thinking bubble this
    // fresh mount is not showing.
    stopSendClock();

    // ── THE TURN THAT IS STILL RUNNING (v3.64.1) ──────────────────────────
    // REPORTED FROM PRODUCTION: an answer in progress DISAPPEARED the moment
    // the user clicked Domains, and came back only once the turn had finished.
    // The fetch was never aborted (that rule is intact, and §6 of the cancel
    // suite executes it) — but every piece of the LIVE RENDER was thrown away
    // on the way back in. The four resets above blank the flag, the buffers
    // and the clock, and nothing ever re-pointed the turn at the NEW mount, so
    // `sendIsOnScreen`'s `sendAbort.mountToken === token` could never match
    // again and the bubble was gone for the rest of the turn.
    //
    // The resets above STAY, byte for byte and for their original reasons:
    // they are what stops a foreign conversation's bubble opening under
    // whatever boot() re-selects, and `state.sending = false` AT THIS DEPTH is
    // pinned by two suites this package does not own. What is added is the
    // other half of the pair:
    //
    //   · the GLOBAL LOCK is restored HERE, synchronously. One turn at a time
    //     is a property of the APP, not of a mount; leaving the flag false
    //     across a re-mount would let a second send start while the first was
    //     still running and overwrite its abort record — an unstoppable,
    //     unadoptable turn.
    //   · the BUBBLE is restored LATER, by `adoptLiveTurn`, which cannot run
    //     here because boot() has not yet said which conversation is on
    //     screen. Until it does, the identity gate still refuses to paint.
    //
    // Deliberately a SECOND statement rather than `state.sending = !!sendAbort`
    // in place of the reset: the reset is the exact line those two suites read
    // and mutate, and an `if` after it leaves that line alone.
    if (sendAbort) state.sending = true;

    // app.js's consumeChatScopeRequest() contract: this MUST be called
    // exactly once, synchronously, right here — before renderShell/boot,
    // before any `await` anywhere in this function — so nothing can
    // intervene between navigate() invoking onEnter and the pending
    // request (if any) being consumed. Consuming clears it in the SAME
    // call (see app.js's own doc comment on why that's the whole point):
    // a second mount of this view with no new request from Domains gets
    // back { slug: null, firstRun: false } and boots exactly as if nothing
    // had ever been requested — it does NOT re-apply whatever the previous
    // mount consumed. scripts/test-next-chat-compile.js §1 proves this by
    // consuming twice in a row and asserting the second call is empty.
    //
    // `firstRun` is part of consumeChatScopeRequest()'s return shape but
    // this file does not act on it — see resolveBootDomain()'s own comment
    // below for why (Domains creates domains directly now; there is
    // nothing left to hand off).
    const scopeReq = consumeChatScopeRequest();

    // ── COMPILE'S NO-KEY STATE, ASKED ON EVERY MOUNT (v3.67.0) ────────────
    // Every mount, not once: the usual way out of "no key" is the door itself —
    // Settings › Providers & keys, then back here — and a cached answer would
    // keep Compile disabled after the key was saved. Not awaited and not part
    // of the boot gate: the thread never waits on a button's resting state.
    // The door is wired on #view-root, the shell's STABLE container (setMain
    // replaces its child, never it), so one delegated listener serves every
    // render of this view; wireAiRunDoors is idempotent per root, so another
    // view wiring the same element adds nothing.
    wireAiRunDoors(document.getElementById('view-root'), { requestSettingsSection, navigate });
    loadCompileAvailability(mountToken).catch(() => {});

    bootGate = createLoadingGate({
      onChange: () => { if (isCurrentMount(mountToken)) renderShell(mountToken); },
    });
    bootGate.begin();

    renderShell(mountToken); // paints the chat chrome immediately; the thread fills in
    boot(mountToken, scopeReq)
      .catch((err) => reportAsyncMountFailure(mountToken, err))
      .finally(() => {
        // A `finally`, and that is load-bearing: `booted` gates the
        // zero-domain empty state, so a boot that ends in ANY way this
        // file does not otherwise cover — a throw from a path with no
        // handler, an early return — would otherwise strand a brand-new
        // user on a loader forever. This runs however boot ended.
        settleGate(bootGate, () => {
          // Repaint only when the gated branch was actually on screen.
          // Once domains exist, `booted` changes nothing that renders, so
          // an unconditional renderShell here would be pure DOM churn on
          // the common path — exactly the redundant repainting this whole
          // change exists to remove.
          const wasBlocking = !state.booted && !state.loadError && state.domains.length === 0;
          state.booted = true;
          if (wasBlocking && isCurrentMount(mountToken)) renderShell(mountToken);
        });
      });

    // ── ESCAPE, NOW OWNED BY EXACTLY ONE THING AT A TIME ──────────────────
    // The composer's pickers used to need their own Escape and outside-click
    // handlers; shared/listbox.js owns both for a menu now (it stops
    // propagation on Escape while open, and closes on a document pointerdown
    // outside itself), so this handler is left with ONE job: the browse dialog.
    //
    // The ordering is the listbox's, not ours: a menu open INSIDE the dialog
    // stops the Escape event before it reaches here, so the first press closes
    // the menu and the second closes the dialog — which is what a user expects
    // and is why this must not also close the dialog unconditionally.
    escHandler = (e) => {
      if (e.key !== 'Escape') return;
      if (isBrowseDialogOpen()) { e.preventDefault(); closeBrowseDialog(); }
    };
    document.addEventListener('keydown', escHandler);

    // ── EVERY AGE ON THIS SCREEN TICKS (v3.72.0, truth audit F3 + F7) ──────
    // One shared clock (shared/age-ticker.js) rewrites the TEXT of every
    // `[data-age-at]` once a second and never renders this view. The one
    // repaint it may ask for is the list's own light one, when the LOCAL DAY
    // changes, so a conversation from before midnight leaves "Today".
    stopAgeTicker = subscribeAgeTicker({
      onDayChange: () => { if (isCurrentMount(mountToken)) renderSidebarConversationsOnly(mountToken); },
    });

    return () => {
      if (stopAgeTicker) { stopAgeTicker(); stopAgeTicker = null; }
      // Timer hygiene (load-bearing): an armed delay timer that survives
      // this teardown would paint a loader into whatever view comes next.
      if (bootGate) { bootGate.cancel(); bootGate = null; }
      // Same rule, same reason: a debounced search refetch armed by a
      // keystroke a fifth of a second ago would otherwise fire after this
      // view is gone. isCurrentMount inside the callback already refuses to
      // act, but an armed timer is still a timer — cancel it at the source.
      cancelSearchTimer();
      if (escHandler) document.removeEventListener('keydown', escHandler);
      escHandler = null;

      // Shell hard rule #2 (see app.js's navigate() doc comment): rail
      // selection must close the composer's model/length picker,
      // unconditionally, before the next view mounts. The shell has no
      // way to reach in and do this itself — these surfaces are OURS —
      // so navigate() relies on THIS teardown running (which it always
      // does, before the next view's onEnter) to honour that guarantee.
      // Do not remove either call as "redundant cleanup": they are the only
      // place the guarantee is enforced for the real composer. If Chat ever
      // grows another transient overlay, close it here too.
      //
      // The listbox menu lives on <body>, so it does NOT go away with the
      // view's own markup — its rAF loop would close it a frame later on
      // detection of the detached trigger, but a menu that outlives its view
      // even for a frame is the detached-orphan shape this repo keeps paying
      // for. Closed explicitly, here, unconditionally.
      closeAllListboxes();
      closeBrowseDialog();

      // Same rule, one level up: the delete confirm is a real overlay on
      // document.body, so it would otherwise outlive this view entirely.
      // Unconditional and safe when nothing is open; it resolves the
      // pending confirmThen() on the CANCEL path, so a teardown can never
      // fire the delete.
      closeConfirmIfOpen();
    };
  },
});

// ── Boot sequence ─────────────────────────────────────────────────────────

// Pure, DOM-free — deliberately factored out of boot() so the scope-handoff
// decision (which domain to activate) is testable offline without a server
// or a DOM (see scripts/test-next-chat-compile.js). `scopeReq` is whatever
// consumeChatScopeRequest() returned to onEnter — by the time it reaches
// here it has ALREADY been cleared in app.js's module state (this function
// never re-reads it and has no way to; it only ever sees the one value it
// was handed). A request naming a domain that no longer exists (deleted
// between the click and this mount, or just a bad slug) falls back to the
// ordinary saved-domain/first-domain logic rather than silently doing
// nothing — same "never worse than not having scoped at all" shape as
// every other defensive fallback in this file.
//
// consumeChatScopeRequest()'s return also carries `firstRun` — this
// function deliberately does not read it. Chat originally showed a
// create-domain panel when a request arrived with no slug (Domains' old
// "+ New domain" button had no create UI of its own and punted here).
// Domains now creates domains directly (openLifecycle('create'), a real
// modal over POST /api/domains) and no longer produces a no-slug request —
// grep confirms every call site in src/public/next/ passes a real slug —
// so `firstRun` is currently always false in practice. It stays part of
// the CONTRACT (app.js's consumeChatScopeRequest() keeps returning it,
// unchanged, for whichever caller Agent A's degradation path expects it
// from) without this file pretending to act on it. Reviving a Chat-side
// first-run affordance would mean: (a) a producer that calls
// requestChatScope() with no slug again, and (b) this function once more
// branching on `scopeReq.firstRun` the way an earlier version of this file
// did — neither exists today.
function resolveBootDomain(domains, scopeReq, savedLsDomain) {
  const req = scopeReq || { slug: null };
  const list = Array.isArray(domains) ? domains : [];
  if (list.length === 0) {
    return { activeDomain: null, appliedScopeSlug: false };
  }
  if (req.slug && list.some((d) => d.slug === req.slug)) {
    return { activeDomain: req.slug, appliedScopeSlug: true };
  }
  const savedValid = list.some((d) => d.slug === savedLsDomain);
  return {
    activeDomain: savedValid ? savedLsDomain : list[0].slug,
    appliedScopeSlug: false,
  };
}

async function boot(token, scopeReq) {
  let domainsData = null;
  let keysData = null;
  try {
    [domainsData, keysData] = await Promise.all([
      fetch('/api/domains/stats').then(r => r.json()),
      fetch('/api/config/api-keys').then(r => r.json()).catch(() => ({})),
    ]);
  } catch (err) {
    if (!isCurrentMount(token)) return; // H1 fix — the mount that started this boot() may already be gone
    state.loadError = 'Could not reach the app server (' + err.message + ').';
    // Set BEFORE the paint, not after: renderShell reads it, and an error
    // frame rendered while `booted` is still false would show a loader
    // instead of the error.
    state.booted = true;
    renderShell(token);
    return;
  }
  if (!isCurrentMount(token)) return;

  // NOTE: `state.booted` is deliberately NOT set here. It flips in
  // onEnter's settle below, i.e. at the moment we PAINT — setting it on
  // arrival would let boot()'s own renderShell calls paint straight
  // through the min-visible clamp. The error path above is the one
  // exception and says why.

  state.domains = Array.isArray(domainsData.domains) ? domainsData.domains : [];
  applyApiKeys(keysData || {});

  let saved = null;
  try { saved = localStorage.getItem(LS_DOMAIN); } catch { /* ignore */ }
  const decision = resolveBootDomain(state.domains, scopeReq, saved);

  if (!decision.activeDomain) {
    state.activeDomain = null;
    renderShell(token);
    return;
  }

  state.activeDomain = decision.activeDomain;
  // Persist only when the handoff itself chose the domain — an ordinary
  // fallback to the already-saved value (or to domains[0]) has nothing new
  // to remember; re-writing the same key either way would be harmless but
  // this keeps the write scoped to an actual, deliberate scope change,
  // mirroring switchDomain()'s own persist-on-real-change discipline below.
  if (decision.appliedScopeSlug) {
    try { localStorage.setItem(LS_DOMAIN, decision.activeDomain); } catch { /* ignore */ }
  }

  await loadConversationList(token, { autoSelectMostRecent: true });

  // ── A PROJECT HANDED OVER WITH THE SCOPE (v3.64.0) ──────────────────────
  //
  // `consumeChatScopeRequest()` has returned `{slug, firstRun}` since P1-10.
  // The shell widens it, additively, to carry the project the Context view's
  // "Ask this project" door was open on. READ DEFENSIVELY — `project` is
  // absent on every existing producer and on any shell that has not shipped
  // the widening yet, and an absent field must mean "no project", never an
  // exception. Nothing here imports the producer; this is the SAME object
  // `resolveBootDomain` above already reads `slug` off.
  //
  // ONLY WHEN THE SCOPE ITSELF APPLIED. A project belongs to a domain, so a
  // handoff whose domain did NOT take (it named a domain this machine does
  // not have) must not pin its project onto whatever domain we fell back to
  // — that would pin a name from one domain into another, where the route
  // would refuse it on the next question.
  //
  // It is written to the SAME per-device store the pill writes, so the
  // handoff seeds the pin and the pin behaves exactly as a hand-picked one
  // from then on: no second lifetime, no second source of truth. It is still
  // RECONCILED inside loadProjectsForDomain — a project that does not exist
  // clears itself rather than being sent.
  const handedProject = (scopeReq && typeof scopeReq.project === 'string' && scopeReq.project.trim())
    ? scopeReq.project.trim() : null;
  if (handedProject && decision.appliedScopeSlug) {
    writePinnedProject(state.activeDomain, handedProject);
    // `scope` rides only when `project` does, and it is NOT persisted — see
    // `state.activeProjectScope`. Absent, empty or the wrong type all mean
    // "whichever work-stream is newest", which is what the store answers for
    // a missing scope anyway, so the degraded case needs no special arm.
    state.activeProjectScope = (typeof scopeReq.scope === 'string' && scopeReq.scope.trim())
      ? scopeReq.scope.trim() : null;
  }

  // NOT awaited, and not part of the boot gate: the pill is a retrieval
  // WIDENING, so the thread must never wait on it. `patchProjectPicker`
  // repaints the pill alone when the answer lands, and every failure —
  // including this promise rejecting — leaves the pill in a stated state
  // rather than the view in a broken one.
  loadProjectsForDomain(state.activeDomain, token).catch(() => {});
}

// The `has<Provider>Key` flags this view reads, in the order providers should
// appear in the composer menu. Explicit rather than derived from the payload's
// key names, because these gate what a user can SPEND on: a provider reaches
// the picker only by being named here, so a backend that grew a new flag
// cannot make a provider pickable in chat without this file agreeing.
//
// Both halves are stated once. `hasOpenrouterKey` has a LOWERCASE r — the
// route derives it mechanically from the provider id, so it is not
// `hasOpenRouterKey`; reading the wrong name is silently falsy and the
// provider simply never appears, which is easy to miss and tedious to find.
const PROVIDER_KEY_FLAGS = Object.freeze([
  ['gemini', 'hasGeminiKey'],
  ['anthropic', 'hasAnthropicKey'],
  ['openrouter', 'hasOpenrouterKey'],
]);

/**
 * Which keyed providers can serve a chat turn with NO MODEL NAMED?
 *
 * DERIVED FROM THE WIRE, NEVER FROM A HARDCODED ID LIST. `models[p]` is the
 * backend's own `getDefaultModel(p)`, so this asks the engine the exact question
 * whose answer decides whether the request can be built at all — and a fourth
 * provider becomes offerable here the moment it genuinely resolves a model, with
 * no edit to this file.
 *
 * It is the client mirror of `normalizeChatProvider`'s model-less arm in
 * src/brain/chat.js. The two are independent by necessity (one reads the wire,
 * one reads config) and both fail in the SAME safe direction — refuse, and let
 * the global active provider answer — so a drift between them can only ever
 * under-offer, never let an unusable provider through.
 *
 * `Object.hasOwn` rather than a bare index: `models['__proto__']` returns
 * Object.prototype, which is truthy, and would admit a provider that does not
 * exist. `providers` is already built from this file's own frozen
 * PROVIDER_KEY_FLAGS, so that is defence in depth rather than the only guard.
 */
function providersWithDefaultModel(providers, models) {
  const list = Array.isArray(providers) ? providers : [];
  const map = models && typeof models === 'object' ? models : {};
  return list.filter(p => {
    if (!Object.hasOwn(map, p)) return false;
    const id = map[p];
    return typeof id === 'string' && id.length > 0;
  });
}

function applyApiKeys(data) {
  const providers = [];
  for (const [id, flag] of PROVIDER_KEY_FLAGS) {
    if (data[flag]) providers.push(id);
  }
  state.availableProviders = providers;
  state.models = data.models || {};
  state.activeProvider = data.activeProvider || null;
  // Read from `build` first and `buildModel` second — a payload can carry one
  // and not the other, and a notice that only worked on the newer shape would
  // be silent on exactly the installs most likely to be running a retired
  // model. `=== true` / `=== false`, never truthiness: the third value is
  // UNKNOWN and must render nothing, because sending a user to change a working
  // model on the strength of a request we could not make is the worse error.
  {
    const b = (data && data.build && typeof data.build === 'object') ? data.build
      : ((data && data.buildModel && typeof data.buildModel === 'object') ? data.buildModel : null);
    state.buildModelId = (b && typeof b.model === 'string') ? b.model : '';
    state.buildProvider = (b && typeof b.provider === 'string' && b.provider) ? b.provider : null;
    state.buildLiveMissing = (b && b.liveMissing === true) ? true
      : ((b && b.liveMissing === false) ? false : null);
  }
  state.providerOnlyProviders = providersWithDefaultModel(providers, state.models);

  let savedProvider = null;
  try { savedProvider = localStorage.getItem(LS_PROVIDER); } catch { /* ignore */ }
  // Gated on providerOnlyProviders, NOT on `providers`. A stored id is a
  // MODEL-LESS selection — nothing else in this restore names a model — so it
  // may only resolve to a provider that can serve one. Restoring it off the
  // key list alone was the reachable half of the OpenRouter defect: no UI
  // interaction was needed, `state.modelProvider` came back as 'openrouter' on
  // load, and every POST carried a provider the backend threw away. A model
  // restored below re-sets this to its own provider, which is the model-mode
  // path and is unaffected.
  state.modelProvider = state.providerOnlyProviders.includes(savedProvider) ? savedProvider : null;

  let savedStyle = null;
  try { savedStyle = localStorage.getItem(LS_STYLE); } catch { /* ignore */ }
  state.responseStyle = STYLE_ORDER.includes(savedStyle) ? savedStyle : 'balanced';

  // Re-scoped client-side against the SAME `providers` list built above from
  // hasGeminiKey/hasAnthropicKey — config-only, never .env (v3.0.13).
  state.offerable = normalizeOfferable(data.offerable, providers);
  {
    const orc = data && data.openrouterCatalogue && typeof data.openrouterCatalogue === 'object'
      ? data.openrouterCatalogue : null;
    state.orCatalogueSyncedAt = orc && typeof orc.syncedAt === 'string' && orc.syncedAt ? orc.syncedAt : null;
  }

  // ── THE WORKING SET'S STORED LISTS ──────────────────────────────────────
  // Restored here rather than at module load, so a Settings Disconnect that
  // re-runs this pass re-reads them too. Deliberately NOT filtered against the
  // live catalogue at read time: an id whose provider was Disconnected simply
  // matches nothing in `buildWorkingSet`'s membership test and contributes no
  // row, and PRUNING it here would silently forget a star the moment a key was
  // temporarily removed — the list survives, the row does not.
  let rawRecents = null, rawStarred = null;
  try { rawRecents = localStorage.getItem(LS_MODEL_RECENTS); } catch { /* ignore */ }
  try { rawStarred = localStorage.getItem(LS_MODEL_STARRED); } catch { /* ignore */ }
  state.modelRecents = parseIdList(rawRecents, MAX_RECENTS);
  state.modelStarred = parseIdList(rawStarred, MAX_STARRED);

  // While the picker is gated off the model stays pinned null, so nothing
  // downstream (the label, the request body) can name a model the backend
  // would silently ignore.
  if (!MODEL_PICKER_ENABLED) { state.chatModel = null; return; }

  let savedModel = null;
  try { savedModel = localStorage.getItem(LS_MODEL); } catch { /* ignore */ }
  const restored = resolveChatModel(savedModel, state.offerable, providers);
  state.chatModel = restored ? restored.entry.id : null;
  // A restored model implies its provider — otherwise a saved Anthropic model
  // would be sent alongside a Gemini provider and the two would disagree.
  if (restored) state.modelProvider = restored.provider;
}

// How many rows one list answer asks for. GET /api/chat clamps to 500; the
// server's `total` is the true count, and the pane says "Showing the newest N
// of M" whenever it is larger (views/chat-list.js truncationHintHtml).
const LIST_LIMIT = 500;

/**
 * The URL for the list, from the list's two inputs: the domain filter and the
 * search text. PURE, so the suite asserts both routes without a network.
 *
 * All domains → GET /api/chat (every non-mirror domain, `total`, `unreadable`).
 * One domain  → GET /api/chat/:domain, the route that has always listed one
 *               domain's conversations in full (no page cap).
 */
function conversationListUrl(domainFilter, q) {
  const query = typeof q === 'string' ? q.trim() : '';
  if (typeof domainFilter === 'string' && domainFilter) {
    return '/api/chat/' + encodeURIComponent(domainFilter) + (query ? '?q=' + encodeURIComponent(query) : '');
  }
  return '/api/chat?limit=' + LIST_LIMIT + (query ? '&q=' + encodeURIComponent(query) : '');
}

// `mountToken` here is ALWAYS a value captured by the caller before its own
// first await (see the H1 doc comment above `myMountToken`) — never the
// live module variable re-read late. `convToken` is the pre-existing,
// unrelated SAME-mount guard (two quick list loads racing each other);
// both are needed and check different things.
//
// `opts.q` — the search string to ask the SERVER to filter by. Callers that
// refresh the list for some other reason (a send, a delete) pass
// state.searchQuery so a refresh cannot silently drop an active filter while
// the search box still shows its text.
//
// `opts.sidebarOnly` — repaint only the conversation pane and leave the open
// thread exactly as it is. A user typing in the filter has not asked to close
// the conversation they are reading.
//
// `opts.autoSelectMostRecent` — the COLD BOOT only: open the newest
// conversation IN THE ACTIVE DOMAIN (the domain boot resolved from a handoff
// or the saved choice), never a newer one elsewhere — a handoff that said
// "ask Articles" must land in Articles.
async function loadConversationList(mountToken, opts = {}) {
  const convToken = ++state.convToken;
  const url = conversationListUrl(state.domainFilter, opts.q);
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (convToken !== state.convToken) return; // a newer list load superseded this
    if (!isCurrentMount(mountToken)) return; // H1 fix — this mount may already be gone
    if (!res.ok) throw new Error(data.error || 'Could not load conversations.');
    state.conversations = Array.isArray(data.conversations) ? data.conversations : [];
    state.listTotal = Number.isInteger(data.total) ? data.total : state.conversations.length;
    state.listUnreadable = Array.isArray(data.unreadable) ? data.unreadable : [];
    state.loadError = null;
  } catch (err) {
    if (convToken !== state.convToken) return;
    if (!isCurrentMount(mountToken)) return;
    state.conversations = [];
    state.listTotal = 0;
    state.listUnreadable = [];
    state.loadError = 'Could not load conversations (' + err.message + ').';
  }

  pruneSelection();

  if (opts.sidebarOnly) {
    renderSidebarConversationsOnly(mountToken);
    return;
  }

  const first = opts.autoSelectMostRecent
    ? state.conversations.find((c) => (c.domain || state.activeDomain) === state.activeDomain)
    : null;
  if (first) {
    await selectConversation(first.id, mountToken, { skipSidebarRender: true, domain: state.activeDomain });
  } else {
    state.activeConversationId = null;
    state.thread = [];
  }
  renderShell(mountToken);
}

// See the invariant on state.selectedConvKeys. A prune rather than a clear:
// a search that still shows a ticked row keeps it ticked.
function pruneSelection() {
  if (state.selectedConvKeys.size === 0) return;
  const live = new Set(state.conversations.map(c => convKey(c.domain || state.activeDomain, c.id)));
  for (const k of [...state.selectedConvKeys]) {
    if (!live.has(k)) state.selectedConvKeys.delete(k);
  }
}

// Debounce for the server-side search. The route does a full-scan read of
// every conversation file, so the debounce is here to spare requests.
const SEARCH_DEBOUNCE_MS = 220;

// How many words make a filter string read as a sentence rather than a needle.
// See looksLikeAnAsk() for why this is a word count and not a question-word
// list, and why 4 rather than 3.
const FILTER_ASK_MIN_WORDS = 4;

function cancelSearchTimer() {
  if (state.searchTimer) { clearTimeout(state.searchTimer); state.searchTimer = null; }
}

function scheduleConversationSearch(mountToken) {
  cancelSearchTimer();
  state.bulkNotice = null; // a stale "Deleted 2 conversations." must not hang over a new search
  state.searchTimer = setTimeout(() => {
    state.searchTimer = null;
    if (!isCurrentMount(mountToken)) return;
    loadConversationList(mountToken, {
      q: state.searchQuery,
      sidebarOnly: true,
    }).catch(reportAsyncActionFailure);
  }, SEARCH_DEBOUNCE_MS);
}

/**
 * Make `slug` the active domain WITHOUT opening or closing anything. The one
 * place the domain changes, used by opening a row from another domain and by
 * the composer's domain picker. Projects belong to a DOMAIN, so the old
 * domain's rows, pin and last reading are about something just left; the new
 * domain's pin is restored inside loadProjectsForDomain from the per-domain
 * map.
 */
function adoptActiveDomain(slug, token) {
  if (!slug || slug === state.activeDomain) return false;
  state.activeDomain = slug;
  try { localStorage.setItem(LS_DOMAIN, slug); } catch { /* ignore */ }
  state.projectRows = [];
  state.projectsFor = null;
  state.projectsState = 'idle';
  state.projectsFetchedAt = 0;
  state.activeProject = null;
  state.activeProjectScope = null;
  state.activeProjectFrom = 'pin';
  state.projectLastUsed = null;
  state.projectKnowledge = null;
  loadProjectsForDomain(slug, token).catch(() => {});
  return true;
}

/**
 * THE PROJECT A CONVERSATION LAST USED (v3.76.0, truth audit F13), from its
 * own messages: the newest assistant turn that RECORDED one (`project`, a
 * name or null — v3.72.0's field). Returns `{ recorded: false }` for a
 * conversation written before the field existed — nothing is guessed for it.
 * Pure; exported for scripts/test-chat-project-restore.js.
 */
export function conversationProject(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'assistant' || !Object.hasOwn(m, 'project')) continue;
    const p = m.project;
    if (p === null) return { recorded: true, project: null };
    if (typeof p === 'string' && p && p.length <= 64) return { recorded: true, project: p };
  }
  return { recorded: false, project: null };
}

/**
 * REOPENING A CONVERSATION RESTORES ITS PROJECT (v3.76.0, F13 — the
 * maintainer's decision). The pill showed the per-domain, per-browser pin, so
 * a thread asked about `curator` reopened reading "No project" and its next
 * question went out without the project it had been about. Now the pill
 * shows what that conversation last used; the user can still change it (that
 * pick is a preference and goes to the pin, as before). NOT written to the
 * pin — the pin's reason for being per-device (see LS_PROJECT) is unchanged
 * — and a conversation with no recorded project leaves today's behaviour
 * alone. A project that no longer exists is not restored.
 */
function applyConversationProject(domain, messages, token) {
  if (domain !== state.activeDomain) return;
  const got = conversationProject(messages);
  // Nothing recorded (an older conversation): today's behaviour, the pin —
  // including after a previous thread had restored a project of its own.
  if (!got.recorded) { restorePinnedProject(token); return; }
  const rowsReady = state.projectsFor === domain && state.projectsState === 'ready';
  const want = got.project && (!rowsReady || state.projectRows.some((r) => r.project === got.project))
    ? got.project : null;
  state.activeProjectFrom = 'conversation';
  if (want === state.activeProject) return;
  state.activeProject = want;
  state.activeProjectScope = null;
  state.projectLastUsed = null;
  state.projectKnowledge = null;
  patchProjectPicker(token);
  if (want) ensureProjectKnowledge(domain, want, token).catch(() => {});
}

/** Back to the per-domain pin — a NEW chat keeps today's behaviour (F13). */
function restorePinnedProject(token) {
  if (state.activeProjectFrom !== 'conversation') return;
  state.activeProjectFrom = 'pin';
  const domain = state.activeDomain;
  const pin = domain ? readPinnedProjects()[domain] || null : null;
  const rowsReady = state.projectsFor === domain && state.projectsState === 'ready';
  const want = pin && (!rowsReady || state.projectRows.some((r) => r.project === pin)) ? pin : null;
  if (want === state.activeProject) return;
  state.activeProject = want;
  state.activeProjectScope = null;
  state.projectLastUsed = null;
  state.projectKnowledge = null;
  patchProjectPicker(token);
  if (want) ensureProjectKnowledge(domain, want, token).catch(() => {});
}

/**
 * Open one conversation. `opts.domain` is the conversation's own domain (a
 * row's `domain`, from its storage path); opening a row from another domain
 * makes that domain active first — the conversation's container, which the
 * composer then shows fixed (M2).
 */
async function selectConversation(id, mountToken, opts = {}) {
  // H1 fix: guards against an out-of-order resolution WITHIN the same mount.
  const selectToken = ++state.selectToken;
  // The notice describes a turn in the thread being navigated AWAY from.
  state.cancelNotice = null;
  const domain = typeof opts.domain === 'string' && opts.domain ? opts.domain : state.activeDomain;
  adoptActiveDomain(domain, mountToken);
  state.activeConversationId = id;
  try {
    const res = await fetch('/api/chat/' + encodeURIComponent(domain) + '/' + encodeURIComponent(id));
    const data = await res.json();
    if (selectToken !== state.selectToken) return;
    if (!isCurrentMount(mountToken)) return;
    if (!res.ok) throw new Error(data.error || 'Could not load this conversation.');
    state.thread = Array.isArray(data.messages) ? data.messages : [];
    applyConversationProject(domain, state.thread, mountToken);
  } catch (err) {
    if (selectToken !== state.selectToken) return;
    if (!isCurrentMount(mountToken)) return;
    state.thread = [{ role: 'assistant', content: '', error: 'Could not load this conversation (' + err.message + ').' }];
  }
  // ── THE RE-ATTACH POINT (v3.64.1) ───────────────────────────────────────
  // THE one place a conversation becomes the conversation on screen — every
  // path that opens a thread funnels through here. SYNCHRONOUS with the
  // assignment above and the render below: no `await` between them, so a
  // turn cannot resolve in the gap and have its answer overwritten.
  adoptLiveTurn(mountToken);
  if (!opts.skipSidebarRender) renderShell(mountToken);
}

// ── Actions ───────────────────────────────────────────────────────────────

/**
 * The composer's domain picker. A conversation lives in ONE domain (its file
 * is in that domain's folder), so choosing another domain can never re-scope
 * the open thread: it starts a NEW chat there (M2 — "domain fixed once a
 * conversation exists"). With no conversation open it simply moves the empty
 * new chat. The list is not touched: it spans every domain already.
 *
 * Entered synchronously by a picker's onChange — reading myMountToken here is
 * safe: nothing can have re-mounted between the event and this line.
 */
function switchDomain(slug) {
  if (slug === state.activeDomain) return;
  if (!state.domains.some((d) => d.slug === slug)) return;
  state.activeConversationId = null;
  state.thread = [];
  state.cancelNotice = null;     // belonged to the thread being left behind
  adoptActiveDomain(slug, myMountToken);
  renderShell(myMountToken);
  focusComposer();
}

function startNewChat() {
  state.activeConversationId = null;
  state.thread = [];
  state.cancelNotice = null;   // belonged to the thread being left behind
  restorePinnedProject(myMountToken);
  renderShell(myMountToken);
  focusComposer();
}

// `mountToken` is passed in by the caller (captured synchronously at click
// time) rather than read fresh here: the in-design confirm awaits from its
// first statement and the user can sit on it indefinitely, during which a
// rail click can tear this mount down. The destructive work lives INSIDE
// confirmThen's `onConfirm`, reached only from the dialog's own confirm
// button — there is no decision boolean to be mis-tested (shared/confirm.js).
//
// `domain` is the ROW's domain: in an all-domains list the row being deleted
// is very often not in the active domain.
async function deleteConversationRow(id, title, domain, mountToken) {
  const dom = typeof domain === 'string' && domain ? domain : state.activeDomain;
  await confirmThen({
    title: 'Delete this conversation?',
    message: title || 'this conversation',
    detail: 'The thread and its messages are removed from ' + domainLabel(dom) + '. This cannot be undone.',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    tone: 'danger',
    destructive: true,
    onConfirm: async () => {
      try {
        await fetch('/api/chat/' + encodeURIComponent(dom) + '/' + encodeURIComponent(id), { method: 'DELETE' });
      } catch { /* best-effort; the list refresh below will show the true state either way */ }
      if (!isCurrentMount(mountToken)) return; // H1 fix
      state.selectedConvKeys.delete(convKey(dom, id));
      if (state.activeConversationId === id && state.activeDomain === dom) {
        state.activeConversationId = null;
        state.thread = [];
        await loadConversationList(mountToken, { autoSelectMostRecent: false, q: state.searchQuery });
        return;
      }
      await loadConversationList(mountToken, { sidebarOnly: true, q: state.searchQuery });
    },
  });
}

/** A domain's display name, or its slug. */
function domainLabel(slug) {
  const d = state.domains.find((x) => x.slug === slug);
  return (d && (d.displayName || d.slug)) || String(slug || 'this domain');
}

// The number of messages ONE completed turn adds to a conversation file: the
// user message and the assistant message. MUST agree with what
// src/brain/chat.js's sendMessage pushes — scripts/test-next-chat-sidebar.js
// §8 holds the two together.
const MESSAGES_PER_TURN = 2;

/**
 * Apply one PERSISTED turn to its row: the count advances by one turn, the
 * row's last use and last project become the ones the server just wrote, and
 * the row moves to the top (the server sorts by `updatedAt ?? createdAt`, and
 * this is that order applied locally rather than a refetch per turn).
 *
 * Gated on a conversation id: an empty-wiki reply answers with prose, writes
 * NOTHING, and reports `conversationId: null`. A row that is not in the list
 * (an active search filtered it out) is left alone rather than invented.
 *
 * `data` is the turn's response ({updatedAt?, project?}); both are optional
 * and applied only when they have the shape the server writes, so a server
 * from before v3.72 changes the count and nothing else.
 */
function bumpMessageCountForTurn(conversationId, domain, data) {
  if (!conversationId) return;
  const dom = domain || state.activeDomain;
  const i = state.conversations.findIndex(c => c.id === conversationId && (c.domain || state.activeDomain) === dom);
  if (i < 0) return;
  const row = state.conversations[i];
  if (typeof row.messageCount === 'number') row.messageCount += MESSAGES_PER_TURN;
  const d = data && typeof data === 'object' ? data : {};
  if (typeof d.updatedAt === 'string' && Number.isFinite(Date.parse(d.updatedAt))) {
    row.updatedAt = d.updatedAt;
    state.conversations.splice(i, 1);
    state.conversations.unshift(row);
  }
  if (Object.hasOwn(d, 'project') && (d.project === null || (typeof d.project === 'string' && d.project.length <= 64))) {
    row.lastProject = d.project;
  }
}

/**
 * Delete every ticked conversation (Select mode).
 *
 * No new endpoint: DELETE /api/chat/:domain/:id already exists and each
 * conversation is one file, so this is N calls to the route the single-row
 * delete has always used. Each call names the ROW's own domain.
 *
 * The key list is FROZEN at click time, intersected with the list on screen,
 * so a row that has since disappeared cannot be swept up. Requests are
 * sequential, so the outcome can say which ones failed.
 *
 * PARTIAL FAILURE IS REPORTED, NEVER ASSUMED AWAY: the honest signal is
 * `res.ok`; every non-ok or thrown call is counted and named, and survivors
 * stay ticked so a retry is one click.
 */
async function deleteSelectedConversations(mountToken) {
  const rows = state.conversations.filter(c => state.selectedConvKeys.has(convKey(c.domain || state.activeDomain, c.id)));
  if (rows.length === 0) return;
  const n = rows.length;
  const only = n === 1 ? rows[0] : null;
  const domainsHit = [...new Set(rows.map(c => c.domain || state.activeDomain))];

  await confirmThen({
    title: 'Delete ' + n + ' conversation' + (n === 1 ? '' : 's') + '?',
    message: only ? (only.title || 'Untitled')
      : n + ' selected conversations in ' + domainsHit.map(domainLabel).join(', '),
    detail: 'Their threads and messages are removed. This cannot be undone.',
    confirmLabel: 'Delete ' + n,
    cancelLabel: 'Cancel',
    tone: 'danger',
    destructive: true,
    onConfirm: async () => {
      const failed = [];
      let deleted = 0;
      for (const c of rows) {
        const dom = c.domain || state.activeDomain;
        const key = convKey(dom, c.id);
        try {
          const res = await fetch('/api/chat/' + encodeURIComponent(dom) + '/' + encodeURIComponent(c.id), { method: 'DELETE' });
          if (res.ok) { deleted++; state.selectedConvKeys.delete(key); }
          else failed.push(key);
        } catch { failed.push(key); }
      }
      if (!isCurrentMount(mountToken)) return;

      let closedActiveThread = false;
      const activeKey = state.activeConversationId ? convKey(state.activeDomain, state.activeConversationId) : null;
      if (activeKey && rows.some(c => convKey(c.domain || state.activeDomain, c.id) === activeKey) && !failed.includes(activeKey)) {
        state.activeConversationId = null;
        state.thread = [];
        closedActiveThread = true;
      }
      state.bulkNotice = failed.length === 0
        ? { text: 'Deleted ' + deleted + ' conversation' + (deleted === 1 ? '' : 's') + '.', tone: 'ok' }
        : { text: 'Deleted ' + deleted + ' of ' + n + '. ' + failed.length + ' could not be deleted and stayed selected — try again.', tone: 'error' };
      // A clean run leaves Select mode; a partial one stays in it, with the
      // survivors ticked, so the retry is the next press.
      if (failed.length === 0) state.selectMode = false;
      await loadConversationList(mountToken, { sidebarOnly: true, q: state.searchQuery });
      if (closedActiveThread && isCurrentMount(mountToken)) renderShell(mountToken);
    },
  });
}

async function sendCurrentMessage() {
  const ta = document.getElementById('chat-input');
  if (!ta || state.sending) return;
  const text = ta.value.trim();
  if (!text || !state.activeDomain) return;

  // H1 fix: this function is only ever entered directly from a click/
  // keydown handler (see wireComposer), so myMountToken is guaranteed
  // fresh here — capture it, plus the domain+conversation this send
  // belongs to. Previously there was NO mount guard at all: a send that
  // resolved after the user left Chat and came back (a fresh mount, its
  // own boot() run — possibly now showing a different conversation)
  // unconditionally overwrote state.activeConversationId/state.thread and
  // forced a renderShell(), hijacking whatever the user was now looking
  // at. The domain/conversation capture additionally covers the SAME-mount
  // case — switching domains or starting a new chat while a send for the
  // old context is still in flight.
  const mountToken = myMountToken;
  const domainAtSend = state.activeDomain;
  const conversationIdAtSend = state.activeConversationId;
  // Captured for the same reason as the three above: the composer is live
  // during the 15-45s call, so by the time the answer lands `state.chatModel`
  // may already be something else. This is the ONLY record of what THIS turn
  // asked for, and it is half of the divergence comparison.
  const requestedModelAtSend = state.chatModel;
  // Captured for the same reason as the three above, and for one more: the
  // pill can be changed while the turn is in flight, and the reading this
  // turn reports back ("12k characters read") belongs to the project that was pinned
  // when it was SENT. Applying it to whatever is pinned when it lands would
  // be a measurement about the wrong project.
  const projectAtSend = state.activeProject;
  const scopeAtSend = state.activeProjectScope;

  // A new turn supersedes the last Stop — the notice described the turn the
  // user has just replaced, and leaving it under a live thinking bubble would
  // read as "stopped" and "thinking" at once.
  state.cancelNotice = null;

  // The abort handle for THIS turn. Captured into the module-level record with
  // the same identity fields the render guards use, so `cancelCurrentSend` can
  // reach it from the button and — critically — so nothing else can. See the
  // record's declaration for why the teardown must never touch it.
  const controller = new AbortController();

  // THE STREAM BUFFERS FOR THIS TURN. Held in a local as well as the module
  // slot so this turn can only ever clear ITS OWN record (same discipline, and
  // the same reason, as `sendAbort` above), and so an abandoned turn keeps
  // writing into a detached object that nothing paints from.
  const streamRec = { sse: false, seen: false, reasoning: '', content: '', reasoningView: 'tail' };
  sendStream = streamRec;

  // The record carries `stream` and `startedAt` as well as the four identity
  // fields (v3.64.1) — they are what `adoptLiveTurn` needs to put a turn back
  // on screen after a re-mount, and holding them HERE rather than in a second
  // parallel object is the same one-record argument `sendIsOnScreen` makes.
  sendAbort = {
    controller, mountToken, domain: domainAtSend, conversationId: conversationIdAtSend, text,
    stream: streamRec, startedAt: Date.now(),
  };

  // WHICH MOUNT MAY THIS TURN PAINT INTO RIGHT NOW. `mountToken` is where it
  // started; `sendAbort.mountToken` is where it lives now, and the two differ
  // exactly when a later mount adopted it (see adoptLiveTurn). Identity-checked
  // on the controller so a turn can only ever read its OWN record — after the
  // `finally` has cleared it, or if some future code path replaced it, this
  // falls back to the captured local and behaves exactly as it did before.
  const here = () => (sendAbort && sendAbort.controller === controller) ? sendAbort.mountToken : mountToken;

  // THE SIDEBAR'S "answering" MARK. Kept in `state` and not read off
  // `sendAbort`, deliberately: `conversationRowHtml` is lifted and executed by
  // a suite this package does not own, whose sandbox declares `state` and not
  // the module's turn record — a reference to `sendAbort` in that function
  // would be an unresolved binding there. An absent field is simply not a
  // match, so every existing fixture renders exactly what it rendered before.
  state.answeringConvId = conversationIdAtSend;
  state.answeringDomain = domainAtSend;

  state.sending = true;
  // Started BEFORE the first render, so the bubble's very first paint already
  // carries "0s" rather than blank-then-jump.
  startSendClock(mountToken);
  state.thread.push({ role: 'user', content: text });
  ta.value = '';
  autosize(ta);
  // THE ONE RENDER THAT FORCES A SCROLL. Every other paint follows the reader
  // (see isThreadAtBottom): text arriving on its own must never drag someone
  // out of the history they are reading. Pressing Send is the opposite — a
  // deliberate act whose result the user is waiting to see — so this render
  // says so explicitly rather than relying on where the scrollbar happened to
  // be.
  renderThreadOnly(mountToken, { stick: true });
  renderComposerBusy(true, mountToken);
  // The list learns about the turn at the same instant the thread does. Rows
  // only — see the `finally`'s own note for why this is not a renderShell.
  renderSidebarConversationsOnly(mountToken);

  try {
    const res = await fetch('/api/chat/' + encodeURIComponent(domainAtSend), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        conversationId: conversationIdAtSend,
        responseStyle: state.responseStyle,
        provider: state.modelProvider,
        // ONLY ever present once the backend honours it — while
        // MODEL_PICKER_ENABLED is false, state.chatModel is pinned null in
        // applyApiKeys, so this spreads to nothing and the body is
        // byte-identical to v3.0.11's. Sending an id the server drops would
        // make the picker's price quote a falsehood; see MODEL_PICKER_ENABLED.
        ...(state.chatModel ? { model: state.chatModel } : {}),
        // ASK for a stream. A route that does not know the field ignores it and
        // answers with JSON exactly as before, which is what makes the branch
        // below a real fallback rather than a version check.
        stream: true,
        // THE PINNED PROJECT, spread rather than sent as a null. With no pin
        // the body is byte-identical to v3.63.0's, which is what keeps the
        // wiki-only turn on exactly the path it was on before — the same
        // discipline `model` two lines up already follows. `scope` rides only
        // when a project does: a work-stream with no project to belong to is
        // a field the route would have to decide what to do with.
        ...(projectAtSend ? { project: projectAtSend } : {}),
        // Only ever beside a project, and only when one was named: a
        // work-stream with no project to belong to is a field the route
        // would have to decide what to do with, and an absent scope already
        // means "the newest" at the store.
        ...(projectAtSend && scopeAtSend ? { scope: scopeAtSend } : {}),
      }),
    });

    // ── STREAM, OR THE ORIGINAL JSON PATH — DECIDED BY THE RESPONSE ────────
    // Not by what we asked for. `res.ok` is in the conjunction so a 4xx/5xx
    // (which is always JSON) takes the error path below with its message
    // intact, and the `getReader` check means an environment with no streaming
    // body degrades rather than throwing.
    const ctype = (res.headers && typeof res.headers.get === 'function')
      ? String(res.headers.get('content-type') || '') : '';
    const isEventStream = !!res.ok && /text\/event-stream/i.test(ctype) &&
      !!res.body && typeof res.body.getReader === 'function';

    // `data` is the SAME shape on both paths — the streaming route's `done`
    // frame carries the full result — so everything below this point is
    // untouched by streaming, and a bug fixed in one path cannot be missing
    // from the other because there is only one path from here.
    const data = isEventStream
      ? await consumeChatStream(res.body, streamRec, here)
      : await res.json();
    // Left byte-identical, including the unguarded `data.error`: on the JSON
    // path a null body must still fail exactly the way it did before.
    if (!res.ok) throw new Error(data.error || 'The request failed.');

    // Must flip BEFORE the relevance check below, regardless of outcome —
    // state.sending is this function's own send-lock and must never be
    // left stuck `true` (silently blocking every future send) just because
    // the view/context moved on while this request was in flight.
    state.sending = false;

    const stillRelevant = isCurrentMount(here()) &&
      state.activeDomain === domainAtSend &&
      state.activeConversationId === conversationIdAtSend;
    if (!stillRelevant) return; // this reply no longer belongs anywhere on screen

    const wasNew = !!data.isNew && !!data.conversationId;
    if (data.conversationId) state.activeConversationId = data.conversationId;
    // What the project context actually contributed to THIS turn, straight
    // off the server's own measurement. Recorded only when the pill still
    // shows the project the turn was SENT with, so a figure can never be
    // attached to a project it is not about. `null` on every other path,
    // including a turn sent with no project — a stale reading beside a fresh
    // pill is worse than no reading at all.
    state.projectLastUsed =
      (projectAtSend && state.activeProject === projectAtSend
        && data.projectContext && typeof data.projectContext === 'object')
        ? data.projectContext : null;
    // RE-PUBLISHED, never re-rendered. The ordinary-turn branch below
    // deliberately does NOT repaint the main view (it patches the sidebar's
    // one integer and the thread), and repainting the scope bar here to move
    // one figure would rebuild the project picker — and close a menu the
    // user may have open — for a number.
    //
    // Since v3.65.0 the figure lives in the picker's FOOTER, which is part of
    // a menu that exists only while the menu is open. `patchProjectFooter`
    // therefore writes `cfg.footHtml` first (what the next build reads) and
    // touches the DOM only if there is a live footer to touch — the guard
    // without which the figure would silently stop updating the moment the
    // picker was closed, which is every moment but one.
    patchProjectFooter();
    state.thread.push({
      role: 'assistant',
      // ══ REPLACE. NEVER APPEND. ═════════════════════════════════════════
      // `data.answer` is the complete, authoritative answer on BOTH paths.
      // The content deltas the user watched arrive were a preview of this
      // string, not a part of it, and `streamRec.content` is deliberately not
      // referenced here or anywhere after this point. Appending it would
      // double every streamed answer, and — worse — the truncation note
      // src/brain/llm.js appends to a cut-off reply exists ONLY in this field
      // and never as a delta, so a buffer-first reader would lose the one
      // sentence explaining why the answer stops mid-thought.
      //
      // No fallback to the buffer when `answer` is absent, deliberately: the
      // JSON path has always rendered an empty bubble in that case, and giving
      // the streaming path its own recovery is how two paths start behaving
      // differently for the same server bug.
      content: data.answer,
      citations: data.citations || [],
      // `{path: title}` for the chips under this answer. Arrives on the JSON
      // body and, identically, on the SSE `done` frame — src/routes/chat.js
      // spreads the WHOLE sendMessage result into that frame un-enumerated, so
      // there is nothing to add on the streaming side and no second place for
      // this field to be forgotten. It is the SAME object the server just
      // persisted onto the message, which is what makes the live thread and a
      // reloaded thread label the same chip the same way. Null when the server
      // resolved no titles; the renderer humanises the slug in that case.
      citationTitles: (data.citationTitles && typeof data.citationTitles === 'object') ? data.citationTitles : null,
      // v3.76.0 (F9): the cited strings the server found to BE wiki pages.
      // The same array it persisted onto the message, so a live answer and a
      // reopened one count the same pages. Absent from an older server.
      ...(Array.isArray(data.citedPages) ? { citedPages: data.citedPages } : {}),
      // `data.model` is the model that ANSWERED, measured by the server from
      // the provider's own usage payload (src/brain/chat.js `usedModel`) —
      // not an echo of what we asked for. A missing/blank value stays null:
      // the renderer shows the neutral provider name rather than guessing.
      model: typeof data.model === 'string' && data.model ? data.model : null,
      requestedModel: requestedModelAtSend || null,
      // The provider's own token counts for THIS turn. Carried verbatim and
      // re-validated at render time by `messageUsageTokens` — the shape is
      // checked once here only to the extent of "is it an object", because the
      // renderer must apply the same rule to a message replayed from disk as to
      // this one, and duplicating the field check in two places is how two
      // copies of a rule drift.
      //
      // This is the SAME object the server just persisted into the conversation
      // JSON, which is what makes the live thread and a reloaded thread show the
      // same figure for the same message. If it were derived only here, the cost
      // would disappear on reload.
      usage: data.usage && typeof data.usage === 'object' ? data.usage : null,
      // v3.72.0 (P1): what the server just PERSISTED on this message — the
      // pinned project's name (null = none this turn) and what the answer
      // cost at answer time. Carried so the live thread and a reloaded one
      // say the same thing; the renderer re-validates both.
      project: (typeof data.project === 'string' || data.project === null) ? data.project : undefined,
      priced: data.priced && typeof data.priced === 'object' ? data.priced : null,
    });
    // The header's meta line counts questions and answers and names the
    // pinned project; patched in place, never by a repaint (see patchChatHead).
    patchChatHead();
    // F3: a save an agent made while this view was open is seen after the
    // next answer, not only on a domain switch. Quiet: the picker is patched
    // in place and an open menu is left open.
    refreshProjectsQuietly(domainAtSend, here()).catch(() => {});

    if (wasNew) {
      // Live-verified bug (found while testing an unrelated fix in this
      // same session): loadConversationList({autoSelectMostRecent:
      // false}) unconditionally does `state.activeConversationId = null;
      // state.thread = [];` when it isn't auto-selecting — correct for ITS
      // other callers (e.g. deleteConversationRow, which already wants a
      // blank thread), but here it threw away the very messages just
      // pushed onto state.thread a few lines up. Reproduced: send the
      // FIRST message of a brand new conversation — the sidebar correctly
      // showed the new row with "2 messages", but the main thread area
      // rendered the EMPTY "Ask ... anything" placeholder instead of the
      // answer that had just arrived; only navigating away and back (which
      // re-fetches the thread from the server via selectConversation) made
      // it reappear. Snapshot the thread we already built before the
      // sidebar-refreshing call, then restore it — we only wanted the
      // conversation LIST refreshed, never the content we already have.
      const threadSoFar = state.thread;
      await loadConversationList(here(), { autoSelectMostRecent: false, q: state.searchQuery });
      if (!isCurrentMount(here())) return;
      // loadConversationList doesn't know which conversation is "active"
      // beyond auto-select, so restore it explicitly and re-render.
      state.activeConversationId = data.conversationId;
      state.thread = threadSoFar;
      renderShell(here());
    } else {
      // THE FIX: this branch used to re-render the sidebar from the SAME
      // state.conversations array that was already on screen, so the row's
      // "N messages" label only ever moved after a navigation forced a
      // refetch — the one number in the sidebar that is supposed to track
      // what the user is doing right now was the last to know.
      //
      // Patched locally rather than by refetching the list, deliberately:
      // the wasNew branch above already pays for a refetch because a whole
      // new row has to appear, but an ordinary turn changes exactly one
      // integer in a list we already hold. Re-reading and re-parsing every
      // conversation file in the domain (that is what GET /api/chat/:domain
      // does — see listConversations) on every message, to learn a number we
      // can derive, would make the common case the expensive one. The one
      // thing a refetch would additionally buy is re-evaluating an ACTIVE
      // SEARCH against the message just sent — a conversation can newly
      // match a live query because of this turn. That is not worth a
      // full-list reparse per message, and it self-corrects on the next
      // keystroke or navigation; stated here rather than left as a surprise.
      bumpMessageCountForTurn(data.conversationId, domainAtSend, data);
      renderThreadOnly(here());
      renderSidebarConversationsOnly(here());
    }
  } catch (err) {
    state.sending = false;
    const stillRelevant = isCurrentMount(here()) &&
      state.activeDomain === domainAtSend &&
      state.activeConversationId === conversationIdAtSend;

    // ── A STOPPED TURN IS A NORMAL OUTCOME, NOT AN ERROR ─────────────────
    //
    // DETECTED FROM THE SIGNAL, NOT THE ERROR'S NAME. `controller.signal.aborted`
    // is the fact; `err.name === 'AbortError'` is a symptom that does not always
    // survive. v3.15.0 measured exactly this: an abort that lands during the
    // BODY read (fetch resolves on HEADERS, so `res.json()` is where a slow
    // turn's remaining time actually goes) was caught by a JSON handler and
    // translated into a different error, invisible to a name test — and the
    // consequence there was that a cancelled call got RETRIED. The name is kept
    // only as a second disjunct.
    if (controller.signal.aborted || (err && err.name === 'AbortError')) {
      // The optimistic user bubble is REMOVED, not annotated. `writeConversation`
      // runs only after the model returns, so an aborted turn persisted nothing:
      // leaving the bubble on screen would show a message that is not in the
      // conversation on disk and would vanish on the next reload. Removing it
      // also means a cancelled FIRST message leaves no conversation behind at
      // all — `wasNew` never ran, so no sidebar row was ever created and
      // `state.activeConversationId` was never set.
      //
      // Guarded by identity rather than by index: `stillRelevant` already proves
      // we are looking at the same thread, and popping only when the last entry
      // is the exact user message this turn sent means a race that somehow
      // appended something else can never eat an innocent message.
      if (stillRelevant) {
        const last = state.thread[state.thread.length - 1];
        if (last && last.role === 'user' && last.content === text) state.thread.pop();
        state.cancelNotice = { text: restoreDraft(text) };
        renderThreadOnly(here());
      }
      // NOT relevant: the abort still happened (that is what the user asked
      // for), but the notice and the draft belong to a thread that is no longer
      // on screen, and restoring text into the composer of a DIFFERENT
      // conversation would arm the wrong thread with someone else's message.
      // Same rule as the success path: stop the work, render nothing.
      return;
    }

    if (!stillRelevant) return;
    // `requestedModel` is the ONLY model fact a failed turn has: the request
    // never came back, so there is no served model to report. It is recorded
    // here so the failure note can say something true about the model the user
    // actually chose — captured at SEND time (see requestedModelAtSend), never
    // read from the composer at render time, because the dropdown is live during
    // a turn and re-deriving it there is the v3.13.2 relabelling bug.
    state.thread.push({
      role: 'assistant', content: '', error: err.message,
      requestedModel: requestedModelAtSend || null,
    });
    renderThreadOnly(here());
  } finally {
    // READ BEFORE THE RECORD IS CLEARED. `here()` falls back to the token this
    // turn was born on once its record is gone, and after an adoption that is
    // the WRONG mount — the composer would come back enabled on a view nobody
    // is looking at while the one on screen kept its Stop button. One read, one
    // value, used by every line below that needs a mount.
    const finalToken = here();
    // Identity-checked so a turn can only ever clear ITS OWN record. Nothing can
    // interleave here today (the cancel path above has no `await`), but a record
    // cleared by the wrong turn would leave a live turn unstoppable — a silent
    // failure with no symptom until someone needs the button.
    if (sendAbort && sendAbort.controller === controller) sendAbort = null;
    // Same identity rule, same reason: a turn may only clear the buffers it
    // owns. Clearing another turn's would blank a live streaming bubble.
    if (sendStream === streamRec) sendStream = null;
    // The sidebar's "answering" mark, under the same identity rule and for the
    // same reason. Cleared on EVERY exit — resolved, stopped, failed — because
    // a mark that outlives its turn tells the user a conversation is still
    // being answered when nothing is running.
    if (state.answeringConvId === conversationIdAtSend && state.answeringDomain === domainAtSend) {
      state.answeringConvId = null;
      state.answeringDomain = null;
    }
    state.sending = false;
    // EVERY exit path — resolved, thrown, or returned early as irrelevant —
    // passes through here, which is the only placement that cannot be skipped by
    // a future `return` added above it. See stopSendClock.
    stopSendClock();
    if (isCurrentMount(finalToken)) {
      renderComposerBusy(false, finalToken);
      // The list has to lose the mark as well, and this is the only exit every
      // outcome shares. `renderSidebarConversationsOnly` repaints the rows and
      // nothing else, so an open filter, the scroll position and the bulk
      // selection all survive it — the same reason the ordinary-turn branch
      // above uses it rather than renderShell.
      renderSidebarConversationsOnly(finalToken);
      focusComposer();
    }
  }
}

/**
 * Stop the turn in flight. THE ONLY CALLER IS THE STOP BUTTON.
 *
 * Does exactly one thing: aborts. Everything the user then sees — the bubble
 * coming down, the notice, the draft, the button reverting, the clock stopping —
 * is done by `sendCurrentMessage`'s own catch/finally, because that is the code
 * that owns the turn's state. Unwinding from here as well would give one
 * transition two owners, which is how the two halves come to disagree.
 *
 * Safe to call with nothing in flight, and safe to call twice: `abort()` on an
 * already-aborted controller is a documented no-op, and the record is cleared by
 * the `finally` regardless.
 */
function cancelCurrentSend() {
  if (!sendAbort) return;
  sendAbort.controller.abort();
}

/**
 * Put a stopped turn's message back in the composer. Returns the sentence the
 * notice should show — which is derived from what actually happened, never
 * assumed, so the notice cannot promise a restore that did not occur.
 *
 * REFUSES TO CLOBBER A NON-EMPTY COMPOSER. Unreachable while a send is in
 * flight, because the textarea is disabled for the duration (see
 * renderComposerBusy) — this is defence in depth, and it fails in the direction
 * of keeping the text the user can SEE rather than the text they cannot.
 */
function restoreDraft(text) {
  const ta = document.getElementById('chat-input');
  if (!ta || ta.value.trim() !== '') return 'Stopped. Nothing was saved.';
  ta.value = text;
  autosize(ta);
  return 'Stopped. Nothing was saved — your message is back in the composer.';
}

/**
 * The notice for a stopped turn, or '' when there is none.
 *
 * A FACT, STATED ONCE, IN THE RECESSED TREATMENT. No icon, no colour, no
 * animation: the user stopped this deliberately, so nothing has gone wrong, and
 * dressing it as a failure (the `alertCircle` + `--danger-text` treatment two
 * branches below in renderThreadOnly) teaches people to distrust the red that
 * marks a real one. Same reasoning, same styling, as `.chat-thinking-slow`.
 */
function cancelNoticeHtml() {
  const n = state.cancelNotice;
  if (!n || !n.text) return '';
  return '<div class="chat-stopped-note" role="status">' + escapeHtml(n.text) + '</div>';
}

// ── Compile to Wiki ──────────────────────────────────────────────────────
// Streams POST /api/compile/conversation and renders the outcome as an
// inline card in the thread — ported from src/public/app.js's Compile
// section (v3.0.14/v3.0.1-beta.27), which is where every invariant below
// comes from and was hard-won:
//   - `refused` is a NORMAL outcome (conversation too short, etc.), not an
//     error — src/routes/compile.js only emits it from a `result.reason`,
//     which compile.js's own comment distinguishes explicitly from
//     `result.error`. Rendered informational (chat-compile-refused, an
//     accent/neutral tone), never in the danger-red error styling.
//   - Pre-flight failures (missing field, unknown domain, a read-only
//     mirror, a 409 while an update is running) are plain HTTP JSON,
//     checked BEFORE the stream is ever read. A held file lock is NOT one
//     of these — the route acquires the lock, THEN starts the SSE stream,
//     so a lock conflict arrives as an in-stream `error` event, never an
//     HTTP status.
//   - Never `(await r.json())` inside a `throw` — a non-JSON error body
//     (any real HTML 5xx page) throws `Unexpected token '<'` instead of the
//     real message; the `.json()` call is wrapped in its own try/catch.
//   - THE v3.0.14 INVARIANT, verbatim: the outcome renders as a card
//     APPENDED INTO THE THREAD, never a fixed panel. A fixed panel between
//     thread and composer once took its height out of the message area and
//     never gave it back, permanently compressing every later message in
//     that conversation with no way to close it. `.chat-compile-card`
//     therefore carries NO max-height/overflow/flex-shrink of its own (see
//     chat.css) — any `overflow` there would flip its flex `min-height:
//     auto` to 0 and let the thread squeeze it back into a scroll box,
//     re-creating the bug indirectly. Horizontal containment lives on the
//     INNER `.chat-compile-change-summary` block instead.
//   - Scroll the card's TOP into view, never the thread's bottom — a card
//     taller than the visible thread (any double-digit-page compile) would
//     otherwise bury its own title and change counts, the whole point of
//     showing it. "Top" means below the sticky, opaque `.chat-scopebar`,
//     whose MEASURED height scrollCompileCardIntoView subtracts: landing the
//     card at the scrollport's own top parks its first rows behind that bar
//     instead (see that function's own comment for the measured repro).
//   - A compile runs 15-45s with the UI fully live, so `compileConvId`/
//     `compileDomain` are captured at CLICK time and `renderCompileOutcome`
//     below refuses to append if either has since changed — otherwise the
//     card either lands in an unrelated transcript (switch conversations
//     mid-compile) or floats alone over a freshly emptied thread (New chat
//     mid-compile). The pages are written either way; only the CARD is
//     conditional on the user still being where they clicked from.
//   - `warnings[]` on `done` is the ONLY signal that the full->concise->
//     summary-only fallback ladder degraded this compile (large/complex
//     conversation). It renders as an info note ABOVE the change list —
//     silently swallowing it would make a degraded compile look identical
//     to a clean one.

function formatBytesChat(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  return (n / 1024).toFixed(1) + ' KB';
}

// Pure — builds the inner HTML for a finished compile's change list. No DOM,
// no state; takes exactly the fields src/brain/compile.js's `done` event
// carries (same {canonPath, status, bytesBefore, bytesAfter, sectionsChanged,
// bulletsAdded} contract writePage() has returned since v2.5.0). Deliberately
// simpler than the shipping app's renderChangeRecords: "unchanged" pages are
// a static count line rather than a click-to-expand list — a compile's
// unchanged set is rarely interesting and this avoids wiring a second
// interactive toggle inside a card that already has none.
//
// `spentHtml` (v3.67.0) is shared/ai-run.js's after-the-run line, already
// rendered by the caller — "Ran on <model> · N in / M out · $x" — and is
// TRUSTED MARKUP (the kit escapes every field it prints). It sits directly
// under the card's heading, never below the change lists: a 30-page card is
// scrolled so its TOP lands in view (scrollCompileCardIntoView), and what the
// run cost is an outcome that may not end up under the fold of a long list.
// Absent (a server that sent no `spent`, or nothing ran) is '' — no line, never
// "$0.00".
function buildCompileOutcomeHtml(title, changes, warnings, spentHtml) {
  const list = Array.isArray(changes) ? changes : [];
  const created = list.filter((c) => c && c.status === 'created');
  const updated = list.filter((c) => c && c.status === 'updated');
  const unchanged = list.filter((c) => c && c.status === 'unchanged');

  const formatRecord = (c) => {
    let detail = '';
    if (c.status === 'updated' && c.bulletsAdded > 0) {
      const sections = Array.isArray(c.sectionsChanged) && c.sectionsChanged.length
        ? ' in ' + c.sectionsChanged.map(escapeHtml).join(', ')
        : '';
      detail = '<span class="chat-compile-change-detail">+<span class="chat-num">' + c.bulletsAdded + '</span> bullet' + (c.bulletsAdded === 1 ? '' : 's') + sections + '</span>';
    } else if (c.status === 'created') {
      detail = '<span class="chat-compile-change-detail">' + formatBytesChat(c.bytesAfter) + '</span>';
    } else if (c.status === 'updated') {
      detail = '<span class="chat-compile-change-detail">' + formatBytesChat(c.bytesBefore) + ' → ' + formatBytesChat(c.bytesAfter) + '</span>';
    }
    return '<li><span class="chat-compile-change-path">' + escapeHtml(c.canonPath || '') + '</span>' + detail + '</li>';
  };

  const createdBlock = created.length ? (
    '<div class="chat-compile-change-section chat-compile-change-created">' +
      '<div class="chat-compile-change-header">' + icon('plus', 13) + ' <span class="chat-num">' + created.length + '</span> new ' + (created.length === 1 ? 'page' : 'pages') + '</div>' +
      '<ul class="chat-compile-change-list">' + created.map(formatRecord).join('') + '</ul>' +
    '</div>'
  ) : '';
  const updatedBlock = updated.length ? (
    '<div class="chat-compile-change-section chat-compile-change-updated">' +
      '<div class="chat-compile-change-header">' + icon('activity', 13) + ' <span class="chat-num">' + updated.length + '</span> ' + (updated.length === 1 ? 'page' : 'pages') + ' updated</div>' +
      '<ul class="chat-compile-change-list">' + updated.map(formatRecord).join('') + '</ul>' +
    '</div>'
  ) : '';
  const emptyBlock = (!created.length && !updated.length)
    ? '<div class="chat-compile-change-empty">No pages were written.</div>'
    : '';
  const unchangedNote = unchanged.length
    ? '<div class="chat-compile-change-unchanged">' + unchanged.length + ' page' + (unchanged.length === 1 ? '' : 's') + ' already up to date</div>'
    : '';

  const warningsHtml = (Array.isArray(warnings) && warnings.length)
    ? '<div class="chat-compile-note">' + warnings.map((w) => '<div>' + icon('alertCircle', 12) + ' ' + escapeHtml(w) + '</div>').join('') + '</div>'
    : '';

  return (
    warningsHtml +
    '<div class="chat-compile-change-summary">' +
      '<h3 class="chat-compile-change-title">Compiled to wiki: ' + escapeHtml(title || '') + '</h3>' +
      (typeof spentHtml === 'string' ? spentHtml : '') +
      createdBlock + updatedBlock + emptyBlock + unchangedNote +
    '</div>'
  );
}

// Updates the LIVE button label/disabled state directly — called on every
// SSE `progress`/`wait` frame, far too often to justify a full renderMain()
// rebuild (which would tear down and re-focus the composer on every tick).
// A full rebuild DOES still happen if the user switches domain/conversation
// mid-compile, or arrives on a fresh mount while a compile is in flight —
// renderCompileButtonHtml reads state.compileBusy/compilePct for exactly
// that case. This function is the fast path for the common one.
//
// `owner` is the calling run's token (see state.compileOwner). A call whose
// owner is not the current holder publishes NOTHING — not to `state`, not to
// the DOM. That single guard is what makes the lock's lifetime the RUN's:
// without it, any run that somehow outlives its claim can release a lock it
// no longer holds, re-enabling the button under a live compile. Note the
// guard is deliberately NOT an isCurrentMount check — the owner's own
// updates SHOULD reach whatever mount is on screen, so that a Chat mount
// entered mid-compile shows a correctly disabled button.
//
// Null-checks both elements the same way renderComposerBusy does: if a
// domain switch mid-compile has already replaced this DOM subtree, or the
// user is on another view entirely, these are harmless no-ops, not errors.
function updateCompileButtonBusy(owner, busy, pct) {
  if (owner !== state.compileOwner) return;
  state.compileBusy = busy;
  state.compilePct = busy ? (pct || 0) : 0;
  if (!busy) state.compileOwner = null;
  const btn = document.getElementById('chat-compile-btn');
  const labelEl = document.getElementById('chat-compile-btn-label');
  // Released to ENABLED only when a run is possible: a key that went away
  // while a compile ran (the key removed in Settings mid-run) leaves the
  // button in its no-key state, whose markup `applyCompileRunsOn` set.
  if (btn) btn.disabled = busy || !!state.compileKeyAttrs;
  if (labelEl) labelEl.textContent = busy ? ('Compiling… ' + Math.round(pct || 0) + '%') : 'Compile to Wiki';
}

// Scrolls so the card's TOP lands at the top of the visible thread area —
// see this section's own header comment for why. #chat-thread has NO
// scroll of its own (see renderThreadOnly's own comment, bottom of this
// file): #main is the real scrolling ancestor, so offsets are measured
// against it, not against the thread element.
//
// v3.72.0: NOTHING IS STICKY AT THE TOP OF THE COLUMN any more — the scope
// bar went (M2: the domain and project moved to the composer, Compile to the
// view header, which scrolls with the thread). So the card lands 8px into the
// scrollport and there is no bar to measure; scripts/test-next-chat-compile.js
// §6c holds the arithmetic AND that chat.css declares no top-sticky rule, so
// the day one returns, this function goes red rather than hiding a card under
// it again. The history: `.chat-scopebar` was `position: sticky; top: 0` with
// an OPAQUE background and covered the top of #main's scrollport; measured
// live at 1440x892 it hid the degraded-compile note entirely, which is why
// this function measured the bar through v3.71.
function scrollCompileCardIntoView(card) {
  const scrollHost = document.getElementById('main');
  if (!scrollHost) return;
  const hostRect = scrollHost.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  scrollHost.scrollTop += (cardRect.top - hostRect.top) - 8;
}

// Pure — the mid-compile-switch guard runCompile()'s renderCompileOutcome
// closure relies on, factored out so it's directly testable without a DOM
// (see scripts/test-next-chat-compile.js). Captures the exact bug this
// closes: a compile runs 15-45s with the UI live, so by the time it
// resolves the user may have switched conversations or domains (or started
// a New chat, which sets activeConversationId to null) — appending the
// outcome card in that case would land it in an unrelated transcript, or
// float alone over a freshly emptied thread. The pages are written either
// way; only whether the CARD appears is conditional on this.
function compileStillTargetsActive(activeConversationId, compileConvId, activeDomain, compileDomain) {
  return activeConversationId === compileConvId && activeDomain === compileDomain;
}

// The push-into-thread half of the outcome render, hoisted to module scope so
// the COST GATE below can render a refusal through exactly the same path the
// finished compile does. It was a closure inside runCompile(); the closure is
// still there and now delegates here, so there is one implementation of "put a
// compile card in the thread" rather than two that can drift. Returns false
// when the user has navigated away, so the caller can log the miss.
function pushCompileCard(html, compileConvId, compileDomain) {
  if (!compileStillTargetsActive(state.activeConversationId, compileConvId, state.activeDomain, compileDomain)) {
    return false;
  }
  state.thread.push({ role: 'compile', html });
  const liveToken = myMountToken;
  renderThreadOnly(liveToken);
  // `querySelectorAll(...)`'s last match, NOT `:last-child` — if
  // state.sending happens to be true at this exact moment (a message send
  // racing a compile in the same conversation), renderThreadOnly appends
  // a trailing "thinking…" bubble AFTER every state.thread item, which
  // would otherwise BE the last child and defeat a `:last-child` selector.
  const threadEl = document.getElementById('chat-thread');
  const cards = threadEl ? threadEl.querySelectorAll('.chat-compile-card') : null;
  const card = cards && cards.length ? cards[cards.length - 1] : null;
  if (card) scrollCompileCardIntoView(card);
  return true;
}

// ── THE COST GATE ────────────────────────────────────────────────────────
// v3.27.0. Compile to Wiki was the last paid action in the app that spent
// money with no estimate and no confirm. Everything from here to
// startCompile() is that gate; runCompile() below it is unchanged and is now
// only ever reached through a confirmed dialog.
//
// FOUR DECISIONS, EACH OF WHICH COULD REASONABLY HAVE GONE THE OTHER WAY:
//
//   1. A FAILED ESTIMATE STILL SHOWS THE CONFIRM. The estimate is a service;
//      the confirm is the promise. If the estimate 500s, blocking the compile
//      would let a broken read route disable a working feature, and skipping
//      the dialog would spend money silently. So the dialog opens and SAYS the
//      cost is unknown — which is both true and the fail-safe direction.
//
//   2. A REFUSAL NEVER BECOMES A DIALOG. A conversation that is too short, or
//      already compiled, costs nothing to refuse. Asking the user to authorise
//      a spend that cannot happen teaches them the dialog is noise. The
//      refusal is rendered as the same `.chat-compile-refused` card the SSE
//      path renders — the round trip that used to be needed to see it is gone.
//
//   3. THE DIALOG IS `tone: 'default'`, NOT `'danger'`. Danger is the design
//      system's DESTRUCTIVE variant (red fill, focus parked on Cancel) and
//      compile deletes nothing — it writes and merges. Dressing a paid,
//      additive action in the same red as "Delete this conversation" devalues
//      the signal on the controls that really are destructive. The cost is
//      carried by the words, and Enter confirming a dialog the user opened
//      by pressing a button is the platform behaviour.
//
//   4. THE PREP FLAG IS SEPARATE FROM `state.compileBusy`. compileBusy is a
//      lock on a RUNNING, PAID write and its label reads "Compiling… N%".
//      Claiming it while a dialog is open would put that label on screen for a
//      compile that has not started and may never start — the app lying about
//      what it is doing. `compilePrepping` is its own flag with its own label.
let compilePrepping = false;

// The two elements updateCompileButtonBusy touches, null-checked the same way
// and for the same reason: a domain switch may already have replaced this DOM.
function setCompilePrepUi(on) {
  const btn = document.getElementById('chat-compile-btn');
  const labelEl = document.getElementById('chat-compile-btn-label');
  if (btn) btn.disabled = on;
  if (labelEl) labelEl.textContent = on ? 'Checking cost…' : 'Compile to Wiki';
}

function providerDisplayLabel(provider) {
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'anthropic') return 'Claude';
  if (provider === 'openrouter') return 'OpenRouter';
  return 'your AI provider';
}

/**
 * PURE — the confirm dialog's words, built from an estimate payload. No DOM,
 * no state, no fetch, so the offline suite can drive every branch directly
 * (see scripts/test-next-compile-estimate.js).
 *
 * THE FOUR COST BRANCHES ARE FOUR DIFFERENT FACTS AND NEVER COLLAPSE:
 * a real price, a FREE model, a model with NO PUBLISHED PRICE, and NO PROVIDER
 * AT ALL. v3.15.0's recorded defect is a fact and its absence sharing one
 * value; rendering any of the last three as "$0.00" would be exactly that, on
 * the surface whose only job is to say what something costs.
 *
 * @param {object|null} est          the `/api/compile/estimate` body, or null
 * @param {string} domain            destination wiki
 * @param {string} convTitle         user content — the caller passes it to
 *                                   confirmThen's `message`, which sets it with
 *                                   textContent, never innerHTML
 * @param {string|null} estimateError why there is no estimate, if there isn't
 * @param {{runLine?: boolean}} [opts]  v3.67.0: `runLine: true` when the
 *                                   dialog also shows the shared run line
 *                                   (shared/ai-run.js) as its first line. The
 *                                   line already names the model and the cost,
 *                                   so the detail stops repeating them: a
 *                                   figure stated twice in two formats is how
 *                                   two copies come to disagree. What stays is
 *                                   what the line cannot say — why a range is
 *                                   a range, and where the pages land. OMITTED
 *                                   (every call before v3.67.0, and a server
 *                                   that sent no `runsOn`) returns the
 *                                   pre-v3.67.0 copy byte for byte.
 */
function buildCompileConfirmCopy(est, domain, convTitle, estimateError, opts) {
  const title = 'Compile this conversation to your wiki?';
  const message = convTitle || 'Untitled conversation';
  const where = `Pages are written into the "${domain}" wiki, merging into pages that already exist.`;

  if (!est || !est.estimate) {
    return {
      title,
      message,
      confirmLabel: 'Compile',
      detail:
        `The cost could not be estimated (${estimateError || 'no estimate was returned'}), so this compile will ` +
        `spend an unknown amount at your provider's rate. ${where}`,
    };
  }

  const e = est.estimate;
  const model = est.model ? `${providerDisplayLabel(est.provider)} "${est.model}"` : 'your AI provider';
  const lo = formatUsdHonest(e.usdLow);
  const hi = formatUsdHonest(e.usdHigh);

  let cost;
  let ranged = false;
  if (e.priceKnown && lo && hi) {
    ranged = lo !== hi;
    cost = ranged
      ? `Estimated cost ${lo} – ${hi} on ${model}.`
      : `Estimated cost about ${lo} on ${model}.`;
  } else if (e.costUnknown === 'free-model') {
    cost = `${model} is free to use, so this compile will not cost anything.`;
  } else if (e.costUnknown === 'no-provider') {
    cost = 'No AI provider is configured, so there is no cost to estimate — and nothing to compile with. Add a Gemini, Anthropic or OpenRouter key in Settings › Providers & keys first.';
  } else {
    cost = `No published price is on file for ${model}, so the cost cannot be shown in dollars. Your provider will still bill this compile at their rate.`;
  }

  // The honesty clause is attached to the RANGE, not to every branch: it
  // explains why two numbers are shown instead of one, and saying it where
  // there are no numbers would be noise.
  const uncertainty = ranged
    ? ' That is a range rather than a price — how many wiki pages the AI decides to write cannot be known before the call, and if the first attempt overruns its output limit The Curator retries, which costs more.'
    : '';

  // THE RUN LINE CARRIES THE MODEL AND THE FIGURE. The no-provider sentence is
  // NOT dropped with the others: it is the one branch that is about what to DO
  // (and the line's own no-key form is five words); every other branch's cost
  // sentence is exactly what the line above it already reads.
  // ── A FALLBACK IS PRICED TOO (v3.72.0, truth audit F5) ─────────────────
  // The figure above prices the configured model. If that model is
  // unavailable the run walks llm.js's fallback chain, which bills a
  // DIFFERENT model — chains escalate forward, so possibly a dearer one. The
  // estimate names the first rung that walk would take (P1,
  // `estimate.fallback`), and the dialog says so before the spend. Absent
  // (no chain, or a server from before v3.72.0) adds nothing, so the copy is
  // byte-identical to before in that case.
  const fb = e.fallback && typeof e.fallback === 'object' && typeof e.fallback.model === 'string' && e.fallback.model
    ? e.fallback : null;
  let fallbackLine = '';
  if (fb && e.costUnknown !== 'no-provider') {
    const fbName = `${providerDisplayLabel(fb.provider)} "${fb.model}"`;
    const rate = (n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0) ? n : null;
    const fin = rate(fb.inPerM);
    const fout = rate(fb.outPerM);
    const priced = fb.free === true
      ? 'which is free'
      : (fb.priceKnown === true && fin !== null && fout !== null
        ? `priced $${fin} / $${fout} per 1M input / output tokens`
        : 'which has no published price');
    fallbackLine = ` If ${model} is unavailable, The Curator may fall back to ${fbName}, ${priced}.`;
  }

  if (opts && opts.runLine === true && e.costUnknown !== 'no-provider') {
    const why = ranged
      ? 'The figure above is a range rather than a price — how many wiki pages the AI decides to write cannot be known before the call, and if the first attempt overruns its output limit The Curator retries, which costs more. '
      : '';
    return { title, message, confirmLabel: 'Compile', detail: `${why}${where}${fallbackLine}` };
  }

  return { title, message, confirmLabel: 'Compile', detail: `${cost}${uncertainty}${fallbackLine} ${where}` };
}

/**
 * The model this chat is on, as far as this view KNOWS it — or null, meaning
 * "the chat is on your AI model" (nothing picked: a new thread starts on the
 * build model, and the server answers a model-less turn with it).
 *
 * Three arms, and the middle one is deliberately modest. A PICKED model is a
 * fact: its id, and its catalogue label. A picked PROVIDER with no model named
 * (the composer's provider mode) is a fact about the provider only — which
 * default that provider answers with is the server's to resolve — so it is
 * returned with `id: null`, and `compileModelClause` claims a difference only
 * when the PROVIDER differs. Claiming "not the model this chat is on" about a
 * model this view merely inferred would be the false notice this file's
 * `chatDefaultGone` comment refuses for the same reason.
 *
 * @returns {{id: string|null, provider: string|null, label: string}|null}
 */
function chatModelOnScreen() {
  const provider = (typeof state.modelProvider === 'string' && state.modelProvider) ? state.modelProvider : null;
  if (typeof state.chatModel === 'string' && state.chatModel) {
    const row = resolveChatModel(state.chatModel, state.offerable, state.availableProviders, provider || undefined);
    return { id: state.chatModel, provider, label: (row && row.entry && row.entry.label) || state.chatModel };
  }
  if (provider) {
    const def = state.models && Object.hasOwn(state.models, provider) ? state.models[provider] : null;
    const row = def ? resolveChatModel(def, state.offerable, state.availableProviders, provider) : null;
    return { id: null, provider, label: (row && row.entry && row.entry.label) || def || providerDisplayLabel(provider) };
  }
  return null;
}

/**
 * PURE — Compile's added clause (DESIGN-ai-jobs inconsistency 9), or ''.
 *
 * A user chatting on Sonnet presses Compile, and Compile runs on the one AI
 * model — Flash Lite, say. The run line names Flash Lite; this sentence says
 * the part a reader would not otherwise think to ask: that it is not the model
 * they have been talking to. It appears ONLY when the two differ; saying it
 * when they are the same would be a notice about nothing, and a notice about
 * nothing is how the next real one gets ignored.
 *
 * @param {object|null} runsOn  the estimate's `runsOn` (describeRun's shape)
 * @param {{id: string|null, provider: string|null, label: string}|null} chat
 *        chatModelOnScreen()'s answer
 * @returns {string} plain text (renderRunsOn escapes its `extraLine`)
 */
function compileModelClause(runsOn, chat) {
  if (!runsOn || typeof runsOn !== 'object' || runsOn.needsKey === true) return '';
  if (!chat) return '';
  const runModel = typeof runsOn.model === 'string' ? runsOn.model : '';
  let differs = false;
  if (chat.id) differs = !!runModel && chat.id !== runModel;
  else differs = !!chat.provider && typeof runsOn.provider === 'string' && !!runsOn.provider && chat.provider !== runsOn.provider;
  if (!differs) return '';
  return 'Compile uses your AI model, not the model this chat is on (' + (chat.label || chat.id || chat.provider) + ').';
}

/**
 * The Compile confirm's FIRST LINE — the shared run line, plus the clause when
 * the chat is on another model — as a function that places it.
 *
 * WHY A FUNCTION TO QUEUE, AND WHY THE DIALOG'S OWN `#cfd-body`.
 * shared/confirm.js writes every string with textContent (a conversation title
 * is user content and reaches it verbatim), so it has no field for markup, and
 * it is a kit nobody edits this release. The run line is markup — a model span
 * carrying its `Provider · id` title, mono figures, a real door button — built
 * by shared/ai-run.js, which escapes every field it prints. So it is placed
 * into the open dialog, as the first child of the element the dialog itself
 * names in `aria-describedby="cfd-body"`: that id is the kit's public contract
 * (a screen reader reads the line as part of the dialog's description because
 * of it), not a private reach — the same reasoning `patchProjectFooter` gives
 * for `cfg.id + '-menu'`.
 *
 * confirmThen builds its DOM SYNCHRONOUSLY and only then returns its promise,
 * so startCompile queues this with queueMicrotask immediately before its
 * `await confirmThen({...})`: the microtask runs once the dialog exists and
 * before the browser paints it, so no frame shows the dialog without its line.
 * It refuses to write into a dialog it did not open (confirmThen declines a
 * second dialog while one is open, and the title check is what tells ours
 * apart), and it wires the line's door on the dialog's own root, since the
 * dialog lives on <body>, outside #view-root.
 *
 * @param {object|null} est    the estimate body (its `runsOn` is read)
 * @param {string} title       the dialog title startCompile passes
 * @returns {() => boolean}    true when a line was placed
 */
function compileConfirmLead(est, title) {
  const runsOn = est && est.runsOn && typeof est.runsOn === 'object' ? est.runsOn : null;
  const html = runsOn
    ? renderRunsOn(runsOn, {
        id: COMPILE_CONFIRM_RUNLINE_ID,
        extraLine: compileModelClause(runsOn, chatModelOnScreen()) || undefined,
      })
    : '';
  return () => {
    if (!html) return false;
    const body = document.getElementById('cfd-body');
    const titleEl = document.getElementById('cfd-title');
    if (!body || !titleEl || titleEl.textContent !== title) return false;
    if (body.querySelector('.ai-run')) return false;
    body.insertAdjacentHTML('afterbegin', html);
    const root = body.closest('.cfd-root');
    if (root) wireAiRunDoors(root, { requestSettingsSection, navigate });
    return true;
  };
}

/**
 * Compile's RESTING no-key state, read once per mount.
 *
 * THE ONE SOURCE (contract §1.13): GET /api/health/ai-available, free and
 * local, which carries `runsOn: describeRun({job})` — and `runsOn.needsKey` is
 * the fact. A server from before v3.67.0 sends no `runsOn` but the same fact as
 * `available: false` (both are "getProviderInfo() threw"), so that is read as
 * the same answer rather than as silence. Anything else — a failed request, an
 * unreadable body — leaves the button exactly as it was: enabled. Guessing "no
 * key" from a network blip would disable a working install.
 */
async function loadCompileAvailability(token) {
  let body = null;
  try {
    const res = await fetch('/api/health/ai-available');
    if (!res.ok) return;
    body = await res.json();
  } catch { return; }
  if (!isCurrentMount(token) || !body || typeof body !== 'object') return;
  const runsOn = (body.runsOn && typeof body.runsOn === 'object') ? body.runsOn
    : (body.available === false ? { needsKey: true } : null);
  applyCompileRunsOn(runsOn);
}

/**
 * Publish Compile's no-key state: into `state` (what the next full render
 * reads) AND onto the live button and its group (so the answer landing after
 * the first paint shows without a repaint that would tear down the composer).
 *
 * DISABLED, NEVER HIDDEN (contract Q3): the button stays where it is, with the
 * no-key run line under it and `aria-describedby` pointing at that line, so a
 * keyboard or screen-reader user hears WHY it cannot be pressed — a hidden
 * button explains nothing. The line's door is the one door to Providers & keys.
 */
function applyCompileRunsOn(runsOn) {
  const needsKey = !!(runsOn && runsOn.needsKey === true);
  state.compileKeyAttrs = needsKey ? aiActionDisabledAttrs(runsOn, COMPILE_RUNLINE_ID) : '';
  state.compileKeyLineHtml = needsKey ? renderRunsOn(runsOn, { id: COMPILE_RUNLINE_ID }) : '';

  const btn = document.getElementById('chat-compile-btn');
  if (!btn) return;
  const host = document.getElementById('chat-compile-keyline-host');
  const oldLine = document.getElementById(COMPILE_RUNLINE_ID);
  if (oldLine) oldLine.remove();
  if (needsKey) {
    if (host) host.insertAdjacentHTML('beforeend', state.compileKeyLineHtml);
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('aria-describedby', COMPILE_RUNLINE_ID);
  } else {
    btn.removeAttribute('aria-disabled');
    btn.setAttribute('aria-describedby', 'chat-compile-caption');
    // A run in flight or an estimate being fetched owns `disabled`; only an
    // idle button is released here.
    if (!state.compileBusy && !compilePrepping) btn.disabled = false;
  }
}

/**
 * The Compile button's click handler. Estimates, then asks, then — and only
 * then — calls runCompile(), which is the function that spends money.
 */
async function startCompile() {
  // Same shape as runCompile's own guard: read and claim with no `await` in
  // between, so a second click cannot pass. `compilePrepping` is checked
  // alongside the run lock so a click during the estimate is a no-op rather
  // than a second dialog.
  if (compilePrepping || state.compileBusy || state.compileOwner !== null) return;
  if (!state.activeConversationId || !state.activeDomain) return;

  const convId = state.activeConversationId;
  const domain = state.activeDomain;
  const row = state.conversations.find((c) => c.id === convId && (c.domain || state.activeDomain) === state.activeDomain);
  const convTitle = (row && typeof row.title === 'string') ? row.title : '';

  compilePrepping = true;
  setCompilePrepUi(true);

  let est = null;
  let estimateError = null;
  try {
    const res = await fetch(
      '/api/compile/estimate?domain=' + encodeURIComponent(domain) +
      '&conversationId=' + encodeURIComponent(convId));
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) estimateError = (body && body.error) || ('HTTP ' + res.status);
    else if (!body) estimateError = 'the server sent an unreadable response';
    else est = body;
  } catch (err) {
    estimateError = err && err.message ? err.message : 'the request failed';
  } finally {
    // Released BEFORE the dialog opens: the dialog is its own modal gate, and
    // leaving the button disabled behind a dismissed dialog would strand it.
    compilePrepping = false;
    setCompilePrepUi(false);
  }

  if (est && est.compilable === false) {
    const shown = pushCompileCard(
      '<div class="chat-compile-refused">' + icon('alertCircle', 14) + ' ' +
      escapeHtml(est.refusal || 'This conversation cannot be compiled.') + '</div>',
      convId, domain);
    if (!shown) console.warn('[next/chat] compile refusal arrived after the user navigated away — card not shown');
    return;
  }

  const copy = buildCompileConfirmCopy(est, domain, convTitle, estimateError,
    { runLine: !!(est && est.runsOn && typeof est.runsOn === 'object') });
  // The run line goes in as the dialog's first line the moment confirmThen has
  // built it — see compileConfirmLead for why a queued microtask, and why the
  // dialog's own #cfd-body.
  queueMicrotask(compileConfirmLead(est, copy.title));
  await confirmThen({
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    confirmLabel: copy.confirmLabel,
    cancelLabel: 'Cancel',
    tone: 'default',
    onConfirm: () => {
      // The user authorised a spend for the conversation they were LOOKING AT.
      // If the target moved while the dialog was open, that authorisation does
      // not transfer — refuse rather than compile something else. Reachable
      // only through the keyboard (the scrim covers the page), which is
      // exactly why it is checked rather than assumed.
      if (!compileStillTargetsActive(state.activeConversationId, convId, state.activeDomain, domain)) return;
      return runCompile();
    },
  });
}

async function runCompile() {
  // Two independent expressions of the same single-flight invariant, both
  // read and both claimed SYNCHRONOUSLY (no `await` anywhere between this
  // check and the claim below), so there is no window for a second click to
  // pass. They are written in exactly two places — here and
  // updateCompileButtonBusy — and always together, so they cannot drift.
  if (state.compileBusy || state.compileOwner !== null) return;
  if (!state.activeConversationId || !state.activeDomain) return;

  // Captured at click time (this function is only ever entered from the
  // compile button's own click handler) — see this section's header
  // comment for why the outcome render below re-checks both against the
  // LIVE state before appending anything. `mountToken` is captured here,
  // before any await, per this file's H1 rule; it is used ONLY by the
  // best-effort state.domains refresh at the end (which genuinely must not
  // write module state on behalf of a dead mount). It is deliberately NOT
  // used to decide whether the outcome card renders — see
  // renderCompileOutcome below.
  const mountToken = myMountToken;
  const compileConvId = state.activeConversationId;
  const compileDomain = state.activeDomain;

  // This run's owner token. Minting it here (rather than inside the try
  // below, where the actual claim now happens) keeps it synchronous with
  // the guard above with no `await` in between — see that guard's own
  // comment. Minting alone is inert: nothing is claimed yet, so a throw
  // here (there is none — `++` on a module-scoped `let` cannot throw)
  // would have nothing to release.
  const owner = ++compileRunSeq;

  // Pushes into `state.thread` (as a synthetic `{role:'compile', html}`
  // item) rather than appending straight into the DOM — see renderThreadOnly's
  // own comment on that branch for why: this file rebuilds `#chat-thread`
  // from `state.thread` on every subsequent send/domain-switch/etc., so a
  // card that lived only in the DOM would vanish the next time any of those
  // ran, one message after the user saw it. Refuses to push at all if the
  // conversation/domain moved on since the click (the mid-compile-switch
  // race this whole section exists to close) — the pages are written
  // either way; only the card's presence is conditional.
  //
  // compileStillTargetsActive is the WHOLE gate, deliberately. An
  // isCurrentMount(mountToken) check used to sit in front of it and was
  // strictly harmful: both documented harms (card lands in an unrelated
  // transcript / floats over a freshly emptied thread) are already covered
  // by the conversation+domain comparison, while the mount check ALSO fired
  // when the user had merely glanced at another view and come back to the
  // SAME domain and SAME conversation — a remount, a new token, and a
  // successful paid compile whose only trace was a console.warn. This
  // matches the shipping app (src/public/app.js's own renderCompileOutcome
  // compares activeConvId/chatDomain and nothing else).
  //
  // The render therefore uses the LIVE myMountToken, not the token captured
  // at click time. That is not a violation of this file's "never re-read
  // myMountToken after an await" rule — it is the one case the rule's own
  // reasoning permits: we are not asking "was I still current?", we are
  // asking "which mount am I painting into NOW?", and the gate above has
  // already established the user is looking at the right conversation. If
  // Chat is not the mounted view at all, renderThreadOnly's own
  // isCurrentMount check makes this a no-op and #chat-thread is absent, so
  // nothing paints and nothing throws (the card stays in state.thread and is
  // replaced by the server's copy on the next boot — the same outcome as
  // before, minus the false negative above).
  const renderCompileOutcome = (html) => {
    const shown = pushCompileCard(html, compileConvId, compileDomain);
    if (!shown) console.warn('[next/chat] compile finished after the user navigated away — card not shown');
    return shown;
  };

  // A compile that was BILLED and then failed (a later rung's parse, a write
  // error) still cost money: the route's `error` event carries `spent` exactly
  // when a call was billed (v3.67.0). Held outside the try so the catch below,
  // which renders the error card, can say what the failed run cost — an
  // outcome, and a cost, is never dropped because the run did not succeed.
  let spentOnError = null;

  try {
    // The actual claim — both statements, inside the try, so a throw from
    // either (neither can throw today: a plain assignment, then a function
    // that only touches `state` and `document.getElementById`, both
    // null-checked) is caught below and the `finally` still releases what
    // was claimed. Before this they sat between the guard and `try`: the
    // one throw-shaped path left to a PERMANENTLY disabled Compile button
    // (no finally to run at all, so the claim would never be released).
    // Not reachable today — recorded as closed anyway, since closing it
    // costs nothing and finding the next thing that makes it reachable is
    // exactly the kind of assumption this codebase's history warns against.
    state.compileOwner = owner;
    updateCompileButtonBusy(owner, true, 0);

    const res = await fetch('/api/compile/conversation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: compileDomain, conversationId: compileConvId }),
    });

    if (!res.ok && res.status !== 200) {
      // Pre-flight validation errors (missing field, unknown domain, a
      // read-only mirror, an in-progress update) are plain JSON, not SSE.
      let errMsg = 'HTTP ' + res.status;
      try { const j = await res.json(); errMsg = j.error || errMsg; } catch { /* non-JSON body — keep the generic message */ }
      throw new Error(errMsg);
    }
    if (!res.body) throw new Error('Streaming is not supported by this browser.');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final = null, refused = null, errored = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let event;
        try { event = JSON.parse(line.slice(6)); } catch { continue; }
        if (event.type === 'progress' || event.type === 'wait') {
          updateCompileButtonBusy(owner, true, event.pct != null ? event.pct : 50);
        } else if (event.type === 'done') {
          final = event;
        } else if (event.type === 'refused') {
          refused = event.reason;
        } else if (event.type === 'error') {
          errored = event.message;
          if (event.spent && typeof event.spent === 'object') spentOnError = event.spent;
        }
      }
    }

    if (errored) throw new Error(errored);
    if (refused) {
      // Normal outcome, not an error — see this section's header comment.
      renderCompileOutcome('<div class="chat-compile-refused">' + icon('alertCircle', 14) + ' ' + escapeHtml(refused) + '</div>');
      return;
    }
    if (!final) throw new Error('The compile finished with no result.');

    const changes = Array.isArray(final.changes) ? final.changes : [];
    const warnings = Array.isArray(final.warnings) ? final.warnings : [];
    // `final.spent` is the route's spentFromUsage() over EVERY rung of the
    // full → concise → summary-only ladder (a degraded compile paid for each
    // attempt, and the line says so by its figure). renderSpent returns ''
    // for an absent or empty payload, so an older server adds no line.
    renderCompileOutcome(buildCompileOutcomeHtml(final.title, changes, warnings, renderSpent(final.spent)));

    // Best-effort refresh of `state.domains` (pageCount etc.) so the NEXT
    // natural full render (a domain switch, a remount) picks up what this
    // compile just wrote. Deliberately does NOT call renderMain()/
    // renderShell() itself: renderMain() re-reads `state.domains` and
    // rebuilds the entire main column — scopebar, thread, composer — which
    // would tear down and re-create the composer (losing focus and any
    // half-typed message) purely to update a page count the user has not
    // asked to see. The outcome card itself would SURVIVE that rebuild (it
    // lives in `state.thread`, which is the whole reason renderCompileOutcome
    // pushes it there rather than appending to the DOM — see renderThreadOnly's
    // `role === 'compile'` branch); the earlier claim here that a render would
    // "silently wipe the outcome card" was false, though the conclusion —
    // don't render — stands for the composer-teardown reason above. A failed
    // fetch here is invisible and fine either way.
    //
    // isCurrentMount IS correct here, unlike in renderCompileOutcome: this
    // writes module state (`state.domains`) that a dead mount has no business
    // touching, and `mountToken` is the click-time capture per the H1 rule.
    try {
      const domainsData = await fetch('/api/domains/stats').then(r => r.json());
      if (isCurrentMount(mountToken) && Array.isArray(domainsData.domains)) {
        state.domains = domainsData.domains;
        // F1 (v3.72.0): the fresh count used to sit in `state.domains` while
        // the screen kept the old one until a domain switch. Every place the
        // count is printed is now PATCHED in place — the header's meta line,
        // the empty thread's line and the composer's domain menu — which is
        // still not the renderMain() the paragraph above refuses.
        patchScopeCount();
      }
    } catch { /* best-effort, see above */ }
  } catch (err) {
    renderCompileOutcome('<div class="chat-compile-error">' + icon('alertCircle', 14) + ' ' + escapeHtml(err.message) + '</div>' +
      renderSpent(spentOnError));
  } finally {
    // Releases the lock. Runs unconditionally — not isCurrentMount-gated,
    // and the fetch above is never aborted on teardown — which is exactly
    // why onEnter does not need (and must not have) a compileBusy reset.
    updateCompileButtonBusy(owner, false, 0);
  }
}

function focusComposer() {
  const ta = document.getElementById('chat-input');
  if (ta) ta.focus();
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
}

// ── Reader integration ───────────────────────────────────────────────────
//
// openReader() takes a full content object (see app.js's doc comment on
// it): this view builds that object and hands it over — it never reaches
// into `.reader-body` or any other shell-owned DOM itself. `onBacklinkClick`
// is how a click on a rendered backlink row gets back to this view without
// it having to attach its own listeners after the shell paints.
async function openWikiReader(path, titleHint) {
  const token = ++state.readerToken;
  // `mount` is captured BY VALUE here, before any await — this was already
  // correct before the re-audit (the one call site the auditor confirmed as
  // the right pattern) and is now the template every other async entry
  // point in this file follows.
  const mount = myMountToken;
  const fallbackTitle = titleHint || path.split('/').pop().replace(/\.md$/, '');
  // MEDIUM-3 fix (third re-audit round): `epoch` is captured from
  // openReader()'s OWN return value — see app.js's readerEpoch doc comment.
  // isCurrentMount(mount) alone isn't enough here: navigate() closes the
  // reader on every VIEW change, but Esc / the scrim / the ✕ button close
  // it WITHOUT any navigation, so the mount stays current throughout.
  // Without this second check, closing the reader and then waiting out an
  // in-flight citation fetch re-opened the overlay on top of whatever the
  // user went back to look at — reproduced: open a page, press Esc, and
  // the fetch (still in flight) painted it right back a moment later.
  const epoch = openReader({ slug: path, title: fallbackTitle, loading: true }, mount);

  try {
    const res = await fetch(
      '/api/wiki/' + encodeURIComponent(state.activeDomain) + '/page?path=' + encodeURIComponent(path)
    );
    const page = await res.json();
    if (token !== state.readerToken) return; // superseded by a newer open/backlink click
    if (!isCurrentMount(mount)) return; // the VIEW moved on (navigate() already closed the reader)
    if (!isCurrentReader(epoch)) return; // the READER was explicitly closed (or reopened) since we started
    if (!res.ok) throw new Error(page.error || 'Could not load this page.');
    paintReaderPage(path, page, mount);
  } catch (err) {
    if (token !== state.readerToken) return;
    if (!isCurrentMount(mount)) return;
    if (!isCurrentReader(epoch)) return;
    openReader({ slug: path, title: fallbackTitle, error: err.message }, mount);
  }
}

function paintReaderPage(path, page, mount) {
  const folder = page.folder || folderOfPath(page.path || path);
  const tags = Array.isArray(page.frontmatter && page.frontmatter.tags) ? page.frontmatter.tags : [];
  // L4 fix: some frontmatter comes back with tags still carrying their
  // literal YAML quote characters (e.g. the string `"type/entity"`, quotes
  // included) rather than the bare `type/entity`. `/^type\//` never
  // matched the quoted form, so the type tag both drove the badge AND
  // leaked through as its own plain chip, quote marks and all. Strip
  // wrapping quotes before testing/displaying so either form is treated
  // the same.
  const plainTags = tags
    .map(t => String(t).replace(/^"+|"+$/g, ''))
    .filter(t => !/^type\//.test(t));
  const backlinks = Array.isArray(page.backlinks)
    ? page.backlinks.map(b => ({ path: b.path, title: b.title || b.slug, type: b.folder }))
    : [];

  openReader({
    // Raw-source handoff: the shell reader's RAW bar needs the domain to call
    // GET /api/wiki/:domain/source. Without it a citation-opened reader shows no
    // bar and issues NO request — degraded, never a wrong-domain guess.
    domain: state.activeDomain,
    slug: page.path || path,
    title: page.title,
    type: folder,
    typeLabel: page.type,
    tags: plainTags,
    readonly: !!page.readonly,
    bodyHtml: renderMarkdown(page.body || ''),
    backlinks,
    onBacklinkClick: (bp, bt) => openWikiReader(bp, bt),
  }, mount);
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderShell(token) {
  renderSidebar(token);
  renderMain(token);
}

// ── The conversation pane ────────────────────────────────────────────────
//
// v3.72.0: the row, the grouping, the list head, the Select mode's bar and
// their wiring live in views/chat-list.js (DOM-free, the ONE sidebar
// component). What stays here is what needs this view's state and its
// actions: the context object the builders read, the handlers they call, and
// the domain filter's listbox (listbox.js imports app.js, which that module
// must not).

/** Everything the pane's builders read, from `state`, in one object. */
function listCtx() {
  return {
    conversations: state.conversations,
    domains: state.domains,
    activeDomain: state.activeDomain,
    activeConversationId: state.activeConversationId,
    selectMode: state.selectMode,
    selectedKeys: state.selectedConvKeys,
    answeringConvId: state.answeringConvId,
    answeringDomain: state.answeringDomain,
    searchQuery: state.searchQuery,
    loadError: state.loadError,
    domainFilter: state.domainFilter,
    total: state.listTotal,
    unreadable: state.listUnreadable,
    bulkNotice: state.bulkNotice,
    emptyExtraHtml: filterAskRowHtml(),
    now: Date.now(),
  };
}

/**
 * The list's DOMAIN FILTER (M1). The shared listbox, one option per domain
 * that can HOLD conversations — a Shared Brain mirror is answered but never
 * written to (src/routes/chat.js, v3.43.0), so it has none to list — each
 * with its identity dot, the same `identityDotClass(index)` every other view
 * paints that domain with.
 */
function domainFilterCfg() {
  const options = [{ value: '', label: 'All domains' }];
  state.domains.forEach((d, i) => {
    if (d.readonly === true) return;
    const name = d.displayName || d.slug;
    options.push({
      value: d.slug,
      label: name,
      html: '<span class="lb-opt-label chat-dom-opt"><span class="cur-sb-dot ' + identityDotClass(i) + '" aria-hidden="true"></span>' +
        escapeHtml(name) + '</span>',
    });
  });
  return {
    id: 'chat-domain-filter',
    options,
    value: state.domainFilter || '',
    ariaLabel: 'Show conversations from',
    triggerClass: 'lb-sm chat-list-filter-btn',
    onChange: (value) => {
      const next = typeof value === 'string' && value ? value : null;
      if (next === state.domainFilter) return;
      state.domainFilter = next;
      state.bulkNotice = null;
      loadConversationList(myMountToken, { q: state.searchQuery, sidebarOnly: true }).catch(reportAsyncActionFailure);
    },
  };
}

function conversationPaneBody() {
  if (state.domains.length === 0) return '';
  return conversationPaneHtml(listCtx());
}

/** Bind the pane: the builders' own wiring, with this view's actions. */
function wirePane(root) {
  wireConversationPane(root, {
    // `myMountToken` is read HERE, at the moment a real user event fires —
    // this node can only receive one while its own mount is live.
    onOpen: (id, domain) => selectConversation(id, myMountToken, { domain }).catch(reportAsyncActionFailure),
    onDelete: (id, domain, title) => deleteConversationRow(id, title, domain, myMountToken).catch(reportAsyncActionFailure),
    onToggle: (key, on) => {
      const want = on === null ? !state.selectedConvKeys.has(key) : on;
      if (want) state.selectedConvKeys.add(key); else state.selectedConvKeys.delete(key);
      renderSidebarConversationsOnly(myMountToken);
    },
    onToggleAll: (on) => {
      if (on) for (const c of state.conversations) state.selectedConvKeys.add(convKey(c.domain || state.activeDomain, c.id));
      else state.selectedConvKeys.clear();
      renderSidebarConversationsOnly(myMountToken);
    },
    onDeleteSelected: () => deleteSelectedConversations(myMountToken).catch(reportAsyncActionFailure),
    onSelectMode: (on) => {
      state.selectMode = !!on;
      state.selectedConvKeys.clear();
      state.bulkNotice = null;
      renderSidebarConversationsOnly(myMountToken);
      // Keyboard continuity: the control that replaced the one just pressed.
      const next = document.getElementById(on ? 'chat-select-done' : 'chat-select-btn');
      if (next) next.focus();
    },
    onAsk: askFilterTextInNewChat,
  }, { selectMode: state.selectMode });

  const allBox = root.querySelector('#chat-bulk-all');
  if (allBox) {
    const n = state.conversations.filter(c => state.selectedConvKeys.has(convKey(c.domain || state.activeDomain, c.id))).length;
    // Not expressible as an attribute — indeterminate is a DOM property only.
    allBox.indeterminate = n > 0 && n < state.conversations.length;
  }
  const host = root.querySelector('#chat-domain-filter-host');
  if (host) {
    const cfg = domainFilterCfg();
    host.innerHTML = renderListboxHtml(cfg);
    mountListbox(cfg);
  }
  // The rows just painted carry `data-age-at`; the clock's next second would
  // write the same words, so this only matters for a row that crossed a unit
  // between the build and now.
  tickAgesNow();
}

// ── "Ask this in a new chat" ─────────────────────────────────────────────
//
// The second half of the mistaken-composer fix. Relabelling the field stops
// the NEXT person typing a question into it; it does nothing for the person
// who already has. That reader is looking at "No conversations match “how do
// we stage the rollout”." — an answer that is technically correct and
// completely useless, because their question is right there, typed, and the
// app is pretending not to have seen it.
//
// So when the filter has matched nothing AND the text reads like something
// asked rather than something looked up, the empty state offers to move it
// where it belongs. It is an OFFER, never an automatic redirect: a filter that
// silently turned into a chat turn would spend money on a keystroke.

/**
 * PURE. Does this text read like a question or a sentence rather than a needle?
 *
 * Two signals, deliberately crude, because the cost of each error is not
 * symmetric: a false positive shows one extra button that nobody has to press,
 * a false negative leaves a typed question stranded. A trailing "?" is
 * unambiguous. Four or more words is the length at which a filter string stops
 * being plausible — real filter needles are one or two words ("graphql",
 * "ingest pipeline"); nobody filters a list by an eight-word phrase.
 *
 * NOT a question-word list ("how", "what", "why"): "the rollout plan we agreed
 * on Tuesday" is a sentence with no question word, and a word list would also
 * have to be maintained per language.
 */
function looksLikeAnAsk(text) {
  const t = String(text == null ? '' : text).trim();
  if (t === '') return false;
  if (t.endsWith('?')) return true;
  return t.split(/\s+/).filter(Boolean).length >= FILTER_ASK_MIN_WORDS;
}

/**
 * Is the offer live RIGHT NOW? The single source of that decision, read by the
 * renderer AND by the field's Enter handler, so the key and the button can
 * never disagree about whether there is anything to trigger.
 *
 * `state.conversations` is the server's answer for the last COMPLETED filter,
 * so "matched nothing" is a fact rather than a guess. A load error is not a
 * miss — the filter may well have matched and we simply could not fetch it —
 * so the offer stays down.
 */
function filterAskOffered() {
  if (state.domains.length === 0) return false;
  if (state.loadError) return false;
  if (state.conversations.length > 0) return false;
  return looksLikeAnAsk(state.searchQuery);
}

/**
 * The row itself. The label does NOT echo the typed text — partly because the
 * hint directly above it already quotes the query back, and partly because an
 * echo is one more place a hostile title-shaped string would have to be
 * escaped for no gain.
 */
function filterAskRowHtml() {
  if (!filterAskOffered()) return '';
  return (
    '<button type="button" class="chat-filter-ask" id="chat-filter-ask">' +
      icon('plus', 12) + ' Ask this in a new chat' +
    '</button>'
  );
}

/**
 * Clear the filter and show the real list again. Also the Escape
 * handler's whole body — Escape on a filter means "undo the filtering", which
 * is a repaint, not a navigation: the open conversation stays open.
 */
function clearConversationFilter() {
  if (state.searchQuery === '') return;
  state.searchQuery = '';
  cancelSearchTimer();
  const input = document.getElementById('chat-search-input');
  if (input) input.value = '';
  loadConversationList(myMountToken, {
    // Cleared one statement above, so this is a blank — passed explicitly all
    // the same, because scripts/test-next-chat-sidebar.js §9 requires every
    // list REFRESH to carry the active query and exempts exactly two call
    // sites by name. Being a third exemption is worse than passing '': the
    // rule it enforces (a refresh must never silently drop the user's filter)
    // is one this function must obey the moment it stops clearing first.
    q: state.searchQuery,
    sidebarOnly: true,
  }).catch(reportAsyncActionFailure);
}

/**
 * MOVE the typed text out of the filter and into the composer, in a new chat.
 *
 * MOVE, not copy: leaving it in the filter would leave the sidebar insisting
 * this domain has no conversations, one click after the user asked to go
 * somewhere else — and the reason (a filter they can no longer see the point
 * of) would be off in a field they have stopped looking at.
 *
 * It does NOT send. The text lands in the composer, focused, caret at the end,
 * exactly as if it had been typed there — which is the state the user believed
 * they were in. Sending on their behalf would spend money on a keystroke that
 * was, by construction, aimed at the wrong control.
 *
 * The new-chat reset is startNewChat's, called rather than reproduced: it is
 * the one place that knows what "a new chat" clears (activeConversationId,
 * thread, cancelNotice) and it already repaints and focuses the composer.
 */
function askFilterTextInNewChat() {
  const text = state.searchQuery.trim();
  if (text === '') return;
  state.searchQuery = '';
  cancelSearchTimer();
  startNewChat();
  const ta = document.getElementById('chat-input');
  if (ta) {
    ta.value = text;
    autosize(ta);
    // NO `ta.focus()` HERE, and its absence is a finding rather than an
    // omission. A first draft called it, and the mutation that deleted the
    // call left scripts/test-next-chat-filter.js §3 GREEN — because
    // startNewChat() above already ends in focusComposer(), which focuses this
    // very element. Two calls, one of which can never be the reason the
    // property holds. The redundancy is removed rather than kept and
    // annotated, and the property is now carried by the ONE call that has a
    // failing direction (deleting focusComposer's call from startNewChat reds
    // §3, which is how it is proven).
    //
    // The caret is NOT redundant: focusing a textarea that already has a value
    // does not reliably put the caret at the end, and position 0 in text the
    // user is about to continue typing is its own small defect.
    try { ta.selectionStart = ta.selectionEnd = text.length; } catch { /* not a real textarea */ }
  }
  // The list on screen is the FILTERED (empty) answer; the filter is now gone,
  // so refetch or the sidebar keeps claiming the domain is empty. Same `q`
  // reasoning as clearConversationFilter above.
  loadConversationList(myMountToken, {
    q: state.searchQuery,
    sidebarOnly: true,
  }).catch(reportAsyncActionFailure);
}

// ── Sidebar render entry points ──────────────────────────────────────────

// `token` is a value the CALLER captured (at onEnter, or at the top of its
// own async function before any await) — never re-derived from the live
// myMountToken here. See the H1 doc comment on myMountToken above.
function renderSidebar(token) {
  if (!isCurrentMount(token)) return;

  // REMOVED (cutover): a "Drop sources to ingest" zone used to sit here with
  // no drag, drop or click handler of any kind — its own label admitted it
  // was inert. A drop target that silently swallows a dragged PDF is worse
  // than no drop target: the user's first attempt fails with no feedback and
  // nothing tells them where the file went. Ingest is a rail destination one
  // click away and owns the whole upload surface (picker, batch queue, cost
  // estimate, cancel), so duplicating a half of it here buys nothing. If
  // drag-to-ingest is ever wired, it belongs in views/ingest.js's queue path,
  // not as a second entry point that has to stay in sync with it.

  // ADOPTED, with NO `info`. There is no prose to fold here — the sidebar
  // title carried nothing but the word "Chat" — so this is the structural half
  // of the fix rather than a copy change: a raw `<div class="sidebar-title">`
  // will accept a paragraph underneath it the moment someone adds one, and a
  // `<header class="tx-vh tx-vh-sidebar">` will not.
  //
  // "New chat" stays a SIBLING and does not move into `actionsHtml`. That slot
  // lays its members out in the title ROW (`.tx-vh-row` is a flex row), and
  // this button is deliberately `width: 100%` full-bleed — it is the sidebar's
  // primary action, not a control that belongs beside a title. Domains' Rename
  // / Delete / Ask are title-row controls and correctly use the slot; this is
  // the other case. The sidebar column is `display: flex; gap: 12px`
  // (shell.css) and `.tx-vh-sidebar` sets `margin: 0`, so the header is just
  // another flex item and the spacing is unchanged — the same arrangement
  // views/ingest.js already ships.
  setSidebar(
    renderViewHeader({ variant: 'sidebar', title: 'Chat' }) +
    '<button class="btn btn-primary chat-new-btn" id="chat-new-btn">' + icon('plus', 14) + ' New chat</button>' +
    (state.domains.length > 0
      // ── THIS FIELD IS A FILTER, AND IT HAD TO STOP LOOKING LIKE A COMPOSER ─
      // REPORTED: a power user typed a question into this box three times —
      // once in a live demo — and waited for an answer. `startNewChat` already
      // calls `focusComposer()`, so the caret was never in here by accident;
      // the cause is that a full-bleed text field sitting directly under the
      // sidebar's primary button, with a placeholder ending in an ellipsis
      // ("Search conversations…") that reads like the composer's own
      // ("Ask Articles…"), IS the most typeable-looking thing on the screen.
      //
      // Three changes, none of which touch what the field DOES: the verb
      // becomes "Filter" (what it does to a list, not what you do to a
      // corpus), the ellipsis goes (an ellipsis promises the sentence
      // continues elsewhere — a filter's does not), and the box takes the
      // kit's sunken-field treatment at --hit-min instead of a taller flat
      // one, so it reads as a well in the sidebar rather than as a raised
      // place to write.
      //
      // NOT SHRUNK BELOW --hit-min, which the brief's "compact height" would
      // have allowed: 30 -> 28 is the compact step this kit HAS (macOS's
      // default control target, and the floor sections 10 and 11 of
      // scripts/test-next-views-kit.js exist to hold). A 26px field would put
      // a real click target under that floor to buy two pixels, and two pixels
      // is not what was confusing anyone — the label and the treatment are.
      //
      // `aria-label` is not decoration here: the visible label for this field
      // is the placeholder, which assistive tech is entitled to ignore.
      ? '<div class="chat-search-wrap">' +
          '<span class="chat-search-icon">' + icon('search', 13) + '</span>' +
          '<input type="text" class="chat-search-input" id="chat-search-input" placeholder="Filter conversations" aria-label="Filter conversations" value="' + escapeHtml(state.searchQuery) + '">' +
        '</div>' +
        '<div class="chat-conv-pane">' + conversationPaneBody() + '</div>'
      // ── CUT: "No domains exist yet — nothing to chat with." ──────────────
      // It stated the same fact as the centre pane, WITH BOTH ON SCREEN AT
      // ONCE — the duplicated-copy class v3.20.0 deleted 712 characters of,
      // whose sharpest instance was Shared Brain's sidebar and centre sharing
      // 160 characters verbatim while both were visible.
      //
      // THE CENTRE COPY IS THE ONE THAT EARNS ITS PLACE, and it is not a
      // coin toss: `renderMain`'s zero-domain branch says the same thing and
      // then says what to do about it ("Create one in Domains") NEXT TO the
      // button that does it. The sidebar sentence carried the diagnosis with
      // no remedy, in the narrower column, below the very control it was
      // explaining. Cutting the half that only restates leaves the half that
      // also acts.
      //
      // WHAT THE SIDEBAR IS LEFT WITH — header, then a disabled New chat —
      // is not an unexplained dead control. Its reason is on screen, in the
      // dominant region, beside the fix. This is also EXACTLY what
      // views/ingest.js already renders in the same state: its `listBlock` is
      // `''` when there are no domains, so the shell's zero-domain sidebar
      // already has a precedent in this build and this is now consistent with
      // it rather than a new shape.
      : ''),
    token
  );

  const newChatBtn = document.getElementById('chat-new-btn');
  if (newChatBtn) newChatBtn.addEventListener('click', startNewChat);
  if (state.domains.length === 0) { newChatBtn && (newChatBtn.disabled = true); }

  const searchInput = document.getElementById('chat-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      // The list is refetched from the server (titles AND message bodies),
      // debounced — not filtered in place. Nothing repaints on this
      // keystroke, so the caret and the value the user is typing are
      // untouched until the answer arrives.
      scheduleConversationSearch(myMountToken);
    });
    // Enter and Escape, wired on the field itself so the keyboard reaches both
    // affordances the mouse has. Enter is deliberately gated on
    // filterAskOffered() — the SAME predicate that decides whether the action
    // row is on screen — rather than on the raw text: the row's condition
    // includes "no conversation matched", which is only known once the
    // debounced refetch has answered, so an Enter typed inside the 220 ms
    // window must fall through and do nothing rather than open a new chat on a
    // filter that was about to match something.
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && filterAskOffered()) {
        e.preventDefault();
        askFilterTextInNewChat();
        return;
      }
      if (e.key === 'Escape' && state.searchQuery !== '') {
        e.preventDefault();
        clearConversationFilter();
      }
    });
  }

  const pane = document.querySelector('.chat-conv-pane');
  if (pane) wirePane(pane);
}

// Lighter re-render used after a selection change, a search result, or a
// completed send that didn't change which conversation is active — rebuilds
// just the pane markup + rewires it, without touching the search input's own
// focus/caret (a full renderSidebar() would recreate the input and drop
// focus while the user is typing).
// H1 fix: this bypasses setSidebar() entirely (it patches an already-
// rendered subtree directly), so it needs its OWN isCurrentMount guard —
// setSidebar's built-in guard can't protect a call site that never calls it.
function renderSidebarConversationsOnly(token) {
  if (!isCurrentMount(token)) return;
  const paneEl = document.querySelector('.chat-conv-pane');
  if (!paneEl) { renderSidebar(token); return; }
  paneEl.innerHTML = conversationPaneBody();
  wirePane(paneEl);
}

// ═════════════════════════════════════════════════════════════════════════
// THE PROJECT PILL (v3.64.0)
//
// A SECOND GROUP in the left half of the scope bar, never a second domain
// selector: the domain group stays first, the spacer still separates the two
// halves, and the compile control still sits alone on the right. With a
// project pinned, the server ALSO reads that project's standing brief, its
// latest Handoff and its read-first Documents — as recorded data,
// framed by the memory layer's own injection defence. Nothing here writes.
// ═════════════════════════════════════════════════════════════════════════

/** The `{domain: project}` map, or `{}` on any failure. Never throws. */
function readPinnedProjects() {
  let raw = null;
  try { raw = localStorage.getItem(LS_PROJECT); } catch { /* ignore */ }
  if (typeof raw !== 'string' || !raw) return {};
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof k === 'string' && k && typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

/** Pin (or, with a null project, UNPIN) for one domain. Never throws. */
function writePinnedProject(domain, project) {
  const map = readPinnedProjects();
  if (project) map[domain] = project; else delete map[domain];
  const keys = Object.keys(map);
  // Insertion order is JS object order for string keys, so dropping from the
  // FRONT drops the least recently written — a re-pin deletes and re-adds.
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PINNED_PROJECTS))) delete map[k];
  try { localStorage.setItem(LS_PROJECT, JSON.stringify(map)); } catch { /* ignore */ }
}

/** The row for the pinned project, or null. */
function activeProjectRow() {
  if (!state.activeProject) return null;
  return state.projectRows.find(r => r.project === state.activeProject) || null;
}

/**
 * Load this domain's projects, then RECONCILE the pin against them.
 *
 * The reconciliation is the load-bearing half. A pinned project that has been
 * deleted, renamed, or that belongs to a domain this device no longer has
 * must stop being sent — the route would refuse it with a 400 and the user
 * would meet a refusal on a question that had nothing to do with projects.
 * Clearing it here means the worst case is a wiki-only answer, which is the
 * fail-safe direction for a retrieval widening.
 */
async function loadProjectsForDomain(domain, token) {
  if (!domain) return;
  state.projectsFor = domain;
  state.projectsState = 'loading';
  state.projectRows = [];
  // Restored BEFORE the fetch so a repaint in between shows the pill the user
  // left rather than flashing "no project" and back.
  // v3.76.0 (F13): a conversation being opened INTO this domain restores its
  // own project once its messages land (applyConversationProject); until
  // then the pin stands, exactly as before.
  if (state.activeProjectFrom !== 'conversation') state.activeProject = readPinnedProjects()[domain] || null;
  patchProjectPicker(token);
  let rows = [];
  let okState = 'ready';
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(domain) + '/projects');
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || 'Could not read this domain\'s projects.');
    rows = Array.isArray(data.projects) ? data.projects : [];
  } catch {
    okState = 'error';
  }
  // A domain switch (or a view teardown) during the fetch: this answer is
  // about a domain nobody is looking at any more.
  if (!isCurrentMount(token) || state.activeDomain !== domain) return;
  state.projectRows = rows;
  state.projectsFetchedAt = Date.now();
  state.projectsState = okState;
  if (state.activeProject && !rows.some(r => r.project === state.activeProject)) {
    state.activeProject = null;
    state.activeProjectScope = null;
    if (state.activeProjectFrom !== 'conversation') writePinnedProject(domain, null);
    state.projectLastUsed = null;
  }
  state.projectKnowledge = null;
  patchProjectPicker(token);
  // AFTER the reconciliation, never before: a pin that has just been cleared
  // because the project is gone must not then be read about. This is the one
  // hook that covers the per-device pin restored on mount AND the pin seeded
  // by `consumeChatScopeRequest()`, because both settle here.
  if (state.activeProject) {
    ensureProjectKnowledge(domain, state.activeProject, token).catch(() => {});
  }
}

/** Commit a pick. `''` means "no project". */
function selectChatProject(value) {
  const next = typeof value === 'string' && value ? value : null;
  if (next === state.activeProject) return;
  state.activeProject = next;
  // The user's own pick is a preference again: it is written to the pin
  // below, as it always was, whatever the pill showed before.
  state.activeProjectFrom = 'pin';
  // A scope names a work-stream INSIDE a project, so it means nothing once
  // the project changes — and a figure measured for the PREVIOUS project
  // would be a wrong reading about the new one. A stale number beside a fresh
  // pill is worse than none.
  state.activeProjectScope = null;
  state.projectLastUsed = null;
  writePinnedProject(state.activeDomain, next);
  // The previous project's domains are a fact about a project that is no
  // longer pinned; dropped here so no repaint between now and the answer can
  // paint them beside the new name.
  state.projectKnowledge = null;
  patchProjectPicker(myMountToken);
  // UN-PINNING READS NOTHING. "No project" has no knowledge domains, and a
  // request that can only answer about nothing is a request not worth making.
  if (next) ensureProjectKnowledge(state.activeDomain, next, myMountToken).catch(() => {});
}

/**
 * Per-MOUNT cache of a project's knowledge domains, keyed by mount token as
 * well as (domain, project).
 *
 * The token is in the key rather than in a reset hook, deliberately: leaving
 * and re-entering Chat mints a new token, so the next read is a MISS and the
 * answer is fresh. A project whose knowledge domains were just edited in
 * Context is therefore correct the moment the user comes back, and no reset
 * site anywhere has to remember this Map exists.
 */
const projectKnowledgeCache = new Map();
const MAX_PROJECT_KNOWLEDGE_CACHE = 24;

/**
 * Read the pinned project's knowledge domains, ONCE per project per mount.
 *
 * ── WHY THIS ONLY DISCLOSES, AND DOES NOT MOVE THE CHIPS ─────────────────
 * The v3.65.0 design record says "Chat pre-selects those domain chips when the
 * project is pinned (retrieval across them, the existing multi-domain scope)".
 * THERE IS NO MULTI-DOMAIN SCOPE IN CHAT, and the parenthetical is the only
 * part of that sentence this file can act on. Three facts, each of which alone
 * settles it:
 *
 *  1. This view is single-select by an explicit product decision recorded at
 *     the top of this file: one active domain, `POST /api/chat/:domain`,
 *     `sendMessage(domain, …)` → `readWikiPages(domain)`, conversations stored
 *     under that one domain. A chip selection cannot widen retrieval, so two
 *     lit chips would claim a reach the answer does not have.
 *  2. `switchDomain` CLEARS the pin ("Projects belong to a DOMAIN … the old
 *     domain's rows, its pin and its last measured reading are all about
 *     something the user has just left"), and `loadProjectsForDomain` then
 *     reconciles the pin against the NEW domain's rows. A project lives in one
 *     domain, so moving the chips to another of its knowledge domains UNPINS
 *     THE PROJECT THAT ASKED FOR THE MOVE. The feature would cancel itself.
 *  3. Even with the pin forced to survive, `src/routes/chat.js` resolves the
 *     project against the URL's `:domain` and answers 400 `project_not_found`
 *     BEFORE the stream opens — so the first question after the move would be
 *     refused.
 *
 * (2) and (3) are executed, not read: scripts/test-next-chat-scopebar.js §15
 * drives the real `switchDomain` and watches the pin go, and §15c drives the
 * real route predicate. Making this work needs a project pin that is not keyed
 * by domain AND a route that resolves a project across domains — both outside
 * this package. Until then the honest rendering is to SAY where the project's
 * knowledge lives, mark those chips as belonging to it, and leave the one lit
 * chip meaning exactly what it has always meant: the wiki this answer reads.
 *
 * Never throws, never blocks a turn: a failed read records `error` and the
 * footer says the domains could not be read rather than inventing a list.
 */
async function ensureProjectKnowledge(domain, project, token) {
  if (!domain || !project) { state.projectKnowledge = null; return; }
  const key = token + '\u0000' + domain + '\u0000' + project;
  if (projectKnowledgeCache.has(key)) {
    state.projectKnowledge = projectKnowledgeCache.get(key);
    patchProjectPicker(token);
      return;
  }
  let rec;
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(domain) + '/' + encodeURIComponent(project));
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error('unreadable');
    // READ DEFENSIVELY. `knowledgeDomains` is additive (v3.65.0): an older
    // server answers this route without it, and an absent list must mean "not
    // told", never an empty one — an empty list rendered as "no domains" would
    // be a claim about a project whose knowledge is in fact its own domain.
    const list = Array.isArray(data.knowledgeDomains)
      ? data.knowledgeDomains.filter(d => typeof d === 'string' && d)
      : null;
    rec = list === null ? null : {
      project,
      domains: list,
      defaulted: data.knowledgeDomainsDefaulted === true,
      // NAMED BUT NOT INSTALLED. The store deliberately does not probe the
      // domains folder on a read (its own report records why), so the list can
      // name a domain this machine has deleted or never had. Computed here
      // against the domain list Chat already holds — no extra request.
      missing: list.filter(d => !state.domains.some(x => x.slug === d)),
      error: false,
    };
  } catch {
    rec = { project, domains: [], defaulted: false, missing: [], error: true };
  }
  // The pin or the domain moved while this was in flight: this answer is about
  // something nobody is looking at.
  if (!isCurrentMount(token) || state.activeDomain !== domain || state.activeProject !== project) return;
  if (projectKnowledgeCache.size >= MAX_PROJECT_KNOWLEDGE_CACHE) projectKnowledgeCache.clear();
  projectKnowledgeCache.set(key, rec);
  state.projectKnowledge = rec;
  patchProjectPicker(token);
}


/**
 * A project row's age NOW, in seconds, or null when it has no saves.
 *
 * `ageSeconds` was measured by the server at fetch time and never advances on
 * its own — which is how the picker came to say "saved 4 min ago" an hour
 * later (truth audit F3). The fetch instant is recorded beside the rows, so
 * the age is the server's reading plus the time since.
 */
function projectAgeSeconds(row, now) {
  if (!row || typeof row.ageSeconds !== 'number' || !Number.isFinite(row.ageSeconds) || row.ageSeconds < 0) return null;
  const t = typeof now === 'number' ? now : Date.now();
  const since = state.projectsFetchedAt > 0 ? Math.max(0, (t - state.projectsFetchedAt) / 1000) : 0;
  return row.ageSeconds + since;
}

/** The ISO instant of a row's last save, derived from the same two facts, for
 *  the shared ticker's `data-age-at`. '' when there is no save. */
function projectSavedAtIso(row) {
  const age = projectAgeSeconds(row, state.projectsFetchedAt || Date.now());
  if (age === null) return '';
  const at = (state.projectsFetchedAt || Date.now()) - row.ageSeconds * 1000;
  return Number.isFinite(at) ? new Date(at).toISOString() : '';
}

/**
 * The cfg the MOUNTED project picker closed over, or null when this domain
 * renders one of the three non-picker states.
 *
 * WHY A MODULE-LEVEL HANDLE EXISTS AT ALL (v3.65.0). The picker's footer is
 * `cfg.footHtml`, and shared/listbox.js reads that field when it BUILDS the
 * menu (on open and on `setOptions`) — not once at mount. So a reading that
 * changes while the menu is shut has exactly one place to be written: onto
 * the same cfg object the instance holds. See `patchProjectFooter`.
 */
let projectLbCfg = null;

function projectListboxCfg() {
  const now = Date.now();
  const options = [
    { value: '', label: 'No project' },
    ...state.projectRows.map(r => {
      const iso = projectSavedAtIso(r);
      const words = iso ? ageWordsFor(iso, now) : null;
      return {
        value: r.project,
        label: r.project,
        detail: words || 'no saves',
        // The age TICKS while the menu is open (v3.72.0, F3): the option
        // carries `data-age-at`, and shared/age-ticker.js rewrites the words
        // in place. Everything interpolated is escaped.
        html: '<span class="lb-opt-label">' + escapeHtml(r.project) + '</span>' +
          (iso
            ? '<span class="lb-opt-detail chat-opt-figure" data-age-at="' + escapeHtml(iso) + '" data-age-text>' + escapeHtml(words || '') + '</span>'
            : '<span class="lb-opt-detail chat-opt-figure">no saves</span>'),
      };
    }),
  ];
  const cfg = {
    id: 'chat-project-lb',
    options,
    value: state.activeProject || '',
    placeholder: 'No project',
    // Per QUESTION, not per chat (M2): the project is sent with each turn and
    // may change between two questions of one conversation.
    ariaLabel: 'Project for your next question',
    triggerClass: 'lb-sm chat-pill chat-project-pill',
    rootClass: 'chat-project-lb-root',
    prefer: 'up',
    footHtml: projectFootHtml(),
    onChange: selectChatProject,
  };
  projectLbCfg = cfg;
  return cfg;
}

/**
 * The picker's footer: what the PINNED project is, in the one place the app
 * already has for a reading — `shared/text.js`'s `renderReadout`.
 *
 * The "saved … ago" is LIVE (v3.72.0, F3): the readout is wrapped in an
 * element carrying `data-age-at` + `data-age-prefix="saved"`, and the shared
 * ticker rewrites the value's words once a second (`.tx-readout-value` is a
 * named target — renderReadout escapes its own value, so no element of this
 * view's can sit around the words).
 *
 * `markHtml` is `renderReadout`'s ONE trusted field; it carries the shared
 * freshness dot, and the age is in WORDS beside it, so colour is never the
 * only carrier. The dot's tier is cut at paint; the words move every second.
 */
function projectFootHtml() {
  const row = activeProjectRow();
  if (!row) return '';
  const age = projectAgeSeconds(row);
  const iso = projectSavedAtIso(row);
  const group = renderReadoutGroup([
    {
      label: row.project,
      value: age === null ? 'no saves yet' : 'saved ' + formatAge(age),
      markHtml: '<span class="fresh-dot fresh-' + freshnessTier(age) + '" aria-hidden="true"></span>',
      provenance: projectFigureText(state.projectLastUsed),
    },
    projectDocumentsReadout(state.projectLastUsed),
    projectKnowledgeReadout(),
  ]);
  return iso
    ? '<div class="chat-project-foot" data-age-at="' + escapeHtml(iso) + '" data-age-prefix="saved">' + group + '</div>'
    : group;
}

/**
 * A character count, short: `18.4k`, `40k`, `812`. Mono is the readout's own
 * face, so the figure stays narrow enough for a picker footer.
 *
 * ONE formatter for both of the footer's character figures (the documents
 * cell and the whole-block provenance), so the two cannot disagree about what
 * "k" means — thousands of CHARACTERS, never kilobytes (v3.66.0: the old
 * `chars / 1024 + ' KB'` called thousands of characters kilobytes).
 */
function formatCharsShort(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return String(Math.round(n));
  const k = Math.round(n / 100) / 10;
  return (Number.isInteger(k) ? String(k) : k.toFixed(1)) + 'k';
}

/**
 * How many documents the LAST TURN's project read had to leave out, parsed
 * from the server's own disclosure notes (`projectOmissionNotes` in
 * src/brain/chat.js). Only the two sentences that are about the DOCUMENT
 * budget count: "N … did not fit the reading budget…" and "A … was cut at the
 * reading budget." Anything else in
 * `notes` (a stale mirror, a trimmed handoff) is not about this bar.
 *
 * Returns `{ omitted, cut }`, both zero when nothing was left out.
 */
function projectDocumentOmissions(notes) {
  let omitted = 0;
  let cut = 0;
  for (const n of (Array.isArray(notes) ? notes : [])) {
    if (typeof n !== 'string') continue;
    // Keyed on the budget clause, not on the server's noun for a document —
    // that noun is the store's, and this view's copy never repeats it.
    const m = n.match(/^(\d+) [^.]*? did not fit the reading budget/);
    if (m) omitted += Number(m[1]);
    else if (/^A [^.]*? was cut at the reading budget/.test(n)) cut += 1;
  }
  return { omitted, cut };
}

/**
 * DOCUMENTS READ vs THE 40,000-CHARACTER PROJECT BUDGET (P4, v3.66.0).
 *
 * THE NUMERATOR IS `documentChars`, NOT `chars`. `chars` is the WHOLE project
 * block (framing, brief, handoff, journal AND documents); the budget
 * (`budgetChars`, PROJECT_CONTEXT_BUDGET_CHARS server-side) governs DOCUMENT
 * BODIES ONLY. A bar of `chars ÷ budgetChars` would pass 100% with nothing
 * cut — a false denominator. `documentChars` is what the budget is about.
 *
 * NEVER DANGER: the server enforces the budget by OMISSION, so the numerator
 * cannot exceed it; `renderDepthCell` only turns danger on `amount > budget`,
 * which this reading cannot produce. What CAN happen — a document left out —
 * is said in WORDS in the provenance line, never as a tone.
 *
 * ABSENT IS NOT ZERO: a server that did not send `documentChars` (an older
 * build, or no project read) renders NO readout, never a "0". A real zero —
 * the project was read and held no documents — is a measured 0 and renders.
 *
 * The depth cell rides in `renderReadout`'s ONE trusted slot (`markHtml`),
 * which the kit escapes nothing into on our behalf: `renderDepthCell` escapes
 * its own value and label. The readout's escaped `value` then carries the
 * denominator in words, "of 40k characters", so the reading is complete for
 * a screen reader and for anyone who cannot see the bar.
 */
function projectDocumentsReadout(used) {
  // INDEX ONLY (v3.67.0). `budgetChars` is now the EFFECTIVE budget — the
  // owner's reading budget under Chat's 40,000-character ceiling
  // (src/brain/chat.js passes `maxBytesCeiling`), so this reading follows the
  // owner with no arithmetic here. At 0 the owner chose "Index only": Chat
  // sends no document text at all and does not fetch any by keyword. There is
  // no denominator to draw a bar against — a bar of 0 ÷ 0 is not a reading —
  // so the fact is said in words, with the reason, and no bar.
  if (used && used.budgetChars === 0) {
    return { label: 'Documents', value: "index only: this project's reading budget" };
  }
  if (!used || !Number.isFinite(used.documentChars) || !Number.isFinite(used.budgetChars) || used.budgetChars <= 0) {
    return { value: null };
  }
  const amount = used.documentChars;
  const budget = used.budgetChars;
  const { omitted, cut } = projectDocumentOmissions(used.notes);
  const words = [];
  if (omitted > 0) words.push(omitted + (omitted === 1 ? ' document' : ' documents') + ' left out');
  if (cut > 0) words.push(cut === 1 ? '1 document cut short' : cut + ' documents cut short');
  return {
    label: 'Documents',
    markHtml: renderDepthCell({
      value: formatCharsShort(amount),
      amount,
      budget,
      label: amount.toLocaleString('en-US') + ' of ' + budget.toLocaleString('en-US') + ' characters of documents',
    }),
    value: 'of ' + formatCharsShort(budget) + ' characters',
    provenance: words.join(' \u00b7 '),
  };
}

/**
 * WHERE THIS PROJECT'S KNOWLEDGE LIVES — a second readout, not a second clause
 * on the first.
 *
 * TWO READOUTS RATHER THAN ONE, and the reason is this file's own most
 * expensive recorded defect: `[Compile to Wiki] 1,406 pages in scope` read as
 * one phrase because two unrelated facts were adjacent, and a user did not
 * press the button because of it. "saved 4 min ago · 5k characters read last turn" is
 * about THIS CONVERSATION's last turn; "research · business" is about the
 * PROJECT, and is true whether or not anyone ever asks a question. Joined by a
 * middot in one line they would read as one sentence about the turn.
 * `renderReadoutGroup` is the kit's own answer for exactly this — several
 * readings as one cluster, each keeping its own label.
 *
 * Returns a value `renderReadoutGroup` drops (`value: null`) when there is
 * nothing measured, so "not told" never renders as an empty row.
 */
function projectKnowledgeReadout() {
  const k = state.projectKnowledge;
  if (!k || k.project !== state.activeProject) return { value: null };
  if (k.error) {
    return { label: 'Knowledge', value: 'could not be read', provenance: 'the project answered, its domains did not' };
  }
  if (!Array.isArray(k.domains) || k.domains.length === 0) return { value: null };
  const shown = k.domains.slice(0, 3).join(' \u00b7 ');
  const more = k.domains.length - 3;
  // WHAT THIS CHAT IS ACTUALLY READING, said in the same breath as where the
  // project's knowledge lives — because on this view they can differ and the
  // difference is invisible otherwise. A count alone ("reads 2 domains") would
  // be read as a claim about the answer; naming the domains, and naming the one
  // the chips are on, is the same fact without the claim.
  const parts = [];
  parts.push(k.defaulted ? 'the default \u2014 nobody has chosen' : 'chosen for this project');
  // v3.71.1: this line carries the state sentence the ⓘ used to append —
  // the project's knowledge lives elsewhere and a chat reads only the domain
  // its chips select — so it is said here, where the reading is, not folded.
  // Gated on a CHOSEN list, as the old panel note was: a defaulted project's
  // knowledge IS its own domain, so "lives in another domain" would be false.
  if (!k.domains.includes(state.activeDomain)) {
    parts.push(k.defaulted
      ? 'this chat is reading ' + state.activeDomain
      : 'its knowledge lives in another domain \u2014 this chat reads only ' + state.activeDomain);
  }
  if (k.missing.length) {
    parts.push(k.missing.length === 1
      ? k.missing[0] + ' is not on this computer'
      : k.missing.length + ' are not on this computer');
  }
  return {
    label: k.domains.length === 1 ? 'Knowledge' : k.domains.length + ' domains',
    value: shown + (more > 0 ? ' +' + more : ''),
    provenance: parts.join(' \u00b7 '),
  };
}

/**
 * Re-publish the footer after a turn has measured something.
 *
 * TWO HALVES, AND THE SECOND ONE IS THE GUARD THE DESIGN NAMES. The footer
 * lives in `.lb-menu`, which shared/listbox.js creates on <body> when the
 * picker is opened and REMOVES when it closes — so for most of a
 * conversation's life there is no node to patch, and a patch-only update
 * would silently stop updating the moment the menu was shut. Writing
 * `cfg.footHtml` is therefore the PRIMARY half: it is what the next menu
 * build reads. The DOM write is the secondary half, for the rarer case where
 * an answer lands while the menu happens to be open.
 *
 * The menu's id is `cfg.id + '-menu'` — the kit's own public contract (it is
 * what the trigger's `aria-controls` names), not a private reach.
 *
 * STILL NOT A REPAINT: `patchProjectPicker(...)` here would rebuild the picker
 * and close a menu the user has open, to move one figure.
 */
function patchProjectFooter() {
  if (!projectLbCfg) return;
  projectLbCfg.footHtml = projectFootHtml();
  const menu = document.getElementById('chat-project-lb-menu');
  const foot = menu ? menu.querySelector('.lb-foot') : null;
  if (foot) foot.innerHTML = projectLbCfg.footHtml;
}

/**
 * The "whole block 12.3k characters read last turn" phrase, or '' when
 * nothing was measured. (It said "12 KB" through v3.65.3 — see the body.)
 *
 * ONE producer, called from the footer builder AND — through it — from the
 * post-turn update, so the figure a menu build prints and the figure a live
 * menu is given cannot disagree. Two hand-written copies of one format string
 * is this repo's most reliably repeated defect.
 *
 * ── IT LOST ITS LEADING SEPARATOR (v3.65.0) ─────────────────────────────
 * It used to return " · 12 KB read", because it was appended inside the bar's
 * one-line readout and had to punctuate itself. It now fills `renderReadout`'s
 * `provenance` slot, which is its own element with its own spacing — a
 * separator baked into the string would print a stray middot with nothing in
 * front of it. The words "last turn" join it here for the same reason: in the
 * bar the neighbouring "saved 4 min ago" said which turn; in the footer the
 * provenance line stands alone and must say so itself.
 *
 * The SERVER's own measurement of what went into the prompt. Never computed
 * here: the client cannot know what the store returned, and an estimate
 * beside a real number is the dead-data shape this file already refuses for
 * `usage`.
 */
function projectFigureText(used) {
  if (!used || !Number.isFinite(used.chars)) return '';
  // CHARACTERS, never KB (v3.66.0). `chars` is a UTF-16 length; dividing it by
  // 1024 and printing "KB" called thousands of characters kilobytes. It is the
  // WHOLE project block, so it says so — the documents share of it, against
  // its own budget, is the `Documents` readout beside it.
  return 'whole block ' + formatCharsShort(used.chars) + ' characters read last turn';
}

/**
 * The project control on the composer. Three non-picker states, told apart
 * rather than merged: not-asked-yet, asked-and-this-domain-has-none, and a
 * read that failed; otherwise the picker.
 *
 * The retired ⓘ (`chat-project-info`) is not here: its points are in the page
 * ⓘ (`chat.page`), and a mark inside the composer strip would put a panel
 * where it takes the thread's height — the M2 complaint.
 */
function projectPickerHtml() {
  const loading = state.projectsState === 'idle' || state.projectsState === 'loading';
  const none = state.projectsState === 'ready' && state.projectRows.length === 0;

  // Dropped FIRST, so the non-picker branches leave no handle on a cfg whose
  // trigger is about to leave the document.
  projectLbCfg = null;

  if (loading) return '<span class="chat-project-note">Reading projects…</span>';
  // Short, because it sits among the composer's pills; still the fact —
  // this domain holds no projects — and never "none" for a failed read.
  if (none) return '<span class="chat-project-note">No projects yet</span>';
  if (state.projectsState === 'error') return '<span class="chat-project-note">Projects could not be read.</span>';
  const cfg = projectListboxCfg();
  pendingListboxes.push(cfg);
  return renderListboxHtml(cfg);
}

/**
 * Give a mounted pill its leading glyph and word.
 *
 * shared/listbox.js renders a trigger's TEXT only (and rewrites only its
 * `[data-lb-text]` child on a pick), so a view that wants a mark on the pill
 * adds it beside that child once the trigger is in the document. Idempotent.
 * `markClass` is one of this file's own literal class names; the word is a
 * literal too, and `aria-hidden` — the trigger's aria-label already names it.
 */
function decoratePill(id, markClass, word) {
  const trigger = document.getElementById(id);
  if (!trigger || trigger.querySelector('.chat-pill-lead')) return;
  trigger.insertAdjacentHTML('afterbegin',
    '<span class="chat-pill-lead" aria-hidden="true">' +
      (markClass ? '<span class="' + markClass + '"></span>' : '') +
      (word ? '<span class="chat-pill-k">' + escapeHtml(word) + '</span>' : '') +
    '</span>');
}

/**
 * Repaint the project control ALONE.
 *
 * Never `renderMain()`: that destroys the thread, the draft and the scroll
 * position, and this control changes on a background fetch the user did not
 * ask for.
 */
let projectLbApi = null;

function patchProjectPicker(token) {
  if (!isCurrentMount(token)) return;
  const host = document.getElementById('chat-project-host');
  if (!host) return;
  const menuOpen = !!document.getElementById('chat-project-lb-menu');
  if (menuOpen) closeAllListboxes();
  const queued = pendingListboxes.length;
  host.innerHTML = projectPickerHtml();
  projectLbApi = null;
  for (const cfg of pendingListboxes.slice(queued)) {
    const api = mountListbox(cfg);
    if (cfg.id === 'chat-project-lb') projectLbApi = api;
  }
  pendingListboxes.length = queued;
  decoratePill('chat-project-lb', 'chat-pmark', 'Project');
}

/**
 * Re-read this domain's projects after an answer (F3), QUIETLY.
 *
 * A save an agent made through the MCP while Chat stayed open was never seen:
 * the rows were read on mount and on a domain switch only. This refreshes
 * the rows and their fetch instant, then updates the picker's cfg IN PLACE
 * (the menu reads it on open) rather than repainting — so a picker the user
 * has open stays open. Only a pin whose project has gone repaints, because
 * the trigger's own label would otherwise name a project that is not sent.
 */
async function refreshProjectsQuietly(domain, token) {
  if (!domain || domain !== state.activeDomain) return;
  let rows;
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(domain) + '/projects');
    const data = await res.json();
    if (!res.ok || data.ok === false) return;
    rows = Array.isArray(data.projects) ? data.projects : [];
  } catch { return; }
  if (!isCurrentMount(token) || state.activeDomain !== domain) return;
  const hadPicker = state.projectsState === 'ready' && state.projectRows.length > 0;
  state.projectRows = rows;
  state.projectsFetchedAt = Date.now();
  state.projectsState = 'ready';
  const pinGone = !!state.activeProject && !rows.some(r => r.project === state.activeProject);
  if (pinGone) {
    state.activeProject = null;
    state.activeProjectScope = null;
    if (state.activeProjectFrom !== 'conversation') writePinnedProject(domain, null);
    state.projectLastUsed = null;
  }
  if (pinGone || !hadPicker || rows.length === 0 || !projectLbCfg) { patchProjectPicker(token); return; }
  // The mounted instance closed over ITS cfg object and normalised its
  // options at mount, so the fresh rows go in through the kit's own
  // `setOptions` (an open menu is rebuilt in place, not closed) and the
  // footer onto the same cfg object the next menu build reads.
  const mounted = projectLbCfg;
  const fresh = projectListboxCfg();
  projectLbCfg = mounted;
  mounted.options = fresh.options;
  mounted.footHtml = fresh.footHtml;
  if (projectLbApi) projectLbApi.setOptions(fresh.options);
}

function renderMain(token) {
  if (!isCurrentMount(token)) return;

  // Chat has no domain-creation UI of its own — Domains owns that. A
  // zero-domain user is routed there rather than shown a duplicate create
  // flow; see resolveBootDomain()'s own comment.
  // Never assert "you have no domains" before boot() has answered. Until
  // then the chat chrome is painted with an empty body — and a loader only
  // if the gate fires.
  // WRITTEN OUT AT EACH SITE rather than hoisted into a builder: the
  // adjacency arm of scripts/test-next-view-header.js §9b reads what sits
  // next to a `renderViewHeader(` call, and a helper name is not that call.
  // `infoId` is EXPLICIT and DIFFERENT at each site — the calls resolve to
  // the same density, so a derived id could collide (§8's guard).
  if (!state.booted && !state.loadError && state.domains.length === 0) {
    setMain(
      renderViewHeader({ eyebrow: 'ask your wiki', title: 'Chat', info: CHAT_INFO, infoHtml: true, infoId: 'tx-vh-info-chat-boot' }) +
      gatedLoader(bootGate, 'Loading…'),
      token
    );
    return;
  }

  // ── THE EMPTY STATE IS A CARD, NOT A PARAGRAPH UNDER THE TITLE ──────────
  // The message states why the view CANNOT be used at all, next to the one
  // button that unblocks it — never folded behind the ⓘ. "Create one in
  // Domains" is pinned by scripts/test-next-chat-compile.js §5: Chat has no
  // domain-creation surface of its own and the copy says where it is.
  if (state.domains.length === 0) {
    setMain(
      renderViewHeader({ eyebrow: 'ask your wiki', title: 'Chat', info: CHAT_INFO, infoHtml: true, infoId: 'tx-vh-info-chat-empty' }) +
      emptyCard({
        title: 'Nothing to chat with yet',
        body: 'Chat needs at least one domain to talk to. Create one in Domains.',
        actionHtml: '<button class="btn btn-primary" id="chat-goto-domains">' +
          icon('plus', 13) + ' Go to Domains</button>',
      }),
      token
    );
    const btn = document.getElementById('chat-goto-domains');
    if (btn) btn.addEventListener('click', () => navigate('domains'));
    return;
  }

  const active = state.domains.find(d => d.slug === state.activeDomain) || state.domains[0];

  // ── A REAL VIEW HEADER, AND THE SCOPE MOVED TO THE COMPOSER (v3.72.0) ───
  // Maintainer decision M2. The sticky scope bar packed six unrelated things
  // into one wrapping row — domain chips (a navigation control that looked
  // like a filter), a page count, the PROJECT eyebrow with its picker and ⓘ,
  // Compile and its caption — and an open ⓘ took the thread's height. Now:
  //   · the view header, like every other view: eyebrow, the conversation's
  //     title, the page ⓘ (C1: the populated view had none), Compile in the
  //     action slot, and ONE meta line of live facts under it;
  //   · every control that changes THE NEXT ANSWER on the composer: domain
  //     (fixed once a conversation exists), project, length, model.
  // The header is not sticky, and its ⓘ panel is laid OVER the thread
  // (chat.css `.chat-head .tx-vh-panel`), so opening it never pushes the
  // thread (M2) — the same button, panel and delegated behaviour as every
  // other ⓘ (shared/text.js), only positioned.
  setMain(
    '<div class="chat-view">' +
      '<div class="chat-head" id="chat-head">' +
        renderViewHeader({
          eyebrow: 'ask your wiki',
          title: chatHeadTitle(),
          info: CHAT_INFO,
          infoHtml: true,
          infoId: 'tx-vh-info-chat',
          actionsHtml: compileControlHtml(),
        }) +
        '<div class="chat-head-meta" id="chat-head-meta">' + chatHeadMetaHtml() + '</div>' +
        // Compile's no-key run line, UNDER the header rather than inside its
        // action slot: the header drops that slot whole when it meets a <p>
        // (shared/text.js safeActions), and the line is one. '' in every
        // other state; its id is what the button's aria-describedby names.
        '<div class="chat-head-runline" id="chat-compile-keyline-host">' + (compileControlHtml() ? (state.compileKeyLineHtml || '') : '') + '</div>' +
      '</div>' +
      '<div class="chat-thread" id="chat-thread"></div>' +
      renderComposerHtml(active) +
    '</div>',
    token
  );

  // startCompile, NOT runCompile: the estimate-then-confirm gate is the entry
  // point and runCompile is unreachable from the UI without passing it.
  document.getElementById('chat-compile-btn')?.addEventListener('click', () => startCompile().catch(reportAsyncActionFailure));
  // The one-click route out of the retired-model notice.
  document.getElementById('chat-model-gone-settings')?.addEventListener('click', () => navigate('settings'));

  // ONE delegated listener for every citation marker and Sources chip, bound
  // to the thread element this paint just created (renderThreadOnly only
  // replaces its innerHTML, so this cannot stack).
  document.getElementById('chat-thread')?.addEventListener('click', onThreadCitationClick);

  wireComposer();
  renderThreadOnly(token);
  tickAgesNow();
}

/** The open conversation's row in the list, or null (a new chat, a mirror's
 *  unlisted conversation, or a row a search filtered out). */
function activeConversationRow() {
  if (!state.activeConversationId) return null;
  return state.conversations.find(c => c.id === state.activeConversationId &&
    (c.domain || state.activeDomain) === state.activeDomain) || null;
}

/**
 * The header's title: the conversation's own title, as the list shows it.
 * A conversation not in the list (a Shared Brain mirror's is never written,
 * or a search hid the row) takes the server's rule on its first question —
 * brain/chat.js titles a conversation with its first message, cut at 57
 * characters past 60 — so the two can never name one thread differently.
 */
function chatHeadTitle() {
  if (!state.activeConversationId) return 'New chat';
  const row = activeConversationRow();
  if (row && row.title) return row.title;
  const first = state.thread.find(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  if (!first) return 'Conversation';
  const t = first.content;
  return t.length > 60 ? t.slice(0, 57).trimEnd() + '…' : t.trim();
}

/**
 * The project the conversation's LAST ANSWER recorded, or null. A message
 * from before v3.72 carries no `project` key and says nothing — never a
 * guess from the pin, which is about the NEXT question, not the last one.
 */
function lastAnswerProject() {
  for (let i = state.thread.length - 1; i >= 0; i--) {
    const m = state.thread[i];
    if (!m || m.role !== 'assistant' || m.error) continue;
    return typeof m.project === 'string' && m.project ? m.project : null;
  }
  return null;
}

/**
 * The meta line under the title — every item a live fact:
 *   ● Articles · 3,428 pages · 3 questions · 3 answers · ▢ curator · started 12 min ago
 * The domain is its identity dot AND its name. The page count is re-patched
 * after a compile writes pages (F1, `patchChatHead`). The questions and
 * answers are the thread on screen — the same counts Compile takes as input,
 * so they stand in for the caption the old bar carried. The project is the
 * one the last answer recorded. The age is the conversation's START, ticking,
 * and says "started" so it is never read as last use.
 */
function chatHeadMetaHtml() {
  const i = state.domains.findIndex(d => d.slug === state.activeDomain);
  const d = i >= 0 ? state.domains[i] : null;
  if (!d) return '';
  const sep = '<span class="chat-head-sep" aria-hidden="true">·</span>';
  const pages = Number.isFinite(d.pageCount) ? d.pageCount : 0;
  const parts = [
    '<span class="chat-head-dom"><span class="cur-sb-dot ' + identityDotClass(i) + '" aria-hidden="true"></span>' +
      escapeHtml(d.displayName || d.slug) + '</span>',
    '<span class="chat-head-pages" id="chat-head-pages">' + pages.toLocaleString() + ' page' + (pages === 1 ? '' : 's') + '</span>',
  ];
  if (state.activeConversationId && state.thread.length) {
    const { questions, answers } = compileTurnCounts();
    parts.push('<span class="chat-head-turns" id="chat-head-turns">' + escapeHtml(turnCountsText(questions, answers)) + '</span>');
  }
  const project = lastAnswerProject();
  if (project) {
    parts.push('<span class="chat-head-project"><span class="chat-pmark" aria-hidden="true"></span>' + escapeHtml(project) + '</span>');
  }
  const row = activeConversationRow();
  const started = row && typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt)) ? row.createdAt : null;
  if (started) {
    parts.push('<span class="chat-head-age" data-age-at="' + escapeHtml(started) + '" data-age-prefix="started" data-age-text>' +
      escapeHtml(ageWordsFor(started, Date.now(), 'started') || '') + '</span>');
  }
  return parts.join(sep);
}

/** "3 questions · 3 answers", with the caption's "no answers yet". */
function turnCountsText(questions, answers) {
  return questions + ' question' + (questions === 1 ? '' : 's') + ' · ' +
    (answers === 0 ? 'no answers yet' : answers + ' answer' + (answers === 1 ? '' : 's'));
}

/**
 * Re-state the header's live facts IN PLACE — the title, the meta line and
 * the Compile caption — never by repainting the header, which would close its
 * open ⓘ and drop focus from Compile. Called after a turn, and after a
 * compile refreshed the domain's page count (truth audit F1: the fresh number
 * sat in `state.domains` while the DOM kept the stale one).
 */
function patchChatHead() {
  const meta = document.getElementById('chat-head-meta');
  if (meta) meta.innerHTML = chatHeadMetaHtml();
  const title = document.querySelector('#chat-head .tx-vh-title');
  const want = chatHeadTitle();
  if (title && title.textContent !== want) title.textContent = want;
  refreshCompileCaption();
}

/**
 * F1, for the other two places a domain's page count is printed: the empty
 * thread's "This domain has N pages" and the composer's domain menu. The
 * header is `patchChatHead`'s.
 */
function patchScopeCount() {
  patchChatHead();
  const d = state.domains.find(x => x.slug === state.activeDomain);
  const body = document.querySelector('.chat-empty-body');
  if (d && body) body.textContent = emptyThreadBodyText(d);
  if (domainLbCfg && domainLbApi) {
    const fresh = domainPickerCfg();
    domainLbCfg.options = fresh.options;
    domainLbApi.setOptions(fresh.options);
  }
}

// Shown/hidden the same way the shipping app's #compile-btn is (v3.0.1-
// beta.15's COMPILE_MIN_USER_MESSAGES = 1): once this conversation has at
// least one user turn. Unlike the shipping app, this does NOT hide the
// button for a read-only Shared Brain mirror domain — the backend already
// refuses that with a clear, user-facing 400 (see runCompile's error
// handling below), and duplicating that domain-readonly check here would
// be a second place for the two to drift apart. A deliberate scope
// simplification, not an oversight.
function renderCompileButtonHtml() {
  const userTurns = state.thread.filter((m) => m.role === 'user').length;
  if (!state.activeConversationId || userTurns < COMPILE_MIN_USER_MESSAGES) return '';
  const label = state.compileBusy
    ? ('Compiling… ' + Math.round(state.compilePct || 0) + '%')
    : 'Compile to Wiki';
  return (
    // No key: `state.compileKeyAttrs` is aiActionDisabledAttrs' ' disabled
    // aria-disabled="true" aria-describedby="chat-compile-runline"', read off
    // state because this body is lifted by two suites (see the field's own
    // comment); '' whenever a run is possible. Busy wins, and prints ONE
    // `disabled`, never two.
    // v3.72.0: with no key line, the button is described by its caption —
    // the sentence the old scope bar printed beside it, now visually hidden
    // because the header's meta line shows the same counts on the face.
    '<button type="button" class="btn btn-ai btn-xs chat-compile-pill" id="chat-compile-btn"' + (state.compileBusy ? ' disabled' : (state.compileKeyAttrs || '')) +
      (state.compileKeyAttrs ? '' : ' aria-describedby="chat-compile-caption"') +
      ' title="Save this conversation as wiki pages">' +
      icon('sparkles', 13) + ' <span id="chat-compile-btn-label">' + escapeHtml(label) + '</span>' +
    '</button>'
  );
}

/**
 * How many messages this compile would take as its INPUT.
 *
 * Counted off `state.thread`, which is what is on screen, so the number in the
 * caption is one the reader can verify by counting bubbles. `role: 'compile'`
 * entries are synthetic outcome cards pushed by runCompile (see
 * renderThreadOnly's own branch for them) and are not messages — including them
 * would make a second compile of the same thread claim one more message than
 * the first, with nothing said in between.
 *
 * NOT the sidebar row's server-supplied `messageCount`: that is the same
 * quantity, but it is patched locally by bumpMessageCountForTurn and is
 * therefore a second, drifting copy of a number the thread already holds
 * exactly.
 */
function compileMessageCount() {
  return state.thread.filter((m) => m && (m.role === 'user' || m.role === 'assistant')).length;
}

/**
 * The same input, SPLIT into the two things a reader can actually point at on
 * screen: their own questions, and the answers that came back.
 *
 * "2 messages" was a true count of a quantity nobody counts. The reported
 * symptom was a caption reading "(2 messages)" beside a sidebar row reading
 * "6 messages" for the same thread — see compileCaptionText for that cause,
 * which is separate — but the wording is its own defect: even once the number
 * is right, "6 messages" is a unit the user has to reconstruct from three
 * bubbles plus three bubbles. Questions and answers are the units on screen.
 *
 * Counted from the same `state.thread` and the same roles as
 * compileMessageCount, so `questions + answers` is that function's value by
 * construction and the caption can never claim a different total from the one
 * the compile takes as input. Synthetic `role: 'compile'` outcome cards are
 * excluded here exactly as they are there.
 *
 * An errored assistant turn is NOT stored in the conversation file (the server
 * persists a turn only on success), so a thread loaded from disk has one
 * answer per question. A LIVE thread can briefly hold an `error` entry, which
 * IS role 'assistant' and IS counted — deliberately: it is a bubble on screen,
 * and a caption that silently skipped it would go back to naming a number the
 * reader cannot verify.
 */
function compileTurnCounts() {
  let questions = 0;
  let answers = 0;
  for (const m of state.thread) {
    if (!m) continue;
    if (m.role === 'user') questions++;
    else if (m.role === 'assistant') answers++;
  }
  return { questions, answers };
}

/**
 * The Compile control's own caption — the sentence that has to be true whether
 * or not the reader has understood anything else on this bar.
 *
 * IT NAMES THE INPUT, NOT THE OUTPUT, and that is the whole point of it. The
 * defect it fixes was a page count being read as "how many pages this button
 * will touch"; replacing it with a different output number would repeat the
 * mistake in a more confident voice, because how many wiki pages a compile
 * writes is genuinely unknown before the call (buildCompileConfirmCopy says so
 * in as many words: "how many wiki pages the AI decides to write cannot be
 * known before the call"). The messages going IN are countable, and they are on
 * screen.
 *
 * NO COST, DELIBERATELY. The confirm dialog is the cost gate (v3.27.0 —
 * "Compile stops spending silently"): it estimates, states a real price, a free
 * model, an unpriced model or no provider as four different sentences, and only
 * then spends. A price on the toolbar would be a second, un-estimated copy of
 * that fact — stale by construction, since it would have to be rendered before
 * `/api/compile/estimate` has been called. The caption's job is to say what the
 * button DOES; the dialog's job is to say what it costs.
 *
 * The wording tracks the dialog's on purpose — the dialog opens with "Compile
 * this conversation to your wiki?" and ends with "Pages are written into the
 * "<domain>" wiki" — so the caption reads as the short form of the sentence the
 * user is about to be shown, not as a second, competing description.
 */
function compileCaptionText() {
  const { questions, answers } = compileTurnCounts();
  const q = questions + ' question' + (questions === 1 ? '' : 's');
  // "0 answers" is grammatical and unhelpful; "no answers yet" says the same
  // fact and says why it is not a mistake. Reachable in one real state: a
  // stopped first turn whose answer never arrived.
  const a = answers === 0 ? 'no answers yet' : (answers + ' answer' + (answers === 1 ? '' : 's'));
  return 'Saves this conversation — ' + q + ' and ' + a + ' — as wiki pages';
}

/**
 * Re-state the caption's counts in place, without repainting the scope bar.
 *
 * THIS IS THE REPORTED DEFECT, not the wording. The caption is built by
 * `renderMain`, which runs on a MOUNT, a domain switch or a conversation
 * switch. An ordinary turn does not go through it: `sendCurrentMessage`'s
 * not-new branch calls `renderThreadOnly` + `renderSidebarConversationsOnly`
 * and patches the sidebar row's count with `bumpMessageCountForTurn`, so the
 * sidebar ticked 2 -> 4 -> 6 while the caption kept the number it was painted
 * with. That is exactly the reported "(2 messages)" beside "6 messages" — the
 * two counters agreed about WHAT to count all along and disagreed about WHEN.
 *
 * A TARGETED `textContent` WRITE, never a re-render, for the reason
 * `updateCompileButtonBusy` directly above states about itself: rebuilding
 * this bar mid-thread would tear down and re-focus the composer, and the
 * v3.53.1 defect this repo records was a section re-rendering itself from a
 * tick. Nothing here reads state that a repaint would refresh — the counts
 * come from `state.thread`, which the caller has just changed.
 *
 * ABSENT ELEMENT IS A NO-OP, AND THAT IS COMPLETE, not lazy: the caption
 * exists only where the button exists (compileControlHtml is one builder for
 * both), and the button APPEARS only when a conversation gains its first user
 * turn — which is `sendCurrentMessage`'s wasNew branch, and that branch calls
 * `renderShell`. So every transition that can create the caption already
 * repaints the bar; this covers every transition that can only change it.
 */
function refreshCompileCaption() {
  const el = document.getElementById('chat-compile-caption');
  if (!el) return;
  el.textContent = compileCaptionText();
}

/**
 * The Compile button PLUS its caption, as one group.
 *
 * One builder rather than two call-site siblings, because the caption must
 * appear and disappear with the button and never on its own: a caption for a
 * control that is not there describes nothing. It delegates the whole
 * visibility decision to renderCompileButtonHtml — an empty string from that
 * function is the single gate — so COMPILE_MIN_USER_MESSAGES stays stated in
 * exactly one place.
 */
function compileControlHtml() {
  const btn = renderCompileButtonHtml();
  if (!btn) return '';
  return (
    '<div class="chat-compile-group">' +
      btn +
      // v3.72.0: VISUALLY HIDDEN, still the button's description. It is not
      // a cost (the confirm is the cost gate) and the header's meta line
      // prints the same question/answer counts on the face. The no-key run
      // line is NOT here: it is a <p>, and the header drops an action slot
      // that holds one — see renderMain's `chat-compile-keyline-host`.
      '<span class="chat-compile-caption visually-hidden" id="chat-compile-caption">' + escapeHtml(compileCaptionText()) + '</span>' +
    '</div>'
  );
}

/**
 * Should the composer carry a model picker at all?
 *
 * Provider mode (v3.0.11): 2+ providers that can actually serve a MODEL-LESS
 * turn, otherwise there is nothing to choose between. Counting merely-keyed
 * providers here would open the picker for a pair like Gemini + a provider with
 * nothing measured, whose only extra row is one the app cannot use.
 * Model mode: ONE keyed provider is enough, because that provider alone offers
 * several models — but still nothing at all with zero keys, since `offerable` is
 * empty for an unkeyed provider.
 *
 * FACTORED OUT of renderComposerHtml because `renderComposerPickers` repaints
 * the picker strip on its own after a pick, and both have to agree about whether
 * a model picker exists. Two copies of that predicate is how a repaint silently
 * grows or drops a control the first paint did not.
 */
function composerShowsModelPicker() {
  return MODEL_PICKER_ENABLED
    ? (state.providerOnlyProviders.length >= 2
        || offerableEntries(state.offerable, state.availableProviders).length > 0)
    : state.providerOnlyProviders.length >= 2;
}

/**
 * The composer's primary button — Send, or Stop while a turn is in flight.
 *
 * ONE BUILDER, TWO CALLERS, for the reason `composerShowsModelPicker` above
 * exists: `renderComposerHtml` paints this on a full repaint and
 * `renderComposerBusy` re-paints it in place when the turn starts and ends. Two
 * copies of "what does this button look like right now" is how a repaint
 * silently drops a control the first paint had — and here the control it would
 * drop is the only way to stop a paid, minutes-long call.
 *
 * ONE ELEMENT, NOT TWO. Same `#chat-send-btn` id and same listener in both
 * states (see wireComposer, which dispatches on `state.sending`), so a repaint
 * cannot orphan a handler or leave two live buttons behind.
 *
 * THE STOP GLYPH IS CSS, NOT `icon()`. There is no stop/square in app.js's
 * shared ICON_BODY, and `icon()` answers an unknown name with a console error
 * and a missing-icon placeholder. app.js is not this view's file to extend, so
 * the square is drawn by `.chat-stop-glyph` in chat.css. `x`/`close` were
 * rejected as substitutes: they read "dismiss this", and what this does is halt
 * work that is still running.
 */
function composerPrimaryButtonHtml(busy) {
  // NOT `disabled` while busy — the whole point is that it is clickable. It was
  // a disabled spinner before this change, which is what left a minutes-long
  // turn with no way out.
  return (
    '<button class="chat-send-btn' + (busy ? ' chat-send-btn-stop' : '') + '" id="chat-send-btn"' +
      (busy
        ? ' title="Stop this answer" aria-label="Stop">' + '<span class="chat-stop-glyph" aria-hidden="true"></span>'
        : ' title="Send (⌘/Ctrl + Enter)" aria-label="Send">' + icon('send', 15)) +
    '</button>'
  );
}

// ── THE SIGNATURE IS BYTE-IDENTICAL, AND THE TEST IS INLINE ───────────────
// Three suites this change does not own reach into this function: one lifts it
// by the literal text `function renderComposerHtml(active)`, one evaluates it
// in a sandbox built from a hardcoded function list of its own, and one lifts
// its CALLER. So the notice is decided HERE, from `state` — which every one of
// those sandboxes already injects — rather than through a new parameter or a
// new helper, either of which reds a suite for a reason that has nothing to do
// with what that suite tests. It is also the shape this file's own
// `composerShowsModelPicker` docblock argues against in general, and the
// exception is stated rather than assumed: the DECISION is three comparisons
// over three values, and it is exercised by driving this function across the
// whole matrix rather than by driving a predicate nothing might call — the
// v3.0.17 lesson about a guard that proves a line exists.
function renderComposerHtml(active) {
  // v3.72.0: a follow-up says where it goes — the conversation's domain is
  // fixed, and this is the one sentence under the caret that says so.
  const domName = active ? (active.displayName || active.slug) : '';
  const placeholder = !active ? 'Ask this domain…'
    : (state.activeConversationId ? 'Ask a follow-up in ' + domName + '…' : 'Ask ' + domName + '…');

  // ── WOULD THE NEXT SEND ASK FOR A MODEL THAT IS NOT THERE? ─────────────
  // Two arms, and they are the two ways a turn resolves a model:
  //   · NOTHING PICKED — the request names no model, the backend resolves the
  //     active provider's default, and that default IS the build model, so the
  //     verdict applies.
  //   · A MODEL PICKED — it applies only if the pick IS that model. The wire
  //     carries a verdict about ONE id and no others; claiming anything about a
  //     different pick would assert a check that never ran.
  //
  // `=== true` is the gate, so UNKNOWN (null) and NOT-MISSING (false) both
  // render nothing. The asymmetry is deliberate: a missed notice costs a
  // fallback the user can already see in the answer's own model label, and a
  // false one sends them off to change a model that is fine.
  const chatDefaultGone = state.buildLiveMissing === true
    && typeof state.buildModelId === 'string' && state.buildModelId !== ''
    && (!state.chatModel || state.chatModel === state.buildModelId);

  // ONE LINE, above the field, never a dialog and never a fold. It is a fact
  // about what the next Send will do, so it belongs where Send is — and the
  // route out is one click, because "go and find it in Settings" is how a
  // notice becomes something people learn to ignore.
  const noticeHtml = chatDefaultGone
    ? '<div class="chat-composer-notice" role="status">' +
        icon('alertTriangle', 13) +
        // `<code>` WITHOUT the `mono` utility class, and the code face comes
        // from `.chat-composer-notice code` in chat.css instead. Not an evasion
        // of scripts/test-next-views-kit.js's budget — that guard's subject is
        // PROSE in the monospace face, and a model id is the opposite of prose
        // — but the budget is an exact allow-list BY CLASS NAME in a file this
        // change does not own, so the face is taken from the component rule the
        // way `.provider-fallback-headline code` already takes it in
        // settings.css. Same rendering, one owner.
        '<span><code>' + escapeHtml(state.buildModelId) + '</code> is no longer offered by its ' +
        'provider. Chat falls back rather than failing, and every answer names the model that ' +
        'actually ran.</span>' +
        '<button type="button" class="btn btn-secondary btn-xs" id="chat-model-gone-settings">' +
        'Open Settings</button>' +
      '</div>'
    : '';

  return (
    '<div class="chat-composer-wrap">' +
      noticeHtml +
      '<div class="chat-composer" id="chat-composer">' +
        // `state.sending` is read here, not passed in, because a full repaint
        // can happen MID-TURN (selectConversation, switchDomain and
        // startNewChat all call renderShell) and the composer must come back
        // in the state the app is actually in. Before this it always came back
        // as an enabled Send that `sendCurrentMessage` then silently refused —
        // the inert-control defect this repo has recorded twice.
        '<textarea class="chat-input" id="chat-input" rows="2" placeholder="' + escapeHtml(placeholder) + '"' +
          (state.sending ? ' disabled' : '') + '></textarea>' +
        // REMOVED (cutover): a permanently-disabled paperclip sat here whose
        // own tooltip said it was not wired up. The shipping composer has no
        // attach control at all, so this was a NEW dead affordance in the
        // most-used surface in the app — a user clicks it, nothing happens,
        // and the only thing they learn is that the product ships broken
        // buttons. Attaching a source is Ingest's job (rail, one click).
        '<div class="chat-composer-controls">' +
          // The pickers are painted by renderComposerPickers() into this host,
          // from ONE cfg object each, and repainted there after every pick. An
          // empty host in the first paint is deliberate: it means there is
          // exactly one code path that ever builds these two controls.
          '<div class="chat-composer-pickers" id="chat-composer-pickers"></div>' +
          '<div class="chat-composer-spacer"></div>' +
          '<span class="chat-cost-hint">cost varies with response length</span>' +
          composerPrimaryButtonHtml(state.sending) +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

// ── Model picker: pure helpers ────────────────────────────────────────────
// Everything below is DOM-free and side-effect-free so the whole surface is
// executable offline (scripts/test-next-composer-model.js extracts and runs
// these directly). Nothing here reads module state — every input is a
// parameter — which is what makes "an unkeyed provider is not selectable"
// provable rather than asserted about source text.

// ── NO SUITABILITY BADGE IN CHAT (v3.72.0, P4) ───────────────────────────
// `SUITABILITY_LABELS` ("caution") and the "chat only" badge before it are
// gone from this view. Both were verdicts about BUILDING THE WIKI shown in a
// menu that picks who answers a chat question (DESIGN.md M-a). The field is
// untouched: llm.js still enforces it and Settings still renders it, where
// the decision on screen is an ingest one. The browse dialog keeps the
// reason text, labelled "For building the wiki:" (shared/model-row.js).

// ── THE THINKING CLOCK ────────────────────────────────────────────────────
// The maintainer picked `deepseek/deepseek-v4-flash-0731` in the composer and
// watched a bare, numberless spinner for minutes, then reported the app as
// broken. It was not: the stored conversation shows that model answered, was
// billed and was attributed correctly. It is simply the slowest thing this
// project has ever measured — 382 seconds for one call.
//
// This is v3.0.17's report, in a second place. That release put an elapsed
// clock on INGEST after "nothing happens and then suddenly something happens";
// chat never got one, and a ticking number is the whole difference between
// "this is alive" and "this is hung". The behaviour and the vocabulary here
// deliberately match ingest.js's (module-level timer, one-second tick, the same
// "6m 22s" formatting) rather than inventing a second pattern.
//
// MODULE LEVEL, NOT `state`. This interval must keep ticking and — far more
// importantly — must be CLEARABLE across a re-mount. A timer that survives its
// own turn writing into a live thread is the "button left permanently reading
// Fixing…" shape this repo has already shipped once.
//
// CORRECTED (chat-cancel): this comment used to justify the placement with
// "`state` is reassigned WHOLESALE by every onEnter". That is FALSE — `state`
// is a `const` (see its declaration) and is never reassigned anywhere in this
// file, which is exactly what onEnter's own comment says ("this file's `state`
// is deliberately NOT reset on every onEnter"). Two comments in one file
// disagreeing about one variable is this repo's most-recurring shape (v3.14.0
// finding 8), so the false half is deleted rather than left to mislead the next
// reader into believing a `state.` field would be wiped on re-mount. The
// placement itself is unchanged and still fine: turn-lifetime bookkeeping lives
// together, up here, beside the abort record below.
let sendStartedAt = null;
let sendTimerId = null;
// What we measured for the model serving THIS turn: `{label, ms}` or null.
// Captured at send time because the composer stays live during the call.
let sendLatencyHint = null;

// ── THE IN-FLIGHT TURN, AND THE ONE THING ALLOWED TO ABORT IT ────────────
//
// `{ controller, mountToken, domain, conversationId, text }` for the turn
// currently in flight, or null. Lives beside the clock, for the same reason and
// with the same lifetime: one per turn, set in `sendCurrentMessage`, cleared in
// its `finally`.
//
// ══ ONLY AN EXPLICIT CLICK ON STOP MAY ABORT. ═══════════════════════════
// NOT the view teardown, NOT `onEnter`, NOT a conversation switch, NOT a domain
// switch, NOT any cleanup path. This is a hard rule, and it is not stylistic:
//
//   - A turn can legitimately run for MINUTES (measured: 186s to first byte on
//     one OpenRouter model). Users navigate away while they wait — that is the
//     normal, reasonable thing to do.
//   - An abandoned turn is NOT wasted today. `sendMessage` persists the
//     conversation server-side after the model returns, so the answer lands on
//     disk and the user gets it back simply by re-opening that conversation.
//     Only the LIVE RENDER is dropped (by the `stillRelevant` check), never the
//     answer.
//   - So aborting on teardown would convert "navigate away" into "silently
//     destroy the paid answer you were waiting for" — strictly worse than the
//     behaviour it replaced, and unrecoverable.
//
// The mount-token / domain / conversation discipline throughout this file is
// about NOT RENDERING INTO THE WRONG PLACE. It must never be read as licence to
// abort because the view moved on. The identity fields captured here serve the
// same render-placement purpose (see `cancelCurrentSend`), plus `text` for the
// draft restore — they are not an abort trigger.
//
// scripts/test-next-chat-cancel.js §6 pins this by EXECUTION: it runs the real
// teardown mid-flight and asserts the request was NOT aborted.
let sendAbort = null;

/**
 * MAY THE TURN IN FLIGHT PAINT INTO THE THREAD THAT IS ON SCREEN RIGHT NOW?
 *
 * ── WHY THIS IS A FUNCTION AND NOT `state.sending` ────────────────────────
 * `state.sending` is a bare global boolean with no conversation and no domain
 * attached to it, and the trailing bubble used to render from `state.sending ?
 * … : ''` with no identity check of any kind. Consequence, reproducible before
 * this change: send in conversation A, click conversation B, and B shows a
 * spinner for a turn that has nothing to do with it.
 *
 * That was survivable while the bubble was a spinner. It is not survivable now
 * that the bubble carries the model's REASONING and a DRAFT OF THE ANSWER:
 * another conversation's content painted into the thread you are reading is
 * the kind of defect that makes a person stop trusting what is on screen.
 *
 * ── IT READS `sendAbort` RATHER THAN A SECOND RECORD OF ITS OWN ───────────
 * `sendAbort` already carries exactly the three identity fields this needs —
 * `{ mountToken, domain, conversationId }` — captured at send time by the same
 * code that captures them for the `stillRelevant` check. Minting a parallel
 * `sendScope` object with the same three fields and a slightly different
 * lifetime is precisely the two-hand-maintained-copies shape this repo has
 * paid for repeatedly; one record, read by both, cannot drift from itself.
 *
 * `state.sending` is still in the conjunction, so it keeps every one of its
 * jobs: the send-lock, the disabled composer, the Send↔Stop dispatch, and the
 * `onEnter` abandon reset. This narrows WHERE the bubble may appear; it does
 * not replace the flag.
 *
 * @param {number} token the mount token of the render asking to paint.
 */
function sendIsOnScreen(token) {
  return !!state.sending && !!sendAbort &&
    sendAbort.mountToken === token &&
    sendAbort.domain === state.activeDomain &&
    sendAbort.conversationId === state.activeConversationId;
}

/**
 * RE-ATTACH A TURN THAT IS STILL RUNNING TO THE MOUNT NOW ON SCREEN.
 *
 * ── THE DEFECT (production, v3.64.0) ──────────────────────────────────────
 * "A chat answer in progress disappears when I go to Domains, and only shows
 * up when the stream finishes." Both halves were true and they had different
 * causes. The answer disappeared because `onEnter` blanked `state.sending`,
 * `sendStream` and the clock while the turn's own record still named the OLD
 * mount, so `sendIsOnScreen` — correctly, on the information it had — refused
 * to paint. It reappeared at the end because `selectConversation` re-reads the
 * conversation from disk, and by then the server had persisted the answer.
 *
 * ── WHY RE-POINTING THE RECORD IS THE FIX, AND NOT A HOLE IN THE GATE ────
 * `sendIsOnScreen` is left BYTE-IDENTICAL, including `sendAbort.mountToken ===
 * token`. The gate was never wrong: a turn may paint only into the mount it
 * belongs to. What was missing is a way for a turn to legitimately CHANGE the
 * mount it belongs to — and the only safe moment for that is this one, where
 * the domain and the conversation have just been proven to match. So the
 * identity check is not weakened; it is satisfied, on purpose, once.
 *
 * This is also the ONE sanctioned exception to the rule stated on
 * `myMountToken` — "never read a shared token after an await". The turn reads
 * `sendAbort.mountToken` rather than its captured local, but it reads its OWN
 * record, written by this function only after a three-way identity match, and
 * never the shell's live variable.
 *
 * ── THE USER'S OWN MESSAGE COMES BACK TOO ────────────────────────────────
 * `sendCurrentMessage` pushes the question optimistically; the server persists
 * NOTHING until the model returns. So the thread `selectConversation` just
 * fetched is missing it, and a bubble with no question above it would read as
 * an answer to nowhere. It is re-added here, guarded by the same identity test
 * the Stop unwind uses (last entry, role user, same text) so a double call
 * cannot push it twice.
 *
 * Returns true when a turn was adopted — callers use it to decide nothing;
 * it exists so the suite can assert the decision rather than infer it.
 */
function adoptLiveTurn(token) {
  if (!sendAbort) return false;
  if (!isCurrentMount(token)) return false;
  if (sendAbort.domain !== state.activeDomain) return false;
  if (sendAbort.conversationId !== state.activeConversationId) return false;

  sendAbort.mountToken = token;
  // The turn kept writing into its own detached buffers the whole time it was
  // off screen (see `sendStream`'s declaration), so the reasoning and the
  // draft that arrived while the user was away are already here — this is a
  // re-point, never a replay.
  sendStream = sendAbort.stream || sendStream;
  state.sending = true;
  // The ORIGINAL start time, not now: the clock measures the turn, and
  // restarting it at zero on the way back would tell the user a 90-second wait
  // had just begun.
  resumeSendClock(token, sendAbort.startedAt);

  const last = state.thread[state.thread.length - 1];
  if (!(last && last.role === 'user' && last.content === sendAbort.text)) {
    state.thread.push({ role: 'user', content: sendAbort.text });
  }
  return true;
}

// ── THE LIVE STREAM FOR THE TURN IN FLIGHT ────────────────────────────────
//
// `{ sse, seen, reasoning, content, reasoningView }` for the turn in flight, or
// null. Same lifetime and the same placement rule as `sendAbort` and the clock:
// one per turn, created in `sendCurrentMessage` before the fetch, cleared in its
// `finally` and on `onEnter`'s abandon path.
//
// ══ THIS IS TRANSIENT DOM MATERIAL. IT IS NEVER A `state.thread` ENTRY. ═══
// Not "for tidiness" — an assistant placeholder in the thread would BREAK
// STOP. `sendCurrentMessage`'s abort unwind removes the optimistic user bubble
// only when the LAST thread entry is `{role:'user'}` with matching content; a
// placeholder pushed after it fails that identity guard, so a stopped turn
// would leave a phantom user message on screen that is not in the conversation
// on disk. scripts/test-next-chat-cancel.js §4 asserts `thread.length === 1`
// after a Stop, and that assertion is the whole reason this lives out here.
// `state.cancelNotice` above is the precedent: transient, rendered, never a
// thread entry.
//
//   sse            — the response really was `text/event-stream`. Set only on
//                    CONFIRMED headers, never optimistically at request time:
//                    a non-streaming route resolves its headers at the END of
//                    the turn, so an optimistic flag would suppress the slow-
//                    turn notice for the entire wait it exists to explain.
//   seen           — the first delta of ANY kind has arrived. This is what ends
//                    the ring's pre-roll.
//   reasoning      — the model's scratchpad, accumulated verbatim.
//   content        — a PREVIEW of the answer, and nothing more. The thread
//                    entry is built from `done.answer` alone (see the send
//                    path); this buffer is discarded.
//   reasoningView  — 'tail' | 'full' | 'hidden'.
let sendStream = null;

// How much of the reasoning tail is shown while it streams.
//
// MEASURED, NOT PICKED: a turn on `z-ai/glm-5.3-flash` emits 6,687-8,385
// characters of reasoning at 31-38 chunks/second. Rendering all of it live is a
// firehose — the text scrolls faster than anyone reads and the useful signal
// (that the model is working, and roughly on what) is lost in it. A few lines,
// updated in place, is the readable form of the same fact. The full text stays
// one click away and is never truncated on the way in.
const STREAM_TAIL_LINES = 4;
const STREAM_TAIL_CHARS = 320;

/**
 * Is the slow-turn notice suppressed for this turn?
 *
 * ── IT MUST NOT FIRE ON A STREAMING RESPONSE, AND THAT IS NOT A PREFERENCE ──
 * `slowTurnNoticeText` quotes `medianLatencyMs`, which is a TOTAL CALL TIME. On
 * a non-streaming turn total is the only number there is, so quoting it beside
 * an elapsed clock compares like with like. On a streaming turn the clock
 * before the first delta measures TIME TO FIRST BYTE — a different quantity,
 * for which this project has no corpus at all. Putting a total-call figure
 * beside it would invite exactly the arithmetic it cannot support ("186s
 * measured, 25s elapsed, so I am 13% through"), which is the invented-
 * denominator this file refuses everywhere else.
 *
 * There is no honest replacement, so there is no replacement: silence beats a
 * number that means something other than what the reader will take it to mean.
 * The live clock and the streamed text still run, so silence is never mistaken
 * for a hang.
 *
 * KNOWN, AND STATED RATHER THAN IMPLIED AWAY: this can only be true once the
 * response headers have been read, so a server that withheld its SSE headers
 * for more than 20 seconds would show the notice briefly before the first
 * delta cleared it. Every producer in this codebase flushes SSE headers before
 * any work, so that window is milliseconds — but it is a property of the
 * server, not something this function can guarantee.
 */
function slowNoticeSuppressed() {
  return !!(sendStream && sendStream.sse);
}

// After this long, a turn stops looking slow and starts looking broken — so if
// we have a measurement for the model in flight, we state it. Once, as a fact.
//
// TWENTY SECONDS, and the number is chosen from the data rather than taste. The
// fastest models measured here answer an ingest outline in 13-22s and a chat
// turn in a small fraction of that, so an ordinary answer never reaches this
// and the notice does not become wallpaper. The slowest measured 382s, which is
// far past the point where a reasonable person concludes the app has hung. The
// bound has to sit above normal and well below panic; 20s is that gap.
const SLOW_TURN_NOTICE_AFTER_MS = 20000;

/**
 * The SPAN of call times this project has actually measured, across every model
 * currently offerable — `{lowMs, highMs, count}` — or null when fewer than two
 * models carry a figure, in which case there is no span to report.
 *
 * DERIVED FROM THE LIVE CATALOGUE, never a hardcoded pair of numbers. The
 * figures move whenever llm.js's table does, and a hardcoded "13s to 6m 22s"
 * would be a measurement in prose that rots silently — which is exactly the
 * defect v3.16.1 recorded when a docblock quoted 491 seconds for a run that
 * never happened.
 *
 * `>= 1000` for the same reason shared/model-summary.js's speedClause uses it:
 * below a second `formatDurationMs` renders "0s", and a range starting at "0s"
 * would be the zero-for-absent claim arriving through rounding.
 */
function measuredLatencyRange(offerable, availableProviders) {
  let low = Infinity, high = -Infinity, count = 0;
  for (const row of offerableEntries(offerable, availableProviders)) {
    const ms = row.entry && row.entry.medianLatencyMs;
    if (!Number.isFinite(ms) || ms < 1000) continue;
    count++;
    if (ms < low) low = ms;
    if (ms > high) high = ms;
  }
  // A "range" of one point is not a range, and rendering "from 48s to 48s" is
  // worse than saying nothing.
  if (count < 2 || low === high) return null;
  return { lowMs: low, highMs: high, count };
}

/**
 * What we can honestly say about how long THIS turn may take.
 *
 * ── THE TWO PROBLEMS THIS ANSWERS, AND WHAT IT REFUSES TO DO ─────────────
 *
 * 1. ONLY 6 OF 213 OFFERABLE MODELS CARRY A LATENCY FIGURE. The previous
 *    version returned null for the other 207, so ~97% of turns got a bare
 *    counter and no expectation at all — and a bare counter at four minutes is
 *    indistinguishable from a hang. The answer is NOT to guess: there is still
 *    no average, no extrapolation from price or context length, and no
 *    borrowing of a sibling model's number. Instead an unmeasured model gets a
 *    statement about OUR DATA — the span of call times we have recorded across
 *    the models we did measure — which is a fact about the catalogue and
 *    explicitly not a prediction about this model.
 *
 * 2. THE FIGURE WAS MEASURED ON THE WRONG WORKLOAD. `medianLatencyMs` comes
 *    from an INGEST OUTLINE call on a ~300,000-character prompt (see
 *    docs/model-lifecycle.md and the qualification harness), and this notice
 *    quoted it during a CHAT turn, whose prompt is a fraction of that size. The
 *    provenance was missing, so the number read as a prediction for the thing
 *    on screen. It now names the workload it came from. It deliberately does NOT
 *    add "so a chat turn will be quicker": fewer input tokens usually means less
 *    time, but output length dominates and we have not measured that, and a
 *    plausible inference stated as fact is how this surface stops being evidence.
 *
 * IT STILL RETURNS NULL WHEN NO MODEL IS NAMED. With `state.chatModel` unset the
 * server picks the provider's default, and which provider is "active" is a
 * server-side fact this view does not hold — so we would be attaching a claim to
 * a model that may not be the one running. `state.modelProvider` being set is
 * the case where we DO know the id (`state.models[provider]` is the backend's
 * own default for it), and that path is taken.
 *
 * @returns {{kind:'measured', label:string, ms:number}
 *          |{kind:'unmeasured', label:string, lowMs:number, highMs:number}
 *          |null}
 */
function latencyHintForTurn() {
  let row = resolveChatModel(state.chatModel, state.offerable, state.availableProviders);
  if (!row && typeof state.modelProvider === 'string' && state.modelProvider) {
    const defaultId = state.models && Object.hasOwn(state.models, state.modelProvider)
      ? state.models[state.modelProvider] : null;
    row = resolveChatModel(defaultId, state.offerable, state.availableProviders);
  }
  if (!row) return null;
  const label = row.entry.label || row.entry.id;
  // llm.js's own reported fact that this model bills nothing — never a ":free"
  // id substring, and never a price of 0 (see formatLivePrice's docblock for why
  // those two are not the same question). Carried on the hint rather than
  // resolved again later so the bubble and the failure note describe the same
  // model the turn was actually sent to.
  const free = row.entry.free === true;
  const ms = row.entry.medianLatencyMs;
  if (Number.isFinite(ms) && ms >= 1000) return { kind: 'measured', label, ms, free };
  const range = measuredLatencyRange(state.offerable, state.availableProviders);
  // No range either (a catalogue with fewer than two measured models): nothing
  // to say about TIMING, so nothing is said about timing. A free model still has
  // something true to say, so it keeps a hint; anything else stays null and gets
  // a bare ticking clock, which is the absence rule.
  if (!range) return free ? { kind: 'free-only', label, free } : null;
  return { kind: 'unmeasured', label, lowMs: range.lowMs, highMs: range.highMs, free };
}

/**
 * The slow-turn notice as PLAIN TEXT — one sentence pair, no markup.
 *
 * Returns '' for a null hint, so both callers (the initial paint and the
 * once-per-second tick) render exactly the same words from exactly one place.
 * Two copies of a sentence about a measurement is how the live text and the
 * repainted text come to disagree.
 */
function slowTurnNoticeText(hint) {
  if (!hint) return '';
  // ── THE FREE-MODEL CLAUSE, AND WHY THE SENTENCE LIVES HERE ────────────────
  //
  // Written out inline rather than delegated to a helper: this function is
  // lifted verbatim into a `new Function` sandbox by test-next-composer-model
  // with a fixed set of bindings, so ANY new free identifier — a helper, or even
  // a module-level string constant — is a ReferenceError there rather than a
  // failing assertion. Inline keeps the shipped wording drivable by that suite.
  //
  // This is also the ONLY copy of the sentence: the failure surface reaches it
  // by calling THIS function with `{label, free: true}` (see
  // failedModelNoteHtml), so the words a user reads while waiting and the words
  // they read after a failure cannot drift apart.
  //
  // NO RATE-LIMIT FIGURE, EVER. v3.15.0 records this project declining to print
  // free-tier request caps because they could not be verified, and v3.18.0
  // measured 18 consecutive 429s on a PAID model — so a "free tier allows N/day"
  // lead would be both unverifiable and wrong exactly when it is read. What is
  // stated instead is the thing we did measure: the SHARED POOL, and the spread
  // it produced across siblings in one session.
  const free = hint.free === true
    ? hint.label + ' is a free model, and free models share one pool of capacity with ' +
      'everyone else using them, so availability can differ sharply between free models at the same ' +
      'moment: in our testing on 27 Aug 2026, one free model answered 8 of 8 calls while three others ' +
      'answered 0 of 8 over the same ten minutes.'
    : '';
  let timing = '';
  if (hint.kind === 'measured') {
    timing = hint.label + ' measured at about ' + formatDurationMs(hint.ms) +
      ' per call in our testing, on a full ingest outline — a much larger prompt than a chat turn.';
  } else if (hint.kind === 'unmeasured') {
    timing = 'We have no timing measurement for ' + hint.label + '. ' +
      'Across the models we have measured, one call took anywhere from ' +
      formatDurationMs(hint.lowMs) + ' to ' + formatDurationMs(hint.highMs) + '.';
  }
  // An unrecognised kind contributes no timing sentence rather than falling
  // through to the unmeasured wording, which would state a span for a hint that
  // carries none and render "undefined to undefined".
  return timing && free ? timing + ' ' + free : (timing || free);
}

/**
 * The markup inside the trailing "thinking…" bubble.
 *
 * Rendered fresh on every `renderThreadOnly`, so it reads the live clock rather
 * than starting from blank — otherwise any re-render (a compile card landing, a
 * sidebar refresh) would visibly reset a running timer to zero.
 */
function thinkingBodyHtml() {
  const elapsedMs = sendStartedAt == null ? 0 : Math.max(0, Date.now() - sendStartedAt);
  const slowText = (!slowNoticeSuppressed() && elapsedMs >= SLOW_TURN_NOTICE_AFTER_MS)
    ? slowTurnNoticeText(sendLatencyHint) : '';
  // NOT an error, an apology or an animation — a fact, stated once, in the
  // recessed colour the composer already uses for measured detail. It names what
  // WE measured, on what, and does not promise this turn will match it.
  //
  // NO DETERMINATE PROGRESS BAR, ever, and this repo has a doctrine for it: one
  // chat turn is a single LLM call with no sub-progress to report, and advancing
  // a ring to look busy is the exact dishonesty shared/progress-ring.js was
  // built to refuse (v3.9.0). A ticking clock is a real measurement; a bar
  // filling toward an invented total is not.
  const slow = slowText ? '<div class="chat-thinking-slow">' + escapeHtml(slowText) + '</div>' : '';
  return (
    // ONE SLOT, TWO OCCUPANTS, ONE PRODUCER. The slot holds either the ring
    // (pre-roll) or the streamed text, and `streamSlotHtml` is the only thing
    // that builds either. The live paint path re-renders THIS ELEMENT and
    // nothing else, so a full `renderThreadOnly` and a per-delta patch can
    // never disagree about what the waiting state looks like.
    //
    // `data-shape` is how the fast path knows whether a STRUCTURAL change has
    // happened (ring -> text, reasoning collapsing on the first content delta,
    // the user expanding the fold) as opposed to more of the same text. It is
    // emitted here so a full render leaves the slot in a state the fast path
    // reads correctly without a second bookkeeping variable.
    '<div id="chat-stream-slot" data-shape="' + escapeHtml(streamShapeKey()) + '">' +
      streamSlotHtml(elapsedMs) +
    '</div>' +
    '<div id="chat-think-slow">' + slow + '</div>'
  );
}

/**
 * A key that changes only when the waiting state's STRUCTURE changes — never
 * when more text arrives.
 *
 * This is what keeps the cost of a delta at "write two strings into two
 * existing text nodes". A key that moved with the text would re-render the slot
 * 31-38 times a second, which is the `renderThreadOnly`-per-token defect one
 * level down: it would drop and re-bind the fold's listener on every chunk and
 * destroy any text selection inside the reasoning box every frame.
 */
function streamShapeKey() {
  const s = sendStream;
  if (!s || !s.seen) return 'ring';
  return [
    'text',
    s.reasoningView,
    s.reasoning ? 'r' : '-',
    s.content ? 'c' : '-',
  ].join('|');
}

/**
 * The last few lines of the reasoning, for the live tail.
 *
 * Deliberately cuts from the END: the newest text is the informative part, and
 * the final line is usually a PARTIAL sentence mid-generation, which is exactly
 * the signal that something is happening right now. Nothing is lost — the tail
 * is a view of `sendStream.reasoning`, which is never truncated on the way in.
 */
function reasoningTailText(full) {
  const text = typeof full === 'string' ? full : '';
  const lines = text.split('\n');
  let tail = lines.slice(Math.max(0, lines.length - STREAM_TAIL_LINES)).join('\n');
  if (tail.length > STREAM_TAIL_CHARS) tail = tail.slice(tail.length - STREAM_TAIL_CHARS);
  return tail;
}

/**
 * The waiting state's contents: the pre-roll ring, or the streamed text.
 *
 * ── EVERY STREAMED CHARACTER IS ESCAPED PLAIN TEXT. NOTHING GOES THROUGH
 *    `renderMarkdown`, INCLUDING THE ANSWER DRAFT. ────────────────────────
 * Two concrete hazards, and one rule that removes both rather than managing
 * them:
 *
 *   1. `renderMarkdown`'s citation pass matches `\[source:([^\]]{1,512})\]`.
 *      Mid-stream, `[source: entities/foo` has no closing bracket yet, so the
 *      match runs on to the NEXT `]` in the buffer and produces a CLICKABLE
 *      CHIP POINTING AT THE WRONG PAGE. A citation that opens the wrong page
 *      is worse than no citation at all, and it would appear and disappear as
 *      the buffer grew.
 *   2. Partial markdown flickers structurally, not just visually: a half-typed
 *      ``` fence swallows the rest of the answer into a code block, a lone `**`
 *      reflows a paragraph, a half-written `[[` becomes a wikilink and then
 *      stops being one.
 *
 * So the draft is a PREVIEW rendered as text, and `done.answer` — replacing it
 * wholesale — is the first and only thing rendered as markdown. The visible
 * settle from plain to formatted at the end is the honest report of exactly
 * that: what you were reading was provisional. (Citations are wired for the
 * same reason on the terminal frame only, in `renderThreadOnly`, never here.)
 *
 * Reasoning additionally has its own reason to stay plain: it is the model's
 * scratchpad, not an answer, and rendering it in the answer's voice is the
 * measurement-and-explanation collapse this app has already been through once.
 */
function streamSlotHtml(elapsedMs) {
  const s = sendStream;
  const clock = '<span id="chat-think-elapsed" aria-hidden="true">' +
    escapeHtml(formatDurationMs(Math.max(0, elapsedMs || 0))) + '</span>';

  if (!s || !s.seen) {
    return '<div class="chat-thinking">' + preRollRingHtml(elapsedMs) + '</div>';
  }

  const hasReasoning = !!s.reasoning;
  const started = !!s.content;
  const view = hasReasoning ? s.reasoningView : 'hidden';

  // "Thinking…" while the scratchpad is the only thing happening; "Thought
  // for" the moment the answer starts, because by then the thinking is over
  // and a present tense would be a false statement about the current state.
  const title = started ? 'Thought for' : (hasReasoning ? 'Thinking…' : 'Answering…');

  let toggle = '';
  if (hasReasoning) {
    const next = view === 'full' ? (started ? 'hidden' : 'tail') : 'full';
    const label = view === 'full'
      ? (started ? 'Hide reasoning' : 'Show less')
      : (view === 'hidden' ? 'Show reasoning' : 'Show all');
    // A real focusable <button>, not a hover affordance: this repo already
    // carries 11 strings that exist only in `title=`, invisible to keyboard and
    // touch, and a twelfth is not being added.
    toggle =
      '<button type="button" class="chat-stream-toggle" data-stream-view="' + escapeHtml(next) + '"' +
        ' aria-expanded="' + (view === 'hidden' ? 'false' : 'true') + '"' +
        ' aria-controls="chat-stream-reasoning">' + escapeHtml(label) + '</button>';
  }

  const reasoningBlock = (hasReasoning && view !== 'hidden')
    ? '<div class="chat-stream-reasoning' + (view === 'full' ? ' chat-stream-reasoning-full' : '') + '"' +
        ' id="chat-stream-reasoning">' +
        escapeHtml(view === 'full' ? s.reasoning : reasoningTailText(s.reasoning)) +
      '</div>'
    : '';

  const draft = started
    ? '<div class="chat-stream-draft" id="chat-stream-answer">' + escapeHtml(s.content) + '</div>'
    : '';

  return (
    '<div class="chat-stream">' +
      '<div class="chat-stream-head">' +
        '<span class="chat-stream-title">' + escapeHtml(title) + '</span>' +
        clock +
        toggle +
      '</div>' +
      reasoningBlock +
      draft +
    '</div>'
  );
}

/** The pre-roll ring — today's waiting state, unchanged, now time-boxed to the
 *  gap before the first delta. */
function preRollRingHtml(elapsedMs) {
  return (
      progressRingHtml({
        // ── THE TWO ARGUMENTS THAT CARRY THE HONESTY RULE ──────────────────
        // No `stages`, and `value: null`. Together these put the component in
        // its activity-only mode: `ringSegments` returns [], `ringValueArc`
        // returns null, so the OUTER RING RENDERS AS TRACK ONLY — empty, and
        // stationary, because nothing but `value` can ever move it. The orbit
        // is the only thing in motion, at its fixed 1.15s period.
        //
        // THAT IS NOT A LIMITATION BEING WORKED AROUND. It is the correct
        // report: this ring covers the gap BEFORE the first byte, which is one
        // call with no sub-progress frames of any kind, so any advancing arc
        // would be derived from a clock rather than from work done — the
        // precise inversion shared/progress-ring.js was built to refuse, and
        // the one this repo has already paid for once (v3.0.17, a user
        // reporting the app as hung because ingest's Planning phase genuinely
        // could not move a bar).
        //
        // (This comment previously said "a chat turn is one non-streaming
        // POST". That was true when it was written and is now false; the
        // CONCLUSION is unchanged, which is why only the premise is corrected
        // rather than the rule being revisited.)
        //
        // AND THE RULE SURVIVES INTO THE STREAM, where it is under MORE
        // pressure, not less: a stream hands us a token count, which is the
        // most convincing wrong denominator available — `max_tokens` is a cap,
        // not a forecast. So: never pass `value` here, never pass `stages`,
        // and never derive either from `elapsedMs` or from a token count.
        // There is no total to divide by. The elapsed clock is a real
        // measurement and is the only number on screen.
        stages: null,
        value: null,
        size: 32,
        // Suppressed anyway below 40px, but stated so the intent survives a
        // future size change: there is no number to put in the middle.
        center: 'none',
        // Nothing has gone wrong and nothing has finished — a wait in progress
        // is the accent case. `attention` would dress an ordinary slow model up
        // as a fault; `success` is for a ring that has settled.
        tone: 'accent',
        label: 'Thinking…',
        // Pre-built so the id survives: `startSendClock`'s tick patches this
        // node's textContent once a second and must not re-render the ring
        // (which would restart the orbit's phase every tick). Same seam, and
        // the same reason, as ingest's `#ing-elapsed`. The component marks
        // every sublabel aria-hidden, so a screen reader is not read a new
        // number every second.
        sublabelHtml: '<span id="chat-think-elapsed">' + escapeHtml(formatDurationMs(Math.max(0, elapsedMs || 0))) + '</span>',
        className: 'chat-think-ring',
      })
  );
}

/**
 * Start the clock for a turn. Idempotent: clears any previous interval first,
 * so two sends can never leave two timers writing to one element.
 */
function startSendClock(token) {
  stopSendClock();
  sendStartedAt = Date.now();
  sendLatencyHint = latencyHintForTurn();
  sendTimerId = setInterval(() => {
    // Same mount gate as ingest's tick. An abandoned mount's in-flight send is
    // still running (this view does not abort the fetch), and its clock must
    // not write into a LATER mount's thread.
    if (!isCurrentMount(token) || sendStartedAt == null) return;
    const elapsedMs = Math.max(0, Date.now() - sendStartedAt);
    const el = document.getElementById('chat-think-elapsed');
    if (el) el.textContent = formatDurationMs(elapsedMs);
    const slotEl = document.getElementById('chat-think-slow');
    // Written every tick rather than once at the crossing: `renderThreadOnly`
    // may have replaced the node since, and re-deriving from elapsed is
    // idempotent. `sendLatencyHint` null => this stays empty forever, which is
    // the absence rule — an unmeasured model gets a live clock and no claim.
    //
    // AND IT IS SUPPRESSED ENTIRELY ON A STREAMING RESPONSE — see
    // slowNoticeSuppressed for why quoting a TOTAL call time beside a clock
    // that is measuring time-to-first-byte is a category error rather than a
    // rough guide. The retraction below covers the narrow case where the
    // notice was already painted before the SSE headers were read: it is
    // removed rather than left standing, because a claim we have decided we
    // cannot make must not survive on screen just because it got there first.
    if (slotEl && slowNoticeSuppressed()) {
      if (slotEl.firstChild) slotEl.innerHTML = '';
    } else if (slotEl && elapsedMs >= SLOW_TURN_NOTICE_AFTER_MS && !slotEl.firstChild) {
      // The SAME sentence builder the initial paint uses. It returns '' for a
      // null hint, which is the absence rule intact: a turn we can say nothing
      // honest about gets a live clock and no claim.
      const text = slowTurnNoticeText(sendLatencyHint);
      if (text) {
        const note = document.createElement('div');
        note.className = 'chat-thinking-slow';
        note.textContent = text;
        slotEl.appendChild(note);
      }
    }
  }, 1000);
}

/**
 * Stop and fully reset the clock.
 *
 * CALLED ON EVERY EXIT PATH — success, error and abandonment — because a timer
 * that outlives its turn keeps a finished answer looking unfinished. In
 * `sendCurrentMessage` it lives in the `finally`, beside the `state.sending`
 * reset it mirrors, so no future `return` can skip it; and in `onEnter`'s reset
 * beside the same flag, which is the abandon path.
 */
function stopSendClock() {
  if (sendTimerId != null) { clearInterval(sendTimerId); sendTimerId = null; }
  sendStartedAt = null;
  sendLatencyHint = null;
}

/**
 * Re-arm the clock for a turn a NEW mount has just adopted, keeping the
 * elapsed time the turn has actually run.
 *
 * `startSendClock` binds its interval's `isCurrentMount` gate to the token it
 * was given, so a turn carried across a re-mount needs a fresh interval bound
 * to the new one — the old interval was already cleared by `onEnter`'s
 * `stopSendClock()`. Everything else about the clock is unchanged, which is
 * why this composes `startSendClock` rather than reimplementing it: one timer
 * builder, one place where the interval, the elapsed write and the slow-turn
 * retraction live.
 *
 * `sendStartedAt` is then put BACK to when the turn really started. Letting
 * `startSendClock`'s own `Date.now()` stand would restart the elapsed reading
 * at 0s on every return to the view — a clock that lies in the direction of
 * "this has only just begun", on the surface whose whole job is to say how
 * long you have been waiting. A missing/invalid stored start falls back to the
 * fresh one rather than producing NaN.
 */
function resumeSendClock(token, startedAt) {
  startSendClock(token);
  if (Number.isFinite(startedAt)) sendStartedAt = startedAt;
}

// ── THE LIVE PAINT ────────────────────────────────────────────────────────
//
// ══ `renderThreadOnly` IS NEVER CALLED PER TOKEN, AND THAT IS THE RULE. ═══
// It does a full `el.innerHTML = …` over EVERY message in the thread, re-binds
// every re-ask, citation-chip and citation-tag listener, and scrolls. At the
// measured 31-38 chunks/second that would: rebuild every historical message
// dozens of times a second, orphan and re-bind every listener with it, destroy
// any text selection the user has made every frame, and — because the rebuild
// ends in a scroll — pin them to the bottom so they cannot read back through
// the conversation while the answer arrives. The fast path below writes into
// the streaming bubble's own nodes and touches nothing else.
let streamPaintQueued = false;

/**
 * Coalesce paints to at most one per animation frame.
 *
 * ── THIS IS A THROTTLE, NOT AN ANIMATION LOOP, AND THE DIFFERENCE IS
 *    STRUCTURAL: THE CALLBACK NEVER RE-SCHEDULES ITSELF. ─────────────────
 * A frame is only ever requested by an arriving delta, and the flag is cleared
 * inside the callback, so a stream that goes quiet schedules nothing and a
 * finished turn leaves nothing running. A self-perpetuating rAF loop on an
 * element that can legitimately be on screen for minutes is the thing this
 * view's stylesheet and its waiting suite have refused all along; coalescing
 * bursts into frames is the opposite — it does strictly LESS work than
 * painting on every chunk.
 *
 * At 31-38 chunks/second and a 60Hz frame budget this usually coalesces
 * nothing, which is the point: it costs nothing in the normal case and bounds
 * the pathological one (a provider that flushes hundreds of tiny deltas).
 */
function schedulePaintStream(token) {
  if (streamPaintQueued) return;
  streamPaintQueued = true;
  const raf = (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
    ? window.requestAnimationFrame.bind(window)
    : (fn) => setTimeout(fn, 16);
  raf(() => {
    streamPaintQueued = false;
    paintStream(token);
  });
}

/**
 * Write the current stream buffers into the streaming bubble, and nothing else.
 *
 * Structural transitions (the ring giving way to text, reasoning collapsing on
 * the first content delta, the user opening or closing the fold) re-render the
 * SLOT — one element, a handful of times per turn. Everything else is two
 * `textContent` writes, which is the whole per-delta cost.
 */
function paintStream(token) {
  if (!isCurrentMount(token)) return;
  // The identity gate, applied to the fast path as well as to the full render.
  // Without it a turn belonging to conversation A would keep writing its
  // reasoning into whatever bubble happened to be in the DOM.
  if (!sendIsOnScreen(token)) return;
  const s = sendStream;
  if (!s) return;
  const slot = document.getElementById('chat-stream-slot');
  if (!slot) return;

  const host = threadScrollHost();
  const following = isThreadAtBottom(host);

  const shape = streamShapeKey();
  if (slot.getAttribute && slot.getAttribute('data-shape') !== shape) {
    if (slot.setAttribute) slot.setAttribute('data-shape', shape);
    const elapsedMs = sendStartedAt == null ? 0 : Math.max(0, Date.now() - sendStartedAt);
    slot.innerHTML = streamSlotHtml(elapsedMs);
    wireStreamToggle(slot, token);
  } else {
    const r = document.getElementById('chat-stream-reasoning');
    if (r) r.textContent = s.reasoningView === 'full' ? s.reasoning : reasoningTailText(s.reasoning);
    const a = document.getElementById('chat-stream-answer');
    if (a) a.textContent = s.content;
  }

  if (following) stickThreadToBottom(host);
}

/**
 * Bind the reasoning fold's toggle inside `root`.
 *
 * Called from both producers of the markup — the fast path's slot re-render and
 * `renderThreadOnly`'s full rebuild — because an `outerHTML`/`innerHTML`
 * replacement drops the listener with the element. An unbound-looking control
 * is the inert-control defect this repo has recorded more than once.
 */
function wireStreamToggle(root, token) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  root.querySelectorAll('[data-stream-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!sendStream) return;
      const next = btn.getAttribute ? btn.getAttribute('data-stream-view') : null;
      if (next !== 'tail' && next !== 'full' && next !== 'hidden') return;
      sendStream.reasoningView = next;
      // Painted SYNCHRONOUSLY, not through the frame throttle: this is a direct
      // response to a click, and deferring it by a frame is how a control comes
      // to feel unresponsive.
      paintStream(token);
    });
  });
}

// ── FOLLOW-IF-FOLLOWING, RATHER THAN AN UNCONDITIONAL JUMP ────────────────
//
// `#chat-thread` has no scroll of its own — the composer and scope bar are
// sticky WITHIN `.main`, which is the one true scrolling ancestor.
//
// The old behaviour was `scrollTop = scrollHeight` on every render, which was
// survivable when a render happened once or twice a turn. With text arriving
// continuously it becomes a pin: a user scrolling back through the conversation
// while an answer streams would be dragged to the bottom on every frame, unable
// to read anything they had already received.
const THREAD_FOLLOW_SLACK_PX = 48;

function threadScrollHost() {
  return document.getElementById('main');
}

/**
 * Is the reader following the bottom of the thread?
 *
 * The slack exists because "at the bottom" is not an equality: browsers report
 * fractional scroll metrics, and a reader one line up is plainly still
 * following. 48px is roughly two lines of body copy at this view's line-height
 * — inside that, you are reading the newest text; outside it, you have
 * deliberately scrolled away and being yanked back is the defect.
 *
 * An environment that reports no metrics at all (a detached node, a test DOM)
 * yields NaN and is treated as following — the fail-safe direction, because the
 * failure it produces is "the newest message is visible", not "your place was
 * silently lost".
 */
function isThreadAtBottom(host) {
  if (!host) return true;
  const gap = host.scrollHeight - host.scrollTop - host.clientHeight;
  if (!Number.isFinite(gap)) return true;
  return gap <= THREAD_FOLLOW_SLACK_PX;
}

function stickThreadToBottom(host) {
  if (host) host.scrollTop = host.scrollHeight;
}

/**
 * Consume a streamed chat turn and return its terminal `done` frame.
 *
 * ══ THE AUTHORITATIVE-RETURN RULE ════════════════════════════════════════
 * `done` carries the FULL result — the same object the non-streaming route
 * returns — and `done.answer` is the complete, authoritative answer. The
 * deltas are a PREVIEW of it, not a part of it.
 *
 * So this function returns the frame and NOTHING derived from `rec.content`,
 * and the caller builds the thread entry from `done.answer` alone. Appending
 * the buffer to it would double every answer AND lose the truncation note,
 * which `src/brain/llm.js` appends to the finished string and which therefore
 * only ever exists in `done.answer` — never as a delta. Nothing in this file
 * concatenates the two, which is what makes the mistake inexpressible rather
 * than merely discouraged.
 *
 * ── READS TO THE END OF THE STREAM RATHER THAN BREAKING ON `done` ─────────
 * The discipline `runCompile` and `shared.js`'s `runRevoke` already document
 * as "THE SSE TRAP": a later chunk can carry the real terminal frame after an
 * earlier one that looked terminal. Reading to the end costs nothing here (the
 * server closes immediately after `done`) and removes a whole class of
 * ordering assumption.
 *
 * ── AND A STREAM THAT SIMPLY STOPS IS A FAILURE, NOT AN EMPTY ANSWER ──────
 * No `done` and no `error` means the connection died mid-answer. Returning
 * something falsy here would push a blank assistant bubble and persist the
 * silence as if it were a reply.
 */
async function consumeChatStream(body, rec, mountTokenNow) {
  // CONFIRMED headers, not an assumption: the caller only reaches this once it
  // has read `content-type: text/event-stream` off the response.
  rec.sse = true;
  let final = null;
  let errored = null;

  // WHICH MOUNT EACH DELTA PAINTS INTO (v3.64.1).
  //
  // `mountTokenNow` IS A FUNCTION, NOT A NUMBER, and that is the whole change
  // on this side. A turn survives the user leaving the view and can be adopted
  // by a later mount part-way through this read (see `adoptLiveTurn`), so a
  // token captured when the read began is stale from that moment on and every
  // remaining delta would be dropped by `paintStream`'s mount gate — which is
  // precisely the "my answer disappeared" report. Asking the caller for the
  // CURRENT value per delta costs one call and cannot go stale.
  //
  // It is a callback rather than a read of the module's turn record ON PURPOSE:
  // scripts/test-next-chat-cancel.js §10g asserts this function does not so
  // much as mention the word, which is how "the stream consumer never cancels
  // a request, it only ever propagates one that was cancelled elsewhere" is
  // kept true by construction rather than by review. Reaching into that record
  // here would have defeated a guard worth more than the convenience.
  //
  // A non-function (an older caller, a test passing a number) still works —
  // it is used as-is, which is exactly the pre-v3.64.1 behaviour.
  const paintInto = () => (typeof mountTokenNow === 'function' ? mountTokenNow() : mountTokenNow);

  for await (const ev of readSseFrames(body)) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'reasoning') {
      if (typeof ev.text === 'string' && ev.text) {
        rec.reasoning += ev.text;
        rec.seen = true;
        schedulePaintStream(paintInto());
      }
    } else if (ev.type === 'content') {
      if (typeof ev.text === 'string' && ev.text) {
        // AUTO-COLLAPSE ON THE FIRST CONTENT DELTA. The scratchpad has done its
        // job — it filled the 86-91% of the turn during which nothing else
        // could be shown — and leaving it open would push the answer the user
        // actually asked for below a wall of the model's own notes. It becomes
        // a summary line with a button, not a deletion: `rec.reasoning` is
        // intact and one click away.
        if (!rec.content) rec.reasoningView = 'hidden';
        rec.content += ev.text;
        rec.seen = true;
        schedulePaintStream(paintInto());
      }
    } else if (ev.type === 'done') {
      final = ev;
    } else if (ev.type === 'error') {
      errored = ev;
    }
    // An unknown frame type is ignored rather than treated as an error: the
    // producer may add one, and a client that refuses what it does not
    // recognise turns an additive server change into an outage.
  }

  if (errored) {
    throw new Error(
      typeof errored.message === 'string' && errored.message ? errored.message : 'The request failed.'
    );
  }
  if (!final) {
    throw new Error('The connection closed before the answer was finished. Nothing was saved — ask again.');
  }
  return final;
}

/**
 * Re-scope the server's `offerable` map to the providers that actually have a
 * SAVED Settings key, into a null-prototype object.
 *
 * The server already gates this the same way, so this is a SECOND, independent
 * layer — deliberately, because this is the exact v3.0.13 bug's shape: a
 * provider the user Disconnected in Settings must not be reachable from chat,
 * and a client that trusts one gate has no defence if that gate regresses.
 * Null-prototype because the keys are server-supplied strings, so a bare
 * `map[provider]` would otherwise resolve `__proto__`/`constructor` to an
 * Object.prototype member instead of "no models" (same hazard PROVIDER_LABELS
 * closes above).
 */
function normalizeOfferable(raw, availableProviders) {
  const out = Object.create(null);

  // ── ONE LIST, TWO JOBS, AND THAT IS THE POINT ──────────────────────────
  // This function used to hold the provider names TWICE — once to zero the
  // output shape, once to drive the fill loop — so adding a provider needed
  // two edits inside one function and doing only the first produced NO
  // ERROR ANYWHERE: the key existed, the array stayed empty, and the entire
  // catalogue for that provider silently vanished from the composer. A
  // dropped menu with no exception is the hardest kind of defect to notice
  // and the exact "we shipped it and it doesn't appear" shape. Now the same
  // list drives both, in one pass, so the two cannot disagree.
  //
  // Deliberately NOT derived from `availableProviders` alone: the zeroed
  // shape must include providers the user has NO key for, so a caller
  // reading `out.anthropic` for an unkeyed provider gets an empty array
  // rather than `undefined` — that is the difference between "no models"
  // and a TypeError at the reader.
  //
  // Deliberately NOT derived from `raw`'s own keys either: this is the
  // client-side half of the v3.0.13 key gate, and a list of providers taken
  // from the payload would let the payload decide what the gate covers.
  const known = ['gemini', 'anthropic', 'openrouter'];

  const rawIsUsable = !!raw && typeof raw === 'object';
  for (const p of known) {
    out[p] = [];
    if (!rawIsUsable) continue;
    if (!Array.isArray(availableProviders) || !availableProviders.includes(p)) continue;
    if (!Object.hasOwn(raw, p)) continue;
    const list = raw[p];
    if (!Array.isArray(list)) continue;
    // Keep only entries that carry the two fields every row is keyed on. A
    // half-formed entry is dropped rather than rendered with blanks: this
    // catalogue is the reason a user can trust the prices beside it.
    out[p] = list.filter(e => e && typeof e === 'object'
      && typeof e.id === 'string' && e.id.length > 0
      && (e.provider === p || e.provider === undefined));
  }
  return out;
}

/** Flat, provider-ordered list of every entry the user may actually pick. */
function offerableEntries(offerable, availableProviders) {
  const providers = Array.isArray(availableProviders) ? availableProviders : [];
  const list = [];
  for (const p of providers) {
    const rows = offerable && Object.hasOwn(offerable, p) ? offerable[p] : null;
    if (Array.isArray(rows)) for (const e of rows) list.push({ provider: p, entry: e });
  }
  return list;
}

/**
 * Validate a stored/clicked model id against the LIVE, key-scoped catalogue.
 * Returns `{ provider, entry }` or null. This is the single selection gate:
 * an id belonging to a provider with no saved key resolves to null, so a
 * stale localStorage value from before a Disconnect can never be applied.
 */
function resolveChatModel(modelId, offerable, availableProviders, preferProvider) {
  if (typeof modelId !== 'string' || !modelId) return null;
  const rows = offerableEntries(offerable, availableProviders);
  // ── A MODEL ID IS NOT UNIQUE ACROSS PROVIDERS ────────────────────────────
  // `offerable` is a map keyed by provider, so nothing stops the same id
  // appearing under two of them — and a bare-id walk returns whichever provider
  // comes FIRST in `availableProviders`, not the one the user clicked. On a
  // menu that groups by provider and prints a price per row, that is a row
  // badged one vendor selecting another vendor's model and quoting the wrong
  // price. So a caller that KNOWS which row was clicked says so, and its answer
  // wins; the bare-id path below is unchanged for the callers that only have an
  // id (a restored localStorage value, a recents entry).
  //
  // DEFENCE IN DEPTH, not a live defect: every one of the 198 synced catalogue
  // ids carries a `vendor/` prefix and no built-in id does, so no collision
  // exists against today's real API. This makes the frontend half unable to
  // produce one if that ever stops being true.
  //
  // A named provider is EXCLUSIVE — no fall-through to the bare-id walk. The
  // hint only ever comes from a row rendered out of the live catalogue in the
  // same frame, so "named, and not there" means the catalogue moved under the
  // menu, and quietly serving a same-named model from a different vendor at a
  // different price is precisely the substitution this exists to stop. Refusing
  // costs one click; both callers already handle a refusal.
  if (typeof preferProvider === 'string' && preferProvider) {
    for (const row of rows) {
      if (row.provider === preferProvider && row.entry.id === modelId) return row;
    }
    return null;
  }
  for (const row of rows) {
    if (row.entry.id === modelId) return row;
  }
  return null;
}

// ── THE WORKING SET ───────────────────────────────────────────────────────
//
// ── THE PROBLEM, MEASURED ────────────────────────────────────────────────
// A synced OpenRouter catalogue puts ~194 rows in this menu beside the 19 the
// project hand-measured. The two built-in provider groups are 7 rows each and
// sit above a scroll of two hundred — so the models we actually know something
// about are the hardest ones in the list to reach.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
// It is NOT a shortlist of "good" models, and there is deliberately no
// capability ranking, no fast/smart/cheap character label, and no "recommended"
// tier anywhere in this file. v3.16.0 measured why: `z-ai/glm-4.7` passes every
// structural filter, is FAST, and returned 0 usable outlines in 9 runs;
// `minimax/minimax-m3` failed 9/9 while its own FREE sibling passed 8/9. Price,
// size, recency and vendor all pointed the wrong way. We hold capability data
// for 19 of 213 ids. A ranking built from anything else would be a confident
// lie on a spending surface.
//
// ── WHAT IT IS ───────────────────────────────────────────────────────────
// A set assembled from four facts, none of which is a judgement about a model:
//
//   1. THE CURRENT SELECTION. Always present, even if it is in no other tier —
//      a picker that cannot show you what is selected is broken.
//   2. STARRED. The user said so.
//   3. RECENT. The user did so.
//   4. MEASURED (`measuredBy` — 'curator' or 'user'). A fact about OUR testing,
//      not about the model: 'curator' means this project ran it against the real
//      ingest prompt, 'user' means this installation probed it on its own pages.
//      `null` means UNMEASURED, never BAD — and an unmeasured model is one click
//      away, never removed.
//
// ── AND IT ONLY EXISTS WHEN IT SAVES ANYTHING ────────────────────────────
// Below `WORKING_SET_COLLAPSE_ABOVE` the whole catalogue is shown, so a user
// with only the built-in providers (7, 14 or 19 rows) sees every model at once
// and never meets a "browse all" affordance that leads to the list they are
// already looking at. The collapse is a consequence of a 200-row catalogue,
// not a permanent gate on the product.
const WORKING_SET_COLLAPSE_ABOVE = 24;
// Recents are capped; the measured tier deliberately is NOT. The measured tier
// is small, fixed and stable, and truncating it would mean hiding one of the
// few models we can say anything grounded about. Recents are a rolling window
// by nature — an eighth one displaces the first.
const MAX_RECENTS = 6;
// A generous cap on an explicit user list, present only so a corrupted or
// adversarially-large stored value cannot make this menu unbounded.
const MAX_STARRED = 40;

/**
 * A stored id list, defensively. Returns a plain array of unique, non-empty
 * strings, capped — or `[]` for anything else at all.
 *
 * EVERY failure mode lands on `[]`: absent key, localStorage throwing (private
 * mode, blocked site data), invalid JSON, an object where an array was stored,
 * an array of numbers, a hand-edited file. `[]` degrades the working set to its
 * measured tier, which is the safe direction — the alternative is a picker that
 * throws while rendering the composer.
 *
 * NOTHING HERE INDEXES AN OBJECT BY A STORED STRING, which is what keeps
 * `__proto__` and `constructor` inert: ids only ever reach `Array.includes`,
 * `Set.has` and `resolveChatModel`'s `===` walk over catalogue entries. A stored
 * `"__proto__"` is simply an id no catalogue entry has, so it resolves to
 * nothing and is dropped by `buildWorkingSet`'s own membership test.
 */
function parseIdList(raw, cap) {
  let parsed = null;
  try { parsed = JSON.parse(String(raw == null ? '' : raw)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  const seen = new Set();
  for (const v of parsed) {
    if (typeof v !== 'string' || !v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

/** Move `id` to the front of a recents list, capped. Pure — returns a new array. */
function pushRecent(list, id, cap) {
  if (typeof id !== 'string' || !id) return Array.isArray(list) ? list.slice(0, cap) : [];
  const rest = (Array.isArray(list) ? list : []).filter(v => typeof v === 'string' && v && v !== id);
  return [id, ...rest].slice(0, cap);
}

/** Add or remove `id`. Pure — returns a new array. */
function toggleStar(list, id, cap) {
  const cur = Array.isArray(list) ? list.filter(v => typeof v === 'string' && v) : [];
  if (typeof id !== 'string' || !id) return cur.slice(0, cap);
  if (cur.includes(id)) return cur.filter(v => v !== id);
  return [id, ...cur].slice(0, cap);
}

/**
 * The working set, in CATALOGUE ORDER.
 *
 * ORDER IS THE CATALOGUE'S, NOT THE RECENCY LIST'S, and that is deliberate: a
 * menu whose rows move every time you use it is a menu you have to re-read every
 * time you open it. Membership changes with use; position does not. Each row
 * carries `reasons` so the row can say WHY it is here without the list
 * re-sorting itself around that.
 *
 * @returns {{rows: Array, collapsed: boolean, total: number}}
 *   `collapsed: false` means the caller should render every entry — either the
 *   catalogue is small enough to show whole, or the working set would not
 *   actually be smaller (a fresh install where every model is measured), in
 *   which case offering "browse all" would lead to the list already on screen.
 */
function buildWorkingSet(all, opts) {
  const entries = Array.isArray(all) ? all : [];
  const o = opts || {};
  const recents = new Set(Array.isArray(o.recents) ? o.recents : []);
  const starred = new Set(Array.isArray(o.starred) ? o.starred : []);
  const selectedId = typeof o.selectedId === 'string' && o.selectedId ? o.selectedId : null;
  const total = entries.length;

  const rows = [];
  for (const row of entries) {
    const id = row && row.entry ? row.entry.id : null;
    if (!id) continue;
    const reasons = [];
    if (selectedId && id === selectedId) reasons.push('selected');
    if (starred.has(id)) reasons.push('starred');
    if (recents.has(id)) reasons.push('recent');
    const by = row.entry.measuredBy;
    if (by === 'curator' || by === 'user') reasons.push('measured');
    if (reasons.length) rows.push({ ...row, reasons });
  }

  // Two independent reasons NOT to collapse, and each has to hold on its own:
  //   • the catalogue is small enough to read whole; or
  //   • the working set is not actually smaller than it, so the fold would buy
  //     the user nothing and cost them a click.
  //
  // ── THE EMPTY WORKING SET USED TO LAND HERE, AND THAT WAS INVERTED ──────
  // A third clause read `|| rows.length === 0`, on the reasoning that with no
  // fact to select on, showing everything is the only honest answer. It is the
  // honest answer at 7 models. At 211 it puts the WHOLE CATALOGUE into a
  // composer dropdown — the one case the collapse exists for — and it is
  // reachable without anything being broken: a backend too old to send
  // `measuredBy`, on a fresh browser profile with no stars and no recents,
  // before the first message is sent. The fail-safe direction is the other
  // one: an empty working set with a large catalogue collapses to nothing but
  // the "Browse all N models…" row, which leads somewhere that can actually
  // handle 211 rows (search, filters, a scroll container that is not a menu).
  // Nothing is hidden — the browse dialog holds every model — and the size
  // gate above still shows a small catalogue whole.
  if (total <= WORKING_SET_COLLAPSE_ABOVE || rows.length >= total) {
    return { rows: entries.map(r => ({ ...r, reasons: [] })), collapsed: false, total };
  }
  return { rows, collapsed: true, total };
}

/**
 * Filter the whole catalogue for the browse dialog.
 *
 * THREE PREDICATES, AND ALL THREE ARE FACTS THE PROVIDER TOLD US: a substring
 * of the id or label, the provider that serves it, and whether it bills nothing
 * (`entry.free === true` — llm.js's own flag, never a ":free" id substring,
 * which its docblock records is not a safe membership test).
 *
 * THERE IS DELIBERATELY NO CAPABILITY OR SPEED FILTER. We hold latency for 6 of
 * 213 ids and quality data for none of the fetched ones, so such a filter would
 * either hide almost everything or sort on a proxy this project has measured to
 * be wrong. Price is displayed on every row and is never a filter for the same
 * reason v3.16.0 refused to make it a gate: it is the USER'S trade-off to make.
 */
function filterCatalogue(all, opts) {
  const entries = Array.isArray(all) ? all : [];
  const o = opts || {};
  const q = typeof o.q === 'string' ? o.q.trim().toLowerCase() : '';
  const provider = typeof o.provider === 'string' && o.provider ? o.provider : null;
  const freeOnly = o.freeOnly === true;
  return entries.filter(row => {
    if (!row || !row.entry) return false;
    if (provider && row.provider !== provider) return false;
    if (freeOnly && row.entry.free !== true) return false;
    if (!q) return true;
    const id = String(row.entry.id || '').toLowerCase();
    const label = String(row.entry.label || '').toLowerCase();
    return id.includes(q) || label.includes(q);
  });
}

/**
 * The friendly display name for a model id, resolved against the live
 * key-scoped catalogue.
 *
 * A model the catalogue cannot describe falls back to its RAW ID rather than
 * to null or to some other model's name: the server told us this id answered,
 * and naming it unrecognisably is honest where relabelling it would not be.
 * Returns null ONLY for a missing/blank id — "we were not told" is a distinct
 * fact from any label, and its caller renders the neutral provider name.
 */
function modelDisplayLabel(modelId, offerable, availableProviders) {
  if (typeof modelId !== 'string' || !modelId) return null;
  const row = resolveChatModel(modelId, offerable, availableProviders);
  return row ? (row.entry.label || row.entry.id) : modelId;
}

/**
 * The provider name to show when no model is recorded for a message.
 *
 * `Object.hasOwn` rather than a bare index: `PROVIDER_LABELS['__proto__']`
 * returns Object.prototype, which is truthy, and would render the literal
 * text `[object Object]` as a provider name.
 */
function neutralProviderLabel(ctx) {
  const c = ctx || {};
  for (const p of [c.modelProvider, c.activeProvider]) {
    if (typeof p === 'string' && p) {
      return Object.hasOwn(PROVIDER_LABELS, p) ? PROVIDER_LABELS[p] : p;
    }
  }
  return 'The Curator';
}

/**
 * What to say about ONE assistant message: which model actually answered it,
 * and whether that differs from the model that was asked for.
 *
 * ── WHY THIS READS THE MESSAGE AND NEVER THE COMPOSER ────────────────────
 * Until v3.13.1 the eyebrow was computed ONCE per render from
 * `state.chatModel` — the composer's CURRENT selection — and stamped onto
 * every assistant message in the thread. That was wrong twice over:
 *
 *   1. It reported the REQUEST, not the OUTCOME. `applyModelOverride` falls
 *      back rather than throwing (deliberately: a refused model must not kill
 *      a chat turn), so a refused pick was served by the provider default
 *      while the UI kept claiming the pick. That is this repo's named
 *      dead-data shape, and specifically the `M3b` case — re-deriving the
 *      model instead of reporting the measured one passes every refusal test
 *      and fails only the fallback-walk. The server has always returned the
 *      truth: `sendMessage`'s `model` field is captured from the provider's
 *      own usage payload via `onUsage`. Nothing read it.
 *   2. It was per-THREAD. `renderThreadOnly` rebuilds the whole thread from
 *      `state.thread` on every send, so changing the dropdown relabelled
 *      HISTORICAL answers with a model that never saw them.
 *
 * So: the model is a property of the message. A message with no recorded
 * model renders the neutral provider name — NEVER the current selection,
 * because that fallback IS the bug — and no divergence is claimed, because
 * with nothing recorded there is nothing to compare.
 *
 * Divergence needs BOTH facts, and `requestedModel` is only ever recorded by
 * the live send (the conversation record does not carry it), so a message
 * replayed from history shows its model without a fallback notice. That is
 * the honest limit: we can say what answered, not what was asked, once the
 * turn is over.
 */
function describeAnswerModel(m, ctx) {
  const c = ctx || {};
  const used = m && typeof m.model === 'string' && m.model ? m.model : null;
  const requested = m && typeof m.requestedModel === 'string' && m.requestedModel ? m.requestedModel : null;
  if (!used) {
    return { label: neutralProviderLabel(c), usedModel: null, requestedLabel: null, diverged: false };
  }
  const diverged = !!requested && requested !== used;
  return {
    label: modelDisplayLabel(used, c.offerable, c.availableProviders),
    usedModel: used,
    requestedLabel: diverged ? modelDisplayLabel(requested, c.offerable, c.availableProviders) : null,
    diverged,
  };
}

/**
 * The four token counts recorded on ONE message, or null.
 *
 * Mirrors `normalizeReportedUsage` in src/brain/chat.js, which is what decides
 * whether the record gets written in the first place — but this side must
 * re-check rather than trust, because a conversation JSON is a file on disk that
 * syncs between machines and can be hand-edited in Obsidian. ALL FOUR or
 * nothing, for the reason given there: the four counts carry four different
 * rates, so three of them priced as if they were four is a confidently wrong
 * number that looks exactly like a right one.
 *
 * Zero is a REPORT, not an absence (`Number.isFinite`, never truthiness).
 * Negative is refused — nothing emits one and it would subtract from a bill.
 */
function messageUsageTokens(m) {
  const u = m && typeof m.usage === 'object' && m.usage ? m.usage : null;
  if (!u) return null;
  const out = {};
  for (const f of ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cacheWriteTokens']) {
    const v = u[f];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    out[f] = v;
  }
  // Zero-in AND zero-out is the "provider reported nothing" sentinel, not a
  // measurement — llm.js's normalizers coerce every missing field to 0, and a
  // completed chat turn cannot have consumed zero input (the prompt carries the
  // schema plus thousands of characters of wiki context). Recording it server-
  // side is refused for the same reason; this side refuses it too so a
  // hand-edited or synced conversation file cannot make a paid answer render as
  // exactly $0.00. See normalizeReportedUsage in src/brain/chat.js.
  if (out.inputTokens === 0 && out.outputTokens === 0) return null;
  // The fifth field, OPTIONAL by the same rule the store applies (see
  // normalizeReportedUsage in src/brain/chat.js): only OpenRouter reports it,
  // so requiring it would erase every cost figure on Anthropic and Gemini.
  // Omitted rather than defaulted to 0, so "not reported" and "no reasoning"
  // stay two different facts and the breakdown can decline to claim either.
  const r = u.reasoningTokens;
  if (typeof r === 'number' && Number.isFinite(r) && r >= 0) out.reasoningTokens = r;
  return out;
}

/**
 * What ONE assistant message cost, in USD, or null when we cannot say.
 *
 * ── EVERY MISSING COMPONENT RETURNS null, NEVER A PARTIAL FIGURE ─────────
 * Three independent things must all be present: the token counts, a recorded
 * SERVED model, and a live published price for that model. Any one absent and
 * the caller renders nothing at all. Specifically NOT rendered:
 *
 *   • a message from before this feature (no `usage` key) — every existing
 *     conversation in every existing wiki is this case;
 *   • a message whose model we do not ship a price for, or whose provider the
 *     user has since Disconnected (the catalogue arrives key-scoped, so its
 *     entries simply are not there);
 *   • anything estimated from character counts or message length. There is no
 *     estimate path in this function on purpose. A plausible number on a money
 *     surface is worse than a blank, because a blank is legible as "unknown"
 *     and a wrong number is not.
 *
 * ── THE ARITHMETIC IS A DELIBERATE MIRROR, NOT AN INVENTION ──────────────
 * The formula is `chargeForItem` in src/brain/ingest-queue.js — the app's
 * existing, shipped answer to "what did these tokens cost", including both
 * Anthropic cache multipliers (0.1x read, 1.25x write). It is MIRRORED here
 * rather than imported for one reason: that module is server-side, imports
 * llm.js and the filesystem, and this file runs in a browser. It cannot be
 * imported, so the honest options were a mirror or a second formula, and a
 * second formula is how this repo produced its v3.2.0 CRITICAL.
 *
 * A mirror is only safe if something can see it drift, so the drift is MEASURED
 * rather than promised: scripts/test-next-composer-model.js imports the real
 * `chargeForItem` out of ingest-queue.js's `__testing` surface and asserts this
 * function agrees with it to the last bit across a matrix generated from the
 * real catalogue. Change either one alone and that goes red naming the case.
 *
 * ⚠ THE MIRROR IS CURRENTLY BROKEN ON PURPOSE, AND ONLY IN ONE DIRECTION.
 * `chargeForItem` still applies Anthropic's 0.1x cached-read multiplier to
 * EVERY provider — the same defect measured below, in the server-side path that
 * feeds the ingest batch queue's BUDGET CAP, where under-counting does not just
 * mis-report a figure but lets a batch overshoot the ceiling the user set. It
 * was not fixed here because that module was owned by another workstream in
 * this release. §11.1 no longer asserts blanket equality on the cache terms:
 * it asserts equality wherever the cache terms are zero (every case that
 * existed before this change), and pins the divergence to EXACTLY this known
 * bug with a tracker that goes RED the day `chargeForItem` is fixed — telling
 * whoever fixes it to delete the tracker and restore plain equality. Do not
 * "repair" the mirror by reinstating the universal 0.1x here; that would make
 * two files agree on a wrong number, which is what let this ship.
 *
 * ── PRICE AT RENDER TIME, AND THE ONE APPROXIMATION IN IT ────────────────
 * `entry.input` / `entry.output` are the LIVE, promotion-resolved figures
 * (llm.js resolves them per-request through getters, so the JSON the client
 * receives already carries today's price) — never `standardInput` /
 * `standardOutput`, which are what two Gemini models will cost from 2027-01-01
 * and would over-report their cost by 2x today.
 *
 * The consequence, stated rather than hidden: a turn served during a promotion
 * and re-read after it ends prices at the standing rate — higher than it
 * actually cost. That is the safe direction under this repo's rule that a price
 * failure resolves upward, and it is the price of not freezing a dollar figure
 * into a conversation record. See src/brain/chat.js's `usage` comment.
 *
 * ── THE CACHE MULTIPLIER IS PER-PROVIDER — MEASURED, NOT INHERITED ───────
 * This block used to record `cachedReadTokens * price.input * 0.1` as a known
 * approximation "inherited deliberately and unchanged from `chargeForItem`".
 * It was not an approximation. It was a MONEY DEFECT, and it has now been
 * measured against real credit-balance deltas on OpenRouter:
 *
 *   cold cache (0 cached)        app $0.00007191   actual $0.00007191  exact
 *   warm cache (1280+1920 cached) app $0.00148150   actual $0.00320950  2.17x under
 *
 * The cold run is the POSITIVE CONTROL: it proves the input/output rates and
 * the measurement harness are right, so the warm gap is the cache term alone.
 * A full-price-cache model predicts $0.00320950 to eight decimal places, and
 * the implied input rate falls out at exactly $0.60/Mtok — `kimi-k2-0905`'s
 * published price. OPENROUTER BILLS CACHED READS AT FULL INPUT PRICE.
 *
 * 0.1x is ANTHROPIC's number and Anthropic's alone (their own docs: cached read
 * ~0.1x, cache write ~1.25x of base input). Applying it to every provider
 * silently under-reported every multi-turn OpenRouter chat by up to 2.17x — on
 * the one surface whose entire purpose is letting a user see what an answer
 * cost. Under-reporting on a spending surface is the failure direction this
 * repo's own rule forbids (v3.9.0: an unrecognised cost tier resolves to
 * 'unknown', never 'similar'), so the multiplier is now resolved from the
 * SERVED model's provider by `cacheMultipliers` below, and anything we have
 * not verified charges FULL price rather than a flattering guess.
 *
 * ── A FREE MODEL NEVER REACHES THE PRICED BRANCH — MADE EXPLICIT ─────────
 * `chargeForItem`'s own fix (src/brain/ingest-queue.js) states the rule this
 * mirror must hold too: "MEMBERSHIP BEATS ANY PRICE THAT MIGHT EVER BE TYPED"
 * — the free check runs FIRST, ahead of the priced branch, so a free model can
 * never be billed even if a price were ever mistakenly typed for one. This
 * function already could not compute a positive figure for a free model —
 * `defineOfferableModel` (llm.js) refuses to register a numeric price for a
 * free entry, so `entry.input`/`entry.output` are `null` and the type guard
 * two lines below already returns null — but that safety was IMPLICIT,
 * riding on a data-contract promise made elsewhere rather than stated here.
 * The explicit `row.entry.free === true` check below makes it a property of
 * THIS function, matching `chargeForItem`'s ordering exactly, so a future
 * change to how free models carry their price cannot silently reopen this.
 *
 * Returns `null`, deliberately not `0` — the ONE proven divergence from
 * `chargeForItem` (which returns a true `0`, correct for a running batch
 * total, where zero is the neutral element). A per-answer readout is not a
 * running total: `0` here would be indistinguishable from a genuine `$0.00`,
 * which is exactly the ambiguity `formatUsdHonest` and the `{0,0,0,0}`
 * sentinel guard above both exist to prevent. `assistantCostHtml` is what
 * turns this `null` into the word "free" — see its own docblock.
 */
/**
 * What ONE provider charges for a cached-read token and a cache-write token,
 * expressed as a multiple of that model's BASE INPUT rate.
 *
 * ── WHY THIS IS A FUNCTION AND NOT TWO CONSTANTS ─────────────────────────
 * Because the two numbers are NOT a property of caching, they are a property
 * of the PROVIDER, and treating them as universal is what produced a measured
 * 2.17x under-report on every multi-turn OpenRouter chat (see
 * `messageCostUsd`'s docblock for the paired cold/warm measurement). A named
 * function is also the only shape a test can drive per provider; two inline
 * literals could only ever be checked by reading them.
 *
 * ── ANTHROPIC: 0.1x / 1.25x, FROM THE PROVIDER'S OWN DOCUMENTATION ───────
 * `cache_read_input_tokens` bills at ~0.1x base input and
 * `cache_creation_input_tokens` at ~1.25x. This is the ONLY provider whose
 * cache rates this project has a published source for, and the only one that
 * gets a discount here.
 *
 * ── EVERYONE ELSE: FULL PRICE ON READS, AND THAT IS THE POINT ────────────
 * OpenRouter is MEASURED at full price. Gemini's implicit cache is NOT
 * measured — its real discount is neither 1.0x nor 0.1x, and inventing a
 * third number from memory is exactly the move that put the wrong constant in
 * this file in the first place. So an unverified provider charges FULL price:
 * over-stating a bill sends a user to a cheaper model than they needed, while
 * under-stating one tells them a paid answer was nearly free. Only the second
 * is a lie the user cannot detect. When a provider's rate is measured the way
 * OpenRouter's was — a cold run as the control, a warm run as the case, both
 * against a real balance delta — add it here with the numbers in the comment,
 * not from a spec sheet.
 *
 * ── WRITES STAY AT 1.25x EVERYWHERE, DELIBERATELY ────────────────────────
 * Only Anthropic's write rate is published, but 1.25 > 1.0, so applying it
 * universally errs UPWARD — the same direction llm.js's `normalizeOpenRouterUsage`
 * already reasons about explicitly when it declines to subtract
 * `cache_write_tokens` from `prompt_tokens`. Dropping it to 1.0 for unverified
 * providers would be a second under-report introduced while fixing the first.
 * Chat sends no cache breakpoint at all, so Anthropic and Gemini report 0 here
 * regardless; OpenRouter can report a non-zero write, and it is billed high.
 *
 * An unknown/absent provider takes the same full-price path as any unverified
 * one — fail-safe, never a discount by default.
 */
function cacheMultipliers(provider) {
  if (provider === 'anthropic') return { read: 0.1, write: 1.25 };
  return { read: 1, write: 1.25 };
}

function messageCostUsd(m, ctx) {
  const u = messageUsageTokens(m);
  if (!u) return null;
  const modelId = m && typeof m.model === 'string' && m.model ? m.model : null;
  if (!modelId) return null;
  const c = ctx || {};
  // The SERVED model — `m.model` is what the provider reported, never
  // `ctx.chatModel` (the composer's current pick) and never `m.requestedModel`.
  // On a fallback walk those differ and the walk is where it matters most: it
  // can move a user ONTO a costlier model, so pricing the request would
  // under-report the bill in exactly the case they did not choose.
  //
  // Resolved through the same key-scoped lookup the LABEL uses, so the price and
  // the name beside it can never come from two different catalogue walks.
  const row = resolveChatModel(modelId, c.offerable, c.availableProviders);
  if (!row || !row.entry) return null;
  // Membership first, ahead of the priced branch — see the docblock above.
  if (row.entry.free === true) return null;
  const input = row.entry.input;
  const output = row.entry.output;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) return null;
  if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) return null;
  // ── chargeForItem's formula, with the cache terms resolved per PROVIDER ──
  // `row.provider` — the provider of the SERVED model, from the same key-scoped
  // walk that produced the price two lines up, so the rate and the multiplier
  // applied to it can never come from two different catalogue entries.
  const mult = cacheMultipliers(row.provider);
  const inCost = (u.inputTokens || 0) / 1e6 * input;
  const outCost = (u.outputTokens || 0) / 1e6 * output;
  const cachedReadCost = (u.cachedReadTokens || 0) / 1e6 * input * mult.read;
  const cacheWriteCost = (u.cacheWriteTokens || 0) / 1e6 * input * mult.write;
  const total = inCost + outCost + cachedReadCost + cacheWriteCost;
  return Number.isFinite(total) ? total : null;
}

/**
 * The cost figure as a DISCLOSURE: the button, then its panel.
 *
 * Top-level rather than a closure inside `assistantCostHtml` for two reasons.
 * It is the piece worth asserting on its own — the ARIA wiring, the escaping
 * and the accessible name are the whole point of the conversion — and
 * test-next-composer-model.js's §0 extraction resolves every call an extracted
 * helper makes, so a nested helper is a name it cannot bind and the suite
 * would go red (correctly) rather than silently exercise a different shape.
 *
 * ── THE MID-DOT IS OUTSIDE THE BUTTON, ON PURPOSE ────────────────────────
 * It is the eyebrow's own punctuation, not part of the control, and keeping it
 * out is what makes the accessible name CONTAIN the visible label exactly
 * ("$0.01" inside "$0.01 — token breakdown"), which WCAG 2.5.3 asks for.
 *
 * ── NO BEHAVIOUR IS IMPLEMENTED HERE ─────────────────────────────────────
 * `data-tx-info` is the attribute shared/text.js's ONE delegated listener keys
 * on — the same listener the view headers use, installed at module scope. It
 * gives Escape-closes-and-returns-focus, outside-click dismiss, and
 * click-inside-is-left-alone for free. Writing a second listener here is how
 * the two surfaces would drift into two answers about the same interaction.
 *
 * Everything interpolated is escaped: `title` is built from integers, `text`
 * from the shared money formatter, and `panelId` from an array index — but
 * they pass through `escapeHtml` regardless, because a formatter that becomes
 * caller-supplied later must not silently become an injection point.
 *
 * @param {string} panelId unique within one paint of one thread
 * @param {string} title   the token breakdown, e.g. "998 in / 247 out tokens"
 * @param {string} text    the visible figure, e.g. "$0.01" or "free"
 */
function costMarkHtml(panelId, title, text) {
  return (
    ' · ' +
    '<button type="button" class="chat-msg-cost" id="' + escapeHtml(panelId) + '-btn"' +
      ' data-tx-info="' + escapeHtml(panelId) + '"' +
      ' aria-expanded="false" aria-controls="' + escapeHtml(panelId) + '"' +
      ' aria-label="' + escapeHtml(text + ' — token breakdown') + '"' +
      ' title="' + escapeHtml(title) + '">' +
      escapeHtml(text) +
    '</button>' +
    // chat.css owns this panel's box outright rather than borrowing the view
    // header's. The header component owns the tx- prefix (a suite enforces
    // it), so a VIEW hand-writing one of its class names couples chat.js to
    // another component's internals; this repo's own rule for the same
    // situation in views/sync.js is "own class, own copy". The two panels are
    // also genuinely different sizes: that one hangs off a page heading, this
    // one off one line of an eyebrow.
    '<div class="chat-cost-panel" id="' + escapeHtml(panelId) + '" role="group"' +
      ' aria-label="Token breakdown" hidden>' + escapeHtml(title) + '</div>'
  );
}

/**
 * The cost fragment appended to one message's eyebrow, or '' when there is
 * nothing we can honestly say.
 *
 * THREE states, not two — `messageCostUsd` returning `null` collapses two
 * DIFFERENT facts (v3.14.0's whole point is that a user can compare what each
 * answer cost, so collapsing them defeats the release on its own surface):
 *
 *   • the served model is FREE (a known, exact fact — zero, by membership)
 *   • the cost is UNKNOWN (no usage recorded, no served model, an unpriced
 *     model, or a Disconnected provider's model — "we were not told")
 *
 * Free is decided by resolving the message's SERVED model through the exact
 * same lookup `messageCostUsd` uses (`resolveChatModel`) and reading its
 * `free` flag — the same and ONLY test `formatLivePrice` uses for the menu.
 * Never a price of 0 (a free entry's price is `null` by design, precisely so
 * a truthy `{input:0,output:0}` can never be read as "priced" — the v3.3.0
 * shape), never a provider id, never an id substring.
 *
 * The {0,0,0,0} "provider reported nothing" sentinel is refused BEFORE this
 * lookup runs (`messageUsageTokens` returns null for it first), so a free
 * model can never borrow that refusal's silence to render "free" over a turn
 * we simply were not told about.
 *
 * Returning '' for the unknown case — not '$0.00', not '—', not 'cost
 * unknown' — is unchanged: an unknown cost still renders as the absence of a
 * cost. A genuinely free one renders as the word "free", never as a dollar
 * figure and never as "$0.00" (that string is reserved for a value we were
 * not told, per format-usd.js's own rule — a free answer is a measurement,
 * not an estimate that happens to round to nothing).
 *
 * Deliberately QUIET: a mid-dot and a figure (or the word "free") on the
 * eyebrow line that already names the model, in the eyebrow's own muted tone.
 * Not a badge, not a colour, not a second money surface — the composer
 * already carries the qualitative "cost varies with response length" hint,
 * and two spend readouts arguing for attention in one column would make the
 * factual one look like an alarm.
 *
 * ── THE TOKEN BREAKDOWN IS A CONTROL, NOT A TOOLTIP ──────────────────────
 *
 * The counts behind the figure — "998 in / 247 out tokens" — used to live in
 * a `title=` on a <span>. A `title=` on a non-focusable element is HOVER-ONLY:
 * a keyboard user never reaches it, and on touch there is no hover at all, so
 * the string does not exist. v3.20.0 counted 11 such strings in this tree and
 * named THIS ONE the worst of them, because it is the only one that justifies
 * a dollar figure — the arithmetic behind a spend claim, unreachable to
 * anyone not holding a mouse.
 *
 * It is now the v3.22.0 affordance: a real focusable <button> revealing a
 * panel that is `hidden` on first paint, Escape closes it and RETURNS FOCUS to
 * the button, an outside click dismisses it and a click inside does not. None
 * of that behaviour is reimplemented here — the button carries `data-tx-info`
 * and shared/text.js's ONE delegated listener (installed at module scope, and
 * already imported by this file for renderViewHeader) does the work. A second
 * copy of that listener is how the two surfaces would drift into two answers.
 *
 * ── WHY A PER-MESSAGE CONTROL IS RIGHT HERE AND WAS WRONG ELSEWHERE ──────
 *
 * A previous pass correctly DECLINED to convert a tooltip rendered ~192 times
 * in the model picker, and left the fact stated once for the group instead.
 * That reasoning does not transfer, and the difference is what decides it:
 * there the string was IDENTICAL on every row, so stating it once was strictly
 * better. Here it is per-message DATA — this answer's own token counts — so
 * "state it once" does not exist as an option. The choice is a control, or the
 * information stays unreachable.
 *
 * THE TAB-STOP COST WAS MEASURED, NOT WAVED AWAY. Every assistant message in
 * this thread ALREADY contributes tab stops: one per citation chip plus the
 * re-ask button. This adds ONE more to an existing group of up to eight, at
 * the START of the message where a reader arrives at it before the answer
 * rather than after it. It is also emitted only where there is something to
 * disclose — `assistantCostHtml` returns '' for every message with no usage,
 * no served model or no live price, so a thread of unpriced answers gains no
 * stops at all.
 *
 * ALWAYS-VISIBLE COUNTS WERE THE OTHER CANDIDATE AND WERE REJECTED. Rendering
 * "998 in / 247 out" as text costs zero tab stops and reaches everyone — but
 * it doubles the length of a line whose stated design is to be quiet, and
 * turns the most detailed thing in the column into the always-on one. A
 * disclosure is the shape for "available on demand"; that is what this is.
 *
 * `title=` IS KEPT ON THE BUTTON, deliberately. It is now on a FOCUSABLE
 * element, so it is no longer the hover-only defect, and dropping it would
 * take instant-hover away from mouse users to fix a problem they never had.
 * Both strings come from the same `title` variable, so they cannot disagree.
 *
 * `aria-label` restates the visible figure before naming the disclosure
 * ("$0.01 — token breakdown") so the accessible name CONTAINS the visible
 * label (WCAG 2.5.3). The mid-dot separator stays OUTSIDE the button: it
 * belongs to the eyebrow's punctuation, not to the control, and keeping it out
 * is what makes that containment exact.
 *
 * @param {number} [index] the message's index in the thread, which is what
 *   makes the panel id unique. Defaults to 0 so a two-argument call — which
 *   every offline suite makes — still produces a well-formed pair.
 */
/*
 * ── THE SENTENCE BEHIND THE DOLLAR FIGURE ────────────────────────────────
 * Built INLINE inside assistantCostHtml below rather than factored into its
 * own function, and that is deliberate rather than lazy: several suites
 * extract `assistantCostHtml` by name into a sandbox with an enumerated
 * binding list, and a helper it called would have to be added to each of
 * those lists — files this change does not own. The behaviour is asserted
 * through assistantCostHtml's real output, which is the surface anyway.
 *
 * ── WHY IT NAMES REASONING, AND WHY IT NAMES "THIS ANSWER" ───────────────
 * Reported by a user comparing two answers to the same question: Sonnet 5
 * "$0.10" beside Flash Lite 2.5 "$0.0024" — 41.7x — where the price table
 * (llm.js MODEL_PRICES_USD_PER_MTOK: $0.10/$0.40 against $2/$10 per Mtok)
 * implies about 21x. The gap is ADAPTIVE THINKING: this app sends no
 * `thinking` parameter, which on Sonnet 5 means the model reasons by default
 * and the provider bills that reasoning inside `output_tokens`. The old
 * breakdown read "19250 in / 6150 out tokens" — every number correct, and
 * none of them able to explain the figure above them, because roughly 4,900
 * of that output was deliberation nobody was shown.
 *
 * "This answer:" is the second half of the same complaint. A thread's later
 * turns cost more than its earlier ones because every previous turn is re-sent
 * as input, so a per-answer figure with no stated scope reads as a running
 * total that is climbing for no reason. Naming the scope costs two words.
 *
 * ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────
 * Say "0 reasoning". `reasoningTokens` is absent on every provider except
 * OpenRouter (Anthropic reports no separate count; Gemini's
 * `thoughtsTokenCount` is not surfaced by its normalizer), and "not reported"
 * is not "none". A missing field produces no clause at all, so this sentence
 * is never the reason someone believes a thinking model did not think.
 * A reported ZERO is equally not printed — there is nothing hidden to
 * disclose — which is why the test is truthiness here and `Number.isFinite`
 * at the two gates that decide whether the field EXISTS.
 *
 * ONE string, used for both the panel body and the `title=` on the control
 * that opens it — the property assistantCostHtml's own docblock already
 * claims ("Both strings come from the same `title` variable, so they cannot
 * disagree").
 */
function assistantCostHtml(m, ctx, index) {
  // ── WHAT IT COST, OR TODAY'S PRICE SAID AS TODAY'S (v3.72.0, F2) ───────
  // A message written from v3.72.0 on carries `priced`, recorded by the
  // server at answer time for the SERVED model (brain/chat.js, P1): what the
  // answer cost THEN. That is the figure shown, and it never moves when a
  // promotion ends or a catalogue re-syncs. A message without it predates
  // the record: its figure can only be computed from TODAY's catalogue, so it
  // is shown AS today's — on the face, not behind the disclosure — and never
  // as what it cost. Validated inline (not in a helper) for the reason the
  // note above gives: suites lift this function by name.
  const pr = m && m.priced && typeof m.priced === 'object' ? m.priced : null;
  const prAt = pr && typeof pr.at === 'string' && Number.isFinite(Date.parse(pr.at)) ? pr.at : null;
  // (No local helper FUNCTIONS in here: test-next-composer-model.js §0
  // resolves every call this function makes against its extraction list.)
  const prOk = !!pr && [pr.costUsd, pr.inPerM, pr.outPerM]
    .every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  const recorded = !pr ? null
    : (pr.free === true && pr.costUsd === 0) ? { free: true }
    : (pr.free === false && prOk) ? { free: false, usd: pr.costUsd, inPerM: pr.inPerM, outPerM: pr.outPerM }
    : null;
  const whenText = prAt ? ' on ' + prAt.slice(0, 10) : '';
  // A rate as the catalogue writes it: at least two decimals, at most four.
  const rates = recorded && !recorded.free
    ? [recorded.inPerM, recorded.outPerM].map((n) => {
      // Rounded to four places by arithmetic, then padded to two — never a
      // `toFixed(4)` money formatter (test-next-composer-model.js §11.7:
      // the per-answer FIGURE comes from formatUsdHonest; this is a RATE).
      const t = String(Math.round(n * 10000) / 10000);
      const dec = t.indexOf('.') === -1 ? '' : t.slice(t.indexOf('.') + 1);
      return '$' + t + (dec === '' ? '.00' : (dec.length < 2 ? '0' : ''));
    })
    : null;
  const usd = recorded ? (recorded.free ? null : recorded.usd) : messageCostUsd(m, ctx);
  const u = messageUsageTokens(m);
  // See the block comment above this function for why this is inline and what
  // each clause is for. `.toLocaleString()` is spelled out at each of the five
  // counts rather than wrapped in a local `tok()` helper — even a local arrow
  // is a call, and test-next-composer-model.js §0's extraction manifest (a
  // static call-graph scan over the functions it sandboxes) would have to name
  // it. Repetition here, in a file this change owns, is cheaper than an entry
  // in a suite it does not.
  //
  // ── THE UNCOUNTED CASE, WHICH IS THE ONE THAT PROMPTED ALL THIS ────────
  // Where the provider reports a reasoning count — OpenRouter's
  // `reasoning_tokens`, Gemini's `thoughtsTokenCount` — the clause carries the
  // NUMBER. Anthropic's usage block has no such field: on a model that reasons
  // by default the thinking is billed inside `output_tokens` and the API never
  // says how much. Saying nothing there would leave the exact answer the user
  // asked about ($0.10 on Sonnet 5) with a breakdown that still cannot explain
  // itself, so the fact is stated WITHOUT a number rather than invented.
  //
  // THE GATE IS `entry.thinks`, llm.js's own MEASURED per-model boolean (set
  // in the model table, carried onto the offerable entry, published by
  // src/routes/config.js) — never a hand-written "Sonnet 5 and Opus 5" list.
  // That list would be WRONG: llm.js records `claude-opus-5` as thinking 0/3
  // while `claude-sonnet-5` thinks 7/7, one release apart. One source, so the
  // note here and the **thinks** badge in the model menu cannot disagree.
  //
  // It is also gated on the count being ABSENT. The day a provider starts
  // reporting one for a thinking model, the number replaces the apology by
  // itself — no second edit, and no risk of the app saying "we do not know"
  // beside a figure it does know. MEASURED, AND RECORDED RATHER THAN
  // OVERCLAIMED: `!u.reasoningTokens` here is DEFENCE IN DEPTH — deleting it
  // leaves the suite green, because the TERNARY below already makes the two
  // clauses mutually exclusive, and it is that structure the guard actually
  // pins (a mutation turning the ternary into a concatenation does go red).
  // The term is kept because it states the rule where the next reader meets
  // it, and because an edit that flattened the ternary would otherwise have
  // nothing upstream saying the two must not co-occur.
  const thinksEntry = (() => {
    const id = m && typeof m.model === 'string' && m.model ? m.model : null;
    if (!id) return null;
    const c = ctx || {};
    const row = resolveChatModel(id, c.offerable, c.availableProviders);
    return row && row.entry ? row.entry : null;
  })();
  const unreportedReasoning = !!u && !u.reasoningTokens &&
    !!thinksEntry && thinksEntry.thinks === true;
  const priceNote = recorded
    ? (recorded.free
      ? ' Priced when answered' + whenText + ': free.'
      : ' Priced when answered' + whenText + ': ' + rates[0] + ' in / ' + rates[1] + ' out per 1M tokens.')
    : ' At today\u2019s price: this answer was written before prices were recorded with each answer.';
  const title = u
    ? 'This answer: ' + Number(u.inputTokens).toLocaleString() +
      ' in / ' + Number(u.outputTokens).toLocaleString() + ' out' +
      (u.cachedReadTokens ? ' / ' + Number(u.cachedReadTokens).toLocaleString() + ' cached' : '') +
      (u.cacheWriteTokens ? ' / ' + Number(u.cacheWriteTokens).toLocaleString() + ' cache write' : '') +
      ' tokens' +
      (u.reasoningTokens
        ? ', of which ' + Number(u.reasoningTokens).toLocaleString() + ' reasoning the model did not show'
        : (unreportedReasoning
          ? '. "Out" includes the model\'s hidden reasoning; this provider does not report how much'
          : '')) +
      '.' + priceNote
    : (recorded ? priceNote.trim() : '');
  // `renderThreadOnly` rebuilds the whole thread with one innerHTML write, so
  // an id only has to be unique WITHIN one paint of one conversation — the
  // message's own index is exactly that. It is not persisted anywhere and no
  // open state survives a rebuild, which is correct: the thread it described
  // has just been replaced.
  const panelId = 'chat-cost-' + (Number.isInteger(index) && index >= 0 ? index : 0);
  if (recorded && recorded.free) return costMarkHtml(panelId, title, 'free');
  if (usd === null) {
    // `messageCostUsd` returned null for one of several reasons (see its own
    // docblock) — free is only ONE of them, and must be checked with the
    // identical resolution it uses so this can never disagree with it about
    // which model is being asked about. `u` (checked above) already proves
    // this is not the {0,0,0,0} sentinel and not a usage-less message.
    if (!u) return '';
    const modelId = m && typeof m.model === 'string' && m.model ? m.model : null;
    if (!modelId) return '';
    const c = ctx || {};
    const row = resolveChatModel(modelId, c.offerable, c.availableProviders);
    if (!row || !row.entry || row.entry.free !== true) return '';
    return costMarkHtml(panelId, title, recorded ? 'free' : 'free today');
  }
  const text = formatUsdHonest(usd);
  // formatUsdHonest returns null for anything that is not a finite number. It
  // cannot happen here (messageCostUsd already guaranteed one), but a formatter
  // that CAN say "no figure" must never have that answer interpolated as the
  // string "null" on a spend line.
  if (text === null) return '';
  return costMarkHtml(panelId, title, recorded ? text : text + ' at today\u2019s price');
}

/**
 * The eyebrow (and, on divergence, the one-line notice under it) for one
 * assistant message.
 *
 * Silent fallback is correct BEHAVIOUR and invisible fallback is a lie about
 * money — the span between the catalogue's dearest and cheapest offerable
 * model is 50x on input and 62x on output — so the notice states plainly what
 * was asked for, what answered, and which of the two the bill follows. It is
 * a fact, not an alarm: no icon, no colour beyond the muted eyebrow tone.
 *
 * Every interpolated value is server- or catalogue-supplied and passes
 * through `escapeHtml`.
 *
 * `index` is threaded through for one reason only: it is what makes the cost
 * disclosure's panel id unique within a paint. It is optional and defaults to
 * 0, so a two-argument call still yields a well-formed button/panel pair.
 */
function assistantEyebrowHtml(m, ctx, index) {
  const d = describeAnswerModel(m, ctx);
  // The cost rides INSIDE the eyebrow, computed from THIS message — same
  // reasoning as the model label directly beside it: `renderThreadOnly` rebuilds
  // the whole thread with one `innerHTML = ...`, so anything derived from
  // view-level state would restamp every historical answer. A relabelled model
  // was the v3.13.2 bug; a re-priced history would be the same bug about money.
  const eyebrow =
    '<div class="chat-msg-eyebrow mono">THE CURATOR · ' + escapeHtml(d.label) +
      assistantCostHtml(m, ctx, index) +
    '</div>';
  if (!d.diverged) return eyebrow;
  return eyebrow +
    '<div class="chat-msg-fallback">' +
      'Requested ' + escapeHtml(d.requestedLabel) + ' — answered by ' + escapeHtml(d.label) +
      '. You are billed for the model that answered.' +
    '</div>';
}

// ── THE MODEL ROW (v3.72.0, P4) ─────────────────────────────────────────────
// The row BODY is shared/model-row.js's `modelRowBodyHtml` — one builder for
// the composer's menu and the browse dialog, so the two lists a user compares
// models across cannot describe one model two ways. What stays here is only
// what this VIEW knows: which row is the default, the listbox/dialog wrappers,
// and the star. The price, promotion and context formatting that used to live
// here (formatPricePerM, formatLivePrice, formatIsoDay, formatPromotionRise)
// moved there whole; nothing about a price is decided in this file.
//
// ── WHAT THE CHAT ROW NO LONGER SAYS, AND WHY ──────────────────────────────
// "caution", "out-performed" and "measured at about Xs per call" were INGEST
// verdicts — timed and judged on a ~300,000-character wiki-outline call — shown
// in a menu that picks who answers a chat question (DESIGN.md M-a, truth audit
// Chat F4). They stay in Settings, where the decision is an ingest one. The
// browse dialog keeps the reason, labelled "For building the wiki:".

/**
 * Whether `provider`/`entry` is the model a question uses when nothing is
 * picked: the BUILD model (a model-less chat turn is answered by it — see
 * chatModelOnScreen). Matched on provider AND id, because two providers may
 * list one id and "default" must name exactly one row.
 */
function isChatDefaultRow(provider, entry) {
  if (!entry || typeof state.buildModelId !== 'string' || !state.buildModelId) return false;
  if (entry.id !== state.buildModelId) return false;
  const bp = typeof state.buildProvider === 'string' && state.buildProvider ? state.buildProvider : null;
  return bp ? provider === bp : true;
}

/** The menu row's body — model-row.js, told which row is the default. */
function renderModelRowBodyHtml(provider, entry, opts) {
  const o = opts || {};
  return modelRowBodyHtml(provider, entry, {
    surface: o.surface === 'browse' ? 'browse' : 'menu',
    isDefault: isChatDefaultRow(provider, entry),
    summary: o.surface === 'browse' ? formatModelSummary(entry, { compact: true }) : '',
  });
}

/**
 * The BROWSE DIALOG's wrapper around the same body: a plain `<button>` (the
 * dialog is a search-results list, not a listbox — each row also carries a
 * star, and a listbox option containing a second control is the
 * v3.0.1-beta.18 hazard). `aria-current`, valid outside a listbox, names the
 * model in use.
 */
function renderModelOptionHtml(provider, entry, selectedId, opts) {
  const isActive = entry.id === selectedId;
  return (
    '<button type="button" class="mr-pick chat-browse-pick' + (isActive ? ' is-active' : '') +
      '"' + (isActive ? ' aria-current="true"' : '') +
      ' data-model-id="' + escapeHtml(entry.id) + '" data-model-provider="' + escapeHtml(provider) + '">' +
      renderModelRowBodyHtml(provider, entry, Object.assign({}, opts || {}, { surface: 'browse' })) +
    '</button>'
  );
}

/**
 * The BROWSE DIALOG's list: one group per KEYED provider, each cheapest-first
 * as the server ordered it. Takes the already-filtered flat row list, so the
 * headings and the rows cannot disagree about what is on screen. '' when
 * nothing is pickable, so the caller can say "no model matches".
 */
function renderModelMenuHtml(rowList, selectedId, opts) {
  const list = Array.isArray(rowList) ? rowList : [];
  const o = opts || {};
  const starred = o.starred instanceof Set ? o.starred : new Set(Array.isArray(o.starred) ? o.starred : []);
  let html = '';
  let rows = 0;
  let lastProvider = null;
  for (const row of list) {
    if (!row || !row.entry) continue;
    if (row.provider !== lastProvider) {
      // An `<li role="presentation">`: valid inside the `<ul>`, and a heading
      // to a screen reader rather than one more model in the count.
      html += '<li class="mr-group" role="presentation">' + escapeHtml(providerWord(row.provider)) + '</li>';
      lastProvider = row.provider;
    }
    const isStarred = starred.has(row.entry.id);
    html += '<li class="chat-browse-row">' +
      renderModelOptionHtml(row.provider, row.entry, selectedId) +
      // THE STAR IS A SIBLING, NOT A CHILD (the v3.13.0 pattern): no control
      // inside a control, so there is no propagation to suppress and none to
      // forget. `aria-pressed` makes it a toggle; the label names the model.
      '<button type="button" class="mr-star' + (isStarred ? ' is-on' : '') + '"' +
        ' data-star-id="' + escapeHtml(row.entry.id) + '"' +
        ' aria-pressed="' + (isStarred ? 'true' : 'false') + '"' +
        ' title="' + (isStarred ? 'Starred — listed first in the Model menu' : 'Star: list this first in the Model menu') + '"' +
        ' aria-label="' + (isStarred ? 'Unstar ' : 'Star ') + escapeHtml(row.entry.label || row.entry.id) + '">' +
        icon('star', 13) +
      '</button>' +
    '</li>';
    rows++;
  }
  return rows ? '<ul class="chat-browse-ul">' + html + '</ul>' : '';
}

// ── THE COMPOSER'S TWO PICKERS, ON THE SHARED LISTBOX ─────────────────────
//
// ── WHAT THIS REPLACED, AND WHY IT HAD TO GO ─────────────────────────────
// A hand-rolled `.chat-dd` menu that carried `role="listbox"` and
// `role="option"` and had ZERO keyboard support: no arrows, no Home/End, no
// Enter, no Escape, no type-ahead, no `aria-activedescendant`. It announced
// itself to a screen reader as a listbox and then behaved like a div. With ~194
// OpenRouter models in it, it was simultaneously the only dropdown in /next
// without keyboard operation and the one that needed it most.
//
// shared/listbox.js was written against exactly this case — contiguous groups,
// per-option rich HTML for the badges/price/summary, `menuClass`, `footHtml`
// and `prefer: 'up'` for a control that sits at the bottom of the viewport —
// and was then never adopted here. This is that adoption.
//
// ── THE RENDER -> WIRE HANDOFF ───────────────────────────────────────────
// The house pattern from memory.js and settings.js: each picker's cfg is built
// ONCE and used for BOTH `renderListboxHtml` (markup) and `mountListbox`
// (behaviour), so the two cannot describe different controls. Cleared before
// every render, so a branch that emits no picker leaves nothing to mount.
const pendingListboxes = [];

// The value of the one ACTION row (see `action` in shared/listbox.js). Chosen
// to be un-typeable as a model id, and never sent anywhere: `commit()` refuses
// to make an action row the control's value, and `resolveChatModel` would
// refuse it anyway since no catalogue entry carries it.
const BROWSE_MODEL_VALUE = ' browse-all';

// ── AN OPTION VALUE NAMES A ROW, NOT A MODEL ID ───────────────────────────
// `offerable` is keyed by provider, so the same model id can legitimately
// appear under two of them. The listbox resolves a commit BY VALUE, so a bare
// id would make two rows share one value: click the second, get the first —
// a row badged one vendor selecting another vendor's model, and printing the
// wrong price on the surface whose entire job is naming what will answer.
//
// `<provider>|<id>` is unambiguous because it is split at the FIRST separator
// and the left half is then re-validated against the live provider list, so
// even an id that itself contained a `|` could not forge a provider. Kept
// human-readable rather than a control character: it lands in a DOM attribute
// that a person may well be reading in devtools.
//
// The SENTINEL carries no separator and is checked first, so it can never be
// mistaken for a qualified value — and no provider name can produce it.
const MODEL_VALUE_SEP = '|';

function modelOptionValue(provider, id) {
  return String(provider) + MODEL_VALUE_SEP + String(id);
}

/**
 * Split a qualified option value. Returns `{ provider, id }`, or null for
 * anything that is not one — the sentinel, an empty string, a bare id left over
 * from a stale render. Null is the caller's cue to do nothing, never to guess.
 */
function parseModelOptionValue(value) {
  if (typeof value !== 'string') return null;
  const at = value.indexOf(MODEL_VALUE_SEP);
  if (at <= 0 || at === value.length - 1) return null;
  return { provider: value.slice(0, at), id: value.slice(at + 1) };
}

/**
 * ONE cfg builder for the model picker - the ingest.js `domainListboxCfg`
 * precedent. Called by the render half and the mount half with its output used
 * for both, so an inline second literal cannot drift from it.
 */
function modelListboxCfg() {
  const all = offerableEntries(state.offerable, state.availableProviders);
  const ws = buildWorkingSet(all, {
    recents: state.modelRecents,
    starred: state.modelStarred,
    selectedId: state.chatModel,
  });
  const starred = new Set(Array.isArray(state.modelStarred) ? state.modelStarred : []);
  const recent = new Set(Array.isArray(state.modelRecents) ? state.modelRecents : []);

  // ── GROUPS: STARRED, RECENT, THEN BY PROVIDER (DESIGN.md §6) ────────────
  // Read from the stored lists directly, not from `row.reasons`: below the
  // collapse threshold `buildWorkingSet` returns every row with NO reasons,
  // and a star must still lead the menu there. Each row lands in exactly ONE
  // group (starred beats recent beats provider), because the listbox resolves
  // a commit by value and one value may appear once. Within a group the
  // catalogue's own order (cheapest first) is kept — a stable sort on the
  // group rank only.
  const ranked = ws.rows.map((row, i) => ({
    row,
    i,
    g: starred.has(row.entry.id) ? { rank: 0, name: 'Starred' }
      : recent.has(row.entry.id) ? { rank: 1, name: 'Recent' }
        : { rank: 2, name: providerWord(row.provider) },
  })).sort((a, b) => (a.g.rank - b.g.rank) || (a.i - b.i));

  const options = ranked.map(({ row, g }) => ({
    // PROVIDER-QUALIFIED — see modelOptionValue. Two rows can never share one
    // value, so the listbox's resolve-by-value cannot cross providers.
    value: modelOptionValue(row.provider, row.entry.id),
    label: row.entry.label || row.entry.id,
    group: g.name,
    // Type-ahead reaches the ID as well as the label, so "deepseek" and "opus"
    // both land somewhere. The listbox tries a prefix match first and falls back
    // to a substring, so the label still wins for a leading match.
    typeahead: (row.entry.label || '') + ' ' + row.entry.id,
    html: renderModelRowBodyHtml(row.provider, row.entry),
  }));

  // ── THE ESCAPE HATCH IS ALWAYS PRESENT, AND THAT REVERSES A REFUSAL ──────
  // It used to be gated on `ws.collapsed`, on the reasoning that a user looking
  // at every model they have should not be offered a button that opens the list
  // already in front of them. That reasoning assumed the dialog is the same
  // list, and it is not: the dialog carries a SEARCH field, a provider filter,
  // a free-only filter and the STAR control, none of which exist in this menu
  // and all of which are the reason someone opens it. Starring in particular is
  // reachable nowhere else, so on a 7-model install the working set could never
  // be built at all — the affordance was missing from exactly the configuration
  // that needed it to get started.
  //
  // It also removes a conditional the collapse rule could get wrong: with the
  // empty-working-set clause fixed above, a large catalogue with nothing to
  // select on now collapses to rows: [] — and an action row that was gated on
  // anything at all could have left that menu completely empty, which reads as
  // "you have no models". The row is unconditional, so that state is
  // inexpressible.
  options.push({
    value: BROWSE_MODEL_VALUE,
    label: 'Browse all ' + ws.total + ' models',
    action: true,
    html: '<span class="mr-browse">' + icon('search', 13) +
      '<span>Browse all ' + ws.total + ' models…</span>' +
      '<span class="mr-browse-sub">search, filter, star</span></span>',
  });

  // ── NO `|| 'gemini'` TERMINAL FALLBACK ───────────────────────────────────
  // This chain used to end in the literal 'gemini', so with NOTHING resolved -
  // no selection, no active provider, no keyed provider at all - the composer
  // confidently rendered "Gemini default" to a user who may have no Gemini key.
  // Naming a specific vendor as a stand-in for "we do not know" is a small lie
  // on a surface whose entire job is saying which model answers.
  const shownProvider = state.modelProvider || state.activeProvider || state.availableProviders[0] || null;
  const shownLabel = (shownProvider && providerWord(shownProvider)) || null;

  return {
    id: 'chat-model-lb',
    options,
    // The SELECTED value must be qualified the same way the rows are, or the
    // check mark and the open-on-selection scroll both land on nothing.
    // `state.chatModel` and `state.modelProvider` are written together by
    // selectChatModel and by the boot restore, so they cannot disagree.
    value: state.chatModel ? modelOptionValue(state.modelProvider, state.chatModel) : null,
    // The ONLY value in this control that `action: true` is honoured on — see
    // normaliseOptions in shared/listbox.js. Marking a MODEL row as an action
    // is inert, which is what stops "selecting a model" silently becoming
    // "running a handler and keeping the old model".
    actionValues: [BROWSE_MODEL_VALUE],
    // Reached only when `value` names no option - i.e. no model is pinned, or
    // the pinned one is outside the working set (impossible: `buildWorkingSet`
    // always includes the selection). "<Provider> default" only where the
    // provider can be named; a bare "Default" claims only what is known.
    placeholder: shownLabel ? shownLabel + ' default' : 'Default',
    // The choice is remembered PER BROWSER (localStorage), across chats, and
    // applies to the next question; the model that actually answered is on
    // each answer (DESIGN.md M-d). "for this chat" claimed a per-conversation
    // memory that does not exist.
    ariaLabel: 'Model for your next question',
    // ── THE FULL NAME, RECOVERABLE ON HOVER ──────────────────────────────
    // The trigger sits in a composer row beside Send and truncates, and an
    // OpenRouter label routinely runs past it (`Mistral Medium 3.1` under a
    // vendor prefix, `moonshotai/kimi-k2-0905`). Without this the only way to
    // read what is about to answer is to open the menu. It names BOTH halves —
    // the label a person recognises and the id the bill is written against —
    // because the truncated half is not always the same one.
    title: (() => {
      const cur = ws.rows.find((r) => r.entry && r.entry.id === state.chatModel);
      if (!cur) return shownLabel ? shownLabel + ' default' : 'Default';
      const nm = cur.entry.label || cur.entry.id;
      return nm === cur.entry.id ? nm : nm + ' — ' + cur.entry.id;
    })(),
    triggerClass: 'lb-sm chat-lb',
    // Names the pill's ROOT so the composer row can let the model name give
    // way (ellipsis, full name in `title`) before the row wraps — chat.css.
    rootClass: 'chat-model-lb-root',
    menuClass: 'lb-rich mr-menu',
    prefer: 'up',
    minWidth: 360,
    // ── ONE FOOT LINE: THE UNIT, WHERE THE CHOICE LIVES, THE SYNC DAY ─────
    // The unit is said once here so no row repeats it. The sync day is the
    // OpenRouter catalogue's OWN stamp from /api/config/api-keys, shown only
    // when OpenRouter is keyed and the server sent one — Gemini and Anthropic
    // prices ship with the app and carry no date on the wire, so none is
    // claimed for them.
    footHtml: modelMenuFootHtml({
      syncedAt: state.availableProviders.includes('openrouter') ? state.orCatalogueSyncedAt : null,
    }),
    onChange: (value) => {
      if (value === BROWSE_MODEL_VALUE) { openBrowseDialog({ mode: 'pick' }); return; }
      const parsed = parseModelOptionValue(value);
      if (!parsed) return;   // not a row this control emitted — do nothing
      selectChatModel(parsed.id, parsed.provider);
    },
  };
}

/** ONE cfg builder for the length picker, same contract. */
function lengthListboxCfg() {
  return {
    id: 'chat-length-lb',
    options: STYLE_ORDER.map(s => ({ value: s, label: STYLE_LABELS[s] })),
    value: state.responseStyle,
    ariaLabel: 'Answer length',
    triggerClass: 'lb-sm chat-pill chat-lb',
    rootClass: 'chat-length-lb-root',
    prefer: 'up',
    onChange: (value) => {
      if (!STYLE_ORDER.includes(value)) return;
      state.responseStyle = value;
      try { localStorage.setItem(LS_STYLE, value); } catch { /* ignore */ }
    },
  };
}

function wireComposer() {
  const ta = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  if (ta) {
    ta.addEventListener('input', () => autosize(ta));
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendCurrentMessage(); }
    });
    autosize(ta);
  }
  wireComposerPrimaryButton();
  // The pickers are BUILT here, not in renderComposerHtml — one code path
  // paints them on first mount and on every repaint after a pick.
  renderComposerPickers();
}

/**
 * Bind the composer's primary button. Factored out of `wireComposer` because
 * `renderComposerBusy` replaces that element (outerHTML) on every busy
 * transition and has to re-bind, and because binding is the half that must not
 * drift between the two paths.
 *
 * DISPATCHES ON `state.sending` AT CLICK TIME rather than binding a different
 * handler per state: the flag is the single truth about whether a turn is in
 * flight, and a handler captured when the button was painted could outlive the
 * state it was painted for.
 */
function wireComposerPrimaryButton() {
  const btn = document.getElementById('chat-send-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (state.sending) cancelCurrentSend();
    else sendCurrentMessage();
  });
}

function renderModelDropdownHtml() {
  const cfg = modelListboxCfg();
  pendingListboxes.push(cfg);
  return renderListboxHtml(cfg);
}

function renderLengthDropdownHtml() {
  const cfg = lengthListboxCfg();
  pendingListboxes.push(cfg);
  return renderListboxHtml(cfg);
}

/**
 * Commit a model choice from anywhere - the composer menu, the browse dialog,
 * or a re-ask. ONE function, because a pick made in one place and a pick made in
 * another must land in the same state, the same storage and the same recents
 * list; three copies of that is how a model gets pinned without being recorded.
 *
 * Re-validated against the LIVE catalogue rather than trusted from the caller:
 * this is the gate that makes an unkeyed provider's model unselectable even if a
 * row for it somehow reached the DOM.
 *
 * @returns {boolean} whether the pick was accepted
 */
function selectChatModel(id, preferProvider) {
  const picked = resolveChatModel(id, state.offerable, state.availableProviders, preferProvider);
  if (!picked) return false;
  state.chatModel = picked.entry.id;
  state.modelProvider = picked.provider;
  state.modelRecents = pushRecent(state.modelRecents, picked.entry.id, MAX_RECENTS);
  try { localStorage.setItem(LS_MODEL, picked.entry.id); } catch { /* ignore */ }
  try { localStorage.setItem(LS_PROVIDER, picked.provider); } catch { /* ignore */ }
  try { localStorage.setItem(LS_MODEL_RECENTS, JSON.stringify(state.modelRecents)); } catch { /* ignore */ }
  renderComposerPickers();
  return true;
}

/** Star/unstar, persisted. Pure logic in `toggleStar`; this is the state half. */
function toggleChatModelStar(id) {
  state.modelStarred = toggleStar(state.modelStarred, id, MAX_STARRED);
  try { localStorage.setItem(LS_MODEL_STARRED, JSON.stringify(state.modelStarred)); } catch { /* ignore */ }
}

/**
 * Repaint BOTH pickers and re-hydrate them.
 *
 * A FULL RE-RENDER OF THE TRIGGERS, not `api.setOptions`, and the reason is the
 * placeholder: the trigger's fallback text ("Gemini default") is derived from
 * live state, while `setOptions` recomputes it from the cfg CAPTURED AT MOUNT.
 * Keeping the instances alive would mean a stale placeholder after a provider
 * change - a wrong vendor name on the one control whose job is naming the model.
 * Re-rendering is cheap (two buttons) and cannot go stale.
 *
 * Focus survives: shared/listbox.js restores it BY ID after an onChange, and the
 * re-rendered trigger keeps the same id.
 */
function renderComposerPickers() {
  const host = document.getElementById('chat-composer-pickers');
  if (!host) return;
  // Any menu still open belongs to a trigger we are about to destroy. The
  // listbox's own rAF loop would notice the detachment and close it a frame
  // later, but closing first means there is never a frame in which a menu is
  // anchored to an element that has left the document.
  closeAllListboxes();
  pendingListboxes.length = 0;
  const showModelPicker = composerShowsModelPicker();
  // v3.72.0 (M2): the per-question scope lives HERE, in the order a question
  // is shaped — which wiki (fixed once the conversation exists), which
  // project's context, then how long and who answers. The project control has
  // its own host so a background project fetch repaints it alone.
  host.innerHTML =
    renderDomainPickerHtml() +
    '<span class="chat-project-host" id="chat-project-host">' + projectPickerHtml() + '</span>' +
    '<span class="chat-composer-vsep" aria-hidden="true"></span>' +
    renderLengthDropdownHtml() +
    (showModelPicker ? renderModelDropdownHtml() : '');
  domainLbApi = null;
  projectLbApi = null;
  for (const cfg of pendingListboxes) {
    const api = mountListbox(cfg);
    if (cfg.id === 'chat-domain-lb') domainLbApi = api;
    if (cfg.id === 'chat-project-lb') projectLbApi = api;
  }
  pendingListboxes.length = 0;
  const di = state.domains.findIndex(d => d.slug === state.activeDomain);
  decoratePill('chat-domain-lb', di >= 0 ? 'cur-sb-dot ' + identityDotClass(di) : '', '');
  decoratePill('chat-project-lb', 'chat-pmark', 'Project');
  decoratePill('chat-length-lb', '', 'Length');
  decoratePill('chat-model-lb', '', 'Model');
}

// ── THE DOMAIN PILL (v3.72.0, M2) ─────────────────────────────────────────
// The conversation's CONTAINER. A conversation is one file in one domain's
// folder, so once it exists its domain cannot change: the pill is drawn
// FIXED (dashed, `.is-fixed`), the menu's foot says which domain the
// conversation is in, and every other option reads "new chat" — choosing one
// starts a new conversation there (switchDomain). It can never look like a
// filter over the thread on screen, which is what the old chips did.

let domainLbCfg = null;
let domainLbApi = null;

function domainPickerCfg() {
  const fixed = !!state.activeConversationId;
  const current = state.domains.find(d => d.slug === state.activeDomain);
  const currentName = current ? (current.displayName || current.slug) : '';
  const options = state.domains.map((d, i) => {
    const name = d.displayName || d.slug;
    const pages = Number.isFinite(d.pageCount) ? d.pageCount : 0;
    const figure = pages.toLocaleString() + ' page' + (pages === 1 ? '' : 's');
    const detail = (fixed && d.slug !== state.activeDomain ? 'new chat · ' : '') + figure +
      (d.readonly === true ? ' · read-only' : '');
    return {
      value: d.slug,
      label: name,
      detail,
      html: '<span class="lb-opt-label chat-dom-opt"><span class="cur-sb-dot ' + identityDotClass(i) + '" aria-hidden="true"></span>' +
        escapeHtml(name) + '</span><span class="lb-opt-detail chat-opt-figure">' + escapeHtml(detail) + '</span>',
    };
  });
  const cfg = {
    id: 'chat-domain-lb',
    options,
    value: state.activeDomain || '',
    placeholder: 'Domain',
    ariaLabel: fixed
      ? 'Domain: ' + currentName + '. This conversation is in ' + currentName + '; another domain starts a new chat'
      : 'Domain for this chat',
    triggerClass: 'lb-sm chat-pill chat-domain-pill' + (fixed ? ' is-fixed' : ''),
    rootClass: 'chat-domain-lb-root',
    prefer: 'up',
    footHtml: fixed
      ? '<p class="chat-dom-foot">This conversation is in <strong>' + escapeHtml(currentName) +
        '</strong>. Another domain starts a new chat there.</p>'
      : '',
    onChange: (value) => switchDomain(value),
  };
  domainLbCfg = cfg;
  return cfg;
}

function renderDomainPickerHtml() {
  if (state.domains.length === 0) return '';
  const cfg = domainPickerCfg();
  pendingListboxes.push(cfg);
  return renderListboxHtml(cfg);
}

// ── THE BROWSE DIALOG ─────────────────────────────────────────────────────
//
// ── WHY THIS IS NOT INSIDE THE LISTBOX MENU ──────────────────────────────
// A search FIELD inside a `role="listbox"` popup is a second interactive
// control inside a control — the v3.0.1-beta.18 hazard — and it breaks the
// select-only combobox contract shared/listbox.js is built on, where focus
// never leaves the trigger and a blur closes the menu. Six other controls
// depend on that contract. So browsing 213 models is its own surface: a
// dialog, with a real text input, real filter buttons, and rows that are plain
// buttons with native focus and a native tab order.
//
// ── AND IT IS ONE SURFACE, TWO MODES ─────────────────────────────────────
// `pick` changes the composer's model. `reask` changes it AND immediately
// re-asks one question with it. The alternative was mounting a listbox per
// assistant message, which on a long thread is dozens of live rAF loops and
// dozens of <body> menus for a control almost none of which will be used.
//
// State lives in a module-level object, not in `state`: this is a document-level
// overlay like the confirm dialog, it must survive `state` being rebuilt, and it
// must be closable from teardown.
let browseUi = null;

function isBrowseDialogOpen() {
  return browseUi !== null;
}

function closeBrowseDialog() {
  if (!browseUi) return;
  // Cancel any pending search repaint BEFORE dropping the reference: a timer
  // that fired afterwards would find `browseUi` null and do nothing, but it
  // would also keep this closure — and the dialog's whole DOM — alive until it
  // did. Cheaper and clearer to cancel it.
  if (browseRefreshTimer !== null) { clearTimeout(browseRefreshTimer); browseRefreshTimer = null; }
  const { root, restoreFocusTo } = browseUi;
  browseUi = null;
  if (root && root.parentNode) root.parentNode.removeChild(root);
  // Focus BY ID, never by holding the node: the element that opened this may
  // have been replaced by a repaint while the dialog was up (a composer pick
  // re-renders the trigger; a send re-renders the whole thread). The v3.8.0
  // pattern that views/onboarding.js established.
  if (restoreFocusTo) {
    const el = document.getElementById(restoreFocusTo);
    if (el) { try { el.focus(); } catch { /* detached */ } }
  }
}

/**
 * Everything the dialog can currently show, as a FLAT row list in catalogue
 * order. Read fresh on every repaint so a Settings change that lands while the
 * dialog is open cannot leave a Disconnected provider's models pickable.
 */
function browseAllRows() {
  return offerableEntries(state.offerable, state.availableProviders);
}

function renderBrowseBodyHtml() {
  const all = browseAllRows();
  const rows = filterCatalogue(all, {
    q: browseUi.q,
    provider: browseUi.provider,
    freeOnly: browseUi.freeOnly,
  });
  const starred = new Set(Array.isArray(state.modelStarred) ? state.modelStarred : []);
  const list = renderModelMenuHtml(rows, state.chatModel, { starred });

  // ── AN EMPTY RESULT SAYS SO, AND OFFERS THE WAY BACK ────────────────────
  // "no results" with no exit is how a search box becomes a trap. The button
  // clears every filter at once, because a user who typed one thing and toggled
  // two others cannot be expected to reverse-engineer which of the three
  // emptied the list.
  const body = list || (
    '<div class="chat-browse-empty">' +
      '<div>No model matches ' +
        (browseUi.q ? '&ldquo;' + escapeHtml(browseUi.q) + '&rdquo;' : 'these filters') +
      '.</div>' +
      '<button type="button" class="chat-browse-clear" data-browse-clear>' +
        'Show all ' + all.length + ' models' +
      '</button>' +
    '</div>'
  );

  // A COUNT, ALWAYS, and it is the honest kind: how many of how many. It is the
  // only thing on screen that says a filter is hiding something.
  const count = rows.length === all.length
    ? all.length + ' models'
    : rows.length + ' of ' + all.length + ' models';

  return '<div class="chat-browse-count" role="status">' + escapeHtml(count) + '</div>' + body;
}

function renderBrowseFiltersHtml() {
  // Providers come from state.availableProviders, which this file builds from
  // its own frozen PROVIDER_KEY_FLAGS list — never payload text. Escaped anyway:
  // "safe because of where it came from" is a property a reader has to go and
  // verify, and it stops being true the day someone sources this from the wire.
  const chips = [{ id: null, label: 'All providers' }].concat(
    state.availableProviders.map(p => ({
      id: p,
      // The picker's ONE provider vocabulary (shared/model-row.js), so a
      // chip and the rows it filters name the provider the same way.
      label: providerWord(p),
    })),
  );
  const provHtml = chips.map(c => (
    '<button type="button" class="chat-browse-chip' + (browseUi.provider === c.id ? ' is-on' : '') + '"' +
      ' data-browse-provider="' + escapeHtml(c.id === null ? '' : c.id) + '"' +
      ' aria-pressed="' + (browseUi.provider === c.id ? 'true' : 'false') + '">' +
      escapeHtml(c.label) +
    '</button>'
  )).join('');

  // ── ONLY FACTS ARE FILTERABLE ────────────────────────────────────────────
  // Provider and free-vs-paid are things the provider TOLD us. There is
  // deliberately no capability, quality or speed filter: we hold latency for 6
  // of 213 ids and quality data for none of the fetched ones, and v3.16.0
  // measured that every available proxy for capability points the wrong way.
  // Price is on every row and is never a gate — that is the user's trade-off.
  return (
    '<div class="chat-browse-filters" role="group" aria-label="Filter models">' +
      provHtml +
      '<span class="chat-browse-sep" aria-hidden="true"></span>' +
      '<button type="button" class="chat-browse-chip' + (browseUi.freeOnly ? ' is-on' : '') + '"' +
        ' data-browse-free aria-pressed="' + (browseUi.freeOnly ? 'true' : 'false') + '">' +
        'Free only' +
      '</button>' +
    '</div>'
  );
}

// ── THE SEARCH DEBOUNCE ───────────────────────────────────────────────────
// Module-level beside `browseUi` for the same reason that is: the dialog is a
// document-level overlay that must survive `state` being rebuilt, and a timer
// held on `browseUi` would be lost the moment the object is replaced while
// still leaving a scheduled callback pointing at a dead dialog.
//
// 90 ms — under the ~100 ms "immediate" threshold, so a person never perceives
// the deferral, while a 60 wpm typist's burst collapses to one rebuild.
const BROWSE_SEARCH_DEBOUNCE_MS = 90;
let browseRefreshTimer = null;

function scheduleBrowseRefresh() {
  if (browseRefreshTimer !== null) clearTimeout(browseRefreshTimer);
  browseRefreshTimer = setTimeout(() => {
    browseRefreshTimer = null;
    // Re-checked INSIDE the callback: the dialog can close between the last
    // keystroke and the timer firing (Escape, the scrim, a teardown), and
    // `refreshBrowseDialog` would then be querying a detached tree.
    if (browseUi) refreshBrowseDialog();
  }, BROWSE_SEARCH_DEBOUNCE_MS);
}

/** Paint now if a repaint is pending. Called wherever the RENDERED list is read. */
function flushBrowseRefresh() {
  if (browseRefreshTimer === null) return;
  clearTimeout(browseRefreshTimer);
  browseRefreshTimer = null;
  if (browseUi) refreshBrowseDialog();
}

/** Repaint the list + filters in place, keeping the search field and its caret. */
function refreshBrowseDialog() {
  if (!browseUi) return;
  const filters = browseUi.root.querySelector('[data-browse-filters]');
  const body = browseUi.root.querySelector('[data-browse-body]');
  if (filters) filters.innerHTML = renderBrowseFiltersHtml();
  if (body) body.innerHTML = renderBrowseBodyHtml();
}

/**
 * @param {{mode: 'pick'|'reask', messageIndex?: number, question?: string,
 *          restoreFocusTo?: string}} opts
 */
function openBrowseDialog(opts) {
  const o = opts || {};
  closeBrowseDialog();

  const root = document.createElement('div');
  root.className = 'chat-browse-root';
  const total = browseAllRows().length;
  const reask = o.mode === 'reask';
  const titleId = 'chat-browse-title';

  root.innerHTML =
    '<div class="chat-browse-scrim" data-browse-scrim></div>' +
    '<div class="chat-browse" role="dialog" aria-modal="true" aria-labelledby="' + titleId + '">' +
      '<div class="chat-browse-head">' +
        '<div>' +
          '<h2 class="chat-browse-title" id="' + titleId + '" tabindex="-1">' +
            (reask ? 'Ask again with another model' : 'Choose a model') +
          '</h2>' +
          '<div class="chat-browse-sub">' +
            (reask
              // ── THE CAVEAT, STATED BEFORE THE SPEND, NOT AFTER ──────────
              // The re-ask goes into the SAME conversation, and src/brain/chat.js
              // builds every prompt from the last 20 messages — so the second
              // model usually reads the first model's answer. That is a
              // materially different question from the one the first model got,
              // and calling it a clean comparison would be a claim the mechanism
              // does not support. Said here, where the decision is being made.
              //
              // AND IT IS CONDITIONAL, because the control is offered on every
              // assistant message and an old enough one falls OUTSIDE that
              // slice. The unconditional sentence was simply false there. The
              // branch is gated on being able to PROVE the answer is in scope
              // (answerIsInPromptWindow fails safe to false), so the hedged
              // sentence is the default — and it is written to be true whether
              // the answer turns out to be in the window or not, since "will not
              // see it" would just be the same over-claim pointing the other
              // way. Both halves keep the point: this is never an independent
              // run, because the turns since are in the prompt either way.
              ? (answerIsInPromptWindow(o.messageIndex)
                ? 'Re-asks your question in this conversation. The new model can see the answer above, so this is a second opinion rather than an independent run.'
                : 'Re-asks your question in this conversation. The new model is only shown the most recent part of the thread and the answer above may fall outside it — but it does see the turns since, so this is still not an independent run.')
              // v3.72.0 (P4, DESIGN.md M-d): the pick is remembered PER
              // BROWSER across chats, not per conversation — say so.
              : 'Every model you have a key for. Picking one sets the model for your next question, remembered on this computer across chats.') +
          '</div>' +
        '</div>' +
        '<button type="button" class="chat-browse-close" data-browse-close aria-label="Close">' +
          icon('x', 16) +
        '</button>' +
      '</div>' +
      '<div class="chat-browse-tools">' +
        '<input type="search" class="chat-browse-q" id="chat-browse-q" autocomplete="off" spellcheck="false"' +
          ' placeholder="Search ' + total + ' models by name or id"' +
          ' aria-label="Search models by name or id">' +
        '<div data-browse-filters></div>' +
      '</div>' +
      '<div class="chat-browse-body" data-browse-body></div>' +
    '</div>';

  document.body.appendChild(root);
  browseUi = {
    root,
    q: '',
    provider: null,
    freeOnly: false,
    mode: reask ? 'reask' : 'pick',
    messageIndex: Number.isInteger(o.messageIndex) ? o.messageIndex : null,
    question: typeof o.question === 'string' ? o.question : '',
    restoreFocusTo: typeof o.restoreFocusTo === 'string' ? o.restoreFocusTo : 'chat-model-lb',
  };
  refreshBrowseDialog();

  const input = root.querySelector('#chat-browse-q');
  if (input) {
    // ── DEBOUNCED, BECAUSE EVERY KEYSTROKE REBUILDS 211 ROWS ─────────────
    // `refreshBrowseDialog` replaces the whole list with innerHTML, and
    // `renderModelMenuHtml` composes a rich body per row — badges, price,
    // summary, two buttons — so a fast typist was paying for the full catalogue
    // once per character. 90 ms is under the ~100 ms threshold at which a
    // response stops feeling immediate, so nothing about typing gets slower to
    // a person; what changes is that a burst of keystrokes costs ONE rebuild
    // instead of one each.
    //
    // THE STATE IS WRITTEN IMMEDIATELY AND ONLY THE PAINT IS DEFERRED, which
    // matters because Enter and ArrowDown (below) read the RENDERED list: the
    // pending timer is flushed there rather than being allowed to race, so a
    // type-then-Enter lands on the results for what was typed and never on the
    // previous frame's first row.
    input.addEventListener('input', () => {
      if (!browseUi) return;
      browseUi.q = input.value;
      scheduleBrowseRefresh();
    });
    // ARROW KEYS FROM THE FIELD, so a search and a choice are one gesture. Tab
    // reaches every row too (they are real buttons); this is the fast path, not
    // the only path.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'Enter') return;
      // Flush first: this reads the RENDERED list, and a pending debounce would
      // otherwise focus the first row of the PREVIOUS query's results — which
      // on a picker is not a cosmetic lag, it is landing on the wrong model.
      flushBrowseRefresh();
      const first = root.querySelector('.chat-browse-pick');
      if (!first) return;
      e.preventDefault();
      first.focus();
    });
    try { input.focus(); } catch { /* detached */ }
  }

  // ── THE FOCUS TRAP, WHICH `aria-modal="true"` IS A PROMISE OF ───────────
  // Declaring `aria-modal` tells a screen reader that everything outside this
  // dialog is inert. Without a trap that is a false statement: Tab walks
  // straight out into the composer behind the scrim, where the user is
  // operating controls their reader has been told do not exist. The wizards and
  // the confirm dialog in this tree already trap; this one owes the same debt.
  //
  // Computed on each Tab rather than cached, because the row list is replaced
  // wholesale on every keystroke in the search field — a cached list would hold
  // detached nodes within one keypress of opening.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !browseUi) return;
    const focusables = [...root.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter(el => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    // `document.activeElement` may be the dialog itself or something the browser
    // put focus on that is no longer in this list; wrapping from either end is
    // the behaviour that matters and both directions are handled.
    if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // ONE delegated handler for the whole dialog. Every control inside is
  // identified by a data attribute, so a repaint (which replaces the filter and
  // body markup wholesale) never needs re-wiring and can never leave a stale
  // listener on a node that has gone.
  root.addEventListener('click', (e) => {
    if (!browseUi) return;
    const t = e.target;
    if (t.closest('[data-browse-scrim]') || t.closest('[data-browse-close]')) {
      closeBrowseDialog();
      return;
    }
    const star = t.closest('[data-star-id]');
    if (star) {
      toggleChatModelStar(star.getAttribute('data-star-id'));
      refreshBrowseDialog();
      // The composer's working set just changed membership; repaint it so the
      // two lists cannot disagree about what is starred.
      renderComposerPickers();
      return;
    }
    if (t.closest('[data-browse-clear]')) {
      browseUi.q = '';
      browseUi.provider = null;
      browseUi.freeOnly = false;
      const q = root.querySelector('#chat-browse-q');
      if (q) q.value = '';
      refreshBrowseDialog();
      return;
    }
    const provBtn = t.closest('[data-browse-provider]');
    if (provBtn) {
      const v = provBtn.getAttribute('data-browse-provider');
      // Re-validated against the live list at click time — the same gate the
      // model pick applies via resolveChatModel, for the same reason.
      browseUi.provider = v && state.availableProviders.includes(v) ? v : null;
      refreshBrowseDialog();
      return;
    }
    if (t.closest('[data-browse-free]')) {
      browseUi.freeOnly = !browseUi.freeOnly;
      refreshBrowseDialog();
      return;
    }
    const pick = t.closest('[data-model-id]');
    if (pick) {
      const id = pick.getAttribute('data-model-id');
      // `data-model-provider` was rendered on every row from the start and READ
      // BY NOBODY — this repo's named dead-data shape. It is the only thing that
      // says WHICH row was clicked when two providers carry one model id, so
      // the pick resolves within it rather than taking whichever provider comes
      // first in the catalogue.
      const provider = pick.getAttribute('data-model-provider') || undefined;
      const mode = browseUi.mode;
      const messageIndex = browseUi.messageIndex;
      const question = browseUi.question;
      if (!selectChatModel(id, provider)) return;   // refused: unkeyed provider, stale id
      closeBrowseDialog();
      if (mode === 'reask') reaskMessage(messageIndex, question);
    }
  });
}


// ── ASK AGAIN WITH ANOTHER MODEL ──────────────────────────────────────────
//
// ── THE DECISION, AND THE CONSTRAINT THAT FORCED IT ──────────────────────
// The re-ask re-sends the SAME question into the SAME conversation. It does not
// open a hidden conversation, and it does not send the question in isolation.
//
// That is not the cleanest possible comparison and it is not pretended to be.
// `sendMessage` (src/brain/chat.js) builds every prompt from
// `conversation.messages.slice(-20)`, so the second model reads the first
// model's answer. Getting an independent run would mean sending with
// `conversationId: null`, which creates a SEPARATE conversation server-side —
// and then either the second answer does not live in this thread at all, or it
// lives here until the next reload and vanishes, and the sidebar grows a stray
// row per comparison. Both are worse than a stated caveat, so the caveat is
// stated: the browse dialog's re-ask mode says in its own subtitle what the new
// model will be shown, BEFORE the spend happens — and says it CONDITIONALLY,
// because the control is offered on every assistant message and an answer far
// enough back is outside `slice(-20)` entirely. See `answerIsInPromptWindow`.
//
// ── WHAT IT COSTS TO BUILD, AND WHY THAT MATTERS ─────────────────────────
// Nothing new. It puts the question back in the composer and calls the ordinary
// `sendCurrentMessage()`, so it inherits the mount guard, the domain/
// conversation capture, the elapsed clock, the served-model capture, the usage
// capture, the error path and the persistence — every one of which was hard-won
// and none of which is re-implemented here. A second send path is how two
// answers come to be recorded differently.
//
// ── AND IT PERSISTS FOR FREE ─────────────────────────────────────────────
// The server appends the re-asked question and its answer to the conversation
// JSON exactly as it appends any other turn. NO NEW STORED FIELD IS INTRODUCED,
// so an existing conversation loads byte-unchanged, and a reloaded thread reads
// Q / A-from-model-1 / Q / A-from-model-2 — the literal history, each answer
// already carrying the model that produced it and what it cost (v3.13.2 /
// v3.14.0). The comparison is auditable after a reload, not only during.
//
// ── ONE DELIBERATE RE-ASK PER CLICK ──────────────────────────────────────
// It never fires automatically and never fans out across models in parallel.
// Every run is a real API call the user pays for, so every run is a decision the
// user made; the model's price is on the row they pick it from.

// ── THE PROMPT WINDOW, AND WHY THE CAVEAT IS NOT UNCONDITIONAL ───────────
//
// `sendMessage` (src/brain/chat.js) builds every prompt from
// `conversation.messages.slice(-20)`. The re-ask control is offered on EVERY
// assistant message, including ones far enough back to fall outside that
// slice — so a dialog that said "the new model can see the answer above"
// unconditionally was stating something false, on the surface where the user
// is deciding to spend money.
//
// THE NUMBER IS A COUPLING, NOT A LOCAL CHOICE. This is a frontend copy of a
// backend constant, which is the two-hand-maintained-copies shape this repo
// keeps paying for. It cannot be imported (this file runs in a browser and
// src/brain does not), so scripts/test-next-chat-reask.js pins BOTH — the
// literal here and the `slice(-20)` there — and goes red the moment they
// disagree, rather than letting the sentence quietly become wrong again.
const PROMPT_HISTORY_MESSAGES = 20;

/**
 * Is the answer at `index` still inside the window the next prompt will carry?
 *
 * ── FAIL-SAFE DIRECTION: FALSE ──────────────────────────────────────────
 * `true` licenses a CLAIM about what the second model will see. Anything this
 * cannot account for therefore returns false, and the caller then says "may
 * not" instead of "can" — an under-claim is a hedge, an over-claim is a
 * falsehood.
 *
 * ── WHY THIS COUNTS THE CLIENT'S THREAD AND IS STILL SOUND ──────────────
 * The window is over the SERVER's `conversation.messages`; this walks
 * `state.thread`, which is not the same array. It holds everything the server
 * has, plus entries the server does not: an errored assistant turn (the send
 * threw, so nothing was appended) and compile cards.
 *
 * Only compile cards are skipped, because they are provably never persisted —
 * they are pushed client-side by `renderCompileOutcome` and are gone from
 * `state.thread` after the next load, which reads `data.messages` wholesale.
 * Everything else is COUNTED even where it may not exist server-side, which
 * over-estimates the distance from the end and can only push the answer out of
 * the window, never into it. That is the safe error.
 */
function answerIsInPromptWindow(index) {
  if (!Number.isInteger(index) || index < 0) return false;
  const thread = Array.isArray(state.thread) ? state.thread : null;
  if (!thread || index >= thread.length) return false;
  let after = 0;
  for (let i = index + 1; i < thread.length; i++) {
    const m = thread[i];
    if (!m || typeof m !== 'object') return false;   // unaccountable → no claim
    if (m.role === 'compile') continue;              // client-only, never persisted
    after++;
  }
  // `after` messages sit behind it, so it is the (after + 1)-th from the end.
  return after + 1 <= PROMPT_HISTORY_MESSAGES;
}

/**
 * One extra sentence under a failed turn when — and only when — the model it was
 * sent to is FREE. '' in every other case.
 *
 * WHY THIS IS THE FACT WORTH STATING. On a free model a rate limit is the
 * EXPECTED outcome rather than an exceptional one, and the user has no way to
 * know that from the provider's own message. The wording is not written here: it
 * comes from `slowTurnNoticeText`, the same builder the thinking bubble uses, so
 * there is exactly one copy of the claim and the "while you wait" text and the
 * "after it failed" text cannot disagree.
 *
 * Resolved from `m.requestedModel` (recorded at send time) with the SAME
 * `resolveChatModel` every other model-derived line in this view uses, and gated
 * on `entry.free === true` — llm.js's reported flag, never an id substring.
 * A message with no recorded model says nothing, which is the absence rule: we
 * do not guess from the composer's current selection.
 */
function failedModelNoteHtml(m, ctx) {
  const id = m && typeof m.requestedModel === 'string' && m.requestedModel ? m.requestedModel : null;
  if (!id) return '';
  const c = ctx || {};
  const row = resolveChatModel(id, c.offerable, c.availableProviders);
  if (!row || !row.entry || row.entry.free !== true) return '';
  const text = slowTurnNoticeText({ label: row.entry.label || row.entry.id, free: true });
  if (!text) return '';
  return '<div class="chat-error-context">' + escapeHtml(text) + '</div>';
}

/**
 * The question an assistant message at `index` was answering: the nearest
 * PRECEDING user turn. Null when there is none — a thread that opens with an
 * assistant message (a compile card, an error) has nothing to re-ask.
 *
 * Compile cards sit in `state.thread` with `role: 'compile'` and are skipped
 * like any other non-user row, so a compile between the question and the answer
 * cannot make this pick the wrong text.
 */
function questionForAnswerIndex(index) {
  if (!Number.isInteger(index) || index < 0) return null;
  for (let i = index - 1; i >= 0; i--) {
    const m = state.thread[i];
    if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return m.content;
    }
  }
  return null;
}

// ── COPY A MESSAGE ────────────────────────────────────────────────────────
//
// Asked for by a user (Robin Good) and specified by the maintainer as an ICON,
// with no word beside it. One per message, on both sides of the thread: an
// answer copies as the MARKDOWN the model wrote — the same string the compile
// path stores and the same one `renderMarkdown` renders — never the rendered
// HTML, and never the citation chips as this view drew them. A question copies
// the question.
//
// VISIBLE AT REST, at reduced emphasis. Not hover-only: a hover-only control
// does not exist on a touch screen and cannot be found by keyboard, and this
// repo's v3.16.1 rule is that a control that matters is not behind a hover.
// `--text-3` is the eyebrow's own ink, so it reads as part of the meta line
// rather than as a second call to action beside "Ask again with another
// model" — which spends money, where this does not.
//
// NO `title=`. The tooltip would be the only carrier of a fact for mouse users
// and nothing for anyone else; `aria-label` plus a `.visually-hidden` label
// carry it instead, with the SAME string from the same variable so the two
// cannot disagree. chat.js is not in test-next-header-adoption.js §6's
// per-file `title=` ratchet, so nothing here was forced — this is the house
// rule that ratchet exists to hold, applied where it is not yet enforced.
//
// THE TEXT IS NOT IN THE MARKUP. `data-copy-msg` carries the message's INDEX
// and the handler reads `state.thread[i].content` at click time — the same
// shape `data-reask` already uses. An answer is routinely kilobytes; putting
// it in an attribute would be a second, escaped copy of every message in the
// DOM for the sake of a control almost nobody presses.
const COPY_FEEDBACK_MS = 1500;

/**
 * The copy control for one message, or '' when there is nothing to copy.
 *
 * Returns '' for an empty or whitespace-only `content`, which is what an
 * ERRORED assistant turn carries (the error text lives in `m.error` and is the
 * provider's sentence, not an answer) and what a stopped turn leaves behind. A
 * control that would write an empty string to the clipboard is an inert
 * control, and this repo has shipped two of those and recorded both.
 *
 * NOTHING IS EMITTED FOR THE STREAMING BUBBLE, and that needs no check here:
 * the in-flight bubble is painted from `sendStream` and is deliberately never
 * pushed into `state.thread` (see sendStream's declaration), so this function
 * is never called for it. The answer becomes copyable at the moment it becomes
 * a thread entry, which is the moment it is final.
 *
 * @param {number} index the message's index in `state.thread` — the handle the
 *   click handler resolves the text through.
 * @param {'answer'|'question'} kind which word the accessible name uses.
 * @param {object} m the message itself, read ONLY to decide whether there is
 *   anything to copy.
 */
function copyControlHtml(index, kind, m) {
  if (!Number.isInteger(index) || index < 0) return '';
  if (!m || typeof m.content !== 'string' || !m.content.trim()) return '';
  const label = kind === 'question' ? 'Copy question' : 'Copy answer';
  return (
    '<button type="button" class="chat-copy-btn" data-copy-msg="' + index + '"' +
      ' aria-label="' + label + '">' +
      '<span class="chat-copy-glyph">' + icon('copy', 13) + '</span>' +
      '<span class="visually-hidden">' + label + '</span>' +
    '</button>' +
    // The confirmation, for a reader who cannot see the glyph change. OUTSIDE
    // the button on purpose: a live region inside a control is inside that
    // control's own subtree, and the button already has an `aria-label`, so
    // the region's text would be both ignored for the name and announced from
    // an odd place. It is `.visually-hidden`, which is absolutely positioned,
    // so filling it moves nothing on screen.
    '<span class="visually-hidden" role="status" aria-live="polite" data-copy-status></span>'
  );
}

// Per-button reset timers. A WeakMap rather than a property on the element:
// `renderThreadOnly` replaces the whole thread with one `innerHTML` write, so
// these buttons are discarded constantly and a WeakMap lets the entry go with
// them. A timer that fires against a detached button writes into a node nobody
// is looking at — harmless, and cheaper than tracking mounts for a 1.5 s
// cosmetic reset.
const copyResetTimers = new WeakMap();

/**
 * Paint the outcome of one copy attempt, then undo it.
 *
 * The glyph is swapped IN PLACE (same `icon()` call, same 13px box) rather
 * than a word being added beside it, so nothing on the line moves — the
 * requirement that made this an icon in the first place.
 *
 * A FAILURE IS SHOWN, not swallowed. `navigator.clipboard` is absent in an
 * insecure context and `writeText` rejects when the document is not focused or
 * permission is refused; in both cases the user pressed a control and must be
 * told it did not do the thing. Same glyph geometry, different mark and
 * different sentence.
 */
function markCopyOutcome(btn, okFlag) {
  const glyph = btn.querySelector('.chat-copy-glyph');
  const status = btn.nextElementSibling;
  const prev = copyResetTimers.get(btn);
  if (prev) clearTimeout(prev);
  btn.classList.remove('is-copied', 'is-failed');
  btn.classList.add(okFlag ? 'is-copied' : 'is-failed');
  if (glyph) glyph.innerHTML = icon(okFlag ? 'check' : 'alertCircle', 13);
  if (status && status.hasAttribute && status.hasAttribute('data-copy-status')) {
    status.textContent = okFlag ? 'Copied' : 'Could not copy';
  }
  copyResetTimers.set(btn, setTimeout(() => {
    copyResetTimers.delete(btn);
    btn.classList.remove('is-copied', 'is-failed');
    if (glyph) glyph.innerHTML = icon('copy', 13);
    // Cleared, not left standing: a live region that still says "Copied" is a
    // stale claim the next screen-reader pass can read back.
    if (status && status.hasAttribute && status.hasAttribute('data-copy-status')) status.textContent = '';
  }, COPY_FEEDBACK_MS));
}

/**
 * Put one message's own text on the clipboard.
 *
 * Reads the text from `state.thread` at CLICK time rather than from anything
 * captured at render time: the thread is rebuilt on every turn, and the index
 * is the only handle that survives the rebuild intact.
 *
 * Exported shape is a promise-free void — the caller is a click handler, and a
 * rejected promise escaping into one is an unhandled rejection. Both arms of
 * `writeText` are handled here, and a host with no Clipboard API at all takes
 * the failure arm rather than throwing.
 */
function copyMessageText(btn) {
  const i = Number(btn.getAttribute('data-copy-msg'));
  const m = Number.isInteger(i) && i >= 0 ? state.thread[i] : null;
  const text = m && typeof m.content === 'string' ? m.content : '';
  if (!text) { markCopyOutcome(btn, false); return; }
  let p = null;
  try {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (clip && typeof clip.writeText === 'function') p = clip.writeText(text);
  } catch { p = null; }
  if (p && typeof p.then === 'function') p.then(() => markCopyOutcome(btn, true), () => markCopyOutcome(btn, false));
  else markCopyOutcome(btn, false);
}

/**
 * The control itself, or '' when there is nothing to re-ask.
 *
 * SUPPRESSED WHILE A SEND IS IN FLIGHT, because `sendCurrentMessage` refuses a
 * second send anyway (`state.sending`) and a button that silently does nothing
 * is the inert-control defect this repo has shipped and recorded twice. Also
 * suppressed where the composer has no model picker at all — with one model
 * there is no other model to ask.
 *
 * NOW RENDERED ON A FAILED TURN TOO, and that is the point of the control there:
 * a failure whose most likely remedy is "try a different model" should offer
 * that remedy where the failure is, not leave the user to find the dropdown.
 * (This docblock previously said errored messages were suppressed. They were —
 * by the CALL SITE never invoking this, not by anything in here. The sentence
 * described a behaviour no line in this function implemented, which is why it
 * silently stopped being true the moment the call site changed.)
 */
function reaskButtonHtml(index) {
  if (state.sending) return '';
  if (!composerShowsModelPicker()) return '';
  if (!questionForAnswerIndex(index)) return '';
  return (
    '<div class="chat-reask-row">' +
      '<button type="button" class="chat-reask-btn" data-reask="' + index + '"' +
        ' title="Re-ask this question in this conversation using a different model">' +
        icon('refresh', 12) + ' <span>Ask again with another model</span>' +
      '</button>' +
    '</div>'
  );
}

/**
 * Run the re-ask. The model has ALREADY been committed by `selectChatModel`
 * before this is called, so this is only the send half.
 *
 * Refuses while a send is in flight rather than queueing: a queued paid call
 * that fires after the user has moved on is spend they did not authorise at the
 * moment it happens.
 */
function reaskMessage(index, question) {
  if (state.sending) return;
  if (typeof question !== 'string' || !question.trim()) return;
  const ta = document.getElementById('chat-input');
  if (!ta) return;
  ta.value = question;
  autosize(ta);
  sendCurrentMessage();
}

// H1 fix: reaches into #chat-send-btn/#chat-input directly, bypassing
// setMain()'s guard — needs its own.
function renderComposerBusy(busy, token) {
  if (!isCurrentMount(token)) return;
  const sendBtn = document.getElementById('chat-send-btn');
  const ta = document.getElementById('chat-input');
  if (sendBtn) {
    // NEVER disabled now. It used to be `disabled = busy` with a spinner inside,
    // which is the state this change exists to remove: a turn that can run for
    // minutes, showing a control that acknowledges it is busy and offers no way
    // out. Liveness has not been lost with the spinner — the thinking bubble
    // carries a spinner AND a ticking elapsed clock, which is the honest signal.
    sendBtn.disabled = false;
    // outerHTML, not innerHTML: the class, title and aria-label all differ
    // between the two states, and rewriting only the contents would leave a
    // square glyph inside a button still telling a screen reader "Send".
    // Replacing the element drops its listener with it, so it is re-bound here —
    // `wireComposer` is not re-run by this path.
    sendBtn.outerHTML = composerPrimaryButtonHtml(busy);
    wireComposerPrimaryButton();
  }
  if (ta) ta.disabled = busy;
}

// H1 fix: reaches into #chat-thread directly, bypassing setMain()'s guard —
// needs its own. This is the exact function the reported bug painted a
// stale answer through (see sendCurrentMessage's H1 comment).
function renderThreadOnly(token, opts) {
  if (!isCurrentMount(token)) return;
  const el = document.getElementById('chat-thread');
  if (!el) return;

  // ── WHERE THE SCROLL ENDS UP, DECIDED BEFORE THE CONTENT CHANGES ────────
  // Measured first, applied last: once `innerHTML` is replaced, "was the
  // reader at the bottom?" is unanswerable.
  //
  // Three cases, and each is a different fact:
  //   - `opts.stick` — a deliberate act (pressing Send) whose result the user
  //     is waiting for. Always jump.
  //   - a DIFFERENT conversation than the last paint — opening or switching a
  //     thread must land on the newest message, and the reader's scroll
  //     position in the previous conversation says nothing about this one.
  //   - otherwise — follow only if they were already following. This is what
  //     lets someone read back through history while an answer streams in.
  const scrollHost = threadScrollHost();
  const conversationChanged = lastRenderedConvId !== state.activeConversationId;
  lastRenderedConvId = state.activeConversationId;
  const stickAfter = !!(opts && opts.stick) || conversationChanged || isThreadAtBottom(scrollHost);

  const active = state.domains.find(d => d.slug === state.activeDomain);

  if (state.thread.length === 0) {
    el.innerHTML =
      '<div class="chat-empty">' +
        '<div class="chat-empty-title">Ask ' + escapeHtml(active ? (active.displayName || active.slug) : 'this domain') + ' anything</div>' +
        '<div class="chat-empty-body">' + escapeHtml(emptyThreadBodyText(active)) + '</div>' +
      '</div>' +
      // The empty state is REACHABLE AFTER A STOP, and it is the case that most
      // needs the notice: stopping the very first message of a new conversation
      // removes the only entry in the thread, so without this the screen would
      // snap back to "Ask X anything" with nothing to say the turn had been
      // stopped rather than never sent.
      cancelNoticeHtml();
    return;
  }

  // Everything the eyebrow needs that is NOT a property of the message
  // itself: the catalogue used to turn a model id into a friendly name, and
  // the provider fallback for a message with no model recorded. The MODEL is
  // deliberately NOT in here — see describeAnswerModel: it comes from each
  // message, so a dropdown change can never relabel an answer it never saw.
  const eyebrowCtx = {
    offerable: state.offerable,
    availableProviders: state.availableProviders,
    modelProvider: state.modelProvider,
    activeProvider: state.activeProvider,
    // PASSED IN DELIBERATELY, AND DELIBERATELY NEVER READ.
    // `describeAnswerModel` must not use the composer's current selection for
    // anything — that is the whole defect. Withholding it here would make the
    // pre-fix behaviour INEXPRESSIBLE: a renderer that reached for it would
    // find nothing, and the suite would stay green with the bug fully
    // present. Same reasoning as this view's model-menu suite §3/§4, which
    // feeds the client the UNGATED catalogue rather than a pre-filtered one
    // so that a client-side leak is something the fixture can actually
    // contain. Here the "leak" is a stale label, and §10.1/§10.2 assert it
    // does not happen while the material for it is sitting in the argument.
    chatModel: state.chatModel,
  };

  answerSources.clear();
  el.innerHTML = state.thread.map((m, i) => {
    // Compile-to-Wiki outcome cards (see the "Compile to Wiki" section
    // above runCompile()). Pushed into `state.thread` itself — NOT
    // appended to the DOM directly — specifically so they survive being
    // caught up in a rebuild like this one: this function does a full
    // `el.innerHTML = ...` on every subsequent send, domain switch, etc.,
    // so anything not represented in `state.thread` would vanish the next
    // time ANY of those ran. `m.html` was built by buildCompileOutcomeHtml/
    // the refused/error branches in runCompile(), which already escape
    // every piece of server- or user-derived text they interpolate (title,
    // paths, error/refusal messages) — this is the one spot in this
    // function that inserts pre-built HTML rather than escaping inline,
    // and it is safe for exactly that reason.
    if (m.role === 'compile') {
      return '<div class="chat-compile-card">' + m.html + '</div>';
    }
    if (m.role === 'user') {
      return (
        '<div class="chat-msg chat-msg-user">' +
          '<div class="chat-msg-eyebrow mono">YOU</div>' +
          copyControlHtml(i, 'question', m) +
          '<div class="chat-bubble">' + escapeHtml(m.content).replace(/\n/g, '<br>') + '</div>' +
        '</div>'
      );
    }
    if (m.error) {
      // ── A FAILURE IS AN OUTCOME, NOT A CATASTROPHE ─────────────────────
      // Reported as: a full-width wall of red text after a long wait, on a
      // free model. Three things changed and each is deliberate.
      //   1. NOT `.chat-answer`. That class is 14.5px body copy and the whole
      //      message was painted --danger-text, so ~450 characters of provider
      //      prose arrived at answer size in alarm colour. The text is now
      //      recessed and width-capped like every other stated fact in this
      //      view; the failure is marked by ONE hairline rule, not by the copy.
      //   2. NO ICON. Same rule the stopped-turn note follows (v3.13.2): state
      //      the fact, do not decorate it.
      //   3. AN ACTION. `reaskButtonHtml` is the v3.18.0 control, reused rather
      //      than reinvented — the same one-click "ask this again with another
      //      model" that a successful answer offers. A failure the user can act
      //      on in one click is the actual fix; better apology copy is not.
      // `role="status"`, not `alert`: the user is already watching this spot
      // having waited for it, and an assertive region would interrupt whatever a
      // screen reader is mid-sentence on. Previously there was no role at all.
      return (
        '<div class="chat-msg chat-msg-assistant chat-msg-error">' +
          '<div class="chat-msg-eyebrow mono">THE CURATOR</div>' +
          '<div class="chat-error-note" role="status">' +
            '<div class="chat-error-detail">' + escapeHtml(m.error) + '</div>' +
            failedModelNoteHtml(m, eyebrowCtx) +
          '</div>' +
          reaskButtonHtml(i) +
        '</div>'
      );
    }
    // ── NUMBERED CITATIONS + ONE SOURCES LIST (v3.72.0, M4) ─────────────
    // shared/answer.js numbers every cited page by first appearance, turns
    // each inline `[source: …]` into a numbered marker (one per path), and
    // appends the server's `citations` after them, deduped. The Sources list
    // under the answer carries each page ONCE, by title, in the page-type
    // channel. No raw path is on the answer's face any more (C5/C6); the
    // `.chat-cite-row` of title chips that repeated every citation is gone.
    // The sources are kept per message index for the ONE delegated click.
    const rendered = renderAnswer(m.content || '', {
      titles: (m.citationTitles && typeof m.citationTitles === 'object') ? m.citationTitles : null,
      citations: Array.isArray(m.citations) ? m.citations : [],
      // v3.76.0 (F9): only a mention that resolved to a page is a source.
      // An answer from before v3.76.0 carries `citedPagesNow` instead: the
      // server's check of its citations against the wiki on disk at read.
      pages: Array.isArray(m.citedPages) ? m.citedPages
        : (Array.isArray(m.citedPagesNow) ? m.citedPagesNow : undefined),
    });
    answerSources.set(i, rendered.sources);
    return (
      '<div class="chat-msg chat-msg-assistant" data-msg-index="' + i + '">' +
        assistantEyebrowHtml(m, eyebrowCtx, i) +
        // A SIBLING of the eyebrow rather than a child of it, and positioned
        // into the meta line by chat.css. assistantEyebrowHtml can emit a
        // SECOND block under the eyebrow (the model-divergence notice).
        copyControlHtml(i, 'answer', m) +
        '<div class="chat-answer">' + rendered.html + '</div>' +
        sourcesHtml(rendered.sources, rendered.mentions) +
        reaskButtonHtml(i) +
      '</div>'
    );
  }).join('') + (sendIsOnScreen(token) ? (
    // ── THE STREAMING BUBBLE, AND WHY IT IS NOT A THREAD ENTRY ───────────
    // Painted here, from `sendStream`, and never pushed into `state.thread`.
    // See sendStream's declaration: an assistant placeholder in the thread
    // breaks the Stop unwind's identity guard, which pops the optimistic user
    // bubble only when it is the LAST entry.
    //
    // `sendIsOnScreen(token)`, not `state.sending`. That bare boolean carried
    // no conversation and no domain, so a turn started in one thread painted
    // its bubble into whichever thread you happened to be looking at. With a
    // spinner that was a cosmetic oddity; with the model's reasoning and a
    // draft answer inside it, it is another conversation's content appearing
    // in the one you are reading.
    '<div class="chat-msg chat-msg-assistant chat-msg-thinking">' +
      '<div class="chat-msg-eyebrow mono">THE CURATOR</div>' +
      thinkingBodyHtml() +
    '</div>'
  ) : '') + cancelNoticeHtml();

  // The Compile caption counts what is in `state.thread`, which this function
  // has just repainted from — and it lives in the scope bar, outside this
  // element, so nothing above touches it. See refreshCompileCaption for why
  // this is a targeted write rather than a repaint, and why it is safe for it
  // to find nothing. Placed AFTER the empty-thread early return on purpose: a
  // caption under a live Compile button and an empty thread is a state this
  // view cannot reach (every path that empties the thread goes through
  // renderShell, which rebuilds the bar), and writing "0 questions" here would
  // be inventing an answer for it.
  refreshCompileCaption();

  // Delegated click for the re-ask control. One handler for the whole thread,
  // not one per message: `renderThreadOnly` replaces this element's entire
  // innerHTML on every send, so per-row listeners would be re-bound (and their
  // predecessors orphaned) on every turn.
  el.querySelectorAll('[data-reask]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.getAttribute('data-reask'));
      const q = questionForAnswerIndex(i);
      if (!q) return;
      openBrowseDialog({
        mode: 'reask',
        messageIndex: i,
        question: q,
        // Focus returns to the composer's model trigger rather than to this
        // button: by the time the dialog closes the thread has usually been
        // rebuilt by the re-ask itself, so this button's element is gone. The
        // trigger is stable and is the control that now reflects the choice.
        restoreFocusTo: 'chat-model-lb',
      });
    });
  });

  // Delegated click for the copy controls. Bound here, with every other
  // listener in this block, for the same reason they are: the `innerHTML`
  // replacement above dropped the previous buttons and their handlers.
  el.querySelectorAll('[data-copy-msg]').forEach(btn => {
    btn.addEventListener('click', () => copyMessageText(btn));
  });

  // The reasoning fold's toggle. Same reason as every other listener in this
  // block: the `innerHTML` replacement above dropped the previous one with the
  // element it was bound to.
  wireStreamToggle(el, token);

  // #chat-thread has no scroll of its own (see chat.css: the composer and
  // scope bar are sticky WITHIN .main, which is the one true scrolling
  // ancestor) — so the element to scroll to reveal the latest message is
  // .main itself, the shared main-column element from index.html/app.js.
  //
  // CONDITIONAL now, on the decision taken at the top of this function before
  // the content moved. It used to be unconditional, which was survivable at one
  // or two renders per turn and is not once text arrives continuously.
  if (stickAfter) stickThreadToBottom(scrollHost);
}

/**
 * Each painted answer's sources, by message index — what the ONE delegated
 * click reads. Rebuilt on every thread paint, so a click can only ever
 * resolve against the sources of the answer that is on screen. The path the
 * reader opens comes from HERE, never from the DOM (P2's contract).
 */
const answerSources = new Map();

/**
 * THE ONE CITATION CLICK, delegated on the thread element (bound once per
 * element in renderMain). A numbered marker in the text (`data-cite-n`) and a
 * Sources chip (`data-source-n`) open the same page: the number is resolved
 * through `sourceByNumber` against that answer's own list.
 */
function onThreadCitationClick(e) {
  const hit = e.target && e.target.closest ? e.target.closest('[data-cite-n], [data-source-n]') : null;
  if (!hit) return;
  const msg = hit.closest('[data-msg-index]');
  if (!msg) return;
  const sources = answerSources.get(Number(msg.getAttribute('data-msg-index')));
  const n = hit.getAttribute('data-cite-n') || hit.getAttribute('data-source-n');
  const src = sourceByNumber(sources || [], n);
  if (!src) return;
  e.preventDefault();
  openWikiReader(src.path, src.title || null);
}

/** The empty thread's line under "Ask X anything" — its page count is live
 *  (F1: patched by patchScopeCount after a compile). */
function emptyThreadBodyText(d) {
  const pages = d && Number.isFinite(d.pageCount) ? d.pageCount : null;
  const cite = 'Answers number the pages they draw from — press a number to open that page.';
  return pages === null ? cite : 'This domain has ' + pages.toLocaleString() + ' page' + (pages === 1 ? '' : 's') + '. ' + cite;
}

// The conversation the thread element was last painted for. Purely a scroll
// decision: opening or switching a conversation must land on its newest
// message, and the reader's scroll position in the PREVIOUS conversation is not
// evidence about this one. `undefined` initially so the very first paint of a
// session counts as a change (a fresh mount must land at the bottom); `null` is
// a real value here — it is what an empty "new chat" thread carries.
let lastRenderedConvId;
