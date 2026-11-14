/**
 * src/brain/page-merge.js — the text of a merge that DELETES a page.
 *
 * Pure: strings in, strings out, no filesystem, nothing on stdout (the MCP
 * reaches this module). `health.js` stays the only place a merge touches disk.
 *
 * WHY THIS EXISTS (the data-loss hotfix). Every Health merge used to take the
 * LONGER page as the base and copy over only the other page's `- ` bullets in
 * eleven named sections. So the shorter page's opening and every non-bullet
 * section vanished, and when the REMOVED page was longer the kept page's own
 * title, frontmatter and prose vanished under the kept name. "Keep X" on screen
 * chose a file name, not the text. Nothing recorded a reason for "longer wins"
 * beyond the v2.2.0 first draft; it only ever chose which text to throw away.
 *
 * THE RULE. The kept page is the base and its lines are not edited, except:
 *   - frontmatter `tags` gain what the other page adds, and `type` follows the
 *     kept folder. Every other byte of the block stays, line endings included:
 *     foreign vaults keep nested YAML, dates, quoted values and keys this module
 *     has no opinion on, and what it does not understand it does not rewrite;
 *   - the removed page's content that the kept page lacks is added.
 * From the removed page:
 *   - a top-level `- ` bullet (with its indented children) directly under a
 *     `## X` goes into the kept page's `## X`. One of the eleven accumulating
 *     sections is created if the kept page lacks it;
 *   - everything else goes under `## Merged from <page>`: the opening, prose,
 *     tables, code fences, and sections with no match, whole and in order.
 *
 * THREE DECISIONS THAT LOOK LIKE MISTAKES, AND ARE NOT:
 *
 * 1. Headings moved under `## Merged from` drop one level (`## X` → `### X`,
 *    `# T` → `### T`). It is the one edit to moved text, and it protects it:
 *    files.js's `extractSectionMap` (mergeWikiPage's prose preservation) ends a
 *    section at `#`, so a verbatim title would make a later ingest drop what
 *    follows it, and a verbatim `## X` would be a section the next ingest's own
 *    `## X` replaces. Under one heading the whole block survives. Lines inside
 *    a code fence are never touched, `# comments` included.
 *
 * 2. A bullet whose first link matches a DIFFERENT kept bullet goes under
 *    `## Merged from`, not into the section. Today's `dedupKey` keys a bullet
 *    on its first link, so `- [[alice]] left in 2005` was dropped next to
 *    `- Founded by [[alice]]`. That was text loss too. It cannot sit in the
 *    section either, because `deduplicateBulletSections` applies the same key
 *    on the next writePage. A bare `- [[alice]]` adds no text and is dropped.
 *
 * 3. "Already there" means the same lines, consecutive, anywhere in the kept
 *    body (trailing spaces and line endings aside). That is what makes a second
 *    identical merge return its input unchanged, and what stops text repeating.
 *    It is never fuzzy: a near-identical paragraph is kept.
 *
 * `findLostLines` is a second, deliberately dumb check that does not use the
 * tokenizer. health.js refuses to delete a page if it finds anything, so a shape
 * of markdown nobody thought of costs a refused merge rather than someone's text.
 */

import { dedupKey } from './files.js';

/** The sections that get a same-named section created. mergeBulletSections' list. */
const ACCUMULATING = new Set([
  'related', 'key facts', 'key ideas', 'key points', 'key takeaways', 'entities mentioned',
  'concepts introduced or referenced', 'applications', 'examples', 'definition', 'how it works',
]);

/** Carried by rule, or dates of the deleted file: never moved as text. */
const BOOKKEEPING_KEYS = new Set(['type', 'tags', 'created', 'updated']);

const HEADING_RE = /^(#{1,6})[ \t]+(\S.*?)[ \t]*$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ANY_INDENT_FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
const BARE_LINK_BULLET_RE = /^-\s+\[\[([^\]|]+)\]\]\s*$/;

/**
 * A top-level YAML key, as a foreign vault writes it: `due date:`, `review.status:`,
 * `größe:`, `日本語:`, `"quoted key":`. `key:value` with no space is not YAML, but this
 * module always read it as a key, and a page may hold one. Returns the key, unquoted,
 * and where its value starts; null for anything else, which includes every markdown
 * shape a rule pair could hold (a bullet, a table, a quote, a link reference).
 */
