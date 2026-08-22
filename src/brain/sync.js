import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { mkdir, readFile, readdir, unlink, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { getDomainsDir } from './config.js';
import { writeFileAtomic } from './atomic-write.js';
import { clearStaleLock } from './write-registry.js';
import { APP_ROOT, getSyncGitDir, getSyncConfigFile } from './paths.js';

// v3.1.0+: the git dir and the stored PAT are USER DATA — they resolve through
// paths.js so they can live outside a read-only .app bundle. In a repo install
// getUserDataDir() === APP_ROOT, so both are byte-identical to the previous
// `path.join(ROOT, …)`. ROOT stays the CODE root: it is only used as an exec
// cwd (a directory guaranteed to exist), never written to.
//
// Resolved PER CALL below (currentGitDir/currentConfigFile) rather than
// snapshotted into consts — a module-load snapshot would defeat paths.js's test
// seams for anything imported before they're set, and this file's config holds
// the user's GitHub PAT.
const ROOT       = APP_ROOT;

const execAsync = promisify(exec);

// Test-only overrides — same pattern as config.js's __setDomainsDirOverride.
// Production code NEVER calls this; both stay null, so currentGitDir() /
// currentConfigFile() resolve to the real project's .knowledge-git and
// .sync-config.json exactly as before. Without this seam there is NO way to
// exercise git()/setup()/push()/pull() etc. in a test without operating on
// the user's REAL sync repo and REAL stored PAT — GIT_DIR/CONFIG_FILE are
// computed once from this file's own location, not from anything injectable
// via env or config. Battle tests point these at a disposable tempdir repo.
let _gitDirOverride = null;
let _configFileOverride = null;

/** Test seam — see the note above. Pass {} (or omit) to clear. */
export function __setSyncTestOverrides({ gitDir, configFile } = {}) {
  _gitDirOverride = gitDir || null;
  _configFileOverride = configFile || null;
}
function currentGitDir()     { return _gitDirOverride || getSyncGitDir(); }
function currentConfigFile() { return _configFileOverride || getSyncConfigFile(); }

// AppleScript's `do shell script` launches us with a minimal PATH. Prepend the
// usual locations for git/node/npm so subprocesses resolve them reliably.
const NODE_BIN_DIR = path.dirname(process.execPath);
const SUBPROCESS_PATH = [
  NODE_BIN_DIR, '/usr/local/bin', '/opt/homebrew/bin',
  '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  process.env.PATH || '',
].filter(Boolean).join(':');
const SUBPROCESS_ENV = { ...process.env, PATH: SUBPROCESS_PATH };

// ── Internal helpers ──────────────────────────────────────────────────────────

function sanitize(str) {
  return String(str)
    .replace(/https?:\/\/[^:@\s]+:[^@\s]*@/g, 'https://***@')
    .replace(/https?:\/\/[^@\s]+@/g,           'https://***@');
}

async function git(cmd, opts = {}) {
  const full = `git --git-dir="${currentGitDir()}" --work-tree="${getDomainsDir()}" ${cmd}`;
  try {
    const { stdout, stderr } = await execAsync(full, {
      timeout: opts.timeout || 30000,
      cwd: ROOT,              // Explicit cwd prevents "getcwd: Operation not permitted" on macOS
      env: SUBPROCESS_ENV,    // Ensure git is findable under the .app wrapper's minimal PATH
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    // exec's err.message includes stderr but NOT stdout. Git writes benign
    // status like "nothing to commit, working tree clean" to stdout, and the
    // callers below detect that via err.message.includes('nothing to commit').
    // Append stdout so those checks (setup commit, pull auto-save, friendlyError)
    // see it — otherwise a no-op commit crashes setup on an already-clean repo.
    const detail = err.stdout ? `${err.message}\n${err.stdout}` : err.message;
    throw new Error(sanitize(detail));
  }
}

function buildRemoteUrl(repoUrl, token) {
  let url = repoUrl.trim();
  // SSH → HTTPS
  if (url.startsWith('git@')) {
    url = url.replace(/^git@github\.com:/, 'https://github.com/');
  }
  url = url.replace(/\.git$/, '');
  const host = url.replace(/^https?:\/\//, '');
  return `https://${token}@${host}.git`;
}

function displayUrl(repoUrl) {
  return repoUrl
    .replace(/\.git$/, '')
    .replace(/^https?:\/\//, '');
}

function friendlyError(err) {
  const msg = err.message.toLowerCase();
  // These two only reach the user if recoverHygieneMergeConflict() (in
  // pull()) declined to auto-resolve — meaning at least one conflicting
  // path did NOT look like one of our own hygiene junk files (.write-lock /
  // .DS_Store), so it may be real wiki content. Never silently discard that;
  // give the user a clear, actionable message instead of raw git text.
  //
  // ORDER IS LOAD-BEARING (v3.0.16): these MUST stay above the auth branch.
  // A merge-conflict message embeds abbreviated commit SHAs and absolute
  // temp/repo paths; a bare `403`/`401` substring match against that whole
  // string fires at random (~0.7%/run — measured), telling a user with a real
  // content conflict to go regenerate their token while the merge sits
  // unresolved. Both phrases below are long and specific, so they cannot
  // shadow anything in the other direction.
  if (msg.includes('untracked working tree files would be overwritten')) {
    return 'Pull found local files that would be overwritten by incoming changes, and at least one ' +
           'doesn\'t look like a routine sync file. Back up your domains folder, then ask for help ' +
           'before syncing again — this needs a manual look.';
  }
  if (msg.includes('automatic merge failed') || msg.includes('fix conflicts and then commit')) {
    return 'Pull hit a real content conflict that couldn\'t be resolved automatically. Back up your ' +
           'domains folder, then ask for help before syncing again — this needs a manual look.';
  }
  if (msg.includes('authentication failed') || /\b(?:401|403)\b/.test(msg) ||
      msg.includes('could not read username')) {
    return 'GitHub rejected the token. For a fine-grained token, make sure it has ' +
           '"Contents: Read and write" on the repo; for a classic token, make sure ' +
           'it has the "repo" scope. Also check the token hasn\'t expired.';
  }
  if (msg.includes('repository not found') || msg.includes('does not exist') ||
      msg.includes('not found')) {
    return 'Repository not found. Check the URL — it must be a private repo you own.';
  }
  if (msg.includes('could not resolve host') || msg.includes('connection refused') ||
      msg.includes('unable to access')) {
    return 'Cannot reach GitHub. Check your internet connection and try again.';
  }
  if (msg.includes('non-fast-forward') || msg.includes('rejected')) {
    return 'GitHub has changes you don\'t have locally. Click "Pull only" first (under Advanced), then sync again.';
  }
  if (msg.includes('nothing to commit')) {
    return null; // Not an error
  }
  return sanitize(err.message);
}

// ── Config ────────────────────────────────────────────────────────────────────

async function saveConfig(repoUrl, token) {
  // v3.0.1-beta.20: atomic + 0600 — .sync-config.json holds the GitHub PAT, so
  // it must not be world-readable, and a kill mid-write must not lose the token.
  await writeFileAtomic(currentConfigFile(), JSON.stringify({ repoUrl, token }, null, 2), { mode: 0o600 });
}

async function loadConfig() {
  if (!existsSync(currentConfigFile())) return null;
  try { return JSON.parse(await readFile(currentConfigFile(), 'utf8')); } catch { return null; }
}

// ── Domains .gitignore ────────────────────────────────────────────────────────

// What we want excluded from sync, per-domain:
//   */raw/                       — uploaded source files (large, local-only)
//   */.mcp-write-log.jsonl       — MCP audit log (v2.5.2+, machine-private)
const DOMAINS_GITIGNORE_RULES = [
  '*/raw/',
  '*/.mcp-write-log.jsonl',
  // Cross-process write lock (src/brain/write-registry.js) is machine-local
  // state, not wiki content. If it's synced and a crash leaves it stale, a
  // machine that pulls it can refuse writes for up to 30 minutes because
  // isPidAlive() sees a foreign PID number.
  '*/.write-lock',
  // Finder's per-directory metadata cache. No `*/` prefix needed — a bare
  // ".DS_Store" pattern (no slash anywhere in it) matches at ANY depth per
  // git's own gitignore rules, so this covers domains/.DS_Store,
  // domains/<d>/.DS_Store, domains/<d>/wiki/.DS_Store, etc. in one line.
  // Every Finder touch on a synced folder produces a meaningless pending
  // change and inflates the navbar sync badge for no reason.
  '.DS_Store',
];

async function ensureDomainsGitignore() {
  const p = path.join(getDomainsDir(), '.gitignore');
  let existing = '';
  if (existsSync(p)) {
    try { existing = await readFile(p, 'utf8'); } catch {}
  }
  // A CRLF-saved .gitignore (e.g. edited on Windows, or normalised by some
  // text editor — Windows is a supported manual-install target) has a
  // trailing \r on every line. git's own gitignore parser does NOT strip
  // that \r, so a pattern written as "*/.write-lock\r" matches nothing —
  // silently. Our own existence check below runs .trim() (which DOES strip
  // \r) to decide whether a rule is "already present", so without this
  // guard we'd conclude the file is already correct and never rewrite it,
  // leaving the ineffective \r-suffixed pattern in place forever. Force a
  // rewrite (which always emits clean LF-only lines) whenever any \r is
  // found anywhere in the existing file, regardless of the trimmed match.
  const hasCarriageReturn = existing.includes('\r');
  const lines = existing.split('\n').map(l => l.trim()).filter(Boolean);
  let changed = hasCarriageReturn;
  for (const rule of DOMAINS_GITIGNORE_RULES) {
    if (!lines.includes(rule)) {
      lines.push(rule);
      changed = true;
    }
  }
  if (!existing || changed) {
    // v3.0.1-beta.20: atomic — a truncated .gitignore could let raw/ source
    // files get committed to GitHub on the next push.
    await writeFileAtomic(p, lines.join('\n') + '\n', 'utf8');
  }
}

// A gitignore rule does NOT untrack a file that's already committed — it only
// keeps NEW/untracked files out. If a `.write-lock` (or a Finder `.DS_Store`)
// was committed before its rule existed (write-lock: realistically reachable
// because the MCP server is a SEPARATE child process from the web server, so
// it can hold the *file* lock — see src/brain/write-registry.js — while the
// web server's in-memory write registry is empty; a Sync click in that
// window runs `git add -A` and commits the lock file), it would keep
// propagating to every machine forever. The functions below walk the ACTUAL
// tracked paths (via `git ls-files`, never a raw shell glob) and untrack
// only the ones matching the exact expected shape.

/**
 * List tracked paths matching `pathspec`, NUL-delimited. `-z` output is
 * never C-quoted — git's DEFAULT (newline-terminated) mode octal-escapes any
 * non-ASCII byte in a path (e.g. a "café" domain's tracked file renders as
 * `"caf\303\251/.write-lock"`), which used to defeat the ASCII-only
 * character-class check below and silently skip the untrack for non-ASCII
 * domain names. Domain slugs are NOT restricted to ASCII — createDomain() in
 * files.js only rejects '..', '/', '\\', and a leading '.' — so this is the
 * real fix (not a documented limitation): `-z` sidesteps quoting entirely
 * and gives back raw UTF-8 bytes, and NUL-splitting is the correct way to
 * consume it (also more robust than newline-splitting in general).
 */
async function listTrackedGlob(pathspec) {
  let stdout;
  try {
    ({ stdout } = await git(`ls-files -z -- "${pathspec}"`));
  } catch {
    return []; // no repo / nothing tracked yet — safe no-op
  }
  return stdout.split('\0').filter(Boolean);
}

/**
 * Is `seg` safe to interpolate into the double-quoted shell argument the
 * `git rm --cached` call below builds (exec() runs everything through
 * `/bin/sh -c "..."`)? Rejects control characters, path separators,
 * quoting/shell metacharacters, the `.`/`..` traversal segments, AND git
 * PATHSPEC-MAGIC characters (`:` `!` `*` `?` `[` `]`). Everything else —
 * including non-ASCII letters — is allowed.
 *
 * The pathspec-magic rejection closes a HIGH-severity finding from an
 * adversarial audit: `createDomain()` in files.js only rejects '..', '/',
 * '\\', and a leading '.' — so a domain literally named `:!x` is a LEGAL
 * filesystem name and would have passed the character-shape checks that
 * predate this fix. But git's DEFAULT (non-literal) pathspec parser reads a
 * leading `:` as introducing MAGIC (`:!`/`:^` = an EXCLUDE pathspec, `:(...)`
 * = named magic) and treats `*`/`?`/`[` as glob wildcards even without
 * explicit `:(glob)` magic — so `git rm --cached -- ":!x/.DS_Store"` is not
 * parsed as "delete this literal path" at all; it's parsed as an EXCLUDE
 * pathspec with no positive match to exclude FROM. The audit's own
 * escalation attempt was blocked by an unrelated git safety guard (`fatal:
 * not removing '.' recursively without -r`), so this was not a data-loss
 * vector as found — but the malformed command throws, gets swallowed by the
 * surrounding best-effort catch, and the untrack silently no-ops FOREVER for
 * that domain, which is the exact bug class this whole module exists to
 * fix. Belt-and-suspenders: the actual `git rm --cached` / `git add`
 * invocations that use an already-validated path ALSO pass
 * `--literal-pathspecs`, which disables ALL pathspec-magic interpretation
 * for that one command regardless of this character check.
 */
function isSafePathSegment(seg) {
  if (!seg || seg === '.' || seg === '..') return false;
  return !/[\x00-\x1f\x7f/\\'"`$;|&<>\n\r:!*?[\]]/.test(seg);
}

/**
 * Validate that a path reported by `git ls-files` has the EXACT shape we
 * expect before it's used to build a `git rm --cached` command: it must end
 * with the literal `finalName`, and — when `exactDepth` is a number rather
 * than `null` — have precisely that many directory segments in front of it
 * (e.g. exactly 1, a bare domain slug, for `<domain>/.write-lock`).
 * `.DS_Store` can legitimately sit at ANY depth (Finder drops it wherever it
 * likes), so its caller passes `exactDepth: null` to allow zero or more
 * segments. Every segment is checked with isSafePathSegment — no `..`, no
 * shell metacharacters, no control characters — so nothing about this path
 * can escape the quoting used when it's later passed to git.
 */
function isSafeTrackedPath(p, finalName, exactDepth) {
  if (typeof p !== 'string' || !p) return false;
  const parts = p.split('/');
  if (parts[parts.length - 1] !== finalName) return false;
  const dirParts = parts.slice(0, -1);
  if (exactDepth !== null && dirParts.length !== exactDepth) return false;
  return dirParts.every(isSafePathSegment);
}

async function untrackStaleWriteLocks() {
  const candidates = await listTrackedGlob('*/.write-lock');
  const untracked = [];
  for (const p of candidates) {
    if (!isSafeTrackedPath(p, '.write-lock', 1)) continue;
    try {
      await git(`--literal-pathspecs rm --cached --ignore-unmatch -- "${p}"`);
      untracked.push(p);
    } catch { /* best-effort — a failed untrack here must never block sync */ }
  }
  return untracked;
}

/**
 * Same pattern as untrackStaleWriteLocks(), for `.DS_Store` — Finder drops
 * these into any folder it browses, and once one is accidentally committed
 * (e.g. from an early sync before this rule existed) it re-syncs to every
 * machine on every push/pull and inflates the pending-changes badge for a
 * file with zero wiki content.
 */
async function untrackStaleDSStore() {
  const candidates = await listTrackedGlob('*.DS_Store');
  const untracked = [];
  for (const p of candidates) {
    if (!isSafeTrackedPath(p, '.DS_Store', null)) continue;
    try {
      await git(`--literal-pathspecs rm --cached --ignore-unmatch -- "${p}"`);
      untracked.push(p);
    } catch { /* best-effort */ }
  }
  return untracked;
}

/**
 * Best-effort local hygiene: delete any `.write-lock` FILE left on disk that
 * the EXISTING staleness rule in write-registry.js (clearStaleLock — age >
 * LOCK_STALE_MS, or the owning PID is no longer alive) already considers
 * dead. `untrackStaleWriteLocks()` above only removes a committed lock from
 * git's INDEX — `git rm --cached` never touches the working tree — so a
 * genuinely dead lock could be left sitting on disk indefinitely (v3.0.15
 * shipped that gap; see CLAUDE.md's "Deferred to v3.0.16" note). This does
 * NOT invent a second, looser definition of staleness: it defers entirely to
 * write-registry.js's own rule, so a lock a live process (this one or the
 * separate MCP child process) still legitimately holds is never touched.
 */
async function cleanupStaleLocalLocks() {
  const base = getDomainsDir();
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const cleared = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const domainDir = path.join(base, entry.name);
    try {
      if (await clearStaleLock(domainDir)) cleared.push(entry.name);
    } catch { /* best-effort — never block sync */ }
  }
  return cleared;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isConfigured() {
  return existsSync(currentGitDir()) && existsSync(currentConfigFile());
}

export async function getStatus() {
  if (!isConfigured()) return { configured: false };

  const config = await loadConfig();
  try {
    const { stdout: statusOut } = await git('status --porcelain');
    const changesCount = statusOut.split('\n').filter(Boolean).length;

    let lastSync = null;
    try {
      const { stdout } = await git('log -1 --format=%ci');
      lastSync = stdout.trim() || null;
    } catch { /* no commits yet */ }

    return {
      configured: true,
      changesCount,
      lastSync,
      repoUrl: config ? displayUrl(config.repoUrl) : null,
    };
  } catch (err) {
    return { configured: true, error: sanitize(err.message) };
  }
}

export async function setup(repoUrl, token, mode) {
  await ensureDomainsGitignore();
  await mkdir(currentGitDir(), { recursive: true });

  const remoteUrl = buildRemoteUrl(repoUrl, token);

  // Init and configure git identity + auto-upstream for push
  await git('init');
  await git('config user.email "thecurator@local"');
  await git('config user.name "The Curator"');
  await git('config push.autoSetupRemote true');

  // Set remote (add or update)
  try {
    await git(`remote add origin "${remoteUrl}"`);
  } catch {
    await git(`remote set-url origin "${remoteUrl}"`);
  }

  if (mode === 'push') {
    await git('add -A');
    try {
      await git('commit -m "Initial The Curator sync"');
    } catch (err) {
      if (!err.message.includes('nothing to commit')) throw err;
    }
    await git('branch -M main');
    await git('push -u origin main', { timeout: 120000 });

  } else { // pull
    await git('fetch origin', { timeout: 120000 });
    try {
      await git('checkout -b main origin/main');
    } catch {
      try {
        await git('checkout main');
        await git('reset --hard origin/main');
      } catch {
        await git('reset --hard origin/main');
      }
    }
  }

  await saveConfig(repoUrl, token);
}

export async function push() {
  // Self-heal: existing installs configured before a DOMAINS_GITIGNORE_RULES
  // addition (e.g. the */.write-lock rule) never re-run ensureDomainsGitignore()
  // otherwise — it was previously only called from setup(). Idempotent no-op
  // when the file is already current.
  await ensureDomainsGitignore();

  // Self-heal part 2: the gitignore rule only keeps FUTURE .write-lock /
  // .DS_Store files from being tracked — it does nothing for ones already
  // committed. Untrack any that are, BEFORE the status/commit below, so the
  // removal rides along with this push's commit instead of needing a second
  // sync round-trip.
  //
  // NOTE on ordering (audit finding, HIGH severity — see pull() below for
  // the full writeup and the fix): running the untrack BEFORE a MERGE is
  // what's unsafe, because `git rm --cached` leaves the file on disk as
  // untracked, and a merge that still wants to write a TRACKED version to
  // that same path refuses to clobber it. push() never merges anything —
  // it only stages/commits/pushes, and a rejected (non-fast-forward) push
  // doesn't touch the local working tree or index AT ALL (git refuses
  // server-side, before anything local changes). So there is no merge
  // step inside push() for the untrack to race against, and this ordering
  // is safe to leave as-is. The actual exposure a rejected push creates is
  // indirect: friendlyError() tells the user to "Pull only" first, and
  // it's THAT pull() call that used to hit the bug — fixed at the source
  // in pull() rather than by reordering here.
  await untrackStaleWriteLocks();
  await untrackStaleDSStore();

  // Self-heal part 3: local-only hygiene, no git involved — clear any
  // `.write-lock` FILE on disk that write-registry.js's own staleness rule
  // already considers dead (untrack above only removes it from git's index).
  await cleanupStaleLocalLocks();

  // Stage and commit any uncommitted changes
  const { stdout } = await git('status --porcelain');
  const uncommittedCount = stdout.split('\n').filter(Boolean).length;

  if (uncommittedCount > 0) {
    const now  = new Date();
    const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    await git('add -A');
    // `add -A` can legitimately cancel out everything `status --porcelain`
    // counted above — most concretely, untrackStaleWriteLocks() staging a
    // "D  <domain>/.write-lock" deletion (counted as 1+ of uncommittedCount)
    // followed by this add -A RE-ADDING that same still-on-disk file if the
    // domains .gitignore doesn't yet effectively exclude it (e.g. a stale
    // CRLF-suffixed pattern on a pre-fix install) — the add cancels the
    // delete back to a clean index, and an unguarded commit then throws
    // "nothing to commit" and takes push() down with it. setup() and pull()
    // already guard their own commits this way; push() must match.
    try {
      await git(`commit -m "The Curator sync — ${date} ${time} — ${uncommittedCount} change${uncommittedCount !== 1 ? 's' : ''}"`);
    } catch (err) {
      if (!err.message.includes('nothing to commit')) throw err;
    }
  }

  // Determine what will be pushed BEFORE pushing. We want the union of files
  // changed across ALL unpushed commits — including commits made earlier in
  // this sync by pull()'s auto-save. The previous implementation only counted
  // the most recent commit's diff, so a big ingest that got split into
  // multiple commits by pull() → push() would show a wildly-wrong count like
  // "6 files" for a 200-file change.
  // Count files we're actually sending TO remote. Naive `diff origin/main..HEAD`
  // is symmetric: when local merged a remote commit (`-X theirs`), files that
  // origin had — but local didn't touch — still show up as "differing", which
  // inflates the count. Use `merge-base` so the count reflects only what local
  // is genuinely adding on top of the common ancestor (v3.0.1-beta.6).
  let aheadCount = 0;
  let filesToPush = 0;
  let filePreview = [];
  try {
    const { stdout: ahead } = await git('rev-list --count origin/main..HEAD');
    aheadCount = parseInt(ahead.trim(), 10) || 0;
    if (aheadCount > 0) {
      const { stdout: baseOut } = await git('merge-base HEAD origin/main');
      const base = baseOut.trim();
      const diffRange = base ? `${base}..HEAD` : 'origin/main..HEAD';
      const { stdout: names } = await git(`diff --name-only ${diffRange}`);
      const list = names.split('\n').filter(Boolean);
      filesToPush = list.length;
      filePreview = list.slice(0, 20);
    }
  } catch {
    // First push ever: origin/main doesn't exist yet. Count tracked files.
    try {
      const { stdout: names } = await git('ls-files');
      const list = names.split('\n').filter(Boolean);
      filesToPush = list.length;
      filePreview = list.slice(0, 20);
      aheadCount = 1;
    } catch { filesToPush = uncommittedCount; aheadCount = 1; }
  }

  if (aheadCount === 0) {
    return {
      pushed: false,
      filesChanged: 0,
      commitsAhead: 0,
      message: 'Everything is already up to date — nothing new to sync.',
    };
  }

  await git('push -u origin main', { timeout: 120000 });

  return {
    pushed: true,
    filesChanged: filesToPush,
    commitsAhead: aheadCount,
    files: filePreview,
    // Back-compat: `changesCount` was the field the UI used before v2.3.7
    changesCount: filesToPush,
  };
}

export async function pull() {
  // Self-heal: see push() — keeps .gitignore current on installs configured
  // before a DOMAINS_GITIGNORE_RULES addition. Safe to run before the merge:
  // it only writes a config FILE, never touches a path the incoming merge
  // might also want to write.
  await ensureDomainsGitignore();

  // Auto-commit local changes so the pull merge succeeds — unchanged,
  // pre-existing behaviour (real content, unrelated to hygiene).
  const { stdout } = await git('status --porcelain');
  if (stdout.trim()) {
    const date = new Date().toLocaleString();
    await git('add -A');
    try {
      await git(`commit -m "Auto-save before sync — ${date}"`);
    } catch (err) {
      if (!err.message.includes('nothing to commit')) throw err;
    }
  }

  // Fetch remote state without merging yet, so we can count what's incoming.
  await git('fetch origin main', { timeout: 120000 });

  // Count files actually coming FROM remote. Naive `diff HEAD..origin/main`
  // is symmetric — it counts files differing in EITHER direction, including
  // files we modified locally in the auto-save commit above. That produces
  // confusing reports like "pulled 206 / pushed 206" for the same 206 files.
  // Using `merge-base` lets us count only files origin advanced beyond the
  // common ancestor (v3.0.1-beta.6).
  let filesPulled = 0;
  let commitsPulled = 0;
  let filePreview = [];
  try {
    const { stdout: cnt } = await git('rev-list --count HEAD..origin/main');
    commitsPulled = parseInt(cnt.trim(), 10) || 0;
    if (commitsPulled > 0) {
      const { stdout: baseOut } = await git('merge-base HEAD origin/main');
      const base = baseOut.trim();
      if (base) {
        const { stdout: names } = await git(`diff --name-only ${base}..origin/main`);
        const list = names.split('\n').filter(Boolean);
        filesPulled = list.length;
        filePreview = list.slice(0, 20);
      }
    }
  } catch { /* no remote yet — first sync, pull will do the right thing */ }

  // ── ORDERING IS LOAD-BEARING (HIGH-severity adversarial-audit finding,
  // fixed here) ──────────────────────────────────────────────────────────
  // untrackStaleWriteLocks()/untrackStaleDSStore()/cleanupStaleLocalLocks()
  // used to run HERE, before the merge below. That is unsafe: `git rm
  // --cached` removes a path from the INDEX but leaves it on disk — an
  // UNTRACKED file. If origin/main's incoming tree still (or again — Finder
  // rewrites .DS_Store on essentially every folder browse) carries that same
  // path as TRACKED, git's merge preflight check refuses to clobber the
  // untracked local file:
  //
  //   error: The following untracked working tree files would be
  //   overwritten by merge:
  //           .DS_Store
  //   Please move or remove them before you merge.
  //   Aborting
  //
  // — a hard, non-retryable failure (exit 2, no merge state created) that
  // used to have no friendlyError() mapping, so the user saw raw git text
  // and Sync was simply broken. Reproduced against real git with two
  // machines sharing a bare remote (see test-sync-hygiene.js's "pull()
  // merge-safety ordering" section) — this is not theoretical: the real
  // knowledge repo carries exactly these three paths today, at three
  // different depths.
  //
  // Fix: run the untrack/cleanup AFTER a successful merge, never before.
  // While `.write-lock`/`.DS_Store` are still tracked locally at merge
  // time, the merge treats them as normal file updates instead of an
  // untracked-file collision.
  let pullOut;
  try {
    ({ stdout: pullOut } = await git('pull --no-rebase -X theirs origin main', { timeout: 120000 }));
  } catch (err) {
    // Even with the reordering above, the SAME preflight check (or a
    // genuine modify/delete conflict — see recoverHygieneMergeConflict) can
    // still occur during the fleet-wide transition window: any OTHER
    // machine not yet updated to this fix can still push a tracked,
    // Finder-touched .DS_Store, and THIS machine may have already untracked
    // its own copy on an earlier pull/push cycle, leaving it untracked-on-
    // disk again by the time this merge runs. Recover automatically, but
    // ONLY when every implicated path is unambiguously one of our own
    // hygiene junk files — never for anything that could be real wiki
    // content.
    pullOut = await recoverHygieneMergeConflict(err);
  }

  // NOW it's safe: whatever origin had for these paths has already been
  // merged in (or the recovery above resolved the one conflict shape our
  // own hygiene files can cause), so `git rm --cached` here can no longer
  // collide with a still-pending merge write.
  await untrackStaleWriteLocks();
  await untrackStaleDSStore();
  await cleanupStaleLocalLocks();

  // If the post-merge untrack staged anything, commit it now so pull() still
  // fully self-heals in one call — matches push()'s existing behaviour of
  // bundling the untrack into a real commit, instead of leaving the user
  // with dangling uncommitted changes after a "Pull only" click.
  const { stdout: postStatus } = await git('status --porcelain');
  if (postStatus.trim()) {
    await git('add -A');
    try {
      await git(`commit -m "Sync hygiene cleanup — ${new Date().toLocaleString()}"`);
    } catch (err) {
      if (!err.message.includes('nothing to commit')) throw err;
    }
  }

  // Prune ghost domain directories. When another machine deletes a domain, the
  // pull removes every tracked file, but empty dirs are left behind because git
  // doesn't track them.
  const pruned = await pruneGhostDomainDirs();

  return {
    pulled: true,
    filesChanged: filesPulled,
    commitsPulled,
    files: filePreview,
    pruned,
    details: pullOut,
  };
}

/**
 * Recovery for the two merge-failure shapes our own hygiene files
 * (.write-lock / .DS_Store) can cause, both verified against real git:
 *
 *  (A) PREFLIGHT ABORT — "The following untracked working tree files would
 *      be overwritten by merge". Fires BEFORE the merge algorithm starts, so
 *      nothing was merged and no conflict state exists. Cause: an earlier
 *      untrack (this module's own untrackStaleWriteLocks/DSStore, from a
 *      previous sync cycle) left the file on disk as untracked; origin
 *      still (or again) has it tracked at that exact path.
 *
 *  (B) MODIFY/DELETE CONFLICT — "CONFLICT (modify/delete): <path> deleted
 *      in HEAD and modified in <sha>". Fires mid-merge when the physical
 *      file was ALSO absent locally (e.g. cleanupStaleLocalLocks() just
 *      deleted a stale .write-lock, or the untracked copy was manually
 *      removed) so the preflight check in (A) doesn't trip, but the commit
 *      graph itself genuinely diverges (we deleted-from-index, they
 *      modified). With `-X theirs`, git already resolves the CONTENT (keeps
 *      theirs' version) but leaves the merge uncommitted — `git status
 *      --porcelain` reports the path with a "U" in one of its two status
 *      columns (DU/UD/AU/UA/UU/AA).
 *
 * BOTH shapes are recovered ONLY when EVERY implicated path matches our own
 * junk patterns (isHygieneJunkPath) — content we already decided to stop
 * tracking, by definition disposable. The instant any implicated path looks
 * like it could be real wiki content, this re-throws the ORIGINAL error
 * unchanged: auto-resolving a genuine merge conflict risks silently
 * discarding the user's work, which must never happen.
 */
async function recoverHygieneMergeConflict(err) {
  const untrackedPaths = extractUntrackedOverwritePaths(err.message);
  if (untrackedPaths.length > 0) {
    if (!untrackedPaths.every(isHygieneJunkPath)) throw err;
    for (const p of untrackedPaths) {
      try { await unlink(path.join(getDomainsDir(), p)); } catch { /* best-effort */ }
    }
    // Nothing was merged yet — the preflight check aborts before any merge
    // state is created — so a plain retry is the correct next step. If this
    // retry ALSO throws (e.g. a genuinely different problem), it propagates
    // unchanged to the caller; we deliberately do not loop/recurse here.
    const { stdout } = await git('pull --no-rebase -X theirs origin main', { timeout: 120000 });
    return stdout;
  }

  // Shape B: an in-progress conflicted merge. `git status --porcelain` (with
  // quoting disabled so a non-ASCII path isn't C-quoted and mismatched
  // against isHygieneJunkPath) is the source of truth for exactly which
  // paths are unresolved — more reliable than re-parsing the error text,
  // which is not guaranteed to enumerate every conflicting path.
  const { stdout: statusOut } = await git('-c core.quotePath=false status --porcelain');
  const unmerged = statusOut.split('\n')
    .filter(Boolean)
    .filter(line => /^(?:DU|UD|AU|UA|UU|AA)[ \t]/.test(line))
    .map(line => line.slice(3));

  if (unmerged.length === 0 || !unmerged.every(isHygieneJunkPath)) throw err;

  for (const p of unmerged) {
    // --literal-pathspecs: defense in depth alongside isHygieneJunkPath's
    // own pathspec-magic character rejection (same reasoning as
    // untrackStaleWriteLocks/DSStore above).
    await git(`--literal-pathspecs add -A -- "${p}"`);
  }
  try {
    await git('commit --no-edit');
  } catch (commitErr) {
    if (!commitErr.message.includes('nothing to commit')) throw commitErr;
  }
  return '(merge completed — auto-resolved a conflict on hygiene-only files: .write-lock/.DS_Store)';
}

function isHygieneJunkPath(p) {
  return isSafeTrackedPath(p, '.write-lock', 1) || isSafeTrackedPath(p, '.DS_Store', null);
}

/**
 * Parse the exact path list out of git's "untracked working tree files
 * would be overwritten by merge" preflight-abort message — each blocked
 * path is tab-indented on its own line between the marker line and the
 * "Please move or remove them" line. Verified against real git output for
 * single- and multi-path ASCII cases.
 *
 * KNOWN GAP (v3.0.16, non-ASCII domain names): git C-quotes non-ASCII bytes
 * in THIS message as octal escapes (`caf\303\251/.DS_Store`), and unlike
 * `status --porcelain` — which Shape B fixes with `-c core.quotePath=false`
 * — that option does NOT affect the merge-preflight text. So the extracted
 * string keeps its backslashes, `isSafePathSegment` rejects it, the
 * `every(isHygieneJunkPath)` gate is false, and the original error is
 * rethrown. Net effect: for a domain named e.g. `cafe\u0301` or a CJK name, a
 * .DS_Store collision does NOT self-heal — the user gets the "needs a
 * manual look" message for a zero-content junk file. FAIL-SAFE (nothing is
 * deleted or auto-committed), but the self-heal silently never fires.
 * To close it, decode git's C-quoting here (expand \NNN octal triplets to
 * bytes, decode UTF-8, unescape \\ \" \t \n) BEFORE validating.
 */
function extractUntrackedOverwritePaths(message) {
  const marker = 'The following untracked working tree files would be overwritten by merge:';
  const idx = message.indexOf(marker);
  if (idx === -1) return [];
  const lines = message.slice(idx + marker.length).split('\n');
  const paths = [];
  for (const line of lines) {
    if (line.startsWith('\t')) {
      paths.push(line.slice(1).trim());
    } else if (paths.length > 0) {
      break;
    }
  }
  return paths;
}

/**
 * Remove any directory under the domains root that has no CLAUDE.md.
 * Called after pull so sync-delete from another machine fully takes effect.
 * Returns the list of pruned domain names (usually empty).
 */
async function pruneGhostDomainDirs() {
  const base = getDomainsDir();
  const pruned = [];
  let entries;
  try {
    const { readdir } = await import('fs/promises');
    entries = await readdir(base, { withFileTypes: true });
  } catch { return pruned; }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dirPath = path.join(base, entry.name);
    const schemaPath = path.join(dirPath, 'CLAUDE.md');
    if (existsSync(schemaPath)) continue;    // real domain, keep
    // Schema is gone → ghost directory. Remove it recursively.
    try {
      await rm(dirPath, { recursive: true, force: true });
      pruned.push(entry.name);
    } catch { /* best-effort; fall through */ }
  }
  return pruned;
}

export async function sync() {
  // Bidirectional sync: pull remote changes first, then push local changes.
  // This is the safest order — always get the latest before pushing.
  const pullResult = await pull();
  const pushResult = await push();
  return { pullResult, pushResult };
}

export async function disconnect() {
  if (existsSync(currentGitDir()))    await rm(currentGitDir(), { recursive: true, force: true });
  if (existsSync(currentConfigFile())) await unlink(currentConfigFile());
}

export { friendlyError };

// Test-only surface for internal helpers that have no other public entry
// point. Production code never imports this. Mirrors the __testing pattern
// already used by atomic-write.js and write-registry.js.
export const __testing = {
  isSafePathSegment,
  isSafeTrackedPath,
  listTrackedGlob,
  untrackStaleWriteLocks,
  untrackStaleDSStore,
  cleanupStaleLocalLocks,
  ensureDomainsGitignore,
  DOMAINS_GITIGNORE_RULES,
  recoverHygieneMergeConflict,
  isHygieneJunkPath,
  extractUntrackedOverwritePaths,
};
