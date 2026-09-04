/**
 * Instance probe — "is another copy of The Curator serving THIS knowledge
 * folder right now?"
 *
 * ── The report this exists for ───────────────────────────────────────────────
 *
 * The maintainer ran the repo checkout (`npm start`, port 3333) and then
 * installed the packaged Mac app, whose config pointed `domainsPath` at the
 * SAME `domains/` folder. Both were live at once. An ingest failed, then a
 * later one took close to an hour, and nothing anywhere in the app said the
 * two were sharing a folder.
 *
 * That configuration used to be impossible BY ACCIDENT: both copies wanted
 * port 3333, so the second one died with EADDRINUSE. `desktop/lib/port.js`
 * now picks a free ephemeral port (deliberately — the maintainer runs the
 * checkout permanently and a desktop app that silently refuses to start is a
 * worse outcome), and that file's own docblock records what the change costs:
 *
 *     "That lock covers two copies of the DESKTOP app. It does NOT cover
 *      'desktop app + npm start checkout' ... it is a REDUCTION in protection
 *      compared with the accidental EADDRINUSE."
 *
 * This module is the deliberate replacement for that accident. It is
 * ADVISORY: it never refuses a start, never refuses a write, and never blocks
 * anything. Two instances still run. The app just stops pretending it cannot
 * tell.
 *
 * ── Why a marker file and not an HTTP probe ─────────────────────────────────
 *
 * The obvious alternative is to GET `http://127.0.0.1:3333/api/config` and
 * compare the `domainsPath` it reports. It was rejected:
 *
 *   • The desktop app binds an EPHEMERAL port chosen at launch. There is no
 *     port to probe — you would have to sweep 1024-65535, which is a port
 *     scan against the user's own machine and would still miss nothing else.
 *   • The checkout is only on 3333 by default; `PORT` moves it.
 *   • A probe answers "is something listening", not "is it serving MY
 *     folder", without a request/response round trip per candidate port.
 *
 * A marker written into a location BOTH installs can see, keyed by the
 * folder they share, answers the real question directly and for any port.
 *
 * ── WHERE the marker lives, and why NOT inside domains/ ─────────────────────
 *
 * This is the load-bearing decision in the module.
 *
 * The shared thing IS the domains folder, so `domains/.instance-lock` is the
 * obvious home. It is also wrong, and the reason is mechanical rather than
 * aesthetic: `getDomainsDir()` is Personal Sync's git WORK-TREE
 * (`src/brain/sync.js` passes `--work-tree=getDomainsDir()`), and `push()`
 * runs `git add -A`. A file there that no `.gitignore` rule covers is
 * committed and pushed to the user's knowledge repo, pulled onto every other
 * machine, and counted in the navbar's pending-changes badge.
 *
 * The generated `domains/.gitignore` comes from `DOMAINS_GITIGNORE_RULES` in
 * `src/brain/sync.js`, and its rules were read rather than assumed. (The
 * patterns below carry a backslash before each slash ONLY so that a pattern
 * beginning with a star does not close this very comment block — the real
 * rules have no backslashes.)
 *
 *     '*\/raw\/'                      one level down — a DOMAIN's raw folder
 *     '*\/.mcp-write-log.jsonl'      one level down
 *     '*\/.write-lock'               one level down (the write-registry lock)
 *     '.DS_Store'                    slash-free, so any depth
 *     '.ingest-queue\/'              trailing slash only, so any depth
 *     '**\/.obsidian\/workspace.json'  plus three Obsidian file rules
 *
 * There is NO root-level rule that would cover a new dotfile at
 * `domains/.instance-lock`. The two rules that DO match at the domains root
 * name specific things — a Finder cache and the batch-ingest queue — and
 * hiding an instance marker inside `.ingest-queue/` to inherit somebody
 * else's ignore rule is exactly the kind of borrowed-semantics trick that
 * costs an afternoon the next time either meaning changes.
 *
 * Adding a rule would mean editing `sync.js`, which this change does not own.
 * So the marker lives OUTSIDE the domains folder, and the same three-line
 * argument `getLogsDir()` and `getMcpLauncherDir()` in `paths.js` already
 * make applies unchanged: this is machine-local operational exhaust, it is
 * meaningless on any other machine, and it must never travel.
 *
 * ── The shared location, and why getUserDataDir() is NOT it ─────────────────
 *
 * `getUserDataDir()` forks on install form: APP_ROOT for a checkout,
 * `~/Library/Application Support/The Curator` for a bundle. Two installs
 * therefore have two different user-data directories, and each would register
 * itself somewhere the other never looks — a registry in which nobody can
 * ever see anybody.
 *
 * `getAppSupportDir()` does NOT fork. It is a fixed per-user location that
 * `getMcpLauncherDir()` already relies on UNCONDITIONALLY, in both install
 * modes, for a file Claude Desktop must be able to execute. This module makes
 * the same assumption for a file two Curator processes must be able to read,
 * which is strictly weaker. Both processes run as the same macOS user and
 * neither is App-Sandboxed (`desktop/build/entitlements.mac.plist` grants no
 * `com.apple.security.app-sandbox`), so `os.homedir()` is the real home in
 * both — a sandboxed app would get a container home and simply never see the
 * other instance, which is a silent FALSE NEGATIVE (no banner) and not a
 * false alarm.
 *
 *     <shared root>/instances/<16 hex of sha256(realpath(domainsDir))>/<pid>.json
 *
 * ── The hash BUCKETS; the recorded path DECIDES ─────────────────────────────
 *
 * The directory name is a hash purely so a path with slashes, spaces or
 * non-ASCII can be a directory name. It is never the identity test: every
 * record carries its own `domainsPath`, and a reader keeps a record only when
 * that string EQUALS the caller's own canonical domains path. So a hash
 * collision cannot manufacture a false alarm, and neither can a leftover
 * bucket from a folder that was renamed onto the same hash.
 *
 * `realpathSync` is applied where it resolves, so two instances pointed at the
 * same folder through different symlink spellings still land in one bucket.
 *
 * ── Liveness, staleness, and the direction each failure runs ────────────────
 *
 * A record is LIVE when its pid is alive (`process.kill(pid, 0)`, the same
 * probe `write-registry.js` uses). A record whose pid is gone is unlinked on
 * sight by whoever notices — a crashed process therefore blocks nothing and
 * clears itself, which is the property the whole design has to have, because
 * this marker is written at startup and there is no heartbeat to expire.
 *
 * The one residual inaccuracy, stated rather than hidden: PID REUSE. If a
 * Curator is hard-killed and the OS later hands its pid to an unrelated
 * program, the stale record reads as live and the banner appears with nothing
 * behind it. The cost is one dismissible sentence; the alternative — a
 * heartbeat — needs a timer this release deliberately does not add, and a
 * heartbeat that lapses would produce the OPPOSITE error (no warning while
 * two apps really are writing), which is the expensive direction. A clean
 * quit removes the record via the `exit` handler installed by
 * `registerInstance`, so reuse only bites after a crash or a `kill -9`.
 *
 * ── Why link(2), when nothing here is exclusive ─────────────────────────────
 *
 * Each instance owns its OWN filename (`<pid>.json`), so there is no lock and
 * no contention — two instances registering at once cannot conflict, which is
 * the point: this must never become a mutex.
 *
 * The marker is still published with `write-registry.js`'s primitive — write
 * a per-caller tempfile, then `link(2)` it into place — for the OTHER property
 * that module documents: link publishes the NAME and the CONTENT in the same
 * instant. With `open('wx')` (or a plain write) there is a window in which a
 * reader sees a zero-byte file, fails to parse it, and — by this module's own
 * "unparseable = junk, remove it" rule — deletes a live instance's marker.
 *
 * ── Invariants ──────────────────────────────────────────────────────────────
 *
 *  1. NOTHING here throws at a caller. Every export absorbs its own errors and
 *     degrades to "no other instances known". A detection feature must never
 *     be able to take down a server start, a route, or an ingest.
 *  2. Never STDOUT. This module sits on `src/brain/`, which the MCP child
 *     process imports; stdout there is reserved for JSON-RPC frames.
 *  3. Own-process records are never reported as "other" — the banner must not
 *     fire for the app the user is looking at.
 *  4. Resolve the registry root PER CALL. A module-level const would snapshot
 *     it at import time and defeat both test seams (the same rule paths.js
 *     states for its own getters).
 */

