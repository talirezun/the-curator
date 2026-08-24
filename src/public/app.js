// ── Version badge ─────────────────────────────────────────────────────────────
fetch('/api/version')
  .then(r => r.json())
  .then(({ version, onDiskVersion, restartRequired }) => {
    const el = document.getElementById('app-version');
    if (!el) return;
    el.textContent = `v${version}`;
    if (restartRequired) {
      el.title = `Files on disk are v${onDiskVersion} — please quit and relaunch The Curator to load the new code.`;
      el.classList.add('app-version-stale');
    }
  })
  .catch(() => {}); // non-critical — silently skip if unavailable

// ── Tabs ──────────────────────────────────────────────────────────────────────
const tabBtns = document.querySelectorAll('.tab-btn');
const tabs = document.querySelectorAll('.tab');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    tabBtns.forEach(b => b.classList.toggle('active', b === btn));
    tabs.forEach(t => {
      t.classList.toggle('active', t.id === `tab-${target}`);
      t.classList.toggle('hidden', t.id !== `tab-${target}`);
    });

    // Auto-refresh data when switching to certain tabs
    if (target === 'domains') loadDomainList().catch(() => {});
    if (target === 'wiki') {
      const wikiDomain = document.getElementById('wiki-domain');
      if (wikiDomain && wikiDomain.value) loadWiki();
    }
    if (target === 'health') resetHealthPanel();
    // Re-evaluate the chat model selector so a key added/removed in Settings
    // this session is reflected without a page reload (init is idempotent).
    if (target === 'chat') { try { initChatModelSelector(); } catch { /* ignore */ } }
    // Batch ingest queue (Track 3): disconnect the live SSE stream when
    // leaving the Ingest tab (this also releases the busy gate, via
    // attachQueueStream's own finally block) and re-check for / reattach to
    // an active batch on the way back in — the "resume on return" contract.
    if (target !== 'ingest') { try { detachQueueStream(); } catch { /* ignore */ } }
    if (target === 'ingest') { checkActiveQueueJob().catch(() => {}); }
  });
});

// ── Domain loading ─────────────────────────────────────────────────────────────
const domainSelects = ['ingest-domain', 'wiki-domain', 'health-domain'];

async function loadDomains() {
  const res = await fetch('/api/domains');
  const { domains, readonlyDomains = [] } = await res.json();
  domainSelects.forEach(id => {
    const el = document.getElementById(id);
    // Read-only Shared Brain mirrors can't be ingested into (the backend
    // refuses too) — keep them out of the ingest target dropdown. Wiki and
    // Health dropdowns keep them: reading + scanning a mirror is fine.
    const list = id === 'ingest-domain'
      ? domains.filter(d => !readonlyDomains.includes(d))
      : domains;
    el.innerHTML = list
      .map(d => `<option value="${d}">${formatDomain(d)}</option>`)
      .join('');
  });
}

function formatDomain(slug) {
  return slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' / ');
}

// ── INGEST TAB ────────────────────────────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('ingest-file');
const fileNameEl = document.getElementById('file-name');
const ingestBtn = document.getElementById('ingest-btn');
const ingestStatus = document.getElementById('ingest-status');
const ingestResult = document.getElementById('ingest-result');

let selectedFile = null;

function setFile(file) {
  if (!file) return;
  const allowed = ['.txt', '.md', '.pdf'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!allowed.includes(ext)) {
    showStatus(ingestStatus, 'error', `Unsupported file type: ${ext}. Use .txt, .md, or .pdf`);
    return;
  }
  selectedFile = file;
  fileNameEl.textContent = file.name;
  // Round-2 audit item 2: don't just enable — refuse if a batch (or any
  // other registered write) is already running against THIS domain. See
  // refreshIngestBtnAvailability() for why.
  refreshIngestBtnAvailability();
  hideEl(ingestStatus);
  hideEl(ingestResult);
}

dropZone?.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone?.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  handleSelectedFiles(e.dataTransfer.files);
});
// Open file picker when clicking anywhere on the drop zone,
// but skip if the click came from the <label> inside — that
// already triggers the input natively via its `for` attribute,
// so calling fileInput.click() again would open the picker twice.
dropZone?.addEventListener('click', (e) => {
  if (e.target.closest('label')) return;
  fileInput?.click();
});
// Track 3 (batch ingest queue): 1 file selected always routes to setFile()
// below — the existing, unchanged single-file flow. 2+ files routes to the
// batch queue instead. handleSelectedFiles() is defined in the "BATCH
// INGEST QUEUE" section further down; it is the ONLY thing this listener's
// behaviour changes versus before.
fileInput?.addEventListener('change', () => handleSelectedFiles(fileInput.files));

ingestBtn?.addEventListener('click', () => submitIngest(false));

// ── Progress bar helpers ───────────────────────────────────────────────────
const ingestProgress = document.getElementById('ingest-progress');
const progressFill   = document.getElementById('progress-fill');
const progressLabel  = document.getElementById('progress-label');
const progressPct    = document.getElementById('progress-pct');
// v3.0.17: may be null if index.html and app.js ever drift — every use below
// is guarded so a missing element degrades to "no elapsed display", never a
// thrown error at module scope (app.js is one big ES module; one throw here
// would blank the whole app for every user — see CLAUDE.md's boot-guard note).
const progressElapsedEl = document.getElementById('progress-elapsed');

// v3.0.17: "how long has the CURRENT step been running" clock. Ingest phases
// (esp. Phase 1's single outline LLM call) can sit at the same pct/message
// for a minute or more with zero sub-progress to report — previously
// indistinguishable from a hang. This ticks every second and is reset only
// on a genuine new progress step, NOT on wait/retry sub-events, so a stalled
// phase visibly keeps counting instead of looking frozen mid-retry.
let progressTimerId = null;
let progressPhaseStartedAt = null;

function formatElapsed(ms) {
  // Defensive clamp: Date.now() - progressPhaseStartedAt is always a finite
  // number in practice (tickProgressElapsed already guards the null case),
  // but a non-finite input must never render "NaNs" if this is ever called
  // from somewhere else.
  const safeMs = Number.isFinite(ms) ? ms : 0;
  const totalSec = Math.max(0, Math.floor(safeMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function tickProgressElapsed() {
  if (!progressElapsedEl || progressPhaseStartedAt == null) return;
  progressElapsedEl.textContent = formatElapsed(Date.now() - progressPhaseStartedAt);
}

function showProgress(pct, label, waiting = false) {
  ingestProgress.classList.remove('hidden');
  progressFill.style.width = pct + '%';
  progressFill.classList.toggle('waiting', waiting);
  progressLabel.textContent = label;
  progressLabel.classList.toggle('waiting', waiting);
  progressPct.textContent = pct + '%';

  // A genuine step change (not a wait/backoff sub-event) restarts the "how
  // long has this step been running" clock.
  if (!waiting) progressPhaseStartedAt = Date.now();

  // Lazily start a single ticking interval; showProgress is called many
  // times per ingest (every SSE event) and must never stack intervals.
  if (progressTimerId == null) {
    progressTimerId = setInterval(tickProgressElapsed, 1000);
  }
  tickProgressElapsed();
}

function hideProgress() {
  ingestProgress.classList.add('hidden');
  progressFill.style.width = '0%';
  progressFill.classList.remove('waiting');
  progressLabel.classList.remove('waiting');
  // Always tear down the interval here — this is the single cleanup point
  // reached on success, error, and the duplicate-file early return (see
  // submitIngest below), so the timer can never leak past one ingest.
  if (progressTimerId != null) {
    clearInterval(progressTimerId);
    progressTimerId = null;
  }
  progressPhaseStartedAt = null;
  if (progressElapsedEl) progressElapsedEl.textContent = '';
}

async function submitIngest(overwrite) {
  if (!selectedFile) return;

  const domain = document.getElementById('ingest-domain').value;
  ingestBtn.disabled = true;
  hideEl(ingestResult);
  hideEl(ingestStatus);
  hideDuplicateBanner();
  showProgress(2, 'Starting…');

  // v3.0.1-beta.8: register ingest start with the UI busy-state tracker so
  // Update / Sync / Delete buttons get disabled while this is running.
  // Matched by ingestEnd() in finally below.
  if (typeof window.__curatorIngestStart === 'function') {
    window.__curatorIngestStart(domain);
  }
  let ingestRegistered = true;

  const formData = new FormData();
  formData.append('domain', domain);
  formData.append('file', selectedFile);
  if (overwrite) formData.append('overwrite', 'true');

  try {
    const res = await fetch('/api/ingest', { method: 'POST', body: formData });

    // ── Non-streaming responses (validation errors, duplicate) ──────────────
    if (!res.headers.get('content-type')?.includes('text/event-stream')) {
      const data = await res.json();
      if (res.status === 409 && data.duplicate) {
        hideProgress();
        showDuplicateBanner(data.filename, domain);
        ingestBtn.disabled = false;
        return;
      }
      throw new Error(data.error || 'Ingest failed');
    }

    // ── Stream SSE progress events ──────────────────────────────────────────
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finalData = null;

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      // SSE lines are separated by '\n'; events are terminated by '\n\n'
      const lines = buf.split('\n');
      buf = lines.pop(); // keep the incomplete trailing line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }

        if (ev.type === 'progress') {
          showProgress(ev.pct, ev.message, false);
        } else if (ev.type === 'wait') {
          // AI is retrying — pulse the bar and show the wait message
          showProgress(ev.pct, ev.message, true);
        } else if (ev.type === 'done') {
          finalData = ev;
          break outer;
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
    }

    if (!finalData) throw new Error('Ingest did not complete successfully');

    // Brief "100%" flash before showing results
    showProgress(100, 'Done!');
    await new Promise(r => setTimeout(r, 500));
    hideProgress();
    showIngestResult(finalData);

    // Reset file selection
    selectedFile = null;
    fileNameEl.textContent = '';
    fileInput.value = '';
    ingestBtn.disabled = true;

    // Refresh domain stats so page counts update without a browser reload
    loadDomainList().catch(() => {});

    // Bump the navbar pending-sync badge — ingest just wrote many new/
    // modified wiki files that need to be pushed (v3.0.1-beta.5).
    refreshSyncPendingBadge();

  } catch (err) {
    hideProgress();
    showStatus(ingestStatus, 'error', err.message);
    ingestBtn.disabled = false;
  } finally {
    // v3.0.1-beta.8: always release the UI busy state so the Update/Sync/
    // Delete buttons re-enable. Mirrors the backend write-registry release
    // pattern in src/routes/ingest.js.
    if (ingestRegistered && typeof window.__curatorIngestEnd === 'function') {
      window.__curatorIngestEnd(domain);
    }
  }
}

function showDuplicateBanner(filename, domain) {
  let banner = document.getElementById('duplicate-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'duplicate-banner';
    banner.className = 'duplicate-banner';
    ingestResult.parentNode.insertBefore(banner, ingestResult);
  }
  banner.innerHTML = `
    <div class="dup-icon">⚠️</div>
    <div class="dup-body">
      <strong>${escHtml(filename)}</strong> has already been ingested into this domain.
      <div class="dup-actions">
        <button class="btn dup-overwrite">Re-ingest &amp; update wiki</button>
        <button class="btn dup-cancel">Cancel</button>
      </div>
    </div>`;
  showEl(banner);

  banner.querySelector('.dup-overwrite').addEventListener('click', () => {
    hideDuplicateBanner();
    submitIngest(true);
  });
  banner.querySelector('.dup-cancel').addEventListener('click', () => {
    hideDuplicateBanner();
    refreshIngestBtnAvailability();
  });
}

function hideDuplicateBanner() {
  const banner = document.getElementById('duplicate-banner');
  if (banner) banner.remove();
}

function showIngestResult(data) {
  const titlePrefix = data.wasOverwrite ? 'Re-ingested:' : 'Ingested:';
  // Prefer the structured change records (v2.5.0+); fall back to the flat
  // pagesWritten list if an older response somehow arrives.
  if (data.changes && data.changes.length) {
    renderChangeRecords(ingestResult, {
      title: `${titlePrefix} ${data.title}`,
      changes: data.changes,
    });
  } else {
    ingestResult.innerHTML = `
      <h3>${escHtml(titlePrefix)} ${escHtml(data.title || '')}</h3>
      <ul>
        ${(data.pagesWritten || []).map(p => `<li><span>${escHtml(p)}</span></li>`).join('')}
      </ul>
    `;
    showEl(ingestResult);
  }
  // v3.0.1-beta.1: surface non-fatal warnings (truncation, stub pages,
  // outline-validator patches) above the change records so the user sees
  // them without having to inspect the log.
  renderIngestWarnings(data);
  // v3.0.17: real per-call token/cache spend (additive `done` field) —
  // compact secondary footer, appended last so it sits below everything else.
  renderTokenUsage(ingestResult, data.tokenUsage);
}

// v3.0.17: format the additive tokenUsage payload
// ({calls, inputTokens, outputTokens, cachedReadTokens, cacheWriteTokens,
// provider, model} — see src/brain/ingest.js's makeUsageAccumulator) into a
// compact HTML fragment, or null if there's nothing worth showing. Every
// field is individually optional/possibly-missing — an older server, a
// response that errored before any LLM call ran, or a future partial shape
// must all degrade to "render nothing", never NaN/undefined text.
function formatTokenUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const calls            = isNum(u.calls) ? u.calls : null;
  const inputTokens      = isNum(u.inputTokens) ? u.inputTokens : null;
  const outputTokens     = isNum(u.outputTokens) ? u.outputTokens : null;
  const cachedReadTokens = isNum(u.cachedReadTokens) ? u.cachedReadTokens : 0;
  const cacheWriteTokens = isNum(u.cacheWriteTokens) ? u.cacheWriteTokens : 0;
  const provider = typeof u.provider === 'string' && u.provider ? u.provider : null;
  const model    = typeof u.model === 'string' && u.model ? u.model : null;

  // Nothing usable at all — e.g. an empty/malformed object ({}), which the
  // one current caller (ingestFile's tokenUsage) never actually sends (its
  // accumulator always initialises calls/inputTokens/outputTokens to 0), but
  // this is a shared render helper and a future or different caller could.
  // Render nothing rather than an empty box.
  if (calls == null && inputTokens == null && outputTokens == null && !provider && !model) {
    return null;
  }

  const parts = [];
  if (provider || model) {
    const label = [provider, model].filter(Boolean).join(' · ');
    parts.push(`<span class="token-usage-model">${escHtml(label)}</span>`);
  }
  if (calls != null) {
    parts.push(`<span class="token-usage-stat">${calls} call${calls === 1 ? '' : 's'}</span>`);
  }
  if (inputTokens != null || outputTokens != null) {
    const inStr  = inputTokens  != null ? inputTokens.toLocaleString()  : '—';
    const outStr = outputTokens != null ? outputTokens.toLocaleString() : '—';
    parts.push(`<span class="token-usage-stat">${inStr} in / ${outStr} out</span>`);
  }
  // Cache split only shown when non-zero — this is the v3.0.16 cost-saving
  // signal the maintainer specifically asked to be able to see.
  if (cachedReadTokens > 0 || cacheWriteTokens > 0) {
    const bits = [];
    if (cachedReadTokens > 0) bits.push(`${cachedReadTokens.toLocaleString()} cached read`);
    if (cacheWriteTokens > 0) bits.push(`${cacheWriteTokens.toLocaleString()} cache write`);
    parts.push(`<span class="token-usage-stat token-usage-cache">${bits.join(' · ')}</span>`);
  }
  return parts.length ? parts.join('') : null;
}

function renderTokenUsage(container, tokenUsage) {
  if (!container) return;
  // Idempotent re-render: drop any prior footer before appending a fresh
  // one (submitIngest reuses the same #ingest-result container per ingest).
  const existing = container.querySelector('.token-usage');
  if (existing) existing.remove();
  const inner = formatTokenUsage(tokenUsage);
  if (!inner) return;
  const el = document.createElement('div');
  el.className = 'token-usage';
  el.innerHTML = inner;
  container.appendChild(el);
}

// v3.0.1-beta.12+: classify each entry in the ingest report by the kind
// of event it represents. Most "warnings" are actually safeguard SUCCESSES
// (Curator caught something and fixed it automatically). Showing them all
// as amber warnings made the result panel look alarming. This classifier
// inspects the message text and groups entries into three buckets:
//
//   ✓ auto-fixed   — Curator detected and fixed automatically, no action needed
//   ⚠ for review   — Curator detected something it can't auto-resolve;
//                    user should look at Wiki Health or decide manually
//   ℹ informational — context the user might want to know (e.g. truncation)
//
// The classifier is text-pattern based. It pairs with the warning strings
// emitted from src/brain/ingest.js — if we add new warning kinds, update
// this classifier too. Documented in docs/user-guide.md §8.
function classifyIngestEntry(w) {
  const lc = String(w || '').toLowerCase();
  // Order matters: most specific patterns first.
  if (lc.includes('injected the trunk page') ||
      lc.includes('hub linkification') ||
      lc.includes('injected entities/') ||
      lc.includes('injected the canonical summary') ||
      lc.includes('redirected to canonical') ||
      lc.includes('redirected; bullets will merge') ||
      lc.includes('dropping') && lc.includes('content will merge')) {
    return { kind: 'fixed', icon: '✓', color: '#3fb950', label: 'Auto-fixed' };
  }
  if (lc.includes('keeping both') ||
      lc.includes("don't resolve") ||
      lc.includes('do not resolve') ||
      lc.includes('stub page') ||
      // v3.0.17: dedicated trigger for the concise-retry-success warning
      // emitted by src/brain/ingest.js (multi-phase single-page fallback —
      // search that file for "briefer than the rest"). That message ends
      // in an instruction to go check the page in the Wiki tab, so it
      // belongs here, not in the quiet blue Info bucket. It previously only
      // landed here by accident, via the 'stub page' trigger above catching
      // the negation "not a stub page" in its text — semantically backwards,
      // and one reword away from silently going blue. If ingest.js's wording
      // for this warning changes, update this trigger to match (that file's
      // own test, scripts/test-ingest-prompt-slimming.js, pins the exact
      // phrase "briefer than the rest" in its source, so a drift there is
      // caught — but check this side too, since that test doesn't read
      // app.js's trigger list for this specific phrase).
      lc.includes('briefer than the rest')) {
    return { kind: 'review', icon: '⚠', color: '#d29922', label: 'For review' };
  }
  if (lc.includes('truncated to')) {
    return { kind: 'attention', icon: '⚠', color: '#f85149', label: 'Attention' };
  }
  return { kind: 'info', icon: 'ℹ', color: '#58a6ff', label: 'Info' };
}

// v3.x (Track 3): `container` is a new trailing parameter defaulting to the
// original global `ingestResult` — the single-file call site below
// (`renderIngestWarnings(data)`) passes no second argument, so it resolves
// to the same default and is behaviourally IDENTICAL to before. The batch
// ingest queue's per-item detail view passes its own container so warnings
// for one item don't get inserted into the single-file panel.
function renderIngestWarnings(data, container = ingestResult) {
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  if (!warnings.length) return;

  // Bucket entries by kind for the header summary.
  const buckets = { fixed: 0, review: 0, attention: 0, info: 0 };
  const classified = warnings.map(w => {
    const c = classifyIngestEntry(w);
    buckets[c.kind]++;
    return { msg: w, ...c };
  });

  // Build a short summary line: "3 auto-fixed, 1 for review, 1 info"
  const summaryParts = [];
  if (buckets.fixed)     summaryParts.push(`<span style="color:#3fb950">${buckets.fixed} auto-fixed</span>`);
  if (buckets.review)    summaryParts.push(`<span style="color:#d29922">${buckets.review} for review</span>`);
  if (buckets.attention) summaryParts.push(`<span style="color:#f85149">${buckets.attention} attention</span>`);
  if (buckets.info)      summaryParts.push(`<span style="color:#58a6ff">${buckets.info} info</span>`);
  const summaryLine = summaryParts.join(' · ');

  const items = classified.map(c =>
    `<li style="margin-bottom:4px"><span style="color:${c.color};font-weight:600">${c.icon} ${c.label}:</span> ${escHtml(c.msg)}</li>`
  ).join('');

  const banner = document.createElement('div');
  banner.className = 'ingest-warnings';
  // Banner color reflects the most-severe entry: red if any attention,
  // amber if any review, green if all auto-fixed, blue otherwise.
  const borderColor = buckets.attention ? '#f85149'
                    : buckets.review    ? '#ffb961'
                    : buckets.fixed     ? '#3fb950'
                    : '#58a6ff';
  const bg = buckets.attention ? '#3a1c1c'
           : buckets.review    ? '#3a2c1c'
           : buckets.fixed     ? '#1c3a2c'
           : '#1c2c3a';
  banner.style.cssText = `background:${bg};border:1px solid ${borderColor};border-radius:6px;padding:10px 12px;margin:10px 0;font-size:13px;line-height:1.5;`;
  banner.innerHTML =
    `<strong>Ingest finished — ${warnings.length} note${warnings.length === 1 ? '' : 's'}</strong>` +
    (summaryLine ? `<div style="font-size:12px;margin-top:2px">${summaryLine}</div>` : '') +
    `<ul style="margin:8px 0 0 0;padding:0;list-style:none">${items}</ul>`;
  container.insertBefore(banner, container.firstChild);
}

// ── Shared change-records renderer (v2.5.0) ───────────────────────────────────
// Used by ingest, chat compile, and (later) MCP write surfaces. Splits records
// into created / updated / unchanged. Unchanged is collapsed by default to
// keep the panel quiet — most users only care about new + updated.
function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function renderChangeRecords(container, { title, changes }) {
  if (!changes || changes.length === 0) {
    container.innerHTML = '';
    hideEl(container);
    return;
  }

  const created = changes.filter(c => c.status === 'created');
  const updated = changes.filter(c => c.status === 'updated');
  const unchanged = changes.filter(c => c.status === 'unchanged');

  const formatRecord = (c) => {
    let detail = '';
    if (c.status === 'updated' && c.bulletsAdded > 0) {
      const sections = c.sectionsChanged && c.sectionsChanged.length
        ? ` in ${c.sectionsChanged.map(escHtml).join(', ')}`
        : '';
      detail = `<span class="change-detail">+${c.bulletsAdded} bullet${c.bulletsAdded === 1 ? '' : 's'}${sections}</span>`;
    } else if (c.status === 'created') {
      detail = `<span class="change-detail">${formatBytes(c.bytesAfter)}</span>`;
    } else if (c.status === 'updated') {
      detail = `<span class="change-detail">${formatBytes(c.bytesBefore)} → ${formatBytes(c.bytesAfter)}</span>`;
    }
    return `<li><span class="change-path">${escHtml(c.canonPath)}</span>${detail}</li>`;
  };

  const headerRow = title
    ? `<h3 class="change-title">${escHtml(title)}</h3>`
    : '';

  const createdBlock = created.length ? `
    <div class="change-section change-created">
      <div class="change-header"><span class="change-icon">✨</span> ${created.length} new ${created.length === 1 ? 'page' : 'pages'}</div>
      <ul class="change-list">${created.map(formatRecord).join('')}</ul>
    </div>` : '';

  const updatedBlock = updated.length ? `
    <div class="change-section change-updated">
      <div class="change-header"><span class="change-icon">✏️</span> ${updated.length} ${updated.length === 1 ? 'page' : 'pages'} updated</div>
      <ul class="change-list">${updated.map(formatRecord).join('')}</ul>
    </div>` : '';

  const unchangedBlock = unchanged.length ? `
    <div class="change-section change-unchanged">
      <button class="change-toggle" type="button">Show ${unchanged.length} unchanged ${unchanged.length === 1 ? 'page' : 'pages'}</button>
      <ul class="change-list hidden">${unchanged.map(formatRecord).join('')}</ul>
    </div>` : '';

  // Empty edge case: every record was unchanged (e.g. re-compile of identical convo)
  const emptyBlock = (!created.length && !updated.length) ? `
    <div class="change-empty">No changes — every page was already up to date.</div>` : '';

  container.innerHTML = `
    <div class="change-summary">
      ${headerRow}
      ${createdBlock}
      ${updatedBlock}
      ${emptyBlock}
      ${unchangedBlock}
    </div>
  `;

  // Wire the "show unchanged" toggle
  const toggle = container.querySelector('.change-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const ul = toggle.nextElementSibling;
      const isHidden = ul.classList.contains('hidden');
      ul.classList.toggle('hidden');
      toggle.textContent = isHidden
        ? `Hide ${unchanged.length} unchanged ${unchanged.length === 1 ? 'page' : 'pages'}`
        : `Show ${unchanged.length} unchanged ${unchanged.length === 1 ? 'page' : 'pages'}`;
    });
  }

  showEl(container);
}

// ── BATCH INGEST QUEUE (Track 3) ────────────────────────────────────────────
//
// 1 file selected → the flow above (setFile/submitIngest), completely
// unchanged. 2+ files selected → this section.
//
// Core design rule: the client NEVER derives or caches job state. Every
// render call takes a FULL job snapshot from the server (an SSE 'job'/'done'
// event, or a plain GET) and rebuilds the panel from it — no incremental
// patching, no client-side "which item is running" bookkeeping. The one
// narrow, explicitly-scoped exception is updateQueueItemProgress(), which
// handles the item-progress SSE event — that event carries only
// {idx, pct, message}, not a full job, exactly like the single-file
// progress bar's own 'progress' event above.
//
// applyQueueJobSnapshot() is the single chokepoint every job object flows
// through (SSE events, POST start/pause/cancel responses, GET refreshes).
// It is the only place that touches the shared busy gate
// (window.__curatorIngestStart/__curatorIngestEnd) and the only place that
// calls renderQueuePanel — so a busy-gate leak or a stale render can't be
// introduced by adding a new call site elsewhere.

const QUEUE_API = '/api/ingest-queue';
const queueStatusEl  = document.getElementById('queue-status');
const queueConfirmEl = document.getElementById('queue-confirm');
const queuePanelEl   = document.getElementById('queue-panel');

let selectedFiles     = [];   // File[] currently chosen for the batch path
let queueEstimate     = null; // last /estimate response (pre-job)
let queueJobId        = null; // the job this tab is currently attached to
let queueStreamAbort  = null; // AbortController for the live SSE fetch
let _queueLastStatus  = null; // last status the busy gate was told about
// The domain key actually used the last time the busy gate was ENTERED.
// This — never a value re-read from the #ingest-domain dropdown — is what
// gets handed to __curatorIngestEnd. The H2 leak was exactly this: enter
// keyed on job.domain, exit keyed on whatever the dropdown happened to
// hold at that later moment (often '' on a page-reload resume, since
// loadDomains() and checkActiveQueueJob() both fire un-awaited and the
// select can still be empty when the exit fires). Storing the entry key
// and always releasing with THAT key makes the mismatch structurally
// impossible rather than a convention every call site must remember.
let _queueBusyDomain  = null;

// ── Pure helpers (extracted + unit-tested via new Function in
//    scripts/test-ingest-queue-frontend.js — keep them free of DOM/fetch
//    calls so they stay testable in a plain Node sandbox) ──────────────────

// Should the shared busy gate be entered or exited when the queue's last-
// known job status moves from `prev` to `next`? 'running' is the only
// status where the batch is actually writing to the wiki — every other
// status (pending/paused/done/cancelled/failed, and the synthetic `null`
// meaning "not attached") is not-busy. Returns 'enter' | 'exit' | null.
function queueBusyTransition(prevStatus, nextStatus) {
  const wasBusy = prevStatus === 'running';
  const isBusy = nextStatus === 'running';
  if (!wasBusy && isBusy) return 'enter';
  if (wasBusy && !isBusy) return 'exit';
  return null;
}

// Byte formatter for batch totals, which can run into the hundreds of MB
// (unlike the KB-scale formatBytes() above, used for single pages). Never
// renders NaN/undefined text — a non-finite input renders as an em dash.
function formatQueueBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(1)} ${units[i]}`;
}

// Pre-spend USD range formatter. Renders a real range, a single value when
// low === high, or an explicit "unknown" string — NEVER a fabricated
// number, NaN, or the literal text "undefined"/"null".
function formatUsdRange(low, high) {
  const isNum = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!isNum(low) || !isNum(high)) return 'cost unknown for this model';
  const fmt = v => `$${v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
  if (Math.abs(high - low) < 0.0001) return fmt(low);
  return `${fmt(low)} – ${fmt(high)}`;
}

// Same contract as formatUsdRange but for a token count range.
function formatTokenRange(low, high) {
  const isNum = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!isNum(low) || !isNum(high)) return 'unknown';
  const fmt = v => Math.round(v).toLocaleString();
  if (low === high) return fmt(low);
  return `${fmt(low)}–${fmt(high)}`;
}

// Copy table for the paused banner, keyed off job.pausedReason. Every key
// in the frozen contract is covered; an unrecognised/null reason falls back
// to a generic message rather than rendering nothing.
function pausedReasonCopy(reason) {
  const table = {
    rate_limit: {
      title: 'Paused — the AI provider rate-limited us',
      body: 'The app already retried with backoff. Nothing was lost. Wait a few minutes, then resume.',
    },
    service_unavailable: {
      title: 'Paused — the AI provider is temporarily unavailable',
      body: 'The app already retried with backoff. Nothing was lost. This is on the provider\'s side, not yours — wait a few minutes, then resume.',
    },
    budget: {
      title: 'Paused — budget cap reached',
      body: 'Raise the cap or resume without one to keep going.',
    },
    consecutive_failures: {
      title: 'Paused — 3 files failed in a row',
      body: 'Something may be systemic (a bad file type, a domain issue). Check the errors below before resuming.',
    },
    interrupted: {
      title: 'Paused — the app restarted mid-batch',
      body: 'The interrupted file will be re-run from the start. Re-ingesting is safe and idempotent — resume when ready.',
    },
    locked: {
      title: 'Paused — this domain is locked',
      body: 'Another process is writing to this domain right now. Resume once it finishes.',
    },
    user: {
      title: 'Paused',
      body: "Resume whenever you're ready.",
    },
  };
  return table[reason] || { title: 'Paused', body: "Resume whenever you're ready." };
}

// Per-item status pill label + CSS class.
function statusPillMeta(status) {
  const table = {
    pending: { label: 'Waiting', cls: 'queue-pill-pending' },
    running: { label: 'Running', cls: 'queue-pill-running' },
    done:    { label: 'Done',    cls: 'queue-pill-done' },
    failed:  { label: 'Failed',  cls: 'queue-pill-failed' },
    skipped: { label: 'Skipped', cls: 'queue-pill-skipped' },
  };
  return table[status] || { label: 'Waiting', cls: 'queue-pill-pending' };
}

// Resolve the ordered "files that will actually be ingested" list for the
// confirm-gate preview from the /estimate response. The frozen contract only
// pins files.rejected's shape ({name,reason}[]); files.accepted's shape is
// not further specified, so this defensively accepts an array of strings, an
// array of {name, size|bytes} objects, or — if the field is absent/not an
// array — falls back to the browser's own selection order. That fallback is
// explicitly marked `ordered:false`: it is NOT guaranteed to match the
// backend's largest-first execution order, so callers must not present it as
// authoritative.
function resolveEstimateFileList(estimate, localFiles) {
  const accepted = estimate && estimate.files && estimate.files.accepted;
  const local = Array.isArray(localFiles) ? localFiles : [];
  const sizeByName = new Map(local.map(f => [f && f.name, f && f.size]));

  if (Array.isArray(accepted)) {
    return accepted.map(entry => {
      if (typeof entry === 'string') {
        return { name: entry, bytes: sizeByName.has(entry) ? sizeByName.get(entry) : null, ordered: true };
      }
      if (entry && typeof entry === 'object') {
        const name = typeof entry.name === 'string' ? entry.name : '';
        const bytes = typeof entry.size === 'number' ? entry.size
                    : typeof entry.bytes === 'number' ? entry.bytes
                    : (sizeByName.has(name) ? sizeByName.get(name) : null);
        return { name, bytes, ordered: true };
      }
      return { name: String(entry), bytes: null, ordered: true };
    });
  }

  return local.map(f => ({ name: f && f.name, bytes: f && f.size, ordered: false }));
}

// 409 "a batch is already running" responses "name the active jobId" per the
// contract, without pinning the exact field name — defensively check the
// shapes a Node/Express JSON body would plausibly use.
function extractConflictJobId(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.jobId === 'string' && data.jobId) return data.jobId;
  if (typeof data.activeJobId === 'string' && data.activeJobId) return data.activeJobId;
  if (data.job && typeof data.job.jobId === 'string' && data.job.jobId) return data.job.jobId;
  return null;
}

// Summarise a job's Health scan counts (job.health.counts) into a short,
// human-readable line. Unknown/absent keys are silently skipped rather than
// dumped as raw JSON — this mirrors the labels already used elsewhere for
// the same counts shape (see renderHealthReport).
function formatHealthCounts(counts) {
  if (!counts || typeof counts !== 'object') return '';
  const labels = {
    brokenLinks: 'broken links', orphans: 'orphans',
    folderPrefixLinks: 'folder-prefix links', crossFolderDupes: 'cross-folder duplicates',
    hyphenVariants: 'hyphen variants', missingBacklinks: 'missing backlinks',
  };
  const parts = [];
  for (const key of Object.keys(labels)) {
    const v = counts[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) parts.push(`${v} ${labels[key]}`);
  }
  return parts.join(', ');
}

// Neutralises Unicode bidi-control codepoints (RLO/LRO/RLE/LRE/PDF/
// RLI/LRI/FSI/PDI/RLM/LRM) in a user-controlled filename before display.
// Filenames here are 100% attacker-controlled and never sanitised
// server-side; a bidi-override character can visually reorder the
// rendered text (e.g. making "evil<RLO>fdp.exe" DISPLAY as
// "evilexe.pdf") without being any kind of markup — escHtml (which only
// handles &/</>/") would pass it straight through unchanged. This is a
// display-integrity fix, not an XSS one: no auditor found an injection
// vector here, and every user-controlled string in this file's HTML
// builders already goes through escHtml.
const BIDI_CONTROL_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
function sanitizeDisplayName(str) {
  return String(str == null ? '' : str).replace(BIDI_CONTROL_RE, '\uFFFD');
}

// ── Pure HTML-string builders (also extracted + unit-tested; escHtml is
//    included in the test's combined eval scope so these resolve exactly as
//    they do in the app) ─────────────────────────────────────────────────

function queueFileListItemHtml(entry) {
  const name = escHtml(sanitizeDisplayName(entry && entry.name != null ? entry.name : ''));
  const size = formatQueueBytes(entry && entry.bytes);
  return `<li class="queue-file-item"><span class="queue-file-name">${name}</span><span class="queue-file-size">${size}</span></li>`;
}

function queueRejectedItemHtml(entry) {
  const name = escHtml(sanitizeDisplayName(entry && entry.name != null ? entry.name : ''));
  const reason = escHtml(entry && entry.reason != null ? entry.reason : 'not supported');
  return `<li class="queue-file-item queue-file-rejected"><span class="queue-file-name">${name}</span><span class="queue-file-reason">${reason}</span></li>`;
}

function queueItemRowHtml(item) {
  const idx = item && Number.isFinite(item.idx) ? item.idx : 0;
  const name = escHtml(sanitizeDisplayName(item && item.name != null ? item.name : ''));
  const size = formatQueueBytes(item && item.bytes);
  const meta = statusPillMeta(item && item.status);
  const isRunning = item && item.status === 'running';
  const errorLine = (item && item.status === 'failed' && item.error)
    ? `<div class="queue-item-error">${escHtml(item.error)}</div>` : '';
  const pages = item && item.result && Number.isFinite(item.result.pagesWritten) ? item.result.pagesWritten : null;
  const resultLine = (item && item.status === 'done' && item.result)
    ? `<div class="queue-item-result">${escHtml(sanitizeDisplayName(item.result.title || item.name || ''))} — ${pages == null ? 0 : pages} page${pages === 1 ? '' : 's'}</div>`
    : '';
  return `<li class="queue-item-row" data-queue-idx="${idx}">
    <div class="queue-item-head">
      <span class="queue-item-name">${name}</span>
      <span class="queue-item-size">${size}</span>
      <span class="queue-item-pill ${meta.cls}">${meta.label}</span>
    </div>
    <div class="queue-item-progress-track${isRunning ? '' : ' hidden'}"><div class="queue-item-progress-fill" style="width:0%"></div></div>
    <div class="queue-item-progress-msg"></div>
    ${errorLine}
    ${resultLine}
  </li>`;
}

function queuePausedBannerHtml(job) {
  const copy = pausedReasonCopy(job && job.pausedReason);
  const detail = (job && typeof job.pausedMessage === 'string' && job.pausedMessage)
    ? `<div class="queue-paused-detail">${escHtml(job.pausedMessage)}</div>` : '';
  return `<div class="queue-paused-banner">
    <div class="queue-paused-title">${escHtml(copy.title)}</div>
    <div class="queue-paused-body">${escHtml(copy.body)}</div>
    ${detail}
  </div>`;
}

// Buckets every item into exactly one status count. This is deliberately
// NOT "count done + count failed + count skipped" — that shape lets an
// item in ANY other state (still 'running' on a batch the server reports
// terminal, a future status, a malformed item) vanish from the summary
// with no trace: the done-summary would read "2 done, 0 failed, 0
// skipped" for a 3-item batch and the missing item would simply never be
// mentioned (H1). Because every item is placed in exactly one bucket here
// — the three known ones, or `other` keyed by its literal status string —
// `known.done + known.failed + known.skipped + sum(other values)` is
// ALWAYS === items.length, by construction, regardless of what statuses
// the server ever sends.
function computeQueueStatusCounts(items) {
  const list = Array.isArray(items) ? items : [];
  const known = { done: 0, failed: 0, skipped: 0 };
  const other = {};
  for (const i of list) {
    const s = (i && typeof i.status === 'string' && i.status) ? i.status : 'unknown';
    if (Object.prototype.hasOwnProperty.call(known, s)) known[s]++;
    else other[s] = (other[s] || 0) + 1;
  }
  return { known, other, total: list.length };
}

