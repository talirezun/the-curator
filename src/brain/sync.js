import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { mkdir, mkdtemp, readFile, readdir, unlink, rm, chmod } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
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
function currentConfigFile() { return _configFileOverride || getSyncConfigFile(); }

/**
 * The git dir THIS install's Personal Sync operates through.
 *
 *   test override           → that
 *   .sync-config.json gitDir → that   ← v3.32.0: ADOPTION (see setup())
 *   otherwise                → getSyncGitDir()   (unchanged for every
 *                              install that has never adopted)
 *
 * WHY A STORED PATH RATHER THAN A RECOMPUTED HEURISTIC. Adoption is decided
 * ONCE, at connect time, by detectForeignSyncRepo() — a filesystem probe. If
 * this resolver re-ran that probe on every call, the answer would change
 * under the app whenever the user moved their domains folder, and this
 * project has already shipped exactly that shape once (v3.25.0's
 * getUserDataDir() caching a failed mkdir, and the machine-id resolver that
 * returned two folder names in one session). A value written to
 * .sync-config.json is a FACT about this install, not a re-derivation.
 *
 * NOT MEMOISED, deliberately. It reads a <300-byte 0600 JSON file; every
 * caller of it is about to spawn a `git` subprocess costing ~1000x more. A
 * cache here would reintroduce the time-dependence the paragraph above
 * exists to avoid — most concretely, disconnect() writes this field away and
 * the very next isConfigured() must see that.
 *
 * FAILS BACK, NEVER FAILS OVER. A gitDir that is absent, relative, or no
 * longer a git dir on disk (the other install was deleted) resolves to the
 * default rather than throwing. The worst case is that this install starts
 * a fresh repo of its own — which is exactly the pre-v3.32.0 behaviour, and
 * is recoverable; refusing to sync at all is not.
 */
