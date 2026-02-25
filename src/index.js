/**
 * index.js
 * Public API for offline-data-manager.
 *
 * The library handles the full download lifecycle: registration, queuing,
 * chunked Range downloads, parallel execution, retry with exponential backoff,
 * TTL-based expiry, storage quota awareness, and resume after page/SW close.
 *
 * All file data is stored as array buffers. The library has no knowledge of file
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
 *   // Start the persistent download loop — call once at app startup
 *   OfflineDataManager.startMonitoring();
 *   OfflineDataManager.startDownloads({ concurrency: 2 });
 *
 *   // Register files at any time — already-running loop picks them up immediately
 *   await OfflineDataManager.registerFile({ id: 'new-file', downloadUrl: '...', version: 1 });
 *
 *   // Retry any failed entries
 *   await OfflineDataManager.retryFailed();
 *
 *   // Stop the loop (pauses in-flight downloads)
 *   await OfflineDataManager.stopDownloads();
 *
 *   // Retrieve as file data — interpret however you like
 *   const fileInfo      = await OfflineDataManager.retrieve('poi-data');
 *   const decoder = new TextDecoder("utf-8");
 *   const text = decoder.decode(myFile.data);
 * 
 *   const json = JSON.parse(text);
 *
 *   // View overall state
 *   const { items, storage } = await OfflineDataManager.getAllStatus();
 *
 *   // Check readiness (true for both 'complete' and 'expired')
 *   const ready = await OfflineDataManager.isReady('poi-data');
 *
 *   // Detailed status for one file
 *   const status = await OfflineDataManager.getStatus('poi-data');
 *
 *   // Delete — protected entries keep their registry and re-download next run
 *   await OfflineDataManager.delete('poi-data');
 *   await OfflineDataManager.delete('base-map', { removeProtected: true }); // force
 *   await OfflineDataManager.deleteAll();
 *
 *   // In a service worker — resume interrupted downloads on activation
 *   self.addEventListener('activate', (event) => {
 *     event.waitUntil(OfflineDataManager.startDownloads());
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
 *   paused      — aborted mid-flight; loop resumes it on next drain cycle
 *   complete    — array buffer stored and fresh
 *   expired     — array buffer stored but TTL elapsed; still accessible, re-download queued
 *   failed      — exhausted all retries; call retryFailed() to re-queue
 *   deferred    — skipped due to insufficient storage; retried next drain cycle
 */

import {
  registerFile,
  registerFiles,
  getAllStatus,
  getStatus,
  isReady,
} from './registry.js';

import {
  startDownloads,
  stopDownloads,
  retryFailed,
  isDownloading,
  abortDownload,
  abortAllDownloads,
  startMonitoring,
  stopMonitoring,
  isOnline,
  isMonitoring,
} from './downloader.js';

import { deleteFile, deleteAllFiles } from './deleter.js';
import { on, off, once, emit } from './events.js';
import {
  getStorageEstimate,
  requestPersistentStorage,
  isPersistentStorage,
} from './storage.js';

import { setDBInfo, dbGet, dbGetAllIds, STORES } from './db.js';
import { READY_STATUSES } from './registry.js';

/**
 * Retrieves the stored file data for a registered file.
 * Returns the array buffer and content type.
 *
 * Returns the data even if the file is expired; expiry only means a refresh is
 * queued, not that the data is gone.
 *
 * @param {string} id
 * @returns {Promise<{ data: ArrayBuffer, mimeType: string }>}
 * @throws {Error} if the file is not registered or has no data yet
 */
async function retrieve(id) {
  const [reg, queue] = await Promise.all([
    dbGet(STORES.REGISTRY, id),
    dbGet(STORES.DOWNLOAD_QUEUE, id),
  ]);

  if (!reg) {
    throw new Error(`retrieve: No registered file with id "${id}".`);
  }

  if (!READY_STATUSES.has(queue?.status) || !queue?.data) {
    throw new Error(
      `retrieve: File "${id}" has no data yet (status: ${queue?.status ?? 'unknown'}).`
    );
  }

  return { data: queue.data, mimeType: queue.mimeType };
}

// ─── Public API object ────────────────────────────────────────────────────────

