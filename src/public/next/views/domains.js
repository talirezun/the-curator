// View: Domains — "your brain". Lists the compounding wikis and hosts the
// Health panel for whichever domain is selected (design spec screens 2 + 3).
//
// Owns views/domains.css. Backend is 100% pre-existing (see the module's
// own fetch helpers below for the exact endpoints) — this file adds no new
// server-side capability, only wiring + presentation.
//
// Data flow: onEnter -> fetchDomainsStats() -> renderSidebar() (rows) and,
// for whichever domain is active, loadHealth(slug) -> scanWiki report ->
// renderMain() (stat cards + health card). The brokenLinks/orphans AI cost
// estimates are fetched (free — they never call an LLM) alongside the
// scan, but ONLY when the scan already found that category's issues, so
// the Quick maintenance buttons can show their cost inline, per the
// design's hard cost-before-action rule.
//
// The semantic-duplicate estimate is the one exception, fetched ON DEMAND
// instead (see confirmSemanticScan) — it costs no tokens either, but
// unlike the other two it can't be gated on a known issue count (nothing
// short of running it knows how many candidate pairs exist), so computing
// it means a real pairwise-similarity pass over every page in the domain.
// Measured on a 3,251-page domain: ~14.9s of UNBROKEN event-loop block —
// every other request, any in-flight ingest SSE stream, and MCP write-
// registry coordination froze for that long. Auto-firing it here (as it
// used to) meant that ~15s hit on every Domains open and every domain
// switch; it now only runs when the user actually opens that specific
// quick-maintenance action.

import {
  registerView, setSidebar, setMain, eyebrow, emptyCard, icon, escapeHtml, navigate, isCurrentMount,
  reportAsyncMountFailure, reportAsyncActionFailure,
} from '../app.js';

// The icon set this view needs (activity, sparkles, chevron-right,
// alert-circle, lock, check) lives in app.js's shared ICON_BODY — see
// icon() below — there is no view-local icon table.

// ── Domain identity colour ────────────────────────────────────────────────
// Domains aren't typed like pages (no entity/concept/summary triad), but
// the design still gives each one a stable colour dot in the sidebar list
// and header. No backend field carries a per-domain colour, so this is a
// small fixed palette assigned by stable list position. Deliberately
// excludes brand violet (reserved for identity/action per the design's
// "violet means action and nothing else" rule) even though the design
// bundle's OWN placeholder DOMAINS array uses a violet dot for one entry —
// treated here as a placeholder-data inconsistency, not a rule to copy.
const DOMAIN_DOT_PALETTE = ['#3FBFD8', '#79C752', '#E0A33A', '#2FB88A', '#F87F8D', '#A8A8BC'];
function domainDotColor(index) {
  return DOMAIN_DOT_PALETTE[index % DOMAIN_DOT_PALETTE.length];
}

// ── Health category definitions ───────────────────────────────────────────
// Order matches the design's chip row. `violet: true` marks the one
// exception to "non-zero chips are amber" — the spec calls out orphans
// specifically getting a violet tint when non-zero.
const HEALTH_CATEGORIES = [
  { key: 'brokenLinks', label: 'Broken links' },
  { key: 'orphans', label: 'Orphan pages', violet: true },
  { key: 'crossFolderDupes', label: 'Cross-folder duplicates' },
  { key: 'hyphenVariants', label: 'Hyphen variants' },
  { key: 'folderPrefixLinks', label: 'Folder-prefix links' },
  { key: 'missingBacklinks', label: 'Missing backlinks' },
];
// Auto-fixable types (mirrors src/brain/health.js AUTO_FIXABLE minus the
// pseudo-types orphanLink/semanticDupe, which scanWiki never emits).
const AUTO_FIX_TYPES = new Set(['brokenLinks', 'folderPrefixLinks', 'crossFolderDupes', 'hyphenVariants', 'missingBacklinks']);
// Per the shipping app's invariant, Dismiss appears ONLY on review-only
// rows — auto-fixable issues get "Fix", never "skip". renderIssueRow's
// `dismissible` flag is set true only for orphans and for brokenLinks rows
// that have no suggestedTarget (the only two review-only shapes scanWiki
// emits); every other type stays un-dismissible by construction.

// ── Module state ───────────────────────────────────────────────────────────
// Kept at module scope (not reset on every onEnter) so switching away to
// another view and back preserves which domain was open — matches how
// app.js's own `state` persists across navigate() calls.
const state = {
  loaded: false,
  loadError: null,
  domains: [],            // raw stats rows from /api/domains/stats, in list order
  readonlySet: new Set(),
  activeSlug: null,

  health: null,           // scanWiki() report for activeSlug, or null
  healthLoading: false,
  healthError: null,
  healthSummary: {},      // slug -> total open issue count, populated as each domain is scanned (sidebar attention dot source — see report)

  aiAvailable: false,
  aiProvider: null,
  aiModel: null,
  estimates: {},          // 'brokenLinks' | 'orphans' | 'semanticDupes' -> result object | 'loading' | 'error'

  expandedGroups: new Set(),   // category keys (+ 'dismissed') currently expanded
  dismissedRecords: null,      // lazily loaded full dismissal list for the active domain

  confirm: null,          // { title, body, confirmLabel, run }
  busyKey: null,          // action key currently in flight, or null
  progressText: null,     // present-participle status line while busy
  banner: null,           // { tone: 'success'|'error'|'info', text }

  pendingPlan: null,      // { kind: 'brokenLinks'|'orphans', plan, summary }
  semanticScan: null,     // { pairs, cost } once a semantic-dupe scan has completed
};

// `state` above is DELIBERATELY module-scoped and NOT reset on every
// onEnter (so leaving Domains and coming back preserves which domain was
// open), which means none of the "did the user switch domain?" checks
// already in this file (the `slug !== state.activeSlug` guards below) catch
// the case that actually broke: the user leaves the DOMAINS VIEW entirely
// for another view while a fetch is in flight. `state.activeSlug` doesn't
// change just because the view unmounted, so those existing guards stayed
// satisfied and a stale response clobbered whatever the new view had
// already painted — reproduced by opening Domains, immediately clicking
// Chat, and watching the health scan (or the ~15s semantic-dupe estimate,
// see H4) land on top of Chat a moment later.
//
// H1 re-audit fix: this variable is `myMountToken` and every guard in this
// file used to read it LIVE (`isCurrentMount(myMountToken)`), including
// from inside functions resuming after an await — which is exactly the bug
// this comment used to claim was closed and wasn't. `myMountToken` gets
// OVERWRITTEN by the next mount (including a re-entry into Domains itself),
// so a function that reads it late, after its own await, sees whatever the
// LATEST mount wrote, not the mount it actually started under. Every async
// function below now captures its own token as a local variable at entry
// (before any await) — from onEnter's parameter for the top-level
// loadDomainsList(), or from this variable for anything invoked
// SYNCHRONOUSLY by a real click (safe: nothing can re-mount between a click
// firing and the very next line of JS running) — and threads that local
// through to every render call and nested async call it makes, rather than
// re-deriving it later. Every other same-view raciness guard in this file
// (slug comparisons, `state.dismissedRecords = null` resets, etc.) is
// unrelated and stays exactly as it was.
let myMountToken = 0;

// MEDIUM-5 fix (re-audit): tracks domains with a destructive WRITE
// genuinely in flight against the real backend. Deliberately survives this
// view's teardown — `busyKey` is reset there (see the M2 fix on
// registerView below) so a fresh mount's buttons aren't stuck disabled
// just because the user navigated away mid-action, but the underlying
// fetch/SSE stream doesn't stop just because the UI stopped watching it.
// Without this, navigating away during "Fix all safe" and back rendered
// every quick-maintenance button on that domain fully enabled while the
// original write was still hitting disk — a second click started a
// genuinely concurrent SECOND write (the backend's write-registry 409s
// it, so nothing corrupts, but the user just sees a confusing error
// instead of "one is already running, please wait"). Keyed by domain slug
// so a write in flight on domain A never disables domain B's own actions.
const inFlightWriteSlugs = new Set();

