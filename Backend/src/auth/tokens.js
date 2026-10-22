// Access tokens: short-lived HS256 JWTs (held in browser memory only).
// Refresh tokens: 256-bit random strings in an HttpOnly cookie; only their SHA-256
// hash is stored. Every refresh rotates the token; replaying an old one revokes the
// whole session family (theft detection).

import crypto from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { HttpError } from '../http.js';

const ISSUER = 'scarlet-rewrite';
const AUDIENCE = 'scarlet-rewrite-api';
const FAMILY_MAX_DAYS = 90; // absolute cap: sign in again at least every 90 days
const RACE_GRACE_MS = 5000; // two tabs refreshing at once: tell the late one to retry

export function createTokenService(authConfig) {
  const key = new TextEncoder().encode(authConfig.accessSecret);
  return {
    accessTtlS: authConfig.accessTtlS,
    async signAccess({ userId, familyId }) {
      return new SignJWT({ sid: familyId })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${authConfig.accessTtlS}s`)
        .sign(key);
    },
    async verifyAccess(token) {
      try {
        const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
        if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw new Error('claims');
        return { userId: payload.sub, familyId: payload.sid };
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) throw new HttpError(401, 'TOKEN_EXPIRED', 'Session expired.');
        throw new HttpError(401, 'TOKEN_INVALID', 'Not signed in.');
      }
    },
  };
}

export const newRefreshToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest();

const days = (n) => n * 24 * 3600 * 1000;

/** Start a new session family after a successful login. */
export async function createSession(db, { userId, userAgent, ttlDays }) {
  const token = newRefreshToken();
  const familyId = crypto.randomUUID();
  const now = Date.now();
  const familyExpires = new Date(now + days(FAMILY_MAX_DAYS));
  const expires = new Date(Math.min(now + days(ttlDays), familyExpires.getTime()));
  await db.query(
    `INSERT INTO auth_sessions (user_id, family_id, token_hash, expires_at, family_expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, familyId, hashToken(token), expires, familyExpires, userAgent?.slice(0, 300) ?? null],
  );
  return { token, familyId, expiresAt: expires };
}

/**
 * Exchange a refresh token for a new one.
 * @returns {Promise<{ ok: true, userId, familyId, token, expiresAt } | { ok: false, reason: 'invalid'|'reuse'|'race' }>}
 */
export async function rotateSession(client, token, { ttlDays, userAgent }) {
  const { rows } = await client.query(
    `SELECT id, user_id, family_id, expires_at, family_expires_at, revoked_at, revoked_reason
       FROM auth_sessions WHERE token_hash = $1 FOR UPDATE`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'invalid' };

  if (row.revoked_at) {
    if (row.revoked_reason === 'rotated') {
      if (Date.now() - new Date(row.revoked_at).getTime() < RACE_GRACE_MS) return { ok: false, reason: 'race' };
      await revokeFamily(client, row.family_id, 'reuse');
      return { ok: false, reason: 'reuse' };
    }
    return { ok: false, reason: 'invalid' };
  }
  const now = Date.now();
  if (new Date(row.expires_at).getTime() <= now || new Date(row.family_expires_at).getTime() <= now) {
    await revokeFamily(client, row.family_id, 'expired');
    return { ok: false, reason: 'invalid' };
  }

  const next = newRefreshToken();
  const expires = new Date(Math.min(now + days(ttlDays), new Date(row.family_expires_at).getTime()));
  const inserted = await client.query(
    `INSERT INTO auth_sessions (user_id, family_id, token_hash, expires_at, family_expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [row.user_id, row.family_id, hashToken(next), expires, row.family_expires_at, userAgent?.slice(0, 300) ?? null],
  );
  await client.query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'rotated', replaced_by = $2 WHERE id = $1`,
    [row.id, inserted.rows[0].id],
  );
  return { ok: true, userId: row.user_id, familyId: row.family_id, token: next, expiresAt: expires };
}

export async function revokeFamily(db, familyId, reason) {
  await db.query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2
      WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason],
  );
}

/** Revoke the family that owns this refresh token (logout). Unknown tokens are ignored. */
export async function revokeByToken(db, token) {
  const { rows } = await db.query('SELECT family_id FROM auth_sessions WHERE token_hash = $1', [hashToken(token)]);
  if (rows[0]) await revokeFamily(db, rows[0].family_id, 'logout');
}

export async function isFamilyActive(db, familyId) {
  const { rows } = await db.query(
    `SELECT 1 FROM auth_sessions
      WHERE family_id = $1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1`,
    [familyId],
  );
  return rows.length > 0;
}
