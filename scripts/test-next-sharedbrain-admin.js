/**
 * test-next-sharedbrain-admin.js — OFFLINE suite for the /next Shared Brain
 * ADMIN surface: admin-token provisioning/rotation and contributor
 * revocation (GDPR Article 17).
 *
 * Subject: src/public/next/views/shared.js + views/shared.css, pinned
 * against the REAL backend contract in src/routes/sharedbrain.js,
 * src/brain/sharedbrain-revoke.js and src/brain/sharedbrain.js.
 *
 * No network, no API key, no server, no DOM. The decision layer and the
 * markup builders are written as pure functions in the view precisely so
 * they can be driven here; they are extracted from the REAL source by
 * brace-matching and evaluated standalone with `new Function` — the pattern
 * scripts/test-next-mcp-wizard.js and scripts/test-chat-markdown.js use.
 *
 * ── WHY THIS SUITE IS SHAPED THE WAY IT IS ─────────────────────────────
 * This repo's recorded failure shape is "a fix closes the reported case
 * while the purpose the code existed for stays broken", and v3.6.2 shipped
 * TWO instances of "new backend fields, no consumer" inside its own fixes.
 * A suite of source regexes asserting "the field name appears somewhere in
 * the view" would reproduce that exactly: it would go green on a field that
 * is read into a variable and never rendered.
 *
 * So §5 renders the ACTUAL MARKUP from a fixture result and asserts the
 * field's own value is present in the output string. Every structured
 * failure field the v3.6.2 backend can emit is traced field → pixels that
 * way, with unique sentinel values so an assertion cannot pass by accident.
 *
 * COVERED, behaviourally (the function is executed, both directions):
 *   §1  adminAffordances()      — rule 4 hiding, incl. read-only beating a
 *                                 locally-provisioned token
 *   §2  revokeGateState() + the short→full expansion — the accident gate
 *   §3  absorbRevokeFrame()     — the two-terminal-frame SSE trap
 *   §4  classifyRevokeOutcome() — success is a NARROW conjunction; every
 *                                 unrecognised shape falls to the honest side
 *   §5  renderRevokeOutcomeHtml() — every structured field reaches markup
 *   §6  a non-clean outcome can never render as success, even when the
 *       server's own prose lies
 *   §7  escaping at every innerHTML sink
 *   §8  renderAdmin/renderAdminToken/renderRevokePanel — hiding and
 *       no-prefill proven from real markup, not from a comment
 *   §9  domainsForAction() for revoke === the backend's registerWrite key
 *
 * NOT COVERED here (stated rather than implied):
 *   - Anything requiring a live DOM: focus, the in-place gate patch
 *     (updateRevokeGateUi), <details> toggling, clipboard. Browser-verified
 *     separately; §10 carries source guards only.
 *   - The network calls themselves. §10 pins the request SHAPE against the
 *     real route; it does not execute a revoke.
 *   - Mount-token discipline (shell-level, and shared with every other view).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const SHARED_PATH = path.join(ROOT, 'src/public/next/views/shared.js');
const shared = readFileSync(SHARED_PATH, 'utf8');
const sharedCss = readFileSync(path.join(ROOT, 'src/public/next/views/shared.css'), 'utf8');
const appJs = readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');
const routes = readFileSync(path.join(ROOT, 'src/routes/sharedbrain.js'), 'utf8');
const revokeBrain = readFileSync(path.join(ROOT, 'src/brain/sharedbrain-revoke.js'), 'utf8');
const sbBrain = readFileSync(path.join(ROOT, 'src/brain/sharedbrain.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Comment stripping for the source guards ─────────────────────────────
// shared.js is heavily commented, and its comments deliberately QUOTE the
// very strings some guards assert absent ("don't 'fix' that by adding one",
// which contains refreshConnections' neighbourhood; "never break on a
// terminal frame"). Run against raw text those guards would be reading a
// comment instead of code — precisely the "the check stopped reaching what
// it protects" failure this repo has recorded more than once.
//
// Deliberately conservative: removes /* … */ blocks and lines whose first
// non-whitespace characters are //. It does NOT strip end-of-line comments
// (that needs a real lexer to tell them from a // inside a string), because
// the safe direction for an ABSENCE check is to leave too much in — a false
// FAILURE the author must look at, never a false pass.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}
function assertStrippedSane(stripped, label, mustContain) {
  for (const needle of mustContain) {
    if (!stripped.includes(needle)) {
      throw new Error(`stripComments over-reached on ${label}: "${needle}" is gone from the stripped code`);
    }
  }
  return stripped;
}
const sharedCode = assertStrippedSane(stripComments(shared), 'shared.js', [
  'function adminAffordances(conn, card)',
  'function runRevoke(token, connId)',
  "case 'revoke-run':",
]);

// ── Extraction (brace-matched; throws loudly if a name goes missing) ─────
function extractFunction(src, name, label) {
  // `export ` is allowed and stripped below — app.js's escapeHtml is exported,
  // and `export` is a syntax error inside new Function().
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${label}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  // Skip the PARAMETER LIST first — several of these take a destructured
  // argument (`function revokeGateState({ member, ... })`), and a naive
  // indexOf('{') latches onto the parameter pattern, so the brace-matcher
  // "ends" the function at the closing paren and yields a truncated,
  // syntactically broken extraction.
  let p = src.indexOf('(', start);
  if (p === -1) throw new Error(`extractFunction: "${name}" has no parameter list`);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i);
  // Tripwire: a truncated extraction must fail LOUDLY here, not later as a
  // confusing SyntaxError out of new Function().
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted.replace(/^export\s+/, '');
}

const PURE_FNS = [
  'mirrorDomainFor',
  'domainsForAction',
  'formatRelativeTime',
  'adminAffordances',
  'revokeExpectedTyped',
  'revokeConfirmationFor',
  'revokeGateState',
  'freshRevokeAcc',
  'absorbRevokeFrame',
  'consumeRevokeChunk',
  'consumeRevokeStream',
  'revokeFailureLines',
  'revokeMarkerNotice',
  'revokeAuditNotice',
  'classifyRevokeOutcome',
  'renderRevokeOutcomeHtml',
  'selectedMemberOf',
  'selectRevokeMember',
  'renderRevokePanel',
  'renderAdminToken',
  'inviteAffordance',
  'renderInvite',
  'renderRevoke',
  'renderAdmin',
];

// The sandbox supplies the REAL escapeHtml (extracted from app.js — the
// escaping discipline is the security-relevant part and must not be a
// stand-in) and an icon() STAND-IN that ECHOES its argument, so if any
// caller ever passed user data through icon() the leak would show up in the
// asserted output rather than being hidden by a constant stub.
const sandbox = new Function(
  'let state = { expandedAdmin: new Set() };\n' +
  extractFunction(appJs, 'escapeHtml', 'app.js') + '\n' +
  'function icon(name, size) { return "<svg data-icon=\\"" + name + "\\" data-size=\\"" + size + "\\"></svg>"; }\n' +
  PURE_FNS.map((n) => extractFunction(shared, n, 'shared.js')).join('\n\n') + '\n' +
  `return { ${PURE_FNS.join(', ')}, escapeHtml, __state: () => state };`
)();

const {
  domainsForAction, adminAffordances, revokeExpectedTyped, revokeConfirmationFor,
  revokeGateState, freshRevokeAcc, absorbRevokeFrame, consumeRevokeChunk, consumeRevokeStream,
  revokeFailureLines, revokeMarkerNotice, revokeAuditNotice, classifyRevokeOutcome,
  renderRevokeOutcomeHtml, selectRevokeMember,
  renderRevokePanel, renderAdminToken, renderAdmin,
} = sandbox;

