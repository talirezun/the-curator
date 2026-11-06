#!/usr/bin/env node
/**
 * test-next-compare-all.js — what the Compare row says about a "Compare all remaining" job,
 * and how it asks (views/health-compare.js), with no browser and a stand-in for domains.js.
 *
 * What a poll may and may not do is the point of this suite: nothing here may spend, resume or
 * repaint by itself. The real screen is e2e-compare-all.mjs: a stubbed model, a real SIGKILL, a
 * 402, the stop at 120%, every frame measured at 1280 and 375.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createCompareAll, compareAllConfirmCopy, compareJobReading, compareJobDetail, compareJobNote, formatDuration } =
  await import(pathToFileURL(path.join(REPO, 'src/public/next/views/health-compare.js')).href);

let passed = 0; let failed = 0;
const ok = (cond, label, detail = '') => { if (cond) { passed++; console.log('  ✓ ' + label); } else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const usd = (v) => '$' + Number(v).toFixed(4);
const cost = (e, o) => (typeof e.estimatedUsd === 'number' ? (o && o.compact ? '≈ ' : '') + usd(e.estimatedUsd) : (o && o.compact ? (e.priceKnown ? 'free' : 'cost unknown') : e.costNote));
const words = (est) => compareAllConfirmCopy(est, { modelName: 'Flash Lite 2.5', cost, usd });
const estimate = (over) => ({ pairs: 3120, estimatedTokens: 1014000, estimatedUsd: 0.14, priceKnown: true, costNote: null, estimatedSeconds: 515, timeBasis: 'measured', rateBasis: 'measured', fallbackNote: 'Priced on this model.', costCeilingTokens: 20000000, overCeiling: false, stopMargin: 1.2, model: 'm', ...over });

section('1. The confirm');
{
  const w = words(estimate());
  ok(w.title === 'Compare all 3,120 remaining pairs?', '1.1 the full count', w.title);
  ok(w.body.includes('About 1,014,000 tokens and $0.1400, about 9 minutes.'), '1.2 tokens, dollars and a measured time', w.body);
  ok(w.body.includes('It stops if it reaches $0.1680.'), '1.3 the stop is 120% of what is confirmed', w.body);
  ok(w.body.includes('You can pause and carry on later.') && w.body.includes('Nothing is merged.'), '1.4 the deck\'s other two sentences');
  ok(w.warn.includes('Priced on this model.'), '1.5 the fallback is stated with the figure', w.warn);
  ok(!w.warn.includes('limit of'), '1.6 under the ceiling nothing is said about it', w.warn);

  const over = words(estimate({ overCeiling: true, costCeilingTokens: 40000 }));
  ok(over.warn.includes('above your limit of 40,000 tokens for one run') && over.warn.includes('stops by itself at $0.1680'), '1.7 over the ceiling: says so, and that it stops', over.warn);
  ok(!/smaller runs|each within/.test(over.warn), '1.8 and does not claim smaller runs: one job, no per-run ceiling inside it', over.warn);

  const unmeasured = words(estimate({ timeBasis: 'assumed', rateBasis: 'assumed' }));
  ok(!/about \d|minute|hour/.test(unmeasured.body), '1.9 another model\'s speed is not given as a time', unmeasured.body);
  ok(unmeasured.warn.includes('How long this takes is not known on Flash Lite 2.5.'), '1.10 it says the time is not known', unmeasured.warn);
  ok(unmeasured.warn.includes('have not been measured on'), '1.11 and that the figures are an assumption', unmeasured.warn);
  ok(words(estimate({ rateBasis: 'measured-tokens' })).warn.includes('an assumption'), '1.12 a measured token count with an assumed split says that');

  const free = words(estimate({ estimatedUsd: null, priceKnown: true, costNote: 'Free — no charge for model "x".' }));
  ok(free.body.includes('Free — no charge') && free.body.includes('It stops if it reaches 1,216,800 tokens.') && !free.body.includes('$'), '1.13 a free model: tokens, no dollars', free.body);
  const unpriced = words(estimate({ estimatedUsd: null, priceKnown: false, costNote: 'Cost estimate unavailable.' }));
  ok(unpriced.body.includes('Cost estimate unavailable.') && !unpriced.body.includes('$'), '1.14 an unpriced model invents no price', unpriced.body);
  ok(words(estimate({ pairs: 1 })).title === 'Compare all 1 remaining pair?', '1.15 one pair');

  ok(formatDuration(30) === 'under a minute' && formatDuration(515) === '9 minutes' && formatDuration(6000) === '1 hour 40 minutes' && formatDuration(7200) === '2 hours' && formatDuration(60) === '1 minute', '1.16 durations');
  ok(formatDuration(null) === null || formatDuration(undefined) === null, '1.17 no number is no time');
  ok(formatDuration(undefined) === null && formatDuration(-1) === null, '1.18 nor is a negative one');
}

const job = (over) => ({ state: 'running', limit: { kind: 'usd', confirmed: 1, stopAt: 1.2 }, spent: { usd: 0.5, inputTokens: 100, outputTokens: 10, cachedReadTokens: 0, cacheWriteTokens: 0 },
  progress: { totalPairs: 3160, checkedPairs: 1200, found: 3, failedPairs: 0 }, secondsLeft: 600, ...over });

section('2. What the row says');
{
  const c = { usd };
  ok(compareJobReading(job(), c) === 'Comparing 1,200 of 3,160…', '2.1 running');
  ok(compareJobReading(job({ progress: { totalPairs: 0, checkedPairs: 0 } }), c) === 'Comparing…', '2.2 no figure before the list is planned, rather than "0 of 0"');
  ok(compareJobReading(job({ state: 'pausing' }), c) === 'Comparing 1,200 of 3,160…', '2.3 pausing still says what it is doing');
  ok(compareJobReading(job({ state: 'paused', pauseReason: 'user' }), c) === 'Paused at 1,200 of 3,160. $0.5000 spent.', '2.4 paused');
  ok(compareJobReading(job({ state: 'paused', pauseReason: 'restart' }), c) === 'Paused when The Curator closed, at 1,200 of 3,160.', '2.5 after a restart, and it says so');
  ok(compareJobReading(job({ state: 'paused', pauseReason: 'provider-errors' }), c).startsWith('Paused at 1,200'), '2.6 a provider failure keeps the figures');
  ok(compareJobReading(job({ state: 'stopped' }), c) === null && compareJobReading(job({ state: 'done' }), c) === null && compareJobReading(null, c) === null, '2.7 otherwise the row reads as usual');
  const tokens = job({ state: 'paused', pauseReason: 'user', limit: { kind: 'tokens', confirmed: 1, stopAt: 2 } });
  ok(compareJobReading(tokens, c) === 'Paused at 1,200 of 3,160. 110 tokens spent.', '2.8 a job confirmed in tokens says tokens');

  const d = compareJobDetail(job(), c);
  ok(d === '$0.5000 spent · 3 new pairs found so far · about 10 minutes left', '2.9 the line while it runs', d);
  ok(compareJobDetail(job({ secondsLeft: null }), c).indexOf('left') === -1, '2.10 no time until a batch has measured one');
  ok(compareJobDetail(job({ progress: { totalPairs: 9, checkedPairs: 1, found: 1 } }), c).includes('1 new pair found so far'), '2.11 one pair');
  const rec = compareJobDetail(job({ state: 'paused', pauseReason: 'restart', recovered: true }), c);
  ok(rec.includes('$0.5000 spent, perhaps one call more'), '2.12 a recovered figure can read low, and it says so', rec);

  const restart = compareJobNote(job({ state: 'paused', pauseReason: 'restart' }), c);
  ok(restart.text === 'Nothing runs until you press Resume.', '2.13 nothing auto-starts, in words');
  ok(compareJobNote(job({ state: 'paused', pauseReason: 'user' }), c) === null, '2.14 a pause you pressed needs no note');
  const credits = compareJobNote(job({ state: 'paused', pauseReason: 'provider-errors', reason: 'Gemini says this account is out of credits.' }), c);
  ok(credits.tone === 'error' && credits.text.includes('out of credits'), '2.15 a provider failure: the reason, as an error');
  const limit = compareJobNote(job({ state: 'stopped', stopReason: 'spend-limit', reason: 'Stopped at the limit: it had spent $1.2 and would have passed $1.2.' }), c);
  ok(limit.text.includes('Stopped at the limit') && limit.text.includes('To carry on, compare again') && limit.tone === 'error', '2.16 the stop: why, spent, how to continue', limit.text);
  const unknown = compareJobNote(job({ state: 'stopped', stopReason: 'price-unknown', reason: 'No price.' }), c);
  ok(unknown.text.includes('$0.5000 spent.'), '2.17 any other stop also says what was spent', unknown.text);
  ok(compareJobNote(job({ state: 'stopped', stopReason: 'user' }), c) === null, '2.18 Stop you pressed needs no note');
  ok(compareJobNote(job({ state: 'failed', reason: 'The comparison stopped: x.' }), c).text.includes('$0.5000 spent.'), '2.19 failed');
  ok(compareJobNote(job({ state: 'done', progress: { failedPairs: 4 } }), c).text.startsWith('4 pairs could not be compared'), '2.20 done with failures: the deck\'s line');
  ok(compareJobNote(job({ state: 'done' }), c) === null, '2.21 done with none: nothing');
}

// ── The stand-in for domains.js ────────────────────────────────────────────
function world(over = {}) {
  const w = { calls: [], renders: 0, notes: [], asked: [], lives: [], covers: [], ended: 0, pulled: 0, mirror: false, slug: 'alpha', mounted: true, status: job(), estimate: estimate(), holdPull: null,
    respond: {}, busyOn: false, ...over };
  w.deps = {
    pollMs: 5,
    slug: () => w.slug,
    offered: () => !w.mirror,
    mounted: () => w.mounted,
    fetchJSON: async (url, opts) => {
      w.calls.push((opts && opts.method ? 'POST ' : 'GET ') + url.replace(/^.*compare-all\//, ''));
      const tail = url.replace(/^.*compare-all\//, '');
      if (w.respond[tail]) { const r = w.respond[tail]; if (r instanceof Error) throw r; return r(opts); }
      if (tail === 'status') return { job: w.status };
      if (tail === 'estimate') return w.estimate;
      return { job: w.status };
    },
    render: () => { w.renders++; },
    live: (t) => { w.lives.push(t); },
    ask: (c) => { w.asked.push(c); },
    note: (slug, text, retry) => { w.notes.push({ slug, text, retry }); },
    setBusy: (on) => { w.busyOn = on; },
    busy: () => w.busyOn,
    focusAfterStart: () => {}, focusAfterStop: () => {},
    modelName: () => 'Flash Lite 2.5',
    cost, usd,
    chip: (o) => '<chip ' + o.label + '|' + (o.cost || '') + '|' + (o.attrs || '') + '>',
    ring: () => '', sparkles: () => '',
    escape: (t) => String(t),
    scanCounting: () => false,
    setCoverage: (t, c) => { w.covers.push([t, c]); },
    pullPairs: async () => { w.pulled++; if (w.holdPull) await w.holdPull; },
    ended: () => { w.ended++; },
  };
  w.api = createCompareAll(w.deps);
  return w;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const POSTS = (w) => w.calls.filter((c) => c.startsWith('POST'));
const c0 = { checked: 40, left: 3120, next: 40, total: 3160 };

section('3. Nothing spends by itself');
{
  const w = world({ status: job({ state: 'paused', pauseReason: 'restart' }) });
  await w.api.sync('alpha');
  await wait(40);
  ok(POSTS(w).length === 0, '3.1 a paused job read at open posts nothing');
  ok(w.calls.filter((c) => c === 'GET status').length === 1, '3.2 and does not poll: nothing is moving');
  ok(/Resume/.test(w.api.actions('alpha', 'NEXT', c0)) && /Stop/.test(w.api.actions('alpha', 'NEXT', c0)), '3.3 Resume and Stop on the row');
  ok(!w.api.actions('alpha', 'NEXT', c0).includes('NEXT'), '3.4 and no other way to spend beside them');

  const r = world({ status: job() });
  await r.api.sync('alpha');
  ok(!r.api.actions('alpha', 'NEXT', c0).includes('NEXT') && !r.api.actions('alpha', 'NEXT', c0).includes('chip'), '3.5 running: nothing beside Pause spends');
  ok(/Pause/.test(r.api.actions('alpha', 'NEXT', c0)), '3.6 Pause');
  r.slug = 'gone'; await wait(30);
  ok(POSTS(r).length === 0, '3.7 a poll never posts');
}

section('4. Asking: the amount that was on screen, and refusals in words');
{
  const w = world({ status: { state: 'none' } });
  await w.api.press('alpha');
  ok(w.calls.includes('GET estimate') && !POSTS(w).length, '4.1 the press reads a fresh estimate and starts nothing');
  ok(w.asked.length === 1 && w.asked[0].tier === 'ai' && w.asked[0].confirmLabel === 'Compare all for', '4.2 it asks');
  let sent = null;
  w.respond.start = (o) => { sent = JSON.parse(o.body); return { job: job() }; };
  await w.asked[0].run();
  ok(sent && sent.confirmedModel === 'm' && sent.confirmedUsd === 0.14 && !('confirmedTokens' in sent), '4.3 start carries the confirmed model and dollars', JSON.stringify(sent));
  w.mounted = false; await wait(20);

  const t = world({ status: { state: 'none' }, estimate: estimate({ estimatedUsd: null, priceKnown: true }) });
  await t.api.press('alpha');
  let tSent = null;
  t.respond.start = (o) => { tSent = JSON.parse(o.body); return { job: job() }; };
  await t.asked[0].run();
  ok(tSent.confirmedTokens === 1014000 && !('confirmedUsd' in tSent), '4.4 a free model confirms tokens', JSON.stringify(tSent));
  t.mounted = false; await wait(20);

  const elsewhere = world({ estimate: estimate({ job: { state: 'none', runningElsewhere: 'other' } }) });
  await elsewhere.api.press('alpha');
  ok(elsewhere.asked.length === 0 && /already running in "other"/.test(elsewhere.notes[0].text), '4.5 a job in another domain: refused in words, no confirm', JSON.stringify(elsewhere.notes));
  ok(!POSTS(elsewhere).length, '4.6 and nothing started');

  const refused = world({ status: { state: 'none' } });
  await refused.api.press('alpha');
  refused.respond.start = new Error('A comparison is already running in "other". It keeps going on its own; this one was not started.');
  await refused.asked[0].run();
  ok(/already running/.test(refused.notes[0].text) && refused.notes[0].retry, '4.7 a start the server refuses: its words stay, with Try again');

  const failed = world();
  failed.respond.estimate = new Error('boom');
  await failed.api.press('alpha');
  ok(failed.busyOn === false && /Could not compare pages: boom/.test(failed.notes[0].text), '4.8 an estimate that fails: the control lets go, and says why');

  const none = world({ estimate: estimate({ pairs: 0 }) });
  await none.api.press('alpha');
  ok(none.asked.length === 0, '4.9 nothing left: no question');
}

section('5. A tick does not paint');
{
  const w = world();
  await w.api.sync('alpha');
  await wait(4); // the pairs it found while nobody was looking have been read and drawn
  const after = w.renders;
  await wait(60);
  ok(w.calls.filter((c) => c === 'GET status').length >= 3, '5.1 it polls while running');
  ok(w.renders === after, '5.2 and no tick repaints: only the row\'s text nodes change', after + ' -> ' + w.renders);
  ok(w.covers.length >= 3 && w.covers.at(-1)[1] === 1200, '5.3 the figures still reach the row');
  w.status = job({ state: 'paused', pauseReason: 'user' });
  await wait(30);
  ok(w.renders > after, '5.4 a change of state paints');
  ok(w.ended === 1 && w.lives.some((l) => l.startsWith('Paused at')), '5.5 and is announced, once, and the figures are read again');
  const n = w.calls.length;
  await wait(40);
  ok(w.calls.length === n, '5.6 and the polling stops');
}
{
  // One outstanding at a time: a slow server can never have two polls waiting.
  const w = world();
  let out = 0; let most = 0;
  w.respond.status = async () => { out++; most = Math.max(most, out); await wait(25); out--; return { job: job() }; };
  await w.api.sync('alpha');
  await wait(150);
  w.mounted = false;
  await wait(40);
  ok(most === 1, '5.7 a slow server never has two polls outstanding', String(most));
}
{
  const w = world();
  await w.api.sync('alpha');
  w.slug = 'other';
  await wait(20);
  const n = w.calls.length;
  await wait(30);
  ok(w.calls.length === n, '5.8 the domain left the screen: the page stops asking (the job does not stop)');
  w.slug = 'alpha'; w.mounted = true;
  await w.api.sync('alpha');
  await wait(20);
  ok(w.calls.length > n, '5.9 coming back picks it up');
  w.mounted = false; await wait(20);
}

{
  // An old record must not overwrite the row's own count, whichever lands first.
  const w = world({ status: job({ state: 'stopped', stopReason: 'spend-limit', finishedAt: 'T' }) });
  await w.api.sync('alpha');
  ok(w.covers.length === 0, '5.10 an old job\'s figures never reach the row', JSON.stringify(w.covers));
  const p = world({ status: job({ state: 'paused', pauseReason: 'user' }) });
  await p.api.sync('alpha');
  ok(p.covers.length === 0, '5.11 nor do a paused one\'s');
  const r = world();
  await r.api.sync('alpha');
  r.status = job({ state: 'done', progress: { totalPairs: 3160, checkedPairs: 3160, found: 3, failedPairs: 0 } });
  await wait(20);
  ok(r.covers.at(-1)[1] === 3160, '5.12 a job it was watching does, as it ends');
}

section('6. Found pairs');
{
  const w = world({ status: job({ progress: { totalPairs: 100, checkedPairs: 10, found: 0 } }) });
  await w.api.sync('alpha');
  await wait(30);
  ok(w.pulled === 0, '6.1 nothing found: the pair list is not read');
  w.status = job({ progress: { totalPairs: 100, checkedPairs: 30, found: 2 } });
  await wait(30);
  ok(w.pulled === 1, '6.2 found moved: read once', String(w.pulled));
  const renders = w.renders;
  w.status = job({ progress: { totalPairs: 100, checkedPairs: 40, found: 5 } });
  await wait(30);
  ok(w.pulled === 2 && w.renders > renders, '6.3 moved again: read again, and the count paints', String(w.pulled));
  let release;
  w.holdPull = new Promise((r) => { release = r; });
  w.status = job({ progress: { totalPairs: 100, checkedPairs: 50, found: 6 } });
  await wait(15);
  w.status = job({ progress: { totalPairs: 100, checkedPairs: 60, found: 7 } });
  await wait(30);
  ok(w.pulled === 3, '6.4 a slow read: only one at a time', String(w.pulled));
  release(); w.holdPull = null;
  await wait(30);
  ok(w.pulled === 4, '6.5 and the next tick catches up', String(w.pulled));
  w.mounted = false; await wait(20);

  const back = world({ status: job({ state: 'paused', pauseReason: 'user', progress: { totalPairs: 100, checkedPairs: 40, found: 5 } }) });
  await back.api.sync('alpha');
  await wait(5);
  ok(back.pulled === 1, '6.6 coming back to a job that found pairs reads them, once');
  await back.api.sync('alpha');
  await wait(5);
  ok(back.pulled === 1, '6.7 not on every reading of the panel');
}

section('7. The chip');
{
  const w = world({ status: { state: 'none' } });
  await w.api.sync('alpha');
  ok(w.api.actions('alpha', 'NEXT', { checked: 0, left: 500, next: 40, total: 500 }) === 'NEXT', '7.1 never run: only the next batch (the deck)');
  ok(w.api.actions('alpha', 'NEXT', { checked: 10, left: 30, next: 30, total: 40 }) === 'NEXT', '7.2 the rest fits in one run: Compare the next covers it');
  ok(/disabled/.test(w.api.actions('alpha', 'NEXT', c0)), '7.3 no figure yet: it waits, a paying button wears its cost');
  w.api.afterPaint(c0);
  await wait(10);
  const html = w.api.actions('alpha', 'NEXT', c0);
  ok(html.startsWith('NEXT') && html.includes('Compare all 3,120') && html.includes('≈ $0.1400') && !/disabled/.test(html), '7.4 with one: count and cost, beside Compare the next', html);
  const scaled = w.api.actions('alpha', 'NEXT', { ...c0, left: 1560 });
  ok(scaled.includes('Compare all 1,560') && scaled.includes('≈ $0.0700'), '7.5 a count that moved scales the figure on the button', scaled);
  const gets = w.calls.filter((c) => c === 'GET estimate').length;
  w.api.afterPaint(c0); w.api.afterPaint(c0);
  await wait(10);
  ok(w.calls.filter((c) => c === 'GET estimate').length === gets, '7.6 one read per quote, however many paints');

  const f = world({ status: { state: 'none' } });
  f.respond.estimate = new Error('slow');
  f.api.afterPaint(c0);
  await wait(10);
  ok(!/disabled/.test(f.api.actions('alpha', 'NEXT', c0)), '7.7 a quote that failed stays pressable: the press asks again and says why');

  const q = world({ status: { state: 'none' } });
  q.api.noteQuote('alpha', estimate());
  ok(q.api.actions('alpha', 'NEXT', c0).includes('≈ $0.1400'), '7.8 the last figures can dress it at first open');
  q.api.afterPaint(c0);
  await wait(10);
  ok(q.calls.filter((c) => c === 'GET estimate').length === 0, '7.9 and need no read');
  q.api.forgetQuote('alpha');
  ok(/disabled/.test(q.api.actions('alpha', 'NEXT', c0)), '7.10 Forget takes the figure with it');
}

section('8. A read-only mirror');
{
  const w = world({ mirror: true });
  await w.api.sync('alpha');
  ok(w.calls.length === 0, '8.1 asks nothing');
  ok(w.api.actions('alpha', 'NEXT', c0) === 'NEXT', '8.2 offers nothing');
  ok(w.api.reading('alpha') === null && w.api.line('alpha') === '' && !w.api.running('alpha'), '8.3 and says nothing');
  w.api.afterPaint(c0);
  await wait(5);
  ok(w.calls.length === 0, '8.4 and reads no quote');
}

section('9. The buttons');
{
  const w = world({ status: job({ state: 'paused', pauseReason: 'user' }) });
  await w.api.sync('alpha');
  let out = 0;
  w.respond.resume = async () => { out++; await wait(15); w.status = job(); return { job: job() }; };
  const btn = { dataset: { compareDo: 'resume' } };
  ok(w.api.onClick(btn) === true, '9.1 the row answers its own buttons');
  ok(w.api.onClick(btn) === true, '9.2 and a second press in flight is taken and ignored');
  await wait(5);
  ok(/aria-busy/.test(w.api.actions('alpha', 'NEXT', c0)) && /Resuming/.test(w.api.actions('alpha', 'NEXT', c0)), '9.3 the pressed control answers, and Stop waits with it');
  await wait(25);
  ok(out === 1, '9.4 one press, one request', String(out));
  ok(/Pause/.test(w.api.actions('alpha', 'NEXT', c0)), '9.5 running again: Pause, on the same control');
  ok(w.api.onClick({ dataset: {} }) === false, '9.6 any other button is not its business');
  w.mounted = false; await wait(20);

  const s = world({ status: job({ state: 'paused', pauseReason: 'user' }) });
  await s.api.sync('alpha');
  s.respond.stop = () => ({ job: job({ state: 'stopped', stopReason: 'user', finishedAt: 'x' }) });
  s.api.onClick({ dataset: { compareDo: 'stop' } });
  await wait(10);
  ok(s.api.actions('alpha', 'NEXT', c0).includes('NEXT') && s.api.line('alpha') === '', '9.7 Stop: the ordinary row, with nothing to say');
  ok(s.ended === 1, '9.8 and fresh figures are read');

  const e = world({ status: job({ state: 'paused', pauseReason: 'user' }) });
  await e.api.sync('alpha');
  e.respond.resume = new Error('This comparison was confirmed for x, and the model is now y.');
  e.api.onClick({ dataset: { compareDo: 'resume' } });
  await wait(10);
  ok(/confirmed for x/.test(e.notes[0].text) && !/aria-busy/.test(e.api.actions('alpha', 'NEXT', c0)), '9.9 Resume refused: the words stay on the row and the control lets go');
}

section('10. A note outlives its usefulness only until something replaces it');
{
  const stopped = job({ state: 'stopped', stopReason: 'spend-limit', reason: 'Stopped at the limit.', finishedAt: 'T1' });
  const w = world({ status: stopped });
  await w.api.sync('alpha');
  ok(w.api.line('alpha').includes('Stopped at the limit'), '10.1 the stop stays until you act on it');
  ok(w.api.line('alpha').includes('Stopped at the limit'), '10.2 a paint does not clear it');
  w.api.acknowledge('alpha');
  ok(!w.api.line('alpha').includes('Stopped at the limit'), '10.3 a later short run supersedes it');
  const a = world({ status: { state: 'none' } });
  await a.api.sync('alpha');
  ok(a.api.line('alpha', 3).includes('3 pairs to review') && a.api.line('alpha', 3).includes('dm-review-btn'), '10.4 pairs with no row to tick: counted here, with Review');
  ok(a.api.line('alpha', 1).includes('1 pair to review'), '10.5 one');
  ok(a.api.line('alpha', 0) === '', '10.6 no job and no pairs: no line');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
