/**
 * The REAL user's MCP config files the v3.85.0 installer can write, and a
 * read-only fingerprint of each.
 *
 * Every test-mcp-install-*.js suite takes this before it does anything and
 * again in `finally`, and FAILS if the suite could have written one: `npm test`
 * must never touch a real config file. It only ever READS (lstat, readFile,
 * readdir).
 *
 * WHY NOT A BARE sha256 COMPARISON. Measured 2026-10-31 on the maintainer's
 * Mac: a running Claude Desktop rewrote its own claude_desktop_config.json in
 * the middle of a suite run (same size, new mtime, no test content), and a
 * bare hash check went red on a write the suite did not make. So a change
 * counts as OURS — and fails the suite — when ANY of these is true:
 *   1. the file appeared or disappeared, or became something other than a file;
 *   2. a new `<file>.curator-backup-*` sibling appeared — the installer takes
 *      one before EVERY replace of an existing file, so no write of ours to
 *      an existing file can happen without it;
 *   3. the file's bytes now contain a test marker (a test tempdir prefix,
 *      the planted fake key, or the fixture launch line);
 *   4. its permission bits changed.
 * A content change with none of these is reported as "changed by its own app"
 * and listed, never silently ignored.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKERS = ['curator-mcpinst-', 'sk-PLANTED', '/app/mcp/server.js'];

export function realConfigPaths() {
  let home = '';
  try { home = os.userInfo().homedir || os.homedir(); } catch { home = os.homedir(); }
  return [
    path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.gemini', 'config', 'mcp_config.json'),
    path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    path.join(home, '.gemini', 'antigravity-ide', 'mcp_config.json'),
  ];
}

function backupsOf(p) {
  try { return readdirSync(path.dirname(p)).filter((n) => n.startsWith(`${path.basename(p)}.curator-backup-`)).sort(); }
  catch { return []; }
}

export function fingerprintReal() {
  const out = {};
  for (const p of realConfigPaths()) {
    let st;
    const rec = { kind: 'absent', sha: null, mode: null, backups: backupsOf(p), marker: false };
    try { st = lstatSync(p); } catch { out[p] = rec; continue; }
    rec.kind = st.isFile() ? 'file' : `other:${st.mode}`;
    rec.mode = st.mode & 0o7777;
    if (st.isFile()) {
      try {
        const b = readFileSync(p);
        rec.sha = createHash('sha256').update(b).digest('hex');
        const t = b.toString('utf8');
        rec.marker = MARKERS.some((m) => t.includes(m));
      } catch { rec.sha = 'unreadable'; }
    }
    out[p] = rec;
  }
  return out;
}

/**
 * `{ours: [...], external: [...]}` — files the suite may have written (fail),
 * and files whose content changed with no sign of us (the owning app).
 */
export function compareReal(before) {
  const now = fingerprintReal();
  const ours = [];
  const external = [];
  for (const p of Object.keys(before)) {
    const a = before[p];
    const b = now[p];
    if (a.kind !== b.kind || a.mode !== b.mode || (b.marker && !a.marker)
      || b.backups.length !== a.backups.length || b.backups.some((x, i) => x !== a.backups[i])) ours.push(p);
    else if (a.sha !== b.sha) external.push(p);
  }
  return { ours, external };
}

/** Back-compat helper: the list that FAILS a suite. Logs external changes. */
export function changedSince(before) {
  const { ours, external } = compareReal(before);
  for (const p of external) console.log(`  · note: ${p} changed during the run with no Curator backup and no test marker — its own app rewrote it`);
  return ours;
}
