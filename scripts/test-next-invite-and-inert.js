/**
 * test-next-invite-and-inert.js — OFFLINE suite for two things that had to
 * land together before cutover:
 *
 *   (1) INVITE RE-DISPLAY on the Shared Brain connection card
 *       (src/public/next/views/shared.js). Before this, /next minted an
 *       invite token in exactly ONE place — the setup wizard's step 2. An
 *       admin who closed the wizard and later needed to onboard someone had
 *       no path back to it short of tearing the brain down and re-creating
 *       it. That is the defect v3.0.5 §4.4 shipped to fix in the shipping
 *       frontend, re-introduced by omission here.
 *
 *   (2) THE INERT-CONTROL CLASS — controls that exist but cannot do
 *       anything, and copy that leaks build vocabulary ("this shell",
 *       "this phase", "not wired") at users. Post-cutover this IS the
 *       product; a disabled paperclip and a drop zone that swallows a
 *       dragged PDF are the first things a user touches.
 *
 * No network, no API key, no server, no browser. The decision logic in
 * shared.js is written as pure functions with no DOM and no fetch precisely
 * so it can be driven here; they are extracted from the REAL source by
 * brace-matching and evaluated standalone with `new Function` — the
 * technique scripts/test-next-onboarding.js already uses.
 *
 * ── What this suite ACTUALLY covers ─────────────────────────────────────
 * COVERED, behaviourally (the real functions are executed, both directions):
 *   - inviteAffordance(): admin vs read-only member; admin WITHOUT a stored
 *     admin token; a token provisioned this mount; non-GitHub storage; and
 *     the cautionTerms flag with and without stored data_handling_terms
 *     (§2, §3).
 *   - inviteRequestBody(): the exact body sent to POST /generate-invite,
 *     including both route defaults it mirrors (§4).
 *   - THE DERIVATION (§5). The body-builder's output is fed to the REAL
 *     encodeInviteToken, extracted from src/routes/sharedbrain.js the same
 *     brace-matched way, and the resulting token is compared BYTE-FOR-BYTE
 *     against the token the setup wizard's own mint inputs produce for the
 *     same brain. This is the assertion the whole feature rests on: the
 *     token is deterministic and NOT stored verbatim, so a wrong field
 *     produces a well-formed token that simply nobody can redeem — a
 *     silent failure. The wizard's field mapping (meta.name → label,
 *     meta.repo → owner + '/' + name, …) is pinned as a source guard in
 *     §5 so this equivalence cannot rot if the wizard's save changes.
 *
 * COVERED, as source-level guards (stated as such, not as behaviour):
 *   - The invite block is reachable: renderAdmin calls renderInvite, the
 *     dispatch handles invite-show/-hide/-copy, and onShowInvite re-checks
 *     the affordance at the ACTION as well as in the render (§6).
 *   - onShowInvite ignores the admin_token the route mints alongside the
 *     invite token, and never puts it on screen (§6).
 *   - The five inert controls are gone or reworded, and their CSS went with
 *     them rather than being left orphaned (§7).
 *   - CLASS-LEVEL: no user-visible string in any owned file carries
 *     preview-era vocabulary, comment-stripped so prose in comments (which
 *     legitimately explains WHY a phrase was removed) does not false-fail
 *     (§8).
 *
 * NOT COVERED here (stated rather than implied):
 *   - Rendering, clicking, the clipboard, and the actual HTTP call. Those
 *     need a DOM and a server; they were verified in a real browser on an
 *     isolated instance instead and that is not reproducible from here.
 *   - Whether the server's generate-invite route is reachable / gated. That
 *     is the route's own suite.
 *   - That a re-displayed token actually redeems against a live GitHub
 *     brain. That needs a real cohort.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const P = {
  shared: path.join(ROOT, 'src/public/next/views/shared.js'),
  sync: path.join(ROOT, 'src/public/next/views/sync.js'),
  chat: path.join(ROOT, 'src/public/next/views/chat.js'),
  memory: path.join(ROOT, 'src/public/next/views/memory.js'),
  chatCss: path.join(ROOT, 'src/public/next/views/chat.css'),
  syncCss: path.join(ROOT, 'src/public/next/views/sync.css'),
  wizard: path.join(ROOT, 'src/public/next/views/shared-brain-wizard.js'),
  route: path.join(ROOT, 'src/routes/sharedbrain.js'),
};
const src = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, readFileSync(v, 'utf8')]));

// ── Comment stripping ───────────────────────────────────────────────────
// Every ABSENCE check below has to run against CODE. This file's subjects
// deliberately QUOTE the strings being asserted absent while explaining why
// they were removed ("its own tooltip said it was not wired up"). Run
// against raw text, those guards would be reading a comment — this repo's
// named failure shape, "a check that stopped reaching the thing it
// protects".
//
// Conservative on purpose: /* … */ blocks and whole-line // comments only.
// End-of-line comments need a real lexer to tell them from a // inside a
// string, and for an ABSENCE check the safe direction is to leave too much
// in (a false FAILURE somebody must look at), never too little.
//
// ORDER IS LOAD-BEARING and matches test-next-onboarding.js: line comments
// FIRST. These files' prose contains `/*`-shaped fragments inside //
// comments; strip blocks first and one of those opens a fake block comment
// that runs on until the next `*/`, swallowing real code. The tripwire
// below is exactly what catches that.
function stripComments(s) {
  return s
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}
function assertStrippedSane(stripped, label, mustContain) {
  for (const needle of mustContain) {
    if (!stripped.includes(needle)) {
      throw new Error(`stripComments over-reached on ${label}: "${needle}" is gone from the stripped code`);
    }
  }
  return stripped;
}

