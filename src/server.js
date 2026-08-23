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
import configRouter  from './routes/config.js';
import healthRouter from './routes/health.js';
import mcpRouter    from './routes/mcp.js';
import compileRouter from './routes/compile.js';
import sharedbrainRouter from './routes/sharedbrain.js';
import diagnosticsRouter from './routes/diagnostics.js';
import { getProviderInfo } from './brain/llm.js';
import { hasActiveWrites, conflictResponse } from './brain/write-registry.js';
import { APP_ROOT, getCredentialFiles } from './brain/paths.js';

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

const app = express();
const PORT = process.env.PORT || 3333;

// Raised from the 100kb default so a large Health batch plan (the broken-link /
// orphan apply endpoints POST the full plan as JSON — 1000+ entries on a mature
// domain) doesn't get rejected with HTTP 413. This is a localhost app, so a
// generous limit carries no DoS risk.
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  res.json({ version, onDiskVersion, restartRequired });
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

// ── /next — Phase 1 UI redesign shell (parallel; does not touch the shipping
// app in any way). Static assets under it (tokens/, assets/, app.js, ...)
// are already served by the express.static() mount above, since
// src/public/next/** lives inside src/public/. A request for the bare
// "/next" path (no trailing slash) is actually caught by that same
// express.static() mount first: it recognizes "next" as a directory and
// issues its own 301 to "/next/" before this route ever runs (harmless —
// every browser follows it transparently). This route's real job is
// "/next/": it resolves to THIS shell's index.html instead of falling
// through to the SPA catch-all below, which would otherwise serve the
// shipping app's index.html at that path. The bare "/next" is kept in the
// list too as a direct fallback, in case that static-redirect behavior
// ever changes.
app.get(['/next', '/next/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'next', 'index.html'));
});

// Catch-all: serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

let server;
function startListen(retriesLeft = MAX_BIND_RETRIES) {
  server = app.listen(PORT, BIND_HOST, () => {
    try {
      const { provider, model } = getProviderInfo();
      const providerLabel = provider === 'gemini' ? '🟦 Gemini' : '🟣 Anthropic';
      console.log(`The Curator v${version} running at http://localhost:${PORT}`);
      console.log(`LLM provider: ${providerLabel}  |  model: ${model}`);
    } catch (err) {
      console.log(`The Curator running at http://localhost:${PORT}`);
      console.warn(`⚠️  ${err.message}`);
    }

    // Auto-open the browser when server starts (skip during restart — frontend reloads itself)
    if (!process.env.CURATOR_NO_OPEN) {
      exec(`open http://localhost:${PORT}`);
    }
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
      // Port still held by the predecessor — wait briefly and retry.
      // The remaining-retries count is logged so /tmp/the-curator.log shows
      // how long the previous process held on.
      console.error(`[server] Port ${PORT} busy, retrying in ${BIND_RETRY_DELAY_MS}ms (${retriesLeft} retries left)`);
      setTimeout(() => startListen(retriesLeft - 1), BIND_RETRY_DELAY_MS);
    } else {
      console.error(`[server] Failed to bind port ${PORT}: ${err.code || ''} ${err.message}`);
      process.exit(1);
    }
  });
}

startListen();
