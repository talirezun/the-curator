/**
 * src/brain/raw-store.js — Track 7 Part II: raw-source fidelity.
 *
 * A wiki summary page is a lossy rendering of an original document. This
 * module is the ONLY way to get from a summary page back to the file it was
 * built from — for the app's HTTP surface and for Claude via MCP.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREAT MODEL — read this before changing anything below.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The summary→source link is a YAML `source:` field, promoted out of an
 * inline `Source:` line by injectFrontmatter (files.js). Concretely:
 *
 *     source: AI-as-a-Force-Multiplier_-Leaders-for-Industry-5.0 (1).pdf
 *
 * That string is **UNTRUSTED**. It is:
 *   • written by an LLM into a markdown file,
 *   • in a file the user can hand-edit in Obsidian,
 *   • in a folder that arrives over Personal Sync (git) and Shared Brain
 *     mirror pulls — i.e. from other machines and other people.
 *
 * And this module's whole job is "open the file this string names", with a
 * route that hands a path to `execFile('open', …)`. So the string is treated
 * as hostile input at every step, and `resolveRawSource` below is the single
 * chokepoint — nothing else in the codebase may build a path into raw/.
 *
 * Why the containment check is PHYSICAL, not lexical: v3.2.0 shipped a
 * CRITICAL because `resolveInsideWiki` was `path.resolve` + `path.relative`
 * with no `realpath`/`lstat`. It refused a path whose STRING escaped, and
 * said nothing about what the path POINTED AT — a symlink at
 * `wiki/entities/leak.md` → `/anywhere/secret.md` has a perfectly in-bounds
 * string, and health.js's destructive handlers shared the flaw, so a test
 * genuinely DELETED a real file outside the wiki. Symlinks reach raw/
 * realistically with no local attacker: git materialises mode-120000
 * entries, so one arrives through a Sync pull or a restored wiki.
 *
 * The lesson recorded in CLAUDE.md from that release is that **two
 * hand-maintained copies of a guard is what produced it**. So this module
 * does NOT write a second containment check: it imports `resolveInsideWiki`
 * from wiki-read.js, which is already the single hardened implementation
 * (health.js imports the same one). Despite its name it is root-agnostic —
 * it takes the root directory as its first argument and does nothing
 * wiki-specific — so passing `rawPath(domain)` is a reuse, not a stretch.
 * If that function is ever hardened again, this module inherits it for free.
 *
 * ── ENFORCED by resolveRawSource ────────────────────────────────────────
 *   • Input must be a non-empty string ≤ MAX_SOURCE_NAME_CHARS.
 *   • Control characters and NUL bytes are refused.
 *   • Backslashes are refused (Windows-shaped traversal, and a legal-but-
 *     ambiguous character in a POSIX filename).
 *   • The value is reduced to a BASENAME (`path.basename`), so directory
 *     structure in the input is discarded outright — `../../.ssh/id_rsa`
 *     can only ever become `id_rsa`, which then has to exist in raw/.
 *   • `.`, `..` and dot-only names are refused after basename reduction.
 *   • LEXICAL containment inside rawPath(domain) (inherited).
 *   • PHYSICAL containment via realpath — a symlink (file OR ancestor
 *     directory) that leaves the raw folder is refused, and a DANGLING
 *     symlink is refused because containment cannot be proven (inherited).
 *   • `lstat` must report a REGULAR FILE. Directories, symlinks, FIFOs,
 *     sockets and devices are all refused — notably, a symlink that
 *     resolves back inside raw/ is still refused here, which is STRICTER
 *     than resolveInsideWiki alone. A raw source is a file we ingested; it
 *     is never legitimately a link.
 *   • A missing file returns { ok: false, reason: 'missing' } — it never
 *     throws. Nothing in this module throws on hostile input.
 *
 * ── NOT ENFORCED (deliberately, and what that means) ────────────────────
 *   • File TYPE / extension. Anything sitting in raw/ can be resolved. The
 *     ingest route restricts uploads to pdf/md/txt, but a user can drop any
 *     file into their own raw folder, and refusing it would be pretending
 *     to a safety we do not have. Consumers that turn bytes into text must
 *     do their own capping/sanitising — see `readRawSourceText`.
 *   • Content inspection. We do not sniff magic bytes or verify a PDF is a
 *     PDF. Resolution answers "which file", never "is this file safe".
 *   • The DOMAIN argument. Callers pass a domain that is already validated
 *     against listDomains() by the route/tool layer. This module derives
 *     rawPath(domain) from it, so a hostile domain string would escape via
 *     the ROOT rather than the leaf. Guarded here anyway (isSafeDomain), so
 *     a future caller that forgets cannot open a hole — but the route/tool
 *     layer remains responsible for "does this domain exist".
 *   • Race conditions between the lstat and a caller's subsequent open.
 *     A local attacker who can swap a file in the user's own raw/ folder
 *     between our stat and the caller's read already has write access to
 *     that folder; there is no privilege boundary to cross.
 *
 * MCP-process note: this module is imported by `mcp/tools/raw-source.js`,
 * so it is loaded inside the MCP stdio child process where stdout is
 * reserved for JSON-RPC frames. It MUST keep stdout pure — no `console.log`
 * anywhere in this file, ever (use `console.error`; see the v2.5.3 "MCP
 * stdout pollution" fix in CLAUDE.md).
 */

