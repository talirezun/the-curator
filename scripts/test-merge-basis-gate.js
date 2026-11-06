#!/usr/bin/env node
/**
 * scripts/test-merge-basis-gate.js — OFFLINE
 *
 * "Preview before Merge" was enforced only in the browser: POST /fix with
 * type semanticDupe and no preview ever requested returned 200 and deleted the
 * page (the Wiki health audit, reproduced). The route now requires the comparison's
 * `basis`: a hash of both pages' current text, with the direction in it.
 *
 * ── WHAT THIS PINS ────────────────────────────────────────────────────────
 *   1. No preview, no basis: refused with a stable code, and nothing changes.
 *   2. The comparison: both originals verbatim, links at each (dumb cross-check),
 *      the basis, nameRelation, and that nothing is lost (read back after merging).
 *   3. A matching basis merges. A stale one (any edit, even far below the opening)
 *      or one for the other direction is refused, and nothing changes.
 *   4. Both settings of MERGE_BASIS_CLIENT_REQUIRED, and the interlock with the view.
 *   5. What the gate leaves alone: a gone page and an invalid pair keep their own
 *      reasons, other fix types are not gated, a mirror is refused first.
 *   6. Batch merge: decided by its own server rule, with no basis, and a direct POST
 *      still cannot delete a pair that rule refuses.
 *   7. The MCP: preview token bound to direction and text; its plan stays small.
 *   8. nameRelation.
 *
 * ── METHOD ────────────────────────────────────────────────────────────────
 * The real router on an ephemeral port, real files, a fake LLM through the
 * `opts.generateText` seam, isolated user-data and domains dirs.
 *
 * ── NOT ENFORCED ──────────────────────────────────────────────────────────
 *   • Whether a person read the comparison: that is the view's 500 ms rule.
 *   • A client that computes the hash itself: the basis says the pages are the ones
 *     compared, not who compared them. The route is on 127.0.0.1 behind the
 *     cross-origin guard, which this suite does not mount.
 *   • A write by Obsidian between this check and the merge's own read, milliseconds
 *     apart. The file lock covers the app and the MCP, not other programs.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { createServer } from 'http';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_DIR = mkdtempSync(path.join(os.tmpdir(), 'curator-basis-user-'));
const DOMAINS_DIR = mkdtempSync(path.join(os.tmpdir(), 'curator-basis-domains-'));
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DIR;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
process.env.GEMINI_API_KEY = 'fake-key-never-sent';
process.env.LLM_PROVIDER = 'gemini';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.LLM_MODEL;

const { __setDomainsDirOverride } = await import(path.join(REPO, 'src/brain/config.js'));
__setDomainsDirOverride(DOMAINS_DIR);
const ai = await import(path.join(REPO, 'src/brain/health-ai.js'));
const dc = await import(path.join(REPO, 'src/brain/duplicate-checks.js'));
const routes = await import(path.join(REPO, 'src/routes/health.js'));
const { fixWikiIssueHandler } = await import(path.join(REPO, 'mcp/tools/health.js'));
const { createStorageAdapter } = await import(path.join(REPO, 'mcp/storage/local.js'));
const { default: express } = await import('express');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/health', routes.default);
const server = createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/api/health`;
const post = async (p, body) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* an SSE stream */ }
  return { status: res.status, body: json, text };
};
const storage = createStorageAdapter({ domainsPath: DOMAINS_DIR });

let passed = 0, failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }

