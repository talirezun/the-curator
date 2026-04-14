import 'dotenv/config';
import express from 'express';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import domainsRouter from './routes/domains.js';
import ingestRouter from './routes/ingest.js';
import queryRouter from './routes/query.js';
import wikiRouter from './routes/wiki.js';
import chatRouter from './routes/chat.js';
import syncRouter from './routes/sync.js';
import configRouter  from './routes/config.js';
import { getProviderInfo } from './brain/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Read version once at startup
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url))
);

const app = express();
const PORT = process.env.PORT || 3333;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/domains', domainsRouter);
app.use('/api/ingest', ingestRouter);
app.use('/api/query', queryRouter);
app.use('/api/wiki', wikiRouter);
app.use('/api/chat', chatRouter);
app.use('/api/sync', syncRouter);
app.use('/api/config',  configRouter);
app.get('/api/health',  (_req, res) => res.json({ ok: true, version }));

// Version endpoint — used by the UI to display the current app version
app.get('/api/version', (req, res) => res.json({ version }));

// ── Heartbeat: detect when the browser tab closes ────────────────────────────
// The frontend sends a heartbeat every 30 seconds. If no heartbeat arrives for
// 90 seconds, we assume the user closed the tab and shut down the server.
// This gives the clean "close tab = stop app" UX.
let lastHeartbeat = Date.now();
let heartbeatTimer = null;

app.post('/api/heartbeat', (_req, res) => {
  lastHeartbeat = Date.now();
  res.json({ ok: true });
});

function startHeartbeatMonitor() {
  heartbeatTimer = setInterval(() => {
    const elapsed = Date.now() - lastHeartbeat;
    if (elapsed > 90000) { // 90 seconds without heartbeat
      console.log('[server] No browser heartbeat for 90s — shutting down.');
      clearInterval(heartbeatTimer);
      process.exit(0);
    }
  }, 15000); // Check every 15 seconds
}

// ── Shutdown endpoint — clean stop ───────────────────────────────────────────
app.post('/api/shutdown', (_req, res) => {
  res.json({ ok: true });
  clearInterval(heartbeatTimer);
  setTimeout(() => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  }, 300);
});

// ── Restart endpoint — stops this server, spawns a new one ───────────────────
// Used by the Update flow. Closes the current server first (freeing the port),
// then spawns a new detached node process that takes over.
app.post('/api/restart', (_req, res) => {
  res.json({ ok: true, restarting: true });
  clearInterval(heartbeatTimer);

  setTimeout(() => {
    // First close THIS server to free port 3333
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => {
      // Port is now free — spawn the new server
      exec(
        `cd "${PROJECT_ROOT}" && nohup node src/server.js >> /tmp/the-curator.log 2>&1 &`,
        { cwd: PROJECT_ROOT }
      );
      // Exit this process
      setTimeout(() => process.exit(1), 500);
    });
    // Safety: if server.close hangs, force exit after 3 seconds
    setTimeout(() => {
      exec(
        `cd "${PROJECT_ROOT}" && nohup node src/server.js >> /tmp/the-curator.log 2>&1 &`,
        { cwd: PROJECT_ROOT }
      );
      process.exit(1);
    }, 3000);
  }, 300);
});

// Catch-all: serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  lastHeartbeat = Date.now();
  startHeartbeatMonitor();

  try {
    const { provider, model } = getProviderInfo();
    const providerLabel = provider === 'gemini' ? '🟦 Gemini' : '🟣 Anthropic';
    console.log(`The Curator v${version} running at http://localhost:${PORT}`);
    console.log(`LLM provider: ${providerLabel}  |  model: ${model}`);
  } catch (err) {
    console.log(`The Curator running at http://localhost:${PORT}`);
    console.warn(`⚠️  ${err.message}`);
  }
});
