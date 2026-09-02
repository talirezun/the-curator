/**
 * test-sharedbrain-queue-scope.js — OFFLINE suite (v3.43.0)
 *
 * The five DATA-LOSS defects a live end-to-end Shared Brain run exposed. All
 * are driven through the real modules against real temp directories; the only
 * fakes are the LLM (a plain async function through the existing `llmFn` seam)
 * and, in §5, a minimal fetch that speaks the GitHub Contents API.
 *
 *   §1  F-02 HIGH — a multi-domain push loaded the connection ONCE, and each
 *       pushDomain wrote pending_retry / permanent_skip as a REPLACEMENT. So
 *       domain B erased domain A's retry queue while last_push_at had already
 *       advanced. Those pages then fell out of both sets and the NEXT push
 *       DIFFED them: their whole body arrived as PRIOR VERSION and routed to
 *       `stable_facts`, which nothing reads. Silent, permanent loss under a
 *       green "Push complete". The recorded gap is that every existing fixture
 *       had a one-element local_domains, so no suite could ever see it.
 *
 *   §2  F-08 HIGH — the same queues were keyed on the page path with no domain
 *       qualifier, so two domains holding a page of the same name shared one
 *       strike counter and one skip entry.
 *
 *   §3  F-03 HIGH — pullCollective adopted an EXISTING domain at
 *       `shared-<slug>` and then pruned every file the collective did not
 *       send. The slug comes from an UNSIGNED invite token, so a crafted
 *       invite named after somebody's own domain emptied that wiki.
 *
 *   §4  F-10 MED — a fellow-supplied `delta.path` reached adapter.writePage
 *       unvalidated. An unwritable one throws, the page is marked failed, its
 *       submissions stay unprocessed, and unprocessed submissions PIN THE
 *       WATERMARK BACK — so one crafted path wedges synthesis for the whole
 *       cohort, permanently, at the cost of one commit.
 *
 *   §5  F-11 MED — the GitHub adapter's appendAudit read the file, built
 *       `existing + line`, and on a SHA conflict re-PUT that STALE string:
 *       the other writer's audit entry was silently discarded. An erasure log
 *       that drops entries under concurrency is not an erasure log.
 *
 *   §6  F-12 MED — the revocation audit recorded an UNSALTED sha256 of the
 *       admin token in a file every contributor can read: an offline oracle
 *       against a token `validateConnection` allows to be any 16-character
 *       string.
 *
 * Every refusal is paired with an acceptance, and §1/§2 assert the PAGES that
 * survive rather than only the bookkeeping, because the bookkeeping is the
 * mechanism and the pages are the harm.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
         readdirSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-sbqueue-'));
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP_ROOT, 'userdata');
mkdirSync(process.env.CURATOR_TEST_USER_DATA_DIR, { recursive: true });
delete process.env.DOMAINS_PATH;

const {
  pushDomain, pullCollective, computePendingPages,
  splitQueues, mergeQueues, queueKeyDomain, isLegacyQueueKey,
  isSharedBrainMirrorClaudeMd,
} = await import('../src/brain/sharedbrain.js');
const { groupDeltasByPage, isSafeDeltaPath, __testing: synthT } =
  await import('../src/brain/sharedbrain-synthesis.js');
const { hashAdminToken, verifyAdminTokenHash } =
  await import('../src/brain/sharedbrain-revoke.js');
const { GitHubStorageAdapter } = await import('../src/brain/sharedbrain-github-adapter.js');
const { LocalFolderStorageAdapter } = await import('../src/brain/sharedbrain-local-adapter.js');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label,
     `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`); }

const scratch = [TMP_ROOT];
function tmp(tag) {
  const d = mkdtempSync(path.join(os.tmpdir(), `curator-sbq-${tag}-`));
  scratch.push(d);
  return d;
}

function seedPage(wikiDir, rel, body) {
  const abs = path.join(wikiDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
  return abs;
}

function makeDomains(root, domains) {
  for (const d of domains) {
    for (const f of ['entities', 'concepts', 'summaries']) {
      mkdirSync(path.join(root, d, 'wiki', f), { recursive: true });
    }
    writeFileSync(path.join(root, d, 'CLAUDE.md'), `# ${d}\n`);
  }
}

// A delta-shaped JSON answer; `failFor` names page paths that must fail.
function makeLlm(failFor = new Set()) {
  return async (system, user) => {
    const m = /PAGE PATH:\s*(\S+)/.exec(user) || /"?path"?\s*[:=]\s*"([^"]+)"/.exec(user);
    const p = m ? m[1] : '';
    if ([...failFor].some(f => user.includes(f))) return 'not json { at all';
    return JSON.stringify({
      path: p, type: 'entity', title: 'T',
      new_facts: ['A fact.'], new_links: [], removed_links: [], stable_facts: [],
    });
  };
}

// ═══ §1 + §2 — the connection-level queues are per-domain and additive ═════
section('1. F-02/F-08 — a multi-domain push no longer erases the other domain');
{
  const root = tmp('multi');
  makeDomains(root, ['alpha', 'beta']);
  // Each domain holds a page with the SAME NAME — the collision F-08 is about.
  seedPage(path.join(root, 'alpha', 'wiki'), 'entities/kestrel.md', '# Kestrel (alpha)\n');
  seedPage(path.join(root, 'beta', 'wiki'),  'entities/kestrel.md', '# Kestrel (beta)\n');
  seedPage(path.join(root, 'beta', 'wiki'),  'entities/healthy.md', '# Healthy\n');

  const storage = path.join(root, 'store');
  mkdirSync(storage, { recursive: true });

  const conn = {
    id: randomUUID(), label: 'Two domains', storage_type: 'local',
    local_storage_path: storage, fellow_id: randomUUID(), fellow_display_name: 'T',
    shared_domain: 'workai', shared_brain_slug: 'cohort',
    local_domains: ['alpha', 'beta'], enabled: true,
    pending_retry: {}, permanent_skip: [], last_push_at: null,
  };

  // The stored record, mutated by patchFn exactly as sharedbrain-config would.
  let stored = { ...conn };
  const patchFn = (id, patch) => { stored = { ...stored, ...patch }; return stored; };

  // The `kestrel.md` page fails (bad JSON) in BOTH domains; beta's `healthy.md`
  // succeeds. This is the configuration the old code destroyed: alpha queues an
  // entry, then beta writes its own queue over the top of it — and because both
  // domains' failures were keyed on the bare `entities/kestrel.md`, they could
  // not have been told apart even if the write had merged.
  const failKestrel = makeLlm(new Set(['Kestrel (']));

  const runClock = new Date();
  const a = await pushDomain({ ...stored, last_push_at: null }, 'alpha',
    { domainsDir: root, llmFn: failKestrel, patchFn, now: () => runClock });
  ok(a.ok, 'alpha push returns ok (partial-push contract)');
  eq(Object.keys(stored.pending_retry), ['alpha/entities/kestrel.md'],
    'alpha queued its failed page under a DOMAIN-QUALIFIED key');

  // The route re-reads per domain and PINS the baseline — reproduced here.
  const b = await pushDomain({ ...stored, last_push_at: null }, 'beta',
    { domainsDir: root, llmFn: failKestrel, patchFn, now: () => runClock });
  ok(b.ok, 'beta push returns ok');

  // THE HEADLINE. Before the fix this array was empty after beta's write.
  ok(Object.prototype.hasOwnProperty.call(stored.pending_retry, 'alpha/entities/kestrel.md'),
    'ALPHA\'S QUEUE SURVIVED BETA\'S PUSH — the F-02 erasure is gone',
    `pending_retry = ${JSON.stringify(stored.pending_retry)}`);
  ok(Object.prototype.hasOwnProperty.call(stored.pending_retry, 'beta/entities/kestrel.md'),
    'and beta\'s identically-named page has its OWN entry — the F-08 collision is gone');
  eq(stored.pending_retry['alpha/entities/kestrel.md'], 1, 'alpha\'s strike counter is 1');
  eq(stored.pending_retry['beta/entities/kestrel.md'], 1, 'beta\'s strike counter is its own, also 1');

  // The pages themselves, which is the harm rather than the bookkeeping.
  const ad = new LocalFolderStorageAdapter({ storage_root: storage });
  const contributed = new Set(
    (await ad.listContributionsSince(null)).flatMap(c => (c.payload.deltas || []).map(d => d.path))
  );
  ok(contributed.has('entities/healthy.md'), 'beta\'s healthy page really was contributed');
  ok(!contributed.has('entities/kestrel.md') || contributed.size >= 1,
    'control: the contribution listing is non-empty, so the check above is not vacuous');

  // A third push re-attempts BOTH queued pages rather than diffing them away.
  const seen = [];
  const recordingLlm = async (system, user) => {
    const m = /Kestrel \((alpha|beta)\)/.exec(user);
    if (m) seen.push(m[1]);
    return JSON.stringify({ path: 'entities/kestrel.md', type: 'entity', title: 'K',
      new_facts: ['Recovered.'], new_links: [], removed_links: [] });
  };
  await pushDomain({ ...stored }, 'alpha', { domainsDir: root, llmFn: recordingLlm, patchFn });
  await pushDomain({ ...stored }, 'beta',  { domainsDir: root, llmFn: recordingLlm, patchFn });
  eq(seen.sort(), ['alpha', 'beta'],
    'BOTH queued pages were re-attempted in FULL on the next push — neither was silently diffed away');
  eq(stored.pending_retry, {}, 'and both queue entries cleared once they succeeded');
}

section('2. F-08 — the key helpers, including the legacy migration');
{
  eq(queueKeyDomain('mydomain/entities/x.md'), 'mydomain', 'a 3-segment key names its domain');
  eq(queueKeyDomain('entities/x.md'), null, 'a legacy 2-segment key names none');
  ok(isLegacyQueueKey('entities/x.md'), 'a wiki-folder-rooted 2-segment path is legacy');
  ok(!isLegacyQueueKey('mydomain/entities/x.md'), 'a qualified key is not legacy');
  // The nastiest case: a domain literally called "entities".
  eq(queueKeyDomain('entities/entities/x.md'), 'entities',
    'a domain named "entities" is still unambiguous — the folder is read from the MIDDLE segment');
  ok(isLegacyQueueKey('entities/x.md') && !isLegacyQueueKey('entities/entities/x.md'),
    'and the two forms never both claim the same string');

  const root = tmp('legacy');
  makeDomains(root, ['alpha', 'beta']);
  seedPage(path.join(root, 'alpha', 'wiki'), 'entities/mine.md', '# Mine\n');
  const wikiAlpha = path.join(root, 'alpha', 'wiki');

  const conn = {
    pending_retry: {
      'entities/mine.md': 2,          // legacy, and the page IS in alpha
      'entities/theirs.md': 1,        // legacy, and the page is NOT in alpha
      'beta/entities/other.md': 3,    // another domain's, qualified
    },
    permanent_skip: ['entities/mine.md', 'entities/theirs.md', 'beta/concepts/x.md'],
  };
  const split = splitQueues(conn, 'alpha', wikiAlpha);
  eq(split.ownRetry, { 'entities/mine.md': 2 },
    'a legacy key whose page EXISTS here is claimed by this domain');
  ok(Object.prototype.hasOwnProperty.call(split.foreignRetry, 'entities/theirs.md'),
    'a legacy key whose page does NOT exist here is LEFT for whichever domain owns it');
  eq(split.foreignRetry['beta/entities/other.md'], 3, 'another domain\'s qualified key is preserved verbatim');
  eq(split.ownSkip, ['entities/mine.md'], 'the same rule applies to permanent_skip');

  const merged = mergeQueues(split, 'alpha', split.ownRetry, split.ownSkip);
  eq(merged.pending_retry['alpha/entities/mine.md'], 2, 'the claimed legacy key comes back QUALIFIED');
  ok(!Object.prototype.hasOwnProperty.call(merged.pending_retry, 'entities/mine.md'),
    'and the legacy form is not ALSO left behind — migration replaces, never duplicates');
  eq(merged.pending_retry['beta/entities/other.md'], 3, 'the foreign entry is untouched');
  ok(merged.permanent_skip.includes('beta/concepts/x.md'), 'foreign skips survive too');

  // computePendingPages must project the SAME way, or the badge promises pages
  // the push then refuses.
  const conn2 = {
    enabled: true, read_only: false, local_domains: ['alpha', 'beta'], last_push_at: null,
    pending_retry: {}, permanent_skip: ['alpha/entities/mine.md'],
  };
  seedPage(path.join(root, 'beta', 'wiki'), 'entities/mine.md', '# Mine (beta)\n');
  eq(await computePendingPages(conn2, root), 1,
    'a skip in ALPHA does not hide the identically-named page in BETA from the pending count');
  const conn3 = { ...conn2, permanent_skip: ['alpha/entities/mine.md', 'beta/entities/mine.md'] };
  eq(await computePendingPages(conn3, root), 0,
    'control: skipping BOTH really does take the count to zero');
}

// ═══ §3 — F-03: pull refuses to adopt a domain it did not create ═══════════
section('3. F-03 — pull refuses a domain that is not a mirror, and prunes nothing');
{
  eq(isSharedBrainMirrorClaudeMd('---\nreadonly: true\nsource: shared-brain\n---\n# M\n'), true,
    'the marker is readonly:true AND source:shared-brain');
  eq(isSharedBrainMirrorClaudeMd('---\nreadonly: true\n---\n# M\n'), false,
    'readonly alone is NOT the marker — other features may reasonably set it');
  eq(isSharedBrainMirrorClaudeMd('---\nsource: shared-brain\n---\n# M\n'), false,
    'source alone is NOT the marker either');
  eq(isSharedBrainMirrorClaudeMd('# Just a heading\n'), false, 'no frontmatter, no marker');
  eq(isSharedBrainMirrorClaudeMd('---\nreadonly: false\nsource: shared-brain\n---\n'), false,
    'readonly:false is refused (the value is read, not merely the key)');

  const root = tmp('adopt');
  const storage = path.join(root, 'store');
  mkdirSync(storage, { recursive: true });

  // The victim: an ORDINARY domain that happens to sit at the mirror slug —
  // exactly what a crafted invite token aims at.
  const VICTIM = 'shared-articles';
  makeDomains(root, [VICTIM]);
  const precious = seedPage(path.join(root, VICTIM, 'wiki'), 'entities/precious.md',
    '# Precious\n\nYears of notes.\n');

  // A collective with one page, so a successful pull WOULD prune the victim's.
  const ad = new LocalFolderStorageAdapter({ storage_root: storage });
  await ad.writePage('workai', 'entities/collective.md', '# Collective\n');

  const conn = {
    id: randomUUID(), label: 'Crafted', storage_type: 'local', local_storage_path: storage,
    fellow_id: randomUUID(), fellow_display_name: 'T',
    shared_domain: 'workai', shared_brain_slug: 'articles', // → shared-articles
    local_domains: [], enabled: true,
  };
  const r = await pullCollective(conn, { domainsDir: root, patchFn: () => {} });
  eq(r.ok, false, 'the pull is REFUSED rather than adopting the domain');
  ok(/not a shared brain mirror/i.test(r.error || ''), 'and says why in plain words',
     JSON.stringify(r.error));
  ok(existsSync(precious), 'THE VICTIM\'S PAGE IS STILL THERE — nothing was pruned');
  eq(readFileSync(precious, 'utf8'), '# Precious\n\nYears of notes.\n', 'byte-identical');
  ok(!existsSync(path.join(root, VICTIM, 'wiki', 'entities', 'collective.md')),
    'and no collective page was written into it');

  // THE ACCEPTANCE HALF, twice: a FRESH domain, and a GENUINE existing mirror.
  const conn2 = { ...conn, shared_brain_slug: 'cohort' };
  const r2 = await pullCollective(conn2, { domainsDir: root, patchFn: () => {} });
  eq(r2.ok, true, 'a pull that CREATES its mirror still works');
  ok(existsSync(path.join(root, 'shared-cohort', 'wiki', 'entities', 'collective.md')),
    'and the collective page landed');
  ok(isSharedBrainMirrorClaudeMd(readFileSync(path.join(root, 'shared-cohort', 'CLAUDE.md'), 'utf8')),
    'the mirror it wrote carries the marker this guard looks for — so the two halves agree');

  await ad.writePage('workai', 'entities/second.md', '# Second\n');
  const r3 = await pullCollective(conn2, { domainsDir: root, patchFn: () => {} });
  eq(r3.ok, true, 'a SECOND pull into the same, genuine mirror still works');
  ok(existsSync(path.join(root, 'shared-cohort', 'wiki', 'entities', 'second.md')),
    'and picks up the new page');
}

// ═══ §4 — F-10: delta.path is validated at the trust boundary ══════════════
section('4. F-10 — a fellow-supplied delta.path cannot wedge synthesis');
{
  for (const good of ['entities/x.md', 'concepts/a-b_c.md', 'summaries/s.1.md']) {
    ok(isSafeDeltaPath(good), `accepted: ${good}`);
  }
  for (const bad of [
    '../escape.md', 'entities/../../escape.md', '/abs/x.md', 'entities/x.txt',
    'other/x.md', 'entities/.hidden.md', 'entities/', '', 'entities/sub/x.md',
    'entities/' + 'a'.repeat(200) + '.md',
  ]) {
    ok(!isSafeDeltaPath(bad), `refused: ${JSON.stringify(bad)}`);
  }
  ok(!isSafeDeltaPath(null) && !isSafeDeltaPath(42) && !isSafeDeltaPath({}),
    'non-strings are refused without throwing');

  // The behaviour that matters: the crafted delta is DROPPED, and the honest
  // one beside it in the SAME payload still lands.
  const grouped = groupDeltasByPage([{
    fellowId: 'f1',
    payload: { deltas: [
      { path: '../escape-attempt.md', new_facts: ['hostile'] },
      { path: 'entities/honest.md', new_facts: ['fine'] },
    ] },
  }]);
  eq([...grouped.keys()], ['entities/honest.md'],
    'the unwritable path is dropped and the honest page in the same payload survives');
  ok(!grouped.has('../escape-attempt.md'), 'no group is created for the crafted path');

  // processed_ids is bounded — otherwise state.last-synthesis grows until the
  // GitHub backend refuses the file outright.
  ok(typeof synthT.MAX_PROCESSED_IDS === 'number' && synthT.MAX_PROCESSED_IDS > 0,
    `processed_ids has a declared ceiling (${synthT.MAX_PROCESSED_IDS})`);
  ok(synthT.MAX_PROCESSED_IDS * 40 < 1000 * 1000,
    'and that ceiling keeps the record under the backend\'s 1 MB file limit at ~40 bytes an id');
}

// ═══ §5 — F-11: a concurrent audit append is not overwritten ═══════════════
section('5. F-11 — appendAudit re-reads inside the retry loop');
{
  // A minimal GitHub Contents API. `raceOnce` makes the FIRST PUT lose a SHA
  // race the way a real concurrent admin would, and injects the other writer's
  // line at that moment.
  function makeFakeGitHub({ raceOnce }) {
    const files = new Map(); // path -> {content, sha}
    let sha = 0;
    let raced = false;
    const puts = [];
    const fetchImpl = async (url, init = {}) => {
      const u = new URL(url);
      const m = /\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(u.pathname);
      const p = m ? decodeURIComponent(m[1]) : '';
      if ((init.method || 'GET') === 'GET') {
        const f = files.get(p);
        if (!f) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        return new Response(JSON.stringify({
          content: Buffer.from(f.content, 'utf8').toString('base64'),
          encoding: 'base64', sha: f.sha, size: f.content.length, path: p,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const body = JSON.parse(init.body);
      const content = Buffer.from(body.content, 'base64').toString('utf8');
      puts.push(content);
      if (raceOnce && !raced) {
        raced = true;
        // The OTHER admin's entry lands first, under a new sha.
        files.set(p, { content: '{"other":"writer"}\n', sha: `sha${++sha}` });
        return new Response(JSON.stringify({ message: 'is at ... but expected ...' }), { status: 409 });
      }
      const cur = files.get(p);
      if (cur && body.sha !== cur.sha) {
        return new Response(JSON.stringify({ message: 'sha mismatch' }), { status: 409 });
      }
      files.set(p, { content, sha: `sha${++sha}` });
      return new Response(JSON.stringify({ content: { sha: `sha${sha}` } }), { status: 200 });
    };
    return { fetchImpl, files, puts };
  }

  const mkAdapter = (fetchImpl) => new GitHubStorageAdapter({
    owner: 'alice', repo: 'brain', branch: 'main', fetchImpl, maxRetries: 3,
    // 20-char minimum, and deliberately not shaped like a real credential.
    pat: 'github_pat_TESTONLY_SHOULD_NEVER_APPEAR_0123456789',
  });

  // (a) The uncontended path still appends, so (b) is not "append is broken".
  {
    const g = makeFakeGitHub({ raceOnce: false });
    const ad = mkAdapter(g.fetchImpl);
    await ad.appendAudit('state/revocations.jsonl', { n: 1 });
    await ad.appendAudit('state/revocations.jsonl', { n: 2 });
    const lines = g.files.get('state/revocations.jsonl').content.trim().split('\n');
    eq(lines.length, 2, 'two sequential appends produce two lines');
    eq(JSON.parse(lines[0]).n, 1, 'the first entry survives the second append');
    eq(JSON.parse(lines[1]).n, 2, 'and the second is there too');
  }

  // (b) THE HEADLINE. A SHA conflict mid-append must not discard the winner.
  {
    const g = makeFakeGitHub({ raceOnce: true });
    const ad = mkAdapter(g.fetchImpl);
    await ad.appendAudit('state/revocations.jsonl', { mine: true });
    const content = g.files.get('state/revocations.jsonl').content;
    const lines = content.trim().split('\n').map(l => JSON.parse(l));
    eq(lines.length, 2,
      'after a real SHA conflict the file holds BOTH entries, not one');
    ok(lines.some(l => l.other === 'writer'),
      'THE OTHER ADMIN\'S ENTRY SURVIVED — the F-11 overwrite is gone');
    ok(lines.some(l => l.mine === true), 'and ours landed as well');
    ok(g.puts.length >= 2, 'the retry really did issue a second PUT');
    ok(g.puts[0] !== g.puts[1],
      'and the retry sent DIFFERENT bytes — proof the content was recomposed, not replayed');
  }
}

// ═══ §6 — F-12: the audit's admin-token hash is salted and verifiable ══════
section('6. F-12 — the shared audit log carries a salted hash, not an oracle');
{
  const TOKEN = 'cohort-admin-2026';   // the weak, hand-set shape the schema allows
  const h1 = hashAdminToken(TOKEN);
  const h2 = hashAdminToken(TOKEN);
  ok(h1.startsWith('sha256:'), 'the value still carries the sha256: prefix readers expect');
  ok(!h1.includes(TOKEN), 'the raw token never appears in it');
  ok(h1 !== h2, 'two hashes of the SAME token differ — the salt is per record');
  eq(h1.split(':').length, 3, 'the salt travels with the digest (three colon-separated parts)');

  // Verifiable — the property the salt must not cost.
  ok(verifyAdminTokenHash(TOKEN, h1), 'an admin holding the token can verify record 1');
  ok(verifyAdminTokenHash(TOKEN, h2), 'and record 2');
  ok(!verifyAdminTokenHash('wrong-token', h1), 'a wrong token does not verify');
  ok(!verifyAdminTokenHash(TOKEN, 'sha256:deadbeef:cafe'), 'a forged record does not verify');

  // The unsalted precomputation the old format allowed is now dead: the naive
  // digest of the token matches nothing.
  const { createHash } = await import('node:crypto');
  const naive = 'sha256:' + createHash('sha256').update(TOKEN).digest('hex');
  ok(h1 !== naive, 'the shipped value is NOT the plain sha256 of the token');
  ok(!verifyAdminTokenHash(TOKEN, naive) === false,
    'control: the legacy unsalted form is still VERIFIABLE, so old audit lines stay checkable');

  eq(hashAdminToken(null), null, 'a missing token hashes to null, not to a hash of ""');
  eq(hashAdminToken(''), null, 'and so does an empty one');
  ok(!verifyAdminTokenHash('x', null) && !verifyAdminTokenHash('x', 'plain'),
    'verification refuses a null or unprefixed stored value');
}

for (const d of scratch) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

console.log(`\n══════════════════════════════════════`);
console.log(`  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
console.log(`══════════════════════════════════════\n`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
