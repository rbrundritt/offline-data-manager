# offline-data-manager

A service-worker-friendly library for registering, downloading, and storing files offline using IndexedDB. All files are stored as typed Blobs — the library has no knowledge of file contents. Parsing, decompression, and interpretation are the caller's responsibility.

[Try the sample app](https://rbrundritt.github.io/offline-data-manager/samples/) - Note that all the UI is from the sample app. This library only provides an API interface for managing offline data workflows.

---

## Features

- Create a register of data to download.
  - Register items individually or in batches.
  - Set a priority for each item to ensure more critical data is downloaded first.
  - Optional mark it protected so that if a delete occurs, the registry persists and will redownload the data the next time download process it triggered.
  - Optionally set a "time to live" (ttl) value so that data is automatically updated after a period of time. Expired data will persist until updated data has been downloaded, at which point the expired data will be replaced.
- Downloads data and stores as blobs in `indexedDB`.
  - Files larger than 5MB are downloaded in 2MB chunks and merged back together when all chunks have been downloaded. This allows for downloads to be interupted and continue without having to start over from the beginning. This is useful if the user refreshes the page or leaves and comes back later.
  - If a download fails, the retry option will attempt to redownload the data using an expotential backoff method up to 5 tries.
  - Online/Offline state is monitored. Downloads are paused and resumed based on the state.
  - Storage limits are monitored and not exceed. This information is also easily retrievable.

## Setup

### With NPM Modules

```bash
npm install offline-data-manager
```

### Browser (without modules)

Download and host the [dist/umd/offline-data-manager.js](dist/umd/offline-data-manager.js) file then add a script tag in your webapp pointing to this file. A global `offlineDataManager` class will be available in JavaScript.

## Running the test harness

The test harness imports directly from `src/index.js` using ES modules, so it requires a local HTTP server (browsers block module imports from `file://`).

```bash
# From the offline-data-manager directory:
npm run dev
# Then open: http://localhost:3000/test/index.html
```

Or with any static server you prefer:

```bash
npx serve .                    # then open http://localhost:3000/test/index.html
python3 -m http.server 3000    # then open http://localhost:3000/test/index.html
```
---

## How to handle retrieved data

Once the data is downloaded, it is stored in `indexedDB` as a `Blob` regardless of the content type. You could check the mimetype if you aren't certain of the type, although that usually shouldn't be the case. Note that the mimetype is only for the main file and not any contents it has. So a Zip file will have a mimetype of `octet-stream` even if it contains a bunch of PNG images which would have a mimetype of `image/png`. As a best practice, when registering the data, add any additional insights you have on the data into the `metadata` option to make it easier to process the data later. Here is some insights on how to get this into a more usable format.

```js
try {
  //Check that the file is ready to be access (status: complete or expired))
  if(await offlineDataManager.retrieve(id)) {
    //Retrieve the file blob.
    const myBlob = await offlineDataManager.retrieve(id);

    //Get the data as text.
    const text = await blob.text();

    //Get the data as json.
    const json = JSON.parse(text);

    //Get as ArrayBuffer.
    const buffer = await blob.arrayBuffer();

    //Get as data Url.
    const dataUrl = URL.createObjectURL(blob);

    //Load the blob into an img tag.
    document.getElementById('myImage').src = dataUrl;
  }
} catch(e) {
  //If we get here it is likely the file ID is not in the registry or the file hasn't been downloaded yet.
}
```

## File structure

```
src/
  index.js      — Public API (import from here)
  db.js         — IndexedDB setup and helpers
  registry.js   — registerFile, registerFiles, view, isReady, getStatus, TTL/expiry
  downloader.js — downloadFiles, chunked Range requests, retry, resume, expiry evaluation
  deleter.js    — deleteFile, deleteAllFiles
  events.js     — Lightweight event emitter
  storage.js    — Storage quota utilities

test/
  index.html    — Interactive test harness (imports from ../src/index.js)
```

---

## Registry entry shape

```js
{
  id:          string,       // required — unique identifier
  downloadUrl: string,       // required — URL to fetch
  version:     number,       // required — non-negative integer; triggers re-download when increased
  mimeType:    string|null,  // optional — inferred from Content-Type header if omitted
  protected:   boolean,      // default false — registry survives deletion; data re-downloaded
  priority:    number,       // default 10 — lower number = higher priority
  ttl:         number,       // seconds; 0 or omitted = never expires
  totalBytes:  number|null,  // optional size hint for storage checks and progress
  metadata:    object,       // arbitrary caller key/values
}
```

### `version`

When `registerFiles()` is called with a higher version, the queue resets to `pending` but the existing blob stays in IDB and remains accessible via `retrieve()` until the new download completes and overwrites it.

### `protected`

| Value | On delete | Registry |
|---|---|---|
| `true` | Blob cleared, queue reset to `pending` | **Survives** — re-downloaded on next `downloadFiles()` |
| `false` | Fully removed | **Removed** |

Pass `{ removeRegistry: true }` to `delete()` to force full removal of a protected entry.

### `ttl`

Time-to-live in seconds. On each `downloadFiles()` call, entries whose `completedAt + ttl` has elapsed are flipped to `expired` and queued for re-download. The existing blob remains accessible throughout — there is no gap in availability. On completion the TTL clock resets from the new `completedAt`.

---

## Download status values

| Status | Meaning |
|---|---|
| `pending` | Queued, not yet started |
| `in-progress` | Actively downloading |
| `paused` | Aborted mid-flight; resumes on next `downloadFiles()` |
| `complete` | Blob stored and fresh |
| `expired` | Blob stored but TTL has elapsed; still accessible, re-download queued |
| `failed` | Exhausted all retries |
| `deferred` | Skipped due to insufficient storage; retried next run |

---

## API

### `setDBInfo(dbName, dbVersion)`

Overrides the default DB name and version number. If used, it should be done before using any other part of this API. By default the database name is `'offline-data-manager'` and the version is 1. 

```js
//Set the db name and version.
offlineDataManager.setDBInfo('my-offline-db', 2);

//Set the db version online. Database name will continue to be 'offline-data-manager'.
offlineDataManager.setDBInfo(null, 2);
```

### `registerFile(entry)`

Registers a single file. No-op if version hasn't strictly increased.

### `registerFiles(entries)`

Registers an array of files. Removes non-protected entries absent from the list.

```js
const { registered, removed } = await offlineDataManager.registerFiles([...]);
```

### `downloadFiles(options?)`

Evaluates TTL expiry, then downloads all pending/paused/deferred/expired entries. Returns immediately if the browser is offline — downloads resume automatically when connectivity is restored if `startMonitoring()` has been called.

```js
await offlineDataManager.downloadFiles({ concurrency: 2, resumeOnly: false, retryFailed: false });
```

- `retryFailed: true` resets all `failed` entries to `pending` before the run, giving them a fresh set of retries. Useful after fixing a broken URL or restoring connectivity after a long outage.

### `retrieve(id)`

Returns the stored `Blob`. Works for both `complete` and `expired` entries.

```js
const blob = await offlineDataManager.retrieve('json-data');
const json = JSON.parse(await blob.text());

const mapBlob   = await offlineDataManager.retrieve('zip-data');
const mapBuffer = await mapBlob.arrayBuffer(); // Process binary data.
```

### `view()`

Returns all entries merged with queue state, plus storage summary.

```js
const { items, storage } = await offlineDataManager.view();
// items[n]: { id, mimeType, version, downloadStatus, storedBytes,
//             bytesDownloaded, progress, completedAt, expiresAt, ... }
// storage:  { usageBytes, quotaBytes, availableBytes, ...Formatted }
```

### `getStatus(id)`

Full merged status for one file, or `null` if not registered.

### `isReady(id)`

Returns `true` if the file has a blob available (`complete` or `expired`).

### `delete(id, options?)`

```js
await offlineDataManager.delete('poi-data');                             // respects protected flag
await offlineDataManager.delete('base-map', { removeRegistry: true });   // force full removal
```

### `deleteAll(options?)`

```js
await offlineDataManager.deleteAll();
await offlineDataManager.deleteAll({ removeRegistry: true });
```

### `startMonitoring()` / `stopMonitoring()`

Monitors `window` online/offline events. Going offline immediately pauses all active downloads (avoiding wasted retry attempts). Coming back online automatically calls `downloadFiles()` with the same options as the most recent explicit call.

```js
offlineDataManager.startMonitoring(); // call once after first downloadFiles()
offlineDataManager.stopMonitoring();  // remove listeners (e.g. in tests)
```

Emits a `'connectivity'` event `{ online: boolean }` on every change. `navigator.onLine` can return `true` on a captive portal — actual server reachability is confirmed by whether the subsequent fetch succeeds, and failed fetches retry with backoff as normal.

### `isOnline()` / `isMonitoring()`

```js
offlineDataManager.isOnline();    // → boolean (navigator.onLine)
offlineDataManager.isMonitoring(); // → boolean
```


Sets status to `paused`; resumes on next `downloadFiles()`.

### `resumeInterruptedDownloads()`

Resumes `paused` and `in-progress` entries. Call in a service worker `activate` event:

```js
self.addEventListener('activate', (event) => {
  event.waitUntil(offlineDataManager.resumeInterruptedDownloads());
});
```

### Events

```js
const unsub = offlineDataManager.on('progress',   ({ id, bytesDownloaded, totalBytes, percent }) => {});
offlineDataManager.on('complete',   ({ id }) => {});
offlineDataManager.on('expired',    ({ id }) => {});
offlineDataManager.on('error',      ({ id, error, retryCount, willRetry }) => {});
offlineDataManager.on('deferred',   ({ id, reason }) => {});
offlineDataManager.on('registered', ({ id, reason }) => {}); // reason: 'new' | 'version-updated'
offlineDataManager.on('deleted',    ({ id, registryRemoved }) => {});
offlineDataManager.on('status',     ({ id, status }) => {});

offlineDataManager.once('complete', ({ id }) => {});
unsub(); // remove listener
```

### Storage

```js
const { usage, quota, available } = await offlineDataManager.getStorageEstimate();
await offlineDataManager.requestPersistentStorage();
await offlineDataManager.isPersistentStorage();
```

---

## Notes

- **MIME type inference** — when `mimeType` is omitted from a registry entry, the downloader reads `Content-Type` from the HEAD probe (or GET response as a fallback) and strips any charset parameters. Falls back to `application/octet-stream` if the server returns nothing useful. The resolved type is stored as `Blob.type` and surfaced in `view()` / `getStatus()`.
- **Retry failed** — `failed` is a terminal status by design to avoid infinite retry loops on broken URLs. Pass `retryFailed: true` to `downloadFiles()` to explicitly re-queue failed entries when you're ready to try again.
- **Chunking threshold** — files over 5 MB are chunked in 2 MB Range requests. Both constants are in `downloader.js`.
- **Content-Encoding** — `Content-Length` is ignored for size tracking when the server applies `gzip`/`br` encoding, avoiding misleading progress numbers. Progress shows as indeterminate instead.
- **Storage safety margin** — 10% of quota is reserved before deferring downloads. Configurable in `storage.js`.
- **Blob in IDB** — the Blob is stored directly on the queue record, so there is only one IDB store to manage rather than a separate data store.