function configuredGitDir() {
  const f = currentConfigFile();
  if (!existsSync(f)) return null;
  let cfg;
  try { cfg = JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
  const d = cfg && cfg.gitDir;
  if (typeof d !== 'string' || !d || !path.isAbsolute(d)) return null;
  return looksLikeGitDir(d) ? d : null;
}

/**
 * Where this install would put a sync repo if it had not adopted one. The
 * test seam overrides THIS, not currentGitDir(), so adoption can be
 * exercised end to end: a suite points the install default at a tempdir and
 * the adopted path still wins, exactly as it does in production.
 */
function installDefaultGitDir() { return _gitDirOverride || getSyncGitDir(); }

function currentGitDir() { return configuredGitDir() || installDefaultGitDir(); }

/**
 * Is `dir` a git directory? Checked by SHAPE on disk rather than by spawning
 * `git rev-parse`, because configuredGitDir() above is synchronous and on
 * every git() call. Both entries are created by `git init` and neither is
 * created by anything else we write.
 */
function looksLikeGitDir(dir) {
  try {
    return existsSync(path.join(dir, 'HEAD')) && existsSync(path.join(dir, 'objects'));
  } catch { return false; }
}

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
  // opts.gitDir — operate on a git dir OTHER than this install's own. Used by
  // two callers and only two: setup(), which must run against the dir it is
  // about to adopt BEFORE that choice is written to config, and
  // preflightSetup(), which runs entirely inside a throwaway tempdir repo.
  // Defaulting to currentGitDir() keeps every existing call site byte-
  // identical in behaviour.
  //
  // opts.env — extra environment for ONE call. Only GIT_INDEX_FILE uses it,
  // so that assessPullOverwrite() can load a tree into a SCRATCH index and
  // never touch the real one.
  const full = `git --git-dir="${opts.gitDir || currentGitDir()}" --work-tree="${getDomainsDir()}" ${cmd}`;
  try {
    const { stdout, stderr } = await execAsync(full, {
      timeout: opts.timeout || 30000,
      cwd: ROOT,              // Explicit cwd prevents "getcwd: Operation not permitted" on macOS
      env: opts.env ? { ...SUBPROCESS_ENV, ...opts.env } : SUBPROCESS_ENV,
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
  // A `file://` remote is passed through UNCHANGED, with no token appended.
  //
  // Two reasons, and the second is why it is here rather than in a test
  // helper. (1) Correctness: git supports the file transport, and the code
  // below — which strips the scheme and re-prefixes `https://<token>@` —
  // turns `file:///srv/wiki.git` into `https:///srv/wiki.git`, a URL with no
  // host, so a user who typed one got "URL rejected: No host part in the
  // URL" instead of either working or being told the format is unsupported.
  // (2) setup() had ZERO test coverage before v3.32.0, and the reason is
  // visible in scripts/test-sync-hygiene.js: every fixture in it hand-builds
  // a repo with `git remote add` because setup() could not be pointed at a
  // local bare repo. The function that destroyed a user's working state was
  // untestable offline. It is not any more.
  //
  // No token is appended and none can leak: the file transport has no
  // credential to carry.
  if (/^file:\/\//i.test(url)) return url;
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
  // GIT ITSELF IS MISSING. This MUST stay above the repository-not-found
  // branch below, which tests the bare substring `not found` — so
  // "/bin/sh: git: command not found" currently resolves to "Repository not
  // found. Check the URL — it must be a private repo you own." That is not a
  // vague message, it is a CONFIDENTLY WRONG diagnosis: it sends a user whose
  // URL is perfectly fine to go and check their URL, and nothing in the flow
  // ever mentions git.
  //
  // Position relative to the auth branch is arbitrary (a git-missing message
  // carries no 401/403 and an auth message carries no "command not found"), so
  // it sits here purely to be unambiguously above the branch it fixes.
  //
  // The Windows form is included because `install.sh` is macOS-only but the
  // repo is cloneable anywhere and Personal Sync has already been debugged on
  // Windows once (v3.0.1-beta.19).
  if (msg.includes('command not found') ||
      msg.includes('git: not found') ||
      msg.includes('spawn git enoent') ||
      msg.includes('is not recognized as an internal or external command')) {
    return 'Git is not available to The Curator, so syncing cannot run. ' +
           'On macOS, open Terminal and run `xcode-select --install`, then try again. ' +
           'If git is installed somewhere unusual, launching The Curator from a terminal ' +
           '(`npm start`) will pick up your shell PATH.';
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
    // NAMES AN ACTION, NOT A PLACE. The previous wording was 'Click "Pull
    // only" first (under Advanced), then sync again' and that was its own
    // defect, found by a user who followed it into a data loss. "(under
    // Advanced)" described the pre-redesign shell's layout (that shell,
    // reachable at /old, was deleted in v3.41.0 — /old now just redirects
    // to /) — /next puts Push only / Pull only at the top level of the Sync
    // view — and on the CONNECT screen neither control exists at all, so a
    // user reading it there reached for the only other thing on the screen,
    // which overwrote their files. setup() now raises its own
    // connect-specific refusal ('remote-not-empty') before this branch can
    // be reached from that screen; this wording is for the configured
    // screen, where "pull first" is genuinely the next step.
    return 'GitHub has changes you don\'t have locally. Pull first, then sync again.';
  }
  if (msg.includes('nothing to commit')) {
    return null; // Not an error
  }
  return sanitize(err.message);
}

// ── Config ────────────────────────────────────────────────────────────────────

async function saveConfig(repoUrl, token, gitDir = null) {
  // v3.0.1-beta.20: atomic + 0600 — .sync-config.json holds the GitHub PAT, so
  // it must not be world-readable, and a kill mid-write must not lose the token.
  //
  // v3.32.0: `gitDir` is written ONLY when this install adopted another
  // install's sync repo (see setup()). It is OMITTED — not written as null —
  // in the ordinary case, so a config file produced by this version against a
  // normal install is byte-identical to one produced by every version before
  // it, and configuredGitDir() reads absent and null identically anyway.
  const payload = gitDir ? { repoUrl, token, gitDir } : { repoUrl, token };
  await writeFileAtomic(currentConfigFile(), JSON.stringify(payload, null, 2), { mode: 0o600 });
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

// ── Connect-time safety: one sync repo per folder, and no silent overwrite ───
//
// THE INCIDENT THIS SECTION EXISTS FOR (v3.32.0). A user installed the Mac
// app, pointed it at the domains folder his existing browser install was
// already syncing, and connected GitHub sync. Four working-state handoffs
// written that morning were destroyed, and `journal.jsonl` — an APPEND-ONLY
// file — came back one line long. Two independent defects combined:
//
//  (1) TWO GIT REPOSITORIES OVER ONE WORK TREE. getSyncGitDir() resolves
//      through getUserDataDir(), which forks on install mode; the work tree
//      does NOT fork — it is getDomainsDir(), which both installs were
//      pointed at. So the app created `<appSupport>/.knowledge-git` beside
//      the checkout's existing `<checkout>/.knowledge-git`, two histories
//      over one set of files, sharing a common remote commit and diverging
//      after it.
//
//  (2) THE REFUSAL LEFT ONLY THE DESTRUCTIVE DOOR OPEN. Connecting in
//      "Push my wiki" mode was correctly refused (non-fast-forward: the
//      remote had commits this brand-new repo did not). The only other
//      control was "Pull an existing wiki", and setup()'s pull arm ended in
//      an unconditional `git reset --hard origin/main`.
//
// `git reset --hard` is the one tree-writing command with NO untracked-file
// safety check. Reproduced against real git: `checkout -b main origin/main`
// REFUSED, naming all three colliding files; `checkout main` REFUSED;
// `reset --hard origin/main` then replaced every one of them with the older
// remote revision and exited 0. Git said no twice and the fallback ladder
// said yes anyway.
//
// The three functions below are the fix's measurement half. setup() is its
// decision half.

/**
 * Normalise a repository URL to a comparable identity — `host/owner/repo`,
 * lowercased, credentials and `.git` stripped, both the HTTPS and the
 * `git@host:owner/repo` forms accepted.
 *
 * Used ONLY to decide whether a sync repo already sitting beside the user's
 * domains folder points at the same GitHub repository they are connecting
 * to. Deliberately lossy and deliberately NOT used for anything that talks
 * to the network: a false match here adopts a repo, and a false mismatch
 * refuses a connect, so both directions are visible to the user rather than
 * silent. Returns null for anything unparseable, and null never matches
 * null (see the call site) — "we could not tell" is not "they are the same".
 */
function repoIdentity(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let u = url.trim();
  u = u.replace(/^git@([^:]+):/, 'https://$1/');
  u = u.replace(/^ssh:\/\//, 'https://');
  u = u.replace(/^https?:\/\//, '');
  u = u.replace(/^[^@/]*@/, '');           // strip user:token@
  u = u.replace(/\.git$/, '').replace(/\/+$/, '');
  return u.toLowerCase() || null;
}

/**
 * The directory a DIFFERENT Curator install would have put its sync repo in
 * for this same domains folder.
 *
 * ONE candidate, and it is not a guess in the loose sense: in repo mode
 * getUserDataDir() IS the checkout, and the default domains folder is
 * `<checkout>/domains`, so a repo-mode install's `.knowledge-git` is
 * necessarily the SIBLING of the domains folder. That is the shape of every
 * install that existed before the Mac app, which is precisely the population
 * that can hit the split. A user who relocated `domainsPath` away from its
 * default is not covered — stated as a limit rather than papered over with
 * a directory walk, which would be both slow and far more likely to adopt
 * something unrelated.
 */
function foreignSyncGitDirCandidate() {
  const parent = path.dirname(getDomainsDir());
  if (!parent || parent === getDomainsDir()) return null;   // domains at filesystem root
  // The directory NAME comes from paths.js's own getter rather than being
  // written out here. Two reasons, and only one of them is the guard in
  // test-paths.js §(b) that fails on a hardcoded user-data filename outside
  // paths.js: the other is that if that directory is ever renamed, a literal
  // here would silently stop detecting anything — a detector that quietly
  // finds nothing is worse than no detector, because the split it exists to
  // catch is itself silent.
  return path.join(parent, path.basename(getSyncGitDir()));
}

/**
 * The cheap half of detectForeignSyncRepo: is a foreign sync repo PRESENT?
 * Two stat calls, no subprocess — see getStatus()'s call site for why that
 * matters. Says nothing about which remote it points at.
 */
function foreignSyncRepoPresent() {
  const candidate = foreignSyncGitDirCandidate();
  if (!candidate) return false;
  if (candidate === installDefaultGitDir() || candidate === currentGitDir()) return false;
  return looksLikeGitDir(candidate);
}

/**
 * Detect a sync repo that already governs this domains folder but is not
 * ours. Returns `{path, originUrl, matchesRequestedRepo}` or null.
 *
 * Reads the candidate's `origin` URL through git itself rather than by
 * parsing its config file by hand — the ini format has include directives,
 * conditional includes and continuation lines, and a hand-rolled parser
 * getting this wrong decides whether we ADOPT a repository.
 *
 * `originUrl` is sanitize()d before it leaves this function: the config of a
 * configured install embeds the PAT in the remote URL, and this value is
 * surfaced to the UI.
 */
async function detectForeignSyncRepo(requestedRepoUrl) {
  const candidate = foreignSyncGitDirCandidate();
  if (!candidate) return null;
  // Ours (default OR already adopted) is by definition not foreign.
  if (candidate === installDefaultGitDir() || candidate === currentGitDir()) return null;
  if (!looksLikeGitDir(candidate)) return null;

  let originUrl = null;
  try {
    const { stdout } = await git('config --get remote.origin.url', { gitDir: candidate });
    originUrl = stdout.trim() || null;
  } catch { /* no origin configured — still a real repo governing this tree */ }

  const a = repoIdentity(originUrl);
  const b = repoIdentity(requestedRepoUrl);
  return {
    path: candidate,
    originUrl: originUrl ? sanitize(originUrl) : null,
    // null never matches null: an unreadable origin is "we could not tell",
    // and adopting on that basis would be adopting on no evidence.
    matchesRequestedRepo: !!(a && b && a === b),
  };
}

/**
 * Which files under the domains folder would a checkout of `origin/main`
 * OVERWRITE, and which would it merely create?
 *
 * READS THE WORK TREE, WRITES NOTHING TO IT. Every step is either a git-dir
 * write or a scratch-index write:
 *
 *   read-tree origin/main    → loads the remote tree into GIT_INDEX_FILE
 *   update-index --refresh   → hashes work-tree files whose stat data does
 *                              not match, and updates the SCRATCH index
 *   diff-files --name-status → compares that index to the work tree
 *
 * THE REFRESH IS LOAD-BEARING AND WAS MEASURED. A freshly `read-tree`d index
 * carries zeroed stat data, so without it `diff-files` reports every file as
 * modified on stat grounds alone — in the probe that built this function, an
 * identical `same.md` came back `M`. Quoting a user an overwrite count that
 * includes every unchanged file would make this guard fire on every connect,
 * and a guard that always fires is one people learn to click through.
 * `update-index --refresh` exits NON-ZERO when anything genuinely differs,
 * which is the normal case here, so its throw is expected and swallowed.
 *
 *   'M' → the path exists on disk with DIFFERENT content. A checkout
 *         replaces it. This is the destructive set.
 *   'D' → the path is in the remote tree and absent on disk. A checkout
 *         creates it. Harmless, counted separately.
 *
 * A scratch index file is used rather than the repo's own, so this is safe
 * to run against a LIVE configured repo (setup() does exactly that) without
 * disturbing a staged state the user may be in the middle of.
 */
async function assessPullOverwrite(gitDir) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'curator-sync-idx-'));
  const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    await git('read-tree origin/main', { gitDir, env });
    try {
      await git('update-index --refresh', { gitDir, env });
    } catch { /* non-zero whenever anything differs — that IS the answer */ }
    const { stdout } = await git('diff-files --name-status -z', { gitDir, env });
    // `status\0path\0status\0path\0…` — `-z` is never C-quoted, so a
    // non-ASCII domain name survives intact (the v3.0.16 lesson, applied
    // here from the start rather than after it bit someone).
    const parts = stdout.split('\0').filter((x) => x !== '');
    const overwrite = [];
    let createCount = 0;
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i];
      const file = parts[i + 1];
      if (status === 'D') createCount++;
      else overwrite.push(file);
    }
    overwrite.sort();
    return { overwrite, overwriteCount: overwrite.length, createCount };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A refusal the UI can render as something other than a wall of git text.
 * `code` is the contract; `message` is the sentence; `details` carries the
 * numbers the user needs to decide.
 */
function refusal(code, message, details = {}) {
  const err = new Error(message);
  err.curatorSyncCode = code;
  err.curatorSyncDetails = details;
  return err;
}

/**
 * WHY THESE MESSAGES NAME AN ACTION AND A SCREEN, NEVER A BUTTON LABEL.
 *
 * The wording that caused the incident was `Click "Pull only" first (under
 * Advanced)` — a sentence describing controls that were not in front of the
 * user. `/next` renders these refusals as its own decision panel with its own
 * button copy, so the strings here are only ever seen by anything driving the
 * API directly — the pre-redesign shell that used to be the other consumer
 * (`/old`, `src/public/app.js`) was deleted in v3.41.0 and `/old` now just
 * redirects to `/`. Historically that shell's connect form was frozen and had
 * only Push and Pull; telling a user on that screen to click "Merge — keep
 * both" would have reproduced the exact defect one screen over. So they say
 * what to do and where the option lives, and leave the label to whichever
 * surface is actually rendering a button.
 */
export function syncRefusalOf(err) {
  if (!err || !err.curatorSyncCode) return null;
  return { code: err.curatorSyncCode, message: err.message, details: err.curatorSyncDetails || {} };
}

/**
 * `git init` + identity + remote + one fetch, against an explicitly-named
 * git dir.
 *
 * THE FILE'S ONLY SETUP-SIDE FETCH LIVES HERE, and that is structural rather
 * than tidy: test-sync-hygiene.js asserts a CLASS invariant — exactly one
 * raw `git('fetch …')` in this module, and a fixed number of gitFetch()
 * callers. preflightSetup() and setup() both need a fetch and both reach it
 * through this one function, so the connect path cannot grow a second
 * ungated fetch site without going red. See gitFetch()'s own docblock for
 * why an ungated fetch is not merely untidy: two concurrent fetches are a
 * compare-and-swap race on refs/remotes/origin/main, and the loser used to
 * be the user's pull.
 *
 * Returns true if `origin/main` now exists locally, false if the remote has
 * no `main` yet (an empty repo — the ordinary first-connect case, and NOT an
 * error). Anything else throws.
 */
async function prepareRemote(gitDir, remoteUrl, timeout) {
  await mkdir(gitDir, { recursive: true });
  // Idempotent on an existing repo — `git init` re-initialises without
  // touching refs, objects or the work tree, which is what makes it safe on
  // the ADOPT path where gitDir is another install's live repository.
  await git('init', { gitDir });
  await git('config user.email "thecurator@local"', { gitDir });
  await git('config user.name "The Curator"', { gitDir });
  await git('config push.autoSetupRemote true', { gitDir });
  try {
    await git(`remote add origin "${remoteUrl}"`, { gitDir });
  } catch {
    await git(`remote set-url origin "${remoteUrl}"`, { gitDir });
  }
  try {
    await gitFetch('origin main', { gitDir, timeout });
    return true;
  } catch (err) {
    // An empty repository, or one with no `main`. `couldn't find remote ref`
    // is git's wording for both. Everything else — auth, network, missing
    // repo — must surface.
    if (/couldn't find remote ref|could not find remote ref/i.test(err.message)) return false;
    throw err;
  }
}

/**
 * NON-DESTRUCTIVE ASSESSMENT of what connecting would do. Writes nothing
 * outside a tempdir; touches the user's domains folder READ-ONLY.
 *
 * This exists because of the second half of the incident at the top of this
 * section: the guard fired, and the user still lost data, because a refusal
 * that leaves only a destructive door open is not a guard. A number has to
 * reach the user BEFORE the click, and the only way to produce that number
 * honestly is to fetch the remote and compare it to what is on disk.
 *
 * WHY A THROWAWAY GIT DIR. Running this against getSyncGitDir() would
 * CREATE that directory, which is what isConfigured() tests — so a user who
 * previewed a connect and then cancelled would be left looking at a
 * half-configured install. A tempdir has no such side effect, and it is
 * removed in a finally.
 *
 * The one cost, stated: the fetch is a real network round trip and downloads
 * the remote's objects into the tempdir, then discards them, so a large wiki
 * costs its download twice on a connect that proceeds. That is paid once per
 * install, against a class of loss that is unrecoverable.
 */
export async function preflightSetup(repoUrl, token) {
  const remoteUrl = buildRemoteUrl(repoUrl, token);
  const foreign = await detectForeignSyncRepo(repoUrl);
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'curator-sync-preflight-'));
  const tmpGitDir = path.join(tmpRoot, 'probe.git');
  try {
    const remoteHasMain = await prepareRemote(tmpGitDir, remoteUrl, 120000);
    let overwriteCount = 0;
    let overwriteSample = [];
    let createCount = 0;
    if (remoteHasMain) {
      const a = await assessPullOverwrite(tmpGitDir);
      overwriteCount = a.overwriteCount;
      overwriteSample = a.overwrite.slice(0, 10);
      createCount = a.createCount;
    }
    return {
      ok: true,
      remoteHasMain,
      localHasContent: await domainsFolderHasContent(),
      overwriteCount,
      overwriteSample,
      createCount,
      foreignSyncRepo: foreign
        ? { originUrl: foreign.originUrl, matchesRequestedRepo: foreign.matchesRequestedRepo }
        : null,
      // What the UI should preselect. Never 'pull' when pulling would
      // destroy something: the whole point is that the destructive option
      // stops being the default AND stops being the only one.
      recommendedMode:
        foreign ? 'adopt'
        : !remoteHasMain ? 'push'
        : overwriteCount > 0 ? 'merge'
        : 'pull',
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/** Does the domains folder hold at least one domain directory? */
async function domainsFolderHasContent() {
  try {
    const entries = await readdir(getDomainsDir(), { withFileTypes: true });
    return entries.some((e) => e.isDirectory() && !e.name.startsWith('.'));
  } catch { return false; }
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
      // v3.32.0: is this install ALREADY in the split state — a second sync
      // repo governing a folder another install's repo also governs?
      //
      // setup()'s adoption closes the split for a connect made from now on.
      // It does NOTHING for an install that is already split, because setup()
      // does not run again. Those installs exist — the incident that produced
      // this work left one on the reporter's machine — so the app has to be
      // able to SAY so. It is not self-healed silently: switching a working
      // install onto a different git dir behind the user's back would orphan
      // whatever commits its own repo already holds, and doing that without
      // being asked is the same class of decision as the one that lost the
      // data. The Sync view renders the remedy (Disconnect, then Connect
      // again — the reconnect adopts) and the user chooses when.
      //
      // TWO existsSync calls and NO subprocess, deliberately: getStatus() is
      // on the rail badge's 60s hot path and every consumer depends on it
      // being instant. That is also why this reports only "a foreign repo is
      // present", not "and it points at the same remote" — the latter needs
      // `git config --get`, which is a process spawn. The stronger check runs
      // at connect time, where one extra process is free.
      splitSyncRepo: foreignSyncRepoPresent(),
      adoptedSyncRepo: !!configuredGitDir(),
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

export const SETUP_MODES = ['push', 'pull', 'merge'];

/**
 * Connect Personal Sync.
 *
 * READ THE INCIDENT WRITEUP at "Connect-time safety" above before changing
 * anything here. This function destroyed a user's working state, and the
 * shape of the fix is: nothing in it may overwrite a file under the domains
 * folder unless the caller has been told how many files and said yes.
 *
 * MODES
 *   'push'  — this folder is the truth. Commit it and push. Never writes the
 *             work tree. Unchanged from every prior version.
 *   'pull'  — the repo is the truth. Checks out over the folder. DESTRUCTIVE,
 *             and now refused when it would overwrite anything unless
 *             opts.confirmOverwrite is explicitly true.
 *   'merge' — NEW. Neither side is the truth. Commit the folder as this
 *             repo's first commit, then merge the remote into it. Nothing is
 *             overwritten irrecoverably, because the local side is committed
 *             BEFORE the merge and stays reachable from the merge's first
 *             parent.
 *
 * ADOPTION. If another Curator install's sync repo already governs this
 * domains folder and points at the same GitHub repository, this install uses
 * THAT repo instead of creating a second one. `mode` is then irrelevant —
 * the adopted repo already contains this folder's history, so there is
 * nothing to push up or pull down and, critically, NOTHING IS WRITTEN TO THE
 * WORK TREE AT ALL. That is the whole point: the split is closed without a
 * single file being replaced.
 *
 * If a foreign repo is found pointing at a DIFFERENT remote, this refuses.
 * Two sync repos over one folder pushing to two different GitHub
 * repositories is not a configuration anyone means, and silently creating it
 * is how the incident happened. The refusal names the other remote and the
 * escape hatch (disconnect the other install, or move/rename its
 * `.knowledge-git`).
 */
export async function setup(repoUrl, token, mode, opts = {}) {
  if (!SETUP_MODES.includes(mode)) {
    throw refusal('invalid-mode', `mode must be one of ${SETUP_MODES.join(', ')}`);
  }
  await ensureDomainsGitignore();

  const remoteUrl = buildRemoteUrl(repoUrl, token);
  const foreign = await detectForeignSyncRepo(repoUrl);

  if (foreign && !foreign.matchesRequestedRepo) {
    throw refusal(
      'foreign-sync-repo',
      'Another Curator install already syncs this domains folder, and it is connected to a ' +
      'different repository. Connecting a second one would put two independent sync histories ' +
      'over the same files. Disconnect sync in the other install first, or point this install ' +
      'at a different domains folder.',
      { otherOriginUrl: foreign.originUrl },
    );
  }

  if (foreign) {
    // ── ADOPT ────────────────────────────────────────────────────────────
    // Point this install at the existing repo. prepareRemote() re-inits it
    // (a documented no-op on an existing repo), refreshes the origin URL
    // with THIS install's token, and fetches. It does not check anything
    // out, does not reset, does not merge — the work tree is not touched by
    // this branch at all, which is the property that makes adoption safe to
    // do automatically.
    await prepareRemote(foreign.path, remoteUrl, 120000);
    await saveConfig(repoUrl, token, foreign.path);
    // The adopted repo's config now carries our PAT in the remote URL.
    // getCredentialFiles()'s 0600 startup sweep is anchored on
    // getSyncGitDir(), not on the adopted path, so harden it here rather
    // than leave a token at whatever umask `git init` produced. Best-effort:
    // a failed chmod must not fail a connect that otherwise succeeded.
    await chmod(path.join(foreign.path, 'config'), 0o600).catch(() => {});
    return { adopted: true, gitDir: foreign.path };
  }

  // currentGitDir(), NOT getSyncGitDir(). Two things depend on it: the
  // __setSyncTestOverrides seam (without which none of this is testable —
  // and setup() shipped untested for its whole life, which is how the
  // incident happened), and a RE-connect on an install that already adopted
  // another install's repo, which must keep using that repo rather than
  // quietly starting a second one beside it.
  const gitDir = currentGitDir();
  // Non-null only when this install has adopted. Carried through every
  // saveConfig() below, because saveConfig writes the whole file: dropping
  // the field would silently un-adopt on the next connect and re-open the
  // split.
  const adoptedDir = configuredGitDir();
  // Did this directory exist before we touched it? Decides whether a refusal
  // below is allowed to clean up after itself — see the rollback note.
  const preexisting = looksLikeGitDir(gitDir);

  if (mode === 'push') {
    await prepareRemote(gitDir, remoteUrl, 120000);
    await git('add -A', { gitDir });
    try {
      await git('commit -m "Initial The Curator sync"', { gitDir });
    } catch (err) {
      if (!err.message.includes('nothing to commit')) throw err;
    }
    await git('branch -M main', { gitDir });
    try {
      await git('push -u origin main', { gitDir, timeout: 120000 });
    } catch (err) {
      // THE REFUSAL THE USER ACTUALLY HIT, and the reason its old wording
      // was its own defect. friendlyError() maps non-fast-forward to
      // 'Click "Pull only" first (under Advanced), then sync again' — a
      // sentence written for the CONFIGURED screen, where those controls
      // exist. On the connect screen there is no "Pull only" and no
      // "Advanced"; there is a Push/Pull toggle. Naming a control that is
      // not on the screen is what left the user reaching for the only other
      // thing that was.
      if (/non-fast-forward|\brejected\b|fetch first/i.test(err.message)) {
        throw refusal(
          'remote-not-empty',
          'That repository already has a wiki in it, so pushing this folder on top of it was ' +
          'refused. To combine the two, connect using the merge option on the app\u2019s main Sync ' +
          'view. To start from the repository instead, connect with the pull option \u2014 it will ' +
          'tell you first if that would replace anything here.',
          {},
        );
      }
      throw err;
    }
    await saveConfig(repoUrl, token, adoptedDir);
    return { adopted: !!adoptedDir, mode: 'push' };
  }

  // Both remaining modes need the remote's history.
  const remoteHasMain = await prepareRemote(gitDir, remoteUrl, 120000);

  if (!remoteHasMain) {
    // Nothing to pull or merge FROM. Falling through to a checkout here
    // would throw raw git text at a user whose only mistake was picking the
    // wrong radio button against an empty repo.
    throw refusal(
      'remote-empty',
      'That repository is empty, so there is nothing to pull or merge. Choose “Push my wiki” to ' +
      'send this folder up as the first version.',
    );
  }

  if (mode === 'merge') {
    // ── MERGE — the non-destructive route ────────────────────────────────
    // Commit the folder FIRST. That single ordering is what makes this
    // recoverable: whatever the merge decides, the pre-merge state of every
    // local file is reachable from the merge commit's first parent, so the
    // worst case is a `git checkout <sha> -- path`, not a loss.
    await git('add -A', { gitDir });
    let haveLocalCommit = true;
    try {
      await git('commit -m "Local wiki, before connecting sync"', { gitDir });
    } catch (err) {
      if (!err.message.includes('nothing to commit')) throw err;
      haveLocalCommit = false;
    }
    if (!haveLocalCommit) {
      // Empty folder: there is nothing to merge WITH, and a merge from an
      // unborn HEAD fails. Degrade to the pull path, which is safe here
      // precisely because there is nothing to overwrite.
      await git('checkout -b main origin/main', { gitDir });
      await saveConfig(repoUrl, token, adoptedDir);
      return { adopted: !!adoptedDir, mode: 'merge', degradedToPull: true };
    }
    await git('branch -M main', { gitDir });
    // `--allow-unrelated-histories` is required and is not a warning sign
    // here: this repo was created seconds ago by `git init`, so it shares no
    // commit with the remote by construction.
    //
    // `-X ours` PREFERS THE LOCAL SIDE, and that is a DIFFERENT decision
    // from pull()'s `-X theirs`, argued rather than inherited. pull()'s
    // `-X theirs` is the STEADY-STATE rule: origin is the shared truth, and
    // a machine reaching a pull is expected to have pushed its own work
    // already, so preferring origin on a contested hunk prefers the version
    // both machines have seen. On a FIRST CONNECT none of that holds — the
    // local side has, by construction, never been pushed anywhere, so there
    // is no sense in which origin has "seen" it. Preferring origin here
    // means preferring a revision that provably does not contain the user's
    // most recent work over one that does. That is the exact substitution
    // the incident made. pull() is untouched.
    //
    // Neither side is lost either way: both are committed parents of the
    // merge. The preference only decides which one is sitting in the folder
    // afterwards.
    //
    // KNOWN AND DISCLOSED: with no merge base, every remote path is an ADD,
    // so a file the user DELETED locally since the last push comes back.
    // Measured. That is the fail-safe direction for a one-time adoption
    // merge — a page reappearing is visible and fixable, a page vanishing is
    // the thing this whole section exists to prevent — and docs/sync.md says
    // so where the user can read it.
    await git('merge --allow-unrelated-histories --no-edit -X ours FETCH_HEAD',
              { gitDir, timeout: 120000 });
    await saveConfig(repoUrl, token, adoptedDir);
    invalidateRemoteCache();
    return { adopted: !!adoptedDir, mode: 'merge' };
  }

  // ── PULL — the destructive route, now gated ───────────────────────────
  const assessment = await assessPullOverwrite(gitDir);
  if (assessment.overwriteCount > 0 && opts.confirmOverwrite !== true) {
    // ROLLBACK. A refusal must not leave a half-configured install behind:
    // isConfigured() tests for the git dir, so a directory left here would
    // make the app claim sync is set up when no config was ever saved. Only
    // remove what THIS call created — never a repo that was already there.
    // `!adoptedDir` as well as `!preexisting`: an adopted dir belongs to
      // another install and a rollback must never delete it (same rule as
      // disconnect()). Both conditions are already true on the only path that
      // creates a repo here, so this is belt and braces, not a live branch.
      if (!preexisting && !adoptedDir) await rm(gitDir, { recursive: true, force: true }).catch(() => {});
    throw refusal(
      'pull-would-overwrite',
      `Pulling would replace ${assessment.overwriteCount} file` +
      `${assessment.overwriteCount === 1 ? '' : 's'} in your domains folder with the version in ` +
      'the repository. Those local versions are not recoverable afterwards. To combine the two ' +
      'instead, connect using the merge option on the app\u2019s main Sync view.',
      {
        // WHICH LAYER REFUSED. There are two, and a mutation proved they are
        // redundant on the ordinary fixture: deleting this one entirely left
        // the suite green, because `git checkout -b` below refuses on the
        // same collision and the catch turns that into the same refusal.
        // Recorded rather than presented as one guard doing the work — the
        // v3.4.0 pairing rule. They are NOT interchangeable: only this layer
        // produces a COUNT and a FILE LIST before anything is attempted, and
        // it is the only one preflightSetup() can use at all, because a
        // preview has no checkout to be refused. The other is the backstop
        // for the case where this measurement is wrong.
        source: 'measured',
        overwriteCount: assessment.overwriteCount,
        overwriteSample: assessment.overwrite.slice(0, 10),
        createCount: assessment.createCount,
      },
    );
  }

  // Safe, or explicitly confirmed. `checkout -b` is preferred over the old
  // `reset --hard` ladder because it carries git's OWN untracked-overwrite
  // refusal — a second, independent guard behind the measurement above. The
  // reset is reached only when the caller confirmed, and its comment says
  // what it does.
  try {
    await git('checkout -b main origin/main', { gitDir });
  } catch (err) {
    if (opts.confirmOverwrite !== true) {
      // NO SILENT ESCALATION. This is where the old code fell through to
      // `reset --hard` and destroyed the user's files. If git refused and
      // nobody confirmed an overwrite, the answer is the refusal, not a
      // bigger hammer.
      // `!adoptedDir` as well as `!preexisting`: an adopted dir belongs to
      // another install and a rollback must never delete it (same rule as
      // disconnect()). Both conditions are already true on the only path that
      // creates a repo here, so this is belt and braces, not a live branch.
      if (!preexisting && !adoptedDir) await rm(gitDir, { recursive: true, force: true }).catch(() => {});
      throw refusal(
        'pull-would-overwrite',
        'Pulling would overwrite files in your domains folder that are not in the repository. ' +
        'To combine the two instead, connect using the merge option on the app\u2019s main Sync view.',
        {
          source: 'checkout-refused',
          overwriteCount: assessment.overwriteCount,
          overwriteSample: assessment.overwrite.slice(0, 10),
        },
      );
    }
    // Confirmed overwrite. `reset --hard` is the only command that will do
    // this, and it will do it to any file: the caller has been shown the
    // count and said yes.
    await git('reset --hard origin/main', { gitDir });
  }

  await saveConfig(repoUrl, token, adoptedDir);
  invalidateRemoteCache();
  return { adopted: !!adoptedDir, mode: 'pull', overwrote: assessment.overwriteCount };
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

  // The prune's baseline — see pruneGhostDomainDirs(). Captured HERE, after
  // the auto-save commit and before the merge, so the deletion diff below
  // contains only what the REMOTE removed. Capturing it earlier would put
  // the user's own local deletions into that diff and hand the prune a
  // nomination it has no business acting on.
  //
  // An unborn HEAD (a repo with no commits) throws; that is not an error
  // condition here, it means nothing can have been deleted yet.
  let preMergeHead = null;
  try {
    const { stdout: headSha } = await git('rev-parse HEAD');
    preMergeHead = headSha.trim() || null;
  } catch { /* no commits yet — prune nothing */ }

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
  // doesn't track them. Scoped to what THIS merge deleted — read that
  // function's header before widening anything here.
  const { pruned, keptLocalContent } = await pruneGhostDomainDirs(preMergeHead);

  // We just merged everything origin had — anything cached about "waiting to
  // pull" describes a state that no longer exists.
  invalidateRemoteCache();

  return {
    pulled: true,
    filesChanged: filesPulled,
    commitsPulled,
    files: filePreview,
    pruned,
    // Folders this pull's merge emptied of tracked files but which still
    // hold something the user has not pushed. Reported rather than removed
    // — see pruneGhostDomainDirs() rule 4. Additive on the wire: the
    // pre-redesign shell (deleted in v3.41.0; /old now redirects to /) used
    // to read `pruned` only, so this field never affected it while it lived.
    prunedKept: keptLocalContent,
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
 * Split NUL-separated git path output into the set of TOP-LEVEL segments.
 *
 * `-z` is what makes this safe to do by hand: without it git C-quotes any
 * path containing a non-ASCII byte, a space-edge case or a quote
 * (`"caf\303\251/x.md"`), and the quoting is NOT disabled by
 * `core.quotePath=false` on every command — see the KNOWN GAP on
 * extractUntrackedOverwritePaths above, which is exactly that bug. With
 * `-z` the bytes are literal and a `split('/')` means what it says.
 *
 * Rename records in `status --porcelain -z` emit a SECOND, bare path chunk
 * with no status prefix. Callers below only match a specific prefix, so a
 * bare chunk is ignored; a file perversely named `?? x` could make one look
 * like an untracked entry, which biases toward KEEPING a directory. That is
 * the safe direction and is why it is left alone rather than parsed harder.
 */
function topLevelSegments(nulSeparated, prefix = '') {
  const out = new Set();
  for (const chunk of String(nulSeparated).split('\0')) {
    if (!chunk) continue;
    let p = chunk;
    if (prefix) {
      if (!p.startsWith(prefix)) continue;
      p = p.slice(prefix.length);
    }
    const seg = p.split('/')[0];
    if (seg) out.add(seg);
  }
  return out;
}

/**
 * Remove the EMPTY SHELL a remote domain-delete leaves behind.
 *
 * ── WHY THIS EXISTS (v2.3.4, and the property that must survive) ─────────
 * Computer 2 deletes a domain and pushes. Computer 1 pulls: every TRACKED
 * file under `domains/test/` is removed, but the directory survives,
 * because git does not track directories and will not remove one that still
 * holds untracked content — and a domain's `raw/` and `conversations/`
 * folders are gitignored, so a real domain always does. The result was a
 * ghost: no `CLAUDE.md`, so `listDomains()` hid it from the app and MCP, while
 * Obsidian and Finder still showed the folder. The delete had not finished
 * propagating. That is the property this function exists to hold, and it
 * still holds it.
 *
 * ── WHY IT CHANGED (v3.33.0+) ────────────────────────────────────────────
 * The original test for "is this a ghost" was `no CLAUDE.md`, applied to
 * every non-dot directory at the top of the domains folder, on every pull,
 * unconditionally. Measured (research pass for docs/roadmap-automatic-sync.md,
 * nothing incoming from the remote):
 *
 *     before pull: [ Attachments, demo, newdomain ]
 *     after  pull: [ demo ]      pruned: ["Attachments","newdomain"]
 *
 * THE DOMAINS FOLDER IS A DOCUMENTED OBSIDIAN VAULT ROOT — docs/sync.md and
 * the user guide both tell people to point Obsidian at it, and Obsidian's
 * own default location for a pasted image is an attachments folder at the
 * vault root. So a folder created by the normal use of the tool we
 * recommend was recursively deleted by the next pull, with no confirmation
 * and no undo. So was a domain still being written by hand, before its
 * schema existed. "No CLAUDE.md" is evidence of a great many things; being
 * a deleted domain is only one of them.
 *
 * Worse, and not in the original report: `push()` runs `git add -A`, so a
 * stray folder that survived long enough to be pushed was TRACKED. Deleting
 * it here staged a deletion that the next push propagated to the remote and
 * from there to every other machine. The blast radius was not local.
 *
 * ── THE RULE NOW: PROOF, NOT INFERENCE ───────────────────────────────────
 * A directory is removed only when all four hold:
 *
 *   1. THIS pull's merge deleted tracked files under it (`preMergeHead..HEAD`,
 *      diff-filter=D). This is the whole fix. A folder git has never heard
 *      of cannot appear in a deletion diff, so it is now unreachable by this
 *      code no matter what it is named or what it contains. It also means a
 *      pull with nothing incoming prunes nothing, which is what the
 *      measurement above should always have shown.
 *   2. It has no `CLAUDE.md` (the v2.3.4 test, kept — necessary, never
 *      sufficient).
 *   3. Git tracks NOTHING under it any more. A partially-deleted domain is
 *      not a deleted domain. This also guarantees the removal can never
 *      stage anything, so it can never propagate on the next push.
 *   4. Nothing under it is untracked-and-not-ignored — i.e. nothing git
 *      would offer to commit. Ignored content (`raw/`, `conversations/`, `.DS_Store`) does not block, because that is the v2.3.4 case
 *      itself; a file the user made and has not pushed does.
 *
 * ── WHAT THIS NO LONGER HANDLES, STATED PLAINLY ──────────────────────────
 * (a) A domain whose `CLAUDE.md` the user deleted BY HAND locally is no
 *     longer swept away by a pull. It lingers, hidden from the app by the
 *     `listDomains()` schema filter, until the user deletes it themselves.
 * (b) A shell this function declines under rule 4 stays declined: the
 *     deletion diff that nominated it belongs to one pull and does not
 *     recur. The user is told (`prunedKept`) and can delete it, or push the
 *     local file and let the folder become a normal tracked thing again.
 * (c) A stray folder a user ALREADY has — the case that motivated this — is
 *     now permanently safe, not merely safer: it can only be nominated by a
 *     pull that deletes tracked files under that exact path, which requires
 *     that they pushed it and then deleted it somewhere else on purpose.
 *
 * FAILURE MODE, NAMED: every branch here fails toward KEEPING the
 * directory. A git call that throws, an unborn HEAD, a diff we cannot read
 * — all return without deleting anything. A lingering folder is a tidiness
 * bug the user can fix in one drag; a deleted one is gone, and for
 * `raw/`-only content it was never on GitHub to recover from.
 *
 * STILL DESTRUCTIVE, DELIBERATELY: a shell that passes all four rules is
 * removed WITH its ignored, machine-local content (`raw/` sources,
 * `conversations/`). Those files were never on the remote and cannot be
 * recovered. That is the v2.3.4 contract — deleting a domain on one machine
 * deletes it everywhere — and narrowing it further would leave the reported
 * case unhandled, so it is preserved rather than quietly dropped.
 *
 * @param {string|null} preMergeHead  commit HEAD pointed at BEFORE this
 *   pull's merge, captured by pull() after its auto-save commit. Null (no
 *   commits yet, or unreadable) prunes nothing.
 * @returns {{pruned: string[], keptLocalContent: string[]}}
 */
async function pruneGhostDomainDirs(preMergeHead) {
  const pruned = [];
  const keptLocalContent = [];

  // Rule 1's baseline. Also the injection gate: this value is interpolated
  // into a shell command string by git(), so it must be a commit id and
  // nothing else, even though today's only caller derives it from
  // rev-parse.
  if (!preMergeHead || !/^[0-9a-f]{7,64}$/.test(preMergeHead)) return { pruned, keptLocalContent };

  const base = getDomainsDir();

  let nominated, trackedTops, unpushedTops;
  try {
    // 1. What did this merge actually delete? Empty ⇒ nothing to do, which
    //    is the common case (most pulls delete nothing).
    const { stdout: deleted } =
      await git(`diff --diff-filter=D --name-only -z ${preMergeHead} HEAD`);
    nominated = topLevelSegments(deleted);
    // An OPTIMISATION, not a guard: `nominated.has(name)` below is already
    // false for every name when the set is empty, and mutation M2 (removing
    // this line) is correctly GREEN. It exists so the ordinary pull — which
    // deletes nothing — costs two fewer git subprocesses.
    if (nominated.size === 0) return { pruned, keptLocalContent };

    // 3. What does git still track, and 4. what is untracked-not-ignored?
    //    Both are one bulk call each — no per-directory pathspec, so no
    //    quoting of a user-chosen folder name ever reaches a shell.
    const { stdout: tracked } = await git('ls-files -z');
    trackedTops = topLevelSegments(tracked);

    const { stdout: status } = await git('status --porcelain -z');
    unpushedTops = topLevelSegments(status, '?? ');
  } catch {
    // Cannot prove anything ⇒ delete nothing.
    return { pruned, keptLocalContent };
  }

  let entries;
  try {
    const { readdir } = await import('fs/promises');
    entries = await readdir(base, { withFileTypes: true });
  } catch { return { pruned, keptLocalContent }; }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!nominated.has(entry.name)) continue;          // 1. not deleted by this pull
    const dirPath = path.join(base, entry.name);
    // 2. live domain. SUBSUMED, and kept anyway: a live domain's CLAUDE.md
    //    is tracked (rule 3 keeps it) or locally-made and untracked (rule 4
    //    keeps it), so mutation M5 removing this line is GREEN and no test
    //    can see it. It stays because it is the v2.3.4 test, it is the only
    //    rule here that needs no git, and it is the last line of defence if
    //    a future edit weakens one of the other three.
    if (existsSync(path.join(dirPath, 'CLAUDE.md'))) continue;
    if (trackedTops.has(entry.name)) continue;         // 3. partial delete
    // 4. holds local work. ITS LIVE WINDOW IS NARROW AND THAT IS MEASURED:
    //    pull() commits the tree twice, and the second commit (`git add -A`,
    //    "Sync hygiene cleanup") runs immediately before this function — so
    //    anything the user left lying around is TRACKED by now and rule 3
    //    catches it. What is left for rule 4 is a write landing between that
    //    commit and this call: the MCP server or an ingest in ANOTHER
    //    process, which this app genuinely has. See section 5 / 5b of
    //    test-sync-prune-safety.js, which drives both halves.
    if (unpushedTops.has(entry.name)) {
      keptLocalContent.push(entry.name);
      continue;
    }
    try {
      await rm(dirPath, { recursive: true, force: true });
      pruned.push(entry.name);
    } catch { /* best-effort; fall through */ }
  }
  return { pruned, keptLocalContent };
}

export async function sync() {
  // Bidirectional sync: pull remote changes first, then push local changes.
  // This is the safest order — always get the latest before pushing.
  const pullResult = await pull();
  const pushResult = await push();
  return { pullResult, pushResult };
}

export async function disconnect() {
  // AN ADOPTED GIT DIR BELONGS TO ANOTHER INSTALL AND MUST NEVER BE DELETED
  // HERE. Without this branch, adoption (see setup()) would have created a
  // brand-new destructive path: the Mac app's Disconnect button would
  // `rm -rf` the browser install's `.knowledge-git`, taking that install's
  // entire sync history and its stored remote with it — a strictly worse
  // outcome than the split adoption exists to close. Disconnecting an
  // adopted install removes only THIS install's own credential file, which
  // is the whole of what this install owns.
  //
  // The check reads the config rather than comparing against
  // getSyncGitDir(), because a test seam or a future relocation could make
  // those two agree for reasons that have nothing to do with adoption.
  const adopted = configuredGitDir();
  const dir = currentGitDir();
  if (!adopted && existsSync(dir)) await rm(dir, { recursive: true, force: true });
  if (existsSync(currentConfigFile())) await unlink(currentConfigFile());
}

export { friendlyError };

// Test-only surface for internal helpers that have no other public entry
// point. Production code never imports this. Mirrors the __testing pattern
// already used by atomic-write.js and write-registry.js.
export const __testing = {
  repoIdentity,
  foreignSyncGitDirCandidate,
  detectForeignSyncRepo,
  foreignSyncRepoPresent,
  assessPullOverwrite,
  prepareRemote,
  looksLikeGitDir,
  configuredGitDir,
  currentGitDir,
  installDefaultGitDir,
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
  pruneGhostDomainDirs,
  topLevelSegments,
  countIncoming,
  invalidateRemoteCache,
  REMOTE_CHECK_TTL_MS,
  REMOTE_CHECK_FAILURE_TTL_MS,
  remoteCacheTtl,
};
