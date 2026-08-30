/**
 * sse.js — the ONE frame reader for this frontend's SSE-over-fetch endpoints.
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * The `reader.read()` loop that turns a streamed fetch `Response` into
 * discrete JSON events is copy-pasted at five call sites today:
 * views/ingest.js's `runIngest` and `attachQueueStream`, views/chat.js's
 * `runCompile`, views/domains.js's `streamSSE`, and src/public/app.js's
 * `submitIngest` (the shipping frontend). A sixth is about to be added for
 * chat-turn streaming. Two hand-maintained copies of a parsing loop is this
 * project's own named failure shape (CLAUDE.md: the v3.2.0 CRITICAL was
 * exactly two copies of one containment check drifting apart); five copies
 * of a network-framing loop is the same risk at a larger multiple. This
 * module is the one place that loop lives from here on.
 *
 * WHAT WAS ACTUALLY COPIED, MEASURED ACROSS ALL FIVE SITES
 * -----------------------------------------------------------
 * Four of the five sites (ingest.js x2, chat.js, app.js) share ONE idiom
 * byte-for-byte in shape: buffer the decoded text, `split('\n')`, `pop()`
 * the trailing (possibly incomplete) line back into the buffer, and treat
 * only lines starting with `'data: '` as frames — everything else (a blank
 * line, an `event:` line, a comment) is silently skipped. This module
 * reproduces exactly that idiom. It is a DELIBERATE choice among two real
 * options that exist in this codebase today; see "WHAT I DID NOT COPY,
 * AND WHY" below for the other one (domains.js's frame-oriented reader),
 * which this module's behaviour is nonetheless a superset of for every
 * producer in this codebase (see the `event:` note below).
 *
 * THE API: AN ASYNC GENERATOR, NOT A CALLBACK
 * ---------------------------------------------
 * `readSseFrames(stream)` is an async generator yielding one parsed JSON
 * frame at a time. This shape was chosen — over a `streamSSE(url, body,
 * onEvent)`-style callback, which is what domains.js already has — because
 * the five real call sites split cleanly into two DIFFERENT termination
 * disciplines and a generator lets each caller keep its own without any
 * extra plumbing:
 *
 *   - ingest.js's `runIngest`/`attachQueueStream` and app.js's
 *     `submitIngest` BREAK the instant they see a terminal frame
 *     (`type: 'done'` / `type: 'error'`), often by THROWING from inside the
 *     loop body on an error frame so the surrounding try/catch handles it.
 *   - chat.js's `runCompile` deliberately reads to the actual end of the
 *     stream and only decides afterwards, accumulating `final`/`refused`/
 *     `errored` — the same "read to stream end, never break on a terminal
 *     frame" discipline shared.js's `runRevoke` documents at length as
 *     "THE SSE TRAP" (a later chunk can carry the REAL terminal frame after
 *     an earlier progress-shaped one).
 *
 * A `for await (const ev of readSseFrames(stream)) { ... }` loop supports
 * BOTH disciplines with the exact same generator: `break` or an uncaught
 * `throw` inside the loop body triggers the async iterator protocol's
 * `.return()` call on the generator, which resumes it at its current
 * suspend point as a `return` completion — running this generator's own
 * `finally` (see below) exactly once, then propagating the `break`/`throw`
 * to the caller. Reading to the natural end of the stream runs the same
 * `finally` when the `for (;;)` loop exits via `done`. One code path, one
 * cleanup guarantee, no sentinel return value needed to say "stop now" and
 * no second API shape built to serve a discipline no current caller needs
 * (see CLAUDE.md v3.16.0's own recorded lesson: "shipping an unwired
 * parameter is the shape this repo keeps re-learning" — a bespoke
 * `onFrame`-callback surface with no adopted caller would be exactly that).
 *
 * WHAT EVERY EXIT PATH GUARANTEES
 * ----------------------------------
 * `reader.cancel().catch(() => {})` runs in a `finally` around the read
 * loop, so it fires on all three ways this generator can stop: the stream
 * ending naturally (`done: true` with no more bytes), the consumer breaking
 * out of its `for await` early, and an uncaught error escaping the loop
 * body. Cancelling a reader whose stream has already ended is a harmless
 * no-op per spec (this is already relied on elsewhere in this codebase —
 * see domains.js's `streamSSE`), so unconditional cancellation on every
 * path is always safe.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * --------------------------------------------
 * `readSseFrames` only reads frames off a `ReadableStream` (typically
 * `response.body`). It does NOT call `fetch`, does not inspect
 * `response.headers`/`response.status`, and does not fall back to
 * `response.json()` for a non-streaming error response (a 400/409/etc.).
 * That decision belongs at the call site, not here, because every real
 * caller does something structurally DIFFERENT with a non-SSE response:
 * ingest.js reads a `duplicate` flag off the JSON body and renders a
 * dedicated banner; chat.js's `runCompile` throws a plain `Error` built
 * from `data.error`; app.js does the ingest-specific duplicate-banner
 * dance too, independently. There is no single "and then what" this module
 * could perform on their behalf without either guessing wrong for some
 * caller or growing a route-shaped configuration surface. So: validate the
 * response is actually a readable event-stream (typically via its
 * `content-type` header and/or `res.ok`) BEFORE calling this function, and
 * pass `response.body` once that's established.
 *
 * NOT ENFORCED — stated plainly, per this project's own documentation
 * doctrine, rather than implied away:
 *
 *   - No multi-line `data:` continuation. The SSE spec allows a single
 *     logical event to be split across several consecutive `data:` lines,
 *     joined with `\n` into one payload. This reader treats every line
 *     independently: two consecutive `data: ` lines are two separate
 *     `JSON.parse` attempts, not one joined payload. This is safe for this
 *     codebase specifically because EVERY producer here builds a frame with
 *     `res.write(\`data: ${JSON.stringify(x)}\n\n\`)` (see src/routes/
 *     ingest.js, ingest-queue.js, compile.js, sharedbrain.js, health.js) —
 *     `JSON.stringify` escapes any literal newline inside the payload as
 *     the two-character sequence `\n`, so a wire frame from this codebase's
 *     own server code can never legitimately need multi-line continuation.
 *     A hand-written `data:` block that DOES split a payload across lines
 *     (which the SSE spec permits) would be misread as two frames or two
 *     parse failures. Any payload containing a literal newline byte MUST be
 *     JSON-encoded before being written — which every producer here already
 *     does, but the reader does not verify it.
 *   - No `event:` / `id:` / `retry:` field support. This reader is
 *     line-oriented, not frame-oriented, and only inspects lines starting
 *     with `'data: '`; every other line — including a real `event: <type>`
 *     line — is silently skipped, exactly like four of the five existing
 *     copies already do. `src/routes/health.js` DOES write real
 *     `event: ${event.type}\n` lines ahead of its `data:` line (consumed
 *     today by views/domains.js's frame-oriented `streamSSE` and
 *     views/shared.js's `consumeRevokeChunk`) — so the blanket claim "there
 *     is no `event:` field anywhere in this codebase" would be false. What
 *     IS true, and verified by reading src/routes/health.js directly: every
 *     `event:` line health.js writes is built from the SAME object that is
 *     then `JSON.stringify`'d onto the `data:` line one line below
 *     (`res.write(\`event: ${event.type}\n\`); res.write(\`data:
 *     ${JSON.stringify(event)}\n\n\`)`), so `event.type` and the JSON
 *     payload's own `.type` field are always identical, always. A reader
 *     that discriminates on the JSON payload's `.type` (as every consumer
 *     in this codebase does, including domains.js/shared.js's `onEvent(type,
 *     payload)` callers, which only ever fall back to the `event:` line
 *     when the payload lacks its own `type` — a case that never occurs
 *     here) never needs the `event:` line at all. This reader ignoring it
 *     is therefore behaviourally exact for every producer + consumer pair
 *     in this codebase today, not merely "close enough" — see WHAT I DID
 *     NOT COPY, AND WHY below for the fuller comparison.
 *   - No final `decoder.decode()` flush call with no arguments. Every
 *     existing copy this module reproduces has the same gap: if a chunk
 *     boundary happens to split a multi-byte UTF-8 character right at the
 *     true end of the stream, the trailing partial bytes are silently
 *     dropped rather than flushed as U+FFFD by a final no-argument
 *     `decoder.decode()` call. Reproducing the existing idiom exactly means
 *     reproducing this pre-existing, extremely narrow gap rather than
 *     silently fixing it as an uninstructed side effect of this extraction.
 *
 * WHAT I DID NOT COPY, AND WHY
 * -------------------------------
 * views/domains.js's `streamSSE` and views/shared.js's `consumeRevokeChunk`
 * both buffer by FRAME (`buf.split('\n\n')`) rather than by LINE, and both
 * were built to consume `event:`-carrying frames from src/routes/health.js
 * and src/routes/sharedbrain.js respectively. This module does not adopt
 * that idiom, for two reasons. First, it is the minority shape — 4 of the 5
 * existing copies (and the compile/ingest/ingest-queue routes this module's
 * first adopter, chat streaming, is closest in shape to) use line-oriented
 * buffering, not frame-oriented. Second, and more load-bearing: a
 * `\n`-oriented reader is a strict behavioural SUPERSET of what the
 * `\n\n`-oriented ones need, for every real payload in this codebase. Every
 * frame this codebase's server code writes is `data: <one-line-of-JSON>\n\n`
 * — JSON.stringify never emits a raw newline — so splitting on `\n` and
 * keeping only `data:`-prefixed lines finds precisely the same frames a
 * `\n\n`-frame-then-`\n`-line reader would, and silently (and correctly)
 * ignores the `event:` line and the blank separator line exactly as
 * argued above. The reverse is not proven — a frame-oriented reader is
 * NOT verified here to handle every case this line-oriented one does — so
 * this module deliberately does not claim to unify or replace
 * domains.js/shared.js's readers; it is offered as what a FUTURE migration
 * of either could adopt without a behaviour change, not as something this
 * task performs. No existing view file is touched by this change.
 *
 * WHY THIS FILE TAKES NO IMPORTS
 * ---------------------------------
 * Like shared/text.js and shared/format-usd.js, this module touches no
 * `document`/`window` global and imports nothing, so it can be
 * `import()`ed directly under plain Node for testing — several other
 * modules in this tree (app.js, shared/listbox.js) throw `ReferenceError:
 * document is not defined` the moment they are imported outside a browser,
 * which collapses their test coverage to source-text scanning. This module
 * needs no such fallback: scripts/test-next-sse.js drives the real,
 * unmodified export directly.
 */

