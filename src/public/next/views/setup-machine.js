// Settings › MCP bridge › 1 "Connect your agent apps" — the evidence under
// each agent app's row (v3.77.0 as block 5 "Tools on this Mac"; v3.88.0 a
// per-row disclosure, closed by default).
//
// DOM-FREE AT IMPORT (the setup-step.js rule): scripts/test-next-setup-machine.js
// imports these builders in plain Node. settings.js owns the state, the one
// request (GET /api/setup/machine) and the listeners; views/mcp-install.js
// places this evidence under its app's row.
//
// THE MACHINE HALF of the Setup check: per agent app on this computer, each
// config file read (and only whether it names my-curator), the skill folders
// compared file by file with the copy this app carries, the hook files and
// what the hook activity log saw. A FAULT found here is never only in this
// fold: the row says it, unfolded (views/mcp-install.js machineWarnings).
//
// NOTHING HERE WRITES. Every action copies (the entry for that tool's file) or
// reveals (the file in Finder); the zip is a download of this app's own copy.

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

// v3.78.0 (contract §1): every config file carries `status` — missing ·
// unopenable · empty · invalid · ok. The four that are not `ok` are said in
// their own words, beside the file's own path. One is inked "to fix" only
// when the TOOL's verdict is a to-fix (it is the only file that could carry
// the entry); otherwise it is a note — another file of the same tool names
// my-curator and the tool works.
export const FILE_STATUS_WORDS = Object.freeze({
  missing: 'missing',
  unopenable: 'can’t open',
  empty: 'empty',
  invalid: 'not valid JSON',
});

