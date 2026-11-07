#!/usr/bin/env node
/**
 * Wiki health's Undo (owner's decision, 2026-11-07): src/brain/health-undo.js.
 *
 * What this suite exists to stop, each proven on files read back from disk:
 *   §1 PROPERTY. Random merges and repairs on generated wikis, then Undo, give
 *      the WHOLE wiki tree byte-identical to before (every file, not just the
 *      recorded ones — so a write the recorder missed shows up as a difference).
 *      Chains of changes undone newest-first return to the first tree.
 *   §2 A file changed since (edit, delete, re-creation, a later Health change)
 *      refuses the whole undo, names the page, and writes nothing.
 *   §3 A copy that cannot be saved blocks the action: nothing changes. A copy
 *      failing part-way stops every later write, and what was written undoes.
 *   §4 A crash (SIGKILL, in a child process) part-way through an undo leaves a
 *      record the next start finishes: the tree ends as before, never a mix.
 *      A crash part-way through an ACTION leaves an undoable record too.
 *   §5 Expiry after 30 days and the size cap, which never deletes the newest.
 *   §6 The routes over a real Express dispatch: list, check, undo, 409 body.
 *   §7 The MCP over real stdio: fix_wiki_issue's reply names the change; there
 *      is no undo tool.
 *   §8 A record applies only to the folder it was made in.
 *   §9 The copies live outside domains/ and never under the sync work tree.
 *
 * Isolated with CURATOR_TEST_USER_DATA_DIR + a domains override; no network.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'health-undo-'));
const DOMAINS = path.join(TMP, 'domains');
mkdirSync(DOMAINS, { recursive: true });
const USER_DATA = path.join(TMP, 'user-data');
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
mkdirSync(USER_DATA, { recursive: true });

const { __setDomainsDirOverride } = await import(path.join(REPO, 'src/brain/config.js'));
__setDomainsDirOverride(DOMAINS);
const health = await import(path.join(REPO, 'src/brain/health.js'));
const undo = await import(path.join(REPO, 'src/brain/health-undo.js'));
const { getHealthUndoDir } = await import(path.join(REPO, 'src/brain/paths.js'));
const { SECTION_KIT: SECTION_KIT_OBJ } = await import(path.join(REPO, 'scripts/test-helpers/section-kit.js'));

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL ${name}${detail !== undefined ? '\n       ' + String(detail).slice(0, 900) : ''}`);
}
const section = (s) => console.log(`\n${s}`);

// ── Helpers ────────────────────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let seq = 0;
function mkDomain(files, name) {
  const dom = name || ('u' + (++seq));
  const wiki = path.join(DOMAINS, dom, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(DOMAINS, dom, 'CLAUDE.md'), '# schema\n');
  if (!files['index.md']) writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  if (!files['log.md']) writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(wiki, rel), body);
  return { name: dom, wiki };
}

/** Every file under the wiki, path → bytes (base64), so a tree compares exactly. */
function tree(wiki) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[path.relative(wiki, p)] = readFileSync(p).toString('base64');
    }
  };
  walk(wiki);
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function diffKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]);
}

const page = (title, body, type = 'entity') => `---\ntype: ${type}\ntags: [type/${type}]\n---\n# ${title}\n\n${body}\n`;

/** A random wiki with every kind of issue the free repairs and merges act on. */
function generatedWiki(rand) {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma', 'kappa', 'lambda', 'theta', 'zeta'];
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const files = {};
  const ents = [], cons = [];
  const n = 5 + Math.floor(rand() * 6);
  for (let i = 0; i < n; i++) {
    const slug = pick(words) + '-' + i;
    if (rand() < 0.5) ents.push(slug); else cons.push(slug);
  }
  const all = () => [...ents, ...cons];
  const linkLine = () => {
    const r = rand();
    if (r < 0.15) return `- [[entities/${pick(ents.length ? ents : ['x'])}]] — a folder link.`;
    if (r < 0.25) return `- [[missing-${Math.floor(rand() * 3)}]] — a link to no page.`;
    if (r < 0.35 && all().length) { const s = pick(all()); return `- [[${s.toUpperCase().replace(/-/g, ' ')}]] — a link with another spelling.`; }
    return `- [[${pick(all())}]] — a link.`;
  };
  for (const s of ents) files[`entities/${s}.md`] = page(s, `Opening for ${s}. ${rand().toString(36)}\n\n## Related\n${linkLine()}\n${linkLine()}`);
  for (const s of cons) files[`concepts/${s}.md`] = page(s, `Concept ${s}. ${rand().toString(36)}\n\n## Related\n${linkLine()}`, 'concept');
  // A hyphen variant pair, a cross-folder pair, a semantic pair.
  files['entities/e-mail.md'] = page('E-mail', 'Hyphen kept. [[' + pick(all()) + ']]');
  files['entities/email.md'] = page('Email', 'Hyphen removed ' + rand().toString(36) + '.\n\n## Related\n- [[e-mail]]');
  files['entities/google.md'] = page('Google', 'Entity google.');
  files['concepts/google.md'] = page('Google', 'Concept google ' + rand().toString(36) + '.', 'concept');
  files['concepts/neural-network.md'] = page('Neural network', 'Kept NN.', 'concept');
  files['concepts/neural-networks.md'] = page('Neural networks', 'Removed NN ' + rand().toString(36) + '.', 'concept');
  // Pages linking to the ones a merge removes, so repointing writes elsewhere.
  files['concepts/linker.md'] = page('Linker', 'See [[neural-networks]], [[email]] and [[concepts/google]].', 'concept');
  // A summary with a concept under Entities Mentioned, and entities lacking the backlink.
  const e0 = ents[0] || 'google';
  files['summaries/source-one.md'] = `---\ntype: summary\n---\n# Source one\n\n**Source:** one.pdf\n\n## Key Takeaways\n- one\n\n## Entities Mentioned\n- [[${e0}]]\n- [[neural-network]]\n\n## Concepts Introduced or Referenced\n- [[${pick(cons.length ? cons : ['neural-network'])}]]\n`;
  files['index.md'] = '# Index\n\n| Page | Type |\n|---|---|\n| [[google]] | entity |\n';
  return { files, ents, cons, pick, all };
}

