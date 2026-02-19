/**
 * downloader.js
 * Download engine: chunked Range requests, parallel downloads,
 * exponential backoff retry, TTL expiry evaluation, storage-aware deferral,
 * resume support across page/SW restarts, and online/offline coordination.
 *
 * Files are stored as raw Blobs with no interpretation of their contents.
 * MIME type is taken from the registry entry when set, or inferred from the
 * Content-Type response header when the registry entry has mimeType: null.
 */

import { dbGet, dbGetAll, dbPut, STORES } from './db.js';
import { DOWNLOAD_STATUS, evaluateExpiry, computeExpiresAt } from './registry.js';
import { emit } from './events.js';
import { hasEnoughSpace } from './storage.js';
import { startConnectivityMonitor, isOnline } from './connectivity.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const CHUNK_SIZE           = 2 * 1024 * 1024; // 2 MB per Range request
const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // Files over 5 MB use chunked Range requests
const DEFAULT_CONCURRENCY  = 2;
const MAX_RETRY_COUNT      = 5;
const BACKOFF_BASE_MS      = 1000;            // Doubles per retry: 1s, 2s, 4s, 8s, 16s

// Active AbortControllers keyed by file id
const _activeDownloads = new Map();

// Options from the most recent downloadFiles() call, used when auto-resuming after reconnect
let _lastDownloadOptions = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep        = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffDelay = (n)  => BACKOFF_BASE_MS * Math.pow(2, n);

async function updateQueue(id, patch) {
  const entry = await dbGet(STORES.DOWNLOAD_QUEUE, id);
  if (entry) await dbPut(STORES.DOWNLOAD_QUEUE, { ...entry, ...patch });
}

/**
 * Probes a URL with HEAD to determine Range support, content size, and MIME type.
 *
 * Content-Length is only reliable when the server is NOT applying content-encoding
 * (gzip/br/deflate). When Content-Encoding is present Content-Length reflects the
 * compressed transfer size, not the decompressed bytes stored — so we return
 * totalBytes: null and let progress show as indeterminate.
 *
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<{ supportsRange: boolean, totalBytes: number|null, mimeType: string|null }>}
 */
async function probeFile(url, signal) {
  try {
    const res           = await fetch(url, { method: 'HEAD', signal });
    const acceptsRanges = res.headers.get('Accept-Ranges') === 'bytes';
    const encoding      = res.headers.get('Content-Encoding');
    const isEncoded     = !!encoding && encoding !== 'identity';
    const contentLength = res.headers.get('Content-Length');
    const totalBytes    = (contentLength && !isEncoded) ? parseInt(contentLength, 10) : null;
    const mimeType      = parseMimeType(res.headers.get('Content-Type'));
    return { supportsRange: acceptsRanges, totalBytes, mimeType };
  } catch {
    return { supportsRange: false, totalBytes: null, mimeType: null };
  }
}

/**
 * Strips charset and other parameters from a Content-Type header value.
 * Returns null if the input is absent or empty.
 * e.g. 'application/json; charset=utf-8' → 'application/json'
 *
 * @param {string|null} contentType
 * @returns {string|null}
 */
function parseMimeType(contentType) {
  if (!contentType) return null;
  const mime = contentType.split(';')[0].trim();
  return mime || null;
}

/**
 * Merges an array of Uint8Array chunks into a single contiguous Uint8Array.
 */
function mergeChunks(chunks) {
  const totalLength = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged      = new Uint8Array(totalLength);
  let offset        = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return merged;
}

// ─── Core download logic ──────────────────────────────────────────────────────

/**
 * Downloads a single file with retry/backoff. On success stores the result as a
 * typed Blob directly on the queue record.
 *
 * MIME type resolution order:
 *   1. registryEntry.mimeType if explicitly set
 *   2. Content-Type from the HEAD probe
 *   3. Content-Type from the GET response headers
 *   4. 'application/octet-stream' as a final fallback
 *
 * @param {object} registryEntry
 * @returns {Promise<void>}
 */
