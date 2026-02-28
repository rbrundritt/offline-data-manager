/**
 * registry.js
 * Manages the file registry and download queue state.
 *
 * Registry entry shape:
 * {
 *   id:           string        — unique identifier
 *   downloadUrl:  string        — URL to fetch
 *   mimeType:     string|null   — MIME type for the stored ArrayBuffer; null means infer from
 *                                 Content-Type response header at download time
 *   version:      number        — incrementing integer; re-download when strictly increased
 *   protected:    boolean  — if true, registry entry survives deletion and data is
 *                            re-downloaded on the next drain cycle
 *   priority:     number   — lower = higher priority (default: 10)
 *   ttl:          number   — time-to-live in seconds; 0 or omitted means never expires
 *   totalBytes:   number|null — optional size hint for storage checks and progress display
 *   metadata:     object   — arbitrary caller-supplied key/value pairs (labels, descriptions, etc.)
 *   registeredAt: number   — timestamp (ms)
 *   updatedAt:    number   — timestamp of last metadata update (ms)
 *   // Mirrored status fields (kept in sync with downloadQueue by syncStatusToRegistry)
 *   status:          string|null
 *   bytesDownloaded: number
 *   retryCount:      number
 *   lastAttemptAt:   number|null
 *   errorMessage:    string|null
 *   deferredReason:  string|null
 *   completedAt:     number|null
 *   expiresAt:       number|null
 * }
 *
 * Download queue entry shape:
 * {
 *   id:              string         — matches registry id
 *   status:          string         — see DOWNLOAD_STATUS below
 *   data:            ArrayBuffer|null — stored file data; null until download completes
 *   bytesDownloaded: number
 *   totalBytes:      number|null
 *   byteOffset:      number         — for Range request resume
 *   retryCount:      number
 *   lastAttemptAt:   number|null    — timestamp (ms)
 *   errorMessage:    string|null
 *   deferredReason:  string|null
 *   completedAt:     number|null    — timestamp (ms); used for TTL expiry calculation
 *   expiresAt:       number|null    — timestamp (ms); set from completedAt + ttl on completion
 * }
 *
 * Status values:
 *   pending     — waiting to be downloaded
 *   in-progress — actively downloading
 *   paused      — aborted mid-download; loop resumes on next drain cycle
 *   complete    — fully downloaded; array buffer data is available
 *   expired     — download was complete but TTL has elapsed; array buffer data still available
 *                 and is replaced (not removed) when the new download completes
 *   failed      — download exhausted all retries
 *   deferred    — skipped due to insufficient storage; re-evaluated next run
 */

import { dbGet, dbGetAll, dbPut, dbDelete, STORES } from './db.js';
import { emit } from './events.js';
import { getStorageEstimate, formatBytes } from './storage.js';
import { _notifyNewWork } from './downloader.js';

export const DOWNLOAD_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in-progress',
  PAUSED: 'paused',
  COMPLETE: 'complete',
  EXPIRED: 'expired',
  FAILED: 'failed',
  DEFERRED: 'deferred',
};

// Statuses where the array buffer data is present and accessible
export const READY_STATUSES = new Set([
  DOWNLOAD_STATUS.COMPLETE,
  DOWNLOAD_STATUS.EXPIRED,
]);

