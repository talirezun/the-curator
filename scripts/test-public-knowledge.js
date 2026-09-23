/**
 * test-public-knowledge.js — OFFLINE suite guarding llm-docs/.
 *
 * llm-docs/ is the knowledge base uploaded to Lumina, the support chat
 * assistant on The Curator's website. Lumina has NO SEARCH: every document is
 * sent to the model IN FULL before every answer. That single fact is what this
 * suite exists for, and it produces two failure classes a reviewer will not
 * catch by reading:
 *
 *   1. SIZE. A paragraph added to a knowledge file is not paid for once — it is
 *      paid for on every question every visitor ever asks. The per-file budgets
 *      below (and the 200,000-token ceiling over the set) are therefore a hard
 *      contract, not a style preference. The budget table is printed on EVERY
 *      run, passing or failing, so the number is visible before it is breached
 *      rather than after.
 *   2. SHAPE. Lumina's document format is narrow: one `#` title, `##` per topic
 *      phrased as the question a visitor would type, nothing deeper, no front
 *      matter, no HTML, no emoji. A file that violates it is accepted by the
 *      uploader and degrades answers silently.
 *
 * A third class is ordinary rot: a link into the GitHub docs whose file was
 * renamed, or whose `#anchor` no longer matches a heading. The assistant will
 * repeat that URL to a visitor with total confidence. Every
 * `blob/main/<path>#<anchor>` link is therefore resolved against the actual
 * repository — the path must exist and the anchor must be a real heading under
 * GitHub's own slug rules (or an explicit `<a id>`).
 *
 * ── Absent files SKIP, an empty set FAILS ───────────────────────────────────
 * The four knowledge files are written and revised independently, so a file
 * that is not on disk is reported as a skip and the rest of the set still
 * passes. If NONE of the four is present the suite FAILS LOUDLY rather than
 * reporting "0 checked, 0 wrong" — a guard that has stopped reaching the thing
 * it guards is the recorded failure shape in this repo (see
 * test-frontend-null-safety.js's history), and a green run over an empty set is
 * exactly that.
 *
 * ── Anti-vacuity control (§5) ───────────────────────────────────────────────
 * Every checker is re-run over synthetic content carrying each defect in turn
 * and must REJECT it, and over clean content and must ACCEPT it. A checker that
 * cannot fail is not a checker.
 *
 * ── On `→` ──────────────────────────────────────────────────────────────────
 * U+2192 RIGHTWARDS ARROW is ALLOWED and is the one deliberate exception in the
 * symbol scan. It is punctuation in these documents ("Settings → General"),
 * reads correctly in a chat bubble, and is how the app's own UI paths are
 * written everywhere else in the repo. Every other arrow, dingbat, pictograph
 * and variation selector is refused.
 *
 * Read-only off disk. No network, no credentials, no writes.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const KB_DIR = path.join(REPO, 'llm-docs');

// chars ÷ 4 — the estimate the maintainer budgets with. Lumina's own meter is
// the authority once a file is uploaded; this is the number to design against.
const CHARS_PER_TOKEN = 4;

// Per-file token budgets, and the ceiling over the whole set.
const BUDGETS = {
  'curator-overview.md': 12_000,
  'curator-user-guide.md': 45_000,
  'curator-agent-memory.md': 30_000,
  'curator-links.md': 8_000,
};
const TOTAL_CEILING = 200_000;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ───────────────────────────────────────────────────────────────────────────
// Shared primitives. Every checker below is a pure function over text so §5
// can drive the SAME code over planted defects.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Classify every line as inside or outside a fenced code block.
 * Returns { inFence: boolean[] } with one entry per line — the length equality
 * against the line array is asserted in §1 as a completeness cross-check, so a
 * classifier that silently stops walking the file cannot pass.
 */
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

/** Strip inline `code` spans from a line so backticked markup is not read as HTML. */
function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, '');
}

/** GitHub's heading → anchor slug. */
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // [label](url) → label
    .replace(/<[^>]*>/g, '')                   // inline HTML dropped
    .replace(/[^\p{L}\p{N}\s-]/gu, '')         // punctuation dropped
    .replace(/\s/g, '-');                      // each space its own hyphen
}