/** One random Health action through the real exported functions. Returns its result. */
async function randomAction(dom, rand, g) {
  const actions = [
    () => health.fixIssue(dom, 'semanticDupe', { keepSlug: 'neural-network', keepFolder: 'concepts', removeSlug: 'neural-networks', removeFolder: 'concepts' }),
    () => health.fixIssue(dom, 'crossFolderDupes', { keep: 'entities/google.md', remove: 'concepts/google.md' }),
    () => health.fixIssue(dom, 'hyphenVariants', { suggestedSlug: 'e-mail', files: ['e-mail', 'email'] }),
    () => health.fixIssue(dom, 'brokenLinks', null),
    () => health.fixIssue(dom, 'folderPrefixLinks', null),
    () => health.fixIssue(dom, 'missingBacklinks', null),
    () => health.fixIssue(dom, 'summaryLinkSections', null),
    () => health.fixIssue(dom, 'crossFolderDupes', null),
    () => health.fixIssue(dom, 'hyphenVariants', null),
    () => { const all = g.all(); return health.fixIssue(dom, 'orphanLink', { orphanSlug: g.pick(all), targetSlug: g.pick(all), description: 'random' }); },
    () => health.fixAllSafe(dom),
    () => health.applyBrokenLinkFixes(dom, [{ linkText: 'missing-0', action: 'strip' }, { linkText: 'missing-1', action: 'strip' }]),
    () => { const all = g.all(); return health.applyOrphanRescue(dom, [{ orphanSlug: g.pick(all), target: g.pick(all), description: 'rescued' }]); },
    async () => { const plan = await health.planIndexRebuild(dom); return health.applyIndexRebuild(dom, plan.basis); },
  ];
  const i = Math.floor(rand() * actions.length);
  try { return { i, r: await actions[i]() }; }
  catch (err) { return { i, err }; }
}

// ── §1 Property: random actions, then undo, give the same tree ─────────────
section('§1 Random merges and repairs on generated wikis, undone, are byte-identical');
{
  let undone = 0, nothingChanged = 0, chains = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const rand = mulberry32(seed);
    const g = generatedWiki(rand);
    const d = mkDomain(g.files);
    const start = tree(d.wiki);
    // A chain of 1-4 actions, each recorded, then undone newest first.
    const steps = 1 + Math.floor(rand() * 4);
    const stack = [];
    const trees = [start];
    for (let s = 0; s < steps; s++) {
      const { i, r, err } = await randomAction(d.name, rand, g);
      const after = tree(d.wiki);
      const changed = !same(after, trees[trees.length - 1]);
      const rec = (r && r.undo) || (err && err.undo) || null;
      ok(changed === !!rec, `seed ${seed} step ${s} action ${i}: a record exists exactly when files changed`,
        JSON.stringify({ changed, rec, err: err && err.message, diff: diffKeys(after, trees[trees.length - 1]) }));
      if (rec) { stack.push(rec); trees.push(after); } else nothingChanged++;
    }
    if (stack.length > 1) chains++;
    while (stack.length) {
      const rec = stack.pop();
      trees.pop();
      const res = await undo.undoHealthChange(d.name, rec.id).catch((e) => ({ error: e.message }));
      const now = tree(d.wiki);
      ok(!res.error && same(now, trees[trees.length - 1]), `seed ${seed}: undoing "${rec.title}" restores the tree before it, byte for byte`,
        JSON.stringify({ res, diff: diffKeys(now, trees[trees.length - 1]) }));
      undone++;
    }
    ok(same(tree(d.wiki), start), `seed ${seed}: after every undo the wiki is the generated one`);
    const list = await undo.listHealthChanges(d.name);
    ok(list.every((c) => c.status === 'undone'), `seed ${seed}: every listed change reads undone`, JSON.stringify(list));
  }
  ok(undone >= 60, `enough changes were undone to mean something (${undone})`, undone);
  ok(chains >= 10, `enough multi-step chains (${chains})`, chains);
  console.log(`  ${undone} undos, ${chains} chains, ${nothingChanged} actions that changed nothing`);
}

