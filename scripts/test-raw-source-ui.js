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

const fnNames = ['formatSourceBytes', 'describeRawSource', 'renderWikiSourceHtml', 'stripFrontmatter', 'escHtml'];
const fnSrcs = fnNames.map(n => extractFunction(app, n));
const sandbox = new Function(
  `${fnSrcs.join('\n\n')}\nreturn { formatSourceBytes, describeRawSource, renderWikiSourceHtml, stripFrontmatter, escHtml };`
)();
const { describeRawSource, renderWikiSourceHtml, stripFrontmatter } = sandbox;

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

// ── 7. stripFrontmatter() — the Wiki tab's leading-YAML-block strip ────────
section('7. stripFrontmatter() strips ONLY a leading frontmatter block');
{
  // No frontmatter at all: byte-identical to input.
  const plain = '# Hello\n\nJust a normal page with no frontmatter.\n\n---\n\nAnd a horizontal rule later on.';
  ok(stripFrontmatter(plain) === plain, 'a page with no frontmatter renders byte-identically — even one that itself contains a later --- hr');
  ok(stripFrontmatter('') === '', 'empty string input: returns empty string, not an error');
  ok(stripFrontmatter(null) === null && stripFrontmatter(undefined) === undefined, 'non-string input (null/undefined) is returned as-is, not thrown on');

  // The real shape: injectFrontmatter's actual output.
  const withFm = '---\ntype: summary\nsource: from-lab-to-life-growth-strategy.md\ndate: 2026-06-14\ntags: [growth-strategy, monetization]\n---\n# From Lab To Life\n\nBody content starts here.';
  const stripped = stripFrontmatter(withFm);
  ok(stripped === '# From Lab To Life\n\nBody content starts here.', `FIXED — the frontmatter block is gone and the real body starts cleanly (got: ${JSON.stringify(stripped)})`);
  ok(!/^type:/.test(stripped) && !/source:/.test(stripped), 'no frontmatter keys (type:, source:, etc) leak into the stripped body');

  // Mid-document --- used as a horizontal rule: frontmatter present AND a
  // LATER --- in the body — only the leading block goes, the hr survives.
  const withHr = '---\ntype: concept\n---\n# Section One\n\nSome content.\n\n---\n\n# Section Two\n\nMore content.';
  const strippedHr = stripFrontmatter(withHr);
  ok(strippedHr === '# Section One\n\nSome content.\n\n---\n\n# Section Two\n\nMore content.',
    `FIXED — the leading frontmatter is stripped but the mid-document --- horizontal rule is NOT eaten (got: ${JSON.stringify(strippedHr)})`);
  ok((strippedHr.match(/^---$/gm) || []).length === 1, 'exactly one --- line survives in the stripped output — the hr, not a second copy of a frontmatter delimiter');

  // Unterminated opening --- (no closing delimiter anywhere): must NOT
  // swallow the whole page. Returns completely unchanged.
  const unterminated = '---\ntype: summary\nthis document never closes its frontmatter block\n# Heading\n\nBody text that would be lost if the whole thing were swallowed.';
  ok(stripFrontmatter(unterminated) === unterminated,
    'an unterminated opening --- returns the ENTIRE document unchanged — nothing is silently swallowed hunting for a delimiter that never arrives');

  const justOpener = '---';
  ok(stripFrontmatter(justOpener) === justOpener, 'a document that is ONLY "---" (no second line at all) is left unchanged, not treated as an empty strip');

  // --- inside a fenced code block, AFTER real frontmatter — the code
  // fence's --- must survive untouched (the search already stopped at the
  // first real closing delimiter, well before the fence is ever reached).
  const withFence = '---\ntype: entity\n---\nSome text before the example.\n\n```\nexample:\n---\ninside fence\n```\n\nMore text after.';
  const strippedFence = stripFrontmatter(withFence);
  ok(strippedFence === 'Some text before the example.\n\n```\nexample:\n---\ninside fence\n```\n\nMore text after.',
    `FIXED — frontmatter stripped cleanly, and the --- living INSIDE a later fenced code block is completely untouched (got: ${JSON.stringify(strippedFence)})`);
  ok(strippedFence.includes('```\nexample:\n---\ninside fence\n```'), 'the fenced code block content is preserved verbatim, --- and all');

  // Empty frontmatter: opening immediately followed by closing.
  const emptyFm = '---\n---\n# Heading\nBody.';
  ok(stripFrontmatter(emptyFm) === '# Heading\nBody.', 'empty frontmatter (opening immediately followed by closing) strips to just the body');

  // Frontmatter with nothing after the closing delimiter at all.
  const fmOnly = '---\ntype: summary\n---\n';
  ok(stripFrontmatter(fmOnly) === '', 'a document that is ONLY frontmatter (nothing after the closing ---) strips to an empty string, not an error');

  // Whitespace-only variants of the delimiter line (trailing spaces) are
  // still recognised — real editors/sources sometimes leave trailing
  // whitespace on a line that is otherwise exactly "---".
  const trailingSpace = '---  \ntype: summary\n---\t\nBody after whitespace-padded delimiters.';
  ok(stripFrontmatter(trailingSpace) === 'Body after whitespace-padded delimiters.',
    'delimiter lines with trailing whitespace are still recognised (trimmed before comparison)');

  // Wired into the actual renderer, not just the standalone helper.
  const rendererFn = extractFunction(app, 'renderMarkdown');
  ok(/stripFrontmatter\(md\)/.test(rendererFn), 'renderMarkdown() calls stripFrontmatter(md) before building HTML');
  ok(/escHtml\(body\)/.test(rendererFn), 'renderMarkdown() escapes the STRIPPED body, not the raw md with frontmatter still attached');

  // ── MUTATION-PROVE: revert stripFrontmatter to a no-op (its pre-fix
  //    shape — the frontmatter block was never stripped anywhere) and
  //    confirm his exact repro goes RED. ─────────────────────────────────
  {
    const NOOP_FN = 'function stripFrontmatter(content) { return content; }';
    const currentFn = extractFunction(app, 'stripFrontmatter');
    ok(!!currentFn && currentFn.length > 0, 'mutation sanity — the current stripFrontmatter was extractable from app.js');
    const brokenSrc = app.replace(currentFn, () => NOOP_FN);
    ok(brokenSrc !== app, 'mutation sanity — the mutation actually changed the in-memory source text (real file on disk untouched)');
    const brokenFn = extractFunction(brokenSrc, 'stripFrontmatter');
    const brokenSandbox = new Function(`${brokenFn}\nreturn { stripFrontmatter };`)();
    const brokenResult = brokenSandbox.stripFrontmatter(withFm);
    ok(brokenResult.startsWith('---\ntype: summary'),
      `RED CONFIRMED — with stripFrontmatter reverted to a no-op, the raw frontmatter block ("---" + "type: summary...") renders as the start of body content, exactly the leaked-YAML defect reported — top of his content pane rendering "type: summary source: ..." as a paragraph (got: ${JSON.stringify(brokenResult.slice(0, 40))})`);
  }
}

