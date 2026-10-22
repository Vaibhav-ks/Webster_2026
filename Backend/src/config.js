// All configuration comes from environment variables. Secrets never have defaults.
// loadConfig() throws a single readable error listing everything that is missing.

const MiB = 1024 * 1024;

function int(name, fallback, env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function list(raw) {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const production = nodeEnv === 'production';
  const problems = [];
  const required = (name) => {
    const v = env[name];
    if (!v) problems.push(`${name} is required`);
    return v;
  };

  const config = {
    nodeEnv,
    production,
    port: int('PORT', 4000, env),
    // Number of proxy hops in front of Express (Render's load balancer = 1).
    trustProxy: int('TRUST_PROXY', production ? 1 : 0, env),

    databaseUrl: required('DATABASE_URL'),

    auth: {
      accessSecret: required('JWT_ACCESS_SECRET'),
      accessTtlS: int('ACCESS_TOKEN_TTL_S', 15 * 60, env),
      refreshTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 30, env),
      // Origins allowed to call the cookie-authenticated endpoints (refresh, logout).
      appOrigins: list(env.APP_ORIGINS),
      cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : production,
      googleClientId: env.GOOGLE_CLIENT_ID || null,
    },

    // Shared secret set by the Cloudflare Pages Function proxy so the API can trust
    // its X-Client-IP header for rate limiting. Optional.
    proxySharedSecret: env.PROXY_SHARED_SECRET || null,

    storage: storageConfig(env, { int, problems }),

    uploads: {
      maxBytes: int('MAX_UPLOAD_BYTES', 2 * 1024 * MiB, env),
      partSize: int('UPLOAD_PART_SIZE', 16 * MiB, env),
      uploadUrlTtlS: int('UPLOAD_URL_TTL_S', 15 * 60, env),
      downloadUrlTtlS: int('DOWNLOAD_URL_TTL_S', 10 * 60, env),
      pendingTtlHours: int('PENDING_UPLOAD_TTL_HOURS', 24, env),
      allowedMimeTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
    },

    cleanupIntervalMin: int('CLEANUP_INTERVAL_MIN', 15, env),
  };

  if (config.auth.accessSecret && config.auth.accessSecret.length < 32) {
    problems.push('JWT_ACCESS_SECRET must be at least 32 characters');
  }
  if (!config.auth.appOrigins.length) problems.push('APP_ORIGINS is required (e.g. http://localhost:5173)');
  if (config.uploads.partSize < 5 * MiB) problems.push('UPLOAD_PART_SIZE must be at least 5 MiB (S3/R2 minimum)');
  if (production && config.storage.driver === 'none') {
    problems.push('No video storage configured: set STORAGE_DRIVER=s3 or cloudinary (or STORAGE_DRIVER=none explicitly)');
  }
  // The S3 part size and the Cloudinary chunk size come from the shared upload settings.
  if (config.storage.s3) Object.assign(config.storage.s3, { partSize: config.uploads.partSize, uploadUrlTtlS: config.uploads.uploadUrlTtlS });

  if (problems.length) throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  return config;
}

/**
 * STORAGE_DRIVER = s3 | cloudinary | none.
 * Unset: "s3" when S3_* (or the older R2_*) variables are present, otherwise "none".
 */
function storageConfig(env, { int, problems }) {
  const e = (name, legacy) => env[name] || (legacy ? env[legacy] : '') || '';
  const r2Endpoint = env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '';
  const s3Endpoint = e('S3_ENDPOINT', 'R2_ENDPOINT') || r2Endpoint;
  const hasS3 = Boolean(e('S3_BUCKET', 'R2_BUCKET'));
  const hasCloudinary = Boolean(env.CLOUDINARY_URL || env.CLOUDINARY_CLOUD_NAME);
  const driver = (env.STORAGE_DRIVER || (hasS3 ? 's3' : hasCloudinary ? 'cloudinary' : 'none')).toLowerCase();
  const out = { driver, s3: null, cloudinary: null };

  if (driver === 's3') {
    out.s3 = {
      endpoint: s3Endpoint || null, // empty = AWS S3
      region: e('S3_REGION', 'R2_REGION') || (s3Endpoint ? 'auto' : ''),
      bucket: e('S3_BUCKET', 'R2_BUCKET'),
      accessKeyId: e('S3_ACCESS_KEY_ID', 'R2_ACCESS_KEY_ID'),
      secretAccessKey: e('S3_SECRET_ACCESS_KEY', 'R2_SECRET_ACCESS_KEY'),
      // Path-style URLs work everywhere except AWS, which prefers virtual-hosted style.
      forcePathStyle: env.S3_FORCE_PATH_STYLE ? env.S3_FORCE_PATH_STYLE === 'true' : Boolean(s3Endpoint),
      maxBytes: env.S3_MAX_UPLOAD_BYTES ? int('S3_MAX_UPLOAD_BYTES', null, env) : null,
    };
    for (const k of ['region', 'bucket', 'accessKeyId', 'secretAccessKey']) {
      if (!out.s3[k]) problems.push(`STORAGE_DRIVER=s3 needs S3_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);
    }
  } else if (driver === 'cloudinary') {
    // CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>, or the three variables.
    let fromUrl = {};
    if (env.CLOUDINARY_URL) {
      try {
        const u = new URL(env.CLOUDINARY_URL);
        fromUrl = { cloudName: u.hostname, apiKey: decodeURIComponent(u.username), apiSecret: decodeURIComponent(u.password) };
      } catch {
        problems.push('CLOUDINARY_URL must look like cloudinary://<api_key>:<api_secret>@<cloud_name>');
      }
    }
    out.cloudinary = {
      cloudName: env.CLOUDINARY_CLOUD_NAME || fromUrl.cloudName || '',
      apiKey: env.CLOUDINARY_API_KEY || fromUrl.apiKey || '',
      apiSecret: env.CLOUDINARY_API_SECRET || fromUrl.apiSecret || '',
      deliveryType: env.CLOUDINARY_DELIVERY_TYPE || 'private',
      chunkSize: int('CLOUDINARY_CHUNK_SIZE', 20 * MiB, env),
      // Free plans cap video uploads at 100 MB; raise this to your plan's limit.
      maxBytes: int('CLOUDINARY_MAX_UPLOAD_BYTES', 100 * 1000 * 1000, env),
    };
    for (const [k, name] of [['cloudName', 'CLOUDINARY_CLOUD_NAME'], ['apiKey', 'CLOUDINARY_API_KEY'], ['apiSecret', 'CLOUDINARY_API_SECRET']]) {
      if (!out.cloudinary[k]) problems.push(`STORAGE_DRIVER=cloudinary needs ${name} (or CLOUDINARY_URL)`);
    }
    if (!['private', 'authenticated'].includes(out.cloudinary.deliveryType)) {
      problems.push('CLOUDINARY_DELIVERY_TYPE must be "private" or "authenticated" (never public "upload")');
    }
    if (out.cloudinary.chunkSize <= 5 * MiB) problems.push('CLOUDINARY_CHUNK_SIZE must be larger than 5 MiB');
  } else if (driver !== 'none') {
    problems.push(`STORAGE_DRIVER must be s3, cloudinary or none (got "${driver}")`);
  }
  return out;
}
