// src/public/next/shared/user-errors.js — the plain-language error catalogue.
//
// PURE: no DOM, no Node, no imports. The browser imports it directly and the
// server imports it through src/brain/user-errors.js, so there is ONE table of
// signatures and ONE set of sentences (the same shape as shared/ai-jobs.js).
//
// ── WHAT IT DOES ──────────────────────────────────────────────────────────────
// `classifyErrorText(text)` recognises RAW MACHINE TEXT — a Node fs errno, an
// AI provider SDK's message, git's `Command failed:`, a V8 TypeError — and
// returns which class it is. Everything else returns null, and null means
// "leave the message exactly as it is". Deliberate prose written by The
// Curator never matches, and scripts/test-user-errors.js proves that against
// every message literal in src/routes and src/brain (the census).
//
// ── WHY EVERY SIGNATURE IS ANCHORED (the v3.0.16 lesson) ─────────────────────
// sync.js once tested a whole git message for a bare `401`/`403` and fired at
// random on abbreviated commit SHAs inside merge-conflict text, telling a user
// with a real content conflict to regenerate their token. So:
//   - a provider or git signature must start at the beginning of the text, or
//     right after a `: ` / `. ` / newline (a caller's own prefix such as
//     "Ingest failed: " or a sentence of prose before the raw tail);
//   - an fs signature must be Node's exact `CODE: description, syscall` shape;
//   - a status number is only ever read from INSIDE an already-recognised
//     provider shape, never searched for in free text.
// Prose before a raw tail that ends in a full stop is kept (`lead`), because
// it is The Curator's own sentence (health-undo's "…so nothing was changed.").
// A prefix that ends in a colon is a programmer's label and is dropped.
//
// ── PART 2 OF THE WORDING RULE: lost or charged ──────────────────────────────
// A sentence below claims "not charged" only where the error class itself
// proves it (a key, credit or length refusal is refused before any work). A
// timeout says the provider MAY still bill. Nothing here ever says "nothing
// was changed": only the code that wrote can know that.

const B = String.raw`(?:^|[:.]\s+|\n)`; // start, or after a caller's prefix / sentence

// ── Provider names (the word Settings › Providers & keys uses) ──────────────
const ANTHROPIC = 'Anthropic';
const GEMINI = 'Gemini';
const OPENROUTER = 'OpenRouter';

/** The client-side classes: a server never produces these. */
export const CLIENT_KLASSES = Object.freeze(['server-unreachable', 'server-outdated', 'request-failed']);
export function isClientKlass(klass) { return CLIENT_KLASSES.includes(klass); }

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function providerOf(ctx) { return (ctx && ctx.provider) || 'your AI provider'; }
function named(ctx) { return ctx && ctx.name ? ` (${ctx.name})` : ''; }

const SETTINGS_KEYS = 'Settings › Providers & keys';

/**
 * klass → (ctx?) → sentence. ctx: { provider?, service?, name?, area? }.
 * Every control named here exists in src/public/next (checked by the suite).
 */