function queueDoneSummaryHtml(job) {
  const items = Array.isArray(job && job.items) ? job.items : [];
  const counts = computeQueueStatusCounts(items);
  const doneN = counts.known.done;
  const failedN = counts.known.failed;
  const skippedN = counts.known.skipped;

  // Round-2 audit item 4a: a CANCELLED batch's untouched items are still
  // sitting at 'pending' on the server (cancel doesn't relabel them), even
  // though the cancel confirm told the user "anything not started yet is
  // skipped". That is the batch behaving exactly as asked, not an
  // anomaly, so it must not render through the amber unaccounted styling —
  // the whole point of that styling is to flag states the user did NOT
  // expect. A FAILED job's leftover pending items (e.g. the domain became
  // unusable before any item ran) are genuinely unexpected and keep the
  // amber treatment; only 'cancelled' gets this carve-out.
  const isCancelled = job && job.status === 'cancelled';
  const notStartedN = isCancelled ? (counts.other.pending || 0) : 0;
  // Anything else outside the three known buckets still renders as its own
  // labelled, visibly-flagged span instead of being silently dropped from
  // the total — this is the mechanism that caught the real H1 bug; only
  // the cancelled+pending combination above is special-cased out of it.
  const otherSpans = Object.keys(counts.other)
    .filter(k => !(isCancelled && k === 'pending'))
    .sort()
    .map(k => `<span class="queue-done-unaccounted">${counts.other[k]} ${escHtml(k)}</span>`)
    .join('');
  const notStartedSpan = notStartedN > 0
    ? `<span>${notStartedN} not started</span>` : '';

  const pages = items.reduce((sum, i) => {
    const p = i && i.result && Number.isFinite(i.result.pagesWritten) ? i.result.pagesWritten : 0;
    return sum + p;
  }, 0);
  const warningsN = items.reduce((sum, i) => {
    const w = i && i.result && Number.isFinite(i.result.warningCount) ? i.result.warningCount : 0;
    return sum + w;
  }, 0);
  const spent = (job && typeof job.spentUsd === 'number' && Number.isFinite(job.spentUsd))
    ? `$${job.spentUsd.toFixed(4)}` : '—';
  const healthStr = formatHealthCounts(job && job.health && job.health.counts);
  const healthLine = (job && job.health)
    ? `<div class="queue-done-health">Health scan: ${healthStr ? escHtml(healthStr) : 'no issues found'} — see the <strong>Health</strong> tab.</div>`
    : '';
  // Round-2 audit item 1 (MUST FIX): a job-level failure (domain deleted,
  // renamed, or converted to a read-only Shared Brain mirror while the
  // batch sat paused) sets job.failReason server-side and the whole batch
  // stops — but nothing rendered it, so a 30-file batch could do nothing
  // and say nothing under a panel headed "Finished". job.failReason is a
  // server-composed string (see assertDomainUsable / the settleJob call in
  // ingest-queue.js) — escaped like every other server string here.
  const failReasonLine = (job && job.status === 'failed' && typeof job.failReason === 'string' && job.failReason)
    ? `<div class="queue-done-fail-reason"><strong>Batch failed:</strong> ${escHtml(job.failReason)}</div>`
    : '';
  return `<div class="queue-done-summary">
    ${failReasonLine}
    <div class="queue-done-totals">
      <span>${doneN} done</span>
      <span>${failedN} failed</span>
      <span>${skippedN} skipped</span>
      ${notStartedSpan}
      ${otherSpans}
      <span>${pages} page${pages === 1 ? '' : 's'} written</span>
      <span>${warningsN} warning${warningsN === 1 ? '' : 's'}</span>
      <span>${spent} spent</span>
    </div>
    ${healthLine}
  </div>`;
}

// ── DOM-coupled render + control functions (browser-verified; not unit-
//    tested directly — the pure builders above carry the tested logic) ────

function handleSelectedFiles(files) {
  const list = Array.from(files || []);
  if (list.length === 0) return;
  if (list.length === 1) {
    // Single file: the existing, unchanged flow. Clear any queue state so a
    // stale confirm gate from a previous multi-select can't linger.
    resetQueueSelection();
    setFile(list[0]);
    return;
  }
  // 2+ files: the batch queue path. `selectedFile`/`ingestBtn` are left
  // alone in their "nothing chosen" state — ingestBtn stays disabled and
  // selectedFile stays null — so submitIngest() (the single-file path)
  // cannot fire for a multi-file selection.
  selectedFile = null;
  fileNameEl.textContent = '';
  ingestBtn.disabled = true;
  hideEl(ingestStatus);
  hideEl(ingestResult);
  hideDuplicateBanner();
  startQueueSelection(list);
}

function resetQueueSelection() {
  selectedFiles = [];
  queueEstimate = null;
  hideEl(queueStatusEl);
  hideEl(queueConfirmEl);
  if (queueConfirmEl) queueConfirmEl.innerHTML = '';
  // Clear a FINISHED batch's report so it doesn't linger next to an
  // unrelated single-file selection — but never hide a batch that's still
  // actually live (running/paused): its panel keeps rendering regardless
  // of whatever the user does in the file picker meanwhile. Round-2 audit
  // item 2 corrected the OLD version of this comment, which claimed the
  // user could freely ingest a different file "in parallel" — true only
  // for a DIFFERENT domain. Looking at (or even choosing) a file here is
  // always fine; refreshIngestBtnAvailability() is what actually refuses
  // the submit if the selected domain matches the live batch's domain.
  const isLiveJob = queueJobId && _queueLastStatus
    && _queueLastStatus !== 'done' && _queueLastStatus !== 'cancelled' && _queueLastStatus !== 'failed';
  if (!isLiveJob) {
    hideEl(queuePanelEl);
    if (queuePanelEl) queuePanelEl.innerHTML = '';
    queueJobId = null;
  }
}

async function startQueueSelection(files) {
  selectedFiles = files;
  queueEstimate = null;
  hideEl(queueConfirmEl);
  hideEl(queuePanelEl);
  showStatus(queueStatusEl, 'loading', `Estimating cost for ${files.length} files…`);
  const domain = document.getElementById('ingest-domain')?.value;
  try {
    const body = { domain, files: files.map(f => ({ name: f.name, size: f.size })) };
    const res = await fetch(`${QUEUE_API}/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Could not estimate cost (HTTP ${res.status})`);
    queueEstimate = data;
    hideEl(queueStatusEl);
    renderQueueConfirm();
  } catch (err) {
    hideEl(queueConfirmEl);
    showStatus(queueStatusEl, 'error', err.message);
  }
}

// Re-estimate if the user changes domain while still at the confirm gate
// (a different domain means a different index size and a different cost).
// Never fires once a job exists — the domain is fixed at that point.
// Also re-evaluates the single-file Ingest button (round-2 audit item 2):
// switching TO a domain with a live batch must disable it; switching AWAY
// from one must re-enable it if a file is already selected.
document.getElementById('ingest-domain')?.addEventListener('change', () => {
  if (selectedFiles.length > 1 && !queueJobId) startQueueSelection(selectedFiles);
  refreshIngestBtnAvailability();
});

function renderQueueConfirm() {
  if (!queueConfirmEl || !queueEstimate) return;
  const est = queueEstimate;
  const fileList = resolveEstimateFileList(est, selectedFiles);
  const rejected = Array.isArray(est.files && est.files.rejected) ? est.files.rejected : [];
  const count = (est.files && Number.isFinite(est.files.count)) ? est.files.count : fileList.length;
  const totalBytes = est.files && est.files.totalBytes;
  const provider = escHtml(est.provider || 'unknown provider');
  const model = escHtml(est.model || 'unknown model');
  const est2 = est.estimate || {};
  const costRange = formatUsdRange(est2.usdLow, est2.usdHigh);
  const tokIn = formatTokenRange(est2.inputTokensLow, est2.inputTokensHigh);
  const tokOut = formatTokenRange(est2.outputTokensLow, est2.outputTokensHigh);
  const basis = escHtml(est2.basis || '');
  const warnings = Array.isArray(est.warnings) ? est.warnings : [];

  queueConfirmEl.innerHTML = `
    <div class="queue-confirm-head">
      <h3>Batch ingest — ${count} file${count === 1 ? '' : 's'}</h3>
      <div class="queue-confirm-sub">${formatQueueBytes(totalBytes)} total · ${provider} · ${model}</div>
    </div>
    ${rejected.length ? `
      <div class="queue-rejected">
        <div class="queue-section-label">Won't be included</div>
        <ul class="queue-file-list">${rejected.map(queueRejectedItemHtml).join('')}</ul>
      </div>` : ''}
    <div class="queue-file-section">
      <div class="queue-section-label">Will be ingested (largest first)</div>
      <ul class="queue-file-list">${fileList.map(queueFileListItemHtml).join('')}</ul>
    </div>
    <div class="queue-estimate">
      <div class="queue-estimate-row"><span>Estimated cost</span><strong>${escHtml(costRange)}</strong></div>
      <div class="queue-estimate-row"><span>Estimated tokens</span><span>${escHtml(tokIn)} in / ${escHtml(tokOut)} out</span></div>
      ${basis ? `<div class="queue-estimate-basis">${basis}</div>` : ''}
    </div>
    ${warnings.length ? `<div class="queue-warnings">${warnings.map(w => `<div>${escHtml(String(w))}</div>`).join('')}</div>` : ''}
    <div class="form-group inline queue-budget-row">
      <label for="queue-budget-input">Budget cap (optional)</label>
      <input type="number" id="queue-budget-input" min="0" step="0.01" placeholder="No cap" />
    </div>
    <label class="queue-overwrite-row"><input type="checkbox" id="queue-overwrite-input" /> Overwrite existing pages for files already ingested</label>
    <div class="queue-confirm-actions">
      <button class="btn primary pill" id="queue-start-btn">Start batch</button>
      <button class="btn" id="queue-cancel-select-btn">Cancel</button>
    </div>
  `;
  showEl(queueConfirmEl);
  hideEl(queuePanelEl);

  document.getElementById('queue-start-btn')?.addEventListener('click', beginQueueJob);
  document.getElementById('queue-cancel-select-btn')?.addEventListener('click', resetQueueSelection);
}

async function beginQueueJob() {
  if (!selectedFiles.length) return;
  const startBtn = document.getElementById('queue-start-btn');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Uploading…'; }
  const domain = document.getElementById('ingest-domain')?.value;
  const overwrite = !!document.getElementById('queue-overwrite-input')?.checked;
  const budgetRaw = document.getElementById('queue-budget-input')?.value;
  const budgetUsd = (budgetRaw !== '' && budgetRaw != null && Number.isFinite(Number(budgetRaw)))
    ? Number(budgetRaw) : null;

  const formData = new FormData();
  formData.append('domain', domain);
  if (overwrite) formData.append('overwrite', 'true');
  if (budgetUsd != null) formData.append('budgetUsd', String(budgetUsd));
  for (const f of selectedFiles) formData.append('files', f);

  try {
    const res = await fetch(QUEUE_API, { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      const activeId = extractConflictJobId(data);
      throw new Error(activeId
        ? `A batch is already running (job ${activeId}). Wait for it to finish, or check the panel below.`
        : (data.error || 'A batch is already running on this domain.'));
    }
    if (!res.ok || !data.ok || !data.jobId) throw new Error(data.error || `Could not start the batch (HTTP ${res.status})`);

    const startRes = await fetch(`${QUEUE_API}/${encodeURIComponent(data.jobId)}/start`, { method: 'POST' });
    const startData = await startRes.json().catch(() => ({}));
    if (!startRes.ok || !startData.ok) throw new Error(startData.error || `Could not start the batch (HTTP ${startRes.status})`);

    // Uploaded + started — the confirm gate's job is done; everything from
    // here is driven by job snapshots.
    hideEl(queueConfirmEl);
    if (queueConfirmEl) queueConfirmEl.innerHTML = '';
    selectedFiles = [];
    if (fileInput) fileInput.value = '';
    showEl(queuePanelEl);
    attachQueueStream(data.jobId);
  } catch (err) {
    showStatus(queueStatusEl, 'error', err.message);
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Start batch'; }
  }
}

function detachQueueStream() {
  if (queueStreamAbort) {
    queueStreamAbort.abort();
    queueStreamAbort = null;
  }
}

// `domain` is only ever consulted on ENTER. On EXIT the key that was
// actually stored at entry time (_queueBusyDomain) is used instead —
// whatever `domain` this call was passed is ignored, so a caller cannot
// accidentally release the wrong slot no matter what it reads from the
// dropdown at that moment. This is the fix for H2.
function applyQueueBusyForStatus(nextStatus, domain) {
  const decision = queueBusyTransition(_queueLastStatus, nextStatus);
  if (decision === 'enter') {
    // Defensive: a slot should never already be held here (the prevStatus
    // latch above only fires 'enter' from a non-busy state), but if it
    // somehow were, releasing it before overwriting the key prevents that
    // slot from being orphaned rather than silently leaking it.
    if (_queueBusyDomain !== null && typeof window.__curatorIngestEnd === 'function') {
      window.__curatorIngestEnd(_queueBusyDomain);
    }
    _queueBusyDomain = domain;
    if (typeof window.__curatorIngestStart === 'function') window.__curatorIngestStart(domain);
  } else if (decision === 'exit') {
    const key = _queueBusyDomain;
    _queueBusyDomain = null;
    if (key !== null && typeof window.__curatorIngestEnd === 'function') window.__curatorIngestEnd(key);
  }
  _queueLastStatus = nextStatus;
}

// THE single chokepoint every job snapshot flows through — SSE 'job'/'done'
// events, POST start/pause/cancel responses, and GET refreshes all end up
// here. Updates the busy gate, then rebuilds the whole panel from the
// snapshot. No other function in this file calls renderQueuePanel or the
// busy-gate helpers directly.
function applyQueueJobSnapshot(job) {
  if (!job) return;
  queueJobId = job.jobId || queueJobId;
  const domain = job.domain || document.getElementById('ingest-domain')?.value;
  applyQueueBusyForStatus(job.status, domain);
  renderQueuePanel(job);
  // Structural guarantee for the "entering with a dead stream" defect: the
  // busy gate is only ever RELEASED inside attachQueueStream's `finally`
  // (see the comment on that function). A snapshot can report 'running'
  // from a source that never attaches a stream in THIS tab — a GET refresh
  // (refreshQueueJob, e.g. the cancel-confirm's "Never mind"), a pause/
  // resume POST response, or a second browser tab that only ever polls.
  // Any of those would enter the gate above with no path that will ever
  // exit it. So: whenever a snapshot says the job is running and this tab
  // has no live stream attached, attach one now — guaranteeing every
  // 'enter' this tab performs is paired with a stream whose `finally` will
  // eventually release it, regardless of which call site produced the
  // snapshot.
  if (job.status === 'running' && !queueStreamAbort && job.jobId) {
    attachQueueStream(job.jobId);
  }
}

async function attachQueueStream(jobId) {
  detachQueueStream(); // tear down any prior connection first (also releases its busy state via its own finally)
  queueJobId = jobId;
  const controller = new AbortController();
  queueStreamAbort = controller;
  const domain = document.getElementById('ingest-domain')?.value;
  try {
    const res = await fetch(`${QUEUE_API}/${encodeURIComponent(jobId)}/stream`, { signal: controller.signal });
    if (!res.body) throw new Error('Stream unavailable for this job');

    // Same reader-loop shape as submitIngest() above: split on '\n', read
    // 'data: ' lines. Deliberately NOT the '\n\n'-chunk parser used by the
    // semantic-dupe batch merge elsewhere in this file.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === 'job' && ev.job) {
          applyQueueJobSnapshot(ev.job);
        } else if (ev.type === 'item-progress') {
          updateQueueItemProgress(ev.idx, ev.pct, ev.message);
        } else if (ev.type === 'done' && ev.job) {
          applyQueueJobSnapshot(ev.job);
          break outer;
        }
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // detached on purpose (nav-away / re-attach)
    renderQueueStreamError(err && err.message ? err.message : 'Lost connection to the batch.');
  } finally {
    // Always release the busy gate here, exactly once, regardless of how the
    // stream ended (done event, thrown error, or abort) — mirrors
    // submitIngest()'s own finally block above. `domain` (read from the
    // dropdown when this attach began) is passed only as a same-tick
    // fallback for the "somehow never entered" edge case; the real release
    // key is whatever applyQueueBusyForStatus recorded at ENTER time
    // (_queueBusyDomain), which it uses instead — see that function.
    applyQueueBusyForStatus(null, domain);
    if (queueStreamAbort === controller) queueStreamAbort = null;
  }
}

function renderQueueStreamError(msg) {
  if (!queuePanelEl) return;
  let banner = queuePanelEl.querySelector('.queue-stream-error');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'queue-stream-error status error';
    queuePanelEl.insertBefore(banner, queuePanelEl.firstChild);
  }
  banner.textContent = msg;
}

// Item-progress SSE event: {idx, pct, message} only, no full job — the one
// documented exception to "render from a snapshot" (see the section header
// comment). Targeted update of a single row; every other part of the panel
// is still rebuilt wholesale by renderQueuePanel.
function updateQueueItemProgress(idx, pct, message) {
  if (!queuePanelEl || !Number.isFinite(idx)) return;
  const row = queuePanelEl.querySelector(`[data-queue-idx="${idx}"]`);
  if (!row) return;
  const track = row.querySelector('.queue-item-progress-track');
  const fill = row.querySelector('.queue-item-progress-fill');
  const msgEl = row.querySelector('.queue-item-progress-msg');
  if (track) track.classList.remove('hidden');
  if (fill && Number.isFinite(pct)) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (msgEl) msgEl.textContent = typeof message === 'string' ? message : '';
}

function renderQueuePanel(job) {
  if (!queuePanelEl || !job) return;
  hideEl(queueConfirmEl);
  showEl(queuePanelEl);

  const domainSelect = document.getElementById('ingest-domain');
  const isTerminal = job.status === 'done' || job.status === 'cancelled' || job.status === 'failed';
  if (domainSelect) domainSelect.disabled = !isTerminal;

  const items = Array.isArray(job.items) ? job.items : [];
  const settledCount = items.filter(i => i && (i.status === 'done' || i.status === 'failed' || i.status === 'skipped')).length;
  const spent = Number.isFinite(job.spentUsd) ? job.spentUsd : 0;

  const headerHtml = `
    <div class="queue-panel-head">
      <div class="queue-panel-title">Batch ingest — ${escHtml(job.domain || '')}</div>
      <div class="queue-panel-sub">${isTerminal ? 'Finished' : `Item ${Math.min(settledCount + 1, items.length)} of ${items.length}`} · $${spent.toFixed(4)} spent</div>
    </div>
  `;

  const pausedHtml = job.status === 'paused' ? queuePausedBannerHtml(job) : '';
  const doneHtml = isTerminal ? queueDoneSummaryHtml(job) : '';

  const controlsHtml = isTerminal ? '' : `
    <div class="queue-panel-controls">
      ${job.status === 'running'
        ? `<button class="btn" id="queue-pause-btn">Pause</button>`
        : `<button class="btn primary" id="queue-resume-btn">${job.status === 'pending' ? 'Start' : 'Resume'}</button>`}
      <button class="btn" id="queue-cancel-btn">Cancel</button>
    </div>
  `;

  const listHtml = `<ul class="queue-item-list">${items.map(queueItemRowHtml).join('')}</ul>`;

  queuePanelEl.innerHTML = `${headerHtml}${pausedHtml}${doneHtml}${controlsHtml}${listHtml}`;

  document.getElementById('queue-pause-btn')?.addEventListener('click', () => pauseQueueJob(job.jobId));
  document.getElementById('queue-resume-btn')?.addEventListener('click', () => resumeQueueJob(job.jobId));
  document.getElementById('queue-cancel-btn')?.addEventListener('click', () => confirmCancelQueueJob(job.jobId));

  if (isTerminal) {
    // A finished batch just wrote/changed pages across (possibly) many
    // files — refresh the same signals a single ingest refreshes.
    loadDomainList().catch(() => {});
    refreshSyncPendingBadge();
  }
}

async function pauseQueueJob(jobId) {
  const btn = document.getElementById('queue-pause-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Pausing…'; }
  try {
    const res = await fetch(`${QUEUE_API}/${encodeURIComponent(jobId)}/pause`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Could not pause (HTTP ${res.status})`);
    if (data.job) applyQueueJobSnapshot(data.job);
  } catch (err) {
    renderQueueStreamError(err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Pause'; }
  }
}

async function resumeQueueJob(jobId) {
  const btn = document.getElementById('queue-resume-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  try {
    const res = await fetch(`${QUEUE_API}/${encodeURIComponent(jobId)}/start`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Could not resume (HTTP ${res.status})`);
    if (data.job) applyQueueJobSnapshot(data.job);
    // Round-2 audit item 3 (regression this track introduced): if the
    // snapshot above already reported 'running', applyQueueJobSnapshot's
    // own auto-attach (added for the H2 fix) has ALREADY called
    // attachQueueStream and — synchronously, before any `await` inside it
    // — set queueStreamAbort. Attaching again here unconditionally opened
    // a SECOND stream, whose detachQueueStream() aborted the first one
    // mid-flight and briefly (self-healing within one localhost RTT, but
    // still a real gap) fired the busy gate's exit while the batch was
    // still running. Only attach here if nothing is attached yet — the
    // case this line exists for is data.job NOT yet reporting 'running'
    // (e.g. still 'pending' the instant after /start), where the
    // auto-attach never fired.
    if (!queueStreamAbort) attachQueueStream(jobId);
  } catch (err) {
    renderQueueStreamError(err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Resume'; }
  }
}

// Inline confirm (no window.confirm/alert anywhere in this codebase — see
// the Shared Brain disconnect/synthesize confirms for the same pattern).
function confirmCancelQueueJob(jobId) {
  const controls = queuePanelEl?.querySelector('.queue-panel-controls');
  if (!controls) return;
  controls.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = 'Cancel this batch? Items already ingested stay in the wiki; anything not started yet is skipped. ';
  const yes = document.createElement('button');
  yes.className = 'btn';
  yes.textContent = 'Yes, cancel';
  const no = document.createElement('button');
  no.className = 'btn';
  no.textContent = 'Never mind';
  controls.append(text, yes, document.createTextNode(' '), no);
  no.addEventListener('click', () => refreshQueueJob(jobId));
  yes.addEventListener('click', async () => {
    yes.disabled = true; no.disabled = true;
    try {
      const res = await fetch(`${QUEUE_API}/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not cancel (HTTP ${res.status})`);
      if (data.job) applyQueueJobSnapshot(data.job);
    } catch (err) {
      renderQueueStreamError(err.message);
    }
  });
}

async function refreshQueueJob(jobId) {
  try {
    const res = await fetch(`${QUEUE_API}/${encodeURIComponent(jobId)}`);
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok && data.job) applyQueueJobSnapshot(data.job);
  } catch { /* leave the current panel as-is */ }
}

// Resume-on-return (spec §5): called on app load and on every Ingest-tab
// entry. If an active (non-terminal) job exists, render it immediately from
// the GET snapshot, then reattach the live SSE stream only if it's actually
// running — a paused/pending job is rendered statically with its own
// Resume/Start button, which reattaches the stream when clicked.
async function checkActiveQueueJob() {
  try {
    const res = await fetch(`${QUEUE_API}/active`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.job) return;
    const job = data.job;
    showEl(queuePanelEl);
    renderQueuePanel(job);
    queueJobId = job.jobId;
    if (job.status === 'running') {
      attachQueueStream(job.jobId);
    } else {
      _queueLastStatus = job.status; // keep the busy-gate bookkeeping honest with no live stream attached
    }
  } catch { /* non-critical — the Ingest tab just won't show a resumed batch */ }
}

// ── CHAT TAB ──────────────────────────────────────────────────────────────────
const chatDomainEl   = document.getElementById('chat-domain');
const newChatBtn     = document.getElementById('new-chat-btn');
const convListEl     = document.getElementById('conversation-list');
const chatEmptyEl    = document.getElementById('chat-empty');
const chatThreadEl   = document.getElementById('chat-thread');
const chatThreadHeader = document.getElementById('chat-thread-header');
const chatThreadTitleText = document.getElementById('chat-thread-title-text');
const compileBtn     = document.getElementById('compile-btn');
const compileProgressEl = document.getElementById('compile-progress');
const compileProgressLabel = document.getElementById('compile-progress-label');
const compileProgressPct = document.getElementById('compile-progress-pct');
const compileProgressFill = document.getElementById('compile-progress-fill');
const chatInputEl    = document.getElementById('chat-input');
const chatSendBtn    = document.getElementById('chat-send-btn');

let activeConvId   = null;   // currently open conversation ID
let chatDomain     = null;   // currently selected domain
let chatBusy       = false;  // prevents double-sends

// ── Composer selectors: Length (Tier 2) + Model (per-chat provider) ───────────
// Both are dropdowns in the unified composer. Length is always shown; Model is
// shown only when BOTH provider keys are configured. Choices persist in
// localStorage and are sent with each message; the backend normalises anything
// unknown (length → 'balanced'; a keyless/absent provider → the global default).
const CHAT_STYLE_KEY = 'curator-chat-response-style';
const CHAT_MODEL_KEY = 'curator-chat-model-provider';
const CHAT_STYLES = ['concise', 'balanced', 'comprehensive'];
const STYLE_LABELS = { concise: 'Concise', balanced: 'Balanced', comprehensive: 'Detailed' };
const PROVIDER_LABELS = { gemini: 'Gemini', anthropic: 'Claude' };

let chatResponseStyle = (() => {
  try {
    const saved = localStorage.getItem(CHAT_STYLE_KEY);
    return CHAT_STYLES.includes(saved) ? saved : 'balanced';
  } catch { return 'balanced'; }
})();
// null → use the global active provider (also the state when only one key exists).
let chatModelProvider = null;
let chatAvailableProviders = [];   // populated from /api/config/api-keys

// Close every open composer dropdown. One module-level pair of document
// listeners (added once) handles outside-click + Escape for ALL dropdowns, so
// re-running initChatModelSelector never stacks duplicate document handlers.
function closeAllChatDropdowns() {
  document.querySelectorAll('.chat-dd.open').forEach(dd => {
    dd.classList.remove('open');
    const b = dd.querySelector('.chat-dd-btn'); if (b) b.setAttribute('aria-expanded', 'false');
    const m = dd.querySelector('.chat-dd-menu'); if (m) m.hidden = true;
  });
}
document.addEventListener('click', (e) => { if (!e.target.closest('.chat-dd')) closeAllChatDropdowns(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllChatDropdowns(); });

// Generic dropdown wiring: toggle open, close on select. IDEMPOTENT — a
// data-wired flag prevents double-binding the button/menu listeners when
// initChatModelSelector re-runs (e.g. after a key change).
function wireDropdown(ddId, btnId, menuId, onSelect) {
  const dd = document.getElementById(ddId);
  const btn = document.getElementById(btnId);
  const menu = document.getElementById(menuId);
  if (!dd || !btn || !menu || dd.dataset.wired === '1') return;
  dd.dataset.wired = '1';
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); dd.classList.remove('open'); };
  const open = () => { closeAllChatDropdowns(); menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); dd.classList.add('open'); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden ? open() : close(); });
  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('.chat-dd-opt');
    if (!opt) return;
    onSelect(opt);
    close();
  });
}

function applyStyleLabel() {
  const v = document.getElementById('chat-length-value');
  if (v) v.textContent = STYLE_LABELS[chatResponseStyle] || 'Balanced';
  document.querySelectorAll('#chat-length-menu .chat-dd-opt').forEach(o =>
    o.classList.toggle('is-active', o.dataset.style === chatResponseStyle));
}

function applyModelLabel() {
  const v = document.getElementById('chat-model-value');
  const shown = chatModelProvider || chatAvailableProviders[0] || 'gemini';
  if (v) v.textContent = PROVIDER_LABELS[shown] || shown;
  document.querySelectorAll('#chat-model-menu .chat-dd-opt').forEach(o =>
    o.classList.toggle('is-active', o.dataset.provider === shown));
}

// Build the model dropdown from configured providers. Shown ONLY when both keys
// exist (nothing to choose otherwise). Called after fetching /api/config/api-keys.
async function initChatModelSelector() {
  const dd = document.getElementById('chat-model-dd');
  const menu = document.getElementById('chat-model-menu');
  if (!dd || !menu) return;
  let data = {};
  try { data = await (await fetch('/api/config/api-keys')).json(); } catch { data = {}; }
  // Availability = SAVED SETTINGS KEYS (config), so the dropdown mirrors exactly
  // what the user has connected in Settings. NOT the "usable" (config OR .env)
  // flags — a key Disconnected in Settings but still in .env must NOT appear here
  // (and the backend's normalizeChatProvider gates on the same config state).
  const providers = [];
  if (data.hasGeminiKey) providers.push('gemini');
  if (data.hasAnthropicKey) providers.push('anthropic');
  chatAvailableProviders = providers;
  const models = data.models || {};

  if (providers.length < 2) {
    // Nothing to choose — hide the selector; chat uses the global active provider.
    dd.hidden = true;
    chatModelProvider = null;
    return;
  }

  // Default: saved choice (if still valid) → the global active provider → first available.
  let saved = null;
  try { saved = localStorage.getItem(CHAT_MODEL_KEY); } catch { /* ignore */ }
  chatModelProvider = providers.includes(saved) ? saved
    : (providers.includes(data.activeProvider) ? data.activeProvider : providers[0]);

  menu.innerHTML = providers.map(p => `
    <button type="button" class="chat-dd-opt" role="option" data-provider="${p}">
      <span class="chat-dd-opt-title">${PROVIDER_LABELS[p] || p}</span>
      <span class="chat-dd-opt-desc">${escHtml(models[p] || '')}</span>
    </button>`).join('');

  dd.hidden = false;
  // onSelect validates against the LIVE provider list (chatAvailableProviders),
  // not a closure snapshot — so re-running init with changed keys stays correct
  // even though wireDropdown binds the listener only once.
  wireDropdown('chat-model-dd', 'chat-model-btn', 'chat-model-menu', (opt) => {
    const p = opt.dataset.provider;
    if (!chatAvailableProviders.includes(p)) return;
    chatModelProvider = p;
    try { localStorage.setItem(CHAT_MODEL_KEY, p); } catch { /* ignore */ }
    applyModelLabel();
  });
  applyModelLabel();
}

// Length dropdown (always present).
wireDropdown('chat-length-dd', 'chat-length-btn', 'chat-length-menu', (opt) => {
  const style = opt.dataset.style;
  if (!CHAT_STYLES.includes(style)) return;
  chatResponseStyle = style;
  try { localStorage.setItem(CHAT_STYLE_KEY, style); } catch { /* ignore */ }
  applyStyleLabel();
});
applyStyleLabel();
initChatModelSelector();
let compileBusy    = false;  // prevents double-compiles
// Show "Compile to Wiki" after the first answer — one good exchange is enough
// to be worth saving (v3.0.1-beta.15; backend MIN_USER_MESSAGES matches).
const COMPILE_MIN_USER_MESSAGES = 1;

// ── Domain selector ───────────────────────────────────────────────────────────
// v3.0.4: chatting WITH a read-only mirror is fine, but Compile writes to
// it — hide the Compile button for mirrors instead of letting the backend
// 400 surprise the user (Phase-1 deferral, now closed).
let chatReadonlyDomains = new Set();

async function loadChatDomains() {
  const res = await fetch('/api/domains');
  const { domains, readonlyDomains = [] } = await res.json();
  chatReadonlyDomains = new Set(readonlyDomains);
  chatDomainEl.innerHTML = domains
    .map(d => `<option value="${d}">${formatDomain(d)}</option>`)
    .join('');
  if (domains.length) {
    chatDomain = domains[0];
    await refreshConversationList();
  }
}

chatDomainEl?.addEventListener('change', async () => {
  chatDomain = chatDomainEl.value;
  activeConvId = null;
  showChatEmpty();
  await refreshConversationList();
});

// ── Conversation list ─────────────────────────────────────────────────────────
async function refreshConversationList() {
  if (!chatDomain) return;
  const res = await fetch(`/api/chat/${chatDomain}`);
  const { conversations } = await res.json();

  if (conversations.length === 0) {
    convListEl.innerHTML = `<div class="conv-empty">No conversations yet.<br>Start a new chat above.</div>`;
    return;
  }

  convListEl.innerHTML = conversations.map(c => `
    <div class="conv-item${c.id === activeConvId ? ' active' : ''}" data-id="${escHtml(c.id)}">
      <span class="conv-title">${escHtml(c.title)}</span>
      <span class="conv-count">${Math.floor(c.messageCount / 2)} msg${Math.floor(c.messageCount / 2) !== 1 ? 's' : ''}</span>
      <button class="conv-delete" data-id="${escHtml(c.id)}" title="Delete">✕</button>
    </div>
  `).join('');

  convListEl.querySelectorAll('.conv-item').forEach(el => {
    el.addEventListener('click', () => openConversation(el.dataset.id));
  });

  convListEl.querySelectorAll('.conv-delete').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await deleteConversation(btn.dataset.id);
    });
  });
}

async function openConversation(id) {
  if (id === activeConvId) return;
  activeConvId = id;

  const res = await fetch(`/api/chat/${chatDomain}/${id}`);
  if (!res.ok) return;
  const conv = await res.json();

  setChatThreadTitle(conv.title);
  renderThread(conv.messages);
  highlightActiveConv(id);
}

function setChatThreadTitle(title) {
  if (!chatThreadTitleText) return;
  chatThreadTitleText.textContent = title || 'Conversation';
}

function highlightActiveConv(id) {
  convListEl.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });
}

async function deleteConversation(id) {
  await fetch(`/api/chat/${chatDomain}/${id}`, { method: 'DELETE' });
  if (id === activeConvId) {
    activeConvId = null;
    showChatEmpty();
  }
  await refreshConversationList();
}

// ── Thread rendering ──────────────────────────────────────────────────────────
function showChatEmpty() {
  showEl(chatEmptyEl);
  hideEl(chatThreadEl);
  hideEl(chatThreadHeader);
  hideEl(compileProgressEl);
  chatThreadEl.innerHTML = '';
}

function updateCompileButtonVisibility(messages) {
  // The header is always visible when a conversation is open (carries the
  // title). The Compile button enables once we have at least
  // COMPILE_MIN_USER_MESSAGES user messages (1 since v3.0.1-beta.15 — a single
  // good question→answer exchange is worth compiling).
  const userTurns = messages.filter(m => m.role === 'user').length;
  if (compileBtn) {
    // v3.0.4: never offer Compile into a read-only Shared Brain mirror —
    // the backend refuses (400) and the write would be overwritten on the
    // next Pull anyway.
    if (userTurns >= COMPILE_MIN_USER_MESSAGES && !chatReadonlyDomains.has(chatDomain)) {
      compileBtn.classList.remove('hidden');
    } else {
      compileBtn.classList.add('hidden');
    }
  }
}

function renderThread(messages) {
  hideEl(chatEmptyEl);
  showEl(chatThreadEl);
  showEl(chatThreadHeader);
  chatThreadEl.innerHTML = '';
  for (const msg of messages) appendMessage(msg.role, msg.content, msg.citations || []);
  chatThreadEl.scrollTop = chatThreadEl.scrollHeight;
  updateCompileButtonVisibility(messages);
}

function appendMessage(role, content, citations = []) {
  hideEl(chatEmptyEl);
  showEl(chatThreadEl);

  // Render Markdown → safe HTML for assistant answers (bold, headings, lists,
  // code, wikilinks, and [source:] chips). User bubbles stay plain text. The
  // renderer escapes first, so it's XSS-safe; fall back to escaped text if the
  // renderer script somehow didn't load.
  const formatted = (role === 'assistant' && typeof window.renderChatMarkdown === 'function')
    ? window.renderChatMarkdown(content)
    : escHtml(content).replace(
        /\[source:\s*([^\]]+)\]/g,
        (_, p) => `<span class="citation-tag">[source: ${escHtml(p)}]</span>`
      );

  const citHtml = citations.length
    ? `<div class="chat-citations">${citations.map(c =>
        `<span class="citation-tag">${escHtml(c)}</span>`).join('')}</div>`
    : '';

  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = `
    <div class="chat-bubble">${formatted}</div>
    ${citHtml}
  `;
  chatThreadEl.appendChild(div);
  chatThreadEl.scrollTop = chatThreadEl.scrollHeight;
}

// v3.0.14: the compile outcome renders as an inline card INSIDE the thread.
// It used to live in a fixed `#compile-result` panel wedged between the thread
// and the composer (`flex-shrink: 0; max-height: 38vh`), which permanently
// stole up to 38% of the chat area (measured 429px → 127px on a 720px
// viewport), gave the thread a second scrollbar, and never cleared until the
// user switched conversations. As a thread item it scrolls with the
// conversation and costs the message area nothing.
//
// Deliberately does NOT touch chatEmptyEl / chatThreadEl visibility: the caller
// guarantees the compiled conversation is still open, and un-hiding the thread
// here would resurrect a headerless thread over the empty state if the user
// hit New Chat mid-compile.
function appendCompileCard() {
  const card = document.createElement('div');
  card.className = 'chat-compile-card';
  chatThreadEl.appendChild(card);
  return card;
}

