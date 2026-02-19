/**
 * storage.js
 * Storage quota estimation utilities.
 */

/**
 * Returns current storage usage and quota from the browser Storage API.
 * @returns {Promise<{ usage: number, quota: number, available: number }>}
 */
export async function getStorageEstimate() {
  if (!navigator?.storage?.estimate) {
    return { usage: 0, quota: Infinity, available: Infinity };
  }
  const { usage = 0, quota = Infinity } = await navigator.storage.estimate();
  return { usage, quota, available: quota - usage };
}

/**
 * Returns true if there is sufficient available storage for the given byte count.
 * Reserves 10% of total quota as a safety buffer.
 *
 * @param {number} requiredBytes
 * @returns {Promise<boolean>}
 */
export async function hasEnoughSpace(requiredBytes) {
  const { available, quota } = await getStorageEstimate();
  return available - (quota * 0.1) >= requiredBytes;
}

/**
 * Requests persistent storage from the browser.
 * Persistent storage is less likely to be evicted under storage pressure.
 * @returns {Promise<boolean>}
 */
export async function requestPersistentStorage() {
  if (!navigator?.storage?.persist) return false;
  return navigator.storage.persist();
}

/**
 * Returns true if persistent storage is already granted.
 * @returns {Promise<boolean>}
 */
export async function isPersistentStorage() {
  if (!navigator?.storage?.persisted) return false;
  return navigator.storage.persisted();
}

/**
 * Formats a byte count as a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === Infinity) return '∞';
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024 ** 2)  return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}