#!/usr/bin/env node
/**
 * measure-harness — read the MCP usage log and report, per harness, whether an
 * unprompted read-then-save was actually observed. v3.63.0 (Package M).
 *
 * WHY THIS EXISTS
 * ────────────────
 * CLAUDE.md's rule for this release: "Claims of harness reach are measured
 * (reads AND unprompted saves), never asserted; unmeasured is labelled
 * unmeasured." This script is the measuring instrument, not the claim itself —
 * it counts what the usage log actually shows for a window of time and prints
 * a verdict word from a fixed, small vocabulary. It never runs a harness, never
 * talks to an agent, and never writes anywhere. `--all` and `--harness` differ
 * only in which sessions go into which row; the aggregation is one function,
 * called once or many times.
 *
 * `client` and `sid` are fields DESIGN doc §G assigns to a sibling package
 * ("S · usage-log fields") that had not landed in this worktree as of this
 * package's build. This script is written DEFENSIVELY against that: a line
 * with no `sid` is `legacy` and never a session (it predates per-session
 * identity and cannot be attributed to one); a line with no `client` belongs
 * to a session whose harness is `unlabeled`. Nothing here assumes S's exact
 * field widths or the shape of its allow-list — only that `sid` is a
 * non-empty string identifying one bridge process, and `client` an
 * allow-listed label naming what connected.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE OPERATOR PROTOCOL (design §E.1 — fix this BEFORE measuring anything)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   Arms:    A = skill only · B = skill + instruction block · C = skill +
 *            block + adapter hooks. Arm C is what v3.63.0 is for.
 *   N:       4 runs per arm per harness (the 2026-09-10 shape — a shape, not
 *            a rate; nothing here licenses treating N as a statistical rate).
 *   Task:    ONE fixed task on a throwaway fixture project, opening with the
 *            trigger word "Continue", ending in a natural stop (a second
 *            variant ends in compaction, arm C only, for the B14 checklist
 *            item). The task prompt must contain NO instruction to save and
 *            no mention of The Curator — that is what "unprompted" means, and
 *            it is a property of the task the OPERATOR wrote, not something
 *            this script can verify from the log. That is why every row
 *            carries a `--protocol` label the operator supplies by hand
 *            (recorded verbatim, never inferred) rather than a computed flag.
 *   Fixture: a throwaway domain under an OS temp dir, pinned with BOTH
 *            CURATOR_TEST_DOMAINS_DIR and --domains-path when launching the
 *            bridge (the mcp-exercise.js discipline — DOMAINS_PATH alone
 *            loses to a configured domainsPath).
 *   Read:    a `get_project_context` or `get_working_state` line with
 *            `ok: true` inside that session's sid.
 *   Save:    a `save_working_state` line with `ok: true` inside that
 *            session's sid — a save that reached the store. Save QUALITY is
 *            explicitly not judged, here or anywhere in this release.
 *   Record per row (by hand, alongside this script's output): date, harness,
 *            harness version, model, arm, skill activated y/n,
 *            `clientInfo.name` observed. This script supplies the counts;
 *            it does not know a harness's version or which skill file loaded.
 *
 *   Run the fixed task N times on one harness with the adapter installed,
 *   under one arm, never prompting for a save, then run this script once for
 *   that window:
 *
 *     node scripts/measure-harness.js --harness claude-code \
 *       --since 2026-09-20T00:00:00Z --protocol arm-c-neutral-task
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT "MEASURED" MAY AND MAY NOT CLAIM
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   MAY claim: "N sessions were opened under this label in this window, and
 *   of those, this many read and this many (also) saved, with no prompt to
 *   save in the task." That is a fact about the log plus the operator's own
 *   statement of the protocol they ran.
 *
 *   MAY NOT claim: that the save was CORRECT, that no other tool was running
 *   against the same fixture in the window (a mixed window inflates or
 *   deflates every row equally — keep windows narrow and exclusive to one
 *   run), that a harness with zero sessions in the window does not work (it
 *   may simply not have been run — `not-measured` is silence, not a verdict
 *   of failure), or that a `client` label this script never saw is the same
 *   harness under a different name (Decision I: the label is many-to-one and
 *   allow-listed elsewhere; this script does no translation of its own).
 *
 *   A harness with no row in the maintained matrix ships as "not measured",
 *   in the product and in the docs, with the protocol that would change it —
 *   never with wording that implies it works (design §E.3).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CLI
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/measure-harness.js --harness <label> --since <iso>
 *       [--protocol <label>] [--min-sessions <n>] [--log <path>] [--json]
 *   node scripts/measure-harness.js --all --since <iso>
 *       [--min-sessions <n>] [--log <path>] [--json]
 *   node scripts/measure-harness.js --help
 *
 *   --since is INCLUSIVE (a line timestamped exactly at --since counts; one
 *   millisecond earlier does not) and open-ended — there is no --until, the
 *   window always runs to the end of the log as read.
 *
 *   Verdict vocabulary (Decision A), computed per row from `sessionsBoth`
 *   (sessions in that row with BOTH a read and a save) against
 *   `--min-sessions` (default 4, Q5's four gating rows):
 *
 *     not-measured     sessions === 0 for this label in this window
 *     measured-no      sessions > 0, but sessionsBoth === 0
 *     measured-partial 0 < sessionsBoth < min-sessions
 *     measured-yes     sessionsBoth >= min-sessions
 *
 *   This script never fails on what it finds — a session that never saved is
 *   exactly the reading it exists to surface, not an error. It exits 0
 *   always, including on a usage mistake (the message still names the
 *   problem); with --json it never writes anything but one JSON value to
 *   stdout, diagnostics go to stderr. It never writes to the log, the domains
 *   folder, or anywhere else — it is read-only, full stop.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMcpUsageLogPath } from '../src/brain/paths.js';
import { VIA_SELF_TEST, normaliseVia } from '../src/brain/mcp-usage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_MAIN = path.resolve(process.argv[1] || '') === path.resolve(HERE, 'measure-harness.js');

/** Tools that count as a session having "read" — mirrors mcp-usage.js's own bootstrap pair. */
export const READ_TOOLS = new Set(['get_project_context', 'get_working_state']);

