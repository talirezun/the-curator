/**
 * test-chat-compile-card.js — OFFLINE suite for the inline compile-result card.
 *
 * v3.0.14 moved the "Compile to Wiki" outcome from a fixed panel wedged between
 * the chat thread and the composer (`#compile-result.result-panel`, styled
 * `flex-shrink: 0; max-height: 38vh; overflow-y: auto`) into an inline card
 * appended to `#chat-thread`.
 *
 * The old panel permanently stole up to 38vh from the message area (measured
 * 429px → 127px of thread height on a 720px viewport), gave the chat a second
 * scrollbar, and was only cleared when the user switched conversations — so
 * every message after a compile stayed compressed. A community user reported it
 * as "compiling opens a second window that compresses the chat".
 *
 * These are source-level guards (the frontend has no DOM test harness), matching
 * the pattern used by the other chat suites. Deterministic, free, no network.
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

// ── 1. The fixed panel is gone ──────────────────────────────────────────────
section('1. The old fixed compile panel no longer exists');
ok(!/id="compile-result"/.test(html), 'index.html has no #compile-result element');
ok(!/compileResultEl/.test(app), 'app.js has no compileResultEl reference');
ok(!/\.result-panel\b/.test(css), 'styles.css has no .result-panel rule');
ok(!/result-panel/.test(html), 'index.html has no result-panel class');

// ── 2. The compile card is a thread item ────────────────────────────────────
section('2. Compile outcome is appended into the chat thread');
const cardFn = (app.match(/function appendCompileCard\(\) \{[\s\S]*?\n\}/) || [''])[0];
ok(cardFn.length > 0, 'appendCompileCard() helper exists');
ok(/chatThreadEl\.appendChild\(card\)/.test(cardFn),
  'appendCompileCard appends the card into #chat-thread (not a sibling panel)');
ok(/className = 'chat-compile-card'/.test(cardFn),
  'the card carries the .chat-compile-card class');
ok(!/chatEmptyEl|showEl\(chatThreadEl\)/.test(cardFn),
  'appendCompileCard does NOT un-hide the thread (would resurrect a headerless thread over the empty state)');

// The old panel had its own scroll box that always started at its TOP, so the
// title + counts were the first thing the user saw. Scrolling the THREAD to the
// bottom instead buries the headline of any card taller than the thread (a
// 25-page compile is ~750px against a ~480px thread).
const scrollFn = (app.match(/function scrollCardIntoView\(card\) \{[\s\S]*?\n\}/) || [''])[0];
ok(scrollFn.length > 0, 'scrollCardIntoView(card) helper exists');
ok(/getBoundingClientRect\(\)\.top/.test(scrollFn) && /chatThreadEl\.scrollTop \+=/.test(scrollFn),
  'it scrolls the card TOP to the top of the thread viewport (not the thread to its bottom)');
ok(!/scrollThreadToBottom/.test(app),
  'the old scroll-to-bottom helper is gone (it hid the card title on tall cards)');

// ── 3. Every compile outcome path uses the card ─────────────────────────────
section('3. Every compile outcome goes through the single guarded renderer');
// One renderer, three call sites (success — which also covers the zero-changes
// branch — refused, and error). Exactly one place appends a card, so the
// navigated-away guard cannot be bypassed by one path.
const renderCalls = (app.match(/renderCompileOutcome\(card =>/g) || []).length;
ok(renderCalls === 3, `renderCompileOutcome is the only card entry point (found ${renderCalls} call sites, expected 3)`);
const appendCalls = (app.match(/=\s*appendCompileCard\(\)/g) || []).length;
ok(appendCalls === 1, `appendCompileCard() is called exactly once, inside the renderer (found ${appendCalls})`);
ok(/if \(refused\) \{[\s\S]{0,200}renderCompileOutcome[\s\S]{0,200}compile-refused/.test(app),
  'refused path renders a card');
ok(/renderChangeRecords\(card, \{/.test(app), 'success path renders change records into the card');
ok(/card\.innerHTML[\s\S]{0,300}change-empty/.test(app),
  'zero-changes path renders an explicit empty state (renderChangeRecords would hide an empty container)');
ok(/catch \(err\) \{[\s\S]{0,200}renderCompileOutcome[\s\S]{0,200}compile-error/.test(app),
  'error path renders a card');
ok(/card\.prepend\(note\)/.test(app), 'degradation warnings still render above the change list');

// Escape-first invariant: the empty-state template is the only newly authored
// innerHTML string in this change, and it interpolates an LLM-supplied title.
ok(/change-title">\$\{escHtml\(`Compiled to wiki: \$\{final\.title\}`\)\}/.test(app),
  'the empty-state title is escHtml-escaped (LLM-supplied value)');

section('3b. A compile that finishes after the user navigated away is not misfiled');
ok(/const compileConvId = activeConvId;/.test(app), 'the handler captures the conversation it compiled');
ok(/const compileDomain = chatDomain;/.test(app), 'the handler captures the domain it compiled');
ok(/activeConvId !== compileConvId \|\| chatDomain !== compileDomain/.test(app),
  'the renderer refuses to append when the open conversation or domain changed mid-compile');

// ── 4. The card must not create a second scroll box ─────────────────────────
section('4. The card is a plain thread item — no nested scroll, no fixed height');
const cardRule = (css.match(/\.chat-compile-card \{[^}]*\}/) || [''])[0];
ok(cardRule.length > 0, '.chat-compile-card rule exists');
ok(!/max-height/.test(cardRule), '.chat-compile-card has NO max-height (would re-create the squeeze)');
ok(!/overflow/.test(cardRule),
  '.chat-compile-card has NO overflow of its own — an overflow would flip its flex min-height:auto to 0 and let the thread squeeze it back into a scroll box');
ok(!/flex-shrink/.test(cardRule), '.chat-compile-card does not pin its own flex size');
ok(/\.chat-compile-card \.change-summary/.test(css), '.change-summary card chrome applies inside the thread card');
// A long `+N bullets in Key Facts, Related, …` detail is nowrap + flex-shrink:0,
// so a row can exceed the thread width. The old panel's own overflow absorbed
// that; uncontained it would scroll every message bubble sideways.
ok(/\.chat-compile-card \.change-summary \{\s*overflow-x:\s*auto;\s*\}/.test(css),
  'horizontal overflow is contained on the inner .change-summary block');

// ── 5. The chat thread keeps its full height ────────────────────────────────
section('5. The thread itself is unchanged (still the flexible, scrolling area)');
const threadRule = (css.match(/\.chat-thread \{[^}]*\}/) || [''])[0];
ok(/flex:\s*1/.test(threadRule), '.chat-thread is still flex: 1');
ok(/overflow-y:\s*auto/.test(threadRule), '.chat-thread is still the scrolling container');
ok(/<div id="chat-thread" class="chat-thread hidden"><\/div>\s*(<!--[\s\S]*?-->\s*)?<div class="chat-composer">/.test(html),
  'the composer follows the thread directly — nothing sits between them any more');
// Cards are cleared by the normal thread lifecycle — the docs rely on this.
ok(/function showChatEmpty\(\)[\s\S]{0,300}chatThreadEl\.innerHTML = ''/.test(app),
  'showChatEmpty() still wipes the thread (clears any compile cards)');
ok(/function renderThread\(messages\)[\s\S]{0,300}chatThreadEl\.innerHTML = ''/.test(app),
  'renderThread() still wipes the thread (reopening a conversation shows no stale cards)');

// ── 6. Ingest is untouched ──────────────────────────────────────────────────
section('6. No regression on the ingest change-records panel');
ok(/renderChangeRecords\(ingestResult/.test(app), 'ingest still renders change records into #ingest-result');
ok(/\.result \.change-summary \{/.test(css), 'the ingest .result .change-summary override is preserved');
ok(/function renderChangeRecords\(container, \{ title, changes \}\)/.test(app),
  'renderChangeRecords keeps its shared (container, {title, changes}) contract');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All inline compile-card offline assertions green');
