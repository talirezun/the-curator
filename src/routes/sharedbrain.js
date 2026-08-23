// This file is licensed under the Curator Enterprise License — NOT MIT.
// Free for personal, educational, evaluation, development and testing use,
// and for production use of the GitHub-backed Shared Brain (free forever).
// Other organizational production use will require a license key once keys
// exist — until then it is free too (grace clause). Each release's version of
// this file converts to MIT two years after that release was published.
// See LICENSES/LICENSE-ENTERPRISE.txt and LICENSES/ENTERPRISE-FILES.txt.
/**
 * Shared Brain — HTTP routes (Phase 4A, v3.0.0-beta+)
 *
 * Mounted at /api/sharedbrain in src/server.js. All endpoints honour
 * the `sharedBrainEnabled` feature flag via the `gate()` middleware —
 * when the flag is false (the v2.8.0 default for existing users), every
 * route returns 404 with a clear message. UI hides the section in
 * parallel based on `GET /api/sharedbrain/feature-flag`.
 *
 * Endpoint inventory:
 *
 *   GET    /feature-flag           Is Shared Brain enabled on this install?
 *   POST   /enable-flag            Flip the flag to true (opt-in for beta)
 *
 *   GET    /list                   List all connections (tokens masked)
 *   POST   /save                   Insert / update a connection
 *   DELETE /:id                    Remove connection from this machine
 *
 *   POST   /:id/push               Push contributions (SSE stream)
 *   POST   /:id/pull               Pull collective updates (SSE stream)
 *   POST   /:id/synthesize         Run synthesis locally (SSE stream)
 *   POST   /:id/revoke             Admin-only revoke (Decision 6b)
 *
 *   POST   /parse-invite           Decode an invite token to its metadata
 *   POST   /generate-invite        Encode metadata into an invite token
 *   POST   /validate-pat           Live PAT validator against a real repo
 *
 * Security notes:
 *   - The full PAT is NEVER returned in any list/get response. We use
 *     getSharedBrains() (masked) for UI calls and getSharedBrainWithToken()
 *     only for internal push/pull/synthesize/revoke.
 *   - validate-pat takes the PAT in the request body, calls GitHub once,
 *     and never persists the PAT until /save fires with the full record.
 *   - parse-invite and generate-invite never touch credentials at all.
 *   - revoke requires the connection's admin_token AND a literal
 *     "REVOKE-<fellow_id>" confirmation string per Decision 6b.
 */

import { Router } from 'express';
import { randomUUID, createHash, timingSafeEqual, randomBytes } from 'crypto';

import {
  getSharedBrainEnabled,
  setSharedBrainEnabled,
} from '../brain/config.js';

import {
  getSharedBrains,
  getSharedBrainWithToken,
  saveSharedBrain,
  removeSharedBrain,
  patchSharedBrain,
  newUuid,
} from '../brain/sharedbrain-config.js';

import { pushDomain, pullCollective, computePendingPages, listMembers } from '../brain/sharedbrain.js';
import { runLocalSynthesis }          from '../brain/sharedbrain-synthesis.js';
import { revokeContributor, hashAdminToken } from '../brain/sharedbrain-revoke.js';
import { domainPath } from '../brain/files.js';
import {
  registerWrite,
  acquireFileLock,
  isUpdateInProgress,
  conflictResponse,
} from '../brain/write-registry.js';

const router = Router();

// ── Feature-flag gate ────────────────────────────────────────────────────
//
// All routes except feature-flag-read and feature-flag-enable check this
// gate. When the flag is false, the entire surface is invisible to the
// browser — 404 prevents probing/feature detection by malicious local code.

function gate(req, res, next) {
  if (!getSharedBrainEnabled()) {
    return res.status(404).json({
      error: 'Shared Brain is not enabled on this install. ' +
        'POST /api/sharedbrain/enable-flag to opt in (beta).',
    });
  }
  next();
}

// ── Validators ───────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const REPO_RE = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;

function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }
function isSlug(s) { return typeof s === 'string' && SLUG_RE.test(s); }
// REPO_RE's name part admits "." / ".." — no SSRF (the GitHub host is
// hardcoded and URL normalisation stays on api.github.com), but reject them
// explicitly for cleanliness (v3.0.2).
function isValidRepo(s) {
  if (typeof s !== 'string') return false;
  const m = s.match(REPO_RE);
  return !!m && m[2] !== '.' && m[2] !== '..';
}

