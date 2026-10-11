import { Injectable, OnDestroy } from '@angular/core';
import type { Md5Request, Md5Response } from './md5.worker';

@Injectable({ providedIn: 'root' })
export class Md5Service implements OnDestroy {
  private readonly worker = new Worker(new URL('./md5.worker', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve: (md5: string) => void; reject: (err: Error) => void }>();
  private nextId = 0;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<Md5Response>) => {
      const request = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.md5) request?.resolve(data.md5);
      else request?.reject(new Error(data.error ?? 'MD5 failed'));
    };
  }

  /** Base64-encoded MD5 of the blob, as Azure expects in the Content-MD5 header. */
  md5(blob: Blob): Promise<string> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, blob } satisfies Md5Request);
    });
  }

  ngOnDestroy(): void {
    this.worker.terminate();
  }
}
