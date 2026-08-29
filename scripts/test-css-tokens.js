/**
 * test-css-tokens.js — OFFLINE suite that catches undefined CSS custom
 * property references before they ship.
 *
 * CSS custom properties (`--name`) fail SILENTLY. In v3.0.12 styles.css
 * shipped `var(--text-dim)` — a variable that was never defined anywhere.
 * The declaration was invalid, so the browser fell back to the inherited /
 * UA-default colour (near-black on a `<button>`), and the chat composer's
 * dropdown text became unreadable on the dark theme. Nothing caught it
 * because there was no CSS test at all — it shipped to real users and was
 * only found from a bug report (see CLAUDE.md's v3.0.12 entry).
 *
 * This suite is a small, dependency-free (node: builtins only) CSS scanner:
 *   1. Reads every LOCAL stylesheet <link rel="stylesheet"> in index.html
 *      (external ones like Google Fonts are skipped — we don't control their
 *      custom-property surface, and they don't ship this app's theme tokens).
 *   2. Strips comments / string literals / plain url(...) contents so stray
 *      "--" sequences inside them can't be mistaken for real definitions or
 *      references.
 *   3. Extracts every `--name: value;` DEFINITION, wherever it appears
 *      (:root, inside a media query, inside a [data-theme] block, inside any
 *      selector) — a definition anywhere in the cascade counts as "defined".
 *   4. Extracts every `var(--name)` / `var(--name, fallback)` REFERENCE,
 *      including nested ones inside a fallback (`var(--a, var(--b, red))`
 *      references BOTH --a and --b).
 *   5. Asserts every referenced name has a matching definition. A fallback
 *      value is NOT a definition — `var(--missing, blue)` still requires
 *      `--missing` to be defined somewhere, exactly like the real
 *      `--text-dim` incident (which had no fallback at all).
 *
 * Section 0 is a battery of self-tests against small synthetic CSS strings
 * with known right/wrong answers, so this suite can't silently rot into a
 * no-op that always finds zero references.
 *
 * ── Pre-existing findings (baselined, not new) ──────────────────────────
 * Building this scanner and running it against the real app originally
 * surfaced FIVE distinct undefined custom-property names in `styles.css`.
 * TWO of them — `--font-mono` (real token: `--mono`) and `--text-1` (likely
 * meant `--text`/`--text-2`) — were the genuine `--text-dim`-class bugs: NO
 * fallback, so an invalid declaration silently fell back to inherited/UA
 * colour. Those two have SINCE BEEN FIXED in `styles.css` (another agent
 * corrected both call sites to the real token names), so they are gone from
 * KNOWN_ISSUES below and are instead locked in by an explicit regression
 * assertion in section 3 — reintroducing `var(--font-mono)` or
 * `var(--text-1)` now fails loudly with a dedicated message, not just the
 * generic "new undefined variable" bucket.
 *
 * THREE remain, all carrying a working hex fallback (so they render
 * correctly today — CSS's fallback mechanism means these are dead/orphaned
 * token names, not silent rendering bugs) and are deliberately left as-is
 * for the design-system token consolidation work rather than patched ad hoc
 * (this suite is not the CSS's owner and must not edit styles.css):
 *
 *   --text-primary   (2 refs, hex fallback: #e2e8f0)
 *   --text-secondary (3 refs, hex fallback: #94a3b8 / #b8c0e0)
 *   --surface-1      (1 ref,  hex fallback: #0f1117)
 *
 * These three are listed in KNOWN_ISSUES below and reported as ⚠ (not
 * counted as failures) so the suite stays green while remaining honest —
 * every run prints them, so they can't be silently forgotten. ANY new
 * undefined reference (any name not in this exact list) is a hard failure.
 * When one of these three is eventually fixed in styles.css, simply delete
 * its entry here — the suite doesn't require the issue to still exist.
 *
 * ── Sections 5-8: the /next redesign shell (src/public/next/**) ────────
 * The shipping app (sections 1-4 above) is one token universe. `/next` —
 * the parallel redesign shell introduced in v3.1.3 — is a SEPARATE,
 * self-contained token universe with its own token files (tokens/*.css)
 * and its own shell.css / views/*.css. It must not inherit definitions
 * from the shipping app's styles.css, and the shipping app must not
 * inherit from it — merging the two would let a genuinely-undefined /next
 * reference silently resolve via a same-named shipping-app token (or vice
 * versa), which is exactly the class of bug this whole suite exists to
 * catch. Sections 5-8 repeat the sections-1-4 method (discover linked
 * stylesheets from the shell's own index.html → extract defs/refs → scan
 * JS files for inline CSS-in-JS) entirely independently, using fresh
 * Sets/Maps that are never unioned with the shipping app's. Section 6b
 * asserts the separation explicitly using real (not synthetic) token
 * names found at scan time — see its comment for why a hardcoded name
 * would be the wrong kind of assertion here.
 *
 * One pre-existing, already-in-production `/next` finding, verified before
 * baselining it (per this suite's own rule — see NEXT_KNOWN_ISSUES in
 * section 7): `--scrim` (shell.css:337) has a working rgba(...) fallback
 * and is real dead/orphaned naming, the same shape as the three shipping-
 * app names above — not a silent no-fallback failure.
 */

import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ─────────────────────────────────────────────────────────────────────────
// The parser
// ─────────────────────────────────────────────────────────────────────────

/** Blank out /* *\/ block comments, preserving length + newlines so char
 *  offsets computed against the ORIGINAL text stay valid for line numbers.
 */
function stripBlockComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === '/' && text[i + 1] === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      for (let k = i; k < j; k++) out += text[k] === '\n' ? '\n' : ' ';
      i = j;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/** Blank out any `// ...` line comment, UNLESS it's part of a URL scheme
 *  like `https://` (real .css never uses `//` comments; this is a defensive
 *  fallback in case a preprocessor-flavoured `//` sneaks into the file — and,
 *  since v3.0.16, the mechanism this suite reuses to strip real JS `//`
 *  comments when scanning app.js in section 4). Preserves length + newlines.
 *
 *  Performance note: the "previous non-whitespace character" check walks
 *  BACKWARD OVER THE INPUT `text` from the current position, not over the
 *  growing `out` accumulator. An earlier version did
 *  `out.replace(/\s+$/, '').slice(-1)`, which re-scans the ENTIRE
 *  accumulated buffer on every single `//` occurrence — invisible on a small
 *  CSS file (few or no `//` sequences) but O(n²) on a large JS file full of
 *  legitimate `//` (comments, `http://` URLs, regex literals): pointing this
 *  scanner at src/public/app.js (section 4) measured 22+ SECONDS with the
 *  old approach vs a few milliseconds with this one. The two are
 *  behaviourally equivalent — nothing before the current position can have
 *  been masked by a LATER `//` span, and a comment span is always jumped
 *  over via `i = j` rather than re-scanned, so `text[i-1]` (skipping
 *  whitespace) always agrees with what the old `out`-based check saw.
 */
function stripLineComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === '/' && text[i + 1] === '/') {
      let k = i - 1;
      while (k >= 0 && /\s/.test(text[k])) k--;
      const prevNonSpace = k >= 0 ? text[k] : '';
      if (prevNonSpace === ':') {
        // e.g. "https:" immediately before "//" — part of a URL, not a comment.
        out += text[i];
        i++;
        continue;
      }
      let j = text.indexOf('\n', i);
      j = j === -1 ? n : j;
      for (let k2 = i; k2 < j; k2++) out += ' ';
      i = j;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/** Blank the interior of '...' / "..." string literals (keep the quotes so
 *  length + structure are preserved). Prevents literal text like
 *  `content: "var(--fake)"` from being read as a real reference.
 */
function maskStrings(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < n && text[i] !== quote) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += text[i]; i++; } // closing quote
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Blank the interior of `url(...)` calls, UNLESS the interior itself
 *  contains a `var(` (e.g. `url(var(--icon-url))`), which stays intact.
 *  Prevents a filename like `--fake-icon.png` from being read as real.
 */
function maskPlainUrls(text) {
  return text.replace(/url\(([^)]*)\)/g, (whole, inner) => {
    if (/var\(/.test(inner)) return whole;
    const blanked = inner.replace(/[^\n]/g, ' ');
    return `url(${blanked})`;
  });
}

/** Full cleanup pipeline: comments → strings → plain urls. Same length as
 *  the input, so indices/line numbers computed on the result are valid
 *  against the original source too.
 */
function cleanCss(text) {
  let out = stripBlockComments(text);
  out = stripLineComments(out);
  out = maskStrings(out);
  out = maskPlainUrls(out);
  return out;
}

/** Every `--name: value;` DEFINITION in the (cleaned) text. A definition
 *  must sit in declaration position — immediately after `{`, `;`, or the
 *  start of the file (ignoring whitespace) — and must not be followed by a
 *  second `:` (a `::pseudo-element` right after a BEM-style `--modifier`
 *  class, e.g. `.btn--primary::before`, must not be mistaken for one).
 *  This also naturally rejects `.btn--primary:hover` (no boundary char
 *  immediately before the `--`, since BEM class names have no whitespace
 *  there) and rejects a fallback like `var(--a, --not-a-def)` (no `:`
 *  follows the name there).
 *  Returns a Map<name, number[]> of every definition's char index.
 */
function extractDefinitions(cleaned) {
  const defs = new Map();
  const re = /--([a-zA-Z0-9_-]+)\s*:/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const idx = m.index;
    let k = idx - 1;
    while (k >= 0 && /\s/.test(cleaned[k])) k--;
    const prevChar = k >= 0 ? cleaned[k] : null;
    const isDeclStart = prevChar === null || prevChar === '{' || prevChar === ';';
    const afterColon = m.index + m[0].length;
    const isDoubleColon = cleaned[afterColon] === ':';
    if (isDeclStart && !isDoubleColon) {
      if (!defs.has(m[1])) defs.set(m[1], []);
      defs.get(m[1]).push(idx);
    }
  }
  return defs;
}

/** Every `var(--name)` / `var(--name, fallback)` REFERENCE in the (cleaned)
 *  text, including references nested inside another var()'s fallback.
 *  Returns [{name, index}].
 */
function extractReferences(cleaned) {
  const refs = [];
  const re = /var\(\s*--([a-zA-Z0-9_-]+)/g;
  let m;
  while ((m = re.exec(cleaned))) {
    refs.push({ name: m[1], index: m.index });
  }
  return refs;
}

function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineNumberFor(lineStarts, index) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** True for an external URL this app doesn't control the token surface of:
 *  absolute http(s), protocol-relative (`//host/...`), or a data: URI.
 *  Used identically for <link href> discovery and @import target following —
 *  a single definition so the two can't silently disagree about what counts
 *  as "ours to scan".
 */
function isExternalUrl(href) {
  return /^(https?:)?\/\//i.test(href) || /^data:/i.test(href);
}

/** Tokenizes a single HTML tag's attributes into a Map<lowercase-name,
 *  value-or-null>, scanning SEQUENTIALLY so a quoted attribute VALUE is
 *  consumed as one atomic token and can never be re-scanned as if its text
 *  contained a second, nested attribute.
 *
 *  AUDIT-FOUND GAP (L2) this replaces a narrower fix for: the previous
 *  `extractAttr` matched `attrName\s*=\s*(?:"..."|'...'|...)` directly
 *  against the WHOLE tag text with only a negative-lookbehind guard against
 *  a hyphenated NAME PREFIX (so `data-href="x"` could no longer satisfy a
 *  lookup for `href`). That guard does nothing about an attribute NAME
 *  appearing, coincidentally, inside another attribute's quoted VALUE:
 *  `<link rel=stylesheet title="see href=DECOY.css" href="REAL.css">` still
 *  matched "href=DECOY.css" INSIDE the title value, because a flat regex
 *  scan has no notion of "already inside a value" — it just finds the next
 *  place the pattern fits, wherever that is. Sequential tokenization can't
 *  make that mistake: once the `title="..."` token is consumed, its entire
 *  quoted span (including any text that looks like `href=...`) is behind
 *  the tokenizer's cursor and is never re-examined as attribute syntax.
 *
 *  The leading `<link` (or whatever the tag name is) and the trailing `>`
 *  are stripped before tokenizing (self-closing `/>` is also stripped) so
 *  the tag-name text itself is never treated as a stray leading attribute.
 *  On a duplicate attribute name (malformed but not impossible HTML), the
 *  FIRST occurrence wins — matching how browsers resolve duplicate
 *  attributes.
 */
function parseAttrs(tagText) {
  const inner = tagText.replace(/^<[a-zA-Z][a-zA-Z0-9-]*/, '').replace(/\/?>$/, '');
  const attrs = new Map();
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(inner))) {
    const name = m[1].toLowerCase();
    const value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : null));
    if (!attrs.has(name)) attrs.set(name, value);
  }
  return attrs;
}

