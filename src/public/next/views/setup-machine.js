// Settings › MCP bridge › 5 "Tools on this Mac" (v3.77.0) — the words.
//
// DOM-FREE AT IMPORT (the setup-step.js rule): scripts/test-next-setup-machine.js
// imports these builders in plain Node. settings.js owns the state, the one
// request (GET /api/setup/machine) and the listeners.
//
// THE MACHINE HALF of the Setup check: per agent tool on this computer, each
// config file read (and only whether it names my-curator), the skill folders
// compared file by file with the copy this app carries, the hook files and
// what the hook activity log saw. Context › step 5 shows one word per cell and
// sends "to fix" lines here for the files.
//
// NOTHING HERE WRITES. Every action copies (the entry for that tool's file) or
// reveals (the file in Finder); the zip is a download of this app's own copy.

import { renderMonitor } from '../shared/monitor.js';
import { ageWordsFor } from '../shared/age-ticker.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const ST = {
  ok: 'cur-setup-st-ok', fix: 'cur-setup-st-fix', 'cant-check': 'cur-setup-st-q',
  'not-checked': 'cur-setup-st-q', unmeasured: 'cur-setup-st-q', none: 'cur-setup-st-none',
};
const st = (state, word) => '<span class="cur-setup-st ' + (ST[state] || ST.none) + '">' + escapeHtml(word) + '</span>';

function when(iso) {
  return ageWordsFor(iso, Date.now(), null) || iso;
}

/** One file row: path · verdict · action. */
function fileRow(f, extraAct = '', missingIsFix = false) {
  let verdict;
  if (!f.present) verdict = st('none', 'absent');
  else if (f.parseError) verdict = st('fix', 'present · could not be read');
  else if (f.opaque) verdict = st('cant-check', 'present · format not read');
  else if (f.named) {
    verdict = st(f.otherFolder || f.commandMissing ? 'fix' : 'ok',
      f.commandMissing ? 'names my-curator · its launch file is missing'
        : f.otherFolder ? 'names my-curator · reads a different knowledge folder'
          : 'names my-curator' + (f.at === 'project' ? ' (for this folder)' : ''));
  // A file with no entry is only "to fix" when the TOOL's verdict says the
  // entry is missing from it (Antigravity's "not in 1 of 3 files"); a tool
  // configured through another of its files is not asked to fix this one.
  } else verdict = st(missingIsFix && f.via !== 'readAlso' ? 'fix' : 'none', 'present · no my-curator entry');
  const via = f.via === 'readAlso' ? '<span class="cur-setup-sub">another app’s file, read for this tool</span>' : '';
  const acts = (f.present ? '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="reveal" data-path="' + escapeHtml(f.file) + '">Reveal</button>' : '') + extraAct;
  return '<div class="settings-setup-file">'
    + '<span class="cur-setup-path">' + escapeHtml(f.display || f.file) + via + '</span>'
    + '<span>' + verdict + (f.jsonc ? '<span class="cur-setup-sub">read with comments allowed</span>' : '') + '</span>'
    + '<span class="settings-setup-acts">' + acts + '</span>'
    + '</div>';
}

function skillRows(h, shipped) {
  const s = h.skills || {};
  const rows = (s.installed || []).map((x) => {
    const v = x.match === null ? st('cant-check', 'installed · not compared')
      : x.match ? st('ok', 'matches this version')
        : st('fix', 'outdated — ' + [x.differs.length ? 'differs: ' + x.differs.join(', ') : '', x.missing.length ? 'missing: ' + x.missing.join(', ') : ''].filter(Boolean).join(' · '));
    return '<div class="settings-setup-file">'
      + '<span class="cur-setup-path">' + escapeHtml(x.dirDisplay || x.dir) + '</span>'
      + '<span>' + v + '</span>'
      + '<span class="settings-setup-acts"><button type="button" class="btn btn-ghost btn-xs" data-setup-act="reveal" data-path="' + escapeHtml(x.dir) + '">Reveal</button></span>'
      + '</div>';
  }).join('');
  if (rows) return rows;
  return '<div class="settings-setup-file"><span class="cur-setup-path">skills</span><span>'
    + st(s.state || 'none', s.word || 'not installed')
    + (s.note ? '<span class="cur-setup-sub">' + escapeHtml(s.note) + '</span>' : '')
    + '</span><span class="settings-setup-acts">'
    + (shipped && s.state === 'cant-check' ? '<a class="btn btn-ghost btn-xs" href="/api/setup/skills/my-curator.zip" download>my-curator.zip</a><a class="btn btn-ghost btn-xs" href="/api/setup/skills/curator-continuity.zip" download>curator-continuity.zip</a>' : '')
    + '</span></div>';
}

function hookRows(h) {
  const k = h.hooks || {};
  const files = (k.files || []).filter((f) => f.present).map((f) => '<div class="settings-setup-file">'
    + '<span class="cur-setup-path">' + escapeHtml(f.display || f.file) + '</span>'
    + '<span>' + st(f.ours ? (f.observation && !/was used/.test(f.observation) ? 'unmeasured' : 'ok') : 'none', f.ours ? 'Curator hooks present' : 'no Curator hooks')
    + (f.ours && f.observation ? '<span class="cur-setup-sub">' + escapeHtml(f.observation) + '</span>' : '') + '</span>'
    + '<span class="settings-setup-acts"><button type="button" class="btn btn-ghost btn-xs" data-setup-act="reveal" data-path="' + escapeHtml(f.file) + '">Reveal</button></span>'
    + '</div>').join('');
  const ev = k.evidence || null;
  const evWords = [];
  if (ev && ev.start) evWords.push('start hook observed firing ' + when(ev.start.at));
  if (ev && ev.stop) evWords.push('stop hook observed firing ' + when(ev.stop.at) + ' — ' + (ev.stop.decision === 'ask' ? 'asked for a save' : 'did not ask: ' + (ev.stop.why || 'no reason recorded')));
  if (!evWords.length && (k.files || []).some((f) => f.ours)) evWords.push('installed, not yet observed firing');
  const evRow = evWords.length
    ? '<div class="settings-setup-file"><span class="cur-setup-path">hook activity</span><span>'
      + evWords.map((w) => '<span class="cur-setup-sub">' + escapeHtml(w) + '</span>').join('') + '</span><span></span></div>'
    : '';
  if (!files && !evRow) {
    return '<div class="settings-setup-file"><span class="cur-setup-path">hooks</span><span>' + st(k.state || 'none', k.word || 'not wired (optional)') + '</span><span></span></div>';
  }
  return files + evRow;
}

