import { HttpError } from '../http.js';
import { isFamilyActive } from './tokens.js';

/** Bearer access token -> req.auth = { userId, familyId }. Revoked sessions fail immediately. */
export function requireAuth({ tokens, pool }) {
  return async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
    if (!match) throw new HttpError(401, 'TOKEN_MISSING', 'Not signed in.');
    const auth = await tokens.verifyAccess(match[1]);
    if (!(await isFamilyActive(pool, auth.familyId))) {
      throw new HttpError(401, 'SESSION_REVOKED', 'Your session has ended. Please sign in again.');
    }
    req.auth = auth;
    next();
  };
}

/**
 * CSRF guard for the cookie-authenticated endpoints (refresh, logout). The refresh
 * cookie is SameSite=Strict already; on top of that the request must come from one
 * of our origins and carry a custom header, which a cross-site form cannot send.
 */
export function requireCsrf({ appOrigins }) {
  const allowed = new Set(appOrigins);
  return (req, _res, next) => {
    const origin = req.get('origin');
    if (!origin || !allowed.has(origin)) throw new HttpError(403, 'BAD_ORIGIN', 'Request origin not allowed.');
    if (req.get('x-scarlet-csrf') !== '1') throw new HttpError(403, 'CSRF', 'Missing CSRF header.');
    next();
  };
}

/** Client IP for rate limiting: trusted from our Pages proxy, otherwise Express's req.ip. */
export function clientIp({ proxySharedSecret }) {
  return (req, _res, next) => {
    const fromProxy =
      proxySharedSecret && req.get('x-proxy-secret') === proxySharedSecret ? req.get('x-client-ip') : null;
    req.clientIp = fromProxy || req.ip || 'unknown';
    next();
  };
}