import { createHash } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { lstat, readFile, appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { rawPath, wikiPath } from './files.js';
import { resolveInsideWiki } from './wiki-read.js';
import { getWikiPage } from './wiki-read.js';

// A filename long enough to be a DoS vector or a filesystem error rather than
// a real source. Every mainstream filesystem caps a single component at 255
// bytes; 512 chars is comfortably permissive while still bounded.
const MAX_SOURCE_NAME_CHARS = 512;

// Manifest lives INSIDE wiki/ — deliberately. See readManifest's docblock.
const MANIFEST_FILENAME = '.raw-manifest.jsonl';

/**
 * Domain-slug shape. Mirrors mcp/util.js's isValidSlug so the two layers
 * agree on what a domain name may contain. This is a backstop: the caller
 * is expected to have already checked the domain against listDomains().
 */
function isSafeDomain(domain) {
  return typeof domain === 'string'
    && domain.length > 0
    && domain.length <= 200
    && /^[a-z0-9][a-z0-9\-_]*$/i.test(domain);
}

/**
 * Reduce an untrusted `source:` value to a bare filename, or null.
 *
 * Exported for testing: the traversal corpus asserts against this directly
 * as well as through resolveRawSource, so a regression is attributable to
 * the sanitiser rather than to the containment check downstream.
 */
export function sanitiseSourceName(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_SOURCE_NAME_CHARS) return null;
  // Escape sequences, not raw bytes — a literal NUL in the source would make
  // git classify this file as BINARY and hide the guard from `git diff` and
  // plain `grep` (the exact accident documented in wiki-read.js).
  if (/[\u0000-\u001f]/.test(trimmed)) return null;

  // REFUSE any path structure outright — do not silently reduce it.
  //
  // Basename reduction alone is SAFE (`../../etc/passwd` becomes `passwd`,
  // which must then exist inside raw/ to resolve, so nothing escapes), but
  // it is not HONEST: on a machine that happened to have a `raw/passwd`, a
  // summary declaring `source: ../../etc/passwd` would quietly open a
  // DIFFERENT file from the one it names, and the user would be told that
  // was the source. A wrong answer delivered confidently is worse than a
  // refusal — this is the same reasoning that makes a dangling symlink a
  // refusal rather than a best-effort open.
  //
  // Refusing costs nothing real: ingest writes `originalName` verbatim, and
  // that value arrives from multer as a bare filename, so a legitimate
  // `source:` never contains a separator. One that does is corruption or an
  // attack, and both deserve the same answer.
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  // `..` cannot begin a real filename here, and this also catches encoded
  // traversal shapes carrying no literal separator (`..%2f..%2fetc%2fpasswd`).
  if (trimmed.startsWith('..')) return null;

  // Basename reduction is KEPT as defense in depth, so a future caller that
  // reaches this function by some other route still cannot smuggle a
  // directory through. For every input accepted above it is a no-op, and the
  // equality check makes that explicit rather than assumed.
  const base = path.basename(trimmed);
  if (!base || base !== trimmed) return null;
  // `.` and dot-only names ('...', '....') are never real files.
  if (/^\.+$/.test(base)) return null;
  return base;
}