// Sanity anchors are STRUCTURAL and deliberately do NOT overlap anything an
// assertion below also checks — test-next-onboarding.js records the
// mutation-found reason: an anchor that an assertion also targets makes the
// tripwire throw before a single assertion runs, which is a red for the
// wrong reason and proves nothing.
const code = {
  shared: assertStrippedSane(stripComments(src.shared), 'shared.js', [
    'function inviteRequestBody(conn)',
    'function inviteAffordance(conn, card)',
    'function adminAffordances(conn, card)',
    'function renderInvite(conn, card, busy)',
  ]),
  sync: assertStrippedSane(stripComments(src.sync), 'sync.js', ['function renderSidebar(token)']),
  chat: assertStrippedSane(stripComments(src.chat), 'chat.js', ['function renderComposerHtml(active)']),
  memory: assertStrippedSane(stripComments(src.memory), 'memory.js', ['registerView(']),
  chatCss: stripComments(src.chatCss),
  syncCss: stripComments(src.syncCss),
  route: assertStrippedSane(stripComments(src.route), 'sharedbrain.js', ['export function encodeInviteToken(metadata)']),
  wizard: assertStrippedSane(stripComments(src.wizard), 'shared-brain-wizard.js', ['generate-invite']),
};

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Extract functions from the real source ──────────────────────────────
// Brace-matched, so nested braces in a body cannot truncate the extraction.
// A missing name THROWS rather than silently testing nothing, and a body
// whose braces never balance THROWS too (the desync tripwire) rather than
// returning a truncated fragment that would `new Function`-compile into
// something subtly different from the real thing.
function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(source);
  if (!m) throw new Error(`extractFunction: ${name} not found`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  const braceAt = source.indexOf('{', m.index + m[0].length - 1);
  if (braceAt === -1) throw new Error(`extractFunction: ${name} has no body brace`);
  let depth = 0;
  for (let i = braceAt; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      // The leading `export ` is stripped: these fragments are concatenated
      // into a `new Function` body, where an export declaration is a hard
      // SyntaxError. Nothing else about the declaration is touched.
      if (depth === 0) return source.slice(start, i + 1).replace(/^export\s+/, '');
    }
  }
  throw new Error(`extractFunction: braces never balanced for ${name} — the extractor desynced`);
}

// ── §1 sanity: the subjects exist and compile ───────────────────────────
section('§1  Extraction sanity');

const fnInviteBody = extractFunction(code.shared, 'inviteRequestBody');
const fnInviteAff = extractFunction(code.shared, 'inviteAffordance');
const fnAdminAff = extractFunction(code.shared, 'adminAffordances');