/** Extract one HTML attribute's value from a single tag string, agnostic to
 *  quoting style (double, single, or UNQUOTED — all valid HTML5) and
 *  case-insensitive on the attribute name (HTML attribute names are
 *  case-insensitive). Built on parseAttrs' sequential tokenizer (see its
 *  docblock for why that matters — it closes both the name-prefix collision
 *  this function used to guard with a lookbehind, e.g. `data-href`, AND the
 *  value-collision gap the lookbehind alone could not close, e.g. an
 *  unrelated attribute whose VALUE happens to contain the text "href=...").
 */
function extractAttr(tagText, attrName) {
  const attrs = parseAttrs(tagText);
  const name = attrName.toLowerCase();
  return attrs.has(name) ? attrs.get(name) : null;
}

/** Every <link ...> tag in `html` whose `rel` attribute contains the token
 *  "stylesheet" (rel can be a space-separated list, e.g. "preload
 *  stylesheet"), regardless of whether rel/href are quoted or unquoted.
 *  Returns { styleTags, local, externalCount } — `local` is the list of
 *  hrefs worth scanning (external ones, e.g. Google Fonts, are counted but
 *  not returned — we don't control their token surface).
 *
 *  Replaces an earlier design where the outer <link> match required
 *  `rel=["']stylesheet["']` (quotes mandatory) and href extraction used the
 *  unanchored pattern described in extractAttr's docblock above — both were
 *  real, audit-found gaps: `<link rel=stylesheet href=x.css>` (unquoted,
 *  valid HTML5) matched neither the old rel check nor the old href pattern.
 *
 *  AUDIT-FOUND GAP (L3), fixed here: the outer tag-boundary regex was
 *  `/<link\b[^>]*>/gi` — `[^>]*` is not quote-aware, so a `>` character
 *  appearing literally INSIDE a quoted attribute value (valid HTML5; `>`
 *  needs no escaping inside an attribute value) terminated the "tag" match
 *  early: `<link rel="stylesheet" title="a > b" href="REAL.css">` matched
 *  only up through the `>` inside the title value, silently dropping the
 *  real `href` attribute (which appears after that point) from the
 *  truncated match text. The stylesheet then vanished from `local` with NO
 *  assertion firing — coverage lost silently, worse than a loud failure.
 *  The fix is the standard quote-aware tag-matching trick: repeat "any char
 *  that isn't `>`, `"`, or `'`, OR a fully-quoted double-quoted span, OR a
 *  fully-quoted single-quoted span" up to the real closing `>` — a `>`
 *  inside either quote style is consumed as part of that quoted span and
 *  can never end the match early.
 */
