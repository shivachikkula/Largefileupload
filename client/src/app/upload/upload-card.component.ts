import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { formatBytes, formatDuration } from './format';
import { UploadService } from './upload.service';
import { UploadTask } from './upload-task';

const STATUS_LABEL: Record<string, string> = {
  preparing: 'Checking with server…',
  uploading: 'Uploading',
  offline: 'Connection lost. Will resume automatically.',
  paused: 'Paused',
  completing: 'Finalizing…',
  completed: 'Completed',
  cancelled: 'Cancelled',
  error: 'Failed',
};

@Component({
  selector: 'app-upload-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let t = task();
    <article class="card" [attr.data-status]="t.status()">
      <header>
        <strong class="name" [title]="t.file.name">{{ t.file.name }}</strong>
        <span class="badge">{{ statusLabel() }}</span>
      </header>

      <div class="bar" role="progressbar" [attr.aria-valuenow]="percent()" aria-valuemin="0" aria-valuemax="100">
        <div class="fill" [style.width.%]="percent()"></div>
      </div>

      <p class="meta">
        <span>{{ percent() }}% · {{ fmt(t.uploadedBytes()) }} of {{ fmt(t.file.size) }}</span>
        @if (t.status() === 'uploading' && t.bytesPerSecond() > 0) {
          <span>{{ fmt(t.bytesPerSecond()) }}/s · {{ eta() }} left</span>
        }
      </p>

      @if (t.resumedFromBytes(); as resumed) {
        <p class="note">Resumed: {{ fmt(resumed) }} was already on the server and was not sent again.</p>
      }
      @if (t.error(); as error) {
        <p class="error">{{ error }}</p>
      }

      <div class="actions">
        @switch (t.status()) {
          @case ('uploading') { <button (click)="t.pause()">Pause</button> }
          @case ('offline') { <button (click)="t.pause()">Pause</button> }
          @case ('paused') { <button (click)="t.resume()">Resume</button> }
          @case ('error') { <button (click)="t.resume()">Retry</button> }
        }
        @if (t.status() !== 'completed' && t.status() !== 'completing') {
          <button class="secondary" (click)="uploads.cancel(t)">Cancel</button>
        }
      </div>
    </article>
  `,
  styles: `
    .card { border: 1px solid var(--border); border-radius: 12px; padding: 16px; background: var(--surface); }
    header { display: flex; gap: 12px; justify-content: space-between; align-items: baseline; }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { font-size: 12px; color: var(--muted); white-space: nowrap; }
    [data-status='offline'] .badge { color: var(--warn); }
    [data-status='error'] .badge { color: var(--danger); }
    [data-status='completed'] .badge { color: var(--ok); }
    .bar { height: 8px; border-radius: 4px; background: var(--track); margin: 12px 0 8px; overflow: hidden; }
    .fill { height: 100%; background: var(--accent); transition: width 0.3s ease; }
    [data-status='offline'] .fill, [data-status='paused'] .fill { background: var(--warn); }
    [data-status='completed'] .fill { background: var(--ok); }
    .meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin: 0; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .note { font-size: 13px; color: var(--ok); margin: 8px 0 0; }
    .error { font-size: 13px; color: var(--danger); margin: 8px 0 0; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .actions:empty { display: none; }
  `,
})
export class UploadCardComponent {
  readonly task = input.required<UploadTask>();
  protected readonly uploads = inject(UploadService);

  protected readonly percent = computed(() => Math.floor(this.task().progress() * 1000) / 10);
  protected readonly statusLabel = computed(() => STATUS_LABEL[this.task().status()]);
  protected readonly eta = computed(() => {
    const t = this.task();
    return formatDuration((t.file.size - t.uploadedBytes()) / t.bytesPerSecond());
  });
  protected readonly fmt = formatBytes;
}