import path from 'path';
import crypto from 'crypto';
import { realpathSync, unlinkSync } from 'fs';
import { mkdir, writeFile, readFile, readdir, unlink, link } from 'fs/promises';
import { getAppSupportDir, getUserDataDir, APP_ROOT } from './paths.js';
import { getDomainsDir } from './config.js';
import { describeInstall } from './install-mode.js';

/** Directory name under the shared root. One word, same spelling everywhere. */
const REGISTRY_SUBDIR = 'instances';

/** Bucket-name length. 16 hex = 64 bits; the recorded path is the real test. */
const BUCKET_HEX_CHARS = 16;

/**
 * Hard ceiling on records read from one bucket. A bucket holds one file per
 * live process, so the real number is 1-3; anything larger means junk
 * accumulated and reading all of it buys nothing.
 */
const MAX_RECORDS_SCANNED = 64;

// Test-only override. Production NEVER sets this. See paths.js's own seams.
let _registryRootOverride = null;

/** Test seam — force the registry root. Pass null to clear. */
export function __setInstanceRegistryRootOverride(p) {
  _registryRootOverride = p ? path.resolve(p) : null;
}

/**
 * An ISOLATED user-data dir, or null when this is a real install.
 *
 * `getUserDataDir()` returns exactly one of two values in production —
 * APP_ROOT (repo) or getAppSupportDir() (bundle) — so anything ELSE is a test
 * seam that somebody set, and the registry follows it rather than writing into
 * the maintainer's real Application Support tree. This reads the resolved
 * value rather than the override variable because that variable is private to
 * paths.js; the comparison is exact, so it cannot mistake a real install for
 * an isolated one.
 */
