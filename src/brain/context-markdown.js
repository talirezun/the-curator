/**
 * The session-start MARKDOWN — the readable rendering of a project's
 * bootstrap that `my-curator context` prints and the session-start hook
 * injects. MOVED HERE UNCHANGED from `src/cli/context.js` in v3.67.0 (the four
 * functions below — `classifyContextAuthority`, `renderAuthority`,
 * `renderFramedContextMarkdown`, `renderContextMarkdown`), because the app's
 * session-start preview route must measure the hook's EXACT bytes and
 * `src/routes/**` may not import `src/cli/**` (the v3.63.0 structural
 * guarantee, pinned by scripts/test-cli-curator.js). `src/cli/context.js`
 * re-exports all four under the same names, so `hook.js` and every suite that
 * imports them from there are untouched.
 *
 * v3.67.0 ADDED two things, and only two: one "Reading budget" line under the
 * Foundations heading, and a fenced `foundations_read` JSON block at the end
 * — `{slug: sha256}` over the documents whose text this rendering carries —
 * so a hook-bootstrapped agent CAN record what it read on its next save.
 *
 * It is a pure renderer over a store envelope plus ONE lazy import (the brief
 * classifier in chat.js). It writes nothing and fetches nothing.
 */
// THE SAME WORDING THE MCP SERIALISES (v3.66.0). Zero-import module, so a
// static import costs nothing on the CLI's cold path.
import {
  briefAuthorityNote, BRIEF_AUTHORITIES, BRIEF_AUTHORITY_LABEL, briefIsTrusted, markdownDataLine,
} from './context-framing.js';

/**
 * THE BRIEF'S AUTHORITY, FROM THE SAME CLASSIFIER CHAT USES (v3.66.0).
 *
 * Through v3.65.3 this rendering told every session-start hook "The standing
 * brief is the owner's own" and labelled an unstamped brief "the owner
 * (hand-authored)" without asking whether the project lived in a `shared-*`
 * Shared Brain mirror (other people's text) or whether the brief carried an
 * agent's provenance stamp. The MCP already framed both correctly.
 *
 * The verdict is `classifyChatBriefAuthority` in src/brain/chat.js — the
 * copy of the MCP's module-private `classifyBriefAuthority` that
 * scripts/test-chat-project-context.js §6 already pins verdict-for-verdict to
 * it. It was NOT moved into a shared module: §6 lifts the MCP's function by
 * brace-match and executes it with only `isDomainReadonly` injected, so a
 * body that delegated to an import would throw there. Calling through the
 * existing, already-guarded copy keeps ONE classification with no third copy,
 * and scripts/test-brief-authority-parity.js drives all three readers end to
 * end over the same fixtures.
 *
 * Imported lazily: chat.js pulls in the LLM module, which a `--help` or a
 * refused resolve never needs.
 */
export async function classifyContextAuthority(ctx) {
  if (!ctx?.brief?.present) return null;
  try {
    const { classifyChatBriefAuthority } = await import('./chat.js');
    return await classifyChatBriefAuthority(ctx.domain, ctx.brief);
  } catch {
    // The classifier itself could not be reached — missing evidence, and
    // missing evidence may not buy authority.
    return 'unverified';
  }
}

/** " · written X", plus " · changed on this disk Y" when the two clocks
 *  differ by more than two minutes (see briefStampOf in working-state.js). */
function briefClocks(b) {
  const w = b && typeof b.writtenAt === 'string' && b.writtenAt ? b.writtenAt : null;
  const f = b && typeof b.updatedAt === 'string' && b.updatedAt ? b.updatedAt : null;
  if (!w) return f ? ` · file last changed on this disk ${f} (no written stamp)` : '';
  const differ = f && Number.isFinite(Date.parse(f)) && Math.abs(Date.parse(f) - Date.parse(w)) > 120000;
  return ` · written ${w}` + (differ ? ` · changed on this disk ${f}` : '');
}

/**
 * The verdict a rendering is allowed to use. A caller that did not classify
 * (or passed something that is not one of the five values) gets `unverified`
 * for a present brief — FAIL-SAFE DOWNWARD: the Markdown can never say "the
 * owner's own" unless the classifier said `owner`.
 */
export function renderAuthority(ctx, supplied) {
  if (!ctx?.brief?.present) return null;
  return BRIEF_AUTHORITIES.includes(supplied) ? supplied : 'unverified';
}

/** Classify, then render — what both production callers (this command and
 *  the session-start hook) use. */