/**
 * Does this `source:` value name a WEB PAGE rather than a local file?
 *
 * Found in the real corpus, not invented: `domains/articles` contains a
 * summary whose frontmatter reads `source: medium.com/@talirezun`. The
 * separator refusal above correctly declines to treat that as a filename,
 * but reporting it as "unsafe" tells the user their wiki looks hostile when
 * the truth is simply "this one came from the web, not from a file". A
 * confident wrong explanation is the failure mode this module exists to
 * avoid, so the two cases are distinguished.
 *
 * THIS IS CLASSIFICATION ONLY. Nothing in The Curator fetches this value —
 * doing so would turn an LLM-authored, sync-delivered string into an
 * outbound request, i.e. an SSRF primitive pointed at whatever host the
 * string names. It is reported to the user as text and nothing more.
 * Deliberately conservative: anything not clearly web-shaped stays
 * classified as unsafe.
 */
export function looksLikeExternalSource(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > 2048) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return true;          // scheme://…
  if (/^www\./i.test(v)) return true;                            // www.example.com/…
  // host.tld/path — requires a dot-separated host AND a path segment, so an
  // ordinary filename with dots ("report.final.pdf") is not misread as a URL.
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+\/\S/i.test(v);
}

/**
 * Resolve an untrusted source filename to an absolute path inside a domain's
 * raw/ folder. THE single chokepoint — nothing else may build a raw path.
 *
 * Never throws, on any input.
 *
 * @param {string} domain      Domain slug (route/tool layer validates existence).
 * @param {string} sourceName  Untrusted `source:` frontmatter value.
 * @returns {Promise<{ok:true, absPath, filename, bytes, mtime}
 *                 | {ok:false, reason:'unsafe'|'missing'|'not-a-file'}>}
 */
export async function resolveRawSource(domain, sourceName) {
  if (!isSafeDomain(domain)) return { ok: false, reason: 'unsafe' };

  const filename = sanitiseSourceName(sourceName);
  if (!filename) return { ok: false, reason: 'unsafe' };

  const rawDir = rawPath(domain);

  // Lexical + PHYSICAL containment, both inherited from the single hardened
  // implementation (see the module docblock's reuse rationale). A symlinked
  // leaf or ancestor that leaves rawDir, and a dangling symlink, are refused
  // here rather than by us.
  const absPath = resolveInsideWiki(rawDir, filename);
  if (!absPath) return { ok: false, reason: 'unsafe' };

  let st;
  try {
    // lstat, not stat: we want to see a symlink AS a symlink and refuse it.
    // A symlink pointing back inside raw/ would satisfy resolveInsideWiki
    // (correctly — it is not an escape), but a raw source is a file we
    // ingested, never a link, so this is deliberately stricter.
    st = await lstat(absPath);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!st.isFile()) return { ok: false, reason: 'not-a-file' };

  return {
    ok: true,
    absPath,
    filename,
    bytes: st.size,
    mtime: st.mtime.toISOString(),
  };
}

/**
 * Given a wiki page path, find the original document it was built from.
 *
 * Only summaries carry a `source:` — an entity or concept page is synthesised
 * from many sources and has no single original. That is a clean "no source"
 * result, not an error: the app's reader panel asks this for whatever page is
 * open and must not see a 500 for an entity.
 *
 * `computeSummarySlugFromSource` is LOSSY (strips the extension, lowercases,
 * strips punctuation, truncates at 80 chars) and therefore NOT reversible —
 * the filename is read from frontmatter, never derived from the slug.
 *
 * @returns {Promise<{found:boolean, reason?:string, filename?:string, ...}>}
 */
