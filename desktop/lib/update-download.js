/**
 * update-download.js — stream one release asset to disk, hashing as it goes,
 * with the same retry ladder the Mac engine uses.
 *
 * WHY A SECOND COPY OF THE MAC ENGINE'S DOWNLOAD, AND HOW IT IS KEPT HONEST.
 * The Mac adapter (update-install-darwin.js) is the v3.99.3 update-engine.js
 * moved BYTE-FOR-BYTE, by the owner's requirement for the Windows split: the
 * macOS suites must stay green unchanged, and the strongest proof of that is a
 * file nobody edited. Its download lives inside its closure, so it cannot be
 * shared without editing it. This module is that download, ported, for the
 * Windows adapter. Three things keep the two from drifting:
 *   · the retry TABLES are not copied: DOWNLOAD_ATTEMPTS, DOWNLOAD_BACKOFF_MS,
 *     PROGRESS_BYTES, isRetryableNetworkError and isRetryableStatus are
 *     imported from the Mac adapter, so there is one definition of each;
 *   · scripts/test-desktop-update-win32.js runs the Mac suite's retry-ladder
 *     cases (500 then 200, 429, 404 never retried, abort during a wait,
 *     truncation, oversize) against this module;
 *   · the day the Mac adapter is next edited for any reason, it should switch
 *     to this module and the copy disappears.
 *
 * No Electron, no `src/`. Every effect is injected.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';

import {
  DOWNLOAD_ATTEMPTS, DOWNLOAD_BACKOFF_MS, PROGRESS_BYTES,
  isRetryableNetworkError, isRetryableStatus,
} from './update-install-darwin.js';
import { updateFailure } from './update-plan.js';

const isAbortError = (err) => !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');

/** Write errors that mean "this disk/folder will not take the file". EPERM and
 *  EBUSY are the Windows additions: antivirus or Controlled Folder Access. */
const WRITE_ERRNOS = new Set(['ENOSPC', 'EDQUOT', 'EACCES', 'EROFS', 'EPERM', 'EBUSY']);

/**
 * @param {object} deps
 * @param {Function} deps.fetchImpl
 * @param {Function} [deps.sleepImpl]
 */
