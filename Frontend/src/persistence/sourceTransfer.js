// Moving the original video between this browser and private cloud storage.
//
// Upload: straight from the browser to whichever storage the server is configured with
// (the API server never sees the bytes). The server's upload plan picks the protocol:
//   s3-multipart       R2 / AWS S3 / any S3-compatible store, presigned part URLs,
//                      parallel parts, resumes from the parts already stored
//   cloudinary-chunked signed chunked upload to Cloudinary
// Chunks/parts are retried with backoff; expired URLs or signatures are refreshed.
// Download: a short-lived URL (or, if the browser can't reach the store, a stream
// through our own API), then size + SHA-256 verification.
//
// Only ever called after the user explicitly chose to save to their account.

import { api, ApiError, authorizedFetch } from '../account/api.js';

const CONCURRENCY = 3;
const MAX_ATTEMPTS = 5;
const URL_BATCH = 10;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(abortError());
    });
  });
const abortError = () => new DOMException('Upload cancelled', 'AbortError');

export const MIME_BY_EXT = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
export function mimeTypeOf(file) {
  if (file.type) return file.type;
  const ext = (/\.[^.]+$/.exec(file.name.toLowerCase()) ?? [''])[0];
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** SHA-256 of a File in a worker, streamed in 8 MiB chunks. */
export function hashFile(file, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/hash.worker.js', import.meta.url), { type: 'module' });
    const stop = () => worker.terminate();
    signal?.addEventListener('abort', () => {
      stop();
      reject(abortError());
    });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress?.(data.progress);
      else if (data.type === 'done') {
        stop();
        resolve(data.sha256);
      } else if (data.type === 'error') {
        stop();
        reject(new Error(data.message));
      }
    };
    worker.onerror = (e) => {
      stop();
      reject(new Error(e.message || 'Could not fingerprint the video.'));
    };
    worker.postMessage({ file });
  });
}

/** PUT one part with XHR (for byte progress). Resolves to the part's ETag. */
function putPart(url, blob, { onBytes, signal }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag');
        if (!etag) {
          const err = new Error('Storage did not return an ETag. The bucket CORS rule must expose the ETag header.');
          err.fatal = true;
          return reject(err);
        }
        resolve(etag);
      } else {
        const err = new Error(`Part upload failed (${xhr.status}).`);
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => reject(Object.assign(new Error('Network error while uploading.'), { network: true }));
    xhr.onabort = () => reject(abortError());
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(blob);
  });
}

/**
 * Upload (or resume uploading) the project's original video, then ask the server to
 * verify and finalize it. The server's plan says which protocol the configured storage
 * uses; the browser never needs storage credentials. Resolves to the project summary.
 */
export async function uploadSource({ projectId, file, reupload = false, onProgress, signal }) {
  const base = `/projects/${projectId}/source`;
  const startPlan = (fresh) =>
    api(`${base}/upload`, { method: 'POST', body: fresh && reupload ? { reupload: true } : {}, signal });

  for (let round = 0; round < 2; round++) {
    const plan = await startPlan(round === 0);
    if (plan.sizeBytes !== file.size) {
      throw new Error('This file is not the one the project was saved with (size differs).');
    }
    let report;
    if (plan.protocol === 's3-multipart') {
      report = await uploadS3Multipart({ base, file, plan, onProgress, signal });
    } else if (plan.protocol === 'cloudinary-chunked') {
      report = await uploadCloudinaryChunked({ file, plan, onProgress, signal, refreshPlan: () => startPlan(false) });
    } else {
      throw new Error(`This server uses a storage type this page doesn't know ("${plan.protocol}"). Reload the page to update.`);
    }
    try {
      const res = await api(`${base}/complete`, { method: 'POST', body: report, signal });
      onProgress?.(1);
      return res.project;
    } catch (err) {
      // Parts went missing or the upload expired server-side: one more round re-sends what's needed.
      if (round === 0 && err instanceof ApiError && ['UPLOAD_INCOMPLETE', 'UPLOAD_EXPIRED'].includes(err.code)) continue;
      throw err;
    }
  }
  throw new Error('The upload could not be completed.');
}

