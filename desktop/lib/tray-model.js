/**
 * buildTrayModel() — the menubar widget's rows, as plain data.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  WHY THIS IS A SEPARATE, ELECTRON-FREE, src-FREE MODULE                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Electron is deliberately not an offline-suite dependency, so `main.js` can
 * never be imported, evaluated or run by `npm test` — a guard on it can only
 * ever be a source scan, which proves a line was WRITTEN and nothing else
 * (v3.0.17). Every module in `desktop/lib/` exists to move the provable part
 * out of main.js, and this one is no different: the entire ROW MODEL — what a
 * row says, which column carries the harness and which carries the machine,
 * how a cap is disclosed, which ages are trustworthy — is ordinary data that
 * `scripts/test-tray-shell.js` computes and inspects for real.
 *
 * It imports nothing from `src/` for the same reason `menu.js` and
 * `quit-decision.js` do not: `src/public/next/views/memory.js` registers a view
 * at module scope and reaches for a DOM, so importing it here would fail in
 * Node. Where a value has to agree with `src/`, it is duplicated and PINNED BY
 * A CROSS-FILE ASSERTION in the suite — the same trade `menu.js` makes for
 * RELEASES_URL, and here it is stronger than a string compare: the suite
 * extracts the real `formatAge` out of `memory.js`, evaluates it, and runs both
 * copies over the same matrix.
 *
 * ── THE INPUT IS THE FIXED CONTRACT ────────────────────────────────────────
 *
 * `getTraySummary({ limit })` is implemented elsewhere (the data layer) and
 * called by main.js as a PLAIN FUNCTION — the shell and the server share one
 * Node realm, so there is no HTTP hop and no IPC. It returns:
 *
 *   { ok, lastSave | null, scopes: [...], brief | null, remote | null,
 *     warnings: [] }
 *
 * and each scope carries `project, scope, machine, harness, writtenAt,
 * writtenAgeSeconds, ageSource ('agent'|'file'), headline, isThisMachine,
 * harnessShared`.
 *
 * THIS MODULE TREATS THAT INPUT AS UNTRUSTED. Not because the data layer is
 * suspect, but because it is being written in parallel with this file and
 * because a menubar that throws is a menubar that is simply absent, with no
 * error anywhere a user will look. Every field is read defensively and every
 * absence has a rendering.
 *
 * ── THE ONE RULE THAT SHAPES EVERY LINE HERE ───────────────────────────────
 *
 * `null` IS NEVER `0` AND NEVER A FAKE STRING. An unknown age renders as
 * "time unknown", never as "just now". An age that came from a filesystem
 * timestamp — `ageSource: 'file'`, which git rewrites on checkout, so on a
 * second machine every pulled handoff reads as brand new — renders as
 * "changed 4 min ago", never as "4 min ago", because *written* is a claim
 * about the agent's clock and *changed* is a claim about this disk's.
 * A fact and its absence must never share a presentation.
 *
 * ── AGES ARE RE-DERIVED AT RENDER TIME, NOT READ OUT OF THE SNAPSHOT ───────
 *
 * `writtenAgeSeconds` in the summary is a number the DATA LAYER computed
 * against the clock it held when it read the disk. This model is rendered far
 * more often than the disk is read — `mouse-enter` re-renders from the
 * in-memory snapshot precisely so a hover costs no I/O, and the one-shot glyph
 * corrector re-renders with no read at all — so taking that number verbatim
 * pins every age to the last read while `renderedAtText`, the absolute stamp
 * beside it, moves.
 *
 * That inverts the purpose of the stamp. `tray-menu.js` justifies the absolute
 * "Updated HH:MM" as the thing that makes a dead watch visible; a stale age
 * sitting under a moving stamp says "fresh" about a reading that is not.
 *
 * So `effectiveAgeSeconds()` re-runs the producer's own arithmetic against the
 * RENDER clock, over the absolute timestamp the snapshot already carries. It
 * is the same expression working-state.js uses, character for character —
 * `Math.max(0, Math.round((now - Date.parse(at)) / 1000))` — so this is not a
 * second opinion about age, it is the first opinion evaluated later.
 *
 * WHAT IT MUST NOT DO IS INVENT PRECISION. `ageSource: 'file'` still has an
 * absolute time to derive from (the store puts the mtime in `writtenAt` when
 * it falls back to the file clock), so a `file` row is re-derived too and
 * keeps its "changed …" wording — the clock it came from is unchanged by
 * recomputing against a newer now. But a row with NO parseable timestamp is
 * left exactly as it was: it falls back to the snapshot's number if there is
 * one, and to null — "time unknown" — if there is not. An unknown age must
 * stay unknown; re-deriving is a way to be more accurate about a fact, never
 * a way to manufacture one.
 */

import { renderPulseStrip, pulseLabel, pulseToolTip } from './pulse-strip.js';

// ── Caps ────────────────────────────────────────────────────────────────────
//
// Eight rows: roughly what fits above the fold of a menubar menu without the
// menu becoming a window. It is also a CAP, so it is disclosed — a cap must
// never read as a measurement (v3.17.0). See `truncatedNote`.
export const MAX_ROWS = 8;

/**
 * Headlines are the agent's own prose and can run long; a menu item that is
 * 400px wide pushes everything else off the screen. Truncation is visible
 * (an ellipsis) rather than silent.
 *
 * ── WHY THIS CAME DOWN FROM 72, AND WHY IT DID NOT GO TO ZERO ──────────────
 *
 * The maintainer's complaint was that the menu takes "close to a quarter of a
 * screen". Measured on his real store, the sublabel sat at 71–72 characters on
 * EVERY row — a clip cap that a real headline always reaches is not a cap on
 * an outlier, it is a fixed width, so the second line of every row was always
 * near maximum. That made it, and not the label, the thing setting the menu's
 * width half the time.
 *
 * He also said explicitly that he wants the headline "available for a quick
 * glance". So it is SHORTER, not GONE: 54 is the width of the longest ROW
 * LABEL after the compaction below, so the headline can never be the widest
 * thing in the menu while still carrying the first clause of the agent's own
 * sentence. The full headline stays reachable — it is what the Agent memory
 * view shows, one click away on the same row.
 */
