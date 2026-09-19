// The ONE producer of the shell's chat-scope handoff (P1-10).
//
// ── WHY THIS IS A MODULE AND NOT A LINE IN A VIEW ──────────────────────────
//
// `app.js` owns the handoff itself — `requestChatScope(slug)` records the
// intent and `consumeChatScopeRequest()` spends it, once, at the top of
// views/chat.js's onEnter. What it does NOT own is the two-step ritual a
// caller has to perform to use it correctly, and that ritual has three ways
// to be wrong that no type and no linter can catch:
//
//   1. RECORD FIRST, THEN NAVIGATE. `requestChatScope` does not navigate;
//      `navigate('chat')` invokes Chat's onEnter before it returns, and that
//      onEnter is what consumes the request. Navigating first means Chat has
//      already mounted and consumed nothing.
//   2. EXACTLY ONE navigate(). `navigate()` does not early-return when the
//      target view is already current — it re-mounts — and the consume CLEARS
//      on read, so a second navigate finds nothing pending and the scope is
//      silently dropped.
//   3. A REAL SLUG. `requestChatScope()` called with a falsy or non-string
//      value records `{slug: null, firstRun: true}` instead. `firstRun` is a
//      vestige — app.js's own comment records that Chat's first-run panel was
//      deleted when Domains learned to create a domain, and that NOTHING in
//      this repo consumes it — so a no-slug request is a request that records
//      a state nobody reads and scopes nothing. app.js names this hazard at
//      the definition; this module is where it is GUARDED, once, for every
//      producer, instead of each view repeating the check or (more likely)
//      not repeating it.
//
// views/domains.js carried this wrapper alone until v3.62.0, when the Context
// view's step ③ gained an "Ask this domain" door onto the same handoff. Two
// hand-written copies of a three-rule ritual is the shape v3.7.0 deleted (one
// call site inside one module), so the wrapper moved here rather than being
// typed a second time.
//
// ── THE DEGRADATION CONTRACT, LIFTED VERBATIM ──────────────────────────────
//
// A NAMESPACE import of `../app.js`, not a named one, and the reason is the
// one views/domains.js recorded when it wrote this: a static named import of
// an export that does not exist is a HARD MODULE-LOAD ERROR in ESM, and it
// takes the entire /next shell down to a blank page — the precise failure the
// boot guard in index.html exists for. `requestChatScope` is app.js's and
// could be renamed in an edit that does not touch this file; a namespace
// import cannot fail that way, and the call below degrades LOUDLY (a console
// warning) and USEFULLY (Chat opens, unscoped) instead of silently. A dead
// button that does nothing is the failure this project keeps recording; a
// button that works slightly less well and says so is not.
//
// `navigate` is imported by NAME because it is not the export at risk: every
// view in the shell already imports it, so an edit that removed it would take
// the app down long before this module noticed. The cycle this creates
// (app.js → views → here → app.js) is the same one shared/listbox.js and
// shared/markdown.js already live inside, and it is safe on the same terms:
// nothing here CALLS a shell function at import time.
import { navigate } from '../app.js';
import * as shell from '../app.js';

/**
 * Open Chat scoped to one domain.
 *
 * @param {string} slug a real domain slug
 * @returns {void}
 */
export function goToChatScoped(slug) {
  // RULE 3, and it is a guard rather than an assertion because the honest
  // outcome of a missing slug is still "open Chat" — the user pressed a
  // button that says so. What must not happen is recording a request that
  // scopes nothing and reads, to the next person debugging it, as though a
  // scope had been asked for.
  const clean = (typeof slug === 'string' && slug.trim()) ? slug.trim() : null;
  if (!clean) {
    console.warn('[next/chat-scope] goToChatScoped() called without a domain slug — '
      + 'opening Chat unscoped. The caller has a domain in hand or it has no business '
      + 'offering this control.');
    navigate('chat');
    return;
  }
  // RULE 1: record, then navigate. RULE 2: exactly one navigate() on every
  // path through this function, including the degraded one above.
  if (typeof shell.requestChatScope === 'function') {
    shell.requestChatScope(clean);
  } else {
    console.warn('[next/chat-scope] app.js does not export requestChatScope() — '
      + 'opening Chat without a domain scope.');
  }
  navigate('chat');
}
