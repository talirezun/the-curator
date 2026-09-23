// ═══════════════════════════════════════════════════════════════════════════
//  shared/ai-run.js — THE RUN LINE (v3.67.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// One line, identical on every AI action in the app, placed directly under the
// action (or action group) it describes:
//
//   before   Runs on Flash Lite 2.5 · ≈6k tokens · ≈$0.0011 · Change model
//   no key   Needs an AI provider key · Add one in Providers & keys
//   after    Ran on Flash Lite 2.5 · 5,812 in / 640 out · $0.0008
//
// It renders what src/brain/ai-run.js produced — `describeRun()` (a route's
// `runsOn`) and `spentFromUsage()` (a route's `spent`) — and computes nothing
// about money itself: every dollar figure passes through `formatUsdHonest`, the
// app's one honest formatter, and an absent figure is an omitted clause, never
// "$0.00".
//
// ── ITS RULES ────────────────────────────────────────────────────────────
// · The model is its HUMAN label; `Provider · model-id` rides in `title`, so
//   the id the bill is written against is one hover away (the composer's rule).
// · Figures are mono and tabular. The line has NO tone colour: a price is a
//   fact, not a warning. A budget over-run keeps its own loud line elsewhere.
// · Never behind a chevron (v3.16.1): hosts render it unfolded.
// · The door — "Change model" / "Add one in Providers & keys" — is ONE door,
//   Settings › Providers & keys. It is omitted inside Settings itself. It is
//   wired by `wireAiRunDoors` with the shell's functions INJECTED, never
//   imported: app.js touches `document` at import time, and a module that
//   imports it cannot run in an offline suite or inside a lifted view body.
// · With no key, the AI action is DISABLED, never hidden:
//   `aiActionDisabledAttrs` returns the attributes, pointing aria-describedby
//   at this line's id so a screen reader hears why.
//
// Pure: no fetch, no DOM access except inside `wireAiRunDoors`, no import but
// the formatter.

import { formatUsdHonest } from './format-usd.js';

// A byte-for-byte copy of app.js's escapeHtml, for the reason shared/monitor.js
// and shared/overview.js each carry one (app.js cannot be imported here).
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const SEP = '<span class="ai-run-sep" aria-hidden="true"> · </span>';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isCount = (v) => isNum(v) && v >= 0;

/** An id safe for an HTML attribute and an aria reference, or ''. */
function cleanId(id) {
  return (typeof id === 'string' && /^[A-Za-z][\w-]{0,79}$/.test(id)) ? id : '';
}

/** 6,799 → "7k"; 640 → "640". Rounded, because the figure is an estimate. */
function formatK(n) {
  if (n < 1000) return String(Math.round(n));
  return Math.round(n / 1000).toLocaleString('en-US') + 'k';
}

/** "≈6k" or "≈18k–24k"; a range whose ends print alike collapses to a point. */
function approxRange(lo, hi, fmt) {
  const a = fmt(lo), b = fmt(hi);
  if (a === null || b === null) return null;
  return a === b ? '≈' + a : '≈' + a + '–' + b;
}

/** "about 48 s" / "about 6 min"; '' below one second (nothing measured to say). */
function aboutDuration(ms) {
  if (!isNum(ms) || ms < 1000) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? 'about ' + s + ' s' : 'about ' + Math.round(s / 60) + ' min';
}

function modelSpan(o) {
  const label = o.modelLabel || o.model || '';
  const title = [o.providerLabel || o.provider, o.model].filter(Boolean).join(' · ');
  return '<span class="ai-run-model"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>'
    + escapeHtml(label) + '</span>';
}

function fig(text) {
  return '<span class="ai-run-fig">' + escapeHtml(text) + '</span>';
}

function door(text) {
  return '<button type="button" class="ai-run-door" data-ai-run-door="providers">'
    + escapeHtml(text) + '</button>';
}

function wrap(inner, id, extraLine) {
  const idAttr = cleanId(id) ? ' id="' + cleanId(id) + '"' : '';
  const extra = (typeof extraLine === 'string' && extraLine)
    ? '<span class="ai-run-extra">' + escapeHtml(extraLine) + '</span>' : '';
  return '<p class="ai-run" role="note"' + idAttr + '><span class="ai-run-main">' + inner + '</span>'
    + extra + '</p>';
}

/**
 * The line BEFORE a run.
 *
 * @param {object} runsOn   a route's `runsOn` (describeRun's shape)
 * @param {object} [opts]
 * @param {boolean} [opts.inSettings=false]  omit the door (we are already there)
 * @param {string}  [opts.id]                the line's id, for aria-describedby
 * @param {string}  [opts.extraLine]         a second line under it (Compile's clause)
 * @param {string}  [opts.figuresNote]       ADDITIVE: replaces the tokens and cost
 *                                           clauses with one plain phrase, for a line
 *                                           that describes a GROUP of actions each
 *                                           carrying its own cost ("each action shows
 *                                           its cost", Wiki health › Quick maintenance)
 * @returns {string} HTML, or '' when there is nothing to describe
 */
