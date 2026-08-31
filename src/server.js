import 'dotenv/config';
import express from 'express';
import path from 'path';
import { readFileSync, chmodSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import domainsRouter from './routes/domains.js';
import ingestRouter from './routes/ingest.js';
import queryRouter from './routes/query.js';
import wikiRouter from './routes/wiki.js';
import chatRouter from './routes/chat.js';
import syncRouter from './routes/sync.js';
import configRouter, { maybeAutoSyncOpenRouter } from './routes/config.js';
import healthRouter from './routes/health.js';
import mcpRouter    from './routes/mcp.js';
import compileRouter from './routes/compile.js';
import sharedbrainRouter from './routes/sharedbrain.js';
import diagnosticsRouter from './routes/diagnostics.js';
import ingestQueueRouter from './routes/ingest-queue.js';
import memoryRouter from './routes/memory.js';
import writeStatusRouter from './routes/write-status.js';
import { getProviderInfo } from './brain/llm.js';
import { hasActiveWrites, conflictResponse } from './brain/write-registry.js';
import { APP_ROOT, getCredentialFiles } from './brain/paths.js';
import { describeInstall } from './brain/install-mode.js';
import { recoverOnBoot as recoverIngestQueueOnBoot } from './brain/ingest-queue.js';
import { logInfo, logWarn, logError, getLogFilePath } from './brain/logger.js';
import { ensureMcpLauncherShim } from './brain/mcp-launcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// APP_ROOT is the CODE root (read-only in a packaged .app). Used for the
// restart spawn and as its cwd. User-data paths come from paths.js instead.
const PROJECT_ROOT = APP_ROOT;

// Read version once at startup
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url))
);

// ── Credential-file permission hardening (v3.0.1-beta.20) ─────────────────────
// New writes already land at 0600 via writeFileAtomic({mode}). This one-shot
// startup sweep catches files created by an OLDER version (which wrote 0644),
// so existing installs are hardened immediately rather than on the next write.
// Best-effort + per-file try/catch: a file owned by another user, or absent,
// must never block startup. .knowledge-git/config is included because git
// embeds the sync PAT in the remote URL there.
// v3.1.0+: the list comes from paths.js (shared with diagnostics.js), so the
// sweep automatically follows these files if the user-data dir moves out of the
// app root — as it does in a packaged .app.
for (const { abs } of getCredentialFiles()) {
  try {
    if (existsSync(abs)) chmodSync(abs, 0o600);
  } catch { /* best-effort */ }
}

// ── Batch-ingest queue boot recovery (Track 3) ─────────────────────────────────
// Any job left `running` on disk was interrupted by a crash or this very
// restart. Reset it to `paused`/`interrupted` for the user to review — this
// NEVER auto-resumes a worker (spending the user's API budget on its own on
// launch is unacceptable); it only makes the on-disk state consistent so the
// UI can offer a Resume button. Best-effort: must never block or fail startup.
recoverIngestQueueOnBoot()
  .then(({ recovered }) => {
    if (recovered > 0) {
      const msg = `Recovered ${recovered} interrupted batch job(s) on boot — paused for review.`;
      console.error(`[ingest-queue] ${msg}`);
      logWarn('ingest-queue', msg);
    }
  })
  .catch(err => {
    const msg = `Boot recovery failed (non-fatal): ${err && err.message}`;
    console.error(`[ingest-queue] ${msg}`);
    logError('ingest-queue', msg);
  });

const app = express();
const PORT = process.env.PORT || 3333;

// Raised from the 100kb default so a large Health batch plan (the broken-link /
// orphan apply endpoints POST the full plan as JSON — 1000+ entries on a mature
// domain) doesn't get rejected with HTTP 413. This is a localhost app, so a
// generous limit carries no DoS risk.
app.use(express.json({ limit: '50mb' }));

