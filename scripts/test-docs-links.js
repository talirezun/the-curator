#!/usr/bin/env node
/**
 * scripts/test-docs-links.js — OFFLINE
 *
 * Every link from the app into docs/ resolves to a file that exists and, when
 * it names an anchor, to a HEADING that really slugifies to it.
 *
 * ── WHY A TEST AND NOT A CONVENTION ────────────────────────────────────────
 *
 * A docs link is the one kind of string in this app that can be wrong forever
 * without anything noticing. It does not throw, it does not render badly, it
 * does not show up in a screenshot: GitHub serves the file and silently
 * ignores an anchor it cannot find, so a renamed heading turns a link into a
 * link to the top of a long page and the only signal is a user clicking it.
 * This project has shipped that exact class twice in prose (v3.6.1's wrong
 * tool count, v3.9.1's eight false revert promises) and both times the fix was
 * to make the claim checkable rather than to promise more care.
 *
 * So: src/public/next/shared/docs-links.js is the only place a destination may
 * be written, and this suite reads the REAL markdown in docs/ and fails on a
 * missing file or a dead anchor.
 *
 * ── THE SLUG RULE, AND WHAT IT DELIBERATELY DOES NOT DO ────────────────────
 *
 * GitHub's anchor for a heading is: lowercase, drop everything that is not a
 * letter, a digit, a space or a hyphen, then spaces to hyphens. Duplicate
 * headings get `-1`, `-2` … appended, which is a trap rather than a feature
 * (insert a second "Cost" heading above yours and every link to the old one
 * silently moves), so §3 below REFUSES a mapped anchor whose heading text
 * occurs more than once in its file instead of implementing the suffix. An
 * anchor nobody can keep stable is not one the app should be pointing at.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DOCS_LINKS, docsUrl, docsLinkHtml,
} from '../src/public/next/shared/docs-links.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const NEXT = join(ROOT, 'src/public/next');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

/** GitHub's heading → anchor rule, as documented in the header. */
function slugify(heading) {
  return heading.toLowerCase().replace(/[^a-z0-9 \-]/g, '').trim().replace(/ /g, '-');
}

