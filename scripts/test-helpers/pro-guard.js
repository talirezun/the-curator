// scripts/test-helpers/pro-guard.js — the Pro rule as two independent checks
// over RENDERED markup (v4.2, build contract 2026-11-26):
//
//   Pro only REVEALS. A warning, a cost, an outcome, a refusal or a confirm is
//   NEVER Pro-only.
//
// 1. proGuardFaults(html) — STRUCTURAL. Every element carrying
//    data-detail="pro" (what proAttr() emits) is checked: it may not BE, or
//    CONTAIN, a protected element. Protected = one of the app's warning /
//    cost / outcome / refusal / confirm surfaces, named below by the classes
//    and roles the shared kit actually emits, plus any money amount in text.
// 2. parityFaults(proHtml, simpleHtml) — the DUMB CROSS-CHECK, for views that
//    render two different bodies (isPro() + re-render) instead of using the
//    attribute. Every protected text in the Pro render must also be VISIBLE in
//    the simple render (simple-mode visibility = data-detail="pro" subtrees
//    removed). It knows nothing about structure, only about words on screen.
//
// Both are exported so a view's own suite (scripts/test-context-*) can run
// them over its arms. scripts/test-pro-guard.js proves each by mutation.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** A forgiving HTML → tree parser: enough for the app's own rendered strings. */
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)|</g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {                               // close tag: pop to the matching open
      const tag = m[1].toLowerCase();
      let n = cur;
      while (n && n !== root && n.tag !== tag) n = n.parent;
      if (n && n !== root) cur = n.parent;
      continue;
    }
    if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrs = {};
      const are = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a;
      while ((a = are.exec(m[3] || '')) !== null) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
      const el = { tag, attrs, children: [], parent: cur };
      cur.children.push(el);
      if (!VOID.has(tag) && !m[4]) cur = el;
      continue;
    }
    const text = m[5] !== undefined ? m[5] : m[0];
    cur.children.push({ tag: '#text', text, parent: cur });
  }
  return root;
}

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

export function textOf(n, { skipPro = false, skipButtons = false } = {}) {
  if (n.tag === '#text') return decode(n.text);
  if (skipPro && isProOnly(n)) return ' ';
  if (skipButtons && n.tag === 'button') return ' ';
  return n.children.map((c) => textOf(c, { skipPro, skipButtons })).join(' ');
}

export const isProOnly = (n) => n.attrs && n.attrs['data-detail'] === 'pro';

/**
 * The protected surfaces, as the kit emits them. Exported so a reader can see
 * the whole list in one place, and a suite can extend it for its own view.
 */
export const PROTECTED_CLASSES = Object.freeze([
  /^cur-mon-loud$/,          // shared/monitor.js loud entry (a warning or an outcome)
  /^cur-mon-(warn|danger)$/, // a monitor tone that is a warning
  /^tx-status(-|$)/,         // shared/text.js renderStatus (outcomes, errors)
  /^tx-error-detail$/,       // a refusal's support line
  /^ai-run(-|$)/,            // shared/ai-run.js: what a paid action costs and runs on
  /^btn-ai$/,                // a paid action carries its price
  /^cfd-/,                   // shared/confirm.js dialog
  /^cur-toast/,              // an outcome toast
  /^settings-inline-error$/, /^settings-fail-note$/,
  /^mem-setup-note$/,        // Context › Setup: a to-fix line
  /^mem-setup-err$/, /^mem-setup-fix-note$/, /^mem-setup-gfix$/,
]);
export const PROTECTED_ROLES = Object.freeze(['alert', 'alertdialog', 'status']);
// A money amount ($0.04, US$1, under $0.01) is a cost line wherever it is.
export const MONEY_RE = /(?:US)?\$\s?\d|\d\s?¢/;

export function protectedReason(n) {
  if (!n || n.tag === '#text' || !n.attrs) return null;
  for (const c of String(n.attrs.class || '').split(/\s+/).filter(Boolean)) {
    if (PROTECTED_CLASSES.some((re) => re.test(c))) return `class "${c}"`;
  }
  if (PROTECTED_ROLES.includes(n.attrs.role)) return `role="${n.attrs.role}"`;
  if (n.attrs['aria-live'] === 'assertive') return 'aria-live="assertive"';
  if ('data-never-pro' in n.attrs) return 'data-never-pro';
  return null;
}

function walk(n, fn) { fn(n); if (n.children) for (const c of n.children) walk(c, fn); }
const describe = (n) => '<' + n.tag + Object.entries(n.attrs || {}).map(([k, v]) => ` ${k}="${v}"`).join('') + '>';

/** Rule 1: no Pro-only element is or contains a protected one. */
export function proGuardFaults(html) {
  const faults = [];
  walk(parseHtml(html), (n) => {
    if (!isProOnly(n)) return;
    walk(n, (d) => {
      const why = protectedReason(d);
      if (why) faults.push(`${describe(n)} hides ${why}: "${textOf(d).replace(/\s+/g, ' ').trim().slice(0, 120)}"`);
    });
    const t = textOf(n);
    if (MONEY_RE.test(t)) faults.push(`${describe(n)} hides a money amount: "${t.replace(/\s+/g, ' ').trim().slice(0, 120)}"`);
  });
  return faults;
}

/**
 * Every protected text in a render (the words a user must always get).
 * `{ words: true }` leaves out the labels of buttons inside it: a view may
 * offer a warning's action in its own place (Context's simple harness row
 * carries the fix button in the row's action slot, and the whole row opens
 * the steps that Pro's "Show its setup steps" door names), but the warning's
 * WORDS must be on screen. Rule 1 still guards a confirm control itself.
 */
export function protectedTexts(html, { words = false } = {}) {
  const out = [];
  walk(parseHtml(html), (n) => {
    if (protectedReason(n)) {
      const t = textOf(n, { skipButtons: words }).replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
  });
  return out;
}

/** Rule 2: every protected text of the Pro render is visible in the simple render. */
export function parityFaults(proHtml, simpleHtml) {
  const visible = textOf(parseHtml(simpleHtml), { skipPro: true }).replace(/\s+/g, ' ');
  return protectedTexts(proHtml, { words: true }).filter((t) => !visible.includes(t))
    .map((t) => `shown in Pro but not in the simple view: "${t.slice(0, 160)}"`);
}