// ── Static assets — deliberately WITHOUT directory indexes (cutover) ─────────
// `index: false` is load-bearing, not tidiness. express.static defaults to
// `index: 'index.html'`, which means a request for "/" was answered by THIS
// MOUNT, from src/public/index.html, and never reached the app.get('*')
// catch-all below. Measured before the cutover: `GET /` returned the shipping
// app's <title>The Curator</title> AND returned 200 even with `Host: evil.com`,
// because this mount is registered ABOVE the Host-header guard.
//
// So flipping the catch-all alone would NOT have moved "/" to the new shell —
// the old app would have kept serving at "/" with three route-level guards all
// reporting success. Turning the index off makes the route table the single
// place that decides which HTML shell a path gets, instead of the answer
// depending on which middleware happened to match first.
//
// Two consequences, both deliberate:
//   - "/" now resolves through the catch-all, which sits BELOW the Host and
//     Origin guards, so it is covered by them for the first time. Strictly a
//     tightening; every real browser sends a loopback Host.
//   - Directory REDIRECTS are a separate option and stay on, so a bare "/next"
//     still 301s to "/next/" exactly as before; the explicit route below then
//     answers it (previously this mount's index option did).
// Asset requests (/app.js, /next/tokens/color.css, ...) are unaffected: they
// name a file, so the index option never applied to them.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Cross-origin guard (v3.0.1-beta.20) ───────────────────────────────────────
// The Curator binds to 127.0.0.1 (see startListen below), so it's not reachable
// from the LAN. The remaining browser-side risk is a malicious web page the user
// has open issuing state-changing fetch() calls to http://localhost:3333, or a
// DNS-rebinding attack pointing an attacker hostname at the loopback address.
// Both surface a cross-origin `Origin` header. We reject any MUTATING request
// whose Origin is present and not one of our own loopback origins. Requests with
// NO Origin header (curl, scripts, the documented revoke flow, server-to-server)
// are allowed — they aren't browser-driven and so aren't the CSRF vector. GETs
// are never blocked (static assets + SPA navigation).
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);

// ── Host-header guard (v3.0.2) ────────────────────────────────────────
// The Origin guard below only covers MUTATING requests — a DNS-rebinding page
// (attacker.com re-pointed at 127.0.0.1) makes what the browser considers
// same-origin GETs, with no Origin header and a fully readable response. That
// exposed every GET endpoint (wiki content, config, connection metadata).
// Rebinding cannot forge the Host header, so validating it closes the hole
// app-wide. Requests with no Host (bare HTTP/1.0 clients) are allowed — they
// are not browsers. The server only binds 127.0.0.1, so no legitimate client
// ever reaches us under a non-loopback hostname.
const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
  `[::1]:${PORT}`,
  'localhost',
  '127.0.0.1',
  '[::1]',
]);
app.use((req, res, next) => {
  const host = req.headers.host;
  if (host && !ALLOWED_HOSTS.has(host.toLowerCase())) {
    return res.status(403).json({
      error: 'Invalid Host header. The Curator only serves requests addressed ' +
             `to http://localhost:${PORT} or http://127.0.0.1:${PORT}.`,
    });
  }
  next();
});
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
app.use((req, res, next) => {
  if (!MUTATING_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({
      error: 'Cross-origin request blocked. The Curator only accepts requests ' +
             `from its own interface (http://localhost:${PORT}).`,
    });
  }
  next();
});

app.use('/api/domains', domainsRouter);
app.use('/api/ingest', ingestRouter);
app.use('/api/query', queryRouter);
app.use('/api/wiki', wikiRouter);
app.use('/api/chat', chatRouter);
app.use('/api/sync', syncRouter);
app.use('/api/config',  configRouter);
app.use('/api/health',  healthRouter);
app.use('/api/mcp',     mcpRouter);
app.use('/api/compile', compileRouter);
app.use('/api/sharedbrain', sharedbrainRouter);
app.use('/api/diagnostics', diagnosticsRouter);
app.use('/api/ingest-queue', ingestQueueRouter);
app.use('/api/memory', memoryRouter);
// READ route. Deliberately not registered as a write and not behind
// guardConcurrent — see the docblock in src/routes/write-status.js.
app.use('/api/write-status', writeStatusRouter);

