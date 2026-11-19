// test-helpers/net-globals.js — v3.99.2.
//
// Several suites lift functions out of a view file by brace-matching and run
// them inside `new Function(...)`. Since plain-language errors, those view
// functions call shared/net.js's helpers (plainError, errorDetailHtml, …) as
// imported names, which a lifted function cannot see. Importing this module
// puts the REAL net.js exports on globalThis, where a `new Function` body
// resolves free names, so a sandbox runs the same code the browser runs
// (never a stub). Import it for its side effect: `import './test-helpers/net-globals.js';`
import * as net from '../../src/public/next/shared/net.js';

for (const [name, value] of Object.entries(net)) {
  if (!(name in globalThis)) globalThis[name] = value;
}
