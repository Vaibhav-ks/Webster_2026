// Any S3-compatible object store: Cloudflare R2, AWS S3, Backblaze B2, Wasabi,
// DigitalOcean Spaces, MinIO, Supabase Storage (S3 endpoint), GCS (interoperability).
// Uploads are multipart, straight from the browser through presigned part URLs.
// Credentials never leave the server.

import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { HttpError } from '../http.js';

const MAX_PARTS = 10_000;

const isNotFound = (err) =>
  err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.name === 'NoSuchUpload' || err?.$metadata?.httpStatusCode === 404;

/** ETags may arrive quoted or not (and with a W/ prefix) depending on who reports them. */
const bareEtag = (etag) => String(etag ?? '').replace(/^W\//, '').replace(/"/g, '');
const partCount = (size, partSize) => Math.max(1, Math.ceil(size / partSize));

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * @param {{ endpoint?, region, bucket, accessKeyId, secretAccessKey, forcePathStyle, partSize, uploadUrlTtlS, maxBytes? }} cfg
 * @param {{ client?, presign? }} [deps] S3Client-compatible object and URL signer (tests)
 */
export function createS3Storage(cfg, { client, presign = getSignedUrl } = {}) {
  const s3 =
    client ??
    new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint || undefined,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // Newer SDKs add CRC32 checksums to every request by default, which breaks presigned
      // browser uploads on several S3-compatible stores. Only send them when required.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  const Bucket = cfg.bucket;
  const host = cfg.endpoint ? new URL(cfg.endpoint).host : `aws-${cfg.region}`;

  async function listParts(key, uploadId) {
    const parts = [];
    let marker;
    try {
      do {
        const out = await s3.send(new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }));
        for (const p of out.Parts ?? []) parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size });
        marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
      } while (marker);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    return parts;
  }

  async function head(asset) {
    try {
      const out = await s3.send(new HeadObjectCommand({ Bucket, Key: asset.objectKey }));
      return { size: Number(out.ContentLength), contentType: out.ContentType ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async function remove(asset) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket, Key: asset.objectKey }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  return {
    kind: 's3',
    store: `s3:${host}/${Bucket}`,
    bucket: Bucket,
    maxBytes: cfg.maxBytes ?? null,

    async begin(asset, state) {
      const partSize = Math.max(cfg.partSize, Math.ceil(asset.sizeBytes / MAX_PARTS));
      let uploadId = state?.uploadId ?? null;
      let uploadedParts = [];
      if (uploadId && state.partSize === partSize) {
        const parts = await listParts(asset.objectKey, uploadId);
        if (parts === null) uploadId = null; // expired or aborted: start over
        else uploadedParts = parts;
      } else uploadId = null;
      if (!uploadId) {
        const out = await s3.send(
          new CreateMultipartUploadCommand({ Bucket, Key: asset.objectKey, ContentType: asset.mimeType }),
        );
        uploadId = out.UploadId;
      }
      return {
        state: { uploadId, partSize },
        plan: { protocol: 's3-multipart', partSize, partCount: partCount(asset.sizeBytes, partSize), uploadedParts },
      };
    },

    async signParts(asset, state, partNumbers) {
      const count = partCount(asset.sizeBytes, state.partSize);
      for (const n of partNumbers) {
        if (n < 1 || n > count) throw new HttpError(400, 'BAD_PART', `Part ${n} is out of range (1-${count}).`);
      }
      return Promise.all(
        partNumbers.map(async (partNumber) => ({
          partNumber,
          url: await presign(
            s3,
            new UploadPartCommand({ Bucket, Key: asset.objectKey, UploadId: state.uploadId, PartNumber: partNumber }),
            { expiresIn: cfg.uploadUrlTtlS },
          ),
        })),
      );
    },

    async finish(asset, state, report) {
      const size = asset.sizeBytes;
      const count = partCount(size, state.partSize);
      // The store's own record of the parts is authoritative; the browser's list must agree.
      const stored = await listParts(asset.objectKey, state.uploadId);
      if (stored === null) {
        return {
          ok: false,
          clearState: true,
          error: new HttpError(409, 'UPLOAD_EXPIRED', 'The upload expired. Please upload the video again.'),
        };
      }
      const byNumber = new Map(stored.map((p) => [p.partNumber, p]));
      const claimedParts = Array.isArray(report?.parts) ? report.parts : [];
      const missing = [];
      for (let n = 1; n <= count; n++) {
        const p = byNumber.get(n);
        const expected = n < count ? state.partSize : size - state.partSize * (count - 1);
        const claimed = claimedParts.find((c) => c.partNumber === n);
        if (!p || p.size !== expected || (claimed?.etag && bareEtag(claimed.etag) !== bareEtag(p.etag))) missing.push(n);
      }
      if (missing.length) {
        return {
          ok: false,
          error: new HttpError(422, 'UPLOAD_INCOMPLETE', 'Some parts of the video are missing or incomplete.', {
            missingParts: missing.slice(0, 100),
          }),
        };
      }
      const parts = [...byNumber.values()].filter((p) => p.partNumber <= count).sort((a, b) => a.partNumber - b.partNumber);
      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: asset.objectKey,
          UploadId: state.uploadId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        }),
      );
      const h = await head(asset);
      if (!h || h.size !== size) {
        await remove(asset);
        return {
          ok: false,
          failed: true,
          error: new HttpError(422, 'UPLOAD_SIZE_MISMATCH', 'The stored video does not match the original file size.'),
        };
      }
      return { ok: true, meta: null };
    },

    async abort(asset, state) {
      if (!state?.uploadId) return;
      try {
        await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: asset.objectKey, UploadId: state.uploadId }));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },

    head,

    downloadUrl(asset, { ttl }) {
      return presign(
        s3,
        new GetObjectCommand({
          Bucket,
          Key: asset.objectKey,
          ResponseContentType: asset.mimeType,
          ResponseContentDisposition: contentDisposition(asset.filename),
        }),
        { expiresIn: ttl },
      );
    },

    async openStream(asset) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket, Key: asset.objectKey }));
        return { body: out.Body, size: Number(out.ContentLength), contentType: out.ContentType ?? asset.mimeType };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    remove,
  };
}