/** One file row: path · verdict · action. */
function fileRow(f, extraAct = '', missingIsFix = false, toolFix = false) {
  let verdict;
  const bad = typeof f.status === 'string' && f.status !== 'ok' && Object.hasOwn(FILE_STATUS_WORDS, f.status) ? f.status : null;
  if (bad === 'missing') verdict = st('none', FILE_STATUS_WORDS.missing);
  else if (bad) {
    verdict = st(toolFix ? 'fix' : 'cant-check', FILE_STATUS_WORDS[bad])
      + '<span class="cur-setup-sub">' + escapeHtml((f.display || f.file || 'this file') + ' is ' + FILE_STATUS_WORDS[bad].replace('can’t open', 'not readable by The Curator')
        + (toolFix ? '' : ' — another file of this app names my-curator, so the app is not affected')) + '</span>';
  } else if (!f.present) verdict = st('none', 'absent');
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
  const via = f.via === 'readAlso' ? '<span class="cur-setup-sub">another app’s file, read for this app</span>' : '';
  const acts = (f.present || (bad && bad !== 'missing') ? '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="reveal" data-path="' + escapeHtml(f.file) + '">Reveal</button>' : '') + extraAct;
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
        : st('fix', 'older — ' + [x.differs.length ? x.differs.join(', ') + (x.differs.length === 1 ? ' differs' : ' differ') : '', x.missing.length ? x.missing.join(', ') + ' missing' : ''].filter(Boolean).join(' · '));
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

// ── v3.89.0: THE SAME EVIDENCE AS DATA, for the section kit ────────────────
// Settings › MCP bridge draws each app's evidence as kit fold items (a mono
// path · a sentence · Reveal). The words are the ones the rows above print —
// one verdict rule per cell, read here from the same payload fields.

/** One config file's verdict, in words. Pure. */
export function fileVerdictWords(f, missingIsFix = false, toolFix = false) {
  const bad = typeof f.status === 'string' && f.status !== 'ok' && Object.hasOwn(FILE_STATUS_WORDS, f.status) ? f.status : null;
  let w;
  if (bad === 'missing') w = FILE_STATUS_WORDS.missing;
  else if (bad) {
    w = FILE_STATUS_WORDS[bad] + (toolFix ? '' : ' — another file of this app names my-curator, so the app is not affected');
  } else if (!f.present) w = 'absent';
  else if (f.parseError) w = 'present · could not be read';
  else if (f.opaque) w = 'present · format not read';
  else if (f.named) {
    w = f.commandMissing ? 'names my-curator · its launch file is missing'
      : f.otherFolder ? 'names my-curator · reads a different knowledge folder'
        : 'names my-curator' + (f.at === 'project' ? ' (for this folder)' : '');
  } else w = 'present · no my-curator entry' + (missingIsFix && f.via !== 'readAlso' ? ' — to fix' : '');
  if (f.via === 'readAlso') w += ' · another app’s file, read for this app';
  if (f.jsonc) w += ' · read with comments allowed';
  return w;
}

/**
 * The evidence under one app, as `[{main, meta, reveal?}]` — files, then
 * skills, then hooks, each group left out exactly when renderAppDetail leaves
 * it out. `reveal` is the absolute path a Reveal button may name (only for
 * something that exists); the caller decides whether Reveal works here.
 */
export function appDetailItems(h, data, opts = {}) {
  if (!h) return [];
  const missingIsFix = !!(h.bridge && h.bridge.state === 'fix' && /^not in /.test(h.bridge.word || ''));
  const toolFix = !!(h.bridge && h.bridge.state === 'fix');
  const out = [];
  for (const f of h.files || []) {
    if (!f) continue;
    const bad = typeof f.status === 'string' && f.status !== 'ok' && f.status !== 'missing';
    out.push({ main: f.display || f.file || '', meta: fileVerdictWords(f, missingIsFix, toolFix),
      reveal: f.present || bad ? f.file : null });
  }
  if (h.bridge && h.bridge.note) out.push({ meta: h.bridge.note });
  const s = h.skills || {};
  const noSkillFolder = s.state === 'cant-check' && !(s.installed || []).length && /no known skill folder/.test(s.note || '');
  if (!noSkillFolder) {
    const inst = s.installed || [];
    for (const x of inst) {
      const v = x.match === null ? 'skill installed · not compared'
        : x.match ? 'skill matches this version'
          : 'skill older — ' + [x.differs && x.differs.length ? x.differs.join(', ') + (x.differs.length === 1 ? ' differs' : ' differ') : '',
            x.missing && x.missing.length ? x.missing.join(', ') + ' missing' : ''].filter(Boolean).join(' · ');
      out.push({ main: x.dirDisplay || x.dir || '', meta: v, reveal: x.dir || null });
    }
    if (!inst.length) {
      const zips = data && data.skillsShipped && s.state === 'cant-check'
        ? '<a class="btn btn-ghost btn-xs" href="/api/setup/skills/my-curator.zip" download>my-curator.zip</a><a class="btn btn-ghost btn-xs" href="/api/setup/skills/curator-continuity.zip" download>curator-continuity.zip</a>'
        : '';
      out.push({ meta: 'skills: ' + (s.word || 'not installed') + (s.note ? ' — ' + s.note : ''), actionHtml: zips });
    }
  }
  const k = h.hooks || {};
  if (k.format !== 'none') {
    const files = (k.files || []).filter((f) => f && f.present);
    for (const f of files) {
      out.push({ main: f.display || f.file || '', meta: (f.ours ? 'Curator hooks present' : 'no Curator hooks') + (f.ours && f.observation ? ' — ' + f.observation : ''), reveal: f.file });
    }
    const ev = k.evidence || null;
    const evWords = [];
    if (ev && ev.start) evWords.push('start hook observed firing ' + when(ev.start.at));
    if (ev && ev.stop) evWords.push('stop hook observed firing ' + when(ev.stop.at) + ' — ' + (ev.stop.decision === 'ask' ? 'asked for a save' : 'did not ask: ' + (ev.stop.why || 'no reason recorded')));
    if (!evWords.length && (k.files || []).some((f) => f && f.ours)) evWords.push('installed, not yet observed firing');
    if (evWords.length) out.push({ meta: 'hooks: ' + evWords.join(' · ') });
    if (!files.length && !evWords.length) out.push({ meta: 'hooks: ' + (k.word || 'not wired (optional)') });
  }
  return out;
}

/** The fix count for one app over its three cells, and its word. Pure. */
export function toolVerdict(h) {
  const fixes = [h.bridge, h.skills, h.hooks].filter((c) => c && c.state === 'fix').length;
  if (fixes) return { word: fixes + ' to fix', state: 'fix', fixes };
  if (h.bridge && h.bridge.state === 'ok') return { word: 'configured', state: 'ok', fixes: 0 };
  return { word: (h.bridge && h.bridge.word) || 'not configured', state: (h.bridge && h.bridge.state) || 'none', fixes: 0 };
}

const REVEAL_BTN = /<button type="button" class="btn btn-ghost btn-xs" data-setup-act="reveal"[^>]*>Reveal<\/button>/g;

/**
 * The disclosure under one app's row: `{label, html}`. The label names what
 * is inside — "Files and skills", "Files, skills and hooks" — so a closed fold
 * still says what it holds. `data` is the machine payload (for `skillsShipped`).
 *
 *   · MCP entry — every file the check read for this app;
 *   · Skills — left out only when the check knows no skill folder for the app;
 *   · Hooks — left out when the app has no hook mechanism at all.
 */
export function renderAppDetail(h, data, opts = {}) {
  const missingIsFix = !!(h.bridge && h.bridge.state === 'fix' && /^not in /.test(h.bridge.word || ''));
  const toolFix = !!(h.bridge && h.bridge.state === 'fix');
  const groups = [];
  const names = ['Files'];
  const fileRows = (h.files || []).map((f) => fileRow(f, '', missingIsFix, toolFix)).join('');
  const note = h.bridge && h.bridge.note ? '<p class="cur-setup-hint">' + escapeHtml(h.bridge.note) + '</p>' : '';
  groups.push('<div class="settings-setup-group"><span class="settings-setup-cap">MCP entry</span>' + fileRows + note + '</div>');
  const s = h.skills || {};
  const noSkillFolder = s.state === 'cant-check' && !(s.installed || []).length && /no known skill folder/.test(s.note || '');
  if (!noSkillFolder) {
    groups.push('<div class="settings-setup-group"><span class="settings-setup-cap">Skills</span>' + skillRows(h, data && data.skillsShipped) + '</div>');
    names.push('skills');
  }
  const k = h.hooks || {};
  if (k.format !== 'none') {
    groups.push('<div class="settings-setup-group"><span class="settings-setup-cap">Hooks</span>' + hookRows(h) + '</div>');
    names.push('hooks');
  }
  const label = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  let html = groups.join('');
  // Reveal is `open -R` — macOS only. Never a dead button elsewhere.
  if (opts.platform && opts.platform !== 'darwin') html = html.replace(REVEAL_BTN, '');
  return { label, html };
}

/** The block's head: "checked just now · Check again". */
export function checkHead(m) {
  const at = m && m.data && m.data.checkedAt;
  const words = at ? ageWordsFor(at, Date.now(), 'checked') : null;
  return (words ? '<span class="settings-setup-checked" data-age-at="' + escapeHtml(at) + '" data-age-prefix="checked" data-age-text>' + escapeHtml(words) + '</span>' : '')
    + '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="machine-check"' + (m && m.loading ? ' disabled' : '') + '>Check again</button>';
}