export async function renderFramedContextMarkdown(ctx) {
  return renderContextMarkdown(ctx, { authority: await classifyContextAuthority(ctx) });
}

/** The readable form: the same facts, in the order a session needs them. */
export function renderContextMarkdown(ctx, opts = {}) {
  const authority = renderAuthority(ctx, opts?.authority);
  const L = [];
  L.push(`# Project context — ${ctx.domain}/${ctx.project}`);
  L.push('');
  L.push(markdownDataLine(authority));
  L.push('');

  // WHERE THE KNOWLEDGE IS (v3.65.0). `--json` carries `knowledgeDomains`
  // for free — it is the store's envelope verbatim — but a session-start hook
  // injects THIS rendering, so a harness that never sees the JSON would be
  // told where the project's STATE is and left to assume where its KNOWLEDGE
  // is. `knowledgeDomainsDefaulted` is rendered too: a fallback presented as
  // a choice is the one misreading this field can create.
  const kd = Array.isArray(ctx.knowledgeDomains) ? ctx.knowledgeDomains : [];
  if (kd.length) {
    L.push(`_Knowledge for this project lives in the ${kd.length === 1 ? 'wiki' : 'wikis'} of `
      + `${kd.map((d) => `**${d}**`).join(', ')}`
      + `${ctx.knowledgeDomainsDefaulted ? ' — not chosen; this project’s own domain, the default' : ' — the owner’s choice'}._`);
    L.push('');
  }

  if (ctx.brief?.present) {
    L.push('## Standing brief');
    L.push('');
    // THE VERDICT FIRST, then the MCP's own note for it byte for byte
    // (`brief.authority_note` on the wire), then the text — so nothing in the
    // text can precede, and pose as, the framing.
    L.push(`_Authority: **${authority}** — ${BRIEF_AUTHORITY_LABEL[authority]}_`);
    L.push('');
    const by = ctx.brief.authoredBy;
    // `authoredBy` is the file's provenance stamp, or null when there is none.
    // "The owner (hand-authored)" is said ONLY when the classifier said owner:
    // an unstamped brief in a mirror is unstamped, not the owner's.
    const byLabel = typeof by === 'string' ? by
      : by && typeof by === 'object'
        ? [by.kind || by.authority || null, by.harness ? `harness ${by.harness}` : null, by.model ? `model ${by.model}` : null]
          .filter(Boolean).join(' · ') || null
        : null;
    const byText = byLabel || (authority === 'owner' ? 'the owner (hand-authored)' : 'no provenance stamp');
    // v3.76.0 (F2) — TWO CLOCKS, NAMED. `writtenAt` is the time the brief
    // itself says it was written (its provenance stamp or `Updated:` line);
    // `updatedAt` is the file's mtime, which a hand edit, a pull or a restore
    // all move. "updated <mtime>" read a week-old brief restored this morning
    // as written this morning. The file's time is added only when it differs.
    L.push(`_Authored by: ${byText}${briefClocks(ctx.brief)}_`);
    L.push('');
    L.push(briefAuthorityNote(authority));
    L.push('');
    const body = String(ctx.brief.text || '').trim();
    // An UNTRUSTED brief is quoted, so a heading or an "Authority:" line typed
    // into it renders as quoted text rather than as this document's framing.
    L.push(briefIsTrusted(authority) ? body : body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
    L.push('');
  } else {
    L.push('## Standing brief');
    L.push('');
    L.push('_None yet._');
    L.push('');
  }

  L.push(`## Latest handoff${ctx.scope ? ` — scope '${ctx.scope}'` : ''}`);
  L.push('');
  const newest = ctx.journal?.entries?.length ? ctx.journal.entries[0] : null;
  if (ctx.current?.present) {
    if (newest?.headline) L.push(`**${newest.headline}**`);
    // `savedAt` is the file's mtime — the moment it ARRIVED on this disk, which
    // on a synced machine is the pull, not the save. `writtenAt` is the agent's
    // own clock. Both, named, rather than one that quietly means two things.
    const meta = [
      ctx.current.writtenAt ? `written ${ctx.current.writtenAt}` : null,
      ctx.current.savedAt ? `arrived on this disk ${ctx.current.arrivedAt || ctx.current.savedAt}` : null,
      newest?.harness ? `harness ${newest.harness}` : null,
      newest?.model ? `model ${newest.model}` : null,
    ].filter(Boolean);
    if (meta.length) { L.push(''); L.push(`_${meta.join(' · ')}_`); }
    if (ctx.current.headingsSuspect) { L.push(''); L.push(`**${ctx.current.headingsSuspectNote}**`); }
    L.push('');
    L.push(String(ctx.current.text || '').trim());
  } else {
    L.push('_No handoff has been saved for this project yet._');
  }
  L.push('');

  const j = ctx.journal;
  if (j?.entries?.length) {
    L.push(`## Journal — ${j.returned ?? j.entries.length} of ${j.total ?? '?'} past saves`);
    L.push('');
    for (const e of j.entries) {
      L.push(`- ${e.at || '(no time)'} · ${e.headline || '(no headline)'}`);
    }
    L.push('');
  }

  const f = ctx.foundations;
  // v3.68.1 — a manifest a NEWER app wrote is said plainly, with no "could
  // not be read" (an agent reading that may try to repair the file).
  if (f && !f.present && f.manifestErrorCode === 'manifest-newer' && f.manifestError) {
    L.push('## Foundations');
    L.push('');
    L.push(`**${f.manifestError} No documents were returned.**`);
    L.push('');
  }
  if (f?.present && f.count) {
    L.push(`## Foundations — ${f.count} document${f.count === 1 ? '' : 's'}`);
    L.push('');
    // v3.67.0 — WHOSE reading budget decided which texts follow, in one line.
    const rb = readingBudgetLine(f.budget);
    if (rb) { L.push(rb); L.push(''); }
    if (f.hiddenCount > 0) {
      L.push(`_${f.hiddenCount} more document${f.hiddenCount === 1 ? ' is' : 's are'} kept but not listed at session start; the owner can name them._`);
      L.push('');
    }
    if (f.manifestError) {
      L.push(f.manifestErrorCode === 'manifest-newer'   // v3.68.1: not broken, never "could not be read"
        ? `**${f.manifestError} No documents were returned.**`
        : `**The manifest could not be read: ${f.manifestError}. No documents were returned.**`);
    }
    for (const d of f.index || []) {
      const marks = [
        d.readFirst ? 'READ FIRST' : 'on request',
        d.freshness || null,
        d.skeleton ? 'UNFILLED SKELETON — questions, not facts' : null,
        d.changedSinceSeen ? 'changed since last read' : null,
      ].filter(Boolean);
      L.push(`- \`${d.slug}\` · ${d.role || '?'} · ${d.bytes ?? '?'} B · ${marks.join(' · ')}`);
    }
    L.push('');
    const bodies = [...(f.requested || []), ...(f.documents || [])];
    for (const d of bodies) {
      L.push(`### ${d.title || d.slug}`);
      L.push('');
      L.push(`_${d.slug} · ${d.role || '?'}${d.truncated ? ' · CUT at the reading budget' : ''}_`);
      L.push('');
      L.push(String(d.text || '').trim());
      L.push('');
    }
    if (f.budget?.omitted?.length) {
      L.push(`_Omitted for the reading budget: ${f.budget.omitted.join(', ')} — ask for them by name with --slugs._`);
      L.push('');
    }
    if (f.requestedRefused?.length) {
      L.push(`_Not returned, and why: ${f.requestedRefused.map((r) => `${r.slug} (${r.reason})`).join(', ')}._`);
      L.push('');
    }
    // v3.67.0 — WHAT WAS READ, as the map to record. Without it an agent
    // bootstrapped by this rendering (a session-start hook) had no hashes to
    // save as `foundations_read`, so every later session counted every
    // document as new. Only documents whose text is here, and whole.
    const read = {};
    for (const d of bodies) if (d && d.slug && d.sha256 && !d.truncated) read[d.slug] = d.sha256;
    if (Object.keys(read).length) {
      L.push('_Record this as `foundations_read` on your next save:_');
      L.push('');
      L.push('```json foundations_read');
      L.push(JSON.stringify(read));
      L.push('```');
      L.push('');
    }
  } else {
    L.push('## Foundations');
    L.push('');
    L.push('_None yet._');
    L.push('');
  }
  return L.join('\n');
}

/** `Reading budget: 64 KB — the owner's` / `120 KB — the default` /
 *  `Index only — the owner's`. Null when the envelope carries no budget. */
export function readingBudgetLine(budget) {
  if (!budget || !Number.isInteger(budget.maxBytes)) return null;
  const size = budget.maxBytes === 0 ? 'Index only' : `${Math.round(budget.maxBytes / 1024)} KB`;
  const whose = budget.source === 'owner' ? "the owner's"
    : budget.source === 'caller' ? 'asked for with --budget'
      : budget.source === 'whatif' ? 'a preview'
        : 'the default';
  return `Reading budget: ${size} — ${whose}`;
}