// Scroll so the card's TOP is at the top of the visible thread area. The old
// fixed panel always showed its own top — the "Compiled to wiki: X" title and
// the ✨/✏️ counts, i.e. the whole point of the panel. Scrolling the thread to
// the bottom instead buries that headline for any card taller than the thread
// (a 25-page compile is ~750px against a ~480px thread). Overscroll is clamped
// by the browser, so short cards still land flush at the bottom.
function scrollCardIntoView(card) {
  const delta = card.getBoundingClientRect().top - chatThreadEl.getBoundingClientRect().top;
  chatThreadEl.scrollTop += delta - 8;
}

function appendSpinner() {
  const div = document.createElement('div');
  div.id = 'chat-thinking';
  div.className = 'chat-msg assistant';
  div.innerHTML = `<div class="chat-spinner"><span class="spinner"></span><span>Thinking…</span></div>`;
  chatThreadEl.appendChild(div);
  chatThreadEl.scrollTop = chatThreadEl.scrollHeight;
  return div;
}

// ── Send message ──────────────────────────────────────────────────────────────
newChatBtn?.addEventListener('click', () => {
  activeConvId = null;
  showChatEmpty();
  highlightActiveConv(null);
  chatInputEl.focus();
});

chatInputEl?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    chatSendBtn.click();
  }
});

// Auto-grow textarea
chatInputEl?.addEventListener('input', () => {
  chatInputEl.style.height = 'auto';
  chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 160) + 'px';
});

chatSendBtn?.addEventListener('click', async () => {
  if (chatBusy) return;
  const message = chatInputEl.value.trim();
  if (!message || !chatDomain) return;

  chatBusy = true;
  chatSendBtn.disabled = true;
  chatInputEl.value = '';
  chatInputEl.style.height = 'auto';

  appendMessage('user', message);
  const spinner = appendSpinner();

  try {
    const res = await fetch(`/api/chat/${chatDomain}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, conversationId: activeConvId, responseStyle: chatResponseStyle, provider: chatModelProvider }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Chat failed');

    spinner.remove();
    appendMessage('assistant', data.answer, data.citations);

    // Brand-new conversation: the server just titled it from the first user
    // message. Surface the title in the thread header.
    if (data.title) setChatThreadTitle(data.title);
    showEl(chatThreadHeader);

    // Re-evaluate Compile button visibility — count user bubbles already in DOM.
    const userTurns = chatThreadEl.querySelectorAll('.chat-msg.user').length;
    updateCompileButtonVisibility(Array.from({ length: userTurns }, () => ({ role: 'user' })));

    if (data.conversationId && data.conversationId !== activeConvId) {
      activeConvId = data.conversationId;
      await refreshConversationList();
    }
  } catch (err) {
    spinner.remove();
    appendMessage('assistant', `Error: ${err.message}`);
  } finally {
    chatBusy = false;
    chatSendBtn.disabled = false;
    chatInputEl.focus();
  }
});

// ── Compile to Wiki (v2.5.0) ──────────────────────────────────────────────────
// Streams progress from /api/compile/conversation and renders the result via
// the shared change-records panel. Progress events drive a dedicated progress
// strip below the thread header (mirrors the ingest tab pattern).

function showCompileProgress(pct, label) {
  if (!compileProgressEl) return;
  showEl(compileProgressEl);
  compileProgressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  compileProgressPct.textContent = `${Math.round(pct)}%`;
  if (label) compileProgressLabel.textContent = label;
}

function hideCompileProgress() {
  if (!compileProgressEl) return;
  hideEl(compileProgressEl);
  compileProgressFill.style.width = '0%';
  compileProgressPct.textContent = '0%';
  compileProgressLabel.textContent = 'Preparing…';
}

if (compileBtn) {
  compileBtn.addEventListener('click', async () => {
    if (compileBusy) return;
    if (!activeConvId || !chatDomain) return;

    // A compile takes 15–45s and the rest of the UI stays live. Remember which
    // conversation we compiled: if the user switches threads, starts a new
    // chat, or changes domain meanwhile, the card must NOT be appended — it
    // would land in an unrelated transcript (reading as if that conversation
    // produced it) or float alone in a freshly-emptied thread. The pages are
    // still written either way; the wiki + domain stats refresh below.
    const compileConvId = activeConvId;
    const compileDomain = chatDomain;
    const renderCompileOutcome = (fill) => {
      if (activeConvId !== compileConvId || chatDomain !== compileDomain) {
        console.warn('[compile] finished after the user navigated away — card not shown');
        return false;
      }
      const card = appendCompileCard();
      fill(card);
      scrollCardIntoView(card);
      return true;
    };

    compileBusy = true;
    compileBtn.disabled = true;
    compileBtn.classList.add('compiling');
    showCompileProgress(0, 'Starting compile…');

    try {
      const res = await fetch('/api/compile/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: chatDomain, conversationId: activeConvId }),
      });

      if (!res.ok && res.status !== 200) {
        // Validation errors come back as JSON, not SSE
        let errMsg = `HTTP ${res.status}`;
        try { const j = await res.json(); errMsg = j.error || errMsg; } catch {}
        throw new Error(errMsg);
      }
      if (!res.body) throw new Error('Streaming not supported by this browser');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let final = null;
      let refused = null;
      let errored = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event;
          try { event = JSON.parse(line.slice(6)); }
          catch { continue; }

          if (event.type === 'progress' || event.type === 'wait') {
            showCompileProgress(event.pct ?? 50, event.message);
          } else if (event.type === 'done') {
            final = event;
          } else if (event.type === 'refused') {
            refused = event.reason;
          } else if (event.type === 'error') {
            errored = event.message;
          }
        }
      }

      if (errored) throw new Error(errored);
      if (refused) {
        renderCompileOutcome(card => {
          card.innerHTML = `<div class="compile-refused">${escHtml(refused)}</div>`;
        });
        return;
      }
      if (!final) throw new Error('Compilation produced no result');

      // Brief moment of "100%" visible before the result card lands in the thread
      showCompileProgress(100, 'Done');

      const compileChanges = Array.isArray(final.changes) ? final.changes : [];
      // v3.0.1-beta.27: non-fatal degradation notes (large conversation →
      // concise / summary-only fallback) render above the change list, so the
      // user knows when only a summary was saved rather than a full extraction.
      const compileWarnings = Array.isArray(final.warnings) ? final.warnings : [];

      renderCompileOutcome(card => {
        if (compileChanges.length) {
          renderChangeRecords(card, {
            title: `Compiled to wiki: ${final.title}`,
            changes: compileChanges,
          });
        } else {
          // renderChangeRecords hides an empty container; inline we still owe
          // the user a visible outcome, so render the empty state explicitly.
          card.innerHTML = `
            <div class="change-summary">
              <h3 class="change-title">${escHtml(`Compiled to wiki: ${final.title}`)}</h3>
              <div class="change-empty">No pages were written.</div>
            </div>`;
        }
        if (compileWarnings.length) {
          const note = document.createElement('div');
          note.className = 'compile-note';
          note.innerHTML = compileWarnings.map(w => `<div>ℹ️ ${escHtml(w)}</div>`).join('');
          card.prepend(note);
        }
      });

      // Refresh the wiki tab and domain stats so changes propagate everywhere
      // (existing post-mutation pattern used after sync/ingest).
      try { if (typeof loadDomainList === 'function') await loadDomainList(); } catch {}
      try {
        const wikiDomain = document.getElementById('wiki-domain');
        if (wikiDomain && wikiDomain.value === chatDomain && typeof loadWiki === 'function') {
          await loadWiki();
        }
      } catch {}

    } catch (err) {
      renderCompileOutcome(card => {
        card.innerHTML = `<div class="compile-error">⚠️ ${escHtml(err.message)}</div>`;
      });
    } finally {
      compileBusy = false;
      compileBtn.disabled = false;
      compileBtn.classList.remove('compiling');
      hideCompileProgress();
    }
  });
}

// ── SYNC TAB ──────────────────────────────────────────────────────────────────

// ── DOM refs ──────────────────────────────────────────────────────────────────
const syncChecking    = document.getElementById('sync-checking');
const syncUnconfigured = document.getElementById('sync-unconfigured');
const syncConfigured  = document.getElementById('sync-configured');
const syncLanding     = document.getElementById('sync-landing');
const syncWizard      = document.getElementById('sync-wizard');

// Wizard step panels
const syncStep1       = document.getElementById('sync-step-1');
const syncStep2       = document.getElementById('sync-step-2');
const syncStep3       = document.getElementById('sync-step-3');
const syncProcessing  = document.getElementById('sync-processing');
const syncError       = document.getElementById('sync-error');
const syncSuccess     = document.getElementById('sync-success');

// Wizard fields
const syncRepoUrlInput = document.getElementById('sync-repo-url');
const syncTokenInput   = document.getElementById('sync-token');

// Persisted across wizard steps
let wizardRepoUrl = '';
let wizardToken   = '';
let wizardLastMode = 'push';

// ── Navbar sync-pending badge (v3.0.1-beta.5) ────────────────────────────────
// Visible from every tab so the user sees uncommitted local changes (e.g.
// a domain deletion) without needing to open the Sync tab. Hidden when sync
// is not configured, or when there are no pending changes.

// v3.0.4 (M14): the badge also covers Shared Brain pending contributions —
// pages changed since the last push (or queued for retry) across every
// enabled connection. The count comes from /api/sharedbrain/list's additive
// pending_pages field, cached here between refreshes.
let _sbPendingCount = 0;

function applySyncPendingBadge(status) {
  const badge = document.getElementById('sync-pending-badge');
  if (!badge) return;
  const gitCount = (status && status.configured) ? (status.changesCount | 0) : 0;
  const sbCount = _sbPendingCount | 0;
  const total = gitCount + sbCount;
  if (total > 0) {
    badge.textContent = String(total);
    const parts = [];
    if (gitCount > 0) parts.push(`${gitCount} local change${gitCount === 1 ? '' : 's'} not yet pushed to GitHub`);
    if (sbCount > 0) parts.push(`${sbCount} page${sbCount === 1 ? '' : 's'} not yet pushed to your Shared Brain${sbCount === 1 ? '' : 's'}`);
    badge.title = `${parts.join('; ')}. Open the Sync tab to push.`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

async function fetchSharedBrainPendingCount() {
  try {
    const r = await fetch('/api/sharedbrain/list');
    if (!r.ok) return 0; // 404 = feature off — nothing pending by definition
    const j = await r.json();
    return (Array.isArray(j.connections) ? j.connections : [])
      .reduce((n, c) => n + (c.pending_pages | 0), 0);
  } catch {
    return 0;
  }
}

async function refreshSyncPendingBadge() {
  try {
    const [res, sbCount] = await Promise.all([
      fetch('/api/sync/status'),
      fetchSharedBrainPendingCount(),
    ]);
    _sbPendingCount = sbCount;
    if (!res.ok) {
      applySyncPendingBadge(null);
      return;
    }
    const status = await res.json();
    applySyncPendingBadge(status);
  } catch {
    // Silent — bad network shouldn't surface as a UI error here. Try again
    // on the next tab click or the next periodic poll.
    applySyncPendingBadge(null);
  }
}

// Refresh on every tab click — covers the common case where a user does
// something destructive (delete a domain, ingest a file) and then clicks a
// different tab. The badge updates instantly when they navigate away.
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => { refreshSyncPendingBadge(); });
});

// Periodic poll so the badge stays fresh even if the user lingers on one
// tab. Cheap: one local HTTP call to a route that does `git status --porcelain`.
setInterval(refreshSyncPendingBadge, 60_000);

// Initial fetch on app load — runs in the background; doesn't block any UI.
refreshSyncPendingBadge();

// ── Ingest-busy state (v3.0.1-beta.8) ─────────────────────────────────────
//
// When an ingest (or compile) is mid-flight, the backend refuses
// /api/update, /api/restart, /api/sync/*, and DELETE /api/domains/:slug
// with 409 (see src/brain/write-registry.js). We mirror that in the UI by
// disabling the matching buttons so the user doesn't see the 409 in the
// first place. The 409 path is still the canonical safety net — this is
// just the friendly layer on top.
//
// State is tracked per-domain (a Map<domain, count>). Multiple concurrent
// ingests are uncommon but possible (different domains) — the buttons stay
// disabled until ALL ingest streams have completed.
const _activeIngests = new Map();
function _ingestActive() {
  for (const n of _activeIngests.values()) if (n > 0) return true;
  return false;
}
// Round-2 audit item 2: is `domain` currently registered as having ANY
// active write (a running batch, a single ingest already in flight, a
// Shared Brain pull — anything that has called window.__curatorIngestStart
// for this domain and not yet matched it with __curatorIngestEnd)? The
// per-domain Map already tracks exactly this; a batch on "articles" reads
// as false for "projects".
//
// Why this matters: write-registry.js's acquireFileLock is an
// existsSync-then-writeFileAtomic check with no O_EXCL, so it does NOT
// exclude two truly concurrent in-process callers (double-granted in an
// audited repro, 5 rounds out of 5) — and routes/ingest.js never even
// calls it. The batch feature's own in-flight counter can't see a
// concurrently-started single-file ingest either. So the ONLY thing
// stopping "batch running on domain X" + "user starts a single ingest
// into domain X" from producing duplicate wiki pages is the UI never
// offering that combination in the first place. This function is that
// refusal; the underlying lock bug is out of scope for this file.
function isDomainWriteBusy(domain) {
  return !!domain && (_activeIngests.get(domain) || 0) > 0;
}
// Single source of truth for #ingest-btn's disabled state and title,
// callable from anywhere the two inputs it depends on can change: a file
// being selected/cleared (setFile), the domain dropdown changing, or the
// busy-gate Map changing (_applyIngestBusyState, called at the end of
// this function's own trigger paths — see ingestStart/ingestEnd below).
function refreshIngestBtnAvailability() {
  if (!ingestBtn) return;
  if (!selectedFile) {
    ingestBtn.disabled = true;
    ingestBtn.removeAttribute('title');
    return;
  }
  const domain = document.getElementById('ingest-domain')?.value;
  if (isDomainWriteBusy(domain)) {
    ingestBtn.disabled = true;
    ingestBtn.title = 'A batch (or another write) is already running for this domain — wait for it to finish, or switch to a different domain.';
  } else {
    ingestBtn.disabled = false;
    ingestBtn.removeAttribute('title');
  }
}
function _applyIngestBusyState() {
  const busy = _ingestActive();
  // Re-evaluate the single-file Ingest button every time this Map changes
  // (a batch starting/ending, a Shared Brain op starting/ending, this same
  // single-file path's own start/end) — it depends on the SAME per-domain
  // state, just scoped to whichever domain is currently selected rather
  // than "is anything anywhere busy".
  refreshIngestBtnAvailability();
  // List of selectors → human-friendly title for the tooltip.
  const targets = [
    { sel: '#settings-update-btn',    label: 'Check for Updates' },
    { sel: '#sync-both-btn',          label: 'Sync now' },
    { sel: '#sync-push-btn',          label: 'Push only' },
    { sel: '#sync-pull-btn',          label: 'Pull only' },
    { sel: '#sync-disconnect-btn',    label: 'Disconnect sync' },
  ];
  for (const t of targets) {
    const el = document.querySelector(t.sel);
    if (!el) continue;
    if (busy) {
      if (!el.dataset.savedTitle) el.dataset.savedTitle = el.title || '';
      if (!el.dataset.preIngestDisabled) {
        el.dataset.preIngestDisabled = el.disabled ? '1' : '0';
      }
      el.disabled = true;
      el.title = 'An ingest is in progress — please wait for it to finish.';
    } else {
      if (el.dataset.preIngestDisabled === '0') el.disabled = false;
      // Always restore the original title attribute (might have been empty).
      if (el.dataset.savedTitle !== undefined) {
        if (el.dataset.savedTitle) el.title = el.dataset.savedTitle;
        else el.removeAttribute('title');
      }
      delete el.dataset.savedTitle;
      delete el.dataset.preIngestDisabled;
    }
  }
  // Domain delete buttons (created dynamically per-card)
  document.querySelectorAll('.domain-delete-btn').forEach(el => {
    if (busy) {
      if (!el.dataset.preIngestDisabled) {
        el.dataset.preIngestDisabled = el.disabled ? '1' : '0';
      }
      el.disabled = true;
      el.title = 'An ingest is in progress — please wait for it to finish.';
    } else {
      if (el.dataset.preIngestDisabled === '0') el.disabled = false;
      el.title = 'Delete';
      delete el.dataset.preIngestDisabled;
    }
  });
  // Shared Brain card buttons (created dynamically per-card) — a Shared
  // Brain pull writes wiki pages, so it must not start mid-ingest (and vice
  // versa: SB operations register through this same gate, disabling
  // Update/Sync/Delete while they run). v3.0.2.
  document.querySelectorAll('.sharedbrain-card button[data-action]').forEach(el => {
    if (busy) {
      if (!el.dataset.preIngestDisabled) {
        el.dataset.preIngestDisabled = el.disabled ? '1' : '0';
      }
      el.disabled = true;
      el.title = 'Another operation is in progress — please wait for it to finish.';
    } else {
      if (el.dataset.preIngestDisabled === '0') el.disabled = false;
      el.removeAttribute('title');
      delete el.dataset.preIngestDisabled;
    }
  });
}
function ingestStart(domain) {
  _activeIngests.set(domain, (_activeIngests.get(domain) || 0) + 1);
  _applyIngestBusyState();
}
function ingestEnd(domain) {
  const n = (_activeIngests.get(domain) || 0) - 1;
  if (n <= 0) _activeIngests.delete(domain);
  else _activeIngests.set(domain, n);
  _applyIngestBusyState();
}
// Expose so other in-app surfaces (compile button, future Dictate/Curate
// modes) can register their own writes through the same gate.
window.__curatorIngestStart = ingestStart;
window.__curatorIngestEnd   = ingestEnd;

// ── Init ──────────────────────────────────────────────────────────────────────
async function initSyncTab() {
  showEl(syncChecking);
  hideEl(syncUnconfigured);
  hideEl(syncConfigured);

  try {
    const res = await fetch('/api/sync/status');
    const status = await res.json();
    hideEl(syncChecking);
    if (status.configured) {
      renderSyncConfigured(status);
    } else {
      showEl(syncUnconfigured);
      showEl(syncLanding);
      hideEl(syncWizard);
    }
  } catch {
    hideEl(syncChecking);
    showEl(syncUnconfigured);
    showEl(syncLanding);
    hideEl(syncWizard);
  }
}

// Only initialise when the Sync tab is first opened (lazy)
let syncTabInitialised = false;
document.querySelector('[data-tab="sync"]')?.addEventListener('click', () => {
  if (!syncTabInitialised) {
    syncTabInitialised = true;
    initSyncTab();
  }
  // Shared Brain refreshes on every tab open so connection-card stats
  // (last push / last pull) stay current after operations elsewhere.
  initSharedBrainSection();
});

// ── SHARED BRAINS (v3.0.0-beta+) ──────────────────────────────────────────────
//
// All endpoints under /api/sharedbrain/* respect the sharedBrainEnabled flag.
// Section is hidden entirely when the flag is off; an opt-in CTA appears
// instead. Flipping the flag is one POST away — UI updates immediately.

const sbChecking = () => document.getElementById('sharedbrain-checking');
const sbSection  = () => document.getElementById('sharedbrain-section');
const sbEmpty    = () => document.getElementById('sharedbrain-empty');
const sbList     = () => document.getElementById('sharedbrain-list');
const sbAddMore  = () => document.getElementById('sharedbrain-add-more');

// v3.0.4 (L12): init/list failures render an inline error row instead of
// silently hiding the section (which read as "Shared Brain is off").
function showSharedBrainError(message) {
  const errEl = document.getElementById('sharedbrain-init-error');
  if (!errEl) return;
  errEl.textContent = `${message} Click the Sync tab again to retry.`;
  errEl.classList.remove('hidden');
}

// v3.0.2: the enable/opt-in toggle moved to Settings → Shared Brain
// (beta). The Sync tab shows the operational section ONLY when the flag is
// on — solo users (the vast majority) see no Shared Brain content here.
async function initSharedBrainSection() {
  const checking = sbChecking();
  if (!checking) return; // index.html doesn't have the section (older app file?)
  showEl(checking);
  hideEl(sbSection());
  const errEl = document.getElementById('sharedbrain-init-error');
  if (errEl) errEl.classList.add('hidden');

  try {
    const flagRes = await fetch('/api/sharedbrain/feature-flag');
    const flag    = await flagRes.json();
    hideEl(checking);

    if (!flag.enabled) return; // enable lives in Settings → Shared Brain (beta)

    showEl(sbSection());
    await refreshSharedBrainList();
  } catch (err) {
    hideEl(checking);
    console.error('[sharedbrain] init failed', err);
    showSharedBrainError(`Could not load the Shared Brain section: ${err.message}.`);
  }
}

// Settings → Shared Brain (beta): show either the enable button or the
// "enabled — go to the Sync tab" state, based on the current flag.
async function refreshSharedBrainSettings() {
  const optin   = document.getElementById('sharedbrain-optin');
  const enabled = document.getElementById('settings-sharedbrain-enabled');
  if (!optin || !enabled) return;
  try {
    const r = await fetch('/api/sharedbrain/feature-flag');
    const j = await r.json();
    if (j.enabled) { hideEl(optin); showEl(enabled); }
    else           { showEl(optin); hideEl(enabled); }
  } catch { /* leave both hidden — transient error; next Settings visit retries */ }
}

// Opt-in button (Settings tab) — flips the feature flag. The Sync tab picks
// the new state up on its next open (its click handler re-inits the section).
function bindSharedBrainOptin() {
  const btn = document.getElementById('sharedbrain-enable-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Enabling…';
    const statusEl = document.getElementById('sharedbrain-optin-status');
    if (statusEl) statusEl.classList.add('hidden');
    try {
      const r = await fetch('/api/sharedbrain/enable-flag', { method: 'POST' });
      const j = await r.json();
      if (!j.enabled) throw new Error(j.error || 'Could not enable Shared Brain');
      await refreshSharedBrainSettings();
    } catch (err) {
      // v3.0.4 (L14): inline status instead of alert().
      if (statusEl) {
        statusEl.textContent = `Could not enable Shared Brain: ${err.message}`;
        statusEl.className = 'status error';
        statusEl.classList.remove('hidden');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enable Shared Brain (beta)';
    }
  });
  // "Sync tab" link in the enabled state — jump straight there.
  const goto = document.getElementById('settings-sharedbrain-goto-sync');
  if (goto) {
    goto.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelector('[data-tab="sync"]')?.click();
    });
  }
}

async function refreshSharedBrainList() {
  try {
    const r = await fetch('/api/sharedbrain/list');
    if (!r.ok) {
      // 404 = flag flipped off externally; resync state
      if (r.status === 404) return initSharedBrainSection();
      throw new Error(`list failed: ${r.status}`);
    }
    const j = await r.json();
    const conns = Array.isArray(j.connections) ? j.connections : [];

    // Keep the navbar badge in sync with the freshest pending counts (M14).
    _sbPendingCount = conns.reduce((n, c) => n + (c.pending_pages | 0), 0);

    if (conns.length === 0) {
      showEl(sbEmpty());
      hideEl(sbList());
      hideEl(sbAddMore());
    } else {
      hideEl(sbEmpty());
      showEl(sbList());
      showEl(sbAddMore());
      renderSharedBrainList(conns);
    }
  } catch (err) {
    console.error('[sharedbrain] refresh failed', err);
    // v3.0.4 (L12): a failed list render used to leave a blank void.
    showSharedBrainError(`Could not load Shared Brain connections: ${err.message}.`);
  }
}

function renderSharedBrainList(connections) {
  const list = sbList();
  list.innerHTML = '';
  for (const c of connections) {
    list.appendChild(renderSharedBrainCard(c));
  }
}

function formatRelativeTime(iso) {
  if (!iso) return 'never';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'never';
  const now = new Date();
  const diffMs = now - then;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} day${day !== 1 ? 's' : ''} ago`;
  return then.toLocaleDateString();
}

// ── Per-connection in-flight-op registry (v3.0.4, M12/M13) ─────────────────
//
// initSharedBrainSection re-runs on every Sync-tab click, and a successful
// operation triggers refreshSharedBrainList — both replace the card DOM.
// Before this registry, a re-render mid-operation detached the card that
// held the status text and re-enabled the fresh card's buttons, so a second
// click could start a duplicate push (or a Disconnect mid-push). Now:
//   - _sbInFlight tracks the running op per connection; renders restore the
//     live status and keep buttons disabled; duplicate ops are refused.
//   - _sbLastResult keeps the final message so tab switches don't wipe it.
const _sbInFlight   = new Map(); // connId → { action, message, isError }
const _sbLastResult = new Map(); // connId → { message, isError }

function sbCardEl(connId) {
  const list = sbList();
  return list ? list.querySelector(`.sharedbrain-card[data-id="${connId}"]`) : null;
}

// Status + busy setters always resolve the CURRENT card in the DOM — never
// a captured node that a re-render may have detached.
function sbSetCardStatus(connId, message, isError = false) {
  const card = sbCardEl(connId);
  if (!card) return;
  const statusEl = card.querySelector('[data-field="status"]');
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle('error', !!isError);
  statusEl.classList.add('active');
}

function sbSetCardBusy(connId, busy) {
  const card = sbCardEl(connId);
  if (!card) return;
  card.querySelectorAll('button[data-action]').forEach(b => { b.disabled = !!busy; });
}

// Compose the final status line for a 'done' SSE frame. Prefers the
// backend's own summary; falls back to assembling one from the raw result
// fields; keeps the last streamed message as the final fallback (M13).
function sbComposeDoneMessage(action, payload, lastShown) {
  if (payload.message) return payload.message;
  const r = payload.result;
  if (r && typeof r === 'object') {
    if (typeof r.message === 'string' && r.message) return r.message;
    if (action === 'pull' && 'created' in r) {
      return `Pull complete: ${r.created} new, ${r.updated} updated` +
        ('unchanged' in r ? `, ${r.unchanged} unchanged` : '') +
        (r.pruned > 0 ? `, ${r.pruned} removed` : '') +
        (r.skipped > 0 ? `, ${r.skipped} skipped` : '') + '.';
    }
    if (action === 'synthesize' && 'pages_written' in r) {
      let m = `Synthesis complete: ${r.pages_written} page${r.pages_written === 1 ? '' : 's'} written` +
        ('processed_contributions' in r ? ` from ${r.processed_contributions} contribution${r.processed_contributions === 1 ? '' : 's'}` : '');
      if (r.conflicts > 0) {
        m += `, ${r.conflicts} conflict${r.conflicts === 1 ? '' : 's'} flagged`;
        if (Array.isArray(r.conflict_pages) && r.conflict_pages.length > 0) {
          m += ` in ${r.conflict_pages.slice(0, 5).join(', ')}${r.conflict_pages.length > 5 ? ` (+${r.conflict_pages.length - 5} more)` : ''}`;
        }
      }
      if (r.pages_failed > 0) m += `, ${r.pages_failed} page${r.pages_failed === 1 ? '' : 's'} failed`;
      return m + '.';
    }
  }
  return lastShown || `${action} completed.`;
}

function renderSharedBrainCard(conn) {
  const card = document.createElement('div');
  card.className = 'sharedbrain-card';
  card.dataset.id = conn.id;

  const repoUrl =
    conn.storage_type === 'github' && conn.github_repo_owner && conn.github_repo_name
      ? `https://github.com/${conn.github_repo_owner}/${conn.github_repo_name}`
      : '';
  const repoLabel =
    conn.storage_type === 'github'
      ? `${conn.github_repo_owner}/${conn.github_repo_name}`
      : conn.storage_type === 'local'
      ? `local: ${conn.local_storage_path}`
      : conn.storage_type;

  const localDomains = Array.isArray(conn.local_domains) && conn.local_domains.length
    ? conn.local_domains.join(', ')
    : '(none configured)';
  const fellowShort = (conn.fellow_id || '').slice(0, 8);

  // Card body uses only static HTML — every dynamic value is set via
  // textContent or DOM property assignment below. This is the chokepoint
  // that prevents XSS from any field the server might pass back (label,
  // repo, fellow_display_name, etc.). NEVER interpolate dynamic data into
  // this template string.
  card.innerHTML = `
    <div class="sharedbrain-card-header">
      <h4 class="sharedbrain-card-title">🧠 <span data-field="label"></span><span class="sharedbrain-card-meta-pill sb-readonly-pill hidden" data-field="readonly-pill">read-only member</span></h4>
      <span class="sharedbrain-card-repo" data-field="repo"></span>
    </div>
    <div class="sharedbrain-card-stats">
      <span><span class="sharedbrain-card-stat-label">Last pushed:</span> <span data-field="last-pushed"></span></span>
      <span><span class="sharedbrain-card-stat-label">Last pulled:</span> <span data-field="last-pulled"></span></span>
      <span><span class="sharedbrain-card-stat-label">Last synthesis:</span> <span data-field="last-synthesis"></span></span>
      <span><span class="sharedbrain-card-stat-label">Domains:</span> <span data-field="domains"></span></span>
    </div>
    <div class="sharedbrain-card-pending hidden" data-field="pending"></div>
    <div class="sharedbrain-card-actions">
      <button class="btn primary" data-action="push">Push contributions</button>
      <button class="btn" data-action="pull">Pull updates</button>
    </div>
    <div class="sharedbrain-card-skips hidden" data-field="skips">
      <details>
        <summary data-field="skips-summary"></summary>
        <ul class="sharedbrain-card-skips-list" data-field="skips-list"></ul>
        <button class="btn" data-action="retry-skipped">Retry these pages on next push</button>
      </details>
    </div>
    <div class="sharedbrain-card-status" data-field="status" aria-live="polite"></div>
    <p class="sharedbrain-card-note" data-field="mirror-note"></p>
    <details class="sharedbrain-card-advanced">
      <summary>Advanced</summary>
      <div class="sharedbrain-card-advanced-body">
        <button class="btn" data-action="synthesize">Run synthesis (admin)</button>
        <button class="btn" data-action="show-invite">Show invite token</button>
        <button class="btn" data-action="admin-token">Generate admin token</button>
        <span class="sharedbrain-card-meta-pill" data-field="fellow-id"></span>
        <button class="btn sync-disconnect-btn" data-action="revoke">Revoke a contributor…</button>
        <button class="btn sync-disconnect-btn" data-action="disconnect">Disconnect</button>
      </div>
      <div class="sharedbrain-card-tokenbox hidden" data-field="token-box"></div>
      <div class="sharedbrain-card-revoke hidden" data-field="revoke-panel"></div>
    </details>
  `;

  // Populate text-content fields. textContent (and DOM property assignments
  // like Element.href) escape automatically — much safer than HTML
  // interpolation. Validation in validateConnection ensures owner/name
  // are slug-shaped before they ever reach us, but defence in depth.
  card.querySelector('[data-field="label"]').textContent = conn.label || '(unnamed)';
  card.querySelector('[data-field="last-pushed"]').textContent = formatRelativeTime(conn.last_push_at);
  card.querySelector('[data-field="last-pulled"]').textContent = formatRelativeTime(conn.last_pull_at);
  // v3.0.4 (M16): when the collective was last synthesised — learned from
  // the admin's own synthesis run, or from state.last-synthesis on Pull.
  // "Pull pulled 0 pages" almost always means "no synthesis yet".
  card.querySelector('[data-field="last-synthesis"]').textContent = conn.last_synthesis_at
    ? formatRelativeTime(conn.last_synthesis_at)
    : 'never — ask your admin to run synthesis';
  card.querySelector('[data-field="domains"]').textContent = localDomains;
  card.querySelector('[data-field="fellow-id"]').textContent = `fellow ${fellowShort}…`;

  // v3.0.4 (L15): say where pulled content lands — users couldn't find it.
  const slug = typeof conn.shared_brain_slug === 'string' ? conn.shared_brain_slug : '';
  card.querySelector('[data-field="mirror-note"]').textContent = slug
    ? `Pulled content appears as the read-only domain "shared-${slug}" in the Domains tab.`
    : '';

  // v3.0.4 (H10): read-only member — Push and synthesis are impossible
  // with a read-only PAT; hide them and show the pill instead of letting
  // the buttons fail with a GitHub 403. v3.0.5: same for the admin ops
  // (revocation deletes remote files — needs write access).
  if (conn.read_only === true) {
    card.querySelector('[data-field="readonly-pill"]').classList.remove('hidden');
    card.querySelector('button[data-action="push"]').classList.add('hidden');
    card.querySelector('button[data-action="synthesize"]').classList.add('hidden');
    card.querySelector('button[data-action="admin-token"]').classList.add('hidden');
    card.querySelector('button[data-action="revoke"]').classList.add('hidden');
  } else {
    // v3.0.5 (4.1/4.2): admin affordances. The masked listing still shows
    // WHETHER an admin_token exists (non-empty masked value) — that gates
    // the revoke button; the token itself never reaches the UI.
    const hasAdminToken = typeof conn.admin_token === 'string' && conn.admin_token.length > 0;
    card.querySelector('button[data-action="admin-token"]').textContent =
      hasAdminToken ? 'Rotate admin token' : 'Generate admin token';
    if (!hasAdminToken) {
      card.querySelector('button[data-action="revoke"]').classList.add('hidden');
    }
  }

  // v3.0.4 (M14): pending contributions at rest.
  const pendingEl = card.querySelector('[data-field="pending"]');
  const pendingCount = conn.pending_pages | 0;
  const retryCount = conn.pending_retry && typeof conn.pending_retry === 'object'
    ? Object.keys(conn.pending_retry).length : 0;
  if (conn.read_only !== true && (pendingCount > 0 || retryCount > 0)) {
    const bits = [];
    if (pendingCount > 0) bits.push(`${pendingCount} page${pendingCount === 1 ? '' : 's'} ready to push`);
    if (retryCount > 0) bits.push(`${retryCount} queued for automatic retry`);
    pendingEl.textContent = `⏳ ${bits.join(' · ')}`;
    pendingEl.classList.remove('hidden');
  }

  // v3.0.4 (M15): permanently-skipped pages get a resting-state pill with
  // an expandable list and a one-click "retry" action (POST /:id/unskip).
  const skips = Array.isArray(conn.permanent_skip) ? conn.permanent_skip.filter(p => typeof p === 'string') : [];
  if (skips.length > 0) {
    const skipsEl = card.querySelector('[data-field="skips"]');
    skipsEl.classList.remove('hidden');
    card.querySelector('[data-field="skips-summary"]').textContent =
      `⚠ ${skips.length} page${skips.length === 1 ? '' : 's'} skipped after repeated failures`;
    const listEl = card.querySelector('[data-field="skips-list"]');
    for (const p of skips) {
      const li = document.createElement('li');
      li.textContent = p;
      listEl.appendChild(li);
    }
  }

  // Repo cell — promote the span to an anchor when we have a URL.
  const repoCell = card.querySelector('[data-field="repo"]');
  repoCell.textContent = repoLabel;
  if (repoUrl) {
    const a = document.createElement('a');
    a.className = 'sharedbrain-card-repo';
    a.dataset.field = 'repo';
    a.href = repoUrl;                  // Element.href setter URL-encodes properly
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = repoLabel;
    repoCell.replaceWith(a);
  }

  // Hook actions. The masked connection rides along for actions that need
  // its non-secret fields (invite re-display, admin-token label, revoke).
  card.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => onSharedBrainAction(conn.id, btn.dataset.action, card, { conn }));
  });

  // v3.0.4 (M12/M13): restore live or last-known status across re-renders.
  const inFlight = _sbInFlight.get(conn.id);
  if (inFlight) {
    sbApplyStatusTo(card, inFlight.message, inFlight.isError);
    card.querySelectorAll('button[data-action]').forEach(b => { b.disabled = true; });
  } else {
    const last = _sbLastResult.get(conn.id);
    if (last) sbApplyStatusTo(card, last.message, last.isError);
  }

  return card;
}

// Apply a status to a specific (possibly not-yet-attached) card node.
function sbApplyStatusTo(card, message, isError) {
  const statusEl = card.querySelector('[data-field="status"]');
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle('error', !!isError);
  statusEl.classList.add('active');
}