// ── Fixtures ─────────────────────────────────────────────────────────────
const FELLOW = '7f3a91c2-4b8e-4d16-9a05-2c6e8b1d4f77';
// short_id per groupMembers(): hyphens STRIPPED, then 8 chars.
const SHORT = FELLOW.replace(/-/g, '').slice(0, 8);   // '7f3a91c2'
const MEMBER = { fellow_id: FELLOW, short_id: SHORT, display_name: 'Ada L', submissions: 4, pages: 9, last_contributed_at: null };

function baseCard(over) {
  return Object.assign({
    acting: null, message: null, error: false,
    adminTokenProvisioned: false, shownAdminToken: null, rotateConfirmOpen: false,
    revokeOpen: false, revokeMembers: null, revokeSelectedFellowId: null,
    revokeTyped: '', revokeTokenPresent: false, revokeProgress: null, revokeOutcome: null,
  }, over || {});
}
function conn(over) {
  return Object.assign({
    id: 'c1', label: 'Cohort', read_only: false, admin_token: null,
    shared_brain_slug: 'cohort', local_domains: ['work'],
  }, over || {});
}
// A CLEAN result exactly as sharedbrain-revoke.js's success return builds it.
function cleanResult(over) {
  return Object.assign({
    ok: true, partial: false, erasure_complete: true,
    summary: 'Revocation complete: 4 contributions deleted, 2 pages removed, 7 rebuilt. Next: tell every contributor to Pull updates…',
    contributions_deleted: 4, contributions_failed: [],
    digest_failed: null, pages_deleted: 2, pages_failed: [],
    pages_rebuilt: 7, pages_rebuild_failed: 0,
    state_reset_failed: null, audit_failed: null,
    marker_cleared: true, marker_active: false,
    audit_record: { revoked_at: 'x', rebuild_ok: true },
  }, over || {});
}
function outcomeHtmlFor(result) {
  let acc = freshRevokeAcc();
  acc = absorbRevokeFrame(acc, { type: 'done', result });
  return renderRevokeOutcomeHtml(classifyRevokeOutcome(acc));
}

// ═══════════════════════════════════════════════════════════════════════
section('1. Rule 4 — who may see the admin surface (adminAffordances)');

{
  const a = adminAffordances(conn({ read_only: true, admin_token: 'sbat_abcd1234…' }), baseCard());
  ok(a.show === false, 'read-only connection: the whole admin surface is hidden');
  ok(a.showRevoke === false && a.showRotate === false,
    'read-only connection: neither revoke nor rotate is offered, even WITH an admin token stored');
}
{
  const a = adminAffordances(conn({ read_only: true }), baseCard({ adminTokenProvisioned: true }));
  ok(a.show === false,
    'read-only beats a locally-provisioned token — the provisioning flag cannot re-open the surface');
}
{
  const a = adminAffordances(conn({ admin_token: null }), baseCard());
  ok(a.show === true && a.showRotate === true, 'no admin token: the surface shows and rotate is offered');
  ok(a.showRevoke === false, 'no admin token: REVOKE is hidden');
  ok(a.rotateLabel === 'Generate admin token', 'no admin token: rotate is labelled as PROVISIONING, not rotation');
}
{
  const a = adminAffordances(conn({ admin_token: 'sbat_abcd1234…' }), baseCard());
  ok(a.showRevoke === true, 'admin token present (masked, as GET /list returns it): revoke is offered');
  ok(a.rotateLabel === 'Rotate admin token', 'admin token present: the button says Rotate');
}
{
  const a = adminAffordances(conn({ admin_token: null }), baseCard({ adminTokenProvisioned: true }));
  ok(a.showRevoke === true,
    'a just-rotated token makes revoke reachable WITHOUT a list refresh (the shown-once rule)');
}
{
  const a = adminAffordances(conn({ admin_token: '' }), baseCard());
  ok(a.showRevoke === false, 'an empty-string admin_token is not a token');
}
{
  let threw = false;
  try { adminAffordances(undefined, undefined); } catch { threw = true; }
  ok(!threw, 'adminAffordances tolerates a missing connection/card without throwing');
}

// ═══════════════════════════════════════════════════════════════════════
section('2. Rule 2 — the confirmation gate and the short→full expansion');

ok(revokeExpectedTyped(MEMBER) === 'REVOKE-' + SHORT,
  'the admin types the SHORT form, REVOKE-<short_id>');
ok(revokeConfirmationFor(MEMBER) === 'REVOKE-' + FELLOW,
  'the API receives the FULL-UUID literal, REVOKE-<fellow_id>');
ok(revokeConfirmationFor(MEMBER) === `REVOKE-${FELLOW}`,
  'the expansion is byte-exact against the route\'s own template literal');
ok(revokeExpectedTyped(MEMBER) !== revokeConfirmationFor(MEMBER),
  'the typed phrase and the transmitted phrase are genuinely different strings');
ok(SHORT.length === 8 && FELLOW.length === 36,
  'short_id is 8 chars against a 36-char fellow_id — the remaining 28 characters are NOT recoverable from what the admin typed, so the expansion cannot be string surgery on the input');
{
  // The behavioural proof that each phrase reads its OWN field: a member
  // whose short_id does not correspond to its fellow_id at all. If the
  // expansion ever started deriving the literal from the typed phrase, this
  // goes red.
  const odd = { fellow_id: FELLOW, short_id: 'zzzzzzzz' };
  ok(revokeConfirmationFor(odd) === 'REVOKE-' + FELLOW,
    'the TRANSMITTED confirmation is derived from fellow_id — never from short_id or from what was typed');
  ok(revokeExpectedTyped(odd) === 'REVOKE-zzzzzzzz',
    'the TYPED phrase is derived from short_id — never from fellow_id');
}
ok(revokeConfirmationFor({ short_id: SHORT }) === null,
  'a member with no fellow_id yields no confirmation (never a half-built literal)');
ok(revokeExpectedTyped({ fellow_id: FELLOW }) === null, 'a member with no short_id yields no expected phrase');

{
  const G = (o) => revokeGateState(Object.assign({ member: MEMBER, typed: 'REVOKE-' + SHORT, tokenPresent: true, busy: false }, o));
  ok(G({}).unlocked === true, 'all three conditions met → unlocked');
  ok(G({ member: null }).unlocked === false, 'no member selected → locked');
  ok(G({ tokenPresent: false }).unlocked === false, 'no admin token typed → locked');
  ok(G({ typed: '' }).unlocked === false, 'empty confirmation → locked');
  ok(G({ typed: 'REVOKE-' + SHORT.toUpperCase() }).unlocked === false, 'confirmation is case-sensitive');
  ok(G({ typed: 'REVOKE-' + SHORT.slice(0, 7) }).unlocked === false, 'a near-miss confirmation → locked');
  ok(G({ typed: '  REVOKE-' + SHORT + '  ' }).unlocked === true, 'surrounding whitespace is tolerated');
  ok(G({ typed: 'REVOKE-' + FELLOW }).unlocked === false,
    'typing the FULL uuid form does not unlock — the gate is the short form the UI asked for');
  ok(G({ busy: true }).unlocked === false,
    'busy → locked even when member, token and confirmation are all valid');
  ok(G({ member: { short_id: SHORT } }).unlocked === false,
    'a member with no fellow_id can never unlock (there would be nothing valid to send)');
  ok(typeof G({ typed: '' }).reason === 'string' && G({ typed: '' }).reason.includes('REVOKE-' + SHORT),
    'the locked reason tells the admin the exact phrase to type');
  ok(G({ member: null }).reason.indexOf('REVOKE-') === -1,
    'with nothing selected the reason does NOT leak a phrase to type');
}

