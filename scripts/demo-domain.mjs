#!/usr/bin/env node
/**
 * A SYNTHETIC demo knowledge base, for screenshots and demos.
 *
 *   node scripts/demo-domain.mjs <empty-target-dir> [--now <ISO time>]
 *
 * Writes two small domains into <target-dir> — the same on-disk layout the app
 * reads (CLAUDE.md, wiki/{entities,concepts,summaries,index.md,log.md},
 * conversations/*.json) — so anyone can run the app against it and get the
 * same screens. `scripts/screenshots.mjs` uses it to regenerate the README's
 * Chat images.
 *
 *   early-computing  23 pages: 11 entities, 8 concepts, 4 summaries, wikilinked
 *                    both ways, plus 4 saved conversations. The newest one's
 *                    answer cites five pages with `[source: …]` markers, so
 *                    the Chat view renders its numbered Sources list.
 *   night-sky         6 pages and 1 conversation, so the all-domains chat list
 *                    shows two domain colours.
 *
 * DETERMINISTIC. No LLM call, no network, no randomness: every page is
 * hand-written below, every id is a fixed UUID. The only input that moves is
 * `--now` (default: the current time), because the Chat list groups rows by
 * age (Today / Yesterday / Previous 7 days / Earlier) and a fixed calendar date
 * would drift into "Earlier" by next week. Pass `--now` to pin it.
 *
 * NOTHING PERSONAL. The topic is the public history of early computing; the
 * prose is original and short. No machine name, user name or path is written
 * into any file.
 *
 * REFUSES a non-empty target, so it can never be pointed at a real
 * domains folder by accident.
 */

import { mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── helpers ────────────────────────────────────────────────────────────────

const day = (d) => d.toISOString().slice(0, 10);

function entity(title, tags, summary, facts, related) {
  return { kind: 'entity', title, tags, body:
`# ${title}

## Summary
${summary}

## Key Facts
${facts.map(f => `- ${f}`).join('\n')}

## Related
${related.map(r => `- ${r}`).join('\n')}
` };
}

function concept(title, tags, definition, overview, related) {
  return { kind: 'concept', title, tags, body:
`# ${title}

## Definition
${definition}

## Overview
${overview}

## Related
${related.map(r => `- ${r}`).join('\n')}
` };
}

function summary(title, tags, source, date, text, points, entities, concepts) {
  return { kind: 'summary', title, tags, source, date, body:
`# ${title}

## Summary
${text}

## Key Points
${points.map(p => `- ${p}`).join('\n')}

## Entities Mentioned
${entities.map(e => `- [[${e}]]`).join('\n')}

## Concepts Covered
${concepts.map(c => `- [[${c}]]`).join('\n')}
` };
}

// ── domain 1: early computing ──────────────────────────────────────────────

const EARLY = {
  slug: 'early-computing',
  name: 'Early Computing',
  scope: 'The history of computing machines and ideas, from mechanical calculators to the first stored-program computers.',
  entities: {
    'charles-babbage': entity('Charles Babbage', ['mathematician', 'inventor'],
      'English mathematician (1791–1871) who designed the Difference Engine and the Analytical Engine, the first design for a general-purpose programmable computer.',
      ['Designed the Difference Engine in the 1820s to tabulate polynomial functions.',
       'Described the Analytical Engine from 1837; it was never completed in his lifetime.',
       'Separated the "store" (memory) from the "mill" (processor) — a split every later computer kept.'],
      ['[[analytical-engine]] — his general-purpose design', '[[difference-engine]] — his first machine',
       '[[ada-lovelace]] — collaborator and first published programmer', '[[punched-card]] — the Engine\'s input medium']),
    'ada-lovelace': entity('Ada Lovelace', ['mathematician', 'writer'],
      'English mathematician (1815–1852) whose 1843 notes on the Analytical Engine contain the first published algorithm intended for a machine.',
      ['Translated Menabrea\'s paper on the Analytical Engine and added notes three times its length.',
       'Note G sets out a method for computing Bernoulli numbers on the Engine.',
       'Argued the Engine could act on symbols other than numbers, such as musical notes.'],
      ['[[charles-babbage]] — whose machine she described', '[[analytical-engine]] — the subject of her notes',
       '[[algorithm]] — Note G is an early example', '[[summaries/notes-on-the-analytical-engine]] — her notes']),
    'alan-turing': entity('Alan Turing', ['mathematician', 'logician'],
      'English mathematician (1912–1954) who defined the Turing machine in 1936 and gave a precise meaning to "computable".',
      ['Published "On Computable Numbers" in 1936.',
       'Showed a single universal machine can imitate any other Turing machine.',
       'Wrote the design for the Automatic Computing Engine (ACE) in 1945.'],
      ['[[turing-machine]] — his model of computation', '[[computability]] — what his paper settled',
       '[[stored-program-computer]] — the universal machine anticipates it', '[[summaries/on-computable-numbers]] — the 1936 paper']),
    'john-von-neumann': entity('John von Neumann', ['mathematician', 'physicist'],
      'Hungarian-American mathematician (1903–1957) whose 1945 draft report on the EDVAC described the stored-program architecture.',
      ['Consulted on the ENIAC project at the Moore School.',
       'The "First Draft of a Report on the EDVAC" circulated in June 1945.',
       'The design he described holds program and data in one memory.'],
      ['[[stored-program-computer]] — the architecture he described', '[[eniac]] — the machine that prompted it',
       '[[summaries/first-draft-report-on-the-edvac]] — the report']),
    'grace-hopper': entity('Grace Hopper', ['computer-scientist', 'naval-officer'],
      'American computer scientist (1906–1992) who programmed the Harvard Mark I and built one of the first compilers.',
      ['Joined the Harvard Mark I team in 1944.',
       'Her A-0 system (1952) translated symbolic code into machine code.',
       'Argued that programs should be written in words closer to English.'],
      ['[[harvard-mark-i]] — the machine she first programmed', '[[compiler]] — the idea she pioneered']),
    'konrad-zuse': entity('Konrad Zuse', ['engineer', 'inventor'],
      'German engineer (1910–1995) who built the Z3 in 1941, a programmable machine using binary floating-point arithmetic.',
      ['The Z3 read its program from punched film.',
       'It used about 2,600 relays.',
       'Designed Plankalkül, an early high-level programming language.'],
      ['[[binary-arithmetic]] — the Z3 computed in binary', '[[general-purpose-computer]] — the Z3 is often counted among the first']),
    'analytical-engine': entity('Analytical Engine', ['machine', 'mechanical'],
      'Babbage\'s design for a mechanical general-purpose computer, programmed with punched cards and never completed.',
      ['A "store" held 1,000 numbers of 40 decimal digits.',
       'The "mill" performed the four arithmetic operations.',
       'Supported conditional branching and loops.'],
      ['[[charles-babbage]] — its designer', '[[ada-lovelace]] — its first programmer',
       '[[punched-card]] — its program medium', '[[general-purpose-computer]] — what it was designed to be']),
    'difference-engine': entity('Difference Engine', ['machine', 'mechanical'],
      'Babbage\'s mechanical calculator for tabulating polynomial functions by the method of finite differences.',
      ['A working Difference Engine No. 2 was built from his plans in 1991.',
       'It could only evaluate polynomials — it was not programmable.'],
      ['[[charles-babbage]] — its designer', '[[analytical-engine]] — its general-purpose successor']),
    'eniac': entity('ENIAC', ['machine', 'electronic'],
      'The Electronic Numerical Integrator and Computer (1945), an early electronic general-purpose computer built at the University of Pennsylvania.',
      ['Contained about 17,000 vacuum tubes.',
       'Was programmed by setting switches and plugging cables, which took days.',
       'The effort of reprogramming it motivated the stored-program design.'],
      ['[[john-von-neumann]] — consulted on its successor', '[[stored-program-computer]] — the fix for its rewiring',
       '[[general-purpose-computer]] — what it was']),
    'colossus': entity('Colossus', ['machine', 'electronic'],
      'A series of electronic machines built at Bletchley Park from 1943 to help break German teleprinter ciphers.',
      ['Used around 1,600 vacuum tubes in the first version.',
       'Was configured with switches and plugs, not a stored program.'],
      ['[[binary-arithmetic]] — it operated on binary teleprinter code', '[[eniac]] — its American contemporary']),
    'harvard-mark-i': entity('Harvard Mark I', ['machine', 'electromechanical'],
      'An electromechanical computer completed in 1944, which read its instructions from punched paper tape.',
      ['About 15 metres long.',
       'Grace Hopper was one of its first programmers.'],
      ['[[grace-hopper]] — one of its programmers', '[[punched-card]] — a close cousin of its paper tape']),
  },
  concepts: {
    'stored-program-computer': concept('Stored-Program Computer', ['architecture'],
      'A computer that keeps its program in the same memory as its data, so a new program is loaded rather than wired.',
      'The idea is usually traced to the 1945 EDVAC report. It turned reprogramming from days of cabling into reading new instructions into memory, and it lets a program treat another program as data.',
      ['[[john-von-neumann]] — described it', '[[turing-machine]] — its theoretical ancestor',
       '[[eniac]] — the machine whose rewiring it replaced', '[[analytical-engine]] — an earlier separation of store and mill']),
    'turing-machine': concept('Turing Machine', ['theory', 'model-of-computation'],
      'An abstract machine that reads and writes symbols on an unbounded tape according to a finite table of rules.',
      'Turing used it to define what a mechanical procedure can compute. A universal Turing machine reads another machine\'s rule table from its tape — a program stored as data.',
      ['[[alan-turing]] — defined it', '[[computability]] — what it defines', '[[stored-program-computer]] — its practical counterpart']),
    'computability': concept('Computability', ['theory'],
      'Whether a function can be calculated by a mechanical procedure at all, regardless of time or memory.',
      'Turing and Church showed in 1936 that some well-defined problems, such as deciding whether any given program halts, cannot be computed.',
      ['[[turing-machine]] — the model it is defined against', '[[alan-turing]] — who settled the question']),
    'punched-card': concept('Punched Card', ['input', 'storage'],
      'A stiff card whose pattern of holes encodes instructions or data for a machine to read.',
      'Borrowed from the Jacquard loom, which wove patterns from chains of cards. Babbage adopted them for the Analytical Engine, and cards remained a main input medium well into the 1970s.',
      ['[[analytical-engine]] — programmed with them', '[[charles-babbage]] — adopted them', '[[harvard-mark-i]] — used paper tape, a close cousin']),
    'algorithm': concept('Algorithm', ['method'],
      'A finite, precise sequence of steps that solves a problem or computes a result.',
      'Lovelace\'s Note G is often cited as the first algorithm written for a machine; Turing later gave the idea a formal definition.',
      ['[[ada-lovelace]] — Note G', '[[turing-machine]] — its formal model']),
    'compiler': concept('Compiler', ['software'],
      'A program that translates code written in a human-readable language into a machine\'s own instructions.',
      'Early compilers such as Hopper\'s A-0 made programming faster and less error-prone, and they only work because a program can be handled as data.',
      ['[[grace-hopper]] — built A-0', '[[stored-program-computer]] — what makes compilation possible']),
    'binary-arithmetic': concept('Binary Arithmetic', ['number-system'],
      'Arithmetic in base two, using only the digits 0 and 1.',
      'Two-state switches — relays, then vacuum tubes — map naturally onto binary, which is why Zuse\'s Z3 and most later machines used it instead of decimal.',
      ['[[konrad-zuse]] — the Z3 used it', '[[colossus]] — worked on binary code']),
    'general-purpose-computer': concept('General-Purpose Computer', ['architecture'],
      'A machine that can carry out any computation given the right program, rather than one fixed task.',
      'The Analytical Engine was designed as one a century before one was built; the Z3 and ENIAC are among the first that worked.',
      ['[[analytical-engine]] — the first design', '[[eniac]] — an early working one', '[[konrad-zuse]] — built the Z3']),
  },
  summaries: {
    'notes-on-the-analytical-engine': summary('Notes on the Analytical Engine', ['primary-source', '1843'],
      'Sketch of the Analytical Engine, with translator\'s notes (1843)', '2026-01-12',
      'Lovelace\'s translation of Menabrea\'s description of the Analytical Engine, with her own notes. The notes explain how the Engine would be programmed with cards and include Note G, a method for computing Bernoulli numbers.',
      ['The Engine separates the store from the mill.', 'Cards supply both operations and variables.',
       'The Engine "weaves algebraical patterns" the way the Jacquard loom weaves flowers.'],
      ['ada-lovelace', 'charles-babbage', 'analytical-engine'], ['algorithm', 'punched-card', 'general-purpose-computer']),
    'on-computable-numbers': summary('On Computable Numbers', ['primary-source', '1936'],
      'On Computable Numbers, with an Application to the Entscheidungsproblem (1936)', '2026-01-14',
      'Turing\'s paper defining the machines now named after him, proving that a universal machine exists and that some problems cannot be decided by any machine.',
      ['A computable number is one whose digits a finite machine can write out.',
       'A universal machine can simulate any other given its description.',
       'The decision problem for first-order logic has no general solution.'],
      ['alan-turing'], ['turing-machine', 'computability', 'algorithm']),
    'first-draft-report-on-the-edvac': summary('First Draft of a Report on the EDVAC', ['primary-source', '1945'],
      'First Draft of a Report on the EDVAC (1945)', '2026-01-19',
      'The report that described a computer holding its program in the same memory as its data, written while ENIAC was being completed.',
      ['Proposes one memory for instructions and numbers.', 'Uses binary rather than decimal.',
       'Describes the machine as organs: arithmetic, control, memory, input and output.'],
      ['john-von-neumann', 'eniac'], ['stored-program-computer', 'binary-arithmetic']),
    'from-looms-to-memory': summary('From Looms to Memory — reading notes', ['overview'],
      'Demo reading notes (synthetic, written for this demo domain)', '2026-01-22',
      'Reading notes tracing one idea from the Jacquard loom to the stored-program computer: that a machine\'s instructions can be written down, stored and swapped.',
      ['Cards made the loom\'s pattern replaceable without rebuilding the loom.',
       'Babbage applied the same idea to calculation.',
       'Electronic machines of the 1940s were fast but slow to reprogram.',
       'Storing the program in memory closed that gap.'],
      ['charles-babbage', 'eniac', 'colossus', 'harvard-mark-i', 'grace-hopper', 'konrad-zuse'],
      ['punched-card', 'stored-program-computer', 'general-purpose-computer', 'compiler']),
  },
};

// ── domain 2: night sky (small, second colour in the chat list) ───────────

const NIGHT = {
  slug: 'night-sky',
  name: 'Night Sky',
  scope: 'Naked-eye astronomy: constellations, bright stars and the instruments used to find them.',
  entities: {
    'polaris': entity('Polaris', ['star'],
      'The North Star, a bright star within a degree of the north celestial pole.',
      ['Found by extending the line of the two pointer stars of the Big Dipper.', 'Its altitude above the horizon roughly equals the observer\'s latitude.'],
      ['[[ursa-major]] — its pointer stars', '[[celestial-navigation]] — why it matters']),
    'ursa-major': entity('Ursa Major', ['constellation'],
      'A large northern constellation whose seven brightest stars form the Big Dipper, or Plough.',
      ['Circumpolar from most of the northern hemisphere.'],
      ['[[polaris]] — found from it', '[[asterism]] — the Dipper is one']),
    'astrolabe': entity('Astrolabe', ['instrument'],
      'A hand-held model of the sky used to measure the altitude of stars and tell the time.',
      ['In wide use in the medieval Islamic world and Europe.'],
      ['[[celestial-navigation]] — an early tool for it']),
  },
  concepts: {
    'asterism': concept('Asterism', ['observing'],
      'A recognisable pattern of stars that is not one of the 88 official constellations.',
      'The Big Dipper and the Summer Triangle are asterisms.',
      ['[[ursa-major]] — contains the Big Dipper']),
    'celestial-navigation': concept('Celestial Navigation', ['navigation'],
      'Finding a position on Earth by measuring the angles of stars, the Sun or the Moon above the horizon.',
      'Polaris gives latitude directly in the northern hemisphere.',
      ['[[polaris]] — the simplest reference', '[[astrolabe]] — an instrument for it']),
  },
  summaries: {
    'finding-the-north-star': summary('Finding the North Star', ['guide'],
      'Demo observing notes (synthetic, written for this demo domain)', '2026-01-10',
      'Short observing notes on finding Polaris from the Big Dipper and using it to estimate latitude.',
      ['Follow the two pointer stars about five times their separation.', 'Polaris is not the brightest star in the sky.'],
      ['polaris', 'ursa-major'], ['asterism', 'celestial-navigation']),
  },
};

// ── conversations ──────────────────────────────────────────────────────────

const HERO_ANSWER =
`**The same idea, a century apart:** instructions written down and swapped, not built into the machine.

### Babbage's half
The Analytical Engine split the machine into a *store* for numbers and a *mill* that worked on them [source: entities/analytical-engine.md], and took its program on punched cards borrowed from the Jacquard loom [source: concepts/punched-card.md].

> The Analytical Engine weaves algebraical patterns just as the Jacquard loom weaves flowers and leaves.
> — Ada Lovelace, Note A (1843)

### The step that closed the gap
The cards still lived *outside* the store, and ENIAC was still rewired by hand [source: entities/eniac.md].

1. Turing's universal machine (1936) read another machine's rules from its own tape [source: concepts/turing-machine.md].
2. The 1945 EDVAC report put instructions and numbers in **one memory** [source: summaries/first-draft-report-on-the-edvac.md].`;

const HERO_TITLES = {
  'entities/analytical-engine.md': 'Analytical Engine',
  'concepts/punched-card.md': 'Punched Card',
  'entities/eniac.md': 'ENIAC',
  'concepts/turing-machine.md': 'Turing Machine',
  'summaries/first-draft-report-on-the-edvac.md': 'First Draft of a Report on the EDVAC',
};

// Token counts and price are illustrative, priced at the default build
// model's published rate ($0.10 in / $0.40 out per 1M) — consistent with
// each other, never presented as a measurement.
function assistant(content, titles, at, inputTokens, outputTokens) {
  const citations = [...new Set([...content.matchAll(/\[source:\s*([^\]]+)\]/g)].map(m => m[1].trim()))];
  const costUsd = Math.round(((inputTokens * 0.10 + outputTokens * 0.40) / 1e6) * 1e6) / 1e6;
  const msg = {
    role: 'assistant', content, citations,
    provider: 'gemini', model: 'gemini-2.5-flash-lite',
    usage: { inputTokens, outputTokens, cachedReadTokens: 0, cacheWriteTokens: 0 },
  };
  if (titles) msg.citationTitles = titles;
  msg.project = null;
  msg.priced = { free: false, inPerM: 0.10, outPerM: 0.40, costUsd, at };
  return msg;
}

