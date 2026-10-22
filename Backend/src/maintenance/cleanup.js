// Periodic, in-process cleanup (no queue needed at this scale):
//  1. Drafts whose source upload never finished within PENDING_UPLOAD_TTL_HOURS are
//     marked 'deleting' (their multipart uploads are aborted, rows removed).
//  2. Projects stuck in 'deleting' (storage was unreachable at delete time) are retried.
// Also configure an R2 lifecycle rule that aborts incomplete multipart uploads after
// 1 day, as a second safety net (see Backend/README.md).

import { purgeProject } from '../projects/service.js';

export async function sweep({ pool, storage, config }) {
  const stale = await pool.query(
    `UPDATE projects p SET status = 'deleting'
       FROM source_assets a
      WHERE a.id = p.source_asset_id
        AND p.status = 'draft'
        AND a.status IN ('pending', 'failed')
        AND a.created_at < now() - make_interval(hours => $1)
        AND p.updated_at < now() - make_interval(hours => $1)
      RETURNING p.id`,
    [config.uploads.pendingTtlHours],
  );
  const { rows } = await pool.query(
    `SELECT id FROM projects WHERE status = 'deleting' AND updated_at < now() - interval '1 minute'
     UNION SELECT unnest($1::uuid[])`,
    [stale.rows.map((r) => r.id)],
  );
  let purged = 0;
  for (const { id } of rows) {
    if ((await purgeProject({ pool, storage }, id)).deleted) purged++;
  }
  return { expiredDrafts: stale.rows.length, purged };
}

export function startCleanup(deps) {
  const run = () =>
    sweep(deps)
      .then((r) => r.purged && console.log(`[cleanup] purged ${r.purged} project(s)`))
      .catch((err) => console.warn('[cleanup] sweep failed:', err.message));
  const timer = setInterval(run, deps.config.cleanupIntervalMin * 60_000);
  timer.unref();
  setTimeout(run, 10_000).unref();
  return () => clearInterval(timer);
}
