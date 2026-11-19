#!/usr/bin/env node
/**
 * test-context-plain-errors.js — v3.99.2, plain-language errors on the
 * Context page and its pure modules (agent C4).
 *
 * The person sees the plain sentence AND, where there is one, the visible
 * "Technical detail (for support):" line. Driven through the REAL modules:
 *   - shared/foundations-init.js: failText (the Context page's reading rule:
 *     `message` before a bare code word in `error`), withDetailOf, supportOf,
 *     errorLines; scanRepo / scanRemote / pickFolder against a fake fetch; the
 *     chooser's scan and picker refusals in its rendered HTML;
 *   - shared/foundations-add.js: readCommitResponse and renderAddPanel;
 *   - shared/foundations-sources.js: refreshOutcome's failed-group line;
 *   - views/ws-delete.js: the delete card's two refusals;
 *   - views/trash-list.js: the delete card, a refused restore, a failed read.
 *
 * The detail line's exact markup belongs to net.js (it may grow the error's
 * code later), so every render assertion compares against net.js's own
 * renderErrorDetail output, never a pinned string. Offline; no DOM, no
 * network, no writes.
 */

import { renderErrorDetail, errorDetailOf, errorCodeOf, plainError, DETAIL_PREFIX } from '../src/public/next/shared/net.js';

const FI = await import('../src/public/next/shared/foundations-init.js');
const FA = await import('../src/public/next/shared/foundations-add.js');
const FSRC = await import('../src/public/next/shared/foundations-sources.js');
const WS = await import('../src/public/next/views/ws-delete.js');
const TR = await import('../src/public/next/views/trash-list.js');

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '\n      ' + String(extra).slice(0, 600) : '')); }
}
function section(t) { console.log('\n' + t); }

