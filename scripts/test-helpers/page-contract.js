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
  // ── v3.90.0: THE COPY DECK'S PRINCIPLES, on the rendered markup ─────────
  if (c.realButtons) {
    // Every action is a REAL button: a <button> of the shared system
    // (btn + a filled tier — never a ghost, which reads as plain text), or an
    // <a> carrying the same classes. A control with an action hook that is
    // neither is a violation. The ⓘ panel's own guide link and the shared
    // listbox / overview / ⓘ triggers are their components' own buttons.
    const rb = c.realButtons;
    const exemptIn = (el) => !!ancestor(el, (p) => hasAny(p, rb.exemptIn || []));
    const tierOk = (el) => has(el, 'btn') && hasAny(el, rb.tiers || []);
    for (const el of els) {
      if (exemptIn(el)) continue;
      if (el.tag === 'a') {
        if (!tierOk(el)) out.push('a link that is not a real button: ' + label(el));
        continue;
      }
      if (el.tag === 'button') {
        if (hasAny(el, rb.exemptClasses || [])) continue;
        if (!tierOk(el)) out.push('a button that is not a real button (no shared tier): ' + label(el));
        continue;
      }
      const hook = Object.keys(el.attrs).some((k) => /^data-[a-z-]*act$/.test(k)) || el.attrs.role === 'button' || 'onclick' in el.attrs;
      if (hook) out.push('a clickable element that is not a <button> or a button-styled <a>: ' + label(el));
    }
  }
  if (c.bannedWords || c.noAllCaps) {
    // The VISIBLE words: text nodes outside anything `hidden` (the closed ⓘ
    // panels), outside <script>/<style>, and — for the banned list — outside
    // data shown as data (`.mono`, <pre>: a path, a tool name, the exact
    // setup text an install writes).
    const hidden = (n) => !!ancestor(n, (p) => 'hidden' in p.attrs || p.tag === 'script' || p.tag === 'style');
    const texts = [];
    walk(root, (n) => { if (n.tag === '#text' && n.text.trim() && !hidden(n)) texts.push(n); });
    const decode = (t) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (c.bannedWords) {
      const bw = c.bannedWords;
      for (const n of texts) {
        if (ancestor(n, (p) => p.tag === 'pre' || hasAny(p, bw.dataClasses || []))) continue;
        const allowed = ancestor(n, (p) => hasAny(p, bw.allowIn || []));
        for (const [name, re] of bw.words) {
          if (allowed && (bw.allowWords || []).includes(name)) continue;
          if (re.test(decode(n.text))) out.push('a mechanism word on screen ("' + name + '"): "' + n.text.trim().slice(0, 60) + '" in ' + label(n.parent));
        }
      }
    }
    if (c.noAllCaps) {
      const nc = c.noAllCaps;
      const acr = new Set(nc.acronyms || []);
      for (const n of texts) {
        if (ancestor(n, (p) => hasAny(p, nc.exemptIn || []) || p.tag === 'pre' || has(p, 'mono'))) continue;
        const words = decode(n.text).split(/[^A-Za-z]+/).filter((w) => w.length >= 2 && w === w.toUpperCase() && !acr.has(w));
        if (words.length) out.push('ALL-CAPS text outside the overview: "' + n.text.trim().slice(0, 60) + '" in ' + label(n.parent));
      }
    }
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

// The depth bar's fill is its one documented inline style (shared/monitor.js
// renderDepthCell writes a computed percentage); nothing else may carry one.
export const DEPTH_BAR_WIDTH = /^width:\d+(\.\d+)?%$/;

/**
 * The mechanism words the MCP page never shows (COPY-DECK-v3.90.0 principle
 * 1, and the owner's list): `[name, RegExp]`. "bridge" is allowed only in the
 * page title (`allowIn: view-title`).
 */
export const MCP_BANNED_WORDS = Object.freeze([
  ['bridge', /\bbridges?\b/i], ['session line', /session lines?/i], ['journal', /\bjournals?\b/i],
  ['signature', /\bsignatures?\b/i], ['stdio', /\bstdio\b/i], ['launcher', /\blaunchers?\b/i],
  ['entry', /\bentry\b|\bentries\b/i], ['MCP server', /\bMCP servers?\b/i], ['hooks', /\bhooks?\b/i],
]);

/**
 * SETTINGS › MCP BRIDGE (v3.89.0) — the page rebuilt on the section kit, held
 * to PROPOSAL §4's rules. Its host list is SHORT and each name is a slot a
 * shared component documents: the overview's two inks (`toneClass`) and its
 * section class (the column rhythm below it, `sectionClass`), the checkbox
 * kit an install tick uses. Nothing page-private, nothing `mcp-*`.
 * The column is the view header, then `.settings-view-body`'s children (a
 * bare display:block wrapper settings.js owns for its section reveal).
 */
export const MCP_PAGE_CONTRACT = Object.freeze({
  name: 'Settings › MCP bridge',
  allow: [...KIT_CLASSES, 'settings-ov-ok', 'settings-ov-attn', 'settings-ov-section', 'cur-check', 'cur-check-sm'],
  forbid: ['mcpi-*', 'mcp-*', 'settings-block-footnote', 'settings-btn-row', 'settings-block*', 'settings-setup-*', 'settings-inline-error'],
  column: {
    // v3.90.0 — the page's one-line lede (`cur-section-intro`) may follow the
    // header, and its closing line (`cur-section-foot`) the last card.
    kinds: [['header', ['tx-vh']], ['lede', ['cur-section-intro']], ['overview', ['cur-ov']], ['head', ['cur-section-head']],
      ['card', ['cur-card']], ['footer', ['cur-section-foot']]],
    pattern: /^header( lede)? overview( head card)+( footer)?$/,
  },
  // v3.90.0 — the copy deck's principles (COPY-DECK-v3.90.0 §Principles).
  realButtons: { tiers: ['btn-secondary', 'btn-primary', 'btn-danger'],
    exemptIn: ['tx-vh-panel', 'cur-ov'], exemptClasses: ['tx-vh-info', 'lb-btn', 'lb-option'] },
  bannedWords: {
    words: MCP_BANNED_WORDS,
    allowIn: ['view-title'], allowWords: ['bridge'],
    dataClasses: ['mono'],
  },
  noAllCaps: { exemptIn: ['cur-ov'], acronyms: ['MCP', 'AI', 'PC', 'UTC', 'JSON', 'OK', 'HTTP', 'URL', 'ID', 'CLI', 'IDE', 'API'] },
  buttonHomes: ['cur-card', 'cur-ov'],
  foldClass: 'cur-fold',
  noMonitorHead: true,
  footnotes: { classes: ['tx-desc', 'tx-note'], lastIn: ['cur-card', 'cur-fold-body'],
    slots: ['cur-action-footnote', 'cur-mon-note', 'tx-vh-panel'] },
  styleAllow: [/^--cur-ov-min:\d+px$/, DEPTH_BAR_WIDTH],
  maxPrimary: 1,
  monoInProse: { prose: ['p', 'tx-desc', 'tx-note', 'cur-action-run'] },
});
