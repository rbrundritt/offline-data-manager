/**
 * downloader.js
 * Download engine: persistent queue loop, chunked Range requests, parallel
 * downloads, exponential backoff retry, TTL expiry evaluation, storage-aware
 * deferral, resume on startup, and online/offline coordination.
 *
 * Files are stored as ArrayBuffers with no interpretation of their contents.
 * MIME type is taken from the registry entry when set, or inferred from the
 * Content-Type response header when the registry entry has mimeType: null.
 *
 * ─── Loop model ──────────────────────────────────────────────────────────────
 *
 * Rather than a one-shot downloadFiles() that the caller must re-invoke,
 * startDownloads() starts a persistent internal loop that:
 *
 *   1. Drains whatever is currently pending/paused/deferred/expired.
 *   2. Waits (without polling) for new work to arrive.
 *   3. Wakes immediately when registerFile() adds a new entry or when the
 *      browser comes back online after an offline period.
 *   4. Exits cleanly when stopDownloads() is called.
 *
 * The caller only needs to call startDownloads() once. Registering new files
 * after that point will automatically trigger their download.
 */

import { dbGet, dbGetAll, dbPut, STORES } from './db.js';
import { DOWNLOAD_STATUS, evaluateExpiry, computeExpiresAt } from './registry.js';
import { emit } from './events.js';
import { hasEnoughSpace } from './storage.js';
import { startConnectivityMonitor, isOnline } from './connectivity.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const CHUNK_SIZE           = 2 * 1024 * 1024; // 2 MB per Range request
const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // Files > 5 MB use chunked Range requests
const DEFAULT_CONCURRENCY  = 2;
const MAX_RETRY_COUNT      = 5;
const BACKOFF_BASE_MS      = 1000;             // Doubles per retry: 1s, 2s, 4s, 8s, 16s

// ─── Loop state ───────────────────────────────────────────────────────────────

// Active AbortControllers keyed by file id
const _activeDownloads = new Map();

// Set when the loop is running; cleared by stopDownloads()
let _loopRunning = false;

// Wake mechanism — a pending Promise that resolves when new work arrives.
// _notifyNewWork() triggers it; the loop awaits _wakeSignal() when idle.
let _wakeResolve = null;

function _wakeSignal() {
  return new Promise((resolve) => { _wakeResolve = resolve; });
}

/** Called by registerFile() and the connectivity monitor to wake the loop. */
export function _notifyNewWork() {
  if (_wakeResolve) {
    const resolve = _wakeResolve;
    _wakeResolve  = null;
    resolve();
  }
}

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
 * Content-Length is only reliable when the server is NOT applying
 * content-encoding. When Content-Encoding is present it reflects the compressed
 * transfer size, not the stored bytes — so we return totalBytes: null and let
 * progress show as indeterminate.
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
 * e.g. 'application/json; charset=utf-8' → 'application/json'
 */
function parseMimeType(contentType) {
  if (!contentType) return null;
  const mime = contentType.split(';')[0].trim();
  return mime || null;
}

/** Merges an array of Uint8Array chunks into a single contiguous Uint8Array. */
function mergeChunks(chunks) {
  const totalLength = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged      = new Uint8Array(totalLength);
  let offset        = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return merged;
}

// ─── Core download logic ──────────────────────────────────────────────────────

/**
 * Downloads a single file with retry/backoff. On success stores the result as
 * an ArrayBuffer with a resolved mimeType directly on the queue record.
 *
 * MIME type resolution order:
 *   1. registryEntry.mimeType if explicitly set
 *   2. Content-Type from the HEAD probe
 *   3. Content-Type from the GET response headers
 *   4. 'application/octet-stream' as a final fallback
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
      let resolvedMimeType = registryEntry.mimeType ?? null;

      if (byteOffset === 0) {
        const probe   = await probeFile(downloadUrl, abortController.signal);
        supportsRange = probe.supportsRange;
        if (probe.totalBytes) {
          totalBytes = probe.totalBytes;
          await updateQueue(id, { totalBytes });
        }
        if (!resolvedMimeType && probe.mimeType) {
          resolvedMimeType = probe.mimeType;
        }
      } else {
        supportsRange = true;
      }

      const useChunking = supportsRange && totalBytes && totalBytes > LARGE_FILE_THRESHOLD;
      let uint8;
      let responseMimeType = null;

      if (useChunking) {
        uint8 = await downloadInChunks(id, downloadUrl, byteOffset, totalBytes, abortController.signal);
      } else {
        const result = await downloadFull(id, downloadUrl, abortController.signal);
        uint8            = result.uint8;
        responseMimeType = result.mimeType;
      }

      // uint8.buffer gives us the underlying ArrayBuffer
      const mimeType    = resolvedMimeType ?? responseMimeType ?? 'application/octet-stream';
      const data        = uint8.buffer;
      const completedAt = Date.now();
      const expiresAt   = computeExpiresAt(completedAt, ttl);

      await updateQueue(id, {
        status:          DOWNLOAD_STATUS.COMPLETE,
        data,
        mimeType,
        bytesDownloaded: data.byteLength,
        byteOffset:      data.byteLength,
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

/** Downloads the full file in a single GET request. Returns { uint8, mimeType }. */
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

  return { uint8: mergeChunks(chunks), mimeType };
}

