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
  });
});

// ── Domain loading ─────────────────────────────────────────────────────────────
const domainSelects = ['ingest-domain', 'wiki-domain', 'health-domain'];

async function loadDomains() {
  const res = await fetch('/api/domains');
  const { domains } = await res.json();
  domainSelects.forEach(id => {
    const el = document.getElementById(id);
    el.innerHTML = domains
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
  ingestBtn.disabled = false;
  hideEl(ingestStatus);
  hideEl(ingestResult);
}

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  setFile(e.dataTransfer.files[0]);
});
// Open file picker when clicking anywhere on the drop zone,
// but skip if the click came from the <label> inside — that
// already triggers the input natively via its `for` attribute,
// so calling fileInput.click() again would open the picker twice.
dropZone.addEventListener('click', (e) => {
  if (e.target.closest('label')) return;
  fileInput.click();
});
fileInput.addEventListener('change', () => setFile(fileInput.files[0]));

ingestBtn.addEventListener('click', () => submitIngest(false));

// ── Progress bar helpers ───────────────────────────────────────────────────
const ingestProgress = document.getElementById('ingest-progress');
const progressFill   = document.getElementById('progress-fill');
const progressLabel  = document.getElementById('progress-label');
const progressPct    = document.getElementById('progress-pct');

function showProgress(pct, label, waiting = false) {
  ingestProgress.classList.remove('hidden');
  progressFill.style.width = pct + '%';
  progressFill.classList.toggle('waiting', waiting);
  progressLabel.textContent = label;
  progressPct.textContent = pct + '%';
}

function hideProgress() {
  ingestProgress.classList.add('hidden');
  progressFill.style.width = '0%';
  progressFill.classList.remove('waiting');
}

async function submitIngest(overwrite) {
  if (!selectedFile) return;

  const domain = document.getElementById('ingest-domain').value;
  ingestBtn.disabled = true;
  hideEl(ingestResult);
  hideEl(ingestStatus);
  hideDuplicateBanner();
  showProgress(2, 'Starting…');

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

  } catch (err) {
    hideProgress();
    showStatus(ingestStatus, 'error', err.message);
    ingestBtn.disabled = false;
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
    ingestBtn.disabled = false;
  });
}

function hideDuplicateBanner() {
  const banner = document.getElementById('duplicate-banner');
  if (banner) banner.remove();
}

function showIngestResult(data) {
  const label = data.wasOverwrite ? 'Re-ingested &amp; updated:' : 'Ingested:';
  ingestResult.innerHTML = `
    <h3>${label} ${escHtml(data.title)}</h3>
    <ul>
      ${data.pagesWritten.map(p => `<li><span>${escHtml(p)}</span></li>`).join('')}
    </ul>
  `;
  showEl(ingestResult);
}

// ── CHAT TAB ──────────────────────────────────────────────────────────────────
const chatDomainEl   = document.getElementById('chat-domain');
const newChatBtn     = document.getElementById('new-chat-btn');
const convListEl     = document.getElementById('conversation-list');
const chatEmptyEl    = document.getElementById('chat-empty');
const chatThreadEl   = document.getElementById('chat-thread');
const chatInputEl    = document.getElementById('chat-input');
const chatSendBtn    = document.getElementById('chat-send-btn');

let activeConvId   = null;   // currently open conversation ID
let chatDomain     = null;   // currently selected domain
let chatBusy       = false;  // prevents double-sends

// ── Domain selector ───────────────────────────────────────────────────────────
async function loadChatDomains() {
  const res = await fetch('/api/domains');
  const { domains } = await res.json();
  chatDomainEl.innerHTML = domains
    .map(d => `<option value="${d}">${formatDomain(d)}</option>`)
    .join('');
  if (domains.length) {
    chatDomain = domains[0];
    await refreshConversationList();
  }
}

chatDomainEl.addEventListener('change', async () => {
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

  renderThread(conv.messages);
  highlightActiveConv(id);
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
  chatThreadEl.innerHTML = '';
}

function renderThread(messages) {
  hideEl(chatEmptyEl);
  showEl(chatThreadEl);
  chatThreadEl.innerHTML = '';
  for (const msg of messages) appendMessage(msg.role, msg.content, msg.citations || []);
  chatThreadEl.scrollTop = chatThreadEl.scrollHeight;
}

function appendMessage(role, content, citations = []) {
  hideEl(chatEmptyEl);
  showEl(chatThreadEl);

  const formatted = escHtml(content).replace(
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
newChatBtn.addEventListener('click', () => {
  activeConvId = null;
  showChatEmpty();
  highlightActiveConv(null);
  chatInputEl.focus();
});

chatInputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    chatSendBtn.click();
  }
});

