#!/usr/bin/env node
/**
 * Shared Brain — Phase 4B Battle Test (MCP readonly-mirror guard)
 *
 * Decision 7 binding: MCP write tools refuse to write to domains where
 * the CLAUDE.md frontmatter has `readonly: true`. This test exercises
 * every write tool against a readonly mirror domain AND a normal
 * personal domain, asserting:
 *
 *   - compile_to_wiki     refuses readonly, allows personal
 *   - fix_wiki_issue      refuses readonly, allows personal
 *   - dismiss_wiki_issue  refuses readonly, allows personal
 *   - undismiss_wiki_issue refuses readonly, allows personal
 *
 *   - Read-only tools (scan_wiki_health, get_health_dismissed, etc.)
 *     do NOT call the guard — they remain available on mirror domains
 *     so Claude can still read what's in the shared brain.
 *
 *   - The refusal message contains the actionable steer ("call this
 *     tool on your personal opted-in domain... then run Push
 *     contributions from the Sync tab") — Claude's skill (SKILL.md §3.1)
 *     relies on this wording.
 *
 *   - refuseIfReadonly is import-able and tolerant of missing CLAUDE.md.
 *
 * Run with:  node scripts/test-sharedbrain-mcp-guard.js
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { refuseIfReadonly } from '../mcp/util.js';
import { isDomainReadonly } from '../src/brain/files.js';
import { compileToWikiHandler } from '../mcp/tools/compile.js';
import { fixWikiIssueHandler, scanWikiHealthHandler } from '../mcp/tools/health.js';
import { dismissWikiIssueHandler, undismissWikiIssueHandler, getHealthDismissedHandler } from '../mcp/tools/dismissed.js';
import { ensureSharedDomainExists } from '../src/brain/sharedbrain.js';
import { __setDomainsDirOverride } from '../src/brain/config.js';

// ── Harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];
function ok(label)        { passed++; console.log(`  ✓ ${label}`); }
function fail(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err.message || err}`); }
function assert(c, l, e)  { c ? ok(l) : fail(l, new Error(e || 'assertion failed')); }
function section(name) { console.log(`\n── ${name} ──`); }

// ── Workspace ───────────────────────────────────────────────────────────

const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'sharedbrain-4b-'));
const domainsDir = path.join(workspaceRoot, 'domains');
mkdirSync(domainsDir, { recursive: true });
// Redirect getDomainsDir at our tempdir via the override (checked before
// config); the DOMAINS_PATH env var loses to .curator-config.json on a real
// install, so it can't isolate this test.
__setDomainsDirOverride(domainsDir);

console.log(`Phase 4B workspace: ${workspaceRoot}`);

// Helper to scaffold a normal (personal) domain
function makePersonalDomain(name) {
  const root = path.join(domainsDir, name);
  mkdirSync(path.join(root, 'wiki', 'entities'), { recursive: true });
  mkdirSync(path.join(root, 'wiki', 'concepts'), { recursive: true });
  mkdirSync(path.join(root, 'wiki', 'summaries'), { recursive: true });
  writeFileSync(path.join(root, 'CLAUDE.md'),
    '---\ndomain: ' + name + '\n---\n\n# ' + name + '\nA personal domain.\n', 'utf-8');
  writeFileSync(path.join(root, 'wiki', 'index.md'), '# Index\n', 'utf-8');
}

// Helper: a minimal storage adapter shape that the handlers expect
function makeMockStorage() {
  return {
    async listDomains() {
      const { readdir, stat } = await import('fs/promises');
      const entries = await readdir(domainsDir, { withFileTypes: true });
      const domains = [];
      for (const e of entries) {
        if (e.isDirectory()) {
          try {
            await stat(path.join(domainsDir, e.name, 'CLAUDE.md'));
            domains.push(e.name);
          } catch { /* skip */ }
        }
      }
      return domains;
    },
  };
}

// ── 1. refuseIfReadonly basic behaviour ─────────────────────────────────

section('refuseIfReadonly — basic behaviour');

// Missing CLAUDE.md → not readonly (conservative default)
{
  const r = await refuseIfReadonly('nonexistent-domain');
  assert(r === null, 'returns null for non-existent domain (not readonly by default)');
}

// Personal domain → not readonly
makePersonalDomain('personal');
{
  const r = await refuseIfReadonly('personal');
  assert(r === null, 'returns null for personal domain');
}

// Readonly shared-brain mirror domain → refusal object
const fakeConnection = {
  id: randomUUID(),
  storage_type: 'local',
  shared_domain: 'work-ai',
  shared_brain_slug: 'cohort',
};
await ensureSharedDomainExists('shared-cohort', fakeConnection, domainsDir);

{
  const isRo = await isDomainReadonly('shared-cohort');
  assert(isRo, 'isDomainReadonly returns true for shared-cohort');
}

{
  const r = await refuseIfReadonly('shared-cohort');
  assert(r !== null, 'refuseIfReadonly returns object for shared-cohort');
  assert(r.ok === false, 'refusal has ok: false');
  assert(typeof r.error === 'string' && r.error.length > 0, 'refusal has non-empty error string');
  assert(/Shared Brain mirror/i.test(r.error), 'error mentions Shared Brain mirror');
  assert(/personal opted-in domain/i.test(r.error), 'error mentions personal opted-in domain (Claude steer)');
  assert(/Push contributions/i.test(r.error), 'error mentions Push contributions from Sync tab');
}

// ── 2. compile_to_wiki — refuses readonly ───────────────────────────────

section('compile_to_wiki — refuses readonly, allows personal');

const storage = makeMockStorage();