function conversations(now) {
  const ago = (min) => new Date(now.getTime() - min * 60_000).toISOString();
  return [
    { domain: 'early-computing', id: '6f1d2c3a-1b2c-4d5e-8f90-a1b2c3d4e5f1',
      title: 'What linked the Analytical Engine to the stored-program computer?',
      createdAt: ago(6), updatedAt: ago(4), messages: [
        { role: 'user', content: 'What linked the Analytical Engine to the stored-program computer?' },
        assistant(HERO_ANSWER, HERO_TITLES, ago(4), 18_420, 412),
      ] },
    { domain: 'early-computing', id: '6f1d2c3a-1b2c-4d5e-8f90-a1b2c3d4e5f2',
      title: 'Who wrote the first compiler?',
      createdAt: ago(190), updatedAt: ago(185), messages: [
        { role: 'user', content: 'Who wrote the first compiler?' },
        assistant('Grace Hopper\'s A-0 system (1952) is usually named as one of the first; it translated symbolic code into machine code [source: entities/grace-hopper.md].',
          { 'entities/grace-hopper.md': 'Grace Hopper' }, ago(185), 12_050, 64),
      ] },
    { domain: 'night-sky', id: '6f1d2c3a-1b2c-4d5e-8f90-a1b2c3d4e5f3',
      title: 'How do I find Polaris?',
      createdAt: ago(60 * 26), updatedAt: ago(60 * 26 - 3), messages: [
        { role: 'user', content: 'How do I find Polaris?' },
        assistant('Follow the two pointer stars at the end of the Big Dipper\'s bowl about five times their separation [source: entities/polaris.md].',
          { 'entities/polaris.md': 'Polaris' }, ago(60 * 26 - 3), 3_900, 48),
      ] },
    { domain: 'early-computing', id: '6f1d2c3a-1b2c-4d5e-8f90-a1b2c3d4e5f4',
      title: 'Compare Colossus and ENIAC',
      createdAt: ago(60 * 24 * 4), updatedAt: ago(60 * 24 * 4 - 5), messages: [
        { role: 'user', content: 'Compare Colossus and ENIAC' },
        assistant('Both were electronic and configured by hand rather than by a stored program; Colossus was built for code-breaking [source: entities/colossus.md], ENIAC as a general-purpose calculator [source: entities/eniac.md].',
          { 'entities/colossus.md': 'Colossus', 'entities/eniac.md': 'ENIAC' }, ago(60 * 24 * 4 - 5), 14_300, 71),
      ] },
    { domain: 'early-computing', id: '6f1d2c3a-1b2c-4d5e-8f90-a1b2c3d4e5f5',
      title: 'Why did early machines use binary?',
      createdAt: ago(60 * 24 * 12), updatedAt: ago(60 * 24 * 12 - 2), messages: [
        { role: 'user', content: 'Why did early machines use binary?' },
        assistant('Two-state switches — relays, then vacuum tubes — map directly onto the digits 0 and 1 [source: concepts/binary-arithmetic.md].',
          { 'concepts/binary-arithmetic.md': 'Binary Arithmetic' }, ago(60 * 24 * 12 - 2), 11_800, 39),
      ] },
  ];
}

