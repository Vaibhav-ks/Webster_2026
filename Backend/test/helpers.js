// Test harness: a throwaway PostgreSQL database per test file (real SQL, real
// constraints and triggers), an in-memory S3/R2 fake, and a fake Google verifier.
//
// Requires TEST_DATABASE_URL pointing at a server where the user may CREATE DATABASE,
// e.g. postgres://postgres:postgres@localhost:5432/postgres (docker compose up db).

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import pg from 'pg';
import request from 'supertest';
import { migrate } from '../scripts/migrate.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { HttpError } from '../src/http.js';
import { createS3Storage } from '../src/storage/s3.js';

export const ORIGIN = 'http://localhost:5173';

export async function createTestDb() {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) throw new Error('TEST_DATABASE_URL is required to run backend tests');
  const name = `scarlet_test_${crypto.randomBytes(5).toString('hex')}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  await migrate(url.toString(), { log: () => {} });
  const pool = createPool(url.toString());
  return {
    pool,
    async drop() {
      await pool.end();
      const c2 = new pg.Client({ connectionString: admin });
      await c2.connect();
      await c2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c2.end();
    },
  };
}

/**
 * In-memory S3 server behind the REAL S3 storage driver (src/storage/s3.js), so the
 * driver's own logic (part verification, size checks) is exercised by every test.
 */
export function createFakeS3Client() {
  const uploads = new Map();
  const objects = new Map();
  const state = { failDeletes: false };
  const etag = (buf) => `"${crypto.createHash('md5').update(buf).digest('hex')}"`;
  const missing = (name) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
  return {
    uploads,
    objects,
    state,
    putPart(uploadId, partNumber, data) {
      const u = uploads.get(uploadId);
      if (!u) throw new Error('NoSuchUpload');
      const tag = etag(data);
      u.parts.set(partNumber, { data, etag: tag });
      return tag;
    },
    async send(cmd) {
      const i = cmd.input;
      switch (cmd.constructor.name) {
        case 'CreateMultipartUploadCommand': {
          const id = crypto.randomUUID();
          uploads.set(id, { key: i.Key, contentType: i.ContentType, parts: new Map() });
          return { UploadId: id };
        }
        case 'ListPartsCommand': {
          const u = uploads.get(i.UploadId);
          if (!u || u.key !== i.Key) throw missing('NoSuchUpload');
          const Parts = [...u.parts.entries()].map(([n, p]) => ({ PartNumber: n, ETag: p.etag, Size: p.data.length }));
          return { Parts, IsTruncated: false };
        }
        case 'CompleteMultipartUploadCommand': {
          const u = uploads.get(i.UploadId);
          const data = Buffer.concat(i.MultipartUpload.Parts.map((p) => u.parts.get(p.PartNumber).data));
          objects.set(i.Key, { data, contentType: u.contentType });
          uploads.delete(i.UploadId);
          return {};
        }
        case 'AbortMultipartUploadCommand':
          if (!uploads.delete(i.UploadId)) throw missing('NoSuchUpload');
          return {};
        case 'HeadObjectCommand': {
          const o = objects.get(i.Key);
          if (!o) throw missing('NotFound');
          return { ContentLength: o.data.length, ContentType: o.contentType };
        }
        case 'GetObjectCommand': {
          const o = objects.get(i.Key);
          if (!o) throw missing('NoSuchKey');
          return { Body: Readable.from([o.data]), ContentLength: o.data.length, ContentType: o.contentType };
        }
        case 'DeleteObjectCommand':
          if (state.failDeletes) throw new Error('storage unavailable');
          objects.delete(i.Key);
          return {};
        default:
          throw new Error(`fake S3: unsupported ${cmd.constructor.name}`);
      }
    },
  };
}

const fakePresign = async (_client, cmd) => {
  const i = cmd.input;
  const q = new URLSearchParams({ uploadId: i.UploadId ?? '', partNumber: String(i.PartNumber ?? ''), signed: '1' });
  return `https://fake-s3.test/${encodeURIComponent(i.Key)}?${q}`;
};