const KEEP_TEXT = `---\ntype: concept\n---\n\n# Data privacy\n\nThe kept page's opening.\n\n## History\n\nIt began long ago.\n\n## Key Facts\n\n- kept fact\n`;
const REMOVE_TEXT = `---\ntype: concept\n---\n\n# Data privacy law\n\nThe removed page's opening.\n\n## Enforcement\n\nRegulators act.\n\n## Key Facts\n\n- removed fact\n- links to [[other-page]]\n`;
let seq = 0;
function fixture(extra = {}) {
  const name = 'basis' + (++seq);
  const wiki = path.join(DOMAINS_DIR, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(DOMAINS_DIR, name, 'CLAUDE.md'), extra.claude || '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  writeFileSync(path.join(wiki, 'concepts/data-privacy.md'), KEEP_TEXT);
  writeFileSync(path.join(wiki, 'concepts/data-privacy-law.md'), REMOVE_TEXT);
  writeFileSync(path.join(wiki, 'concepts/other-page.md'), '# Other\n\nLinks: [[data-privacy-law]] and [[concepts/data-privacy-law|the law]] and [[data-privacy]].\n');
  writeFileSync(path.join(wiki, 'summaries/source-a.md'), '# Source\n\n- [[data-privacy-law]]\n');
  return { name, wiki, keepFile: path.join(wiki, 'concepts/data-privacy.md'), removeFile: path.join(wiki, 'concepts/data-privacy-law.md') };
}
const PAIR = { keepFolder: 'concepts', keepSlug: 'data-privacy', removeFolder: 'concepts', removeSlug: 'data-privacy-law' };
const FLIPPED = { keepFolder: 'concepts', keepSlug: 'data-privacy-law', removeFolder: 'concepts', removeSlug: 'data-privacy' };
const unchanged = (d) => readFileSync(d.keepFile, 'utf8') === KEEP_TEXT && readFileSync(d.removeFile, 'utf8') === REMOVE_TEXT;
const fix = (d, issue, extra = {}) => post(`/${d.name}/fix`, { type: 'semanticDupe', issue, ...extra });
const preview = (d, issue) => post(`/${d.name}/semantic-dupes/preview`, { issue });

// ═══════════════════════════════════════════════════════════════════════════
section('1. No preview and no basis: refused, nothing changes (both settings)');
for (const strict of [false, true]) {
  routes.__setMergeBasisClientRequiredForTest(strict);
  const d = fixture();
  const r = await fix(d, PAIR);
  ok(r.status === 409 && r.body.code === 'MERGE_BASIS_MISSING', `1.1 strict=${strict}: refused with the stable code`, JSON.stringify(r.body));
  ok(/nothing was changed/i.test(r.body.error), `1.2 strict=${strict}: the message says nothing changed`);
  ok(r.body.fixed === 0, `1.3 strict=${strict}: fixed is 0`);
  ok(unchanged(d), `1.4 strict=${strict}: both pages are byte-identical (today this deleted the page)`);
  const empty = await fix(d, PAIR, { basis: '' });
  ok(empty.status === 409 && empty.body.code === 'MERGE_BASIS_MISSING' && unchanged(d), `1.5 strict=${strict}: an empty basis is no basis`);
  const wrongType = await fix(d, PAIR, { basis: { not: 'a string' } });
  ok(wrongType.status === 409 && unchanged(d), `1.6 strict=${strict}: a basis that is not a string is refused`);
}
routes.__setMergeBasisClientRequiredForTest(null);

// ═══════════════════════════════════════════════════════════════════════════
section('2. The comparison');
{
  const d = fixture();
  const r = await preview(d, PAIR);
  ok(r.status === 200 && /^[0-9a-f]{64}$/.test(r.body.basis), '2.1 preview returns a sha-256 basis', JSON.stringify(r.body).slice(0, 200));
  ok(r.body.originals.keep.text === KEEP_TEXT, '2.2 the page that stays, verbatim');
  ok(r.body.originals.remove.text === REMOVE_TEXT, '2.3 the page that goes away, verbatim');
  ok(r.body.originals.keep.length === KEEP_TEXT.length && r.body.originals.keep.truncated === false, '2.4 length, and not truncated');
  // Dumb cross-check of the link counts: a plain substring count, not the pattern.
  const count = (slug) => {
    let files = 0, links = 0;
    for (const rel of ['concepts/other-page.md', 'summaries/source-a.md', 'concepts/data-privacy.md', 'concepts/data-privacy-law.md']) {
      if (rel === `concepts/${slug}.md`) continue;
      const text = readFileSync(path.join(d.wiki, rel), 'utf8');
      const n = text.split(`[[${slug}]]`).length - 1 + text.split(`[[${slug}|`).length - 1
        + text.split(`[[concepts/${slug}]]`).length - 1 + text.split(`[[concepts/${slug}|`).length - 1;
      if (n) { files++; links += n; }
    }
    return { files, links };
  };
  const inR = r.body.originals.remove.linksIn;
  const inK = r.body.originals.keep.linksIn;
  ok(inR.links === count('data-privacy-law').links && inR.files === count('data-privacy-law').files && inR.links === 3, '2.5 links at the page that goes, against a substring count', JSON.stringify(inR));
  ok(inK.links === count('data-privacy').links && inK.links === 1, '2.6 links at the page that stays', JSON.stringify(inK));
  ok(r.body.nameRelation === 'different-names', '2.7 nameRelation is on the preview');
  ok(r.body.mergeOutcome.lostLines === 0, '2.8 the preview states no text is lost');
  ok(r.body.mergeOutcome.movedUnder === 'Merged from data-privacy-law', '2.9 and names the heading the moved text goes under', JSON.stringify(r.body.mergeOutcome));

  // The statement, against the file: every non-blank body line of both pages is on
  // the kept page after a real merge, and the preview equalled what was written.
  const planned = r.body.mergedPreview;
  const m = await fix(d, PAIR, { basis: r.body.basis });
  ok(m.status === 200 && m.body.fixed === 1, '2.10 the merge with that basis runs', JSON.stringify(m.body));
  ok(!existsSync(d.removeFile), '2.11 the removed page is gone');
  const after = readFileSync(d.keepFile, 'utf8');
  const lines = (t) => t.split('\n').map((l) => l.trim()).filter((l) => l && l !== '---' && !l.startsWith('type:') && !l.startsWith('#'));
  const missing = [...lines(KEEP_TEXT), ...lines(REMOVE_TEXT)].filter((l) => !after.includes(l));
  ok(missing.length === 0, '2.12 "nothing lost" holds against the file, read back', missing.join(' | '));
  ok(planned === after.slice(0, 4000), '2.13 the merged preview is what was written');

  const big = fixture();
  const longText = KEEP_TEXT + 'x'.repeat(70000) + '\n';
  writeFileSync(big.keepFile, longText);
  const rb = await preview(big, PAIR);
  ok(rb.body.originals.keep.truncated === true && rb.body.originals.keep.length === longText.length && rb.body.originals.keep.text.length === 60000, '2.14 a long page says it was cut, and its real length');
  ok(rb.status === 200, '2.15 the basis still covers the whole page, past the cut');
  writeFileSync(big.keepFile, longText + 'edit past the cut\n');
  const rc = await fix(big, PAIR, { basis: rb.body.basis });
  ok(rc.status === 409 && rc.body.code === 'MERGE_BASIS_STALE', '2.16 an edit past the cut still makes the basis stale');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. Stale and wrong-way bases (both settings)');
for (const strict of [false, true]) {
  routes.__setMergeBasisClientRequiredForTest(strict);
  {
    const d = fixture();
    const { body } = await preview(d, PAIR);
    const edited = REMOVE_TEXT + '\n## A new section far below the opening\n\nnew text\n';
    writeFileSync(d.removeFile, edited);
    const r = await fix(d, PAIR, { basis: body.basis });
    ok(r.status === 409 && r.body.code === 'MERGE_BASIS_STALE', `3.1 strict=${strict}: an edit far below the opening is stale`, JSON.stringify(r.body));
    ok(/nothing was changed/i.test(r.body.error), `3.2 strict=${strict}: says nothing changed`);
    ok(readFileSync(d.removeFile, 'utf8') === edited && readFileSync(d.keepFile, 'utf8') === KEEP_TEXT, `3.3 strict=${strict}: nothing was written or deleted`);
    const fresh = await preview(d, PAIR);
    ok(fresh.body.basis !== body.basis, `3.4 strict=${strict}: comparing again gives a new basis`);
    const m = await fix(d, PAIR, { basis: fresh.body.basis });
    ok(m.body.fixed === 1 && !existsSync(d.removeFile), `3.5 strict=${strict}: and that one merges`);
  }
  {
    const d = fixture();
    const { body } = await preview(d, PAIR);
    const r = await fix(d, FLIPPED, { basis: body.basis });
    ok(r.status === 409 && r.body.code === 'MERGE_BASIS_STALE' && unchanged(d), `3.6 strict=${strict}: a basis for the other direction is refused, nothing changes`, JSON.stringify(r.body));
  }
  {
    const d = fixture();
    const r = await fix(d, PAIR, { basis: 'a'.repeat(64) });
    ok(r.status === 409 && r.body.code === 'MERGE_BASIS_STALE' && unchanged(d), `3.7 strict=${strict}: a made-up basis is refused`);
  }
}
routes.__setMergeBasisClientRequiredForTest(null);

// ═══════════════════════════════════════════════════════════════════════════
section('4. The two settings, and the landing order');
{
  routes.__setMergeBasisClientRequiredForTest(false);
  let d = fixture();
  await preview(d, PAIR);
  let r = await fix(d, PAIR);
  ok(r.body.fixed === 1 && !existsSync(d.removeFile), '4.1 transition: Preview then Merge with no basis works, as today\'s view does it');

  d = fixture();
  await preview(d, FLIPPED);
  r = await fix(d, PAIR);
  ok(r.status === 409 && r.body.code === 'MERGE_BASIS_MISSING' && unchanged(d), '4.2 transition: a preview the other way round does not open this direction');

  d = fixture();
  await preview(d, PAIR);
  const edited = KEEP_TEXT + '\nmore\n';
  writeFileSync(d.keepFile, edited);
  r = await fix(d, PAIR);
  ok(r.status === 409 && readFileSync(d.keepFile, 'utf8') === edited && existsSync(d.removeFile), '4.3 transition: a preview of older text does not open it');

  // A preview of one domain's pair does not open the same-named pair elsewhere.
  const other = fixture();
  d = fixture();
  await preview(other, PAIR);
  r = await fix(d, PAIR);
  ok(r.status === 409 && unchanged(d), '4.4 transition: a preview in another domain does not open it');

  routes.__setMergeBasisClientRequiredForTest(true);
  d = fixture();
  await preview(d, PAIR);
  r = await fix(d, PAIR);
  ok(r.status === 409 && r.body.code === 'MERGE_BASIS_MISSING' && unchanged(d), '4.5 strict: a preview without sending its basis is refused');
  routes.__setMergeBasisClientRequiredForTest(null);

  // THE INTERLOCK. Each landing order is safe, and this goes red on the wrong end
  // state: strict with a view that sends nothing would break every Merge, and a view
  // that sends the basis with strict still off leaves the transition path open.
  const view = readFileSync(path.join(REPO, 'src/public/next/views/domains.js'), 'utf8');
  const line = view.split('\n').find((l) => l.includes("type: 'semanticDupe', issue: toWirePair(pair)"));
  ok(!!line, '4.6 the view\'s merge call is where this suite looks for it');
  const viewSends = !!line && /\bbasis\b/.test(line);
  ok(viewSends === routes.__MERGE_BASIS_CLIENT_REQUIRED,
    '4.7 MERGE_BASIS_CLIENT_REQUIRED (routes/health.js) is true exactly when the view sends the basis',
    `view sends basis: ${viewSends}; constant: ${routes.__MERGE_BASIS_CLIENT_REQUIRED}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. What the gate leaves alone');
{
  const d = fixture();
  rmSync(d.removeFile);
  const r = await fix(d, PAIR);
  ok(r.status === 200 && r.body.fixed === 0 && r.body.reason === 'remove-page-missing' && r.body.missing === 'concepts/data-privacy-law',
    '5.1 a gone page keeps its reason: the view marks the pair resolved from it', JSON.stringify(r.body));
  const invalid = await fix(d, { keepFolder: '../..', keepSlug: 'x', removeFolder: 'concepts', removeSlug: 'y' });
  ok(invalid.status === 200 && invalid.body.reason === 'semantic-pair-invalid', '5.2 an invalid pair keeps its reason', JSON.stringify(invalid.body));
  const bulk = await post(`/${d.name}/fix`, { type: 'semanticDupe' });
  ok(bulk.status === 200 && bulk.body.fixed === 0 && bulk.body.total === 0, '5.3 no issue is the old no-op, and deletes nothing');

  const f = fixture();
  writeFileSync(path.join(f.wiki, 'concepts/prefix.md'), '# P\n\nSee [[concepts/other-page]].\n');
  const free = await post(`/${f.name}/fix`, { type: 'folderPrefixLinks', issue: { sourceFile: 'concepts/prefix.md', linkText: 'concepts/other-page' } });
  ok(free.status === 200 && free.body.fixed === 1, '5.4 other fix types are not gated', JSON.stringify(free.body));

  const m = fixture({ claude: '---\nreadonly: true\n---\n# mirror\n' });
  const mirror = await fix(m, PAIR);
  ok(mirror.status === 400 && /read-only/.test(mirror.body.error) && unchanged(m), '5.5 a mirror is refused first, as it always was', JSON.stringify(mirror.body));
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. Batch merge keeps its own server rule');
{
  const name = 'basis' + (++seq);
  const wiki = path.join(DOMAINS_DIR, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(DOMAINS_DIR, name, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  const page = (t) => `---\ntype: concept\n---\n\n# ${t}\n\nAbout ${t}.\n`;
  for (const s of ['hand-off', 'handoff', 'privacy-law', 'privacy-laws-eu']) writeFileSync(path.join(wiki, `concepts/${s}.md`), page(s));
  const llm = async (sys, user) => {
    const results = [];
    for (const m of user.matchAll(/--- PAIR (\d+) ---\nA: \[([^\]]+)\]/g)) results.push({ index: Number(m[1]), relation: 'same', confidence: 'high', canonicalSlug: m[2].split('/')[1], rationale: 'because' });
    return JSON.stringify({ results });
  };
  await ai.scanSemanticDuplicates(name, { maxPairs: 500, costCeilingTokens: 1e9, generateText: llm }, () => {});
  const send = (pairs) => post(`/${name}/semantic-dupes/merge-batch`, { pairs });
  const notVariant = { keepFolder: 'concepts', keepSlug: 'privacy-law', removeFolder: 'concepts', removeSlug: 'privacy-laws-eu', confidence: 'high', basis: 'a'.repeat(64) };
  const r = await send([notVariant]);
  ok(/"status":"ineligible"/.test(r.text) && existsSync(path.join(wiki, 'concepts/privacy-laws-eu.md')), '6.1 a direct batch POST cannot delete a pair the rule refuses, whatever it carries');
  const variant = { keepFolder: 'concepts', keepSlug: 'handoff', removeFolder: 'concepts', removeSlug: 'hand-off' };
  const v = await send([variant]);
  ok(/"merged":1/.test(v.text) && !existsSync(path.join(wiki, 'concepts/hand-off.md')), '6.2 an eligible spelling variant merges with no basis: nobody previews a batch', v.text.slice(-200));
  const again = await post(`/${name}/fix`, { type: 'semanticDupe', issue: { keepFolder: 'concepts', keepSlug: 'privacy-law', removeFolder: 'concepts', removeSlug: 'privacy-laws-eu' } });
  ok(again.status === 409 && existsSync(path.join(wiki, 'concepts/privacy-laws-eu.md')), '6.3 a remembered high answer does not open the single-pair route');
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. The MCP: its own gate, bound to direction and text');
{
  const call = (d, issue, previewFlag) => fixWikiIssueHandler({ domain: d.name, type: 'semanticDupe', issue, preview: previewFlag }, storage);
  let d = fixture();
  let r = await call(d, PAIR, false);
  ok(r.ok === false && /preview first/.test(r.error) && unchanged(d), '7.1 no preview in this session: refused, as before');

  d = fixture();
  const p = await call(d, PAIR, true);
  ok(p.ok === true && p.plan.keepPath === 'concepts/data-privacy.md', '7.2 preview returns the plan');
  ok(p.plan.originals === undefined, '7.3 the plan carries no page text: a model\'s preview stays its old size');
  ok(unchanged(d), '7.4 a preview writes nothing');
  r = await call(d, PAIR, false);
  ok(r.ok === true && r.fixed === 1 && !existsSync(d.removeFile), '7.5 preview then commit merges', JSON.stringify(r).slice(0, 200));
  writeFileSync(d.removeFile, REMOVE_TEXT);
  r = await call(d, PAIR, false);
  ok(r.ok === false && /preview first/.test(r.error) && existsSync(d.removeFile), '7.6 the token was consumed: each merge needs its own preview');

  d = fixture();
  await call(d, PAIR, true);
  r = await call(d, FLIPPED, false);
  ok(r.ok === false && r.reason === 'preview-stale' && unchanged(d), '7.7 a preview does not authorise the other direction (it did: the key is order-insensitive)', JSON.stringify(r).slice(0, 200));

  d = fixture();
  await call(d, PAIR, true);
  const edited = REMOVE_TEXT + '\nA later edit.\n';
  writeFileSync(d.removeFile, edited);
  r = await call(d, PAIR, false);
  ok(r.ok === false && r.reason === 'preview-stale' && readFileSync(d.removeFile, 'utf8') === edited && readFileSync(d.keepFile, 'utf8') === KEEP_TEXT, '7.8 a page edited after the preview is refused (it merged)', JSON.stringify(r).slice(0, 200));
  ok(/nothing was written/i.test(r.report) && /preview: true/.test(r.report), '7.9 the report says what to do');

  d = fixture();
  await call(d, PAIR, true);
  rmSync(d.removeFile);
  r = await call(d, PAIR, false);
  ok(r.fixed === 0 && r.reason === 'remove-page-missing', '7.10 a gone page keeps its own answer', JSON.stringify(r).slice(0, 200));
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. nameRelation');
{
  const cases = [
    ['hand-off', 'handoff', 'spelling-variant'],
    ['neural-network', 'neural-networks', 'spelling-variant'],
    ['gpt_4_1', 'gpt-4-1', 'spelling-variant'],
    ['claude-opus-4.6', 'claude-opus-4.7', 'version-differs'],
    ['gpt-4-1', 'gpt-41', 'version-differs'],
    ['gemini', 'gemini-3', 'version-differs'],
    ['gemini-3-flash', 'gemini-2-flash', 'version-differs'],
    ['iphone-14', 'iphone-14s', 'different-names'],
    ['gpt-4', 'gpt-4o', 'different-names'],
    ['data-privacy', 'data-privacy-law', 'different-names'],
    ['2024', '2025', 'different-names'],
    ['rag', 'retrieval-augmented-generation', 'different-names'],
    ['gpt-4.0', 'gpt-4', 'version-differs'],
  ];
  for (const [a, b, want] of cases) {
    ok(dc.nameRelation(a, b) === want && dc.nameRelation(b, a) === want, `8. ${a} / ${b}: ${want}`, `got ${dc.nameRelation(a, b)}`);
  }
}

server.close();
rmSync(USER_DIR, { recursive: true, force: true });
rmSync(DOMAINS_DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