// ── Fetch helpers ──────────────────────────────────────────────────────────

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page etc. */ }
  if (!res.ok) {
    const msg = (body && body.error) || ('Request failed (' + res.status + ')');
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Minimal SSE-over-POST reader. The server writes `event: <type>\ndata:
// <json>\n\n` frames (see src/routes/health.js); this parses the raw
// stream without any library. onEvent(type, payload) fires per frame.
async function streamSSE(url, body, onEvent) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok || !res.body) {
    let msg = 'Request failed (' + res.status + ')';
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // NIT fix (re-audit, third round): every caller's `onEvent` deliberately
  // throws on an `error` frame (`if (type === 'error') throw new Error(...)`)
  // to signal a failure back to streamSSE's own caller — but that throw
  // used to propagate straight out of this function with the reader
  // neither cancelled nor released, leaving the stream lock (and, until
  // GC, the underlying connection) held open longer than necessary.
  // `try/finally` covers BOTH exit paths — the throw, and normal
  // completion via `done` — with one `cancel()` call; cancelling an
  // already-closed reader is a harmless no-op per spec.
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let type = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        onEvent(parsed.type || type, parsed);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function formatUsd(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(2);
}

function relTime(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + (min === 1 ? ' minute ago' : ' minutes ago');
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + (hr === 1 ? ' hour ago' : ' hours ago');
  const day = Math.floor(hr / 24);
  return day + (day === 1 ? ' day ago' : ' days ago');
}

function pluralize(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

function countSafeFixable(report) {
  if (!report) return 0;
  const suggested = (report.brokenLinks || []).filter((i) => i.suggestedTarget).length;
  return suggested
    + (report.crossFolderDupes || []).length
    + (report.hyphenVariants || []).length
    + (report.folderPrefixLinks || []).length
    + (report.missingBacklinks || []).length;
}

function totalOpenIssues(report) {
  if (!report) return 0;
  let n = 0;
  for (const cat of HEALTH_CATEGORIES) n += (report[cat.key] || []).length;
  return n;
}

// ── Data loading ───────────────────────────────────────────────────────────

async function loadDomainsList(token) {
  state.loaded = false;
  state.loadError = null;
  render(token);
  try {
    const data = await fetchJSON('/api/domains/stats');
    if (!isCurrentMount(token)) return; // H1 fix
    state.domains = Array.isArray(data.domains) ? data.domains : [];
    state.readonlySet = new Set(data.readonlyDomains || []);
    if (!state.activeSlug || !state.domains.some((d) => d.slug === state.activeSlug)) {
      state.activeSlug = state.domains.length ? state.domains[0].slug : null;
    }
    state.loaded = true;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.loadError = err.message;
    state.loaded = true;
  }
  render(token);

  // AI availability is a free, local, no-network check — safe to fetch
  // every time the view mounts.
  try {
    const info = await fetchJSON('/api/health/ai-available');
    if (!isCurrentMount(token)) return;
    state.aiAvailable = !!info.available;
    state.aiProvider = info.provider || null;
    state.aiModel = info.model || null;
  } catch {
    if (!isCurrentMount(token)) return;
    state.aiAvailable = false;
  }

  if (!isCurrentMount(token)) return;
  if (state.activeSlug) await loadHealth(state.activeSlug, token);
  else render(token);
}

async function loadHealth(slug, token, opts) {
  const silent = !!(opts && opts.silent);
  if (!silent) { state.healthLoading = true; state.healthError = null; state.health = null; }
  state.estimates = {};
  state.pendingPlan = null;
  state.semanticScan = null;
  state.dismissedRecords = null;
  render(token);

  try {
    const report = await fetchJSON('/api/health/' + encodeURIComponent(slug));
    if (slug !== state.activeSlug || !isCurrentMount(token)) return; // user switched domains, or left the view, mid-fetch
    state.health = report;
    state.healthSummary[slug] = totalOpenIssues(report);
  } catch (err) {
    if (slug !== state.activeSlug || !isCurrentMount(token)) return;
    state.healthError = err.message;
  } finally {
    // LOW-6 fix (re-audit): unlike busyKey, `healthLoading` IS keyed to a
    // specific domain+mount's own scan — a stale response (wrong slug, or
    // this mount already abandoned) must not clear it, because a genuinely
    // in-flight CURRENT scan could still be running and relying on it
    // staying true until ITS OWN finally runs. An ungated reset here let an
    // old, abandoned loadHealth call silently turn off the "Scanning…"
    // indicator for a brand-new, still-running scan.
    if (slug === state.activeSlug && isCurrentMount(token)) state.healthLoading = false;
    render(token);
  }

  if (state.aiAvailable && state.health && slug === state.activeSlug && isCurrentMount(token)) {
    loadEstimates(slug, token).catch(reportAsyncActionFailure);
  }
}

async function loadEstimates(slug, token) {
  const jobs = [];
  if ((state.health.brokenLinks || []).length > 0) {
    jobs.push(['brokenLinks', '/api/health/' + encodeURIComponent(slug) + '/broken-links/estimate']);
  }
  if ((state.health.orphans || []).length > 0) {
    jobs.push(['orphans', '/api/health/' + encodeURIComponent(slug) + '/orphans/estimate']);
  }
  // H4 fix: the semantic-duplicate estimate used to be pushed here
  // unconditionally on every domain open/switch — see the file-header
  // comment above for why that's the expensive one. It's now fetched only
  // from confirmSemanticScan(), on demand, the first time the user opens
  // that specific quick-maintenance action.
  if (jobs.length === 0) return;

  for (const [key] of jobs) state.estimates[key] = 'loading';
  render(token);

  await Promise.all(jobs.map(async ([key, url]) => {
    try {
      const est = await fetchJSON(url);
      if (slug === state.activeSlug && isCurrentMount(token)) state.estimates[key] = est;
    } catch (err) {
      if (slug === state.activeSlug && isCurrentMount(token)) state.estimates[key] = { error: err.message };
    }
  }));
  if (slug === state.activeSlug && isCurrentMount(token)) render(token);
}

// ── Chat handoff ─────────────────────────────────────────────────────────
// "Ask this domain" / "New domain" both navigate to Chat, which owns scope
// selection and the first-run composer. There is no shared shell state for
// "the domain Chat should scope to" yet, so this writes a best-effort
// localStorage hint Chat MAY read on its own onEnter — it is not required
// to. See the final report for the shell function this should really be.
function requestChatScope(slug) {
  try { localStorage.setItem('curator-next-chat-scope-request', slug); } catch { /* private mode etc. */ }
  navigate('chat');
}
function requestChatFirstRun() {
  try { localStorage.setItem('curator-next-chat-first-run-request', '1'); } catch { /* ignore */ }
  navigate('chat');
}

// ── Sidebar ────────────────────────────────────────────────────────────────

function renderSidebar(token) {
  if (!isCurrentMount(token)) return;
  const newBtn =
    '<button class="btn btn-primary dm-new-btn" id="dm-new-domain-btn">' + icon('grid', 13) + ' New domain</button>';

  if (!state.loaded) {
    setSidebar('<div class="sidebar-title">Domains</div>' + newBtn + '<div class="sidebar-hint">Loading…</div>', token);
    bindNewDomainBtn();
    return;
  }
  if (state.loadError) {
    setSidebar(
      '<div class="sidebar-title">Domains</div>' + newBtn +
      '<div class="sidebar-hint dm-error-text">Could not load domains — ' + escapeHtml(state.loadError) + '</div>',
      token
    );
    bindNewDomainBtn();
    return;
  }
  if (state.domains.length === 0) {
    setSidebar(
      '<div class="sidebar-title">Domains</div>' + newBtn +
      '<div class="cur-eyebrow" style="margin-top:10px">KNOWLEDGE</div>' +
      '<div class="sidebar-note">No domains yet. A domain is one compounding wiki — create your first one from Chat.</div>',
      token
    );
    bindNewDomainBtn();
    return;
  }

  const rows = state.domains.map((d, i) => {
    const readonly = state.readonlySet.has(d.slug);
    const active = d.slug === state.activeSlug;
    const issueCount = state.healthSummary[d.slug];
    const attention = typeof issueCount === 'number' && issueCount > 0;
    // NIT fix: this used to always append the literal word " pages", so a
    // freshly-created domain with exactly one page read "1 pages" — Chat
    // gets this right everywhere else ("1 page in scope").
    const pagesText = typeof d.pageCount === 'number'
      ? d.pageCount.toLocaleString() + ' page' + (d.pageCount === 1 ? '' : 's')
      : '— pages';
    return (
      '<button class="dm-row' + (active ? ' active' : '') + '" data-domain-slug="' + escapeHtml(d.slug) + '">' +
        '<span class="dm-row-dot" style="background:' + domainDotColor(i) + '"></span>' +
        '<span class="dm-row-main">' +
          '<span class="dm-row-name">' + escapeHtml(d.displayName || d.slug) + '</span>' +
          '<span class="dm-row-meta mono">' + pagesText + '</span>' +
        '</span>' +
        (readonly ? '<span class="dm-row-mirror" title="Read-only Shared Brain mirror">RO</span>' : '') +
        (attention ? '<span class="dm-row-attn" title="' + issueCount + ' open health issue' + (issueCount === 1 ? '' : 's') + '"></span>' : '') +
      '</button>'
    );
  }).join('');

  setSidebar(
    '<div class="sidebar-title">Domains</div>' + newBtn +
    '<div class="cur-eyebrow" style="margin-top:10px">KNOWLEDGE</div>' +
    '<div class="dm-row-list">' + rows + '</div>',
    token
  );

  bindNewDomainBtn();
  document.querySelectorAll('.dm-row[data-domain-slug]').forEach((btn) => {
    btn.addEventListener('click', () => selectDomain(btn.dataset.domainSlug));
  });
}

function bindNewDomainBtn() {
  const btn = document.getElementById('dm-new-domain-btn');
  if (btn) btn.addEventListener('click', requestChatFirstRun);
}

// Entered synchronously by a click handler — reading myMountToken here is
// safe (see the doc comment on it above).
function selectDomain(slug) {
  if (slug === state.activeSlug) return;
  state.activeSlug = slug;
  state.confirm = null;
  state.banner = null;
  state.expandedGroups = new Set();
  render(myMountToken);
  loadHealth(slug, myMountToken).catch(reportAsyncActionFailure);
}

// ── Main column ────────────────────────────────────────────────────────────

function renderMain(token) {
  if (!isCurrentMount(token)) return;
  if (!state.loaded) {
    setMain(eyebrow('your brain') + '<h1 class="view-title">Domains</h1><div class="view-body">Loading…</div>', token);
    return;
  }
  if (state.loadError) {
    setMain(
      eyebrow('your brain') + '<h1 class="view-title">Domains</h1>' +
      emptyCard({ title: 'Could not load domains', body: escapeHtml(state.loadError) }),
      token
    );
    return;
  }
  if (state.domains.length === 0) {
    setMain(
      eyebrow('your brain') + '<h1 class="view-title">Domains</h1>' +
      '<div class="view-body">A domain is one compounding wiki — a subject you read about often. Everything ingested ' +
      'into it updates the pages already there, so the graph gets denser rather than just bigger.</div>' +
      emptyCard({
        title: 'No domains yet',
        body: 'Name your first domain from Chat and it sets up its schema. Nothing is written until you confirm.',
        actionHtml: '<button class="btn btn-primary" id="dm-empty-new-btn">' + icon('grid', 13) + ' New domain</button>',
      }),
      token
    );
    document.getElementById('dm-empty-new-btn')?.addEventListener('click', requestChatFirstRun);
    return;
  }

  const domain = state.domains.find((d) => d.slug === state.activeSlug);
  if (!domain) { setMain(eyebrow('your brain') + '<h1 class="view-title">Domains</h1>', token); return; }

  const readonly = state.readonlySet.has(domain.slug);
  // MEDIUM-2 fix (re-audit): `pageCounts.other` is a real, additive backend
  // field (files.js) — pages that don't fall under entities/concepts/
  // summaries (a stray root-level note, for example). `pageCount` is
  // DELIBERATELY the recursive total INCLUDING `other`, specifically so
  // the four numbers reconcile — files.js's own comment calls a renderer
  // that shows only three of the four "now the bug, and a visible one".
  // Reproduced before this fix: a domain with 1 stray note rendered
  // "A compounding wiki of 3 pages — 2 entities, 0 concepts, 0 summaries."
  // — a self-contradicting sentence (2 ≠ 3) with the remainder nowhere to
  // be found. `other` must never just be dropped; it's rendered as a
  // fourth stat card AND folded into the scope sentence (only when
  // non-zero, so the common all-zero case reads exactly as before).
  const counts = domain.pageCounts || { entities: 0, concepts: 0, summaries: 0, other: 0 };
  const otherCount = counts.other || 0;
  const pages = typeof domain.pageCount === 'number' ? domain.pageCount : (counts.entities + counts.concepts + counts.summaries + otherCount);

  const scopeSentence = readonly
    ? 'A read-only mirror of a Shared Brain — synthesised from every contributor’s opted-in pages. Fix issues in your personal contributing domain instead; changes made here are overwritten on the next Pull.'
    : ('A compounding wiki of ' + pluralize(pages, 'page') + ' — ' + pluralize(counts.entities, 'entity').replace('entitys', 'entities') +
       ', ' + pluralize(counts.concepts, 'concept') + ', ' + pluralize(counts.summaries, 'summary').replace('summarys', 'summaries') +
       (otherCount > 0 ? ', ' + pluralize(otherCount, 'other page') : '') + '.');

  const html =
    '<div class="dm-path-eyebrow mono">domains/' + escapeHtml(domain.slug) + '/</div>' +
    '<div class="dm-title-row">' +
      '<h1 class="view-title dm-title">' + escapeHtml(domain.displayName || domain.slug) + '</h1>' +
      (readonly ? '<span class="dm-mirror-pill">' + icon('lock', 11) + ' read-only mirror</span>' : '') +
      '<button class="btn btn-primary dm-ask-btn" id="dm-ask-btn">' + icon('messageSquare', 14) + ' Ask this domain</button>' +
    '</div>' +
    '<div class="view-body dm-scope-desc">' + escapeHtml(scopeSentence) + '</div>' +
    renderStatCards(counts, pages) +
    renderHealthPanel(domain, readonly) +
    renderRecentlyWritten();

  setMain(html, token);
  document.getElementById('dm-ask-btn')?.addEventListener('click', () => requestChatScope(domain.slug));
  bindHealthListeners(domain, readonly);
}

function renderStatCards(counts, pages) {
  const otherCount = counts.other || 0;
  return (
    '<div class="dm-stats-grid">' +
      '<div class="dm-stat-card"><div class="cur-eyebrow">PAGES</div><div class="dm-stat-value mono">' + pages.toLocaleString() + '</div></div>' +
      '<div class="dm-stat-card"><div class="cur-eyebrow">ENTITIES</div><div class="dm-stat-value mono dm-stat-entity">' + (counts.entities || 0).toLocaleString() + '</div></div>' +
      '<div class="dm-stat-card"><div class="cur-eyebrow">CONCEPTS</div><div class="dm-stat-value mono dm-stat-concept">' + (counts.concepts || 0).toLocaleString() + '</div></div>' +
      '<div class="dm-stat-card"><div class="cur-eyebrow">SUMMARIES</div><div class="dm-stat-value mono dm-stat-summary">' + (counts.summaries || 0).toLocaleString() + '</div></div>' +
      // MEDIUM-2 fix: shown only when non-zero, so the common case (every
      // page fits entities/concepts/summaries) renders identically to
      // before — but when `other` IS non-zero it is never just dropped
      // (see the caller's comment): a fifth stat card, same shape as the
      // other three, not a footnote.
      (otherCount > 0
        ? '<div class="dm-stat-card"><div class="cur-eyebrow">OTHER</div><div class="dm-stat-value mono dm-stat-other">' + otherCount.toLocaleString() + '</div></div>'
        : '') +
    '</div>'
  );
}

function renderRecentlyWritten() {
  // No lightweight "recent pages" endpoint exists — GET /api/wiki/:domain
  // returns full body content for every page in the domain (documented in
  // src/routes/wiki.js as "14 MB on the real articles domain"), which is
  // the wrong shape and cost for a sidebar-adjacent recency list. Rather
  // than pull that much data just to read mtimes, this is left an honest
  // placeholder — see the final report.
  return (
    '<div class="cur-eyebrow dm-recent-eyebrow">RECENTLY WRITTEN</div>' +
    '<div class="dm-recent-note">Not wired up in this phase — the only available endpoint returns full page ' +
    'content for the whole domain, too heavy for a recency list. A lightweight path+mtime endpoint would unlock this.</div>'
  );
}

// ── Health panel ───────────────────────────────────────────────────────────

function renderHealthPanel(domain, readonly) {
  if (state.healthLoading) {
    return (
      '<div class="dm-health-card">' +
        '<div class="dm-health-top"><div class="dm-health-head">' + icon('activity', 17) + '<span class="dm-health-title">Wiki health</span></div></div>' +
        '<div class="dm-health-body">Scanning…</div>' +
      '</div>'
    );
  }
  if (state.healthError) {
    return (
      '<div class="dm-health-card">' +
        '<div class="dm-health-top">' +
          '<div class="dm-health-head">' + icon('activity', 17) + '<span class="dm-health-title">Wiki health</span></div>' +
          '<button class="btn btn-secondary" id="dm-rescan-btn">' + icon('refresh', 13) + ' Rescan</button>' +
        '</div>' +
        '<div class="dm-health-body dm-error-text">Could not scan this domain — ' + escapeHtml(state.healthError) + '</div>' +
      '</div>'
    );
  }
  const report = state.health;
  if (!report) return '';

  const total = totalOpenIssues(report);
  const busy = state.busyKey;
  // MEDIUM-5 fix: a write against THIS domain started by an earlier,
  // already-abandoned mount that hasn't actually finished on disk yet.
  // Distinct from `busy` (this mount's OWN action, reset on unmount) —
  // this one tracks the real backend operation and survives remounts.
  const crossMountBusy = inFlightWriteSlugs.has(domain.slug);

  const chips = HEALTH_CATEGORIES.map((cat) => {
    const count = (report[cat.key] || []).length;
    const cls = count === 0 ? 'dm-chip-zero' : (cat.violet ? 'dm-chip-violet' : 'dm-chip-amber');
    return '<span class="dm-chip ' + cls + '">' + escapeHtml(cat.label) + ' <span class="mono dm-chip-count">' + count + '</span></span>';
  }).join('');

  const scanMeta =
    'Scanned ' + pluralize(report.counts.entities, 'entity').replace('entitys', 'entities') +
    ' · ' + pluralize(report.counts.concepts, 'concept') +
    ' · ' + pluralize(report.counts.summaries, 'summary').replace('summarys', 'summaries') +
    ' · ' + report.counts.dismissed + ' dismissed';

  return (
    '<div class="dm-health-card">' +
      '<div class="dm-health-top">' +
        '<div class="dm-health-head">' + icon('activity', 17) + '<span class="dm-health-title">Wiki health</span></div>' +
        '<button class="btn btn-secondary" id="dm-rescan-btn"' + (busy ? ' disabled' : '') + '>' +
          icon('refresh', 13) + ' ' + (busy === 'rescan' ? 'Scanning…' : 'Rescan') +
        '</button>' +
      '</div>' +
      '<div class="dm-health-body">Found ' + total + (total === 1 ? ' issue' : ' issues') + ', last scanned ' + relTime(report.scannedAt) +
        '. Structural repairs run locally and free; anything needing judgement stays review-only, and anything that spends tokens asks first.</div>' +
      '<div class="dm-health-meta mono">' + scanMeta + '</div>' +
      '<div class="dm-chip-row">' + chips + '</div>' +
      (state.banner ? renderBanner() : '') +
      (readonly ? renderMirrorNote() : renderQuickMaintenance(domain, report, crossMountBusy)) +
      (state.confirm ? renderConfirmCard() : '') +
      (state.pendingPlan ? renderPendingPlan(crossMountBusy) : '') +
      (state.semanticScan ? renderSemanticScanResult(readonly, crossMountBusy) : '') +
      renderIssueGroups(report, readonly, crossMountBusy) +
    '</div>'
  );
}

function renderBanner() {
  const b = state.banner;
  const cls = b.tone === 'error' ? 'dm-banner-error' : (b.tone === 'info' ? 'dm-banner-info' : 'dm-banner-success');
  const ic = b.tone === 'error' ? icon('alertCircle', 14) : icon('check', 14);
  return '<div class="dm-banner ' + cls + '">' + ic + '<span>' + escapeHtml(b.text) + '</span></div>';
}

function renderMirrorNote() {
  return (
    '<div class="dm-mirror-note">' + icon('lock', 13) +
    '<span>This domain is a read-only Shared Brain mirror. Fixes here would be overwritten on the next Pull — ' +
    'fix issues in your personal contributing domain, then push from Sync.</span></div>'
  );
}

function renderQuickMaintenance(domain, report, crossMountBusy) {
  const busy = state.busyKey;
  // MEDIUM-5 fix: disable every DESTRUCTIVE quick-maintenance button (not
  // just the read-only Rescan above) while an earlier, already-abandoned
  // mount's write against this SAME domain is still actually running.
  const disableAll = !!busy || crossMountBusy;
  const items = [];

  const safeTotal = countSafeFixable(report);
  if (safeTotal > 0) {
    items.push(
      '<button class="dm-quick-btn" data-action="fixSafe"' + (disableAll ? ' disabled' : '') + '>' +
        '<span class="dm-quick-label">' + (busy === 'fixSafe' ? 'Fixing…' : 'Fix ' + pluralize(safeTotal, 'safe issue')) + '</span>' +
      '</button>'
    );
  }

  if (state.aiAvailable) {
    const brokenCount = (report.brokenLinks || []).length;
    if (brokenCount > 0) items.push(quickAiButton('brokenLinks', 'Fix ' + pluralize(brokenCount, 'broken link'), busy, crossMountBusy));
    const orphanCount = (report.orphans || []).length;
    if (orphanCount > 0) items.push(quickAiButton('orphans', 'Rescue ' + pluralize(orphanCount, 'orphan'), busy, crossMountBusy));
    // H4 fix: always offered, unlike the two above — there's no free,
    // already-known count to gate this on (see the file-header comment on
    // loadEstimates). The button shows no cost until the user opens it;
    // confirmSemanticScan() fetches the (slow, but token-free) estimate at
    // that point and shows a "no likely duplicates" banner instead of a
    // confirm dialog if candidatePairs turns out to be 0.
    items.push(quickAiButton('semanticDupes', 'Find duplicate pages', busy, crossMountBusy));
  }

  if (items.length === 0) {
    if (!state.aiAvailable) {
      return (
        '<div class="dm-quick dm-quick-empty">' +
          '<span>No structural issues to fix right now. Add an AI provider key in Settings to unlock broken-link ' +
          'resolution, orphan rescue and duplicate-page detection.</span>' +
          '<button class="btn btn-secondary dm-quick-settings-btn" id="dm-open-settings-btn">Open Settings</button>' +
        '</div>'
      );
    }
    return '';
  }

  return (
    '<div class="dm-quick">' +
      '<div class="dm-quick-eyebrow cur-eyebrow">' + icon('sparkles', 12) + ' QUICK MAINTENANCE</div>' +
      '<div class="dm-quick-actions">' + items.join('') + '</div>' +
      // Wording nit found during live verification: `crossMountBusy` is
      // true for BOTH "some earlier, abandoned mount's write is still
      // running" AND "this exact mount's own action, which it just
      // started, is running" (inFlightWriteSlugs.add(slug) fires the
      // instant any write starts, including this mount's). Only call it
      // an EARLIER fix when it isn't also this mount's own busyKey —
      // otherwise a user who clicks Fix and never left the view sees
      // "an earlier fix is still running" about the very click they just
      // made, which reads as if something is already wrong.
      (crossMountBusy && !busy
        ? '<div class="dm-quick-note dm-quick-note-busy">' + icon('alertTriangle', 12) + ' An earlier fix on this domain is still running — please wait for it to finish before starting another.</div>'
        : '<div class="dm-quick-note">Every AI action shows its cost before it runs. All changes are git-tracked and revertable from Sync.</div>') +
    '</div>'
  );
}

function quickAiButton(key, label, busy, crossMountBusy) {
  const est = state.estimates[key];
  let costText = null;
  if (est === 'loading') costText = '…';
  else if (est && !est.error && typeof est.estimatedUsd === 'number') costText = formatUsd(est.estimatedUsd);
  const disabled = busy || crossMountBusy || est === 'loading' || (est && est.error);
  const label2 = (busy === key + 'Plan' || busy === key + 'Scan' || busy === key + 'Estimate') ? label + '…' : label;
  return (
    '<button class="dm-quick-btn dm-quick-btn-ai" data-action="' + key + '"' + (disabled ? ' disabled' : '') + '>' +
      icon('sparkles', 12) +
      '<span class="dm-quick-label">' + escapeHtml(label2) + '</span>' +
      (costText ? '<span class="mono dm-quick-cost">' + escapeHtml(costText) + '</span>' : '') +
    '</button>'
  );
}

function renderConfirmCard() {
  const c = state.confirm;
  return (
    '<div class="dm-confirm-card">' +
      '<div class="dm-confirm-title">' + escapeHtml(c.title) + '</div>' +
      '<div class="dm-confirm-body">' + escapeHtml(c.body) + '</div>' +
      '<div class="dm-confirm-actions">' +
        '<button class="btn btn-primary" id="dm-confirm-yes">' + escapeHtml(c.confirmLabel || 'Confirm') + '</button>' +
        '<button class="btn btn-secondary" id="dm-confirm-no">Cancel</button>' +
      '</div>' +
    '</div>'
  );
}

function renderPendingPlan(crossMountBusy) {
  const p = state.pendingPlan;
  const busy = state.busyKey || crossMountBusy;
  let summaryLine = '';
  let body = '';
  if (p.kind === 'brokenLinks') {
    const s = p.summary;
    summaryLine = pluralize(s.retarget, 'link') + ' will be repointed to an existing page, ' + pluralize(s.strip, 'link') + ' will have the brackets removed (no matching page found).';
    body = pluralize(s.retargetOccurrences, 'occurrence') + ' repointed, ' + pluralize(s.stripOccurrences, 'occurrence') + ' stripped, across the domain.';
  } else {
    const s = p.summary;
    summaryLine = pluralize(s.rescuable, 'orphan') + ' found a home; ' + pluralize(s.noHome, 'orphan') + ' left for manual review.';
    body = 'Each rescued orphan gets one new [[wikilink]] added to the page that should reference it.';
  }
  return (
    '<div class="dm-plan-card">' +
      '<div class="dm-plan-title">Plan ready — nothing written yet</div>' +
      '<div class="dm-plan-summary">' + escapeHtml(summaryLine) + '</div>' +
      '<div class="dm-plan-detail mono">' + escapeHtml(body) + '</div>' +
      '<div class="dm-plan-actions">' +
        '<button class="btn btn-primary" id="dm-plan-apply-btn"' + (busy ? ' disabled' : '') + '>' + (busy === p.kind + 'Apply' ? 'Applying…' : 'Apply this plan') + '</button>' +
        '<button class="btn btn-secondary" id="dm-plan-discard-btn"' + (busy ? ' disabled' : '') + '>Discard</button>' +
      '</div>' +
      (crossMountBusy ? '<div class="dm-plan-detail mono dm-quick-note-busy">An earlier operation on this domain is still running.</div>' : '') +
    '</div>'
  );
}

function renderSemanticScanResult(readonly, crossMountBusy) {
  const s = state.semanticScan;
  const busy = state.busyKey || crossMountBusy;
  const high = s.pairs.filter((p) => p.confidence === 'high');
  const rest = s.pairs.filter((p) => p.confidence !== 'high');
  if (s.pairs.length === 0) {
    return '<div class="dm-plan-card"><div class="dm-plan-title">No likely duplicates found</div></div>';
  }
  const rows = (list, actionable) => list.map((p) =>
    '<div class="dm-issue-row">' +
      '<span class="mono dm-issue-main">' + escapeHtml(p.keepFolder + '/' + p.keepSlug) + ' ← ' + escapeHtml(p.removeFolder + '/' + p.removeSlug) + '</span>' +
      '<span class="dm-issue-meta">' + escapeHtml(p.confidence) + (actionable ? '' : ' · review manually') + '</span>' +
    '</div>'
  ).join('');
  return (
    '<div class="dm-plan-card">' +
      '<div class="dm-plan-title">' + pluralize(s.pairs.length, 'candidate pair') + ' found</div>' +
      (high.length > 0 ? (
        '<div class="dm-plan-summary">' + pluralize(high.length, 'high-confidence pair') + ' can be merged automatically.</div>' +
        rows(high, true) +
        (readonly ? '' : (
          '<div class="dm-plan-actions">' +
            '<button class="btn btn-primary" id="dm-semantic-merge-btn"' + (busy ? ' disabled' : '') + '>' +
              (busy === 'semanticMerge' ? 'Merging…' : 'Merge ' + pluralize(high.length, 'high-confidence duplicate')) +
            '</button>' +
          '</div>'
        ))
      ) : '') +
      (rest.length > 0 ? ('<div class="dm-plan-detail mono">' + pluralize(rest.length, 'lower-confidence pair') + ' left for manual review:</div>' + rows(rest, false)) : '') +
    '</div>'
  );
}

function renderIssueGroups(report, readonly, crossMountBusy) {
  const groups = HEALTH_CATEGORIES.map((cat) => renderIssueGroup(cat, report[cat.key] || [], readonly, crossMountBusy)).join('');
  const dismissedGroup = renderDismissedGroup(report.counts.dismissed);
  return '<div class="dm-groups">' + groups + dismissedGroup + '</div>';
}

function renderIssueGroup(cat, issues, readonly, crossMountBusy) {
  if (issues.length === 0) return '';
  const open = state.expandedGroups.has(cat.key);
  const fixAllCount = cat.key === 'brokenLinks' ? issues.filter((i) => i.suggestedTarget).length : issues.length;
  const canFixAll = !readonly && AUTO_FIX_TYPES.has(cat.key) && fixAllCount > 0;
  const busy = state.busyKey === 'group:' + cat.key;
  // MEDIUM-5 fix: also disabled while ANY write against this domain is in
  // flight from an earlier mount — not just this specific category's own
  // busyKey — since a concurrent fix on a DIFFERENT category still hits
  // the same domain's files on disk and would still 409 against it.
  const disabled = busy || crossMountBusy;
  const rows = issues.slice(0, 50).map((issue) => renderIssueRow(cat.key, issue, readonly)).join('');
  const more = issues.length > 50 ? '<div class="dm-issue-more mono">…and ' + (issues.length - 50) + ' more</div>' : '';
  return (
    '<details class="dm-group"' + (open ? ' open' : '') + ' data-group-key="' + cat.key + '">' +
      '<summary class="dm-group-summary">' +
        icon('chevronRight', 13) +
        '<span class="dm-group-label">' + escapeHtml(cat.label) + '</span>' +
        '<span class="dm-group-pill mono">' + issues.length + '</span>' +
        (canFixAll && fixAllCount > 0 ? (
          '<button class="btn btn-secondary dm-group-fixall-btn" data-fixall="' + cat.key + '"' + (disabled ? ' disabled' : '') + '>' +
            (busy ? 'Fixing…' : 'Fix all ' + fixAllCount) +
          '</button>'
        ) : '') +
      '</summary>' +
      '<div class="dm-group-body">' + rows + more + '</div>' +
    '</details>'
  );
}

function renderIssueRow(type, issue, readonly) {
  let main = '';
  let meta = '';
  let dismissible = false;
  switch (type) {
    case 'brokenLinks':
      main = escapeHtml(issue.sourceFile) + ' → [[' + escapeHtml(issue.linkText) + ']]';
      if (issue.suggestedTarget) meta = 'suggests ' + escapeHtml(issue.suggestedTarget);
      else { meta = 'no suggestion'; dismissible = true; }
      break;
    case 'orphans':
      main = escapeHtml(issue.path);
      meta = escapeHtml(issue.type);
      dismissible = true;
      break;
    case 'crossFolderDupes':
      main = 'keep ' + escapeHtml(issue.keep) + ', remove ' + escapeHtml(issue.remove);
      break;
    case 'hyphenVariants':
      main = escapeHtml((issue.files || []).join(', '));
      meta = '→ ' + escapeHtml(issue.suggestedSlug || '');
      break;
    case 'folderPrefixLinks':
      main = escapeHtml(issue.sourceFile) + ' → [[' + escapeHtml(issue.linkText) + ']]';
      break;
    case 'missingBacklinks':
      main = escapeHtml(issue.summary) + ' ↔ ' + escapeHtml(issue.entity);
      break;
    default:
      // L7 fix: every other branch above escapes its interpolated fields;
      // this one didn't, and was unreachable until a 7th health category
      // is added — the moment that happens, this stops being defense in
      // depth and starts being the only thing standing between a scanned
      // page's own content and raw HTML injection into the issue row.
      main = escapeHtml(JSON.stringify(issue));
  }
  const canDismiss = !readonly && dismissible;
  return (
    '<div class="dm-issue-row">' +
      '<span class="mono dm-issue-main">' + main + '</span>' +
      '<span class="dm-issue-meta">' + meta + '</span>' +
      (canDismiss ? '<button class="btn btn-ghost dm-dismiss-btn" data-dismiss-type="' + type + '" data-dismiss-issue=\'' + escapeHtml(JSON.stringify(issue)) + '\'>Dismiss</button>' : '') +
    '</div>'
  );
}

function renderDismissedGroup(count) {
  if (!count) return '';
  const open = state.expandedGroups.has('dismissed');
  let body;
  if (!open) {
    body = '';
  } else if (state.dismissedRecords === null) {
    body = '<div class="dm-issue-row"><span class="dm-issue-meta">Loading…</span></div>';
  } else {
    body = state.dismissedRecords.map((r) => (
      '<div class="dm-issue-row">' +
        '<span class="mono dm-issue-main">' + escapeHtml(describeDismissed(r)) + '</span>' +
        '<button class="btn btn-ghost dm-restore-btn" data-restore-key=\'' + escapeHtml(JSON.stringify(r)) + '\'>Restore</button>' +
      '</div>'
    )).join('') || '<div class="dm-issue-row"><span class="dm-issue-meta">Nothing dismissed.</span></div>';
  }
  return (
    '<details class="dm-group dm-group-dismissed"' + (open ? ' open' : '') + ' data-group-key="dismissed">' +
      '<summary class="dm-group-summary">' +
        icon('chevronRight', 13) +
        '<span class="dm-group-label dm-dismissed-label">Dismissed</span>' +
        '<span class="dm-group-pill mono">' + count + '</span>' +
      '</summary>' +
      '<div class="dm-group-body">' + body + '</div>' +
    '</details>'
  );
}

function describeDismissed(r) {
  switch (r.type) {
    case 'brokenLinks': return r.sourceFile + ' → [[' + r.linkText + ']]';
    case 'orphans': return r.path;
    case 'crossFolderDupes': return 'keep ' + r.keep + ', remove ' + r.remove;
    case 'hyphenVariants': return (r.files || []).join(', ');
    case 'folderPrefixLinks': return r.sourceFile + ' → [[' + r.linkText + ']]';
    case 'missingBacklinks': return r.summary + ' ↔ ' + r.entity;
    case 'semanticDupe': return (r.slugs || []).join(' / ');
    default: return r.type;
  }
}

// ── Event wiring for the health card ───────────────────────────────────────

function bindHealthListeners(domain, readonly) {
  document.getElementById('dm-rescan-btn')?.addEventListener('click', () => rescan(domain.slug));
  document.getElementById('dm-open-settings-btn')?.addEventListener('click', () => navigate('settings'));

  // LOW-3 fix (re-audit, third round): these 5 dispatch sites are the
  // DESTRUCTIVE ones (fix/rescue/merge/apply) — exactly what
  // reportAsyncActionFailure exists for — and each one's target function
  // ends with an un-try-wrapped `render(token)` (or `await loadHealth`)
  // whose own throw would otherwise become a bare, unattributed "Uncaught
  // (in promise)". `Promise.resolve().then(() => fn()).catch(...)` is used
  // uniformly rather than `fn(...).catch(...)` directly because
  // mergeSemanticDuplicates is a plain SYNCHRONOUS function (it only sets
  // state.confirm and calls render()) — it returns `undefined`, and
  // `undefined.catch` would itself throw. Wrapping the call in `.then()`
  // defers it by one microtask (imperceptible; nothing else can run
  // in between) and converts either a synchronous throw OR a rejected
  // promise into the same caught path, so the same wrapper is correct
  // for both the sync and the async targets without special-casing either.
  document.querySelectorAll('.dm-quick-btn[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      Promise.resolve().then(() => onQuickAction(domain.slug, btn.dataset.action)).catch(reportAsyncActionFailure);
    });
  });

  document.getElementById('dm-confirm-yes')?.addEventListener('click', () => {
    const run = state.confirm && state.confirm.run;
    state.confirm = null;
    if (run) Promise.resolve().then(() => run()).catch(reportAsyncActionFailure);
  });
  document.getElementById('dm-confirm-no')?.addEventListener('click', () => { state.confirm = null; render(myMountToken); });

  document.getElementById('dm-plan-apply-btn')?.addEventListener('click', () => {
    Promise.resolve().then(() => applyPendingPlan(domain.slug)).catch(reportAsyncActionFailure);
  });
  document.getElementById('dm-plan-discard-btn')?.addEventListener('click', () => { state.pendingPlan = null; render(myMountToken); });

  document.getElementById('dm-semantic-merge-btn')?.addEventListener('click', () => {
    Promise.resolve().then(() => mergeSemanticDuplicates(domain.slug)).catch(reportAsyncActionFailure);
  });

  document.querySelectorAll('.dm-group-fixall-btn[data-fixall]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't toggle the <details> — see v3.0.1-beta.18 note in CLAUDE.md
      Promise.resolve().then(() => fixAllOfType(domain.slug, btn.dataset.fixall)).catch(reportAsyncActionFailure);
    });
  });

  document.querySelectorAll('.dm-group[data-group-key]').forEach((el) => {
    el.addEventListener('toggle', () => {
      const key = el.dataset.groupKey;
      if (el.open) state.expandedGroups.add(key); else state.expandedGroups.delete(key);
      if (key === 'dismissed' && el.open && state.dismissedRecords === null) loadDismissedRecords(domain.slug).catch(reportAsyncActionFailure);
    });
  });

  document.querySelectorAll('.dm-dismiss-btn[data-dismiss-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.dismissType;
      const issue = JSON.parse(btn.dataset.dismissIssue);
      dismissIssue(domain.slug, type, issue).catch(reportAsyncActionFailure);
    });
  });
  document.querySelectorAll('.dm-restore-btn[data-restore-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const record = JSON.parse(btn.dataset.restoreKey);
      undismissIssue(domain.slug, record).catch(reportAsyncActionFailure);
    });
  });
}

