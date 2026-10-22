// Configuration only (no database, no packages): runs anywhere with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://x',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  APP_ORIGINS: 'http://localhost:5173',
};
const load = (env) => loadConfig({ ...base, ...env });

test('no storage configured -> driver none (allowed outside production)', () => {
  assert.equal(load({}).storage.driver, 'none');
  assert.throws(() => load({ NODE_ENV: 'production', APP_ORIGINS: 'https://app.example' }), /No video storage configured/);
});

test('older R2_* variables still work and select the s3 driver', () => {
  const c = load({ R2_ACCOUNT_ID: 'acc', R2_BUCKET: 'videos', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' });
  assert.equal(c.storage.driver, 's3');
  assert.equal(c.storage.s3.endpoint, 'https://acc.r2.cloudflarestorage.com');
  assert.equal(c.storage.s3.region, 'auto');
  assert.equal(c.storage.s3.forcePathStyle, true);
  assert.equal(c.storage.s3.partSize, c.uploads.partSize);
});

test('AWS S3 (no endpoint) needs a region and uses virtual-hosted URLs', () => {
  assert.throws(
    () => load({ STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }),
    /S3_REGION/,
  );
  const c = load({ STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_REGION: 'ap-south-1', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' });
  assert.equal(c.storage.s3.endpoint, null);
  assert.equal(c.storage.s3.forcePathStyle, false);
});

test('any S3-compatible endpoint (Backblaze, MinIO, ...)', () => {
  const c = load({
    S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
    S3_REGION: 'us-west-004',
    S3_BUCKET: 'b',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
  });
  assert.equal(c.storage.driver, 's3');
  assert.equal(c.storage.s3.forcePathStyle, true);
});

test('cloudinary from CLOUDINARY_URL, private by default, public delivery refused', () => {
  const c = load({ CLOUDINARY_URL: 'cloudinary://123:abc%2Fdef@my-cloud' });
  assert.equal(c.storage.driver, 'cloudinary');
  assert.deepEqual(
    { ...c.storage.cloudinary },
    { cloudName: 'my-cloud', apiKey: '123', apiSecret: 'abc/def', deliveryType: 'private', chunkSize: 20 * 1024 * 1024, maxBytes: 100_000_000 },
  );
  assert.throws(() => load({ CLOUDINARY_URL: 'cloudinary://1:2@c', CLOUDINARY_DELIVERY_TYPE: 'upload' }), /never public/);
  assert.throws(() => load({ STORAGE_DRIVER: 'cloudinary' }), /CLOUDINARY_CLOUD_NAME/);
  assert.throws(() => load({ CLOUDINARY_URL: 'cloudinary://1:2@c', CLOUDINARY_CHUNK_SIZE: String(5 * 1024 * 1024) }), /larger than 5 MiB/);
});

test('STORAGE_DRIVER wins when both are configured, and typos are rejected', () => {
  const both = { S3_BUCKET: 'b', S3_ENDPOINT: 'https://x.test', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', CLOUDINARY_URL: 'cloudinary://1:2@c' };
  assert.equal(load(both).storage.driver, 's3');
  assert.equal(load({ ...both, STORAGE_DRIVER: 'cloudinary' }).storage.driver, 'cloudinary');
  assert.throws(() => load({ STORAGE_DRIVER: 'gcs' }), /STORAGE_DRIVER must be/);
});
