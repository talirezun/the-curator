#!/usr/bin/env node
/**
 * Shared Brain — Phase 5 REAL-LLM live test (5.2 + 5.3)
 *
 * Until this suite existed, the Shared Brain delta-generation prompt and
 * the conflict-resolution prompt had NEVER met a real model — every other
 * test injects a mock llmFn. This runs both prompts against every
 * configured provider (Gemini AND Anthropic Haiku):
 *
 *   5.2  Full push path: a realistic wiki page → pushDomain with the REAL
 *        generateText → the stored contribution payload parses, carries
 *        string facts, and survives the trust-boundary sanitizers.
 *   5.3  Conflict resolution: two handcrafted contradictory facts on one
 *        page → runLocalSynthesis with the REAL LLM resolving the
 *        Jaccard-flagged contradiction → whatever verdict the model picks
 *        (keep_a / keep_b / both / merge), the result must parse, the page
 *        must be written, and no fact may be silently lost UNLESS the
 *        model explicitly resolved it.
 *   5.4  Prior-content diff path: loadPriorContent() (revived this release —
 *        its git pathspec used to carry a spurious `domains/` prefix and
 *        always returned null) is exercised against a REAL throwaway git
 *        repo laid out exactly like Personal Sync's, then a REAL model is
 *        handed the resulting PRIOR VERSION / CURRENT VERSION diff prompt.
 *        Asserts the model reports only the genuinely new fact and does
 *        NOT re-submit the unchanged ones — the actual point of reviving
 *        the diff path, which no offline spy-llmFn test can prove.
 *
 * Storage: the REAL GitHubStorageAdapter when GITHUB_TEST_REPO +
 * GITHUB_TEST_PAT are set (full 5.2 as planned); otherwise the local
 * adapter in a tempdir (prompts still meet the real model — the part that
 * matters most). Each provider run uses its own shared_domain; GitHub
 * artefacts are cleaned up exhaustively.
 *
 * Gating: self-skips (exit 0) when NO provider key is available. Each
 * provider is attempted only if getEffectiveKey(provider) resolves.
 * The active provider is forced via .curator-config.json, which is backed
 * up ON DISK and restored byte-for-byte (same pattern as
 * test-beta15-production.js).
 *
 * Cost: ~4 small LLM calls per provider (≲ $0.01 total).
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, copyFileSync, chmodSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import dotenv from 'dotenv';
dotenv.config(); // standalone script — .env keys aren't loaded via server.js here

import { pushDomain } from '../src/brain/sharedbrain.js';
import { runLocalSynthesis } from '../src/brain/sharedbrain-synthesis.js';
import { LocalFolderStorageAdapter } from '../src/brain/sharedbrain-local-adapter.js';
import { GitHubStorageAdapter } from '../src/brain/sharedbrain-github-adapter.js';
import { getEffectiveKey } from '../src/brain/config.js';
import { getProviderInfo } from '../src/brain/llm.js';
import { __setUserDataDirOverride } from '../src/brain/paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, '.curator-config.json');
const CONFIG_BACKUP = `${CONFIG_FILE}.pre-llmlive-backup`;

// ── Gate ────────────────────────────────────────────────────────────────

const providers = ['gemini', 'anthropic'].filter(p => {
  try { return !!getEffectiveKey(p); } catch { return false; }
});
if (providers.length === 0) {
  console.error('');
  console.error('SKIP: no LLM provider key available (config or GEMINI_API_KEY /');
  console.error('ANTHROPIC_API_KEY). This suite runs the Shared Brain delta +');
  console.error('conflict prompts against REAL models. Regression unaffected.');
  console.error('');
  process.exit(0);
}

const ghRepo = process.env.GITHUB_TEST_REPO;
const ghPat  = process.env.GITHUB_TEST_PAT;
const useGitHub = !!(ghRepo && ghPat && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(ghRepo));
const [ghOwner, ghName] = useGitHub ? ghRepo.split('/') : [null, null];

// ── Harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];
function ok(label)        { passed++; console.log(`  ✓ ${label}`); }
function fail(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err.message || err}`); }
function assert(c, l, e)  { c ? ok(l) : fail(l, new Error(e || 'assertion failed')); }
function section(name)    { console.log(`\n── ${name} ──`); }

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Phase 5 REAL-LLM Shared Brain test (5.2 push / 5.3 conflicts)');
console.log(`  Providers: ${providers.join(' + ')}`);
console.log(`  Storage:   ${useGitHub ? `GitHub (${ghRepo})` : 'local adapter (GITHUB_TEST_* not set)'}`);
console.log('══════════════════════════════════════════════════════════════');

// ── Config backup / provider forcing (on-disk, crash-safe) ──────────────

if (existsSync(CONFIG_BACKUP)) {
  // A previous run crashed mid-flight — restore its backup first.
  copyFileSync(CONFIG_BACKUP, CONFIG_FILE);
  chmodSync(CONFIG_FILE, 0o600);
  unlinkSync(CONFIG_BACKUP);
  console.log('  (recovered .curator-config.json from a previous crashed run)');
}
const hadConfig = existsSync(CONFIG_FILE);
if (hadConfig) {
  copyFileSync(CONFIG_FILE, CONFIG_BACKUP);
  chmodSync(CONFIG_BACKUP, 0o600);
}
function restoreConfig() {
  if (hadConfig) {
    if (existsSync(CONFIG_BACKUP)) {
      copyFileSync(CONFIG_BACKUP, CONFIG_FILE);
      chmodSync(CONFIG_FILE, 0o600);
      unlinkSync(CONFIG_BACKUP);
    }
  } else {
    if (existsSync(CONFIG_FILE)) unlinkSync(CONFIG_FILE);
    if (existsSync(CONFIG_BACKUP)) unlinkSync(CONFIG_BACKUP);
  }
}
process.on('exit', restoreConfig);
process.on('SIGINT', () => { restoreConfig(); process.exit(130); });
// SIGTERM (an ordinary `kill`) must restore/clean up too — only the exit
// handler ran before, so a plain kill (not just SIGINT) left the real
// .curator-config.json swapped for the backup. SIGKILL is uncatchable;
// nothing can be done for that case.
process.on('SIGTERM', () => { restoreConfig(); process.exit(143); });

function forceProvider(provider) {
  const cfg = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};
  cfg.activeProvider = provider;
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  chmodSync(CONFIG_FILE, 0o600);
}

// ── Workspace ────────────────────────────────────────────────────────────

const workspace = mkdtempSync(path.join(os.tmpdir(), 'sharedbrain-llmlive-'));
process.on('exit', () => { try { rmSync(workspace, { recursive: true, force: true }); } catch { /* */ } });