export const MAX_HEADLINE_CHARS = 54;

/** Tier B lines: shown only when they have something to say, and bounded so a
 *  pathological warning list cannot become the whole menu. */
export const MAX_NOTICES = 4;

/** "Live" — an agent has written in this scope within this many seconds.
 *  Two minutes, from the recency table in docs/roadmap-menubar-widget.md.
 *  Exported because main.js arms a ONE-SHOT timer at exactly this boundary
 *  (see `liveExpiresInMs` below) rather than polling to find out. */
export const LIVE_WINDOW_SECONDS = 120;

// ── Age formatting ──────────────────────────────────────────────────────────

/**
 * The precision ladder, coarsest first. `null` is the ordinary ladder — the one
 * `src/public/next/views/memory.js` renders and the one every row uses unless
 * something forces a finer reading. See `resolveCollisions` for the only thing
 * that ever does.
 */
export const AGE_PRECISIONS = [null, 'hour', 'minute'];

/**
 * Relative age from a whole-second count.
 *
 * ── THE DEFAULT ARM IS A VERBATIM COPY, AND IT MUST STAY ONE ───────────────
 *
 * Called with ONE argument this is `formatAge` from
 * `src/public/next/views/memory.js`, unchanged. The duplication is deliberate:
 * that module registers a view and touches the DOM at import time, so it cannot
 * be imported here. Two functions rendering "4 min ago" differently is the
 * smallest possible version of the two-surfaces-drift problem, so the suite
 * does not merely diff the text — it extracts the real one, evaluates it, and
 * asserts both agree on a matrix that crosses every boundary in the ladder.
 *
 * ── AND `precision` EXTENDS IT RATHER THAN BRANCHING AROUND IT ─────────────
 *
 * A second age formatter living beside this one would be that same drift
 * problem, created deliberately, to solve a narrower problem. So the ladder
 * gained a FLOOR instead: `precision` names the coarsest unit the answer is
 * allowed to use, and everything below that floor is the existing ladder
 * untouched.
 *
 *   undefined  the ordinary ladder            "1 day ago"
 *   'hour'     never coarser than hours       "34 hr ago"
 *   'minute'   never coarser than minutes     "2041 min ago"
 *
 * It is the SAME FACT at a finer resolution, never a different fact, and it is
 * reached only from `resolveCollisions` — where two rows would otherwise render
 * the identical label and the alternative is naming a machine.
 *
 * Every arm still returns `null` for an absent age. A null/absent age is NOT
 * rendered as "0s ago"; callers get null and render their own words.
 */
export function formatAge(seconds, precision) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return 'just now';
  const m = Math.floor(seconds / 60);
  if (precision === 'minute') return m + ' min ago';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (precision === 'hour') return h + ' hr ago';
  if (h < 24) return h + ' hr ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  const w = Math.floor(d / 7);
  if (w < 5) return w + ' week' + (w === 1 ? '' : 's') + ' ago';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + ' month' + (mo === 1 ? '' : 's') + ' ago';
  const y = Math.floor(d / 365);
  return y + ' year' + (y === 1 ? '' : 's') + ' ago';
}

/**
 * The age phrase for a row, qualified by WHICH CLOCK it came from.
 *
 *   'agent' -> "4 min ago"           the agent's own clock, from the journal
 *   'file'  -> "changed 4 min ago"   this disk's mtime, which git rewrites
 *   absent  -> "time unknown"        never "just now"
 *
 * The `file` wording is the whole point of `ageSource` existing. A handoff
 * that arrived over Personal Sync carries the mtime of the PULL, so an
 * unqualified "just now" over a day-old handoff is not merely imprecise — it
 * is the exact reading that stops someone looking.
 */
export function ageText(ageSeconds, ageSource, precision) {
  const rel = formatAge(ageSeconds, precision);
  if (rel === null) return 'time unknown';
  return ageSource === 'file' ? 'changed ' + rel : rel;
}

/**
 * The age of one record AT THE RENDER CLOCK, in whole seconds.
 *
 * See "AGES ARE RE-DERIVED AT RENDER TIME" in this file's header for why this
 * exists. In one line: the snapshot's `writtenAgeSeconds` was measured against
 * a clock that has since moved, and this model is rendered from that snapshot
 * on hover, on a glyph expiry and on a mode change without any new read.
 *
 * PRECEDENCE, and the order is the whole contract:
 *
 *  1. A parseable absolute `at` wins. The arithmetic is byte-for-byte the one
 *     `working-state.js` uses to produce `writtenAgeSeconds` in the first
 *     place, including the `Math.max(0, …)` clamp — so a clock skewed a few
 *     seconds into the future (ordinary between two machines, which is the
 *     scenario this widget was built for) reads "just now" rather than
 *     collapsing to "time unknown".
 *  2. Otherwise the snapshot's own number, unchanged. It is stale by however
 *     long ago the read was, which is exactly as good as today's behaviour and
 *     is the best available when there is no timestamp to do better with.
 *  3. Otherwise null. NOT zero, NOT "just now" — see the header's one rule.
 *
 * @param {string|null} at        an absolute ISO timestamp, or anything else
 * @param {number|null} fallback  the snapshot's precomputed age in seconds
 * @param {number} nowMs          the render clock, in epoch ms
 * @returns {number|null}
 */
export function effectiveAgeSeconds(at, fallback, nowMs) {
  if (typeof at === 'string' && at) {
    const ms = Date.parse(at);
    if (Number.isFinite(ms) && Number.isFinite(nowMs)) {
      return Math.max(0, Math.round((nowMs - ms) / 1000));
    }
  }
  return typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 0
    ? fallback
    : null;
}

/**
 * The recency bucket. Discrete states on a log-ish scale, NOT a bar: age is
 * unbounded, so any bar maximum would be invented and the bar's fullness would
 * be a fiction.
 *
 * Keyed on the age the caller hands it, which the model always takes from the
 * `writtenAt`/`writtenAgeSeconds` pair — the agent's clock wherever the store
 * had one — precisely so that a `git pull` cannot turn every incoming scope
 * Live. Re-deriving that age at render time (see `effectiveAgeSeconds`) does
 * not weaken that: it changes WHEN the age is measured, never WHICH CLOCK it
 * was measured from, and `ageSource` continues to say which that was.
 */
