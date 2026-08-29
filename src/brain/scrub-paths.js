/**
 * src/brain/scrub-paths.js
 *
 * The absolute-path scrubber, and its ONLY home.
 *
 * ── WHY IT LIVES IN A LEAF MODULE ───────────────────────────────────────────
 * It was written for the ingest queue (v3.3.0) and lived in `ingest-queue.js`,
 * which imports `llm.js` and `health.js`. `llm.js` needs it too — its
 * catalogue-persistence failures log a raw `fs` error, i.e. an absolute path,
 * to stderr from a BOOT-TIME auto-sync nobody is watching, and stderr is what
 * users paste into bug reports. Importing it back out of `ingest-queue.js`
 * would make llm.js -> ingest-queue.js -> llm.js a cycle AND drag the whole
 * queue (plus health.js) into the MCP child's import graph, where a stray
 * stdout write corrupts JSON-RPC (v2.5.3).
 *
 * So the implementation MOVED here, unchanged, and `ingest-queue.js` re-exports
 * it. There is still exactly one copy — the thing that matters — and every
 * existing importer (`sharedbrain-revoke.js`, `working-state.js`, the suites)
 * keeps its import path, so nothing had to be edited to agree with it.
 *
 * The docblock below is the original and is preserved verbatim, including the
 * measured table behind BARE_PATH_SPACE_BRIDGE.
 */

/**
 * Absolute-path scrubber for any string that can reach HTTP.
 *
 * Raw `fs` errors embed absolute paths, and two of them were escaping:
 * `item.error` carried `ENOENT: ... open '/private/tmp/.../wiki/log.md'` into
 * both `GET /:jobId` and every SSE `job` frame, and a create-time
 * `ENAMETOOLONG` carried the OS temp path AND the staging path into an HTTP
 * 500 body. On a real install that is the user's home directory and their
 * cloud-storage layout. `toWire` stripped the `stagedPath` FIELD and stopped
 * there — a field-level strip cannot see a path embedded in prose.
 *
 * ── Why there are two passes, and why the first version was worse than none ─
 *
 * The first implementation was ONE regex whose character class excluded
 * whitespace, so a match stopped dead at the first space and echoed the rest
 * verbatim. That is not a corner case: it is the COMMON case. Measured:
 *   /Users/alice smith/Google Drive/My Drive/wiki/log.md
 *     -> '.../alice smith/Google Drive/My Drive.../log.md'
 * The user's name and their entire cloud-storage layout survived a function
 * whose stated purpose was hiding exactly that, and its docblock asserted
 * "a false negative leaks the user's filesystem" while shipping one. Windows
 * was worse (`C:\Users\Alice Smith\...` kept everything after the drive
 * letter), and `Dropbox (Personal)`, `/Volumes/My Book` and
 * `OneDrive - Company` all leaked. The test only exercised space-free paths,
 * so it was green on precisely the inputs that already worked.
 *
 * ── ENFORCED ───────────────────────────────────────────────────────────────
 *
 * PASS 1 (quoted) is exact, and it is the one that matters: Node's `fs`
 * errors always quote the path (`open '<path>'`), so this pass sees the whole
 * path as a delimited unit and spaces, dashes, parentheses and drive letters
 * are all simply interior characters. Any quoted run whose content begins
 * with `/` or `<letter>:` is reduced to its basename, quotes preserved.
 * Verified against: spaces, `Dropbox (Personal)`, `/Volumes/My Book`,
 * `OneDrive - Company`, Windows `C:\Users\First Last\...`, and the
 * two-path `copyfile 'a' -> 'b'` shape.
 *
 * PASS 2 (bare) covers an absolute path that is NOT quoted — an unterminated
 * quote, or a path we composed into a message ourselves. It walks path
 * segments and will cross a space only when a separator follows within a
 * bounded lookahead (BARE_PATH_SPACE_BRIDGE), which is what stops it eating
 * the sentence after the path.
 *
 * ── NOT ENFORCED (stated, not hidden) ──────────────────────────────────────
 *
 *  - An UNQUOTED path containing a folder name of more than
 *    BARE_PATH_SPACE_BRIDGE + 2 space-separated words: the bridge gives up
 *    and the remainder of that path is echoed. The leading directories —
 *    including `/Users/<name>` — are still removed. Quoting the path (which
 *    every real `fs` error does) removes the limit entirely.
 *  - `~/Documents/...` is not an absolute path and is only partially
 *    scrubbed; nothing in this module produces one.
 *  - A path split across a newline.
 *
 * Both passes fail toward scrubbing where the two directions conflict:
 * over-scrubbing costs a few words of readability, under-scrubbing exposes
 * the user's home directory. Those costs are not symmetric.
 */

/**
 * How many extra space-separated tokens the bare pass may look past before it
 * must see a path separator. NOT a guess: measured on a fixture of five real
 * leak shapes and four real error messages that must survive byte-identical.
 *   {0,2} -> 2 of 5 shapes still leak
 *   {0,3} -> 1 of 5 still leaks
 *   {0,4} -> 0 leak, 0 prose damaged   <-- chosen
 *   {0,5} -> 0 leak, but 2 of 4 messages lose their trailing sentence
 * Both ends of that table are pinned by tests; moving this constant in either
 * direction turns one of them red.
 */
const BARE_PATH_SPACE_BRIDGE = 4;

/** One path segment character: no whitespace, no quote, no sentence punctuation. */
const PATH_SEG_CHARS = "[^\\s'\"`<>|,;()\\[\\]{}]";

const QUOTED_ABS_PATH_RE = /(['"`])((?:\/|[A-Za-z]:[\\/])[^'"`\n]*)\1/g;

const BARE_ABS_PATH_RE = new RegExp(
  // Must start at a boundary, so a URL's "//host/path" and an embedded
  // "https://x/y" are not mistaken for filesystem paths.
  "(?<![A-Za-z0-9:/\\\\._-])" +
  "(?:[A-Za-z]:[\\\\/]|/)" +
  // At least one more separator: a single-segment "/tmp" carries no user data
  // and, crucially, this is what stops the pass re-matching its own output.
  "(?:" + PATH_SEG_CHARS + "*[\\\\/])" +
  "(?:" + PATH_SEG_CHARS + "+|[ ](?=" + PATH_SEG_CHARS + "*(?:[ ]" +
    PATH_SEG_CHARS + "*){0," + BARE_PATH_SPACE_BRIDGE + "}[\\\\/]))*",
  "g"
);

/** The basename is the useful half and carries no location. */
function keepBasename(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : '';
  return last ? `.../${last}` : '...';
}

export function scrubPaths(value) {
  if (typeof value !== 'string' || !value) return value;
  const quoted = value.replace(QUOTED_ABS_PATH_RE, (_m, q, p) => `${q}${keepBasename(p)}${q}`);
  return quoted.replace(BARE_ABS_PATH_RE, (m) => keepBasename(m));
}