/** Every anchor a markdown file offers: headings (with -1/-2 duplicates) + explicit <a id>. */
function anchorsOf(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const inFence = classifyFences(lines);
  const seen = new Map();
  const out = new Set();
  lines.forEach((line, i) => {
    if (!inFence[i]) {
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const base = slugify(h[2]);
        const n = seen.get(base) || 0;
        seen.set(base, n + 1);
        out.add(n === 0 ? base : `${base}-${n}`);
      }
    }
    for (const m of line.matchAll(/<a\s+id=["']([^"']+)["']/g)) out.add(m[1]);
  });
  return out;
}

// ── the shape checkers ─────────────────────────────────────────────────────

/** Every `#`-level heading line index, outside fences. */
function headings(text) {
  const lines = text.split('\n');
  const inFence = classifyFences(lines);
  const out = [];
  lines.forEach((line, i) => {
    if (inFence[i]) return;
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) out.push({ line: i + 1, level: m[1].length, text: m[2] });
  });
  return out;
}

function titleProblems(text) {
  const hs = headings(text);
  const h1 = hs.filter((h) => h.level === 1);
  const problems = [];
  if (h1.length !== 1) problems.push(`expected exactly one '# ' heading, found ${h1.length}`);
  const lines = text.split('\n');
  let first = 0;
  while (first < lines.length && lines[first].trim() === '') first++;
  if (!/^#\s+\S/.test(lines[first] || '')) problems.push(`first non-blank line is not the '# ' title (line ${first + 1})`);
  return problems;
}

function depthProblems(text) {
  return headings(text)
    .filter((h) => h.level > 2)
    .map((h) => `line ${h.line}: heading depth ${h.level} (${'#'.repeat(h.level)} ${h.text.slice(0, 40)})`);
}

function frontmatterProblems(text) {
  const first = text.split('\n')[0];
  return first !== undefined && first.trim() === '---'
    ? ["line 1 is '---' — a front matter block"]
    : [];
}

const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/;
function htmlProblems(text) {
  const lines = text.split('\n');
  const inFence = classifyFences(lines);
  const problems = [];
  lines.forEach((line, i) => {
    if (inFence[i]) return;
    const m = stripInlineCode(line).match(HTML_TAG);
    if (m) problems.push(`line ${i + 1}: HTML tag ${m[0]}`);
  });
  return problems;
}

const ARROW_RIGHT = 0x2192; // the one allowed exception — see the docblock.
function isBannedSymbol(cp) {
  if (cp === ARROW_RIGHT) return false;
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) ||  // pictographs, emoticons, transport, supplemental
    (cp >= 0x2600 && cp <= 0x27bf) ||    // misc symbols + dingbats (the common symbol range)
    (cp >= 0x2b00 && cp <= 0x2bff) ||    // misc symbols and arrows
    (cp >= 0x2190 && cp <= 0x21ff) ||    // arrows
    cp === 0xfe0f || cp === 0x20e3 ||    // variation selector-16, combining keycap
    cp === 0x2122 || cp === 0x00a9 || cp === 0x00ae || // (tm) (c) (r)
    cp === 0x203c || cp === 0x2049
  );
}
function emojiProblems(text) {
  const lines = text.split('\n');
  const problems = [];
  lines.forEach((line, i) => {
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (isBannedSymbol(cp)) {
        problems.push(`line ${i + 1}: U+${cp.toString(16).toUpperCase().padStart(4, '0')} (${ch})`);
        break;
      }
    }
  });
  return problems;
}