async function downloadSingleFile(registryEntry) {
  const { id, downloadUrl, ttl } = registryEntry;
  const abortController = new AbortController();
  _activeDownloads.set(id, abortController);

  let queueEntry = await dbGet(STORES.DOWNLOAD_QUEUE, id);
  let retryCount = queueEntry?.retryCount ?? 0;

  while (retryCount <= MAX_RETRY_COUNT) {
    try {
      await updateQueue(id, {
        status:        DOWNLOAD_STATUS.IN_PROGRESS,
        lastAttemptAt: Date.now(),
        retryCount,
        errorMessage:  null,
      });
      emit('status', { id, status: DOWNLOAD_STATUS.IN_PROGRESS });

      // Re-read to get current byteOffset in case we're resuming
      queueEntry = await dbGet(STORES.DOWNLOAD_QUEUE, id);
      const byteOffset = queueEntry?.byteOffset ?? 0;

      let supportsRange    = false;
      let totalBytes       = queueEntry?.totalBytes ?? registryEntry.totalBytes ?? null;
      let resolvedMimeType = registryEntry.mimeType ?? null; // may be null — filled in below

      if (byteOffset === 0) {
        const probe   = await probeFile(downloadUrl, abortController.signal);
        supportsRange = probe.supportsRange;
        if (probe.totalBytes) {
          totalBytes = probe.totalBytes;
          await updateQueue(id, { totalBytes });
        }
        // Use probed MIME type only when registry didn't specify one
        if (!resolvedMimeType && probe.mimeType) {
          resolvedMimeType = probe.mimeType;
        }
      } else {
        supportsRange = true; // Used Range before — assume still supported
      }

      const useChunking = supportsRange && totalBytes && totalBytes > LARGE_FILE_THRESHOLD;
      let buffer;
      let responseMimeType = null; // filled by downloadFull when not chunking

      if (useChunking) {
        buffer = await downloadInChunks(id, downloadUrl, byteOffset, totalBytes, abortController.signal);
      } else {
        const result = await downloadFull(id, downloadUrl, abortController.signal);
        buffer           = result.buffer;
        responseMimeType = result.mimeType;
      }

      // Final MIME type: registry > probe > GET response > fallback
      const mimeType    = resolvedMimeType ?? responseMimeType ?? 'application/octet-stream';
      const blob        = new Blob([buffer], { type: mimeType });
      const completedAt = Date.now();
      const expiresAt   = computeExpiresAt(completedAt, ttl);

      await updateQueue(id, {
        status:          DOWNLOAD_STATUS.COMPLETE,
        blob,
        bytesDownloaded: buffer.byteLength,
        byteOffset:      buffer.byteLength,
        completedAt,
        expiresAt,
        errorMessage:    null,
        deferredReason:  null,
      });

      emit('complete', { id, mimeType });
      _activeDownloads.delete(id);
      return;

    } catch (err) {
      if (err.name === 'AbortError') {
        await updateQueue(id, { status: DOWNLOAD_STATUS.PAUSED });
        emit('status', { id, status: DOWNLOAD_STATUS.PAUSED });
        _activeDownloads.delete(id);
        return;
      }

      retryCount++;

      if (retryCount > MAX_RETRY_COUNT) {
        await updateQueue(id, {
          status:       DOWNLOAD_STATUS.FAILED,
          retryCount,
          errorMessage: err.message,
        });
        emit('error', { id, error: err, retryCount });
        _activeDownloads.delete(id);
        return;
      }

      const delay = backoffDelay(retryCount - 1);
      console.warn(`[offline-data-manager] "${id}" failed (attempt ${retryCount}), retrying in ${delay}ms:`, err.message);
      emit('error', { id, error: err, retryCount, willRetry: true });
      await updateQueue(id, { status: DOWNLOAD_STATUS.PENDING, retryCount, errorMessage: err.message });
      await sleep(delay);
    }
  }
}

/**
 * Downloads the full file in a single GET request.
 * Returns { buffer: Uint8Array, mimeType: string|null }
 */