/** The monitor's head word for one tool, and its tone. Pure. */
export function toolVerdict(h) {
  const fixes = [h.bridge, h.skills, h.hooks].filter((c) => c && c.state === 'fix').length;
  if (fixes) return { word: fixes + ' to fix', state: 'fix' };
  if (h.bridge && h.bridge.state === 'ok') return { word: 'configured', state: 'ok' };
  return { word: (h.bridge && h.bridge.word) || 'not configured', state: (h.bridge && h.bridge.state) || 'none' };
}

/**
 * The block's body. `m` is `{data, error, loading}`; `openFolds` which
 * harness folds are open.
 */
export function renderToolsOnThisMacBody(m, openFolds = {}) {
  const data = m && m.data;
  if (!data) {
    if (m && m.error) return '<p class="settings-inline-error" role="alert">Could not check this computer: ' + escapeHtml(m.error) + '</p>';
    return '<p class="cur-setup-hint" aria-busy="true">Checking this computer…</p>';
  }
  const hs = data.harnesses || [];
  const fixN = hs.reduce((n, h) => n + [h.bridge, h.skills, h.hooks].filter((c) => c && c.state === 'fix').length, 0);
  const bp = data.bridgeProcesses || {};
  const loud = [];
  if (bp.checked && Array.isArray(bp.stale) && bp.stale.length) {
    loud.push({ tone: 'warn', text: bp.stale.length + (bp.stale.length === 1 ? ' bridge started' : ' bridges started') + ' before the code on disk is still running.', strongText: bp.remedy || '' });
  }
  const mon = renderMonitor({
    id: 'settings-setup-monitor',
    label: 'Tools on this computer',
    head: { stateWord: fixN ? fixN + ' to fix' : 'Nothing to fix', tone: fixN ? 'warn' : 'ok' },
    lines: [
      { key: 'This Curator', value: (data.version || 'unknown') + (data.install ? ' · ' + data.install : '') },
      { key: 'Machine name', value: (data.machine && data.machine.ids && data.machine.ids.length ? data.machine.ids.join(' · ') : 'not minted — written on the first save'),
        sub: data.machine && data.machine.split ? 'two installs on this computer, so two names' : '' },
      { key: 'Skills to compare with', value: data.skillsShipped ? 'carried by this app' : 'none — this install carries no copy' },
    ],
    loud,
  });
  const entries = data.copyEntries || {};
  const folds = hs.map((h) => {
    const v = toolVerdict(h);
    const key = 'tool-' + h.id;
    const copy = entries[h.id]
      ? '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="copy-entry" data-tool="' + escapeHtml(h.id) + '">Copy entry</button>' : '';
    const missingIsFix = !!(h.bridge && h.bridge.state === 'fix' && /^not in /.test(h.bridge.word || ''));
    const fileRows = (h.files || []).map((f) => fileRow(f, '', missingIsFix)).join('');
    const note = h.bridge && h.bridge.note ? '<p class="cur-setup-hint">' + escapeHtml(h.bridge.note) + '</p>' : '';
    return '<details class="settings-setup-fold" data-setup-fold="' + escapeHtml(key) + '"' + (openFolds[key] ? ' open' : '') + '>'
      + '<summary class="settings-setup-summary"><span class="settings-setup-name">' + escapeHtml(h.label) + '</span>'
      + st(v.state, v.word) + '</summary>'
      + '<div class="settings-setup-body">'
      + '<div class="settings-setup-group"><span class="settings-setup-cap">Bridge</span>' + fileRows + note
      + (copy && h.bridge && h.bridge.state !== 'ok' ? '<div class="settings-setup-acts settings-setup-copyrow">' + copy + '<span class="cur-setup-hint">the entry in this tool’s own format, to paste into one of the files above</span></div>' : '')
      + '</div>'
      + '<div class="settings-setup-group"><span class="settings-setup-cap">Skills</span>' + skillRows(h, data.skillsShipped) + '</div>'
      + '<div class="settings-setup-group"><span class="settings-setup-cap">Hooks</span>' + hookRows(h) + '</div>'
      + '</div></details>';
  }).join('');
  const none = hs.length ? '' : '<p class="cur-setup-hint">No agent tool is set up on this computer.</p>';
  const privacy = '<p class="cur-setup-hint">Only whether each file names my-curator is read — never its contents, and never another server’s entry. Nothing here writes a file.</p>';
  return '<div class="settings-setup-stack">' + mon + folds + none + privacy + '</div>';
}

export function toolsOnThisMacHead(m) {
  const at = m && m.data && m.data.checkedAt;
  const words = at ? ageWordsFor(at, Date.now(), 'checked') : null;
  return (words ? '<span class="settings-setup-checked" data-age-at="' + escapeHtml(at) + '" data-age-prefix="checked" data-age-text>' + escapeHtml(words) + '</span>' : '')
    + '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="machine-check"' + (m && m.loading ? ' disabled' : '') + '>Check again</button>';
}