function rescan(slug) { loadHealth(slug, myMountToken).catch(reportAsyncActionFailure); }

function onQuickAction(slug, action) {
  if (action === 'fixSafe') return confirmFixSafe(slug);
  if (action === 'brokenLinks') return confirmBrokenLinksPlan(slug);
  if (action === 'orphans') return confirmOrphansPlan(slug);
  if (action === 'semanticDupes') return confirmSemanticScan(slug);
}

// ── fix-all-safe (free, deterministic) ─────────────────────────────────────

function confirmFixSafe(slug) {
  const total = countSafeFixable(state.health);
  state.confirm = {
    title: 'Fix ' + pluralize(total, 'safe issue') + '?',
    body: 'Applies deterministic repairs only — cross-folder duplicates, hyphen variants, folder-prefix links, ' +
      'missing backlinks, and broken links that already have a known target. Nothing here spends AI tokens. ' +
      'Every change is git-tracked and can be reverted from Sync.',
    confirmLabel: 'Fix now',
    run: () => runFixSafe(slug),
  };
  render(myMountToken);
}

// Every `run*`/`apply*`/`merge*` action below follows the same shape:
// captured `const token = myMountToken` as the FIRST line (safe — always
// entered synchronously, directly or one hop through a confirm-dialog
// click, from a real user click; see the doc comment on myMountToken
// above), `state.busyKey` reset in a `finally` so it is NEVER left stuck
// (H2 fix — a busyKey that survives a navigate-away-and-back permanently
// disables every quick-maintenance button until a full page reload), and
// every state MUTATION (not just the render) gated on isCurrentMount(token)
// so a response for an abandoned mount can't corrupt state a later, fresh
// mount would otherwise render correctly.
async function runFixSafe(slug) {
  const token = myMountToken;
  state.busyKey = 'fixSafe';
  render(token);
  try {
    // LOW-4 fix (re-audit, third round): `add()` moved to be the FIRST
    // statement inside the try (was: add(slug) — render(token) — try {}).
    // If render(token) threw, `add()` had already run, but the matching
    // `finally { delete(slug) }` below was never reached (the throw
    // happened OUTSIDE the try) — the entry leaked permanently, disabling
    // this domain's Fix/Rescue/Merge buttons behind "an earlier fix is
    // still running" for the rest of the session (no reachable trigger
    // found; hardening only). With `add()` INSIDE the try, a throw before
    // this line means `add()` never ran — nothing to leak — and a throw
    // after it is caught by this same try's `finally`.
    inFlightWriteSlugs.add(slug); // MEDIUM-5 fix — see the module-level comment above
    const result = await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/fix-all-safe', { method: 'POST' });
    if (isCurrentMount(token)) state.banner = { tone: 'success', text: 'Fixed ' + result.fixed + ' of ' + result.total + ' safe issues.' };
  } catch (err) {
    if (isCurrentMount(token)) state.banner = { tone: 'error', text: 'Could not fix safe issues — ' + err.message };
  } finally {
    inFlightWriteSlugs.delete(slug); // unconditional — the real write actually finished
    state.busyKey = null;
  }
  if (!isCurrentMount(token)) return;
  await loadHealth(slug, token, { silent: true });
}

