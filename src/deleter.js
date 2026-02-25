/**
 * deleter.js
 * Handles deletion of downloaded array buffer and optionally registry entries.
 *
 * Deletion rules:
 *
 *   Protected entries (protected: true)
 *     ArrayBuffer is cleared and queue is reset to 'pending' so the file re-downloads
 *     on the next downloadFiles() call. Registry entry survives.
 *     Pass { removeProtected: true } to override and fully remove.
 *
 *   Non-protected entries (protected: false)
 *     BlArrayBufferob, queue entry, and registry entry are all removed.
 *
 *   In-progress downloads are aborted before deletion.
 */

import { dbGet, dbGetAllIds, dbDelete, dbPut, STORES } from './db.js';
import { DOWNLOAD_STATUS } from './registry.js';
import { abortDownload, abortAllDownloads } from './downloader.js';
import { emit } from './events.js';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Resets a queue entry to pending, clearing the array buffer and all progress state.
 * Used for protected entries where the registry survives.
 * @param {string} id
 */
async function resetQueueEntry(id) {
  const existing = await dbGet(STORES.DOWNLOAD_QUEUE, id);
  if (!existing) return;
  await dbPut(STORES.DOWNLOAD_QUEUE, {
    ...existing,
    status:          DOWNLOAD_STATUS.PENDING,
    data:            null,
    bytesDownloaded: 0,
    byteOffset:      0,
    retryCount:      0,
    errorMessage:    null,
    deferredReason:  null,
    completedAt:     null,
    expiresAt:       null,
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Deletes a single file's array buffer and optionally its registry entry.
 *
 * @param {string} id
 * @param {object}  [options]
 * @param {boolean} [options.removeProtected=false] — force registry removal for protected entries
 * @returns {Promise<{ id: string, registryRemoved: boolean }>}
 */
export async function deleteFile(id, { removeProtected = false } = {}) {
  const registryEntry = await dbGet(STORES.REGISTRY, id);
  if (!registryEntry) throw new Error(`deleteFile: No registered file with id "${id}".`);

  await abortDownload(id);

  const shouldRemoveRegistry = removeProtected || !registryEntry.protected;

  if (shouldRemoveRegistry) {
    await dbDelete(STORES.REGISTRY, id);
    await dbDelete(STORES.DOWNLOAD_QUEUE, id);
  } else {
    // Protected — wipe array buffer and reset queue; registry stays, re-downloads next run
    await resetQueueEntry(id);
  }

  emit('deleted', { id, registryRemoved: shouldRemoveRegistry });
  return { id, registryRemoved: shouldRemoveRegistry };
}

/**
 * Deletes all files. Protected entries follow the same rules as deleteFile().
 *
 * @param {object}  [options]
 * @param {boolean} [options.removeProtected=false]
 * @returns {Promise<Array<{ id: string, registryRemoved: boolean }>>}
 */
export async function deleteAllFiles({ removeProtected = false } = {}) {
  await abortAllDownloads();
  const allRegistryIds = await dbGetAllIds(STORES.REGISTRY);
  return Promise.all(allRegistryIds.map((id) => deleteFile(id, { removeProtected })));
}