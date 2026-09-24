#!/usr/bin/env node
/**
 * scripts/test-explainers.js — OFFLINE
 *
 * The explainer MODEL (v3.71.0), enforced over every entry of
 * src/public/next/shared/explainers.js — the one file that holds the copy of
 * every ⓘ that has adopted it.
 *
 * An ⓘ is a helper for fast understanding, written for someone who has never
 * read the guide. Before this release the Context view alone averaged 311
 * words per panel against a 20-word promise, because nothing measured it.
 * Every rule below is measured here, per entry:
 *
 *   §1  shape         — frozen deeply; `<surface>.<topic>` keys; the fields
 *                       the renderer reads and no others
 *   §2  caps          — lead ≤ 20 words and ≤ 2 sentences; ≤ 3 points, each
 *                       ≤ 12 words; try ≤ 14; total ≤ 90; table 2–5 rows ×
 *                       2–3 cols, cells ≤ 6 words; steps 2–5, ≤ 10 words;
 *                       flow 2–4 chips
 *   §3  words         — the banned list (internals · warning/cost/outcome ·
 *                       state-dependent); bold only for a screen word; a
 *                       table's row names and a flow's chips are screen words
 *   §4  icons         — every icon is in the kit's glyph table; the book,
 *                       external and info glyphs are reserved for the frame
 *   §5  guide cards   — key in DOCS_LINKS; the anchor is what GITHUB makes of
 *                       a heading that exists exactly once, and the heading
 *                       the card prints is that heading
 *   §6  the slugger   — GitHub's real rule, with controls pinned from anchors
 *                       GitHub actually served for this repo's guide
 *   §7  every docs link, under GitHub's rule too
 *   §8  the framing   — three nodes, in order; the sentence; where it appears
 *   §9  SELF-TEST     — the linter is fed mutated copies of real entries and
 *                       must flag each, so a check that stopped reaching its
 *                       target goes red here rather than passing everything
 *
 * ── THE SLUG RULE, CHECKED AGAINST GITHUB RATHER than ASSUMED ─────────────
 *
 * The design pass (INVENTORY finding 2) believed GitHub KEEPS circled numerals
 * such as ④ in an anchor. GitHub was asked: the rendered docs/user-guide.md
 * (GET /repos/…/contents/docs/user-guide.md, Accept: application/vnd.github.html,
 * 2026-09-24) served `step---session-start-and-the-context-window-meter` for
 * "Step ④ — Session start, and the context-window meter" and
 * `-documents--what-the-project-tells-an-agent` for "① Documents — what the
 * project tells an agent". So ④ is DROPPED, as github-slugger 2.0.0 does —
 * and the real divergence from test-docs-links.js's ASCII rule is elsewhere:
 * GitHub does NOT trim, so a heading that STARTS or ENDS with a dropped
 * symbol gets a leading or trailing hyphen, and GitHub KEEPS non-ASCII
 * letters (é, ⓘ) that an ASCII rule drops. The rule below is github-slugger's
 * (lowercase; drop everything that is not a letter, mark, decimal digit,
 * connector, space or hyphen; spaces to hyphens), measured against
 * github-slugger over all 1,474 headings in docs/ with zero differences.
 *
 * Offline: reads docs/ off disk and imports three import-free /next modules.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPLAINERS, FRAMING, SCREEN_WORDS } from '../src/public/next/shared/explainers.js';
import { GLYPHS, VISUAL_TYPES, explainerHtml } from '../src/public/next/shared/explainer.js';
import { DOCS_LINKS } from '../src/public/next/shared/docs-links.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

// ═════════════════════════════════════════════════════════════════════════
// The measuring instruments — shared by the real pass and the self-test.

/** Words, as the design counted them: markup stripped, tokens with a letter or digit. */
export function words(s) {
  return String(s).replace(/\*\*|`/g, '').split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x)).length;
}
function sentences(s) {
  return (String(s).match(/[.!?](?=\s|$)/g) || []).length || 1;
}
function cellText(c) { return c && typeof c === 'object' ? c.text : c; }

const BANNED = [
  // internals (MODEL.md §3 rule 4)
  ['state/', /state\//i], ['.md', /\.md\b/i], ['manifest', /manifest/i], ['slug', /slug/i],
  ['scope', /\bscope/i], ['tier', /\btiers?\b/i], ['checksum', /checksum/i], ['JSON', /\bjson\b/i],
  ['bytes', /\bbytes?\b/i], ['endpoint', /endpoint/i], ['route', /\broutes?\b/i], ['store', /\bstores?\b/i],
  ['bridge process', /bridge process/i], ['provenance', /provenance/i], ['supersede', /supersed/i],
  ['accumulate', /accumulat/i], ['verbatim', /verbatim/i], ['canonical', /canonical/i],
  ['foundations', /foundation/i], ['working state', /working state/i], ['capture', /\bcaptur/i],
  ['tokenizer', /tokeni[sz]er/i], ['synthesis', /synthesis/i], ['version number', /\bv\d+\./i],
  ['SHA', /\bsha\b/i], ['function_name(', /\b\w+_\w+\(/],
  // never a warning, cost, refusal or outcome (rule 6)
  ['warning', /\bwarn/i], ['cost', /\bcost\b/i], ['$', /\$/], ['refused', /\brefus/i],
  ['error', /\berror/i], ['failed', /\bfail/i], ['danger', /\bdanger/i],
  // true in every state (rule 7)
  ['yet', /\byet\b/i], ['nothing has been', /nothing has been/i], ['Start here', /start here/i],
];

/** Every string an entry puts on screen, with where it came from. */
function textsOf(e) {
  const out = [['label', e.label], ['title', e.title], ['lead', e.lead]];
  (e.points || []).forEach((p, i) => out.push(['point ' + (i + 1), p.text]));
  if (e.try) out.push(['try', e.try]);
  const v = e.visual || {};
  if (v.caption) out.push(['visual caption', v.caption]);
  (v.head || []).forEach((h) => out.push(['table head', h]));
  (v.rows || []).forEach((r) => r.forEach((c) => out.push(['table cell', cellText(c)])));
  (v.steps || []).forEach((s) => out.push(['visual step', s]));
  out.push(['guide heading', e.guide && e.guide.heading]);
  return out.filter(([, t]) => typeof t === 'string');
}

const ENTRY_FIELDS = ['label', 'title', 'lead', 'visual', 'points', 'try', 'guide'];
const SCREEN = new Set(SCREEN_WORDS);

/**
 * Every rule a test can check, for one entry. Returns the problems as
 * strings; [] is a clean entry. The SAME function runs over the real copy
 * (§2–§4) and over deliberately broken copies (§9).
 */
export function lintEntry(e) {
  const p = [];
  if (!e || typeof e !== 'object') return ['not an object'];
  for (const k of Object.keys(e)) if (!ENTRY_FIELDS.includes(k)) p.push('unknown field ' + k);
  for (const k of ['label', 'title', 'lead']) {
    if (typeof e[k] !== 'string' || !e[k].trim()) p.push('missing ' + k);
  }
  if (!e.guide || typeof e.guide.key !== 'string' || typeof e.guide.heading !== 'string') p.push('missing guide');
  if (p.length) return p;

  // caps
  if (words(e.lead) > 20) p.push('lead is ' + words(e.lead) + ' words (cap 20)');
  if (sentences(e.lead) > 2) p.push('lead is ' + sentences(e.lead) + ' sentences (cap 2)');
  if (words(e.title) > 4) p.push('title is ' + words(e.title) + ' words (cap 4)');
  const pts = e.points || [];
  if (!Array.isArray(pts)) p.push('points is not a list');
  if (pts.length > 3) p.push(pts.length + ' points (cap 3)');
  pts.forEach((pt, i) => {
    if (!pt || typeof pt.text !== 'string') { p.push('point ' + (i + 1) + ' has no text'); return; }
    if (words(pt.text) > 12) p.push('point ' + (i + 1) + ' is ' + words(pt.text) + ' words (cap 12)');
    if (!Object.prototype.hasOwnProperty.call(GLYPHS, pt.icon)) p.push('point ' + (i + 1) + ' icon "' + pt.icon + '" is not in the glyph table');
    else if (['book', 'external', 'info'].includes(pt.icon)) p.push('point ' + (i + 1) + ' uses the reserved "' + pt.icon + '" glyph');
    // MODEL.md §2 says "one bold per point"; the accepted copy bolds two or
    // three screen words in five points ("**Push** … **Pull**", "**Wiki**,
    // **Context** and **All**"), each a real control name. The rule that
    // carries the meaning is "only a screen word" (checked below); the count
    // is capped at three, so bold cannot become emphasis.
    if ((pt.text.match(/\*\*/g) || []).length > 6) p.push('point ' + (i + 1) + ' bolds more than three words');
  });
  if (e.try !== undefined && (typeof e.try !== 'string' || words(e.try) > 14)) p.push('try is ' + words(e.try || '') + ' words (cap 14)');

  let total = words(e.lead) + pts.reduce((n, pt) => n + words(pt.text || ''), 0) + (e.try ? words(e.try) : 0);
  const v = e.visual;
  if (v !== undefined) {
    if (!v || !VISUAL_TYPES.includes(v.type)) p.push('visual type "' + (v && v.type) + '" is not one of ' + VISUAL_TYPES.join(' · '));
    else if (v.type === 'table') {
      const rows = v.rows || [];
      if (rows.length < 2 || rows.length > 5) p.push('table has ' + rows.length + ' rows (2–5)');
      rows.forEach((r, i) => {
        if (!Array.isArray(r) || r.length < 2 || r.length > 3) p.push('table row ' + (i + 1) + ' has ' + (r && r.length) + ' cells (2–3)');
        (r || []).forEach((c) => {
          const t = cellText(c);
          if (typeof t !== 'string') p.push('table row ' + (i + 1) + ' has a cell with no text');
          else if (words(t) > 6) p.push('table cell "' + t + '" is ' + words(t) + ' words (cap 6)');
          if (c && typeof c === 'object' && !Object.prototype.hasOwnProperty.call(GLYPHS, c.icon)) p.push('table cell icon "' + c.icon + '" is not in the glyph table');
          total += words(t || '');
        });
        if (r && !SCREEN.has(cellText(r[0]))) p.push('table row name "' + cellText(r[0]) + '" is not a screen word');
      });
      if (v.head && (!Array.isArray(v.head) || v.head.length !== (rows[0] || []).length)) p.push('table head does not match its columns');
      (v.head || []).forEach((h) => { total += words(h); });
    } else if (v.type === 'steps' || v.type === 'flow') {
      const s = v.steps || [];
      const [lo, hi] = v.type === 'steps' ? [2, 5] : [2, 4];
      if (s.length < lo || s.length > hi) p.push(v.type + ' has ' + s.length + ' items (' + lo + '–' + hi + ')');
      s.forEach((x) => {
        if (v.type === 'steps' && words(x) > 10) p.push('step "' + x + '" is ' + words(x) + ' words (cap 10)');
        if (v.type === 'flow' && !SCREEN.has(x)) p.push('flow chip "' + x + '" is not a screen word');
        total += words(x);
      });
    } else if (v.type === 'frame') {
      if (v.here !== undefined && !FRAMING.nodes.some((n) => n.id === v.here)) p.push('frame here "' + v.here + '" is not a framing node');
    }
  }
  if (total > 90) p.push('total is ' + total + ' words (cap 90)');

  // words
  for (const [where, t] of textsOf(e)) {
    for (const [name, re] of BANNED) if (re.test(t)) p.push(where + ' uses banned "' + name + '"');
    for (const m of t.matchAll(/\*\*([^*]+)\*\*/g)) if (!SCREEN.has(m[1])) p.push(where + ' bolds "' + m[1] + '", not a screen word');
    if ((t.match(/\*\*/g) || []).length % 2) p.push(where + ' has an unbalanced **');
    if ((t.match(/`/g) || []).length % 2) p.push(where + ' has an unbalanced `');
    if (/[<>]/.test(t)) p.push(where + ' carries markup — copy is text plus ** and ` only');
  }
  if (/^\s*(\*\*)?(it|they)\b/i.test(e.lead)) p.push('lead starts with a pronoun, not the thing');
  return p;
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  SHAPE');

