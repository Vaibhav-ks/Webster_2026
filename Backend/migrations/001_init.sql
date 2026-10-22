-- The Scarlet Rewrite: users, sessions, saved projects.
--
-- Design notes
-- * The editor's single source of truth for edits is `removedRanges`. It lives in
--   projects.editor_state (current) and project_versions.editor_state (checkpoints).
--   There are no per-edit rows that could drift from it.
-- * The transcript (Whisper output) is stored once per project and is immutable.
-- * The original video lives in R2. source_assets keeps the private object key,
--   never a public URL.
-- * A project's source asset can be set once and never swapped: a different video
--   means a different project (timestamps and cuts would not match).

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  display_name   text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  password_hash  text,
  google_sub     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_google_sub_unique UNIQUE (google_sub),
  CONSTRAINT users_has_login_method CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL)
);

-- ---------------------------------------------------------------- refresh sessions
-- One row per issued refresh token. Rotation revokes the old row and points it at
-- the new one; all rows of one login share a family_id. Only a SHA-256 hash of the
-- token is stored.
CREATE TABLE auth_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id         uuid NOT NULL,
  token_hash        bytea NOT NULL UNIQUE,
  expires_at        timestamptz NOT NULL,
  family_expires_at timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  revoked_reason    text CHECK (revoked_reason IN ('rotated', 'logout', 'reuse', 'expired')),
  replaced_by       uuid REFERENCES auth_sessions(id) ON DELETE SET NULL,
  user_agent        text
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_family_active_idx ON auth_sessions (family_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- projects
CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description     text CHECK (description IS NULL OR char_length(description) <= 2000),
  -- draft: source upload not finished (not restorable); active: restorable;
  -- deleting: hidden, storage cleanup in progress
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'deleting')),
  source_asset_id uuid,
  transcript_id   uuid,
  -- { removedRanges: [{start,end}], history: { past: [...], future: [...] } }
  editor_state    jsonb NOT NULL,
  revision        integer NOT NULL DEFAULT 1,   -- optimistic concurrency token
  schema_version  integer NOT NULL,
  current_version integer NOT NULL DEFAULT 0,   -- latest project_versions.version_number
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_opened_at  timestamptz
);
CREATE INDEX projects_user_updated_idx ON projects (user_id, updated_at DESC);

-- ---------------------------------------------------------------- source media
CREATE TABLE source_assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            text NOT NULL DEFAULT 'r2',
  bucket              text NOT NULL,
  object_key          text NOT NULL UNIQUE,
  original_filename   text NOT NULL CHECK (char_length(original_filename) BETWEEN 1 AND 255),
  mime_type           text NOT NULL,
  size_bytes          bigint NOT NULL CHECK (size_bytes > 0),
  duration_s          double precision NOT NULL CHECK (duration_s > 0),
  width               integer,
  height              integer,
  sha256              char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'failed', 'deleting')),
  multipart_upload_id text,
  part_size           integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  uploaded_at         timestamptz,
  deleted_at          timestamptz
);
CREATE INDEX source_assets_project_idx ON source_assets (project_id);
CREATE INDEX source_assets_pending_idx ON source_assets (created_at) WHERE status IN ('pending', 'failed');

-- ---------------------------------------------------------------- transcripts
CREATE TABLE transcripts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  words        jsonb NOT NULL,          -- [{ id, text, start, end }], as produced by Whisper
  word_count   integer NOT NULL,
  model        text,
  language     text,
  words_sha256 char(64) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transcripts_project_idx ON transcripts (project_id);

-- ---------------------------------------------------------------- versions
-- Checkpoints of editor_state (removedRanges only; undo history is not versioned).
CREATE TABLE project_versions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_number          integer NOT NULL CHECK (version_number > 0),
  editor_state            jsonb NOT NULL,
  transcript_id           uuid NOT NULL REFERENCES transcripts(id),
  schema_version          integer NOT NULL,
  state_sha256            char(64) NOT NULL,
  created_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  change_summary          text CHECK (change_summary IS NULL OR char_length(change_summary) <= 200),
  restored_from_version_id uuid REFERENCES project_versions(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_versions_number_unique UNIQUE (project_id, version_number)
);

-- ---------------------------------------------------------------- cross references
ALTER TABLE projects
  ADD CONSTRAINT projects_source_asset_fk FOREIGN KEY (source_asset_id)
    REFERENCES source_assets(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT projects_transcript_fk FOREIGN KEY (transcript_id)
    REFERENCES transcripts(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------- integrity guards
-- Transcripts and versions are append-only.
CREATE FUNCTION reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER transcripts_immutable BEFORE UPDATE ON transcripts
  FOR EACH ROW EXECUTE FUNCTION reject_update();
CREATE TRIGGER project_versions_immutable BEFORE UPDATE ON project_versions
  FOR EACH ROW EXECUTE FUNCTION reject_update();

-- A project's source and transcript can be set once, never swapped for others.
-- (Clearing them happens only through ON DELETE SET NULL while the project is deleted.)
CREATE FUNCTION guard_project_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_asset_id IS NOT NULL AND NEW.source_asset_id IS DISTINCT FROM OLD.source_asset_id
     AND NEW.source_asset_id IS NOT NULL THEN
    RAISE EXCEPTION 'project source cannot be replaced; create a new project' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.transcript_id IS NOT NULL AND NEW.transcript_id IS DISTINCT FROM OLD.transcript_id
     AND NEW.transcript_id IS NOT NULL THEN
    RAISE EXCEPTION 'project transcript cannot be replaced' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER projects_source_guard BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION guard_project_source();

-- Immutable source facts: once uploaded, an asset's key, size and checksum never change.
CREATE FUNCTION guard_asset_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.object_key <> OLD.object_key OR NEW.size_bytes <> OLD.size_bytes OR NEW.sha256 <> OLD.sha256
     OR NEW.project_id <> OLD.project_id OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'source asset identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER source_assets_identity_guard BEFORE UPDATE ON source_assets
  FOR EACH ROW EXECUTE FUNCTION guard_asset_identity();