// ── Single-category "Fix all N" (free, deterministic) ──────────────────────

async function fixAllOfType(slug, type) {
  const token = myMountToken;
  state.busyKey = 'group:' + type;
  render(token);
  try {
    inFlightWriteSlugs.add(slug); // MEDIUM-5 fix — LOW-4: inside the try, see runFixSafe's comment
    const result = await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    });
    if (isCurrentMount(token)) state.banner = { tone: 'success', text: 'Fixed ' + result.fixed + ' of ' + result.total + '.' };
  } catch (err) {
    if (isCurrentMount(token)) state.banner = { tone: 'error', text: 'Could not fix — ' + err.message };
  } finally {
    inFlightWriteSlugs.delete(slug);
    state.busyKey = null;
  }
  if (!isCurrentMount(token)) return;
  await loadHealth(slug, token, { silent: true });
}

// ── Broken-links AI plan/apply ──────────────────────────────────────────────

function confirmBrokenLinksPlan(slug) {
  const est = state.estimates.brokenLinks;
  const provider = state.aiProvider || 'the configured provider';
  const model = state.aiModel || '';
  const cost = est && !est.error ? formatUsd(est.estimatedUsd) : null;
  state.confirm = {
    title: 'Ask AI to resolve broken links?',
    body: 'Sends each broken link’s context, plus the domain’s slug inventory' +
      (est && !est.error ? ' (' + est.inventorySize + ' entries)' : '') + ', to ' + provider + (model ? '/' + model : '') +
      '. Estimated cost ' + (cost || 'unknown') + ' for ' + (est && !est.error ? est.needAi : '?') + ' link' +
      (est && est.needAi === 1 ? '' : 's') + ' that need AI (' + (est && !est.error ? est.resolveFree : 0) + ' resolve for free locally). ' +
      'This only builds a plan — nothing is written yet.',
    confirmLabel: 'Build plan',
    run: () => runBrokenLinksPlan(slug),
  };
  render(myMountToken);
}