export async function sourceForSummary(domain, summaryPath) {
  let page;
  try {
    page = await getWikiPage(domain, summaryPath);
  } catch (err) {
    // Propagate the reader's own status codes (400 bad path, 404 no page) —
    // the route layer already knows how to render those.
    throw err;
  }

  if (page.folder !== 'summaries') {
    return {
      found: false,
      reason: 'not-a-summary',
      page: page.path,
      message:
        `"${page.path}" is a ${page.type} page. Only summary pages record the single ` +
        `original document they were built from; entities and concepts are synthesised ` +
        `from many sources.`,
    };
  }

  const declared = page.frontmatter?.source;
  if (!declared || typeof declared !== 'string' || !declared.trim()) {
    return {
      found: false,
      reason: 'no-source-recorded',
      page: page.path,
      message:
        `"${page.path}" does not record a source filename. Summaries written before ` +
        `the source field existed, or compiled from a conversation rather than ingested ` +
        `from a file, have no original document.`,
    };
  }

  // A web reference is not a local file and never will be — report it as
  // what it is instead of letting it fall through to "unsafe". Classification
  // only: the URL is never fetched (see looksLikeExternalSource).
  if (looksLikeExternalSource(declared)) {
    return {
      found: false,
      reason: 'external-source',
      page: page.path,
      declaredSource: declared,
      url: declared,
      message:
        `"${page.path}" was built from a web page (${declared}), not from a file on this ` +
        `machine, so there is no original document in the raw folder to open.`,
    };
  }

  const resolved = await resolveRawSource(domain, declared);
  if (!resolved.ok) {
    // The manifest may still know about it even when the blob is gone — raw/
    // is gitignored, so a second machine legitimately has the record and not
    // the file. Look it up so the caller can say something useful.
    const record = resolved.reason === 'missing'
      ? await findManifestRecord(domain, declared)
      : null;

    return {
      found: false,
      reason: resolved.reason,
      page: page.path,
      declaredSource: declared,
      manifest: record,
      message: resolved.reason === 'missing'
        ? (record
            ? `"${declared}" was ingested on ${record.ingestedAt} (${record.bytes} bytes) but is ` +
              `not on this machine. Raw source files are deliberately not synced — they stay on ` +
              `the machine that ingested them.`
            : `"${declared}" is not in this domain's raw folder. It may have been deleted, or ` +
              `ingested on another machine (raw source files are not synced).`)
        : resolved.reason === 'not-a-file'
          ? `"${declared}" exists in the raw folder but is not a regular file (it may be a ` +
            `folder or a shortcut/symlink), so The Curator will not open it.`
          // 'unsafe' covers two genuinely different situations, and telling a
          // user that a file sitting in their raw folder "is not a usable
          // filename" is simply wrong. Split on whether the NAME was the
          // problem or the PATH it resolved to was.
          : sanitiseSourceName(declared)
            ? `"${declared}" is in this domain's raw folder, but it is a shortcut/symlink ` +
              `pointing outside that folder (or to a target that no longer exists), so The ` +
              `Curator will not open it — a file it cannot contain is a file it cannot ` +
              `safely vouch for. Replace it with a real file inside raw/.`
            : `The source recorded on "${page.path}" is not a usable filename ` +
              `(${JSON.stringify(declared).slice(0, 120)}), so The Curator will not open it.`,
    };
  }

  return {
    found: true,
    page: page.path,
    filename: resolved.filename,
    absPath: resolved.absPath,   // server-side only — routes must not return this
    bytes: resolved.bytes,
    mtime: resolved.mtime,
  };
}

/**
 * sha256 of a raw source, streamed.
 *
 * Streamed rather than readFile'd because these are real documents: the
 * largest file in the maintainer's own `articles` domain is 126 MB, and
 * buffering that whole file to hash it would spike the long-running app
 * process's RSS for no reason. Node's Buffer cap would also make a
 * sufficiently large file fail outright.
 *
 * @returns {Promise<string|null>} lowercase hex digest, or null on any error.
 */