// Version endpoint — used by the UI to display the current app version.
// Also reports on-disk version (from package.json) so the UI can detect
// "files updated but process not restarted" and prompt the user.
app.get('/api/version', (req, res) => {
  let onDiskVersion = version;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
    onDiskVersion = pkg.version;
  } catch { /* fall back to startup version */ }
  const restartRequired = onDiskVersion !== version;
  // installMode / capabilities ride along so the install form is OBSERVABLE
  // rather than inferred. Purely ADDITIVE: every existing consumer reads
  // `version`, `onDiskVersion` and `restartRequired`, and those are unchanged.
  res.json({ version, onDiskVersion, restartRequired, ...describeInstall() });
});

// ── Restart endpoint — used after updates ────────────────────────────────────
//
// Replaces this server process with a fresh one. Pre-v2.7.1 used
// exec("nohup ... &") + closure-callback chaining, which had a race:
// if server.close() callback hadn't fired by the safety-timeout (3s),
// the spawn could run while the old process still held port 3333,
// and the brand-new child would crash on EADDRINUSE — leaving zero
// servers running. Users would see a stuck "v2.x.y · restart" badge
// after every update.
//
// v2.7.1 fix: use Node-native `spawn` with `detached: true` + `unref()`
// for a properly-detached child that's independent of this process's
// stdio and lifecycle. Paired with EADDRINUSE retry on the listen call
// at startup (see startListenWithRetry below) so the child waits if
// the parent hasn't released the port yet.
app.post('/api/restart', (_req, res) => {
  // v3.0.1-beta.8: refuse to restart while any wiki write is in flight.
  // The spawn-and-exit dance kills the current process; an in-flight ingest
  // would lose its remaining writes. The atomic-write fix in this release
  // makes the partial state recoverable (no zero-byte files), but the
  // best UX is still to wait. Update flow (POST /api/update) has the same
  // guard so its restart trigger doesn't bypass this.
  if (hasActiveWrites()) {
    const { status, body } = conflictResponse('restart the app');
    return res.status(status).json(body);
  }
  logInfo('server', 'Restart requested — spawning a replacement process.');
  res.json({ ok: true, restarting: true });

  // Brief delay so the HTTP response can flush before we tear down.
  setTimeout(() => {
    // Spawn the replacement BEFORE we close this server. Detached + unref
    // makes the child fully independent — survives our process.exit.
    // The child inherits PATH and env vars (so npm and friends resolve
    // correctly under the .app wrapper).
    const child = spawn(
      process.execPath,
      [path.join(PROJECT_ROOT, 'src/server.js')],
      {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CURATOR_NO_OPEN: '1' },
      }
    );
    child.unref();

    // Force-close all open connections (idle keep-alives included) so the
    // port is released for the new child as fast as possible.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();

    // Exit after a brief grace period. The child has EADDRINUSE retry on its
    // listen call, so even if we haven't fully released the port by the time
    // it tries to bind, it'll wait and retry rather than crashing.
    setTimeout(() => process.exit(0), 500);
  }, 200);
});

// ═══ THE CUTOVER (v3.9.0) ════════════════════════════════════════════════════
// "/" and the SPA catch-all now serve the REDESIGNED shell
// (src/public/next/index.html). The shipping frontend is NOT removed — it
// stays reachable at "/old" for 2-3 releases, and every one of its files
// (src/public/{app,markdown}.js, index.html, styles.css) is byte-untouched.
//
// The two shells resolve their assets DIFFERENTLY, and that difference is what
// makes the path shapes below load-bearing:
//
//   next/index.html  — all 18 refs are ROOT-ABSOLUTE and /next/-prefixed
//                      (test-next-asset-paths.js pins this; v3.6.1 made them
//                      so precisely for today). It therefore loads the same
//                      /next/app.js no matter which path served the HTML, so
//                      "/", "/next/" and a deep SPA path are interchangeable.
//
//   public/index.html — refs are BARE-RELATIVE (src="app.js"). Those resolve
//                      against the DIRECTORY of the URL that served the page.
//                      At "/old" the directory is "/", so src="app.js" →
//                      "/app.js", which the static mount serves. At "/old/"
//                      the directory is "/old/", so it would request
//                      "/old/app.js" — no such file — which the catch-all
//                      would answer with the NEXT shell's HTML at 200
//                      text/html, and the browser would parse HTML as
//                      JavaScript. That is the v3.6.1 landmine in mirror
//                      image, so "/old/" is REDIRECTED to "/old" rather than
//                      served. 302, not 301: a permanently-cached redirect on
//                      a path we intend to retire is not worth the recovery
//                      story.
//
// The trailing-slash test is INSIDE one handler, on req.path, and not a
// second `app.get('/old/')` route. Express's router is non-strict by default,
// so a '/old/' route ALSO matches '/old' — a separate route therefore caught
// both and redirected '/old' to itself. Reproduced live before this shape:
// `GET /old` answered 302 -> /old, an endless loop where the shipping app
// used to be. Making the router strict would have fixed it too and is the
// wrong trade: `strict` is app-wide and would change matching for every
// existing route.
app.get('/old', (req, res) => {
  if (req.path !== '/old') return res.redirect(302, '/old');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// /next keeps working — bookmarks, muscle memory, and every link written
// during the redesign. It serves the SAME shell as "/" (one file, not a copy).
// A bare "/next" is still 301'd to "/next/" by the static mount's directory
// redirect (that option is unrelated to `index: false`); this route then
// answers "/next/". The bare form is kept in the list as a direct fallback in
// case that redirect behaviour ever changes.
app.get(['/next', '/next/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'next', 'index.html'));
});

// Catch-all: serve the SPA shell. Post-cutover this is the NEXT shell — and
// because the static mount above now runs with `index: false`, "/" reaches
// here too rather than being answered by a directory index.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'next', 'index.html'));
});

