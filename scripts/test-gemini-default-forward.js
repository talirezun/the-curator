#!/usr/bin/env node
/**
 * test-gemini-default-forward.js — OFFLINE. The Gemini default moves FORWARD
 * from gemini-2.5-flash-lite to gemini-3.5-flash-lite, and every label names the
 * model that ANSWERS (2026-11-07).
 *
 * The facts below were measured once on 2026-11-07 and are typed here, never
 * read back from llm.js: on a new paid key both gemini-2.5-flash-lite and
 * gemini-2.5-flash answered 404 "no longer available to new users", so a new
 * user on the 2.5 default was served by gemini-3.1-flash-lite at its price while
 * the app named 2.5. Prices per 1M tokens, from Google's pricing page:
 * 2.5 Flash Lite $0.10/$0.40, 3.5 Flash Lite $0.30/$2.50, 3.1 Flash Lite
 * $0.25/$1.50. Facts captured (judge A): Haiku 5.5 88%, 3.5 Lite 39%,
 * 3.1 Lite 28%; per source $0.020 / $0.033 / $0.026.
 *
 * No network: the only provider "call" goes through the Anthropic client seam.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpUD = mkdtempSync(path.join(os.tmpdir(), 'curator-gemini-forward-'));
process.env.CURATOR_TEST_USER_DATA_DIR = tmpUD;
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(tmpUD, 'domains');
mkdirSync(path.join(tmpUD, 'domains', 'probe', 'wiki'), { recursive: true });
mkdirSync(path.join(tmpUD, 'domains', 'probe', 'raw'), { recursive: true });
writeFileSync(path.join(tmpUD, 'domains', 'probe', 'CLAUDE.md'), '# probe\n');
writeFileSync(path.join(tmpUD, 'domains', 'probe', 'wiki', 'index.md'), '# Index\n');
for (const k of ['LLM_MODEL', 'LLM_PROVIDER', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[k];

let failed = 0;
let passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.log(`  ✗ ${m}`); } };

const llm = await import('../src/brain/llm.js');
const config = await import('../src/brain/config.js');
const { describeRun } = await import('../src/brain/ai-run.js');
const { estimateIngestQueueCost } = await import('../src/brain/ingest-queue.js');
const { makeUsageAccumulator } = await import('../src/brain/ingest.js');
const { FALLBACK_CHAINS } = llm.__testing;

const OLD_LITE = 'gemini-2.5-flash-lite';
const OLD_FLASH = 'gemini-2.5-flash';
const NEW_LITE = 'gemini-3.5-flash-lite';
const MEASURED = { [NEW_LITE]: { input: 0.30, output: 2.50 }, 'gemini-3.1-flash-lite': { input: 0.25, output: 1.50 } };
const cfgFile = path.join(tmpUD, '.curator-config.json');
const useConfig = (c) => writeFileSync(cfgFile, JSON.stringify(c));
const FAKE_G = 'fixture-gemini-key-placeholder';
const FAKE_A = 'fixture-anthropic-key-placeholder';

console.log('test-gemini-default-forward.js\n');

console.log('§1 a new Gemini user resolves to 3.5 Flash Lite — asserted on the RESOLVED model');
useConfig({ geminiApiKey: FAKE_G, activeProvider: 'gemini' });
const info = llm.getProviderInfo();
ok(info.provider === 'gemini', 'fixture: Gemini is the resolved provider');
ok(info.model === NEW_LITE, `the resolved build model is ${NEW_LITE} (got ${info.model})`);
ok(llm.isBuildLaneModel('gemini', NEW_LITE), 'and it may build a wiki');
const p = llm.getModelPrice(NEW_LITE);
ok(p && p.input === MEASURED[NEW_LITE].input && p.output === MEASURED[NEW_LITE].output, 'and it is priced at $0.30/$2.50');

console.log('§2 the 404ing 2.5 ids are retired: not offered, not priced, not walked to');
for (const id of [OLD_LITE, OLD_FLASH]) {
  ok(!llm.isOfferableModel('gemini', id), `${id} is not offered`);
  ok(llm.getModelPrice(id) === null, `${id} carries no price`);
  ok(!FALLBACK_CHAINS.gemini.includes(id), `${id} is not a fallback rung`);
  ok(Object.hasOwn(llm.RETIRED_MODELS, id), `${id} is in RETIRED_MODELS`);
}

console.log('§3 the chain escalates FORWARD from the default, every rung priced and build-lane');
const chain = FALLBACK_CHAINS.gemini;
ok(chain.length >= 1, 'the chain is not empty');
ok(!chain.includes(NEW_LITE), 'it does not repeat the default');
ok(!chain.includes('gemini-3.1-flash-lite'), 'the OLDER 3.1 Lite is not a rung (it silently served 2.5 users)');
const gen = (id) => Number((/gemini-(\d+\.\d+)/.exec(id) || [])[1]);
for (const id of chain) {
  ok(!!llm.getModelPrice(id), `${id} is priced`);
  ok(llm.isBuildLaneModel('gemini', id), `${id} may build a wiki`);
  ok(gen(id) > gen(NEW_LITE), `${id} is a NEWER generation than the default`);
}

console.log('§4 a stored 2.5 pick moves forward, with a note that names the price');
useConfig({ geminiApiKey: FAKE_G, activeProvider: 'gemini', selectedModels: { gemini: OLD_LITE } });
ok(llm.getProviderInfo().model === NEW_LITE, 'READ side: before any rewrite, a 2.5 Lite pick resolves to 3.5 Lite');
let notes = llm.migrateRetiredModelSelections(new Date('2026-11-07T12:00:00Z'));
ok(notes.length === 1 && notes[0].from === OLD_LITE && notes[0].to === NEW_LITE, 'WRITE side: one migration, 2.5 Lite → 3.5 Lite');
ok(config.getSelectedModel('gemini') === NEW_LITE, 'the stored pick names the successor');
ok(/Flash Lite 2\.5/.test(notes[0].text) && /Flash Lite 3\.5/.test(notes[0].text), 'the note names both models');
ok(notes[0].text.includes('$0.30') && notes[0].text.includes('$2.50') && notes[0].text.includes('$0.10') && notes[0].text.includes('$0.40'),
  'the note states the new AND the old price — no silent price change');
ok(config.getModelMigrationNotes().length === 1, 'the note is persisted for the app to show');
ok(llm.migrateRetiredModelSelections().length === 0, 'idempotent: a second run changes nothing');

useConfig({ geminiApiKey: FAKE_G, activeProvider: 'gemini', selectedModels: { gemini: OLD_FLASH } });
notes = llm.migrateRetiredModelSelections();
ok(notes.length === 1 && notes[0].to === NEW_LITE, 'a 2.5 Flash pick moves forward to the provider default, 3.5 Lite (the withdrawn-model rule)');
ok(notes[0].text.includes('$0.30') && notes[0].text.includes('$2.50') && /costs the same/.test(notes[0].text),
  'and its note says the price is the same, $0.30/$2.50');
ok(notes[0].text.includes('Flash 3.7'), 'and names the newer full Flash model for anyone who wants it');

console.log('§5 a user on the DEFAULT (no stored pick) is told once; nobody without a key is');
useConfig({ geminiApiKey: FAKE_G, activeProvider: 'gemini' });
notes = llm.migrateRetiredModelSelections();
ok(notes.length === 1 && notes[0].from === OLD_LITE && notes[0].to === NEW_LITE, 'one note for the default user');
ok(notes[0].text.includes('$0.30') && notes[0].text.includes('$0.10'), 'it names the new and the old price');
ok(config.getSelectedModel('gemini') === null, 'and it does NOT pin them: they still follow the default');
ok(llm.migrateRetiredModelSelections().length === 0, 'never repeated after it was recorded');
useConfig({ anthropicApiKey: FAKE_A, activeProvider: 'anthropic' });
ok(llm.migrateRetiredModelSelections().length === 0, 'a user with no Gemini key gets no Gemini note');

console.log('§6 after a fallback walk, labels and estimates name the model that ANSWERED');
useConfig({ anthropicApiKey: FAKE_A, activeProvider: 'anthropic' });
const asked = llm.getProviderInfo().model;
llm.__setAnthropicClientFactory(() => ({ messages: {
  stream(body) {
    if (body.model === asked) { const e = new Error(`404 model not found: ${body.model}`); e.status = 404; throw e; }
    return { finalMessage: async () => ({ stop_reason: 'end_turn', model: body.model,
      usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'text', text: 'ok' }] }) };
  },
  create(body) { return this.stream(body).finalMessage(); },
} }));
try {
  const acc = makeUsageAccumulator();
  await llm.generateText('sys', 'user', 64, 'text', null, { onUsage: acc.onUsage });
  const ran = acc.totals.model;
  ok(ran && ran !== asked, `fixture: the chain walked (asked ${asked}, answered ${ran})`);
  ok(llm.answeringModel('anthropic', asked) === ran, 'answeringModel names the rung that answered');
  const d = describeRun({ job: 'ingest' });
  ok(d.model === ran, `the run line names ${ran}, not ${asked} (got ${d.model})`);
  ok(d.answeringFor === asked, 'and says which model it is answering for');
  const est = await estimateIngestQueueCost('probe', [{ name: 'a.md', size: 4000 }]);
  ok(est.model === ran, `the batch estimate prices and labels ${ran} (got ${est.model})`);
} finally {
  llm.__setAnthropicClientFactory(null);
}
ok(llm.answeringModel('gemini', NEW_LITE) === NEW_LITE, 'with no walk on a provider, the configured model is named');

rmSync(tmpUD, { recursive: true, force: true });
console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed ? 1 : 0);
