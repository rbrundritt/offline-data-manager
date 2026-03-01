/**
 * Helper function that tries to determine the content mimi type for a url or file name string by inspecting the file extension of the request.
 * If all else fails, returns 'application/octet-stream' as that is considered the best default content type for media to fail over to.
 * @param {string} urlOrFileName The url or file name.
 * @returns
 */
export function getMimeType(urlOrFileName: string): any;
