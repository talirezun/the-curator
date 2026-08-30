import { Router } from 'express';
import {
  sendMessage,
  listConversations,
  readConversation,
  deleteConversation,
} from '../brain/chat.js';
import { assertKnownDomain } from '../brain/files.js';
// IMPORTED, never re-implemented. isAbortError is llm.js's own classifier for
// "the caller stopped this" (it tags `curatorAborted`, and also matches a raw
// SDK `AbortError` we never got to translate). A second hand-written copy of a
// classifier is the shape that produced the v3.2.0 CRITICAL.
import { isAbortError } from '../brain/llm.js';
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
//
// `errorText` exists so the JSON body and the SSE `error` frame cannot drift
// into two different disclosure policies. Two hand-maintained copies of a
// scrubber is the shape that produced the v3.2.0 CRITICAL, and the SSE siblings
// this route otherwise copies (ingest, compile) both emit RAW `err.message` —
// which is exactly what must NOT be copied here, because a chat turn's errors
// reach the same fs layer the JSON path was scrubbed for.
function errorText(err) {
  return scrubPaths(String((err && err.message) || 'Unexpected error'));
}

function sendError(res, err) {
  // Raw `fs` errors embed absolute paths, which on a real install is the user's
  // home directory and their cloud-storage layout. `scrubPaths` is the v3.3.0
  // scrubber, imported from its single home; it keeps the basename, which is
  // the half that helps.
  res.status(err && Number.isInteger(err.status) ? err.status : 500)
     .json({ error: errorText(err) });
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
  // ── CANCELLATION: WHAT COUNTS AS "THE CLIENT IS GONE" ───────────────────
  //
  // MEASURED, NOT ASSUMED (express 4.22.2 / node 22.14, 25 runs per case).
  // Three obvious candidates are all WRONG here, each for the same reason —
  // express.json() has already drained the request body before this handler
  // runs, so the readable side is finished on a perfectly healthy request:
  //
  //   req.destroyed        true on entry in 25/25 NORMAL requests.
  //   req.on('close')      fires on entry in 25/25 NORMAL requests.
  //   req.aborted          false in 25/25 ABORTED requests (legacy, unset).
  //
  // res.on('close') fires in BOTH cases too — on a normal request it simply
  // fires later, after we have written. So the event alone cannot discriminate
  // and `res.on('close', abort)` would cancel every successful turn.
  //
  // The discriminator is the RESPONSE's own write state at the moment close
  // fires. Over 25 aborted requests it was identical every time
  // (`writableEnded:false, writableFinished:false, headersSent:false,
  // destroyed:true`), and on a normal request res.end() sets writableEnded
  // synchronously BEFORE close is emitted. So:
  //
  //   close fired AND we have not written  <=>  the connection died under us.
  //
  // `writableEnded` (end() was called) rather than `writableFinished` (bytes
  // flushed) is the right test: it is the earliest point at which we have
  // committed a response, so it can never lag behind our own write.
  //
  // WHAT THIS DELIBERATELY DOES *NOT* CATCH: an open-but-idle connection. In
  // the SPA, navigating to another conversation or another section leaves the
  // fetch in flight and the socket open, so nothing fires here, the turn runs
  // to completion and sendMessage persists it. That is the required behaviour,
  // not a gap. The only things that reach this code are a genuinely closed
  // connection: the tab closing, or the browser aborting the fetch.
  //
  // CROSS-LAYER NOTE: this makes the FRONTEND the sole author of intent. If
  // views/chat.js ever aborts its in-flight fetch on view teardown, that will
  // read here as a cancel and the turn will stop. Only a Stop control should
  // abort the fetch; a view change must not.
  //
  // Registered before assertKnownDomain, which does not weaken the "nothing
  // derived from an unvalidated domain is ever built" invariant above: an
  // AbortController and a listener on `res` derive nothing from `:domain` and
  // touch no path. One listener on a per-request `res` object also cannot
  // accumulate — the keep-alive SOCKET is reused across requests, `res` is not.
  //
  // MEASURED HONESTLY, because three of the four lines below are DEFENCE IN
  // DEPTH rather than independently load-bearing, and saying otherwise would be
  // claiming coverage this does not have:
  //   • swapping res.on('close') for req.on('close') reds 19 assertions,
  //     including "a turn nobody is watching still persists". That one is the
  //     whole reason the measurement above was done instead of guessing.
  //   • deleting the `writableEnded` line ALONE leaves the suite 58/58 GREEN.
  //     It is a no-op today only because `clientGone` is never read after
  //     res.json() — so the handler is correct by COINCIDENCE without it, and
  //     one reordering (an await added before the write, a post-response hook)
  //     turns it into the 19-red mutation. It stays because it makes the
  //     invariant explicit; it is not claimed as tested behaviour.
  //   • both `if (clientGone) return` lines are green when deleted too. See
  //     each one's own note for why it is kept and what makes it redundant.
  //
  // ── ADDENDUM: THE SSE PATH, AND THE ONE MEASURED LINE THAT MOVES ────────
  //
  // The measurement above was taken against a handler that writes ONCE, at the
  // end. Under `stream: true` this handler flushes headers immediately and then
  // writes frames for the whole turn, so one observation in it is no longer
  // true and must not be relied on:
  //
  //   headersSent — `false` in 25/25 aborted requests as measured, because
  //                 nothing had been written yet. Under SSE it is TRUE from
  //                 flushHeaders() onward, for the entire turn, on a healthy
  //                 request and on an aborted one alike.
  //
  // SO `headersSent` IS NOT A DISCRIMINATOR AND THIS CHECK MUST NOT BE
  // "SIMPLIFIED" TO IT. It would read as "we have answered" from the first
  // millisecond of every streaming turn, so close would never be treated as a
  // disconnect and a streaming turn could never be cancelled at all.
  //
  // `writableEnded` still discriminates, unchanged, and for the same reason it
  // did before: ONLY `res.end()` sets it, and neither setHeader nor
  // flushHeaders nor res.write does. On the SSE path res.end() runs in the
  // handler's `finally`, i.e. strictly after every frame, so at the moment a
  // genuine disconnect fires close it is still false — exactly as measured.
  // The whole streaming change therefore rides on the discriminator that was
  // measured, and touches nothing about how it is derived.
  const controller = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (res.writableEnded) return; // we already answered — a normal close
    clientGone = true;
    controller.abort();
  });

  // ── CONTENT-NEGOTIATED: STREAMING IS STRICTLY ADDITIVE (v3.23) ───────────
  //
  // Without `stream: true` in the body this route answers with `res.json(result)`
  // exactly as it always has — same object, same status, same everything. That
  // is not politeness, it is a hard requirement with two named consumers:
  // `/old` (src/public/app.js) POSTs here and reads `await res.json()`, and
  // scripts/test-chat-cancel.js does the same across ~40 assertions. A route
  // that only spoke SSE would break the escape-hatch shell and blind the suite
  // that guards cancellation.
  //
  // `=== true` and nothing looser. A string `"true"`, a `1`, or a truthy object
  // does NOT stream. The strictness is the point: the JSON path is the safe
  // default, so anything ambiguous must land on it rather than on the branch
  // that changes the content type out from under a caller who did not ask.
  //
  // `streaming` (as opposed to `wantsStream`) means "SSE HEADERS ARE ALREADY
  // OUT". Everything downstream branches on THAT, never on the request flag,
  // because the only question that matters after a failure is whether we have
  // already committed to a 200 + text/event-stream. It flips at exactly one
  // place, immediately after flushHeaders().
  let streaming = false;
  const emit = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { domain } = req.params;
    const { message, conversationId, responseStyle, provider, model } = req.body;
    // READ SEPARATELY, NOT ADDED TO THE DESTRUCTURE ABOVE, and that is not a
    // style choice: test-chat-model.js:2206 pins that exact destructuring line
    // with a source regex (`/responseStyle, provider, model \} = req\.body/`),
    // so appending `, stream` to it reds a suite this change has no business
    // touching. Recorded rather than worked around silently — a source regex
    // that proves a line EXISTS proves nothing about what it renders (v3.0.17),
    // and this is what that coupling costs the next person to widen this body.
    const wantsStream = req.body.stream === true;

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
    // ── EVERY REFUSAL HAPPENS ABOVE THIS LINE ─────────────────────────────
    //
    // flushHeaders() commits us to `200 text/event-stream` irrevocably: after
    // it, `res.status(400)` is a no-op and the client is parsing frames. So the
    // missing-message 400 and assertKnownDomain's 404 both run FIRST and reach
    // the client as real status codes with a JSON body, identically on both
    // paths. The ordering is the guarantee; there is no second in-band way to
    // say "your domain does not exist".
    //
    // Deliberately NO `event:` lines. This app carries two SSE dialects —
    // routes/health.js and routes/config.js write `event: <type>` before the
    // data line; routes/ingest.js, routes/compile.js, the ingest queue and
    // sharedbrain write a bare `data:` with a `type` KEY inside the payload.
    // Chat's sibling is compile (one long LLM call, progress then a terminal
    // frame), so it follows compile. Mixing the two would make an `onmessage`
    // handler silently receive nothing.
    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      streaming = true;
    }

    const result = await sendMessage(domain, conversationId || null, message, {
      responseStyle, provider, model, signal: controller.signal,
      // undefined on the JSON path, which generateText normalises to null — so
      // a non-streaming request takes a byte-identical path to before.
      //
      // The frame is CONSTRUCTED here rather than forwarded as `emit(d)`,
      // because the wire contract belongs to this file. llm.js's
      // makeDeltaEmitter already guarantees a non-empty `text` and a `type` of
      // exactly 'content' or 'reasoning' (an empty delta is dropped there, and
      // that drop is load-bearing upstream: an empty delta would COMMIT the
      // attempt and disable the retry ladder for no visible benefit). Naming
      // the two fields explicitly means a future field added to llm.js's
      // internal delta shape cannot leak onto the wire unreviewed.
      onDelta: wantsStream ? (d) => emit({ type: d.type, text: d.text }) : undefined,
    });
    // The client hung up while we were working. The turn still ran to
    // completion and sendMessage has already persisted it — see the
    // persistence rule at that write — so there is nothing to recover, only
    // nobody left to tell. Writing here is pointless rather than fatal:
    // measured over 25 aborted requests, res.json() on a destroyed socket
    // neither threw nor emitted 'error' (an unguarded second res.end() did not
    // either). We return anyway, because serialising a response for a socket
    // that is gone is work with no reader.
    //
    // Deleting this line alone leaves the suite GREEN (measured): res.json() on
    // a destroyed socket is inert, so skipping it saves work and changes no
    // observable behaviour. Hygiene, not a guarantee — recorded as such.
    if (clientGone) return;
    // The terminal frame carries the FULL sendMessage result, unchanged and
    // un-enumerated — the same object `res.json` sends on the other path, so
    // the two surfaces cannot disagree about what a turn produced. Enumerating
    // fields here is how `usage` would have become the app's next dead-data
    // field (v3.9.0 finding 7); the suite instead pins the frame's exact key
    // set, so a NEW field is a green change and a field named `type` — which
    // would clobber the frame's own discriminator and hang the consumer — is a
    // red one.
    if (streaming) return emit({ type: 'done', ...result });
    res.json(result);
  } catch (err) {
    // Same reason as above, one branch earlier: nothing can reach a closed
    // socket. A cancel is also NOT an incident — logging every user Stop as an
    // error is how a log stops being read, which is the rule the status check
    // below already encodes for a self-produced 404.
    //
    // Also GREEN when deleted alone, and the REASON is worth recording because
    // it is a dependency on another module: generateText normalises ANY error
    // raised once its signal has fired into a tagged abort error
    // (`isAbortError(err) || signal.aborted -> throw makeAbortError()`), so a
    // post-cancel failure arrives here already classified and is caught by the
    // isAbortError branch below instead. This line is what keeps that true for
    // a failure raised OUTSIDE generateText — a writeConversation EACCES after
    // the user left — which no offline fixture currently reaches.
    if (clientGone) return;
    // Headers are already out and the status is already 200, so there is no
    // status code left to send: on this path EVERY failure is an in-band frame.
    // That includes an abort with the connection still open (the SDK raising
    // its own AbortError) — the client is still parsing and would otherwise
    // wait forever for a `done` that never comes. llm.js's ABORT_MESSAGE is
    // already a finished, user-readable sentence, so it needs no dressing.
    //
    // SCRUBBED, and this is the one place this route deliberately DIVERGES
    // from the ingest/compile idiom it otherwise copies: both of those emit a
    // raw `err.message`. A chat turn reaches the same conversation-file fs
    // layer whose absolute paths the JSON branch has always scrubbed, so the
    // frame goes through the same `errorText` the JSON branch uses.
    //
    // A refusal we produced ourselves cannot reach here — every one of them is
    // above flushHeaders — so a streaming error is always genuinely
    // unexpected, EXCEPT an abort, which is a user action and must not be
    // stack-traced (logging every Stop is how a log stops being read).
    if (streaming) {
      if (!isAbortError(err)) console.error('Chat stream error:', err);
      return emit({ type: 'error', message: errorText(err) });
    }
    // An abort with the connection still OPEN is not something this route can
    // cause — `controller` is per-request and only the close handler above ever
    // fires it. It would mean an SDK raised its own AbortError (e.g. an
    // internal timeout). The client is still waiting, so it must get an answer:
    // returning silently here would hang the browser forever. It is reported
    // without a stack trace because llm.js's ABORT_MESSAGE is already a
    // finished, user-readable sentence.
    if (isAbortError(err)) return sendError(res, err);
    // A refusal we produced ourselves (an unknown domain) carries a status and
    // is an ordinary 404, not an incident — stack-tracing it to stderr on every
    // probe is how a log stops being read. Anything without a status is genuinely
    // unexpected and still gets logged.
    if (!(err && Number.isInteger(err.status))) console.error('Chat error:', err);
    sendError(res, err);
  } finally {
    // GUARDED, not unconditional. On the JSON path res.json() has already
    // ended the response and an extra res.end() would be a no-op — but "a
    // no-op" is a claim about express internals, and the requirement here is
    // that the non-streaming path is UNCHANGED, not that a change happens to
    // be harmless. On the SSE path this is the only thing that ends the
    // response, and it must run on every exit including a disconnect, which is
    // why it is a finally rather than a line after each frame.
    if (streaming) res.end();
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