export function hashRawSource(absPath) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const hash = createHash('sha256');
      const stream = createReadStream(absPath);
      stream.on('error', () => done(null));
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => done(hash.digest('hex')));
    } catch {
      done(null);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Manifest — an append-only JSONL index of what was ingested.
//
// Location: `<domain>/wiki/.raw-manifest.jsonl`, i.e. INSIDE wiki/ and
// therefore git-tracked and synced, following .health-dismissed.jsonl's
// precedent exactly (same folder, same format, same merge rationale: one
// JSON object per line appends cleanly under git's 3-way merge).
//
// The BLOBS stay local and gitignored (`*/raw/` — that does not change).
// Only this small text index travels. That is the entire point: without it,
// a second machine opening a summary can only say "no idea"; with it, it can
// say "this came from report.pdf, 2.4 MB, ingested 12 March — not on this
// machine". It leaks nothing new, because the filename is ALREADY in the
// synced `source:` frontmatter of the summary page sitting beside it.
//
// Reads are tolerant: a malformed line is skipped, never thrown on. A
// half-written line from a killed process, or a git merge that produced
// conflict markers, must degrade to "that record is unavailable" rather
// than breaking the reader for every other record.
// ─────────────────────────────────────────────────────────────────────────

function manifestFilePath(domain) {
  return path.join(wikiPath(domain), MANIFEST_FILENAME);
}

/**
 * Append one ingest record. BEST-EFFORT: returns false on any failure and
 * never throws.
 *
 * The best-effort contract is load-bearing, and matches the MCP audit log and
 * the `onWarn` channel: an ingest that succeeded must NEVER be reported as
 * failed because a bookkeeping append did not land. The user's pages are on
 * disk; a missing index line is a cosmetic loss.
 *
 * Appended (not rewritten) so concurrent ingests cannot lose each other's
 * records, and so a crash mid-write costs at most the one trailing line —
 * which readManifest is built to skip.
 */
export async function appendManifestRecord(domain, record) {
  try {
    if (!isSafeDomain(domain)) return false;
    if (!record || typeof record !== 'object') return false;
    const filename = sanitiseSourceName(record.filename);
    if (!filename) return false;

    const line = JSON.stringify({
      filename,
      sha256: typeof record.sha256 === 'string' ? record.sha256 : null,
      bytes: Number.isFinite(record.bytes) ? record.bytes : null,
      ingestedAt: typeof record.ingestedAt === 'string' ? record.ingestedAt : new Date().toISOString(),
      summaryPath: typeof record.summaryPath === 'string' ? record.summaryPath : null,
    });

    const target = manifestFilePath(domain);
    await mkdir(path.dirname(target), { recursive: true });
    await appendFile(target, line + '\n', 'utf8');
    return true;
  } catch (err) {
    // stderr, never stdout — this module loads inside the MCP stdio child.
    console.error('[raw-store] manifest append failed (non-fatal):', err?.message);
    return false;
  }
}

/**
 * Read every parseable manifest record. Never throws; returns [] if the file
 * is absent or entirely unreadable.
 */
export async function readManifest(domain) {
  try {
    if (!isSafeDomain(domain)) return [];
    const target = manifestFilePath(domain);
    if (!existsSync(target)) return [];
    const raw = await readFile(target, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        // A line that parses but isn't a record (a bare number, a string, an
        // array) is as malformed as one that doesn't parse.
        if (rec && typeof rec === 'object' && !Array.isArray(rec)) out.push(rec);
      } catch {
        // Malformed line — skip it. See the tolerance rationale above.
      }
    }
    return out;
  } catch (err) {
    console.error('[raw-store] manifest read failed:', err?.message);
    return [];
  }
}

/**
 * Most recent manifest record for a filename, or null.
 * Comparison is on the SANITISED basename on both sides, so a record written
 * with a path-shaped filename can still be found by its basename.
 */
