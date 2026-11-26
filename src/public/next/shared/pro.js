// shared/pro.js — LOCAL STUB written by package K (Context page) so its views
// and suites run before package P lands the real module. Same exported API as
// the build contract (CONTRACT-pro-context-v1.md, "Frontend API"); package P's
// file replaces this one wholesale at integration. DOM-free at import, so an
// offline suite can import it in plain Node.

const listeners = new Set();
let on = false;

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function paintAttr() {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-pro', on ? 'on' : 'off');
  }
}

function notify() {
  for (const cb of [...listeners]) { try { cb(on); } catch { /* a listener's failure is its own */ } }
}

let delegated = false;
function delegate() {
  if (delegated || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  delegated = true;
  document.addEventListener('click', (e) => {
    const b = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-pro-more]') : null;
    if (!b) return;
    e.preventDefault();
    const y = typeof window !== 'undefined' ? window.scrollY : 0;
    setPro(true).then(() => { if (typeof window !== 'undefined') window.scrollTo(0, y); });
  });
}

export async function initPro() {
  try {
    const r = await fetch('/api/config/ui-detail');
    const j = await r.json();
    on = !!(j && j.uiDetail === 'pro');
  } catch { on = false; }
  paintAttr();
  delegate();
}

export function isPro() { return on; }

export async function setPro(next) {
  const was = on;
  on = !!next;
  paintAttr();
  if (was !== on) notify();
  try {
    const r = await fetch('/api/config/ui-detail', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uiDetail: on ? 'pro' : 'simple' }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch {
    // The stub keeps the switch where the user put it for this page load.
  }
}

export function onProChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function proAttr() { return ' data-detail="pro"'; }

export function moreInProLine(what) {
  delegate();
  return '<p class="tx-desc pro-more"><button type="button" class="btn btn-ghost btn-xs" data-pro-more>'
    + 'More in Pro: ' + escapeHtml(what) + ' ›</button></p>';
}
