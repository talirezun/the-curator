/**
 * The Setup check (v3.77.0) — what is wired for The Curator on THIS machine and
 * in ONE project's repository, and what the project's own saves prove.
 *
 * ONE DERIVATION, THREE SURFACES: Context › project › step 5 "Setup",
 * Settings › MCP bridge › "Tools on this Mac", and `my-curator doctor` (which
 * imports the file inspectors below instead of keeping its own copies).
 *
 * ── READ-ONLY, AND WHAT "READ" MAY RETURN ──────────────────────────────────
 * Nothing here writes a file, a config, a marker or a git ref. Harness config
 * files hold OTHER servers' entries, and their `env` blocks hold API keys, so
 * an inspector returns only: whether the file is present, whether it parsed,
 * whether it names `my-curator`, and OUR entry's command and `--domains-path`.
 * Never file text, never another server's name, never an `env` value.
 * `scripts/test-setup-check.js` plants a fake key in every fixture config and
 * asserts it never appears in any result.
 *
 * ── EVIDENCE BEFORE CONFIGURATION ──────────────────────────────────────────
 * A config file we read — or failed to find — only EXPLAINS. A save that a tool
 * made to this project, from a machine, under its own scope, PROVES the bridge,
 * the instructions and the scope all worked. When the two disagree the result
 * carries both: measured 2026-09-26 on the maintainer's Mac, ~/.claude.json
 * named no `my-curator` while Claude Code sessions had the tools (Claude
 * Desktop's config named it), and a reader that trusted the file said
 * "not configured" about a working setup.
 *
 * ── THE STATES ─────────────────────────────────────────────────────────────
 * Every cell is one of STATES. There is no score and no percentage: a count of
 * "to fix" rows is the only aggregate, because it counts real rows.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  MCP_SERVER_NAME, adapterFor, listHarnesses, resolveTemplates, skillRootsFor,
} from './harness-adapters.js';
import { normaliseHarness } from './harness-names.js';
import { installIdOf } from './tray-summary.js';

export const STATES = Object.freeze({
  OK: 'ok',
  FIX: 'fix',
  CANT: 'cant-check',
  NOT_CHECKED: 'not-checked',
  UNMEASURED: 'unmeasured',
  NONE: 'none',
});

export const SKILL_NAMES = Object.freeze(['my-curator', 'curator-continuity']);

/** File states that tell us nothing about the entry (see FILE_STATES). */
const BAD_FILE_STATES = new Set(['empty', 'invalid', 'unopenable']);
const BAD_FILE_WORDS = Object.freeze({
  empty: 'is empty',
  invalid: 'could not be read (not valid JSON)',
  unopenable: 'could not be opened (a macOS permission)',
});