// ─── Validation ───────────────────────────────────────────────────────────────

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Registry entry must be an object.');
  }
  if (!entry.id || typeof entry.id !== 'string') {
    throw new Error('Registry entry must have a string "id".');
  }
  if (!entry.downloadUrl || typeof entry.downloadUrl !== 'string') {
    throw new Error(`Entry "${entry.id}" must have a string "downloadUrl".`);
  }
  if (entry.mimeType !== undefined && entry.mimeType !== null && typeof entry.mimeType !== 'string') {
    throw new Error(`Entry "${entry.id}" mimeType must be a string or omitted.`);
  }
  if (typeof entry.version !== 'number' || !Number.isInteger(entry.version) || entry.version < 0) {
    throw new Error(`Entry "${entry.id}" version must be a non-negative integer.`);
  }
  if (entry.ttl !== undefined && (typeof entry.ttl !== 'number' || entry.ttl < 0)) {
    throw new Error(`Entry "${entry.id}" ttl must be a non-negative number (seconds).`);
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function makeQueueEntry(id) {
  return {
    id,
    status: DOWNLOAD_STATUS.PENDING,
    data: null,
    bytesDownloaded: 0,
    totalBytes: null,
    byteOffset: 0,
    retryCount: 0,
    lastAttemptAt: null,
    errorMessage: null,
    deferredReason: null,
    completedAt: null,
    expiresAt: null,
  };
}

/**
 * Patches status fields onto the registry record so status reads
 * only need to query the registry store, never the download queue.
 * Exported so downloader.js can call it via updateQueue.
 * @param {string} id
 * @param {object} patch
 */
export async function syncStatusToRegistry(id, patch) {
  const reg = await dbGet(STORES.REGISTRY, id);
  if (reg) await dbPut(STORES.REGISTRY, { ...reg, ...patch });
}

/**
 * Computes the expiresAt timestamp from a completedAt time and a ttl (seconds).
 * Returns null if ttl is absent, zero, or falsy (meaning never expires).
 *
 * @param {number} completedAt — ms timestamp
 * @param {number|undefined} ttl — seconds
 * @returns {number|null}
 */
export function computeExpiresAt(completedAt, ttl) {
  if (!ttl) return null;
  return completedAt + ttl * 1000;
}

/**
 * Returns true if an expiresAt timestamp has passed.
 * @param {number|null} expiresAt
 * @returns {boolean}
 */
export function isExpired(expiresAt) {
  if (!expiresAt) return false;
  return Date.now() >= expiresAt;
}

// ─── Public API ───────────────────────────────────────────────────────────────

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
export async function registerFile(entry) {
  try {
    validateEntry(entry);

    const now = Date.now();
    const existing = await dbGet(STORES.REGISTRY, entry.id);
    const existingQueue = await dbGet(STORES.DOWNLOAD_QUEUE, entry.id);

    const registryRecord = {
      id: entry.id,
      downloadUrl: entry.downloadUrl,
      mimeType: entry.mimeType ?? null,
      version: entry.version,
      protected: entry.protected ?? false,
      priority: entry.priority ?? 10,
      ttl: entry.ttl ?? 0,
      totalBytes: entry.totalBytes ?? null,
      metadata: entry.metadata ?? {},
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
      // Status fields — only stamped on new entries; version-bump branch handles its own reset below
      ...(existing ? {} : {
        status: DOWNLOAD_STATUS.PENDING,
        bytesDownloaded: 0,
        retryCount: 0,
        lastAttemptAt: null,
        errorMessage: null,
        deferredReason: null,
        completedAt: null,
        expiresAt: null,
      }),
    };

    if (existing) {
      if (entry.version > existing.version) {
        await dbPut(STORES.REGISTRY, registryRecord);

        // Preserve the existing data array buffer while re-queuing so data stays accessible
        const newQueueEntry = existingQueue
          ? {
            ...existingQueue,
            status: DOWNLOAD_STATUS.PENDING,
            bytesDownloaded: 0,
            byteOffset: 0,
            retryCount: 0,
            errorMessage: null,
            deferredReason: null,
            completedAt: null,
            expiresAt: null,
            // data array buffer intentionally kept so retrieve() still works during re-download
          }
          : makeQueueEntry(entry.id);

        await dbPut(STORES.DOWNLOAD_QUEUE, newQueueEntry);

        // Reset status fields on the registry record for the version bump
        await syncStatusToRegistry(entry.id, {
          status: DOWNLOAD_STATUS.PENDING,
          bytesDownloaded: 0,
          retryCount: 0,
          errorMessage: null,
          deferredReason: null,
          completedAt: null,
          expiresAt: null,
        });

        emit('registered', { id: entry.id, reason: 'version-updated' });
        _notifyNewWork();
      }
      // Version unchanged or lower — no-op
      return;
    }

    // Brand new entry
    await dbPut(STORES.REGISTRY, registryRecord);
    await dbPut(STORES.DOWNLOAD_QUEUE, makeQueueEntry(entry.id));
    emit('registered', { id: entry.id, reason: 'new' });
    _notifyNewWork();
  } catch (err) {
    if (err?.name === 'QuotaExceededError') {
      emit('error', { id: id, reason: 'insufficient-storage', willRetry: false });
      return;
    } else {
      emit('error', { id: id, reason: (err?.message ?? err), willRetry: false });
    }
  }
}

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
export async function registerFiles(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('registerFiles expects an array.');
  }

  const incomingIds = new Set(entries.map((e) => e.id));
  const existingAll = await dbGetAll(STORES.REGISTRY);
  const removed = [];

  for (const existing of existingAll) {
    if (!incomingIds.has(existing.id) && !existing.protected) {
      await dbDelete(STORES.REGISTRY, existing.id);
      await dbDelete(STORES.DOWNLOAD_QUEUE, existing.id);
      removed.push(existing.id);
      emit('deleted', { id: existing.id, registryRemoved: true });
    }
  }

  for (const entry of entries) {
    await registerFile(entry);
  }

  return { registered: entries.map((e) => e.id), removed };
}

