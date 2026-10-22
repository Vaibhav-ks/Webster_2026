import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, register, bearer, sampleProject, uploadSource } from './helpers.js';
import { sweep } from '../src/maintenance/cleanup.js';

let t;
before(async () => (t = await setup()));
after(() => t.teardown());

const api = (method, path, token) => request(t.app)[method](path).set(bearer(token));

async function savedProject(token, opts) {
  const { body, data } = sampleProject(opts);
  const created = await api('post', '/api/projects', token).send(body).expect(201);
  return { id: created.body.project.id, project: created.body.project, body, data };
}

test('create -> draft (not restorable) until the upload completes', async () => {
  const u = await register(t.app);
  const { id, project, data } = await savedProject(u.token);
  assert.equal(project.status, 'draft');
  assert.equal(project.restorable, false);
  assert.equal(project.source.status, 'pending');

  await api('post', `/api/projects/${id}/source/download-url`, u.token).expect(409);
  await api('post', `/api/projects/${id}/versions`, u.token).send({ baseRevision: 1 }).expect(409);

  const done = await uploadSource(t.app, t.storage, u.token, id, data);
  assert.equal(done.status, 200);
  assert.equal(done.body.project.status, 'active');
  assert.equal(done.body.project.restorable, true);
  assert.equal(done.body.project.currentVersion, 1);

  const key = [...t.storage.objects.keys()].find((k) => k.includes(id));
  assert.match(key, new RegExp(`^u/${u.user.id}/p/${id}/source/[0-9a-f-]{36}$`), 'server-generated private key, no filename');
  assert.ok(t.storage.objects.get(key).data.equals(data), 'stored bytes are the original, untouched');
});

