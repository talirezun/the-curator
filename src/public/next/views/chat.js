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
} from '../app.js';

// ── Markdown rendering (ported from src/public/markdown.js) ─────────────
// That file is the shipping app's dependency-free, XSS-safe renderer for
// chat answers. It's written as a `window`-attaching IIFE (`<script src>`
// in the shipping index.html), not an ES module, and this view must not
// edit next/index.html to add a script tag — so rather than reach across
// with a runtime <script> injection, the same algorithm is ported here as
// real module-scope functions. The CARDINAL RULE carries over unchanged
// and must never be violated by an edit to this section: escape the
// WHOLE string first, then insert only a fixed allow-list of tags by
// matching Markdown syntax in the already-escaped text. No model or user
// text is ever interpolated into an attribute or a URL.
//
// One addition beyond the original: citation spans carry their path in a
// nested `.chat-cite-path` TEXT node (never an attribute — see the M3 fix
// comment inside formatSegment below) so a single delegated click handler
// on the thread can open the reader from an inline "[source: ...]" mention,
// not just the chip row rendered below the message.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSegment(t) {
  // Wikilinks: [[target]] or [[target|alias]] -> readable, non-interactive
  // styled span (matches the shipping renderer's behaviour — resolving a
  // bare wikilink to a folder+slug would require guessing which of
  // entities/concepts it lives in, which the shipping app also declines
  // to do here).
  t = t.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    const label = (alias != null ? alias : String(target).split('/').pop().replace(/\.md$/, '')).trim();
    return '<span class="chat-wikilink">' + label + '</span>';
  });
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  // Citation chips: [source: path] -> clickable styled span. MUST run LAST
  // in this function (adversarial-audit finding M1, verified against the
  // real HTML parser): every pass above scans the WHOLE string for its own
  // syntax, including HTML this function has already emitted. When this
  // ran FIRST, a crafted `[source: x[[y] tail]]` made the wikilink pass's
  // `[[...]]` match START INSIDE this span's data-cite="..." attribute
  // value and END at the "]]" much later in the string — its replacement
  // deleted everything in between, including the closing `">` and
  // `</span>`, leaving the attribute unterminated for the rest of the
  // document (a real attribute-breakout; not exploitable today only
  // because nothing downstream of this span carries a second attribute or
  // a URL sink — one added attribute away from live XSS). Running this
  // pass last means nothing downstream ever re-scans its output, so no
  // ordering of characters inside `path` can reach into markup this
  // function already emitted.
  //
  // No `\s*` adjacent to the capture group (avoids backtracking on an
  // unclosed tag); the leading space after "source:" is trimmed below.
  // `path` is extracted from `t`, which was already HTML-escaped ONCE by
  // renderMarkdown's top-level escHtml(raw) before any pass ran — do NOT
  // escape it again here (that was the separate L5 bug: a citation path
  // containing "&" got re-escaped from "&amp;" to "&amp;amp;", which the
  // browser only unescapes one level on click, so the fetch 404'd on a
  // filename that actually existed).
  // M3 fix (re-audit finding): this used to drop `path` straight into a
  // `data-cite="..."` ATTRIBUTE. Citation must stay LAST in this function
  // (see the big comment above — moving it earlier reopens the M1 bracket-
  // consumption bug), which means by the time this pass runs, `path` can
  // already contain markup the wikilink pass emitted a moment ago (e.g. a
  // citation string that itself embeds a `[[...]]` sequence). That markup
  // carries real `"` characters as part of `class="chat-wikilink"` — reading
  // it into an attribute value lets those quotes close the attribute early.
  // Verified: `[source: [[a]] onerror=alert(1) ]` produced
  // `data-cite="<span class="chat-wikilink">a</span> onerror=alert(1)">` —
  // the attribute terminates at the FIRST `"`, right after `class=`, leaving
  // the rest as loose, unintended markup. Not live script execution today
  // (nothing downstream reads that broken value as a URL/handler), but it is
  // one added attribute away from it, and it already lets a crafted citation
  // repoint or corrupt what the click handler treats as a path.
  //
  // Fix: keep `path` in TEXT CONTENT instead (mirrors the shipping
  // renderer's approach — src/public/markdown.js:36 — adjusted for this
  // file's citation-LAST ordering). Text content is never re-parsed as
  // markup by the browser, so no character sequence inside it can break out
  // of anything; the click handler below reads it back via `.textContent`
  // on the dedicated `.chat-cite-path` child instead of a data attribute.
  t = t.replace(/\[source:([^\]]+)\]/g, (_, p) => {
    const path = p.trim();
    return '<span class="chat-citation-tag">' + icon('dot', 7) +
      '<span class="chat-cite-path">' + path + '</span></span>';
  });
  return t;
}

