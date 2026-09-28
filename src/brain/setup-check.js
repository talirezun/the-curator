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
export function inspectInstructionFile(file, opts = {}) {
  const empty = {
    file, present: false, bytes: 0, mtimeMs: null, hasBlock: false, current: false, namesProject: null, wrongProject: false,
    atTop: false, overCap: false, blockPastCap: false, blockStartsPastCap: false,
    blockStart: null, blockEnd: null, blockStartBytes: null, blockEndBytes: null,
  };
  let text;
  let mtimeMs = null;
  try {
    if (!existsSync(file)) return empty;
    const st = statSync(file);
    if (!st.isFile()) return empty;
    mtimeMs = st.mtimeMs;
    text = readFileSync(file, 'utf8');
  } catch { return empty; }
  const { norm, ...a } = analyseInstructionText(text, opts);
  return { ...empty, ...a, file, present: true, mtimeMs };
}

/**
 * Where a thing reaches another computer (v3.79.0). The owner has TWO sync
 * channels and a third kind of thing that syncs nowhere:
 *   personal-sync  handoffs, the brief, Documents — Sync now (the private
 *                  knowledge repository)
 *   project-git    CLAUDE.md, AGENTS.md, .curator-project — the project's own
 *                  git: commit and push here, pull there. Sync now never
 *                  carries them.
 *   this-computer  MCP settings, skills, hooks — set up on each computer.
 */
export const TRAVELS = Object.freeze({
  PERSONAL_SYNC: 'personal-sync',
  PROJECT_GIT: 'project-git',
  THIS_COMPUTER: 'this-computer',
});

/** The heading Copy agent instructions puts above the block (agent-instructions.js HEADING). */
const BLOCK_HEADING_RE = /^##[ \t]+Working state[ \t]*$/;

/**
 * Whitespace-collapsed copy of `s` with a map back into `s`: `out[i]` came
 * from `s[map[i]]`. Leading and trailing whitespace go and every run becomes
 * one space — the same collapse as the `ws()` comparison below, so a match
 * found in `out` maps back to real offsets.
 */
function collapseWithMap(s) {
  let out = '';
  const map = [];
  let gap = -1;
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) { if (out.length && gap === -1) gap = i; continue; }
    if (gap !== -1) { out += ' '; map.push(gap); gap = -1; }
    out += s[i];
    map.push(i);
  }
  return { out, map };
}

/**
 * Where the Curator block sits in `norm` (LF text), as JS string offsets.
 *
 * START: the `## Working state` heading when it is the nearest non-blank line
 * above the lead sentence (how Copy agent instructions composes it), else the
 * lead sentence itself.
 * END: the next Markdown heading at that heading's level or higher (any
 * heading when there is none above the lead), outside a code fence, or the end
 * of the file — and never before the end of the matched current text. The
 * block's paragraphs carry no heading, so the next heading is where the
 * owner's own text resumes. Prose pasted straight after the block with NO
 * heading reads as part of it: an over-estimate of the block, never a cut.
 */
