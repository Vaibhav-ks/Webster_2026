import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { setup, register, bearer, sampleProject, uploadSource, createFakeStorage } from './helpers.js';
import { createApp } from '../src/app.js';
import { createCloudinaryStorage } from '../src/storage/cloudinary.js';

/** Just enough of the cloudinary v2 SDK; "uploads" are simulated by putting resources in. */
function fakeCloudinarySdk() {
  const resources = new Map();
  const destroyed = [];
  return {
    resources,
    destroyed,
    config() {},
    utils: {
      api_sign_request: (params, secret) =>
        crypto
          .createHash('sha1')
          .update(Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&') + secret)
          .digest('hex'),
      private_download_url: (id, format, o) =>
        `https://api.cloudinary.test/download?public_id=${encodeURIComponent(id)}&format=${format}&type=${o.type}&expires_at=${o.expires_at}`,
    },
    api: {
      resource: async (id) => {
        const r = resources.get(id);
        if (!r) throw { error: { message: 'Resource not found', http_code: 404 } };
        return r;
      },
    },
    uploader: {
      destroy: async (id) => {
        destroyed.push(id);
        resources.delete(id);
        return { result: 'ok' };
      },
    },
  };
}

const cloudinaryCfg = {
  cloudName: 'demo-cloud',
  apiKey: 'key123',
  apiSecret: 'secret456',
  deliveryType: 'private',
  chunkSize: 20 * 1024 * 1024,
  maxBytes: 100 * 1000 * 1000,
};

test('cloudinary driver: signed plan pins key, type and overwrite; verification by Admin API', async () => {
  const sdk = fakeCloudinarySdk();
  const driver = createCloudinaryStorage(cloudinaryCfg, { sdk });
  assert.equal(driver.store, 'cloudinary:demo-cloud');
  const asset = { id: 'a', objectKey: 'u/1/p/2/source/3', mimeType: 'video/mp4', sizeBytes: 1234, filename: 'x.mp4', meta: null };

  const { state, plan } = await driver.begin(asset, null);
  assert.equal(plan.protocol, 'cloudinary-chunked');
  assert.equal(plan.url, 'https://api.cloudinary.com/v1_1/demo-cloud/video/upload');
  assert.equal(plan.fields.public_id, asset.objectKey);
  assert.equal(plan.fields.type, 'private');
  assert.equal(plan.fields.overwrite, 'false');
  assert.equal(plan.fields.api_key, 'key123');
  assert.ok(!('api_secret' in plan.fields), 'secret never leaves the server');
  const { signature, api_key, ...signed } = plan.fields;
  assert.equal(signature, sdk.utils.api_sign_request(signed, 'secret456'));
  assert.equal(api_key, 'key123');

  // Resuming keeps the same upload id (Cloudinary chunk uploads are keyed by it).
  assert.equal((await driver.begin(asset, state)).state.uploadId, state.uploadId);

  // Not uploaded yet -> incomplete, nothing persisted.
  const early = await driver.finish(asset, state, {});
  assert.equal(early.ok, false);
  assert.equal(early.error.code, 'UPLOAD_INCOMPLETE');
  assert.equal(await driver.head(asset), null);

  // Wrong size -> deleted and failed.
  sdk.resources.set(asset.objectKey, { bytes: 999, format: 'mp4', version: 1 });
  const wrong = await driver.finish(asset, state, {});
  assert.equal(wrong.failed, true);
  assert.deepEqual(sdk.destroyed, [asset.objectKey]);

  // Right size -> ok, format remembered for downloads.
  sdk.resources.set(asset.objectKey, { bytes: 1234, format: 'mp4', version: 7 });
  const ok = await driver.finish(asset, state, {});
  assert.deepEqual(ok, { ok: true, meta: { format: 'mp4', version: 7 } });
  const url = await driver.downloadUrl({ ...asset, meta: ok.meta }, { ttl: 600 });
  assert.match(url, /type=private/);
  const exp = Number(new URL(url).searchParams.get('expires_at'));
  assert.ok(exp > Date.now() / 1000 && exp <= Date.now() / 1000 + 601, 'URL expires');
});

test('full save/reopen flow works on Cloudinary through the same API', async () => {
  const sdk = fakeCloudinarySdk();
  const t = await setup({ storage: createCloudinaryStorage(cloudinaryCfg, { sdk }) });
  try {
    const u = await register(t.app);
    const { body } = sampleProject({ size: 1024 * 1024 });
    const created = await request(t.app).post('/api/projects').set(bearer(u.token)).send(body).expect(201);
    const id = created.body.project.id;

    const plan = await request(t.app).post(`/api/projects/${id}/source/upload`).set(bearer(u.token)).send({}).expect(200);
    assert.equal(plan.body.protocol, 'cloudinary-chunked');
    await request(t.app).post(`/api/projects/${id}/source/parts`).set(bearer(u.token)).send({ partNumbers: [1] }).expect(409);

    // The browser uploads to Cloudinary...
    sdk.resources.set(plan.body.fields.public_id, { bytes: body.source.sizeBytes, format: 'mp4', version: 3 });
    const done = await request(t.app)
      .post(`/api/projects/${id}/source/complete`)
      .set(bearer(u.token))
      .send({ result: { public_id: plan.body.fields.public_id, bytes: body.source.sizeBytes } })
      .expect(200);
    assert.equal(done.body.project.restorable, true);

    const row = (await t.pool.query('SELECT provider, store, provider_meta FROM source_assets WHERE project_id = $1', [id])).rows[0];
    assert.deepEqual(row, { provider: 'cloudinary', store: 'cloudinary:demo-cloud', provider_meta: { format: 'mp4', version: 3 } });

    const dl = await request(t.app).post(`/api/projects/${id}/source/download-url`).set(bearer(u.token)).expect(200);
    assert.match(dl.body.url, /^https:\/\/api\.cloudinary\.test\/download/);

    await request(t.app).delete(`/api/projects/${id}`).set(bearer(u.token)).expect(204);
    assert.ok(sdk.destroyed.includes(plan.body.fields.public_id));
  } finally {
    await t.teardown();
  }
});

let t;
before(async () => (t = await setup()));
after(() => t.teardown());

test('the API can stream the original itself (fallback when the browser cannot reach storage)', async () => {
  const u = await register(t.app);
  const { body, data } = sampleProject({ size: 6 * 1024 * 1024 });
  const created = await request(t.app).post('/api/projects').set(bearer(u.token)).send(body).expect(201);
  const id = created.body.project.id;
  await uploadSource(t.app, t.storage, u.token, id, data);

  const res = await request(t.app)
    .get(`/api/projects/${id}/source/content`)
    .set(bearer(u.token))
    .buffer(true)
    .parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    })
    .expect(200);
  assert.ok(res.body.equals(data));
  assert.equal(res.headers['content-length'], String(data.length));

  const other = await register(t.app);
  await request(t.app).get(`/api/projects/${id}/source/content`).set(bearer(other.token)).expect(404);
});

