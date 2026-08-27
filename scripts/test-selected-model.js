/**
 * test-selected-model.js — OFFLINE suite for the PERSISTED per-provider model
 * choice (Settings → model picker).
 *
 * WHY THIS SUITE EXISTS, stated plainly: resolveProviderDefault() decides which
 * model EVERY ingest, EVERY Health AI scan, EVERY compile and EVERY chat runs
 * on. A defect here does not present as a broken button — it presents as the
 * user's whole wiki being built by a model they did not choose, or being billed
 * at many times what they expected. So the assertions below are about MONEY and
 * about a stored value outliving the thing it names, not about a getter
 * round-tripping.
 *
 * THE LOAD-BEARING ASSERTION is §2: with NOTHING stored, resolveProviderDefault
 * is byte-identical to its pre-change behaviour. That is what protects every
 * existing user, and it is asserted explicitly rather than left implied.
 *
 * Deterministic + free. Every config read/write in here is redirected into a
 * throwaway tempdir via CURATOR_TEST_USER_DATA_DIR in a SPAWNED child, so this
 * suite can never read or write the developer's real .curator-config.json
 * (which holds live API keys). The in-process half never writes at all.
 *
 * Model ids are enumerated from the REAL OFFERABLE_MODELS table, never
 * hardcoded — a hardcoded list is how guards in this repo have gone blind when
 * the thing they guard moved underneath them.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { OFFERABLE_MODELS, isOfferableModel } from '../src/brain/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CONFIG_JS = path.join(ROOT, 'src/brain/config.js');
const LLM_JS    = path.join(ROOT, 'src/brain/llm.js');
const ROUTE_JS  = path.join(ROOT, 'src/routes/config.js');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function section(t) { console.log(`\n${t}`); }

const tmpBase = mkdtempSync(path.join(os.tmpdir(), 'curator-selmodel-'));
process.on('exit', () => { try { rmSync(tmpBase, { recursive: true, force: true }); } catch {} });

// ── Enumerated from the REAL table, never hardcoded ──────────────────────────
const DEFAULT_MODEL = {
  gemini:    OFFERABLE_MODELS.gemini[0].id,      // cheapest-first ⇒ head IS the default
  anthropic: OFFERABLE_MODELS.anthropic[0].id,
};
// A non-default but legitimately offerable id per provider — the realistic
// "user upgraded on their own key" case.
const UPGRADE_MODEL = {
  gemini:    OFFERABLE_MODELS.gemini[1].id,
  anthropic: OFFERABLE_MODELS.anthropic[1].id,
};
const PROVIDERS = ['gemini', 'anthropic'];

/**
 * Drive the REAL config.js + llm.js in a spawned child whose user-data dir is a
 * throwaway tempdir. `setup` runs first (seeds the config file), then `probe`
 * returns a JSON-serialisable result.
 *
 * A child process, not an in-process override, because this exercises the
 * WRITE path: config.js must never be pointed at the developer's real file, and
 * the env seam is checked before repo/bundle detection so it cannot lose to a
 * configured domainsPath.
 */
let probeSeq = 0;
function probe(configObject, body, { env = {} } = {}) {
  const dir = path.join(tmpBase, `p${++probeSeq}`);
  mkdirSync(dir, { recursive: true });
  if (configObject !== null) {
    writeFileSync(path.join(dir, '.curator-config.json'),
      typeof configObject === 'string' ? configObject : JSON.stringify(configObject, null, 2),
      { mode: 0o600 });
  }
  const script = `
    import fs from 'node:fs';
    import * as cfg from ${JSON.stringify(CONFIG_JS)};
    import * as llm from ${JSON.stringify(LLM_JS)};
    let out;
    try { out = { ok: true, v: (function(){ ${body} })() }; }
    catch (e) { out = { ok: false, threw: String(e && e.message || e) }; }
    process.stdout.write('@@' + JSON.stringify(out) + '@@');
  `;
  const childEnv = { ...process.env, CURATOR_TEST_USER_DATA_DIR: dir };
  // Neutralise ambient developer overrides so the suite is machine-independent.
  delete childEnv.LLM_MODEL;
  delete childEnv.GEMINI_API_KEY;
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.DOMAINS_PATH;
  delete childEnv.CURATOR_TEST_DOMAINS_DIR;
  Object.assign(childEnv, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];

  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { env: childEnv, encoding: 'utf8' });
  const m = (r.stdout || '').match(/@@([\s\S]*)@@/);
  if (!m) return { error: (r.stderr || '(no stderr)').trim().split('\n').slice(-4).join(' | ') };
  const parsed = JSON.parse(m[1]);
  return { ...parsed, dir, stderr: r.stderr || '' };
}