// Listen with EADDRINUSE retry (v2.7.1).
//
// When triggered by /api/restart, the new child may try to bind before the
// previous process has fully released the port. Pre-v2.7.1 this caused the
// child to crash and the user to be left with zero servers running — visible
// as a stuck "restart" badge that never resolved after an update.
//
// The retry loop tolerates up to 6 seconds of port-hold (60 × 100ms). Any
// other listen error (permission denied, address unavailable, etc.) bails
// immediately rather than spinning indefinitely.
const MAX_BIND_RETRIES = 60;
const BIND_RETRY_DELAY_MS = 100;

// v3.0.1-beta.20: bind to the loopback interface only. Previously the server
// bound to 0.0.0.0 (all interfaces), so anyone on the same LAN/Wi-Fi could reach
// :3333 and hit unauthenticated endpoints (config, sync, ingest). The Curator is
// a single-user localhost app — 127.0.0.1 matches that intent and removes the
// LAN attack surface entirely.
const BIND_HOST = '127.0.0.1';

// id-keyed with a safe default (v3.15.x): a plain `a === 'gemini' ? X : Y`
// binary ternary has no third arm, so a third (or fourth) provider silently
// renders as whichever name sits in the "else" branch — the exact v3.10.1
// credential-crossing shape, here in a log line rather than a write. An
// unrecognised id must render its OWN id, never another provider's label.
// Object.hasOwn (not a bare `in`/index) so a garbage id like '__proto__' or
// 'constructor' can't resolve to an inherited Object.prototype member.
const PROVIDER_STARTUP_LABELS = Object.freeze({
  gemini:     '🟦 Gemini',
  anthropic:  '🟣 Anthropic',
  openrouter: '🟠 OpenRouter',
});
function providerStartupLabel(provider) {
  return Object.hasOwn(PROVIDER_STARTUP_LABELS, provider)
    ? PROVIDER_STARTUP_LABELS[provider]
    : `❓ ${provider}`;
}

