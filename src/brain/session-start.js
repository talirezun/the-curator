/**
 * src/brain/session-start.js — WHAT AN AGENT RECEIVES AT SESSION START,
 * MEASURED. The one measurement behind three consumers (v3.70.0):
 *
 *   · GET  /api/memory/:d/:p/session-start          (the Context view, step ④)
 *   · POST /api/memory/:d/:p/session-start/preview  (a what-if; writes nothing)
 *   · getTraySummary().sessionStart                 (the menubar widget)
 *
 * Moved here from src/routes/memory.js (v3.67.0's `sessionStartReport`) so the
 * tray, which lives in src/brain/, can call the SAME function — a brain module
 * may not import a route. The route is a thin wrapper now.
 *
 * ── MEASURED, NEVER ESTIMATED — EXCEPT THE ONE ESTIMATE THAT SAYS SO ──────
 * The MCP figure is the REAL `get_project_context` handler's reply, called
 * DIRECTLY rather than through the MCP dispatcher, so a measurement is never
 * logged as a session in the usage log. Since v3.70.0 a large bootstrap is
 * PAGED (≤ 80 KB per reply), so the figure is `replyDelivery(out).totalBytes`
 * — every page's measured bytes — and the per-layer split reads the document
 * text of EVERY page, not page 1's alone. The hook figure is the REAL
 * session-start Markdown (`renderFramedContextMarkdown`).
 *
 * Tokens now ride on the wire BESIDE the bytes (v3.70.0 made tokens the
 * primary unit on screen). Every `tokens` field is `estimateTokens(bytes)` —
 * the store's ONE estimator, four bytes a token — so the app, the widget and
 * the kit cannot each round differently. The view still prefixes "≈".
 *
 * ── WHY THE HANDLER IS A DYNAMIC IMPORT ───────────────────────────────────
 * `src/brain/` imports nothing from `mcp/` statically (context-framing.js
 * exists to keep that direction). This module MEASURES that door's reply, so
 * it has to reach it; it does so lazily, exactly as the route did, and the
 * handler's own static graph reaches no `sync.js` and no `child_process`
 * (scripts/test-session-start.js walks it, so the tray's no-network
 * guarantee survives this module joining its graph).
 *
 * ── IT IS A READ ─────────────────────────────────────────────────────────
 * Nothing is written anywhere: no state file, no manifest, no usage-log line,
 * no config. The window and harness figures are READ from the install's
 * config (src/brain/config.js `getContextWindowSettings`).
 */
import * as workingStore from './working-state.js';
import { renderFramedContextMarkdown } from './context-markdown.js';
import { getContextWindowSettings } from './config.js';

/**
 * v3.76.0 — the hook injects one line naming the tool it runs for and that
 * tool's own save scope (context-markdown.js `saveTargetLine`), so the real
 * bytes depend on the tool by a few characters. The figure is measured AS
 * CLAUDE CODE'S hook — the tool the hooks ship verified for first — with the
 * scope a Claude Code save with no scope lands in, never a retyped literal.
 */
export const HOOK_MEASURE_TARGET = Object.freeze({
  tool: 'Claude Code', scope: workingStore.defaultScopeFor('claude-code').scope, configured: false,
});

/** Each layer's own named cap, for the monitor's depth bars. v3.72.1 (truth
 *  audit F8): DERIVED from the store's own limits rather than retyped, so step
 *  ②'s handoff budget (the route's `stateBudgetBytes`, also MAX_STATE_BYTES)
 *  and step ④'s can never quote two different numbers. */
export const SESSION_BRIEF_CAP = workingStore.MAX_BRIEF_BYTES;
export const SESSION_HANDOFF_CAP = workingStore.MAX_STATE_BYTES;
/** The MCP door's per-reply guard (mcp/tools/working-state.js RESPONSE_BUDGET_BYTES,
 *  a module-private constant; scripts/test-session-start.js pins the two equal). */
export const SESSION_REPLY_CAP = 307200;
/** The Lean preset's bytes — the cost line's threshold ("handed more than the
 *  Lean preset"). Off the store's ladder, never a literal (F8). */