async function downloadFull(id, downloadUrl, signal) {
  const response = await fetch(downloadUrl, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  const encoding   = response.headers.get('Content-Encoding');
  const isEncoded  = !!encoding && encoding !== 'identity';
  const rawLength  = response.headers.get('Content-Length');
  const totalBytes = (rawLength && !isEncoded) ? parseInt(rawLength, 10) : null;
  const mimeType   = parseMimeType(response.headers.get('Content-Type'));

  const reader   = response.body.getReader();
  const chunks   = [];
  let downloaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.byteLength;
    await updateQueue(id, { bytesDownloaded: downloaded, totalBytes });
    emit('progress', {
      id,
      bytesDownloaded: downloaded,
      totalBytes,
      percent: totalBytes ? Math.round((downloaded / totalBytes) * 100) : null,
    });
  }

  return { buffer: mergeChunks(chunks), mimeType };
}

/**
 * Downloads a file in sequential Range request chunks, resuming from byteOffset.
 * Returns a Uint8Array of the complete file bytes.
 */
async function downloadInChunks(id, downloadUrl, startOffset, totalBytes, signal) {
  let offset     = startOffset;
  const chunks   = [];
  let downloaded = startOffset;

  while (offset < totalBytes) {
    const end      = Math.min(offset + CHUNK_SIZE - 1, totalBytes - 1);
    const response = await fetch(downloadUrl, {
      signal,
      headers: { Range: `bytes=${offset}-${end}` },
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status} on Range bytes=${offset}-${end}`);
    }

    const chunk = new Uint8Array(await response.arrayBuffer());
    chunks.push(chunk);
    offset     += chunk.byteLength;
    downloaded += chunk.byteLength;

    await updateQueue(id, { bytesDownloaded: downloaded, byteOffset: offset });
    emit('progress', {
      id,
      bytesDownloaded: downloaded,
      totalBytes,
      percent: Math.round((downloaded / totalBytes) * 100),
    });
  }

  return mergeChunks(chunks);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluates TTL expiry, then downloads everything that needs it.
 *
 * Eligible statuses (when resumeOnly is false):
 *   pending, in-progress, paused, deferred, expired
 *   + failed entries when retryFailed: true
 *
 * If the browser is currently offline, the call returns immediately after
 * marking any in-progress entries as paused. Downloads will auto-resume
 * when connectivity is restored (if startConnectivityMonitor() was called).
 *
 * @param {object}  [options]
 * @param {number}  [options.concurrency=2]    — max parallel downloads
 * @param {boolean} [options.resumeOnly=false] — only resume in-progress/paused
 * @param {boolean} [options.retryFailed=false] — re-queue failed entries before running
 * @returns {Promise<void>}
 */
export async function downloadFiles({
  concurrency  = DEFAULT_CONCURRENCY,
  resumeOnly   = false,
  retryFailed  = false,
} = {}) {
  // Remember options so the connectivity monitor can re-use them on reconnect
  _lastDownloadOptions = { concurrency, resumeOnly, retryFailed };

  // If offline, pause anything in-progress and bail — don't burn retry attempts
  if (!isOnline()) {
    const allQueue = await dbGetAll(STORES.DOWNLOAD_QUEUE);
    for (const entry of allQueue) {
      if (entry.status === DOWNLOAD_STATUS.IN_PROGRESS) {
        _activeDownloads.get(entry.id)?.abort();
        _activeDownloads.delete(entry.id);
        await updateQueue(entry.id, {
          status:        DOWNLOAD_STATUS.PAUSED,
          deferredReason: 'network-offline',
        });
      }
    }
    emit('connectivity', { online: false });
    return;
  }

  // Check TTL expiry before deciding what to download
  await evaluateExpiry();

  // Optionally reset failed entries so they'll be picked up this run
  if (retryFailed) {
    const allQueue = await dbGetAll(STORES.DOWNLOAD_QUEUE);
    for (const entry of allQueue) {
      if (entry.status === DOWNLOAD_STATUS.FAILED) {
        await updateQueue(entry.id, {
          status:       DOWNLOAD_STATUS.PENDING,
          retryCount:   0,
          errorMessage: null,
        });
      }
    }
  }

  const [allRegistry, allQueue] = await Promise.all([
    dbGetAll(STORES.REGISTRY),
    dbGetAll(STORES.DOWNLOAD_QUEUE),
  ]);

  const registryMap = new Map(allRegistry.map((r) => [r.id, r]));

  const eligibleStatuses = resumeOnly
    ? [DOWNLOAD_STATUS.IN_PROGRESS, DOWNLOAD_STATUS.PAUSED]
    : [
        DOWNLOAD_STATUS.PENDING,
        DOWNLOAD_STATUS.IN_PROGRESS,
        DOWNLOAD_STATUS.PAUSED,
        DOWNLOAD_STATUS.DEFERRED,
        DOWNLOAD_STATUS.EXPIRED,
      ];

  const toDownload = allQueue
    .filter((q) => eligibleStatuses.includes(q.status))
    .sort((a, b) => {
      const pa = registryMap.get(a.id)?.priority ?? 10;
      const pb = registryMap.get(b.id)?.priority ?? 10;
      return pa - pb;
    });

  const queue    = [...toDownload];
  const inFlight = new Set();

  function runNext() {
    if (queue.length === 0) return;
    const queueEntry    = queue.shift();
    const registryEntry = registryMap.get(queueEntry.id);
    if (!registryEntry) return;

    const p = (async () => {
      // Storage check — defer rather than skip if space is insufficient
      const needed = registryEntry.totalBytes ?? queueEntry.totalBytes ?? 0;
      if (needed > 0 && !(await hasEnoughSpace(needed))) {
        await updateQueue(queueEntry.id, {
          status:         DOWNLOAD_STATUS.DEFERRED,
          deferredReason: 'insufficient-storage',
        });
        emit('deferred', { id: queueEntry.id, reason: 'insufficient-storage' });
        return;
      }
      await downloadSingleFile(registryEntry);
    })().finally(() => { inFlight.delete(p); runNext(); });

    inFlight.add(p);
  }

  const initialBatch = Math.min(concurrency, queue.length);
  for (let i = 0; i < initialBatch; i++) runNext();

  await new Promise((resolve) => {
    const interval = setInterval(() => {
      if (inFlight.size === 0 && queue.length === 0) {
        clearInterval(interval);
        resolve();
      }
    }, 100);
  });
}

/**
 * Aborts an active download, setting it to 'paused'.
 * It will resume on the next downloadFiles() call.
 * @param {string} id
 */
export async function abortDownload(id) {
  _activeDownloads.get(id)?.abort();
  _activeDownloads.delete(id);
}

/**
 * Aborts all active downloads.
 */
export async function abortAllDownloads() {
  for (const [id, ctrl] of _activeDownloads) {
    ctrl.abort();
    _activeDownloads.delete(id);
  }
}

/**
 * Resumes any downloads interrupted by a previous page or SW close.
 * Call this in a service worker 'activate' event.
 * @returns {Promise<void>}
 */
export async function resumeInterruptedDownloads() {
  await downloadFiles({ resumeOnly: true });
}

/**
 * Starts monitoring online/offline connectivity.
 *
 * - Going offline: all active downloads are paused immediately.
 * - Coming back online: downloadFiles() is called automatically with the
 *   same options as the most recent explicit call.
 *
 * Idempotent — safe to call multiple times. Call stopConnectivityMonitor()
 * to remove the listeners (useful in tests or cleanup).
 */
export function startMonitoring() {
  startConnectivityMonitor({
    pauseAll:  abortAllDownloads,
    resumeAll: () => downloadFiles(_lastDownloadOptions),
  });
}

/**
 * Stops online/offline monitoring.
 * Re-exported from connectivity.js for convenience.
 */
export { stopConnectivityMonitor as stopMonitoring } from './connectivity.js';
export { isOnline, isMonitoring } from './connectivity.js';