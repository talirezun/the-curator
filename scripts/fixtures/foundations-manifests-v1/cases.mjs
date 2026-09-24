/**
 * Real-shaped v1 foundations manifests (v3.68.1 byte-identity fixtures).
 *
 * Synthetic data only — no real user data, no home paths (the repo is public).
 * Each case is the manifest on disk plus the store operations run over it;
 * `golden.json` beside this file holds the bytes the v3.68.0 writer (`05fb1a1`)
 * produced after each operation, and `test-manifest-forward-compat.js`
 * requires the current writer to produce the same bytes.
 */
const H = (c) => c.repeat(64);
const HUMAN = { kind: 'human', harness: null, model: null, commissionedBy: null };
const AGENT = { kind: 'agent', harness: 'claude-code', model: 'opus-5', commissionedBy: 'owner' };
const ORDER = ['architecture', 'decisions', 'conventions', 'roadmap', 'api', 'guide', 'other'];
const doc = (slug, role, over) => ({
  slug, role, title: slug.replace(/\.md$/, ''), source: { kind: 'curator' },
  sha256: H('a'), bytes: 1200, updatedAt: '2026-09-20T10:00:00.000Z', commit: null, authoredBy: HUMAN,
  skeleton: false, readFirst: false, ...over,
});
const repoDoc = (slug, role, p, over) => doc(slug, role, {
  source: { kind: 'repo', path: p }, commit: '0123456789abcdef0123456789abcdef01234567', copiedFrom: null, ...over,
});
const pretty = (o) => `${JSON.stringify(o, null, 2)}\n`;

export const CASES = [
  {
    name: 'curator-kept, copiedFrom (v3.68.0 shape)',
    manifest: pretty({ version: 1, ownership: 'curator', repo: null, budgetBytes: 204800, order: ORDER, documents: [
      doc('architecture.md', 'architecture', { copiedFrom: 'dev', readFirst: true, sha256: H('b') }),
      doc('decisions-agents.md', 'decisions', { copiedFrom: 'dev' }),
      doc('notes.md', 'other', { copiedFrom: null, authoredBy: AGENT, hidden: true }),
    ] }),
    ops: [['readFirst', 'decisions-agents.md', true], ['atStart', 'notes.md', 'on-request'], ['remove', 'architecture.md']],
  },
  {
    name: 'curator-kept, before v3.68 (no copiedFrom key)',
    manifest: pretty({ version: 1, ownership: 'curator', repo: null, budgetBytes: 204800, order: ORDER, documents: [
      doc('architecture.md', 'architecture', { skeleton: true }),
      doc('conventions.md', 'conventions', { readFirst: true }),
    ] }),
    ops: [['readFirst', 'architecture.md', true], ['atStart', 'conventions.md', 'not-at-start']],
  },
  {
    name: 'folder mirror (repo.root, origin recorded)',
    manifest: pretty({ version: 1, ownership: 'repo', repo: {
      root: '/srv/checkouts/lumina', remote: { owner: 'acme', repo: 'lumina', ref: null, path: null },
      lastRefreshAt: '2026-09-21T08:30:00.000Z', lastRefreshCommit: '89abcdef0123456789abcdef0123456789abcdef',
    }, budgetBytes: 204800, order: ORDER, documents: [
      repoDoc('decisions-agents.md', 'decisions', 'decisions-agents.md', { readFirst: true }),
      repoDoc('wiki-pipeline.md', 'guide', 'wiki-pipeline.md'),
    ] }),
    ops: [['readFirst', 'wiki-pipeline.md', true], ['atStart', 'decisions-agents.md', 'not-at-start'], ['remove', 'wiki-pipeline.md']],
  },
  {
    name: 'GitHub mirror (root null, repo.remote)',
    manifest: pretty({ version: 1, ownership: 'repo', repo: {
      root: null, remote: { owner: 'acme', repo: 'lumina', ref: 'main', path: 'docs' },
      lastRefreshAt: '2026-09-22T12:00:00.000Z', lastRefreshCommit: 'fedcba9876543210fedcba9876543210fedcba98',
    }, budgetBytes: 204800, order: ORDER, documents: [
      repoDoc('architecture.md', 'architecture', 'architecture.md', { commit: 'fedcba9876543210fedcba9876543210fedcba98' }),
      repoDoc('api.md', 'api', 'reference/api.md', { hidden: true }),
    ] }),
    ops: [['readFirst', 'architecture.md', true], ['readFirst', 'api.md', true], ['remove', 'api.md']],
  },
  {
    name: 'empty, curator chosen',
    manifest: pretty({ version: 1, ownership: 'curator', repo: null, budgetBytes: 204800, order: ORDER, documents: [] }),
    ops: [['save', 'first.md', '# First\n\nThe first document.\n']],
  },
  {
    name: 'empty, repo chosen (declared source)',
    manifest: pretty({ version: 1, ownership: 'repo', repo: {
      root: null, remote: { owner: 'acme', repo: 'lumina', ref: null, path: null }, lastRefreshAt: null, lastRefreshCommit: null,
    }, budgetBytes: 204800, order: ORDER, documents: [] }),
    ops: [],
  },
];