// Auto-grow textarea
chatInputEl.addEventListener('input', () => {
  chatInputEl.style.height = 'auto';
  chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 160) + 'px';
});

chatSendBtn.addEventListener('click', async () => {
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
      body: JSON.stringify({ message, conversationId: activeConvId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Chat failed');

    spinner.remove();
    appendMessage('assistant', data.answer, data.citations);

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
document.querySelector('[data-tab="sync"]').addEventListener('click', () => {
  if (!syncTabInitialised) {
    syncTabInitialised = true;
    initSyncTab();
  }
});

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
}

// ── Sync Up ───────────────────────────────────────────────────────────────────
document.getElementById('sync-push-btn').addEventListener('click', async () => {
  const btn = document.getElementById('sync-push-btn');
  const statusEl = document.getElementById('sync-op-status');
  btn.disabled = true;
  showStatus(statusEl, 'loading', 'Syncing up — pushing your changes to GitHub…');

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

// ── Sync Down ─────────────────────────────────────────────────────────────────
document.getElementById('sync-pull-btn').addEventListener('click', async () => {
  const btn = document.getElementById('sync-pull-btn');
  const statusEl = document.getElementById('sync-op-status');
  btn.disabled = true;
  showStatus(statusEl, 'loading', 'Syncing down — pulling latest changes from GitHub…');

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

// ── Bidirectional Sync ────────────────────────────────────────────────────────
document.getElementById('sync-both-btn').addEventListener('click', async () => {
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
document.getElementById('sync-disconnect-btn').addEventListener('click', async () => {
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
document.getElementById('open-wizard-btn').addEventListener('click', () => {
  hideEl(syncLanding);
  showEl(syncWizard);
  showWizardStep(syncStep1);
  setProgressStep(1);
  syncRepoUrlInput.value = wizardRepoUrl;
  syncTokenInput.value   = wizardToken;
});

// ── Wizard: Step 1 → Step 2 ───────────────────────────────────────────────────
document.getElementById('wizard-next-1').addEventListener('click', () => {
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

document.getElementById('wizard-back-1').addEventListener('click', () => {
  showSyncLanding();
});

// ── Wizard: Token show/hide ───────────────────────────────────────────────────
document.getElementById('sync-token-toggle').addEventListener('click', () => {
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
document.getElementById('wizard-next-2').addEventListener('click', () => {
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

document.getElementById('wizard-back-2').addEventListener('click', () => {
  showWizardStep(syncStep1);
  setProgressStep(1);
});

document.getElementById('wizard-back-3').addEventListener('click', () => {
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
    document.getElementById('sync-error-msg').textContent = err.message;
    showWizardStep(syncError);
  }
}

// ── Error recovery ────────────────────────────────────────────────────────────
document.getElementById('sync-try-again').addEventListener('click', () => {
  showWizardStep(syncStep1);
  setProgressStep(1);
});

document.getElementById('sync-retry-same').addEventListener('click', () => {
  submitSyncSetup(wizardLastMode);
});

// ── WIKI TAB ──────────────────────────────────────────────────────────────────
const wikiLoadBtn = document.getElementById('wiki-load-btn');
const wikiBrowser = document.getElementById('wiki-browser');
const wikiSidebar = document.getElementById('wiki-sidebar');
const wikiContent = document.getElementById('wiki-content');
const wikiEmpty = document.getElementById('wiki-empty');

wikiLoadBtn.addEventListener('click', loadWiki);

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

    this.btn.addEventListener('click', e => { e.stopPropagation(); this.toggle(); });
    document.addEventListener('click', () => this.close());

    this.refresh();
  }

  refresh() {
    const opts    = Array.from(this.native.options);
    const selOpt  = opts[this.native.selectedIndex] || opts[0];

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

  toggle() { this.isOpen ? this.close() : this.open(); }

  open() {
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
    new MutationObserver(() => this.refresh())
      .observe(this.native, { childList: true, subtree: true });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showEl(el) { el.classList.remove('hidden'); }
function hideEl(el) { el.classList.add('hidden'); }

function showStatus(el, type, msg) {
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

document.querySelector('[data-tab="domains"]').addEventListener('click', () => {
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
        showStatus(statusEl, 'success', `✓ Renamed to "${newName}". Since sync is configured, run Sync Up soon to reflect this on GitHub.`);
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
      noteEl.textContent = 'This domain will also be removed from GitHub on the next Sync Up.';
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

newDomainBtn.addEventListener('click', () => {
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

document.getElementById('nd-cancel-btn').addEventListener('click', () => {
  hideEl(newDomainForm);
});

ndDisplayName.addEventListener('input', () => {
  const slug = clientGenerateSlug(ndDisplayName.value);
  ndSlugPreview.textContent = slug ? `Folder: domains/${slug}/` : '';
});

templateGrid.querySelectorAll('.template-card').forEach(card => {
  card.addEventListener('click', () => {
    templateGrid.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedTemplate = card.dataset.template;
  });
});

ndCreateBtn.addEventListener('click', async () => {
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
}

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

    // Surface model-lifecycle fallback when the provider has retired the
    // pinned default and we auto-recovered onto the next model in the chain.
    // Rendered as an amber callout just below the provider badge — tells the
    // user exactly which model is in use and nudges them to Check for Updates.
    renderFallbackBanner(data.fallback);
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
  el.innerHTML =
    `<strong>⚠ Using fallback model.</strong> ${providerLabel}'s <code>${escapeHtml(fallback.requestedModel)}</code> ` +
    `is unavailable; currently running on <code>${escapeHtml(fallback.usingModel)}</code>. ` +
    `Open <strong>Check for Updates</strong> above to pull the latest Curator with an updated default model.`;
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
      status.innerHTML = `
        <span style="color:var(--warning)">
          <strong>Files are updated (v${versionInfo.onDiskVersion})</strong>
          but the running app is still v${versionInfo.version}.
          Please quit and relaunch The Curator — right-click the Dock icon → Quit, then re-open the .app.
        </span>`;
      status.className = 'status';
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
}

document.getElementById('health-scan-btn')?.addEventListener('click', () => runHealthScan());

async function runHealthScan() {
  const domain = document.getElementById('health-domain').value;
  if (!domain) {
    showStatus(healthStatusEl, 'error', 'Select a domain first.');
    return;
  }
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

function renderHealthReport(report) {
  const total =
    report.brokenLinks.length +
    report.orphans.length +
    report.folderPrefixLinks.length +
    report.crossFolderDupes.length +
    report.hyphenVariants.length +
    report.missingBacklinks.length;

  const counts = report.counts || { entities: 0, concepts: 0, summaries: 0 };
  healthSummaryEl.classList.remove('hidden');
  healthSummaryEl.innerHTML = `
    <div class="health-summary-head">
      <div class="health-summary-title">${total === 0 ? '✅ Wiki is clean' : `Found ${total} issue${total === 1 ? '' : 's'}`}</div>
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
  `;

  healthSectionsEl.classList.remove('hidden');
  healthSectionsEl.innerHTML = HEALTH_ORDER.map(type => renderSection(report, type)).join('');

  // Wire up fix buttons
  healthSectionsEl.querySelectorAll('[data-fix-all]').forEach(btn => {
    btn.addEventListener('click', () => fixAll(report.domain, btn.dataset.fixAll, btn));
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

  const rows = issues.map((issue, idx) => {
    const description = describeIssue(type, issue);
    let trailing;
    if (canFixIssue(issue)) {
      trailing = `<button class="btn btn-sm health-fix-btn" data-fix-one="${type}" data-issue='${escapeAttr(JSON.stringify(issue))}'>${btnLabel}</button>`;
    } else if (type === 'brokenLinks' && _aiAvailable) {
      // Review-only broken link + AI available → offer AI suggestion
      trailing =
        `<button class="btn btn-sm health-ai-btn" data-ai-suggest="brokenLinks" data-issue='${escapeAttr(JSON.stringify(issue))}' data-row-idx="${idx}">✨ Ask AI</button>` +
        `<span class="health-review-tag">Review</span>`;
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

  return `
    <details class="health-section" open>
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

  // Render the inline result block beneath the issue description
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

  // Insert a child block under the description; replace actions with Apply/Skip
  let aiBlock = row.querySelector('.health-ai-result');
  if (!aiBlock) {
    aiBlock = document.createElement('div');
    aiBlock.className = 'health-ai-result';
    desc.insertAdjacentElement('afterend', aiBlock);
  }
  aiBlock.innerHTML = body;

  if (canApply) {
    actions.innerHTML =
      `<button class="btn btn-sm health-fix-btn health-ai-apply">Apply</button>` +
      `<button class="btn btn-sm health-ai-skip">Skip</button>`;
    const applyBtn = actions.querySelector('.health-ai-apply');
    const skipBtn  = actions.querySelector('.health-ai-skip');
    applyBtn.addEventListener('click', () => {
      const patched = { ...issue, suggestedTarget: result.target };
      fixOne(domain, 'brokenLinks', patched, applyBtn);
    });
    skipBtn.addEventListener('click', () => {
      aiBlock.remove();
      actions.innerHTML = `<span class="health-review-tag">Review</span>`;
    });
  } else {
    actions.innerHTML = `<span class="health-review-tag">Review</span>`;
  }
}
