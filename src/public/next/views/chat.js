// View: Chat — the default view.
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
  registerView, setSidebar, setMain, eyebrow, escapeHtml, icon, openReader, navigate, isCurrentMount,
  reportAsyncMountFailure, isCurrentReader, reportAsyncActionFailure,
  consumeChatScopeRequest,
} from '../app.js';
import { renderMarkdown } from '../shared/markdown.js';
// The ONE honest USD renderer for /next. Imported, never re-implemented: a
// local `'$' + n.toFixed(4)` renders any charge below $0.00005 as the string
// `$0.0000`, i.e. a paid answer labelled free — and a one-word chat turn on the
// cheapest model measures ~$0.0000015, so that is this surface's ORDINARY case,
// not an edge case. See shared/format-usd.js.
import { formatUsdHonest } from '../shared/format-usd.js';
import { formatModelSummary, formatDurationMs } from '../shared/model-summary.js';
import { confirmThen, closeConfirmIfOpen } from '../shared/confirm.js';
// The one dropdown surface in /next. Adopted here for the composer's model and
// length pickers, which until now were the last hand-rolled menus in the tree
// and the only ones with no keyboard operation at all.
import { renderListboxHtml, mountListbox, closeAllListboxes } from '../shared/listbox.js';
import { createLoadingGate, gatedLoader, settleGate } from '../shared/loading-gate.js';

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

function typeDotStyle(folder) {
  if (folder === 'entities') return 'background:var(--type-entity)';
  if (folder === 'concepts') return 'background:var(--type-concept)';
  if (folder === 'summaries') return 'background:var(--type-summary)';
  return 'background:var(--border-strong)';
}

function typeChipClass(folder) {
  if (folder === 'entities') return 'chat-chip-entity';
  if (folder === 'concepts') return 'chat-chip-concept';
  if (folder === 'summaries') return 'chat-chip-summary';
  return 'chat-chip-plain';
}

function isSameLocalDay(isoA, isoB) {
  const a = new Date(isoA), b = new Date(isoB);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + 'd ago';
  return new Date(iso).toLocaleDateString();
}

// NIT-10 fix: indexed by server-supplied provider strings (state.modelProvider
// / state.activeProvider come from the /api/config/api-keys response) — same
// __proto__/constructor lookup hazard as app.js's READER_TYPE_CLASS/DOT maps,
// closed the same way.
// 'Claude' rather than 'Anthropic' is deliberate and predates OpenRouter: the
// composer names the thing that answers, and users say Claude. 'OpenRouter' is
// the vendor's own capitalisation — note the wire field is `hasOpenrouterKey`
// with a lowercase r, because the route derives it mechanically from the id.
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
  conversations: [],      // sidebar list for activeDomain: [{id, title, createdAt, messageCount, matchField?}]
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
  selectedConvIds: new Set(),
  // Outcome of the last bulk delete: {text, tone}. Rendered in the sidebar
  // because a partial failure has nowhere else to be seen — the list simply
  // comes back with some rows still in it, which on its own is
  // indistinguishable from having mis-clicked.
  bulkNotice: null,
  activeConversationId: null,
  thread: [],             // [{role, content, citations?, error?}]
  sending: false,
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
};

// Monotonic; source of `state.compileOwner`. Module-scoped (not in `state`)
// because it must never be reset — a reused owner token would let a stale run
// release a newer run's lock, which is the whole thing compileOwner prevents.
let compileRunSeq = 0;

let escHandler = null;

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
    state.sending = false;
    // The abandon path. The clock is module-level precisely so it can be
    // stopped from a DIFFERENT mount than the one that started it: the previous
    // mount's send is still in flight (this view never aborts the fetch), and
    // its interval would otherwise keep ticking against a thinking bubble this
    // fresh mount is not showing.
    stopSendClock();

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

    return () => {
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

  await loadDomainConversations(state.activeDomain, token, { autoSelectMostRecent: true });
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

// `mountToken` here is ALWAYS a value captured by the caller before its own
// first await (see the H1 doc comment above `myMountToken`) — never the
// live module variable re-read late. `convToken` is the pre-existing,
// unrelated SAME-mount guard (two quick domain switches racing each other);
// both are needed and check different things.
// `opts.q` — the search string to ask the SERVER to filter by. Absent or
// empty means no filter, i.e. byte-identical to the pre-search request.
// Callers that refresh the list for some other reason (a send, a delete)
// pass state.searchQuery so a refresh cannot silently drop an active
// filter while the search box still shows its text.
//
// `opts.sidebarOnly` — repaint only the conversation pane and leave the
// selection AND the open thread exactly as they are. This is the search
// path: a user typing in the search box has not asked to close the
// conversation they are reading, and a full renderShell() would rebuild the
// search input itself and drop their focus and caret mid-word.
async function loadDomainConversations(domain, mountToken, opts = {}) {
  const convToken = ++state.convToken;
  const q = typeof opts.q === 'string' ? opts.q.trim() : '';
  const url = '/api/chat/' + encodeURIComponent(domain) + (q ? '?q=' + encodeURIComponent(q) : '');
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (convToken !== state.convToken) return; // a newer domain switch superseded this
    if (!isCurrentMount(mountToken)) return; // H1 fix — this mount may already be gone
    if (!res.ok) throw new Error(data.error || 'Could not load conversations.');
    state.conversations = Array.isArray(data.conversations) ? data.conversations : [];
    state.loadError = null;
  } catch (err) {
    if (convToken !== state.convToken) return;
    if (!isCurrentMount(mountToken)) return;
    state.conversations = [];
    state.loadError = 'Could not load conversations for this domain (' + err.message + ').';
  }

  // Every path that replaces state.conversations passes through here, which
  // is what makes "selection only ever names a visible row" true rather than
  // remembered — including the error path above, where the list becomes
  // empty and the selection must therefore become empty too.
  pruneSelection();

  if (opts.sidebarOnly) {
    renderSidebarConversationsOnly(mountToken);
    return;
  }

  if (opts.autoSelectMostRecent && state.conversations.length > 0) {
    await selectConversation(state.conversations[0].id, mountToken, { skipSidebarRender: true });
  } else {
    state.activeConversationId = null;
    state.thread = [];
  }
  renderShell(mountToken);
}

// See the invariant on state.selectedConvIds. Deliberately a prune rather
// than a clear: a list refresh that leaves the ticked rows on screen (a
// send, an unrelated delete) has no business discarding the user's ticks.
function pruneSelection() {
  if (state.selectedConvIds.size === 0) return;
  const live = new Set(state.conversations.map(c => c.id));
  for (const id of [...state.selectedConvIds]) {
    if (!live.has(id)) state.selectedConvIds.delete(id);
  }
}

// How long after the last keystroke the search refetch fires. Long enough
// that typing a word is one request rather than one per letter; short
// enough to feel immediate. Measured server-side at 500 conversations /
// 11.8 MB: the whole request is ~37 ms with no query and ~42 ms on a
// full-scan miss, so the debounce is here to spare requests, not because
// the query is expensive.
const SEARCH_DEBOUNCE_MS = 220;

function cancelSearchTimer() {
  if (state.searchTimer) { clearTimeout(state.searchTimer); state.searchTimer = null; }
}

function scheduleConversationSearch(mountToken) {
  cancelSearchTimer();
  state.bulkNotice = null; // a stale "Deleted 2 conversations." must not hang over a new search
  state.searchTimer = setTimeout(() => {
    state.searchTimer = null;
    if (!isCurrentMount(mountToken)) return;
    loadDomainConversations(state.activeDomain, mountToken, {
      q: state.searchQuery,
      sidebarOnly: true,
    }).catch(reportAsyncActionFailure);
  }, SEARCH_DEBOUNCE_MS);
}

async function selectConversation(id, mountToken, opts = {}) {
  // H1 fix: guards against an out-of-order resolution WITHIN the same mount
  // (click conversation A, then quickly click B — A's fetch can resolve
  // after B's and must not paint over it) — the same shape as convToken
  // above, distinct from the cross-mount isCurrentMount(mountToken) check.
  const selectToken = ++state.selectToken;
  state.activeConversationId = id;
  try {
    const res = await fetch('/api/chat/' + encodeURIComponent(state.activeDomain) + '/' + encodeURIComponent(id));
    const data = await res.json();
    if (selectToken !== state.selectToken) return;
    if (!isCurrentMount(mountToken)) return;
    if (!res.ok) throw new Error(data.error || 'Could not load this conversation.');
    state.thread = Array.isArray(data.messages) ? data.messages : [];
  } catch (err) {
    if (selectToken !== state.selectToken) return;
    if (!isCurrentMount(mountToken)) return;
    state.thread = [{ role: 'assistant', content: '', error: 'Could not load this conversation (' + err.message + ').' }];
  }
  if (!opts.skipSidebarRender) renderShell(mountToken);
}

// ── Actions ───────────────────────────────────────────────────────────────