async function onSharedBrainAction(connId, action, card, opts = {}) {
  // v3.0.4 (M12): one operation per connection at a time. The status/busy
  // helpers below always resolve the CURRENT card in the DOM, so a Sync-tab
  // re-render mid-operation can't detach the status or re-enable buttons.
  const conn = opts.conn || null;

  // ── v3.0.5 (Phase 4) card actions ─────────────────────────────────────
  if (action === 'show-invite')  return sbToggleInviteBox(connId, card, conn);
  if (action === 'admin-token')  return sbHandleAdminToken(connId, card, conn);
  if (action === 'revoke')       return sbToggleRevokePanel(connId, card, conn);

  // v3.0.5 (4.5): synthesis merges every pending contribution into the
  // collective — usually the admin's job. Confirm inline before running.
  if (action === 'synthesize' && !opts.confirmed) {
    if (_sbInFlight.has(connId)) {
      sbSetCardStatus(connId, 'An operation is already running on this connection — wait for it to finish.', true);
      return;
    }
    const statusEl = card.querySelector('[data-field="status"]');
    if (!statusEl) return;
    statusEl.textContent = '';
    statusEl.classList.remove('error');
    statusEl.classList.add('active');
    const text = document.createElement('span');
    text.textContent = 'Run synthesis now? This merges all pending contributions into the collective wiki — it is usually run by the brain admin (weekly, or after a batch of pushes). ';
    const yes = document.createElement('button');
    yes.className = 'btn primary';
    yes.textContent = 'Run synthesis';
    const no = document.createElement('button');
    no.className = 'btn';
    no.textContent = 'Cancel';
    statusEl.append(text, yes, document.createTextNode(' '), no);
    no.addEventListener('click', () => { statusEl.textContent = ''; statusEl.classList.remove('active'); });
    yes.addEventListener('click', () => onSharedBrainAction(connId, 'synthesize', card, { ...opts, confirmed: true }));
    return;
  }

  if (action === 'disconnect') {
    if (_sbInFlight.has(connId)) {
      sbSetCardStatus(connId, 'An operation is running on this connection — wait for it to finish before disconnecting.', true);
      return;
    }
    // v3.0.4 (L14): inline confirm in the card status area instead of the
    // browser confirm() dialog.
    const statusEl = card.querySelector('[data-field="status"]');
    if (!statusEl) return;
    statusEl.textContent = '';
    statusEl.classList.remove('error');
    statusEl.classList.add('active');
    const text = document.createElement('span');
    text.textContent = 'Disconnect this Shared Brain? This removes it from THIS computer only — the shared repo and other contributors are not affected. ';
    const yes = document.createElement('button');
    yes.className = 'btn sync-disconnect-btn';
    yes.textContent = 'Disconnect';
    const no = document.createElement('button');
    no.className = 'btn';
    no.textContent = 'Cancel';
    statusEl.append(text, yes, document.createTextNode(' '), no);
    no.addEventListener('click', () => {
      statusEl.textContent = '';
      statusEl.classList.remove('active');
    });
    yes.addEventListener('click', async () => {
      yes.disabled = true; no.disabled = true;
      try {
        const r = await fetch(`/api/sharedbrain/${connId}`, { method: 'DELETE' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `disconnect failed: ${r.status}`);
        }
        _sbLastResult.delete(connId);
        await refreshSharedBrainList();
        refreshSyncPendingBadge();
      } catch (err) {
        sbSetCardStatus(connId, `Could not disconnect: ${err.message}`, true);
      }
    });
    return;
  }

  // v3.0.4 (M15): "Retry these pages" — clears permanent_skip via the
  // unskip endpoint; the pages get a fresh strike counter on the next push.
  if (action === 'retry-skipped') {
    if (_sbInFlight.has(connId)) {
      sbSetCardStatus(connId, 'An operation is already running on this connection — try again when it finishes.', true);
      return;
    }
    try {
      const r = await fetch(`/api/sharedbrain/${connId}/unskip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok !== true) throw new Error(j.error || `unskip returned ${r.status}`);
      const msg = `${j.unskipped} page${j.unskipped === 1 ? '' : 's'} re-queued — they will be retried on the next Push.`;
      _sbLastResult.set(connId, { message: msg, isError: false });
      await refreshSharedBrainList();
    } catch (err) {
      sbSetCardStatus(connId, `Could not re-queue skipped pages: ${err.message}`, true);
    }
    return;
  }

  if (!['push', 'pull', 'synthesize'].includes(action)) return;

  if (_sbInFlight.has(connId)) {
    const running = _sbInFlight.get(connId);
    sbSetCardStatus(connId, `A ${running.action} is already running on this connection — wait for it to finish.`, true);
    return;
  }
  _sbInFlight.set(connId, { action, message: `Starting ${action}…`, isError: false });
  sbSetCardBusy(connId, true);

  function setStatus(msg, isError = false) {
    const entry = _sbInFlight.get(connId);
    if (entry) { entry.message = msg; entry.isError = isError; }
    sbSetCardStatus(connId, msg, isError);
  }
  setStatus(`Starting ${action}…`);

  // v3.0.2: register through the same busy-state gate as ingest so
  // Update / Sync / Delete buttons are disabled while a Shared Brain
  // operation writes (mirrors the backend write-registry 409 guard).
  const busyKey = `sharedbrain:${connId}`;
  if (window.__curatorIngestStart) window.__curatorIngestStart(busyKey);

  let hadError = false;
  try {
    const r = await fetch(`/api/sharedbrain/${connId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `${action} returned ${r.status}`);
    }

    // Parse SSE stream
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastMessage = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const event of events) {
        if (!event.startsWith('data:')) continue;
        try {
          const payload = JSON.parse(event.slice(5).trim());
          if (payload.type === 'error') {
            hadError = true;
            setStatus(`Error: ${payload.message}`, true);
          } else if (payload.type === 'done') {
            // v3.0.4 (M13): prefer the backend's real summary; otherwise
            // compose one from the result fields (pull counts, synthesis
            // conflicts incl. affected pages); never downgrade to a bare
            // "completed" while a richer message was streamed.
            setStatus(sbComposeDoneMessage(action, payload, lastMessage));
          } else if (payload.message) {
            lastMessage = payload.message;
            setStatus(lastMessage);
          }
        } catch { /* malformed SSE frame — ignore */ }
      }
    }
  } catch (err) {
    hadError = true;
    setStatus(`Error: ${err.message}`, true);
  } finally {
    // Persist the final message BEFORE any re-render so the fresh card
    // restores it (M13), then release the registries.
    const entry = _sbInFlight.get(connId);
    if (entry) _sbLastResult.set(connId, { message: entry.message, isError: entry.isError || hadError });
    _sbInFlight.delete(connId);
    // Re-enable BEFORE releasing the global gate: if another ingest is still
    // active, the gate's re-application re-disables with correct bookkeeping.
    sbSetCardBusy(connId, false);
    if (window.__curatorIngestEnd) window.__curatorIngestEnd(busyKey);
  }

  if (!hadError) {
    // Refresh so updated stats (last pushed/pulled/synthesis, pending count)
    // appear — the re-render restores the final status from _sbLastResult.
    await refreshSharedBrainList();
    refreshSyncPendingBadge();
  }
}

// ── v3.0.5 (4.4) — invite-token re-display from the card ───────────────────
//
// The invite token is DETERMINISTIC (base64 of the connection's metadata),
// so re-generating from the stored fields reproduces the original token.
// No secrets involved — safe to show any time.

async function sbToggleInviteBox(connId, card, conn) {
  const box = card.querySelector('[data-field="token-box"]');
  if (!box) return;
  if (!box.classList.contains('hidden')) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  if (!conn || conn.storage_type !== 'github') {
    sbSetCardStatus(connId, 'Invite re-display is only available for GitHub-backed brains.', true);
    return;
  }
  box.classList.remove('hidden');
  box.textContent = 'Generating invite token…';
  try {
    const r = await fetch('/api/sharedbrain/generate-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: `${conn.github_repo_owner}/${conn.github_repo_name}`,
        name: conn.label,
        shared_domain: conn.shared_domain,
        branch: conn.github_branch || 'main',
        storage_type: 'github',
        data_handling_terms: conn.data_handling_terms || 'contributor_retains',
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `generate-invite returned ${r.status}`);
    // NOTE: the response also carries a fresh admin_token — deliberately
    // ignored here (this action re-displays the INVITE token only).
    box.textContent = '';
    sbRenderTokenBox(box, 'Invite token — share with new contributors (metadata only, no credentials):', j.token);
    if (!conn.data_handling_terms) {
      const warn = document.createElement('p');
      warn.className = 'hint';
      warn.textContent = '⚠ This connection predates v3.0.5, so the token above uses the default "contributor retains copyright" terms. If your brain was set up with the organisational (IP transfer) mode, contributors joining with this token would see the wrong consent text — use your originally shared token instead.';
      box.appendChild(warn);
    }
  } catch (err) {
    box.textContent = `Could not generate the invite token: ${err.message}`;
  }
}

// Render a selectable token + Copy button into a container (textContent
// only — never innerHTML with dynamic data).
function sbRenderTokenBox(box, labelText, token) {
  const label = document.createElement('div');
  label.className = 'hint';
  label.textContent = labelText;
  const code = document.createElement('code');
  code.className = 'sb-invite-token-display';
  code.textContent = token;
  const copy = document.createElement('button');
  copy.className = 'btn';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(token);
      copy.textContent = 'Copied ✓';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
    } catch {
      copy.textContent = 'Copy blocked — select the token manually';
      setTimeout(() => { copy.textContent = 'Copy'; }, 3500);
    }
  });
  box.append(label, code, copy);
}

// ── v3.0.5 (4.1) — admin-token generation / rotation from the card ─────────

function sbHandleAdminToken(connId, card, conn) {
  if (_sbInFlight.has(connId)) {
    sbSetCardStatus(connId, 'An operation is running on this connection — try again when it finishes.', true);
    return;
  }
  const hasToken = !!(conn && typeof conn.admin_token === 'string' && conn.admin_token.length > 0);
  const statusEl = card.querySelector('[data-field="status"]');
  if (!statusEl) return;
  statusEl.textContent = '';
  statusEl.classList.remove('error');
  statusEl.classList.add('active');
  const text = document.createElement('span');
  text.textContent = hasToken
    ? 'Rotate the admin token? The CURRENT token stops working immediately — anywhere you stored it becomes invalid. '
    : 'Generate an admin token for this connection? It authorises contributor revocation (GDPR erasure) and is shown only once — have your password manager ready. ';
  const yes = document.createElement('button');
  yes.className = 'btn primary';
  yes.textContent = hasToken ? 'Rotate token' : 'Generate token';
  const no = document.createElement('button');
  no.className = 'btn';
  no.textContent = 'Cancel';
  statusEl.append(text, yes, document.createTextNode(' '), no);
  no.addEventListener('click', () => { statusEl.textContent = ''; statusEl.classList.remove('active'); });
  yes.addEventListener('click', async () => {
    yes.disabled = true; no.disabled = true;
    try {
      const r = await fetch(`/api/sharedbrain/${connId}/admin-token/rotate`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok !== true) throw new Error(j.error || `rotate returned ${r.status}`);
      statusEl.textContent = '';
      statusEl.classList.remove('active');
      // Show ONCE in the token box; deliberately no auto-refresh (a
      // re-render would wipe the display before the admin copies it).
      const box = card.querySelector('[data-field="token-box"]');
      if (box) {
        box.classList.remove('hidden');
        box.textContent = '';
        sbRenderTokenBox(box,
          'Your admin token — shown ONCE. Store it in a password manager now; it authorises contributor revocation:',
          j.admin_token);
      }
      // Update the current card in place so the admin affordances appear.
      const btn = card.querySelector('button[data-action="admin-token"]');
      if (btn) btn.textContent = 'Rotate admin token';
      const revokeBtn = card.querySelector('button[data-action="revoke"]');
      if (revokeBtn) revokeBtn.classList.remove('hidden');
      if (conn) conn.admin_token = 'sbat_set…'; // presence marker for this render's closures
    } catch (err) {
      sbSetCardStatus(connId, `Could not ${hasToken ? 'rotate' : 'generate'} the admin token: ${err.message}`, true);
    }
  });
}

// ── v3.0.5 (4.2) — revoke UI (GDPR Article 17) ──────────────────────────────

async function sbToggleRevokePanel(connId, card, conn) {
  const panel = card.querySelector('[data-field="revoke-panel"]');
  if (!panel) return;
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    panel.textContent = '';
    return;
  }
  panel.classList.remove('hidden');
  panel.textContent = 'Loading the member list from the shared repo…';
  try {
    const r = await fetch(`/api/sharedbrain/${connId}/members`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `members returned ${r.status}`);
    sbBuildRevokePanel(connId, card, panel, Array.isArray(j.members) ? j.members : [], j.self_fellow_id);
  } catch (err) {
    panel.textContent = `Could not load the member list: ${err.message}`;
  }
}

function sbBuildRevokePanel(connId, card, panel, members, selfFellowId) {
  panel.textContent = '';
  const h = document.createElement('h5');
  h.textContent = 'Revoke a contributor — GDPR Article 17 (irreversible)';
  const intro = document.createElement('p');
  intro.className = 'hint';
  intro.textContent = 'Permanently erases the contributor\'s submissions and every collective page they touched, then rebuilds the collective from the remaining contributors. This cannot be undone.';
  panel.append(h, intro);

  if (members.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No contributions found in this brain yet — there is nobody to revoke.';
    panel.appendChild(p);
    return;
  }

  let selected = null;

  const list = document.createElement('div');
  list.className = 'sb-revoke-members';

  const tokenLabel = document.createElement('label');
  tokenLabel.textContent = 'Admin token (from your password manager)';
  const tokenInput = document.createElement('input');
  tokenInput.type = 'password';
  tokenInput.placeholder = 'sbat_…';
  tokenInput.autocomplete = 'off';

  const confirmLabel = document.createElement('label');
  confirmLabel.textContent = 'Type the confirmation to unlock';
  const confirmInput = document.createElement('input');
  confirmInput.type = 'text';
  confirmInput.placeholder = 'Select a member first';
  confirmInput.autocomplete = 'off';
  confirmInput.spellcheck = false;

  const goBtn = document.createElement('button');
  goBtn.className = 'btn sync-disconnect-btn';
  goBtn.textContent = 'Permanently revoke this contributor';
  goBtn.disabled = true;

  function refreshGo() {
    goBtn.disabled = !(
      selected &&
      tokenInput.value.trim().length >= 16 &&
      confirmInput.value.trim() === `REVOKE-${selected.short_id}`
    );
  }
  tokenInput.addEventListener('input', refreshGo);
  confirmInput.addEventListener('input', refreshGo);

  for (const m of members) {
    const label = document.createElement('label');
    label.className = 'sb-checkbox-label';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `sb-revoke-pick-${connId}`;
    const span = document.createElement('span');
    const who = m.display_name ? `${m.display_name} (${m.short_id}…)` : `fellow ${m.short_id}…`;
    const self = m.fellow_id === selfFellowId ? ' — YOU' : '';
    span.textContent = `${who}${self} · ${m.submissions} submission${m.submissions === 1 ? '' : 's'} · last active ${formatRelativeTime(m.last_contributed_at)}`;
    radio.addEventListener('change', () => {
      selected = m;
      confirmInput.placeholder = `Type REVOKE-${m.short_id}`;
      refreshGo();
    });
    label.append(radio, span);
    list.appendChild(label);
  }

  goBtn.addEventListener('click', () => {
    runSharedBrainRevoke(connId, card, selected, tokenInput.value.trim(), goBtn);
  });

  panel.append(list, tokenLabel, tokenInput, confirmLabel, confirmInput, goBtn);
}

async function runSharedBrainRevoke(connId, card, member, adminToken, goBtn) {
  if (!member || !adminToken) return;
  if (_sbInFlight.has(connId)) {
    sbSetCardStatus(connId, 'An operation is already running on this connection — wait for it to finish.', true);
    return;
  }
  _sbInFlight.set(connId, { action: 'revoke', message: 'Starting revocation…', isError: false });
  sbSetCardBusy(connId, true);
  if (goBtn) goBtn.disabled = true;

  function setStatus(msg, isError = false) {
    const entry = _sbInFlight.get(connId);
    if (entry) { entry.message = msg; entry.isError = isError; }
    sbSetCardStatus(connId, msg, isError);
  }
  setStatus('Starting revocation…');

  const busyKey = `sharedbrain:${connId}`;
  if (window.__curatorIngestStart) window.__curatorIngestStart(busyKey);

  let hadError = false;
  try {
    const r = await fetch(`/api/sharedbrain/${connId}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        admin_token: adminToken,
        fellow_id: member.fellow_id,
        // The user deliberately typed REVOKE-<short id>; the API contract
        // requires the full literal — construct it from the picked member.
        confirmation: `REVOKE-${member.fellow_id}`,
      }),
    });

    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `revoke returned ${r.status}`);
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const event of events) {
        if (!event.startsWith('data:')) continue;
        try {
          const payload = JSON.parse(event.slice(5).trim());
          if (payload.type === 'error') {
            hadError = true;
            setStatus(`Error: ${payload.message}`, true);
          } else if (payload.type === 'done') {
            const res = payload.result || {};
            setStatus(
              `Revocation complete: ${res.contributions_deleted ?? '?'} contributions deleted, ` +
              `${res.pages_deleted ?? '?'} pages removed, ${res.pages_rebuilt ?? '?'} rebuilt. ` +
              'Next: tell every contributor to Pull updates (their mirrors drop the erased content), ' +
              'and remove the person as a GitHub collaborator so they cannot push again.'
            );
          } else if (payload.message) {
            setStatus(payload.message);
          }
        } catch { /* malformed SSE frame — ignore */ }
      }
    }
  } catch (err) {
    hadError = true;
    setStatus(`Error: ${err.message}`, true);
  } finally {
    const entry = _sbInFlight.get(connId);
    if (entry) _sbLastResult.set(connId, { message: entry.message, isError: entry.isError || hadError });
    _sbInFlight.delete(connId);
    sbSetCardBusy(connId, false);
    if (window.__curatorIngestEnd) window.__curatorIngestEnd(busyKey);
  }

  if (!hadError) {
    await refreshSharedBrainList();
    refreshSyncPendingBadge();
  }
}

// ── Shared Brain Wizard — Phase 4D (contributor path) ──────────────────────

const sbWizard = {
  state: {
    mode: 'join', // 'join' or 'create' — 'create' lands in Phase 4E
    inviteMetadata: null,    // {repo, name, branch, shared_domain, ...}
    pat: '',
    patValidation: null,      // {valid, hasWriteAccess, isPrivate, defaultBranch, message}
    selectedDomains: new Set(),
    displayName: '',
    attributeByName: false,
    consent: false,
    currentStep: 1,
    saveInProgress: false,
    slugManuallyEdited: false,    // admin path: auto-derive slug until user overrides
    generatedInviteToken: null,   // admin path: token shown on Step 2
    generatedAdminToken: null,    // admin path (v3.0.5): revocation credential, shown once
  },
  reset() {
    this.state = {
      mode: 'join',
      inviteMetadata: null,
      pat: '',
      patValidation: null,
      selectedDomains: new Set(),
      displayName: '',
      attributeByName: false,
      consent: false,
      currentStep: 1,
      saveInProgress: false,
      slugManuallyEdited: false,
      generatedInviteToken: null,
      generatedAdminToken: null,
    };
  },
};

function openSharedBrainWizard(mode) {
  sbWizard.reset();
  sbWizard.state.mode = mode || 'join';

  // Wizard title varies by mode
  const titleEl = document.getElementById('sb-wizard-title');
  const subtitleEl = document.getElementById('sb-wizard-subtitle');
  if (titleEl) {
    titleEl.textContent = sbWizard.state.mode === 'create'
      ? 'Set up a new Shared Brain'
      : 'Join a Shared Brain';
  }
  if (subtitleEl) {
    subtitleEl.textContent = sbWizard.state.mode === 'create'
      ? 'Create one for your cohort, team, or research group.'
      : "Connect to your cohort's collective wiki.";
  }

  // Clear contributor-path inputs
  const inviteInput = document.getElementById('sb-invite-token');
  if (inviteInput) inviteInput.value = '';
  const patInput = document.getElementById('sb-pat-input');
  if (patInput) { patInput.value = ''; patInput.type = 'password'; }
  const previewEl = document.getElementById('sb-invite-preview');
  if (previewEl) previewEl.classList.add('hidden');
  const patValidationEl = document.getElementById('sb-pat-validation');
  if (patValidationEl) {
    patValidationEl.classList.add('hidden');
    patValidationEl.className = 'sb-pat-validation hidden';
    patValidationEl.textContent = '';
  }
  const consentEl = document.getElementById('sb-consent');
  if (consentEl) consentEl.checked = false;
  const nameEl = document.getElementById('sb-display-name');
  if (nameEl) nameEl.value = '';
  const attrEl = document.getElementById('sb-attribute-name');
  if (attrEl) attrEl.checked = false;

  // Clear admin-path inputs
  for (const id of ['sb-admin-repo', 'sb-admin-name', 'sb-admin-shared-domain']) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  const branchEl = document.getElementById('sb-admin-branch');
  if (branchEl) branchEl.value = 'main';
  const dhtDefault = document.querySelector('input[name="sb-admin-dht"][value="contributor_retains"]');
  if (dhtDefault) dhtDefault.checked = true;
  const adminTokenDisplay = document.getElementById('sb-admin-invite-token');
  if (adminTokenDisplay) adminTokenDisplay.textContent = 'sbi_…';
  const adminAdminToken = document.getElementById('sb-admin-admin-token');
  if (adminAdminToken) adminAdminToken.textContent = 'sbat_…';

  // Reset disabled-button state
  document.getElementById('sb-step1-next').disabled = true;
  document.getElementById('sb-step3-next').disabled = true;
  document.getElementById('sb-step5-save').disabled = true;
  for (const stepId of ['sb-step1-status', 'sb-step4-status', 'sb-step5-status', 'sb-admin-step1-status']) {
    const el = document.getElementById(stepId);
    if (el) { el.classList.add('hidden'); el.textContent = ''; }
  }

  // v3.0.4 (L16): remember what had focus so closing returns the user
  // where they were; trap Tab inside the dialog while it is open.
  _sbWizardPrevFocus = document.activeElement;
  document.getElementById('sharedbrain-wizard').classList.remove('hidden');
  document.addEventListener('keydown', sbWizardKeydown, true);
  sbWizardGoToStep(1);
}

// v3.0.4 (L16): modal keyboard behaviour — Escape closes, Tab cycles
// within the wizard card (focus trap).
let _sbWizardPrevFocus = null;
function sbWizardKeydown(e) {
  const overlay = document.getElementById('sharedbrain-wizard');
  if (!overlay || overlay.classList.contains('hidden')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSharedBrainWizard();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusables = overlay.querySelectorAll(
    'button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const visible = [...focusables].filter(el => el.offsetParent !== null);
  if (visible.length === 0) return;
  const first = visible[0];
  const last = visible[visible.length - 1];
  if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
    e.preventDefault();
    first.focus();
  }
}

function closeSharedBrainWizard() {
  document.getElementById('sharedbrain-wizard').classList.add('hidden');
  document.removeEventListener('keydown', sbWizardKeydown, true);
  // Restore focus to where the user was before the dialog opened (L16).
  if (_sbWizardPrevFocus && typeof _sbWizardPrevFocus.focus === 'function') {
    try { _sbWizardPrevFocus.focus(); } catch { /* element may be gone */ }
  }
  _sbWizardPrevFocus = null;
}

// Step IDs by mode. Admin path replaces contributor steps 1 & 2 with its
// own setup + invite-display panels; steps 3-5 are shared between modes.
const SB_STEP_PANELS = {
  join: ['sb-step-1', 'sb-step-2', 'sb-step-3', 'sb-step-4', 'sb-step-5'],
  create: ['sb-admin-step-1', 'sb-admin-step-2', 'sb-step-3', 'sb-step-4', 'sb-step-5'],
};

const SB_STEP_LABELS = {
  join:   ['Token', 'Access', 'PAT', 'Domains', 'Save'],
  create: ['Setup', 'Invite', 'PAT', 'Domains', 'Save'],
};

function sbWizardGoToStep(n) {
  sbWizard.state.currentStep = n;
  const mode = sbWizard.state.mode || 'join';
  const panelIds = SB_STEP_PANELS[mode] || SB_STEP_PANELS.join;
  // Hide every wizard panel (both modes), then show only the active one.
  const allPanelIds = new Set([...SB_STEP_PANELS.join, ...SB_STEP_PANELS.create]);
  for (const id of allPanelIds) {
    const panel = document.getElementById(id);
    if (panel) panel.classList.add('hidden');
  }
  const activeId = panelIds[n - 1];
  const active = activeId ? document.getElementById(activeId) : null;
  if (active) active.classList.remove('hidden');

  // v3.0.4 (M9): populate outbound links when their panel becomes VISIBLE,
  // not when it is left. Before this, the step-2 "Open the repo on GitHub"
  // link was empty on first entry — the one step designed for the
  // collaborator-invite confusion case opened the Curator page itself.
  if (activeId === 'sb-step-2') refreshStep2Links();
  if (activeId === 'sb-step-3') refreshPatCreateLink();

  // Update progress indicator labels + active/done states
  const labels = SB_STEP_LABELS[mode] || SB_STEP_LABELS.join;
  const steps = document.querySelectorAll('.sb-progress .ob-step');
  steps.forEach(el => {
    const num = Number(el.dataset.step);
    el.classList.toggle('active', num === n);
    el.classList.toggle('done', num < n);
    // v3.0.4 (L16): announce the current step to assistive tech.
    if (num === n) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
    const labelEl = el.querySelector(`[data-label="step${num}"]`);
    if (labelEl && labels[num - 1]) labelEl.textContent = labels[num - 1];
  });

  // v3.0.4 (L16): move focus to the newly visible panel's heading region.
  if (active) {
    const heading = active.querySelector('h3');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: false });
    }
  }
}

// ── Step 1: invite token paste + decode ────────────────────────────────────

function bindSharedBrainWizardStep1() {
  const input  = document.getElementById('sb-invite-token');
  const preview = document.getElementById('sb-invite-preview');
  const nextBtn = document.getElementById('sb-step1-next');
  const statusEl = document.getElementById('sb-step1-status');
  if (!input) return;

  // v3.0.4 (M11): monotonic sequence guard — a slow response for an OLD
  // input value must never overwrite the verdict for the current one.
  let debounce = null;
  let seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const mySeq = ++seq; // anything in flight is now stale
    nextBtn.disabled = true;
    sbWizard.state.inviteMetadata = null;
    statusEl.classList.add('hidden');
    preview.classList.add('hidden');
    const token = input.value.trim();
    if (!token) return;
    debounce = setTimeout(async () => {
      try {
        const r = await fetch('/api/sharedbrain/parse-invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const j = await r.json();
        if (mySeq !== seq) return; // stale response — a newer input superseded it
        if (!j.valid) {
          statusEl.textContent = j.error || 'Invite token is invalid.';
          statusEl.className = 'status error';
          statusEl.classList.remove('hidden');
          return;
        }
        sbWizard.state.inviteMetadata = j.metadata;
        preview.querySelector('[data-field="name"]').textContent = j.metadata.name;
        preview.querySelector('[data-field="repo"]').textContent = j.metadata.repo;
        preview.querySelector('[data-field="branch"]').textContent = j.metadata.branch || 'main';
        preview.querySelector('[data-field="shared_domain"]').textContent = j.metadata.shared_domain;
        preview.classList.remove('hidden');
        nextBtn.disabled = false;
      } catch (err) {
        if (mySeq !== seq) return;
        statusEl.textContent = `Could not parse token: ${err.message}`;
        statusEl.className = 'status error';
        statusEl.classList.remove('hidden');
      }
    }, 280);
  });

  nextBtn.addEventListener('click', () => sbWizardGoToStep(2));
}

// ── Step 2: confirm GitHub access ──────────────────────────────────────────

function bindSharedBrainWizardStep2() {
  const next  = document.getElementById('sb-step2-next');
  if (!next) return;
  // Link population happens on panel ENTRY via sbWizardGoToStep (M9) —
  // this button only advances.
  next.addEventListener('click', () => sbWizardGoToStep(3));
}

// Populate step-2 links + copy whenever the panel becomes visible (first
// entry, Back-nav, or re-entry) — v3.0.4 (M9, L18).
function refreshStep2Links() {
  const meta = sbWizard.state.inviteMetadata;
  if (!meta) return;
  const repoLink = document.getElementById('sb-repo-link');
  if (repoLink) repoLink.href = `https://github.com/${meta.repo}`;
  // L18: the invitation-email hint names the repo (we never know the
  // admin's personal name — the invite token carries the brain name only).
  const repoName = document.querySelector('#sb-step-2 [data-field="invite-repo"]');
  if (repoName) repoName.textContent = meta.repo;
}

// Populate the PAT-create deep link whenever step 3 becomes visible —
// works for both the contributor and admin paths (M9).
function refreshPatCreateLink() {
  const meta = sbWizard.state.inviteMetadata;
  if (!meta) return;
  const patLink = document.getElementById('sb-pat-create-link');
  if (patLink) {
    const name = `Curator Shared Brain - ${meta.name}`.slice(0, 60);
    patLink.href = `https://github.com/settings/personal-access-tokens/new?name=${encodeURIComponent(name)}`;
  }
}

// ── Step 3: PAT paste + live validation ────────────────────────────────────

function bindSharedBrainWizardStep3() {
  const input  = document.getElementById('sb-pat-input');
  const validation = document.getElementById('sb-pat-validation');
  const nextBtn = document.getElementById('sb-step3-next');
  if (!input) return;

  function setValidation(state, message) {
    validation.className = `sb-pat-validation ${state}`;
    validation.textContent = message;
    validation.classList.remove('hidden');
  }

  // v3.0.4 (M11): sequence guard, and the PAT is stored in wizard state
  // ONLY after a valid verdict — a stale/rejected token can no longer
  // linger in state and get saved.
  let debounce = null;
  let seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const mySeq = ++seq;
    nextBtn.disabled = true;
    sbWizard.state.pat = '';
    sbWizard.state.patValidation = null;
    const pat = input.value.trim();

    if (!pat) {
      validation.classList.add('hidden');
      return;
    }
    if (pat.length < 20) {
      setValidation('checking', 'Token looks too short — keep pasting.');
      return;
    }

    debounce = setTimeout(async () => {
      const meta = sbWizard.state.inviteMetadata;
      if (!meta) {
        setValidation('err', 'Lost the invite metadata — go back to step 1.');
        return;
      }
      setValidation('checking', 'Checking your token against GitHub…');
      try {
        const r = await fetch('/api/sharedbrain/validate-pat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: meta.repo, pat }),
        });
        const j = await r.json();
        if (mySeq !== seq) return; // stale response — a newer paste superseded it

        if (!j.valid) {
          setValidation('err', j.error || 'Token rejected by GitHub.');
          return;
        }
        // Valid token → store it (M11: only on valid).
        sbWizard.state.patValidation = j;
        sbWizard.state.pat = pat;

        if (!j.hasWriteAccess) {
          // v3.0.4 (H10): read-only tokens may proceed as read-only
          // members — they can Pull the collective wiki but not Push.
          setValidation('warn',
            '⚠️ Token works but is read-only. You can continue as a read-only member — ' +
            'you\'ll be able to Pull the collective wiki, but not push contributions. ' +
            'To contribute, re-create the token with Contents: Read AND write, then re-paste.');
          nextBtn.disabled = false;
          return;
        }
        setValidation('ok',
          `✓ Token verified. Authenticated against ${j.repoFullName || meta.repo}.`);
        nextBtn.disabled = false;
      } catch (err) {
        if (mySeq !== seq) return;
        setValidation('err', `Could not reach the Curator server: ${err.message}`);
      }
    }, 400);
  });

  nextBtn.addEventListener('click', () => {
    sbWizardGoToStep(4);
    populateSharedBrainDomains();
  });
}

// ── Step 4: pick personal domains + display name ───────────────────────────

async function populateSharedBrainDomains() {
  const container = document.getElementById('sb-domain-checkboxes');
  if (!container) return;
  container.innerHTML = '<p class="hint">Loading domains…</p>';

  try {
    const r = await fetch('/api/domains');
    const j = await r.json();
    const domains = Array.isArray(j) ? j : (j.domains || []);
    // Filter out shared-* mirror domains — never contribute from a mirror
    const eligible = domains.filter(d => {
      const name = typeof d === 'string' ? d : d.name;
      return name && !name.startsWith('shared-');
    });

    if (eligible.length === 0) {
      container.innerHTML = '<p class="hint">No personal domains found. <a href="#" onclick="document.querySelector(\'[data-tab=domains]\').click(); return false;">Create one first</a>, then come back.</p>';
      return;
    }

    // v3.0.4 (M10): the checkboxes are REBUILT every time this panel is
    // entered, but state.selectedDomains persists across back/forward.
    // Restore the checked state from state (and drop selections whose
    // domain no longer exists) so what the user sees is what gets saved.
    const eligibleNames = new Set(eligible.map(d => (typeof d === 'string' ? d : d.name)));
    for (const sel of [...sbWizard.state.selectedDomains]) {
      if (!eligibleNames.has(sel)) sbWizard.state.selectedDomains.delete(sel);
    }

    container.innerHTML = '';
    for (const d of eligible) {
      const name = typeof d === 'string' ? d : d.name;
      const label = document.createElement('label');
      label.className = 'sb-checkbox-label';
      label.innerHTML = `
        <input type="checkbox" value="" />
        <span></span>
      `;
      const cb = label.querySelector('input');
      cb.value = name;
      cb.checked = sbWizard.state.selectedDomains.has(name); // M10
      label.querySelector('span').textContent = name;
      cb.addEventListener('change', () => {
        if (cb.checked) sbWizard.state.selectedDomains.add(name);
        else            sbWizard.state.selectedDomains.delete(name);
      });
      container.appendChild(label);
    }
  } catch (err) {
    container.textContent = '';
    const p = document.createElement('p');
    p.className = 'status error';
    p.textContent = `Could not load domains: ${err.message}`;
    container.appendChild(p);
  }
}

// A connection is read-only when the PAT verdict was valid-but-no-write
// (v3.0.4, H10).
function sbIsReadOnlyVerdict() {
  const v = sbWizard.state.patValidation;
  return !!(v && v.valid && !v.hasWriteAccess);
}

function bindSharedBrainWizardStep4() {
  const nameEl = document.getElementById('sb-display-name');
  const attrEl = document.getElementById('sb-attribute-name');
  const next   = document.getElementById('sb-step4-next');
  const status = document.getElementById('sb-step4-status');
  if (!next) return;

  if (nameEl) nameEl.addEventListener('input', () => {
    sbWizard.state.displayName = nameEl.value.trim();
  });
  if (attrEl) attrEl.addEventListener('change', () => {
    sbWizard.state.attributeByName = attrEl.checked;
  });

  next.addEventListener('click', () => {
    if (status) status.classList.add('hidden');
    // Validate at least one domain selected — unless this is a read-only
    // member (H10): they can't push, so contributing domains are optional.
    if (sbWizard.state.selectedDomains.size === 0 && !sbIsReadOnlyVerdict()) {
      // v3.0.4 (L14): inline status instead of alert().
      if (status) {
        status.textContent = 'Please select at least one personal domain to contribute. (You can change this later.)';
        status.className = 'status error';
        status.classList.remove('hidden');
      }
      return;
    }
    if (!sbWizard.state.displayName) {
      // Default display name = "Fellow <short fellow_id>" — we don't have a fellow_id yet
      // (server assigns it on save). Use a generic placeholder — and reflect
      // it in the input so Back-nav shows what will actually be saved (L17).
      sbWizard.state.displayName = 'Anonymous Fellow';
      if (nameEl) nameEl.value = 'Anonymous Fellow';
    }
    refreshConsentTextForMode();
    populateSharedBrainReview();
    sbWizardGoToStep(5);
  });
}

// ── Step 5: review + consent + save ────────────────────────────────────────

function populateSharedBrainReview() {
  const meta = sbWizard.state.inviteMetadata;
  const box  = document.querySelector('.sb-review-box');
  if (!box || !meta) return;
  box.querySelector('[data-field="name"]').textContent = meta.name;
  box.querySelector('[data-field="repo"]').textContent =
    meta.repo + (sbIsReadOnlyVerdict() ? ' (read-only member — Pull only)' : '');
  box.querySelector('[data-field="domains"]').textContent =
    [...sbWizard.state.selectedDomains].join(', ') ||
    (sbIsReadOnlyVerdict() ? '(none — read-only members don\'t push)' : '(none)');
  box.querySelector('[data-field="display-name"]').textContent = sbWizard.state.displayName;
  box.querySelector('[data-field="attribution"]').textContent =
    sbWizard.state.attributeByName
      ? 'show name (admin must also enable cohort-side)'
      : 'anonymous UUID (default)';
}

function bindSharedBrainWizardStep5() {
  const consent = document.getElementById('sb-consent');
  const save    = document.getElementById('sb-step5-save');
  const status  = document.getElementById('sb-step5-status');
  if (!consent || !save) return;

  consent.addEventListener('change', () => {
    sbWizard.state.consent = consent.checked;
    save.disabled = !consent.checked || sbWizard.state.saveInProgress;
  });

  save.addEventListener('click', async () => {
    if (!sbWizard.state.consent) return;
    sbWizard.state.saveInProgress = true;
    save.disabled = true;
    save.textContent = 'Saving…';
    status.classList.add('hidden');

    const meta = sbWizard.state.inviteMetadata;
    // Generate a slug derived from the brain name for the local mirror.
    const brainSlug = meta.name.toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'cohort';

    const connection = {
      label: meta.name,
      storage_type: meta.storage_type || 'github',
      github_repo_owner: meta.repo.split('/')[0],
      github_repo_name:  meta.repo.split('/')[1],
      github_pat:        sbWizard.state.pat,
      github_branch:     meta.branch || 'main',
      fellow_display_name: sbWizard.state.displayName,
      shared_domain:       meta.shared_domain,
      shared_brain_slug:   brainSlug,
      local_domains:       [...sbWizard.state.selectedDomains],
      attribute_by_name:   sbWizard.state.attributeByName,
      read_only:           sbIsReadOnlyVerdict(), // v3.0.4 (H10)
      // v3.0.5 (4.4): persisted so the invite token can be re-displayed
      // from the card with the right consent mode.
      data_handling_terms: meta.data_handling_terms || 'contributor_retains',
      enabled: true,
    };
    // v3.0.5 (4.1): the admin path stores the revocation credential shown
    // on step 2. Contributor connections have no admin token.
    if (sbWizard.state.mode === 'create' && sbWizard.state.generatedAdminToken) {
      connection.admin_token = sbWizard.state.generatedAdminToken;
    }

    try {
      const r = await fetch('/api/sharedbrain/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Save failed');

      closeSharedBrainWizard();
      // v3.0.4 (L17): don't keep the PAT in wizard state after it has been
      // persisted — reset the whole state and clear the input field.
      sbWizard.reset();
      const patField = document.getElementById('sb-pat-input');
      if (patField) patField.value = '';
      await refreshSharedBrainList();
      refreshSyncPendingBadge();
    } catch (err) {
      status.textContent = `Could not save: ${err.message}`;
      status.className = 'status error';
      status.classList.remove('hidden');
      save.textContent = 'Save & Connect';
      sbWizard.state.saveInProgress = false;
      save.disabled = false;
    }
  });
}

