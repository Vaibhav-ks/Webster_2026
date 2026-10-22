import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';
import { createStorage } from './storage/index.js';
import { createGoogleVerifier } from './auth/google.js';
import { startCleanup } from './maintenance/cleanup.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const pool = createPool(config.databaseUrl);
const storage = createStorage(config.storage);
if (storage) console.log(`[api] video storage: ${storage.store}`);
else console.warn('[api] STORAGE_DRIVER=none: saving original videos is disabled.');
const verifyGoogle = createGoogleVerifier(config.auth.googleClientId);
if (!verifyGoogle) console.warn('[api] GOOGLE_CLIENT_ID is not set: Google sign-in is disabled.');

const app = createApp({ config, pool, storage, verifyGoogle });
const stopCleanup = startCleanup({ pool, storage, config });
const server = app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));

function shutdown() {
  stopCleanup();
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