export function ageBucket(ageSeconds) {
  if (typeof ageSeconds !== 'number' || !Number.isFinite(ageSeconds) || ageSeconds < 0) return 'unknown';
  if (ageSeconds < LIVE_WINDOW_SECONDS) return 'live';
  if (ageSeconds < 30 * 60) return 'warm';
  if (ageSeconds < 12 * 3600) return 'today';
  if (ageSeconds < 7 * 86400) return 'cool';
  return 'cold';
}

// ── Machine names ───────────────────────────────────────────────────────────

/**
 * A machine folder is `<hostname-slug>-<install-id>` — far too long for a menu
 * row, and the install id is not the interesting half. Show the HOST part.
 *
 * The install id is stripped only when the trailing hyphen-segment actually
 * LOOKS like one (4+ hex characters and nothing else). A host legitimately
 * called `build-box` keeps both words, because `box` is not hex. This is a
 * display heuristic and it is allowed to be conservative: the cost of not
 * stripping is a slightly longer label, and the cost of over-stripping is a
 * machine name that is missing a word.
 */
export function hostPart(machine) {
  if (typeof machine !== 'string' || !machine) return null;
  const i = machine.lastIndexOf('-');
  if (i <= 0) return machine;
  const tail = machine.slice(i + 1);
  return /^[0-9a-f]{4,}$/i.test(tail) ? machine.slice(0, i) : machine;
}

/** The disambiguator appended when two VISIBLE rows share a host part —
 *  exactly the hostname-split condition docs/working-state.md describes. */
function installTag(machine) {
  if (typeof machine !== 'string') return '';
  const i = machine.lastIndexOf('-');
  if (i <= 0) return '';
  const tail = machine.slice(i + 1);
  return /^[0-9a-f]{4,}$/i.test(tail) ? tail.slice(0, 4) : '';
}

/**
 * Short machine labels for a set of rows, disambiguated only where needed.
 *
 * Computed over the ROWS THAT WILL BE SHOWN, not over every machine on disk:
 * a suffix that disambiguates against something the user cannot see is noise.
 */
export function shortMachineNames(machines) {
  const list = (Array.isArray(machines) ? machines : []).filter((m) => typeof m === 'string' && m);
  // Count DISTINCT machines per host part — the same machine appearing on
  // three rows is one machine and must not disambiguate against itself.
  const distinct = new Map();
  for (const m of list) {
    const h = hostPart(m) || m;
    if (!distinct.has(h)) distinct.set(h, new Set());
    distinct.get(h).add(m);
  }
  const out = new Map();
  for (const m of list) {
    const h = hostPart(m) || m;
    const tag = installTag(m);
    out.set(m, distinct.get(h).size > 1 && tag ? h + '·' + tag : h);
  }
  return out;
}

// ── Scope names ─────────────────────────────────────────────────────────────

/**
 * Prefixes that carry no information in a list where every row is a scope.
 *
 * `session-` is the one the skill's own examples produce, and on the
 * maintainer's real store it is 14 characters (`session-2026-0`) shared by
 * every single row. A token every row carries is a token that distinguishes
 * nothing; it is pure width.
 */
export const SCOPE_DISPLAY_PREFIXES = ['session-'];

/**
 * Display names for a set of scopes, shortened only where it stays lossless.
 *
 * ── THE COLLISION GUARD IS THE WHOLE REASON THIS IS A SET OPERATION ────────
 *
 * Stripping a prefix per-row in isolation can make two DIFFERENT scopes render
 * identically — a store holding both `deploy` and `session-deploy` would show
 * two rows reading `deploy`, and a list in which two rows are the same row is
 * worse than a list that is slightly too wide. So the strip is computed over
 * all the scopes that will be SHOWN together, and any scope whose shortened
 * form collides with another shown scope's displayed form keeps its full name.
 *
 * Computed over the shown rows and not over the whole store for the same
 * reason `shortMachineNames` is: disambiguating against something the user
 * cannot see is noise.
 *
 * The full scope always remains in the row's tooltip. Nothing becomes
 * unreachable — that rule is absolute here.
 *
 * @param {string[]} scopes
 * @returns {Map<string, string>} raw scope -> displayed scope
 */
export function shortScopeNames(scopes) {
  const list = (Array.isArray(scopes) ? scopes : []).filter((s) => typeof s === 'string' && s);
  const taken = new Set(list);

  const proposed = new Map();
  for (const s of list) {
    let short = s;
    for (const p of SCOPE_DISPLAY_PREFIXES) {
      if (s.length > p.length && s.slice(0, p.length) === p) { short = s.slice(p.length); break; }
    }
    proposed.set(s, short);
  }

  // A shortened form is only accepted when nothing else shown already answers
  // to it — neither another scope's full name nor another scope's short form.
  const shortCounts = new Map();
  for (const short of proposed.values()) shortCounts.set(short, (shortCounts.get(short) || 0) + 1);

  const out = new Map();
  for (const [raw, short] of proposed) {
    const collides = short !== raw && (taken.has(short) || shortCounts.get(short) > 1);
    out.set(raw, collides ? raw : short);
  }
  return out;
}

// ── Text helpers ────────────────────────────────────────────────────────────

/** Collapse whitespace and clip, with a VISIBLE ellipsis. A headline is the
 *  agent's own sentence and can contain newlines; a menu label containing a
 *  newline renders as a mangled single line on macOS. */
export function clip(text, max) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

/** Two-digit local clock time. The menu's own freshness stamp is ABSOLUTE and
 *  the rows' ages are RELATIVE, deliberately: they answer different questions
 *  (how old is this event / how old is this reading), and conflating them is
 *  how a widget comes to display a confidently stale list. Taken from the open
 *  bug filed against OpenAI's Codex menubar app, whose proposed remedy is
 *  exactly a "last updated at HH:MM" stamp. */
