/// <reference lib="webworker" />
import SparkMD5 from 'spark-md5';

export interface Md5Request {
  id: number;
  blob: Blob;
}

export interface Md5Response {
  id: number;
  md5?: string;
  error?: string;
}

/**
 * Hashes blocks off the main thread so the UI stays smooth. The base64 MD5 is
 * sent as Content-MD5 and Azure rejects the block if the bytes don't match.
 */
addEventListener('message', async ({ data }: MessageEvent<Md5Request>) => {
  try {
    const raw = SparkMD5.ArrayBuffer.hash(await data.blob.arrayBuffer(), true);
    postMessage({ id: data.id, md5: btoa(raw) } satisfies Md5Response);
  } catch (err) {
    postMessage({ id: data.id, error: String(err) } satisfies Md5Response);
  }
});