export function createFakeStorage({ bucket = 'test-bucket', endpoint = 'https://fake-s3.test' } = {}) {
  const fake = createFakeS3Client();
  const driver = createS3Storage(
    { endpoint, region: 'auto', bucket, accessKeyId: 'x', secretAccessKey: 'y', forcePathStyle: true, partSize: 5 * 1024 * 1024, uploadUrlTtlS: 900 },
    { client: fake, presign: fakePresign },
  );
  return Object.assign(driver, {
    uploads: fake.uploads,
    objects: fake.objects,
    putPart: fake.putPart,
    get failDeletes() {
      return fake.state.failDeletes;
    },
    set failDeletes(v) {
      fake.state.failDeletes = v;
    },
  });
}

/** credential string -> Google payload. Unknown credentials are rejected like a bad signature. */
export function createFakeGoogle() {
  const known = new Map();
  return {
    add(credential, payload) {
      known.set(credential, { emailVerified: true, name: 'Google User', ...payload });
    },
    verify: async (credential) => {
      const p = known.get(credential);
      if (!p) throw new HttpError(401, 'GOOGLE_INVALID', 'Google sign-in could not be verified.');
      return p;
    },
  };
}

export function testConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'unused',
    JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-123',
    APP_ORIGINS: ORIGIN,
    COOKIE_SECURE: 'false',
    UPLOAD_PART_SIZE: String(5 * 1024 * 1024),
    MAX_UPLOAD_BYTES: String(50 * 1024 * 1024),
    ...overrides,
  });
}

export async function setup({ rateLimits = { auth: 1000, loginEmail: 1000, refresh: 1000 }, env, storage: storageOverride } = {}) {
  const db = await createTestDb();
  const storage = storageOverride ?? createFakeStorage();
  const google = createFakeGoogle();
  const config = testConfig(env);
  const app = createApp({ config, pool: db.pool, storage, verifyGoogle: google.verify, rateLimits });
  return { app, db, storage, google, config, pool: db.pool, teardown: () => db.drop() };
}

/** A supertest agent keeps cookies, like a browser tab. */
export function browser(app) {
  return request.agent(app);
}

export async function register(app, email = `u${crypto.randomBytes(4).toString('hex')}@example.com`, password = 'correct horse 1') {
  const agent = browser(app);
  const res = await agent.post('/api/auth/register').send({ email, password }).expect(201);
  const refreshCookie = /sr_rt=([^;]+)/.exec(res.headers['set-cookie'].join(';'))[1];
  return { agent, email, password, token: res.body.accessToken, user: res.body.user, refreshCookie };
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });

export function sampleProject({ size = 12 * 1024 * 1024, duration = 30, sha256 } = {}) {
  const data = crypto.randomBytes(size);
  return {
    data,
    body: {
      title: 'Interview take 3',
      transcript: {
        model: 'onnx-community/whisper-base_timestamped',
        language: 'english',
        words: [
          { id: 'w0', text: 'Hello', start: 0.4, end: 0.8 },
          { id: 'w1', text: 'um', start: 1.0, end: 1.3 },
          { id: 'w2', text: 'world', start: 1.5, end: 2.0 },
        ],
      },
      editorState: {
        removedRanges: [{ start: 1.0, end: 1.3 }],
        history: { past: [[]], future: [] },
      },
      source: {
        filename: 'take3.mp4',
        mimeType: 'video/mp4',
        sizeBytes: size,
        durationS: duration,
        width: 1280,
        height: 720,
        sha256: sha256 ?? crypto.createHash('sha256').update(data).digest('hex'),
      },
    },
  };
}

/** Run the full browser upload against the fake storage: start -> PUT parts -> complete. */
export async function uploadSource(app, storage, token, projectId, data, { skipParts = [] } = {}) {
  const start = await request(app).post(`/api/projects/${projectId}/source/upload`).set(bearer(token)).send({}).expect(200);
  const { partSize, partCount } = start.body;
  const numbers = Array.from({ length: partCount }, (_, i) => i + 1);
  const urls = await request(app)
    .post(`/api/projects/${projectId}/source/parts`)
    .set(bearer(token))
    .send({ partNumbers: numbers })
    .expect(200);
  const uploadId = new URL(urls.body.parts[0].url).searchParams.get('uploadId');
  const parts = [];
  for (const n of numbers) {
    if (skipParts.includes(n)) continue;
    const etag = storage.putPart(uploadId, n, data.subarray((n - 1) * partSize, n * partSize));
    parts.push({ partNumber: n, etag });
  }
  return request(app).post(`/api/projects/${projectId}/source/complete`).set(bearer(token)).send({ parts });
}
