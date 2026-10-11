const SAMPLE = 1024 * 1024;

/**
 * Identifies "the same file" across page reloads without reading all 10 GB:
 * name + size + lastModified + SHA-256 of the first and last MiB.
 */
export async function fileFingerprint(file: File): Promise<string> {
  const head = await file.slice(0, SAMPLE).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - SAMPLE)).arrayBuffer();
  const meta = new TextEncoder().encode(`${file.name}|${file.size}|${file.lastModified}|`);

  const data = new Uint8Array(meta.byteLength + head.byteLength + tail.byteLength);
  data.set(meta, 0);
  data.set(new Uint8Array(head), meta.byteLength);
  data.set(new Uint8Array(tail), meta.byteLength + head.byteLength);

  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
