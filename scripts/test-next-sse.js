#!/usr/bin/env node
/**
 * Offline battle test for src/public/next/shared/sse.js — the canonical SSE
 * frame reader extracted from the `reader.read()` loop copy-pasted across
 * views/ingest.js (x2), views/chat.js and src/public/app.js (see that
 * module's own docblock for the full inventory and what was deliberately
 * NOT unified: views/domains.js and views/shared.js's frame-oriented
 * `\n\n`-split readers).
 *
 * This suite drives the real, unmodified `readSseFrames` export directly —
 * no brace-extraction, no `new Function` sandbox — because the module takes
 * no imports and touches no `document`/`window` global, so it is importable
 * under plain Node exactly as shipped. §0 asserts that importability itself,
 * since two sibling modules in this tree (app.js, shared/listbox.js) throw
 * `ReferenceError: document is not defined` the instant they are imported
 * outside a browser.
 *
 * A `ReadableStream` is faked with a minimal `{ getReader() }` object whose
 * `read()`/`cancel()` are hand-rolled promises — no real network, no real
 * DOM `ReadableStream`, so this suite is deterministic and instant.
 */
import { fileURLToPath } from 'url';
import path from 'path';
import { readSseFrames } from '../src/public/next/shared/sse.js';

let passed = 0, failed = 0;
const fails = [];
function ok(l) { passed++; console.log(`  ✓ ${l}`); }
function bad(l, e) { failed++; fails.push({ l, e }); console.log(`  ✗ ${l}`); if (e) console.log(`    └─ ${e}`); }
function assert(c, l, e) { c ? ok(l) : bad(l, e || 'assertion failed'); }
function section(t) { console.log(`\n── ${t} ──`); }

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
void __dirname; // reserved for parity with sibling suites; unused here (no fs isolation needed)

// ── fake ReadableStream ──────────────────────────────────────────────────
// `chunks` is an array of STRINGS; each array element is what one
// `reader.read()` call returns as one decoded network chunk (encoded here
// with a real TextEncoder so `decoder.decode(value, {stream:true})` inside
// the module receives the same BufferSource shape a real browser fetch
// would hand it — a plain JS string would not be a valid `decode()` input).
const encoder = new TextEncoder();
function makeFakeStream(chunks, opts = {}) {
  let i = 0;
  const readCalls = { count: 0 };
  const cancelCalls = { count: 0 };
  const reader = {
    read: async () => {
      readCalls.count++;
      if (opts.readThrows && i === opts.readThrowsAt) throw new Error('read-boom (test fixture)');
      if (i < chunks.length) {
        const chunk = chunks[i++];
        return { done: false, value: encoder.encode(chunk) };
      }
      return { done: true, value: undefined };
    },
    cancel: async () => {
      cancelCalls.count++;
      if (opts.cancelRejects) throw new Error('cancel-boom (test fixture, must be swallowed)');
      return undefined;
    },
  };
  return { stream: { getReader: () => reader }, readCalls, cancelCalls };
}

async function collect(stream, { breakOn } = {}) {
  const frames = [];
  for await (const ev of readSseFrames(stream)) {
    frames.push(ev);
    if (breakOn && breakOn(ev)) break;
  }
  return frames;
}

