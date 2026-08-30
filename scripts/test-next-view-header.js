/**
 * test-next-view-header.js — OFFLINE suite for renderViewHeader in
 * src/public/next/shared/text.js, plus the views that adopt it.
 *
 * No network, no API key, no server, no browser, no spend.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────
 *
 * Every view in /next painted a paragraph of static prose directly under its
 * <h1>. The maintainer reported it repeatedly — "text floating around",
 * "truly bad UX".
 *
 * v3.20.0 ATTEMPTED THIS AND FAILED, and the failure is why this suite is
 * shaped the way it is. That release built renderDescription and adopted it in
 * these very headers: the wording changed, the position did not. On Domains a
 * generated sentence became a static one, in the same slot, still a paragraph
 * under a title. THE CONTAINER WAS THE DEFECT, NOT THE WORDING.
 *
 * So the guard cannot be "does the copy read better". It has to be: can the
 * component even express the defect, and do the adopted views still go through
 * it. Both are asserted below, and both are mutation-proven.
 *
 * ── ENFORCED ────────────────────────────────────────────────────────────
 *
 *  §2  STRUCTURAL. renderViewHeader's output carries no <p> and no prose
 *      container outside the info panel, over an adversarial input matrix —
 *      including prose smuggled through the one caller-supplied HTML slot,
 *      which is DROPPED rather than rendered.
 *  §3  THE PANEL IS CLOSED ON FIRST PAINT. `hidden` is present on the panel
 *      in every output, and text.css states `display: none` for it explicitly
 *      so no later cascade can reveal it.
 *  §4  THE AFFORDANCE IS A REAL CONTROL: a <button type="button"> with an
 *      accessible name, aria-expanded="false", and aria-controls naming a
 *      panel id that actually exists in the same string.
 *  §4b NO TWO HEADERS IN ONE VIEW RESOLVE TO THE SAME INFO-PANEL DOM ID, over
 *      every view file ENUMERATED FROM DISK. §4 proved the `infoId` override
 *      WORKS; it never proved an adopter USES it, and v3.24.0 shipped duplicate
 *      ids on Sync through that gap with all 120 suites green. Ids are derived
 *      by RUNNING renderViewHeader, so the guard cannot drift from production.
 *  §5  ABSENT IS NOT ZERO, inherited from the rest of text.js: no info means
 *      no button AND no panel, not an empty one.
 *  §6  ESCAPING on every interpolated value; `infoHtml` is opt-in only.
 *  §7  TWO DENSITIES: the sidebar variant emits a <div> title, never a second
 *      <h1> on a screen that already has one.
 *  §8  ADOPTION, per view, at a NAMED SITE — because a count stays green while
 *      any single site regresses. This is the v3.20.0 lesson: reverting one
 *      call site to a raw div left that release's suite green at 98/0.
 *  §9  NO PROSE BETWEEN THE HEADER AND THE BODY in any adopted view: the
 *      retired classes do not reappear where the paragraph used to be.
 *  §9b THE CLASS GUARD, over EVERY view file on disk WITH NO ADOPTER FILTER.
 *      It used to open `if (!src.includes('renderViewHeader(')) continue;`,
 *      which made it police adopters only — and §8's list of who must adopt
 *      was four hardcoded names. views/chat.js, the DEFAULT view, floated a
 *      paragraph under its <h1> straight through that pair with this suite
 *      green. The `continue` was only the symptom: both patterns were anchored
 *      on the token `renderViewHeader(`, so they were inert on a file that had
 *      never adopted it. What a header MEANS is widened instead, to include a
 *      hand-rolled `view-title` / `sidebar-title` element.
 *  §10 A WARNING IS NEVER BEHIND THE MARK. Domains' read-only-mirror notice
 *      names data loss ("overwritten on the next Pull"), so it must be a
 *      renderStatus box in the body and must NOT appear in the header's info.
 *  §11 CSS HYGIENE: no px font-size in the new rules (--font-scale would stop
 *      reaching them), no colour literal, and no --text-3 (4.27 dark / 4.14
 *      light, under the 4.5 AA floor).
 *  §12 POSITIVE CONTROLS, including one for ok()'s own argument order —
 *      v3.18.0 records this repo's two suites disagreeing about it, and a
 *      reversed signature makes every literal assertion pass unconditionally.
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────
 *
 *  • The actions slot's prose filter is NARROW BY CONSTRUCTION. It matches a
 *    <p> and four known prose class names. A bare <div> of prose passed as
 *    `actionsHtml` renders. It is a floor, not a proof.
 *  • §8/§9 are SOURCE scans. The view modules cannot be imported in Node —
 *    they reach app.js, which touches `document` at module scope — so nothing
 *    here executes a view's real render. What IS executed is the component
 *    itself, on every branch.
 *  • NOTHING HERE MEASURES RENDERING, LAYOUT OR CONTRAST. A green run does
 *    not mean no paragraph is on screen; only looking does. The contrast
 *    figures quoted in §11's comments were measured in a real browser and are
 *    recorded, not re-derived here.
 *  • The delegated click/Escape behaviour is asserted as MARKUP (the button
 *    carries the attributes the handler keys on) and as SOURCE, not as
 *    executed DOM: there is no DOM in this process. The keyboard path was
 *    driven in a real browser instead.
 *  • §4b IS A STATIC SCAN, and a static scan cannot see: a title built from a
 *    variable (reported as unresolvable, never guessed — and REQUIRED to carry
 *    an explicit infoId once a file has a second info-carrying header, which is
 *    the only point at which it could collide); a header rendered from a shared
 *    helper in a file outside views/; two DIFFERENT views mounting headers at
 *    the same time (not reachable today — the shell renders one view, whose
 *    sidebar and main are the pair this covers); an id assigned or rewritten at
 *    runtime; and any panel emitted by something other than renderViewHeader —
 *    views/settings.js hand-rolls its own `.tx-vh-info` marks through a local
 *    infoMark(), and those ids are outside this scan (they are namespaced
 *    `settings-*`, so they cannot collide with a `tx-vh-info-*` header id, but
 *    that is a fact about today's strings and not something asserted here).
 *  • It proves ids are UNIQUE. It does not prove the right panel OPENS — that
 *    needs a browser, and it was driven in one.
 */

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  renderViewHeader, renderStatus, renderDescription,
} from '../src/public/next/shared/text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEXT = join(HERE, '..', 'src', 'public', 'next');
const read = (rel) => readFileSync(join(NEXT, rel), 'utf8');

let passed = 0, failed = 0;
/** ok(label, cond, detail) — label FIRST. §12 proves that order is real. */
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 220)}` : ''}`); }
}
function section(t) { console.log(`\n${t}\n${'-'.repeat(60)}`); }

