// What Personal Sync did not back up, in plain words. Pure: a report goes in
// (GET /api/sync/backup-report, or `backup` on POST /api/sync/preflight), HTML
// comes out, every name escaped. Nothing here sits behind a chevron (v3.16.1): a
// file that is not backed up is an outcome, and a secret in the repository is a
// warning.

import { renderStatus } from '../shared/text.js';

// A local copy, as in every pure shared module: app.js's export would pull the
// whole shell into anything that imports this file.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const fileWord = (n) => n + ' file' + (n === 1 ? '' : 's');

const names = (list) => {
  const shown = list.slice(0, 5);
  return shown.join(', ') + (list.length > shown.length ? ', and ' + (list.length - shown.length) + ' more' : '');
};

function fileList(b) {
  return '<ul class="sync-decision-files">' +
    b.files.map((f) => '<li>' + escapeHtml(f) + '</li>').join('') +
    (b.count > b.files.length ? '<li class="sync-decision-more">…and ' + (b.count - b.files.length) + ' more</li>' : '') +
  '</ul>';
}

function group(title, why, b) {
  if (!b || !b.count) return '';
  return '<div class="sync-backup-group">' +
    '<div class="sync-backup-title">' + escapeHtml(title) + ' (' + b.count + ')</div>' +
    '<p class="sync-decision-body">' + escapeHtml(why) + '</p>' +
    fileList(b) +
  '</div>';
}

export function nonDomainText(nonDomain) {
  return nonDomain.map((d) => (d.isFolder
    ? d.name + ' (' + fileWord(d.files) + ')'
    : fileWord(d.files) + ' loose at the top of the folder')).join(', ');
}

/** Warnings first: what the user has to act on. */
export function backupWarningsHtml(b) {
  let out = '';
  if (b.nestedRepos && b.nestedRepos.length) {
    const one = b.nestedRepos.length === 1;
    out += renderStatus({
      state: 'attention',
      title: one ? 'One folder is not backed up' : b.nestedRepos.length + ' folders are not backed up',
      detail: names(b.nestedRepos) + (one ? ' has its' : ' have their') + ' own git history, so Sync cannot copy ' +
        (one ? 'it' : 'them') + ' and nothing in ' + (one ? 'it' : 'them') + ' is on GitHub. Its own repository may back it ' +
        'up already; check that it has somewhere to push to. To back it up here instead, choose that folder ' +
        'itself as your knowledge folder (Domains, Use existing folder), or delete its .git folder if you do ' +
        'not need its history, then Sync.',
    });
  }
  if (b.brokenLinks && b.brokenLinks.length) {
    out += renderStatus({
      state: 'attention',
      title: 'Your repository holds an empty link',
      detail: names(b.brokenLinks) + ': an earlier sync sent a link instead of the files, so the repository has no ' +
        'content for it. The next Sync removes the link. Nothing here is changed.',
    });
  }
  if (b.credentialsInRepo && b.credentialsInRepo.count) {
    out += renderStatus({
      state: 'attention',
      title: 'Secrets are already in your repository',
      detail: names(b.credentialsInRepo.files) + ' went to your repository before The Curator left such files out. ' +
        'Sync no longer sends changes to ' + (b.credentialsInRepo.count === 1 ? 'it' : 'them') + '. ' +
        'First, replace the key or password with a new one, because the old one stays in the repository’s history. ' +
        'Then move the file out of this folder, Sync once, and move it back: it then stays on this computer only. ' +
        'Your other computers lose their copy on their next Sync, so copy it first. ' +
        'To remove the history as well: make a new empty private repository, Disconnect here, connect to the new one ' +
        'with Push my wiki, then delete the old one on GitHub. The Curator never rewrites history.',
    });
  }
  return out;
}

export function backupReportHtml(b) {
  if (!b || b.configured === false) return '';
  const lists =
    group('Look like secrets', 'Left out by name, so they stay on this computer. A key pasted into a note is not detected.', b.credentialsLeftOut) +
    group('Source files in raw/', 'These stay on this computer. Keep your own copy.', b.rawSources) +
    group('Obsidian Bases and Untitled notes', 'Sync skips these. Keep your own copy of any you care about.', b.obsidianFiles) +
    group('Left out by your own .gitignore', 'A rule in a .gitignore file in this folder excludes these.', b.ownRules);
  const also = b.nonDomain && b.nonDomain.length
    ? '<div class="sync-backup-group">' +
        '<div class="sync-backup-title">Also backed up, though not domains</div>' +
        '<p class="sync-decision-body">' + escapeHtml(nonDomainText(b.nonDomain)) + '. These are in your repository. To keep ' +
        'a new folder out, add a line such as /Folder name/ to the .gitignore file in your knowledge folder before ' +
        'its first sync.</p>' +
      '</div>'
    : '';
  const house = b.housekeepingCount
    ? '<p class="sync-decision-body">' + escapeHtml(fileWord(b.housekeepingCount)) + ' of app and system housekeeping also stay on this computer.</p>'
    : '';
  const warnings = backupWarningsHtml(b);
  if (!warnings && !lists && !also && !house) return '';
  return '<section class="sync-status-card sync-backup" aria-label="What is not backed up">' +
    '<div class="sync-setup-title">What Sync does not back up</div>' +
    warnings + lists + also + house +
  '</section>';
}

/** Does a connect need the "here is what goes" panel first? */
export function connectNeedsReview(b) {
  if (!b) return false;
  return (b.nestedRepos.length > 0 && b.backedUpFiles > 0) ||
    b.credentialsLeftOut.count > 0 || b.nonDomain.length > 0;
}

export function reviewFolders(b) {
  return b.nonDomain.filter((d) => d.isFolder).map((d) => d.name);
}

/** The panel before a first push or merge: the user's only moment to choose first. */
export function connectReviewHtml(b, { busy, leavingOut }) {
  const dis = busy ? ' disabled' : '';
  const folders = reviewFolders(b);
  return '<div class="sync-decision sync-decision-info">' +
    '<div class="sync-decision-title">Before you connect</div>' +
    (b.nonDomain.length
      ? '<p class="sync-decision-body">These are not domains, and would also go to your repository: ' +
        escapeHtml(nonDomainText(b.nonDomain)) + '.</p>'
      : '') +
    (b.credentialsLeftOut.count
      ? '<p class="sync-decision-body">These look like secrets, so they stay on this computer:</p>' + fileList(b.credentialsLeftOut)
      : '') +
    (b.nestedRepos.length
      ? '<p class="sync-decision-body">These have their own git history, so they cannot be backed up here: ' +
        escapeHtml(names(b.nestedRepos)) + '.</p>'
      : '') +
    '<div class="sync-decision-actions">' +
      '<button type="button" class="btn btn-primary" id="btn-decide-go"' + dis + '>' +
        (busy && !leavingOut ? 'Connecting…' : 'Connect') + '</button>' +
      (folders.length
        ? '<button type="button" class="btn btn-secondary" id="btn-decide-leave-out"' + dis + '>' +
            (busy && leavingOut ? 'Connecting…' : 'Connect, and leave out ' + (folders.length === 1 ? 'that folder' : 'those folders')) + '</button>'
        : '') +
      '<button type="button" class="btn btn-ghost" id="btn-decide-cancel">Cancel</button>' +
    '</div>' +
  '</div>';
}
