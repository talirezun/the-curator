/**
 * test-research-links.js — OFFLINE suite: every relative link in the research
 * series resolves.
 *
 * research/ holds the published articles (research/articles/*.md) and the
 * series index (research/README.md). They link into the docs by relative path
 * and #anchor — "../../docs/user-guide.md#5-first-run--the-getting-started-panel"
 * — and the docs change every release: a heading is renamed, a section is
 * renumbered, a file moves. The article is not touched, so nothing in its own
 * diff shows the link has died, and a reader who clicks it lands at the top of
 * a 7,000-line guide or on a 404. The repo is public; a dead link in a
 * published article is a defect, the maintainer asked for it to be caught
 * mechanically, and this is where it is caught.
 *
 * For EVERY markdown file under research/ (recursively), every link outside a
 * fenced block and outside inline code — inline `[text](target)`, image
 * `![alt](target)`, reference definitions `[id]: target`, and HTML `href=` /
 * `src=` attributes — is classified:
 *
 *   - RELATIVE (a path, or a bare `#anchor` into the same file): the target
 *     file must exist, and a `#anchor` must equal the GitHub slug of a heading
 *     in the target (lowercase, punctuation dropped except `-` and `_`, each
 *     space a hyphen, duplicate headings `-1`, `-2` …) or an explicit
 *     `<a id="…">` / `<a name="…">` in it. A directory target must exist.
 *   - THIS REPOSITORY'S OWN GITHUB URL (github.com/talirezun/the-curator,
 *     blob/main or tree/main): resolved against the working tree the same way,
 *     because it is the same file on disk and needs no network.
 *   - EXTERNAL http(s) / mailto: NOT fetched (the suite is offline). They are
 *     counted and the count is printed, so the number is visible.
 *
 * A failure names file:line and the bad link.
 *
 * ── Anti-vacuity ─────────────────────────────────────────────────────────────
 * §1 fails if research/ yields no files or no relative links (a scanner that
 * stopped matching would otherwise certify nothing). §3 drives the SAME
 * checker over planted defects — a missing file, a missing anchor, a wrong
 * duplicate suffix — and over clean links, and each must be rejected /
 * accepted. §4 pins the slug rules against headings whose slugs are known.
 *
 * The slug rules are the ones test-public-knowledge.js uses for llm-docs/
 * (copied, not imported: that suite is a script, not a module).
 *
 * Read-only off disk. No network, no credentials, no writes.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const RESEARCH = path.join(REPO, 'research');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Markdown primitives ─────────────────────────────────────────────────────

/** One boolean per line: is it inside (or a delimiter of) a fenced block? */
function classifyFences(lines) {
  const inFence = [];
  let fence = null;
  for (const line of lines) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (m) {
      const ch = m[1][0];
      if (!fence) { fence = ch; inFence.push(true); continue; }
      if (ch === fence) { fence = null; inFence.push(true); continue; }
      inFence.push(true);
      continue;
    }
    inFence.push(Boolean(fence));
  }
  return inFence;
}

function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length));
}

