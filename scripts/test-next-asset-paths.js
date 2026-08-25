/**
 * test-next-asset-paths.js — OFFLINE guard on how src/public/next/index.html
 * references its own assets.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * Until v3.6.1 every asset in next/index.html was referenced RELATIVELY
 * (`src="app.js"`, `href="tokens/color.css"`, …) — 18 of them. That is
 * correct while the shell is served at /next/, and catastrophic the moment
 * cutover serves it at /, because:
 *
 *   • `src="app.js"` resolves to /app.js, and src/public/app.js EXISTS — so
 *     the browser loads the SHIPPING bundle into the /next shell. HTTP 200,
 *     correct MIME, no error anywhere.
 *   • Every CSS href resolves to a path with no file behind it, which the
 *     `app.get('*')` SPA catch-all answers with **200 + text/html**. A
 *     browser refuses text/html as a stylesheet, so the app renders
 *     completely unstyled — and a 200 is not a resource error, so nothing
 *     fires.
 *
 * And the guards that should have caught it could not:
 *
 *   • src/public/app.js sets `window.__curatorBooted = true`, which is the
 *     exact sentinel next/index.html's boot guard treats as proof of a
 *     healthy boot. The wrong bundle therefore CERTIFIES the boot it broke.
 *   • test-css-tokens.js reads stylesheets from DISK, not over HTTP, so it
 *     stays green while zero stylesheets reach the browser.
 *
 * That is this repo's named failure shape — "a check that stops reaching the
 * thing it was written to protect" — with three independent layers all
 * reporting success. Verified live before the fix: serving the shell and
 * requesting /tokens/color.css returned `200 text/css`? No — `200 text/html`.
 *
 * ── What this pins ───────────────────────────────────────────────────────
 *
 * Every src/href in next/index.html is root-absolute (or external), so it
 * resolves identically at /next/ and at / — making the cutover swap a
 * non-event rather than a scheduled outage.
 *
 * ── NOT ENFORCED (stated rather than implied) ────────────────────────────
 *
 *   • This checks next/index.html ONLY. Relative URLs built at runtime in JS
 *     (fetch paths, dynamic imports, injected <img>) are out of scope.
 *   • It does not start a server; it asserts the reference FORM and that the
 *     target exists on disk, not the HTTP response.
 *   • It does not check src/public/index.html (the shipping shell), which is
 *     served at / today and is retired at cutover.
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

console.log('\n=== 4. the boot-sentinel collision that made this silent ===');
// Both bundles set the same sentinel. That is fine ONLY while the /next shell
// can never load the shipping bundle by path resolution — i.e. while its
// script ref is root-absolute. Pin the relationship, not just the string.
const shipApp = readFileSync(path.join(REPO, 'src/public/app.js'), 'utf8');
const nextApp = readFileSync(path.join(REPO, 'src/public/next/app.js'), 'utf8');
ok(shipApp.includes('__curatorBooted'), 'shipping app.js sets the boot sentinel');
ok(nextApp.includes('__curatorBooted'), '/next app.js sets the same boot sentinel');
ok(refs.includes('/next/app.js'),
   'next/index.html loads /next/app.js by ABSOLUTE path — so the shipping bundle can never satisfy it and falsely certify the boot');

console.log('\n' + '='.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ next/index.html asset references are cutover-safe');