// ── Wizard chrome (close, back buttons, password toggles) ──────────────────

function bindSharedBrainWizardChrome() {
  const closeBtn = document.getElementById('sb-wizard-close');
  if (closeBtn) closeBtn.addEventListener('click', closeSharedBrainWizard);

  // Back / Cancel buttons inside each panel
  document.querySelectorAll('#sharedbrain-wizard .ob-actions .btn[data-action]').forEach(btn => {
    const action = btn.dataset.action;
    btn.addEventListener('click', () => {
      if (action === 'close') {
        closeSharedBrainWizard();
      } else if (action === 'back') {
        const n = sbWizard.state.currentStep;
        // Panel-entry side effects (link population) run inside
        // sbWizardGoToStep — nothing extra needed here (M9).
        if (n > 1) sbWizardGoToStep(n - 1);
      }
    });
  });

  // Eye-icon password toggle for PAT field (reuses .toggle-vis from existing app)
  document.querySelectorAll('#sharedbrain-wizard .toggle-vis').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.target;
      const input = document.getElementById(id);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });
}

// ── CTA buttons wired to open the wizard ───────────────────────────────────

function bindSharedBrainCtas() {
  // Contributor path
  for (const id of ['sharedbrain-join-btn', 'sharedbrain-join-btn-2']) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => openSharedBrainWizard('join'));
  }
  // Admin path (Phase 4E)
  for (const id of ['sharedbrain-create-btn', 'sharedbrain-create-btn-2']) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => openSharedBrainWizard('create'));
  }
}

// ── Admin Step 1: collect form, generate invite token, advance to Step 2 ──

function slugifyForSharedDomain(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')   // anything not a slug char → hyphen
    .replace(/^-+|-+$/g, '')          // trim leading/trailing hyphens
    .replace(/-{2,}/g, '-')           // collapse runs of hyphens
    .slice(0, 40);
}

function bindSharedBrainAdminStep1() {
  const next = document.getElementById('sb-admin-step1-next');
  const status = document.getElementById('sb-admin-step1-status');
  if (!next) return;

  // Auto-derive the "folder inside the repo" slug from the brain name as
  // the user types — until the user manually edits the slug field, at
  // which point we respect their override and stop auto-filling.
  // The "manually edited" state lives on sbWizard.state so it resets on
  // every openSharedBrainWizard() call (otherwise a previous session's
  // manual edit would freeze auto-derive forever).
  const nameEl = document.getElementById('sb-admin-name');
  const slugEl = document.getElementById('sb-admin-shared-domain');

  if (nameEl && slugEl) {
    nameEl.addEventListener('input', () => {
      if (!sbWizard.state.slugManuallyEdited) {
        slugEl.value = slugifyForSharedDomain(nameEl.value);
      }
    });
    slugEl.addEventListener('input', () => {
      // If user clears the slug, allow auto-derive to resume on the next name keystroke
      sbWizard.state.slugManuallyEdited = slugEl.value.length > 0;
    });
  }

  next.addEventListener('click', async () => {
    const repo = document.getElementById('sb-admin-repo').value.trim();
    const name = document.getElementById('sb-admin-name').value.trim();
    const sharedDomain = document.getElementById('sb-admin-shared-domain').value.trim();
    const branch = document.getElementById('sb-admin-branch').value.trim() || 'main';
    const dht = document.querySelector('input[name="sb-admin-dht"]:checked')?.value || 'contributor_retains';

    status.classList.add('hidden');

    // Client-side validation mirroring the server's checks
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
      status.textContent = 'Repository must be in "owner/name" format (no spaces).';
      status.className = 'status error';
      status.classList.remove('hidden');
      return;
    }
    if (!name) {
      status.textContent = 'Display name is required.';
      status.className = 'status error';
      status.classList.remove('hidden');
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(sharedDomain)) {
      status.textContent = 'Shared domain slug: lowercase letters, digits, hyphens, underscores. No spaces.';
      status.className = 'status error';
      status.classList.remove('hidden');
      return;
    }

    next.disabled = true;
    next.textContent = 'Generating…';
    try {
      const r = await fetch('/api/sharedbrain/generate-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo, name, shared_domain: sharedDomain, branch,
          data_handling_terms: dht, storage_type: 'github',
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'generate-invite failed');

      // Stash everything the admin will need as a contributor later
      sbWizard.state.inviteMetadata = {
        v: 1,
        repo, name,
        shared_domain: sharedDomain,
        branch,
        data_handling_terms: dht,
        storage_type: 'github',
      };
      sbWizard.state.generatedInviteToken = j.token;
      // v3.0.5 (Phase 4.1): the revocation credential — shown once on
      // step 2, stored on the connection at save. Keep the FIRST generated
      // one if the admin goes Back and regenerates the invite (the invite
      // token is deterministic; the admin token is random, and silently
      // replacing an already-noted-down token would strand the admin).
      if (!sbWizard.state.generatedAdminToken && j.admin_token) {
        sbWizard.state.generatedAdminToken = j.admin_token;
      }

      // Populate the share screen
      document.getElementById('sb-admin-invite-token').textContent = j.token;
      const adminTokEl = document.getElementById('sb-admin-admin-token');
      if (adminTokEl && sbWizard.state.generatedAdminToken) {
        adminTokEl.textContent = sbWizard.state.generatedAdminToken;
      }
      const collabLink = document.getElementById('sb-admin-collab-link');
      if (collabLink) collabLink.href = `https://github.com/${repo}/settings/access`;

      sbWizardGoToStep(2);
    } catch (err) {
      status.textContent = `Could not generate invite token: ${err.message}`;
      status.className = 'status error';
      status.classList.remove('hidden');
    } finally {
      next.disabled = false;
      next.textContent = 'Continue →';
    }
  });
}

// ── Admin Step 2: copy invite token + advance to PAT step ──

// Shared copy-button behaviour for wizard token boxes (invite + admin token).
function bindSbCopyButton(btnId, getText) {
  const copyBtn = document.getElementById(btnId);
  if (!copyBtn) return;
  copyBtn.addEventListener('click', async () => {
    const text = getText();
    if (!text) return;
    const label = copyBtn.querySelector('span');
    try {
      await navigator.clipboard.writeText(text);
      const original = label ? label.textContent : 'Copy';
      copyBtn.classList.add('copied');
      if (label) label.textContent = 'Copied ✓';
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        if (label) label.textContent = original;
      }, 1800);
    } catch {
      // v3.0.4 (L14): inline hint instead of alert() — select-and-copy
      // still works; the button label says why nothing happened.
      if (label) {
        const original = label.textContent;
        label.textContent = 'Copy blocked — select the token and copy manually';
        setTimeout(() => { label.textContent = original; }, 4000);
      }
    }
  });
}

function bindSharedBrainAdminStep2() {
  bindSbCopyButton('sb-admin-copy-invite', () => sbWizard.state.generatedInviteToken);
  bindSbCopyButton('sb-admin-copy-admin-token', () => sbWizard.state.generatedAdminToken);

  const next = document.getElementById('sb-admin-step2-next');
  if (next) {
    // PAT-link population happens on step-3 entry via sbWizardGoToStep (M9).
    next.addEventListener('click', () => sbWizardGoToStep(3));
  }
}

// ── Adapt consent text based on data_handling_terms (Decision 6c) ──────────

function refreshConsentTextForMode() {
  const meta = sbWizard.state.inviteMetadata;
  if (!meta) return;
  const consentBox = document.querySelector('.sb-consent-box');
  if (!consentBox) return;

  const ul = consentBox.querySelector('ul');
  if (!ul) return;

  const ipLineText = meta.data_handling_terms === 'organisational'
    ? 'By contributing, you assign copyright in contributed pages to the organisation per your employment agreement.'
    : 'You retain copyright in your original content. The cohort owns the synthesised collective output.';

  // Find or create the IP-mode bullet — second one in the list
  const items = ul.querySelectorAll('li');
  if (items[1]) items[1].textContent = ipLineText;
}

bindSharedBrainOptin();
bindSharedBrainCtas();
bindSharedBrainWizardChrome();
bindSharedBrainWizardStep1();
bindSharedBrainWizardStep2();
bindSharedBrainWizardStep3();
bindSharedBrainWizardStep4();
bindSharedBrainWizardStep5();
bindSharedBrainAdminStep1();
bindSharedBrainAdminStep2();

// ── Configured panel ──────────────────────────────────────────────────────────
function renderSyncConfigured(status) {
  hideEl(syncUnconfigured);
  showEl(syncConfigured);

  const repoUrl = status.repoUrl || '';
  const link = document.getElementById('sync-repo-link');
  link.textContent = repoUrl;
  link.href = repoUrl.startsWith('http') ? repoUrl : `https://${repoUrl}`;

  const lastSyncEl = document.getElementById('sync-last-sync-label');
  if (status.lastSync) {
    const d = new Date(status.lastSync);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    lastSyncEl.textContent = `Last synced: ${isToday ? 'Today at ' + timeStr : d.toLocaleDateString()}`;
  } else {
    lastSyncEl.textContent = 'Last synced: never';
  }

  const changesEl = document.getElementById('sync-changes-label');
  if (status.changesCount > 0) {
    changesEl.textContent = `${status.changesCount} local change${status.changesCount !== 1 ? 's' : ''} not yet pushed`;
  } else {
    changesEl.textContent = '';
  }

  // Keep the navbar badge in sync — every sync operation (push, pull, sync)
  // already calls renderSyncConfigured after success, so this single line
  // covers all those code paths without each one needing its own update.
  applySyncPendingBadge(status);
}

// ── Push only ─────────────────────────────────────────────────────────────────
document.getElementById('sync-push-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('sync-push-btn');
  const statusEl = document.getElementById('sync-op-status');
  btn.disabled = true;
  showStatus(statusEl, 'loading', 'Pushing your local changes to GitHub…');

  try {
    const res = await fetch('/api/sync/push', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    if (data.pushed) {
      const n = data.filesChanged ?? data.changesCount ?? 0;
      const commits = data.commitsAhead ? ` across ${data.commitsAhead} commit${data.commitsAhead !== 1 ? 's' : ''}` : '';
      showStatus(statusEl, 'success',
        `✓ Pushed ${n} file${n !== 1 ? 's' : ''} to GitHub${commits}.`);
    } else {
      showStatus(statusEl, 'success', `✓ ${data.message}`);
    }
    // Refresh status + domain stats
    const s = await fetch('/api/sync/status').then(r => r.json());
    renderSyncConfigured(s);
    loadDomainList().catch(() => {});
  } catch (err) {
    showStatus(statusEl, 'error', err.message);
  } finally {
    btn.disabled = false;
  }
});

// ── Pull only ─────────────────────────────────────────────────────────────────
document.getElementById('sync-pull-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('sync-pull-btn');
  const statusEl = document.getElementById('sync-op-status');
  btn.disabled = true;
  showStatus(statusEl, 'loading', 'Pulling latest changes from GitHub…');

  try {
    const res = await fetch('/api/sync/pull', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const n = data.filesChanged ?? 0;
    const pruned = data.pruned?.length
      ? `, removed ${data.pruned.length} deleted domain${data.pruned.length !== 1 ? 's' : ''} (${data.pruned.join(', ')})`
      : '';
    const msg = n > 0
      ? `✓ Pulled ${n} file${n !== 1 ? 's' : ''} from GitHub${pruned}.`
      : `✓ Already up to date${pruned}.`;
    showStatus(statusEl, 'success', msg);
    const s = await fetch('/api/sync/status').then(r => r.json());
    renderSyncConfigured(s);
    // Refresh domain stats + dropdowns (sync may have added/removed pages or domains)
    Promise.all([loadDomains(), loadChatDomains(), loadDomainList()]).catch(() => {});
  } catch (err) {
    showStatus(statusEl, 'error', err.message);
  } finally {
    btn.disabled = false;
  }
});

// ── Sync now (bidirectional) ──────────────────────────────────────────────────
document.getElementById('sync-both-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('sync-both-btn');
  const statusEl = document.getElementById('sync-op-status');
  btn.disabled = true;
  showStatus(statusEl, 'loading', 'Syncing — pulling remote changes, then pushing local…');

  try {
    const res = await fetch('/api/sync/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const parts = [];
    const pulled = data.pullResult?.filesChanged ?? 0;
    const pushed = data.pushResult?.filesChanged ?? 0;
    if (pulled > 0) {
      parts.push(`Pulled ${pulled} file${pulled !== 1 ? 's' : ''} from GitHub`);
    }
    if (data.pushResult?.pushed && pushed > 0) {
      parts.push(`pushed ${pushed} file${pushed !== 1 ? 's' : ''} to GitHub`);
    }
    if (data.pullResult?.pruned?.length) {
      const p = data.pullResult.pruned;
      parts.push(`removed ${p.length} deleted domain${p.length !== 1 ? 's' : ''} (${p.join(', ')})`);
    }
    const summary = parts.length
      ? `✓ Sync complete — ${parts.join(', ')}.`
      : '✓ Sync complete — everything was already up to date.';
    showStatus(statusEl, 'success', summary);
    const s = await fetch('/api/sync/status').then(r => r.json());
    renderSyncConfigured(s);
    // Refresh domain stats + dropdowns (sync may have added/removed pages or domains)
    Promise.all([loadDomains(), loadChatDomains(), loadDomainList()]).catch(() => {});
  } catch (err) {
    showStatus(statusEl, 'error', err.message);
  } finally {
    btn.disabled = false;
  }
});

// ── Disconnect ────────────────────────────────────────────────────────────────
document.getElementById('sync-disconnect-btn')?.addEventListener('click', async () => {
  if (!confirm('Disconnect sync from this computer? Your GitHub repository will not be affected.')) return;
  try {
    await fetch('/api/sync/disconnect', { method: 'DELETE' });
    hideEl(syncConfigured);
    showEl(syncUnconfigured);
    showSyncLanding();
    syncTabInitialised = false; // allow re-init next time
  } catch (err) {
    alert('Failed to disconnect: ' + err.message);
  }
});

// ── Wizard helpers ────────────────────────────────────────────────────────────
function showSyncLanding() {
  showEl(syncLanding);
  hideEl(syncWizard);
}

function showWizardStep(stepEl) {
  [syncStep1, syncStep2, syncStep3, syncProcessing, syncError, syncSuccess].forEach(el => {
    el.classList.add('hidden');
  });
  stepEl.classList.remove('hidden');
}

function setProgressStep(n) {
  document.querySelectorAll('.sync-progress-step').forEach(el => {
    const s = parseInt(el.dataset.step);
    el.classList.toggle('active', s === n);
    el.classList.toggle('done', s < n);
  });
}

// ── Wizard: open ─────────────────────────────────────────────────────────────
document.getElementById('open-wizard-btn')?.addEventListener('click', () => {
  hideEl(syncLanding);
  showEl(syncWizard);
  showWizardStep(syncStep1);
  setProgressStep(1);
  syncRepoUrlInput.value = wizardRepoUrl;
  syncTokenInput.value   = wizardToken;
});

// ── Wizard: Step 1 → Step 2 ───────────────────────────────────────────────────
document.getElementById('wizard-next-1')?.addEventListener('click', () => {
  const url = syncRepoUrlInput.value.trim();
  if (!url || !url.includes('github.com')) {
    syncRepoUrlInput.focus();
    syncRepoUrlInput.style.borderColor = 'var(--error)';
    setTimeout(() => syncRepoUrlInput.style.borderColor = '', 1500);
    return;
  }
  wizardRepoUrl = url;
  showWizardStep(syncStep2);
  setProgressStep(2);
});

document.getElementById('wizard-back-1')?.addEventListener('click', () => {
  showSyncLanding();
});

// ── Wizard: Token show/hide ───────────────────────────────────────────────────
document.getElementById('sync-token-toggle')?.addEventListener('click', () => {
  const input = syncTokenInput;
  const btn   = document.getElementById('sync-token-toggle');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
});

// ── Wizard: Step 2 → Step 3 ───────────────────────────────────────────────────
document.getElementById('wizard-next-2')?.addEventListener('click', () => {
  const tok = syncTokenInput.value.trim();
  if (!tok || tok.length < 10) {
    syncTokenInput.focus();
    syncTokenInput.style.borderColor = 'var(--error)';
    setTimeout(() => syncTokenInput.style.borderColor = '', 1500);
    return;
  }
  wizardToken = tok;
  showWizardStep(syncStep3);
  setProgressStep(3);
});

document.getElementById('wizard-back-2')?.addEventListener('click', () => {
  showWizardStep(syncStep1);
  setProgressStep(1);
});

document.getElementById('wizard-back-3')?.addEventListener('click', () => {
  showWizardStep(syncStep2);
  setProgressStep(2);
});

// ── Wizard: Mode cards → submit ───────────────────────────────────────────────
document.querySelectorAll('.sync-mode-card').forEach(card => {
  card.addEventListener('click', () => submitSyncSetup(card.dataset.mode));
});

async function submitSyncSetup(mode) {
  wizardLastMode = mode;
  showWizardStep(syncProcessing);

  const msgEl = document.getElementById('sync-proc-msg');
  msgEl.textContent = mode === 'push'
    ? 'Connecting to GitHub and pushing your knowledge…'
    : 'Connecting to GitHub and pulling your knowledge…';

  try {
    const res = await fetch('/api/sync/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl: wizardRepoUrl, token: wizardToken, mode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Setup failed');

    // Show success
    document.getElementById('sync-success-repo').textContent = data.repoUrl || wizardRepoUrl;
    showWizardStep(syncSuccess);

    // Auto-transition to configured panel after 4 seconds
    setTimeout(async () => {
      const s = await fetch('/api/sync/status').then(r => r.json());
      hideEl(syncUnconfigured);
      renderSyncConfigured(s);
    }, 4000);

  } catch (err) {
    // A network-level failure (server crashed or stopped mid-setup) surfaces as
    // "Failed to fetch" / "Load failed" / "NetworkError" — unhelpful on its own.
    // Translate it into an actionable message.
    const raw = String(err && err.message || '');
    const isNetworkDown = /failed to fetch|load failed|networkerror|connection/i.test(raw);
    document.getElementById('sync-error-msg').textContent = isNetworkDown
      ? 'The Curator server stopped responding during setup. This usually means the server process closed or restarted. '
        + 'Make sure The Curator is still running, reload this page, and try again. '
        + 'On Windows, also check that no GitHub sign-in popup is waiting for you — see docs/sync.md → Troubleshooting.'
      : raw || 'Setup failed';
    showWizardStep(syncError);
  }
}

// ── Error recovery ────────────────────────────────────────────────────────────
document.getElementById('sync-try-again')?.addEventListener('click', () => {
  showWizardStep(syncStep1);
  setProgressStep(1);
});

document.getElementById('sync-retry-same')?.addEventListener('click', () => {
  submitSyncSetup(wizardLastMode);
});

// ── WIKI TAB ──────────────────────────────────────────────────────────────────
const wikiLoadBtn = document.getElementById('wiki-load-btn');
const wikiBrowser = document.getElementById('wiki-browser');
const wikiSidebar = document.getElementById('wiki-sidebar');
const wikiContent = document.getElementById('wiki-content');
const wikiEmpty = document.getElementById('wiki-empty');

wikiLoadBtn?.addEventListener('click', loadWiki);

async function loadWiki() {
  const domain = document.getElementById('wiki-domain').value;
  wikiLoadBtn.disabled = true;
  hideEl(wikiBrowser);
  hideEl(wikiEmpty);

  try {
    const res = await fetch(`/api/wiki/${domain}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    if (data.pages.length === 0) {
      showEl(wikiEmpty);
    } else {
      renderWikiSidebar(data.pages);
      showEl(wikiBrowser);
    }
  } catch (err) {
    alert(err.message);
  } finally {
    wikiLoadBtn.disabled = false;
  }
}

function renderWikiSidebar(pages) {
  // Group by folder
  const groups = {};
  for (const page of pages) {
    const parts = page.path.split('/');
    const group = parts.length > 1 ? parts[0] : 'root';
    if (!groups[group]) groups[group] = [];
    groups[group].push(page);
  }

  wikiSidebar.innerHTML = Object.entries(groups).map(([group, items]) => `
    <div class="wiki-group-label">${group}</div>
    ${items.map((p, i) => {
      const name = p.path.split('/').pop().replace('.md', '');
      return `<div class="wiki-page-link" data-path="${escHtml(p.path)}">${escHtml(name)}</div>`;
    }).join('')}
  `).join('');

  wikiSidebar.querySelectorAll('.wiki-page-link').forEach(link => {
    link.addEventListener('click', () => {
      wikiSidebar.querySelectorAll('.wiki-page-link').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
      const page = pages.find(p => p.path === link.dataset.path);
      if (page) renderMarkdown(page.content);
    });
  });

  // Auto-select first
  const first = wikiSidebar.querySelector('.wiki-page-link');
  if (first) first.click();
}

function renderMarkdown(md) {
  // Lightweight markdown renderer (no external deps)
  let html = escHtml(md)
    // headings
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // bold/italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // wiki links
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="citation-tag">$1</span>')
    // bullet lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // horizontal rule
    .replace(/^---$/gm, '<hr style="border-color:var(--border);margin:14px 0"/>')
    // table rows (basic)
    .replace(/^\|(.+)\|$/gm, (_, row) => {
      const cells = row.split('|').map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    })
    // paragraphs
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hltup])(.+)$/gm, '$1');

  // Wrap orphan li tags
  html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');

  wikiContent.innerHTML = `<p>${html}</p>`;
}

// ── Custom Select ─────────────────────────────────────────────────────────────
class CustomSelect {
  constructor(nativeSelect) {
    this.native  = nativeSelect;
    this.wrap    = null;
    this.btn     = null;
    this.dropdown = null;
    this.isOpen  = false;
    this._build();
    this._observe();
  }

  _build() {
    this.native.classList.add('cs-native');

    this.wrap = document.createElement('div');
    this.wrap.className = 'cs-wrap';
    // Inherit classes that affect sizing (e.g. chat-domain-select)
    if (this.native.classList.contains('chat-domain-select')) {
      this.wrap.classList.add('chat-domain-select-wrap');
    }
    this.native.parentNode.insertBefore(this.wrap, this.native);
    this.wrap.appendChild(this.native);

    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.className = 'cs-btn';
    this.wrap.insertBefore(this.btn, this.native);

    this.dropdown = document.createElement('div');
    this.dropdown.className = 'cs-dropdown';
    this.wrap.appendChild(this.dropdown);

    this.btn.addEventListener('click', e => {
      e.stopPropagation();
      if (this.native.disabled) return; // mirror a real <select disabled>
      this.toggle();
    });
    document.addEventListener('click', () => this.close());

    this.refresh();
  }

  refresh() {
    const opts    = Array.from(this.native.options);
    const selOpt  = opts[this.native.selectedIndex] || opts[0];

    // Keep the VISIBLE control in lockstep with the native element's
    // disabled state. The native <select> is `display: none` (styles.css
    // `select.cs-native`) — this button is the only thing the user can
    // actually see or click, so a caller setting `nativeSelect.disabled =
    // true` (e.g. renderQueuePanel locking the domain picker mid-batch)
    // was previously a complete no-op: the button stayed fully clickable
    // and openable. M4 fix.
    this.btn.disabled = this.native.disabled;
    this.btn.setAttribute('aria-disabled', this.native.disabled ? 'true' : 'false');
    if (this.native.disabled) this.close();

    this.btn.innerHTML = `
      <span class="cs-value">${selOpt ? escHtml(selOpt.text) : '—'}</span>
      <svg class="cs-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
           stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

    this.dropdown.innerHTML = opts.map((opt, i) => `
      <div class="cs-option${opt.selected ? ' selected' : ''}" data-index="${i}">
        ${opt.selected
          ? `<svg class="cs-check" width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
               stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
          : '<span class="cs-check-placeholder"></span>'}
        ${escHtml(opt.text)}
      </div>`).join('');

    this.dropdown.querySelectorAll('.cs-option').forEach(optEl => {
      optEl.addEventListener('click', e => {
        e.stopPropagation();
        this.native.selectedIndex = parseInt(optEl.dataset.index);
        this.native.dispatchEvent(new Event('change', { bubbles: true }));
        this.refresh();
        this.close();
      });
    });
  }

  toggle() { if (this.native.disabled) return; this.isOpen ? this.close() : this.open(); }

  open() {
    if (this.native.disabled) return; // defense in depth alongside the click guard + disabled btn
    document.querySelectorAll('.cs-wrap.open').forEach(w => {
      if (w !== this.wrap) w.classList.remove('open');
    });
    this.wrap.classList.add('open');
    this.isOpen = true;
  }

  close() {
    this.wrap.classList.remove('open');
    this.isOpen = false;
  }

  _observe() {
    // attributes+attributeFilter:['disabled'] is what makes the M4 fix
    // actually fire: `nativeSelect.disabled = true/false` is a reflected
    // IDL property (per the HTML spec it sets/removes the `disabled`
    // content attribute), so this observer sees every caller's disable/
    // enable toggle — including ones that predate this fix and set the
    // property with no knowledge that CustomSelect exists — without any
    // call site needing to know to notify us.
    new MutationObserver(() => this.refresh())
      .observe(this.native, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// v3.1.0 (Track 1.2 frontend hardening): these three are called from dozens
// of sites throughout the file, many with an element looked up moments
// earlier. Null-safe here means one missing element degrades that one status
// message/toggle instead of throwing inside whatever handler called it.
function showEl(el) { if (!el) { console.error('showEl: target element is missing'); return; } el.classList.remove('hidden'); }
function hideEl(el) { if (!el) { console.error('hideEl: target element is missing'); return; } el.classList.add('hidden'); }

function showStatus(el, type, msg) {
  if (!el) { console.error('showStatus: target element is missing'); return; }
  el.className = `status ${type}`;
  el.innerHTML = type === 'loading'
    ? `<span class="spinner"></span><span>${escHtml(msg)}</span>`
    : escHtml(msg);
  showEl(el);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
// Upgrade all <select> elements to custom dropdowns before loading data
document.querySelectorAll('select').forEach(sel => new CustomSelect(sel));

loadDomains();
loadChatDomains();
// Batch ingest queue (Track 3): non-critical background check for a batch
// left running/paused from a previous session, regardless of which tab is
// active on load (mirrors the version-badge fetch at the top of this file).
checkActiveQueueJob().catch(() => {});

// ── DOMAINS TAB ───────────────────────────────────────────────────────────────

// ── Knowledge Base Path panel ─────────────────────────────────────────────────

async function initKbPathPanel() {
  const pathValue    = document.getElementById('kb-path-value');
  const editBtn      = document.getElementById('kb-path-edit-btn');
  const chooseBtn    = document.getElementById('kb-path-choose-btn');
  const firstRunBtn  = document.getElementById('first-run-choose-btn');
  const editRow      = document.getElementById('kb-path-edit-row');
  const pathInput    = document.getElementById('kb-path-input');
  const saveBtn      = document.getElementById('kb-path-save-btn');
  const cancelBtn    = document.getElementById('kb-path-cancel-btn');
  const copyBtn      = document.getElementById('kb-path-copy-btn');
  const statusEl     = document.getElementById('kb-path-status');
  const displayEl    = document.getElementById('kb-path-display');
  const firstRunEl   = document.getElementById('first-run-guide');

  // ── Load current path ──────────────────────────────────────────────────────
  let currentPath = '';
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    currentPath = cfg.domainsPath;
    pathValue.textContent = currentPath;
    pathInput.value = currentPath;
  } catch {
    pathValue.textContent = '(could not load)';
  }

  // ── Show first-run guide if no domains exist ───────────────────────────────
  try {
    const { domains } = await fetch('/api/domains').then(r => r.json());
    if (firstRunEl && domains.length === 0) {
      firstRunEl.classList.remove('hidden');
    }
  } catch { /* ignore */ }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function showStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = 'kb-path-status ' + type;
    statusEl.classList.remove('hidden');
    if (type === 'success') setTimeout(() => statusEl.classList.add('hidden'), 4000);
  }

  function applyPath(newPath) {
    currentPath = newPath;
    pathValue.textContent = newPath;
    pathInput.value = newPath;
    editRow.classList.add('hidden');
    displayEl.classList.remove('hidden');
    if (firstRunEl) firstRunEl.classList.add('hidden');
    showStatus('✓ Knowledge base folder updated', 'success');
    domainsTabInitialised = false;
    loadDomainList();
  }

  // ── Native folder picker (osascript via server) ────────────────────────────
  async function openFolderPicker() {
    const btn = event.currentTarget;
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Selecting…';
    try {
      const res = await fetch('/api/config/pick-folder', { method: 'POST' });
      const data = await res.json();
      if (data.cancelled) return;
      if (!res.ok) throw new Error(data.error || 'Picker failed');
      applyPath(data.path);
    } catch (err) {
      showStatus('✗ ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  if (chooseBtn)   chooseBtn.addEventListener('click',   openFolderPicker);
  if (firstRunBtn) firstRunBtn.addEventListener('click', openFolderPicker);

  // ── Manual edit flow ───────────────────────────────────────────────────────
  if (editBtn) editBtn.addEventListener('click', () => {
    editRow.classList.remove('hidden');
    displayEl.classList.add('hidden');
    pathInput.focus();
    pathInput.select();
  });

  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    editRow.classList.add('hidden');
    displayEl.classList.remove('hidden');
    statusEl.classList.add('hidden');
    pathInput.value = currentPath;
  });

  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const newPath = pathInput.value.trim();
    if (!newPath) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Applying…';
    try {
      const res = await fetch('/api/config/domains-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      applyPath(data.domainsPath || newPath);
    } catch (err) {
      showStatus('✗ ' + err.message, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Apply';
    }
  });

  // ── Copy path ──────────────────────────────────────────────────────────────
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pathValue.textContent);
      const orig = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => copyBtn.textContent = orig, 1500);
    } catch { copyBtn.textContent = 'Copy failed'; }
  });

  // ── Keyboard shortcuts in the input ───────────────────────────────────────
  if (pathInput) pathInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  saveBtn.click();
    if (e.key === 'Escape') cancelBtn.click();
  });
}

let domainsTabInitialised = false;

document.querySelector('[data-tab="domains"]')?.addEventListener('click', () => {
  if (!domainsTabInitialised) {
    domainsTabInitialised = true;
    initKbPathPanel();
  }
  // loadDomainList() is now called by the tab-switch handler
});

// Domains is the first tab — initialize immediately
initKbPathPanel();
loadDomainList();
domainsTabInitialised = true;

async function loadDomainList() {
  const listEl = document.getElementById('domain-list');
  listEl.innerHTML = '<div class="domain-loading"><span class="spinner"></span> Loading…</div>';
  try {
    const res = await fetch('/api/domains');
    const { domains } = await res.json();

    if (domains.length === 0) {
      listEl.innerHTML = '<div class="domain-empty">No domains yet. Create one above.</div>';
      return;
    }

    const statsResults = await Promise.allSettled(
      domains.map(d => fetch(`/api/domains/${encodeURIComponent(d)}/stats`).then(r => r.json()))
    );

    listEl.innerHTML = '';
    domains.forEach((slug, i) => {
      const stats = statsResults[i].status === 'fulfilled'
        ? statsResults[i].value
        : { slug, displayName: formatDomain(slug), pageCount: '?', conversationCount: '?', lastIngestDate: null };
      listEl.appendChild(buildDomainCard(stats));
    });
  } catch (err) {
    listEl.innerHTML = `<div class="status error">${escHtml(err.message)}</div>`;
  }
}

function buildDomainCard(stats) {
  const card = document.createElement('div');
  card.className = 'domain-card';
  card.dataset.slug = stats.slug;

  const lastIngest = stats.lastIngestDate
    ? `Last ingest: ${stats.lastIngestDate}`
    : 'No ingests yet';

  const firstLetter = (stats.displayName || stats.slug)[0].toUpperCase();

  card.innerHTML = `
    <div class="domain-card-icon">${escHtml(firstLetter)}</div>
    <div class="domain-card-body">
      <div class="domain-card-name">${escHtml(stats.displayName)}</div>
      <div class="domain-card-slug">domains/${escHtml(stats.slug)}/</div>
      <div class="domain-card-stats">
        <span>${stats.pageCount} wiki pages</span>
        <span class="domain-stat-dot">·</span>
        <span>${stats.conversationCount} conversations</span>
        <span class="domain-stat-dot">·</span>
        <span>${escHtml(lastIngest)}</span>
      </div>
    </div>
    <div class="domain-card-actions">
      <button class="btn domain-rename-btn" title="Rename">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="btn domain-delete-btn" title="Delete">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>
    </div>
    <div class="domain-card-panel hidden"></div>
  `;

  card.querySelector('.domain-rename-btn').addEventListener('click', () => showRenamePanel(card, stats));
  card.querySelector('.domain-delete-btn').addEventListener('click', () => showDeletePanel(card, stats));

  return card;
}

