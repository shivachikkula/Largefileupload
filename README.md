# Largefileupload

Resumable uploads of very large files (10 GB+) from an **Angular** client into **Azure Blob Storage**.
If the connection drops at 49%, the upload continues from about 49%, even after a page reload or a browser crash.

```
Angular client                         Upload API (Node/Express)              Azure Blob Storage
──────────────                         ─────────────────────────              ──────────────────
1. POST /api/uploads ────────────────▶ create/find session ─────────────────▶ (metadata JSON blob)
   ◀── uploadId, blockSize, write-only SAS, uploadedBlocks[]
2. PUT ?comp=block&blockid=… ─────────────────────────────────────────────────▶ Put Block (staged, uncommitted)
   (4 in parallel, Content-MD5, straight to Azure: no file bytes pass through the API)
   ✖ network drops: in-flight blocks are aborted, task shows "offline", waits for network
3. GET /api/uploads/:id ─────────────▶ Get Block List (uncommitted) ────────▶ "which blocks do you have?"
   ◀── uploadedBlocks[0..313], fresh SAS
4. PUT only the missing blocks ───────────────────────────────────────────────▶ Put Block
5. POST /api/uploads/:id/complete ───▶ verify all blocks + sizes, Put Block List ▶ blob assembled in order
```

## How the resume works

| Concern | Implementation |
|---|---|
| Split the file | `file.slice()`: a view over the file on disk, so 10 GB is never held in memory. Block size is at least 8 MiB, grown as needed to stay under Azure's 50,000-block limit. |
| Where did I stop? | **Azure is the source of truth.** Each successful `Put Block` is an *uncommitted block*. `Get Block List?blocklisttype=uncommitted` returns exactly what arrived. A block is staged atomically, so a half-sent block simply isn't there. |
| Safe retries | Block IDs are deterministic (`base64("block-000314")`). Re-sending a block overwrites it, and `complete` is idempotent. |
| Integrity | `Content-MD5` on every block (computed in a Web Worker); Azure rejects corrupted blocks with 400. On commit the server checks that the final blob size equals the file size. |
| Connection drop | `offline` event or network error: abort in-flight requests (at most 4 × 8 MB of work is lost) and wait. On the `online` event, or after exponential backoff with jitter, ask the server again and upload the missing blocks. A stall timer catches dead connections that never raise an error. |
| Expired SAS | SAS tokens are short-lived (30 min) and write-only for one blob. A 403, or a token close to expiry, triggers a single-flight refresh. |
| Page refresh / crash | The client fingerprints the file: SHA-256 of name, size, lastModified, and the first and last MiB. `POST /api/uploads` with the same fingerprint returns the existing session. IndexedDB remembers unfinished uploads, so the UI can say "select this file again". |
| Cancel / abandon | `DELETE` commits an empty block list, which makes Azure discard the staged blocks immediately, then deletes the blob. Abandoned uncommitted blocks are garbage-collected by Azure after 7 days, which matches the session TTL. |
| Concurrency | Session updates use ETag preconditions, so two `complete` calls can't both commit. |

## Code map

**server/** (Node 22, Express 5, `@azure/storage-blob`)
- `src/routes/uploads.ts`: the four endpoints: start/resume, status, complete, cancel
- `src/azure.ts`: clients, block IDs, SAS (account key **or** user-delegation SAS via Managed Identity)
- `src/sessionStore.ts`: session metadata stored as JSON blobs (swap in Cosmos DB or SQL if preferred)
- `scripts/e2e-resume.ts`: end-to-end test: drop at 49%, resume, MD5 rejection, complete, SHA-256 check, cancel

**client/** (Angular 21, standalone, zoneless, signals)
- `src/app/upload/upload-task.ts`: the resumable upload state machine (pool, retries, offline, resume)
- `src/app/upload/azure-block.client.ts`: `Put Block` via XHR with progress and stall detection
- `src/app/upload/upload-api.service.ts`, `fingerprint.ts`, `resume-store.ts` (IndexedDB), `md5.worker.ts`
- `src/app/upload/upload-card.component.ts`, `src/app/app.ts`: UI

## Run locally (Azurite emulator)

```bash
# terminal 1: Azure Storage emulator
cd server && npm install && npm run azurite

# terminal 2: API
cd server && cp .env.example .env
AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true CONFIGURE_STORAGE_CORS=true npm run dev

# terminal 3: Angular (proxies /api to :3000)
cd client && npm install && npm start      # http://localhost:4200

# optional: backend end-to-end resume test
cd server && AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true npm run test:e2e
```

To try a drop by hand: start a big upload, then in Chrome DevTools open the Network tab and set throttling to **Offline**, then back to **No throttling**.

## Production on Azure

- **Auth:** replace `demoAuth` in `server/src/index.ts` with real token validation (e.g. Entra ID/MSAL) and use the user's `oid`.
- **Storage auth:** set `AZURE_STORAGE_ACCOUNT_URL` instead of a connection string. The API's Managed Identity needs the roles *Storage Blob Data Contributor* and *Storage Blob Delegator* (for user-delegation SAS). No account keys are needed.
- **CORS on the storage account:** allow your SPA origin, methods `PUT, OPTIONS`, allowed headers `content-md5, x-ms-*, content-type`. Set this in Bicep or Terraform, not with `CONFIGURE_STORAGE_CORS`.
- **Clean up** `upload-sessions` blobs with a lifecycle management rule (e.g. delete after 30 days).
- **Post-processing:** subscribe to the Event Grid `BlobCreated` event (fires on commit) for virus scanning, thumbnails and so on.
