/**
 * index.js
 * Public API for offline-data-manager.
 *
 * The library handles the full download lifecycle: registration, queuing,
 * chunked Range downloads, parallel execution, retry with exponential backoff,
 * TTL-based expiry, storage quota awareness, and resume after page/SW close.
 *
 * All file data is stored as typed Blobs. The library has no knowledge of file
 * contents — parsing, decompression, and interpretation are the caller's concern.
 *
 * ─── Quick start ─────────────────────────────────────────────────────────────
 *
 *   import OfflineDataManager from './src/index.js';
 *
 *   // Register files — mimeType is optional; inferred from Content-Type if omitted
 *   await OfflineDataManager.registerFiles([
 *     {
 *       id:          'base-map',
 *       downloadUrl: 'https://example.com/map.pmtiles',
 *       mimeType:    'application/vnd.pmtiles',  // explicit
 *       version:     1,
 *       protected:   true,
 *       priority:    1,
 *       ttl:         86400,   // re-download after 24 hours
 *     },
 *     {
 *       id:          'poi-data',
 *       downloadUrl: 'https://example.com/poi.json',
 *       // mimeType omitted — will be inferred from Content-Type response header
 *       version:     2,
 *       protected:   false,
 *       priority:    5,
 *       ttl:         3600,    // re-download after 1 hour
 *     },
 *   ]);
 *
 *   // Subscribe to events
 *   OfflineDataManager.on('progress',     ({ id, percent }) => console.log(`${id}: ${percent}%`));
 *   OfflineDataManager.on('complete',     ({ id, mimeType }) => console.log(`${id} ready (${mimeType})`));
 *   OfflineDataManager.on('expired',      ({ id }) => console.log(`${id} TTL elapsed, refreshing`));
 *   OfflineDataManager.on('error',        ({ id, error, willRetry }) => { ... });
 *   OfflineDataManager.on('connectivity', ({ online }) => console.log(online ? 'back online' : 'offline'));
 *
 *   // Start connectivity monitoring — pauses on offline, auto-resumes on reconnect
 *   OfflineDataManager.startMonitoring();
 *
 *   // Download (retryFailed: true re-queues any previously failed entries)
 *   await OfflineDataManager.downloadFiles({ concurrency: 2, retryFailed: true });
 *
 *   // Retrieve as Blob — interpret however you like
 *   const blob      = await OfflineDataManager.retrieve('poi-data');
 *   const text      = await blob.text();
 *   const json      = JSON.parse(text);
 *
 *   const mapBlob   = await OfflineDataManager.retrieve('base-map');
 *   const mapBuffer = await mapBlob.arrayBuffer();
 *   // → pass to PMTiles, pass to a map library, create an object URL, etc.
 *
 *   // View overall state
 *   const { items, storage } = await OfflineDataManager.view();
 *
 *   // Check readiness (true for both 'complete' and 'expired')
 *   const ready = await OfflineDataManager.isReady('poi-data');
 *
 *   // Detailed status for one file
 *   const status = await OfflineDataManager.getStatus('poi-data');
 *
 *   // Delete — protected entries keep their registry and re-download next run
 *   await OfflineDataManager.delete('poi-data');
 *   await OfflineDataManager.delete('base-map', { removeRegistry: true }); // force
 *   await OfflineDataManager.deleteAll();
 *
 *   // In a service worker — resume interrupted downloads on activation
 *   self.addEventListener('activate', (event) => {
 *     event.waitUntil(OfflineDataManager.resumeInterruptedDownloads());
 *   });
 *
 * ─── Registry entry shape ────────────────────────────────────────────────────
 *
 *   {
 *     id:          string        — required, unique
 *     downloadUrl: string        — required
 *     mimeType:    string|null   — optional; inferred from Content-Type if omitted
 *     version:     number        — required, non-negative integer
 *     protected:   boolean       — default false
 *     priority:    number        — default 10, lower = higher priority
 *     ttl:         number        — seconds; 0 or omitted = never expires
 *     totalBytes:  number|null   — optional size hint
 *     metadata:    object        — arbitrary caller key/values
 *   }
 *
 * ─── Download status values ───────────────────────────────────────────────────
 *
 *   pending     — queued, not yet started
 *   in-progress — actively downloading
 *   paused      — aborted mid-flight; resumes on next downloadFiles()
 *   complete    — blob stored and fresh
 *   expired     — blob stored but TTL elapsed; still accessible, re-download queued
 *   failed      — exhausted all retries; re-queue with retryFailed: true
 *   deferred    — skipped due to insufficient storage; retried next run
 */

import {
  registerFile,
  registerFiles,
  view,
  getStatus,
  isReady,
} from './registry.js';

import {
  downloadFiles,
  abortDownload,
  abortAllDownloads,
  resumeInterruptedDownloads,
  startMonitoring,
  stopMonitoring,
  isOnline,
  isMonitoring,
} from './downloader.js';

import { deleteFile, deleteAllFiles } from './deleter.js';
import { on, off, once, emit }        from './events.js';
import {
  getStorageEstimate,
  requestPersistentStorage,
  isPersistentStorage,
} from './storage.js';

import { setDBInfo, dbGet, STORES } from './db.js';
import { READY_STATUSES } from './registry.js';