export const USER_MESSAGES = Object.freeze({
  // ── AI provider ──
  'ai-key-rejected': (c) =>
    `${cap(providerOf(c))} didn't accept the API key saved in The Curator, so the request was refused and not charged. ` +
    `Open ${SETTINGS_KEYS} and use Replace key to paste a working key.`,
  'ai-no-credit': (c) =>
    `Your ${c && c.provider ? c.provider : 'AI provider'} account has run out of credit, so the request was refused and not charged. ` +
    `Add credit on ${c && c.provider ? `${c.provider}'s` : "your provider's"} website, or switch to another provider in ${SETTINGS_KEYS}.`,
  'ai-rate-limited': (c) =>
    `${cap(providerOf(c))} is limiting how many requests your account can make right now. Wait a minute, then try again. ` +
    `If it keeps happening, switch to another provider in ${SETTINGS_KEYS}.`,
  'ai-overloaded': (c) =>
    `${cap(providerOf(c))} is having problems on its side right now. Wait a few minutes, then try again.`,
  'ai-unreachable': (c) =>
    `The Curator couldn't reach ${providerOf(c)}. Check this computer's internet connection, then try again.`,
  'ai-timeout': (c) =>
    `${cap(providerOf(c))} took too long to answer, so The Curator stopped waiting. Your provider may still bill the request. ` +
    `Try again in a few minutes.`,
  'ai-model-unavailable': (c) =>
    `${cap(providerOf(c))} says the chosen model isn't available. Pick another model in ${SETTINGS_KEYS}.`,
  'ai-too-long': () =>
    `This was more text than the chosen AI model can read at once, so the request was refused and not charged. ` +
    `Pick a model that can read more in ${SETTINGS_KEYS}, or split the source into smaller files.`,
  'ai-bad-answer': () =>
    `The AI's answer came back in a form The Curator couldn't read. Your AI provider charges for answers like this one. ` +
    `Try again; if it keeps happening, pick a different model in ${SETTINGS_KEYS}.`,
  'ai-provider-error': (c) =>
    `${cap(providerOf(c))} couldn't complete this request. Try again in a few minutes. ` +
    `If it keeps failing, pick a different model or provider in ${SETTINGS_KEYS}.`,

  // ── Files ──
  'files-not-allowed': (c) =>
    `This computer didn't let The Curator use a file it needs${named(c)}. Check that the folder isn't read-only and, ` +
    `on a Mac, that The Curator is allowed to use it in System Settings › Privacy & Security › Files and Folders. Then try again.`,
  'files-disk-full': () =>
    `This computer's disk is full, so The Curator couldn't save. Free some space, then try again.`,
  'files-missing': (c) =>
    `The Curator couldn't find ${c && c.name ? c.name : 'a file it needs'}. It may have been moved, renamed or deleted outside ` +
    `The Curator, or not yet downloaded from iCloud or Dropbox. Check that it's still there, then try again. ` +
    `If you moved your knowledge folder, choose its new location in Settings › Knowledge base.`,
  'files-exists': (c) =>
    `Something called ${c && c.name ? c.name : 'that'} already exists there. Choose a different name, or move the existing one first.`,
  'files-busy': (c) =>
    `A file The Curator needs${named(c)} is busy or still downloading from cloud storage. Wait a moment, then try again.`,
  'files-name-too-long': () =>
    `A file name is too long for this computer. Use a shorter name, then try again.`,
  'files-read-only-disk': (c) =>
    `The disk holding ${c && c.name ? c.name : 'this file'} is read-only, so The Curator couldn't save to it. ` +
    `If your knowledge folder is on that disk, choose a folder on a writable disk in Settings › Knowledge base.`,
  'files-wrong-kind': (c) =>
    `The Curator expected a folder but found a file, or the other way round${named(c)}. Something may have been renamed ` +
    `outside The Curator. Check that name, then try again.`,

  // ── GitHub (Shared Brain's storage) ──
  'github-token-rejected': () =>
    `GitHub didn't accept the access token for this Shared Brain. Create a new token on GitHub, then use ` +
    `Leave this Shared Brain and re-join with your invite.`,
  'github-not-found': () =>
    `GitHub couldn't find this Shared Brain's repository, or the token can't see it. Ask the person who invited you ` +
    `to check that the repository still exists and that you still have access.`,
  'github-busy': () =>
    `GitHub is limiting requests from this token right now. Wait a few minutes, then try again.`,
  'github-unavailable': () =>
    `GitHub is having problems right now. Wait a few minutes, then try again.`,

  // ── Network outside an AI call ──
  'network-unreachable': (c) =>
    `The Curator couldn't reach ${(c && c.service) || 'the internet service it needed'}. ` +
    `Check this computer's internet connection, then try again.`,
  'network-certificate': (c) =>
    `The Curator couldn't check the security certificate of ${(c && c.service) || 'the service it needed'}. This is often ` +
    `caused by a company network, a VPN or security software. Try another network, then try again.`,

  // ── git (only when Sync's own translation did not recognise it) ──
  'git-other': (c) =>
    (c && c.area === 'sync'
      ? `Sync didn't finish, for a reason The Curator doesn't recognise. Try Sync now again. `
      : `A background step didn't finish, for a reason The Curator doesn't recognise. Try again. `) +
    `If it fails the same way, send the technical detail to support.`,

  // ── The server itself ──
  'internal-error': () =>
    `Something went wrong inside The Curator. Try again. If it keeps happening, send the technical detail to support.`,
  'request-too-large': () =>
    `That was too much to send in one go. Try a smaller selection.`,
  'request-malformed': () =>
    `The Curator received a request it couldn't read. Reload the page, then try again.`,
  'api-route-missing': () =>
    `This part of The Curator isn't available in the version that's running. Quit The Curator and open it again, ` +
    `so the version you installed is the one running.`,

  // ── Client-side (the browser makes these itself) ──
  'server-unreachable': () =>
    `The Curator isn't responding. It may be restarting, or it may have been closed. Wait a few seconds, then try again. ` +
    `If it doesn't come back, quit The Curator and open it again.`,
  'server-outdated': () =>
    `The Curator was updated, but the previous version is still running. Quit The Curator and open it again.`,
  'request-failed': () =>
    `The Curator couldn't finish that. Try again. If it keeps failing, use Run system check in Settings › General.`,
});