/** Downloads a file in sequential Range request chunks. Returns a Uint8Array. */
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

// ─── Queue drain ──────────────────────────────────────────────────────────────

/**
 * Runs one drain cycle: evaluates TTL expiry, reads the queue, and downloads
 * all eligible entries up to `concurrency` in parallel.
 *
 * Returns when all eligible entries have been processed (completed, failed,
 * or deferred). Does not loop — startDownloads() calls this repeatedly.
 */
async function drainQueue(concurrency) {
  await evaluateExpiry();

  const [allRegistry, allQueue] = await Promise.all([
    dbGetAll(STORES.REGISTRY),
    dbGetAll(STORES.DOWNLOAD_QUEUE),
  ]);

  const registryMap = new Map(allRegistry.map((r) => [r.id, r]));

  const eligible = allQueue
    .filter((q) => [
      DOWNLOAD_STATUS.PENDING,
      DOWNLOAD_STATUS.IN_PROGRESS,
      DOWNLOAD_STATUS.PAUSED,
      DOWNLOAD_STATUS.DEFERRED,
      DOWNLOAD_STATUS.EXPIRED,
    ].includes(q.status))
    .sort((a, b) => (registryMap.get(a.id)?.priority ?? 10) - (registryMap.get(b.id)?.priority ?? 10));

  if (eligible.length === 0) return;

  const queue    = [...eligible];
  const inFlight = new Set();

  await new Promise((resolve) => {
    function runNext() {
      if (!_loopRunning)          { resolve(); return; }
      if (queue.length === 0)     { if (inFlight.size === 0) resolve(); return; }
      if (inFlight.size >= concurrency) return;

      const queueEntry    = queue.shift();
      const registryEntry = registryMap.get(queueEntry.id);
      if (!registryEntry) { runNext(); return; }

      const p = (async () => {
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
      runNext(); // fill remaining concurrency slots immediately
    }

    runNext();
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Starts the persistent download loop.
 *
 * The loop drains the queue, then waits for new work without polling.
 * It wakes automatically when:
 *   - registerFile() / registerFiles() adds a new or updated entry
 *   - The browser comes back online after an offline period
 *   - retryFailed() is called
 *
 * Idempotent — subsequent calls while already running are a no-op.
 *
 * @param {object} [options]
 * @param {number} [options.concurrency=2] — max parallel downloads
 */
export function startDownloads({ concurrency = DEFAULT_CONCURRENCY } = {}) {
  if (_loopRunning) return;
  _loopRunning = true;

  (async () => {
    while (_loopRunning) {
      if (!isOnline()) {
        // Offline — pause anything in-progress and wait for the online event
        const allQueue = await dbGetAll(STORES.DOWNLOAD_QUEUE);
        for (const entry of allQueue) {
          if (entry.status === DOWNLOAD_STATUS.IN_PROGRESS) {
            _activeDownloads.get(entry.id)?.abort();
            _activeDownloads.delete(entry.id);
            await updateQueue(entry.id, {
              status:         DOWNLOAD_STATUS.PAUSED,
              deferredReason: 'network-offline',
            });
          }
        }
        emit('connectivity', { online: false });
        await _wakeSignal();
        continue;
      }

      await drainQueue(concurrency);

      // Queue is empty — wait for new work before looping again
      if (_loopRunning) await _wakeSignal();
    }
  })();
}

/**
 * Stops the download loop gracefully.
 *
 * In-flight downloads are aborted and set to 'paused'. They will resume
 * automatically when startDownloads() is called again.
 */
export async function stopDownloads() {
  _loopRunning = false;
  _notifyNewWork(); // unblock the loop if it's waiting on _wakeSignal
  await abortAllDownloads();
  emit('stopped', {});
}

/**
 * Re-queues all failed entries and wakes the loop to retry them.
 * Only meaningful when the loop is running via startDownloads().
 */
export async function retryFailed() {
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
  _notifyNewWork();
}

/**
 * Returns true if the download loop is currently running.
 * @returns {boolean}
 */
export function isDownloading() {
  return _loopRunning;
}

/**
 * Aborts a single active download, setting it to 'paused'.
 * The loop will pick it up again on the next drain cycle.
 * @param {string} id
 */
export async function abortDownload(id) {
  _activeDownloads.get(id)?.abort();
  _activeDownloads.delete(id);
}

/**
 * Aborts all active downloads, setting them to 'paused'.
 */
export async function abortAllDownloads() {
  for (const [id, ctrl] of _activeDownloads) {
    ctrl.abort();
    _activeDownloads.delete(id);
  }
}

/**
 * Starts monitoring online/offline connectivity.
 *
 * Going offline: aborts active downloads immediately (pauses them).
 * Coming back online: wakes the download loop to resume.
 *
 * Idempotent — safe to call multiple times.
 * Emits 'connectivity' events: { online: boolean }.
 */
export function startMonitoring() {
  startConnectivityMonitor({
    pauseAll:  abortAllDownloads,
    resumeAll: _notifyNewWork,
  });
}

export { stopConnectivityMonitor as stopMonitoring } from './connectivity.js';
export { isOnline, isMonitoring }                    from './connectivity.js';