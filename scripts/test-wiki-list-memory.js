#!/usr/bin/env node
/**
 * test-wiki-list-memory.js — OFFLINE suite. No network, no API key, no LLM.
 *
 * GET /api/wiki/:domain/list?include=memory — the v3.50.0 addition that makes
 * a domain's MEMORY pages browsable from the same list as its wiki pages.
 *
 * ── WHY THE FLAG, AND WHY A SEPARATE ARRAY ───────────────────────────────
 * A domain's `state/` tree is markdown too: each project's standing brief and
 * each work-stream's `current.md`. The maintainer's report was that those are
 * documents he should be able to browse, and until now the only route to any
 * of them was the Agent memory screen, which is organised around resuming
 * work rather than around reading.
 *
 * They are a SEPARATE array from `entries`, never folded into it, because the
 * stat card above the browse list says PAGES and means wiki pages — a facet
 * called "All" that disagreed with the number directly above it is the
 * self-contradicting-figures defect this card was already fixed for once.
 *
 * The flag is OPT-IN because the two halves cost differently: the wiki half is
 * one readdir per canonical folder, while the memory half walks the project
 * list and reads one journal tail per (scope, machine) pair. §1 proves a
 * flagless response is UNCHANGED, field for field, so nothing that does not
 * want memory pays for it.
 *
 * ── THE ASSERTION THE VIEW'S COMMENT RESTS ON ────────────────────────────
 * §6 drives the REAL `GET /:domain/page` against a real `state/` path and
 * proves it REFUSES. views/domains.js routes a memory click to the memory
 * route on the strength of that claim, and a claim about another module's
 * behaviour has to be measured, not asserted in a comment — this repo has a
 * recorded history of comments that were true when written and false a release
 * later.
 *
 * Isolated via CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR, set
 * BEFORE any app module is imported (never process.env.DOMAINS_PATH — that var
 * loses to a configured domainsPath and would silently no-op on a real
 * install).
 *
 * Run with:  node scripts/test-wiki-list-memory.js
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// ── Isolation FIRST ─────────────────────────────────────────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-wikimem-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
for (const d of [TMP_USER, TMP_DOMAINS]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.DOMAINS_PATH;

const { default: wikiRouter } = await import('../src/routes/wiki.js');
const { default: express } = await import('express');

let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function bad(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err}`); }
function assert(cond, label, err) { cond ? ok(label) : bad(label, err || 'assertion failed'); }
function eq(label, actual, expected) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), label,
    `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function section(name) { console.log(`\n── ${name} ──`); }

// ── Fixture ─────────────────────────────────────────────────────────────
// A domain with a wiki AND a state tree in BOTH layouts: the domain's own
// project at the state ROOT (permanently, per the store's contract — never
// `state/<domain>/`), and a named project one level down.
function seed(domain, { withState = true } = {}) {
  const D = path.join(TMP_DOMAINS, domain);
  mkdirSync(path.join(D, 'wiki/entities'), { recursive: true });
  mkdirSync(path.join(D, 'wiki/concepts'), { recursive: true });
  mkdirSync(path.join(D, 'wiki/summaries'), { recursive: true });
  writeFileSync(path.join(D, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(D, 'wiki/entities/foo.md'), '# Foo\n');
  writeFileSync(path.join(D, 'wiki/concepts/bar.md'), '# Bar\n');
  if (!withState) return D;

  // The domain's OWN project: brief at the state root, one work-stream on two
  // machines (the `<machine>` segment is load-bearing in the store, so two
  // machines under one scope must produce TWO rows).
  mkdirSync(path.join(D, 'state'), { recursive: true });
  writeFileSync(path.join(D, 'state/project.md'), '# ' + domain + ' brief\n');
  for (const m of ['mac-aaaa1111', 'mac-bbbb2222']) {
    mkdirSync(path.join(D, `state/main/${m}`), { recursive: true });
    writeFileSync(path.join(D, `state/main/${m}/current.md`), '# handoff on ' + m + '\n');
    writeFileSync(path.join(D, `state/main/${m}/journal.jsonl`),
      JSON.stringify({ at: '2026-09-01T10:00:00.000Z', headline: 'SECRET-HEADLINE',
                       harness: 'SECRET-HARNESS', model: 'SECRET-MODEL' }) + '\n');
  }
  // A NAMED project, one level deeper.
  mkdirSync(path.join(D, 'state/lumina/design/mac-aaaa1111'), { recursive: true });
  writeFileSync(path.join(D, 'state/lumina/project.md'), '# lumina brief\n');
  writeFileSync(path.join(D, 'state/lumina/design/mac-aaaa1111/current.md'), '# lumina handoff\n');
  // A project with a brief and NO saves — it must still appear (a brief IS a
  // memory page), and it must contribute no handoff row.
  mkdirSync(path.join(D, 'state/quiet'), { recursive: true });
  writeFileSync(path.join(D, 'state/quiet/project.md'), '# quiet brief\n');
  return D;
}
seed('acme');
seed('bare', { withState: false });

const app = express();
app.use('/api/wiki', wikiRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;
const get = async (p) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
  return { status: res.status, body: await res.json() };
};

try {
  // ═══════════════════════════════════════════════════════════════════════
  section('1. WITHOUT the flag, the response is what it always was');
  // ═══════════════════════════════════════════════════════════════════════
  const plain = await get('/api/wiki/acme/list');
  assert(plain.status === 200, 'a flagless list still answers 200');
  eq('...with exactly the shipped field set and no memory keys',
    Object.keys(plain.body).sort(), ['count', 'domain', 'entries', 'total', 'truncated']);
  eq('...and the wiki inventory itself is untouched',
    plain.body.entries.map((e) => e.path), ['concepts/bar.md', 'entities/foo.md']);
  // ANTI-VACUITY: the domain really does have memory pages to have omitted.
  const flagged = await get('/api/wiki/acme/list?include=memory');
  assert(Array.isArray(flagged.body.memory) && flagged.body.memory.length > 0,
    '...and this domain DOES have memory pages, so the omission above is a finding');
  // A VALUE THAT IS NOT `memory` IS NOT A BACK DOOR.
  const other = await get('/api/wiki/acme/list?include=raw');
  assert(other.body.memory === undefined, 'an unrecognised include value adds nothing');
  const csv = await get('/api/wiki/acme/list?include=raw,memory');
  assert(Array.isArray(csv.body.memory), '...and a comma-separated list containing `memory` does');

  // ═══════════════════════════════════════════════════════════════════════
  section('2. WITH the flag: every brief and every (scope, machine) handoff');
  // ═══════════════════════════════════════════════════════════════════════
  const mem = flagged.body.memory;
  eq('the memory pages are exactly the files on disk, by path',
    mem.map((e) => e.path).sort(),
    [
      'state/lumina/design/mac-aaaa1111/current.md',
      'state/lumina/project.md',
      'state/main/mac-aaaa1111/current.md',
      'state/main/mac-bbbb2222/current.md',
      'state/project.md',
      'state/quiet/project.md',
    ]);
  assert(mem.every((e, i) => i === 0 || mem[i - 1].path.localeCompare(e.path) <= 0),
    '...and they arrive sorted by path, so the list is stable between calls');
  const byPath = Object.fromEntries(mem.map((e) => [e.path, e]));

  // THE DOMAIN'S OWN PROJECT LIVES AT THE STATE ROOT, PERMANENTLY. `state/`
  // syncs and a fleet never upgrades at once, so it is never `state/<domain>/`.
  eq('the domain’s own brief is at the state ROOT, never under state/<domain>/',
    byPath['state/project.md'].project, 'acme');
  assert(byPath['state/project.md'].isDefaultProject === true,
    '...and is marked as the domain’s own project');
  assert(mem.every((e) => !e.path.startsWith('state/acme/')),
    '...and nothing is filed under state/<domain>/ (anti-vacuity for the rule above)');

  eq('a brief’s title names the project and what it is',
    byPath['state/lumina/project.md'].title, 'lumina · Standing brief');
  eq('a handoff’s title names project, work-stream and machine',
    byPath['state/main/mac-bbbb2222/current.md'].title, 'acme · main · mac-bbbb2222');
  eq('...and the named project’s handoff too',
    byPath['state/lumina/design/mac-aaaa1111/current.md'].title, 'lumina · design · mac-aaaa1111');

  // ONE ROW PER (scope, machine). Collapsing two machines under one scope
  // would hide a file that is on disk.
  const mainRows = mem.filter((e) => e.kind === 'handoff' && e.scope === 'main');
  eq('two machines under one work-stream produce TWO rows, not one', mainRows.length, 2);
  eq('...and they are distinguished by machine',
    mainRows.map((e) => e.machine).sort(), ['mac-aaaa1111', 'mac-bbbb2222']);

  // A BRIEF WITH NO SAVES IS STILL A MEMORY PAGE.
  assert(!!byPath['state/quiet/project.md'], 'a project with a brief and no saves still lists its brief');
  assert(!mem.some((e) => e.project === 'quiet' && e.kind === 'handoff'),
    '...and contributes no handoff row it does not have');

  eq('the counts describe the memory half', flagged.body.memoryCount, mem.length);
  eq('...and the real total sits beside it', flagged.body.memoryTotal, mem.length);
  eq('...with truncation stated rather than implied', flagged.body.memoryTruncated, false);
  eq('the WIKI count is unchanged by the flag', flagged.body.count, plain.body.count);
  eq('...and so is the wiki total', flagged.body.total, plain.body.total);

  // ═══════════════════════════════════════════════════════════════════════
  section('3. THE WIRE SHAPE IS AN ALLOW-LIST, and carries no file bodies');
  // ═══════════════════════════════════════════════════════════════════════
  const ALLOWED = ['kind', 'project', 'isDefaultProject', 'scope', 'machine', 'path', 'title', 'savedAt', 'bytes'];
  const stray = new Set();
  for (const e of mem) for (const k of Object.keys(e)) if (!ALLOWED.includes(k)) stray.add(k);
  eq('no field beyond the nine named ones reaches the wire', [...stray].sort(), []);
  // ANTI-VACUITY: the store's rows really do carry the fields that must not
  // leak — the journal facts the seed planted are readable from that store.
  const wire = JSON.stringify(flagged.body);
  for (const secret of ['SECRET-HEADLINE', 'SECRET-HARNESS', 'SECRET-MODEL']) {
    assert(!wire.includes(secret), `the journal's ${secret.split('-')[1].toLowerCase()} never reaches this listing`);
  }
  const { listWorkingScopes } = await import('../src/brain/working-state.js');
  const scoped = await listWorkingScopes('acme');
  assert(scoped.ok && scoped.scopes.some((p) => p.headline === 'SECRET-HEADLINE'),
    '...and the store DOES compute them, so the four assertions above are findings and not blindness');
  for (const body of ['acme brief', 'lumina handoff', 'handoff on mac-']) {
    assert(!wire.includes(body), `no file body reaches the listing (${body})`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('4. A DOMAIN WITH NO STATE TREE IS NOT AN ERROR');
  // ═══════════════════════════════════════════════════════════════════════
  const bare = await get('/api/wiki/bare/list?include=memory');
  assert(bare.status === 200, 'a domain with no state/ folder answers 200');
  eq('...with an empty memory array rather than an omitted field', bare.body.memory, []);
  eq('...and an honest zero', bare.body.memoryCount, 0);
  assert(bare.body.entries.length === 2, '...while its wiki pages are listed as usual');

  // ═══════════════════════════════════════════════════════════════════════
  section('5. THE DOMAIN GATE STILL COMES FIRST');
  // ═══════════════════════════════════════════════════════════════════════
  const unknown = await get('/api/wiki/nosuch/list?include=memory');
  assert(unknown.status === 404, 'an unknown domain is refused with 404, flag or no flag');
  assert(unknown.body.memory === undefined, '...and nothing about memory is answered for it');
  const traversal = await get('/api/wiki/' + encodeURIComponent('../escape') + '/list?include=memory');
  assert(traversal.status === 404, 'a traversal-shaped domain name is refused too');

  // ═══════════════════════════════════════════════════════════════════════
  section('6. THE CLAIM THE VIEW ROUTES ON: /page CANNOT OPEN A state/ PATH');
  // ═══════════════════════════════════════════════════════════════════════
  // views/domains.js sends a memory click to GET /api/memory/:domain/:project
  // rather than to the reader's usual route, on the strength of this. It is
  // measured here rather than asserted in a comment.
  for (const p of ['state/project.md', 'state/lumina/project.md', 'state/main/mac-aaaa1111/current.md']) {
    const r = await get('/api/wiki/acme/page?path=' + encodeURIComponent(p));
    assert(r.status >= 400, `GET /:domain/page refuses "${p}" (${r.status})`);
    assert(!JSON.stringify(r.body).includes('brief'),
      `...and leaks none of its content for "${p}"`);
  }
  // ANTI-VACUITY: the same route DOES open a real wiki page, so the refusals
  // above are about `state/` and not about the route being broken.
  const wikiPage = await get('/api/wiki/acme/page?path=' + encodeURIComponent('entities/foo.md'));
  assert(wikiPage.status === 200 && /Foo/.test(wikiPage.body.body || ''),
    '...while a real wiki page opens normally (so the refusals are findings)');

} finally {
  server.close();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  ✗ ${f.label}\n    └─ ${f.err}`);
  process.exit(1);
}
console.log('\nAll wiki-list memory assertions green.');
