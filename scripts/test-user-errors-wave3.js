#!/usr/bin/env node
/**
 * scripts/test-user-errors-wave3.js — v3.99.2, wave 3 of plain-language errors.
 *
 *   §1 The support line shows the message's CATALOGUE code (net.js, one place):
 *      "Technical detail (for support): <detail> (code: x)" or "… code: x";
 *      a code outside the catalogue (an errno, an adapter code, a view code)
 *      is never shown as one. Every render path carries it: renderUserError,
 *      renderErrorDetail, errorDetailHtml / plainError, loudWithDetail, and a
 *      body rebuilt from a remembered sentence.
 *   §2 The catalogue's code list agrees with the source: every sync code
 *      sync.js emits is in SYNC_CODES and every listed one is emitted.
 *   §3 Per-surface wording: { area: 'sharedbrain', surface: 'admin' } gives a
 *      REAL GitHubAdapterError 401 the admin's next step (not "re-join with
 *      your invite"), the code unchanged; the control it names exists.
 *   §4 Routes: GET /:id/members?surface=admin over the REAL router with a
 *      GitHub 401 answers in the admin's words; without it, the member's. The
 *      revoke catch's frame is admin-worded.
 *   §5 Miss paths scrub absolute paths: the REAL ingest and compile routes,
 *      driven to a non-catalogue error carrying a home path, send no path;
 *      sharedbrain's and health's frame builders the same.
 *   §6 The wizard's token check shows the detail line (setValidation) and the
 *      Update failed box is valid HTML.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function section(t) { console.log(`\n${t}`); }
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${extra !== undefined ? `  [${typeof extra === 'string' ? extra : JSON.stringify(extra)}]` : ''}`); }
}
const HOME_RE = /\/Users\/|alice smith|\/home\//;

// ── Isolation, BEFORE any brain module is imported ─────────────────────────
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-user-errors-wave3-'));
const DOMAINS = path.join(TMP, 'domains');
const USERDATA = path.join(TMP, 'userdata');
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(USERDATA, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USERDATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_LOG_DIR = path.join(USERDATA, 'logs');
process.env.CURATOR_NO_OPEN = '1';
delete process.env.LLM_MODEL;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;
writeFileSync(path.join(USERDATA, '.curator-config.json'), JSON.stringify({
  anthropicApiKey: 'zz-fake-anthropic-key-for-tests',
  activeProvider: 'anthropic',
}) + '\n');

const net = await import('../src/public/next/shared/net.js');
const SHARED = await import('../src/public/next/shared/user-errors.js');
const UE = await import('../src/brain/user-errors.js');

try {
  // ═══════════════════════════════════════════════════════════════════════
  section('§1 the support line ends with the catalogue code');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const { supportLineText, renderErrorDetail, renderUserError, plainError, errorDetailHtml, errorDetailOf,
      rememberErrorDetail, loudWithDetail, DETAIL_PREFIX } = net;
    ok(supportLineText('invalid x-api-key', 'ai-key-rejected') === DETAIL_PREFIX + 'invalid x-api-key (code: ai-key-rejected)',
      'detail + code → "<detail> (code: …)"', supportLineText('invalid x-api-key', 'ai-key-rejected'));
    ok(supportLineText('', 'server-unreachable') === DETAIL_PREFIX + 'code: server-unreachable', 'code only → "code: …"');
    ok(supportLineText('raw', '') === DETAIL_PREFIX + 'raw', 'detail only → the detail, unchanged');
    ok(supportLineText('', '') === '' && supportLineText(null, undefined) === '', 'neither → nothing');
    for (const c of ['EACCES', 'SHARED_BRAIN_AUTH', 'manifest-newer', 'shape', 'x', 'INDEX_PLAN_STALE', '<b>']) {
      ok(supportLineText('raw', c) === DETAIL_PREFIX + 'raw' && supportLineText('', c) === '', `a non-catalogue code (${c}) is never shown`);
    }
    ok(supportLineText('raw', 'sync-token-rejected').endsWith('(code: sync-token-rejected)'), 'a sync code is a catalogue code');
    ok(renderErrorDetail('a<b', 'ai-key-rejected') === '<div class="tx-error-detail">' + DETAIL_PREFIX + 'a&lt;b (code: ai-key-rejected)</div>',
      'renderErrorDetail(detail, code): escaped, the code at the end');
    ok(renderErrorDetail('a<b') === '<div class="tx-error-detail">' + DETAIL_PREFIX + 'a&lt;b</div>', 'renderErrorDetail(detail) alone is byte-identical to before');

    const body = UE.toUserError(Object.assign(new Error("EACCES: permission denied, open '/Users/alice smith/v/wiki/a.md'"), { code: 'EACCES', syscall: 'open', path: '/Users/alice smith/v/wiki/a.md' }));
    ok(body && body.code === 'files-not-allowed', 'a real-shaped server body', body);
    const html = renderUserError(body);
    ok(html.includes('(code: files-not-allowed)</div>') && html.includes('tx-error-detail'), 'renderUserError(server body) shows the code at the end of the detail line', html);
    ok(!HOME_RE.test(html), '…and still no home path');

    // health.js's frames pass a raw errno through as `code` (own !== undefined)
    const healthLike = { error: 'Plain words.', detail: 'EACCES: permission denied', code: 'EACCES' };
    ok(!/code:/.test(renderUserError(healthLike)), 'a raw errno passed as `code` is not shown as a catalogue code', renderUserError(healthLike));

    const s = plainError({ error: "EPERM: operation not permitted, open '/Users/x/vault/wiki/a.md'" });
    ok(/\(code: files-not-allowed\)<\/div>$/.test(errorDetailHtml(s)), 'plainError + errorDetailHtml: the remembered code is shown', errorDetailHtml(s));
    ok(errorDetailHtml('Another sentence.') === '', 'a different message never inherits a code');
    const rebuilt = renderUserError({ error: s, detail: errorDetailOf(s) }, { title: 'Could not save' });
    ok(rebuilt.includes('(code: files-not-allowed)'), 'a body rebuilt from a remembered sentence (settings.js idiom) still finds its code', rebuilt);

    const unreachable = plainError(new TypeError('Failed to fetch'));
    ok(errorDetailOf(unreachable) === '' && errorDetailHtml(unreachable).includes('code: server-unreachable'),
      'a message with no detail but a code: the line is the code alone', errorDetailHtml(unreachable));
    const loud = loudWithDetail({ tone: 'danger', text: unreachable });
    ok(loud.length === 2 && loud[1].text === DETAIL_PREFIX + 'code: server-unreachable', 'loudWithDetail carries a code-only line', loud);
    rememberErrorDetail('Error: composed.', 'raw text', 'EACCES');
    ok(errorDetailHtml('Error: composed.') === '<div class="tx-error-detail">' + DETAIL_PREFIX + 'raw text</div>', 'rememberErrorDetail drops a non-catalogue code');
    rememberErrorDetail('Only an internal code.', '', 'manifest-newer');
    ok(errorDetailHtml('Only an internal code.') === '', '…and with no detail, nothing is remembered for it');
    const deliberate = plainError({ error: 'Pull first, then push.', code: 'sync-remote-ahead' });
    ok(deliberate === 'Pull first, then push.' && errorDetailHtml(deliberate).includes('code: sync-remote-ahead'),
      'a deliberate sentence passes unchanged and its catalogue code is shown', errorDetailHtml(deliberate));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§2 the catalogue code list agrees with the source');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const { CATALOGUE_CODES, SYNC_CODES, KLASS_CODES, isCatalogueCode } = SHARED;
    ok(Object.values(KLASS_CODES).every((c) => CATALOGUE_CODES.includes(c)), 'every klass code is in the catalogue');
    ok(SYNC_CODES.every((c) => CATALOGUE_CODES.includes(c)), 'every sync code is in the catalogue');
    ok(UE.isCatalogueCode === isCatalogueCode && UE.CATALOGUE_CODES === CATALOGUE_CODES, 'the server re-exports the same list');
    const syncSrc = readFileSync(path.join(ROOT, 'src/brain/sync.js'), 'utf8') + readFileSync(path.join(ROOT, 'src/routes/sync.js'), 'utf8');
    // The codes sync emits are the literals next to a code key, a refusal() call, or curatorSyncCode.
    const emitted = new Set([...syncSrc.matchAll(/(?:code\s*[:=]\s*|refusal\(\s*|curatorSyncCode\s*[:=]\s*|Code\s*[:=]\s*)'(sync-[a-z0-9-]+)'/g)].map((m) => m[1]));
    const anyLiteral = new Set([...syncSrc.matchAll(/'(sync-[a-z0-9-]+)'/g)].map((m) => m[1]));
    ok(emitted.size >= 5, `control: the scan finds sync codes in the source (${emitted.size})`, [...emitted]);
    const missing = [...emitted].filter((c) => !SYNC_CODES.includes(c));
    ok(missing.length === 0, 'every sync code the source emits is in SYNC_CODES', missing);
    const stale = SYNC_CODES.filter((c) => !anyLiteral.has(c));
    ok(stale.length === 0, 'every SYNC_CODES entry is a literal in the sync source (no stale entries)', stale);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§3 per-surface wording: an admin\'s dead GitHub token');
  // ═══════════════════════════════════════════════════════════════════════
  const { GitHubStorageAdapter } = await import('../src/brain/sharedbrain-github-adapter.js');
  const gh = (status, message) => new GitHubStorageAdapter({
    owner: 'cohort', repo: 'brain', pat: 'github_pat_FAKE_SECRET_DONOTLEAK_zZ123456789',
    fetchImpl: async () => new Response(JSON.stringify({ message }), { status, headers: { 'content-type': 'application/json' } }),
  });
  let e401 = null;
  try { await gh(401, 'Bad credentials').readPage('d', 'concepts/x.md'); } catch (e) { e401 = e; }
  {
    ok(e401 && e401.name === 'GitHubAdapterError' && e401.code === 'SHARED_BRAIN_AUTH', 'control: the adapter really threw SHARED_BRAIN_AUTH', e401 && e401.code);
    const member = UE.toUserError(e401, { area: 'sharedbrain' });
    const admin = UE.toUserError(e401, { area: 'sharedbrain', surface: 'admin' });
    // v3.99.2 (Replace token): both wordings now name Replace token on the card;
    // re-joining was never possible (connectionClash refuses a second membership).
    ok(member && /Replace token/.test(member.error) && !/re-join|Set up another/.test(member.error), 'the default (member) wording names Replace token, never re-join', member && member.error);
    ok(admin && admin.code === 'github-token-rejected' && admin.code === member.code, 'admin: the code is unchanged', admin && admin.code);
    ok(admin && !/re-join|your invite|Set up another/.test(admin.error) && /Replace token/.test(admin.error) && /new token on GitHub/.test(admin.error)
      && /admin token stays/.test(admin.error) && admin.error !== member.error,
      'admin: the admin\'s own words (a new token that can write, Replace token, the admin token untouched), never re-join or the refused setup', admin && admin.error);
    ok(admin && admin.detail === member.detail && !admin.detail.includes('github_pat_'), 'admin: the same sanitised detail');
    const byText = UE.toUserError(e401.message, { area: 'sharedbrain', surface: 'admin' });
    ok(byText && byText.error === admin.error, 'admin: the same sentence from the text alone (a route\'s err.message)');
    // (readPage answers a 404 with null, a missing page; the tree read is the
    // shape a vanished repository produces)
    const nf = UE.toUserError('GitHub GET git/trees/main → 404: Not Found', { area: 'sharedbrain', surface: 'admin' });
    ok(nf && nf.code === 'github-not-found' && !/person who invited you/.test(nf.error), 'admin 404: not "ask the person who invited you"', nf && nf.error);
    const other = UE.toUserError(e401, { area: 'sharedbrain', surface: 'no-such-surface' });
    ok(other && other.error === member.error, 'an unknown surface falls back to the global sentence');
    const wrongArea = UE.toUserError(e401, { area: 'sync', surface: 'admin' });
    ok(wrongArea && wrongArea.error === member.error, 'a surface is looked up inside its area only');
    ok(UE.toUserError(new Error('Domain "x" not found'), { area: 'sharedbrain', surface: 'admin' }) === null, 'a deliberate message still passes (null)');
    const sharedView = readFileSync(path.join(ROOT, 'src/public/next/views/shared.js'), 'utf8');
    ok(sharedView.includes("'+ Set up another'") || sharedView.includes('>+ Set up another<'), 'the control the admin sentence names exists on the Shared Brain page');
    // the surface sentences pass the catalogue's plain-words rule too
    const RAW = /\b(?:401|403|404|ENOENT|HEAD|stderr|ref)\b|HTTP \d{3}/;
    for (const [area, bySurface] of Object.entries(SHARED.SURFACE_MESSAGES)) {
      for (const [surface, byKlass] of Object.entries(bySurface)) {
        for (const [klass, fn] of Object.entries(byKlass)) {
          ok(klass in SHARED.USER_MESSAGES && !RAW.test(fn({})), `${area}/${surface}/${klass}: a real klass, plain words`);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§4 routes: the members list and the revoke catch, admin-worded');
  // ═══════════════════════════════════════════════════════════════════════
  const { default: express } = await import('express');
  const { __setDomainsDirOverride } = await import('../src/brain/config.js');
  __setDomainsDirOverride(DOMAINS);
  const sbRoutes = await import('../src/routes/sharedbrain.js');
  const app = express();
  app.use(express.json());
  app.use('/api', UE.userErrorBodies);
  app.use('/api/sharedbrain', sbRoutes.default);
  app.use('/api/ingest', (await import('../src/routes/ingest.js')).default);
  app.use('/api/compile', (await import('../src/routes/compile.js')).default);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  try {
    // GitHub answers 401 to everything; every other request is real.
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(url, init);
    };
    const post = (p, b) => realFetch(`${BASE}/api/sharedbrain${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
    await post('/enable-flag');
    const saved = await (await post('/save', { connection: {
      label: 'Wave 3', storage_type: 'github', github_repo_owner: 'cohort', github_repo_name: 'brain',
      github_pat: 'github_pat_FAKE_SECRET_DONOTLEAK_zZ123456789', fellow_display_name: 'Admin',
      shared_domain: 'work-ai', shared_brain_slug: 'wave-three', local_domains: [],
    } })).json();
    const id = saved && saved.connection && saved.connection.id;
    ok(!!id, 'control: a GitHub-backed connection was saved', saved);

    const asAdmin = await realFetch(`${BASE}/api/sharedbrain/${id}/members?surface=admin`);
    const a = await asAdmin.json();
    ok(asAdmin.status === 502 || asAdmin.status === 500, 'members (admin): the failure status is unchanged', asAdmin.status);
    ok(a.code === 'github-token-rejected' && /admin token stays/.test(a.error) && !/re-join/.test(a.error), 'members?surface=admin: the admin\'s words, the same code', a);
    ok(typeof a.detail === 'string' && !a.detail.includes('github_pat_') && !HOME_RE.test(a.detail), 'members (admin): detail carries no token or path', a.detail);
    const asMember = await (await realFetch(`${BASE}/api/sharedbrain/${id}/members`)).json();
    ok(asMember.code === 'github-token-rejected' && /Replace token/.test(asMember.error) && !/admin token stays/.test(asMember.error), 'members without ?surface: the default wording (token check, others)', asMember);
    const bogus = await (await realFetch(`${BASE}/api/sharedbrain/${id}/members?surface=__proto__`)).json();
    ok(bogus.error === asMember.error, 'an unknown ?surface value selects nothing (allow-list)', bogus);

    const fr = sbRoutes.__testing.errorFrame(e401, 'admin');
    ok(fr.type === 'error' && fr.code === 'github-token-rejected' && /admin token stays/.test(fr.message), 'the revoke catch frame (surface admin): admin words', fr);
    const frDefault = sbRoutes.__testing.errorFrame(e401);
    ok(/Replace token/.test(frDefault.message) && !/admin token stays/.test(frDefault.message), 'push/pull/synthesize frames: the default (member) wording');
    const revokeSrc = readFileSync(path.join(ROOT, 'src/routes/sharedbrain.js'), 'utf8');
    const revokeBlock = revokeSrc.slice(revokeSrc.indexOf("router.post('/:id/revoke'"), revokeSrc.indexOf('// ── Invite-token utilities'));
    ok(/errorFrame\(err, 'admin'\)/.test(revokeBlock), 'cross-check: the revoke route\'s catch passes the admin surface');

    // ═════════════════════════════════════════════════════════════════════
    section('§5 a miss keeps today\'s text, with home paths scrubbed');
    // ═════════════════════════════════════════════════════════════════════
    const RAW_PATH_MSG = "Could not prepare the batch from '/Users/alice smith/Google Drive/vault/wiki/log.md' just now";
    ok(UE.toUserError(new Error(RAW_PATH_MSG), { area: 'ai' }) === null, 'control: the catalogue does not recognise this message (a miss)');
    const llm = await import('../src/brain/llm.js');
    llm.__setAnthropicClientFactory(() => ({ messages: { stream: () => { throw new Error(RAW_PATH_MSG); }, create: async () => { throw new Error(RAW_PATH_MSG); } } }));
    const { createDomain } = await import('../src/brain/files.js');
    await createDomain('alpha', 'Alpha', 'A throwaway domain.', 'generic');
    const frames = async (res) => (await res.text()).split('\n').filter((l) => l.startsWith('data:'))
      .map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);

    const fd = new FormData();
    fd.append('domain', 'alpha');
    fd.append('file', new Blob(['# Widget\n\n' + 'The widget is made of brass and has three gears. '.repeat(40)], { type: 'text/markdown' }), 'w.md');
    const ing = (await frames(await realFetch(`${BASE}/api/ingest`, { method: 'POST', body: fd }))).find((f) => f.type === 'error');
    ok(!!ing && typeof ing.message === 'string', 'ingest: an error frame arrived', ing);
    ok(ing && /Could not prepare the batch from/.test(ing.message) && !HOME_RE.test(ing.message) && /log\.md/.test(ing.message),
      'ingest miss: today\'s text, the home path reduced to the basename', ing && ing.message);

    const CONV = '00000001-0000-4000-8000-000000000000';
    mkdirSync(path.join(DOMAINS, 'alpha', 'conversations'), { recursive: true });
    writeFileSync(path.join(DOMAINS, 'alpha', 'conversations', `${CONV}.json`), JSON.stringify({
      id: CONV, title: 'A talk', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
      messages: [{ role: 'user', content: 'What is the widget made of?' }, { role: 'assistant', content: 'Brass, with three gears.', citations: [] }],
    }));
    const cmp = (await frames(await realFetch(`${BASE}/api/compile/conversation`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'alpha', conversationId: CONV }),
    }))).find((f) => f.type === 'error');
    ok(!!cmp && typeof cmp.message === 'string', 'compile: an error frame arrived', cmp);
    ok(cmp && /Could not prepare the batch from/.test(cmp.message) && !HOME_RE.test(cmp.message),
      'compile miss: today\'s text, no home path', cmp && cmp.message);

    const { __errorFrameForTest: compileFrame } = await import('../src/routes/compile.js');
    const cMiss = compileFrame(new Error(RAW_PATH_MSG), RAW_PATH_MSG);
    ok(/Could not prepare the batch from/.test(cMiss.message) && !HOME_RE.test(cMiss.message), 'compile catch frame (a throw): no home path', cMiss.message);
    const sbMiss = sbRoutes.__testing.errorFrame(new Error(RAW_PATH_MSG));
    ok(/Could not prepare the batch from/.test(sbMiss.message) && !HOME_RE.test(sbMiss.message), 'sharedbrain miss frame: no home path', sbMiss.message);
    const { __errorFrameForTest: healthFrame } = await import('../src/routes/health.js');
    const h1 = healthFrame(Object.assign(new Error(RAW_PATH_MSG), { code: 'INDEX_UNREADABLE' }), true);
    ok(!HOME_RE.test(h1.error) && /log\.md/.test(h1.error) && h1.code === 'INDEX_UNREADABLE', 'health miss frame (with code): no home path, its own code kept', h1);
    const h2 = healthFrame(new Error(RAW_PATH_MSG), false);
    ok(!HOME_RE.test(h2.error) && !('code' in h2), 'health miss frame (no code): no home path', h2);
    const plainMsg = 'Domain "alpha" not found';
    ok(healthFrame(new Error(plainMsg), false).error === plainMsg && sbRoutes.__testing.errorFrame(new Error(plainMsg)).message === plainMsg,
      'a deliberate sentence with no path is byte-identical on a miss');

    // v3.99.2 audit: the OpenRouter qualify stream was the last raw SSE frame.
    const { __qualifyErrorFrameForTest: qualifyFrame } = await import('../src/routes/config.js');
    const SK = ['sk', 'or', 'v1', 'f'.repeat(40)].join('-');
    const q1 = qualifyFrame(new Error(`OpenRouter chat → HTTP 401: {"error":{"message":"bad key ${SK}"}}`));
    ok(q1.type === 'error' && /didn't accept the API key/.test(q1.error) && q1.code === 'ai-key-rejected', 'qualify frame: a raw OpenRouter 401 is the plain key sentence', q1);
    ok(/HTTP 401/.test(q1.detail) && !q1.detail.includes(SK), '…its raw text is the detail, without the key', q1.detail);
    const q2 = qualifyFrame(Object.assign(new Error(RAW_PATH_MSG), { code: 'MODEL_GONE' }));
    ok(q2.code === 'MODEL_GONE' && !HOME_RE.test(q2.error) && !('detail' in q2), 'qualify frame miss: its own code kept, home path scrubbed, no detail', q2);
    const q3 = qualifyFrame(Object.assign(new Error("EACCES: permission denied, open '/Users/alice/x/q.json'"), { code: 'EACCES', syscall: 'open', path: '/Users/alice/x/q.json' }));
    ok(q3.code === 'EACCES' && /didn't let The Curator use a file/.test(q3.error), 'qualify frame: a raw errno code is never replaced', q3);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((r) => server.close(r));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§6 the wizard\'s token check and the Update failed box');
  // ═══════════════════════════════════════════════════════════════════════
  {
    await import('./test-helpers/net-globals.js');
    const wizard = readFileSync(path.join(ROOT, 'src/public/next/views/shared-brain-wizard.js'), 'utf8');
    const lift = (src, name) => {
      const start = src.indexOf('function ' + name + '(');
      let i = src.indexOf('{', start), depth = 0;
      for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
      return src.slice(start, i + 1);
    };
    const step3 = lift(wizard, 'bindStep3');
    const setValidationSrc = lift(step3, 'setValidation');
    const mk = (tag) => ({ tag, className: '', textContent: '', children: [], ownerDocument: null,
      classList: { remove() {}, add() {} }, appendChild(c) { this.children.push(c); } });
    const doc = { createElement: (t) => mk(t) };
    const validation = mk('div'); validation.ownerDocument = doc;
    const setValidation = new Function('validation',
      lift(wizard, 'appendSupportLine') + '\n' + setValidationSrc + '\nreturn setValidation;')(validation);
    const patVerdict = new Function(lift(wizard, 'patVerdict') + '\nreturn patVerdict;')();
    // A thrown error the server translated (apiErrorHandler): {error, detail, code}, no `valid`.
    const v = patVerdict({ error: 'Something went wrong inside The Curator. Try again.', detail: 'TypeError: x is not a function', code: 'internal-error' }, {});
    setValidation(v.kind, v.message, v.support);
    ok(validation.textContent === 'Something went wrong inside The Curator. Try again.', 'the sentence is the status text, unchanged');
    ok(validation.children.length === 1 && validation.children[0].className === 'tx-error-detail' &&
      validation.children[0].textContent === 'Technical detail (for support): TypeError: x is not a function (code: internal-error)',
      'setValidation: the detail line (with its code) under the sentence, as text', validation.children.map((c) => c.textContent));
    const v2 = patVerdict({ valid: false, error: 'GitHub rejected the token (401/403). Re-paste it.' }, {});
    ok(!('support' in v2), 'the route\'s own rejection (no detail, no code) has no support line', v2);
    const val2 = mk('div'); val2.ownerDocument = doc;
    new Function('validation', lift(wizard, 'appendSupportLine') + '\n' + setValidationSrc + '\nreturn setValidation;')(val2)(v2.kind, v2.message, v2.support);
    ok(val2.children.length === 0, '…and nothing is appended for it');
    ok(/setValidation\(verdict\.kind, verdict\.message, verdict\.support\)/.test(step3) &&
      /setValidation\('error', 'Could not check your token\. ' \+ u\.error, supportLineText\(u\.detail, u\.code\)\)/.test(step3),
      'cross-check: both failure paths in bindStep3 pass the support line');

    const settings = readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');
    const boxFn = new Function('escapeHtml', lift(settings, 'box') + '\nreturn box;')(
      (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
    const detail = net.renderErrorDetail('git fetch failed', 'git-other');
    const html = boxFn('upd-bad', 'Update failed', 'Plain sentence.', null, 'Nothing was restarted.', null, detail);
    ok(!/<span>[^]*?<div class="tx-error-detail"/.test(html.replace(/<span class="upd-[a-z]+">[^<]*<\/span>/g, '')) &&
      html.includes('<div>Plain sentence.' + detail + '</div>'), 'box(…, supportHtml): the line sits in a <div> body, never a <div> inside a <span>', html);
    const noSupport = boxFn('upd-bad', 'Update failed', 'Plain sentence.', null, 'Nothing was restarted.');
    ok(noSupport.includes('<span>Plain sentence.</span>'), 'box without supportHtml: byte-identical body span', noSupport);
    const failedBranch = settings.slice(settings.indexOf("if (state.updatePhase === 'failed')"), settings.indexOf("const v = classifyUpdate(state.updateCheck"));
    ok(/box\('upd-bad', 'Update failed', escapeHtml\(state\.updateError \|\| 'Unknown error\.'\),/.test(failedBranch) &&
      /errorDetailHtml\(state\.updateError\)\);/.test(failedBranch) && !/'Unknown error\.'\) \+ errorDetailHtml/.test(failedBranch),
      'cross-check: the Update failed branch passes the detail as supportHtml, not inside the body');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§7 Settings leftovers (agent F): the trash read, the install apply');
  // ═══════════════════════════════════════════════════════════════════════
  {
    await import('./test-helpers/net-globals.js');
    const { stripComments, functionSource } = await import('./test-helpers/source-scan.js');
    const settings = stripComments(readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8'));
    const TR = await import('../src/public/next/views/trash-list.js');
    const MI = await import('../src/public/next/views/mcp-install.js');
    const fn = (name) => { const f = functionSource(settings, name); if (!f) throw new Error(name + ' not found'); return f; };

    // 5a: an empty reply to GET /api/trash: the fallback is read after the
    // section's own "Could not read the trash: " prefix.
    const emptyConst = /\nconst TRASH_EMPTY_REPLY = [^\n]+;/.exec(settings);
    ok(!!emptyConst, 'trash: the empty-reply sentence is a named constant beside loadTrash');
    const loadTrash = new Function('fetch', 'state', 'isCurrentMount', 'render',
      (emptyConst ? emptyConst[0] : '') + '\n' + fn('loadTrash') + '\nreturn loadTrash;');
    for (const [label, res] of [
      ['an empty 500 reply', { ok: false, status: 500, json: async () => ({}) }],
      ['a 200 reply with no entries', { ok: true, status: 200, json: async () => ({}) }],
    ]) {
      const st = { trash: null, trashError: null };
      await loadTrash(async () => res, st, () => true, () => {})(1);
      const html = TR.trashSectionHtml({ data: null, error: st.trashError });
      ok(typeof st.trashError === 'string' && st.trashError.length > 10, `trash (${label}): a sentence is stored`, st.trashError);
      ok(!/Could not read the trash[^]*Could not read the trash/.test(html), `trash (${label}): never "Could not read the trash" twice`, html);
      ok(!/HTTP \d{3}/.test(st.trashError), `trash (${label}): no status number in the sentence`, st.trashError);
    }
    const st500 = { trash: null, trashError: null };
    await loadTrash(async () => ({ ok: false, status: 500, json: async () => ({}) }), st500, () => true, () => {})(1);
    ok(net.errorDetailOf(st500.trashError) === 'HTTP 500', 'trash: the status is the support detail, not the sentence', net.errorDetailOf(st500.trashError));
    const stRaw = { trash: null, trashError: null };
    await loadTrash(async () => ({ ok: false, status: 500, json: async () => ({ error: "EACCES: permission denied, open '/Users/x/.curator-trash/a'" }) }), stRaw, () => true, () => {})(1);
    ok(/^This computer didn't let The Curator use a file/.test(stRaw.trashError), 'trash: CONTROL a server message still wins over the fallback', stRaw.trashError);

    // 5b: a failed apply keeps the detail failureWords remembered.
    const mi = { busy: null, plan: { action: 'install', token: 't', items: [] }, error: null };
    const applyInstall = new Function('state', 'isCurrentMount', 'render', 'requestApply', 'failureWords', 'loadInstallStatus',
      fn('applyInstall') + '\nreturn applyInstall;')(
      { mcpInstall: mi }, () => true, () => {},
      async () => ({ ok: false, code: 'write-failed', message: 'The setup file could not be written.', detail: "EACCES: permission denied, open '~/x.json'" }),
      MI.failureWords, () => {});
    await applyInstall(1);
    ok(/Nothing was changed\. Preview again to continue\.$/.test(mi.error || ''), 'install apply: CONTROL the composed sentence', mi.error);
    ok(net.errorDetailHtml(mi.error).includes("EACCES: permission denied, open '~/x.json'".replace(/'/g, '&#39;')),
      'install apply: the composed sentence keeps its technical detail', net.errorDetailHtml(mi.error));

    // item 7: the OpenRouter qualify stream's error frame goes through net.js.
    const qState = { qualify: null, qualifyAbort: null, qualifyTickId: null };
    const RAW_OR = 'OpenRouter /chat/completions → HTTP 401: {"error":{"message":"No auth credentials found","code":401}}';
    const onQualifyGo = new Function('state', 'fetch', 'isCurrentMount', 'render', 'stopQualifyClock', 'setInterval',
      fn('onQualifyGo') + '\nreturn onQualifyGo;')(qState,
      async () => new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode('event: error\ndata: ' + JSON.stringify({ error: RAW_OR }) + '\n\n')); c.close(); } }), { status: 200 }),
      () => true, () => {}, () => {}, () => 0);
    await onQualifyGo('m/x', 1);
    const qe = qState.qualify && qState.qualify.error;
    ok(qState.qualify && qState.qualify.phase === 'error' && typeof qe === 'string', 'qualify: CONTROL the error frame ends the run', qState.qualify);
    ok(!/HTTP 401|\{"error"/.test(qe) && net.errorDetailOf(qe).includes('No auth credentials found'),
      'qualify: a raw provider error frame becomes the sentence, the raw text its detail', qe);
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
