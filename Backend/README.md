# Scarlet Rewrite API (optional)

Accounts and saved projects for The Scarlet Rewrite. The editor works fully without it:
guests upload, transcribe, edit, preview and export entirely in the browser, and nothing
is sent anywhere. This API only comes into play when a signed-in user clicks **Save**.

- **Express 5** on Node 20+, plain JavaScript (ES modules)
- **PostgreSQL** (any host: Docker locally, Neon in production) via `pg` + SQL migrations
- **Pluggable video storage** (`STORAGE_DRIVER`): any S3-compatible store (Cloudflare R2,
  AWS S3, Backblaze B2, Wasabi, MinIO ...) or Cloudinary. Uploads go straight from the
  browser to the store; the API only signs and verifies
- Auth: email/password (argon2id) and Google Identity Services, short-lived JWT access
  tokens + rotating, revocable refresh tokens in an HttpOnly cookie

## Run locally

```bash
docker compose up -d db                 # from the repo root: Postgres 16 on :5432
cd Backend
cp .env.example .env                    # then fill in JWT_ACCESS_SECRET (and storage / Google if you have them)
npm install
npm run migrate                         # creates tables; never drops anything
npm run dev                             # http://localhost:4000/api/health

cd ../Frontend && npm install && npm run dev   # Vite proxies /api to :4000
```

Without storage settings (`STORAGE_DRIVER=none`) the API still runs: sign-in works, but
saving a project's video returns `503 STORAGE_DISABLED`. Without `GOOGLE_CLIENT_ID`, Google sign-in is hidden.

### Tests

```bash
TEST_DATABASE_URL=postgres://scarlet:scarlet@localhost:5432/postgres npm test
```

Each test file creates and drops its own database, so the real constraints, triggers and
transactions are exercised. Storage tests run the real S3 driver against an in-memory S3
client, and the Cloudinary driver against a fake SDK; Google is faked.
`node --test test/config.test.js` needs no database or packages.

## Data model

| Table | Holds |
| --- | --- |
| `users` | one row per person; `password_hash` and/or `google_sub` (both unique, never merged by email) |
| `auth_sessions` | SHA-256 of each refresh token, its family, expiry and revocation |
| `projects` | owner, title, `editor_state` (removedRanges + undo history, jsonb), `revision`, status |
| `source_assets` | provider + `store` it lives in, private object key, filename, type, size, duration, SHA-256, upload status |
| `storage_orphans` | objects that couldn't be deleted because their store is no longer configured |
| `transcripts` | Whisper's words (jsonb), immutable, hashed |
| `project_versions` | checkpoints of `removedRanges` only, immutable, hashed |

Integrity rules enforced by the database itself: transcripts and versions can't be
updated; a project's source and transcript can be set once and never swapped (a
different video is a new project); an asset's key, size and checksum never change.

## API

All `/api/projects/*` routes need `Authorization: Bearer <access token>` and only see
the caller's own projects (anything else is a 404).

| Method & path | Purpose |
| --- | --- |
| `POST /api/auth/register` · `login` · `google` | sign in; `google` returns `409 LINK_REQUIRED` if the email already has an account |
| `POST /api/auth/google/link` | link Google to the signed-in account (needs the account password) |
| `POST /api/auth/refresh` · `logout` | cookie + `Origin` + `X-Scarlet-CSRF: 1` |
| `GET /api/auth/me` | current user |
| `POST /api/projects` | create (draft) with transcript, edit state and source metadata |
| `GET /api/projects` · `GET /api/projects/:id` | list · full state (`?open=1` marks it opened) |
| `PATCH /api/projects/:id` | autosave; `baseRevision` must match or `409 REVISION_CONFLICT` |
| `DELETE /api/projects/:id` | deletes the stored original and all rows (`202` if storage cleanup must retry) |
| `POST /api/projects/:id/source/upload` | start or resume the upload; returns the store's plan (`s3-multipart` or `cloudinary-chunked`). `{ reupload: true }` after loss or a store change |
| `POST /api/projects/:id/source/parts` | S3 only: presigned URLs for up to 100 parts |
| `POST /api/projects/:id/source/complete` | the driver verifies the stored object (S3: every part + size; Cloudinary: Admin API size), then activates the project |
| `POST /api/projects/:id/source/abort` | cancel an upload |
| `POST /api/projects/:id/source/download-url` | 10-minute download URL (`410 SOURCE_MISSING`, `409 SOURCE_IN_OTHER_STORE`) |
| `GET /api/projects/:id/source/content` | same-origin stream of the original, used when the browser can't fetch the store directly |
| `GET/POST /api/projects/:id/versions` | list · checkpoint (optionally with the latest state) |
| `POST /api/projects/:id/versions/:vid/restore` | restore as a new version; nothing is deleted |

## External services

### Google sign-in
1. Google Cloud Console → APIs & Services → Credentials → *Create OAuth client ID* → Web application.
2. Authorized JavaScript origins: `http://localhost:5173`, and your Pages domain (e.g. `https://scarlet-rewrite.pages.dev`).
   No redirect URIs are needed (popup mode).