export function renderRunsOn(runsOn, opts) {
  const o = opts || {};
  if (!runsOn || typeof runsOn !== 'object') return '';
  if (runsOn.needsKey === true) {
    return wrap('<span class="ai-run-lead">Needs an AI provider key</span>'
      + (o.inSettings ? '' : SEP + door('Add one in Providers & keys')), o.id, o.extraLine);
  }
  if (!runsOn.model && !runsOn.modelLabel) return '';

  // " (free)" once: OpenRouter's catalogue already labels its free ids that
  // way ("MiniMax M3 (free)"), measured on the real describeRun output, and
  // "(free) (free)" is the result of appending blindly.
  const label = String(runsOn.modelLabel || runsOn.model || '');
  const freeMark = runsOn.free === true && !/\(free\)\s*$/i.test(label) ? ' (free)' : '';
  const parts = ['<span class="ai-run-lead">Runs on ' + modelSpan(runsOn) + freeMark + '</span>'];

  if (typeof o.figuresNote === 'string' && o.figuresNote) {
    parts.push(escapeHtml(o.figuresNote));
  } else {
    // Tokens: the whole run, input plus output where both are known.
    const inLo = isCount(runsOn.inputTokensLow) ? runsOn.inputTokensLow : runsOn.inputTokens;
    const inHi = isCount(runsOn.inputTokensHigh) ? runsOn.inputTokensHigh : runsOn.inputTokens;
    if (isCount(inLo) && isCount(inHi)) {
      const outLo = isCount(runsOn.outputTokensLow) ? runsOn.outputTokensLow : 0;
      const outHi = isCount(runsOn.outputTokensHigh) ? runsOn.outputTokensHigh : outLo;
      parts.push(fig(approxRange(inLo + outLo, inHi + outHi, formatK) + ' tokens'));
    }
    // Cost: free, a priced figure, or the unpriced sentence. A priced model
    // with no figures (a resting button) prints no cost clause at all.
    if (runsOn.free === true) {
      parts.push('free');
    } else if (runsOn.costNote === 'price-not-published' || runsOn.priceKnown === false) {
      parts.push('price not published: your provider bills at its rate');
    } else if (isNum(runsOn.usdLow) && isNum(runsOn.usdHigh)) {
      parts.push(fig(approxRange(runsOn.usdLow, runsOn.usdHigh, formatUsdHonest)));
    }
    const about = aboutDuration(runsOn.medianLatencyMs);
    if (about) parts.push(about);
  }
  if (!o.inSettings) parts.push(door('Change model'));
  return wrap(parts.join(SEP), o.id, o.extraLine);
}

/**
 * The line AFTER a run.
 *
 * @param {object} spent   a route's `spent` (spentFromUsage's shape)
 * @param {object} [opts]
 * @param {boolean} [opts.inSettings=false]  accepted for symmetry; the after-line has no door
 * @param {string}  [opts.id]
 * @returns {string} HTML, or '' when no call reported a model (nothing ran)
 */
export function renderSpent(spent, opts) {
  const o = opts || {};
  if (!spent || typeof spent !== 'object' || !spent.model) return '';
  const n = (v) => (isCount(v) ? v : 0);
  const tokensIn = n(spent.inputTokens) + n(spent.cachedReadTokens) + n(spent.cacheWriteTokens);
  const tokensOut = n(spent.outputTokens);
  const parts = ['<span class="ai-run-lead">Ran on ' + modelSpan(spent)
    + (spent.fallbackFrom ? ' (your model was unavailable)' : '') + '</span>'];
  parts.push(fig(tokensIn.toLocaleString('en-US') + ' in / ' + tokensOut.toLocaleString('en-US') + ' out'));
  if (isNum(spent.usd)) {
    const usd = formatUsdHonest(spent.usd);
    parts.push(fig((spent.estimated === true ? 'approx. ' : '') + usd));
  } else {
    parts.push('price not published');
  }
  return wrap(parts.join(SEP), o.id);
}

/**
 * Attributes for an AI action button: disabled — never hidden — with the no-key
 * line as its description. '' whenever a run is possible.
 *
 * @param {object} runsOn
 * @param {string} lineId  the id passed to renderRunsOn for the same action
 * @returns {string}
 */
export function aiActionDisabledAttrs(runsOn, lineId) {
  if (!runsOn || runsOn.needsKey !== true) return '';
  const id = cleanId(lineId);
  return ' disabled aria-disabled="true"' + (id ? ' aria-describedby="' + id + '"' : '');
}

const _wired = new WeakSet();

/**
 * Make every run-line door under `root` open Settings › Providers & keys.
 * Delegated and idempotent: wiring the same root twice adds one listener.
 *
 * @param {Element} root
 * @param {{requestSettingsSection: Function, navigate: Function}} deps  the shell's
 *        own functions, injected (never imported from app.js)
 * @returns {boolean} true when the root is wired
 */
export function wireAiRunDoors(root, deps) {
  const d = deps || {};
  if (!root || typeof root.addEventListener !== 'function') return false;
  if (typeof d.requestSettingsSection !== 'function' || typeof d.navigate !== 'function') return false;
  if (_wired.has(root)) return true;
  _wired.add(root);
  root.addEventListener('click', (e) => {
    const t = e && e.target;
    const btn = t && typeof t.closest === 'function' ? t.closest('[data-ai-run-door]') : null;
    if (!btn) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    d.requestSettingsSection('providers');
    d.navigate('settings');
  });
  return true;
}