// ── Invite token codec ───────────────────────────────────────────────────
//
// Format: sbi_<base64url(JSON)>. The JSON carries metadata only — repo,
// display name, branch, shared_domain. NO credentials.
//
// Versioned via `v` field so future tokens can add fields without breaking
// older Curator versions. v1 readers tolerate extra fields they don't know.

const INVITE_VERSION = 1;
const INVITE_PREFIX = 'sbi_';

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(
    str.replace(/-/g, '+').replace(/_/g, '/') + pad,
    'base64'
  ).toString('utf8');
}

// Decision 6c — admin picks which IP mode applies cohort-wide. Encoded in
// the invite token so every contributor's wizard sees the matching consent
// text on their own machine.
const VALID_DATA_HANDLING_TERMS = ['contributor_retains', 'organisational'];

export function encodeInviteToken(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('encodeInviteToken: metadata is required');
  }
  const payload = {
    v: INVITE_VERSION,
    storage_type: metadata.storage_type || 'github',
    repo:          metadata.repo,
    name:          metadata.name,
    shared_domain: metadata.shared_domain,
    branch:        metadata.branch || 'main',
    data_handling_terms: metadata.data_handling_terms || 'contributor_retains',
  };
  // Sanity-check required fields BEFORE encoding so a bad invite token
  // can't be generated in the first place.
  if (!isValidRepo(payload.repo || '')) throw new Error('encodeInviteToken: repo must be "owner/name"');
  if (typeof payload.name !== 'string' || !payload.name.trim()) throw new Error('encodeInviteToken: name is required');
  if (!isSlug(payload.shared_domain)) throw new Error('encodeInviteToken: shared_domain must be slug-shaped');
  if (!VALID_DATA_HANDLING_TERMS.includes(payload.data_handling_terms)) {
    throw new Error(`encodeInviteToken: data_handling_terms must be one of ${VALID_DATA_HANDLING_TERMS.join(' | ')}`);
  }
  return INVITE_PREFIX + base64UrlEncode(JSON.stringify(payload));
}

// Real invite tokens are a few hundred bytes. Anything bigger is garbage —
// cap BEFORE the regex/base64/JSON work so a pasted megabyte can't spike
// memory (the JSON body limit is 50 MB for Health batch plans) (v3.0.2).
const INVITE_TOKEN_MAX_CHARS = 8192;

