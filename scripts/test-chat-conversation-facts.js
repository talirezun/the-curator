/**
 * test-chat-conversation-facts.js — OFFLINE suite for v3.72.0 package P1,
 * "conversation facts": the data the Chat overhaul's list and answers render.
 *
 * WHAT IS RECORDED NOW THAT WAS NOT BEFORE
 *   • conversation.updatedAt — last use, written on every completed turn;
 *   • assistant message.project — the pinned project's name, or null;
 *   • assistant message.priced  — the per-1M rates and the dollar figure AT THE
 *     MOMENT OF ANSWERING (truth audit F2: an old answer used to be re-priced at
 *     today's catalogue on every render);
 *   • listConversations rows: domain (the storage path), updatedAt, lastProject;
 *     sorted by updatedAt ?? createdAt;
 *   • GET /api/chat — one list across every non-mirror domain (decision M1);
 *   • compile estimate: `fallback` (F5) and a basis that never calls a
 *     chars-per-token figure "exact" (F6).
 *
 * THE RULE EVERY SECTION RETURNS TO: a fact that was never recorded is ABSENT,
 * never guessed. An older conversation shows no project, no last-use and no
 * stored price — and nothing back-fills them.
 *
 * Isolation: CURATOR_TEST_USER_DATA_DIR and CURATOR_TEST_DOMAINS_DIR point at
 * fresh temp dirs, the domains dir is also set through __setDomainsDirOverride,
 * the provider is a fake Anthropic SDK injected through llm.js's existing seam,
 * and no ambient key survives. Nothing here touches the network or real data.
 */

import express from 'express';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let passed = 0, failed = 0;
function section(t) { console.log(`\n${t}`); }
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// ── Isolation, BEFORE any brain module is imported ─────────────────────────
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-conv-facts-'));
const DOMAINS = path.join(TMP, 'domains');
const USERDATA = path.join(TMP, 'userdata');
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(USERDATA, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USERDATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
delete process.env.LLM_MODEL;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;
writeFileSync(path.join(USERDATA, '.curator-config.json'), JSON.stringify({
  anthropicApiKey: 'zz-fake-anthropic-key-for-tests',
  activeProvider: 'anthropic',
}) + '\n');

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);
const llm = await import('../src/brain/llm.js');
const chat = await import('../src/brain/chat.js');
const files = await import('../src/brain/files.js');
const { spentFromUsage } = await import('../src/brain/ai-run.js');
const est = await import('../src/brain/compile-estimate.js');
const chatRouter = (await import('../src/routes/chat.js')).default;

const { sendMessage, readConversation } = chat;
const { buildAssistantMessage, normalizePriced, priceServedAnswer } = chat.__testing;
const { listConversations, listAllConversations } = files;

// ── Fixture helpers ─────────────────────────────────────────────────────────
function makeDomain(slug, { readonly = false, page = true } = {}) {
  const base = path.join(DOMAINS, slug);
  mkdirSync(path.join(base, 'wiki', 'entities'), { recursive: true });
  mkdirSync(path.join(base, 'conversations'), { recursive: true });
  writeFileSync(path.join(base, 'CLAUDE.md'),
    readonly ? '---\nreadonly: true\n---\n# mirror\n' : `# ${slug}\n`);
  if (page) {
    writeFileSync(path.join(base, 'wiki', 'entities', 'foo.md'),
      '---\ntype: entity\n---\n# Foo\n\n## Key Facts\n- Foo is a thing.\n');
  }
  return base;
}
const uuidN = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
function writeConv(domain, conv) {
  const p = path.join(DOMAINS, domain, 'conversations', `${conv.id}.json`);
  writeFileSync(p, JSON.stringify(conv, null, 2));
  return p;
}