// ── 8. The source bar's found state — RAW label, and still escapes ─────────
section('8. Round — the source bar labels itself "RAW", distinct from the page being viewed');
{
  const evilName = '<img src=x onerror=alert(1)>.pdf';
  const html2 = renderWikiSourceHtml({ state: 'found', filename: evilName, sizeText: '1.0 KB' });
  ok(/wiki-source-label">RAW</.test(html2), 'FIXED — the found state carries an explicit "RAW" label');
  ok(!/<img/i.test(html2), 'the malicious filename next to the new label is still fully escaped — no live <img> tag');
  ok(html2.includes('&lt;img src=x onerror=alert(1)&gt;.pdf'), 'the malicious filename renders as inert escaped text');

  // The exact reported collision: a summary page and its raw/ source share
  // an identical filename because the source was itself markdown. The RAW
  // label is what has to survive this test — a reader must be able to
  // tell the two apart even though the filename alone cannot.
  const collisionName = 'from-lab-to-life-growth-strategy.md';
  const collisionHtml = renderWikiSourceHtml({ state: 'found', filename: collisionName, sizeText: '22.2 KB' });
  ok(collisionHtml.includes('RAW') && collisionHtml.includes(collisionName),
    'his exact repro — a raw/ file sharing its filename with the summary page — now carries the RAW label alongside the (identical) filename');
  ok(/wiki-source-label">RAW<\/span><span class="wiki-source-name">from-lab-to-life-growth-strategy\.md/.test(collisionHtml),
    'the label sits immediately before the filename in the actual markup, not just present somewhere in the string');

  // Not fabricating a path: the label is the word RAW (a concept/folder
  // name), never an absolute filesystem path — same invariant as before,
  // re-asserted now that the found-state markup has changed shape.
  ok(!/\/Users\//.test(html2) && !/^\//.test(html2), 'no absolute filesystem path is present in the found-state markup');
  ok(!/absPath/.test(app), 'app.js still never references absPath anywhere (unchanged invariant)');

  // CSS: the new label uses real theme tokens, not an invented one.
  const labelRule = (css.match(/\.wiki-source-label \{[^}]*\}/) || [''])[0];
  ok(labelRule.length > 0, '.wiki-source-label rule exists in styles.css');
  ok(/var\(--text-muted\)/.test(labelRule), 'uses the real --text-muted token, matching the existing DOMAIN/FILE label convention');
  ok(!/--text-dim/.test(labelRule), 'does not reference the nonexistent --text-dim token');

  // ── MUTATION-PROVE: strip the RAW label back out of the found-state
  //    markup (its pre-fix shape) and confirm the collision case goes RED. ─
  {
    const currentFoundBlock = (app.match(/if \(info\.state === 'found'\) \{[\s\S]*?\n  \}/) || [''])[0];
    ok(currentFoundBlock.length > 0, 'mutation sanity — the found-state block was extractable from app.js');
    ok(currentFoundBlock.includes('wiki-source-label'),
      'mutation sanity — the found-state block does currently include the label span (so removing it is a real mutation)');
    const brokenFoundBlock = currentFoundBlock.replace('`<span class="wiki-source-label">RAW</span>` +\n      ', '');
    ok(brokenFoundBlock !== currentFoundBlock, 'mutation sanity — the label span was actually removed from the extracted block');
    const brokenSrc2 = app.replace(currentFoundBlock, () => brokenFoundBlock);
    ok(brokenSrc2 !== app, 'mutation sanity — the mutation actually changed the in-memory source text (real file on disk untouched)');
    const fnNames2 = ['formatSourceBytes', 'describeRawSource', 'renderWikiSourceHtml', 'escHtml'];
    const fnSrcs2 = fnNames2.map(n => extractFunction(brokenSrc2, n));
    const brokenSandbox2 = new Function(`${fnSrcs2.join('\n\n')}\nreturn { renderWikiSourceHtml };`)();
    const brokenCollisionHtml = brokenSandbox2.renderWikiSourceHtml({ state: 'found', filename: collisionName, sizeText: '22.2 KB' });
    ok(!/RAW/.test(brokenCollisionHtml),
      `RED CONFIRMED — with the label removed, a raw/ file sharing its filename with the summary page renders completely indistinguishably from the page itself (got: ${JSON.stringify(brokenCollisionHtml)})`);
  }
}

// ── 9. The chat renderer (public/markdown.js) is a different path and is
//    untouched by any of this. ─────────────────────────────────────────────
section('9. public/markdown.js (chat) is unaffected by the Wiki tab frontmatter strip');
{
  const mdJsPath = path.join(ROOT, 'src/public/markdown.js');
  const mdJs = readFileSync(mdJsPath, 'utf8');
  ok(!/stripFrontmatter/.test(mdJs), 'markdown.js does not reference stripFrontmatter — the chat render path was not touched');
  ok(!/wiki-source-label/.test(mdJs), 'markdown.js has no knowledge of the Wiki tab source bar either — fully separate concern');
  // renderChatMarkdown is markdown.js's real entry point (see
  // test-chat-markdown.js) — confirm it is untouched by re-extracting it
  // with the SAME brace-matching extractor used above and checking it
  // still starts a fresh HTML-escape pass over its own input, with no
  // frontmatter-stripping call inserted ahead of it.
  ok(/function renderChatMarkdown\(/.test(mdJs), 'renderChatMarkdown() still exists in markdown.js, unrenamed and unremoved');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All raw-source UI offline assertions green');