let server;
function startListen(retriesLeft = MAX_BIND_RETRIES) {
  server = app.listen(PORT, BIND_HOST, () => {
    try {
      const { provider, model } = getProviderInfo();
      const providerLabel = providerStartupLabel(provider);
      console.log(`The Curator v${version} running at http://localhost:${PORT}`);
      console.log(`LLM provider: ${providerLabel}  |  model: ${model}`);
      console.log(`Log file: ${getLogFilePath()}`);
      logInfo('server', `The Curator v${version} started at http://localhost:${PORT} — provider: ${provider} · model: ${model}`);
    } catch (err) {
      console.log(`The Curator running at http://localhost:${PORT}`);
      console.warn(`⚠️  ${err.message}`);
      logWarn('server', `Started at http://localhost:${PORT}, but provider info could not be resolved: ${err.message}`);
    }

    // ── Keep the Claude Desktop launcher current ────────────────────────────
    //
    // A NO-OP IN REPO MODE — the capability says 'node-script', so this
    // returns `not-needed` having touched no filesystem path at all. In bundle
    // mode it rewrites a small shell shim naming the CURRENT app binary,
    // because the app is the only process that knows where it is and launch is
    // the only moment it is guaranteed to be running (src/brain/mcp-launcher.js
    // carries the full argument, including why shipping the shim and why
    // having the wizard write it are both wrong).
    //
    // It never throws — a failure here must never take the server down — and a
    // refusal (translocated app, Downloads) writes nothing and says why.
    try {
      const shim = ensureMcpLauncherShim();
      if (shim.reason === 'written') {
        logInfo('server', `MCP launcher written at ${shim.path}`);
      } else if (!shim.ok) {
        logWarn('server', `MCP launcher not written (${shim.reason}): ${shim.message}`);
      }
    } catch (err) {
      logWarn('server', `MCP launcher generation failed unexpectedly: ${err.message}`);
    }

    // Auto-open the browser when server starts (skip during restart — frontend reloads itself)
    if (!process.env.CURATOR_NO_OPEN) {
      exec(`open http://localhost:${PORT}`);
    }

    // ── Refresh the OpenRouter model catalogue if it is absent or stale ──────
    //
    // WHY IT IS HERE, AFTER listen(), AND NOT AT MODULE SCOPE IN THE ROUTER.
    // The catalogue used to be populated ONLY by a user pressing Sync in
    // Settings: before that press chat offered the 5 hand-measured OpenRouter
    // routes, after it ~190, and nothing said which state you were in. A list
    // that is silently partial is worse than a short one, because the user
    // cannot tell it is partial.
    //
    // The trigger belongs to a SERVER BOOT, not to importing a module. Firing it
    // from `routes/config.js`'s module scope would make any suite that imports
    // that file for an unrelated helper reach the network and write a catalogue
    // sidecar into the real user-data directory — `test-beta10-fixes.js` does
    // exactly that import and does not isolate. Binding it to `listen()` makes
    // "only a real boot syncs" structural rather than a list of suites to
    // remember.
    //
    // Placed INSIDE the listen callback and never awaited, so it cannot delay
    // the port binding by a single millisecond. Every failure mode is absorbed
    // by `maybeAutoSyncOpenRouter` itself: it is key-gated config-only, it
    // defers to any write in flight, it cannot throw, and a failed or empty
    // fetch leaves the existing catalogue completely intact.
    // The SKIP is logged, not just the run. Two reasons, both practical:
    // a user asking "why is my OpenRouter model list short?" gets the answer
    // in the app's own log file (getLogFilePath() — see src/brain/logger.js;
    // this used to say /tmp/the-curator.log, which is a shell redirect the
    // AppleScript wrapper sets up, not anything the app itself owns, and
    // does not exist at all in a packaged bundle), and the call itself
    // becomes observable, which is the only way to see that this line is
    // still wired without standing up a network fetch at boot.
    maybeAutoSyncOpenRouter()
      .then(r => {
        if (r && !r.ran) {
          console.error(`[config] OpenRouter catalogue auto-sync skipped (${r.reason})`);
          logWarn('config', `OpenRouter catalogue auto-sync skipped (${r.reason})`);
        }
      })
      .catch(() => {});
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
      // Port still held by the predecessor — wait briefly and retry. The
      // remaining-retries count is logged so the app's own log file (see
      // getLogFilePath() in src/brain/logger.js) shows how long the
      // previous process held on.
      console.error(`[server] Port ${PORT} busy, retrying in ${BIND_RETRY_DELAY_MS}ms (${retriesLeft} retries left)`);
      logWarn('server', `Port ${PORT} busy, retrying in ${BIND_RETRY_DELAY_MS}ms (${retriesLeft} retries left)`);
      setTimeout(() => startListen(retriesLeft - 1), BIND_RETRY_DELAY_MS);
    } else {
      console.error(`[server] Failed to bind port ${PORT}: ${err.code || ''} ${err.message}`);
      logError('server', `Failed to bind port ${PORT}: ${err.code || ''} ${err.message}`);
      process.exit(1);
    }
  });
}

startListen();