// ═══════════════════════════════════════════════════════════════════════
section('3. The SSE trap — two terminal frames, only one carries `result`');
//
// revokeContributor calls onProgress('done', msg) → the route forwards it as
// {type:'done', message} with NO result; the route THEN emits its own
// {type:'done', result}. A reader that stops at the first terminal frame gets
// the prose and none of the structured fields.

{
  let acc = freshRevokeAcc();
  acc = absorbRevokeFrame(acc, { type: 'info', message: 'Listing contributions…' });
  acc = absorbRevokeFrame(acc, { type: 'progress', message: 'Deleted contribution 7f3a91c2…' });
  acc = absorbRevokeFrame(acc, { type: 'done', message: 'Revocation complete: 4 contributions deleted…' });
  ok(acc.result === null, 'the FIRST done frame (onProgress) carries no result — reproduced exactly');
  acc = absorbRevokeFrame(acc, { type: 'done', result: cleanResult() });
  ok(acc.result !== null && acc.result.erasure_complete === true,
    'the SECOND done frame (the route) delivers the structured result — absorption did not stop at the first');
  ok(acc.result.contributions_deleted === 4, 'the structured counts survive the two-frame sequence');
}
{
  // Order-independence: a result already absorbed must never be cleared by a
  // later frame that has none.
  let acc = freshRevokeAcc();
  acc = absorbRevokeFrame(acc, { type: 'done', result: cleanResult() });
  acc = absorbRevokeFrame(acc, { type: 'done', message: 'trailing prose with no result' });
  ok(acc.result !== null, 'a later result-LESS frame cannot clear a result already absorbed');
}
{
  // The failure path has the same two-frame shape.
  let acc = freshRevokeAcc();
  acc = absorbRevokeFrame(acc, { type: 'error', message: '⚠ ERASURE INCOMPLETE — …' });
  ok(acc.sawError === true, 'the first error frame is recorded');
  ok(acc.result === null, 'the first error frame carries no result');
  acc = absorbRevokeFrame(acc, { type: 'error', message: 'x', result: cleanResult({ ok: false, partial: true, erasure_complete: false }) });
  ok(acc.result !== null && acc.result.erasure_complete === false,
    'the route\'s error frame delivers the structured result — the failure path is NOT dead data');
}
{
  let acc = freshRevokeAcc();
  const before = JSON.stringify(acc);
  absorbRevokeFrame(acc, { type: 'done', result: cleanResult() });
  ok(JSON.stringify(acc) === before, 'absorbRevokeFrame is pure — it does not mutate the accumulator it is given');
}
{
  let acc = freshRevokeAcc();
  let threw = false;
  try {
    for (const junk of [null, undefined, 'string', 42, {}, { type: 'done' }, { type: 'done', result: 'not-an-object' }]) {
      acc = absorbRevokeFrame(acc, junk);
    }
  } catch { threw = true; }
  ok(!threw, 'malformed frames do not throw');
  ok(acc.result === null, 'a non-object `result` is refused rather than absorbed');
}

// ═══════════════════════════════════════════════════════════════════════
section('4. classifyRevokeOutcome — success is a NARROW conjunction');

function classifyOf(result) {
  let acc = freshRevokeAcc();
  if (result) acc = absorbRevokeFrame(acc, { type: 'done', result });
  return classifyRevokeOutcome(acc);
}
{
  const o = classifyOf(cleanResult());
  ok(o.tone === 'success' && o.certifiable === true, 'ok + !partial + erasure_complete → success');
}
{
  const o = classifyOf(cleanResult({ ok: false, partial: true, erasure_complete: true, summary: 'Erasure completed (…), but the revocation did NOT finish cleanly.' }));
  ok(o.tone === 'warning', 'partial:true with erasure_complete:true → WARNING, never success');
  ok(o.certifiable === false, 'a partial run is not certifiable');
  ok(!/Revocation complete/i.test(o.headline), 'the partial headline never says "Revocation complete"');
  ok(/do NOT certify/i.test(o.erasureLine), 'the partial outcome explicitly says not to certify');
}
{
  const o = classifyOf(cleanResult({ ok: false, partial: true, erasure_complete: false }));
  ok(o.tone === 'danger', 'erasure_complete:false → DANGER');
  ok(/NOT been fully removed/i.test(o.headline), 'the danger headline states the data was not fully removed');
  ok(o.certifiable === false, 'an incomplete erasure is not certifiable');
}
{
  // THE DEFAULT-DIRECTION TEST. v3.6.1 records a `default:` arm that fell
  // into the cheerful branch; an absent verdict must fall to the honest side.
  const r = cleanResult(); delete r.erasure_complete;
  const o = classifyOf(r);
  ok(o.tone !== 'success', 'erasure_complete ABSENT → not success, even with ok:true and partial:false');
  ok(o.tone === 'warning' && o.certifiable === false, 'an absent verdict degrades to "not confirmed", not to "complete"');
}
{
  const o = classifyOf(cleanResult({ erasure_complete: null }));
  ok(o.tone !== 'success', 'erasure_complete:null → not success');
}
{
  const o = classifyOf(null);
  ok(o.tone === 'danger', 'no result at all → danger');
  ok(/NOT erased/i.test(o.headline), 'a resultless stream tells the admin to treat the data as NOT erased');
  ok(o.certifiable === false, 'a resultless stream is not certifiable');
}
{
  const o = classifyOf(cleanResult({ ok: true, partial: true }));
  ok(o.tone !== 'success', 'partial:true wins over ok:true — the two disagreeing must not resolve cheerfully');
}
{
  const o = classifyOf(cleanResult());
  ok(o.summary.startsWith('Revocation complete:'), 'the SERVER summary is preferred verbatim, not re-composed here');
}
{
  const r = cleanResult(); delete r.summary;
  const o = classifyOf(r);
  ok(typeof o.summary === 'string' && o.summary.length > 0, 'a missing summary degrades to a real string, never "undefined"');
  ok(o.tone === 'success', 'a missing summary does not by itself demote a clean run');
}
{
  // FINDING 1 (re-audit LOW): a STRUCTURED result present but with no
  // `summary` field is the only case the `summaryFromServer: hasServerSummary`
  // ternary exists to guard — the `!result` early-return branch hardcodes
  // `false` and never runs this line at all. The block above already checks
  // that `o.summary` degrades to a real string, but never checked the flag
  // ITSELF nor the label it drives — exactly the gap a mutation to
  // `summaryFromServer: true` slips through undetected.
  //
  // Reachability today is nil (sharedbrain-revoke.js sets `summary` at all
  // three of its return points), which is precisely why this needs a test:
  // nothing else catches a future return path that forgets to.
  const r = cleanResult(); delete r.summary;
  const o = classifyOf(r);
  ok(o.summaryFromServer === false, 'a structured result missing `summary` is never marked as server-authored');
  const html = renderRevokeOutcomeHtml(o);
  ok(/not a confirmed result — do not quote this/.test(html) && !/the wording to quote/.test(html),
    'so the rendered label reads "not a confirmed result — do not quote this", never "the wording to quote"');
}
{
  // MUTATION PROOF (Finding 1). Reproduce the re-audit's exact defeat:
  // `summaryFromServer: hasServerSummary` → a bare `true`. The two
  // assertions above must go RED against this mutated build, proving they
  // are behavioural and not merely checking that the field exists.
  const goodSrc = extractFunction(shared, 'classifyRevokeOutcome', 'shared.js');
  const needle = 'summaryFromServer: hasServerSummary,';
  if (!goodSrc.includes(needle)) {
    throw new Error('FINDING-1 mutation guard: classifyRevokeOutcome\'s summaryFromServer line changed — update this mutation to match it');
  }
  const mutatedSrc = goodSrc.replace(needle, 'summaryFromServer: true,');
  const mutatedClassify = new Function(
    extractFunction(shared, 'revokeFailureLines', 'shared.js') + '\n' +
    extractFunction(shared, 'revokeMarkerNotice', 'shared.js') + '\n' +
    extractFunction(shared, 'revokeAuditNotice', 'shared.js') + '\n' +
    mutatedSrc + '\n' +
    'return classifyRevokeOutcome;'
  )();

  let acc = freshRevokeAcc();
  const r = cleanResult(); delete r.summary;
  acc = absorbRevokeFrame(acc, { type: 'done', result: r });
  const mutatedOutcome = mutatedClassify(acc);
  ok(mutatedOutcome.summaryFromServer === true,
    'MUTATION PROOF: with the guard defeated, a result missing `summary` is wrongly marked server-authored');
  const html = renderRevokeOutcomeHtml(mutatedOutcome);
  ok(/Server summary \(the wording to quote\)/.test(html),
    'MUTATION PROOF: …and the rendered label wrongly invites the admin to quote the fallback string as the server’s ' +
    'own wording — the exact defeat the re-audit found undetected');
}

