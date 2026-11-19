// This file is licensed under the Curator Enterprise License — NOT MIT.
// Free for personal, educational, evaluation, development and testing use,
// and for production use of the GitHub-backed Shared Brain (free forever).
// Other organizational production use will require a license key once keys
// exist — until then it is free too (grace clause). Each release's version of
// this file converts to MIT two years after that release was published.
// See LICENSES/LICENSE-ENTERPRISE.txt and LICENSES/ENTERPRISE-FILES.txt.
/**
 * Shared Brain — Replace token (v3.99.2)
 *
 * WHY. When GitHub rejects the token (personal access token) a Shared Brain
 * connection stores, there was no way to give it a new one: a member was told
 * to Leave and re-join, and an admin to run the setup again, which the app
 * REFUSES (connectionClash: one brain, one membership). This replaces the
 * token on the existing connection and changes nothing else — not its
 * identity, fellow_id, admin token (a different credential: the `sbat_…`
 * token that authorises revoking contributors) or read-only flag.
 *
 * THE NEW TOKEN IS CHECKED FIRST, against the connection's OWN repository,
 * with the same call the setup wizard's check makes (POST /validate-pat:
 * GET /repos/:owner/:repo, `permissions.push`). Only when GitHub accepts it,
 * and it can do what this connection does, is anything written:
 *   · a read-only member's connection (`read_only: true`) only Pulls, so a
 *     token that can READ the repository is enough (the wizard accepts a
 *     read-only token for exactly that membership);
 *   · every other connection — a contributor, and an admin, whose synthesis
 *     and revoke write to the repository — Pushes, so the token must be able
 *     to WRITE (`permissions.push`). A read-only token is refused rather than
 *     saved: saving it would turn every following Push into a GitHub 403.
 * Any refusal leaves `.sharedbrain-config.json` byte-identical.
 *
 * The token never leaves this module: not in a return value, not in an error,
 * not in a log. Every detail text is scrubbed of it.
 */

import { getSharedBrainWithToken, replaceSharedBrainPat, connectionIdentity } from './sharedbrain-config.js';
import { GITHUB_API, rateLimitReading, sanitizeDetail } from './github-read-client.js';
import { sharedBrainGithubFetch } from './sharedbrain-storage-factory.js';

// The same shape Sync's Replace token accepts (classic `ghp_…`, fine-grained
// `github_pat_…`, the old 40-hex form), with this store's own 400-char ceiling.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,400}$/;
const TOKEN_CHECK_TIMEOUT_MS = 30000;

// The Replace-token refusals' sentences, as DATA: the code below uses these
// exact strings, and scripts/build-error-catalogue.mjs reads them to write the
// published error catalogue, so the page cannot drift from what a person sees.
// `repo` is "owner/name". Every sentence says nothing was changed, because
// every one of them is returned before the write (save-failed: the write
// itself failed atomically, so the old file is still the file).
export const SHAREDBRAIN_TOKEN_MESSAGES = Object.freeze({
  'sharedbrain-token-missing': 'Paste the new token from GitHub first. Nothing was changed.',
  'sharedbrain-token-invalid':
    'That doesn’t look like a GitHub token. Copy the whole token from GitHub (it starts with ' +
    'ghp_ or github_pat_) and paste it again. Nothing was changed.',
  'sharedbrain-token-not-github':
    'This Shared Brain is kept in a folder, not on GitHub, so it has no GitHub token to replace. Nothing was changed.',
  'sharedbrain-new-token-rejected':
    'GitHub didn’t accept the new token. Check that you copied all of it and that it has not expired, ' +
    'then try again. Nothing was changed: this Shared Brain still has the token it had.',
  'sharedbrain-new-token-no-access': (repo) =>
    'GitHub accepted the token, but it cannot open this Shared Brain’s repository' +
    (repo ? ' (' + repo + ')' : '') + '. For a fine-grained token, give it that repository with ' +
    'Contents: Read and write; for a classic token, tick the repo scope. If you were invited, check that ' +
    'you accepted the invitation on GitHub. Nothing was changed.',
  'sharedbrain-new-token-read-only': (repo) =>
    'GitHub accepted the token, but it can only read this Shared Brain’s repository' +
    (repo ? ' (' + repo + ')' : '') + ', and this connection pushes contributions. Give the token ' +
    'Contents: Read and write on that repository, then try again. Nothing was changed.',
  'sharedbrain-token-check-rate-limited':
    'GitHub is limiting requests from this token right now, so the new token couldn’t be checked. ' +
    'Nothing was changed. Wait a few minutes, then try again.',
  'sharedbrain-token-check-offline':
    'The Curator couldn’t reach GitHub to check the new token, so nothing was changed. ' +
    'Check your internet connection and try again.',
  'sharedbrain-token-check-failed':
    'The new token couldn’t be checked, so nothing was changed. Try again in a minute; if it ' +
    'keeps happening, copy the technical detail below and send it to support.',
  'sharedbrain-token-save-failed':
    'The new token works, but The Curator couldn’t save it, so nothing was changed. ' +
    'Try again; if it keeps happening, copy the technical detail below and send it to support.',
});
const M = SHAREDBRAIN_TOKEN_MESSAGES;