/** S3-compatible stores: parallel parts to presigned URLs, resuming from parts already stored. */
async function uploadS3Multipart({ base, file, plan, onProgress, signal }) {
  const { partSize, partCount } = plan;
  const done = new Map(plan.uploadedParts.map((p) => [p.partNumber, p.etag]));
  const partLen = (n) => (n < partCount ? partSize : file.size - partSize * (partCount - 1));
  let doneBytes = [...done.keys()].reduce((s, n) => s + partLen(n), 0);
  const inFlight = new Map();
  const report = () => onProgress?.(Math.min(1, (doneBytes + [...inFlight.values()].reduce((a, b) => a + b, 0)) / file.size));
  report();

  const queue = [];
  for (let n = 1; n <= partCount; n++) if (!done.has(n)) queue.push(n);

  const urls = new Map();
  let urlsExpireAt = 0;
  async function urlFor(n) {
    if (!urls.has(n) || Date.now() > urlsExpireAt - 60_000) {
      const wanted = [n, ...queue.slice(0, URL_BATCH - 1)];
      const res = await api(`${base}/parts`, { method: 'POST', body: { partNumbers: wanted }, signal });
      for (const p of res.parts) urls.set(p.partNumber, p.url);
      urlsExpireAt = Date.parse(res.expiresAt);
    }
    return urls.get(n);
  }

  async function uploadPart(n) {
    const blob = file.slice((n - 1) * partSize, (n - 1) * partSize + partLen(n));
    for (let attempt = 1; ; attempt++) {
      try {
        const etag = await putPart(await urlFor(n), blob, {
          signal,
          onBytes: (loaded) => {
            inFlight.set(n, loaded);
            report();
          },
        });
        inFlight.delete(n);
        done.set(n, etag);
        doneBytes += blob.size;
        report();
        return;
      } catch (err) {
        inFlight.delete(n);
        if (err.name === 'AbortError' || err.fatal || attempt >= MAX_ATTEMPTS) throw err;
        if (err.status === 403) urls.delete(n); // presigned URL expired: get a fresh one
        await sleep(1000 * 2 ** (attempt - 1), signal);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      if (signal?.aborted) throw abortError();
      await uploadPart(queue.shift());
    }
  });
  await Promise.all(workers);
  return { parts: [...done.entries()].map(([partNumber, etag]) => ({ partNumber, etag })).sort((a, b) => a.partNumber - b.partNumber) };
}

