#!/usr/bin/env node
/**
 * OFFLINE — two contracts an MCP client reads BEFORE it ever calls a tool, and
 * that nothing was checking.
 *
 * §1 · THE ACCEPTED `type` VALUES ARE IN THE SCHEMA, NOT ONLY IN PROSE.
 *   `dismiss_wiki_issue` / `undismiss_wiki_issue` gate on a Set and used to
 *   advertise that Set as a comma-separated sentence in a `description`. A
 *   client cannot validate against prose, so the first a model learned of a
 *   wrong value was a refusal string — and the values genuinely differ between
 *   neighbouring tools (`fix_wiki_issue` takes the pseudo-type `orphanLink`
 *   and has no `orphans`; these two take `orphans` and no `orphanLink`), which
 *   is exactly the shape a hand-kept sentence gets wrong.
 *
 *   The guard is an EQUALITY over a derived universe, not a spot check: every
 *   candidate type the codebase knows about — this enum, `AUTO_FIXABLE` from
 *   the health module, plus decoys — is offered to the REAL handler, and
 *   acceptance must match enum membership exactly, in both directions. A value
 *   added to the Set and not to the enum reds here, and so does the reverse.
 *
 * §2 · THE RESPONSE-BUDGET NOTICES NAME THE BUDGET THAT IS ENFORCED.
 *   `MAX_RESPONSE_BYTES` has been 400 KB since v2.3.1 while all three notices
 *   the guard emits said "1 MB limit". A model that is trimmed and then told
 *   its budget is 1 MB has been handed a number 2.6x too large to plan its
 *   retry with. Two of the three arms are driven END TO END through
 *   `registerTools` against a fake storage — the guard really runs, really
 *   trims, and the emitted text is the assertion.
 *
 * SAFETY — no real user data. §1 writes dismissals into a throwaway tempdir
 * pinned with CURATOR_TEST_DOMAINS_DIR + CURATOR_TEST_USER_DATA_DIR before any
 * import; §2 touches no filesystem at all (its storage is a stub object).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-schema-contracts-'));
const DOMAINS = path.join(TMP, 'domains');
const USER_DATA = path.join(TMP, 'userdata');
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(USER_DATA, { recursive: true });
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'DOMAINS_PATH', 'LLM_MODEL']) delete process.env[k];
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

const D = await import('../mcp/tools/dismissed.js');
const { AUTO_FIXABLE, scanWiki } = await import('../src/brain/health.js');
const { createStorageAdapter } = await import('../mcp/storage/local.js');
const { registerTools } = await import('../mcp/tools/index.js');

let passed = 0, failed = 0;
const failures = [];
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); failures.push({ label, detail }); }
};
const section = (t) => console.log(`\n── ${t} ──`);

// ═══ §1 ════════════════════════════════════════════════════════════════════
section('§1 · dismiss/undismiss — the schema enum IS the runtime gate');

const P = 'zz-enum';
mkdirSync(path.join(DOMAINS, P, 'wiki', 'entities'), { recursive: true });
writeFileSync(path.join(DOMAINS, P, 'CLAUDE.md'), `# ${P}\n\nThrowaway fixture.\n`);
const storage = createStorageAdapter({ domainsPath: DOMAINS });

const dismissEnum = D.dismissWikiIssueDefinition.inputSchema.properties.type.enum;
const undismissEnum = D.undismissWikiIssueDefinition.inputSchema.properties.type.enum;

ok(Array.isArray(dismissEnum) && dismissEnum.length > 0,
  'dismiss_wiki_issue declares an `enum` for `type` at all — a client can validate before calling',
  JSON.stringify(dismissEnum));
ok(JSON.stringify(undismissEnum) === JSON.stringify(dismissEnum),
  'undismiss declares the SAME enum — the pair is symmetric by construction, not by hope');

// The universe: everything this codebase treats as an issue type anywhere,
// plus decoys. Derived, so a type added to health.js joins the probe for free.
//
// THE SCANNER'S OWN KEYS ARE IN IT FOR A REASON THIS SUITE LEARNED THE HARD
// WAY. The first version built the universe from `dismissEnum ∪ AUTO_FIXABLE`
// alone, and a mutation that DELETED `orphans` from the enum came back GREEN:
// deleting a value from the enum also deleted it from the probe, so the
// equality was comparing a list against itself. A guard whose universe is
// derived from the thing under test cannot detect that thing shrinking. So the
// third source is INDEPENDENT — the array-valued keys of a real `scanWiki`
// result, which is where dismissible types come from in the first place.
const scanned = await scanWiki(P);
const SCAN_TYPES = Object.entries(scanned)
  .filter(([, v]) => Array.isArray(v)).map(([k]) => k);
ok(SCAN_TYPES.includes('orphans') && SCAN_TYPES.length >= 6,
  `PRECONDITION: the scanner independently names ${SCAN_TYPES.length} issue types, so the probe does not depend on the enum for its candidates`,
  SCAN_TYPES.join(','));
const UNIVERSE = [...new Set([
  ...dismissEnum,
  ...AUTO_FIXABLE,
  ...SCAN_TYPES,
  'orphanLink',      // fix_wiki_issue's pseudo-type — deliberately NOT dismissible
  'orphan',          // the singular near-miss a model would plausibly guess
  '__proto__', 'constructor', 'nonsense',
])];
// The empty string is deliberately NOT in the universe: it is refused one line
// EARLIER, by the `type is required` check, so counting it as "accepted by the
// type gate" would be an artefact of the probe rather than a fact about the
// gate. It gets its own assertion below instead — a distinction the first run
// of this suite got wrong and reported as over-acceptance.

ok(UNIVERSE.length > dismissEnum.length + 2,
  `PRECONDITION: the probe universe (${UNIVERSE.length}) is wider than the enum (${dismissEnum.length}) — a universe equal to the enum could not detect over-acceptance`);

const accepted = { dismiss: [], undismiss: [] };
for (const t of UNIVERSE) {
  const d = await D.dismissWikiIssueHandler({ domain: P, type: t, issue: { file: 'entities/a.md', link: 'b' } }, storage);
  if (!/cannot be dismissed/i.test(String(d?.error || ''))) accepted.dismiss.push(t);
  const u = await D.undismissWikiIssueHandler({ domain: P, type: t, issue: { file: 'entities/a.md', link: 'b' } }, storage);
  if (!/cannot be un-dismissed/i.test(String(u?.error || ''))) accepted.undismiss.push(t);
}
const same = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
ok(same(accepted.dismiss, dismissEnum),
  'THE EQUALITY: the set the dismiss handler accepts is EXACTLY its schema enum — neither wider nor narrower',
  `accepted=${JSON.stringify(accepted.dismiss.sort())} enum=${JSON.stringify([...dismissEnum].sort())}`);
ok(same(accepted.undismiss, undismissEnum),
  '…and the same holds for undismiss',
  `accepted=${JSON.stringify(accepted.undismiss.sort())}`);
const emptyDismiss = await D.dismissWikiIssueHandler({ domain: P, type: '', issue: { a: 1 } }, storage);
ok(/type is required/i.test(String(emptyDismiss?.error || '')),
  'an EMPTY type is refused as missing, one check earlier than the enum gate — a separate contract, asserted separately',
  String(emptyDismiss?.error));
ok(!dismissEnum.includes('orphanLink') && AUTO_FIXABLE.has('orphanLink'),
  'CONTROL: the two surfaces really do differ — `orphanLink` is auto-fixable and NOT dismissible, so this is not a vacuous equality between two copies of one list');
ok(dismissEnum.includes('orphans') && !AUTO_FIXABLE.has('orphans'),
  '…and `orphans` runs the other way, which is the pair a prose-only contract kept confusing');
for (const [name, def] of [['dismiss', D.dismissWikiIssueDefinition], ['undismiss', D.undismissWikiIssueDefinition]]) {
  const desc = def.inputSchema.properties.type.description || '';
  ok(dismissEnum.every((t) => desc.includes(t)),
    `the ${name} description still lists every accepted value — it is composed FROM the enum, so it cannot drift from it`, desc);
}

// ═══ §2 ════════════════════════════════════════════════════════════════════
section('§2 · the size guard names the budget it actually enforces');

/** A fake MCP server that just captures the CallTool handler. */
function captureCallTool() {
  let call = null;
  const server = {
    setRequestHandler(schema, fn) {
      // The list handler takes no request; the call handler does. Distinguish
      // by driving both later — here we keep the second registration, which is
      // CallTool in registerTools' own order, and verify by using it.
      if (call === null) call = fn; else call = fn;
    },
  };
  return { server, get: () => call };
}
// registerTools registers ListTools first, then CallTool; keep the last.
const cap = captureCallTool();
const HUGE_BASE = 'B'.repeat(600 * 1024);
registerTools(cap.server, {
  getBase: () => HUGE_BASE,
  baseExists: async () => false,
  listDomains: async () => [],
});
const callTool = cap.get();
ok(typeof callTool === 'function', 'PRECONDITION: the real CallTool handler was captured from registerTools');

