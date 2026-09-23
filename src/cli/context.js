/**
 * `my-curator context` — the bootstrap, to stdout.
 *
 * Calls `getProjectContext()` — the SAME store function `get_project_context`
 * calls, with the same `include` / `slugs` / `max_bytes` options — and writes
 * the result out. `--json` emits the STORE'S ENVELOPE VERBATIM
 * (`JSON.stringify` of what the store returned, no reshaping); the default is
 * a readable Markdown rendering of the same facts, shaped for a context
 * injection.
 *
 * ── WHY `--json` IS THE STORE'S ENVELOPE AND NOT THE MCP TOOL'S ────────────
 * `getProjectContextHandler` in `mcp/tools/working-state.js` wraps the same
 * store reply for a MODEL: it frames the brief with an authority note, adds
 * `content_is_data`, `resolved_by` and a prose `report`, and bounds the whole
 * thing against the 400 KB MCP response guard. Those are properties of the
 * MCP transport and of a model reading it, not facts about the project. A
 * programmatic caller of this command wants the facts, so it gets the store's
 * own envelope — and `scripts/test-cli-curator.js` §2 pins that the two
 * clients agree field for field on every fact the handler forwards untouched
 * (`foundations`, `current`, `journal.entries`, `seen`, `scope`), which is the
 * claim that actually matters: one store, two clients, one answer.
 *
 * ── IT IS A READ. IT WRITES NOTHING ────────────────────────────────────────
 * Including the MCP usage log. A CLI read is not an MCP call, and a line here
 * would make the honesty meter count a session that never opened a bridge —
 * inflating exactly the reading the meter exists to make honest. §5 of the
 * suite fingerprints the log across a run.
 */
import {
  EXIT_OK, EXIT_REFUSED, EXIT_USAGE, out, note, refuse,
  flagStr, flagBool, resolveProjectForCli, renderResolveRefusal, renderStoreRefusal,
} from './resolve.js';
// THE SAME WORDING THE MCP SERIALISES (v3.66.0). Zero-import module, so a
// static import costs nothing on the CLI's cold path.
import {
  briefAuthorityNote, BRIEF_AUTHORITIES, BRIEF_AUTHORITY_LABEL, briefIsTrusted, markdownDataLine,
} from '../brain/context-framing.js';

export const CONTEXT_USAGE =
  'my-curator context [--project <domain/project|project>] [--domain <d>] [--scope <name>]\n'
  + '                   [--json] [--budget <bytes>] [--include index|changed|all]\n'
  + '                   [--slugs a.md,b.md] [--for-hook] [--harness <id>]';

/** `--slugs a,b` or repeated `--slugs a --slugs b`, both to one list. */
function parseSlugs(flags) {
  const raw = flags.slugs;
  if (raw === undefined || raw === true) return undefined;
  const arr = Array.isArray(raw) ? raw : [raw];
  const items = [];
  for (const entry of arr) {
    if (typeof entry !== 'string') continue;
    for (const s of entry.split(',')) {
      const t = s.trim();
      if (t) items.push(t);
    }
  }
  return items.length ? items : undefined;
}

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
    const { classifyChatBriefAuthority } = await import('../brain/chat.js');
    return await classifyChatBriefAuthority(ctx.domain, ctx.brief);
  } catch {
    // The classifier itself could not be reached — missing evidence, and
    // missing evidence may not buy authority.
    return 'unverified';
  }
}

/**
 * The verdict a rendering is allowed to use. A caller that did not classify
 * (or passed something that is not one of the five values) gets `unverified`
 * for a present brief — FAIL-SAFE DOWNWARD: the Markdown can never say "the
 * owner's own" unless the classifier said `owner`.
 */
function renderAuthority(ctx, supplied) {
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
    L.push(`_Authored by: ${byText}${ctx.brief.updatedAt ? ` · updated ${ctx.brief.updatedAt}` : ''}_`);
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
  if (f?.present && f.count) {
    L.push(`## Foundations — ${f.count} document${f.count === 1 ? '' : 's'}`);
    L.push('');
    if (f.manifestError) L.push(`**The manifest could not be read: ${f.manifestError}. No documents were returned.**`);
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
  } else {
    L.push('## Foundations');
    L.push('');
    L.push('_None yet._');
    L.push('');
  }
  return L.join('\n');
}

export async function runContext(parsed) {
  const { flags } = parsed;
  if (flagBool(flags, 'help')) { out(CONTEXT_USAGE); return EXIT_OK; }

  const resolved = await resolveProjectForCli({
    project: flagStr(flags, 'project'),
    domain: flagStr(flags, 'domain'),
    cwd: flagStr(flags, 'cwd') || process.cwd(),
  });
  if (!resolved.ok) return refuse(renderResolveRefusal(resolved), EXIT_USAGE);

  const budget = flagStr(flags, 'budget') || flagStr(flags, 'maxBytes');
  const include = flagStr(flags, 'include');
  if (include && !['index', 'changed', 'all'].includes(include)) {
    return refuse(`--include must be one of index, changed, all — got "${include}".`, EXIT_USAGE);
  }

  const { getProjectContext } = await import('../brain/working-state.js');
  const ctx = await getProjectContext(resolved.domain, resolved.project, {
    scope: flagStr(flags, 'scope') || undefined,
    include: include || undefined,
    slugs: parseSlugs(flags),
    maxBytes: budget !== null ? Number(budget) : undefined,
  });
  if (!ctx.ok) return refuse(renderStoreRefusal(ctx), EXIT_REFUSED);

  if (flagBool(flags, 'forHook')) {
    // The harness's session-start envelope, and nothing else. The shape is the
    // adapter's — a harness whose envelope is unverified gets NOTHING rather
    // than a guess at another harness's shape (Decision C's corollary).
    const { sessionStartEnvelope, harnessEntry } = await import('./hook.js');
    const id = flagStr(flags, 'harness');
    const entry = harnessEntry(id);
    if (!entry) {
      note(`--for-hook needs a --harness this build knows. Unknown: "${id || '(none)'}". Nothing was emitted.`);
      return EXIT_OK;
    }
    const env = sessionStartEnvelope(entry, await renderFramedContextMarkdown(ctx));
    if (env === null) {
      note(`No session-start envelope is shipped for "${entry.id}": ${entry.sessionStart?.withheld || 'unverified'}. Nothing was emitted.`);
      return EXIT_OK;
    }
    out(JSON.stringify(env));
    return EXIT_OK;
  }

  if (flagBool(flags, 'json')) {
    out(JSON.stringify(ctx));
    return EXIT_OK;
  }
  out(await renderFramedContextMarkdown(ctx));
  return EXIT_OK;
}
