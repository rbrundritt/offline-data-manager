/**
 * db.js
 * IndexedDB setup and store management.
 *
 * Stores:
 *   registry      — one record per registered file
 *   downloadQueue — one record per file tracking download state and stored array buffer
 *
 * All file data is stored as an ArrayBuffer directly on the downloadQueue record.
 * There is no separate data store — the download manager is purely a
 * fetch-and-store layer with no knowledge of file contents.
 */

let DB_NAME = 'offline-data-manager';
let DB_VERSION = 1;

let _db = null;

/**
 * List of all the data stores in the DB.
 */
export const STORES = {
  REGISTRY:       'registry',
  DOWNLOAD_QUEUE: 'downloadQueue',
};

/**
 * Overrides the default DB name and version number. 
 * @param {string|undefined} dbName Optional DB name. Default: 'offline-data-manager'
 * @param {number|undefined} dbVersion Optional DB version. Default: 1
 */
export async function setDBInfo(dbName, dbVersion) {
  DB_NAME = dbName ?? 'offline-data-manager';
  DB_VERSION = dbVersion ?? 1;
}

/**
 * Opens (or returns the cached) database connection.
 * @returns {Promise<IDBDatabase>}
 */
export async function openDB() {
  if (_db) return _db;

  _db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORES.REGISTRY)) {
        const registryStore = db.createObjectStore(STORES.REGISTRY, { keyPath: 'id' });
        registryStore.createIndex('protected', 'protected', { unique: false });
        registryStore.createIndex('priority',  'priority',  { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.DOWNLOAD_QUEUE)) {
        const queueStore = db.createObjectStore(STORES.DOWNLOAD_QUEUE, { keyPath: 'id' });
        queueStore.createIndex('status',   'status',   { unique: false });
        queueStore.createIndex('priority', 'priority', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror  = () => reject(request.error);
  });

  return _db;
}

/**
 * Get a single record by key.
 * @param {string} storeName
 * @param {string} key
 * @returns {Promise<any|undefined>}
 */
export async function dbGet(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
}

/**
 * Get all records from a store.
 * @param {string} storeName
 * @returns {Promise<any[]>}
 */
export async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
}

/**
 * Get all record ids from a store.
 * @param {string} storeName
 * @returns {Promise<string[]>}
 */
export async function dbGetAllIds(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
}

/**
 * Put (insert or replace) a record.
 * @param {string} storeName
 * @param {object} record
 * @returns {Promise<void>}
 */
export async function dbPut(storeName, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readwrite').objectStore(storeName).put(record);
    req.onsuccess = () => resolve();
    req.onerror  = () => reject(req.error);
  });
}

/**
 * Delete a record by key.
 * @param {string} storeName
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function dbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror  = () => reject(req.error);
  });
}