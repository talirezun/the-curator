// The machine this app runs on, in the words a user reads: "this Mac" on
// macOS, "this PC" on Windows, "this computer" on Linux or when unknown.
//
// The server is local-only (127.0.0.1), so the browser that draws the page runs
// on the same machine as the server and `navigator` is a truthful source. A view
// that already holds the install status (`data.platform`) passes that instead.
// Outside a browser (the DOM-free suites import these modules) there is no
// `document`; the default there is 'darwin' so the original macOS strings stay
// byte-identical, and a suite pins another platform with setPlatform().

let forced = null;

/** Test seam: pin the platform ('darwin' | 'win32' | 'linux' | '' for unknown); null clears. */
export function setPlatform(p) { forced = p === undefined ? null : p; }

/** 'darwin' | 'win32' | 'linux' | '' (unknown). */
export function browserPlatform() {
  if (forced !== null) return forced;
  if (typeof document === 'undefined') return 'darwin';
  try {
    const n = globalThis.navigator || {};
    const s = String((n.userAgentData && n.userAgentData.platform) || n.platform || n.userAgent || '');
    if (/win/i.test(s) && !/darwin/i.test(s)) return 'win32';
    if (/mac|iphone|ipad/i.test(s)) return 'darwin';
    if (/linux|x11|cros/i.test(s)) return 'linux';
  } catch { /* fall through */ }
  return '';
}

/** 'Mac' | 'PC' | 'computer' — for "this <word>". With no argument, the browser's platform. */
export function machineWord(platform) {
  const p = arguments.length ? platform : browserPlatform();
  return p === 'win32' ? 'PC' : p === 'darwin' ? 'Mac' : 'computer';
}
