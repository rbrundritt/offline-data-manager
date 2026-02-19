/**
 * Opens (or returns the cached) database connection.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB(): Promise<IDBDatabase>;
/**
 * Get a single record by key.
 * @param {string} storeName
 * @param {string} key
 * @returns {Promise<any|undefined>}
 */
export function dbGet(storeName: string, key: string): Promise<any | undefined>;
/**
 * Get all records from a store.
 * @param {string} storeName
 * @returns {Promise<any[]>}
 */
export function dbGetAll(storeName: string): Promise<any[]>;
/**
 * Put (insert or replace) a record.
 * @param {string} storeName
 * @param {object} record
 * @returns {Promise<void>}
 */
export function dbPut(storeName: string, record: object): Promise<void>;
/**
 * Delete a record by key.
 * @param {string} storeName
 * @param {string} key
 * @returns {Promise<void>}
 */
export function dbDelete(storeName: string, key: string): Promise<void>;
export namespace STORES {
    let REGISTRY: string;
    let DOWNLOAD_QUEUE: string;
}
