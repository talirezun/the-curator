import { Router } from 'express';
import {
  sendMessage,
  listConversations,
  readConversation,
  deleteConversation,
} from '../brain/chat.js';
import { assertKnownDomain } from '../brain/files.js';
import { scrubPaths } from '../brain/scrub-paths.js';

const router = Router();

// Conversation IDs are server-generated UUIDs. Reject non-conforming IDs
// before they reach the filesystem layer — defense in depth against
// path-traversal via crafted IDs.
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── EVERY ROUTE IN THIS FILE VALIDATES `:domain`. THREE OF FOUR DID NOT. ─────
//
// `:id` has been regex-validated since v2.5.0 and `:domain` never was on the
// read paths, so `domain` went straight into `conversationsPath(domain)` —
// `path.join(getDomainsDir(), domain, 'conversations')` — with no containment
// of any kind. Express decodes the path segment, so `..%2f<something>` arrives
// as `../<something>` and `path.join` resolves it OUT of the domains root.
// Reproduced against a running app: `GET /api/chat/..%2f<x>?q=…` read a
// conversations directory outside the tree.
//
// The traversal itself is pre-existing. What changed is its VALUE: `?q=`
// (added this cycle) turns the listing into an oracle over MESSAGE BODIES, so
// the same request now reports whether a string appears inside files it should
// never have reached, not merely that they exist.
//
// `assertKnownDomain` is IMPORTED from files.js, where `listDomains()` lives.
// It is an exact allow-list, which is strictly stronger than a path-shape test,
// and importing it is the point: a second hand-written copy of a containment
// guard is what produced the v3.2.0 CRITICAL. routes/health.js uses the same
// function, so the two cannot drift.
//
// It runs FIRST in every handler, before the id regex, so nothing derived from
// an unvalidated domain is ever built — not even a path we then throw away.
function sendError(res, err) {
  // Raw `fs` errors embed absolute paths, which on a real install is the user's
  // home directory and their cloud-storage layout. `scrubPaths` is the v3.3.0
  // scrubber, imported from its single home; it keeps the basename, which is
  // the half that helps.
  res.status(err && Number.isInteger(err.status) ? err.status : 500)
     .json({ error: scrubPaths(String((err && err.message) || 'Unexpected error')) });
}

// List conversations for a domain.
//
// `?q=` is an OPTIONAL filter, matched against each conversation's title AND
// every message body (case-insensitive) — see matchConversation in
// src/brain/files.js for why the bodies are scanned server-side.
//
// DELIBERATELY NOT VALIDATED BEYOND "is it a string". There is no shape a
// query can take that is unsafe here: it never touches the filesystem (the
// directory is derived from `domain` alone), it is only ever used as the
// argument to String.prototype.includes, and its LENGTH is bounded inside
// listConversations, which is the one place that knows what the bound is for.
//
// The shape worth naming is `?q=a&q=b`, which express delivers as an ARRAY:
// an array reaching `.slice()` slices the array and the `.trim()` after it
// throws, turning a malformed URL into a 500.
//
// MEASURED, NOT ASSUMED: removing this typeof test on its own leaves the
// suite GREEN, because listConversations applies the same test to `opts.q`
// and is the layer that genuinely stops it (removing THAT one throws). So
// this line is DEFENCE IN DEPTH at the HTTP boundary — it normalises the one
// place where a non-string can be introduced by a URL rather than by a
// programming error — and is recorded as such rather than presented as the
// fix. Both are pinned, and the pair mutated together goes red.
router.get('/:domain', async (req, res) => {
  try {
    await assertKnownDomain(req.params.domain);
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const conversations = await listConversations(req.params.domain, { q });
    res.json({ conversations });
  } catch (err) {
    sendError(res, err);
  }
});

// Load a full conversation
router.get('/:domain/:id', async (req, res) => {
  try {
    await assertKnownDomain(req.params.domain);
    if (!CONVERSATION_ID_RE.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid conversationId' });
    }
    const conversation = await readConversation(req.params.domain, req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(conversation);
  } catch (err) {
    sendError(res, err);
  }
});

// Send a message (creates conversation if conversationId omitted)
router.post('/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    const { message, conversationId, responseStyle, provider, model } = req.body;

    if (!message) return res.status(400).json({ error: 'message is required' });

    // Was an inline `listDomains().includes(domain)` returning 400. Now the
    // shared guard, so all four routes in this file refuse the same inputs with
    // the same status — an unknown domain is a missing resource (404), which is
    // what routes/wiki.js and routes/domains.js have always returned for it.
    await assertKnownDomain(domain);

    // responseStyle + provider + model are all optional; sendMessage normalises
    // each one (unknown responseStyle → 'balanced'; a provider without a SAVED
    // Settings key → the global active provider; a model that is not offerable
    // on that provider, or whose provider has no saved key → that provider's
    // default), so an absent or garbage value is always safe.
    //
    // DELIBERATELY NOT VALIDATED HERE. The model allow-list is applied at
    // getProviderInfo(), the single producer of the string both SDKs receive,
    // with normalizeChatModel as chat's own key gate in front of it. Adding a
    // check at this route would leave the other seven generateText entry points
    // open and create a second hand-maintained copy of the guard — the shape
    // that produced the v3.2.0 CRITICAL.
    const result = await sendMessage(domain, conversationId || null, message, { responseStyle, provider, model });
    res.json(result);
  } catch (err) {
    // A refusal we produced ourselves (an unknown domain) carries a status and
    // is an ordinary 404, not an incident — stack-tracing it to stderr on every
    // probe is how a log stops being read. Anything without a status is genuinely
    // unexpected and still gets logged.
    if (!(err && Number.isInteger(err.status))) console.error('Chat error:', err);
    sendError(res, err);
  }
});

// Delete a conversation
router.delete('/:domain/:id', async (req, res) => {
  try {
    await assertKnownDomain(req.params.domain);
    if (!CONVERSATION_ID_RE.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid conversationId' });
    }
    await deleteConversation(req.params.domain, req.params.id);
    res.json({ success: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