export const SESSION_LEAN_BYTES = workingStore.READING_BUDGET_PRESETS.find((p) => p.id === 'lean').bytes;
/** Chat's ceiling on project-context text (src/brain/chat.js
 *  PROJECT_CONTEXT_BUDGET_CHARS). A copy, not an import: chat.js reaches the
 *  model layer, and the tray imports this module under a no-network guarantee
 *  (scripts/test-session-start.js walks the graph). The same suite pins the
 *  two equal, so the figure step ④ shows for Chat cannot drift (F7). */
export const SESSION_CHAT_CEILING_CHARS = 40000;

/** The layers IN THE WINDOW, in drawing order. `readFirst` is the document text. */
export const SESSION_LAYER_KEYS = Object.freeze(['framing', 'brief', 'handoff', 'journal', 'index', 'readFirst']);
/** The bucket kit's name for each layer key (src/public/next/shared/bucket.js LAYER_KEYS). */
const KIT_KEY = Object.freeze({ framing: 'framing', brief: 'brief', handoff: 'handoff', journal: 'journal', index: 'index', readFirst: 'read' });

const utf8 = (x) => Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x ?? null), 'utf8');
/** Exactly as mcp/tools/index.js serialises a reply. */
const mcpSize = (obj) => Buffer.byteLength(JSON.stringify(obj, null, 2), 'utf8');
const tok = (b) => workingStore.estimateTokens(b);
const int0 = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

/**
 * Which preset the budget in force IS — `{preset, custom, nearest}`.
 * An UNPLANNED project (source `default`) has no preset: its figure is the
 * store's 120 KB default for any document, not a reading budget the owner set,
 * so `preset` is null rather than a "custom" the owner never chose.
 */
export function budgetPresetOf(bytes, source) {
  if (source === 'default') return { preset: null, custom: false, nearest: null };
  const p = workingStore.readingBudgetPreset(bytes);
  if (!p) return { preset: null, custom: false, nearest: null };
  return { preset: p.id, custom: p.custom === true, nearest: p.custom ? p.nearest : null };
}

/**
 * The session-start report.
 *
 * `whatIf` is the store's internal option (`{ownerBudgetBytes?, startStates?}`),
 * reached only from the preview route. `opts.presets === false` skips the
 * seven what-if runs, `opts.hook === false` skips the Markdown door — the tray
 * asks for neither. `opts.settings` replaces the config read (a test seam).
 */
