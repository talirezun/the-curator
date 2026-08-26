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
import { confirmThen, closeConfirmIfOpen } from '../shared/confirm.js';
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
const PROVIDER_LABELS = Object.assign(Object.create(null), { gemini: 'Gemini', anthropic: 'Claude' });
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
// exactly STYLE_ORDER below; CHAT_MODEL_KEY holds one of 'gemini'|
// 'anthropic', exactly the provider strings used here. Both sides already
// guard every read with an `.includes()` allow-list against the live
// available-providers/styles list (see applyApiKeys below and app.js's own
// `CHAT_STYLES.includes(saved)` / `providers.includes(saved)`), so an
// unrecognised or stale value on either side already degrades to "not set"
// rather than being applied — no extra normalisation needed here. Reading
// the same keys means a user's per-chat model and response-length choice
// survives the /next cutover instead of silently resetting to the
// defaults (global provider, 'balanced'). LS_DOMAIN has no shipping
// counterpart (the shipping app doesn't persist a chat-scoped domain this
// way) and stays namespaced to this shell.
const LS_DOMAIN = 'curator-next-chat-domain';
const LS_STYLE = 'curator-chat-response-style';
const LS_PROVIDER = 'curator-chat-model-provider';
// The per-conversation MODEL id. Deliberately /next-namespaced and NOT sharing
// a key with anything the shipping app writes: LS_PROVIDER above holds one of
// 'gemini'|'anthropic', and this holds a model id like 'claude-sonnet-5'. Two
// different value FORMATS must never share one key — that is how a stale value
// from the other writer gets applied as if it were ours.
const LS_MODEL = 'curator-next-chat-model';

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
  conversations: [],      // sidebar list for activeDomain: [{id, title, createdAt, messageCount}]
  searchQuery: '',
  activeConversationId: null,
  thread: [],             // [{role, content, citations?, error?}]
  sending: false,
  responseStyle: 'balanced',
  modelProvider: null,    // null -> global active provider
  availableProviders: [], // config-scoped subset of ['gemini','anthropic']
  models: {},             // {gemini, anthropic} default model ids, for labels
  // The pickable-model catalogue, per provider, cheapest-first, exactly as
  // GET /api/config/api-keys returned it. Already config-scoped SERVER-side
  // (a provider with no saved Settings key gets `[]`), and re-scoped CLIENT-side
  // by normalizeOfferable so the v3.0.13 rule holds even if that ever changes.
  offerable: { gemini: [], anthropic: [] },
  chatModel: null,        // per-conversation model id; null -> the provider's default
  activeProvider: null,   // global active provider (fallback label when modelProvider is null)
  openPicker: null,       // 'model' | 'length' | null
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
let outsideClickHandler = null;

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

    escHandler = (e) => {
      if (e.key !== 'Escape') return;
      if (state.openPicker) { state.openPicker = null; renderComposerPickers(); }
    };
    outsideClickHandler = (e) => {
      if (state.openPicker && !e.target.closest('.chat-dd')) {
        state.openPicker = null;
        renderComposerPickers();
      }
    };
    document.addEventListener('keydown', escHandler);
    document.addEventListener('click', outsideClickHandler);

    return () => {
      // Timer hygiene (load-bearing): an armed delay timer that survives
      // this teardown would paint a loader into whatever view comes next.
      if (bootGate) { bootGate.cancel(); bootGate = null; }
      if (escHandler) document.removeEventListener('keydown', escHandler);
      if (outsideClickHandler) document.removeEventListener('click', outsideClickHandler);
      escHandler = null;
      outsideClickHandler = null;

      // Shell hard rule #2 (see app.js's navigate() doc comment): rail
      // selection must close the composer's model/length picker,
      // unconditionally, before the next view mounts. The shell has no
      // way to reach in and do this itself — this picker is OUR state —
      // so navigate() relies on THIS teardown running (which it always
      // does, before the next view's onEnter) to honour that guarantee.
      // Do not remove this as "redundant cleanup": it is the only place
      // the guarantee is enforced for the real composer. If Chat ever
      // grows another transient overlay-like flag (another dropdown, an
      // inline confirm), reset it here too.
      state.openPicker = null;

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

function applyApiKeys(data) {
  const providers = [];
  if (data.hasGeminiKey) providers.push('gemini');
  if (data.hasAnthropicKey) providers.push('anthropic');
  state.availableProviders = providers;
  state.models = data.models || {};
  state.activeProvider = data.activeProvider || null;

  let savedProvider = null;
  try { savedProvider = localStorage.getItem(LS_PROVIDER); } catch { /* ignore */ }
  state.modelProvider = providers.includes(savedProvider) ? savedProvider : null;

  let savedStyle = null;
  try { savedStyle = localStorage.getItem(LS_STYLE); } catch { /* ignore */ }
  state.responseStyle = STYLE_ORDER.includes(savedStyle) ? savedStyle : 'balanced';

  // Re-scoped client-side against the SAME `providers` list built above from
  // hasGeminiKey/hasAnthropicKey — config-only, never .env (v3.0.13).
  state.offerable = normalizeOfferable(data.offerable, providers);

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
async function loadDomainConversations(domain, mountToken, opts = {}) {
  const convToken = ++state.convToken;
  try {
    const res = await fetch('/api/chat/' + encodeURIComponent(domain));
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

  if (opts.autoSelectMostRecent && state.conversations.length > 0) {
    await selectConversation(state.conversations[0].id, mountToken, { skipSidebarRender: true });
  } else {
    state.activeConversationId = null;
    state.thread = [];
  }
  renderShell(mountToken);
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
  loadDomainConversations(slug, myMountToken, { autoSelectMostRecent: true }).catch(reportAsyncActionFailure);
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
      await loadDomainConversations(state.activeDomain, mountToken, { autoSelectMostRecent: false });
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

  state.sending = true;
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
    state.thread.push({ role: 'assistant', content: data.answer, citations: data.citations || [] });

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
      await loadDomainConversations(state.activeDomain, mountToken, { autoSelectMostRecent: false });
      if (!isCurrentMount(mountToken)) return;
      // loadDomainConversations doesn't know which conversation is "active"
      // beyond auto-select, so restore it explicitly and re-render.
      state.activeConversationId = data.conversationId;
      state.thread = threadSoFar;
      renderShell(mountToken);
    } else {
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

// `token` is a value the CALLER captured (at onEnter, or at the top of its
// own async function before any await) — never re-derived from the live
// myMountToken here. See the H1 doc comment on myMountToken above.
function renderSidebar(token) {
  if (!isCurrentMount(token)) return;
  const query = state.searchQuery.trim().toLowerCase();
  const filtered = query
    ? state.conversations.filter(c => (c.title || '').toLowerCase().includes(query))
    : state.conversations;

  const today = [];
  const earlier = [];
  const now = new Date().toISOString();
  for (const c of filtered) {
    (isSameLocalDay(c.createdAt, now) ? today : earlier).push(c);
  }

  const row = (c) => (
    '<div class="chat-conv-row' + (c.id === state.activeConversationId ? ' active' : '') + '" data-conv-id="' + escapeHtml(c.id) + '">' +
      '<div class="chat-conv-row-main" role="button" tabindex="0" data-conv-select="' + escapeHtml(c.id) + '">' +
        '<div class="chat-conv-title">' + escapeHtml(c.title || 'Untitled') + '</div>' +
        '<div class="chat-conv-meta mono">' + c.messageCount + ' message' + (c.messageCount === 1 ? '' : 's') + '</div>' +
      '</div>' +
      '<button class="chat-conv-delete" data-conv-delete="' + escapeHtml(c.id) + '" data-conv-title="' + escapeHtml(c.title || '') + '" title="Delete conversation" aria-label="Delete conversation">' +
        icon('trash', 13) +
      '</button>' +
    '</div>'
  );

  const groupHtml = (label, list) => list.length === 0 ? '' : (
    '<div class="chat-conv-group-label mono">' + label + '</div>' + list.map(row).join('')
  );

  let convListHtml;
  if (state.domains.length === 0) {
    convListHtml = '';
  } else if (state.loadError) {
    convListHtml = '<div class="chat-sidebar-error">' + escapeHtml(state.loadError) + '</div>';
  } else if (filtered.length === 0) {
    convListHtml = '<div class="sidebar-hint">' + (query ? 'No conversations match “' + escapeHtml(state.searchQuery) + '”.' : 'No conversations yet in this domain.') + '</div>';
  } else {
    convListHtml = groupHtml('TODAY', today) + groupHtml('EARLIER', earlier);
  }

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
        '<div class="chat-conv-list">' + convListHtml + '</div>'
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
      renderSidebarConversationsOnly(myMountToken);
    });
  }

  wireConvRows(document);
  document.querySelectorAll('[data-conv-delete]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversationRow(el.dataset.convDelete, el.dataset.convTitle, myMountToken).catch(reportAsyncActionFailure);
    });
  });
}

