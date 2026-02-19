/**
 * connectivity.js
 * Monitors browser online/offline status and coordinates with the downloader.
 *
 * Behaviour:
 *   - When the browser goes offline, all active downloads are paused immediately.
 *     This avoids burning retry attempts on fetch errors that are purely
 *     connectivity-related rather than server-side problems.
 *
 *   - When the browser comes back online, downloadFiles() is called automatically
 *     to resume. This means callers only need to call downloadFiles() once — the
 *     manager handles reconnection internally for the duration of the session.
 *
 *   - navigator.onLine can return true on a captive portal or a connection that
 *     can't reach the actual download servers. The 'online' event therefore
 *     triggers a resume attempt, but actual connectivity is still confirmed by
 *     whether the subsequent fetch succeeds. Failed fetches will retry with
 *     backoff as normal.
 *
 * Usage:
 *   Call startConnectivityMonitor() once, typically right after the first
 *   downloadFiles() call. It is idempotent — safe to call multiple times.
 *   Call stopConnectivityMonitor() to clean up listeners (e.g. in tests).
 */

import { emit } from './events.js';

// Injected by startConnectivityMonitor — avoids a circular import with downloader.js
let _pauseAll  = null;
let _resumeAll = null;
let _monitoring = false;

function handleOffline() {
  emit('connectivity', { online: false });
  _pauseAll?.();
}

function handleOnline() {
  emit('connectivity', { online: true });
  _resumeAll?.();
}

/**
 * Starts monitoring window online/offline events.
 * Downloads are paused when offline and resumed when online.
 *
 * @param {object} handlers
 * @param {Function} handlers.pauseAll  — called when offline; should abort active downloads
 * @param {Function} handlers.resumeAll — called when online; should call downloadFiles()
 */
export function startConnectivityMonitor({ pauseAll, resumeAll }) {
  if (_monitoring) return;
  _pauseAll  = pauseAll;
  _resumeAll = resumeAll;
  window.addEventListener('offline', handleOffline);
  window.addEventListener('online',  handleOnline);
  _monitoring = true;
}

/**
 * Stops monitoring and removes event listeners.
 * After calling this, online/offline events will no longer trigger pause/resume.
 */
export function stopConnectivityMonitor() {
  window.removeEventListener('offline', handleOffline);
  window.removeEventListener('online',  handleOnline);
  _pauseAll   = null;
  _resumeAll  = null;
  _monitoring = false;
}

/**
 * Returns the current online status from navigator.onLine.
 * Note: true does not guarantee the download servers are reachable,
 * only that the browser believes it has a network connection.
 * @returns {boolean}
 */
export function isOnline() {
  return navigator.onLine ?? true;
}

/**
 * Returns true if connectivity monitoring is currently active.
 * @returns {boolean}
 */
export function isMonitoring() {
  return _monitoring;
}