function locateBlock(norm, leadIndex, bodyEnd) {
  const lines = [];
  { let i = 0; for (const l of norm.split('\n')) { lines.push({ at: i, text: l }); i += l.length + 1; } }
  let leadLine = 0;
  for (let k = 0; k < lines.length; k++) if (lines[k].at <= leadIndex) leadLine = k;
  let start = leadIndex;
  let level = 6;
  for (let k = leadLine - 1; k >= 0; k--) {
    const t = lines[k].text;
    if (!t.trim()) continue;
    if (BLOCK_HEADING_RE.test(t)) { start = lines[k].at; level = 2; }
    break;
  }
  let end = norm.length;
  let fence = false;
  for (let k = leadLine + 1; k < lines.length; k++) {
    const t = lines[k].text;
    if (/^\s*(```|~~~)/.test(t)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^(#{1,6})[ \t]/.exec(t);
    if (m && m[1].length <= level) { end = lines[k].at; break; }
  }
  while (end > start && /\s/.test(norm[end - 1])) end--;
  if (Number.isInteger(bodyEnd) && bodyEnd > end) end = bodyEnd;
  return { start, end };
}

/**
 * The block analysis of an instruction file's TEXT (v3.79.0) — shared by the
 * check and by the file reader route, so the two never disagree. Offsets are
 * into the LF-normalised text, returned as `norm`.
 */
export function analyseInstructionText(text, { domain, project, template, cap = null } = {}) {
  const raw = String(text ?? '');
  const norm = raw.replace(/\r\n/g, '\n');
  const rec = {
    bytes: Buffer.byteLength(raw), hasBlock: false, current: false, namesProject: null, wrongProject: false,
    atTop: false, overCap: false, blockPastCap: false, blockStartsPastCap: false,
    blockStart: null, blockEnd: null, blockStartBytes: null, blockEndBytes: null, norm,
  };
  if (cap && rec.bytes > cap) rec.overCap = true;
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
  const lead = lm ? lm.index : -1;
  const m = /The Curator \(project `([^`]{1,200})`/.exec(norm);
  rec.namesProject = m ? m[1] : null;
  rec.wrongProject = !!(rec.namesProject && domain && project && rec.namesProject !== `${domain}/${project}`);
  let bodyEnd = null;
  if (typeof template === 'string' && domain && project) {
    const body = template.split('{{DOMAIN_PROJECT}}').join(`${domain}/${project}`).split('{{PROJECT}}').join(project);
    // WHITESPACE-INSENSITIVE, WORD-EXACT (v3.77.0 screen review): an owner's
    // paste or editor re-wraps the block's lines, and a block identical in
    // every word but wrapped differently IS the current text. Runs of
    // whitespace (newlines included) collapse to one space on both sides;
    // every other character must match exactly, so a block that differs in
    // a single word is still "not current".
    const ws = (s) => s.replace(/\s+/g, ' ').trim();
    const want = ws(body);
    const c = collapseWithMap(norm);
    const at = want ? c.out.indexOf(want) : -1;
    rec.current = at !== -1;
    if (rec.current) bodyEnd = c.map[at + want.length - 1] + 1;
  }
  if (lead !== -1) {
    const { start, end } = locateBlock(norm, lead, bodyEnd);
    rec.blockStart = start;
    rec.blockEnd = end;
    // Byte offsets are ON DISK (a CRLF file's `\r`s counted), since a tool's
    // cap is bytes of the file it reads.
    const rawAt = (k) => {
      if (raw === norm) return k;
      let n = 0;
      let i = 0;
      for (; i < raw.length && n < k; i++) if (!(raw[i] === '\r' && raw[i + 1] === '\n')) n++;
      return i;
    };
    rec.blockStartBytes = Buffer.byteLength(raw.slice(0, rawAt(start)));
    rec.blockEndBytes = Buffer.byteLength(raw.slice(0, rawAt(end)));
    rec.atTop = rec.blockStartBytes <= AT_TOP_BYTES;
    if (cap) {
      // v3.79.0 — the block is past the cap when its END is: the tool reads
      // the first `cap` bytes and cuts the rest, so a block that starts inside
      // the cap but runs past it is cut too. Before, this was `start + 1200 >
      // cap`, computed and never read: the to-fix fired on `overCap` (ANY
      // file longer than the cap, block at the top or not) and on "not in the
      // first 2 KB".
      rec.blockPastCap = rec.blockEndBytes > cap;
      rec.blockStartsPastCap = rec.blockStartBytes >= cap;
    }
  }
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
  // v3.79.0 — the same two words the file reader uses.
  rec.git.committed = rec.git.tracked === true && rec.git.uncommitted === false;
  rec.git.pushed = rec.git.committed && rec.git.upstream ? rec.git.unpushed === false : null;
  return rec;
}

/**
 * One repository file's git standing (v3.79.0), read-only, NO fetch:
 * `{repo, tracked, uncommitted, unpushed, upstream, committed, pushed}`.
 * `committed` = tracked and clean; `pushed` = committed and not ahead of the
 * upstream AS OF THIS MAC'S LAST FETCH — null when there is no upstream, so a
 * view never claims either way. `name` is a repository-relative file name the
 * caller already allow-listed; it is passed after `--`, never as an option.
 */
export async function inspectGitFile(repo, name, { git = gitRead, present = true } = {}) {
  const inside = await git(repo, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out.trim() !== 'true') return { repo: false, committed: null, pushed: null };
  const rec = { repo: true, tracked: null, uncommitted: null, unpushed: null, upstream: null, committed: null, pushed: null };
  if (!present) return rec;
  rec.tracked = (await git(repo, ['ls-files', '--error-unmatch', '--', name])).ok;
  const st = await git(repo, ['status', '--porcelain', '--', name]);
  rec.uncommitted = st.ok ? st.out.trim().length > 0 : null;
  const up = await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up.ok && up.out.trim()) {
    rec.upstream = up.out.trim().slice(0, 200);
    const ahead = await git(repo, ['rev-list', '@{u}..HEAD', '--', name]);
    rec.unpushed = ahead.ok ? ahead.out.trim().length > 0 : null;
  }
  rec.committed = rec.tracked === true && rec.uncommitted === false;
  rec.pushed = rec.committed && rec.upstream ? rec.unpushed === false : null;
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
  // A folder that is set but NOT on this computer is not read (v3.79.0): its
  // files were reported missing beside "the folder isn't on this Mac".
  const repoPath = o.repo && o.repo.exists !== false ? (o.repo.path || null) : null;
  const repoDisplay = o.repo?.path ? tildeUnder(o.home || '', o.repo.path) : null;
  // Is the folder a git repository? Unknown (no marker read) counts as yes:
  // the git command is then offered, and git itself says if it is not.
  const isGit = o.marker?.git?.repo !== false;
  /** `{committed, pushed}` of one instruction file, from the route's read-only git (or null). */
  const gitOf = (name) => {
    const g = o.instructionGit && typeof o.instructionGit === 'object' ? o.instructionGit[name] : null;
    return g && typeof g === 'object' ? { committed: g.committed ?? null, pushed: g.pushed ?? null } : null;
  };
  /** The one git command that commits and pushes one file, run in the set folder. */
  const commitFixes = (name, message) => (repoPath && isGit
    ? [FIX.command(commitPushCommand(name, message), 'Copy the git command that commits and pushes it', repoPath, o.home || '')]
    : []);
  const blockFixes = (name, message) => [
    // `reveal` on copy-block: the v3.78.0 view builds its Reveal button from it.
    { ...FIX.copyBlock(name), reveal: name },
    FIX.reveal(path.join(repoPath, name), `Reveal ${name}`),
    ...commitFixes(name, message),
  ];
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
      row.saved = { state: wrong ? STATES.FIX : STATES.OK, at: s.at, scope: s.scope, machine: s.machine, thisMachine: s.thisMachine, ownScope: own, wrongScope: wrong, curator: s.curator, travels: TRAVELS.PERSONAL_SYNC };
      // The wrong-name to-fix line is decided AFTER the block check below
      // (v3.79.0): what to do about it depends on whether the instructions
      // this tool reads are already current.
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
        toFix.push(item({
          tool: id, kind: 'bridge-file', status: b.status, file: b.file, fileDisplay: b.display,
          text: `${label}’s MCP settings file (${b.display}) ${BAD_FILE_TEXT[b.status]}, so ${label} can’t reach The Curator on this Mac.`,
          detail: badFileDetail(id, label, b.status),
        }, [FIX.reveal(b.file, `Reveal ${base}`), FIX.recheck(), FIX.settings()]));
      } else {
        toFix.push(bridgeItem(id, label, m));
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
      const it = skillsItem(id, label, m.skills, o.home || '');
      if (it) toFix.push(it);
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
    const cap = a?.instructionFile?.cap || null;
    let best = null;       // the instruction file whose block this tool gets
    let blockItem = null;  // its to-fix line, which a wrong-name save joins
    if (!names.length) row.block = { state: STATES.NONE, word: 'reads no instruction file' };
    else if (!repoPath) row.block = { state: STATES.NOT_CHECKED, word: 'not checked', note: 'no repository set on this computer' };
    else {
      const files = names.map((n) => ({ ...inspectInstructionFile(path.join(repoPath, n), {
        domain, project, template: o.template, cap,
      }), name: n }));
      const withBlock = files.filter((f) => f.hasBlock);
      best = withBlock.find((f) => f.current && !f.wrongProject) || withBlock[0] || null;
      row.block = {
        travels: TRAVELS.PROJECT_GIT,
        files: files.map((f) => ({
          name: f.name, present: f.present, hasBlock: f.hasBlock, current: f.current, wrongProject: f.wrongProject,
          namesProject: f.namesProject, atTop: f.atTop, overCap: f.overCap, blockPastCap: f.blockPastCap, bytes: f.bytes,
          mtime: Number.isFinite(f.mtimeMs) ? new Date(f.mtimeMs).toISOString() : null,
          ...(cap ? { cap } : {}),
          git: gitOf(f.name),
          travels: TRAVELS.PROJECT_GIT,
        })),
      };
      const fileWord = names.join(' or ');
      const at = { repoDisplay, tool: id };
      if (!a) {
        // An ASSUMPTION (the common convention), so never a to-fix line.
        Object.assign(row.block, best && best.current && !best.wrongProject
          ? { state: STATES.OK, word: 'current in AGENTS.md', note: 'assumed: most tools read AGENTS.md' }
          : { state: STATES.UNMEASURED, word: best ? 'AGENTS.md has an older or other block' : 'AGENTS.md has no Curator block', note: 'which file this tool reads is not known' });
      } else if (!best) {
        const f = names[0];
        Object.assign(row.block, { state: STATES.FIX, word: 'missing', note: `${fileWord} has no Curator block` });
        blockItem = item({ ...at, kind: 'block-missing', file: f,
          text: `${f} in ${repoDisplay} has no Curator instructions, so ${label} doesn’t know this project and may overwrite another tool’s handoff.`,
          detail: `${names.includes('CLAUDE.md') ? '' : `${label} reads ${names.join(' and ')}, not CLAUDE.md. `}Paste them at the very top (create the file if it isn’t there), then commit and push.`,
        }, blockFixes(f, 'Add The Curator instructions'));
      } else if (best.wrongProject) {
        Object.assign(row.block, { state: STATES.FIX, word: `names ${best.namesProject}`, note: best.name });
        blockItem = item({ ...at, kind: 'block-wrong', file: best.name,
          text: `${best.name} in ${repoDisplay} has the Curator instructions for ${best.namesProject}, so ${label} opens that project instead of ${domain}/${project}.`,
          detail: 'Replace them with this project’s instructions at the very top, then commit and push.',
        }, blockFixes(best.name, 'Use this project’s Curator instructions'));
      } else if (!best.current) {
        Object.assign(row.block, { state: STATES.FIX, word: 'outdated', note: best.name });
        blockItem = item({ ...at, kind: 'block-outdated', file: best.name,
          text: `${best.name} in ${repoDisplay} has older Curator instructions, so ${label} may not re-read on “continue” or save under its own name.`,
          detail: 'Replace them with the current instructions at the very top, then commit and push.',
        }, blockFixes(best.name, 'Update The Curator instructions'));
      } else if (cap && best.blockPastCap) {
        // v3.79.0 — ONLY when the block does not fit in what the tool reads.
        // v3.78.0 fired on `overCap` (any file longer than the cap, the block
        // at the top or not) and on "not in the first 2 KB".
        const n = cap.toLocaleString('en-US');
        Object.assign(row.block, { state: STATES.FIX, word: `past the ${n}-byte cap`, note: best.name });
        blockItem = item({ ...at, kind: 'block-cap', file: best.name, cap,
          text: `${label} reads only the first ${n} bytes of ${best.name}, and the Curator instructions ${best.blockStartsPastCap ? 'start after that' : 'run past that'}.`,
          detail: 'Move them to the top, then commit and push.',
        }, [FIX.reveal(path.join(repoPath, best.name), `Reveal ${best.name}`), ...commitFixes(best.name, 'Move The Curator instructions to the top')]);
      } else {
        Object.assign(row.block, { state: STATES.OK, word: best.atTop ? 'current · at the top' : 'current', note: best.name });
      }
      if (blockItem) toFix.push(blockItem);
    }

    // The wrong-name save (v3.79.0), decided now that the block is known.
    if (s && row.saved.wrongScope) {
      const it = wrongSaveItem({ id, label, s, row, best, blockItem, names, repoPath, gitOf, commitFixes });
      if (it) toFix.push(it);
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

    // ── What a setup guide and a Remove need (v3.80.0, additive) ─────────
    // The view builds a numbered guide in the tool's reader from these, and
    // offers Remove only where it would actually take the row away.
    row.reads = [...names];
    if (a) row.userAdded = (o.addedTools || []).includes(id);
    // WHY A ROW IS LISTED decides whether it can be removed: a tool that has
    // SAVED this project stays (its saves are this project's record), and a
    // tool whose MCP settings here name my-curator stays (the check found it,
    // nobody added it). Only the owner's own addition is taken back.
    const configured = !!(m && m.configured && m.instructionNames.length);
    row.removable = s ? { ok: false, why: 'saved' }
      : configured ? { ok: false, why: 'configured' }
        : row.userAdded ? { ok: true } : { ok: false, why: 'not-added' };
    {
      // Where the MCP entry goes: the file that already names us, else the
      // first of the tool's own files that exists, else its first own file.
      // `file` (absolute — the route reveals it) only when it exists here.
      const own = (m?.files || []).filter((f) => f.via === 'own');
      const pick = own.find((f) => f.named) || own.find((f) => f.present) || own[0] || null;
      const cfg = a?.mcpConfig || null;
      row.mcpTarget = pick
        ? { display: pick.display || tildeUnder(o.home || '', pick.file), ...(pick.present ? { file: pick.file } : {}),
          format: cfg?.format || null, verified: cfg?.verified === true, exists: !!pick.present }
        : null;
      const tree = a?.skillsTree || null;
      row.skillsTarget = tree
        ? { path: typeof tree.path === 'string' && tree.path ? tree.path : null, verified: tree.verified === true, accountHeld: tree.accountHeld === true }
        : null;
    }
    // The instruction file's own doors, for a guide step that has no to-fix
    // line to borrow them from (a custom tool's ASSUMED AGENTS.md is never a
    // to-fix): copy, reveal, and the git command that commits and pushes it.
    row.instructionFixes = repoPath && names.length && row.block.state !== STATES.OK
      ? blockFixes(names[0], 'Add The Curator instructions')
      : [];

    // ── One word per tool, and the four parts (v3.78.0) ──────────────────
    row.parts = {
      mcp: { state: row.bridge.state, word: row.bridge.word, travels: TRAVELS.THIS_COMPUTER },
      skills: { state: row.skills.state, word: row.skills.word, travels: TRAVELS.THIS_COMPUTER },
      block: { state: row.block.state, word: row.block.word, travels: TRAVELS.PROJECT_GIT },
      hooks: { state: row.hooks.state, word: row.hooks.word, travels: TRAVELS.THIS_COMPUTER },
    };
    row.status = toolStatus(row);
    row.evidence = evidence;
    tools.push(row);
  }
  tools.sort((x, y) => (Date.parse(y.saved?.at) || 0) - (Date.parse(x.saved?.at) || 0) || x.label.localeCompare(y.label));

  // ── Computers, grouped by INSTALLATION (v3.78.0) ──────────────────────
  // Before the repository (v3.79.0): whether ANOTHER computer has saved this
  // project decides what the marker-missing line tells the owner to do.
  const computers = groupComputers(pairs, { domain, project, isHere, sync: o.sync, installs: o.machine?.installs || [], currentIds: hereIds });
  const otherComputerSaved = computers.rows.some((c) => !c.thisComputer && c.newestSaveAt);

  // ── Repository ─────────────────────────────────────────────────────────
  let repo = null;
  if (o.repo) {
    const mk = o.marker ? { ...o.marker, travels: TRAVELS.PROJECT_GIT } : null;
    repo = {
      path: o.repo.path, source: o.repo.source, exists: o.repo.exists !== false, marker: mk,
      travels: TRAVELS.PROJECT_GIT, ...(repoDisplay ? { repoDisplay } : {}),
    };
    const at = { repoDisplay };
    const h = o.home || '';
    if (o.repo.exists === false) {
      toFix.push(item({ ...at, kind: 'repo-missing',
        text: `${repoDisplay} isn’t on this Mac.`,
        detail: 'Clone the project’s git repository here, then choose the folder.',
      }, [FIX.changeRepo('Choose the folder')]));
    }
    if (mk && repoPath) {
      const line = `${domain}/${project}`;
      const create = `printf '%s\\n' ${shq(line)} > .curator-project`;
      const createPush = `${create} && ${commitPushCommand('.curator-project', 'Add The Curator project marker')}`;
      const gitRepo = mk.git?.repo !== false;
      if (!mk.present) {
        let detail;
        let fixes;
        if (!gitRepo) {
          detail = `Create it with the one line ${line}.`;
          fixes = [FIX.command(create, 'Copy the command that creates it', repoPath, h), FIX.copyMarker()];
        } else if (otherComputerSaved) {
          // Another computer has saved this project, so its checkout may well
          // carry the marker. What this Mac cannot see is whether it was ever
          // committed and pushed there — the second button covers that case.
          detail = 'If it exists on another computer, run git pull here. If it isn’t there either, create it, then commit and push.';
          fixes = [
            FIX.command('git pull', 'Copy git pull', repoPath, h),
            FIX.command(createPush, 'Copy the command that creates, commits and pushes it', repoPath, h),
          ];
        } else {
          detail = 'Create it, then commit and push.';
          fixes = [FIX.command(createPush, 'Copy the command that creates, commits and pushes it', repoPath, h), FIX.copyMarker()];
        }
        toFix.push(item({ ...at, kind: 'marker-missing', otherComputerSaved,
          text: `${repoDisplay} has no .curator-project, so agents and hooks can’t tell which project this folder is.`,
          detail,
        }, fixes));
      } else if (!mk.namesThis) {
        const said = mk.line || '(nothing)';
        const rewrite = gitRepo ? `${create} && ${commitPushCommand('.curator-project', 'Point .curator-project at this project')}` : create;
        toFix.push(item({ ...at, kind: 'marker-wrong',
          text: `${repoDisplay}/.curator-project says ${said}, so every agent here opens ${said}.`,
          detail: `Change it to ${line}${gitRepo ? ', then commit and push' : ''}.`,
        }, [FIX.command(rewrite, gitRepo ? 'Copy the command that rewrites, commits and pushes it' : 'Copy the command that rewrites it', repoPath, h), FIX.copyMarker()]));
      } else if (mk.git?.repo && (mk.git.tracked === false || mk.git.uncommitted === true)) {
        toFix.push(item({ ...at, kind: 'marker-uncommitted',
          text: `${repoDisplay}/.curator-project isn’t committed to the project’s git repository.`,
          detail: 'Your other computers get it only after you commit and push it here, then pull there.',
        }, [FIX.command(commitPushCommand('.curator-project', 'Add The Curator project marker'), 'Copy the git command that commits and pushes it', repoPath, h)]));
      } else if (mk.git?.repo && mk.git.unpushed === true) {
        toFix.push(item({ ...at, kind: 'marker-unpushed',
          text: `${repoDisplay}/.curator-project is committed but not pushed.`,
          detail: 'Your other computers get it only after you push it here, then pull there.',
        }, [FIX.command('git push', 'Copy git push', repoPath, h)]));
      }
    }
  }

  // ── A newer handoff waiting in Personal Sync — one line per computer ──
  for (const c of computers.rows) {
    if (c.thisComputer || !c.waiting) continue;
    toFix.push(item({
      kind: 'sync-incoming', machine: c.primary, thisMachine: false, waiting: c.waiting,
      ...(c.newestSaveAt ? { at: c.newestSaveAt } : {}),
      text: `${c.primary} saved a newer handoff; it’s waiting in your Personal Sync on GitHub.`,
      detail: 'Sync now before you start the agent.',
    }, [FIX.sync()]));
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
      ? 'Open Antigravity once (it fills the file), then Re-check. If it stays empty, reveal it and fix or delete it.'
      : `Open ${label} once (it may fill the file), then Re-check. If it stays empty, reveal it and add the my-curator entry, or delete it.`;
  }
  if (status === 'invalid') {
    return `Nothing in it can be read, and ${label} may not read it either. Reveal it and fix the syntax (or delete it if it is a leftover), then Re-check.`;
  }
  return 'Reveal it and check its permissions (or give The Curator access under System Settings › Privacy & Security), then Re-check.';
}

// ─────────────────────────────────────────────────────────────────────────
// To-fix lines (v3.79.0): two lines each, and buttons that say what they do
// ─────────────────────────────────────────────────────────────────────────

/** A to-fix line's config-file words, for a sentence ("…file (~/x) is empty, so…"). */
const BAD_FILE_TEXT = Object.freeze({
  empty: 'is empty',
  invalid: 'isn’t valid JSON',
  unopenable: 'can’t be opened (a macOS permission)',
});

/**
 * The fix buttons, one constructor per kind. Every one carries a `label`
 * that says what pressing it does.
 */
export const FIX = Object.freeze({
  reveal: (p, label) => ({ kind: 'reveal', path: p, label: label || `Reveal ${path.basename(p)}` }),
  copyBlock: (file) => ({ kind: 'copy-block', label: 'Copy instructions', ...(file ? { file } : {}) }),
  command: (command, label, cwd, home) => ({
    kind: 'copy-command', command, label,
    ...(cwd ? { cwd, cwdDisplay: tildeUnder(home, cwd) } : {}),
  }),
  copyMarker: () => ({ kind: 'copy-marker', label: 'Copy marker line' }),
  copySnippet: (tool) => ({ kind: 'copy-snippet', tool, label: 'Copy MCP entry' }),
  downloadSkill: (skill) => ({ kind: 'download-skill', skill, href: `/api/setup/skills/${skill}.zip`, label: `Download ${skill}.zip` }),
  sync: () => ({ kind: 'sync', label: 'Sync now' }),
  changeRepo: (label = 'Choose the folder') => ({ kind: 'change-repo', label }),
  settings: () => ({ kind: 'settings', label: 'Open Tools on this Mac' }),
  recheck: () => ({ kind: 'recheck', label: 'Re-check' }),
});

/** A to-fix item: `fixes` in button order, and `fix` = the first (a v3.78.0 view reads that). */
function item(fields, fixes = []) {
  const list = fixes.filter(Boolean);
  return { ...fields, fixes: list, fix: list[0] || null };
}

/** A single-quoted shell word, unless it is plainly safe as it is. */
export function shq(s) {
  const t = String(s);
  return /^[A-Za-z0-9._/@:+=-]+$/.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`;
}

/**
 * The ONE command that commits and pushes one file, run in the set folder.
 * `git commit … -- <file>` commits that file only, never whatever else the
 * owner has staged.
 */
export function commitPushCommand(file, message) {
  return `git add -- ${shq(file)} && git commit -m ${JSON.stringify(message)} -- ${shq(file)} && git push`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "25 Sep" — this Mac's local date, for a sentence. Null for no date. */
export function shortDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The bridge to-fix that is not a bad file: name the file, offer the entry and a reveal. */
function bridgeItem(id, label, m) {
  const files = m.files || [];
  const flagged = files.find((f) => f.named && f.via === 'own' && (f.commandMissing || f.otherFolder))
    || files.find((f) => f.named && (f.commandMissing || f.otherFolder));
  const base = { tool: id, kind: 'bridge' };
  if (flagged) {
    const missing = !!flagged.commandMissing;
    return item({ ...base, file: flagged.file, fileDisplay: flagged.display,
      reason: missing ? 'launch-missing' : 'other-folder',
      text: missing
        ? `${label}’s MCP entry in ${flagged.display} launches a file that isn’t on this Mac, so ${label} can’t reach The Curator.`
        : `${label}’s MCP entry in ${flagged.display} reads a different knowledge folder, so ${label} doesn’t see this project’s handoffs.`,
      detail: `Replace the entry with the current one, then restart ${label}.`,
    }, [FIX.copySnippet(id), FIX.reveal(flagged.file, `Reveal ${path.basename(flagged.file)}`)]);
  }
  const named = files.find((f) => f.named && f.via === 'own');
  const notIn = files.filter((f) => f.via === 'own' && f.present && f.status === 'ok' && !f.named);
  if (named && notIn.length) {
    return item({ ...base, file: notIn[0].file, fileDisplay: notIn[0].display, reason: 'not-in-every-file',
      text: `${label}’s MCP entry is in ${named.display} but not in ${notIn.map((f) => f.display).join(' or ')}, so ${label} may not reach The Curator from every window.`,
      detail: `Add the entry to ${notIn.length === 1 ? 'that file' : 'those files'}, then restart ${label}.`,
    }, [FIX.copySnippet(id), FIX.reveal(notIn[0].file, `Reveal ${path.basename(notIn[0].file)}`)]);
  }
  return item({ ...base, reason: 'other',
    text: `${label}’s MCP entry: ${m.bridge.word}.`,
    detail: 'Open Tools on this Mac to see each file it read.',
  }, [FIX.settings()]);
}

/** The skills to-fix: which skill, where, and only the stale one's download. */
function skillsItem(id, label, skills, home) {
  const installed = skills.installed || [];
  const stale = installed.filter((s) => s.match === false);
  if (stale.length) {
    const folders = [...new Set(stale.map((s) => path.dirname(s.dir)))];
    const names = stale.map((s) => s.skill);
    return item({ tool: id, kind: 'skills', reason: 'outdated', skills: names, folder: folders[0], folderDisplay: tildeUnder(home, folders[0]),
      text: `${label}’s ${names.join(' and ')} skill${names.length === 1 ? ' is' : 's are'} older than the copy this app carries (in ${folders.map((f) => tildeUnder(home, f)).join(' and ')}).`,
      detail: `Download the current .zip, replace the folder with it, then start a new ${label} session.`,
    }, [...[...new Set(names)].map((n) => FIX.downloadSkill(n)), FIX.reveal(stale[0].dir, 'Reveal the folder')]);
  }
  const have = [...new Set(installed.map((s) => s.skill))];
  const missing = SKILL_NAMES.filter((n) => !have.includes(n));
  if (!missing.length || !installed.length) return null;
  const folder = path.dirname(installed[0].dir);
  return item({ tool: id, kind: 'skills', reason: 'missing', skills: missing, folder, folderDisplay: tildeUnder(home, folder),
    text: `${label} has the ${have.join(' and ')} skill but not ${missing.join(' or ')} (in ${tildeUnder(home, folder)}).`,
    detail: `Download it and unzip it beside the other one, then start a new ${label} session.`,
  }, [...missing.map((n) => FIX.downloadSkill(n)), FIX.reveal(folder, 'Reveal the folder')]);
}

/**
 * A tool's newest save went under a name that is not its own (v3.79.0).
 *
 * WHAT THIS CAN KNOW: the block check reads THIS Mac's checkout only. When
 * the save came from another computer, nothing here says what that
 * computer's checkout holds — only whether this Mac's copy is current and
 * whether it is committed and pushed (so that a `git pull` there could bring
 * it). And a file's mtime is when its CONTENT last changed on this Mac — an
 * edit anywhere in the file moves it — while an agent reads its instruction
 * file when its session STARTS. So "saved after the instructions changed"
 * does not prove the session saw the current text; the wording says so.
 */
function wrongSaveItem({ id, label, s, row, best, blockItem, names, repoPath, gitOf, commitFixes }) {
  const when = shortDate(s.at);
  const where = s.thisMachine ? 'this Mac' : (s.machine || 'another computer');
  const fields = { tool: id, at: s.at, machine: s.machine || null, thisMachine: !!s.thisMachine, scope: s.scope };
  if (blockItem) {
    // The block line already carries the fix; it explains the save too.
    blockItem.detail += ` That is why its ${when ? `${when} ` : 'last '}save went under “${s.scope}”.`;
    Object.assign(blockItem, { at: s.at, machine: s.machine || null, thisMachine: !!s.thisMachine, wrongSave: { scope: s.scope, at: s.at } });
    return null;
  }
  const text = `${label}’s last save (${when ? `${when}, ` : ''}on ${where}) went under “${s.scope}”, not its own name “${id}”.`;
  if (row.block.state === STATES.OK && best) {
    const file = best.name;
    const g = gitOf(file);
    if (!s.thisMachine) {
      if (g && (g.committed === false || g.pushed === false)) {
        return item({ ...fields, kind: 'wrong-scope', blockCurrent: true, file,
          text,
          detail: `Your instructions here are current but not yet ${g.committed === false ? 'committed and pushed' : 'pushed'}, so ${where} can’t have them: commit and push ${file} here, then run git pull there.`,
        }, commitFixes(file, 'Update The Curator instructions'));
      }
      return item({ ...fields, kind: 'wrong-scope', blockCurrent: true, file,
        text,
        detail: `Your instructions here are already current, so this clears the next time ${label} saves — after that computer runs git pull.`,
      }, []);
    }
    const changedAt = Number.isFinite(best.mtimeMs) ? best.mtimeMs : null;
    // Two seconds of slack: a save and an edit in the same moment are not "after".
    if (changedAt !== null && Date.parse(s.at) > changedAt + 2000) {
      return item({ ...fields, kind: 'wrong-scope', blockCurrent: true, file, savedAfterInstructions: true,
        instructionsChangedAt: new Date(changedAt).toISOString(),
        text,
        detail: `Your instructions here are already current, but it saved after ${file} last changed (${shortDate(new Date(changedAt).toISOString())}). If that session started before the change, this clears next time; if not, ask it to save under “${id}”.`,
      }, []);
    }
    return item({ ...fields, kind: 'wrong-scope', blockCurrent: true, file,
      text,
      detail: `Your instructions here are already current, so this clears the next time ${label} saves.`,
    }, []);
  }
  // No block line to carry it: no folder set, a tool that reads no
  // instruction file, or a custom tool whose file is assumed.
  if (!names.length) {
    return item({ ...fields, kind: 'wrong-scope', text,
      detail: `${label} reads no instruction file, so tell it in the conversation to save under “${id}”.`,
    }, []);
  }
  return item({ ...fields, kind: 'wrong-scope', text,
    detail: repoPath
      ? `Paste the current instructions at the very top of ${names[0]}; they tell it to save under its own name.`
      : `The current instructions tell it to save under its own name. Set this project’s folder so Setup can check ${names.join(' and ')}.`,
  }, [FIX.copyBlock(names[0]), ...(repoPath ? [] : [FIX.changeRepo('Set the folder')])]);
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
export function groupComputers(pairs, { domain, project, isHere, sync, installs = [], currentIds = [] }) {
  currentIds = new Set(Array.isArray(currentIds) || currentIds instanceof Set ? currentIds : []);
  const rows = new Map();
  const collision = toolScopeIds();
  const keyOf = (name) => { const i = installIdOf(name); return i ? `install:${i}` : `name:${name}`; };
  const rowFor = (name) => {
    const key = keyOf(name);
    if (!rows.has(key)) {
      const i = installIdOf(name);
      const inst = i ? installs.find((x) => x.installId === i) : null;
      rows.set(key, { key, installId: i, names: new Map(), thisComputer: false, installKind: inst ? inst.kind || null : null, tools: new Set(), saves: new Map(), newestSaveAt: null, curatorVersion: null, waiting: 0 });
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
    // v3.79.0 — each tool's NEWEST save from this install, and the name it
    // went under: the reader flags a save that is not under the tool's own.
    if (t) {
      const prev = r.saves.get(t.id);
      if (!prev || (Number.isFinite(t0) && !(Date.parse(prev.at) >= t0))) {
        const own = p.scope === t.id;
        r.saves.set(t.id, {
          tool: t.id, label: t.label, scope: p.scope || null, at, curator: p.curator || null, machine: p.machine,
          ownScope: own, wrongScope: !own && collision.has(p.scope), travels: TRAVELS.PERSONAL_SYNC,
        });
      }
    }
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
    // Newest-saved name first; a name with no dated save sorts last. On an
    // EXACT tie (two saves stamped in the same millisecond — the agent clock
    // is ISO with ms resolution), the name that is an install's CURRENT
    // machine id on this Mac wins (it carries today's hostname slug; an
    // alias like `mac-17d23c` is a pre-D10 spelling), then plain lexical
    // order. Before v3.79.0 a tie fell straight to lexical order, which puts
    // `mac-…` ahead of `talis-macbook-pro-…` — the one way `test-setup-routes`
    // §9 could read the alias as primary.
    const cur = (n) => (currentIds.has(n) ? 1 : 0);
    const names = [...r.names.entries()]
      .sort((x, y) => (Date.parse(y[1]) || 0) - (Date.parse(x[1]) || 0) || cur(y[0]) - cur(x[0]) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
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
      saves: [...r.saves.values()].sort((x, y) => (Date.parse(y.at) || 0) - (Date.parse(x.at) || 0) || x.label.localeCompare(y.label)),
      travels: TRAVELS.PERSONAL_SYNC,
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