/** GitHub's heading → anchor slug. */
function slugify(text) {
  // A code span's CONTENT is heading text (`<machine>` renders as "<machine>"
  // and slugs as "machine"); HTML outside code spans is markup and is dropped.
  const plain = text
    .trim()
    .split(/(`[^`]*`)/)
    .map((seg) => (seg.startsWith('`') && seg.endsWith('`') && seg.length > 1
      ? seg.slice(1, -1)
      : seg.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')   // [label](url) → label
           .replace(/<[^>]*>/g, '')))                   // inline HTML dropped
    .join('');
  return plain
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')         // punctuation dropped (keeps - and _)
    .replace(/\s/g, '-');                       // each space its own hyphen
}

/** Every anchor a markdown text offers: headings (with -1/-2 duplicates) + explicit <a id|name>. */
function anchorsOfText(text) {
  const lines = text.split('\n');
  const inFence = classifyFences(lines);
  const seen = new Map();
  const out = new Set();
  lines.forEach((line, i) => {
    if (!inFence[i]) {
      const h = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        const base = slugify(h[2]);
        const n = seen.get(base) || 0;
        seen.set(base, n + 1);
        out.add(n === 0 ? base : `${base}-${n}`);
      }
    }
    for (const m of line.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/g)) out.add(m[1]);
  });
  return out;
}

const anchorCache = new Map();
function anchorsOfFile(abs) {
  if (!anchorCache.has(abs)) anchorCache.set(abs, anchorsOfText(readFileSync(abs, 'utf8')));
  return anchorCache.get(abs);
}

// ── Link extraction ─────────────────────────────────────────────────────────

/** Every link target in a markdown text, with its 1-based line number. */
function extractLinks(text) {
  const lines = text.split('\n');
  const inFence = classifyFences(lines);
  const out = [];
  lines.forEach((raw, i) => {
    if (inFence[i]) return;
    const line = stripInlineCode(raw);
    // inline and image links: [text](target "title") / [text](<target>)
    for (const m of line.matchAll(/!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
      out.push({ line: i + 1, target: m[1].replace(/^<|>$/g, '') });
    }
    // reference definitions: [id]: target
    const ref = line.match(/^ {0,3}\[[^\]]+\]:\s+(<[^>]*>|\S+)/);
    if (ref) out.push({ line: i + 1, target: ref[1].replace(/^<|>$/g, '') });
    // HTML attributes
    for (const m of line.matchAll(/\b(?:href|src|srcset)=["']([^"'\s]+)[^"']*["']/g)) {
      out.push({ line: i + 1, target: m[1] });
    }
    // autolinks <https://…> are external by construction
    for (const m of line.matchAll(/<(https?:\/\/[^>\s]+)>/g)) out.push({ line: i + 1, target: m[1] });
  });
  return out;
}

const OWN_REPO = /^https?:\/\/github\.com\/talirezun\/the-curator\/(blob|tree)\/main\/([^?#]*)(?:#(.*))?$/;

/**
 * Check one link. `fileAbs` is the file the link is written in; `readTarget`
 * lets §3 supply planted files without touching the disk.
 * Returns { kind: 'relative'|'own-repo'|'external', problem: string|null }.
 */
function checkLink(target, fileAbs, fs = realFs) {
  if (/^(mailto:|tel:)/i.test(target)) return { kind: 'external', problem: null };
  let pathPart, frag, kind, expectDir = null;
  const own = target.match(OWN_REPO);
  if (own) {
    kind = 'own-repo';
    expectDir = own[1] === 'tree';
    pathPart = path.join(REPO, decodeURIComponent(own[2]));
    frag = own[3];
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) {
    return { kind: 'external', problem: null };
  } else {
    kind = 'relative';
    const hash = target.indexOf('#');
    const p = hash === -1 ? target : target.slice(0, hash);
    frag = hash === -1 ? undefined : target.slice(hash + 1);
    const clean = decodeURIComponent(p.split('?')[0]);
    pathPart = clean === '' ? fileAbs : path.resolve(path.dirname(fileAbs), clean);
  }
  if (!pathPart.startsWith(REPO)) return { kind, problem: `points outside the repository: ${target}` };
  if (!fs.exists(pathPart)) return { kind, problem: `no such file: ${target}` };
  const isDir = fs.isDir(pathPart);
  if (expectDir === true && !isDir) return { kind, problem: `not a directory: ${target}` };
  if (expectDir === false && isDir) return { kind, problem: `not a file: ${target}` };
  if (frag !== undefined && frag !== '') {
    if (isDir || !/\.md$/i.test(pathPart)) return { kind, problem: `an #anchor on a non-markdown target: ${target}` };
    let want;
    try { want = decodeURIComponent(frag); } catch { want = frag; }
    if (!fs.anchors(pathPart).has(want)) return { kind, problem: `no such anchor: ${target}` };
  }
  return { kind, problem: null };
}

const realFs = {
  exists: (p) => existsSync(p),
  isDir: (p) => statSync(p).isDirectory(),
  anchors: (p) => anchorsOfFile(p),
};

function mdFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...mdFilesUnder(abs));
    else if (name.toLowerCase().endsWith('.md')) out.push(abs);
  }
  return out.sort();
}

/** { counts, problems[] } for one file's text. */
function reportFor(text, fileAbs, fs = realFs) {
  const counts = { relative: 0, 'own-repo': 0, external: 0 };
  const problems = [];
  for (const { line, target } of extractLinks(text)) {
    const r = checkLink(target, fileAbs, fs);
    counts[r.kind]++;
    if (r.problem) problems.push(`${path.relative(REPO, fileAbs)}:${line} — ${r.problem}`);
  }
  return { counts, problems };
}

// ── §1 The research series ──────────────────────────────────────────────────

section('§1 — Every relative link in research/**/*.md resolves (file exists, #anchor is a real heading)');

const files = existsSync(RESEARCH) ? mdFilesUnder(RESEARCH) : [];
ok(files.length > 0, `research/ holds markdown files to check (${files.length})`);
ok(files.some((f) => path.relative(RESEARCH, f) === 'README.md'), 'research/README.md is among them');

const totals = { relative: 0, 'own-repo': 0, external: 0 };
for (const f of files) {
  const { counts, problems } = reportFor(readFileSync(f, 'utf8'), f);
  for (const k of Object.keys(totals)) totals[k] += counts[k];
  const rel = path.relative(REPO, f);
  ok(problems.length === 0,
    `${rel}: ${counts.relative} relative + ${counts['own-repo']} own-repo link${counts.relative + counts['own-repo'] === 1 ? '' : 's'} resolve`);
  for (const p of problems) console.log(`      ✗ ${p}`);
}
ok(totals.relative > 0, `the link scan actually ran (${totals.relative} relative links found)`);
console.log(`\n  External http(s) links, NOT fetched (offline): ${totals.external}`);
console.log(`  This repository's own github.com URLs, resolved on disk: ${totals['own-repo']}`);