// ── §1b The record names every file, and its words ────────────────────────
section('§1b The record: plain words, page counts, the deleted page');
{
  const g = generatedWiki(mulberry32(999));
  const d = mkDomain(g.files);
  const r = await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'neural-network', keepFolder: 'concepts', removeSlug: 'neural-networks', removeFolder: 'concepts' });
  ok(r.fixed === 1 && r.undo && r.undo.title === 'Merged neural-networks into neural-network', 'the title says what merged into what', JSON.stringify(r.undo));
  ok(r.undo.deleted.length === 1 && r.undo.deleted[0] === 'concepts/neural-networks', 'the deleted page is named', JSON.stringify(r.undo));
  ok(r.undo.pageList.includes('concepts/linker'), 'a page whose links were repointed is in the record', JSON.stringify(r.undo.pageList));
  ok(r.undo.pages === r.undo.pageList.length && r.undo.pages >= 3, 'pages counts the pages', JSON.stringify(r.undo));
  const list = await undo.listHealthChanges(d.name);
  ok(list.length === 1 && list[0].id === r.undo.id && list[0].status === 'ready', 'the list shows it, ready', JSON.stringify(list));
  // A nothing-to-do action leaves no record.
  const r2 = await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'neural-network', keepFolder: 'concepts', removeSlug: 'neural-networks', removeFolder: 'concepts' });
  ok(r2.fixed === 0 && !r2.undo && (await undo.listHealthChanges(d.name)).length === 1, 'a refused action leaves no record', JSON.stringify(r2));

  // A write of the same bytes is not a change: no record, no copy left behind.
  const { writeFileAtomic } = await import(path.join(REPO, 'src/brain/atomic-write.js'));
  const same0 = await undo.withHealthUndo(d.name, { kind: 'test', title: 'same bytes' }, async () => {
    const f = path.join(d.wiki, 'concepts/linker.md');
    await writeFileAtomic(f, readFileSync(f));
    return {};
  });
  ok(!same0.undo && (await undo.listHealthChanges(d.name)).length === 1, 'rewriting a page with its own bytes records nothing', JSON.stringify(same0));

  // A removed page that was a symbolic link comes back as that link.
  const { symlinkSync, lstatSync, readlinkSync } = await import('node:fs');
  const sd = mkDomain({ 'concepts/real.md': '# Real\n\nOnly copy.\n' });
  symlinkSync(path.join(sd.wiki, 'concepts/real.md'), path.join(sd.wiki, 'concepts/alias.md'));
  const sr = await health.fixIssue(sd.name, 'semanticDupe', { keepSlug: 'real', keepFolder: 'concepts', removeSlug: 'alias', removeFolder: 'concepts' });
  ok(sr.fixed === 1 && sr.undo, 'a merge that removes a symbolic link is recorded', JSON.stringify(sr));
  await undo.undoHealthChange(sd.name, sr.undo.id);
  const alias = path.join(sd.wiki, 'concepts/alias.md');
  ok(lstatSync(alias).isSymbolicLink() && readlinkSync(alias) === path.join(sd.wiki, 'concepts/real.md') && readFileSync(path.join(sd.wiki, 'concepts/real.md'), 'utf8') === '# Real\n\nOnly copy.\n',
    'and undo puts the link back as a link, and the page as it was');

  // A batch of spelling variants is ONE change, undone all at once.
  const dc = await import(path.join(REPO, 'src/brain/duplicate-checks.js'));
  const files = {};
  const memory = new Map();
  const pairs = [];
  for (let i = 0; i < 6; i++) {
    const w = ["apple", "berry", "cloud", "dream", "engine", "forest"]; const a = `topic-${w[i]}`, b = `topic-${w[i]}s`;
    const keep = page(a, `Kept ${i}.`, 'concept'), remove = page(b, `Removed ${i}.\n\n## Related\n- [[topic-${w[(i + 1) % 6]}s]]`, 'concept');
    files[`concepts/${a}.md`] = keep;
    files[`concepts/${b}.md`] = remove;
    memory.set(dc.pairKey('concepts', a, 'concepts', b), {
      provider: 'p', model: 'm', prompt: 'x', verdict: 'yes', confidence: 'high', keep: `concepts/${a}`, remove: `concepts/${b}`, at: 'now',
      openings: dc.openingsHash('concepts', a, dc.pageOpening(keep), 'concepts', b, dc.pageOpening(remove)),
    });
    pairs.push({ keepSlug: a, keepFolder: 'concepts', removeSlug: b, removeFolder: 'concepts' });
  }
  const bd = mkDomain(files);
  await dc.saveDuplicateChecks(bd.name, memory);
  const bBefore = tree(bd.wiki);
  const br = await health.fixSemanticDuplicatesBatch(bd.name, pairs);
  ok(br.merged === 6 && br.undo && br.undo.title === 'Merged 6 spelling variants' && br.undo.deleted.length === 6, 'a batch of 6 is one change, in plain words', JSON.stringify({ merged: br.merged, undo: br.undo }));
  ok((await undo.listHealthChanges(bd.name)).length === 1, 'one entry in the list');
  await undo.undoHealthChange(bd.name, br.undo.id);
  ok(same(tree(bd.wiki), bBefore), 'and one undo puts all 12 pages back', JSON.stringify(diffKeys(tree(bd.wiki), bBefore)));
}

