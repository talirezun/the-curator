/**
 * THE PAGE CONTRACT — a reusable guard over a page's rendered markup (v3.89.0).
 *
 * A page built from the shared section kit (src/public/next/shared/section.js)
 * is held to measurable rules, checked on its RENDERED HTML rather than on its
 * source, so a rename, a helper or a new branch cannot slip past it. Two
 * layers, from docs/dev's MCP-redesign proposal §5:
 *
 *   LAYER 1 — the class allow-list. Every class token in the markup must
 *     match the contract's `allow` list (exact names, or `prefix*`), and none
 *     may match its `forbid` list. A page-private class (`mcpi-warn`,
 *     `settings-block-footnote`) is how a look-alike component gets in, so the
 *     allow-list is per page and short.
 *
 *   LAYER 2 — structure, on a small tree built from the markup:
 *     column     the column's top-level children, as a kind sequence matched
 *                against a pattern (e.g. `header overview (head card)+`), with
 *                no stray text node and no unclassified element between them;
 *     buttons    every <button> sits inside one of `buttonHomes` (the ⓘ mark,
 *                `tx-vh-info`, is exempt — it belongs to its head);
 *     details    every <details> is a kit fold row (`cur-fold`);
 *     monitors   no `.cur-mon` carries a `.cur-mon-head` (no uppercase status
 *                word as a monitor head);
 *     footnotes  a `tx-desc` / `tx-note` is the LAST element of its card or
 *                fold body, or sits in an action card's footnote slot, or is a
 *                monitor's own note — never between two instruments;
 *     style      no inline `style=` except the contract's `styleAllow`
 *                patterns (the overview's track floor, the card's measured
 *                reserve);
 *     primary    at most `maxPrimary` `btn-primary` on the page;
 *     mono       optionally: no `.mono` element directly inside prose.
 *
 * `checkPageContract(html, contract)` returns a list of violations (strings);
 * an empty list is a pass. It never throws on markup it cannot place — an
 * element it cannot classify is itself a violation. Self-tested, with a
 * positive control per rule, by scripts/test-next-page-contract.js.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use']);

/** A tiny, forgiving HTML parser: elements with attrs and children, plus
 *  text nodes. SVG shapes may self-close; `<svg>` itself has children. */
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, classes: [], children: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(String(html)))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      let n = cur;
      while (n && n !== root && n.tag !== tag) n = n.parent;
      if (n && n !== root) cur = n.parent;
      continue;
    }
    if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrs = {};
      const are = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a;
      while ((a = are.exec(m[3] || ''))) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
      const el = { tag, attrs, classes: (attrs.class || '').split(/\s+/).filter(Boolean), children: [], parent: cur };
      cur.children.push(el);
      if (!m[4] && !VOID.has(tag)) cur = el;
      continue;
    }
    if (m[5] != null) cur.children.push({ tag: '#text', text: m[5], parent: cur, classes: [], attrs: {}, children: [] });
  }
  return root;
}

export function walk(node, fn) {
  for (const c of node.children) { fn(c); walk(c, fn); }
}
const has = (el, c) => el.classes.includes(c);
const hasAny = (el, list) => list.some((c) => has(el, c));
function ancestor(el, pred) {
  for (let p = el.parent; p; p = p.parent) if (p.tag !== '#root' && pred(p)) return p;
  return null;
}
function label(el) {
  return el.tag === '#text' ? '"' + el.text.trim().slice(0, 40) + '"'
    : '<' + el.tag + (el.classes.length ? '.' + el.classes.join('.') : '') + (el.attrs.id ? '#' + el.attrs.id : '') + '>';
}

/** `allow` / `forbid` entries: an exact class, or `prefix*`. */
function matcher(list) {
  const exact = new Set(), pre = [];
  for (const e of list || []) (e.endsWith('*') ? pre.push(e.slice(0, -1)) : exact.add(e));
  return (c) => exact.has(c) || pre.some((p) => c.startsWith(p));
}

/**
 * @param {string} html
 * @param {{
 *   name: string,
 *   allow?: string[], forbid?: string[],            // Layer 1
 *   column?: { kinds: Array<[string, string[]]>,    // kind name -> classes that mark it
 *              pattern: RegExp },                   // over the space-joined kind sequence
 *   buttonHomes?: string[],                         // classes a <button> must sit inside
 *   foldClass?: string,                             // every <details> carries it
 *   noMonitorHead?: boolean,
 *   footnotes?: { classes: string[], lastIn: string[], slots: string[] },
 *   styleAllow?: RegExp[],
 *   maxPrimary?: number,
 *   monoInProse?: { prose: string[] } | false,
 * }} contract
 * @returns {string[]} violations
 */