function discoverStylesheetLinks(html) {
  const allTags = html.match(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || [];
  const styleTags = allTags.filter(tag => {
    const rel = extractAttr(tag, 'rel');
    if (!rel) return false;
    return rel.toLowerCase().split(/\s+/).includes('stylesheet');
  });
  const local = [];
  let externalCount = 0;
  for (const tag of styleTags) {
    const href = extractAttr(tag, 'href');
    if (!href) continue;
    if (isExternalUrl(href)) { externalCount++; continue; }
    local.push(href);
  }
  return { styleTags, local, externalCount };
}

/** Every `@import` target in a stylesheet's RAW (not yet string-masked) text.
 *  Must run on comment-stripped-but-NOT-string-masked text — cleanCss()'s
 *  maskStrings() would blank out exactly the quoted target this needs to
 *  read, e.g. `@import "foo.css";`. Handles `@import url(...)`, the bare
 *  `@import "...";` / `@import '...';` forms, an optional trailing media
 *  query, AND modern `@import layer(...) "...";` / `@import supports(...)
 *  "...";` cascade-layer / feature-query forms (AUDIT-FOUND GAP L4 — the
 *  previous regex required `url(...)` or a quoted target to appear
 *  IMMEDIATELY after `@import\s+`, so any modifier token in front of the
 *  target, like `layer(base)`, made the whole match fail silently).
 *
 *  Two-step approach: capture the whole `@import ... ;` (or `...EOF`)
 *  statement first, then search WITHIN it for a `url(...)` target (any
 *  position — modifiers may precede or follow it) and, failing that, the
 *  first bare quoted string (which is the target in every bare/layer/
 *  supports form, since those modifiers' own parenthesized contents don't
 *  ordinarily contain quotes).
 *
 *  AUDIT-FOUND GAP (L5), also fixed here: this used to accept an `@import`
 *  match ANYWHERE in the text, including inside an unrelated CSS string
 *  literal — e.g. `.x { content: "@import url(GHOST.css)"; }` — which
 *  queued a phantom target and crashed expandWithImports with an uncaught
 *  ENOENT (a controlled test failure is fine; an uncaught crash is not). A
 *  real `@import` at-rule can only appear at statement/declaration-block
 *  position: immediately after `;`, `{`, `}`, or the start of the file
 *  (ignoring whitespace) — the same plausibility check extractDefinitions
 *  above already applies to custom-property definitions. Text inside a
 *  quoted string value is preceded by that string's own opening quote
 *  character, which is none of those, so it's correctly rejected.
 *
 *  Also fixed: extracted targets are now `.trim()`-med. `url( i.css )`
 *  (spaces before AND after the bare filename, no quotes) previously
 *  captured a trailing space into the target string — untrimmed — which
 *  would fail to resolve to the real file on disk.
 *
 *  Returns an array of target strings (both local and external — the caller
 *  decides via isExternalUrl what to do with each).
 */
function findImportTargets(rawText) {
  const noComments = stripLineComments(stripBlockComments(rawText));
  const targets = [];
  const stmtRe = /@import\b([^;]*)(;|$)/g;
  let m;
  while ((m = stmtRe.exec(noComments))) {
    let k = m.index - 1;
    while (k >= 0 && /\s/.test(noComments[k])) k--;
    const prevChar = k >= 0 ? noComments[k] : null;
    const isStatementStart = prevChar === null || prevChar === ';' || prevChar === '{' || prevChar === '}';
    if (!isStatementStart) continue;

    const stmt = m[1];
    const urlMatch = stmt.match(/url\(\s*(['"]?)([^'")]*)\1\s*\)/i);
    let target = null;
    if (urlMatch) {
      target = urlMatch[2];
    } else {
      const strMatch = stmt.match(/(['"])([^'"]*)\1/);
      if (strMatch) target = strMatch[2];
    }
    if (!target) continue;
    target = target.trim();
    if (target) targets.push(target);
  }
  return targets;
}

/** BFS over `@import` chains starting from `initialFiles` (the stylesheets
 *  actually <link>ed from an index.html), resolving each local import
 *  relative to the IMPORTING file's own directory, so a genuinely-undefined
 *  var(--x) that lives only inside an imported file is no longer invisible
 *  to the scanner (the audit-found gap this closes: /next already ships
 *  tokens/fonts.css using @import, so this is not a hypothetical shape).
 *  External import targets (e.g. Google Fonts) are recorded but never
 *  followed — same reasoning as skipping external <link> hrefs: we don't
 *  control that token surface. Cycle-safe via a visited-by-absolute-path
 *  Set, so a (malformed) A-imports-B-imports-A chain terminates instead of
 *  looping forever.
 *
 *  AUDIT-FOUND GAP (L5): every `readFileSync` here used to be unguarded, so
 *  a typo'd or phantom `@import` target (a path that doesn't exist on disk
 *  — see findImportTargets' docblock for how a string literal could also
 *  produce one before that was fixed) threw an uncaught ENOENT and crashed
 *  the ENTIRE test suite with a raw stack trace, rather than failing this
 *  one check cleanly. Every read is now wrapped; an unreadable file is
 *  recorded in the new `unreadableFiles` list (never thrown) and is NOT
 *  added to `files` — critically, this means the caller's own separate
 *  `readFileSync` pass over the returned `files` list (sections 2 and 6
 *  below) can never re-encounter it and crash a second time. Each entry's
 *  `raw` content, once successfully read, is cached on the queue item so
 *  it is read from disk exactly once per file, not once here and again per
 *  caller.
 *
 *  Returns { files, skippedExternalImports, unreadableFiles } where `files`
 *  is initialFiles PLUS every reachable, successfully-read local import,
 *  each shaped the same way ({relPath, absPath}) so the caller's existing
 *  per-file scan loop needs no special-casing for "was this file linked
 *  directly or reached via @import".
 */
function expandWithImports(initialFiles) {
  const visited = new Set();
  const queue = [];
  const result = [];
  const skippedExternalImports = [];
  const unreadableFiles = [];

  function tryRead(relPath, absPath, from) {
    try {
      return { raw: readFileSync(absPath, 'utf8'), ok: true };
    } catch (err) {
      unreadableFiles.push({ relPath, absPath, from, error: err && (err.code || err.message) || 'unknown error' });
      return { ok: false };
    }
  }

  for (const f of initialFiles) {
    if (visited.has(f.absPath)) continue;
    visited.add(f.absPath);
    const r = tryRead(f.relPath, f.absPath, null);
    if (!r.ok) continue; // never added to result — caller's own read pass can't re-crash on it
    result.push(f);
    queue.push({ ...f, raw: r.raw });
  }

  while (queue.length) {
    const f = queue.shift();
    const targets = findImportTargets(f.raw);
    for (const target of targets) {
      if (isExternalUrl(target)) {
        skippedExternalImports.push({ from: f.relPath, target });
        continue;
      }
      const importedAbs = path.normalize(path.join(path.dirname(f.absPath), target));
      if (visited.has(importedAbs)) continue; // already queued/scanned — also breaks import cycles
      visited.add(importedAbs);
      const importedRel = path.relative(ROOT, importedAbs).split(path.sep).join('/');
      const r = tryRead(importedRel, importedAbs, f.relPath);
      if (!r.ok) continue; // phantom/typo'd import target — recorded, never re-read, never crashes
      const entry = { relPath: importedRel, absPath: importedAbs };
      result.push(entry);
      queue.push({ ...entry, raw: r.raw });
    }
  }
  return { files: result, skippedExternalImports, unreadableFiles };
}

/** Recursively list every `.js` file under `dir`. Used for the /next CSS-in-
 *  JS scan (section 8) so a new subdirectory (like next/shared/, added in
 *  this very release) is covered automatically instead of requiring the
 *  scanner to know its name in advance — the audit-found gap this closes:
 *  the previous version enumerated exactly two locations (next/app.js +
 *  next/views/*.js) and silently never looked at next/shared/**.
 */
function walkJsFiles(dir) {
  return walkFilesByExt(dir, '.js');
}

/** The one recursive walker both `walkJsFiles` (section 8) and
 *  `walkCssFiles` (section 9) delegate to. Deliberately ONE implementation:
 *  two hand-maintained copies of a discovery routine is this repo's named
 *  anti-pattern (v3.2.0's CRITICAL came from exactly that shape), and the
 *  §3f self-tests below therefore prove recursion for BOTH callers at once
 *  rather than covering one and leaving the other to be assumed.
 */
function walkFilesByExt(dir, ext) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFilesByExt(abs, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      out.push(abs);
    }
  }
  return out;
}

/** Recursively list every `.css` file under `dir`. Section 9's whole point is
 *  that this list is derived by WALKING THE TREE — never from a hardcoded
 *  set of expected filenames. A hardcoded list is what let a 4th declarer
 *  slip past the v3.8.0 single-copy guard whose comment claimed it checked
 *  "anywhere in /next", and a hardcoded list here could not have caught the
 *  v3.9.0 defect either, because the whole defect was a file NOT being named.
 */
function walkCssFiles(dir) {
  return walkFilesByExt(dir, '.css');
}

// ─────────────────────────────────────────────────────────────────────────
// 0. Parser self-tests — synthetic CSS with known right/wrong answers.
//    Without these, this suite could silently rot into a no-op that always
//    reports zero references (e.g. a regex typo that never matches anything
//    would still print a green summary).
// ─────────────────────────────────────────────────────────────────────────
section('0. Parser self-tests (synthetic CSS)');

{
  const src = `
:root { --known: red; }
.x { color: var(--known); }
.y { color: var(--missing-a, var(--missing-b, blue)); }
`;
  const cleaned = cleanCss(src);
  const defs = extractDefinitions(cleaned);
  const refs = extractReferences(cleaned);
  const refNames = refs.map(r => r.name);

  ok(defs.has('known') && !defs.has('missing-a') && !defs.has('missing-b'),
    'definitions: only --known is defined');
  ok(refNames.includes('known'), 'references: plain var(--known) is found');
  ok(refNames.includes('missing-a'), 'references: outer var(--missing-a, ...) is found');
  ok(refNames.includes('missing-b'),
    'references: NESTED var(--missing-b, blue) inside a fallback is also found');
}

{
  // "A fallback value is not a definition" — a hardcoded fallback must NOT
  // make the extractor think the variable is defined.
  const src = `.z { color: var(--not-defined-anywhere, #ffffff); }`;
  const cleaned = cleanCss(src);
  const defs = extractDefinitions(cleaned);
  const refs = extractReferences(cleaned);
  ok(!defs.has('not-defined-anywhere'),
    'a var() fallback value does not register as a definition');
  ok(refs.some(r => r.name === 'not-defined-anywhere'),
    'the reference itself is still recorded (so it can be checked against real definitions)');
}

{
  // Comments — both the /* */ block form and a defensive // line form —
  // must hide BOTH definitions and references inside them.
  const src = `
/* --should-not-count: red; */
// --also-should-not-count: blue;
.a {
  /* color: var(--commented-out-ref); */
  color: var(--should-not-count);
}
`;
  const cleaned = cleanCss(src);
  const defs = extractDefinitions(cleaned);
  const refs = extractReferences(cleaned);
  ok(!defs.has('should-not-count'), 'a definition inside a /* */ comment is ignored');
  ok(!defs.has('also-should-not-count'), 'a definition inside a // comment is ignored');
  ok(!refs.some(r => r.name === 'commented-out-ref'),
    'a var() reference inside a /* */ comment is ignored (not counted as a real usage)');
  ok(refs.some(r => r.name === 'should-not-count'),
    'the REAL (non-commented) reference to --should-not-count is still found — proving the ' +
    'name is correctly flagged as undefined rather than accidentally suppressed');
}

{
  // A definition inside a media query or a [data-theme] block still counts.
  const src = `
:root { --light-only: blue; }
@media (prefers-color-scheme: dark) {
  :root { --dark-var: black; }
}
[data-theme="dark"] { --themed: navy; }
.b { color: var(--dark-var); }
.c { background: var(--themed); }
`;
  const cleaned = cleanCss(src);
  const defs = extractDefinitions(cleaned);
  ok(defs.has('dark-var'), 'a definition inside @media (prefers-color-scheme: dark) counts as defined');
  ok(defs.has('themed'), 'a definition inside a [data-theme="dark"] block counts as defined');
}

{
  // "--name" appearing inside a string or a plain url(...) must not be
  // mistaken for a real definition or reference.
  const src = `
.d::before { content: "var(--fake-in-string)"; }
.e { background: url(images/--fake-in-url.png); }
`;
  const cleaned = cleanCss(src);
  const defs = extractDefinitions(cleaned);
  const refs = extractReferences(cleaned);
  ok(!refs.some(r => r.name === 'fake-in-string'),
    'a "var(...)"-shaped string INSIDE a quoted string literal is not read as a real reference');
  ok(!defs.has('fake-in-url') && !refs.some(r => r.name === 'fake-in-url'),
    '"--"-shaped text inside a plain url(...) is not read as a definition or reference');
  // url(var(--icon)) — a legitimate modern reference — must NOT be masked away.
  const src2 = `.f { background: url(var(--icon-url)); }`;
  const refs2 = extractReferences(cleanCss(src2));
  ok(refs2.some(r => r.name === 'icon-url'), 'url(var(--x)) still extracts --x as a real reference');
}

{
  // BEM-style double-hyphen class modifiers immediately followed by a
  // pseudo-class/pseudo-element colon must never be mistaken for a
  // custom-property definition.
  const src = `.button--primary:hover { color: red; }`;
  const defs = extractDefinitions(cleanCss(src));
  ok(defs.size === 0,
    '.button--primary:hover is not misread as a definition of --primary');

  // Direct guard on the "::" (pseudo-element) rejection, independent of the
  // BEM prevChar guard above.
  const src2 = `; --weird::what { }`;
  const defs2 = extractDefinitions(cleanCss(src2));
  ok(!defs2.has('weird'), 'a name immediately followed by "::" (pseudo-element) is rejected');
}

{
  // Whitespace robustness inside var().
  const src = `.g { color: var(  --spaced  ,  blue  ); }`;
  const refs = extractReferences(cleanCss(src));
  ok(refs.some(r => r.name === 'spaced'), 'var( --spaced , blue ) with extra whitespace is still extracted');
}

{
  // Line-number accuracy.
  const src = `:root {\n  --a: red;\n}\n.h {\n  color: var(--undefined-thing);\n}\n`;
  const cleaned = cleanCss(src);
  const lineStarts = computeLineStarts(src);
  const refs = extractReferences(cleaned);
  const ref = refs.find(r => r.name === 'undefined-thing');
  ok(ref && lineNumberFor(lineStarts, ref.index) === 5,
    'line number is correctly computed for a reference several lines into the source');
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Discover every LOCAL stylesheet the app actually loads
// ─────────────────────────────────────────────────────────────────────────
section('1. Discover local stylesheets loaded by index.html');

const indexPath = path.join(ROOT, 'src/public/index.html');
const indexHtml = readFileSync(indexPath, 'utf8');

const disc1 = discoverStylesheetLinks(indexHtml);
const localCssFiles = disc1.local;

ok(disc1.styleTags.length > 0, 'index.html contains at least one <link rel="stylesheet"> tag');
ok(localCssFiles.includes('styles.css'), 'styles.css is discovered as a local stylesheet');
console.log(`  → local stylesheets found: ${localCssFiles.join(', ')}`);
console.log(`  → external stylesheets skipped: ${disc1.externalCount} (e.g. Google Fonts — not this app's token surface)`);

// ─────────────────────────────────────────────────────────────────────────
// 2. Extract definitions + references from every local stylesheet
// ─────────────────────────────────────────────────────────────────────────
section('2. Extract definitions and references from the real app CSS');

const publicDir = path.dirname(indexPath);
const initialFiles1 = localCssFiles.map(href => ({
  relPath: `src/public/${href}`,
  absPath: path.join(publicDir, href),
}));
const expanded1 = expandWithImports(initialFiles1);
const files = expanded1.files;
if (expanded1.skippedExternalImports.length) {
  console.log(`  → external @import target(s) skipped (not this app's token surface): ` +
    expanded1.skippedExternalImports.map(s => `${s.target} (from ${s.from})`).join(', '));
}
const importedOnly1 = files.filter(f => !initialFiles1.some(i => i.absPath === f.absPath));
if (importedOnly1.length) {
  console.log(`  → additional local file(s) discovered via @import: ${importedOnly1.map(f => f.relPath).join(', ')}`);
}
// A real broken/typo'd @import in shipping CSS is a real bug worth failing
// loudly on — expandWithImports no longer crashes on one (L5), but silently
// swallowing it would just trade one failure mode for another.
ok(expanded1.unreadableFiles.length === 0,
  expanded1.unreadableFiles.length === 0
    ? 'no @import target in the shipping app CSS failed to resolve to a readable file'
    : `${expanded1.unreadableFiles.length} @import target(s) in the shipping app CSS could not be read: ` +
      expanded1.unreadableFiles.map(u => `${u.relPath} (from ${u.from ?? 'index.html link'}) — ${u.error}`).join(', '));

const globalDefs = new Set();
const perFileData = [];

for (const f of files) {
  const raw = readFileSync(f.absPath, 'utf8');
  const cleaned = cleanCss(raw);
  const defs = extractDefinitions(cleaned);
  const refs = extractReferences(cleaned);
  const lineStarts = computeLineStarts(raw);
  for (const name of defs.keys()) globalDefs.add(name);
  perFileData.push({ ...f, raw, cleaned, defs, refs, lineStarts });
}

const totalDefs = globalDefs.size;
const totalRefs = perFileData.reduce((n, f) => n + f.refs.length, 0);

ok(totalDefs > 0, `found ${totalDefs} distinct custom-property definitions across ${files.length} file(s)`);
ok(totalRefs > 0, `found ${totalRefs} total var() references across ${files.length} file(s)`);
console.log(`  → defined tokens: ${[...globalDefs].sort().join(', ')}`);

// ─────────────────────────────────────────────────────────────────────────
// 3. Every referenced variable must be defined somewhere
// ─────────────────────────────────────────────────────────────────────────
section('3. Every var() reference resolves to a defined custom property');

// Pre-existing, already-in-production issues (see file header for full
// detail + provenance). Baselined by NAME so this suite stays green against
// the current codebase without hiding them — every run still prints them.
// A NEW undefined name (anything not in this exact list) is a hard failure.
// `--font-mono` and `--text-1` are DELIBERATELY NOT here — they were the two
// genuine no-fallback bugs and have been fixed in styles.css; section 3b
// below locks that fix in with a dedicated regression assertion instead of
// leaving them silently forgiven here.
const KNOWN_ISSUES = new Set([
  'text-primary',   // has a hex fallback; 2 refs
  'text-secondary', // has a hex fallback; 3 refs
  'surface-1',      // has a hex fallback; 1 ref
]);
ok(KNOWN_ISSUES.size === 3,
  'baseline contains exactly the three remaining fallback-carrying names (not the two already-fixed ones)');

const realOffenders = [];
const knownOffenders = [];

for (const f of perFileData) {
  for (const ref of f.refs) {
    if (globalDefs.has(ref.name)) continue; // defined somewhere — fine
    const line = lineNumberFor(f.lineStarts, ref.index);
    const declaration = f.raw.split('\n')[line - 1]?.trim() ?? '(unavailable)';
    const entry = { file: f.relPath, line, name: ref.name, declaration };
    if (KNOWN_ISSUES.has(ref.name)) knownOffenders.push(entry);
    else realOffenders.push(entry);
  }
}

if (knownOffenders.length > 0) {
  console.log(`\n  ⚠ ${knownOffenders.length} pre-existing (baselined) undefined-variable reference(s) — not new, not failing this suite:`);
  for (const o of knownOffenders) {
    console.log(`      ${o.file}:${o.line}  var(--${o.name})  →  ${o.declaration}`);
  }
}

ok(realOffenders.length === 0,
  realOffenders.length === 0
    ? 'no NEW undefined custom-property references found'
    : `found ${realOffenders.length} NEW undefined custom-property reference(s):\n` +
      realOffenders.map(o => `        ${o.file}:${o.line}  var(--${o.name})  →  ${o.declaration}`).join('\n')
);

// ─────────────────────────────────────────────────────────────────────────
// 3b. Regression lock — the two FIXED no-fallback bugs must never come back
// ─────────────────────────────────────────────────────────────────────────
// `--font-mono` and `--text-1` were undefined-with-NO-fallback references —
// the exact `--text-dim` silent-rendering-failure class — until styles.css
// was corrected (`--font-mono` → `--mono`, `--text-1` → `--text`). They are
// intentionally absent from KNOWN_ISSUES above, so without this explicit
// check a reintroduction would just land in the generic "new undefined
// variable" bucket in section 3. These two assertions name the exact
// regression so a failure is unmistakable.
const allRefs = perFileData.flatMap(f =>
  f.refs.map(r => ({ ...r, file: f.relPath, lineStarts: f.lineStarts }))
);
const fontMonoRefs = allRefs.filter(r => r.name === 'font-mono');
const text1Refs = allRefs.filter(r => r.name === 'text-1');

ok(fontMonoRefs.length === 0,
  fontMonoRefs.length === 0
    ? 'REGRESSION GUARD: var(--font-mono) is not referenced anywhere (the real token is --mono; this was the v3.0.12-class no-fallback bug)'
    : `REGRESSION: var(--font-mono) reintroduced at ${fontMonoRefs.map(r => `${r.file}:${lineNumberFor(r.lineStarts, r.index)}`).join(', ')} — the real token is --mono`
);
ok(text1Refs.length === 0,
  text1Refs.length === 0
    ? 'REGRESSION GUARD: var(--text-1) is not referenced anywhere (likely meant --text/--text-2; this was the v3.0.12-class no-fallback bug)'
    : `REGRESSION: var(--text-1) reintroduced at ${text1Refs.map(r => `${r.file}:${lineNumberFor(r.lineStarts, r.index)}`).join(', ')} — likely meant --text/--text-2`
);

// ─────────────────────────────────────────────────────────────────────────
// 3c. Self-tests for scanning var(--x) references embedded in JS source
//    (section 4 below applies this to the real src/public/app.js)
// ─────────────────────────────────────────────────────────────────────────
section('3c. Self-tests — var() references embedded in JS string/template literals');

{
  // The whole point of section 4 is to find var(--x) usages that live INSIDE
  // JS string/template literals (e.g. `status.innerHTML = 'color:var(--x)'`)
  // — unlike a real .css file, where "var(--x)" inside a quoted string is
  // decorative content to be ignored (maskStrings' job there). So the JS scan
  // deliberately does NOT run maskStrings/maskPlainUrls — only comment
  // stripping. This proves that choice: a reference inside a real JS
  // comment is excluded, but one inside a JS string literal is NOT masked
  // away (which full cleanCss() WOULD do, defeating the entire scan).
  const src = `
// var(--commented-out) should not count
status.innerHTML = 'color:var(--real-ref)';
/* var(--also-commented) should not count either */
const x = \`<span style="color:var(--template-ref)">\`;
`;
  const cleaned = stripLineComments(stripBlockComments(src));
  const refs = extractReferences(cleaned).map(r => r.name);
  ok(!refs.includes('commented-out'), 'a var() reference inside a JS // comment is not counted');
  ok(!refs.includes('also-commented'), 'a var() reference inside a JS /* */ comment is not counted');
  ok(refs.includes('real-ref'),
    'a var() reference inside a single-quoted JS string literal is still found (NOT masked — this is the point of scanning app.js)');
  ok(refs.includes('template-ref'),
    'a var() reference inside a JS template (backtick) literal is still found');
}

// ─────────────────────────────────────────────────────────────────────────
// 3d. Self-tests — extractAttr / discoverStylesheetLinks (quote-agnostic,
//    attribute-boundary-anchored <link> href/rel discovery)
// ─────────────────────────────────────────────────────────────────────────
// Audit-found gap: an earlier unanchored `href=["']...["']` pattern matched
// INSIDE `data-href="..."` (the substring `href="..."` is literally present
// there), and required quotes around both `rel` and `href` even though
// unquoted attribute values are valid HTML5. Both are real correctness
// bugs, not merely theoretical — the FIRST one is nastier: the reported
// file count went UP while actual coverage went DOWN (a decoy file gets
// scanned instead of the real one, and the scan still reports "found N
// stylesheets" as if nothing were wrong).
section('3d. Self-tests — extractAttr / discoverStylesheetLinks (quote-agnostic, boundary-anchored)');

{
  ok(extractAttr('<link rel="stylesheet" href="a.css">', 'href') === 'a.css',
    'extractAttr: double-quoted value');
  ok(extractAttr(`<link rel='stylesheet' href='a.css'>`, 'href') === 'a.css',
    'extractAttr: single-quoted value');
  ok(extractAttr('<link rel="stylesheet" href=a.css>', 'href') === 'a.css',
    'extractAttr: UNQUOTED value (valid HTML5) is still extracted');
  ok(extractAttr('<link rel="stylesheet" HREF="a.css">', 'href') === 'a.css',
    'extractAttr: attribute NAME matching is case-insensitive (HREF)');
  ok(extractAttr('<link data-href="decoy.css" rel="stylesheet" href="real.css">', 'href') === 'real.css',
    'extractAttr: "data-href" does NOT satisfy a lookup for "href" — the real href is found instead of the decoy');
  ok(extractAttr('<link x-href="decoy.css" rel="stylesheet" href="real.css">', 'href') === 'real.css',
    'extractAttr: "x-href" (any preceding word/hyphen char) also does not satisfy "href"');
  ok(extractAttr('<link rel="stylesheet">', 'href') === null,
    'extractAttr: returns null when the attribute is genuinely absent');
}

{
  // The exact audit-demonstrated shape: a decoy data-href BEFORE the real
  // href. The old code picked the decoy (wrong file scanned, no error).
  const html = `<link data-href="fallback.css" rel="stylesheet" href="probe.css">`;
  const d = discoverStylesheetLinks(html);
  ok(d.styleTags.length === 1, 'discoverStylesheetLinks: the <link> tag is recognised as rel=stylesheet');
  ok(d.local.length === 1 && d.local[0] === 'probe.css',
    'discoverStylesheetLinks: resolves to the REAL href ("probe.css"), not the decoy "fallback.css"');
}

{
  // Fully unquoted tag — both rel and href without quotes.
  const html = `<link rel=stylesheet href=probe-unquoted.css>`;
  const d = discoverStylesheetLinks(html);
  ok(d.styleTags.length === 1, 'discoverStylesheetLinks: an unquoted rel=stylesheet tag is still recognised');
  ok(d.local.length === 1 && d.local[0] === 'probe-unquoted.css',
    'discoverStylesheetLinks: an unquoted href is still discovered');
}

{
  // rel as a space-separated token list (e.g. a preload+stylesheet combo).
  const html = `<link rel="preload stylesheet" href="combo.css">`;
  const d = discoverStylesheetLinks(html);
  ok(d.local.includes('combo.css'), 'discoverStylesheetLinks: "stylesheet" is recognised as one token of a multi-token rel list');
}

{
  // Non-stylesheet <link> tags (icon, preconnect) must not be swept in.
  const html = `<link rel="icon" href="favicon.svg"><link rel="preconnect" href="https://fonts.gstatic.com">`;
  const d = discoverStylesheetLinks(html);
  ok(d.styleTags.length === 0 && d.local.length === 0,
    'discoverStylesheetLinks: non-stylesheet <link> tags (icon, preconnect) are correctly ignored');
}

{
  // External href (absolute, protocol-relative, data:) must be counted but
  // not returned as something we scan.
  const html = [
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Foo">`,
    `<link rel="stylesheet" href="//fonts.googleapis.com/css2?family=Bar">`,
    `<link rel="stylesheet" href="local.css">`,
  ].join('\n');
  const d = discoverStylesheetLinks(html);
  ok(d.styleTags.length === 3, 'discoverStylesheetLinks: all three <link> tags are recognised as stylesheets');
  ok(d.local.length === 1 && d.local[0] === 'local.css',
    'discoverStylesheetLinks: absolute-https and protocol-relative hrefs are excluded from `local`');
  ok(d.externalCount === 2, 'discoverStylesheetLinks: both external hrefs are counted in externalCount');
}

// ─────────────────────────────────────────────────────────────────────────
// 3d2. AUDIT ROUND 2 — L2 (value-collision) and L3 (tag-boundary
//    truncation on a quoted `>`), both closed by the sequential-tokenizer
//    rewrite of parseAttrs/extractAttr and the quote-aware outer tag regex.
// ─────────────────────────────────────────────────────────────────────────
section('3d2. Self-tests — audit round 2: attribute-value collisions and quoted ">" tag truncation');

{
  // L2: the audit's exact demonstrated shape — the text "href=DECOY.css"
  // appears INSIDE an unrelated attribute's quoted VALUE (title), not as a
  // real attribute. The v1 lookbehind fix only guarded against a hyphenated
  // NAME PREFIX (data-href); it did nothing about a name-shaped substring
  // sitting inside another attribute's value, because a flat regex scan has
  // no notion of "I already consumed this text as a value".
  const tag = '<link rel=stylesheet title="see href=DECOY.css" href="REAL.css">';
  ok(extractAttr(tag, 'href') === 'REAL.css',
    'L2: extractAttr is NOT fooled by "href=DECOY.css" appearing inside an unrelated attribute\'s quoted VALUE (title) — finds the real href="REAL.css"');
  ok(extractAttr(tag, 'title') === 'see href=DECOY.css',
    'L2: the title attribute\'s own value is still extracted correctly and in full (proves the fix is real tokenization, not just skipping href-shaped text)');
}

{
  // L2, single-quoted variant of the same collision.
  const tag = `<link rel=stylesheet title='see href=DECOY.css' href='REAL.css'>`;
  ok(extractAttr(tag, 'href') === 'REAL.css',
    "L2: the same value-collision guard holds for single-quoted attribute values");
}

{
  // L3: the audit's exact demonstrated shape — a `>` character appears
  // LITERALLY inside a quoted attribute value (valid HTML5; no escaping
  // required). The old outer regex `[^>]*` stopped at that `>`, truncating
  // the "tag" match before the real href attribute (which appears after
  // the truncation point) was ever reached — so the stylesheet silently
  // vanished from `local` with NO assertion firing.
  const html = '<link rel="stylesheet" title="a > b" href="REAL.css">';
  const d = discoverStylesheetLinks(html);
  ok(d.styleTags.length === 1,
    'L3: a `>` character embedded inside a quoted attribute value does not truncate the <link> tag match early — exactly one tag is found');
  ok(d.local.length === 1 && d.local[0] === 'REAL.css',
    'L3: the real href, which appears AFTER the embedded ">" in source order, is correctly discovered (was silently dropped before the fix — coverage lost with no error)');
}

{
  // L3, single-quoted variant, and a `>` inside the href's OWN value (not
  // just an unrelated attribute) to make sure the quote-aware match isn't
  // accidentally scoped to only non-target attributes.
  const html = `<link rel='stylesheet' title='x > y' href='a>b.css'>`;
  const d = discoverStylesheetLinks(html);
  ok(d.styleTags.length === 1 && d.local.length === 1 && d.local[0] === 'a>b.css',
    "L3: a `>` inside the href value itself (single-quoted) is preserved intact, not treated as the tag's closing bracket");
}

{
  // Combined L2+L3 stress: both collisions in the same tag, at once —
  // proves the two fixes compose rather than one masking a residual gap in
  // the other.
  const html = '<link data-href="early-decoy.css" rel="stylesheet" title="a > b, also href=late-decoy.css" href="REAL-COMBINED.css">';
  const d = discoverStylesheetLinks(html);
  ok(d.styleTags.length === 1 && d.local.length === 1 && d.local[0] === 'REAL-COMBINED.css',
    'L2+L3 combined: a name-prefix decoy, a value-embedded decoy, AND an embedded ">" in the same tag all fail to divert extraction from the real href');
}

{
  // NEW bypass attempt (not previously tried by the audit): a genuinely
  // DUPLICATE `href` attribute on the same tag — malformed HTML, but real
  // build tooling has been known to emit it. Real browsers resolve
  // duplicate attributes to the FIRST occurrence; parseAttrs must agree
  // (its `if (!attrs.has(name))` guard means first-wins), not silently
  // prefer whichever the regex engine happens to match last.
  ok(extractAttr('<link rel="stylesheet" href="first.css" href="second-should-be-ignored.css">', 'href') === 'first.css',
    'NEW: a duplicate href attribute resolves to the FIRST occurrence (matches real browser semantics), not the second');
}

{
  // NEW bypass attempt: a tag with NO genuine `rel` attribute at all, but a
  // decoy string that READS like `rel="stylesheet"` sitting inside an
  // unrelated attribute's value. Must NOT be classified as a stylesheet
  // link — the rel check must see there is no real `rel` attribute here.
  const html = '<link href="x.css" title="rel=&quot;stylesheet&quot; spoofed" data-note="not a real rel">';
  const d = discoverStylesheetLinks(html);
  ok(d.styleTags.length === 0 && d.local.length === 0,
    'NEW: a decoy "rel=stylesheet"-shaped string inside an unrelated attribute value does NOT make a tag with no genuine rel attribute count as a stylesheet link');
}

// ─────────────────────────────────────────────────────────────────────────
// 3e. Self-tests — findImportTargets / expandWithImports (@import following)
// ─────────────────────────────────────────────────────────────────────────
// Audit-found gap: a linked stylesheet's own `@import` was never followed,
// so an undefined var(--x) living ONLY in the imported file was invisible —
// not hypothetical: /next already ships tokens/fonts.css using @import
// (currently unlinked, but the shape is real and in this exact codebase).
section('3e. Self-tests — findImportTargets / expandWithImports (@import following)');

{
  ok(findImportTargets(`@import url("foo.css");`).includes('foo.css'),
    'findImportTargets: @import url("...") double-quoted');
  ok(findImportTargets(`@import url('foo.css');`).includes('foo.css'),
    "findImportTargets: @import url('...') single-quoted");
  ok(findImportTargets(`@import url(foo.css);`).includes('foo.css'),
    'findImportTargets: @import url(...) unquoted');
  ok(findImportTargets(`@import "foo.css";`).includes('foo.css'),
    'findImportTargets: bare @import "...' + '"; (no url())');
  ok(findImportTargets(`@import 'foo.css';`).includes('foo.css'),
    "findImportTargets: bare @import '...'; (no url())");
  ok(findImportTargets(`@import url("foo.css") screen;`).includes('foo.css'),
    'findImportTargets: a trailing media-query qualifier does not corrupt the extracted target');
  ok(findImportTargets(`/* @import url("commented.css"); */`).length === 0,
    'findImportTargets: an @import inside a /* */ comment is not extracted');
  ok(findImportTargets(`// @import url("commented.css");`).length === 0,
    'findImportTargets: an @import inside a // comment is not extracted');
  ok(findImportTargets(`.x { color: red; }`).length === 0,
    'findImportTargets: ordinary CSS with no @import yields nothing');
}

{
  ok(isExternalUrl('https://fonts.googleapis.com/x.css'), 'isExternalUrl: absolute https URL');
  ok(isExternalUrl('http://example.com/x.css'), 'isExternalUrl: absolute http URL');
  ok(isExternalUrl('//fonts.googleapis.com/x.css'), 'isExternalUrl: protocol-relative URL');
  ok(isExternalUrl('data:text/css;base64,Zm9v'), 'isExternalUrl: a data: URI');
  ok(!isExternalUrl('foo.css'), 'isExternalUrl: a plain relative path is NOT external');
  ok(!isExternalUrl('../shared/foo.css'), 'isExternalUrl: a relative parent-dir path is NOT external');
}

{
  // The exact audit-demonstrated shape, using REAL temp files (outside the
  // repo) so expandWithImports actually reads from disk, not from strings.
  const dir = mkdtempSync(path.join(tmpdir(), 'css-import-selftest-'));
  try {
    const entryPath = path.join(dir, 'entry.css');
    const leafPath = path.join(dir, 'leaf.css');
    writeFileSync(entryPath, `:root { --known: red; }\n@import url('leaf.css');\n.a { color: var(--known); }\n`);
    writeFileSync(leafPath, `.b { color: var(--only-in-leaf); }\n`);

    const { files, skippedExternalImports } = expandWithImports([{ relPath: 'entry.css', absPath: entryPath }]);
    ok(files.length === 2, 'expandWithImports: entry.css + its local @import (leaf.css) are both returned');
    ok(files.some(f => f.absPath === leafPath), 'expandWithImports: the imported file is present with a real absPath');
    ok(skippedExternalImports.length === 0, 'expandWithImports: no external imports were skipped (there are none here)');

    // Now prove the def/ref pipeline actually SEES the imported file's
    // reference — this is the end-to-end version of the audit's bypass.
    const allRefNames = new Set();
    for (const f of files) {
      const raw = readFileSync(f.absPath, 'utf8');
      for (const r of extractReferences(cleanCss(raw))) allRefNames.add(r.name);
    }
    ok(allRefNames.has('only-in-leaf'),
      'end-to-end: var(--only-in-leaf), defined ONLY inside the imported leaf.css, is now visible to the reference scan (the exact gap the audit found)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // Multi-hop chain (A imports B imports C) — proves the BFS actually
  // recurses rather than following only the first hop.
  const dir = mkdtempSync(path.join(tmpdir(), 'css-import-chain-'));
  try {
    const aPath = path.join(dir, 'a.css');
    const bPath = path.join(dir, 'b.css');
    const cPath = path.join(dir, 'c.css');
    writeFileSync(aPath, `@import url('b.css');\n`);
    writeFileSync(bPath, `@import url('c.css');\n`);
    writeFileSync(cPath, `.z { color: var(--deep-in-c); }\n`);
    const { files } = expandWithImports([{ relPath: 'a.css', absPath: aPath }]);
    ok(files.length === 3, 'expandWithImports: a 2-hop @import chain (A→B→C) is fully followed (3 files total)');
    ok(files.some(f => f.absPath === cPath), 'expandWithImports: the deepest file in the chain is reached');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // Cycle protection — A imports B, B imports A. Must terminate, not hang,
  // and must not duplicate A in the result.
  const dir = mkdtempSync(path.join(tmpdir(), 'css-import-cycle-'));
  try {
    const aPath = path.join(dir, 'a.css');
    const bPath = path.join(dir, 'b.css');
    writeFileSync(aPath, `@import url('b.css');\n.a { color: var(--in-a); }\n`);
    writeFileSync(bPath, `@import url('a.css');\n.b { color: var(--in-b); }\n`);
    const start = Date.now();
    const { files } = expandWithImports([{ relPath: 'a.css', absPath: aPath }]);
    const elapsedMs = Date.now() - start;
    ok(elapsedMs < 2000, `expandWithImports: an A↔B import cycle terminates promptly (${elapsedMs}ms), does not hang`);
    ok(files.length === 2, 'expandWithImports: a cycle does not duplicate files in the result (still exactly 2)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // External @import target must be skipped, not followed, not thrown on.
  const dir = mkdtempSync(path.join(tmpdir(), 'css-import-external-'));
  try {
    const entryPath = path.join(dir, 'entry.css');
    writeFileSync(entryPath,
      `@import url('https://fonts.googleapis.com/css2?family=Foo');\n.a { color: red; }\n`);
    const { files, skippedExternalImports } = expandWithImports([{ relPath: 'entry.css', absPath: entryPath }]);
    ok(files.length === 1, 'expandWithImports: an external @import target is not added to the followed-files list');
    ok(skippedExternalImports.length === 1 && skippedExternalImports[0].target.includes('fonts.googleapis.com'),
      'expandWithImports: the external @import is recorded in skippedExternalImports (not silently dropped)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 3e2. AUDIT ROUND 2 — L4 (modern @import forms) and L5 (string-literal
//    false positive crash + untrimmed target), all in findImportTargets /
//    expandWithImports.
// ─────────────────────────────────────────────────────────────────────────
section('3e2. Self-tests — audit round 2: modern @import forms, string-literal false positives, untrimmed targets, unreadable imports');

{
  // L4: cascade-layer and feature-query modifiers BEFORE the quoted target,
  // with no url(...) wrapper — the old regex required url(...) or a bare
  // quoted string to appear IMMEDIATELY after "@import ", so any modifier
  // token in front of the target made the whole match silently fail.
  ok(findImportTargets(`@import layer(base) "e.css";`).includes('e.css'),
    'L4: @import layer(base) "e.css"; is recognised (modifier before a bare quoted target)');
  ok(findImportTargets(`@import supports(display:grid) "g.css";`).includes('g.css'),
    'L4: @import supports(display:grid) "g.css"; is recognised (modifier before a bare quoted target)');
  ok(findImportTargets(`@import url(f.css) layer(base);`).includes('f.css'),
    'L4: @import url(f.css) layer(base); still works (modifier AFTER a url() target — was already passing, kept as a non-regression check)');
  ok(findImportTargets(`@import layer(base) url("h.css") screen;`).includes('h.css'),
    'L4: a layer(...) modifier before url(...) PLUS a trailing media qualifier all compose correctly');
}

{
  // L5a: the audit's exact demonstrated crash trigger — "@import" text
  // appearing inside an UNRELATED CSS string literal must not be read as a
  // real at-rule. Before the statement-position guard, this queued a
  // phantom "GHOST.css" target that crashed expandWithImports with an
  // uncaught ENOENT.
  ok(findImportTargets(`.x { content: "@import url(GHOST.css)"; }`).length === 0,
    'L5a: "@import ..." appearing inside a CSS string literal value (content: "...") is correctly rejected — not a real at-rule (statement-position guard)');
  ok(findImportTargets(`.y { content: '@import "SNEAKY.css"'; }`).length === 0,
    'L5a: same rejection for the single-quoted-string variant');
  // Legitimate @import immediately after a previous statement's ';' or a
  // block's '}' must still be recognised — the guard must not overreach.
  ok(findImportTargets(`@import "a.css";\n@import "b.css";`).length === 2,
    'L5a: the statement-position guard does not reject a legitimate SECOND @import following a ";"');
  ok(findImportTargets(`.z { color: red; }\n@import url("late.css");`).includes('late.css'),
    'L5a: an @import immediately after a "}" (closing a preceding rule) is still accepted');
}

{
  // L5b: an untrimmed target — extra whitespace between the filename and
  // the closing ")" in a bare (unquoted) url(...) form previously produced
  // a target string with a trailing space, which would never resolve to
  // the real file on disk.
  ok(findImportTargets(`@import url( i.css );`).includes('i.css'),
    'L5b: @import url( i.css ); (whitespace padding, no quotes) trims to "i.css", not "i.css " with a trailing space');
}

{
  // L5c: expandWithImports must not CRASH on a typo'd/phantom import
  // target that survives the statement-position guard (i.e. is a
  // genuinely well-formed but nonexistent @import) — it must record the
  // failure and continue, never throw.
  const dir = mkdtempSync(path.join(tmpdir(), 'css-import-phantom-'));
  try {
    const entryPath = path.join(dir, 'entry.css');
    writeFileSync(entryPath, `:root { --known: red; }\n@import url('does-not-exist.css');\n.a { color: var(--known); }\n`);
    let threw = false;
    let result;
    try {
      result = expandWithImports([{ relPath: 'entry.css', absPath: entryPath }]);
    } catch {
      threw = true;
    }
    ok(!threw, 'L5c: a typo\'d/phantom @import target does NOT crash expandWithImports (no uncaught exception)');
    ok(threw || (result.files.length === 1 && result.files[0].absPath === entryPath),
      'L5c: the phantom target is excluded from `files` (entry.css itself is still present and correctly the only entry)');
    ok(threw || (result.unreadableFiles.length === 1
        && result.unreadableFiles[0].absPath === path.join(dir, 'does-not-exist.css')
        && result.unreadableFiles[0].from === 'entry.css'),
      'L5c: the phantom target is recorded in `unreadableFiles` with its source file, not silently dropped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // L5c, second variant: the string-literal false-positive AND a phantom
  // import in the SAME file — proves the crash-prevention and the
  // statement-position guard compose (the string-literal text is rejected
  // before it ever reaches the read attempt; only the genuine @import is
  // attempted, and it is safely recorded as unreadable rather than thrown).
  const dir = mkdtempSync(path.join(tmpdir(), 'css-import-mixed-'));
  try {
    const entryPath = path.join(dir, 'entry.css');
    writeFileSync(entryPath,
      `.x { content: "@import url(GHOST.css)"; }\n@import url('also-phantom.css');\n.y { color: var(--known); }\n`);
    let threw = false;
    let result;
    try {
      result = expandWithImports([{ relPath: 'entry.css', absPath: entryPath }]);
    } catch {
      threw = true;
    }
    ok(!threw, 'L5c mixed: a string-literal false-positive alongside a real phantom import does not crash');
    ok(threw || (result.unreadableFiles.length === 1 && result.unreadableFiles[0].absPath === path.join(dir, 'also-phantom.css')),
      'L5c mixed: only the GENUINE @import target ("also-phantom.css") is recorded as unreadable — the string-literal text ("GHOST.css") never reached a read attempt at all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 3f. Self-tests — walkJsFiles (recursive /next JS discovery)
// ─────────────────────────────────────────────────────────────────────────
// Audit-found gap: the previous /next JS file list was two hardcoded
// locations (next/app.js + next/views/*.js) and silently never looked
// inside any other subdirectory — in production, next/shared/ existed and
// was invisible to this scan. walkJsFiles must recurse into an arbitrary
// nesting depth, not just one extra level.
section('3f. Self-tests — walkJsFiles (recursive /next JS discovery)');

{
  const dir = mkdtempSync(path.join(tmpdir(), 'walkjs-'));
  try {
    writeFileSync(path.join(dir, 'app.js'), '// top level\n');
    writeFileSync(path.join(dir, 'readme.md'), 'not js\n');
    const viewsDir = path.join(dir, 'views');
    mkdirSync(viewsDir);
    writeFileSync(path.join(viewsDir, 'a.js'), '// views/a\n');
    const sharedDir = path.join(dir, 'shared');
    mkdirSync(sharedDir);
    writeFileSync(path.join(sharedDir, 'b.js'), '// shared/b\n');
    // Two levels deep, to prove recursion isn't just "one extra directory".
    const nestedDir = path.join(sharedDir, 'nested');
    mkdirSync(nestedDir);
    writeFileSync(path.join(nestedDir, 'c.js'), '// shared/nested/c\n');

    const found = walkJsFiles(dir).map(p => path.relative(dir, p)).sort();
    ok(found.length === 4, `walkJsFiles: finds exactly the 4 real .js files (found ${found.length}: ${found.join(', ')})`);
    ok(found.includes('app.js'), 'walkJsFiles: top-level .js file found');
    ok(found.includes(path.join('views', 'a.js')), 'walkJsFiles: one-level-deep .js file found');
    ok(found.includes(path.join('shared', 'b.js')), 'walkJsFiles: a sibling directory not previously enumerated is found');
    ok(found.includes(path.join('shared', 'nested', 'c.js')),
      'walkJsFiles: TWO levels deep is still found — recursion is real, not a single extra hop');
    ok(!found.some(p => p.endsWith('readme.md')), 'walkJsFiles: non-.js files are excluded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Inline var(--x) references embedded in src/public/app.js (CSS-in-JS)
// ─────────────────────────────────────────────────────────────────────────
// app.js builds a handful of inline `style="color:var(--x)"` HTML snippets
// as JS string/template literals (status banners, the update-progress UI,
// the markdown renderer's <hr> rule). These live entirely outside
// styles.css's <link> discovery in section 1, so section 3 never sees them —
// a token typo here would fail SILENTLY exactly like the --text-dim bug,
// just in a JS file instead of a CSS one. We check them against the SAME
// `globalDefs` set collected from the real stylesheets in section 2 (the
// tokens app.js's inline styles rely on come from styles.css; app.js
// defines none of its own).
section('4. Inline var(--x) references in src/public/app.js (CSS-in-JS)');

const appJsPath = path.join(ROOT, 'src/public/app.js');
const appJsRaw = readFileSync(appJsPath, 'utf8');
const appJsCleaned = stripLineComments(stripBlockComments(appJsRaw));
const appJsRefs = extractReferences(appJsCleaned);
const appJsLineStarts = computeLineStarts(appJsRaw);

ok(appJsRefs.length > 0, `found ${appJsRefs.length} var() reference(s) in app.js`);

const appJsRealOffenders = [];
for (const ref of appJsRefs) {
  if (globalDefs.has(ref.name)) continue;
  const line = lineNumberFor(appJsLineStarts, ref.index);
  const declaration = appJsRaw.split('\n')[line - 1]?.trim() ?? '(unavailable)';
  appJsRealOffenders.push({ file: 'src/public/app.js', line, name: ref.name, declaration });
}

ok(appJsRealOffenders.length === 0,
  appJsRealOffenders.length === 0
    ? 'every var(--x) reference in app.js resolves to a token defined in styles.css'
    : `found ${appJsRealOffenders.length} undefined custom-property reference(s) in app.js:\n` +
      appJsRealOffenders.map(o => `        ${o.file}:${o.line}  var(--${o.name})  →  ${o.declaration}`).join('\n')
);

const appJsDistinctNames = [...new Set(appJsRefs.map(r => r.name))].sort();
console.log(`  → app.js references ${appJsRefs.length} var() usage(s) across ${appJsDistinctNames.length} distinct token(s): ${appJsDistinctNames.join(', ')}`);

// ─────────────────────────────────────────────────────────────────────────
// 5. Discover every LOCAL stylesheet the /next shell actually loads
// ─────────────────────────────────────────────────────────────────────────
// Mirrors section 1 exactly, but against src/public/next/index.html — the
// file list is DERIVED from the shell's own <link> tags, never hardcoded,
// so a new /next view's stylesheet that gets linked is covered
// automatically, and one that's added but never linked is (correctly)
// invisible here too, same as section 1's contract for the shipping app.
section('5. Discover local stylesheets loaded by next/index.html');

const nextIndexPath = path.join(ROOT, 'src/public/next/index.html');
const nextIndexHtml = readFileSync(nextIndexPath, 'utf8');

const disc5 = discoverStylesheetLinks(nextIndexHtml);
const nextLocalCssFiles = disc5.local;

function nextHrefToRel(href) {
  if (href.startsWith('/next/')) return href.slice('/next/'.length);
  if (href.startsWith('/')) return href.replace(/^\/+/, '');
  return href;
}

ok(disc5.styleTags.length > 0, 'next/index.html contains at least one <link rel="stylesheet"> tag');
// Compare NORMALISED names so this holds for both the historical relative
// form and the root-absolute form adopted in v3.6.1.
const nextLocalCssNames = nextLocalCssFiles.map(nextHrefToRel);
ok(nextLocalCssNames.includes('shell.css'), 'shell.css is discovered as a local /next stylesheet');
ok(nextLocalCssNames.includes('views/ingest.css'), 'views/ingest.css is discovered as a local /next stylesheet');
ok(!nextLocalCssFiles.includes('tokens/fonts.css'),
  'tokens/fonts.css is correctly NOT discovered (deliberately unlinked per v3.1.3 — self-hosting is pending; fonts-local.css stands in)');
console.log(`  → /next local stylesheets found (${nextLocalCssFiles.length}): ${nextLocalCssFiles.join(', ')}`);
console.log(`  → /next external stylesheets skipped: ${disc5.externalCount} (e.g. Google Fonts)`);

// ─────────────────────────────────────────────────────────────────────────
// 6. Extract definitions and references from the /next CSS universe
// ─────────────────────────────────────────────────────────────────────────
section('6. Extract definitions and references from the /next CSS universe');

const nextPublicDir = path.dirname(nextIndexPath);
// v3.6.1: next/index.html's refs became ROOT-ABSOLUTE (`/next/tokens/base.css`)
// so the shell resolves identically at /next/ and at / — see
// scripts/test-next-asset-paths.js for why that matters. A naive join then
// produced `src/public/next/next/tokens/...` and this scanner saw ZERO /next
// files. It failed loudly (a minimum-count assertion below), which is the only
// reason it was noticed — a scanner that silently measures nothing is this
// repo's recorded worst case. Normalise BOTH forms so either survives.

const nextInitialFiles = nextLocalCssFiles.map(href => {
  const rel = nextHrefToRel(href);
  return { relPath: `src/public/next/${rel}`, absPath: path.join(nextPublicDir, rel) };
});
const expanded6 = expandWithImports(nextInitialFiles);
const nextFiles = expanded6.files;
if (expanded6.skippedExternalImports.length) {
  console.log(`  → /next external @import target(s) skipped (not this app's token surface): ` +
    expanded6.skippedExternalImports.map(s => `${s.target} (from ${s.from})`).join(', '));
}
ok(expanded6.unreadableFiles.length === 0,
  expanded6.unreadableFiles.length === 0
    ? 'no @import target in the /next CSS failed to resolve to a readable file'
    : `${expanded6.unreadableFiles.length} @import target(s) in /next CSS could not be read: ` +
      expanded6.unreadableFiles.map(u => `${u.relPath} (from ${u.from ?? 'next/index.html link'}) — ${u.error}`).join(', '));
const importedOnly6 = nextFiles.filter(f => !nextInitialFiles.some(i => i.absPath === f.absPath));
if (importedOnly6.length) {
  console.log(`  → /next additional local file(s) discovered via @import: ${importedOnly6.map(f => f.relPath).join(', ')}`);
}

const nextGlobalDefs = new Set();
const nextPerFileData = [];

for (const f of nextFiles) {
  const raw = readFileSync(f.absPath, 'utf8');
  const cleaned = cleanCss(raw);
  const defs = extractDefinitions(cleaned);
  const refs = extractReferences(cleaned);
  const lineStarts = computeLineStarts(raw);
  for (const name of defs.keys()) nextGlobalDefs.add(name);
  nextPerFileData.push({ ...f, raw, cleaned, defs, refs, lineStarts });
}

const nextTotalDefs = nextGlobalDefs.size;
const nextTotalRefs = nextPerFileData.reduce((n, f) => n + f.refs.length, 0);

ok(nextTotalDefs > 0, `found ${nextTotalDefs} distinct custom-property definitions across ${nextFiles.length} /next file(s)`);
ok(nextTotalRefs > 0, `found ${nextTotalRefs} total var() references across ${nextFiles.length} /next file(s)`);
console.log(`  → /next defined tokens (${nextTotalDefs}): ${[...nextGlobalDefs].sort().join(', ')}`);

// ─────────────────────────────────────────────────────────────────────────
// 6b. The /next token universe is NOT merged with the shipping app's
// ─────────────────────────────────────────────────────────────────────────
// If the two universes were unioned, a var() genuinely undefined in one
// could silently resolve via a same-named definition in the other —
// defeating the point of scanning them at all. Rather than assert this
// against hardcoded names (which would rot as either token set evolves),
// find a name that is REALLY defined in exactly one universe at scan time
// and confirm the two independently-built Sets agree; this can only pass
// if the two scans stayed genuinely separate.
section("6b. The /next token universe is NOT merged with the shipping app's");

const oldOnlyName = [...globalDefs].find(n => !nextGlobalDefs.has(n));
const nextOnlyName = [...nextGlobalDefs].find(n => !globalDefs.has(n));

ok(!!oldOnlyName, `found a token defined ONLY in the shipping app (e.g. --${oldOnlyName}) to test separation against`);
ok(!!nextOnlyName, `found a token defined ONLY in /next (e.g. --${nextOnlyName}) to test separation against`);
ok(!!oldOnlyName && !nextGlobalDefs.has(oldOnlyName),
  `--${oldOnlyName} (shipping-app-only) is correctly ABSENT from the /next definition set — the universes are not merged`);
ok(!!nextOnlyName && !globalDefs.has(nextOnlyName),
  `--${nextOnlyName} (/next-only) is correctly ABSENT from the shipping-app definition set — the universes are not merged`);

// A concrete real-world case this separation protects, found while building
// this section: /next's tokens/typography.css defines its OWN --font-mono
// (a real font stack) and /next JS legitimately references it
// (views/shared.js — checked in section 8). The SHIPPING app also once had
// a var(--font-mono) bug (section 3b's regression guard) but its real token
// is --mono — --font-mono is undefined there. Merge the two universes and
// that distinction disappears; kept separate, each reference is checked
// against only the definitions that actually apply to it.
ok(nextGlobalDefs.has('font-mono'),
  '--font-mono is a real, defined token in the /next universe (tokens/typography.css) — used legitimately by /next JS (views/shared.js)');
ok(!globalDefs.has('font-mono'),
  '--font-mono is NOT defined in the shipping-app universe (its real token is --mono) — proving the two universes must be checked separately, not unioned');

// ─────────────────────────────────────────────────────────────────────────
// 7. Every var() reference in /next CSS resolves within the /next universe
// ─────────────────────────────────────────────────────────────────────────
section('7. Every var() reference in /next CSS resolves to a /next-defined custom property');

// One pre-existing, already-in-production /next finding, verified BEFORE
// baselining it (per CLAUDE.md: "never add a variable to the CSS-token
// baseline to make the suite pass" without checking whether it should
// simply be defined instead). `--scrim` (shell.css:337) carries a working
// rgba(5,5,10,0.68) fallback, and the light-theme override three lines
// below (shell.css:343) replaces the WHOLE `background` declaration
// directly rather than going through the var — so the fallback is the
// only value ever actually used, in either theme. This suite does not own
// shell.css (it is out of scope for this task), so it is baselined by name
// exactly like section 3's three shipping-app entries, rather than "fixed"
// here. Any NEW undefined name in /next CSS is still a hard failure.
const NEXT_KNOWN_ISSUES = new Set([
  'scrim', // rgba(...) fallback; shell.css:337; light theme bypasses it entirely (shell.css:343)
]);
ok(NEXT_KNOWN_ISSUES.size === 1,
  'baseline contains exactly the one known /next fallback-carrying name (--scrim)');

const nextRealOffenders = [];
const nextKnownOffenders = [];

for (const f of nextPerFileData) {
  for (const ref of f.refs) {
    if (nextGlobalDefs.has(ref.name)) continue; // defined somewhere in /next — fine
    const line = lineNumberFor(f.lineStarts, ref.index);
    const declaration = f.raw.split('\n')[line - 1]?.trim() ?? '(unavailable)';
    const entry = { file: f.relPath, line, name: ref.name, declaration };
    if (NEXT_KNOWN_ISSUES.has(ref.name)) nextKnownOffenders.push(entry);
    else nextRealOffenders.push(entry);
  }
}

if (nextKnownOffenders.length > 0) {
  console.log(`\n  ⚠ ${nextKnownOffenders.length} pre-existing (baselined) undefined-variable reference(s) in /next — not new, not failing this suite:`);
  for (const o of nextKnownOffenders) {
    console.log(`      ${o.file}:${o.line}  var(--${o.name})  →  ${o.declaration}`);
  }
}

// Named positive assertion the baseline pattern requires: confirms the
// baselined --scrim really is the ONLY undefined /next CSS reference today,
// so a second, DIFFERENT undefined name can't silently hide behind this one
// baseline entry (the same discipline section 3's header describes being
// added after that suite was audited for exactly this gap).
ok(nextKnownOffenders.length === 1 && nextKnownOffenders[0].name === 'scrim',
  'the only baselined /next reference is --scrim, and it is at the known location (shell.css)');

ok(nextRealOffenders.length === 0,
  nextRealOffenders.length === 0
    ? 'no NEW undefined custom-property references found in /next CSS'
    : `found ${nextRealOffenders.length} NEW undefined custom-property reference(s) in /next CSS:\n` +
      nextRealOffenders.map(o => `        ${o.file}:${o.line}  var(--${o.name})  →  ${o.declaration}`).join('\n')
);

// ─────────────────────────────────────────────────────────────────────────
// 8. Inline var(--x) references in /next JS files (CSS-in-JS)
// ─────────────────────────────────────────────────────────────────────────
// The /next views build HTML strings with inline `style="...var(--x)..."`
// attributes — the same CSS-in-JS shape section 4 covers for the shipping
// app's app.js — entirely outside the <link> discovery in section 5, so
// section 7 never sees them. Checked against nextGlobalDefs (the /next
// universe defined in section 6), NOT globalDefs (the shipping app) — see
// section 6b for why that separation matters. The file list is discovered
// by WALKING the entire src/public/next/ tree for *.js files (walkJsFiles),
// not by enumerating known subdirectories, so a new sibling directory (like
// next/shared/, introduced in this very release) is covered automatically
// instead of requiring this scanner to be told its name — an earlier
// version hardcoded exactly two locations (next/app.js + next/views/*.js)
// and was audit-found to silently never look inside next/shared/**, where
// ingest-queue-logic.js's inline var(--x) usages live.
section('8. Inline var(--x) references in /next JS files (CSS-in-JS)');

const nextRootDir = path.join(ROOT, 'src/public/next');
const nextJsFiles = walkJsFiles(nextRootDir)
  .map(abs => path.relative(ROOT, abs).split(path.sep).join('/'))
  .sort();

ok(nextJsFiles.length > 1, `discovered ${nextJsFiles.length} /next JS files to scan (app.js + views/*.js + shared/*.js)`);
ok(nextJsFiles.includes('src/public/next/shared/ingest-queue-logic.js'),
  'the recursive /next JS walk reaches next/shared/ingest-queue-logic.js (not just app.js + views/)');

let nextJsTotalRefs = 0;
const nextJsRealOffenders = [];
const nextJsDistinctNames = new Set();

for (const relPath of nextJsFiles) {
  const absPath = path.join(ROOT, relPath);
  const raw = readFileSync(absPath, 'utf8');
  const cleaned = stripLineComments(stripBlockComments(raw));
  const refs = extractReferences(cleaned);
  const lineStarts = computeLineStarts(raw);
  nextJsTotalRefs += refs.length;
  for (const ref of refs) {
    nextJsDistinctNames.add(ref.name);
    if (nextGlobalDefs.has(ref.name)) continue;
    const line = lineNumberFor(lineStarts, ref.index);
    const declaration = raw.split('\n')[line - 1]?.trim() ?? '(unavailable)';
    nextJsRealOffenders.push({ file: relPath, line, name: ref.name, declaration });
  }
}

ok(nextJsTotalRefs > 0, `found ${nextJsTotalRefs} var() reference(s) across /next JS files`);
ok(nextJsRealOffenders.length === 0,
  nextJsRealOffenders.length === 0
    ? 'every var(--x) reference in /next JS files resolves to a token defined in the /next CSS universe'
    : `found ${nextJsRealOffenders.length} undefined custom-property reference(s) in /next JS files:\n` +
      nextJsRealOffenders.map(o => `        ${o.file}:${o.line}  var(--${o.name})  →  ${o.declaration}`).join('\n')
);

console.log(`  → /next JS files reference ${nextJsTotalRefs} var() usage(s) across ${nextJsDistinctNames.size} distinct token(s): ${[...nextJsDistinctNames].sort().join(', ')}`);

// ─────────────────────────────────────────────────────────────────────────
// 9. Every /next stylesheet on disk is actually REACHABLE from the shell
// ─────────────────────────────────────────────────────────────────────────
// THE GAP THIS CLOSES (v3.9.1). shared/progress-ring.css shipped in v3.9.0
// written, correct, and NEVER <link>ed. Both views that render the ring
// (views/ingest.js and views/domains.js) therefore painted raw markup for a
// whole release: SVG `stroke` defaults to `none` and `fill` to black, so
// browser-measured the live result was track stroke none, fill stroke none,
// orbit animation `none / 0s`, and the only painted element a black dot,
// invisible on the dark surface — with `.pring`/`.pring-text` falling back
// to `display: inline` so label and sublabel glued into one run. A user
// reported it. No guard caught it, and the reason is the important part:
//
//   - Section 5 above discovers /next stylesheets ONLY from index.html's
//     <link> tags, so a file that is never linked is never scanned. Its own
//     comment called that blind spot correct ("one that's added but never
//     linked is (correctly) invisible here too") — true for section 5's
//     token-scanning purpose, but it meant NOTHING in the tree asked the
//     other question: should it have been linked?
//   - test-next-asset-paths.js greps index.html and validates the refs that
//     ARE present. It cannot see one that is ABSENT. Same blind spot as the
//     19th asset ref v3.9.0 recorded, pointed the other way.
//
// Both guards validated PRESENT things. This one is a DIFF, so it can fail
// on an ABSENCE, which is the only shape that catches this class.
//
// The on-disk set is WALKED (walkCssFiles), never hardcoded — a hardcoded
// list cannot detect a file nobody remembered to name. The reachable set is
// `nextFiles` from section 6, i.e. linked-from-index.html PLUS everything
// transitively @imported, so a stylesheet pulled in by an @import counts as
// reachable and is not falsely reported.
section('9. Every /next stylesheet on disk is reachable from next/index.html');

// The ONLY permitted unreachable stylesheets. Every entry needs a reason,
// and both directions are asserted below: an entry that no longer exists,
// or that has since become reachable, FAILS — so this list cannot quietly
// rot into a licence for the next unlinked file.
const NEXT_ALLOWED_UNLINKED = new Map([
  ['src/public/next/tokens/fonts.css',
    'deliberately unlinked since v3.1.3 — it @imports Google Fonts and this ' +
    'local-first app does not phone home on page load; tokens/fonts-local.css ' +
    'stands in until the webfonts are self-hosted. Kept on disk so nothing ' +
    'from the design bundle is lost.'],
]);

const nextCssOnDisk = walkCssFiles(nextRootDir)
  .map(abs => path.relative(ROOT, abs).split(path.sep).join('/'))
  .sort();
const nextReachable = new Set(nextFiles.map(f => f.relPath));

ok(nextCssOnDisk.length > 1,
  `walked the /next tree and found ${nextCssOnDisk.length} stylesheet(s) on disk`);
// Positive control: the walk must actually reach the non-views subdirectory
// the v3.9.0 defect lived in. Without this, a walker that silently only
// looked at views/ would report "0 unreachable" and look green.
ok(nextCssOnDisk.includes('src/public/next/shared/progress-ring.css'),
  'the /next CSS walk reaches shared/progress-ring.css (not just tokens/ + views/)');

const nextUnreachable = nextCssOnDisk.filter(rel => !nextReachable.has(rel));
const nextUnexpectedUnlinked = nextUnreachable.filter(rel => !NEXT_ALLOWED_UNLINKED.has(rel));

ok(nextUnexpectedUnlinked.length === 0,
  nextUnexpectedUnlinked.length === 0
    ? `every /next stylesheet on disk is reachable from next/index.html (${nextReachable.size} reachable; ` +
      `${nextUnreachable.length} deliberately unlinked and allow-listed)`
    : `${nextUnexpectedUnlinked.length} /next stylesheet(s) exist on disk but are NEVER LOADED by the shell — ` +
      `any rule they contain is dead, and any element depending on them renders unstyled in the browser ` +
      `(this is exactly the v3.9.0 progress-ring defect). Add a <link> to src/public/next/index.html, or, ` +
      `if the file is deliberately unlinked, add it to NEXT_ALLOWED_UNLINKED with a reason:\n` +
      nextUnexpectedUnlinked.map(f => `        ${f}`).join('\n'));

// The allow-list must stay honest in BOTH directions.
const nextStaleAllowEntries = [...NEXT_ALLOWED_UNLINKED.keys()]
  .filter(rel => !nextCssOnDisk.includes(rel));
ok(nextStaleAllowEntries.length === 0,
  nextStaleAllowEntries.length === 0
    ? 'every NEXT_ALLOWED_UNLINKED entry still exists on disk (no stale exemptions)'
    : `NEXT_ALLOWED_UNLINKED names ${nextStaleAllowEntries.length} file(s) that no longer exist — ` +
      `delete the entry: ${nextStaleAllowEntries.join(', ')}`);

const nextRedundantAllowEntries = [...NEXT_ALLOWED_UNLINKED.keys()]
  .filter(rel => nextReachable.has(rel));
ok(nextRedundantAllowEntries.length === 0,
  nextRedundantAllowEntries.length === 0
    ? 'no NEXT_ALLOWED_UNLINKED entry is actually linked (the exemption list grants nothing it need not)'
    : `NEXT_ALLOWED_UNLINKED exempts ${nextRedundantAllowEntries.length} file(s) that ARE now linked — ` +
      `delete the entry so the exemption cannot mask a future unlink: ${nextRedundantAllowEntries.join(', ')}`);

// Named regression assertion for the exact file this section was written
// for. The generic diff above already covers it, but a dedicated failure
// message means a future unlink reports the ring by name rather than
// landing in an anonymous bucket — the same treatment section 3 gives
// --font-mono / --text-1.
ok(nextReachable.has('src/public/next/shared/progress-ring.css'),
  'REGRESSION GUARD (v3.9.1): shared/progress-ring.css is loaded by next/index.html — ' +
  'without it the two-layer progress ring renders as unstyled SVG (no strokes, no orbit ' +
  'animation, label and sublabel glued together) in BOTH views/ingest.js and views/domains.js');

// Report the two kinds of unreachable SEPARATELY. An earlier version of this
// line printed nextUnreachable.length as "allow-listed", which on the
// mutation run announced "2 allow-listed unlinked" while one of the two was
// the unexplained failure — a summary line that understates the problem it
// sits next to is the same shape as the v3.9.0 confirm dialog that said
// "1 page will be deleted" and deleted 2.
{
  const allowed = nextUnreachable.filter(rel => NEXT_ALLOWED_UNLINKED.has(rel));
  console.log(`  → /next stylesheets: ${nextCssOnDisk.length} on disk, ${nextReachable.size} reachable, ` +
    `${allowed.length} allow-listed unlinked${allowed.length ? ` (${allowed.join(', ')})` : ''}` +
    (nextUnexpectedUnlinked.length
      ? `, ${nextUnexpectedUnlinked.length} UNEXPLAINED (${nextUnexpectedUnlinked.join(', ')})`
      : ''));
}

// ─────────────────────────────────────────────────────────────────────────
// 9b. Self-test — the reachability diff can actually FAIL
// ─────────────────────────────────────────────────────────────────────────
// Section 9 reports a count of zero when things are healthy, which is
// indistinguishable from a check that never looked. This drives the SAME
// two functions section 9 uses (discoverStylesheetLinks + walkCssFiles)
// over a synthetic tree that contains a deliberately-unlinked stylesheet,
// and asserts it is found — an over-bound control proving the corpus CAN
// go red, per this repo's standing rule after v3.0.15's baseline incident.
section('9b. Self-test — the unreachable-stylesheet diff can actually fail');

{
  const dir = mkdtempSync(path.join(tmpdir(), 'cssreach-'));
  try {
    mkdirSync(path.join(dir, 'shared'));
    mkdirSync(path.join(dir, 'views'));
    writeFileSync(path.join(dir, 'linked.css'), '.a{color:red}\n');
    writeFileSync(path.join(dir, 'views', 'view.css'), '.b{color:red}\n');
    // The defect shape: present on disk, never linked, in a subdirectory.
    writeFileSync(path.join(dir, 'shared', 'orphan.css'), '.c{color:red}\n');
    writeFileSync(path.join(dir, 'index.html'),
      '<link rel="stylesheet" href="/next/linked.css">' +
      '<link rel="stylesheet" href="/next/views/view.css">');

    const walked = walkCssFiles(dir).map(p => path.relative(dir, p).split(path.sep).join('/')).sort();
    const linked = discoverStylesheetLinks(readFileSync(path.join(dir, 'index.html'), 'utf8'))
      .local.map(nextHrefToRel);
    const unreachable = walked.filter(rel => !linked.includes(rel));

    ok(walked.length === 3, `self-test: the walk finds all 3 stylesheets on disk (found ${walked.length})`);
    ok(unreachable.length === 1,
      `self-test: exactly 1 stylesheet is detected as unreachable (found ${unreachable.length}) — the diff is NOT a no-op`);
    ok(unreachable[0] === 'shared/orphan.css',
      'self-test: the unreachable file is correctly identified as shared/orphan.css');
    ok(!unreachable.includes('views/view.css') && !unreachable.includes('linked.css'),
      'self-test: linked stylesheets are NOT falsely reported as unreachable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 10. No /next rule freezes a font size in px (the text-scale control)
// ─────────────────────────────────────────────────────────────────────────
// THE GAP THIS CLOSES. Settings > General ships a user-adjustable text size.
// It is implemented as ONE multiplier, `--font-scale`, applied inside the
// `--text-*` ramp in tokens/typography.css and written only by app.js's
// applyFontScale(). Everything that reads a ramp token therefore resizes in
// the same frame; anything that writes `font-size: 14.5px` is frozen at 1x.
//
// The failure is SILENT and asymmetric with the rest of this suite: an
// undefined var() at least makes the declaration invalid, whereas a px
// literal is perfectly valid CSS that simply ignores the feature. Nothing
// errors, nothing logs, and the control still visibly "works" — because the
// rail, the titles and most chrome DO scale. So the app looks responsive to
// the setting while the specific thing the user enlarged the text to read
// does not move.
//
// An audit found 23 such rules across /next, 14 of them in views/chat.css —
// including `.chat-answer` and `.chat-bubble`, i.e. the most-read text in
// the application, and `.chat-input`, what the user types into. All 14 are
// now on the ramp; this section stops them coming back.
//
// SHAPE: a per-file CEILING, not an exact-match baseline. views/chat.css is
// pinned at zero. The five remaining rules live in files this change does
// not own, so they are recorded with the count they had and asserted as an
// upper bound: another agent FIXING one lowers the count and stays green
// (an exact-match baseline would go red on somebody else's improvement,
// which trains people to edit the baseline), while any regression raises it
// and fails. A slack ceiling is reported so it can be tightened.
//
// Both `font-size: Npx` AND the `font:` shorthand (`font: 500 9px/15px ...`)
// are detected — the shorthand is the obvious way a px size would come back
// past a guard that only knew the longhand, and two live examples of it
// already exist in the tree.
section('10. No /next rule freezes a font size in px (defeats the text-scale control)');

/** Every frozen px font size in a stylesheet. Runs on CLEANED css, so a px
 *  size QUOTED IN A COMMENT — and this tree has several, e.g. chat.css's
 *  own note about what a rule "was" — is correctly not a finding.
 *  cleanCss preserves offsets and newlines, so line numbers are the real
 *  ones in the file on disk. Returns [{ line, prop, value }].
 */
function findFrozenFontSizes(rawCss) {
  const cleaned = cleanCss(rawCss);
  const lineStarts = computeLineStarts(cleaned);
  // Anchored at a declaration boundary so `font-family:` and a stray `font`
  // inside a selector cannot match. `font-size` is listed first so the
  // alternation prefers it where both could apply.
  const re = /(?:^|[{};])\s*(font-size|font)\s*:\s*([^;}]*)/g;
  const out = [];
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const [, prop, value] = m;
    if (/(?:^|[^a-zA-Z0-9_.-])\d*\.?\d+px/.test(value)) {
      // Report the line of the PROPERTY, not of m.index — the match is
      // anchored on the preceding `{` or `;`, which in a multi-line rule
      // sits on the line ABOVE the declaration. Caught by the self-test
      // below, which is the only reason this is right.
      const propAt = m.index + m[0].indexOf(prop);
      out.push({ line: lineNumberFor(lineStarts, propAt), prop, value: value.trim() });
    }
  }
  return out;
}

// ── 10a. Self-tests: the detector fires, and does not over-fire ──────────
// Section 10's healthy answer for chat.css is "0 findings", which is exactly
// what a detector that never looked also reports. These synthetic cases are
// the positive control (this repo's standing rule after v3.0.15 baselined
// away the two names it was written to catch).
{
  const fires = [
    ['.a{font-size:14.5px}',            'font-size longhand, fractional'],
    ['.a{font-size: 10px;}',            'font-size longhand, integer'],
    ['.a{ font: 500 9px/15px mono; }',  'font shorthand (a guard that only knew the longhand would miss this)'],
    ['.a{color:red;font-size:12px;}',   'second declaration in a rule'],
    ['.a{font-size:9.5px}',             'a size below the ramp floor is still frozen'],
  ];
  for (const [css, why] of fires) {
    ok(findFrozenFontSizes(css).length === 1, `self-test: DETECTS a frozen px size — ${why}`);
  }

  const quiet = [
    ['.a{font-size:var(--text-base)}',        'a ramp token is the fix, not a finding'],
    ['.a{font-size:0.92em}',                  'em is relative to a scaled parent, so it scales'],
    ['.a{font:var(--type-body)}',             'the composed role reads the ramp'],
    ['.a{font-family:var(--font-mono)}',      'font-family is not a size'],
    ['/* was 14.5px before the ramp */\n.a{font-size:var(--text-base)}',
                                              'a px size quoted in a COMMENT is not a finding'],
    ['.a{padding:0 5px;border-radius:2px}',   'px elsewhere in the rule is untouched (only sizes scale)'],
    ['.a{font-size:100%}',                    'percentage inherits the scaled parent'],
  ];
  for (const [css, why] of quiet) {
    ok(findFrozenFontSizes(css).length === 0, `self-test: does NOT over-fire — ${why}`);
  }

  // The line number must be the real one, or a failure message sends the
  // next reader to the wrong rule.
  const located = findFrozenFontSizes('.a{color:red}\n\n.b{\n  font-size: 13px;\n}');
  ok(located.length === 1 && located[0].line === 4,
    `self-test: reports the real line number (got ${located.length === 1 ? located[0].line : 'no finding'}, expected 4)`);
}

// ── 10b. The real /next tree ────────────────────────────────────────────
// Ceilings for the files this change does not own. Each needs a reason.
const FROZEN_PX_CEILING = new Map([
  ['src/public/next/shell.css', {
    max: 3,
    note: 'reader chrome + the sidebar count badge (2 font-size, 1 font shorthand) — ' +
          'shell.css is not this change\'s file; same fix, separate change.' }],
  ['src/public/next/views/shared.css', {
    max: 2,
    note: 'Shared Brain card repo line + one font shorthand.' }],
  ['src/public/next/views/sync.css', {
    max: 2,
    note: 'Sync repo/status lines at 12.5px.' }],
]);

const frozenByFile = new Map();
for (const abs of walkCssFiles(nextRootDir)) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const found = findFrozenFontSizes(readFileSync(abs, 'utf8'));
  if (found.length) frozenByFile.set(rel, found);
}

// The file this change owns: ZERO, no ceiling, no exemption.
const CHAT_CSS = 'src/public/next/views/chat.css';
{
  const found = frozenByFile.get(CHAT_CSS) || [];
  ok(found.length === 0,
    found.length === 0
      ? `views/chat.css has NO frozen px font size — every size there is on the --text-* ramp, ` +
        `so Settings > General's text-size control reaches the chat answer, the user's own ` +
        `message bubble and the composer input`
      : `views/chat.css has ${found.length} frozen px font size(s). Each one IGNORES the ` +
        `Settings > General text-size control — the rule renders at 1x no matter what the user ` +
        `picks, silently and with no error. Use the nearest --text-* step from ` +
        `tokens/typography.css:\n` +
        found.map(f => `        line ${f.line}: ${f.prop}: ${f.value}`).join('\n'));
}

// Named regression guards for the two rules that make this feature matter.
// The zero-count assertion above already covers them; a dedicated message
// means a regression names the offender instead of landing in a bucket —
// the treatment sections 3 and 9 give --font-mono and progress-ring.css.
{
  const chatCss = readFileSync(path.join(ROOT, CHAT_CSS), 'utf8');
  const ruleSize = (selector) => {
    // Read the declared font-size out of one rule, from cleaned CSS so a
    // commented-out copy of the rule cannot satisfy this.
    const cleaned = cleanCss(chatCss);
    const at = cleaned.indexOf(selector + ' {');
    if (at === -1) return null;
    const close = cleaned.indexOf('}', at);
    const m = /font-size\s*:\s*([^;}]+)/.exec(cleaned.slice(at, close));
    return m ? m[1].trim() : null;
  };
  ok(ruleSize('.chat-answer') === 'var(--text-base)',
    `REGRESSION GUARD: .chat-answer reads var(--text-base), not a px literal — it is the ` +
    `most-read text in the app and was frozen at 14.5px, so enlarging the text resized the ` +
    `rail and the titles and left the ANSWER unchanged (got: ${ruleSize('.chat-answer')})`);
  ok(ruleSize('.chat-bubble') === 'var(--text-base)',
    `REGRESSION GUARD: .chat-bubble reads var(--text-base), not a px literal — the user's own ` +
    `message must scale with the answer it sits above (got: ${ruleSize('.chat-bubble')})`);
}

// Everyone else: an upper bound, plus honesty in the other direction.
{
  const overCeiling = [];
  const slackCeiling = [];
  for (const [rel, found] of frozenByFile) {
    if (rel === CHAT_CSS) continue;
    const entry = FROZEN_PX_CEILING.get(rel);
    if (!entry) { overCeiling.push(`${rel}: ${found.length} frozen (no ceiling recorded)`); continue; }
    if (found.length > entry.max) {
      overCeiling.push(`${rel}: ${found.length} frozen, ceiling ${entry.max} — ` +
        found.map(f => `line ${f.line}`).join(', '));
    }
  }
  for (const [rel, entry] of FROZEN_PX_CEILING) {
    const n = (frozenByFile.get(rel) || []).length;
    if (n < entry.max) slackCeiling.push(`${rel}: ${n} of ${entry.max}`);
  }

  ok(overCeiling.length === 0,
    overCeiling.length === 0
      ? `no /next stylesheet exceeds its frozen-px ceiling ` +
        `(${FROZEN_PX_CEILING.size} file(s) carry known, pre-existing frozen sizes)`
      : `${overCeiling.length} /next stylesheet(s) gained a frozen px font size. A px literal ` +
        `cannot be resized by Settings > General's text-size control. Use a --text-* step, or ` +
        `raise the ceiling here with a reason:\n` +
        overCeiling.map(s => `        ${s}`).join('\n'));

  // A ceiling nobody needs any more is a licence for the next regression.
  // Reported, deliberately NOT a failure: these files are owned by other
  // changes, and a suite that goes red when a colleague FIXES something
  // teaches people to edit baselines rather than read them.
  if (slackCeiling.length) {
    console.log(`  ⚠ frozen-px ceiling is now slack (tighten it): ${slackCeiling.join('; ')}`);
  }

  const totalFrozen = [...frozenByFile.values()].reduce((a, f) => a + f.length, 0);
  console.log(`  → /next frozen px font sizes: ${totalFrozen} across ${frozenByFile.size} file(s)` +
    `${frozenByFile.size ? ` (${[...frozenByFile.keys()].map(r => r.split('/').pop()).join(', ')})` : ''}; ` +
    `views/chat.css: ${(frozenByFile.get(CHAT_CSS) || []).length}`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All CSS custom-property token assertions green');