async function runBrokenLinksPlan(slug) {
  const token = myMountToken;
  state.busyKey = 'brokenLinksPlan';
  state.progressText = 'Planning…';
  render(token);
  try {
    let result = null;
    await streamSSE('/api/health/' + encodeURIComponent(slug) + '/broken-links/plan', {}, (type, ev) => {
      if (type === 'done') result = ev;
      if (type === 'error') throw new Error(ev.error || 'Plan failed');
    });
    if (!result) throw new Error('No plan returned');
    if (isCurrentMount(token)) state.pendingPlan = { kind: 'brokenLinks', plan: result.plan, summary: result.summary };
  } catch (err) {
    if (isCurrentMount(token)) state.banner = { tone: 'error', text: 'Could not build a broken-link plan — ' + err.message };
  } finally {
    state.busyKey = null;
  }
  render(token);
}

// ── Orphan-rescue AI plan/apply ─────────────────────────────────────────────

function confirmOrphansPlan(slug) {
  const est = state.estimates.orphans;
  const provider = state.aiProvider || 'the configured provider';
  const model = state.aiModel || '';
  const cost = est && !est.error ? formatUsd(est.estimatedUsd) : null;
  state.confirm = {
    title: 'Ask AI to find homes for orphan pages?',
    body: 'Sends each orphan plus the domain’s entity/concept inventory' +
      (est && !est.error ? ' (' + est.inventorySize + ' entries)' : '') + ' to ' + provider + (model ? '/' + model : '') +
      '. Estimated cost ' + (cost || 'unknown') + '. This only builds a plan — nothing is written yet.',
    confirmLabel: 'Build plan',
    run: () => runOrphansPlan(slug),
  };
  render(myMountToken);
}

