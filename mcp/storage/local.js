/**
 * Local filesystem storage adapter for the My Curator MCP server.
 *
 * Phase 1 — reads markdown files directly from the user's domains/ folder.
 * Phase 3 will add an r2.js adapter with the same interface.
 *
 * Domains path resolution order — MUST stay in lockstep with
 * src/brain/config.js's getDomainsDir(); see the "why config outranks env"
 * note below before reordering anything:
 *   1. CURATOR_TEST_DOMAINS_DIR env var  (TEST-ONLY; never set in production)
 *   2. --domains-path CLI arg (passed from the generated Claude Desktop config)
 *   3. .curator-config.json in the Curator user-data dir
 *   4. DOMAINS_PATH env var
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
 * Why rung 3 (config) outranks rung 4 (DOMAINS_PATH): this MCP adapter and
 * src/brain/config.js's getDomainsDir() are two independent readers of the
 * SAME "where is my wiki" setting. .curator-config.json's domainsPath is what
 * the Settings UI's "change knowledge base location" panel actually writes —
 * it is the user's explicit, current choice. DOMAINS_PATH is a `.env` fallback
 * documented for developers/non-macOS users who haven't touched Settings. If a
 * user has BOTH (e.g. an old DOMAINS_PATH left over in .env from before they
 * used the folder picker), the config value is the one that matches what the
 * app UI shows them — so it must win, in both readers, or the MCP would read a
 * folder the user does not see in their own browser. v3.1.0 introduced this as
 * "one divergence remains, deliberately, and is unrelated to this release"
 * (docs/architecture.md) while flagging it as increasingly urgent; this rung
 * swap is that follow-up, closing the gap rather than opening it further. Do
 * not re-invert this ordering without re-reading that history —
 * the two prior states of this comment (env-above-config, then a "do not
 * reorder" freeze) were each independent development, not a reasoned design
 * for env-over-config; there was never a functional need for the MCP to differ
 * from the app here.
 *
 * v3.1.0+: rungs 3 and 5 resolve through src/brain/paths.js — the SAME module
 * the app itself uses. This file used to re-derive the config path from its own
 * location. If that derivation ever disagreed with the app's, the MCP server
 * would read a different domains folder than the UI and the user's Claude
 * Desktop would silently see a stale or empty wiki. paths.js imports only Node
 * builtins and logs nothing, so it is safe for this stdio child process (stdout
 * is reserved for JSON-RPC frames).
 *
 * SCOPE — this resolver governs READS. Every MCP read tool (list_domains,
 * search_wiki, get_node, etc.) goes through createStorageAdapter() here, so it
 * honours the --domains-path CLI arg above. MCP WRITE tools (compile_to_wiki
 * and the health-fix tools in mcp/tools/compile.js and mcp/tools/health.js) do
 * NOT go through this adapter — they import writePage/scanWiki/fixIssue etc.
 * directly from src/brain/files.js and src/brain/health.js, which resolve the
 * domains dir via src/brain/config.js's getDomainsDir().
 *
 * ── v3.16.2: THAT SPLIT WAS A LIVE DEFECT, AND IT IS NOW CLOSED ─────────────
 * getDomainsDir() had NO rung for the CLI arg, so in one process reads and
 * writes resolved DIFFERENT folders whenever --domains-path disagreed with what
 * getDomainsDir() computed on its own — e.g. an arg pointing at an old location
 * while Settings had since moved. Measured: compile_to_wiki returned
 * `ok: true` with a summary_path, wrote the page into the folder getDomainsDir()
 * chose, wrote .mcp-write-log.jsonl into the folder THIS resolver chose (the
 * audit log goes through the adapter), and a follow-up get_node on the path it
 * had just returned reported NOT FOUND.
 *
 * mcp/server.js now installs the arg into config.js (setCliDomainsDir) BEFORE
 * this adapter is constructed, at the rung directly below the test seams and
 * above the stored setting — i.e. the same position this resolver gives it. The
 * two ladders are therefore equivalent by construction on every input.
 *
 * THIS LADDER IS DELIBERATELY LEFT IN PLACE rather than delegated to
 * getDomainsDir(): scripts/test-paths.js §9 pins these four rungs as source
 * lines AND drives them behaviourally, and deleting them would take that guard
 * with them. The agreement is instead asserted behaviourally — test-paths.js §1
 * and §9(a)-(c), plus scripts/test-mcp-domains-path.js, which adds the case
 * §9(d) was missing: with the CLI arg supplied, the app-side resolver must
 * agree too. That missing companion assertion is precisely why this shipped.
 * If you ever DO unify them, update those pins in the same change.
 */

