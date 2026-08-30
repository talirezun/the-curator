# The visual harness

Every other offline suite in this repo says the same thing in its own header:
*nothing here measures real rendering, layout or contrast.* That is honest, and
it is a real gap. It let a stylesheet ship **styled but never loaded** for a
whole release; it let a fixed panel **swallow clicks** on primary buttons across
six views (first reported as a cosmetic text overlap, because someone compared
bounding boxes instead of asking `elementFromPoint` what was on top); it let
form controls sit **frozen at the browser's ~13.33px default** against the app's
own text-size setting. Each was invisible to a fully green `npm test`.

This directory runs the real server on an ephemeral port, drives a real browser,
and measures what the browser actually did.

---

## Running it

```bash
node scripts/visual/run.js                    # measure, then diff against the baseline
node scripts/visual/run.js --record           # (re)record the baseline
node scripts/visual/run.js --json out.json    # dump the full raw report
node scripts/visual/run.js --views chat,domains --themes dark
node scripts/visual/run.js --with-onboarding  # measure with the first-run panel docked
```

As a test suite:

```bash
node scripts/test-visual-regression.js        # LIVE_LOCAL; part of `npm run test:live`
node scripts/test-visual-contrast-math.js     # OFFLINE; part of `npm test`
```

Exit codes: `0` pass or skip, `1` regression or hard failure.

### It needs a browser, and adds no dependency

**No package is added to `package.json`, deliberately.** The auto-updater runs
`npm install` on every end-user machine, so a browser-driver dependency would
download a browser onto the machine of everyone who has ever installed The
Curator, to support a test they will never run. This repo already refused to
commit Playwright for exactly that reason.

Instead: Node 22 ships a WHATWG `WebSocket` on `globalThis`, and the Chrome
DevTools Protocol is JSON-RPC over a WebSocket. So the whole driver is
[`cdp.js`](cdp.js) plus [`browser.js`](browser.js), talking to whatever
Chrome/Chromium/Edge/Brave is already installed, launched headless with a
throwaway profile on an **ephemeral** debugging port.

With no browser installed the suite prints a `⊘` line, **no assertion tally**,
and exits 0 — the same self-skip contract a live suite uses for a missing API
key. `CURATOR_VISUAL_BROWSER=/path/to/binary` overrides the search and is
**authoritative**: if you name a binary and it is not there, that is a skip, not
a silent fallback to some other browser.

### Safety

- **Never binds port 3333.** The maintainer runs the live app there. A free port
  is taken from the OS and asserted not to be 3333.
- **Every in-page probe re-checks `location.port`** against the port we started
  and *throws* on a mismatch, plus throws on a zero-width viewport. The browser
  is shared between agents on this machine, and one agent's measurement has
  already landed on another agent's server here. A measurement that cannot
  prove its own origin is not recorded.
- **Both isolation seams are set** (`CURATOR_TEST_USER_DATA_DIR` *and*
  `CURATOR_TEST_DOMAINS_DIR`) so the child server never holds the maintainer's
  real `.curator-config.json` or `.sync-config.json`. Provider keys are also
  deleted from the child's environment, because `.env` is a documented gap in
  that seam. **No LLM call is possible; the run costs $0.**
- **Only our own child PIDs are ever signalled.** No `pkill`, no `killall`, no
  port sweep, anywhere in this directory.
- The fixture is a throwaway domain in a tempdir, removed on teardown. The API
  key written into the isolated config is a deliberate fake.

---

## Recording and reading a baseline

```bash
node scripts/visual/run.js --record
```

writes `baselines/next-shell.json` — a **normalised** subset of the run:
per view × theme, the failing-contrast set, the occluded-control set, dead
stylesheets, console errors, control counts, the typography histogram, and the
horizontal-overflow flag; plus per-asset status/content-type and the
font-scale-frozen set. Timestamps, ports and browser build are deliberately
excluded: they move for reasons that are not regressions, and a baseline that
goes red on those trains people to re-record without reading it.

Then `node scripts/visual/run.js` classifies every difference:

| line | meaning |
|---|---|
| `✗ REGRESSION` | **fails the run.** A new occlusion, a new contrast failure, a stylesheet that stopped applying, a new console error, a newly frozen font-size, a broken asset, new horizontal overflow. |
| `✓ improvement` | a defect the baseline recorded is gone. Re-record to lock it in. |
| `· change` | a count moved (controls, typography). Informational — read it, decide. |

