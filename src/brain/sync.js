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

// ── The single fetch chokepoint ───────────────────────────────────────────────
//
// EVERY `git fetch` this module issues goes through gitFetch(), and the
// source guard in test-sync-hygiene.js asserts there is exactly ONE raw
// fetch invocation in this file — the one inside gitFetch's own body. That
// is deliberately a CLASS invariant rather than a per-call-site one: this
// project's named recurring defect is a guard applied to the instance in
// front of its author while a sibling doing identical work stays
// unprotected (v3.6.0 shipped four of those in one release). A future
// fourth fetch site written as a bare invocation of the git() helper goes
// RED instead of silently re-arming what follows.
//
// WHY A GATE AT ALL — reproduced against real git, 11 of 12 runs:
// getRemoteStatus()'s background fetch and pull()'s reporting fetch both
// write `refs/remotes/origin/main`. Two concurrent fetches are a
// compare-and-swap race on that ref, and the LOSER dies with
//
//   error: cannot lock ref 'refs/remotes/origin/main': is at <a> but
//   expected <b>  ! <b>..<a>  main -> origin/main (unable to update local ref)
//
// Before this gate, that landed on the USER'S PULL (see pull()) and the
// sync silently did not happen. Serialising in-process removes the
// collision at its source rather than teaching each caller to survive it.
//
// NOT A REPLACEMENT for pull()'s own tolerance of a failed reporting fetch.
// This gate is per-PROCESS, and the MCP server Claude Desktop spawns is a
// separate process against the same git dir, as is a second app instance.
// Two layers, and pull()'s comment says which one it is not allowed to
// lean on.
let _fetchGate = Promise.resolve();

// Real `git fetch` subprocesses issued by this module. The invariant these
// fixes exist to hold is "how many actually ran", so it is asserted where
// it means it — on the call itself — rather than inferred from a timestamp
// or a duration. Same instrument, and the same reasoning, as v3.3.0's
// independent in-flight counter around the one ingestFileImpl call.
let _fetchCount = 0;

