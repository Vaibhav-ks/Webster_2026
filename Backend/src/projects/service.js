// Saved projects. Every query is scoped by the authenticated user's id; a project
// that belongs to someone else is indistinguishable from one that doesn't exist.
//
// Lifecycle:
//   create  -> project 'draft' + immutable transcript + source asset 'pending'
//   upload  -> straight from the browser to the configured store (storage driver decides
//              the protocol: S3 multipart with presigned parts, Cloudinary signed chunks)
//   complete-> driver verifies the stored object, asset 'uploaded', project 'active', version 1
//   update  -> editor_state with optimistic concurrency (revision)
//   version -> checkpoint of removedRanges; restore creates new checkpoints, never deletes
//   delete  -> 'deleting', storage objects removed, rows removed (cleanup retries failures)

import crypto from 'node:crypto';
import { tx } from '../db.js';
import { HttpError, notFound } from '../http.js';
import {
  SCHEMA_VERSION,
  HISTORY_LIMIT,
  sanitizeEditorState,
  checkWords,
  stableStringify,
  sha256Hex,
  versionPayload,
  stateHash,
} from './state.js';
import { assetView } from '../storage/index.js';

const EXT_BY_MIME = { 'video/mp4': ['.mp4', '.m4v'], 'video/webm': ['.webm'], 'video/quicktime': ['.mov'] };

const lockProject = async (client, userId, projectId) => {
  const { rows } = await client.query(
    `SELECT p.*, a.id AS a_id, a.object_key, a.status AS a_status, a.size_bytes, a.duration_s, a.mime_type,
            a.original_filename, a.sha256, a.width, a.height, a.store, a.provider, a.upload_state, a.provider_meta
       FROM projects p LEFT JOIN source_assets a ON a.id = p.source_asset_id
      WHERE p.id = $1 AND p.user_id = $2 AND p.status <> 'deleting'
      FOR UPDATE OF p`,
    [projectId, userId],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
};

const lockAsset = (client, assetId) => client.query('SELECT 1 FROM source_assets WHERE id = $1 FOR UPDATE', [assetId]);

function summary(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    restorable: row.status === 'active' && row.a_status === 'uploaded',
    revision: row.revision,
    currentVersion: row.current_version,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    source: row.a_id
      ? {
          id: row.a_id,
          filename: row.original_filename,
          mimeType: row.mime_type,
          sizeBytes: Number(row.size_bytes),
          durationS: row.duration_s,
          width: row.width ?? null,
          height: row.height ?? null,
          sha256: row.sha256,
          status: row.a_status,
        }
      : null,
  };
}


function checkRevision(row, baseRevision) {
  if (row.revision !== baseRevision) {
    throw new HttpError(409, 'REVISION_CONFLICT', 'This project was saved from somewhere else.', {
      currentRevision: row.revision,
      updatedAt: row.updated_at,
    });
  }
}

