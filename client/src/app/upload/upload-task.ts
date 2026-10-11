import { HttpErrorResponse } from '@angular/common/http';
import { computed, signal } from '@angular/core';
import { BlockUploadError, putBlock } from './azure-block.client';
import { fileFingerprint } from './fingerprint';
import { Md5Service } from './md5.service';
import { resumeStore } from './resume-store';
import { UploadApiService, isNetworkError } from './upload-api.service';
import { UploadSessionDto, UploadStatus, blockIdFor } from './upload.models';

export interface UploadTaskOptions {
  /** Blocks uploaded in parallel. 4 keeps a fast link busy without hogging it. */
  concurrency: number;
  /** Retries per block for 5xx/429/expired SAS before giving up on the batch. */
  maxBlockRetries: number;
}

type StopReason = 'pause' | 'cancel';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Exponential backoff with full jitter: 1s, 2s, 4s ... capped at 30s. */
const backoff = (attempt: number) => Math.random() * Math.min(30_000, 1000 * 2 ** attempt);

/**
 * One file's resumable upload.
 *
 *   preparing ─▶ uploading ─▶ completing ─▶ completed
 *                  │  ▲
 *        offline ◀─┘  └─ network back: ask the server which blocks it has,
 *                         upload only the missing ones
 *
 * The server's block list is the single source of truth. After any interruption
 * we re-ask it rather than trusting local counters, because a block can land in
 * Azure even though its response was lost.
 */
export class UploadTask {
  readonly status = signal<UploadStatus>('preparing');
  readonly uploadedBytes = signal(0);
  readonly bytesPerSecond = signal(0);
  readonly error = signal<string | undefined>(undefined);
  /** Set when the server already had part of this file (resume after refresh/crash). */
  readonly resumedFromBytes = signal<number | undefined>(undefined);
  readonly progress = computed(() => (this.file.size ? this.uploadedBytes() / this.file.size : 0));

  private session?: UploadSessionDto;
  private fingerprint?: string;
  private stopReason?: StopReason;
  private batch?: AbortController;
  private waitForNetworkCtrl?: AbortController;
  private sasRefresh?: Promise<void>;
  private runPromise: Promise<void> = Promise.resolve();
  private persistChain: Promise<void> = Promise.resolve();

  private confirmedBytes = 0;
  private readonly inFlightBytes = new Map<number, number>();
  private speedSample = { at: 0, bytes: 0 };

  constructor(
    readonly file: File,
    private readonly api: UploadApiService,
    private readonly md5: Md5Service,
    private readonly options: UploadTaskOptions,
  ) {}

  get uploadId(): string | undefined {
    return this.session?.uploadId;
  }

  get isActive(): boolean {
    return ['preparing', 'uploading', 'offline', 'completing'].includes(this.status());
  }

  start(): void {
    this.stopReason = undefined;
    // Chain so a resume never overlaps a run that is still winding down after pause.
    this.runPromise = this.runPromise.then(() => this.run());
  }

  pause(): void {
    if (!this.isActive || this.status() === 'completing') return;
    this.stop('pause');
    this.status.set('paused');
    this.bytesPerSecond.set(0);
  }

  resume(): void {
    if (this.status() === 'paused' || this.status() === 'error') this.start();
  }

  async cancel(): Promise<void> {
    if (this.status() === 'completed' || this.status() === 'cancelled') return;
    this.stop('cancel');
    this.status.set('cancelled');
    this.bytesPerSecond.set(0);
    await this.runPromise;
    if (this.session) await this.api.cancel(this.session.uploadId).catch(() => undefined);
    await this.forget();
  }

  /** Browser says the connection is gone: drop in-flight requests now instead of waiting for TCP timeouts. */
  onBrowserOffline(): void {
    if (this.status() === 'uploading') this.batch?.abort('offline');
  }

  /** Browser says we're back: stop waiting out the backoff and resume immediately. */
  onBrowserOnline(): void {
    this.waitForNetworkCtrl?.abort();
  }

