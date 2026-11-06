#!/usr/bin/env node
/**
 * test-hub-linkify.js — OFFLINE suite for the post-ingest hub linkification pass.
 * No network and no API key; every write lands in a tempdir.
 *
 * Found through a live failure on 2026-11-06. A page the model wrote without a
 * `# title` opens on a section heading, and linkifyHubPages took that heading as
 * the page's name. Every hub then got `## [[the-curator-team|Related]]` and prose
 * like "[[the-curator-team|related]] to". The hub's own Related section stopped
 * being one, so Health reported missing backlinks. On gemini-2.5-flash-lite 3 of
 * 16 ingests of one source hit it.
 *
 * Isolation: __setDomainsDirOverride plus CURATOR_TEST_USER_DATA_DIR.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = mkdtempSync(path.join(tmpdir(), 'curator-hub-linkify-'));
const DOMAINS = path.join(ROOT, 'domains');
mkdirSync(DOMAINS);
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(ROOT, 'userdata');
mkdirSync(process.env.CURATOR_TEST_USER_DATA_DIR);

const { __setDomainsDirOverride } = await import(path.join(REPO, 'src/brain/config.js'));
__setDomainsDirOverride(DOMAINS);
const { createDomain } = await import(path.join(REPO, 'src/brain/files.js'));
const { __testing } = await import(path.join(REPO, 'src/brain/ingest.js'));
const { scanWiki } = await import(path.join(REPO, 'src/brain/health.js'));
const { linkifyHubPages } = __testing;

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
}

const DOMAIN = 'hubs';
await createDomain(DOMAIN, 'Hubs', 'Hub linkification test', 'tech');
const wiki = path.join(DOMAINS, DOMAIN, 'wiki');
const put = (rel, text) => writeFileSync(path.join(wiki, rel), text);
const fm = (type, tags) => `---\ntype: ${type}\ntags: [${tags}, type/${type}]\ncreated: 2026-11-06\n---\n`;

// No `# title`: these open on a section heading, the shape that caused the defect.
put('entities/the-curator-team.md', `${fm('entity', 'team')}A team.\n\n## Related\n- [[summaries/s]] — s\n`);
put('concepts/sketchnoting.md', `${fm('concept', 'notes')}Drawings.\n\n## How It Works\n- Draw.\n\n## Related\n- [[summaries/s]] — s\n`);
// A real title: this name must still be matched.
put('concepts/cornell-method.md', `${fm('concept', 'notes')}# Cornell Method\n\nColumns.\n\n## Related\n- [[summaries/s]] — s\n`);

const HUB_FM = fm('concept', 'sketchnoting, cornell method');
put('concepts/patterns.md', `${HUB_FM}Patterns related to note-taking.

## How It Works
- Cornell Method splits the page.
- Sketchnoting draws the idea.
- The Curator Team wrote this.
- A fourth item.
- A fifth item.

## Cornell Method in depth
- Details.

## Related
- [[summaries/s]] — s
`);
put('summaries/s.md', `${fm('summary', 'notes')}# S\n\n## Concepts Introduced or Referenced\n- [[patterns]]\n`);

const paths = ['entities/the-curator-team.md', 'concepts/sketchnoting.md', 'concepts/cornell-method.md', 'concepts/patterns.md'];
const report = await linkifyHubPages(DOMAIN, paths);
const hub = readFileSync(path.join(wiki, 'concepts/patterns.md'), 'utf8');
const headings = hub.split('\n').filter(l => /^#{1,6}\s/.test(l));

console.log('\nA section heading is not a page name');
ok(headings.includes('## Related'), 'the hub keeps its plain ## Related heading');
ok(headings.includes('## How It Works'), 'another page\'s first section heading stays plain text here');
ok(!/\|related\]\]/i.test(hub), 'the word "related" is linked nowhere on the hub');
ok(!/\|how it works\]\]/i.test(hub), '"How It Works" is linked nowhere on the hub');
ok(hub.includes('Patterns related to note-taking.'), 'prose using the word keeps its text');

console.log('\nReal mentions are still linked');
ok(report.linksAdded >= 3, `the pass added links (${report.linksAdded})`);
ok(hub.includes('- [[cornell-method|Cornell Method]] splits the page.'), 'a # title matches');
ok(/- \[\[sketchnoting\|Sketchnoting\]\] draws the idea\./.test(hub), 'a page with no # title matches by its slug');
ok(/\[\[the-curator-team\|The Curator Team\]\] wrote this\./.test(hub), 'a hyphenated slug matches in words');

console.log('\nHeadings and frontmatter are never rewritten');
ok(headings.includes('## Cornell Method in depth'), 'a heading naming a page stays a plain heading');
ok(!headings.some(h => h.includes('[[')), 'no heading carries a link');
const hubFm = hub.match(/^---\n[\s\S]*?\n---/)[0];
ok(!hubFm.includes('[['), 'no link landed in the frontmatter');
ok(/sketchnoting/.test(hubFm) && /cornell-method/.test(hubFm), 'the page keeps its own tags');

console.log('\nCross-check: the code the user clicks');
const scan = await scanWiki(DOMAIN);
ok((scan.missingBacklinks || []).length === 0,
  `Health finds the Related section (${(scan.missingBacklinks || []).length} missing backlinks)`);

rmSync(ROOT, { recursive: true, force: true });
console.log(`\nPassed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