(async () => {
  // ══════════════════════════════════════════════════════════════════════
  section('§0  Importability — the module must be usable under plain Node');
  // ══════════════════════════════════════════════════════════════════════
  {
    assert(typeof readSseFrames === 'function',
      'readSseFrames imports as a function (the import above did not throw ReferenceError: document is not defined)');
    const gen = readSseFrames(makeFakeStream([]).stream);
    assert(gen && typeof gen[Symbol.asyncIterator] === 'function',
      'calling readSseFrames(stream) returns something usable in `for await` (an async iterable)');
    assert(typeof gen.next === 'function' && typeof gen.return === 'function',
      'the returned object exposes .next()/.return() — the async generator protocol `for await` relies on for early exit');
    // Drain it so the underlying fake reader's cancel() runs and nothing is left dangling.
    // eslint-disable-next-line no-empty
    for await (const _ of gen) { /* empty stream — no frames expected */ void _; }
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§1  A normal multi-frame stream');
  // ══════════════════════════════════════════════════════════════════════
  {
    const { stream, cancelCalls } = makeFakeStream([
      'data: {"type":"progress","pct":10,"message":"starting"}\n\n',
      'data: {"type":"progress","pct":55,"message":"halfway"}\n\n',
      'data: {"type":"done","title":"finished"}\n\n',
    ]);
    const frames = await collect(stream);
    assert(frames.length === 3, `all 3 frames yielded (got ${frames.length})`);
    assert(frames[0].type === 'progress' && frames[0].pct === 10, 'frame 1 parsed correctly');
    assert(frames[1].type === 'progress' && frames[1].pct === 55, 'frame 2 parsed correctly');
    assert(frames[2].type === 'done' && frames[2].title === 'finished', 'frame 3 parsed correctly');
    assert(cancelCalls.count === 1, `reader.cancel() called exactly once on natural stream end (got ${cancelCalls.count})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§2  A frame split across two chunk boundaries (the lines.pop() buffering)');
  // ══════════════════════════════════════════════════════════════════════
  {
    // The FIRST chunk ends mid-JSON, with NO trailing '\n' at all — a naive
    // per-chunk parser would see one incomplete "line" and either choke or
    // silently drop it. The SECOND chunk completes that same line and adds
    // a fully separate terminal frame in the same read().
    const { stream } = makeFakeStream([
      'data: {"type":"progress","pct":5',                       // no trailing \n — genuinely incomplete
      '0,"message":"halfway"}\n\ndata: {"type":"done"}\n\n',    // completes it, then a whole 2nd frame
    ]);
    const frames = await collect(stream);
    assert(frames.length === 2, `exactly 2 frames recovered across the split (got ${frames.length}: ${JSON.stringify(frames)})`);
    assert(frames[0] && frames[0].type === 'progress' && frames[0].pct === 50 && frames[0].message === 'halfway',
      `the split frame is reassembled correctly, not dropped or mis-parsed (got ${JSON.stringify(frames[0])})`);
    assert(frames[1] && frames[1].type === 'done', 'the following frame in the same chunk is also yielded');
  }

  // Same property again, but splitting mid-line at a point that also
  // straddles the closing '\n' itself, to make sure the buffering isn't
  // accidentally only correct when the split lands inside the JSON body.
  {
    const { stream } = makeFakeStream([
      'data: {"type":"progress","pct":1}',   // no \n at all yet
      '\n\ndata: {"type":"progress","pct":2}\n\n',
    ]);
    const frames = await collect(stream);
    assert(frames.length === 2 && frames[0].pct === 1 && frames[1].pct === 2,
      `a split landing exactly at the newline boundary is also handled (got ${JSON.stringify(frames)})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§3  A malformed JSON frame is skipped, not fatal');
  // ══════════════════════════════════════════════════════════════════════
  {
    const { stream } = makeFakeStream([
      'data: {this is not valid json\n\n',
      'data: {"type":"progress","pct":1}\n\n',
      'data: also not json at all\n\n',
      'data: {"type":"done"}\n\n',
    ]);
    let threw = false, frames = [];
    try {
      frames = await collect(stream);
    } catch (err) {
      threw = true;
      void err;
    }
    assert(!threw, 'iterating past a malformed JSON frame does not throw');
    assert(frames.length === 2, `only the 2 well-formed frames are yielded (got ${frames.length}: ${JSON.stringify(frames)})`);
    // Deliberately defensive (frames[0]/[1] may be undefined if a mutation
    // makes a parse failure fatal — the case above already reports that as
    // its own failed assertion; this one must not additionally CRASH the
    // whole suite with a raw TypeError, which would hide every assertion
    // after it and read as "the module is broken" rather than "one
    // assertion failed". Found live: an earlier draft of this exact line
    // threw `Cannot read properties of undefined (reading 'type')` under
    // MUTATION 2 below, which is precisely the failure shape this project's
    // own test-diagnostics.js §0 exists to avoid for a different module.
    assert(!!(frames[0] && frames[0].type === 'progress' && frames[1] && frames[1].type === 'done'),
      `the well-formed frames are the right ones, in order (got ${JSON.stringify(frames)})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§4  Blank lines and non-"data: " lines are skipped (incl. a real "event:" line)');
  // ══════════════════════════════════════════════════════════════════════
  {
    const { stream } = makeFakeStream([
      '\n',                                        // a bare blank line
      ': this is an SSE comment line\n',            // SSE comment syntax
      'event: progress\n',                          // a REAL event: line (src/routes/health.js writes these)
      'data: {"type":"progress","pct":42}\n',
      'id: 17\n',                                   // an id: field
      'retry: 3000\n',
      '\n',
      'data: {"type":"done"}\n\n',
    ]);
    const frames = await collect(stream);
    assert(frames.length === 2, `only the 2 real data: frames are yielded, everything else silently skipped (got ${frames.length}: ${JSON.stringify(frames)})`);
    assert(frames[0].type === 'progress' && frames[0].pct === 42, 'the progress frame survives despite the surrounding event:/id:/retry:/comment lines');
    assert(frames[1].type === 'done', 'the done frame after it is also reached');
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§5  A stream that ends without a terminator ("done"/"error") frame');
  // ══════════════════════════════════════════════════════════════════════
  {
    const { stream, cancelCalls } = makeFakeStream([
      'data: {"type":"progress","pct":1}\n\n',
      'data: {"type":"progress","pct":2}\n\n',
      // stream simply ends here — no 'done', no 'error'
    ]);
    let threw = false, frames = [];
    try {
      frames = await collect(stream);
    } catch (err) {
      threw = true;
      void err;
    }
    assert(!threw, 'the generator completes cleanly when the stream ends with no terminal frame');
    assert(frames.length === 2, `both progress frames are yielded and iteration simply ends (got ${frames.length})`);
    assert(cancelCalls.count === 1, 'reader.cancel() still runs once on this "no terminator" natural end');
    // This mirrors every real caller's own post-loop check (e.g. ingest.js's
    // `if (!finalData) throw new Error('Ingest did not complete
    // successfully')`) — that decision belongs to the CALLER, not this
    // module, which is why this test only asserts the generator itself
    // behaves (no throw, no phantom frame) and leaves "what does the
    // absence of a terminal frame MEAN" unasserted here.
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§6  reader.cancel() runs on an early break — and no further reads happen');
  // ══════════════════════════════════════════════════════════════════════
  {
    // Both frames arrive in ONE chunk, so if the consumer's `break` failed
    // to actually stop iteration inside the generator, the second frame
    // would still be yielded from the SAME already-decoded chunk (no
    // network round-trip required to prove it) — this isolates the
    // assertion from any timing assumptions about read().
    const { stream, readCalls, cancelCalls } = makeFakeStream([
      'data: {"type":"done"}\n\ndata: {"type":"progress","pct":99}\n\n',
    ]);
    const frames = await collect(stream, { breakOn: (ev) => ev.type === 'done' });
    assert(frames.length === 1 && frames[0].type === 'done',
      `only the terminal frame is observed before the consumer breaks (got ${JSON.stringify(frames)})`);
    assert(readCalls.count === 1, `no further reader.read() calls happen after the consumer's early break (got ${readCalls.count})`);
    assert(cancelCalls.count === 1, `reader.cancel() runs exactly once on the early break (got ${cancelCalls.count})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§7  reader.cancel() runs when the consumer throws inside the loop body');
  // ══════════════════════════════════════════════════════════════════════
  {
    // Mirrors ingest.js's own idiom: `else if (ev.type === 'error') throw new
    // Error(ev.message);` from inside the for-await body, letting an outer
    // try/catch handle it — while still wanting the stream torn down.
    const { stream, cancelCalls } = makeFakeStream([
      'data: {"type":"error","message":"boom from the server"}\n\n',
      'data: {"type":"progress","pct":99}\n\n',
    ]);
    let threw = false, message = '';
    try {
      for await (const ev of readSseFrames(stream)) {
        if (ev.type === 'error') throw new Error(ev.message);
      }
    } catch (err) {
      threw = true;
      message = err.message;
    }
    assert(threw && message === 'boom from the server', `the thrown error propagates to the caller (got threw=${threw}, message="${message}")`);
    assert(cancelCalls.count === 1, `reader.cancel() still runs once even though the consumer threw (got ${cancelCalls.count})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§8  A rejecting reader.cancel() is swallowed, never surfaces to the caller');
  // ══════════════════════════════════════════════════════════════════════
  {
    const { stream, cancelCalls } = makeFakeStream(
      ['data: {"type":"done"}\n\n'],
      { cancelRejects: true },
    );
    let threw = false;
    let frames = [];
    try {
      frames = await collect(stream);
    } catch (err) {
      threw = true;
      void err;
    }
    assert(!threw, 'a rejecting cancel() does not propagate as an error out of the generator');
    assert(frames.length === 1 && frames[0].type === 'done', 'the frame itself is still delivered normally');
    assert(cancelCalls.count === 1, 'cancel() was still attempted exactly once');
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§9  A non-stream argument fails loudly and clearly, not with a raw TypeError');
  // ══════════════════════════════════════════════════════════════════════
  {
    for (const bad_ of [null, undefined, {}, 'not-a-stream', 42]) {
      let threw = false, message = '';
      try {
        // eslint-disable-next-line no-unused-vars
        for await (const _ of readSseFrames(bad_)) { /* never reached */ }
      } catch (err) {
        threw = true;
        message = err.message || '';
      }
      assert(threw && /ReadableStream/.test(message),
        `readSseFrames(${JSON.stringify(bad_)}) throws a clear, named error (threw=${threw}, message="${message}")`);
    }
  }

  console.log(`\n  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
  if (failed > 0) {
    for (const { l, e } of fails) console.log(`  ✗ ${l}${e ? ` — ${e}` : ''}`);
    process.exit(1);
  }
  console.log('\nAll sse.js tests green.');
  process.exit(0);
})();