const OfflineDataManager = {
  // ── DB ──────────────────────────────────────────────────────────────────────

  /**
   * Overrides the default DB name and version number. 
   * @param {string|undefined} dbName Optional DB name. Default: 'offline-data-manager'
   * @param {number|undefined} dbVersion Optional DB version. Default: 1
   */
  setDBInfo,

  /**
   * Get all record ids from a store.
   * @param {string} storeName
   * @returns {Promise<string[]>}
   */
  dbGetAllIds,

  // ── Registry ────────────────────────────────────────────────────────────────

  /**
   * Registers a single file entry.
   *
   * - New entry: added to registry, fresh pending queue entry created.
   * - Existing, version increased: registry updated, queue reset to pending.
   *   Existing array buffer remains accessible until the new download completes.
   * - Existing, version unchanged or lower: no-op.
   *
   * @param {object} entry
   * @returns {Promise<void>}
   */
  registerFile,

  /**
   * Registers an array of file entries and removes any registry entries
   * whose IDs are no longer present in the incoming array.
   *
   * Protected entries missing from the new list are left untouched.
   * Non-protected entries missing from the new list are fully removed.
   *
   * @param {object[]} entries
   * @returns {Promise<{ registered: string[], removed: string[] }>}
   */
  registerFiles,

  // ── Download ─────────────────────────────────────────────────────────────────

  /**
   * Starts the persistent download loop.
   *
   * Drains all actionable queue entries, then waits for new work without
   * polling. Wakes automatically when registerFile() adds a new entry, when
   * the browser comes back online, or when retryFailed() is called.
   *
   * Idempotent — safe to call multiple times; subsequent calls while already
   * running are a no-op.
   *
   * @param {object} [options]
   * @param {number} [options.concurrency=2] — max parallel downloads
   */
  startDownloads,

  /**
   * Stops the download loop gracefully.
   * In-flight downloads are aborted and set to 'paused'. Call startDownloads()
   * again to resume.
   */
  stopDownloads,

  /**
   * Re-queues all failed entries and wakes the loop to retry them.
   */
  retryFailed,

  /**
   * Returns true if the download loop is currently running.
   * @returns {boolean}
   */
  isDownloading,

  /**
   * Aborts a single active download, setting it to 'paused'.
   * The loop will pick it up again automatically on the next drain cycle.
   * @param {string} id
   */
  abortDownload,

  /**
   * Aborts all active downloads, setting them to 'paused'.
   */
  abortAllDownloads,

  /**
   * Starts monitoring online/offline connectivity.
   *
   * - Going offline: all active downloads are paused immediately.
   * - Coming back online: the download loop resumes automatically (via startMonitoring())
   *   same options as the most recent explicit call.
   *
   * Idempotent — safe to call multiple times. Call stopConnectivityMonitor()
   * to remove the listeners (useful in tests or cleanup).
   */
  startMonitoring,

  /**
   * Stops monitoring and removes event listeners.
   * After calling this, online/offline events will no longer trigger pause/resume.
   */
  stopMonitoring,

  /**
   * Returns the current online status from navigator.onLine.
   * Note: true does not guarantee the download servers are reachable,
   * only that the browser believes it has a network connection.
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
   * Returns the stored file data for a completed or expired file.
   * @param {string} id
   * @returns {Promise<{ data: ArrayBuffer, mimeType: string }>}
   */
  retrieve,

  // ── Status & view ─────────────────────────────────────────────────────────────

  /**
   * Returns all registry entries merged with download state, plus storage summary.
   * @returns {Promise<{ items: object[], storage: object }>}
   */
  getAllStatus,

  /**
   * Returns the full status object for a single file, or null if not registered.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  getStatus,

  /**
   * Returns true if the file has data available (status: complete or expired).
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  isReady,

  // ── Delete ───────────────────────────────────────────────────────────────────

  /**
   * Deletes a file's data.
   * Protected entries: data cleared, queue reset to pending, registry survives.
   * Non-protected entries: fully removed including registry.
   * @param {string} id
   * @param {{ removeProtected?: boolean }} [options]
   */
  delete: deleteFile,

  /**
   * Deletes all files following the same protected/non-protected rules.
   * @param {{ removeProtected?: boolean }} [options]
   */
  deleteAll: deleteAllFiles,

  // ── Events ───────────────────────────────────────────────────────────────────

  /**
  * Subscribe to an event. Returns an unsubscribe function.
  * Events: 'progress' | 'complete' | 'error' | 'deferred' | 'expired' |
  *         'registered' | 'deleted' | 'status'
  * @param {string} event
  * @param {Function} listener
  * @returns {Function}
  */
  on,

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} listener
   */
  off,

  /**
   * Emit an event to all registered listeners.
   * @param {string} event
   * @param {object} data
   */
  once,

  // ── Storage ──────────────────────────────────────────────────────────────────

  /**
   * Returns current storage usage and quota from the browser Storage API.
   * @returns {Promise<{ usage: number, quota: number, available: number }>}
   */
  getStorageEstimate,

  /**
   * Requests persistent storage from the browser.
   * Persistent storage is less likely to be evicted under storage pressure.
   * @returns {Promise<boolean>}
   */
  requestPersistentStorage,

  /**
   * Returns true if persistent storage is already granted.
   * @returns {Promise<boolean>}
   */
  isPersistentStorage,
};

export default OfflineDataManager;

// Named exports for tree-shaking
export {
  registerFile,
  registerFiles,
  startDownloads,
  stopDownloads,
  retryFailed,
  isDownloading,
  abortDownload,
  abortAllDownloads,
  startMonitoring,
  stopMonitoring,
  isOnline,
  isMonitoring,
  retrieve,
  getAllStatus,
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