test('reopen returns transcript, cuts, history and source metadata exactly as saved', async () => {
  const u = await register(t.app);
  const { id, body, data } = await savedProject(u.token);
  await uploadSource(t.app, t.storage, u.token, id, data);

  const res = await api('get', `/api/projects/${id}?open=1`, u.token).expect(200);
  assert.deepEqual(res.body.transcript.words, body.transcript.words);
  assert.deepEqual(res.body.editorState.removedRanges, body.editorState.removedRanges);
  assert.deepEqual(res.body.editorState.history, { past: [[]], future: [] });
  assert.equal(res.body.project.source.sha256, body.source.sha256);
  assert.equal(res.body.project.source.durationS, 30);
  assert.ok(res.body.project.lastOpenedAt);

  const dl = await api('post', `/api/projects/${id}/source/download-url`, u.token).expect(200);
  assert.match(dl.body.url, /^https:\/\/fake-s3\.test\//);
  assert.equal(dl.body.streamPath, `/projects/${id}/source/content`);
  assert.equal(dl.body.sha256, body.source.sha256);
  assert.equal(dl.body.sizeBytes, data.length);
});

test('another user cannot read, change, download, version or delete my project', async () => {
  const owner = await register(t.app);
  const other = await register(t.app);
  const { id, data } = await savedProject(owner.token);
  await uploadSource(t.app, t.storage, owner.token, id, data);
  const versions = await api('get', `/api/projects/${id}/versions`, owner.token).expect(200);
  const vid = versions.body.versions[0].id;

  const attempts = [
    ['get', `/api/projects/${id}`],
    ['patch', `/api/projects/${id}`, { baseRevision: 1, title: 'mine now' }],
    ['delete', `/api/projects/${id}`],
    ['post', `/api/projects/${id}/source/upload`, { reupload: true }],
    ['post', `/api/projects/${id}/source/parts`, { partNumbers: [1] }],
    ['post', `/api/projects/${id}/source/complete`, { parts: [] }],
    ['post', `/api/projects/${id}/source/abort`],
    ['post', `/api/projects/${id}/source/download-url`],
    ['get', `/api/projects/${id}/versions`],
    ['post', `/api/projects/${id}/versions`, { baseRevision: 1 }],
    ['post', `/api/projects/${id}/versions/${vid}/restore`, { baseRevision: 1 }],
  ];
  for (const [method, path, body] of attempts) {
    const res = await api(method, path, other.token).send(body ?? {});
    assert.equal(res.status, 404, `${method.toUpperCase()} ${path} must look like a missing project`);
  }
  const list = await api('get', '/api/projects', other.token).expect(200);
  assert.equal(list.body.projects.length, 0);

  // Nothing changed for the owner.
  const mine = await api('get', `/api/projects/${id}`, owner.token).expect(200);
  assert.equal(mine.body.project.title, 'Interview take 3');
  await api('get', '/api/projects/not-a-uuid', owner.token).expect(404);
});

test('a client-supplied owner id is ignored', async () => {
  const a = await register(t.app);
  const b = await register(t.app);
  const { body } = sampleProject();
  const res = await api('post', '/api/projects', a.token).send({ ...body, userId: b.user.id });
  assert.equal(res.status, 400, 'unknown fields are rejected outright');
});

test('autosave uses optimistic concurrency: a stale revision is refused', async () => {
  const u = await register(t.app);
  const { id } = await savedProject(u.token);
  const s1 = await api('patch', `/api/projects/${id}`, u.token)
    .send({ baseRevision: 1, editorState: { removedRanges: [{ start: 0.4, end: 0.8 }] } })
    .expect(200);
  assert.equal(s1.body.revision, 2);

  const stale = await api('patch', `/api/projects/${id}`, u.token)
    .send({ baseRevision: 1, editorState: { removedRanges: [] } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
  assert.equal(stale.body.error.details.currentRevision, 2);

  const now = await api('get', `/api/projects/${id}`, u.token).expect(200);
  assert.deepEqual(now.body.editorState.removedRanges, [{ start: 0.4, end: 0.8 }], 'newer save not overwritten');
});

test('invalid cut lists are rejected; an invalid undo history is dropped, not fatal', async () => {
  const u = await register(t.app);
  const { id } = await savedProject(u.token);
  const overlap = await api('patch', `/api/projects/${id}`, u.token).send({
    baseRevision: 1,
    editorState: { removedRanges: [{ start: 1, end: 3 }, { start: 2, end: 4 }] },
  });
  assert.equal(overlap.status, 422);
  const pastEnd = await api('patch', `/api/projects/${id}`, u.token).send({
    baseRevision: 1,
    editorState: { removedRanges: [{ start: 1, end: 99 }] },
  });
  assert.equal(pastEnd.status, 422);

  const longHistory = Array.from({ length: 80 }, (_, i) => [{ start: i * 0.1, end: i * 0.1 + 0.05 }]);
  const ok = await api('patch', `/api/projects/${id}`, u.token)
    .send({ baseRevision: 1, editorState: { removedRanges: [], history: { past: longHistory, future: [] } } })
    .expect(200);
  const saved = await api('get', `/api/projects/${id}`, u.token);
  assert.equal(saved.body.editorState.history.past.length, 50, 'history capped at 50');
  assert.deepEqual(saved.body.editorState.history.past.at(-1), longHistory.at(-1), 'the most recent 50 are kept');
  assert.equal(ok.body.revision, 2);

  const badHistory = await api('patch', `/api/projects/${id}`, u.token)
    .send({ baseRevision: 2, editorState: { removedRanges: [], history: { past: [[{ start: 1, end: 500 }]], future: [] } } })
    .expect(200);
  const after = await api('get', `/api/projects/${id}`, u.token);
  assert.deepEqual(after.body.editorState.history, { past: [], future: [] });
  assert.equal(badHistory.body.revision, 3);
});

test('upload validation: size limit, type, missing parts, and resuming an interrupted upload', async () => {
  const u = await register(t.app);
  const big = sampleProject({ size: 1024 });
  big.body.source.sizeBytes = t.config.uploads.maxBytes + 1;
  assert.equal((await api('post', '/api/projects', u.token).send(big.body)).status, 413);

  const wrongType = sampleProject({ size: 1024 });
  wrongType.body.source.mimeType = 'application/pdf';
  wrongType.body.source.filename = 'x.pdf';
  assert.equal((await api('post', '/api/projects', u.token).send(wrongType.body)).status, 415);

  const { id, data } = await savedProject(u.token); // 12 MiB -> 3 parts of 5 MiB
  const partial = await uploadSource(t.app, t.storage, u.token, id, data, { skipParts: [2] });
  assert.equal(partial.status, 422);
  assert.equal(partial.body.error.code, 'UPLOAD_INCOMPLETE');
  assert.deepEqual(partial.body.error.details.missingParts, [2]);
  const stillDraft = await api('get', `/api/projects/${id}`, u.token);
  assert.equal(stillDraft.body.project.restorable, false, 'never marked restorable after a failed upload');

  // Resume: the server reports which parts R2 already has.
  const resume = await api('post', `/api/projects/${id}/source/upload`, u.token).send({}).expect(200);
  assert.deepEqual(resume.body.uploadedParts.map((p) => p.partNumber).sort(), [1, 3]);
  const done = await uploadSource(t.app, t.storage, u.token, id, data);
  assert.equal(done.status, 200);

  // A second save never re-uploads.
  const again = await api('post', `/api/projects/${id}/source/upload`, u.token).send({});
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_UPLOADED');
});

test('missing media is reported, and can be re-uploaded into the same record', async () => {
  const u = await register(t.app);
  const { id, data, body } = await savedProject(u.token);
  await uploadSource(t.app, t.storage, u.token, id, data);
  const key = [...t.storage.objects.keys()].find((k) => k.includes(id));
  t.storage.objects.delete(key); // lost in storage

  const dl = await api('post', `/api/projects/${id}/source/download-url`, u.token);
  assert.equal(dl.status, 410);
  assert.equal(dl.body.error.code, 'SOURCE_MISSING');
  const meta = await api('get', `/api/projects/${id}`, u.token).expect(200);
  assert.deepEqual(meta.body.editorState.removedRanges, body.editorState.removedRanges, 'edits untouched');

  await api('post', `/api/projects/${id}/source/upload`, u.token).send({}).expect(409);
  const re = await api('post', `/api/projects/${id}/source/upload`, u.token).send({ reupload: true }).expect(200);
  assert.equal(re.body.partCount, 3);
  const done = await uploadSource(t.app, t.storage, u.token, id, data, {});
  // uploadSource calls /upload without reupload first; the record is pending again so it resumes.
  assert.equal(done.status, 200);
  await api('post', `/api/projects/${id}/source/download-url`, u.token).expect(200);
});

test('the source of a project can never be swapped', async () => {
  const u = await register(t.app);
  const { id, data } = await savedProject(u.token);
  await uploadSource(t.app, t.storage, u.token, id, data);
  const before = (await t.pool.query('SELECT source_asset_id FROM projects WHERE id = $1', [id])).rows[0];
  const other = await savedProject(u.token);
  const otherAsset = (await t.pool.query('SELECT source_asset_id FROM projects WHERE id = $1', [other.id])).rows[0];
  await assert.rejects(
    t.pool.query('UPDATE projects SET source_asset_id = $2 WHERE id = $1', [id, otherAsset.source_asset_id]),
    /cannot be replaced/,
  );
  const afterRow = (await t.pool.query('SELECT source_asset_id FROM projects WHERE id = $1', [id])).rows[0];
  assert.equal(afterRow.source_asset_id, before.source_asset_id);
});

test('versions: explicit save checkpoints, unchanged saves are skipped, restore never deletes history', async () => {
  const u = await register(t.app);
  const { id, data } = await savedProject(u.token);
  await uploadSource(t.app, t.storage, u.token, id, data); // v1: [1.0-1.3]

  const v2 = await api('post', `/api/projects/${id}/versions`, u.token)
    .send({ baseRevision: 1, editorState: { removedRanges: [{ start: 0.4, end: 1.3 }] }, changeSummary: 'Cut intro' })
    .expect(201);
  assert.equal(v2.body.version.versionNumber, 2);
  const same = await api('post', `/api/projects/${id}/versions`, u.token).send({ baseRevision: v2.body.revision }).expect(201);
  assert.equal(same.body.unchanged, true);

  // Edit further without checkpointing, then restore v1.
  const edit = await api('patch', `/api/projects/${id}`, u.token)
    .send({ baseRevision: same.body.revision, editorState: { removedRanges: [{ start: 0.4, end: 2.0 }] } })
    .expect(200);
  const list = await api('get', `/api/projects/${id}/versions`, u.token);
  const v1 = list.body.versions.find((v) => v.versionNumber === 1);
  const restored = await api('post', `/api/projects/${id}/versions/${v1.id}/restore`, u.token)
    .send({ baseRevision: edit.body.revision })
    .expect(200);
  assert.deepEqual(restored.body.editorState.removedRanges, [{ start: 1.0, end: 1.3 }]);
  assert.deepEqual(restored.body.editorState.history.past.at(-1), [{ start: 0.4, end: 2.0 }], 'previous cuts are undoable');

  const all = (await api('get', `/api/projects/${id}/versions`, u.token)).body.versions;
  assert.deepEqual(
    all.map((v) => [v.versionNumber, v.changeSummary]),
    [
      [4, 'Restored version 1'],
      [3, 'Before restoring version 1'],
      [2, 'Cut intro'],
      [1, 'First save'],
    ],
  );
  assert.equal(all[0].restoredFromVersionId, v1.id);

  // Versions are append-only at the database level.
  await assert.rejects(t.pool.query(`UPDATE project_versions SET change_summary = 'x' WHERE project_id = $1`, [id]), /immutable/);
  // A tampered version is refused instead of being applied.
  await t.pool.query('ALTER TABLE project_versions DISABLE TRIGGER project_versions_immutable');
  await t.pool.query(
    `UPDATE project_versions SET editor_state = '{"removedRanges":[]}' WHERE project_id = $1 AND version_number = 2`,
    [id],
  );
  await t.pool.query('ALTER TABLE project_versions ENABLE TRIGGER project_versions_immutable');
  const v2id = all.find((v) => v.versionNumber === 2).id;
  const tampered = await api('post', `/api/projects/${id}/versions/${v2id}/restore`, u.token).send({
    baseRevision: restored.body.revision,
  });
  assert.equal(tampered.status, 500);
  assert.equal(tampered.body.error.code, 'VERSION_CORRUPT');
});

test('delete removes the stored video and all rows; storage outage keeps it hidden and retries', async () => {
  const u = await register(t.app);
  const { id, data } = await savedProject(u.token);
  await uploadSource(t.app, t.storage, u.token, id, data);
  await api('delete', `/api/projects/${id}`, u.token).expect(204);
  assert.ok(![...t.storage.objects.keys()].some((k) => k.includes(id)));
  for (const table of ['projects', 'source_assets', 'transcripts', 'project_versions']) {
    const col = table === 'projects' ? 'id' : 'project_id';
    assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [id])).rows[0].n, 0, table);
  }

  const second = await savedProject(u.token);
  await uploadSource(t.app, t.storage, u.token, second.id, second.data);
  t.storage.failDeletes = true;
  await api('delete', `/api/projects/${second.id}`, u.token).expect(202);
  await api('get', `/api/projects/${second.id}`, u.token).expect(404);
  assert.equal((await api('get', '/api/projects', u.token)).body.projects.some((p) => p.id === second.id), false);
  assert.ok([...t.storage.objects.keys()].some((k) => k.includes(second.id)), 'original kept until it can be deleted');

  t.storage.failDeletes = false;
  await t.pool.query(`UPDATE projects SET updated_at = now() - interval '5 minutes' WHERE id = $1`, [second.id]);
  const r = await sweep({ pool: t.pool, storage: t.storage, config: t.config });
  assert.ok(r.purged >= 1);
  assert.ok(![...t.storage.objects.keys()].some((k) => k.includes(second.id)));
});

test('cleanup expires abandoned uploads but leaves active projects alone', async () => {
  const u = await register(t.app);
  const abandoned = await savedProject(u.token);
  await api('post', `/api/projects/${abandoned.id}/source/upload`, u.token).send({}).expect(200);
  const kept = await savedProject(u.token);
  await uploadSource(t.app, t.storage, u.token, kept.id, kept.data);

  await t.pool.query(
    `UPDATE source_assets SET created_at = now() - interval '2 days' WHERE project_id = ANY($1)`,
    [[abandoned.id, kept.id]],
  );
  await t.pool.query(`UPDATE projects SET updated_at = now() - interval '2 days' WHERE id = ANY($1)`, [[abandoned.id, kept.id]]);
  const uploadsBefore = t.storage.uploads.size;
  await sweep({ pool: t.pool, storage: t.storage, config: t.config });
  await api('get', `/api/projects/${abandoned.id}`, u.token).expect(404);
  await api('get', `/api/projects/${kept.id}`, u.token).expect(200);
  assert.equal(t.storage.uploads.size, uploadsBefore - 1, 'multipart upload aborted');
});
