// Preloaded into the server by scripts/e2e-health-keyed-patch.mjs. Answers the
// Gemini route locally with canned verdicts and refuses every other non-local
// host, so a browser suite can press every paid button without a provider call.
import { appendFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
const LOG = process.env.HEALTH_STUB_LOG;
const log = (o) => { if (LOG) appendFileSync(LOG, JSON.stringify(o) + '\n'); };
const reply = (text) => new Response(JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, totalTokenCount: 1100 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url, opts) => {
  const u = String(url && url.url ? url.url : url);
  let host = '';
  try { host = new URL(u).hostname; } catch { /* a relative URL */ }
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return realFetch(url, opts);
  if (!u.includes('generativelanguage.googleapis.com')) { log({ blocked: u }); return new Response('{}', { status: 503 }); }
  if (!u.includes(':generateContent')) return new Response('{"models":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  const body = JSON.parse(opts.body);
  const sys = JSON.stringify(body.systemInstruction || '');
  const prompt = JSON.stringify(body.contents);
  await new Promise((r) => setTimeout(r, Number(process.env.HEALTH_STUB_LATENCY_MS || 120)));
  if (/orphan/i.test(sys)) {
    const results = [];
    const re = /--- ORPHAN (\d+) \[/g;
    let m;
    while ((m = re.exec(prompt))) results.push({ index: Number(m[1]), home: 'wiki-hub', description: 'Links to a related idea.', confidence: 'high' });
    log({ kind: 'orphans', n: results.length });
    return reply(JSON.stringify({ results }));
  }
  if (/PAIR \d+ ---/.test(prompt)) {
    const pairs = [];
    const re = /--- PAIR (\d+) ---\\nA: \[[a-z]+\/([^\]]+)\][\s\S]*?\\nB: \[[a-z]+\/([^\]]+)\]/g;
    let m;
    while ((m = re.exec(prompt))) pairs.push({ index: Number(m[1]), a: m[2], b: m[3] });
    log({ kind: 'pairs', n: pairs.length });
    return reply(JSON.stringify({ results: pairs.map((p) => {
      const same = p.a.replace(/-(notes|variant)$/, '') === p.b.replace(/-(notes|variant)$/, '') || p.a.replace(/-/g, '') === p.b.replace(/-/g, '');
      return same
        ? { index: p.index, difference: 'none', relation: 'same', confidence: 'high', canonicalSlug: p.a.length >= p.b.length ? p.a : p.b, rationale: 'Both pages describe the same subject.' }
        : { index: p.index, difference: 'different subjects', relation: 'overlap' };
    }) }));
  }
  const results = [];
  const re = /(?:^|\\n)(?:--- )?(?:LINK )?(\d+)[:\]]/g;
  let m;
  while ((m = re.exec(prompt)) && results.length < 200) results.push({ index: Number(m[1]), target: null, confidence: 'low' });
  log({ kind: 'other', n: results.length });
  return reply(JSON.stringify({ results }));
};