// Entered synchronously by a click handler — reading myMountToken here is
// safe (see the doc comment on it above): nothing can have re-mounted
// between the click firing and this line running.
function switchDomain(slug) {
  if (slug === state.activeDomain) return;
  state.activeDomain = slug;
  try { localStorage.setItem(LS_DOMAIN, slug); } catch { /* ignore */ }
  state.activeConversationId = null;
  state.thread = [];
  state.searchQuery = '';
  cancelSearchTimer();          // a keystroke's pending refetch belongs to the OLD domain
  state.selectedConvIds.clear(); // ids are per-domain; carrying them across would target rows that are gone
  state.bulkNotice = null;
  // autoSelectMostRecent: FALSE.
  //
  // This function has already cleared activeConversationId and thread three
  // lines up — the deliberate "you switched scope, here is a blank sheet"
  // state, which renderMain paints as the empty new-chat placeholder. Passing
  // `true` here then had loadDomainConversations immediately re-select
  // conversations[0], so the blank sheet existed only for the duration of the
  // fetch and the user landed inside whatever thread they happened to have
  // opened last in that domain — reading as a switch that did not take.
  //
  // `true` is still correct for the COLD BOOT call (see boot()): there, the
  // user has not asked for anything, and restoring the most recent thread is
  // the useful default rather than an override of an explicit action.
  loadDomainConversations(slug, myMountToken, { autoSelectMostRecent: false }).catch(reportAsyncActionFailure);
  renderShell(myMountToken); // immediate feedback while the fetch is in flight
}

function startNewChat() {
  state.activeConversationId = null;
  state.thread = [];
  renderShell(myMountToken);
  focusComposer();
}

// `mountToken` is passed in by the caller (captured synchronously at click
// time — see wireConvRows below) rather than read fresh here.
//
// UPDATED with the confirm-dialog swap: the staleness reasoning that
// comment recorded still holds, but it now bites HARDER and EARLIER, so it
// is restated rather than left saying something half-true. Before, the
// first statement was `window.confirm`, which is synchronous and BLOCKING —
// nothing could re-mount the view while it was up, and the only await was
// the fetch afterwards. The in-design dialog is a normal in-page overlay:
// it awaits from the very first statement and the user can sit on it
// indefinitely, during which a rail click can tear this mount down and
// build another. So `mountToken` must be the value captured at CLICK time
// (it is — see the two call sites), never `myMountToken` read in here, and
// the isCurrentMount guard below is now load-bearing for a much wider
// window than it used to be.
//
// The destructive work lives INSIDE confirmThen's `onConfirm`, which is
// only ever reached from the dialog's own confirm button. There is no
// decision boolean anywhere in that API to be mis-tested, so the classic
// port of this code — `const ok = openConfirm(...)` without `await`, where
// `ok` is a truthy Promise and the DELETE fires on Cancel — is not
// expressible here. See shared/confirm.js's header.
async function deleteConversationRow(id, title, mountToken) {
  await confirmThen({
    title: 'Delete this conversation?',
    message: title || 'this conversation',
    detail: 'The thread and its messages are removed from this domain. This cannot be undone.',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    tone: 'danger',
    onConfirm: async () => {
      try {
        await fetch('/api/chat/' + encodeURIComponent(state.activeDomain) + '/' + encodeURIComponent(id), { method: 'DELETE' });
      } catch { /* best-effort; the list refresh below will show the true state either way */ }
      if (!isCurrentMount(mountToken)) return; // H1 fix
      if (state.activeConversationId === id) {
        state.activeConversationId = null;
        state.thread = [];
      }
      await loadDomainConversations(state.activeDomain, mountToken, { autoSelectMostRecent: false, q: state.searchQuery });
    },
  });
}

// How many messages one completed chat turn appends to a conversation.
//
// DERIVED FROM THE SERVER, NOT GUESSED: sendMessage in src/brain/chat.js
// pushes exactly one 'user' message and one assistant message and then
// writes the file — so a turn that reached the client with a conversation
// id grew the stored conversation by two. Pinned by a source guard in
// scripts/test-next-chat-sidebar.js, which counts those pushes in the real
// brain file, so a change there turns this constant red instead of letting
// the sidebar quietly drift out of step with the number on disk.
const MESSAGES_PER_TURN = 2;

/**
 * Advance one sidebar row's message count for a turn the server PERSISTED.
 *
 * Gated on a conversation id, and that gate is load-bearing rather than
 * defensive: sendMessage has an early return for a domain whose wiki is
 * empty which answers with prose, writes NOTHING to disk, and reports
 * `conversationId: null`. That response lands in this same branch (it is
 * not `isNew`), so counting it would push the sidebar one turn ahead of the
 * file on every such message. A thrown/aborted turn never reaches here at
 * all — it lands in the catch — and nothing is persisted there either.
 *
 * A row that is not in the list (an active search filtered it out) is left
 * alone rather than invented: there is nothing on screen for the number to
 * be wrong on, and the next list load brings the server's own count.
 *
 * MEASURED, AND RECORDED RATHER THAN OVERCLAIMED: deleting the id gate alone
 * leaves the suite GREEN, because the `.find` below can never match a falsy
 * id either (every id in the list is a server-generated UUID). The gate is
 * therefore DEFENCE IN DEPTH — it states the rule at the top where the next
 * reader meets it — and the `.find` is what actually enforces it today. It is
 * kept, not deleted, because the rule it states is the one a future refactor
 * (a loose `==`, an id-less optimistic row) would break first; it is just not
 * claimed as independently load-bearing.
 */
function bumpMessageCountForTurn(conversationId) {
  if (!conversationId) return;
  const row = state.conversations.find(c => c.id === conversationId);
  if (!row || typeof row.messageCount !== 'number') return;
  row.messageCount += MESSAGES_PER_TURN;
}

/**
 * Delete every ticked conversation.
 *
 * No new endpoint: DELETE /api/chat/:domain/:id already exists and each
 * conversation is one file, so this is N calls to the route the single-row
 * delete has always used — no second server-side deletion path to keep in
 * step with the first, and nothing new to secure.
 *
 * The id list is FROZEN at click time, from state.conversations rather than
 * from the Set: the Set is the source of truth for what is ticked, but
 * intersecting it with the list that is actually on screen means a row that
 * has since disappeared cannot be swept up even if pruneSelection had not
 * already run. Ordering follows the rendered list so the confirm's count and
 * the sidebar agree.
 *
 * Requests are sequential. They are a handful of local file unlinks; firing
 * them in parallel buys milliseconds and costs the ability to say which ones
 * actually succeeded when some of them do not.
 *
 * PARTIAL FAILURE IS REPORTED, NEVER ASSUMED AWAY. `{ success: true }` comes
 * back from the route for an id that names no file at all (deleteConversation
 * is a no-op then), so the honest signal is `res.ok` — the server accepted and
 * acted on the request — and every non-ok or thrown call is counted and named.
 * A run that deletes 3 of 5 says so; the 2 survivors stay ticked, so a retry
 * is one click rather than a re-selection.
 */