export function createProjectService({ pool, storage, config }) {
  const up = config.uploads;

  const requireStorage = () => {
    if (!storage) throw new HttpError(503, 'STORAGE_DISABLED', 'Cloud storage is not configured on this server.');
    return storage;
  };
  const maxBytes = () => Math.min(up.maxBytes, storage?.maxBytes ?? Infinity);

  /** The driver for an asset, or a clear error if it lives in a store this server no longer uses. */
  function driverFor(row) {
    const driver = requireStorage();
    if (row.store !== driver.store) {
      throw new HttpError(
        409,
        'SOURCE_IN_OTHER_STORE',
        'The original video is kept in a storage service this server no longer uses.',
        { store: row.store },
      );
    }
    return driver;
  }

  async function insertVersion(client, { projectId, number, payload, transcriptId, userId, summaryText, restoredFrom }) {
    const { rows } = await client.query(
      `INSERT INTO project_versions
         (project_id, version_number, editor_state, transcript_id, schema_version, state_sha256, created_by,
          change_summary, restored_from_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, version_number, change_summary, created_at, restored_from_version_id`,
      [projectId, number, payload, transcriptId, SCHEMA_VERSION, stateHash(payload), userId, summaryText, restoredFrom ?? null],
    );
    await client.query('UPDATE projects SET current_version = $2 WHERE id = $1', [projectId, number]);
    return versionDto(rows[0]);
  }

  const versionDto = (v) => ({
    id: v.id,
    versionNumber: v.version_number,
    changeSummary: v.change_summary,
    createdAt: v.created_at,
    restoredFromVersionId: v.restored_from_version_id,
  });

  async function latestVersionHash(client, projectId) {
    const { rows } = await client.query(
      `SELECT state_sha256 FROM project_versions WHERE project_id = $1 ORDER BY version_number DESC LIMIT 1`,
      [projectId],
    );
    return rows[0]?.state_sha256 ?? null;
  }

  return {
    // ------------------------------------------------------------ create / read
    async create(userId, body) {
      const { source, transcript } = body;
      if (!up.allowedMimeTypes.includes(source.mimeType)) {
        throw new HttpError(415, 'UNSUPPORTED_MEDIA', 'Only MP4, WebM and MOV videos can be saved.');
      }
      const lower = source.filename.toLowerCase();
      if (!EXT_BY_MIME[source.mimeType].some((ext) => lower.endsWith(ext))) {
        throw new HttpError(415, 'UNSUPPORTED_MEDIA', 'The file extension does not match its video type.');
      }
      const limit = maxBytes();
      if (source.sizeBytes > limit) {
        throw new HttpError(413, 'FILE_TOO_LARGE', `Videos up to ${Math.floor(limit / 1024 ** 2)} MB can be saved.`, {
          maxBytes: limit,
        });
      }
      checkWords(transcript.words, source.durationS);
      const editorState = sanitizeEditorState(body.editorState, source.durationS);
      const words = transcript.words.map(({ id, text, start, end }) => ({ id, text, start, end }));

      return tx(pool, async (client) => {
        const projectId = crypto.randomUUID();
        const assetId = crypto.randomUUID();
        const transcriptId = crypto.randomUUID();
        const objectKey = `u/${userId}/p/${projectId}/source/${assetId}`;

        await client.query(
          `INSERT INTO projects (id, user_id, title, description, editor_state, schema_version)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [projectId, userId, body.title, body.description ?? null, editorState, SCHEMA_VERSION],
        );
        await client.query(
          `INSERT INTO transcripts (id, project_id, words, word_count, model, language, words_sha256)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            transcriptId,
            projectId,
            JSON.stringify(words),
            words.length,
            transcript.model ?? null,
            transcript.language ?? null,
            sha256Hex(stableStringify(words)),
          ],
        );
        await client.query(
          `INSERT INTO source_assets (id, project_id, user_id, provider, store, bucket, object_key, original_filename,
                                      mime_type, size_bytes, duration_s, width, height, sha256)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            assetId,
            projectId,
            userId,
            storage?.kind ?? 'none',
            storage?.store ?? 'none',
            storage?.bucket ?? 'unconfigured',
            objectKey,
            source.filename,
            source.mimeType,
            source.sizeBytes,
            source.durationS,
            source.width ?? null,
            source.height ?? null,
            source.sha256,
          ],
        );
        await client.query('UPDATE projects SET source_asset_id = $2, transcript_id = $3 WHERE id = $1', [
          projectId,
          assetId,
          transcriptId,
        ]);
        return summary(await lockProject(client, userId, projectId));
      });
    },

    async list(userId) {
      const { rows } = await pool.query(
        `SELECT p.*, a.id AS a_id, a.status AS a_status, a.size_bytes, a.duration_s, a.mime_type,
                a.original_filename, a.sha256, a.width, a.height
           FROM projects p LEFT JOIN source_assets a ON a.id = p.source_asset_id
          WHERE p.user_id = $1 AND p.status <> 'deleting'
          ORDER BY p.updated_at DESC
          LIMIT 500`,
        [userId],
      );
      return rows.map(summary);
    },

    async get(userId, projectId, { markOpened = false } = {}) {
      const { rows } = await pool.query(
        `SELECT p.*, a.id AS a_id, a.status AS a_status, a.size_bytes, a.duration_s, a.mime_type,
                a.original_filename, a.sha256, a.width, a.height,
                t.id AS t_id, t.words, t.model, t.language, t.words_sha256
           FROM projects p
           LEFT JOIN source_assets a ON a.id = p.source_asset_id
           LEFT JOIN transcripts t ON t.id = p.transcript_id
          WHERE p.id = $1 AND p.user_id = $2 AND p.status <> 'deleting'`,
        [projectId, userId],
      );
      const row = rows[0];
      if (!row) throw notFound();
      if (row.t_id && sha256Hex(stableStringify(row.words)) !== row.words_sha256) {
        throw new HttpError(500, 'TRANSCRIPT_CORRUPT', 'The saved transcript failed its integrity check.');
      }
      if (markOpened) {
        await pool.query('UPDATE projects SET last_opened_at = now() WHERE id = $1 AND user_id = $2', [projectId, userId]);
      }
      return {
        project: summary(row),
        transcript: row.t_id
          ? { id: row.t_id, words: row.words, model: row.model, language: row.language, wordsSha256: row.words_sha256 }
          : null,
        editorState: row.editor_state,
      };
    },

    // ------------------------------------------------------------ update
    async update(userId, projectId, body) {
      return tx(pool, async (client) => {
        const row = await lockProject(client, userId, projectId);
        checkRevision(row, body.baseRevision);
        const sets = [];
        const params = [projectId];
        if (body.editorState) {
          params.push(sanitizeEditorState(body.editorState, row.duration_s));
          sets.push(`editor_state = $${params.length}`);
        }
        if (body.title !== undefined) {
          params.push(body.title);
          sets.push(`title = $${params.length}`);
        }
        if (body.description !== undefined) {
          params.push(body.description);
          sets.push(`description = $${params.length}`);
        }
        const { rows } = await client.query(
          `UPDATE projects SET ${[...sets, 'revision = revision + 1', 'updated_at = now()'].join(', ')}
            WHERE id = $1 RETURNING revision, updated_at`,
          params,
        );
        return { revision: rows[0].revision, updatedAt: rows[0].updated_at };
      });
    },

    // ------------------------------------------------------------ delete
    async markDeleted(userId, projectId) {
      await tx(pool, async (client) => {
        await lockProject(client, userId, projectId);
        await client.query(`UPDATE projects SET status = 'deleting', updated_at = now() WHERE id = $1`, [projectId]);
        await client.query(`UPDATE source_assets SET status = 'deleting' WHERE project_id = $1`, [projectId]);
      });
      return purgeProject({ pool, storage }, projectId);
    },

    // ------------------------------------------------------------ source upload (any driver)
    /**
     * Start or resume uploading the original. Returns the driver's plan, which tells the
     * browser which protocol to use. `reupload` is only for an original that is missing
     * from storage (or lives in a store this server no longer uses): the record, key, size
     * and checksum stay the same, so only the identical file can be uploaded.
     */
    async startUpload(userId, projectId, { reupload = false } = {}) {
      const driver = requireStorage();
      return tx(pool, async (client) => {
        const row = await lockProject(client, userId, projectId);
        if (!row.a_id) throw new HttpError(409, 'NO_SOURCE', 'This project has no source video record.');
        await lockAsset(client, row.a_id);
        const asset = assetView(row);

        if (row.a_status === 'uploaded') {
          if (!reupload) throw new HttpError(409, 'ALREADY_UPLOADED', 'The original video is already saved.');
          if (row.store === driver.store && (await driver.head(asset))) {
            throw new HttpError(409, 'ALREADY_UPLOADED', 'The original video is already saved.');
          }
        }
        if (row.store !== driver.store) {
          if (row.a_status === 'uploaded') {
            // Moving to the current store; the old copy can't be reached from here.
            await client.query(`INSERT INTO storage_orphans (store, object_key, reason) VALUES ($1, $2, 'replaced by re-upload')`, [
              row.store,
              row.object_key,
            ]);
          }
          await client.query(
            `UPDATE source_assets SET provider = $2, store = $3, bucket = $4, upload_state = NULL, provider_meta = NULL WHERE id = $1`,
            [row.a_id, driver.kind, driver.store, driver.bucket],
          );
          row.upload_state = null;
        }
        if (asset.sizeBytes > maxBytes()) {
          throw new HttpError(413, 'FILE_TOO_LARGE', 'This video is larger than the current storage allows.', { maxBytes: maxBytes() });
        }

        const { state, plan } = await driver.begin(asset, row.upload_state, { reupload });
        await client.query(`UPDATE source_assets SET status = 'pending', upload_state = $2 WHERE id = $1`, [row.a_id, state]);
        return { ...plan, sizeBytes: asset.sizeBytes };
      });
    },

    /** S3 only: presigned URLs for some parts of the multipart upload. */
    async presignParts(userId, projectId, partNumbers) {
      const row = await tx(pool, (client) => lockProject(client, userId, projectId));
      const driver = driverFor(row);
      if (row.a_status !== 'pending' || !row.upload_state) {
        throw new HttpError(409, 'NO_UPLOAD_IN_PROGRESS', 'Start the upload first.');
      }
      const parts = await driver.signParts(assetView(row), row.upload_state, partNumbers);
      return { parts, expiresAt: new Date(Date.now() + up.uploadUrlTtlS * 1000).toISOString() };
    },

    async completeUpload(userId, projectId, report) {
      // Failures that update the asset (e.g. mark it failed) must commit that before the
      // error is reported, so they are returned from the transaction and thrown after.
      const result = await tx(pool, async (client) => {
        const row = await lockProject(client, userId, projectId);
        if (!row.a_id) throw new HttpError(409, 'NO_SOURCE', 'This project has no source video record.');
        const driver = driverFor(row);
        await lockAsset(client, row.a_id);
        if (row.a_status !== 'pending' || !row.upload_state) {
          throw new HttpError(409, 'NO_UPLOAD_IN_PROGRESS', 'There is no upload to complete.');
        }

        const done = await driver.finish(assetView(row), row.upload_state, report);
        if (!done.ok) {
          if (done.failed) {
            await client.query(`UPDATE source_assets SET status = 'failed', upload_state = NULL WHERE id = $1`, [row.a_id]);
          } else if (done.clearState) {
            await client.query(`UPDATE source_assets SET upload_state = NULL WHERE id = $1`, [row.a_id]);
          } else {
            throw done.error; // nothing to persist
          }
          return { fail: done.error };
        }

        await client.query(
          `UPDATE source_assets SET status = 'uploaded', uploaded_at = now(), upload_state = NULL, provider_meta = $2
            WHERE id = $1`,
          [row.a_id, done.meta ?? null],
        );
        // Only now is the project restorable.
        await client.query(`UPDATE projects SET status = 'active' WHERE id = $1`, [projectId]);
        if (row.current_version === 0) {
          await insertVersion(client, {
            projectId,
            number: 1,
            payload: versionPayload(row.editor_state),
            transcriptId: row.transcript_id,
            userId,
            summaryText: 'First save',
          });
        }
        return { project: summary(await lockProject(client, userId, projectId)) };
      });
      if (result.fail) throw result.fail;
      return result.project;
    },

    async abortUpload(userId, projectId) {
      await tx(pool, async (client) => {
        const row = await lockProject(client, userId, projectId);
        if (!row.a_id || !row.upload_state || !storage || row.store !== storage.store) return;
        await lockAsset(client, row.a_id);
        await storage.abort(assetView(row), row.upload_state);
        await client.query(`UPDATE source_assets SET upload_state = NULL WHERE id = $1`, [row.a_id]);
      });
    },

    /** Look up an owned, fully uploaded original and confirm it is really there. */
    async locateSource(userId, projectId) {
      const { rows } = await pool.query(
        `SELECT a.* FROM projects p JOIN source_assets a ON a.id = p.source_asset_id
          WHERE p.id = $1 AND p.user_id = $2 AND p.status <> 'deleting'`,
        [projectId, userId],
      );
      const a = rows[0];
      if (!a) throw notFound();
      if (a.status !== 'uploaded') {
        throw new HttpError(409, 'SOURCE_NOT_UPLOADED', 'The original video was never fully uploaded.');
      }
      const driver = driverFor(a);
      const asset = assetView(a);
      const head = await driver.head(asset);
      if (!head) throw new HttpError(410, 'SOURCE_MISSING', 'The original video is missing from storage.');
      if (head.size !== asset.sizeBytes) {
        throw new HttpError(409, 'SOURCE_CORRUPT', 'The stored video does not match the saved file size.');
      }
      return { driver, asset, sha256: a.sha256 };
    },

    async downloadUrl(userId, projectId) {
      const { driver, asset, sha256 } = await this.locateSource(userId, projectId);
      return {
        url: await driver.downloadUrl(asset, { ttl: up.downloadUrlTtlS }),
        // Same-origin fallback that streams through the API, for stores the browser can't
        // fetch directly (e.g. missing CORS). Needs the Authorization header.
        streamPath: `/projects/${projectId}/source/content`,
        expiresAt: new Date(Date.now() + up.downloadUrlTtlS * 1000).toISOString(),
        filename: asset.filename,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        sha256,
      };
    },

    async openSourceStream(userId, projectId) {
      const { driver, asset } = await this.locateSource(userId, projectId);
      const stream = await driver.openStream(asset);
      if (!stream) throw new HttpError(410, 'SOURCE_MISSING', 'The original video is missing from storage.');
      return { ...stream, filename: asset.filename };
    },

    // ------------------------------------------------------------ versions
    async listVersions(userId, projectId) {
      const owned = await pool.query(`SELECT 1 FROM projects WHERE id = $1 AND user_id = $2 AND status <> 'deleting'`, [
        projectId,
        userId,
      ]);
      if (!owned.rows.length) throw notFound();
      const { rows } = await pool.query(
        `SELECT id, version_number, change_summary, created_at, restored_from_version_id
           FROM project_versions WHERE project_id = $1 ORDER BY version_number DESC LIMIT 200`,
        [projectId],
      );
      return rows.map(versionDto);
    },

    /** Explicit save: optionally write the latest state, then checkpoint it (skipped if unchanged). */
    async createVersion(userId, projectId, { baseRevision, editorState, changeSummary }) {
      return tx(pool, async (client) => {
        let row = await lockProject(client, userId, projectId);
        if (row.status !== 'active') {
          throw new HttpError(409, 'NOT_RESTORABLE', 'Finish uploading the original video before saving versions.');
        }
        checkRevision(row, baseRevision);
        let revision = row.revision;
        let state = row.editor_state;
        if (editorState) {
          state = sanitizeEditorState(editorState, row.duration_s);
          const upd = await client.query(
            `UPDATE projects SET editor_state = $2, revision = revision + 1, updated_at = now()
              WHERE id = $1 RETURNING revision`,
            [projectId, state],
          );
          revision = upd.rows[0].revision;
        }
        const payload = versionPayload(state);
        if ((await latestVersionHash(client, projectId)) === stateHash(payload)) {
          return { revision, version: null, unchanged: true };
        }
        const version = await insertVersion(client, {
          projectId,
          number: row.current_version + 1,
          payload,
          transcriptId: row.transcript_id,
          userId,
          summaryText: changeSummary ?? 'Saved',
        });
        return { revision, version, unchanged: false };
      });
    },

    /**
     * Restore an old version without destroying anything: the current state is
     * checkpointed first (if it isn't already), then the old cut list is written as a
     * new version and becomes the current state. The previous cut list is pushed onto
     * the undo history, mirroring the editor's own commit().
     */
    async restoreVersion(userId, projectId, versionId, { baseRevision }) {
      return tx(pool, async (client) => {
        const row = await lockProject(client, userId, projectId);
        checkRevision(row, baseRevision);
        const { rows } = await client.query(
          `SELECT * FROM project_versions WHERE id = $1 AND project_id = $2`,
          [versionId, projectId],
        );
        const v = rows[0];
        if (!v) throw notFound('Version');
        if (stateHash(v.editor_state) !== v.state_sha256) {
          throw new HttpError(500, 'VERSION_CORRUPT', 'That version failed its integrity check and was not restored.');
        }
        if (v.transcript_id !== row.transcript_id) {
          throw new HttpError(409, 'VERSION_MISMATCH', 'That version belongs to a different transcript.');
        }
        const restored = sanitizeEditorState({ removedRanges: v.editor_state.removedRanges }, row.duration_s);

        let number = row.current_version;
        const current = versionPayload(row.editor_state);
        if ((await latestVersionHash(client, projectId)) !== stateHash(current)) {
          number += 1;
          await insertVersion(client, {
            projectId,
            number,
            payload: current,
            transcriptId: row.transcript_id,
            userId,
            summaryText: `Before restoring version ${v.version_number}`,
          });
        }
        number += 1;
        const version = await insertVersion(client, {
          projectId,
          number,
          payload: versionPayload(restored),
          transcriptId: row.transcript_id,
          userId,
          summaryText: `Restored version ${v.version_number}`,
          restoredFrom: v.id,
        });

        const prevHistory = row.editor_state.history ?? { past: [], future: [] };
        const editorState = {
          removedRanges: restored.removedRanges,
          history: { past: [...prevHistory.past, current.removedRanges].slice(-HISTORY_LIMIT), future: [] },
        };
        const upd = await client.query(
          `UPDATE projects SET editor_state = $2, revision = revision + 1, updated_at = now()
            WHERE id = $1 RETURNING revision`,
          [projectId, editorState],
        );
        return { revision: upd.rows[0].revision, editorState, version };
      });
    },
  };
}

/**
 * Remove storage objects for a project marked 'deleting', then its rows. Idempotent;
 * if storage fails the project stays 'deleting' (hidden) and cleanup retries later.
 * Objects in a store this server no longer uses are recorded in storage_orphans.
 */
export async function purgeProject({ pool, storage }, projectId) {
  const { rows: assets } = await pool.query(
    `SELECT a.* FROM source_assets a JOIN projects p ON p.id = a.project_id
      WHERE a.project_id = $1 AND p.status = 'deleting'`,
    [projectId],
  );
  try {
    for (const a of assets) {
      // An upload that never started or finished may have left nothing behind.
      if (!a.upload_state && !a.uploaded_at) continue;
      if (!storage || a.store !== storage.store) {
        await pool.query(`INSERT INTO storage_orphans (store, object_key, reason) VALUES ($1, $2, 'project deleted')`, [
          a.store,
          a.object_key,
        ]);
        continue;
      }
      if (a.upload_state) await storage.abort(assetView(a), a.upload_state);
      await storage.remove(assetView(a));
    }
  } catch (err) {
    console.warn(`[cleanup] storage delete for project ${projectId} failed, will retry:`, err.message);
    return { deleted: false };
  }
  await pool.query(`DELETE FROM projects WHERE id = $1 AND status = 'deleting'`, [projectId]);
  return { deleted: true };
}
