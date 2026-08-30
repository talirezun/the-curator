/**
 * test-next-header-adoption.js — OFFLINE. THE HOLE THE LAST GUARD LEFT OPEN.
 *
 * v3.22.0 built renderViewHeader and adopted it in four views. Its suite,
 * scripts/test-next-view-header.js, guards that work in two layers: §8 names
 * each adopted call site, and §9b is a CLASS guard that walks every view file
 * on disk and forbids prose concatenated onto a header.
 *
 * §9b opens with this line:
 *
 *     if (!src.includes('renderViewHeader(')) continue;
 *
 * WHICH MEANS A VIEW THAT NEVER ADOPTS THE COMPONENT IS SILENTLY EXEMPT. The
 * class guard only governs files that already opted in; §8's list of who must
 * opt in is hardcoded to the four views that existed when it was written. So
 * the two layers together prove "every ADOPTER behaves" and "these four are
 * ADOPTERS" — and say nothing at all about a fifth view painting
 * `<h1 class="view-title">` plus a paragraph by hand. memory.js and sync.js
 * were exactly that, and both were invisible to a fully green run.
 *
 * This suite closes it from the other side: it enumerates every view FROM DISK
 * and asks whether each one renders a view header at all — and if it does,
 * whether it does so through the component. Adding a sixth view inherits the
 * guard without anyone remembering to extend a list, which is how the last one
 * went blind (and how v3.0.1-beta.24's FN_NAMES list, and v3.9.0's asset-path
 * grep, went blind before it).
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  · §1 No view file may paint a raw `class="view-title"` or
 *    `class="sidebar-title"` string literal. Those are the component's own
 *    output; a hand-rolled one is an unadopted header by definition.
 *  · §2 Every view that DOES render a header imports renderViewHeader from the
 *    one shared module and declares no local copy.
 *  · §3 The exemptions are three DIALOG/PANEL files, and each exemption must
 *    MATCH SOMETHING — the file must still be a dialog whose accessible name
 *    comes from an id on its own heading. A stale exemption is a silent hole
 *    (the discipline test-next-loading-gate.js's EXEMPT table established).
 *  · §4 The two newly adopted views, at named sites, in both densities.
 *  · §5 What was CUT has not returned, in either shape.
 *  · §6 NO HOVER-ONLY `title=` ON A NON-FOCUSABLE ELEMENT may be added to
 *    these files. Counted per file and ratcheted: the allow-list may shrink,
 *    never grow. v3.20.0 counted 11 such strings app-wide; this is the ratchet
 *    that stops a twelfth.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *  · This is a SOURCE scan. A view module reaches app.js, which touches
 *    `document` at module scope, so no view's real render executes in Node.
 *  · The focusability test in §6 reads the TAG NAME preceding a `title=`. An
 *    element made focusable by a `tabindex` attribute reads as non-focusable
 *    here, which fails in the SAFE direction (it would demand an exemption
 *    rather than grant one). A `title=` built by string concatenation far from
 *    its own tag walks past it entirely. It is a floor, not a proof.
 *  · NOTHING HERE MEASURES RENDERING. A green run does not mean no paragraph
 *    is on screen. The headers were screenshotted in both themes instead.
 */

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = join(HERE, '..', 'src', 'public', 'next', 'views');
const SHARED_DIR = join(HERE, '..', 'src', 'public', 'next', 'shared');

let passed = 0, failed = 0;
/** ok(label, cond, detail) — label FIRST. §7 proves that order is real. */
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 240)}` : ''}`); }
}
function section(t) { console.log(`\n${t}\n${'-'.repeat(62)}`); }