// A raw file-system failure as Node prints it, with a home folder in it: the
// shape the inventory found reaching the Context page unscrubbed.
const RAW = "EACCES: permission denied, open '/Users/somebody/Library/Mobile Documents/brain/domains/d/state/p/project.json'";
const HTTPISH = /HTTP \d{3}|\(HTTP/;
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

section('1. failText — the Context page\'s one reading rule');
{
  const a = FI.failText({ ok: false, error: 'invalid-scope', message: '"x y" is not a usable scope name.' }, 400, 'F.');
  ok('a bare code word in `error` gives way to the sentence in `message`', a === '"x y" is not a usable scope name.', a);
  ok('...and a deliberate sentence carries no detail', errorDetailOf(a) === '', errorDetailOf(a));

  const b = FI.failText({ ok: false, error: 'Another write is in progress on this project. Try again in a moment.' }, 409, 'F.');
  ok('deliberate prose in `error` passes UNCHANGED',
    b === 'Another write is in progress on this project. Try again in a moment.', b);

  const c = FI.failText({ ok: false, message: RAW }, 500, 'The brief could not be saved.');
  ok('a raw fs message becomes the catalogue sentence, never the raw text',
    !c.includes('EACCES') && !c.includes('/Users/') && c.length > 20, c);
  const cd = errorDetailOf(c);
  ok('...its raw text is kept as the detail', cd.includes('EACCES'), cd);
  ok('...with the home folder taken out', !cd.includes('/Users/somebody') && cd.includes('~'), cd);

  const d = FI.failText(null, 502, 'The brief could not be saved.');
  ok('a reply with no body says the SITE\'s sentence, never a status', d === 'The brief could not be saved.', d);
  ok('...and the status is the detail', errorDetailOf(d) === 'HTTP 502', errorDetailOf(d));
  const e = FI.failText({}, 500, 'The reading budget could not be saved.');
  ok('an empty object body says the site\'s sentence too', e === 'The reading budget could not be saved.', e);

  const f = FI.failText({ ok: false, error: 'too_many_domains' }, 400, 'F.');
  ok('CONTROL: a code word with no message at all is not replaced by the fallback (the caller maps codes)',
    f === 'too_many_domains', f);

  const composed = FI.withDetailOf('Not changed: ' + c, c);
  ok('withDetailOf: a composed sentence carries the inner error\'s detail', errorDetailOf(composed) === cd, errorDetailOf(composed));
  ok('supportOf: the status box\'s third line is the prefixed detail', FI.supportOf(c) === DETAIL_PREFIX + cd, FI.supportOf(c));
  ok('supportOf: nothing for a sentence with no detail', FI.supportOf(a) === '');
  const lines = FI.errorLines(c);
  ok('errorLines: a toast gets the sentence, then the detail line',
    lines.length === 2 && lines[0] === c && lines[1] === DETAIL_PREFIX + cd, JSON.stringify(lines));
  ok('errorLines: just the sentence when there is no detail', FI.errorLines(a).length === 1);
}

section('2. The chooser\'s reads (scanRepo, scanRemote, pickFolder)');
{
  const fake = (status, body) => async () => ({ ok: status < 400, status,
    json: async () => { if (body === undefined) throw new SyntaxError('Unexpected token < in JSON at position 0'); return body; } });

  const r1 = await FI.scanRepo('/r', fake(500, { ok: false, error: RAW }));
  ok('scanRepo: a raw failure is a plain sentence', r1.ok === false && !r1.error.includes('EACCES'), r1.error);
  ok('...with its detail remembered', errorDetailOf(r1.error).includes('EACCES'));
  const r2 = await FI.scanRepo('/r', fake(502, undefined));
  ok('scanRepo: a non-JSON reply says the site\'s sentence, never "HTTP 502"',
    r2.error === 'The folder could not be listed.' && errorDetailOf(r2.error) === 'HTTP 502', JSON.stringify(r2));
  const r3 = await FI.scanRepo('/r', fake(400, { ok: false, error: 'That folder is not on this computer.' }));
  ok('scanRepo: the route\'s own refusal passes unchanged', r3.error === 'That folder is not on this computer.', r3.error);

  const s1 = await FI.scanRemote({ remote: 'acme/brain' }, fake(503, undefined));
  ok('scanRemote: an empty reply says the site\'s sentence', s1.error === 'The repository could not be listed.'
    && !HTTPISH.test(s1.error), s1.error);
  const s2 = await FI.scanRemote({ remote: 'acme/brain' }, async () => { throw new Error('Failed to fetch'); });
  ok('scanRemote: a dropped connection is never the browser\'s "Failed to fetch"',
    !/Failed to fetch/.test(s2.error) && s2.error.length > 20, s2.error);

  const p1 = await FI.pickFolder(fake(500, undefined));
  ok('pickFolder: a failed picker with no words says so in words, no status',
    p1.reason === 'failed' && p1.message === 'The folder picker did not answer.' && errorDetailOf(p1.message) === 'HTTP 500',
    JSON.stringify(p1));
  const p2 = await FI.pickFolder(fake(501, { ok: false, reason: 'no-dialog', message: 'no bridge', hint: 'type it' }));
  ok('CONTROL: pickFolder keeps the route\'s own words', /no bridge type it/.test(p2.message), p2.message);

  // The chooser paints the detail under the refusal it belongs to.
  const scanErr = plainError(RAW);
  const html = FI.renderFoundationsChooser({ id: 'x', choice: {
    ...FI.freshChooser({}), ownership: 'repo', repoRoot: '/r', scanError: scanErr } });
  ok('the chooser\'s scan refusal shows the sentence', html.includes(esc('Nothing was read: ' + scanErr)), html.slice(0, 400));
  ok('...and the technical detail under it, visible (not in a <details>)',
    html.includes(renderErrorDetail(errorDetailOf(scanErr), errorCodeOf(scanErr))) && !html.includes('<details'));
  const plain = FI.renderFoundationsChooser({ id: 'x', choice: {
    ...FI.freshChooser({}), ownership: 'repo', repoRoot: '/r', scanError: 'that folder is not here' } });
  ok('CONTROL: a refusal with no detail has no detail line', !plain.includes('tx-error-detail'));
}

section('3. Adding documents (foundations-add)');
{
  const out = FA.readCommitResponse(500, {}, { door: 'local' });
  ok('a failed commit with no words says the site\'s sentence, never "(HTTP 500)"',
    out.ok === false && out.error === 'The documents could not be added.' && !HTTPISH.test(out.error), out.error);
  ok('...and the status is its detail', errorDetailOf(out.error) === 'HTTP 500');
  const raw = FA.readCommitResponse(500, { ok: false, error: RAW }, { door: 'local' });
  ok('a raw commit failure is the plain sentence', !raw.error.includes('EACCES'), raw.error);

  const facts = { present: true, ownership: 'curator', count: 1, bytes: 1000, budgetBytes: 204800,
    docs: [{ slug: 'architecture.md', source: { kind: 'curator' } }] };
  const rec = Object.assign(FA.freshAddPanel('local', FA.doorsFor(facts).local, facts), {
    domain: 'd', project: 'p', root: '/typed/n', error: raw.error, // A DIFFERENT failure, so its sentence (the key its detail is kept under) differs from the commit's.
    scanError: plainError("ENOENT: no such file or directory, scandir '/Users/somebody/repo/docs'") });
  const html = FA.renderAddPanel(rec, facts, 'local', {});
  ok('the panel\'s commit refusal shows its technical detail',
    html.includes(renderErrorDetail(errorDetailOf(raw.error), errorCodeOf(raw.error))), html.slice(0, 600));
  ok('the panel\'s list refusal ("Nothing was listed: …") shows ITS detail, not the commit\'s',
    rec.scanError !== raw.error && html.includes(renderErrorDetail(errorDetailOf(rec.scanError), errorCodeOf(rec.scanError))));
  const quiet = FA.renderAddPanel(Object.assign({}, rec, { error: 'Pick at least one file.', scanError: null }), facts, 'local', {});
  ok('CONTROL: a refusal with no detail gets no detail line', !quiet.includes('tx-error-detail'));
}

section('4. A refresh group that failed (foundations-sources)');
{
  const { failed: lines } = FSRC.refreshOutcome({ groups: [{ id: 'g1', label: 'docs', ok: false, message: RAW }] }, []);
  ok('the failed line names the group and says, in words, why', lines.length === 1
    && lines[0].startsWith('docs was not refreshed and is unchanged: ') && !lines[0].includes('EACCES'), lines[0]);
  ok('...and the raw text is that line\'s technical detail', errorDetailOf(lines[0]).includes('EACCES'));
  const { failed: words } = FSRC.refreshOutcome({ groups: [{ id: 'g1', label: 'docs', ok: false,
    message: 'The folder is not on this computer.' }] }, []);
  ok('CONTROL: a written reason passes unchanged',
    words[0] === 'docs was not refreshed and is unchanged: The folder is not on this computer.', words[0]);
}

section('5. Deleting a handoff (ws-delete)');
{
  const NOW = Date.parse('2026-09-25T12:00:00Z');
  const preview = { ok: true, scope: 'main', restoreTo: 'state/', total: 1, otherMachines: 0,
    machines: [{ machine: 'm', isThisMachine: true, hasCurrent: true, headline: 'H', writtenAt: '2026-09-25T11:00:00Z' }] };
  const del = (over) => ({ domain: 'd', project: 'd', scope: 'main', preview, loading: false, loadError: null,
    confirmText: '', busy: false, error: null, ...over });
  const err = plainError({ error: RAW });
  const h1 = WS.wsDeleteCardHtml(del({ error: err }), NOW);
  ok('a refused delete shows the sentence and its detail', h1.includes('Not deleted.</strong> ')
    && h1.includes(renderErrorDetail(errorDetailOf(err), errorCodeOf(err))), h1.slice(-900));
  const loadErr = plainError(RAW + ' (preview)');
  const h2 = WS.wsDeleteCardHtml(del({ preview: null, loadError: loadErr }), NOW);
  ok('a failed preview says nothing was deleted, with its detail',
    h2.includes('Nothing was deleted.') && h2.includes(renderErrorDetail(errorDetailOf(loadErr), errorCodeOf(loadErr))), h2.slice(0, 900));
  ok('CONTROL: a refusal with no detail has no detail line',
    !WS.wsDeleteCardHtml(del({ error: 'Type the exact name.' }), NOW).includes('tx-error-detail'));
}

section('6. The trash (trash-list)');
{
  const now = Date.parse('2026-09-25T18:00:00Z');
  const ready = { id: 'p--2026-09-25T16-00-00Z', kind: 'projects', name: 'proj', domain: 'alpha', project: 'proj',
    deletedAt: '2026-09-25T16:00:00Z', from: 'domains/alpha/state/proj/', status: 'ready',
    bytes: 2048, files: 3, contains: { hasBrief: true, scopes: 2, handoffs: 2 } };
  const restoreErr = plainError({ error: RAW + ' (restore)' });
  const r = TR.trashRowHtml(ready, { nowMs: now, action: { kind: ready.kind, id: ready.id, mode: 'restore', error: restoreErr } });
  ok('a refused restore shows the sentence on its row', r.includes('Not restored.</strong> '), r.slice(0, 600));
  ok('...AND its technical detail (the row renderer used to drop it)', r.includes(renderErrorDetail(errorDetailOf(restoreErr), errorCodeOf(restoreErr))));
  const delErr = plainError({ error: RAW + ' (delete)' });
  const d = TR.trashRowHtml(ready, { nowMs: now, action: { kind: ready.kind, id: ready.id, mode: 'delete', confirmText: '', error: delErr } });
  ok('a refused delete-forever shows its technical detail', d.includes(renderErrorDetail(errorDetailOf(delErr), errorCodeOf(delErr))));
  const readErr = plainError(RAW + ' (read)');
  const s = TR.trashSectionHtml({ data: null, error: readErr });
  ok('a failed read of the trash shows its technical detail', s.includes('Could not read the trash: ')
    && s.includes(renderErrorDetail(errorDetailOf(readErr), errorCodeOf(readErr))), s);
  ok('CONTROL: a failure with no detail has no detail line',
    !TR.trashSectionHtml({ data: null, error: 'boom' }).includes('tx-error-detail'));
}

section('7. The Context page\'s own requests (views/memory.js, lifted and run)');
{
  // memory.js imports app.js (DOM-bound), so its request functions are lifted
  // out of the source and run against a fake fetch, seeing the REAL net.js
  // and foundations-init.js helpers as globals (context-error-globals.js).
  await import('./test-helpers/context-error-globals.js');
  const { readFileSync } = await import('node:fs');
  const { stripComments, functionSource } = await import('./test-helpers/source-scan.js');
  const memSrc = stripComments(readFileSync(new URL('../src/public/next/views/memory.js', import.meta.url), 'utf8'));
  const lift = (name, extra = '') => {
    const body = functionSource(memSrc, name);
    if (!body) throw new Error(name + ' not found in views/memory.js');
    return new Function('fetch', 'isCurrentMount', extra + body + '\nreturn ' + name + ';');
  };
  const fakeFetch = (status, body) => async () => ({ ok: status < 400, status,
    json: async () => { if (body === undefined) throw new SyntaxError('Unexpected end of JSON input'); return body; } });
  const always = () => true;

  const budget = lift('writeReadingBudget')(fakeFetch(500, {}), always);
  const b = await budget('d', 'p', 4096);
  ok('reading budget: a reply with no message says the site\'s sentence, not "HTTP 500"',
    b.ok === false && b.error === 'The reading budget could not be saved.' && !HTTPISH.test(b.error), JSON.stringify(b));
  ok('...with the status as its technical detail', errorDetailOf(b.error) === 'HTTP 500');
  const b2 = await lift('writeReadingBudget')(fakeFetch(500, undefined), always)('d', 'p', 4096);
  ok('reading budget: an unreadable reply is a sentence too, never the JSON parser\'s words',
    !/JSON|Unexpected/.test(b2.error) && errorDetailOf(b2.error).includes('Unexpected end of JSON input'), b2.error);

  const start = lift('writeStartState')(fakeFetch(409, { ok: false, error: 'locked',
    message: 'Another write is in progress on this project. Try again in a moment.' }), always);
  const st = await start('d', 'p', 'a.md', true);
  ok('read-first: a store refusal says its own sentence (message before the code word)',
    st.error === 'Another write is in progress on this project. Try again in a moment.', st.error);

  const ctx = lift('writeContextSettings')(async () => { throw new TypeError('Failed to fetch'); }, always);
  const c = await ctx({ contextWindow: 1 });
  ok('context window: a dropped connection is a sentence, never "Failed to fetch"',
    !/Failed to fetch/.test(c.error) && c.error.length > 20, c.error);

  const state = lift('fetchState')(fakeFetch(500, { ok: false, message: RAW }), always);
  const fs = await state('d', 'p', {}, 1);
  ok('project read: a raw fs failure becomes the plain sentence', !fs.error.includes('EACCES'), fs.error);
  ok('...and its detail is the raw text, home folder removed',
    errorDetailOf(fs.error).includes('EACCES') && !errorDetailOf(fs.error).includes('/Users/somebody'));
  ok('...which the status box shows as its third line', globalThis.supportOf(fs.error) === DETAIL_PREFIX + errorDetailOf(fs.error));

  const idx = lift('fetchIndex')(fakeFetch(502, undefined), always);
  const ix = await idx(1);
  ok('project list: a non-JSON reply (an HTML error page) is a sentence, not a parse error',
    ix && ix.error && !/JSON|Unexpected/.test(ix.error), ix && ix.error);
}

section('8. Leftovers (agent F): the reader overlay and the Setup step show the detail');
{
  const { readFileSync } = await import('node:fs');
  const { stripComments, functionSource } = await import('./test-helpers/source-scan.js');
  const appSrc = stripComments(readFileSync(new URL('../src/public/next/app.js', import.meta.url), 'utf8'));
  const readerErrorHtml = new Function('icon', 'escapeHtml', 'errorDetailHtml',
    functionSource(appSrc, 'readerErrorHtml') + '\nreturn readerErrorHtml;')(() => '<svg></svg>', esc, globalThis.errorDetailHtml);

  // The handoff reader's failure, through the REAL request code: memory.js's
  // openPreviousHandoff, lifted, against a fake fetch, with the payload the
  // reader would be handed recorded.
  const memSrc = stripComments(readFileSync(new URL('../src/public/next/views/memory.js', import.meta.url), 'utf8'));
  const opened = [];
  const openPrev = new Function('fetch', 'openReader', 'isCurrentMount', 'isCurrentReader', 'state', 'previousReaderContent',
    functionSource(memSrc, 'openPreviousHandoff') + '\nreturn openPreviousHandoff;')(
    async () => ({ ok: false, status: 500, json: async () => ({ ok: false, message: RAW }) }),
    (c) => { opened.push(c); return opened.length; }, () => true, () => true,
    { detail: { previous: { path: 'previous.md' }, scope: 's', machine: 'm' }, activeDomain: 'd', activeProject: 'p' }, () => null);
  await openPrev(1);
  const last = opened[opened.length - 1] || {};
  ok('reader: CONTROL the replaced-handoff reader is opened with an error sentence',
    typeof last.error === 'string' && !last.error.includes('EACCES'), last.error);
  const rh = readerErrorHtml(last.error);
  ok('reader: the error shows its technical detail under the sentence',
    rh.includes(renderErrorDetail(errorDetailOf(last.error), errorCodeOf(last.error))) && rh.includes('(code: files-not-allowed)'), rh);
  ok('reader: CONTROL an error with nothing remembered has no detail line', !readerErrorHtml('Plain.').includes('tx-error-detail'));

  const SS = await import('../src/public/next/views/setup-step.js');
  const checkErr = FI.failText({ ok: false, message: RAW + ' (setup)' }, 500, 'The setup check could not be read.');
  const line = renderErrorDetail(errorDetailOf(checkErr), errorCodeOf(checkErr));
  ok('setup: a failed first check shows its detail', SS.renderSetupBody({ error: checkErr }, {}).includes(line));
  const data = { ok: true, domain: 'd', project: 'p', checkedAt: new Date().toISOString(), repo: null, repoCandidates: [], repoSuggestions: [],
    tools: [], computers: [], physical: [], toFix: [], addable: [], sync: { configured: false }, machine: { ids: [], split: false } };
  const re = SS.renderSetupBody({ data, error: checkErr }, {});
  ok('setup: a failed RE-check shows its detail too', re.includes(line), re.slice(0, 400));
  ok('setup: …and its sentence is not doubled-dotted', !/\.\.<|\.\.'|\.\.\s/.test(re) && /did not finish: /.test(re));
  const repoErr = FI.failText({ ok: false, message: RAW + ' (repo)' }, 500, 'The repository folder was not saved.');
  const rr = SS.renderSetupBody({ data }, { repoError: repoErr, forceRepoOpen: true, openFolds: { 'setup-repo': true } });
  ok('setup: the repository folder error shows its detail', rr.includes(esc(repoErr)) && rr.includes(renderErrorDetail(errorDetailOf(repoErr), errorCodeOf(repoErr))), rr.slice(0, 300));
  const custErr = plainError({ error: RAW + ' (custom)' });
  const cr = SS.renderSetupBody({ data }, { customOpen: true, customError: custErr });
  ok('setup: the custom tool error shows its detail', cr.includes(renderErrorDetail(errorDetailOf(custErr), errorCodeOf(custErr))));
  ok('setup: CONTROL a plain refusal with no detail has none', !SS.renderSetupBody({ data }, { customOpen: true, customError: 'Use letters only.' }).includes('tx-error-detail'));
  const fdata = { ...data, repo: { path: '/x/p', display: '~/p', source: 'set', exists: true, marker: { present: true, namesThis: true, line: 'd/p' } } };
  const fr = SS.fileReaderContent(fdata, '.curator-project', { error: RAW }, { md: (t) => t });
  ok('setup file reader: the detail line carries the catalogue code', fr && /\(code: files-not-allowed\)<\/div>/.test(fr.bodyHtml), fr && fr.bodyHtml);
}

console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) { console.log('❌ Context plain-error assertions FAILED'); process.exit(1); }
console.log('✅ Context plain-error assertions passed');