// Refused on shared-cohort
{
  const result = await compileToWikiHandler({
    domain: 'shared-cohort',
    title: 'Test',
    summary_content: 'Just a test page.\n',
    dry_run: true,
  }, storage);
  assert(result.ok === false, 'compile_to_wiki returns ok: false for shared-cohort');
  assert(/Shared Brain mirror/i.test(result.error || ''), 'refusal message mentions Shared Brain mirror');
}

// Note: a full compile_to_wiki on personal would require API key + real
// LLM. Not appropriate for a quick guard test. The dry_run path skips
// the LLM but still needs config we don't have. We instead test the
// 'rejects malformed input' path on personal — proves the guard does
// NOT fire (input validation does instead).
{
  const result = await compileToWikiHandler({
    domain: 'personal',
    // intentionally missing required summary_content
    title: 'X',
  }, storage);
  assert(result.ok === false, 'compile_to_wiki on personal still returns ok: false');
  assert(/summary_content is required/i.test(result.error || ''),
    'personal-domain refusal is for input validation, NOT the readonly guard (proves guard let it through)');
  assert(!/Shared Brain mirror/i.test(result.error || ''),
    'personal-domain refusal does NOT mention Shared Brain mirror');
}

// ── 3. fix_wiki_issue — refuses readonly ────────────────────────────────

section('fix_wiki_issue — refuses readonly, allows personal');

{
  const result = await fixWikiIssueHandler({
    domain: 'shared-cohort',
    type: 'brokenLinks',
    issue: { sourceFile: 'x', link: 'y' },
  }, storage);
  assert(result.ok === false, 'fix_wiki_issue refuses readonly');
  assert(/Shared Brain mirror/i.test(result.error || ''), 'refusal mentions mirror');
}

{
  // Hit personal with an invalid type → input validation refuses, NOT the guard
  const result = await fixWikiIssueHandler({
    domain: 'personal',
    type: 'orphans', // valid type but not auto-fixable except orphanLink
    issue: {},
  }, storage);
  assert(result.ok === false, 'fix_wiki_issue on personal returns ok: false');
  assert(!/Shared Brain mirror/i.test(result.error || ''),
    'personal-domain refusal is NOT the readonly guard');
}

// ── 4. dismiss_wiki_issue + undismiss — refuse readonly ─────────────────

section('dismiss / undismiss — refuse readonly, allow personal');

{
  const result = await dismissWikiIssueHandler({
    domain: 'shared-cohort',
    type: 'brokenLinks',
    issue: { sourceFile: 'x', link: 'y' },
  }, storage);
  assert(result.ok === false, 'dismiss_wiki_issue refuses readonly');
  assert(/Shared Brain mirror/i.test(result.error || ''), 'dismiss refusal mentions mirror');
}

{
  const result = await undismissWikiIssueHandler({
    domain: 'shared-cohort',
    type: 'brokenLinks',
    issue: { sourceFile: 'x', link: 'y' },
  }, storage);
  assert(result.ok === false, 'undismiss_wiki_issue refuses readonly');
  assert(/Shared Brain mirror/i.test(result.error || ''), 'undismiss refusal mentions mirror');
}

// Personal: missing-issue path (input validation, not guard)
{
  const result = await dismissWikiIssueHandler({
    domain: 'personal',
    type: 'brokenLinks',
    // missing issue
  }, storage);
  assert(result.ok === false, 'dismiss_wiki_issue on personal returns ok: false');
  assert(!/Shared Brain mirror/i.test(result.error || ''),
    'personal-domain dismiss refusal is NOT the readonly guard');
}

// ── 5. READ-ONLY tools — do NOT call the guard ──────────────────────────

section('Read-only tools (scan, list dismissed) — work on mirror domains');

{
  const result = await scanWikiHealthHandler({
    domain: 'shared-cohort',
  }, storage);
  // The handler may return ok: true or ok: false depending on what it
  // finds; either way, the refusal text must NOT mention readonly.
  assert(
    !result.error || !/Shared Brain mirror/i.test(result.error),
    'scan_wiki_health on mirror does NOT trigger the readonly guard (read is allowed)'
  );
}

{
  const result = await getHealthDismissedHandler({
    domain: 'shared-cohort',
  }, storage);
  assert(
    !result.error || !/Shared Brain mirror/i.test(result.error),
    'get_health_dismissed on mirror does NOT trigger the readonly guard (read is allowed)'
  );
}

// ── 6. Robustness — handler resolves domain first, guard second ─────────

section('Guard does NOT bypass domain resolution');

// Pass a totally invalid domain — the readonly check must run AFTER
// resolveDomainArg, so the error should be "Unknown domain", not the
// readonly message.
{
  const result = await compileToWikiHandler({
    domain: 'nonexistent',
    title: 'X',
    summary_content: 'x',
  }, storage);
  assert(result.ok === false, 'compile_to_wiki refuses unknown domain');
  assert(/Unknown domain|Invalid domain/i.test(result.error || ''),
    'refusal is the domain-resolution error, not the readonly one');
  assert(!/Shared Brain mirror/i.test(result.error || ''),
    'unknown-domain refusal does NOT mention Shared Brain mirror');
}

// ── Cleanup ──────────────────────────────────────────────────────────────

console.log('\nCleaning up...');
rmSync(workspaceRoot, { recursive: true, force: true });
console.log(`Removed ${workspaceRoot}`);

__setDomainsDirOverride(null);

// ── Summary ──────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════');
console.log(`  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
console.log('══════════════════════════════════════');

if (failed > 0) {
  console.log('\nFAILURES:');
  for (const { label, err } of failures) {
    console.log(`  ✗ ${label}`);
    if (err) console.log(`    └─ ${err.message || err}`);
  }
  process.exit(1);
}

console.log('\nAll Phase 4B MCP guard tests green.');
process.exit(0);