// ── §2 Interleaved edits refuse, and write nothing ─────────────────────────
section('§2 A page changed since refuses the whole undo');
{
  const cases = [
    ['an edit to the kept page', (w) => writeFileSync(path.join(w, 'concepts/neural-network.md'), 'edited by hand\n'), 'concepts/neural-network', 'edited'],
    ['an edit to a repointed page', (w) => writeFileSync(path.join(w, 'concepts/linker.md'), readFileSync(path.join(w, 'concepts/linker.md'), 'utf8') + '\nmore\n'), 'concepts/linker', 'edited'],
    ['the deleted page made again', (w) => writeFileSync(path.join(w, 'concepts/neural-networks.md'), '# again\n'), 'concepts/neural-networks', 'recreated'],
    ['the kept page deleted', (w) => rmSync(path.join(w, 'concepts/neural-network.md')), 'concepts/neural-network', 'deleted'],
  ];
  for (const [label, edit, pageName, why] of cases) {
    const g = generatedWiki(mulberry32(7));
    const d = mkDomain(g.files);
    const before = tree(d.wiki);
    const r = await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'neural-network', keepFolder: 'concepts', removeSlug: 'neural-networks', removeFolder: 'concepts' });
    edit(d.wiki);
    const edited = tree(d.wiki);
    const check = await undo.checkHealthUndo(d.name, r.undo.id);
    ok(!check.ok && check.conflicts.some((c) => c.page === pageName && c.why === why), `${label}: the check names ${pageName} (${why})`, JSON.stringify(check));
    let err = null;
    try { await undo.undoHealthChange(d.name, r.undo.id); } catch (e) { err = e; }
    ok(err && err.code === undo.UNDO_CONFLICT && err.status === 409 && err.message.includes(pageName) && /Nothing was undone/.test(err.message),
      `${label}: undo refuses, naming the page`, err && err.message);
    ok(same(tree(d.wiki), edited), `${label}: nothing was written by the refusal`, JSON.stringify(diffKeys(tree(d.wiki), edited)));
    ok((await undo.listHealthChanges(d.name))[0].status === 'ready', `${label}: the change stays undoable`);
    // Put the page back as the merge left it, and the undo goes through.
    if (why === 'recreated') rmSync(path.join(d.wiki, 'concepts/neural-networks.md'));
  }
  // A later Health change on the same page: named, undo that first.
  const g = generatedWiki(mulberry32(8));
  const d = mkDomain(g.files);
  const start = tree(d.wiki);
  const first = await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'neural-network', keepFolder: 'concepts', removeSlug: 'neural-networks', removeFolder: 'concepts' });
  const second = await health.fixIssue(d.name, 'crossFolderDupes', { keep: 'entities/google.md', remove: 'concepts/google.md' });
  ok(first.undo && second.undo, 'two changes recorded', JSON.stringify([first.undo, second.undo]));
  let err = null;
  try { await undo.undoHealthChange(d.name, first.undo.id); } catch (e) { err = e; }
  ok(err && err.code === undo.UNDO_CONFLICT && err.message.includes(second.undo.title) && /Undo that one first/.test(err.message),
    'undoing the older change first names the later one to undo first', err && err.message);
  await undo.undoHealthChange(d.name, second.undo.id);
  await undo.undoHealthChange(d.name, first.undo.id);
  ok(same(tree(d.wiki), start), 'newest first, both undo to the start');
  // Twice is refused.
  let again = null;
  try { await undo.undoHealthChange(d.name, first.undo.id); } catch (e) { again = e; }
  ok(again && again.code === undo.UNDO_NOT_READY && /already undone/.test(again.message), 'a second undo is refused', again && again.message);
  // A damaged copy refuses before anything is written.
  const third = await health.fixIssue(d.name, 'hyphenVariants', { suggestedSlug: 'e-mail', files: ['e-mail', 'email'] });
  const recDir = path.join(undo.domainUndoDir(d.name), third.undo.id);
  const rec3 = JSON.parse(readFileSync(path.join(recDir, 'record.json'), 'utf8'));
  writeFileSync(path.join(recDir, rec3.files[rec3.files.length - 1].copy), 'damaged');
  const merged3 = tree(d.wiki);
  let dmg = null;
  try { await undo.undoHealthChange(d.name, third.undo.id); } catch (e) { dmg = e; }
  ok(dmg && /missing or damaged/.test(dmg.message) && same(tree(d.wiki), merged3), 'a damaged copy refuses the undo and writes nothing', dmg && dmg.message);

  // A forged id is refused before any path is built.
  let forged = null;
  try { await undo.undoHealthChange(d.name, '../../etc'); } catch (e) { forged = e; }
  ok(forged && forged.status === 404, 'a forged id is a 404', forged && forged.message);
}

// ── §3 A copy that cannot be saved blocks the action ───────────────────────
section('§3 Copy failure blocks the action');
{
  // (a) The store cannot be created: nothing changes.
  const g = generatedWiki(mulberry32(21));
  const d = mkDomain(g.files);
  const before = tree(d.wiki);
  const store = getHealthUndoDir();
  rmSync(store, { recursive: true, force: true });
  writeFileSync(store, 'a file where the folder should be');
  let err = null;
  try { await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'neural-network', keepFolder: 'concepts', removeSlug: 'neural-networks', removeFolder: 'concepts' }); } catch (e) { err = e; }
  ok(err && err.code === undo.UNDO_COPY_FAILED && /nothing was changed/.test(err.message), 'an unwritable store refuses the merge', err && err.message);
  ok(same(tree(d.wiki), before), 'and the wiki is untouched', JSON.stringify(diffKeys(tree(d.wiki), before)));
  err = null;
  try { await health.fixAllSafe(d.name); } catch (e) { err = e; }
  ok(err && err.code === undo.UNDO_COPY_FAILED && same(tree(d.wiki), before), 'the safe repairs too');
  rmSync(store, { force: true });

  // (b) The first copy fails: nothing changes, no record.
  undo.__setUndoFaultForTest({ copy: () => { throw new Error('disk full (simulated)'); } });
  err = null;
  try { await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'neural-network', keepFolder: 'concepts', removeSlug: 'neural-networks', removeFolder: 'concepts' }); } catch (e) { err = e; }
  undo.__setUndoFaultForTest(null);
  ok(err && err.code === undo.UNDO_COPY_FAILED, 'a failed first copy throws', err && err.message);
  ok(same(tree(d.wiki), before), 'and nothing was written', JSON.stringify(diffKeys(tree(d.wiki), before)));
  ok((await undo.listHealthChanges(d.name)).length === 0, 'and nothing is listed');

  // (c) The third copy fails: the action stops there, and what it wrote undoes.
  let n = 0;
  undo.__setUndoFaultForTest({ copy: () => { if (++n === 3) throw new Error('disk full (simulated)'); } });
  err = null;
  try { await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'neural-network', keepFolder: 'concepts', removeSlug: 'neural-networks', removeFolder: 'concepts' }); } catch (e) { err = e; }
  undo.__setUndoFaultForTest(null);
  const mid = tree(d.wiki);
  ok(err && err.code === undo.UNDO_COPY_FAILED && err.undo, 'a copy failing part-way throws, with the record of what was written', err && err.message);
  ok(existsSync(path.join(d.wiki, 'concepts/neural-networks.md')), 'the page to delete was not deleted: every write after the failure was stopped');
  const changedFiles = diffKeys(mid, before);
  ok(changedFiles.length === 2 && err.undo.pages + (err.undo.index ? 1 : 0) === 2, 'exactly the two copied files changed', JSON.stringify({ changedFiles, rec: err.undo }));
  const list = await undo.listHealthChanges(d.name);
  ok(list.length === 1 && list[0].interrupted === true, 'it is listed, marked interrupted', JSON.stringify(list));
  await undo.undoHealthChange(d.name, err.undo.id);
  ok(same(tree(d.wiki), before), 'and undoing it gives the wiki before', JSON.stringify(diffKeys(tree(d.wiki), before)));

  // (d) A synchronous write inside an action is refused rather than written uncopied.
  const { writeFileAtomicSync, writeRecorder } = await import(path.join(REPO, 'src/brain/atomic-write.js'));
  err = null;
  try {
    await undo.withHealthUndo(d.name, { kind: 'test', title: 'sync' }, async () => {
      writeFileAtomicSync(path.join(d.wiki, 'concepts/linker.md'), 'sync write');
    });
  } catch (e) { err = e; }
  ok(err && /synchronous write/.test(err.message) && same(tree(d.wiki), before), 'a sync write to a page during an action is refused', err && err.message);
  // Outside the wiki is never copied and never refused.
  const outside = path.join(TMP, 'outside.txt');
  await undo.withHealthUndo(d.name, { kind: 'test', title: 'x' }, async () => { writeFileAtomicSync(outside, 'ok'); });
  ok(readFileSync(outside, 'utf8') === 'ok' && writeRecorder.getStore() === undefined, 'a write outside the wiki is untouched, and the store is empty after');
}