const HOME_PATHS = [/\/Users\//, /\/home\//, /C:\\Users/i];
function homePathProblems(text) {
  const lines = text.split('\n');
  const problems = [];
  lines.forEach((line, i) => {
    for (const re of HOME_PATHS) {
      if (re.test(line)) { problems.push(`line ${i + 1}: ${re.source}`); break; }
    }
  });
  return problems;
}

// ── the link checker ───────────────────────────────────────────────────────

const BLOB = /https:\/\/github\.com\/talirezun\/the-curator\/blob\/main\/([^\s|)<>"']+)/g;
const TREE = /https:\/\/github\.com\/talirezun\/the-curator\/tree\/main\/([^\s|)<>"']+)/g;

const anchorCache = new Map();
function anchorsCached(rel) {
  if (!anchorCache.has(rel)) anchorCache.set(rel, anchorsOf(path.join(REPO, rel)));
  return anchorCache.get(rel);
}

/** Returns { checked, problems[] } for the repo links in one knowledge file. */
function linkReport(text) {
  const problems = [];
  const seen = new Set();
  let checked = 0;
  for (const m of text.matchAll(BLOB)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    checked++;
    const [rel, frag] = m[1].split('#');
    const abs = path.join(REPO, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) { problems.push(`no such file: ${m[1]}`); continue; }
    if (frag && !anchorsCached(rel).has(frag)) problems.push(`no such anchor: ${m[1]}`);
  }
  for (const m of text.matchAll(TREE)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    checked++;
    const abs = path.join(REPO, m[1]);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) problems.push(`no such directory: ${m[1]}`);
  }
  return { checked, problems };
}

// ───────────────────────────────────────────────────────────────────────────
// Run
// ───────────────────────────────────────────────────────────────────────────

console.log('test-public-knowledge.js — llm-docs/ shape, budget and link guard\n');

section('§0 — The folder and the file set');

ok(existsSync(KB_DIR) && statSync(KB_DIR).isDirectory(), 'llm-docs/ exists');

const onDisk = existsSync(KB_DIR)
  ? readdirSync(KB_DIR).filter((f) => /^curator-.*\.md$/.test(f)).sort()
  : [];

const present = [];
const skipped = [];
for (const name of Object.keys(BUDGETS)) {
  if (onDisk.includes(name)) present.push(name);
  else skipped.push(name);
}
// A curator-*.md file with no budget is unbudgeted, and an unbudgeted file is
// exactly how the 200k ceiling gets breached without anyone noticing.
const unbudgeted = onDisk.filter((f) => !(f in BUDGETS));
ok(unbudgeted.length === 0, `every curator-*.md on disk has a budget${unbudgeted.length ? ` — unbudgeted: ${unbudgeted.join(', ')}` : ''}`);

for (const name of skipped) console.log(`  · SKIP ${name} — not on disk yet (written separately)`);

ok(present.length > 0, `at least one knowledge file is present (${present.length} of ${Object.keys(BUDGETS).length})`);
if (present.length === 0) {
  console.log('\n' + '─'.repeat(72));
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  console.log('❌ FAILURES — no knowledge file was checked; this suite had nothing to guard');
  process.exit(1);
}

// ── The budget meter. Printed on every run, pass or fail. ──────────────────

section('§1 — Budget (chars ÷ 4; Lumina sends every file IN FULL on every answer)');

const texts = new Map();
for (const name of present) texts.set(name, readFileSync(path.join(KB_DIR, name), 'utf8'));

const fmt = (n) => n.toLocaleString('en-US');
console.log('');
console.log('  ' + 'file'.padEnd(26) + 'chars'.padStart(10) + 'est tokens'.padStart(13) + 'budget'.padStart(10) + 'used'.padStart(8));
console.log('  ' + '-'.repeat(65));
let totalTokens = 0;
const overBudget = [];
for (const name of Object.keys(BUDGETS)) {
  if (!texts.has(name)) {
    console.log('  ' + name.padEnd(26) + '—'.padStart(10) + '—'.padStart(13) + fmt(BUDGETS[name]).padStart(10) + 'skip'.padStart(8));
    continue;
  }
  const chars = texts.get(name).length;
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
  totalTokens += tokens;
  const pct = Math.round((tokens / BUDGETS[name]) * 100);
  if (tokens > BUDGETS[name]) overBudget.push(`${name}: ${fmt(tokens)} > ${fmt(BUDGETS[name])}`);
  console.log('  ' + name.padEnd(26) + fmt(chars).padStart(10) + fmt(tokens).padStart(13) + fmt(BUDGETS[name]).padStart(10) + `${pct}%`.padStart(8));
}
console.log('  ' + '-'.repeat(65));
console.log('  ' + 'TOTAL (present files)'.padEnd(26) + ''.padStart(10) + fmt(totalTokens).padStart(13) + fmt(TOTAL_CEILING).padStart(10) + `${Math.round((totalTokens / TOTAL_CEILING) * 100)}%`.padStart(8));
console.log('');

ok(overBudget.length === 0, `every present file is within its budget${overBudget.length ? ` — ${overBudget.join('; ')}` : ''}`);
ok(totalTokens <= TOTAL_CEILING, `the set is within the ${fmt(TOTAL_CEILING)}-token ceiling (${fmt(totalTokens)})`);

// ── Shape ─────────────────────────────────────────────────────────────────

section('§2 — Lumina document shape');

for (const name of present) {
  const text = texts.get(name);
  const lines = text.split('\n');

  // Completeness cross-check: the fence classifier must have visited every
  // line. A classifier that quietly stops walking is how a scanner reports
  // green over a file it never finished reading.
  ok(classifyFences(lines).length === lines.length,
    `${name}: fence classifier visited every line (${lines.length})`);

  const t = titleProblems(text);
  ok(t.length === 0, `${name}: one '# ' title, first non-blank line${t.length ? ` — ${t.join('; ')}` : ''}`);

  const d = depthProblems(text);
  ok(d.length === 0, `${name}: no heading deeper than '## '${d.length ? ` — ${d.slice(0, 3).join('; ')}` : ''}`);

  const f = frontmatterProblems(text);
  ok(f.length === 0, `${name}: no front matter${f.length ? ` — ${f.join('; ')}` : ''}`);

  const h = htmlProblems(text);
  ok(h.length === 0, `${name}: no HTML tags outside code fences${h.length ? ` — ${h.slice(0, 3).join('; ')}` : ''}`);

  const e = emojiProblems(text);
  ok(e.length === 0, `${name}: no emoji or pictographic symbols${e.length ? ` — ${e.slice(0, 3).join('; ')}` : ''}`);

  const p = homePathProblems(text);
  ok(p.length === 0, `${name}: no absolute home path${p.length ? ` — ${p.slice(0, 3).join('; ')}` : ''}`);

  // Lumina's `##` topics are meant to be the question a visitor would type.
  // Advisory rather than mandatory — reported, never failed — because a
  // legitimate topic can be a noun phrase.
  const h2 = headings(text).filter((x) => x.level === 2);
  const asQuestions = h2.filter((x) => x.text.trim().endsWith('?')).length;
  console.log(`  · ${name}: ${asQuestions} of ${h2.length} '## ' topics are phrased as questions`);
}

// ── Links ─────────────────────────────────────────────────────────────────

section('§3 — Repository links resolve (path exists, #anchor is a real heading)');

let totalLinks = 0;
for (const name of present) {
  const { checked, problems } = linkReport(texts.get(name));
  totalLinks += checked;
  ok(problems.length === 0,
    `${name}: ${checked} repository link${checked === 1 ? '' : 's'} resolve${problems.length ? ` — ${problems.slice(0, 5).join('; ')}` : ''}`);
}
// If the link scan found nothing at all across every present file, the regex
// has stopped matching and this section is certifying nothing.
ok(totalLinks > 0, `the link scan actually ran (${totalLinks} distinct repository links)`);

// ── The slug rules, pinned against known headings ─────────────────────────

section('§4 — GitHub slug rules');

ok(slugify('19. API keys, cost & free tier') === '19-api-keys-cost--free-tier',
  "'&' is dropped and leaves a double hyphen");
ok(slugify('First run — the Getting started panel') === 'first-run--the-getting-started-panel',
  'an em dash is dropped and leaves a double hyphen');
ok(slugify('The menu bar icon (Mac app)') === 'the-menu-bar-icon-mac-app',
  'parentheses are dropped');
ok(slugify('Activation: put the discipline where the harness cannot skip it')
  === 'activation-put-the-discipline-where-the-harness-cannot-skip-it',
  'a colon is dropped');
{
  // Duplicate headings get -1, -2 … and explicit <a id> anchors count. Proven
  // against the real user guide, which carries three of them.
  const ug = path.join(REPO, 'docs/user-guide.md');
  if (existsSync(ug)) {
    const a = anchorsOf(ug);
    ok(a.has('what-a-row-can-do'), "an explicit <a id> anchor is found (docs/user-guide.md 'what-a-row-can-do')");
    ok(a.has('19-api-keys-cost--free-tier'), 'a real heading anchor is found in docs/user-guide.md');
  } else {
    ok(false, 'docs/user-guide.md is present to pin the anchor rules against');
  }
}

// ── Anti-vacuity control ──────────────────────────────────────────────────

section('§5 — Control: each checker must REJECT a planted defect and ACCEPT clean text');

const CLEAN = [
  '# The Curator',
  '',
  '## What is it?',
  '',
  'A local app that turns sources into a markdown wiki. Settings → General.',
  '',
  '```html',
  '<div>fenced HTML is fine</div>',
  '### fenced heading is fine',
  '```',
  '',
  'Inline `<machine>` in backticks is fine.',
  '',
].join('\n');

ok(titleProblems(CLEAN).length === 0, 'control: clean text accepted (title)');
ok(depthProblems(CLEAN).length === 0, 'control: clean text accepted (depth — fenced ### ignored)');
ok(frontmatterProblems(CLEAN).length === 0, 'control: clean text accepted (front matter)');
ok(htmlProblems(CLEAN).length === 0, 'control: clean text accepted (HTML — fenced and inline-code ignored)');
ok(emojiProblems(CLEAN).length === 0, 'control: clean text accepted (symbols — → is the allowed exception)');
ok(homePathProblems(CLEAN).length === 0, 'control: clean text accepted (home path)');

const BAD = [
  ['two # titles', titleProblems, '# One\n\n# Two\n'],
  ['no # title', titleProblems, '## Only a topic\n'],
  ['title not first', titleProblems, 'Intro prose.\n\n# Title\n'],
  ['### heading', depthProblems, '# T\n\n## Q?\n\n### too deep\n'],
  ['#### heading', depthProblems, '# T\n\n## Q?\n\n#### too deep\n'],
  ['front matter', frontmatterProblems, '---\ntitle: x\n---\n\n# T\n'],
  ['HTML tag', htmlProblems, '# T\n\n## Q?\n\n<br>\n'],
  ['HTML tag with attributes', htmlProblems, '# T\n\n## Q?\n\n<img src="x.png" alt="y">\n'],
  ['emoji', emojiProblems, '# T\n\n## Q?\n\nGreat \u{1F389}\n'],
  ['dingbat check mark', emojiProblems, '# T\n\n## Q?\n\n\u2705 done\n'],
  ['variation selector', emojiProblems, '# T\n\n## Q?\n\n\u2699\uFE0F settings\n'],
  ['leftwards arrow', emojiProblems, '# T\n\n## Q?\n\nback \u2190 here\n'],
  ['macOS home path', homePathProblems, '# T\n\n## Q?\n\nOpen /Users/someone/domains\n'],
  ['linux home path', homePathProblems, '# T\n\n## Q?\n\nOpen /home/someone/domains\n'],
  ['windows home path', homePathProblems, '# T\n\n## Q?\n\nOpen C:\\Users\\someone\n'],
];
for (const [label, fn, text] of BAD) {
  const problems = fn(text);
  ok(problems.length > 0, `control rejected (${label})${problems.length ? '' : ' — NOT REJECTED, the checker is vacuous'}`);
}

// The link checker must be able to say no, and must not say no to a good link.
{
  const badPath = linkReport('See https://github.com/talirezun/the-curator/blob/main/docs/does-not-exist.md for more.');
  ok(badPath.problems.length === 1 && badPath.problems[0].startsWith('no such file'),
    'control rejected a link to a file that does not exist');
  const badAnchor = linkReport('See https://github.com/talirezun/the-curator/blob/main/docs/user-guide.md#no-such-heading-here here.');
  ok(badAnchor.problems.length === 1 && badAnchor.problems[0].startsWith('no such anchor'),
    'control rejected a link to an anchor that does not exist');
  const good = linkReport('See https://github.com/talirezun/the-curator/blob/main/docs/user-guide.md#3-installation here.');
  ok(good.checked === 1 && good.problems.length === 0, 'control accepted a valid link with a valid anchor');
  const badTree = linkReport('See https://github.com/talirezun/the-curator/tree/main/not-a-folder here.');
  ok(badTree.problems.length === 1 && badTree.problems[0].startsWith('no such directory'),
    'control rejected a tree link to a directory that does not exist');
}

// ───────────────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(72));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (skipped.length) console.log(`Skipped (not on disk): ${skipped.join(', ')}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All llm-docs assertions green');
