/**
 * test-raw-source-ui.js — OFFLINE suite for the Track 7 Part II frontend
 * affordance: "which original file was this summary built from, and is it
 * still on this machine?"
 *
 * Backend (already shipped, not touched here): `GET /api/wiki/:domain/source`
 * and `POST /api/wiki/:domain/source/reveal` — src/brain/raw-store.js +
 * src/routes/wiki.js. This suite tests only the frontend layer added on top:
 * the Wiki tab's source bar in src/public/app.js/index.html/styles.css.
 *
 * describeRawSource() and renderWikiSourceHtml() are deliberately PURE (no
 * DOM, no fetch — see app.js's docblock above them), so they are extracted
 * from the live app.js source and evaluated standalone with `new Function`,
 * exactly the pattern scripts/test-chat-markdown.js uses for markdown.js.
 * Everything else (wiring, escaping discipline, the external-source
 * no-anchor invariant) is checked with source-level guards against the real
 * app.js/index.html/styles.css text, matching
 * scripts/test-chat-compile-card.js.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const html = readFileSync(path.join(ROOT, 'src/public/index.html'), 'utf8');
const app  = readFileSync(path.join(ROOT, 'src/public/app.js'), 'utf8');
const css  = readFileSync(path.join(ROOT, 'src/public/styles.css'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Extract the pure functions from the real app.js and eval them standalone ──
// Grabs a top-level `function NAME(...) { ... }` block by brace-matching so
// nested braces inside the body don't truncate the extraction.
function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`extractFunction: "${name}" not found in source`);
  let i = src.indexOf('{', start);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const fnNames = ['formatSourceBytes', 'describeRawSource', 'renderWikiSourceHtml', 'escHtml'];
const fnSrcs = fnNames.map(n => extractFunction(app, n));
const sandbox = new Function(
  `${fnSrcs.join('\n\n')}\nreturn { formatSourceBytes, describeRawSource, renderWikiSourceHtml, escHtml };`
)();
const { describeRawSource, renderWikiSourceHtml } = sandbox;

// ── 1. describeRawSource — every reason, including unknown/absent ──────────
section('1. describeRawSource() maps every backend reason correctly');
{
  ok(describeRawSource(null) === null, 'null input → null');
  ok(describeRawSource(undefined) === null, 'undefined input → null');
  ok(describeRawSource('nonsense') === null, 'non-object input → null');
  ok(describeRawSource({}) === null, 'empty object (no found/reason) → null');

  const found = describeRawSource({ ok: true, found: true, filename: 'report.pdf', bytes: 204800, mtime: '2026-01-01T00:00:00.000Z' });
  ok(found && found.state === 'found', 'found:true → state "found"');
  ok(found.filename === 'report.pdf', 'found → filename passed through');
  ok(found.sizeText === '200.0 KB', 'found → bytes formatted as KB');

  const notSummary = describeRawSource({ ok: true, found: false, reason: 'not-a-summary', page: 'entities/x.md' });
  ok(notSummary === null, "reason 'not-a-summary' → null (render nothing)");

  const noSource = describeRawSource({ ok: true, found: false, reason: 'no-source-recorded', page: 'summaries/x.md' });
  ok(noSource === null, "reason 'no-source-recorded' → null (render nothing)");

  const ext = describeRawSource({ ok: true, found: false, reason: 'external-source', url: 'medium.com/@talirezun', declaredSource: 'medium.com/@talirezun' });
  ok(ext && ext.state === 'external', "reason 'external-source' → state 'external'");
  ok(ext.url === 'medium.com/@talirezun', 'external → url value passed through verbatim');

  const extFallback = describeRawSource({ ok: true, found: false, reason: 'external-source', declaredSource: 'www.example.com/post' });
  ok(extFallback && extFallback.url === 'www.example.com/post', 'external → falls back to declaredSource when url is absent');

  const extEmpty = describeRawSource({ ok: true, found: false, reason: 'external-source' });
  ok(extEmpty === null, 'external-source with no usable url/declaredSource → null, not a blank bar');

  const missing = describeRawSource({ ok: true, found: false, reason: 'missing', declaredSource: 'report (1).pdf' });
  ok(missing && missing.state === 'missing', "reason 'missing' → state 'missing'");
  ok(/report \(1\)\.pdf/.test(missing.text), 'missing → names the declared filename');
  ok(!/error|corrupt|broken/i.test(missing.text), 'missing → wording is plain, not alarming');

  const missingNoName = describeRawSource({ ok: true, found: false, reason: 'missing' });
  ok(missingNoName && missingNoName.state === 'missing' && missingNoName.text.length > 0,
    'missing with no declaredSource still renders plain generic text');

  const unsafe = describeRawSource({ ok: true, found: false, reason: 'unsafe' });
  ok(unsafe && unsafe.state === 'unsafe', "reason 'unsafe' → state 'unsafe'");

  const notAFile = describeRawSource({ ok: true, found: false, reason: 'not-a-file' });
  ok(notAFile && notAFile.state === 'unsafe', "reason 'not-a-file' → also state 'unsafe' (same neutral copy)");

  const unknown = describeRawSource({ ok: true, found: false, reason: 'some-future-reason-this-build-does-not-know' });
  ok(unknown === null, 'an unrecognised future reason degrades to null, not a guess');
}

// ── 2. renderWikiSourceHtml — XSS + structural invariants ──────────────────
section('2. renderWikiSourceHtml() escapes user-controlled strings');
{
  ok(renderWikiSourceHtml(null) === '', 'null info → empty string (bar stays hidden)');

  const evilName = '<img src=x onerror=alert(1)>.pdf';
  const foundHtml = renderWikiSourceHtml({ state: 'found', filename: evilName, sizeText: '1.0 KB' });
  ok(!/<img/i.test(foundHtml), 'malicious filename: no live <img> tag in output');
  ok(foundHtml.includes('&lt;img src=x onerror=alert(1)&gt;.pdf'), 'malicious filename: fully HTML-escaped');
  ok(!/onerror=/.test(foundHtml) || foundHtml.includes('&lt;img'), 'onerror payload is neutralised by escaping');

  const quoteName = '"><script>alert(1)</script>.pdf';
  const foundHtml2 = renderWikiSourceHtml({ state: 'found', filename: quoteName, sizeText: '' });
  ok(!/<script/i.test(foundHtml2), 'quote/script-breakout filename: no live <script> tag');
  ok(foundHtml2.includes('&quot;&gt;&lt;script&gt;'), 'quote/script-breakout filename: escaped');

  const evilUrl = '"><script>alert(1)</script>';
  const extHtml = renderWikiSourceHtml({ state: 'external', url: evilUrl });
  ok(!/<script/i.test(extHtml), 'malicious external URL text: no live <script> tag');
  ok(extHtml.includes('&quot;&gt;&lt;script&gt;'), 'malicious external URL text: escaped');

  const missingHtml = renderWikiSourceHtml({ state: 'missing', text: '<b>x</b> isn\'t here' });
  ok(!/<b>/i.test(missingHtml), 'missing-state text is escaped too (defensive, even though currently app-authored)');
}

// ── 3. THE load-bearing guard — external-source is never clickable/fetchable ─
section('3. external-source renders as inert text — never a link, never fetched');
{
  const html2 = renderWikiSourceHtml({ state: 'external', url: 'medium.com/@talirezun' });
  ok(!/<a[\s>]/i.test(html2), 'no <a> tag anywhere in the external-source markup');
  ok(!/href\s*=/i.test(html2), 'no href attribute anywhere in the external-source markup');
  ok(/class="wiki-source-url"/.test(html2), 'the URL renders inside a plain <span class="wiki-source-url">');
  ok(html2.includes('medium.com/@talirezun'), 'the URL text itself is present (shown, just not linked)');
}

// ── 4. found:false never renders a Reveal button ────────────────────────────
section('4. Reveal in Finder only appears when found === true');
{
  for (const reason of ['missing', 'unsafe', 'not-a-file', 'external-source', 'not-a-summary', 'no-source-recorded']) {
    const info = describeRawSource({ ok: true, found: false, reason, url: 'x.com/y', declaredSource: 'x.pdf' });
    const out = renderWikiSourceHtml(info);
    ok(!/wiki-source-reveal-btn/.test(out), `reason '${reason}': no Reveal button in output`);
  }
  const foundOut = renderWikiSourceHtml(describeRawSource({ ok: true, found: true, filename: 'x.pdf', bytes: 10 }));
  ok(/wiki-source-reveal-btn/.test(foundOut), 'found: true DOES render the Reveal button');
}

// ── 5. A page with no source renders nothing ────────────────────────────────
section('5. No-source pages produce an empty bar, not an empty-looking bar');
{
  const notSummaryOut = renderWikiSourceHtml(describeRawSource({ ok: true, found: false, reason: 'not-a-summary' }));
  ok(notSummaryOut === '', 'not-a-summary → renderWikiSourceHtml returns "" (caller hides the bar)');

  const noSourceOut = renderWikiSourceHtml(describeRawSource({ ok: true, found: false, reason: 'no-source-recorded' }));
  ok(noSourceOut === '', 'no-source-recorded → renderWikiSourceHtml returns ""');
}

// ── 6. Wiring — source-level guards on app.js/index.html/styles.css ────────
section('6. Frontend wiring');
{
  ok(/id="wiki-source-bar"/.test(html), 'index.html has the #wiki-source-bar element');
  ok(/<div class="wiki-main">/.test(html), 'wiki-main wraps the source bar + content so the layout stays a 2-column grid');
  ok(/id="wiki-content"/.test(html), '#wiki-content is still present (unchanged sibling)');

  ok(/function loadWikiSourceInfo\(/.test(app), 'loadWikiSourceInfo() exists');
  ok(/pagePath\.startsWith\('summaries\/'\)/.test(app),
    'the fetch is gated to summaries/ paths — no request fired for every entity/concept page open');
  ok(/function revealWikiSource\(/.test(app), 'revealWikiSource() exists');
  ok(/\/source\/reveal`, \{\s*\n\s*method: 'POST'/.test(app), 'revealWikiSource POSTs to the reveal endpoint');
  ok(/res\.status === 501/.test(app), 'revealWikiSource handles the non-macOS 501 response distinctly');

  ok(/loadWikiSourceInfo\(currentWikiDomain, page\.path\)/.test(app),
    'selecting a page in the sidebar triggers a source lookup for that page');
  ok(/hideWikiSourceBar\(\);/.test(app), 'hideWikiSourceBar() is called (bar resets between page loads)');

  // Race-safety: a stale response must not paint over a page the user has
  // since navigated away from.
  ok(/wikiSourceRequestSeq/.test(app), 'a request-sequence guard exists');
  ok(/if \(seq !== wikiSourceRequestSeq\) return;/.test(app), 'a superseded source response is discarded, not rendered');

  // No alert()/confirm() anywhere in the new code path.
  const revealFn = extractFunction(app, 'revealWikiSource');
  ok(!/\balert\(/.test(revealFn) && !/\bconfirm\(/.test(revealFn), 'revealWikiSource uses no alert()/confirm()');

  // CSS: source bar uses only real theme tokens (test-css-tokens.js covers
  // this exhaustively across the whole file; this is a targeted check that
  // the new block specifically avoids the historical --text-dim mistake).
  const barRule = (css.match(/\.wiki-source-bar \{[^}]*\}/) || [''])[0];
  ok(barRule.length > 0, '.wiki-source-bar rule exists in styles.css');
  ok(!/--text-dim/.test(css.slice(css.indexOf('.wiki-source-bar'), css.indexOf('.wiki-source-bar') + 2000)),
    'no reference to the nonexistent --text-dim token near the new rules');
  ok(/var\(--text-2\)/.test(barRule), 'uses the real --text-2 token');

  // Never render an absolute filesystem path — the API deliberately never
  // returns one (absPath is stripped server-side); the frontend must not
  // try to reconstruct or display one either.
  ok(!/absPath/.test(app), 'app.js never references absPath (the API never sends one)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All raw-source UI offline assertions green');