export function createDownloader(deps = {}) {
  const {
    fetchImpl = globalThis.fetch,
    sleepImpl = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  } = deps;

  const waitBeforeRetry = async (ms, signal) => {
    if (signal && signal.aborted) return false;
    const listens = signal && typeof signal.addEventListener === 'function';
    let release = null;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      if (listens) {
        release = () => { try { signal.removeEventListener('abort', done); } catch { /* not an EventTarget */ } };
        signal.addEventListener('abort', done, { once: true });
      }
      Promise.resolve(sleepImpl(ms)).then(done, done);
    });
    if (release) release();
    return !(signal && signal.aborted);
  };

  const discardBody = async (response) => {
    try { if (response && response.body && typeof response.body.cancel === 'function') await response.body.cancel(); } catch { /* already gone */ }
  };

  /** The initial request, retrying ONLY the transient class (see the Mac
   *  adapter's docblock above DOWNLOAD_ATTEMPTS for the incident and the
   *  table). Nothing is hashed or written here. */
  async function openDownload({ asset, signal }) {
    let lastStatus = null;
    let lastDetail = null;
    let serverSide = false;
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      if (signal && signal.aborted) return updateFailure('download-cancelled', null, { attempts: attempt - 1 });
      let response = null;
      try {
        response = await fetchImpl(asset.url, { redirect: 'follow', signal: signal || undefined });
      } catch (err) {
        if (isAbortError(err)) return updateFailure('download-cancelled', null, { attempts: attempt });
        if (!isRetryableNetworkError(err)) return updateFailure('download-failed', err && err.message, { attempts: attempt });
        serverSide = false;
        lastStatus = null;
        lastDetail = (err && err.message) || 'network error';
        if (attempt === DOWNLOAD_ATTEMPTS) break;
        if (!await waitBeforeRetry(DOWNLOAD_BACKOFF_MS[attempt - 1], signal)) {
          return updateFailure('download-cancelled', null, { attempts: attempt });
        }
        continue;
      }
      if (!response) return updateFailure('download-failed', 'no response', { attempts: attempt });
      if (response.status === 404 || response.status === 410) {
        await discardBody(response);
        return updateFailure('download-not-found', `status ${response.status}`, { attempts: attempt, lastStatus: response.status });
      }
      if (response.ok) {
        if (!response.body) return updateFailure('download-failed', 'response carried no body', { attempts: attempt });
        return { ok: true, response, attempts: attempt };
      }
      await discardBody(response);
      serverSide = true;
      lastStatus = response.status;
      lastDetail = `status ${response.status}`;
      if (!isRetryableStatus(response.status)) {
        return updateFailure('download-failed', `status ${response.status}`, { attempts: attempt, lastStatus: response.status });
      }
      if (attempt === DOWNLOAD_ATTEMPTS) break;
      if (!await waitBeforeRetry(DOWNLOAD_BACKOFF_MS[attempt - 1], signal)) {
        return updateFailure('download-cancelled', null, { attempts: attempt, lastStatus: response.status });
      }
    }
    const extra = { attempts: DOWNLOAD_ATTEMPTS, ...(lastStatus === null ? {} : { lastStatus }) };
    const detail = `${lastDetail} after ${DOWNLOAD_ATTEMPTS} attempts`;
    return serverSide
      ? updateFailure('download-server-error', detail, extra)
      : updateFailure('download-failed', detail, extra);
  }

  /**
   * Stream `asset` to `filePath`. `{ok:true, bytes, digest}` or a named
   * failure. Aborts MID-STREAM on oversize, honours backpressure, and waits
   * for the file to close before returning (the Mac engine's measured 0-byte
   * leftover, avoided the same way).
   */
  async function downloadAsset({ asset, filePath, signal, emit = () => {} }) {
    const opened = await openDownload({ asset, signal });
    if (!opened.ok) return opened;
    const { response } = opened;

    const hash = createHash(asset.digest ? asset.digest.algorithm : 'sha256');
    const out = createWriteStream(filePath, { mode: 0o600 });
    let received = 0;
    let lastEmit = 0;
    const write = (chunk) => new Promise((resolve, reject) => {
      if (out.write(chunk)) resolve();
      else out.once('drain', resolve);
      out.once('error', reject);
    });

    try {
      for await (const chunk of response.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buf.length;
        if (received > asset.size) {
          throw Object.assign(new Error('oversized'), { curatorReason: 'download-oversized' });
        }
        hash.update(buf);
        await write(buf);
        if (received - lastEmit >= PROGRESS_BYTES) {
          lastEmit = received;
          emit('downloading', received, asset.size);
        }
      }
      await new Promise((resolve, reject) => { out.end((err) => (err ? reject(err) : resolve())); });
    } catch (err) {
      try { out.destroy(); } catch { /* already gone */ }
      await new Promise((resolve) => { if (out.closed) resolve(); else out.once('close', resolve); });
      if (err && err.curatorReason) return updateFailure(err.curatorReason);
      if (isAbortError(err)) return updateFailure('download-cancelled');
      if (err && WRITE_ERRNOS.has(err.code)) return updateFailure('download-write-failed', err.code);
      return updateFailure('download-truncated', err && err.message);
    }
    emit('downloading', received, asset.size);
    return { ok: true, bytes: received, digest: hash.digest('hex') };
  }

  return { openDownload, downloadAsset };
}

/** The digest of a file on disk, streamed. `null` when it cannot be read. */
export async function hashFile(filePath, algorithm = 'sha256') {
  try {
    const hash = createHash(algorithm);
    await new Promise((resolve, reject) => {
      const s = createReadStream(filePath);
      s.on('data', (c) => hash.update(c));
      s.on('error', reject);
      s.on('end', resolve);
    });
    return hash.digest('hex');
  } catch {
    return null;
  }
}