const runId = randomUUID().slice(0, 8);
const ghCleanupPrefixes = []; // populated per provider when using GitHub

function makeStorage(provider) {
  if (useGitHub) {
    return {
      kind: 'github',
      adapter: new GitHubStorageAdapter({ owner: ghOwner, repo: ghName, pat: ghPat, branch: 'main' }),
      connFields: {
        storage_type: 'github',
        github_repo_owner: ghOwner,
        github_repo_name: ghName,
        github_pat: ghPat,
        github_branch: 'main',
      },
    };
  }
  const root = path.join(workspace, `storage-${provider}`);
  mkdirSync(root, { recursive: true });
  return {
    kind: 'local',
    adapter: new LocalFolderStorageAdapter({ storage_root: root }),
    connFields: { storage_type: 'local', local_storage_path: root },
  };
}

const connections = {};
const patchFn = (id, patch) => {
  connections[id] = { ...(connections[id] || {}), ...patch };
  return connections[id];
};

// A realistic page — enough substance that the delta prompt has real work.
const PAGE_CONTENT = `# Retrieval-Augmented Generation

## Definition

Retrieval-Augmented Generation (RAG) pairs a language model with a document
retriever: at query time, relevant passages are fetched from an external
corpus and injected into the prompt, grounding the model's answer in
verifiable sources instead of parametric memory alone.

## Key Facts

- Introduced by Lewis et al. in a 2020 paper from Facebook AI Research.
- Reduces hallucination by grounding answers in retrieved passages.
- The retriever and generator can be trained jointly or used off-the-shelf.
- Chunk size and overlap are the two retrieval parameters that most affect quality.

## Related

- [[vector-databases]]
- [[semantic-search]]
`;

// ── Per-provider run ─────────────────────────────────────────────────────