const BARE_KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):/;
const QUOTED_KEY_RE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)')[ \t]*:(?=[ \t]|$)/;
const PLAIN_KEY_RE = /^([^\s#:\-?!&*|>%`'"{}[\],](?:[^:]|:(?=\S))*?)[ \t]*:(?=[ \t]|$)/;
const noCR = (line) => line.replace(/\r$/, '');

function fmKey(rawLine) {
  const line = noCR(rawLine);
  const bare = line.match(BARE_KEY_RE);
  if (bare) return { key: bare[1], valueAt: bare[0].length };
  const quoted = line.match(QUOTED_KEY_RE);
  if (quoted) return { key: quoted[1] ?? quoted[2], valueAt: quoted[0].length };
  const plain = line.match(PLAIN_KEY_RE);
  return plain ? { key: plain[1], valueAt: plain[0].length } : null;
}

const headingKey = (text) => text.replace(/[ \t]+#+[ \t]*$/, '').trim().toLowerCase();
const isBlank = (line) => line.trim() === '';

function closesFence(line, marker) {
  const t = line.trim();
  return t.length >= marker.length && t[0] === marker[0] && new RegExp(`^\\${marker[0]}+$`).test(t);
}

// ── Page → frontmatter + body lines ─────────────────────────────────────────

/**
 * A real frontmatter block only. A page opening with a horizontal rule and a
 * later `---` must stay body text, or its lines would be treated as metadata.
 *
 * It is frontmatter when every line has a YAML shape, or when it opens with a key.
 * The second clause is what a markdown reader does with a block YAML cannot parse:
 * calling such a block body text gave the page a SECOND frontmatter block on the next
 * write, for good, because the composers then build a fresh one above it.
 *
 * Frontmatter lines are split on `\n` alone, so a `\r` stays on its line, and the
 * two fence lines are carried as written: joined with `\n` they are the file's bytes.
 */
function splitPage(text) {
  const raw = String(text ?? '').replace(/^\ufeff/, '');
  const rawLines = raw.split('\n');
  if (rawLines[0].trimEnd() === '---') {
    for (let j = 1; j < rawLines.length; j++) {
      if (rawLines[j].trimEnd() !== '---') continue;
      const fm = rawLines.slice(1, j);
      const firstReal = fm.find((l) => !isBlank(l) && !/^#/.test(l));
      const looksLikeYaml = fm.every((l) => isBlank(l) || fmKey(l) || /^[ \t]/.test(l) || /^- /.test(l) || /^#/.test(l))
        || (firstReal !== undefined && fmKey(firstReal));
      if (looksLikeYaml) {
        return {
          hasFrontmatter: true, frontmatter: fm, open: rawLines[0], close: rawLines[j],
          body: rawLines.slice(j + 1).join('\n').split(/\r?\n/),
        };
      }
      break;
    }
  }
  return { hasFrontmatter: false, frontmatter: [], body: raw.split(/\r?\n/) };
}

/** What goes above the body. A kept block keeps its own fences and line endings. */
function headText(keep, fmLines, eol) {
  if (fmLines === null) return '';
  if (keep.hasFrontmatter) return [keep.open, ...fmLines, keep.close].join('\n') + '\n';
  return ['---', ...fmLines, '---'].join(eol) + eol;
}

/** Frontmatter lines → entries; a key owns the indented or `- ` lines under it. */
function frontmatterEntries(fm) {
  const entries = [];
  for (const line of fm) {
    const k = fmKey(line);
    if (k) entries.push({ key: k.key, valueAt: k.valueAt, lines: [line] });
    else if (entries.length) entries[entries.length - 1].lines.push(line);
    else entries.push({ key: null, lines: [line] });
  }
  return entries;
}

const isTagsEntry = (e) => e.key !== null && e.key.toLowerCase() === 'tags';

/** Split on commas outside quotes. */
function splitFlowItems(inner) {
  const items = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') { cur += inner[++i] ?? ''; continue; }
      if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && cur.trim() === '') {
      quote = c;
      cur += c;
    } else if (c === ',') {
      items.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  items.push(cur);
  return items;
}

function cleanTag(item) {
  const t = item.trim();
  const q = t.match(/^(["'])(.*)\1$/);
  return q ? q[2] : t.replace(/[ \t]+#.*$/, '');
}

/**
 * How a `tags` entry is written. `unknown` means this module cannot add to it
 * without guessing, so it is left exactly as it is.
 */
function tagShape(entry) {
  const lines = entry.lines.map(noCR);
  const value = lines[0].slice(entry.valueAt).trim();
  const rest = lines.slice(1).filter((l) => !isBlank(l));
  if (value === '' && rest.length === 0) return { form: 'empty', items: [] };
  if (value === '') {
    const items = rest.filter((l) => !/^\s*#/.test(l));
    if (!items.length || !items.every((l) => /^\s*-\s+\S/.test(l))) return { form: 'unknown', items: [] };
    return { form: 'block', items: items.map((l) => cleanTag(l.replace(/^\s*-\s+/, ''))) };
  }
  if (value.startsWith('[')) {
    const joined = [value, ...rest.map((l) => l.trim())].join(' ');
    const m = joined.match(/^\[(.*)\](?:[ \t]+#.*)?$/);
    if (!m) return { form: 'unknown', items: [] };
    return { form: 'flow', items: splitFlowItems(m[1]).map(cleanTag).filter(Boolean) };
  }
  if (rest.length || /^[{|>&!*]/.test(value)) return { form: 'unknown', items: [] };
  const comment = value.match(/[ \t]+#.*$/);
  const scalar = comment ? value.slice(0, comment.index) : value;
  return {
    form: 'scalar', comment: comment ? comment[0] : '',
    items: splitFlowItems(scalar).map(cleanTag).filter(Boolean),
    spelled: splitFlowItems(scalar).map((x) => x.trim()).filter(Boolean),
  };
}

const parseTags = (entry) => (entry ? [...new Set(tagShape(entry).items)] : []);

/** A tag this module adds, quoted only when YAML would misread it bare. */
const spellTag = (t) => (/^[\p{L}\p{N}_./-]+$/u.test(t) ? t : JSON.stringify(t));

/**
 * The `tags` entry with the `type/` tag following the folder and `added` appended.
 * Only those edits: what is there keeps its spelling, quotes, spacing and comments.
 * Null when the entry's shape is unknown.
 */
function editTagEntry(entry, shape, otherType, wantType, added, cr) {
  if (shape.form === 'unknown') return null;
  const swap = otherType
    ? (l) => l.replace(new RegExp(`(^|[\\s\\[,"'])type/${otherType}(?=$|[\\s\\],"'#])`, 'g'), `$1type/${wantType}`)
    : (l) => l;
  const lines = entry.lines.map(noCR);
  const body = [lines[0].slice(0, entry.valueAt) + swap(lines[0].slice(entry.valueAt)), ...lines.slice(1).map(swap)];
  const spelled = added.map(spellTag);
  if (spelled.length) {
    if (shape.form === 'empty') {
      body[0] = `${body[0].trimEnd()} [${spelled.join(', ')}]`;
    } else if (shape.form === 'scalar') {
      const items = shape.spelled.map(swap);
      body[0] = `${body[0].slice(0, entry.valueAt)} [${[...items, ...spelled].join(', ')}]${shape.comment}`;
    } else if (shape.form === 'block') {
      let last = body.length - 1;
      while (last > 0 && !/^\s*-\s+\S/.test(body[last])) last--;
      const indent = (body[last].match(/^(\s*)-/) || [, '  '])[1];
      body.splice(last + 1, 0, ...spelled.map((t) => `${indent}- ${t}`));
    } else {
      let last = body.length - 1;
      while (last > 0 && !body[last].includes(']')) last--;
      const at = body[last].lastIndexOf(']');
      const before = body[last].slice(0, at);
      const kept = before.trimEnd();
      const gap = before.slice(kept.length);
      const sep = shape.items.length === 0 ? '' : ', ';
      body[last] = `${kept}${sep}${spelled.join(', ')}${gap}${body[last].slice(at)}`;
    }
  }
  // The original line's own ending where the line is still there; a new line takes the block's.
  return body.map((l, i) => {
    const orig = entry.lines.find((o) => noCR(o) === l);
    if (orig !== undefined) return orig;
    return l + (i < entry.lines.length && entry.lines[i].endsWith('\r') ? '\r' : cr);
  });
}

function composeFrontmatter(keep, remove, wantType) {
  const otherType = wantType === 'entity' ? 'concept' : wantType === 'concept' ? 'entity' : null;
  const typeTag = (t) => (otherType && t === `type/${otherType}` ? `type/${wantType}` : t);
  // New lines take the block's own line ending.
  const cr = keep.frontmatter.filter((l) => l.endsWith('\r')).length * 2 > keep.frontmatter.length ? '\r' : '';

  const keepEntries = frontmatterEntries(keep.frontmatter);
  const removeEntries = frontmatterEntries(remove.frontmatter);
  const keepTagEntry = keepEntries.find(isTagsEntry);
  const before = parseTags(keepTagEntry);
  const incoming = parseTags(removeEntries.find(isTagsEntry)).map(typeTag);
  const union = [...new Set([...before.map(typeTag), ...incoming])];
  const had = new Set(before.map(typeTag));
  const newTags = union.filter((t) => !had.has(t));
  const typeTagMoves = before.some((t) => typeTag(t) !== t);

  const comparable = (e) => e.lines.filter((l) => !isBlank(l)).map((l) => l.trimEnd()).join('\n');
  const added = [];
  const conflicts = [];
  for (const e of removeEntries) {
    if (e.key !== null && (BOOKKEEPING_KEYS.has(e.key) || isTagsEntry(e))) continue;
    const mine = e.key === null ? null : keepEntries.find((k) => k.key === e.key);
    const text = e.lines.filter((l) => e.key !== null || !isBlank(l)).map(noCR);
    if (!mine) {
      if (e.key === null) conflicts.push(...text);
      else added.push(...text);
    } else if (comparable(mine) !== comparable(e)) {
      conflicts.push(...text);
    }
  }

  if (!keep.hasFrontmatter) {
    if (!union.length && !added.length) return { lines: null, conflicts };
    const lines = [];
    if (wantType) lines.push(`type: ${wantType}`);
    if (union.length) lines.push(`tags: [${union.map(spellTag).join(', ')}]`);
    return { lines: [...lines, ...added], conflicts };
  }

  const lines = [];
  for (const e of keepEntries) {
    if (e === keepTagEntry && (newTags.length || typeTagMoves)) {
      const edited = editTagEntry(e, tagShape(e), otherType, wantType, newTags, cr);
      if (edited) lines.push(...edited);
      else {
        // A shape this module cannot add to: the entry stands, and what it would have
        // gained is kept as text. On a deleting merge findLostLines then refuses the
        // delete, because the tag is not in `tags`: nothing goes, and the pages stay.
        lines.push(...e.lines);
        if (newTags.length) conflicts.push(`tags: [${newTags.map(spellTag).join(', ')}]`);
      }
    } else if (e.key === 'type' && otherType && noCR(e.lines[0]).trim().match(new RegExp(`^type:\\s*${otherType}$`))) {
      const first = noCR(e.lines[0]);
      const ending = e.lines[0].endsWith('\r') ? '\r' : '';
      lines.push(first.slice(0, e.valueAt) + first.slice(e.valueAt).replace(otherType, wantType) + ending, ...e.lines.slice(1));
    } else {
      lines.push(...e.lines);
    }
  }
  if (!keepTagEntry && union.length) lines.push(`tags: [${union.map(spellTag).join(', ')}]${cr}`);
  lines.push(...added.map((l) => l + cr));
  return { lines, conflicts };
}

// ── Body → blocks ───────────────────────────────────────────────────────────

/**
 * Whole units only: a fence (a `## x` inside one is not a heading), a bullet
 * with its indented children, or a run of non-blank lines, so a table or a
 * paragraph can never be split. Unclosed fences run to the end of the page,
 * which is what a markdown reader does with them too.
 */
function tokenize(lines) {
  const tokens = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    const open = line.match(FENCE_OPEN_RE);
    if (open) {
      let j = i + 1;
      while (j < lines.length && !closesFence(lines[j], open[1])) j++;
      const closed = j < lines.length;
      let end = closed ? j + 1 : j;
      while (!closed && end > i + 1 && isBlank(lines[end - 1])) end--;
      tokens.push({ kind: 'fence', start: i, end, lines: lines.slice(i, end), closed, marker: open[1] });
      i = end;
      continue;
    }

    const h = line.match(HEADING_RE);
    if (h) {
      tokens.push({ kind: 'heading', start: i, end: i + 1, lines: [line], level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    if (line.startsWith('- ')) {
      let j = i + 1;
      let last = i;
      while (j < lines.length) {
        if (isBlank(lines[j])) {
          let k = j;
          while (k < lines.length && isBlank(lines[k])) k++;
          if (k < lines.length && /^[ \t]/.test(lines[k])) { j = k; continue; }
          break;
        }
        if (!/^[ \t]/.test(lines[j])) break;
        const inner = lines[j].match(ANY_INDENT_FENCE_RE);
        if (inner) {
          j++;
          while (j < lines.length && !closesFence(lines[j], inner[1])) j++;
          if (j >= lines.length) { last = lines.length - 1; break; }
        }
        last = j;
        j++;
      }
      while (last > i && isBlank(lines[last])) last--;
      tokens.push({ kind: 'bullet', start: i, end: last + 1, lines: lines.slice(i, last + 1) });
      i = last + 1;
      continue;
    }

    let j = i + 1;
    while (j < lines.length && !isBlank(lines[j]) && !FENCE_OPEN_RE.test(lines[j])
      && !HEADING_RE.test(lines[j]) && !lines[j].startsWith('- ')) j++;
    tokens.push({ kind: 'para', start: i, end: j, lines: lines.slice(i, j) });
    i = j;
  }
  return tokens;
}

/**
 * Each `## X` name in a tokenized body: where new text goes (its first section)
 * and the bullets it holds (in every section of that name, so a page that repeats
 * a heading is not handed its own bullets back).
 */
function sectionIndex(tokens) {
  const sections = new Map();
  tokens.forEach((t, idx) => {
    if (t.kind !== 'heading' || t.level !== 2) return;
    const key = headingKey(t.text);
    let directEnd = t.end;
    const bullets = [];
    let n = idx + 1;
    for (; n < tokens.length && tokens[n].kind !== 'heading'; n++) {
      directEnd = tokens[n].end;
      if (tokens[n].kind === 'bullet') bullets.push(tokens[n]);
    }
    let sectionEnd = directEnd;
    for (; n < tokens.length; n++) {
      if (tokens[n].kind === 'heading' && tokens[n].level <= 2) break;
      sectionEnd = tokens[n].end;
    }
    if (sections.has(key)) sections.get(key).bullets.push(...bullets);
    else sections.set(key, { directEnd, sectionEnd, bullets });
  });
  return sections;
}

const normLines = (lines) => lines.map((l) => l.trimEnd());
const hayOf = (lines) => '\n' + normLines(lines).join('\n') + '\n';

function demote(token) {
  const level = token.level === 1 ? 3 : Math.min(6, token.level + 1);
  return '#'.repeat(level) + ' ' + token.text;
}

/** Where a bullet's section stands: what it holds, and what this merge adds. */
function bulletTarget(section) {
  const exact = new Set();
  const lower = new Set();
  const keys = new Set();
  const multi = [];
  for (const b of section ? section.bullets : []) {
    exact.add(b.lines[0].trim());
    lower.add(b.lines[0].trim().toLowerCase());
    keys.add(dedupKey(b.lines[0]));
    if (b.lines.length > 1) multi.push(hayOf(b.lines));
  }
  return { exact, lower, keys, multi, inserts: [] };
}

function placeBullet(target, token) {
  const top = token.lines[0];
  const isSingle = token.lines.length === 1;
  const key = dedupKey(top);

  // Same words in another case is not the same text: a capital can be a name. It
  // falls through to `keys`, and so to `## Merged from`.
  if (isSingle && target.exact.has(top.trim())) return 'drop';
  if (!isSingle && target.multi.includes(hayOf(token.lines))) return 'drop';
  if (target.keys.has(key)) {
    return isSingle && BARE_LINK_BULLET_RE.test(top.trim()) ? 'drop' : 'material';
  }
  target.exact.add(top.trim());
  target.lower.add(top.trim().toLowerCase());
  target.keys.add(key);
  if (!isSingle) target.multi.push(hayOf(token.lines));
  target.inserts.push(...token.lines);
  return 'section';
}

// ── The composer ────────────────────────────────────────────────────────────

/**
 * The text the kept page will hold after the merge. The ONLY composer: every
 * deleting merge and the preview call it, so the preview cannot describe a
 * different page than the one written.
 *
 * @param {string} keepText
 * @param {string} removeText
 * @param {object} opts
 * @param {string} opts.sourceLabel  the removed page, as `## Merged from` names it
 * @param {string} [opts.keepFolder] 'entities' | 'concepts': decides `type`
 * @returns {string}
 */
export function composeMergedPage(keepText, removeText, { sourceLabel, keepFolder } = {}) {
  const original = String(keepText ?? '');
  const bom = original.startsWith('﻿') ? '﻿' : '';
  const crlf = (original.match(/\r\n/g) || []).length;
  const lf = (original.match(/\n/g) || []).length;
  const eol = crlf * 2 > lf ? '\r\n' : '\n';

  const keep = splitPage(original);
  const remove = splitPage(removeText);
  const wantType = keepFolder === 'entities' ? 'entity' : keepFolder === 'concepts' ? 'concept' : null;
  const fm = composeFrontmatter(keep, remove, wantType);

  const keepTokens = tokenize(keep.body);
  const sections = sectionIndex(keepTokens);
  // Heading text exactly as written: `# Nvidia` beside `# NVIDIA` is text that moves.
  // `sections` stays case-blind: that only decides where a bullet goes.
  const known = new Set(keepTokens.filter((t) => t.kind === 'heading').map((t) => t.text));
  let hay = hayOf(keep.body);

  const targets = new Map();       // section key → bullet target, kept sections and new ones
  const newSections = new Map();   // section key → the heading text to create
  const material = [];             // blocks for `## Merged from`, in source order

  const accept = (lines, closer) => {
    material.push(closer ? [...lines, closer] : lines);
    hay += normLines(lines).join('\n') + '\n';
  };

  const removeTokens = tokenize(remove.body);
  let pending = [];
  const flushPending = () => { for (const h of pending) accept([h]); pending = []; };
  const placeBlock = (token) => {
    if (hay.includes(hayOf(token.lines))) return;
    flushPending();
    accept(token.lines, token.kind === 'fence' && !token.closed ? token.marker[0].repeat(token.marker.length) : null);
  };

  let group = null;  // { key, canMerge, direct, sawContent, heading, headingHandled }
  const closeGroup = () => {
    if (group && group.heading && !group.sawContent && !known.has(group.heading.text)) {
      flushPending();
      known.add(group.heading.text);
      accept([demote(group.heading)]);
    }
    pending = [];
  };

  for (const t of removeTokens) {
    if (t.kind === 'heading' && t.level <= 2) {
      closeGroup();
      if (t.level === 1) {
        group = null;
        if (!known.has(t.text)) { known.add(t.text); accept([demote(t)]); }
        continue;
      }
      const key = headingKey(t.text);
      const inKept = sections.has(key) || newSections.has(key);
      const canMerge = inKept || ACCUMULATING.has(key);
      group = { key, canMerge, direct: true, sawContent: false, heading: t };
      if (known.has(t.text) || (canMerge && !inKept)) pending.push(demote(t));
      else {
        // Includes a section the kept page has in another case: its bullets go to
        // that section, and this spelling of the heading moves as text.
        known.add(t.text);
        accept([demote(t)]);
        group.heading = null;
      }
      continue;
    }

    if (group) group.sawContent = true;

    if (t.kind === 'heading') {
      if (group) group.direct = false;
      if (known.has(t.text)) pending.push(demote(t));
      else {
        flushPending();
        known.add(t.text);
        accept([demote(t)]);
      }
      continue;
    }

    if (t.kind === 'bullet' && group && group.canMerge && group.direct) {
      if (!targets.has(group.key)) targets.set(group.key, bulletTarget(sections.get(group.key)));
      const where = placeBullet(targets.get(group.key), t);
      if (where === 'section' && !sections.has(group.key) && !newSections.has(group.key)) {
        newSections.set(group.key, group.heading.text);
        known.add(group.heading.text);
      }
      if (where === 'section') hay += normLines(t.lines).join('\n') + '\n';
      if (where !== 'material') continue;
    }

    placeBlock(t);
  }
  closeGroup();

  if (fm.conflicts.length) {
    const block = ['```yaml', ...fm.conflicts, '```'];
    if (!hay.includes(hayOf(block))) {
      if (!known.has('Frontmatter')) { known.add('Frontmatter'); accept(['### Frontmatter']); }
      accept(block);
    }
  }

  // ── Nothing to add? The kept page's bytes stand. ──────────────────────────
  const fmUnchanged = fm.lines === null
    || (keep.hasFrontmatter && fm.lines.join('\n') === keep.frontmatter.join('\n'));
  const hasInserts = [...targets.entries()].some(([, tg]) => tg.inserts.length);
  if (fmUnchanged && !hasInserts && !material.length) return original;

  // ── Into the kept page's own sections, last first so indexes hold ─────────
  const body = keep.body.slice();
  const spliced = [];
  for (const [key, target] of targets) {
    if (!target.inserts.length || !sections.has(key)) continue;
    spliced.push({ at: sections.get(key).directEnd, lines: target.inserts });
  }
  const label = String(sourceLabel || 'the removed page');
  const materialHeading = `## Merged from ${label}`;
  const materialKey = headingKey(`Merged from ${label}`);
  const materialLines = material.flatMap((block, i) => (i ? ['', ...block] : block));
  const reuse = material.length ? sections.get(materialKey) : null;
  if (reuse) spliced.push({ at: reuse.sectionEnd, lines: ['', ...materialLines], raw: true });

  spliced.sort((a, b) => b.at - a.at);
  for (const { at, lines, raw } of spliced) {
    const prev = at > 0 ? body[at - 1] : '';
    const prevIsList = prev.startsWith('- ') || /^[ \t]/.test(prev) || HEADING_RE.test(prev);
    body.splice(at, 0, ...(raw || prevIsList ? lines : ['', ...lines]));
  }

  // ── New text at the foot ──────────────────────────────────────────────────
  const tail = [];
  for (const [key, heading] of newSections) {
    tail.push('', `## ${heading}`, ...targets.get(key).inserts);
  }
  if (material.length && !reuse) tail.push('', materialHeading, '', ...materialLines);

  if (tail.length) {
    while (body.length && isBlank(body[body.length - 1])) body.pop();
    const lastKept = keepTokens[keepTokens.length - 1];
    if (lastKept && lastKept.kind === 'fence' && !lastKept.closed) {
      body.push(lastKept.marker[0].repeat(lastKept.marker.length));
    }
    if (!body.length) tail.shift();
    body.push(...tail, '');
  } else if (body.length === 0 || !isBlank(body[body.length - 1])) {
    body.push('');
  }

  return bom + headText(keep, fm.lines, eol) + body.join(eol);
}

// ── Reuse: the model named a page that exists ───────────────────────────────

/**
 * Whether new wording says something the page does not. Deterministic, no model.
 *
 * THE RULE (owner's decision, 2026-11-06, after a live re-test). Keeping every
 * wording added 50,000 characters per re-ingest round on one domain and never
 * converged: one page held six near-identical definitions. So a sentence, line or
 * bullet joins the page only when at least half of its content words are on no
 * line of the page, or it holds a number the page lacks ("30 years" beside "25
 * years" shares every other word, and is a new fact).
 *
 * WHY 0.5, AND WHY THE WHOLE PAGE. Measured on the replies of three real re-ingest
 * rounds, 79 lines labelled by one reader: at 0.5 on the whole page, 86% of what is
 * dropped really was a rewording and 92% of real new points are kept, the best
 * precision of the grid; 0.45 and 0.55 are lower, and comparing with the single
 * closest line is no better. Added characters per round fell from about 40,000 to
 * about 13,000. It does not reach zero: a model finds new details on each reading.
 * Known failure: on a long page a new point in the page's own vocabulary is
 * dropped, which is why every drop is reported.
 *
 * It can only ever drop new text. Replaying a reply adds nothing, because what it
 * added is now on the page and what it dropped has less chance than before.
 */
export const NEW_WORDING_MIN_SHARE = 0.5;

const STOP_WORDS = new Set(('a an and are as at be been but by can could did do does for from had has have how if in into is it '
  + 'its may might more most no not of on or our she so some such than that the their them then there these they this those '
  + 'to us was we were what when where which while who why will with would you your he his her i my me also both each very '
  + 'just only over under about between through within without per via using use used uses make makes made one two new').split(' '));

function contentWords(text) {
  const plain = String(text).toLowerCase()
    .replace(/\[\[([^\]|]*\/)?([^\]|]+)(\|([^\]]+))?\]\]/g, (m, a, slug, c, alias) => ` ${(alias || slug).replace(/[-_]/g, ' ')} `)
    .replace(/(\d),(?=\d)/g, '$1')
    .replace(/[^\p{L}\p{N}.$%-]+/gu, ' ')
    .replace(/(?<!\d)[.-]|[.-](?!\d)/g, ' ');
  const stem = (w) => {
    if (/\d/.test(w)) return w;
    if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  };
  return [...new Set(plain.split(/\s+/).filter((w) => w && !STOP_WORDS.has(w)).map(stem))];
}

/**
 * Is this mostly new against the words on the page? A text with no content word never is.
 *
 * `pageLines` (optional: one Set of content words per line of the page) catches a
 * CHANGED figure (2026-11-14). "Monthly fee: €3,500" beside an old
 * "Monthly fee: €3,200" is new even when 3500 already appears elsewhere on the
 * page (a table row, another bullet): if the line(s) it most resembles (sharing at
 * least half of its words, the most of any line) lack one of its numbers, the figure
 * changed, and the text is new.
 * A line that repeats a statement with the same numbers is untouched by this test, so
 * the 0.5 measurement for prose stands as it was.
 */
export function isMostlyNew(text, pageWords, pageLines = null) {
  const words = contentWords(text);
  if (!words.length) return false;
  const fresh = words.filter((w) => !pageWords.has(w));
  if (fresh.length / words.length >= NEW_WORDING_MIN_SHARE || fresh.some((w) => /\d/.test(w))) return true;
  return Array.isArray(pageLines) && changesAFigure(words, pageLines);
}

/**
 * A statement the page makes, with at least one of its numbers different. Compared with
 * the line(s) it most resembles, not the whole page: "Lite tier monthly fee: €13,800"
 * beside "Lite tier monthly fee: €2,490" and "Fleet tier monthly fee: €13,800" is a
 * changed Lite figure, although the Fleet line holds that number (an audit found the
 * page-wide version dropped it).
 */
function changesAFigure(words, pageLines) {
  const nums = words.filter((w) => /\d/.test(w));
  const plain = words.filter((w) => !/\d/.test(w));
  if (!nums.length || !plain.length) return false;
  let best = 0;
  const closest = [];
  for (const line of pageLines) {
    const share = plain.filter((w) => line.has(w)).length / plain.length;
    if (share < NEW_WORDING_MIN_SHARE || share < best) continue;
    if (share > best) { best = share; closest.length = 0; }
    closest.push(line);
  }
  if (!closest.length) return false;
  // New unless one of the lines it most resembles already says it, figures and all.
  return !closest.some((line) => nums.every((n) => line.has(n)));
}

const splitSentences = (text) => text.split(/(?<=[.!?])\s+(?=[A-Z\[`"“*])/).map((x) => x.trim()).filter(Boolean);
const LINK_SECTIONS = new Set(['related', 'entities mentioned', 'concepts introduced or referenced']);
const LIST_LINE_RE = /^[ \t]*(\d+[.)]|[*+]|>)[ \t]/;
function leadTarget(bulletLine) {
  const m = bulletLine.match(/^-\s+\[\[([^\]|#]+)/);
  return m ? m[1].trim().replace(/\.md$/, '').replace(/^(entities|concepts)\//, '').toLowerCase() : null;
}

/**
 * Exact-name reuse: the model named a page that exists. The page's text always
 * stays, title and opening first; in any `##` section the incoming page repeats,
 * wording that passes isMostlyNew goes directly below the kept text, verbatim; a
 * section the page lacks goes at the foot if anything in it passes. The test runs
 * on every sentence, list line and bullet against ALL the page, so it holds for
 * every heading (812 distinct ones on one measured domain). In Related and the
 * summary link sections a link-led bullet is decided by its target instead: a new
 * target is always added, a known one never.
 *
 * Not text, on purpose: the incoming `# title` when the page has one, and `created`
 * and `date` (bookkeeping of a write).
 *
 * @param {string} keepText
 * @param {string} incomingText
 * @param {object} [opts]
 * @param {string} [opts.keepFolder]
 * @param {boolean} [opts.repeatSource] this same source was ingested here before, so
 *   no wording joins the page however new its words look: a model finds new vocabulary
 *   on every reading, and the mostly-new test alone never reaches zero (measured +14,000
 *   characters a round; +5,500 with new link targets still allowed).
 * @param {string[]} [opts.dropped] receives each passage left out for repeating the
 *   page, so the caller can say so. An exact repeat is not listed: nothing is lost.
 * @returns {string}
 */
export function composeReusedPage(keepText, incomingText, { keepFolder, dropped = [], repeatSource = false } = {}) {
  const original = String(keepText ?? '');
  const bom = original.startsWith('\ufeff') ? '\ufeff' : '';
  const crlf = (original.match(/\r\n/g) || []).length;
  const eol = crlf * 2 > (original.match(/\n/g) || []).length ? '\r\n' : '\n';

  const keep = splitPage(original);
  const inc = splitPage(withoutWriteBookkeeping(incomingText));
  const wantType = keepFolder === 'entities' ? 'entity' : keepFolder === 'concepts' ? 'concept' : null;
  const fm = repeatSource
    ? { lines: keep.hasFrontmatter ? keep.frontmatter : null, conflicts: [] }
    : composeFrontmatter(keep, inc, wantType);

  const keepTokens = tokenize(keep.body);
  const sections = sectionIndex(keepTokens);
  const keptHasTitle = keepTokens.some((t) => t.kind === 'heading' && t.level === 1);
  let hay = hayOf(keep.body);
  const pageWords = new Set(contentWords(keep.body.join('\n')));
  const pageLines = keep.body.map((l) => new Set(contentWords(l))).filter((x) => x.size);
  const absorb = (text) => {
    const ws = contentWords(text);
    for (const w of ws) pageWords.add(w);
    if (ws.length) pageLines.push(new Set(ws));
  };

  // Where the opening ends: before the first `##`, or a second `#`.
  let openingEnd = 0;
  let titles = 0;
  for (const t of keepTokens) {
    if (t.kind === 'heading' && (t.level === 2 || (t.level === 1 && titles++ > 0))) break;
    openingEnd = t.end;
  }

  const plans = new Map();          // insertion line → lines
  const tailSections = new Map();   // section key → { heading, lines }
  const addAt = (at, block) => {
    if (!plans.has(at)) plans.set(at, []);
    plans.get(at).push(block);
  };
  const remember = (lines) => { hay += normLines(lines).join('\n') + '\n'; };

  // A section's bullets, as they stand plus what this write adds.
  const bulletState = new Map();
  const bulletsOf = (key) => {
    if (!bulletState.has(key)) {
      const target = bulletTarget(sections.get(key));
      bulletState.set(key, target);
    }
    return bulletState.get(key);
  };
  /** True when this bullet is already held, or is a bare link the section has. */
  const bulletHeld = (key, token) => {
    const target = bulletsOf(key);
    const top = token.lines[0];
    const single = token.lines.length === 1;
    if (single && target.lower.has(top.trim().toLowerCase())) return true;
    if (!single && target.multi.includes(hayOf(token.lines))) return true;
    if (single && BARE_LINK_BULLET_RE.test(top.trim()) && target.keys.has(dedupKey(top))) return true;
    if (single) { target.exact.add(top.trim()); target.lower.add(top.trim().toLowerCase()); }
    else target.multi.push(hayOf(token.lines));
    target.keys.add(dedupKey(top));
    return false;
  };

  const incTokens = tokenize(inc.body);
  let group = null;                 // null: the opening
  let pending = [];                 // a heading waits for something new under it
  const linkTargets = new Map();    // link section → the targets it names
  const place = (block, direct) => {
    if (group === null) {
      addAt(openingEnd, block);
    } else if (sections.has(group.key)) {
      const sec = sections.get(group.key);
      addAt(direct ? sec.directEnd : sec.sectionEnd, block);
    } else {
      tailSections.get(group.key).lines.push(block);
    }
  };

  for (const t of incTokens) {
    if (t.kind === 'heading' && t.level === 2) {
      pending = [];
      const key = headingKey(t.text);
      group = { key, direct: true };
      if (!sections.has(key) && !tailSections.has(key)) {
        tailSections.set(key, { heading: t.text, lines: [] });
      }
      continue;
    }
    if (t.kind === 'heading') {
      if (group) group.direct = false;
      // A sub-heading goes on the page only with something new under it.
      pending.push([t.level === 1 ? demote(t) : t.lines[0]]);
      continue;
    }
    if (t.kind === 'bullet' && group) {
      if (bulletHeld(group.key, t)) continue;
    } else if (hay.includes(hayOf(t.lines))) {
      continue;
    }

    // What of this block says something new. A fence is code: only an exact repeat
    // goes (above). A table is one unit. Prose goes sentence by sentence.
    let lines = t.lines;
    const whole = t.lines.join(' ');
    if (t.kind === 'bullet') {
      const target = group && LINK_SECTIONS.has(group.key) ? leadTarget(t.lines[0]) : null;
      if (repeatSource) {
        if (!BARE_LINK_BULLET_RE.test(t.lines[0].trim())) dropped.push(whole);
        continue;
      } else if (target) {
        if (!linkTargets.has(group.key)) {
          linkTargets.set(group.key, new Set((sections.get(group.key)?.bullets || []).map((b) => leadTarget(b.lines[0])).filter(Boolean)));
        }
        const known = linkTargets.get(group.key);
        if (known.has(target)) { dropped.push(whole); continue; }
        known.add(target);
      } else if (!isMostlyNew(whole, pageWords, pageLines)) {
        if (!BARE_LINK_BULLET_RE.test(t.lines[0].trim())) dropped.push(whole);
        continue;
      }
    } else if (repeatSource) {
      dropped.push(whole);
      continue;
    } else if (t.kind === 'para') {
      if (t.lines.every((l) => l.startsWith('|'))) {
        if (!isMostlyNew(whole, pageWords, pageLines)) { dropped.push(whole); continue; }
      } else {
        const everyLine = t.lines.every((l) => LIST_LINE_RE.test(l));
        const units = everyLine ? t.lines : splitSentences(whole);
        const fresh = [];
        for (const u of units) {
          if (isMostlyNew(u, pageWords, pageLines)) { fresh.push(u); absorb(u); } else dropped.push(u);
        }
        if (!fresh.length) continue;
        if (fresh.length !== units.length) lines = everyLine ? fresh : [fresh.join(' ')];
      }
    }
    absorb(lines.join(' '));

    const direct = !group || group.direct;
    for (const h of pending) {
      if (!hay.includes(`\n${h[0].trimEnd()}\n`)) { remember(h); absorb(h[0]); place(h, direct); }
    }
    pending = [];
    remember(lines);
    const closer = t.kind === 'fence' && !t.closed ? t.marker[0].repeat(t.marker.length) : null;
    place(closer ? [...lines, closer] : lines, direct);
  }
  for (const [key, section] of tailSections) if (!section.lines.length) tailSections.delete(key);

  // A Key Facts section new to the page goes right after Key Takeaways, where ingest
  // asks for it, not at the foot after Notes (2026-11-14). Every other new section
  // still goes at the foot, as before.
  if (tailSections.has('key facts') && sections.has('key takeaways') && !sections.has('key facts')) {
    const { heading, lines } = tailSections.get('key facts');
    const block = [`## ${heading}`];
    lines.forEach((b, i) => {
      const bothList = i > 0 && lines[i - 1][0].startsWith('- ') && b[0].startsWith('- ');
      if (i > 0 && !bothList) block.push('');
      block.push(...b);
    });
    addAt(sections.get('key takeaways').sectionEnd, block);
    tailSections.delete('key facts');
  }

  const conflicts = fm.conflicts.length ? ['```yaml', ...fm.conflicts, '```'] : null;
  const addConflicts = conflicts && !hay.includes(hayOf(conflicts));

  const fmUnchanged = fm.lines === null
    || (keep.hasFrontmatter && fm.lines.join('\n') === keep.frontmatter.join('\n'));
  const anyNew = plans.size > 0 || tailSections.size > 0 || addConflicts;
  if (fmUnchanged && !anyNew) return original;

  // ── Into the kept body, last first so the line numbers hold ───────────────
  const body = keep.body.slice();
  const atList = (line) => line !== undefined && (line.startsWith('- ') || /^[ \t]+\S/.test(line));
  for (const at of [...plans.keys()].sort((a, b) => b - a)) {
    const out = [];
    let prev = at > 0 ? body[at - 1] : undefined;
    for (const block of plans.get(at)) {
      const bothList = atList(prev) && block[0].startsWith('- ');
      if (prev !== undefined && !isBlank(prev) && !bothList) out.push('');
      out.push(...block);
      prev = block[block.length - 1];
    }
    if (at < body.length && !isBlank(body[at]) && !(atList(prev) && body[at].startsWith('- '))) out.push('');
    body.splice(at, 0, ...out);
  }

  const tail = [];
  for (const { heading, lines } of tailSections.values()) {
    tail.push('', `## ${heading}`);
    lines.forEach((block, i) => {
      const bothList = i > 0 && lines[i - 1][0].startsWith('- ') && block[0].startsWith('- ');
      if (i > 0 && !bothList) tail.push('');
      tail.push(...block);
    });
  }
  if (addConflicts) tail.push('', '## Frontmatter from a later write', ...conflicts);

  if (tail.length) {
    while (body.length && isBlank(body[body.length - 1])) body.pop();
    const lastKept = keepTokens[keepTokens.length - 1];
    if (lastKept && lastKept.kind === 'fence' && !lastKept.closed) {
      body.push(lastKept.marker[0].repeat(lastKept.marker.length));
    }
    if (!body.length) tail.shift();
    body.push(...tail, '');
  } else if (body.length === 0 || !isBlank(body[body.length - 1])) {
    body.push('');
  }

  // A page with no `# title` takes the incoming one, which is otherwise not text.
  if (!keptHasTitle && !repeatSource) {
    const title = tokenize(splitPage(incomingText).body).find((t) => t.kind === 'heading' && t.level === 1);
    if (title) body.unshift(title.lines[0], ...(body.length && !isBlank(body[0]) ? [''] : []));
  }

  return bom + headText(keep, fm.lines, eol) + body.join(eol);
}

/**
 * The incoming page without what a reuse deliberately does not carry: its first
 * `# title`, when no text comes before it, and its `date`.
 */
function withoutWriteBookkeeping(incomingText) {
  const page = splitPage(incomingText);
  const body = page.body.slice();
  const first = body.findIndex((l) => !isBlank(l));
  if (first >= 0 && /^#[ \t]+\S/.test(body[first])) body.splice(first, 1);
  const fm = page.frontmatter.filter((l) => !/^date:/.test(l));
  return (page.hasFrontmatter ? ['---', ...fm, '---'] : []).concat(body).join('\n');
}

// ── The dumb cross-check ────────────────────────────────────────────────────

/**
 * Every non-blank line of both pages must still be on the merged page. Returns
 * what is missing; [] is the only answer that allows a delete.
 *
 * Deliberately not built on `tokenize`, and it knows nothing about sections:
 * it fails for different reasons than the composer can. Allowed differences,
 * each of them no loss of text: surrounding spaces; a heading's level; a bare
 * `- [[x]]` when `[[x]]` is on the page, in any case, because a link names one page
 * however it is capitalised and the write path's own dedup key says so; `type`,
 * `created` and `updated` in frontmatter (`type` follows the folder, the dates
 * belong to a deleted file); `tags`, which are checked one by one apart from the
 * `type/` tag. Case is NOT allowed anywhere else: a capital can be a name.
 */
export function findLostLines(keepText, removeText, mergedText) {
  const norm = (l) => l.trim();
  const stripHashes = (l) => norm(l).replace(/^#{1,6}\s+/, '');
  const merged = splitPage(mergedText);
  const mergedAll = [...merged.frontmatter, ...merged.body];
  const have = new Set(mergedAll.map(norm));
  const haveHeadingText = new Set(mergedAll.filter((l) => /^#{1,6}\s/.test(l)).map(stripHashes));
  const wholeLower = mergedAll.join('\n').toLowerCase();
  const mergedTags = new Set(parseTags(frontmatterEntries(merged.frontmatter).find(isTagsEntry)));
  const lost = [];

  for (const [name, text] of [['kept', keepText], ['removed', removeText]]) {
    const page = splitPage(text);
    for (const line of page.body) {
      if (isBlank(line) || have.has(norm(line))) continue;
      if (/^#{1,6}\s/.test(line) && haveHeadingText.has(stripHashes(line))) continue;
      const bare = line.trim().match(BARE_LINK_BULLET_RE);
      if (bare) {
        const target = bare[1].trim().toLowerCase();
        if (wholeLower.includes(`[[${target}]]`) || wholeLower.includes(`[[${target}|`)) continue;
      }
      lost.push({ page: name, line });
    }
    for (const e of frontmatterEntries(page.frontmatter)) {
      if (isTagsEntry(e)) {
        for (const tag of parseTags(e)) {
          if (!tag.startsWith('type/') && !mergedTags.has(tag)) lost.push({ page: name, line: `tags: ${tag}` });
        }
      } else if (e.key === null || !BOOKKEEPING_KEYS.has(e.key)) {
        for (const line of e.lines) {
          if (!isBlank(line) && !have.has(norm(line))) lost.push({ page: name, line });
        }
      }
    }
  }
  return lost;
}