3. Put the client ID in `GOOGLE_CLIENT_ID` (API) and `VITE_GOOGLE_CLIENT_ID` (frontend).

### Video storage

Pick one with `STORAGE_DRIVER` (see `.env.example`). The browser uploads straight to the
store and never sees credentials; the server signs requests and verifies the result.
Every original also gets a SHA-256 before upload, checked again after every download.

**Any S3-compatible store** (`STORAGE_DRIVER=s3`): Cloudflare R2, AWS S3, Backblaze B2,
Wasabi, DigitalOcean Spaces, MinIO, Supabase Storage (S3 endpoint) ...
1. Create a **private** bucket and an access key limited to it (read + write objects).
2. Set `S3_ENDPOINT` (empty for AWS), `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
3. Bucket **CORS** (browsers upload and download directly):
   ```json
   [
     {
       "AllowedOrigins": ["http://localhost:5173", "https://scarlet-rewrite.pages.dev"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["content-type"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   `ExposeHeaders: ETag` is required: the browser needs each part's ETag to finish a multipart upload.
4. **Lifecycle rule**: abort incomplete multipart uploads after 1 day (most S3-compatible
   stores support it). The API also expires unfinished drafts after `PENDING_UPLOAD_TTL_HOURS`.

Cost note: every time a project is reopened, the full original is downloaded. R2 has no
egress fees; on AWS S3 those downloads are billed.

**Cloudinary** (`STORAGE_DRIVER=cloudinary`):
1. Copy the API environment variable from the Cloudinary console into `CLOUDINARY_URL`.
2. Set `CLOUDINARY_MAX_UPLOAD_BYTES` to your plan's video limit (free plan: 100 MB).
3. Nothing else to configure: uploads are signed per request (public ID, `private`
   delivery type and `overwrite=false` are fixed by the server), chunked in 20 MB pieces,
   and verified through the Admin API. Downloads use signed, expiring private-download URLs.
- Cloudinary keeps the original upload. Downloads are checked against the saved SHA-256, so
  if a plan ever served altered bytes the app would refuse them rather than trust them.
- If the browser can't fetch Cloudinary's download URL directly (CORS), it automatically
  falls back to `GET /api/projects/:id/source/content`, which streams the file through the
  API. That works everywhere but uses your API host's bandwidth.
- An interrupted Cloudinary upload restarts from the beginning (Cloudinary has no way to
  list which chunks it already has); S3 uploads resume from the parts already stored.

**Switching storage later.** Every saved original remembers which store it is in. After you
change `STORAGE_DRIVER` or the bucket, projects saved before keep working only as follows:
- Opening one shows *"the original is in a storage service this app no longer uses"* and
  offers to pick the original file from the device. Only the identical file (same SHA-256)
  is accepted; it is then uploaded to the new store under the same record.
- Deleting one removes its rows and records the old object in `storage_orphans`, so it can
  be cleaned up by hand (`SELECT * FROM storage_orphans`).
- To move everything at once instead, copy the objects (same keys) into the new store
  (e.g. `rclone copy`), then
  `UPDATE source_assets SET store = '<new store id>', provider = 's3'` for the copied rows.
  The store id is printed when the API starts (`[api] video storage: ...`).

### Neon (PostgreSQL)
Create a project, copy the connection string (with `sslmode=require`) into `DATABASE_URL`,
and run `npm run migrate` once from your machine or as a Render pre-deploy command.
Nothing in the code is Neon-specific; any PostgreSQL 13+ with the `citext` extension works.

### Render (API) and Cloudflare Pages (frontend)
- Render web service: root `Backend`, build `npm ci`, pre-deploy `npm run migrate`, start `npm start`,
  health check `/api/health`. Set `NODE_ENV=production`, the storage variables, all the variables above, and
  `APP_ORIGINS=https://<your-pages-domain>`.
- Cloudflare Pages: root `Frontend`, build `npm run build`, output `dist`. The function in
  `Frontend/functions/api/[[path]].js` proxies `/api/*` to Render; set `API_ORIGIN` (Render URL)
  and `PROXY_SHARED_SECRET` (same as the API). Set `VITE_GOOGLE_CLIENT_ID` as a build variable.
- Because the browser only talks to the Pages origin, cookies are first-party and no CORS
  configuration is needed on the API. Switching API hosts later only means changing `API_ORIGIN`.

## Security notes
- Passwords: argon2id; never logged; login errors don't reveal whether an email exists.
  Registration does say "email already in use", which is accepted for usability.
- Access tokens: 15 min, memory only in the browser; checked against the session on
  every request, so logout and token-theft detection take effect immediately.
- Refresh tokens: 30 days sliding, 90 days absolute, rotated on every use; replaying an
  old one revokes the whole session family.
- Rate limits are in-memory (per instance). With several API instances, move them to a shared store.