// Arm A — a STRING result over budget takes the truncation path.
const strRes = await callTool({ params: { name: 'list_domains', arguments: {} } });
const strText = strRes?.content?.[0]?.text || '';
ok(strText.length > 100 && /response truncated/i.test(strText),
  'PRECONDITION: an over-budget STRING response really did take the truncation path', strText.slice(-160));
ok(/400 KB response limit/.test(strText) && !/1 MB/.test(strText),
  'the string notice names 400 KB — the budget that was enforced — and no longer claims 1 MB', strText.slice(-160));

// Arm B — an OBJECT result over budget whose arrays are not trimmable falls
// through to the final message.
const cap2 = captureCallTool();
registerTools(cap2.server, {
  getBase: () => '/fake/base',
  baseExists: async () => true,
  listDomains: async () => Array.from({ length: 30000 }, (_, i) => `domain-with-a-long-name-${i}`),
});
const objRes = await cap2.get()({ params: { name: 'list_domains', arguments: {} } });
const objText = objRes?.content?.[0]?.text || '';
ok(/_truncated/.test(objText) && /even after trimming/.test(objText),
  'PRECONDITION: an over-budget OBJECT with no trimmable field really did reach the final fallback', objText.slice(0, 200));
ok(/400 KB response limit/.test(objText) && !/1 MB/.test(objText),
  'the final fallback names 400 KB too', objText.slice(0, 200));

