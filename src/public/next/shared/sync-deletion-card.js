// shared/sync-deletion-card.js — the Sync deletion guard's question (v4.2.1).
//
// A sync that would delete more than a page or two stops before changing
// anything (src/brain/sync.js, src/brain/sync-deletions.js) and answers with
// the count, the domains, a sample and a confirm token. This is the card the
// Sync page shows for it, built from the page's existing parts: the decision
// panel (`.sync-decision`, the danger tone the connect flow's overwrite
// question uses), its title and body, and the app's buttons.
//
// HOUSE RULES. A warning is never behind a chevron (v3.16.1): the sentence,
// the count and the domains are on the card itself; the full list opens in
// the right-side reader ("Show the pages"), never inline and never folded.
// It is a warning, so it is NEVER Pro-only: nothing here reads the Pro mode,
// and the card carries data-never-pro so the Pro guard protects it by meaning.
//
// Pure: no imports, no DOM. The words match the server's
// (src/brain/sync-deletions.js deletionHeadline); scripts/
// test-sync-deletion-guard.js proves the two give the same sentence.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function deletionWhat(d) {
  const n = d.count;
  if (d.pages === n) return n + ' page' + (n === 1 ? '' : 's');
  if (!d.pages) return n + ' file' + (n === 1 ? '' : 's');
  return n + ' files (' + d.pages + ' of them page' + (d.pages === 1 ? '' : 's') + ')';
}

export function deletionDomains(d) {
  const list = Array.isArray(d.byDomain) ? d.byDomain : [];
  const named = list.slice(0, 4).map((g) => (g.domain || 'top level') + ' ' + g.count);
  const rest = list.length - named.length;
  return named.join(' · ') + (rest > 0 ? ' · +' + rest + ' more' : '');
}

export function deletionHeadline(d) {
  return d.direction === 'in'
    ? 'This sync would delete ' + deletionWhat(d) + ' on this computer that are no longer in your GitHub backup (' + deletionDomains(d) + ').'
    : 'This sync would delete ' + deletionWhat(d) + ' from your GitHub backup (' + deletionDomains(d) + ').';
}

/** True when an outcome is the deletion guard's question with what the card needs. */
export function isDeletionQuestion(o) {
  return !!(o && o.details && typeof o.details.count === 'number' && typeof o.details.confirmToken === 'string');
}

/**
 * The card. `d` is the refusal's details; `opts.busy` while a confirmed run
 * goes; `opts.disabled` when another write holds the folder (Delete them only:
 * Cancel and Show the pages never touch anything).
 */
export function deletionCardHtml(d, opts = {}) {
  const them = d.count === 1 ? 'it' : 'these';
  const busy = !!opts.busy;
  const off = busy || opts.disabled ? ' disabled' : '';
  return (
    '<div class="sync-decision sync-decision-danger" id="sync-deletion-card" role="alert" data-never-pro>' +
      '<div class="sync-decision-title">' +
        (d.direction === 'in' ? 'Check before deleting on this computer' : 'Check before deleting from your GitHub backup') +
      '</div>' +
      '<p class="sync-decision-body" id="sync-deletion-headline">' + esc(deletionHeadline(d)) +
        ' If you didn’t delete ' + them + ' on purpose, press Cancel. Nothing is changed.</p>' +
      (d.stale
        ? '<p class="sync-decision-body">What this sync would delete changed since you were last asked, so this is a new question.</p>'
        : '') +
      '<div class="sync-decision-actions">' +
        '<button type="button" class="btn btn-ghost" id="btn-deletions-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>' +
        '<button type="button" class="btn btn-secondary" id="btn-deletions-show">Show the ' + (d.pages === d.count ? 'pages' : 'files') + '</button>' +
        '<button type="button" class="btn btn-danger" id="btn-deletions-confirm"' + off + '>' +
          (busy ? 'Deleting…' : 'Delete them') + '</button>' +
      '</div>' +
    '</div>'
  );
}

/** The reader's body: the domains, then every path the server sent (escaped). */
export function deletionListHtml(d) {
  const paths = Array.isArray(d.paths) && d.paths.length ? d.paths : (Array.isArray(d.sample) ? d.sample : []);
  const more = d.count - paths.length;
  return (
    '<p>' + esc(deletionHeadline(d)) + ' Nothing is changed until you press Delete them.</p>' +
    (Array.isArray(d.wholeDomains) && d.wholeDomains.length
      ? '<p><strong>Whole domain' + (d.wholeDomains.length === 1 ? '' : 's') + ' that would disappear:</strong> ' +
        esc(d.wholeDomains.join(', ')) + '</p>'
      : '') +
    '<ul>' + paths.map((p) => '<li><code>' + esc(p) + '</code></li>').join('') + '</ul>' +
    (more > 0 ? '<p>…and ' + more + ' more.</p>' : '')
  );
}
