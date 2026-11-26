// shared/settings-file-banner.js — the app shell's banner for a DAMAGED
// settings file (v4.1.2, the F2 follow-up).
//
// src/brain/config.js holds THE RULE: a .curator-config.json or
// .sharedbrain-config.json that is present but cannot be read, is not JSON, or
// has the wrong shape is never overwritten. A copy is kept beside it as
// `<file>.unreadable-<sha:12>`, and every change to it is refused
// (`config_unreadable`, 409). Before this banner, the only place that said so
// was the refusal of whatever the person happened to try next.
//
// So the shell asks GET /api/config/settings-files once at boot and whenever
// the window comes back, and draws ONE banner above the view for every damaged
// file: what happened, the file, the kept copy, and — when the bytes could be
// read and kept — "Start fresh", which sets the file aside after a confirm
// (POST /api/config/settings-files/set-aside). It is PERSISTENT: there is no
// Dismiss, because every save keeps failing until the file is fixed or set
// aside, and a warning is never hidden behind anything (v3.16.1).
//
// Built only from existing parts: renderStatus (shared/text.js) in its danger
// tone, the app's .btn, and confirmThen (shared/confirm.js). Placed where the
// two other shell banners sit (app.js's instance banner, model-retirement.js).
// Every fetch is wrapped: boot() calls checkSettingsFiles() without awaiting,
// and a throw there would stop markBooted().

import { renderStatus } from './text.js';
import { confirmThen } from './confirm.js';

export const BANNER_ID = 'settings-file-banner';

// Local, as shared/model-retirement.js does: importing app.js's escapeHtml
// from a module app.js imports would be a cycle.
const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// What each file holds, in the words a person knows it by.
const WHAT = Object.freeze({
  '.curator-config.json': {
    name: 'settings file',
    holds: 'your API keys, where your knowledge folder is, and your other choices',
    fresh: 'Your API keys, your knowledge folder’s location and your other choices must then be set again in Settings. Your knowledge folder itself is not touched.',
  },
  '.sharedbrain-config.json': {
    name: 'Shared Brain connections file',
    holds: 'your Shared Brain connections and their tokens',
    fresh: 'Each Shared Brain must then be joined again. Your wiki pages and mirror domains are not touched.',
  },
});

/** PURE. The damaged entries of a GET /api/config/settings-files answer, known files only. */
export function damagedFiles(data) {
  const list = data && data.ok && Array.isArray(data.files) ? data.files : [];
  return list.filter((f) => f && f.state === 'damaged' && typeof f.file === 'string' && Object.hasOwn(WHAT, f.file));
}

/** PURE. The banner's words for one damaged file: {title, detail, canStartFresh}. */
export function bannerWords(f) {
  const w = WHAT[f.file];
  const kept = typeof f.backup === 'string' && f.backup ? f.backup : null;
  if (f.reason === 'read') {
    return {
      title: 'The Curator can’t open its ' + w.name,
      detail: 'This computer didn’t let The Curator open ' + f.file + ', which holds ' + w.holds + '. ' +
        'Nothing is saved to it until it can be opened, so that nothing in it is lost. ' +
        'Check the file’s permissions in The Curator’s data folder, then quit The Curator and open it again.',
      canStartFresh: false,
    };
  }
  return {
    title: 'The Curator can’t read its ' + w.name,
    detail: f.file + ' is damaged, so nothing is saved to it: saving would erase ' + w.holds + '. ' +
      (kept ? 'A copy of it is kept beside it as ' + kept + '. ' : '') +
      'Fix the file by hand, or start fresh.',
    canStartFresh: true,
  };
}

/** PURE. The banner's HTML for a list of damaged files ('' for none). */
export function renderSettingsFileBanner(files, errors = {}) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return '';
  return list.map((f) => {
    const b = bannerWords(f);
    const err = errors && typeof errors[f.file] === 'string' ? errors[f.file] : '';
    return '<div class="settings-file-banner-item" data-settings-file="' + escapeHtml(f.file) + '" ' +
        'style="display:flex;flex-direction:column;gap:var(--space-4)">' +
        renderStatus({ state: 'danger', title: b.title, detail: b.detail, support: err }) +
        (b.canStartFresh
          ? '<div><button type="button" class="btn btn-secondary" data-settings-file-start-fresh="' + escapeHtml(f.file) + '">Start fresh</button></div>'
          : '') +
      '</div>';
  }).join('');
}

/** PURE. The confirm's words for Start fresh. */
export function startFreshConfirm(f) {
  const w = WHAT[f.file];
  return {
    title: 'Start with a fresh ' + w.name + '?',
    message: 'The damaged ' + f.file + ' is moved aside: a byte-for-byte copy is kept in The Curator’s data folder' +
      (f.backup ? ' as ' + f.backup : '') + ', and the next save starts a new, empty file.',
    detail: w.fresh,
    confirmLabel: 'Start fresh',
    tone: 'danger',
  };
}

let lastErrors = {};

function paint(files) {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById(BANNER_ID);
  const html = renderSettingsFileBanner(files, lastErrors);
  if (!html) { if (existing) existing.remove(); return; }
  const main = document.getElementById('main');
  const viewRoot = document.getElementById('view-root');
  if (!main || !viewRoot) return;
  const wrap = existing || document.createElement('div');
  wrap.id = BANNER_ID;
  wrap.className = 'main-inner';
  wrap.style.paddingBottom = '0';
  wrap.setAttribute('role', 'alert');
  wrap.innerHTML = '<div style="display:flex;flex-direction:column;gap:var(--space-6)">' + html + '</div>';
  if (!existing) main.insertBefore(wrap, viewRoot);
  for (const btn of wrap.querySelectorAll('[data-settings-file-start-fresh]')) {
    const file = btn.getAttribute('data-settings-file-start-fresh');
    const f = files.find((x) => x.file === file);
    if (f) btn.addEventListener('click', () => { onStartFresh(f, btn); });
  }
}

async function onStartFresh(f, btn) {
  await confirmThen({
    ...startFreshConfirm(f),
    onConfirm: async () => {
      if (btn) btn.disabled = true;
      let body = null, ok = false;
      try {
        const res = await fetch('/api/config/settings-files/set-aside', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: f.file }),
        });
        try { body = await res.json(); } catch { body = null; }
        ok = res.ok && !!(body && body.ok);
      } catch { ok = false; }
      if (ok) delete lastErrors[f.file];
      else lastErrors[f.file] = (body && typeof body.error === 'string' && body.error) || 'The file was not set aside. Try again.';
      // A fresh .curator-config.json changes what every view reads (keys,
      // the knowledge folder): reload so nothing keeps the old answer.
      if (ok && f.file === '.curator-config.json' && typeof location !== 'undefined') { location.reload(); return; }
      await checkSettingsFiles();
    },
  });
}

/** Ask once and paint. Never throws or rejects (boot() does not await it). */
export async function checkSettingsFiles() {
  let files = [];
  try {
    const res = await fetch('/api/config/settings-files');
    if (res.ok) files = damagedFiles(await res.json());
  } catch { files = []; }
  try { paint(files); } catch { /* shell missing or detached */ }
}

let armed = false;
/** Re-check when the window comes back (a hand fix made meanwhile clears the banner). */
export function armSettingsFileRecheck() {
  if (armed || typeof document === 'undefined') return;
  armed = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkSettingsFiles();
  });
}
