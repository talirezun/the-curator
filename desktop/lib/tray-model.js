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
 */

// ── Caps ────────────────────────────────────────────────────────────────────
//
// Eight rows: roughly what fits above the fold of a menubar menu without the
// menu becoming a window. It is also a CAP, so it is disclosed — a cap must
// never read as a measurement (v3.17.0). See `truncatedNote`.
export const MAX_ROWS = 8;

/** Headlines are the agent's own prose and can run long; a menu item that is
 *  400px wide pushes everything else off the screen. Truncation is visible
 *  (an ellipsis) rather than silent. */
export const MAX_HEADLINE_CHARS = 72;

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
 * Relative age from a whole-second count.
 *
 * A VERBATIM COPY of `formatAge` in `src/public/next/views/memory.js`, and the
 * duplication is deliberate: that module registers a view and touches the DOM
 * at import time, so it cannot be imported here. Two functions rendering
 * "4 min ago" differently is the smallest possible version of the
 * two-surfaces-drift problem, so the suite does not merely diff the text — it
 * extracts the real one, evaluates it, and asserts both agree on a matrix that
 * crosses every boundary in the ladder.
 *
 * A null/absent age is NOT rendered as "0s ago". Callers get null and render
 * their own words.
 */
export function formatAge(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return 'just now';
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
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
export function ageText(ageSeconds, ageSource) {
  const rel = formatAge(ageSeconds);
  if (rel === null) return 'time unknown';
  return ageSource === 'file' ? 'changed ' + rel : rel;
}

/**
 * The recency bucket. Discrete states on a log-ish scale, NOT a bar: age is
 * unbounded, so any bar maximum would be invented and the bar's fullness would
 * be a fiction.
 *
 * Keyed on the age the caller hands it, which the model always takes from
 * `writtenAgeSeconds` — the agent's clock — precisely so that a `git pull`
 * cannot turn every incoming scope Live.
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
 * row. A supplied warning that already names the same scope suppresses the
 * derived one, so the two sources cannot both speak about one scope.
 */
function collisionNotices(rows, suppliedWarnings) {
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.harnessShared !== true) continue;
    const key = r.project + ' ' + r.scope;
    if (seen.has(key)) continue;
    seen.add(key);
    const already = suppliedWarnings.some((w) =>
      /harness/i.test(w) && w.includes(r.project) && w.includes(r.scope));
    if (already) continue;
    out.push({ kind: 'collision', text: 'Two harnesses are writing ' + r.project + ' · ' + r.scope });
  }
  return out;
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

  const ok = !!(summary && summary.ok !== false);
  const all = readScopes(summary);

  // NEWEST FIRST, and the sort key is the AGENT'S clock where there is one.
  //
  // Sorting on mtime would put every freshly-pulled remote handoff at the top
  // of the list regardless of when it was written — the same defect as the
  // recency bucket, one layer up. Rows with no age at all sort LAST: they
  // cannot be placed truthfully anywhere else, and putting an unknown at the
  // top would be asserting it is the newest.
  const withAge = all.map((s, i) => ({ s, i, age: num(s.writtenAgeSeconds) }));
  withAge.sort((a, b) => {
    if (a.age === null && b.age === null) return a.i - b.i;
    if (a.age === null) return 1;
    if (b.age === null) return -1;
    if (a.age !== b.age) return a.age - b.age;
    return a.i - b.i;
  });

  const shown = withAge.slice(0, maxRows).map((x) => x.s);
  const machineLabels = shortMachineNames(shown.map((s) => s.machine));

  const rows = shown.map((s, idx) => {
    const project = str(s.project) || '(unnamed)';
    const scope = str(s.scope) || '(unnamed)';
    const age = num(s.writtenAgeSeconds);
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
    const harness = str(s.harness);
    const machineShort = machineLabels.get(s.machine) || str(s.machine);
    const provenance = isThisMachine
      ? (harness || 'unknown harness')
      : (machineShort || 'unknown machine');

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
      ageText: ageText(age, source),
      headline: clip(s.headline, MAX_HEADLINE_CHARS),
      writtenAt: str(s.writtenAt),
      // What a row SAYS. Identity, provenance and age on the label; the
      // agent's own sentence on the sublabel (macOS renders it as a second
      // line, and a platform that does not simply drops it — which is why the
      // essential facts are on the LABEL and never only on the sublabel).
      label: project + ' · ' + scope + ' — ' + provenance + ' · ' + ageText(age, source),
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
  const ls = summary && typeof summary.lastSave === 'object' && summary.lastSave ? summary.lastSave : null;
  const lsAge = ls ? num(ls.writtenAgeSeconds) : null;
  const lsSource = ls && ls.ageSource === 'file' ? 'file' : (ls && ls.ageSource === 'agent' ? 'agent' : null);

  let headline;
  if (ls && lsAge !== null) {
    headline = {
      known: true,
      ageSeconds: lsAge,
      ageSource: lsSource,
      text: 'Last save · ' + ageText(lsAge, lsSource),
      where: [str(ls.project), str(ls.scope)].filter(Boolean).join(' · ') || null,
      bucket: ageBucket(lsAge),
    };
  } else if (rows.length && rows[0].ageSeconds !== null) {
    const r = rows[0];
    headline = {
      known: true,
      ageSeconds: r.ageSeconds,
      ageSource: r.ageSource,
      text: 'Last save · ' + r.ageText,
      where: r.project + ' · ' + r.scope,
      bucket: r.bucket,
    };
  } else if (rows.length) {
    headline = {
      known: false, ageSeconds: null, ageSource: null,
      // NOT "just now", and not a blank. The menu says out loud that it does
      // not know, which is a different sentence from "nothing has been saved".
      text: 'Last save · time unknown',
      where: rows[0].project + ' · ' + rows[0].scope,
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

  const suppliedWarnings = (summary && Array.isArray(summary.warnings) ? summary.warnings : [])
    .map((w) => (typeof w === 'string' ? w : (w && typeof w.message === 'string' ? w.message : null)))
    .filter((w) => typeof w === 'string' && w.trim())
    .map((w) => w.trim());

  const notices = [];
  const remote = remoteNotice(summary && summary.remote);
  if (remote) notices.push(remote);
  notices.push(...collisionNotices(rows, suppliedWarnings));
  const seenText = new Set(notices.map((n) => n.text));
  for (const w of suppliedWarnings) {
    if (seenText.has(w)) continue;
    seenText.add(w);
    notices.push({ kind: 'warning', text: clip(w, 96) || w });
  }

  // A CAP IS DISCLOSED, NEVER PRESENTED AS A MEASUREMENT. `total` is the true
  // count when the data layer supplies one; `all.length` is what we can see.
  const total = num(summary && summary.total);
  const hidden = (total !== null ? total : all.length) - rows.length;

  return {
    ok,
    empty: rows.length === 0,
    headline,
    rows,
    notices: notices.slice(0, MAX_NOTICES),
    noticesHidden: Math.max(0, notices.length - MAX_NOTICES),
    truncatedNote: hidden > 0 ? '…and ' + hidden + ' more in Agent memory' : null,
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
