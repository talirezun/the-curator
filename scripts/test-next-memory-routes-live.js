#!/usr/bin/env node
/**
 * test-next-memory-routes-live.js — OFFLINE. The two things about
 * src/routes/memory.js that ONLY a real Express dispatch over a real socket,
 * against the REAL working-state store, can show.
 *
 * ── WHY THIS SUITE AND NOT MORE OF test-next-memory-projects.js ───────────
 *
 * That suite calls each route's handler DIRECTLY, out of the router's stack,
 * with a hand-built `{params, query, body}` and a `next()` that THROWS. That
 * is the right tool for almost everything and it is deliberately fast. It is
 * structurally incapable of seeing the two things below:
 *
 *   1. REGISTRATION ORDER. Which handler Express picks for a given URL is the
 *      whole subject of D-G, and a suite that hands the handler its params has
 *      already made that decision for it. v3.61.0 recorded "Express dispatch
 *      not driven live in the route suite" as a known gap; this closes it.
 *   2. A FALL-THROUGH. `GET /:domain/projects` now declines with `next()` when
 *      the caller asks `?as=project`, and the request continues to
 *      `GET /:domain/:project`. There is no way to observe that without a real
 *      router: the direct harness's `next()` throws by construction.
 *
 * And it drives the v3.62.0 `readFirst` arms end to end against the real
 * store, because the field crosses four layers (manifest → store → route
 * allow-list → response) and the recorded defect class in this area is a
 * consumer silently dropping a field the store computed honestly.
 *
 * ── ISOLATION ────────────────────────────────────────────────────────────
 * CURATOR_TEST_USER_DATA_DIR and CURATOR_TEST_DOMAINS_DIR are both set to a
 * tempdir BEFORE anything imports the store, and `__setDomainsDirOverride`
 * belt-and-braces on top. The real domains folder, the real
 * `.curator-config.json` and port 3391 are never touched: the server listens
 * on an EPHEMERAL port (`listen(0)`) on 127.0.0.1 and is closed in `finally`.
 *
 * ── NOT ENFORCED (stated rather than implied) ────────────────────────────
 *   • No view. What the app does with these answers is other suites' subject.
 *   • No concurrency. The store's own lock is exercised by test-foundations.js.
 *   • The 512 KB document cap, the 200 KB project budget and every other
 *     tier-0 refusal are test-foundations.js's; this asks only about routing
 *     and about the fields that cross the wire.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const TMP = mkdtempSync(join(tmpdir(), 'curator-routes-live-'));
const DOMAINS = join(TMP, 'domains');
mkdirSync(DOMAINS, { recursive: true });
// BOTH, and BEFORE the store is imported. The domains one is what redirects
// the wiki tree; the user-data one is what keeps a spawned or in-process
// server away from the developer's real `.sync-config.json` and its PAT.
process.env.CURATOR_TEST_USER_DATA_DIR = TMP;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;

let passed = 0; let failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);

const express = (await import('express')).default;
const router = (await import('../src/routes/memory.js')).default;
const routerMod = await import('../src/routes/memory.js');
const store = await import('../src/brain/working-state.js');

function makeDomain(slug, extraCLAUDE) {
  mkdirSync(join(DOMAINS, slug, 'wiki', 'entities'), { recursive: true });
  writeFileSync(join(DOMAINS, slug, 'CLAUDE.md'), (extraCLAUDE || '') + '# ' + slug + '\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'index.md'), '# Index\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'log.md'), '# Log\n');
}

// THE MAINTAINER'S OWN CASE, by name: a domain called `projects`, whose own
// project is therefore also called `projects` (`defaultProjectOf` returns the
// domain name). `alpha` is the control — every assertion about `projects`
// needs a domain where the two segments differ, or the assertion is about the
// literal rather than about the collision.
makeDomain('projects');
makeDomain('alpha');
makeDomain('shared-mirror', '---\nreadonly: true\n---\n\n');

// A brief in each, so the detail read has something to be about.
mkdirSync(join(DOMAINS, 'projects', 'state'), { recursive: true });
writeFileSync(join(DOMAINS, 'projects', 'state', 'project.md'),
  '# projects\n\n## Standing brief\n\nTHE DOMAIN OWN PROJECT, in a domain called projects.\n');
mkdirSync(join(DOMAINS, 'alpha', 'state'), { recursive: true });
writeFileSync(join(DOMAINS, 'alpha', 'state', 'project.md'),
  '# alpha\n\n## Standing brief\n\nThe alpha domain own project.\n');

// ── A REAL SERVER, on an ephemeral port ──────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/memory', router);
const server = await new Promise((resolve) => {
  const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
});
const BASE = `http://127.0.0.1:${server.address().port}/api/memory`;

async function GET(path) {
  const res = await fetch(BASE + path);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body: body || {} };
}
async function send(method, path, payload) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload === undefined ? {} : payload),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body: body || {} };
}

console.log('test-next-memory-routes-live.js — Express dispatch, the real store, and the reading plan\n');

try {
  // ═══════════════════════════════════════════════════════════════════════
  section('§1  The collision is real — and BOTH readings are live (D-G)');
  // ═══════════════════════════════════════════════════════════════════════
  //
  // `/projects/projects` is one URL naming two resources. Neither is
  // hypothetical: the Domains view fetches the list on every domain switch,
  // and the Project-context view fetches the detail on every project open.
  {
    const list = await GET('/projects/projects');
    eq(list.status, 200, 'GET /projects/projects still answers 200');
    ok(Array.isArray(list.body.projects),
      'and it is STILL THE LIST — the default is byte-identical to what shipped',
      JSON.stringify(Object.keys(list.body)));
    eq(list.body.domain, 'projects', '…about the domain called projects');
    ok(!('brief' in list.body), '…with no `brief`, which is the detail read’s field',
      JSON.stringify(Object.keys(list.body)));
  }
  {
    const detail = await GET('/projects/projects?as=project');
    eq(detail.status, 200, 'GET /projects/projects?as=project answers 200');
    ok(detail.body.brief && detail.body.brief.present === true,
      'and it is THE DETAIL READ — the brief is there', JSON.stringify(Object.keys(detail.body)));
    ok(/THE DOMAIN OWN PROJECT/.test((detail.body.brief || {}).text || ''),
      '…and it is THIS project’s brief, off disk, not a neighbour’s',
      ((detail.body.brief || {}).text || '').slice(0, 80));
    eq(detail.body.project, 'projects', '…named as the project it is');
    ok(!Array.isArray(detail.body.projects),
      '…and it is NOT the list', JSON.stringify(Object.keys(detail.body)));
    ok(detail.body.deprecated !== true,
      '…reached through the CURRENT two-segment read, not the deprecated alias');
  }
  {
    // THE CONTROL that makes the two above mean something: on any other
    // domain the literal still wins by default, and `as=project` still means
    // what it says — a project called `projects`, which `alpha` has not got.
    const list = await GET('/alpha/projects');
    eq(list.status, 200, 'CONTROL: GET /alpha/projects is the list');
    ok(Array.isArray(list.body.projects), '…as it always was');
    const missing = await GET('/alpha/projects?as=project');
    eq(missing.status, 404,
      'GET /alpha/projects?as=project is a 404 — asking for a project that is not there');
    eq(missing.body.reason, 'project_not_found', '…with the reason that says which thing was missing');
  }
  {
    // AN UNRECOGNISED VALUE IS LOUD. This is the deliberate difference from
    // `?open=newest`, which the detail route ignores: `open` picks how much
    // of one resource to send, `as` picks WHICH RESOURCE.
    const typo = await GET('/projects/projects?as=projct');
    eq(typo.status, 400, 'a mistyped `as` is a 400, never the list served quietly');
    eq(typo.body.reason, 'invalid_as', '…with a reason a client can branch on');
    ok(/as=list/.test(typo.body.error || '') && /as=project/.test(typo.body.error || ''),
      '…and an error naming BOTH values', typo.body.error);
    const explicit = await GET('/projects/projects?as=list');
    eq(explicit.status, 200, '`as=list` is accepted and means the default');
    ok(Array.isArray(explicit.body.projects), '…which is the list');
  }
  {
    // THE FOUR-SEGMENT ROUTES WERE NEVER SHADOWED, and still are not — the
    // two-segment literal cannot match four segments. Driven rather than
    // argued, on the domain where the collision lives.
    const init = await send('POST', '/projects/projects/foundations/init',
      { ownership: 'curator', seed: false });
    ok(init.status === 200 || init.status === 201,
      'POST /projects/projects/foundations/init reaches the init route — a FOUR-segment\n      path, which the two-segment literal above cannot shadow in either direction',
      String(init.status));
    ok(init.body.ok === true, '…and really initialises', JSON.stringify(init.body).slice(0, 160));
  }
  {
    // AND THE `as` PARAMETER IS INERT EVERYWHERE ELSE. It is read by exactly
    // one handler; a detail read that happens to carry it must not change.
    const a = await GET('/alpha/alpha');
    const b = await GET('/alpha/alpha?as=project');
    eq(b.status, a.status, '`as` on a URL that never collides changes the status not at all');
    eq(JSON.stringify(b.body.brief), JSON.stringify(a.body.brief),
      '…and not the answer either');
  }
  {
    // THE DEPRECATED ONE-SEGMENT ALIAS still resolves the domain's own
    // project, and `/repo-scan` still precedes it. Both are assertions about
    // REGISTRATION ORDER, which is what this suite exists to drive.
    const alias = await GET('/alpha');
    eq(alias.status, 200, 'the one-segment alias still answers');
    eq(alias.body.deprecated, true, '…and says so');
    const scan = await GET('/repo-scan');
    ok(scan.status === 400 || scan.status === 200,
      'GET /repo-scan reaches the SCAN route, not the alias (a 400 about a missing root, '
      + 'never a 404 about a domain called repo-scan)', JSON.stringify(scan.body).slice(0, 140));
    ok(scan.body.reason !== 'unknown_domain',
      '…proven by the reason: the alias would have answered unknown_domain', scan.body.reason);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§2  The reading plan — PATCH, on a CURATOR-owned project');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const save = await send('PUT', '/projects/projects/foundations/architecture.md',
      { text: '# Architecture\n\nHow it fits together.\n', title: 'Architecture', role: 'architecture' });
    eq(save.status, 200, 'a document is written through the PUT');
    eq(save.body.readFirst, false, '…and is NOT read-first by default — absent means false');

    const flag = await send('PATCH', '/projects/projects/foundations/architecture.md',
      { readFirst: true });
    eq(flag.status, 200, 'PATCH …/foundations/:slug {readFirst: true} answers 200');
    eq(flag.body.readFirst, true, '…reporting the flag it set');
    eq(flag.body.wasReadFirst, false, '…and what it was before');
    eq(flag.body.changed, true, '…and that it moved');
    eq(flag.body.readFirstCount, 1, '…with the count the summary line needs');
    eq(flag.body.onRequestCount, 0, '…and its complement');
    ok(flag.body.readFirstBytes > 0, '…and the flagged bytes', String(flag.body.readFirstBytes));
    eq(flag.body.readFirstBudgetBytes, 122880,
      '…measured against the BOOTSTRAP budget (120 KB), not the 200 KB project budget');
    eq(flag.body.readFirstBudgetExceeded, false, '…which one small document does not exceed');
  }
  {
    // THE MANIFEST IS WHAT MOVED, and the DOCUMENT is what did not. This is
    // the whole argument for the route existing on both ownerships, so it is
    // measured on disk rather than taken from the response.
    const docPath = join(DOMAINS, 'projects', 'state', 'foundations', 'architecture.md');
    const before = createHash('sha256').update(readFileSync(docPath)).digest('hex');
    await send('PATCH', '/projects/projects/foundations/architecture.md', { readFirst: false });
    const after = createHash('sha256').update(readFileSync(docPath)).digest('hex');
    eq(after, before, 'the DOCUMENT ON DISK is byte-identical after a flag write');
    const mf = JSON.parse(readFileSync(
      join(DOMAINS, 'projects', 'state', 'foundations', 'manifest.json'), 'utf8'));
    const row = mf.documents.find((d) => d.slug === 'architecture.md');
    eq(row.readFirst, false, '…while the MANIFEST entry carries the new value');
  }
  {
    // AN IDEMPOTENT PATCH IS A SUCCESS, and says it changed nothing. A view
    // that announced "flagged" on a no-op would be announcing a change
    // nobody made.
    const again = await send('PATCH', '/projects/projects/foundations/architecture.md',
      { readFirst: false });
    eq(again.status, 200, 'setting the flag to what it already is is a SUCCESS');
    eq(again.body.changed, false, '…and reports `changed: false` rather than inventing an edit');
    eq(again.body.readFirst, false, '…with the state that holds');
  }
  {
    // THE BODY IS ONE FIELD. This route is reachable on a MIRROR, so a body
    // that quietly ignored a `text` key would be a write path to a mirrored
    // document wearing the wrong method.
    const noField = await send('PATCH', '/projects/projects/foundations/architecture.md', {});
    eq(noField.status, 400, 'an empty body is refused');
    eq(noField.body.reason, 'invalid_read_first', '…with the reason naming the field');
    const wrongType = await send('PATCH', '/projects/projects/foundations/architecture.md',
      { readFirst: 'yes' });
    eq(wrongType.status, 400, 'a string is refused — `=== boolean`, never truthiness');
    const smuggled = await send('PATCH', '/projects/projects/foundations/architecture.md',
      { readFirst: true, text: '# REPLACED\n' });
    eq(smuggled.status, 400, 'a body carrying `text` is REFUSED, not silently ignored');
    eq(smuggled.body.reason, 'unexpected_fields', '…naming what it refused');
    ok((smuggled.body.fields || []).includes('text'), '…by name', JSON.stringify(smuggled.body.fields));
    const doc = readFileSync(
      join(DOMAINS, 'projects', 'state', 'foundations', 'architecture.md'), 'utf8');
    ok(!/REPLACED/.test(doc), '…and the document on disk is untouched by the attempt', doc.slice(0, 60));
  }
  {
    const badSlug = await send('PATCH', '/projects/projects/foundations/..%2Fescape.md',
      { readFirst: true });
    ok(badSlug.status === 400 || badSlug.status === 404,
      'a slug that is not a slug never reaches a path builder', String(badSlug.status));
    const missing = await send('PATCH', '/projects/projects/foundations/nope.md', { readFirst: true });
    eq(missing.status, 404, 'an unknown document is a 404, not a 400 about a bad request');
    eq(missing.body.reason, 'foundation_not_found', '…in this router’s own spelling');
  }
  {
    const noManifest = await send('PATCH', '/alpha/alpha/foundations/architecture.md',
      { readFirst: true });
    eq(noManifest.status, 400, 'a project that has not chosen an ownership yet is a 400');
    eq(noManifest.body.reason, 'no_manifest', '…with the reason that names the missing step');
  }
  {
    // A READ-ONLY SHARED BRAIN DOMAIN, refused at the ROUTE and not merely
    // deep in the store. The store ALSO refuses it (`readonly`, which
    // `statusForStoreRefusal` maps to 403), so a status check alone cannot
    // tell the route's guard from the store's — a mutation removing
    // `refuseMirror` from this handler came back GREEN against exactly that
    // assertion. The SENTENCE is what distinguishes them: the route's names
    // the Shared Brain mirror and says where work belongs instead, which is
    // what the person needs, and the store's cannot because it does not know
    // about cohorts.
    const mirrorDomain = await send('PATCH', '/shared-mirror/shared-mirror/foundations/x.md',
      { readFirst: true });
    eq(mirrorDomain.status, 403,
      'a read-only Shared Brain domain is refused, as on every write route');
    ok(/read-only Shared Brain mirror/.test(mirrorDomain.body.error || ''),
      '…and told so in those words');
    // AND IT IS THE *ROUTE'S* GUARD, not the store's. Both refuse a mirror
    // and both open with the same sentence, so neither the status nor the
    // first clause can tell them apart — a mutation removing `refuseMirror`
    // from this handler came back GREEN against exactly those two. What
    // distinguishes them is the SHAPE: the route's guard runs BEFORE the
    // project name and the slug are even validated, so its body carries
    // neither; the store's refusal is forwarded through `tier0Refusal`,
    // which stamps `slug` and `message` onto it. Structural, not prose.
    ok(!('slug' in mirrorDomain.body),
      '…by the ROUTE\u2019s guard, which fires before the slug is validated and therefore '
      + 'cannot name one', JSON.stringify(Object.keys(mirrorDomain.body)));
    ok(!('message' in mirrorDomain.body),
      '…and before any store refusal, which would have arrived carrying `message`',
      JSON.stringify(Object.keys(mirrorDomain.body)));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§3  The reading plan — PATCH on a REPO-owned project, which is the point');
  // ═══════════════════════════════════════════════════════════════════════
  //
  // The PUT is refused `repo_owned` on a mirror. If the flag rode on the PUT,
  // a mirrored project — the commonest way documents arrive — could not be
  // routed from the app at all. That is the defect this route exists to close,
  // so it is driven rather than argued.
  {
    const repo = join(TMP, 'fake-repo');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'architecture.md'), '# Arch\n\nMirrored verbatim.\n');
    // THE PROJECT FIRST. `foundations/init` addresses a project that exists;
    // it does not create one, and a 404 here would otherwise read as a routing
    // failure rather than as the missing step it is.
    const made = await send('POST', '/alpha/projects', { project: 'mirrored' });
    ok(made.status === 201 || made.status === 200,
      'PRECONDITION: the project is created', JSON.stringify(made.body).slice(0, 160));
    const p = await send('POST', '/alpha/mirrored/foundations/init', {
      ownership: 'repo', repoRoot: repo,
      files: [{ path: 'docs/architecture.md', role: 'architecture' }],
    });
    ok(p.status === 200 || p.status === 201,
      'a repo-owned project is initialised with one mirrored document', String(p.status));

    const put = await send('PUT', '/alpha/mirrored/foundations/architecture.md',
      { text: '# Edited\n' });
    eq(put.status, 400, 'CONTROL: the PUT is still refused on a mirror…');
    eq(put.body.reason, 'repo_owned', '…as `repo_owned`, which is the invariant that matters');

    const srcSha = createHash('sha256')
      .update(readFileSync(join(repo, 'docs', 'architecture.md'))).digest('hex');
    const copyPath = join(DOMAINS, 'alpha', 'state', 'mirrored', 'foundations', 'architecture.md');
    const beforeSha = createHash('sha256').update(readFileSync(copyPath)).digest('hex');

    const flag = await send('PATCH', '/alpha/mirrored/foundations/architecture.md',
      { readFirst: true });
    eq(flag.status, 200, 'but the PATCH is ALLOWED — the reading plan is the owner’s, not the repo’s');
    eq(flag.body.readFirst, true, '…and it really flags');
    const afterSha = createHash('sha256').update(readFileSync(copyPath)).digest('hex');
    eq(afterSha, beforeSha, 'the MIRRORED COPY is byte-identical afterwards');
    eq(afterSha, srcSha, '…and still equal to its source, which is what the freshness claim rests on');

    const idx = await GET('/alpha/mirrored');
    const row = ((idx.body.foundations || {}).documents || [])
      .find((d) => d.slug === 'architecture.md');
    eq(row && row.readFirst, true, 'and the project read carries the flag back');
    eq(row && row.freshness, 'fresh', '…with the document still reading FRESH against its source');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§4  The five readings cross the route’s allow-list');
  // ═══════════════════════════════════════════════════════════════════════
  //
  // `foundationsWire` is a strict allow-list, and the recorded defect class in
  // this area is a consumer silently dropping a field the store computed
  // honestly. So each name is asked for on the ENVELOPE the view reads, not
  // only on the write that produced it.
  {
    const idx = await GET('/projects/projects');
    const f = (await GET('/projects/projects?as=project')).body.foundations || {};
    ok(Array.isArray(idx.body.projects), 'CONTROL: the list read is unaffected by any of this');
    for (const name of ['readFirstCount', 'onRequestCount', 'readFirstBytes',
      'readFirstBudgetBytes', 'readFirstBudgetExceeded']) {
      ok(Object.prototype.hasOwnProperty.call(f, name),
        `the project read forwards \`${name}\``, JSON.stringify(Object.keys(f)));
    }
    ok((f.documents || []).every((d) => typeof d.readFirst === 'boolean'),
      'every document row carries `readFirst` as a real boolean, present even when false',
      JSON.stringify((f.documents || []).map((d) => d.readFirst)));
    // THE TWO BUDGETS ARE DIFFERENT NUMBERS AND MUST STAY SO. Collapsing them
    // would make a view say "within budget" about the wrong budget.
    ok(f.readFirstBudgetBytes !== f.budgetBytes,
      'the read-first budget (120 KB, the bootstrap’s) is NOT the project budget (200 KB)',
      `${f.readFirstBudgetBytes} vs ${f.budgetBytes}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§5  PUT’s `readFirst` is TRI-STATE — an omitted field preserves it');
  // ═══════════════════════════════════════════════════════════════════════
  //
  // A save that normalised an absent field to `false` would silently un-route
  // a document every time its text was edited, and the owner would find their
  // reading plan emptying itself one save at a time with nothing to see.
  {
    await send('PATCH', '/projects/projects/foundations/architecture.md', { readFirst: true });
    const edit = await send('PUT', '/projects/projects/foundations/architecture.md',
      { text: '# Architecture\n\nEdited, with no mention of the reading plan.\n' });
    eq(edit.status, 200, 'an ordinary edit saves');
    eq(edit.body.readFirst, true, '…and the flag SURVIVES it — omitted means "leave it alone"');
    eq(edit.body.wasReadFirst, true, '…with the prior value reported too');

    const off = await send('PUT', '/projects/projects/foundations/architecture.md',
      { text: '# Architecture\n\nAnd now explicitly off.\n', readFirst: false });
    eq(off.body.readFirst, false, 'an EXPLICIT false on the PUT does move it');
    const on = await send('PUT', '/projects/projects/foundations/architecture.md',
      { text: '# Architecture\n\nAnd on again.\n', readFirst: true });
    eq(on.body.readFirst, true, '…and so does an explicit true');

    const bad = await send('PUT', '/projects/projects/foundations/architecture.md',
      { text: '# x\n', readFirst: 'yes' });
    eq(bad.status, 400, 'a non-boolean `readFirst` on the PUT is refused rather than coerced');
    eq(bad.body.reason, 'invalid_read_first', '…with its own reason');
    const still = readFileSync(
      join(DOMAINS, 'projects', 'state', 'foundations', 'architecture.md'), 'utf8');
    ok(/And on again/.test(still),
      '…and the refusal happened BEFORE the write, so the document is the last good one',
      still.slice(0, 60));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§6  The literals are exported, so nothing re-types them');
  // ═══════════════════════════════════════════════════════════════════════
  eq(routerMod.AS_PROJECT, 'project', 'AS_PROJECT is exported');
  eq(routerMod.AS_LIST, 'list', 'AS_LIST is exported');
  ok(typeof store.setFoundationReadFirst === 'function',
    'the store exports setFoundationReadFirst — the manifest-only setter this route calls');
} finally {
  await new Promise((r) => server.close(r));
  rmSync(TMP, { recursive: true, force: true });
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed === 0) console.log('✅ Express dispatch, the collision and the reading plan all hold');
process.exit(failed > 0 ? 1 : 0);
