/**
 * Baseline record + diff.
 *
 * A single run answers "is it broken right now". A baseline answers the
 * question this repo actually keeps asking: "what MOVED?" — the one a green
 * suite could never answer, because it had nothing to compare against.
 *
 * WHY THE BASELINE IS NORMALISED RATHER THAN THE RAW REPORT
 * Timestamps, ports, browser build and full contrast decimals all move for
 * reasons that are not regressions. A baseline that goes red on those trains
 * people to re-record it without reading it, which is worse than no baseline.
 * So the stored shape is the SUBSET whose movement means something.
 *
 * RATCHET, NOT ABSOLUTE. Known-unfixed contrast failures and known-frozen
 * font sizes are real and documented in this project's own release notes.
 * Failing on them would make the harness red on day one, which is how a guard
 * gets ignored. Instead the baseline pins the CURRENT set and the diff fails
 * only on ADDITIONS — the gap cannot grow, and shrinking it is reported as an
 * improvement to be re-recorded.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BASELINE_DIR = path.join(HARNESS_DIR, 'baselines');
export const DEFAULT_BASELINE = path.join(BASELINE_DIR, 'next-shell.json');
export const ONBOARDING_BASELINE = path.join(BASELINE_DIR, 'next-shell-onboarding.json');

/**
 * The baseline a given mode belongs to. `--with-onboarding` renders the
 * first-run panel, which legitimately adds controls and text -- diffing that
 * against the steady-state baseline reports regressions that are really just
 * a different screen. Two modes, two baselines.
 */
export function baselineFor({ withOnboarding = false } = {}) {
  return withOnboarding ? ONBOARDING_BASELINE : DEFAULT_BASELINE;
}

/** Content-type family, so `; charset=UTF-8` churn is not a diff. */
function typeFamily(ct) { return String(ct || '').split(';')[0].trim().toLowerCase(); }

/** Reduce a full report to the stable, meaningful subset. */
export function normalize(report) {
  if (report.skipped) return { skipped: true };
  const out = {
    boot: { booted: !!report.boot?.booted },
    assets: {},
    views: {},
    fontScaleFrozen: (report.fontScaleFrozen?.frozen || []).map(f => `${f.view ? f.view + ':' : ''}${f.key}@${f.px}`).sort(),
  };

  for (const a of report.assets || []) {
    out.assets[a.ref] = { status: a.status, type: typeFamily(a.ctype), ok: !!a.ok, servedAsShell: !!a.servedAsShell };
  }

  for (const [k, v] of Object.entries(report.views || {})) {
    const occluded = v.controls.filter(c => c.state === 'occluded')
      .map(c => `${c.key} <- ${c.occludedBy}`).sort();
    // Not occlusion, but the same user-visible outcome: looks clickable,
    // cannot be clicked. Ratcheted separately so the two diagnoses stay apart.
    const unclickable = v.controls.filter(c => c.state === 'pointer-events-none')
      .map(c => c.key).sort();
    // Only CERTAIN measurements become verdicts. An uncertain backdrop is
    // recorded as a count so the size of the blind spot is visible, but it
    // never fails a build -- ratcheting a number we cannot stand behind
    // would make the ratchet itself untrustworthy.
    const certain = v.contrast.filter(c => !c.uncertain);
    const contrastFails = certain.filter(c => !c.pass)
      .map(c => `${c.key}@${c.fontSize}px=${c.ratio}/${c.floor}`).sort();
    const contrastUncertain = v.contrast.filter(c => c.uncertain).length;
    const deadSheets = v.stylesheets.filter(s => !s.inCssom || s.rules === 0)
      .map(s => s.href).sort();
    out.views[k] = {
      horizontalOverflow: !!v.geometry.horizontalOverflow,
      controlCounts: {
        reachable: v.controls.filter(c => c.state === 'reachable').length,
        notRendered: v.controls.filter(c => c.state === 'not-rendered').length,
        offscreen: v.controls.filter(c => c.state === 'offscreen').length,
        noHit: v.controls.filter(c => c.state === 'no-hit').length,
        disabled: v.controls.filter(c => c.state === 'disabled').length,
        pointerEventsNone: v.controls.filter(c => c.state === 'pointer-events-none').length,
      },
      occluded,
      unclickable,
      contrastFails,
      contrastUncertain,
      contrastTotal: v.contrast.length,
      deadSheets,
      typography: v.typography,
      consoleErrors: (v.consoleErrors || []).map(e => String(e).slice(0, 200)).sort(),
    };
  }
  return out;
}