// ── §4 A crash mid-undo, and mid-action ────────────────────────────────────
section('§4 A crash part-way leaves a record the next start finishes');
const CHILD = path.join(TMP, 'child.mjs');
writeFileSync(CHILD, `
const [repo, domains, dom, mode, arg] = process.argv.slice(2);
const { __setDomainsDirOverride } = await import(repo + '/src/brain/config.js');
__setDomainsDirOverride(domains);
const undo = await import(repo + '/src/brain/health-undo.js');
const health = await import(repo + '/src/brain/health.js');
if (mode === 'undo') {
  undo.__setUndoFaultForTest({ restore: (i) => { if (i === 2) process.kill(process.pid, 'SIGKILL'); } });
  await undo.undoHealthChange(dom, arg);
} else {
  let n = 0;
  undo.__setUndoFaultForTest({ copy: () => { if (++n === 3) process.kill(process.pid, 'SIGKILL'); } });
  await health.fixIssue(dom, 'semanticDupe', { keepSlug: 'neural-network', keepFolder: 'concepts', removeSlug: 'neural-networks', removeFolder: 'concepts' });
}
process.stdout.write('finished\\n');
`);
{
  const g = generatedWiki(mulberry32(31));
  const d = mkDomain(g.files);
  const before = tree(d.wiki);
  const r = await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'neural-network', keepFolder: 'concepts', removeSlug: 'neural-networks', removeFolder: 'concepts' });
  const merged = tree(d.wiki);
  ok(r.undo && r.undo.pages >= 3, 'a merge with at least three files to put back', JSON.stringify(r.undo));
  const run = spawnSync(process.execPath, [CHILD, REPO, DOMAINS, d.name, 'undo', r.undo.id], { env: process.env, encoding: 'utf8' });
  ok(run.signal === 'SIGKILL' && !/finished/.test(run.stdout), 'the child was killed part-way through the undo', JSON.stringify({ signal: run.signal, out: run.stdout, err: run.stderr.slice(0, 400) }));
  const crashed = tree(d.wiki);
  // Anti-vacuity: the crash really did leave a mix on disk.
  ok(!same(crashed, before) && !same(crashed, merged), 'on disk right after the crash: neither state (the crash was really mid-way)', JSON.stringify(diffKeys(crashed, before)));
  const dir = undo.domainUndoDir(d.name);
  const rec = JSON.parse(readFileSync(path.join(dir, r.undo.id, 'record.json'), 'utf8'));
  ok(rec.status === 'undoing', 'the record says the undo was under way', rec.status);
  // The next start: what server.js runs at listen.
  await undo.recoverAllHealthUndo();
  ok(same(tree(d.wiki), before), 'after the next start the wiki is as before the merge, byte for byte', JSON.stringify(diffKeys(tree(d.wiki), before)));
  const list = await undo.listHealthChanges(d.name);
  ok(list[0].status === 'undone', 'and the change reads undone', JSON.stringify(list));

  // Crash mid-ACTION: an undoable record.
  const g2 = generatedWiki(mulberry32(32));
  const d2 = mkDomain(g2.files);
  const before2 = tree(d2.wiki);
  const run2 = spawnSync(process.execPath, [CHILD, REPO, DOMAINS, d2.name, 'action'], { env: process.env, encoding: 'utf8' });
  ok(run2.signal === 'SIGKILL', 'the child was killed part-way through a merge', run2.stderr.slice(0, 400));
  ok(!same(tree(d2.wiki), before2), 'the merge had written something before the crash');
  const list2 = await undo.listHealthChanges(d2.name);
  ok(list2.length === 1 && list2[0].interrupted === true && list2[0].status === 'ready', 'the crashed merge is listed, interrupted, undoable', JSON.stringify(list2));
  await undo.undoHealthChange(d2.name, list2[0].id);
  ok(same(tree(d2.wiki), before2), 'and undoing it gives the wiki before the merge', JSON.stringify(diffKeys(tree(d2.wiki), before2)));

  // A recovery that finds a page changed after the crash leaves it alone.
  const g3 = generatedWiki(mulberry32(33));
  const d3 = mkDomain(g3.files);
  const r3 = await health.fixIssue(d3.name, 'semanticDupe', { keepSlug: 'neural-network', keepFolder: 'concepts', removeSlug: 'neural-networks', removeFolder: 'concepts' });
  spawnSync(process.execPath, [CHILD, REPO, DOMAINS, d3.name, 'undo', r3.undo.id], { env: process.env, encoding: 'utf8' });
  const rec3 = JSON.parse(readFileSync(path.join(undo.domainUndoDir(d3.name), r3.undo.id, 'record.json'), 'utf8'));
  const last = rec3.files[rec3.files.length - 1].rel;
  writeFileSync(path.join(d3.wiki, last), 'written after the crash\n');
  await undo.recoverAllHealthUndo();
  ok(readFileSync(path.join(d3.wiki, last), 'utf8') === 'written after the crash\n', 'a page written after the crash is never overwritten by recovery');
  const l3 = await undo.listHealthChanges(d3.name);
  ok(l3[0].status === 'stuck' && /changed while the undo was unfinished/.test(l3[0].stuck), 'and the change says it is stuck, in words', JSON.stringify(l3));
}

