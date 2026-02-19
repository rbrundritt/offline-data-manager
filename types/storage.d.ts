/**
 * storage.js
 * Storage quota estimation utilities.
 */
/**
 * Returns current storage usage and quota from the browser Storage API.
 * @returns {Promise<{ usage: number, quota: number, available: number }>}
 */
export function getStorageEstimate(): Promise<{
    usage: number;
    quota: number;
    available: number;
}>;
/**
 * Returns true if there is sufficient available storage for the given byte count.
 * Reserves 10% of total quota as a safety buffer.
 *
 * @param {number} requiredBytes
 * @returns {Promise<boolean>}
 */
export function hasEnoughSpace(requiredBytes: number): Promise<boolean>;
/**
 * Requests persistent storage from the browser.
 * Persistent storage is less likely to be evicted under storage pressure.
 * @returns {Promise<boolean>}
 */
export function requestPersistentStorage(): Promise<boolean>;
/**
 * Returns true if persistent storage is already granted.
 * @returns {Promise<boolean>}
 */
export function isPersistentStorage(): Promise<boolean>;
/**
 * Formats a byte count as a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes: number): string;