function isolatedUserDataDir() {
  if (process.env.CURATOR_TEST_USER_DATA_DIR) {
    return path.resolve(process.env.CURATOR_TEST_USER_DATA_DIR);
  }
  try {
    const dir = getUserDataDir();
    if (dir !== APP_ROOT && dir !== getAppSupportDir()) return dir;
  } catch { /* fall through to the shared root */ }
  return null;
}

/**
 * Absolute path to the directory holding every bucket.
 *
 *   __setInstanceRegistryRootOverride  → that (test seam)
 *   CURATOR_TEST_INSTANCE_DIR          → that (test seam, crosses processes)
 *   an ISOLATED user-data dir          → <that>/instances
 *   otherwise                          → ~/Library/Application Support/The Curator/instances
 *
 * Pure resolver — creates nothing.
 */
export function getInstanceRegistryRoot() {
  if (_registryRootOverride) return _registryRootOverride;
  if (process.env.CURATOR_TEST_INSTANCE_DIR) {
    return path.resolve(process.env.CURATOR_TEST_INSTANCE_DIR);
  }
  const isolated = isolatedUserDataDir();
  if (isolated) return path.join(isolated, REGISTRY_SUBDIR);
  return path.join(getAppSupportDir(), REGISTRY_SUBDIR);
}

/**
 * The canonical spelling of a domains folder: resolved, and realpath'd when
 * that succeeds. Two instances reaching one folder through different symlink
 * spellings must produce the SAME string, or they never see each other.
 * A path that does not exist yet keeps its resolved form (never throws).
 */
export function canonicalDomainsPath(domainsDir) {
  const resolved = path.resolve(String(domainsDir || ''));
  try { return realpathSync(resolved); } catch { return resolved; }
}