// Arm C — the middle notice (partial trim) is NOT driven here: reaching it
// needs a tool that returns a >400 KB `results`/`edges` array, which means a
// large real wiki on disk. Stated rather than pretended: this one arm is a
// source check, and it is labelled as such.
const guardSrc = await (await import('node:fs/promises'))
  .readFile(new URL('../mcp/tools/index.js', import.meta.url), 'utf8');
// Comments are stripped first: this file's own docblock explains the defect by
// quoting the old figure, and a scan that reds on its own explanation is a
// scan nobody keeps.
const guardCode = guardSrc.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
ok(!/1 MB/.test(guardCode),
  'SOURCE CHECK (the partial-trim notice needs a large real wiki, so it is not reachable offline): no "1 MB" figure survives in the guard\'s CODE',
  (guardCode.match(/.{0,60}1 MB.{0,60}/) || [''])[0]);
ok((guardSrc.match(/MAX_RESPONSE_LABEL/g) || []).length >= 4,
  '…and all three notices plus the definition reference the derived label rather than a typed figure',
  String((guardSrc.match(/MAX_RESPONSE_LABEL/g) || []).length));

console.log(`\n${'─'.repeat(56)}\nPassed: ${passed}   Failed: ${failed}`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
}
process.exit(failed ? 1 : 0);
