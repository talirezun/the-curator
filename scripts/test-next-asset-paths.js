/**
 * test-next-asset-paths.js — OFFLINE guard on how src/public/next/index.html
 * references its own assets, and on the route table that serves it.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * Until v3.6.1 every asset in next/index.html was referenced RELATIVELY
 * (`src="app.js"`, `href="tokens/color.css"`, …) — 18 of them AT THAT TIME
 * (the file carries more now; this scanner never hardcodes the count, it
 * reports whatever it finds, so the number below is history, not a target).
 * That was correct while the shell was served only at /next/, and
 * catastrophic the moment the v3.9.0 cutover served it at /, because:
 *
 *   • `src="app.js"` resolved to /app.js, and src/public/app.js EXISTED — so
 *     the browser loaded the SHIPPING bundle into the /next shell. HTTP 200,
 *     correct MIME, no error anywhere.
 *   • Every CSS href resolved to a path with no file behind it, which the
 *     `app.get('*')` SPA catch-all answers with **200 + text/html**. A
 *     browser refuses text/html as a stylesheet, so the app rendered
 *     completely unstyled — and a 200 is not a resource error, so nothing
 *     fired.
 *
 * And the guards that should have caught it could not:
 *
 *   • src/public/app.js set `window.__curatorBooted = true`, which is the
 *     exact sentinel next/index.html's boot guard treats as proof of a
 *     healthy boot. The wrong bundle therefore CERTIFIED the boot it broke.
 *   • test-css-tokens.js reads stylesheets from DISK, not over HTTP, so it
 *     stays green while zero stylesheets reach the browser.
 *
 * That is this repo's named failure shape — "a check that stops reaching the
 * thing it was written to protect" — with three independent layers all
 * reporting success.
 *
 * ── WHAT CHANGED IN v3.41.0, AND WHY THIS FILE GREW RATHER THAN SHRANK ───
 *
 * The pre-redesign shell is DELETED: src/public/{app,markdown}.js,
 * index.html and styles.css are gone, and "/old" now 302s to "/". The
 * obvious reading is that this suite's §4 is obsolete — the shipping bundle
 * cannot be loaded by mistake if it does not exist.
 *
 * That reading is wrong in the direction that matters. §4 pinned a
 * RELATIONSHIP (a bare-relative script ref resolves to a file at the server
 * root), and the relationship is what protects the shell; the specific file
 * that used to sit there was only today's instance of it. So §4 now asserts
 * the ABSENCE of every deleted file — a re-added src/public/app.js would
 * silently re-arm the identical trap, and nothing else in the suite would
 * notice — and keeps the root-absolute ref assertion, which is the half that
 * makes the absence a belt-and-braces rather than the whole defence.
 *
 * §5 and §6 are the two route-table and page-title guards inherited from
 * scripts/test-cutover.js, which v3.41.0 deleted along with the cutover
 * notice it existed to test. Those two sections were never about the
 * notice — they are about which HTML shell each path gets, and that question
 * outlives the cutover. They are here rather than deleted with their file.
 *
 * ── NOT ENFORCED (stated rather than implied) ────────────────────────────
 *
 *   • This checks next/index.html ONLY. Relative URLs built at runtime in JS
 *     (fetch paths, dynamic imports, injected <img>) are out of scope.
 *   • It does not start a server; it asserts the reference FORM, that the
 *     target exists on disk, and the SOURCE TEXT of the routes — never an
 *     HTTP response. No request has ever been made against these routes by
 *     this suite.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const NEXT_HTML = path.join(REPO, 'src/public/next/index.html');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// Returns every src="…" / href="…" value in the given HTML.
function extractRefs(html) {
  return [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map(m => m[1]);
}
const EXTERNAL = /^(?:https?:|data:|mailto:|#|\/\/)/;
function isBareRelative(ref) {
  return ref !== '' && !ref.startsWith('/') && !EXTERNAL.test(ref);
}

console.log('\n=== 1. next/index.html references ===');
const html = readFileSync(NEXT_HTML, 'utf8');
const refs = extractRefs(html);

// Guard against a regex that silently matches nothing — the v3.6.0 `data-href`
// lesson, where a scanner reported MORE files scanned while covering less.
ok(refs.length >= 15,
   `found ${refs.length} src/href references (a near-zero count means this scanner stopped reaching the file)`);

const bare = refs.filter(isBareRelative);
ok(bare.length === 0,
   `zero bare-relative references${bare.length ? ` — found: ${bare.join(', ')}` : ''}`);

const local = refs.filter(r => r.startsWith('/next/'));
ok(local.length >= 15, `${local.length} references are root-absolute under /next/`);

console.log('\n=== 2. every referenced local asset exists on disk ===');
let missing = [];
for (const ref of local) {
  const rel = ref.replace(/^\/next\//, '');
  if (!existsSync(path.join(REPO, 'src/public/next', rel))) missing.push(ref);
}
ok(missing.length === 0,
   `all ${local.length} referenced assets resolve${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);

console.log('\n=== 3. NEGATIVE CONTROL — the scanner can actually fail ===');
// A guard that cannot go red is worth nothing. Prove the detector fires on a
// synthetic document containing exactly the shape this suite exists to refuse.
const fixture = '<link rel="stylesheet" href="tokens/color.css">\n<script src="app.js"></script>';
const fixtureBare = extractRefs(fixture).filter(isBareRelative);
ok(fixtureBare.length === 2,
   `detector flags a fixture with 2 bare-relative refs (got ${fixtureBare.length})`);
ok(fixtureBare.includes('app.js') && fixtureBare.includes('tokens/color.css'),
   'detector names the offending refs rather than merely counting');
// …and does NOT fire on the acceptable forms.
const okFixture = '<script src="/next/app.js"></script><a href="https://x.test/">e</a><a href="#top">t</a>';
ok(extractRefs(okFixture).filter(isBareRelative).length === 0,
   'detector does NOT flag root-absolute, external, or fragment refs (no false positives)');

console.log('\n=== 4. the pre-redesign shell is GONE, and must stay gone ===');
// The boot-sentinel collision this section originally pinned: BOTH bundles set
// `window.__curatorBooted`, so a /next shell that accidentally loaded the
// shipping bundle got a certified-healthy boot out of the file that had just
// broken it. v3.41.0 removed the shipping bundle, so the collision has no
// second party — but the trap is re-armed by anyone who puts a file back at
// src/public/app.js, and nothing else in this repo would notice. Assert the
// absence directly.
const RETIRED = ['app.js', 'index.html', 'markdown.js', 'styles.css'];
const resurrected = RETIRED.filter((f) => existsSync(path.join(REPO, 'src/public', f)));
ok(resurrected.length === 0,
   `the retired pre-redesign shell is absent from src/public/${resurrected.length ? ` — found again: ${resurrected.join(', ')}` : ' (app.js, index.html, markdown.js, styles.css)'}`);

// CONTROL: the existsSync probe is pointed at a real directory and can report
// presence. Without this, a typo in REPO would make the check above pass by
// looking at nothing — the vacuous-guard shape this repo keeps recording.
ok(existsSync(path.join(REPO, 'src/public/next/app.js')),
   'CONTROL: the same probe DOES find src/public/next/app.js — the absence above is a measurement, not a broken path');

const nextApp = readFileSync(path.join(REPO, 'src/public/next/app.js'), 'utf8');
ok(nextApp.includes('__curatorBooted'), '/next app.js sets the boot sentinel');
ok(refs.includes('/next/app.js'),
   'next/index.html loads /next/app.js by ABSOLUTE path — so a file re-added at the server root can never satisfy it and falsely certify the boot');

console.log('\n=== 5. the route table — "/" and the catch-all serve NEXT ===');
// Inherited from the deleted scripts/test-cutover.js §7. Every ABSENCE check
// here must run against CODE, not prose: src/server.js's own cutover comment
// QUOTES the strings being asserted absent while explaining them, so a raw-text
// scan would be reading a comment — this repo's named failure shape.
//
// Conservative on purpose: whole-line // comments and /* ... */ blocks only,
// line comments FIRST (stripping blocks first can open a fake block comment
// inside a // line and swallow the rest of the file).
function stripComments(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}
function extractBlock(src, needle, label) {
  const start = src.indexOf(needle);
  if (start === -1) throw new Error(`extractBlock: "${needle}" not found in ${label}`);
  let i = src.indexOf('{', start);
  if (i === -1) throw new Error(`extractBlock: "${needle}" has no body in ${label}`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const block = src.slice(start, i);
  if (block.length < needle.length + 4) {
    throw new Error(`extractBlock: "${needle}" extraction desynced — implausibly short (${label})`);
  }
  return block;
}

const serverRaw = readFileSync(path.join(REPO, 'src/server.js'), 'utf8');
const serverCode = stripComments(serverRaw);
// Tripwire for an over-reaching stripper. The anchors are STRUCTURAL and
// deliberately exclude anything asserted below — an overlap turns the very
// mutation a check exists to catch into a thrown tripwire, which is a red for
// the wrong reason and proves nothing.
for (const anchor of ['const app = express();', 'res.sendFile(']) {
  if (!serverCode.includes(anchor)) {
    throw new Error(`stripComments over-reached on server.js: "${anchor}" is gone from the stripped code`);
  }
}
// CONTROL: the stripper really strips. The phrase below exists ONLY inside a
// comment in server.js, so if it survives the strip, every absence assertion
// in this section is being satisfied by prose rather than by code.
ok(/permanently-cached redirect/.test(serverRaw) && !/permanently-cached redirect/.test(serverCode),
   'CONTROL: comments really are stripped from server.js (a comment mention cannot satisfy an assertion)');

{
  // `index: false` is the non-obvious half. express.static defaults to
  // index:'index.html', so before the cutover "/" was answered by the STATIC
  // MOUNT and never reached the catch-all at all. The old file is deleted, but
  // the option must stay false so a NEW src/public/index.html cannot silently
  // take "/" back from the route table.
  // Matched to the statement terminator, not to the first ")": the first ")"
  // closes path.join(), so a lazy [^)]* capture stops BEFORE the options object
  // and the assertion below passes/fails on text it never saw.
  const staticM = /app\.use\(express\.static\([\s\S]*?\);/.exec(serverCode);
  ok(!!staticM, 'the express.static mount is found');
  ok(!!staticM && staticM[0].includes('path.join'),
     'sanity: the whole mount statement was captured, options object included');
  ok(/index:\s*false/.test(staticM ? staticM[0] : ''),
     'the static mount runs with { index: false } — without it a file dropped at src/public/index.html answers "/" and the catch-all never runs');

  // Presence is ASSERTED before extraction, never assumed: extractBlock throws
  // on a missing needle, and a throw here would replace every assertion below
  // with a stack trace.
  const hasCatchAll = serverCode.includes("app.get('*'");
  ok(hasCatchAll, 'a SPA catch-all route exists');
  const catchAll = hasCatchAll ? extractBlock(serverCode, "app.get('*'", 'server.js') : '';
  ok(/'next',\s*'index\.html'/.test(catchAll),
     'the SPA catch-all serves src/public/next/index.html');
  ok(catchAll !== '' && !/__dirname,\s*'public',\s*'index\.html'/.test(catchAll),
     'and not a file directly under src/public/');

  const hasNextRoute = serverCode.includes("app.get(['/next', '/next/']");
  ok(hasNextRoute, 'the /next route still exists');
  const nextRoute = hasNextRoute ? extractBlock(serverCode, "app.get(['/next', '/next/']", 'server.js') : '';
  ok(/'next',\s*'index\.html'/.test(nextRoute), '/next serves the SAME shell (bookmarks keep working)');

  // "/old" is a REDIRECT now, not a second shell. Without an explicit route it
  // would fall through to the catch-all and be answered by the /next shell at
  // 200, leaving the URL bar reading "/old" forever; a 404 would break a
  // bookmark that a working app is sitting behind. So: redirect, and to "/",
  // which is a DIFFERENT path from either registered form — making a
  // self-redirect loop (reproduced live in v3.9.0) inexpressible here.
  const hasOldRoute = serverCode.includes("app.get(['/old', '/old/']");
  ok(hasOldRoute, "an explicit /old route exists — without it the catch-all answers /old with the app at 200 and the stale URL never corrects");
  const oldRoute = hasOldRoute ? extractBlock(serverCode, "app.get(['/old', '/old/']", 'server.js') : '';
  ok(/redirect\(302,\s*'\/'\)/.test(oldRoute), '/old redirects to "/" with a 302');
  ok(!/sendFile/.test(oldRoute), '/old serves no file of its own — there is no second shell left to serve');
  ok(!/redirect\(301/.test(oldRoute),
     'and it is NOT a permanently-cached 301 — this path is meant to be deleted outright later');
  ok(!/app\.get\('\/old'/.test(serverCode) && !/app\.get\('\/old\/'/.test(serverCode),
     'there is no SEPARATE single-path /old route (express is non-strict, so two routes both match /old — the v3.9.0 loop)');

  // Ordering: both explicit routes must be registered BEFORE the catch-all, or
  // the catch-all swallows them.
  ok(serverCode.indexOf("app.get(['/old', '/old/']") < serverCode.indexOf("app.get('*'"),
     '/old is registered before the catch-all');
  ok(serverCode.indexOf("app.get(['/next', '/next/']") < serverCode.indexOf("app.get('*'"),
     '/next is registered before the catch-all');
}

console.log('\n=== 6. page title suits a PRIMARY app, not a preview ===');
// Inherited from the deleted scripts/test-cutover.js §9. Caught by a
// spot-check after the routes had been verified twice: the shell's <title>
// still read "The Curator — Next (preview)", i.e. the app telling every user
// it is a preview in every browser tab, window switcher and new bookmark.
// Nothing asserted it, because nothing had reason to until the shell became
// primary. The comparison against the OLD shell's title is dropped with that
// shell — there is no longer a second title to be distinguishable from.
{
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
  ok(!!title, 'sanity: the shell has a <title> (a missing one would pass the negative check vacuously)');
  ok(!/preview|beta|wip|todo/i.test(title || ''),
     `the title carries no preview/beta marker (got ${JSON.stringify(title)})`);
  ok(/curator/i.test(title || ''), `the title names the product (got ${JSON.stringify(title)})`);
}

console.log('\n' + '='.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ next/index.html asset references and the route table are sound');