const KEYED = { gemini: 'AIzaTESTTESTTESTTEST', anthropic: 'sk-ant-TESTTESTTEST' };
/** A config with a SAVED key for each named provider. */
function cfgWithKeys(providers, extra = {}) {
  const c = { ...extra };
  if (providers.includes('gemini'))    c.geminiApiKey = KEYED.gemini;
  if (providers.includes('anthropic')) c.anthropicApiKey = KEYED.anthropic;
  if (providers.length) c.activeProvider = providers[0];
  return c;
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1  Round-trip: set → get → resolveProviderDefault honours it');
// ═══════════════════════════════════════════════════════════════════════════

for (const p of PROVIDERS) {
  const want = UPGRADE_MODEL[p];
  const r = probe(cfgWithKeys([p]), `
    cfg.setSelectedModel(${JSON.stringify(p)}, ${JSON.stringify(want)});
    return {
      stored:    cfg.getSelectedModel(${JSON.stringify(p)}),
      resolved:  llm.getProviderInfo().model,
      viaDefault: llm.getDefaultModel(${JSON.stringify(p)}),
      onDisk:    JSON.parse(fs.readFileSync(process.env.CURATOR_TEST_USER_DATA_DIR + '/.curator-config.json','utf8')).selectedModels,
    };
  `);
  ok(!r.error && r.ok, `[${p}] round-trip probe ran${r.error ? `: ${r.error}` : r.threw ? `: threw ${r.threw}` : ''}`);
  if (r.ok) {
    eq(r.v.stored, want,     `[${p}] getSelectedModel returns what setSelectedModel stored`);
    eq(r.v.resolved, want,   `[${p}] resolveProviderDefault (via getProviderInfo) HONOURS the stored model`);
    eq(r.v.viaDefault, want, `[${p}] getDefaultModel reflects the stored model`);
    ok(r.v.onDisk && r.v.onDisk[p] === want, `[${p}] the choice is PERSISTED to .curator-config.json`);
  }
}

// The stored choice must be an actual change, or §1 proves nothing.
for (const p of PROVIDERS) {
  ok(UPGRADE_MODEL[p] !== DEFAULT_MODEL[p],
    `control: [${p}] the model used in §1 differs from the default (${DEFAULT_MODEL[p]}) — the round-trip is not vacuous`);
  ok(isOfferableModel(p, UPGRADE_MODEL[p]),
    `control: [${p}] that model really is offerable`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  THE LOAD-BEARING ONE — nothing stored ⇒ byte-identical to today');
// ═══════════════════════════════════════════════════════════════════════════

for (const p of PROVIDERS) {
  const r = probe(cfgWithKeys([p]), `
    return {
      stored:   cfg.getSelectedModel(${JSON.stringify(p)}),
      resolved: llm.getProviderInfo().model,
      viaDefault: llm.getDefaultModel(${JSON.stringify(p)}),
      provider: llm.getProviderInfo().provider,
    };
  `);
  ok(!r.error && r.ok, `[${p}] no-selection probe ran${r.error ? `: ${r.error}` : ''}`);
  if (r.ok) {
    eq(r.v.stored, null,                  `[${p}] nothing stored ⇒ getSelectedModel is null`);
    eq(r.v.resolved, DEFAULT_MODEL[p],    `[${p}] nothing stored ⇒ resolveProviderDefault returns DEFAULTS[${p}] — EXISTING USERS UNCHANGED`);
    eq(r.v.viaDefault, DEFAULT_MODEL[p],  `[${p}] nothing stored ⇒ getDefaultModel returns DEFAULTS[${p}]`);
    eq(r.v.provider, p,                   `[${p}] provider resolution itself is unchanged`);
  }
}

// A config with NO selectedModels key at all is the shape every existing
// install has on disk right now.
{
  const r = probe({ geminiApiKey: KEYED.gemini, anthropicApiKey: KEYED.anthropic, activeProvider: 'anthropic' }, `
    return { model: llm.getProviderInfo().model, provider: llm.getProviderInfo().provider };
  `);
  ok(r.ok && r.v.provider === 'anthropic' && r.v.model === DEFAULT_MODEL.anthropic,
    'a real-shaped legacy config (both keys, no selectedModels) resolves exactly as before');
}

// Writing nothing must not even CREATE the key — a user who never picks keeps a
// byte-identical config file.
{
  const r = probe(cfgWithKeys(['gemini']), `
    cfg.setSelectedModel('gemini', UPGRADE);
    cfg.setSelectedModel('gemini', '');
    const raw = fs.readFileSync(process.env.CURATOR_TEST_USER_DATA_DIR + '/.curator-config.json','utf8');
    return { hasKey: Object.prototype.hasOwnProperty.call(JSON.parse(raw), 'selectedModels'),
             resolved: llm.getProviderInfo().model };
  `.replace(/UPGRADE/, JSON.stringify(UPGRADE_MODEL.gemini)));
  ok(r.ok && r.v.hasKey === false, 'clearing the last selection DELETES selectedModels — no residue in the config file');
  ok(r.ok && r.v.resolved === DEFAULT_MODEL.gemini, 'after clearing, resolution returns to the provider default');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  A stored id for an UNKEYED provider is not honoured (v3.0.13)');
// ═══════════════════════════════════════════════════════════════════════════

// The realistic path: user connects Anthropic, picks a pricier model, later
// clicks Disconnect in Settings — but a stale ANTHROPIC_API_KEY still sits in
// .env, so the provider itself still resolves. The MODEL must not.
for (const p of PROVIDERS) {
  const envKey = p === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
  const r = probe(
    // selection present, but NO saved key for that provider in config
    { selectedModels: { [p]: UPGRADE_MODEL[p] }, activeProvider: p },
    `return { resolved: llm.getProviderInfo().model, provider: llm.getProviderInfo().provider,
              stored: cfg.getSelectedModel(${JSON.stringify(p)}) };`,
    { env: { [envKey]: 'env-only-stale-key' } }
  );
  ok(!r.error && r.ok, `[${p}] disconnected-provider probe ran${r.error ? `: ${r.error}` : ''}`);
  if (r.ok) {
    eq(r.v.provider, p, `[${p}] control: the provider DOES still resolve off the .env key (so the test reaches the model gate)`);
    eq(r.v.resolved, DEFAULT_MODEL[p],
      `[${p}] a stored model for a Disconnected provider is IGNORED — falls back to the cheapest default`);
    eq(r.v.stored, UPGRADE_MODEL[p],
      `[${p}] control: the value is still on disk — it is the KEY GATE refusing it, not a missing value`);
  }
}

// Both directions: with the key SAVED IN CONFIG, the very same stored value IS
// honoured. Without this pair the §3 green could just mean "never honoured".
for (const p of PROVIDERS) {
  const r = probe(cfgWithKeys([p], { selectedModels: { [p]: UPGRADE_MODEL[p] } }),
    `return llm.getProviderInfo().model;`);
  eq(r.ok && r.v, UPGRADE_MODEL[p],
    `[${p}] control (other direction): with the key SAVED, that identical stored value IS honoured`);
}

// The gate must read CONFIG keys, not effective keys — pinned behaviourally
// above, and structurally here so the reason survives a refactor.
{
  const src = readFileSync(LLM_JS, 'utf8');
  const fn = src.slice(src.indexOf('function storedSelection'), src.indexOf('function defaultModelFor'));
  ok(/getApiKeys\(\)/.test(fn), 'storedSelection() gates on getApiKeys() (config-only)');
  ok(!/getEffectiveKey/.test(fn), 'storedSelection() does NOT use getEffectiveKey (.env would defeat Disconnect)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  A stored NON-OFFERABLE id falls back — never honoured, never throws');
// ═══════════════════════════════════════════════════════════════════════════

// Every way a stored id stops being valid: retired by the provider, pulled by
// us after a bad probe, cross-provider paste, or plain nonsense.
const STALE = [
  ['a model id we removed from the catalogue', 'claude-3-5-haiku-latest'],
  ['a totally unknown id',                     'gpt-5-turbo'],
  ['empty-ish whitespace',                     '   '],
];
for (const p of PROVIDERS) {
  // A REAL id belonging to the OTHER provider — the most plausible mistake, and
  // enumerated from the live table rather than typed in.
  const other = p === 'gemini' ? 'anthropic' : 'gemini';
  const cases = [...STALE, [`a real ${other} id stored under ${p}`, UPGRADE_MODEL[other]]];
  for (const [label, bad] of cases) {
    ok(!isOfferableModel(p, bad), `control: [${p}] "${label}" really is not offerable`);
    const r = probe(cfgWithKeys([p], { selectedModels: { [p]: bad } }),
      `return { model: llm.getProviderInfo().model, provider: llm.getProviderInfo().provider };`);
    ok(!r.error && r.ok, `[${p}] stale probe ran (${label})${r.threw ? ` — THREW: ${r.threw}` : ''}`);
    if (r.ok) {
      eq(r.v.model, DEFAULT_MODEL[p],
        `[${p}] stale stored id (${label}) ⇒ falls back to the CHEAPEST default, does not throw`);
    }
  }
}

// The refusal must be visible to an operator, on stderr (llm.js is imported by
// the MCP child, which reserves stdout for JSON-RPC frames).
{
  const r = probe(cfgWithKeys(['gemini'], { selectedModels: { gemini: 'gpt-5-turbo' } }),
    `return llm.getProviderInfo().model;`);
  ok(/Refusing model/.test(r.stderr || ''), 'a refused stored model is LOGGED (operator can see why they are on the default)');
  ok(!/@@/.test((r.stderr || '').replace(/Refusing model[\s\S]*/, '')), 'control: the refusal log did not land on stdout');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  Prototype keys — as the provider AND as the model');
// ═══════════════════════════════════════════════════════════════════════════

const PROTO = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];

for (const bad of PROTO) {
  const r = probe(cfgWithKeys(['gemini']), `
    const got = cfg.getSelectedModel(${JSON.stringify(bad)});
    const set = cfg.setSelectedModel(${JSON.stringify(bad)}, 'anything');
    return {
      got: got === null ? 'null' : typeof got,
      set: set === null ? 'null' : typeof set,
      offerable: llm.isOfferableModel(${JSON.stringify(bad)}, 'x'),
      offerableAsModel: llm.isOfferableModel('gemini', ${JSON.stringify(bad)}),
      // the write must not have created anything
      onDisk: JSON.parse(fs.readFileSync(process.env.CURATOR_TEST_USER_DATA_DIR + '/.curator-config.json','utf8')).selectedModels ?? null,
      resolved: llm.getProviderInfo().model,
    };
  `);
  ok(!r.error && r.ok, `"${bad}" probe ran${r.threw ? ` — THREW: ${r.threw}` : ''}`);
  if (r.ok) {
    eq(r.v.got, 'null', `getSelectedModel("${bad}") returns null — no Object.prototype member leaks out`);
    eq(r.v.set, 'null', `setSelectedModel("${bad}", …) is refused`);
    eq(r.v.offerable, false, `isOfferableModel("${bad}", …) is false`);
    eq(r.v.offerableAsModel, false, `isOfferableModel("gemini", "${bad}") is false`);
    eq(r.v.onDisk, null, `"${bad}" as a provider wrote NOTHING to the config`);
    eq(r.v.resolved, DEFAULT_MODEL.gemini, `resolution is unaffected by the "${bad}" attempt`);
  }
}

// A config file whose selectedModels carries a __proto__ entry. JSON.parse
// materialises this as an OWN data property, so it is reachable — the sanitiser
// must drop it, and it must not poison the map returned to callers.
{
  const poisoned = `{
    "geminiApiKey": ${JSON.stringify(KEYED.gemini)},
    "activeProvider": "gemini",
    "selectedModels": { "__proto__": { "gemini": "gpt-5-turbo" }, "constructor": "x" }
  }`;
  const r = probe(poisoned, `
    return {
      gem: cfg.getSelectedModel('gemini'),
      resolved: llm.getProviderInfo().model,
      polluted: ({}).gemini ?? null,
    };
  `);
  ok(!r.error && r.ok, `poisoned-config probe ran${r.threw ? ` — THREW: ${r.threw}` : ''}`);
  if (r.ok) {
    eq(r.v.gem, null, 'a __proto__-carrying selectedModels yields NO selection');
    eq(r.v.resolved, DEFAULT_MODEL.gemini, 'a poisoned config still resolves to the safe default');
    eq(r.v.polluted, null, 'Object.prototype was not polluted');
  }
}

// A later legitimate write must SCRUB the junk rather than carry it forward.
{
  const poisoned = `{
    "geminiApiKey": ${JSON.stringify(KEYED.gemini)},
    "activeProvider": "gemini",
    "selectedModels": { "__proto__": {"x":1}, "constructor": "x", "gemini": 12345 }
  }`;
  const r = probe(poisoned, `
    cfg.setSelectedModel('gemini', ${JSON.stringify(UPGRADE_MODEL.gemini)});
    const on = JSON.parse(fs.readFileSync(process.env.CURATOR_TEST_USER_DATA_DIR + '/.curator-config.json','utf8')).selectedModels;
    return { keys: Object.keys(on).sort(), gem: on.gemini };
  `);
  ok(r.ok && JSON.stringify(r.v.keys) === JSON.stringify(['gemini']),
    'a legitimate write REBUILDS selectedModels, dropping __proto__/constructor junk');
  ok(r.ok && r.v.gem === UPGRADE_MODEL.gemini, 'and stores the real choice');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  Corrupt / hand-mangled config degrades to defaults, never throws');
// ═══════════════════════════════════════════════════════════════════════════

const CORRUPT = [
  ['a string instead of an object',   '"gemini-2.5-flash"'],
  ['null',                            'null'],
  ['an array',                        '["gemini-2.5-flash"]'],
  ['a number',                        '42'],
  ['a boolean',                       'true'],
  ['a nested object as the value',    '{"gemini": {"id": "gemini-2.5-flash"}}'],
  ['an array as the value',           '{"gemini": ["gemini-2.5-flash"]}'],
  ['a number as the value',           '{"gemini": 7}'],
  ['null as the value',               '{"gemini": null}'],
  ['an empty string as the value',    '{"gemini": ""}'],
  ['an empty object',                 '{}'],
];
for (const [label, json] of CORRUPT) {
  const raw = `{"geminiApiKey": ${JSON.stringify(KEYED.gemini)}, "activeProvider":"gemini", "selectedModels": ${json}}`;
  const r = probe(raw, `
    return { stored: cfg.getSelectedModel('gemini'), model: llm.getProviderInfo().model };
  `);
  ok(!r.error && r.ok, `corrupt (${label}) did not throw${r.threw ? ` — THREW: ${r.threw}` : ''}`);
  if (r.ok) {
    eq(r.v.stored, null, `corrupt (${label}) ⇒ getSelectedModel null`);
    eq(r.v.model, DEFAULT_MODEL.gemini, `corrupt (${label}) ⇒ resolves to the safe default`);
  }
}

// The whole file being unparseable is already handled by readRaw's catch, but a
// server that cannot boot is the worst outcome of all, so pin it.
{
  const r = probe('{ this is not json at all ', `
    return { stored: cfg.getSelectedModel('gemini'), threwOnResolve: (() => { try { llm.getProviderInfo(); return false; } catch { return true; } })() };
  `, { env: { GEMINI_API_KEY: 'env-key' } });
  ok(!r.error && r.ok, 'an unparseable config file does not crash module load');
  ok(r.ok && r.v.stored === null, 'an unparseable config yields no selection');
  ok(r.ok && r.v.threwOnResolve === false, 'and resolution still works off the .env key');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  Precedence: per-call > LLM_MODEL > stored > DEFAULTS');
// ═══════════════════════════════════════════════════════════════════════════

{
  const stored = UPGRADE_MODEL.gemini;
  const perCall = OFFERABLE_MODELS.gemini[2].id;
  ok(perCall !== stored && perCall !== DEFAULT_MODEL.gemini,
    'control: the three ids in the precedence probe are all distinct');

  const base = cfgWithKeys(['gemini'], { selectedModels: { gemini: stored } });

  const a = probe(base, `return llm.getProviderInfo(null, ${JSON.stringify(perCall)}).model;`);
  eq(a.ok && a.v, perCall, 'a per-call model override BEATS the stored selection');

  const b = probe(base, `return llm.getProviderInfo().model;`, { env: { LLM_MODEL: 'dev-forced-model' } });
  eq(b.ok && b.v, 'dev-forced-model', 'LLM_MODEL (dev escape hatch) beats the stored selection');

  // An INVALID per-call override falls back to the user's EFFECTIVE default —
  // their stored Settings choice — NOT to DEFAULTS.
  //
  // This is deliberate, and it is worth stating because the opposite is the
  // intuitive guess. applyModelOverride's contract is "refuse, and use the
  // provider's default instead"; once a user has made a Settings choice, THAT
  // is the provider's default for them. Dropping to DEFAULTS would silently
  // demote a user who has deliberately paid for a better model, every time some
  // caller sent a garbage id — a behaviour indistinguishable from the picker
  // not working. It is still money-safe: the stored id can only be something
  // the user explicitly POSTed AND that is still on the allow-list AND whose
  // provider key is still saved, so a refusal can never escalate past what the
  // user already authorised.
  const c = probe(base, `return llm.getProviderInfo(null, 'not-a-real-model').model;`);
  eq(c.ok && c.v, stored,
    'an INVALID per-call override falls back to the EFFECTIVE default (the stored selection), not past it');

  // …and with nothing stored, that same refusal lands on DEFAULTS — so the
  // fallback target is "whatever this user\'s default is", consistently.
  const c2 = probe(cfgWithKeys(['gemini']), `return llm.getProviderInfo(null, 'not-a-real-model').model;`);
  eq(c2.ok && c2.v, DEFAULT_MODEL.gemini,
    'with nothing stored, an invalid per-call override falls to DEFAULTS — same rule, no special case');

  const d = probe(base, `return llm.getProviderInfo().model;`);
  eq(d.ok && d.v, stored, 'with neither, the stored selection wins over DEFAULTS');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  Read fresh per call — a change takes effect without a restart');
// ═══════════════════════════════════════════════════════════════════════════

{
  const r = probe(cfgWithKeys(['gemini']), `
    const before = llm.getProviderInfo().model;
    cfg.setSelectedModel('gemini', ${JSON.stringify(UPGRADE_MODEL.gemini)});
    const after = llm.getProviderInfo().model;
    cfg.setSelectedModel('gemini', '');
    const cleared = llm.getProviderInfo().model;
    return { before, after, cleared };
  `);
  ok(r.ok, 'per-call-freshness probe ran');
  if (r.ok) {
    eq(r.v.before,  DEFAULT_MODEL.gemini, 'fresh read: default before any selection');
    eq(r.v.after,   UPGRADE_MODEL.gemini, 'fresh read: the NEW selection is picked up in the SAME process — no snapshot at module load');
    eq(r.v.cleared, DEFAULT_MODEL.gemini, 'fresh read: clearing takes effect immediately too');
  }
}

// Structural backstop for the behavioural proof above. Anchored at COLUMN 0,
// because that is what distinguishes a module-level declaration (snapshotted at
// import, the v3.1.0 defect) from an indented one inside a function body (fresh
// per call, which is what we want and what storedSelection actually does).
{
  const src = readFileSync(LLM_JS, 'utf8');
  const SNAPSHOT = /^const\s+\w+\s*=\s*(?:getSelectedModel|getApiKeys)\s*\(/m;
  ok(!SNAPSHOT.test(src),
    'llm.js does not snapshot getSelectedModel()/getApiKeys() into a module-level const');
  ok(SNAPSHOT.test(src + '\nconst KEYS = getApiKeys();\n'),
    'control: that snapshot guard detects a planted module-level snapshot');
  ok(!SNAPSHOT.test('function f() {\n  const keys = getApiKeys();\n}'),
    'control: it does NOT fire on the correct indented, per-call form');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9  The route: gates on a SAVED key AND on the allow-list');
// ═══════════════════════════════════════════════════════════════════════════

// Driven through the real express router in-process (no port bound, no server
// on 3333 touched), with the config redirected to a tempdir.
function routeProbe(configObject, reqBody, { env = {} } = {}) {
  const dir = path.join(tmpBase, `r${++probeSeq}`);
  mkdirSync(dir, { recursive: true });
  if (configObject !== null) {
    writeFileSync(path.join(dir, '.curator-config.json'), JSON.stringify(configObject, null, 2), { mode: 0o600 });
  }
  const script = `
    import express from 'express';
    import routes from ${JSON.stringify(ROUTE_JS)};
    const app = express();
    app.use(express.json());
    app.use('/api/config', routes);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise(r => srv.once('listening', r));
    const port = srv.address().port;
    const res = await fetch('http://127.0.0.1:' + port + '/api/config/api-keys/model', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(reqBody))},
    });
    const body = await res.json().catch(() => ({}));
    const after = await (await fetch('http://127.0.0.1:' + port + '/api/config/api-keys')).json();
    srv.close();
    process.stdout.write('@@' + JSON.stringify({ ok: true, v: { status: res.status, body,
      selectedModels: after.selectedModels, models: after.models } }) + '@@');
  `;
  const childEnv = { ...process.env, CURATOR_TEST_USER_DATA_DIR: dir };
  for (const k of ['LLM_MODEL','GEMINI_API_KEY','ANTHROPIC_API_KEY','DOMAINS_PATH','CURATOR_TEST_DOMAINS_DIR']) delete childEnv[k];
  Object.assign(childEnv, env);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: childEnv, encoding: 'utf8' });
  const m = (r.stdout || '').match(/@@([\s\S]*)@@/);
  if (!m) return { error: (r.stderr || '(no stderr)').trim().split('\n').slice(-4).join(' | ') };
  return JSON.parse(m[1]);
}

// Happy path
{
  const r = routeProbe(cfgWithKeys(['anthropic']), { provider: 'anthropic', model: UPGRADE_MODEL.anthropic });
  ok(!r.error, `route happy-path probe ran${r.error ? `: ${r.error}` : ''}`);
  if (!r.error) {
    eq(r.v.status, 200, 'route accepts an offerable model for a keyed provider');
    eq(r.v.body.selectedModel, UPGRADE_MODEL.anthropic, 'route echoes the stored model');
    eq(r.v.body.effectiveModel, UPGRADE_MODEL.anthropic, 'route reports the model the app will actually use');
    eq(r.v.selectedModels.anthropic, UPGRADE_MODEL.anthropic, 'GET /api-keys reflects the new selection');
    eq(r.v.models.anthropic, UPGRADE_MODEL.anthropic, 'GET /api-keys `models` (what will be USED) reflects it too');
  }
}

// Refusal: provider has no SAVED key (only .env) — the v3.0.13 rule at the write end.
{
  const r = routeProbe({ geminiApiKey: KEYED.gemini, activeProvider: 'gemini' },
    { provider: 'anthropic', model: UPGRADE_MODEL.anthropic },
    { env: { ANTHROPIC_API_KEY: 'stale-env-key' } });
  ok(!r.error, 'route unkeyed-provider probe ran');
  if (!r.error) {
    eq(r.v.status, 400, 'route REFUSES a provider with no key saved in Settings (an .env key does not count)');
    eq(r.v.selectedModels.anthropic, null, 'and nothing was stored');
  }
}

// Refusal: non-offerable model
for (const bad of ['gpt-5-turbo', 'claude-3-5-haiku-latest', UPGRADE_MODEL.gemini /* wrong provider */]) {
  const r = routeProbe(cfgWithKeys(['anthropic']), { provider: 'anthropic', model: bad });
  ok(!r.error, `route non-offerable probe ran (${bad})`);
  if (!r.error) {
    eq(r.v.status, 400, `route REFUSES a non-offerable model (${bad})`);
    eq(r.v.selectedModels.anthropic, null, `and stored nothing (${bad})`);
    ok(!String(JSON.stringify(r.v.body)).includes(bad),
      `and does not echo the caller's string back (${bad}) — log-forgery / injected-instruction defence`);
  }
}

// Refusal: bad provider, including prototype keys
for (const bad of ['openai', '__proto__', 'constructor', '', null, 42]) {
  const r = routeProbe(cfgWithKeys(['gemini']), { provider: bad, model: UPGRADE_MODEL.gemini });
  ok(!r.error && r.v.status === 400, `route REFUSES provider ${JSON.stringify(bad)}`);
}

// Clearing is allowed and returns to the default
{
  const r = routeProbe(cfgWithKeys(['gemini'], { selectedModels: { gemini: UPGRADE_MODEL.gemini } }),
    { provider: 'gemini', model: '' });
  ok(!r.error, 'route clear probe ran');
  if (!r.error) {
    eq(r.v.status, 200, 'route accepts an empty model as "clear my selection"');
    eq(r.v.body.selectedModel, null, 'and reports nothing selected');
    eq(r.v.models.gemini, DEFAULT_MODEL.gemini, 'and the app returns to the provider default');
  }
}

// A non-string, non-empty model is a 400, not a crash.
for (const bad of [42, true, { id: 'x' }, ['x']]) {
  const r = routeProbe(cfgWithKeys(['gemini']), { provider: 'gemini', model: bad });
  ok(!r.error && r.v.status === 400, `route REFUSES a non-string model ${JSON.stringify(bad)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10  Structural invariants');
// ═══════════════════════════════════════════════════════════════════════════

{
  const routeSrc = readFileSync(ROUTE_JS, 'utf8');
  const cfgSrc   = readFileSync(CONFIG_JS, 'utf8');
  const llmSrc   = readFileSync(LLM_JS, 'utf8');

  // The concurrency guard. Without it a click mid-ingest switches the model
  // between Phase 1 and Phase 2 (v3.6.0's class), invalidates the Anthropic
  // prompt cache mid-run, and makes per-item spend arithmetic wrong.
  ok(/router\.post\('\/api-keys\/model',\s*guardConcurrent\(/.test(routeSrc),
    'the model route carries guardConcurrent — a model swap mid-ingest is refused');
  // Negative control: the assertion can fail.
  ok(!/router\.post\('\/api-keys\/model',\s*guardConcurrent\(/
      .test(routeSrc.replace(/(router\.post\('\/api-keys\/model',\s*)guardConcurrent\([^)]*\),\s*/, '$1')),
    'control: that guard assertion detects the guard being removed');

  // config.js must not import llm.js (cycle), so validation cannot live there.
  ok(!/from '\.\/llm\.js'/.test(cfgSrc), 'config.js does not import llm.js — no import cycle');

  // ── THE CONSEQUENCE OF THAT ANTI-CYCLE RULE (v3.15.0) ─────────────────────
  //
  // Because config.js may not import llm.js, it cannot decide for itself
  // whether a provider has a model that can BUILD a wiki. So `setApiKeys`
  // takes an INJECTED predicate — `opts.canActivate(provider)` — and, with no
  // predicate supplied, ACTIVATES NOTHING. That default is fail-safe by
  // design, and both failure directions were weighed at the definition site:
  //
  //   • forget the predicate  -> the key saves but does not become active.
  //     Annoying, VISIBLE, undone by one click on the Set-active control.
  //   • activate a provider that cannot build -> ingest, Health and Compile
  //     all throw on the next call with NOTHING on screen, because the route
  //     swallows getProviderInfo()'s throw in a catch commented "no key
  //     configured yet" — while a key IS configured. That is the v3.15.0 P0:
  //     a user with a WORKING Gemini install who merely SAVED an OpenRouter
  //     key lost the entire build lane.
  //
  // BOTH REGRESSIONS ARE SILENT, which is why they need a guard rather than a
  // comment. A caller that never passes the predicate quietly stops honouring
  // last-saved-wins (a working feature dies with no error); a caller that has
  // the predicate REMOVED re-arms the P0. Neither throws, neither logs.
  //
  // WHY A WHOLE-TREE WALK AND NOT A SCAN OF routes/config.js. Today that file
  // holds the only production caller — verified, and re-verified mechanically
  // below. But the entire point of the guard is the caller that does not exist
  // yet, and a scan pinned to one filename is blind to exactly that. Same
  // approach as test-next-chat-compile.js, which pins that exactly one
  // POST /api/domains call site exists anywhere under its tree.
  //
  // DELIBERATELY NOT EXTENDED TO `setActiveProvider`, and this is not an
  // oversight. Its default is the OPPOSITE (absent predicate => allow) because
  // it backs an explicit user click, where a silent no-op reads as a dead
  // button; POST /api-keys/active returns a 400 with a reason instead. Three
  // LIVE suites call it with no opts and depend on that. Do not "fix" the
  // asymmetry into symmetry — it is load-bearing in both directions.
  {
    // Production trees only. `scripts/` is excluded because a test may
    // legitimately drive the raw seam (test-paths.js probes the domains-dir
    // override; this suite's sibling seeds an isolated config), and
    // src/brain/config.js is excluded because it DEFINES the function.
    const SKIP_DIRS = new Set(['node_modules', '.git', 'scripts', 'domains',
                               '.knowledge-git', 'Design', 'coverage', 'dist', 'build']);
    const DEFINITION_FILE = path.join(ROOT, 'src/brain/config.js');

    function walkJs(dir, out = []) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkJs(full, out); }
        else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(full);
      }
      return out;
    }

    /**
     * Extract the FULL argument text of a call, by paren depth rather than by
     * `([^)]*)`. That single-line form breaks on a multi-line call and on any
     * nested parenthesis — and a call site it cannot read is precisely where a
     * missing predicate would hide.
     *
     * Returns null when it cannot find a balanced close paren, and the caller
     * turns that into a NAMED FAILURE. Unparseable is never a silent skip.
     *
     * String- and comment-aware, because an apostrophe or a `)` inside a
     * message string would otherwise unbalance the count.
     */
    function extractCallArgs(src, openIdx, cap = 4000) {
      let depth = 0, i = openIdx;
      let str = null, esc = false, line = false, block = false;
      const end = Math.min(src.length, openIdx + cap);
      for (; i < end; i++) {
        const c = src[i], n = src[i + 1];
        if (line) { if (c === '\n') line = false; continue; }
        if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
        if (str) {
          if (esc) { esc = false; continue; }
          if (c === '\\') { esc = true; continue; }
          if (c === str) str = null;
          continue;
        }
        if (c === '/' && n === '/') { line = true; i++; continue; }
        if (c === '/' && n === '*') { block = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { str = c; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
      }
      return null; // unbalanced, or longer than the cap -> the caller FAILS
    }

    // Find every call site outside the definition file, across the whole
    // production tree. Matches `setApiKeys(` and any qualified form
    // (`cfg.setApiKeys(`, `configModule.setApiKeys(`), so a namespace import
    // cannot evade it.
    const callSites = [];
    let unparseable = [];
    const visited = walkJs(ROOT);
    for (const file of visited) {
      if (file === DEFINITION_FILE) continue;
      const src = readFileSync(file, 'utf8');
      const re = /(?:^|[^A-Za-z0-9_$.])(?:[A-Za-z0-9_$]+\s*\.\s*)?setApiKeys\s*\(/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const openIdx = src.indexOf('(', m.index + m[0].length - 1);
        const args = extractCallArgs(src, openIdx);
        const rel = path.relative(ROOT, file);
        if (args === null) unparseable.push(`${rel}@${m.index}`);
        else callSites.push({ file: rel, args });
      }
    }

    // NON-VACUITY, both halves. A walk that visits nothing, or a matcher that
    // finds nothing, would pass every requirement below by finding no work.
    ok(visited.length > 20 && visited.some(f => f.endsWith(path.join('src', 'routes', 'config.js'))),
      `the walk actually visited the production tree (${visited.length} .js/.mjs files, including src/routes/config.js)`);
    ok(callSites.length >= 1,
      `at least one production setApiKeys(...) call site was FOUND — found ${callSites.length}: ${JSON.stringify(callSites.map(c => c.file))}`);
    // Unparseable is a FAILURE naming the file, never a skip.
    eq(unparseable.length, 0,
      `every setApiKeys(...) call site parsed to a balanced argument list${unparseable.length ? ` — UNPARSEABLE: ${unparseable.join(', ')}` : ''}`);

    for (const c of callSites) {
      ok(/\bcanActivate\s*:/.test(c.args),
        `${c.file}: setApiKeys(...) passes canActivate — without it the save NEVER activates, silently killing last-saved-wins; with it removed, the v3.15.0 P0 (a saved OpenRouter key deactivating the build lane) is re-armed`);
    }

    // ── NEGATIVE CONTROLS, driven through the REAL extractor + predicate ──────
    // Not a hand-written boolean: the same two functions the loop above uses,
    // so a bug in either is caught here rather than making the loop vacuous.
    {
      const bare = 'const r = setApiKeys(update);';
      const bareArgs = extractCallArgs(bare, bare.indexOf('('));
      eq(bareArgs, 'update', 'control: the extractor reads a bare single-argument call');
      ok(!/\bcanActivate\s*:/.test(bareArgs),
        'CONTROL: a bare `setApiKeys(update)` FAILS the requirement — the assertion above can go red');

      // Multi-line + nested parens + a `)` and an apostrophe inside a string:
      // the exact shapes a `([^)]*)` regex silently truncates or mis-reads.
      const hard = [
        'const { skippedActivation } = setApiKeys(update, {',
        "  // a comment with a stray ) paren",
        "  label: 'it\\'s fine (really)',",
        '  canActivate: (p) => providerCanBuild(p, getProviderInfo(p)),',
        '});',
      ].join('\n');
      const hardArgs = extractCallArgs(hard, hard.indexOf('('));
      ok(hardArgs !== null, 'control: the extractor survives a multi-line call with nested parens, a comment and a quoted apostrophe');
      ok(/\bcanActivate\s*:/.test(hardArgs || ''),
        'control: and still SEES canActivate in that hard case (a single-line [^)]* regex truncates at the first inner paren and would miss it)');
      const naive = /setApiKeys\(([^)]*)\)/.exec(hard);
      ok(naive && !/\bcanActivate\s*:/.test(naive[1]),
        'control: the naive single-line regex DOES miss it on that same input — which is why the extractor exists');

      // An unbalanced call must be reported, never treated as compliant.
      eq(extractCallArgs('setApiKeys(update, { canActivate: f', 'setApiKeys('.length - 1), null,
        'control: an unbalanced call site returns null, which the loop turns into a NAMED failure rather than a silent pass');
    }
  }
  // Comments stripped first, deliberately — the same trap test-chat-model.js
  // records: config.js's own docblock NAMES OFFERABLE_MODELS to explain where
  // validation does live, and a guard that reds on prose describing the
  // invariant gets "fixed" by deleting the explanation. Match executable text.
  const cfgCode = cfgSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/OFFERABLE_MODELS|isOfferableModel/.test(cfgCode),
    'config.js holds NO copy of the allow-list — one predicate, referenced, never duplicated');
  ok(/OFFERABLE_MODELS|isOfferableModel/.test(cfgCode + '\nif (!isOfferableModel(p, m)) return null;'),
    'control: that no-copy guard detects a planted allow-list check in config.js');

  // ── The allow-list has exactly ONE implementation ─────────────────────────
  // The RULE is unchanged and is more load-bearing now than when it was
  // written: exactly one array scan decides membership in the offerable
  // catalogue. What changed in v3.15.0 is the SHAPE that expresses it. It used
  // to read `OFFERABLE_MODELS[provider].some(...)`; OpenRouter's catalogue is
  // populated at runtime, so the static table is a PARTIAL view for that
  // provider and the scan now runs over the `listOfferableModels(provider)`
  // accessor instead.
  //
  // The pin is therefore WIDENED, never softened: it counts BOTH shapes, so a
  // regression to the old direct-table form is caught as well as a second copy
  // of the new one. It also counts `.find` / `.filter` / `.includes` /
  // `.indexOf`, because "one scan" is about the number of membership decisions,
  // not about which array method spells them.
  //
  // COMMENTS ARE STRIPPED FIRST, and that is not tidiness — measured, the raw
  // source matches TWICE and the executable source matches ONCE, because
  // llm.js's own docblock on `isBuildLaneModel` explains the rule by quoting
  // the very expression it forbids ("A second `listOfferableModels(...).find(...)`
  // here would be a hand-maintained copy"). A guard that reds on the prose
  // describing the invariant gets "fixed" by deleting the explanation. This is
  // the same trap already recorded 10 lines above for config.js.
  const CATALOGUE_SCAN_RE =
    /(?:OFFERABLE_MODELS\s*\[[^\]]*\]|listOfferableModels\s*\([^)]*\))\s*\.\s*(?:some|find|findIndex|filter|includes|indexOf)\s*\(/g;
  const llmCode = llmSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const impls = (llmCode.match(CATALOGUE_SCAN_RE) || []).length;
  eq(impls, 1, 'exactly ONE allow-list scan over the offerable catalogue exists in llm.js');
  // Negative controls — both shapes must be detectable, or the widening above
  // is decoration. Planted separately so a regex that only sees the new form
  // (i.e. that silently stopped guarding against the old one) still reds.
  eq((`${llmCode}\nreturn OFFERABLE_MODELS[provider].some(m => m.id === id);`.match(CATALOGUE_SCAN_RE) || []).length, 2,
    'control: a planted SECOND scan in the OLD direct-table shape is detected');
  eq((`${llmCode}\nreturn listOfferableModels(provider).find(e => e.id === id);`.match(CATALOGUE_SCAN_RE) || []).length, 2,
    'control: a planted SECOND scan in the NEW accessor shape is detected');

  // ── The lane check must SHARE that one scan, not open a second front ──────
  // `isBuildLaneModel` (v3.15.0) is a second question asked of the same entry:
  // "may the user pick this at all" vs "may it build the wiki". If it did its
  // own `listOfferableModels(...).find(...)` there would be two membership
  // tests that can disagree — the v3.2.0 CRITICAL's shape, and here the
  // disagreement would be a model that is refused for chat but accepted for
  // ingest, or the reverse. Both functions must reach the catalogue through
  // the one shared helper. llm.js's own comment claims "there is a standing
  // offline guard against it"; this is that guard.
  const helperUses = (llmCode.match(/findOfferableModel\s*\(/g) || []).length;
  ok(helperUses >= 3,
    `the shared findOfferableModel helper is defined once and called by both predicates (found ${helperUses} occurrences: 1 definition + >=2 call sites)`);
  for (const fn of ['isOfferableModel', 'isBuildLaneModel']) {
    const start = llmCode.indexOf(`export function ${fn}(`);
    ok(start !== -1, `${fn} is exported from llm.js`);
    const body = llmCode.slice(start, llmCode.indexOf('\n}', start) + 2);
    ok(/findOfferableModel\s*\(/.test(body),
      `${fn} reaches the catalogue through the shared findOfferableModel helper`);
    // Fresh non-global regex per test: CATALOGUE_SCAN_RE carries /g, and
    // `.test()` on a /g regex is STATEFUL (it advances lastIndex), so reusing
    // it here would make the second loop iteration read from an arbitrary
    // offset and pass for the wrong reason.
    ok(!new RegExp(CATALOGUE_SCAN_RE.source).test(body),
      `${fn} does NOT carry its own catalogue scan (one membership test, not two that can disagree)`);
  }

  // The single 0600 atomic writer.
  const writers = (cfgSrc.match(/writeFileAtomicSync\(/g) || []).length;
  eq(writers, 1, 'config.js still has exactly ONE file writer (0600 atomic) — setSelectedModel did not add a second');
  ok(/function writeRaw/.test(cfgSrc) && /mode: 0o600/.test(cfgSrc),
    'that writer still sets mode 0600 (this file holds the API keys)');

  // Fall back, never throw — the money-safe direction.
  const dmf = llmSrc.slice(llmSrc.indexOf('function defaultModelFor'), llmSrc.indexOf('export function getDefaultModel'));
  ok(!/throw/.test(dmf), 'defaultModelFor never throws — a stale selection degrades, it does not break every ingest');
  ok(/applyModelOverride\(/.test(dmf),
    'defaultModelFor validates the stored id through applyModelOverride (the existing single guard), not a new check');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All selected-model (persisted per-provider model) offline assertions green');
