# offline-data-manager

A service-worker-friendly library for registering, downloading, and storing files offline using IndexedDB. All files are stored as typed Blobs — the library has no knowledge of file contents. Parsing, decompression, and interpretation are the caller's responsibility.

---

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

### `registerFile(entry)`

Registers a single file. No-op if version hasn't strictly increased.

### `registerFiles(entries)`

Registers an array of files. Removes non-protected entries absent from the list.

```js
const { registered, removed } = await ODM.registerFiles([...]);
```

### `downloadFiles(options?)`

Evaluates TTL expiry, then downloads all pending/paused/deferred/expired entries. Returns immediately if the browser is offline — downloads resume automatically when connectivity is restored if `startMonitoring()` has been called.

```js
await ODM.downloadFiles({ concurrency: 2, resumeOnly: false, retryFailed: false });
```

- `retryFailed: true` resets all `failed` entries to `pending` before the run, giving them a fresh set of retries. Useful after fixing a broken URL or restoring connectivity after a long outage.

### `retrieve(id)`

Returns the stored `Blob`. Works for both `complete` and `expired` entries.

```js
const blob = await ODM.retrieve('json-data');
const json = JSON.parse(await blob.text());

const mapBlob   = await ODM.retrieve('zip-data');
const mapBuffer = await mapBlob.arrayBuffer(); // Process binary data.
```

### `view()`

Returns all entries merged with queue state, plus storage summary.

```js
const { items, storage } = await ODM.view();
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
await ODM.delete('poi-data');                             // respects protected flag
await ODM.delete('base-map', { removeRegistry: true });   // force full removal
```

### `deleteAll(options?)`

```js
await ODM.deleteAll();
await ODM.deleteAll({ removeRegistry: true });
```

### `startMonitoring()` / `stopMonitoring()`

Monitors `window` online/offline events. Going offline immediately pauses all active downloads (avoiding wasted retry attempts). Coming back online automatically calls `downloadFiles()` with the same options as the most recent explicit call.

```js
ODM.startMonitoring(); // call once after first downloadFiles()
ODM.stopMonitoring();  // remove listeners (e.g. in tests)
```

Emits a `'connectivity'` event `{ online: boolean }` on every change. `navigator.onLine` can return `true` on a captive portal — actual server reachability is confirmed by whether the subsequent fetch succeeds, and failed fetches retry with backoff as normal.

### `isOnline()` / `isMonitoring()`

```js
ODM.isOnline();    // → boolean (navigator.onLine)
ODM.isMonitoring(); // → boolean
```


Sets status to `paused`; resumes on next `downloadFiles()`.

### `resumeInterruptedDownloads()`

Resumes `paused` and `in-progress` entries. Call in a service worker `activate` event:

```js
self.addEventListener('activate', (event) => {
  event.waitUntil(ODM.resumeInterruptedDownloads());
});
```

### Events

```js
const unsub = ODM.on('progress',   ({ id, bytesDownloaded, totalBytes, percent }) => {});
ODM.on('complete',   ({ id }) => {});
ODM.on('expired',    ({ id }) => {});
ODM.on('error',      ({ id, error, retryCount, willRetry }) => {});
ODM.on('deferred',   ({ id, reason }) => {});
ODM.on('registered', ({ id, reason }) => {}); // reason: 'new' | 'version-updated'
ODM.on('deleted',    ({ id, registryRemoved }) => {});
ODM.on('status',     ({ id, status }) => {});

ODM.once('complete', ({ id }) => {});
unsub(); // remove listener
```

### Storage

```js
const { usage, quota, available } = await ODM.getStorageEstimate();
await ODM.requestPersistentStorage();
await ODM.isPersistentStorage();
```

---

## Notes

- **MIME type inference** — when `mimeType` is omitted from a registry entry, the downloader reads `Content-Type` from the HEAD probe (or GET response as a fallback) and strips any charset parameters. Falls back to `application/octet-stream` if the server returns nothing useful. The resolved type is stored as `Blob.type` and surfaced in `view()` / `getStatus()`.
- **Retry failed** — `failed` is a terminal status by design to avoid infinite retry loops on broken URLs. Pass `retryFailed: true` to `downloadFiles()` to explicitly re-queue failed entries when you're ready to try again.
- **Chunking threshold** — files over 5 MB are chunked in 2 MB Range requests. Both constants are in `downloader.js`.
- **Content-Encoding** — `Content-Length` is ignored for size tracking when the server applies `gzip`/`br` encoding, avoiding misleading progress numbers. Progress shows as indeterminate instead.
- **Storage safety margin** — 10% of quota is reserved before deferring downloads. Configurable in `storage.js`.
- **Blob in IDB** — the Blob is stored directly on the queue record, so there is only one IDB store to manage rather than a separate data store.