// ── §5 Expiry and the size cap ─────────────────────────────────────────────
section('§5 30 days, and a size cap that never deletes the newest');
{
  const g = generatedWiki(mulberry32(41));
  const d = mkDomain(g.files);
  const a = await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'neural-network', keepFolder: 'concepts', removeSlug: 'neural-networks', removeFolder: 'concepts' });
  const b = await health.fixIssue(d.name, 'crossFolderDupes', { keep: 'entities/google.md', remove: 'concepts/google.md' });
  const c = await health.fixIssue(d.name, 'hyphenVariants', { suggestedSlug: 'e-mail', files: ['e-mail', 'email'] });
  const dir = undo.domainUndoDir(d.name);
  const age = (id, days) => {
    const f = path.join(dir, id, 'record.json');
    const rec = JSON.parse(readFileSync(f, 'utf8'));
    rec.createdAt = new Date(Date.now() - days * 86400000).toISOString();
    writeFileSync(f, JSON.stringify(rec));
  };
  age(a.undo.id, 31);
  age(b.undo.id, 29);
  await undo.pruneHealthUndo();
  ok(!existsSync(path.join(dir, a.undo.id)) && existsSync(path.join(dir, b.undo.id)), 'a change older than 30 days expires; a 29-day one stays');
  ok((await undo.listHealthChanges(d.name)).length === 2, 'the list shows the two left');
  await undo.pruneHealthUndo({ maxBytes: 1 });
  ok(!existsSync(path.join(dir, b.undo.id)) && existsSync(path.join(dir, c.undo.id)), 'over the cap the oldest goes, and the newest stays even alone over it');
  await undo.pruneHealthUndo({ maxBytes: 1 });
  ok(existsSync(path.join(dir, c.undo.id)), 'the newest is never deleted to meet the cap');
  age(c.undo.id, 31);
  await undo.pruneHealthUndo();
  ok(!existsSync(dir), 'a 31-day newest expires, and the empty folder goes');
}