// Lighter re-render used after search input / a completed send that
// didn't change which conversation is active — rebuilds just the list
// markup + rewires its own rows, without touching the search input's own
// focus/caret (a full renderSidebar() would recreate the input and drop
// focus while the user is typing).
// H1 fix: this bypasses setSidebar() entirely (it patches an already-
// rendered subtree directly), so it needs its OWN isCurrentMount guard —
// setSidebar's built-in guard can't protect a call site that never calls it.
function renderSidebarConversationsOnly(token) {
  if (!isCurrentMount(token)) return;
  const listEl = document.querySelector('.chat-conv-list');
  if (!listEl) { renderSidebar(token); return; }
  const query = state.searchQuery.trim().toLowerCase();
  const filtered = query
    ? state.conversations.filter(c => (c.title || '').toLowerCase().includes(query))
    : state.conversations;
  const today = [];
  const earlier = [];
  const now = new Date().toISOString();
  for (const c of filtered) (isSameLocalDay(c.createdAt, now) ? today : earlier).push(c);

  const row = (c) => (
    '<div class="chat-conv-row' + (c.id === state.activeConversationId ? ' active' : '') + '" data-conv-id="' + escapeHtml(c.id) + '">' +
      '<div class="chat-conv-row-main" role="button" tabindex="0" data-conv-select="' + escapeHtml(c.id) + '">' +
        '<div class="chat-conv-title">' + escapeHtml(c.title || 'Untitled') + '</div>' +
        '<div class="chat-conv-meta mono">' + c.messageCount + ' message' + (c.messageCount === 1 ? '' : 's') + '</div>' +
      '</div>' +
      '<button class="chat-conv-delete" data-conv-delete="' + escapeHtml(c.id) + '" data-conv-title="' + escapeHtml(c.title || '') + '" title="Delete conversation" aria-label="Delete conversation">' +
        icon('trash', 13) +
      '</button>' +
    '</div>'
  );
  const groupHtml = (label, list) => list.length === 0 ? '' : (
    '<div class="chat-conv-group-label mono">' + label + '</div>' + list.map(row).join('')
  );

  listEl.innerHTML = filtered.length === 0
    ? '<div class="sidebar-hint">' + (query ? 'No conversations match “' + escapeHtml(state.searchQuery) + '”.' : 'No conversations yet in this domain.') + '</div>'
    : groupHtml('TODAY', today) + groupHtml('EARLIER', earlier);

  wireConvRows(listEl);
  listEl.querySelectorAll('[data-conv-delete]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversationRow(el.dataset.convDelete, el.dataset.convTitle, myMountToken).catch(reportAsyncActionFailure);
    });
  });
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