ok(/return\s*{/.test(fnInviteBody), 'inviteRequestBody extracted with a body that returns an object');
ok(fnInviteAff.includes('adminAffordances('), 'inviteAffordance extracted and delegates to adminAffordances (one gate, not two)');

const sharedApi = new Function(`
  ${fnAdminAff}
  ${fnInviteAff}
  ${fnInviteBody}
  return { adminAffordances, inviteAffordance, inviteRequestBody };
`)();
ok(typeof sharedApi.inviteAffordance === 'function', 'shared.js decision functions evaluate standalone');

// A representative saved connection, shaped exactly like the masked record
// GET /api/sharedbrain/list returns (metadata survives masking; only
// TOKEN_FIELDS are replaced with a prefix + ellipsis, so a stored admin
// token still reads as a non-empty string).
function conn(over = {}) {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    label: 'Cohort Brain',
    storage_type: 'github',
    github_repo_owner: 'talirezun',
    github_repo_name: 'cohort-brain',
    github_branch: 'main',
    shared_domain: 'work-ai',
    shared_brain_slug: 'cohort',
    data_handling_terms: 'contributor_retains',
    admin_token: 'sbat_abc…',
    read_only: false,
    ...over,
  };
}
const freshCard = (over = {}) => ({ adminTokenProvisioned: false, ...over });

// ── §2 who may see the invite affordance ────────────────────────────────
section('§2  inviteAffordance — admin vs read-only member');

{
  const a = sharedApi.inviteAffordance(conn(), freshCard());
  eq(a.show, true, 'admin with a stored admin token SEES the invite affordance');
}
{
  const a = sharedApi.inviteAffordance(conn({ read_only: true }), freshCard());
  eq(a.show, false, 'read-only member does NOT see it');
  eq(a.reason, 'not-admin', 'read-only member is refused as not-admin (same gate as the rest of the admin surface)');
}
{
  // A read-only connection can still carry an admin_token field in theory;
  // read_only must win, or the strictest gate in the file is bypassable by
  // a stray field.
  const a = sharedApi.inviteAffordance(conn({ read_only: true, admin_token: 'sbat_xyz…' }), freshCard());
  eq(a.show, false, 'read_only beats a present admin_token (read_only is checked first)');
}
{
  const a = sharedApi.inviteAffordance(conn({ admin_token: '' }), freshCard());
  eq(a.show, false, 'admin with NO admin token does not see it (generate one first)');
  eq(a.reason, 'not-admin', '…and the reason says why');
}
{
  const a = sharedApi.inviteAffordance(conn({ admin_token: undefined }), freshCard());
  eq(a.show, false, 'a missing admin_token field is treated as absent, not as present');
}
{
  // A token provisioned THIS mount must count — the shown-once rule forbids
  // a post-rotate list refresh, so conn.admin_token is still stale here.
  const a = sharedApi.inviteAffordance(conn({ admin_token: '' }), freshCard({ adminTokenProvisioned: true }));
  eq(a.show, true, 'a token provisioned this mount unlocks it without a list refresh (shown-once rule)');
}
{
  const a = sharedApi.inviteAffordance(conn({ storage_type: 'local' }), freshCard());
  eq(a.show, false, 'a local-folder brain does not see it (encodeInviteToken refuses non-github at mint time)');
  eq(a.reason, 'not-github', '…and the reason distinguishes it from the not-admin case');
}
{
  eq(sharedApi.inviteAffordance(null, freshCard()).show, false, 'a null connection is refused rather than throwing');
}

// ── §3 the pre-v3.0.5 caution ───────────────────────────────────────────
section('§3  cautionTerms — connections saved before data_handling_terms was persisted');

{
  const a = sharedApi.inviteAffordance(conn({ data_handling_terms: undefined }), freshCard());
  eq(a.show, true, 'a pre-v3.0.5 connection still gets the affordance…');
  eq(a.cautionTerms, true, '…and RAISES the caution (the re-derived token defaults to contributor_retains)');
}
{
  const a = sharedApi.inviteAffordance(conn({ data_handling_terms: 'contributor_retains' }), freshCard());
  eq(a.cautionTerms, false, 'a STORED contributor_retains is a real recorded choice — no caution');
}
{
  const a = sharedApi.inviteAffordance(conn({ data_handling_terms: 'organisational' }), freshCard());
  eq(a.cautionTerms, false, 'a stored organisational choice raises no caution');
}
{
  const a = sharedApi.inviteAffordance(conn({ data_handling_terms: '' }), freshCard());
  eq(a.cautionTerms, true, 'an empty-string terms value is treated as absent (it cannot be a valid enum member)');
}

// ── §4 the request body ─────────────────────────────────────────────────
section('§4  inviteRequestBody — the exact body POSTed to /generate-invite');