// ── writer ─────────────────────────────────────────────────────────────────

function pageText(p, created) {
  const type = p.kind;
  const fm = ['---', `type: ${type}`];
  if (type === 'summary') { fm.push(`source: ${p.source}`, `date: ${p.date}`); }
  fm.push(`tags: [${[...p.tags, `type/${type}`].join(', ')}]`, `created: ${created}`, '---', '');
  return fm.join('\n') + p.body;
}

function writeDomain(root, d, created) {
  const base = path.join(root, d.slug);
  const wiki = path.join(base, 'wiki');
  for (const sub of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, sub), { recursive: true });
  mkdirSync(path.join(base, 'raw'), { recursive: true });
  mkdirSync(path.join(base, 'conversations'), { recursive: true });

  writeFileSync(path.join(base, 'CLAUDE.md'),
    `# Domain: ${d.name}\n\nThis is a dedicated knowledge curator for ${d.name.toLowerCase()} topics.\n\n` +
    `## Scope\n${d.scope}\n\n(Synthetic demo domain, generated by scripts/demo-domain.mjs.)\n`);

  const rows = [];
  for (const [folder, set] of [['entities', d.entities], ['concepts', d.concepts], ['summaries', d.summaries]]) {
    for (const [slug, p] of Object.entries(set)) {
      writeFileSync(path.join(wiki, folder, `${slug}.md`), pageText(p, created));
      const link = folder === 'summaries' ? `summaries/${slug}` : slug;
      const oneLine = p.body.split('\n## ')[1].split('\n').slice(1).join(' ').trim().split('. ')[0].replace(/\.$/, '');
      rows.push(`| [[${link}]] | ${p.kind} | ${oneLine}. |`);
    }
  }
  writeFileSync(path.join(wiki, 'index.md'),
    `# ${d.name} — Index\n\n| Page | Type | Summary |\n|---|---|---|\n${rows.join('\n')}\n`);
  writeFileSync(path.join(wiki, 'log.md'),
    `# Log\n\n## [${created}] ingest | demo domain generated\n\n- ${rows.length} pages written by scripts/demo-domain.mjs.\n`);
  return rows.length;
}