// The HTTP status each refusal answers with. 400 for what the request itself
// got wrong or GitHub refused; 502/503 for a check that could not be made.
const STATUS = Object.freeze({
  'sharedbrain-token-missing': 400,
  'sharedbrain-token-invalid': 400,
  'sharedbrain-token-not-github': 409,
  'sharedbrain-new-token-rejected': 400,
  'sharedbrain-new-token-no-access': 400,
  'sharedbrain-new-token-read-only': 400,
  'sharedbrain-token-check-rate-limited': 503,
  'sharedbrain-token-check-offline': 502,
  'sharedbrain-token-check-failed': 502,
  'sharedbrain-token-save-failed': 500,
});

/** A refusal: {ok:false, status, body:{error, code, detail?}}. Never holds the token. */
function refusal(code, sentence, detail, token) {
  const body = { error: sentence, code };
  if (detail) {
    let d = sanitizeDetail(String(detail));
    if (token) d = d.split(token).join('***');
    body.detail = d.slice(0, 600);
  }
  return { ok: false, status: STATUS[code] || 400, body };
}

function errText(err) {
  if (!err) return '';
  const parts = [err.name && err.name !== 'Error' ? err.name : '', err.message || String(err)];
  const c = err.cause;
  if (c && (c.code || c.message)) parts.push('(' + [c.code, c.message].filter(Boolean).join(': ') + ')');
  return parts.filter(Boolean).join(': ');
}

/**
 * Check `newToken` against connection `id`'s repository and, only if it can do
 * what that connection does, save it. Never throws for an expected outcome.
 *
 * @returns {Promise<{ok:true, repo:string} | {ok:false, status:number, body:{error, code, detail?}}>}
 *          `null` when the connection does not exist (the route answers 404).
 */
export async function replaceSharedBrainToken(id, newToken, opts = {}) {
  const conn = getSharedBrainWithToken(id);
  if (!conn) return null;
  if (conn.storage_type !== 'github') {
    return refusal('sharedbrain-token-not-github', M['sharedbrain-token-not-github']);
  }
  const token = typeof newToken === 'string' ? newToken.trim() : '';
  if (!token) return refusal('sharedbrain-token-missing', M['sharedbrain-token-missing']);
  if (!TOKEN_SHAPE.test(token)) return refusal('sharedbrain-token-invalid', M['sharedbrain-token-invalid']);

  const owner = String(conn.github_repo_owner || '');
  const name = String(conn.github_repo_name || '');
  const repo = owner + '/' + name;
  const identity = connectionIdentity(conn);
  const needsWrite = conn.read_only !== true;

  // 1. Check, writing nothing. The only network call in this function.
  const doFetch = opts.fetchImpl || sharedBrainGithubFetch();
  let r;
  try {
    r = await doFetch(`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'the-curator-sharedbrain-validator',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(opts.timeoutMs || TOKEN_CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    return refusal('sharedbrain-token-check-offline', M['sharedbrain-token-check-offline'], errText(err), token);
  }

  let body = null;
  try { body = await r.json(); } catch { body = null; }
  const ghSaid = body && typeof body.message === 'string' ? body.message : '';
  const detail = `GitHub GET repos/${repo} → ${r.status}${ghSaid ? ': ' + ghSaid : ''}`;

  const limited = r.status === 429 || rateLimitReading(r).exhausted ||
    (r.status === 403 && /rate limit/i.test(ghSaid));
  if (limited) {
    return refusal('sharedbrain-token-check-rate-limited', M['sharedbrain-token-check-rate-limited'], detail, token);
  }
  if (r.status === 401) {
    return refusal('sharedbrain-new-token-rejected', M['sharedbrain-new-token-rejected'], detail, token);
  }
  if (r.status === 403 || r.status === 404) {
    return refusal('sharedbrain-new-token-no-access', M['sharedbrain-new-token-no-access'](repo), detail, token);
  }
  if (!r.ok) {
    return refusal('sharedbrain-token-check-failed', M['sharedbrain-token-check-failed'], detail, token);
  }
  if (needsWrite && !(body && body.permissions && body.permissions.push === true)) {
    return refusal('sharedbrain-new-token-read-only', M['sharedbrain-new-token-read-only'](repo),
      `GitHub GET repos/${repo} → ${r.status}: permissions.push is not true`, token);
  }

  // 2. Save: the token alone, re-read and re-checked at write time.
  try {
    replaceSharedBrainPat(id, token, identity);
  } catch (err) {
    return refusal('sharedbrain-token-save-failed', M['sharedbrain-token-save-failed'], errText(err), token);
  }
  return { ok: true, repo };
}

export const __testing = { TOKEN_SHAPE, STATUS };