function renderInline(text) {
  const parts = String(text).split(/(`[^`\n]+`)/g);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) out += '<code>' + parts[i].slice(1, -1) + '</code>';
    else out += formatSegment(parts[i]);
  }
  return out;
}

function renderMarkdown(raw) {
  const escaped = escHtml(raw);
  const lines = escaped.split('\n');
  const out = [];

  let inCode = false;
  let codeBuf = [];
  let listType = null;
  let listBuf = [];
  let para = [];

  const flushPara = () => {
    if (para.length) { out.push('<p>' + para.map(renderInline).join('<br>') + '</p>'); para = []; }
  };
  const flushList = () => {
    if (listType) { out.push('<' + listType + '>' + listBuf.join('') + '</' + listType + '>'); listBuf = []; listType = null; }
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    if (/^\s*```/.test(line)) {
      if (inCode) { out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>'); codeBuf = []; inCode = false; }
      else { flushPara(); flushList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }

    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push('<div class="chat-md-h">' + renderInline(h[2]) + '</div>'); continue; }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listBuf.push('<li>' + renderInline(bullet[1]) + '</li>');
      continue;
    }

    const num = line.match(/^\s*\d+\.\s+(.*)$/);
    if (num) {
      flushPara();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listBuf.push('<li>' + renderInline(num[1]) + '</li>');
      continue;
    }

    flushList();
    para.push(line);
  }

  flushPara();
  flushList();
  if (inCode) out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>');

  return out.join('');
}

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

// ── localStorage keys (namespaced separately from the shipping app's own
// curator-chat-* keys — same origin, but a distinct prefix keeps this
// parallel shell's persisted choices from ever being confused with the
// shipping app's, even though nothing would actually break if they
// collided since both mean the same thing here). ─────────────────────────
const LS_DOMAIN = 'curator-next-chat-domain';
const LS_STYLE = 'curator-next-chat-style';
const LS_PROVIDER = 'curator-next-chat-provider';

// ── View state ────────────────────────────────────────────────────────────

const state = {
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
  activeProvider: null,   // global active provider (fallback label when modelProvider is null)
  openPicker: null,       // 'model' | 'length' | null
  loadError: null,
  convToken: 0,           // guards against out-of-order conversation-list fetches (SAME mount, e.g. two quick conversation clicks)
  selectToken: 0,         // guards against out-of-order selectConversation resolutions (SAME mount)
  readerToken: 0,         // guards against out-of-order reader-page fetches (SAME mount)
};

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
    state.sending = false;
    renderShell(mountToken); // paints sidebar+main immediately with a loading state
    boot(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));

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
    };
  },
});

// ── Boot sequence ─────────────────────────────────────────────────────────