/**
 * Write the demo domains into `root` (which must be empty or absent).
 * @returns {{domains: {slug, pages}[], conversations: number}}
 */
export function writeDemoDomains(root, { now = new Date() } = {}) {
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error(`refusing to write into a non-empty directory: ${root}`);
  }
  mkdirSync(root, { recursive: true });
  const created = day(new Date(now.getTime() - 14 * 86_400_000));
  const out = [];
  for (const d of [EARLY, NIGHT]) out.push({ slug: d.slug, pages: writeDomain(root, d, created) });
  const convs = conversations(now);
  for (const c of convs) {
    const { domain, ...rest } = c;
    const conv = { id: rest.id, title: rest.title, createdAt: rest.createdAt, domain, messages: rest.messages, updatedAt: rest.updatedAt };
    writeFileSync(path.join(root, domain, 'conversations', `${c.id}.json`), JSON.stringify(conv, null, 2));
  }
  return { domains: out, conversations: convs.length };
}

export const HERO_CONVERSATION_ID = '6f1d2c3a-1b2c-4d5e-8f90-a1b2c3d4e5f1';

// ── the workspace: projects, handoffs, journal, usage log, trash, sync ─────
//
// Everything below writes through The Curator's OWN store functions
// (working-state.js, files.js), so the on-disk format is exactly what the app
// writes — never a hand-copied imitation of it. It therefore runs only in a
// CHILD process whose environment already points both test seams
// (CURATOR_TEST_DOMAINS_DIR, CURATOR_TEST_USER_DATA_DIR) at throwaway
// directories: `node scripts/demo-domain.mjs <domains> --workspace <userdata>`.
//
// A FAKE CLOCK makes the ages on screen read like a real week of work
// ("8 min ago", "yesterday") while the file contents stay deterministic for a
// given --now: `Date` is replaced for this process only, and every store call
// reads its timestamp from it.
//
// Nothing here is personal: the machine is `demo-mac-4d3e2f`, the tools are
// named by their public product names, and the sync remote is a LOCAL bare
// repository labelled `github.com/example/my-brain` — no network is touched.

