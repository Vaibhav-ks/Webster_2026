// Cloudinary as the store for original videos.
//
// Upload: the browser POSTs the file in chunks (>5 MB each except the last) straight to
// Cloudinary's Upload API, with the same X-Unique-Upload-Id on every chunk and a
// Content-Range per chunk. The server only hands out a *signed* parameter set that pins
// the public_id (our object key), the delivery type and overwrite=false, so the browser
// can't choose where the file goes. Signatures are valid for one hour; the browser asks
// for a fresh one when it needs it.
// Verify: the Admin API reports the stored size, which must equal the original's.
// Delivery: assets are 'private' (or 'authenticated'), never public. Downloads use a
// signed, expiring private-download URL, or are streamed by the API (openStream).
//
// Notes
// - The maximum file size depends on your Cloudinary plan (CLOUDINARY_MAX_UPLOAD_BYTES).
// - Cloudinary keeps the uploaded original. The browser verifies the downloaded bytes
//   against the SHA-256 taken before upload, so any alteration is detected, not trusted.
// - Unfinished chunked uploads have no list/abort API; they simply expire on Cloudinary.

import crypto from 'node:crypto';
import { v2 as cloudinarySdk } from 'cloudinary';
import { HttpError } from '../http.js';

const httpCode = (err) => err?.http_code ?? err?.error?.http_code ?? err?.statusCode;
const isNotFound = (err) => httpCode(err) === 404;

const EXT_BY_MIME = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

/**
 * @param {{ cloudName, apiKey, apiSecret, deliveryType, chunkSize, maxBytes }} cfg
 * @param {{ sdk? }} [deps] a cloudinary v2 compatible object (tests)
 */
export function createCloudinaryStorage(cfg, { sdk } = {}) {
  const cld = sdk ?? cloudinarySdk;
  cld.config({ cloud_name: cfg.cloudName, api_key: cfg.apiKey, api_secret: cfg.apiSecret, secure: true });
  const type = cfg.deliveryType; // 'private' | 'authenticated'
  const opts = { resource_type: 'video', type };

  async function resource(asset) {
    try {
      return await cld.api.resource(asset.objectKey, opts);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  function signedFields(asset) {
    const params = {
      public_id: asset.objectKey,
      type,
      overwrite: 'false', // an uploaded original can never be replaced through this signature
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    const signature = cld.utils.api_sign_request(params, cfg.apiSecret);
    return { ...params, api_key: cfg.apiKey, signature };
  }

  const formatOf = (asset) => asset.meta?.format ?? EXT_BY_MIME[asset.mimeType] ?? 'mp4';

  function downloadUrl(asset, { ttl }) {
    return cld.utils.private_download_url(asset.objectKey, formatOf(asset), {
      ...opts,
      expires_at: Math.floor(Date.now() / 1000) + ttl,
      attachment: false,
    });
  }

  return {
    kind: 'cloudinary',
    store: `cloudinary:${cfg.cloudName}`,
    bucket: cfg.cloudName,
    maxBytes: cfg.maxBytes ?? null,

    async begin(asset, state) {
      // Re-sending chunks under the same upload id is idempotent, so a resumed upload
      // keeps its id (Cloudinary has no API to list which chunks already arrived).
      const uploadId = state?.uploadId ?? crypto.randomBytes(16).toString('hex');
      return {
        state: { uploadId, chunkSize: cfg.chunkSize },
        plan: {
          protocol: 'cloudinary-chunked',
          url: `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/video/upload`,
          chunkSize: cfg.chunkSize,
          uploadId,
          fields: signedFields(asset),
        },
      };
    },

    signParts() {
      throw new HttpError(409, 'WRONG_PROTOCOL', 'This storage does not use presigned parts.');
    },

    async finish(asset) {
      const r = await resource(asset);
      if (!r) {
        return {
          ok: false,
          error: new HttpError(422, 'UPLOAD_INCOMPLETE', 'The upload did not finish. Please try again.', { missingParts: [] }),
        };
      }
      if (Number(r.bytes) !== asset.sizeBytes) {
        await cld.uploader.destroy(asset.objectKey, { ...opts, invalidate: true });
        return {
          ok: false,
          failed: true,
          error: new HttpError(422, 'UPLOAD_SIZE_MISMATCH', 'The stored video does not match the original file size.'),
        };
      }
      return { ok: true, meta: { format: r.format, version: r.version } };
    },

    async abort() {
      // Nothing to cancel server-side: partial chunked uploads expire on their own.
    },

    async head(asset) {
      const r = await resource(asset);
      return r ? { size: Number(r.bytes), contentType: asset.mimeType } : null;
    },

    downloadUrl,

    async openStream(asset) {
      const res = await fetch(downloadUrl(asset, { ttl: 300 }), { redirect: 'follow' });
      if (res.status === 404) return null;
      if (!res.ok || !res.body) throw new Error(`Cloudinary download failed (${res.status})`);
      const len = Number(res.headers.get('content-length'));
      return { body: res.body, size: Number.isFinite(len) && len > 0 ? len : asset.sizeBytes, contentType: asset.mimeType };
    },

    async remove(asset) {
      try {
        await cld.uploader.destroy(asset.objectKey, { ...opts, invalidate: true });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
  };
}