function gitFetch(args, opts) {
  // ONE raw fetch invocation in this whole file — see the class invariant
  // above. Both arms of the .then() below share it, so a rejected
  // predecessor does not become a second literal call site the guard would
  // have to learn about.
  const runOne = () => { _fetchCount++; return git(`fetch ${args}`, opts); };
  // TWO LAYERS, and NEITHER IS INDIVIDUALLY LOAD-BEARING — stated that way
  // because it was measured, not assumed. The gate must survive a
  // rejection: one failed fetch must not wedge every later one for the
  // process lifetime (a permanently dead badge and a permanently
  // mis-counted pull). Both the rejection arm of the .then() below and the
  // SETTLED chain after it achieve that independently, so mutating either
  // one alone leaves the suite fully green; removing BOTH turns it red in
  // 14 places. Recorded here rather than presented as one guard doing the
  // work, which is what the v3.4.0 pairing rule exists to prevent.
  const run = _fetchGate.then(runOne, runOne);
  _fetchGate = run.then(() => {}, () => {});
  return run;
}

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
  // A losing ref compare-and-swap between two concurrent fetches. gitFetch()
  // serialises this process's own fetches and pull() no longer dies on it,
  // so a user should never see this — but a SEPARATE process against the
  // same git dir (the MCP server Claude Desktop spawns; a second app
  // instance) is outside that gate, and the raw git text carries three
  // absolute filesystem paths. Mapped, and kept ABOVE the auth branch for
  // the v3.0.16 reason the two branches above it are: this message embeds
  // full 40-char SHAs, so a bare `401`/`403` substring test against it fires
  // at random. The phrase below is long and specific and cannot shadow in
  // the other direction.
  if (msg.includes('cannot lock ref') || msg.includes('unable to update local ref')) {
    return 'Another sync check was running at the same time, so this one stopped early. ' +
           'Nothing was changed — wait a moment and try again.';
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
  // Batch-ingest queue (Track 3, src/brain/ingest-queue.js). Purely defensive:
  // getIngestQueueDir() (src/brain/paths.js) resolves OUTSIDE getDomainsDir()
  // by construction, so this rule should never need to match anything on a
  // normal install. It exists only for the pathological case of a user
  // pointing domainsPath at the same directory as their user-data dir (e.g.
  // the app root in repo mode) — in which case the queue's staged source
  // files (which can be large, and are mid-batch operational state, not wiki
  // content) must not get swept into a sync commit.
  '.ingest-queue/',
  // v3.5.1: Obsidian's workspace state — rewritten on essentially every pane
  // move/resize/tab switch, so tracking it produces a pending change on
  // almost every Obsidian interaction (same class of noise as .DS_Store).
  // Scope is DELIBERATELY narrow to this ONE file: whether
  // appearance/graph/plugin settings (the rest of .obsidian/) sync across
  // machines is a user preference, not ours to impose — confirmed decision,
  // do not widen this to '.obsidian/' wholesale.
  //
  // MUST keep the leading '**/': per gitignore(5), a pattern containing a
  // slash ANYWHERE other than a single trailing one is anchored to the
  // directory holding the .gitignore file (unlike the slash-free '.DS_Store'
  // rule above, which matches at any depth for free). Without '**/' this
  // rule would only ever match domains/.obsidian/workspace.json — never the
  // documented vault roots one or two levels down
  // (domains/<domain>/.obsidian/… or domains/<domain>/wiki/.obsidian/…),
  // which is where a real Obsidian vault actually puts it. Caught live: the
  // untrack ran fine (git ls-files pathspec matching is unaffected — it
  // isn't gitignore-based), but the very next `git add -A` inside the same
  // push()/pull() cycle silently RE-STAGED the file because gitignore never
  // actually excluded that nested path, undoing the untrack in the same
  // commit. `**/foo` is exactly what gitignore(5) documents for "match in
  // all directories".
  '**/.obsidian/workspace.json',
  // Obsidian leftover files — created when the vault root is pointed at the
  // wrong folder, or a wikilink resolves to nothing and Obsidian auto-
  // creates an empty stub note. These three entries MIRROR the app repo's
  // own .gitignore "Obsidian leftover files" block (see the root .gitignore)
  // — not new patterns, the same ones already proven necessary there,
  // applied to the knowledge repo too.
  '*.base',
  'Untitled.md',
  'Untitled 1.md',
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

/**
 * Same contract as isSafeTrackedPath, but the final segment only needs to
 * END WITH `suffix` rather than equal a fixed constant — for `*.base`,
 * where the basename varies (Untitled.base, "Untitled 1.base", …). Because
 * the final segment is therefore NOT a known-safe constant the way
 * '.write-lock'/'.DS_Store' are in isSafeTrackedPath, it is ALSO run
 * through isSafePathSegment here (isSafeTrackedPath deliberately skips that
 * for its own final segment, since callers there always pass a fixed name).
 */
function isSafeTrackedPathSuffix(p, suffix, exactDepth) {
  if (typeof p !== 'string' || !p) return false;
  const parts = p.split('/');
  const last = parts[parts.length - 1];
  if (!last.endsWith(suffix)) return false;
  const dirParts = parts.slice(0, -1);
  if (exactDepth !== null && dirParts.length !== exactDepth) return false;
  return parts.every(isSafePathSegment);
}

/**
 * Same contract again, for a fixed multi-segment TAIL rather than a single
 * final segment — `.obsidian/workspace.json`. The vault root is user-
 * configurable (domains/, domains/<domain>/, or domains/<domain>/wiki/ —
 * see CLAUDE.md's Obsidian Graph Setup section), so this file can
 * legitimately appear at any depth; every leading segment (including both
 * tail segments) is validated with isSafePathSegment.
 */
function isSafeTrackedTailPath(p, tailSegments) {
  if (typeof p !== 'string' || !p) return false;
  const parts = p.split('/');
  if (parts.length < tailSegments.length) return false;
  const tail = parts.slice(-tailSegments.length);
  for (let i = 0; i < tailSegments.length; i++) {
    if (tail[i] !== tailSegments[i]) return false;
  }
  return parts.every(isSafePathSegment);
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
 * Same pattern again, for `.obsidian/workspace.json` — rewritten on
 * essentially every pane move/resize/tab switch, so once one is committed
 * (e.g. from before this rule existed) it produces a pending change on
 * almost every Obsidian interaction. Deliberately narrow: only this ONE
 * file under .obsidian/, never the directory wholesale — see the
 * DOMAINS_GITIGNORE_RULES comment for why.
 */
async function untrackStaleObsidianWorkspace() {
  const candidates = await listTrackedGlob('*.obsidian/workspace.json');
  const untracked = [];
  for (const p of candidates) {
    if (!isSafeTrackedTailPath(p, ['.obsidian', 'workspace.json'])) continue;
    try {
      await git(`--literal-pathspecs rm --cached --ignore-unmatch -- "${p}"`);
      untracked.push(p);
    } catch { /* best-effort */ }
  }
  return untracked;
}

/**
 * Same pattern again, for the Obsidian leftover files mirrored from the app
 * repo's own .gitignore (see DOMAINS_GITIGNORE_RULES) — `*.base` files
 * (Untitled.base, "Untitled 1.base", …) and the fixed stub names
 * Untitled.md / "Untitled 1.md". Three glob passes, one per pattern, same
 * granularity as untrackStaleWriteLocks/untrackStaleDSStore above rather
 * than one pass trying to do all three at once.
 */
async function untrackStaleObsidianLeftovers() {
  const untracked = [];
  const baseCandidates = await listTrackedGlob('*.base');
  for (const p of baseCandidates) {
    if (!isSafeTrackedPathSuffix(p, '.base', null)) continue;
    try {
      await git(`--literal-pathspecs rm --cached --ignore-unmatch -- "${p}"`);
      untracked.push(p);
    } catch { /* best-effort */ }
  }
  for (const finalName of ['Untitled.md', 'Untitled 1.md']) {
    const candidates = await listTrackedGlob(`*${finalName}`);
    for (const p of candidates) {
      if (!isSafeTrackedPath(p, finalName, null)) continue;
      try {
        await git(`--literal-pathspecs rm --cached --ignore-unmatch -- "${p}"`);
        untracked.push(p);
      } catch { /* best-effort */ }
    }
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

// ── Remote status: "how much is waiting on GitHub" ───────────────────────────
//
// getStatus() above answers "what have I changed locally" from `git status
// --porcelain` — no network, and it must STAY that way: it is on the rail
// badge's hot path (a 60s timer plus every view change), and every other
// consumer in both frontends already depends on it being instant.
//
// Knowing what is waiting to be PULLED is a different question and it cannot
// be answered locally: it REQUIRES a `git fetch`. That is a real cost —
// latency, GitHub rate limit, battery — so it lives here behind its own
// endpoint, on its own deliberately slow cadence, and is never folded into
// getStatus().
//
// THREE independent bounds on that cost, because one is not enough:
//   1. The caller's cadence (see refreshSyncRemoteBadge in next/app.js).
//   2. This TTL cache — but read the correction below before trusting it.
//   3. An in-flight memo (_remoteInFlight), which is what actually bounds
//      CONCURRENT callers.
//
// CORRECTION, because this comment used to claim a guarantee the code did
// not have and that is exactly what stops the next reviewer looking. It
// read "the network call happens at most once per REMOTE_CHECK_TTL_MS per
// process", offered as protection against "a second browser tab". It was
// true only of STRICTLY SEQUENTIAL callers. The cache is read before the
// await and written after it, so every caller that arrives while a check is
// running misses: measured, a burst of 40 concurrent calls produced 40 real
// `git fetch` subprocesses and ZERO cache hits — and at N=2, two browser
// tabs booting, one of the two checks failed outright on the ref race
// described at gitFetch(). The memo at (3) is what makes the sentence true;
// the TTL bounds REPEATED checks over time, which is a different claim.
//
// This is the same reasoning as the ingest budget cap: bound the spend in
// the module that does the spending, not only at the call site. It matters
// more than a rate limit here, because server.js's cross-origin guard
// covers mutating methods only — this is a GET, so a page in another tab
// can drive it. It cannot read the response, but it could otherwise have
// spawned unbounded authenticated fetches on the user's PAT. (2) and (3)
// bound that to one in-flight check per TTL.
//
// HONESTY RULE, and it is the whole point of the null. A failed check
// resolves to `behindFiles: null`, NEVER 0. "We could not ask" and "there is
// nothing waiting" are different facts, and rendering the first as the
// second is exactly the failure v3.9.0's ring rule names — never show a
// reassuring number you have not measured. Callers must branch on null.
//
// A FETCH MUST NEVER TOUCH THE WORKING TREE. `git fetch` writes
// remote-tracking refs and FETCH_HEAD inside the git dir; it does not merge,
// check out, or modify a single file under the domains folder. That is what
// makes this safe to run on a timer while the user is working, and the
// offline suite asserts it by checksumming the tree across a call.
//
// Deliberately NOT wrapped in guardConcurrent at the route: a fetch does not
// take index.lock and cannot race a write the way pull()'s merge can.
//
// CORRECTION — this paragraph used to end "If it does collide with a
// concurrent pull over a ref lock, git fails, and the honesty rule above
// turns that into 'unknown' rather than a wrong number." That described the
// wrong victim, and reassuringly. Measured, the collision landed on the
// USER'S PULL, not on this check: pull()'s fetch was the one with no catch,
// so a background badge refresh ABORTED the user's sync 11 times in 12
// before the merge. The honesty rule below is real and still applies to
// THIS function's own failures; it never protected the other side of the
// race. Fixed in two places rather than by rewording: gitFetch() serialises
// every fetch in this process, and pull() now treats its own reporting
// fetch as non-fatal.
const REMOTE_CHECK_TTL_MS = 5 * 60 * 1000;

// A FAILED check is cached far more briefly than a successful one, and the
// asymmetry is deliberate. Both still bound the network cost, but they are
// answering different questions. A success is a fact that stays true until
// someone pushes; caching it for minutes is free. A failure usually means a
// closed laptop lid, a dropped VPN, a captive portal — conditions that clear
// in seconds — and caching THAT for five minutes would leave the badge
// stuck on "could not check GitHub" long after the network came back, which
// reads as a broken feature. Found while testing the recovery path live.
const REMOTE_CHECK_FAILURE_TTL_MS = 60 * 1000;

let _remoteCache = null; // { at: epochMs, payload }

// PURE. How long a given cached answer stays good. Extracted so the
// success/failure asymmetry can be asserted directly: proving it through
// getRemoteStatus() would need real elapsed time (a minute of it), and a
// timing-based assertion is precisely the kind this project deleted in
// v3.9.0 for flaking under CI load.
//
// The caller's own maxAgeMs always wins when it is SHORTER — a caller asking
// for fresher data than the default must never be handed staler data.
function remoteCacheTtl(payload, maxAgeMs) {
  if (payload && payload.remoteChecked) return maxAgeMs;
  return Math.min(maxAgeMs, REMOTE_CHECK_FAILURE_TTL_MS);
}

// A safe, bounded explanation for a failed remote check — see the call site.
export function remoteErrorMessage(err) {
  const mapped = friendlyError(err);
  if (mapped && mapped !== sanitize(err.message)) return mapped;
  return 'Could not reach GitHub to check for incoming changes.';
}

// Any operation that moves HEAD or origin/main makes a cached answer stale.
// Called by push() and pull() so the badge reflects reality immediately after
// a sync instead of showing a number up to a TTL old.
function invalidateRemoteCache() {
  _remoteCache = null;
}

// Coalescing memo for a check that is already running. See the docblock
// above REMOTE_CHECK_TTL_MS for why the TTL cache alone was never the
// concurrency bound its own comment claimed.
let _remoteInFlight = null;

export async function getRemoteStatus({ maxAgeMs = REMOTE_CHECK_TTL_MS } = {}) {
  if (!isConfigured()) return { configured: false };

  // THE CACHE IS KEYED ON THE REPOSITORY, not merely on time, and that is
  // load-bearing rather than tidiness. invalidateRemoteCache() is called by
  // push() and pull() — NOT by setup() or disconnect() — so on the ordinary
  // "wrong repo, let me redo it" flow a freshly-repointed connection kept
  // answering with the OLD repo's number for up to a full TTL: measured,
  // priming against a repo 3 behind and then repointing config at a repo
  // with nothing waiting still returned {behindFiles:3, cached:true}, and
  // the rail showed "↓3" for a repo with nothing to pull. Keying makes that
  // unrepresentable instead of relying on every future mutating path
  // REMEMBERING to invalidate — which is precisely the guard-on-an-instance
  // shape that produced the bug. Deliberately no invalidate() calls added
  // to setup()/disconnect(): with the key they would be redundant, and a
  // redundant guard reads to the next reviewer as the one doing the work.
  const config = await loadConfig();
  const repoKey = (config && config.repoUrl) || null;

  const now = Date.now();
  if (_remoteCache && _remoteCache.repoKey === repoKey &&
      (now - _remoteCache.at) < remoteCacheTtl(_remoteCache.payload, maxAgeMs)) {
    return { ..._remoteCache.payload, cached: true };
  }

  // Concurrent callers share the one in-flight check. `cached` stays false
  // for all of them and that is accurate: a coalesced caller receives the
  // result of a real check that had not finished when it asked, which is
  // not the same fact as a TTL hit on a completed one.
  if (_remoteInFlight && _remoteInFlight.repoKey === repoKey) {
    return { ...(await _remoteInFlight.promise), cached: false };
  }

  const promise = runRemoteCheck(now, repoKey);
  _remoteInFlight = { repoKey, promise };
  try {
    return { ...(await promise), cached: false };
  } finally {
    // Only clear OUR entry: a later caller that already installed its own
    // must not have it wiped out from under it.
    if (_remoteInFlight && _remoteInFlight.promise === promise) _remoteInFlight = null;
  }
}

async function runRemoteCheck(now, repoKey) {
  let payload;
  try {
    // Timeout is deliberately shorter than pull()'s 120s: this runs
    // unattended on a timer, so a hanging network must degrade to "unknown"
    // quickly rather than pin an open request for two minutes.
    await gitFetch('origin main', { timeout: 30000 });
    const incoming = await countIncoming();
    payload = {
      configured: true,
      remoteChecked: true,
      behindFiles: incoming.files,
      behindCommits: incoming.commits,
      files: incoming.preview,
      checkedAt: new Date(now).toISOString(),
      remoteError: null,
    };
  } catch (err) {
    // null, not 0 — see the honesty rule above.
    payload = {
      configured: true,
      remoteChecked: false,
      behindFiles: null,
      behindCommits: null,
      files: [],
      checkedAt: new Date(now).toISOString(),
      // NEVER the raw error. sanitize() strips credentials out of a remote
      // URL, but not the absolute filesystem paths git puts in its own
      // messages — `git --git-dir="/Users/<name>/..." fetch origin main` —
      // and this endpoint is POLLED IN THE BACKGROUND, so anything here is
      // on the wire continuously rather than in response to a click. That is
      // the v3.3.0 path-leak shape (an error field carrying absolute paths
      // straight to the frontend), and there is nothing to trade for it:
      // friendlyError() already maps every failure a user can act on
      // (auth, network, no-repo) to a fixed sentence, and the rest are not
      // actionable anyway. Confirmed necessary by a live run against an
      // unreachable remote, which leaked two absolute paths.
      //
      // friendlyError() cannot simply be `|| `-ed with a default: its own
      // fallback is `sanitize(err.message)`, so it NEVER returns null for an
      // unrecognised error and the default would be dead code. (That fallback
      // is right for the sibling routes — a user who just clicked Push is
      // better served by the real git text — but wrong for a background poll.)
      // So compare against that exact fallback to tell "mapped to a written
      // sentence" from "handed the raw message straight back".
      remoteError: remoteErrorMessage(err),
    };
  }

  _remoteCache = { at: now, repoKey, payload };
  return payload;
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
    await gitFetch('origin', { timeout: 120000 });
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
  await untrackStaleObsidianWorkspace();
  await untrackStaleObsidianLeftovers();

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

  // origin/main just moved — a cached "waiting to pull" answer is now stale.
  invalidateRemoteCache();

  return {
    pushed: true,
    filesChanged: filesToPush,
    commitsAhead: aheadCount,
    files: filePreview,
    // Back-compat: `changesCount` was the field the UI used before v2.3.7
    changesCount: filesToPush,
  };
}

/**
 * How much origin has that we do not — the SINGLE derivation of "incoming",
 * shared by pull() and getRemoteStatus().
 *
 * ONE COPY, DELIBERATELY. The rail badge's "waiting to pull" number and the
 * number pull() reports afterwards are the same fact stated at two moments;
 * two hand-maintained copies of this arithmetic is precisely the shape that
 * produced the v3.2.0 CRITICAL (a guard duplicated, then drifted). Because
 * both callers run this identical code against `origin/main`, the badge can
 * never promise a count that the pull then contradicts.
 *
 * CALLER MUST HAVE FETCHED FIRST. This reads remote-tracking refs only; it
 * issues no network call of its own, so a caller that skips the fetch gets a
 * stale answer rather than a wrong one.
 *
 * Naive `diff HEAD..origin/main` is symmetric — it counts files differing in
 * EITHER direction, including files we changed locally, which is what
 * produced the "pulled 206 / pushed 206" report for one set of 206 files
 * (v3.0.1-beta.6). `merge-base` restricts the count to what origin actually
 * advanced beyond the common ancestor.
 *
 * Throws if there is no origin/main yet (first sync) — both callers treat
 * that as "nothing known to be incoming", never as an error to surface.
 */
async function countIncoming() {
  const { stdout: cnt } = await git('rev-list --count HEAD..origin/main');
  const commits = parseInt(cnt.trim(), 10) || 0;
  if (commits <= 0) return { commits: 0, files: 0, preview: [] };

  const { stdout: baseOut } = await git('merge-base HEAD origin/main');
  const base = baseOut.trim();
  if (!base) return { commits, files: 0, preview: [] };

  const { stdout: names } = await git(`diff --name-only ${base}..origin/main`);
  const list = names.split('\n').filter(Boolean);
  return { commits, files: list.length, preview: list.slice(0, 20) };
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

  // ── THIS FETCH IS FOR REPORTING ONLY, AND ITS FAILURE MUST NOT ABORT THE
  // SYNC (RELEASE-BLOCKER fix) ────────────────────────────────────────────
  // It used to sit OUTSIDE this try, one bare `await` with nothing to catch
  // it, and that was a silent-no-sync bug the moment v3.9.1 added a SECOND
  // fetch site (getRemoteStatus's background badge check). Both write
  // `refs/remotes/origin/main`; concurrently they are a compare-and-swap
  // race, and the loser dies with "cannot lock ref … is at <a> but expected
  // <b>". Reproduced against real git with a bare local remote: the user's
  // pull failed 11 of 12 times, before the merge, showing a raw git
  // transcript containing three absolute filesystem paths. The v3.9.1 UI
  // made it self-inflicted — the Sync view re-enabled its buttons and THEN
  // fired the badge check, so the user's own next click landed inside the
  // window.
  //
  // WHY TOLERATING IT IS NOT "WIDENING A CATCH UNTIL THE ERROR GOES AWAY",
  // which is the failure mode this could easily have been. Verified against
  // real git, both directions: `git pull --no-rebase -X theirs origin main`
  // three lines below RUNS ITS OWN FETCH and merges FETCH_HEAD. It does not
  // read `refs/remotes/origin/main` and does not care whether that ref
  // moved. Driven from a deliberately stale origin/main it fetched, merged,
  // produced the correct file content, and left origin/main correct — exit
  // 0. So this fetch is a prerequisite for countIncoming()'s NUMBER, never
  // for the sync itself, and a failure here is exactly the same class of
  // event as a countIncoming() failure, which this catch has always
  // degraded rather than raised.
  //
  // THE PULL STILL FAILS LOUDLY WHEN IT SHOULD. Nothing is being swallowed:
  // a real cause (bad token, no network, repo gone) fails the merge below
  // too, and THAT error is unguarded except by recoverHygieneMergeConflict,
  // which re-throws anything not provably one of our own hygiene junk
  // files. Moving the error surface onto the merge means one authority for
  // "did the sync happen", and it is the operation that actually decides.
  // Honest cost, stated rather than hidden: a fetch that HANGS to its
  // timeout now costs its 120s before the merge spends its own, where it
  // previously aborted at 120s. That path is a hang, not the common
  // failure (a dead network or a rejected token fails in seconds).
  //
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
    await gitFetch('origin main', { timeout: 120000 });
    const incoming = await countIncoming();
    commitsPulled = incoming.commits;
    filesPulled   = incoming.files;
    filePreview   = incoming.preview;
  } catch { /* no remote yet, or a losing ref race — the merge below decides */ }

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
  // collide with a still-pending merge write. v3.5.1's two additions
  // (.obsidian/workspace.json + the *.base/Untitled leftovers) follow the
  // EXACT same after-merge placement, for the exact same reason — see the
  // ordering writeup above this try/catch.
  await untrackStaleWriteLocks();
  await untrackStaleDSStore();
  await untrackStaleObsidianWorkspace();
  await untrackStaleObsidianLeftovers();
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

  // We just merged everything origin had — anything cached about "waiting to
  // pull" describes a state that no longer exists.
  invalidateRemoteCache();

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

// v3.5.1: extended to the two new hygiene-junk classes, PRECISELY — each
// new disjunct reuses the same validator its own untrack function uses, so
// this gate can never recognise a path its own untrack pass wouldn't have
// untracked. A widened version of this gate would let recoverHygieneMergeConflict
// silently auto-resolve a conflict on something that ISN'T disposable junk —
// see this function's callers' docblock for why that must never happen.
function isHygieneJunkPath(p) {
  return isSafeTrackedPath(p, '.write-lock', 1)
    || isSafeTrackedPath(p, '.DS_Store', null)
    || isSafeTrackedTailPath(p, ['.obsidian', 'workspace.json'])
    || isSafeTrackedPathSuffix(p, '.base', null)
    || isSafeTrackedPath(p, 'Untitled.md', null)
    || isSafeTrackedPath(p, 'Untitled 1.md', null);
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
  // Real `git fetch` subprocesses this module has issued. Read by the
  // concurrency assertions — see _fetchCount's declaration for why the
  // invariant is measured here and not inferred from a duration.
  fetchCount: () => _fetchCount,
  resetFetchCount: () => { _fetchCount = 0; },
  gitFetch,
  isSafePathSegment,
  isSafeTrackedPath,
  isSafeTrackedPathSuffix,
  isSafeTrackedTailPath,
  listTrackedGlob,
  untrackStaleWriteLocks,
  untrackStaleDSStore,
  untrackStaleObsidianWorkspace,
  untrackStaleObsidianLeftovers,
  cleanupStaleLocalLocks,
  ensureDomainsGitignore,
  DOMAINS_GITIGNORE_RULES,
  recoverHygieneMergeConflict,
  isHygieneJunkPath,
  extractUntrackedOverwritePaths,
  countIncoming,
  invalidateRemoteCache,
  REMOTE_CHECK_TTL_MS,
  REMOTE_CHECK_FAILURE_TTL_MS,
  remoteCacheTtl,
};