export function writeBaseline(report, file = DEFAULT_BASELINE) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(normalize(report), null, 2) + '\n');
  return file;
}

export function readBaseline(file = DEFAULT_BASELINE) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

const setDiff = (a, b) => a.filter(x => !b.includes(x));

/**
 * Compare a fresh report against a baseline.
 * @returns {{regressions: string[], improvements: string[], changes: string[]}}
 *   `regressions` FAIL the run; `improvements` and `changes` are reported and
 *   invite a re-record. Nothing is auto-accepted — a baseline that updates
 *   itself is a baseline that proves nothing.
 */
export function diffBaseline(report, base) {
  const now = normalize(report);
  const regressions = [], improvements = [], changes = [];

  if (base.boot?.booted && !now.boot.booted) regressions.push('BOOT: the shell no longer sets window.__curatorBooted');

  // Assets
  for (const [ref, b] of Object.entries(base.assets || {})) {
    const n = now.assets[ref];
    if (!n) { changes.push(`asset removed from the shell: ${ref}`); continue; }
    if (b.ok && !n.ok) regressions.push(`asset broke: ${ref} (was ${b.status} ${b.type}, now ${n.status} ${n.type})`);
    else if (!b.ok && n.ok) improvements.push(`asset fixed: ${ref}`);
    else if (b.type !== n.type) changes.push(`asset content-type changed: ${ref} ${b.type} -> ${n.type}`);
  }
  for (const ref of Object.keys(now.assets)) {
    if (!(ref in (base.assets || {}))) {
      changes.push(`new asset referenced: ${ref}`);
      if (!now.assets[ref].ok) regressions.push(`new asset is broken on arrival: ${ref} (${now.assets[ref].status} ${now.assets[ref].type})`);
    }
  }

  // Font-scale freeze — ratcheted.
  for (const f of setDiff(now.fontScaleFrozen, base.fontScaleFrozen || [])) {
    regressions.push(`font-scale: newly frozen against the text-size setting: ${f}`);
  }
  for (const f of setDiff(base.fontScaleFrozen || [], now.fontScaleFrozen)) {
    improvements.push(`font-scale: no longer frozen: ${f}`);
  }

  // Per view/theme
  const keys = new Set([...Object.keys(base.views || {}), ...Object.keys(now.views)]);
  for (const k of keys) {
    const b = base.views?.[k], n = now.views[k];
    if (!b) { changes.push(`new view/theme measured: ${k}`); continue; }
    if (!n) { changes.push(`view/theme no longer measured: ${k}`); continue; }

    for (const s of setDiff(n.deadSheets, b.deadSheets)) regressions.push(`${k}: stylesheet linked but applies no rules: ${s}`);
    for (const s of setDiff(b.deadSheets, n.deadSheets)) improvements.push(`${k}: stylesheet now loads: ${s}`);

    for (const o of setDiff(n.occluded, b.occluded)) regressions.push(`${k}: control is covered at its own centre: ${o}`);
    for (const o of setDiff(b.occluded, n.occluded)) improvements.push(`${k}: control no longer covered: ${o}`);

    for (const u of setDiff(n.unclickable || [], b.unclickable || [])) regressions.push(`${k}: control looks enabled but has pointer-events:none: ${u}`);
    for (const u of setDiff(b.unclickable || [], n.unclickable || [])) improvements.push(`${k}: control is clickable again: ${u}`);

    for (const c of setDiff(n.contrastFails, b.contrastFails)) regressions.push(`${k}: new contrast failure: ${c}`);
    for (const c of setDiff(b.contrastFails, n.contrastFails)) improvements.push(`${k}: contrast failure gone: ${c}`);

    for (const e of setDiff(n.consoleErrors, b.consoleErrors)) regressions.push(`${k}: new console error: ${e}`);

    if (!b.horizontalOverflow && n.horizontalOverflow) regressions.push(`${k}: the page now scrolls horizontally`);
    if (b.horizontalOverflow && !n.horizontalOverflow) improvements.push(`${k}: horizontal overflow gone`);

    for (const [field, bv] of Object.entries(b.controlCounts)) {
      const nv = n.controlCounts[field];
      if (nv !== bv) changes.push(`${k}: controls.${field} ${bv} -> ${nv}`);
    }

    const typoKeys = new Set([...Object.keys(b.typography), ...Object.keys(n.typography)]);
    for (const tk of typoKeys) {
      const bv = b.typography[tk] || 0, nv = n.typography[tk] || 0;
      if (bv !== nv) changes.push(`${k}: typography ${tk} count ${bv} -> ${nv}`);
    }
  }
  return { regressions, improvements, changes };
}
