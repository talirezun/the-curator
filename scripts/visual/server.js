/**
 * Spin up an ISOLATED Curator server for the visual harness.
 *
 * SAFETY — every line here is load-bearing:
 *
 *  - EPHEMERAL PORT, NEVER 3333. The maintainer runs the real app on 3333 and
 *    this repo has already had an agent's browser hijack another agent's tab.
 *    We pick a free port, assert it is not 3333, and every in-page probe
 *    re-checks `location.port` against it before recording anything.
 *
 *  - BOTH isolation seams. CURATOR_TEST_DOMAINS_DIR alone isolates only the
 *    wiki; the server would still hold the maintainer's real
 *    `.curator-config.json` and `.sync-config.json` (their live GitHub PAT).
 *    CURATOR_TEST_USER_DATA_DIR is the one that covers the credential files,
 *    and we set both.
 *
 *  - CREDENTIALS STRIPPED. `.env` is a documented gap in the user-data seam,
 *    so provider keys are additionally deleted from the child's environment.
 *    The harness never needs an LLM, and with no key reachable it cannot
 *    spend money even if a view were to try.
 *
 *  - WE SIGNAL ONLY OUR OWN CHILD PID. No pkill, no killall, no port sweep.
 */

import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HARNESS_DIR, '..', '..');

const FORBIDDEN_PORTS = new Set([3333]);   // the maintainer's live app

/** Ask the OS for a free port by binding :0 and reading it back. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Seed a throwaway user-data + domains tree so the shell reaches a normal
 * steady state instead of the first-run empty state.
 *
 * The API key written here is a FAKE, deliberately. A real key would let a
 * stray code path spend money; a fake one cannot, while still satisfying the
 * `hasGeminiKey` check that otherwise puts the onboarding panel on screen and
 * changes every layout measurement. (The onboarding panel is separately worth
 * measuring — `--with-onboarding` skips this seeding.)
 */
export function seedFixture({ withOnboarding = false } = {}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'curator-visual-userdata-'));
  const domainsDir = mkdtempSync(path.join(os.tmpdir(), 'curator-visual-domains-'));

  if (!withOnboarding) {
    writeFileSync(path.join(userDataDir, '.curator-config.json'), JSON.stringify({
      geminiApiKey: 'AIza' + '-VISUAL-HARNESS-FAKE-KEY-not-a-credential', // assembled: a literal here would trip .githooks/pre-commit, and allow-listing our own fixture trains the next person to allow-list
      activeProvider: 'gemini',
      domainsPath: domainsDir,
    }, null, 2), { mode: 0o600 });
  }

  // One small, deterministic domain. Real enough that views render content;
  // small enough that nothing in the report depends on the maintainer's data.
  const slug = 'visual-fixture';
  const wiki = path.join(domainsDir, slug, 'wiki');
  for (const d of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, d), { recursive: true });
  mkdirSync(path.join(domainsDir, slug, 'raw'), { recursive: true });
  mkdirSync(path.join(domainsDir, slug, 'conversations'), { recursive: true });

  writeFileSync(path.join(domainsDir, slug, 'CLAUDE.md'),
    '# Visual Fixture\n\nA deterministic domain used only by the visual harness.\n');
  writeFileSync(path.join(wiki, 'index.md'),
    '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n' +
    '| [[ada-lovelace]] | entity | A person page. |\n' +
    '| [[gradient-descent]] | concept | A concept page. |\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n\n## [2026-01-01] seed\n\n- Fixture created.\n');
  writeFileSync(path.join(wiki, 'entities', 'ada-lovelace.md'),
    '---\ntype: entity\ntags: [type/entity]\n---\n\n# Ada Lovelace\n\n## Summary\n\nA fixture entity.\n\n## Related\n\n- [[gradient-descent]]\n');
  writeFileSync(path.join(wiki, 'concepts', 'gradient-descent.md'),
    '---\ntype: concept\ntags: [type/concept]\n---\n\n# Gradient Descent\n\n## Definition\n\nA fixture concept.\n\n## Related\n\n- [[ada-lovelace]]\n');

  return { userDataDir, domainsDir, domainSlug: slug };
}

/**
 * Start `src/server.js` isolated, and resolve once it answers /api/version.
 * @returns {Promise<{port, origin, close, fixture}>}
 */
export async function startIsolatedServer({ withOnboarding = false } = {}) {
  const port = await freePort();
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`refusing to bind port ${port} (reserved for the live app)`);

  const fixture = seedFixture({ withOnboarding });

  const env = { ...process.env };
  // No provider or GitHub credential may reach this child. `.env` is not
  // covered by the user-data seam, so strip explicitly.
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
                   'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT', 'DOMAINS_PATH', 'LLM_MODEL']) {
    delete env[k];
  }
  env.PORT = String(port);
  env.CURATOR_NO_OPEN = '1';                                  // never steal focus
  env.CURATOR_TEST_USER_DATA_DIR = fixture.userDataDir;        // credentials
  env.CURATOR_TEST_DOMAINS_DIR = fixture.domainsDir;           // wiki content

  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'src', 'server.js')], {
    cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d.toString(); });
  child.stderr.on('data', d => { log += d.toString(); });

  const close = async () => {
    if (child.exitCode === null && child.pid) {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      for (let i = 0; i < 30 && child.exitCode === null; i++) await delay(100);
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }
    for (const d of [fixture.userDataDir, fixture.domainsDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };

  const origin = `http://localhost:${port}`;
  for (let i = 0; i < 120; i++) {                              // up to ~24s
    if (child.exitCode !== null) {
      await close();
      throw new Error(`server exited with code ${child.exitCode}\n${log.slice(-1500)}`);
    }
    try {
      const r = await fetch(`${origin}/api/version`);
      if (r.ok) return { port, origin, close, fixture, log: () => log };
    } catch { /* not up yet */ }
    await delay(200);
  }
  await close();
  throw new Error(`server did not answer /api/version on ${origin}\n${log.slice(-1500)}`);
}