export function checkPageContract(html, contract) {
  const c = contract || {};
  const out = [];
  const root = parseHtml(html);
  const els = [];
  walk(root, (n) => { if (n.tag !== '#text') els.push(n); });

  // ── LAYER 1 ─────────────────────────────────────────────────────────────
  if (c.allow) {
    const ok = matcher(c.allow);
    const seen = new Set();
    for (const el of els) for (const k of el.classes) {
      if (!ok(k) && !seen.has(k)) { seen.add(k); out.push('class not on the allow-list: .' + k + ' on ' + label(el)); }
    }
  }
  if (c.forbid) {
    const bad = matcher(c.forbid);
    const seen = new Set();
    for (const el of els) for (const k of el.classes) {
      if (bad(k) && !seen.has(k)) { seen.add(k); out.push('forbidden class: .' + k + ' on ' + label(el)); }
    }
  }

  // ── LAYER 2: the column ─────────────────────────────────────────────────
  if (c.column) {
    const kinds = [];
    for (const ch of root.children) {
      if (ch.tag === '#text') {
        if (ch.text.trim()) out.push('text between the column\'s blocks: ' + label(ch));
        continue;
      }
      const k = c.column.kinds.find(([, cls]) => hasAny(ch, cls));
      if (!k) { out.push('unclassified block in the column: ' + label(ch)); kinds.push('?'); continue; }
      kinds.push(k[0]);
    }
    const seq = kinds.join(' ');
    if (!c.column.pattern.test(seq)) out.push('column sequence "' + seq + '" does not match ' + c.column.pattern);
  }

  // ── LAYER 2: the in-card rules ──────────────────────────────────────────
  if (c.buttonHomes) {
    for (const el of els) {
      if (el.tag !== 'button' || has(el, 'tx-vh-info')) continue;
      if (!ancestor(el, (p) => hasAny(p, c.buttonHomes))) out.push('button outside every card: ' + label(el));
    }
  }
  if (c.foldClass) {
    for (const el of els) if (el.tag === 'details' && !has(el, c.foldClass)) out.push('<details> that is not a kit fold row: ' + label(el));
  }
  if (c.noMonitorHead) {
    for (const el of els) {
      if (!has(el, 'cur-mon')) continue;
      walk(el, (n) => { if (has(n, 'cur-mon-head')) out.push('a monitor with a head (status word): ' + label(el)); });
    }
  }
  if (c.footnotes) {
    const f = c.footnotes;
    for (const el of els) {
      if (!hasAny(el, f.classes)) continue;
      if (ancestor(el, (p) => hasAny(p, f.slots))) continue;
      const parent = el.parent;
      const sibs = parent.children.filter((n) => n.tag !== '#text' || n.text.trim());
      const last = sibs[sibs.length - 1] === el;
      if (!(hasAny(parent, f.lastIn) && last)) out.push('a footnote that is not the last line of its card: ' + label(el) + ' in ' + label(parent));
    }
  }
  if (c.styleAllow) {
    for (const el of els) {
      if (!('style' in el.attrs)) continue;
      if (!c.styleAllow.some((re) => re.test(el.attrs.style))) out.push('inline style: ' + label(el) + ' style="' + el.attrs.style + '"');
    }
  }
  if (Number.isInteger(c.maxPrimary)) {
    const n = els.filter((el) => has(el, 'btn-primary')).length;
    if (n > c.maxPrimary) out.push(n + ' primary buttons (at most ' + c.maxPrimary + ')');
  }
  if (c.monoInProse) {
    for (const el of els) {
      if (!has(el, 'mono')) continue;
      const p = el.parent;
      if (p && (c.monoInProse.prose.includes(p.tag) || hasAny(p, c.monoInProse.prose))
        && p.children.some((n) => n.tag === '#text' && n.text.trim())) {
        out.push('a mono span inside a sentence: ' + label(el) + ' in ' + label(p));
      }
    }
  }
  return out;
}

/** The kit's own names — the base of every page's allow-list. */
export const KIT_CLASSES = Object.freeze([
  'cur-section-*', 'cur-card', 'cur-card-*', 'cur-folds', 'cur-fold', 'cur-fold-*',
  'cur-action', 'cur-action-*', 'cur-status-line', 'cur-status-line-*',
  'cur-ov', 'cur-ov-*', 'cur-group', 'cur-group-title', 'cur-eyebrow',
  'cur-mon', 'cur-mon-*', 'cur-depth', 'cur-depth-*', 'cur-sb-dot', 'cur-sb-dot-*',
  'fresh-*', 'tx-*', 'xp', 'xp-*', 'lb', 'lb-*', 'btn', 'btn-*', 'mono',
  // renderViewHeader's own historical names, on the same elements as its tx-vh-*.
  'view-eyebrow', 'view-title',
  // shell.css's screen-reader-only utility.
  'visually-hidden',
]);
