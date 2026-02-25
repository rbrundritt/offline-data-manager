/** Called by registerFile() and the connectivity monitor to wake the loop. */
export function _notifyNewWork(): void;
/**
 * Starts the persistent download loop.
 *
 * The loop drains the queue, then waits for new work without polling.
 * It wakes automatically when:
 *   - registerFile() / registerFiles() adds a new or updated entry
 *   - The browser comes back online after an offline period
 *   - retryFailed() is called
 *
 * Idempotent — subsequent calls while already running are a no-op.
 *
 * @param {object} [options]
 * @param {number} [options.concurrency=2] — max parallel downloads
 */
export function startDownloads({ concurrency }?: {
    concurrency?: number | undefined;
}): void;
/**
 * Stops the download loop gracefully.
 *
 * In-flight downloads are aborted and set to 'paused'. They will resume
 * automatically when startDownloads() is called again.
 */
export function stopDownloads(): Promise<void>;
/**
 * Re-queues all failed entries and wakes the loop to retry them.
 * Only meaningful when the loop is running via startDownloads().
 */
export function retryFailed(): Promise<void>;
/**
 * Returns true if the download loop is currently running.
 * @returns {boolean}
 */
export function isDownloading(): boolean;
/**
 * Aborts a single active download, setting it to 'paused'.
 * The loop will pick it up again on the next drain cycle.
 * @param {string} id
 */
export function abortDownload(id: string): Promise<void>;
/**
 * Aborts all active downloads, setting them to 'paused'.
 */
export function abortAllDownloads(): Promise<void>;
/**
 * Starts monitoring online/offline connectivity.
 *
 * Going offline: aborts active downloads immediately (pauses them).
 * Coming back online: wakes the download loop to resume.
 *
 * Idempotent — safe to call multiple times.
 * Emits 'connectivity' events: { online: boolean }.
 */
export function startMonitoring(): void;
export { stopConnectivityMonitor as stopMonitoring, isOnline, isMonitoring } from "./connectivity.js";