  private stop(reason: StopReason): void {
    this.stopReason = reason;
    this.batch?.abort(reason);
    this.waitForNetworkCtrl?.abort();
  }

  private async run(): Promise<void> {
    if (this.stopReason) return;
    this.error.set(undefined);
    let networkAttempt = 0;

    while (!this.stopReason) {
      try {
        if (!this.session) {
          await this.createOrResumeSession();
        } else {
          // Every (re)start begins with "server, what do you have?"
          this.status.set('preparing');
          this.applyServerState(await this.api.status(this.session.uploadId));
        }
        if (this.stopReason) return;

        if (this.session!.status === 'completed') return await this.finish();
        if (this.session!.status !== 'uploading') throw new Error(`Upload is ${this.session!.status}`);

        this.status.set('uploading');
        await this.uploadMissingBlocks();

        this.status.set('completing');
        this.applyServerState(await this.api.complete(this.session!.uploadId));
        return await this.finish();
      } catch (err) {
        if (this.stopReason) return;

        if (this.isConnectivityProblem(err)) {
          this.status.set('offline');
          this.bytesPerSecond.set(0);
          await this.waitForNetwork(networkAttempt++);
          continue; // loop back: refresh state from the server, then carry on
        }
        if (err instanceof HttpErrorResponse && err.status === 409) {
          continue; // e.g. "missing blocks" on complete: re-sync and upload them
        }

        console.error('Upload failed', err);
        this.status.set('error');
        this.bytesPerSecond.set(0);
        this.error.set(this.describe(err));
        return;
      }
    }
  }

  private async createOrResumeSession(): Promise<void> {
    this.status.set('preparing');
    this.fingerprint ??= await fileFingerprint(this.file);
    const session = await this.api.start({
      fileName: this.file.name,
      fileSize: this.file.size,
      contentType: this.file.type || 'application/octet-stream',
      fingerprint: this.fingerprint,
    });
    if (session.resumed && session.uploadedBytes > 0) this.resumedFromBytes.set(session.uploadedBytes);
    this.applyServerState(session);
  }

  private applyServerState(session: UploadSessionDto): void {
    this.session = session;
    this.confirmedBytes = session.uploadedBytes;
    this.inFlightBytes.clear();
    this.updateProgress();
    void this.persist();
  }

  private async uploadMissingBlocks(): Promise<void> {
    const session = this.session!;
    const have = new Set(session.uploadedBlocks);
    const queue = [...Array(session.totalBlocks).keys()].filter((i) => !have.has(i));

    const batch = (this.batch = new AbortController());
    this.speedSample = { at: performance.now(), bytes: this.uploadedBytes() };

    const worker = async () => {
      for (let index = queue.shift(); index !== undefined; index = queue.shift()) {
        await this.uploadBlock(index, batch.signal);
      }
    };

    try {
      await Promise.all(Array.from({ length: this.options.concurrency }, worker));
    } catch (err) {
      batch.abort(batch.signal.reason ?? 'failed'); // one failure stops the siblings too
      if (batch.signal.reason === 'offline') throw new BlockUploadError('network', 'Browser went offline');
      throw err;
    }
  }