// ═══════════════════════════════════════════════════════════════════════
section('5. Field → pixels: every structured field reaches the MARKUP');
//
// The dead-data proof. Each fixture carries a unique sentinel; the assertion
// is against the rendered HTML string, so a field that is read but never
// rendered fails here.

{
  const html = outcomeHtmlFor(cleanResult({
    ok: false, partial: true, erasure_complete: false,
    contributions_failed: [{ submission_id: 'deadbeefcafe', error: 'SENTINEL_CONTRIB_ERR' }],
  }));
  ok(html.includes('SENTINEL_CONTRIB_ERR'), 'contributions_failed[].error is rendered');
  ok(html.includes('deadbeef'), 'contributions_failed[].submission_id is rendered (shortened)');
  ok(/could NOT be deleted/.test(html), 'contributions_failed is labelled in plain English');
}
{
  const html = outcomeHtmlFor(cleanResult({ ok: false, partial: true, digest_failed: { error: 'SENTINEL_DIGEST_ERR' } }));
  ok(html.includes('SENTINEL_DIGEST_ERR'), 'digest_failed.error is rendered');
}
{
  const html = outcomeHtmlFor(cleanResult({
    ok: false, partial: true, erasure_complete: false,
    pages_failed: [{ path: 'concepts/SENTINEL_PAGE.md', error: 'SENTINEL_PAGE_ERR' }],
  }));
  ok(html.includes('concepts/SENTINEL_PAGE.md'), 'pages_failed[].path is rendered');
  ok(html.includes('SENTINEL_PAGE_ERR'), 'pages_failed[].error is rendered');
}
{
  const html = outcomeHtmlFor(cleanResult({ ok: false, partial: true, pages_rebuild_failed: 3 }));
  ok(/3 pages failed to write during the rebuild/.test(html), 'pages_rebuild_failed is rendered with its count');
}
{
  const html = outcomeHtmlFor(cleanResult({ ok: false, partial: true, state_reset_failed: { error: 'SENTINEL_STATE_ERR' } }));
  ok(html.includes('SENTINEL_STATE_ERR'), 'state_reset_failed.error is rendered');
  ok(/not an erasure failure/.test(html), 'state_reset_failed is correctly NOT presented as an erasure failure');
}
{
  const html = outcomeHtmlFor(cleanResult({ ok: false, partial: true, audit_failed: { error: 'SENTINEL_AUDIT_ERR' } }));
  ok(html.includes('SENTINEL_AUDIT_ERR'), 'audit_failed.error is rendered');
  ok(/no permanent record|No audit record/.test(html), 'audit_failed is explained, not just named');
}
{
  const html = outcomeHtmlFor(cleanResult({ ok: false, partial: true, audit_record: { rebuild_ok: false } }));
  ok(/rebuild synthesis FAILED/.test(html), 'a failed rebuild (audit_record.rebuild_ok === false) is rendered');
}
{
  const html = outcomeHtmlFor(cleanResult({ ok: false, partial: true, marker_cleared: false, marker_active: true }));
  ok(/BLOCKED right now/.test(html), 'marker_active:true renders the actionable "cohort synthesis is blocked" warning');
}
{
  const html = outcomeHtmlFor(cleanResult({ ok: false, partial: false, erasure_complete: false, marker_cleared: null, marker_active: null }));
  ok(/UNKNOWN/.test(html), 'marker_active:null renders as genuinely UNKNOWN');
  ok(!/BLOCKED right now/.test(html), 'marker_active:null does NOT raise a cohort-wide "blocked" alarm');
}
{
  const html = outcomeHtmlFor(cleanResult({ ok: false, partial: false, erasure_complete: false, marker_cleared: null, marker_active: false }));
  ok(!/BLOCKED right now/.test(html) && !/UNKNOWN/.test(html),
    'marker_cleared:null with marker_active:false (a pre-Step-0 abort) claims neither blocked nor unknown');
}
{
  // An abort writes NO audit line. Saying nothing would let the admin assume one exists.
  const html = outcomeHtmlFor(cleanResult({ ok: false, partial: false, erasure_complete: false, audit_record: null, audit_failed: null }));
  ok(/No audit record was written for this attempt/.test(html),
    'an aborted run states that NO audit record was written — it is never implied to have been logged');
}
{
  const html = outcomeHtmlFor(cleanResult());
  ok(/4 contributions deleted · 2 pages removed · 7 rebuilt/.test(html), 'the deleted/removed/rebuilt counts are rendered');
  ok(html.includes('Revocation complete: 4 contributions deleted'), 'the server summary is rendered verbatim');
}
{
  // The count line must survive a zero — a falsy 0 that renders nothing would
  // silently hide "nothing was deleted", which is exactly what an admin needs
  // to see on a run that erased nothing.
  const html = outcomeHtmlFor(cleanResult({ contributions_deleted: 0, pages_deleted: 0, pages_rebuilt: 0 }));
  ok(/0 contributions deleted · 0 pages removed · 0 rebuilt/.test(html), 'zero counts still render (0 is not treated as absent)');
}
{
  // L5 (audit): certifiable and sawError were written to the outcome object
  // but read nowhere outside this test file. Traced field → pixels exactly
  // like every other field in this section, with unique sentinels.
  const html = outcomeHtmlFor(cleanResult());
  ok(/Certifiable: this result is safe to certify/.test(html),
    'certifiable:true renders an explicit, positive certify notice');
}
{
  const html = outcomeHtmlFor(cleanResult({ ok: false, partial: true, erasure_complete: false }));
  ok(!/Certifiable: this result is safe to certify/.test(html),
    'a non-certifiable outcome renders NO certify notice (erasureLine already carries the negative case)');
}
{
  // An error frame with NO message still sets sawError (absorbRevokeFrame's
  // own contract), and a later done-with-result frame can still classify as
  // success — the two fields do not talk to each other today. sawError must
  // still reach the admin.
  let acc = freshRevokeAcc();
  acc = absorbRevokeFrame(acc, { type: 'error' });
  acc = absorbRevokeFrame(acc, { type: 'done', result: cleanResult() });
  const outcome = classifyRevokeOutcome(acc);
  ok(outcome.tone === 'success' && outcome.sawError === true,
    'sawError survives into the outcome even when a later clean done frame classifies as success');
  const html = renderRevokeOutcomeHtml(outcome);
  ok(/error frame was reported partway through this stream/.test(html),
    'sawError renders a warning notice even on an otherwise-success outcome');
}
{
  const html = outcomeHtmlFor(cleanResult());
  ok(!/error frame was reported partway through this stream/.test(html),
    'sawError:false (the ordinary case) renders no stream-error notice');
}
{
  // L4 (audit): a truncated stream (no terminal frame at all) must never
  // label its leftover progress prose "the wording to quote" — that prose
  // can itself be success-shaped (e.g. cut off mid "Revocation complete…").
  let acc = freshRevokeAcc();
  acc = absorbRevokeFrame(acc, { message: 'Revocation complete: 4 contributions deleted (SENTINEL_PROGRESS_NOT_A_RESULT)' });
  const outcome = classifyRevokeOutcome(acc);
  ok(outcome.tone === 'danger' && outcome.summaryFromServer === false,
    'a resultless stream is DANGER and its summary is never marked as server-authored');
  const html = renderRevokeOutcomeHtml(outcome);
  ok(html.includes('SENTINEL_PROGRESS_NOT_A_RESULT'), 'the leftover message is still shown (useful context)…');
  ok(/not a confirmed result — do not quote this/.test(html) && !/the wording to quote/.test(html),
    '…but labelled as NOT a confirmed, quotable server result — the exact truncated-stream trap the audit named');
}
{
  const html = outcomeHtmlFor(cleanResult());
  ok(/Server summary \(the wording to quote\)/.test(html),
    'a GENUINE result.summary keeps the original "wording to quote" label');
}