{
  const b = sharedApi.inviteRequestBody(conn());
  eq(b.repo, 'talirezun/cohort-brain', 'repo is owner + "/" + name (the route takes one "owner/name" string)');
  eq(b.name, 'Cohort Brain', 'name comes from conn.label');
  eq(b.shared_domain, 'work-ai', 'shared_domain is the REMOTE domain slug, not shared_brain_slug');
  ok(b.shared_domain !== 'cohort', 'shared_domain is NOT the local mirror slug (shared_brain_slug) — different fields');
  eq(b.branch, 'main', 'branch comes from github_branch');
  eq(b.storage_type, 'github', 'storage_type is pinned to github');
  eq(b.data_handling_terms, 'contributor_retains', 'data_handling_terms comes from the stored value');
}
{
  const b = sharedApi.inviteRequestBody(conn({ github_branch: 'cohort-2026' }));
  eq(b.branch, 'cohort-2026', 'a non-default branch is carried through, not flattened to main');
}
{
  const b = sharedApi.inviteRequestBody(conn({ github_branch: undefined }));
  eq(b.branch, 'main', 'an absent branch mirrors the route default (main)');
}
{
  const b = sharedApi.inviteRequestBody(conn({ data_handling_terms: undefined }));
  eq(b.data_handling_terms, 'contributor_retains', 'absent terms mirror the route default — this is what the caution warns about');
}
{
  const b = sharedApi.inviteRequestBody(conn({ data_handling_terms: 'organisational' }));
  eq(b.data_handling_terms, 'organisational', 'organisational terms are NOT silently downgraded to the default');
}
eq(sharedApi.inviteRequestBody(null), null, 'a null connection yields null rather than a body of "undefined/undefined"');

// ── §5 THE DERIVATION ───────────────────────────────────────────────────
// The assertion the whole feature rests on. The token is not stored: it is
// re-derived, so if the mapping from connection → request body is wrong the
// result is a WELL-FORMED token that nobody in the cohort can redeem. A
// round-trip decode alone would not catch that (it would happily round-trip
// the wrong values), so the real test is EQUIVALENCE with the wizard's own
// mint inputs, run through the REAL encoder.
section('§5  The derivation — re-derived token === the token the wizard minted');

const realEncode = new Function('Buffer', `
  ${extractFunction(code.route, 'base64UrlEncode')}
  ${extractFunction(code.route, 'base64UrlDecode')}
  ${extractFunction(code.route, 'isValidRepo')}
  ${extractFunction(code.route, 'isSlug')}
  const REPO_RE = ${/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.toString()};
  const SLUG_RE = ${/^[a-z0-9][a-z0-9_-]{0,127}$/i.toString()};
  const INVITE_VERSION = 1;
  const INVITE_PREFIX = 'sbi_';
  const INVITE_STORAGE_TYPE = 'github';
  const VALID_DATA_HANDLING_TERMS = ['contributor_retains', 'organisational'];
  ${extractFunction(code.route, 'encodeInviteToken')}
  return { encodeInviteToken, base64UrlDecode };
`)(Buffer);

ok(typeof realEncode.encodeInviteToken === 'function', 'the REAL encodeInviteToken was extracted and evaluates standalone');

// Control: the extracted encoder behaves like the real one — it must REFUSE
// what the route refuses, or "it produced a token" would prove nothing.
{
  let threw = false;
  try { realEncode.encodeInviteToken({ repo: 'a/b', name: 'x', shared_domain: 'd', storage_type: 'local' }); }
  catch { threw = true; }
  ok(threw, 'control: the extracted encoder still refuses a non-github storage_type (it is the real one)');
}

// The wizard's own mint inputs for this brain, verbatim from step 1's
// generate-invite call: { repo, name, shared_domain, branch,
// data_handling_terms, storage_type }.
const WIZARD_MINT = {
  repo: 'talirezun/cohort-brain',
  name: 'Cohort Brain',
  shared_domain: 'work-ai',
  branch: 'main',
  data_handling_terms: 'contributor_retains',
  storage_type: 'github',
};
const wizardToken = realEncode.encodeInviteToken(WIZARD_MINT);
const cardToken = realEncode.encodeInviteToken(sharedApi.inviteRequestBody(conn()));

ok(wizardToken.startsWith('sbi_'), 'the minted token carries the sbi_ prefix');
eq(cardToken, wizardToken, 'the card re-derives the wizard\'s token BYTE-FOR-BYTE');

