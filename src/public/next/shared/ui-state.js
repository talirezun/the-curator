// shared/ui-state.js — the four pieces of /next state that must survive a
// change of storage PARTITION.
//
// ══ WHY THIS EXISTS ══════════════════════════════════════════════════════
//
// Every preference in this shell lives in localStorage. A native shell (an
// Electron BrowserWindow) has its OWN storage partition: nothing in Safari or
// Chrome carries over. The trick that made the /old -> /next cutover invisible
// — "the new frontend MUST read the same three key names" (NEXT-PHASE-PLAN R6)
// — cannot help here, because the problem is not what a key is CALLED, it is
// which partition it is IN. Reading the same name out of an empty partition
// still returns null.
//
// So the state whose loss is a CORRECTNESS or TRUST failure is recorded on the
// SERVER, in .curator-config.json, which src/brain/paths.js already resolves
// correctly in both install modes. The full triage — which four fields moved,
// which ten deliberately did not, and why this file rather than a new one —
// is in src/brain/config.js's UI_STATE section and is not repeated here.
//
// ══ THE THREE PROPERTIES THIS MODULE HAS TO KEEP ═════════════════════════
//
// 1. IT IS A NO-OP FOR AN EXISTING USER. Before this ships, every user's four
//    values are in localStorage and the server has none. mergeField() below
//    then returns exactly the localStorage value for every field, so every
//    consumer sees precisely what it saw yesterday. That is why the server
//    stores the SAME STRINGS the browser held ('yes', '1', 'pre') rather than
//    booleans: the no-op claim is a byte comparison, not an argument about an
//    encoding.
//
// 2. A CONSENT IS NEVER SILENTLY DOWNGRADED. mergeField() is a UNION for the
//    monotonic fields — either side saying "recorded" wins, in BOTH
//    directions. There is no ordering in which a stored consent becomes
//    "not yet given", and the server refuses the downgrade independently
//    (src/brain/config.js setUiState). Two mechanisms, neither relying on the
//    other being remembered.
//
// 3. EVERY CONSUMER KEEPS ITS OWN FAIL-SAFE DIRECTION. They are deliberately
//    NOT the same direction — views/onboarding.js fails towards SHOW and
//    views/cutover-notice.js fails towards HIDE, each with a written cost
//    argument. So this module never decides for them: durableStorage() is a
//    drop-in for the `storage` object those modules already inject into their
//    own pure functions, and an UNKNOWN field falls through to real
//    localStorage — including its throw. A consumer that used to see a throw
//    still sees a throw, and its documented direction is untouched.
//
// ══ WHAT IT COSTS TO READ ════════════════════════════════════════════════
//
// EXACTLY ONE GET per page load, shared. load() memoises its own promise, so
// the boot-time callers (cutover notice, then first-run guidance) and the
// much-later caller (the AI-Health privacy consent, on a click) all resolve
// against one request. Nothing here runs on navigate(), so a view switch
// costs zero requests — this is not per-view state and must never become it.
//
// Writes are one POST per RECORDED FACT, and every field is write-once or
// monotonic, so the ceiling is four POSTs for the life of an install.

// localStorage key  ->  server field. The left column is the shipping key
// name, unchanged: renaming any of them would strand the value it is the
// whole point of this module to rescue.
//
// scripts/test-ui-state.js ENUMERATES the curator-* keys from disk and fails
// on any key that appears in neither this map nor its documented STAYS list,
// so a key added later cannot quietly inherit "per-device" by default.
export const UI_STATE_KEYS = Object.freeze({
  'curator-ai-health-disclosure-seen-v1': 'aiHealthDisclosureSeen',
  'curator-next-onboarding-dismissed-v1': 'onboardingDismissed',
  'curator-next-cutover-notice-v1': 'cutoverNoticeDismissed',
  'curator-next-install-origin-v1': 'installOrigin',
});

// Mirrors UI_STATE_SPEC in src/brain/config.js. The server is authoritative —
// it refuses anything outside its own allow-list whatever this table says —
// but the client validates too, so a corrupted localStorage value is never
// promoted into the config file in the first place. scripts/test-ui-state.js
// compares the two tables field for field and value for value, because two
// hand-maintained copies of one rule is the v3.2.0 CRITICAL shape.
export const UI_STATE_VALUES = Object.freeze({
  aiHealthDisclosureSeen: Object.freeze(['yes']),
  onboardingDismissed: Object.freeze(['1']),
  cutoverNoticeDismissed: Object.freeze(['1']),
  installOrigin: Object.freeze(['pre', 'post']),
});

// The one field a user can deliberately UN-set: views/onboarding.js's
// clearDismissed(), reached from Settings' "Show setup guide". Kept here as
// well as on the server so removeItem() knows whether a clear is even worth
// sending, and asserted against the server's own `clearable` flag by
// scripts/test-ui-state.js so the two cannot drift.
export const UI_STATE_CLEARABLE = Object.freeze(['onboardingDismissed']);

