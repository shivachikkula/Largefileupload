import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { RestError } from '@azure/storage-blob';
import { blockIdFor, blockIndexFor, createUploadSas, uploadContainer } from '../azure.js';
import { config } from '../config.js';
import { ConcurrencyError, sessionStore, type UploadSession } from '../sessionStore.js';

export const uploadsRouter = Router();

const MiB = 1024 * 1024;

class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

/** Large enough to stay under Azure's 50,000-block limit, rounded to whole MiB. */
function chooseBlockSize(fileSize: number): number {
  const needed = Math.ceil(fileSize / config.maxBlocks);
  return Math.max(config.minBlockSize, Math.ceil(needed / MiB) * MiB);
}

function expectedBlockSize(session: UploadSession, index: number): number {
  const isLast = index === session.totalBlocks - 1;
  return isLast ? session.fileSize - index * session.blockSize : session.blockSize;
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.\- ]/g, '_').slice(0, 200) || 'file';
}

/**
 * Azure is the source of truth for what has arrived: every successful Put Block
 * shows up as an uncommitted block. A block is staged atomically, so a request
 * cut off mid-way leaves nothing behind and the block is simply missing.
 */
async function getUploadedBlocks(session: UploadSession): Promise<number[]> {
  if (session.status === 'completed') return [...Array(session.totalBlocks).keys()];
  try {
    const list = await uploadContainer.getBlockBlobClient(session.blobName).getBlockList('uncommitted');
    const uploaded = new Set<number>();
    for (const block of list.uncommittedBlocks ?? []) {
      const index = blockIndexFor(block.name);
      if (index !== undefined && index < session.totalBlocks && block.size === expectedBlockSize(session, index)) {
        uploaded.add(index);
      }
    }
    return [...uploaded].sort((a, b) => a - b);
  } catch (err) {
    // No block has been staged yet, so the blob doesn't exist.
    if (err instanceof RestError && err.statusCode === 404) return [];
    throw err;
  }
}

async function toResponse(session: UploadSession) {
  const uploadedBlocks = await getUploadedBlocks(session);
  const sas = session.status === 'uploading' ? await createUploadSas(session.blobName) : undefined;
  return {
    uploadId: session.id,
    fileName: session.fileName,
    fileSize: session.fileSize,
    blockSize: session.blockSize,
    totalBlocks: session.totalBlocks,
    status: session.status,
    expiresAt: session.expiresAt,
    uploadedBlocks,
    uploadedBytes: uploadedBlocks.reduce((sum, i) => sum + expectedBlockSize(session, i), 0),
    sasUrl: sas?.url,
    sasExpiresOn: sas?.expiresOn.toISOString(),
  };
}

async function loadOwnedSession(req: Request) {
  const stored = await sessionStore.get(String(req.params.id));
  // 404 (not 403) for other users' sessions so IDs can't be probed.
  if (!stored || stored.session.userId !== req.userId) throw new HttpError(404, 'Upload not found');
  return stored;
}

/**
 * POST /api/uploads
 * Starts an upload, or returns the existing session when the same user picks the
 * same file again (same fingerprint). That's how a refresh or crash resumes.
 */
uploadsRouter.post('/', async (req: Request, res: Response) => {
  const { fileName, fileSize, contentType, fingerprint } = req.body ?? {};
  if (typeof fileName !== 'string' || !fileName.trim()) throw new HttpError(400, 'fileName is required');
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new HttpError(400, 'fileSize must be a positive integer');
  if (fileSize > config.maxFileSize) throw new HttpError(413, `File exceeds ${config.maxFileSize} bytes`);
  if (typeof fingerprint !== 'string' || fingerprint.length < 16 || fingerprint.length > 256) {
    throw new HttpError(400, 'fingerprint is required');
  }

  const existing = await sessionStore.findResumable(req.userId, fingerprint);
  if (existing && existing.session.fileSize === fileSize) {
    res.status(200).json({ ...(await toResponse(existing.session)), resumed: true });
    return;
  }

  const id = randomUUID();
  const blockSize = chooseBlockSize(fileSize);
  const now = new Date();
  const session: UploadSession = {
    id,
    userId: req.userId,
    fingerprint,
    fileName,
    fileSize,
    contentType: typeof contentType === 'string' && contentType ? contentType : 'application/octet-stream',
    blockSize,
    totalBlocks: Math.ceil(fileSize / blockSize),
    blobName: `${encodeURIComponent(req.userId)}/${id}/${safeFileName(fileName)}`,
    status: 'uploading',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.sessionTtlDays * 24 * 60 * 60 * 1000).toISOString(),
  };
  await sessionStore.create(session);
  res.status(201).json({ ...(await toResponse(session)), resumed: false });
});