/** klass → the stable `code` a body carries. Today every code IS its klass. */
export const KLASS_CODES = Object.freeze(Object.fromEntries(Object.keys(USER_MESSAGES).map((k) => [k, k])));

// ── Per-surface wording (wave 3) ─────────────────────────────────────────────
// The same failure can need a different next step on a different screen (the
// Sync amendment: "a step must exist on THAT screen"). An override is looked
// up by ctx.area, then ctx.surface, then klass; with no override the global
// sentence above is used. The code never changes: only the words do.
//   toUserError(err, { area: 'sharedbrain', surface: 'admin' })
export const SURFACE_MESSAGES = Object.freeze({
  sharedbrain: Object.freeze({
    // An admin's action (revoke): "Leave and re-join with your invite" is a
    // member's step. The admin's token is replaced the way every admin's is
    // provisioned: by running the setup wizard again for the same repository
    // and shared domain (docs/shared-brain-admin.md; shared.js says the same
    // for a missing admin token). "+ Set up another" is on the Shared Brain
    // page whenever a connection exists, which an admin's always does.
    admin: Object.freeze({
      'github-token-rejected': () =>
        `GitHub didn't accept the access token this computer uses for this Shared Brain, so this didn't finish. ` +
        `Create a new token on GitHub, then use + Set up another and run the setup again for the same repository ` +
        `and shared domain: the setup wizard is the only place that accepts a new token.`,
      'github-not-found': () =>
        `GitHub couldn't find this Shared Brain's repository, or the access token can't see it. Check on GitHub ` +
        `that the repository still exists and that your token has access to it, then try again.`,
    }),
  }),
});

/** The override for (area, surface, klass), or null. */
export function surfaceMessage(klass, ctx) {
  const area = ctx && ctx.area;
  const surface = ctx && ctx.surface;
  if (!area || !surface) return null;
  const byArea = Object.prototype.hasOwnProperty.call(SURFACE_MESSAGES, area) ? SURFACE_MESSAGES[area] : null;
  const bySurface = byArea && Object.prototype.hasOwnProperty.call(byArea, surface) ? byArea[surface] : null;
  const fn = bySurface && Object.prototype.hasOwnProperty.call(bySurface, klass) ? bySurface[klass] : null;
  return typeof fn === 'function' ? fn : null;
}