/** `~/…` for a path under `home` — a DISPLAY string only; paths stay absolute. */
export function tildeUnder(home, p) {
  return typeof p === 'string' && home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

// ─────────────────────────────────────────────────────────────────────────
// Reading JSON, including JSONC
// ─────────────────────────────────────────────────────────────────────────

/**
 * Strip `//` and `/* *\/` comments and trailing commas OUTSIDE strings.
 * Enough for opencode.jsonc; not a general JSON5 reader.
 */
export function stripJsonComments(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // Trailing commas before } or ] — outside strings, which the pass above
  // already made safe to scan because comments are gone; strings can still
  // hold ",}" so re-walk with a string guard.
  let res = '';
  inStr = false;
  for (let j = 0; j < out.length; j++) {
    const c = out[j];
    if (inStr) {
      res += c;
      if (c === '\\') { res += out[j + 1] ?? ''; j++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; res += c; continue; }
    if (c === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    res += c;
  }
  return res;
}

/**
 * The five states a config file can be in (v3.78.0). Before this, an empty
 * file and a file macOS would not let us open were indistinguishable from
 * "broken" and "absent" respectively — measured 2026-09-28: a 0-byte
 * `~/.gemini/antigravity/mcp_config.json` beside a WORKING
 * `~/.gemini/config/mcp_config.json` turned Antigravity red with "a config
 * file could not be read", and an EACCES file read as not there at all.
 *
 *   missing     no file at that path
 *   unopenable  the file exists and reading it failed (EACCES, a macOS
 *               privacy refusal, a folder where a file should be)
 *   empty       0 bytes, or whitespace only — a half-written or placeholder file
 *   invalid     text that does not parse (JSON, or JSONC after comments go)
 *   ok          parsed
 */
export const FILE_STATES = Object.freeze(['missing', 'unopenable', 'empty', 'invalid', 'ok']);

/** Read a file's text for a check: `{status, text?, bytes?, readError?}`. Never throws. */
function readForCheck(file) {
  let exists = false;
  try { exists = existsSync(file); } catch { exists = false; }
  if (!exists) return { status: 'missing' };
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (err) {
    return { status: 'unopenable', readError: String(err?.code || err?.message || 'unreadable').slice(0, 80) };
  }
  const bytes = Buffer.byteLength(text);
  if (!text.trim()) return { status: 'empty', bytes };
  return { status: 'ok', text, bytes };
}

/**
 * `{present, status, json?, jsonc?, parseError?, bytes?, readError?}` — never the text.
 * `present` keeps its v3.77.0 meaning for `doctor`: the file is there (an
 * unopenable file IS there — it used to read as absent). `parseError` is set
 * for `empty` as well as `invalid`, so a reader that only knows `parseError`
 * still never treats an empty file as a working one.
 */
export function readJsonFile(file) {
  const r = readForCheck(file);
  if (r.status === 'missing') return { present: false, status: 'missing' };
  if (r.status === 'unopenable') return { present: true, status: 'unopenable', readError: r.readError };
  if (r.status === 'empty') return { present: true, status: 'empty', parseError: 'the file is empty', bytes: r.bytes };
  const { text, bytes } = r;
  try { return { present: true, status: 'ok', json: JSON.parse(text), bytes }; } catch (err) {
    try { return { present: true, status: 'ok', json: JSON.parse(stripJsonComments(text)), bytes, jsonc: true }; }
    catch { return { present: true, status: 'invalid', parseError: err.message.slice(0, 160), bytes }; }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Targets — where each harness keeps what, derived from the adapter table
// ─────────────────────────────────────────────────────────────────────────

/**
 * Every harness with somewhere to LOOK, resolved against `{home, project}`.
 * `project` may be '' — project-level files are then simply not listed.
 * (Moved from `src/cli/doctor.js`, whose docblock carries the full argument
 * for which harnesses get a row.)
 */
export function harnessTargets({ home = '', project = '' } = {}) {
  const dirs = { home, project };
  // `cordis`: dsh's YAML patch layers, read by LINE-SCAN (no YAML parser in
  // this repository — the TOML precedent below). goose's `config.yaml` stays
  // opaque: its entry shape was never line-scanned and is not claimed here.
  const kindFor = (cfg) => (cfg.format === 'json' ? 'json' : cfg.format === 'toml' ? 'toml'
    : (cfg.format === 'yaml' && cfg.shape === 'cordis') ? 'cordis' : 'opaque');
  const rows = [];
  for (const id of listHarnesses()) {
    const a = adapterFor(id);
    if (!a) continue;
    const cfg = a.mcpConfig || null;
    const mcpFiles = cfg
      ? [...resolveTemplates(cfg.user || [], dirs), ...resolveTemplates(cfg.project || [], dirs)]
      : [];
    // One file per sub-folder (dsh's `~/.dsh/profiles/<name>/cordis.patch.yml`),
    // marked `expanded` because no template names it. Read-only: a listing.
    const expanded = [];
    if (cfg?.eachDir) {
      const base = resolveTemplates([cfg.eachDir.dir], dirs)[0];
      let names = [];
      try { names = base ? readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().slice(0, 20) : []; }
      catch { names = []; }
      for (const n of names) expanded.push(path.join(base, n, cfg.eachDir.file));
    }
    if (cfg && mcpFiles.length === 0) continue;
    const kind = cfg ? kindFor(cfg) : 'json';
    const mk = (file, via, extra = {}) => ({
      file, kind, key: cfg?.key || null, via,
      tomlKey: kind === 'toml' ? `[${cfg.key}.${MCP_SERVER_NAME}]` : undefined,
      ...extra,
    });
    const row = {
      id: a.id,
      label: a.label,
      mcp: [...mcpFiles.map((f) => mk(f, 'own')), ...expanded.map((f) => mk(f, 'own', { expanded: true }))],
      // Read for this row, never written for it (see the adapter's note).
      mcpAlso: cfg ? resolveTemplates(cfg.readAlso || [], dirs).map((f) => mk(f, 'readAlso')) : [],
      projectsKey: cfg?.projectsKey || null,
      hooks: ['user', 'project', 'local']
        .flatMap((scope) => resolveTemplates(a.hooks?.configPath?.[scope] || [], dirs)
          .map((file) => ({ file, scope, kind: path.extname(file) ? 'json' : 'dir' }))),
      instructions: (a.instructionFile?.names || []).map((name) => {
        const rec = { file: project ? path.join(project, name) : null, name };
        if (a.instructionFile.cap) rec.maxBytes = a.instructionFile.cap;
        if (a.instructionFile.fromSetting) rec.fromSetting = a.instructionFile.fromSetting;
        return rec;
      }).filter((r) => r.file),
    };
    if (a.instructionFile?.firstMatch) row.firstMatch = true;
    if (!cfg) row.noMcpClient = true;
    rows.push(row);
  }
  return rows;
}

/** Our own entry in a parsed config object, or null. */
function ourEntry(json, key) {
  const servers = json && typeof json === 'object' ? json[key] : null;
  const e = servers && typeof servers === 'object' ? servers[MCP_SERVER_NAME] : undefined;
  return e && typeof e === 'object' ? e : null;
}

function entryFacts(entry) {
  // `command` is a string (command+args) or an ARRAY (opencode's single-array).
  let command = null;
  let args = [];
  if (Array.isArray(entry.command)) {
    command = typeof entry.command[0] === 'string' ? entry.command[0] : null;
    args = entry.command.slice(1).filter((x) => typeof x === 'string');
  } else {
    command = typeof entry.command === 'string' ? entry.command : null;
    args = Array.isArray(entry.args) ? entry.args.filter((x) => typeof x === 'string') : [];
  }
  const i = args.indexOf('--domains-path');
  // OUR entry's server script (`<install>/mcp/server.js`) — which Curator
  // install this tool launches, so the Setup check can find that install's
  // machine id on this Mac (v3.78.0). Our own entry's argument, never another's.
  const serverScript = args.find((x) => /(^|\/)mcp\/server\.js$/.test(x)) || null;
  return { command, domainsPath: i !== -1 && typeof args[i + 1] === 'string' ? args[i + 1] : null, serverScript };
}

/** The line a Cordis patch carries for our server — `serverName: my-curator`, quoted or not, not commented. */
const CORDIS_SERVER_RE = new RegExp(`^\\s*serverName:\\s*(["']?)${MCP_SERVER_NAME}\\1\\s*(#.*)?$`);

/**
 * Does this config file name the my-curator server, and where does it point?
 * `opts.repo` (absolute) additionally reads `<projectsKey>[repo][key]` —
 * Claude Code's local-scope entries in ~/.claude.json.
 */
export function inspectMcpFile(target, opts = {}) {
  if (target.kind === 'toml' || target.kind === 'cordis') {
    // LINE-SCAN (no TOML or YAML parser in this repository): a malformed file
    // cannot be detected, so `invalid` is never reported here — only missing,
    // unopenable, empty, or read.
    const r = readForCheck(target.file);
    if (r.status === 'missing') return { present: false, status: 'missing' };
    if (r.status === 'unopenable') return { present: true, status: 'unopenable', readError: r.readError };
    if (r.status === 'empty') return { present: true, status: 'empty', parseError: 'the file is empty', bytes: r.bytes };
    const lines = r.text.split('\n');
    const named = target.kind === 'toml'
      ? lines.some((l) => l.trim().startsWith(target.tomlKey))
      : lines.some((l) => CORDIS_SERVER_RE.test(l));
    return {
      present: true, status: 'ok', named,
      scan: `line-scan (no ${target.kind === 'toml' ? 'TOML' : 'YAML'} parser — a malformed file cannot be detected)`,
    };
  }
  if (target.kind === 'dir') {
    try { return { present: existsSync(target.file) && statSync(target.file).isDirectory() }; }
    catch { return { present: false }; }
  }
  if (target.kind === 'opaque') {
    const present = existsSync(target.file);
    return { present, status: present ? 'ok' : 'missing', opaque: true };
  }
  const r = readJsonFile(target.file);
  if (!r.present || r.status !== 'ok') {
    const { json, ...rest } = r;
    return rest;
  }
  let entry = ourEntry(r.json, target.key);
  let at = entry ? 'top' : null;
  if (!entry && opts.projectsKey && opts.repo && r.json && typeof r.json[opts.projectsKey] === 'object') {
    const p = r.json[opts.projectsKey][opts.repo];
    const e = p && typeof p === 'object' ? ourEntry(p, target.key) : null;
    if (e) { entry = e; at = 'project'; }
  }
  const base = { present: true, status: 'ok', ...(r.jsonc ? { jsonc: true } : {}) };
  if (!entry) return { ...base, named: false };
  return { ...base, named: true, at, ...entryFacts(entry) };
}

/** A Curator hook command, in any form install-hooks writes. */
export const OUR_HOOK_RE = /curator(?:\.js)?['"]?\s+hook\s/;

/** Curator hook entries in a harness hook file, plus the accepted-and-inert ones. */
export function inspectHookFile(harnessId, file) {
  const r = readJsonFile(file);
  if (!r.present || r.status !== 'ok') { const { json, ...rest } = r; return rest; }
  const text = JSON.stringify(r.json);
  const ours = OUR_HOOK_RE.test(text);
  const events = [];
  const inert = [];
  const spec = adapterFor(harnessId)?.hooks;
  if (spec?.fileShape === 'named-hooks') {
    const doc = r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? r.json : {};
    for (const [name, hook] of Object.entries(doc)) {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) continue;
      const mine = OUR_HOOK_RE.test(JSON.stringify(hook));
      for (const k of Object.keys(hook)) if (k !== 'enabled' && !events.includes(k) && mine) events.push(k);
      if (hook.enabled === false && mine) {
        inert.push(`"${name}" — this named hook is switched off (\`"enabled": false\`), so its Curator handlers never run`);
      }
    }
    return { present: true, ours, events, inert };
  }
  const hooks = r.json?.hooks && typeof r.json.hooks === 'object' ? r.json.hooks : r.json;
  if (hooks && typeof hooks === 'object') for (const k of Object.keys(hooks)) events.push(k);
  if (harnessId === 'cline' && events.some((e) => /precompact/i.test(e))) {
    inert.push('PreCompact — Cline accepts this hook and maps it to `undefined`, so it NEVER fires');
  }
  if (harnessId === 'codex' && events.some((e) => /sessionend/i.test(e))) {
    inert.push('SessionEnd — Codex allows 1 s by default and 3 s at most, which cannot complete an MCP round trip');
  }
  return { present: true, ours, events, inert };
}

// ─────────────────────────────────────────────────────────────────────────
// Skills
// ─────────────────────────────────────────────────────────────────────────

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The shipped skills, file by file: `{skill: {file: sha256}}`, or null when
 * this install carries no `skills/` folder (a DMG before v3.77.0).
 */
export function repoSkillHashes(skillsDir) {
  if (!skillsDir) return null;
  const out = {};
  for (const name of SKILL_NAMES) {
    const dir = path.join(skillsDir, name);
    let files;
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return null; }
    out[name] = Object.fromEntries(files.map((f) => [f, sha256(readFileSync(path.join(dir, f)))]));
  }
  return out;
}

/** Every installed copy under the roots, compared file by file. */
export function inspectSkills(roots, repo) {
  const found = [];
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'skills'));
    let plugins = [];
    try { plugins = readdirSync(path.join(root, 'plugins')).sort(); } catch { plugins = []; }
    for (const p of plugins) candidates.push(path.join(root, 'plugins', p, 'skills'));
  }
  for (const dir of candidates) {
    for (const name of SKILL_NAMES) {
      const at = path.join(dir, name);
      try { if (!statSync(at).isDirectory()) continue; } catch { continue; }
      const rec = { skill: name, dir: at, match: null, differs: [], missing: [] };
      if (repo && repo[name]) {
        for (const [f, h] of Object.entries(repo[name])) {
          let got = null;
          try { got = sha256(readFileSync(path.join(at, f))); } catch { got = null; }
          if (got === null) rec.missing.push(f);
          else if (got !== h) rec.differs.push(f);
        }
        rec.match = rec.differs.length === 0 && rec.missing.length === 0;
      }
      found.push(rec);
    }
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────
// The instruction block, the marker, git
// ─────────────────────────────────────────────────────────────────────────

/** The block's first line, as composed — where a block STARTS in a file. */
const BLOCK_LEAD = "This repository's working state lives in The Curator";
/** "At the top" = the block starts within this many bytes of the file start. */
export const AT_TOP_BYTES = 2048;

/**
 * One instruction file against the CURRENT block for this project.
 * `template` is paragraph 1 as shipped (`TEMPLATE` in
 * `src/public/next/shared/agent-instructions.js`), passed in so a suite can
 * drive it and so this module needs no second copy of model-read text.
 */
export function inspectInstructionFile(file, { domain, project, template, cap = null } = {}) {
  const rec = { file, present: false, bytes: 0, hasBlock: false, current: false, namesProject: null, wrongProject: false, atTop: false, overCap: false, blockPastCap: false };
  let text;
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return rec;
    text = readFileSync(file, 'utf8');
  } catch { return rec; }
  rec.present = true;
  rec.bytes = Buffer.byteLength(text);
  const norm = text.replace(/\r\n/g, '\n');
  // A Curator block of ANY era: the lead sentence every version has carried,
  // or the save tool beside a read tool. The v3.72-v3.74 blocks call
  // `get_working_state`, not `get_project_context` — requiring the newer
  // name read an OLD block as "no block" instead of "outdated".
  rec.hasBlock = norm.replace(/\s+/g, ' ').includes(BLOCK_LEAD)
    || (norm.includes('save_working_state') && (norm.includes('get_project_context') || norm.includes('get_working_state')));
  if (!rec.hasBlock) return rec;
  // The lead may itself be re-wrapped: find it with any whitespace between words.
  const leadRe = new RegExp(BLOCK_LEAD.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
  const lm = leadRe.exec(norm);
  const start = lm ? lm.index : -1;
  const m = /The Curator \(project `([^`]{1,200})`/.exec(norm);
  rec.namesProject = m ? m[1] : null;
  rec.wrongProject = !!(rec.namesProject && domain && project && rec.namesProject !== `${domain}/${project}`);
  if (typeof template === 'string' && domain && project) {
    const body = template.split('{{DOMAIN_PROJECT}}').join(`${domain}/${project}`).split('{{PROJECT}}').join(project);
    // WHITESPACE-INSENSITIVE, WORD-EXACT (v3.77.0 screen review): an owner's
    // paste or editor re-wraps the block's lines, and a block identical in
    // every word but wrapped differently IS the current text. Runs of
    // whitespace (newlines included) collapse to one space on both sides;
    // every other character must match exactly, so a block that differs in
    // a single word is still "not current".
    const ws = (s) => s.replace(/\s+/g, ' ').trim();
    rec.current = ws(norm).includes(ws(body));
  }
  if (start !== -1) {
    const startBytes = Buffer.byteLength(norm.slice(0, start));
    rec.atTop = startBytes <= AT_TOP_BYTES;
    if (cap) rec.blockPastCap = startBytes + 1200 > cap;
  }
  if (cap && rec.bytes > cap) rec.overCap = true;
  return rec;
}

/** Run git read-only in `cwd`. Never throws; resolves `{ok, out}`. */
export function gitRead(cwd, args, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile('git', args, {
        cwd, timeout: timeoutMs, maxBuffer: 256 * 1024,
        // Never take index.lock while the user is committing.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      }, (err, stdout) => resolve(err ? { ok: false, out: '', code: err.code ?? null } : { ok: true, out: String(stdout) }));
    } catch { resolve({ ok: false, out: '' }); }
  });
}

/**
 * The `.curator-project` marker at the repository root: present, what it names,
 * and — read-only git, NO fetch — tracked, uncommitted, unpushed.
 */
/**
 * The `.curator-project` marker in `dir`, read without git: `{present, line,
 * namesThis}`. Synchronous and cheap, so a candidate scan can ask it of many
 * folders. Unreadable reads as absent.
 */
export function readMarkerLine(dir, { domain, project } = {}) {
  const rec = { present: false, line: null, namesThis: false };
  try {
    const file = path.join(dir, '.curator-project');
    if (existsSync(file) && statSync(file).isFile()) {
      rec.present = true;
      const text = readFileSync(file, 'utf8').slice(0, 1024);
      rec.line = (text.split('\n').map((s) => s.trim()).find(Boolean) || '').slice(0, 200) || null;
      const names = new Set(domain === project ? [domain, `${domain}/${domain}`] : [project, `${domain}/${project}`]);
      rec.namesThis = !!(rec.line && names.has(rec.line));
    }
  } catch { return { present: false, line: null, namesThis: false }; }
  return rec;
}

export async function inspectMarker(repo, { domain, project, git = gitRead } = {}) {
  const file = path.join(repo, '.curator-project');
  const rec = { file, ...readMarkerLine(repo, { domain, project }), git: null };
  const inside = await git(repo, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out.trim() !== 'true') { rec.git = { repo: false }; return rec; }
  rec.git = { repo: true, tracked: null, uncommitted: null, unpushed: null, upstream: null };
  if (!rec.present) return rec;
  const tracked = await git(repo, ['ls-files', '--error-unmatch', '--', '.curator-project']);
  rec.git.tracked = tracked.ok;
  const st = await git(repo, ['status', '--porcelain', '--', '.curator-project']);
  rec.git.uncommitted = st.ok ? st.out.trim().length > 0 : null;
  const up = await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up.ok && up.out.trim()) {
    rec.git.upstream = up.out.trim().slice(0, 200);
    const ahead = await git(repo, ['rev-list', '@{u}..HEAD', '--', '.curator-project']);
    rec.git.unpushed = ahead.ok ? ahead.out.trim().length > 0 : null;
  }
  return rec;
}

// ─────────────────────────────────────────────────────────────────────────
// Where is this project checked out here? (v3.78.0)
// ─────────────────────────────────────────────────────────────────────────

export const REPO_CANDIDATE_MAX = 5;
const REPO_WHY_TEXT = Object.freeze({
  'claude-code': 'Claude Code has opened this folder, and its .curator-project names this project.',
  foundations: 'This project’s foundation documents were read from this folder, and its .curator-project names this project.',
  'hook-log': 'A Curator hook started a session for this project in this folder.',
  'git-remote': 'Its git remote is the GitHub repository this project’s foundations mirror (it has no .curator-project for this project yet).',
});

/** `owner/repo` of a folder's `origin`, read from `.git/config` — no subprocess, no fetch. */
export function originRepoOf(dir) {
  try {
    const cfg = path.join(dir, '.git', 'config');
    if (!existsSync(cfg) || !statSync(cfg).isFile()) return null;
    const text = readFileSync(cfg, 'utf8').slice(0, 64 * 1024);
    const sec = /\[remote\s+"origin"\]([^[]*)/.exec(text);
    const url = sec ? /^\s*url\s*=\s*(\S+)\s*$/m.exec(sec[1]) : null;
    const m = url ? /github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(url[1]) : null;
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
  } catch { return null; }
}

/**
 * Folders on THIS computer that are probably this project's checkout.
 *
 * PRIVACY — the inputs name OTHER folders (~/.claude.json's `projects` keys
 * are every folder Claude Code has opened). A path leaves this function only
 * when it exists here, sits under `home`, and either its `.curator-project`
 * names this project or (`git-remote`) its origin is a GitHub repository this
 * project's foundations mirror. Nothing else about any input is returned.
 *
 * @param {object} o
 *   home, domain, project
 *   sources   — `[{path, why}]` in detection order: claude-code, foundations, hook-log
 *   githubRepos — `owner/repo` strings from the project's foundation sources
 * @returns {Array<{path, display, why, whyText}>} at most REPO_CANDIDATE_MAX
 */
export function findRepoCandidates({ home, domain, project, sources = [], githubRepos = [] }) {
  const out = [];
  const seen = new Set();
  const remotes = new Set((githubRepos || []).filter((x) => typeof x === 'string').map((x) => x.toLowerCase()));
  const later = [];
  if (!home) return out;
  const usable = (p) => {
    if (typeof p !== 'string' || !p.startsWith('/') || p.length > 1024 || p.includes('\0')) return null;
    const r = path.resolve(p);
    if (!r.startsWith(`${home}/`)) return null;
    try { if (!statSync(r).isDirectory()) return null; } catch { return null; }
    return r;
  };
  for (const s of sources) {
    if (out.length >= REPO_CANDIDATE_MAX) break;
    const p = usable(s && s.path);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const mk = readMarkerLine(p, { domain, project });
    if (mk.namesThis) out.push({ path: p, display: tildeUnder(home, p), why: s.why, whyText: REPO_WHY_TEXT[s.why] || '' });
    else if (!mk.present && remotes.size) later.push(p);
  }
  // A folder with NO marker whose origin is the mirrored repository. One with
  // a marker naming ANOTHER project is never offered: it is that project's.
  for (const p of later) {
    if (out.length >= REPO_CANDIDATE_MAX) break;
    const o = originRepoOf(p);
    if (o && remotes.has(o)) out.push({ path: p, display: tildeUnder(home, p), why: 'git-remote', whyText: REPO_WHY_TEXT['git-remote'] });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// This machine
// ─────────────────────────────────────────────────────────────────────────

/**
 * Per harness, what this machine's files say — bridge, skills, hooks.
 * `repo` (absolute or '') adds the project-level files. Pure over the
 * filesystem it is pointed at: `home` is a parameter, never `os.homedir()`.
 *
 * @param {{home: string, repo?: string, skillsDir?: string|null,
 *          domainsDir?: string|null, hookSummary?: object}} o
 */
export function collectMachineSetup(o = {}) {
  const home = o.home || '';
  const repo = o.repo || '';
  const repoSkills = o.repoSkills !== undefined ? o.repoSkills : (() => {
    try { return repoSkillHashes(o.skillsDir); } catch { return null; }
  })();
  const hookSummary = o.hookSummary || {};
  const out = [];
  for (const t of harnessTargets({ home, project: repo })) {
    const a = adapterFor(t.id);
    const files = [];
    for (const m of [...t.mcp, ...t.mcpAlso]) {
      const r = inspectMcpFile(m, { projectsKey: m.via === 'own' ? t.projectsKey : null, repo });
      const status = r.status || (r.present ? 'ok' : 'missing');
      const rec = { file: m.file, display: tildeUnder(home, m.file), via: m.via, present: !!r.present, named: r.named === true, status };
      if (m.expanded) rec.expanded = true;
      if (r.jsonc) rec.jsonc = true;
      if (status === 'invalid' || status === 'empty') rec.parseError = true;
      if (status === 'unopenable') rec.unopenable = true;
      if (r.opaque) rec.opaque = true;
      if (r.scan) rec.lineScan = true;
      if (r.at) rec.at = r.at;
      if (r.named) {
        if (r.domainsPath && o.domainsDir && r.domainsPath !== o.domainsDir) rec.otherFolder = true;
        if (r.command && r.command.startsWith('/') && !existsSync(r.command)) rec.commandMissing = true;
        rec.command = r.command || null;
        if (r.serverScript) rec.serverScript = r.serverScript;
      }
      files.push(rec);
    }
    const own = files.filter((f) => f.via === 'own');
    const namedOwn = own.filter((f) => f.named);
    const namedAlso = files.filter((f) => f.via === 'readAlso' && f.named);
    // A file that could not tell us anything (v3.78.0). It flags the tool ONLY
    // when no file of this tool names my-curator: beside a working file it is
    // a note, because the tool demonstrably has its entry. Measured
    // 2026-09-28 — a 0-byte ~/.gemini/antigravity/mcp_config.json beside a
    // working ~/.gemini/config/mcp_config.json turned Antigravity red.
    const bad = files.filter((f) => BAD_FILE_STATES.has(f.status));
    const anyNamed = files.some((f) => f.named);
    let bridge;
    if (t.noMcpClient) bridge = { state: STATES.NONE, word: 'no MCP client' };
    else if (bad.length && !anyNamed) {
      const b = bad[0];
      bridge = {
        state: STATES.FIX,
        word: `${b.display} ${BAD_FILE_WORDS[b.status]}`,
        badFile: { file: b.file, display: b.display, status: b.status },
      };
    } else if (namedOwn.some((f) => f.otherFolder || f.commandMissing)) {
      bridge = { state: STATES.FIX, word: namedOwn.some((f) => f.commandMissing) ? 'launch line points at a missing file' : 'reads a different knowledge folder' };
    } else if (namedOwn.length) {
      // Only files that were READ count: an empty or unopenable file is a
      // note below, never "not in 1 of 2 files".
      const presentOwn = own.filter((f) => f.present && !f.opaque && f.status === 'ok');
      const userOwn = own.filter((f) => f.present && f.status === 'ok');
      const notIn = userOwn.filter((f) => !f.named && t.id === 'antigravity');
      bridge = notIn.length
        ? { state: STATES.FIX, word: `not in ${notIn.length} of ${userOwn.length} files` }
        : { state: STATES.OK, word: 'configured', count: `${namedOwn.length} of ${presentOwn.length || namedOwn.length} file${(presentOwn.length || namedOwn.length) === 1 ? '' : 's'}` };
    } else if (namedAlso.some((f) => f.otherFolder || f.commandMissing)) {
      bridge = { state: STATES.FIX, via: 'readAlso', word: namedAlso.some((f) => f.commandMissing) ? 'launch line points at a missing file' : 'reads a different knowledge folder' };
    } else if (namedAlso.length) {
      // The short form on the cell; the dated observation itself rides on
      // the file row (`readAlsoNote`), where Settings prints it in full.
      bridge = { state: STATES.OK, word: 'configured', via: 'readAlso', note: 'found only in Claude Desktop’s config — observed working that way (2026-09-26)', observation: a?.mcpConfig?.readAlsoNote || null };
    } else if (own.some((f) => f.opaque && f.present)) {
      bridge = { state: STATES.CANT, word: 'config present, format not read' };
    } else {
      bridge = { state: STATES.NONE, word: own.some((f) => f.present) ? 'no entry found' : 'no config file found' };
    }
    // The bad files that did NOT flag the tool, as notes for the reader.
    if (bad.length && bridge.state !== STATES.FIX && !t.noMcpClient) {
      bridge.fileNotes = bad.map((b) => ({
        file: b.file, display: b.display, status: b.status,
        text: `${b.display} ${BAD_FILE_WORDS[b.status]} — not used; ${anyNamed ? 'another file names my-curator' : 'nothing depends on it'}.`,
      }));
    }

    // Skills
    const roots = skillRootsFor(t.id, { home, project: repo });
    const accountHeld = a?.skillsTree?.accountHeld === true;
    const installed = roots.length ? inspectSkills(roots, repoSkills) : [];
    let skills;
    const haveBoth = SKILL_NAMES.every((n) => installed.some((s) => s.skill === n));
    const stale = installed.filter((s) => s.match === false);
    if (installed.length && repoSkills === null) skills = { state: STATES.CANT, word: 'installed · this app carries no copy to compare' };
    else if (stale.length) skills = { state: STATES.FIX, word: `${stale.map((s) => s.skill).join(', ')} outdated` };
    else if (installed.length && haveBoth) skills = { state: STATES.OK, word: `${SKILL_NAMES.length} of ${SKILL_NAMES.length} current` };
    else if (installed.length) skills = { state: STATES.FIX, word: `${SKILL_NAMES.filter((n) => !installed.some((s) => s.skill === n)).join(', ')} missing` };
    else if (accountHeld) skills = { state: STATES.CANT, word: 'can’t check here', note: 'held by your Claude account' };
    else if (!roots.length) skills = { state: STATES.CANT, word: 'can’t check here', note: 'no known skill folder for this tool' };
    else skills = { state: STATES.NONE, word: 'not installed' };
    skills.roots = roots;
    skills.installed = installed;

    // Hooks
    const hookFiles = t.hooks.filter((h) => h.kind === 'json').map((h) => {
      const r = inspectHookFile(t.id, h.file);
      const rec = { file: h.file, scope: h.scope, present: !!r.present, ours: r.ours === true };
      if (r.parseError) rec.parseError = true;
      if (r.inert?.length) rec.inert = r.inert;
      const obs = a?.hooks?.scopeObservations?.[h.scope];
      if (obs) rec.observation = obs;
      return rec;
    });
    const wired = hookFiles.filter((h) => h.ours && !(h.inert && h.inert.length));
    // The scope whose injection was SEEN used (Antigravity's project file,
    // 2026-09-26). A tool with such a record and hooks wired only elsewhere is
    // "wired, not seen working" — never "to fix", because nothing proved the
    // other file is ignored.
    const provenScope = a?.hooks?.scopeObservations
      ? Object.keys(a.hooks.scopeObservations).find((s) => /was used/.test(a.hooks.scopeObservations[s])) : null;
    const format = a?.hooks?.state || 'none';
    let hooks;
    if (format === 'none' || format === 'present-useless') hooks = { state: STATES.NONE, word: format === 'none' ? 'no hook mechanism' : 'hooks cannot carry the ask' };
    else if (wired.length && provenScope && !wired.some((h) => h.scope === provenScope)) {
      hooks = { state: STATES.UNMEASURED, word: `wired in the ${wired.map((h) => h.scope).join(' + ')} file only · not seen working`, note: wired.map((h) => h.observation).filter(Boolean).join(' ') || null, suggestScope: provenScope };
    } else if (wired.length) hooks = { state: a?.measured ? STATES.OK : STATES.UNMEASURED, word: a?.measured ? 'wired' : 'wired · unmeasured' };
    else hooks = { state: STATES.NONE, word: 'not wired (optional)' };
    hooks.format = format;
    hooks.files = hookFiles;
    const ev = hookSummary[t.id] || null;
    hooks.evidence = ev ? { start: ev.start || null, stop: ev.stop || null } : null;

    out.push({
      id: t.id, label: t.label, bridge, skills, hooks, files,
      configured: bridge.state === STATES.OK,
      instructionNames: (a?.instructionFile?.names || []).slice(),
      instructionCap: a?.instructionFile?.cap || null,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// One project
// ─────────────────────────────────────────────────────────────────────────

/** The ids a scope NAMED for a tool would carry — the collision set. */
function toolScopeIds() {
  return new Set(['main', ...listHarnesses()]);
}

/** A pair's harness label → `{id, label}` or null. */
function toolOf(label) {
  const n = normaliseHarness(typeof label === 'string' ? label : '');
  return n ? { id: n.id, label: adapterFor(n.id)?.label || n.label } : null;
}

/**
 * The machine segment of an incoming state path for this project, or null.
 * `<domain>/state/<project>/<scope>/<machine>/…` for a named project;
 * `<domain>/state/<scope>/<machine>/…` for the domain's own.
 */
export function incomingMachine(relPath, domain, project) {
  const segs = String(relPath || '').split('/').filter(Boolean);
  if (segs[0] !== domain || segs[1] !== 'state') return null;
  if (domain !== project) {
    if (segs[2] !== project || segs.length < 6) return null;
    return segs[3] === 'foundations' ? null : segs[4];
  }
  if (segs.length < 5 || segs[2] === 'foundations') return null;
  return segs[3];
}

/**
 * Everything the Context step shows for one project.
 *
 * @param {object} o
 *   domain, project
 *   pairs        — `listWorkingScopes(..., {withSaveTimes:true}).scopes`
 *   machine      — `{ids: string[], installIds?: string[], installs?: [{installId, kind}]}`
 *                  — every machine id and installation id found on THIS computer
 *   machineRows  — `collectMachineSetup({home, repo})` for this project's repo
 *   repo         — `{path, source}` or null
 *   marker       — `inspectMarker()` result or null
 *   template     — paragraph 1 of the agent-instructions block
 *   addedTools   — ids the user added here
 *   customTools  — `[{id, label}]` tools the user named that no adapter knows
 *   sync         — `{configured, lastSyncAt, pending, incoming: string[]|null, checkedAt}`
 *   thisVersion  — this app's version
 */
export function collectProjectSetup(o) {
  const { domain, project } = o;
  const pairs = Array.isArray(o.pairs) ? o.pairs : [];
  const hereIds = new Set(o.machine?.ids || []);
  const hereInstalls = new Set(o.machine?.installIds || []);
  for (const id of hereIds) { const i = installIdOf(id); if (i) hereInstalls.add(i); }
  // THIS COMPUTER, by installation id as well as by exact name (v3.78.0):
  // `mac-17d23c` and `talis-macbook-pro-17d23c` are one install (D10), and an
  // exact-name comparison called one of them another computer. The id-less
  // guard is tray-summary's: a bare hostname has no install id and matches
  // only exactly.
  const isHere = (name) => {
    if (typeof name !== 'string' || !name) return false;
    if (hereIds.has(name)) return true;
    const i = installIdOf(name);
    return i !== null && hereInstalls.has(i);
  };
  const machineRows = Array.isArray(o.machineRows) ? o.machineRows : [];
  const byId = new Map(machineRows.map((r) => [r.id, r]));
  const repoPath = o.repo?.path || null;
  const toFix = [];
  const custom = new Map((Array.isArray(o.customTools) ? o.customTools : [])
    .filter((c) => c && typeof c.id === 'string' && c.id && !adapterFor(c.id))
    .map((c) => [c.id, c.label || c.id]));

  // ── Evidence: saves by tool ────────────────────────────────────────────
  const saved = new Map();   // tool id → newest pair info
  for (const p of pairs) {
    const t = toolOf(p.harness);
    if (!t) continue;
    const at = p.writtenAt || p.lastWriteAt || null;
    const cur = saved.get(t.id);
    if (!cur || Date.parse(at) > Date.parse(cur.at)) {
      saved.set(t.id, { tool: t, at, scope: p.scope, machine: p.machine, thisMachine: isHere(p.machine), curator: p.curator || null });
    }
  }

  // ── Which tools get a row ──────────────────────────────────────────────
  const ids = new Set([...saved.keys()]);
  for (const id of o.addedTools || []) if (adapterFor(id)) ids.add(id);
  for (const id of custom.keys()) ids.add(id);
  for (const r of machineRows) {
    if (r.configured && r.instructionNames.length) ids.add(r.id);
  }

  const collision = toolScopeIds();
  const tools = [];
  for (const id of ids) {
    const a = adapterFor(id);
    const m = byId.get(id) || null;
    const s = saved.get(id) || null;
    const label = a?.label || s?.tool.label || custom.get(id) || id;
    const row = { id, label, known: !!a };
    const evidence = [];
    if (!a) {
      // A tool no adapter knows — named by the user or seen only in a save.
      // Everything said about it is the generic convention, and says so.
      row.custom = true;
      row.userAdded = custom.has(id);
      row.instructionFile = 'AGENTS.md';
    }

    // Saved
    if (s) {
      const own = s.scope === id;
      const wrong = !own && collision.has(s.scope);
      row.saved = { state: wrong ? STATES.FIX : STATES.OK, at: s.at, scope: s.scope, machine: s.machine, thisMachine: s.thisMachine, ownScope: own, wrongScope: wrong, curator: s.curator };
      if (wrong) {
        toFix.push({
          tool: id, kind: 'wrong-scope',
          text: `${label} saved under “${s.scope}”, not “${id}”.`,
          detail: `A tool saving under ${s.scope === 'main' ? 'the shared “main”' : `another tool’s scope`} replaces that handoff. The current agent instructions tell each tool to save under its own name.`,
          fix: { kind: 'copy-block' },
        });
      }
      evidence.push({ heading: 'Saved', lines: [
        `Newest save ${s.at || '(time not recorded)'} under “${s.scope}”${own ? ' — its own scope' : wrong ? ' — not its own scope' : ''}.`,
        s.thisMachine ? 'Made from this computer.' : `Made from ${s.machine || 'another computer'}.`,
        ...(s.curator ? [`Saved with The Curator ${s.curator}.`] : []),
      ] });
    } else {
      row.saved = { state: STATES.NONE, at: null };
      evidence.push({ heading: 'Saved', lines: [`${label} has not saved to this project yet. A tool is ready only once it has saved from this computer under its own name.`] });
    }

    // Bridge (this machine), with evidence overriding an absent entry
    if (!m) row.bridge = { state: STATES.CANT, word: a ? 'this tool has no config file The Curator knows' : 'config location not known — copy the entry by hand' };
    else if (m.bridge.state === STATES.NONE && s && s.thisMachine) {
      row.bridge = { state: STATES.OK, word: 'working', note: 'entry not found in the files read — a save from this computer proves it works' };
    } else row.bridge = { ...m.bridge };
    if (a && a.mcpConfig && a.mcpConfig.verified !== true && row.bridge.state !== STATES.OK) {
      row.bridge.note = row.bridge.note || 'config location not measured — copy the entry by hand';
    }
    if (m && m.bridge.state === STATES.FIX) {
      const b = m.bridge.badFile;
      if (b) {
        const base = path.basename(b.file);
        toFix.push({
          tool: id, kind: 'bridge-file', status: b.status,
          text: `${label}: ${b.display} ${BAD_FILE_WORDS[b.status]}.`,
          detail: badFileDetail(id, label, b.status),
          fix: { kind: 'reveal', path: b.file, label: `Reveal ${base}` },
        });
      } else {
        toFix.push({ tool: id, kind: 'bridge', text: `${label}: ${m.bridge.word}.`, detail: 'See Settings › MCP bridge › Tools on this Mac for the file.', fix: { kind: 'settings' } });
      }
    }
    {
      const lines = [row.bridge.word + (row.bridge.note ? ` — ${row.bridge.note}` : '')];
      let reveal = null;
      for (const f of m?.files || []) {
        const where = f.via === 'readAlso' ? ' (read for this tool; another app owns it)' : '';
        let what;
        if (f.status === 'missing') what = 'not found';
        else if (BAD_FILE_STATES.has(f.status)) what = BAD_FILE_WORDS[f.status];
        else if (f.opaque) what = 'present — format not read';
        else if (f.named) what = `names my-curator${f.at === 'project' ? ' (for this repository)' : ''}${f.otherFolder ? ' — but reads a different knowledge folder' : ''}${f.commandMissing ? ' — but its launch file is missing' : ''}`;
        else what = 'present, no my-curator entry';
        lines.push(`${f.display || f.file}: ${what}${where}.`);
        if (!reveal && (f.named || BAD_FILE_STATES.has(f.status))) reveal = f.file;
      }
      for (const n of m?.bridge?.fileNotes || []) lines.push(n.text);
      if (m?.bridge?.observation) lines.push(m.bridge.observation);
      if (m?.bridge?.badFile) reveal = m.bridge.badFile.file;
      if (a?.mcpConfig?.note) lines.push(a.mcpConfig.note);
      evidence.push({ heading: 'MCP bridge', lines, ...(reveal ? { reveal } : {}) });
    }

    // Skills
    row.skills = m ? { state: m.skills.state, word: m.skills.word, note: m.skills.note || null } : { state: STATES.CANT, word: 'can’t check here' };
    if (m && m.skills.state === STATES.FIX) {
      toFix.push({ tool: id, kind: 'skills', text: `${label}: ${m.skills.word}.`, detail: 'Replace the installed skill folders with the current copy this app carries.', fix: { kind: 'skills' } });
    }
    {
      const lines = [row.skills.word + (row.skills.note ? ` — ${row.skills.note}` : '')];
      let reveal = null;
      for (const sk of m?.skills?.installed || []) {
        lines.push(`${sk.skill} at ${tildeUnder(o.home || '', sk.dir)}: ${sk.match === true ? 'current' : sk.match === false ? `outdated${sk.differs.length ? ` (differs: ${sk.differs.join(', ')})` : ''}${sk.missing.length ? ` (missing: ${sk.missing.join(', ')})` : ''}` : 'not compared'}.`);
        if (!reveal) reveal = sk.dir;
      }
      if (!m?.skills?.installed?.length && m?.skills?.roots?.length) lines.push(`Looked in: ${m.skills.roots.map((r) => tildeUnder(o.home || '', r)).join(', ')}.`);
      if (!a) lines.push('Where this tool keeps skills is not known; download the skill .zip files and install them the way the tool documents.');
      evidence.push({ heading: 'Skills', lines, ...(reveal ? { reveal } : {}) });
    }

    // Block
    const names = a ? (a.instructionFile?.names || []) : ['AGENTS.md'];
    if (!names.length) row.block = { state: STATES.NONE, word: 'reads no instruction file' };
    else if (!repoPath) row.block = { state: STATES.NOT_CHECKED, word: 'not checked', note: 'no repository set on this computer' };
    else {
      const files = names.map((n) => inspectInstructionFile(path.join(repoPath, n), {
        domain, project, template: o.template, cap: a?.instructionFile?.cap || null,
      }));
      const withBlock = files.filter((f) => f.hasBlock);
      const best = withBlock.find((f) => f.current && !f.wrongProject) || withBlock[0] || null;
      row.block = { files: files.map((f) => ({ name: path.basename(f.file), present: f.present, hasBlock: f.hasBlock, current: f.current, wrongProject: f.wrongProject, namesProject: f.namesProject, atTop: f.atTop, overCap: f.overCap, bytes: f.bytes })) };
      const fileWord = names.join(' or ');
      if (!a) {
        // An ASSUMPTION (the common convention), so never a to-fix line.
        Object.assign(row.block, best && best.current && !best.wrongProject
          ? { state: STATES.OK, word: 'current in AGENTS.md', note: 'assumed: most tools read AGENTS.md' }
          : { state: STATES.UNMEASURED, word: best ? 'AGENTS.md has an older or other block' : 'AGENTS.md has no Curator block', note: 'which file this tool reads is not known' });
      } else if (!best) {
        Object.assign(row.block, { state: STATES.FIX, word: 'missing', note: `${fileWord} has no Curator block` });
        toFix.push({ tool: id, kind: 'block-missing', file: names[0],
          text: `${names[0]} has no Curator block.`,
          detail: `${label} reads ${fileWord}${names.includes('CLAUDE.md') ? '' : ', not CLAUDE.md'}. Without the block it does not know which project to read, and it may save under “main” and replace another tool’s handoff.`,
          fix: { kind: 'copy-block', reveal: names[0] } });
      } else if (best.wrongProject) {
        Object.assign(row.block, { state: STATES.FIX, word: `names ${best.namesProject}`, note: path.basename(best.file) });
        toFix.push({ tool: id, kind: 'block-wrong', file: path.basename(best.file), text: `${path.basename(best.file)} names project ${best.namesProject}, not ${domain}/${project}.`, detail: 'Replace the block with the one for this project.', fix: { kind: 'copy-block', reveal: path.basename(best.file) } });
      } else if (!best.current) {
        Object.assign(row.block, { state: STATES.FIX, word: 'outdated', note: path.basename(best.file) });
        toFix.push({ tool: id, kind: 'block-outdated', file: path.basename(best.file), text: `The Curator block in ${path.basename(best.file)} is not the current text.`, detail: 'The current text tells an agent to re-read on “continue” and to save under its own scope. Replace the old block.', fix: { kind: 'copy-block', reveal: path.basename(best.file) } });
      } else if (best.overCap || (a.instructionFile.cap && !best.atTop)) {
        Object.assign(row.block, { state: STATES.FIX, word: `past the ${a.instructionFile.cap.toLocaleString('en-US')}-byte cap`, note: path.basename(best.file) });
        toFix.push({ tool: id, kind: 'block-cap', file: path.basename(best.file), text: `${path.basename(best.file)} is longer than ${label} reads.`, detail: `${label} reads the first ${a.instructionFile.cap.toLocaleString('en-US')} bytes. Move the block to the very top.`, fix: { kind: 'reveal', reveal: path.basename(best.file) } });
      } else {
        Object.assign(row.block, { state: STATES.OK, word: best.atTop ? 'current · at the top' : 'current', note: path.basename(best.file) });
      }
    }
    {
      const lines = [row.block.word + (row.block.note ? ` — ${row.block.note}` : '')];
      if (names.length) lines.push(`${label} reads ${names.join(' and ')}${a?.instructionFile?.firstMatch ? ' (the first one found wins)' : ''}.`);
      for (const f of row.block.files || []) {
        lines.push(`${f.name}: ${!f.present ? 'not in the repository' : !f.hasBlock ? 'no Curator block' : f.wrongProject ? `block names ${f.namesProject}` : f.current ? `current${f.atTop ? ', at the top' : ''}` : 'an older block'}.`);
      }
      const first = (row.block.files || []).find((f) => f.present) || (row.block.files || [])[0];
      evidence.push({ heading: 'Instruction block', lines, ...(repoPath && first ? { reveal: path.join(repoPath, first.name) } : {}) });
    }

    // Hooks (optional — never "to fix" unless wired where it cannot load)
    if (m) {
      row.hooks = {
        state: m.hooks.state, word: m.hooks.word, note: m.hooks.note || null, evidence: m.hooks.evidence,
        suggest: m.hooks.suggestScope ? `my-curator install-hooks ${id} --scope ${m.hooks.suggestScope} --git-exclude` : null,
        files: m.hooks.files.map((f) => ({ file: f.file, scope: f.scope, ours: f.ours, observation: f.observation || null })),
      };
    } else row.hooks = { state: STATES.NONE, word: '—' };
    {
      const lines = [row.hooks.word + (row.hooks.note ? ` — ${row.hooks.note}` : '')];
      let reveal = null;
      for (const f of row.hooks.files || []) {
        lines.push(`${tildeUnder(o.home || '', f.file)} (${f.scope}): ${f.ours ? 'Curator hooks present' : 'no Curator hooks'}${f.observation ? ` — ${f.observation}` : ''}.`);
        if (!reveal && f.ours) reveal = f.file;
      }
      const ev = row.hooks.evidence;
      if (ev?.start) lines.push(`Start hook observed firing ${ev.start.at}.`);
      if (ev?.stop) lines.push(`Stop hook observed firing ${ev.stop.at}${ev.stop.decision === 'ask' ? ' — asked for a save' : ` — did not ask: ${ev.stop.why || 'no reason recorded'}`}.`);
      if (row.hooks.suggest) lines.push(`Suggested: ${row.hooks.suggest}`);
      evidence.push({ heading: 'Hooks', lines, ...(reveal ? { reveal } : {}) });
    }

    // ── One word per tool, and the four parts (v3.78.0) ──────────────────
    row.parts = {
      mcp: { state: row.bridge.state, word: row.bridge.word },
      skills: { state: row.skills.state, word: row.skills.word },
      block: { state: row.block.state, word: row.block.word },
      hooks: { state: row.hooks.state, word: row.hooks.word },
    };
    row.status = toolStatus(row);
    row.evidence = evidence;
    tools.push(row);
  }
  tools.sort((x, y) => (Date.parse(y.saved?.at) || 0) - (Date.parse(x.saved?.at) || 0) || x.label.localeCompare(y.label));

  // ── Repository ─────────────────────────────────────────────────────────
  let repo = null;
  if (o.repo) {
    const mk = o.marker || null;
    repo = { path: o.repo.path, source: o.repo.source, exists: o.repo.exists !== false, marker: mk };
    if (o.repo.exists === false) {
      toFix.push({ kind: 'repo-missing', text: 'The repository folder set for this project is not on this computer.', detail: 'Its checks did not run. Set the folder where it is checked out here.', fix: { kind: 'change-repo' } });
    }
    if (mk) {
      if (!mk.present) {
        toFix.push({ kind: 'marker-missing', text: '.curator-project is not in this checkout.', detail: 'Without it an agent and the hooks cannot tell which project this folder is. If it exists on another computer, it may not be committed there.', fix: { kind: 'copy-marker' } });
      } else if (!mk.namesThis) {
        toFix.push({ kind: 'marker-wrong', text: `.curator-project names “${mk.line}”, not ${domain}/${project}.`, detail: 'Every agent in this folder would open that project instead.', fix: { kind: 'copy-marker' } });
      } else if (mk.git?.repo && (mk.git.tracked === false || mk.git.uncommitted === true)) {
        toFix.push({ kind: 'marker-uncommitted', text: '.curator-project is not committed.', detail: 'A clone on another computer will not know which project it is.', fix: { kind: 'copy-command', command: 'git add .curator-project && git commit -m "Add The Curator project marker"' } });
      } else if (mk.git?.repo && mk.git.unpushed === true) {
        toFix.push({ kind: 'marker-unpushed', text: '.curator-project is committed but not pushed.', detail: 'Another computer will not see it until you push (as of this Mac’s last fetch).', fix: { kind: 'copy-command', command: 'git push' } });
      }
    }
  }

  // ── Computers, grouped by INSTALLATION (v3.78.0) ──────────────────────
  const computers = groupComputers(pairs, { domain, project, isHere, sync: o.sync, installs: o.machine?.installs || [] });
  const waitingTotal = computers.rows.reduce((n, c) => n + (c.thisComputer ? 0 : c.waiting), 0);
  if (waitingTotal) {
    toFix.push({ kind: 'sync-incoming', text: `${waitingTotal === 1 ? 'A newer handoff is' : `${waitingTotal} handoff files are`} waiting on GitHub.`, detail: 'Another computer saved and synced. Sync this Mac before starting, so the agent reads it.', fix: { kind: 'sync' } });
  }

  return {
    domain, project,
    repo,
    tools,
    computers: computers.rows,
    physical: computers.physical,
    sync: o.sync || null,
    toFix,
    counts: {
      toFix: toFix.length,
      tools: tools.length,
      computers: computers.physical.length,
      installs: computers.rows.length,
      machineNames: computers.rows.reduce((n, c) => n + c.names.length, 0),
    },
    thisVersion: o.thisVersion || null,
  };
}

/**
 * One word per tool. `ready` only when it has SAVED, from this computer,
 * under a scope that is not another tool's, and its block is current (or it
 * reads none) — the v3.77.0 rule that a tool turns ok only on evidence.
 */
function toolStatus(row) {
  const cells = [row.saved, row.bridge, row.skills, row.block, row.hooks];
  if (cells.some((c) => c && c.state === STATES.FIX)) return 'to-fix';
  if (!row.saved || row.saved.state !== STATES.OK) return 'no-save';
  const blockOk = row.block.state === STATES.OK || row.block.state === STATES.NONE;
  const bridgeOk = row.bridge.state === STATES.OK;
  return row.saved.thisMachine && blockOk && bridgeOk ? 'ready' : 'partly';
}

/** What to do about a config file that told us nothing — addressed to a person. */
function badFileDetail(id, label, status) {
  if (status === 'empty') {
    return id === 'antigravity'
      ? 'Antigravity writes it on first launch — open Antigravity once, then Re-check. If it stays empty, reveal it and fix or delete it.'
      : `An empty file names no server. Open ${label} once (it may fill the file), then Re-check. If it stays empty, reveal it and add the my-curator entry, or delete it.`;
  }
  if (status === 'invalid') {
    return `It is not valid JSON, so nothing in it can be read — including a my-curator entry — and ${label} may not read it either. Reveal it and fix the syntax (or delete it if it is a leftover), then Re-check.`;
  }
  return 'macOS did not let The Curator open it. Reveal it and check its permissions (or give The Curator access under System Settings › Privacy & Security), then Re-check.';
}

/**
 * The Computers fold: one ROW per installation, and one PHYSICAL group for
 * everything found on this Mac. Pure over its inputs.
 *
 * A row is keyed by the installation id — the trailing id of
 * `<hostname-slug>-<install-id>` (`installIdOf`, tray-summary's rule, never a
 * copy). `mac-17d23c` and `talis-macbook-pro-17d23c` are the same install
 * under two hostname spellings (working-state.js D10), so they are one row
 * with two names. A name with no install id (a pre-D9 bare hostname) is its
 * own row.
 *
 * Every row that is this computer's joins ONE physical group: a Mac app and a
 * source checkout on one laptop are two installs and one computer. Rows of
 * other computers stay one group each — nothing proves two remote installs
 * share hardware, and a hostname is not that proof (it flaps).
 */
export function groupComputers(pairs, { domain, project, isHere, sync, installs = [] }) {
  const rows = new Map();
  const keyOf = (name) => { const i = installIdOf(name); return i ? `install:${i}` : `name:${name}`; };
  const rowFor = (name) => {
    const key = keyOf(name);
    if (!rows.has(key)) {
      const i = installIdOf(name);
      const inst = i ? installs.find((x) => x.installId === i) : null;
      rows.set(key, { key, installId: i, names: new Map(), thisComputer: false, installKind: inst ? inst.kind || null : null, tools: new Set(), newestSaveAt: null, curatorVersion: null, waiting: 0 });
    }
    const r = rows.get(key);
    if (!r.names.has(name)) r.names.set(name, null);
    if (isHere(name)) r.thisComputer = true;
    return r;
  };
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (!p || !p.machine) continue;
    const r = rowFor(p.machine);
    const t = toolOf(p.harness);
    if (t) r.tools.add(t.label);
    const at = p.writtenAt || p.lastWriteAt || null;
    const t0 = Date.parse(at);
    if (Number.isFinite(t0)) {
      const prevName = r.names.get(p.machine);
      if (!prevName || t0 > Date.parse(prevName)) r.names.set(p.machine, at);
      if (!r.newestSaveAt || t0 > Date.parse(r.newestSaveAt)) { r.newestSaveAt = at; r.curatorVersion = p.curator || null; }
    }
  }
  const incoming = Array.isArray(sync?.incoming) ? sync.incoming : null;
  if (incoming) {
    for (const f of incoming) {
      const m = incomingMachine(f, domain, project);
      if (m) rowFor(m).waiting++;
    }
  }
  const out = [...rows.values()].map((r) => {
    // Newest-saved name first; a name with no dated save sorts last.
    const names = [...r.names.entries()]
      .sort((x, y) => (Date.parse(y[1]) || 0) - (Date.parse(x[1]) || 0) || x[0].localeCompare(y[0]))
      .map(([n]) => n);
    const row = {
      key: r.key,
      names,
      primary: names[0],
      aliases: names.slice(1),
      thisComputer: r.thisComputer,
      installKind: r.installKind,
      tools: [...r.tools].sort(),
      newestSaveAt: r.newestSaveAt,
      curatorVersion: r.curatorVersion,
      waiting: r.waiting,
      // v3.77.0 names, kept for one release so an older view still renders.
      machine: names[0],
      thisMachine: r.thisComputer,
      newestAt: r.newestSaveAt,
      curator: r.curatorVersion,
    };
    if (r.thisComputer && sync) row.sync = sync;
    return row;
  }).sort((x, y) => (y.thisComputer - x.thisComputer) || ((Date.parse(y.newestSaveAt) || 0) - (Date.parse(x.newestSaveAt) || 0)));
  const here = out.filter((r) => r.thisComputer);
  const physical = [
    ...(here.length ? [{ thisComputer: true, installs: here }] : []),
    ...out.filter((r) => !r.thisComputer).map((r) => ({ thisComputer: false, installs: [r] })),
  ];
  return { rows: out, physical };
}
