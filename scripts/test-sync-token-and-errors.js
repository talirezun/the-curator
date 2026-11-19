#!/usr/bin/env node
/**
 * test-sync-token-and-errors.js — OFFLINE. Sync errors in plain words, and
 * Replace token (2026-11-19).
 *
 * THE INCIDENT. A user's Sync page showed, as the whole message:
 *   Command failed: git --git-dir="/Users/x/the-curator/.knowledge-git"
 *   --work-tree="/Users/x/the-curator/domains" pull --no-rebase -X theirs
 *   origin main fatal: could not read Password for 'https://***@github.com':
 *   Device not configured
 * GitHub had refused his expired token (401), git fell back to asking for a
 * password, and there was no terminal. friendlyError() had no branch for it
 * and returned git's text. The only way to change the token was Disconnect,
 * which deletes the sync history folder.
 *
 * WHAT IS PROVED HERE, against REAL git:
 *   §1  the reproduced texts map to the token sentence and code; an unknown
 *       failure is a plain sentence with the git text as `detail`, never the
 *       message; detail carries no credential and no home folder.
 *   §2  every git call runs with GIT_TERMINAL_PROMPT=0 — measured through the
 *       module against a fake GitHub that answers 401 (git then says
 *       "terminal prompts disabled", not "Device not configured").
 *   §3  a FAKE GITHUB over HTTPS (git http-backend behind a Basic-auth check,
 *       self-signed, GIT_SSL_NO_VERIFY in this process only): connect with a
 *       token, revoke it, a push fails with code sync-token-rejected.
 *   §4  Replace token refuses (bad shape, rejected, no access, unreachable,
 *       not a repository) and changes NOTHING: .sync-config.json, the git
 *       config and the remote address are sha256-identical after each.
 *   §5  Replace token succeeds: both places carry the new token and agree,
 *       every other byte of the config is unchanged, 0600, and a push works.
 *   §6  an ADOPTED git dir: the adopted repository's address is the one
 *       rewritten, `gitDir` is kept, the install's default dir is not created.
 *   §7  a config write that fails puts the git address back.
 *   §8  the routes (in-process router): {error, detail, code}, the token
 *       never in any response, the job records detail and code, remote-status
 *       carries a code and no detail; the REAL server's cross-origin guard
 *       refuses a foreign Origin on POST /api/sync/token.
 *   §9  the view: the runner keeps detail and code, a token code opens the
 *       panel beside the error, the detail line renders with its prefix,
 *       escaped, and the token input has no value attribute.
 *
 * Tokens are assembled from parts (the pre-commit secret guard).
 * Run: node scripts/test-sync-token-and-errors.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import http from 'http';
import net from 'net';
import { execSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${extra !== undefined ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }
setTimeout(() => { console.log('  ✗ watchdog: the suite did not finish in 110 s'); process.exit(1); }, 110_000).unref();

// ── Isolation, BEFORE any app module is imported ──────────────────────────
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-synctoken-')));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
fs.mkdirSync(TMP_USER, { recursive: true });
fs.mkdirSync(path.join(TMP_DOMAINS, 'demo', 'wiki', 'entities'), { recursive: true });
fs.writeFileSync(path.join(TMP_DOMAINS, 'demo', 'CLAUDE.md'), 'schema\n');
fs.writeFileSync(path.join(TMP_DOMAINS, 'demo', 'wiki', 'index.md'), '# Index\n');
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
process.env.CURATOR_NO_OPEN = '1';
delete process.env.DOMAINS_PATH;
// No user or system git config (a credential helper on this computer must not
// answer for the fake), and the fake's self-signed certificate is accepted —
// in THIS process and its children only.
const GITCFG = path.join(TMP, 'gitconfig');
fs.writeFileSync(GITCFG, '[user]\n\tname = t\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = main\n');
process.env.GIT_CONFIG_GLOBAL = GITCFG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_SSL_NO_VERIFY = '1';
delete process.env.GIT_ASKPASS;
delete process.env.SSH_ASKPASS;
delete process.env.GIT_TERMINAL_PROMPT;

const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json'].map((f) => path.join(ROOT, f));
const fingerprintReal = () => REAL_FILES.map((f) => (fs.existsSync(f)
  ? `${path.basename(f)}:${createHash('sha256').update(fs.readFileSync(f)).digest('hex')}` : `${path.basename(f)}:absent`)).join('|');
const realBefore = fingerprintReal();

const sh = (cmd, opts = {}) => execSync(cmd, { stdio: 'pipe', ...opts }).toString();
const sha = (f) => (fs.existsSync(f) ? createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'absent');

// Synthetic tokens, assembled from parts.
const P = 'gh' + 'p_';
const OLD_TOKEN = P + 'old' + 'A'.repeat(33);
const NEW_TOKEN = P + 'new' + 'B'.repeat(33);
const BAD_TOKEN = P + 'bad' + 'C'.repeat(33);
const NOACCESS_TOKEN = P + 'nac' + 'D'.repeat(33);
const ALL_TOKENS = [OLD_TOKEN, NEW_TOKEN, BAD_TOKEN, NOACCESS_TOKEN];
const HOME = os.homedir();
const leaks = (text) => {
  const s = String(text);
  const found = ALL_TOKENS.filter((t) => s.includes(t));
  if (HOME && HOME.length > 1 && s.includes(HOME)) found.push('home folder');
  if (/\/Users\/[A-Za-z0-9._-]+/.test(s) || /\/home\/[A-Za-z0-9._-]+/.test(s)) found.push('/Users/ or /home/ path');
  return found;
};

// ── The fake GitHub: git http-backend behind a Basic-auth check, over TLS ──
// curl, given `https://<token>@host`, retries a 401 with Basic "<token>:"
// (measured: the first request carries no Authorization, the second carries
// exactly that), so the check is the token as the user name.
const CERT_DIR = path.join(TMP, 'tls');
fs.mkdirSync(CERT_DIR);
sh(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${path.join(CERT_DIR, 'k.pem')}" -out "${path.join(CERT_DIR, 'c.pem')}" -days 1 -subj "/CN=127.0.0.1"`);
const PROJECT_ROOT = path.join(TMP, 'github');
fs.mkdirSync(path.join(PROJECT_ROOT, 'owner'), { recursive: true });
sh(`git init --bare -q "${path.join(PROJECT_ROOT, 'owner', 'wiki.git')}"`);
sh(`git --git-dir="${path.join(PROJECT_ROOT, 'owner', 'wiki.git')}" config http.receivepack true`);
const fake = { accepted: new Set([OLD_TOKEN]), noAccess: new Set([NOACCESS_TOKEN]), requests: 0 };

function basicUser(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
  return dec.split(':')[0];
}
const ghServer = https.createServer({
  key: fs.readFileSync(path.join(CERT_DIR, 'k.pem')),
  cert: fs.readFileSync(path.join(CERT_DIR, 'c.pem')),
}, (req, res) => {
  fake.requests++;
  const user = basicUser(req);
  if (!user || (!fake.accepted.has(user) && !fake.noAccess.has(user))) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
    res.end('Invalid username or token.');
    return;
  }
  if (fake.noAccess.has(user)) { res.writeHead(404); res.end('Repository not found.'); return; }
  const [pathInfo, qs = ''] = req.url.split('?');
  const child = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: PROJECT_ROOT, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: pathInfo, QUERY_STRING: qs,
      REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '', REMOTE_USER: 'owner', REMOTE_ADDR: '127.0.0.1',
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  req.pipe(child.stdin);
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d));
  child.on('close', () => {
    const buf = Buffer.concat(chunks);
    const sep = buf.indexOf('\r\n\r\n');
    const head = buf.slice(0, sep).toString('utf8').split('\r\n');
    const body = buf.slice(sep + 4);
    let status = 200;
    const headers = {};
    for (const line of head) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 200; else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.end(body);
  });
});
await new Promise((r) => ghServer.listen(0, '127.0.0.1', r));
const GH_PORT = ghServer.address().port;
const REPO_URL = `https://127.0.0.1:${GH_PORT}/owner/wiki`;

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function extractFunction(src, name, where) {
  const m = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let i = src.indexOf('(', start);
  let pd = 0;
  for (; i < src.length; i++) { if (src[i] === '(') pd++; else if (src[i] === ')') { pd--; if (pd === 0) { i++; break; } } }
  i = src.indexOf('{', i);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i);
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced in ${where}`);
  return out.replace(/^export\s+/, '');
}

const sync = await import('../src/brain/sync.js');
const { getDomainsDir } = await import('../src/brain/config.js');
const { getSyncConfigFile, getSyncGitDir } = await import('../src/brain/paths.js');
const express = (await import('express')).default;
const syncRouter = (await import('../src/routes/sync.js')).default;
const { __resetSyncJobForTest } = await import('../src/brain/sync-job.js');
const { describeSyncError, friendlyError, replaceToken } = sync;

const CONFIG = getSyncConfigFile();
const GITDIR = getSyncGitDir();
const remoteUrlOf = (gitDir) => { try { return sh(`git --git-dir="${gitDir}" config --get remote.origin.url`).trim(); } catch { return null; } };
const snapshot = (gitDir = GITDIR, cfg = CONFIG) => ({ cfg: sha(cfg), gitcfg: sha(path.join(gitDir, 'config')), url: remoteUrlOf(gitDir) });
const sameSnap = (a, b) => a.cfg === b.cfg && a.gitcfg === b.gitcfg && a.url === b.url;

let routeServer = null;
let realServer = null;
try {
// ═══════════════════════════════════════════════════════════════════════════
section('§0  Isolation');
// ═══════════════════════════════════════════════════════════════════════════
ok(getDomainsDir() === TMP_DOMAINS, 'the domains dir is the tempdir');
ok(CONFIG.startsWith(TMP_USER) && GITDIR.startsWith(TMP_USER), 'the sync config and git dir are in the tempdir');

// ═══════════════════════════════════════════════════════════════════════════
section('§1  The reproduced texts, in plain words');
// ═══════════════════════════════════════════════════════════════════════════
const INCIDENT = 'Command failed: git --git-dir="/Users/x/the-curator/.knowledge-git" --work-tree="/Users/x/the-curator/domains" ' +
  "pull --no-rebase -X theirs origin main fatal: could not read Password for 'https://***@github.com': Device not configured";
const MEASURED = {
  'incident (Device not configured)': INCIDENT,
  'password, prompts disabled': "fatal: could not read Password for 'https://***@github.com': terminal prompts disabled",
  'username, no tty': "fatal: could not read Username for 'https://github.com': Device not configured",
  'username, prompts disabled': "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  'Linux no-tty wording': "fatal: could not read Password for 'https://***@github.com': No such device or address",
  'credential helper answered': 'remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for \'https://github.com/o/r.git/\'',
};
for (const [label, text] of Object.entries(MEASURED)) {
  const d = describeSyncError(new Error(text));
  ok(d.code === 'sync-token-rejected', `${label}: code sync-token-rejected`, d);
  ok(/rejected the token saved for Sync/.test(d.error) && /Nothing was lost/.test(d.error) && /Replace token/.test(d.error),
    `${label}: the sentence says what happened, that nothing was lost, and names Replace token`, d.error);
  ok(friendlyError(new Error(text)) === d.error, `${label}: friendlyError() returns the same sentence`);
}
{
  const d = describeSyncError(new Error(INCIDENT));
  ok(!/git --git-dir|Command failed|--work-tree/.test(d.error), 'the incident: no git command in the message');
  ok(typeof d.detail === 'string' && d.detail.includes('could not read Password') && d.detail.includes('~/the-curator'),
    'the incident: the git text is the detail, with the home folder as ~', d.detail);
  ok(!d.detail.includes('/Users/x'), 'the incident: no /Users/<name> in the detail');
  const c = describeSyncError(new Error(INCIDENT), { context: 'connect' });
  ok(c.code === 'sync-token-rejected' && /press Connect again/.test(c.error) && !/Replace token/.test(c.error),
    'on the connect screen the same failure names Connect, which is on that screen, not Replace token', c.error);
}
{
  const d403 = describeSyncError(new Error("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403"));
  ok(d403.code === 'sync-token-no-access' && /Contents: Read and write/.test(d403.error), 'measured 403: the scope sentence, code sync-token-no-access', d403);
  const d404 = describeSyncError(new Error("fatal: repository 'https://github.com/o/r.git/' not found"));
  ok(d404.code === 'sync-repo-not-found' && /Repository not found/.test(d404.error), 'measured 404: unchanged sentence', d404);
  const off = describeSyncError(new Error("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"));
  ok(off.code === 'sync-offline' && /Cannot reach GitHub/.test(off.error), 'offline: unchanged sentence', off);
  const conflict = describeSyncError(new Error('Automatic merge failed; fix conflicts and then commit the result. a401b 403c'));
  ok(conflict.code === 'sync-merge-conflict', 'ORDER: a conflict carrying 401/403-like text is still a conflict, not a token', conflict.code);
  ok(friendlyError(new Error('nothing to commit, working tree clean')) === null, 'nothing to commit is still not an error (friendlyError null)');
}
{
  const UNKNOWN = `Command failed: git --git-dir="${HOME}/the-curator/.knowledge-git" --work-tree="${HOME}/the-curator/domains" ` +
    `push origin main\nerror: something odd happened at https://${OLD_TOKEN}@github.com/o/r.git and /Users/someone/x`;
  const d = describeSyncError(new Error(UNKNOWN));
  ok(d.code === 'sync-failed', 'an unrecognised failure: code sync-failed', d.code);
  ok(/Sync couldn’t finish\. Nothing was lost/.test(d.error) && /technical detail below/.test(d.error),
    'an unrecognised failure: a plain sentence, what was lost, what to do', d.error);
  ok(!/git --git-dir|Command failed|--work-tree/.test(d.error) && leaks(d.error).length === 0,
    'the fallback message carries no git command, token or home folder', d.error);
  ok(d.detail && d.detail.includes('something odd happened'), 'the raw text survives as detail, for support');
  ok(leaks(d.detail).length === 0, 'the detail carries no token and no home folder', { leaks: leaks(d.detail), detail: d.detail });
  ok(friendlyError(new Error(UNKNOWN)) === d.error, 'friendlyError(): the same plain sentence, never git text');
  ok(sync.remoteErrorMessage(new Error(UNKNOWN)) === 'Could not reach GitHub to check for incoming changes.',
    'the background check keeps its own sentence for an unrecognised failure');
  ok(sync.remoteErrorCode(new Error(INCIDENT)) === 'sync-token-rejected', 'the background check reports the token code');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  GIT_TERMINAL_PROMPT=0 on every git call');
// ═══════════════════════════════════════════════════════════════════════════
ok(sync.__subprocessEnvForTest().GIT_TERMINAL_PROMPT === '0', 'the env sync.js runs git with sets GIT_TERMINAL_PROMPT=0');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  Connect through the fake GitHub, then the token is revoked');
// ═══════════════════════════════════════════════════════════════════════════
const r0 = await sync.setup(REPO_URL, OLD_TOKEN, 'push');
ok(r0 && sync.isConfigured(), 'CONTROL: connect with a token the fake accepts works over HTTPS', r0);
ok(remoteUrlOf(GITDIR).includes(OLD_TOKEN), 'CONTROL: the token lives in the origin address of the git dir');
ok(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).token === OLD_TOKEN, 'CONTROL: …and in .sync-config.json');
fs.writeFileSync(path.join(TMP_DOMAINS, 'demo', 'wiki', 'entities', 'a.md'), '# A\n');
const p1 = await sync.push();
ok(p1 && p1.pushed !== false, 'CONTROL: a push with the accepted token reaches the fake', p1);

fake.accepted.delete(OLD_TOKEN); // GitHub revokes it
fs.writeFileSync(path.join(TMP_DOMAINS, 'demo', 'wiki', 'entities', 'b.md'), '# B\n');
let pushErr = null;
try { await sync.push(); } catch (e) { pushErr = e; }
ok(pushErr !== null, 'a push with a revoked token fails');
const pd = describeSyncError(pushErr);
ok(pd.code === 'sync-token-rejected', 'REAL git, real chain: the failure is code sync-token-rejected', pd);
ok(/terminal prompts disabled/.test(pushErr.message),
  'git said "terminal prompts disabled": it was never allowed to ask for a password', pushErr.message.slice(-160));
ok(leaks(pushErr.message).length === 0 && leaks(JSON.stringify(pd)).length === 0, 'neither the error nor its description carries a token or home folder', leaks(JSON.stringify(pd)));

// ═══════════════════════════════════════════════════════════════════════════
section('§4  Replace token refuses, and nothing changes');
// ═══════════════════════════════════════════════════════════════════════════
async function refusedCase(label, tok, wantCode, gitDir = GITDIR, cfg = CONFIG) {
  const before = snapshot(gitDir, cfg);
  let err = null;
  try { await replaceToken(tok); } catch (e) { err = e; }
  const ref = sync.syncRefusalOf(err);
  ok(ref && ref.code === wantCode, `${label}: refused with ${wantCode}`, ref || (err && err.message));
  ok(sameSnap(before, snapshot(gitDir, cfg)), `${label}: .sync-config.json, the git config and the address are sha256-identical`, { before, after: snapshot(gitDir, cfg) });
  const said = JSON.stringify(ref || {}) + (err ? err.message : '');
  ok(leaks(said).length === 0, `${label}: no token or home folder in what is said`, leaks(said));
  ok(ref && /nothing was changed|Nothing was changed|still has the token/i.test(ref.message), `${label}: the sentence says nothing was changed`, ref && ref.message);
  return ref;
}
await refusedCase('bad shape', 'not a token at all', 'sync-token-invalid');
await refusedCase('shell metacharacters', P + 'x"; rm -rf ~; echo "' + 'A'.repeat(20), 'sync-token-invalid');
await refusedCase('a token GitHub refuses', BAD_TOKEN, 'sync-new-token-rejected');
await refusedCase('a token without access to this repository', NOACCESS_TOKEN, 'sync-new-token-no-access');
{
  // Unreachable and not-a-repository: rigs of their own, configured by hand.
  for (const [label, repoUrl, code] of [
    ['GitHub unreachable', `https://127.0.0.1:${await freePort()}/owner/wiki`, 'sync-token-check-offline'],
    ['not a repository', `file://${path.join(TMP, 'nothing-here.git')}`, 'sync-token-check-failed'],
  ]) {
    const rig = path.join(TMP, 'rig-' + label.replace(/\W+/g, '-'));
    const gd = path.join(rig, 'git'); const cf = path.join(rig, 'sync.json');
    fs.mkdirSync(rig, { recursive: true });
    sh(`git init -q --bare "${gd}"`);
    sh(`git --git-dir="${gd}" remote add origin "${repoUrl.startsWith('file:') ? repoUrl : repoUrl.replace('https://', `https://${OLD_TOKEN}@`)}.git"`);
    fs.writeFileSync(cf, JSON.stringify({ repoUrl, token: OLD_TOKEN }, null, 2), { mode: 0o600 });
    sync.__setSyncTestOverrides({ gitDir: gd, configFile: cf });
    try {
      const ref = await refusedCase(label, NEW_TOKEN, code, gd, cf);
      if (code === 'sync-token-check-failed') ok(ref && typeof ref.detail === 'string' && ref.detail.length > 0, `${label}: the git text is kept as detail`, ref);
    } finally { sync.__setSyncTestOverrides({}); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  Replace token succeeds: both places, agreeing, and a push works');
// ═══════════════════════════════════════════════════════════════════════════
{
  fake.accepted.add(NEW_TOKEN);
  const beforeText = fs.readFileSync(CONFIG, 'utf8');
  const res = await replaceToken('  ' + NEW_TOKEN + '\n');
  ok(res && res.replaced === true, 'replaced', res);
  ok(leaks(JSON.stringify(res)).length === 0, 'the result carries no token', res);
  const after = fs.readFileSync(CONFIG, 'utf8');
  ok(after === beforeText.split(OLD_TOKEN).join(NEW_TOKEN), '.sync-config.json: every other byte unchanged, only the token');
  ok((fs.statSync(CONFIG).mode & 0o777) === 0o600, '.sync-config.json stays 0600', (fs.statSync(CONFIG).mode & 0o777).toString(8));
  const url = remoteUrlOf(GITDIR);
  ok(url.includes(NEW_TOKEN) && !url.includes(OLD_TOKEN), 'the origin address carries the new token');
  ok(url === `https://${JSON.parse(after).token}@127.0.0.1:${GH_PORT}/owner/wiki.git`, 'the two places agree');
  ok((fs.statSync(path.join(GITDIR, 'config')).mode & 0o777) === 0o600, 'the git config holding the address is 0600');
  const p2 = await sync.push();
  ok(p2 && p2.pushed === true, 'the push that failed with the revoked token now goes through', p2);
  const st = await sync.getStatus();
  ok(st.configured && leaks(JSON.stringify(st)).length === 0, 'status carries no token');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  An adopted git dir');
// ═══════════════════════════════════════════════════════════════════════════
{
  const rig = path.join(TMP, 'adopt');
  const other = path.join(rig, 'other-install', '.knowledge-git');
  const ownDefault = path.join(rig, 'this-install', '.knowledge-git');
  const cf = path.join(rig, 'this-install', '.sync-config.json');
  fs.mkdirSync(path.dirname(cf), { recursive: true });
  sh(`git init -q --bare "${other}"`);
  sh(`git --git-dir="${other}" remote add origin "https://${OLD_TOKEN}@127.0.0.1:${GH_PORT}/owner/wiki.git"`);
  fs.writeFileSync(cf, JSON.stringify({ repoUrl: REPO_URL, token: OLD_TOKEN, gitDir: other }, null, 2), { mode: 0o600 });
  sync.__setSyncTestOverrides({ gitDir: ownDefault, configFile: cf });
  try {
    ok(sync.__testing.currentGitDir() === other, 'CONTROL: this install resolves to the adopted git dir');
    const before = fs.readFileSync(cf, 'utf8');
    await replaceToken(NEW_TOKEN);
    const cfg = JSON.parse(fs.readFileSync(cf, 'utf8'));
    ok(cfg.gitDir === other, 'gitDir is kept: the install stays adopted');
    ok(fs.readFileSync(cf, 'utf8') === before.split(OLD_TOKEN).join(NEW_TOKEN), 'only the token changed in the config');
    ok(remoteUrlOf(other).includes(NEW_TOKEN), 'the adopted repository’s address carries the new token');
    ok(!fs.existsSync(ownDefault), 'the install’s own default git dir was not created');
  } finally { sync.__setSyncTestOverrides({}); }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  A config write that fails puts the git address back');
// ═══════════════════════════════════════════════════════════════════════════
if (process.getuid && process.getuid() === 0) {
  ok(true, 'SKIPPED as root: a read-only folder does not stop root');
} else {
  const rig = path.join(TMP, 'rollback');
  const gd = path.join(rig, 'git'); const cfDir = path.join(rig, 'cfg'); const cf = path.join(cfDir, 'sync.json');
  fs.mkdirSync(cfDir, { recursive: true });
  sh(`git init -q --bare "${gd}"`);
  sh(`git --git-dir="${gd}" remote add origin "https://${OLD_TOKEN}@127.0.0.1:${GH_PORT}/owner/wiki.git"`);
  fs.writeFileSync(cf, JSON.stringify({ repoUrl: REPO_URL, token: OLD_TOKEN }, null, 2), { mode: 0o600 });
  sync.__setSyncTestOverrides({ gitDir: gd, configFile: cf });
  const urlBefore = remoteUrlOf(gd);
  const cfgBefore = sha(cf);
  fs.chmodSync(cfDir, 0o500); // the atomic write's temp file cannot be created
  let err = null;
  try { await replaceToken(NEW_TOKEN); } catch (e) { err = e; }
  fs.chmodSync(cfDir, 0o700);
  sync.__setSyncTestOverrides({});
  const ref = sync.syncRefusalOf(err);
  ok(ref && ref.code === 'sync-token-save-failed', 'refused with sync-token-save-failed', ref || (err && err.message));
  ok(remoteUrlOf(gd) === urlBefore, 'the git address is the old one again: the two places still agree');
  ok(sha(cf) === cfgBefore, 'the config is unchanged');
  ok(leaks(JSON.stringify(ref || {})).length === 0, 'no token or home folder in the refusal');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  The routes');
// ═══════════════════════════════════════════════════════════════════════════
{
  __resetSyncJobForTest();
  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRouter);
  routeServer = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${routeServer.address().port}/api/sync`;
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = {}; try { json = JSON.parse(text); } catch { json = {}; }
    return { status: r.status, text, json };
  };

  const missing = await post('/token', {});
  ok(missing.status === 400 && missing.json.code === 'sync-token-missing', 'no token: 400, sync-token-missing', missing.json);
  const bad = await post('/token', { token: BAD_TOKEN });
  ok(bad.status === 400 && bad.json.code === 'sync-new-token-rejected' && typeof bad.json.error === 'string', 'a refused token: 400 {error, code}', bad.json);
  ok(leaks(bad.text).length === 0, 'the refused token is not echoed, nor any other', leaks(bad.text));

  fake.accepted.add(OLD_TOKEN);
  const good = await post('/token', { token: OLD_TOKEN });
  ok(good.status === 200 && good.json.success === true && good.json.configured === true, 'an accepted token: 200, success, the status', good.json);
  ok(leaks(good.text).length === 0, 'the success answer carries no token', leaks(good.text));
  ok(remoteUrlOf(GITDIR).includes(OLD_TOKEN), 'the route really replaced it');

  // Revoke it and push: the shape every failing route now has.
  fake.accepted.delete(OLD_TOKEN);
  fs.writeFileSync(path.join(TMP_DOMAINS, 'demo', 'wiki', 'entities', 'c.md'), '# C\n');
  const pushed = await post('/push');
  ok(pushed.status === 500 && pushed.json.code === 'sync-token-rejected', 'a push with a revoked token: 500 {code: sync-token-rejected}', pushed.json);
  ok(/Replace token/.test(pushed.json.error || '') && !/git --git-dir|Command failed/.test(pushed.json.error || ''), 'its error is the plain sentence', pushed.json.error);
  ok(typeof pushed.json.detail === 'string' && /terminal prompts disabled/.test(pushed.json.detail), 'its detail is git’s text', pushed.json.detail);
  ok(leaks(pushed.text).length === 0, 'no token or home folder anywhere in it', leaks(pushed.text));
  const job = await (await fetch(base + '/job')).json();
  ok(job.last && job.last.state === 'failed' && job.last.code === 'sync-token-rejected' && typeof job.last.detail === 'string',
    'the job record carries the code and the detail, for a page that only follows the run', job.last);
  ok(leaks(JSON.stringify(job)).length === 0, 'the job record carries no token');
  const rs = await (await fetch(base + '/remote-status')).json();
  ok(rs.remoteChecked === false && rs.remoteErrorCode === 'sync-token-rejected' && !('detail' in rs), 'remote-status: the code, and no detail on the background poll', rs);
  ok(leaks(JSON.stringify(rs)).length === 0, 'remote-status carries no token');
}
{
  // The REAL server: the cross-origin guard covers POST /api/sync/token.
  const port = await freePort();
  realServer = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CURATOR_NO_OPEN: '1', CURATOR_TEST_USER_DATA_DIR: TMP_USER,
      CURATOR_TEST_DOMAINS_DIR: TMP_DOMAINS, CURATOR_TEST_LOG_DIR: path.join(TMP_USER, 'logs'),
      CURATOR_TEST_MCP_LAUNCHER_DIR: path.join(TMP_USER, 'bin') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  realServer.stdout.on('data', (c) => { out += c; });
  realServer.stderr.on('data', (c) => { out += c; });
  const reqRaw = (headers, body) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/sync/token', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    r.on('error', () => resolve({ status: 0, text: '' }));
    r.end(body);
  });
  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    const r = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/sync/job' }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve(0));
    });
    if (r === 200) up = true; else await new Promise((r2) => setTimeout(r2, 100));
  }
  ok(up, 'CONTROL: the real server started', out.slice(0, 400));
  const foreign = await reqRaw({ Origin: 'https://evil.example' }, JSON.stringify({ token: BAD_TOKEN }));
  ok(foreign.status === 403 && !foreign.text.includes(BAD_TOKEN), 'a foreign Origin is refused 403 before the route runs', foreign);
  const noOrigin = await reqRaw({}, JSON.stringify({ token: BAD_TOKEN }));
  ok(noOrigin.status === 400 && /sync-new-token-rejected/.test(noOrigin.text) && !noOrigin.text.includes(BAD_TOKEN),
    'CONTROL: the same request from the app’s side reaches the route', noOrigin);
  ok(!out.includes(BAD_TOKEN), 'the server printed no token');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9  The view and the runner');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { createSyncRunner } = await import('../src/public/next/shared/sync-run.js');
  const runner = createSyncRunner({
    fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: 'GitHub rejected the token saved for Sync.', detail: 'fatal: x', code: 'sync-token-rejected' }) }),
    setTimeout: () => 0, clearTimeout: () => {},
  });
  const o = await runner.startSyncRun('push');
  ok(o && o.ok === false && o.detail === 'fatal: x' && o.code === 'sync-token-rejected', 'the runner keeps the route’s detail and code', o);

  const viewSrc = fs.readFileSync(path.join(ROOT, 'src/public/next/views/sync.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');
  const box = new Function(
    `const SYNC_RUN_KINDS = ['sync', 'push', 'pull'];\n` +
    extractFunction(appSrc, 'escapeHtml', 'app.js') + '\n' +
    ['freshState', 'seedFromSyncRun', 'syncErrorHtml', 'tokenErrorCodes', 'tokenPanelOpen', 'renderTokenPanel']
      .map((n) => extractFunction(viewSrc, n, 'views/sync.js')).join('\n') + '\n' +
    'let state = freshState();\n' +
    'return { freshState, seedFromSyncRun, syncErrorHtml, tokenPanelOpen, renderTokenPanel, setState: (s) => { state = s; } };')();
  const st = box.seedFromSyncRun(box.freshState(), null, o);
  ok(st.actionErrorCode === 'sync-token-rejected' && st.actionErrorDetail === 'fatal: x', 'a mount seeds the code and the detail');
  ok(box.tokenPanelOpen(st) === true, 'a token code opens Replace token beside the error');
  const other = box.seedFromSyncRun(box.freshState(), null, { ...o, code: 'sync-failed' });
  ok(box.tokenPanelOpen(other) === false, 'CONTROL: another failure does not');
  box.setState(st);
  const html = box.renderTokenPanel({ repoUrl: 'github.com/o/r' }, false);
  ok(/id="sync-token-panel"/.test(html) && /id="sync-token-input"/.test(html) && /id="btn-token-save"/.test(html), 'the open panel renders the field and the save button');
  ok(!/id="sync-token-input"[^>]*value=/.test(html), 'the token input has NO value attribute (the token never enters markup)');
  const closed = box.freshState();
  box.setState(closed);
  ok(/id="btn-token-open"/.test(box.renderTokenPanel({ repoUrl: 'x' }, false)), 'with no token error: one Replace token button');
  const eh = box.syncErrorHtml('Sentence.', '<b>git</b> said & "this"');
  ok(eh.includes('Technical detail (for support):') && eh.includes('&lt;b&gt;git&lt;/b&gt;') && !eh.includes('<b>git'), 'the detail line: prefixed, escaped', eh);
  ok(!box.syncErrorHtml('Sentence.', null).includes('Technical detail'), 'no detail, no detail line');
}

} finally {
  if (routeServer) await new Promise((r) => routeServer.close(r));
  if (realServer) { try { realServer.kill('SIGKILL'); } catch { /* gone */ } }
  await new Promise((r) => ghServer.close(r));
  ghServer.closeAllConnections?.();
}

section('§10  The real credential files were never touched');
ok(fingerprintReal() === realBefore, 'the repository’s own .curator-config.json / .sync-config.json / .sharedbrain-config.json are unchanged');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ FAILURES');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('✅ Sync errors are plain words, and a token can be replaced without Disconnect');
process.exit(0);