export function decodeInviteToken(token) {
  if (typeof token !== 'string' || !token.startsWith(INVITE_PREFIX)) {
    throw new Error('Invite token must start with "sbi_"');
  }
  if (token.length > INVITE_TOKEN_MAX_CHARS) {
    throw new Error('Invite token is too long to be valid');
  }
  const body = token.slice(INVITE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    throw new Error('Invite token contains invalid characters');
  }
  let parsed;
  try {
    parsed = JSON.parse(base64UrlDecode(body));
  } catch {
    throw new Error('Invite token is malformed (could not decode payload)');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invite token payload is not an object');
  if (typeof parsed.v !== 'number' || parsed.v < 1) throw new Error('Invite token version is missing or invalid');
  if (parsed.v > INVITE_VERSION) {
    throw new Error(`Invite token uses version ${parsed.v}; this Curator install supports up to v${INVITE_VERSION}. Update The Curator.`);
  }
  if (!isValidRepo(parsed.repo || '')) throw new Error('Invite token: repo must be "owner/name"');
  if (typeof parsed.name !== 'string' || !parsed.name.trim()) throw new Error('Invite token: name is required');
  if (!isSlug(parsed.shared_domain)) throw new Error('Invite token: shared_domain must be slug-shaped');
  if (parsed.branch) {
    // Valid git ref name: alphanumeric start, no consecutive dots, no leading
    // dot per path component. Belt-and-braces — the GitHub adapter would also
    // reject malformed refs, but tighter validation upstream protects callers.
    const okBranch = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(parsed.branch) && !parsed.branch.includes('..');
    if (!okBranch) throw new Error('Invite token: branch is invalid (must be a valid git ref, no .. segments)');
  }
  if (parsed.storage_type && !['github', 'local', 'cloudflare-r2'].includes(parsed.storage_type)) {
    throw new Error(`Invite token: unsupported storage_type "${parsed.storage_type}"`);
  }
  // Decision 6c — tolerate missing data_handling_terms for backward compat
  // with v2.8.0 tokens; default to contributor_retains (the safer default).
  if (parsed.data_handling_terms === undefined) {
    parsed.data_handling_terms = 'contributor_retains';
  }
  if (!VALID_DATA_HANDLING_TERMS.includes(parsed.data_handling_terms)) {
    throw new Error(`Invite token: unsupported data_handling_terms "${parsed.data_handling_terms}"`);
  }
  return parsed;
}

// ── Feature flag ─────────────────────────────────────────────────────────

router.get('/feature-flag', (_req, res) => {
  res.json({ enabled: getSharedBrainEnabled() });
});

router.post('/enable-flag', (_req, res) => {
  try {
    const enabled = setSharedBrainEnabled(true);
    res.json({ enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── List, save, remove ───────────────────────────────────────────────────

router.get('/list', gate, async (_req, res) => {
  try {
    const connections = getSharedBrains();
    // v3.0.4 (M14): cheap local pending-push count per connection —
    // mtime scan only, no LLM/network. Powers the navbar badge and the
    // connection card. Additive field; failures degrade to 0.
    for (const c of connections) {
      try { c.pending_pages = await computePendingPages(c); }
      catch { c.pending_pages = 0; }
    }
    res.json({ connections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/save', gate, (req, res) => {
  try {
    const conn = req.body && req.body.connection;
    if (!conn || typeof conn !== 'object') {
      return res.status(400).json({ error: 'connection object is required in body' });
    }
    // Caller may omit id / fellow_id for first save — assign UUIDs.
    if (!conn.id)        conn.id        = newUuid();
    if (!conn.fellow_id) conn.fellow_id = newUuid();
    // Defaults for fields the wizard doesn't surface
    if (!conn.pending_retry)  conn.pending_retry  = {};
    if (!conn.permanent_skip) conn.permanent_skip = [];
    if (conn.enabled === undefined) conn.enabled = true;
    if (conn.attribute_by_name === undefined) conn.attribute_by_name = false;
    if (conn.read_only === undefined) conn.read_only = false;

    const masked = saveSharedBrain(conn);
    res.json({ connection: masked });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', gate, (req, res) => {
  try {
    const id = req.params.id;
    if (!isUuid(id)) return res.status(400).json({ error: 'id must be a UUID' });
    const removed = removeSharedBrain(id);
    if (!removed) return res.status(404).json({ error: 'connection not found' });
    res.json({ removed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SSE helpers ──────────────────────────────────────────────────────────

function openSseStream(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  return (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

function loadConnectionOr404(id, res) {
  if (!isUuid(id)) {
    res.status(400).json({ error: 'id must be a UUID' });
    return null;
  }
  const conn = getSharedBrainWithToken(id);
  if (!conn) {
    res.status(404).json({ error: 'connection not found' });
    return null;
  }
  return conn;
}

// ── Push / Pull / Synthesize (SSE) ───────────────────────────────────────

// v3.0.2: the push/pull/synthesize/revoke operations now participate
// in the write-registry (and, for pull, the per-domain file lock) exactly
// like ingest/compile do. Before this, an app update or restart could kill
// the process mid-pull or mid-revoke, and Personal Sync could snapshot a
// half-pulled mirror — the same bug class v3.0.1-beta.8 fixed for ingest.

router.post('/:id/push', gate, async (req, res) => {
  const conn = loadConnectionOr404(req.params.id, res);
  if (!conn) return;

  // v3.0.4 (H10): read-only members (PAT without write access) can Pull
  // but never Push — refuse before any work so the error is crisp instead
  // of a confusing GitHub 403 mid-stream.
  if (conn.read_only === true) {
    return res.status(400).json({
      error: 'This connection is read-only — your access token can read the shared repo but not write to it. ' +
             'You can Pull updates, but not push contributions. To contribute, create a token with ' +
             'Contents: Read and write, then re-run the Join wizard.',
    });
  }

  // Explicit local_domain → push just that one. Otherwise push EVERY
  // opted-in domain (v3.0.2 — previously only local_domains[0]
  // was pushed and the other opted-in domains silently never contributed).
  const explicit = req.body && req.body.local_domain;
  let domainsToPush;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    if (!isSlug(explicit)) {
      return res.status(400).json({ error: 'local_domain must be a slug-shaped domain name' });
    }
    domainsToPush = [explicit];
  } else {
    domainsToPush = Array.isArray(conn.local_domains) ? conn.local_domains.filter(isSlug) : [];
  }
  if (domainsToPush.length === 0) {
    return res.status(400).json({ error: 'No contributing domains configured on this connection. Add at least one in the connection settings.' });
  }

  if (isUpdateInProgress()) {
    const { status, body } = conflictResponse('push Shared Brain contributions');
    return res.status(status).json(body);
  }

  const emit = openSseStream(res);
  const releases = domainsToPush.map(d => registerWrite(d, 'sharedbrain-push'));
  try {
    const results = [];
    for (const d of domainsToPush) {
      if (domainsToPush.length > 1) emit({ type: 'info', message: `— Domain "${d}" —` });
      const result = await pushDomain(conn, d, {
        onProgress: (stage, message, meta) => emit({ type: stage, message, ...meta }),
      });
      results.push(result);
      if (result && result.ok === false) {
        emit({ type: 'error', message: `${d}: ${result.error || 'push failed'}` });
      }
    }

    const okResults = results.filter(r => r && r.ok);
    const failedCount = results.length - okResults.length;
    if (okResults.length > 0) {
      const totPushed  = okResults.reduce((n, r) => n + (r.pushed  || 0), 0);
      const totSkipped = okResults.reduce((n, r) => n + (r.skipped || 0), 0);
      const message =
        `Push complete: ${totPushed} page${totPushed !== 1 ? 's' : ''} pushed` +
        (domainsToPush.length > 1 ? ` across ${okResults.length} domain${okResults.length !== 1 ? 's' : ''}` : '') +
        (totSkipped > 0 ? `, ${totSkipped} will retry next time` : '') +
        (failedCount > 0 ? `, ${failedCount} domain${failedCount !== 1 ? 's' : ''} failed` : '') + '.';
      emit({ type: 'done', message, results });
    }
    // If every domain failed, the error events above are the outcome —
    // no 'done' is emitted, so the UI keeps the error styling.
  } catch (err) {
    console.error('[sharedbrain push]', err.message);
    emit({ type: 'error', message: err.message });
  } finally {
    releases.forEach(r => r());
    res.end();
  }
});

router.post('/:id/pull', gate, async (req, res) => {
  const conn = loadConnectionOr404(req.params.id, res);
  if (!conn) return;

  if (isUpdateInProgress()) {
    const { status, body } = conflictResponse('pull Shared Brain updates');
    return res.status(status).json(body);
  }

  // Guard before any mkdir/lock — a malformed connection must not create a
  // ghost "shared-undefined" domain directory.
  if (!isSlug(conn.shared_brain_slug)) {
    return res.status(400).json({ error: 'Connection has an invalid shared_brain_slug — re-save the connection.' });
  }
  const localDomain = `shared-${conn.shared_brain_slug}`;
  const emit = openSseStream(res);

  // Pull writes wiki pages into the local mirror domain via writePage —
  // register + file-lock it so update/restart/sync/ingest 409 instead of
  // racing the writes (and the MCP child process sees the in-flight state).
  const releaseRegistry = registerWrite(localDomain, 'sharedbrain-pull');
  const releaseFileLock = await acquireFileLock(domainPath(localDomain), { op: 'sharedbrain-pull' });
  if (!releaseFileLock) {
    releaseRegistry();
    emit({
      type: 'error',
      message: `Another process is already writing to "${localDomain}" (file lock held). ` +
               `If this seems stuck, manually delete <domains>/${localDomain}/.write-lock and retry.`,
    });
    return res.end();
  }

  try {
    const result = await pullCollective(conn, {
      onProgress: (stage, message, meta) => emit({ type: stage, message, ...meta }),
    });
    if (result && result.ok === false) {
      emit({ type: 'error', message: result.error || 'Pull failed' });
    } else {
      emit({ type: 'done', result });
    }
  } catch (err) {
    console.error('[sharedbrain pull]', err.message);
    emit({ type: 'error', message: err.message });
  } finally {
    try { await releaseFileLock(); } catch { /* best-effort */ }
    releaseRegistry();
    res.end();
  }
});

router.post('/:id/synthesize', gate, async (req, res) => {
  const conn = loadConnectionOr404(req.params.id, res);
  if (!conn) return;

  // v3.0.4 (H10): synthesis writes pages + state to the shared repo — a
  // read-only token cannot do that.
  if (conn.read_only === true) {
    return res.status(400).json({
      error: 'This connection is read-only — synthesis writes to the shared repo and needs a token with ' +
             'Contents: Read and write.',
    });
  }

  if (isUpdateInProgress()) {
    const { status, body } = conflictResponse('run Shared Brain synthesis');
    return res.status(status).json(body);
  }

  const emit = openSseStream(res);
  // Synthesis writes only to REMOTE collective storage (+ a config patch),
  // but a restart/update mid-run would leave the collective half-written
  // with contributions consumed — register so those endpoints 409.
  const releaseRegistry = registerWrite(`shared-${conn.shared_brain_slug}`, 'sharedbrain-synthesize');
  try {
    const result = await runLocalSynthesis(conn, {
      onProgress: (stage, message, meta) => emit({ type: stage, message, ...meta }),
    });
    if (result && result.ok === false) {
      emit({ type: 'error', message: result.error || 'Synthesis failed' });
    } else {
      emit({ type: 'done', result });
    }
  } catch (err) {
    console.error('[sharedbrain synthesize]', err.message);
    emit({ type: 'error', message: err.message });
  } finally {
    releaseRegistry();
    res.end();
  }
});

// ── Un-skip (v3.0.4, M15) ────────────────────────────────────────────────
//
// permanent_skip previously had NO user-facing recovery besides editing the
// page (the mtime-based un-skip from v3.0.2). This endpoint lets the UI's
// "Retry these pages" action clear skip entries directly: the pages get a
// fresh strike counter and are re-attempted on the next push. Local config
// change only — no network, no LLM.

/**
 * Pure core of the unskip operation (exported via __testing).
 * Returns null when `requested` is malformed; otherwise
 * { unskipped, patch: { permanent_skip, pending_retry } }.
 * Requested paths not actually in permanent_skip are ignored.
 */
export function computeUnskipPatch(conn, requested) {
  const currentSkip = Array.isArray(conn.permanent_skip) ? conn.permanent_skip : [];
  let toClear;
  if (requested === undefined || requested === null) {
    toClear = currentSkip; // no body → clear everything
  } else {
    if (!Array.isArray(requested) || !requested.every(p => typeof p === 'string')) {
      return null;
    }
    const skipSet = new Set(currentSkip);
    toClear = requested.filter(p => skipSet.has(p)); // only paths actually skipped
  }
  const clearSet = new Set(toClear);
  const newRetry = { ...(conn.pending_retry || {}) };
  for (const p of toClear) delete newRetry[p]; // fresh strike counter
  return {
    unskipped: toClear.length,
    patch: {
      permanent_skip: currentSkip.filter(p => !clearSet.has(p)),
      pending_retry: newRetry,
    },
  };
}

router.post('/:id/unskip', gate, (req, res) => {
  const conn = loadConnectionOr404(req.params.id, res);
  if (!conn) return;

  const result = computeUnskipPatch(conn, req.body && req.body.pages);
  if (result === null) {
    return res.status(400).json({ error: 'pages must be an array of page-path strings (or omitted to retry all)' });
  }

  try {
    patchSharedBrain(conn.id, result.patch);
    res.json({ ok: true, unskipped: result.unskipped, permanent_skip: result.patch.permanent_skip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Revoke (admin-only, Decision 6b) ─────────────────────────────────────

router.post('/:id/revoke', gate, async (req, res) => {
  const conn = loadConnectionOr404(req.params.id, res);
  if (!conn) return;

  const { admin_token, fellow_id, confirmation } = req.body || {};

  // The admin_token in the body must match the one stored in the connection.
  // (Connections used by non-admin contributors won't have an admin_token at
  // all — only the connection cohort admin has stored theirs.) v3.0.3:
  // constant-time comparison over sha256 digests — a plain !== leaks match
  // length/position through timing. Low practical risk on loopback, but the
  // fix is one line.
  const tokensMatch = (a, b) =>
    typeof a === 'string' && typeof b === 'string' &&
    timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  if (!conn.admin_token || !tokensMatch(admin_token, conn.admin_token)) {
    return res.status(403).json({ error: 'admin_token is required and must match the connection' });
  }
  if (!isUuid(fellow_id)) {
    return res.status(400).json({ error: 'fellow_id must be a UUID' });
  }
  if (confirmation !== `REVOKE-${fellow_id}`) {
    return res.status(400).json({
      error: `confirmation must be the literal string "REVOKE-${fellow_id}"`,
    });
  }

  // v3.0.2: a revoke interrupted by update/restart is the worst
  // possible state — remote contributions and pages already deleted but the
  // rebuild synthesis never ran. Refuse to start during an update, and
  // register so update/restart 409 for the duration.
  if (isUpdateInProgress()) {
    const { status, body } = conflictResponse('revoke a Shared Brain contributor');
    return res.status(status).json(body);
  }

  // Phase 4F (v3.0.0-beta+) — full Article 17 revocation orchestration.
  // SSE-streamed because pages-rebuild on a moderate brain can take 30s+.
  const emit = openSseStream(res);
  const releaseRegistry = registerWrite(`shared-${conn.shared_brain_slug}`, 'sharedbrain-revoke');
  try {
    const result = await revokeContributor(conn, {
      fellowId: fellow_id,
      adminTokenHash: hashAdminToken(admin_token),
      onProgress: (stage, message, meta) => emit({ type: stage, message, ...meta }),
    });
    if (!result.ok) {
      emit({ type: 'error', message: result.error || 'Revoke failed' });
    } else {
      emit({ type: 'done', result });
    }
  } catch (err) {
    console.error('[sharedbrain revoke]', err.message);
    emit({ type: 'error', message: err.message });
  } finally {
    releaseRegistry();
    res.end();
  }
});

// ── Invite-token utilities (no credentials touched) ──────────────────────

router.post('/parse-invite', gate, (req, res) => {
  try {
    const { token } = req.body || {};
    if (typeof token !== 'string') {
      return res.status(400).json({ error: 'token (string) is required' });
    }
    const metadata = decodeInviteToken(token);
    res.json({ valid: true, metadata });
  } catch (err) {
    res.status(400).json({ valid: false, error: err.message });
  }
});

// v3.0.5 (Phase 4.1): the admin token that gates contributor revocation.
// Generated at brain setup, shown ONCE (like the invite token), stored on
// the admin's connection at save. Prefix makes it recognisable in a
// password manager; 20 random bytes ≈ 160 bits of entropy.
export function generateAdminToken() {
  return 'sbat_' + randomBytes(20).toString('hex');
}

router.post('/generate-invite', gate, (req, res) => {
  try {
    const { repo, name, shared_domain, branch, storage_type, data_handling_terms } = req.body || {};
    const token = encodeInviteToken({ repo, name, shared_domain, branch, storage_type, data_handling_terms });
    // v3.0.5: a fresh admin token rides along for the admin wizard. The
    // invite token is DETERMINISTIC (same metadata → same token, safe to
    // re-display later); the admin token is random and independent — it is
    // NOT embedded in the invite token and never reaches contributors.
    res.json({ token, admin_token: generateAdminToken() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Member directory (v3.0.5, Phase 4.3) ─────────────────────────────────
//
// Everyone who has ever contributed to this brain — the admin needs a
// fellow_id to revoke, and it was previously undiscoverable from the UI.
// Read-only. Identity is storage-path-derived (same trust rule as
// synthesis); display names are informational.

router.get('/:id/members', gate, async (req, res) => {
  const conn = loadConnectionOr404(req.params.id, res);
  if (!conn) return;
  try {
    const result = await listMembers(conn);
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json({ members: result.members, self_fellow_id: conn.fellow_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin-token provision / rotation (v3.0.5, Phase 4.1) ─────────────────
//
// Generates a new admin token for this connection and returns it ONCE.
// Used by: (a) pre-v3.0.5 admin connections that have no admin_token yet
// (revoke was impossible without hand-editing config), (b) rotation after
// a suspected leak. Rotating invalidates the previous token immediately.

router.post('/:id/admin-token/rotate', gate, (req, res) => {
  const conn = loadConnectionOr404(req.params.id, res);
  if (!conn) return;
  try {
    const token = generateAdminToken();
    // saveSharedBrain (not patch) — credential fields have a single audited
    // write path with full validation. `conn` is the FULL record here.
    saveSharedBrain({ ...conn, admin_token: token });
    res.json({ ok: true, admin_token: token, rotated: !!conn.admin_token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Live PAT validation (server-proxy, Decision Q2) ──────────────────────
//
// Called by the wizard the moment the user pastes their PAT. The PAT
// travels from the browser to localhost:3333 only — never out to the
// network from the browser. The Curator server makes the one GitHub
// call needed to verify the PAT works on the specified repo with write
// access, returns a clean verdict, and forgets the PAT (we never persist
// here — persistence happens on /save after the user finishes the wizard).

router.post('/validate-pat', gate, async (req, res) => {
  try {
    const { repo, pat } = req.body || {};

    if (typeof repo !== 'string' || !isValidRepo(repo)) {
      return res.status(400).json({ error: 'repo must be "owner/name"' });
    }
    if (typeof pat !== 'string' || pat.length < 20 || pat.length > 400) {
      return res.status(400).json({ error: 'pat is required (fine-grained PAT, 20-400 chars)' });
    }

    // Step 1: Authenticate via GET /repos/:owner/:repo
    const [owner, name] = repo.split('/');
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${pat}`,
      'User-Agent': 'the-curator-sharedbrain-validator',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const r = await fetch(url, { method: 'GET', headers });

    if (r.status === 401 || r.status === 403) {
      return res.json({
        valid: false,
        hasWriteAccess: false,
        error: 'GitHub rejected the token (401/403). Check that the token is pasted correctly, and that you have ' +
               'ACCEPTED the collaborator invitation — GitHub emails it when the admin adds you, and the token is ' +
               'rejected until you click Accept. Then re-paste the token here.',
      });
    }
    if (r.status === 404) {
      return res.json({
        valid: false,
        hasWriteAccess: false,
        error: 'Repository not found, or your token does not have access. The most common cause: the collaborator ' +
               'invitation email was never accepted (check your inbox/spam for "[GitHub]"). Otherwise ask the admin ' +
               'to confirm the repo name and re-send the invitation.',
      });
    }
    if (!r.ok) {
      return res.json({
        valid: false,
        hasWriteAccess: false,
        error: `GitHub returned ${r.status} — try again in a moment.`,
      });
    }

    // Step 2: Determine write access. GitHub returns `permissions.push` on
    // authenticated repo lookups; true means the token has write access.
    let body;
    try { body = await r.json(); } catch { body = {}; }
    const hasWriteAccess = !!(body && body.permissions && body.permissions.push);

    res.json({
      valid: true,
      hasWriteAccess,
      repoFullName: body.full_name || repo,
      isPrivate: !!body.private,
      defaultBranch: body.default_branch || 'main',
      // Helpful diagnostic that does NOT leak the token: tells the user
      // what their token currently sees on the repo. A non-write token
      // returns valid:true + hasWriteAccess:false so the wizard can
      // show the "go fix your token scopes" hint.
      message: hasWriteAccess
        ? 'Token is valid and has write access.'
        : 'Token works but is read-only. You can connect as a read-only member (Pull only) — ' +
          'to contribute, re-create the token with Contents: Read and write.',
    });
  } catch (err) {
    // Network errors etc. Never include the PAT in the response.
    console.error('[sharedbrain validate-pat]', err.message);
    res.status(500).json({
      valid: false,
      error: `Could not reach GitHub: ${err.message}`,
    });
  }
});

export default router;

// Exposed for the battle test only.
export const __testing = {
  encodeInviteToken,
  decodeInviteToken,
  INVITE_VERSION,
  INVITE_PREFIX,
  computeUnskipPatch,
  generateAdminToken,
};