export function clockText(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── The model ───────────────────────────────────────────────────────────────

function readScopes(summary) {
  const raw = summary && Array.isArray(summary.scopes) ? summary.scopes : [];
  return raw.filter((s) => s && typeof s === 'object');
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * The remote line — rendered as ONE footer line and only when it has something
 * to say.
 *
 * `remote: null` means WE DID NOT CHECK, and that is rendered as nothing. It
 * is not rendered as "up to date", because the widget does not know that. The
 * distinction matters here more than anywhere else in this file: "0 waiting"
 * and "not checked" are the fact and its absence, and the remote check is on
 * menu-open only, so "not checked" is the NORMAL state of this field rather
 * than an error.
 */
export function remoteNotice(remote) {
  if (!remote || typeof remote !== 'object') return null;
  if (remote.ok === false) {
    return {
      kind: 'remote', ok: false,
      text: str(remote.message) || 'Could not check GitHub for waiting handoffs',
    };
  }
  const files = num(remote.behindFiles) ?? num(remote.waiting);
  const n = files ?? num(remote.behindCommits);
  if (n === null || n === 0) return null;
  const unit = files !== null
    ? (n === 1 ? 'handoff' : 'handoffs')
    : (n === 1 ? 'commit' : 'commits');
  return { kind: 'remote', ok: true, text: n + ' ' + unit + ' waiting on GitHub' };
}

/** The data layer's warning codes this model has an opinion about. They are
 *  the `code` field on `getTraySummary()`'s `warnings[]` entries, and they are
 *  a CONTRACT — see `dedupeAgainstSuppliedWarnings` for why matching on the
 *  message text instead is what this fix exists to undo. Pinned by the suite
 *  against the real producer's own emissions. */
export const WARNING_HARNESS_COLLISION = 'harness-collision';
export const WARNING_SCOPES_TRUNCATED = 'scopes-truncated';

/**
 * Normalise `summary.warnings[]` into records that keep the STRUCTURE.
 *
 * The data layer emits `{code, message, project, scope, …}`. The previous
 * version of this file flattened every warning to its message string at the
 * top of `buildTrayModel`, which threw the code away before anything could use
 * it — and the deduplication below then had nothing left to match on but
 * prose. Defensive as ever: a bare string is accepted and simply carries no
 * code, and anything unusable is dropped.
 */
function readWarnings(summary) {
  const raw = summary && Array.isArray(summary.warnings) ? summary.warnings : [];
  const out = [];
  for (const w of raw) {
    if (typeof w === 'string') {
      if (w.trim()) out.push({ code: null, message: w.trim(), project: null, scope: null });
      continue;
    }
    if (!w || typeof w !== 'object') continue;
    const message = typeof w.message === 'string' && w.message.trim() ? w.message.trim() : null;
    if (!message) continue;
    out.push({
      code: typeof w.code === 'string' && w.code ? w.code : null,
      message,
      project: str(w.project),
      scope: str(w.scope),
    });
  }
  return out;
}

/**
 * The collision warning: two harnesses on one machine resolve to the same
 * `<machine>` folder and silently overwrite each other's handoff.
 *
 * The widget cannot fix it — the remedy, give them separate scopes, is the
 * user's — and it must not propose one in six words. It names the scope and
 * says nothing else.
 *
 * DERIVED HERE rather than taken from `warnings[]`, because `harnessShared` is
 * per-row data this module already holds and a per-row fact belongs with the
 * row. `dedupeAgainstSuppliedWarnings` then removes whichever copy is
 * redundant, so the two sources cannot both speak about one scope.
 */
function collisionNotices(rows) {
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.harnessShared !== true) continue;
    const key = r.project + ' ' + r.scope;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: 'collision',
      project: r.project,
      scope: r.scope,
      text: 'Two harnesses are writing ' + r.project + ' · ' + r.scope,
    });
  }
  return out;
}

/**
 * Drop the supplied warnings that something else in this menu already says.
 *
 * ── WHY THIS MATCHES ON `code` AND NEVER ON WORDING ────────────────────────
 *
 * The previous suppression was `/harness/i.test(w) && w.includes(project) &&
 * w.includes(scope)` over the warning's MESSAGE. The only producer of that
 * warning is `tray-summary.js`'s `harness-collision`, and its message reads
 * "Two agent tools are writing alpha · main." — the word "harness" does not
 * appear in it anywhere. So the suppression was dead against the sole case it
 * was written for, and every collision emitted BOTH lines, burning two of the
 * four notice slots to say one thing twice.
 *
 * It passed its own test because the fixture in the suite was a hand-written
 * string that happened to contain "harnesses". A regex over user-facing copy
 * is a coupling to a sentence nobody knows they must not reword; the `code`
 * field exists precisely to be matched on, and is asserted against the real
 * producer's emissions rather than against a fixture.
 *
 * TWO PAIRS ARE DEDUPED, and the second is the same shape one notch milder:
 *
 *  - `harness-collision` versus the derived collision line. The SUPPLIED one
 *    wins, because the data layer saw the whole store and its message is the
 *    better sentence; the derived line exists for a summary that reports
 *    `harnessShared` on a row without emitting the warning.
 *  - `scopes-truncated` versus `truncatedNote`. `truncatedNote` is already
 *    rendered as its own menu item directly under the last row, where it
 *    belongs; letting the warning through as well restates the cap in the
 *    notices block a few lines below. The note wins for the same reason it
 *    exists — it is attached to the list it is about.
 *
 * @param {Array} supplied   readWarnings() output
 * @param {Array} derived    the collision notices this model computed
 * @param {boolean} hasTruncatedNote  whether the cap is already disclosed
 */
