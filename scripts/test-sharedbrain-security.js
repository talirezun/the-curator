#!/usr/bin/env node
/**
 * Shared Brain — Phase 2D Battle Test (security boundaries)
 *
 * Rounds out the security surface beyond what Phases 2A and 2C cover.
 *
 * Scenarios:
 *   1. isDomainReadonly() — accurately detects the readonly:true frontmatter
 *      that ensureSharedDomainExists writes, and returns false for personal
 *      domains, missing CLAUDE.md, malformed YAML, edge cases.
 *
 *   2. Symlink defense — pull refuses to write through a pre-existing symlink
 *      at the target path. Verifies that a malicious symlink planted in a
 *      shared-X/ mirror cannot redirect synthesis output to a legitimate
 *      user file.
 *
 *   3. Edge-case malicious paths — null bytes, control characters, mixed
 *      forward/backward slashes, encoded ".." patterns, very long paths.
 *
 *   4. Token-leak audit — push and pull cycles don't leak credential-shaped
 *      strings into console.error output or thrown error messages.
 *
 * Run with:  node scripts/test-sharedbrain-security.js
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { LocalFolderStorageAdapter } from '../src/brain/sharedbrain-local-adapter.js';
import { pullCollective, ensureSharedDomainExists } from '../src/brain/sharedbrain.js';
import { pushDomain } from '../src/brain/sharedbrain.js';
import { isDomainReadonly } from '../src/brain/files.js';
import { __setDomainsDirOverride } from '../src/brain/config.js';

// ── Harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];
function ok(label)        { passed++; console.log(`  ✓ ${label}`); }
function fail(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err.message || err}`); }
function assert(c, l, e)  { c ? ok(l) : fail(l, new Error(e || 'assertion failed')); }
function assertEq(a, e, l) {
  const sa = JSON.stringify(a);
  const se = JSON.stringify(e);
  sa === se ? ok(l) : fail(l, new Error(`expected ${se}, got ${sa}`));
}
function section(name) { console.log(`\n── ${name} ──`); }

// ── Setup ────────────────────────────────────────────────────────────────

const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'sharedbrain-2d-'));
const storageRoot = path.join(workspaceRoot, 'shared-storage');
mkdirSync(storageRoot, { recursive: true });
const domainsDir = path.join(workspaceRoot, 'domains');
mkdirSync(domainsDir, { recursive: true });

// Point every getDomainsDir() consumer (isDomainReadonly, pullCollective's
// internal appendLog, etc.) at our throwaway workspace. The DOMAINS_PATH env
// var can't do this on a real install where .curator-config.json sets
// domainsPath (config wins over env). Cleared at cleanup.
__setDomainsDirOverride(domainsDir);

console.log(`Phase 2D workspace: ${workspaceRoot}`);

function makeConnection(opts = {}) {
  return {
    id: randomUUID(),
    label: 'Test Cohort',
    storage_type: 'local',
    local_storage_path: storageRoot,
    fellow_id: randomUUID(),
    fellow_display_name: 'Tester',
    shared_domain: 'work-ai',
    shared_brain_slug: 'test-cohort',
    local_domains: ['personal'],
    last_push_at: null,
    last_pull_at: null,
    pending_retry: {},
    permanent_skip: [],
    enabled: true,
    ...opts,
  };
}

const connections = {};
const patchFn = (id, patch) => {
  if (!connections[id]) return null;
  connections[id] = { ...connections[id], ...patch };
  return connections[id];
};

// ── 1. isDomainReadonly() ────────────────────────────────────────────────

section('isDomainReadonly — accurate detection');

// The global __setDomainsDirOverride above already points getDomainsDir at our
// workspace, so isDomainReadonly resolves into the tempdir we populate below.
async function readonlyCheck(domain) {
  return await isDomainReadonly(domain);
}

// Set up a few test domains with various CLAUDE.md shapes
function makeDomainWithClaude(slug, claudeContent) {
  const dir = path.join(domainsDir, slug);
  mkdirSync(path.join(dir, 'wiki', 'entities'), { recursive: true });
  mkdirSync(path.join(dir, 'wiki', 'concepts'), { recursive: true });
  mkdirSync(path.join(dir, 'wiki', 'summaries'), { recursive: true });
  writeFileSync(path.join(dir, 'CLAUDE.md'), claudeContent, 'utf-8');
  writeFileSync(path.join(dir, 'wiki', 'index.md'), '# Index\n', 'utf-8');
  writeFileSync(path.join(dir, 'wiki', 'log.md'), '# Log\n', 'utf-8');
}

// Genuine shared brain mirror (matches what ensureSharedDomainExists writes)
makeDomainWithClaude('shared-foo',
  `---\nreadonly: true\nsource: shared-brain\nshared_brain_slug: foo\n---\n\n# Shared Brain Mirror: Foo\n\nMirror body...\n`
);
assert(await readonlyCheck('shared-foo'), 'detects readonly:true in frontmatter');

// Personal domain (no readonly flag)
makeDomainWithClaude('personal',
  `# Domain: Personal\n\nNo frontmatter at all.\n`
);
assert(!(await readonlyCheck('personal')), 'personal domain (no frontmatter) → false');

// Frontmatter present but no readonly key
makeDomainWithClaude('other',
  `---\nname: Other\ntags: foo\n---\n\n# Other\n`
);
assert(!(await readonlyCheck('other')), 'frontmatter without readonly key → false');

// readonly: false should NOT be readonly
makeDomainWithClaude('writable',
  `---\nreadonly: false\n---\n\n# Writable\n`
);
assert(!(await readonlyCheck('writable')), 'readonly: false → not readonly');

// Tolerant of indentation and quotes
makeDomainWithClaude('shared-quoted',
  `---\n   readonly:   "true"\n---\n\n# Quoted\n`
);
assert(await readonlyCheck('shared-quoted'), 'tolerant of indentation + quoted "true"');

makeDomainWithClaude('shared-single',
  `---\nreadonly: 'true'\n---\n\n# Single quotes\n`
);
assert(await readonlyCheck('shared-single'), 'tolerant of single-quoted true');

// Conservative: reject non-strictly-true values
makeDomainWithClaude('shared-yes',
  `---\nreadonly: yes\n---\n\n# Yes\n`
);
assert(!(await readonlyCheck('shared-yes')), 'rejects "readonly: yes" (must be literal true)');

makeDomainWithClaude('shared-1',
  `---\nreadonly: 1\n---\n\n# 1\n`
);
assert(!(await readonlyCheck('shared-1')), 'rejects "readonly: 1" (must be literal true)');

// Case-insensitive on the value
makeDomainWithClaude('shared-True',
  `---\nreadonly: True\n---\n\n# True\n`
);
assert(await readonlyCheck('shared-True'), 'accepts "readonly: True" (case-insensitive)');

// CRLF line endings (Windows)
makeDomainWithClaude('shared-crlf',
  `---\r\nreadonly: true\r\n---\r\n\r\n# CRLF\r\n`
);
assert(await readonlyCheck('shared-crlf'), 'tolerates CRLF line endings');

// Missing CLAUDE.md — domain not found, should not crash
assert(!(await readonlyCheck('nonexistent-domain')), 'missing CLAUDE.md → false (no crash)');

// Empty / whitespace / nullish input
assert(!(await readonlyCheck('')), 'empty domain string → false');
assert(!(await readonlyCheck(null)), 'null input → false');
assert(!(await readonlyCheck(undefined)), 'undefined input → false');

// Malformed frontmatter — opening ---  but no closing
makeDomainWithClaude('malformed',
  `---\nreadonly: true\n\n# No closing fence\n`
);
assert(!(await readonlyCheck('malformed')), 'unclosed frontmatter → false (conservative default)');

// ── 2. Symlink defense in pullCollective ────────────────────────────────

section('Symlink defense — pullCollective refuses to write through symlinks');

// Stage some content in collective storage
const adapter = new LocalFolderStorageAdapter({ storage_root: storageRoot });
await adapter.writePage('work-ai', 'entities/target.md', '# Real Target Content\n');

// First pull — creates the mirror domain with a real file
const conn1 = makeConnection({ shared_brain_slug: 'symlink-test' });
connections[conn1.id] = conn1;
const pull1 = await pullCollective(conn1, { domainsDir, patchFn });
assert(pull1.ok, 'initial pull succeeded');

const mirrorWikiDir = path.join(domainsDir, 'shared-symlink-test', 'wiki');
const targetPath = path.join(mirrorWikiDir, 'entities', 'target.md');
assert(existsSync(targetPath), 'pulled target.md exists');

// Plant a "victim" file we don't want overwritten — simulating a legitimate
// personal domain entity that an attacker would try to corrupt.
const victimPath = path.join(workspaceRoot, 'victim.md');
const ORIGINAL_VICTIM = '# UNTOUCHED VICTIM\n';
writeFileSync(victimPath, ORIGINAL_VICTIM, 'utf-8');

// Replace the legitimate mirror page with a symlink pointing at the victim.
// This simulates an attacker with filesystem access planting a redirect
// before the user runs the next pull.
rmSync(targetPath);
symlinkSync(victimPath, targetPath);

assert(lstatSync(targetPath).isSymbolicLink(), 'pre-pull: target is a symlink to victim');

// Stage NEW collective content for this path
await adapter.writePage('work-ai', 'entities/target.md', '# OVERWRITTEN BY SYNTHESIS\n');

// Pull again — the defense should refuse to write through the symlink
const pull2 = await pullCollective(connections[conn1.id], { domainsDir, patchFn });
assert(pull2.ok, 'second pull still returns ok (skipped the symlink)');
assert(pull2.skipped >= 1, `at least 1 page skipped (got skipped=${pull2.skipped})`);

// CRITICAL: the victim file MUST be unchanged
const victimAfter = readFileSync(victimPath, 'utf-8');
assertEq(victimAfter, ORIGINAL_VICTIM, 'victim file was NOT overwritten — symlink defense held');

// And the symlink itself is still in place (we didn't quietly replace it)
assert(lstatSync(targetPath).isSymbolicLink(), 'post-pull: symlink still present (not silently replaced)');

// ── 3. Edge-case malicious paths ─────────────────────────────────────────

section('Edge-case malicious paths — resolveInsideBase rejection');

const { __testing } = await import('../src/brain/sharedbrain.js');
const { resolveInsideBase } = __testing;

// Null byte injection — POSIX rejects but JavaScript strings can carry these
assert(resolveInsideBase('/base', 'foo .md') === null || (() => {
  // Some Node versions normalise the null byte away — if path.resolve doesn't
  // crash and returns something inside /base, that's still safe.
  const r = resolveInsideBase('/base', 'foo .md');
  return r !== null && r.startsWith('/base');
})(), 'null byte path either rejected or resolved safely inside base');

// Backslash separators on POSIX — not actually a separator, treated as a literal char
const backslash = resolveInsideBase('/base', 'foo\\bar.md');
assert(backslash !== null && backslash.startsWith('/base'),
  'backslash on POSIX is a literal char, resolves inside base');

// Very deep ".." chain
assert(resolveInsideBase('/base', '../'.repeat(50) + 'etc/passwd') === null,
  '50-level ../ chain rejected');

// URL-encoded ".." — our resolver doesn't decode, so this becomes a weird filename inside base
const encoded = resolveInsideBase('/base', '%2e%2e/passwd');
assert(encoded !== null && encoded.startsWith('/base'),
  'URL-encoded ".." not decoded — treated as literal chars (no double-decoding bug)');

// Mixed trailing slashes
assert(resolveInsideBase('/base/', '../../etc/') === null, 'trailing slashes in base + traversal rejected');

// Empty string after trim equivalent
assert(resolveInsideBase('/base', '   ') !== null, 'whitespace path resolves to base (no crash)');

// Very long path (4 KB)
const veryLong = 'a/'.repeat(2000) + 'leaf.md';
const longRes = resolveInsideBase('/base', veryLong);
assert(longRes !== null && longRes.startsWith('/base'), 'very long path within budget works');

// ── 4. Token-leak audit — push & pull cycles don't expose credentials ──

section('Token-leak audit — credential-shaped strings stay in memory only');

// Capture all console.error output during a normal push/pull cycle
const originalErr = console.error;
const captured = [];
console.error = (...args) => captured.push(args.map(a => String(a)).join(' '));

// Set up a personal domain + collective for Fellow A
const fellowPersonalDir = path.join(domainsDir, 'personal');
mkdirSync(path.join(fellowPersonalDir, 'wiki', 'entities'), { recursive: true });
mkdirSync(path.join(fellowPersonalDir, 'wiki', 'concepts'), { recursive: true });
mkdirSync(path.join(fellowPersonalDir, 'wiki', 'summaries'), { recursive: true });
// Already wrote CLAUDE.md above (`makeDomainWithClaude('personal', ...)`)
writeFileSync(path.join(fellowPersonalDir, 'wiki', 'entities', 'leak.md'), '# Leak\n', 'utf-8');

const TEST_TOKEN_PAT     = 'ghp_thisisasecretpatdonotleak1234abcdABCD';
const TEST_TOKEN_FELLOW  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.thisisasecretfellowtoken';
const TEST_TOKEN_ADMIN   = 'admin_sk_supersecretkeyvaluedontleak';

const tokenConn = makeConnection({
  shared_brain_slug: 'leak-audit',
  // Add fake credentials to verify they're never echoed by any code path.
  // storage_type stays "local" so no real API is hit.
  github_pat: TEST_TOKEN_PAT,
  fellow_token: TEST_TOKEN_FELLOW,
  admin_token: TEST_TOKEN_ADMIN,
});
connections[tokenConn.id] = tokenConn;

// Mock LLM that throws — exercises the error log path
const throwingLLM = async () => { throw new Error(`mock LLM failure with conn id ${tokenConn.id}`); };

await pushDomain(tokenConn, 'personal', {
  llmFn: throwingLLM,
  domainsDir,
  patchFn,
});

await pullCollective(tokenConn, { domainsDir, patchFn });

// Restore console.error
console.error = originalErr;

// Scan all captured output for any of the secrets
const allOutput = captured.join('\n');
for (const [name, secret] of [
  ['github_pat',   TEST_TOKEN_PAT],
  ['fellow_token', TEST_TOKEN_FELLOW],
  ['admin_token',  TEST_TOKEN_ADMIN],
]) {
  // Check both the full secret and the first 16+ chars (in case something
  // log-truncates partway)
  const firstHalf = secret.slice(0, 16);
  assert(!allOutput.includes(secret),
    `[${name}] full secret never appears in console.error output`);
  assert(!allOutput.includes(firstHalf),
    `[${name}] even first-16-chars of secret never appears in output`);
}

// Also confirm we DID capture SOMETHING (otherwise the test is silently passing)
assert(captured.length > 0, 'audit captured at least one console.error (mock LLM failures)');

// ── 5. isDomainReadonly check inside an MCP-style write-time gate ────────

section('isDomainReadonly — works as a guard (the Phase 4 enforcement preview)');

// Phase 4 will add MCP write tools that call isDomainReadonly() at the top
// and refuse. This isn't yet wired in MCP, but we can preview the helper
// returning the right answer for the kind of domain shape MCP will see.

// A real shared-brain mirror (set up by ensureSharedDomainExists in Phase 2C)
const fellow2_DomainsDir = path.join(workspaceRoot, 'fellow2');
mkdirSync(fellow2_DomainsDir, { recursive: true });

const conn2 = makeConnection({ shared_brain_slug: 'mcp-preview' });
await ensureSharedDomainExists('shared-mcp-preview', conn2, fellow2_DomainsDir);

// Point the override at this fellow's dir for the duration of this one check.
__setDomainsDirOverride(fellow2_DomainsDir);
try {
  assert(await isDomainReadonly('shared-mcp-preview'),
    'ensureSharedDomainExists output is detected as readonly (Phase 4 MCP guard will work)');
} finally {
  __setDomainsDirOverride(domainsDir); // restore the main workspace override
}

// Cleanup
console.log('\nCleaning up...');
rmSync(workspaceRoot, { recursive: true, force: true });
console.log(`Removed ${workspaceRoot}`);

// Clear the test-only domains-dir override so it can't leak into any other
// code running in this process.
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

console.log('\nAll Phase 2D security tests green. Ready for Phase 2E (synthesis).');
process.exit(0);
