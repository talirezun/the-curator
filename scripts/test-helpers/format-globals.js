// test-helpers/format-globals.js — kit v1 (2026-11-27).
//
// The same device as net-globals.js, for shared/format.js: several suites
// lift view functions by brace-matching and run them inside `new Function`,
// and since kit v1 those functions write their sizes, counts and token
// figures through format.js's exports (fmtSize, fmtCount, fmtTokens, …),
// imported names a lifted function cannot see. Importing this module puts
// the REAL exports on globalThis, where a `new Function` body resolves free
// names, so the sandbox runs the code the browser runs (never a stub).
// Import it for its side effect: `import './test-helpers/format-globals.js';`
import * as format from '../../src/public/next/shared/format.js';

for (const [name, value] of Object.entries(format)) {
  if (!(name in globalThis)) globalThis[name] = value;
}
