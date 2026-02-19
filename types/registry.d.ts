/**
 * Computes the expiresAt timestamp from a completedAt time and a ttl (seconds).
 * Returns null if ttl is absent, zero, or falsy (meaning never expires).
 *
 * @param {number} completedAt — ms timestamp
 * @param {number|undefined} ttl — seconds
 * @returns {number|null}
 */
export function computeExpiresAt(completedAt: number, ttl: number | undefined): number | null;
/**
 * Returns true if an expiresAt timestamp has passed.
 * @param {number|null} expiresAt
 * @returns {boolean}
 */
export function isExpired(expiresAt: number | null): boolean;
/**
 * Registers a single file entry.
 *
 * - New entry: added to registry, fresh pending queue entry created.
 * - Existing, version increased: registry updated, queue reset to pending.
 *   Existing blob remains accessible until the new download completes.
 * - Existing, version unchanged or lower: no-op.
 *
 * @param {object} entry
 * @returns {Promise<void>}
 */
export function registerFile(entry: object): Promise<void>;
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
export function registerFiles(entries: object[]): Promise<{
    registered: string[];
    removed: string[];
}>;
/**
 * Checks all complete queue entries against their TTL and flips any that have
 * expired to `expired` status, queuing them for re-download.
 *
 * Called internally by downloadFiles() before deciding what to download.
 * @returns {Promise<string[]>} IDs of entries that were marked expired
 */
export function evaluateExpiry(): Promise<string[]>;
/**
 * Returns a merged view of all registry entries with their current download
 * state, plus a storage summary.
 *
 * @returns {Promise<{ items: object[], storage: object }>}
 */
export function view(): Promise<{
    items: object[];
    storage: object;
}>;
/**
 * Returns the full merged status object for a single registered file,
 * or null if not registered.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export function getStatus(id: string): Promise<object | null>;
/**
 * Returns true if a file has data available (complete or expired).
 * An expired file still has a valid blob — it is simply due for refresh.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export function isReady(id: string): Promise<boolean>;
export namespace DOWNLOAD_STATUS {
    let PENDING: string;
    let IN_PROGRESS: string;
    let PAUSED: string;
    let COMPLETE: string;
    let EXPIRED: string;
    let FAILED: string;
    let DEFERRED: string;
}
export const READY_STATUSES: Set<string>;
