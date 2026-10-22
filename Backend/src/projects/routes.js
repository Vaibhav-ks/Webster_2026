// /api/projects/* - every route requires a signed-in user and only ever touches that
// user's rows (the service scopes all queries by req.auth.userId).

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { z } from 'zod';
import { parse, assertUuid } from '../http.js';
import { EditorState, Transcript, SourceMeta } from './state.js';

const Title = z.string().trim().min(1).max(200);
const Description = z.string().trim().max(2000).nullable();
const Revision = z.number().int().positive();

const CreateBody = z
  .object({ title: Title, description: Description.optional(), transcript: Transcript, editorState: EditorState, source: SourceMeta })
  .strict();
const UpdateBody = z
  .object({ baseRevision: Revision, editorState: EditorState.optional(), title: Title.optional(), description: Description.optional() })
  .strict();
const StartUploadBody = z.object({ reupload: z.boolean().optional() }).strict();
const PartsBody = z.object({ partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100) }).strict();
// What the browser reports after uploading. The driver decides what to trust: S3 checks
// every part against the store's own list; Cloudinary asks its Admin API.
const CompleteBody = z
  .object({
    parts: z
      .array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().max(200) }).strict())
      .max(10_000)
      .optional(),
    result: z.record(z.string(), z.unknown()).optional(), // e.g. Cloudinary's final upload response
  })
  .strict();
const VersionBody = z
  .object({ baseRevision: Revision, editorState: EditorState.optional(), changeSummary: z.string().trim().max(200).optional() })
  .strict();
const RestoreBody = z.object({ baseRevision: Revision }).strict();

export function createProjectsRouter({ service, signedIn }) {
  const r = Router();
  r.use(signedIn);
  r.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const id = (req) => assertUuid(req.params.id);
  const user = (req) => req.auth.userId;

  r.post('/', async (req, res) => {
    res.status(201).json({ project: await service.create(user(req), parse(CreateBody, req.body)) });
  });
  r.get('/', async (req, res) => {
    res.json({ projects: await service.list(user(req)) });
  });
  r.get('/:id', async (req, res) => {
    res.json(await service.get(user(req), id(req), { markOpened: req.query.open === '1' }));
  });
  r.patch('/:id', async (req, res) => {
    res.json(await service.update(user(req), id(req), parse(UpdateBody, req.body)));
  });
  r.delete('/:id', async (req, res) => {
    const { deleted } = await service.markDeleted(user(req), id(req));
    // 202: hidden from the user now, storage cleanup will be retried in the background.
    res.status(deleted ? 204 : 202).end();
  });

  // Source video: browser -> storage directly; the storage driver chooses the protocol.
  r.post('/:id/source/upload', async (req, res) => {
    res.json(await service.startUpload(user(req), id(req), parse(StartUploadBody, req.body)));
  });
  r.post('/:id/source/parts', async (req, res) => {
    res.json(await service.presignParts(user(req), id(req), parse(PartsBody, req.body).partNumbers));
  });
  r.post('/:id/source/complete', async (req, res) => {
    res.json({ project: await service.completeUpload(user(req), id(req), parse(CompleteBody, req.body)) });
  });
  r.post('/:id/source/abort', async (req, res) => {
    await service.abortUpload(user(req), id(req));
    res.status(204).end();
  });
  r.post('/:id/source/download-url', async (req, res) => {
    res.json(await service.downloadUrl(user(req), id(req)));
  });
  // Fallback download through the API (same origin) for stores the browser can't fetch directly.
  r.get('/:id/source/content', async (req, res) => {
    const src = await service.openSourceStream(user(req), id(req));
    res.set({
      'Content-Type': src.contentType,
      'Content-Length': String(src.size),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(src.filename)}`,
    });
    const body = typeof src.body?.getReader === 'function' ? Readable.fromWeb(src.body) : src.body;
    await pipeline(body, res);
  });

  // Versions (checkpoints of the cut list).
  r.get('/:id/versions', async (req, res) => {
    res.json({ versions: await service.listVersions(user(req), id(req)) });
  });
  r.post('/:id/versions', async (req, res) => {
    res.status(201).json(await service.createVersion(user(req), id(req), parse(VersionBody, req.body)));
  });
  r.post('/:id/versions/:versionId/restore', async (req, res) => {
    const versionId = assertUuid(req.params.versionId, 'Version');
    res.json(await service.restoreVersion(user(req), id(req), versionId, parse(RestoreBody, req.body)));
  });

  return r;
}
