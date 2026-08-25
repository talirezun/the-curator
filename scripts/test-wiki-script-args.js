#!/usr/bin/env node
/**
 * Offline suite for the argument handling of the two destructive wiki-repair
 * scripts that are NOT covered by test-repair-wiki-args.js:
 *
 *   scripts/fix-wiki-duplicates.js
 *   scripts/fix-wiki-structure.js
 *
 * WHY THIS EXISTS — the bugs it pins:
 *
 *   A. fix-wiki-duplicates.js parsed its domain with
 *        `args.find(a => !a.startsWith('--')) || 'articles'`
 *      — byte-identical to the expression that made repair-wiki.js repair the
 *      wrong domain. Because `--domain=business` starts with `--`, it was
 *      skipped, the `|| 'articles'` fallback fired, and the script MERGED AND
 *      DELETED files in `articles` while printing "Deduplicating wiki for
 *      domain: articles" and leaving `business` untouched. Reproduced live in a
 *      tempdir before the fix; section 9 reproduces the same scenario and
 *      asserts the opposite outcome.
 *
 *   B. fix-wiki-structure.js read `process.argv[2]` directly, so `--domain=X`
 *      was taken as a LITERAL directory name; fixDomain() then returned
 *      silently on the missing wiki/ folder and the run exited 0 printing
 *      "Done. Review the changes above" with nothing above it — a success
 *      report over a total no-op. Separately, a BARE invocation walked and
 *      mutated EVERY domain. The all-domains capability is real and documented,
 *      so it was kept behind an explicit `--all`; only the accidental default
 *      was removed.
 *
 * Both directions are asserted throughout. A guard that refuses everything is
 * as broken as one that refuses nothing, so every valid documented form must be
 * ACCEPTED and resolve to the target the caller actually named.
 *
 * Section 7 additionally pins the CLASS: all three scripts must agree on every
 * argument shape they share. Fixing one sibling and leaving the others is the
 * failure mode this whole suite exists to prevent.
 *
 * SAFETY: this suite never touches a real domain. The pure-parser sections do
 * no I/O at all; the end-to-end section spawns the scripts with
 * CURATOR_TEST_DOMAINS_DIR pointed at an os.tmpdir() fixture, and asserts the
 * resolved domains dir IS that fixture before spawning anything destructive.
 *
 * Run:  node scripts/test-wiki-script-args.js
 * Exit: 0 if all green; non-zero on any failure.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DUP_SCRIPT = path.join(__dirname, 'fix-wiki-duplicates.js');
const STRUCT_SCRIPT = path.join(__dirname, 'fix-wiki-structure.js');

// Importing these modules must NOT run a repair. If either direct-run guard
// regressed, main() would fire here — deduplicating or migrating whatever
// domain it guessed — before a single assertion ran. Reaching section 1 is
// itself part of the proof.
const { parseDedupeArgs, USAGE: DUP_USAGE } = await import('./fix-wiki-duplicates.js');
const { parseStructureArgs, USAGE: STRUCT_USAGE } = await import('./fix-wiki-structure.js');
const { parseRepairArgs } = await import('./repair-wiki.js');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(label), console.log(`  ✗ ${label}`));
}
function section(t) { console.log(`\n${t}`); }

const DUP_SRC = readFileSync(DUP_SCRIPT, 'utf8');
const STRUCT_SRC = readFileSync(STRUCT_SCRIPT, 'utf8');

// ── 1. Importing the modules is inert ───────────────────────────────────────
section('1. Both modules are importable without side effects');

ok(typeof parseDedupeArgs === 'function', 'fix-wiki-duplicates exports parseDedupeArgs');
ok(typeof parseStructureArgs === 'function', 'fix-wiki-structure exports parseStructureArgs');
for (const [name, src] of [['fix-wiki-duplicates', DUP_SRC], ['fix-wiki-structure', STRUCT_SRC]]) {
  // Test the GATE, not just the identifier. Merely asserting /invokedDirectly/
  // stays green if someone leaves the const in place and changes the branch to
  // `if (true)` — which is precisely the regression that turns a plain import
  // into a destructive run (verified by mutation: with the gate defeated, an
  // import-only consumer deleted a wiki file).
  ok(/const invokedDirectly = /.test(src) && /import\.meta\.url/.test(src),
    `${name}.js computes a direct-invocation check`);
  ok(/if \(invokedDirectly\) \{/.test(src),
    `${name}.js actually gates main() on it (not \`if (true)\`)`);
}
ok(typeof DUP_USAGE === 'string' && DUP_USAGE.includes('--domain='),
  'fix-wiki-duplicates USAGE documents the --domain= form');
ok(typeof STRUCT_USAGE === 'string' && STRUCT_USAGE.includes('--domain=') && STRUCT_USAGE.includes('--all'),
  'fix-wiki-structure USAGE documents --domain= and --all');

// ── 2. fix-wiki-duplicates: ACCEPTED forms ──────────────────────────────────
section('2. fix-wiki-duplicates: valid invocations are accepted and name the right domain');

const dupAccept = [
  [['business'],                       'business', false, 'positional domain'],
  [['--domain=business'],              'business', false, '--domain=business (the form that used to be ignored)'],
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
for (const [argv, expectDomain, expectDry, label] of dupAccept) {
  const r = parseDedupeArgs(argv);
  ok(r.ok === true && r.domain === expectDomain && r.dryRun === expectDry,
    `accepted: ${label} → domain="${expectDomain}" dryRun=${expectDry}`);
}

// The specific regression. This is the assertion the old parser failed.
{
  const r = parseDedupeArgs(['--domain=business']);
  ok(r.ok && r.domain === 'business', 'REGRESSION PIN: --domain=business resolves to "business"');
  ok(r.domain !== 'articles', 'REGRESSION PIN: --domain=business NEVER resolves to the old hardcoded "articles"');
}

// The old expression, reproduced verbatim, to show the pin is not vacuous.
{
  const legacy = (args) => args.find(a => !a.startsWith('--')) || 'articles';
  ok(legacy(['--domain=business']) === 'articles',
    'the pre-fix expression really did return "articles" for --domain=business (pin is not vacuous)');
  ok(parseDedupeArgs(['--domain=business']).domain !== legacy(['--domain=business']),
    'the fixed parser disagrees with the pre-fix expression on that input');
}

// No accepted parse may ever invent a domain that appears in no argument.
{
  const probes = [['x'], ['--domain=x'], ['x', '--dry-run'], ['--dry-run', '--domain=x']];
  let invented = false;
  for (const p of probes) {
    const r = parseDedupeArgs(p);
    if (r.ok && !p.some(a => a === r.domain || a === `--domain=${r.domain}`)) invented = true;
  }
  ok(!invented, 'no accepted parse yields a domain that appears in no argument');
}

// ── 3. fix-wiki-duplicates: REFUSED forms ───────────────────────────────────
section('3. fix-wiki-duplicates: dangerous / ambiguous invocations are refused');

const SHARED_REFUSALS = [
  [[],                                'bare invocation (no domain) — must not default to a destructive run'],
  [['--dry-run'],                     '--dry-run alone still names no domain'],
  [['--typo'],                        'unrecognised flag is refused, not ignored'],
  [['--domain'],                      'bare --domain (no "=") is refused, not ignored'],
  [['--domains=business'],            'near-miss flag --domains= is refused'],
  [['--Domain=business'],             'case-variant flag is refused (not silently ignored)'],
  [['--dry_run', 'business'],         'near-miss --dry_run is refused rather than treated as a no-op'],
  [['--domain='],                     'empty --domain= value'],
  [['articles', 'business'],          'two positionals'],
  [['articles', '--domain=business'], 'positional and --domain= disagreeing'],
  [['--domain=a', '--domain=b'],      'two different --domain= values'],
  [['../../etc'],                     'parent-traversal domain name'],
  [['../articles'],                   'relative traversal domain name'],
  [['a/b'],                           'domain containing a path separator'],
  [['a\\b'],                          'domain containing a backslash'],
  [['/etc/passwd'],                   'absolute path as domain'],
  [['.'],                             'dot as domain'],
  [['..'],                            'dot-dot as domain'],
  [[''],                              'empty-string positional'],
  [['articles; rm -rf ~'],            'shell metacharacters in the domain name'],
  [['articles business --dry-run'],   'one arg containing spaces (quoted multi-domain)'],
];
for (const [argv, label] of SHARED_REFUSALS) {
  const r = parseDedupeArgs(argv);
  ok(r.ok !== true && !r.help && typeof r.error === 'string' && r.error.length > 0,
    `refused with a message: ${label}`);
}
// A flag must be refused FOR BEING AN UNKNOWN FLAG — not incidentally, because
// no domain happened to be named. Without this, an "ignore unknown flags"
// regression still looks refused for `['--typo']` (the ignored flag leaves no
// positional, so the no-domain branch fires) and the guard reads green while
// `['--typo', 'business']` silently runs a destructive job.
for (const flag of ['--typo', '--domain', '--domains=business', '--Domain=business', '--all', '--force', '-x']) {
  const alone = parseDedupeArgs([flag]);
  const withDomain = parseDedupeArgs([flag, 'business']);
  ok(/Unrecognised option/.test(alone.error || '') || /--domain=/.test(alone.error || ''),
    `refused BY NAME, not incidentally: ${flag} alone`);
  ok(withDomain.ok !== true,
    `refused even when a valid domain is also present: ${flag} business`);
}

// --help is a refusal-to-run, but a benign one: no error, and no domain.
{
  const h = parseDedupeArgs(['--help']);
  ok(h.ok !== true && h.help === true && h.domain === undefined, '--help returns help, not a domain');
  ok(parseDedupeArgs(['-h']).help === true, '-h returns help');
  ok(parseDedupeArgs(['business', '--help']).help === true, '--help wins even with a domain present');
}

// ── 4. fix-wiki-structure: ACCEPTED forms ───────────────────────────────────
section('4. fix-wiki-structure: valid invocations are accepted and name the right target');

const structAccept = [
  [['business'],                       { domain: 'business', all: false, dryRun: false }, 'positional domain'],
  [['--domain=business'],              { domain: 'business', all: false, dryRun: false }, '--domain=business (was a silent no-op)'],
  [['articles', '--dry-run'],          { domain: 'articles', all: false, dryRun: true },  'positional + --dry-run'],
  [['--domain=articles', '--dry-run'], { domain: 'articles', all: false, dryRun: true },  '--domain= + --dry-run'],
  [['--all'],                          { domain: null, all: true, dryRun: false },        '--all (the preserved all-domains capability)'],
  [['--all', '--dry-run'],             { domain: null, all: true, dryRun: true },         '--all --dry-run'],
  [['--dry-run', '--all'],             { domain: null, all: true, dryRun: true },         '--dry-run before --all'],
  [['shared-cohort'],                  { domain: 'shared-cohort', all: false, dryRun: false }, 'hyphenated domain slug'],
  [['business', '--domain=business'],  { domain: 'business', all: false, dryRun: false }, 'positional and --domain= agreeing'],
];
for (const [argv, expect, label] of structAccept) {
  const r = parseStructureArgs(argv);
  ok(r.ok === true && r.domain === expect.domain && r.all === expect.all && r.dryRun === expect.dryRun,
    `accepted: ${label} → domain=${JSON.stringify(expect.domain)} all=${expect.all} dryRun=${expect.dryRun}`);
}

// The capability decision, pinned explicitly in BOTH directions.
{
  ok(parseStructureArgs(['--all']).all === true,
    'CAPABILITY PIN: the documented all-domains migration still exists (via --all)');
  ok(parseStructureArgs([]).ok !== true,
    'CAPABILITY PIN: but it is no longer what a bare invocation does');
  ok(parseStructureArgs(['--all']).domain === null,
    '--all sets no domain (the two are mutually exclusive results)');
  const one = parseStructureArgs(['business']);
  ok(one.all === false, 'naming one domain never implies --all');
}

// ── 5. fix-wiki-structure: REFUSED forms ────────────────────────────────────
section('5. fix-wiki-structure: dangerous / ambiguous invocations are refused');

for (const [argv, label] of SHARED_REFUSALS) {
  const r = parseStructureArgs(argv);
  ok(r.ok !== true && !r.help && typeof r.error === 'string' && r.error.length > 0,
    `refused with a message: ${label}`);
}
// Same precision requirement as section 3: refused for being unknown, not
// incidentally for leaving no positional behind. `--all` is omitted — it is
// this script's own valid flag.
for (const flag of ['--typo', '--domain', '--domains=business', '--Domain=business', '--force', '-x']) {
  const alone = parseStructureArgs([flag]);
  ok(/Unrecognised option/.test(alone.error || '') || /--domain=/.test(alone.error || ''),
    `refused BY NAME, not incidentally: ${flag} alone`);
  ok(parseStructureArgs([flag, 'business']).ok !== true,
    `refused even when a valid domain is also present: ${flag} business`);
  ok(parseStructureArgs([flag, '--all']).ok !== true,
    `refused even when --all is also present: ${flag} --all`);
}
{
  const conflict = parseStructureArgs(['--all', 'business']);
  ok(conflict.ok !== true && /--all/.test(conflict.error),
    'refused: --all combined with a named domain (ambiguous scope)');
  ok(parseStructureArgs(['--all', '--domain=business']).ok !== true,
    'refused: --all combined with --domain=');
  ok(parseStructureArgs(['--all', '../../etc']).ok !== true,
    'refused: --all with a traversal positional (conflict is caught, not bypassed)');
}
{
  const h = parseStructureArgs(['--help']);
  ok(h.ok !== true && h.help === true, '--help returns help');
  ok(parseStructureArgs(['--all', '--help']).help === true, '--help wins even with --all present');
}

// ── 6. Both parsers are pure ────────────────────────────────────────────────
section('6. Both parsers are pure (no I/O, no exit, no env)');

for (const [name, parse] of [['parseDedupeArgs', parseDedupeArgs], ['parseStructureArgs', parseStructureArgs]]) {
  const argvBefore = process.argv.slice();
  const envBefore = JSON.stringify(process.env);
  parse(['business', '--dry-run']);
  parse([]);
  parse(['--typo']);
  ok(JSON.stringify(process.argv) === JSON.stringify(argvBefore), `${name} does not mutate process.argv`);
  ok(JSON.stringify(process.env) === envBefore, `${name} does not mutate process.env`);
  const r = parse(new Array(500).fill('--dry-run'));
  ok(r.ok !== true, `${name}: a 500-flag argv still returns (no throw, no hang)`);
  // process.argv is always strings, so this only pins "does not throw". A
  // number stringifies to a legal directory name and is legitimately accepted;
  // an object stringifies to something DOMAIN_RE refuses.
  let threw = false;
  try { parse([123]); parse([{}]); parse([null]); } catch { threw = true; }
  ok(!threw, `${name}: non-string args are coerced safely rather than thrown on`);
  ok(parse([{}]).ok !== true, `${name}: an object arg stringifies to something refused`);
}

// ── 7. THE CLASS: all three scripts share one argument contract ─────────────
section('7. Class invariant: all three destructive scripts agree on shared argument shapes');

// Every shape below is one all three scripts must handle identically. --all is
// excluded because it is fix-wiki-structure's own capability; everything else
// is common ground. Fixing one script and leaving a sibling broken is the exact
// failure mode this section exists to make impossible.
const CONTRACT_ACCEPT = [
  ['business'], ['--domain=business'], ['business', '--dry-run'],
  ['--domain=business', '--dry-run'], ['--dry-run', '--domain=business'],
  ['shared-cohort'], ['--domain=b', '--domain=b'],
];
const PARSERS = [
  ['fix-wiki-duplicates', parseDedupeArgs],
  ['fix-wiki-structure', parseStructureArgs],
  ['repair-wiki', parseRepairArgs],
];
for (const argv of CONTRACT_ACCEPT) {
  const verdicts = PARSERS.map(([n, p]) => {
    const r = p(argv);
    return { n, ok: r.ok === true, domain: r.domain, dryRun: r.dryRun };
  });
  const allOk = verdicts.every(v => v.ok);
  const sameDomain = new Set(verdicts.map(v => v.domain)).size === 1;
  const sameDry = new Set(verdicts.map(v => v.dryRun)).size === 1;
  ok(allOk && sameDomain && sameDry,
    `contract: [${argv.join(' ')}] accepted identically by all three (domain=${verdicts[0].domain}, dryRun=${verdicts[0].dryRun})`);
}
for (const [argv, label] of SHARED_REFUSALS) {
  const verdicts = PARSERS.map(([n, p]) => ({ n, refused: p(argv).ok !== true }));
  ok(verdicts.every(v => v.refused),
    `contract: refused by all three — ${label}`);
}
{
  const helps = PARSERS.map(([, p]) => p(['--help']).help === true);
  ok(helps.every(Boolean), 'contract: --help is help in all three');
}

// ── 8. Source guards ────────────────────────────────────────────────────────
section('8. Source guards');

ok(!/\|\|\s*['"]articles['"]/.test(DUP_SRC),
  'fix-wiki-duplicates: no `|| \'articles\'` default-domain fallback anywhere in the file');
ok(!/find\(\s*a\s*=>\s*!\s*a\.startsWith\('--'\)\s*\)/.test(DUP_SRC),
  'fix-wiki-duplicates: the positional-only find() that swallowed --domain= is gone');
// Assignment-shaped on purpose. A bare /process\.argv\[2\]/ also matches the
// file's own docblock, which NAMES the removed expression — so that form would
// fail for a prose reason rather than a behavioural one, which is worse than no
// guard. Honest scope: this catches the exact regression (`x = process.argv[2]`),
// not every conceivable way to re-read a raw positional. The end-to-end
// assertions in section 9 are what actually pin the behaviour.
ok(!/=\s*process\.argv\[2\]/.test(STRUCT_SRC),
  'fix-wiki-structure: nothing assigns from a bare process.argv[2] any more');
ok(/It read `process\.argv\[2\]` directly/.test(STRUCT_SRC),
  'the guard above is not vacuous — the string does occur in the file, in prose');
for (const [name, src] of [['fix-wiki-duplicates', DUP_SRC], ['fix-wiki-structure', STRUCT_SRC]]) {
  ok(!/execSync\(`/.test(src), `${name}: no shell template-string child process`);
  ok(/DOMAIN_RE/.test(src), `${name}: validates the domain against a single-path-segment regex`);
}
// The destructive calls must still be behind a dryRun gate in both files.
ok(/if\s*\(\s*!\s*dryRun\s*\)/.test(DUP_SRC), 'fix-wiki-duplicates: writes/deletes are gated on !dryRun');
ok((STRUCT_SRC.match(/!\s*dryRun/g) || []).length >= 4,
  'fix-wiki-structure: dryRun is threaded through its write/move/delete sites');

// ── 9. End-to-end against a THROWAWAY tempdir (never a real domain) ─────────
section('9. End-to-end: the real scripts, isolated to a tempdir');

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'wiki-script-args-'));
let e2eRan = false;

function seed() {
  for (const d of ['articles', 'business']) {
    for (const sub of ['entities', 'concepts', 'summaries', 'people']) {
      mkdirSync(path.join(tmpRoot, d, 'wiki', sub), { recursive: true });
    }
    writeFileSync(path.join(tmpRoot, d, 'CLAUDE.md'), `# ${d}\n`);
    // A pair that the entity hyphen-strip rule will merge (and DELETE one of).
    writeFileSync(path.join(tmpRoot, d, 'wiki', 'entities', 'blocklabs.md'),
      '---\ntype: entity\n---\n# Block Labs\n\n## Key Facts\n- from blocklabs\n');
    writeFileSync(path.join(tmpRoot, d, 'wiki', 'entities', 'block-labs.md'),
      '---\ntype: entity\n---\n# Block Labs\n\n## Key Facts\n- from block-labs\n');
    // A non-canonical folder for fix-wiki-structure to migrate.
    writeFileSync(path.join(tmpRoot, d, 'wiki', 'people', 'someone.md'),
      `# Someone\n\n## Key Facts\n- people file in ${d}\n`);
  }
}

/** Recursive content fingerprint — proves --dry-run changed nothing at all. */
function fingerprint(dir) {
  const h = createHash('sha256');
  const walk = (p, rel) => {
    for (const name of readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(p, name.name);
      const r = path.posix.join(rel, name.name);
      if (name.isDirectory()) { h.update(`D:${r}\n`); walk(full, r); }
      else { h.update(`F:${r}:${readFileSync(full, 'utf8')}\n`); }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

try {
  seed();

  // HARD PRECONDITION: prove the isolation before running anything destructive.
  const resolved = execFileSync(process.execPath, ['-e',
    "import('./src/brain/config.js').then(m=>process.stdout.write(m.getDomainsDir()))"
  ], { cwd: ROOT, env: { ...process.env, CURATOR_TEST_DOMAINS_DIR: tmpRoot }, encoding: 'utf8' });
  const isolated = path.resolve(resolved) === path.resolve(tmpRoot);
  ok(isolated, 'PRECONDITION: the resolved domains dir is the tempdir, not the real one');
  if (!isolated) throw new Error('refusing to run the destructive scripts: domains dir is not the tempdir');
  e2eRan = true;

  const run = (script, args) => {
    try {
      const stdout = execFileSync(process.execPath, [script, ...args], {
        cwd: ROOT,
        env: { ...process.env, CURATOR_TEST_DOMAINS_DIR: tmpRoot },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out: stdout };
    } catch (err) {
      return { code: err.status ?? 1, out: `${err.stdout || ''}${err.stderr || ''}` };
    }
  };
  const dupFile = (d, f) => path.join(tmpRoot, d, 'wiki', 'entities', f);
  const peopleDir = (d) => path.join(tmpRoot, d, 'wiki', 'people');

  // ---- fix-wiki-duplicates ----
  console.log('\n  fix-wiki-duplicates.js');

  const dBare = run(DUP_SCRIPT, []);
  ok(dBare.code !== 0 && /Usage:/.test(dBare.out), 'bare invocation exits non-zero with usage text');
  ok(!/Deduplicating wiki for domain/.test(dBare.out), 'bare invocation deduplicates nothing');
  ok(existsSync(dupFile('articles', 'block-labs.md')),
    'bare invocation left articles untouched (the old default-domain victim)');

  const dBad = run(DUP_SCRIPT, ['--typo', 'business']);
  ok(dBad.code !== 0 && /Unrecognised option/.test(dBad.out), 'unknown flag exits non-zero');

  const beforeDry = fingerprint(tmpRoot);
  const dDry = run(DUP_SCRIPT, ['business', '--dry-run']);
  ok(dDry.code === 0 && /DRY RUN/.test(dDry.out), '--dry-run runs and announces itself');
  ok(/MERGE/.test(dDry.out), '--dry-run still REPORTS the merge it would make (not a silent no-op)');
  ok(fingerprint(tmpRoot) === beforeDry, '--dry-run wrote and deleted nothing (recursive checksum unchanged)');

  const dReal = run(DUP_SCRIPT, ['--domain=business']);
  ok(dReal.code === 0 && /Deduplicating wiki for domain: business/.test(dReal.out),
    '--domain=business announces the domain the user named');
  ok(!existsSync(dupFile('business', 'block-labs.md')),
    '--domain=business really deduplicated business (duplicate deleted)');
  ok(existsSync(dupFile('articles', 'block-labs.md')),
    'THE BUG: articles was NOT touched by --domain=business');

  // ---- fix-wiki-structure ----
  console.log('\n  fix-wiki-structure.js');

  const sBare = run(STRUCT_SCRIPT, []);
  ok(sBare.code !== 0 && /Usage:/.test(sBare.out), 'bare invocation exits non-zero with usage text');
  ok(!/Domain: /.test(sBare.out), 'bare invocation migrates nothing');
  ok(existsSync(path.join(peopleDir('articles'), 'someone.md'))
    && existsSync(path.join(peopleDir('business'), 'someone.md')),
    'THE BUG: a bare invocation no longer mutates EVERY domain');

  const sBad = run(STRUCT_SCRIPT, ['--typo']);
  ok(sBad.code !== 0 && /Unrecognised option/.test(sBad.out), 'unknown flag exits non-zero');

  const sMissing = run(STRUCT_SCRIPT, ['no-such-domain']);
  ok(sMissing.code !== 0 && /No wiki found for domain/.test(sMissing.out),
    'a domain with no wiki/ fails loudly (was: exit 0 reporting "Done")');

  const beforeSDry = fingerprint(tmpRoot);
  const sDry = run(STRUCT_SCRIPT, ['business', '--dry-run']);
  ok(sDry.code === 0 && /DRY RUN/.test(sDry.out), '--dry-run runs and announces itself');
  ok(/MOVED/.test(sDry.out), '--dry-run still REPORTS the move it would make');
  ok(fingerprint(tmpRoot) === beforeSDry, '--dry-run wrote, moved and deleted nothing (recursive checksum unchanged)');

  const sOne = run(STRUCT_SCRIPT, ['--domain=business']);
  ok(sOne.code === 0 && /Domain: business/.test(sOne.out),
    '--domain=business names the domain the user asked for (was: silent no-op)');
  ok(!existsSync(peopleDir('business')), '--domain=business really migrated business');
  ok(existsSync(path.join(peopleDir('articles'), 'someone.md')),
    'THE BUG: articles was NOT touched by --domain=business');

  const sAll = run(STRUCT_SCRIPT, ['--all']);
  ok(sAll.code === 0 && /Migrating ALL/.test(sAll.out), '--all announces its scope before acting');
  ok(!existsSync(peopleDir('articles')),
    'CAPABILITY PRESERVED: --all still migrates every domain');
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
console.log('All fix-wiki-duplicates + fix-wiki-structure argument assertions green.');
