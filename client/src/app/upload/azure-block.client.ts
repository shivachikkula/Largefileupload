/** Why a Put Block failed decides what the uploader does next. */
export type BlockErrorKind =
  | 'network' // connection dropped, timed out or stalled: wait for the network, then resume
  | 'sas-expired' // 403: get a fresh SAS from our API and retry
  | 'transient' // 408/429/5xx: back off and retry
  | 'aborted' // we cancelled it (pause / offline / cancel)
  | 'fatal'; // anything else, e.g. 400 MD5 mismatch that keeps happening

export class BlockUploadError extends Error {
  constructor(public readonly kind: BlockErrorKind, message: string, public readonly status = 0) {
    super(message);
  }
}

export interface PutBlockOptions {
  md5: string;
  signal: AbortSignal;
  onProgress: (loadedBytes: number) => void;
  /** Abort if no bytes move for this long; a dead connection often never errors on its own. */
  stallTimeoutMs?: number;
}

/**
 * Stages one block straight into Azure Blob Storage ("Put Block") using the SAS.
 * Uses XMLHttpRequest rather than HttpClient so app interceptors (auth headers etc.)
 * never leak to Azure, and so upload progress events are available.
 */
export function putBlock(sasUrl: string, blockId: string, block: Blob, opts: PutBlockOptions): Promise<void> {
  const url = `${sasUrl}&comp=block&blockid=${encodeURIComponent(blockId)}`;
  const stallTimeoutMs = opts.stallTimeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(new BlockUploadError('aborted', 'Aborted'));
      return;
    }

    const xhr = new XMLHttpRequest();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;

    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, stallTimeoutMs);
    };
    const cleanup = () => {
      clearTimeout(stallTimer);
      opts.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => xhr.abort();
    opts.signal.addEventListener('abort', onAbort);

    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-MD5', opts.md5);
    xhr.upload.onprogress = (e) => {
      armStallTimer();
      opts.onProgress(e.loaded);
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status === 201) {
        opts.onProgress(block.size);
        resolve();
        return;
      }
      const status = xhr.status;
      const kind: BlockErrorKind =
        status === 403 ? 'sas-expired' : status === 408 || status === 429 || status >= 500 ? 'transient' : 'fatal';
      reject(new BlockUploadError(kind, `Put Block failed with ${status}: ${xhr.responseText.slice(0, 300)}`, status));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new BlockUploadError('network', 'Network error'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(
        stalled
          ? new BlockUploadError('network', `No progress for ${stallTimeoutMs / 1000}s`)
          : new BlockUploadError('aborted', 'Aborted'),
      );
    };

    armStallTimer();
    xhr.send(block); // the browser streams the Blob from disk; it is never fully loaded into memory
  });
}