/** The one tool that counts as a session having "saved". */
export const SAVE_TOOL = 'save_working_state';

export const DEFAULT_MIN_SESSIONS = 4;

export const VERDICTS = Object.freeze({
  NOT_MEASURED: 'not-measured',
  NO: 'measured-no',
  PARTIAL: 'measured-partial',
  YES: 'measured-yes',
});

const HARNESS_LABEL_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

// ── Line parsing ─────────────────────────────────────────────────────────

/**
 * Parse one JSONL line into a normalised record, or return null with a
 * reason if it cannot be trusted. Never throws.
 *
 * `sid` and `client` are read defensively: a future field this script does
 * not know the exact shape of is still just "a non-empty string, or absent".
 */
export function parseUsageLine(raw) {
  if (!raw || !raw.trim()) return { record: null, malformed: false }; // blank line — ignore, not an error
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return { record: null, malformed: true };
  }
  if (!rec || typeof rec !== 'object' || typeof rec.ts !== 'string') {
    return { record: null, malformed: true };
  }
  const atMs = Date.parse(rec.ts);
  if (!Number.isFinite(atMs)) return { record: null, malformed: true };

  const sid = typeof rec.sid === 'string' && rec.sid.length > 0 ? rec.sid : null;
  const client = typeof rec.client === 'string' && rec.client.length > 0 ? rec.client : null;
  const tool = typeof rec.tool === 'string' && rec.tool ? rec.tool : 'unknown';

  return {
    malformed: false,
    record: {
      ts: rec.ts,
      atMs,
      tool,
      ok: rec.ok === true,
      via: normaliseVia(rec.via),
      sid,
      client,
    },
  };
}

/** Read one file if present; missing file is not an error — returns []. */
async function readLinesOf(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n');
}

/**
 * Read the usage log (oldest rotated generation first, then the live file),
 * exactly the order mcp-usage.js's own readUsage() uses for `logStartedAt` —
 * so a window spanning a rotation still sees every line in true time order.
 */
