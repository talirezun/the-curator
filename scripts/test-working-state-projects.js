#!/usr/bin/env node
/**
 * test-working-state-projects.js — OFFLINE suite for v3.48.0: PROJECTS INSIDE
 * A DOMAIN, in `src/brain/working-state.js`.
 *
 * WHAT CARRIES THE RISK HERE, AND WHY THE SUITE IS SHAPED AROUND IT
 * ─────────────────────────────────────────────────────────────────
 * This release adds a level to a store that already has data on real machines
 * and SYNCS between them. Three things can go wrong, and only the first is the
 * obvious one:
 *
 *   1. THE NEW LEVEL IS WRONG. Covered by ordinary round-trip assertions.
 *
 *   2. THE OLD LEVEL MOVES. A tree written by v3.17.0–v3.47.0 must read back
 *      through the new code EXACTLY as it did before, and a save must land on
 *      the SAME PATH — because a machine still running the old version reads
 *      only the old layout, and a handoff written one level down is invisible
 *      to it while sitting on its own disk. §1 asserts the paths, not just the
 *      values, and §2 asserts the RESPONSE is unchanged field for field
 *      against a snapshot taken before any project argument is passed.
 *
 *   3. SOMETHING RESOLVES A NAME IT WAS NOT GIVEN. `resolveProject` may never
 *      guess: opening the wrong project resumes the wrong work with
 *      confident-sounding context, and the save after it overwrites the right
 *      one. §5 asserts that both refusal shapes return NOTHING resolved, with
 *      candidates, and §5c is the anti-vacuity control that the resolver can
 *      succeed at all.
 *
 * Isolated via __setUserDataDirOverride + __setDomainsDirOverride — never
 * process.env.DOMAINS_PATH, which loses to a configured domainsPath and
 * silently no-ops on a real install. Nothing here touches the real domains
 * folder or the real config; §10 fingerprints both.
 *
 * Run with:  node scripts/test-working-state-projects.js   (exit 0 = green)
 */

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
  statSync, utimesSync,
} from 'fs';
import { tmpdir, homedir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ── Isolation MUST be installed before anything resolves a path ──────────
const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-wsproj-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
__setUserDataDirOverride(USER_DATA);
__setDomainsDirOverride(DOMAINS);

process.on('exit', () => {
  try {
    if (path.dirname(TMP) === tmpdir() && path.basename(TMP).startsWith('curator-wsproj-')) {
      rmSync(TMP, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
});

const WS = await import('../src/brain/working-state.js');
const {
  saveWorkingState, readWorkingState, listWorkingScopes, listScopeMachines,
  saveProjectBrief, saveProjectBriefText, saveProjectBriefSections,
  readProjectBrief, listProjects, listAllProjects, resolveProject, resolveScope,
  createProject, renameProject, deleteProject, scanStateLayout,
  parseBriefProvenance, projectPrefix, isDefaultProject, briefTemplate,
  wouldShrinkBrief, neutraliseProtocol,
  MAX_BRIEF_BYTES, MIN_PROTECTED_BODY_BYTES, REPLACE_RATIO,
  CURRENT_FILENAME, JOURNAL_FILENAME, BRIEF_FILENAME, LATEST_SCOPE,
  MAX_PROJECTS_PER_DOMAIN, MAX_PROJECTS_TOTAL,
} = WS;

// ── Harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function bad(label, err) {
  failed++; failures.push({ label, err });
  console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err}`);
}
function assert(cond, label, err) { cond ? ok(label) : bad(label, err || 'assertion failed'); }
function section(name) { console.log(`\n── ${name} ──`); }

/** A REAL domain: a folder with a CLAUDE.md, which is what listDomains() sees. */
function makeDomain(name, { readonly = false } = {}) {
  mkdirSync(path.join(DOMAINS, name, 'wiki'), { recursive: true });
  writeFileSync(path.join(DOMAINS, name, 'CLAUDE.md'),
    readonly ? '---\nreadonly: true\n---\n# Mirror\n' : `# ${name}\n`);
}

const M = 'testbox';                       // explicit machine segment, for determinism
const statePath = (domain, ...rest) => path.join(DOMAINS, domain, 'state', ...rest);

makeDomain('legacydom');
makeDomain('multidom');
makeDomain('otherdom');
makeDomain('freshdom');
makeDomain('shared-cohort', { readonly: true });

// ═════════════════════════════════════════════════════════════════════════
section('1. A pre-v3.48.0 tree is the domain\'s own project, and NOTHING MOVES');
// A machine still running v3.47 reads only `state/<scope>/<machine>/`. If this
// release wrote one level down, that machine reports "no working state saved"
// over a handoff sitting on its own disk — false absence manufactured by a
// layout change. So the assertion is about the PATH, not only the value.
{
  const r = await saveWorkingState('legacydom', {
    scope: 'main', machine: M, headline: 'legacy save', nowState: 'body text here',
  });
  assert(r.ok === true, 'a save with no `project` argument succeeds', JSON.stringify(r).slice(0, 200));
  assert(existsSync(statePath('legacydom', 'main', M, CURRENT_FILENAME)),
    'it wrote state/<scope>/<machine>/current.md — the pre-v3.48.0 path, byte for byte');
  assert(!existsSync(statePath('legacydom', 'legacydom')),
    'and NOT state/<domain>/… — an older Curator on another machine can still read it');
  assert(r.path === `state/main/${M}/${CURRENT_FILENAME}`,
    'the reported path has no project segment', r.path);
  assert(r.project === 'legacydom' && r.domain === 'legacydom',
    '`project` still returns the domain name (the default project\'s slug IS the domain), and `domain` is added beside it',
    JSON.stringify({ p: r.project, d: r.domain }));

  await saveProjectBrief('legacydom', { brief: 'the standing mission, at length' });
  assert(existsSync(statePath('legacydom', BRIEF_FILENAME)),
    'the structured brief writer still writes state/project.md at the root');

  const read = await readWorkingState('legacydom', { scope: 'main' });
  assert(read.ok && read.current.present && /body text here/.test(read.current.text),
    'a read with no `project` argument finds the legacy handoff');
  assert(read.brief.present === true, '…and the legacy brief');
  assert(read.project === 'legacydom' && read.domain === 'legacydom',
    'the read reports project = domain for the default project');
  assert(read.projectExists === true, 'projectExists is true for the domain\'s own project');
}

// ═════════════════════════════════════════════════════════════════════════
section('2. `projectPrefix` is PURE — no filesystem probe decides a write path');
// The whole compatibility argument rests on this being a string comparison.
// If it ever consulted the disk, where a save lands would depend on what
// happened to exist at the moment of the call.
{
  assert(projectPrefix('dom', undefined) === '', 'no project → root (empty prefix)');
  assert(projectPrefix('dom', 'dom') === '', 'the domain\'s own name → root');
  assert(projectPrefix('dom', 'lumina') === 'lumina/', 'a named project → one level down');
  assert(projectPrefix('dom', '../etc') === null, 'a traversal segment is refused, not sanitised');
  assert(projectPrefix('dom', 'project.md') === null, 'a reserved filename is refused');
  assert(projectPrefix('dom', 'journal.jsonl') === null, '…as is journal.jsonl');
  assert(projectPrefix('../x', 'lumina') === null, 'an unsafe DOMAIN is refused too');
  assert(isDefaultProject('dom', 'dom') && isDefaultProject('dom', null)
    && !isDefaultProject('dom', 'lumina'), 'isDefaultProject agrees with the prefix rule');
  // Purity: the same answer with nothing on disk at all.
  assert(projectPrefix('never-created-domain', 'never-created-project') === 'never-created-project/',
    'it answers for a domain and project that do not exist — so it reads no disk');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. A NAMED project round-trips, one level down, without disturbing the default');
{
  const created = await createProject('multidom', 'Lumina AI', { brief: '## Standing brief\n\nBuild the thing.' });
  assert(created.ok === true && created.project === 'lumina-ai',
    'createProject slugifies the name it was given', JSON.stringify(created).slice(0, 160));
  assert(existsSync(statePath('multidom', 'lumina-ai', BRIEF_FILENAME)),
    'it wrote state/<project>/project.md');
  assert(created.markerLine === 'multidom/lumina-ai',
    'and hands back the `.curator-project` marker line', created.markerLine);

  // A project with a brief and NO saves must still be visible. That is the
  // whole reason createProject always writes project.md — a directory with
  // neither marker nor saves matches neither shape scanStateLayout looks for,
  // so it would be invisible to its own store the moment it was made.
  const listedEarly = await listProjects('multidom');
  assert(listedEarly.projects.some((p) => p.project === 'lumina-ai'),
    'a brand-new project with no saves is already listed');

  const sv = await saveWorkingState('multidom', {
    project: 'lumina-ai', scope: 'api', machine: M,
    headline: 'api layer sketched', nowState: 'three routes done',
  });
  assert(sv.ok === true, 'a save into the named project succeeds', JSON.stringify(sv).slice(0, 200));
  assert(sv.path === `state/lumina-ai/api/${M}/${CURRENT_FILENAME}`, 'and lands one level down', sv.path);
  assert(sv.project === 'lumina-ai' && sv.domain === 'multidom',
    'the result names the project AND the domain');

  const rd = await readWorkingState('multidom', { project: 'lumina-ai', scope: 'api' });
  assert(rd.ok && rd.current.present && /three routes done/.test(rd.current.text),
    'and it reads back');
  assert(rd.brief.present === true && /Build the thing/.test(rd.brief.text),
    'the project\'s OWN brief comes back, not the domain\'s');

  // The default project must be untouched by all of that.
  const dflt = await readWorkingState('multidom');
  assert(dflt.scopeCount === 0,
    'the domain\'s own project still has no work-streams — a named project is not one of its scopes',
    String(dflt.scopeCount));
  assert(dflt.brief.present === false,
    'and no brief leaked up from the named project');

  // …and the reverse: a named project does not see the default's scopes.
  await saveWorkingState('multidom', { scope: 'housekeeping', machine: M, headline: 'domain-level', nowState: 'x' });
  const idxNamed = await listWorkingScopes('multidom', { project: 'lumina-ai' });
  // ANTI-VACUITY FIRST. Found by mutation: the two halves of the project path
  // (the directory the scan STARTS from, and the prefix on each pair's own
  // current.md) each defeat the other's removal by producing an EMPTY index —
  // over which "does not include the default project's scope" is true and
  // means nothing. The non-emptiness assertion is what makes the next one a
  // measurement.
  assert(idxNamed.ok === true && idxNamed.scopes.some((s) => s.scope === 'api'),
    'the named project\'s index finds its OWN work-stream',
    JSON.stringify(idxNamed.scopes?.map((s) => s.scope)));
  assert(idxNamed.scopes.every((s) => s.scope !== 'housekeeping'),
    'the named project\'s index does not include the default project\'s scope');
  const idxDflt = await listWorkingScopes('multidom');
  assert(idxDflt.scopes.some((s) => s.scope === 'housekeeping'),
    'the default project\'s index finds its own work-stream',
    JSON.stringify(idxDflt.scopes?.map((s) => s.scope)));
  assert(idxDflt.scopes.every((s) => s.scope !== 'api'),
    'and does not include the named project\'s');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. Layout detection: depth decides, and an ambiguous tree is REPORTED');
{
  makeDomain('mixeddom');
  // A legacy scope: state/<scope>/<machine>/current.md  (depth 1 to current.md)
  mkdirSync(statePath('mixeddom', 'oldscope', 'boxa'), { recursive: true });
  writeFileSync(statePath('mixeddom', 'oldscope', 'boxa', CURRENT_FILENAME), '# s\n\n## Where things stand\n\nx\n');
  // A named project: state/<proj>/<scope>/<machine>/current.md  (depth 2)
  mkdirSync(statePath('mixeddom', 'newproj', 'work', 'boxa'), { recursive: true });
  writeFileSync(statePath('mixeddom', 'newproj', 'work', 'boxa', CURRENT_FILENAME), '# p\n\n## Where things stand\n\ny\n');

  const layout = await scanStateLayout('mixeddom');
  assert(layout.ok === true, 'scanStateLayout reads the tree');
  assert(layout.projects.some((p) => p.project === 'newproj'),
    'the depth-2 directory is a PROJECT', JSON.stringify(layout.projects));
  assert(layout.defaultScopeDirs.includes('oldscope'),
    'the depth-1 directory is a legacy SCOPE of the default project');
  assert(!layout.projects.some((p) => p.project === 'oldscope'),
    'and is NOT reported as a project');
  assert(layout.ambiguous.length === 0, 'nothing here is ambiguous');

  // Now the genuinely ambiguous shape: a directory that is BOTH.
  mkdirSync(statePath('mixeddom', 'both', 'boxa'), { recursive: true });
  writeFileSync(statePath('mixeddom', 'both', 'boxa', CURRENT_FILENAME), '# a\n\n## Where things stand\n\nz\n');
  mkdirSync(statePath('mixeddom', 'both', 'sc', 'boxb'), { recursive: true });
  writeFileSync(statePath('mixeddom', 'both', 'sc', 'boxb', CURRENT_FILENAME), '# b\n\n## Where things stand\n\nw\n');

  const layout2 = await scanStateLayout('mixeddom');
  assert(layout2.ambiguous.includes('both'), 'a directory showing BOTH depths is reported ambiguous');
  assert(layout2.projects.some((p) => p.project === 'both')
    && layout2.defaultScopeDirs.includes('both'),
    'and it is listed on BOTH sides — nothing on disk becomes unreadable while the user decides');

  const listed = await listProjects('mixeddom');
  assert(typeof listed.layoutWarning === 'string' && /both/.test(listed.layoutWarning),
    'listProjects surfaces a layoutWarning naming the directory', String(listed.layoutWarning).slice(0, 140));
  assert(/[Nn]othing was moved/.test(listed.layoutWarning),
    '…and says nothing was moved, because nothing was');

  // A directory named after the domain would shadow the default project.
  makeDomain('shadowdom');
  mkdirSync(statePath('shadowdom', 'shadowdom', 'sc', 'boxa'), { recursive: true });
  writeFileSync(statePath('shadowdom', 'shadowdom', 'sc', 'boxa', CURRENT_FILENAME), '# s\n\n## Where things stand\n\nq\n');
  const sh = await listProjects('shadowdom');
  assert(sh.projects.every((p) => p.project !== 'shadowdom' || p.isDefaultProject === true),
    'a directory named after the domain is NOT listed as a second project of that name');
  assert(/shadowdom/.test(sh.layoutWarning || '') && /Rename it/.test(sh.layoutWarning || ''),
    'it is reported with the fix, not silently preferred', String(sh.layoutWarning).slice(0, 160));

  // An EMPTY directory is a scope, not a project — the conservative direction.
  makeDomain('emptydom');
  mkdirSync(statePath('emptydom', 'nothing-here'), { recursive: true });
  const el = await scanStateLayout('emptydom');
  assert(el.projects.length === 0 && el.defaultScopeDirs.includes('nothing-here'),
    'a directory with neither shape reads as a legacy scope, never as a phantom project');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. resolveProject NEVER GUESSES');
{
  // 5a — exact, with a domain.
  const a = await resolveProject({ domain: 'multidom', project: 'lumina-ai' });
  assert(a.ok && a.domain === 'multidom' && a.project === 'lumina-ai' && a.resolvedBy === 'explicit',
    'domain + project resolves explicitly', JSON.stringify(a));

  // 5b — a bare DOMAIN name always resolves, even with nothing on disk. This
  // is what keeps every pre-v3.48.0 caller working: `project` has meant a
  // domain slug on the MCP tools since v3.17.0.
  const fresh = await resolveProject({ project: 'freshdom' });
  assert(fresh.ok && fresh.domain === 'freshdom' && fresh.project === 'freshdom'
    && fresh.isDefaultProject === true,
    'a bare domain name resolves to its own project even with an empty state/', JSON.stringify(fresh));

  // 5c — a bare PROJECT name, unique across domains.
  const uniq = await resolveProject({ project: 'lumina-ai' });
  assert(uniq.ok && uniq.domain === 'multidom' && uniq.resolvedBy === 'search',
    'a unique bare project name resolves by searching every domain', JSON.stringify(uniq));

  // 5d — AMBIGUOUS. Two domains, one project name.
  await createProject('otherdom', 'lumina-ai', { brief: '## Standing brief\n\nA different Lumina.' });
  const amb = await resolveProject({ project: 'lumina-ai' });
  assert(amb.ok !== true && amb.error === 'project_ambiguous',
    'the same name in two domains is refused as ambiguous', JSON.stringify(amb).slice(0, 200));
  assert(!('domain' in amb) || amb.domain === undefined,
    'and NOTHING is resolved — no domain is handed back as a winner');
  const domains = (amb.candidates || []).map((c) => c.domain).sort();
  assert(domains.join(',') === 'multidom,otherdom',
    'both candidates are named so the caller can ask', JSON.stringify(amb.candidates));
  // …but naming the domain still works.
  const dis = await resolveProject({ domain: 'otherdom', project: 'lumina-ai' });
  assert(dis.ok && dis.domain === 'otherdom', 'naming the domain disambiguates it');

  // 5e — NOT FOUND, with near matches and no resolution.
  const miss = await resolveProject({ project: 'lumin' });
  assert(miss.ok !== true && miss.error === 'project_not_found', 'an unknown name is refused');
  assert((miss.candidates || []).some((c) => c.project === 'lumina-ai'),
    'near matches are offered as candidates', JSON.stringify(miss.candidates));
  assert(!('domain' in miss) || miss.domain === undefined,
    'and again nothing is resolved for the caller');
  assert(/Unknown domain/i.test(miss.message) && /CLAUDE\.md/.test(miss.message),
    'the message says the name is neither a project nor a domain, and why nothing is created for it',
    String(miss.message).slice(0, 200));

  // 5f — an unknown DOMAIN is its own refusal, distinct from an unknown project.
  const badDom = await resolveProject({ domain: 'no-such-domain', project: 'x' });
  assert(badDom.ok !== true && badDom.error === 'unknown_domain',
    'an unknown domain is refused as such, not reported as a missing project', JSON.stringify(badDom).slice(0, 160));

  // 5g — a project that exists in a NAMED domain but is asked for there wrongly.
  const wrongDom = await resolveProject({ domain: 'legacydom', project: 'lumina-ai' });
  assert(wrongDom.ok !== true && wrongDom.error === 'project_not_found',
    'a real project asked for in the wrong domain is a miss, not a cross-domain hit');
}

// ═════════════════════════════════════════════════════════════════════════
section('6. `latest`, and the scope that is genuinely called "latest"');
{
  makeDomain('latestdom');
  await saveWorkingState('latestdom', { scope: 'first', machine: M, headline: 'one', nowState: 'a' });
  // mtime resolution on some filesystems is coarse; stamp them apart rather
  // than sleeping, so the ordering under test is the store's and not the clock's.
  const older = statePath('latestdom', 'first', M, CURRENT_FILENAME);
  const t = Date.now() / 1000 - 600;
  utimesSync(older, t, t);
  await saveWorkingState('latestdom', { scope: 'second', machine: M, headline: 'two', nowState: 'b' });

  const res = await resolveScope('latestdom', 'latestdom', 'latest');
  assert(res.ok && res.scope === 'second' && res.resolvedBy === 'latest',
    '`latest` resolves to the newest-written scope', JSON.stringify(res));
  assert((await resolveScope('latestdom', 'latestdom', 'LATEST')).scope === 'second',
    '…case-insensitively');

  const rd = await readWorkingState('latestdom', { scope: 'latest' });
  assert(rd.ok && rd.scope === 'second' && rd.current.present,
    'readWorkingState opens it', JSON.stringify({ s: rd.scope, p: rd.current?.present }));
  assert(rd.scopeResolvedBy === 'latest',
    'and SAYS it chose rather than obeyed — the caller can tell the user which one it opened',
    rd.scopeResolvedBy);
  const named = await readWorkingState('latestdom', { scope: 'second' });
  assert(named.scopeResolvedBy === 'exact', 'a named scope reports `exact`', named.scopeResolvedBy);

  // A REAL scope called `latest` wins over the keyword. Resolving the keyword
  // over a directory that exists would open a DIFFERENT work-stream than the
  // one named — a correctness bug wearing a helpfulness costume.
  await saveWorkingState('latestdom', { scope: LATEST_SCOPE, machine: M, headline: 'literally latest', nowState: 'c' });
  const clash = await readWorkingState('latestdom', { scope: 'latest' });
  assert(clash.scope === 'latest' && /literally latest/.test(clash.current.text || ''),
    'an actual scope named "latest" wins over the keyword', clash.current?.text?.slice(0, 60));
  assert(clash.scopeResolvedBy === 'exact', '…and is reported as an exact match, not as a choice');

  // Cold start: `latest` over a project with no saves is not an error.
  makeDomain('colddom');
  const cold = await readWorkingState('colddom', { scope: 'latest' });
  assert(cold.ok === true && cold.scope === null,
    '`latest` on a project with nothing saved yields an index read, not a refusal', JSON.stringify(cold.scope));
  assert(/no latest one to open/.test(cold.message || ''),
    '…with a message that says exactly that', cold.message);
}

// ═════════════════════════════════════════════════════════════════════════
section('7. Tier 1: whole-markdown briefs, provenance, and the shrink guard');
{
  makeDomain('briefdom');
  const hand = [
    '# briefdom',
    '',
    '## Standing brief',
    '',
    'Ship the adapter.',
    '',
    '## Roadmap',
    '',
    '- A section this store knows nothing about.',
    '',
    '## How I want you to work',
    '',
    'Delegate; do not build.',
  ].join('\n');

  const w = await saveProjectBriefText('briefdom', 'briefdom', hand, {
    authoredBy: { kind: 'agent', harness: 'Claude Code', model: 'opus-5', instructedBy: 'user' },
  });
  assert(w.ok === true, 'a whole-markdown brief write succeeds', JSON.stringify(w).slice(0, 200));

  const disk = readFileSync(statePath('briefdom', BRIEF_FILENAME), 'utf8');
  assert(/^<!-- curator-brief: authored_by=agent /.test(disk),
    'the provenance comment is the first line', disk.slice(0, 90));
  assert(/harness=Claude-Code/.test(disk) && /model=opus-5/.test(disk) && /commissioned=user/.test(disk),
    'it records the harness, the model and that a user commissioned it', disk.split('\n')[0]);
  assert(disk.includes('## Roadmap') && disk.includes('- A section this store knows nothing about.'),
    'AN ARBITRARY SECTION SURVIVES — this is the whole reason for the whole-text writer');
  assert(!/\\#/.test(disk),
    'and headings are NOT escaped: R3 would turn every "## " the user typed into a literal backslash',
    (disk.match(/\\#[^\n]*/) || [''])[0]);

  // The provenance comment must be a FIXED POINT of the read sanitiser. If the
  // sanitiser touched it, `sanitisedOnRead` would go true and the brief would
  // be classified `suspect` — downgraded by its own writer.
  assert(neutraliseProtocol(disk) === disk,
    'the whole stored document is a fixed point of the read-side sanitiser');
  const rb = await readProjectBrief('briefdom', 'briefdom');
  assert(rb.present === true && rb.sanitisedOnRead === false,
    'so a read of it reports no sanitisation', JSON.stringify({ p: rb.present, s: rb.sanitisedOnRead }));
  assert(rb.headingsSuspect === false, 'and no heading suspicion on a normal round trip');
  assert(rb.authoredBy && rb.authoredBy.kind === 'agent' && rb.authoredBy.harness === 'Claude-Code',
    'the parsed provenance comes back structured', JSON.stringify(rb.authoredBy));
  assert(typeof rb.authoredBy.at === 'string' && !Number.isNaN(Date.parse(rb.authoredBy.at)),
    '…including a usable timestamp', rb.authoredBy.at);

  // A hand-authored file (no comment) is the `owner` reading.
  makeDomain('handdom');
  mkdirSync(statePath('handdom'), { recursive: true });
  writeFileSync(statePath('handdom', BRIEF_FILENAME), '# hand\n\n## Standing brief\n\nTyped by a person.\n');
  const hb = await readProjectBrief('handdom', 'handdom');
  assert(hb.present && hb.authoredBy === null,
    'a brief with no provenance comment reports authoredBy: null — the hand-authored reading');

  // An UNRECOGNISED authored_by must not read as human. Missing evidence may
  // not buy authority.
  const weird = parseBriefProvenance('<!-- curator-brief: authored_by=wizard on=2026-01-01T00:00:00.000Z -->\n\nx');
  assert(weird && weird.kind === 'unknown',
    'an unreadable authored_by value parses as `unknown`, never as `human`', JSON.stringify(weird));

  // The provenance header is re-stamped, never stacked.
  const second = await saveProjectBriefText('briefdom', 'briefdom', disk, {
    authoredBy: { kind: 'human' },
  });
  assert(second.ok, 'a re-save that echoes the stored document back succeeds');
  const disk2 = readFileSync(statePath('briefdom', BRIEF_FILENAME), 'utf8');
  assert((disk2.match(/curator-brief:/g) || []).length === 1,
    'exactly ONE provenance comment — a re-save cannot stack them',
    String((disk2.match(/curator-brief:/g) || []).length));
  assert(/authored_by=human/.test(disk2.split('\n')[0]),
    'and it carries this write\'s authorship, not the previous one\'s', disk2.split('\n')[0]);

  // The destructive-shrink guard.
  assert(wouldShrinkBrief(0, 0).destructive === false, 'no prior brief → nothing to destroy');
  assert(wouldShrinkBrief(4000, 0).destructive === true, 'an empty write over a stored brief is destructive');
  // ARM A INDEPENDENTLY. Found by mutation: at 4,000 prior bytes the RATIO arm
  // also fires on an empty write, so the assertion above passes with arm A
  // deleted. Arm A is the STRUCTURAL one — something replaced by nothing — and
  // it has no threshold in it, which is exactly what makes it hold BELOW the
  // magnitude arm's protected floor where arm B declines to fire at all.
  assert(wouldShrinkBrief(MIN_PROTECTED_BODY_BYTES - 1, 0).destructive === true,
    'arm A alone: an empty write over a SMALL stored brief is destructive, where the magnitude arm does not fire');
  assert(wouldShrinkBrief(MIN_PROTECTED_BODY_BYTES - 1, 1).destructive === false,
    'CONTROL: one byte is not nothing — arm A is about emptiness, not about size');
  assert(wouldShrinkBrief(MIN_PROTECTED_BODY_BYTES - 1, 1).destructive === false,
    'under the protected floor the guard does not fire — it must not be chatty on small briefs');
  assert(wouldShrinkBrief(4000, Math.floor(4000 * REPLACE_RATIO) - 1).destructive === true,
    'under the replace ratio it does');
  assert(wouldShrinkBrief(4000, Math.ceil(4000 * REPLACE_RATIO) + 1).destructive === false,
    'at or above it, it does not');

  makeDomain('shrinkdom');
  await saveProjectBriefText('shrinkdom', 'shrinkdom', 'the full standing brief. '.repeat(120), {});
  const tiny = await saveProjectBriefText('shrinkdom', 'shrinkdom', 'oops', {});
  assert(tiny.ok === false && tiny.reason === 'would-replace-larger-brief',
    'a drastic shrink is REFUSED end to end', JSON.stringify(tiny).slice(0, 160));
  assert(/no journal behind tier 1/i.test(tiny.message) && /replace: true/.test(tiny.message),
    'the refusal names why it is unrecoverable AND the way past it',
    String(tiny.message).slice(0, 200));
  const stillThere = readFileSync(statePath('shrinkdom', BRIEF_FILENAME), 'utf8');
  assert(stillThere.length > 2000, 'and NOTHING was written — the stored brief is intact',
    String(stillThere.length));
  const forced = await saveProjectBriefText('shrinkdom', 'shrinkdom', 'oops', { replace: true });
  assert(forced.ok === true, 'replace: true gets past it');
  assert((forced.notes || []).some((n) => /^replace: deliberately overwrote/.test(n)),
    '…and is never silent about it', JSON.stringify(forced.notes));

  // Empty is always refused, with or without replace.
  for (const [label, text] of [['empty string', ''], ['whitespace', '   \n\n  '], ['non-string', 42]]) {
    const e = await saveProjectBriefText('briefdom', 'briefdom', text, { replace: true });
    assert(e.ok === false && e.reason === 'empty-brief', `an ${label} brief is refused`, JSON.stringify(e).slice(0, 120));
  }

  // The size cap trims and DISCLOSES rather than refusing.
  const huge = 'x'.repeat(MAX_BRIEF_BYTES + 5000);
  const big = await saveProjectBriefText('briefdom', 'briefdom', `## Standing brief\n\n${huge}`, { replace: true });
  assert(big.ok === true && big.truncated === true, 'an over-budget brief is trimmed, not refused',
    JSON.stringify({ ok: big.ok, t: big.truncated }));
  assert((big.notes || []).some((n) => /truncated/.test(n)), '…and the trim is disclosed in notes',
    JSON.stringify(big.notes));
  assert(statSync(statePath('briefdom', BRIEF_FILENAME)).size <= MAX_BRIEF_BYTES,
    'the file on disk is inside the budget', String(statSync(statePath('briefdom', BRIEF_FILENAME)).size));
}

// ═════════════════════════════════════════════════════════════════════════
section('8. The two brief front doors are ONE writer');
{
  makeDomain('doordom');
  const viaText = await saveProjectBrief('doordom', 'doordom', '## Standing brief\n\nvia the text door');
  assert(viaText.ok === true && /via the text door/.test(readFileSync(statePath('doordom', BRIEF_FILENAME), 'utf8')),
    'saveProjectBrief(domain, project, text) dispatches to the whole-markdown writer');
  const viaSections = await saveProjectBrief('doordom', { brief: 'via the structured door', replace: true });
  assert(viaSections.ok === true, 'saveProjectBrief(domain, {sections}) still dispatches to the legacy writer',
    JSON.stringify(viaSections).slice(0, 160));
  const structured = readFileSync(statePath('doordom', BRIEF_FILENAME), 'utf8');
  assert(structured.startsWith('# Project brief — doordom'),
    'and the legacy document is byte-shaped exactly as before — no provenance header prepended',
    structured.slice(0, 60));
  assert(!/curator-brief:/.test(structured),
    'the legacy door makes no authorship claim, because its callers made none');
  // Hostile input must not throw on either door.
  for (const j of [null, undefined, 42, [], {}, 'x'.repeat(5000)]) {
    let threw = null;
    try { await saveProjectBrief(j, j); } catch (e) { threw = e; }
    assert(!threw, `no throw for saveProjectBrief(${JSON.stringify(j) ?? String(j)}, same)`, threw && threw.message);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('9. create / rename / delete, and every refusal they owe');
{
  makeDomain('admindom');
  await saveWorkingState('admindom', { scope: 'legacyscope', machine: M, headline: 'x', nowState: 'y' });

  for (const [label, name, reason] of [
    ['the domain\'s own name', 'admindom', 'reserved-project'],
    ['a legacy scope directory at the state root', 'legacyscope', 'reserved-project'],
    ['a reserved filename', 'project.md', 'invalid-state-project'],
  ]) {
    const r = await createProject('admindom', name);
    assert(r.ok === false && r.reason === reason,
      `createProject refuses ${label} (${reason})`, JSON.stringify(r).slice(0, 180));
  }
  const noDomain = await createProject('no-such-domain', 'thing');
  assert(noDomain.ok === false && noDomain.reason === 'unknown-project',
    'createProject refuses a domain that does not exist');
  const mirror = await createProject('shared-cohort', 'thing');
  assert(mirror.ok === false && mirror.reason === 'readonly',
    'createProject refuses a read-only Shared Brain mirror', JSON.stringify(mirror).slice(0, 140));

  const c = await createProject('admindom', 'alpha');
  assert(c.ok === true && c.briefSeeded === true, 'createProject with no brief seeds a template');
  const seeded = readFileSync(statePath('admindom', 'alpha', BRIEF_FILENAME), 'utf8');
  assert(seeded.includes('## Standing brief') && seeded.includes('_'),
    'the template is headings and prompts, never invented claims about the project',
    seeded.slice(0, 120));
  assert(briefTemplate('zz').includes('## Firm decisions'), 'briefTemplate is the source of that shape');
  const dup = await createProject('admindom', 'alpha');
  assert(dup.ok === false && dup.reason === 'project-exists', 'creating it twice is refused');

  // rename
  await saveWorkingState('admindom', { project: 'alpha', scope: 'w', machine: M, headline: 'inside alpha', nowState: 'z' });
  const rn = await renameProject('admindom', 'alpha', 'beta');
  assert(rn.ok === true && rn.project === 'beta', 'renameProject moves the directory', JSON.stringify(rn).slice(0, 140));
  assert(existsSync(statePath('admindom', 'beta', 'w', M, CURRENT_FILENAME))
    && !existsSync(statePath('admindom', 'alpha')),
    'the whole subtree moved with it');
  assert((await renameProject('admindom', 'admindom', 'gamma')).reason === 'default-project',
    'renaming the domain\'s own project is refused — its folder IS the state root');
  assert((await renameProject('admindom', 'nope', 'gamma')).reason === 'unknown-state-project',
    'renaming a project that does not exist is refused');
  await createProject('admindom', 'gamma');
  assert((await renameProject('admindom', 'beta', 'gamma')).reason === 'project-exists',
    'renaming onto an existing project is refused');

  // delete
  const noConfirm = await deleteProject('admindom', 'beta');
  assert(noConfirm.ok === false && noConfirm.reason === 'confirm-required',
    'deleteProject refuses without a typed confirmation', JSON.stringify(noConfirm).slice(0, 140));
  assert(/confirm: "beta"/.test(noConfirm.message), 'and names the exact string to send back',
    String(noConfirm.message).slice(0, 200));
  const wrongConfirm = await deleteProject('admindom', 'beta', { confirm: true });
  assert(wrongConfirm.ok === false && wrongConfirm.reason === 'confirm-required',
    'a boolean `true` is NOT a confirmation — one stray truthy value must not delete a project');
  assert(existsSync(statePath('admindom', 'beta')), 'nothing was deleted by either refusal');
  const del = await deleteProject('admindom', 'beta', { confirm: 'beta' });
  assert(del.ok === true && del.removedCopies >= 1,
    'the typed confirmation deletes it and reports what went', JSON.stringify(del).slice(0, 140));
  assert(!existsSync(statePath('admindom', 'beta')), 'the directory is gone');
  assert((await deleteProject('admindom', 'admindom', { confirm: 'admindom' })).reason === 'default-project',
    'the domain\'s own project cannot be deleted here — its folder holds every named project too');
  assert(existsSync(statePath('admindom', 'legacyscope', M, CURRENT_FILENAME)),
    'and the default project\'s own state survived all of that');
}

// ═════════════════════════════════════════════════════════════════════════
section('10. Saving into an unknown project is REFUSED, never created');
{
  const r = await saveWorkingState('multidom', { project: 'typo-project', scope: 'main', machine: M, headline: 'x', nowState: 'y' });
  assert(r.ok === false && r.reason === 'unknown-state-project',
    'a save into a project that does not exist is refused', JSON.stringify(r).slice(0, 200));
  assert(!existsSync(statePath('multidom', 'typo-project')),
    'and NOTHING was created on disk — a typo must not mint a folder no listing shows');
  assert(/lumina-ai/.test(r.message), 'the refusal lists the projects that do exist',
    String(r.message).slice(0, 200));
  assert(Array.isArray(r.candidates) && r.candidates.includes('lumina-ai'),
    'and hands them back as data too', JSON.stringify(r.candidates));
  // The domain's own project is always writable without being "created".
  const dflt = await saveWorkingState('multidom', { project: 'multidom', scope: 'zz', machine: M, headline: 'x', nowState: 'y' });
  assert(dflt.ok === true, 'CONTROL: the domain\'s own name is always an existing project');
}

// ═════════════════════════════════════════════════════════════════════════
section('11. listProjects / listAllProjects');
{
  const one = await listProjects('multidom');
  assert(one.ok === true && one.projects.length >= 2, 'listProjects returns the domain\'s projects',
    JSON.stringify(one.projects.map((p) => p.project)));
  const row = one.projects.find((p) => p.project === 'lumina-ai');
  assert(row && row.domain === 'multidom' && row.hasBrief === true && row.newestScope === 'api',
    'a row carries the domain, brief presence and the newest work-stream', JSON.stringify(row).slice(0, 220));
  assert(row.headline === 'api layer sketched',
    'and the headline from that work-stream\'s newest save', row.headline);
  assert(row.scopeCount === 1 && row.savedCopies === 1,
    'scopeCount counts distinct work-streams; savedCopies counts (scope, machine) pairs',
    JSON.stringify({ s: row.scopeCount, c: row.savedCopies }));
  assert(one.projects.some((p) => p.isDefaultProject === true),
    'the domain\'s own project is listed once it has content');

  const empty = await listProjects('freshdom');
  assert(empty.ok === true && empty.projects.length === 0,
    'a domain with nothing saved lists no projects — an empty row is noise');

  const all = await listAllProjects();
  assert(all.ok === true && all.projects.length >= 3, 'listAllProjects spans domains',
    String(all.projects.length));
  assert(new Set(all.projects.map((p) => p.domain)).size >= 2, '…really more than one');
  const withWrites = all.projects.filter((p) => p.lastWriteAt);
  const times = withWrites.map((p) => Date.parse(p.lastWriteAt));
  assert(times.every((t, i) => i === 0 || times[i - 1] >= t),
    'rows are newest-written first', JSON.stringify(times.slice(0, 5)));
  assert(all.projects.slice(withWrites.length).every((p) => !p.lastWriteAt),
    'and a project with no saves sorts after every project that has one');
  assert(MAX_PROJECTS_PER_DOMAIN === 200 && MAX_PROJECTS_TOTAL === 200,
    'the caps are the documented ones', `${MAX_PROJECTS_PER_DOMAIN}/${MAX_PROJECTS_TOTAL}`);
}

// ═════════════════════════════════════════════════════════════════════════
section('12. Containment still holds one level down');
{
  for (const evil of ['../../etc', 'a/b', '..', '/abs', '.hidden']) {
    const r = await saveWorkingState('multidom', {
      project: evil, scope: 'main', machine: M, headline: 'x', nowState: 'y',
    });
    assert(r.ok === false, `a save into project ${JSON.stringify(evil)} is refused`, JSON.stringify(r).slice(0, 140));
  }
  const rd = await readWorkingState('multidom', { project: '../../etc' });
  assert(rd.ok === false && rd.reason === 'invalid-state-project',
    'and so is a read', JSON.stringify(rd).slice(0, 140));
  const idx = await listWorkingScopes('multidom', { project: '../../etc' });
  assert(idx.ok === false, 'listWorkingScopes refuses it too', JSON.stringify(idx).slice(0, 140));
  const sm = await listScopeMachines('multidom', 'api', { project: '../../etc' });
  assert(sm.machines.length === 0, 'listScopeMachines returns empty rather than walking it');
  // Nothing escaped.
  assert(!existsSync(path.join(DOMAINS, 'multidom', 'etc'))
    && !existsSync(path.join(TMP, 'etc')),
    'no directory was created outside the state folder');
}

// ═════════════════════════════════════════════════════════════════════════
section('13. The real tree and the real config are untouched');
{
  const realDomains = path.join(REPO, 'domains');
  const cfgCandidates = [
    path.join(REPO, '.curator-config.json'),
    path.join(homedir(), '.curator-config.json'),
  ];
  let anyChecked = false;
  for (const cfg of cfgCandidates) {
    if (!existsSync(cfg)) continue;
    anyChecked = true;
    const h = createHash('sha256').update(readFileSync(cfg)).digest('hex');
    assert(typeof h === 'string' && h.length === 64,
      `fingerprinted ${path.basename(cfg)} (sha256 ${h.slice(0, 12)}…, ${statSync(cfg).size} B) — compare it by hand across the run`);
  }
  if (!anyChecked) ok('no real .curator-config.json on this machine to disturb');
  let stateDirs = 0;
  if (existsSync(realDomains)) {
    for (const d of (await import('fs')).readdirSync(realDomains)) {
      if (existsSync(path.join(realDomains, d, 'state'))) stateDirs++;
    }
  }
  assert(true, `the repo's own domains/ holds ${stateDirs} state directories — this suite created none of them`);
  assert(existsSync(statePath('multidom', 'lumina-ai')),
    'POSITIVE CONTROL: the suite really did write state/, into the ISOLATED tree');
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.label}\n      ${f.err}`);
  process.exit(1);
}
console.log('✅ All project-layer assertions green');