**It is a ratchet, not an absolute.** The app has real, documented,
known-unfixed contrast failures today (179 across 14 view/theme combinations
at the time of writing — mostly `--text-3` at 4.27 dark / 4.14 light against a
4.5 floor, which this project's own release notes already record). Failing on
those would make the harness red on day one, which is how a guard gets ignored.
The baseline pins the current set; the diff fails only on **additions**. The gap
cannot grow, and shrinking it is reported as an improvement.

**Recording a baseline is asserting "this is the state I accept." Read it first.**

---

## ENFORCED

Each of these has a **positive control that must fire on every run** — the
harness plants the defect in the live app, confirms the detector catches it,
removes it, and confirms the app is back to its prior reading. A guard that
cannot fail is this project's single most recurring defect, and this one refuses
to report a clean sweep until it has proven it can report a dirty one.

1. **Assets reachable over HTTP with the right content-type.** Every same-origin
   `href`/`src` in `next/index.html` is fetched and its content-type checked.
   This matters *specifically* because the SPA catch-all answers **any**
   unmatched path with `200 text/html` — a missing asset never 404s here, so the
   status code alone proves nothing. Control: a request for
   `/next/__visual_harness_definitely_missing__.css` must come back as the shell.
2. **Stylesheets actually apply.** A sheet can be `<link>`ed, served 200, and
   still contribute nothing. `cssRules.length` is the only thing that
   distinguishes that. Control: a `<link>` is repointed at a missing path
   through the real server and must be detected as inert.
3. **Controls are reachable at their own centre**, via `document.elementFromPoint`.
   Control: a full-viewport pointer-catching overlay must flip every reachable
   control to occluded, and the occluder must be *named*.
4. **Contrast**, from browser-resolved colours composited down the real ancestor
   chain, graded against the WCAG floor each element's own size and weight
   implies. Controls: grey-on-identical-grey must measure exactly `1.00` and
   fail; and the composited model is checked against **pixels Chrome actually
   painted** (1×1 screenshot clips, decoded with a dependency-free PNG decoder
   over `node:zlib`) at every eligible point.
5. **Response to the app's own text-size setting.** Every text-bearing element
   is measured at `--font-scale: 1` and again at `1.18`; anything that did not
   move is reported as frozen. Control: a planted hardcoded-px element must
   appear in that list. *You cannot grep for an absent declaration — this
   measures the behaviour instead.*
6. **The shell boots** (`window.__curatorBooted`) with no console errors, in
   every view × theme.
7. **No horizontal overflow** of the document.
8. **The origin guard itself**, executed rather than grepped: the offline suite
   runs each probe in a sandbox with a faked `location` and requires it to
   throw. A comment naming `location.port` would satisfy a source scan; it
   cannot satisfy that.

Cross-checked against reality: the harness independently reproduces, to two
decimals, six contrast figures this project measured by hand in a real browser
during earlier releases — `--text-3` at **4.27** dark / **4.14** light,
`--text-2` at **8.55** / **7.02**, and panel text at **8.09** / **7.26** —
including `.sidebar-hint` at exactly the 4.27 its own release note records.

---

## NOT ENFORCED

Named, not implied away. A green run does **not** mean any of the following.

- **Appearance.** Nothing here is a screenshot comparison. The app could be
  restyled beyond recognition and pass, as long as it stays legible, reachable
  and unbroken. This measures properties, not looks.
- **Headless is not headed.** macOS draws its classic scrollbars only when a
  mouse is attached, so the v3.19.0 "thick draggable divider" report **cannot**
  reproduce here. Font rasterisation and sub-pixel antialiasing also differ.
- **One browser engine.** Chromium only. WebKit and Gecko lay out and paint
  differently.
- **One viewport, one scale.** 1280×860 at `deviceScaleFactor: 1`. Nothing is
  measured responsively; the recorded 375px shell collapse is **not** covered.
- **One state per view.** The default, freshly-entered state only. No hover, no
  focus rings, no open listbox popups, no modals, no confirm dialogs, no
  wizards, no scrolled positions, no error or loading states. Whole surfaces —
  the reader overlay, both wizards, the semantic-merge preview — are never
  entered.
- **Occlusion is tested at the CENTRE only.** A control covered at its edges but
  clear at its centre passes. Overlap is not the same question as reachability,
  and only reachability is asked.
- **Contrast is modelled, not sampled, for text.** The backdrop is composited
  from `background-color` down the ancestor chain. Where a gradient, image,
  filter, blend mode or transparent ancestor is involved, the model is a guess —
  those measurements are marked `uncertain`, **reported with a count, and never
  ratcheted as verdicts** (6 of 720 at the time of writing, all ancestor
  opacity). Glyph antialiasing is not accounted for, so thin or light text can
  read worse on screen than its number.
- **The paint cross-check has a narrow scope.** It validates the backdrop model
  only at points inside a plain background-colour fill, clear of borders, corner
  radii and any self-painting descendant — 10 eligible points out of 103
  candidates on the last run. It is a spot-check on the model, not a proof of
  every number.
- **Text measurement is capped** at 400 elements per view (`textTotal` reports
  the true count) and covers only elements with a *direct* text node.
- **No accessibility beyond contrast.** No focus order, no keyboard traversal,
  no ARIA, no screen-reader semantics, no `prefers-reduced-motion`,
  `forced-colors` or high-contrast modes.
- **Fixture data, not real data.** One tiny synthetic domain. Long titles, many
  domains, empty states and error states are all unmeasured.
- **The baseline records defects.** It says the app has not got *worse*. It says
  nothing about whether it is *good*.

---

## Files

| file | what it is |
|---|---|
| `run.js` | CLI: measure, record, diff |
| `harness.js` | orchestration, asset check, contrast grading, the in-browser detector controls |
| `probes.js` | functions stringified into the page; each carries the origin guard |
| `cdp.js` | ~200-line CDP client over Node's built-in `WebSocket` |
| `browser.js` | find + launch a browser; isolated profile, ephemeral port, own-PID-only teardown |
| `server.js` | isolated Curator server + throwaway fixture |
| `contrast.js` | pure WCAG maths (luminance, compositing, ratio, floors) |
| `png.js` | dependency-free PNG decode over `node:zlib`, for real painted pixels |
| `baseline.js` | normalise, record, diff |
| `baselines/` | recorded baselines |

## If you change a probe

Probes are **stringified into the page**, so they must stay self-contained: no
imports, no closure over module scope, no shared helpers. Every one must keep
its `expectPort` guard — `test-visual-contrast-math.js` §7 executes each of them
with a mismatched port and requires a throw, so dropping the guard turns that
suite red rather than quietly widening the blast radius.
