import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { errorHandler, HttpError } from './http.js';
import { createTokenService } from './auth/tokens.js';
import { requireAuth, clientIp } from './auth/middleware.js';
import { normalizeEmail } from './auth/passwords.js';
import { createAuthRouter } from './auth/routes.js';
import { createProjectService } from './projects/service.js';
import { createProjectsRouter } from './projects/routes.js';

function limiter({ windowMs, limit, key }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: key,
    validate: false, // our key generator handles proxies itself (see clientIp)
    handler: (_req, res) =>
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes.' } }),
  });
}

/**
 * @param {{ config, pool, storage?, verifyGoogle?, rateLimits? }} deps
 *   storage: a storage driver (src/storage/index.js) or a test fake; null disables cloud media endpoints.
 *   verifyGoogle: credential -> { sub, email, emailVerified, name }; null disables Google.
 */
export function createApp({ config, pool, storage = null, verifyGoogle = null, rateLimits = {} }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  app.use(express.json({ limit: '12mb' }));
  app.use(cookieParser());
  app.use(clientIp(config));

  const tokens = createTokenService(config.auth);
  const signedIn = requireAuth({ tokens, pool });
  const fifteenMin = 15 * 60_000;
  const limiters = {
    auth: limiter({ windowMs: fifteenMin, limit: rateLimits.auth ?? 30, key: (req) => `ip:${req.clientIp}` }),
    loginEmail: limiter({
      windowMs: fifteenMin,
      limit: rateLimits.loginEmail ?? 10,
      key: (req) => `email:${normalizeEmail(req.body?.email)}`,
    }),
    refresh: limiter({ windowMs: 60_000, limit: rateLimits.refresh ?? 60, key: (req) => `ip:${req.clientIp}` }),
  };

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({
      ok: true,
      storage: storage ? { kind: storage.kind, maxBytes: Math.min(config.uploads.maxBytes, storage.maxBytes ?? Infinity) } : null,
      google: Boolean(verifyGoogle),
    });
  });

  app.use('/api/auth', createAuthRouter({ pool, config, tokens, verifyGoogle, limiters }));
  const service = createProjectService({ pool, storage, config });
  app.use('/api/projects', createProjectsRouter({ service, signedIn }));

  app.use('/api', () => {
    throw new HttpError(404, 'NOT_FOUND', 'Unknown API route.');
  });
  app.use(errorHandler);
  return app;
}
