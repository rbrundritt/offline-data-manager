# offline-data-manager

A service-worker-friendly library for registering, downloading, and storing files offline using IndexedDB. All files are stored as ArrayBuffers — the library has no knowledge of file contents. Parsing, decompression, and interpretation are the caller's responsibility.

[Try the sample app](https://rbrundritt.github.io/offline-data-manager/samples/) - Note that all the UI is from the sample app. This library only provides an API interface for managing offline data workflows.

> [!NOTE]
> Since this code runs in JavaScript and will most likely be used within a website, the data it accesses either needs to be on the same domain or hosted on a server with CORS enabled. Alternatively, you can pass cross domain requests through a CORS enabled proxy.

---

## Features

- Create a register of data to download.
  - Register items individually or in batches.
  - Set a priority for each item to ensure more critical data is downloaded first.
  - Optional mark it protected so that if a delete occurs, the registry persists and will redownload the data the next time download process it triggered.
  - Optionally set a "time to live" (ttl) value so that data is automatically updated after a period of time. Expired data will persist until updated data has been downloaded, at which point the expired data will be replaced.
- Downloads data and stores as an ArrayBuffer in `indexedDB`.
  - Files larger than 5MB are downloaded in 2MB chunks and merged back together when all chunks have been downloaded. This allows for downloads to be interupted and continue without having to start over from the beginning. This is useful if the user refreshes the page or leaves and comes back later.
  - If a download fails, the retry option will attempt to redownload the data using an expotential backoff method up to 5 tries.
  - Online/Offline state is monitored. Downloads are paused and resumed based on the state.
  - Storage limits are monitored and not exceed. This information is also easily retrievable.

> [!TIP]
> If you use this with a shared worker, the download process will only ever have one instance running, download, and writing data. It will also persist between open pages of your app. For example, if you start the process on one webpage, open a second that's on the same domain, then close the first webpage, the service worker would continue to function uninterrupted. 

---

## Setup

### With NPM Modules

```bash
npm install offline-data-manager
```

### Browser (without modules)

Download and host the [dist/umd/offline-data-manager.js](dist/umd/offline-data-manager.js) file then add a script tag in your webapp pointing to this file. A global `offlineDataManager` class will be available in JavaScript.

---

## File structure

```
src/
  index.js        — Public API (import from here)
  db.js           — IndexedDB setup and helpers
  registry.js     — registerFile, registerFiles, view, isReady, getStatus, TTL/expiry
  downloader.js   — Persistent download loop, chunked Range requests, retry, connectivity
  deleter.js      — deleteFile, deleteAllFiles
  events.js       — Lightweight event emitter
  storage.js      — Storage quota utilities
  connectivity.js — Online/offline monitoring

test/
  index.html      — Interactive test harness (imports from ../src/index.js)

dist/
  offline-data-manager.esm.js     — ES module bundle (Vite, Webpack 5+)
  offline-data-manager.cjs        — CommonJS bundle (Node.js require())
  offline-data-manager.umd.js     — UMD bundle (browser <script> tag, AMD)
  offline-data-manager.umd.min.js — Minified UMD bundle

build.mjs         — Zero-dependency build script (node build.mjs)
```

---

## Quick start

```js
import ODM from './src/index.js';

// 1. Register files
await ODM.registerFiles([
  {
    id:          'base-map',
    downloadUrl: 'https://example.com/map.pmtiles',
    mimeType:    'application/vnd.pmtiles',
    version:     1,
    protected:   true,
    priority:    1,
    ttl:         86400,
  },
  {
    id:          'poi-data',
    downloadUrl: 'https://example.com/poi.json',
    // mimeType omitted — inferred from Content-Type response header
    version:     1,
    priority:    5,
  },
]);

// 2. Subscribe to events
ODM.on('progress',      ({ id, percent }) => console.log(`${id}: ${percent}%`));
ODM.on('complete',      ({ id, mimeType }) => console.log(`${id} ready (${mimeType})`));
ODM.on('error',         ({ id, error, willRetry }) => console.error(id, error));
ODM.on('connectivity',  ({ online }) => console.log(online ? 'back online' : 'offline'));

// 3. Start connectivity monitoring
ODM.startMonitoring();

// 4. Start the persistent download loop — call once at startup
ODM.startDownloads({ concurrency: 2 });

// Later: register a new file — the loop picks it up automatically, no extra call needed
await ODM.registerFile({ id: 'new-layer', downloadUrl: '...', version: 1 });

// Retrieve stored data
const { data, mimeType } = await ODM.retrieve('poi-data');
const json = JSON.parse(new TextDecoder().decode(data));

// Pass to a library that accepts ArrayBuffers (e.g. PMTiles)
const { data: mapBuffer } = await ODM.retrieve('base-map');
```

---

## Registry entry shape

```js
{
  id:          string,       // required — unique identifier
  downloadUrl: string,       // required — URL to fetch
  mimeType:    string|null,  // optional — inferred from Content-Type header if omitted
  version:     number,       // required — non-negative integer; triggers re-download when increased
  protected:   boolean,      // default false — registry survives deletion; data re-downloaded
  priority:    number,       // default 10 — lower number = higher priority
  ttl:         number,       // seconds; 0 or omitted = never expires
  totalBytes:  number|null,  // optional size hint for storage checks and progress
  metadata:    object,       // arbitrary caller key/values
}
```

### `version`
When `registerFiles()` is called with a higher version, the queue resets to `pending` but the existing ArrayBuffer stays in IDB and remains accessible via `retrieve()` until the new download completes and overwrites it.

### `protected`
| Value | On delete | Registry |
|---|---|---|
| `true` | Data cleared, queue reset to `pending` | **Survives** — re-downloaded on next drain cycle |
| `false` | Fully removed | **Removed** |

Pass `{ removeProtected: true }` to `delete()` to force full removal of a protected entry.

### `ttl`
Time-to-live in seconds. On each drain cycle, entries whose `completedAt + ttl` has elapsed are flipped to `expired` and queued for re-download. The existing ArrayBuffer remains accessible throughout — there is no gap in availability. On completion the TTL clock resets from the new `completedAt`.

---

## Download status values

| Status | Meaning |
|---|---|
| `pending` | Queued, not yet started |
| `in-progress` | Actively downloading |
| `paused` | Aborted mid-flight; loop resumes it on next drain cycle |
| `complete` | ArrayBuffer stored and fresh |
| `expired` | ArrayBuffer stored but TTL has elapsed; still accessible, re-download queued |
| `failed` | Exhausted all retries; call `retryFailed()` to re-queue |
| `deferred` | Skipped due to insufficient storage; retried next drain cycle |

---

## API

### Registration

#### `registerFile(entry)`
Registers a single file. No-op if the version hasn't strictly increased. Wakes the download loop immediately if it's running.

#### `registerFiles(entries)`
Registers an array of files and removes any non-protected entries absent from the list.
```js
const { registered, removed } = await ODM.registerFiles([...]);
```

---

### Download loop

#### `startDownloads(options?)`
Starts the persistent download loop. Idempotent — safe to call multiple times.

```js
ODM.startDownloads({ concurrency: 2 });
```

The loop:
1. Evaluates TTL expiry, then downloads all pending / paused / deferred / expired entries up to `concurrency` in parallel.
2. Waits — without polling — for new work to arrive.
3. Wakes automatically when `registerFile()` adds a new or updated entry, when the browser comes back online, or when `retryFailed()` is called.
4. Exits cleanly when `stopDownloads()` is called.

Because registering a file wakes the loop, there is no need to call `startDownloads()` again after registering new files at runtime.

#### `stopDownloads()`
Stops the loop gracefully. In-flight downloads are aborted and set to `paused`. Call `startDownloads()` again to resume.

```js
await ODM.stopDownloads();
```

#### `retryFailed()`
Re-queues all `failed` entries and wakes the loop to retry them. `failed` is terminal by design — broken URLs won't loop forever.

```js
await ODM.retryFailed();
```

#### `isDownloading()`
Returns `true` if the loop is currently running.

```js
ODM.isDownloading(); // → boolean
```

---

### Abort

#### `abortDownload(id)`
Aborts a single active download, setting it to `paused`. The loop picks it up again on the next drain cycle.

#### `abortAllDownloads()`
Aborts all active downloads.

---

### Connectivity monitoring

#### `startMonitoring()` / `stopMonitoring()`
Monitors `window` online/offline events.

- Going **offline**: immediately pauses all active downloads (avoids burning retry attempts).
- Coming back **online**: wakes the download loop to resume automatically.

```js
ODM.startMonitoring(); // call once, typically at startup before startDownloads()
ODM.stopMonitoring();  // remove listeners (e.g. in tests)
```

Emits a `'connectivity'` event `{ online: boolean }` on every change. `navigator.onLine` can return `true` on captive portals — actual server reachability is confirmed by whether the subsequent fetch succeeds, with failed fetches retrying normally with backoff.

#### `isOnline()` / `isMonitoring()`
```js
ODM.isOnline();     // → boolean (navigator.onLine)
ODM.isMonitoring(); // → boolean
```

---

### Retrieve

#### `retrieve(id)`
Returns the stored ArrayBuffer and resolved MIME type for a completed or expired file.

```js
const { data, mimeType } = await ODM.retrieve('poi-data');

// Text / JSON
const text = new TextDecoder().decode(data);
const json = JSON.parse(text);

// Binary (e.g. PMTiles, zip)
const { data: mapBuffer } = await ODM.retrieve('base-map');
// pass mapBuffer to PMTiles, JSZip, etc.
```

Returns data for both `complete` and `expired` entries — expiry only means a refresh is queued, not that the data is gone. Throws if the file is not registered or has no data yet.

---

### Status

#### `getAllStatus()`
Returns all entries merged with queue state, plus a storage summary.
```js
const { items, storage } = await ODM.getAllStatus();
// items[n]: { id, mimeType, version, downloadStatus, storedBytes,
//             bytesDownloaded, progress, completedAt, expiresAt, ... }
// storage:  { usageBytes, quotaBytes, availableBytes, ...Formatted }
```

#### `getStatus(id)`
Full merged status for one file, or `null` if not registered.

#### `isReady(id)`
Returns `true` if the file has data available (`complete` or `expired`).

---

### Delete

#### `delete(id, options?)`
```js
await ODM.delete('poi-data');                             // respects protected flag
await ODM.delete('base-map', { removeProtected: true });   // force full removal
```

#### `deleteAll(options?)`
```js
await ODM.deleteAll();
await ODM.deleteAll({ removeProtected: true });
```

---

### Events

```js
const unsub = ODM.on('progress',      ({ id, bytesDownloaded, totalBytes, percent }) => {});
ODM.on('complete',      ({ id, mimeType }) => {});
ODM.on('expired',       ({ id }) => {});
ODM.on('error',         ({ id, error, retryCount, willRetry }) => {});
ODM.on('deferred',      ({ id, reason }) => {});
ODM.on('registered',    ({ id, reason }) => {}); // reason: 'new' | 'version-updated'
ODM.on('deleted',       ({ id, registryRemoved }) => {});
ODM.on('status',        ({ id, status }) => {});
ODM.on('stopped',       ({}) => {});              // emitted when stopDownloads() completes
ODM.on('connectivity',  ({ online }) => {});

ODM.once('complete', ({ id }) => {});
unsub(); // remove listener
```

---

### Storage

```js
const { usage, quota, available } = await ODM.getStorageEstimate();
await ODM.requestPersistentStorage();
await ODM.isPersistentStorage();
```

---

### Service worker

The download loop starts fresh on each page load. Call `startDownloads()` in a service worker `activate` event to resume any downloads interrupted by a previous SW close — pending and paused entries are picked up automatically on the first drain cycle.

```js
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      ODM.startMonitoring();
      ODM.startDownloads({ concurrency: 2 });
    })()
  );
});
```

---

## Building for distribution

```bash
node build.mjs           # produces dist/ (ESM, CJS, UMD, UMD minified)
node build.mjs --watch   # rebuild on src changes
node build.mjs --no-min  # skip minification
```

The build script is zero-dependency — pure Node.js 18+, no Rollup or Webpack required.

| Output | For |
|---|---|
| `dist/offline-data-manager.esm.js` | Vite, Webpack 5+, native `<script type=module>` |
| `dist/offline-data-manager.cjs` | Node.js `require()`, older toolchains |
| `dist/offline-data-manager.umd.js` | `<script>` tag → `window.OfflineDataManager`, AMD |
| `dist/offline-data-manager.umd.min.js` | Production `<script>` tag |

---

## Notes

- **ArrayBuffer storage** — all file data is stored as a raw ArrayBuffer on the queue record alongside its resolved `mimeType`. There is only one IDB store to manage; no separate data store.
- **MIME type inference** — when `mimeType` is omitted from a registry entry, the downloader reads `Content-Type` from the HEAD probe (or GET response as a fallback) and strips any charset parameters. Falls back to `application/octet-stream` if the server returns nothing useful. The resolved type is stored with the ArrayBuffer and returned by `retrieve()`, `getAllStatus()`, and `getStatus()`.
- **Persistent loop vs one-shot** — the loop waits on a Promise that resolves only when `registerFile()` or the connectivity monitor calls an internal wake function. There is no polling between drain cycles.
- **Chunking threshold** — files over 5 MB are downloaded in 2 MB Range request chunks. Both constants are in `downloader.js`.
- **Content-Encoding** — `Content-Length` is ignored for size tracking when the server applies `gzip`/`br` encoding, avoiding misleading progress numbers. Progress shows as indeterminate instead.
- **Storage safety margin** — 10% of quota is reserved before deferring downloads. Configurable in `storage.js`.