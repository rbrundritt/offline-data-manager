export default OfflineDataManager;
declare namespace OfflineDataManager {
    export { setDBInfo };
    export { registerFile };
    export { registerFiles };
    export { downloadFiles };
    export { abortDownload };
    export { abortAllDownloads };
    export { resumeInterruptedDownloads };
    export { startMonitoring };
    export { stopMonitoring };
    export { isOnline };
    export { isMonitoring };
    export { retrieve };
    export { view };
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
import { downloadFiles } from './downloader.js';
import { abortDownload } from './downloader.js';
import { abortAllDownloads } from './downloader.js';
import { resumeInterruptedDownloads } from './downloader.js';
import { startMonitoring } from './downloader.js';
import { stopMonitoring } from './downloader.js';
import { isOnline } from './downloader.js';
import { isMonitoring } from './downloader.js';
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
export function retrieve(id: string): Promise<Blob>;
import { view } from './registry.js';
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
export { registerFile, registerFiles, downloadFiles, abortDownload, abortAllDownloads, resumeInterruptedDownloads, startMonitoring, stopMonitoring, isOnline, isMonitoring, view, getStatus, isReady, deleteFile, deleteAllFiles, on, off, once, emit, getStorageEstimate, requestPersistentStorage, isPersistentStorage };
