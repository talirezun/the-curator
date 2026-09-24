#!/usr/bin/env node
/**
 * OFFLINE — v3.69.0: ONE PROJECT, MANY SOURCES, as the VIEW shows it.
 *
 * The maintainer retired "a project has one source": a document is written
 * here, copied in from a folder, or mirrored from a folder or a GitHub
 * repository (up to 8 source groups), and one project may hold all four
 * kinds at once. So every decision the Documents step makes moves from the
 * project's `ownership` to the DOCUMENT (CONTRACT v3.69.0 §1.6, §3.4, §4, §5,
 * §7 package C). This suite drives the DOM-free rules in
 * src/public/next/shared/foundations-sources.js and foundations-add.js, and
 * the LIFTED renderers of views/memory.js, against FIXTURES of the contract's
 * documented response shapes — the routes that produce them are built after
 * this package (package B), so nothing here reaches a server:
 *
 *   v1-derived (no `sources[]`, the pre-v3.69.0 envelope):
 *     kept-only · folder mirror · GitHub mirror
 *   v2-derived (the §3.4 `sources[]` and per-row `source.group`):
 *     kept-only · folder mirror · GitHub mirror · MIXED with 3 groups
 *   a repo-scan listing with a COLLISION (`alreadyAdded`, `alreadyAs`, `landsAs`)
 *
 * and asserts: both doors always enabled (§4.1); the D2 Keep in sync / Copy
 * once default (§4.2); the checklist reads the SERVER's annotations only
 * (§4.3); the sources strip (§4.4); the per-row words (§3.4); the trash icon
 * on every row and the pencil on kept rows only (§5.1); the ONE delete
 * sentence per kind, identical from the row and from the editor (§5.2); the
 * origin clause; and a CENSUS that no view decision branches on `ownership`.
 *
 * Run with:  node scripts/test-foundations-sources-view.js   (exit 0 = all green)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, 'src/public/next');
const FSRC = await import('../src/public/next/shared/foundations-sources.js');
const FA = await import('../src/public/next/shared/foundations-add.js');
const FI = await import('../src/public/next/shared/foundations-init.js');
const { renderDepthCell } = await import('../src/public/next/shared/monitor.js');
const viewSrc = readFileSync(join(NEXT, 'views/memory.js'), 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 600) : '')); }
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function section(t) { console.log('\n' + t); }
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const text = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');

// ── Extraction (brace-matched; THROWS on a missing name) ─────────────────
function extractFunction(source, name) {
  const m = new RegExp('(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ' + name + '\\s*\\(').exec(source);
  if (!m) throw new Error('extractFunction: "' + name + '" not found');
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = source.indexOf('(', start);
  let pd = 0;
  for (; p < source.length; p++) {
    if (source[p] === '(') pd++;
    else if (source[p] === ')') { pd--; if (pd === 0) { p++; break; } }
  }
  let i = source.indexOf('{', p);
  let d = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') d++;
    else if (source[i] === '}') { d--; if (d === 0) { i++; break; } }
  }
  return source.slice(start, i).replace(/^export\s+/, '');
}
function constSrc(name) {
  const m = new RegExp('^const ' + name + ' = ([\\s\\S]*?);\\n', 'm').exec(viewSrc);
  if (!m) throw new Error('const ' + name + ' not found');
  return 'const ' + name + ' = ' + m[1] + ';\n';
}

// ═════════════════════════════════════════════════════════════════════════
// THE FIXTURES — the contract's documented response shapes (§3.4, §4.3, §5.4)
// ═════════════════════════════════════════════════════════════════════════
const T0 = '2026-09-22T10:00:00.000Z';
const doc = (slug, over) => ({ slug, role: 'other', title: slug.replace(/\.md$/, ''), bytes: 2048,
  sha256: 'a'.repeat(64), updatedAt: T0, authoredBy: { kind: 'human' }, skeleton: false,
  readFirst: false, hidden: false, freshness: 'n/a', source: { kind: 'curator' }, ...over });
const envelope = (docs, over) => ({ present: true, ownership: 'curator', repo: null, budgetBytes: 204800,
  totalBytes: docs.reduce((a, d) => a + d.bytes, 0), documents: docs, orphanFiles: [], manifestError: null,
  ...over });
const group = (id, over) => ({ id, kind: 'folder', label: 'second-brain', reachableHere: true, remote: null,
  lastRefreshAt: T0, lastRefreshCommit: 'c'.repeat(40), documentCount: 0, ...over });

const F = {};
// v1-derived: exactly what a v3.68 route sends (no `sources`, no `group`).
F.v1Kept = envelope([doc('notes.md'), doc('dev-arch.md', { copiedFrom: 'dev' })]);
F.v1Folder = envelope([
  doc('decisions.md', { source: { kind: 'repo', path: 'docs/dev/decisions.md' }, freshness: 'fresh', commit: 'b'.repeat(40) }),
  doc('roadmap.md', { source: { kind: 'repo', path: 'docs/roadmap.md' }, freshness: 'stale' }),
], { ownership: 'repo', repo: { root: '/Users/me/src/second-brain', remote: null, lastRefreshAt: T0, lastRefreshCommit: null } });
F.v1GitHub = envelope([
  doc('architecture.md', { source: { kind: 'repo', path: 'docs/architecture.md' }, freshness: 'unreachable' }),
], { ownership: 'repo', repo: { root: null, remote: { owner: 'acme', repo: 'lumina', ref: null, path: null },
  lastRefreshAt: T0, lastRefreshCommit: null } });
// v2-derived: the §3.4 `sources[]` and per-row `source.group`.
F.v2Kept = { ...F.v1Kept, sources: [] };
F.v2Folder = envelope(F.v1Folder.documents.map((d) => ({ ...d, source: { ...d.source, group: 's1' } })),
  { ownership: 'repo', sources: [group('s1', { documentCount: 2 })] });
F.v2GitHub = envelope(F.v1GitHub.documents.map((d) => ({ ...d, source: { ...d.source, group: 's1' } })),
  { ownership: 'repo', sources: [group('s1', { kind: 'github', label: 'acme/lumina', reachableHere: false,
    remote: { owner: 'acme', repo: 'lumina', ref: null, path: null }, documentCount: 1 })] });
// MIXED, 3 groups: a folder here (with origin recorded), a GitHub repository,
// a folder that is NOT on this computer and has no remote — plus a written,
// a copied and a skeleton document.
F.mixed = envelope([
  doc('decisions-agents.md', { role: 'decisions', source: { kind: 'repo', path: 'docs/dev/decisions-agents.md', group: 's1' },
    freshness: 'fresh', commit: 'b'.repeat(40), readFirst: true }),
  doc('roadmap.md', { source: { kind: 'repo', path: 'docs/roadmap.md', group: 's1' }, freshness: 'stale' }),
  doc('lumina-architecture.md', { role: 'architecture', source: { kind: 'repo', path: 'docs/architecture.md', group: 's2' },
    freshness: 'unreachable' }),
  doc('field-notes.md', { source: { kind: 'repo', path: 'field-notes.md', group: 's3' }, freshness: 'unreachable' }),
  doc('notes.md', { authoredBy: { kind: 'agent', tool: 'save_foundation' } }),
  doc('dev-arch.md', { copiedFrom: 'dev' }),
  doc('conventions.md', { role: 'conventions', skeleton: true }),
], { ownership: 'mixed', sources: [
  group('s1', { documentCount: 2, remote: { owner: 'talirezun', repo: 'second-brain', ref: null, path: null } }),
  group('s2', { kind: 'github', label: 'acme/lumina', reachableHere: false,
    remote: { owner: 'acme', repo: 'lumina', ref: 'main', path: null }, lastRefreshAt: null, documentCount: 1 }),
  group('s3', { label: 'field-notes', reachableHere: false, documentCount: 1, lastRefreshAt: null }),
] });
// A repo-scan listing with a COLLISION (§4.3, §4.5).
const SCAN = {
  ok: true, root: '/Users/me/src/lumina-docs', inGitCheckout: true,
  candidates: [
    { path: 'architecture.md', bytes: 4096, suggestedSlug: 'architecture.md', tooLarge: false,
      alreadyAdded: false, alreadyAs: null, landsAs: 'architecture-lumina-docs.md' },
    { path: 'roadmap.md', bytes: 1024, suggestedSlug: 'roadmap.md', tooLarge: false,
      alreadyAdded: true, alreadyAs: 'roadmap-lumina-docs.md', landsAs: 'roadmap-lumina-docs.md' },
    { path: 'guide/setup.md', bytes: 512, suggestedSlug: 'setup.md', tooLarge: false,
      alreadyAdded: false, alreadyAs: null, landsAs: 'setup.md' },
  ],
};

// ═════════════════════════════════════════════════════════════════════════
// THE LIFTED VIEW — memory.js's own renderers, with their real collaborators
// ═════════════════════════════════════════════════════════════════════════
const stateBox = {};
const V = new Function('state', 'escapeHtml', 'icon', 'renderMarkdown', 'renderStatus', 'renderDescription',
  'renderRoleOptions', 'FOUNDATION_ROLES', 'FOUNDATION_SLUG_RE', 'MAX_FOUNDATION_BYTES', 'FOUNDATIONS_BUDGET_BYTES',
  'formatBytes', 'renderDepthCell', 'renderListboxHtml', 'fndSuggestCellHtml', 'FSRC',
  'const READ_FIRST_BUDGET_BYTES = 120 * 1024;\n' + constSrc('START_STATES')
  + ['skeletonOf', 'copiedFromOf', 'formatAge', 'fndSize', 'fndStartOf', 'fndStartCfg', 'foundationsFacts',
    'foundationsOwnershipWord', 'foundationsWord', 'foundationsSummaryMeta', 'foundationsUncheckedWhy',
    'fndRowHtml', 'renderFoundationStop', 'fndStats', 'fndSlugError', 'fndShrinkWarn', 'renderFoundationEditor']
    .map((n) => extractFunction(viewSrc, n)).join('\n')
  + '\nreturn { foundationsFacts, foundationsSummaryMeta, foundationsWord, foundationsUncheckedWhy, fndRowHtml, '
  + 'renderFoundationStop, renderFoundationEditor };')(
  stateBox, escapeHtml, () => '<svg></svg>', (t) => '<md>' + escapeHtml(t) + '</md>',
  (o) => '<div class="tx-status">' + escapeHtml(o.title) + escapeHtml(o.detail || '') + '</div>',
  (t) => '<p class="tx-desc">' + escapeHtml(t) + '</p>',
  FI.renderRoleOptions, FI.FOUNDATION_ROLES, FI.FOUNDATION_SLUG_RE, FI.MAX_FOUNDATION_BYTES,
  FI.FOUNDATIONS_BUDGET_BYTES, FI.formatBytes, renderDepthCell,
  (cfg) => '<button type="button" id="' + cfg.id + '"></button>', () => '<td></td>', FSRC);
const setState = (o) => { for (const k of Object.keys(stateBox)) delete stateBox[k]; Object.assign(stateBox, o); };
const facts = (env) => V.foundationsFacts({ foundations: env });
const row = (env, slug) => {
  const f = facts(env);
  const d = f.docs.find((x) => x.slug === slug);
  const keptOnly = f.count > 0 && f.kinds.folder + f.kinds.github === 0;
  return V.fndRowHtml(d, keptOnly, false, f.budgetBytes, undefined, f.sources);
};

// ═════════════════════════════════════════════════════════════════════════
section('§1 — the source groups, normalised: v1 and v2 of the same project agree');
// ═════════════════════════════════════════════════════════════════════════
{
  eq('a v1 kept-only project has no source', FSRC.sourcesOf(F.v1Kept).length, 0);
  eq('...and so does its v2 twin', FSRC.sourcesOf(F.v2Kept).length, 0);
  const strip = (g) => JSON.stringify({ id: g.id, kind: g.kind, label: g.label, remote: g.remote, documentCount: g.documentCount });
  eq('a v1 folder mirror reads as the ONE group s1, kind folder, labelled by the folder\'s basename',
    strip(FSRC.sourcesOf(F.v1Folder)[0]),
    JSON.stringify({ id: 's1', kind: 'folder', label: 'second-brain', remote: null, documentCount: 2 }));
  eq('...exactly what its v2 twin says', strip(FSRC.sourcesOf(F.v2Folder)[0]), strip(FSRC.sourcesOf(F.v1Folder)[0]));
  eq('a v1 GitHub mirror reads as s1, kind github, labelled owner/repo',
    strip(FSRC.sourcesOf(F.v1GitHub)[0]),
    JSON.stringify({ id: 's1', kind: 'github', label: 'acme/lumina',
      remote: { owner: 'acme', repo: 'lumina', ref: null, path: null }, documentCount: 1 }));
  eq('...exactly what its v2 twin says', strip(FSRC.sourcesOf(F.v2GitHub)[0]), strip(FSRC.sourcesOf(F.v1GitHub)[0]));
  eq('the mixed project has three groups', FSRC.sourcesOf(F.mixed).map((g) => g.id + ':' + g.kind).join(' '),
    's1:folder s2:github s3:folder');
  eq('no manifest has no source, whatever a stale `repo` says',
    FSRC.sourcesOf({ present: false, repo: { root: '/x' } }).length, 0);
  ok('the root PATH itself never reaches the model — only its basename, as the label',
    !JSON.stringify(FSRC.sourcesOf(F.v1Folder)).includes('/Users/me'), JSON.stringify(FSRC.sourcesOf(F.v1Folder)));
  eq('MAX_SOURCES_PER_PROJECT is the contract\'s 8', FSRC.MAX_SOURCES_PER_PROJECT, 8);
  ok('...and the step\'s ⓘ says the same number in words ("up to eight sources")',
    /from up to eight sources/.test(viewSrc) && FSRC.MAX_SOURCES_PER_PROJECT === 8);
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — every document\'s kind, and a dumb cross-check of the counts');
// ═════════════════════════════════════════════════════════════════════════
{
  const S = FSRC.sourcesOf(F.mixed);
  const kinds = F.mixed.documents.map((d) => d.slug + '=' + FSRC.rowKind(d, S)).join(' ');
  eq('the four kinds, per document', kinds,
    'decisions-agents.md=folder roadmap.md=folder lumina-architecture.md=github field-notes.md=folder '
    + 'notes.md=written dev-arch.md=copied conventions.md=written');
  // THE DUMB CROSS-CHECK: counted by hand from the fixture, not by the function.
  const f = facts(F.mixed);
  eq('kindCounts agrees with a hand count', JSON.stringify(f.kinds),
    JSON.stringify({ written: 2, copied: 1, folder: 3, github: 1 }));
  eq('a v1 GitHub row (no group named) is github by the ONE group', FSRC.rowKind(F.v1GitHub.documents[0],
    FSRC.sourcesOf(F.v1GitHub)), 'github');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — the per-row words (§3.4), from each row\'s OWN group');
// ═════════════════════════════════════════════════════════════════════════
{
  const S = FSRC.sourcesOf(F.mixed);
  const w = (slug) => FSRC.rowFreshWord(F.mixed.documents.find((d) => d.slug === slug), S);
  eq('folder group, reachable, fresh', w('decisions-agents.md').word, 'fresh');
  eq('...with the dot', w('decisions-agents.md').tier, 'recent');
  eq('folder group, reachable, stale', w('roadmap.md').word, 'stale');
  eq('github group → GitHub · not checked', w('lumina-architecture.md').word, 'GitHub · not checked');
  eq('folder group NOT here, no remote → source not here', w('field-notes.md').word, 'source not here');
  const notHereWithRemote = FSRC.rowFreshWord({ ...F.mixed.documents[0], freshness: 'unreachable' },
    S.map((g) => (g.id === 's1' ? { ...g, reachableHere: false } : g)));
  eq('folder group NOT here, remote recorded → GitHub · not checked', notHereWithRemote.word, 'GitHub · not checked');
  eq('written → today\'s state word, no dot', JSON.stringify(w('notes.md')),
    JSON.stringify({ word: 'written by an agent', tier: null, why: false }));
  eq('copied → today\'s state word', w('dev-arch.md').word, 'copied from dev');
  eq('skeleton → today\'s state word', w('conventions.md').word, 'skeleton · to fill');
  // A GITHUB row can never read "source not here" — even with no remote on
  // the group record (the label alone) and whatever its freshness says.
  const bare = [{ id: 's9', kind: 'github', label: 'o/r', reachableHere: false, remote: null, documentCount: 1 }];
  eq('a GitHub-group row reads "GitHub · not checked" even with no remote recorded',
    FSRC.rowFreshWord({ source: { kind: 'repo', path: 'a.md', group: 's9' }, freshness: 'unreachable' }, bare).word,
    'GitHub · not checked');
  // THE TABLE PAINTS THOSE WORDS
  const r = row(F.mixed, 'lumina-architecture.md');
  ok('the painted GitHub row says "GitHub · not checked", as a why-button',
    /data-fnd-why="lumina-architecture\.md"[^>]*>GitHub · not checked</.test(r), r);
  ok('the painted folder-not-here row says "source not here"', />source not here</.test(row(F.mixed, 'field-notes.md')));
  const why = V.foundationsUncheckedWhy(facts(F.mixed), 'lumina-architecture.md');
  ok('...and its "why?" names THAT row\'s repository', /acme\/lumina/.test(why.title), JSON.stringify(why));
  const why3 = V.foundationsUncheckedWhy(facts(F.mixed), 'field-notes.md');
  ok('...while the folder row\'s names ITS folder', /field-notes is not on this computer/.test(why3.title), JSON.stringify(why3));
  eq('the summary word counts a real missing folder as unreachable', V.foundationsWord(facts(F.mixed)), '1 stale');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — the row controls (§5.1): pencil on kept rows, trash on EVERY row');
// ═════════════════════════════════════════════════════════════════════════
{
  for (const d of F.mixed.documents) {
    const h = row(F.mixed, d.slug);
    const kept = !d.source || d.source.kind !== 'repo';
    ok('[' + d.slug + '] carries the trash icon, labelled, with no title=',
      new RegExp('class="btn btn-ghost btn-xs fnd-delete" data-fnd-delete="' + d.slug.replace(/\./g, '\\.')
        + '" aria-label="Delete [^"]+"><svg').test(h) && !/fnd-delete"[^>]*title=/.test(h), h);
    ok('[' + d.slug + '] ' + (kept ? 'carries' : 'does NOT carry') + ' the pencil',
      /data-fnd-edit=/.test(h) === kept, h);
  }
  const ro = (() => {
    const f = facts(F.mixed);
    return V.fndRowHtml(f.docs[0], false, true, f.budgetBytes, undefined, f.sources);
  })();
  ok('a read-only row carries neither', !/fnd-delete|fnd-edit/.test(ro));
  // THE TABLE VARIANT: kept-only keeps its State column; any mirror → Source + Freshness.
  ok('a kept-only project keeps its State column', /fnd-cell-state/.test(row(F.v2Kept, 'notes.md'))
    && !/fnd-cell-source/.test(row(F.v2Kept, 'notes.md')));
  ok('a mixed project\'s kept row says its kind in the Source cell', /fnd-cell-source">written here</.test(row(F.mixed, 'notes.md'))
    && /fnd-cell-source">copied in</.test(row(F.mixed, 'dev-arch.md')));
  ok('...and a mirrored row its path, with the group under it when there are several',
    /fnd-src-path">docs\/architecture\.md<[\s\S]*fnd-src-group">GitHub · acme\/lumina</.test(row(F.mixed, 'lumina-architecture.md')));
  ok('...but a single-source project shows no group label',
    !/fnd-src-group/.test(row(F.v2Folder, 'decisions.md')));
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — ONE delete sentence per kind (§5.2), escaped, exactly');
// ═════════════════════════════════════════════════════════════════════════
{
  const S = FSRC.sourcesOf(F.mixed);
  const c = (slug) => FSRC.deleteConfirmCopy(F.mixed.documents.find((d) => d.slug === slug), S);
  eq('written', text(c('notes.md').html), 'Delete notes.md? It was written in this project, so this is the only copy. '
    + 'It is removed from this project and from your agents’ next session, and cannot be undone from inside The '
    + 'Curator; if you sync, a git client can still recover it.');
  eq('...primary', c('notes.md').primary, 'Delete permanently');
  eq('written (skeleton)', text(c('conventions.md').html), 'Delete conventions.md? It is an unfilled template. '
    + 'It is removed from this project and from your agents’ next session.');
  eq('...primary', c('conventions.md').primary, 'Delete template');
  eq('copied', text(c('dev-arch.md').html), 'Delete dev-arch.md? Only this project’s copy is removed. The original '
    + 'in the folder dev is not touched. This copy was never kept in sync, so you can add it again at any time with '
    + 'Add from this computer.');
  eq('...primary', c('dev-arch.md').primary, 'Delete copy');
  eq('folder', text(c('roadmap.md').html), 'Delete roadmap.md? Only this project’s copy is removed. The original, '
    + 'docs/roadmap.md in the folder second-brain, is not touched. A refresh will not bring it back: it stops being '
    + 'mirrored. Add it again with Add from this computer.');
  eq('github — naming owner/repo, and the LAST-document clause', text(c('lumina-architecture.md').html),
    'Delete lumina-architecture.md? Only this project’s copy is removed. The original, docs/architecture.md on '
    + 'GitHub acme/lumina, is not touched. A refresh will not bring it back: it stops being mirrored. Add it again '
    + 'with Add from GitHub. This was the last document from acme/lumina, so that source is removed from the project too.');
  ok('the folder sentence bolds the slug, the folder and "not"',
    /<b>roadmap\.md<\/b>/.test(c('roadmap.md').html) && /<b>second-brain<\/b>/.test(c('roadmap.md').html)
    && /will <b>not<\/b> bring/.test(c('roadmap.md').html));
  ok('no mirror sentence says a refresh brings it back',
    ['roadmap.md', 'lumina-architecture.md', 'field-notes.md'].every((s) => !/refresh (will )?(bring|restore)s? it back(?! )/i
      .test(text(c(s).html).replace('A refresh will not bring it back', ''))));
  ok('every sentence that has an original says only THIS project\'s copy goes and the original is not touched',
    ['dev-arch.md', 'roadmap.md', 'lumina-architecture.md', 'field-notes.md']
      .every((s) => /Only this project’s copy is removed/.test(c(s).html) && /is not touched/.test(c(s).html)));
  const hostile = FSRC.deleteConfirmCopy({ slug: '<img src=x onerror=1>.md', source: { kind: 'repo', path: '"><script>', group: 'h' } },
    [{ id: 'h', kind: 'github', label: '<b>x</b>', remote: { owner: '<o>', repo: 'r"', ref: null, path: null }, documentCount: 2 }]);
  ok('every interpolated value is escaped', !/<img|<script|<o>/.test(hostile.html) && /&lt;img/.test(hostile.html), hostile.html);
  // ── THE ROW STRIP AND THE EDITOR STRIP SAY THE SAME THING ─────────────
  for (const slug of ['notes.md', 'dev-arch.md', 'conventions.md']) {
    const f = facts(F.mixed);
    setState({ activeDomain: 'a', activeProject: 'p', fndStop: { domain: 'a', project: 'p', slug } });
    const rowStrip = V.renderFoundationStop(f);
    setState({ activeDomain: 'a', activeProject: 'p', fndEdit: { domain: 'a', project: 'p', slug, isNew: false,
      loading: false, loaded: 'x', text: 'x', title: slug, role: 'other', confirmDelete: true } });
    const edStrip = V.renderFoundationEditor(f);
    const sentence = (h) => (/role="alertdialog"[^>]*><span>([\s\S]*?)<\/span><button/.exec(h) || [])[1];
    const btn = (h, id) => (new RegExp('id="' + id + '"[^>]*>([^<]*)<').exec(h) || [])[1];
    ok('[' + slug + '] the editor\'s Delete and the row\'s trash render IDENTICAL words',
      !!sentence(rowStrip) && sentence(rowStrip) === sentence(edStrip), sentence(rowStrip) + ' ||| ' + sentence(edStrip));
    ok('[' + slug + '] ...and the same primary', btn(rowStrip, 'mem-fnd-stop-go') === btn(edStrip, 'mem-fnd-delete-go'),
      btn(rowStrip, 'mem-fnd-stop-go') + ' vs ' + btn(edStrip, 'mem-fnd-delete-go'));
  }
  {
    const f = facts(F.mixed);
    setState({ activeDomain: 'a', activeProject: 'p', fndStop: { domain: 'a', project: 'p', slug: 'field-notes.md' } });
    const h = V.renderFoundationStop(f);
    ok('the row strip for a folder-not-here mirror uses the same in-flow alertdialog and "Keep it"',
      /class="mem-fnd-delete-bar" role="alertdialog"/.test(h) && /btn-danger-solid/.test(h) && />Keep it</.test(h), h);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — the summary\'s origin clause, from the documents');
// ═════════════════════════════════════════════════════════════════════════
{
  const o = (env) => FSRC.originWord(facts(env));
  eq('kept-only (v1)', o(F.v1Kept), 'kept here');
  eq('kept-only (v2)', o(F.v2Kept), 'kept here');
  eq('a folder mirror', o(F.v2Folder), 'mirrored');
  eq('a GitHub mirror', o(F.v1GitHub), 'mirrored');
  eq('written + copied + mirrors from 3 sources', o(F.mixed), 'written, copied and mirrored from 3 sources');
  const wc = envelope([doc('a.md'), doc('b.md', { copiedFrom: 'x' }),
    doc('c.md', { source: { kind: 'repo', path: 'c.md', group: 's1' }, freshness: 'fresh' })],
  { sources: [group('s1', { documentCount: 1 })] });
  eq('written + copied + one folder', o(wc), 'written, copied and mirrored');
  const wg = envelope([doc('a.md'), doc('g1.md', { source: { kind: 'repo', path: 'g1.md', group: 's2' }, freshness: 'unreachable' }),
    doc('g2.md', { source: { kind: 'repo', path: 'g2.md', group: 's2' }, freshness: 'unreachable' })],
  { sources: [group('s2', { kind: 'github', label: 'o/r', remote: { owner: 'o', repo: 'r' }, reachableHere: false, documentCount: 2 })] });
  eq('written + GitHub', o(wg), 'written and 2 from GitHub');
  ok('...and it reaches the summary line', /· written and 2 from GitHub ·/.test(V.foundationsSummaryMeta(facts(wg))),
    V.foundationsSummaryMeta(facts(wg)));
  eq('the state word of a copied-only project is "copied"', V.foundationsWord(facts(envelope([doc('a.md', { copiedFrom: 'x' })]))), 'copied');
  eq('...of written and copied, "written and copied"', V.foundationsWord(facts(F.v1Kept)), 'written and copied');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — the doors (§4.1) and the local panel\'s D2 control (§4.2)');
// ═════════════════════════════════════════════════════════════════════════
{
  for (const [name, env] of Object.entries(F)) {
    const d = FA.doorsFor(facts(env));
    ok('[' + name + '] both doors enabled', d.local.available && d.github.available);
  }
  const rec = (over) => Object.assign(FA.freshAddPanel('local', {}, facts(F.mixed)), { domain: 'acme', project: 'lumina' }, over || {});
  const p0 = FA.renderAddPanel(rec(), facts(F.mixed), {});
  ok('the local panel shows BOTH options, always', /data-fadd-mode="mirror"/.test(p0) && /data-fadd-mode="copy"/.test(p0));
  ok('before a listing Copy once is chosen', /value="copy" data-fadd-mode="copy" checked/.test(p0));
  const listed = rec({ mode: 'mirror', inGitCheckout: true, root: SCAN.root, listedRoot: SCAN.root,
    candidates: SCAN.candidates, picks: { 'architecture.md': true } });
  const p1 = FA.renderAddPanel(listed, facts(F.mixed), {});
  ok('inside a git checkout Keep in sync is chosen and the note says why, in one sentence',
    /value="mirror" data-fadd-mode="mirror" checked/.test(p1)
    && /id="fadd-note">This folder is inside a git checkout, so the files are kept in sync: [^<.]*\.</.test(p1),
    (p1.match(/id="fadd-note">[^<]*/) || [''])[0]);
  ok('...and the primary reads "Mirror 1 document"', /id="fadd-go">Mirror 1 document</.test(p1));
  ok('once the owner presses Copy once, the note is the copy sentence',
    /id="fadd-note">Copied once: /.test(FA.renderAddPanel({ ...listed, mode: 'copy', modeChosen: true }, facts(F.mixed), {})));
  // ── THE CHECKLIST READS THE SERVER (§4.3) ────────────────────────────
  ok('"already added" comes from the server\'s field, with the name it landed on',
    /data-fadd-row="roadmap\.md"[\s\S]{0,200}checked disabled[\s\S]{0,300}already added as roadmap-lumina-docs\.md/.test(p1), p1);
  ok('a collision shows its "lands as" badge BEFORE the commit',
    /data-fadd-row="architecture\.md"[\s\S]{0,400}lands as architecture-lumina-docs\.md/.test(p1));
  ok('...and a file landing under its own name shows none',
    !/data-fadd-row="guide\/setup\.md"[^]*?lands as setup\.md/.test(p1));
  ok('a same-named document already in the project does NOT make a row "already added" — only the server says so',
    /data-fadd-pick="architecture\.md"/.test(p1));
  eq('only the server-marked row is excluded from the ticks',
    JSON.stringify(FA.tickedPaths({ ...listed, picks: { 'architecture.md': true, 'roadmap.md': true } })),
    JSON.stringify(['architecture.md']));
  eq('the listing asks the server to annotate for THIS project and mode',
    FA.listUrl(listed), '/api/memory/repo-scan?all=1&root=%2FUsers%2Fme%2Fsrc%2Flumina-docs&mode=mirror&domain=acme&project=lumina');
  const t = FA.outcomeToast(listed, { added: ['architecture-lumina-docs.md'], refreshed: [], refused: [] });
  ok('the outcome names the rename again', /architecture\.md landed as architecture-lumina-docs\.md/.test(t.lines.join(' ')),
    JSON.stringify(t));
}