/**
 * Retrieves the stored Blob for a registered file.
 * Returns the Blob as-is — the caller is responsible for interpreting its contents.
 *
 * Returns the blob even if the file is expired; expiry only means a refresh is
 * queued, not that the data is gone.
 *
 * @param {string} id
 * @returns {Promise<Blob>}
 * @throws {Error} if the file is not registered or has no blob yet
 */
async function retrieve(id) {
  const [reg, queue] = await Promise.all([
    dbGet(STORES.REGISTRY, id),
    dbGet(STORES.DOWNLOAD_QUEUE, id),
  ]);

  if (!reg) {
    throw new Error(`retrieve: No registered file with id "${id}".`);
  }

  if (!READY_STATUSES.has(queue?.status) || !queue?.blob) {
    throw new Error(
      `retrieve: File "${id}" has no data yet (status: ${queue?.status ?? 'unknown'}).`
    );
  }

  return queue.blob;
}

// ─── Public API object ────────────────────────────────────────────────────────

const OfflineDataManager = {
  // ── DB ──────────────────────────────────────────────────────────────────────

  /** Overrides the default DB name and version number.  */
  setDBInfo,

  // ── Registry ────────────────────────────────────────────────────────────────

  /** Registers a single file. No-op if version hasn't strictly increased. */
  registerFile,

  /**
   * Registers an array of files. Removes non-protected entries absent from the list.
   * @returns {Promise<{ registered: string[], removed: string[] }>}
   */
  registerFiles,

  // ── Download ─────────────────────────────────────────────────────────────────

  /**
   * Downloads all pending / paused / deferred / expired files.
   * Evaluates TTL expiry first, then downloads priority-ordered, storage-aware.
   * Returns immediately if the browser is offline (downloads resume automatically
   * when connectivity is restored if startMonitoring() has been called).
   * @param {{ concurrency?: number, resumeOnly?: boolean, retryFailed?: boolean }} [options]
   */
  downloadFiles,

  /** Aborts a single active download (sets status to 'paused'). */
  abortDownload,

  /** Aborts all active downloads. */
  abortAllDownloads,

  /**
   * Resumes downloads interrupted by a previous page or SW close.
   * Call inside a service worker 'activate' event.
   */
  resumeInterruptedDownloads,

  /**
   * Starts monitoring window online/offline events.
   * Going offline pauses all active downloads immediately.
   * Coming back online automatically calls downloadFiles() with the same
   * options as the most recent explicit call.
   * Idempotent — safe to call multiple times.
   * Emits 'connectivity' events: { online: boolean }
   */
  startMonitoring,

  /**
   * Stops online/offline monitoring and removes event listeners.
   */
  stopMonitoring,

  /**
   * Returns true if the browser believes it has a network connection.
   * Note: true does not guarantee the download servers are reachable.
   * @returns {boolean}
   */
  isOnline,

  /**
   * Returns true if connectivity monitoring is currently active.
   * @returns {boolean}
   */
  isMonitoring,

  // ── Retrieve ─────────────────────────────────────────────────────────────────

  /**
   * Returns the stored Blob for a completed or expired file.
   * Blob.type reflects the mimeType set at registration.
   * @param {string} id
   * @returns {Promise<Blob>}
   */
  retrieve,

  // ── Status & view ─────────────────────────────────────────────────────────────

  /**
   * Returns all registry entries merged with download state, plus storage summary.
   * @returns {Promise<{ items: object[], storage: object }>}
   */
  view,

  /**
   * Returns the full status object for a single file, or null if not registered.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  getStatus,

  /**
   * Returns true if the file has a blob available (status: complete or expired).
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  isReady,

  // ── Delete ───────────────────────────────────────────────────────────────────

  /**
   * Deletes a file's blob.
   * Protected entries: blob cleared, queue reset to pending, registry survives.
   * Non-protected entries: fully removed including registry.
   * @param {string} id
   * @param {{ removeRegistry?: boolean }} [options]
   */
  delete: deleteFile,

  /**
   * Deletes all files following the same protected/non-protected rules.
   * @param {{ removeRegistry?: boolean }} [options]
   */
  deleteAll: deleteAllFiles,

  // ── Events ───────────────────────────────────────────────────────────────────

  /**
   * Subscribe to a lifecycle event. Returns an unsubscribe function.
   * Events: 'progress' | 'complete' | 'error' | 'deferred' | 'expired' |
   *         'registered' | 'deleted' | 'status'
   */
  on,
  off,
  once,

  // ── Storage ──────────────────────────────────────────────────────────────────

  /** Returns { usage, quota, available } in bytes from the browser Storage API. */
  getStorageEstimate,

  /** Requests persistent storage (less likely to be evicted by the browser). */
  requestPersistentStorage,

  /** Returns true if persistent storage is already granted. */
  isPersistentStorage,

};

export default OfflineDataManager;

// Named exports for tree-shaking
export {
  registerFile,
  registerFiles,
  downloadFiles,
  abortDownload,
  abortAllDownloads,
  resumeInterruptedDownloads,
  startMonitoring,
  stopMonitoring,
  isOnline,
  isMonitoring,
  retrieve,
  view,
  getStatus,
  isReady,
  deleteFile,
  deleteAllFiles,
  on,
  off,
  once,
  emit,
  getStorageEstimate,
  requestPersistentStorage,
  isPersistentStorage,
};