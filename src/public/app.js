// ── Stop server ───────────────────────────────────────────────────────────────
document.getElementById('stop-btn').addEventListener('click', async () => {
  const btn = document.getElementById('stop-btn');
  btn.disabled = true;
  btn.textContent = 'Stopping…';
  try {
    await fetch('/api/shutdown', { method: 'POST' });
  } catch {
    // Expected — the server closes before it can finish the response
  }
  btn.textContent = '✓ Stopped';
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
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => setFile(fileInput.files[0]));

ingestBtn.addEventListener('click', () => submitIngest(false));

async function submitIngest(overwrite) {
  if (!selectedFile) return;

  const domain = document.getElementById('ingest-domain').value;
  ingestBtn.disabled = true;
  hideEl(ingestResult);
  hideDuplicateBanner();
  showStatus(ingestStatus, 'loading', 'Ingesting — Second Brain is reading your source and updating the wiki...');

  const formData = new FormData();
  formData.append('domain', domain);
  formData.append('file', selectedFile);
  if (overwrite) formData.append('overwrite', 'true');

  try {
    const res = await fetch('/api/ingest', { method: 'POST', body: formData });
    const data = await res.json();

    // ── Duplicate detected ──────────────────────────────────────────────────
    if (res.status === 409 && data.duplicate) {
      hideEl(ingestStatus);
      showDuplicateBanner(data.filename, domain);
      ingestBtn.disabled = false;
      return;
    }

    if (!res.ok) throw new Error(data.error || 'Ingest failed');

    hideEl(ingestStatus);
    showIngestResult(data);

    // Reset
    selectedFile = null;
    fileNameEl.textContent = '';
    fileInput.value = '';
    ingestBtn.disabled = true;
  } catch (err) {
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
loadDomains();
loadChatDomains();
