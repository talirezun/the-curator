// ── Version badge ─────────────────────────────────────────────────────────────
fetch('/api/version')
  .then(r => r.json())
  .then(({ version }) => {
    const el = document.getElementById('app-version');
    if (el) el.textContent = `v${version}`;
  })
  .catch(() => {}); // non-critical — silently skip if unavailable

// ── Stop server ───────────────────────────────────────────────────────────────
document.getElementById('stop-btn').addEventListener('click', async () => {
  const btn = document.getElementById('stop-btn');
  btn.disabled = true;
  btn.innerHTML = '<span style="opacity:.6">Stopping…</span>';
  try {
    await fetch('/api/shutdown', { method: 'POST' });
  } catch {
    // Expected — the server closes before it can finish the response
  }
  btn.innerHTML = '✓ Stopped';
  document.body.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100vh;gap:16px;font-family:system-ui;color:#e2e8f0;background:#0f1117;">
      <div style="font-size:48px;">🧠</div>
      <div style="font-size:20px;font-weight:600;">Second Brain stopped</div>
      <div style="font-size:14px;color:#64748b;">Click the app icon to start it again.</div>
    </div>`;
});

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
  });
});

// ── Domain loading ─────────────────────────────────────────────────────────────
const domainSelects = ['ingest-domain', 'wiki-domain'];

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
      showStatus(statusEl, 'success',
        `✓ Synced ${data.changesCount} change${data.changesCount !== 1 ? 's' : ''} to GitHub.`);
    } else {
      showStatus(statusEl, 'success', `✓ ${data.message}`);
    }
    // Refresh status
    const s = await fetch('/api/sync/status').then(r => r.json());
    renderSyncConfigured(s);
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

    showStatus(statusEl, 'success',
      '✓ Pulled successfully. Reload the Wiki or Chat tab to see updated content.');
    const s = await fetch('/api/sync/status').then(r => r.json());
    renderSyncConfigured(s);
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

let domainsTabInitialised = false;

document.querySelector('[data-tab="domains"]').addEventListener('click', () => {
  if (!domainsTabInitialised) {
    domainsTabInitialised = true;
    loadDomainList();
  }
});

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