async function boot(token) {
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
    renderShell(token);
    return;
  }
  if (!isCurrentMount(token)) return;

  state.domains = Array.isArray(domainsData.domains) ? domainsData.domains : [];
  applyApiKeys(keysData || {});

  if (state.domains.length === 0) {
    state.activeDomain = null;
    renderShell(token);
    return;
  }

  let saved = null;
  try { saved = localStorage.getItem(LS_DOMAIN); } catch { /* ignore */ }
  const savedValid = state.domains.some(d => d.slug === saved);
  state.activeDomain = savedValid ? saved : state.domains[0].slug;

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
// time — see wireConvRows below) rather than read fresh here, because this
// function itself awaits (window.confirm is synchronous/blocking, but the
// fetch afterwards is not) before it may touch shared state/DOM.
async function deleteConversationRow(id, title, mountToken) {
  const ok = window.confirm('Delete "' + (title || 'this conversation') + '"? This cannot be undone.');
  if (!ok) return;
  try {
    await fetch('/api/chat/' + encodeURIComponent(state.activeDomain) + '/' + encodeURIComponent(id), { method: 'DELETE' });
  } catch { /* best-effort; the list refresh below will show the true state either way */ }
  if (!isCurrentMount(mountToken)) return; // H1 fix
  if (state.activeConversationId === id) {
    state.activeConversationId = null;
    state.thread = [];
  }
  await loadDomainConversations(state.activeDomain, mountToken, { autoSelectMostRecent: false });
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

  const dropZone =
    '<div class="chat-drop-zone" title="Not wired up in this shell yet — open the Ingest view to add sources.">' +
      icon('upload', 15) +
      '<div class="chat-drop-title">Drop sources to ingest</div>' +
      '<div class="chat-drop-sub mono">pdf · md · txt · or a folder</div>' +
      '<div class="chat-drop-sub mono chat-drop-inert">not wired up yet — open <span class="chat-drop-link" id="chat-drop-goto-ingest" role="link" tabindex="0">Ingest</span> instead</div>' +
    '</div>';

  setSidebar(
    '<div class="sidebar-title">Chat</div>' +
    '<button class="btn btn-primary chat-new-btn" id="chat-new-btn">' + icon('plus', 14) + ' New chat</button>' +
    (state.domains.length > 0
      ? '<div class="chat-search-wrap">' +
          '<span class="chat-search-icon">' + icon('search', 13) + '</span>' +
          '<input type="text" class="chat-search-input" id="chat-search-input" placeholder="Search conversations…" value="' + escapeHtml(state.searchQuery) + '">' +
        '</div>' +
        '<div class="chat-conv-list">' + convListHtml + '</div>'
      : '<div class="sidebar-hint">No domains exist yet — nothing to chat with.</div>') +
    dropZone,
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
  const gotoIngest = document.getElementById('chat-drop-goto-ingest');
  if (gotoIngest) {
    gotoIngest.addEventListener('click', () => navigate('ingest'));
    gotoIngest.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('ingest'); }
    });
  }
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

  wireComposer();
  renderThreadOnly(token);
  renderComposerPickers();
}

function renderComposerHtml(active) {
  const placeholder = active ? 'Ask ' + (active.displayName || active.slug) + '…' : 'Ask this domain…';
  const showModelPicker = state.availableProviders.length >= 2;

  return (
    '<div class="chat-composer-wrap">' +
      '<div class="chat-composer" id="chat-composer">' +
        '<textarea class="chat-input" id="chat-input" rows="2" placeholder="' + escapeHtml(placeholder) + '"></textarea>' +
        '<div class="chat-composer-controls">' +
          '<button class="chat-ctrl-btn" id="chat-attach-btn" disabled title="Not wired up in this phase — ingestion from Chat isn\'t connected yet. Use the Ingest view.">' +
            icon('paperclip', 15) +
          '</button>' +
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
    const shown = state.modelProvider || state.activeProvider || state.availableProviders[0] || 'gemini';
    modelValue.textContent = PROVIDER_LABELS[shown] || shown;
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

  const modelLabel = state.modelProvider ? (PROVIDER_LABELS[state.modelProvider] || state.modelProvider)
    : (state.activeProvider ? (PROVIDER_LABELS[state.activeProvider] || state.activeProvider) : 'The Curator');

  el.innerHTML = state.thread.map(m => {
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
  // lives in TEXT CONTENT (.chat-cite-path), see formatSegment's comment —
  // so read it back the same way it was displayed rather than via a dataset.
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