async function runOrphansPlan(slug) {
  const token = myMountToken;
  state.busyKey = 'orphansPlan';
  render(token);
  try {
    let result = null;
    await streamSSE('/api/health/' + encodeURIComponent(slug) + '/orphans/plan', {}, (type, ev) => {
      if (type === 'done') result = ev;
      if (type === 'error') throw new Error(ev.error || 'Plan failed');
    });
    if (!result) throw new Error('No plan returned');
    if (isCurrentMount(token)) state.pendingPlan = { kind: 'orphans', plan: result.plan, summary: result.summary };
  } catch (err) {
    if (isCurrentMount(token)) state.banner = { tone: 'error', text: 'Could not build an orphan-rescue plan — ' + err.message };
  } finally {
    state.busyKey = null;
  }
  render(token);
}

async function applyPendingPlan(slug) {
  const token = myMountToken;
  const p = state.pendingPlan;
  if (!p) return;
  const kind = p.kind;
  state.busyKey = kind + 'Apply';
  render(token);
  const url = '/api/health/' + encodeURIComponent(slug) + '/' + (kind === 'brokenLinks' ? 'broken-links' : 'orphans') + '/apply';
  try {
    inFlightWriteSlugs.add(slug); // MEDIUM-5 fix — LOW-4: inside the try, see runFixSafe's comment
    let result = null;
    await streamSSE(url, { plan: p.plan }, (type, ev) => {
      if (type === 'done') result = ev;
      if (type === 'error') throw new Error(ev.error || 'Apply failed');
    });
    if (isCurrentMount(token)) {
      if (kind === 'brokenLinks') {
        state.banner = { tone: 'success', text: 'Repointed ' + (result.occurrencesReplaced || 0) + ' link occurrences across ' + pluralize(result.filesChanged || 0, 'file') + '.' };
      } else {
        state.banner = { tone: 'success', text: 'Rescued ' + (result.rescued || 0) + ' orphans (' + (result.skipped || 0) + ' skipped).' };
      }
    }
  } catch (err) {
    if (isCurrentMount(token)) state.banner = { tone: 'error', text: 'Could not apply the plan — ' + err.message };
  } finally {
    // MEDIUM-4 fix (re-audit): unlike busyKey (which must ALWAYS reset —
    // see the H2 fix note above — or a button stays disabled forever),
    // `pendingPlan` is a piece of DATA a later, fresh mount can legitimately
    // own. If the user leaves this view mid-apply, comes back, and builds a
    // NEW plan before the abandoned apply's stream finishes, this ungated
    // reset used to silently destroy that new plan out from under the user
    // the instant the old apply's finally ran — with no error, no banner,
    // just the plan vanishing. Gate it: only null out the plan this SAME
    // mount is responsible for.
    if (isCurrentMount(token)) state.pendingPlan = null;
    inFlightWriteSlugs.delete(slug);
    state.busyKey = null;
  }
  if (!isCurrentMount(token)) return;
  await loadHealth(slug, token, { silent: true });
}