import fs from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getCuratorConfigFile, getDefaultDomainsDir } from '../../src/brain/paths.js';
// The symlink-aware half of the path guard below. IMPORTED, not copied: the
// v3.2.0 CRITICAL in this repo was two hand-maintained copies of exactly this
// guard drifting apart, and the copy that lagged was the one that could delete
// a file outside the wiki. src/brain/wiki-read.js is already loaded inside the
// MCP stdio child process (mcp/tools/health.js -> src/brain/health.js ->
// wiki-read.js) and its own docblock commits it to stdout purity, so this adds
// no new import weight and no new JSON-RPC-stream risk. It is a leaf edge:
// nothing under src/brain/ imports this adapter, so no cycle is created.
import { resolveInsideWiki as resolveInsideRoot } from '../../src/brain/wiki-read.js';

export function createStorageAdapter({ domainsPath } = {}) {
  const resolveDomainsPath = () => {
    // TEST-ONLY wholesale isolation — see rung 1 in the header.
    if (process.env.CURATOR_TEST_DOMAINS_DIR) {
      return path.resolve(process.env.CURATOR_TEST_DOMAINS_DIR);
    }
    if (domainsPath) return path.resolve(domainsPath);
    const configPath = getCuratorConfigFile();
    if (existsSync(configPath)) {
      try {
        const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
        if (cfg.domainsPath) return path.resolve(cfg.domainsPath);
      } catch { /* fall through */ }
    }
    if (process.env.DOMAINS_PATH) return path.resolve(process.env.DOMAINS_PATH);
    return getDefaultDomainsDir();
  };

  const base = resolveDomainsPath();
  const resolvedBase = path.resolve(base);

  /**
   * Resolve a relative path under base and refuse to escape the base directory.
   * Returns null for any attempt at path traversal (../, absolute paths, etc.).
   * This is the single chokepoint for all filesystem reads driven by LLM input.
   *
   * ── Why this delegates rather than doing the check itself ────────────────
   *
   * It used to be purely LEXICAL — path.resolve + path.relative, no realpath
   * and no lstat. Lexical containment is not containment: a SYMLINK inside the
   * domains folder pointing anywhere on the filesystem passes every one of
   * those checks, because the string never leaves the base. `domains/x/wiki`
   * symlinked at `~/.ssh` reads as `wiki/id_rsa` — a legal relative path under
   * base — and the adapter opens it. That is the exact shape v3.2.0 found and
   * fixed in src/brain/health.js (a symlink escape that could DELETE a file
   * outside the wiki); the read side of the MCP kept the weak version.
   *
   * resolveInsideWiki() is the hardened implementation that fix produced:
   * lexical check FIRST, then realpath(3) of the leaf when the leaf is itself
   * a symlink, and otherwise realpath of the deepest existing ancestor with
   * the not-yet-existing tail re-attached, so a symlinked ANCESTOR directory
   * is caught for paths that do not exist yet. A dangling symlink cannot be
   * proven inside, so it is refused. Its parameter is named `wikiDir` for its
   * first caller; the function itself is a generic "is this path physically
   * inside this root", which is precisely the question here.
   */
  const resolveInsideBase = (relativePath) => resolveInsideRoot(resolvedBase, relativePath);

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
          // A symlinked ENTRY is the one shape the root-level guard above
          // cannot see: the walk arrives here having only ever joined names
          // that are lexically inside. `entities/notes.md -> ~/.ssh/id_rsa`
          // is not a directory, does end in .md, and would be read and
          // returned as wiki content. Route it through the SAME guard the
          // rest of this adapter uses, so a symlink is allowed exactly when
          // it lands back inside the domains folder. Costs a realpath only
          // for entries that actually are symlinks — an ordinary wiki pays
          // nothing. (Symlinked DIRECTORIES are already never descended:
          // Dirent.isDirectory() is false for a link to one.)
          if (entry.isSymbolicLink() && !resolveInsideBase(path.relative(resolvedBase, full))) continue;
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

    /**
     * How many .md files are under a domain's wiki/ folder — WITHOUT reading
     * any of them. Exists so mcp/graph.js can check its cache for staleness on
     * every tool call at a price it can actually afford.
     *
     * Measured on a synthetic 3,000-file / ~2.5 MB domain: listWikiFiles()
     * 173 ms p50, this 1.5 ms p50. Same walk, same skip rules (dotfiles out,
     * symlinks guarded, symlinked directories not descended) — the only
     * difference is that it never opens a file. Keeping the two walks in the
     * same module is deliberate: a count that disagreed with the listing would
     * make the cache check silently useless.
     */
    async countWikiFiles(domain) {
      if (typeof domain !== 'string' || !domain || domain.includes('/') || domain.includes('\\') || domain.includes('..')) {
        return 0;
      }
      const wikiRoot = resolveInsideBase(path.join(domain, 'wiki'));
      if (!wikiRoot) return 0;
      let count = 0;
      const walk = async (dir) => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink() && !resolveInsideBase(path.relative(resolvedBase, full))) continue;
          if (entry.isDirectory()) await walk(full);
          else if (entry.name.endsWith('.md')) count++;
        }
      };
      await walk(wikiRoot);
      return count;
    },
  };
}