// ═══════════════════════════════════════════════════════════════════════
section('6. A non-clean outcome can NEVER read as success');

const NON_SUCCESS_FIXTURES = [
  ['partial with erasure complete', cleanResult({ ok: false, partial: true })],
  ['erasure denied', cleanResult({ ok: false, partial: true, erasure_complete: false })],
  ['erasure verdict absent', (() => { const r = cleanResult(); delete r.erasure_complete; return r; })()],
  ['ok:true but partial:true', cleanResult({ partial: true })],
  ['marker still active', cleanResult({ ok: false, partial: true, marker_cleared: false, marker_active: true })],
];
for (const [label, r] of NON_SUCCESS_FIXTURES) {
  const html = outcomeHtmlFor(r);
  ok(!html.includes('sb-outcome-ok'), `${label}: does NOT render with the success tone class`);
  ok(/sb-outcome-warn|sb-outcome-danger/.test(html), `${label}: renders with a warning or danger tone`);
  ok(!/>Revocation complete\.</.test(html), `${label}: the headline is never "Revocation complete."`);
}
{
  // THE HOSTILE-PROSE TEST. The tone must be decided by the STRUCTURED
  // fields, not by the server's wording — otherwise a drifted summary
  // string could paint a gutted collective green, which is the v3.0.3 bug.
  const html = outcomeHtmlFor(cleanResult({
    ok: false, partial: true, erasure_complete: false,
    summary: 'Revocation complete. Everything is fine.',
  }));
  ok(!html.includes('sb-outcome-ok'), 'a summary claiming success cannot make a failed result render as success');
  ok(html.includes('sb-outcome-danger'), 'the structured fields decide the tone, not the prose');
  ok(/NOT been fully removed/.test(html), 'the honest headline overrides the lying summary');
}
{
  const html = outcomeHtmlFor(cleanResult());
  ok(html.includes('sb-outcome-ok'), 'a genuinely clean run DOES render with the success tone (the suite can go both ways)');
}

// ═══════════════════════════════════════════════════════════════════════
section('7. Escaping at every innerHTML sink');

{
  const nasty = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';
  const html = outcomeHtmlFor(cleanResult({
    ok: false, partial: true, erasure_complete: false,
    summary: nasty,
    contributions_failed: [{ submission_id: nasty, error: nasty }],
    pages_failed: [{ path: nasty, error: nasty }],
    digest_failed: { error: nasty },
    state_reset_failed: { error: nasty },
    audit_failed: { error: nasty },
  }));
  ok(!html.includes('<script>'), 'no raw <script> survives into the outcome markup');
  // Note the assertion is on the TAG, not on the substring "onerror=".
  // escapeHtml neutralises `<` `>` `"` `'` `&`; the bare text `onerror=alert(2)`
  // legitimately survives as escaped body text and is inert there. An
  // assertion against the substring would have been checking the wrong thing.
  ok(!html.includes('<img'), 'no raw <img> tag survives — the attribute-breakout vector is closed');
  ok(!/"><img|"><script/.test(html), 'the quote-breakout prefix cannot escape an attribute');
  ok(html.includes('&lt;script&gt;'), 'the hostile string is present but escaped');
  ok(html.includes('&quot;&gt;&lt;img'), 'the breakout attempt is rendered as escaped text');
}
{
  const card = baseCard({ revokeOpen: true, revokeSelectedFellowId: FELLOW, revokeMembers: { members: [{ fellow_id: FELLOW, short_id: SHORT, display_name: '<img src=x onerror=alert(1)>', submissions: 1, pages: 1, last_contributed_at: null }], selfFellowId: null } });
  const html = renderRevokePanel(conn(), card, false, false);
  ok(!html.includes('<img src=x'), 'a hostile display_name from the shared repo is escaped in the member list');
  ok(html.includes('&lt;img'), 'the hostile display_name is present but escaped');
}
{
  const html = renderAdminToken(baseCard({ shownAdminToken: 'sbat_"><script>x</script>' }), adminAffordances(conn(), baseCard()), false);
  ok(!html.includes('<script>'), 'the shown-once token box escapes its value');
}

// ═══════════════════════════════════════════════════════════════════════
section('8. Rendered markup — hiding, no-prefill, shown-once');