{
  // Determinism, stated as behaviour rather than assumed from the word.
  const again = realEncode.encodeInviteToken(sharedApi.inviteRequestBody(conn()));
  eq(again, cardToken, 'the derivation is deterministic — same connection, same token');
}
{
  // …and it is a real function of the metadata, not a constant.
  const other = realEncode.encodeInviteToken(sharedApi.inviteRequestBody(conn({ shared_domain: 'other-domain' })));
  ok(other !== cardToken, 'control: a DIFFERENT shared_domain produces a different token (the equality above is not vacuous)');
}
{
  const other = realEncode.encodeInviteToken(sharedApi.inviteRequestBody(conn({ data_handling_terms: 'organisational' })));
  ok(other !== cardToken, 'control: different terms produce a different token — which is exactly why the caution exists');
}

// Round-trip: decode what the card would send and check every field.
{
  const payload = JSON.parse(realEncode.base64UrlDecode(cardToken.slice('sbi_'.length)));
  eq(payload.v, 1, 'decoded payload: version 1');
  eq(payload.repo, 'talirezun/cohort-brain', 'decoded payload: repo');
  eq(payload.name, 'Cohort Brain', 'decoded payload: name');
  eq(payload.shared_domain, 'work-ai', 'decoded payload: shared_domain');
  eq(payload.branch, 'main', 'decoded payload: branch');
  eq(payload.storage_type, 'github', 'decoded payload: storage_type');
  eq(payload.data_handling_terms, 'contributor_retains', 'decoded payload: data_handling_terms');
}

// The equivalence above is only meaningful while the wizard's SAVE maps its
// mint inputs onto the connection fields this card reads back. Pinned as a
// source guard so a change there fails here rather than silently making the
// re-derived token wrong.
ok(/label:\s*meta\.name/.test(code.wizard), 'wizard save maps meta.name → label (the inverse of inviteRequestBody.name)');
ok(/github_repo_owner:\s*meta\.repo\.split\('\/'\)\[0\]/.test(code.wizard), 'wizard save splits meta.repo → github_repo_owner');
ok(/github_repo_name:\s*meta\.repo\.split\('\/'\)\[1\]/.test(code.wizard), 'wizard save splits meta.repo → github_repo_name');
ok(/shared_domain:\s*meta\.shared_domain/.test(code.wizard), 'wizard save maps meta.shared_domain → shared_domain');
ok(/github_branch:\s*meta\.branch/.test(code.wizard), 'wizard save maps meta.branch → github_branch');
ok(/data_handling_terms:\s*meta\.data_handling_terms/.test(code.wizard), 'wizard save persists data_handling_terms (the field the caution is about)');

// ── §6 wiring (source guards, stated as such) ───────────────────────────
section('§6  Wiring — the invite block is reachable and the admin token is not leaked');

ok(/renderAdminToken\([^)]*\)\s*\+\s*\n?\s*renderInvite\(/.test(code.shared),
  'renderAdmin renders the invite block (so it is reachable at all)');
ok(code.shared.includes("data-sb-action=\"invite-show\""), 'the Show button carries data-sb-action="invite-show"');
ok(code.shared.includes("case 'invite-show':"), 'the dispatch handles invite-show');
ok(code.shared.includes("case 'invite-hide':"), 'the dispatch handles invite-hide');
ok(code.shared.includes("case 'invite-copy':"), 'the dispatch handles invite-copy');

{
  const fn = extractFunction(code.shared, 'onShowInvite');
  ok(fn.includes('inviteAffordance('), 'onShowInvite re-checks the affordance at the ACTION, not only in the render');
  ok(fn.includes('/api/sharedbrain/generate-invite'), 'onShowInvite POSTs to the generate-invite route');
  ok(fn.includes('inviteRequestBody(conn)'), 'onShowInvite sends the derived body (not a hand-built one that could drift)');
  ok(!fn.includes('admin_token'), 'onShowInvite never reads the admin_token the route mints alongside — it is not persisted, so showing it would put a live credential on screen that authorises nothing');
  ok(!/card\.acting\s*=/.test(fn), 'onShowInvite does NOT take the per-connection action lock (it is a pure read; it must not block a Push)');
}
{
  const fn = extractFunction(code.shared, 'renderInvite');
  ok(fn.includes('escapeHtml(card.inviteToken)'), 'the token is escaped before it reaches the DOM');
  ok(fn.includes('aff.cautionTerms'), 'the pre-v3.0.5 caution is rendered from the affordance flag');
  ok(!fn.includes('sb-token-box'), 'the invite is NOT rendered in the amber shown-once box — it is not a secret and must not read as one');
}