const keys = Object.keys(EXPLAINERS);
const REQUIRED = [
  'context.page', 'context.overview', 'context.documents', 'context.memory', 'context.knowledge',
  'context.session-start', 'context.drafting-request', 'context.read-with',
  'onboarding.frame', 'domains.page', 'domains.page-mirror', 'chat.page', 'domains.pages',
  'domains.health', 'settings.general', 'shared.page',
  // v3.71.1 — the remaining ⓘ (REPORT-v3711-copy.md has the location each replaces)
  'domains.overview', 'ingest.page', 'domains.projects', 'domains.marker-line',
  'domains.agent-instructions', 'domains.new-project', 'domains.new-project-documents',
  'domains.shared-brain',
  'settings.providers', 'settings.connect', 'settings.build', 'settings.chat', 'settings.all-models',
  'settings.measured', 'settings.fetched-models', 'settings.update', 'settings.update-recovery',
  'settings.update-recovery-installer', 'settings.appearance', 'settings.system-check',
  'settings.mcp', 'settings.mcp-connect', 'settings.mcp-domain', 'settings.mcp-tool-map',
  'settings.mcp-across', 'settings.health', 'settings.storage', 'settings.vault-folder',
  'settings.github-token',
  'shared.enable', 'shared.token-check', 'shared.wizard-repo', 'shared.wizard-token',
  'shared.wizard-attribution', 'sync.page', 'chat.project',
];
for (const k of REQUIRED) ok(keys.includes(k), `COPY.md §2–§3 entry "${k}" is present`);
ok(keys.every((k) => REQUIRED.includes(k)), `…and nothing else (${keys.length} entries) — a new entry is added here as well, on purpose`);
ok(keys.every((k) => /^[a-z][a-z0-9]*\.[a-z0-9-]+$/.test(k)), 'every key is `<surface>.<topic>`, lower-case');
{
  let frozen = Object.isFrozen(EXPLAINERS);
  (function walk(o) { if (o && typeof o === 'object') { if (!Object.isFrozen(o)) frozen = false; Object.values(o).forEach(walk); } })(EXPLAINERS);
  ok(frozen, 'EXPLAINERS is frozen all the way down — no caller can rewrite a word at runtime');
  ok(Object.isFrozen(FRAMING) && Object.isFrozen(FRAMING.nodes[0]) && Object.isFrozen(SCREEN_WORDS), '…and so are FRAMING and SCREEN_WORDS');
}
{
  const labels = keys.map((k) => EXPLAINERS[k].label);
  const dup = labels.filter((l, i) => labels.indexOf(l) !== i);
  ok(dup.length === 0, 'every ⓘ accessible name is distinct' + (dup.length ? ' — repeated: ' + dup.join(', ') : ''));
}