function dedupeAgainstSuppliedWarnings(supplied, derived, hasTruncatedNote) {
  const derivedKeys = new Set(derived.map((d) => d.project + ' ' + d.scope));
  const keptSupplied = [];
  const supersededDerived = new Set();

  for (const w of supplied) {
    if (w.code === WARNING_SCOPES_TRUNCATED && hasTruncatedNote) continue;
    if (w.code === WARNING_HARNESS_COLLISION) {
      // Matched on the warning's OWN project/scope fields, not by searching
      // its prose for them — the same reason the code is matched rather than
      // the wording. A collision warning that names a scope we did not derive
      // (it was past the row cap, say) still gets through.
      const key = (w.project || '') + ' ' + (w.scope || '');
      if (derivedKeys.has(key)) supersededDerived.add(key);
      keptSupplied.push(w);
      continue;
    }
    keptSupplied.push(w);
  }

  return {
    supplied: keptSupplied,
    derived: derived.filter((d) => !supersededDerived.has(d.project + ' ' + d.scope)),
  };
}

/**
 * Build the whole menu model from one `getTraySummary()` result.
 *
 * @param {object} summary  a getTraySummary() result, or anything at all —
 *                          garbage in produces the empty state, never a throw.
 * @param {object} [opts]
 * @param {Date}   [opts.now]      the render clock, injected so the suite can
 *                                 assert the absolute stamp deterministically.
 * @param {number} [opts.maxRows]
 * @returns {object} the model consumed by tray-menu.js.
 */
