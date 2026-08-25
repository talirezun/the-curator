#!/usr/bin/env node
/**
 * Offline suite for scripts/repair-wiki.js argument handling + the opt-in
 * pronoun repair.
 *
 * WHY THIS EXISTS — the bug it pins:
 *   repair-wiki.js is DESTRUCTIVE (writeFile + rm across a wiki). Its parser
 *   used to be `args.find(a => !a.startsWith('--')) || 'articles'`. Because
 *   `--domain=business` starts with `--`, it was skipped, the `|| 'articles'`
 *   fallback fired, and the script destructively repaired `articles` — a domain
 *   the user never named — while printing "Repairing wiki for domain: articles".
 *   CLAUDE.md documented the `--domain=` form, so the documented invocation was
 *   precisely the broken one.
 *
 * Both directions are asserted. A guard that refuses everything is as broken as
 * one that refuses nothing, so every documented/valid form must be ACCEPTED and
 * resolve to the domain the caller actually named.
 *
 * SAFETY: this suite never touches a real domain. The pure-parser sections do
 * no I/O at all; the end-to-end section spawns the script with
 * CURATOR_TEST_DOMAINS_DIR pointed at an os.tmpdir() fixture, and asserts the
 * resolved domains dir IS that fixture before spawning anything destructive.
 *
 * Run:  node scripts/test-repair-wiki-args.js
 * Exit: 0 if all green; non-zero on any failure.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'repair-wiki.js');

// Importing the module must NOT run a repair. If the direct-run guard at the
// bottom of repair-wiki.js regressed, main() would fire here and process.exit(1)
// before a single assertion ran — so reaching section 1 is itself the proof.
const {
  parseRepairArgs,
  readPronounConfig,
  buildPronounReplacements,
  applyPronounReplacements,
  PRONOUN_ENV,
  USAGE,
} = await import('./repair-wiki.js');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(label), console.log(`  ✗ ${label}`));
}
function section(t) { console.log(`\n${t}`); }

const SRC = readFileSync(SCRIPT, 'utf8');

// ── 1. Importing the module is inert ────────────────────────────────────────
section('1. The module is importable without side effects');

ok(typeof parseRepairArgs === 'function', 'parseRepairArgs is exported');
ok(/invokedDirectly/.test(SRC) && /import\.meta\.url/.test(SRC),
  'repair-wiki.js guards main() behind a direct-invocation check');
ok(typeof USAGE === 'string' && USAGE.includes('--domain='),
  'USAGE text documents the --domain= form');

// ── 2. ACCEPTED forms resolve to the domain the caller named ────────────────
section('2. Valid invocations are accepted and name the right domain');

const acceptCases = [
  [['business'],                       'business', false, 'positional domain'],
  [['--domain=business'],              'business', false, '--domain=business (the documented form that used to be ignored)'],
  [['articles'],                       'articles', false, 'positional articles'],
  [['--domain=articles'],              'articles', false, '--domain=articles'],
  [['business', '--dry-run'],          'business', true,  'positional + --dry-run'],
  [['--dry-run', '--domain=business'], 'business', true,  '--dry-run before --domain='],
  [['--domain=business', '--dry-run'], 'business', true,  '--domain= before --dry-run'],
  [['business', '--domain=business'],  'business', false, 'positional and --domain= agreeing'],
  [['--domain=b', '--domain=b'],       'b',        false, 'repeated identical --domain='],
  [['shared-cohort'],                  'shared-cohort', false, 'hyphenated domain slug'],
  [['My_Domain.v2'],                   'My_Domain.v2',  false, 'underscore/dot/uppercase slug'],
];
for (const [argv, expectDomain, expectDry, label] of acceptCases) {
  const r = parseRepairArgs(argv);
  ok(r.ok === true && r.domain === expectDomain && r.dryRun === expectDry,
    `accepted: ${label} → domain="${expectDomain}" dryRun=${expectDry}`);
}

// The specific regression. This is the assertion the old parser failed.
{
  const r = parseRepairArgs(['--domain=business']);
  ok(r.ok && r.domain === 'business', 'REGRESSION PIN: --domain=business resolves to "business"');
  ok(r.domain !== 'articles', 'REGRESSION PIN: --domain=business NEVER resolves to the old hardcoded "articles"');
}

// The old expression, reproduced verbatim, to show the pin is not vacuous:
// it must disagree with the fixed parser on exactly the reported input.
{
  const legacy = (args) => args.find(a => !a.startsWith('--')) || 'articles';
  ok(legacy(['--domain=business']) === 'articles',
    'the pre-fix expression really did return "articles" for --domain=business (pin is not vacuous)');
  ok(parseRepairArgs(['--domain=business']).domain !== legacy(['--domain=business']),
    'the fixed parser disagrees with the pre-fix expression on that input');
}

// No accepted parse may ever invent a domain that appears in no argument.
{
  const probes = [['x'], ['--domain=x'], ['x', '--dry-run'], ['--dry-run', '--domain=x']];
  let invented = false;
  for (const p of probes) {
    const r = parseRepairArgs(p);
    if (r.ok && !p.some(a => a === r.domain || a === `--domain=${r.domain}`)) invented = true;
  }
  ok(!invented, 'no accepted parse yields a domain that appears in no argument');
}

// ── 3. REFUSED forms ────────────────────────────────────────────────────────
section('3. Dangerous / ambiguous invocations are refused');

const refuseCases = [
  [[],                                    'bare invocation (no domain) — must not default to a destructive run'],
  [['--dry-run'],                         '--dry-run alone still names no domain'],
  [['--typo'],                            'unrecognised flag is refused, not ignored'],
  [['--domain'],                          'bare --domain (no "=") is refused, not ignored'],
  [['--domains=business'],                'near-miss flag --domains= is refused'],
  [['--Domain=business'],                 'case-variant flag is refused (not silently ignored)'],
  [['--dry_run', 'business'],             'near-miss --dry_run is refused rather than treated as a no-op'],
  [['--domain='],                         'empty --domain= value'],
  [['articles', 'business'],              'two positionals'],
  [['articles', '--domain=business'],     'positional and --domain= disagreeing'],
  [['--domain=a', '--domain=b'],          'two different --domain= values'],
  [['../../etc'],                         'parent-traversal domain name'],
  [['../articles'],                       'relative traversal domain name'],
  [['a/b'],                               'domain containing a path separator'],
  [['a\\b'],                              'domain containing a backslash'],
  [['/etc/passwd'],                       'absolute path as domain'],
  [['.'],                                 'dot as domain'],
  [['..'],                                'dot-dot as domain'],
  [[''],                                  'empty-string positional'],
  [['articles; rm -rf ~'],                'shell metacharacters in the domain name'],
  [['articles business --dry-run'],       'one arg containing spaces (quoted multi-domain)'],
];
for (const [argv, label] of refuseCases) {
  const r = parseRepairArgs(argv);
  ok(r.ok !== true && !r.help && typeof r.error === 'string' && r.error.length > 0,
    `refused with a message: ${label}`);
}

// --help is a refusal-to-run, but a benign one: no error, and no domain.
{
  const h = parseRepairArgs(['--help']);
  ok(h.ok !== true && h.help === true && h.domain === undefined, '--help returns help, not a domain');
  ok(parseRepairArgs(['-h']).help === true, '-h returns help');
  ok(parseRepairArgs(['business', '--help']).help === true, '--help wins even with a domain present');
}

// ── 4. parseRepairArgs is pure ──────────────────────────────────────────────
section('4. parseRepairArgs is pure (no I/O, no exit, no env)');

{
  const argvBefore = process.argv.slice();
  const envBefore = JSON.stringify(process.env);
  parseRepairArgs(['business', '--dry-run']);
  parseRepairArgs([]);
  parseRepairArgs(['--typo']);
  ok(JSON.stringify(process.argv) === JSON.stringify(argvBefore), 'does not mutate process.argv');
  ok(JSON.stringify(process.env) === envBefore, 'does not mutate process.env');
  const r = parseRepairArgs(new Array(500).fill('--dry-run'));
  ok(r.ok !== true, 'a 500-flag argv still returns (no throw, no hang)');
  // process.argv is always strings, so this only pins "does not throw". A
  // number stringifies to a legal directory name and is legitimately accepted;
  // an object stringifies to something DOMAIN_RE refuses.
  let threw = false;
  try { parseRepairArgs([123]); parseRepairArgs([{}]); parseRepairArgs([null]); } catch { threw = true; }
  ok(!threw, 'non-string args are coerced safely rather than thrown on');
  ok(parseRepairArgs([{}]).ok !== true, 'an object arg stringifies to something refused');
}

// ── 5. Pronoun repair is opt-in and de-personalised ─────────────────────────
section('5. Pronoun repair: opt-in config');

ok(readPronounConfig({}).enabled === false, 'unset env → disabled (clean self-skip)');
ok(readPronounConfig({ [PRONOUN_ENV.page]: 'entities/x.md' }).error,
  'partially configured (page only) → error, not a silent skip');
ok(readPronounConfig({ [PRONOUN_ENV.from]: 'she', [PRONOUN_ENV.to]: 'he' }).error,
  'partially configured (from/to only) → error');
ok(readPronounConfig({ [PRONOUN_ENV.page]: 'entities/x.md', [PRONOUN_ENV.from]: 'she', [PRONOUN_ENV.to]: 'zzz' }).error,
  'unknown pronoun set → error');
ok(readPronounConfig({ [PRONOUN_ENV.page]: 'entities/x.md', [PRONOUN_ENV.from]: 'she', [PRONOUN_ENV.to]: 'she' }).error,
  'from === to → error');
ok(readPronounConfig({ [PRONOUN_ENV.page]: '__proto__', [PRONOUN_ENV.from]: 'she', [PRONOUN_ENV.to]: 'he' }).error,
  'non-.md page → error');
ok(readPronounConfig({ [PRONOUN_ENV.page]: '../../secrets.md', [PRONOUN_ENV.from]: 'she', [PRONOUN_ENV.to]: 'he' }).error,
  'page with ".." → error (stays inside the wiki)');
ok(readPronounConfig({ [PRONOUN_ENV.page]: '/etc/x.md', [PRONOUN_ENV.from]: 'she', [PRONOUN_ENV.to]: 'he' }).error,
  'absolute page path → error');
ok(readPronounConfig({ [PRONOUN_ENV.page]: 'entities/__proto__.md', [PRONOUN_ENV.from]: 'constructor', [PRONOUN_ENV.to]: 'he' }).error,
  'prototype key as a pronoun set → error (own-property check)');
{
  const good = readPronounConfig({ [PRONOUN_ENV.page]: 'entities/some-person.md', [PRONOUN_ENV.from]: 'SHE', [PRONOUN_ENV.to]: ' he ' });
  ok(good.enabled && !good.error && good.page === 'entities/some-person.md' && good.from === 'she' && good.to === 'he',
    'valid config parses (case/whitespace tolerant)');
}

// ── 6. Pronoun rewriting: behaviour preserved, scope honest ─────────────────
section('6. Pronoun rewriting behaviour');

// Corpus deliberately includes a sentence about a DIFFERENT person, to pin that
// the rewrite stays anchored and does not sweep bare pronouns.
const CORPUS = [
  'She founded the lab in 2019.',
  'A note: she founded a second lab later.',
  'Her work spans two fields.',
  'Cited: her work appears in three journals.',
  'Her methodology is unusual.',
  'See her methodology below.',
  'Shares insights through her "From Lab to Life" series.',
  'A colleague, Dr Ada Lovelace, kept her own notes.',
  'They met in 2020.',
].join('\n');

// The pre-fix hardcoded chain, reproduced verbatim, as the equivalence oracle.
function legacyPronounFix(input) {
  let c = input;
  c = c.replace(/\bShe founded\b/g, 'He founded');
  c = c.replace(/\bshe founded\b/g, 'he founded');
  c = c.replace(/\bHer work\b/g, 'His work');
  c = c.replace(/\bher work\b/g, 'his work');
  c = c.replace(/\bHer methodology\b/g, 'His methodology');
  c = c.replace(/\bher methodology\b/g, 'his methodology');
  c = c.replace(/\bthrough her\b/g, 'through his');
  c = c.replace(/\bthrough his "From Lab to Life" series\./g, 'through his "From Lab to Life" series.');
  c = c.replace(/through her "From Lab to Life"/g, 'through his "From Lab to Life"');
  return c;
}

const sheToHe = applyPronounReplacements(CORPUS, buildPronounReplacements('she', 'he'));
ok(sheToHe === legacyPronounFix(CORPUS),
  'she→he output is byte-identical to the pre-fix hardcoded chain (capability preserved)');
ok(sheToHe !== CORPUS, 'the equivalence oracle is not vacuous — the corpus really does change');
ok(sheToHe.includes('He founded') && sheToHe.includes('his work') && sheToHe.includes('through his "From Lab to Life"'),
  'she→he rewrites the anchored phrases');
ok(sheToHe.includes('kept her own notes'),
  'HONEST SCOPE: a bare pronoun about another person is NOT rewritten');

{
  const theyOut = applyPronounReplacements(CORPUS, buildPronounReplacements('she', 'they'));
  ok(theyOut.includes('They founded') && theyOut.includes('Their work') && theyOut.includes('through their'),
    'she→they works (direction is data, not hardcoded)');
  const back = applyPronounReplacements(sheToHe, buildPronounReplacements('he', 'she'));
  ok(back === CORPUS, 'he→she round-trips the anchored phrases back to the original');
  ok(buildPronounReplacements('she', 'nope').length === 0, 'unknown direction yields no replacements');
  ok(applyPronounReplacements('unchanged', []) === 'unchanged', 'an empty replacement list is a no-op');
}

// ── 7. Source guards ────────────────────────────────────────────────────────
section('7. Source guards on repair-wiki.js');

ok(!/\|\|\s*['"]articles['"]/.test(SRC),
  'no `|| \'articles\'` default-domain fallback anywhere in the file');
ok(!/find\(\s*a\s*=>\s*!\s*a\.startsWith\('--'\)\s*\)/.test(SRC),
  'the positional-only find() that swallowed --domain= is gone');
ok(!/join\([^)]*['"]entities['"]\s*,\s*['"][^'"]+\.md['"]/.test(SRC),
  'Part 3 builds no hardcoded entities/<person>.md path (target comes from config)');
ok(!/\bis\s+(male|female)\b/i.test(SRC),
  'no hardcoded gender assertion about any individual');
ok(!/execSync\(`/.test(SRC),
  'the child process is not spawned through a shell template string');
ok(SRC.includes('execFileSync'), 'Part 4 spawns inject-summary-backlinks via execFileSync (no shell)');
ok(/cfg\.page/.test(SRC), 'fixPronouns reads its target page from the config object');

// ── 8. End-to-end against a THROWAWAY tempdir (never a real domain) ─────────
section('8. End-to-end: the real script, isolated to a tempdir');

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'repair-wiki-args-'));
let e2eRan = false;
try {
  for (const d of ['articles', 'business']) {
    mkdirSync(path.join(tmpRoot, d, 'wiki', 'entities'), { recursive: true });
    mkdirSync(path.join(tmpRoot, d, 'wiki', 'concepts'), { recursive: true });
    mkdirSync(path.join(tmpRoot, d, 'wiki', 'summaries'), { recursive: true });
    writeFileSync(path.join(tmpRoot, d, 'CLAUDE.md'), `# ${d}\n`);
    writeFileSync(path.join(tmpRoot, d, 'wiki', 'entities', 'google.md'),
      '---\ntype: entity\n---\n# Google\n\n## Key Facts\n- entity fact\n');
    writeFileSync(path.join(tmpRoot, d, 'wiki', 'concepts', 'google.md'),
      '---\ntype: concept\n---\n# Google\n\n## Key Facts\n- concept fact\n');
  }

  // HARD PRECONDITION: prove the isolation before running anything destructive.
  const resolved = execFileSync(process.execPath, ['-e',
    "import('./src/brain/config.js').then(m=>process.stdout.write(m.getDomainsDir()))"
  ], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, CURATOR_TEST_DOMAINS_DIR: tmpRoot }, encoding: 'utf8' });
  const isolated = path.resolve(resolved) === path.resolve(tmpRoot);
  ok(isolated, 'PRECONDITION: the resolved domains dir is the tempdir, not the real one');

  if (!isolated) throw new Error('refusing to run the destructive script: domains dir is not the tempdir');
  e2eRan = true;

  const run = (args) => {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, CURATOR_TEST_DOMAINS_DIR: tmpRoot },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out: stdout };
    } catch (err) {
      return { code: err.status ?? 1, out: `${err.stdout || ''}${err.stderr || ''}` };
    }
  };

  const bare = run([]);
  ok(bare.code !== 0 && /Usage:/.test(bare.out), 'bare invocation exits non-zero with usage text');
  ok(!/Repairing wiki for domain/.test(bare.out), 'bare invocation repairs nothing');
  ok(existsSync(path.join(tmpRoot, 'articles', 'wiki', 'concepts', 'google.md')),
    'bare invocation left articles untouched (the old default-domain victim)');

  const badFlag = run(['--typo', 'business']);
  ok(badFlag.code !== 0 && /Unrecognised option/.test(badFlag.out), 'unknown flag exits non-zero');

  const dry = run(['business', '--dry-run']);
  ok(dry.code === 0 && /DRY RUN/.test(dry.out), '--dry-run runs and announces itself');
  ok(existsSync(path.join(tmpRoot, 'business', 'wiki', 'concepts', 'google.md')),
    '--dry-run wrote/deleted nothing');

  const real = run(['--domain=business']);
  ok(real.code === 0 && /Repairing wiki for domain: business/.test(real.out),
    '--domain=business announces the domain the user named');
  ok(!existsSync(path.join(tmpRoot, 'business', 'wiki', 'concepts', 'google.md')),
    '--domain=business really repaired business (duplicate merged away)');
  ok(existsSync(path.join(tmpRoot, 'articles', 'wiki', 'concepts', 'google.md')),
    'THE BUG: articles was NOT touched by --domain=business');

  // Pronoun repair, driven entirely by env, on a page named by the caller.
  const personPage = path.join(tmpRoot, 'business', 'wiki', 'entities', 'sample-person.md');
  writeFileSync(personPage, '# Sample Person\n\n- She founded the lab.\n- Her work is cited.\n');
  const pronouns = execFileSync(process.execPath, [SCRIPT, '--domain=business'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      CURATOR_TEST_DOMAINS_DIR: tmpRoot,
      [PRONOUN_ENV.page]: 'entities/sample-person.md',
      [PRONOUN_ENV.from]: 'she',
      [PRONOUN_ENV.to]: 'he',
    },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const after = readFileSync(personPage, 'utf8');
  ok(/He founded/.test(after) && /His work/.test(after), 'opt-in pronoun repair rewrote the configured page');
  ok(/corrected she → he/.test(pronouns), 'pronoun repair reports the configured direction');

  const skipped = run(['articles']);
  ok(/Skipped — not configured/.test(skipped.out), 'with no pronoun env set, Part 3 self-skips cleanly');
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
ok(e2eRan, 'the end-to-end section actually ran (not silently skipped)');
ok(!existsSync(tmpRoot), 'tempdir cleaned up');

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All repair-wiki argument + pronoun-config assertions green.');