export async function sessionStartReport(domain, project, whatIf = null, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const withPresets = o.presets !== false;
  const withHook = o.hook !== false;
  const store = workingStore;
  const { getProjectContextHandler, replyDelivery } = await import('../../mcp/tools/working-state.js');
  const run = (wi, page) => getProjectContextHandler(
    page ? { domain, project, page } : { domain, project }, null, wi ? { whatIf: wi } : {});

  const out = await run(whatIf);
  if (!out || out.ok !== true) return { ok: false, reason: out?.reason || 'io', error: out?.error || 'unreadable' };
  const f = out.foundations || {};
  const delivery = replyDelivery(out);
  const mcp = delivery ? delivery.totalBytes : mcpSize(out);

  // EVERY PAGE'S DOCUMENTS. Page 1 carries only the documents that fit beside
  // the brief, handoff, journal and index; pages 2..N carry the rest. A split
  // read off page 1 alone would count page 2's documents "on request".
  const sent = Array.isArray(f.documents) ? [...f.documents] : [];
  // The reply each document actually arrived in — the fallback for a page the
  // delivery plan does not name (v3.70.1's per-document entries).
  const arrivedOn = new Map(sent.map((d) => [d && d.slug, 1]));
  const tooLarge = [];
  const notes = [];
  let pagesUnread = 0;
  for (let pg = 2; delivery && pg <= delivery.replies; pg++) {
    const r = await run(whatIf, pg);
    if (!r || r.ok !== true || !r.foundations) { pagesUnread++; continue; }
    if (Array.isArray(r.foundations.documents)) {
      for (const d of r.foundations.documents) if (d && !arrivedOn.has(d.slug)) arrivedOn.set(d.slug, pg);
      sent.push(...r.foundations.documents);
    }
    if (Array.isArray(r.foundations.tooLarge)) tooLarge.push(...r.foundations.tooLarge);
  }
  if (pagesUnread) notes.push(`${pagesUnread} later page${pagesUnread === 1 ? '' : 's'} could not be read for the split; the total is still the measured one.`);

  // THE HOOK DOOR: the store envelope the hook reads (no caller budget, the
  // store's own journal default), rendered by the real function.
  let hook = null;
  if (withHook) {
    const ctx = await store.getProjectContext(domain, project, whatIf ? { whatIf } : {});
    hook = ctx && ctx.ok === true ? utf8(await renderFramedContextMarkdown(ctx, { saveTarget: HOOK_MEASURE_TARGET })) : 0;
  }

  // "Not at start" documents are absent from the reply by design; their size
  // comes from the index, with the what-if plan applied the same way.
  const list = await store.listFoundations(domain, out.project);
  const listed = list && list.ok !== false && Array.isArray(list.documents) ? list.documents : [];
  const plan = whatIf && whatIf.startStates && typeof whatIf.startStates === 'object' ? whatIf.startStates : null;
  const stateOf = (d) => (plan && Object.prototype.hasOwnProperty.call(plan, d.slug) ? plan[d.slug] : d.atStart);
  const hiddenDocs = listed.filter((d) => stateOf(d) === 'not-at-start');
  const readFirstPlanned = listed.filter((d) => stateOf(d) === 'read-first');

  const rows = Array.isArray(f.index) ? f.index : [];
  const sizeOf = new Map(rows.map((r) => [r.slug, int0(r.bytes)]));
  for (const d of listed) if (!sizeOf.has(d.slug)) sizeOf.set(d.slug, int0(d.bytes));
  const sentSlugs = new Set(sent.map((d) => d.slug));
  const tooLargeSlugs = new Set(tooLarge.map((t) => t && t.slug).filter((x) => typeof x === 'string'));
  const omittedSlugs = Array.isArray(f.budget?.omitted) ? f.budget.omitted.filter((x) => typeof x === 'string') : [];
  const omittedSet = new Set(omittedSlugs);
  const readFirstSent = sent.filter((d) => d.readFirst === true);
  const otherSent = sent.filter((d) => d.readFirst !== true);
  const onRequest = rows.filter((r) => !sentSlugs.has(r.slug) && !omittedSet.has(r.slug) && !tooLargeSlugs.has(r.slug));
  const textBytes = (arr) => arr.reduce((n, d) => n + utf8(d.text || ''), 0);

  const tiers = {
    brief: { bytes: out.brief?.present ? utf8(out.brief.text || '') : 0, present: out.brief?.present === true, capBytes: SESSION_BRIEF_CAP },
    handoff: { bytes: out.current?.present ? utf8(out.current.text || '') : 0, present: out.current?.present === true, capBytes: SESSION_HANDOFF_CAP },
    journal: {
      bytes: Array.isArray(out.journal?.entries) && out.journal.entries.length ? utf8(out.journal.entries) : 0,
      lines: Array.isArray(out.journal?.entries) ? out.journal.entries.length : 0,
    },
    index: { bytes: rows.length ? utf8(rows) : 0, listed: rows.length, hiddenCount: Number.isInteger(f.hiddenCount) ? f.hiddenCount : 0 },
    readFirst: {
      bytes: textBytes(readFirstSent), count: readFirstSent.length,
      budgetBytes: Number.isInteger(f.readFirstBudgetBytes) ? f.readFirstBudgetBytes : 0,
      exceeded: f.readFirstBudgetExceeded === true,
    },
    otherText: { bytes: textBytes(otherSent), count: otherSent.length },
    onRequest: { bytes: onRequest.reduce((n, r) => n + (sizeOf.get(r.slug) || 0), 0), count: onRequest.length },
    omitted: { bytes: omittedSlugs.reduce((n, sl) => n + (sizeOf.get(sl) || 0), 0), count: omittedSlugs.length, slugs: omittedSlugs.slice(0, 200) },
    hidden: { bytes: hiddenDocs.reduce((n, d) => n + int0(d.bytes), 0), count: hiddenDocs.length },
    domainPages: { domains: Array.isArray(out.knowledgeDomains) ? out.knowledgeDomains.slice(0, 12) : [], bytes: 0 },
    framing: { bytes: 0 },
  };
  const counted = tiers.brief.bytes + tiers.handoff.bytes + tiers.journal.bytes + tiers.index.bytes
    + tiers.readFirst.bytes + tiers.otherText.bytes;
  // "Framing and structure": labels, the report, the authority note, the
  // JSON keys and indentation, and (paged) every later page's envelope —
  // everything delivered that is not a tier. So the parts add up to the whole.
  tiers.framing.bytes = Math.max(0, mcp - counted);

  const b = f.budget || {};
  const source = ['owner', 'default', 'whatif', 'caller'].includes(b.source) ? b.source : 'default';
  const sentText = tiers.readFirst.bytes + tiers.otherText.bytes;
  const planned = f.planned === true;
  const budgetBytes = Number.isInteger(b.maxBytes) ? b.maxBytes : 0;
  const which = budgetPresetOf(budgetBytes, source);
  if (out.readingBudgetError) notes.push(String(out.readingBudgetError).slice(0, 300));
  if (f.manifestError) {
    notes.push(f.manifestErrorCode === 'manifest-newer'   // v3.68.1
      ? String(f.manifestError).slice(0, 300)
      : `the foundations manifest could not be read: ${String(f.manifestError).slice(0, 200)}`);
  }
  if (typeof b.bounded === 'string') notes.push(b.bounded);

  // ── THE LAYERS, IN THE WINDOW, IN DRAWING ORDER ────────────────────────
  // An unplanned project sends document text that is not flagged read first
  // (up to the 120 KB default); it is the same layer — document text at the
  // start — and its label says which it is, never "read first" for text the
  // owner did not flag.
  const docLabel = planned || tiers.otherText.count === 0 ? 'read first' : 'documents sent at start';
  const layerBytes = {
    framing: tiers.framing.bytes, brief: tiers.brief.bytes, handoff: tiers.handoff.bytes,
    journal: tiers.journal.bytes, index: tiers.index.bytes, readFirst: sentText,
  };
  const LABEL = { framing: 'framing', brief: 'standing brief', handoff: 'latest handoff', journal: 'journal', index: 'document list', readFirst: docLabel };

  // ── v3.70.1: THE DOCUMENT LAYER, ONE ENTRY PER DOCUMENT ────────────────
  // Every document whose text is in the window, in DELIVERY ORDER (page 1's,
  // then page 2's …), with the reply it arrives in. `page` is the delivery
  // plan's (`replyDelivery(out).pages`, P1's `deliveryPlan`), and the reply the
  // document was actually read from when the plan does not name it. Each
  // entry's bytes are the text it is handed (so the entries ADD UP to the
  // layer), and its title is the index row's. Additive: `documents` (the
  // count) is unchanged.
  const pageOf = new Map();
  for (const p of (delivery ? delivery.pages : [])) {
    for (const sl of (Array.isArray(p.slugs) ? p.slugs : [])) if (!pageOf.has(sl)) pageOf.set(sl, p.page);
  }
  const titleOf = new Map(rows.map((r) => [r.slug, typeof r.title === 'string' ? r.title : null]));
  const entries = sent.filter((d) => d && typeof d.slug === 'string').map((d) => {
    const bytes = utf8(d.text || '');
    const t = titleOf.get(d.slug) || (typeof d.title === 'string' && d.title.trim() ? d.title : null);
    return {
      slug: d.slug, title: (t || d.slug).slice(0, 200), bytes, tokens: tok(bytes),
      page: pageOf.get(d.slug) || arrivedOn.get(d.slug) || 1,
      readFirst: d.readFirst === true,
    };
  });
  const layers = SESSION_LAYER_KEYS.map((key) => ({
    key, label: LABEL[key], bytes: layerBytes[key], tokens: tok(layerBytes[key]),
    ...(key === 'readFirst' ? { documents: tiers.readFirst.count + tiers.otherText.count, entries } : {}),
  }));
  // The kit's segments for the same layer: a short name (the slug without
  // `.md`), the title for the segment's tooltip, and the reply it arrives in.
  const parts = entries.map((e) => ({ label: e.slug.replace(/\.md$/, ''), title: e.title, tokens: e.tokens, page: e.page }));

  // ── THE DELIVERY: how many MCP replies, each page's measured size ───────
  const pageBytes = delivery ? delivery.pageBytes : workingStore.CONTEXT_PAGE_BYTES;
  const deliveryOut = {
    pageBytes, pageTokens: tok(pageBytes),
    replies: delivery ? delivery.replies : 1,
    paged: delivery ? delivery.paged === true : false,
    totalBytes: mcp, totalTokens: tok(mcp),
    pages: (delivery ? delivery.pages : []).map((p) => ({
      page: p.page, slugs: Array.isArray(p.slugs) ? p.slugs.slice(0, 200) : [], bytes: int0(p.bytes), tokens: tok(int0(p.bytes)), oversize: p.oversize === true,
    })),
    tooLarge: tooLarge.slice(0, 50).map((t) => ({ slug: String(t.slug), bytes: int0(t.bytes), tokens: tok(int0(t.bytes)) })),
  };

  // ── EVERY PRESET, SAME PLAN — one what-if run each ──────────────────────
  // Carries enough to show a TRUE difference between presets, and to say
  // plainly when there is none because nothing is read first.
  let presets = [];
  let presetsSummary = null;
  if (withPresets) {
    for (const p of workingStore.READING_BUDGET_PRESETS) {
      const wi = { ...(whatIf || {}), ownerBudgetBytes: p.bytes };
      const r = await run(wi);
      const d = r && r.ok === true ? replyDelivery(r) : null;
      const slugs = d ? d.pages.flatMap((pg) => pg.slugs) : [];
      const docBytes = slugs.reduce((n, sl) => n + (sizeOf.get(sl) || 0), 0);
      const om = r && r.ok === true && Array.isArray(r.foundations?.budget?.omitted) ? r.foundations.budget.omitted.length : 0;
      presets.push({
        id: p.id, bytes: p.bytes, tokens: p.tokens,
        mcpBytes: d ? d.totalBytes : null, mcpTokens: d ? tok(d.totalBytes) : null,
        replies: d ? d.replies : null,
        documents: slugs.length, documentBytes: docBytes, documentTokens: tok(docBytes),
        omitted: om,
        current: which.preset === p.id && !which.custom,
        _set: d ? slugs.join('\n') : null,
      });
    }
    // "THE SAME" MEANS THE SAME DOCUMENTS, not the same byte count: the
    // report's own sentence names the budget ("within 32 KB"), so two presets
    // that hand over exactly the same text still differ by a few bytes of
    // framing. A preset card must not claim a difference that is only digits.
    presets = presets.map((p, i) => {
      const { _set, ...row } = p;
      return { ...row, sameAsPrevious: i > 0 && _set !== null && _set === presets[i - 1]._set };
    });
    const allEqual = presets.every((p, i) => p.mcpBytes !== null && (i === 0 || p.sameAsPrevious));
    const rfBytes = readFirstPlanned.reduce((n, d) => n + int0(d.bytes), 0);
    presetsSummary = {
      allEqual,
      reason: allEqual ? (readFirstPlanned.length === 0 ? 'nothing-read-first' : 'budget-not-binding') : null,
      readFirstDocuments: readFirstPlanned.length,
      readFirstBytes: rfBytes,
      readFirstTokens: tok(rfBytes),
    };
  }

  const settings = o.settings && typeof o.settings === 'object' ? o.settings : getContextWindowSettings();
  const windowTokens = settings.contextWindowTokens;
  const harnessTokens = Number.isInteger(settings.harnessEstimateTokens) ? settings.harnessEstimateTokens : null;
  const onDemand = {
    documents: tiers.onRequest.count, bytes: tiers.onRequest.bytes, tokens: tok(tiers.onRequest.bytes),
    notAtStart: tiers.hidden.count, notAtStartBytes: tiers.hidden.bytes, notAtStartTokens: tok(tiers.hidden.bytes),
  };
  const budget = {
    bytes: budgetBytes, tokens: tok(budgetBytes),
    source, defaulted: source === 'default',
    ownerBytes: Number.isInteger(out.readingBudgetBytes) ? out.readingBudgetBytes : null,
    preset: which.preset, custom: which.custom, nearest: which.nearest,
    cap: workingStore.CONTEXT_MAX_BYTES_CAP, capTokens: tok(workingStore.CONTEXT_MAX_BYTES_CAP),
    replyCapBytes: SESSION_REPLY_CAP,
  };

  return {
    ok: true, domain: out.domain, project: out.project,
    budget,
    planned,
    presets,
    presetsSummary,
    tiers,
    bytes: { mcp, hook },
    tokens: { mcp: tok(mcp), hook: hook === null ? null : tok(hook) },
    layers,
    onDemand,
    delivery: deliveryOut,
    window: {
      tokens: windowTokens, set: settings.contextWindowSet === true, custom: settings.contextWindowCustom === true,
      choices: Array.isArray(settings.choices) ? settings.choices : [],
    },
    harness: { tokens: harnessTokens, set: harnessTokens !== null, estimate: true },
    // The bucket kit's model `m`, ready to pass (src/public/next/shared/bucket.js).
    meter: {
      windowTokens, harnessTokens,
      layers: layers.map((l) => ({ key: KIT_KEY[l.key], label: l.label, tokens: l.tokens,
        ...(l.key === 'readFirst' && parts.length ? { parts } : {}) })),
      budgetTokens: budget.tokens,
      onDemand: { tokens: onDemand.tokens, documents: onDemand.documents },
      delivery: { replies: deliveryOut.replies, replyTokens: deliveryOut.pageTokens },
      preview: whatIf !== null && whatIf !== undefined,
    },
    costLine: { applies: !planned && (f.count || 0) > 0 && sentText > SESSION_LEAN_BYTES, documentTextBytes: sentText },
    // v3.72.1 (truth audit F7): what CHAT is handed, so step ④ shows the real
    // figure — the smaller of this project's reading budget and Chat's ceiling
    // (chat.js `loadProjectContext`) — instead of a typed "≤ 40,000".
    chat: { ceilingChars: SESSION_CHAT_CEILING_CHARS,
      effectiveChars: Math.min(budgetBytes, SESSION_CHAT_CEILING_CHARS) },
    notes,
  };
}

/**
 * The widget's projection of a report — the SAME numbers the app shows, and
 * nothing the app does not (the parity rule). No per-preset table, no hook
 * figure: the widget draws neither, and the tray asks the report for neither.
 */
export function sessionStartBrief(report) {
  if (!report || report.ok !== true) return null;
  return {
    domain: report.domain, project: report.project,
    planned: report.planned,
    bytes: report.bytes.mcp, tokens: report.tokens.mcp,
    layers: report.layers.map((l) => ({ key: l.key, label: l.label, bytes: l.bytes, tokens: l.tokens })),
    budget: {
      bytes: report.budget.bytes, tokens: report.budget.tokens, source: report.budget.source,
      preset: report.budget.preset, custom: report.budget.custom, nearest: report.budget.nearest,
    },
    onDemand: { documents: report.onDemand.documents, tokens: report.onDemand.tokens },
    delivery: { replies: report.delivery.replies, paged: report.delivery.paged, pageTokens: report.delivery.pageTokens },
    window: { tokens: report.window.tokens, set: report.window.set },
    harness: { tokens: report.harness.tokens, set: report.harness.set },
    meter: report.meter,
  };
}
