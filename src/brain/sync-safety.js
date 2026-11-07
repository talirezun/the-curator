/**
 * What Personal Sync must never send, and how to tell what it did not send.
 *
 * Pure file-system and string work: no git, no network. brain/sync.js owns
 * every git call and uses these at its one staging chokepoint (stageAll).
 *
 * WHY THIS EXISTS. Measured on folders The Curator did not create: `git add -A`
 * over a knowledge folder pushed `.env` to the user's repository, and a vault
 * with its own `.git` became an empty gitlink while Sync reported success. The
 * folder can be any folder (Use existing folder), so nothing about its contents
 * can be assumed.
 *
 * NAMES, NOT CONTENT, with one exception (Obsidian plugin settings, below). A
 * key pasted into a note is not detected: scanning every page on every sync
 * would be slow, and a wiki about API keys would be refused. docs/sync.md says so.
 */
import { readdir, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { writeFileAtomic } from './atomic-write.js';

// Basename patterns: `*` only. No markdown page can match: a page called
// `credentials.md` or `service-account-token.md` is knowledge, not a secret.
const CREDENTIAL_BASENAMES = [
  '.env', '.env.*', '.env-*', '.env_*', '.envrc',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.ppk', '*.ovpn', '*.kdbx',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  '.netrc', '_netrc', '.npmrc', '.pypirc', '.pgpass', '.htpasswd', '.git-credentials',
  // This app's own credential files (paths.js getCredentialFiles), for an install
  // whose knowledge folder IS its user-data folder.
  '.sync-config.json', '.curator-config.json', '.sharedbrain-config.json',
  'credentials', 'credentials.json', 'credentials.yml', 'credentials.yaml', 'credentials.toml',
  'secrets.json', 'secrets.yml', 'secrets.yaml', 'secrets.toml', 'secret.json',
  'service-account*.json', 'serviceAccount*.json', 'client_secret*.json',
  'token.json', 'auth.json',
];
const CREDENTIAL_TAILS = [['.aws', 'credentials'], ['.docker', 'config.json'], ['.kube', 'config']];
const CREDENTIAL_DIRS = ['.ssh', '.gnupg', '.knowledge-git'];

/** The same table as gitignore lines. A pattern holding a slash needs `**\/`. */
export const CREDENTIAL_GITIGNORE_RULES = [
  ...CREDENTIAL_BASENAMES,
  ...CREDENTIAL_TAILS.map((t) => `**/${t.join('/')}`),
  ...CREDENTIAL_DIRS.map((d) => `${d}/`),
];

const globToRegExp = (glob) =>
  new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
const BASENAME_RES = CREDENTIAL_BASENAMES.map(globToRegExp);
const DIR_SET = new Set(CREDENTIAL_DIRS.map((d) => d.toLowerCase()));

/** Is this work-tree-relative path (forward slashes) credential-shaped by name? */
export function isCredentialPath(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  if (BASENAME_RES.some((re) => re.test(base))) return true;
  const lower = parts.map((p) => p.toLowerCase());
  if (lower.slice(0, -1).some((p) => DIR_SET.has(p))) return true;
  return CREDENTIAL_TAILS.some((t) =>
    lower.length >= t.length && t.every((seg, i) => lower[lower.length - t.length + i] === seg.toLowerCase()));
}

// ── Obsidian plugin settings ─────────────────────────────────────────────────
//
// `.obsidian/plugins/<plugin>/data.json` is where plugins keep their settings,
// and AI plugins keep the user's API key there in plain text. The rest of
// `.obsidian/` keeps syncing (a confirmed decision, see DOMAINS_GITIGNORE_RULES);
// only a settings file that actually holds a key value is held back.
const PLUGIN_DATA_RE = /(^|\/)\.obsidian\/plugins\/[^/]+\/data\.json$/;
const SECRET_KEY_RE = /(api[-_ ]?key|secret|password|passwd|private[-_ ]?key|(access|auth|refresh|bearer)[-_ ]?token|^token$)/i;
const MIN_SECRET_LENGTH = 16;
const MAX_PLUGIN_FILE_BYTES = 5 * 1024 * 1024;

export function isPluginSettingsPath(rel) { return PLUGIN_DATA_RE.test(rel); }

/** Does this JSON hold a long string under a key-shaped name? Never returns the value. */
export function pluginSettingsHoldSecret(text) {
  let data;
  try { data = JSON.parse(text); } catch { return false; }
  const visit = (node, depth) => {
    if (depth > 8 || node === null || typeof node !== 'object') return false;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && v.length >= MIN_SECRET_LENGTH && SECRET_KEY_RE.test(k)) return true;
      if (visit(v, depth + 1)) return true;
    }
    return false;
  };
  return visit(data, 0);
}