function renderComposerHtml(active) {
  const placeholder = active ? 'Ask ' + (active.displayName || active.slug) + '…' : 'Ask this domain…';
  // Provider mode (v3.0.11): 2+ keyed providers, otherwise there is nothing to
  // choose between. Model mode: ONE keyed provider is enough, because that
  // provider alone offers several models — but still nothing at all with zero
  // keys, since `offerable` is empty for an unkeyed provider.
  const showModelPicker = MODEL_PICKER_ENABLED
    ? (state.availableProviders.length >= 2
        || offerableEntries(state.offerable, state.availableProviders).length > 0)
    : state.availableProviders.length >= 2;

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
          (showModelPicker ? renderModelDropdownHtml() : '') +
          renderLengthDropdownHtml() +
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

const SUITABILITY_LABELS = Object.assign(Object.create(null), {
  'chat-only': 'chat only',
  caution: 'caution',
});

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
  out.gemini = [];
  out.anthropic = [];
  if (!raw || typeof raw !== 'object') return out;
  for (const p of ['gemini', 'anthropic']) {
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
function resolveChatModel(modelId, offerable, availableProviders) {
  if (typeof modelId !== 'string' || !modelId) return null;
  for (const row of offerableEntries(offerable, availableProviders)) {
    if (row.entry.id === modelId) return row;
  }
  return null;
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

/** "$1 in / $5 out per 1M" from the LIVE (promotion-resolved) fields. */
function formatLivePrice(entry) {
  const inp = formatPricePerM(entry && entry.input);
  const out = formatPricePerM(entry && entry.output);
  if (inp === null || out === null) return 'price unavailable';
  return inp + ' in / ' + out + ' out per 1M';
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
  const inp = formatPricePerM(entry.standardInput);
  const out = formatPricePerM(entry.standardOutput);
  const from = typeof entry.standardPriceFromIso === 'string' && entry.standardPriceFromIso
    ? entry.standardPriceFromIso
    : entry.promotionUntilIso;
  if (inp === null || out === null) return 'promotional price — rises after ' + entry.promotionUntilIso;
  return 'promotional price — rises to ' + inp + ' / ' + out + ' on ' + from;
}

/**
 * Does this entry carry a measured caveat the user must see before picking it?
 * `suitability !== 'general'` OR `dominated` — both come straight from the
 * server's measured catalogue. Flagged models are SHOWN, never filtered out:
 * the contract is an honest label, not a curated-down list.
 */
function isFlaggedModel(entry) {
  if (!entry) return false;
  return entry.dominated === true || (entry.suitability !== undefined && entry.suitability !== 'general');
}

/** One selectable row. Every interpolated value is server-supplied → escaped. */
function renderModelOptionHtml(provider, entry, selectedId) {
  const isActive = entry.id === selectedId;
  const flagged = isFlaggedModel(entry);
  const rise = formatPromotionRise(entry);
  const badges = [];
  if (entry.suitability !== undefined && entry.suitability !== 'general') {
    badges.push('<span class="chat-mm-badge is-warn">' +
      escapeHtml(SUITABILITY_LABELS[entry.suitability] || entry.suitability) + '</span>');
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

  return (
    '<button type="button" class="chat-dd-opt chat-mm-opt' + (isActive ? ' is-active' : '') +
      '" role="option" aria-selected="' + (isActive ? 'true' : 'false') +
      '" data-model-id="' + escapeHtml(entry.id) + '" data-model-provider="' + escapeHtml(provider) + '">' +
      '<span class="chat-mm-head">' +
        '<span class="chat-dd-opt-title">' + escapeHtml(entry.label || entry.id) + '</span>' +
        badges.join('') +
      '</span>' +
      '<span class="chat-dd-opt-desc mono">' + escapeHtml(entry.id) + '</span>' +
      '<span class="chat-mm-price mono">' + escapeHtml(formatLivePrice(entry)) + '</span>' +
      (rise ? '<span class="chat-mm-rise">' + escapeHtml(rise) + '</span>' : '') +
      (flagged && typeof entry.note === 'string' && entry.note
        ? '<span class="chat-mm-note">' + escapeHtml(entry.note) + '</span>'
        : '') +
    '</button>'
  );
}

/**
 * The whole menu: one group per KEYED provider, each cheapest-first exactly as
 * the server ordered it. Returns '' when nothing is pickable, so the caller can
 * decide not to render a dropdown at all rather than render an empty one.
 */
function renderModelMenuHtml(offerable, availableProviders, selectedId) {
  const providers = Array.isArray(availableProviders) ? availableProviders : [];
  let html = '';
  let rows = 0;
  for (const p of providers) {
    const list = offerable && Object.hasOwn(offerable, p) && Array.isArray(offerable[p]) ? offerable[p] : [];
    if (!list.length) continue;
    html += '<div class="chat-mm-group">' + escapeHtml(PROVIDER_LABELS[p] || p) + '</div>';
    for (const entry of list) { html += renderModelOptionHtml(p, entry, selectedId); rows++; }
  }
  return rows ? html : '';
}

function renderModelDropdownHtml() {
  return (
    '<div class="chat-dd" id="chat-model-dd">' +
      '<button type="button" class="chat-dd-btn" id="chat-model-btn" aria-haspopup="listbox" aria-expanded="false">' +
        '<span class="chat-dd-dot"></span><span id="chat-model-value" class="mono"></span>' + icon('chevronDown', 12) +
      '</button>' +
      '<div class="chat-dd-menu" id="chat-model-menu" role="listbox" hidden></div>' +
    '</div>'
  );
}

function renderLengthDropdownHtml() {
  return (
    '<div class="chat-dd" id="chat-length-dd">' +
      '<button type="button" class="chat-dd-btn" id="chat-length-btn" aria-haspopup="listbox" aria-expanded="false">' +
        '<span id="chat-length-value" class="mono"></span>' + icon('chevronDown', 12) +
      '</button>' +
      '<div class="chat-dd-menu" id="chat-length-menu" role="listbox" hidden></div>' +
    '</div>'
  );
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

  const modelBtn = document.getElementById('chat-model-btn');
  if (modelBtn) modelBtn.addEventListener('click', () => togglePicker('model'));
  const lengthBtn = document.getElementById('chat-length-btn');
  if (lengthBtn) lengthBtn.addEventListener('click', () => togglePicker('length'));
}

function togglePicker(which) {
  state.openPicker = state.openPicker === which ? null : which;
  renderComposerPickers();
}

function renderComposerPickers() {
  // Model dropdown
  const modelValue = document.getElementById('chat-model-value');
  const modelMenu = document.getElementById('chat-model-menu');
  const modelBtn = document.getElementById('chat-model-btn');
  if (modelValue && modelMenu && modelBtn) {
    const shownProvider = state.modelProvider || state.activeProvider || state.availableProviders[0] || 'gemini';

    // MODEL mode (gated — see MODEL_PICKER_ENABLED). Falls through to the
    // v3.0.11 PROVIDER menu below whenever the gate is off OR nothing is
    // actually pickable, so a catalogue that arrives empty (an older backend,
    // a provider list we do not recognise) degrades to the shipped behaviour
    // rather than to an empty menu.
    const modelMenuHtml = MODEL_PICKER_ENABLED
      ? renderModelMenuHtml(state.offerable, state.availableProviders, state.chatModel)
      : '';
    if (modelMenuHtml) {
      const chosen = resolveChatModel(state.chatModel, state.offerable, state.availableProviders);
      modelValue.textContent = chosen
        ? (chosen.entry.label || chosen.entry.id)
        : ((PROVIDER_LABELS[shownProvider] || shownProvider) + ' default');
      modelMenu.innerHTML = modelMenuHtml;
      modelMenu.classList.add('chat-mm-menu');
      modelMenu.hidden = state.openPicker !== 'model';
      modelBtn.setAttribute('aria-expanded', state.openPicker === 'model' ? 'true' : 'false');
      modelMenu.querySelectorAll('[data-model-id]').forEach(opt => {
        opt.addEventListener('click', () => {
          const id = opt.dataset.modelId;
          // Re-validated against the LIVE catalogue at click time, not trusted
          // from the markup: this is the gate that makes an unkeyed provider's
          // model unselectable even if a row for it somehow reached the DOM.
          const picked = resolveChatModel(id, state.offerable, state.availableProviders);
          if (!picked) return;
          state.chatModel = picked.entry.id;
          state.modelProvider = picked.provider;
          try { localStorage.setItem(LS_MODEL, picked.entry.id); } catch { /* ignore */ }
          try { localStorage.setItem(LS_PROVIDER, picked.provider); } catch { /* ignore */ }
          state.openPicker = null;
          renderComposerPickers();
        });
      });
      renderLengthPicker();
      return;
    }

    const shown = shownProvider;
    modelValue.textContent = PROVIDER_LABELS[shown] || shown;
    modelMenu.classList.remove('chat-mm-menu');
    modelMenu.innerHTML = state.availableProviders.map(p => (
      '<button type="button" class="chat-dd-opt' + (p === shown ? ' is-active' : '') + '" role="option" data-provider="' + p + '">' +
        '<span class="chat-dd-opt-title">' + (PROVIDER_LABELS[p] || p) + '</span>' +
        '<span class="chat-dd-opt-desc mono">' + escapeHtml(state.models[p] || '') + '</span>' +
      '</button>'
    )).join('');
    modelMenu.hidden = state.openPicker !== 'model';
    modelBtn.setAttribute('aria-expanded', state.openPicker === 'model' ? 'true' : 'false');
    modelMenu.querySelectorAll('[data-provider]').forEach(opt => {
      opt.addEventListener('click', () => {
        const p = opt.dataset.provider;
        if (!state.availableProviders.includes(p)) return;
        state.modelProvider = p;
        try { localStorage.setItem(LS_PROVIDER, p); } catch { /* ignore */ }
        state.openPicker = null;
        renderComposerPickers();
      });
    });
  }

  renderLengthPicker();
}

function renderLengthPicker() {
  // Length dropdown
  const lengthValue = document.getElementById('chat-length-value');
  const lengthMenu = document.getElementById('chat-length-menu');
  const lengthBtn = document.getElementById('chat-length-btn');
  if (lengthValue && lengthMenu && lengthBtn) {
    lengthValue.textContent = STYLE_LABELS[state.responseStyle] || 'Balanced';
    lengthMenu.innerHTML = STYLE_ORDER.map(s => (
      '<button type="button" class="chat-dd-opt' + (s === state.responseStyle ? ' is-active' : '') + '" role="option" data-style="' + s + '">' +
        '<span class="chat-dd-opt-title">' + STYLE_LABELS[s] + '</span>' +
      '</button>'
    )).join('');
    lengthMenu.hidden = state.openPicker !== 'length';
    lengthBtn.setAttribute('aria-expanded', state.openPicker === 'length' ? 'true' : 'false');
    lengthMenu.querySelectorAll('[data-style]').forEach(opt => {
      opt.addEventListener('click', () => {
        const s = opt.dataset.style;
        if (!STYLE_ORDER.includes(s)) return;
        state.responseStyle = s;
        try { localStorage.setItem(LS_STYLE, s); } catch { /* ignore */ }
        state.openPicker = null;
        renderComposerPickers();
      });
    });
  }
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

  // Names the MODEL when one is deliberately chosen (it is the more specific
  // truth), otherwise the provider exactly as before.
  const chosenModel = resolveChatModel(state.chatModel, state.offerable, state.availableProviders);
  const modelLabel = chosenModel
    ? (chosenModel.entry.label || chosenModel.entry.id)
    : (state.modelProvider ? (PROVIDER_LABELS[state.modelProvider] || state.modelProvider)
      : (state.activeProvider ? (PROVIDER_LABELS[state.activeProvider] || state.activeProvider) : 'The Curator'));

  el.innerHTML = state.thread.map(m => {
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
        '<div class="chat-msg-eyebrow mono">THE CURATOR · ' + escapeHtml(modelLabel) + '</div>' +
        '<div class="chat-answer">' + renderMarkdown(m.content || '') + '</div>' +
        (chips ? '<div class="chat-cite-row">' + chips + '</div>' : '') +
      '</div>'
    );
  }).join('') + (state.sending ? (
    '<div class="chat-msg chat-msg-assistant chat-msg-thinking">' +
      '<div class="chat-msg-eyebrow mono">THE CURATOR</div>' +
      '<div class="chat-thinking"><span class="chat-spinner"></span> thinking…</div>' +
    '</div>'
  ) : '');

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