function showRenamePanel(cardEl, stats) {
  // Close any other open panels first
  document.querySelectorAll('.domain-card-panel').forEach(p => {
    if (p !== cardEl.querySelector('.domain-card-panel')) {
      p.classList.add('hidden');
      p.innerHTML = '';
    }
  });

  const panel = cardEl.querySelector('.domain-card-panel');
  panel.innerHTML = `
    <div class="domain-inline-form">
      <label class="domain-inline-label">New display name</label>
      <input type="text" class="domain-rename-input" value="${escHtml(stats.displayName)}" />
      <span class="domain-slug-preview"></span>
      <div class="domain-inline-actions">
        <button class="btn domain-rename-cancel" type="button">Cancel</button>
        <button class="btn primary domain-rename-submit pill" type="button">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px"><polyline points="20 6 9 17 4 12"/></svg>
          Rename
        </button>
      </div>
      <div class="domain-inline-status status hidden"></div>
    </div>
  `;
  panel.classList.remove('hidden');

  const input = panel.querySelector('.domain-rename-input');
  const preview = panel.querySelector('.domain-slug-preview');
  input.select();
  input.focus();

  input.addEventListener('input', () => {
    const slug = clientGenerateSlug(input.value);
    preview.textContent = slug ? `New folder: domains/${slug}/` : '';
  });

  panel.querySelector('.domain-rename-cancel').addEventListener('click', () => {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  });

  panel.querySelector('.domain-rename-submit').addEventListener('click', async () => {
    const newName = input.value.trim();
    if (!newName) return;
    const submitBtn = panel.querySelector('.domain-rename-submit');
    const statusEl = panel.querySelector('.domain-inline-status');
    submitBtn.disabled = true;
    showStatus(statusEl, 'loading', 'Renaming…');

    try {
      const res = await fetch(`/api/domains/${encodeURIComponent(stats.slug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: newName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      await Promise.all([loadDomains(), loadChatDomains(), loadDomainList()]);

      if (data.syncWarning) {
        // Brief advisory before the card refreshes away
        showStatus(statusEl, 'success', `✓ Renamed to "${newName}". Since sync is configured, run Sync now soon to reflect this on GitHub.`);
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      showStatus(statusEl, 'error', err.message);
      submitBtn.disabled = false;
    }
  });
}

function showDeletePanel(cardEl, stats) {
  // Close any other open panels
  document.querySelectorAll('.domain-card-panel').forEach(p => {
    if (p !== cardEl.querySelector('.domain-card-panel')) {
      p.classList.add('hidden');
      p.innerHTML = '';
    }
  });

  const panel = cardEl.querySelector('.domain-card-panel');
  panel.innerHTML = `
    <div class="domain-delete-warning">
      <div class="domain-delete-icon">⚠️</div>
      <div class="domain-delete-body">
        <strong class="domain-delete-title">Delete "${escHtml(stats.displayName)}"?</strong>
        <div class="domain-delete-counts">
          This will permanently delete <strong>${stats.pageCount} wiki pages</strong>,
          <strong>${stats.conversationCount} conversations</strong>, and all source files for this domain.
          This cannot be undone.
        </div>
        <div class="domain-delete-sync-note hidden"></div>
        <div class="domain-inline-actions">
          <button class="btn domain-delete-cancel" type="button">Cancel</button>
          <button class="btn domain-delete-confirm" type="button">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            Yes, delete permanently
          </button>
        </div>
        <div class="domain-delete-status status hidden"></div>
      </div>
    </div>
  `;
  panel.classList.remove('hidden');

  // Async sync check
  fetch('/api/sync/status').then(r => r.json()).then(s => {
    if (s.configured) {
      const noteEl = panel.querySelector('.domain-delete-sync-note');
      noteEl.textContent = 'This domain will also be removed from GitHub on the next sync.';
      noteEl.classList.remove('hidden');
    }
  }).catch(() => {});

  panel.querySelector('.domain-delete-cancel').addEventListener('click', () => {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  });

  panel.querySelector('.domain-delete-confirm').addEventListener('click', async () => {
    const confirmBtn = panel.querySelector('.domain-delete-confirm');
    const statusEl = panel.querySelector('.domain-delete-status');
    confirmBtn.disabled = true;
    showStatus(statusEl, 'loading', 'Deleting…');

    try {
      const res = await fetch(`/api/domains/${encodeURIComponent(stats.slug)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Fade out the card
      cardEl.style.transition = 'opacity 0.3s, transform 0.3s';
      cardEl.style.opacity = '0';
      cardEl.style.transform = 'translateX(-8px)';
      setTimeout(() => cardEl.remove(), 300);

      await Promise.all([loadDomains(), loadChatDomains()]);
      // Bump the navbar pending-sync badge — the deletion is now an
      // uncommitted change that needs to be pushed (v3.0.1-beta.5).
      refreshSyncPendingBadge();
    } catch (err) {
      showStatus(statusEl, 'error', err.message);
      confirmBtn.disabled = false;
    }
  });
}

function clientGenerateSlug(name) {
  if (!name) return '';
  let slug = name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, '-and-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (slug.length > 32) {
    slug = slug.slice(0, 32);
    const lastDash = slug.lastIndexOf('-');
    if (lastDash > 0) slug = slug.slice(0, lastDash);
  }
  return slug;
}

// ── New Domain Form ───────────────────────────────────────────────────────────

const newDomainBtn   = document.getElementById('new-domain-btn');
const newDomainForm  = document.getElementById('new-domain-form');
const ndDisplayName  = document.getElementById('nd-display-name');
const ndDescription  = document.getElementById('nd-description');
const ndSlugPreview  = document.querySelector('.nd-slug-preview');
const ndStatus       = document.getElementById('nd-status');
const ndCreateBtn    = document.getElementById('nd-create-btn');
const templateGrid   = document.getElementById('template-grid');
let selectedTemplate = 'tech';

newDomainBtn?.addEventListener('click', () => {
  showEl(newDomainForm);
  ndDisplayName.value = '';
  ndDescription.value = '';
  ndSlugPreview.textContent = '';
  hideEl(ndStatus);
  // Reset template selection
  templateGrid.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
  templateGrid.querySelector('[data-template="tech"]').classList.add('selected');
  selectedTemplate = 'tech';
  ndDisplayName.focus();
  newDomainForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.getElementById('nd-cancel-btn')?.addEventListener('click', () => {
  hideEl(newDomainForm);
});

ndDisplayName?.addEventListener('input', () => {
  const slug = clientGenerateSlug(ndDisplayName.value);
  ndSlugPreview.textContent = slug ? `Folder: domains/${slug}/` : '';
});

templateGrid?.querySelectorAll('.template-card').forEach(card => {
  card.addEventListener('click', () => {
    templateGrid.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedTemplate = card.dataset.template;
  });
});

ndCreateBtn?.addEventListener('click', async () => {
  const displayName = ndDisplayName.value.trim();
  if (!displayName) {
    ndDisplayName.focus();
    ndDisplayName.style.borderColor = 'var(--error)';
    setTimeout(() => ndDisplayName.style.borderColor = '', 1500);
    return;
  }

  ndCreateBtn.disabled = true;
  showStatus(ndStatus, 'loading', 'Creating domain…');

  try {
    const res = await fetch('/api/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName,
        description: ndDescription.value.trim(),
        template: selectedTemplate,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    hideEl(newDomainForm);
    await Promise.all([loadDomains(), loadChatDomains(), loadDomainList()]);
    showStatus(ndStatus, 'success', `✓ Domain "${data.displayName}" created at domains/${data.slug}/`);
    showEl(ndStatus);
  } catch (err) {
    showStatus(ndStatus, 'error', err.message);
  } finally {
    ndCreateBtn.disabled = false;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS TAB
// ══════════════════════════════════════════════════════════════════════════════

let settingsInitialised = false;

document.querySelector('[data-tab="settings"]')?.addEventListener('click', () => {
  if (!settingsInitialised) {
    settingsInitialised = true;
    initSettings();
  } else {
    // Already initialised — still refresh the MCP section so stale UI state
    // (e.g. from closing the wizard) gets reconciled with current server status.
    refreshMcpSection();
    refreshSharedBrainSettings();
  }
});

async function initSettings() {
  // Load API keys
  await loadApiKeyStatus();
  // Load version
  try {
    const r = await fetch('/api/version');
    const { version } = await r.json();
    document.getElementById('settings-version').textContent = `v${version}`;
  } catch {}
  // Load My Curator MCP status + snippet
  await refreshMcpSection();
  // Load AI Health limits
  await loadAiHealthSettings();
  // Load default-domain dropdown (v2.5.2+)
  await loadDefaultDomain();
  // Shared Brain (beta) opt-in state (v3.0.2)
  await refreshSharedBrainSettings();
}

async function loadDefaultDomain() {
  const sel = document.getElementById('settings-default-domain');
  const status = document.getElementById('settings-default-domain-status');
  if (!sel) return;
  try {
    const r = await fetch('/api/config/default-domain');
    if (!r.ok) return;
    const { defaultDomain, domains } = await r.json();
    // Reset and populate the dropdown
    sel.innerHTML =
      '<option value="">— none (always require explicit domain) —</option>' +
      (domains || []).map(d => `<option value="${escapeAttr(d)}">${escapeHtml(d)}</option>`).join('');
    sel.value = defaultDomain || '';
  } catch {
    if (status) {
      status.textContent = 'Could not load domains.';
      status.className = 'status-inline error';
      status.classList.remove('hidden');
    }
  }
}

document.getElementById('settings-default-domain')?.addEventListener('change', async (e) => {
  const sel = e.target;
  const status = document.getElementById('settings-default-domain-status');
  const value = sel.value || '';
  try {
    const r = await fetch('/api/config/default-domain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultDomain: value }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Save failed');
    if (status) {
      status.textContent = value ? `Saved — '${value}' is the default.` : 'Saved — no default set.';
      status.className = 'status-inline ok';
      status.classList.remove('hidden');
      setTimeout(() => status.classList.add('hidden'), 2200);
    }
  } catch (err) {
    if (status) {
      status.textContent = err.message;
      status.className = 'status-inline error';
      status.classList.remove('hidden');
    }
  }
});

async function loadAiHealthSettings() {
  const ceilingEl = document.getElementById('ai-cost-ceiling');
  const pairsEl   = document.getElementById('ai-max-pairs');
  if (!ceilingEl || !pairsEl) return;
  try {
    const r = await fetch('/api/health/ai-settings');
    if (!r.ok) return;
    const data = await r.json();
    ceilingEl.value = data.costCeilingTokens ?? 50000;
    pairsEl.value   = data.semanticDupeMaxPairs ?? 500;
  } catch {}
}

document.getElementById('ai-health-save')?.addEventListener('click', async () => {
  const ceilingEl = document.getElementById('ai-cost-ceiling');
  const pairsEl   = document.getElementById('ai-max-pairs');
  const statusEl  = document.getElementById('ai-health-save-status');
  const ceiling = parseInt(ceilingEl.value, 10);
  const pairs   = parseInt(pairsEl.value, 10);
  if (!Number.isFinite(ceiling) || ceiling < 1000) {
    statusEl.textContent = 'Cost ceiling must be at least 1,000 tokens';
    return;
  }
  if (!Number.isFinite(pairs) || pairs < 10) {
    statusEl.textContent = 'Max pairs must be at least 10';
    return;
  }
  statusEl.textContent = 'Saving…';
  try {
    const r = await fetch('/api/health/ai-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ costCeilingTokens: ceiling, semanticDupeMaxPairs: pairs }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Save failed');
    statusEl.textContent = '✓ Saved';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SYSTEM CHECK (Settings) — free quick diagnostics + opt-in live API test
// (UI label "System Check"; element IDs keep the diag-* prefix)
// ══════════════════════════════════════════════════════════════════════════════
const DIAG_ICON = { ok: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️' };

function renderDiagChecks(checks) {
  return checks.map(c => `
    <div class="diag-row diag-${c.status}">
      <span class="diag-icon">${DIAG_ICON[c.status] || 'ℹ️'}</span>
      <div class="diag-body">
        <div class="diag-label">${escHtml(c.label)}</div>
        <div class="diag-detail">${escHtml(c.detail)}</div>
      </div>
    </div>`).join('');
}

(function wireHealthCheck() {
  const runBtn   = document.getElementById('diag-run-btn');
  const liveBtn  = document.getElementById('diag-live-btn');
  const results  = document.getElementById('diag-results');
  const confirm  = document.getElementById('diag-live-confirm');
  if (!runBtn || !results) return; // section not present

  runBtn.addEventListener('click', async () => {
    confirm?.classList.add('hidden');
    runBtn.disabled = true;
    results.classList.remove('hidden');
    results.innerHTML = '<div class="hint"><span class="spinner"></span> Running checks…</div>';
    try {
      const r = await fetch('/api/diagnostics/quick');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Health check failed');
      const s = data.summary || {};
      const tone = s.fail ? 'fail' : (s.warn ? 'warn' : 'ok');
      const headline = s.fail
        ? `${s.fail} problem${s.fail === 1 ? '' : 's'} found`
        : (s.warn ? `${s.warn} thing${s.warn === 1 ? '' : 's'} to review` : 'Everything looks good');
      results.innerHTML =
        `<div class="diag-headline diag-${tone}">${escHtml(headline)}</div>` +
        renderDiagChecks(data.checks || []);
    } catch (err) {
      results.innerHTML = `<div class="status error">${escHtml(err.message)}</div>`;
    } finally {
      runBtn.disabled = false;
    }
  });

  // The live test costs money, so it goes through an explicit confirm gate.
  liveBtn?.addEventListener('click', () => { confirm?.classList.remove('hidden'); });
  document.getElementById('diag-live-cancel')?.addEventListener('click', () => {
    confirm?.classList.add('hidden');
  });
  document.getElementById('diag-live-confirm-btn')?.addEventListener('click', async () => {
    confirm?.classList.add('hidden');
    if (liveBtn) liveBtn.disabled = true;
    results.classList.remove('hidden');
    results.innerHTML = '<div class="hint"><span class="spinner"></span> Testing AI connection…</div>';
    try {
      const r = await fetch('/api/diagnostics/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await r.json();
      if (data.ok) {
        results.innerHTML = renderDiagChecks([{
          status: 'ok',
          label: 'AI connection',
          detail: `Works — ${data.provider} · ${data.model} · responded in ${data.latencyMs} ms`
            + (data.fallback ? ` (using fallback model ${data.fallback.model})` : ''),
        }]);
      } else {
        results.innerHTML = renderDiagChecks([{
          status: 'fail',
          label: 'AI connection',
          detail: data.error || 'The provider did not respond.',
        }]);
      }
    } catch (err) {
      results.innerHTML = `<div class="status error">${escHtml(err.message)}</div>`;
    } finally {
      if (liveBtn) liveBtn.disabled = false;
    }
  });
})();

// ══════════════════════════════════════════════════════════════════════════════
// MY CURATOR (MCP) — Settings section (landing → wizard → connected)
// ══════════════════════════════════════════════════════════════════════════════

// Cached latest status so buttons can act without re-fetching
let mcpLatestStatus = null;
let mcpLatestSnippet = null;

async function refreshMcpSection() {
  const checking    = document.getElementById('mcp-checking');
  const unconfigured = document.getElementById('mcp-unconfigured');
  const configured  = document.getElementById('mcp-configured');
  if (!checking) return; // section not in DOM

  try {
    const [statusRes, snippetRes, fullRes] = await Promise.all([
      fetch('/api/mcp/config'),
      fetch('/api/mcp/claude-config'),
      fetch('/api/mcp/claude-full-config'),
    ]);
    // Detect the "stale running server" case: Express falls through to the SPA
    // catch-all when the /api/mcp route doesn't exist, so we get HTML instead of JSON.
    const looksLikeHtml = (r) => (r.headers.get('content-type') || '').includes('text/html');
    if (looksLikeHtml(statusRes) || !statusRes.ok) {
      checking.innerHTML =
        '<div style="padding:14px;border-radius:8px;background:var(--warning-dim);' +
        'border:1px solid rgba(249,226,175,0.3);color:var(--warning);font-size:13px;line-height:1.55">' +
        '<strong>Restart needed.</strong> The files for My Curator have been updated, but the ' +
        'running app is still the old version. Right-click The Curator in the Dock → <strong>Quit</strong>, ' +
        'then re-open the .app to load the MCP bridge.' +
        '</div>';
      checking.classList.remove('hidden');
      return;
    }
    const status = await statusRes.json();
    const claudeSnippet = await snippetRes.json();
    const full = await fullRes.json();

    mcpLatestStatus = status;
    mcpLatestSnippet = claudeSnippet;

    // Populate snippet + diff (used by the wizard when opened)
    const snippetStr = JSON.stringify(claudeSnippet, null, 2);
    const snippetEl = document.getElementById('mcp-snippet');
    if (snippetEl) { snippetEl.textContent = snippetStr; snippetEl.dataset.copy = snippetStr; }
    const diffAfter = document.getElementById('mcp-diff-after');
    if (diffAfter) diffAfter.textContent = JSON.stringify(full.merged, null, 2);
    const diffBefore = document.getElementById('mcp-diff-before');
    if (diffBefore) {
      if (full.was_empty) {
        diffBefore.textContent = '{}';
      } else {
        // Diff should show the user's file WITHOUT our entry
        const clone = JSON.parse(JSON.stringify(full.merged));
        if (clone.mcpServers) {
          const { [status.mcp_server_name]: _removed, ...rest } = clone.mcpServers;
          if (Object.keys(rest).length === 0) delete clone.mcpServers;
          else clone.mcpServers = rest;
        }
        diffBefore.textContent = Object.keys(clone).length === 0 ? '{}' : JSON.stringify(clone, null, 2);
      }
    }
    const configPathEl = document.getElementById('mcp-config-path');
    if (configPathEl) configPathEl.textContent = mcpHomeShorten(status.claude_config_path);
    const snippetMeta = document.getElementById('mcp-snippet-meta');
    if (snippetMeta) snippetMeta.textContent = `Points at: ${mcpHomeShorten(status.domains_dir)}`;

    // Warn on landing if domains folder missing
    const domainsWarn = document.getElementById('mcp-domains-warn');
    const startBtn = document.getElementById('mcp-open-wizard-btn');
    if (domainsWarn) domainsWarn.classList.toggle('hidden', status.domains_dir_exists);
    if (startBtn) startBtn.disabled = !status.domains_dir_exists;

    // Decide which state to show
    checking.classList.add('hidden');
    const showConfigured = status.installed && !status.stale;
    unconfigured.classList.toggle('hidden', showConfigured);
    configured.classList.toggle('hidden', !showConfigured && !status.stale);

    if (status.installed && status.stale) {
      // Treat stale as configured-with-warning so we show the reconnect card
      configured.classList.remove('hidden');
      unconfigured.classList.add('hidden');
      document.getElementById('mcp-stale-alert').classList.remove('hidden');
      document.getElementById('mcp-configured-meta').textContent = 'Claude Desktop has an entry, but it points at a different folder.';
    } else if (status.installed) {
      document.getElementById('mcp-stale-alert').classList.add('hidden');
      const domainCount = (status.domains_dir_exists ? (mcpLatestStatus._domainsCount ?? null) : null);
      document.getElementById('mcp-configured-meta').textContent =
        `Claude Desktop → ${status.mcp_server_name} → ${mcpHomeShorten(status.domains_dir)}`;
    } else {
      // Unconfigured path — ensure landing (not mid-wizard) is visible
      document.getElementById('mcp-landing')?.classList.remove('hidden');
      document.getElementById('mcp-wizard')?.classList.add('hidden');
      mcpGoToStep(1);
    }
  } catch (err) {
    checking.textContent = 'Could not load My Curator status: ' + err.message;
  }
}

function mcpHomeShorten(p) {
  if (!p) return '';
  return p.replace(/^\/Users\/[^/]+\//, '~/');
}

// ── Landing → Wizard ─────────────────────────────────────────────────────────

function openMcpWizard() {
  document.getElementById('mcp-landing')?.classList.add('hidden');
  document.getElementById('mcp-configured')?.classList.add('hidden');
  document.getElementById('mcp-unconfigured')?.classList.remove('hidden');
  document.getElementById('mcp-wizard')?.classList.remove('hidden');
  mcpGoToStep(1);
}

function closeMcpWizard() {
  // Hide the wizard and reset its internal step to 1 for next open
  const wizard = document.getElementById('mcp-wizard');
  if (wizard) wizard.classList.add('hidden');
  mcpGoToStep(1);
  // Re-read state — refreshMcpSection decides whether to show landing or connected
  refreshMcpSection();
}

function mcpGoToStep(step) {
  for (let i = 1; i <= 3; i++) {
    const panel = document.getElementById(`mcp-step-${i}`);
    if (panel) panel.classList.toggle('hidden', i !== step);
    const pip = document.querySelector(`.mcp-progress-step[data-step="${i}"]`);
    if (pip) {
      pip.classList.toggle('active', i === step);
      pip.classList.toggle('done',   i <  step);
    }
  }
}

// Make the landing button and configured-panel reconfigure button open the wizard
document.getElementById('mcp-open-wizard-btn')?.addEventListener('click', openMcpWizard);
document.getElementById('mcp-reconfigure-btn')?.addEventListener('click', async () => {
  await refreshMcpSection();   // always regenerate with the current domainsDir
  // Force unconfigured view even if installed — user wants to re-run
  document.getElementById('mcp-configured')?.classList.add('hidden');
  document.getElementById('mcp-unconfigured')?.classList.remove('hidden');
  openMcpWizard();
});

// ── Step 1: copy & continue ───────────────────────────────────────────────────
document.getElementById('mcp-wizard-next-1')?.addEventListener('click', async () => {
  const snippetEl = document.getElementById('mcp-snippet');
  const btn = document.getElementById('mcp-wizard-next-1');
  try {
    const text = snippetEl.dataset.copy || snippetEl.textContent;
    if (text) await navigator.clipboard.writeText(text);
    btn.textContent = '✓ Copied — advancing…';
    setTimeout(() => {
      mcpGoToStep(2);
      btn.textContent = 'Copy & Continue →';
    }, 450);
  } catch {
    // Clipboard not available — still advance, user can select-copy manually
    mcpGoToStep(2);
  }
});
document.getElementById('mcp-wizard-back-1')?.addEventListener('click', () => {
  // Cancel from step 1 — go back to whichever state the user came from
  closeMcpWizard();
});

document.getElementById('mcp-regenerate-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('mcp-regenerate-btn');
  btn.disabled = true;
  await refreshMcpSection();
  btn.disabled = false;
  btn.textContent = '✓ Regenerated';
  setTimeout(() => { btn.textContent = '↻ Regenerate'; }, 1500);
});

// ── Step 2: paste / reveal ────────────────────────────────────────────────────
document.getElementById('mcp-reveal-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('mcp-reveal-btn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/mcp/reveal-config', { method: 'POST' });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error);
  } catch (err) {
    alert('Could not open Finder: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('mcp-wizard-next-2')?.addEventListener('click', () => mcpGoToStep(3));
document.getElementById('mcp-wizard-back-2')?.addEventListener('click', () => mcpGoToStep(1));

// ── Step 3: restart + self-test + finish ──────────────────────────────────────
async function runSelfTestInto(btnId, resultId) {
  const btn = document.getElementById(btnId);
  const out = document.getElementById(resultId);
  if (!btn || !out) return;
  btn.disabled = true;
  out.classList.remove('hidden', 'mcp-selftest-ok', 'mcp-selftest-fail');
  out.classList.add('mcp-selftest-running');
  out.textContent = 'Running self-test…';
  try {
    const r = await fetch('/api/mcp/self-test', { method: 'POST' });
    const data = await r.json();
    out.classList.remove('mcp-selftest-running');
    if (data.ok) {
      out.classList.add('mcp-selftest-ok');
      const domainsText = data.domains && data.domains.length
        ? `${data.domains.length} domain${data.domains.length === 1 ? '' : 's'} (${data.domains.join(', ')})`
        : 'no domains yet';
      out.innerHTML = `<strong>✓ My Curator responded.</strong>
        ${data.tool_count} tools registered, ${domainsText}.
        The bridge is working — if Claude Desktop still can't see it,
        the issue is inside its config file.`;
    } else {
      out.classList.add('mcp-selftest-fail');
      out.innerHTML = `<strong>✗ Self-test failed.</strong> ${escapeHtml(data.error || 'Unknown error')}
        ${data.stderr ? `<pre class="mcp-selftest-stderr">${escapeHtml(data.stderr)}</pre>` : ''}`;
    }
  } catch (err) {
    out.classList.remove('mcp-selftest-running');
    out.classList.add('mcp-selftest-fail');
    out.textContent = 'Self-test failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}
document.getElementById('mcp-selftest-btn')?.addEventListener('click', () =>
  runSelfTestInto('mcp-selftest-btn', 'mcp-selftest-result'));
document.getElementById('mcp-configured-selftest-btn')?.addEventListener('click', () =>
  runSelfTestInto('mcp-configured-selftest-btn', 'mcp-configured-selftest-result'));

document.getElementById('mcp-wizard-back-3')?.addEventListener('click', () => mcpGoToStep(2));
document.getElementById('mcp-wizard-done-btn')?.addEventListener('click', () => closeMcpWizard());

// Expose for onboarding: lets the first-run wizard jump straight here
window.openMcpSettingsWizard = function () {
  document.querySelector('[data-tab="settings"]')?.click();
  setTimeout(() => openMcpWizard(), 300);
};

// Delegated handler for inline code-block copy buttons (works for both snippet and diff-after)
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.mcp-code-copy');
  if (!btn) return;
  const targetId = btn.dataset.copyTarget;
  const el = targetId && document.getElementById(targetId);
  if (!el) return;
  const text = el.dataset.copy || el.textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    const prev = btn.getAttribute('aria-label');
    btn.setAttribute('aria-label', 'Copied');
    setTimeout(() => { btn.classList.remove('copied'); btn.setAttribute('aria-label', prev || 'Copy'); }, 1500);
  } catch {
    alert('Clipboard copy failed — select the code manually.');
  }
});

async function loadApiKeyStatus() {
  try {
    const r = await fetch('/api/config/api-keys');
    const data = await r.json();
    const geminiInput = document.getElementById('settings-gemini-key');
    const anthropicInput = document.getElementById('settings-anthropic-key');
    if (geminiInput)   geminiInput.placeholder = data.hasGeminiKey ? data.geminiApiKey : 'AIza...';
    if (anthropicInput) anthropicInput.placeholder = data.hasAnthropicKey ? data.anthropicApiKey : 'sk-ant-...';
    // Clear actual values — only show placeholders with masked keys
    if (geminiInput) geminiInput.value = '';
    if (anthropicInput) anthropicInput.value = '';

    // Show/hide the per-field Disconnect button based on whether a key is saved
    document.querySelectorAll('.key-disconnect-btn').forEach(btn => {
      const provider = btn.dataset.provider;
      const has = provider === 'gemini' ? data.hasGeminiKey : data.hasAnthropicKey;
      btn.classList.toggle('hidden', !has);
    });

    const badge = document.getElementById('settings-provider-badge');
    const text = document.getElementById('settings-provider-text');
    if (data.activeProvider) {
      const label = data.activeProvider === 'gemini' ? 'Gemini' : 'Anthropic';
      text.textContent = `Active: ${label} — ${data.activeModel}`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    // Provider toggle — only meaningful when BOTH keys are stored. Lets the
    // user flip the active provider with one click instead of re-pasting a key.
    const toggle = document.getElementById('settings-provider-toggle');
    if (toggle) {
      const bothKeys = data.hasGeminiKey && data.hasAnthropicKey;
      toggle.classList.toggle('hidden', !bothKeys);
      if (bothKeys) {
        toggle.querySelectorAll('.provider-toggle-btn').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.provider === data.activeProvider);
        });
      }
    }

    // Surface model-lifecycle fallback when the provider has retired the
    // pinned default and we auto-recovered onto the next model in the chain.
    // Rendered as an amber callout just below the provider badge — tells the
    // user exactly which model is in use and nudges them to Check for Updates.
    renderFallbackBanner(data.fallback);

    // Keep the chat model selector in sync with the saved keys: a Disconnect /
    // Save / provider switch here must be reflected in the chat dropdown right
    // away (init is idempotent, so this is safe to call on every key refresh).
    try { initChatModelSelector(); } catch { /* ignore */ }
  } catch {}
}

function renderFallbackBanner(fallback) {
  let el = document.getElementById('settings-model-fallback');
  if (!fallback) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'settings-model-fallback';
    el.className = 'settings-fallback-banner';
    const badge = document.getElementById('settings-provider-badge');
    badge?.parentNode?.insertBefore(el, badge.nextSibling);
  }
  const providerLabel = fallback.provider === 'gemini' ? 'Gemini' : 'Anthropic';
  // `costTier` comes from getFallbackStatus(), which compares the PUBLISHED
  // prices of the configured model and the one actually being billed. Three
  // states on purpose:
  //   costlier — confirmed more expensive; say so plainly, because a silent
  //              2.5x-3.75x jump per ingest is the whole reason this exists.
  //   unknown  — we don't have a price for one of the ids. Never imply parity:
  //              the user is off the model they chose, so point them at their
  //              provider's pricing rather than saying nothing.
  //   similar  — confirmed same-or-cheaper; no cost line at all.
  // Falls back to the legacy boolean so an older payload still warns.
  const costTier = fallback.costTier || (fallback.costlier ? 'costlier' : 'similar');
  let costNote = '';
  if (costTier === 'costlier') {
    costNote =
      `<span class="settings-fallback-cost">💰 This model costs more than your usual one — ` +
      `every ingest, compile and chat is billed at the higher rate until the default is restored.</span>`;
  } else if (costTier === 'unknown') {
    costNote =
      `<span class="settings-fallback-cost settings-fallback-cost-unknown">ℹ️ Pricing for this model may ` +
      `differ from your usual one — check your provider's pricing page before a large ingest.</span>`;
  }
  el.innerHTML =
    `<strong>⚠ Using fallback model.</strong> ${providerLabel}'s <code>${escapeHtml(fallback.requestedModel)}</code> ` +
    `is unavailable; currently running on <code>${escapeHtml(fallback.usingModel)}</code>. ` +
    `Open <strong>Check for Updates</strong> above to pull the latest Curator with an updated default model.` +
    costNote;
}

// Save API keys
document.getElementById('settings-save-keys')?.addEventListener('click', async () => {
  const btn = document.getElementById('settings-save-keys');
  const status = document.getElementById('settings-keys-status');
  const gemini = document.getElementById('settings-gemini-key').value.trim();
  const anthropic = document.getElementById('settings-anthropic-key').value.trim();

  if (!gemini && !anthropic) {
    showStatus(status, 'error', 'Enter at least one API key.');
    return;
  }

  btn.disabled = true;
  try {
    const body = {};
    if (gemini)    body.geminiApiKey    = gemini;
    if (anthropic) body.anthropicApiKey = anthropic;

    const r = await fetch('/api/config/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);

    showStatus(status, 'success', '✓ API keys saved.');
    await loadApiKeyStatus();
  } catch (err) {
    showStatus(status, 'error', err.message);
  } finally {
    btn.disabled = false;
  }
});

// Per-field Disconnect — clears the stored key for one provider without
// requiring the user to re-enter a different key first. If the cleared
// provider was active, active switches to the other provider (if it has
// a key), or to none.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.key-disconnect-btn');
  if (!btn) return;
  const provider = btn.dataset.provider;
  const label = provider === 'gemini' ? 'Google Gemini' : 'Anthropic';
  if (!confirm(`Remove the saved ${label} API key? You can re-add it later.`)) return;

  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = 'Removing…';
  try {
    const r = await fetch('/api/config/api-keys/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Disconnect failed');
    const status = document.getElementById('settings-keys-status');
    showStatus(status, 'success', `✓ ${label} key removed.`);
    await loadApiKeyStatus();
  } catch (err) {
    const status = document.getElementById('settings-keys-status');
    showStatus(status, 'error', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
});

// Provider toggle — flip the active provider without re-pasting a key.
// Only rendered when both keys are stored (see loadApiKeyStatus).
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.provider-toggle-btn');
  if (!btn) return;
  const provider = btn.dataset.provider;
  if (btn.classList.contains('active')) return; // already active — no-op

  const group = btn.closest('.provider-toggle-buttons');
  group?.querySelectorAll('.provider-toggle-btn').forEach(b => (b.disabled = true));
  try {
    const r = await fetch('/api/config/api-keys/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Switch failed');
    const status = document.getElementById('settings-keys-status');
    const label = provider === 'gemini' ? 'Gemini' : 'Anthropic';
    showStatus(status, 'success', `✓ Switched to ${label} — ${data.activeModel}`);
    await loadApiKeyStatus();
  } catch (err) {
    const status = document.getElementById('settings-keys-status');
    showStatus(status, 'error', err.message);
  } finally {
    group?.querySelectorAll('.provider-toggle-btn').forEach(b => (b.disabled = false));
  }
});

// Show/hide toggle for password fields (works for both Settings and Onboarding)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-vis');
  if (!btn) return;
  const targetId = btn.dataset.target;
  const input = document.getElementById(targetId);
  if (input) {
    input.type = input.type === 'password' ? 'text' : 'password';
  }
});

// Check for updates
document.getElementById('settings-update-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('settings-update-btn');
  const status = document.getElementById('settings-update-status');
  btn.disabled = true;
  showStatus(status, 'info', 'Checking for updates...');

  try {
    const r = await fetch('/api/config/update-check');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);

    // Check whether the files on disk are newer than the currently running server.
    // This happens when a user ran the manual recovery command (git reset --hard + npm install)
    // but didn't restart the .app — the disk is on v2.3.x but the process is still v2.2.x.
    let versionInfo = null;
    try {
      const vr = await fetch('/api/version');
      versionInfo = await vr.json();
    } catch { /* non-critical */ }

    if (versionInfo?.restartRequired) {
      // v3.0.1-beta.8+: offer a one-click Restart instead of asking the user
      // to manually quit the Dock app. The /api/restart endpoint is what we
      // already call after a successful update (and is the bulletproof v2.7.1
      // implementation) — there's no reason to make the user do this by hand
      // when the running process is responsive enough to have served the
      // version check. The manual Dock → Quit path remains documented in the
      // fallback hint below in case the auto-restart somehow doesn't take.
      status.innerHTML = `
        <span style="color:var(--warning)">
          <strong>Files are updated (v${versionInfo.onDiskVersion})</strong>
          but the running app is still v${versionInfo.version}.
        </span>
        <button id="settings-restart-stale" class="btn primary pill" style="margin-left:12px;font-size:12px;padding:4px 14px">
          Restart now
        </button>
        <div style="color:var(--text-muted);font-size:11px;margin-top:6px">
          If the restart doesn't take, fall back to right-click the Dock icon → Quit, then re-open the .app.
        </div>`;
      status.className = 'status';
      document.getElementById('settings-restart-stale')?.addEventListener('click', async (ev) => {
        const restartBtn = ev.currentTarget;
        restartBtn.disabled = true;
        restartBtn.textContent = 'Restarting…';
        try { await fetch('/api/restart', { method: 'POST' }); } catch {}
        // Poll until the new server answers — same pattern as doUpdate().
        const poll = setInterval(async () => {
          try {
            const r = await fetch('/api/health', { signal: AbortSignal.timeout(1000) });
            if (r.ok) {
              clearInterval(poll);
              clearTimeout(failsafe);
              setTimeout(() => location.reload(), 500);
            }
          } catch {}
        }, 1200);
        const failsafe = setTimeout(() => {
          clearInterval(poll);
          status.innerHTML = `<span style="color:var(--warning)">Auto-restart didn't respond within 30s. Right-click the Dock icon → Quit, then re-open the .app.</span>`;
        }, 30_000);
      });
      return;
    }

    if (data.updateAvailable) {
      const versionText = data.current !== data.latest
        ? `v${data.current} → v${data.latest}`
        : `v${data.current} (${data.localCommit} → ${data.remoteCommit})`;
      status.innerHTML = `
        <span style="color:var(--warning)">Update available: ${versionText}</span>
        <button id="settings-do-update" class="btn primary pill" style="margin-left:12px;font-size:12px;padding:4px 14px">
          Update Now
        </button>`;
      status.className = 'status';
      document.getElementById('settings-do-update')?.addEventListener('click', doUpdate);
    } else {
      showStatus(status, 'success', `✓ You're up to date (v${data.current})`);
    }
  } catch (err) {
    showStatus(status, 'error', `Update check failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

async function doUpdate() {
  const status = document.getElementById('settings-update-status');
  status.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <div style="width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--accent);
           border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0"></div>
      <span>Updating... pulling latest code and installing dependencies. This may take a minute.</span>
    </div>`;
  status.className = 'status';

  let updateData = null;
  try {
    const r = await fetch('/api/config/update', { method: 'POST' });
    updateData = await r.json();
    if (!r.ok) throw new Error(updateData.error);
  } catch (err) {
    status.innerHTML = `<span style="color:var(--error)">Update failed: ${err.message || 'Unknown error'}</span>`;
    status.className = 'status';
    return;
  }

  // Update succeeded — now restart the server. If it was a partial success
  // (files synced but npm couldn't run — common when the fix itself is in the
  // update being pulled), surface the warning text so the user understands.
  const banner = updateData?.partial && updateData?.warning
    ? `<div style="color:var(--warning);font-size:12px;margin-top:6px;line-height:1.5">${updateData.warning}</div>`
    : '';
  const versionLine = updateData?.from && updateData?.to
    ? `<span style="color:var(--text-muted);font-family:var(--mono);font-size:11px">${updateData.from} → ${updateData.to}</span>`
    : '';
  status.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <div style="width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--success);
           border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0"></div>
      <span>Update complete. Restarting server... ${versionLine}</span>
    </div>${banner}`;

  // Trigger restart — this spawns a new server process, then kills this one
  try { await fetch('/api/restart', { method: 'POST' }); } catch {}

  // Poll for the new server to come up
  const poll = setInterval(async () => {
    try {
      const r = await fetch('/api/health', { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        clearInterval(poll);
        clearTimeout(failsafe);
        status.innerHTML = '<span style="color:var(--success)">✓ Updated successfully! Reloading...</span>';
        status.className = 'status';
        setTimeout(() => location.reload(), 600);
      }
    } catch {}
  }, 1500);

  const failsafe = setTimeout(() => {
    clearInterval(poll);
    status.innerHTML = '<span style="color:var(--success)">✓ Updated! <a href="http://localhost:3333" style="color:var(--accent)">Click here to reload</a>.</span>';
    status.className = 'status';
  }, 20000);
}

// ══════════════════════════════════════════════════════════════════════════════
// ONBOARDING WIZARD
// ══════════════════════════════════════════════════════════════════════════════

async function checkFirstRun() {
  try {
    const r = await fetch('/api/config/api-keys');
    const keys = await r.json();
    if (keys.hasGeminiKey || keys.hasAnthropicKey) return; // already configured
    // Show wizard
    document.getElementById('onboarding-wizard')?.classList.remove('hidden');
  } catch {}
}

// Step 1 — API keys
document.getElementById('ob-gemini-key')?.addEventListener('input', updateOBStep1);
document.getElementById('ob-anthropic-key')?.addEventListener('input', updateOBStep1);

function updateOBStep1() {
  const g = document.getElementById('ob-gemini-key')?.value.trim();
  const a = document.getElementById('ob-anthropic-key')?.value.trim();
  const btn = document.getElementById('ob-step1-next');
  if (btn) btn.disabled = !(g || a);
}

document.getElementById('ob-step1-next')?.addEventListener('click', async () => {
  const btn = document.getElementById('ob-step1-next');
  const status = document.getElementById('ob-step1-status');
  const gemini = document.getElementById('ob-gemini-key').value.trim();
  const anthropic = document.getElementById('ob-anthropic-key').value.trim();
  btn.disabled = true;

  try {
    const body = {};
    if (gemini)    body.geminiApiKey    = gemini;
    if (anthropic) body.anthropicApiKey = anthropic;
    const r = await fetch('/api/config/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error); }

    // Advance to step 2
    document.getElementById('ob-step-1').classList.add('hidden');
    document.getElementById('ob-step-2').classList.remove('hidden');
    document.querySelector('.ob-step[data-step="1"]').classList.remove('active');
    document.querySelector('.ob-step[data-step="1"]').classList.add('done');
    document.querySelector('.ob-step[data-step="2"]').classList.add('active');
  } catch (err) {
    showStatus(status, 'error', err.message);
    btn.disabled = false;
  }
});

// Step 2 — Domain template picker
document.querySelectorAll('.ob-template-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ob-template-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.getElementById('ob-step2-skip')?.addEventListener('click', () => obGoToStep3());
document.getElementById('ob-step2-next')?.addEventListener('click', async () => {
  const name = document.getElementById('ob-domain-name').value.trim();
  const status = document.getElementById('ob-step2-status');
  if (!name) {
    showStatus(status, 'error', 'Enter a domain name.');
    return;
  }
  const template = document.querySelector('.ob-template-btn.active')?.dataset.template || 'generic';
  try {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const r = await fetch('/api/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, displayName: name, description: '', template }),
    });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
    obGoToStep3();
  } catch (err) {
    showStatus(status, 'error', err.message);
  }
});

function obGoToStep3() {
  document.getElementById('ob-step-2').classList.add('hidden');
  document.getElementById('ob-step-3').classList.remove('hidden');
  document.querySelector('.ob-step[data-step="2"]').classList.remove('active');
  document.querySelector('.ob-step[data-step="2"]').classList.add('done');
  document.querySelector('.ob-step[data-step="3"]').classList.add('active');
}

document.getElementById('ob-step3-sync')?.addEventListener('click', () => {
  closeOnboarding();
  document.querySelector('[data-tab="sync"]')?.click();
});

document.getElementById('ob-step3-next')?.addEventListener('click', () => obGoToStep4());

function obGoToStep4() {
  document.getElementById('ob-step-3').classList.add('hidden');
  document.getElementById('ob-step-4').classList.remove('hidden');
  document.querySelector('.ob-step[data-step="3"]').classList.remove('active');
  document.querySelector('.ob-step[data-step="3"]').classList.add('done');
  document.querySelector('.ob-step[data-step="4"]').classList.add('active');
}

document.getElementById('ob-step4-later')?.addEventListener('click', () => closeOnboarding());
document.getElementById('ob-step4-done')?.addEventListener('click', () => closeOnboarding());
document.getElementById('ob-step4-now')?.addEventListener('click', () => {
  closeOnboarding();
  // Open the Settings tab and launch the MCP wizard directly
  if (typeof window.openMcpSettingsWizard === 'function') {
    window.openMcpSettingsWizard();
  } else {
    document.querySelector('[data-tab="settings"]')?.click();
  }
});

function closeOnboarding() {
  document.getElementById('onboarding-wizard')?.classList.add('hidden');
  // Refresh data
  loadDomains?.();
  loadChatDomains?.();
  try { loadDomainList?.(); } catch {}
}

// Run first-run check after initial load
checkFirstRun();

// ── HEALTH TAB ───────────────────────────────────────────────────────────────

const healthSummaryEl  = document.getElementById('health-summary');
const healthSectionsEl = document.getElementById('health-sections');
const healthStatusEl   = document.getElementById('health-status');
const healthEmptyEl    = document.getElementById('health-empty');

const HEALTH_META = {
  brokenLinks:       { label: 'Broken links',          desc: 'Wikilinks that point to a page that doesn\'t exist. Rows with a suggestion can be fixed in one click.', autoFix: true, perIssue: true },
  orphans:           { label: 'Orphan pages',          desc: 'Entity or concept pages with no incoming links.',                     autoFix: false },
  folderPrefixLinks: { label: 'Folder-prefix links',   desc: 'Links that include a folder prefix (e.g. [[concepts/rag]]).',         autoFix: true  },
  crossFolderDupes:  { label: 'Cross-folder duplicates', desc: 'The same page exists in both entities/ and concepts/.',             autoFix: true  },
  hyphenVariants:    { label: 'Hyphen variants',       desc: 'Entity files with the same name but different hyphenation.',          autoFix: true  },
  missingBacklinks:  { label: 'Missing backlinks',     desc: 'Summary mentions an entity but the entity doesn\'t link back.',       autoFix: true  },
};

const HEALTH_ORDER = [
  'brokenLinks', 'crossFolderDupes', 'hyphenVariants',
  'folderPrefixLinks', 'missingBacklinks', 'orphans',
];

// Session cache for AI availability — populated once per page load by
// /api/health/ai-available. Re-probed when the user re-enters the Health tab
// after changing API keys in Settings.
let _aiAvailable = null;
async function checkAiAvailable() {
  try {
    const r = await fetch('/api/health/ai-available');
    if (!r.ok) return false;
    const data = await r.json();
    _aiAvailable = !!data.available;
    return _aiAvailable;
  } catch {
    _aiAvailable = false;
    return false;
  }
}

function resetHealthPanel() {
  healthSummaryEl.classList.add('hidden');
  healthSectionsEl.classList.add('hidden');
  healthSectionsEl.innerHTML = '';
  healthEmptyEl.classList.remove('hidden');
  hideEl(healthStatusEl);
  // Also wipe any leftover Phase 3 state so switching domains or re-entering
  // the tab never shows stale semantic-dupe results from a previous scan.
  resetSemanticDupesPanel();
  // Clear any pending AI batch plans so a plan from the previous domain can
  // never be applied to a newly-selected one (audit H1). Guarded because these
  // are declared later in the module; by call time they're initialised.
  try { _blPlan = null; _orphPlan = null; _blBusy = false; _orphBusy = false; } catch { /* pre-init */ }
  // Re-hide + wipe the AI tool cards.
  for (const id of ['semantic-dupes-section', 'broken-links-ai-section', 'orphans-ai-section']) {
    const sec = document.getElementById(id);
    if (!sec) continue;
    sec.classList.add('hidden');
    const resultsEl = sec.querySelector('.semantic-dupes-results');
    if (resultsEl) resultsEl.innerHTML = '';
  }
}

// Wipes the Phase 3 semantic-duplicates sub-panel. Safe to call even before
// its DOM elements exist (initial page load) — all lookups null-guard.
function resetSemanticDupesPanel() {
  const section  = document.getElementById('semantic-dupes-section');
  const progress = document.getElementById('semantic-dupes-progress');
  const results  = document.getElementById('semantic-dupes-results');
  const status   = document.getElementById('semantic-dupes-status');
  if (section)  section.classList.add('hidden');
  if (progress) {
    progress.classList.add('hidden');
    const fill = progress.querySelector('.semantic-dupes-progress-fill');
    const text = progress.querySelector('.semantic-dupes-progress-text');
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = '';
  }
  if (results) results.innerHTML = '';
  if (status)  status.textContent = '';
  // Drop previewed-pairs safety gate too — a fresh scan starts from zero.
  if (typeof _semPreviewedPairs !== 'undefined') _semPreviewedPairs = new Set();
}

document.getElementById('health-scan-btn')?.addEventListener('click', () => runHealthScan());

// When the user switches domains in the Health tab, clear the Phase 3 panel
// immediately so stale results never linger across domains. The main summary
// + sections also get wiped so the UI shows the "click Scan" empty state.
document.getElementById('health-domain')?.addEventListener('change', () => {
  resetHealthPanel();
  _healthDomain = null;
});

async function runHealthScan() {
  const domain = document.getElementById('health-domain').value;
  if (!domain) {
    showStatus(healthStatusEl, 'error', 'Select a domain first.');
    return;
  }
  // Always wipe Phase 3 state at the start of any scan — prevents stale
  // semantic-dupe results from a previous domain bleeding into the new one.
  resetSemanticDupesPanel();
  healthEmptyEl.classList.add('hidden');
  showStatus(healthStatusEl, 'info', 'Scanning wiki…');
  try {
    // Re-probe AI availability in parallel with the scan; API key may have
    // been added/removed since last visit.
    const [scanResp] = await Promise.all([
      fetch(`/api/health/${encodeURIComponent(domain)}`),
      checkAiAvailable(),
    ]);
    if (!scanResp.ok) throw new Error((await scanResp.json()).error || 'Scan failed');
    const report = await scanResp.json();
    hideEl(healthStatusEl);
    renderHealthReport(report);
  } catch (err) {
    showStatus(healthStatusEl, 'error', err.message);
  }
}

// Expose the domain currently rendered in the Health tab so the
// semantic-duplicates flow (which lives outside renderHealthReport) can use it.
let _healthDomain = null;

function renderHealthReport(report) {
  _healthDomain = report.domain;
  // Defensive: default every issue array so a partial/older response can't throw
  // in render and break the whole Health UI (audit M3).
  for (const k of ['brokenLinks', 'orphans', 'folderPrefixLinks', 'crossFolderDupes', 'hyphenVariants', 'missingBacklinks']) {
    if (!Array.isArray(report[k])) report[k] = [];
  }
  // Re-entering the scan invalidates any pending AI batch plan from a previous
  // scan/domain — clear it so a stale plan can never be applied to a new domain
  // (audit H1).
  _blPlan = null; _orphPlan = null; _blBusy = false; _orphBusy = false;

  const total =
    report.brokenLinks.length +
    report.orphans.length +
    report.folderPrefixLinks.length +
    report.crossFolderDupes.length +
    report.hyphenVariants.length +
    report.missingBacklinks.length;

  const counts = report.counts || { entities: 0, concepts: 0, summaries: 0, dismissed: 0 };
  const dismissedCount = counts.dismissed || 0;
  const dismissedNote = dismissedCount > 0
    ? ` <span class="health-summary-dismissed" title="Issues you've previously dismissed — see the Dismissed section below to un-dismiss">${dismissedCount} dismissed</span>`
    : '';
  // Counts that drive the AI Maintenance action bar (v3.0.1-beta.17).
  const safeCount =
    report.crossFolderDupes.length +
    report.hyphenVariants.length +
    report.folderPrefixLinks.length +
    report.missingBacklinks.length +
    report.brokenLinks.filter(i => i.suggestedTarget).length;
  const brokenCount = report.brokenLinks.length;
  const orphanCount = report.orphans.length;

  // Build the action bar — batch tools first, so maintaining a large wiki is a
  // few clicks, not hundreds. Each button only appears when it has work to do.
  const maintBtns = [];
  if (safeCount > 0) maintBtns.push(`<button class="btn primary health-maint-btn" data-maint="safe">🛠 Fix ${safeCount} safe issue${safeCount === 1 ? '' : 's'}</button>`);
  if (_aiAvailable && brokenCount > 0) maintBtns.push(`<button class="btn health-maint-btn" data-maint="broken">✨ Fix ${brokenCount} broken link${brokenCount === 1 ? '' : 's'}</button>`);
  if (_aiAvailable && orphanCount > 0) maintBtns.push(`<button class="btn health-maint-btn" data-maint="orphans">✨ Rescue ${orphanCount} orphan${orphanCount === 1 ? '' : 's'}</button>`);
  if (_aiAvailable) maintBtns.push(`<button class="btn health-maint-btn" data-maint="dupes">✨ Find duplicate pages</button>`);

  // Show the bar whenever there's something actionable OR any structural issue.
  // The "✨ Find duplicate pages" button is in maintBtns whenever AI is
  // available, so this makes the semantic-duplicate scan reachable even on a
  // structurally-clean wiki (total === 0). Before v3.0.1-beta.22 the bar was
  // gated on `total > 0`, which hid the ONLY entry point to the semantic scan
  // on clean wikis — a wiki can be "✅ clean" of broken links/orphans yet still
  // have a dozen semantic duplicates, which this scan is the only way to find.
  // We still show the bar on `total > 0` even with no qualifying button so the
  // "add an API key" hint surfaces (audit M2).
  const showMaintBar = total > 0 || maintBtns.length > 0;
  const maintBar = showMaintBar
    ? `<div class="health-maintenance-bar">
         <div class="health-maintenance-label">⚡ Quick maintenance${_aiAvailable ? '' : ' <span class="hint">— add an API key in Settings to unlock AI tools</span>'}</div>
         ${maintBtns.length ? `<div class="health-maintenance-actions">${maintBtns.join('')}</div>` : ''}
         ${maintBtns.length ? `<div class="hint" style="margin-top:6px">AI tools show a preview before writing. Everything is git-tracked — revert from the Sync tab if needed.</div>` : ''}
       </div>`
    : '';

  healthSummaryEl.classList.remove('hidden');
  healthSummaryEl.innerHTML = `
    <div class="health-summary-head">
      <div class="health-summary-title">${total === 0 ? '✅ Wiki is clean' : `Found ${total} issue${total === 1 ? '' : 's'}`}${dismissedNote}</div>
      <div class="health-summary-sub">Scanned ${counts.entities} entities, ${counts.concepts} concepts, ${counts.summaries} summaries.</div>
    </div>
    <div class="health-summary-chips">
      ${HEALTH_ORDER.map(type => {
        const n = report[type].length;
        const meta = HEALTH_META[type];
        if (!meta) return '';
        const cls = n === 0 ? 'ok' : (meta.autoFix ? 'warn' : 'info');
        return `<span class="health-chip health-chip-${cls}">${meta.label}: ${n}</span>`;
      }).join('')}
    </div>
    ${maintBar}
  `;

  // Wire the action bar to the batch flows.
  healthSummaryEl.querySelectorAll('[data-maint]').forEach(btn => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.maint;
      if (which === 'safe')    runFixAllSafe(btn);
      else if (which === 'broken')  startBrokenLinkFix();
      else if (which === 'orphans') startOrphanRescue();
      else if (which === 'dupes')   startSemanticScan();
    });
  });

  healthSectionsEl.classList.remove('hidden');
  healthSectionsEl.innerHTML = HEALTH_ORDER.map(type => renderSection(report, type)).join('');

  // Phase 3 (v2.4.5+): show the semantic-duplicates section only when AI is
  // available — it's a paid, opt-in action. Hidden otherwise.
  // v3.0.1-beta.17: the AI batch tools are launched from the Maintenance action
  // bar above. Their cards stay HIDDEN until a flow is launched (un-hidden by the
  // run* functions) so a fresh scan never leaves empty bordered boxes under the
  // issue list (audit M1). Here we only RESET them — wipe stale results/progress
  // and re-hide — so switching domains or re-scanning starts clean.
  for (const id of ['semantic-dupes-section', 'broken-links-ai-section', 'orphans-ai-section']) {
    const sec = document.getElementById(id);
    if (!sec) continue;
    sec.classList.add('ai-tool-headless', 'hidden');
    const resultsEl = sec.querySelector('.semantic-dupes-results');
    const progressEl = sec.querySelector('.semantic-dupes-progress');
    if (resultsEl) resultsEl.innerHTML = '';
    if (progressEl) progressEl.classList.add('hidden');
  }

  // Wire up fix buttons. The "Fix all" button lives inside the <summary>, so
  // stop the click from also toggling the (now collapsed-by-default) section.
  healthSectionsEl.querySelectorAll('[data-fix-all]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fixAll(report.domain, btn.dataset.fixAll, btn); });
  });
  healthSectionsEl.querySelectorAll('[data-fix-one]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.fixOne;
      const issue = JSON.parse(btn.dataset.issue);
      fixOne(report.domain, type, issue, btn);
    });
  });
  healthSectionsEl.querySelectorAll('[data-ai-suggest]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await ensureAiDisclosure();
      if (!ok) return;
      const type = btn.dataset.aiSuggest;
      const issue = JSON.parse(btn.dataset.issue);
      runAiSuggest(report.domain, type, issue, btn);
    });
  });

  // Wire Dismiss buttons (v2.5.1+) — persists the skip via the dismiss endpoint
  // and removes the row. Failure shows an inline status; row is left in place.
  healthSectionsEl.querySelectorAll('[data-dismiss-one]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.dismissOne;
      const issue = JSON.parse(btn.dataset.issue);
      await dismissIssue(report.domain, type, issue, btn);
    });
  });

  // Render the Dismissed (N) section below the regular issue sections — kept
  // collapsed by default so it doesn't compete with the actionable lists.
  loadAndRenderDismissedSection(report.domain);
}

async function dismissIssue(domain, type, issue, btn) {
  if (!btn) return;
  const row = btn.closest('.health-issue-row');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Dismissing…';
  try {
    const r = await fetch(`/api/health/${encodeURIComponent(domain)}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, issue }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Dismiss failed');
    if (row) row.remove();
    // Refresh the Dismissed section so the user sees the newly-dismissed item.
    loadAndRenderDismissedSection(domain);
    bumpDismissedCounter(+1);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    showStatus(healthStatusEl, 'error', err.message);
  }
}

function bumpDismissedCounter(delta) {
  const el = healthSummaryEl?.querySelector('.health-summary-dismissed');
  if (!el) {
    // No counter currently shown (count was 0). If the new value is positive,
    // a fresh scan would render the counter; for now, leave the summary as-is.
    // The user can run a new scan or trust the Dismissed section's count.
    return;
  }
  const m = el.textContent.match(/(\d+)/);
  const cur = m ? parseInt(m[1], 10) : 0;
  const next = Math.max(0, cur + delta);
  el.textContent = `${next} dismissed`;
}

async function loadAndRenderDismissedSection(domain) {
  const container = document.getElementById('health-dismissed-section');
  if (!container) return;
  try {
    const r = await fetch(`/api/health/${encodeURIComponent(domain)}/dismissed`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load dismissed list');
    renderDismissedSection(container, domain, data.records || []);
  } catch (err) {
    console.warn('[health dismissed]', err.message);
    container.innerHTML = '';
    container.classList.add('hidden');
  }
}

function renderDismissedSection(container, domain, records) {
  if (!records.length) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  const rows = records.map(r => {
    const desc = describeDismissedRecord(r);
    const dismissedAt = r.dismissedAt
      ? new Date(r.dismissedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : '';
    return (
      `<li class="health-issue-row health-dismissed-row" data-key="${escapeAttr(r.key || '')}">` +
        `<span class="health-issue-desc">${desc}</span>` +
        `<span class="health-issue-actions">` +
          (dismissedAt ? `<span class="health-dismissed-when">${dismissedAt}</span>` : '') +
          `<button class="btn btn-sm health-undismiss-btn" data-undismiss-type="${escapeAttr(r.type)}" data-undismiss-record='${escapeAttr(JSON.stringify(r))}'>Un-dismiss</button>` +
        `</span>` +
      `</li>`
    );
  }).join('');

  container.innerHTML = `
    <details class="health-section health-dismissed-block">
      <summary class="health-section-head">
        <span class="health-section-title">Dismissed <span class="health-count">${records.length}</span></span>
      </summary>
      <p class="health-section-desc">Issues you previously skipped. They won't appear in scan results until you un-dismiss them.</p>
      <ul class="health-issue-list">${rows}</ul>
    </details>
  `;

  container.querySelectorAll('[data-undismiss-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.undismissType;
      const record = JSON.parse(btn.dataset.undismissRecord);
      undismissIssue(domain, type, record, btn);
    });
  });
}

/**
 * Convert a stored dismissal record back into a user-facing description.
 * Mirrors the shapes describeIssue() handles, but reads from record fields
 * directly (which carry the original issue's identity tuple).
 */
function describeDismissedRecord(r) {
  const esc = escapeHtml;
  switch (r.type) {
    case 'semanticDupe': {
      const [a, b] = r.slugs || [];
      const folder = r.folder && r.folder !== 'mixed' ? r.folder + '/' : '';
      return `<code>${esc(folder)}${esc(a || '?')}</code> ↔ <code>${esc(folder)}${esc(b || '?')}</code>`;
    }
    case 'orphans':
      return `Orphan: <code>${esc(r.path || r.slug || '?')}</code>`;
    case 'brokenLinks':
      return `Broken link in <code>${esc(r.sourceFile)}</code>: <code>[[${esc(r.linkText)}]]</code>`;
    case 'folderPrefixLinks':
      return `Folder-prefix link in <code>${esc(r.sourceFile)}</code>: <code>[[${esc(r.linkText)}]]</code>`;
    case 'crossFolderDupes':
      return `Cross-folder dupe: <code>${esc(r.keep)}</code> + <code>${esc(r.remove)}</code>`;
    case 'hyphenVariants':
      return `Hyphen variants: ${(r.files || []).map(f => `<code>${esc(f)}</code>`).join(', ')}`;
    case 'missingBacklinks':
      return `Missing backlink: <code>${esc(r.summary)}</code> ↛ <code>${esc(r.entity)}</code>`;
    default:
      return `<code>${esc(r.type)}</code>`;
  }
}

async function undismissIssue(domain, type, record, btn) {
  if (!btn) return;
  const row = btn.closest('.health-dismissed-row');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Restoring…';
  try {
    // The record IS the issue — the brain layer's recordToIssue() lift makes
    // the original record sufficient as `issue` for keyForIssue() to recreate
    // the canonical key. For semanticDupe specifically we need to expose the
    // pair-shape fields the route validator expects.
    let issue = record;
    if (type === 'semanticDupe') {
      const [slugA, slugB] = record.slugs || [];
      issue = {
        slugA, slugB,
        folderA: record.folderA || record.folder || 'entities',
        folderB: record.folderB || record.folder || 'entities',
      };
    }
    const r = await fetch(`/api/health/${encodeURIComponent(domain)}/undismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, issue }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Un-dismiss failed');
    if (row) row.remove();
    bumpDismissedCounter(-1);
    // Refresh the dismissed list so the count and remaining records sync.
    loadAndRenderDismissedSection(domain);
    // Note: we deliberately do NOT auto-rerun the structural scan. The next
    // time the user clicks Scan, the un-dismissed issue will reappear.
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    showStatus(healthStatusEl, 'error', err.message);
  }
}

// Module-level helper so renderSection AND the AI-result renderers below can
// produce the SAME dismiss button. Without this, renderBrokenLinkAiResult /
// renderOrphanAiResult replace the row's actions HTML and accidentally wipe
// the Dismiss button — the v2.5.1 UX bug surfaced shortly after release.
function dismissButtonHtml(type, issue) {
  return `<button class="btn btn-sm health-dismiss-btn" title="Mark as not-an-issue — won't show on future scans" data-dismiss-one="${type}" data-issue='${escapeAttr(JSON.stringify(issue))}'>Dismiss</button>`;
}

// Wire a single dismiss button to the dismiss endpoint. Called by AI-result
// renderers after they inject a Dismiss button into a row, so the click
// handler attaches even though the button didn't exist when renderHealthReport
// ran its initial wiring loop.
function wireDismissButton(btn, domain) {
  if (!btn || btn.dataset.dismissWired) return;
  btn.dataset.dismissWired = '1';
  btn.addEventListener('click', async () => {
    const type = btn.dataset.dismissOne;
    const issue = JSON.parse(btn.dataset.issue);
    await dismissIssue(domain, type, issue, btn);
  });
}

function renderSection(report, type) {
  const meta = HEALTH_META[type];
  let issues = report[type] || [];
  const n = issues.length;
  if (n === 0) return '';

  const canFixIssue = (issue) => {
    if (type === 'brokenLinks') return !!issue.suggestedTarget;
    return meta.autoFix;
  };
  const fixableCount = meta.autoFix ? issues.filter(canFixIssue).length : 0;
  const btnLabel = type === 'brokenLinks' ? 'Apply' : 'Fix';

  // Sort fixable rows to the top so users can see the actionable ones without
  // scrolling through hundreds of review-only entries.
  if (type === 'brokenLinks' && fixableCount > 0) {
    issues = [...issues].sort((a, b) => (b.suggestedTarget ? 1 : 0) - (a.suggestedTarget ? 1 : 0));
  }

  const dismissBtn = (issue) => dismissButtonHtml(type, issue);

  const rows = issues.map((issue, idx) => {
    const description = describeIssue(type, issue);
    let trailing;
    if (canFixIssue(issue)) {
      // Auto-fixable rows: just the Apply / Fix button. No dismiss — the user
      // is meant to click Apply, not skip permanently. (If they really want to
      // suppress an auto-fixable item, they can dismiss it from the Dismissed
      // section after running fix-all.)
      trailing = `<button class="btn btn-sm health-fix-btn" data-fix-one="${type}" data-issue='${escapeAttr(JSON.stringify(issue))}'>${btnLabel}</button>`;
    } else if (type === 'brokenLinks' && _aiAvailable) {
      // Review-only broken link + AI available → offer AI suggestion + Dismiss
      trailing =
        `<button class="btn btn-sm health-ai-btn" data-ai-suggest="brokenLinks" data-issue='${escapeAttr(JSON.stringify(issue))}' data-row-idx="${idx}">✨ Ask AI</button>` +
        dismissBtn(issue) +
        `<span class="health-review-tag">Review</span>`;
    } else if (type === 'orphans' && _aiAvailable) {
      // Orphan page + AI available → offer AI orphan-rescue + Dismiss
      trailing =
        `<button class="btn btn-sm health-ai-btn" data-ai-suggest="orphans" data-issue='${escapeAttr(JSON.stringify(issue))}' data-row-idx="${idx}">✨ Ask AI</button>` +
        dismissBtn(issue) +
        `<span class="health-review-tag">Review</span>`;
    } else if (type === 'brokenLinks' || type === 'orphans') {
      // Review-only without AI → still allow Dismiss
      trailing = dismissBtn(issue) + `<span class="health-review-tag">Review</span>`;
    } else {
      trailing = `<span class="health-review-tag">Review</span>`;
    }
    return `<li class="health-issue-row" data-type="${type}" data-row-idx="${idx}"><span class="health-issue-desc">${description}</span><span class="health-issue-actions">${trailing}</span></li>`;
  }).join('');

  const fixAllLabel = type === 'brokenLinks'
    ? `Apply all suggestions (${fixableCount})`
    : `Fix all (${n})`;
  const fixAllBtn = fixableCount > 0
    ? `<button class="btn btn-sm health-fix-all-btn" data-fix-all="${type}">${fixAllLabel}</button>`
    : '';

  // Collapsed by default (v3.0.1-beta.18): with 1000+ rows an open section
  // pushes the Quick-maintenance bar and the AI progress/preview panels far
  // below the fold, so the user can't see whether a fix is running. Click the
  // section header to expand it.
  return `
    <details class="health-section">
      <summary class="health-section-head">
        <span class="health-section-title">${meta.label} <span class="health-count">${n}</span></span>
        ${fixAllBtn}
      </summary>
      <p class="health-section-desc">${meta.desc}</p>
      <ul class="health-issue-list">${rows}</ul>
    </details>
  `;
}

function describeIssue(type, issue) {
  const esc = escapeHtml;
  switch (type) {
    case 'brokenLinks':
      return `In <code>${esc(issue.sourceFile)}</code>: <code>[[${esc(issue.linkText)}]]</code>`
        + (issue.suggestedTarget ? ` — did you mean <code>[[${esc(issue.suggestedTarget)}]]</code>?` : '');
    case 'orphans':
      return `<code>${esc(issue.path)}</code> has no incoming links`;
    case 'folderPrefixLinks':
      return `In <code>${esc(issue.sourceFile)}</code>: <code>[[${esc(issue.linkText)}]]</code>`;
    case 'crossFolderDupes':
      return `Merge <code>${esc(issue.remove)}</code> into <code>${esc(issue.keep)}</code>`;
    case 'hyphenVariants':
      return `${issue.files.map(f => `<code>${esc(f)}</code>`).join(', ')} → merge into <code>${esc(issue.suggestedSlug)}</code>`;
    case 'missingBacklinks':
      return `<code>${esc(issue.entity)}</code> is missing backlink to <code>${esc(issue.summary)}</code>`;
    default:
      return JSON.stringify(issue);
  }
}

async function fixOne(domain, type, issue, btn) {
  btn.disabled = true;
  btn.textContent = 'Fixing…';
  try {
    const r = await fetch(`/api/health/${encodeURIComponent(domain)}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, issue }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Fix failed');
    await runHealthScan();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Fix';
    showStatus(healthStatusEl, 'error', err.message);
  }
}

async function fixAll(domain, type, btn) {
  btn.disabled = true;
  btn.textContent = 'Fixing…';
  try {
    const r = await fetch(`/api/health/${encodeURIComponent(domain)}/fix-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Fix-all failed');
    const result = await r.json();
    showStatus(healthStatusEl, 'success', `Fixed ${result.fixed} of ${result.total}.`);
    await runHealthScan();
  } catch (err) {
    btn.disabled = false;
    showStatus(healthStatusEl, 'error', err.message);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

// ── AI Health (Phase 1 — v2.4.3) ────────────────────────────────────────────

const AI_DISCLOSURE_KEY = 'curator-ai-health-disclosure-seen-v1';

/**
 * Ensure the user has acknowledged the AI privacy disclosure once. Returns a
 * Promise<boolean> — true if the user accepts (or has previously), false if
 * they cancel.
 */
function ensureAiDisclosure() {
  if (localStorage.getItem(AI_DISCLOSURE_KEY) === 'yes') return Promise.resolve(true);
  return new Promise(resolve => {
    const overlay = document.getElementById('ai-health-disclosure');
    const continueBtn = document.getElementById('ai-disclosure-continue');
    const cancelBtn   = document.getElementById('ai-disclosure-cancel');
    if (!overlay || !continueBtn || !cancelBtn) return resolve(true); // fail-open in case markup missing

    overlay.classList.remove('hidden');
    const onContinue = () => {
      localStorage.setItem(AI_DISCLOSURE_KEY, 'yes');
      cleanup();
      resolve(true);
    };
    const onCancel = () => { cleanup(); resolve(false); };
    function cleanup() {
      overlay.classList.add('hidden');
      continueBtn.removeEventListener('click', onContinue);
      cancelBtn.removeEventListener('click', onCancel);
    }
    continueBtn.addEventListener('click', onContinue);
    cancelBtn.addEventListener('click', onCancel);
  });
}

async function runAiSuggest(domain, type, issue, btn) {
  const row = btn.closest('.health-issue-row');
  const actions = row?.querySelector('.health-issue-actions');
  if (!actions) return;

  // Replace the actions area with a loading indicator while we wait
  actions.innerHTML = `<span class="health-ai-loading">Asking AI…</span>`;

  let result;
  try {
    const r = await fetch(`/api/health/${encodeURIComponent(domain)}/ai-suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, issue }),
    });
    result = await r.json();
    if (!r.ok || result.error) throw new Error(result.error || 'AI suggest failed');
  } catch (err) {
    actions.innerHTML =
      `<button class="btn btn-sm health-ai-btn health-ai-retry">✨ Retry</button>` +
      `<span class="health-review-tag">Review</span>`;
    const retryBtn = actions.querySelector('.health-ai-retry');
    retryBtn.addEventListener('click', () => runAiSuggest(domain, type, issue, retryBtn));
    showStatus(healthStatusEl, 'error', 'AI suggest failed: ' + err.message);
    return;
  }

  if (type === 'orphans') {
    renderOrphanAiResult(domain, issue, result, row, actions);
  } else {
    renderBrokenLinkAiResult(domain, issue, result, row, actions);
  }
}

function renderBrokenLinkAiResult(domain, issue, result, row, actions) {
  const desc = row.querySelector('.health-issue-desc');
  const canApply = !!result.target && result.confidence !== 'low';
  const conf = result.confidence || 'low';
  const rationale = escapeHtml(result.rationale || '');

  let body;
  if (result.target) {
    body =
      `<div class="health-ai-result-head">` +
        `<span class="health-ai-result-label">🤖 Suggested:</span> ` +
        `<code>[[${escapeHtml(result.target)}]]</code> ` +
        `<span class="health-ai-confidence health-ai-confidence-${conf}">${escapeHtml(conf)} confidence</span>` +
      `</div>` +
      `<div class="health-ai-rationale">${rationale}</div>`;
  } else {
    body =
      `<div class="health-ai-result-head">` +
        `<span class="health-ai-result-label">🤖 No good target:</span> ` +
        `<span class="health-ai-confidence health-ai-confidence-${conf}">${escapeHtml(conf)} confidence</span>` +
      `</div>` +
      `<div class="health-ai-rationale">${rationale}</div>` +
      `<div class="health-ai-hint">Consider creating a new page or removing the link.</div>`;
  }

  let aiBlock = row.querySelector('.health-ai-result');
  if (!aiBlock) {
    aiBlock = document.createElement('div');
    aiBlock.className = 'health-ai-result';
    desc.insertAdjacentElement('afterend', aiBlock);
  }
  aiBlock.innerHTML = body;

  if (canApply) {
    // Apply (accept AI fix) | Dismiss (won't flag again) | Skip (close AI block,
    // keep flagging on future scans). Three distinct actions; keeping all three
    // makes the user's options explicit. "Skip" tooltip clarifies it's just a
    // local close — different from Dismiss.
    actions.innerHTML =
      `<button class="btn btn-sm health-fix-btn health-ai-apply">Apply</button>` +
      dismissButtonHtml('brokenLinks', issue) +
      `<button class="btn btn-sm health-ai-skip" title="Close this AI suggestion. The link will still be flagged on the next scan — use Dismiss to never show it again.">Skip</button>`;
    const applyBtn = actions.querySelector('.health-ai-apply');
    const skipBtn  = actions.querySelector('.health-ai-skip');
    const dismissBtn = actions.querySelector('.health-dismiss-btn');
    applyBtn.addEventListener('click', () => {
      const patched = { ...issue, suggestedTarget: result.target };
      fixOne(domain, 'brokenLinks', patched, applyBtn);
    });
    skipBtn.addEventListener('click', () => {
      aiBlock.remove();
      actions.innerHTML = dismissButtonHtml('brokenLinks', issue) + `<span class="health-review-tag">Review</span>`;
      const reAdded = actions.querySelector('.health-dismiss-btn');
      if (reAdded) wireDismissButton(reAdded, domain);
    });
    wireDismissButton(dismissBtn, domain);
  } else {
    // No good target → only meaningful actions are Dismiss (won't flag again)
    // or leave for review later.
    actions.innerHTML = dismissButtonHtml('brokenLinks', issue) + `<span class="health-review-tag">Review</span>`;
    wireDismissButton(actions.querySelector('.health-dismiss-btn'), domain);
  }
}

function renderOrphanAiResult(domain, issue, result, row, actions) {
  const desc = row.querySelector('.health-issue-desc');
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];

  let aiBlock = row.querySelector('.health-ai-result');
  if (!aiBlock) {
    aiBlock = document.createElement('div');
    aiBlock.className = 'health-ai-result';
    desc.insertAdjacentElement('afterend', aiBlock);
  }

  if (candidates.length === 0) {
    aiBlock.innerHTML =
      `<div class="health-ai-result-head">` +
        `<span class="health-ai-result-label">🤖 No good candidates.</span>` +
      `</div>` +
      `<div class="health-ai-hint">AI found no existing pages that should reference this orphan. Consider whether the orphan itself should stay, merge into another page, or be removed.</div>`;
    // No fixable candidates → still preserve the row-level Dismiss so the user
    // can mark the orphan as intentional and stop seeing it on future scans.
    actions.innerHTML = dismissButtonHtml('orphans', issue) + `<span class="health-review-tag">Review</span>`;
    wireDismissButton(actions.querySelector('.health-dismiss-btn'), domain);
    return;
  }

  const header =
    `<div class="health-ai-result-head">` +
      `<span class="health-ai-result-label">🤖 Suggested pages to link from:</span>` +
    `</div>`;

  const candidateRows = candidates.map((c, i) => {
    const conf = c.confidence || 'low';
    const target = escapeHtml(c.target);
    const rationale = escapeHtml(c.rationale || '');
    const descText = escapeHtml(c.description || '');
    const canApply = conf !== 'low';
    return (
      `<div class="health-ai-candidate" data-candidate-idx="${i}">` +
        `<div class="health-ai-candidate-head">` +
          `<code>[[${target}]]</code> ` +
          `<span class="health-ai-confidence health-ai-confidence-${conf}">${escapeHtml(conf)} confidence</span>` +
        `</div>` +
        (descText ? `<div class="health-ai-candidate-desc">Bullet: <em>${descText}</em></div>` : '') +
        `<div class="health-ai-rationale">${rationale}</div>` +
        `<div class="health-ai-candidate-actions">` +
          (canApply
            ? `<button class="btn btn-sm health-fix-btn health-ai-apply-orphan">Apply</button>`
            : `<span class="health-review-tag">Low confidence — review manually</span>`) +
          `<button class="btn btn-sm health-ai-skip-orphan" title="Skip this suggestion only — the orphan stays flagged. To stop seeing the orphan altogether, use the Dismiss button at the row level.">Skip</button>` +
        `</div>` +
      `</div>`
    );
  }).join('');

  aiBlock.innerHTML = header + `<div class="health-ai-candidates">${candidateRows}</div>`;
  // Preserve the row-level Dismiss button so the user can choose to suppress
  // the whole orphan after seeing the AI's candidate list — e.g. when none of
  // the suggestions are right and they don't want this orphan re-surfaced.
  actions.innerHTML = dismissButtonHtml('orphans', issue) + `<span class="health-review-tag">Review</span>`;
  wireDismissButton(actions.querySelector('.health-dismiss-btn'), domain);

  // Wire per-candidate buttons. Each Apply targets a different page; Skip
  // removes just that candidate row. When all candidates are gone, we collapse
  // the entire block.
  aiBlock.querySelectorAll('.health-ai-candidate').forEach(card => {
    const idx = Number(card.dataset.candidateIdx);
    const cand = candidates[idx];
    const applyBtn = card.querySelector('.health-ai-apply-orphan');
    const skipBtn  = card.querySelector('.health-ai-skip-orphan');

    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Applying…';
        try {
          const r = await fetch(`/api/health/${encodeURIComponent(domain)}/fix`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'orphanLink',
              issue: {
                orphanSlug: issue.slug,
                targetSlug: cand.target,
                description: cand.description || '',
              },
            }),
          });
          if (!r.ok) throw new Error((await r.json()).error || 'Apply failed');
          const data = await r.json();
          if (!data.fixed) throw new Error('Server reported no changes applied');
          // On success, trigger a full re-scan — orphan may disappear.
          await runHealthScan();
        } catch (err) {
          applyBtn.disabled = false;
          applyBtn.textContent = 'Apply';
          showStatus(healthStatusEl, 'error', err.message);
        }
      });
    }

    skipBtn.addEventListener('click', () => {
      card.remove();
      if (aiBlock.querySelectorAll('.health-ai-candidate').length === 0) {
        aiBlock.remove();
        actions.innerHTML = `<span class="health-review-tag">Review</span>`;
      }
    });
  });
}

