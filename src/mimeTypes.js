//A lookup table of file extensions to content mimi types.
const MIMI_TYPES = {
    //Image file types
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    gif: 'image/gif',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    avif: 'image/avif',
    apng: 'image/apng',

    //Video file types
    mp4: 'video/mp4',
    webm: 'video/webm',
    mpeg: 'video/mpeg',

    //Audio file types
    mp3: 'audio/mpeg',
    wav: 'audio/wav',

    //Font file types
    ttf: 'font/ttf',
    woff: 'font/woff',
    woff2: 'font/woff2',
    otf: 'font/otf',

    //JSON and XML based file types
    json: 'application/json',
    geojson: 'application/json',
    geojsonseq: 'application/json',
    topojson: 'application/json',
    gpx: 'application/xml',
    georss: 'application/xml',
    gml: 'application/xml',
    citygml: 'application/xml',
    czml: 'application/xml',
    xml: 'application/xml',
    kml: 'application/vnd.google-earth.kml+xml',

    //Office Excel file types (Just incase someone decides to use that to load in a table of data)
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.ms-excel',

    //3D model file types commonly used in web.
    gltf: 'model/gltf+json',
    glb: 'model/gltf-binary',
    dae: 'model/vnd.collada+xml',

    //Other binary file types
    zip: 'application/zip',
    pbf: 'application/x-protobuf',
    mvt: 'application/vnd.mapbox-vector-tile',
    pdf: 'application/pdf',

    //Other map tile file types
    terrian: 'application/vnd.quantized-mesh',
    pmtiles: 'application/vnd.pmtiles',

    //Text based file types
    htm: 'text/html',
    html: 'text/html',
    xhtml: 'application/xhtml+xml',
    js: 'text/javascript',
    css: 'text/css',
    csv: 'text/csv',
    md: 'text/markdown',
    plain: 'text/plain',
    txt: 'text/plain',
    wat: 'text/plain',
    wsv: 'text/wsv',

    //Other standard web file types
    wasm: 'application/wasm'

    /**
    * The following should use 'application/octet-stream' and since that is the default, no need to add to lookup table:
    * - tpkx
    * - kmz
    * - shp
    * - dbf
    * - bin
    * - b3dm
    * - i3dm
    * - pnts
    * - subtree
    */
}

/**
 * Helper function that tries to determine the content mimi type for a url or file name string by inspecting the file extension of the request. 
 * If all else fails, returns 'application/octet-stream' as that is considered the best default content type for media to fail over to.
 * @param {string} urlOrFileName The url or file name.
 * @returns
 */
export function getMimeType(urlOrFileName) {
    //Try get file extension.
    if (urlOrFileName && typeof urlOrFileName == 'string' && urlOrFileName.includes('.')) {
        // Get the extension after the last dot.
        const ext = urlOrFileName.split('.').pop().toLowerCase();
        const ct = MIMI_TYPES[ext];
        if (ct) {
            return ct;
        }
    }

    return 'application/octet-stream';
}