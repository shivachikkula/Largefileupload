/**
 * Remembers unfinished uploads in IndexedDB so that after a refresh/crash the
 * UI can say "big.mp4 is 49% uploaded, select it again to resume".
 *
 * Only a hint for the UI: the server (Azure's block list) is always asked what
 * actually arrived before resuming. Every call tolerates IndexedDB being unavailable.
 */
export interface PendingUpload {
  fingerprint: string;
  uploadId: string;
  fileName: string;
  fileSize: number;
  uploadedBytes: number;
  updatedAt: number;
}

const DB_NAME = 'resumable-uploads';
const STORE = 'pending';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'fingerprint' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  try {
    const db = await openDb();
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    }).finally(() => db.close());
  } catch {
    return undefined; // private mode / storage blocked: resume still works by re-selecting the file
  }
}

export const resumeStore = {
  save: (upload: PendingUpload) => run<void>('readwrite', (s) => s.put(upload)),
  remove: (fingerprint: string) => run<void>('readwrite', (s) => s.delete(fingerprint)),
  async list(): Promise<PendingUpload[]> {
    return (await run<PendingUpload[]>('readonly', (s) => s.getAll())) ?? [];
  },
};