export async function findManifestRecord(domain, sourceName) {
  const want = sanitiseSourceName(sourceName);
  if (!want) return null;
  const all = await readManifest(domain);
  let best = null;
  for (const rec of all) {
    if (sanitiseSourceName(rec.filename) !== want) continue;
    if (!best || String(rec.ingestedAt || '') >= String(best.ingestedAt || '')) best = rec;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────
// Text extraction for MCP.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Default cap on extracted text handed to an MCP client.
 *
 * The MCP response budget is 400 KB total (enforceSizeLimit, mcp/tools/index.js),
 * shared with every other field and with the rest of the conversation. 120 KB
 * (~30 k tokens) leaves the envelope comfortably under budget so the size
 * guard never has to trim this tool's output, while still being far more of
 * the original document than the summary page carries.
 */
export const MAX_EXTRACT_CHARS = 120 * 1024;

/**
 * Hard BYTE ceiling on returned text.
 *
 * A character cap alone is not sufficient and this nearly shipped wrong: the
 * MCP budget is measured in BYTES (`Buffer.byteLength`, enforceSizeLimit),
 * but JavaScript string length counts UTF-16 code units. A document in
 * Chinese, Japanese, Greek, Cyrillic — or an English PDF whose extractor
 * emits “smart quotes” and em-dashes — runs 2–3 bytes per character, so
 * 120 k characters can be 360 KB of UTF-8 and blow a 400 KB budget shared
 * with every other field. 200 KB leaves the envelope safely under budget
 * whatever the script, so enforceSizeLimit never has to trim this tool's
 * output (its trimmer only halves ARRAYS — it cannot shrink a long `text`
 * string, and would fall through to a structured error, losing the answer
 * entirely).
 */
export const MAX_EXTRACT_BYTES = 200 * 1024;

/**
 * Truncate to at most `maxBytes` of UTF-8 WITHOUT splitting a character.
 * `Buffer.slice` on a multi-byte boundary produces U+FFFD; we walk back to
 * the last complete character instead.
 */
function sliceToByteBudget(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8');
  let end = maxBytes;
  // UTF-8 continuation bytes are 10xxxxxx; back up off the middle of one.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Extract capped, plain TEXT from a resolved raw source.
 *
 * Binary safety is the point of this function. A PDF's bytes must never reach
 * the JSON-RPC stream, and MCP's storage adapter cannot help here (it forces
 * 'utf8', which would mangle a PDF into replacement characters rather than
 * refuse it). So: PDFs go through the real pdf-parse extractor, and anything
 * that is not decodable text is REFUSED rather than emitted as mojibake.
 *
 * @param {string} absPath  Must have come from resolveRawSource.
 * @param {number} maxChars
 * @returns {Promise<{ok:true, text, truncated, totalChars}
 *                 | {ok:false, reason:'binary'|'unreadable', message}>}
 */
export async function readRawSourceText(absPath, maxChars = MAX_EXTRACT_CHARS) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : MAX_EXTRACT_CHARS;

  let text;
  try {
    // extractText is ingest's own extractor (exported in this release) — one
    // implementation, so what Claude reads is what the wiki was built from.
    const { extractText } = await import('./ingest.js');
    text = await extractText(absPath);
  } catch (err) {
    return {
      ok: false,
      reason: 'unreadable',
      message:
        `Could not extract text from this file (${err?.message || 'unknown error'}). ` +
        `An encrypted or scanned/image-only PDF has no extractable text layer — ` +
        `run OCR on it first.`,
    };
  }

  if (typeof text !== 'string') {
    return { ok: false, reason: 'unreadable', message: 'Extractor returned no text.' };
  }

  // Binary refusal. extractText falls through to a utf8 read for anything
  // that is not a .pdf, and Node's utf8 decoder does not fail on binary — it
  // substitutes U+FFFD. So a hand-dropped .docx/.zip/image in raw/ would
  // otherwise be emitted as a wall of replacement characters. Two signals:
  // a NUL byte (never present in real text) or a high density of U+FFFD.
  const sample = text.slice(0, 8192);
  if (sample.includes('\u0000')) {
    return {
      ok: false, reason: 'binary',
      message: 'This file is binary, not text — The Curator will not send its bytes.',
    };
  }
  const replacements = (sample.match(/�/g) || []).length;
  if (sample.length > 0 && replacements / sample.length > 0.05) {
    return {
      ok: false, reason: 'binary',
      message: 'This file does not decode as text — The Curator will not send its bytes.',
    };
  }

  const totalChars = text.length;
  // Two independent caps, both enforced: characters (the caller's budget)
  // and BYTES (the MCP wire budget — see MAX_EXTRACT_BYTES).
  let out = totalChars > limit ? text.slice(0, limit) : text;
  out = sliceToByteBudget(out, MAX_EXTRACT_BYTES);
  return {
    ok: true,
    text: out,
    truncated: out.length < totalChars,
    totalChars,
  };
}