test('switching storage: old originals are recognised, re-uploaded on relink, and the old copy is recorded', async () => {
  const u = await register(t.app);
  const { body, data } = sampleProject({ size: 6 * 1024 * 1024 });
  const created = await request(t.app).post('/api/projects').set(bearer(u.token)).send(body).expect(201);
  const id = created.body.project.id;
  await uploadSource(t.app, t.storage, u.token, id, data);

  // Same database, new STORAGE_DRIVER / bucket.
  const newStore = createFakeStorage({ bucket: 'new-bucket', endpoint: 'https://other-s3.test' });
  const app2 = createApp({ config: t.config, pool: t.pool, storage: newStore, rateLimits: { auth: 1000, loginEmail: 1000, refresh: 1000 } });

  const dl = await request(app2).post(`/api/projects/${id}/source/download-url`).set(bearer(u.token));
  assert.equal(dl.status, 409);
  assert.equal(dl.body.error.code, 'SOURCE_IN_OTHER_STORE');
  const meta = await request(app2).get(`/api/projects/${id}`).set(bearer(u.token)).expect(200);
  assert.deepEqual(meta.body.editorState.removedRanges, body.editorState.removedRanges, 'edits untouched');

  // Relink: the identical file is uploaded into the new store under the same record.
  await request(app2).post(`/api/projects/${id}/source/upload`).set(bearer(u.token)).send({ reupload: true }).expect(200);
  const done = await uploadSource(app2, newStore, u.token, id, data);
  assert.equal(done.status, 200);
  await request(app2).post(`/api/projects/${id}/source/download-url`).set(bearer(u.token)).expect(200);

  const row = (await t.pool.query('SELECT store, sha256 FROM source_assets WHERE project_id = $1', [id])).rows[0];
  assert.equal(row.store, newStore.store);
  assert.equal(row.sha256, body.source.sha256, 'same file identity');
  const orphans = (await t.pool.query('SELECT store, reason FROM storage_orphans')).rows;
  assert.ok(orphans.some((o) => o.store === t.storage.store && o.reason === 'replaced by re-upload'));
});
