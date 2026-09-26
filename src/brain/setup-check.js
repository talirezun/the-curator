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

export const STATES = Object.freeze({
  OK: 'ok',
  FIX: 'fix',
  CANT: 'cant-check',
  NOT_CHECKED: 'not-checked',
  UNMEASURED: 'unmeasured',
  NONE: 'none',
});

export const SKILL_NAMES = Object.freeze(['my-curator', 'curator-continuity']);

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

/** `{present, json?, jsonc?, parseError?, bytes?, readError?}` — never the text. */
export function readJsonFile(file) {
  try {
    if (!existsSync(file)) return { present: false };
    const text = readFileSync(file, 'utf8');
    const bytes = Buffer.byteLength(text);
    try { return { present: true, json: JSON.parse(text), bytes }; } catch (err) {
      try { return { present: true, json: JSON.parse(stripJsonComments(text)), bytes, jsonc: true }; }
      catch { return { present: true, parseError: err.message.slice(0, 160), bytes }; }
    }
  } catch (err) { return { present: false, readError: err.message.slice(0, 160) }; }
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
  const kindFor = (format) => (format === 'json' ? 'json' : format === 'toml' ? 'toml' : 'opaque');
  const rows = [];
  for (const id of listHarnesses()) {
    const a = adapterFor(id);
    if (!a) continue;
    const cfg = a.mcpConfig || null;
    const mcpFiles = cfg
      ? [...resolveTemplates(cfg.user || [], dirs), ...resolveTemplates(cfg.project || [], dirs)]
      : [];
    if (cfg && mcpFiles.length === 0) continue;
    const kind = cfg ? kindFor(cfg.format) : 'json';
    const mk = (file, via) => ({
      file, kind, key: cfg?.key || null, via,
      tomlKey: kind === 'toml' ? `[${cfg.key}.${MCP_SERVER_NAME}]` : undefined,
    });
    const row = {
      id: a.id,
      label: a.label,
      mcp: mcpFiles.map((f) => mk(f, 'own')),
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
  return { command, domainsPath: i !== -1 && typeof args[i + 1] === 'string' ? args[i + 1] : null };
}

/**
 * Does this config file name the my-curator server, and where does it point?
 * `opts.repo` (absolute) additionally reads `<projectsKey>[repo][key]` —
 * Claude Code's local-scope entries in ~/.claude.json.
 */
export function inspectMcpFile(target, opts = {}) {
  if (target.kind === 'toml') {
    try {
      if (!existsSync(target.file)) return { present: false };
      const text = readFileSync(target.file, 'utf8');
      const named = text.split('\n').some((l) => l.trim().startsWith(target.tomlKey));
      return { present: true, named, scan: 'line-scan (no TOML parser — a malformed file cannot be detected)' };
    } catch (err) { return { present: false, readError: err.message }; }
  }
  if (target.kind === 'dir') {
    try { return { present: existsSync(target.file) && statSync(target.file).isDirectory() }; }
    catch { return { present: false }; }
  }
  if (target.kind === 'opaque') return { present: existsSync(target.file), opaque: true };
  const r = readJsonFile(target.file);
  if (!r.present || r.parseError) {
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
  const base = { present: true, ...(r.jsonc ? { jsonc: true } : {}) };
  if (!entry) return { ...base, named: false };
  return { ...base, named: true, at, ...entryFacts(entry) };
}

/** A Curator hook command, in any form install-hooks writes. */
export const OUR_HOOK_RE = /curator(?:\.js)?['"]?\s+hook\s/;

/** Curator hook entries in a harness hook file, plus the accepted-and-inert ones. */
export function inspectHookFile(harnessId, file) {
  const r = readJsonFile(file);
  if (!r.present || r.parseError) { const { json, ...rest } = r; return rest; }
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
export async function inspectMarker(repo, { domain, project, git = gitRead } = {}) {
  const file = path.join(repo, '.curator-project');
  const rec = { file, present: false, line: null, namesThis: false, git: null };
  try {
    if (existsSync(file)) {
      rec.present = true;
      const text = readFileSync(file, 'utf8').slice(0, 1024);
      rec.line = (text.split('\n').map((s) => s.trim()).find(Boolean) || '').slice(0, 200) || null;
      const names = new Set(domain === project ? [domain, `${domain}/${domain}`] : [project, `${domain}/${project}`]);
      rec.namesThis = !!(rec.line && names.has(rec.line));
    }
  } catch { /* unreadable: reported absent */ }
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
      const rec = { file: m.file, via: m.via, present: !!r.present, named: r.named === true };
      if (r.jsonc) rec.jsonc = true;
      if (r.parseError) rec.parseError = true;
      if (r.opaque) rec.opaque = true;
      if (r.at) rec.at = r.at;
      if (r.named) {
        if (r.domainsPath && o.domainsDir && r.domainsPath !== o.domainsDir) rec.otherFolder = true;
        if (r.command && r.command.startsWith('/') && !existsSync(r.command)) rec.commandMissing = true;
        rec.command = r.command || null;
      }
      files.push(rec);
    }
    const own = files.filter((f) => f.via === 'own');
    const namedOwn = own.filter((f) => f.named);
    const namedAlso = files.filter((f) => f.via === 'readAlso' && f.named);
    let bridge;
    if (t.noMcpClient) bridge = { state: STATES.NONE, word: 'no MCP client' };
    else if (files.some((f) => f.parseError && !f.named)) {
      bridge = { state: STATES.FIX, word: 'a config file could not be read' };
    } else if (namedOwn.some((f) => f.otherFolder || f.commandMissing)) {
      bridge = { state: STATES.FIX, word: namedOwn.some((f) => f.commandMissing) ? 'launch line points at a missing file' : 'reads a different knowledge folder' };
    } else if (namedOwn.length) {
      const presentOwn = own.filter((f) => f.present && !f.opaque);
      const userOwn = own.filter((f) => f.present);
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
 *   machine      — `{ids: string[]}` — every machine id that is THIS computer
 *   machineRows  — `collectMachineSetup({home, repo})` for this project's repo
 *   repo         — `{path, source}` or null
 *   marker       — `inspectMarker()` result or null
 *   template     — paragraph 1 of the agent-instructions block
 *   addedTools   — ids the user added here
 *   sync         — `{configured, lastSyncAt, pending, incoming: string[]|null, checkedAt}`
 *   thisVersion  — this app's version
 */
export function collectProjectSetup(o) {
  const { domain, project } = o;
  const pairs = Array.isArray(o.pairs) ? o.pairs : [];
  const here = new Set(o.machine?.ids || []);
  const machineRows = Array.isArray(o.machineRows) ? o.machineRows : [];
  const byId = new Map(machineRows.map((r) => [r.id, r]));
  const repoPath = o.repo?.path || null;
  const toFix = [];

  // ── Evidence: saves by tool ────────────────────────────────────────────
  const saved = new Map();   // tool id → newest pair info
  for (const p of pairs) {
    const t = toolOf(p.harness);
    if (!t) continue;
    const at = p.writtenAt || p.lastWriteAt || null;
    const cur = saved.get(t.id);
    if (!cur || Date.parse(at) > Date.parse(cur.at)) {
      saved.set(t.id, { tool: t, at, scope: p.scope, machine: p.machine, thisMachine: here.has(p.machine), curator: p.curator || null });
    }
  }

  // ── Which tools get a row ──────────────────────────────────────────────
  const ids = new Set([...saved.keys()]);
  for (const id of o.addedTools || []) if (adapterFor(id)) ids.add(id);
  for (const r of machineRows) {
    if (r.configured && r.instructionNames.length) ids.add(r.id);
  }

  const collision = toolScopeIds();
  const tools = [];
  for (const id of ids) {
    const a = adapterFor(id);
    const m = byId.get(id) || null;
    const s = saved.get(id) || null;
    const label = a?.label || s?.tool.label || id;
    const row = { id, label, known: !!a };

    // Saved
    if (s) {
      const own = s.scope === id;
      const wrong = !own && collision.has(s.scope);
      row.saved = { state: wrong ? STATES.FIX : STATES.OK, at: s.at, scope: s.scope, machine: s.machine, thisMachine: s.thisMachine, ownScope: own, wrongScope: wrong };
      if (wrong) {
        toFix.push({
          tool: id, kind: 'wrong-scope',
          text: `${label} saved under “${s.scope}”, not “${id}”.`,
          detail: `A tool saving under ${s.scope === 'main' ? 'the shared “main”' : `another tool’s scope`} replaces that handoff. The current agent instructions tell each tool to save under its own name.`,
          fix: { kind: 'copy-block' },
        });
      }
    } else row.saved = { state: STATES.NONE, at: null };

    // Bridge (this machine), with evidence overriding an absent entry
    if (!m) row.bridge = { state: STATES.CANT, word: 'this tool has no config file The Curator knows' };
    else if (m.bridge.state === STATES.NONE && s && s.thisMachine) {
      row.bridge = { state: STATES.OK, word: 'working', note: 'entry not found in the files read — a save from this computer proves it works' };
    } else row.bridge = { ...m.bridge };
    if (m && m.bridge.state === STATES.FIX) {
      toFix.push({ tool: id, kind: 'bridge', text: `${label}: ${m.bridge.word}.`, detail: 'See Settings › MCP bridge › Tools on this Mac for the file.', fix: { kind: 'settings' } });
    }

    // Skills
    row.skills = m ? { state: m.skills.state, word: m.skills.word, note: m.skills.note || null } : { state: STATES.CANT, word: 'can’t check here' };
    if (m && m.skills.state === STATES.FIX) {
      toFix.push({ tool: id, kind: 'skills', text: `${label}: ${m.skills.word}.`, detail: 'Replace the installed skill folders with the current copy this app carries.', fix: { kind: 'skills' } });
    }

    // Block
    const names = a?.instructionFile?.names || [];
    if (!names.length) row.block = { state: STATES.NONE, word: 'reads no instruction file' };
    else if (!repoPath) row.block = { state: STATES.NOT_CHECKED, word: 'not checked', note: 'no repository set on this computer' };
    else {
      const files = names.map((n) => inspectInstructionFile(path.join(repoPath, n), {
        domain, project, template: o.template, cap: a.instructionFile.cap || null,
      }));
      const withBlock = files.filter((f) => f.hasBlock);
      const best = withBlock.find((f) => f.current && !f.wrongProject) || withBlock[0] || null;
      row.block = { files: files.map((f) => ({ name: path.basename(f.file), present: f.present, hasBlock: f.hasBlock, current: f.current, wrongProject: f.wrongProject, namesProject: f.namesProject, atTop: f.atTop, overCap: f.overCap, bytes: f.bytes })) };
      const fileWord = names.join(' or ');
      if (!best) {
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

    // Hooks (optional — never "to fix" unless wired where it cannot load)
    if (m) {
      row.hooks = {
        state: m.hooks.state, word: m.hooks.word, note: m.hooks.note || null, evidence: m.hooks.evidence,
        suggest: m.hooks.suggestScope ? `my-curator install-hooks ${id} --scope ${m.hooks.suggestScope} --git-exclude` : null,
        files: m.hooks.files.map((f) => ({ file: f.file, scope: f.scope, ours: f.ours, observation: f.observation || null })),
      };
    } else row.hooks = { state: STATES.NONE, word: '—' };
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

  // ── Computers ──────────────────────────────────────────────────────────
  const comps = new Map();
  for (const p of pairs) {
    if (!p.machine) continue;
    const c = comps.get(p.machine) || { machine: p.machine, thisMachine: here.has(p.machine), tools: new Set(), newestAt: null, curator: null };
    const t = toolOf(p.harness);
    if (t) c.tools.add(t.label);
    const at = p.writtenAt || p.lastWriteAt || null;
    if (at && (!c.newestAt || Date.parse(at) > Date.parse(c.newestAt))) { c.newestAt = at; c.curator = p.curator || null; }
    comps.set(p.machine, c);
  }
  const incoming = Array.isArray(o.sync?.incoming) ? o.sync.incoming : null;
  const waiting = new Map();
  if (incoming) {
    for (const f of incoming) {
      const m = incomingMachine(f, domain, project);
      if (m) waiting.set(m, (waiting.get(m) || 0) + 1);
    }
  }
  for (const [m, n] of waiting) {
    if (!comps.has(m)) comps.set(m, { machine: m, thisMachine: here.has(m), tools: new Set(), newestAt: null, curator: null });
    comps.get(m).waiting = n;
  }
  const computers = [...comps.values()]
    .map((c) => ({ ...c, tools: [...c.tools].sort(), waiting: c.waiting || 0 }))
    .sort((x, y) => (y.thisMachine - x.thisMachine) || ((Date.parse(y.newestAt) || 0) - (Date.parse(x.newestAt) || 0)));
  const waitingTotal = computers.reduce((s, c) => s + (c.thisMachine ? 0 : c.waiting), 0);
  if (waitingTotal) {
    toFix.push({ kind: 'sync-incoming', text: `${waitingTotal === 1 ? 'A newer handoff is' : `${waitingTotal} handoff files are`} waiting on GitHub.`, detail: 'Another computer saved and synced. Sync this Mac before starting, so the agent reads it.', fix: { kind: 'sync' } });
  }

  return {
    domain, project,
    repo,
    tools,
    computers,
    sync: o.sync || null,
    toFix,
    counts: { toFix: toFix.length, tools: tools.length, computers: computers.length },
    thisVersion: o.thisVersion || null,
  };
}