let answerText = 'Foo is a thing. [source: entities/foo.md]';
let providerBehaviour = 'answer';
const USAGE = { input_tokens: 12000, output_tokens: 900, cache_read_input_tokens: 4000, cache_creation_input_tokens: 1000 };
llm.__setAnthropicClientFactory(() => ({
  messages: {
    stream: () => ({
      finalMessage: () => providerBehaviour === 'throw'
        ? Promise.reject(Object.assign(new Error('zz provider exploded'), { status: 400 }))
        : Promise.resolve({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: answerText }],
          usage: USAGE,
        }),
    }),
  },
}));

// A minimal but well-shaped project-context envelope for the existing
// `opts.getProjectContext` seam (the one test-chat-project-context.js drives).
function projectStore(project) {
  return async () => ({
    ok: true, project, domain: 'alpha', scope: 'session-1',
    brief: { present: true, text: 'BRIEF', bytes: 5, truncated: false, sanitisedOnRead: false, authoredBy: null },
    current: { present: false },
    journal: { entries: [], returned: 0, total: 0, totalUnknown: false },
    seen: {},
    foundations: {
      present: false, ownership: 'curator', repo: null, manifestError: null, orphanFiles: [],
      count: 0, totalBytes: 0, budgetBytes: 200 * 1024, budgetExceeded: false,
      staleCount: 0, unreachableCount: 0, skeletonCount: 0, readFirstCount: 0, onRequestCount: 0,
      readFirstBytes: 0, readFirstBudgetBytes: 120 * 1024, readFirstBudgetExceeded: false,
      changedCount: 0, includeMode: 'changed', bodySelection: 'read-first', seenSource: 'none',
      index: [], documents: [], requested: [], requestedRefused: [], requestedBytes: 0, unreadable: [],
      budget: { maxBytes: 40000, usedBytes: 0, truncated: false, omitted: [] }, readingOrder: [],
    },
  });
}