// ── The published catalogue's codes ──────────────────────────────────────────
// Every code a person may see under an error, as "code: …" in the support line
// (shared/net.js). This list is what a published error catalogue documents, so
// a code outside it is NEVER shown as if it were one: an fs errno a route
// passes through as `code` ('EACCES'), an adapter's internal code
// ('SHARED_BRAIN_AUTH'), a view-branching code ('manifest-newer', 'shape').
// The sync codes are sync.js's (error-contract.md, the Sync amendment).
export const SYNC_CODES = Object.freeze([
  'sync-token-rejected', 'sync-token-no-access', 'sync-repo-not-found', 'sync-offline', 'sync-remote-ahead',
  'sync-merge-conflict', 'sync-busy-retry', 'sync-held-back-collision', 'sync-nested-repo', 'sync-git-missing',
  'sync-failed', 'sync-token-missing', 'sync-token-invalid', 'sync-new-token-rejected', 'sync-new-token-no-access',
  'sync-token-check-offline', 'sync-token-check-failed', 'sync-token-save-failed', 'sync-config-unreadable',
  'sync-not-configured',
]);
export const CATALOGUE_CODES = Object.freeze([...new Set([...Object.values(KLASS_CODES), ...SYNC_CODES])]);
const CATALOGUE_SET = new Set(CATALOGUE_CODES);
/** True only for a code in the published catalogue. */
export function isCatalogueCode(code) { return typeof code === 'string' && CATALOGUE_SET.has(code); }

// ── Sub-classifiers: run only INSIDE a recognised provider shape ────────────
const TOO_LONG_RE = /prompt is too long|too many tokens|request_too_large|exceeds the maximum number of tokens|input token count|maximum context length|context_length_exceeded|context window/i;
const NO_CREDIT_RE = /credit balance is too low|insufficient credits|insufficient_quota|billing_error/i;

function byStatus(status, inner, provider) {
  const text = inner || '';
  if (TOO_LONG_RE.test(text)) return 'ai-too-long';
  if (NO_CREDIT_RE.test(text) || status === 402) return 'ai-no-credit';
  if (status === 401) return 'ai-key-rejected';
  if (status === 403) return /api key|api_key|permission/i.test(text) || provider === ANTHROPIC ? 'ai-key-rejected' : 'ai-provider-error';
  if (status === 404) return 'ai-model-unavailable';
  if (status === 408) return 'ai-timeout';
  if (status === 429) return 'ai-rate-limited';
  if (status >= 500) return 'ai-overloaded';
  return 'ai-provider-error';
}

/** Anthropic body type → klass (body: {"type":"error","error":{"type":X,...}}). */
export function anthropicKlass(status, type, message) {
  const text = String(message || '');
  if (TOO_LONG_RE.test(text) || type === 'request_too_large') return 'ai-too-long';
  if (NO_CREDIT_RE.test(text) || type === 'billing_error') return 'ai-no-credit';
  switch (type) {
    case 'authentication_error':
    case 'permission_error': return 'ai-key-rejected';
    case 'not_found_error': return 'ai-model-unavailable';
    case 'rate_limit_error': return 'ai-rate-limited';
    case 'overloaded_error':
    case 'api_error': return 'ai-overloaded';
    case 'timeout_error': return 'ai-timeout';
    default: return byStatus(status, text, ANTHROPIC);
  }
}

// ── Signatures, in matching order ───────────────────────────────────────────
// Each entry: [regex, (match) => hit | null]. The first that returns a hit
// wins. `lead` is computed from match.index by the caller.

const FS_KLASS = Object.freeze({
  EACCES: 'files-not-allowed', EPERM: 'files-not-allowed',
  ENOSPC: 'files-disk-full', EDQUOT: 'files-disk-full',
  ENOENT: 'files-missing',
  EEXIST: 'files-exists',
  EBUSY: 'files-busy', EDEADLK: 'files-busy', EMFILE: 'files-busy', ENFILE: 'files-busy', EAGAIN: 'files-busy', ETIMEDOUT: 'files-busy',
  ENAMETOOLONG: 'files-name-too-long',
  EROFS: 'files-read-only-disk',
  ENOTDIR: 'files-wrong-kind', EISDIR: 'files-wrong-kind',
});
export const FS_ERRNO_KLASS = FS_KLASS;

const NET_CODES = 'ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENETDOWN';
const CERT_RE = /\b(?:UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID)\b|unable to verify the first certificate|self[- ]signed certificate in certificate chain/;

