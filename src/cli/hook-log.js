/**
 * `my-curator hook-log` — the last hook invocations on this machine, read from
 * the content-free hook activity log (src/brain/hook-log.js).
 *
 * READ-ONLY and exit 0 always, like `doctor`: it is what somebody runs when a
 * hook seems not to have fired, and a command that fails there answers nothing.
 */
import { EXIT_OK, out, note, flagStr, flagBool } from './resolve.js';

export const HOOK_LOG_USAGE = 'my-curator hook-log [--limit <n>] [--harness <id>] [--json]';

export function renderHookLog(lines, files) {
  const L = [];
  L.push(`my-curator hook-log — ${lines.length} line${lines.length === 1 ? '' : 's'} shown`);
  L.push(`  from: ${files.join(', ') || '(no log file)'}`);
  if (!lines.length) {
    L.push('  No hook has run on this machine since the log began (v3.77.0), or its log is elsewhere.');
    return L.join('\n');
  }
  for (const l of lines) {
    const when = `${String(l.ts).slice(0, 19).replace('T', ' ')}Z`;
    const outcome = l.decision === 'ask' ? 'ASKED for a save'
      : l.decision === 'inject' ? 'injected the context' : 'did nothing';
    const bits = [
      `${when}  ${l.harness} ${l.event}${l.raw && l.raw !== l.event ? ` (${l.raw})` : ''}`,
      `→ ${outcome}${l.rung !== null && l.rung !== undefined ? ` · rung ${l.rung}` : ''}${l.why ? ` · ${l.why}` : ''}`,
    ];
    L.push(`  ${bits[0]}`);
    L.push(`      ${bits[1]}`);
    const meta = [
      `project ${l.project || '(unresolved)'}`,
      `id ${l.sid ? `${l.sid}… via ${l.idKey}` : 'none sent'}`,
      l.term ? `terminationReason ${l.term}` : null,
      l.bound ? `window bounded by ${l.bound}` : null,
      `payload keys: ${(l.keys || []).join(', ') || '(none)'}`,
    ].filter(Boolean);
    L.push(`      ${meta.join(' · ')}`);
  }
  return L.join('\n');
}

export async function runHookLog(parsed) {
  const { flags } = parsed;
  if (flagBool(flags, 'help')) { out(HOOK_LOG_USAGE); return EXIT_OK; }
  try {
    const { readHookLines } = await import('../brain/hook-log.js');
    const { lines, files } = await readHookLines();
    const n = Number.parseInt(flagStr(flags, 'limit') || '20', 10);
    const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 500) : 20;
    const harness = flagStr(flags, 'harness');
    const picked = (harness ? lines.filter((l) => l.harness === harness) : lines).slice(-limit);
    if (flagBool(flags, 'json')) out(JSON.stringify({ ok: true, files, lines: picked }));
    else out(renderHookLog(picked, files));
  } catch (err) {
    note(`my-curator hook-log could not read the log: ${err.message}`);
  }
  return EXIT_OK;
}