/**
 * Read Server-Sent-Event frames off a `ReadableStream` (typically
 * `response.body` from a `fetch()` call already confirmed to be streaming).
 *
 * Yields the PARSED JSON payload of every line that starts with the literal
 * six characters `'data: '` (matching every producer in this codebase,
 * which always writes exactly one space after the colon). A line that does
 * not start with that prefix — blank, a comment, an `event:`/`id:`/`retry:`
 * field, or anything else — is silently skipped, never yielded and never an
 * error. A `data:` line whose payload fails `JSON.parse` is ALSO silently
 * skipped (not a fatal error, not yielded) — matching every existing copy's
 * `try { ev = JSON.parse(line.slice(6)); } catch { continue; }`.
 *
 * A partial line straddling two `reader.read()` chunks is buffered and
 * completed by the next chunk before being parsed — this is the one
 * correctness property that makes the whole loop exist rather than parsing
 * each chunk in isolation.
 *
 * `reader.cancel()` is always attempted exactly once when this generator
 * stops, on every exit path (stream end, early `break` by the caller, or an
 * uncaught error/`.throw()` from the caller's loop body), and its result is
 * never awaited for success or failure — a rejected cancel is swallowed,
 * matching every existing copy.
 *
 * @param {{ getReader: () => { read: () => Promise<{done:boolean,value?:Uint8Array}>, cancel: () => Promise<any> } }} stream
 *   A WHATWG `ReadableStream` — pass `response.body`, after already having
 *   decided (at the call site) that `response` is a genuine SSE stream.
 * @returns {AsyncGenerator<any>} yields one parsed JSON frame per `data:` line.
 */
export async function* readSseFrames(stream) {
  if (!stream || typeof stream.getReader !== 'function') {
    throw new Error('readSseFrames: expected a ReadableStream (e.g. response.body), got ' + typeof stream);
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      // The last element of `lines` is whatever came after the final '\n' in
      // `buf` — a complete line if `buf` happened to end exactly on a
      // newline (in which case this is the empty string), or an incomplete
      // trailing line otherwise. Either way it must NOT be processed yet;
      // popping it off `lines` (mutating that array) and back into `buf` is
      // what lets the next chunk complete it. `String.prototype.split`
      // always returns an array with at least one element, so `.pop()` here
      // can never return `undefined`.
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let frame;
        try { frame = JSON.parse(line.slice(6)); } catch { continue; }
        yield frame;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
