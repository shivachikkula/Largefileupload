import { createHash } from 'node:crypto';
import { RestError } from '@azure/storage-blob';
import { sessionContainer } from './azure.js';

export type UploadStatus = 'uploading' | 'committing' | 'completed' | 'aborted';

export interface UploadSession {
  id: string;
  userId: string;
  fingerprint: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  blockSize: number;
  totalBlocks: number;
  blobName: string;
  status: UploadStatus;
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
}

export interface StoredSession {
  session: UploadSession;
  etag: string;
}

/** Thrown when another request changed the session first (optimistic concurrency). */
export class ConcurrencyError extends Error {}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sessionPath = (id: string) => `sessions/${id}.json`;
const indexPath = (userId: string, fingerprint: string) =>
  `by-fingerprint/${sha256(userId)}/${sha256(fingerprint)}.json`;

function isStatus(err: unknown, ...codes: number[]): boolean {
  return err instanceof RestError && codes.includes(err.statusCode ?? 0);
}

async function readJson<T>(path: string): Promise<{ value: T; etag: string } | undefined> {
  try {
    const blob = sessionContainer.getBlockBlobClient(path);
    const buffer = await blob.downloadToBuffer();
    const props = await blob.getProperties();
    return { value: JSON.parse(buffer.toString('utf8')) as T, etag: props.etag! };
  } catch (err) {
    if (isStatus(err, 404)) return undefined;
    throw err;
  }
}

async function writeJson(
  path: string,
  value: unknown,
  conditions: { ifMatch?: string; ifNoneMatch?: string } = {},
): Promise<string> {
  const body = JSON.stringify(value);
  try {
    const res = await sessionContainer.getBlockBlobClient(path).upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: 'application/json' },
      conditions,
    });
    return res.etag!;
  } catch (err) {
    if (isStatus(err, 409, 412)) throw new ConcurrencyError(`Session blob ${path} changed concurrently`);
    throw err;
  }
}

/**
 * Upload session metadata kept as small JSON blobs next to the data, so the API
 * stays stateless and needs no database. Swap for Cosmos DB / SQL if you prefer;
 * the routes only depend on this module's functions.
 */
export const sessionStore = {
  async get(id: string): Promise<StoredSession | undefined> {
    const found = await readJson<UploadSession>(sessionPath(id));
    return found && { session: found.value, etag: found.etag };
  },

  async create(session: UploadSession): Promise<StoredSession> {
    const etag = await writeJson(sessionPath(session.id), session, { ifNoneMatch: '*' });
    await writeJson(indexPath(session.userId, session.fingerprint), { uploadId: session.id });
    return { session, etag };
  },

  /** Conditional write: fails with ConcurrencyError if the session changed since it was read. */
  async update(session: UploadSession, etag: string): Promise<StoredSession> {
    const newEtag = await writeJson(sessionPath(session.id), session, { ifMatch: etag });
    return { session, etag: newEtag };
  },

  /** Lets a user who re-selects the same file after a crash/refresh continue the old session. */
  async findResumable(userId: string, fingerprint: string): Promise<StoredSession | undefined> {
    const index = await readJson<{ uploadId: string }>(indexPath(userId, fingerprint));
    if (!index) return undefined;
    const stored = await this.get(index.value.uploadId);
    if (!stored || stored.session.status !== 'uploading') return undefined;
    if (new Date(stored.session.expiresAt).getTime() <= Date.now()) return undefined;
    return stored;
  },

  async forgetFingerprint(userId: string, fingerprint: string): Promise<void> {
    await sessionContainer.getBlockBlobClient(indexPath(userId, fingerprint)).deleteIfExists();
  },
};
