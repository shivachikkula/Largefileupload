import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Md5Service } from './md5.service';
import { PendingUpload, resumeStore } from './resume-store';
import { UploadApiService } from './upload-api.service';
import { UploadTask } from './upload-task';

@Injectable({ providedIn: 'root' })
export class UploadService {
  private readonly api = inject(UploadApiService);
  private readonly md5 = inject(Md5Service);

  readonly tasks = signal<UploadTask[]>([]);
  /** Unfinished uploads from earlier visits (IndexedDB), shown so the user knows to re-pick the file. */
  readonly pendingFromLastVisit = signal<PendingUpload[]>([]);

  constructor() {
    const onOffline = () => this.tasks().forEach((t) => t.onBrowserOffline());
    const onOnline = () => this.tasks().forEach((t) => t.onBrowserOnline());
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (this.tasks().some((t) => t.isActive)) e.preventDefault(); // "Leave site?" prompt
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    window.addEventListener('beforeunload', onBeforeUnload);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('beforeunload', onBeforeUnload);
    });

    void this.refreshPending();
  }

  /**
   * Re-selecting a file that was half-uploaded before a refresh needs nothing
   * special here: the server matches its fingerprint and returns the old session.
   */
  add(files: Iterable<File>): void {
    for (const file of files) {
      if (file.size === 0) continue;
      const task = new UploadTask(file, this.api, this.md5, { concurrency: 4, maxBlockRetries: 5 });
      this.tasks.update((tasks) => [task, ...tasks]);
      task.start();
    }
    // Hide "unfinished" entries once the matching file is being uploaded again.
    const names = new Set([...files].map((f) => `${f.name}|${f.size}`));
    this.pendingFromLastVisit.update((list) => list.filter((p) => !names.has(`${p.fileName}|${p.fileSize}`)));
  }

  async cancel(task: UploadTask): Promise<void> {
    await task.cancel();
    this.tasks.update((tasks) => tasks.filter((t) => t !== task));
  }

  async discardPending(pending: PendingUpload): Promise<void> {
    await this.api.cancel(pending.uploadId).catch(() => undefined);
    await resumeStore.remove(pending.fingerprint);
    await this.refreshPending();
  }

  private async refreshPending(): Promise<void> {
    this.pendingFromLastVisit.set(await resumeStore.list());
  }
}
