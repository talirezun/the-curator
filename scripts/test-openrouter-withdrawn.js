#!/usr/bin/env node
/**
 * test-openrouter-withdrawn.js — OFFLINE. A model OpenRouter stopped serving leaves the
 * catalogue and the chain, and a stored pick of it moves FORWARD (2026-11-07).
 *
 * The facts below were read once from OpenRouter's free metadata endpoints on 2026-11-07
 * (GET /api/v1/models, GET /api/v1/models/<id>/endpoints) and typed here, never read back
 * from llm.js. Granite 4.0 H Micro: not in the list, 0 endpoints. Prices are what a cold
 * call BILLED (usage.cost), to the last digit: Solar 472 in + 6 out = 0.0000744,
 * GLM 246 in + 199 out = 0.00005514.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpUD = mkdtempSync(path.join(os.tmpdir(), 'curator-withdrawn-'));
process.env.CURATOR_TEST_USER_DATA_DIR = tmpUD;
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(tmpUD, 'domains');
delete process.env.LLM_MODEL;
delete process.env.LLM_PROVIDER;
delete process.env.OPENROUTER_API_KEY;

let failed = 0;
let passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.log(`  ✗ ${m}`); } };

const llm = await import('../src/brain/llm.js');
const config = await import('../src/brain/config.js');
const { FALLBACK_CHAINS, DEFAULTS } = llm.__testing;

const GRANITE = 'ibm-granite/granite-4.0-h-micro';
const LIVE_2026_11_07 = {
  'upstage/solar-pro4': { endpoints: 2, input: 0.15, output: 0.60 },
  'z-ai/glm-5.3-flash': { endpoints: 42, input: 0.03, output: 0.24 },
  'moonshotai/kimi-k2-0905': { endpoints: 1, input: 0.60, output: 2.50 },
};

console.log('test-openrouter-withdrawn.js\n');

console.log('§1 the withdrawn id is gone everywhere it could be picked or walked to');
ok(!llm.isOfferableModel('openrouter', GRANITE), 'Granite is not offered');
ok(llm.getModelPrice(GRANITE) === null, 'and carries no price');
ok(!FALLBACK_CHAINS.openrouter.includes(GRANITE), 'and is not a fallback rung');
ok(DEFAULTS.openrouter !== GRANITE, 'and is not the default');
ok(Object.keys(llm.STATIC_ELIGIBILITY_EXEMPTIONS).length === 0, 'and its context-floor waiver went with it');

console.log('§2 every OpenRouter model offered is really served, at the price it bills');
const offered = llm.OFFERABLE_MODELS.openrouter.map((m) => m.id);
ok(offered.length === Object.keys(LIVE_2026_11_07).length && offered.every((id) => LIVE_2026_11_07[id]?.endpoints > 0),
  `the ${offered.length} offered ids are exactly the ones with live endpoints`);
for (const id of offered) {
  const p = llm.getModelPrice(id);
  ok(p && p.input === LIVE_2026_11_07[id].input && p.output === LIVE_2026_11_07[id].output,
    `${id} is quoted at its billed $${LIVE_2026_11_07[id].input}/$${LIVE_2026_11_07[id].output}`);
}

console.log('§3 the chain still has a working, priced, measured rung that does not repeat the default');
const chain = FALLBACK_CHAINS.openrouter;
ok(chain.length >= 1, 'the chain is not empty');
for (const id of chain) {
  ok(LIVE_2026_11_07[id]?.endpoints > 0, `${id} has live endpoints`);
  ok(!!llm.getModelPrice(id), `${id} is priced`);
  ok(llm.isBuildLaneModel('openrouter', id), `${id} has been measured building a wiki`);
  ok(id !== DEFAULTS.openrouter, `${id} is not the default it backs up`);
  const a = llm.getModelPrice(id);
  const b = llm.getModelPrice(DEFAULTS.openrouter);
  ok(a.input <= b.input && a.output <= b.output, `${id} cannot cost more than the default it backs up`);
}

console.log('§4 a stored pick moves forward, and the note says why and what it costs');
const cfgFile = path.join(tmpUD, '.curator-config.json');
writeFileSync(cfgFile, JSON.stringify({
  openrouterApiKey: 'fixture-openrouter-key-placeholder', activeProvider: 'openrouter',
  selectedModels: { openrouter: GRANITE },
}));
ok(llm.getProviderInfo().provider === 'openrouter', 'fixture: OpenRouter is the resolved provider');
ok(llm.getProviderInfo().model === DEFAULTS.openrouter, 'READ side: before any rewrite, the pick resolves to Solar Pro 4');
const notes = llm.migrateRetiredModelSelections(new Date('2026-11-07T12:00:00Z'));
ok(notes.length === 1 && notes[0].from === GRANITE && notes[0].to === 'upstage/solar-pro4', 'WRITE side: one migration');
ok(config.getSelectedModel('openrouter') === 'upstage/solar-pro4', 'the stored pick names the successor');
ok(/no longer serves/.test(notes[0].text), 'the note gives the real reason');
ok(!/Anthropic/.test(notes[0].text), '…and not the Anthropic generation rule, which is not why');
ok(/costs more/.test(notes[0].text) && /\$0\.017/.test(notes[0].text), '…and says the successor costs more');
ok(llm.migrateRetiredModelSelections().length === 0, 'idempotent');

rmSync(tmpUD, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ Withdrawn OpenRouter model handled');
