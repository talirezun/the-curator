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
const domainSelects = ['ingest-domain', 'query-domain', 'wiki-domain'];

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

ingestBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  const domain = document.getElementById('ingest-domain').value;
  ingestBtn.disabled = true;
  showStatus(ingestStatus, 'loading', 'Ingesting — Claude is reading your source and updating the wiki...');
  hideEl(ingestResult);

  const formData = new FormData();
  formData.append('domain', domain);
  formData.append('file', selectedFile);

  try {
    const res = await fetch('/api/ingest', { method: 'POST', body: formData });
    const data = await res.json();

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
});

function showIngestResult(data) {
  ingestResult.innerHTML = `
    <h3>Ingested: ${escHtml(data.title)}</h3>
    <ul>
      ${data.pagesWritten.map(p => `<li><span>${escHtml(p)}</span></li>`).join('')}
    </ul>
  `;
  showEl(ingestResult);
}

// ── QUERY TAB ─────────────────────────────────────────────────────────────────
const queryBtn = document.getElementById('query-btn');
const queryText = document.getElementById('query-text');
const queryStatus = document.getElementById('query-status');
const queryResult = document.getElementById('query-result');

queryText.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) queryBtn.click();
});

queryBtn.addEventListener('click', async () => {
  const domain = document.getElementById('query-domain').value;
  const question = queryText.value.trim();
  if (!question) return;

  queryBtn.disabled = true;
  showStatus(queryStatus, 'loading', 'Querying — Claude is reading the wiki and synthesizing an answer...');
  hideEl(queryResult);

  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, question }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Query failed');

    hideEl(queryStatus);
    showQueryResult(data);
  } catch (err) {
    showStatus(queryStatus, 'error', err.message);
  } finally {
    queryBtn.disabled = false;
  }
});

function showQueryResult({ answer, citations }) {
  const formattedAnswer = escHtml(answer).replace(
    /\[source:\s*([^\]]+)\]/g,
    (_, p) => `<span class="citation-tag">[source: ${escHtml(p)}]</span>`
  );

  queryResult.innerHTML = `
    <div class="answer-text">${formattedAnswer}</div>
    ${citations.length ? `
      <hr style="margin: 16px 0; border-color: var(--border);" />
      <h3>Sources</h3>
      <ul>${citations.map(c => `<li><span>${escHtml(c)}</span></li>`).join('')}</ul>
    ` : ''}
  `;
  showEl(queryResult);
}

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