/**
 * Strip line and block comments. Every source scan below runs on the stripped
 * text: a commented-out call site satisfies a naive regex, which is how a
 * guard comes to certify code that no longer runs.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The header element only — everything the user sees without clicking. */
function headerVisible(html) {
  return html.replace(/<div class="tx-vh-panel"[\s\S]*?<\/div>/g, '');
}

const TITLE = 'Ingest';
const PROSE = 'A domain is one compounding wiki — a subject you read about often.';

// ═══════════════════════════════════════════════════════════════════════════
section('§1  THE SIGNATURE HAS NO PROSE SLOT — the defect is inexpressible');
// ═══════════════════════════════════════════════════════════════════════════
// The whole claim of this release, asserted against the source of the
// function rather than against a rendered string: if a `description` /
// `subtitle` / `lede` / `body` field existed, an author could put a paragraph
// back under the title through the sanctioned API and every output assertion
// below would still pass.
{
  const src = stripComments(read('shared/text.js'));
  const fn = src.slice(src.indexOf('export function renderViewHeader'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  for (const banned of ['o.description', 'o.subtitle', 'o.lede', 'o.body', 'o.hint', 'o.note']) {
    ok(`renderViewHeader reads no \`${banned}\` — there is no sanctioned way to add a subtitle`,
      !body.includes(banned), body.slice(0, 200));
  }
  ok('the ONE prose field is `info`, and it is read',
    body.includes('str(o.info)'), body.slice(0, 200));
  ok('...and `info` is only ever emitted inside the tx-vh-panel element',
    /class="tx-vh-panel"[\s\S]*?escapeHtml\(info\)|class="tx-vh-panel"[\s\S]*?\? info :/.test(body),
    body.slice(0, 400));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  STRUCTURAL — no prose in the visible header, over a matrix');
// ═══════════════════════════════════════════════════════════════════════════
{
  const matrix = [
    ['bare', { title: TITLE }],
    ['eyebrow', { eyebrow: 'the way material gets in', title: TITLE }],
    ['info', { eyebrow: 'x', title: TITLE, info: PROSE }],
    ['info+html', { title: TITLE, info: '<strong>Two jobs</strong> here.', infoHtml: true }],
    ['actions', { title: TITLE, info: PROSE, actionsHtml: '<button id="a">Rename</button>' }],
    ['sidebar', { variant: 'sidebar', title: TITLE, info: PROSE }],
  ];
  for (const [name, args] of matrix) {
    const html = renderViewHeader(args);
    const vis = headerVisible(html);
    ok(`[${name}] the visible header contains no <p>`, !/<p[\s>]/i.test(vis), vis);
    ok(`[${name}] ...and none of the retired prose classes`,
      !/\b(?:tx-desc|view-body|sidebar-hint|settings-hint-text|dm-scope-desc)\b/.test(vis), vis);
  }
  // The prose is not merely absent from the visible header — it is present in
  // the string, inside the panel. Absence alone would also be satisfied by a
  // component that silently dropped the explanation.
  const withInfo = renderViewHeader({ title: TITLE, info: PROSE });
  ok('the explanation is NOT dropped — it survives, inside the panel',
    withInfo.includes(PROSE.replace(/'/g, '&#39;')) || withInfo.includes(PROSE), withInfo);
  ok('...and it appears AFTER the title row, not before it',
    withInfo.indexOf('tx-vh-panel') > withInfo.indexOf('tx-vh-row'), withInfo);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2b  THE ONE CALLER-SUPPLIED HTML SLOT REFUSES PROSE');
// ═══════════════════════════════════════════════════════════════════════════
// `actionsHtml` is the only route by which the paragraph could re-enter the
// header, so the wrong call produces the right output: prose is DROPPED.
{
  const proseShapes = [
    ['a <p>', '<p>A domain is one compounding wiki.</p>'],
    ['a tx-desc div', '<div class="tx-desc">A domain is one compounding wiki.</div>'],
    ['a view-body div', '<div class="view-body">A domain is one compounding wiki.</div>'],
    ['a sidebar-hint div', '<div class="sidebar-hint">One file at a time.</div>'],
    ['a settings-hint-text span', '<span class="settings-hint-text">Default 50,000 tokens.</span>'],
    ['a button FOLLOWED by a <p>', '<button id="r">Rename</button><p>and some prose</p>'],
  ];
  for (const [name, actionsHtml] of proseShapes) {
    const html = renderViewHeader({ title: TITLE, actionsHtml });
    ok(`actionsHtml carrying ${name} is DROPPED, not rendered`,
      !html.includes('compounding wiki') && !html.includes('some prose')
      && !html.includes('One file at a time') && !html.includes('50,000'), html);
  }
  // ...and the slot still WORKS, or "drop everything" would pass the above.
  const real = renderViewHeader({
    title: 'Research',
    actionsHtml: '<button class="btn btn-primary" id="dm-ask-btn">Ask this domain</button>',
  });
  ok('a genuine control still renders — the filter is not "drop everything"',
    real.includes('dm-ask-btn') && real.includes('Ask this domain'), real);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  THE PANEL IS CLOSED ON FIRST PAINT');
// ═══════════════════════════════════════════════════════════════════════════
{
  const html = renderViewHeader({ title: TITLE, info: PROSE });
  ok('the panel element carries `hidden`', /<div class="tx-vh-panel"[^>]*\shidden>/.test(html), html);
  ok('the panel is NOT rendered open', !/tx-vh-panel[^>]*\sopen/.test(html), html);
  // There is no `open: true` escape hatch, deliberately: a header that opens
  // its own panel is a paragraph under a title with extra steps.
  const forced = renderViewHeader({ title: TITLE, info: PROSE, open: true });
  ok('there is no `open` parameter — passing one cannot reveal the panel',
    /<div class="tx-vh-panel"[^>]*\shidden>/.test(forced), forced);

  const css = read('shared/text.css');
  ok('text.css states `display: none` for the hidden panel explicitly',
    /\.tx-vh-panel\[hidden\]\s*\{\s*display:\s*none;\s*\}/.test(css));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  THE AFFORDANCE IS A REAL CONTROL, NOT A TOOLTIP');
// ═══════════════════════════════════════════════════════════════════════════
// v3.20.0 counted 11 pieces of information in this app carried ONLY by
// `title=` on a non-focusable span — invisible to keyboard and to touch.
{
  const html = renderViewHeader({ title: 'Shared Brain', info: PROSE });
  ok('it is a <button>, and typed so it cannot submit a form',
    /<button type="button" class="tx-vh-info"/.test(html), html);
  ok('it has an accessible name', /aria-label="About Shared Brain"/.test(html), html);
  ok('it reports collapsed state', /aria-expanded="false"/.test(html), html);

  const controls = (html.match(/aria-controls="([^"]+)"/) || [])[1];
  ok('aria-controls names a panel that EXISTS in the same string',
    !!controls && html.includes(`<div class="tx-vh-panel" id="${controls}"`), controls);
  const dataId = (html.match(/data-tx-info="([^"]+)"/) || [])[1];
  ok('...and the delegated handler keys on the SAME id (data-tx-info)',
    dataId === controls, `${dataId} vs ${controls}`);
  ok('the button id is distinct from the panel id — two elements, two ids',
    /id="tx-vh-info-shared-brain-btn"/.test(html) && /id="tx-vh-info-shared-brain"/.test(html), html);

  // The glyph is decorative; the name is on the button.
  ok('the glyph is aria-hidden — the accessible name is not doubled',
    /<svg[^>]*aria-hidden="true"/.test(html), html);

  // Two headers on one screen must not collide on ids.
  const a = renderViewHeader({ title: 'Ingest', info: PROSE });
  const b = renderViewHeader({ title: 'Ingest', info: PROSE, infoId: 'tx-vh-info-ingest-sidebar' });
  // The PANEL id, not the button's — `id="…-btn"` appears first in the string.
  const panelId = (h) => (h.match(/<div class="tx-vh-panel" id="([^"]+)"/) || [])[1];
  const idA = panelId(a);
  const idB = panelId(b);
  ok('an explicit infoId overrides the derived one, so two headers can coexist',
    idA !== idB && idB === 'tx-vh-info-ingest-sidebar', `${idA} / ${idB}`);

  // The behaviour lives in ONE delegated pair, installed once.
  const src = stripComments(read('shared/text.js'));
  ok('Escape is handled — not left to a component that has no dismissal',
    /addEventListener\('keydown'[\s\S]{0,400}e\.key !== 'Escape'/.test(src), 'no Escape handler');
  ok('...and Escape returns focus to the control, never to <body>',
    /last\.focus\(\)/.test(src), 'no focus restore');
  ok('the listeners are installed ONCE, not per render',
    /if \(txInfoWired \|\| typeof document === 'undefined'\) return;/.test(src));
  ok('...and guarded on `document`, so this module still imports in Node',
    src.includes("typeof document === 'undefined'"));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4b TWO HEADERS IN ONE VIEW CANNOT COLLIDE ON A DOM ID');
// ═══════════════════════════════════════════════════════════════════════════
// §4's last pair proves the `infoId` OVERRIDE WORKS. It never proved that any
// adopter USES it — and that gap shipped a real defect.
//
// v3.24.0 added an `info` to views/sync.js's MAIN header. Its SIDEBAR header
// already had one, and both are titled 'Sync', so both derived the same panel
// id. `document.getElementById` returns the first in document order, so
// clicking the main mark opened the SIDEBAR's panel (measured: 243x58,
// hidden=false) while the main panel stayed hidden at 0x0 with
// `offsetParent === null`. Its prose — the git-recovery route, i.e. the one
// sentence a user needs when something has gone wrong, and the stated
// justification for deleting the "coming soon" History card — was in the DOM
// and unreachable by anyone. `aria-controls` was ambiguous too, so assistive
// tech was pointed at the wrong panel.
//
// ALL 120 OFFLINE SUITES WERE GREEN OVER IT, this one included. That is the
// v3.20.0 shape verbatim: a suite that proves a mechanism exists proves nothing
// about adoption. And the shape recurs — views/domains.js and views/ingest.js
// had BOTH already reached for `infoId` by hand. Two remembered, one forgot.
//
// The derivation now folds the variant in, so the sidebar-vs-main case cannot
// collide by construction. This section covers the RESIDUAL that construction
// does not reach: two headers sharing BOTH title and variant, and a header
// whose title is dynamic in a file that has another header to collide with.
//
// IT USES THE REAL renderViewHeader TO DERIVE EVERY ID. A second copy of the
// slug rule here would be a second thing to keep in step, and this repo's
// v3.2.0 CRITICAL came from exactly that. Change the derivation and this
// follows; what it asserts is ADOPTION, which is the half that was missing.
{
  /** Text between the parens of a call, respecting strings and nesting. */
  function argText(src, openParen) {
    let depth = 0, q = null;
    for (let i = openParen; i < src.length; i++) {
      const c = src[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        depth--;
        if (depth === 0) return src.slice(openParen + 1, i);
      }
    }
    return null;
  }

  /** Depth-0 properties of an object literal body → { key: rawValueText }. */
  function props(body) {
    const parts = [];
    let depth = 0, q = null, buf = '';
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (q) { buf += c; if (c === '\\') buf += body[++i] || ''; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; buf += c; continue; }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
      buf += c;
    }
    if (buf.trim()) parts.push(buf);

    const out = {};
    for (const p of parts) {
      if (!p.trim()) continue;
      // First depth-0 colon splits key from value. No colon = ES6 shorthand,
      // which is by definition a variable and therefore dynamic.
      let d = 0, qq = null, at = -1;
      for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (qq) { if (c === '\\') i++; else if (c === qq) qq = null; continue; }
        if (c === "'" || c === '"' || c === '`') { qq = c; continue; }
        if ('([{'.includes(c)) d++;
        else if (')]}'.includes(c)) d--;
        else if (c === ':' && d === 0) { at = i; break; }
      }
      if (at === -1) out[p.trim()] = null;                 // shorthand → dynamic
      else out[p.slice(0, at).trim().replace(/^['"]|['"]$/g, '')] = p.slice(at + 1).trim();
    }
    return out;
  }

  /** A single-quoted or double-quoted literal with no interpolation, else null. */
  function literal(v) {
    if (typeof v !== 'string') return null;
    const m = v.trim().match(/^'([^'\\]*)'$|^"([^"\\]*)"$/);
    return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
  }

  function callsIn(src) {
    const found = [];
    const re = /renderViewHeader\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const open = m.index + m[0].length - 1;
      const arg = argText(src, open);
      if (arg === null) { found.push({ opaque: true }); continue; }
      if (!arg.trim().startsWith('{')) { found.push({ opaque: true }); continue; }
      const body = argText(arg, arg.indexOf('{'));
      const p = props(body === null ? '' : body);
      const hasInfoKey = Object.prototype.hasOwnProperty.call(p, 'info');
      const infoVal = hasInfoKey ? String(p.info === null ? '' : p.info).trim() : '';
      found.push({
        opaque: false,
        // Conservative: anything not literally null/undefined/'' may emit a panel.
        hasInfo: hasInfoKey && !['null', 'undefined', "''", '""'].includes(infoVal),
        title: literal(p.title), titleGiven: Object.prototype.hasOwnProperty.call(p, 'title'),
        variant: literal(p.variant), variantGiven: Object.prototype.hasOwnProperty.call(p, 'variant'),
        infoId: literal(p.infoId), infoIdGiven: Object.prototype.hasOwnProperty.call(p, 'infoId'),
      });
    }
    return found;
  }

  const panelIdOf = (html) => (html.match(/<div class="tx-vh-panel" id="([^"]+)"/) || [])[1];

  /**
   * The id this call will emit, or null when a static scan cannot know.
   * Derived by RUNNING the component, never by re-implementing its slug rule.
   */
  function idFor(c) {
    if (!c.hasInfo) return { kind: 'none' };
    if (c.infoIdGiven) {
      return c.infoId === null
        ? { kind: 'unknown', why: 'infoId is not a literal' }
        : { kind: 'id', id: panelIdOf(renderViewHeader({ title: 'x', info: 'x', infoId: c.infoId })) };
    }
    if (c.variantGiven && c.variant === null) return { kind: 'unknown', why: 'variant is not a literal' };
    if (c.title === null) return { kind: 'unknown', why: 'title is not a literal' };
    const html = renderViewHeader({
      title: c.title, info: 'x', ...(c.variantGiven ? { variant: c.variant } : {}),
    });
    return { kind: 'id', id: panelIdOf(html) };
  }

  // ── The scan, over every view file ENUMERATED FROM DISK ────────────────────
  // Never a hardcoded list. A hardcoded list is how §8 went blind on chat.js,
  // and how three other guards in this repo went blind (v3.14.0, v3.23.0).
  const dir = join(NEXT, 'views');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  ok('view files were enumerated FROM DISK, not from a hardcoded list',
    files.length >= 8, `${files.length} files`);

  let totalCalls = 0, infoCalls = 0, opaque = 0, filesWithTwo = 0, scanned = 0;
  for (const f of files) {
    const src = stripComments(readFileSync(join(dir, f), 'utf8'));
    scanned++;
    const calls = callsIn(src);
    totalCalls += calls.length;
    opaque += calls.filter((c) => c.opaque).length;

    const live = calls.filter((c) => !c.opaque && c.hasInfo);
    infoCalls += live.length;
    if (live.length >= 2) filesWithTwo++;

    const ids = live.map(idFor);
    const concrete = ids.filter((r) => r.kind === 'id').map((r) => r.id);
    const dup = concrete.find((id, i) => concrete.indexOf(id) !== i);
    ok(`${f}: no two view headers resolve to the same info-panel DOM id`,
      dup === undefined,
      dup && `duplicate id "${dup}" — getElementById returns the FIRST, so one panel is unreachable`);

    // A dynamic title cannot be compared. That is fine alone and NOT fine
    // beside a sibling: it is precisely why views/domains.js passes an explicit
    // infoId for a title that is a user-chosen domain name — and a domain
    // named "Domains" would otherwise collide with the view's own header.
    if (live.length >= 2) {
      const blind = ids.filter((r) => r.kind === 'unknown');
      ok(`${f}: every header whose id a static scan cannot resolve carries an explicit infoId`,
        blind.length === 0,
        blind.length ? `${blind.length} unresolvable (${blind.map((b) => b.why).join('; ')})` : '');
    }
  }
  ok('...and EVERY view file was scanned', scanned === files.length, `${scanned}/${files.length}`);

  // ── ANTI-VACUITY. A parser that silently stops matching reports zero
  // collisions forever. These fail if the scan ever goes blind. ─────────────
  // 13 real call sites today: chat 3, domains 2, ingest 2, memory 2, settings 1,
  // shared 1, sync 2. A raw grep says 14 — chat.js:2248 MENTIONS the token in a
  // comment, and stripComments removes it. That gap is the reason this floor is
  // a measured number and not a guessed one.
  ok('the scan actually parsed the call sites it is meant to police',
    totalCalls >= 13, `found ${totalCalls} renderViewHeader calls`);
  ok('...and found headers that carry `info` at all — otherwise there are no ids to compare',
    infoCalls >= 8, `${infoCalls} info-carrying headers`);
  ok('...and at least one view has TWO of them, so the comparison is non-vacuous',
    filesWithTwo >= 1, `${filesWithTwo} files with 2+ info-carrying headers`);
  ok('no call site passes an opaque (non-literal) options object the scan cannot read',
    opaque === 0, `${opaque} opaque call sites`);

  // ── CONTROLS: the detector must fire on the real shape, and not on others ──
  const dupSrc =
    "renderViewHeader({ variant: 'sidebar', title: 'Sync', info: 'a' }) +\n" +
    "renderViewHeader({ variant: 'sidebar', title: 'Sync', info: 'b' })";
  {
    const ids = callsIn(dupSrc).filter((c) => c.hasInfo).map(idFor).map((r) => r.id);
    ok('CONTROL: FIRES on two headers sharing BOTH title and variant — the residual construction cannot remove',
      ids[0] !== undefined && ids[0] === ids[1], ids.join(' / '));
  }
  {
    // Byte-for-byte the shape v3.24.0 shipped, minus the variant fold.
    const shipped =
      "renderViewHeader({ variant: 'sidebar', title: 'Sync', info: 'x' }) +\n" +
      "renderViewHeader({ eyebrow: 'where it all lives', title: 'Sync', info: 'y' })";
    const ids = callsIn(shipped).filter((c) => c.hasInfo).map(idFor).map((r) => r.id);
    ok('CONTROL: the sidebar/main pair that SHIPPED broken now resolves to two distinct ids',
      ids[0] && ids[1] && ids[0] !== ids[1], ids.join(' / '));
  }
  {
    const ids = callsIn(
      "renderViewHeader({ title: 'Sync', info: 'a' }) +\n" +
      "renderViewHeader({ title: 'Sync', info: 'b', infoId: 'tx-vh-info-sync-two' })"
    ).filter((c) => c.hasInfo).map(idFor).map((r) => r.id);
    ok('CONTROL: an explicit infoId separates them', ids[0] !== ids[1], ids.join(' / '));
  }
  {
    const cs = callsIn("renderViewHeader({ title: 'Sync' }) + renderViewHeader({ title: 'Sync', info: null })");
    ok('CONTROL: does NOT fire on headers with no info — they emit no panel and no id',
      cs.every((c) => !c.hasInfo), JSON.stringify(cs));
  }
  {
    const cs = callsIn("renderViewHeader({ title, info: info ? info.text : null })");
    ok('CONTROL: a dynamic title is reported as unresolvable, never guessed',
      cs[0].title === null && idFor(cs[0]).kind === 'unknown', JSON.stringify(cs[0]));
  }
  {
    const cs = callsIn("renderViewHeader({ title: 'A, B', info: 'x, y' })");
    ok('CONTROL: a comma inside a string literal does not split a property',
      cs[0].title === 'A, B' && cs[0].hasInfo, JSON.stringify(cs[0]));
  }
  {
    const cs = callsIn("renderViewHeader({ title: 'X', info: 'x', actionsHtml: btn({ a: 1, b: 2 }) })");
    ok('CONTROL: a nested object in another property does not confuse the split',
      cs[0].title === 'X' && cs[0].hasInfo, JSON.stringify(cs[0]));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  ABSENT IS NOT ZERO');
// ═══════════════════════════════════════════════════════════════════════════
{
  const bare = renderViewHeader({ title: TITLE });
  ok('no info → NO button', !bare.includes('tx-vh-info'), bare);
  ok('no info → NO panel, not an empty one', !bare.includes('tx-vh-panel'), bare);
  ok('no eyebrow → no empty eyebrow div', !bare.includes('tx-vh-eyebrow'), bare);
  ok('no actions → no empty actions div', !bare.includes('tx-vh-actions'), bare);

  ok('whitespace-only info renders no affordance',
    !renderViewHeader({ title: TITLE, info: '   ' }).includes('tx-vh-info'));
  ok('no title → empty string, not a headless header', renderViewHeader({ title: '  ' }) === '');
  for (const bad of [null, undefined, 'x', 42, []]) {
    ok(`a ${JSON.stringify(bad)} argument returns '' rather than throwing`,
      renderViewHeader(bad) === '');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  ESCAPING');
// ═══════════════════════════════════════════════════════════════════════════
{
  const X = '<img src=x onerror=alert(1)>';
  const html = renderViewHeader({ eyebrow: X, title: X, info: X, infoId: X, actionsHtml: null });
  ok('no raw <img> survives anywhere in the output', !html.includes('<img'), html);
  ok('...the title is escaped', html.includes('&lt;img'), html);
  // Precise, because the loose version was a FALSE POSITIVE: the escaped text
  // legitimately CONTAINS the word onerror, so scanning past the closing quote
  // reported a breakout that had not happened. What matters is that no
  // attribute VALUE carries a raw < or a raw quote.
  {
    const attrs = [...html.matchAll(/(?:aria-label|title|id|aria-controls|data-tx-info)="([^"]*)"/g)]
      .map((m) => m[1]);
    ok('...and no attribute value carries a raw < — nothing can break out',
      attrs.length > 0 && attrs.every((v) => !v.includes('<')), attrs.join(' | '));
  }
  ok('...and an attacker-shaped infoId cannot break out of id=""',
    !/id="[^"]*"[^ >]/.test(html), html);

  const raw = renderViewHeader({ title: 'T', info: '<strong>ok</strong>', infoHtml: true });
  ok('infoHtml: true is honoured (opt-in only)', raw.includes('<strong>ok</strong>'), raw);
  const esc = renderViewHeader({ title: 'T', info: '<strong>ok</strong>' });
  ok('...and is NOT the default', esc.includes('&lt;strong&gt;'), esc);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  TWO DENSITIES, ONE VOCABULARY');
// ═══════════════════════════════════════════════════════════════════════════
{
  const main = renderViewHeader({ title: TITLE, info: PROSE });
  const side = renderViewHeader({ variant: 'sidebar', title: TITLE, info: PROSE });
  ok('the default renders an <h1>', /<h1 class="view-title tx-vh-title">/.test(main), main);
  ok('the sidebar renders a <div>, never a second <h1> on one screen',
    !side.includes('<h1') && /<div class="sidebar-title tx-vh-title">/.test(side), side);
  ok('...and both still carry the SAME affordance — one vocabulary',
    side.includes('tx-vh-info') && main.includes('tx-vh-info'));
  ok('...and the same closed-by-default panel',
    /<div class="tx-vh-panel"[^>]*\shidden>/.test(side), side);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  ADOPTION — per view, at a NAMED site');
// ═══════════════════════════════════════════════════════════════════════════
// A COUNT alone stays green while any single site regresses. That is not a
// hypothetical: v3.20.0 reverted one memory.js call site to a raw div and its
// suite stayed green at 98/0.
//
// THIS OBJECT IS A LIST, AND A LIST IS EXACTLY WHAT WENT BLIND. It is kept
// anyway, because the per-site assertions below are the thing §9b's class scan
// cannot do (a class scan proves nothing is wrong; only a named site proves a
// particular thing is right). What has changed is that it is no longer the ONLY
// layer: §9b now walks every file on disk with no adopter filter, so a view
// missing from here is caught there, and scripts/test-next-header-adoption.js
// asks the third question — which views render a header WITHOUT the component.
const VIEWS = {
  'domains.js': stripComments(read('views/domains.js')),
  'ingest.js': stripComments(read('views/ingest.js')),
  'shared.js': stripComments(read('views/shared.js')),
  'settings.js': stripComments(read('views/settings.js')),
  // Added when chat.js adopted the component. It was the view this suite's two
  // layers could not see between them, so it is named here explicitly.
  'chat.js': stripComments(read('views/chat.js')),
};
for (const [name, src] of Object.entries(VIEWS)) {
  ok(`${name} imports renderViewHeader from the ONE shared module`,
    /import \{[^}]*\brenderViewHeader\b[^}]*\} from '\.\.\/shared\/text\.js';/s.test(src));
  ok(`${name} does NOT declare a local copy of it`,
    !/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+renderViewHeader\b/.test(src)
    && !/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+renderViewHeader\s*=/.test(src));
  const calls = (src.match(/renderViewHeader\(/g) || []).length;
  ok(`${name} actually CALLS it (${calls} sites) — an unused import is an unadopted component`,
    calls > 0, `${calls} call sites`);
}
// The named sites.
ok('domains.js: ONE header builder serves all four list branches',
  /function domainsHeader\(\)[\s\S]{0,300}renderViewHeader\(\{ eyebrow: 'your brain', title: 'Domains', info: DOMAIN_BLURB \}\)/
    .test(VIEWS['domains.js']));
ok('domains.js: the four list branches call it, and none hand-rolls the header',
  (VIEWS['domains.js'].match(/domainsHeader\(\)/g) || []).length >= 5
  && !/eyebrow\('your brain'\) \+ '<h1/.test(VIEWS['domains.js']));
ok('domains.js: the DETAIL header is the component, with the controls in the actions slot',
  /renderViewHeader\(\{[\s\S]{0,400}actionsHtml:[\s\S]{0,400}dm-ask-btn/.test(VIEWS['domains.js']));
ok('shared.js: the centre header is the component',
  /renderViewHeader\(\{[\s\S]{0,120}title: 'Shared Brain',/.test(VIEWS['shared.js']));
ok('ingest.js: BOTH blocks the report named — centre and sidebar',
  /renderViewHeader\(\{ eyebrow: 'the way material gets in', title: 'Ingest' \}\)/.test(VIEWS['ingest.js'])
  && /renderViewHeader\(\{ variant: 'sidebar', title: 'Ingest', info: hint/.test(VIEWS['ingest.js']));
ok('settings.js: renderMain builds the header, per-section, from SECTION_INFO',
  /const info = SECTION_INFO\[state\.section\];[\s\S]{0,300}renderViewHeader\(\{/.test(VIEWS['settings.js']));
// chat.js — the app's DEFAULT view, and the one both layers of this suite
// missed. THREE headers: two in the centre column (pre-boot and zero-domain,
// the identical two-field literal at both) and one in the sidebar.
ok('chat.js: both centre branches build the header from the component, identically',
  (VIEWS['chat.js'].match(/renderViewHeader\(\{ eyebrow: 'the default view', title: 'Chat' \}\)/g) || []).length === 2);
ok('chat.js: the sidebar uses the sidebar DENSITY, so the screen keeps one <h1>',
  /renderViewHeader\(\{ variant: 'sidebar', title: 'Chat' \}\)/.test(VIEWS['chat.js']));
ok('chat.js: neither centre call passes `info` — there was no prose to fold, only prose to MOVE',
  !/renderViewHeader\(\{ eyebrow: 'the default view', title: 'Chat', info:/.test(VIEWS['chat.js']));
ok('settings.js: `general` has NO entry, so that section renders no mark',
  /const SECTION_INFO = \{[\s\S]*?\n\};/.test(VIEWS['settings.js'])
  && !/^\s{2}general:/m.test(VIEWS['settings.js'].match(/const SECTION_INFO = \{[\s\S]*?\n\};/)[0]));

// ═══════════════════════════════════════════════════════════════════════════
section('§9  NO PROSE WHERE THE PARAGRAPH USED TO BE');
// ═══════════════════════════════════════════════════════════════════════════
// The retired containers, per view. Named rather than generic: this is the
// exact position the maintainer reported, four times.
ok('shared.js emits no .view-body anywhere', !/class="view-body"/.test(VIEWS['shared.js']));
ok('shared.js: the sidebar label was CUT, not restyled',
  !/Cohorts this install writes to/.test(VIEWS['shared.js']));
ok('settings.js emits no .view-body anywhere (5 paragraphs, 0 left)',
  !/class="view-body"/.test(VIEWS['settings.js']));
ok('ingest.js: the deleted drop-zone sentence has not returned',
  !/Drop in a/.test(VIEWS['ingest.js']));
ok('ingest.js: .view-body SURVIVES only as the loading-placeholder role it shares with loading-gate.js',
  /class="view-body">Starting batch/.test(VIEWS['ingest.js']));
ok('domains.js: the blurb reaches the fold, never renderDescription',
  !/renderDescription\(DOMAIN_BLURB\)/.test(VIEWS['domains.js'])
  && /info: DOMAIN_BLURB/.test(VIEWS['domains.js']));
ok('domains.js: the hand-rolled title row is GONE, not kept beside the component',
  !/dm-title-row/.test(VIEWS['domains.js']));
ok('domains.css: its layout rule went with it, so there is no second copy to drift',
  !/^\.dm-title-row/m.test(stripComments(read('views/domains.css'))));
// chat.js — the position the maintainer's complaint actually pointed at.
ok('chat.js emits no .view-body anywhere (the paragraph under the <h1> is gone)',
  !/class="view-body"/.test(VIEWS['chat.js']));
ok('chat.js hand-rolls no title element at all, in either density',
  !/class="view-title"/.test(VIEWS['chat.js']) && !/class="sidebar-title"/.test(VIEWS['chat.js']));
ok('chat.js: the sentence was RELOCATED into the shared empty card, not deleted and not hidden',
  /emptyCard\(\{[\s\S]{0,300}?Chat needs at least one domain to talk to/.test(VIEWS['chat.js']));
ok('chat.js: ...and it is NOT behind the info mark — a blocked screen must say why, unfolded',
  !/info:[^\n]{0,120}Chat needs at least one domain/.test(VIEWS['chat.js']));
ok('chat.js: `eyebrow()` is no longer imported — both of its call sites were hand-rolled headers',
  !/\beyebrow\b/.test(VIEWS['chat.js'].slice(0, VIEWS['chat.js'].indexOf("} from '../app.js';"))));

// ── §9b  THE CLASS GUARD, not one named string ────────────────────────────
// M1 in the mutation table put `renderDescription(DOMAIN_BLURB)` back above the
// Domains detail header, and §9's named assertion caught it — but only because
// it names that constant. A DIFFERENT paragraph would have walked past.
//
// So this is the generic form, over EVERY view in the tree rather than the four
// adopted here: nothing that renders prose may sit adjacent to a header call.
// A fifth view adopting renderViewHeader later inherits the guard without
// anyone remembering to extend a list — which is how the last one went blind.
//
// ── AND IT WENT BLIND ANYWAY. THE SECOND FIX, AND WHAT IT COST TO FIND ─────
//
// The paragraph above was true and insufficient. This loop opened with
//
//     if (!src.includes('renderViewHeader(')) continue;
//
// so a view that never adopted the component was skipped — by the guard whose
// entire job is to forbid the shape a NON-adopter is most likely to have. §8's
// list of who must adopt was hardcoded to four views. Together the two layers
// proved "every ADOPTER behaves" and "these four are ADOPTERS", and said
// nothing whatsoever about a fifth view. views/chat.js — the app's DEFAULT
// view — was that fifth view, and it floated
// `<div class="view-body">Chat needs at least one domain to talk to…</div>`
// directly under `<h1 class="view-title">Chat</h1>` through the whole of the
// release built to make that inexpressible, with this suite green at 130/0.
//
// THE `continue` WAS ONLY THE SYMPTOM. Deleting it alone changes nothing,
// which is the part worth recording: BOTH patterns were anchored on the token
// `renderViewHeader(`, so on a file that has never heard of the component they
// match nothing no matter how many paragraphs it paints. The loop would have
// walked chat.js and cheerfully passed it.
//
// So what a "view header" MEANS is widened here instead: the component call OR
// a hand-rolled title element — `<h1 class="view-title">` / `<div
// class="sidebar-title">`, which are the component's own output classes and
// therefore, appearing as raw string literals, are a header built by hand. The
// adjacency question is then asked of every view file on disk, unconditionally.
{
  // BOTH DIRECTIONS. The first draft only looked AFTER the header call, and M1
  // in the mutation table walks straight past it — inserting the paragraph
  // ABOVE the header is where it fits syntactically, and prose above a title is
  // the same defect as prose below one. Caught by running the mutation, not by
  // re-reading the regex.
  //
  // Assembled from source fragments rather than written as four literals: the
  // "after" and "before" forms have to agree about what a header is and what
  // prose is, and two hand-maintained copies of that answer drift. That is this
  // repo's most reliable defect shape and it is not worth re-earning here.
  const HEADER_END =
    '(?:renderViewHeader\\([\\s\\S]{0,600}?\\)' +          // the component
    '|class="view-title">[^<]{0,200}</h1>\'' +             // hand-rolled, centre
    '|class="sidebar-title">[^<]{0,200}</div>\')';         // hand-rolled, sidebar
  const HEADER_START =
    '(?:renderViewHeader\\(' +
    '|\'<h1 class="view-title">' +
    '|\'<div class="sidebar-title">)';
  const PROSE_START =
    '(?:renderDescription\\(|\'<p|\'<div class="(?:tx-desc|view-body|sidebar-hint)")';
  const PROSE_END =
    '(?:renderDescription\\([^;]{0,200}?\\)' +
    '|\'<p[^\']{0,200}?\'' +
    '|\'<div class="(?:tx-desc|view-body|sidebar-hint)[^\']{0,200}?\')';

  const PROSE_AFTER_HEADER = new RegExp(HEADER_END + '\\s*\\+\\s*' + PROSE_START);
  const PROSE_BEFORE_HEADER = new RegExp(PROSE_END + '\\s*\\+\\s*(?:\\n\\s*)?' + HEADER_START);
  const PROSE_NEXT_TO_HEADER = {
    test: (t) => PROSE_AFTER_HEADER.test(t) || PROSE_BEFORE_HEADER.test(t),
  };

  const viewFiles = readdirSync(join(NEXT, 'views')).filter((f) => f.endsWith('.js'));
  ok('every view file was enumerated FROM DISK, not from a hardcoded list',
    viewFiles.length >= 8, `${viewFiles.length} files`);
  // NO `continue`. Every view is asked the question, adopter or not — see the
  // block comment above for the release this cost.
  let scanned = 0;
  for (const f of viewFiles) {
    const src = stripComments(readFileSync(join(NEXT, 'views', f), 'utf8'));
    scanned++;
    const hit = src.match(PROSE_AFTER_HEADER) || src.match(PROSE_BEFORE_HEADER);
    ok(`${f}: no prose is concatenated onto a view header, above it or below it`,
      !hit, hit && hit[0].slice(-160));
  }
  ok('...and EVERY view file was scanned, not just the ones that adopted the component',
    scanned === viewFiles.length, `scanned ${scanned} of ${viewFiles.length}`);

  // CONTROL: the detector fires on the exact shape it forbids, in both forms.
  ok('CONTROL: the adjacency detector FIRES on a renderDescription after a header',
    PROSE_NEXT_TO_HEADER.test("renderViewHeader({ title: 'X' }) +\n renderDescription(BLURB) +"));
  ok('CONTROL: ...and on a raw prose div after a header',
    PROSE_NEXT_TO_HEADER.test("renderViewHeader({ title: 'X' }) +\n '<div class=\"tx-desc\">hi</div>' +"));
  ok('CONTROL: ...and on a renderDescription placed ABOVE the header',
    PROSE_NEXT_TO_HEADER.test("renderDescription(BLURB) +\n    renderViewHeader({ title: 'X' })"));
  ok('CONTROL: ...and does NOT fire on a header followed by a status box',
    !PROSE_NEXT_TO_HEADER.test("renderViewHeader({ title: 'X' }) +\n renderStatus({ title: 'y' }) +"));
  ok('CONTROL: ...nor on a status box placed above the header',
    !PROSE_NEXT_TO_HEADER.test("renderStatus({ title: 'y' }) +\n renderViewHeader({ title: 'X' })"));

  // ── THE CONTROLS THAT MATTER: the NON-adopter shapes the old form missed ──
  // Byte-for-byte the two lines views/chat.js actually shipped. If this suite
  // is ever rewritten and these stop firing, the hole is open again.
  ok('CONTROL: FIRES on a HAND-ROLLED <h1> followed by a paragraph — chat.js’s real, shipped shape',
    PROSE_NEXT_TO_HEADER.test(
      "      '<h1 class=\"view-title\">Chat</h1>' +\n" +
      "      '<div class=\"view-body\">Chat needs at least one domain to talk to.</div>' +"));
  ok('CONTROL: ...and on a hand-rolled SIDEBAR title followed by a .sidebar-hint',
    PROSE_NEXT_TO_HEADER.test(
      "    '<div class=\"sidebar-title\">Chat</div>' +\n" +
      "    '<div class=\"sidebar-hint\">No domains exist yet.</div>' +"));
  ok('CONTROL: ...and on a paragraph placed ABOVE a hand-rolled <h1>',
    PROSE_NEXT_TO_HEADER.test(
      "      '<div class=\"view-body\">prose</div>' +\n      '<h1 class=\"view-title\">Chat</h1>'"));
  ok('CONTROL: ...and does NOT fire on a hand-rolled title followed by a BUTTON',
    !PROSE_NEXT_TO_HEADER.test(
      "    '<div class=\"sidebar-title\">Chat</div>' +\n    '<button class=\"btn\">New chat</button>' +"));
  // AND THE PROOF THAT IT IS THE WIDENING, NOT THE `continue`, THAT CLOSED IT:
  // the OLD pattern — anchored on the component token — is inert on that same
  // shipped shape. Deleting the `continue` alone would have left this suite
  // green over the defect it was written to catch.
  ok('CONTROL: the OLD component-anchored pattern is INERT on that shape — the `continue` was not the bug',
    !/renderViewHeader\(([\s\S]{0,600}?)\)\s*\+\s*(?:renderDescription\(|'<p|'<div class="(?:tx-desc|view-body|sidebar-hint)")/
      .test("      '<h1 class=\"view-title\">Chat</h1>' +\n" +
            "      '<div class=\"view-body\">Chat needs at least one domain to talk to.</div>' +"));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10  A WARNING IS NEVER BEHIND THE MARK');
// ═══════════════════════════════════════════════════════════════════════════
// v3.16.1: a warning behind a click is not a warning. Domains' read-only
// mirror notice names data loss, so it must be in the body, unfolded.
{
  const d = VIEWS['domains.js'];
  ok('the mirror notice is SPLIT: an explanation and a warning, two constants',
    /const MIRROR_INFO = /.test(d) && /const MIRROR_WARNING = /.test(d));
  ok('the DATA-LOSS half is the warning half',
    /const MIRROR_WARNING = '[^']*overwritten on the next Pull/.test(d));
  ok('...and it renders through renderStatus, in the body',
    /renderStatus\(\{ state: 'attention', title: '[^']+', detail: MIRROR_WARNING \}\)/.test(d));
  ok('...and is NOT what the header hides',
    /info: readonly \? MIRROR_INFO : DOMAIN_BLURB/.test(d) && !/info: MIRROR_WARNING/.test(d));
  ok('the header component has NO tone/state/warning field, so it cannot host one',
    !/o\.warningTone|o\.state|o\.tone/.test(
      (() => {
        const s = stripComments(read('shared/text.js'));
        const f = s.slice(s.indexOf('export function renderViewHeader'));
        return f.slice(0, f.indexOf('\n}\n') + 3);
      })()));
  // Settings' money/timing banners stayed in the body too.
  ok('settings.js keeps the fallback-model banner unfolded (it is a billing change)',
    /renderFallbackBanner\(k\.fallback\)/.test(VIEWS['settings.js']));
  ok('settings.js keeps every cross-write banner unfolded',
    (VIEWS['settings.js'].match(/renderCrossWriteBanner\(/g) || []).length >= 2);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11  CSS HYGIENE');
// ═══════════════════════════════════════════════════════════════════════════
{
  const css = read('shared/text.css');
  const vh = css.slice(css.indexOf('/* ── 6. View header'));
  ok('the view-header rules exist in text.css', vh.length > 200);
  // --font-scale multiplies the --text-* ramp; a px font-size freezes at 1x.
  // v3.20.0 found 14 of those in chat.css alone, including .chat-answer.
  const pxSizes = [...vh.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => m[0]);
  ok('no hardcoded px font-size — the text-size setting still reaches this header',
    pxSizes.length === 0, pxSizes.join(', '));
  const literals = [...vh.matchAll(/(?:color|background)\s*:\s*(#[0-9a-f]{3,8}|rgb)/gi)].map((m) => m[0]);
  ok('no colour literal — every value resolves to a token', literals.length === 0, literals.join(', '));
  // --text-3 measures 4.27 dark / 4.14 light against --surface, under the 4.5
  // AA floor, and 181 rules in /next already use it as a text colour.
  ok('no --text-3 — hierarchy is made with size, weight and family',
    !/var\(--text-3\)/.test(vh));
  ok('the panel and the glyph both use --text-2 (8.34 dark / 7.26 light)',
    /\.tx-vh-info \{[\s\S]*?color: var\(--text-2\);/.test(vh)
    && /\.tx-vh-panel \{[\s\S]*?color: var\(--text-2\);/.test(vh));
  ok('the panel is bordered — --surface-raised is BYTE-IDENTICAL to --surface in light',
    /\.tx-vh-panel \{[\s\S]*?border: 1px solid var\(--border\);/.test(vh));
  ok('reduced motion is honoured for the mark’s transition',
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.tx-vh-info \{ transition: none; \}/.test(vh));
  ok('text.css is <link>ed from index.html — the v3.9.1 styled-but-unlinked trap',
    /<link[^>]+href="\/next\/shared\/text\.css"/.test(read('index.html')));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§12  POSITIVE CONTROLS — every detector above is shown to FIRE');
// ═══════════════════════════════════════════════════════════════════════════
// A detector that cannot go red is a comment.
{
  // ok()'s ARGUMENT ORDER. v3.18.0 records this repo's suites disagreeing
  // about it, and a reversed signature makes every literal assertion pass
  // unconditionally — caught there by mutation, not by review.
  //
  // It drives the REAL ok() — a private copy would prove nothing about the
  // function every other assertion uses — with console.log MUTED for the
  // duration. Muting is not cosmetic: run-tests.js fails a suite on any line
  // beginning with the cross glyph (run-tests.js:334), so a deliberate red
  // printed here would mark this whole suite FAILED while it reports 0
  // failures. That is the v3.3.0 shape — a suite classified by a STRING in its
  // own output rather than by its exit code.
  const before = { p: passed, f: failed };
  const realLog = console.log;
  console.log = () => {};
  try {
    ok('CONTROL-ORDER: a deliberately-false assertion', false);
  } finally {
    console.log = realLog;
  }
  const reallyFailed = failed === before.f + 1 && passed === before.p;
  failed = before.f; passed = before.p;          // un-count the deliberate red
  ok('CONTROL: ok() takes (label, cond) — a reversed signature would pass everything unconditionally',
    reallyFailed);

  // §2's <p> detector.
  ok('CONTROL: the <p> detector FIRES on a header that really carries one',
    /<p[\s>]/i.test(headerVisible('<header class="tx-vh"><h1>T</h1><p>prose</p></header>')));
  // §2b's actions filter, both directions.
  ok('CONTROL: the actions filter PASSES a control-only slot',
    renderViewHeader({ title: 'T', actionsHtml: '<button>Go</button>' }).includes('<button>Go</button>'));
  // §3's hidden detector.
  ok('CONTROL: the hidden-panel detector FIRES on an unhidden panel',
    !/<div class="tx-vh-panel"[^>]*\shidden>/.test('<div class="tx-vh-panel" id="x">p</div>'));
  // §8's adoption scan — a file that merely imports without calling.
  ok('CONTROL: the call-site count reports 0 for import-without-call',
    ("import { renderViewHeader } from '../shared/text.js';".match(/renderViewHeader\(/g) || []).length === 0);
  // §9's retired-class scan.
  ok('CONTROL: the .view-body scan FIRES on a file that has one',
    /class="view-body"/.test('x = \'<p class="view-body">hi</p>\';'));
  // stripComments — the reason every source scan runs on stripped text.
  ok('CONTROL: stripComments removes a commented-out call site',
    !/renderViewHeader\(/.test(stripComments('// renderViewHeader({ title: "x" })\nconst a = 1;')));
  ok('CONTROL: ...and leaves a real one',
    /renderViewHeader\(/.test(stripComments('const a = renderViewHeader({ title: "x" });')));
  // The sibling roles still work — this suite must not be green because the
  // module failed to load.
  ok('CONTROL: the module really loaded (a sibling role still renders)',
    renderStatus({ state: 'attention', title: 'x' }).includes('tx-status-attention')
    && renderDescription('hi').includes('tx-desc'));
}

console.log(`\n  Passed: ${passed}   Failed: ${failed}\n`);
if (failed === 0) console.log('All view-header offline assertions green');
process.exit(failed === 0 ? 0 : 1);