export function basenameOf(p) {
  const parts = String(p || '').split(/[\\/]/).filter((s) => s && s !== '...');
  return parts.length ? parts[parts.length - 1] : '';
}

const SIGNATURES = [
  // git: never diagnosed here — friendlyError in sync.js does that first.
  [new RegExp(B + 'Command failed: git\\b'), () => ({ klass: 'git-other' })],

  // Anthropic SDK: `${status} ${JSON body}` (sdk/error.js makeMessage).
  [new RegExp(B + '(\\d{3}) (\\{"type":"error",[\\s\\S]*)$'), (m) => {
    const status = Number(m[1]);
    const type = (/"error":\s*\{\s*"type":\s*"([a-z_]+)"/.exec(m[2]) || [])[1];
    const msg = (/"message":\s*"((?:[^"\\]|\\.)*)"/.exec(m[2]) || [])[1];
    return { klass: anthropicKlass(status, type, msg), provider: ANTHROPIC };
  }],
  [new RegExp(B + '(\\d{3}) status code \\(no body\\)$'), (m) => ({ klass: byStatus(Number(m[1]), '', ANTHROPIC), provider: ANTHROPIC })],
  [new RegExp(B + 'Connection error\\.$'), () => ({ klass: 'ai-unreachable' })],
  [new RegExp(B + 'Request timed out\\.$'), () => ({ klass: 'ai-timeout' })],

  // Gemini SDK: `[GoogleGenerativeAI Error]: Error fetching from <url>: [400 Bad Request] …`
  [new RegExp(B + '\\[GoogleGenerativeAI Error\\]: ([\\s\\S]*)$'), (m) => {
    const rest = m[1];
    const http = /^Error fetching from \S+: \[(\d{3})[^\]]*\]\s*([\s\S]*)$/.exec(rest);
    if (http) {
      const status = Number(http[1]);
      const inner = http[2];
      if (/API_KEY_INVALID|API key not valid|API key expired|API_KEY_EXPIRED/.test(inner)) return { klass: 'ai-key-rejected', provider: GEMINI };
      return { klass: byStatus(status, inner, GEMINI), provider: GEMINI };
    }
    if (/^Error fetching from \S+: fetch failed/.test(rest)) return { klass: 'ai-unreachable', provider: GEMINI };
    if (/^Request aborted/.test(rest)) return null;
    return { klass: 'ai-provider-error', provider: GEMINI };
  }],

  // OpenRouter adapter: only its RAW shapes. Its ⚠ sentences are deliberate.
  [new RegExp(B + 'OpenRouter \\S+ → HTTP (\\d{3})(?:: ([\\s\\S]*))?$'), (m) => ({ klass: byStatus(Number(m[1]), m[2], OPENROUTER), provider: OPENROUTER })],
  [new RegExp(B + 'OpenRouter request failed before a response arrived: '), () => ({ klass: 'ai-unreachable', provider: OPENROUTER })],
  [new RegExp(B + 'OpenRouter (?:did not respond|sent response headers but did not finish the body) within \\d+ ms\\.$'), () => ({ klass: 'ai-timeout', provider: OPENROUTER })],

  // GitHub storage adapter: `GitHub ${op} ${repoPath} → ${status}[: detail]`.
  [new RegExp(B + 'GitHub (?:GET|PUT|POST|DELETE|PATCH) \\S+ → (\\d{3})\\b(?:: ([\\s\\S]*))?$'), (m) => {
    const status = Number(m[1]);
    const inner = m[2] || '';
    if (/rate limit/i.test(inner) || status === 429) return { klass: 'github-busy' };
    if (status === 401 || status === 403) return { klass: 'github-token-rejected' };
    if (status === 404) return { klass: 'github-not-found' };
    if (status >= 500) return { klass: 'github-unavailable' };
    return null;
  }],

  // The model's answer could not be parsed (health-ai.js and the same shape elsewhere).
  [new RegExp(B + 'AI response was not valid JSON\\b'), () => ({ klass: 'ai-bad-answer' })],

  // Node fs errno, Node's exact shape: `CODE: description, syscall 'path'`.
  [/(?:^|[^A-Za-z0-9_])(E[A-Z]{2,}): ([a-z][a-z ,]*?), ([a-z_]+)(?: '([^'\n]*)')?/, (m) => {
    const klass = FS_KLASS[m[1]];
    return klass ? { klass, name: basenameOf(m[4]) || undefined } : null;
  }],

  // Network, outside an AI SDK's own shape.
  [new RegExp(B + 'fetch failed$'), () => ({ klass: 'network-unreachable' })],
  [new RegExp(B + '(?:request to \\S+ failed, reason: )?(?:connect|getaddrinfo|read|write|querySrv) (?:' + NET_CODES + ')\\b'), () => ({ klass: 'network-unreachable' })],
  [new RegExp(B + '(?:request to \\S+ failed, reason: )?(?:' + CERT_RE.source + ')'), () => ({ klass: 'network-certificate' })],

  // A programming error (V8's own wording).
  [new RegExp(B + "(?:Cannot read properties of (?:undefined|null) \\(reading |Cannot set properties of (?:undefined|null) \\(setting |Cannot destructure property '|Maximum call stack size exceeded$|Assignment to constant variable\\.$)"), () => ({ klass: 'internal-error' })],
  [new RegExp(B + '[A-Za-z_$][\\w$.]*(?:\\(\\.\\.\\.\\))? is not (?:a function|defined|iterable|a constructor)$'), () => ({ klass: 'internal-error' })],

  // ── Client-side (the browser's own failures) ──
  [new RegExp(B + '(?:TypeError: )?(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\\.)$'), () => ({ klass: 'server-unreachable' })],
  [new RegExp(B + `(?:SyntaxError: )?(?:Unexpected token '<', "<!DOCTYPE|Unexpected token '<', "<html|Unexpected token < in JSON at position 0|JSON\\.parse: unexpected character at line 1 column 1)`), () => ({ klass: 'server-outdated' })],
  [new RegExp(B + '(?:Request failed \\(\\d{3}\\)|\\(?HTTP \\d{3}\\)?|Unexpected end of JSON input)$'), () => ({ klass: 'request-failed' })],
];

