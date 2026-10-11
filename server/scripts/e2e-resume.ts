/**
 * End-to-end check of the resume flow, using the same REST calls the Angular
 * client makes. Expects Azurite and the API to be running:
 *   npm run azurite   &   AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true npm run dev
 */
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { uploadContainer } from '../src/azure.js';

const API = process.env.API_URL ?? 'http://localhost:3000/api/uploads';
const MiB = 1024 * 1024;
const headers = { 'content-type': 'application/json', 'x-user-id': 'e2e-user' };

const blockIdFor = (i: number) => Buffer.from(`block-${i.toString().padStart(6, '0')}`).toString('base64');

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function putBlock(sasUrl: string, index: number, data: Buffer, signal?: AbortSignal) {
  const url = `${sasUrl}&comp=block&blockid=${encodeURIComponent(blockIdFor(index))}`;
  const res = await fetch(url, {
    method: 'PUT',
    body: data,
    signal,
    headers: { 'content-md5': createHash('md5').update(data).digest('base64') },
  });
  if (res.status !== 201) throw new Error(`Put Block ${index} failed: ${res.status} ${await res.text()}`);
}

const slice = (file: Buffer, blockSize: number, i: number) => file.subarray(i * blockSize, (i + 1) * blockSize);

async function main() {
  // ~100 MiB "file" so it has 13 blocks of 8 MiB (the last one partial).
  const file = randomBytes(100 * MiB + 12345);
  const fingerprint = createHash('sha256').update(`e2e|${file.length}|${Date.now()}`).digest('hex');
  const meta = { fileName: 'big video.mp4', fileSize: file.length, contentType: 'video/mp4', fingerprint };

  // 1. Start the upload
  const created = await api('POST', '', meta);
  assert.equal(created.status, 201);
  const { uploadId, blockSize, totalBlocks } = created.body;
  console.log(`created ${uploadId}: ${totalBlocks} blocks of ${blockSize / MiB} MiB`);

  // 2. Upload ~49% of the blocks, then "lose the network" in the middle of the next block
  const before = Math.floor(totalBlocks * 0.49);
  for (let i = 0; i < before; i++) await putBlock(created.body.sasUrl, i, slice(file, blockSize, i));
  const ctrl = new AbortController();
  const inFlight = putBlock(created.body.sasUrl, before, slice(file, blockSize, before), ctrl.signal);
  setTimeout(() => ctrl.abort(), 1);
  await assert.rejects(inFlight);
  console.log(`uploaded ${before}/${totalBlocks} blocks, then aborted block ${before} mid-flight`);

  // 3. Completing now must be refused, and must say what's missing
  const early = await api('POST', `/${uploadId}/complete`);
  assert.equal(early.status, 409);
  assert.equal(early.body.details.missingCount, totalBlocks - before);

  // 4. "Browser refreshed": same file chosen again, so same fingerprint, so the same session comes back
  const resumed = await api('POST', '', meta);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.resumed, true);
  assert.equal(resumed.body.uploadId, uploadId);
  assert.deepEqual(resumed.body.uploadedBlocks, [...Array(before).keys()]);
  console.log(`resumed: server reports blocks 0..${before - 1} (${resumed.body.uploadedBytes} bytes) already stored`);

  // 5. Upload only what is missing (4 in parallel), re-uploading one existing block to show it's harmless
  const missing = [...Array(totalBlocks).keys()].filter((i) => !resumed.body.uploadedBlocks.includes(i));
  const queue = [0, ...missing];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
        await putBlock(resumed.body.sasUrl, i, slice(file, blockSize, i));
      }
    }),
  );

  // 6. A corrupted block is rejected by Azure via Content-MD5
  const bad = await fetch(`${resumed.body.sasUrl}&comp=block&blockid=${encodeURIComponent(blockIdFor(0))}`, {
    method: 'PUT',
    body: slice(file, blockSize, 0),
    headers: { 'content-md5': createHash('md5').update('not the data').digest('base64') },
  });
  assert.equal(bad.status, 400);
  console.log('corrupted block rejected by Content-MD5 check');

  // 7. Complete twice (second call is idempotent)
  const done = await api('POST', `/${uploadId}/complete`);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'completed');
  assert.equal((await api('POST', `/${uploadId}/complete`)).status, 200);

  // 8. The blob is byte-for-byte identical to the source file
  const blobName = `e2e-user/${uploadId}/big video.mp4`;
  const stored = await uploadContainer.getBlockBlobClient(blobName).downloadToBuffer();
  assert.equal(createHash('sha256').update(stored).digest('hex'), createHash('sha256').update(file).digest('hex'));
  console.log(`completed: ${stored.length} bytes, sha256 matches`);

  // 9. Another user can't see the session
  const other = await fetch(`${API}/${uploadId}`, { headers: { 'x-user-id': 'someone-else' } });
  assert.equal(other.status, 404);

  // 10. Cancelling discards staged blocks
  const second = await api('POST', '', { ...meta, fingerprint: `${fingerprint}-2` });
  await putBlock(second.body.sasUrl, 0, slice(file, blockSize, 0));
  assert.equal((await api('DELETE', `/${second.body.uploadId}`)).status, 204);
  const blobs = [];
  for await (const b of uploadContainer.listBlobsFlat({ prefix: `e2e-user/${second.body.uploadId}/` })) blobs.push(b);
  assert.equal(blobs.length, 0);
  console.log('cancel: staged blocks discarded');

  console.log('\nE2E resume test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
