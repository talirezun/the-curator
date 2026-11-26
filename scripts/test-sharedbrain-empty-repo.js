#!/usr/bin/env node
/**
 * v4.1.2 E2E finding D2. The first day of a Shared Brain: the admin created
 * the repository, a member joined and pressed Pull before anyone pushed.
 * GitHub answers the tree read of a repository with no commit with
 * `409 {"message":"Git Repository is empty."}`, and the screen showed
 * "pullCollective: listPages failed: GitHub GET tree:main → 409: Git
 * Repository is empty." Now that one answer is an empty tree, so the Pull
 * says there is nothing to pull yet; any OTHER 409 on that read still fails
 * (a read that failed must never pass for "nothing there").
 *
 * Driven through the real pullCollective and GitHub adapter against a fake
 * GitHub on 127.0.0.1 (the loopback-only CURATOR_TEST_GITHUB_API seam).
 * Isolation: CURATOR_TEST_USER_DATA_DIR, CURATOR_TEST_DOMAINS_DIR, a fake HOME
 * and CURATOR_NO_OPEN before any app module loads. No network, no LLM.
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-sbempty-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
const TMP_HOME = path.join(TMP, 'home');
for (const d of [TMP_USER, TMP_DOMAINS, TMP_HOME]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
process.env.HOME = TMP_HOME;
process.env.CURATOR_NO_OPEN = '1';
delete process.env.DOMAINS_PATH;

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

const PAT = 'github_pat_' + 'E'.repeat(30);
const seen = [];
const fake = http.createServer((req, res) => {
  seen.push(`${req.method} ${req.url}`);
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const m = /^\/repos\/acme\/([^/]+)\/(git\/trees|contents)\//.exec(req.url);
  if (!m) return json(404, { message: 'Not Found' });
  const [, repo, kind] = m;
  if (kind === 'contents') return json(404, { message: 'This repository is empty.' });
  if (repo === 'empty') return json(409, { message: 'Git Repository is empty.' });
  if (repo === 'conflict') return json(409, { message: 'Conflict' });
  if (repo === 'nobody') return json(409, {});
  return json(500, { message: 'unexpected' });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.CURATOR_TEST_GITHUB_API = `http://127.0.0.1:${fake.address().port}`;

const { pullCollective } = await import('../src/brain/sharedbrain.js');

const conn = (repo) => ({
  id: randomUUID(), label: 'Day one', storage_type: 'github',
  github_repo_owner: 'acme', github_repo_name: repo, github_pat: PAT, github_branch: 'main',
  fellow_id: randomUUID(), fellow_display_name: 'Member', shared_domain: 'work-ai',
  shared_brain_slug: `cohort-${repo}`, local_domains: ['work-ai'],
  last_push_at: null, last_pull_at: null, pending_retry: {}, permanent_skip: [], enabled: true,
});
const patches = [];
const patchFn = (id, patch) => { patches.push({ id, patch }); return patch; };

console.log('\n1. D2 — Pull on an empty repository is "nothing to pull yet"\n');
{
  const c = conn('empty');
  const progress = [];
  const r = await pullCollective(c, { domainsDir: TMP_DOMAINS, patchFn, onProgress: (k, m) => progress.push(`${k}: ${m}`) });
  ok(r.ok === true, 'the Pull succeeds', r);
  ok(r.created === 0 && r.updated === 0, 'and pulls nothing');
  ok(!JSON.stringify(r).includes('409') && !JSON.stringify(r).includes('listPages failed'), 'no raw GitHub error reaches the answer', r);
  ok(progress.some((p) => /nothing to pull/i.test(p)), 'the progress says there is nothing to pull', progress);
  ok(patches.some((p) => p.id === c.id && typeof p.patch.last_pull_at === 'string'), 'the pull is recorded as done');
  ok(seen.some((s) => s.includes('/repos/acme/empty/git/trees/main')), 'the fake GitHub was asked for the tree (the seam is live)');
  ok(existsSync(path.join(TMP_DOMAINS, `shared-${c.shared_brain_slug}`)), 'the mirror domain exists, empty, ready for the first synthesis');
  ok(!JSON.stringify(progress).includes(PAT) && !JSON.stringify(r).includes(PAT), 'the token is in no message');
}

console.log('\n2. Any other 409 on the tree read is still an error\n');
for (const repo of ['conflict', 'nobody']) {
  const r = await pullCollective(conn(repo), { domainsDir: TMP_DOMAINS, patchFn });
  ok(r.ok === false && /409/.test(r.error || ''), `a 409 that does not say the repository is empty (${repo}): the Pull fails`, r);
  ok(!(r.error || '').includes(PAT), 'and the error carries no token');
}
ok(readdirSync(TMP_DOMAINS).every((d) => d.startsWith('shared-cohort-')), 'nothing but the mirror folders was written');

await new Promise((r) => fake.close(r));
delete process.env.CURATOR_TEST_GITHUB_API;
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:\n' + failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