/** The bucket directory name for a domains folder. A NAME, not the identity. */
export function bucketName(domainsDir) {
  return crypto.createHash('sha256')
    .update(canonicalDomainsPath(domainsDir), 'utf8')
    .digest('hex')
    .slice(0, BUCKET_HEX_CHARS);
}

/** Absolute path to the bucket directory for a domains folder. */
export function getBucketDir(domainsDir) {
  return path.join(getInstanceRegistryRoot(), bucketName(domainsDir));
}

/**
 * Plain words for what KIND of Curator this process is, for a sentence a
 * non-technical user reads.
 *
 * Electron is checked FIRST and on its own evidence. `describeInstall()`
 * answers "may I rewrite my own code", which is a different question: the
 * desktop build could in principle report either mode, while
 * `process.versions.electron` is present if and only if this is the app.
 */
export function describeThisInstance() {
  if (process.versions && process.versions.electron) return 'the Mac app';
  let mode = 'repo';
  try { mode = describeInstall().installMode; } catch { /* default to repo */ }
  return mode === 'bundle' ? 'an installed app' : 'a terminal checkout';
}

/**
 * Is `pid` still alive? Signal 0 tests for existence without delivering
 * anything. Copied in behaviour from write-registry.js's isPidAlive, including
 * its conservative arms: EPERM means the process exists under another user.
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    if (err && err.code === 'EPERM') return true;
    return true;
  }
}

function recordFileName(pid) {
  return `${pid}.json`;
}

/**
 * Publish `payload` at `target` with the name and the content appearing in the
 * same instant — write a per-caller tempfile, then link(2) it into place.
 * Returns true on success. Never throws.
 *
 * A pre-existing name is NOT an error here (unlike a lock): the caller decides
 * what an occupied name means, because for this registry the only way one can
 * be occupied is that THIS pid registered before, or a dead process left it.
 */
async function publishAtomically(target, payload) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const tmp = `${target}.${process.pid}.${nonce}.tmp`;
  try {
    await writeFile(tmp, payload, 'utf8');
  } catch {
    return false;
  }
  try {
    await link(tmp, target);
    return true;
  } catch {
    return false;
  } finally {
    try { await unlink(tmp); } catch { /* best-effort */ }
  }
}

/** Remove a record file, absorbing every error. */
async function dropRecord(file) {
  try { await unlink(file); } catch { /* already gone, or not ours to remove */ }
}

let _exitHandlerInstalled = false;
/** Paths this process published, removed synchronously on a clean exit. */
const _ownRecordPaths = new Set();

/**
 * Remove this process's own marker on a clean exit. Synchronous by necessity —
 * an `exit` listener cannot await. Best-effort in every arm: a failure here
 * leaves a record whose pid is dead, which the next reader clears anyway.
 */
function installExitHandler() {
  if (_exitHandlerInstalled) return;
  _exitHandlerInstalled = true;
  process.on('exit', () => {
    for (const p of _ownRecordPaths) {
      try { unlinkSync(p); } catch { /* best-effort */ }
    }
  });
}

/**
 * Announce this process as serving `domainsDir`.
 *
 * @param {{ domainsDir?: string, port?: number|string, version?: string|null }} opts
 * @returns {Promise<{ok: boolean, path?: string, reason?: string}>}  never throws
 */
