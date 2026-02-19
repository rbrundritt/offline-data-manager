/**
 * events.js
 * Lightweight event emitter for download lifecycle events.
 *
 * Events emitted:
 *   'progress'   — { id, bytesDownloaded, totalBytes, percent }
 *   'complete'   — { id }
 *   'error'      — { id, error, retryCount, willRetry? }
 *   'deferred'   — { id, reason }
 *   'expired'    — { id }
 *   'registered' — { id, reason: 'new' | 'version-updated' }
 *   'deleted'    — { id, registryRemoved }
 *   'status'     — { id, status }
 */

const _listeners = new Map();

/**
 * Subscribe to an event. Returns an unsubscribe function.
 * @param {string} event
 * @param {Function} listener
 * @returns {Function}
 */
export function on(event, listener) {
  if (!_listeners.has(event)) _listeners.set(event, new Set());
  _listeners.get(event).add(listener);
  return () => off(event, listener);
}

/**
 * Unsubscribe from an event.
 * @param {string} event
 * @param {Function} listener
 */
export function off(event, listener) {
  _listeners.get(event)?.delete(listener);
}

/**
 * Emit an event to all registered listeners.
 * @param {string} event
 * @param {object} data
 */
export function emit(event, data) {
  _listeners.get(event)?.forEach((listener) => {
    try { listener(data); } catch (err) {
      console.error(`[offline-data-manager] Error in "${event}" listener:`, err);
    }
  });
}

/**
 * Subscribe to an event once; auto-removes after first call.
 * @param {string} event
 * @param {Function} listener
 */
export function once(event, listener) {
  const wrapper = (data) => { listener(data); off(event, wrapper); };
  on(event, wrapper);
}