// ── Phase 3 (v2.4.5) — Semantic duplicate scanning ─────────────────────────

const semBtn          = document.getElementById('semantic-dupes-scan-btn');
const semStatus       = document.getElementById('semantic-dupes-status');
const semProgress     = document.getElementById('semantic-dupes-progress');
const semResults      = document.getElementById('semantic-dupes-results');
const semConfirmModal = document.getElementById('semantic-dupes-confirm');
const semEstimateEl   = document.getElementById('semantic-dupes-estimate');
const semCancelBtn    = document.getElementById('semantic-dupes-cancel');
const semConfirmBtn   = document.getElementById('semantic-dupes-confirm-btn');
const semPreviewModal = document.getElementById('semantic-merge-preview');
const semPreviewBody  = document.getElementById('semantic-merge-preview-body');
const semMergeCancel  = document.getElementById('semantic-merge-cancel');
const semMergeConfirm = document.getElementById('semantic-merge-confirm');

let _semPreviewedPairs = new Set();   // pairs the user has previewed (safety gate)
let _semCurrentPreview = null;        // the pair currently in the preview modal
let _semBatchRunning = false;         // guards against double-firing the batch merge

async function startSemanticScan() {
  if (!_healthDomain) {
    showStatus(healthStatusEl, 'error', 'Run Scan first so a domain is selected.');
    return;
  }
  if (semStatus) semStatus.textContent = 'Estimating…';
  try {
    const r = await fetch(`/api/health/${encodeURIComponent(_healthDomain)}/semantic-dupes/estimate`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Estimate failed');
    openSemanticConfirmModal(data);
    if (semStatus) semStatus.textContent = '';
  } catch (err) {
    if (semStatus) semStatus.textContent = '';
    showStatus(healthStatusEl, 'error', err.message);
  }
}
semBtn?.addEventListener('click', startSemanticScan);

function openSemanticConfirmModal(est) {
  const costStr = est.estimatedUsd !== null && est.estimatedUsd !== undefined
    ? `$${est.estimatedUsd.toFixed(4)} on ${est.provider}/${est.model}`
    : 'cost unknown';
  const overCap = est.estimatedTokens > est.costCeilingTokens;
  const truncatedNote = est.truncated
    ? `<div class="hint" style="margin-top:6px">Pre-filter found ${est.totalCandidates.toLocaleString()} potential pairs; capped to ${est.candidatePairs.toLocaleString()} highest-similarity (raise the cap in Settings if you want more).</div>`
    : '';
  semEstimateEl.innerHTML = `
    <div class="semantic-dupes-estimate-row"><strong>Pages:</strong> ${est.pageCount.toLocaleString()}</div>
    <div class="semantic-dupes-estimate-row"><strong>Candidate pairs:</strong> ${est.candidatePairs.toLocaleString()}</div>
    <div class="semantic-dupes-estimate-row"><strong>Estimated tokens:</strong> ${est.estimatedTokens.toLocaleString()}</div>
    <div class="semantic-dupes-estimate-row"><strong>Estimated cost:</strong> ${escapeHtml(costStr)}</div>
    <div class="semantic-dupes-estimate-row"><strong>Your cost ceiling:</strong> ${est.costCeilingTokens.toLocaleString()} tokens</div>
    ${overCap ? `<div class="status error" style="margin-top:8px">Estimate exceeds your cost ceiling. Raise the ceiling in Settings, or lower the candidate cap.</div>` : ''}
    ${truncatedNote}
  `;
  semConfirmBtn.disabled = overCap;
  semConfirmModal.classList.remove('hidden');
}

function closeSemanticConfirmModal() {
  semConfirmModal.classList.add('hidden');
}

semCancelBtn?.addEventListener('click', closeSemanticConfirmModal);
semConfirmBtn?.addEventListener('click', () => {
  closeSemanticConfirmModal();
  runSemanticScan();
});

async function runSemanticScan() {
  const _semSec = document.getElementById('semantic-dupes-section');
  _semSec?.classList.remove('hidden');
  _semSec?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  semResults.innerHTML = '';
  _semPreviewedPairs = new Set();
  _semBatchRunning = false;
  semProgress.classList.remove('hidden');
  const fill = semProgress.querySelector('.semantic-dupes-progress-fill');
  const text = semProgress.querySelector('.semantic-dupes-progress-text');
  fill.style.width = '0%';
  text.textContent = 'Starting…';

  semBtn.disabled = true;
  try {
    const r = await fetch(`/api/health/${encodeURIComponent(_healthDomain)}/semantic-dupes/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `Scan failed (HTTP ${r.status})`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        let event;
        try { event = JSON.parse(dataLine.slice(6)); }
        catch { continue; }
        handleSemanticEvent(event, { fill, text });
      }
    }
  } catch (err) {
    text.textContent = 'Error';
    showStatus(healthStatusEl, 'error', err.message);
  } finally {
    semBtn.disabled = false;
  }
}

function handleSemanticEvent(event, ui) {
  if (event.type === 'start') {
    ui.text.textContent = `Checking ${event.candidatePairs} pairs across ${event.batches} batches…`;
    ui.fill.style.width = '2%';
  } else if (event.type === 'progress') {
    const pct = event.total > 0 ? (event.processed / event.total) * 100 : 0;
    ui.fill.style.width = `${Math.max(2, Math.round(pct))}%`;
    ui.text.textContent = `${event.processed} / ${event.total} pairs checked · ${event.found} duplicates found`;
  } else if (event.type === 'pair') {
    renderSemanticPairCard(event.pair);
  } else if (event.type === 'batch-error') {
    console.warn('[semantic] batch error:', event.error);
  } else if (event.type === 'error') {
    ui.text.textContent = 'Error';
    showStatus(healthStatusEl, 'error', event.error);
  } else if (event.type === 'done') {
    ui.fill.style.width = '100%';
    const usd = event.cost && typeof event.cost.estimatedUsd === 'number'
      ? `$${event.cost.estimatedUsd.toFixed(4)}` : 'cost unknown';
    ui.text.textContent = `Done. ${event.pairs.length} duplicate${event.pairs.length === 1 ? '' : 's'} found · ${event.cost.inputTokens.toLocaleString()} in + ${event.cost.outputTokens.toLocaleString()} out tokens · ${usd}`;
    if (event.pairs.length === 0) {
      semResults.innerHTML = '<div class="hint" style="padding:12px">No semantic duplicates found in this domain.</div>';
    } else {
      renderBatchMergeBar();
    }
  }
}

// ── Batch merge of high-confidence duplicates (v3.0.1-beta.15) ────────────────
// The previous flow forced the user to Preview + Merge every pair one at a time
// — brutal at 245 pairs. This adds a single "Merge all high-confidence" action
// with an explicit confirm step. Only HIGH-confidence pairs (clear near-
// identical duplicates) are eligible; medium/low stay manual. The whole wiki is
// git-tracked, so a mistaken batch is revertable from the Sync tab.

// Derive the batch list from the LIVE cards in the DOM, not a frozen scan-time
// array (audit fix). This makes the batch respect every per-card action the
// user took after the scan: a Flip rebuilds the card with swapped
// keep/remove dataset (so we merge the direction the user chose), a Skip removes
// the card entirely (so we don't re-merge a dismissed pair), and an individual
// Merge adds `.semantic-pair-merged` (excluded so we don't re-attempt it).
function highConfidencePairs() {
  const cards = semResults.querySelectorAll('.semantic-pair-card:not(.semantic-pair-merged)');
  const pairs = [];
  for (const card of cards) {
    if (card.dataset.confidence !== 'high') continue;
    const keep = (card.dataset.keep || '').split('/');
    const remove = (card.dataset.remove || '').split('/');
    if (keep.length < 2 || remove.length < 2) continue;
    pairs.push({
      keepFolder: keep[0], keepSlug: keep.slice(1).join('/'),
      removeFolder: remove[0], removeSlug: remove.slice(1).join('/'),
      confidence: 'high',
    });
  }
  return pairs;
}

function renderBatchMergeBar() {
  const existing = document.getElementById('semantic-batch-bar');
  if (existing) existing.remove();
  const highConf = highConfidencePairs();
  if (highConf.length === 0) return;

  const bar = document.createElement('div');
  bar.id = 'semantic-batch-bar';
  bar.className = 'semantic-batch-bar';
  bar.innerHTML = `
    <button class="btn btn-primary semantic-merge-all-btn">✨ Merge all ${highConf.length} high-confidence duplicate${highConf.length === 1 ? '' : 's'}</button>
    <span class="hint">Merges every green “high confidence” pair at once. The duplicate page is deleted and its links repointed. If you use GitHub Sync, this is revertable from the Sync tab.</span>
  `;
  // Insert as the first element so it sits above the pair cards.
  semResults.insertBefore(bar, semResults.firstChild);
  bar.querySelector('.semantic-merge-all-btn').addEventListener('click', () => confirmBatchMerge(bar));
}

function confirmBatchMerge(bar) {
  const highConf = highConfidencePairs();
  if (highConf.length === 0) return;
  bar.innerHTML = `
    <div class="semantic-batch-confirm">
      <strong>Merge ${highConf.length} high-confidence duplicate${highConf.length === 1 ? '' : 's'}?</strong>
      This deletes ${highConf.length} duplicate page${highConf.length === 1 ? '' : 's'} and rewrites their links across the wiki.
      If you use GitHub Sync, you can undo it from the <strong>Sync</strong> tab if anything looks wrong.
      <div class="semantic-batch-confirm-actions">
        <button class="btn btn-primary semantic-batch-go">Yes, merge all ${highConf.length}</button>
        <button class="btn semantic-batch-cancel">Cancel</button>
      </div>
    </div>
  `;
  bar.querySelector('.semantic-batch-cancel').addEventListener('click', () => renderBatchMergeBar());
  bar.querySelector('.semantic-batch-go').addEventListener('click', () => runSemanticBatchMerge(bar, highConf));
}

function findCardForPair(pair) {
  const key = `${pair.keepFolder}/${pair.keepSlug}||${pair.removeFolder}/${pair.removeSlug}`;
  const cards = semResults.querySelectorAll('.semantic-pair-card');
  for (const c of cards) if (c.dataset.key === key) return c;
  return null;
}

async function runSemanticBatchMerge(bar, pairs) {
  if (_semBatchRunning) return;
  _semBatchRunning = true;
  bar.innerHTML = `<div class="semantic-batch-progress"><span class="spinner"></span> <span class="semantic-batch-progress-text">Merging 0 / ${pairs.length}…</span></div>`;
  const progText = bar.querySelector('.semantic-batch-progress-text');

  try {
    const r = await fetch(`/api/health/${encodeURIComponent(_healthDomain)}/semantic-dupes/merge-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairs }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `Batch merge failed (HTTP ${r.status})`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let summary = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        let event;
        try { event = JSON.parse(dataLine.slice(6)); }
        catch { continue; }

        if (event.type === 'progress') {
          if (progText) progText.textContent = `Merging ${event.done} / ${event.total}…`;
          // Update the matching card live.
          if (event.pair) {
            const card = findCardForPair(event.pair);
            if (card) {
              if (event.status === 'merged') {
                card.classList.add('semantic-pair-merged');
                card.innerHTML = `<div class="hint">✓ Merged. <code>[[${escapeHtml(event.pair.removeSlug)}]]</code> → <code>[[${escapeHtml(event.pair.keepSlug)}]]</code></div>`;
              } else if (event.status === 'skipped') {
                card.classList.add('semantic-pair-merged');
                card.innerHTML = `<div class="hint">⊘ Skipped (already merged by an earlier pair). <code>[[${escapeHtml(event.pair.removeSlug)}]]</code></div>`;
              }
            }
          }
        } else if (event.type === 'done') {
          summary = event;
        } else if (event.type === 'error') {
          throw new Error(event.error || 'Batch merge error');
        }
      }
    }

    if (summary) {
      const parts = [`${summary.merged} merged`];
      if (summary.skipped) parts.push(`${summary.skipped} skipped`);
      if (summary.errors) parts.push(`${summary.errors} errored`);
      bar.innerHTML = `<div class="hint">✓ Done — ${parts.join(' · ')}. Go to <strong>Sync</strong> to push the cleanup (or to revert it).</div>`;
      showStatus(healthStatusEl, 'success', `Merged ${summary.merged} duplicate${summary.merged === 1 ? '' : 's'}.`);
      refreshSyncPendingBadge?.();
    } else {
      bar.innerHTML = `<div class="hint">Done.</div>`;
    }
  } catch (err) {
    bar.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
    showStatus(healthStatusEl, 'error', err.message);
  } finally {
    _semBatchRunning = false;
  }
}