// ── §7 the five inert controls ──────────────────────────────────────────
section('§7  Inert controls — removed or reworded, with their CSS');

ok(!code.chat.includes('chat-attach-btn'), 'chat: the permanently-disabled attach button is gone');
ok(!code.chatCss.includes('.chat-ctrl-btn {'), 'chat.css: .chat-ctrl-btn (which styled only that button) went with it');
ok(!code.chat.includes('chat-drop-zone'), 'chat: the handler-less drop zone is gone');
ok(!code.chat.includes('chat-drop-goto-ingest'), 'chat: its dangling goto-Ingest listener is gone too');
ok(!code.chatCss.includes('.chat-drop-zone {'), 'chat.css: the .chat-drop-* rules went with the element');
ok(code.chat.includes("navigate('domains')"), 'control: chat.js still uses navigate() elsewhere — the import was not orphaned');

ok(!code.sync.includes('sync-domain-state'), 'sync: the per-domain column that could only ever render "—" is gone');
ok(!code.sync.includes('sync-domain-footnote'), 'sync: the footnote apologising for it is gone');
ok(!code.syncCss.includes('.sync-domain-state {'), 'sync.css: .sync-domain-state went with it');
ok(!code.syncCss.includes('.sync-domain-footnote {'), 'sync.css: .sync-domain-footnote went with it');
ok(code.sync.includes('sync-domain-name'), 'sync: the real domain NAMES (from GET /api/domains) are still listed');
ok(!code.sync.includes('PER DOMAIN'), 'sync: the heading no longer promises per-domain state');

// ── §7b the "History — coming soon" card (v3.24.0) ──────────────────────
// Maintainer-reported: an unexplained "Commit history & revert are coming
// soon" card sat under a bare "History" eyebrow on the Sync view with no
// backend behind it and no clear reason to be there. Removed outright —
// NOT reworded (the memory.js UNBUILT check in §8 below covers the
// reword-a-false-claim class; this is a different class, deleting a card
// nobody asked for). The one real fact it carried — every sync is a git
// commit, so a git client can revert by hand — is not thrown away: it
// moves into renderMain()'s renderViewHeader `info` field, which per
// text.js's own docblock is the correct home for an EXPLANATION (as
// opposed to a warning/cost/irreversibility notice, which must stay
// unfolded). Named to the function, not a whole-file grep, so a future
// edit that re-adds a dedicated card elsewhere in the file would still be
// caught here as long as it does not also happen to land inside
// renderMain().
section('§7b  The "History — coming soon" card is gone; the recovery fact moved to the header info mark');

ok(!code.sync.includes('sync-history-empty'), 'sync: the .sync-history-empty card element is gone');
ok(!code.syncCss.includes('.sync-history-empty'), 'sync.css: every .sync-history-empty rule went with it (class AND scoped children)');
ok(!/commit history/i.test(code.sync), 'sync: no "Commit history" heading/copy remains anywhere in the view');
ok(!/coming soon/i.test(code.sync), 'sync: no "coming soon" roadmap teaser remains anywhere in the view');
ok(!code.sync.includes("'History'"), 'sync: the bare "History" eyebrow that introduced the card is gone');