export async function registerInstance(opts = {}) {
  const domainsDir = opts.domainsDir || safeDomainsDir();
  if (!domainsDir) return { ok: false, reason: 'no-domains-dir' };

  const bucket = getBucketDir(domainsDir);
  const target = path.join(bucket, recordFileName(process.pid));
  const portNum = Number(opts.port);
  const payload = JSON.stringify({
    pid: process.pid,
    port: Number.isFinite(portNum) ? portNum : null,
    kind: describeThisInstance(),
    startedAt: Date.now(),
    version: typeof opts.version === 'string' ? opts.version : null,
    // The identity test on read. The bucket hash only groups.
    domainsPath: canonicalDomainsPath(domainsDir),
  }, null, 2);

  try {
    await mkdir(bucket, { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, reason: 'registry-unwritable' };
  }

  let published = await publishAtomically(target, payload);
  if (!published) {
    // The only names that can be occupied are ours from an earlier register,
    // or a dead process's leftover under a reused pid. Either way the record
    // under OUR pid is not somebody else's live state — replace it once.
    await dropRecord(target);
    published = await publishAtomically(target, payload);
  }
  if (!published) return { ok: false, reason: 'publish-failed' };

  _ownRecordPaths.add(target);
  installExitHandler();
  return { ok: true, path: target };
}

/** Remove this process's marker for `domainsDir`. Never throws. */
export async function unregisterInstance(domainsDir = safeDomainsDir()) {
  if (!domainsDir) return;
  const target = path.join(getBucketDir(domainsDir), recordFileName(process.pid));
  _ownRecordPaths.delete(target);
  await dropRecord(target);
}

/** getDomainsDir(), with its throw absorbed — callers get null, never an error. */
function safeDomainsDir() {
  try { return getDomainsDir(); } catch { return null; }
}

/**
 * Every LIVE instance registered against `domainsDir`, this process included.
 *
 * Clears as it goes: a record that cannot be parsed, names a different folder,
 * or whose pid is gone is removed. Never throws — an unreadable registry is
 * reported as an empty one.
 *
 * @returns {Promise<Array<{pid:number, port:number|null, kind:string, startedAt:number|null, version:string|null}>>}
 */
export async function listInstances(domainsDir = safeDomainsDir()) {
  if (!domainsDir) return [];
  const canonical = canonicalDomainsPath(domainsDir);
  const bucket = getBucketDir(domainsDir);

  let names;
  try {
    names = await readdir(bucket);
  } catch {
    return [];   // no bucket yet — nobody has ever registered here
  }

  const out = [];
  let scanned = 0;
  for (const name of names) {
    if (scanned >= MAX_RECORDS_SCANNED) break;
    if (!name.endsWith('.json')) continue;   // .tmp files mid-publish, junk
    scanned++;
    const file = path.join(bucket, name);
    let record;
    try {
      record = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      // Unparseable. link(2) publishes name and content together, so this is
      // not a half-written marker — it is junk, and it is removed.
      await dropRecord(file);
      continue;
    }
    if (!record || typeof record !== 'object') { await dropRecord(file); continue; }
    if (record.domainsPath !== canonical) {
      // A different folder that happens to hash into this bucket, or a
      // leftover from before a rename. Not ours to report and not ours to
      // delete on a path-mismatch alone — leave it and move on.
      continue;
    }
    if (!isPidAlive(record.pid)) { await dropRecord(file); continue; }
    out.push({
      pid: record.pid,
      port: Number.isFinite(record.port) ? record.port : null,
      kind: typeof record.kind === 'string' ? record.kind : 'another Curator',
      startedAt: Number.isFinite(record.startedAt) ? record.startedAt : null,
      version: typeof record.version === 'string' ? record.version : null,
    });
  }
  return out;
}

/**
 * Every live instance EXCEPT this process. The banner reads this, so the
 * own-process exclusion is the difference between a warning and an app
 * warning about itself.
 */
export async function listOtherInstances(domainsDir = safeDomainsDir()) {
  const all = await listInstances(domainsDir);
  return all.filter(r => r.pid !== process.pid);
}

/**
 * One plain sentence naming the other instances, or null when there are none.
 * Shared by the server's startup log, the banner and the ingest error, so
 * those three can never describe the same situation differently.
 */
export function describeOthers(others) {
  if (!Array.isArray(others) || others.length === 0) return null;
  const parts = others.map(o => o.port ? `${o.kind} on port ${o.port}` : o.kind);
  return parts.join(', and ');
}

export const __testing = {
  isPidAlive,
  recordFileName,
  MAX_RECORDS_SCANNED,
  BUCKET_HEX_CHARS,
};
