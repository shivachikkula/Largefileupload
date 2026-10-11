import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { formatBytes } from './upload/format';
import { UploadCardComponent } from './upload/upload-card.component';
import { UploadService } from './upload/upload.service';

@Component({
  selector: 'app-root',
  imports: [UploadCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      <h1>Large file upload</h1>
      <p class="lead">
        Files go straight to Azure Blob Storage in 8 MB blocks. If the connection drops, the upload continues
        from where it stopped, even after a page reload.
      </p>

      <label
        class="drop"
        [class.dragging]="dragging()"
        (dragover)="$event.preventDefault(); dragging.set(true)"
        (dragleave)="dragging.set(false)"
        (drop)="onDrop($event)"
      >
        <input type="file" multiple (change)="onPick($event)" />
        <strong>Choose files</strong> or drop them here
      </label>

      @if (uploads.pendingFromLastVisit().length) {
        <section class="pending">
          <h2>Unfinished uploads</h2>
          <p>Select the same file again to continue where it stopped.</p>
          <ul>
            @for (p of uploads.pendingFromLastVisit(); track p.fingerprint) {
              <li>
                <span>{{ p.fileName }}</span>
                <span class="muted">{{ pct(p.uploadedBytes, p.fileSize) }}% of {{ fmt(p.fileSize) }}</span>
                <button class="secondary" (click)="uploads.discardPending(p)">Discard</button>
              </li>
            }
          </ul>
        </section>
      }

      <section class="list">
        @for (task of uploads.tasks(); track task) {
          <app-upload-card [task]="task" />
        }
      </section>
    </main>
  `,
  styles: `
    main { max-width: 720px; margin: 0 auto; padding: 32px 16px 64px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    .lead { color: var(--muted); margin: 0 0 24px; }
    .drop { display: block; border: 2px dashed var(--border); border-radius: 12px; padding: 32px 16px; text-align: center; cursor: pointer; color: var(--muted); }
    .drop:hover, .drop.dragging { border-color: var(--accent); color: var(--text); }
    .drop strong { color: var(--accent); }
    .drop input { display: none; }
    .pending { margin-top: 24px; padding: 16px; border-radius: 12px; background: var(--warn-bg); }
    .pending h2 { font-size: 16px; margin: 0 0 4px; }
    .pending p { margin: 0 0 8px; font-size: 14px; color: var(--muted); }
    .pending ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .pending li { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .pending li span:first-child { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .muted { color: var(--muted); font-size: 13px; }
    .list { display: grid; gap: 12px; margin-top: 24px; }
  `,
})
export class App {
  protected readonly uploads = inject(UploadService);
  protected readonly dragging = signal(false);
  protected readonly fmt = formatBytes;

  protected pct(done: number, total: number): number {
    return Math.floor((done / total) * 100);
  }

  protected onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files) this.uploads.add([...input.files]);
    input.value = ''; // allow picking the same file again
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    if (event.dataTransfer?.files) this.uploads.add([...event.dataTransfer.files]);
  }
}