// ── Semantic-duplicate scan + batch merge ───────────────────────────────────

// H4 fix: the semantic-duplicate estimate is fetched HERE, on demand, the
// first time the user opens this action for the domain — not prefetched
// on every Domains open/switch (see loadEstimates + the file-header
// comment for why: it's a real pairwise-similarity pass over every page,
// measured at ~14.9s of unbroken event-loop block on a 3,251-page domain,
// even though it spends no tokens). The cost-before-action rule still
// holds: nothing token-spending runs until the SECOND step (the confirm
// dialog below, then Scan now) — this just moves WHEN the free-but-slow
// estimate itself runs, from "always, on view entry" to "once, on request".
async function confirmSemanticScan(slug) {
  const token = myMountToken;
  if (!state.estimates.semanticDupes) {
    state.busyKey = 'semanticDupesEstimate';
    render(token);
    try {
      const est = await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/semantic-dupes/estimate');
      if (slug === state.activeSlug && isCurrentMount(token)) state.estimates.semanticDupes = est;
    } catch (err) {
      if (slug === state.activeSlug && isCurrentMount(token)) state.estimates.semanticDupes = { error: err.message };
    } finally {
      // H2 fix (re-audit finding): previously this reset lived AFTER the
      // try/catch, as a plain sequential statement — but BOTH early
      // returns below (domain switched mid-estimate, or the view left
      // entirely) skipped straight past it. Since this is the only place
      // that ever clears 'semanticDupesEstimate', every quick-maintenance
      // button and Rescan stayed permanently disabled — reproduced by
      // opening this action, switching domains before the ~free-but-slow
      // estimate resolved, and finding every button on this domain (and
      // every OTHER domain, since busyKey is shared module state, not
      // per-domain) still disabled after a full navigate-away-and-back
      // remount; only a page reload recovered. A `finally` runs on EVERY
      // exit from the block above, including a `return` inside it, so
      // this can no longer be skipped.
      state.busyKey = null;
    }
  }

  if (slug !== state.activeSlug || !isCurrentMount(token)) { render(token); return; }

  const est = state.estimates.semanticDupes;
  if (!est) { render(token); return; } // domain changed before the estimate ever resolved
  if (est.error) {
    state.banner = { tone: 'error', text: 'Could not estimate the duplicate scan — ' + est.error };
    render(token);
    return;
  }
  if (!est.candidatePairs) {
    state.banner = { tone: 'info', text: 'No likely duplicate candidates found — nothing to scan.' };
    render(token);
    return;
  }

  const provider = state.aiProvider || 'the configured provider';
  const model = state.aiModel || '';
  const cost = formatUsd(est.estimatedUsd);
  state.confirm = {
    title: 'Scan for duplicate pages?',
    body: 'Scans ' + est.candidatePairs + ' candidate pairs' +
      (est.totalCandidates ? ' (pre-filtered locally from ' + est.totalCandidates + ' total)' : '') +
      ' using ' + provider + (model ? '/' + model : '') + '. Estimated cost ' + (cost || 'unknown') +
      '. This only finds pairs — nothing is merged yet.',
    confirmLabel: 'Scan now',
    run: () => runSemanticScan(slug),
  };
  render(token);
}