async function deleteSelectedConversations(mountToken) {
  const domain = state.activeDomain;
  const ids = state.conversations.filter(c => state.selectedConvIds.has(c.id)).map(c => c.id);
  if (!domain || ids.length === 0) return;
  const n = ids.length;
  const only = n === 1 ? (state.conversations.find(c => c.id === ids[0]) || {}) : null;

  await confirmThen({
    // The count is in the TITLE, not only in the body: it is the whole
    // difference between this dialog and the single-row one, and it is what
    // catches a select-all the user did not mean.
    title: 'Delete ' + n + ' conversation' + (n === 1 ? '' : 's') + '?',
    message: only ? (only.title || 'Untitled') : n + ' selected conversations in ' + domain,
    detail: 'Their threads and messages are removed from this domain. This cannot be undone.',
    confirmLabel: 'Delete ' + n,
    cancelLabel: 'Cancel',
    tone: 'danger',
    onConfirm: async () => {
      const failed = [];
      let deleted = 0;
      for (const id of ids) {
        try {
          const res = await fetch('/api/chat/' + encodeURIComponent(domain) + '/' + encodeURIComponent(id), { method: 'DELETE' });
          if (res.ok) { deleted++; state.selectedConvIds.delete(id); }
          else failed.push(id);
        } catch { failed.push(id); }
      }
      if (!isCurrentMount(mountToken)) return;
      // The domain can have changed under a long run (the dialog is a normal
      // in-page overlay and the loop awaits N requests). The deletes already
      // went to the right domain — `domain` was captured — but the list
      // refresh and the notice belong to whatever is on screen now, and
      // painting a "Deleted 3" over a different domain's sidebar would be a
      // false statement about it.
      if (state.activeDomain !== domain) return;

      // Only the OPEN conversation being one of the ones actually deleted
      // may close the thread. Deleting two unrelated rows must not throw away
      // what the user is reading — which is why the refresh below is
      // `sidebarOnly` rather than the `autoSelectMostRecent: false` the
      // single-row path uses (that arm unconditionally blanks the thread,
      // which is correct there because the row it deleted is usually the open
      // one, and wrong here).
      let closedActiveThread = false;
      if (state.activeConversationId && ids.includes(state.activeConversationId) && !failed.includes(state.activeConversationId)) {
        state.activeConversationId = null;
        state.thread = [];
        closedActiveThread = true;
      }
      state.bulkNotice = failed.length === 0
        ? { text: 'Deleted ' + deleted + ' conversation' + (deleted === 1 ? '' : 's') + '.', tone: 'ok' }
        : { text: 'Deleted ' + deleted + ' of ' + n + '. ' + failed.length + ' could not be deleted and stayed selected — try again.', tone: 'error' };
      await loadDomainConversations(domain, mountToken, { sidebarOnly: true, q: state.searchQuery });
      // sidebarOnly repaints only the pane, so the emptied main area needs
      // its own paint — and only when the thread genuinely closed.
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

  state.sending = true;
  // Started BEFORE the first render, so the bubble's very first paint already
  // carries "0s" rather than blank-then-jump.
  startSendClock(mountToken);
  state.thread.push({ role: 'user', content: text });
  ta.value = '';
  autosize(ta);
  renderThreadOnly(mountToken);
  renderComposerBusy(true, mountToken);

  try {
    const res = await fetch('/api/chat/' + encodeURIComponent(domainAtSend), {
      method: 'POST',
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
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'The request failed.');

    // Must flip BEFORE the relevance check below, regardless of outcome —
    // state.sending is this function's own send-lock and must never be
    // left stuck `true` (silently blocking every future send) just because
    // the view/context moved on while this request was in flight.
    state.sending = false;

    const stillRelevant = isCurrentMount(mountToken) &&
      state.activeDomain === domainAtSend &&
      state.activeConversationId === conversationIdAtSend;
    if (!stillRelevant) return; // this reply no longer belongs anywhere on screen

    const wasNew = !!data.isNew && !!data.conversationId;
    if (data.conversationId) state.activeConversationId = data.conversationId;
    state.thread.push({
      role: 'assistant',
      content: data.answer,
      citations: data.citations || [],
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
    });

    if (wasNew) {
      // Live-verified bug (found while testing an unrelated fix in this
      // same session): loadDomainConversations({autoSelectMostRecent:
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
      await loadDomainConversations(state.activeDomain, mountToken, { autoSelectMostRecent: false, q: state.searchQuery });
      if (!isCurrentMount(mountToken)) return;
      // loadDomainConversations doesn't know which conversation is "active"
      // beyond auto-select, so restore it explicitly and re-render.
      state.activeConversationId = data.conversationId;
      state.thread = threadSoFar;
      renderShell(mountToken);
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
      bumpMessageCountForTurn(data.conversationId);
      renderThreadOnly(mountToken);
      renderSidebarConversationsOnly(mountToken);
    }
  } catch (err) {
    state.sending = false;
    const stillRelevant = isCurrentMount(mountToken) &&
      state.activeDomain === domainAtSend &&
      state.activeConversationId === conversationIdAtSend;
    if (!stillRelevant) return;
    state.thread.push({ role: 'assistant', content: '', error: err.message });
    renderThreadOnly(mountToken);
  } finally {
    state.sending = false;
    // EVERY exit path — resolved, thrown, or returned early as irrelevant —
    // passes through here, which is the only placement that cannot be skipped by
    // a future `return` added above it. See stopSendClock.
    stopSendClock();
    if (isCurrentMount(mountToken)) {
      renderComposerBusy(false, mountToken);
      focusComposer();
    }
  }
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
function buildCompileOutcomeHtml(title, changes, warnings) {
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
      detail = '<span class="chat-compile-change-detail">+<span class="mono">' + c.bulletsAdded + '</span> bullet' + (c.bulletsAdded === 1 ? '' : 's') + sections + '</span>';
    } else if (c.status === 'created') {
      detail = '<span class="chat-compile-change-detail mono">' + formatBytesChat(c.bytesAfter) + '</span>';
    } else if (c.status === 'updated') {
      detail = '<span class="chat-compile-change-detail mono">' + formatBytesChat(c.bytesBefore) + ' → ' + formatBytesChat(c.bytesAfter) + '</span>';
    }
    return '<li><span class="chat-compile-change-path mono">' + escapeHtml(c.canonPath || '') + '</span>' + detail + '</li>';
  };

  const createdBlock = created.length ? (
    '<div class="chat-compile-change-section chat-compile-change-created">' +
      '<div class="chat-compile-change-header">' + icon('plus', 13) + ' <span class="mono">' + created.length + '</span> new ' + (created.length === 1 ? 'page' : 'pages') + '</div>' +
      '<ul class="chat-compile-change-list">' + created.map(formatRecord).join('') + '</ul>' +
    '</div>'
  ) : '';
  const updatedBlock = updated.length ? (
    '<div class="chat-compile-change-section chat-compile-change-updated">' +
      '<div class="chat-compile-change-header">' + icon('activity', 13) + ' <span class="mono">' + updated.length + '</span> ' + (updated.length === 1 ? 'page' : 'pages') + ' updated</div>' +
      '<ul class="chat-compile-change-list">' + updated.map(formatRecord).join('') + '</ul>' +
    '</div>'
  ) : '';
  const emptyBlock = (!created.length && !updated.length)
    ? '<div class="chat-compile-change-empty">No pages were written.</div>'
    : '';
  const unchangedNote = unchanged.length
    ? '<div class="chat-compile-change-unchanged mono">' + unchanged.length + ' page' + (unchanged.length === 1 ? '' : 's') + ' already up to date</div>'
    : '';

  const warningsHtml = (Array.isArray(warnings) && warnings.length)
    ? '<div class="chat-compile-note">' + warnings.map((w) => '<div>' + icon('alertCircle', 12) + ' ' + escapeHtml(w) + '</div>').join('') + '</div>'
    : '';

  return (
    warningsHtml +
    '<div class="chat-compile-change-summary">' +
      '<h3 class="chat-compile-change-title">Compiled to wiki: ' + escapeHtml(title || '') + '</h3>' +
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
  if (btn) btn.disabled = busy;
  if (labelEl) labelEl.textContent = busy ? ('Compiling… ' + Math.round(pct || 0) + '%') : 'Compile to Wiki';
}

// Scrolls so the card's TOP lands at the top of the visible thread area —
// see this section's own header comment for why. #chat-thread has NO
// scroll of its own (see renderThreadOnly's own comment, bottom of this
// file): #main is the real scrolling ancestor, so offsets are measured
// against it, not against the thread element.
//
// `.chat-scopebar` is `position: sticky; top: 0` with an OPAQUE background
// (see chat.css), so it pins to the top of #main's scrollport and covers
// whatever is underneath it. Landing the card at the scrollport's own top
// therefore parked its first rows BEHIND the bar: measured live at 1440x892
// on a 30-change card, the bar occupied 0->55 while `.chat-compile-note` —
// the ONLY signal that compile's full->concise->summary-only ladder degraded
// this run — sat at 8->45, entirely hidden. With no warning present the same
// arithmetic hides the "Compiled to wiki: <title>" heading instead. It bit
// precisely in the case this function exists for (a card taller than the
// viewport). The bar's height is MEASURED, never hardcoded: it wraps and
// grows with the number of scope pills, and its padding comes from tokens.
function scrollCompileCardIntoView(card) {
  const scrollHost = document.getElementById('main');
  if (!scrollHost) return;
  const bar = scrollHost.querySelector('.chat-scopebar');
  const barHeight = bar ? bar.getBoundingClientRect().height : 0;
  const hostRect = scrollHost.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  scrollHost.scrollTop += (cardRect.top - hostRect.top) - barHeight - 8;
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
    if (!compileStillTargetsActive(state.activeConversationId, compileConvId, state.activeDomain, compileDomain)) {
      console.warn('[next/chat] compile finished after the user navigated away — card not shown');
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
  };

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
    renderCompileOutcome(buildCompileOutcomeHtml(final.title, changes, warnings));

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
      if (isCurrentMount(mountToken) && Array.isArray(domainsData.domains)) state.domains = domainsData.domains;
    } catch { /* best-effort, see above */ }
  } catch (err) {
    renderCompileOutcome('<div class="chat-compile-error">' + icon('alertCircle', 14) + ' ' + escapeHtml(err.message) + '</div>');
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

// Conversation rows are `<div role="button" tabindex="0">` (a real <button>
// can't be used because each row also nests a delete <button> — buttons
// can't nest) — so click alone isn't enough for keyboard/AT users; wire
// Enter/Space the same way a native button would respond. `root` scopes
// the query to either the whole sidebar (first render) or just the
// conversation-list element (the lighter re-render after search input).
function wireConvRows(root) {
  root.querySelectorAll('[data-conv-select]').forEach(el => {
    // myMountToken read HERE, inside the handler body, at the moment the
    // event actually fires — not at bind time and not by a wrapper closure
    // capturing it early. Both would be equivalent in practice (this DOM
    // node can only receive an event while its own mount is still live —
    // it's replaced wholesale by setSidebar() on every mount), but reading
    // it fresh at invocation is the least assumption-laden version of "safe
    // because this is a synchronous, real user event".
    el.addEventListener('click', () => selectConversation(el.dataset.convSelect, myMountToken).catch(reportAsyncActionFailure));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectConversation(el.dataset.convSelect, myMountToken).catch(reportAsyncActionFailure);
      }
    });
  });
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
// Row markup, grouping, the empty state and the event wiring all live here
// ONCE. They used to exist as two hand-maintained copies — one inside
// renderSidebar (the full paint) and one inside renderSidebarConversationsOnly
// (the light re-paint) — including two copies of the search predicate. Two
// copies of a renderer is how a fix lands in one of them: adding a checkbox
// or a match hint to only one path would have made a row appear and then
// silently lose its checkbox on the next send. The light path now replaces
// `.chat-conv-pane`'s contents with the SAME builder the full path used, so
// they cannot diverge.

// A row's own "why did this match" hint. Compared with === against the one
// value the server can send, so nothing user- or LLM-derived reaches the
// markup through this field. A title match needs no hint: the title is
// right there and the user can see the word in it.
function matchHint(c) {
  return c.matchField === 'message' ? ' · matched in a message' : '';
}

function conversationRowHtml(c) {
  const selected = state.selectedConvIds.has(c.id);
  const count = typeof c.messageCount === 'number' ? c.messageCount : 0;
  const title = c.title || 'Untitled';
  return (
    '<div class="chat-conv-row' +
        (c.id === state.activeConversationId ? ' active' : '') +
        (selected ? ' selected' : '') +
      '" data-conv-id="' + escapeHtml(c.id) + '">' +
      // Always rendered, never hover-revealed: a control that only exists
      // under the pointer cannot be reached by keyboard at all (the sibling
      // delete button's `display:none` until :hover has exactly that
      // problem), and multi-select is unusable if you cannot find the way in.
      '<input type="checkbox" class="chat-conv-check" data-conv-check="' + escapeHtml(c.id) + '"' +
        (selected ? ' checked' : '') +
        ' aria-label="Select ' + escapeHtml(title) + '">' +
      '<div class="chat-conv-row-main" role="button" tabindex="0" data-conv-select="' + escapeHtml(c.id) + '">' +
        '<div class="chat-conv-title">' + escapeHtml(title) + '</div>' +
        '<div class="chat-conv-meta mono">' + count + ' message' + (count === 1 ? '' : 's') + matchHint(c) + '</div>' +
      '</div>' +
      '<button class="chat-conv-delete" data-conv-delete="' + escapeHtml(c.id) + '" data-conv-title="' + escapeHtml(c.title || '') + '" title="Delete conversation" aria-label="Delete conversation">' +
        icon('trash', 13) +
      '</button>' +
    '</div>'
  );
}

function conversationListHtml() {
  if (state.domains.length === 0) return '';
  if (state.loadError) return '<div class="chat-sidebar-error">' + escapeHtml(state.loadError) + '</div>';

  const query = state.searchQuery.trim();
  // NOT filtered here. state.conversations IS the server's answer for the
  // last completed search (see loadDomainConversations' `q`); re-applying a
  // client-side predicate on top would silently throw away exactly the rows
  // the server-side search exists to find — the ones that matched on a
  // message body rather than on the title this file renders.
  const list = state.conversations;
  if (list.length === 0) {
    return '<div class="sidebar-hint">' +
      (query ? 'No conversations match “' + escapeHtml(state.searchQuery) + '”.' : 'No conversations yet in this domain.') +
      '</div>';
  }

  const today = [];
  const earlier = [];
  const now = new Date().toISOString();
  for (const c of list) (isSameLocalDay(c.createdAt, now) ? today : earlier).push(c);

  const groupHtml = (label, group) => group.length === 0 ? '' : (
    '<div class="chat-conv-group-label mono">' + label + '</div>' + group.map(conversationRowHtml).join('')
  );
  return groupHtml('TODAY', today) + groupHtml('EARLIER', earlier);
}

// The select-all / count / clear / delete strip. Present whenever there is
// anything to select, so "select all" is discoverable without first having
// to guess that ticking a row reveals more controls; the destructive half
// appears only once something is actually selected.
function bulkBarHtml() {
  if (state.domains.length === 0 || state.loadError || state.conversations.length === 0) return '';
  const n = state.selectedConvIds.size;
  const allChecked = n > 0 && n >= state.conversations.length;
  return (
    '<div class="chat-bulk-bar">' +
      '<label class="chat-bulk-all">' +
        '<input type="checkbox" id="chat-bulk-all"' + (allChecked ? ' checked' : '') + ' aria-label="Select all conversations">' +
        '<span class="mono">' + (n === 0 ? 'Select all' : n + ' selected') + '</span>' +
      '</label>' +
      (n > 0
        ? '<button type="button" class="chat-bulk-link" id="chat-bulk-clear">Clear</button>' +
          '<button type="button" class="chat-bulk-delete" id="chat-bulk-delete" aria-label="Delete ' + n + ' selected conversation' + (n === 1 ? '' : 's') + '">' +
            icon('trash', 12) + ' Delete' +
          '</button>'
        : '') +
    '</div>'
  );
}

function bulkNoticeHtml() {
  const notice = state.bulkNotice;
  if (!notice || !notice.text) return '';
  return '<div class="chat-bulk-notice' + (notice.tone === 'error' ? ' error' : '') + '" role="status">' +
    escapeHtml(notice.text) + '</div>';
}

function conversationPaneHtml() {
  return bulkBarHtml() + bulkNoticeHtml() + '<div class="chat-conv-list">' + conversationListHtml() + '</div>';
}

// Wires everything inside the pane: row select (click + keyboard), per-row
// delete, per-row checkbox, and the bulk strip. One function, called from
// both render paths, for the same reason the markup is one builder.
function wireConversationPane(root) {
  wireConvRows(root);

  root.querySelectorAll('[data-conv-delete]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversationRow(el.dataset.convDelete, el.dataset.convTitle, myMountToken).catch(reportAsyncActionFailure);
    });
  });

  root.querySelectorAll('[data-conv-check]').forEach(el => {
    // No stopPropagation: the checkbox is a SIBLING of .chat-conv-row-main,
    // not a descendant, so a click on it never passes through the row's own
    // select handler. (The delete button above suppresses defensively; it is
    // a sibling too.)
    el.addEventListener('change', () => {
      if (el.checked) state.selectedConvIds.add(el.dataset.convCheck);
      else state.selectedConvIds.delete(el.dataset.convCheck);
      renderSidebarConversationsOnly(myMountToken);
    });
  });

  const allBox = root.querySelector('#chat-bulk-all');
  if (allBox) {
    const n = state.selectedConvIds.size;
    // Not expressible as an attribute — indeterminate is a DOM property only.
    allBox.indeterminate = n > 0 && n < state.conversations.length;
    allBox.addEventListener('change', () => {
      if (allBox.checked) for (const c of state.conversations) state.selectedConvIds.add(c.id);
      else state.selectedConvIds.clear();
      renderSidebarConversationsOnly(myMountToken);
    });
  }

  const clearBtn = root.querySelector('#chat-bulk-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    state.selectedConvIds.clear();
    renderSidebarConversationsOnly(myMountToken);
  });

  const deleteBtn = root.querySelector('#chat-bulk-delete');
  if (deleteBtn) deleteBtn.addEventListener('click', () => {
    deleteSelectedConversations(myMountToken).catch(reportAsyncActionFailure);
  });
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

  setSidebar(
    '<div class="sidebar-title">Chat</div>' +
    '<button class="btn btn-primary chat-new-btn" id="chat-new-btn">' + icon('plus', 14) + ' New chat</button>' +
    (state.domains.length > 0
      ? '<div class="chat-search-wrap">' +
          '<span class="chat-search-icon">' + icon('search', 13) + '</span>' +
          '<input type="text" class="chat-search-input" id="chat-search-input" placeholder="Search conversations…" value="' + escapeHtml(state.searchQuery) + '">' +
        '</div>' +
        '<div class="chat-conv-pane">' + conversationPaneHtml() + '</div>'
      : '<div class="sidebar-hint">No domains exist yet — nothing to chat with.</div>'),
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
  }

  const pane = document.querySelector('.chat-conv-pane');
  if (pane) wireConversationPane(pane);
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
  paneEl.innerHTML = conversationPaneHtml();
  wireConversationPane(paneEl);
}