// ── §6 The routes ──────────────────────────────────────────────────────────
section('§6 The routes over a real Express dispatch');
{
  const express = (await import('express')).default;
  const router = (await import(path.join(REPO, 'src/routes/health.js'))).default;
  const app = express();
  app.use(express.json());
  app.use('/api/health', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = server.address().port;
  const call = (method, url, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  try {
    const g = generatedWiki(mulberry32(51));
    const d = mkDomain(g.files);
    const before = tree(d.wiki);
    const fix = await call('POST', `/api/health/${d.name}/fix`, { type: 'crossFolderDupes', issue: { keep: 'entities/google.md', remove: 'concepts/google.md' } });
    ok(fix.status === 200 && fix.body.fixed === 1 && fix.body.undo && fix.body.undo.id, 'a fix through the route returns its change', JSON.stringify(fix.body));
    const scan = await call('GET', `/api/health/${d.name}`);
    ok(scan.status === 200 && scan.body.recentChanges === 1, 'the scan reports how many recent changes there are', JSON.stringify(scan.body.recentChanges));
    const list = await call('GET', `/api/health/${d.name}/changes`);
    ok(list.status === 200 && list.body.changes.length === 1 && list.body.keepDays === 30 && list.body.thisComputerOnly === true, 'the list route', JSON.stringify(list.body));
    const id = fix.body.undo.id;
    writeFileSync(path.join(d.wiki, 'entities/google.md'), 'edited\n');
    const chk = await call('GET', `/api/health/${d.name}/changes/${id}`);
    ok(chk.status === 200 && chk.body.ok === false && /entities\/google/.test(chk.body.message), 'the check route names the changed page', JSON.stringify(chk.body));
    const refused = await call('POST', `/api/health/${d.name}/changes/${id}/undo`);
    ok(refused.status === 409 && refused.body.code === 'undo-conflict' && refused.body.conflicts.length >= 1, 'the undo route refuses with 409 and the pages', JSON.stringify(refused.body));
    ok(readFileSync(path.join(d.wiki, 'entities/google.md'), 'utf8') === 'edited\n', 'and wrote nothing');
    // Put the wiki back to `before` by hand, fix again, then undo straight away.
    rmSync(path.join(d.wiki, 'entities/google.md'));
    for (const [rel, b64] of Object.entries(before)) { mkdirSync(path.dirname(path.join(d.wiki, rel)), { recursive: true }); writeFileSync(path.join(d.wiki, rel), Buffer.from(b64, 'base64')); }
    const fix2 = await call('POST', `/api/health/${d.name}/fix`, { type: 'crossFolderDupes', issue: { keep: 'entities/google.md', remove: 'concepts/google.md' } });
    const done = await call('POST', `/api/health/${d.name}/changes/${fix2.body.undo.id}/undo`);
    ok(done.status === 200 && done.body.change.status === 'undone' && same(tree(d.wiki), before), 'the undo route puts every file back', JSON.stringify(done.body));
    const missing = await call('POST', `/api/health/${d.name}/changes/20260101T000000000Z-000000000000/undo`);
    ok(missing.status === 404, 'an unknown change is a 404', JSON.stringify(missing.body));
    const unknownDomain = await call('GET', `/api/health/no-such-domain/changes`);
    ok(unknownDomain.status === 404, 'an unknown domain is a 404', JSON.stringify(unknownDomain));
    // A read-only mirror refuses the undo.
    const m = mkDomain({ ...generatedWiki(mulberry32(52)).files }, 'shared-mirror');
    writeFileSync(path.join(DOMAINS, m.name, 'CLAUDE.md'), '---\nreadonly: true\n---\n# mirror\n');
    const mr = await call('POST', `/api/health/${m.name}/changes/20260101T000000000Z-000000000000/undo`);
    ok(mr.status === 400, 'a read-only mirror refuses undo', JSON.stringify(mr));
  } finally {
    server.close();
  }
}

// ── §7 The MCP, over real stdio ────────────────────────────────────────────
section('§7 The MCP names the change and has no undo tool');
{
  const g = generatedWiki(mulberry32(61));
  const d = mkDomain(g.files);
  const before = tree(d.wiki);
  const child = spawn(process.execPath, [path.join(REPO, 'mcp/server.js'), '--domains-path', DOMAINS], {
    env: { ...process.env, CURATOR_TEST_DOMAINS_DIR: DOMAINS, CURATOR_TEST_USER_DATA_DIR: USER_DATA },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buf = '';
  let id = 0;
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    const timer = setTimeout(() => reject(new Error('MCP timeout on ' + method)), 30000);
    waiting.set(myId, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'undo-test', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = (await rpc('tools/list', {})).result.tools;
    ok(!tools.some((t) => /undo|revert|restore/i.test(t.name)), 'no MCP tool undoes', tools.map((t) => t.name).join(','));
    const fixTool = tools.find((t) => t.name === 'fix_wiki_issue');
    ok(/Recent changes/.test(fixTool.description) && /no undo over the MCP/.test(fixTool.description) && /this computer only/.test(fixTool.description),
      'fix_wiki_issue says where undo is, and that it is not over the MCP', fixTool.description.slice(-400));
    const res = await rpc('tools/call', { name: 'fix_wiki_issue', arguments: { domain: d.name, type: 'crossFolderDupes', issue: { keep: 'entities/google.md', remove: 'concepts/google.md' } } });
    const reply = JSON.parse(res.result.content[0].text);
    ok(reply.fixed === 1 && reply.undo && reply.undo.id && /Recent changes/.test(reply.undo.where), 'the reply names the change and where to undo it', JSON.stringify(reply.undo));
    // The app undoes what the MCP did.
    await undo.undoHealthChange(d.name, reply.undo.id);
    ok(same(tree(d.wiki), before), 'the app undoes the MCP\'s merge, byte for byte', JSON.stringify(diffKeys(tree(d.wiki), before)));
  } finally {
    child.kill();
  }
}

// ── §8 A record belongs to its folder ──────────────────────────────────────
section('§8 A record applies only to the folder it was made in');
{
  const g = generatedWiki(mulberry32(71));
  const d = mkDomain(g.files, 'samename');
  const r = await health.fixIssue(d.name, 'crossFolderDupes', { keep: 'entities/google.md', remove: 'concepts/google.md' });
  const OTHER = path.join(TMP, 'other-domains');
  mkdirSync(OTHER, { recursive: true });
  __setDomainsDirOverride(OTHER);
  mkDomain(generatedWiki(mulberry32(72)).files, 'samename');
  ok((await undo.listHealthChanges('samename')).length === 0, 'another folder with the same domain name lists nothing');
  let err = null;
  try { await undo.undoHealthChange('samename', r.undo.id); } catch (e) { err = e; }
  ok(err && err.status === 404, 'and cannot undo the first folder\'s change', err && err.message);
  __setDomainsDirOverride(DOMAINS);
  ok((await undo.listHealthChanges('samename')).length === 1, 'back in its folder, it is listed again');
}

// ── §10 The words, the row, and start-up ───────────────────────────────────
section('§10 Words true for every change, the row always there, a refusal cleared, expiry at start');
{
  const { extractFunction } = await import(path.join(REPO, 'scripts/test-helpers/mcp-page-sandbox.js'));
  const SRC = readFileSync(path.join(REPO, 'src/public/next/views/domains.js'), 'utf8');
  const lift = (names, deps, ret) => new Function('state', ...Object.keys(deps),
    names.map((n) => extractFunction(SRC, n)).join('\n') + '\nreturn ' + ret + ';');
  const n0 = (v) => (Number(v) || 0).toLocaleString('en-US');
  const words = lift(['undoWords', 'listPages'], { n0 }, 'undoWords')({}, n0);

  // A Rebuild, recorded for real: index.md alone.
  const g = generatedWiki(mulberry32(81));
  const d = mkDomain(g.files);
  const plan = await health.planIndexRebuild(d.name);
  const rb = await health.applyIndexRebuild(d.name, plan.basis);
  ok(rb.undo && rb.undo.pages === 0 && rb.undo.index === true, 'a Rebuild is recorded as the page list and no page', JSON.stringify(rb.undo));
  const w = words(rb.undo);
  ok(w.meta === 'The page list' && w.body === 'Puts back the page list exactly as it was before this change.' && w.done === 'Undone. The page list is back as it was.',
    'a Rebuild reads as the page list, everywhere', JSON.stringify(w));
  ok(!/\b0 pages\b|: \./.test(JSON.stringify(w)), 'and never "0 pages" or an empty list', JSON.stringify(w));
  // A merge that also touched index.md, and a plain merge.
  const wm = words({ pages: 3, index: true, pageList: ['a', 'b', 'c'], deleted: ['c'] });
  ok(wm.meta === '3 pages and the page list' && /^Puts back these 3 pages and the page list exactly as they were before this change: a, b, c\. c comes back\.$/.test(wm.body) &&
    wm.done === 'Undone. 3 pages and the page list are back as they were.', 'a merge with the page list', JSON.stringify(wm));
  const w1 = words({ pages: 1, index: false, pageList: ['a'], deleted: [] });
  ok(w1.meta === '1 page' && w1.body === 'Puts back this page exactly as it was before this change: a.' && w1.done === 'Undone. The page is back as it was.', 'one page', JSON.stringify(w1));

  // The same name in two folders: the title names the folders.
  const sd = mkDomain({ 'concepts/neural-networks.md': page('NN', 'Concept.', 'concept'), 'entities/neural-networks.md': page('NN', 'Entity.') });
  const sm = await health.fixIssue(sd.name, 'semanticDupe', { keepSlug: 'neural-networks', keepFolder: 'concepts', removeSlug: 'neural-networks', removeFolder: 'entities' });
  ok(sm.fixed === 1 && sm.undo.title === 'Merged entities/neural-networks into concepts/neural-networks', 'a same-name merge shows both folders', JSON.stringify(sm.undo));

  // The row is there at 0 (so a first change never makes it appear under a press), never on a mirror.
  const rowDeps = {
    escapeHtml: (x) => String(x), icon: () => '', n0, relTime: () => 'just now', gatedLoader: () => '', loadGate: null,
    renderAnchorStack: () => '', ...SECTION_KIT_OBJ,
  };
  const row = lift(['recentChangeCount', 'changeMeta', 'undoWords', 'listPages', 'renderChangesRow'], rowDeps, 'renderChangesRow');
  const st = { health: { recentChanges: 0 }, changeRecords: null, expandedGroups: new Set(), rowBusy: new Set(), busyKey: null };
  const html0 = row(st, ...Object.values(rowDeps))(false, false);
  ok(/data-group-key="changes"/.test(html0) && /Recent changes/.test(html0), 'Recent changes is drawn with nothing in it', html0.slice(0, 300));
  ok(row(st, ...Object.values(rowDeps))(true, false) === '', 'and not on a read-only mirror');
  const open0 = row({ ...st, changeRecords: [], expandedGroups: new Set(['changes']) }, ...Object.values(rowDeps))(false, false);
  ok(/Nothing was changed here in the last 30 days\./.test(open0), 'open and empty, it says so', open0.slice(0, 400));

  // Undo pressed: an earlier refusal on a change row goes; other outcomes stay.
  const st2 = { rowOutcomes: { 'change:a': { tone: 'error' }, 'change:b': { tone: 'error' }, 'issue:x': { tone: 'error' } } };
  lift(['pressUndoRow'], {}, 'pressUndoRow')(st2)('b');
  ok(!st2.rowOutcomes['change:a'] && !st2.rowOutcomes['change:b'] && st2.rowOutcomes['issue:x'] && st2.pressAnchor === 'change:b',
    'a new Undo clears the old refusals on change rows, and only those', JSON.stringify(st2));

  // Start-up expires old copies without waiting for a Health action.
  const ed = mkDomain(generatedWiki(mulberry32(82)).files);
  const er = await health.fixIssue(ed.name, 'crossFolderDupes', { keep: 'entities/google.md', remove: 'concepts/google.md' });
  const f = path.join(undo.domainUndoDir(ed.name), er.undo.id, 'record.json');
  const rec = JSON.parse(readFileSync(f, 'utf8'));
  rec.createdAt = new Date(Date.now() - 31 * 86400000).toISOString();
  writeFileSync(f, JSON.stringify(rec));
  await undo.startHealthUndo();
  ok(!existsSync(path.dirname(f)), 'the server start expires a 31-day copy');
}

// ── §9 Where the copies live ───────────────────────────────────────────────
section('§9 The copies live outside domains/, on this computer');
{
  const store = path.resolve(getHealthUndoDir());
  ok(store.startsWith(path.resolve(USER_DATA) + path.sep), 'the store is under the user-data dir', store);
  ok(!store.startsWith(path.resolve(DOMAINS) + path.sep), 'and not inside domains/ (the sync work tree)', store);
  // Nothing of the store was written into any wiki.
  const leaked = [];
  const walk = (dd) => { for (const n of readdirSync(dd)) { const p = path.join(dd, n); if (statSync(p).isDirectory()) walk(p); else if (/record\.json|^f\d+$|\.tmp-/.test(n)) leaked.push(p); } };
  walk(DOMAINS);
  ok(leaked.length === 0, 'no record, copy or temp file inside any domain', leaked.join('\n'));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