/** Every ATX heading in a markdown file, heading text only. */
function headingsOf(md) {
  return (md.match(/^#{1,6} .*$/gm) || []).map((h) => h.replace(/^#+\s+/, '').trim());
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  THE MAP ITSELF');

const keys = Object.keys(DOCS_LINKS);
ok(keys.length >= 14, `the map carries ${keys.length} keys (floor 14 — the two migrated links plus the Settings and Project-context topics; the memory.* KEY PREFIX deliberately did not follow the v3.62.0 rename, because a key names the DOCS TOPIC and working-state.md was not renamed)`);
ok(Object.isFrozen(DOCS_LINKS), 'DOCS_LINKS is frozen — no caller can add a destination at runtime');
ok(keys.every((k) => Object.isFrozen(DOCS_LINKS[k])),
  '…and so is every entry, so `DOCS_LINKS.x.anchor = …` cannot rewrite one either');
ok(keys.every((k) => /^[a-z][a-z0-9]*\.[a-z0-9-]+$/.test(k)),
  'every key is `<surface>.<topic>`, lower-case — the shape the next reader can scan');

// ═════════════════════════════════════════════════════════════════════════
section('§2  EVERY MAPPED FILE EXISTS');

for (const k of keys) {
  const { file } = DOCS_LINKS[k];
  ok(existsSync(join(DOCS, file)), `${k} → docs/${file} exists`);
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  EVERY MAPPED ANCHOR IS A REAL, UNAMBIGUOUS HEADING');

for (const k of keys) {
  const { file, anchor } = DOCS_LINKS[k];
  if (anchor === null) {
    ok(true, `${k} → docs/${file} (whole file — no anchor to rot)`);
    continue;
  }
  const md = readFileSync(join(DOCS, file), 'utf8');
  const heads = headingsOf(md);
  const matched = heads.filter((h) => slugify(h) === anchor);
  ok(matched.length === 1,
    `${k} → docs/${file}#${anchor} matches exactly one heading` +
      (matched.length === 1 ? ` ("${matched[0]}")` : ` — found ${matched.length}`));
  // Duplicate heading TEXT is the `-1` trap even when the slug matched once,
  // because the duplicate may be added later above this one.
  if (matched.length === 1) {
    const sameText = heads.filter((h) => h === matched[0]).length;
    ok(sameText === 1,
      `…and "${matched[0]}" occurs once in that file, so GitHub appends no -1 suffix that would move the anchor`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  THE SLUGIFIER IS NOT VACUOUS');

ok(slugify('Version and updates') === 'version-and-updates', 'CONTROL: plain words');
ok(slugify('Default domain for MCP writes (v2.5.2+)') === 'default-domain-for-mcp-writes-v252',
  'CONTROL: brackets, dots and a plus are dropped, not hyphenated');
ok(slugify("Tier 1 is not tier 2: the brief is the owner's") === 'tier-1-is-not-tier-2-the-brief-is-the-owners',
  'CONTROL: a colon and an apostrophe vanish without leaving a hyphen behind');
ok(slugify('6b. The menu bar icon (Mac app)') === '6b-the-menu-bar-icon-mac-app', 'CONTROL: a numbered heading');
ok(slugify('Version and updates') !== 'version-and-update',
  'CONTROL: the slugifier can be WRONG — a near miss does not match');

// ═════════════════════════════════════════════════════════════════════════
section('§5  docsUrl');

ok(docsUrl('settings.mcp-bridge') === 'https://github.com/talirezun/the-curator/blob/main/docs/mcp-user-guide.md',
  'a null anchor emits no trailing "#"');
ok(docsUrl('app.two-installs') ===
   'https://github.com/talirezun/the-curator/blob/main/docs/user-guide.md#two-installs-one-knowledge-folder',
  'MIGRATION PIN: app.js\'s INSTANCE_DOCS_URL resolves byte-for-byte to the literal it replaced');
ok(docsUrl('settings.mcp-bridge') === 'https://github.com/talirezun/the-curator/blob/main/docs/mcp-user-guide.md',
  'MIGRATION PIN: mcp-wizard.js\'s MCP_GUIDE_URL resolves byte-for-byte to the literal it replaced');
{
  let threw = null;
  try { docsUrl('settings.does-not-exist'); } catch (e) { threw = e; }
  ok(threw instanceof Error && /unknown docs key/.test(threw.message),
    'an unknown key THROWS with the key in the message — loud and local, not a link to nowhere');
}
{
  // The own-property rule: an inherited name must not resolve to something.
  let threw = null;
  try { docsUrl('constructor'); } catch (e) { threw = e; }
  ok(threw instanceof Error, "…and 'constructor' throws too — the lookup is own-property, not a truthiness test");
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  docsLinkHtml');

{
  const html = docsLinkHtml('settings.system-check', 'System check');
  ok(/^<a href="https:\/\/github\.com\/talirezun\/the-curator\/blob\/main\/docs\/system-check\.md"/.test(html),
    'it renders the mapped URL as the href');
  ok(/target="_blank"/.test(html) && /rel="noopener noreferrer"/.test(html),
    'it opens in a new tab AND severs window.opener — noreferrer as well as noopener');
  const evil = docsLinkHtml('memory.handoff', '<img src=x onerror=alert(1)>"');
  ok(!/<img/.test(evil) && /&lt;img/.test(evil) && /&quot;/.test(evil),
    'the LABEL is escaped — tags and quotes come back as entities, so a composed label cannot break out');
  let threw = null;
  try { docsLinkHtml('nope.nope', 'x'); } catch (e) { threw = e; }
  ok(threw instanceof Error, 'and it inherits docsUrl\'s refusal — an unknown key never renders a link at all');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  NO VIEW MAY TYPE A DOCS URL OF ITS OWN');

{
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  })(NEXT);
  const MODULE = join(NEXT, 'shared/docs-links.js');
  const offenders = files
    .filter((p) => p !== MODULE)
    .filter((p) => /github\.com\/talirezun\/the-curator\/blob\/main\/docs/.test(readFileSync(p, 'utf8')))
    .map((p) => relative(ROOT, p));
  ok(offenders.length === 0,
    'no file under src/public/next/ outside shared/docs-links.js contains a hand-typed docs URL' +
      (offenders.length ? ' — found in ' + offenders.join(', ') : ''));
  ok(files.length > 10 && files.includes(MODULE),
    `CONTROL: the walk really saw the tree (${files.length} .js files, including the module itself)`);
  ok(/github\.com\/talirezun\/the-curator\/blob\/main\/docs/.test(readFileSync(MODULE, 'utf8')),
    'CONTROL: …and the pattern it is scanning for does occur — in the one file allowed to hold it');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  THE TWO MIGRATED CONSTANTS GO THROUGH THE MAP');

{
  const appJs = readFileSync(join(NEXT, 'app.js'), 'utf8');
  const wiz = readFileSync(join(NEXT, 'views/mcp-wizard.js'), 'utf8');
  ok(/const INSTANCE_DOCS_URL = docsUrl\('app\.two-installs'\);/.test(appJs),
    "app.js's INSTANCE_DOCS_URL is docsUrl('app.two-installs')");
  ok(/import \{ docsUrl \} from '\.\/shared\/docs-links\.js';/.test(appJs), '…and app.js imports it');
  ok(/export const MCP_GUIDE_URL = docsUrl\('settings\.mcp-bridge'\);/.test(wiz),
    "mcp-wizard.js's MCP_GUIDE_URL is docsUrl('settings.mcp-bridge')");
  ok(/import \{ docsUrl \} from '\.\.\/shared\/docs-links\.js';/.test(wiz), '…and mcp-wizard.js imports it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