// ═════════════════════════════════════════════════════════════════════════
section('§8 — the sources strip (§4.4)');
// ═════════════════════════════════════════════════════════════════════════
{
  const now = Date.parse(T0) + 2 * 86400 * 1000;
  const m = FSRC.sourcesStripModel(facts(F.mixed).sources, now);
  eq('one line per group', m.groups.length, 3);
  eq('the folder line', [m.groups[0].kindWord, m.groups[0].label, m.groups[0].meta.join(' · ')].join(' · '),
    'Folder · second-brain · 2 documents · refreshed 2 days ago');
  eq('the GitHub line', [m.groups[1].kindWord, m.groups[1].label, m.groups[1].meta.join(' · ')].join(' · '),
    'GitHub · acme/lumina · 1 document · not checked');
  eq('the folder not here', m.groups[2].meta.join(' · '), '1 document · not on this computer');
  ok('"Refresh all" with two or more groups', m.refreshAll === true);
  ok('"Read from GitHub instead" only on a folder with a remote',
    m.groups[0].canReadFromGitHub && !m.groups[1].canReadFromGitHub && !m.groups[2].canReadFromGitHub);
  const h = FSRC.renderSourcesStrip(m, {});
  ok('each line has its OWN Refresh naming its group',
    ['s1', 's2', 's3'].every((id) => new RegExp('data-fnd-refresh="' + id + '"').test(h)), h);
  ok('...plus Refresh all', /id="mem-fnd-refresh-all"/.test(h));
  ok('an empty strip for a kept-only project', FSRC.renderSourcesStrip(FSRC.sourcesStripModel(facts(F.v2Kept).sources)) === '');
  const hostile = FSRC.renderSourcesStrip(FSRC.sourcesStripModel([{ id: 's1', kind: 'folder', label: '<img onerror=1>', documentCount: 1 }]));
  ok('a label is escaped', !/<img/.test(hostile) && /&lt;img/.test(hostile));
  const out = FSRC.refreshOutcome({ refreshed: ['a'], added: [], unchanged: [], missing: [],
    groups: [{ id: 's1', ok: true }, { id: 's2', ok: false, reason: 'rate-limited' }] }, facts(F.mixed).sources);
  eq('a failed group is named by its label and said to be unchanged', out.failed[0],
    'acme/lumina was not refreshed and is unchanged (rate-limited)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§9 — CENSUS: no view decision branches on the project\'s `ownership` (§1.6)');
// ═════════════════════════════════════════════════════════════════════════
{
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : (/\.js$/.test(n) ? [p] : []);
  });
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
  // THE ALLOWED SITES, each with its reason. None is a decision about a
  // project's documents: the first five are the v3.61.0 New-project CHOOSER's
  // own state (`c.ownership` is which arm the owner is filling in), and the
  // last reads the create route's answer to say whether templates were seeded.
  const ALLOWED = [
    ['shared/foundations-init.js', /\b(c|choice)\.ownership\s*(===|!==)/],
    ['views/domains.js', /\bc\.ownership\s*===/],
    ['views/domains.js', /f\.foundations\.ownership === 'curator' && f\.foundations\.seed/],
  ];
  const hits = [];
  for (const file of walk(NEXT)) {
    const rel = file.slice(NEXT.length + 1);
    strip(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if (!/ownership\s*(===|!==)/.test(line)) return;
      if (ALLOWED.some(([f, re]) => f === rel && re.test(line))) return;
      hits.push(rel + ':' + (i + 1) + ': ' + line.trim());
    });
  }
  ok('no decision site in src/public/next/** compares `ownership` (except the listed chooser sites)',
    hits.length === 0, JSON.stringify(hits));
  ok('CONTROL: the scan really reads the chooser sites it allows',
    /c\.ownership === 'curator'/.test(readFileSync(join(NEXT, 'shared/foundations-init.js'), 'utf8')));
  const mem = strip(viewSrc);
  ok('memory.js in particular has none at all', !/ownership\s*(===|!==)/.test(mem));
  ok('...and neither do the two doors or the source rules',
    !/ownership\s*(===|!==)/.test(strip(readFileSync(join(NEXT, 'shared/foundations-add.js'), 'utf8')))
    && !/ownership\s*(===|!==)/.test(strip(readFileSync(join(NEXT, 'shared/foundations-sources.js'), 'utf8'))));
  ok('the retired helpers are gone, not left calling nothing',
    !/function foundationsControlOffer|function foundationsRemoteSource|state\.fndInit\b/.test(mem));
}

console.log(`\n${'═'.repeat(60)}\nPassed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ foundations-sources view assertions failed'); process.exit(1); }
console.log('✅ All foundations-sources view assertions green');
