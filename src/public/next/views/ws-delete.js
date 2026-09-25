// ═══════════════════════════════════════════════════════════════════════════
//  views/ws-delete.js — "DELETE HANDOFF", THE CONFIRM AND ITS OUTCOME
//  (v3.75.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// A work-stream is a SCOPE — `state/[<project>/]<scope>/`, holding one folder
// per machine. Until this release one could only be removed by hand.
//
// ── THE WORD ON SCREEN IS "HANDOFF", NOT "WORK-STREAM" ───────────────────
// v3.65.1's vocabulary decision (D1): the Context view's copy says Handoffs,
// and a census in scripts/test-next-memory-view.js bans "work-stream" from
// what a reader sees. In that vocabulary a scope is ONE HANDOFF (the fold's
// "N handoffs" counts scopes) and each machine's folder is a SAVED COPY of it
// ("M saved copies"). So the card is "Delete handoff <scope>?" and lists the
// saved copies. The store, the route and the docs keep `scope`/work-stream.
//
// The Handoffs table now carries a neutral `.row-act` trash on each row (the ONE
// row-action rule, shared/row-action.css: neutral at rest and on hover, red
// only inside the confirm), and a press opens the confirm card built here.
//
// DOM-FREE AT IMPORT, for the reason views/chat-list.js gives: an offline
// suite imports the REAL builders in plain Node (scripts/test-work-stream-
// delete.js) instead of lifting them out of the 13,000-line memory.js by
// brace-matching. memory.js owns the state, the requests and the listeners;
// this module owns the words and the one predicate the button is gated on.
//
// ── WHAT THE CARD SAYS, AND WHERE EACH FACT COMES FROM ───────────────────
// · WHAT GOES: every machine's copy of the scope, each with its newest
//   headline and its age — from the delete PREVIEW read when the card opened
//   (`GET …/scopes/:scope/delete-preview`), never from the row that was
//   pressed. A row is ONE machine's copy; the delete takes all of them, and
//   quoting the row would be v3.72.1's "promise 4, delete 7" shape.
// · OTHER COMPUTERS: when any copy was saved on another machine, one plain
//   sentence says Sync will remove it there too. Never folded (v3.16.1).
// · WHERE IT GOES AND HOW TO BRING IT BACK: the trash folder the preview
//   named, and the folder to move it back into (`restoreTo`, the server's).
// · THE GATE: a typed confirmation, the scope's exact name. The button is
//   disabled until it matches (`wsDeleteConfirmMatches`, the ONE predicate —
//   used by the render, by the live input handler and by the request), and
//   the route re-checks it, so a client that skipped the box deletes nothing.

import { formatAge } from '../shared/age.js';

// A byte-for-byte copy of app.js's escapeHtml, for the reason
// views/chat-list.js carries one: this module must import in plain Node.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

/** The ONE predicate: exact, no trim, no case folding. */
export function wsDeleteConfirmMatches(del) {
  return !!del && typeof del.scope === 'string' && del.scope !== ''
    && typeof del.confirmText === 'string' && del.confirmText === del.scope;
}

/** May the delete button be pressed right now? */
export function wsDeleteCanSubmit(del) {
  return !!del && !del.busy && !del.loading && !del.loadError
    && !!del.preview && wsDeleteConfirmMatches(del);
}

/** The request body. The typed text is SENT, not merely checked here. */
export function wsDeleteBody(del) {
  return JSON.stringify({ confirm: del && typeof del.confirmText === 'string' ? del.confirmText : '' });
}

/** One machine copy's line: name, this-machine mark, headline, age, tool. */
function machineLine(m, nowMs) {
  const at = typeof m.writtenAt === 'string' ? Date.parse(m.writtenAt)
    : (typeof m.lastWriteAt === 'string' ? Date.parse(m.lastWriteAt) : NaN);
  const age = Number.isFinite(at) ? formatAge(Math.max(0, Math.round((nowMs - at) / 1000))) : null;
  const facts = [];
  if (age) facts.push('saved ' + age + (typeof m.writtenAt === 'string' ? '' : ' (file time)'));
  const tool = m.harnessLabel || m.harness;
  if (tool) facts.push(tool);
  if (m.hasPrevious) facts.push('with a kept previous handoff');
  if (!m.hasCurrent) facts.push('no handoff, journal only');
  return (
    '<li class="mem-wsdel-machine">' +
      '<span class="mem-wsdel-machine-name">' + escapeHtml(m.machine) + '</span>' +
      (m.isThisMachine ? ' <span class="mem-wsdel-mine">this machine</span>' : '') +
      (m.headline ? ' — “' + escapeHtml(m.headline) + '”' : '') +
      (facts.length ? '<span class="mem-wsdel-facts"> · ' + escapeHtml(facts.join(' · ')) + '</span>' : '') +
    '</li>'
  );
}

/**
 * THE CONFIRM CARD. `del` is memory.js's `state.wsDelete`:
 *   { domain, project, scope, preview, loading, loadError, confirmText, busy, error }
 */