{
  const fnMain = extractFunction(code.sync, 'renderMain');
  ok(/info:\s*'/.test(fnMain), 'renderMain: renderViewHeader is now called WITH an info field (was header-only before)');
  ok(/real git commit/.test(fnMain), 'renderMain: the info text names the actual recovery mechanism (a real git commit)');
  ok(/git client/.test(fnMain), 'renderMain: the info text names how to act on it (a git client)');
  ok(!/coming soon/i.test(fnMain), 'renderMain: the relocated sentence does not resurrect "coming soon" wording');

  // ── THE FALSE-REVERT CLASS, GUARDED RATHER THAN RE-FIXED ──────────────
  // CLAUDE.md tracks this class from v3.9.1 (a "revert it from the Sync tab"
  // promise found at EIGHT sites) through v3.20.0 (a NINTH: "Every sync is a
  // git commit, so anything can be reverted" — in this very file). There is
  // no revert route in src/routes/sync.js and never has been. The v3.24.0
  // rewrite's own first draft reached for "so nothing is lost", which is
  // false twice over: `*/raw/` is gitignored (ingested source files are
  // NEVER committed, so no git history restores them) and pull() resolves
  // with `-X theirs`, measured in v3.17.2 to silently discard the local side
  // of a conflicting hunk. Guarding the SHAPE, not the sentence, because the
  // next instance will be written by someone who never read this file.
  const ABSOLUTES = [
    /nothing is lost/i,
    /anything can be reverted/i,
    /revert it from the sync tab/i,
    /everything is recoverable/i,
  ];
  for (const re of ABSOLUTES) {
    ok(!re.test(fnMain), `renderMain: the info text makes no absolute safety promise (${re.source})`);
  }
  // And the positive half, so the guard above cannot be satisfied by simply
  // deleting the sentence: the ABSENCE of an in-app revert must be STATED,
  // which is what stops a user hunting the UI for a button that is not there.
  ok(/no revert control/i.test(fnMain),
    'renderMain: the info text says plainly that there is no revert control in the app');
  ok(/auto-saves/i.test(fnMain),
    'renderMain: it names the mechanism that makes the recovery path real (pull auto-saves before merging)');
}

// ── §8 CLASS-LEVEL: no preview-era vocabulary in user-visible strings ───
// The point of a class-level assertion rather than four spot checks: this
// vocabulary was scattered by an era, not by an author, and the next
// instance will be written by somebody who never read this file. Run over
// COMMENT-STRIPPED source, because the comments in these very files
// legitimately quote the phrases while explaining why they were removed.
section('§8  Class invariant — no build vocabulary in shipped copy');

const PREVIEW_VOCAB = [
  'preview shell',
  'this shell',
  'this phase',
  'not wired',
  'preview build',
];
for (const [name, body] of Object.entries({
  'shared.js': code.shared,
  'sync.js': code.sync,
  'chat.js': code.chat,
  'memory.js': code.memory,
  'chat.css': code.chatCss,
  'sync.css': code.syncCss,
})) {
  const lower = body.toLowerCase();
  const hits = PREVIEW_VOCAB.filter((v) => lower.includes(v));
  ok(hits.length === 0, `${name} carries no preview-era vocabulary in code${hits.length ? ' (found: ' + hits.join(', ') + ')' : ''}`);
}

// Control: the detector can actually fire. Without this, an over-eager
// stripComments (or a typo in the vocabulary list) would report a clean
// sweep over nothing at all.
{
  const planted = stripComments('const s = "Not wired up in this phase";\n// this shell — a comment, must not count\n');
  const lower = planted.toLowerCase();
  ok(PREVIEW_VOCAB.some((v) => lower.includes(v)), 'control: the detector FIRES on a planted user-visible string');
  ok(!lower.includes('this shell'), 'control: …and does NOT fire on the same vocabulary inside a comment');
}

// The replacement copy is real product language, not a differently-worded
// evasion.
// v3.17.0 INVERTED this assertion, and the reason matters more than the line.
// It was written when replacing build vocabulary ("not wired up in this shell")
// with "coming soon" was the FIX — the honest wording for a feature that did not
// exist. Agent memory now EXISTS (two MCP tools, a store, a route), so "coming
// soon" became the false claim, and views/settings.js carries an explicit house
// rule against it: "NO PROMISE OF A DATE, and no 'coming soon'. This project has
// shipped 27 consecutive 'previews' straight to production."
// The durable guarantee is the PREVIEW_VOCAB sweep above, which still runs over
// this file. What is pinned here is the fact that replaced it: the view must not
// tell a user the feature is unbuilt when it is built.
{
  const memCode = stripComments(src.memory).toLowerCase();
  const UNBUILT = ['coming soon', 'not built', "isn't built", 'is not built',
    "doesn't exist yet", 'does not exist yet', 'not yet built'];
  const stale = UNBUILT.filter((v) => memCode.includes(v));
  ok(stale.length === 0,
    `memory: does not claim the feature is unbuilt${stale.length ? ' (found: ' + stale.join(', ') + ')' : ''}`);
  // Control: this detector must be able to fire, or it is decoration.
  ok(UNBUILT.some((v) => 'a planted coming soon string'.includes(v)),
    'control: the unbuilt-claim detector FIRES on a planted string');
}
ok(src.shared.includes('Exporting your Shared Brain data — coming soon.'), 'shared: the export note reworded to "coming soon"');
ok(src.shared.includes('Disconnect and re-join to change the selection.'),
  'shared: the domain-selection note now tells the user what to actually DO instead of naming the build');

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
