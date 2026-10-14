# Largefileupload

Resumable uploads of very large files (10 GB+) from an **Angular** client into **Azure Blob Storage**.
The API comes in two interchangeable versions with the same endpoints and JSON: **ASP.NET Core (.NET 10)** in
`server-dotnet/` and **Node.js/Express** in `server/`. Run either one on port 3000; the Angular client works with both.
If the connection drops at 49%, the upload continues from about 49%, even after a page reload or a browser crash.

```
Angular client                         Upload API (.NET or Node)              Azure Blob Storage
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

**server-dotnet/** (ASP.NET Core minimal API, .NET 10, `Azure.Storage.Blobs`)
- `LargeFileUpload.Api/Uploads/UploadEndpoints.cs`: the four endpoints: start/resume, status, complete, cancel
- `LargeFileUpload.Api/Storage/BlobStorage.cs`: clients, block IDs, SAS (account key **or** user-delegation SAS via Managed Identity)
- `LargeFileUpload.Api/Storage/SessionStore.cs`: session metadata stored as JSON blobs
- `LargeFileUpload.Api/appsettings*.json`: settings; the `Development` environment points at Azurite

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

### Option A: .NET API

Requires the .NET 10 SDK, plus Node.js 22.12+ for Azurite and the Angular client.

```bash
# terminal 1: Azure Storage emulator (keep it running), or use the Azurite VS Code extension
cd server
npm install
npm run azurite

# terminal 2: .NET API on http://localhost:3000 (Development settings point at Azurite)
cd server-dotnet/LargeFileUpload.Api
dotnet run

# terminal 3: Angular on http://localhost:4200
cd client
npm install
npm start
```

In Visual Studio, open `server-dotnet/LargeFileUpload.slnx` and press F5. The `http` profile uses port 3000.
The end-to-end test in `server/` works against either API: `cd server && npm run test:e2e`.

### Option B: Node API

The commands are the same in PowerShell, cmd and bash.

```bash
# one-time setup
cd server
npm install
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
                            # (defaults point at Azurite; .env is loaded automatically)

# terminal 1: Azure Storage emulator (keep it running)
cd server
npm run azurite

# terminal 2: API on http://localhost:3000
cd server
npm run dev                 # watch mode, or: npm start (builds to dist/ first, then runs)

# terminal 3: Angular on http://localhost:4200 (proxies /api to :3000)
cd client
npm install
npm start

# optional: backend end-to-end resume test (needs terminals 1 and 2)
cd server
npm run test:e2e
```

Check the API with `curl http://localhost:3000/healthz`, which returns `ok`. If startup fails with
"Could not reach Azure Storage", Azurite isn't running or `.env` is missing.

To try a drop by hand: start a big upload, then in Chrome DevTools open the Network tab and set throttling to **Offline**, then back to **No throttling**.

## Debugging

Open the repo root in VS Code, start Azurite (`npm run azurite` in `server/`), then open **Run and Debug**
(Ctrl+Shift+D), pick a configuration and press **F5**. Only run one API at a time, because both use port 3000.

| Configuration | Use it to |
|---|---|
| **Debug .NET API** | Build and run the .NET API under the debugger (needs the C# Dev Kit extension) |
| **Debug Node API** | Run the Node API under the debugger (loads `server/.env`, no build step) |
| **Debug E2E resume test** | Step through the drop-and-resume test; start one of the APIs first |
| **Debug .NET API + Angular** / **Debug Node API + Angular** | Debug the server and the Angular client (Chrome) together; run `npm start` in `client/` first |
| **Attach to API (port 9229)** | Attach to an API started with `npm run debug` in `server/` |

Good breakpoints in .NET: `StartAsync`, `GetUploadedBlocksAsync` (answers "which blocks does Azure already have?")
and `CompleteAsync` in `UploadEndpoints.cs`. In Node: the `uploadsRouter.post('/')`, `get('/:id')` and `post('/:id/complete')` handlers in
`server/src/routes/uploads.ts`, and `getUploadedBlocks()`, which answers "which blocks does Azure already have?".

## Production on Azure

- **Auth:** replace the demo `x-user-id` header with real token validation (e.g. Entra ID/MSAL) and use the user's `oid`.
  In .NET that's the middleware in `Program.cs` (use `AddMicrosoftIdentityWebApi`); in Node, `demoAuth` in `server/src/index.ts`.
- **Storage auth:** set `Storage__AccountUrl` (.NET) or `AZURE_STORAGE_ACCOUNT_URL` (Node) instead of a connection string. The API's Managed Identity needs the roles *Storage Blob Data Contributor* and *Storage Blob Delegator* (for user-delegation SAS). No account keys are needed.
- **CORS on the storage account:** allow your SPA origin, methods `PUT, OPTIONS`, allowed headers `content-md5, x-ms-*, content-type`. Set this in Bicep or Terraform, not with the API's startup CORS option.
- **Clean up** `upload-sessions` blobs with a lifecycle management rule (e.g. delete after 30 days).
- **Post-processing:** subscribe to the Event Grid `BlobCreated` event (fires on commit) for virus scanning, thumbnails and so on.
