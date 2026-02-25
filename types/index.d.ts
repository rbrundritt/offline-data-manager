export default OfflineDataManager;
declare namespace OfflineDataManager {
    export { setDBInfo };
    export { dbGetAllIds };
    export { registerFile };
    export { registerFiles };
    export { startDownloads };
    export { stopDownloads };
    export { retryFailed };
    export { isDownloading };
    export { abortDownload };
    export { abortAllDownloads };
    export { startMonitoring };
    export { stopMonitoring };
    export { isOnline };
    export { isMonitoring };
    export { retrieve };
    export { getAllStatus };
    export { getStatus };
    export { isReady };
    export { deleteFile as delete };
    export { deleteAllFiles as deleteAll };
    export { on };
    export { off };
    export { once };
    export { getStorageEstimate };
    export { requestPersistentStorage };
    export { isPersistentStorage };
}
import { registerFile } from './registry.js';
import { registerFiles } from './registry.js';
import { startDownloads } from './downloader.js';
import { stopDownloads } from './downloader.js';
import { retryFailed } from './downloader.js';
import { isDownloading } from './downloader.js';
import { abortDownload } from './downloader.js';
import { abortAllDownloads } from './downloader.js';
import { startMonitoring } from './downloader.js';
import { stopMonitoring } from './downloader.js';
import { isOnline } from './downloader.js';
import { isMonitoring } from './downloader.js';
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
export function retrieve(id: string): Promise<{
    data: ArrayBuffer;
    mimeType: string;
}>;
import { getAllStatus } from './registry.js';
import { getStatus } from './registry.js';
import { isReady } from './registry.js';
import { deleteFile } from './deleter.js';
import { deleteAllFiles } from './deleter.js';
import { on } from './events.js';
import { off } from './events.js';
import { once } from './events.js';
import { emit } from './events.js';
import { getStorageEstimate } from './storage.js';
import { requestPersistentStorage } from './storage.js';
import { isPersistentStorage } from './storage.js';
import { setDBInfo } from './db.js';
import { dbGetAllIds } from './db.js';
export { registerFile, registerFiles, startDownloads, stopDownloads, retryFailed, isDownloading, abortDownload, abortAllDownloads, startMonitoring, stopMonitoring, isOnline, isMonitoring, getAllStatus, getStatus, isReady, deleteFile, deleteAllFiles, on, off, once, emit, getStorageEstimate, requestPersistentStorage, isPersistentStorage };