export const DEMO_MACHINE = 'demo-mac-4d3e2f';
export const DEMO_REPO_URL = 'https://github.com/example/my-brain.git';
export const DEMO_PROJECT = 'exhibit-site';

function installFakeClock(start) {
  const RealDate = Date;
  let now = start.getTime();
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(now); else super(...a); }
    static now() { return now; }
  }
  globalThis.Date = FakeDate;
  return { set: (ms) => { now = ms; }, real: RealDate };
}

async function writeDemoWorkspace(domainsDir, userDataDir, now) {
  const { execFileSync } = await import('child_process');
  const T = now.getTime();
  const MIN = 60_000, HR = 60 * MIN, DAY = 24 * HR;

  // ── 1. Personal Sync, as it was THREE HOURS AGO: the wiki committed and
  //       pushed to a local bare repo. Everything written after this point
  //       is a real "local change not pushed" in the Sync view.
  const remote = path.join(userDataDir, '.demo-sync-remote.git');   // a LOCAL stand-in for GitHub
  const gitDir = path.join(userDataDir, '.knowledge-git');
  const at = new Date(T - 3 * HR).toISOString();
  const genv = { ...process.env, GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com',
    GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  const g = (...a) => execFileSync('git', a, { env: genv, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  g('init', '-q', '--bare', '-b', 'main', remote);
  writeFileSync(path.join(domainsDir, '.gitignore'), '*/raw/\n*/.mcp-write-log.jsonl\n*/.write-lock\n.DS_Store\n');
  g('--git-dir', gitDir, '--work-tree', domainsDir, 'init', '-q', '-b', 'main');
  g('--git-dir', gitDir, '--work-tree', domainsDir, 'add', '-A');
  g('--git-dir', gitDir, '--work-tree', domainsDir, 'commit', '-q', '-m', 'Sync: demo wiki');
  g('--git-dir', gitDir, 'remote', 'add', 'origin', remote);
  g('--git-dir', gitDir, 'push', '-q', 'origin', 'main');
  g('--git-dir', gitDir, 'fetch', '-q', 'origin', 'main');
  g('--git-dir', gitDir, 'config', 'curator.lastSyncAt', at);
  writeFileSync(path.join(userDataDir, '.sync-config.json'),
    JSON.stringify({ repoUrl: DEMO_REPO_URL, token: 'demo-token-not-a-credential' }, null, 2), { mode: 0o600 });

  // ── 2. Machine identity, pinned before any save mints a real one.
  writeFileSync(path.join(userDataDir, '.curator-install-id'), '4d3e2f\n', { mode: 0o600 });
  writeFileSync(path.join(userDataDir, '.curator-machine-id'), DEMO_MACHINE + '\n', { mode: 0o600 });

  const clock = installFakeClock(new Date(T - 6 * DAY));
  const ws = await import('../src/brain/working-state.js');
  const files = await import('../src/brain/files.js');
  const must = (r, what) => { if (!r || r.ok === false) throw new Error(`${what}: ${r && (r.message || r.reason)}`); return r; };
  const D = 'early-computing', P = DEMO_PROJECT;

  // ── 3. Projects and briefs.
  clock.set(T - 6 * DAY);
  must(await ws.createProject(D, P, { brief:
`# ${P} — standing brief

## Goal
A small static website for a museum exhibit on early computing: one page per machine, a
timeline, and an interactive Difference Engine you can crank in the browser.

## Constraints
- Plain HTML, CSS and JavaScript. No framework, no build step.
- Every fact on the site links to a page in the Early Computing wiki.
- Must work offline on the kiosk in the gallery.

## How we work
- Save a handoff at the end of every session; read the latest one first.
- Architecture decisions go in the architecture document, not in a handoff.
` }), 'createProject');
  must(await ws.createProject(D, 'lecture-series', { brief:
`# lecture-series — standing brief

## Goal
Six evening lectures to accompany the exhibit, one per machine.
` }), 'createProject lecture-series');
  must(await ws.setKnowledgeDomains(D, P, ['early-computing', 'night-sky']), 'setKnowledgeDomains');

  // ── 4. Canonical documents (tier 0).
  must(await ws.saveFoundation(D, P, { slug: 'architecture.md', role: 'architecture', title: 'Architecture', text:
`# Architecture

- One HTML page per machine under \`/machines/\`, generated from the wiki's entity pages.
- The timeline is a single SVG, drawn at load from \`timeline.json\`.
- The Difference Engine simulator is one ES module, \`engine.js\`, with no dependencies.
- A service worker caches everything for the offline kiosk.
` }), 'saveFoundation architecture');
  must(await ws.saveFoundation(D, P, { slug: 'style-guide.md', role: 'conventions', title: 'Style guide', text:
`# Style guide

- Dates as years only ("1843"), never full dates.
- Machine names in their period spelling: "Analytical Engine", "ENIAC", "Colossus".
- Captions under 25 words.
` }), 'saveFoundation style-guide');
  await ws.setFoundationReadFirst(D, P, 'architecture.md', true);

  // ── 5. Handoffs. Two tools, each in its own scope, plus one SHARED scope
  //       where Antigravity's save replaced Claude Code's (so a previous.md
  //       is kept, exactly as v3.74.0 keeps it).
  const save = async (atMs, input) => { clock.set(atMs); return must(await ws.saveWorkingState(D, { project: P, replace: true, ...input }), 'save ' + input.scope); };
  const CC = { harness: 'Claude Code', model: 'claude-opus-5-5' };
  const AG = { harness: 'Antigravity', model: 'gemini-3-pro' };

  await save(T - 5 * DAY, { ...CC, scope: 'claude-code', headline: 'Machine pages scaffolded from the wiki; timeline next',
    nowState: 'Eleven machine pages are generated from the entity pages. The timeline has not been started.',
    decisions: ['Pages are generated at build time from the wiki, never hand-written.'],
    nextSteps: ['Draw the timeline from timeline.json.'] });
  await save(T - 2 * DAY, { ...CC, scope: 'claude-code', headline: 'Timeline drawn; Difference Engine crank works for the first column',
    nowState: 'The timeline renders all eleven machines from 1822 to 1949. The engine simulator adds the first difference column correctly; the carry between columns is still wrong.',
    decisions: ['Pages are generated at build time from the wiki, never hand-written.', 'The timeline is one SVG drawn at load — no charting library.'],
    traps: ['Do not animate the carry with CSS transitions — the kiosk browser drops frames. Step it in JS.'],
    nextSteps: ['Fix the carry between difference columns.', 'Add the service worker for offline use.'] });
  await save(T - 8 * MIN, { ...CC, scope: 'claude-code', headline: 'Carry fixed; engine tabulates x² + x + 41 to 40 terms',
    nowState: 'The Difference Engine simulator now carries correctly across all seven columns and tabulates x² + x + 41 for forty terms, matching the printed table. The offline service worker is written but untested on the kiosk.',
    decisions: ['Pages are generated at build time from the wiki, never hand-written.', 'The timeline is one SVG drawn at load — no charting library.', 'The engine steps one column per animation frame.'],
    traps: ['Do not animate the carry with CSS transitions — the kiosk browser drops frames. Step it in JS.'],
    nextSteps: ['Test the service worker on the kiosk with the network cable out.', 'Write captions for the Colossus and Harvard Mark I pages.'],
    openQuestions: ['Should the timeline include the Z3, which was destroyed in 1943?'] });

  await save(T - 3 * DAY, { ...AG, scope: 'antigravity', headline: 'Caption pass on six machine pages; style guide applied',
    nowState: 'Captions written for six of the eleven machine pages, each under 25 words and linked to its wiki page.',
    decisions: ['Captions cite the wiki page, not the original source.'],
    nextSteps: ['Caption the remaining five machine pages.'] });
  await save(T - 26 * HR, { ...AG, scope: 'antigravity', headline: 'All eleven captions done; two facts queried against the wiki',
    nowState: 'Every machine page has a caption. Two dates disagreed with the wiki and were corrected to match it.',
    decisions: ['Captions cite the wiki page, not the original source.', 'Where a caption and the wiki disagree, the wiki wins and the caption is fixed.'],
    nextSteps: ['Proof-read the timeline labels.'] });

  await save(T - 4 * HR, { ...CC, scope: 'main', headline: 'Release checklist drafted for the gallery opening',
    nowState: 'A release checklist exists: build, copy to the kiosk, test offline, sign-off.',
    nextSteps: ['Run the checklist on the kiosk.'] });
  await save(T - 40 * MIN, { ...AG, scope: 'main', headline: 'Checklist run once on a spare kiosk — offline mode fails on first load',
    nowState: 'The checklist was run on the spare kiosk. The site works online; with the cable out, the first load fails because the service worker has not installed yet.',
    traps: ['The first visit must happen ONLINE so the service worker can install — say so in the checklist.'],
    nextSteps: ['Add a "first load online" step to the checklist.'] });

  // A throwaway scope, deleted to the trash below.
  await save(T - 5 * DAY + 2 * HR, { ...CC, scope: 'test-run', headline: 'Scratch save while testing the bridge', nowState: 'Nothing to keep.' });

  // ── 6. The trash (v3.73.0 / v3.75.0): one handoff, one project, one domain.
  clock.set(T - 20 * HR);
  must(await ws.deleteWorkStream(D, P, 'test-run', { confirm: 'test-run' }), 'deleteWorkStream');
  must(await ws.createProject(D, 'prototype-2025', { brief: '# prototype-2025 — standing brief\n\n## Goal\nAn early paper prototype of the exhibit.\n' }), 'createProject prototype');
  clock.set(T - 2 * DAY);
  must(await ws.deleteProject(D, 'prototype-2025', { confirm: 'prototype-2025' }), 'deleteProject');
  writeDomain(domainsDir, { slug: 'old-drafts', name: 'Old Drafts', scope: 'Drafts from an earlier version of the exhibit.',
    entities: {}, concepts: { 'draft-outline': concept('Draft Outline', ['draft'], 'An early outline of the exhibit.', 'Superseded by the Early Computing domain.', []) }, summaries: {} },
    day(new Date(T - 30 * DAY)));
  clock.set(T - 3 * DAY);
  await files.deleteDomain('old-drafts', { confirm: 'old-drafts' });

  // ── 7. The MCP usage log — content-free, one line per tool call — so
  //       Context's "Agent sessions" and "Saves by tool" have a week to show.
  const lines = [];
  let n = 0;
  const session = (ms, client, calls) => {
    const sid = (0x5e5510000000 + (++n)).toString(16).padStart(12, '0');
    lines.push({ ts: new clock.real(ms).toISOString(), ev: 'session', sid, client });
    calls.forEach(([tool, dt], k) => lines.push({ ts: new clock.real(ms + dt).toISOString(), tool, domain: D, ok: true, refused: false, ms: 9 + k, sid, project: P }));
  };
  const start = [['get_project_context', 1000]];
  const full = (end) => [...start, ['search_wiki', 60_000], ['save_working_state', end]];
  session(T - 5 * DAY - 40 * MIN, 'claude-code', full(40 * MIN));
  session(T - 3 * DAY - 30 * MIN, 'antigravity', full(30 * MIN));
  session(T - 2 * DAY - 50 * MIN, 'claude-code', full(50 * MIN));
  session(T - 26 * HR - 20 * MIN, 'antigravity', full(20 * MIN));
  session(T - 4 * HR - 25 * MIN, 'claude-code', full(25 * MIN));
  session(T - 40 * MIN - 15 * MIN, 'antigravity', full(15 * MIN));
  session(T - 8 * MIN - 30 * MIN, 'claude-code', full(30 * MIN));
  session(T - 6 * HR, 'claude-code', start);              // read the context, never saved
  lines.sort((a, b) => a.ts.localeCompare(b.ts));
  writeFileSync(path.join(userDataDir, '.mcp-usage.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  // ── 8. File times. The store stamps every document with the FAKE clock,
  //       but the file system stamped them with the real one, and a few
  //       readings fall back to a file's mtime ("file changed just now").
  //       Align each file's mtime with the time written inside it.
  const { utimesSync, readdirSync: ls, statSync } = await import('fs');
  const walk = (dir) => ls(dir).flatMap(n => { const f = path.join(dir, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
  for (const f of walk(path.join(domainsDir, D, 'state'))) {
    let when = T - 6 * DAY;                                  // briefs, documents, project.json
    const m = /Saved: ([0-9TZ:.-]+)/.exec(readFileSync(f, 'utf8'));
    if (m) when = Date.parse(m[1]);
    else if (f.endsWith('.jsonl')) {
      const last = readFileSync(f, 'utf8').trim().split('\n').pop();
      try { const j = JSON.parse(last); when = Date.parse(j.at || j.ts) || when; } catch { /* keep */ }
    }
    utimesSync(f, new clock.real(when), new clock.real(when));
  }

  clock.set(T);
  return { project: P };
}

// ── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (f) => { const k = args.indexOf(f); return k >= 0 ? args[k + 1] : null; };
  const now = val('--now') ? new Date(val('--now')) : new Date();
  const userData = val('--workspace');
  const target = args.find((a, k) => !a.startsWith('--') && !['--now', '--workspace'].includes(args[k - 1]));
  if (!target || Number.isNaN(now.getTime())) {
    console.error('usage: node scripts/demo-domain.mjs <empty-target-dir> [--now <ISO time>] [--workspace <empty user-data dir>]');
    process.exit(2);
  }
  try {
    const domainsDir = path.resolve(target);
    const r = writeDemoDomains(domainsDir, { now });
    for (const d of r.domains) console.log(`  ${d.slug}: ${d.pages} pages`);
    console.log(`  ${r.conversations} conversations`);
    if (userData) {
      const ud = path.resolve(userData);
      // The store functions must see ONLY these two directories.
      if (process.env.CURATOR_TEST_DOMAINS_DIR !== domainsDir || process.env.CURATOR_TEST_USER_DATA_DIR !== ud) {
        throw new Error('--workspace needs CURATOR_TEST_DOMAINS_DIR and CURATOR_TEST_USER_DATA_DIR set to the two target directories');
      }
      if (existsSync(ud) && readdirSync(ud).length > 0) throw new Error(`refusing to write into a non-empty directory: ${ud}`);
      mkdirSync(ud, { recursive: true });
      await writeDemoWorkspace(domainsDir, ud, now);
      console.log(`  workspace: project ${DEMO_PROJECT}, handoffs, journal, trash, sync, usage log`);
    }
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(1);
  }
}