/**
 * GET /api/uploads/:id
 * The resume call: which blocks does the server already have? Also hands out a
 * fresh SAS, since the old one may have expired while the user was offline.
 */
uploadsRouter.get('/:id', async (req: Request, res: Response) => {
  const { session } = await loadOwnedSession(req);
  res.json(await toResponse(session));
});

/**
 * POST /api/uploads/:id/complete
 * Checks every block is present with the right size, then commits the block list,
 * which assembles the final blob in order.
 */
uploadsRouter.post('/:id/complete', async (req: Request, res: Response) => {
  let { session, etag } = await loadOwnedSession(req);
  if (session.status === 'completed') {
    res.json(await toResponse(session)); // idempotent: a retried "complete" is fine
    return;
  }
  if (session.status !== 'uploading') throw new HttpError(409, `Upload is ${session.status}`);

  const uploaded = new Set(await getUploadedBlocks(session));
  const missing = [...Array(session.totalBlocks).keys()].filter((i) => !uploaded.has(i));
  if (missing.length > 0) {
    throw new HttpError(409, 'Upload is missing blocks', { missingBlocks: missing.slice(0, 1000), missingCount: missing.length });
  }

  // Claim the session so two concurrent "complete" calls can't both commit.
  ({ session, etag } = await sessionStore.update({ ...session, status: 'committing' }, etag));

  try {
    const blob = uploadContainer.getBlockBlobClient(session.blobName);
    const blockIds = [...Array(session.totalBlocks).keys()].map(blockIdFor);
    await blob.commitBlockList(blockIds, {
      blobHTTPHeaders: { blobContentType: session.contentType },
      metadata: { uploadid: session.id, originalname: encodeURIComponent(session.fileName) },
    });
    const props = await blob.getProperties();
    if (props.contentLength !== session.fileSize) {
      throw new Error(`Committed size ${props.contentLength} != expected ${session.fileSize}`);
    }
  } catch (err) {
    await sessionStore.update({ ...session, status: 'uploading' }, etag);
    throw err;
  }

  ({ session } = await sessionStore.update(
    { ...session, status: 'completed', completedAt: new Date().toISOString() },
    etag,
  ));
  await sessionStore.forgetFingerprint(session.userId, session.fingerprint);
  res.json(await toResponse(session));
});

/**
 * DELETE /api/uploads/:id
 * Cancels the upload. Committing an empty block list makes Azure discard every
 * uncommitted block right away; then the empty blob is deleted.
 */
uploadsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { session, etag } = await loadOwnedSession(req);
  if (session.status === 'completed') throw new HttpError(409, 'Upload already completed');
  if (session.status === 'aborted') {
    res.status(204).end();
    return;
  }

  await sessionStore.update({ ...session, status: 'aborted' }, etag);
  const blob = uploadContainer.getBlockBlobClient(session.blobName);
  await blob.commitBlockList([]);
  await blob.deleteIfExists();
  await sessionStore.forgetFingerprint(session.userId, session.fingerprint);
  res.status(204).end();
});

export function errorHandler(err: unknown, _req: Request, res: Response, _next: unknown) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    return;
  }
  if (err instanceof ConcurrencyError) {
    res.status(409).json({ error: 'Upload was modified by another request; retry' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