/**
 * Strip block and line comments before every scan.
 *
 * NOT HYGIENE — a correctness requirement with a precedent. A guard written
 * during this same design-system push went RED on the CODE COMMENT that
 * explained the rule it was checking: the comment quoted the very selector the
 * assertion asserted was absent. The inverse is worse and is the v3.18.0 shape:
 * a `//`-commented call site satisfies a positive scan, so a guard certifies
 * code that no longer runs. §0 proves this stripper actually strips, in both
 * directions, before anything relies on it.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const viewFiles = readdirSync(VIEWS_DIR).filter((f) => f.endsWith('.js')).sort();
const SRC = Object.fromEntries(
  viewFiles.map((f) => [f, stripComments(readFileSync(join(VIEWS_DIR, f), 'utf8'))])
);
const RAW = Object.fromEntries(
  viewFiles.map((f) => [f, readFileSync(join(VIEWS_DIR, f), 'utf8')])
);

// ═══════════════════════════════════════════════════════════════════════════
section('§0  THE STRIPPER WORKS — proven before anything trusts it');
// ═══════════════════════════════════════════════════════════════════════════
{
  const probe = [
    'const a = 1; // class="view-title" in a line comment',
    '/* class="sidebar-title" in a block comment */',
    'const real = \'<h1 class="view-title">Kept</h1>\';',
  ].join('\n');
  const out = stripComments(probe);
  ok('a line comment is removed', !out.includes('in a line comment'), out);
  ok('a block comment is removed', !out.includes('in a block comment'), out);
  ok('CONTROL: real code SURVIVES the stripper (it is not just deleting everything)',
    out.includes('class="view-title">Kept'), out);
  ok('CONTROL: the corpus can tell the two apart — the probe had 3 matches, the stripped text has 1',
    (probe.match(/class="(?:view|sidebar)-title"/g) || []).length === 3
    && (out.match(/class="(?:view|sidebar)-title"/g) || []).length === 1);
  ok('a `//` inside a URL is not treated as a comment',
    stripComments("const u = 'https://x.test/a';").includes('https://x.test/a'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1  THE CLASS GUARD — no view hand-rolls a header');
// ═══════════════════════════════════════════════════════════════════════════
// `view-title` and `sidebar-title` are renderViewHeader's OWN output classes.
// A view emitting either as a raw string literal has, by definition, built a
// header the component was created to own — and can therefore put a paragraph
// under it, which is the whole defect.
{
  ok('every view file was enumerated FROM DISK, not from a hardcoded list',
    viewFiles.length >= 8, `${viewFiles.length} files: ${viewFiles.join(', ')}`);

  /**
   * A RATCHET WITH A NAMED PENDING LIST, and the list must MATCH SOMETHING.
   *
   * Running this guard for the first time found FOUR views still painting a raw
   * `<div class="sidebar-title">`: chat, domains, settings and shared. v3.22.0
   * adopted the component for those views' CENTRE headers and left their
   * SIDEBAR headers hand-rolled — which its own §8 could not see, because that
   * section names call sites that DO exist rather than asking which ones do not.
   *
   * SEVERITY, STATED HONESTLY RATHER THAN INFLATED: none of the four carries a
   * paragraph today, so the defect the component removes is not live in them.
   * What is missing is the STRUCTURE that makes it inexpressible — a raw div
   * will accept a paragraph underneath it the moment someone adds one, and the
   * whole lesson of v3.20.0 is that the container was the defect, not the copy.
   *
   * Each entry carries the count it is allowed and the reason it was not simply
   * fixed here. The budget may SHRINK, never grow: adopting one of these turns
   * its entry stale, the count check goes red, and whoever adopted it deletes
   * the line. A stale exemption is a silent hole (the discipline
   * test-next-loading-gate.js's EXEMPT table established), so an entry that
   * matches nothing fails rather than passing quietly.
   */
  const HAND_ROLLED = /class="(?:view-title|sidebar-title)"/g;
  const PENDING = {
    // chat.js IS GONE FROM THIS LIST, and the entry that stood here is the
    // reason this file exists. It read `'chat.js': 3` and carried the LIVE
    // instance of the defect: `<h1 class="view-title">Chat</h1>` followed
    // IMMEDIATELY by `<div class="view-body">Chat needs at least one domain to
    // talk to…</div>`, a paragraph floating under a view title, on the app's
    // DEFAULT view, after the release that was supposed to make that
    // inexpressible. test-next-view-header.js §9b — the guard written to forbid
    // exactly that adjacency — could not see it, because its loop opened
    // `if (!src.includes('renderViewHeader(')) continue;` and skipped every view
    // that had not already opted in.
    //
    // All three of chat.js's headers now go through the component (centre ×2,
    // sidebar ×1) and the paragraph moved into the shared empty card. The
    // ratchet worked exactly as designed: fixing the view turned the entry
    // stale, the count check went red, and the entry was deleted rather than
    // left as a silent hole. The assertion that recorded the defect was
    // INVERTED rather than removed — see below the loop — so the fix cannot
    // quietly regress into a passing budget of 3.
    //
    // Four call sites, each concatenating a `newBtn`; adoption means moving
    // that button into the actions slot, which is a change to a view this pass
    // did not own.
    'domains.js': 4,
    'settings.js': 1,
    // Its title embeds `<span class="sb-beta-pill">beta</span>`. renderViewHeader
    // ESCAPES the title, so adopting needs the markup relocated to the actions
    // slot — a real decision about that view, not a mechanical swap.
    'shared.js': 1,
  };
  for (const f of viewFiles) {
    const hits = SRC[f].match(HAND_ROLLED) || [];
    const budget = PENDING[f] || 0;
    ok(`${f}: hand-rolled view headers ${budget ? `≤ ${budget} (pending adoption)` : '= 0'} — found ${hits.length}`,
      hits.length <= budget, hits.join(', '));
  }
  for (const f of Object.keys(PENDING)) {
    ok(`the PENDING entry for ${f} MATCHES something — a stale exemption is a silent hole`,
      viewFiles.includes(f) && (SRC[f].match(HAND_ROLLED) || []).length === PENDING[f],
      `expected ${PENDING[f]}, found ${(SRC[f] ? (SRC[f].match(HAND_ROLLED) || []).length : 'file missing')}`);
  }
  // THE LIVE ONE, NOW INVERTED. This assertion used to pin the defect's exact
  // shape in chat.js ("RECORDED, NOT FIXED"). Deleting it on the fix would have
  // left the fix guarded only by a COUNT, and a count is satisfied by any three
  // absences — including three that come back as something the count cannot
  // distinguish. So it now asserts the opposite of what it used to, naming the
  // same file and the same position, and goes red if the paragraph returns in
  // either the shape it had or the container it had.
  ok('FIXED, AND PINNED — chat.js paints no <h1 class="view-title"> and no .view-body of its own',
    !/class="view-title"/.test(SRC['chat.js']) && !/class="view-body"/.test(SRC['chat.js']),
    SRC['chat.js'].match(/class="(?:view-title|view-body)"[^']{0,80}/g)?.join(' | '));
  ok('...and its zero-domain sentence lives in the SHARED empty card, not under the title',
    /emptyCard\(\{[\s\S]{0,300}?Chat needs at least one domain to talk to/.test(SRC['chat.js']));
  ok('...with the header itself coming from the component, in both densities',
    /renderViewHeader\(\{ eyebrow: 'the default view', title: 'Chat' \}\)/.test(SRC['chat.js'])
    && /renderViewHeader\(\{ variant: 'sidebar', title: 'Chat' \}\)/.test(SRC['chat.js']));
  // CONTROL: the inverted assertion can still go red — proven on a copy that
  // restores the exact original two lines.
  ok('CONTROL: the inverted assertion FIRES if the old shape is put back',
    /class="view-title"/.test(
      SRC['chat.js'] + `'<h1 class="view-title">Chat</h1>' + '<div class="view-body">x</div>'`));

  // A fresh, NON-GLOBAL copy for the controls: a /g regex carries lastIndex
  // across .test() calls, so reusing the scanner here would make the third
  // control's result depend on the second's. That is its own silent-hole shape.
  const HR1 = /class="(?:view-title|sidebar-title)"/;
  ok('CONTROL: the hand-rolled detector FIRES on the shape it forbids',
    HR1.test(`'<h1 class="view-title">Sync</h1>'`));
  ok('CONTROL: ...and on the sidebar density too',
    HR1.test(`'<div class="sidebar-title">Sync</div>'`));
  ok('CONTROL: ...and does NOT fire on the component’s own composed class',
    !HR1.test('<h1 class="view-title tx-vh-title">'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  EVERY HEADER-RENDERING VIEW IMPORTS THE ONE COMPONENT');
// ═══════════════════════════════════════════════════════════════════════════
const ADOPTERS = viewFiles.filter((f) => SRC[f].includes('renderViewHeader('));
{
  ok('at least six views have adopted it', ADOPTERS.length >= 6, ADOPTERS.join(', '));
  for (const f of ADOPTERS) {
    ok(`${f}: imports renderViewHeader from '../shared/text.js'`,
      /import \{[^}]*\brenderViewHeader\b[^}]*\} from '\.\.\/shared\/text\.js';/s.test(SRC[f]));
    ok(`${f}: declares no LOCAL copy of it (two copies of one component drift)`,
      !/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+renderViewHeader\b/.test(SRC[f])
      && !/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+renderViewHeader\s*=/.test(SRC[f]));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  THE EXEMPTIONS ARE DIALOGS, AND EACH MUST MATCH SOMETHING');
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Three files in this tree are NOT views. They are a modal dialog, a second
 * modal dialog, and a docked panel — each rendered OVER a view that already
 * has its own <h1>.
 *
 * renderViewHeader does not fit them, and the reason is structural rather than
 * a matter of taste, so it is asserted rather than asserted-to-have-been-
 * considered:
 *
 *   1. Each takes its ACCESSIBLE NAME from `aria-labelledby`, pointing at an
 *      `id` on its own heading. renderViewHeader puts NO id on its title and
 *      has no `titleId` parameter — swapping it in would leave the dialog
 *      unnamed. §3b asserts that absence in the component itself, so if a
 *      `titleId` is ever added this exemption is re-openable on evidence.
 *   2. Its default density emits an <h1>. Rendered inside a modal over a view
 *      that already has one, that is the document-outline error the component's
 *      own docblock cites as the reason the sidebar density exists.
 *   3. onboarding.js additionally focuses its heading BY ID after every
 *      re-render (`root.querySelector('#obp-title')`), which needs both the id
 *      and the `tabindex="-1"` the component does not emit. That focus
 *      restoration is itself a v3.17.1 accessibility fix; adopting here would
 *      revert it.
 *
 * AND THE PRECEDENT AGREES: shared.js (the Shared Brain VIEW) adopted the
 * component in v3.22.0 while shared-brain-wizard.js (the dialog for the same
 * feature) did not. Same feature, one adopted, one not — the view/dialog line
 * was drawn deliberately then, not invented here.
 *
 * EVERY EXEMPTION MUST MATCH SOMETHING. If one of these stops being a dialog,
 * its exemption stops matching and this section goes red rather than quietly
 * granting cover to a real view.
 */
const DIALOG_EXEMPT = {
  'onboarding.js': { headingId: 'obp-title', role: 'region' },
  'mcp-wizard.js': { headingId: 'mcpw-title', role: 'dialog' },
  'shared-brain-wizard.js': { headingId: 'sbw-title', role: 'dialog' },
};
{
  for (const [f, e] of Object.entries(DIALOG_EXEMPT)) {
    ok(`${f}: the exemption MATCHES — the file exists and is enumerated`, viewFiles.includes(f));
    const src = SRC[f] || '';
    ok(`${f}: is still a ${e.role}, named by aria-labelledby="${e.headingId}"`,
      new RegExp(`role="${e.role}"[^']*aria-labelledby="${e.headingId}"`).test(src),
      src.slice(0, 0) || 'role/aria-labelledby pair not found');
    ok(`${f}: that id is on its OWN heading, which the component cannot emit`,
      new RegExp(`<h[23][^>]*id="${e.headingId}"`).test(src));
    ok(`${f}: and it has NOT adopted renderViewHeader behind this exemption’s back`,
      !src.includes('renderViewHeader('));
  }
  ok('onboarding.js focuses its heading BY ID, so the id and tabindex are load-bearing',
    /querySelector\('#obp-title'\)/.test(SRC['onboarding.js'])
    && /id="obp-title" tabindex="-1"/.test(SRC['onboarding.js']));
  ok('onboarding.js has no paragraph under its title anyway — obp-progress is a READOUT',
    /function progressLabel\([\s\S]{0,200}done \+ ' of ' \+ list\.length/.test(SRC['onboarding.js']));

  // §3b — the component really cannot name a dialog. The exemption rests on
  // this, so it is measured rather than asserted from memory.
  const textSrc = stripComments(readFileSync(join(SHARED_DIR, 'text.js'), 'utf8'));
  const fn = textSrc.slice(textSrc.indexOf('export function renderViewHeader'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  ok('renderViewHeader puts NO id on its title element — the reason above is real',
    body.length > 200 && !/tx-vh-title[^']*id=/.test(body) && !/o\.titleId/.test(body), body.slice(0, 120));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  THE TWO NEW ADOPTIONS, AT NAMED SITES');
// ═══════════════════════════════════════════════════════════════════════════
// A count alone stays green while any single site regresses: reverting ONE
// memory.js call site left v3.20.0's suite green at 98/0.
{
  const m = SRC['memory.js'], s = SRC['sync.js'];
  ok('memory.js sidebar: the component, in the sidebar density',
    /renderViewHeader\(\{\s*variant: 'sidebar',\s*title: 'Agent memory',/.test(m));
  ok('memory.js centre: the component, eyebrow + title and NO info field',
    /renderViewHeader\(\{ eyebrow: '[^']*', title: 'Agent memory' \}\)/.test(m));
  ok('memory.js centre deliberately hides nothing — renderAbout() still owns the mechanism',
    /renderExplainer\(\{/.test(m) && /summary: 'How this works'/.test(m));
  ok('sync.js sidebar: the component, in the sidebar density',
    /renderViewHeader\(\{\s*variant: 'sidebar',\s*title: 'Sync',/.test(s));
  // v3.24.0: this site GAINED an `info` field (the maintainer flagged the
  // dedicated "Commit history & revert are coming soon" card as unexplained
  // roadmap noise; that card is gone and the one real fact it carried — a
  // git client can revert, because every sync is a real commit — moved
  // here). The v3.22.0-era assertion pinned "eyebrow + title, no info"; that
  // shape is now WRONG BY DESIGN, so the regex is widened to require the
  // eyebrow/title pair PLUS a non-empty info string, rather than merely
  // dropping the check — an info-less regression at this exact call site
  // would still be caught (the info clause is mandatory in the pattern, not
  // optional).
  ok('sync.js centre: the component, eyebrow + title + info (recovery mechanism, relocated in v3.24.0)',
    /renderViewHeader\(\{\s*eyebrow: 'where it all lives',\s*title: 'Sync',\s*info: '[^']+',?\s*\}\)/.test(s));
  ok('neither view still imports eyebrow() — an unused import is an unadopted component',
    !/\beyebrow\b/.test((m.match(/import \{[\s\S]*?\} from '\.\.\/app\.js';/) || [''])[0])
    && !/\beyebrow\b/.test((s.match(/import \{[\s\S]*?\} from '\.\.\/app\.js';/) || [''])[0]));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  WHAT WAS CUT HAS NOT RETURNED, IN EITHER SHAPE');
// ═══════════════════════════════════════════════════════════════════════════
{
  const m = SRC['memory.js'], s = SRC['sync.js'];
  ok('memory.js: the "read here, written by them" clause stays cut (the foot says it unfolded)',
    !/read here, written by them/.test(m));
  ok('memory.js: ...and the sidebar foot really is where that fact lives now',
    /Read-only here\. Agents write this through MCP\./.test(m));
  ok('sync.js: the .view-body sentence is gone and has not come back as a description',
    !/class="view-body"/.test(s) && !/lives on your disk and backs up/.test(s));
  ok('sync.js: the sidebar sentence is the header’s info, not a .sidebar-hint div',
    /info: 'Pages, chats and schemas travel/.test(s) && !/class="sidebar-hint"/.test(s));

  // A WARNING IS NEVER BEHIND THE MARK. sync.js's cross-write refusal explains
  // why every primary action is dead, so it renders unfolded, as a status box.
  ok('sync.js: the cross-write refusal is a renderStatus box, not the header’s info',
    /renderStatus\(\{\s*state: 'attention',\s*title: '[^']+',\s*detail: crossWriteTitle\(\),/.test(s)
    && !/info: crossWriteTitle/.test(s));
  ok('sync.js: ...and it is actually RENDERED, not merely computed (the dead-data shape)',
    /\bcrossNote\b/.test(s) && (s.match(/\bcrossNote\b/g) || []).length >= 2);
  ok('sync.js: no `title=` survives on the disabled action buttons',
    !/crossTitle/.test(s));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  NO NEW HOVER-ONLY `title=` ON A NON-FOCUSABLE ELEMENT');
// ═══════════════════════════════════════════════════════════════════════════
/**
 * A RATCHET, not a ban. v3.20.0 counted 11 pieces of information in this app
 * carried only by a hover tooltip — invisible to keyboard and to touch — and
 * v3.22.0 declined to add a twelfth. This holds that line for the five files
 * this pass touched.
 *
 * The allow-list carries a REASON per entry and a COUNT, and the count may
 * shrink but never grow. Each survivor is the same shape: a tooltip carrying a
 * MORE PRECISE FORM of a value already rendered beside it (an ISO stamp behind
 * a humanised "2 hr ago"), which hides no fact. The two that carried a fact
 * available nowhere else were promoted to visible notes, not folded behind a
 * mark, because both qualify whether the reader should TRUST the document.
 *
 * Converting the three survivors would put a disclosure control on every row of
 * a journal list that pages to 50, and is recorded here as a decision rather
 * than done quietly or left unmentioned.
 */
const FOCUSABLE = /<(?:button|a|input|select|textarea)\b/i;
const TITLE_ALLOW = {
  'memory.js': 3,            // mem-doc-stamp, mem-fold-meta, mem-j-when: ISO stamp behind a humanised age.
  'sync.js': 0,
  'onboarding.js': 0,
  'mcp-wizard.js': 0,
  'shared-brain-wizard.js': 0,
};
{
  for (const [f, budget] of Object.entries(TITLE_ALLOW)) {
    ok(`${f}: the allow-list entry MATCHES a real file`, viewFiles.includes(f));
    const src = SRC[f];
    const offenders = [];
    for (const mt of src.matchAll(/\btitle="/g)) {
      // The nearest opening tag before this `title=`.
      const before = src.slice(Math.max(0, mt.index - 400), mt.index);
      const tag = before.lastIndexOf('<');
      const openTag = tag >= 0 ? before.slice(tag, tag + 12) : '';
      if (!FOCUSABLE.test(openTag)) offenders.push(src.slice(mt.index - 60, mt.index + 40).replace(/\s+/g, ' '));
    }
    ok(`${f}: hover-only title= on a non-focusable element ≤ ${budget} (found ${offenders.length})`,
      offenders.length <= budget, offenders.join('  |  '));
  }
  ok('CONTROL: the detector FIRES on a title= on a <span>',
    (() => { const s = '<span class="x" title="hidden fact">v</span>';
      const i = s.indexOf('title="'); return !FOCUSABLE.test(s.slice(s.lastIndexOf('<', i), i)); })());
  ok('CONTROL: ...and does NOT fire on a title= on a <button>',
    (() => { const s = '<button type="button" title="ok">v</button>';
      const i = s.indexOf('title="'); return FOCUSABLE.test(s.slice(s.lastIndexOf('<', i), i)); })());
  // The two that were PROMOTED rather than folded — named, so a revert is red.
  ok('memory.js: the shared-mirror explanation is a rendered note, not a tooltip',
    /A read-only Shared Brain mirror/.test(SRC['memory.js'])
    && !/title="A read-only Shared Brain mirror/.test(RAW['memory.js']));
  ok('memory.js: the other-machine caution is a rendered note, not a tooltip',
    /local paths and processes may differ/.test(SRC['memory.js'])
    && !/title="Saved on a different machine/.test(RAW['memory.js']));
  ok('shared-brain-wizard.js: its one title= duplicates an aria-label, so it hides nothing',
    /title="Show\/hide" aria-label="Show or hide the token"/.test(SRC['shared-brain-wizard.js']));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  CONTROLS — this suite can actually fail');
// ═══════════════════════════════════════════════════════════════════════════
{
  // v3.18.0: the suites disagreed about ok()'s argument order, and a reversed
  // signature makes every literal assertion pass unconditionally. Muted,
  // because run-tests.js fails a suite on any line starting with the cross.
  const realLog = console.log;
  let printed = '';
  console.log = (s) => { printed += String(s) + '\n'; };
  const p0 = passed, f0 = failed;
  ok('probe-true', true);
  ok('probe-false', false);
  console.log = realLog;
  passed = p0; failed = f0;
  ok('ok() takes (label, cond) in that order — a truthy label would pass everything',
    /✓ probe-true/.test(printed) && /✗ probe-false/.test(printed), printed);
  ok('CONTROL: an empty source would FAIL the hand-rolled scan, not pass it vacuously',
    !/class="(?:view-title|sidebar-title)"/.test('') === true);
}

console.log(`\n  Passed: ${passed}   Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