/** Exposed for the census suite's mutation proofs; not for callers. */
export const __SIGNATURES = SIGNATURES;

/**
 * @param {unknown} text
 * @returns {{klass:string, provider?:string, service?:string, name?:string, lead?:string} | null}
 *   null = not raw machine text: show the message unchanged.
 */
export function classifyErrorText(text) {
  if (typeof text !== 'string' || !text) return null;
  // The ⚠ messages (llm.js rate-limit/overload, OpenRouter's own sentences) are
  // deliberate and pinned; they pass through whole.
  if (text.trimStart().startsWith('⚠')) return null;
  for (const [re, build] of SIGNATURES) {
    const m = re.exec(text);
    if (!m) continue;
    const hit = build(m);
    if (!hit) continue;
    const lead = leadBefore(text, m.index);
    if (lead) hit.lead = lead;
    return hit;
  }
  return null;
}

/** The Curator's own sentence(s) before a raw tail, when they end in a full stop. */
function leadBefore(text, index) {
  if (index <= 0) return '';
  const before = text.slice(0, index + 1).trimEnd();
  // `[:.]\s+` consumed the stop as part of the match; index points at it.
  if (!/\.$/.test(before)) return '';
  if (!/^[A-Z"'(]/.test(before)) return '';
  return before;
}

/** lead (if any) + the class's sentence. */
export function composeUserMessage(hit, ctx = {}) {
  if (!hit || !USER_MESSAGES[hit.klass]) return null;
  // What the text itself says (provider, file name) outranks the caller's guess.
  const c = { ...ctx, ...(hit.provider ? { provider: hit.provider } : {}), ...(hit.name ? { name: hit.name } : {}) };
  const sentence = (surfaceMessage(hit.klass, c) || USER_MESSAGES[hit.klass])(c);
  return hit.lead ? `${hit.lead} ${sentence}` : sentence;
}
