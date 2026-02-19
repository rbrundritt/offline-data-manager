/**
 * Evaluates TTL expiry, then downloads everything that needs it.
 *
 * Eligible statuses (when resumeOnly is false):
 *   pending, in-progress, paused, deferred, expired
 *   + failed entries when retryFailed: true
 *
 * If the browser is currently offline, the call returns immediately after
 * marking any in-progress entries as paused. Downloads will auto-resume
 * when connectivity is restored (if startConnectivityMonitor() was called).
 *
 * @param {object}  [options]
 * @param {number}  [options.concurrency=2]    — max parallel downloads
 * @param {boolean} [options.resumeOnly=false] — only resume in-progress/paused
 * @param {boolean} [options.retryFailed=false] — re-queue failed entries before running
 * @returns {Promise<void>}
 */
export function downloadFiles({ concurrency, resumeOnly, retryFailed, }?: {
    concurrency?: number | undefined;
    resumeOnly?: boolean | undefined;
    retryFailed?: boolean | undefined;
}): Promise<void>;
/**
 * Aborts an active download, setting it to 'paused'.
 * It will resume on the next downloadFiles() call.
 * @param {string} id
 */
export function abortDownload(id: string): Promise<void>;
/**
 * Aborts all active downloads.
 */
export function abortAllDownloads(): Promise<void>;
/**
 * Resumes any downloads interrupted by a previous page or SW close.
 * Call this in a service worker 'activate' event.
 * @returns {Promise<void>}
 */
export function resumeInterruptedDownloads(): Promise<void>;
/**
 * Starts monitoring online/offline connectivity.
 *
 * - Going offline: all active downloads are paused immediately.
 * - Coming back online: downloadFiles() is called automatically with the
 *   same options as the most recent explicit call.
 *
 * Idempotent — safe to call multiple times. Call stopConnectivityMonitor()
 * to remove the listeners (useful in tests or cleanup).
 */
export function startMonitoring(): void;
export { stopConnectivityMonitor as stopMonitoring, isOnline, isMonitoring } from "./connectivity.js";