/** POST one Cloudinary chunk. Resolves to Cloudinary's JSON response. */
function postChunk(url, fields, blob, { uploadId, start, end, total, signal, onBytes }) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', blob);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Unique-Upload-Id', uploadId);
    xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${total}`);
    xhr.upload.onprogress = (e) => onBytes(Math.min(e.loaded, end - start));
    xhr.onload = () => {
      let json = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // non-JSON error page
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(json ?? {});
      const message = json?.error?.message || `Upload failed (${xhr.status}).`;
      const err = new Error(message);
      err.status = xhr.status;
      err.staleSignature = /stale request|signature/i.test(message);
      err.fatal = xhr.status >= 400 && xhr.status < 500 && !err.staleSignature && xhr.status !== 408 && xhr.status !== 429;
      reject(err);
    };
    xhr.onerror = () => reject(Object.assign(new Error('Network error while uploading.'), { network: true }));
    xhr.onabort = () => reject(abortError());
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(form);
  });
}

/**
 * Cloudinary: sequential chunks (>5 MB except the last) with one X-Unique-Upload-Id and
 * a Content-Range per chunk. The signed fields expire after an hour, so long uploads ask
 * the server for a fresh signature. Cloudinary can't report which chunks it already has,
 * so a resumed upload re-sends from the start (re-sending a chunk is harmless).
 */
async function uploadCloudinaryChunked({ file, plan, onProgress, signal, refreshPlan }) {
  const { chunkSize, uploadId, url } = plan;
  let fields = plan.fields;
  let signedAt = Date.now();
  let last = null;
  onProgress?.(0);
  for (let start = 0; start < file.size; start += chunkSize) {
    const end = Math.min(start + chunkSize, file.size);
    for (let attempt = 1; ; attempt++) {
      if (Date.now() - signedAt > 50 * 60 * 1000) {
        fields = (await refreshPlan()).fields;
        signedAt = Date.now();
      }
      try {
        last = await postChunk(url, fields, file.slice(start, end), {
          uploadId,
          start,
          end,
          total: file.size,
          signal,
          onBytes: (loaded) => onProgress?.(Math.min(1, (start + loaded) / file.size)),
        });
        break;
      } catch (err) {
        if (err.name === 'AbortError' || err.fatal || attempt >= MAX_ATTEMPTS) throw err;
        if (err.staleSignature) {
          fields = (await refreshPlan()).fields;
          signedAt = Date.now();
        } else {
          await sleep(1000 * 2 ** (attempt - 1), signal);
        }
      }
    }
  }
  // The final chunk returns the full upload response; the server re-checks it with Cloudinary.
  return { result: { public_id: last?.public_id, bytes: last?.bytes, format: last?.format, version: last?.version } };
}

export function abortUpload(projectId) {
  return api(`/projects/${projectId}/source/abort`, { method: 'POST' }).catch(() => {});
}

export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Fetch the original video through a short-lived URL and verify it is byte-identical
 * to what was saved. Resolves to a File ready for the editor's normal loading path.
 */
export async function downloadSource(projectId, { onProgress, onPhase, signal } = {}) {
  let info;
  try {
    info = await api(`/projects/${projectId}/source/download-url`, { method: 'POST', signal });
  } catch (err) {
    if (err.code === 'SOURCE_MISSING') throw new SourceError('SOURCE_MISSING', 'The original video is missing from cloud storage.');
    if (err.code === 'SOURCE_CORRUPT') throw new SourceError('SOURCE_CORRUPT', 'The stored video is damaged.');
    if (err.code === 'SOURCE_IN_OTHER_STORE') {
      throw new SourceError('SOURCE_IN_OTHER_STORE', 'The original video is in a storage service this app no longer uses.');
    }
    throw err;
  }

  onPhase?.('download');
  let res = null;
  try {
    res = await fetch(info.url, { signal });
    if (!res.ok || !res.body) res = null;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Often CORS on the storage provider; fall back to streaming through our own API.
  }
  if (!res && info.streamPath) {
    try {
      res = await authorizedFetch(info.streamPath, { signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (err.code === 'SOURCE_MISSING') throw new SourceError('SOURCE_MISSING', 'The original video is missing from cloud storage.');
      throw new SourceError('DOWNLOAD_FAILED', "Couldn't download the original video. Check your connection and try again.");
    }
  }
  if (!res) throw new SourceError('DOWNLOAD_FAILED', "Couldn't download the original video. Check your connection and try again.");

  let loaded = 0;
  const counted = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        onProgress?.(Math.min(1, loaded / info.sizeBytes));
        controller.enqueue(chunk);
      },
    }),
  );
  // Let the browser manage the bytes (it may spill large blobs to disk).
  const blob = await new Response(counted).blob();
  const file = new File([blob], info.filename, { type: info.mimeType });

  onPhase?.('verify');
  if (file.size !== info.sizeBytes) {
    throw new SourceError('SOURCE_CORRUPT', 'The downloaded video is incomplete. Please try again.');
  }
  const sha256 = await hashFile(file, { onProgress, signal });
  if (sha256 !== info.sha256) {
    throw new SourceError('SOURCE_CORRUPT', 'The downloaded video failed its integrity check.');
  }
  return file;
}