async function runProvider(provider) {
  section(`PROVIDER: ${provider.toUpperCase()}`);
  forceProvider(provider);

  const storage = makeStorage(provider);
  const sharedDomain = `llm-live-${provider}-${runId}`;
  if (useGitHub) {
    ghCleanupPrefixes.push(`collective/${sharedDomain}/`);
  }

  // ── 5.2 — full push path with the real model ─────────────────────────
  const domainsDir = path.join(workspace, `domains-${provider}`);
  const wikiDir = path.join(domainsDir, 'research', 'wiki', 'concepts');
  mkdirSync(wikiDir, { recursive: true });
  writeFileSync(path.join(wikiDir, 'retrieval-augmented-generation.md'), PAGE_CONTENT);

  const pushConn = {
    id: randomUUID(),
    label: `LLM Live ${provider}`,
    fellow_id: randomUUID(),
    fellow_display_name: 'LLM Live Tester',
    shared_domain: sharedDomain,
    shared_brain_slug: `llmlive-${provider}`,
    local_domains: ['research'],
    last_push_at: null,
    pending_retry: {},
    permanent_skip: [],
    enabled: true,
    ...storage.connFields,
  };
  connections[pushConn.id] = pushConn;
  if (useGitHub) ghCleanupPrefixes.push(`contributions/${pushConn.fellow_id}/`);

  const submissionId = randomUUID();
  let pushRes = null;
  try {
    pushRes = await pushDomain(pushConn, 'research', {
      domainsDir, patchFn, submissionId,
      onProgress: (level, msg) => console.log(`    [push:${level}] ${msg}`),
    });
  } catch (err) {
    fail(`[${provider}] pushDomain threw`, err);
  }

  if (pushRes) {
    assert(pushRes.ok === true, `[${provider}] push ok (error: ${pushRes.error || 'none'})`);
    assert(pushRes.pushed === 1, `[${provider}] the page was pushed (pushed=${pushRes.pushed}, skipped=${pushRes.skipped})`);
  }

  // The stored payload is what synthesis will trust — verify the REAL
  // model produced a shape that survives the trust boundary.
  if (pushRes && pushRes.ok && pushRes.pushed === 1) {
    try {
      // Poll — a just-committed contribution can lag the tree listing
      // (GitHub read-after-write consistency).
      let mine = null;
      for (let i = 0; i < 8 && !mine; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 1500));
        const listed = await storage.adapter.listContributionsSince(null);
        mine = listed.find(c => c.submissionId === submissionId) || null;
      }
      assert(!!mine, `[${provider}] stored contribution retrievable`);
      const delta = mine && Array.isArray(mine.payload.deltas) ? mine.payload.deltas[0] : null;
      assert(!!delta, `[${provider}] payload carries a delta`);
      if (delta) {
        assert(typeof delta.title === 'string' && delta.title.trim().length > 0,
          `[${provider}] delta.title is a non-empty string ("${(delta.title || '').slice(0, 40)}")`);
        assert(Array.isArray(delta.new_facts) && delta.new_facts.length > 0,
          `[${provider}] delta.new_facts non-empty (${delta.new_facts && delta.new_facts.length} facts)`);
        assert((delta.new_facts || []).every(f => typeof f === 'string' && f.trim().length > 0),
          `[${provider}] every fact is a non-empty string (trust boundary satisfied)`);
        assert((delta.new_facts || []).some(f => /2020|lewis|rag|retriev/i.test(f)),
          `[${provider}] facts are grounded in the page content`);
        assert(Array.isArray(delta.new_links), `[${provider}] new_links is an array`);
      }
    } catch (err) {
      fail(`[${provider}] payload verification`, err);
    }
  }

  // ── 5.3 — conflict resolution with the real model ────────────────────
  // Two handcrafted near-identical contradictory facts (Jaccard ≥ 0.5 →
  // flagged → REAL LLM verdict). Any verdict shape is acceptable; what
  // must hold: the run succeeds, the page is written, and at least one of
  // the disputed facts survives.
  const fellowX = randomUUID();
  const fellowY = randomUUID();
  if (useGitHub) {
    ghCleanupPrefixes.push(`contributions/${fellowX}/`, `contributions/${fellowY}/`);
  }
  const conflictConn = { ...pushConn, id: randomUUID(), fellow_id: fellowX };
  connections[conflictConn.id] = conflictConn;

  try {
    await storage.adapter.storeContribution(fellowX, randomUUID(), {
      fellow_id: fellowX, domain: sharedDomain,
      contributed_at: new Date(Date.now() - 60_000).toISOString(),
      deltas: [{ path: 'concepts/transformer-architecture.md', title: 'Transformer Architecture',
        new_facts: ['The transformer architecture was introduced by Google researchers in 2017.'],
        new_links: [], removed_links: [] }],
    });
    await storage.adapter.storeContribution(fellowY, randomUUID(), {
      fellow_id: fellowY, domain: sharedDomain,
      contributed_at: new Date(Date.now() - 30_000).toISOString(),
      deltas: [{ path: 'concepts/transformer-architecture.md', title: 'Transformer Architecture',
        new_facts: ['The transformer architecture was introduced by Google researchers in 2015.'],
        new_links: [], removed_links: [] }],
    });

    const synth = await runLocalSynthesis(conflictConn, {
      patchFn, // REAL llmFn — this is the point of the test
      onProgress: (level, msg) => console.log(`    [synth:${level}] ${msg}`),
    });
    assert(synth.ok === true, `[${provider}] synthesis with real conflict LLM ok (error: ${synth.error || 'none'})`);
    assert(synth.pages_failed === 0, `[${provider}] no pages failed (${synth.pages_failed})`);
    assert(synth.pages_written >= 1, `[${provider}] conflict page written`);
    assert(typeof synth.conflicts === 'number', `[${provider}] conflicts count is a number (verdict parsed: ${synth.conflicts})`);

    const page = await storage.adapter.readPage(sharedDomain, 'concepts/transformer-architecture.md');
    assert(typeof page === 'string' && page.length > 0, `[${provider}] conflict page readable`);
    const has2017 = page.includes('2017');
    const has2015 = page.includes('2015');
    assert(has2017 || has2015,
      `[${provider}] at least one disputed fact survives (2017=${has2017}, 2015=${has2015})`);
    if (synth.conflicts > 0) {
      assert(/CONFLICTING SOURCES/.test(page),
        `[${provider}] model kept both → conflict marker rendered`);
      assert(Array.isArray(synth.conflict_pages) && synth.conflict_pages.includes('concepts/transformer-architecture.md'),
        `[${provider}] conflict_pages names the page`);
    } else {
      console.log(`    (model resolved the contradiction — kept ${has2017 && has2015 ? 'both merged' : has2017 ? '2017' : '2015'})`);
      ok(`[${provider}] model resolved decisively — no degenerate marker`);
    }
  } catch (err) {
    fail(`[${provider}] conflict-resolution scenario`, err);
  }

  // ── 5.4 — prior-content diff path meets a real model ──────────────────
  //
  // loadPriorContent() was 100% dead for the whole life of Shared Brain:
  // its git pathspec carried a spurious `domains/` prefix, but Personal
  // Sync's work-tree IS the domains dir, so real tracked paths look like
  // `research/wiki/concepts/x.md` — never `domains/research/...`. Dead, it
  // always returned null, so generateDeltaSummary always took the "brand
  // new page" branch and every push re-submitted a page's ENTIRE body as
  // new facts, even on the second, third, fourth push of the same page.
  //
  // test-sharedbrain-push.js §11/§11b prove the mechanism offline with a
  // spy llmFn. That is not the same claim as "a real model behaves like a
  // diff when handed the prompt" — this section is the missing half: build
  // a real throwaway git repo, commit a v1 page, edit it to v2 (exactly one
  // new fact, everything else byte-identical), push through the REAL
  // provider, and assert the stored contribution's new_facts contains the
  // new fact and does NOT contain the unchanged ones. If loadPriorContent
  // were still dead, the model would see the "new page" framing and report
  // all four facts — which would fail the assertion below.
  try {
    const priorRoot = path.join(workspace, `priorcontent-${provider}`);
    const priorGitDir = path.join(priorRoot, '.knowledge-git');
    const priorDomainsDir = path.join(priorRoot, 'domains');
    const priorWikiDir = path.join(priorDomainsDir, 'research', 'wiki', 'concepts');
    mkdirSync(priorWikiDir, { recursive: true });

    const PAGE_REL = 'concepts/vector-databases.md';
    const pageAbs = path.join(priorDomainsDir, 'research', 'wiki', PAGE_REL);

    // V2 adds exactly ONE new fact; everything else is byte-identical, so
    // any OTHER fact showing up in the model's output proves it was NOT
    // handed the prior version (the bug is back).
    const V1 =
      `# Vector Databases\n\n` +
      `## Definition\n` +
      `A vector database stores high-dimensional embeddings and retrieves them by similarity.\n\n` +
      `## Key Facts\n` +
      `- Pinecone is a managed vector database service.\n` +
      `- FAISS is Meta's open-source similarity search library.\n` +
      `- Cosine similarity is the most common distance metric.\n`;
    const V2 = V1 + `- Qdrant is written in Rust and supports on-premise deployment.\n`;

    // Real git repo, bootstrapped exactly the way sync.js lays out Personal
    // Sync's: git dir + work-tree given explicitly so tracked paths are
    // relative to the DOMAINS folder, never carrying a `domains/` prefix.
    const GIT_ISOLATION = ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
    const GIT_IDENTITY = {
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
    };
    const g = (args, extraEnv = {}) => execFileSync('git',
      [...GIT_ISOLATION, `--git-dir=${priorGitDir}`, `--work-tree=${priorDomainsDir}`, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_IDENTITY, ...extraEnv } });

    g(['init', '-q']);
    writeFileSync(pageAbs, V1);
    const T1 = '2020-01-01T00:00:00Z';
    g(['--literal-pathspecs', 'add', '-A']);
    g(['commit', '-q', '-m', 'v1'], { GIT_AUTHOR_DATE: T1, GIT_COMMITTER_DATE: T1 });

    const tracked = g(['ls-files']).trim();
    assert(tracked.includes(`research/wiki/${PAGE_REL}`) && !/(^|\n)domains\//.test(tracked),
      `[${provider}] tracked path carries no domains/ prefix`,
      `tracked: "${tracked.replace(/\n/g, ' | ')}"`);

    // The user edits the page AFTER that commit — uncommitted, exactly the
    // state between two Personal Sync pushes.
    writeFileSync(pageAbs, V2);

    // Seed an ISOLATED config in the tempdir before redirecting there. paths.js
    // resolves ALL user-data files (not just .knowledge-git) off the same
    // override, so .curator-config.json disappears the moment the override is
    // set unless we put one here. Without this, getEffectiveKey(provider) finds
    // no key for THIS provider and getProviderInfo silently falls through to
    // whichever provider still has one on this machine — a HIGH-severity class
    // of failure where both providers "pass" while actually running the same
    // model.
    //
    // Only the PROVIDER-UNDER-TEST's key is copied in — not both. Nothing else
    // runs while the override is active besides pushDomain, whose default
    // llmFn calls generateText() with no provider override, so it only ever
    // needs this one key. This is strictly better than seeding both: with the
    // other key absent, a resolution bug can no longer silently fall through
    // to a different provider — getProviderInfo() has nothing left to fall
    // back to and throws instead. The failure becomes structurally
    // impossible rather than merely detected by the assertion below.
    // (Also halves how many real credentials ever touch this tempdir file.)
    const realCfgNow = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};
    const keyField = `${provider}ApiKey`; // 'geminiApiKey' | 'anthropicApiKey'
    writeFileSync(path.join(priorRoot, '.curator-config.json'), JSON.stringify({
      [keyField]: realCfgNow[keyField] || null,
      activeProvider: provider,
    }), { mode: 0o600 });

    __setUserDataDirOverride(priorRoot); // points getSyncGitDir() (and the config file above) at THIS tempdir only

    // Prove the redirect didn't silently swap providers. sharedbrain-delta.js's
    // default llmFn calls generateText() with no explicit provider, which
    // resolves through this exact function — so if this doesn't match, the
    // rest of the section would silently be testing the wrong model. A
    // mismatch here must fail LOUDLY; this class of bug is invisible by
    // construction otherwise (see the docblock above).
    const resolvedProviderInfo = getProviderInfo();
    assert(resolvedProviderInfo.provider === provider,
      `[${provider}] §5.4 resolves to the provider under test, not a silent fallback`,
      `getProviderInfo() under the override resolved to ${JSON.stringify(resolvedProviderInfo)} — ` +
      `check that ${provider}ApiKey is present in the real .curator-config.json`);
    console.log(`    [prior-diff:${provider}] resolved provider/model under override: ${resolvedProviderInfo.provider} / ${resolvedProviderInfo.model}`);

    const priorConn = {
      ...pushConn,
      id: randomUUID(),
      fellow_id: randomUUID(),
      shared_domain: `llm-live-prior-${provider}-${runId}`,
      shared_brain_slug: `llmlive-prior-${provider}`,
      last_push_at: '2020-06-01T00:00:00Z', // after the v1 commit, well before "now"
      pending_retry: {},
      permanent_skip: [],
    };
    connections[priorConn.id] = priorConn;
    if (useGitHub) ghCleanupPrefixes.push(`contributions/${priorConn.fellow_id}/`);

    const priorSubmissionId = randomUUID();
    let priorPushRes = null;
    try {
      priorPushRes = await pushDomain(priorConn, 'research', {
        domainsDir: priorDomainsDir, patchFn, submissionId: priorSubmissionId,
        onProgress: (level, msg) => console.log(`    [prior-push:${level}] ${msg}`),
      });
    } catch (err) {
      fail(`[${provider}] prior-diff pushDomain threw`, err);
    }

    if (priorPushRes) {
      assert(priorPushRes.ok === true, `[${provider}] prior-diff push ok (error: ${priorPushRes.error || 'none'})`);
      assert(priorPushRes.pushed === 1, `[${provider}] prior-diff page pushed (pushed=${priorPushRes.pushed}, skipped=${priorPushRes.skipped})`);
    }

    if (priorPushRes && priorPushRes.ok && priorPushRes.pushed === 1) {
      let mine = null;
      for (let i = 0; i < 8 && !mine; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 1500));
        const listed = await storage.adapter.listContributionsSince(null);
        mine = listed.find(c => c.submissionId === priorSubmissionId) || null;
      }
      assert(!!mine, `[${provider}] prior-diff contribution retrievable`);
      const delta = mine && Array.isArray(mine.payload.deltas) ? mine.payload.deltas[0] : null;
      assert(!!delta, `[${provider}] prior-diff payload carries a delta`);
      if (delta) {
        const facts = Array.isArray(delta.new_facts) ? delta.new_facts : [];
        console.log(`    [prior-diff:${provider}] new_facts: ${JSON.stringify(facts, null, 2)}`);
        const joined = facts.join(' | ').toLowerCase();
        assert(joined.includes('qdrant'),
          `[${provider}] the genuinely new fact (Qdrant) is captured`,
          `facts: ${JSON.stringify(facts)}`);
        const oldTerms = ['pinecone', 'faiss', 'cosine'];
        const leaked = oldTerms.filter(t => joined.includes(t));
        assert(leaked.length === 0,
          `[${provider}] unchanged facts (pinecone/faiss/cosine) were NOT re-submitted — proves the model was handed and used the prior version`,
          `leaked: ${leaked.join(',') || 'none'}; facts: ${JSON.stringify(facts)}`);
      }
    }
  } catch (err) {
    fail(`[${provider}] prior-content diff scenario`, err);
  } finally {
    __setUserDataDirOverride(null); // never leave the override pointed at a tempdir
  }
}

// ── Run all providers ────────────────────────────────────────────────────

for (const provider of providers) {
  await runProvider(provider);
}

// ── GitHub cleanup (exhaustive, best-effort) ─────────────────────────────

if (useGitHub) {
  section('Cleanup — delete every file this run created in the repo');
  try {
    const cleanup = new GitHubStorageAdapter({ owner: ghOwner, repo: ghName, pat: ghPat, branch: 'main' });
    const { entries } = await cleanup._apiTree();
    const targets = entries.filter(e => ghCleanupPrefixes.some(p => e.path === p || e.path.startsWith(p)));
    let deleted = 0;
    for (const t of targets) {
      try { await cleanup._apiDelete(t.path, `Shared Brain: cleanup llm-live ${runId}`, t.sha); deleted++; }
      catch (err) { console.log(`  ⚠ could not delete ${t.path}: ${err.message}`); }
    }
    console.log(`  Deleted ${deleted} / ${targets.length} files`);
  } catch (err) {
    console.log(`  ⚠ cleanup errored: ${err.message} (unique slugs per run — no impact on future runs)`);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(50)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.label}\n    ${f.err ? f.err.message : ''}`);
}
process.exit(failed > 0 ? 1 : 0);