{
  ok(renderAdmin(conn({ read_only: true }), baseCard(), false, false) === '',
    'read-only connection renders NO admin markup at all (not merely a disabled control)');
  const html = renderAdmin(conn({ read_only: true, admin_token: 'sbat_abcd1234…' }), baseCard({ adminTokenProvisioned: true }), false, false);
  ok(html === '', 'read-only renders nothing even with a token stored AND provisioned locally');
}
{
  const html = renderAdmin(conn({ admin_token: null }), baseCard(), false, false);
  ok(!html.includes('data-sb-action="revoke-open"'), 'no admin token: the revoke control is absent from the markup');
  ok(html.includes('data-sb-action="rotate-open"'), 'no admin token: rotate IS offered as the provisioning path');
  ok(/Generate one above first/.test(html), 'no admin token: the markup explains how to unlock revoke');
}
{
  const html = renderAdmin(conn({ admin_token: 'sbat_abcd1234…' }), baseCard(), false, false);
  ok(html.includes('data-sb-action="revoke-open"'), 'admin token present: the revoke control appears');
  ok(/irreversible/i.test(html), 'the revoke control is labelled irreversible');
}
{
  // NO PREFILL — proven from real markup.
  const card = baseCard({ revokeOpen: true, revokeSelectedFellowId: FELLOW, revokeTyped: '', revokeMembers: { members: [MEMBER], selfFellowId: null } });
  const html = renderRevokePanel(conn(), card, false, false);
  const valueAttr = /id="sb-revoke-confirm-c1"[^>]*?value="([^"]*)"/.exec(html);
  ok(valueAttr !== null, 'the confirmation input is present with a value attribute');
  ok(valueAttr[1] === '', 'THE CONFIRMATION FIELD IS EMPTY — a selected member does not prefill the unlocking phrase');
  ok(html.includes('Type REVOKE-' + SHORT), 'the phrase to type is SHOWN as guidance');
  ok(html.indexOf('value="REVOKE-') === -1, 'the phrase never appears inside any value= attribute');
  ok(/disabled/.test(/data-sb-action="revoke-run"[^>]*>/.exec(html)[0]),
    'with nothing typed, the irreversible button is DISABLED');
}
{
  const card = baseCard({ revokeOpen: true, revokeSelectedFellowId: FELLOW, revokeTyped: 'REVOKE-' + SHORT, revokeTokenPresent: true, revokeMembers: { members: [MEMBER], selfFellowId: null } });
  const html = renderRevokePanel(conn(), card, false, false);
  ok(!/disabled/.test(/data-sb-action="revoke-run"[^>]*>/.exec(html)[0]),
    'with the token typed and the phrase matched, the button is ENABLED (the gate can go both ways)');
  const html2 = renderRevokePanel(conn(), card, false, true);   // mirrorBusy
  ok(/disabled/.test(/data-sb-action="revoke-run"[^>]*>/.exec(html2)[0]),
    'a cross-mount write on the mirror domain re-locks the button');
}
{
  const card = baseCard({ revokeOpen: true, revokeMembers: { members: [], selfFellowId: null } });
  const html = renderRevokePanel(conn(), card, false, false);
  ok(/nobody to revoke/.test(html), 'an empty cohort says so instead of rendering an unusable form');
}
{
  // SHOWN-ONCE SURVIVAL. The box is rendered FROM STATE, so re-rendering
  // redraws it rather than destroying it.
  const card = baseCard({ shownAdminToken: 'sbat_0123456789abcdef' });
  const aff = adminAffordances(conn({ admin_token: null }), card);
  const first = renderAdminToken(card, aff, false);
  const second = renderAdminToken(card, aff, false);
  ok(first.includes('sbat_0123456789abcdef'), 'the shown-once token renders');
  ok(second === first, 'a SECOND render produces identical markup — a re-render cannot wipe the token');
  ok(/shown once/i.test(first), 'the box tells the admin it is shown once');
  ok(/Leaving this view discards it/.test(first),
    'the box states that leaving the view discards the token — browser-verified behaviour, stated rather than left as a silent trap');
  ok(first.includes('data-sb-action="token-hide"'), 'the only way to clear it is the admin\'s own Hide button');
}
{
  const card = baseCard({ shownAdminToken: null });
  const html = renderAdminToken(card, adminAffordances(conn(), card), false);
  ok(!html.includes('sb-token-box'), 'no token box is rendered when there is nothing to show');
}

// ═══════════════════════════════════════════════════════════════════════
section('9. The write gate key matches the backend\'s registerWrite');

{
  const c = conn({ shared_brain_slug: 'cohort' });
  ok(JSON.stringify(domainsForAction(c, 'revoke')) === JSON.stringify(['shared-cohort']),
    'domainsForAction(conn, "revoke") → the shared-<slug> mirror domain');
  ok(JSON.stringify(domainsForAction(c, 'revoke')) === JSON.stringify(domainsForAction(c, 'synthesize')),
    'revoke shares the mirror key with synthesize, exactly as the routes do');
  ok(routes.includes("registerWrite(`shared-${conn.shared_brain_slug}`, 'sharedbrain-revoke')"),
    'PINNED: the real revoke route registers `shared-<slug>` — the key the client uses');
}

// ═══════════════════════════════════════════════════════════════════════
section('10. Source guards — the seams a pure test cannot reach');

const runRevokeSrc = extractFunction(sharedCode, 'runRevoke', 'shared.js (stripped)');
const rotateSrc = extractFunction(sharedCode, 'onRotateAdminToken', 'shared.js (stripped)');

ok(!/refreshConnections/.test(rotateSrc),
  'the rotate path issues NO list refresh — the shown-once rule ("don\'t \'fix\' that by adding one")');
ok(/card\.shownAdminToken = data\.admin_token/.test(rotateSrc),
  'the rotated token is taken from the response and held only in card state');
ok(!/localStorage|sessionStorage/.test(sharedCode),
  'no credential (or anything else) is written to web storage anywhere in this view');
ok(/body: JSON\.stringify\(\{ admin_token: adminToken, fellow_id: fellowId, confirmation \}\)/.test(runRevokeSrc),
  'the admin token travels in the POST BODY — never a URL, never a query string');
ok(!/admin_token=|adminToken.*encodeURIComponent/.test(runRevokeSrc),
  'the admin token is never placed into a URL');
ok(/const adminToken = tokenEl \? tokenEl\.value\.trim\(\) : ''/.test(runRevokeSrc),
  'the token is re-read from the live input at submit time, not trusted from state');
ok(/revokeTokenPresent: false/.test(sharedCode) && !/card\.revokeToken\s*=/.test(sharedCode),
  'card state holds only a boolean token-present flag, never the token value');
ok(/const confirmation = revokeConfirmationFor\(member\)/.test(runRevokeSrc),
  'the transmitted confirmation is built by revokeConfirmationFor from the picked member');
ok(/fellow_id: fellowId, confirmation \}\)/.test(runRevokeSrc),
  'the request sends THAT full-UUID literal — never the short phrase the admin typed');
// MEDIUM-4 (audit): this pair of source checks is now a THIN, CORRECTLY-
// SCOPED complement to the behavioural proof in §10b below — not the whole
// guard. §10b is what actually catches a reintroduced "stop on the first
// terminal frame" regression; these two just confirm runRevoke's own reader
// loop delegates ALL chunk handling to consumeRevokeChunk (so §10b's
// coverage of consumeRevokeChunk/consumeRevokeStream really does cover what
// runRevoke executes) and has no OTHER early exit of its own.
ok(!/if\s*\([^)]*sawTerminal[^)]*\)\s*\{?\s*(?:streamDone\s*=\s*true;\s*)?break/.test(runRevokeSrc)
  && /if \(done\) break;/.test(runRevokeSrc),
  "runRevoke's own reader loop has no early exit keyed on a terminal frame — its ONLY exit is the real stream ending");