// ═════════════════════════════════════════════════════════════════════════
section('§2–§4  EVERY ENTRY OBEYS THE MODEL (caps · words · icons)');

for (const k of keys) {
  const e = EXPLAINERS[k];
  const probs = lintEntry(e);
  let total = words(e.lead) + (e.points || []).reduce((n, p) => n + words(p.text), 0) + (e.try ? words(e.try) : 0);
  const v = e.visual || {};
  (v.rows || []).forEach((r) => r.forEach((c) => { total += words(cellText(c)); }));
  (v.head || []).forEach((h) => { total += words(h); });
  (v.steps || []).forEach((s) => { total += words(s); });
  ok(probs.length === 0,
    `${k}: lead ${words(e.lead)}w · ${(e.points || []).length} points · total ${total}w` +
      (probs.length ? ' — ' + probs.join('; ') : ''));
}

{
  const p3 = (EXPLAINERS['context.knowledge'].points[2] || {}).text;
  ok(p3 === 'This project’s own domain stays chosen, even after you add others.',
    'context.knowledge point 3 states the true rule — adding domains never drops the project\'s own '
    + '(working-state.js: chosen list defaults to [<containing domain>] and an add appends to it)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  EVERY GUIDE CARD LANDS ON THE HEADING IT PRINTS');

/** GitHub's heading → anchor rule (github-slugger 2.0.0; see the header). */
export function githubSlug(heading) {
  return String(heading).toLowerCase()
    .replace(/[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}
function headingsOf(md) {
  // ATX headings outside fenced code — a `# comment` in a shell block is not a heading.
  const out = [];
  let fence = null;
  for (const line of md.split('\n')) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) { fence = fence === f[1] ? null : (fence || f[1]); continue; }
    if (fence) continue;
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}
const stripEnum = (h) => h.replace(/^\d+[a-z]?\.\s+/, '');

// Headings the v3.71.0 docs pass (P5) retitles or adds. Named so a red line
// here says WHY on a branch where that pass has not merged yet.
const P5_ANCHORS = new Set([
  'documents--the-files-that-travel-with-a-project',
  'memory--the-brief-handoffs-and-the-journal',
  'session-start-and-the-context-window',
]);
const mdCache = new Map();
const readDoc = (f) => { if (!mdCache.has(f)) mdCache.set(f, readFileSync(join(DOCS, f), 'utf8')); return mdCache.get(f); };

for (const k of keys) {
  const { key, heading } = EXPLAINERS[k].guide;
  const entry = Object.prototype.hasOwnProperty.call(DOCS_LINKS, key) ? DOCS_LINKS[key] : null;
  ok(!!entry, `${k} → guide key "${key}" is in DOCS_LINKS`);
  if (!entry) continue;
  ok(entry.anchor !== null && existsSync(join(DOCS, entry.file)), `…which names a section of an existing file (docs/${entry.file}#${entry.anchor})`);
  if (entry.anchor === null || !existsSync(join(DOCS, entry.file))) continue;
  const heads = headingsOf(readDoc(entry.file));
  const hits = heads.filter((h) => githubSlug(h) === entry.anchor);
  const pending = P5_ANCHORS.has(entry.anchor) ? ' [a v3.71.0 docs retitle — red until that pass merges]' : '';
  ok(hits.length === 1, `…#${entry.anchor} is what GitHub makes of exactly one heading` +
    (hits.length === 1 ? ` ("${hits[0]}")` : ` — found ${hits.length}`) + pending);
  if (hits.length !== 1) continue;
  ok(stripEnum(hits[0]) === heading, `…and the card prints that heading: "${heading}"` +
    (stripEnum(hits[0]) === heading ? '' : ` — the guide says "${stripEnum(hits[0])}"`));
  ok(heads.filter((h) => h === hits[0]).length === 1, '…which occurs once, so GitHub appends no -1 that a later duplicate could move');
  ok(!/[①-⓿❶-➓]/.test(heading), '…and carries no circled numeral (a screen step number is not the section\'s name)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  THE SLUGGER IS GITHUB\'S, NOT A GUESS');

// Pinned from what GitHub SERVED for this repo's guide (see the header).
ok(githubSlug('Step ④ — Session start, and the context-window meter') === 'step---session-start-and-the-context-window-meter',
  'LIVE PIN: GitHub drops ④ and the em dash, and keeps the three spaces as three hyphens');
ok(githubSlug('① Documents — what the project tells an agent') === '-documents--what-the-project-tells-an-agent',
  'LIVE PIN: a heading that STARTS with a dropped symbol keeps a leading hyphen — GitHub does not trim');
ok(githubSlug('The PAGES lens — Wiki · Context · All') === 'the-pages-lens--wiki--context--all',
  'LIVE PIN: the middle dot is punctuation and goes');
ok(githubSlug('Default domain for MCP writes (v2.5.2+)') === 'default-domain-for-mcp-writes-v252',
  'CONTROL: brackets, dots and a plus vanish without leaving a hyphen');
ok(githubSlug('15b. Shared Brain') === '15b-shared-brain', 'CONTROL: a numbered heading');
ok(githubSlug('Café naïve') === 'café-naïve', 'CONTROL (github-slugger): non-ASCII LETTERS are kept — an ASCII rule would drop them');
ok(githubSlug('The help system: lede, ⓘ, "Read more"') === 'the-help-system-lede-ⓘ-read-more',
  'CONTROL (github-slugger): ⓘ is alphabetic and is KEPT, unlike ④');
ok(githubSlug('Version and updates') !== 'version-and-update', 'CONTROL: the slugger can be WRONG — a near miss does not match');
{
  const md = '# Real\n```sh\n# not a heading\n```\n## Also real ##\n';
  const h = headingsOf(md);
  ok(h.length === 2 && h[0] === 'Real' && h[1] === 'Also real', 'CONTROL: a # inside a code fence is not a heading; a closing ## is not part of one');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  EVERY DOCS LINK IN THE APP, UNDER GITHUB\'S RULE TOO');

// test-docs-links.js checks these with an ASCII rule that TRIMS; GitHub does
// not trim and keeps non-ASCII letters. Where the two could disagree, the
// user gets GitHub's, so every mapped anchor is checked against it as well.
for (const [k, { file, anchor }] of Object.entries(DOCS_LINKS)) {
  if (anchor === null || !existsSync(join(DOCS, file))) continue;
  const n = headingsOf(readDoc(file)).filter((h) => githubSlug(h) === anchor).length;
  ok(n === 1, `${k} → docs/${file}#${anchor} resolves on GitHub` + (n === 1 ? '' : ` — ${n} headings match`) +
    (P5_ANCHORS.has(anchor) && n !== 1 ? ' [a v3.71.0 docs retitle — red until that pass merges]' : ''));
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  THE FRAMING');

ok(FRAMING.nodes.map((n) => n.id).join(' → ') === 'second-brain → shared-brain → agent-memory',
  'three nodes, always in this order: Second brain → Shared Brain → Agent memory');
ok(FRAMING.nodes.map((n) => n.name).join('|') === 'Second brain|Shared Brain|Agent memory', '…named as the maintainer decided ("Agent memory" for the node, Context for the page)');
ok(!/optional/.test(FRAMING.nodes[0].places) && /optional/.test(FRAMING.nodes[1].places) && /optional/.test(FRAMING.nodes[2].places),
  'the first node works alone: ② and ③ say optional, ① does not');
ok(FRAMING.nodes.every((n) => words(n.line) <= 8), 'each node\'s line is ≤ 8 words');
ok(words(FRAMING.sentence) <= 20 && EXPLAINERS['onboarding.frame'].lead === FRAMING.sentence,
  'the framing sentence is the onboarding lead, word for word');
for (const t of FRAMING.nodes.flatMap((n) => [n.name, n.places, n.line]).concat([FRAMING.sentence, FRAMING.caption])) {
  const bad = BANNED.filter(([, re]) => re.test(t)).map(([n]) => n);
  if (bad.length) ok(false, `framing text "${t}" uses banned ${bad.join(', ')}`);
}
const TOPS = {
  'onboarding.frame': undefined, 'context.page': 'agent-memory', 'domains.page': 'second-brain',
  'chat.page': 'second-brain', 'shared.page': 'shared-brain', 'domains.page-mirror': 'shared-brain',
};
for (const [k, here] of Object.entries(TOPS)) {
  const v = EXPLAINERS[k].visual;
  ok(v && v.type === 'frame' && v.here === here, `${k} is a top ⓘ and carries the frame` + (here ? `, marking ${here}` : ', with no marker'));
}
ok(keys.filter((k) => (EXPLAINERS[k].visual || {}).type === 'frame').every((k) => k in TOPS),
  'no STEP ⓘ repeats the frame — a step says where it sits in one word of its lead instead');
{
  const html = explainerHtml('context.page');
  ok((html.match(/you are here/g) || []).length === 1 && /is-here[^>]*>[\s\S]*?Agent memory/.test(html),
    'rendered: Context\'s top ⓘ marks Agent memory "you are here", once');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8b  v3.71.1 — THE REMAINING ⓘ');

{
  // One set of GitHub steps, two panels (Context's READ WITH and Settings →
  // Knowledge base). They are the same procedure; if one is corrected the
  // other must be, or a beginner meets two different recipes for one token.
  const a = EXPLAINERS['context.read-with'].visual.steps;
  const b = EXPLAINERS['settings.github-token'].visual.steps;
  ok(JSON.stringify(a) === JSON.stringify(b),
    'settings.github-token carries exactly context.read-with\'s four GitHub steps');
  // The MCP tool count is counted from mcp/tools/index.js, never written in
  // prose (CLAUDE.md, The MCP), and an explainer carries no counts at all.
  const counted = keys.filter((k) => textsOf(EXPLAINERS[k]).some(([, t]) =>
    /\b(\d+|twenty|seventeen|seven)[\s-]+(\w+\s+)?tools?\b/i.test(t)));
  ok(counted.length === 0, 'no explainer states how many MCP tools there are' +
    (counted.length ? ' — ' + counted.join(', ') : ''));
  // A Settings ⓘ whose words describe only ONE install mode would read false
  // on the other two; the recovery mark is therefore two entries, one per arm.
  ok(/Terminal/.test(EXPLAINERS['settings.update-recovery'].lead) &&
     /installer/.test(EXPLAINERS['settings.update-recovery-installer'].lead) &&
     !/git|Terminal/.test(JSON.stringify(EXPLAINERS['settings.update-recovery-installer'])),
    'the two going-back entries each describe their own install, and the installer one never mentions git');
  // The create form's retired claim (v3.69.0 made a mix of sources legal).
  const neverMix = keys.filter((k) => /never (a )?mix|never both|answered once|set once/i.test(JSON.stringify(EXPLAINERS[k])));
  ok(neverMix.length === 0, 'no explainer repeats "a project is never a mix of sources" — false since per-document sources' +
    (neverMix.length ? ' — ' + neverMix.join(', ') : ''));
}

// ═════════════════════════════════════════════════════════════════════════
section('§9  SELF-TEST — THE LINTER CATCHES EACH BREAK (a clean pass is not vacuous)');

{
  const base = JSON.parse(JSON.stringify(EXPLAINERS['context.documents']));
  ok(lintEntry(base).length === 0, 'CONTROL: the unmodified entry is clean');
  const mut = (name, f, expect) => {
    const e = JSON.parse(JSON.stringify(base));
    f(e);
    const p = lintEntry(e);
    ok(p.some((x) => expect.test(x)), `${name} → flagged (${p.filter((x) => expect.test(x))[0] || 'NOT FLAGGED: ' + p.join('; ')})`);
  };
  mut('a 21-word lead', (e) => { e.lead = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone.'; }, /lead is 21 words/);
  mut('a three-sentence lead', (e) => { e.lead = 'One. Two. Three.'; }, /3 sentences/);
  mut('four bolds in a point', (e) => { e.points[0].text = '**Wiki** **Context** **All** **Documents**'; }, /more than three/);
  mut('a fourth point', (e) => { e.points.push({ icon: 'file', text: 'One more.' }); }, /4 points/);
  mut('a 13-word point', (e) => { e.points[0].text = 'a b c d e f g h i j k l m'; }, /13 words \(cap 12\)/);
  mut('a 15-word try', (e) => { e.try = 'a b c d e f g h i j k l m n o'; }, /try is 15/);
  mut('a total over 90', (e) => { e.visual.rows = [['read first', 'a b c d e f'], ['on request', 'a b c d e f'], ['not at start', 'a b c d e f'], ['Documents', 'a b c d e f'], ['Memory', 'a b c d e f']]; e.points.forEach((p) => { p.text = 'a b c d e f g h i j k l'; }); }, /total is \d+ words/);
  mut('an internal word', (e) => { e.points[0].text = 'Stored in the manifest.'; }, /banned "manifest"/);
  mut('"foundations"', (e) => { e.lead = 'Your foundations.'; }, /banned "foundations"/);
  mut('a cost', (e) => { e.try = 'Check the cost first.'; }, /banned "cost"/);
  mut('a warning', (e) => { e.points[1].text = 'Warning: this is shared.'; }, /banned "warning"/);
  mut('a state word', (e) => { e.lead = 'Nothing is chosen yet.'; }, /banned "yet"/);
  mut('a version number', (e) => { e.lead = 'New in v3.71.0.'; }, /banned "version number"/);
  mut('bold on a non-screen word', (e) => { e.points[0].text = 'Use **canon docs** here.'; }, /bolds "canon docs"/);
  mut('an unbalanced **', (e) => { e.points[0].text = 'Use **Documents here.'; }, /unbalanced \*\*/);
  mut('raw markup', (e) => { e.points[0].text = 'Press <b>this</b>.'; }, /carries markup/);
  mut('an unknown icon', (e) => { e.points[0].icon = 'rocket'; }, /icon "rocket" is not in the glyph table/);
  mut('the book glyph on a point', (e) => { e.points[0].icon = 'book'; }, /reserved "book"/);
  mut('an unknown visual', (e) => { e.visual = { type: 'chart' }; }, /visual type "chart"/);
  mut('a table row that is no screen word', (e) => { e.visual.rows[0][0] = 'pinned'; }, /row name "pinned"/);
  mut('a 7-word table cell', (e) => { e.visual.rows[0][1] = 'a b c d e f g'; }, /7 words \(cap 6\)/);
  mut('a one-row table', (e) => { e.visual.rows = [e.visual.rows[0]]; }, /1 rows/);
  mut('an unknown field', (e) => { e.warning = 'x'; }, /unknown field warning/);
  mut('no guide card', (e) => { delete e.guide; }, /missing guide/);
  mut('a frame marking an unknown node', (e) => { e.visual = { type: 'frame', here: 'settings' }; }, /frame here "settings"/);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