export function buildTrayModel(summary, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const maxRows = Number.isInteger(opts.maxRows) && opts.maxRows > 0 ? opts.maxRows : MAX_ROWS;

  const nowMs = now.getTime();
  const ok = !!(summary && summary.ok !== false);
  const all = readScopes(summary);

  // NEWEST FIRST, and the sort key is the AGENT'S clock where there is one.
  //
  // Sorting on mtime would put every freshly-pulled remote handoff at the top
  // of the list regardless of when it was written — the same defect as the
  // recency bucket, one layer up. Rows with no age at all sort LAST: they
  // cannot be placed truthfully anywhere else, and putting an unknown at the
  // top would be asserting it is the newest.
  //
  // The age is computed ONCE per row, here, and the same value is used for the
  // sort, the bucket, the label and the glyph. Deriving it twice — once for
  // the order and once for the text — is how a list comes to be sorted by one
  // number and labelled with another.
  const withAge = all.map((s, i) => ({
    s, i, age: effectiveAgeSeconds(str(s.writtenAt), num(s.writtenAgeSeconds), nowMs),
  }));
  withAge.sort((a, b) => {
    if (a.age === null && b.age === null) return a.i - b.i;
    if (a.age === null) return 1;
    if (b.age === null) return -1;
    if (a.age !== b.age) return a.age - b.age;
    return a.i - b.i;
  });

  const shownWithAge = withAge.slice(0, maxRows);
  const shown = shownWithAge.map((x) => x.s);
  const machineLabels = shortMachineNames(shown.map((s) => s.machine));
  const scopeLabels = shortScopeNames(shown.map((s) => str(s.scope)).filter(Boolean));

  // ── WIDTH COMPACTION, AND EVERY LEVER IS CONDITIONAL ON THE DATA ────────
  //
  // The measured complaint was that this menu takes "close to a quarter of a
  // screen": the widest rendered line on the maintainer's own store was 93
  // characters, with a mean of 57 across 24 lines. There is NO width API in
  // Electron, and none in AppKit's maximum direction either — the LENGTH OF
  // THE CONTENT is the only lever that exists, so the content is what changes.
  //
  // What was measured as pure width, carrying zero information on his store:
  //
  //   "projects · "     11 chars on 8 rows — exactly one project has state
  //   "session-2026-0"  a 14-char prefix common to every scope name
  //   "claude-code"     11 chars — the harness on 65 of 65 journal lines
  //
  // NONE of these is deleted unconditionally. Each is dropped only while the
  // data says it distinguishes nothing, and each comes straight back the
  // moment it does: a second project, a scope that does not share the prefix,
  // a second harness. A hardcoded strip would be a lie waiting for the day the
  // user's setup changes, and it would be a silent one.
  //
  // THE ABSOLUTE RULE ON TOP OF ALL OF THEM: every fact removed from a label
  // is still in that row's `toolTip`, in full and unshortened. The tooltip is
  // built below from the RAW values for exactly this reason, and the suite
  // asserts it for every lever.

  // Projects: counted over every scope the summary handed us, not merely the
  // rows that survived the cap, so a project sitting just past the row limit
  // still keeps the token on the rows above it. (If the DATA LAYER itself
  // capped before we saw it, a project hidden past that cap is not rendered
  // anywhere either, and `truncatedNote` is what points at the full list.)
  const projectsPresent = new Set(all.map((s) => str(s.project) || '(unnamed)'));
  const showProject = projectsPresent.size !== 1;

  // Harness: dropped only when EVERY shown row that would display one displays
  // the same one. A row with no harness at all counts against dropping — an
  // absent harness is not evidence that it matches the others, and "unknown
  // harness" is a real distinction worth its width.
  const localHarnesses = shown
    .filter((s) => s.isThisMachine === true)
    .map((s) => str(s.harness));
  const dropHarness = localHarnesses.length > 0
    && localHarnesses.every((h) => h !== null)
    && new Set(localHarnesses).size === 1;

  // ── THE PROVENANCE SLOT, DECIDED ACROSS THE WHOLE SHOWN SET ─────────────
  //
  // Provisional first, because whether a token may be dropped is a fact about
  // the LIST and not about the row: a token can only be dropped when it
  // distinguishes nothing, and "nothing" is measured against the rows beside
  // it.
  const sourceOf = (s) => (s.ageSource === 'file' ? 'file' : (s.ageSource === 'agent' ? 'agent' : null));
  const machineOf = (s) => machineLabels.get(s.machine) || str(s.machine) || 'unknown machine';

  // The per-row age precision, escalated only by the collision resolver below.
  // Every row starts on the ordinary ladder — the one the app's own memory view
  // renders — and a row is moved off it only to avoid printing a machine name.
  const precisions = shown.map(() => null);

  const provenances = shown.map((s) => (
    s.isThisMachine === true
      ? (dropHarness ? null : (str(s.harness) || 'unknown harness'))
      : machineOf(s)
  ));

  const identityOf = (s) => {
    const scp = str(s.scope) || '(unnamed)';
    return (showProject ? (str(s.project) || '(unnamed)') + ' · ' : '') + (scopeLabels.get(scp) || scp);
  };
  const composeLabel = (s, age, provenance, precision) =>
    identityOf(s) + (provenance ? ' — ' + provenance : '') + ' · ' + ageText(age, sourceOf(s), precision);

  /**
   * ── WHICH ROWS ARE THE SAME COMPUTER ────────────────────────────────────
   *
   * KEYED ON `isThisMachine`, NOT on the producer's `machineMatch`, and the
   * reason is that this module must hold exactly ONE notion of "this machine".
   * `isThisMachine` is already the field the two-meaning slot is built on — it
   * decides whether a row's provenance is a harness or a machine at all — so
   * reusing it means the collision fix and the provenance rule can never
   * disagree about what a row is. Reading `machineMatch` here would put a
   * SECOND identity opinion in the same function, which is the drift shape this
   * project keeps recording; it is also a diagnostic that must never be
   * displayed, and a diagnostic that silently governs what IS displayed is
   * worse than one that is merely unused.
   *
   * Two rows are one computer when they are both THIS installation — which is
   * exactly the maintainer's case, one laptop whose hostname flapped under DHCP
   * leaving two `<machine>` folders — or when they name the same folder.
   */
  const machineKey = (s) => (s.isThisMachine === true ? '@this' : (str(s.machine) || '@unknown'));

  // ── AND THEN THE COLLISION GUARD, WHICH IS WHY IT IS TWO PASSES ─────────
  //
  // Compaction that makes two rows READ THE SAME is worse than the width it
  // saved: a list in which two entries are indistinguishable is not a shorter
  // list, it is a broken one. So the compacted labels are composed, checked
  // against each other, and any row that has become a duplicate is separated.
  //
  // ── HOW IT SEPARATES THEM, IN ORDER, AND WHY THAT ORDER ────────────────
  //
  // The first version of this restored a MACHINE FOLDER NAME whenever the
  // colliding rows sat in different folders. Driven against the maintainer's
  // real store it produced exactly this:
  //
  //   2026-08-30-design-conformance-pre-native — talis-macbook-pro · 1 day ago
  //   2026-08-30-design-conformance-pre-native — mac · 1 day ago
  //
  // Those two folders are ONE LAPTOP whose hostname flapped under DHCP. So the
  // fix reasserted a phantom second computer that the machine-identity work had
  // just removed, and it did it on the only two lines in the whole menu still
  // over the width target — a fix that is wrong about the hardware AND the
  // most expensive thing on screen.
  //
  //  1. If the colliding rows are the SAME COMPUTER (see `machineKey`),
  //     escalate the PRECISION OF THE AGE — day, then hour, then minute — until
  //     the labels differ. "1 day ago" becomes "34 hr ago" and "36 hr ago".
  //     That is the same fact at a finer resolution, it costs no width, and it
  //     makes no claim about hardware at all. It goes through `formatAge`'s own
  //     ladder with a floor rather than through a second formatter.
  //  2. If they are DIFFERENT computers, the machine label is restored exactly
  //     as before. That is not really a collision to be worked around — the
  //     machine IS the distinguishing fact, and it is the news.
  //  3. If the same computer saved twice within one MINUTE, escalation runs out
  //     and the folder names come back. Two saves that close genuinely need
  //     another discriminator, and at that point the folder name is the
  //     least-bad one available.
  //
  // The loop re-groups after every step because separating one pair can move a
  // row into collision with a third; it stops when nothing collides or when no
  // step made progress. A pair that survives all of it is genuinely two rows
  // identical in every field, which no label composition can separate; the
  // tooltip and the Agent memory view are where that goes.
  //
  // This is the same rule `shortScopeNames` applies to prefixes, one level up,
  // and it is reachable in ordinary use: one scope worked on from two machines
  // whose two ages round to the same words is not exotic, it is a handoff.
  for (let pass = 0; pass < AGE_PRECISIONS.length + 2; pass++) {
    const groups = new Map();
    shownWithAge.forEach(({ s, age }, i) => {
      const l = composeLabel(s, age, provenances[i], precisions[i]);
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(i);
    });
    const colliding = [...groups.values()].filter((g) => g.length > 1);
    if (!colliding.length) break;

    let progressed = false;
    for (const idxs of colliding) {
      const oneComputer = new Set(idxs.map((i) => machineKey(shown[i]))).size === 1;
      if (oneComputer) {
        const next = AGE_PRECISIONS[AGE_PRECISIONS.indexOf(precisions[idxs[0]]) + 1];
        if (next !== undefined) {
          for (const i of idxs) precisions[i] = next;
          progressed = true;
          continue;
        }
        // Escalation exhausted: these rows are the same computer saving twice
        // inside one minute. The finer age bought nothing, so it is HANDED
        // BACK before falling through — leaving a row reading "60 min ago"
        // when "1 hr ago" is what every other row says, and when the thing
        // that actually separates them is about to be the folder name, would
        // be paying width for a distinction that failed.
        for (const i of idxs) precisions[i] = null;
      }
      const machines = new Set(idxs.map((i) => str(shown[i].machine)));
      for (const i of idxs) {
        if (provenances[i] !== null) continue;
        provenances[i] = machines.size > 1
          ? machineOf(shown[i])
          : (str(shown[i].harness) || 'unknown harness');
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  const rows = shownWithAge.map(({ s, age }, idx) => {
    const project = str(s.project) || '(unnamed)';
    const scope = str(s.scope) || '(unnamed)';
    const source = s.ageSource === 'file' ? 'file' : (s.ageSource === 'agent' ? 'agent' : null);
    const isThisMachine = s.isThisMachine === true;

    // ── THE ONE SLOT WITH TWO MEANINGS ──────────────────────────────────
    //
    // On a row written by THIS machine, show the HARNESS. On a row written by
    // ANOTHER machine, show the MACHINE.
    //
    // Checked against the contract's own fields rather than inherited from the
    // research, and it holds: on a local row `machine` is constant across every
    // row and therefore carries no information, while `harness` is the thing
    // that differs when two agent tools are running side by side. The moment a
    // row is remote that inverts completely — the machine IS the news ("the
    // other computer did this"), and which harness is running over there is
    // somebody else's business. One slot, and in each context it holds the
    // interesting fact.
    //
    // `isThisMachine` is read STRICTLY: anything other than a literal `true` is
    // treated as remote, so an absent field shows the machine name. That is the
    // safe direction — a machine name is never WRONG, only redundant, whereas a
    // harness label on a row from another computer implies that harness is
    // running here.
    //
    // ── AND WHEN THE SLOT IS EMPTY, THAT IS ALSO A READING ──────────────
    //
    // The harness token is dropped from a LOCAL row when every local row
    // carries the same one (see `dropHarness` above). A MACHINE token is never
    // dropped: `isThisMachine === false` is the whole reason that row needs a
    // provenance at all, and dropping it would make a handoff from another
    // computer indistinguishable from one written here.
    //
    // The result is that a row showing no provenance is a row from HERE, and a
    // row showing a machine name is a row from THERE — which is more legible
    // than the same fact spelled out on every line, and it degrades safely:
    // the moment a second harness appears, every local row says which.
    const harness = str(s.harness);
    const machineShort = machineLabels.get(s.machine) || str(s.machine);
    const provenance = provenances[idx];

    const scopeShort = scopeLabels.get(scope) || scope;

    return {
      id: 'tray-row-' + idx,
      project,
      scope,
      machine: str(s.machine),
      machineShort,
      harness,
      isThisMachine,
      harnessShared: s.harnessShared === true,
      bucket: ageBucket(age),
      ageSeconds: age,
      ageSource: source,
      agePrecision: precisions[idx],
      ageText: ageText(age, source, precisions[idx]),
      headline: clip(s.headline, MAX_HEADLINE_CHARS),
      writtenAt: str(s.writtenAt),
      // What a row SAYS. Identity, provenance and age on the label; the
      // agent's own sentence on the sublabel (macOS renders it as a second
      // line, and a platform that does not simply drops it — which is why the
      // essential facts are on the LABEL and never only on the sublabel).
      scopeShort,
      showsProject: showProject,
      showsProvenance: provenance !== null,
      label: composeLabel(s, age, provenance, precisions[idx]),
      sublabel: clip(s.headline, MAX_HEADLINE_CHARS),
      // The tooltip is where the precise facts go — the ones that are true but
      // too long for a row, including BOTH clocks when they disagree.
      toolTip: [
        project + ' · ' + scope,
        s.machine ? 'machine: ' + s.machine : null,
        harness ? 'harness: ' + harness : null,
        source === 'agent' && str(s.writtenAt) ? 'written: ' + str(s.writtenAt) : null,
        source === 'file'
          ? 'this age is the file timestamp on this disk, which git rewrites on checkout, not the agent’s clock'
          : null,
        age === null ? 'no save time is recorded for this scope' : null,
      ].filter(Boolean).join('\n'),
    };
  });

  // ── The headline answer, and it is the FIRST thing in the menu ───────────
  //
  // The maintainer's stated need is: "when I'm approaching the end of the
  // context window I'm always wondering if we have updated the scope". So the
  // top of the menu answers WHEN THE LAST SAVE HAPPENED, in one line, before
  // anything else.
  //
  // `lastSave` is preferred because the data layer computes it. `rows[0]` is
  // the fallback, because a summary that lists scopes but no `lastSave` still
  // knows perfectly well when the newest one was written, and refusing to say
  // so would be manufacturing an absence rather than reporting one.
  //
  // This is the line the measured symptom was on: driving the real function
  // over ONE snapshot with `now` forty minutes apart produced the identical
  // "Last save · 4 min ago" both times while `renderedAtText` moved. It is
  // re-derived from `lastSave.writtenAt` for the same reason the rows are.
  const ls = summary && typeof summary.lastSave === 'object' && summary.lastSave ? summary.lastSave : null;
  const lsAge = ls ? effectiveAgeSeconds(str(ls.writtenAt), num(ls.writtenAgeSeconds), nowMs) : null;
  const lsSource = ls && ls.ageSource === 'file' ? 'file' : (ls && ls.ageSource === 'agent' ? 'agent' : null);

  // The "where" line is compacted by the SAME rules as the rows it sits above,
  // so the two cannot disagree about what a scope is called. `whereText` is
  // the compacted form; `whereFull` is kept beside it so the tooltip and any
  // later surface still has the unshortened truth.
  const whereOf = (proj, scp) => {
    const p = str(proj), c = str(scp);
    if (!p && !c) return { text: null, full: null };
    const short = c ? (scopeLabels.get(c) || c) : null;
    return {
      text: [showProject ? p : null, short].filter(Boolean).join(' · ') || null,
      full: [p, c].filter(Boolean).join(' · ') || null,
    };
  };

  let headline;
  if (ls && lsAge !== null) {
    const w = whereOf(ls.project, ls.scope);
    headline = {
      known: true,
      ageSeconds: lsAge,
      ageSource: lsSource,
      text: 'Last save · ' + ageText(lsAge, lsSource),
      where: w.text,
      whereFull: w.full,
      bucket: ageBucket(lsAge),
    };
  } else if (rows.length && rows[0].ageSeconds !== null) {
    const r = rows[0];
    const w = whereOf(r.project, r.scope);
    headline = {
      known: true,
      ageSeconds: r.ageSeconds,
      ageSource: r.ageSource,
      text: 'Last save · ' + r.ageText,
      where: w.text,
      whereFull: w.full,
      bucket: r.bucket,
    };
  } else if (rows.length) {
    const w = whereOf(rows[0].project, rows[0].scope);
    headline = {
      known: false, ageSeconds: null, ageSource: null,
      // NOT "just now", and not a blank. The menu says out loud that it does
      // not know, which is a different sentence from "nothing has been saved".
      text: 'Last save · time unknown',
      where: w.text,
      whereFull: w.full,
      bucket: 'unknown',
    };
  } else {
    headline = {
      known: false, ageSeconds: null, ageSource: null,
      // The empty state is the FIRST thing a new user sees and it must not
      // read like an error. A failed read is a different sentence again.
      text: ok ? 'No agent memory yet' : 'Agent memory could not be read',
      where: null,
      bucket: 'unknown',
    };
  }

  // A CAP IS DISCLOSED, NEVER PRESENTED AS A MEASUREMENT. `total` is the true
  // count when the data layer supplies one; `all.length` is what we can see.
  //
  // Computed BEFORE the notices, because the notice block has to know whether
  // the cap is already disclosed here in order not to disclose it twice.
  const total = num(summary && summary.total);
  const hidden = (total !== null ? total : all.length) - rows.length;
  const truncatedNote = hidden > 0 ? '…and ' + hidden + ' more in Agent memory' : null;

  const deduped = dedupeAgainstSuppliedWarnings(
    readWarnings(summary), collisionNotices(rows), truncatedNote !== null);

  const notices = [];
  const remote = remoteNotice(summary && summary.remote);
  if (remote) notices.push(remote);
  notices.push(...deduped.derived);
  // A last-resort net on the TEXT, kept for warnings that carry no code at all
  // (main.js pushes bare strings on its own failure paths). It is a backstop
  // and never the mechanism — see dedupeAgainstSuppliedWarnings for why the
  // mechanism must be structural.
  const seenText = new Set(notices.map((n) => n.text));
  for (const w of deduped.supplied) {
    if (seenText.has(w.message)) continue;
    seenText.add(w.message);
    notices.push({ kind: 'warning', code: w.code, text: clip(w.message, 96) || w.message });
  }

  // ── The standing brief — TIER C, and it lives in the tooltip ────────────
  //
  // The data layer pays one `stat` for this on every read. Nothing rendered
  // it, which is the unwired-field shape this project has an allergy to; the
  // choice was to stop computing it or to give it a surface, and the argument
  // for a surface is in `trayToolTip`. Its age is re-derived from `updatedAt`
  // for exactly the reason the rows' ages are.
  const rawBrief = summary && typeof summary.brief === 'object' && summary.brief ? summary.brief : null;
  const briefAge = rawBrief
    ? effectiveAgeSeconds(str(rawBrief.updatedAt), num(rawBrief.ageSeconds), nowMs)
    : null;
  const brief = rawBrief ? {
    project: str(rawBrief.project),
    ageSeconds: briefAge,
    // There is only ONE clock for a brief — it is hand-authored and no MCP
    // tool writes it, so mtime is all there is and the store emits no
    // `ageSource`. `ageText(age, null)` is therefore the unqualified form,
    // which is correct: there is no second clock to be honest between.
    ageText: ageText(briefAge, null),
  } : null;

  // ── The pulse ───────────────────────────────────────────────────────────
  //
  // A picture of when saves happened, drawn as a template PNG and carried on
  // ONE menu item near the top. The whole argument for it being a still frame
  // in an icon gutter — rather than the live multi-band graph iStat Menus
  // draws — is in `lib/pulse-strip.js`; the short version is that
  // `NSMenuItem.setView:` does not exist in Electron and an NSMenu is frozen
  // once open regardless.
  //
  // `null` when the data layer supplied no pulse, so the menu simply has no
  // strip item rather than an item carrying a blank rectangle. The producer is
  // free not to compute one and nothing here degrades.
  const rawPulse = summary && typeof summary.pulse === 'object' && summary.pulse
    ? summary.pulse : null;
  const strip = renderPulseStrip(rawPulse);
  const pulse = strip ? {
    strip,
    label: pulseLabel(rawPulse),
    toolTip: pulseToolTip(rawPulse),
  } : null;

  return {
    ok,
    empty: rows.length === 0,
    headline,
    pulse,
    rows,
    notices: notices.slice(0, MAX_NOTICES),
    noticesHidden: Math.max(0, notices.length - MAX_NOTICES),
    truncatedNote,
    brief,
    // ── THE GLYPH CARRIES AT MOST ONE BIT BEYOND PRESENCE ───────────────
    //
    // `live` = an agent has written ON THIS MACHINE in the last two minutes.
    // Remote rows are excluded deliberately: a pulled handoff is not an agent
    // at work here, and the glyph is a LOCAL instrument — the remote question
    // needs the network, and putting it in the bar would mean a background
    // network timer for one bit of tray state.
    glyph: rows.some((r) => r.isThisMachine && r.bucket === 'live') ? 'live' : 'idle',
    // The freshness stamp for the footer. Absolute, so it cannot rot into a
    // lie the way a relative one does.
    renderedAt: now.toISOString(),
    renderedAtText: clockText(now),
  };
}

/**
 * How long until the model's `glyph` would change on its own, in ms — or null
 * if it would not.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A POLL ──────────────────────────────
 *
 * The glyph is visible all the time, so `live` has to become `idle` two
 * minutes after the last local save even though NOTHING HAPPENS ON DISK at
 * that moment. The two obvious implementations are both wrong: a repeating
 * tick burns a wake-up forever for a bit that changes a few times an hour, and
 * leaving it alone means a glyph claiming an agent is working hours after one
 * stopped.
 *
 * So main.js arms ONE `setTimeout` at exactly this boundary, armed only while
 * the glyph is `live`, firing at most once per save and doing NO I/O when it
 * fires — it re-renders from the snapshot already in memory. That is a
 * scheduled correction, not a poll: when the glyph is `idle` there is no timer
 * at all, which is the state the process is in almost all of the time.
 */
export function liveExpiresInMs(model) {
  if (!model || model.glyph !== 'live' || !Array.isArray(model.rows)) return null;
  const ages = model.rows
    .filter((r) => r.isThisMachine && r.bucket === 'live' && typeof r.ageSeconds === 'number')
    .map((r) => r.ageSeconds);
  if (!ages.length) return null;
  const youngest = Math.min(...ages);
  // +1s so the timer fires just PAST the boundary rather than on it, where a
  // rounding difference could re-render with the bucket unchanged and re-arm a
  // zero-length timer in a loop.
  return Math.max(1000, Math.round((LIVE_WINDOW_SECONDS - youngest + 1) * 1000));
}
