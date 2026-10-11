import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { UploadSessionDto } from './upload.models';

export interface StartUploadRequest {
  fileName: string;
  fileSize: number;
  contentType: string;
  fingerprint: string;
}

/** Our backend: hands out sessions + SAS URLs, reports progress, commits. No file bytes go through it. */
@Injectable({ providedIn: 'root' })
export class UploadApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/api/uploads';

  /** Creates a session, or returns the existing one if this file was started before. */
  start(req: StartUploadRequest): Promise<UploadSessionDto> {
    return firstValueFrom(this.http.post<UploadSessionDto>(this.baseUrl, req));
  }

  /** Which blocks does Azure already have? Also returns a fresh SAS. */
  status(uploadId: string): Promise<UploadSessionDto> {
    return firstValueFrom(this.http.get<UploadSessionDto>(`${this.baseUrl}/${uploadId}`));
  }

  complete(uploadId: string): Promise<UploadSessionDto> {
    return firstValueFrom(this.http.post<UploadSessionDto>(`${this.baseUrl}/${uploadId}/complete`, {}));
  }

  cancel(uploadId: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`${this.baseUrl}/${uploadId}`));
  }
}

/** Status 0 means the request never reached the server (offline, DNS, connection reset). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof HttpErrorResponse && (err.status === 0 || err.status >= 502);
}
