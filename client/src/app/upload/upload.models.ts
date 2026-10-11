/** What the API returns for an upload session (POST /api/uploads, GET /api/uploads/:id). */
export interface UploadSessionDto {
  uploadId: string;
  fileName: string;
  fileSize: number;
  blockSize: number;
  totalBlocks: number;
  status: 'uploading' | 'committing' | 'completed' | 'aborted';
  expiresAt: string;
  /** Block indexes Azure already holds: the server's answer to "where was I?" */
  uploadedBlocks: number[];
  uploadedBytes: number;
  /** Write-only SAS for this one blob; absent once the upload is no longer in progress. */
  sasUrl?: string;
  sasExpiresOn?: string;
  resumed?: boolean;
}

export type UploadStatus =
  | 'preparing'
  | 'uploading'
  | 'offline'
  | 'paused'
  | 'completing'
  | 'completed'
  | 'cancelled'
  | 'error';

/** Must match the server's blockIdFor(): same-length base64 IDs, ordered by index. */
export function blockIdFor(index: number): string {
  return btoa(`block-${index.toString().padStart(6, '0')}`);
}