const FIELDS = Object.freeze(Object.values(UI_STATE_KEYS));
const FIELD_TO_LS = Object.freeze(Object.fromEntries(
  Object.entries(UI_STATE_KEYS).map(([lsKey, field]) => [field, lsKey]),
));

function validFor(field, value) {
  const allowed = UI_STATE_VALUES[field];
  return !!allowed && typeof value === 'string' && allowed.includes(value);
}

// ═════════════════════════════════════════════════════════════════════════
// PURE LOGIC — no DOM, no fetch, no storage, so the suite can drive every
// decision offline and in both directions.
// ═════════════════════════════════════════════════════════════════════════

/**
 * The merge, per field. `server` and `local` are the raw stored strings or
 * null. Returns the string to use, or null for "still not recorded".
 *
 * ONE RULE, and it is the whole safety property:
 *
 *     A RECORDED VALUE WINS. The server is consulted first; a null on either
 *     side never erases a value on the other.
 *
 * Read in the two directions that matter:
 *   • server has nothing, browser has a consent  -> the consent stands (this
 *     is the pre-migration case: a no-op for every existing user, because the
 *     answer is byte-identical to the localStorage value they already had).
 *   • browser is a fresh partition, server has the consent -> the consent
 *     stands (this is the migration case, and the reason the module exists).
 *
 * An earlier draft carried a per-field 'union' vs 'server-wins' table. It was
 * deleted rather than shipped: the two rules coincide on every input this
 * allow-list can produce, so the table was an unwired field dressed as a
 * policy — the shape this repo keeps re-learning. Server-first is what
 * installOrigin needs ("written ONCE and never re-decided" — its own header),
 * and it costs the three monotonic fields nothing, because their `values`
 * lists hold a single literal and there is no second value for the two sides
 * to disagree about.
 *
 * Anything invalid on either side is treated as ABSENT rather than trusted —
 * the same rule views/cutover-notice.js's readOrigin() already applies to a
 * value from a future version or a key some other tool squatted on.
 */
export function mergeField(field, server, local) {
  const s = validFor(field, server) ? server : null;
  const l = validFor(field, local) ? local : null;
  return s !== null ? s : l;
}

/**
 * What must be sent to the server so it holds the merged truth.
 *
 * Only fields whose merged value differs from what the server already has —
 * so a warm install promotes nothing and a migrating install promotes exactly
 * what it rescued. Returns a plain object; `{}` means "nothing to do", and the
 * caller must not POST at all in that case (an empty POST would rewrite the
 * credential file for no reason).
 */
export function promotionPatch(serverMap, localMap) {
  const patch = {};
  for (const field of FIELDS) {
    const server = serverMap ? serverMap[field] : null;
    const merged = mergeField(field, server, localMap ? localMap[field] : null);
    if (merged !== null && merged !== (validFor(field, server) ? server : null)) {
      patch[field] = merged;
    }
  }
  return patch;
}

