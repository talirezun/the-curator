import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import domainsRouter from './routes/domains.js';
import ingestRouter from './routes/ingest.js';
import queryRouter from './routes/query.js';
import wikiRouter from './routes/wiki.js';
import chatRouter from './routes/chat.js';
import syncRouter from './routes/sync.js';
import { getProviderInfo } from './brain/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Shutdown endpoint — kills the server process cleanly
app.post('/api/shutdown', (req, res) => {
  res.json({ message: 'Server shutting down...' });
  setTimeout(() => process.exit(0), 300);
});

// Catch-all: serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  try {
    const { provider, model } = getProviderInfo();
    const providerLabel = provider === 'gemini' ? '🟦 Gemini' : '🟣 Anthropic';
    console.log(`Second Brain running at http://localhost:${PORT}`);
    console.log(`LLM provider: ${providerLabel}  |  model: ${model}`);
  } catch (err) {
    console.log(`Second Brain running at http://localhost:${PORT}`);
    console.warn(`⚠️  ${err.message}`);
  }
});
