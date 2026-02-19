/**
 * Subscribe to an event. Returns an unsubscribe function.
 * @param {string} event
 * @param {Function} listener
 * @returns {Function}
 */
export function on(event: string, listener: Function): Function;
/**
 * Unsubscribe from an event.
 * @param {string} event
 * @param {Function} listener
 */
export function off(event: string, listener: Function): void;
/**
 * Emit an event to all registered listeners.
 * @param {string} event
 * @param {object} data
 */
export function emit(event: string, data: object): void;
/**
 * Subscribe to an event once; auto-removes after first call.
 * @param {string} event
 * @param {Function} listener
 */
export function once(event: string, listener: Function): void;