/** The merged view of both sides, every field present, null where unrecorded. */
export function mergeState(serverMap, localMap) {
  const out = {};
  for (const field of FIELDS) {
    out[field] = mergeField(
      field,
      serverMap ? serverMap[field] : null,
      localMap ? localMap[field] : null,
    );
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════
// Module state
// ═════════════════════════════════════════════════════════════════════════

// The merged record. `null` until load() has resolved; a field is present here
// only when it has a KNOWN value, so an absent field falls through to real
// localStorage in durableStorage() and every consumer's own fail-safe
// direction survives untouched.
let cache = null;
let loadPromise = null;

// Wrapped rather than referenced directly, exactly like views/onboarding.js's
// and views/cutover-notice.js's own helpers: some privacy modes throw on the
// `window.localStorage` PROPERTY ACCESS, not only on getItem. The stand-in
// throws from every method, which is what lets a consumer keep seeing the
// throw it already handles.
function rawStorage() {
  try {
    return window.localStorage;
  } catch {
    return {
      getItem() { throw new Error('no storage'); },
      setItem() { throw new Error('no storage'); },
      removeItem() { throw new Error('no storage'); },
    };
  }
}

function readLocalMap() {
  const out = {};
  for (const field of FIELDS) {
    // Each read in its OWN try/catch: one unreadable key must not discard the
    // other three, which is what a single try around the loop would do.
    try { out[field] = rawStorage().getItem(FIELD_TO_LS[field]); } catch { out[field] = null; }
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════
// Network
// ═════════════════════════════════════════════════════════════════════════

async function getServerMap() {
  const res = await fetch('/api/config/ui-state');
  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  // v2.3.3 SPA fall-through: src/server.js answers an unknown path with
  // index.html at HTTP 200, so res.json() would throw `Unexpected token '<'`.
  // Treat that as "the server told us nothing", never as a crash.
  if (!ct.includes('application/json')) return null;
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || typeof data !== 'object' || !data.ui || typeof data.ui !== 'object') return null;
  return data.ui;
}

async function postPatch(patch) {
  const res = await fetch('/api/config/ui-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok || !ct.includes('application/json')) return null;
  const data = await res.json();
  return (data && data.ui && typeof data.ui === 'object') ? data.ui : null;
}

// ═════════════════════════════════════════════════════════════════════════
// Entry points
// ═════════════════════════════════════════════════════════════════════════

/**
 * Load once per page, memoised, and NEVER throw.
 *
 * This runs on the boot path. views/cutover-notice.js and views/onboarding.js
 * both document the same hard safety property: app.js calls markBooted()
 * immediately after boot() returns, and next/index.html's <head> guard treats
 * an unset window.__curatorBooted at DOMContentLoaded as proof the module
 * died — it then paints a full-page recovery panel TO EVERY USER. This
 * function is `async` and its whole body is inside try/catch, so it can
 * neither throw synchronously nor reject.
 *
 * The promotion POST is deliberately NOT awaited: the merged answer is already
 * known once the GET lands, and making first paint wait on a write buys
 * nothing. If the POST fails the values simply stay in localStorage and are
 * promoted again on the next load, which is the same fail-safe shape
 * writeDismissed() already has.
 */
export function loadUiState() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    let serverMap = null;
    try { serverMap = await getServerMap(); } catch { serverMap = null; }
    const localMap = readLocalMap();
    const merged = mergeState(serverMap, localMap);
    // Only fields with a KNOWN value enter the cache — see `cache` above.
    const known = {};
    for (const field of FIELDS) if (merged[field] !== null) known[field] = merged[field];
    cache = known;

    // Promote ONLY when the server actually answered. With serverMap === null
    // we cannot tell an empty server from an unreachable one, and POSTing on
    // an unreachable one would just fail; worse, treating "unreachable" as
    // "empty" is how a fact and its ABSENCE get collapsed into one value.
    if (serverMap) {
      const patch = promotionPatch(serverMap, localMap);
      if (Object.keys(patch).length > 0) {
        postPatch(patch).catch(() => { /* retried on the next load */ });
      }
    }
    return { ...merged };
  })().catch(() => {
    // Unreachable — the body above cannot reject — but a rejected boot-path
    // promise is the one failure this file is not allowed to have, so the
    // guard is written rather than argued.
    cache = {};
    return mergeState(null, null);
  });
  return loadPromise;
}

/**
 * A `storage`-shaped adapter over the merged record, keyed by the SHIPPING
 * localStorage key names.
 *
 * Drop-in for the object views/onboarding.js and views/cutover-notice.js
 * already build and inject into their own pure functions — which is why those
 * functions, and the assertions in scripts/test-cutover.js and
 * scripts/test-next-onboarding.js that drive them with a fake storage, are
 * untouched by this change.
 */
export function durableStorage() {
  return {
    getItem(key) {
      const field = UI_STATE_KEYS[key];
      // A KNOWN merged value answers immediately. An UNKNOWN one — nothing
      // recorded anywhere, or a key this module does not own — falls through
      // to real localStorage AND ITS THROW, so the caller's own documented
      // fail-safe direction is preserved exactly.
      if (field && cache && Object.hasOwn(cache, field)) return cache[field];
      return rawStorage().getItem(key);
    },
    setItem(key, value) {
      const field = UI_STATE_KEYS[key];
      const str = String(value);
      // localStorage is still written, deliberately. It is the fast path for
      // the NEXT load in this same partition, and it keeps this change purely
      // additive: an older build reading these keys still finds them.
      try { rawStorage().setItem(key, str); } catch { /* private mode — the server copy is the durable one */ }
      if (!field || !validFor(field, str)) return;
      if (cache) cache[field] = str;
      postPatch({ [field]: str }).catch(() => { /* localStorage still holds it; promoted next load */ });
    },
    // Only views/onboarding.js's clearDismissed() reaches this, from
    // Settings' "Show setup guide". It must NOT be swallowed: without the
    // server clear, localStorage would be emptied while the durable record
    // still said "dismissed", so the merge would keep hiding the panel and
    // the button would appear to persist nothing. The immediate re-open is
    // unaffected either way — openOnboardingPanel() opens the panel directly
    // — so a failed POST costs only the durability of the re-open, which is
    // the same best-effort shape writeDismissed() already has.
    removeItem(key) {
      const field = UI_STATE_KEYS[key];
      try { rawStorage().removeItem(key); } catch { /* private mode */ }
      // A clear aimed at a field the server refuses to clear leaves the
      // DURABLE record standing — the cache is deliberately not emptied,
      // because emptying it would make a recorded consent read as un-given
      // for the rest of the session while the server still held it. Nothing
      // in the tree does this today; the branch exists so that if something
      // ever does, the answer is "the durable record wins" rather than a
      // silent half-clear.
      if (!field || !UI_STATE_CLEARABLE.includes(field)) return;
      if (cache) delete cache[field];
      postPatch({ [field]: null }).catch(() => { /* re-shows next load at worst */ });
    },
  };
}

/** Test seam — clears the memoised load so a suite can drive it twice. */
export function __resetUiState() {
  cache = null;
  loadPromise = null;
}
