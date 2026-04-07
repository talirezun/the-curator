import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOMAINS_DIR = path.resolve(__dirname, '../../domains');

export function domainPath(domain) {
  return path.join(DOMAINS_DIR, domain);
}

export function wikiPath(domain) {
  return path.join(DOMAINS_DIR, domain, 'wiki');
}

export function rawPath(domain) {
  return path.join(DOMAINS_DIR, domain, 'raw');
}

export async function listDomains() {
  const entries = await readdir(DOMAINS_DIR, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

export async function readSchema(domain) {
  const schemaFile = path.join(DOMAINS_DIR, domain, 'CLAUDE.md');
  return readFile(schemaFile, 'utf8');
}

export async function readWikiPages(domain) {
  const wikiDir = wikiPath(domain);
  const pages = [];
  await collectMarkdown(wikiDir, wikiDir, pages);
  return pages;
}

async function collectMarkdown(baseDir, dir, pages) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdown(baseDir, full, pages);
    } else if (entry.name.endsWith('.md')) {
      const content = await readFile(full, 'utf8');
      const relativePath = path.relative(baseDir, full);
      pages.push({ path: relativePath, content });
    }
  }
}

export async function writePage(domain, relativePath, content) {
  const fullPath = path.join(wikiPath(domain), relativePath);
  const dir = path.dirname(fullPath);
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content, 'utf8');
}

export async function appendLog(domain, entry) {
  const logFile = path.join(wikiPath(domain), 'log.md');
  const existing = await readFile(logFile, 'utf8');
  await writeFile(logFile, existing + entry + '\n', 'utf8');
}

export async function readIndex(domain) {
  const indexFile = path.join(wikiPath(domain), 'index.md');
  if (!existsSync(indexFile)) return '';
  return readFile(indexFile, 'utf8');
}

export async function writeIndex(domain, content) {
  const indexFile = path.join(wikiPath(domain), 'index.md');
  await writeFile(indexFile, content, 'utf8');
}