// ── The walk ─────────────────────────────────────────────────────────────────

/**
 * Git's own test for an embedded repository, close enough to act on: `.git` as
 * a directory holding HEAD and objects, or `.git` as anything else (a gitfile, a
 * symlink). An empty `.git` folder is NOT one: git adds that folder's files as
 * ordinary files, so it is backed up and must not be reported otherwise.
 */
function isNestedGitEntry(dirAbs, entry) {
  if (entry.name !== '.git') return false;
  if (!entry.isDirectory()) return true;
  const p = path.join(dirAbs, '.git');
  return existsSync(path.join(p, 'HEAD')) && existsSync(path.join(p, 'objects'));
}

/**
 * Walk the work tree once: nested repositories (never descended into) and
 * plugin settings holding a key. Symlinks are not followed, because git stores
 * a symlink as a link. An unreadable folder is skipped: git will say so itself
 * if it matters, and this walk must never be what fails a sync.
 */
export async function scanWorkTree(base) {
  const nestedRepos = [];
  const secretPluginFiles = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(base, rel) : base;
    let entries;
    try { entries = await readdir(abs, { withFileTypes: true }); } catch { continue; }
    if (rel && entries.some((e) => isNestedGitEntry(abs, e))) {
      nestedRepos.push(rel);
      continue;
    }
    for (const e of entries) {
      if (e.name === '.git' && e.isDirectory()) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { stack.push(child); continue; }
      if (e.isFile() && isPluginSettingsPath(child)) {
        try {
          const buf = await readFile(path.join(base, child));
          if (buf.length <= MAX_PLUGIN_FILE_BYTES && pluginSettingsHoldSecret(buf.toString('utf8'))) {
            secretPluginFiles.push(child);
          }
        } catch { /* unreadable: nothing to send either */ }
      }
    }
  }
  return { nestedRepos: nestedRepos.sort(), secretPluginFiles: secretPluginFiles.sort() };
}

// ── The machine-local exclude block ──────────────────────────────────────────
//
// `<git dir>/info/exclude`, not `.gitignore`: whether a folder here has its own
// repository is a fact about THIS computer and must not travel to the others.

const BLOCK_START = '# >>> The Curator: left out of sync on this computer (rewritten on every sync)';
const BLOCK_END = '# <<< The Curator';

/** One anchored, literal gitignore line. Null when gitignore cannot express the name. */
export function anchoredIgnoreLine(rel, { dir = false } = {}) {
  if (/[\r\n]/.test(rel)) return null;
  const escaped = rel.replace(/[\\*?[\]]/g, '\\$&').replace(/ +$/, (m) => m.replace(/ /g, '\\ '));
  return `/${escaped}${dir ? '/' : ''}`;
}

export async function writeExcludeBlock(gitDir, lines) {
  const file = path.join(gitDir, 'info', 'exclude');
  let existing = '';
  try { existing = await readFile(file, 'utf8'); } catch { /* none yet */ }
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  const kept = start !== -1 && end > start
    ? existing.slice(0, start) + existing.slice(end + BLOCK_END.length).replace(/^\n/, '')
    : existing;
  const body = lines.filter(Boolean);
  const next = (kept && !kept.endsWith('\n') ? kept + '\n' : kept) +
    (body.length ? [BLOCK_START, ...body, BLOCK_END].join('\n') + '\n' : '');
  if (next === existing) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, next, 'utf8');
}

// ── Sorting what git left out into what a person can act on ──────────────────

const HOUSEKEEPING_BASENAMES = new Set(['.DS_Store', '.write-lock', '.mcp-write-log.jsonl']);
const HOUSEKEEPING_TOPS = new Set(['.ingest-queue', '.curator-trash', '.duplicate-checks', '.duplicate-jobs', '.recent-new-pages']);

/** credential · raw · obsidian · housekeeping · own (the user's own rule) */
export function classifyLeftOut(rel) {
  if (isCredentialPath(rel)) return 'credential';
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  if (parts.length >= 3 && parts[1] === 'raw') return 'raw';
  if (HOUSEKEEPING_BASENAMES.has(base) || HOUSEKEEPING_TOPS.has(parts[0])) return 'housekeeping';
  if (base === 'workspace.json' && parts[parts.length - 2] === '.obsidian') return 'housekeeping';
  if (base.endsWith('.base') || base === 'Untitled.md' || base === 'Untitled 1.md') return 'obsidian';
  return 'own';
}