function renderSemanticPairCard(pair) {
  const card = document.createElement('div');
  card.className = 'semantic-pair-card';
  card.dataset.keep = `${pair.keepFolder}/${pair.keepSlug}`;
  card.dataset.remove = `${pair.removeFolder}/${pair.removeSlug}`;
  const conf = pair.confidence || 'medium';
  card.dataset.confidence = conf;   // read by the batch-merge selector
  const pairKey = `${pair.keepFolder}/${pair.keepSlug}||${pair.removeFolder}/${pair.removeSlug}`;
  card.dataset.key = pairKey;
  card.innerHTML = `
    <div class="semantic-pair-head">
      <code>[[${escapeHtml(pair.removeSlug)}]]</code>
      <span class="semantic-pair-arrow">→</span>
      <code>[[${escapeHtml(pair.keepSlug)}]]</code>
      <span class="health-ai-confidence health-ai-confidence-${conf}">${escapeHtml(conf)} confidence</span>
    </div>
    <div class="semantic-pair-sub">
      Keep: <code>${escapeHtml(pair.keepFolder)}/${escapeHtml(pair.keepSlug)}</code>
      &nbsp;·&nbsp; Remove: <code>${escapeHtml(pair.removeFolder)}/${escapeHtml(pair.removeSlug)}</code>
    </div>
    <div class="semantic-pair-rationale">${escapeHtml(pair.rationale || '')}</div>
    <div class="semantic-pair-actions">
      <button class="btn btn-sm semantic-preview-btn">Preview diff</button>
      <button class="btn btn-sm semantic-flip-btn" title="Swap which side is kept">↔ Flip</button>
      <button class="btn btn-sm semantic-merge-btn" disabled>Merge</button>
      <button class="btn btn-sm semantic-skip-btn">Skip</button>
    </div>
  `;
  semResults.appendChild(card);

  card.querySelector('.semantic-preview-btn').addEventListener('click', () => openMergePreview(card, pair));
  card.querySelector('.semantic-flip-btn').addEventListener('click', () => {
    const flipped = {
      keepSlug: pair.removeSlug, keepFolder: pair.removeFolder,
      removeSlug: pair.keepSlug, removeFolder: pair.keepFolder,
      confidence: pair.confidence, rationale: pair.rationale,
    };
    card.replaceWith(card); // no-op to appease linters
    // Rebuild card
    card.remove();
    renderSemanticPairCard(flipped);
  });
  const mergeBtn = card.querySelector('.semantic-merge-btn');
  mergeBtn.addEventListener('click', () => {
    if (!_semPreviewedPairs.has(pairKey)) {
      showStatus(healthStatusEl, 'error', 'Click Preview diff before merging.');
      return;
    }
    openMergeConfirm(card, pair);
  });
  card.querySelector('.semantic-skip-btn').addEventListener('click', async () => {
    // Persist the skip (v2.5.1+) so the same pair doesn't re-surface on the
    // next semantic-dupe scan. The pair shape mirrors what the brain layer
    // expects in `findSemanticCandidatePairs` output.
    const skipBtn = card.querySelector('.semantic-skip-btn');
    skipBtn.disabled = true;
    skipBtn.textContent = 'Skipping…';
    try {
      const issue = {
        slugA: pair.keepSlug, folderA: pair.keepFolder,
        slugB: pair.removeSlug, folderB: pair.removeFolder,
      };
      const r = await fetch(`/api/health/${encodeURIComponent(_healthDomain)}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'semanticDupe', issue }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Skip failed');
      card.remove();
      // Refresh the Dismissed section if the structural Health view is showing.
      if (_healthDomain) loadAndRenderDismissedSection(_healthDomain);
      bumpDismissedCounter(+1);
    } catch (err) {
      skipBtn.disabled = false;
      skipBtn.textContent = 'Skip';
      showStatus(healthStatusEl, 'error', err.message);
    }
  });
}

async function openMergePreview(card, pair) {
  semPreviewBody.innerHTML = '<div class="hint">Loading preview…</div>';
  semPreviewModal.classList.remove('hidden');
  try {
    const r = await fetch(`/api/health/${encodeURIComponent(_healthDomain)}/semantic-dupes/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue: pair }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Preview failed');

    const files = data.affectedFiles || [];
    const fileRows = files.slice(0, 20).map(f => `<li><code>${escapeHtml(f.path)}</code> — ${f.linkCount} link${f.linkCount === 1 ? '' : 's'}</li>`).join('');
    const moreNote = files.length < data.affectedCount
      ? `<li class="hint">…and ${data.affectedCount - files.length} more files</li>`
      : '';

    semPreviewBody.innerHTML = `
      <div class="semantic-preview-grid">
        <div>
          <strong>Keep:</strong> <code>${escapeHtml(data.keepPath)}</code>
        </div>
        <div>
          <strong>Delete:</strong> <code>${escapeHtml(data.removePath)}</code>
        </div>
        <div>
          <strong>Link rewrites:</strong> ${data.totalLinksRewritten} across ${data.affectedCount} file${data.affectedCount === 1 ? '' : 's'}
        </div>
      </div>
      ${files.length ? `<h4 style="margin-top:14px">Files that will be updated</h4><ul class="semantic-preview-files">${fileRows}${moreNote}</ul>` : ''}
      <h4 style="margin-top:14px">Merged content preview (first 4 KB)</h4>
      <pre class="semantic-preview-merged">${escapeHtml(data.mergedPreview || '')}${data.mergedLength > 4000 ? '\n…(truncated)' : ''}</pre>
    `;

    _semPreviewedPairs.add(card.dataset.key);
    _semCurrentPreview = { card, pair };
    const mergeBtn = card.querySelector('.semantic-merge-btn');
    mergeBtn.disabled = false;
  } catch (err) {
    semPreviewBody.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
  }
}

function closeMergePreview() {
  semPreviewModal.classList.add('hidden');
  semMergeConfirm.style.display = '';
  _semCurrentPreview = null;
}

semMergeCancel?.addEventListener('click', closeMergePreview);
// The confirm button inside the preview modal triggers the merge immediately
semMergeConfirm?.addEventListener('click', async () => {
  if (!_semCurrentPreview) return;
  const { card, pair } = _semCurrentPreview;
  semMergeConfirm.disabled = true;
  semMergeConfirm.textContent = 'Merging…';
  try {
    const r = await fetch(`/api/health/${encodeURIComponent(_healthDomain)}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'semanticDupe', issue: pair }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Merge failed');
    if (!data.fixed) throw new Error('Server rejected merge (validation failed)');
    card.classList.add('semantic-pair-merged');
    card.innerHTML = `<div class="hint">✓ Merged. <code>[[${escapeHtml(pair.removeSlug)}]]</code> → <code>[[${escapeHtml(pair.keepSlug)}]]</code></div>`;
    closeMergePreview();
    showStatus(healthStatusEl, 'success', `Merged ${pair.removeSlug} → ${pair.keepSlug}`);
  } catch (err) {
    showStatus(healthStatusEl, 'error', err.message);
  } finally {
    semMergeConfirm.disabled = false;
    semMergeConfirm.textContent = 'Merge and delete duplicate';
  }
});

function openMergeConfirm(card, pair) {
  // If user clicked the enabled Merge button (already previewed), jump straight
  // into the preview modal in a "confirm" state. We reuse the same modal so
  // the user always sees what will change.
  openMergePreview(card, pair);
}

// ── Bulk AI broken-link fix (v3.0.1-beta.16) ──────────────────────────────────
// Flow: button → confirm (cost estimate) → plan (SSE, read-only) → preview
// summary → Apply (SSE, writes). Revertable from the Sync tab.

const blBtn         = document.getElementById('broken-links-ai-btn');
const blStatus      = document.getElementById('broken-links-ai-status');
const blProgress    = document.getElementById('broken-links-ai-progress');
const blResults     = document.getElementById('broken-links-ai-results');
const blConfirmModal = document.getElementById('broken-links-ai-confirm');
const blEstimateEl  = document.getElementById('broken-links-ai-estimate');
const blCancelBtn   = document.getElementById('broken-links-ai-cancel');
const blConfirmBtn  = document.getElementById('broken-links-ai-confirm-btn');

let _blPlan = null;        // the plan returned from /broken-links/plan
let _blBusy = false;

async function startBrokenLinkFix() {
  if (!_healthDomain) { showStatus(healthStatusEl, 'error', 'Run Scan first so a domain is selected.'); return; }
  if (blStatus) blStatus.textContent = 'Estimating…';
  try {
    const r = await fetch(`/api/health/${encodeURIComponent(_healthDomain)}/broken-links/estimate`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Estimate failed');
    openBrokenLinkConfirm(data);
    if (blStatus) blStatus.textContent = '';
  } catch (err) {
    if (blStatus) blStatus.textContent = '';
    showStatus(healthStatusEl, 'error', err.message);
  }
}
blBtn?.addEventListener('click', startBrokenLinkFix);

function openBrokenLinkConfirm(est) {
  const costStr = est.estimatedUsd != null
    ? `$${est.estimatedUsd.toFixed(4)} on ${est.provider}/${est.model}`
    : 'cost unknown';
  blEstimateEl.innerHTML = `
    <div class="semantic-dupes-estimate-row"><strong>Broken links:</strong> ${est.totalOccurrences.toLocaleString()} (${est.uniqueTargets.toLocaleString()} unique targets)</div>
    <div class="semantic-dupes-estimate-row"><strong>Fix for free (formatting):</strong> ${est.resolveFree.toLocaleString()}</div>
    <div class="semantic-dupes-estimate-row"><strong>Need AI judgment:</strong> ${est.needAi.toLocaleString()}</div>
    <div class="semantic-dupes-estimate-row"><strong>Estimated cost:</strong> ${escapeHtml(costStr)}</div>
  `;
  blConfirmBtn.disabled = est.totalOccurrences === 0;
  blConfirmModal.classList.remove('hidden');
}

blCancelBtn?.addEventListener('click', () => blConfirmModal.classList.add('hidden'));
blConfirmBtn?.addEventListener('click', () => {
  blConfirmModal.classList.add('hidden');
  runBrokenLinkPlan();
});

async function runBrokenLinkPlan() {
  if (_blBusy) return;
  _blBusy = true;
  _blPlan = null;
  const _blSec = document.getElementById('broken-links-ai-section');
  _blSec?.classList.remove('hidden');
  _blSec?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  blResults.innerHTML = '';
  blProgress.classList.remove('hidden');
  const fill = blProgress.querySelector('.semantic-dupes-progress-fill');
  const text = blProgress.querySelector('.semantic-dupes-progress-text');
  fill.style.width = '2%';
  text.textContent = 'Planning…';
  blBtn.disabled = true;

  try {
    const r = await fetch(`/api/health/${encodeURIComponent(_healthDomain)}/broken-links/plan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `Plan failed (HTTP ${r.status})`); }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, nl); buffer = buffer.slice(nl + 2);
        const dl = chunk.split('\n').find(l => l.startsWith('data: '));
        if (!dl) continue;
        let ev; try { ev = JSON.parse(dl.slice(6)); } catch { continue; }
        if (ev.type === 'start') {
          text.textContent = ev.needAi > 0 ? `Asking AI about ${ev.needAi} links in ${ev.batches} batches…` : 'Resolving…';
        } else if (ev.type === 'progress') {
          const pct = ev.total > 0 ? (ev.processed / ev.total) * 100 : 100;
          fill.style.width = `${Math.max(2, Math.round(pct))}%`;
          text.textContent = `${ev.processed} / ${ev.total} links analysed…`;
        } else if (ev.type === 'batch-error') {
          console.warn('[broken-links plan] batch error:', ev.error);
        } else if (ev.type === 'error') {
          throw new Error(ev.error || 'Plan error');
        } else if (ev.type === 'done') {
          fill.style.width = '100%';
          _blPlan = ev.plan;
          renderBrokenLinkPreview(ev.summary, ev.cost);
        }
      }
    }
  } catch (err) {
    text.textContent = 'Error';
    showStatus(healthStatusEl, 'error', err.message);
  } finally {
    blBtn.disabled = false;
    _blBusy = false;
  }
}

function renderBrokenLinkPreview(summary, cost) {
  blProgress.classList.add('hidden');
  const usd = cost && cost.estimatedUsd != null ? `$${cost.estimatedUsd.toFixed(4)}` : '';
  const retargetSamples = (_blPlan || []).filter(p => p.action === 'retarget').slice(0, 12);
  const stripSamples = (_blPlan || []).filter(p => p.action === 'strip').slice(0, 12);
  const sampleRow = (p) => p.action === 'retarget'
    ? `<li><code>[[${escapeHtml(p.linkText)}]]</code> → <code>[[${escapeHtml(p.target)}]]</code> <span class="hint">${p.occurrences}×</span></li>`
    : `<li><code>[[${escapeHtml(p.linkText)}]]</code> → <span class="hint">remove brackets · ${p.occurrences}×</span></li>`;

  blResults.innerHTML = `
    <div class="semantic-batch-bar" style="flex-direction:column; align-items:stretch">
      <div>
        <strong>Plan ready.</strong> ${summary.retargetOccurrences.toLocaleString()} link${summary.retargetOccurrences === 1 ? '' : 's'} will be
        repointed to a real page (${summary.retarget} unique), and ${summary.stripOccurrences.toLocaleString()} will have their brackets removed
        (${summary.strip} unique). ${usd ? `Planning cost: ${usd}.` : ''}
        <span class="hint">${summary.deterministic} fixed by formatting rules, ${summary.ai} judged by AI.</span>
      </div>
      <div class="broken-links-preview-cols">
        <div>
          <h4>Repointed to a real page (${summary.retarget})</h4>
          <ul class="semantic-preview-files">${retargetSamples.map(sampleRow).join('') || '<li class="hint">none</li>'}${summary.retarget > retargetSamples.length ? `<li class="hint">…and ${summary.retarget - retargetSamples.length} more</li>` : ''}</ul>
        </div>
        <div>
          <h4>Brackets removed — no real page (${summary.strip})</h4>
          <ul class="semantic-preview-files">${stripSamples.map(sampleRow).join('') || '<li class="hint">none</li>'}${summary.strip > stripSamples.length ? `<li class="hint">…and ${summary.strip - stripSamples.length} more</li>` : ''}</ul>
        </div>
      </div>
      <div class="semantic-batch-confirm-actions">
        <button class="btn primary broken-links-apply-btn">Apply — fix ${(summary.retargetOccurrences + summary.stripOccurrences).toLocaleString()} broken links</button>
        <button class="btn broken-links-cancel-btn">Cancel</button>
      </div>
      <span class="hint">All changes are git-tracked — if anything looks wrong, revert from the Sync tab before pushing.</span>
    </div>
  `;
  blResults.querySelector('.broken-links-apply-btn').addEventListener('click', () => applyBrokenLinkPlan());
  blResults.querySelector('.broken-links-cancel-btn').addEventListener('click', () => { blResults.innerHTML = ''; _blPlan = null; });
}

async function applyBrokenLinkPlan() {
  if (_blBusy || !_blPlan || !_blPlan.length) return;
  _blBusy = true;
  blResults.innerHTML = `<div class="semantic-batch-bar"><div class="semantic-batch-progress"><span class="spinner"></span> <span class="bl-apply-text">Applying…</span></div></div>`;
  const applyText = blResults.querySelector('.bl-apply-text');
  try {
    // Send only the fields the apply endpoint needs (linkText/action/target) —
    // not occurrences/sourceFiles/confidence/source — so even a 1000+ entry plan
    // stays a small request body (avoids HTTP 413 on large domains).
    const slimPlan = _blPlan.map(p => ({ linkText: p.linkText, action: p.action, target: p.target }));
    const r = await fetch(`/api/health/${encodeURIComponent(_healthDomain)}/broken-links/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: slimPlan }),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `Apply failed (HTTP ${r.status})`); }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let summary = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, nl); buffer = buffer.slice(nl + 2);
        const dl = chunk.split('\n').find(l => l.startsWith('data: '));
        if (!dl) continue;
        let ev; try { ev = JSON.parse(dl.slice(6)); } catch { continue; }
        if (ev.type === 'progress' && applyText) applyText.textContent = `Applying… ${ev.done}/${ev.total} pages`;
        else if (ev.type === 'done') summary = ev;
        else if (ev.type === 'error') throw new Error(ev.error || 'Apply error');
      }
    }
    if (summary) {
      blResults.innerHTML = `<div class="semantic-batch-bar"><div class="hint">✓ Done — ${summary.retargeted.toLocaleString()} repointed, ${summary.stripped.toLocaleString()} brackets removed across ${summary.filesChanged.toLocaleString()} pages. Re-scan to confirm, then push from the <strong>Sync</strong> tab.</div></div>`;
      showStatus(healthStatusEl, 'success', `Fixed ${summary.retargeted + summary.stripped} broken links.`);
      refreshSyncPendingBadge?.();
      // Auto re-scan so the broken-link count updates (reads the domain dropdown).
      setTimeout(() => runHealthScan(), 400);
    } else {
      blResults.innerHTML = `<div class="hint">Done.</div>`;
    }
  } catch (err) {
    blResults.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
    showStatus(healthStatusEl, 'error', err.message);
  } finally {
    _blBusy = false;
    _blPlan = null;
  }
}

// ── Fix all safe (deterministic) issues — one click (v3.0.1-beta.17) ──────────
let _fixSafeBusy = false;
async function runFixAllSafe(btn) {
  if (_fixSafeBusy || !_healthDomain) return;
  _fixSafeBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Fixing…'; }
  showStatus(healthStatusEl, 'info', 'Fixing safe issues…');
  let fixedOk = false;
  try {
    const r = await fetch(`/api/health/${encodeURIComponent(_healthDomain)}/fix-all-safe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Fix failed');
    showStatus(healthStatusEl, 'success', `Fixed ${data.fixed} of ${data.total} safe issue${data.total === 1 ? '' : 's'}.`);
    refreshSyncPendingBadge?.();
    fixedOk = true;
  } catch (err) {
    showStatus(healthStatusEl, 'error', err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
  } finally {
    _fixSafeBusy = false;
  }
  // Re-scan OUTSIDE the fix try/catch so a scan hiccup can't be reported as a
  // "fix failed" error (audit H2). The scan re-renders the action bar fresh.
  if (fixedOk) { try { await runHealthScan(); } catch { /* scan errors surface via runHealthScan itself */ } }
}

// ── Bulk AI orphan rescue (v3.0.1-beta.17) ────────────────────────────────────
// Flow mirrors the broken-link fixer: confirm (estimate) → plan (SSE) → preview
// → apply (SSE). Apply injects a Related link from each orphan's best "home".

const orphProgress    = document.getElementById('orphans-ai-progress');
const orphResults     = document.getElementById('orphans-ai-results');
const orphConfirmModal = document.getElementById('orphans-ai-confirm');
const orphEstimateEl  = document.getElementById('orphans-ai-estimate');
const orphCancelBtn   = document.getElementById('orphans-ai-cancel');
const orphConfirmBtn  = document.getElementById('orphans-ai-confirm-btn');

let _orphPlan = null;
let _orphBusy = false;

async function startOrphanRescue() {
  if (!_healthDomain) { showStatus(healthStatusEl, 'error', 'Run Scan first so a domain is selected.'); return; }
  try {
    const r = await fetch(`/api/health/${encodeURIComponent(_healthDomain)}/orphans/estimate`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Estimate failed');
    openOrphanConfirm(data);
  } catch (err) {
    showStatus(healthStatusEl, 'error', err.message);
  }
}

function openOrphanConfirm(est) {
  const costStr = est.estimatedUsd != null ? `$${est.estimatedUsd.toFixed(4)} on ${est.provider}/${est.model}` : 'cost unknown';
  orphEstimateEl.innerHTML = `
    <div class="semantic-dupes-estimate-row"><strong>Orphan pages:</strong> ${est.orphanCount.toLocaleString()}</div>
    <div class="semantic-dupes-estimate-row"><strong>Estimated cost:</strong> ${escapeHtml(costStr)}</div>
  `;
  orphConfirmBtn.disabled = est.orphanCount === 0;
  orphConfirmModal.classList.remove('hidden');
}

orphCancelBtn?.addEventListener('click', () => orphConfirmModal.classList.add('hidden'));
orphConfirmBtn?.addEventListener('click', () => { orphConfirmModal.classList.add('hidden'); runOrphanPlan(); });

async function runOrphanPlan() {
  if (_orphBusy) return;
  _orphBusy = true;
  _orphPlan = null;
  const _orphSec = document.getElementById('orphans-ai-section');
  _orphSec?.classList.remove('hidden');
  _orphSec?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  orphResults.innerHTML = '';
  orphProgress.classList.remove('hidden');
  const fill = orphProgress.querySelector('.semantic-dupes-progress-fill');
  const text = orphProgress.querySelector('.semantic-dupes-progress-text');
  fill.style.width = '2%';
  text.textContent = 'Planning…';
  try {
    const r = await fetch(`/api/health/${encodeURIComponent(_healthDomain)}/orphans/plan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `Plan failed (HTTP ${r.status})`); }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, nl); buffer = buffer.slice(nl + 2);
        const dl = chunk.split('\n').find(l => l.startsWith('data: '));
        if (!dl) continue;
        let ev; try { ev = JSON.parse(dl.slice(6)); } catch { continue; }
        if (ev.type === 'start') text.textContent = `Finding homes for ${ev.orphans} orphans in ${ev.batches} batches…`;
        else if (ev.type === 'progress') { const pct = ev.total > 0 ? (ev.processed / ev.total) * 100 : 100; fill.style.width = `${Math.max(2, Math.round(pct))}%`; text.textContent = `${ev.processed} / ${ev.total} orphans analysed…`; }
        else if (ev.type === 'error') throw new Error(ev.error || 'Plan error');
        else if (ev.type === 'done') { fill.style.width = '100%'; _orphPlan = ev.plan; renderOrphanPreview(ev.summary, ev.cost); }
      }
    }
  } catch (err) {
    text.textContent = 'Error';
    showStatus(healthStatusEl, 'error', err.message);
  } finally {
    _orphBusy = false;
  }
}

function renderOrphanPreview(summary, cost) {
  orphProgress.classList.add('hidden');
  const usd = cost && cost.estimatedUsd != null ? `$${cost.estimatedUsd.toFixed(4)}` : '';
  const samples = (_orphPlan || []).slice(0, 18);
  const row = (p) => `<li><code>[[${escapeHtml(p.orphanSlug)}]]</code> → linked from <code>[[${escapeHtml(p.target)}]]</code> <span class="hint">${escapeHtml(p.description || '')}</span></li>`;
  if (!summary.rescuable) {
    orphResults.innerHTML = `<div class="semantic-batch-bar"><div class="hint">The AI found no confident home for any of the ${summary.orphans} orphans. They're left as-is for manual review (try the per-orphan <strong>✨ Ask AI</strong> in the Orphans section below).</div></div>`;
    return;
  }
  orphResults.innerHTML = `
    <div class="semantic-batch-bar" style="flex-direction:column; align-items:stretch">
      <div><strong>Plan ready.</strong> ${summary.rescuable} of ${summary.orphans} orphan${summary.orphans === 1 ? '' : 's'} will get an incoming link from a related page${summary.noHome ? `; ${summary.noHome} had no confident home and are left for manual review` : ''}. ${usd ? `Planning cost: ${usd}.` : ''}</div>
      <ul class="semantic-preview-files" style="max-height:260px">${samples.map(row).join('')}${summary.rescuable > samples.length ? `<li class="hint">…and ${summary.rescuable - samples.length} more</li>` : ''}</ul>
      <div class="semantic-batch-confirm-actions">
        <button class="btn primary orph-apply-btn">Apply — rescue ${summary.rescuable} orphan${summary.rescuable === 1 ? '' : 's'}</button>
        <button class="btn orph-cancel-btn">Cancel</button>
      </div>
      <span class="hint">Git-tracked — revert from the Sync tab if anything looks wrong.</span>
    </div>
  `;
  orphResults.querySelector('.orph-apply-btn').addEventListener('click', () => applyOrphanPlan());
  orphResults.querySelector('.orph-cancel-btn').addEventListener('click', () => { orphResults.innerHTML = ''; _orphPlan = null; });
}

async function applyOrphanPlan() {
  if (_orphBusy || !_orphPlan || !_orphPlan.length) return;
  _orphBusy = true;
  orphResults.innerHTML = `<div class="semantic-batch-bar"><div class="semantic-batch-progress"><span class="spinner"></span> <span class="orph-apply-text">Applying…</span></div></div>`;
  const applyText = orphResults.querySelector('.orph-apply-text');
  try {
    // Slim payload — apply only needs orphanSlug/target/description.
    const slimPlan = _orphPlan.map(p => ({ orphanSlug: p.orphanSlug, target: p.target, description: p.description }));
    const r = await fetch(`/api/health/${encodeURIComponent(_healthDomain)}/orphans/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: slimPlan }),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `Apply failed (HTTP ${r.status})`); }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let summary = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, nl); buffer = buffer.slice(nl + 2);
        const dl = chunk.split('\n').find(l => l.startsWith('data: '));
        if (!dl) continue;
        let ev; try { ev = JSON.parse(dl.slice(6)); } catch { continue; }
        if (ev.type === 'progress' && applyText) applyText.textContent = `Applying… ${ev.done}/${ev.total}`;
        else if (ev.type === 'done') summary = ev;
        else if (ev.type === 'error') throw new Error(ev.error || 'Apply error');
      }
    }
    if (summary) {
      orphResults.innerHTML = `<div class="semantic-batch-bar"><div class="hint">✓ Done — rescued ${summary.rescued.toLocaleString()} orphan${summary.rescued === 1 ? '' : 's'}${summary.skipped ? `, ${summary.skipped} skipped` : ''}. Re-scan to confirm, then push from the <strong>Sync</strong> tab.</div></div>`;
      showStatus(healthStatusEl, 'success', `Rescued ${summary.rescued} orphan${summary.rescued === 1 ? '' : 's'}.`);
      refreshSyncPendingBadge?.();
      setTimeout(() => runHealthScan(), 400);
    } else {
      orphResults.innerHTML = `<div class="hint">Done.</div>`;
    }
  } catch (err) {
    orphResults.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
    showStatus(healthStatusEl, 'error', err.message);
  } finally {
    _orphBusy = false;
    _orphPlan = null;
  }
}

// ── Boot sentinel ─────────────────────────────────────────────────────────────
// MUST stay the last statement in this file. The boot guard in index.html treats
// "this flag is still false at DOMContentLoaded" as proof that the module threw
// during evaluation (one bad getElementById at the top is enough to blank the
// whole page), and renders a visible recovery panel instead of leaving the user
// with an empty window. It also switches the global error/unhandledrejection
// handlers from "fatal" to "log and ignore", so ordinary post-boot failures —
// a background poll's fetch rejecting, say — never trigger that panel.
window.__curatorBooted = true;
