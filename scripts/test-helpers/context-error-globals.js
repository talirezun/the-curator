// test-helpers/context-error-globals.js — v3.99.2.
//
// Suites that lift functions out of views/memory.js by brace-matching and run
// them inside `new Function(...)` see only globals. Since plain-language
// errors, those functions call net.js's helpers (plainError, errorDetailHtml,
// userMessageFrom, renderErrorDetail) and the Context page's four helpers from
// shared/foundations-init.js (failText, withDetailOf, supportOf, errorLines).
// Importing this module puts the REAL exports on globalThis, so a sandbox runs
// the same code the browser runs (never a stub). Import it for its side
// effect: `import './test-helpers/context-error-globals.js';`
import './net-globals.js';
import * as FI from '../../src/public/next/shared/foundations-init.js';

for (const name of ['failText', 'withDetailOf', 'supportOf', 'errorLines']) {
  if (!(name in globalThis)) globalThis[name] = FI[name];
}