export async function readRawLines(logPath) {
  const rotated = `${logPath}.1`;
  const [older, current] = await Promise.all([readLinesOf(rotated), readLinesOf(logPath)]);
  return [...older, ...current];
}

// ── Aggregation ──────────────────────────────────────────────────────────

/**
 * Bucket every line in the log into: self-test (excluded from everything
 * else), legacy (no sid — never a session), malformed (unparseable), and
 * sessioned (grouped by sid), each filtered to `sinceMs <= atMs` (inclusive
 * lower bound, no upper bound).
 */
export function bucketLines(rawLines, sinceMs) {
  let malformedLines = 0;
  let selfTestLines = 0;
  let legacyLines = 0;
  const sessionsBySid = new Map(); // sid -> [{tool, ok, client, atMs}]

  for (const raw of rawLines) {
    const { record, malformed } = parseUsageLine(raw);
    if (malformed) { malformedLines++; continue; }
    if (!record) continue; // blank line
    if (record.atMs < sinceMs) continue; // strictly before the window — not counted anywhere

    if (record.via === VIA_SELF_TEST) { selfTestLines++; continue; }
    if (!record.sid) { legacyLines++; continue; }

    if (!sessionsBySid.has(record.sid)) sessionsBySid.set(record.sid, []);
    sessionsBySid.get(record.sid).push({
      tool: record.tool, ok: record.ok, client: record.client, atMs: record.atMs,
    });
  }

  return { malformedLines, selfTestLines, legacyLines, sessionsBySid };
}

/**
 * Reduce one sid's lines to the shape everything downstream needs.
 *
 * `client` is the single distinct non-null client value seen across the
 * session's lines; `null` if none of its lines carried one ("unlabeled");
 * the literal string `'mixed'` if more than one distinct value appeared —
 * one bridge process is supposed to report one client for its whole life, so
 * disagreement is itself a finding this script surfaces rather than hides by
 * picking one arbitrarily.
 */
export function summariseSession(lines) {
  const clients = new Set(lines.map((l) => l.client).filter(Boolean));
  const client = clients.size === 0 ? null : clients.size === 1 ? [...clients][0] : 'mixed';
  const hasRead = lines.some((l) => READ_TOOLS.has(l.tool) && l.ok);
  const hasSaved = lines.some((l) => l.tool === SAVE_TOOL && l.ok);
  const atValues = lines.map((l) => l.atMs);
  return {
    client,
    hasRead,
    hasSaved,
    firstAtMs: Math.min(...atValues),
    lastAtMs: Math.max(...atValues),
    lineCount: lines.length,
  };
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Fold an array of session summaries (all sharing one label) into one row's counts. */
function foldSessions(summaries, minSessions) {
  const sessions = summaries.length;
  const sessionsRead = summaries.filter((s) => s.hasRead).length;
  const sessionsSaved = summaries.filter((s) => s.hasSaved).length;
  const sessionsBoth = summaries.filter((s) => s.hasRead && s.hasSaved).length;
  const ratio = sessions > 0 ? sessionsBoth / sessions : null;

  let verdict;
  if (sessions === 0) verdict = VERDICTS.NOT_MEASURED;
  else if (sessionsBoth === 0) verdict = VERDICTS.NO;
  else if (sessionsBoth >= minSessions) verdict = VERDICTS.YES;
  else verdict = VERDICTS.PARTIAL;

  let firstAtMs = null;
  let lastAtMs = null;
  for (const s of summaries) {
    if (firstAtMs === null || s.firstAtMs < firstAtMs) firstAtMs = s.firstAtMs;
    if (lastAtMs === null || s.lastAtMs > lastAtMs) lastAtMs = s.lastAtMs;
  }

  return {
    sessions,
    sessionsRead,
    sessionsSaved,
    sessionsBoth,
    ratio,
    verdict,
    firstTs: isoOrNull(firstAtMs),
    lastTs: isoOrNull(lastAtMs),
  };
}

/**
 * Build the single row for `--harness <label>`.
 *
 * Sessions whose resolved client is NOT this label are never folded into the
 * row's counts ("ignored"), but their labels are tallied in `otherClients` so
 * an operator can see a mislabelled or mixed-source window rather than have
 * it silently understate the harness being measured.
 */
export function buildHarnessRow(bucketed, harness, { minSessions = DEFAULT_MIN_SESSIONS } = {}) {
  const matched = [];
  const otherClients = Object.create(null);

  for (const lines of bucketed.sessionsBySid.values()) {
    const summary = summariseSession(lines);
    if (summary.client === harness) {
      matched.push(summary);
    } else {
      const key = summary.client === null ? 'unlabeled' : summary.client;
      otherClients[key] = (otherClients[key] || 0) + 1;
    }
  }

  return {
    harness,
    ...foldSessions(matched, minSessions),
    otherClients,
  };
}

/** Build one row per distinct client label present (`--all`), 'unlabeled' and 'mixed' included. */
export function buildAllRows(bucketed, { minSessions = DEFAULT_MIN_SESSIONS } = {}) {
  const byLabel = new Map();
  for (const lines of bucketed.sessionsBySid.values()) {
    const summary = summariseSession(lines);
    const key = summary.client === null ? 'unlabeled' : summary.client;
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key).push(summary);
  }
  const labels = [...byLabel.keys()].sort((a, b) => a.localeCompare(b));
  return labels.map((label) => ({
    harness: label,
    ...foldSessions(byLabel.get(label), minSessions),
  }));
}