function renderMain(token) {
  if (!isCurrentMount(token)) return;

  // Chat has no domain-creation UI of its own — Domains owns that
  // (openLifecycle('create'), a real modal over POST /api/domains). A
  // zero-domain user is routed there rather than shown a duplicate create
  // flow; see resolveBootDomain()'s own comment for why a Chat-side
  // create-domain panel used to exist here and was removed.
  // Never assert "you have no domains" before boot() has answered. Until
  // then the chat chrome is painted with an empty body — and a loader only
  // if the gate fires. `loadError` is excluded because that frame is a
  // real conclusion with its own rendering elsewhere; waiting on it here
  // would replace an error with a spinner.
  if (!state.booted && !state.loadError && state.domains.length === 0) {
    setMain(
      eyebrow('the default view') +
      '<h1 class="view-title">Chat</h1>' +
      gatedLoader(bootGate, 'Loading…'),
      token
    );
    return;
  }

  if (state.domains.length === 0) {
    setMain(
      eyebrow('the default view') +
      '<h1 class="view-title">Chat</h1>' +
      '<div class="view-body">Chat needs at least one domain to talk to. Create one in Domains, then come back here.</div>' +
      '<button class="btn btn-primary" id="chat-goto-domains">' + icon('plus', 13) + ' Go to Domains</button>',
      token
    );
    const btn = document.getElementById('chat-goto-domains');
    if (btn) btn.addEventListener('click', () => navigate('domains'));
    return;
  }

  const active = state.domains.find(d => d.slug === state.activeDomain) || state.domains[0];
  const pageCount = active ? active.pageCount : 0;

  const scopePills = state.domains.map(d => (
    '<button class="chat-scope-pill' + (d.slug === state.activeDomain ? ' active' : '') + '" data-scope-domain="' + escapeHtml(d.slug) + '">' +
      '<span class="chat-type-dot" style="background:var(--accent)"></span>' + escapeHtml(d.displayName || d.slug) +
    '</button>'
  )).join('');

  setMain(
    '<div class="chat-view">' +
      '<div class="chat-scopebar">' +
        '<span class="chat-scope-eyebrow mono">SCOPE</span>' +
        '<div class="chat-scope-pills">' + scopePills + '</div>' +
        '<div class="chat-scope-spacer"></div>' +
        renderCompileButtonHtml() +
        '<span class="chat-scope-count mono">' + pageCount.toLocaleString() + ' page' + (pageCount === 1 ? '' : 's') + ' in scope</span>' +
      '</div>' +
      '<div class="chat-thread" id="chat-thread"></div>' +
      renderComposerHtml(active) +
    '</div>',
    token
  );

  document.querySelectorAll('[data-scope-domain]').forEach(btn => {
    btn.addEventListener('click', () => switchDomain(btn.dataset.scopeDomain));
  });
  document.getElementById('chat-compile-btn')?.addEventListener('click', () => runCompile().catch(reportAsyncActionFailure));

  wireComposer();
  renderThreadOnly(token);
  renderComposerPickers();
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
    '<button class="chat-compile-btn" id="chat-compile-btn"' + (state.compileBusy ? ' disabled' : '') +
      ' title="Save this conversation as wiki pages">' +
      icon('sparkles', 13) + ' <span id="chat-compile-btn-label">' + escapeHtml(label) + '</span>' +
    '</button>'
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

function renderComposerHtml(active) {
  const placeholder = active ? 'Ask ' + (active.displayName || active.slug) + '…' : 'Ask this domain…';

  return (
    '<div class="chat-composer-wrap">' +
      '<div class="chat-composer" id="chat-composer">' +
        '<textarea class="chat-input" id="chat-input" rows="2" placeholder="' + escapeHtml(placeholder) + '"></textarea>' +
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
          '<span class="chat-cost-hint mono">cost varies with response length</span>' +
          '<button class="chat-send-btn" id="chat-send-btn" title="Send (⌘/Ctrl + Enter)" aria-label="Send">' +
            icon('send', 15) +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="chat-foot-hint mono">Answers cite the pages they came from. Click a citation to read the page.</div>' +
    '</div>'
  );
}

// ── Model picker: pure helpers ────────────────────────────────────────────
// Everything below is DOM-free and side-effect-free so the whole surface is
// executable offline (scripts/test-next-composer-model.js extracts and runs
// these directly). Nothing here reads module state — every input is a
// parameter — which is what makes "an unkeyed provider is not selectable"
// provable rather than asserted about source text.

// ── THE BADGE THAT WAS ON 97% OF THE LIST, AND IS NOW ON NONE OF IT ───────
//
// `chat-only` used to render here as "chat only — not for ingest". Counted
// against a synced catalogue: 194 of 213 offerable models carry it — every
// fetched OpenRouter entry, by construction, because `defineOfferableModel`
// admits a dynamic entry only as chat-only. A flag on 97% of a list is not a
// warning, it is wallpaper; it is the same finding v3.16.1 recorded about the
// caution flag ("every FETCHED catalogue entry is 'flagged' by construction"),
// arriving through a different field.
//
// It is also redundant on THIS surface specifically. The composer picks the
// model that answers a CHAT turn; there is no ingest decision on this screen to
// warn about, and the fact a user actually needs — which model builds the wiki —
// is stated positively in Settings ("This model builds your wiki", v3.14.0). A
// model's absence from the BUILD list is the message.
//
// THE UNDERLYING FIELD IS UNTOUCHED. `suitability` is still enforced at two
// layers in llm.js (`isBuildLaneModel` and the lane split), still rendered by
// Settings' picker, and still pinned by scripts/test-next-model-picker.js. This
// removes a LABEL from one menu, not a constraint from the app.
//
// `caution` stays, and stays word-for-word aligned with settings.js's
// MODEL_SUITABILITY_BADGES: it flags a specific measured hazard on a small
// number of models, and its reason is on the row (`cautionReason`, the first
// clause of the derived summary). There is no shared JS constant the two views
// import, so this comment is the enforcement point: change the word here and
// change it in settings.js in the same commit.
const SUITABILITY_LABELS = Object.assign(Object.create(null), {
  caution: 'caution',
});

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
// MODULE LEVEL, NOT `state`. `state` is reassigned WHOLESALE by every onEnter,
// and this interval must keep ticking and — far more importantly — must be
// CLEARABLE across a re-mount. A timer that survives its own turn writing into
// a live thread is the "button left permanently reading Fixing…" shape this
// repo has already shipped once.
let sendStartedAt = null;
let sendTimerId = null;
// What we measured for the model serving THIS turn: `{label, ms}` or null.
// Captured at send time because the composer stays live during the call.
let sendLatencyHint = null;

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
  const ms = row.entry.medianLatencyMs;
  if (Number.isFinite(ms) && ms >= 1000) return { kind: 'measured', label, ms };
  const range = measuredLatencyRange(state.offerable, state.availableProviders);
  // No range either (a catalogue with fewer than two measured models): nothing
  // to say, so nothing is said. The clock still ticks.
  if (!range) return null;
  return { kind: 'unmeasured', label, lowMs: range.lowMs, highMs: range.highMs };
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
  if (hint.kind === 'measured') {
    return hint.label + ' measured at about ' + formatDurationMs(hint.ms) +
      ' per call in our testing, on a full ingest outline — a much larger prompt than a chat turn.';
  }
  return 'We have no timing measurement for ' + hint.label + '. ' +
    'Across the models we have measured, one call took anywhere from ' +
    formatDurationMs(hint.lowMs) + ' to ' + formatDurationMs(hint.highMs) + '.';
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
  const slowText = elapsedMs >= SLOW_TURN_NOTICE_AFTER_MS ? slowTurnNoticeText(sendLatencyHint) : '';
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
    '<div class="chat-thinking"><span class="chat-spinner"></span> thinking… ' +
      '<span class="mono" id="chat-think-elapsed">' + escapeHtml(formatDurationMs(elapsedMs)) + '</span>' +
    '</div>' +
    '<div id="chat-think-slow">' + slow + '</div>'
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
    if (slotEl && elapsedMs >= SLOW_TURN_NOTICE_AFTER_MS && !slotEl.firstChild) {
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
  // An EMPTY working set also lands here (a backend too old to send
  // `measuredBy`, with no stars and no recents): showing everything is the only
  // honest answer, since we have no fact to select on.
  if (total <= WORKING_SET_COLLAPSE_ABOVE || rows.length >= total || rows.length === 0) {
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
 * ── A PRE-EXISTING APPROXIMATION, INHERITED KNOWINGLY ────────────────────
 * `cachedReadTokens * price.input * 0.1` is ANTHROPIC's cached-read multiplier.
 * Chat sends no cache breakpoint at all (`cachePrefixChars` is passed only by
 * ingest.js), so both providers measure 0 cache-write here — but GEMINI's
 * IMPLICIT cache can still populate `cachedReadTokens`, and Gemini's implicit
 * discount is not 0.1x. Applying one provider's multiplier to the other is
 * therefore an approximation on that one term. It is inherited deliberately and
 * unchanged from `chargeForItem`, which has always done exactly this: fixing it
 * would mean diverging from the formula this mirrors, which is the drift the
 * mirror exists to prevent. Recorded here so the next reader knows it is a known
 * approximation rather than an oversight.
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
  // ── chargeForItem's formula, term for term ──────────────────────────────
  const inCost = (u.inputTokens || 0) / 1e6 * input;
  const outCost = (u.outputTokens || 0) / 1e6 * output;
  const cachedReadCost = (u.cachedReadTokens || 0) / 1e6 * input * 0.1;
  const cacheWriteCost = (u.cacheWriteTokens || 0) / 1e6 * input * 1.25;
  const total = inCost + outCost + cachedReadCost + cacheWriteCost;
  return Number.isFinite(total) ? total : null;
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
 * The `title` carries the token counts behind the figure, so a user who wants
 * to check the arithmetic against their provider's own dashboard can, without
 * the thread growing a table. The free case still carries a title when usage
 * is on hand — "free" is a price, not an absence of tokens.
 */
function assistantCostHtml(m, ctx) {
  const usd = messageCostUsd(m, ctx);
  const u = messageUsageTokens(m);
  const title = u
    ? u.inputTokens + ' in / ' + u.outputTokens + ' out' +
      (u.cachedReadTokens ? ' / ' + u.cachedReadTokens + ' cached' : '') +
      (u.cacheWriteTokens ? ' / ' + u.cacheWriteTokens + ' cache write' : '') +
      ' tokens'
    : '';
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
    return '<span class="chat-msg-cost" title="' + escapeHtml(title) + '">' +
      ' · free</span>';
  }
  const text = formatUsdHonest(usd);
  // formatUsdHonest returns null for anything that is not a finite number. It
  // cannot happen here (messageCostUsd already guaranteed one), but a formatter
  // that CAN say "no figure" must never have that answer interpolated as the
  // string "null" on a spend line.
  if (text === null) return '';
  return '<span class="chat-msg-cost" title="' + escapeHtml(title) + '">' +
    ' · ' + escapeHtml(text) + '</span>';
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
 */
function assistantEyebrowHtml(m, ctx) {
  const d = describeAnswerModel(m, ctx);
  // The cost rides INSIDE the eyebrow, computed from THIS message — same
  // reasoning as the model label directly beside it: `renderThreadOnly` rebuilds
  // the whole thread with one `innerHTML = ...`, so anything derived from
  // view-level state would restamp every historical answer. A relabelled model
  // was the v3.13.2 bug; a re-priced history would be the same bug about money.
  const eyebrow =
    '<div class="chat-msg-eyebrow mono">THE CURATOR · ' + escapeHtml(d.label) +
      assistantCostHtml(m, ctx) +
    '</div>';
  if (!d.diverged) return eyebrow;
  return eyebrow +
    '<div class="chat-msg-fallback">' +
      'Requested ' + escapeHtml(d.requestedLabel) + ' — answered by ' + escapeHtml(d.label) +
      '. You are billed for the model that answered.' +
    '</div>';
}

/**
 * A price per 1M tokens as a display string, or null when the value is not a
 * finite number. NEVER substitutes a placeholder number — an unknown price is
 * rendered as "price unavailable", because a fabricated 0 on a spend surface is
 * the honesty defect this whole catalogue exists to remove.
 */
function formatPricePerM(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return '$' + n.toFixed(2).replace(/\.00$/, '');
}

/**
 * "$1 in / $5 out per 1M" from the LIVE (promotion-resolved) fields — or
 * 'free' / 'price unavailable', which are DIFFERENT facts and must not
 * collapse into one string.
 *
 * `entry.free === true` is llm.js's own reported fact that this model bills
 * nothing (see FREE_MODELS in src/brain/llm.js) — a free model's `input`/
 * `output` are `null` BY DESIGN, never `0`, precisely so a budget guard can
 * never mistake "known to be free" for a truthy zero it must "enforce" (the
 * v3.3.0 shape). So `free` is checked FIRST, ahead of the price fields, and
 * is the ONLY thing this function branches on to say "free" — never a price
 * of 0 (a real model could in principle be priced at exactly $0/$0 and that
 * would still not mean "free" without the flag), never a provider id, and
 * never an id substring like ":free" (llm.js's own docblock records why
 * OpenRouter's `:free` suffix is not a safe membership test — a router id
 * and two audio models are zero-priced but not actually free).
 *
 * A model with NO `free` flag and no usable price is a DIFFERENT fact — the
 * catalogue did not tell us what this costs — and must keep saying so rather
 * than being read as free. "Free" and "unknown" must never render the same.
 */
function formatLivePrice(entry) {
  if (entry && entry.free === true) return 'free';
  const inp = formatPricePerM(entry && entry.input);
  const out = formatPricePerM(entry && entry.output);
  if (inp === null || out === null) return 'price unavailable';
  return inp + ' in / ' + out + ' out per 1M';
}

/**
 * '2027-01-01' -> '1 Jan 2027'.
 *
 * Parsed from the ISO COMPONENTS, never via `new Date(iso)` +
 * `toLocaleDateString`: that reads the string as UTC midnight and then renders
 * it in the viewer's zone, so anyone west of Greenwich would be told a price
 * rises on 31 Dec 2026. An off-by-one on a price date is a small lie about
 * money. Unparseable input returns the raw string rather than inventing a date.
 *
 * A DELIBERATE SECOND COPY of settings.js's `formatIsoDay`, not a shared
 * import: that module is an independent view with no shared date utility, and
 * this release does not own it. The composer previously rendered this same fact
 * as a raw ISO string while Settings humanised it — one date, two renderings,
 * one app. NOT ENFORCED, and said plainly: nothing mechanically pins these two
 * functions together; if this behaviour changes, change settings.js's copy in
 * the same commit. The suites assert the OUTPUT on each side independently.
 */
function formatIsoDay(iso) {
  if (typeof iso !== 'string') return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIdx = Number(m[2]) - 1;
  if (monthIdx < 0 || monthIdx > 11) return iso;
  return String(Number(m[3])) + ' ' + MONTHS[monthIdx] + ' ' + m[1];
}

/**
 * The coming rise, when `input`/`output` are a promotion rather than the
 * standing price. Returns '' when there is no promotion — so a caller that
 * renders this unconditionally shows nothing extra for a normally-priced model.
 * A promoted price shown with no mention of the rise reads as permanent, which
 * is the same class of misstatement as showing the standard price as current.
 */
function formatPromotionRise(entry) {
  if (!entry || !entry.promotionUntilIso) return '';
  // ── Only claim a rise that has not already happened ──────────────────────
  // `promotionUntilIso` stays populated AFTER a promotion expires, at which
  // point llm.js's `input`/`output` getters have already resolved to the
  // standing figures. The old truthiness-only check would therefore keep
  // telling a 2027 reader that this price "rises to $1.50" while the price
  // line directly above it already read $1.50 — a warning about a change that
  // has already happened, on the one surface whose whole job is to say what
  // something costs. settings.js's renderModelRow has carried this guard since
  // the picker shipped (`promoActive`); the composer did not, and the drift
  // was invisible because today's clock is on the promoted side of the date.
  //
  // SUPPRESS ONLY ON POSITIVE EVIDENCE OF EXPIRY. If any of the four figures
  // is missing we cannot establish that the promotion has ended, and the
  // fail-safe direction on money is to WARN (v3.9.0's rule) — so an entry with
  // unknown standard prices still discloses that a rise is coming, via the
  // date-only fallback below. Going silent because we could not tell would
  // turn "we don't know" into "there is nothing to know".
  const bothKnown =
    typeof entry.input === 'number' && typeof entry.standardInput === 'number' &&
    typeof entry.output === 'number' && typeof entry.standardOutput === 'number';
  const expired = bothKnown &&
    entry.input === entry.standardInput && entry.output === entry.standardOutput;
  if (expired) return '';
  const inp = formatPricePerM(entry.standardInput);
  const out = formatPricePerM(entry.standardOutput);
  const from = typeof entry.standardPriceFromIso === 'string' && entry.standardPriceFromIso
    ? entry.standardPriceFromIso
    : entry.promotionUntilIso;
  if (inp === null || out === null) return 'promotional price — rises after ' + formatIsoDay(entry.promotionUntilIso);
  return 'promotional price — rises to ' + inp + ' / ' + out + ' on ' + formatIsoDay(from);
}

/**
 * THE BODY of one model row — everything inside it, and none of its wrapper.
 * Every interpolated value is server-supplied → escaped.
 *
 * TWO SURFACES RENDER THIS: the composer's shared-listbox menu (which owns the
 * row ELEMENT, and therefore all of the keyboard and ARIA behaviour, and takes
 * this string as `html`) and the browse dialog (via `renderModelOptionHtml`
 * below). Splitting the body from the wrapper is what lets those two be one
 * description of one model rather than two that can drift.
 *
 * ── WHY THIS ROW NO LONGER CARRIES THE FULL `note` ──────────────────────────
 * It used to render `entry.note` inline for every FLAGGED model — and once the
 * live OpenRouter catalogue landed, every fetched chat-only entry is flagged, so
 * a dropdown became several screens of two-hundred-word paragraphs. That was the
 * maintainer's report. The note is not shortened and not truncated: it is shown
 * whole in Settings, behind that screen's existing per-model disclosure, and
 * what stands here is the derived one-liner from shared/model-summary.js.
 *
 * THE SUMMARY IS NOT OPTIONAL FOR A FLAGGED MODEL. `defineOfferableModel`
 * refuses to build a `caution` or `dominated` entry without a `cautionReason`,
 * and that string is the summary's first clause — so the reason for a warning
 * badge is on screen with nothing to open, which is the property this row is
 * required to have. `isFlaggedModel` was deleted with the inline note: it
 * existed only to gate that note, and re-deriving "is this flagged" here is how
 * the badge and the prose drift apart.
 *
 * WHY THERE IS NO DISCLOSURE ON THIS SURFACE. Every row is a `[role="option"]`.
 * A `<details>` inside one would put an interactive control inside an
 * interactive control — the v3.0.1-beta.18 hazard, in the shape that cannot be
 * fixed with `stopPropagation` because it breaks the listbox's own semantics.
 * So the composer summarises and Settings discloses, and the menu carries one
 * footer line saying so. The STAR in the browse dialog is a sibling BUTTON
 * outside the option element for exactly the same reason — the v3.13.0 pattern.
 */
function renderModelRowBodyHtml(provider, entry, opts) {
  const o = opts || {};
  // COMPACT on this surface. A dropdown opened mid-thought needs the model, the
  // price and any warning — not the measured coverage, which is what Settings'
  // denser row and its expand are for. Same builder, same words, less of them.
  const summary = formatModelSummary(entry, { compact: true });
  const rise = formatPromotionRise(entry);
  const badges = [];
  // ── SUITABILITY, NARROWED TO WHAT IS ACTUALLY A WARNING ──────────────────
  // Gated on the LABEL TABLE having an entry, not on `!== 'general'`. That is
  // the load-bearing difference: the old test rendered the raw field value as a
  // fallback, so dropping 'chat-only' from the table would have printed the bare
  // string "chat-only" on 194 rows instead of removing the badge. A value with
  // no label is a value this surface has decided not to badge.
  const suitLabel = typeof entry.suitability === 'string'
    && Object.hasOwn(SUITABILITY_LABELS, entry.suitability)
    ? SUITABILITY_LABELS[entry.suitability] : null;
  if (suitLabel) {
    badges.push('<span class="chat-mm-badge is-warn">' + escapeHtml(suitLabel) + '</span>');
  }
  // Label kept in sync with settings.js's MODEL_SUITABILITY_BADGES-adjacent
  // `dominated` badge (search for "out-performed" there): same underlying
  // `OFFERABLE_MODELS[].dominated` flag (src/brain/llm.js, not owned by this
  // view), same user-facing word on both surfaces. "dominated" is measurement
  // jargon a user does not think in; "out-performed" says the same fact in
  // plain language. See scripts/test-next-composer-model.js /
  // scripts/test-next-model-picker.js for the assertions pinning this string
  // on both sides — there is no single shared JS constant the two views both
  // import (they are independent modules with independent badge tables), so
  // this comment is the enforcement point: if you change the word here,
  // change it in settings.js's renderModelOption in the same commit.
  if (entry.dominated === true) badges.push('<span class="chat-mm-badge is-warn">out-performed</span>');
  if (entry.thinks === true) badges.push('<span class="chat-mm-badge">thinks</span>');

  // ── THE PROVIDER, ON EVERY ROW ───────────────────────────────────────────
  // Group headings alone stopped working the moment ~194 OpenRouter rows landed
  // under one of them: scroll past the first screen and no heading is in view,
  // so a row 40 deep names a model and not who serves it — which is the one
  // fact that decides whose key pays for it. A per-row marker costs the same
  // wherever the scroll happens to be.
  //
  // TEXT PLUS A DOT, never a dot alone: colour alone is not an accessible
  // distinction, so the three families are told apart by the WORD and the colour
  // is a scanning aid on top of it. chat.css records the measured contrast of
  // both halves in both themes.
  const provLabel = Object.hasOwn(PROVIDER_LABELS, provider) ? PROVIDER_LABELS[provider] : provider;
  // The class comes from an ALLOW-LIST, never interpolated from the provider
  // string — a class attribute assembled out of payload text is a way to smuggle
  // a selector. An unknown provider gets the neutral swatch and its own name.
  const provClass = Object.hasOwn(PROVIDER_LABELS, provider) ? ' is-' + provider : '';
  const prov =
    '<span class="chat-mm-prov' + provClass + '">' +
      '<span class="chat-mm-prov-dot" aria-hidden="true"></span>' +
      escapeHtml(provLabel) +
    '</span>';

  // Why a row is in the working set — rendered only where it says something the
  // row does not already say. `selected` is deliberately absent: the check mark
  // and the trigger label both already carry it.
  const marks = [];
  const reasons = Array.isArray(o.reasons) ? o.reasons : [];
  if (reasons.includes('starred') || o.starred === true) {
    marks.push('<span class="chat-mm-mark is-star" title="Starred">★</span>');
  }
  if (reasons.includes('recent')) {
    marks.push('<span class="chat-mm-mark" title="You used this recently">recent</span>');
  }

  return (
    '<span class="chat-mm-head">' +
      '<span class="chat-dd-opt-title">' + escapeHtml(entry.label || entry.id) + '</span>' +
      prov +
      marks.join('') +
      badges.join('') +
    '</span>' +
    '<span class="chat-dd-opt-desc mono">' + escapeHtml(entry.id) + '</span>' +
    '<span class="chat-mm-price mono">' + escapeHtml(formatLivePrice(entry)) + '</span>' +
    (rise ? '<span class="chat-mm-rise">' + escapeHtml(rise) + '</span>' : '') +
    (summary ? '<span class="chat-mm-note">' + escapeHtml(summary) + '</span>' : '')
  );
}

/**
 * The BROWSE DIALOG's wrapper around the same body.
 *
 * ONE BODY BUILDER, TWO WRAPPERS, and that is the point. The composer's menu row
 * is a shared-listbox `div[role="option"]` this file does not own; the browse
 * dialog's is a `<button>` it does. If each surface built its own body, the
 * price, the badges and the warning would be free to disagree between the two
 * lists the user is comparing models across — two hand-maintained descriptions
 * of one measured fact, this repo's named cause of the v3.2.0 CRITICAL.
 */
function renderModelOptionHtml(provider, entry, selectedId, opts) {
  const isActive = entry.id === selectedId;
  // ── A PLAIN BUTTON, NOT A `role="option"` ────────────────────────────────
  // The browse dialog is a SEARCH RESULTS list, not a listbox: each row carries
  // a pick control AND a star control, and a `role="listbox"` whose options
  // contain a second interactive control is a broken listbox — the
  // v3.0.1-beta.18 hazard, and the reason the composer's rich rows delegate
  // their semantics to shared/listbox.js instead of hand-rolling them here.
  // Two native buttons per row means native focus, native activation and a
  // native tab order, with no ARIA to get wrong.
  //
  // `aria-current` rather than `aria-selected`: valid outside a listbox, and it
  // says the true thing — this is the model currently in use.
  return (
    '<button type="button" class="chat-dd-opt chat-mm-opt chat-browse-pick' + (isActive ? ' is-active' : '') +
      '"' + (isActive ? ' aria-current="true"' : '') +
      ' data-model-id="' + escapeHtml(entry.id) + '" data-model-provider="' + escapeHtml(provider) + '">' +
      renderModelRowBodyHtml(provider, entry, opts) +
    '</button>'
  );
}

/**
 * The BROWSE DIALOG's list: one group per KEYED provider, each cheapest-first
 * exactly as the server ordered it. Returns '' when nothing is pickable, so the
 * caller can say "no model matches" rather than render an empty box.
 *
 * Takes a FLAT, already-filtered row list (`[{provider, entry, reasons?}]`) and
 * regroups it, rather than walking `offerable` itself — because the dialog's
 * search and its free-only/provider filters have already decided what belongs
 * here, and a second walk would let the header rows disagree with the body rows
 * about what is on screen.
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
      // An `<li>`, not a `<div>`: this list is a real `<ul>` and a `<div>` is
      // not valid content inside one. `role="presentation"` keeps it out of the
      // list's item count for a screen reader, where it is a heading and not an
      // eighth model.
      html += '<li class="chat-mm-group" role="presentation">' +
        escapeHtml(Object.hasOwn(PROVIDER_LABELS, row.provider) ? PROVIDER_LABELS[row.provider] : row.provider) +
        '</li>';
      lastProvider = row.provider;
    }
    const isStarred = starred.has(row.entry.id);
    html += '<li class="chat-browse-row">' +
      renderModelOptionHtml(row.provider, row.entry, selectedId, {
        reasons: row.reasons,
        starred: isStarred,
      }) +
      // ── THE STAR IS A SIBLING, NOT A CHILD ─────────────────────────────
      // The v3.13.0 pattern, for the reason recorded there: a control nested
      // inside another control has to suppress propagation to work at all, and
      // any later edit that drops the suppression silently re-breaks it. As a
      // sibling there is NO propagation path to suppress, so it cannot regress.
      // `aria-pressed` makes it a real toggle to a screen reader; the label
      // names the model, because "Star" alone is meaningless in a list of 213.
      '<button type="button" class="chat-mm-star' + (isStarred ? ' is-on' : '') + '"' +
        ' data-star-id="' + escapeHtml(row.entry.id) + '"' +
        ' aria-pressed="' + (isStarred ? 'true' : 'false') + '"' +
        ' title="' + (isStarred ? 'Starred — always in your working set' : 'Star: keep this in your working set') + '"' +
        ' aria-label="' + (isStarred ? 'Unstar ' : 'Star ') + escapeHtml(row.entry.label || row.entry.id) + '">' +
        icon('star', 13) +
      '</button>' +
    '</li>';
    rows++;
  }
  // ── WHERE THE FULL MEASUREMENT WENT ──────────────────────────────────────
  // Each row now carries a derived one-liner instead of the model's whole
  // measured `note` (see renderModelOptionHtml). The note still exists, whole
  // and verbatim, behind Settings' per-model expand — so this says so once for
  // the menu rather than leaving the reader to guess that the evidence was
  // deleted rather than moved.
  //
  // A PLAIN DIV, CARRYING NO `data-model-id`. The pick handler binds to
  // `[data-model-id]` only, so nothing here is clickable and nothing can be
  // selected by mistake; it sits alongside the existing `.chat-mm-group`
  // headers, which are already non-row children of this list.
  const foot = rows
    ? '<div class="chat-mm-foot">Full measurements for each model: Settings → API keys</div>'
    : '';
  return rows ? '<ul class="chat-browse-ul">' + html + '</ul>' + foot : '';
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

  const options = ws.rows.map(row => ({
    // PROVIDER-QUALIFIED — see modelOptionValue. Two rows can never share one
    // value, so the listbox's resolve-by-value cannot cross providers.
    value: modelOptionValue(row.provider, row.entry.id),
    label: row.entry.label || row.entry.id,
    group: Object.hasOwn(PROVIDER_LABELS, row.provider) ? PROVIDER_LABELS[row.provider] : row.provider,
    // Type-ahead reaches the ID as well as the label, so "deepseek" and "opus"
    // both land somewhere. The listbox tries a prefix match first and falls back
    // to a substring, so the label still wins for a leading match.
    typeahead: (row.entry.label || '') + ' ' + row.entry.id,
    html: renderModelRowBodyHtml(row.provider, row.entry, {
      reasons: row.reasons,
      starred: starred.has(row.entry.id),
    }),
  }));

  // THE ESCAPE HATCH, PRESENT ONLY WHEN IT LEADS SOMEWHERE ELSE.
  // `collapsed` is false whenever the working set is not actually smaller than
  // the catalogue, so a user looking at every model they have is never offered
  // a button that opens the list already in front of them.
  if (ws.collapsed) {
    options.push({
      value: BROWSE_MODEL_VALUE,
      label: 'Browse all ' + ws.total + ' models',
      action: true,
      html: '<span class="chat-mm-browse">' + icon('search', 13) +
        '<span>Browse all ' + ws.total + ' models - search, filter, star</span></span>',
    });
  }

  // ── NO `|| 'gemini'` TERMINAL FALLBACK ───────────────────────────────────
  // This chain used to end in the literal 'gemini', so with NOTHING resolved -
  // no selection, no active provider, no keyed provider at all - the composer
  // confidently rendered "Gemini default" to a user who may have no Gemini key.
  // Naming a specific vendor as a stand-in for "we do not know" is a small lie
  // on a surface whose entire job is saying which model answers.
  const shownProvider = state.modelProvider || state.activeProvider || state.availableProviders[0] || null;
  const shownLabel = (shownProvider && PROVIDER_LABELS[shownProvider]) || shownProvider || null;

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
    ariaLabel: 'Model for this chat',
    triggerClass: 'lb-sm chat-lb',
    menuClass: 'lb-rich chat-mm-menu',
    prefer: 'up',
    minWidth: 360,
    // ── WHERE THE FULL MEASUREMENT WENT ────────────────────────────────────
    // Each row carries a derived one-liner rather than the model's whole
    // measured `note`. The note still exists, whole and verbatim, behind
    // Settings' per-model expand, so this says so once rather than leaving the
    // reader to guess the evidence was deleted rather than moved.
    footHtml: 'Full measurements for each model: Settings → API keys',
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
    triggerClass: 'lb-sm chat-lb',
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
  if (sendBtn) sendBtn.addEventListener('click', sendCurrentMessage);
  // The pickers are BUILT here, not in renderComposerHtml — one code path
  // paints them on first mount and on every repaint after a pick.
  renderComposerPickers();
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
  host.innerHTML =
    (showModelPicker ? renderModelDropdownHtml() : '') +
    renderLengthDropdownHtml();
  for (const cfg of pendingListboxes) mountListbox(cfg);
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

  return '<div class="chat-browse-count mono" role="status">' + escapeHtml(count) + '</div>' + body;
}

function renderBrowseFiltersHtml() {
  // Providers come from state.availableProviders, which this file builds from
  // its own frozen PROVIDER_KEY_FLAGS list — never payload text. Escaped anyway:
  // "safe because of where it came from" is a property a reader has to go and
  // verify, and it stops being true the day someone sources this from the wire.
  const chips = [{ id: null, label: 'All providers' }].concat(
    state.availableProviders.map(p => ({
      id: p,
      label: Object.hasOwn(PROVIDER_LABELS, p) ? PROVIDER_LABELS[p] : p,
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
              : 'Every model you have a key for. Picking one changes the model for this chat until you change it again.') +
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
    input.addEventListener('input', () => {
      if (!browseUi) return;
      browseUi.q = input.value;
      refreshBrowseDialog();
    });
    // ARROW KEYS FROM THE FIELD, so a search and a choice are one gesture. Tab
    // reaches every row too (they are real buttons); this is the fast path, not
    // the only path.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'Enter') return;
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

/**
 * The control itself, or '' when there is nothing to re-ask.
 *
 * SUPPRESSED WHILE A SEND IS IN FLIGHT, because `sendCurrentMessage` refuses a
 * second send anyway (`state.sending`) and a button that silently does nothing
 * is the inert-control defect this repo has shipped and recorded twice. Also
 * suppressed on an errored message and where the composer has no model picker at
 * all — with one model there is no other model to ask.
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
    sendBtn.disabled = busy;
    sendBtn.innerHTML = busy ? '<span class="chat-spinner"></span>' : icon('send', 15);
  }
  if (ta) ta.disabled = busy;
}

// H1 fix: reaches into #chat-thread directly, bypassing setMain()'s guard —
// needs its own. This is the exact function the reported bug painted a
// stale answer through (see sendCurrentMessage's H1 comment).
function renderThreadOnly(token) {
  if (!isCurrentMount(token)) return;
  const el = document.getElementById('chat-thread');
  if (!el) return;

  const active = state.domains.find(d => d.slug === state.activeDomain);

  if (state.thread.length === 0) {
    el.innerHTML =
      '<div class="chat-empty">' +
        '<div class="chat-empty-title">Ask ' + escapeHtml(active ? (active.displayName || active.slug) : 'this domain') + ' anything</div>' +
        '<div class="chat-empty-body">' +
          (active
            ? 'This domain has ' + active.pageCount.toLocaleString() + ' page' + (active.pageCount === 1 ? '' : 's') + '. Answers cite the specific pages they draw from — click a citation to open it.'
            : 'Answers cite the specific pages they draw from — click a citation to open it.') +
        '</div>' +
      '</div>';
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
          '<div class="chat-bubble">' + escapeHtml(m.content).replace(/\n/g, '<br>') + '</div>' +
        '</div>'
      );
    }
    if (m.error) {
      return (
        '<div class="chat-msg chat-msg-assistant chat-msg-error">' +
          '<div class="chat-msg-eyebrow mono">THE CURATOR</div>' +
          '<div class="chat-answer">' + icon('alertCircle', 14) + ' ' + escapeHtml(m.error) + '</div>' +
        '</div>'
      );
    }
    const citations = Array.isArray(m.citations) ? [...new Set(m.citations)] : [];
    const chips = citations.map(c => {
      const folder = folderOfPath(c);
      return (
        '<button class="chat-cite-chip ' + typeChipClass(folder) + '" data-cite="' + escapeHtml(c) + '">' +
          '<span class="chat-type-dot" style="' + typeDotStyle(folder) + '"></span>' + escapeHtml(c) +
        '</button>'
      );
    }).join('');
    return (
      '<div class="chat-msg chat-msg-assistant">' +
        assistantEyebrowHtml(m, eyebrowCtx) +
        '<div class="chat-answer">' + renderMarkdown(m.content || '') + '</div>' +
        (chips ? '<div class="chat-cite-row">' + chips + '</div>' : '') +
        reaskButtonHtml(i) +
      '</div>'
    );
  }).join('') + (state.sending ? (
    '<div class="chat-msg chat-msg-assistant chat-msg-thinking">' +
      '<div class="chat-msg-eyebrow mono">THE CURATOR</div>' +
      thinkingBodyHtml() +
    '</div>'
  ) : '');

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

  // Delegated click for the citation-chip row below the message. `data-cite`
  // is safe here — `c` is a plain filename from the API's `citations` array,
  // passed through escapeHtml (which escapes quotes) for attribute context.
  el.querySelectorAll('[data-cite]').forEach(elm => {
    elm.addEventListener('click', () => openWikiReader(elm.dataset.cite, null));
  });
  // Delegated click for inline "[source: ...]" mentions inside the rendered
  // answer text (M3 fix). These never carry a data-cite attribute — the path
  // lives in TEXT CONTENT (.chat-cite-path); the reasoning is in
  // formatSegment's citation-pass comment, which now lives in
  // ../shared/markdown.js, NOT in this file — the renderer was lifted out so
  // the wiki reader could share it. Read the path back the same way it was
  // displayed rather than via a dataset.
  el.querySelectorAll('.chat-citation-tag').forEach(elm => {
    const pathEl = elm.querySelector('.chat-cite-path');
    const path = pathEl ? pathEl.textContent.trim() : '';
    if (!path) return;
    elm.addEventListener('click', () => openWikiReader(path, null));
  });

  // #chat-thread has no scroll of its own (see chat.css: the composer and
  // scope bar are sticky WITHIN .main, which is the one true scrolling
  // ancestor) — so the element to scroll to reveal the latest message is
  // .main itself, the shared main-column element from index.html/app.js.
  const scrollHost = document.getElementById('main');
  if (scrollHost) scrollHost.scrollTop = scrollHost.scrollHeight;
}