async function runSemanticScan(slug) {
  const token = myMountToken;
  state.busyKey = 'semanticDupesScan';
  render(token);
  try {
    let result = null;
    await streamSSE('/api/health/' + encodeURIComponent(slug) + '/semantic-dupes/scan', {}, (type, ev) => {
      if (type === 'done') result = ev;
      if (type === 'error') throw new Error(ev.error || 'Scan failed');
    });
    if (!result) throw new Error('No scan result returned');
    if (isCurrentMount(token)) state.semanticScan = { pairs: result.pairs || [], cost: result.cost };
  } catch (err) {
    if (isCurrentMount(token)) state.banner = { tone: 'error', text: 'Could not scan for duplicates — ' + err.message };
  } finally {
    state.busyKey = null;
  }
  render(token);
}

function mergeSemanticDuplicates(slug) {
  const s = state.semanticScan;
  if (!s) return;
  const high = s.pairs.filter((p) => p.confidence === 'high');
  if (high.length === 0) return;
  state.confirm = {
    title: 'Merge ' + pluralize(high.length, 'high-confidence duplicate') + '?',
    body: 'Combines each pair’s bullet sections onto the kept page, retargets every [[wikilink]] across the ' +
      'domain to it, and deletes the removed file. Nothing else changes. Every change is git-tracked and revertable from Sync.',
    confirmLabel: 'Merge now',
    run: () => runMergeSemanticDuplicates(slug, high),
  };
  render(myMountToken);
}

async function runMergeSemanticDuplicates(slug, pairs) {
  const token = myMountToken;
  state.busyKey = 'semanticMerge';
  render(token);
  try {
    inFlightWriteSlugs.add(slug); // MEDIUM-5 fix — LOW-4: inside the try, see runFixSafe's comment
    let result = null;
    await streamSSE('/api/health/' + encodeURIComponent(slug) + '/semantic-dupes/merge-batch', { pairs }, (type, ev) => {
      if (type === 'done') result = ev;
      if (type === 'error') throw new Error(ev.error || 'Merge failed');
    });
    if (isCurrentMount(token)) state.banner = { tone: 'success', text: 'Merged ' + (result.merged || 0) + ' of ' + (result.total || pairs.length) + ' duplicate pairs.' };
  } catch (err) {
    if (isCurrentMount(token)) state.banner = { tone: 'error', text: 'Could not merge duplicates — ' + err.message };
  } finally {
    // MEDIUM-4 fix (re-audit): same reasoning as applyPendingPlan's
    // `pendingPlan` above — the semantic-duplicate scan is the single most
    // expensive operation in this view (a real pairwise LLM pass), so
    // silently destroying a NEWER scan the user built after coming back to
    // this domain, just because an OLDER, abandoned merge happened to
    // finish afterward, is the worst possible place for an ungated reset.
    // busyKey stays ungated (it must always clear, or the maintenance bar
    // bricks — H2).
    if (isCurrentMount(token)) state.semanticScan = null;
    inFlightWriteSlugs.delete(slug);
    state.busyKey = null;
  }
  if (!isCurrentMount(token)) return;
  await loadHealth(slug, token, { silent: true });
}

// ── Dismiss / undismiss ──────────────────────────────────────────────────

async function dismissIssue(slug, type, issue) {
  const token = myMountToken;
  try {
    await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, issue }),
    });
    state.dismissedRecords = null;
    if (!isCurrentMount(token)) return;
    await loadHealth(slug, token, { silent: true });
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.banner = { tone: 'error', text: 'Could not dismiss — ' + err.message };
    render(token);
  }
}

async function undismissIssue(slug, record) {
  const token = myMountToken;
  try {
    await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/undismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: record.type, issue: record }),
    });
    state.dismissedRecords = null;
    if (!isCurrentMount(token)) return;
    await loadHealth(slug, token, { silent: true });
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.banner = { tone: 'error', text: 'Could not restore — ' + err.message };
    render(token);
  }
}

async function loadDismissedRecords(slug) {
  const token = myMountToken;
  try {
    const data = await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/dismissed');
    if (slug === state.activeSlug && isCurrentMount(token)) state.dismissedRecords = data.records || [];
  } catch {
    if (slug === state.activeSlug && isCurrentMount(token)) state.dismissedRecords = [];
  }
  render(token);
}

// ── Render entry point ─────────────────────────────────────────────────────

function render(token) {
  renderSidebar(token);
  renderMain(token);
}

registerView('domains', {
  onEnter(mountToken) {
    myMountToken = mountToken;
    loadDomainsList(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));

    // M2 fix (re-audit finding): this view's `state` is DELIBERATELY
    // module-scoped and NOT reset on every onEnter (see the comment above
    // `state` — leaving Domains and coming back should still show which
    // domain was open). But a few of those fields are dangerous to leave
    // behind rather than merely stale: `state.confirm.run` and
    // `state.pendingPlan` close over (or were built from) a specific
    // scan/plan snapshot — if the user leaves this view with a confirm
    // dialog open or a built-but-unapplied plan pending and comes back
    // later, they could be shown, or worse still able to APPLY, a
    // confirmation/plan derived from a scan `loadHealth` has long since
    // discarded (a different domain's issues, or a health report that's
    // been rescanned since). `state.busyKey` is reset here too as a second
    // line of defense alongside the H2 fix in confirmSemanticScan/etc.
    // (every busy-setting function below now also clears it itself, in a
    // `finally`, regardless of mount staleness — this teardown is what
    // still catches ANY spot that pattern was missed). Everything else
    // (expandedGroups, dismissedRecords, the health report itself) is left
    // exactly as it was, matching this file's persist-across-mounts design.
    return () => {
      state.confirm = null;
      state.pendingPlan = null;
      state.semanticScan = null;
      state.busyKey = null;
    };
  },
});