async function main() {
  makeDomain('alpha');
  makeDomain('beta');
  makeDomain('shared-mirror', { readonly: true });

  // ═════════════════════════════════════════════════════════════════════════
  section('§0 — Harness self-check');
  {
    let sawFail = false;
    const realOk = ok;
    ok = (c) => { if (!c) sawFail = true; }; // eslint-disable-line no-func-assign
    ok(false, 'probe');
    ok = realOk; // eslint-disable-line no-func-assign
    ok(sawFail, 'control: ok() can fail — the assertions below are not decorative');
    eq(llm.getProviderInfo().provider, 'anthropic', 'the fixture config is the only key source (anthropic, fake SDK)');
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('§1 — buildAssistantMessage: project and priced are appended, only when passed');
  {
    const legacy = buildAssistantMessage('a', ['e/f.md'], 'anthropic', 'claude-haiku-4-5', null, null);
    ok(!('project' in legacy) && !('priced' in legacy),
      'a six-argument call (every pre-v3.72 call site) carries neither key — its bytes are unchanged');

    const withNull = buildAssistantMessage('a', [], null, null, null, null, { project: null, priced: null });
    ok(Object.prototype.hasOwnProperty.call(withNull, 'project') && withNull.project === null,
      '"no project on this turn" is RECORDED as null — distinguishable from "not recorded" (key absent)');
    ok(!('priced' in withNull), 'priced: null is OMITTED — nothing true to record means no key');

    const named = buildAssistantMessage('a', [], null, null, null, null, { project: 'curator' });
    eq(named.project, 'curator', 'a pinned project is recorded by name');
    for (const bad of ['', 42, {}, ['x']]) {
      const m = buildAssistantMessage('a', [], null, null, null, null, { project: bad });
      eq(m.project, null, `a non-string/empty project (${JSON.stringify(bad)}) records null, never the raw value`);
    }

    const at = '2026-09-25T10:00:00.000Z';
    const src = { free: false, inPerM: 1, outPerM: 5, costUsd: 0.0123, at, sneaky: '<b>x</b>' };
    const priced = buildAssistantMessage('a', [], null, null, null, null, { project: null, priced: src }).priced;
    eq(JSON.stringify(priced), JSON.stringify({ free: false, inPerM: 1, outPerM: 5, costUsd: 0.0123, at }),
      'priced is a FRESH allow-listed literal — nothing else riding on the caller\'s object reaches disk');
    ok(priced !== src, '…and it is not the caller\'s object');
    eq(JSON.stringify(normalizePriced({ free: true, inPerM: 9, outPerM: 9, costUsd: 3, at })),
      JSON.stringify({ free: true, costUsd: 0, at }),
      'a FREE record carries no per-1M rates and a cost of exactly 0 — never a typed price');
    for (const [label, p] of [
      ['no at', { free: false, inPerM: 1, outPerM: 1, costUsd: 1 }],
      ['unparseable at', { free: false, inPerM: 1, outPerM: 1, costUsd: 1, at: 'yesterday-ish' }],
      ['negative cost', { free: false, inPerM: 1, outPerM: 1, costUsd: -1, at }],
      ['NaN rate', { free: false, inPerM: NaN, outPerM: 1, costUsd: 1, at }],
      ['missing out rate', { free: false, inPerM: 1, costUsd: 1, at }],
      ['an array', [1, 2]],
    ]) {
      eq(normalizePriced(p), null, `a malformed priced record (${label}) is refused, not part-filled`);
    }
    eq(Object.keys(buildAssistantMessage('a', [], 'anthropic', 'm', null, null, { project: 'p', priced: src })).join(','),
      'role,content,citations,provider,model,project,priced',
      'the new keys come AFTER every existing key — existing keys keep their order');
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('§2 — priceServedAnswer: the answer\'s price, fixed on the day it was answered (F2)');
  {
    const usage = { inputTokens: 12000, outputTokens: 900, cachedReadTokens: 4000, cacheWriteTokens: 1000 };
    const p = await priceServedAnswer('claude-haiku-4-5', usage);
    const price = llm.getModelPrice('claude-haiku-4-5');
    ok(p && p.free === false, 'a priced model yields a priced record');
    eq(p && p.inPerM, price.input, 'inPerM is the served model\'s price per 1M input tokens today');
    eq(p && p.outPerM, price.output, 'outPerM likewise for output');
    eq(p && p.costUsd, spentFromUsage({ ...usage, model: 'claude-haiku-4-5', calls: 1 }).usd,
      'costUsd IS spentFromUsage — the app\'s one finished-call formula, not a fifth copy of it');
    // DUMB CROSS-CHECK: the arithmetic by hand, with Anthropic's 0.1x read / 1.25x write.
    const byHand = (12000 * price.input + 900 * price.output + 4000 * price.input * 0.1 + 1000 * price.input * 1.25) / 1e6;
    ok(p && Math.abs(p.costUsd - byHand) < 1e-12, `…and it equals the arithmetic done by hand ($${byHand})`);
    ok(p && Number.isFinite(Date.parse(p.at)) && Math.abs(Date.parse(p.at) - Date.now()) < 60_000,
      '`at` is the moment of pricing');

    // THE F2 CASE: a promotional model. The stored figure is the promotion's,
    // and stays the promotion's — a record is not re-read against tomorrow.
    const promo = await priceServedAnswer('gemini-3.7-flash', usage);
    const promoToday = llm.resolveModelPrice('gemini-3.7-flash', Date.now());
    const after = llm.resolveModelPrice('gemini-3.7-flash', Date.parse('2027-01-02T00:00:00Z'));
    eq(promo && promo.inPerM, promoToday.input, 'a promotional model is recorded at the price in force today');
    ok(after.input > promoToday.input,
      `CONTROL: the same model re-priced after the promotion ends is dearer ($${after.input} vs $${promoToday.input}) — the defect this record prevents`);

    const freeId = [...llm.__testing.FREE_MODELS][0];
    eq(JSON.stringify(Object.keys((await priceServedAnswer(freeId, usage)) || {})), '["free","costUsd","at"]',
      `a FREE model (${freeId}) is recorded as free with cost 0 — membership first, no rates`);
    eq(await priceServedAnswer('zz-no-such-model', usage), null, 'an unpriced model records NOTHING (never $0)');
    eq(await priceServedAnswer('claude-haiku-4-5', null), null, 'no reported usage records nothing');
    eq(await priceServedAnswer('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0 }),
      null, 'the zero-in/zero-out "provider told us nothing" sentinel records nothing');
    eq(await priceServedAnswer(null, usage), null, 'no served model records nothing');
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('§3 — sendMessage writes updatedAt, project and priced — to disk AND to the wire');
  let firstId;
  {
    const t0 = Date.now();
    const r = await sendMessage('alpha', null, 'What is foo?', { provider: 'anthropic' });
    firstId = r.conversationId;
    const conv = await readConversation('alpha', firstId);
    const msg = conv.messages.filter(m => m.role === 'assistant').pop();
    ok(typeof conv.updatedAt === 'string' && Date.parse(conv.updatedAt) >= t0 - 5,
      'a completed first turn writes conversation.updatedAt');
    ok(Date.parse(conv.updatedAt) >= Date.parse(conv.createdAt), '…no earlier than createdAt');
    ok(Object.prototype.hasOwnProperty.call(msg, 'project') && msg.project === null,
      'no project pinned ⇒ the answer records project: null');
    ok(msg.priced && msg.priced.free === false && msg.priced.costUsd > 0, 'the answer records what it cost');
    eq(JSON.stringify(r.priced), JSON.stringify(msg.priced),
      'the live result carries the SAME priced record as the file (one figure, two surfaces)');
    eq(r.project, null, 'the live result carries project: null');
    eq(r.updatedAt, conv.updatedAt, 'the live result carries the new updatedAt');
    eq(msg.priced.inPerM, llm.getModelPrice(msg.model).input, 'priced is for the SERVED model (msg.model)');

    // Second turn: createdAt stays, updatedAt moves.
    const createdBefore = conv.createdAt;
    const updatedBefore = conv.updatedAt;
    await new Promise(res => setTimeout(res, 15));
    const r2 = await sendMessage('alpha', firstId, 'And again, with a project', {
      provider: 'anthropic', project: 'curator', getProjectContext: projectStore('curator'),
    });
    const conv2 = await readConversation('alpha', firstId);
    const msg2 = conv2.messages.filter(m => m.role === 'assistant').pop();
    eq(conv2.createdAt, createdBefore, 'a later turn never touches createdAt');
    ok(Date.parse(conv2.updatedAt) > Date.parse(updatedBefore), 'a later turn MOVES updatedAt forward');
    eq(msg2.project, 'curator', 'a pinned project is recorded on that turn\'s answer, by name');
    eq(r2.project, 'curator', '…and returned live');
    eq(conv2.messages.filter(m => m.role === 'assistant')[0].project, null,
      'the EARLIER answer keeps its own record (null) — nothing is rewritten');

    // A turn that THROWS persists nothing — including no updatedAt.
    const p = path.join(DOMAINS, 'alpha', 'conversations', `${firstId}.json`);
    const before = sha(readFileSync(p));
    providerBehaviour = 'throw';
    let threw = false;
    try { await sendMessage('alpha', firstId, 'this one fails', { provider: 'anthropic' }); } catch { threw = true; }
    providerBehaviour = 'answer';
    ok(threw, 'precondition: the provider failure surfaced');
    eq(sha(readFileSync(p)), before, 'a failed turn leaves the file byte-identical — updatedAt does not move');
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('§4 — listConversations: domain, updatedAt, lastProject; absent when never recorded');
  {
    // An OLDER conversation (pre-v3.72 shape): no updatedAt, no project keys.
    writeConv('alpha', {
      id: uuidN(1), title: 'Old thread', createdAt: '2026-01-01T00:00:00.000Z', domain: 'alpha',
      messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', citations: [] }],
    });
    // Created long ago, used recently, and it claims a different domain in-file.
    writeConv('alpha', {
      id: uuidN(2), title: 'Revived', createdAt: '2025-06-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z',
      domain: 'beta',
      messages: [
        { role: 'user', content: 'q' }, { role: 'assistant', content: 'a', citations: [], project: 'older-proj' },
        { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2', citations: [] },
      ],
    });
    // Malformed facts from a synced/hand-edited file.
    writeConv('alpha', {
      id: uuidN(3), title: 'Malformed', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: 'not-a-date',
      messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', project: 'x'.repeat(65) }],
    });
    writeConv('alpha', {
      id: uuidN(4), title: 'Null project', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z',
      messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', project: null }],
    });

    const rows = await listConversations('alpha');
    const by = Object.fromEntries(rows.map(r => [r.id, r]));
    ok(rows.every(r => r.domain === 'alpha'), 'every row carries its domain');
    eq(by[uuidN(2)].domain, 'alpha', 'domain comes from the STORAGE PATH, never the file\'s own `domain` key');
    ok(!('updatedAt' in by[uuidN(1)]), 'an older conversation has NO updatedAt — never a copy of createdAt');
    ok(!('lastProject' in by[uuidN(1)]), 'an older conversation has NO lastProject — never a guess');
    eq(by[uuidN(2)].updatedAt, '2099-01-01T00:00:00.000Z', 'a recorded updatedAt is carried');
    ok(!('lastProject' in by[uuidN(2)]),
      'only the LAST answer counts: an earlier answer\'s project is not promoted when the last one predates the record');
    ok(!('updatedAt' in by[uuidN(3)]), 'an unparseable updatedAt is dropped, not carried as a timestamp');
    ok(!('lastProject' in by[uuidN(3)]), 'an over-long project name is dropped from the wire');
    ok(Object.prototype.hasOwnProperty.call(by[uuidN(4)], 'lastProject') && by[uuidN(4)].lastProject === null,
      'a recorded "no project" reaches the row as null');
    eq(by[firstId].lastProject, 'curator', 'the conversation sendMessage wrote reports its last turn\'s project');

    eq(rows[0].id, uuidN(2),
      'SORT: last use wins — a thread started in 2025 but used most recently is FIRST');
    const keys = rows.map(r => Date.parse(r.updatedAt || r.createdAt) || -Infinity);
    ok(keys.every((k, i) => i === 0 || keys[i - 1] >= k), 'SORT: rows are in non-increasing updatedAt ?? createdAt order');
    eq(rows[rows.length - 1].id, uuidN(1), 'SORT: the oldest untouched thread is last');
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('§5 — listAllConversations: every non-mirror domain; unreadable is NAMED');
  {
    writeConv('beta', {
      id: uuidN(10), title: 'Beta thread about zebras', createdAt: '2026-05-01T00:00:00.000Z',
      messages: [{ role: 'user', content: 'zebra question' }],
    });
    writeConv('beta', {
      id: 'not-a-uuid', title: 'Hand-made file', createdAt: '2026-05-02T00:00:00.000Z', messages: [],
    });
    // A conversation that arrived in a mirror by sync. It is not the user's.
    writeConv('shared-mirror', {
      id: uuidN(20), title: 'Mirror thread zebra', createdAt: '2099-05-01T00:00:00.000Z', messages: [],
    });

    const all = await listAllConversations({});
    const ids = all.conversations.map(c => c.id);
    ok(ids.includes(uuidN(10)) && ids.includes(uuidN(2)), 'rows from BOTH ordinary domains are present');
    ok(!ids.includes(uuidN(20)), 'a read-only (mirror) domain\'s conversations are NOT listed');
    ok(all.conversations.every(c => c.domain === 'alpha' || c.domain === 'beta'), 'every row names its own domain');
    const keys = all.conversations.map(c => Date.parse(c.updatedAt || c.createdAt) || -Infinity);
    ok(keys.every((k, i) => i === 0 || keys[i - 1] >= k), 'the merged list is sorted across domains');
    eq(all.unreadable.length, 0, 'nothing unreadable in the healthy fixture');

    const zebra = await listAllConversations({ q: 'ZEBRA' });
    eq(JSON.stringify(zebra.conversations.map(c => c.id)), JSON.stringify([uuidN(10)]),
      'q searches every domain (case-insensitive) — and still never a mirror');

    // A domain whose conversations "folder" is a FILE: ENOTDIR, not ENOENT.
    makeDomain('gamma', { page: false });
    rmSync(path.join(DOMAINS, 'gamma', 'conversations'), { recursive: true });
    writeFileSync(path.join(DOMAINS, 'gamma', 'conversations'), 'not a directory');
    const withBad = await listAllConversations({});
    eq(JSON.stringify(withBad.unreadable), '["gamma"]',
      'a domain that could not be read is NAMED — "we could not look" is never served as "there is nothing"');
    ok(withBad.conversations.length === all.conversations.length, '…and the readable domains still list');
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('§6 — GET /api/chat over a real express server');
  {
    const app = express();
    app.use(express.json());
    app.use('/api/chat', chatRouter);
    const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/chat`;
    const get = async (qs) => { const r = await fetch(base + qs); return { status: r.status, body: await r.json() }; };
    try {
      const r = await get('');
      eq(r.status, 200, 'GET /api/chat answers 200');
      const expectTotal = (await listAllConversations({})).conversations.filter(c => /^[0-9a-f-]{36}$/i.test(c.id)).length;
      eq(r.body.total, expectTotal, 'total is the TRUE count of openable rows across domains');
      ok(!r.body.conversations.some(c => c.id === 'not-a-uuid'),
        'a row whose id is not a UUID is dropped — every other route would refuse to open it');
      ok(!r.body.conversations.some(c => c.id === uuidN(20)), 'no mirror rows on the wire');
      eq(JSON.stringify(r.body.unreadable), '["gamma"]', 'unreadable domains reach the wire by name');
      eq(r.body.limit, 200, 'default limit 200');
      eq(r.body.offset, 0, 'default offset 0');
      ok(r.body.conversations.every(c => typeof c.domain === 'string'), 'every row on the wire carries domain');
      const row2 = r.body.conversations.find(c => c.id === uuidN(2));
      ok(row2 && row2.updatedAt === '2099-01-01T00:00:00.000Z', 'updatedAt reaches the wire');
      const rowFirst = r.body.conversations.find(c => c.id === firstId);
      eq(rowFirst && rowFirst.lastProject, 'curator', 'lastProject reaches the wire');

      const p1 = await get('?limit=2&offset=0');
      const p2 = await get('?limit=2&offset=2');
      eq(p1.body.conversations.length, 2, 'limit=2 returns two rows');
      eq(p1.body.total, expectTotal, '…with the full total beside them');
      eq(JSON.stringify(p2.body.conversations.map(c => c.id)),
        JSON.stringify(r.body.conversations.slice(2, 4).map(c => c.id)), 'offset pages through the same order');
      eq((await get('?limit=99999')).body.limit, 500, 'a limit above the cap is clamped to 500 (and says so)');
      for (const bad of ['?limit=0', '?limit=abc', '?limit=-1', '?limit=1.5', '?limit=1&limit=2', '?offset=x', '?offset=-3']) {
        eq((await get(bad)).status, 400, `a malformed page parameter (${bad}) is a 400, never a guessed page`);
      }
      const z = await get('?q=zebra');
      eq(JSON.stringify(z.body.conversations.map(c => c.id)), JSON.stringify([uuidN(10)]), '?q= filters across domains');
      eq(z.body.total, 1, '…and total counts the filtered set');
      eq((await get('?q=a&q=b')).status, 200, '?q=a&q=b (an array) is no filter, never a 500');
      // The per-domain route is unchanged in shape and gains the same row facts.
      const one = await get('/alpha');
      ok(Array.isArray(one.body.conversations) && !('total' in one.body), 'GET /api/chat/:domain keeps its old envelope');
      ok(one.body.conversations.every(c => c.domain === 'alpha'), '…and its rows carry domain too');
    } finally {
      await new Promise(res => server.close(res));
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('§7 — Compile estimate: the fallback rung (F5) and no false "exact" (F6)');
  {
    const rungsFor = llm.__testing && llm.__testing.fallbackRungsFor;
    ok(typeof rungsFor === 'function',
      'llm.js\'s fallbackRungsFor is reachable (compile-estimate reads the rung list there — a rename must red HERE)');
    for (const provider of ['gemini', 'anthropic', 'openrouter']) {
      const head = llm.__testing.DEFAULTS[provider];
      const expected = rungsFor(provider, head).find(r => r !== head) || null;
      const got = est.compileFallbackRung(provider, head);
      eq(got ? got.model : null, expected, `${provider}: the named rung is llm.js's first rung after "${head}"`);
      if (got) {
        const pr = llm.getModelPrice(got.model);
        eq(got.inPerM, pr ? pr.input : null, `${provider}: the rung's input rate is its catalogue price`);
        eq(got.outPerM, pr ? pr.output : null, `${provider}: the rung's output rate is its catalogue price`);
      }
    }
    const freeId = [...llm.__testing.FREE_MODELS][0];
    eq(est.compileFallbackRung('openrouter', freeId), null,
      'a FREE head names no paid rung — the free-head rule is llm.js\'s, not re-derived');
    const self = llm.__testing.FALLBACK_CHAINS.anthropic[0];
    ok(est.compileFallbackRung('anthropic', self)?.model !== self,
      'a head that is itself a rung never names itself as its own fallback');
    eq(est.compileFallbackRung('', 'x'), null, 'no provider ⇒ null');

    // Through the real estimator.
    writeConv('alpha', {
      id: uuidN(30), title: 'Compile me', createdAt: '2026-04-01T00:00:00.000Z',
      messages: [{ role: 'user', content: 'What is foo?' }, { role: 'assistant', content: 'Foo is a thing.', citations: [] }],
    });
    const e = await est.estimateCompileCost('alpha', uuidN(30));
    ok(e.compilable === true, 'precondition: the conversation is compilable');
    const fb = e.estimate && e.estimate.fallback;
    const expected = rungsFor(e.provider, e.model).find(r => r !== e.model);
    eq(fb && fb.model, expected, 'estimate.fallback names the rung a walk from the configured model would bill');
    ok(fb && e.estimate.basis.includes(`falls back to "${fb.model}"`), 'the basis says so in words');
    ok(fb && e.estimate.basis.includes(`$${fb.inPerM} / $${fb.outPerM}`), '…with the rung\'s own prices');
    ok(!/input half is exact/i.test(e.estimate.basis) && !/not a formula/i.test(e.estimate.basis),
      'F6: the basis never calls the input TOKEN figure exact or "not a formula"');
    ok(/measured exactly in characters/.test(e.estimate.basis) && /estimated from that length \(±15%\)/.test(e.estimate.basis),
      'F6: it says what IS exact (characters) and what is estimated (tokens, ±15%)');
  }
}

try {
  await main();
} catch (err) {
  failed++;
  console.log(`  ✗ the suite threw: ${err && err.stack}`);
} finally {
  __setDomainsDirOverride(null);
  llm.__setAnthropicClientFactory(null);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  delete process.env.CURATOR_TEST_USER_DATA_DIR;
  delete process.env.CURATOR_TEST_DOMAINS_DIR;
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
