/**
 * Deletes a single file's array buffer and optionally its registry entry.
 *
 * @param {string} id
 * @param {object}  [options]
 * @param {boolean} [options.removeProtected=false] — force registry removal for protected entries
 * @returns {Promise<{ id: string, registryRemoved: boolean }>}
 */
export function deleteFile(id: string, { removeProtected }?: {
    removeProtected?: boolean | undefined;
}): Promise<{
    id: string;
    registryRemoved: boolean;
}>;
/**
 * Deletes all files. Protected entries follow the same rules as deleteFile().
 *
 * @param {object}  [options]
 * @param {boolean} [options.removeProtected=false]
 * @returns {Promise<Array<{ id: string, registryRemoved: boolean }>>}
 */
export function deleteAllFiles({ removeProtected }?: {
    removeProtected?: boolean | undefined;
}): Promise<Array<{
    id: string;
    registryRemoved: boolean;
}>>;
