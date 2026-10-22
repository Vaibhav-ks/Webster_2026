-- Provider-neutral source storage.
--
-- * store:         which configured store holds the object ("s3:<host>/<bucket>",
--                  "cloudinary:<cloud>"). Lets the server recognise originals saved in a
--                  store it no longer uses after STORAGE_DRIVER changes.
-- * upload_state:  driver-specific state of an in-progress upload (S3 multipart id and part
--                  size, Cloudinary chunked-upload id ...). Replaces multipart_upload_id/part_size.
-- * provider_meta: driver-specific facts about the stored object (e.g. Cloudinary format).
-- * storage_orphans: objects the API could not delete because their store is no longer
--                  configured. Never silently forgotten; clean them up by hand.

ALTER TABLE source_assets
  ADD COLUMN store text,
  ADD COLUMN upload_state jsonb,
  ADD COLUMN provider_meta jsonb;

UPDATE source_assets
   SET store = provider || ':' || bucket,
       upload_state = CASE WHEN multipart_upload_id IS NOT NULL
                           THEN jsonb_build_object('uploadId', multipart_upload_id, 'partSize', part_size) END;

ALTER TABLE source_assets
  ALTER COLUMN store SET NOT NULL,
  ALTER COLUMN provider DROP DEFAULT,
  DROP COLUMN multipart_upload_id,
  DROP COLUMN part_size;

CREATE TABLE storage_orphans (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store      text NOT NULL,
  object_key text NOT NULL,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
