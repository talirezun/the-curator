/**
 * Can this ingest finish writing? Checked BEFORE the first paid call.
 *
 * An ingest spends money on its model calls and only then writes. A wiki built
 * elsewhere (Obsidian, Logseq, a plain folder) often lacks log.md or index.md,
 * may have a file where a folder should be, a folder where a file should be,
 * or a read-only folder. Before this check such a run paid for every call and
 * then threw while writing, so the user paid and got an error.
 *
 * What is NOT a problem, and so never refused here:
 *   - a missing log.md or index.md: the ingest creates them (appendLog and
 *     ensurePagesInIndex);
 *   - a missing entities/, concepts/ or summaries/ (or a missing wiki/): the
 *     page writer creates the folder.
 *
 * What is refused, with a sentence naming the path and what to do:
 *   - wiki/, raw/, entities/, concepts/ or summaries/ exists but is not a folder;
 *   - log.md, index.md or this source's summary page is a folder or another
 *     non-file, or is a symbolic link (the atomic writer refuses to write
 *     through a link, so it would fail after spending);
 *   - a folder the ingest writes into is not writable.
 *
 * Read-only: stats and access checks only, never a write. Every path is built
 * from files.js's wikiPath / rawPath, which resolve through paths.js.
 */
import { lstat, stat, access } from 'fs/promises';
import { constants as FS } from 'fs';
import path from 'path';
import { wikiPath, rawPath, domainPath } from './files.js';

async function lstatOrNull(p) {
  try { return await lstat(p); } catch (err) { if (err && err.code === 'ENOENT') return null; throw err; }
}

async function writable(dir) {
  try { await access(dir, FS.W_OK | FS.X_OK); return true; } catch { return false; }
}

/** A folder: absent is fine; it must be a folder (a link to one is fine) and writable. */
async function checkFolder(abs, rel, problems) {
  const l = await lstatOrNull(abs);
  if (!l) return false;
  let isDir = l.isDirectory();
  if (!isDir && l.isSymbolicLink()) {
    try { isDir = (await stat(abs)).isDirectory(); } catch { isDir = false; }
  }
  if (!isDir) {
    problems.push(`"${rel}" is a file, not a folder. The Curator writes pages into a folder of that name — rename or move that file, then ingest again.`);
    return true;
  }
  if (!(await writable(abs))) {
    problems.push(`The folder "${rel}" is read-only, so no page could be written there. Make it writable, then ingest again.`);
  }
  return true;
}

/** A file the ingest rewrites: absent is fine; else a regular file, not a link. */
async function checkFile(abs, rel, problems) {
  const l = await lstatOrNull(abs);
  if (!l) return;
  if (l.isSymbolicLink()) {
    problems.push(`"${rel}" is a symbolic link. The Curator never writes through a link, so it could not update this file — replace the link with the file itself, then ingest again.`);
  } else if (l.isDirectory()) {
    problems.push(`"${rel}" is a folder, not a file. The Curator keeps a file of that name — rename or move the folder, then ingest again.`);
  } else if (!l.isFile()) {
    problems.push(`"${rel}" is not an ordinary file, so The Curator could not update it. Remove it, then ingest again.`);
  }
}

/**
 * @param {string} domain
 * @param {string} [summaryPath]  e.g. 'summaries/report.md' — the page this source writes
 * @returns {Promise<string[]>}   one plain sentence per problem; empty when the ingest can write
 */
export async function ingestWriteProblems(domain, summaryPath) {
  const problems = [];
  const wiki = wikiPath(domain);
  const hasWiki = await checkFolder(wiki, 'wiki', problems);
  if (problems.length) return problems;   // nothing below can be judged
  if (!hasWiki && !(await writable(domainPath(domain)))) {
    problems.push(`The domain folder "${domain}" is read-only, so its wiki folder could not be created. Make it writable, then ingest again.`);
    return problems;
  }
  await checkFolder(rawPath(domain), 'raw', problems);
  if (hasWiki) {
    // Every write in wiki/ makes a temporary file beside its target and renames
    // it into place, so wiki/ itself must be writable: for log.md and index.md,
    // and to create a page folder that is missing.
    if (!(await writable(wiki))) {
      problems.push(`The folder "wiki" is read-only, so log.md, index.md and any missing page folder could not be written. Make it writable, then ingest again.`);
    }
    for (const folder of ['entities', 'concepts', 'summaries']) {
      await checkFolder(path.join(wiki, folder), `wiki/${folder}`, problems);
    }
    await checkFile(path.join(wiki, 'log.md'), 'wiki/log.md', problems);
    await checkFile(path.join(wiki, 'index.md'), 'wiki/index.md', problems);
    if (typeof summaryPath === 'string' && summaryPath) {
      await checkFile(path.join(wiki, summaryPath), `wiki/${summaryPath}`, problems);
    }
  }
  return [...new Set(problems)];
}

/** Throws one plain error before anything is spent when the ingest could not finish writing. */
export async function assertIngestCanWrite(domain, summaryPath) {
  const problems = await ingestWriteProblems(domain, summaryPath);
  if (problems.length === 0) return;
  const err = new Error(
    `Nothing was sent to the AI and nothing was charged: this ingest could not save its pages. ` +
    problems.join(' ')
  );
  err.code = 'INGEST_CANNOT_WRITE';
  err.status = 409;
  err.problems = problems;
  throw err;
}
