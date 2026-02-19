/**
 * Starts monitoring window online/offline events.
 * Downloads are paused when offline and resumed when online.
 *
 * @param {object} handlers
 * @param {Function} handlers.pauseAll  — called when offline; should abort active downloads
 * @param {Function} handlers.resumeAll — called when online; should call downloadFiles()
 */
export function startConnectivityMonitor({ pauseAll, resumeAll }: {
    pauseAll: Function;
    resumeAll: Function;
}): void;
/**
 * Stops monitoring and removes event listeners.
 * After calling this, online/offline events will no longer trigger pause/resume.
 */
export function stopConnectivityMonitor(): void;
/**
 * Returns the current online status from navigator.onLine.
 * Note: true does not guarantee the download servers are reachable,
 * only that the browser believes it has a network connection.
 * @returns {boolean}
 */
export function isOnline(): boolean;
/**
 * Returns true if connectivity monitoring is currently active.
 * @returns {boolean}
 */
export function isMonitoring(): boolean;