// ── CLI ──────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  node scripts/measure-harness.js --harness <label> --since <iso> [--protocol <label>] [--min-sessions <n>] [--log <path>] [--json]
  node scripts/measure-harness.js --all --since <iso> [--min-sessions <n>] [--log <path>] [--json]

Read-only. Reports whether an unprompted read-then-save was observed in the
MCP usage log for a harness, in a time window. See the file header for the
full operator protocol and what a verdict may and may not claim.`;

export function parseArgs(argv) {
  const args = { json: false, help: false, all: false, minSessions: DEFAULT_MIN_SESSIONS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--all':
        args.all = true;
        break;
      case '--harness':
        args.harness = argv[++i];
        break;
      case '--since':
        args.since = argv[++i];
        break;
      case '--protocol':
        args.protocol = argv[++i];
        break;
      case '--min-sessions':
        args.minSessionsRaw = argv[++i];
        break;
      case '--log':
        args.log = argv[++i];
        break;
      default:
        args.unknown = args.unknown || [];
        args.unknown.push(a);
    }
  }
  return args;
}

/** Validate parsed args. Returns { ok: true, opts } or { ok: false, error }. */
export function validateArgs(args) {
  if (args.unknown && args.unknown.length) {
    return { ok: false, error: `unrecognised argument(s): ${args.unknown.join(' ')}` };
  }
  if (args.all && args.harness) {
    return { ok: false, error: '--all and --harness are mutually exclusive' };
  }
  if (!args.all && !args.harness) {
    return { ok: false, error: 'one of --harness <label> or --all is required' };
  }
  if (args.harness && !HARNESS_LABEL_RE.test(args.harness)) {
    return { ok: false, error: `--harness must look like a slug (got ${JSON.stringify(args.harness)})` };
  }
  if (!args.since) {
    return { ok: false, error: '--since <iso> is required' };
  }
  const sinceMs = Date.parse(args.since);
  if (!Number.isFinite(sinceMs)) {
    return { ok: false, error: `--since is not a parseable date (got ${JSON.stringify(args.since)})` };
  }
  let minSessions = DEFAULT_MIN_SESSIONS;
  if (args.minSessionsRaw !== undefined) {
    minSessions = Number(args.minSessionsRaw);
    if (!Number.isInteger(minSessions) || minSessions < 1) {
      return { ok: false, error: `--min-sessions must be a positive integer (got ${JSON.stringify(args.minSessionsRaw)})` };
    }
  }
  const protocol = typeof args.protocol === 'string' && args.protocol.length ? args.protocol : null;
  return {
    ok: true,
    opts: {
      all: !!args.all,
      harness: args.harness || null,
      sinceMs,
      sinceIso: new Date(sinceMs).toISOString(),
      protocol,
      minSessions,
      logPath: args.log || null,
      json: !!args.json,
    },
  };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function formatRatio(row) {
  return row.sessions > 0 ? `${row.sessionsBoth}/${row.sessions}` : '—';
}

export function formatTable(rows, meta) {
  const header = ['harness', 'sessions', 'read', 'saved', 'both', 'verdict', 'first', 'last'];
  const widths = [14, 9, 7, 7, 6, 16, 26, 26];
  const lines = [];
  lines.push(`window: since=${meta.sinceIso} (inclusive) until=now  protocol=${meta.protocol || '(none given)'}  min-sessions=${meta.minSessions}`);
  lines.push(header.map((h, i) => pad(h, widths[i])).join(' '));
  for (const r of rows) {
    lines.push([
      pad(r.harness, widths[0]),
      pad(r.sessions, widths[1]),
      pad(`${r.sessionsRead}/${r.sessions || 0}`, widths[2]),
      pad(`${r.sessionsSaved}/${r.sessions || 0}`, widths[3]),
      pad(formatRatio(r), widths[4]),
      pad(r.verdict, widths[5]),
      pad(r.firstTs || '—', widths[6]),
      pad(r.lastTs || '—', widths[7]),
    ].join(' '));
    if (r.otherClients && Object.keys(r.otherClients).length) {
      const other = Object.entries(r.otherClients).map(([k, v]) => `${k}=${v}`).join(', ');
      lines.push(`  (other clients seen in window, not counted above: ${other})`);
    }
  }
  lines.push(`self-test lines excluded: ${meta.selfTestLines}  legacy lines (no sid): ${meta.legacyLines}  malformed lines: ${meta.malformedLines}`);
  return lines.join('\n');
}

/** The whole run, as a pure-ish function of argv + an injectable clock/log path — the seam the tests drive. */
export async function run(argv, { logPathOverride } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    return { ok: true, exitCode: 0, stdout: USAGE, stderr: '' };
  }
  const validated = validateArgs(args);
  if (!validated.ok) {
    if (args.json) {
      return { ok: false, exitCode: 0, stdout: JSON.stringify({ error: validated.error }), stderr: '' };
    }
    return { ok: false, exitCode: 0, stdout: '', stderr: `Error: ${validated.error}\n\n${USAGE}\n` };
  }
  const opts = validated.opts;
  const logPath = logPathOverride || opts.logPath || getMcpUsageLogPath();

  let bucketed;
  try {
    const rawLines = await readRawLines(logPath);
    bucketed = bucketLines(rawLines, opts.sinceMs);
  } catch (err) {
    const msg = `could not read the usage log at ${logPath}: ${err && err.message}`;
    if (opts.json) return { ok: false, exitCode: 0, stdout: JSON.stringify({ error: msg }), stderr: '' };
    return { ok: false, exitCode: 0, stdout: '', stderr: `Error: ${msg}\n` };
  }

  const meta = {
    logPath,
    sinceIso: opts.sinceIso,
    protocol: opts.protocol,
    minSessions: opts.minSessions,
    selfTestLines: bucketed.selfTestLines,
    legacyLines: bucketed.legacyLines,
    malformedLines: bucketed.malformedLines,
  };

  if (opts.all) {
    const rows = buildAllRows(bucketed, { minSessions: opts.minSessions });
    const payload = { mode: 'all', ...meta, rows };
    const stdout = opts.json ? JSON.stringify(payload) : formatTable(rows, meta);
    return { ok: true, exitCode: 0, stdout, stderr: '' };
  }

  const row = buildHarnessRow(bucketed, opts.harness, { minSessions: opts.minSessions });
  const payload = { mode: 'harness', ...meta, ...row };
  const stdout = opts.json ? JSON.stringify(payload) : formatTable([row], meta);
  return { ok: true, exitCode: 0, stdout, stderr: '' };
}

async function main() {
  let result;
  try {
    result = await run(process.argv.slice(2));
  } catch (err) {
    // Never throw uncaught — this script reports, it does not crash a chain
    // that called it. Exactly one stderr line; nothing on stdout it did not
    // itself decide to print.
    process.stderr.write(`measure-harness: unexpected error: ${err && err.stack || err}\n`);
    process.exitCode = 0;
    return;
  }
  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (IS_MAIN) {
  main();
}