export function wsDeleteCardHtml(del, nowMs = Date.now()) {
  if (!del || !del.scope) return '';
  const scope = del.scope;
  const pv = del.preview && typeof del.preview === 'object' ? del.preview : null;
  const busy = !!del.busy;
  const machines = pv && Array.isArray(pv.machines) ? pv.machines : [];
  const total = pv && Number.isInteger(pv.total) ? pv.total : machines.length;
  const others = pv && Number.isInteger(pv.otherMachines)
    ? pv.otherMachines : machines.filter((m) => !m.isThisMachine).length;

  let what;
  if (del.loading) {
    what = '<div class="mem-wsdel-body">Reading every machine’s saved copy of this handoff…</div>';
  } else if (del.loadError) {
    what = '<div class="mem-wsdel-body">Could not read what this would delete: ' + escapeHtml(del.loadError) +
      ' Nothing was deleted.</div>';
  } else if (pv) {
    what =
      '<div class="mem-wsdel-body">' + (total === 1
        ? 'This removes the only saved copy of <span class="mem-wsdel-name">' + escapeHtml(scope) +
          '</span>, with its Journal:'
        : 'This removes ' + escapeHtml(plural(total, 'saved copy', 'saved copies')) +
          ' of <span class="mem-wsdel-name">' + escapeHtml(scope) + '</span>, one per machine, each with its Journal:') +
      '</div>' +
      '<ul class="mem-wsdel-list">' + machines.map((m) => machineLine(m, nowMs)).join('') + '</ul>' +
      (pv.truncated ? '<div class="mem-wsdel-body">…and ' + escapeHtml(String(total - machines.length)) +
        ' more not listed here. All of them go.</div>' : '') +
      (pv.unlistedMachines ? '<div class="mem-wsdel-body">' +
        escapeHtml(plural(pv.unlistedMachines, 'folder', 'folders')) +
        ' in it cannot be listed by name and go with it.</div>' : '');
  } else {
    what = '';
  }

  const warn = pv && others > 0
    ? '<div class="mem-wsdel-warn" role="note">Includes ' +
      escapeHtml(plural(others, 'copy saved on another computer', 'copies saved on other computers')) +
      '. Sync will remove it on your other computers too.</div>'
    : '';

  const trashDir = pv && typeof pv.trashDir === 'string' && pv.trashDir ? pv.trashDir : null;
  const restoreTo = pv && typeof pv.restoreTo === 'string' && pv.restoreTo ? pv.restoreTo : null;
  const where = pv
    ? '<div class="mem-wsdel-body">It is moved to The Curator’s trash' +
      (trashDir ? ', <span class="mem-wsdel-path">' + escapeHtml(trashDir) + '/</span>' : '') +
      ', not erased. To restore it, move that folder back into ' +
      (restoreTo ? '<span class="mem-wsdel-path">' + escapeHtml(restoreTo) + '</span>' : 'this project’s state folder') +
      ' and rename it <span class="mem-wsdel-name">' + escapeHtml(scope) + '</span>.</div>'
    : '';

  const can = wsDeleteCanSubmit(del);
  return (
    '<div class="mem-wsdel-card" role="group" aria-labelledby="mem-ws-del-title" data-ws-del-scope="' +
      escapeHtml(scope) + '">' +
      '<div class="mem-wsdel-title" id="mem-ws-del-title">Delete handoff ' +
        '<span class="mem-wsdel-name">' + escapeHtml(scope) + '</span>?</div>' +
      what + warn + where +
      '<label class="mem-wsdel-label" for="mem-ws-del-input">Type <span class="mem-wsdel-name">' +
        escapeHtml(scope) + '</span> to confirm</label>' +
      '<input class="mem-wsdel-input" id="mem-ws-del-input" type="text" autocomplete="off" spellcheck="false" value="' +
        escapeHtml(del.confirmText || '') + '"' + (busy ? ' disabled' : '') + ' />' +
      (del.error
        ? '<div class="mem-wsdel-error" role="alert"><strong>Not deleted.</strong> ' + escapeHtml(del.error) + '</div>'
        : '') +
      '<div class="mem-wsdel-actions">' +
        '<button type="button" class="btn btn-danger-solid btn-xs" id="mem-ws-del-go"' + (can ? '' : ' disabled') + '>' +
          (busy ? 'Deleting…' : 'Delete handoff') + '</button>' +
        '<button type="button" class="btn btn-ghost btn-xs" id="mem-ws-del-no"' + (busy ? ' disabled' : '') +
          '>Keep it</button>' +
      '</div>' +
    '</div>'
  );
}

/** The outcome sentence, from the SERVER's answer, never from the request. */
export function wsDeleteOutcomeText(result, scope) {
  const r = result && typeof result === 'object' ? result : {};
  const name = typeof r.scope === 'string' && r.scope ? r.scope : scope;
  const machines = Array.isArray(r.machines) ? r.machines.filter((m) => typeof m === 'string') : [];
  const unlisted = Number.isInteger(r.unlistedMachines) ? r.unlistedMachines : 0;
  const n = machines.length + unlisted;
  let text = 'Deleted handoff “' + name + '”';
  if (n) text += ' — ' + plural(n, 'saved copy', 'saved copies') + (machines.length ? ' (' + machines.join(', ') + ')' : '');
  text += '.';
  if (typeof r.trashPath === 'string' && r.trashPath) {
    // v3.76.0: the restore is a button now — Settings › Trash. The by-hand
    // path stays, as the fallback the user guide also keeps.
    text += ' It was moved to The Curator’s trash, at ' + r.trashPath + '. To restore it, open Settings › Trash ' +
      'and press Restore — or move that folder back into ' +
      (typeof r.restoreTo === 'string' && r.restoreTo ? r.restoreTo : 'this project’s state folder') +
      ' and rename it ' + name + '.';
  }
  if (r.recreated === true) {
    text += ' A save landed while it was being deleted, so “' + name + '” exists again holding only that save.';
  }
  return text;
}