// ── §2 Extraction covers every link shape used ─────────────────────────────

section('§2 — Extraction: every link shape is seen, code is not');

{
  const sample = [
    'A [plain](../a.md) link and an ![image](../img/x.jpg).',
    'A [titled](../b.md#head "Title") link and one in <angle> form: [x](<../c d.md>).',
    '[ref]: ../d.md#sec',
    '<img src="../e.png" alt=""> and <a href="../f.md">f</a>',
    'Inline `[not](../code.md)` is ignored.',
    '```',
    '[fenced](../fenced.md)',
    '```',
    'External [site](https://example.com) and <https://example.org>.',
    'A [[wikilink]] is not a link.',
  ].join('\n');
  const got = extractLinks(sample).map((l) => l.target);
  const want = ['../a.md', '../img/x.jpg', '../b.md#head', '../c d.md', '../d.md#sec', '../e.png', '../f.md',
    'https://example.com', 'https://example.org'];
  ok(JSON.stringify(got) === JSON.stringify(want), `every shape extracted, code and fences skipped (got ${JSON.stringify(got)})`);
  ok(extractLinks(sample).find((l) => l.target === '../d.md#sec')?.line === 3, 'the line number is the 1-based source line');
}

// ── §3 Control: the checker rejects planted defects and accepts clean links ─

section('§3 — Control: planted defects are REJECTED, clean links ACCEPTED');

{
  const base = path.join(REPO, 'research', 'articles');
  const doc = path.join(REPO, 'docs', 'planted.md');
  const planted = new Map([
    [doc, '# Guide\n\n## 5. First run — the Getting started panel\n\n## Notes\n\n## Notes\n\n<a id="row-do"></a>\n'],
    [path.join(REPO, 'docs'), null],
  ]);
  const fakeFs = {
    exists: (p) => planted.has(p),
    isDir: (p) => planted.get(p) === null,
    anchors: (p) => anchorsOfText(planted.get(p)),
  };
  const art = path.join(base, 'x.md');
  const probe = (t) => checkLink(t, art, fakeFs).problem;
  ok(probe('../../docs/planted.md') === null, 'clean: an existing file');
  ok(probe('../../docs/planted.md#5-first-run--the-getting-started-panel') === null, 'clean: a real heading anchor');
  ok(probe('../../docs/planted.md#notes-1') === null, 'clean: a duplicate heading addressed with -1');
  ok(probe('../../docs/planted.md#row-do') === null, 'clean: an explicit <a id> anchor');
  ok(probe('../../docs/') === null, 'clean: an existing directory');
  ok(probe('https://example.com/nowhere') === null, 'external links are not judged');
  ok(/no such file/.test(probe('../../docs/missing.md') || ''), 'REJECTED: a missing file');
  ok(/no such anchor/.test(probe('../../docs/planted.md#first-run') || ''), 'REJECTED: a missing anchor');
  ok(/no such anchor/.test(probe('../../docs/planted.md#notes-2') || ''), 'REJECTED: a duplicate suffix that does not exist');
  ok(/no such anchor/.test(probe('../../docs/planted.md#Notes') || ''), 'REJECTED: an anchor in the wrong case');
  ok(/no such file/.test(probe('https://github.com/talirezun/the-curator/blob/main/docs/missing.md') || ''),
    "REJECTED: this repository's own URL to a missing file");
  ok(/outside the repository/.test(probe('../../../elsewhere.md') || ''), 'REJECTED: a path that climbs out of the repository');
  const rep = reportFor('ok [a](../../docs/planted.md)\nbad [b](../../docs/planted.md#nope)\n', art, fakeFs);
  ok(rep.problems.length === 1 && /research\/articles\/x\.md:2 — no such anchor/.test(rep.problems[0]),
    `a failure names file:line and the link (${rep.problems[0] || 'none'})`);
}

// ── §4 Slug rules ───────────────────────────────────────────────────────────

section('§4 — GitHub slug rules');

ok(slugify('19. API keys, cost & free tier') === '19-api-keys-cost--free-tier', "'&' dropped, double hyphen left");
ok(slugify('First run — the Getting started panel') === 'first-run--the-getting-started-panel', 'an em dash dropped, double hyphen left');
ok(slugify('The menu bar icon (Mac app)') === 'the-menu-bar-icon-mac-app', 'parentheses dropped');
ok(slugify('`save_working_state` and snake_case') === 'save_working_state-and-snake_case', 'underscores kept, backticks dropped');
ok(slugify("Karpathy's Quietly Radical Idea") === 'karpathys-quietly-radical-idea', 'apostrophe dropped');
ok(slugify('Why `<machine>` is in the path') === 'why-machine-is-in-the-path', 'a code span keeps its text, angle brackets and all dropped as punctuation');
ok(slugify('A <em>styled</em> heading') === 'a-styled-heading', 'HTML outside a code span is dropped as markup');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