ok(/consumeState = consumeRevokeChunk\(consumeState, dec\.decode\(value, \{ stream: true \}\), \(frameAcc\) => \{/.test(runRevokeSrc),
  'runRevoke delegates ALL chunk buffering/absorption to consumeRevokeChunk — the function §10b drives directly');
{
  const chunkSrc = extractFunction(sharedCode, 'consumeRevokeChunk', 'shared.js (stripped)');
  ok(/acc = absorbRevokeFrame\(acc, payload\)/.test(chunkSrc),
    'every frame goes through absorbRevokeFrame, so the structured result cannot be dropped');
}
ok(!/\(await res\.json\(\)\)[\s\S]{0,40}throw|throw new Error\(\(await/.test(runRevokeSrc),
  'no `(await res.json())` inside a throw — a non-JSON 403/409 must not become "Unexpected token \'<\'"');
ok(/res\.json\(\)\.catch\(\(\) => \(\{\}\)\)/.test(runRevokeSrc),
  'the non-SSE error path tolerates a non-JSON body');
ok(/if \(!aff\.showRevoke\) return;/.test(runRevokeSrc),
  'runRevoke re-checks the affordance — rule 4 is enforced at the ACTION, not only in the render');
ok(/if \(!aff\.showRotate\) return;/.test(rotateSrc),
  'onRotateAdminToken re-checks the affordance too');
// NIT (audit): runRevoke's own card.acting busy guard used to be a silent
// `return` while its siblings (startAction, onRotateAdminToken) surface a
// message — a stale click here looked like nothing had happened.
{
  const idxGuard = runRevokeSrc.indexOf('if (card.acting) {');
  const idxMsg = runRevokeSrc.indexOf("card.message = 'An operation is already running on this connection — wait for it to finish.';");
  ok(idxGuard !== -1 && idxMsg !== -1 && idxMsg > idxGuard && idxMsg < idxGuard + 200,
    "runRevoke's busy guard now surfaces a message + render close by, matching its siblings (startAction, onRotateAdminToken) instead of a silent return");
}
// MEDIUM-5 (audit): "selecting a member clears the typed confirmation" used
// to be checked here as `/card\.revokeTyped = '';/.test(sharedCode)` against
// the WHOLE file — true of three unrelated call sites, so it could not
// detect a mutation that made SELECTION ITSELF prefill the phrase. Proven
// behaviourally in §10c below instead, by calling selectRevokeMember()
// directly and by mutation-proving the guard would catch a prefill.
ok(/releases\.forEach\(\(r\) => r\(\)\);/.test(runRevokeSrc),
  'the write-gate handles are released unconditionally in `finally`');
ok(/card\.acting = null;/.test(runRevokeSrc),
  'card.acting is cleared in the same synchronous block as the final outcome (terminal beats pending)');
// Browser-found: the run invalidates the member directory (right — a stale
// list would offer a contributor who no longer exists), and nothing else
// reloads it, so the panel sat on "Loading…" forever after a refused run.
ok(/card\.revokeMembers = null;/.test(runRevokeSrc) && /if \(card\.revokeOpen\) settling\.push\(loadRevokeMembers\(token, connId\)/.test(runRevokeSrc),
  'a finished run that leaves the panel open RELOADS the member directory it just invalidated');
{
  const idxInvalidate = runRevokeSrc.indexOf('card.revokeMembers = null;');
  const idxReload = runRevokeSrc.indexOf('if (card.revokeOpen) settling.push(loadRevokeMembers');
  ok(idxInvalidate !== -1 && idxReload > idxInvalidate,
    'the reload is ordered AFTER the invalidation, so it cannot be undone by it');
}
// MEDIUM-3 (audit): the outcome the admin must certify an erasure from was
// never scrolled into view, and the member-directory reload above pushes it
// further down the page AFTER the first render — see revealRevokeOutcome's
// own comment. Proven from real markup + real ordering, not a comment.
ok(/function revealRevokeOutcome\(connId\)/.test(sharedCode),
  'revealRevokeOutcome exists as its own function (not inlined ad hoc at the call site)');
ok(/Promise\.all\(settling\)\.then\(\(\) => \{ if \(isCurrentMount\(token\)\) revealRevokeOutcome\(connId\); \}\);/.test(runRevokeSrc),
  'the outcome is revealed only after EVERY re-render that can still move it (member reload and/or list refresh) has settled');
{
  // The reveal call must be ORDERED after the settling promises are built,
  // not spliced in right after the synchronous first render() — that
  // render is provably too early (loadRevokeMembers's own re-render, fired
  // afterwards, is what pushes .sb-outcome further down the page).
  const idxFirstRender = runRevokeSrc.indexOf('state.expandedAdmin.add(connId);\n      render(token);');
  const idxSettlingBuild = runRevokeSrc.indexOf('const settling = [];');
  const idxReveal = runRevokeSrc.indexOf('revealRevokeOutcome(connId);');
  ok(idxFirstRender !== -1 && idxSettlingBuild > idxFirstRender && idxReveal > idxSettlingBuild,
    'ordering: first render → settling promises collected → reveal, never reveal right after the first render');
}

// ═══════════════════════════════════════════════════════════════════════
section('10b. MEDIUM-4 — the SSE trap, proven behaviourally (not by a source regex)');
//
// The auditor applied `if (acc.sawTerminal) { streamDone = true; break; }`
// to the OLD inline reader loop and the old source-regex guard — checking
// for the literal string "break outer" and the presence of `if (done)
// break;` — stayed green, because the regression used neither string.
//
// consumeRevokeStream/consumeRevokeChunk are the EXACT functions runRevoke
// now delegates all chunk handling to (pinned in §10 above), so driving
// them here with a fixture is driving what production actually executes,
// not a parallel re-implementation of it.

// The real backend shape (PINNED at the bottom of this file): the FIRST
// done frame carries no result (revokeContributor's own resultless done),
// the SECOND carries the structured result the route builds. This is not
// an invented edge case — it is what the live route + brain module do on
// every real run.
const SSE_FRAME_1 = 'data: ' + JSON.stringify({ type: 'done', message: 'Revocation running…' }) + '\n\n';
const SSE_FRAME_2 = 'data: ' + JSON.stringify({ type: 'done', result: cleanResult() }) + '\n\n';

{
  const acc = consumeRevokeStream([SSE_FRAME_1, SSE_FRAME_2]);
  ok(acc.result && acc.result.ok === true && acc.result.contributions_deleted === 4,
    'consumeRevokeStream: a done-with-no-result frame followed by a done-with-result frame yields the SECOND frame\'s result');
}
{
  // Same two frames, arriving as ONE chunk (a plausible real network split)
  // and as a frame split mid-way across a chunk boundary (buffering must
  // hold the partial frame in `buf` for the next chunk).
  const acc1 = consumeRevokeStream([SSE_FRAME_1 + SSE_FRAME_2]);
  ok(acc1.result && acc1.result.ok === true, 'both frames in ONE chunk still yields the result');

  const mid = Math.floor(SSE_FRAME_2.length / 2);
  const acc2 = consumeRevokeStream([SSE_FRAME_1 + SSE_FRAME_2.slice(0, mid), SSE_FRAME_2.slice(mid)]);
  ok(acc2.result && acc2.result.ok === true,
    'the second frame split across a chunk boundary still yields the result (buf carries the partial frame forward)');
}
{
  // MUTATION PROOF. Re-apply the auditor's exact regression — an early
  // break out of the chunk-consuming loop the instant a terminal frame has
  // been seen — adapted only for this refactor's variable name (`state`/
  // `state.acc` here, where the old inline loop used `acc`/`streamDone`);
  // the SHAPE is byte-identical: stop looking at further input once the
  // stream has reported ANY terminal frame.
  const goodSrc = extractFunction(shared, 'consumeRevokeStream', 'shared.js');
  const needle = 'for (const chunk of chunks) state = consumeRevokeChunk(state, chunk);';
  if (!goodSrc.includes(needle)) {
    throw new Error('MEDIUM-4 mutation guard: consumeRevokeStream\'s loop shape changed — update this mutation to match it');
  }
  const mutatedSrc = goodSrc.replace(
    needle,
    'for (const chunk of chunks) { state = consumeRevokeChunk(state, chunk); if (state.acc.sawTerminal) { break; } }'
  );
  const mutatedConsumeRevokeStream = new Function(
    extractFunction(shared, 'freshRevokeAcc', 'shared.js') + '\n' +
    extractFunction(shared, 'absorbRevokeFrame', 'shared.js') + '\n' +
    extractFunction(shared, 'consumeRevokeChunk', 'shared.js') + '\n' +
    mutatedSrc + '\n' +
    'return consumeRevokeStream;'
  )();

  const mutatedAcc = mutatedConsumeRevokeStream([SSE_FRAME_1, SSE_FRAME_2]);
  ok(mutatedAcc.result === null,
    'MUTATION PROOF: reintroducing "stop on the first terminal frame" drops the REAL result — the exact fixture that ' +
    'passed above now fails against the mutated code, proving this guard is behavioural, not decorative');
  ok(mutatedAcc.sawTerminal === true,
    'the mutated code still correctly marked the stream terminal — it just never saw the frame that mattered');
}

// ═══════════════════════════════════════════════════════════════════════
section('10c. MEDIUM-5 — the no-prefill invariant, proven behaviourally');
//
// The auditor's exact defeat: make member SELECTION prefill the
// confirmation instead of clearing it. The old guard — a whole-FILE regex
// for the literal string `card.revokeTyped = '';` — stayed green under this
// exact mutation, because that string occurs at TWO OTHER unrelated call
// sites in the same file (revoke-close, and runRevoke's own post-run
// reset).

{
  const card = baseCard({ revokeSelectedFellowId: null, revokeTyped: 'REVOKE-leftover-from-a-previous-attempt' });
  const returned = selectRevokeMember(card, FELLOW);
  ok(returned === card, 'selectRevokeMember mutates and returns the same card object');
  ok(card.revokeSelectedFellowId === FELLOW, 'selectRevokeMember sets the selected fellow id');
  ok(card.revokeTyped === '',
    'selectRevokeMember clears ANY previously-typed confirmation — selection can never leave a stale or prefilled phrase behind');
}
{
  // MUTATION PROOF. Apply the auditor's exact defeat to a standalone copy
  // of selectRevokeMember and confirm the SAME assertion shape used above
  // (revokeTyped === '') would have caught it — the invariant is provable,
  // not merely asserted.
  const goodSrc = extractFunction(shared, 'selectRevokeMember', 'shared.js');
  const needle = "card.revokeTyped = '';";
  if (!goodSrc.includes(needle)) {
    throw new Error('MEDIUM-5 mutation guard: selectRevokeMember\'s clearing line changed — update this mutation to match it');
  }
  const mutatedSrc = goodSrc.replace(needle, "card.revokeTyped = 'REVOKE-' + fellowId;");
  const mutatedSelectRevokeMember = new Function(mutatedSrc + '\nreturn selectRevokeMember;')();

  const card = baseCard({ revokeSelectedFellowId: null, revokeTyped: '' });
  mutatedSelectRevokeMember(card, SHORT);
  ok(card.revokeTyped !== '',
    'MUTATION PROOF: a selection handler that PREFILLS the confirmation phrase — defeating the accident gate outright — ' +
    'produces a non-empty revokeTyped, which the behavioural assertion above (checking for emptiness) would catch, ' +
    'unlike the old whole-file regex');
}

// CSS seams (C4/C5: no new stylesheet, no new custom property).
for (const cls of ['.sb-card-admin', '.sb-token-box', '.sb-revoke-panel', '.btn-danger',
  '.sb-outcome-ok', '.sb-outcome-warn', '.sb-outcome-danger', '.sb-member-row']) {
  ok(sharedCss.includes(cls + ' ') || sharedCss.includes(cls + ' {') || sharedCss.includes(cls + ','),
    `CSS: ${cls} is defined in shared.css (no new stylesheet was created)`);
}
// NIT (audit): .btn-danger must not be a BARE global selector in a
// per-view stylesheet — shell.css owns .btn/.btn-primary/.btn-secondary/
// .btn-ghost, the real cross-view button variants, and a bare `.btn-danger`
// here would leak into every other view sharing the class name.
ok(!/(?:^|\n)\.btn-danger\s*\{/.test(sharedCss),
  'CSS: .btn-danger is never defined as a bare top-level selector in shared.css');
ok(/\.sb-revoke-go \.btn-danger\s*\{/.test(sharedCss),
  'CSS: .btn-danger is scoped to .sb-revoke-go, its only user');
// Comment-stripped, for the same reason the JS guards are: shared.css's own
// comments deliberately QUOTE `var(--scrim, ...)` to explain why the token is
// NOT used here, so a raw-text absence check would be reading the explanation
// instead of the code — the "check stopped reaching what it protects" shape.
const sharedCssCode = assertStrippedSane(
  sharedCss.replace(/\/\*[\s\S]*?\*\//g, ''), 'shared.css', ['.sbw-scrim {', '.btn-danger {']);
ok(!/var\(--scrim/.test(sharedCssCode),
  'CSS: shared.css adds no second --scrim reference (it is baselined at exactly one, in shell.css)');
ok(/var\(--scrim/.test(sharedCss),
  'the --scrim mention in shared.css is a COMMENT only — proving the strip above was load-bearing, not decorative');

// Backend contract pins — if any of these go red, the view must be updated
// to match, not the assertion relaxed.
ok(revokeBrain.includes("onProgress('done', doneMsg)"),
  'PINNED: revokeContributor emits its own result-less done frame — the reason absorption must not stop there');
ok(routes.includes("emit({ type: 'done', result })"),
  'PINNED: the route emits a SECOND done frame carrying the structured result');
ok(routes.includes("emit({ type: 'error', message: result.error || 'Revoke failed', result })"),
  'PINNED: the route carries the structured result on the FAILURE frame too');
ok(routes.includes('confirmation !== `REVOKE-${fellow_id}`'),
  'PINNED: the route requires the FULL-UUID confirmation literal');
ok(routes.includes("res.status(403).json({ error: 'admin_token is required and must match the connection' })"),
  'PINNED: an admin-token mismatch is a 403 — the non-SSE path the view handles');
ok(/short_id: c\.fellowId\.replace\(\/-\/g, ''\)\.slice\(0, 8\)/.test(sbBrain),
  'PINNED: short_id strips hyphens — so it can never be expanded back into a UUID by string surgery');
ok(routes.includes('res.json({ ok: true, admin_token: token, rotated: !!conn.admin_token })'),
  'PINNED: the rotate route returns {ok, admin_token, rotated} — the shape the view reads');
{
  // rebuild_ok is deliberately read out of audit_record because it is NOT a
  // top-level result field. If this ever goes RED because the backend added
  // one, update revokeFailureLines() to prefer the top-level field — do not
  // delete this assertion.
  const base = revokeBrain.slice(revokeBrain.indexOf('const baseResult = {'), revokeBrain.indexOf('if (problems.length > 0)'));
  ok(!/^\s*rebuild_ok:/m.test(base),
    'PINNED: rebuild_ok is NOT a top-level result field, which is why the view reads it from audit_record');
  ok(/rebuild_ok: rebuildOk/.test(revokeBrain), 'PINNED: rebuild_ok lives in the audit record');
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ /next Shared Brain admin suite FAILED');
  process.exit(1);
}
console.log('✅ All /next Shared Brain admin assertions green');