  private async uploadBlock(index: number, signal: AbortSignal): Promise<void> {
    const { blockSize } = this.session!;
    const start = index * blockSize;
    const block = this.file.slice(start, Math.min(start + blockSize, this.file.size)); // a view, not a copy
    const md5 = await this.md5.md5(block);

    for (let attempt = 0; ; attempt++) {
      try {
        await this.ensureFreshSas();
        await putBlock(this.session!.sasUrl!, blockIdFor(index), block, {
          md5,
          signal,
          onProgress: (loaded) => {
            this.inFlightBytes.set(index, loaded);
            this.updateProgress();
          },
        });
        this.inFlightBytes.delete(index);
        this.confirmedBytes += block.size;
        this.updateProgress();
        void this.persist();
        return;
      } catch (err) {
        this.inFlightBytes.delete(index); // whatever was sent of this block is lost; it is resent whole
        this.updateProgress();
        if (!(err instanceof BlockUploadError) || attempt >= this.options.maxBlockRetries) throw err;

        if (err.kind === 'sas-expired') {
          await this.refreshSas();
        } else if (err.kind === 'transient' || (err.kind === 'fatal' && err.status === 400 && attempt === 0)) {
          await sleep(backoff(attempt), signal); // 400 once: may be a corrupted transfer (Content-MD5 mismatch)
        } else {
          throw err; // network → whole batch goes to "offline"; aborted/fatal → stop
        }
        if (signal.aborted) throw new BlockUploadError('aborted', 'Aborted');
      }
    }
  }

  private async ensureFreshSas(): Promise<void> {
    const expires = this.session?.sasExpiresOn ? Date.parse(this.session.sasExpiresOn) : 0;
    if (expires - Date.now() < 2 * 60_000) await this.refreshSas();
  }

  /** Single-flight: four workers hitting an expired SAS cause one API call, not four. */
  private refreshSas(): Promise<void> {
    this.sasRefresh ??= this.api
      .status(this.session!.uploadId)
      .then((fresh) => {
        this.session = { ...this.session!, sasUrl: fresh.sasUrl, sasExpiresOn: fresh.sasExpiresOn };
      })
      .finally(() => (this.sasRefresh = undefined));
    return this.sasRefresh;
  }

  /** Wait with backoff, but wake immediately on the browser's "online" event (or pause/cancel). */
  private async waitForNetwork(attempt: number): Promise<void> {
    this.waitForNetworkCtrl = new AbortController();
    await sleep(Math.max(1000, backoff(attempt)), this.waitForNetworkCtrl.signal);
    while (!navigator.onLine && !this.stopReason) {
      this.waitForNetworkCtrl = new AbortController();
      await sleep(30_000, this.waitForNetworkCtrl.signal);
    }
  }

  private isConnectivityProblem(err: unknown): boolean {
    if (err instanceof BlockUploadError) return err.kind === 'network' || err.kind === 'transient';
    return isNetworkError(err) || !navigator.onLine;
  }

  private updateProgress(): void {
    let inFlight = 0;
    for (const bytes of this.inFlightBytes.values()) inFlight += bytes;
    const total = Math.min(this.file.size, this.confirmedBytes + inFlight);
    this.uploadedBytes.set(total);

    const now = performance.now();
    const elapsed = now - this.speedSample.at;
    if (elapsed >= 1000) {
      const current = ((total - this.speedSample.bytes) * 1000) / elapsed;
      this.bytesPerSecond.set(Math.max(0, this.bytesPerSecond() * 0.7 + current * 0.3));
      this.speedSample = { at: now, bytes: total };
    }
  }

  /** Writes are chained so a late progress save can't re-create the entry after it was removed. */
  private persist(): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      if (!this.fingerprint || !this.session || ['completed', 'cancelled'].includes(this.status())) return;
      await resumeStore.save({
        fingerprint: this.fingerprint,
        uploadId: this.session.uploadId,
        fileName: this.file.name,
        fileSize: this.file.size,
        uploadedBytes: this.confirmedBytes,
        updatedAt: Date.now(),
      });
    });
    return this.persistChain;
  }

  private forget(): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      if (this.fingerprint) await resumeStore.remove(this.fingerprint);
    });
    return this.persistChain;
  }

  private async finish(): Promise<void> {
    this.confirmedBytes = this.file.size;
    this.inFlightBytes.clear();
    this.uploadedBytes.set(this.file.size);
    this.bytesPerSecond.set(0);
    this.status.set('completed');
    await this.forget();
  }

  private describe(err: unknown): string {
    if (err instanceof HttpErrorResponse) return err.error?.error ?? err.message;
    return err instanceof Error ? err.message : String(err);
  }
}
