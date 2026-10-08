// Retired-model migration, browser half (2026-10-08).
//
// The Curator offers the current Anthropic generation and the one before it,
// and nothing older (src/brain/llm.js RETIRED_MODELS). A user whose saved pick
// names a retired model is moved FORWARD to the same family's newest model, and
// told once:
//
//   • the BUILD pick lives in .curator-config.json; the server moves it at
//     start and keeps the note until it is dismissed (GET/POST
//     /api/config/model-retirement[/dismiss]);
//   • the CHAT pick lives in this browser's localStorage
//     (`curator-next-chat-model`), so only this module can move it. It does so
//     from the same server-built map, and keeps its own note in localStorage
//     until the same Dismiss clears it.
//
// One banner shows both kinds of note. Dismiss removes them on both sides, so
// a note is shown until the user has seen and dismissed it, and never again.
// Every storage access is wrapped: a blocked storage partition must never stop
// boot() or the chat view (fail towards NOT migrating — the pick then resolves
// through the server's read-side successor map or the default, never errors).

export const LS_CHAT_MODEL = 'curator-next-chat-model';
export const LS_RETIREMENT_NOTES = 'curator-next-model-retirement-notes-v1';
const BANNER_ID = 'model-retirement-banner';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * PURE. The id a saved chat pick should become, and the note to show, given
 * the server's map `{ <oldId>: { successor, chatNote } }`. An id that is not
 * retired (or a malformed map) comes back unchanged with no note.
 */
export function migrateChatModelId(savedId, retired) {
  if (typeof savedId !== 'string' || !savedId) return { id: savedId, note: null };
  if (!retired || typeof retired !== 'object' || !Object.hasOwn(retired, savedId)) {
    return { id: savedId, note: null };
  }
  const r = retired[savedId];
  if (!r || typeof r.successor !== 'string' || !r.successor) return { id: savedId, note: null };
  return {
    id: r.successor,
    note: { lane: 'chat', from: savedId, to: r.successor, text: typeof r.chatNote === 'string' ? r.chatNote : '' },
  };
}

function readLocalNotes(storage) {
  try {
    const raw = storage.getItem(LS_RETIREMENT_NOTES);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(n => n && typeof n.text === 'string' && n.text) : [];
  } catch { return []; }
}

/**
 * Move this browser's remembered chat pick forward if it names a retired
 * model, and remember the note. Returns the id the caller should use (the
 * successor, or `savedId` unchanged). Idempotent: once moved, the stored id is
 * no longer retired, so a second call changes nothing and adds no note.
 */
export function migrateStoredChatModel(savedId, retired, storage = globalThis.localStorage) {
  const { id, note } = migrateChatModelId(savedId, retired);
  if (!note) return savedId;
  try {
    storage.setItem(LS_CHAT_MODEL, id);
    const notes = readLocalNotes(storage);
    if (!notes.some(n => n.from === note.from && n.to === note.to)) notes.push(note);
    storage.setItem(LS_RETIREMENT_NOTES, JSON.stringify(notes));
  } catch { /* nothing persisted — the id is still moved for this session */ }
  try { renderModelRetirementBanner(); } catch { /* no shell to draw in */ }
  return id;
}

let serverNotes = [];

/** Every note not yet dismissed: the server's (build pick) and this browser's (chat pick). */
export function pendingRetirementNotes(storage = globalThis.localStorage) {
  return [...serverNotes, ...(storage ? readLocalNotes(storage) : [])];
}

/** Dismiss: clear both sides so the note never comes back. */
export async function dismissRetirementNotes(storage = globalThis.localStorage) {
  serverNotes = [];
  try { storage.removeItem(LS_RETIREMENT_NOTES); } catch { /* nothing to clear */ }
  const el = typeof document !== 'undefined' ? document.getElementById(BANNER_ID) : null;
  if (el) el.remove();
  try { await fetch('/api/config/model-retirement/dismiss', { method: 'POST' }); } catch { /* shown again next boot; harmless */ }
}

/** Draw (or remove) the banner above the view, the same place the instance banner sits. */
export function renderModelRetirementBanner(notes = pendingRetirementNotes()) {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById(BANNER_ID);
  if (existing) existing.remove();
  const list = Array.isArray(notes) ? notes.filter(n => n && n.text) : [];
  if (list.length === 0) return;
  const main = document.getElementById('main');
  const viewRoot = document.getElementById('view-root');
  if (!main || !viewRoot) return;
  const wrap = document.createElement('div');
  wrap.id = BANNER_ID;
  wrap.className = 'main-inner';
  wrap.style.paddingBottom = '0';
  wrap.innerHTML =
    '<div role="status" style="display:flex;gap:var(--space-4);align-items:flex-start;' +
      'padding:var(--space-6) var(--space-8);border-radius:var(--radius-lg);' +
      'border:1px solid var(--border);background:var(--info-tint)">' +
      '<div style="flex:1;min-width:0;font:var(--type-body-sm);color:var(--text-2)">' +
        '<div style="color:var(--text);font-weight:600">Your AI model was updated</div>' +
        list.map(n => '<div>' + esc(n.text) + '</div>').join('') +
      '</div>' +
      '<button type="button" class="btn btn-ghost" id="' + BANNER_ID + '-dismiss">Dismiss</button>' +
    '</div>';
  main.insertBefore(wrap, viewRoot);
  const btn = document.getElementById(BANNER_ID + '-dismiss');
  if (btn) btn.addEventListener('click', () => { dismissRetirementNotes(); });
}

/**
 * Boot: ask the server once, move this browser's chat pick forward, and show
 * whatever is pending. Fire-and-forget; NEVER throws or rejects (boot() calls
 * it without awaiting, like checkOtherInstances).
 */
export async function checkModelRetirement() {
  try {
    const res = await fetch('/api/config/model-retirement');
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.ok) return;
    serverNotes = Array.isArray(data.notes) ? data.notes.filter(n => n && typeof n.text === 'string' && n.text) : [];
    let saved = null;
    try { saved = globalThis.localStorage.getItem(LS_CHAT_MODEL); } catch { saved = null; }
    migrateStoredChatModel(saved, data.retired);
    renderModelRetirementBanner();
  } catch { /* say nothing rather than guess */ }
}