/**
 * Updates the metadata in the registry. Adds to, doesn't replace it. Pass in an empty object to clear as null will be ignored.
 * @param {string} id The of the registry record to update.
 * @param {Object} metadata The metadata object to merge.
 * @returns {Promise<void>}
 */
export async function updateRegistryMetadata(id, metadata) {
  try {
    if (id && metadata) {
      const existing = await dbGet(STORES.REGISTRY, entry.id);

      if (existing) {
        existing.metadata = { ...(existing.metadata ?? {}), ...metadata };
        await dbPut(STORES.REGISTRY, existing);
      }
    }
  } catch (err) {
    if (err?.name === 'QuotaExceededError') {
      emit('error', { id: id, reason: 'insufficient-storage', willRetry: false });
      return;
    } else {
      emit('error', { id: id, reason: (err?.message ?? err), willRetry: false });
    }
  }
}

/**
 * Checks all complete queue entries against their TTL and flips any that have
 * expired to `expired` status, queuing them for re-download.
 *
 * Called internally by the download loop before each drain cycle.
 * @returns {Promise<string[]>} IDs of entries that were marked expired
 */
export async function evaluateExpiry() {
  const allQueue = await dbGetAll(STORES.DOWNLOAD_QUEUE);
  const expiredIds = [];

  for (const entry of allQueue) {
    if (entry.status === DOWNLOAD_STATUS.COMPLETE && isExpired(entry.expiresAt)) {
      await dbPut(STORES.DOWNLOAD_QUEUE, {
        ...entry,
        status: DOWNLOAD_STATUS.EXPIRED,
      });
      await syncStatusToRegistry(entry.id, { status: DOWNLOAD_STATUS.EXPIRED });
      expiredIds.push(entry.id);
      emit('expired', { id: entry.id });
    }
  }

  return expiredIds;
}

/**
 * Returns a merged view of all registry entries with their current download
 * state, plus a storage summary. Status fields are read directly from the
 * registry — the download queue is not consulted.
 *
 * @returns {Promise<{ items: object[], storage: object }>}
 */
export async function getAllStatus() {
  const [registryEntries, storageEstimate] = await Promise.all([
    dbGetAll(STORES.REGISTRY),
    getStorageEstimate(),
  ]);

  const items = registryEntries
    .map((reg) => processStatus(reg))
    .sort((a, b) => a.priority - b.priority);

  return {
    items,
    storage: {
      usageBytes: storageEstimate.usage,
      quotaBytes: storageEstimate.quota,
      availableBytes: storageEstimate.available,
      usageFormatted: formatBytes(storageEstimate.usage),
      quotaFormatted: formatBytes(storageEstimate.quota),
      availableFormatted: formatBytes(storageEstimate.available),
    },
  };
}

/**
 * Returns the full merged status object for a single registered file,
 * or null if not registered. Status fields are read directly from the
 * registry — the download queue is not consulted.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getStatus(id) {
  const reg = await dbGet(STORES.REGISTRY, id);
  if (!reg) return null;

  return processStatus(reg);
}

/**
 * Takes a registry entry and processes it to create a status response.
 * @param {*} reg The registry item.
 * @returns The enhanced status information for the registry.
 */
function processStatus(reg) {
  return {
    id: reg.id,
    downloadUrl: reg.downloadUrl,
    mimeType: reg.mimeType ?? null,
    version: reg.version,
    protected: reg.protected,
    priority: reg.priority,
    ttl: reg.ttl,
    totalBytes: reg.totalBytes,
    metadata: reg.metadata,
    registeredAt: reg.registeredAt,
    updatedAt: reg.updatedAt,
    // Mirrored status fields
    downloadStatus: reg.status ?? null,
    bytesDownloaded: reg.bytesDownloaded ?? 0,
    progress: (reg.totalBytes && reg.bytesDownloaded)
      ? Math.round((reg.bytesDownloaded / reg.totalBytes) * 100)
      : null,
    retryCount: reg.retryCount ?? 0,
    lastAttemptAt: reg.lastAttemptAt ?? null,
    errorMessage: reg.errorMessage ?? null,
    deferredReason: reg.deferredReason ?? null,
    completedAt: reg.completedAt ?? null,
    expiresAt: reg.expiresAt ?? null,
  };
}

/**
 * Returns true if a file has data available (complete or expired).
 * An expired file still has a valid array buffer — it is simply due for refresh.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function isReady(id) {
  const reg = await dbGet(STORES.REGISTRY, id);
  if (reg?.status) {
    return READY_STATUSES.has(reg?.status);
  }

  const queue = await dbGet(STORES.DOWNLOAD_QUEUE, id);
  return READY_STATUSES.has(queue?.status);
}