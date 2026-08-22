/**
 * Local filesystem storage adapter for the My Curator MCP server.
 *
 * Phase 1 — reads markdown files directly from the user's domains/ folder.
 * Phase 3 will add an r2.js adapter with the same interface.
 *
 * Domains path resolution order (do not reorder rungs 2-5 without checking
 * src/brain/config.js's getDomainsDir, which deliberately ranks config ABOVE
 * DOMAINS_PATH; see the note on that divergence below):
 *   1. CURATOR_TEST_DOMAINS_DIR env var  (TEST-ONLY; never set in production)
 *   2. --domains-path CLI arg (passed from the generated Claude Desktop config)
 *   3. DOMAINS_PATH env var
 *   4. .curator-config.json in the Curator user-data dir
 *   5. <user-data dir>/domains
 *
 * Rung 1 exists so a spawned MCP child can be isolated onto a throwaway
 * tempdir wholesale, exactly as the app already allows (getDomainsDir ranks
 * CURATOR_TEST_DOMAINS_DIR above config for the same reason). It sits ABOVE the
 * CLI arg deliberately: a test that sets it means it, and the CLI arg is
 * supplied by the generated Claude Desktop config, not by the test. It is never
 * set in production — Claude Desktop is launched by launchd and does not
 * inherit a developer's shell environment.
 *
 * v3.1.0+: steps 3 and 4 resolve through src/brain/paths.js — the SAME module
 * the app itself uses. This file used to re-derive the config path from its own
 * location. If that derivation ever disagreed with the app's, the MCP server
 * would read a different domains folder than the UI and the user's Claude
 * Desktop would silently see a stale or empty wiki. paths.js imports only Node
 * builtins and logs nothing, so it is safe for this stdio child process (stdout
 * is reserved for JSON-RPC frames).
 */

import fs from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getCuratorConfigFile, getDefaultDomainsDir } from '../../src/brain/paths.js';

export function createStorageAdapter({ domainsPath } = {}) {
  const resolveDomainsPath = () => {
    // TEST-ONLY wholesale isolation — see rung 1 in the header.
    if (process.env.CURATOR_TEST_DOMAINS_DIR) {
      return path.resolve(process.env.CURATOR_TEST_DOMAINS_DIR);
    }
    if (domainsPath) return path.resolve(domainsPath);
    if (process.env.DOMAINS_PATH) return path.resolve(process.env.DOMAINS_PATH);
    const configPath = getCuratorConfigFile();
    if (existsSync(configPath)) {
      try {
        const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
        if (cfg.domainsPath) return path.resolve(cfg.domainsPath);
      } catch { /* fall through */ }
    }
    return getDefaultDomainsDir();
  };

  const base = resolveDomainsPath();
  const resolvedBase = path.resolve(base);

  /**
   * Resolve a relative path under base and refuse to escape the base directory.
   * Returns null for any attempt at path traversal (../, absolute paths, etc.).
   * This is the single chokepoint for all filesystem reads driven by LLM input.
   */
  const resolveInsideBase = (relativePath) => {
    if (typeof relativePath !== 'string' || !relativePath) return null;
    // Reject absolute paths outright — the MCP never needs them.
    if (path.isAbsolute(relativePath)) return null;
    const resolved = path.resolve(resolvedBase, relativePath);
    // Must live under base (path.resolve canonicalises .., //, etc.)
    const rel = path.relative(resolvedBase, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return resolved;
  };

  return {
    getType() { return 'local'; },
    getBase() { return base; },

    async baseExists() {
      try { const s = await fs.stat(base); return s.isDirectory(); }
      catch { return false; }
    },

    async listDomains() {
      try {
        const entries = await fs.readdir(base, { withFileTypes: true });
        const candidates = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => e.name);
        // A directory is only a real domain if it has a CLAUDE.md schema.
        // Sync-deleted domains sometimes leave empty dir shells behind because
        // git doesn't track empty directories — filtering on the schema file
        // ignores those ghosts.
        const real = [];
        for (const name of candidates) {
          try {
            const s = await fs.stat(path.join(base, name, 'CLAUDE.md'));
            if (s.isFile()) real.push(name);
          } catch { /* no schema → not a real domain */ }
        }
        return real.sort();
      } catch {
        return [];
      }
    },

    async readFile(relativePath) {
      const full = resolveInsideBase(relativePath);
      if (!full) return null;    // traversal attempt, absolute path, or empty input
      try { return await fs.readFile(full, 'utf8'); }
      catch { return null; }
    },

    // Append one record to the per-domain MCP write audit log (v2.5.2+).
    // Lives at `domains/<d>/.mcp-write-log.jsonl` — sibling to wiki/, NOT
    // inside it. Gitignored via the rule added in `ensureDomainsGitignore`
    // so write history stays local: it must not spill to GitHub.
    //
    // Format: one JSON object per line, e.g.
    //   {"ts":"2026-04-26T17:01Z","tool":"compile_to_wiki","paths":["summaries/x.md"], ...}
    async appendToWriteAudit(domain, entry) {
      if (typeof domain !== 'string' || !domain || domain.includes('/') || domain.includes('\\') || domain.includes('..')) {
        return;
      }
      const file = resolveInsideBase(path.join(domain, '.mcp-write-log.jsonl'));
      if (!file) return;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
      } catch { /* audit log is best-effort; never fail the write because of it */ }
    },

    /** Returns all .md files under a domain's wiki/ folder with their content. */
    async listWikiFiles(domain) {
      // Reject any domain containing path separators or parent refs
      if (typeof domain !== 'string' || !domain || domain.includes('/') || domain.includes('\\') || domain.includes('..')) {
        return [];
      }
      const wikiRoot = resolveInsideBase(path.join(domain, 'wiki'));
      if (!wikiRoot) return [];
      const files = [];
      const walk = async (dir) => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.name.endsWith('.md')) {
            const rel = path.relative(wikiRoot, full).split(path.sep).join('/');
            let content = '';
            try { content = await fs.readFile(full, 'utf8'); } catch {}
            files.push({ path: rel, content });
          }
        }
      };
      await walk(wikiRoot);
      return files;
    },
  };
}
